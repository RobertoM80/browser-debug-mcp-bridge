# Code Conventions

## Naming

| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `my-component.ts` |
| Classes | PascalCase | `MyClass` |
| Functions/variables | camelCase | `myFunction` |
| Constants | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |

## Code Style

Prettier is enforced with these settings:

- Single quotes
- Semicolons enabled
- Trailing commas (es5)
- Print width: 100
- Indent: 2 spaces
- Final newline: yes
- Trim trailing whitespace: yes

## Commands

```bash
# Check format
pnpm format:check

# Fix format
pnpm format:write

# Lint all
pnpm nx run-many -t lint

# Lint one project
pnpm nx lint <project>
```

## Error Handling & Logging

- Use `console.warn`/`console.error` for debugging
- Server: use Fastify's logger or pino
- Extension: prefix logs with `[mcpdbg]`
- Do not swallow errors; wrap with context or rethrow

## Adding New Code

- Keep changes minimal and aligned to existing patterns
- Ensure lint and format pass before pushing
