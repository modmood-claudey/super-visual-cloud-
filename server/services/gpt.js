'use strict';
const OpenAI = require('openai');
const { saveMessage, getHistory, logGptImage, countGptImages } = require('./supabase');

const GPT_IMAGE_LIMIT = 45;
const GPT_IMAGE_WINDOW_HOURS = 3;

const GPT_SYSTEM_PROMPT = `You are the AI Creative Director for Super Visual — a premium media production company in Doha Qatar run by Mohammad Abu Al-Rob.

CLIENTS: Alcazar (luxury travel, Ritz-Carlton Doha shoot), ASDAM Perfumes (Vistula/Rhine/Volga/La Seine — Symphony of Scent campaign), Sadad Payment, Chef Mustafa/Haya Haya, Style Shams, Cozy Care, Vigneto.qa (replica fashion), Iksha 360, Peugeot 5008 Ingaro Blue, Joelle FHC.

YOUR ROLE: Shape rough ideas into polished creative concepts. Write prompts. Generate brand kits. Build storyboards. Analyze references. Always offer 3 paths when generating:
  1) GPT native (you do it all — brand + images)
  2) Claude precision (Waviboy/Seedance JSON)
  3) Saved templates (Pro Storyboard system)

PROMPT RULES (always follow for image/video prompts):
- Specific camera body + lens (e.g. Hasselblad X2D 80mm f/2.8)
- Lighting with ratio + Kelvin (e.g. Rembrandt 4:1, 5600K key)
- Film/sensor reference (e.g. Kodak Portra 400)
- Micro-texture (pores, subsurface scattering, atmospheric haze)
- Composition (geometric framing, negative space, camera height)
- Color grade (lifted blacks, highlight rolloff, dominant hues)
- NEVER use: cinematic, moody, vibrant, stunning, ethereal, dynamic, dreamy
- Append "no 3D, no cartoon, no VFX" for live-action/realistic

STORYBOARD: 7 separate assets — Hero image + 6 scene frames + 2 character sheets (multi-angle) + 1 environment wide shot. NEVER one prompt = full board. Per frame must include: ACTION + CAMERA + LIGHTING + MOOD.
Colors: #F2C94C #F2994A #6B8E23 #D9C7A1 #7FAFD4

COMMUNICATION: Short and direct only. No essays. Copy-paste ready. Default ratio: 9:16.
Always respond in English unless user writes in Arabic first.

AT THE END OF EVERY RESPONSE when a task is detected, output this JSON on its own line:
{"action":"brief|storyboard|generate|approve|prompt|pipeline|brand|vo","client":"name or null","output":"generated content or null","command":"/command or null","engine":"gpt|claude|template"}`;

let _client = null;

function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

function parseActionJSON(text) {
  const lines = text.trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('{') && t.includes('"action"')) {
      try { return JSON.parse(t); } catch (_) {}
    }
  }
  return {};
}

function stripActionJSON(text) {
  const lines = text.trim().split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last.startsWith('{') && last.includes('"action"')) lines.pop();
    else break;
  }
  return lines.join('\n').trim();
}

async function chat(session_id, userMessage, platform = 'dashboard', systemOverride = null) {
  const client = getClient();
  const history = await getHistory(session_id, 16);

  const messages = [
    { role: 'system', content: systemOverride || GPT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const response = await client.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages,
    max_tokens: 1024,
    temperature: 0.7,
  });

  const raw = response.choices[0].message.content;
  const action = parseActionJSON(raw);
  const text   = stripActionJSON(raw);

  await saveMessage(session_id, platform, 'user', userMessage);
  await saveMessage(session_id, platform, 'assistant', raw);

  return { text, action, raw };
}

async function analyzeImage(image_url, prompt = 'Analyze this image for a creative production director.') {
  const client = getClient();
  const response = await client.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: image_url, detail: 'high' } },
      ],
    }],
    max_tokens: 800,
  });
  return response.choices[0].message.content;
}

async function analyzeVideo(video_url, prompt = null) {
  const analysisPrompt = prompt || `Analyze this video reference for a media production director. Extract and structure:
1) Camera angles and shot types used
2) Lighting setup and color temperature estimate
3) Color grade style (shadows, highlights, saturation)
4) Camera movement and motion style
5) Pacing and cut rhythm (cuts per minute)
6) Mood and atmosphere
7) Specific techniques worth replicating
Output as structured Waviboy-style production notes. Be specific and technical.`;

  const client = getClient();
  const response = await client.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: analysisPrompt },
        { type: 'image_url', image_url: { url: video_url, detail: 'high' } },
      ],
    }],
    max_tokens: 1000,
  });
  return response.choices[0].message.content;
}

async function writePrompt(brief, refs = [], style = 'waviboy') {
  const client = getClient();
  const refText = refs.length > 0 ? `\n\nReference images provided: ${refs.join(', ')}` : '';
  const msg = `Write a ${style} image prompt for: ${brief}${refText}

Follow ALL prompt rules:
- Specific camera body + lens
- Lighting with ratio + Kelvin temperature
- Film/sensor reference
- Micro-texture details
- Composition with geometric framing
- Color grade description
- Append "no 3D, no cartoon, no VFX"
- NEVER use: cinematic, moody, vibrant, stunning, ethereal, dynamic, dreamy

Output only the prompt, nothing else.`;

  const response = await client.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: msg }],
    max_tokens: 600,
    temperature: 0.8,
  });
  return response.choices[0].message.content.trim();
}

