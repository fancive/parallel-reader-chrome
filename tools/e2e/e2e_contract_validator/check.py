"""Pure CTRF artifact validation command."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .core import (
    ArtifactInvalidError,
    BadConfigError,
    check_internal_consistency,
    check_risk_coverage,
    load_config,
    load_ctrf,
    verify_cosign,
    verify_evidence_sha256,
)


def run_check(
    config_path: str | Path,
    artifact_path: str | Path,
    evidence_dir: str | Path | None = None,
    signature_path: str | Path | None = None,
) -> tuple[dict[str, Any], int]:
    artifact = Path(artifact_path)
    config_file = Path(config_path)
    evidence_base = Path(evidence_dir) if evidence_dir else artifact.parent
    result: dict[str, Any] = {
        "schema_version": "2.0",
        "mode": "ctrf",
        "status": "failed",
        "config_path": str(config_file),
        "artifact_path": str(artifact),
        "missing": [],
        "failures": [],
        "steps": {},
    }

    try:
        config = load_config(config_file)
        ctrf = load_ctrf(artifact)
        result["steps"]["parse"] = "pass"
    except (OSError, json.JSONDecodeError, BadConfigError) as error:
        result["status"] = "invalid"
        result["failures"].append(str(error))
        result["steps"]["parse"] = "fail"
        return result, 3

    provenance = config.get("provenance") or {}
    if provenance.get("cosign_required"):
        sig_path = Path(signature_path) if signature_path else artifact.with_suffix(artifact.suffix + ".sig")
        if not sig_path.exists() or not verify_cosign(artifact, sig_path):
            result["failures"].append("cosign provenance verification failed")
            result["steps"]["provenance"] = "fail"
            return result, 1
        result["steps"]["provenance"] = "pass"
    else:
        result["steps"]["provenance"] = "skipped"

    evidence_errors = verify_evidence_sha256(ctrf, evidence_base)
    if evidence_errors:
        result["status"] = "invalid"
        result["failures"].extend(evidence_errors)
        result["steps"]["evidence_sha256"] = "fail"
        return result, 4
    result["steps"]["evidence_sha256"] = "pass"

    consistency_errors = check_internal_consistency(ctrf)
    if consistency_errors:
        result["failures"].extend(consistency_errors)
        result["steps"]["internal_consistency"] = "fail"
        return result, 1
    result["steps"]["internal_consistency"] = "pass"

    missing = check_risk_coverage(config, ctrf)
    result["missing"] = missing
    if missing:
        result["failures"].append(f"missing required risk tags: {', '.join(missing)}")
        result["steps"]["risk_coverage"] = "fail"
        return result, 1
    result["steps"]["risk_coverage"] = "pass"

    result["status"] = "pass"
    return result, 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate an e2e CTRF artifact")
    parser.add_argument("--config", required=True, help="Path to .e2e/config.yaml")
    parser.add_argument("--artifact", required=True, help="Path to .e2e/artifact.json")
    parser.add_argument("--evidence-dir", help="Base directory for relative evidence paths")
    parser.add_argument("--signature", help="Path to cosign signature")
    parser.add_argument("--json", action="store_true", help="Emit JSON output")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result, exit_code = run_check(args.config, args.artifact, args.evidence_dir, args.signature)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.json else None, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
