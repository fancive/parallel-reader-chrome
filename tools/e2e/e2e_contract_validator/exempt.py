"""Validate e2e contract exemptions."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml


REQUIRED_EVIDENCE = {
    "docs_only": ["git_diff_files"],
    "config_only_no_runtime": ["changed_paths", "rationale"],
    "test_only": ["git_diff_files"],
    "no_e2e_surface": ["changed_symbols", "rationale"],
    "env_unavailable_blocked": ["failed_precondition", "expected_unblock_condition"],
}


def _present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, (list, dict, str)):
        return bool(value)
    return True


def validate_exemption(path: str | Path) -> tuple[dict[str, Any], int]:
    result = {"schema_version": "2.0", "status": "invalid", "e2e_blocked": False, "failures": []}
    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            exemption = yaml.safe_load(handle) or {}
    except OSError as error:
        result["failures"].append(str(error))
        return result, 3

    if not isinstance(exemption, dict):
        result["failures"].append("exemption must be a YAML/JSON object")
        return result, 3

    exemption_type = exemption.get("type")
    if exemption_type not in REQUIRED_EVIDENCE:
        result["failures"].append(f"invalid exemption type {exemption_type!r}")
        return result, 3

    evidence = exemption.get("evidence") or {}
    if not isinstance(evidence, dict):
        result["failures"].append("exemption.evidence must be an object")
        return result, 1

    missing = [key for key in REQUIRED_EVIDENCE[exemption_type] if not _present(evidence.get(key))]
    if missing:
        result["failures"].append(f"missing evidence field(s): {', '.join(missing)}")
        return result, 1

    result["status"] = "pass"
    result["type"] = exemption_type
    result["e2e_blocked"] = exemption_type == "env_unavailable_blocked"
    return result, 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate e2e exemption evidence")
    parser.add_argument("--file", required=True, help="Path to exemption YAML/JSON")
    parser.add_argument("--json", action="store_true", help="Emit JSON output")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result, exit_code = validate_exemption(args.file)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.json else None, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
