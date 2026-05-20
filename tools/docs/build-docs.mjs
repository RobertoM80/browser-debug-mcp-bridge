import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  DISABLE_UPDATE_NOTIFIER: '1',
};

const command = 'pnpm exec docusaurus build apps/docs --out-dir ../../dist/apps/docs';
const result = spawnSync(command, {
  stdio: 'inherit',
  shell: true,
  env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
