# Contributing

Thank you for taking an interest in Anticlus. Issues and pull requests are welcome.

## Setting up

Requires Node 22 or later and pnpm.

```bash
pnpm install
pnpm test          # the test suite
pnpm typecheck     # tsc --noEmit
pnpm build         # compiles to dist/
pnpm example       # the supplier-bank-change walkthrough
```

The Python client lives in `clients/python` and has its own tests:

```bash
pip install -e "clients/python[dev]"
pytest -q clients/python
```

Two tests run every scenario through the gateway and can print a result table. It is hidden by default
because the built-in keyword scorer has documented gaps and the `FAIL` rows confuse newcomers; the
assertions that matter are the ones in the test. To see the table:

```bash
ANTICLUS_SHOW_SCOREBOARD=1 pnpm test
```

## Making a change

- Open an issue first for anything that changes the decision order, the grant format, the HTTP API or the
  MFA signature scheme. Those are what operators depend on.
- Add or update a test with the change. The suite runs in CI on every pull request, together with
  typecheck and build.
- Keep the README and `docs/` in step with the behaviour. If a limit listed under *Security model and
  limits* changes, change the list.
- The benchmark audio and result tables are not in this repository; they live in `anticlus-eval`. Do not
  add media files here.

## Reporting a security problem

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0, the licence of
this repository.
