# Local Git Hooks

Install once per clone:

```bash
pnpm hooks:install
```

This configures:
- `core.hooksPath=.githooks`
- `commit.template=.gitmessage.txt`

Active hooks:
- `pre-commit`: runs `pnpm lint` and `pnpm test:non-e2e` (with `NX_TUI=false`)
- `commit-msg`: enforces Conventional Commit subject format

Notes:
- Playwright E2E suites are intentionally not in pre-commit (run in CI and manually via `pnpm test:e2e:smoke` / `pnpm test:e2e:full`).
