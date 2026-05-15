'use strict';
const router = require('express').Router();
const db     = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const projects = await db.listProjects(req.user.id);
    res.json({ projects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/create', requireAuth, async (req, res) => {
  try {
    const { client, name, brief } = req.body;
    if (!client || !name) return res.status(400).json({ error: 'client and name required' });
    const project = await db.createProject({ client, name, brief: brief || '', user_id: req.user.id });
    res.status(201).json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const project = await db.getProject(req.params.id);
    const scenes  = await db.listScenes(req.params.id);
    res.json({ project, scenes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const project = await db.updateProject(req.params.id, req.body);
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
