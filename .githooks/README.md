# Local Git Hooks

Install once per clone:

```bash
pnpm hooks:install
```

This configures:
- `core.hooksPath=.githooks`

Active hooks:
- `pre-commit`: runs `pnpm typecheck`, `pnpm lint`, `pnpm test`

