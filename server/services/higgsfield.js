'use strict';
const axios = require('axios');

const API_BASE      = 'https://api.higgsfield.ai';
const WORKSPACE_ID  = process.env.HIGGSFIELD_WORKSPACE_ID || '154e2f0c-d69e-46b5-be29-0d4bf53f5927';
const POLL_INTERVAL = 5000;

function headers() {
  return {
    Authorization: `Bearer ${process.env.HIGGSFIELD_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Workspace-Id': WORKSPACE_ID,
  };
}

// Model name map to API identifiers
const MODEL_MAP = {
  nano_banana_pro: 'nano-banana-pro',
  seedance_2_0:    'seedance-2.0',
  seedance:        'seedance-2.0',
};

const RATIO_MAP = {
  '9:16': '9_16',
  '16:9': '16_9',
  '1:1':  '1_1',
  '4:3':  '4_3',
};

async function generateImage(prompt, refs = [], model = 'nano_banana_pro', ratio = '9:16') {
  const body = {
    prompt,
    model: MODEL_MAP[model] || model,
    aspect_ratio: RATIO_MAP[ratio] || ratio,
    workspace_id: WORKSPACE_ID,
  };

  if (refs.length > 0) {
    body.reference_images = refs.slice(0, 14).map(url => ({ url }));
  }

  const res = await axios.post(`${API_BASE}/v1/images/generate`, body, { headers: headers() });
  return { job_id: res.data.job_id || res.data.id, status: 'pending', data: res.data };
}

async function generateVideo(prompt, refs = [], model = 'seedance_2_0', ratio = '9:16') {
  const body = {
    prompt,
    model: MODEL_MAP[model] || model,
    aspect_ratio: RATIO_MAP[ratio] || ratio,
    workspace_id: WORKSPACE_ID,
    duration: 5,
    resolution: '720p',
  };

  if (refs.length > 0) {
    body.reference_images = refs.slice(0, 9).map(url => ({ url }));
  }

  const res = await axios.post(`${API_BASE}/v1/videos/generate`, body, { headers: headers() });
  return { job_id: res.data.job_id || res.data.id, status: 'pending', data: res.data };
}

async function getJobStatus(job_id) {
  const res = await axios.get(`${API_BASE}/v1/jobs/${job_id}`, { headers: headers() });
  return res.data;
}

async function pollJob(job_id, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const job = await getJobStatus(job_id);
    const status = (job.status || '').toLowerCase();

    if (status === 'completed' || status === 'succeeded' || status === 'done') {
      return {
        status:     'completed',
        result_url: job.result_url || job.output_url || job.image_url || job.video_url || job.url,
        data:       job,
      };
    }
    if (status === 'failed' || status === 'error') {
      return { status: 'failed', error: job.error || 'Generation failed', data: job };
    }
  }

  return { status: 'timeout', error: `Job ${job_id} timed out after ${timeoutMs / 1000}s` };
}

async function generateAndWait(prompt, type = 'image', refs = [], model = null, ratio = '9:16') {
  const defaultModel = type === 'video' ? 'seedance_2_0' : 'nano_banana_pro';
  const { job_id } = type === 'video'
    ? await generateVideo(prompt, refs, model || defaultModel, ratio)
    : await generateImage(prompt, refs, model || defaultModel, ratio);

  return pollJob(job_id);
}

async function listModels() {
  try {
    const res = await axios.get(`${API_BASE}/v1/models`, { headers: headers() });
    return res.data;
  } catch {
    return {
      image: ['nano-banana-pro'],
      video: ['seedance-2.0'],
    };
  }
}

module.exports = { generateImage, generateVideo, getJobStatus, pollJob, generateAndWait, listModels };
