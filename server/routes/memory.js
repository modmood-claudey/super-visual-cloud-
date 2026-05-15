'use strict';
const router = require('express').Router();
const mem    = require('../services/memory');
const { requireAuth } = require('../middleware/auth');

router.get('/list', requireAuth, async (req, res) => {
  try {
    const { category, limit = 50 } = req.query;
    const items = await mem.list(category || null, parseInt(limit));
    res.json({ items, categories: mem.CATEGORIES });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/search', requireAuth, async (req, res) => {
  try {
    const { q, category } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const items = await mem.search(q, category || null);
    res.json({ items, query: q });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/save', requireAuth, async (req, res) => {
  try {
    const { category, title, content, tags = [], client } = req.body;
    if (!category || !title || !content) return res.status(400).json({ error: 'category, title, content required' });
    const item = await mem.save(category, title, content, tags, client);
    res.status(201).json({ item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await mem.remove(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/summary', requireAuth, async (req, res) => {
  try {
    const summary = await mem.getSummary();
    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
