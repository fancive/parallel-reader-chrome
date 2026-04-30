"""Command dispatcher for e2e_contract_validator.

Trimmed for this repo: only the ``gate`` subcommand is wired up. Upstream
(fancive/claude-code-addons) also exposes ``check``, ``init``, ``exempt`` and
the ``junit-xml`` / ``input-test-transcript`` converters; none are used here.
"""

from __future__ import annotations

import argparse

from . import gate


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="e2e_contract_validator")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("gate", help="Run project .e2e gate")

    args, rest = parser.parse_known_args(argv)
    if args.command == "gate":
        return gate.main(rest)
    parser.error(f"unknown command {args.command}")
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
