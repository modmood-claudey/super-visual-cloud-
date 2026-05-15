'use strict';
const path = require('path');
const fs   = require('fs');
const gpt  = require('../services/gpt');
const el   = require('../services/elevenlabs');
const db   = require('../services/supabase');
const higgsfield = require('../services/higgsfield');

const AUTH_PATH = path.join(__dirname, '../state/wa_auth');
const WA_ALLOWED = process.env.WA_ALLOWED_NUMBER || '';

async function startBot() {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    isJidUser,
  } = require('@whiskeysockets/baileys');

  const Pino   = require('pino');
  const logger = Pino({ level: 'silent' });

  if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

  const sessions  = new Map(); // jid → { project, engine, pendingAction, storyboard }

  function getSession(jid) {
    if (!sessions.has(jid)) {
      sessions.set(jid, { project: null, engine: 'gpt', pendingAction: null, storyboard: [] });
    }
    return sessions.get(jid);
  }

  function allowed(jid) {
    if (!WA_ALLOWED) return true;
    return jid.startsWith(WA_ALLOWED);
  }

  async function connect() {
    const sock = makeWASocket({ auth: state, logger, printQRInTerminal: true, browser: ['Super Visual', 'Chrome', '1.0'] });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) console.log('\n[WhatsApp] Scan QR code above to connect\n');
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          console.log('[WhatsApp] Reconnecting…');
          setTimeout(connect, 3000);
        } else {
          console.log('[WhatsApp] Logged out. Delete wa_auth folder and restart.');
        }
      }
      if (connection === 'open') console.log('✓ WhatsApp connected');
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!isJidUser(msg.key.remoteJid || '')) continue;

        const jid  = msg.key.remoteJid;
        if (!allowed(jid)) continue;

        const sess = getSession(jid);

        const send = async (text) => {
          await sock.sendMessage(jid, { text }).catch(e => console.error('[WA send]', e.message));
        };

        const textMsg = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || msg.message?.videoMessage?.caption
          || '';

        const bodyText = textMsg.trim();

        // ── Media handling ─────────────────────────────────────────────────────
        const hasImage = !!msg.message?.imageMessage;
        const hasVideo = !!msg.message?.videoMessage;
        const hasAudio = !!msg.message?.audioMessage;

        if (hasImage || hasVideo) {
          await send(hasVideo ? '🎬 Analyzing video reference…' : '🖼️ Analyzing image…');
          try {
            const buf  = await downloadMediaMessage(msg, 'buffer', {});
            const ext  = hasVideo ? '.mp4' : '.jpg';
            const tmp  = `/tmp/wa_${Date.now()}${ext}`;
            fs.writeFileSync(tmp, buf);

            const url = await db.uploadFile(
              'references',
              path.basename(tmp),
              buf,
              hasVideo ? 'video/mp4' : 'image/jpeg'
            );

            const analysis = hasVideo
              ? await gpt.analyzeVideo(url)
              : await gpt.analyzeImage(url);

            await send(`📊 *Analysis:*\n\n${analysis}\n\n💡 Use as reference for which scene?`);
            fs.unlinkSync(tmp);
          } catch (e) {
            await send(`⚠️ Analysis error: ${e.message}`);
          }
          continue;
        }

        if (hasAudio && sess.pendingAction?.type === 'vo_clone') {
          try {
            const buf  = await downloadMediaMessage(msg, 'buffer', {});
            const name = sess.pendingAction.name;
            const result = await el.clone(name, buf);
            await send(`✅ Voice cloned: *${name}*\nID: \`${result.voice_id}\``);
            sess.pendingAction = null;
          } catch (e) {
            await send(`⚠️ Clone error: ${e.message}`);
          }
          continue;
        }

        if (!bodyText) continue;

        // ── Commands ───────────────────────────────────────────────────────────
        if (bodyText.startsWith('/')) {
          const [cmd, ...rest] = bodyText.split(' ');
          const args = rest.join(' ').trim();

          switch (cmd.toLowerCase()) {
            case '/start':
              await send('👋 *Super Visual AI*\n\n/image [prompt]\n/video [prompt]\n/agency\n/storyboard [brief]\n/vo [text|dialect|gender|age|emotion]\n/project [client] [name]\n/status');
              break;

            case '/status': {
              const limit = await gpt.checkImageLimit().catch(() => ({ remaining: '?', limit: '?' }));
              await send(`📊 Engine: ${sess.engine} | GPT: ${limit.remaining}/${limit.limit} | Project: ${sess.project?.name || 'None'}`);
              break;
            }

            case '/project': {
              const parts  = args.split(/\s+/);
              const client = parts[0] || 'Unknown';
              const name   = parts.slice(1).join(' ') || 'Default';
              const user   = await getOrCreateUser(jid, db);
              sess.project = await db.createProject({ client, name, brief: '', user_id: user.id });
              await send(`✅ Project: *${client} / ${name}*`);
              break;
            }

            case '/image': {
              if (!args) { await send('Usage: /image [prompt]'); break; }
              await send('🎨 Generating…');
              const limit = await gpt.checkImageLimit();
              let url;
              if (limit.remaining > 0 && sess.engine !== 'higgsfield') {
                const r = await gpt.generateImages([args], jid);
                url = r.images?.[0]?.url;
              }
              if (!url) {
                const hf = await higgsfield.generateAndWait(args, 'image', []);
                url = hf.result_url;
              }
              if (url) await sock.sendMessage(jid, { image: { url }, caption: args.slice(0, 80) });
              else await send('⚠️ Generation failed');
              break;
            }

            case '/video': {
              if (!args) { await send('Usage: /video [prompt]'); break; }
              await send('🎬 Submitting video job…');
              const job = await higgsfield.generateVideo(args, []);
              await send(`✅ Job: \`${job.job_id}\` — polling…`);
              const result = await higgsfield.pollJob(job.job_id, 300000);
              await send(result.status === 'completed' ? `🎬 Ready: ${result.result_url}` : `⚠️ ${result.error}`);
              break;
            }

            case '/vo': {
              const parts   = args.split('|').map(s => s.trim());
              const text    = parts[0];
              const dialect = parts[1] || 'qatari';
              const gender  = parts[2] || 'male';
              const age     = parts[3] || 'mid';
              const emotion = parts[4] || 'luxury';
              if (!text) { await send('Usage: /vo [text|dialect|gender|age|emotion]'); break; }
              await send('🎙 Generating VO…');
              const r = await el.generate(text, dialect, gender, age, emotion);
              await sock.sendMessage(jid, { audio: { url: r.url }, mimetype: 'audio/mpeg', ptt: false });
              await send(`✅ ${dialect} · ${gender} · ${emotion}`);
              break;
            }

            case '/voclone': {
              if (!args) { await send('Usage: /voclone [name] — then send audio file'); break; }
              sess.pendingAction = { type: 'vo_clone', name: args };
              await send(`🎤 Send the audio sample for voice clone: *${args}*`);
              break;
            }

            case '/agency':
              await send('🏢 *Choose engine:*\n1 — GPT native\n2 — Claude + Waviboy\n3 — Template\n\nReply with number:');
              sess.pendingAction = { type: 'agency_engine' };
              break;

            case '/storyboard': {
              if (!sess.project) { await send('Set project first: /project [client] [name]'); break; }
              if (!args) {
                sess.pendingAction = 'storyboard_brief';
                await send('📋 Enter brief:');
              } else {
                await runStoryboard(jid, args, sess, send, sock, db, gpt, higgsfield);
              }
              break;
            }

            case '/switch':
              if (['gpt','claude','higgsfield','template'].includes(args)) {
                sess.engine = args;
                await send(`🔀 Engine: *${args}*`);
              } else {
                await send('Usage: /switch gpt|claude|higgsfield|template');
              }
              break;

            case '/brain': {
              const mem = require('../services/memory');
              const summary = await mem.getSummary();
              const lines = Object.entries(summary).map(([k, v]) => `• ${k}: ${v}`).join('\n');
              await send(`🧠 *Second Brain*\n\n${lines || 'Empty'}`);
              break;
            }

            default:
              await send(`Unknown command. Type /start for menu.`);
          }
          continue;
        }

        // ── Pending action ─────────────────────────────────────────────────────
        if (sess.pendingAction) {
          const pa = sess.pendingAction;
          sess.pendingAction = null;

          if (pa === 'storyboard_brief') {
            await runStoryboard(jid, bodyText, sess, send, sock, db, gpt, higgsfield);
            continue;
          }
          if (pa.type === 'agency_engine') {
            const eng = bodyText === '1' ? 'gpt' : bodyText === '2' ? 'claude' : 'template';
            sess.engine = eng;
            await send(`Engine: *${eng}*\n\nEnter campaign brief:`);
            sess.pendingAction = { type: 'agency_brief', engine: eng };
            continue;
          }
          if (pa.type === 'agency_brief') {
            await send(`🏢 Running ${pa.engine} campaign…`);
            await runStoryboard(jid, bodyText, sess, send, sock, db, gpt, higgsfield);
            continue;
          }
        }

        // ── Brain chat ─────────────────────────────────────────────────────────
        const result = await gpt.chat(jid, bodyText, 'whatsapp');
        await send(result.text);
      }
    });

    return sock;
  }

  return connect();
}

