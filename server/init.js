'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const bcrypt  = require('bcryptjs');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { signToken } = require('./middleware/auth');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SQL_TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text DEFAULT 'editor',
  name text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client text NOT NULL,
  name text NOT NULL,
  brief text,
  brand_kit jsonb,
  status text DEFAULT 'active',
  user_id uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  num integer,
  title text,
  action text,
  camera text,
  lighting text,
  mood text,
  prompt text,
  image_url text,
  video_url text,
  seedance_prompt jsonb,
  status text DEFAULT 'pending',
  approved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memories (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  category text,
  title text,
  content text,
  tags text[],
  client text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id text,
  platform text,
  role text,
  message text,
  user_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gpt_image_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text,
  prompt text,
  result_url text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vo_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid,
  text text,
  dialect text,
  emotion text,
  audio_url text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topaz_queue (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  video_url text,
  project_id uuid,
  scene_id uuid,
  status text DEFAULT 'pending',
  result_url text,
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  completed_at timestamptz
);
`;

const STORAGE_BUCKETS = ['generated-images', 'storyboards', 'vo-files', 'references'];

async function createTables() {
  console.log('\n1. Creating database tables…');
  const pg = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  await pg.query(SQL_TABLES);
  await pg.end();
  console.log('   ✓ All tables created');
}

async function createBuckets() {
  console.log('\n2. Creating storage buckets…');
  for (const bucket of STORAGE_BUCKETS) {
    const { error } = await supabase.storage.createBucket(bucket, { public: true });
    if (error && !error.message.includes('already exists')) {
      console.log(`   ✗ ${bucket}: ${error.message}`);
    } else {
      console.log(`   ✓ ${bucket}`);
    }
  }
}

async function seedAdmin() {
  console.log('\n3. Seeding admin user…');
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) { console.log('   ⚠ ADMIN_EMAIL / ADMIN_PASSWORD not set in .env'); return; }

  const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
  if (existing) { console.log(`   ✓ Admin already exists: ${email}`); return; }

  const hash = await bcrypt.hash(password, 12);
  const { error } = await supabase.from('users').insert({
    email, password_hash: hash, role: 'admin', name: 'Mohammad'
  });
  if (error) console.log(`   ✗ ${error.message}`);
  else console.log(`   ✓ Admin created: ${email}`);
}

async function generateServiceToken() {
  console.log('\n4. Service JWT token (for bots):');
  const token = signToken({ id: 'service', role: 'service', platform: 'bot' }, '365d');
  console.log(`   ${token}`);
  console.log('   Add to .env as: SERVICE_JWT=...');
  return token;
}

async function testConnections() {
  console.log('\n5. Testing API connections…');

  // Supabase
  try {
    await supabase.from('users').select('id').limit(1);
    console.log('   ✓ Supabase');
  } catch (e) { console.log(`   ✗ Supabase: ${e.message}`); }

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      await client.models.list();
      console.log('   ✓ OpenAI');
    } catch (e) { console.log(`   ✗ OpenAI: ${e.message}`); }
  } else { console.log('   ⚠ OpenAI: key not set'); }

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      console.log('   ✓ Anthropic (Claude)');
    } catch (e) { console.log(`   ✗ Anthropic: ${e.message}`); }
  } else { console.log('   ⚠ Anthropic: key not set'); }

  // ElevenLabs
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const axios = require('axios');
      await axios.get('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
      });
      console.log('   ✓ ElevenLabs');
    } catch (e) { console.log(`   ✗ ElevenLabs: ${e.message}`); }
  } else { console.log('   ⚠ ElevenLabs: key not set'); }

  // Higgsfield
  if (process.env.HIGGSFIELD_API_KEY) {
    try {
      const axios = require('axios');
      await axios.get('https://api.higgsfield.ai/v1/models', {
        headers: { Authorization: `Bearer ${process.env.HIGGSFIELD_API_KEY}` }
      });
      console.log('   ✓ Higgsfield');
    } catch (e) { console.log(`   ✗ Higgsfield: ${e.message} (API endpoint may differ — check higgsfield.ai/docs)`); }
  } else { console.log('   ⚠ Higgsfield: key not set'); }
}

async function printNextSteps() {
  console.log('\n═══════════════════════════════════════');
  console.log('NEXT STEPS:');
  console.log('═══════════════════════════════════════');
  console.log('1. Fill in your .env file (copy .env.example)');
  console.log('2. Run: npm run init  (this script)');
  console.log('3. Deploy to Railway: railway up');
  console.log('4. Set env vars in Railway dashboard');
  console.log('5. Open your Railway URL + /login');
  console.log('');
  console.log('RAILWAY DEPLOY:');
  console.log('  npm install -g @railway/cli');
  console.log('  railway login');
  console.log('  railway init');
  console.log('  railway up');
  console.log('═══════════════════════════════════════\n');
}

(async () => {
  console.log('═══════════════════════════════════════');
  console.log('Super Visual Cloud — Init');
  console.log('═══════════════════════════════════════');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\n✗ SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env\n');
    process.exit(1);
  }

  await createTables().catch(e => console.log(`   ✗ Tables: ${e.message}`));
  await createBuckets();
  await seedAdmin();
  await generateServiceToken();
  await testConnections();
  await printNextSteps();
})();
