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

// ── Static files (dashboard) ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── File upload endpoint ───────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const { uploadFile } = require('./services/supabase');

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

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/auth',       require('./routes/auth'));
app.use('/brain',      require('./routes/brain'));
app.use('/generate',   require('./routes/generate'));
app.use('/storyboard', require('./routes/storyboard'));
app.use('/storyboard', require('./routes/storyboard_routes'));
app.use('/branding',   require('./routes/branding'));
app.use('/vo',         require('./routes/vo'));
app.use('/memory',     require('./routes/memory'));
app.use('/projects',   require('./routes/projects'));
app.use('/topaz',      require('./routes/topaz'));

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

// ── SPA fallback ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Super Visual Cloud running on port ${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);

  // Start Telegram bot
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const { startBot } = require('./bots/telegram');
      startBot();
    } catch (e) {
      console.error('[telegram] Failed to start:', e.message);
    }
  }

  // Start WhatsApp bot (optional — requires QR scan)
  if (process.env.START_WHATSAPP === 'true') {
    require('./bots/whatsapp').startBot().catch(e => {
      console.error('[whatsapp] Failed to start:', e.message);
    });
  }
});

module.exports = app;
