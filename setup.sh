#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
echo "=== AsciiEQ Discord Caption Bot - setup ==="
command -v node >/dev/null 2>&1 || { echo "Node.js not found. Install from https://nodejs.org then re-run."; exit 1; }
npm install || { echo "Install failed - see README.md Troubleshooting."; exit 1; }
[ -f .env ] || { cp .env.example .env; echo "Created .env"; }
echo "Done. Edit .env, paste your DISCORD_BOT_TOKEN, then run ./start.sh"
