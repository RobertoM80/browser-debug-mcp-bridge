# Documentation Versioning Strategy

Use Docusaurus versioned docs for release-level snapshots.

## Policy

- `current`: tracks main branch
- `v1`, `v2`, `v3`: immutable snapshots aligned to release milestones
- Patch releases update latest major snapshot and `current`

## Suggested commands

```bash
pnpm nx build docs
npx docusaurus docs:version v3 apps/docs
```

After versioning, update sidebars and release notes links as needed.
