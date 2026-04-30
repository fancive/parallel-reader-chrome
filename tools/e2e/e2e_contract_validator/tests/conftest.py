from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest


def make_ctrf(tags=None, status="passed", exit_code=None, expected_exit_code=None, evidence=None):
    contract = {"schema_version": "2.0", "probe": {"kind": "library"}}
    if exit_code is not None:
        contract["command_recorded"] = {"argv": ["demo"], "exit_code": exit_code}
    if expected_exit_code is not None:
        contract["expected_exit_code"] = expected_exit_code
    if evidence:
        contract["command_recorded"] = {
            **contract.get("command_recorded", {"argv": ["demo"], "exit_code": 0}),
            "stdout_path": evidence["path"],
            "stdout_sha256": evidence["sha256"],
        }
    tests = [{
        "name": "demo",
        "status": status,
        "duration": 1,
        "tags": [f"risk:{tag}" for tag in (tags or [])],
        "extra": {"e2e_contract": contract},
    }]
    summary = {"tests": 1, "passed": 1 if status == "passed" else 0, "failed": 1 if status == "failed" else 0, "skipped": 0, "pending": 0, "other": 0}
    return {"reportFormat": "CTRF", "specVersion": "0.0.0", "results": {"tool": {"name": "test"}, "summary": summary, "tests": tests}}


@pytest.fixture
def e2e_project(tmp_path):
    (tmp_path / ".e2e").mkdir()
    (tmp_path / ".e2e" / "evidence").mkdir()
    (tmp_path / ".e2e" / "config.yaml").write_text(
        'schema_version: "2.0"\nrequired_risk_tags: [failure_path, wiring]\nprovenance:\n  cosign_required: false\n',
        encoding="utf-8",
    )
    return tmp_path


def write_json(path: Path, data):
    path.write_text(json.dumps(data), encoding="utf-8")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()
