#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! python -c 'import e2e_contract_validator' >/dev/null 2>&1; then
  if [ -n "${E2E_CONTRACT_VALIDATOR_PYTHONPATH:-}" ]; then
    export PYTHONPATH="${E2E_CONTRACT_VALIDATOR_PYTHONPATH}${PYTHONPATH:+:$PYTHONPATH}"
  elif [ -d "tools/e2e/e2e_contract_validator" ]; then
    export PYTHONPATH="$(cd tools/e2e && pwd)${PYTHONPATH:+:$PYTHONPATH}"
  elif [ -d "../claude-code-addons/scripts" ]; then
    export PYTHONPATH="$(cd "../claude-code-addons/scripts" && pwd)${PYTHONPATH:+:$PYTHONPATH}"
  else
    echo "e2e_contract_validator is not importable; vendored copy missing under tools/e2e/" >&2
    exit 3
  fi
fi

if ! python -c 'import e2e_contract_validator' >/dev/null 2>&1; then
  echo "e2e_contract_validator still not importable after PYTHONPATH setup" >&2
  exit 3
fi

python -m e2e_contract_validator gate --project . --json "$@"
