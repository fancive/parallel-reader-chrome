from __future__ import annotations

import json

import pytest

from e2e_contract_validator import check
from e2e_contract_validator.converters import input_test_transcript


def test_v04_runbook_transcript_converts_risk_tags(tmp_path):
    runbook = tmp_path / "runbook.yaml"
    runbook.write_text(
        """cases:
  - id: c1
    group_id: R1
    status: passed
  - id: c2
    group_id: R4
    status: passed
""",
        encoding="utf-8",
    )
    transcript = tmp_path / "code-agent-1.md"
    transcript.write_text(f"---\nservice: code-agent\nrunbook: {runbook.name}\nexit_code: 0\n---\n", encoding="utf-8")

    ctrf = input_test_transcript.convert_transcript(transcript)
    tags = {tag for test in ctrf["results"]["tests"] for tag in test["tags"]}

    assert "risk:failure_path" in tags
    assert "risk:concurrency" in tags


def test_converted_transcript_can_fail_required_coverage(tmp_path):
    runbook = tmp_path / "runbook.yaml"
    runbook.write_text("cases:\n  - id: c1\n    group_id: R1\n    status: passed\n", encoding="utf-8")
    transcript = tmp_path / "code-agent-1.md"
    transcript.write_text(f"---\nservice: code-agent\nrunbook: {runbook.name}\nexit_code: 0\n---\n", encoding="utf-8")
    artifact = tmp_path / "artifact.json"
    config = tmp_path / "config.yaml"
    artifact.write_text(json.dumps(input_test_transcript.convert_transcript(transcript)), encoding="utf-8")
    config.write_text('schema_version: "2.0"\nrequired_risk_tags: [failure_path, concurrency]\n', encoding="utf-8")

    result, exit_code = check.run_check(config, artifact)

    assert exit_code == 1
    assert result["missing"] == ["concurrency"]


def test_legacy_known_service_uses_profile(tmp_path):
    transcript = tmp_path / "code-agent-1.md"
    transcript.write_text("---\nservice: code-agent\nexit_code: 0\n---\nno groups\n", encoding="utf-8")

    ctrf = input_test_transcript.convert_transcript(transcript)
    tags = set(ctrf["results"]["tests"][0]["tags"])

    assert "risk:wiring" in tags
    assert "risk:concurrency" in tags


def test_unknown_legacy_service_exits_3(tmp_path):
    transcript = tmp_path / "unknown-1.md"
    transcript.write_text("---\nservice: unknown\nexit_code: 0\n---\nno groups\n", encoding="utf-8")

    with pytest.raises(input_test_transcript.TranscriptError):
        input_test_transcript.convert_transcript(transcript)


def test_unfinished_transcript_exits_3(tmp_path):
    transcript = tmp_path / "code-agent-1.md"
    transcript.write_text("---\nservice: code-agent\nexit_code: TBD\n---\n", encoding="utf-8")

    with pytest.raises(input_test_transcript.TranscriptError):
        input_test_transcript.convert_transcript(transcript)
