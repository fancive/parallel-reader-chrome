from __future__ import annotations

import os

from e2e_contract_validator import exempt, gate, init

from conftest import make_ctrf, write_json


def test_init_writes_scaffold_and_refuses_overwrite(tmp_path):
    written = init.run_init(tmp_path)

    assert ".e2e/config.yaml" in written
    assert (tmp_path / ".e2e" / "gate.sh").exists()
    assert os.access(tmp_path / ".e2e" / "gate.sh", os.X_OK)
    assert ".e2e/artifact.json" in (tmp_path / ".gitignore").read_text(encoding="utf-8")

    try:
        init.run_init(tmp_path)
    except FileExistsError:
        pass
    else:
        raise AssertionError("second init should refuse without --force")


def test_init_from_input_test_scaffold(tmp_path):
    init.run_init(tmp_path, from_input_test="code-agent")

    assert (tmp_path / ".e2e" / "cases" / "input-test" / "code-agent" / "cases.yaml").exists()


def test_exempt_validates_all_types(tmp_path):
    cases = {
        "docs_only": "evidence:\n  git_diff_files: [README.md]\n",
        "config_only_no_runtime": "evidence:\n  changed_paths: [conf.yaml]\n  rationale: not loaded\n",
        "test_only": "evidence:\n  git_diff_files: [tests/test_demo.py]\n",
        "no_e2e_surface": "evidence:\n  changed_symbols: [helper]\n  rationale: private\n",
        "env_unavailable_blocked": "evidence:\n  failed_precondition: redis\n  expected_unblock_condition: tunnel\n",
    }
    for kind, body in cases.items():
        path = tmp_path / f"{kind}.yaml"
        path.write_text(f"type: {kind}\n{body}", encoding="utf-8")
        result, exit_code = exempt.validate_exemption(path)
        assert exit_code == 0
        assert result["status"] == "pass"


def test_exempt_invalid_type_exits_3(tmp_path):
    path = tmp_path / "bad.yaml"
    path.write_text("type: unknown\nevidence: {}\n", encoding="utf-8")

    _, exit_code = exempt.validate_exemption(path)

    assert exit_code == 3


def test_gate_runs_script_and_preserves_check_exit(e2e_project):
    artifact = e2e_project / ".e2e" / "fixture.json"
    write_json(artifact, make_ctrf(["failure_path", "wiring"]))
    run = e2e_project / ".e2e" / "run.sh"
    run.write_text(f"#!/usr/bin/env bash\ncp {artifact} .e2e/artifact.json\n", encoding="utf-8")
    run.chmod(0o755)

    result, exit_code = gate.run_gate(e2e_project)

    assert exit_code == 0
    assert result["status"] == "pass"
    assert result["run_exit_code"] == 0
    assert result["check_exit_code"] == 0


def test_gate_skip_run_does_not_execute(e2e_project):
    write_json(e2e_project / ".e2e" / "artifact.json", make_ctrf(["failure_path", "wiring"]))
    run = e2e_project / ".e2e" / "run.sh"
    run.write_text("#!/usr/bin/env bash\nexit 99\n", encoding="utf-8")
    run.chmod(0o755)

    _, exit_code = gate.run_gate(e2e_project, skip_run=True)

    assert exit_code == 0


def test_gate_fails_when_runner_exits_nonzero_even_if_artifact_checks(e2e_project):
    write_json(e2e_project / ".e2e" / "artifact.json", make_ctrf(["failure_path", "wiring"]))
    run = e2e_project / ".e2e" / "run.sh"
    run.write_text("#!/usr/bin/env bash\nexit 7\n", encoding="utf-8")
    run.chmod(0o755)

    result, exit_code = gate.run_gate(e2e_project)

    assert exit_code == 1
    assert result["run_exit_code"] == 7
    assert result["check_exit_code"] == 0


def test_gate_absent_contract_required_fails(tmp_path):
    result, exit_code = gate.run_gate(tmp_path, required=True)

    assert exit_code == 3
    assert result["status"] == "missing_contract"
