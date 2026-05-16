'use strict';
const router  = require('express').Router();
const gpt     = require('../services/gpt');
const claude  = require('../services/claude');
const { requireAuth } = require('../middleware/auth');
const db      = require('../services/supabase');

// POST /brain/chat
router.post('/chat', requireAuth, async (req, res) => {
  try {
    const { message, session_id, platform = 'dashboard', attachments = [] } = req.body;
    if (!message && attachments.length === 0) {
      return res.status(400).json({ error: 'message or attachments required' });
    }

    let contextParts = [];
    let fullMessage  = message || '';

    // Process attachments first
    for (const att of attachments) {
      if (att.type === 'image' && att.url) {
        const analysis = await gpt.analyzeImage(att.url, 'Analyze this reference image for a creative production session.');
        contextParts.push(`[IMAGE REFERENCE ANALYSIS]\n${analysis}`);
      } else if (att.type === 'video' && att.url) {
        const analysis = await gpt.analyzeVideo(att.url);
        contextParts.push(`[VIDEO REFERENCE ANALYSIS]\n${analysis}`);
      }
    }

    if (contextParts.length > 0) {
      fullMessage = `${fullMessage}\n\n${contextParts.join('\n\n')}`.trim();
    }

    const sid = session_id || `${req.user.id}_${platform}`;
    const result = await gpt.chat(sid, fullMessage, platform);

    // Track conversation (fire-and-forget)
    const convTitle   = (message || 'Attachment').slice(0, 60);
    const lastSnippet = (result.text || '').slice(0, 120);
    db.upsertConversation(req.user.id, sid, platform, convTitle, lastSnippet).catch(() => {});

    // Enrich suggestions based on action
    const suggestions = buildSuggestions(result.action);

    res.json({ text: result.text, action: result.action, suggestions, session_id: sid, conversation_id: sid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /brain/select-engine
router.post('/select-engine', requireAuth, async (req, res) => {
  try {
    const { task, engine, brief, scene, brand_kit } = req.body;
    if (!task || !engine) return res.status(400).json({ error: 'task and engine required' });

    let result;

    if (engine === 'claude') {
      if (task === 'waviboy')    result = await claude.formatWaviboy(brief || scene, brand_kit);
      else if (task === 'seedance') result = await claude.generateSeedanceJSON(brief || scene, 'general');
      else if (task === 'storyboard') result = await claude.structureStoryboard(brief, 6);
      else if (task === 'brand') result = await claude.brandStrategy(brief);
      else result = await claude.formatWaviboy(brief || task, brand_kit);
    } else if (engine === 'gpt') {
      if (task === 'prompt')     result = await gpt.writePrompt(brief || scene, [], 'waviboy');
      else if (task === 'brand') result = await gpt.generateBrandKit(brief, []);
      else if (task === 'storyboard') result = await gpt.generateStoryboard(brief, brand_kit, 6, []);
      else result = await gpt.writePrompt(brief || task, [], 'waviboy');
    } else {
      return res.status(400).json({ error: 'engine must be gpt or claude' });
    }

    res.json({ result, engine, task });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildSuggestions(action = {}) {
  const suggestions = [];
  const act = action.action || '';

  if (act === 'brief' || act === 'brand') {
    suggestions.push(
      { label: '1. GPT Brand Kit', command: '/agency', engine: 'gpt', description: 'Full brand kit + images via GPT' },
      { label: '2. Claude Strategy', command: '/agency', engine: 'claude', description: 'Waviboy structure via Claude' },
      { label: '3. Template', command: '/agency', engine: 'template', description: 'Apply saved Pro Storyboard template' }
    );
  } else if (act === 'storyboard' || act === 'generate') {
    suggestions.push(
      { label: '1. GPT Images', engine: 'gpt', description: 'Fast GPT native generation' },
      { label: '2. Higgsfield', engine: 'higgsfield', description: 'Nano Banana Pro 2K quality' },
      { label: '3. Claude + Higgsfield', engine: 'claude+higgsfield', description: 'Waviboy prompts + Higgsfield render' }
    );
  }
  return suggestions;
}


// GET /brain/conversations
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const convs = await db.listConversations(req.user.id, 60);
    res.json({ conversations: convs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /brain/conversations/:session_id/messages
router.get('/conversations/:session_id/messages', requireAuth, async (req, res) => {
  try {
    const messages = await db.getHistory(req.params.session_id, 100);
    res.json({ messages, session_id: req.params.session_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /brain/conversations/:session_id
router.delete('/conversations/:session_id', requireAuth, async (req, res) => {
  try {
    await db.deleteConversation(req.params.session_id, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
