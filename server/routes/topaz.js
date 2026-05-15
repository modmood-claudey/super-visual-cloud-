'use strict';
const router = require('express').Router();
const db     = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// POST /topaz/request
router.post('/request', requireAuth, async (req, res) => {
  try {
    const { video_url, project_id, scene_id } = req.body;
    if (!video_url) return res.status(400).json({ error: 'video_url required' });

    const job = await db.addTopazJob(video_url, project_id, scene_id, req.user.id);
    res.json({
      job,
      message: 'Added to Topaz queue. Turn on your Mac and run: python mac_agent/topaz_agent.py',
      mac_command: `SERVER_URL=${process.env.SERVER_URL} python mac_agent/topaz_agent.py`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /topaz/queue — Mac agent polls this
router.get('/queue', async (req, res) => {
  // Service token or admin auth
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'token required' });

  try {
    const jwt = require('jsonwebtoken');
    jwt.verify(token, process.env.JWT_SECRET);
    const jobs = await db.getPendingTopazJobs();
    res.json({ jobs });
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
});

// POST /topaz/complete — Mac agent posts result
router.post('/complete', async (req, res) => {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'token required' });

  try {
    const jwt = require('jsonwebtoken');
    jwt.verify(token, process.env.JWT_SECRET);

    const { job_id, result_url } = req.body;
    if (!job_id || !result_url) return res.status(400).json({ error: 'job_id and result_url required' });

    const job = await db.completeTopazJob(job_id, result_url);

    // Update scene video_url if scene_id exists
    if (job.scene_id) {
      await db.updateScene(job.scene_id, { video_url: result_url });
    }

    // Notify via Telegram if bot is running
    const tgModule = global.telegramBot;
    if (tgModule && job.requested_by) {
      try {
        tgModule.sendMessage(job.requested_by, `✅ Topaz upscaling complete!\n${result_url}`);
      } catch (_) {}
    }

    res.json({ ok: true, job });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
