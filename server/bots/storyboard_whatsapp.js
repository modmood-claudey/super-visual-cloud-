'use strict';
const pipeline = require('../services/storyboard_pipeline');

// Returns true if the command was handled (prevents fallthrough to brain chat)
async function handleCommand(cmd, jid, send, sock) {
  if (cmd === '/fullboard') {
    const result = pipeline.startStoryboard(jid);
    await send(result.message);
    return true;
  }
  if (cmd === '/go') {
    const sess = pipeline.getSession(jid);
    if (!['collecting_refs', 'collecting_brand_assets'].includes(sess.step)) {
      await send('❌ Nothing to submit. Use /fullboard to start.');
      return true;
    }
    const result = await pipeline.handleMessage(jid, 'DONE', []);
    await send(result.message);
    if (result.action === 'extract_brand') await _doExtract(jid, send, sock);
    if (result.action === 'generate')      await _doGenerate(jid, send, sock);
    return true;
  }
  return false;
}

// Returns true if message was consumed by the storyboard pipeline
async function handleMessage(bodyText, jid, send, sock, imageUrl, videoUrl) {
  const sess = pipeline.getSession(jid);
  if (sess.step === 'idle') return false;

  const attachments = [];
  if (imageUrl) attachments.push({ type: 'image', url: imageUrl });
  if (videoUrl) attachments.push({ type: 'video', url: videoUrl });

  if (!bodyText && !attachments.length) return false;

  try {
    const result = await pipeline.handleMessage(jid, bodyText, attachments);
    await send(result.message);
    if (result.action === 'extract_brand') await _doExtract(jid, send, sock);
    if (result.action === 'generate')      await _doGenerate(jid, send, sock);
    return true;
  } catch (e) {
    await send(`⚠️ Error: ${e.message}`);
    return true;
  }
}

async function _doExtract(jid, send, sock) {
  try {
    const r = await pipeline.extractBrandKit(jid);
    await send(r.message);
  } catch (e) {
    await send(`⚠️ Brand extraction failed: ${e.message}`);
  }
}

async function _doGenerate(jid, send, sock) {
  try {
    const result = await pipeline.runGeneration(jid);

    if (result.brand_kit) {
      const colors = (result.brand_kit.colors || []).map(c => c.hex).join(' · ');
      await send(`🎨 *Brand Kit*\n\n*${result.brand_kit.name || ''}*\n_${result.brand_kit.tagline || ''}_\n\nColors: ${colors}`);
    }

    for (const scene of result.scenes) {
      if (scene.image_url) {
        await sock.sendMessage(jid, {
          image: { url: scene.image_url },
          caption: `Scene ${scene.num}: ${scene.title || ''}\n${(scene.action || '').slice(0, 100)}`,
        }).catch(() => {});
      }
    }

    if (result.storyboard_url) {
      await send(`📋 Storyboard:\n${result.storyboard_url}`);
    } else {
      await send(`✅ Done — ${result.scenes.length} scenes generated.`);
    }
  } catch (e) {
    await send(`⚠️ Generation failed: ${e.message}`);
  }
}

module.exports = { handleCommand, handleMessage };
