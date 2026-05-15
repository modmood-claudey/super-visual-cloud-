'use strict';
const TelegramBot = require('node-telegram-bot-api');
const gpt         = require('../services/gpt');
const claude      = require('../services/claude');
const higgsfield  = require('../services/higgsfield');
const el          = require('../services/elevenlabs');
const db          = require('../services/supabase');
const mem         = require('../services/memory');
const { signToken } = require('../middleware/auth');

const ALLOWED_CHAT_ID = parseInt(process.env.TELEGRAM_ALLOWED_CHAT_ID || '6327308132', 10);

// Per-chat session state
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      project: null,
      pendingAction: null,
      engine: 'gpt',
      storyboard: [],
      serviceToken: signToken({ id: String(chatId), role: 'service', platform: 'telegram' }, '365d'),
    });
  }
  return sessions.get(chatId);
}

function allowed(chatId) {
  return chatId === ALLOWED_CHAT_ID;
}

const MENU_TEXT = `*Super Visual AI Pipeline*

📸 /image \\[prompt\\] — generate image
🎬 /video \\[prompt\\] — generate video
🏢 /agency — full brand campaign
📋 /storyboard — new storyboard
✅ /approve \\[num\\] — approve scene
🔄 /retry \\[num\\] — retry scene
✏️ /adjust \\[num\\] — adjust with feedback
❌ /allbad \\[num\\] — all bad, fix prompt
🎬 /compile — compile approved scenes
🎙 /vo \\[text\\|dialect\\|gender\\|age\\|emotion\\]
📁 /project \\[client\\] \\[name\\]
🧠 /brain — memory browser
📊 /status
🔀 /switch \\[gpt\\|claude\\|higgsfield\\]`;

