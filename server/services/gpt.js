'use strict';
const OpenAI = require('openai');
const axios  = require('axios');
const { saveMessage, getHistory, logGptImage, countGptImages, uploadFile } = require('./supabase');

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
    max_completion_tokens: 1024,
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
    max_completion_tokens: 800,
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
    max_completion_tokens: 1000,
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
    max_completion_tokens: 600,
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
    max_completion_tokens: 1000,
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
    max_completion_tokens: 2000,
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
    max_completion_tokens: 600,
  });
  return response.choices[0].message.content.trim();
}

async function generateFullStoryboard(brief, refs = [], videoRefs = [], numScenes = 6, clientName = '', projectName = '') {
  const gptClient = getClient();

  // Build vision message with text + all ref images
  const contentParts = [
    {
      type: 'text',
      text: `You are a creative director for Super Visual, Doha Qatar.
Analyze these references and brief. Output JSON only:
{
  "brand_kit": {"name":"...","tagline":"...","colors":[{"hex":"...","usage":"..."}],"tone":"...","visual_style":"..."},
  "scenes": [{"num":1,"title":"...","duration":"5s","action":"...","camera":"...","lighting":"...","mood":"...","prompt":"..."}]
}
Scene prompts MUST follow Waviboy rules:
- Specific camera body + lens
- Lighting + Kelvin
- Film/sensor reference
- Micro-texture details
- Composition
- Color grade
- NEVER use: cinematic, moody, vibrant, stunning, ethereal, dynamic, dreamy
- Append: no 3D, no cartoon, no VFX
Generate exactly ${numScenes} scenes.

Brief: ${brief}
Client: ${clientName}
Project: ${projectName}`,
    },
  ];

  for (const refUrl of refs.slice(0, 10)) {
    try {
      const resp = await axios.get(refUrl, { responseType: 'arraybuffer', timeout: 15000 });
      const b64  = Buffer.from(resp.data).toString('base64');
      const ct   = resp.headers['content-type'] || 'image/jpeg';
      contentParts.push({ type: 'image_url', image_url: { url: `data:${ct};base64,${b64}`, detail: 'high' } });
    } catch (_) {}
  }

  const analysisResp = await gptClient.chat.completions.create({
    model: 'gpt-5.5-2026-04-23',
    messages: [{ role: 'user', content: contentParts }],
    max_completion_tokens: 4000,
    response_format: { type: 'json_object' },
  });

  let parsed;
  try {
    parsed = JSON.parse(analysisResp.choices[0].message.content);
  } catch {
    throw new Error('GPT returned invalid JSON for storyboard');
  }

  const brand_kit = parsed.brand_kit || {};
  const scenes    = (parsed.scenes   || []).slice(0, numScenes);

  // Generate image for each scene
  const image_urls = [];

  for (const scene of scenes) {
    try {
      const styleCtx   = brand_kit.visual_style ? ` Style: ${brand_kit.visual_style}.` : '';
      const fullPrompt = `${scene.prompt}${styleCtx}`;

      const imgResp = await gptClient.images.generate({
        model:   'gpt-image-2',
        prompt:  fullPrompt,
        n:       1,
        size:    '1024x1536',
        quality: 'high',
      });

      const item = imgResp.data[0];
      let buf;

      if (item?.url) {
        const dl = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 30000 });
        buf = Buffer.from(dl.data);
      } else if (item?.b64_json) {
        buf = Buffer.from(item.b64_json, 'base64');
      }

      if (buf) {
        const fname      = `fullboard_scene_${Date.now()}_${scene.num}.png`;
        const publicUrl  = await uploadFile('references', fname, buf, 'image/png');
        scene.image_url  = publicUrl;
        image_urls.push(publicUrl);
        await logGptImage(null, scene.prompt, publicUrl);
      }
    } catch (e) {
      scene.image_url   = null;
      scene.image_error = e.message;
    }
  }

  // Build HTML storyboard sheet → PNG → upload
  const html = buildFullStoryboardHTML(brand_kit, scenes, clientName, projectName);
  let storyboard_url = null;

  try {
    const pngBuf  = await htmlToPng(html);
    const fname   = `storyboard_full_${Date.now()}.png`;
    storyboard_url = await uploadFile('storyboards', fname, pngBuf, 'image/png');
  } catch (_) {
    try {
      const htmlBuf  = Buffer.from(html, 'utf8');
      const fname    = `storyboard_full_${Date.now()}.html`;
      storyboard_url = await uploadFile('storyboards', fname, htmlBuf, 'text/html');
    } catch (_2) {}
  }

  return { brand_kit, scenes, storyboard_url, image_urls };
}

