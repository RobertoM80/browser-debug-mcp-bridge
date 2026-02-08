# TypeScript Standards

## Compiler Options

- `strict: true`
- `noImplicitReturns: true`
- `noFallthroughCasesInSwitch: true`

## Type Guidelines

- Prefer explicit types for public APIs and exported functions
- Avoid `any`. Use `unknown` and narrow when shape is not known

## Path Aliases

From `tsconfig.base.json`:

- `@browser-debug-mcp-bridge/shared`
- `@browser-debug-mcp-bridge/redaction`
- `@browser-debug-mcp-bridge/selectors`
- `@browser-debug-mcp-bridge/mcp-contracts`

Use relative imports only within the same package/module.

## Import Grouping

Keep imports organized:
1. External dependencies
2. Internal path aliases
3. Relative imports
