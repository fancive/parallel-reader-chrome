# Vendored E2E tooling

`e2e_contract_validator/` is vendored from
[fancive/claude-code-addons](https://github.com/fancive/claude-code-addons)
(`scripts/e2e_contract_validator/`) so this repo's E2E gate is self-contained
and CI does not depend on an external checkout.

Trimmed to only what the `gate` subcommand needs. The upstream package also
ships `init`, `check`, `exempt`, `junit-xml`, and `input-test-transcript`
subcommands plus a `converters/` subpackage; none of those are wired here.
When syncing from upstream, re-apply the trim:

- drop `init.py`
- drop `converters/` and `tests/test_converter.py`,
  `tests/test_input_test_transcript.py`
- in `__main__.py`, only register the `gate` subcommand
- in `tests/test_gate_exempt.py`, drop `init` imports and tests

Run `npm run e2e` and `python -m pytest tools/e2e/e2e_contract_validator/tests`
locally before committing.

`.e2e/gate.sh` adds `tools/e2e` to `PYTHONPATH` automatically; CI sets
`E2E_CONTRACT_VALIDATOR_PYTHONPATH` to the same path.