async function htmlToPng(html) {
  const puppeteer = require('puppeteer-core');
  let executablePath;

  try {
    const chromium = require('@sparticuz/chromium');
    executablePath  = await chromium.executablePath();
  } catch (_) {
    executablePath = process.env.CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
    executablePath,
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return await page.screenshot({ fullPage: true, type: 'png' });
  } finally {
    await browser.close().catch(() => {});
  }
}

function buildFullStoryboardHTML(brand_kit, scenes, clientName, projectName) {
  const palette = (brand_kit.colors || [])
    .map(c => `<span class="swatch" style="background:${c.hex}" title="${c.usage || c.hex}"></span>`)
    .join('');

  const sceneCards = scenes.map(s => `
    <div class="scene">
      <div class="scene-num">SCENE ${s.num}</div>
      <div class="scene-title">${s.title || ''}</div>
      ${s.image_url
        ? `<img src="${s.image_url}" alt="Scene ${s.num}">`
        : '<div class="no-img">No image</div>'}
      <div class="meta">
        <div><strong>ACTION:</strong> ${s.action || ''}</div>
        <div><strong>CAMERA:</strong> ${s.camera || ''}</div>
        <div><strong>LIGHTING:</strong> ${s.lighting || ''}</div>
        <div><strong>MOOD:</strong> ${s.mood || ''}</div>
      </div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${brand_kit.name || projectName} — Super Visual Storyboard</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0a0a0a; color: #e8e8e8; font-family: -apple-system, sans-serif; padding: 40px; }
.header { margin-bottom: 32px; border-bottom: 1px solid #2a2a2a; padding-bottom: 24px; }
h1 { color: #F2C94C; font-size: 32px; margin-bottom: 6px; }
.tagline { color: #888; font-size: 15px; margin-bottom: 16px; }
.palette { display: flex; gap: 8px; }
.swatch { display: inline-block; width: 28px; height: 28px; border-radius: 50%; border: 1px solid #333; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 24px; }
.scene { background: #141414; border: 1px solid #2a2a2a; border-radius: 12px; overflow: hidden; }
.scene-num { background: #F2C94C; color: #000; font-size: 10px; font-weight: 700; padding: 4px 12px; letter-spacing: 1px; }
.scene-title { padding: 10px 16px 6px; font-size: 14px; font-weight: 600; }
img { width: 100%; aspect-ratio: 2/3; object-fit: cover; }
.no-img { width: 100%; aspect-ratio: 2/3; background: #1c1c1c; display: flex; align-items: center; justify-content: center; color: #555; font-size: 12px; }
.meta { padding: 12px 16px; font-size: 11px; line-height: 1.9; color: #aaa; border-top: 1px solid #222; }
.meta strong { color: #F2C94C; }
footer { margin-top: 40px; text-align: center; color: #444; font-size: 11px; border-top: 1px solid #1c1c1c; padding-top: 20px; }
</style>
</head>
<body>
<div class="header">
  <h1>${brand_kit.name || projectName || 'Storyboard'}</h1>
  <div class="tagline">${brand_kit.tagline || ''}</div>
  <div class="palette">${palette}</div>
</div>
<div class="grid">${sceneCards}</div>
<footer>${clientName} · Super Visual Doha · ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</footer>
</body>
</html>`;
}

module.exports = {
  GPT_SYSTEM_PROMPT,
  chat,
  analyzeImage,
  analyzeVideo,
  writePrompt,
  generateBrandKit,
  generateStoryboard,
  generateFullStoryboard,
  generateImages,
  checkImageLimit,
  adjustPromptFromFeedback,
};