function startBot() {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  global.telegramBot = bot;

  const send = (chatId, text, opts = {}) =>
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts }).catch(e => {
      if (!e.message.includes('message is not modified')) console.error('[TG send]', e.message);
    });

  const genButtons = (scene_id) => ({
    inline_keyboard: [[
      { text: '✅ Approve',       callback_data: `approve:${scene_id}` },
      { text: '🔄 Retry',         callback_data: `retry:${scene_id}` },
      { text: '✏️ Adjust',        callback_data: `adjust:${scene_id}` },
      { text: '❌ All Bad',       callback_data: `allbad:${scene_id}` },
      { text: '🔀 Switch Engine', callback_data: `switch:${scene_id}` },
    ]],
  });

  const engineButtons = () => ({
    inline_keyboard: [[
      { text: '1️⃣ GPT',              callback_data: 'engine:gpt' },
      { text: '2️⃣ Claude+Waviboy',   callback_data: 'engine:claude' },
      { text: '3️⃣ Template',         callback_data: 'engine:template' },
    ]],
  });

  // ── /start ────────────────────────────────────────────────────────────────
  bot.onText(/\/start/, (msg) => {
    if (!allowed(msg.chat.id)) return;
    send(msg.chat.id, MENU_TEXT);
  });

  // ── /status ───────────────────────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    if (!allowed(msg.chat.id)) return;
    const sess  = getSession(msg.chat.id);
    const limit = await gpt.checkImageLimit().catch(() => ({ remaining: '?', used: '?' }));
    const proj  = sess.project ? `${sess.project.client} / ${sess.project.name}` : 'None';
    send(msg.chat.id,
      `📊 *Status*\n\n` +
      `Project: ${proj}\n` +
      `Engine: ${sess.engine}\n` +
      `GPT Images: ${limit.remaining}/${limit.limit} remaining\n` +
      `Scenes: ${sess.storyboard.length}`
    );
  });

  // ── /switch ───────────────────────────────────────────────────────────────
  bot.onText(/\/switch (.+)/, (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const sess = getSession(msg.chat.id);
    const eng  = match[1].trim().toLowerCase();
    if (['gpt', 'claude', 'higgsfield', 'template'].includes(eng)) {
      sess.engine = eng;
      send(msg.chat.id, `🔀 Engine switched to: *${eng}*`);
    } else {
      send(msg.chat.id, 'Usage: /switch gpt|claude|higgsfield|template');
    }
  });

  // ── /project ──────────────────────────────────────────────────────────────
  bot.onText(/\/project (.+)/, async (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const parts   = match[1].trim().split(/\s+/);
    const client  = parts[0];
    const name    = parts.slice(1).join(' ') || 'Default';
    const sess    = getSession(msg.chat.id);

    try {
      const userId = String(msg.chat.id);
      let user = await db.getUserByEmail(`${userId}@telegram.bot`);
      if (!user) {
        const bcrypt = require('bcryptjs');
        const hash   = await bcrypt.hash(userId, 10);
        user = await db.createUser(`${userId}@telegram.bot`, hash, `TG_${userId}`, 'editor');
      }
      const project = await db.createProject({ client, name, brief: '', user_id: user.id });
      sess.project  = project;
      send(msg.chat.id, `✅ Project set: *${client} / ${name}*\n\nSend /storyboard or /agency to begin.`);
    } catch (e) {
      send(msg.chat.id, `⚠️ Error: ${e.message}`);
    }
  });

  // ── /image ────────────────────────────────────────────────────────────────
  bot.onText(/\/image (.+)/, async (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const sess   = getSession(msg.chat.id);
    const prompt = match[1].trim();
    send(msg.chat.id, '🎨 Generating image…');

    try {
      const limit = await gpt.checkImageLimit();
      let image_url, engine_used;

      if (sess.engine !== 'higgsfield' && limit.remaining > 0) {
        engine_used = 'gpt';
        const r = await gpt.generateImages([prompt], String(msg.chat.id));
        image_url = r.images?.[0]?.url;
        if (!image_url) { engine_used = 'higgsfield'; }
      }
      if (!image_url) {
        engine_used = 'higgsfield';
        const hf = await higgsfield.generateAndWait(prompt, 'image', []);
        image_url = hf.result_url;
      }

      if (image_url) {
        await bot.sendPhoto(msg.chat.id, image_url, { caption: `✅ [${engine_used}] ${prompt.slice(0, 80)}` });
      } else {
        send(msg.chat.id, '⚠️ Generation failed — no image returned.');
      }
    } catch (e) {
      send(msg.chat.id, `⚠️ ${e.message}`);
    }
  });

  // ── /video ────────────────────────────────────────────────────────────────
  bot.onText(/\/video (.+)/, async (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const prompt = match[1].trim();
    send(msg.chat.id, '🎬 Submitting video job to Higgsfield…');
    try {
      const job = await higgsfield.generateVideo(prompt, []);
      send(msg.chat.id, `✅ Job submitted: \`${job.job_id}\`\n\nPolling… this takes ~2-3 min.`);
      const result = await higgsfield.pollJob(job.job_id, 300000);
      if (result.status === 'completed') {
        send(msg.chat.id, `🎬 Video ready: ${result.result_url}`);
      } else {
        send(msg.chat.id, `⚠️ Job ${result.status}: ${result.error || ''}`);
      }
    } catch (e) {
      send(msg.chat.id, `⚠️ ${e.message}`);
    }
  });

  // ── /agency ───────────────────────────────────────────────────────────────
  bot.onText(/\/agency/, (msg) => {
    if (!allowed(msg.chat.id)) return;
    send(msg.chat.id, '🏢 *Campaign Engine*\n\nChoose generation engine:', { reply_markup: engineButtons() });
  });

  // ── /storyboard ───────────────────────────────────────────────────────────
  bot.onText(/\/storyboard(.*)/, async (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const sess = getSession(msg.chat.id);
    if (!sess.project) {
      return send(msg.chat.id, '❌ Set a project first: /project [client] [name]');
    }
    const brief = match[1]?.trim() || sess.project.brief;
    if (!brief) {
      sess.pendingAction = 'storyboard_brief';
      return send(msg.chat.id, '📋 Enter the storyboard brief:');
    }
    await runStoryboard(msg.chat.id, brief, sess, send, bot, genButtons);
  });

  // ── /approve, /retry, /adjust, /allbad ────────────────────────────────────
  bot.onText(/\/approve (\d+)/, async (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const sess  = getSession(msg.chat.id);
    const scene = sess.storyboard[parseInt(match[1]) - 1];
    if (!scene) return send(msg.chat.id, '❌ Scene not found');
    await db.updateScene(scene.id, { status: 'approved', approved_at: new Date().toISOString() });
    send(msg.chat.id, `✅ Scene ${match[1]} approved.`);
  });

  bot.onText(/\/retry (\d+)/, async (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const sess  = getSession(msg.chat.id);
    const scene = sess.storyboard[parseInt(match[1]) - 1];
    if (!scene) return send(msg.chat.id, '❌ Scene not found');
    send(msg.chat.id, `🔄 Retrying scene ${match[1]}…`);
    await regenerateScene(scene, msg.chat.id, sess, bot, send, genButtons);
  });

  bot.onText(/\/adjust (\d+)(.*)/, async (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const sess  = getSession(msg.chat.id);
    const num   = parseInt(match[1]);
    const scene = sess.storyboard[num - 1];
    if (!scene) return send(msg.chat.id, '❌ Scene not found');
    const feedback = match[2]?.trim();
    if (!feedback) {
      sess.pendingAction = { type: 'adjust', scene_id: scene.id, num };
      return send(msg.chat.id, `✏️ Scene ${num} — Send your feedback (and optionally the best image URL):`);
    }
    send(msg.chat.id, `✏️ Adjusting scene ${num}…`);
    const new_prompt = await gpt.adjustPromptFromFeedback(scene.prompt, feedback, [], null);
    await db.updateScene(scene.id, { prompt: new_prompt });
    scene.prompt = new_prompt;
    await regenerateScene(scene, msg.chat.id, sess, bot, send, genButtons);
  });

  bot.onText(/\/allbad (\d+)(.*)/, async (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const sess  = getSession(msg.chat.id);
    const num   = parseInt(match[1]);
    const scene = sess.storyboard[num - 1];
    if (!scene) return send(msg.chat.id, '❌ Scene not found');
    const feedback = match[2]?.trim() || 'All results were bad';
    send(msg.chat.id, `🔧 Diagnosing & fixing scene ${num}…`);
    const new_prompt = await gpt.adjustPromptFromFeedback(scene.prompt, feedback, [], null);
    await db.updateScene(scene.id, { prompt: new_prompt });
    scene.prompt = new_prompt;
    await regenerateScene(scene, msg.chat.id, sess, bot, send, genButtons);
  });

  // ── /compile ──────────────────────────────────────────────────────────────
  bot.onText(/\/compile/, async (msg) => {
    if (!allowed(msg.chat.id)) return;
    const sess = getSession(msg.chat.id);
    if (!sess.project) return send(msg.chat.id, '❌ No project set');
    send(msg.chat.id, '📦 Compiling storyboard…');
    try {
      const scenes  = await db.listScenes(sess.project.id);
      const html    = buildCompileHTML(sess.project, scenes);
      const buf     = Buffer.from(html, 'utf8');
      const filename = `storyboard_${sess.project.id}.html`;
      const url = await db.uploadFile('storyboards', filename, buf, 'text/html');
      send(msg.chat.id, `✅ Storyboard compiled:\n${url}`);
    } catch (e) {
      send(msg.chat.id, `⚠️ ${e.message}`);
    }
  });

  // ── /vo ───────────────────────────────────────────────────────────────────
  bot.onText(/\/vo (.+)/, async (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const parts   = match[1].split('|').map(s => s.trim());
    const text    = parts[0];
    const dialect = parts[1] || 'qatari';
    const gender  = parts[2] || 'male';
    const age     = parts[3] || 'mid';
    const emotion = parts[4] || 'luxury';

    if (!text) return send(msg.chat.id, 'Usage: /vo [text|dialect|gender|age|emotion]');
    send(msg.chat.id, '🎙 Generating VO…');
    try {
      const result = await el.generate(text, dialect, gender, age, emotion);
      send(msg.chat.id, `✅ VO ready:\n${result.url}`);
      await bot.sendAudio(msg.chat.id, result.url, { caption: `${dialect} · ${gender} · ${emotion}` });
    } catch (e) {
      send(msg.chat.id, `⚠️ VO error: ${e.message}`);
    }
  });

  // ── /voscript ─────────────────────────────────────────────────────────────
  bot.onText(/\/voscript (.+)/, async (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const parts   = match[1].split('|').map(s => s.trim());
    const scene   = parts[0];
    const brand   = parts[1] || 'Super Visual';
    const dialect = parts[2] || 'qatari';
    const dur     = parseInt(parts[3]) || 15;
    const tone    = parts[4] || 'luxury';
    send(msg.chat.id, '✍️ Writing VO script…');
    try {
      const result = await el.generateScript(scene, brand, dialect, dur, tone);
      send(msg.chat.id, `📝 *Script:*\n\n${result}`);
    } catch (e) {
      send(msg.chat.id, `⚠️ ${e.message}`);
    }
  });

  // ── /brain ────────────────────────────────────────────────────────────────
  bot.onText(/\/brain/, async (msg) => {
    if (!allowed(msg.chat.id)) return;
    try {
      const summary = await mem.getSummary();
      const lines = Object.entries(summary).map(([k, v]) => `• ${k}: ${v}`).join('\n');
      send(msg.chat.id, `🧠 *Second Brain*\n\n${lines || 'Empty — nothing saved yet.'}`);
    } catch (e) {
      send(msg.chat.id, `⚠️ ${e.message}`);
    }
  });

  // ── /fullboard ────────────────────────────────────────────────────────────
  bot.onText(/\/fullboard(.*)/, (msg, match) => {
    if (!allowed(msg.chat.id)) return;
    const sess = getSession(msg.chat.id);
    sess.pendingAction = { type: 'fullboard_ask_scenes' };
    send(msg.chat.id,
      `🎬 *Full Storyboard*\n\nHow many scenes?\n\n*6* — Short reel\n*9* — Full campaign\n*12* — Extended`
    );
  });

  // ── /go (triggers fullboard generation) ───────────────────────────────────
  bot.onText(/\/go/, async (msg) => {
    if (!allowed(msg.chat.id)) return;
    const sess = getSession(msg.chat.id);
    if (sess.pendingAction?.type !== 'fullboard_collect') return;
    const pa = sess.pendingAction;
    if (!pa.brief) return send(msg.chat.id, '❌ Send your brief first, then /go');
    sess.pendingAction = null;
    await runFullStoryboard(msg.chat.id, pa.brief, pa.refs, pa.numScenes, sess, send, bot);
  });

  // ── Callback query handler (inline buttons) ────────────────────────────────
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    if (!allowed(chatId)) return;
    const sess = getSession(chatId);
    const [action, id] = query.data.split(':');
    await bot.answerCallbackQuery(query.id);

    if (action === 'engine') {
      sess.engine = id;
      bot.editMessageText(`🔀 Engine: *${id}*`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
      if (id !== 'template' && sess.project) {
        send(chatId, '📋 Send the campaign brief to start:');
        sess.pendingAction = { type: 'agency_brief', engine: id };
      }
      return;
    }

    const scene = sess.storyboard.find(s => s.id === id);
    if (!scene) return send(chatId, '❌ Scene not found');

    if (action === 'approve') {
      await db.updateScene(id, { status: 'approved', approved_at: new Date().toISOString() });
      bot.editMessageCaption(`✅ Scene ${scene.num} — APPROVED`, { chat_id: chatId, message_id: query.message.message_id });
    } else if (action === 'retry') {
      send(chatId, `🔄 Retrying scene ${scene.num}…`);
      await regenerateScene(scene, chatId, sess, bot, send, genButtons);
    } else if (action === 'adjust') {
      sess.pendingAction = { type: 'adjust', scene_id: id, num: scene.num };
      send(chatId, `✏️ Scene ${scene.num} — Send your feedback:`);
    } else if (action === 'allbad') {
      sess.pendingAction = { type: 'allbad', scene_id: id, num: scene.num };
      send(chatId, `❌ Scene ${scene.num} — Describe what's wrong (or just send "all bad"):`);
    } else if (action === 'switch') {
      send(chatId, `🔀 Switch engine for scene ${scene.num}:`, { reply_markup: engineButtons() });
      sess.pendingAction = { type: 'switch_scene', scene_id: id };
    }
  });

  // ── General messages → brain ───────────────────────────────────────────────
  bot.on('message', async (msg) => {
    if (!allowed(msg.chat.id)) return;

    const chatId = msg.chat.id;
    const sess   = getSession(chatId);
    const text   = msg.text?.trim() || '';

    // Handle fullboard scene-count reply
    if (sess.pendingAction?.type === 'fullboard_ask_scenes') {
      if (text && !text.startsWith('/')) {
        const num = parseInt(text);
        if (!num || num < 1 || num > 30) {
          send(chatId, '❌ Reply with a number: 6, 9, or 12');
          return;
        }
        sess.pendingAction = { type: 'fullboard_collect', numScenes: num, refs: [], brief: null };
        send(chatId, `✅ *${num} scenes.* Now send your brief + reference images.\nSend /go when ready.`);
        return;
      }
    }

    // Handle fullboard ref image collection
    if (sess.pendingAction?.type === 'fullboard_collect') {
      const pa = sess.pendingAction;
      if (msg.photo) {
        const file = await bot.getFile(msg.photo[msg.photo.length - 1].file_id);
        const url  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        pa.refs.push(url);
        send(chatId, `📎 Ref ${pa.refs.length} added — send more or /go to generate.`);
        return;
      }
      if (text && !text.startsWith('/')) {
        pa.brief = text;
        send(chatId, `✅ Brief saved (${pa.refs.length} refs). Send more images or /go to start.`);
        return;
      }
    }

    if (msg.text?.startsWith('/')) return;

    // Handle pending actions
    if (sess.pendingAction) {
      const pa = sess.pendingAction;
      sess.pendingAction = null;

      if (pa === 'storyboard_brief') {
        return runStoryboard(chatId, text, sess, send, bot, genButtons);
      }
      if (pa.type === 'agency_brief') {
        send(chatId, `🏢 Starting ${pa.engine} campaign…`);
        return runAgency(chatId, text, pa.engine, sess, send, bot, genButtons);
      }
      if (pa.type === 'adjust') {
        send(chatId, `✏️ Adjusting scene ${pa.num}…`);
        const scene      = sess.storyboard.find(s => s.id === pa.scene_id);
        const new_prompt = await gpt.adjustPromptFromFeedback(scene.prompt, text, [], null);
        await db.updateScene(pa.scene_id, { prompt: new_prompt });
        scene.prompt = new_prompt;
        return regenerateScene(scene, chatId, sess, bot, send, genButtons);
      }
      if (pa.type === 'allbad') {
        send(chatId, `🔧 Fixing scene ${pa.num}…`);
        const scene      = sess.storyboard.find(s => s.id === pa.scene_id);
        const new_prompt = await gpt.adjustPromptFromFeedback(scene.prompt, text, [], null);
        await db.updateScene(pa.scene_id, { prompt: new_prompt });
        scene.prompt = new_prompt;
        return regenerateScene(scene, chatId, sess, bot, send, genButtons);
      }
    }

    // Photo/video attachment
    const attachments = [];
    if (msg.photo) {
      const file  = await bot.getFile(msg.photo[msg.photo.length - 1].file_id);
      const url   = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      attachments.push({ type: 'image', url });
    }
    if (msg.video || msg.document?.mime_type?.startsWith('video/')) {
      const fobj = msg.video || msg.document;
      const file = await bot.getFile(fobj.file_id);
      const url  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      attachments.push({ type: 'video', url });
    }

    // Brain chat
    try {
      let contextParts = [];
      for (const att of attachments) {
        const analysis = att.type === 'image'
          ? await gpt.analyzeImage(att.url)
          : await gpt.analyzeVideo(att.url);
        contextParts.push(`[${att.type.toUpperCase()} ANALYSIS]\n${analysis}`);
        send(chatId, `📊 *${att.type === 'image' ? 'Image' : 'Video'} Analysis:*\n\n${analysis}`);
      }

      const fullMsg = [text, ...contextParts].filter(Boolean).join('\n\n');
      if (!fullMsg) return;

      const result = await gpt.chat(String(chatId), fullMsg, 'telegram');
      send(chatId, result.text);

      if (result.action?.action) {
        const act = result.action.action;
        if (act === 'brief' || act === 'brand') {
          send(chatId, '🎯 Choose generation engine:', { reply_markup: engineButtons() });
        }
      }
    } catch (e) {
      send(chatId, `⚠️ Brain error: ${e.message}`);
    }
  });

  console.log('✓ Telegram bot polling started');
  return bot;
}

