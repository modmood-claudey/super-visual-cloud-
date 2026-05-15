# Super Visual Cloud

AI production pipeline — fully cloud-hosted. Deploy to Railway, no Mac required (except optional Topaz upscaling).

## Architecture

```
Railway (Node.js)
  ├── Express server
  ├── Telegram bot (always on)
  ├── WhatsApp bot (optional, needs QR scan)
  └── REST API + SPA dashboard

Supabase
  ├── PostgreSQL (projects, scenes, users, memories)
  └── Storage (images, videos, audio, references)

AI Services
  ├── OpenAI GPT-4o — all creative tasks
  ├── Claude Sonnet — strategy, Waviboy, Seedance JSON
  ├── Higgsfield — image + video generation
  └── ElevenLabs — Arabic VO

Mac Agent (optional)
  └── Topaz Video AI — 4× upscaling on demand
```

## Setup

### 1. Supabase

1. Create project at [supabase.com](https://supabase.com)
2. Copy Project URL and service_role key
3. Run `npm run init` (step 4) — creates all tables + buckets automatically

### 2. Environment

```bash
cd server
cp .env.example .env
# Fill in all values (see .env.example for guide)
```

### 3. Initialize database

```bash
cd server
npm install
npm run init
```

Copy the **Service JWT** printed at the end — needed for Mac agent.

### 4. Deploy to Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Then in Railway dashboard → Variables, add all env vars from `.env`.

### 5. Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy token → `TELEGRAM_BOT_TOKEN`
3. Get your chat ID: message [@userinfobot](https://t.me/userinfobot) → `TELEGRAM_ALLOWED_CHAT_ID`

### 6. WhatsApp bot (optional)

Set `START_WHATSAPP=true` in env vars.  
On first deploy, check Railway logs for QR code and scan with WhatsApp.

### 7. Mac agent for Topaz (optional)

```bash
cd mac_agent
cp .env.example .env
# Fill: SERVER_URL, SERVICE_JWT, SUPABASE_URL, SUPABASE_SERVICE_KEY
chmod +x start.sh
./start.sh
```

## Environment Variables

| Variable | Where to get |
|----------|-------------|
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `HIGGSFIELD_API_KEY` | [higgsfield.ai](https://higgsfield.ai) → API settings |
| `HIGGSFIELD_WORKSPACE_ID` | Higgsfield dashboard → workspace |
| `ELEVENLABS_API_KEY` | [elevenlabs.io](https://elevenlabs.io) → Profile → API key |
| `SUPABASE_URL` | Supabase → Project Settings → API → URL |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon/public |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → service_role |
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string (URI) |
| `JWT_SECRET` | Generate: `openssl rand -base64 32` |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → /newbot |
| `TELEGRAM_ALLOWED_CHAT_ID` | [@userinfobot](https://t.me/userinfobot) |
| `ADMIN_EMAIL` | Your choice |
| `ADMIN_PASSWORD` | Your choice (min 8 chars) |

## Bot Commands

```
/start          — show menu
/status         — engine, GPT limit, active project
/project [client] [name]  — set active project
/switch gpt|claude|higgsfield|template  — switch engine
/image [prompt] — generate image (auto-selects engine)
/video [prompt] — generate video (Higgsfield)
/storyboard [brief]  — full storyboard pipeline
/approve [n]    — approve scene n
/retry [n]      — regenerate scene n
/adjust [n] [feedback]  — adjust scene n
/allbad [n]     — mark all bad, request adjustment
/compile        — compile approved storyboard to HTML
/vo [text|dialect|gender|age|emotion]  — generate VO
/voscript [scene] [brand]  — write + generate Arabic VO script
/brain          — second brain summary
/agency         — choose engine interactively
```

## Deploy Commands

```bash
# First deploy
railway up

# Re-deploy after changes
railway up

# View logs
railway logs

# Open dashboard
railway open
```

## File Structure

```
super_visual_cloud/
├── Procfile
├── .railway.toml
├── .gitignore
├── README.md
├── server/
│   ├── index.js              # Express app + bot startup
│   ├── init.js               # DB init + seeding
│   ├── package.json
│   ├── .env.example
│   ├── middleware/
│   │   └── auth.js           # JWT middleware
│   ├── routes/
│   │   ├── auth.js
│   │   ├── brain.js
│   │   ├── generate.js
│   │   ├── storyboard.js
│   │   ├── branding.js
│   │   ├── vo.js
│   │   ├── projects.js
│   │   ├── memory.js
│   │   └── topaz.js
│   ├── services/
│   │   ├── supabase.js
│   │   ├── gpt.js
│   │   ├── claude.js
│   │   ├── higgsfield.js
│   │   ├── elevenlabs.js
│   │   └── memory.js
│   ├── bots/
│   │   ├── telegram.js
│   │   └── whatsapp.js
│   └── public/
│       ├── index.html        # SPA dashboard
│       └── login.html
└── mac_agent/
    ├── topaz_agent.py        # Polls server, runs Topaz, uploads result
    ├── start.sh
    └── .env.example
```
