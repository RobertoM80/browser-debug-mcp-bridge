import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const root = process.cwd();
const files = [
  'apps/docs/docs/intro.md',
  'apps/docs/docs/getting-started/quick-start.md',
  'apps/docs/docs/getting-started/local-debug-session.md',
  'apps/docs/docs/architecture/overview.md',
  'apps/docs/docs/mcp-tools/overview.md',
  'apps/docs/docs/mcp-tools/v1-query-tools.md',
  'apps/docs/docs/mcp-tools/v2-heavy-capture.md',
  'apps/docs/docs/mcp-tools/v3-correlation.md',
  'apps/docs/docs/extension/overview.md',
  'apps/docs/docs/server/overview.md',
  'apps/docs/docs/security-privacy/controls.md',
  'apps/docs/docs/testing/strategy.md',
  'apps/docs/docs/troubleshooting/common-issues.md',
  'apps/docs/docs/faq.md',
  'apps/docs/docs/contributing/docs-contribution.md',
  'apps/docs/docs/contributing/versioning-strategy.md',
  'apps/docs/docs/workflows/failure-diagnosis-playbook.md',
  'apps/docs/docs/reference/limits-and-redaction.md'
];

const mdLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
const missing = [];

for (const relativeFile of files) {
  const absoluteFile = resolve(root, relativeFile);
  const source = readFileSync(absoluteFile, 'utf8');
  const base = dirname(absoluteFile);
  const matches = source.matchAll(mdLinkPattern);

  for (const match of matches) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('#')) {
      continue;
    }

    if (raw.startsWith('@site/') || raw.startsWith('@theme/')) {
      continue;
    }

    const withoutAnchor = raw.split('#')[0];
    const candidate = resolve(base, withoutAnchor);
    const withMd = candidate.endsWith('.md') || candidate.endsWith('.mdx') ? candidate : `${candidate}.md`;

    if (!existsSync(candidate) && !existsSync(withMd)) {
      missing.push(`${relativeFile}: ${raw}`);
    }
  }
}

if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error('Broken docs links:\n' + missing.join('\n'));
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log('Docs link check passed.');