async function runStoryboard(chatId, brief, sess, send, bot, genButtons) {
  if (!sess.project) return send(chatId, '❌ Set a project first: /project [client] [name]');
  send(chatId, `📋 Building storyboard for: "${brief.slice(0, 60)}"…`);
  try {
    const scenes = sess.engine === 'claude'
      ? await claude.structureStoryboard(brief, 6)
      : await gpt.generateStoryboard(brief, null, 6);

    const userId = String(chatId);
    let user = await db.getUserByEmail(`${userId}@telegram.bot`);
    if (!user) {
      const bcrypt = require('bcryptjs');
      user = await db.createUser(`${userId}@telegram.bot`, await bcrypt.hash(userId, 10), `TG_${userId}`, 'editor');
    }
    if (!sess.project.id) {
      sess.project = await db.createProject({ client: sess.project.client || 'TG', name: sess.project.name || brief.slice(0,40), brief, user_id: user.id });
    }

    sess.storyboard = [];
    for (const s of scenes) {
      const row = await db.createScene({ project_id: sess.project.id, num: s.num || sess.storyboard.length + 1, ...s, status: 'pending' });
      sess.storyboard.push(row);
    }

    const list = sess.storyboard.map(s => `${s.num}. *${s.title || `Scene ${s.num}`}* — ${s.action?.slice(0, 60) || ''}`).join('\n');
    send(chatId, `✅ Storyboard ready (${sess.storyboard.length} scenes):\n\n${list}\n\nUse /storyboard/scene/generate or just say "generate all"`);
  } catch (e) {
    send(chatId, `⚠️ ${e.message}`);
  }
}

