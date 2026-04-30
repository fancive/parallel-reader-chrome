"""Command dispatcher for e2e_contract_validator."""

from __future__ import annotations

import argparse

from . import check, exempt, gate, init
from .converters import input_test_transcript, junit_xml


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="e2e_contract_validator")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("check", help="Validate CTRF artifact")
    subcommands.add_parser("gate", help="Run project .e2e gate")
    subcommands.add_parser("init", help="Create project .e2e scaffold")
    subcommands.add_parser("exempt", help="Validate an e2e exemption")
    subcommands.add_parser("junit-xml", help="Convert JUnit XML to CTRF")
    subcommands.add_parser("input-test-transcript", help="Convert input-test transcript to CTRF")

    args, rest = parser.parse_known_args(argv)
    if args.command == "check":
        return check.main(rest)
    if args.command == "gate":
        return gate.main(rest)
    if args.command == "init":
        return init.main(rest)
    if args.command == "exempt":
        return exempt.main(rest)
    if args.command == "junit-xml":
        return junit_xml.main(rest)
    if args.command == "input-test-transcript":
        return input_test_transcript.main(rest)
    parser.error(f"unknown command {args.command}")
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
