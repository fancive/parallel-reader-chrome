"""Core validators for the e2e CTRF contract."""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

import yaml


VALID_RISK_TAGS = {
    "boundary_io",
    "failure_path",
    "concurrency",
    "wiring",
    "regression",
    "security",
    "data_integrity",
    "resource_lifecycle",
    "contract",
}


class ContractError(Exception):
    """Base contract validation error."""


class BadConfigError(ContractError):
    """Config or artifact cannot be parsed as a supported contract."""


class ArtifactInvalidError(ContractError):
    """Artifact is structurally present but invalid or inconsistent."""


def load_config(path: str | Path) -> dict[str, Any]:
    config_path = Path(path)
    with config_path.open("r", encoding="utf-8") as handle:
        config = yaml.safe_load(handle) or {}
    if not isinstance(config, dict):
        raise BadConfigError("config must be a YAML object")

    schema_version = str(config.get("schema_version", ""))
    if not schema_version:
        raise BadConfigError("config.schema_version is required")
    if schema_version.split(".", 1)[0] != "2":
        raise BadConfigError(f"unsupported config schema_version {schema_version!r}")

    required = config.get("required_risk_tags")
    if not isinstance(required, list) or not required:
        raise BadConfigError("config.required_risk_tags must be a non-empty list")
    invalid = [
        tag for tag in required
        if not isinstance(tag, str) or (tag not in VALID_RISK_TAGS and not tag.startswith("x-"))
    ]
    if invalid:
        raise BadConfigError(f"unknown required risk tag(s): {', '.join(map(str, invalid))}")
    return config


def load_ctrf(path: str | Path) -> dict[str, Any]:
    artifact_path = Path(path)
    with artifact_path.open("r", encoding="utf-8") as handle:
        ctrf = json.load(handle)
    if not isinstance(ctrf, dict):
        raise BadConfigError("artifact must be a JSON object")

    results = ctrf.get("results")
    if not isinstance(results, dict):
        raise BadConfigError("artifact.results is required")
    if not isinstance(results.get("tool"), dict):
        raise BadConfigError("artifact.results.tool is required")
    if not isinstance(results.get("summary"), dict):
        raise BadConfigError("artifact.results.summary is required")
    if not isinstance(results.get("tests"), list):
        raise BadConfigError("artifact.results.tests must be a list")
    return ctrf


def check_risk_coverage(config: dict[str, Any], ctrf: dict[str, Any]) -> list[str]:
    required = set(config.get("required_risk_tags") or [])
    covered = {
        tag.removeprefix("risk:")
        for test in ctrf["results"]["tests"]
        if test.get("status") == "passed"
        for tag in test.get("tags", [])
        if isinstance(tag, str) and tag.startswith("risk:")
    }
    return sorted(required - covered)


def _iter_e2e_contracts(ctrf: dict[str, Any]):
    for test in ctrf["results"]["tests"]:
        extra = test.get("extra") or {}
        contract = extra.get("e2e_contract") or {}
        if isinstance(contract, dict):
            yield test, contract


def _walk_dicts(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_dicts(child)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_evidence_sha256(ctrf: dict[str, Any], evidence_dir: str | Path) -> list[str]:
    base = Path(evidence_dir).resolve()
    mismatches: list[str] = []
    for test, contract in _iter_e2e_contracts(ctrf):
        test_name = str(test.get("name", "<unknown>"))
        for mapping in _walk_dicts(contract):
            for key, expected in mapping.items():
                if not key.endswith("_sha256") or not isinstance(expected, str):
                    continue
                path_key = f"{key[:-7]}_path"
                rel_path = mapping.get(path_key)
                if not isinstance(rel_path, str) or not rel_path:
                    continue
                file_path = Path(rel_path)
                file_path = file_path.resolve() if file_path.is_absolute() else (base / file_path).resolve()
                try:
                    file_path.relative_to(base)
                except ValueError:
                    mismatches.append(f"{test_name}: evidence path escapes base directory {rel_path}")
                    continue
                if not file_path.exists():
                    mismatches.append(f"{test_name}: missing evidence file {rel_path}")
                    continue
                actual = _sha256(file_path)
                if actual != expected:
                    mismatches.append(f"{test_name}: {rel_path} sha256 mismatch")
    return mismatches


def check_internal_consistency(ctrf: dict[str, Any]) -> list[str]:
    summary = ctrf["results"]["summary"]
    tests = ctrf["results"]["tests"]
    statuses = ["passed", "failed", "skipped", "pending", "other"]
    errors: list[str] = []
    for field in ["tests", *statuses]:
        if field not in summary:
            errors.append(f"summary.{field} is required")
    count_total = sum(int(summary.get(status, 0) or 0) for status in statuses)
    declared_total = int(summary.get("tests", len(tests)) or 0)
    if declared_total != len(tests):
        errors.append(f"summary.tests={declared_total} but artifact has {len(tests)} test entries")
    if count_total != len(tests):
        errors.append(f"summary status counts total {count_total} but artifact has {len(tests)} test entries")
    failed_count = int(summary.get("failed", 0) or 0)
    if failed_count:
        errors.append(f"summary.failed={failed_count}; e2e gate requires all tests to pass")

    for test, contract in _iter_e2e_contracts(ctrf):
        if test.get("status") != "passed":
            continue
        command = contract.get("command_recorded")
        if not isinstance(command, dict):
            continue
        if "exit_code" not in command:
            errors.append(f"{test.get('name', '<unknown>')}: command_recorded.exit_code missing")
            continue
        actual = command.get("exit_code")
        expected = contract.get("expected_exit_code", 0)
        if actual != expected:
            errors.append(
                f"{test.get('name', '<unknown>')}: exit_code {actual!r} != expected {expected!r}"
            )
    return errors


def verify_cosign(artifact_path: str | Path, signature_path: str | Path) -> bool:
    result = subprocess.run(
        ["cosign", "verify-blob", "--signature", str(signature_path), str(artifact_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    return result.returncode == 0


def summary_counts(tests: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"tests": len(tests), "passed": 0, "failed": 0, "pending": 0, "skipped": 0, "other": 0}
    for test in tests:
        status = test.get("status")
        if status in counts and status != "tests":
            counts[status] += 1
        else:
            counts["other"] += 1
    return counts
