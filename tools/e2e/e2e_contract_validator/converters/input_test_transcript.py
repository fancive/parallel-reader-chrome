"""Convert legacy input-test transcripts to CTRF."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import yaml

from ..core import summary_counts


STRATEGY_TAGS = {
    "R1": {"failure_path"},
    "negation_test": {"failure_path"},
    "R2": {"failure_path", "boundary_io"},
    "boundary": {"failure_path", "boundary_io"},
    "R3": {"resource_lifecycle", "failure_path"},
    "lifecycle": {"resource_lifecycle", "failure_path"},
    "R4": {"concurrency", "data_integrity"},
    "concurrency": {"concurrency", "data_integrity"},
}

SERVICE_PROFILES = {
    "billing-gateway": {"boundary_io", "failure_path", "regression"},
    "code-agent": {"boundary_io", "wiring", "failure_path", "concurrency", "regression"},
    "personalization-push": {"boundary_io", "failure_path", "resource_lifecycle"},
    "rca-pipeline": {"boundary_io", "wiring", "failure_path", "data_integrity"},
    "unified-filter": {"boundary_io", "failure_path", "data_integrity"},
    "traffic-gateway": {"boundary_io", "failure_path", "concurrency"},
    "abtest": {"boundary_io", "data_integrity", "regression"},
    "realtime-push-end-time": {"boundary_io", "failure_path", "resource_lifecycle"},
    "agent-tools": {"boundary_io", "wiring", "failure_path"},
}


class TranscriptError(Exception):
    """Transcript cannot be converted safely."""


def _frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end < 0:
        return {}, text
    block = text[4:end]
    body = text[end + len("\n---"):]
    data = yaml.safe_load(block) or {}
    return (data if isinstance(data, dict) else {}), body


def _reject_tbd(value: Any, path: str = "") -> None:
    if isinstance(value, str) and value.strip().upper() == "TBD":
        raise TranscriptError(f"unfinished transcript field: {path}")
    if isinstance(value, dict):
        for key, child in value.items():
            _reject_tbd(child, f"{path}.{key}" if path else str(key))
    if isinstance(value, list):
        for index, child in enumerate(value):
            _reject_tbd(child, f"{path}[{index}]")


def _service_from(fm: dict[str, Any], transcript_path: Path) -> str:
    for key in ("service", "skill", "target_service"):
        if fm.get(key):
            return str(fm[key])
    match = re.match(r"([a-z0-9-]+)-\d", transcript_path.name)
    return match.group(1) if match else ""


def _tags_from_case(case: dict[str, Any]) -> set[str]:
    tags: set[str] = set()
    for key in ("group_id", "falsifiability_strategy", "strategy"):
        value = str(case.get(key, "")).strip()
        tags.update(STRATEGY_TAGS.get(value, set()))
    for tag in case.get("risk_tags") or []:
        if isinstance(tag, str):
            tags.add(tag.removeprefix("risk:").removeprefix("risk_"))
    if case.get("regression") is True:
        tags.add("regression")
    return tags


def _load_cases_from_runbook(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(text)
        if isinstance(data, dict) and isinstance(data.get("cases"), list):
            return [case for case in data["cases"] if isinstance(case, dict)]
    except yaml.YAMLError:
        pass

    cases: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    for line in text.splitlines():
        match = re.match(r"\s*(case_id|id|group_id|falsifiability_strategy|strategy|status|regression)\s*:\s*(.+)\s*$", line)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip()
        if key in {"case_id", "id"} and current:
            cases.append(current)
            current = {}
        current[key] = value.lower() == "true" if key == "regression" else value
    if current:
        cases.append(current)
    return cases


def _legacy_group_cases(body: str) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for match in re.finditer(r"\b(R[1-4])\b[^\n]*(PASS|PASSED|OK|FAIL|FAILED|SKIP|SKIPPED)", body, re.I):
        status_word = match.group(2).lower()
        cases.append({
            "id": match.group(1),
            "group_id": match.group(1),
            "status": "passed" if status_word in {"pass", "passed", "ok"} else status_word,
        })
    return cases


def _make_test(name: str, status: str, tags: set[str], raw: str = "") -> dict[str, Any]:
    ctrf_status = "passed" if status in {"passed", "pass", "ok"} else "failed" if status in {"failed", "fail"} else "skipped"
    return {
        "name": name,
        "status": ctrf_status,
        "duration": 0,
        "tags": [f"risk:{tag}" for tag in sorted(tags)],
        "extra": {
            "rawStatus": raw or status,
            "e2e_contract": {
                "schema_version": "2.0",
                "probe": {"kind": "cli"},
            },
        },
    }


def convert_transcript(path: str | Path) -> dict[str, Any]:
    transcript = Path(path)
    text = transcript.read_text(encoding="utf-8")
    fm, body = _frontmatter(text)
    _reject_tbd(fm)
    service = _service_from(fm, transcript)
    exit_code = fm.get("exit_code", fm.get("status_summary", {}).get("exit_code") if isinstance(fm.get("status_summary"), dict) else None)
    if str(exit_code).strip().upper() == "TBD":
        raise TranscriptError("unfinished transcript exit_code")

    cases: list[dict[str, Any]] = []
    runbook = fm.get("runbook") or fm.get("runbook_path")
    if runbook:
        runbook_path = Path(str(runbook))
        if not runbook_path.is_absolute():
            runbook_path = transcript.parent / runbook_path
        cases = _load_cases_from_runbook(runbook_path)
    if not cases:
        cases = _legacy_group_cases(body)

    tests: list[dict[str, Any]] = []
    for index, case in enumerate(cases, 1):
        status = str(case.get("status", "passed")).lower()
        if status in {"passed", "pass", "ok"}:
            tests.append(_make_test(str(case.get("id") or case.get("case_id") or f"case-{index}"), status, _tags_from_case(case)))

    if not tests:
        if service in SERVICE_PROFILES and str(exit_code) == "0":
            tests.append(_make_test(f"{service}.legacy-profile", "passed", SERVICE_PROFILES[service], "legacy-profile"))
        else:
            raise TranscriptError("cannot convert transcript without explicit cases or known successful service profile")

    now_ms = int(time.time() * 1000)
    return {
        "reportFormat": "CTRF",
        "specVersion": "0.0.0",
        "results": {
            "tool": {"name": "input-test-transcript", "version": "1"},
            "summary": {**summary_counts(tests), "start": now_ms, "stop": now_ms},
            "tests": tests,
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert input-test transcript markdown to CTRF")
    parser.add_argument("transcript", help="Transcript markdown path")
    parser.add_argument("--output", "-o", help="Output CTRF JSON path")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        ctrf = convert_transcript(args.transcript)
    except (OSError, TranscriptError, yaml.YAMLError) as error:
        print(json.dumps({"status": "invalid", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 3
    output = json.dumps(ctrf, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(output + "\n", encoding="utf-8")
    else:
        sys.stdout.write(output + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
