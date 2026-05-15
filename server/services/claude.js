'use strict';
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const WAVIBOY_RULES = `WAVIBOY PROMPT RULES (mandatory):
- Specific camera body + lens (e.g. Hasselblad X2D, 80mm f/2.8)
- Lighting setup with ratio + Kelvin temperature (e.g. Rembrandt 4:1, 5600K key, 3200K fill)
- Film/sensor rendering reference (e.g. Kodak Portra 400, ARRI ALEXA)
- Micro-texture (pores, subsurface scattering, atmospheric haze, grain structure)
- Composition (geometric framing, negative space, camera height, rule of thirds vs. centered)
- Color grade (lifted blacks, highlight rolloff, dominant hues, cross-process details)
- NEVER use: cinematic, moody, vibrant, stunning, ethereal, dynamic, dreamy
- Append "no 3D, no cartoon, no VFX" for live-action/realistic clients`;

const SEEDANCE_RULES = `SEEDANCE 2.0 VIDEO RULES:
- Output bilingual EN+ZH JSON: [{"lang":"en","prompt":"..."},{"lang":"zh","prompt":"..."}]
- Double contrast on every cut (change both shot size AND camera type simultaneously)
- Maximum 3 characters tracked across cuts
- No reflection shots (mirrors, puddles, blades, glass surfaces)
- Physics not emotions: "jaw clenches" not "looks angry", "fingers whiten on grip" not "nervous"
- No age markers ever (no "young", "old", "elderly", "teen")
- Scene types: Action(Pursuit/Duel/Impact), General(Journey/Atmosphere/Reveal), Dialogue(Confrontation/Interrogation/Negotiation)
- Every shot needs: subject action + camera angle + camera movement + lighting condition`;

async function formatWaviboy(scene_description, brand_kit = null) {
  const brandCtx = brand_kit
    ? `Brand context: ${brand_kit.brand_name}. Visual style: ${brand_kit.visual_style}. Color palette: ${brand_kit.color_palette?.map(c => c.hex).join(', ')}.`
    : '';

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: `You are a precision prompt engineer. Write Waviboy-style image prompts for AI generation.\n\n${WAVIBOY_RULES}`,
    messages: [{
      role: 'user',
      content: `Write a Waviboy prompt for this scene:\n${scene_description}\n\n${brandCtx}\n\nOutput only the prompt text, nothing else.`,
    }],
  });
  return response.content[0].text.trim();
}

async function generateSeedanceJSON(scene_description, scene_type = 'general') {
  const typeGuide = {
    action: 'Pursuit, Duel, or Impact — fast cuts, extreme contrast between shots',
    general: 'Journey, Atmosphere, or Reveal — smooth transitions, atmospheric',
    dialogue: 'Confrontation, Interrogation, or Negotiation — tight coverage, tension',
  };

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    system: `You generate Seedance 2.0 bilingual video prompts.\n\n${SEEDANCE_RULES}`,
    messages: [{
      role: 'user',
      content: `Generate a Seedance 2.0 bilingual JSON for this scene:
Scene: ${scene_description}
Type: ${scene_type} (${typeGuide[scene_type] || typeGuide.general})

Return ONLY a valid JSON array:
[{"lang":"en","prompt":"..."},{"lang":"zh","prompt":"..."}]`,
    }],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return [{ lang: 'en', prompt: text }, { lang: 'zh', prompt: '' }];
}

async function structureStoryboard(brief, num_scenes = 6) {
  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    system: `You are a storyboard structure expert for premium visual media production.`,
    messages: [{
      role: 'user',
      content: `Create a ${num_scenes}-scene storyboard structure for:
${brief}

Return ONLY valid JSON array. Each scene must have:
- num (int)
- title (string)
- duration ("Xs" format)
- action (physical description — what literally happens)
- camera (camera body + lens + angle + movement — no abstract terms)
- lighting (setup with Kelvin + ratios)
- mood (atmosphere without slop words)

[{"num":1,"title":"...","duration":"5s","action":"...","camera":"...","lighting":"...","mood":"..."}]`,
    }],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return [];
}

async function brandStrategy(brief) {
  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1200,
    system: `You are a brand strategy director for premium Gulf market brands.`,
    messages: [{
      role: 'user',
      content: `Write a strategic brand framework for: ${brief}

Return JSON:
{
  "positioning": "...",
  "differentiators": ["..."],
  "audience_segments": [{"segment":"...","insight":"..."}],
  "messaging_pillars": ["..."],
  "tone_guide": "...",
  "visual_direction": "...",
  "campaign_territories": ["..."]
}`,
    }],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return { raw: text };
}

module.exports = { formatWaviboy, generateSeedanceJSON, structureStoryboard, brandStrategy };
