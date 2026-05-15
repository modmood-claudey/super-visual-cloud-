#!/bin/bash
# Super Visual — Topaz Mac Agent launcher
# Usage: ./start.sh
# Copy .env.example to .env and fill in before running.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "⚠️  .env not found. Copy .env.example → .env and fill in your values."
  exit 1
fi

# Load env
set -a
source "$ENV_FILE"
set +a

echo "════════════════════════════════════"
echo " Super Visual — Topaz Mac Agent"
echo " Server : $SERVER_URL"
echo "════════════════════════════════════"

exec python3 "$SCRIPT_DIR/topaz_agent.py"
