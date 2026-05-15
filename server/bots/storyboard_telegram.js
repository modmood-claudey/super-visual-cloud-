'use strict';
const pipeline = require('../services/storyboard_pipeline');

function attach(bot, allowedFn) {
  const isAllowed = allowedFn || (() => true);

  const send = (chatId, text, opts = {}) =>
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts }).catch(e => {
      if (!e.message?.includes('message is not modified')) console.error('[TG storyboard]', e.message);
    });

  // /fullboard
  bot.onText(/\/fullboard(.*)/, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    const result = pipeline.startStoryboard(String(msg.chat.id));
    send(msg.chat.id, result.message);
  });

  // /go — shortcut for sending DONE while in collecting_refs
  bot.onText(/\/go/, async (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    const sess = pipeline.getSession(String(msg.chat.id));
    if (!['collecting_refs', 'collecting_brand_assets'].includes(sess.step)) {
      return send(msg.chat.id, '❌ Nothing to submit. Use /fullboard to start.');
    }
    const result = await pipeline.handleMessage(String(msg.chat.id), 'DONE', []);
    await send(msg.chat.id, result.message);
    if (result.action === 'extract_brand') await _doExtract(String(msg.chat.id), bot, send);
    if (result.action === 'generate')      await _doGenerate(String(msg.chat.id), bot, send);
  });

  // General message handler — intercepts when a storyboard session is active
  bot.on('message', async (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    const sess = pipeline.getSession(String(msg.chat.id));
    if (sess.step === 'idle') return;          // not active — let other handlers take it
    if (msg.text?.startsWith('/')) return;     // commands handled above

    const chatId      = String(msg.chat.id);
    const text        = msg.text?.trim() || '';
    const attachments = [];

    if (msg.photo) {
      const file = await bot.getFile(msg.photo[msg.photo.length - 1].file_id);
      attachments.push({ type: 'image', url: `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}` });
    }
    if (msg.video || msg.document?.mime_type?.startsWith('video/')) {
      const fobj = msg.video || msg.document;
      const file = await bot.getFile(fobj.file_id);
      attachments.push({ type: 'video', url: `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}` });
    }

    if (!text && !attachments.length) return;

    try {
      const result = await pipeline.handleMessage(chatId, text, attachments);
      await send(msg.chat.id, result.message);
      if (result.action === 'extract_brand') await _doExtract(chatId, bot, send);
      if (result.action === 'generate')      await _doGenerate(chatId, bot, send);
    } catch (e) {
      send(msg.chat.id, `⚠️ Error: ${e.message}`);
    }
  });
}

async function _doExtract(chatId, bot, send) {
  try {
    const r = await pipeline.extractBrandKit(chatId);
    await send(chatId, r.message);
  } catch (e) {
    send(chatId, `⚠️ Brand extraction failed: ${e.message}`);
  }
}

async function _doGenerate(chatId, bot, send) {
  try {
    const result = await pipeline.runGeneration(chatId);

    if (result.brand_kit) {
      const colors = (result.brand_kit.colors || []).map(c => c.hex).join(' · ');
      await send(chatId,
        `🎨 *Brand Kit*\n\n*${result.brand_kit.name || ''}*\n_${result.brand_kit.tagline || ''}_\n\nColors: ${colors}\nStyle: ${result.brand_kit.visual_style || ''}`
      );
    }

    for (const scene of result.scenes) {
      if (scene.image_url) {
        await bot.sendPhoto(Number(chatId), scene.image_url, {
          caption: `Scene ${scene.num}: ${scene.title || ''}\n${(scene.action || '').slice(0, 100)}`,
        }).catch(() => {});
      }
    }

    if (result.storyboard_url) {
      await send(chatId, `📋 *Storyboard Sheet:*\n${result.storyboard_url}`);
    } else {
      await send(chatId, `✅ Done — ${result.scenes.length} scenes generated.`);
    }
  } catch (e) {
    send(chatId, `⚠️ Generation failed: ${e.message}`);
  }
}

module.exports = { attach };
