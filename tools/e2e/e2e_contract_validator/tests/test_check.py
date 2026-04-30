from __future__ import annotations

from e2e_contract_validator import check

from conftest import make_ctrf, sha256_text, write_json


def test_check_green(e2e_project):
    write_json(e2e_project / ".e2e" / "artifact.json", make_ctrf(["failure_path", "wiring"]))

    result, exit_code = check.run_check(e2e_project / ".e2e" / "config.yaml", e2e_project / ".e2e" / "artifact.json")

    assert exit_code == 0
    assert result["status"] == "pass"


def test_check_missing_risk_tag_fails(e2e_project):
    write_json(e2e_project / ".e2e" / "artifact.json", make_ctrf(["failure_path"]))

    result, exit_code = check.run_check(e2e_project / ".e2e" / "config.yaml", e2e_project / ".e2e" / "artifact.json")

    assert exit_code == 1
    assert result["missing"] == ["wiring"]


def test_check_sha_mismatch_is_invalid(e2e_project):
    evidence = e2e_project / ".e2e" / "evidence" / "stdout.txt"
    evidence.write_text("actual", encoding="utf-8")
    artifact = make_ctrf(["failure_path", "wiring"], evidence={"path": "evidence/stdout.txt", "sha256": sha256_text("expected")})
    write_json(e2e_project / ".e2e" / "artifact.json", artifact)

    result, exit_code = check.run_check(e2e_project / ".e2e" / "config.yaml", e2e_project / ".e2e" / "artifact.json")

    assert exit_code == 4
    assert result["status"] == "invalid"


def test_check_expected_exit_code_allows_nonzero(e2e_project):
    artifact = make_ctrf(["failure_path", "wiring"], exit_code=1, expected_exit_code=1)
    write_json(e2e_project / ".e2e" / "artifact.json", artifact)

    _, exit_code = check.run_check(e2e_project / ".e2e" / "config.yaml", e2e_project / ".e2e" / "artifact.json")

    assert exit_code == 0


def test_check_expected_exit_code_mismatch_fails(e2e_project):
    artifact = make_ctrf(["failure_path", "wiring"], exit_code=2, expected_exit_code=1)
    write_json(e2e_project / ".e2e" / "artifact.json", artifact)

    result, exit_code = check.run_check(e2e_project / ".e2e" / "config.yaml", e2e_project / ".e2e" / "artifact.json")

    assert exit_code == 1
    assert "exit_code" in result["failures"][0]


def test_check_failed_tests_fail_even_when_required_tags_are_covered(e2e_project):
    artifact = make_ctrf(["failure_path", "wiring"], status="failed")
    write_json(e2e_project / ".e2e" / "artifact.json", artifact)

    result, exit_code = check.run_check(e2e_project / ".e2e" / "config.yaml", e2e_project / ".e2e" / "artifact.json")

    assert exit_code == 1
    assert "summary.failed" in result["failures"][0]


def test_check_requires_summary_tests_field(e2e_project):
    artifact = make_ctrf(["failure_path", "wiring"])
    del artifact["results"]["summary"]["tests"]
    write_json(e2e_project / ".e2e" / "artifact.json", artifact)

    result, exit_code = check.run_check(e2e_project / ".e2e" / "config.yaml", e2e_project / ".e2e" / "artifact.json")

    assert exit_code == 1
    assert "summary.tests is required" in result["failures"][0]


def test_check_evidence_path_cannot_escape_base(e2e_project):
    artifact = make_ctrf(["failure_path", "wiring"], evidence={"path": "../outside.txt", "sha256": "bad"})
    write_json(e2e_project / ".e2e" / "artifact.json", artifact)

    result, exit_code = check.run_check(e2e_project / ".e2e" / "config.yaml", e2e_project / ".e2e" / "artifact.json")

    assert exit_code == 4
    assert "escapes base" in result["failures"][0]


def test_check_cosign_required_calls_verifier(e2e_project, monkeypatch):
    config = e2e_project / ".e2e" / "config.yaml"
    config.write_text('schema_version: "2.0"\nrequired_risk_tags: [failure_path, wiring]\nprovenance:\n  cosign_required: true\n', encoding="utf-8")
    artifact = e2e_project / ".e2e" / "artifact.json"
    sig = e2e_project / ".e2e" / "artifact.json.sig"
    write_json(artifact, make_ctrf(["failure_path", "wiring"]))
    sig.write_text("sig", encoding="utf-8")
    calls = []
    monkeypatch.setattr(check, "verify_cosign", lambda art, signature: calls.append((art, signature)) or True)

    _, exit_code = check.run_check(config, artifact)

    assert exit_code == 0
    assert calls


def test_check_cosign_failure_fails(e2e_project, monkeypatch):
    config = e2e_project / ".e2e" / "config.yaml"
    config.write_text('schema_version: "2.0"\nrequired_risk_tags: [failure_path, wiring]\nprovenance:\n  cosign_required: true\n', encoding="utf-8")
    artifact = e2e_project / ".e2e" / "artifact.json"
    sig = e2e_project / ".e2e" / "artifact.json.sig"
    write_json(artifact, make_ctrf(["failure_path", "wiring"]))
    sig.write_text("sig", encoding="utf-8")
    monkeypatch.setattr(check, "verify_cosign", lambda art, signature: False)

    result, exit_code = check.run_check(config, artifact)

    assert exit_code == 1
    assert "provenance" in result["failures"][0]
