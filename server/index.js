'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const path        = require('path');
const multer      = require('multer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security ───────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(rateLimit({ windowMs: 60000, max: 100, standardHeaders: true, legacyHeaders: false }));

// ── Body parsers ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Root redirect must come before static middleware (otherwise index.html is served first)
app.get('/', (_req, res) => res.redirect(302, '/login'));

// ── Static files (dashboard) ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── File upload endpoint ───────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
let uploadFile = async () => { throw new Error('Supabase not configured'); };
try { uploadFile = require('./services/supabase').uploadFile; }
catch (e) { console.error('[startup] supabase init failed:', e.message); }

app.post('/upload', require('./middleware/auth').requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const ext    = require('path').extname(req.file.originalname) || '.bin';
    const bucket = req.file.mimetype.startsWith('image/') ? 'references'
                 : req.file.mimetype.startsWith('video/') ? 'references'
                 : req.file.mimetype.startsWith('audio/') ? 'vo-files'
                 : 'references';
    const fname  = `upload_${Date.now()}${ext}`;
    const url    = await uploadFile(bucket, fname, req.file.buffer, req.file.mimetype);
    res.json({ url, filename: fname, mimetype: req.file.mimetype });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Safe route loader ────────────────────────────────────────────────────────
function safeRequire(mod) {
  try { return require(mod); }
  catch (e) {
    console.error('[startup] Failed to load module:', mod, '-', e.message);
    const r = require('express').Router();
    r.all('*', (_req, res) => res.status(503).json({ error: 'Route unavailable', detail: e.message }));
    return r;
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/auth',       safeRequire('./routes/auth'));
app.use('/brain',      safeRequire('./routes/brain'));
app.use('/generate',   safeRequire('./routes/generate'));
app.use('/storyboard', safeRequire('./routes/storyboard'));
app.use('/storyboard', safeRequire('./routes/storyboard_routes'));
app.use('/branding',   safeRequire('./routes/branding'));
app.use('/vo',         safeRequire('./routes/vo'));
app.use('/memory',     safeRequire('./routes/memory'));
app.use('/projects',   safeRequire('./routes/projects'));
app.use('/topaz',      safeRequire('./routes/topaz'));

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const checks = { server: 'ok', timestamp: new Date().toISOString() };

  // GPT
  try {
    const { checkImageLimit } = require('./services/gpt');
    const limit = await checkImageLimit();
    checks.gpt = { status: 'ok', images_remaining: limit.remaining };
  } catch (e) { checks.gpt = { status: 'error', error: e.message }; }

  // Supabase
  try {
    const { supabase } = require('./services/supabase');
    await supabase.from('users').select('id').limit(1);
    checks.supabase = 'ok';
  } catch (e) { checks.supabase = { status: 'error', error: e.message }; }

  // Anthropic
  checks.anthropic = process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing key';
  checks.higgsfield = process.env.HIGGSFIELD_API_KEY ? 'configured' : 'missing key';
  checks.elevenlabs = process.env.ELEVENLABS_API_KEY ? 'configured' : 'missing key';
  checks.telegram   = process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'missing key';

  const ok = checks.gpt?.status === 'ok' && checks.supabase === 'ok';
  res.status(ok ? 200 : 503).json(checks);
});

// ── Static PWA files ──────────────────────────────────────────────────────────
app.get('/manifest.json', (_req, res) => res.sendFile('manifest.json', { root: path.join(__dirname, 'public') }));
app.get('/sw.js',         (_req, res) => res.sendFile('sw.js',         { root: path.join(__dirname, 'public') }));
app.get('/icon-192.png',  (_req, res) => res.sendFile('icon-192.png',  { root: path.join(__dirname, 'public') }));
app.get('/icon-512.png',  (_req, res) => res.sendFile('icon-512.png',  { root: path.join(__dirname, 'public') }));

// ── Page routing ──────────────────────────────────────────────────────────────

// Login page
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/login.html', (_req, res) => {
  res.redirect(301, '/login');
});