async function generateBrandKit(brief, refs = []) {
  const client = getClient();
  const msg = `Create a complete brand kit for: ${brief}${refs.length ? '\n\nRefs: ' + refs.join(', ') : ''}

Return ONLY valid JSON in this exact structure:
{
  "brand_name": "...",
  "tagline": "...",
  "color_palette": [{"hex":"#...","name":"...","usage":"..."}],
  "typography": {"primary":"...","secondary":"..."},
  "tone_of_voice": "...",
  "visual_style": "...",
  "logo_concept_description": "...",
  "campaign_theme": "...",
  "target_audience": "..."
}`;

  const response = await client.chat.completions.create({
    model: 'gpt-5.5-2026-04-23',
    messages: [{ role: 'user', content: msg }],
    max_tokens: 1000,
    response_format: { type: 'json_object' },
    temperature: 0.7,
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return { brand_name: 'Unknown', tagline: '', raw: response.choices[0].message.content };
  }
}

async function generateStoryboard(brief, brand_kit, num_scenes = 6, refs = []) {
  const client = getClient();
  const brandContext = brand_kit
    ? `Brand: ${brand_kit.brand_name}. Style: ${brand_kit.visual_style}. Theme: ${brand_kit.campaign_theme}.`
    : '';

  const msg = `Create a ${num_scenes}-scene storyboard for: ${brief}
${brandContext}
${refs.length ? 'Refs: ' + refs.join(', ') : ''}

Return ONLY valid JSON array:
[{
  "num": 1,
  "title": "Scene title",
  "duration": "5s",
  "action": "What happens physically",
  "camera": "Camera body + lens + angle + movement",
  "lighting": "Setup with Kelvin + ratio",
  "mood": "Atmosphere description",
  "prompt": "Full Waviboy image prompt for this scene"
}]

Rules: NEVER use cinematic/moody/vibrant/stunning/ethereal/dynamic/dreamy in prompts. Include camera body+lens+Kelvin+film reference in every prompt.`;

  const response = await client.chat.completions.create({
    model: 'gpt-5.5-2026-04-23',
    messages: [{ role: 'user', content: msg }],
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    temperature: 0.7,
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content);
    return Array.isArray(parsed) ? parsed : parsed.scenes || parsed.storyboard || [];
  } catch {
    return [];
  }
}

async function generateImages(prompts, user_id = null) {
  const limit = await checkImageLimit();
  if (limit.limit_hit) {
    return { limit_hit: true, switch_to: 'higgsfield', remaining: 0 };
  }

  const client = getClient();
  const results = [];
  const promptList = Array.isArray(prompts) ? prompts : [prompts];

  for (const prompt of promptList.slice(0, limit.remaining)) {
    try {
      const response = await client.images.generate({
        model: 'gpt-image-1',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
      });
      const url = response.data[0]?.url || response.data[0]?.b64_json;
      results.push({ url, prompt });
      await logGptImage(user_id, prompt, url);
    } catch (e) {
      results.push({ error: e.message, prompt });
    }
  }

  const newRemaining = limit.remaining - results.filter(r => !r.error).length;
  return { images: results, remaining: newRemaining, limit_hit: newRemaining <= 0 };
}

async function checkImageLimit() {
  const used      = await countGptImages(GPT_IMAGE_WINDOW_HOURS);
  const remaining = Math.max(0, GPT_IMAGE_LIMIT - used);
  return {
    used,
    remaining,
    limit:     GPT_IMAGE_LIMIT,
    limit_hit: remaining <= 0,
    window_hours: GPT_IMAGE_WINDOW_HOURS,
  };
}

async function adjustPromptFromFeedback(original_prompt, feedback, bad_image_urls = [], best_image_url = null) {
  const client = getClient();
  const imgParts = [];

  if (best_image_url) {
    imgParts.push({ type: 'text', text: 'Best result so far (use as reference for direction):' });
    imgParts.push({ type: 'image_url', image_url: { url: best_image_url } });
  }
  for (const url of bad_image_urls.slice(0, 3)) {
    imgParts.push({ type: 'text', text: 'Bad result (identify what went wrong):' });
    imgParts.push({ type: 'image_url', image_url: { url } });
  }

  const textPart = {
    type: 'text',
    text: `Original prompt: ${original_prompt}\n\nUser feedback: ${feedback}\n\nAnalyze the results and write an improved Waviboy prompt. Follow all prompt rules (camera+lens, Kelvin, film reference, micro-texture, composition, color grade). Output only the improved prompt.`,
  };

  const response = await client.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: [textPart, ...imgParts] }],
    max_tokens: 600,
  });
  return response.choices[0].message.content.trim();
}

module.exports = {
  GPT_SYSTEM_PROMPT,
  chat,
  analyzeImage,
  analyzeVideo,
  writePrompt,
  generateBrandKit,
  generateStoryboard,
  generateImages,
  checkImageLimit,
  adjustPromptFromFeedback,
};
