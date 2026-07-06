const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Supabase Config ───────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://aiojtzshvypdztisqrnm.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = 'sb_publishable_hWLNiEr1XAOK7f0O3jVJeA_pzUT22Z9';
const ADMIN_WHATSAPP = '+27634530070';

if (!SUPABASE_SERVICE_KEY) {
  console.error('⚠️  WARNING: SUPABASE_SERVICE_KEY environment variable is not set!');
  console.error('   All server-side database writes (sellers, messages, notifications, orders)');
  console.error('   will fail with Row Level Security errors.');
  console.error('   → Set SUPABASE_SERVICE_KEY in your Render environment variables.');
}

// Always use service key (bypasses RLS). Never fall back to anon key for server operations.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-admin-key']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
app.use(limiter);

// ─── Error Helper ──────────────────────────────────────────────────────────────
function sendError(res, status, message, detail = null) {
  const payload = { success: false, error: message };
  if (detail) payload.detail = detail;
  return res.status(status).json(payload);
}
function sendSuccess(res, data, message = 'Success') {
  return res.json({ success: true, message, data });
}

// ─── Admin key helpers ─────────────────────────────────────────────────────────
// Fallback key for when the DB is unreachable (e.g. SUPABASE_SERVICE_KEY not set).
// Matches the key hardcoded in admin.html so the admin panel always works.
const HARDCODED_ADMIN_KEY = process.env.ADMIN_KEY || 'ZMAFRDEAL-ADMIN-2024';

async function lookupAdminKey(key) {
  // 1. Try DB lookup (bypasses RLS via service key)
  try {
    const { data, error } = await supabase
      .from('admin_keys')
      .select('*')
      .eq('key', key)
      .eq('active', true)
      .single();
    if (!error && data) return { id: data.user_id || 'admin', role: 'admin', record: data };
  } catch (_) { /* DB unreachable — fall through to hardcoded check */ }

  // 2. Hardcoded fallback — works even when SUPABASE_SERVICE_KEY is not set
  if (key === HARDCODED_ADMIN_KEY) {
    return { id: 'admin', role: 'admin', record: { key, name: 'Default Admin' } };
  }

  return null;
}

// ─── Auth Middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return sendError(res, 401, 'Authorization header missing');
  const token = authHeader.replace('Bearer ', '');
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return sendError(res, 401, 'Invalid or expired session. Please log in again.');
    req.user = user;
    next();
  } catch (e) {
    return sendError(res, 401, 'Invalid or expired session. Please log in again.');
  }
}

async function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey) return sendError(res, 401, 'Admin key required');
  const admin = await lookupAdminKey(adminKey);
  if (!admin) return sendError(res, 401, 'Invalid admin credentials');
  req.admin = admin.record;
  req.user = { id: admin.id, role: 'admin' };
  next();
}

// Accepts either a valid admin key OR a valid user JWT.
// IMPORTANT: if x-admin-key is present it is checked first and exclusively —
// we do NOT fall through to JWT auth when a key is supplied but wrong.
async function requireAuthOrAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey) {
    const admin = await lookupAdminKey(adminKey);
    if (!admin) return sendError(res, 401, 'Invalid admin credentials');
    req.admin = admin.record;
    req.user = { id: admin.id, role: 'admin' };
    return next();
  }
  // No admin key — try user JWT
  const authHeader = req.headers.authorization;
  if (!authHeader) return sendError(res, 401, 'Authorization required');
  const token = authHeader.replace('Bearer ', '');
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return sendError(res, 401, 'Invalid or expired session. Please log in again.');
    req.user = user;
    next();
  } catch (e) {
    return sendError(res, 401, 'Invalid or expired session. Please log in again.');
  }
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => sendSuccess(res, { status: 'online', time: new Date() }, 'Server is running'));

// ═════════════════════════════════════════════════════════════════════════════
// CURRENCIES — Public & Admin
// ═════════════════════════════════════════════════════════════════════════════

// Hardcoded defaults (used only if country_currencies table not yet created — Kenya is the example)
const DEFAULT_CURRENCIES = [
  { id:1, country:'Kenya', flag:'🇰🇪', currency_code:'KES', currency_symbol:'KSh', currency_name:'Kenya Shilling', phone_code:'+254', ksh_rate:1, is_main:true }
];

// Public: get all active country currencies — only returns what admin has configured
app.get('/api/currencies', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('country_currencies')
      .select('*')
      .eq('active', true)
      .order('is_main', { ascending: false })
      .order('country');
    if (error) return sendSuccess(res, [], 'No currencies available');
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendSuccess(res, [], 'No currencies available');
  }
});

