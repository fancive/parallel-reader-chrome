# Vendored E2E tooling

`e2e_contract_validator/` is vendored from
[fancive/claude-code-addons](https://github.com/fancive/claude-code-addons)
(`scripts/e2e_contract_validator/`) so this repo's E2E gate is self-contained
and CI does not depend on an external checkout.

When updating, copy the upstream package wholesale and run
`npm run e2e` locally to verify before committing.

`.e2e/gate.sh` adds `tools/e2e` to `PYTHONPATH` automatically; CI sets
`E2E_CONTRACT_VALIDATOR_PYTHONPATH` to the same path.
