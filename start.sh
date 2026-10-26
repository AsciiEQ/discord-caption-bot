#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js not found. Run ./setup.sh first."; exit 1; }
[ -d node_modules ] || { echo "Run ./setup.sh first."; exit 1; }
[ -f .env ] || { echo "No .env - run ./setup.sh and paste your token."; exit 1; }
node index.js
