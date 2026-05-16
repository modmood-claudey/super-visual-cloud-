#!/usr/bin/env bash
# Super Visual Cloud — DigitalOcean App Platform deploy
# Usage: ./deploy.sh [--token YOUR_DO_TOKEN]
set -e

DOCTL=${DOCTL:-/tmp/doctl}
APP_SPEC=.do/app.yaml

# Load secrets from server/.env
ENV_FILE="server/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found"; exit 1
fi
source <(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$')

echo "=== Super Visual Cloud — DigitalOcean Deploy ==="

# Authenticate if token provided
if [ -n "$1" ] && [[ "$1" == --token* ]]; then
  TOKEN="${1#--token=}"
  $DOCTL auth init --access-token "$TOKEN"
fi

if ! $DOCTL auth list &>/dev/null 2>&1; then
  echo "Not authenticated. Run: $DOCTL auth init"
  exit 1
fi

# Check if app exists
APP_ID=$($DOCTL apps list --format ID,Spec.Name --no-header 2>/dev/null \
  | awk '/super-visual-cloud/{print $1}' | head -1)

if [ -z "$APP_ID" ]; then
  echo "Creating new DigitalOcean app..."
  APP_ID=$($DOCTL apps create --spec "$APP_SPEC" --no-header --format ID 2>/dev/null | head -1)
  echo "Created app: $APP_ID"
else
  echo "Updating existing app: $APP_ID"
  $DOCTL apps update "$APP_ID" --spec "$APP_SPEC" --wait
fi

# Inject secrets (values not stored in YAML)
echo "Setting secret env vars..."
$DOCTL apps update "$APP_ID" \
  --spec <(cat "$APP_SPEC" | \
    python3 -c "
import sys, yaml, json
spec = yaml.safe_load(sys.stdin)
import os
secrets = {
  'OPENAI_API_KEY':      os.environ.get('OPENAI_API_KEY',''),
  'ANTHROPIC_API_KEY':   os.environ.get('ANTHROPIC_API_KEY',''),
  'SUPABASE_ANON_KEY':   os.environ.get('SUPABASE_ANON_KEY',''),
  'SUPABASE_SERVICE_KEY':os.environ.get('SUPABASE_SERVICE_KEY',''),
  'HIGGSFIELD_API_KEY':  os.environ.get('HIGGSFIELD_API_KEY',''),
  'ELEVENLABS_API_KEY':  os.environ.get('ELEVENLABS_API_KEY',''),
  'TELEGRAM_BOT_TOKEN':  os.environ.get('TELEGRAM_BOT_TOKEN',''),
  'JWT_SECRET':          os.environ.get('JWT_SECRET',''),
  'ADMIN_PASSWORD':      os.environ.get('ADMIN_PASSWORD',''),
}
for env in spec['services'][0]['envs']:
  if env['key'] in secrets:
    env['value'] = secrets[env['key']]
print(yaml.dump(spec, default_flow_style=False))
") --wait 2>/dev/null || echo "(secret injection requires pyyaml; set secrets manually in DO dashboard)"

echo ""
echo "=== Deploy complete ==="
$DOCTL apps get "$APP_ID" --format ID,Spec.Name,LiveURL --no-header
