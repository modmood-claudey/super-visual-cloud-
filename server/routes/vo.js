'use strict';
const router    = require('express').Router();
const el        = require('../services/elevenlabs');
const multer    = require('multer');
const { requireAuth } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// POST /vo/generate
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const {
      text,
      dialect   = 'qatari',
      gender    = 'male',
      age       = 'mid',
      emotion   = 'luxury',
      project_id = null,
    } = req.body;

    if (!text) return res.status(400).json({ error: 'text required' });

    const result = await el.generate(text, dialect, gender, age, emotion, project_id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /vo/script — generate Arabic script via GPT then synthesize
router.post('/script', requireAuth, async (req, res) => {
  try {
    const {
      scene,
      brand_name  = 'Super Visual',
      dialect     = 'qatari',
      duration    = 15,
      tone        = 'luxury',
      gender      = 'male',
      age         = 'mid',
      emotion     = 'luxury',
      project_id  = null,
      generate_audio = true,
    } = req.body;

    if (!scene) return res.status(400).json({ error: 'scene required' });

    const script = await el.generateScript(scene, brand_name, dialect, duration, tone);

    let audio = null;
    if (generate_audio) {
      audio = await el.generate(script, dialect, gender, age, emotion, project_id);
    }

    res.json({ script, audio, dialect, tone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /vo/clone — clone voice from uploaded audio
router.post('/clone', requireAuth, upload.single('audio'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    const result = await el.clone(name, req.file.buffer);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /vo/voices
router.get('/voices', requireAuth, async (req, res) => {
  try {
    const voices = await el.listVoices();
    res.json({ voices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /vo/quota
router.get('/quota', requireAuth, async (req, res) => {
  try {
    const quota = await el.getQuota();
    res.json(quota);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
