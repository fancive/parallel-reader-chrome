#!/usr/bin/env bash
# Run the e2e gate inside a Linux Playwright container so behavior matches
# GitHub Actions without needing a push. Useful for diagnosing Chrome
# regressions that only surface on Linux stable.

set -euo pipefail

cd "$(dirname "$0")/.."

PW_VERSION=$(node -p "require('./package.json').devDependencies['playwright-core']?.match(/\\d+\\.\\d+\\.\\d+/)?.[0] || ''")
if [ -n "${PW_VERSION}" ]; then
  IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-jammy"
else
  IMAGE="mcr.microsoft.com/playwright:latest"
fi

echo "[e2e:linux] image: ${IMAGE}"

# Mount the repo, mask host node_modules with an anonymous volume so the
# container's `npm ci` does not overwrite the host's macOS binaries.
docker run --rm -t \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  -v "$PWD":/app \
  -v /app/node_modules \
  -w /app \
  --ipc=host \
  "${IMAGE}" \
  bash -c '
    set -euo pipefail
    apt-get update >/dev/null
    apt-get install -y --no-install-recommends python3 python-is-python3 python3-yaml dbus-x11 >/dev/null
    cleanup() {
      chown -R "${HOST_UID}:${HOST_GID}" /app/.e2e /app/dist >/dev/null 2>&1 || true
    }
    trap cleanup EXIT
    mkdir -p /run/dbus
    dbus-daemon --system --fork
    npm ci
    dbus-run-session -- xvfb-run -a bash .e2e/run.sh
  '