async function runAgency(chatId, brief, engine, sess, send, bot, genButtons) {
  try {
    let brand_kit;
    if (engine === 'gpt') {
      brand_kit = await gpt.generateBrandKit(brief, []);
      send(chatId, `🎨 *Brand Kit:*\n\n*${brand_kit.brand_name}*\n_${brand_kit.tagline}_\n\nColors: ${brand_kit.color_palette?.map(c => c.hex).join(', ')}`);
    }
    await runStoryboard(chatId, brief, sess, send, bot, genButtons);
  } catch (e) {
    send(chatId, `⚠️ ${e.message}`);
  }
}

async function regenerateScene(scene, chatId, sess, bot, send, genButtons) {
  const limit = await gpt.checkImageLimit();
  let image_url, engine_used;

  if (sess.engine !== 'higgsfield' && limit.remaining > 0) {
    engine_used = 'gpt';
    const r = await gpt.generateImages([scene.prompt], String(chatId));
    image_url = r.images?.[0]?.url;
  }
  if (!image_url) {
    engine_used = 'higgsfield';
    const hf = await higgsfield.generateAndWait(scene.prompt, 'image', []);
    image_url = hf.result_url;
  }

  if (image_url) {
    await db.updateScene(scene.id, { image_url, status: 'generated' });
    scene.image_url = image_url;
    bot.sendPhoto(chatId, image_url, {
      caption: `Scene ${scene.num} [${engine_used}]: ${scene.title || ''}`,
      reply_markup: genButtons(scene.id),
    });
  } else {
    send(chatId, `⚠️ Scene ${scene.num}: generation failed`);
  }
}

