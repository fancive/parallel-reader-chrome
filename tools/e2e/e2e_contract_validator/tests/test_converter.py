from __future__ import annotations

from e2e_contract_validator import check
from e2e_contract_validator.converters import junit_xml


def test_junit_xml_converter_extracts_properties_and_statuses(tmp_path):
    xml = tmp_path / "junit.xml"
    xml.write_text(
        """<testsuite>
          <testcase classname="c" name="pass" time="0.1"><properties><property name="risk_tag" value="failure_path,wiring"/></properties></testcase>
          <testcase classname="c" name="xfail"><skipped message="xfail reason"/></testcase>
          <testcase classname="c" name="xpass"><failure message="XPASS strict"/></testcase>
          <testcase classname="c" name="other"><system-out>XPASS</system-out></testcase>
        </testsuite>""",
        encoding="utf-8",
    )

    ctrf = junit_xml.convert_file(xml)

    assert ctrf["results"]["summary"]["tests"] == 4
    assert ctrf["results"]["summary"]["passed"] == 1
    assert ctrf["results"]["summary"]["failed"] == 1
    assert ctrf["results"]["summary"]["skipped"] == 1
    assert ctrf["results"]["summary"]["other"] == 1
    assert ctrf["results"]["tests"][0]["tags"] == ["risk:failure_path", "risk:wiring"]
    assert ctrf["results"]["tests"][1]["extra"]["rawStatus"] == "xfailed"
    assert ctrf["results"]["tests"][2]["extra"]["rawStatus"] == "xpassed_strict"
    assert ctrf["results"]["tests"][3]["extra"]["rawStatus"] == "xpassed"


def test_junit_xml_output_can_be_checked(tmp_path):
    xml = tmp_path / "junit.xml"
    xml.write_text(
        """<testsuite><testcase classname="c" name="pass"><properties><property name="markers" value="risk_failure_path risk_wiring"/></properties></testcase></testsuite>""",
        encoding="utf-8",
    )
    ctrf_path = tmp_path / "artifact.json"
    config_path = tmp_path / "config.yaml"
    config_path.write_text('schema_version: "2.0"\nrequired_risk_tags: [failure_path, wiring]\n', encoding="utf-8")
    junit_xml.main([str(xml), "--output", str(ctrf_path)])

    _, exit_code = check.run_check(config_path, ctrf_path)

    assert exit_code == 0
