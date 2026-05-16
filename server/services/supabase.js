'use strict';
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ── Project helpers ────────────────────────────────────────────────────────────
async function createProject(data) {
  const { data: row, error } = await supabase
    .from('projects').insert(data).select().single();
  if (error) throw error;
  return row;
}

async function getProject(id) {
  const { data, error } = await supabase
    .from('projects').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function listProjects(user_id) {
  const { data, error } = await supabase
    .from('projects').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function updateProject(id, updates) {
  const { data, error } = await supabase
    .from('projects').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// ── Scene helpers ──────────────────────────────────────────────────────────────
async function createScene(data) {
  const { data: row, error } = await supabase
    .from('scenes').insert(data).select().single();
  if (error) throw error;
  return row;
}

async function getScene(id) {
  const { data, error } = await supabase
    .from('scenes').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function listScenes(project_id) {
  const { data, error } = await supabase
    .from('scenes').select('*').eq('project_id', project_id).order('num');
  if (error) throw error;
  return data;
}

async function updateScene(id, updates) {
  const { data, error } = await supabase
    .from('scenes').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// ── Chat history ───────────────────────────────────────────────────────────────
async function saveMessage(session_id, platform, role, message, user_id = null) {
  const { error } = await supabase.from('chat_history').insert({
    session_id, platform, role, message, user_id
  });
  if (error) console.error('[supabase] saveMessage:', error.message);
}

async function getHistory(session_id, limit = 20) {
  const { data, error } = await supabase
    .from('chat_history')
    .select('role, message')
    .eq('session_id', session_id)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) return [];
  return data.map(r => ({ role: r.role, content: r.message }));
}

// ── GPT image log ──────────────────────────────────────────────────────────────
async function logGptImage(user_id, prompt, result_url) {
  await supabase.from('gpt_image_log').insert({ user_id, prompt, result_url });
}

async function countGptImages(windowHours = 3) {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const { count, error } = await supabase
    .from('gpt_image_log')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', since);
  if (error) return 0;
  return count || 0;
}

// ── Memory ─────────────────────────────────────────────────────────────────────
async function saveMemory(category, title, content, tags = [], client = null) {
  const { data, error } = await supabase
    .from('memories').insert({ category, title, content, tags, client }).select().single();
  if (error) throw error;
  return data;
}

async function searchMemories(query, category = null) {
  let q = supabase.from('memories')
    .select('*')
    .or(`title.ilike.%${query}%,content.ilike.%${query}%`);
  if (category) q = q.eq('category', category);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(20);
  if (error) return [];
  return data;
}

async function listMemories(category = null, limit = 50) {
  let q = supabase.from('memories').select('*');
  if (category) q = q.eq('category', category);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
  if (error) return [];
  return data;
}

// ── VO logs ────────────────────────────────────────────────────────────────────
async function logVO(project_id, text, dialect, emotion, audio_url) {
  await supabase.from('vo_logs').insert({ project_id, text, dialect, emotion, audio_url });
}

// ── Topaz queue ────────────────────────────────────────────────────────────────
async function addTopazJob(video_url, project_id, scene_id, requested_by) {
  const { data, error } = await supabase
    .from('topaz_queue').insert({ video_url, project_id, scene_id, requested_by }).select().single();
  if (error) throw error;
  return data;
}

async function getPendingTopazJobs() {
  const { data, error } = await supabase
    .from('topaz_queue').select('*').eq('status', 'pending').order('requested_at');
  if (error) return [];
  return data;
}

async function completeTopazJob(id, result_url) {
  const { data, error } = await supabase
    .from('topaz_queue')
    .update({ status: 'completed', result_url, completed_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// ── Storage upload ─────────────────────────────────────────────────────────────
async function uploadFile(bucket, filename, buffer, contentType = 'application/octet-stream') {
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(filename, buffer, { contentType, upsert: true });
  if (error) throw error;
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filename);
  return urlData.publicUrl;
}

// ── Conversations ─────────────────────────────────────────────────────────────
async function upsertConversation(user_id, session_id, platform, title, last_message) {
  const now = new Date().toISOString();
  const { error: insErr } = await supabase
    .from('conversations')
    .insert({ user_id, session_id, platform, title, last_message, updated_at: now });
  if (insErr) {
    if (insErr.code === '23505') {
      // Already exists — update last_message + timestamp, preserve title
      const { error: updErr } = await supabase
        .from('conversations')
        .update({ last_message, updated_at: now })
        .eq('session_id', session_id);
      if (updErr) console.error('[conv] update failed:', updErr.message);
    } else {
      console.error('[conv] insert failed:', insErr.code, insErr.message);
    }
  }
}

async function listConversations(user_id, limit = 60) {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, session_id, platform, title, last_message, created_at, updated_at')
    .eq('user_id', user_id)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return data;
}

async function deleteConversation(session_id, user_id) {
  await supabase.from('chat_history').delete().eq('session_id', session_id);
  await supabase.from('conversations').delete().eq('session_id', session_id).eq('user_id', user_id);
}

async function getConversationBySession(session_id) {
  const { data } = await supabase
    .from('conversations')
    .select('id, session_id, title, last_message')
    .eq('session_id', session_id)
    .single();
  return data || null;
}

async function updateConversationTitle(session_id, title) {
  await supabase
    .from('conversations')
    .update({ title })
    .eq('session_id', session_id);
}

// ── User helpers ───────────────────────────────────────────────────────────────
async function getUserByEmail(email) {
  const { data, error } = await supabase
    .from('users').select('*').eq('email', email).single();
  if (error) return null;
  return data;
}

async function createUser(email, password_hash, name, role = 'editor') {
  const { data, error } = await supabase
    .from('users').insert({ email, password_hash, name, role }).select().single();
  if (error) throw error;
  return data;
}

module.exports = {
  supabase,
  createProject, getProject, listProjects, updateProject,
  createScene, getScene, listScenes, updateScene,
  saveMessage, getHistory,
  logGptImage, countGptImages,
  saveMemory, searchMemories, listMemories,
  logVO,
  addTopazJob, getPendingTopazJobs, completeTopazJob,
  uploadFile,
  getUserByEmail, createUser,
  upsertConversation, listConversations, deleteConversation,
  getConversationBySession, updateConversationTitle,
};
