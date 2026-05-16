'use strict';
const OpenAI = require('openai');
const db = require('./supabase');

const CATEGORIES = ['prompts', 'color_grades', 'brand_briefs', 'workflows', 'storyboards', 'voice_clone', 'references', 'notes'];

function _getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function save(category, title, content, tags = [], client = null) {
  if (!CATEGORIES.includes(category)) category = 'notes';
  return db.saveMemory(category, title, content, tags, client);
}

async function search(query, category = null) {
  return db.searchMemories(query, category);
}

async function list(category = null, limit = 50) {
  return db.listMemories(category, limit);
}

async function getByClient(client_name) {
  const { data, error } = await db.supabase
    .from('memories')
    .select('*')
    .eq('client', client_name)
    .order('created_at', { ascending: false });
  if (error) return [];
  return data;
}

async function remove(id) {
  const { error } = await db.supabase.from('memories').delete().eq('id', id);
  if (error) throw error;
  return true;
}

async function getSummary() {
  const { data } = await db.supabase.from('memories').select('category');
  if (!data) return {};
  return data.reduce((acc, row) => {
    acc[row.category] = (acc[row.category] || 0) + 1;
    return acc;
  }, {});
}

// ── Retrieve relevant memories to inject into system prompt ──────────────────
async function getRelevant(userMessage, limit = 5) {
  try {
    // Extract capitalized words (proper nouns = client/project names)
    const keywords = userMessage
      .split(/\s+/)
      .filter(w => w.length > 3 && /^[A-Z]/.test(w))
      .slice(0, 4)
      .join(' ');

    let memories = [];

    if (keywords) {
      memories = await db.searchMemories(keywords, null);
    }

    // Pad with recent memories if not enough matches
    if (memories.length < limit) {
      const recent = await db.listMemories(null, limit * 3);
      const seen   = new Set(memories.map(m => m.id));
      for (const m of recent) {
        if (!seen.has(m.id)) memories.push(m);
        if (memories.length >= limit) break;
      }
    }

    return memories.slice(0, limit);
  } catch (e) {
    return [];
  }
}

// Format memories as a clean block for injection into system prompt
function formatForPrompt(memories) {
  if (!memories || !memories.length) return '';
  const lines = memories.map(m =>
    `[${m.category}${m.client ? ' / ' + m.client : ''}] ${m.title}: ${m.content.slice(0, 200)}`
  );
  return `MEMORY CONTEXT (from previous sessions):\n${lines.join('\n')}`;
}

// ── Extract and persist key facts from a conversation turn ───────────────────
async function extractAndSave(userMessage, assistantResponse, platform = 'unknown') {
  const prompt = `Extract key facts from this conversation worth remembering for future sessions.

User: ${userMessage.slice(0, 600)}
Assistant: ${assistantResponse.slice(0, 800)}

Extract ONLY significant facts:
- Client names, brands, project names with details
- Approved prompts or creative styles
- Stated preferences ("prefers X", "always use Y", "hates Z")
- Decisions made (approved approach, chosen direction)
- Budget, deadlines, or constraints mentioned
- Campaign themes or brand guidelines established

Return JSON: {"facts":[{"category":"prompts|brand_briefs|notes|workflows|color_grades","title":"short title","content":"the concrete fact in 1-2 sentences","tags":["tag1","tag2"],"client":"client name or null"}]}

RULES: Return empty array if only small talk or questions with no concrete facts. Max 4 facts per turn.`;

  try {
    const client   = _getClient();
    const response = await client.chat.completions.create({
      model:           'gpt-5.4-mini',
      messages:        [{ role: 'user', content: prompt }],
      max_completion_tokens: 600,
      response_format: { type: 'json_object' },
      temperature:     0.2,
    });

    let facts = [];
    try {
      const parsed = JSON.parse(response.choices[0].message.content);
      facts = Array.isArray(parsed) ? parsed : (parsed.facts || parsed.memories || []);
    } catch { return; }

    for (const fact of facts.slice(0, 4)) {
      if (!fact.title || !fact.content) continue;
      const cat = CATEGORIES.includes(fact.category) ? fact.category : 'notes';
      await db.saveMemory(
        cat,
        String(fact.title).slice(0, 120),
        String(fact.content).slice(0, 500),
        Array.isArray(fact.tags) ? fact.tags.slice(0, 5) : [],
        fact.client || null
      );
    }

    if (facts.length > 0) {
      console.log(`[memory] saved ${facts.length} facts from ${platform} conversation`);
    }
  } catch (e) {
    console.error('[memory] extractAndSave failed:', e.message);
  }
}

module.exports = { save, search, list, getByClient, remove, getSummary, getRelevant, formatForPrompt, extractAndSave, CATEGORIES };