// Dashboard app (client-side auth guard in app.html)
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/app/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// ── API aliases ────────────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => res.redirect(307, '/health'));
app.get('/api/chats',  require('./middleware/auth').requireAuth, async (req, res) => {
  try {
    const { listConversations } = require('./services/supabase');
    const convs = await listConversations(req.user.id, 60);
    res.json({ conversations: convs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chats — save new chat
app.post('/api/chats', require('./middleware/auth').requireAuth, async (req, res) => {
  try {
    const { supabase } = require('./services/supabase');
    const { title, messages } = req.body;
    const lastMsg = messages?.[messages.length-1]?.content || '';
    const row = { user_id: req.user.id, session_id: `api_${Date.now()}`, platform: 'dashboard', title: title || 'Untitled' };
    // Include last_message only if column exists (avoids schema cache errors if migration not run)
    const { data, error } = await supabase
      .from('conversations')
      .insert({ ...row, last_message: lastMsg })
      .select().single();
    if (error && error.message && error.message.includes('last_message')) {
      // Retry without last_message (migration not yet applied)
      const { data: data2, error: error2 } = await supabase
        .from('conversations').insert(row).select().single();
      if (error2) throw error2;
      return res.json(data2);
    }
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/chats/:id — get single chat
app.get('/api/chats/:id', require('./middleware/auth').requireAuth, async (req, res) => {
  try {
    const { supabase } = require('./services/supabase');
    const { data, error } = await supabase.from('conversations').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fallback — 404 for API routes, marketing site for everything else
app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/brain') ||
      req.path.startsWith('/storyboard') || req.path.startsWith('/generate') || req.path.startsWith('/branding') ||
      req.path.startsWith('/projects') || req.path.startsWith('/memory') || req.path.startsWith('/vo') ||
      req.path.startsWith('/upload') || req.path.startsWith('/health') || req.path.startsWith('/topaz')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Super Visual Cloud running on port ${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);

  // Start Telegram bot (only if TELEGRAM_POLLING=true — avoids conflict with standalone bot.py)
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_POLLING === 'true') {
    try {
      const { startBot } = require('./bots/telegram');
      startBot();
    } catch (e) {
      console.error('[telegram] Failed to start:', e.message);
    }
  }

  // Check conversations table exists — warn clearly if migration not run
  (async () => {
    try {
      const { supabase } = require('./services/supabase');
      const { error } = await supabase.from('conversations').select('id').limit(1);
      if (error && error.code === '42P01') {
        console.warn('[startup] ⚠️  conversations table missing — run this in Supabase SQL Editor:');
        console.warn('  server/migrations/001_conversations.sql');
      } else if (!error) {
        console.log('[startup] conversations table OK');
      } else {
        console.warn('[startup] conversations check:', error.message);
      }
    } catch (e) {
      console.warn('[startup] conversations check failed:', e.message);
    }
  })();

  // Seed admin user if not exists
  (async () => {
    try {
      const { getUserByEmail, createUser } = require('./services/supabase');
      const bcrypt = require('bcryptjs');
      const adminEmail = process.env.ADMIN_EMAIL || 'mohammad@supervisual.com';
      const adminPass  = process.env.ADMIN_PASSWORD || 'SuperVisual2026!';
      const existing   = await getUserByEmail(adminEmail);
      if (!existing) {
        const hash = await bcrypt.hash(adminPass, 12);
        await createUser(adminEmail, hash, 'Mohammad', 'admin');
        console.log('[startup] Admin user seeded:', adminEmail);
      } else {
        console.log('[startup] Admin user exists:', adminEmail);
      }
    } catch (e) {
      console.error('[startup] Admin seed failed (DB may not be ready):', e.message);
    }
  })();

  // Start WhatsApp bot (optional — requires QR scan)
  if (process.env.START_WHATSAPP === 'true') {
    require('./bots/whatsapp').startBot().catch(e => {
      console.error('[whatsapp] Failed to start:', e.message);
    });
  }
});

module.exports = app;
