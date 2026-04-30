"""Convert JUnit XML to CTRF JSON."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from ..core import summary_counts


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _children(element: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in list(element) if _local_name(child.tag) == name]


def _first(element: ET.Element, name: str) -> ET.Element | None:
    matches = _children(element, name)
    return matches[0] if matches else None


def _property_map(testcase: ET.Element) -> dict[str, str]:
    props = _first(testcase, "properties")
    values: dict[str, str] = {}
    if props is None:
        return values
    for prop in _children(props, "property"):
        name = prop.attrib.get("name")
        value = prop.attrib.get("value", "")
        if name:
            values[name] = value
    return values


def _risk_tags(properties: dict[str, str]) -> list[str]:
    tags: set[str] = set()
    for raw in re.split(r"[\s,]+", properties.get("risk_tag", "").strip()):
        if raw:
            tags.add(raw.removeprefix("risk_").removeprefix("risk:"))
    for raw in re.split(r"[\s,]+", properties.get("markers", "").strip()):
        if raw.startswith("risk_"):
            tags.add(raw.removeprefix("risk_"))
        elif raw.startswith("risk:"):
            tags.add(raw.removeprefix("risk:"))
    return [f"risk:{tag}" for tag in sorted(tags)]


def _status_and_raw(testcase: ET.Element) -> tuple[str, str]:
    failure = _first(testcase, "failure")
    error = _first(testcase, "error")
    skipped = _first(testcase, "skipped")
    system_out = _first(testcase, "system-out")
    if failure is not None or error is not None:
        text = " ".join([
            (failure.attrib.get("message", "") if failure is not None else ""),
            (failure.text or "" if failure is not None else ""),
            (error.attrib.get("message", "") if error is not None else ""),
            (error.text or "" if error is not None else ""),
        ]).lower()
        raw = "xpassed_strict" if "xpass" in text or "xpassed" in text else "failed"
        return "failed", raw
    if skipped is not None:
        text = f"{skipped.attrib.get('message', '')} {skipped.text or ''}".lower()
        return "skipped", "xfailed" if "xfail" in text else "skipped"
    if system_out is not None and re.search(r"\bXPASS\b", system_out.text or ""):
        return "other", "xpassed"
    return "passed", "passed"


def _testcases(root: ET.Element) -> list[ET.Element]:
    if _local_name(root.tag) == "testcase":
        return [root]
    return [element for element in root.iter() if _local_name(element.tag) == "testcase"]


def convert_file(path: str | Path) -> dict[str, Any]:
    tree = ET.parse(path)
    root = tree.getroot()
    tests: list[dict[str, Any]] = []
    now_ms = int(time.time() * 1000)
    for testcase in _testcases(root):
        properties = _property_map(testcase)
        status, raw_status = _status_and_raw(testcase)
        classname = testcase.attrib.get("classname", "")
        name = testcase.attrib.get("name", "unnamed")
        full_name = f"{classname}.{name}" if classname else name
        duration = float(testcase.attrib.get("time", "0") or 0)
        tests.append({
            "name": full_name,
            "status": status,
            "duration": int(duration * 1000),
            "tags": _risk_tags(properties),
            "extra": {
                "rawStatus": raw_status,
                "e2e_contract": {
                    "schema_version": "2.0",
                    "probe": {"kind": "library"},
                },
            },
        })
    return {
        "reportFormat": "CTRF",
        "specVersion": "0.0.0",
        "results": {
            "tool": {"name": "junit-xml", "version": "1"},
            "summary": {**summary_counts(tests), "start": now_ms, "stop": now_ms},
            "tests": tests,
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert JUnit XML to CTRF")
    parser.add_argument("xml", help="JUnit XML file")
    parser.add_argument("--output", "-o", help="Output CTRF JSON path")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    ctrf = convert_file(args.xml)
    output = json.dumps(ctrf, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(output + "\n", encoding="utf-8")
    else:
        sys.stdout.write(output + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
