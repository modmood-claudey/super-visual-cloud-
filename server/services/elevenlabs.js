'use strict';
const axios  = require('axios');
const { uploadFile, logVO, supabase } = require('./supabase');

const API_BASE = 'https://api.elevenlabs.io/v1';
const MODEL_ID = 'eleven_multilingual_v2';

// ── Voice catalogue (configure in ElevenLabs dashboard, paste IDs here) ────────
// These are example IDs — replace with your actual cloned/selected voices
const VOICE_CATALOG = {
  male: {
    young:  { neutral: 'pNInz6obpgDQGcFmaJgB', luxury: 'TxGEqnHWrfWFTfGW9XjX', warm: 'yoZ06aMxZJJ28mfd3POQ' },
    mid:    { neutral: 'VR6AewLTigWG4xSOukaG', formal: 'g5CIjZEefAph4nQFvHAz' },
    senior: { neutral: 'onwK4e9ZLuTAKqWW03F9' },
  },
  female: {
    young:  { neutral: 'EXAVITQu4vr4xnSDxMaL', luxury: 'MF3mGyEYCl7XYWbV9V6O', warm: 'jsCqWAovK2LkecY7zXl4' },
    mid:    { neutral: 'ThT5KcBeYPX3keUQqHPh', formal: 'AZnzlk1XvdvUeBnXmlld' },
    senior: { neutral: 'XB0fDUnXU5powFXDhCwa' },
  },
};

// Emotion → voice settings
const EMOTION_SETTINGS = {
  neutral:  { stability: 0.5,  similarity_boost: 0.75, style: 0.0,  use_speaker_boost: true  },
  warm:     { stability: 0.6,  similarity_boost: 0.80, style: 0.15, use_speaker_boost: true  },
  formal:   { stability: 0.8,  similarity_boost: 0.70, style: 0.0,  use_speaker_boost: false },
  excited:  { stability: 0.3,  similarity_boost: 0.75, style: 0.6,  use_speaker_boost: true  },
  dramatic: { stability: 0.25, similarity_boost: 0.70, style: 0.8,  use_speaker_boost: true  },
  luxury:   { stability: 0.75, similarity_boost: 0.85, style: 0.25, use_speaker_boost: true  },
  whisper:  { stability: 0.9,  similarity_boost: 0.60, style: 0.1,  use_speaker_boost: false },
};

// Dialect → language code hint for multilingual model
const DIALECT_HINTS = {
  qatari:      'اللهجة القطرية',
  gulf:        'اللهجة الخليجية',
  saudi:       'اللهجة السعودية',
  emirati:     'اللهجة الإماراتية',
  palestinian: 'اللهجة الفلسطينية',
  jordanian:   'اللهجة الأردنية',
  msa:         'الفصحى',
};

function resolveVoiceId(gender = 'male', age = 'mid', emotion = 'neutral') {
  const g = VOICE_CATALOG[gender] || VOICE_CATALOG.male;
  const a = g[age] || g.mid || g.young;
  return a[emotion] || a.neutral || Object.values(a)[0];
}

async function generate(text, dialect = 'qatari', gender = 'male', age = 'mid', emotion = 'neutral', project_id = null) {
  const voice_id  = resolveVoiceId(gender, age, emotion);
  const settings  = EMOTION_SETTINGS[emotion] || EMOTION_SETTINGS.neutral;
  const dialectHint = DIALECT_HINTS[dialect] || '';

  // Prepend dialect context if not MSA
  const fullText = dialectHint && dialect !== 'msa'
    ? `[${dialectHint}]\n${text}`
    : text;

  const res = await axios.post(
    `${API_BASE}/text-to-speech/${voice_id}`,
    {
      text: fullText,
      model_id: MODEL_ID,
      voice_settings: settings,
    },
    {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      responseType: 'arraybuffer',
    }
  );

  const buffer   = Buffer.from(res.data);
  const filename = `vo_${Date.now()}_${dialect}_${gender}.mp3`;
  const url      = await uploadFile('vo-files', filename, buffer, 'audio/mpeg');

  await logVO(project_id, text, dialect, emotion, url);

  return { url, filename, dialect, gender, age, emotion, voice_id };
}

async function clone(name, audio_buffer) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('name', name);
  form.append('files', audio_buffer, { filename: 'sample.mp3', contentType: 'audio/mpeg' });
  form.append('description', `Super Visual voice clone: ${name}`);

  const res = await axios.post(`${API_BASE}/voices/add`, form, {
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      ...form.getHeaders(),
    },
  });

  const voice_id = res.data.voice_id;

  // Save to Supabase memories
  await supabase.from('memories').insert({
    category: 'voice_clone',
    title: name,
    content: JSON.stringify({ voice_id, name, created_at: new Date().toISOString() }),
    tags: ['voice', 'elevenlabs'],
  });

  return { voice_id, name };
}

async function listVoices() {
  const res = await axios.get(`${API_BASE}/voices`, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
  });
  return res.data.voices || [];
}

async function getQuota() {
  const res = await axios.get(`${API_BASE}/user/subscription`, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
  });
  const sub = res.data;
  const used = sub.character_count || 0;
  const limit = sub.character_limit || 10000;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percent_used: Math.round((used / limit) * 100),
    tier: sub.tier || 'free',
  };
}

// Generate VO script via GPT then synthesize
async function generateScript(scene_description, brand_name, dialect = 'qatari', duration = 15, tone = 'luxury') {
  const { chat } = require('./gpt');
  const sid = `vo_script_${Date.now()}`;
  const prompt = `Write a ${duration}-second Arabic VO script for:
Scene: ${scene_description}
Brand: ${brand_name}
Dialect: ${dialect}
Tone: ${tone}
Duration: ${duration} seconds (approx ${Math.round(duration * 2.5)} Arabic words)

Write ONLY the Arabic script text. No translation. No notes.`;

  const result = await chat(sid, prompt, 'system');
  return result.text.trim();
}

module.exports = { generate, clone, listVoices, getQuota, generateScript, resolveVoiceId };
