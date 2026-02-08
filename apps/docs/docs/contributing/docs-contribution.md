# Contributing Documentation

## Authoring standards

- Prefer task-oriented pages and concrete command examples
- Keep terminology consistent: session, light telemetry, heavy capture, redaction
- Link related pages instead of duplicating long sections

## Templates and review checklist

When adding a page, include:

1. Purpose and audience
2. Preconditions
3. Step-by-step procedure
4. Verification section
5. Related links

Review checklist:

- Internal links valid
- Commands copy-paste cleanly
- Limits and privacy notes included where applicable
- Page appears in generated sidebar section

## Release update process

- Update docs with behavior changes in same PR as code
- Run `pnpm docs:ci` before merge
- Tag release notes with affected sections
