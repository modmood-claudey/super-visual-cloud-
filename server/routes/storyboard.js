'use strict';
const router     = require('express').Router();
const gpt        = require('../services/gpt');
const claude     = require('../services/claude');
const higgsfield = require('../services/higgsfield');
const db         = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// POST /storyboard/start
router.post('/start', requireAuth, async (req, res) => {
  try {
    const { brief, client, project_name, num_scenes = 6, engine = 'gpt' } = req.body;
    if (!brief) return res.status(400).json({ error: 'brief required' });

    // Create or reuse project
    let project;
    if (req.body.project_id) {
      project = await db.getProject(req.body.project_id);
    } else {
      project = await db.createProject({
        client: client || 'Unknown',
        name: project_name || `Project ${Date.now()}`,
        brief,
        user_id: req.user.id,
      });
    }

    // Generate scene breakdown
    const scenes = engine === 'claude'
      ? await claude.structureStoryboard(brief, num_scenes)
      : await gpt.generateStoryboard(brief, null, num_scenes);

    // Save scenes to DB
    const saved = [];
    for (const scene of scenes) {
      const row = await db.createScene({
        project_id: project.id,
        num:        scene.num || saved.length + 1,
        title:      scene.title,
        action:     scene.action,
        camera:     scene.camera,
        lighting:   scene.lighting,
        mood:       scene.mood,
        prompt:     scene.prompt || '',
        status:     'pending',
      });
      saved.push(row);
    }

    res.json({ project, scenes: saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /storyboard/scene/generate
router.post('/scene/generate', requireAuth, async (req, res) => {
  try {
    const { scene_id, engine = 'auto', refs = [] } = req.body;
    if (!scene_id) return res.status(400).json({ error: 'scene_id required' });

    const scene   = await db.getScene(scene_id);
    const prompt  = scene.prompt || `${scene.action} ${scene.camera} ${scene.lighting}`;
    const limit   = await gpt.checkImageLimit();

    let image_url, engine_used;

    if ((engine === 'gpt' || engine === 'auto') && limit.remaining > 0) {
      engine_used = 'gpt';
      const result = await gpt.generateImages([prompt], req.user.id);
      if (result.images?.[0]?.url) {
        image_url = result.images[0].url;
      } else {
        engine_used = 'higgsfield';
      }
    }

    if (!image_url || engine === 'higgsfield') {
      engine_used = 'higgsfield';
      const hf = await higgsfield.generateAndWait(prompt, 'image', refs);
      image_url = hf.result_url;
    }

    const updated = await db.updateScene(scene_id, { image_url, status: 'generated' });
    const newLimit = await gpt.checkImageLimit();

    res.json({ scene: updated, engine_used, gpt_remaining: newLimit.remaining });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /storyboard/scene/approve
router.post('/scene/approve', requireAuth, async (req, res) => {
  try {
    const { scene_id } = req.body;
    const scene = await db.updateScene(scene_id, { status: 'approved', approved_at: new Date().toISOString() });
    res.json({ scene });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /storyboard/scene/retry
router.post('/scene/retry', requireAuth, async (req, res) => {
  try {
    const { scene_id, engine = 'auto', refs = [] } = req.body;
    req.body = { scene_id, engine, refs };
    return require('./storyboard').handle(req, res);
  } catch (e) {
    // Regenerate same prompt
    const scene = await db.getScene(req.body.scene_id);
    const limit = await gpt.checkImageLimit();
    let image_url, engine_used;

    if (limit.remaining > 0) {
      engine_used = 'gpt';
      const result = await gpt.generateImages([scene.prompt], req.user.id);
      image_url = result.images?.[0]?.url;
    }
    if (!image_url) {
      engine_used = 'higgsfield';
      const hf = await higgsfield.generateAndWait(scene.prompt, 'image', []);
      image_url = hf.result_url;
    }
    const updated = await db.updateScene(req.body.scene_id, { image_url, status: 'generated' });
    res.json({ scene: updated, engine_used });
  }
});

// POST /storyboard/scene/adjust
router.post('/scene/adjust', requireAuth, async (req, res) => {
  try {
    const { scene_id, feedback, best_image_url } = req.body;
    if (!scene_id || !feedback) return res.status(400).json({ error: 'scene_id and feedback required' });

    const scene       = await db.getScene(scene_id);
    const new_prompt  = await gpt.adjustPromptFromFeedback(scene.prompt, feedback, [], best_image_url);
    await db.updateScene(scene_id, { prompt: new_prompt, status: 'adjusting' });

    const limit = await gpt.checkImageLimit();
    let image_url, engine_used;

    if (limit.remaining > 0) {
      engine_used = 'gpt';
      const result = await gpt.generateImages([new_prompt], req.user.id);
      image_url = result.images?.[0]?.url;
    }
    if (!image_url) {
      engine_used = 'higgsfield';
      const hf = await higgsfield.generateAndWait(new_prompt, 'image', best_image_url ? [best_image_url] : []);
      image_url = hf.result_url;
    }

    const updated = await db.updateScene(scene_id, { image_url, prompt: new_prompt, status: 'generated' });
    res.json({ scene: updated, new_prompt, engine_used });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /storyboard/scene/allbad
router.post('/scene/allbad', requireAuth, async (req, res) => {
  try {
    const { scene_id, bad_images = [], feedback } = req.body;
    if (!scene_id) return res.status(400).json({ error: 'scene_id required' });

    const scene      = await db.getScene(scene_id);
    const new_prompt = await gpt.adjustPromptFromFeedback(scene.prompt, feedback || 'All results were bad. Fix the core issues.', bad_images);
    await db.updateScene(scene_id, { prompt: new_prompt, status: 'adjusting' });

    const limit = await gpt.checkImageLimit();
    let image_url, engine_used;

    if (limit.remaining > 0) {
      engine_used = 'gpt';
      const result = await gpt.generateImages([new_prompt], req.user.id);
      image_url = result.images?.[0]?.url;
    }
    if (!image_url) {
      engine_used = 'higgsfield';
      const hf = await higgsfield.generateAndWait(new_prompt, 'image', []);
      image_url = hf.result_url;
    }

    const updated = await db.updateScene(scene_id, { image_url, prompt: new_prompt, status: 'generated' });
    res.json({ scene: updated, new_prompt, engine_used, diagnosed: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /storyboard/compile
router.post('/compile', requireAuth, async (req, res) => {
  try {
    const { project_id } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });

    const project = await db.getProject(project_id);
    const scenes  = await db.listScenes(project_id);
    const approved = scenes.filter(s => s.status === 'approved' || s.image_url);

    if (approved.length === 0) return res.status(400).json({ error: 'No approved scenes to compile' });

    const html = buildStoryboardHTML(project, approved);
    const buffer = Buffer.from(html, 'utf8');
    const filename = `storyboard_${project_id}_${Date.now()}.html`;
    const url = await db.uploadFile('storyboards', filename, buffer, 'text/html');

    res.json({ url, filename, scene_count: approved.length, project: project.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /storyboard/:project_id
router.get('/:project_id', requireAuth, async (req, res) => {
  try {
    const scenes  = await db.listScenes(req.params.project_id);
    const project = await db.getProject(req.params.project_id);
    res.json({ project, scenes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildStoryboardHTML(project, scenes) {
  const sceneCards = scenes.map(s => `
    <div class="scene">
      <div class="scene-num">SCENE ${s.num}</div>
      <div class="scene-title">${s.title || ''}</div>
      ${s.image_url ? `<img src="${s.image_url}" alt="Scene ${s.num}">` : '<div class="no-img">No image</div>'}
      <div class="meta">
        <div><strong>ACTION:</strong> ${s.action || ''}</div>
        <div><strong>CAMERA:</strong> ${s.camera || ''}</div>
        <div><strong>LIGHTING:</strong> ${s.lighting || ''}</div>
        <div><strong>MOOD:</strong> ${s.mood || ''}</div>
      </div>
      ${s.prompt ? `<div class="prompt">${s.prompt}</div>` : ''}
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${project.name} — Super Visual Storyboard</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0a0a0a; color: #e8e8e8; font-family: -apple-system, sans-serif; padding: 40px; }
h1 { color: #F2C94C; font-size: 28px; margin-bottom: 8px; }
.client { color: #888; font-size: 14px; margin-bottom: 32px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 24px; }
.scene { background: #141414; border: 1px solid #2a2a2a; border-radius: 12px; overflow: hidden; }
.scene-num { background: #F2C94C; color: #000; font-size: 10px; font-weight: 700; padding: 4px 12px; letter-spacing: 1px; }
.scene-title { padding: 12px 16px 8px; font-size: 14px; font-weight: 600; }
img { width: 100%; aspect-ratio: 9/16; object-fit: cover; }
.no-img { width: 100%; aspect-ratio: 9/16; background: #1c1c1c; display: flex; align-items: center; justify-content: center; color: #555; font-size: 12px; }
.meta { padding: 12px 16px; font-size: 11px; line-height: 1.8; color: #aaa; border-top: 1px solid #2a2a2a; }
.meta strong { color: #F2C94C; }
.prompt { padding: 10px 16px; font-size: 10px; color: #666; border-top: 1px solid #1c1c1c; font-family: monospace; line-height: 1.5; }
</style>
</head>
<body>
<h1>${project.name}</h1>
<div class="client">${project.client} · Super Visual · ${new Date().toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'})}</div>
<div class="grid">${sceneCards}</div>
</body>
</html>`;
}

module.exports = router;
