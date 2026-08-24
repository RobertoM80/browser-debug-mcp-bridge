import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSkillInstructions } from './agent-instructions';
import {
  getBaseUrl,
  getCliErrorGuidance,
  isLiveSession,
  parseArgs,
  parseJsonObject,
  parseToolArguments,
  run,
  withCommonLimits,
} from './main';

describe('bdmcp CLI parsing', () => {
  it('tells agents which package installs bdmcp before using it', () => {
    const instructions = getSkillInstructions();

    expect(instructions).toContain('bdmcp --help');
    expect(instructions).toContain('npm i -g browser-debug-mcp-bridge');
    expect(instructions.indexOf('npm i -g browser-debug-mcp-bridge')).toBeLessThan(instructions.indexOf('bdmcp health'));
    expect(instructions).toContain('node scripts/browser-debug-cli.cjs');
  });

  it('parses command words and long options', () => {
    const parsed = parseArgs(['tool', 'run', 'list_sessions', '--json-args', '{"limit":10}', '--json']);

    expect(parsed.command).toEqual(['tool', 'run', 'list_sessions']);
    expect(parsed.options['json-args']).toBe('{"limit":10}');
    expect(parsed.options.json).toBe(true);
  });

  it('resolves bridge base URL from options', () => {
    expect(getBaseUrl({ port: '9876' })).toBe('http://127.0.0.1:9876');
    expect(getBaseUrl({ 'base-url': 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000');
  });

  it('parses JSON object arguments and common limits', () => {
    expect(parseJsonObject('{"limit":5}', 'args')).toEqual({ limit: 5 });
    expect(withCommonLimits({ sessionId: 's1' }, { limit: '3', 'max-bytes': '1024' })).toEqual({
      sessionId: 's1',
      limit: 3,
      maxResponseBytes: 1024,
    });
  });

  it('reads tool arguments from --args-file without dropping numeric values', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'bdmcp-cli-'));
    const argsFile = join(tempRoot, 'args.json');
    writeFileSync(argsFile, JSON.stringify({
      sessionId: 'sess-1',
      targetUrl: 'https://example.com/products',
      maxBodyBytes: 2_000_000,
    }), 'utf8');

    expect(parseToolArguments({ 'args-file': argsFile })).toEqual({
      sessionId: 'sess-1',
      targetUrl: 'https://example.com/products',
      maxBodyBytes: 2_000_000,
    });
  });

  it('recognizes live sessions from list_sessions metadata', () => {
    expect(isLiveSession({ liveConnection: { connected: true } })).toBe(true);
    expect(isLiveSession({ liveConnection: { connected: false } })).toBe(false);
    expect(isLiveSession({})).toBe(false);
  });

  it('diagnoses a healthy legacy bridge that does not expose CLI routes', async () => {
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/health') {
        response.end(JSON.stringify({ status: 'ok', database: 'connected' }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ statusCode: 404, error: 'Not Found' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not expose a TCP port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      let cliError: unknown;
      try {
        await run(parseArgs(['tool', 'list', '--base-url', baseUrl]));
      } catch (error) {
        cliError = error;
      }

      expect(cliError).toBeInstanceOf(Error);
      await expect(getCliErrorGuidance(baseUrl, cliError)).resolves.toContain(
        'running bridge is healthy but does not expose the CLI API',
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('keeps startup guidance for failures that are not CLI route mismatches', async () => {
    await expect(getCliErrorGuidance('http://127.0.0.1:8065', new Error('connection refused')))
      .resolves.toContain('If the bridge is not running');
  });
});