async function runStoryboard(jid, brief, sess, send, sock, db, gpt, higgsfield) {
  await send(`📋 Building storyboard…`);
  try {
    const claude = require('../services/claude');
    const scenes = sess.engine === 'claude'
      ? await claude.structureStoryboard(brief, 6)
      : await gpt.generateStoryboard(brief, null, 6);

    const user = await getOrCreateUser(jid, db);
    if (!sess.project) {
      sess.project = await db.createProject({ client: 'WA', name: brief.slice(0, 40), brief, user_id: user.id });
    }

    sess.storyboard = [];
    for (let i = 0; i < scenes.length; i++) {
      const row = await db.createScene({ project_id: sess.project.id, ...scenes[i], num: i + 1, status: 'pending' });
      sess.storyboard.push(row);
    }

    const list = sess.storyboard.map(s => `${s.num}. ${s.title || `Scene ${s.num}`}`).join('\n');
    await send(`✅ ${sess.storyboard.length} scenes ready:\n\n${list}`);
  } catch (e) {
    await send(`⚠️ ${e.message}`);
  }
}

async function getOrCreateUser(jid, db) {
  const email = `${jid.replace('@s.whatsapp.net', '')}@wa.bot`;
  let user = await db.getUserByEmail(email);
  if (!user) {
    const bcrypt = require('bcryptjs');
    user = await db.createUser(email, await bcrypt.hash(jid, 10), `WA_${jid.split('@')[0]}`, 'editor');
  }
  return user;
}

module.exports = { startBot };
