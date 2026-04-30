"""Host-neutral e2e gate wrapper."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path
from typing import Any

from .check import run_check
from .core import BadConfigError, load_config
from .exempt import validate_exemption


def _run_shell(command: str, cwd: Path) -> tuple[int, str, str]:
    result = subprocess.run(
        command,
        cwd=str(cwd),
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    return result.returncode, result.stdout, result.stderr


def run_preconditions(config: dict[str, Any], project: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for item in config.get("preconditions") or []:
        if not isinstance(item, dict) or not item.get("check"):
            continue
        code, stdout, stderr = _run_shell(str(item["check"]), project)
        records.append({
            "name": item.get("name", "precondition"),
            "check": item.get("check", ""),
            "exit_code": code,
            "status": "pass" if code == 0 else "fail",
            "stdout": stdout.strip(),
            "stderr": stderr.strip(),
            "remediation": item.get("remediation", ""),
        })
    return records


def run_gate(project: str | Path, skip_run: bool = False, required: bool = False) -> tuple[dict[str, Any], int]:
    project_root = Path(project).resolve()
    e2e_dir = project_root / ".e2e"
    config_path = e2e_dir / "config.yaml"
    artifact_path = e2e_dir / "artifact.json"
    result: dict[str, Any] = {
        "schema_version": "2.0",
        "mode": "ctrf",
        "status": "failed",
        "exit_code": 1,
        "run_exit_code": None,
        "check_exit_code": None,
        "missing": [],
        "artifact_path": str(artifact_path),
        "config_path": str(config_path),
        "preconditions": [],
    }

    if not config_path.exists():
        result["status"] = "missing_contract" if required else "no_contract"
        result["exit_code"] = 3 if required else 0
        return result, result["exit_code"]

    exemption_path = e2e_dir / "exemption.json"
    if exemption_path.exists():
        exemption_result, exemption_exit = validate_exemption(exemption_path)
        result["exemption"] = exemption_result
        result["status"] = "exempt" if exemption_exit == 0 else "invalid_exemption"
        result["exit_code"] = exemption_exit
        return result, exemption_exit

    try:
        config = load_config(config_path)
    except (OSError, BadConfigError) as error:
        result["status"] = "invalid"
        result["failures"] = [str(error)]
        result["exit_code"] = 3
        return result, 3

    preconditions = run_preconditions(config, project_root)
    result["preconditions"] = preconditions
    failed_preconditions = [item for item in preconditions if item["status"] != "pass"]
    if failed_preconditions:
        result["status"] = "precondition_failed"
        result["exit_code"] = 2
        return result, 2

    run_script = e2e_dir / "run.sh"
    run_exit = 0
    if not skip_run:
        if not run_script.exists():
            result["status"] = "invalid"
            result["failures"] = [".e2e/run.sh is missing"]
            result["exit_code"] = 3
            return result, 3
        env = os.environ.copy()
        env["E2E_CONTRACT_ACTIVE"] = "true"
        completed = subprocess.run(
            ["bash", str(run_script)],
            cwd=str(project_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            check=False,
        )
        run_exit = completed.returncode
        result["run_stdout"] = completed.stdout.strip()
        result["run_stderr"] = completed.stderr.strip()
    result["run_exit_code"] = run_exit

    check_result, check_exit = run_check(config_path, artifact_path, e2e_dir)
    result["check"] = check_result
    result["check_exit_code"] = check_exit
    result["missing"] = check_result.get("missing", [])

    exit_code = check_exit if check_exit else (1 if run_exit != 0 else 0)
    result["exit_code"] = exit_code
    result["status"] = "pass" if exit_code == 0 else "fail"
    return result, exit_code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run project .e2e gate")
    parser.add_argument("--project", default=".", help="Project root")
    parser.add_argument("--skip-run", action="store_true", help="Validate existing artifact only")
    parser.add_argument("--required", action="store_true", help="Fail if .e2e/config.yaml is absent")
    parser.add_argument("--json", action="store_true", help="Emit JSON output")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result, exit_code = run_gate(args.project, skip_run=args.skip_run, required=args.required)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.json else None, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
