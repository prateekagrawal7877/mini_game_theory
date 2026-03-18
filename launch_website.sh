#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found. Please install Node.js and npm first."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "ADMIN_PASSWORD is not set."
  echo "Using temporary default password: change-me-now"
  echo "For secure admin access, run: export ADMIN_PASSWORD='your-strong-password'"
fi

echo "Launching website..."
echo "Frontend: http://localhost:5173"
echo "API:      http://localhost:8787"

npm run dev
