import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../../');

const read = (relativePath: string): string => {
  const absolutePath = resolve(root, relativePath);
  return readFileSync(absolutePath, 'utf8');
};

describe('project documentation', () => {
  it('should provide a root README with setup instructions', () => {
    const filePath = resolve(root, 'README.md');
    expect(existsSync(filePath)).toBe(true);

    const content = read('README.md');
    expect(content).toContain('## Quick start');
    expect(content).toContain('pnpm install');
    expect(content).toContain('pnpm nx serve mcp-server');
  });

  it('should document MCP tools with usage examples', () => {
    const filePath = resolve(root, 'docs/MCP_TOOLS.md');
    expect(existsSync(filePath)).toBe(true);

    const content = read('docs/MCP_TOOLS.md');
    expect(content).toContain('list_sessions');
    expect(content).toContain('get_dom_subtree');
    expect(content).toContain('explain_last_failure');
  });

  it('should include a root SECURITY document with privacy controls', () => {
    const filePath = resolve(root, 'SECURITY.md');
    expect(existsSync(filePath)).toBe(true);

    const content = read('SECURITY.md');
    expect(content).toContain('Safe mode is ON by default');
    expect(content).toContain('Domain allowlist is required');
    expect(content).toContain('redactionSummary');
  });

  it('should include troubleshooting and architecture decision docs', () => {
    const troubleshootingPath = resolve(root, 'docs/TROUBLESHOOTING.md');
    const architectureDecisionsPath = resolve(root, 'docs/ARCHITECTURE_DECISIONS.md');

    expect(existsSync(troubleshootingPath)).toBe(true);
    expect(existsSync(architectureDecisionsPath)).toBe(true);

    const troubleshootingContent = read('docs/TROUBLESHOOTING.md');
    const architectureDecisionsContent = read('docs/ARCHITECTURE_DECISIONS.md');

    expect(troubleshootingContent).toContain('## Extension cannot connect to server');
    expect(architectureDecisionsContent).toContain('## AD-003: Light telemetry always-on, heavy capture on-demand');
  });

  it('should include a Docusaurus documentation platform with core sections', () => {
    const docsProject = resolve(root, 'apps/docs/project.json');
    const docsConfig = resolve(root, 'apps/docs/docusaurus.config.ts');
    const docsIntro = resolve(root, 'apps/docs/docs/intro.md');
    const docsTools = resolve(root, 'apps/docs/docs/mcp-tools/overview.md');
    const docsSecurity = resolve(root, 'apps/docs/docs/security-privacy/controls.md');

    expect(existsSync(docsProject)).toBe(true);
    expect(existsSync(docsConfig)).toBe(true);
    expect(existsSync(docsIntro)).toBe(true);
    expect(existsSync(docsTools)).toBe(true);
    expect(existsSync(docsSecurity)).toBe(true);

    const introContent = read('apps/docs/docs/intro.md');
    const toolsContent = read('apps/docs/docs/mcp-tools/overview.md');
    const securityContent = read('apps/docs/docs/security-privacy/controls.md');

    expect(introContent).toContain('Browser Debug MCP Bridge Documentation');
    expect(toolsContent).toContain('V1 query tools');
    expect(securityContent).toContain('Safe mode is ON by default');
  });
});
