import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { getRuntimeDataDir } from '../runtime-paths.js';

export interface CliAuditEvent {
  command: string;
  args: string[];
  ok: boolean;
  durationMs: number;
  error?: string;
}

export function appendCliAuditEvent(event: CliAuditEvent): void {
  const path = join(getRuntimeDataDir(), 'cli-audit.ndjson');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    })}\n`,
    'utf8',
  );
}