// Admin: add a new country/currency
app.post('/api/admin/currencies', requireAuthOrAdmin, async (req, res) => {
  try {
    const { country, flag, currency_code, currency_symbol, currency_name, phone_code, ksh_rate, is_main } = req.body;
    if (!country || !currency_code || !currency_symbol || !currency_name || ksh_rate === undefined) {
      return sendError(res, 400, 'country, currency_code, currency_symbol, currency_name and ksh_rate are required');
    }
    const { data, error } = await supabase.from('country_currencies').insert({
      country, flag: flag || '🌍', currency_code, currency_symbol, currency_name,
      phone_code: phone_code || '', ksh_rate: parseFloat(ksh_rate),
      is_main: is_main || false, active: true,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Currency added');
  } catch (e) { return sendError(res, 500, e.message); }
});

// Admin: update a country/currency (rate, symbol, etc.)
app.put('/api/admin/currencies/:id', requireAuthOrAdmin, async (req, res) => {
  try {
    const { country, flag, currency_code, currency_symbol, currency_name, phone_code, ksh_rate, is_main, active } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (country !== undefined) updates.country = country;
    if (flag !== undefined) updates.flag = flag;
    if (currency_code !== undefined) updates.currency_code = currency_code;
    if (currency_symbol !== undefined) updates.currency_symbol = currency_symbol;
    if (currency_name !== undefined) updates.currency_name = currency_name;
    if (phone_code !== undefined) updates.phone_code = phone_code;
    if (ksh_rate !== undefined) updates.ksh_rate = parseFloat(ksh_rate);
    if (is_main !== undefined) updates.is_main = is_main;
    if (active !== undefined) updates.active = active;
    const { data, error } = await supabase.from('country_currencies').update(updates).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Currency updated');
  } catch (e) { return sendError(res, 500, e.message); }
});

// Admin: delete a country/currency — cascades to cities, districts, payment methods
app.delete('/api/admin/currencies/:id', requireAuthOrAdmin, async (req, res) => {
  try {
    const { data: cur, error: cerr } = await supabase.from('country_currencies').select('country').eq('id', req.params.id).single();
    if (cerr) return sendError(res, 500, cerr.message);
    const countryName = cur.country;
    // Cascade delete related data
    await Promise.all([
      supabase.from('country_cities').delete().eq('country', countryName),
      supabase.from('country_districts').delete().eq('country', countryName),
      supabase.from('country_payment_methods').delete().eq('country', countryName),
    ]);
    const { error } = await supabase.from('country_currencies').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, `${countryName} and all related data deleted`);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Admin: set default guest currency in site settings
app.post('/api/admin/currencies/default', requireAuthOrAdmin, async (req, res) => {
  try {
    const { currency_code, country } = req.body;
    if (!currency_code) return sendError(res, 400, 'currency_code is required');
    const { error } = await supabase.from('site_settings').update({
      default_guest_currency: currency_code,
      default_guest_country: country || null,
      updated_at: new Date().toISOString()
    }).eq('id', 1);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'Default guest currency updated');
  } catch (e) { return sendError(res, 500, e.message); }
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTO EXCHANGE RATE UPDATER — runs on startup then every 24 hours
// Uses @fawazahmed0/currency-api (free, no API key, 200+ currencies including
// SLL, GHS, ZMW, KES, NGN, TZS, UGX, ZAR, etc.)
// Rates are stored as ksh_rate = "how many units of this currency = 1 KES"
// ═════════════════════════════════════════════════════════════════════════════
const RATE_API_PRIMARY  = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';
const RATE_API_FALLBACK = 'https://latest.currency-api.pages.dev/v1/currencies/usd.json';

async function fetchLiveRates() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(RATE_API_PRIMARY, { signal: controller.signal });
    if (!r.ok) throw new Error('Primary rate API returned ' + r.status);
    return await r.json();
  } catch (_) {
    // Try fallback
    const r2 = await fetch(RATE_API_FALLBACK, { signal: controller.signal });
    if (!r2.ok) throw new Error('Fallback rate API returned ' + r2.status);
    return await r2.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function updateExchangeRates() {
  try {
    console.log('[rates] Fetching live exchange rates...');
    const rateData = await fetchLiveRates();
    const rates = rateData.usd; // { kes: 129.5, sll: 23000.5, ghs: 12.3, ... }
    if (!rates || typeof rates !== 'object') throw new Error('Unexpected rate API response shape');

    const kesRate = parseFloat(rates['kes'] || rates['KES']);
    if (!kesRate || kesRate <= 0) throw new Error('KES rate missing from API response');

    // Get all active currencies from DB
    const { data: currencies, error: fetchErr } = await supabase
      .from('country_currencies')
      .select('id, currency_code, ksh_rate')
      .eq('active', true);

    if (fetchErr) throw new Error('DB fetch failed: ' + fetchErr.message);
    if (!currencies || !currencies.length) {
      console.log('[rates] No active currencies in DB — skipping update');
      return { updated: 0, total: 0, skipped: 0 };
    }

    let updated = 0, skipped = 0;
    for (const currency of currencies) {
      const code = (currency.currency_code || '').toLowerCase();
      if (!code) { skipped++; continue; }

      let newRate;
      if (code === 'kes') {
        newRate = 1; // KES is always the base
      } else {
        const usdRate = parseFloat(rates[code]);
        if (!usdRate || usdRate <= 0) {
          console.log(`[rates] No rate for ${code.toUpperCase()} — keeping existing`);
          skipped++;
          continue;
        }
        // ksh_rate = how many units of this currency per 1 KES
        // e.g. 1 USD = 129.5 KES and 1 USD = 23000 SLL → 1 KES = 23000/129.5 ≈ 177.6 SLL
        newRate = usdRate / kesRate;
      }

      newRate = parseFloat(newRate.toFixed(6));
      // Only write if rate actually changed (>0.1% difference) to avoid unnecessary DB writes
      const existing = parseFloat(currency.ksh_rate || 0);
      if (existing > 0 && Math.abs(newRate - existing) / existing < 0.001) {
        skipped++;
        continue;
      }

      const { error: upErr } = await supabase
        .from('country_currencies')
        .update({ ksh_rate: newRate, updated_at: new Date().toISOString() })
        .eq('id', currency.id);

      if (upErr) {
        console.error(`[rates] Failed to update ${code.toUpperCase()}:`, upErr.message);
        skipped++;
      } else {
        updated++;
      }
    }

    console.log(`[rates] Done — updated: ${updated}, skipped/unchanged: ${skipped}, total: ${currencies.length}`);
    return { updated, skipped, total: currencies.length, date: rateData.date || new Date().toISOString().slice(0, 10) };
  } catch (e) {
    console.error('[rates] Exchange rate update failed:', e.message);
    throw e;
  }
}

// Run once at startup (non-blocking — failure is logged, not fatal)
updateExchangeRates().catch(() => {});

// Then repeat every 24 hours
setInterval(() => updateExchangeRates().catch(() => {}), 24 * 60 * 60 * 1000);

// Admin: manually trigger a rate refresh
app.post('/api/admin/currencies/refresh-rates', requireAuthOrAdmin, async (req, res) => {
  try {
    const result = await updateExchangeRates();
    return sendSuccess(res, result, `Rates refreshed — ${result.updated} updated, ${result.skipped} unchanged`);
  } catch (e) {
    return sendError(res, 500, 'Rate refresh failed: ' + e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// Register with email/password
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, full_name, country, phone } = req.body;
    if (!email || !password || !full_name || !country) {
      return sendError(res, 400, 'Email, password, full name and country are required');
    }

    // Use admin.createUser with email_confirm:true so the account is instantly
    // confirmed regardless of whether Supabase email confirmation is enabled.
    // This guarantees signInWithPassword succeeds immediately after.
    const { data: adminData, error: adminError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name }
    });

    // Fall back to regular signUp if admin API is unavailable (e.g. missing service key)
    let userId, authUser;
    if (adminError) {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({ email, password });
      if (signUpError) return sendError(res, 400, signUpError.message);
      userId = signUpData.user?.id;
      authUser = signUpData.user;
    } else {
      userId = adminData.user?.id;
      authUser = adminData.user;
    }

    if (!userId) return sendError(res, 500, 'Account creation failed. Please try again.');

    // Determine currency_code from country (sent by client, or look up from DB, or fall back to defaults)
    const clientCurrency = req.body.currency_code;
    let resolvedCurrency = clientCurrency;
    if (!resolvedCurrency && country) {
      try {
        const { data: currRow } = await supabase
          .from('country_currencies')
          .select('currency_code')
          .eq('country', country)
          .eq('active', true)
          .single();
        if (currRow?.currency_code) resolvedCurrency = currRow.currency_code;
      } catch (_) {}
    }
    if (!resolvedCurrency) {
      const countryMatch = DEFAULT_CURRENCIES.find(c => c.country === country);
      resolvedCurrency = countryMatch ? countryMatch.currency_code : 'KES';
    }

    const { error: profileError } = await supabase.from('profiles').insert({
      id: userId, email, full_name, country, phone: phone || null, role: 'buyer',
      currency_code: resolvedCurrency,
      created_at: new Date().toISOString()
    });
    if (profileError) return sendError(res, 500, 'Account created but profile save failed: ' + profileError.message);

    // Send welcome notification
    await supabase.from('notifications').insert({
      user_id: userId, type: 'welcome', title: 'Welcome to Zmafrdeal!',
      message: `Hi ${full_name}, welcome to Zmafrdeal! Discover great deals from verified sellers across Africa — shop smart, shop easy.`,
      read: false, created_at: new Date().toISOString()
    });

    // Sign in to get a live session — works now because account is already confirmed
    const { data: signInData } = await supabase.auth.signInWithPassword({ email, password });
    const session = signInData?.session || null;
    const profile = { id: userId, email, full_name, country, phone: phone || null, role: 'buyer' };

    return sendSuccess(res, { user: authUser, session, profile }, 'Account created successfully');
  } catch (e) {
    return sendError(res, 500, 'Unexpected server error: ' + e.message);
  }
});

// Login — accepts email OR phone number
app.post('/api/auth/login', async (req, res) => {
  try {
    // Support both {identifier,password} (new) and {email,password} (legacy)
    const { identifier, password, email: rawEmail } = req.body;
    const input = (identifier || rawEmail || '').trim();
    if (!input || !password) return sendError(res, 400, 'Email/phone and password are required');

    let loginEmail = input;

    // Detect phone: starts with + or digits, not an email
    const isPhone = /^[+\d]/.test(input) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
    if (isPhone) {
      const normalised = input.replace(/[\s\-().]/g, '');
      // Try exact phone match
      let { data: profile } = await supabase.from('profiles').select('email').eq('phone', normalised).maybeSingle();
      if (!profile) {
        // Try without leading +
        const stripped = normalised.replace(/^\+/, '');
        const res2 = await supabase.from('profiles').select('email').eq('phone', stripped).maybeSingle();
        profile = res2.data;
      }
      if (!profile) return sendError(res, 401, 'No account found with this phone number');
      loginEmail = profile.email;
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email: loginEmail, password });
    if (error) return sendError(res, 401, error.message);
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', data.user.id).single();
    if (profile?.banned) {
      return res.status(403).json({ success: false, banned: true, error: 'Your account has been suspended.' });
    }
    return sendSuccess(res, { user: data.user, session: data.session, profile }, 'Login successful');
  } catch (e) {
    return sendError(res, 500, 'Login failed: ' + e.message);
  }
});

// Forgot password
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return sendError(res, 400, 'Email is required');
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) return sendError(res, 400, error.message);
    return sendSuccess(res, null, 'Password reset email sent. Check your inbox.');
  } catch (e) {
    return sendError(res, 500, 'Password reset failed: ' + e.message);
  }
});

