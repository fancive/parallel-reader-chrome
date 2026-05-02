# E2E Contract

This project uses `.e2e/run.sh` as the single runtime entry point. It builds the extension, launches Chrome with the unpacked `dist/` extension, serves a local article fixture, and writes `.e2e/artifact.json` in CTRF format.

Run the host-neutral gate:

```bash
npm run e2e
```

CI currently records a temporary `env_unavailable_blocked` exemption because
GitHub Actions Linux has not been able to complete Playwright Chromium
`launchPersistentContext` for the MV3 extension smoke. The full smoke remains
available for focused diagnosis:

```bash
bash .e2e/run.sh
npm run e2e:linux
```

If `e2e_contract_validator` is not installed, either run from this workspace layout where `../claude-code-addons/scripts` exists, or set:

```bash
export E2E_CONTRACT_VALIDATOR_PYTHONPATH=/path/to/claude-code-addons/scripts
```

Generated artifacts under `.e2e/artifact.json` and `.e2e/evidence/` are ignored by git.
