'use strict';
const db = require('./supabase');

const CATEGORIES = ['prompts', 'color_grades', 'brand_briefs', 'workflows', 'storyboards', 'voice_clone', 'references', 'notes'];

async function save(category, title, content, tags = [], client = null) {
  if (!CATEGORIES.includes(category)) category = 'notes';
  return db.saveMemory(category, title, content, tags, client);
}

async function search(query, category = null) {
  return db.searchMemories(query, category);
}

async function list(category = null, limit = 50) {
  return db.listMemories(category, limit);
}

async function getByClient(client_name) {
  const { data, error } = await db.supabase
    .from('memories')
    .select('*')
    .eq('client', client_name)
    .order('created_at', { ascending: false });
  if (error) return [];
  return data;
}

async function remove(id) {
  const { error } = await db.supabase.from('memories').delete().eq('id', id);
  if (error) throw error;
  return true;
}

async function getSummary() {
  const { data } = await db.supabase
    .from('memories')
    .select('category')
    .then(r => r);
  if (!data) return {};
  return data.reduce((acc, row) => {
    acc[row.category] = (acc[row.category] || 0) + 1;
    return acc;
  }, {});
}

module.exports = { save, search, list, getByClient, remove, getSummary, CATEGORIES };
