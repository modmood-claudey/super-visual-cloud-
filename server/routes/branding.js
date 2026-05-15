'use strict';
const router     = require('express').Router();
const gpt        = require('../services/gpt');
const claude     = require('../services/claude');
const higgsfield = require('../services/higgsfield');
const db         = require('../services/supabase');
const memory     = require('../services/memory');
const { requireAuth } = require('../middleware/auth');

// POST /branding/generate
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const { brief, client, project_name, refs = [], engine = 'gpt', num_scenes = 6 } = req.body;
    if (!brief) return res.status(400).json({ error: 'brief required' });

    const project = await db.createProject({
      client: client || 'Unknown',
      name: project_name || `${engine} Brand ${Date.now()}`,
      brief,
      user_id: req.user.id,
    });

    let brand_kit, storyboard, images = [], strategy = null;

    if (engine === 'gpt') {
      // Full GPT pipeline
      brand_kit  = await gpt.generateBrandKit(brief, refs);
      storyboard = await gpt.generateStoryboard(brief, brand_kit, num_scenes, refs);

      const prompts = storyboard.map(s => s.prompt).filter(Boolean);
      const imgResult = await gpt.generateImages(prompts, req.user.id);
      images = imgResult.images || [];

      // Save scenes with images
      for (let i = 0; i < storyboard.length; i++) {
        const scene = storyboard[i];
        await db.createScene({
          project_id: project.id,
          num: scene.num || i + 1,
          title: scene.title,
          action: scene.action,
          camera: scene.camera,
          lighting: scene.lighting,
          mood: scene.mood,
          prompt: scene.prompt,
          image_url: images[i]?.url || null,
          status: images[i]?.url ? 'generated' : 'pending',
        });
      }

      await db.updateProject(project.id, { brand_kit });

    } else if (engine === 'claude') {
      // Claude structure + Higgsfield render
      strategy   = await claude.brandStrategy(brief);
      storyboard = await claude.structureStoryboard(brief, num_scenes);

      // Add Waviboy prompts to each scene
      for (const scene of storyboard) {
        scene.prompt = await claude.formatWaviboy(`${scene.action}. ${scene.camera}. ${scene.lighting}`, null);
      }

      // Generate images via Higgsfield
      for (let i = 0; i < storyboard.length; i++) {
        const scene = storyboard[i];
        try {
          const hf = await higgsfield.generateAndWait(scene.prompt, 'image', refs, null);
          scene.image_url = hf.result_url;
          images.push({ url: hf.result_url, prompt: scene.prompt });
        } catch {
          scene.image_url = null;
        }

        await db.createScene({
          project_id: project.id,
          num: scene.num || i + 1,
          title: scene.title,
          action: scene.action,
          camera: scene.camera,
          lighting: scene.lighting,
          mood: scene.mood,
          prompt: scene.prompt,
          image_url: scene.image_url,
          status: scene.image_url ? 'generated' : 'pending',
        });
      }

      brand_kit = strategy;
      await db.updateProject(project.id, { brand_kit: strategy });

    } else if (engine === 'template') {
      // Load template from memory
      const templates = await memory.list('storyboards', 5);
      const template  = templates[0];
      if (!template) return res.status(404).json({ error: 'No saved templates found. Save a storyboard to memory first.' });

      storyboard = JSON.parse(template.content || '[]');
      brand_kit  = { template_name: template.title, source: 'saved_template' };

      for (let i = 0; i < storyboard.length; i++) {
        await db.createScene({ project_id: project.id, ...storyboard[i], num: i + 1, status: 'pending' });
      }
    }

    const scenes = await db.listScenes(project.id);
    res.json({ project, brand_kit, strategy, storyboard: scenes, images, engine });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /branding/switch-engine
router.post('/switch-engine', requireAuth, async (req, res) => {
  try {
    const { project_id, from_engine, to_engine } = req.body;
    if (!project_id || !to_engine) return res.status(400).json({ error: 'project_id and to_engine required' });

    const project = await db.getProject(project_id);
    const scenes  = await db.listScenes(project_id);
    const results = [];

    for (const scene of scenes) {
      if (scene.status === 'approved') continue;

      let new_prompt = scene.prompt;
      if (to_engine === 'claude') {
        new_prompt = await claude.formatWaviboy(scene.action, project.brand_kit);
        await db.updateScene(scene.id, { prompt: new_prompt });
      }

      const limit = await gpt.checkImageLimit();
      let image_url, engine_used;

      if (to_engine === 'gpt' && limit.remaining > 0) {
        engine_used = 'gpt';
        const r = await gpt.generateImages([new_prompt], req.user.id);
        image_url = r.images?.[0]?.url;
      } else {
        engine_used = 'higgsfield';
        const hf = await higgsfield.generateAndWait(new_prompt, 'image', []);
        image_url = hf.result_url;
      }

      const updated = await db.updateScene(scene.id, { image_url, status: 'generated' });
      results.push({ ...updated, engine_used });
    }

    res.json({ scenes: results, from_engine, to_engine, project_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
