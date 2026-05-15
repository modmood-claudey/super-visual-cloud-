'use strict';
const router      = require('express').Router();
const gpt         = require('../services/gpt');
const higgsfield  = require('../services/higgsfield');
const { requireAuth } = require('../middleware/auth');

// POST /generate/image
router.post('/image', requireAuth, async (req, res) => {
  try {
    const { prompt, refs = [], model, engine = 'auto' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const limit = await gpt.checkImageLimit();

    let result;
    let engine_used = engine;

    if (engine === 'gpt' || (engine === 'auto' && limit.remaining > 0)) {
      engine_used = 'gpt';
      result = await gpt.generateImages([prompt], req.user?.id);
      if (result.limit_hit && engine === 'auto') {
        engine_used = 'higgsfield';
        const hf = await higgsfield.generateAndWait(prompt, 'image', refs, model);
        result = { images: [{ url: hf.result_url, prompt }], engine_used, remaining: 0 };
      }
    } else {
      engine_used = 'higgsfield';
      const hf = await higgsfield.generateAndWait(prompt, 'image', refs, model);
      result = { images: [{ url: hf.result_url, prompt }], engine_used };
    }

    res.json({ ...result, engine_used, gpt_remaining: limit.remaining });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /generate/video
router.post('/video', requireAuth, async (req, res) => {
  try {
    const { prompt, refs = [], seedance_json } = req.body;
    if (!prompt && !seedance_json) return res.status(400).json({ error: 'prompt or seedance_json required' });

    const finalPrompt = prompt || (Array.isArray(seedance_json)
      ? seedance_json.find(s => s.lang === 'en')?.prompt || seedance_json[0]?.prompt
      : prompt);

    const job = await higgsfield.generateVideo(finalPrompt, refs);
    res.json({ job_id: job.job_id, status: 'pending', poll_url: `/generate/status/${job.job_id}`, engine: 'higgsfield' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /generate/status/:job_id
router.get('/status/:job_id', requireAuth, async (req, res) => {
  try {
    const job = await higgsfield.getJobStatus(req.params.job_id);
    res.json(job);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /generate/limit
router.get('/limit', requireAuth, async (req, res) => {
  try {
    const limit = await gpt.checkImageLimit();
    res.json(limit);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
