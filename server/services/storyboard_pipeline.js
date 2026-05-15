'use strict';
const OpenAI = require('openai');
const axios  = require('axios');
const { uploadFile, logGptImage } = require('./supabase');

const sessions = new Map();

function _getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ── Session ───────────────────────────────────────────────────────────────────
function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      step:         'idle',
      numScenes:    6,
      brand_mode:   null,   // 'existing' | 'create' | 'skip'
      brand_assets: [],     // { type:'text'|'image'|'video', content?, url? }
      brief:        null,
      refs:         [],     // { type:'image'|'video', url }
      brandKit:     null,
      scenes:       [],
      storyboard_url: null,
    });
  }
  return sessions.get(id);
}

function clearSession(id) { sessions.delete(id); }

// ── Start ─────────────────────────────────────────────────────────────────────
function startStoryboard(id) {
  const sess = getSession(id);
  Object.assign(sess, {
    step: 'num_scenes', brand_mode: null, brand_assets: [],
    brief: null, refs: [], brandKit: null, scenes: [], storyboard_url: null,
  });
  return { message: '🎬 *Full Storyboard*\n\nHow many scenes?\n\n*6* — Short reel\n*9* — Full campaign\n*12* — Extended' };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function handleMessage(id, text, attachments = []) {
  const sess = getSession(id);
  const t    = (text || '').trim();

  if (sess.step === 'idle') return { message: '❌ Send /fullboard to start.' };

  // ── num_scenes ──────────────────────────────────────────────────────────────
  if (sess.step === 'num_scenes') {
    const num = parseInt(t);
    if (!num || num < 1 || num > 30) return { message: '❌ Reply with a number: 6, 9, or 12' };
    sess.numScenes = num;
    sess.step = 'brand_choice';
    return {
      message: `✅ *${num} scenes.*\n\nDoes the client have an existing brand?\n\n1️⃣ Yes — I'll upload brand assets\n2️⃣ No — Create brand kit from scratch\n3️⃣ Skip — Just storyboard, no brand kit`,
    };
  }

  // ── brand_choice ────────────────────────────────────────────────────────────
  if (sess.step === 'brand_choice') {
    const lower = t.toLowerCase();
    if (lower === '1' || lower === 'yes') {
      sess.brand_mode = 'existing';
      sess.step       = 'collecting_brand_assets';
      return { message: '📁 Send brand assets: logo image, brand images, known colors, brand name.\n\nType *DONE* when finished.' };
    }
    if (lower === '2' || lower === 'no') {
      sess.brand_mode = 'create';
      sess.step       = 'collecting_refs';
      return { message: '✏️ Got it. Send your brief + reference images/videos.\n\nType *DONE* when ready to generate.' };
    }
    if (lower === '3' || lower === 'skip') {
      sess.brand_mode = 'skip';
      sess.brandKit   = null;
      sess.step       = 'collecting_refs';
      return { message: '⏭️ Skipping brand kit. Send your brief + references.\n\nType *DONE* when ready to generate.' };
    }
    return { message: '❌ Reply with 1, 2, or 3' };
  }

  // ── collecting_brand_assets ─────────────────────────────────────────────────
  if (sess.step === 'collecting_brand_assets') {
    if (t.toUpperCase() === 'DONE') {
      if (!sess.brand_assets.length) return { message: '⚠️ Send at least one brand asset first.' };
      return { message: '🔍 Extracting brand kit from assets…', action: 'extract_brand' };
    }
    if (t) sess.brand_assets.push({ type: 'text', content: t });
    for (const att of attachments) sess.brand_assets.push(att);
    return { message: `📎 Saved (${sess.brand_assets.length} assets). Send more or type *DONE*.` };
  }

  // ── collecting_refs ─────────────────────────────────────────────────────────
  if (sess.step === 'collecting_refs') {
    if (t.toUpperCase() === 'DONE') {
      if (!sess.brief && !sess.refs.length) return { message: '⚠️ Send brief or reference images before DONE.' };
      return { message: '🚀 Generating storyboard… (2–3 min)', action: 'generate' };
    }
    if (t) sess.brief = sess.brief ? `${sess.brief}\n${t}` : t;
    for (const att of attachments) sess.refs.push(att);
    const parts = [];
    if (sess.brief)       parts.push('brief saved');
    if (sess.refs.length) parts.push(`${sess.refs.length} refs`);
    return { message: `✅ ${parts.join(', ')}. Send more or type *DONE* to generate.` };
  }

  return { message: '❌ Unknown step. Send /fullboard to restart.' };
}

// ── Extract brand kit from uploaded assets ────────────────────────────────────
async function extractBrandKit(id) {
  const sess   = getSession(id);
  const client = _getClient();

  const contentParts = [{
    type: 'text',
    text: `Analyze these brand assets. Extract and return JSON only:
{
  "name": "brand name",
  "tagline": "tagline or slogan",
  "colors": [{"hex":"#RRGGBB","usage":"primary|secondary|accent"}],
  "tone": "tone of voice description",
  "visual_style": "visual style description"
}`,
  }];

  for (const asset of sess.brand_assets.slice(0, 10)) {
    if (asset.type === 'text') {
      contentParts[0].text += `\n\nAdditional context: ${asset.content}`;
    } else if (asset.url) {
      try {
        const r   = await axios.get(asset.url, { responseType: 'arraybuffer', timeout: 15000 });
        const b64 = Buffer.from(r.data).toString('base64');
        const ct  = r.headers['content-type'] || 'image/jpeg';
        contentParts.push({ type: 'image_url', image_url: { url: `data:${ct};base64,${b64}`, detail: 'high' } });
      } catch (_) {}
    }
  }

  const resp = await client.chat.completions.create({
    model: 'gpt-5.5-2026-04-23',
    messages: [{ role: 'user', content: contentParts }],
    max_tokens: 600,
    response_format: { type: 'json_object' },
  });

  try { sess.brandKit = JSON.parse(resp.choices[0].message.content); }
  catch { sess.brandKit = { name: 'Unknown' }; }

  sess.step = 'collecting_refs';

  const kit    = sess.brandKit;
  const colors = (kit.colors || []).map(c => c.hex).join(', ');
  return {
    brandKit: sess.brandKit,
    message:
      `🎨 *Brand Kit Extracted*\n\n*${kit.name || ''}*\n_${kit.tagline || ''}_\n\n` +
      `Colors: ${colors}\nStyle: ${kit.visual_style || ''}\n\n` +
      `Looks good? Now send your brief + reference images/videos.\nType *DONE* when ready.`,
  };
}

// ── Full generation ───────────────────────────────────────────────────────────
async function runGeneration(id) {
  const sess    = getSession(id);
  const client  = _getClient();
  const refUrls = sess.refs.map(r => r.url).filter(Boolean);
  const brief   = sess.brief || '';

  // Build system prompt based on brand_mode
  let brandInstruction;
  if (sess.brand_mode === 'skip') {
    brandInstruction = `Generate ONLY scenes — no brand kit. Output JSON only:
{"scenes":[{"num":1,"title":"...","duration":"5s","action":"...","camera":"...","lighting":"...","mood":"...","prompt":"..."}]}`;
  } else if (sess.brand_mode === 'existing' && sess.brandKit) {
    brandInstruction = `Use the EXISTING brand identity below — do NOT invent a new brand.
Existing brand: ${JSON.stringify(sess.brandKit)}

Output JSON only:
{"brand_kit":{"name":"...","tagline":"...","colors":[{"hex":"...","usage":"..."}],"tone":"...","visual_style":"..."},"scenes":[{"num":1,"title":"...","duration":"5s","action":"...","camera":"...","lighting":"...","mood":"...","prompt":"..."}]}`;
  } else {
    brandInstruction = `Create a new brand kit for this client. Output JSON only:
{"brand_kit":{"name":"...","tagline":"...","colors":[{"hex":"...","usage":"..."}],"tone":"...","visual_style":"..."},"scenes":[{"num":1,"title":"...","duration":"5s","action":"...","camera":"...","lighting":"...","mood":"...","prompt":"..."}]}`;
  }

  const fullPrompt = `You are a creative director for Super Visual, Doha Qatar.
Analyze these references and brief.

${brandInstruction}

Scene prompts MUST follow Waviboy rules:
- Specific camera body + lens (e.g. Hasselblad X2D 80mm f/2.8)
- Lighting + Kelvin (e.g. Rembrandt 4:1 5600K key)
- Film/sensor reference (e.g. Kodak Portra 400)
- Micro-texture details
- Composition (geometric framing, negative space)
- Color grade (lifted blacks, highlight rolloff)
- NEVER use: cinematic, moody, vibrant, stunning, ethereal, dynamic, dreamy
- Append: no 3D, no cartoon, no VFX
Generate exactly ${sess.numScenes} scenes.

Brief: ${brief}`;

  const contentParts = [{ type: 'text', text: fullPrompt }];

  for (const url of refUrls.slice(0, 10)) {
    try {
      const r   = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
      const b64 = Buffer.from(r.data).toString('base64');
      const ct  = r.headers['content-type'] || 'image/jpeg';
      contentParts.push({ type: 'image_url', image_url: { url: `data:${ct};base64,${b64}`, detail: 'high' } });
    } catch (_) {}
  }

  const analysisResp = await client.chat.completions.create({
    model:           'gpt-5.5-2026-04-23',
    messages:        [{ role: 'user', content: contentParts }],
    max_tokens:      4000,
    response_format: { type: 'json_object' },
  });

  let parsed;
  try { parsed = JSON.parse(analysisResp.choices[0].message.content); }
  catch { throw new Error('GPT returned invalid JSON for storyboard'); }

  const brand_kit = sess.brand_mode === 'skip' ? null : (parsed.brand_kit || sess.brandKit || {});
  const scenes    = (parsed.scenes || []).slice(0, sess.numScenes);

  // Generate image per scene with gpt-image-2
  const image_urls = [];
  for (const scene of scenes) {
    try {
      const styleCtx   = brand_kit?.visual_style ? ` Style: ${brand_kit.visual_style}.` : '';
      const imgResp    = await client.images.generate({
        model: 'gpt-image-2', prompt: `${scene.prompt}${styleCtx}`,
        n: 1, size: '1024x1536', quality: 'high',
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
        const fname     = `scene_${Date.now()}_${scene.num}.png`;
        const publicUrl = await uploadFile('references', fname, buf, 'image/png');
        scene.image_url = publicUrl;
        image_urls.push(publicUrl);
        await logGptImage(null, scene.prompt, publicUrl);
      }
    } catch (e) { scene.image_url = null; scene.image_error = e.message; }
  }

  // Build storyboard HTML → PNG → upload
  const html = _buildHTML(brand_kit, scenes);
  let storyboard_url = null;
  try {
    const puppeteer = require('puppeteer-core');
    let executablePath;
    try { const chromium = require('@sparticuz/chromium'); executablePath = await chromium.executablePath(); }
    catch { executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; }
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: { width: 1440, height: 900 }, executablePath, headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      const pngBuf = await page.screenshot({ fullPage: true, type: 'png' });
      storyboard_url = await uploadFile('storyboards', `storyboard_${Date.now()}.png`, pngBuf, 'image/png');
    } finally { await browser.close().catch(() => {}); }
  } catch (_) {
    try { storyboard_url = await uploadFile('storyboards', `storyboard_${Date.now()}.html`, Buffer.from(html, 'utf8'), 'text/html'); }
    catch (_2) {}
  }

  sess.brandKit       = brand_kit;
  sess.scenes         = scenes;
  sess.storyboard_url = storyboard_url;
  sess.step           = 'done';

  return { brand_kit, scenes, storyboard_url, image_urls };
}

function _buildHTML(brand_kit, scenes) {
  const palette = (brand_kit?.colors || [])
    .map(c => `<span style="display:inline-block;width:28px;height:28px;border-radius:50%;background:${c.hex};border:1px solid #333;margin-right:6px" title="${c.usage||c.hex}"></span>`)
    .join('');
  const cards = scenes.map(s => `
    <div style="background:#141414;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden">
      <div style="background:#F2C94C;color:#000;font-size:10px;font-weight:700;padding:4px 12px;letter-spacing:1px">SCENE ${s.num}</div>
      <div style="padding:10px 16px 6px;font-size:14px;font-weight:600">${s.title || ''}</div>
      ${s.image_url
        ? `<img src="${s.image_url}" style="width:100%;aspect-ratio:2/3;object-fit:cover">`
        : '<div style="width:100%;aspect-ratio:2/3;background:#1c1c1c;display:flex;align-items:center;justify-content:center;color:#555;font-size:12px">No image</div>'}
      <div style="padding:12px 16px;font-size:11px;line-height:1.9;color:#aaa;border-top:1px solid #222">
        <div><strong style="color:#F2C94C">ACTION:</strong> ${s.action || ''}</div>
        <div><strong style="color:#F2C94C">CAMERA:</strong> ${s.camera || ''}</div>
        <div><strong style="color:#F2C94C">LIGHTING:</strong> ${s.lighting || ''}</div>
        <div><strong style="color:#F2C94C">MOOD:</strong> ${s.mood || ''}</div>
      </div>
    </div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Storyboard</title></head>
<body style="background:#0a0a0a;color:#e8e8e8;font-family:-apple-system,sans-serif;padding:40px">
  <div style="margin-bottom:32px;border-bottom:1px solid #2a2a2a;padding-bottom:24px">
    <h1 style="color:#F2C94C;font-size:32px;margin:0 0 6px">${brand_kit?.name || 'Storyboard'}</h1>
    <div style="color:#888;font-size:15px;margin-bottom:16px">${brand_kit?.tagline || ''}</div>
    <div>${palette}</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:24px">${cards}</div>
  <div style="margin-top:40px;text-align:center;color:#444;font-size:11px;border-top:1px solid #1c1c1c;padding-top:20px">
    Super Visual Doha · ${new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })}
  </div>
</body></html>`;
}

module.exports = { getSession, clearSession, startStoryboard, handleMessage, extractBrandKit, runGeneration };
