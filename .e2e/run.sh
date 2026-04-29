#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

rm -f .e2e/artifact.json
npm run build >/dev/null
node scripts/e2e-extension-smoke.mjs
