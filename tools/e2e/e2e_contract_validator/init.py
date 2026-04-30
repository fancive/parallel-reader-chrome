"""Project scaffold for the e2e contract."""

from __future__ import annotations

import argparse
import os
import stat
from pathlib import Path


GITIGNORE_LINES = [
    ".e2e/artifact.json",
    ".e2e/artifact.json.sig",
    ".e2e/evidence/",
    ".e2e/.tmp.xml",
]

CONFIG_TEMPLATE = """schema_version: "2.0"

# Uncomment and tune for the current project.
required_risk_tags:
  - boundary_io
  - failure_path
  - concurrency
  - wiring

preconditions: []

provenance:
  cosign_required: false
"""

RUN_TEMPLATE = """#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "TODO: run real e2e probes and write .e2e/artifact.json in CTRF format" >&2
exit 3
"""

GATE_TEMPLATE = """#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! python -c 'import e2e_contract_validator' >/dev/null 2>&1; then
  if [ -n "${E2E_CONTRACT_VALIDATOR_PYTHONPATH:-}" ]; then
    export PYTHONPATH="${E2E_CONTRACT_VALIDATOR_PYTHONPATH}${PYTHONPATH:+:$PYTHONPATH}"
  else
    echo "e2e_contract_validator is not importable; set E2E_CONTRACT_VALIDATOR_PYTHONPATH or install it" >&2
    exit 3
  fi
fi

python -m e2e_contract_validator gate --project . --json "$@"
"""

HOOK_TEMPLATE = """#!/usr/bin/env bash
set -euo pipefail

[ "${STOP_HOOK_ACTIVE:-}" = "true" ] && exit 0
export STOP_HOOK_ACTIVE=true

OUT="$(mktemp)"
set +e
bash .e2e/gate.sh --json >"$OUT"
CODE=$?
set -e

if [ "$CODE" -ne 0 ]; then
  cat "$OUT" >&2
  rm -f "$OUT"
  echo '{"decision":"block","reason":"e2e contract gate failed"}'
  exit 2
fi
cat "$OUT" >&2
rm -f "$OUT"
exit 0
"""

PYTEST_CONFTST_TEMPLATE = '''"""Copy risk_* pytest markers into JUnit XML user properties."""


def pytest_runtest_setup(item):
    markers = [mark.name for mark in item.iter_markers() if mark.name.startswith("risk_")]
    if markers:
        item.user_properties.append(("markers", " ".join(markers)))
        item.user_properties.append(("risk_tag", ",".join(name.removeprefix("risk_") for name in markers)))
'''

README_TEMPLATE = """# E2E Contract

This project uses `.e2e/run.sh` as the single runtime entry point. The script must write `.e2e/artifact.json` in CTRF format. The host-neutral gate is:

```bash
bash .e2e/gate.sh
```

If `e2e_contract_validator` is not installed, set:

```bash
export E2E_CONTRACT_VALIDATOR_PYTHONPATH=/path/to/claude-code-addons/scripts
```
"""

INPUT_TEST_CASES_TEMPLATE = """# input-test migration case metadata

service: {service}
cases:
  - id: TODO
    group_id: R1
    falsifiability_strategy: negation_test
    risk_tags: [failure_path]
    status: pending
"""


def _write(path: Path, content: str, force: bool, executable: bool = False) -> None:
    if path.exists() and not force:
        raise FileExistsError(f"{path} already exists; use --force")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if executable:
        mode = path.stat().st_mode
        path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _append_gitignore(project: Path) -> None:
    gitignore = project / ".gitignore"
    existing = gitignore.read_text(encoding="utf-8").splitlines() if gitignore.exists() else []
    additions = [line for line in GITIGNORE_LINES if line not in existing]
    if not additions:
        return
    with gitignore.open("a", encoding="utf-8") as handle:
        if existing and existing[-1].strip():
            handle.write("\n")
        handle.write("\n".join(additions) + "\n")


def run_init(target: str | Path, force: bool = False, hook_only: bool = False, from_input_test: str = "") -> list[str]:
    project = Path(target).resolve()
    e2e = project / ".e2e"
    written: list[str] = []

    files = [
        (e2e / "gate.sh", GATE_TEMPLATE, True),
        (e2e / "hook.sh", HOOK_TEMPLATE, True),
    ]
    if not hook_only:
        files.extend([
            (e2e / "config.yaml", CONFIG_TEMPLATE, False),
            (e2e / "run.sh", RUN_TEMPLATE, True),
            (e2e / "README.md", README_TEMPLATE, False),
            (e2e / "cases" / ".gitkeep", "", False),
            (e2e / "cases" / "conftest.py", PYTEST_CONFTST_TEMPLATE, False),
        ])
    if from_input_test:
        service_dir = e2e / "cases" / "input-test" / from_input_test
        files.extend([
            (service_dir / "cases.yaml", INPUT_TEST_CASES_TEMPLATE.format(service=from_input_test), False),
            (service_dir / "run.sh", "#!/usr/bin/env bash\nset -euo pipefail\n# TODO: run input-test service scenarios and emit CTRF\n", True),
            (service_dir / "runbook.md", f"# {from_input_test} input-test migration runbook\n", False),
        ])

    for path, content, executable in files:
        _write(path, content, force=force, executable=executable)
        written.append(os.path.relpath(path, project))

    if not hook_only:
        _append_gitignore(project)
        written.append(".gitignore")
    return written


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Initialize project .e2e scaffold")
    parser.add_argument("--target", default=".", help="Project root")
    parser.add_argument("--force", action="store_true", help="Overwrite existing files")
    parser.add_argument("--hook-only", action="store_true", help="Only write gate.sh and hook.sh")
    parser.add_argument("--from-input-test", default="", help="Scaffold project-local input-test service cases")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        written = run_init(args.target, args.force, args.hook_only, args.from_input_test)
    except FileExistsError as error:
        print(str(error))
        return 1
    for item in written:
        print(item)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
