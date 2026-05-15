'use strict';
const router   = require('express').Router();
const pipeline = require('../services/storyboard_pipeline');
const db       = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// POST /storyboard/full — API trigger (bypasses bot flow)
router.post('/full', requireAuth, async (req, res) => {
  try {
    const {
      brief, refs = [], num_scenes = 6,
      client = '', project = '',
      brand_mode = 'create', brand_kit = null,
    } = req.body;
    if (!brief) return res.status(400).json({ error: 'brief required' });

    const id   = `api_${req.user.id}_${Date.now()}`;
    const sess = pipeline.getSession(id);
    pipeline.startStoryboard(id);
    Object.assign(sess, {
      numScenes:  num_scenes,
      brand_mode: brand_mode,
      brandKit:   brand_kit,
      brief,
      refs:  refs.map(url => ({ type: 'image', url })),
      step: 'collecting_refs',
    });

    const result = await pipeline.runGeneration(id);

    const dbProject = await db.createProject({
      client:    client || 'Unknown',
      name:      result.brand_kit?.name || project || `Project ${Date.now()}`,
      brief,
      user_id:   req.user.id,
      brand_kit: result.brand_kit,
    });

    for (let i = 0; i < result.scenes.length; i++) {
      const s = result.scenes[i];
      await db.createScene({
        project_id: dbProject.id,
        num:        s.num || i + 1,
        title:      s.title,  action:   s.action,
        camera:     s.camera, lighting: s.lighting,
        mood:       s.mood,   prompt:   s.prompt,
        image_url:  s.image_url || null,
        status:     s.image_url ? 'generated' : 'pending',
      });
    }

    const tgBot = global.telegramBot;
    if (tgBot) {
      const chatId = parseInt(process.env.TELEGRAM_ALLOWED_CHAT_ID || '6327308132');
      tgBot.sendMessage(
        chatId,
        `✅ *Full Storyboard Ready*\n*${result.brand_kit?.name || 'Storyboard'}*\n${result.scenes.length} scenes\n${result.storyboard_url || ''}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }

    pipeline.clearSession(id);
    res.json({ ...result, project: dbProject });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /storyboard/session/:id — session status
router.get('/session/:id', requireAuth, (req, res) => {
  const sess = pipeline.getSession(req.params.id);
  res.json({
    step:       sess.step,
    numScenes:  sess.numScenes,
    brand_mode: sess.brand_mode,
    refs_count: sess.refs.length,
    has_brief:  !!sess.brief,
  });
});

module.exports = router;
