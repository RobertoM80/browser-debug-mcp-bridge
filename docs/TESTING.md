# Testing Guide

## Test Runner

Vitest is used across all projects.

## Commands

```bash
# Test all
pnpm nx run-many -t test

# Test one project
pnpm nx test <project>

# Test with coverage
pnpm nx test <project> --coverage

# Run single test file
pnpm nx test <project> --testPathPattern <path>

# Run test by name
pnpm nx test <project> --testNamePattern "<name>"
```

## Testing Patterns

- Integration tests for WebSocket ingest and MCP tool responses
- Coverage configured in individual project configs
- Update or add tests for new behavior
