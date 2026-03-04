import { spawnSync } from 'node:child_process';

const child = spawnSync('pnpm nx run e2e-playwright:test --skipNxCache', {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    BDMCP_E2E_HEADED: '1',
  },
});

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}

process.exit(child.status ?? 1);
