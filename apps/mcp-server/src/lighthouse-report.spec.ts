import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, afterEach } from 'vitest';
import { initializeDatabase } from './db/migrations.js';
import {
  getLighthouseReport,
  getLighthouseReportAsset,
  listLighthouseReports,
  planLighthouseFixes,
  runLighthouseReport,
  type LighthouseRunner,
} from './lighthouse-report.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createDb(): Database.Database {
  const db = new Database(':memory:');
  initializeDatabase(db);
  db.prepare(`
    INSERT INTO sessions (
      session_id, created_at, last_seen_at, url_start, url_last
    ) VALUES (?, ?, ?, ?, ?)
  `).run('session-1', 1_000, 1_500, 'https://example.com/start', 'https://example.com/app');
  return db;
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bdmcp-lighthouse-'));
  tempDirs.push(dir);
  return dir;
}

function createRunner(): LighthouseRunner {
  return {
    async run(input) {
      return {
        lhr: {
          requestedUrl: input.url,
          finalDisplayedUrl: `${input.url}/final`,
          fetchTime: '2026-05-21T10:00:00.000Z',
          lighthouseVersion: '13.3.0',
          userAgent: 'Chrome',
          runWarnings: [],
          categories: {
            performance: {
              id: 'performance',
              title: 'Performance',
              score: 0.42,
              auditRefs: [
                { id: 'render-blocking-resources', weight: 10 },
                { id: 'unused-javascript', weight: 5 },
              ],
            },
          },
          audits: {
            'first-contentful-paint': {
              id: 'first-contentful-paint',
              title: 'First Contentful Paint',
              score: 0.8,
              displayValue: '2.0 s',
            },
            'render-blocking-resources': {
              id: 'render-blocking-resources',
              title: 'Eliminate render-blocking resources',
              score: 0,
              scoreDisplayMode: 'numeric',
              displayValue: '1,200 ms',
              details: {
                type: 'opportunity',
                overallSavingsMs: 1_200,
                items: [{ url: `${input.url}/styles.css` }],
              },
            },
            'unused-javascript': {
              id: 'unused-javascript',
              title: 'Reduce unused JavaScript',
              score: 0.4,
              scoreDisplayMode: 'numeric',
              displayValue: '180 KiB',
              details: {
                type: 'opportunity',
                overallSavingsBytes: 184_320,
                items: [{ url: `${input.url}/main.js` }],
              },
            },
          },
        },
        report: [
          JSON.stringify({ requestedUrl: input.url, categories: { performance: { score: 0.42 } } }),
          '<html><body>Lighthouse report</body></html>',
        ],
      };
    },
  };
}

describe('lighthouse reports', () => {
  it('persists a mocked Lighthouse report and reads artifacts', async () => {
    const db = createDb();
    const artifactDir = createTempDir();

    const report = await runLighthouseReport(db, {
      sessionId: 'session-1',
      artifactDir,
    }, createRunner());

    expect(report.status).toBe('succeeded');
    expect(report.requestedUrl).toBe('https://example.com/app');
    expect(report.finalUrl).toBe('https://example.com/app/final');
    expect(report.scores.performance).toBe(0.42);

    const stored = getLighthouseReport(db, report.reportId);
    expect(stored.reportId).toBe(report.reportId);
    expect(stored.jsonBytes).toBeGreaterThan(0);

    const asset = getLighthouseReportAsset(db, {
      reportId: report.reportId,
      asset: 'html',
      encoding: 'raw',
    });
    expect(asset.data).toContain('Lighthouse report');

    const listed = listLighthouseReports(db, { sessionId: 'session-1' });
    expect(listed.reports).toHaveLength(1);
    db.close();
  });

  it('creates prioritized fix plans from a stored Lighthouse report', async () => {
    const db = createDb();
    const projectRoot = createTempDir();
    mkdirSync(join(projectRoot, 'src', 'app', 'page'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'app', 'page', 'page.tsx'), 'export default function Page() { return null; }\n', 'utf8');
    writeFileSync(join(projectRoot, 'src', 'app', 'page', 'styles.css'), 'body { color: black; }\n', 'utf8');
    writeFileSync(join(projectRoot, 'src', 'app', 'page', 'main.js'), 'console.log("main");\n', 'utf8');
    const report = await runLighthouseReport(db, {
      url: 'https://example.com/page',
      artifactDir: createTempDir(),
    }, createRunner());

    const plan = planLighthouseFixes(db, {
      reportId: report.reportId,
      projectRoot,
      routePath: '/page',
    });

    expect(plan.itemCount).toBe(3);
    expect(plan.items[0]).toMatchObject({
      auditId: 'render-blocking-resources',
      priority: 'critical',
      resourceUrls: ['https://example.com/page/styles.css'],
      fixReadiness: 'source-located',
    });
    expect(plan.items[0].sourceCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: 'src/app/page/styles.css',
        matchType: 'resource-path',
      }),
    ]));
    expect(plan.priorityCounts.critical).toBe(1);
    expect(plan.priorityCounts.high).toBe(1);
    expect(plan.items.map((item) => item.auditId)).toContain('first-contentful-paint');
    expect(plan.summary.sourceContext).toMatchObject({
      routePath: '/page',
      scannedFileCount: 3,
    });
    db.close();
  });

  it('persists failed Lighthouse runs for later inspection', async () => {
    const db = createDb();
    const report = await runLighthouseReport(db, {
      url: 'https://example.com/fail',
      artifactDir: createTempDir(),
    }, {
      async run() {
        throw new Error('Chrome unavailable');
      },
    });

    expect(report.status).toBe('failed');
    expect(report.errorMessage).toBe('Chrome unavailable');
    expect(listLighthouseReports(db, { status: 'failed' }).reports).toHaveLength(1);
    db.close();
  });
});