// Get profile
app.get('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
    if (error) return sendError(res, 404, 'Profile not found');
    return sendSuccess(res, data);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Update profile
app.put('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const { full_name, phone, country, avatar_url, settings } = req.body;
    const updates = {};
    if (full_name) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone || null;
    if (country !== undefined) updates.country = country || null;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url || null;
    if (settings !== undefined) updates.settings = settings;
    updates.updated_at = new Date().toISOString();

    let { data, error } = await supabase.from('profiles').update(updates).eq('id', req.user.id).select().single();

    // If the error is about the settings column not existing, retry without it
    if (error && error.message && error.message.includes('settings')) {
      const { settings: _dropped, ...fallbackUpdates } = updates;
      const fallback = await supabase.from('profiles').update(fallbackUpdates).eq('id', req.user.id).select().single();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) return sendError(res, 500, 'Profile update failed: ' + error.message);
    return sendSuccess(res, data, 'Profile updated successfully');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SELLER ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/sellers/apply', async (req, res) => {
  try {
    const { full_name, email, password, business_name, business_type, phone, country, id_number, address, description } = req.body;
    if (!email || !password || !full_name || !business_name || !phone) {
      return sendError(res, 400, 'Full name, email, password, business name and phone are required');
    }
    const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
    if (authError) return sendError(res, 400, authError.message);

    const userId = authData.user?.id;
    await supabase.from('profiles').insert({
      id: userId, email, full_name, country: country || null, phone, role: 'seller_pending',
      created_at: new Date().toISOString()
    });

    const { error: sellerError } = await supabase.from('sellers').insert({
      id: userId, business_name, business_type, phone, country: country || null,
      id_number, address, description, status: 'pending', commission_rate: 10,
      created_at: new Date().toISOString()
    });
    if (sellerError) return sendError(res, 500, 'Seller application failed: ' + sellerError.message);
    return sendSuccess(res, null, 'Seller application submitted. Await admin approval.');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/sellers/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return sendError(res, 401, error.message);
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', data.user.id).single();
    if (!profile || !['seller', 'seller_pending'].includes(profile.role)) {
      return sendError(res, 403, 'This account is not registered as a seller');
    }
    if (profile.banned) {
      return res.status(403).json({
        success: false,
        banned: true,
        ban_reason: profile.ban_reason || null,
        error: 'Your seller account has been suspended.'
      });
    }
    const { data: seller } = await supabase.from('sellers').select('*').eq('id', data.user.id).single();
    return sendSuccess(res, { user: data.user, session: data.session, profile, seller });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/sellers/dashboard', requireAuth, async (req, res) => {
  try {
    const { data: seller } = await supabase.from('sellers').select('*').eq('id', req.user.id).single();
    if (!seller) return sendError(res, 403, 'Not a registered seller');
    const { data: products } = await supabase.from('products').select('*').eq('seller_id', req.user.id);
    const { data: orders } = await supabase.from('orders').select('*').eq('seller_id', req.user.id);
    const totalRevenue = orders?.filter(o => o.status === 'completed').reduce((s, o) => s + (o.total || 0), 0) || 0;
    return sendSuccess(res, { seller, products: products || [], orders: orders || [], total_revenue: totalRevenue });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PRODUCTS ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// Get all products (public - country filtered)
app.get('/api/products', async (req, res) => {
  try {
    const { country, category, subcategory, search, limit = 50, offset = 0, sort = 'popular', flash_sale,
      min_price, max_price, min_rating, on_sale, in_stock, free_shipping } = req.query;

    let query = supabase.from('products').select('*, reviews(rating)').eq('status', 'active').or('hidden.eq.false,hidden.is.null');

    if (category) query = query.eq('category', category);
    if (subcategory) query = query.ilike('subcategory', `%${subcategory}%`);
    if (flash_sale === 'true') query = query.eq('is_flash_sale', true);
    if (search) query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
    // Price filter: include exact-price products AND price_range products whose lower
    // bound falls within the requested range (price_range products have price = lower bound).
    if (min_price && max_price) {
      query = query.or(
        `and(price.gte.${parseFloat(min_price)},price.lte.${parseFloat(max_price)}),` +
        `and(price_range.not.is.null,price.gte.${parseFloat(min_price)},price.lte.${parseFloat(max_price)})`
      );
    } else if (min_price) {
      query = query.gte('price', parseFloat(min_price));
    } else if (max_price) {
      query = query.lte('price', parseFloat(max_price));
    }
    if (on_sale === 'true') query = query.not('previous_price', 'is', null);
    if (in_stock === 'true') query = query.gt('stock_available', 0);
    if (free_shipping === 'true') query = query.eq('shipping_fee', 0);

    if (country && country !== 'all') {
      query = query.or(`target_countries.cs.{${country}},show_to_all.eq.true`);
    }

    if (sort === 'price_asc') query = query.order('price', { ascending: true });
    else if (sort === 'price_desc') query = query.order('price', { ascending: false });
    else if (sort === 'popular') query = query.order('sales_count', { ascending: false });
    else if (sort === 'newest') query = query.order('created_at', { ascending: false });
    else if (sort === 'views') query = query.order('views_count', { ascending: false });
    else query = query.order('sales_count', { ascending: false });

    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data, error } = await query;
    if (error) return sendError(res, 500, 'Failed to load products: ' + error.message);

    let productsWithRatings = (data || []).map(p => {
      const reviews = p.reviews || [];
      const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
      return { ...p, avg_rating: parseFloat(avg.toFixed(1)), review_count: reviews.length, reviews: undefined };
    });

    if (min_rating) {
      productsWithRatings = productsWithRatings.filter(p => p.avg_rating >= parseFloat(min_rating));
    }
    if (sort === 'rating') {
      productsWithRatings.sort((a, b) => b.avg_rating - a.avg_rating);
    }

    return sendSuccess(res, productsWithRatings);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Get single product
app.get('/api/products/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    if (error || !data) return sendError(res, 404, 'Product not found');
    const { data: reviews } = await supabase.from('reviews').select('*').eq('product_id', req.params.id).eq('approved', true).order('created_at', { ascending: false });
    const avg = reviews?.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
    // Increment view count (fire and forget)
    supabase.from('products').update({ views_count: (data.views_count || 0) + 1 }).eq('id', req.params.id).then(() => {});
    return sendSuccess(res, { ...data, reviews: reviews || [], avg_rating: parseFloat(avg.toFixed(1)), review_count: reviews?.length || 0 });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Get flash sale products
app.get('/api/products/flash-sale/active', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('products').select('*').eq('is_flash_sale', true).eq('status', 'active').gt('flash_sale_end', now);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Get best sellers
app.get('/api/products/best-sellers/list', async (req, res) => {
  try {
    const { data, error } = await supabase.from('products').select('*').eq('status', 'active').order('sales_count', { ascending: false }).limit(20);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Get most purchased
app.get('/api/products/most-purchased/list', async (req, res) => {
  try {
    const { data, error } = await supabase.from('products').select('*').eq('status', 'active').order('sales_count', { ascending: false }).limit(20);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Upload image (base64) → Supabase Storage via service key
app.post('/api/upload', async (req, res) => {
  try {
    const { data: b64, folder = 'uploads' } = req.body;
    if (!b64) return sendError(res, 400, 'No image data provided');
    const base64Data = b64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const isPng = b64.startsWith('data:image/png');
    const ext = isPng ? 'png' : 'jpg';
    const filename = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const { error } = await supabase.storage
      .from('product-images')
      .upload(filename, buffer, { contentType: isPng ? 'image/png' : 'image/jpeg', upsert: true });
    if (error) return sendError(res, 500, 'Storage upload failed: ' + error.message);
    const url = `${SUPABASE_URL}/storage/v1/object/public/product-images/${filename}`;
    return sendSuccess(res, { url });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Post product (seller or admin)
// Coerce stock_available to integer. The DB column is INTEGER, but the admin
// panel sends text labels ("Limited Stock", "In Stock", "Pre-Order", etc.).
// Map them to safe sentinel values so the insert never fails.
function coerceStock(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseInt(val, 10);
  if (!isNaN(n)) return n;
  const s = String(val).trim().toLowerCase();
  // Extract leading number from strings like "50+ Items"
  const m = s.match(/^(\d+)/);
  if (m) return parseInt(m[1], 10);
  if (/out.?of.?stock/i.test(s)) return 0;
  if (/limited/i.test(s))         return 5;
  if (/in.?stock|available|free/i.test(s)) return 999;
  // Pre-Order / Made to Order / Coming Soon → treat as available (positive)
  return 999;
}

// When a product has a price_range (e.g. "600-700"), parse the lower bound and store
// it in `price` so that price-range filters (min_price/max_price) work correctly.
function coercePriceFromRange(body) {
  if (body.price_range && (!body.price || parseFloat(body.price) === 0)) {
    const parts = String(body.price_range).split(/\s*[-–—]\s*/);
    const lo = parseFloat(parts[0]);
    if (!isNaN(lo) && lo > 0) return lo;
  }
  return body.price !== undefined ? parseFloat(body.price) || 0 : undefined;
}

app.post('/api/products', requireAuthOrAdmin, async (req, res) => {
  try {
    const isAdminRequest = !!req.admin;
    const coercedPrice = coercePriceFromRange(req.body);
    const product = {
      ...req.body,
      id: uuidv4(),
      price: coercedPrice,
      seller_id: isAdminRequest ? (req.body.seller_id || null) : req.user.id,
      status: isAdminRequest ? 'active' : 'pending_approval',
      sales_count: isAdminRequest ? (parseInt(req.body.sales_count) || 0) : 0,
      stock_available: coerceStock(req.body.stock_available),
      created_at: new Date().toISOString()
    };

    if (!isAdminRequest) {
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', req.user.id).single();
      if (profile?.role === 'admin') product.status = 'active';
    }

    const { data, error } = await supabase.from('products').insert(product).select().single();
    if (error) return sendError(res, 500, 'Product posting failed: ' + error.message);
    return sendSuccess(res, data, 'Product posted successfully');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Update product
app.put('/api/products/:id', requireAuthOrAdmin, async (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.id; delete updates.seller_id; delete updates.created_at;
    if (updates.stock_available !== undefined) updates.stock_available = coerceStock(updates.stock_available);
    // Ensure price reflects lower bound of price_range so filters work correctly
    const coercedPrice = coercePriceFromRange(updates);
    if (coercedPrice !== undefined) updates.price = coercedPrice;
    const { data, error } = await supabase.from('products').update(updates).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, 'Product update failed: ' + error.message);
    return sendSuccess(res, data, 'Product updated');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/categories', async (req, res) => {
  try {
    const { data, error } = await supabase.from('categories').select('*').eq('active', true).order('sort_order');
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/categories', requireAuthOrAdmin, async (req, res) => {
  try {
    const { name, icon, sort_order } = req.body;
    if (!name) return sendError(res, 400, 'Category name is required');
    const { data, error } = await supabase.from('categories').insert({ name, icon, sort_order: sort_order || 0, active: true }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Category created');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.delete('/api/categories/:id', requireAuthOrAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('categories').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'Category deleted');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SUBCATEGORIES
// ═════════════════════════════════════════════════════════════════════════════

// Public: get subcategories for a category (optional ?category= filter)
app.get('/api/subcategories', async (req, res) => {
  try {
    let query = supabase.from('subcategories').select('*').order('sort_order').order('name');
    if (req.query.category) query = query.eq('category_name', req.query.category);
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Admin: add a subcategory to a category
app.post('/api/admin/subcategories', requireAdmin, async (req, res) => {
  try {
    const { category_name, name, slug, sort_order } = req.body;
    if (!category_name || !name) return sendError(res, 400, 'category_name and name are required');
    const { data, error } = await supabase.from('subcategories').insert({
      category_name, name,
      slug: slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      sort_order: sort_order || 0,
      created_at: new Date().toISOString()
    }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Subcategory added');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Admin: delete a subcategory
app.delete('/api/admin/subcategories/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('subcategories').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'Subcategory deleted');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CART ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/cart', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('cart_items').select('*, products(*)').eq('user_id', req.user.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/cart', requireAuth, async (req, res) => {
  try {
    const { product_id, quantity, variation } = req.body;
    if (!product_id) return sendError(res, 400, 'Product ID is required');

    const { data: existing } = await supabase.from('cart_items').select('*').eq('user_id', req.user.id).eq('product_id', product_id).single();
    if (existing) {
      const { data, error } = await supabase.from('cart_items').update({ quantity: existing.quantity + (quantity || 1), variation }).eq('id', existing.id).select().single();
      if (error) return sendError(res, 500, error.message);
      return sendSuccess(res, data, 'Cart updated');
    }

    const { data, error } = await supabase.from('cart_items').insert({ user_id: req.user.id, product_id, quantity: quantity || 1, variation, created_at: new Date().toISOString() }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Added to cart');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.delete('/api/cart/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('cart_items').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'Item removed from cart');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// WISHLIST
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/wishlist', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('wishlist').select('*, products(*)').eq('user_id', req.user.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/wishlist', requireAuth, async (req, res) => {
  try {
    const { product_id } = req.body;
    if (!product_id) return sendError(res, 400, 'Product ID is required');
    const { data: existing } = await supabase.from('wishlist').select('*').eq('user_id', req.user.id).eq('product_id', product_id).single();
    if (existing) {
      await supabase.from('wishlist').delete().eq('id', existing.id);
      return sendSuccess(res, { removed: true }, 'Removed from wishlist');
    }
    const { data, error } = await supabase.from('wishlist').insert({ user_id: req.user.id, product_id, created_at: new Date().toISOString() }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Added to wishlist');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/orders', requireAuth, async (req, res) => {
  try {
    const { items, delivery_info, payment_method, payment_name, subtotal, discount, shipping_fee, total, voucher_code } = req.body;
    if (!items || !items.length) return sendError(res, 400, 'Order items are required');
    if (!delivery_info?.full_name || !delivery_info?.phone) return sendError(res, 400, 'Delivery information is required');

    // Derive a human-readable name if not provided: replace underscores, title-case
    const resolvedPaymentName = payment_name || payment_method.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const orderId = Math.floor(100000 + Math.random() * 900000).toString();
    const { data: order, error } = await supabase.from('orders').insert({
      id: orderId, user_id: req.user.id, items: JSON.stringify(items),
      delivery_info: JSON.stringify(delivery_info), payment_method,
      payment_name: resolvedPaymentName,
      subtotal, discount: discount || 0, shipping_fee: shipping_fee || 0, total,
      voucher_code: voucher_code || null, status: 'pending',
      created_at: new Date().toISOString()
    }).select().single();

    if (error) return sendError(res, 500, 'Order placement failed: ' + error.message);

    // Update product sales count
    for (const item of items) {
      await supabase.rpc('increment_sales', { product_id: item.product_id, amount: item.quantity });
    }

    // Notify user
    await supabase.from('notifications').insert({
      user_id: req.user.id, type: 'order_placed', title: 'Order Placed Successfully',
      message: `Your order #${orderId} has been placed and is pending confirmation.`,
      read: false, created_at: new Date().toISOString()
    });

    // Clear cart
    if (payment_method !== 'cart_manual') {
      await supabase.from('cart_items').delete().eq('user_id', req.user.id);
    }

    return sendSuccess(res, order, 'Order placed successfully');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase.from('orders').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('orders').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (error || !data) return sendError(res, 404, 'Order not found');
    return sendSuccess(res, data);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// REVIEWS
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/reviews', async (req, res) => {
  try {
    const { product_id, user_name, rating, comment, user_id, photo_url } = req.body;
    if (!product_id || !user_name || !rating) return sendError(res, 400, 'Product, name and rating are required');
    if (rating < 1 || rating > 5) return sendError(res, 400, 'Rating must be between 1 and 5');

    const { data, error } = await supabase.from('reviews').insert({
      id: uuidv4(), product_id, user_id: user_id || null, user_name,
      rating: parseInt(rating), comment: comment || null, photo_url: photo_url || null,
      approved: false, created_at: new Date().toISOString()
    }).select().single();

    if (error) return sendError(res, 500, 'Review submission failed: ' + error.message);
    return sendSuccess(res, data, 'Review submitted. Pending admin approval.');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/reviews/:product_id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('reviews').select('*').eq('product_id', req.params.product_id).eq('approved', true).order('created_at', { ascending: false });
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// VOUCHERS
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/vouchers/validate', async (req, res) => {
  try {
    const { code, product_id, user_id } = req.body;
    if (!code) return sendError(res, 400, 'Voucher code is required');

    const { data, error } = await supabase.from('vouchers').select('*').eq('code', code.toUpperCase()).eq('active', true).single();
    if (error || !data) return sendError(res, 404, 'Invalid voucher code');

    const now = new Date();
    if (data.expires_at && new Date(data.expires_at) < now) return sendError(res, 400, 'Voucher has expired');
    if (data.usage_count >= data.usage_limit) return sendError(res, 400, 'Voucher usage limit reached');

    return sendSuccess(res, { discount_type: data.discount_type, discount_value: data.discount_value, min_order: data.min_order }, 'Voucher is valid');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/vouchers/user/:user_id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('user_vouchers').select('*, vouchers(*)').eq('user_id', req.user.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/vouchers/public', async (req, res) => {
  try {
    const now = new Date().toISOString();
    let query = supabase.from('vouchers').select('id, code, discount_type, discount_value, min_order, usage_limit, usage_count, expires_at').eq('active', true);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) return sendError(res, 500, error.message);
    const valid = (data || []).filter(v => (!v.expires_at || new Date(v.expires_at) > new Date()) && (v.usage_limit == null || v.usage_count < v.usage_limit));
    return sendSuccess(res, valid);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.patch('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('notifications').update({ read: true }).eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'Notification marked as read');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.patch('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await supabase.from('notifications').update({ read: true }).eq('user_id', req.user.id).eq('read', false);
    return sendSuccess(res, null, 'All notifications marked as read');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// BANNERS (Admin set)
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/banners', async (req, res) => {
  try {
    const { data, error } = await supabase.from('banners').select('*').eq('active', true).order('sort_order');
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/banners', requireAuthOrAdmin, async (req, res) => {
  try {
    const { title, image_url, link_url, sort_order } = req.body;
    if (!image_url) return sendError(res, 400, 'Banner image URL is required');
    const { data, error } = await supabase.from('banners').insert({ title, image_url, link_url, sort_order: sort_order || 0, active: true }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Banner created');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.delete('/api/banners/:id', requireAuthOrAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('banners').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'Banner deleted');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/products', requireAuthOrAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase.from('products').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.patch('/api/admin/products/:id/status', requireAuthOrAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabase.from('products').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Product status updated');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.patch('/api/admin/products/:id/hide', requireAuthOrAdmin, async (req, res) => {
  try {
    const { hidden } = req.body;
    const { data, error } = await supabase.from('products').update({ hidden }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, `Product ${hidden ? 'hidden' : 'visible'}`);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.delete('/api/admin/products/:id', requireAuthOrAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('products').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'Product deleted');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/admin/orders', requireAuthOrAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase.from('orders').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.patch('/api/admin/orders/:id/status', requireAuthOrAdmin, async (req, res) => {
  try {
    const { status, tracking_number, estimated_delivery } = req.body;
    const { data: order } = await supabase.from('orders').select('user_id').eq('id', req.params.id).single();
    const updatePayload = { status, updated_at: new Date().toISOString() };
    if (tracking_number !== undefined) updatePayload.tracking_number = tracking_number || null;
    if (estimated_delivery !== undefined) updatePayload.estimated_delivery = estimated_delivery || null;
    const { data, error } = await supabase.from('orders').update(updatePayload).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    if (order?.user_id) {
      const msgs = {
        confirmed: 'Your order has been confirmed and is being prepared!',
        shipped: `Your order is on its way!${tracking_number ? ' Tracking: ' + tracking_number : ''}${estimated_delivery ? ' Est. delivery: ' + new Date(estimated_delivery).toLocaleDateString() : ''}`,
        completed: 'Your order has been delivered! Thank you for shopping with Zmafrdeal.',
        cancelled: 'Your order has been cancelled. Contact us if you have questions.'
      };
      await supabase.from('notifications').insert({ user_id: order.user_id, type: 'order_update', title: `Order ${status.charAt(0).toUpperCase() + status.slice(1)}`, message: msgs[status] || `Your order status has been updated to: ${status}`, read: false, created_at: new Date().toISOString() });
    }
    return sendSuccess(res, data, 'Order status updated');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Seller: update their own order status
app.patch('/api/seller/orders/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['confirmed', 'shipped', 'completed', 'cancelled'];
    if (!status || !allowed.includes(status)) return sendError(res, 400, 'Invalid status. Allowed: ' + allowed.join(', '));
    // Verify this order belongs to this seller
    const { data: order, error: fetchErr } = await supabase.from('orders').select('id, seller_id, user_id, status').eq('id', req.params.id).single();
    if (fetchErr || !order) return sendError(res, 404, 'Order not found');
    if (order.seller_id !== req.user.id) return sendError(res, 403, 'Not your order');
    const { data, error } = await supabase.from('orders').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    // Notify buyer
    if (order.user_id) {
      const msgs = { confirmed: 'Your order has been confirmed by the seller!', shipped: 'Great news — your order has been shipped!', completed: 'Your order has been delivered. Enjoy your purchase!', cancelled: 'Your order was cancelled by the seller. Contact us for help.' };
      await supabase.from('notifications').insert({ user_id: order.user_id, type: 'order_update', title: `Order ${status.charAt(0).toUpperCase() + status.slice(1)}`, message: msgs[status], read: false, created_at: new Date().toISOString() });
    }
    return sendSuccess(res, data, 'Order status updated');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Seller: view return requests on their products
app.get('/api/seller/returns', requireAuth, async (req, res) => {
  try {
    const { data: orderRows } = await supabase.from('orders').select('id').eq('seller_id', req.user.id);
    const ids = (orderRows || []).map(o => o.id);
    if (!ids.length) return sendSuccess(res, []);
    const { data, error } = await supabase.from('return_requests').select('*, orders(id, total)').in('order_id', ids).order('created_at', { ascending: false });
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Seller: add a response to a return request
app.patch('/api/seller/returns/:id/respond', requireAuth, async (req, res) => {
  try {
    const { response } = req.body;
    if (!response) return sendError(res, 400, 'Response text is required');
    // Verify the return belongs to one of this seller's orders
    const { data: ret } = await supabase.from('return_requests').select('order_id').eq('id', req.params.id).single();
    if (!ret) return sendError(res, 404, 'Return request not found');
    const { data: order } = await supabase.from('orders').select('seller_id').eq('id', ret.order_id).single();
    if (!order || order.seller_id !== req.user.id) return sendError(res, 403, 'Not your return request');
    const { data, error } = await supabase.from('return_requests').update({ customer_response: response, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Response saved');
  } catch (e) { return sendError(res, 500, e.message); }
});

// Return requests
app.post('/api/return-requests', requireAuth, async (req, res) => {
  try {
    const { order_id, product_name, reason } = req.body;
    if (!order_id || !product_name || !reason) return sendError(res, 400, 'Order ID, product name and reason are required');
    const { data, error } = await supabase.from('return_requests').insert({
      order_id, user_id: req.user.id, product_name, reason, status: 'pending',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Return request submitted');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// User: fetch their own return requests
app.get('/api/return-requests', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('return_requests')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// User: respond to an admin decision (accept or dispute)
app.post('/api/return-requests/:id/respond', requireAuth, async (req, res) => {
  try {
    const { response, comment } = req.body;
    if (!['accepted', 'disputed'].includes(response)) return sendError(res, 400, 'Response must be "accepted" or "disputed"');
    const newStatus = response === 'accepted' ? 'completed' : 'disputed';
    const { data, error } = await supabase
      .from('return_requests')
      .update({ customer_response: response, customer_comment: comment || null, status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error) return sendError(res, 500, error.message);
    if (!data) return sendError(res, 404, 'Return request not found');
    return sendSuccess(res, data, response === 'accepted' ? 'Return accepted' : 'Dispute submitted');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/admin/return-requests', requireAuthOrAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('return_requests').select('*, orders(id, total), profiles(full_name, email)').order('created_at', { ascending: false });
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.patch('/api/admin/return-requests/:id', requireAuthOrAdmin, async (req, res) => {
  try {
    const { status, admin_notes } = req.body;
    const { data, error } = await supabase.from('return_requests').update({ status, admin_notes: admin_notes || null, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Return request updated');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/admin/reviews', requireAuthOrAdmin, async (req, res) => {
  try {
    const { approved } = req.query;
    let query = supabase.from('reviews').select('*, products(name)').order('created_at', { ascending: false });
    if (approved !== undefined) query = query.eq('approved', approved === 'true');
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.patch('/api/admin/reviews/:id', requireAuthOrAdmin, async (req, res) => {
  try {
    const { approved } = req.body;
    const { data, error } = await supabase.from('reviews').update({ approved }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, `Review ${approved ? 'approved' : 'rejected'}`);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.delete('/api/admin/reviews/:id', requireAuthOrAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('reviews').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'Review deleted');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/admin/sellers', requireAuthOrAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('sellers').select('*, profiles(full_name, email, banned, ban_reason)').order('created_at', { ascending: false });
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.patch('/api/admin/sellers/:id/status', requireAuthOrAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await supabase.from('sellers').update({ status }).eq('id', req.params.id);
    const role = status === 'approved' ? 'seller' : 'buyer';
    await supabase.from('profiles').update({ role }).eq('id', req.params.id);
    if (status === 'approved') {
      await supabase.from('notifications').insert({ user_id: req.params.id, type: 'seller_approved', title: 'Seller Application Approved', message: 'Congratulations! Your seller application has been approved. You can now post products on Zmafrdeal.', read: false, created_at: new Date().toISOString() });
    }
    return sendSuccess(res, null, `Seller ${status}`);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/admin/analytics', requireAuthOrAdmin, async (req, res) => {
  try {
    const [products, orders, users, reviews] = await Promise.all([
      supabase.from('products').select('id, status, sales_count, price'),
      supabase.from('orders').select('id, status, total, created_at'),
      supabase.from('profiles').select('id, country, created_at'),
      supabase.from('reviews').select('id, approved')
    ]);
    const totalRevenue = (orders.data || []).filter(o => o.status === 'completed').reduce((s, o) => s + (o.total || 0), 0);
    const pendingOrders = (orders.data || []).filter(o => o.status === 'pending').length;
    return sendSuccess(res, {
      total_products: products.data?.length || 0,
      active_products: products.data?.filter(p => p.status === 'active').length || 0,
      total_orders: orders.data?.length || 0, pending_orders: pendingOrders,
      total_revenue: totalRevenue, total_users: users.data?.length || 0,
      pending_reviews: reviews.data?.filter(r => !r.approved).length || 0
    });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Voucher management
app.post('/api/admin/vouchers', requireAuthOrAdmin, async (req, res) => {
  try {
    const { code, discount_type, discount_value, min_order, usage_limit, expires_at } = req.body;
    if (!code || !discount_type || discount_value === undefined || discount_value === null || discount_value === '') return sendError(res, 400, 'Code, type and value are required');
    const { data, error } = await supabase.from('vouchers').insert({ code: code.toUpperCase(), discount_type, discount_value, min_order: min_order || 0, usage_limit: usage_limit || 100, usage_count: 0, expires_at, active: true, created_at: new Date().toISOString() }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Voucher created');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/admin/vouchers', requireAuthOrAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('vouchers').select('*').order('created_at', { ascending: false });
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.patch('/api/admin/vouchers/:id/toggle', requireAuthOrAdmin, async (req, res) => {
  try {
    const { data: v } = await supabase.from('vouchers').select('active').eq('id', req.params.id).single();
    if (!v) return sendError(res, 404, 'Voucher not found');
    const { data, error } = await supabase.from('vouchers').update({ active: !v.active }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, data.active ? 'Voucher activated' : 'Voucher deactivated');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/admin/vouchers/:id/assign', requireAuthOrAdmin, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return sendError(res, 400, 'User ID is required');
    const { data: v } = await supabase.from('vouchers').select('*').eq('id', req.params.id).single();
    if (!v) return sendError(res, 404, 'Voucher not found');
    const { data, error } = await supabase.from('user_vouchers').insert({ user_id, voucher_id: req.params.id, assigned_at: new Date().toISOString() }).select().single();
    if (error) return sendError(res, 500, error.message);
    await supabase.from('notifications').insert({ user_id, type: 'voucher', title: 'You have a new voucher!', message: `Use code ${v.code} to get ${v.discount_type === 'percent' ? v.discount_value + '% off' : 'SLL ' + v.discount_value + ' off'} your order${v.min_order ? ' (min order: SLL ' + v.min_order + ')' : ''}.${v.expires_at ? ' Expires: ' + new Date(v.expires_at).toLocaleDateString() : ''}`, read: false, created_at: new Date().toISOString() });
    return sendSuccess(res, data, 'Voucher assigned to user');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Send notification to a single user
app.post('/api/admin/notifications/send', requireAuthOrAdmin, async (req, res) => {
  try {
    const { user_id, type, title, message } = req.body;
    if (!user_id || !title || !message) return sendError(res, 400, 'User ID, title and message required');
    const { data, error } = await supabase.from('notifications').insert({ user_id, type: type || 'admin_message', title, message, read: false, created_at: new Date().toISOString() }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Notification sent');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Broadcast notification to ALL users
app.post('/api/admin/notifications/broadcast', requireAuthOrAdmin, async (req, res) => {
  try {
    const { type, title, message } = req.body;
    if (!title || !message) return sendError(res, 400, 'Title and message required');
    const { data: users, error: uErr } = await supabase.from('profiles').select('id');
    if (uErr) return sendError(res, 500, uErr.message);
    if (!users || !users.length) return sendSuccess(res, { count: 0 }, 'No users to notify');
    const now = new Date().toISOString();
    const rows = users.map(u => ({ user_id: u.id, type: type || 'admin_message', title, message, read: false, created_at: now }));
    const { error } = await supabase.from('notifications').insert(rows);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, { count: rows.length }, `Broadcast sent to ${rows.length} users`);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Public settings endpoint (no auth required — used by buyer + seller pages)
app.get('/api/settings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('site_settings')
      .select('default_currency, currency_symbol, currency_name, default_country, store_name, tagline, whatsapp_number, contact_email, show_banners, show_flash_sale, maintenance_mode, pwa_enabled, use_geolocation, business_hours, contact_location, about_story, help_payments_text')
      .eq('id', 1)
      .single();
    if (error) {
      return sendSuccess(res, { default_currency: 'KES', currency_symbol: 'KSh', currency_name: 'Kenya Shilling', default_country: 'Kenya', store_name: 'Zmafrdeal', use_geolocation: false });
    }
    return sendSuccess(res, data);
  } catch (e) {
    return sendSuccess(res, { default_currency: 'KES', currency_symbol: 'KSh', currency_name: 'Kenya Shilling', default_country: 'Kenya', store_name: 'Zmafrdeal', use_geolocation: false });
  }
});

// Lightweight public status check — maintenance mode + store name only.
// Used by all buyer pages on load to handle fresh browser / incognito visitors.
// Intentionally minimal: no auth, tiny DB read, short cache header.
app.get('/api/store-status', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('site_settings')
      .select('maintenance_mode, store_name, tagline, whatsapp_number, contact_email, registration_disabled, commission_rate, free_shipping_threshold, default_currency, currency_symbol, currency_name, default_country, show_banners, show_flash_sale, show_recently_viewed, business_hours, contact_location, about_story, help_payments_text')
      .eq('id', 1)
      .single();
    if (error || !data) {
      return sendSuccess(res, { maintenanceMode: false, storeName: 'Zmafrdeal' });
    }
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    return sendSuccess(res, {
      maintenanceMode:      !!data.maintenance_mode,
      storeName:            data.store_name || 'Zmafrdeal',
      tagline:              data.tagline || '',
      whatsappNumber:       data.whatsapp_number || '',
      contactEmail:         data.contact_email || '',
      registrationDisabled: !!data.registration_disabled,
      commissionRate:       data.commission_rate || 10,
      freeShipping:         data.free_shipping_threshold || 0,
      currencyCode:         data.default_currency || '',
      currencySymbol:       data.currency_symbol || '',
      currencyName:         data.currency_name || '',
      country:              data.default_country || '',
      showBanners:          data.show_banners !== false,
      showFlashSale:        data.show_flash_sale !== false,
      showRecentlyViewed:   data.show_recently_viewed !== false,
      businessHours:        data.business_hours   || '',
      contactLocation:      data.contact_location || '',
      aboutStory:           data.about_story      || '',
      helpPaymentsText:     data.help_payments_text || ''
    });
  } catch (e) {
    return sendSuccess(res, { maintenanceMode: false, storeName: 'Zmafrdeal' });
  }
});

// Admin settings
app.get('/api/admin/settings', requireAuthOrAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('site_settings').select('*').single();
    if (error) return sendError(res, 404, 'Settings not found');
    return sendSuccess(res, data);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.put('/api/admin/settings', requireAuthOrAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('site_settings').upsert({ id: 1, ...req.body, updated_at: new Date().toISOString() }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Settings saved');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/admin/clear-flash-sales', requireAuthOrAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('products')
      .update({ is_flash_sale: false, flash_sale_price: null, flash_sale_end: null, flash_sale_stock: 0 })
      .eq('is_flash_sale', true);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'All flash sales cleared');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Messages (user to admin)
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('messages').select('*').eq('user_id', req.user.id).order('created_at', { ascending: true });
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/messages', requireAuth, async (req, res) => {
  try {
    const { subject, message, photo_url } = req.body;
    if (!message && !photo_url) return sendError(res, 400, 'Message or photo is required');
    const insertData = { user_id: req.user.id, subject: subject || 'General Inquiry', message: message || '📷 Photo', status: 'unread', created_at: new Date().toISOString() };
    if (photo_url) insertData.photo_url = photo_url;
    const { data, error } = await supabase.from('messages').insert(insertData).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Message sent to admin');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/admin/users', requireAuthOrAdmin, async (req, res) => {
  try {
    const { role } = req.query;
    let query = supabase.from('profiles').select('*').order('created_at', { ascending: false });
    if (role) query = query.eq('role', role);
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/admin/users/:id/ban', requireAuthOrAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const { error } = await supabase.from('profiles').update({ role: 'buyer', banned: true, ban_reason: reason || null }).eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'User banned');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/admin/sellers/:id/ban', requireAuthOrAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    await supabase.from('profiles').update({ banned: true, ban_reason: reason || null }).eq('id', req.params.id);
    await supabase.from('sellers').update({ status: 'suspended' }).eq('id', req.params.id);
    await supabase.from('notifications').insert({
      user_id: req.params.id, type: 'account',
      title: 'Seller Account Suspended',
      message: reason ? `Your seller account has been suspended. Reason: ${reason}` : 'Your seller account has been suspended. Please contact support for details.',
      read: false, created_at: new Date().toISOString()
    });
    return sendSuccess(res, null, 'Seller banned');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/admin/sellers/:id/unban', requireAuthOrAdmin, async (req, res) => {
  try {
    await supabase.from('profiles').update({ banned: false, ban_reason: null, role: 'seller' }).eq('id', req.params.id);
    await supabase.from('sellers').update({ status: 'approved' }).eq('id', req.params.id);
    await supabase.from('notifications').insert({
      user_id: req.params.id, type: 'account',
      title: 'Seller Account Reinstated',
      message: 'Great news! Your seller account has been reinstated. You can now log in and manage your store.',
      read: false, created_at: new Date().toISOString()
    });
    return sendSuccess(res, null, 'Seller unbanned');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.post('/api/admin/users/:id/unban', requireAuthOrAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('profiles').update({ banned: false }).eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'User unbanned');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/admin/messages', requireAuthOrAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('messages').select('*, profiles(full_name, email)').order('created_at', { ascending: false });
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.patch('/api/admin/messages/:id/reply', requireAuthOrAdmin, async (req, res) => {
  try {
    const { reply } = req.body;
    if (!reply) return sendError(res, 400, 'Reply text is required');
    const { data: msg } = await supabase.from('messages').select('user_id').eq('id', req.params.id).single();
    const { data, error } = await supabase.from('messages').update({ reply, status: 'replied', replied_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    if (msg?.user_id) {
      await supabase.from('notifications').insert({ user_id: msg.user_id, type: 'admin_message', title: 'Support replied to your message', message: reply, read: false, created_at: new Date().toISOString() });
    }
    return sendSuccess(res, data, 'Reply sent');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.delete('/api/admin/messages/:id', requireAuthOrAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('messages').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'Message deleted');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// Search history (recently viewed)
app.post('/api/recently-viewed', async (req, res) => {
  try {
    const { user_id, product_id } = req.body;
    if (!product_id) return sendError(res, 400, 'Product ID required');
    if (user_id) {
      await supabase.from('recently_viewed').upsert({ user_id, product_id, viewed_at: new Date().toISOString() });
    }
    return sendSuccess(res, null, 'Recorded');
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

app.get('/api/recently-viewed/:user_id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('recently_viewed').select('*, products(*)').eq('user_id', req.params.user_id).order('viewed_at', { ascending: false }).limit(20);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
});

// ── Bulk delete endpoints (admin only) ──────────────────────────
app.delete('/api/admin/bulk/products', requireAuthOrAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'All products deleted');
  } catch (e) { return sendError(res, 500, e.message); }
});

app.delete('/api/admin/bulk/orders', requireAuthOrAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'All orders deleted');
  } catch (e) { return sendError(res, 500, e.message); }
});

app.delete('/api/admin/bulk/reviews', requireAuthOrAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('reviews').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'All reviews deleted');
  } catch (e) { return sendError(res, 500, e.message); }
});

app.delete('/api/admin/bulk/vouchers', requireAuthOrAdmin, async (req, res) => {
  try {
    await supabase.from('user_vouchers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { error } = await supabase.from('vouchers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'All vouchers deleted');
  } catch (e) { return sendError(res, 500, e.message); }
});

app.delete('/api/admin/bulk/users', requireAuthOrAdmin, async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
    const { error } = await supabase.from('profiles').delete().eq('role', 'user');
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'All regular users deleted');
  } catch (e) { return sendError(res, 500, e.message); }
});

// ═════════════════════════════════════════════════════════════════════════════
// SPONSORED PRODUCTS
// ═════════════════════════════════════════════════════════════════════════════

// Public: active sponsored products (for index.html display)
app.get('/api/sponsored/active', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('sponsored_products')
      .select('*, products(id,name,home_photo,category,price,stock_available,description,currency,price_ksh)')
      .eq('status', 'approved')
      .lte('start_date', now)
      .gte('end_date', now);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Seller: submit sponsorship request
app.post('/api/sponsored/request', requireAuth, async (req, res) => {
  try {
    const { product_id, placement_preference, budget, duration_days, target_note, contact_phone } = req.body;
    if (!product_id || !placement_preference || !duration_days)
      return sendError(res, 400, 'Product, placement and duration are required');
    const { data: prod } = await supabase.from('products').select('id,name').eq('id', product_id).single();
    if (!prod) return sendError(res, 404, 'Product not found');
    const { data: existing } = await supabase.from('sponsored_products')
      .select('id,status').eq('product_id', product_id).in('status', ['pending','approved']).maybeSingle();
    if (existing) return sendError(res, 400, 'This product already has an active or pending sponsorship');
    const { data, error } = await supabase.from('sponsored_products').insert({
      product_id, seller_id: req.user.id,
      placement_preference, budget: budget || 0,
      duration_days: parseInt(duration_days),
      target_note: target_note || '',
      contact_phone: contact_phone || '',
      status: 'pending',
      impressions: 0, clicks: 0, conversions: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Sponsorship request submitted. Awaiting admin approval.');
  } catch (e) { return sendError(res, 500, e.message); }
});

// Seller: get all their sponsorship records
app.get('/api/sponsored/my', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sponsored_products')
      .select('*, products(id,name,home_photo,category,price)')
      .eq('seller_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Track view or click on a sponsored product
app.post('/api/sponsored/:id/track', async (req, res) => {
  try {
    const { type } = req.body;
    const col = type === 'click' ? 'clicks' : 'impressions';
    const { data: sp } = await supabase.from('sponsored_products').select(col).eq('id', req.params.id).single();
    if (!sp) return sendError(res, 404, 'Not found');
    await supabase.from('sponsored_products').update({ [col]: (sp[col] || 0) + 1, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (type === 'view') {
      await supabase.from('sponsored_views').insert({
        sponsored_id: req.params.id,
        viewer_id: req.headers['x-user-id'] || null,
        created_at: new Date().toISOString()
      });
    }
    return sendSuccess(res, null, 'Tracked');
  } catch (e) { return sendError(res, 500, e.message); }
});

// Seller: analytics for one sponsored record
app.get('/api/sponsored/:id/analytics', requireAuth, async (req, res) => {
  try {
    const { data: sp, error } = await supabase
      .from('sponsored_products')
      .select('*, products(name,price,home_photo)')
      .eq('id', req.params.id)
      .eq('seller_id', req.user.id)
      .single();
    if (error || !sp) return sendError(res, 404, 'Not found');
    const { data: views } = await supabase
      .from('sponsored_views')
      .select('created_at,viewer_id')
      .eq('sponsored_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(50);
    return sendSuccess(res, { ...sp, recent_views: views || [] });
  } catch (e) { return sendError(res, 500, e.message); }
});

// Admin: list all sponsorship requests
app.get('/api/admin/sponsored', requireAuthOrAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sponsored_products')
      .select('*, products(id,name,home_photo,category,status)')
      .order('created_at', { ascending: false });
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Admin: approve with chosen placement
app.patch('/api/admin/sponsored/:id/approve', requireAuthOrAdmin, async (req, res) => {
  try {
    const { placement, admin_notes } = req.body;
    if (!placement) return sendError(res, 400, 'Placement is required');
    const { data: sp } = await supabase.from('sponsored_products').select('*').eq('id', req.params.id).single();
    if (!sp) return sendError(res, 404, 'Not found');
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + (sp.duration_days || 7) * 86400000);
    const { data, error } = await supabase.from('sponsored_products').update({
      status: 'approved', placement,
      admin_notes: admin_notes || '',
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    if (sp.seller_id) {
      const endStr = endDate.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
      await supabase.from('notifications').insert({
        user_id: sp.seller_id, type: 'system',
        title: 'Sponsorship Approved!',
        message: `Your sponsored product was approved. Placement: "${placement}". Active until ${endStr}.`,
        read: false, created_at: new Date().toISOString()
      });
    }
    return sendSuccess(res, data, 'Sponsorship approved');
  } catch (e) { return sendError(res, 500, e.message); }
});

// Admin: reject with reason
app.patch('/api/admin/sponsored/:id/reject', requireAuthOrAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return sendError(res, 400, 'Reason is required');
    const { data: sp } = await supabase.from('sponsored_products').select('seller_id').eq('id', req.params.id).single();
    if (!sp) return sendError(res, 404, 'Not found');
    const { data, error } = await supabase.from('sponsored_products').update({
      status: 'rejected', reason, updated_at: new Date().toISOString()
    }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    if (sp.seller_id) {
      await supabase.from('notifications').insert({
        user_id: sp.seller_id, type: 'system',
        title: 'Sponsorship Request Rejected',
        message: `Your sponsorship request was not approved. Reason: ${reason}`,
        read: false, created_at: new Date().toISOString()
      });
    }
    return sendSuccess(res, data, 'Sponsorship rejected');
  } catch (e) { return sendError(res, 500, e.message); }
});

// Admin: cancel active sponsorship with reason
app.patch('/api/admin/sponsored/:id/cancel', requireAuthOrAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return sendError(res, 400, 'Reason is required');
    const { data: sp } = await supabase.from('sponsored_products').select('seller_id').eq('id', req.params.id).single();
    if (!sp) return sendError(res, 404, 'Not found');
    const { data, error } = await supabase.from('sponsored_products').update({
      status: 'cancelled', reason, updated_at: new Date().toISOString()
    }).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    if (sp.seller_id) {
      await supabase.from('notifications').insert({
        user_id: sp.seller_id, type: 'system',
        title: 'Sponsorship Cancelled',
        message: `Your active sponsorship was cancelled. Reason: ${reason}`,
        read: false, created_at: new Date().toISOString()
      });
    }
    return sendSuccess(res, data, 'Sponsorship cancelled');
  } catch (e) { return sendError(res, 500, e.message); }
});

// ─── HTML serving with dynamic OG tags ────────────────────────────────────────
// Serves index.html; if ?product=ID is present, injects product-specific OG
// meta tags so WhatsApp / social crawlers show the right image & description.
const SITE_URL = process.env.SITE_URL || 'https://zmafrdeal.shop';
const INDEX_PATH = path.join(__dirname, 'index.html');

app.get(['/', '/index.html'], async (req, res) => {
  let html;
  try { html = fs.readFileSync(INDEX_PATH, 'utf8'); }
  catch (e) { return res.status(404).send('index.html not found'); }

  const productId = req.query.product;
  if (productId) {
    try {
      const { data: p } = await supabase
        .from('products')
        .select('name, description, home_photo, price, currency, category')
        .eq('id', productId)
        .single();

      if (p) {
        const curr = p.currency || 'SLL';
        const priceStr = p.price ? `${curr} ${Number(p.price).toLocaleString()}` : '';
        const title = `${p.name}${priceStr ? ' — ' + priceStr : ''} | Zmafrdeal`;
        const rawDesc = (p.description || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const desc = (priceStr ? `${priceStr} · ` : '') + (rawDesc.slice(0, 140) || `Shop ${p.name} on Zmafrdeal. Fast delivery, genuine products.`);
        const image = p.home_photo && p.home_photo.startsWith('http') ? p.home_photo : `${SITE_URL}/zmafrdeal.png`;
        const url = `${SITE_URL}/index.html?product=${productId}`;

        // Replace existing OG tags
        html = html
          .replace(/(<meta property="og:title"[^>]*content=")[^"]*(")/i,   `$1${title.replace(/"/g, '&quot;')}$2`)
          .replace(/(<meta property="og:description"[^>]*content=")[^"]*(")/i, `$1${desc.replace(/"/g, '&quot;')}$2`)
          .replace(/(<meta property="og:image"[^>]*content=")[^"]*(")/i,   `$1${image}$2`);

        // Inject og:url, og:type=product, twitter tags after <head>
        const extra = [
          `<meta property="og:url" content="${url}"/>`,
          `<meta property="og:type" content="product"/>`,
          `<meta property="og:site_name" content="Zmafrdeal"/>`,
          `<meta name="twitter:card" content="summary_large_image"/>`,
          `<meta name="twitter:title" content="${title.replace(/"/g, '&quot;')}"/>`,
          `<meta name="twitter:description" content="${desc.replace(/"/g, '&quot;')}"/>`,
          `<meta name="twitter:image" content="${image}"/>`,
        ].join('\n');
        html = html.replace(/(<\/head>)/i, extra + '\n$1');
      }
    } catch (_) { /* product fetch failed — serve generic html */ }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Short cache: crawlers re-check after 5 min; browsers always get fresh
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
  res.send(html);
});

// ─── CITIES, DISTRICTS & PAYMENT METHODS ─────────────────────────────────────

// Public: GET /api/locations/cities?country=X
app.get('/api/locations/cities', async (req, res) => {
  try {
    const country = req.query.country || '';
    let query = supabase.from('country_cities').select('id,city_name,sort_order,is_main_city').eq('active', true);
    if (country) query = query.eq('country', country);
    query = query.order('sort_order').order('city_name');
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Public: GET /api/locations/districts?country=X
app.get('/api/locations/districts', async (req, res) => {
  try {
    const country = req.query.country || '';
    const city = req.query.city || '';
    let query = supabase.from('country_districts').select('id,district_name,region,sort_order').eq('active', true);
    if (city) query = query.eq('region', city);
    if (country) query = query.eq('country', country);
    query = query.order('region').order('sort_order').order('district_name');
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Public: GET /api/payment-methods?country=X
app.get('/api/payment-methods', async (req, res) => {
  try {
    const country = req.query.country || '';
    let query = supabase.from('country_payment_methods').select('id,name,description,icon_color,method_key,sort_order,checkout_instructions,is_pay_later,payment_link').eq('active', true);
    if (country) query = query.eq('country', country);
    query = query.order('sort_order').order('name');
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Admin: GET /api/admin/cities?country=X
app.get('/api/admin/cities', requireAdmin, async (req, res) => {
  try {
    const country = req.query.country || '';
    let query = supabase.from('country_cities').select('*');
    if (country) query = query.eq('country', country);
    query = query.order('country').order('sort_order').order('city_name');
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) { return sendError(res, 500, e.message); }
});

app.post('/api/admin/cities', requireAdmin, async (req, res) => {
  try {
    const { country, city_name, sort_order = 0, active = true, districts = [] } = req.body;
    if (!country || !city_name) return sendError(res, 400, 'country and city_name required');
    const { data, error } = await supabase.from('country_cities').insert([{ country, city_name: city_name.trim(), sort_order, active }]).select().single();
    if (error) return sendError(res, 500, error.message);
    // Insert districts linked to this city (region = city_name)
    const dList = Array.isArray(districts) ? districts : [];
    if (dList.length) {
      const distRows = dList.map((d, i) => ({ country, district_name: d.trim(), region: city_name.trim(), sort_order: i, active: true }));
      await supabase.from('country_districts').insert(distRows);
    }
    return sendSuccess(res, data, `City added${dList.length ? ` with ${dList.length} district(s)` : ''}`);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Bulk delete all cities for a country
app.delete('/api/admin/cities/all', requireAdmin, async (req, res) => {
  try {
    const { country } = req.query;
    if (!country) return sendError(res, 400, 'country query param required');
    const { error } = await supabase.from('country_cities').delete().eq('country', country);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, `All cities for ${country} deleted`);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Bulk delete all districts for a country (or for a specific city)
app.delete('/api/admin/districts/all', requireAdmin, async (req, res) => {
  try {
    const { country, city } = req.query;
    if (!country) return sendError(res, 400, 'country query param required');
    let q = supabase.from('country_districts').delete().eq('country', country);
    if (city) q = q.eq('region', city);
    const { error } = await q;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, `All districts for ${city || country} deleted`);
  } catch (e) { return sendError(res, 500, e.message); }
});

// Nuclear DB reset
app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  try {
    const { tables = [] } = req.body; // array of table keys to clear
    const tableMap = {
      orders:   () => supabase.from('orders').delete().not('id','is',null),
      products: () => supabase.from('products').delete().not('id','is',null),
      reviews:  () => supabase.from('reviews').delete().not('id','is',null),
      vouchers: () => supabase.from('vouchers').delete().not('id','is',null),
      cities:   () => supabase.from('country_cities').delete().not('id','is',null),
      districts:() => supabase.from('country_districts').delete().not('id','is',null),
      payments: () => supabase.from('country_payment_methods').delete().not('id','is',null),
      countries:() => supabase.from('country_currencies').delete().not('id','is',null),
    };
    const toReset = tables.length ? tables : Object.keys(tableMap);
    const results = {};
    for (const key of toReset) {
      if (tableMap[key]) {
        const { error } = await tableMap[key]();
        results[key] = error ? 'error: ' + error.message : 'cleared';
      }
    }
    return sendSuccess(res, results, 'Reset complete');
  } catch (e) { return sendError(res, 500, e.message); }
});

app.put('/api/admin/cities/:id', requireAdmin, async (req, res) => {
  try {
    const { country, city_name, sort_order, active, is_main_city } = req.body;
    const updates = {};
    if (country !== undefined) updates.country = country;
    if (city_name !== undefined) updates.city_name = city_name.trim();
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (active !== undefined) updates.active = active;
    if (is_main_city !== undefined) updates.is_main_city = is_main_city;
    const { data, error } = await supabase.from('country_cities').update(updates).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'City updated');
  } catch (e) { return sendError(res, 500, e.message); }
});

app.delete('/api/admin/cities/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('country_cities').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'City deleted');
  } catch (e) { return sendError(res, 500, e.message); }
});

// Admin: Districts
app.get('/api/admin/districts', requireAdmin, async (req, res) => {
  try {
    const country = req.query.country || '';
    let query = supabase.from('country_districts').select('*');
    if (country) query = query.eq('country', country);
    query = query.order('country').order('region').order('sort_order').order('district_name');
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) { return sendError(res, 500, e.message); }
});

app.post('/api/admin/districts', requireAdmin, async (req, res) => {
  try {
    const { country, district_name, region = '', sort_order = 0, active = true } = req.body;
    if (!country || !district_name) return sendError(res, 400, 'country and district_name required');
    const { data, error } = await supabase.from('country_districts').insert([{ country, district_name: district_name.trim(), region: region.trim(), sort_order, active }]).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'District added');
  } catch (e) { return sendError(res, 500, e.message); }
});

app.put('/api/admin/districts/:id', requireAdmin, async (req, res) => {
  try {
    const { country, district_name, region, sort_order, active } = req.body;
    const updates = {};
    if (country !== undefined) updates.country = country;
    if (district_name !== undefined) updates.district_name = district_name.trim();
    if (region !== undefined) updates.region = region.trim();
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (active !== undefined) updates.active = active;
    const { data, error } = await supabase.from('country_districts').update(updates).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'District updated');
  } catch (e) { return sendError(res, 500, e.message); }
});

app.delete('/api/admin/districts/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('country_districts').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'District deleted');
  } catch (e) { return sendError(res, 500, e.message); }
});

// Admin: Payment Methods
app.get('/api/admin/payment-methods', requireAdmin, async (req, res) => {
  try {
    const country = req.query.country || '';
    let query = supabase.from('country_payment_methods').select('*');
    if (country) query = query.eq('country', country);
    query = query.order('country').order('sort_order').order('name');
    const { data, error } = await query;
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data || []);
  } catch (e) { return sendError(res, 500, e.message); }
});

app.post('/api/admin/payment-methods', requireAdmin, async (req, res) => {
  try {
    const { country, name, description = '', icon_color = '#888888', method_key, sort_order = 0, active = true, checkout_instructions = '', is_pay_later = false, payment_link = null } = req.body;
    if (!country || !name || !method_key) return sendError(res, 400, 'country, name, and method_key required');
    const { data, error } = await supabase.from('country_payment_methods').insert([{ country, name: name.trim(), description: description.trim(), icon_color, method_key: method_key.trim().toLowerCase().replace(/\s+/g,'_'), sort_order, active, checkout_instructions: checkout_instructions.trim(), is_pay_later: !!is_pay_later, payment_link: payment_link || null }]).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Payment method added');
  } catch (e) { return sendError(res, 500, e.message); }
});

app.put('/api/admin/payment-methods/:id', requireAdmin, async (req, res) => {
  try {
    const { country, name, description, icon_color, method_key, sort_order, active, checkout_instructions, is_pay_later, payment_link } = req.body;
    const updates = {};
    if (country !== undefined) updates.country = country;
    if (name !== undefined) updates.name = name.trim();
    if (description !== undefined) updates.description = description.trim();
    if (icon_color !== undefined) updates.icon_color = icon_color;
    if (method_key !== undefined) updates.method_key = method_key.trim().toLowerCase().replace(/\s+/g,'_');
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (active !== undefined) updates.active = active;
    if (checkout_instructions !== undefined) updates.checkout_instructions = checkout_instructions.trim();
    if (is_pay_later !== undefined) updates.is_pay_later = !!is_pay_later;
    if (payment_link !== undefined) updates.payment_link = payment_link || null;
    const { data, error } = await supabase.from('country_payment_methods').update(updates).eq('id', req.params.id).select().single();
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, data, 'Payment method updated');
  } catch (e) { return sendError(res, 500, e.message); }
});

app.delete('/api/admin/payment-methods/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('country_payment_methods').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, error.message);
    return sendSuccess(res, null, 'Payment method deleted');
  } catch (e) { return sendError(res, 500, e.message); }
});

// 404 handler
app.use((req, res) => sendError(res, 404, `Route ${req.method} ${req.path} not found`));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  sendError(res, 500, 'Internal server error: ' + err.message);
});

app.listen(PORT, () => {
  console.log(`Zmafrdeal server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;