function buildCompileHTML(project, scenes) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${project.name}</title>
<style>body{background:#0a0a0a;color:#e8e8e8;font-family:sans-serif;padding:32px}
h1{color:#F2C94C}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-top:24px}
.card{background:#141414;border:1px solid #2a2a2a;border-radius:8px;overflow:hidden}
.num{background:#F2C94C;color:#000;font-size:10px;font-weight:700;padding:3px 10px}
img{width:100%;aspect-ratio:9/16;object-fit:cover}
.info{padding:10px;font-size:11px;color:#aaa;line-height:1.7}
strong{color:#F2C94C}</style></head><body>
<h1>${project.name}</h1><p style="color:#888">${project.client}</p>
<div class="grid">${scenes.map(s => `<div class="card">
<div class="num">SCENE ${s.num}</div>
${s.image_url ? `<img src="${s.image_url}">` : '<div style="aspect-ratio:9/16;background:#1c1c1c"></div>'}
<div class="info">
<strong>${s.title || ''}</strong><br>
${s.action || ''}</div></div>`).join('')}
</div></body></html>`;
}

async function runFullStoryboard(chatId, brief, refs, numScenes, sess, send, bot) {
  send(chatId, `🚀 Generating full storyboard (${numScenes} scenes + brand kit)…\nThis takes 2–3 minutes.`);
  try {
    const gpt = require('../services/gpt');
    const result = await gpt.generateFullStoryboard(
      brief, refs, [], numScenes,
      sess.project?.client || '',
      sess.project?.name   || ''
    );

    const colors = (result.brand_kit?.colors || []).map(c => c.hex).join(' · ');
    send(chatId,
      `🎨 *Brand Kit*\n\n*${result.brand_kit?.name || ''}*\n_${result.brand_kit?.tagline || ''}_\n\n` +
      `Colors: ${colors}\nStyle: ${result.brand_kit?.visual_style || ''}\nTone: ${result.brand_kit?.tone || ''}`
    );

    for (const scene of result.scenes) {
      if (scene.image_url) {
        await bot.sendPhoto(chatId, scene.image_url, {
          caption: `Scene ${scene.num}: ${scene.title || ''}\n${(scene.action || '').slice(0, 100)}`,
        }).catch(() => {});
      }
    }

    if (result.storyboard_url) {
      send(chatId, `📋 *Storyboard Sheet:*\n${result.storyboard_url}`);
    }
  } catch (e) {
    send(chatId, `⚠️ Full storyboard error: ${e.message}`);
  }
}

module.exports = { startBot };
