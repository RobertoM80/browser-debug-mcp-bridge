import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { startNextFixtureApp, type ManagedServerProcess } from './utils/runtime';

type CdpHeader = {
  name: string;
  value: string;
};

type FetchRequestPausedEvent = {
  requestId?: string;
  request?: {
    url?: string;
    method?: string;
  };
  responseStatusCode?: number;
  responseStatusText?: string;
  responseHeaders?: CdpHeader[];
};

type FetchGetResponseBodyResult = {
  body: string;
  base64Encoded?: boolean;
};

type ReplayMode =
  | 'continue-after-read'
  | 'fulfill-original-headers'
  | 'fulfill-minimal-headers'
  | 'fulfill-first-body-for-all-requests'
  | 'fulfill-patched-each-request'
  | 'fulfill-patched-first-body-for-all-requests';

type RscReplayProbeResult = {
  matchedCount: number;
  fulfilledCount: number;
  continuedCount: number;
  bodyBytes: number;
  patchMatchCount: number;
  finalUrl?: string;
  contentType?: string;
  responseStatusCode?: number;
};

type CapturedRscBody = {
  bodyBase64: string;
  bodyBytes: number;
  patchMatchCount: number;
  contentType?: string;
  finalUrl?: string;
};

type NavigationResult = {
  succeeded: boolean;
  pageErrors: string[];
  bodyText: string;
};

const RSC_REPLAY_TIMEOUT_MS = 15_000;
const PRODUCTS_RSC_PATH = '/products?_rsc=';
const RSC_TEXT_PATCHES = [
  ['Original debugging kits', 'Override debugging kits'],
  ['$129', '$049'],
] as const;

function headerValue(headers: CdpHeader[] | undefined, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return headers?.find((header) => header.name.toLowerCase() === normalizedName)?.value;
}

function decodedBodyBytes(body: FetchGetResponseBodyResult): number {
  if (body.base64Encoded === true) {
    return Buffer.from(body.body, 'base64').byteLength;
  }

  return Buffer.byteLength(body.body, 'utf8');
}

function fulfillBodyBase64(body: FetchGetResponseBodyResult): string {
  return body.base64Encoded === true
    ? body.body
    : Buffer.from(body.body, 'utf8').toString('base64');
}

function bodyText(body: FetchGetResponseBodyResult): string {
  return body.base64Encoded === true
    ? Buffer.from(body.body, 'base64').toString('utf8')
    : body.body;
}

function buildReplayBody(body: FetchGetResponseBodyResult, mode: ReplayMode): { bodyBase64: string; patchMatchCount: number } {
  if (mode !== 'fulfill-patched-each-request' && mode !== 'fulfill-patched-first-body-for-all-requests') {
    return {
      bodyBase64: fulfillBodyBase64(body),
      patchMatchCount: 0,
    };
  }

  let text = bodyText(body);
  let patchMatchCount = 0;
  for (const [search, replacement] of RSC_TEXT_PATCHES) {
    const matched = text.split(search).length - 1;
    patchMatchCount += matched;
    text = text.split(search).join(replacement);
  }

  return {
    bodyBase64: Buffer.from(text, 'utf8').toString('base64'),
    patchMatchCount,
  };
}

function sanitizeReplayHeaders(headers: CdpHeader[] | undefined, contentType: string | undefined): CdpHeader[] {
  const blockedHeaders = new Set([
    'connection',
    'content-encoding',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);
  const replayHeaders = (headers ?? []).filter((header) => !blockedHeaders.has(header.name.toLowerCase()));

  if (!replayHeaders.some((header) => header.name.toLowerCase() === 'content-type')) {
    replayHeaders.push({ name: 'Content-Type', value: contentType ?? 'text/x-component; charset=utf-8' });
  }

  return replayHeaders;
}

function minimalReplayHeaders(contentType: string | undefined): CdpHeader[] {
  return [
    { name: 'Content-Type', value: contentType ?? 'text/x-component; charset=utf-8' },
    { name: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
    { name: 'X-BDMCP-RSC-Replay-Probe', value: '1' },
  ];
}

async function waitForProductsNavigation(page: Page): Promise<NavigationResult> {
  const pageErrors: string[] = [];
  const onPageError = (error: Error) => {
    pageErrors.push(error.message);
  };
  page.on('pageerror', onPageError);

  try {
    const result = await Promise.race([
      page.locator('#products-headline').waitFor({ state: 'visible', timeout: RSC_REPLAY_TIMEOUT_MS }).then(() => 'visible' as const),
      page.waitForEvent('pageerror', { timeout: RSC_REPLAY_TIMEOUT_MS }).then((error) => {
        pageErrors.push(error.message);
        return 'pageerror' as const;
      }),
    ]).catch(() => 'timeout' as const);

    const bodyText = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
    return {
      succeeded: result === 'visible',
      pageErrors,
      bodyText,
    };
  } finally {
    page.off('pageerror', onPageError);
  }
}

async function clickProductsAndWait(page: Page): Promise<NavigationResult> {
  const navigationPromise = waitForProductsNavigation(page);
  await page.click('nav a[href="/products"]');
  return await navigationPromise;
}

async function installRscReplayProbe(page: Page, urlPrefix: string, mode: ReplayMode): Promise<{
  result: RscReplayProbeResult;
  dispose(): Promise<void>;
}> {
  const cdp = await page.context().newCDPSession(page);
  const result: RscReplayProbeResult = {
    matchedCount: 0,
    fulfilledCount: 0,
    continuedCount: 0,
    bodyBytes: 0,
    patchMatchCount: 0,
  };
  const pendingTasks = new Set<Promise<void>>();
  let firstReplayBody: Promise<{ bodyBase64: string; patchMatchCount: number }> | undefined;

  const continueRequest = async (requestId: string): Promise<void> => {
    await cdp.send('Fetch.continueRequest', { requestId });
    result.continuedCount += 1;
  };

  const handlePausedRequest = (event: FetchRequestPausedEvent): void => {
    const task = (async () => {
      const requestId = event.requestId;
      const requestUrl = event.request?.url;
      if (!requestId || !requestUrl) {
        return;
      }

      if (!requestUrl.startsWith(urlPrefix)) {
        await continueRequest(requestId);
        return;
      }

      result.matchedCount += 1;
      result.finalUrl = requestUrl;
      result.responseStatusCode = event.responseStatusCode;
      result.contentType = headerValue(event.responseHeaders, 'content-type');

      const body = await cdp.send<FetchGetResponseBodyResult>('Fetch.getResponseBody', { requestId });
      result.bodyBytes += decodedBodyBytes(body);
      if (!firstReplayBody) {
        firstReplayBody = Promise.resolve(buildReplayBody(body, mode));
      }

      if (mode === 'continue-after-read') {
        await continueRequest(requestId);
        return;
      }

      const replayBody = mode === 'fulfill-first-body-for-all-requests'
        || mode === 'fulfill-patched-first-body-for-all-requests'
        ? await firstReplayBody
        : buildReplayBody(body, mode);
      if (!replayBody) {
        throw new Error('RSC replay body was not prepared');
      }
      result.patchMatchCount += replayBody?.patchMatchCount ?? 0;

      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: event.responseStatusCode ?? 200,
        responsePhrase: event.responseStatusText ?? 'OK',
        responseHeaders: mode === 'fulfill-original-headers'
          ? sanitizeReplayHeaders(event.responseHeaders, result.contentType)
          : minimalReplayHeaders(result.contentType),
        body: replayBody.bodyBase64,
      });
      result.fulfilledCount += 1;
    })().catch(async () => {
      if (event.requestId) {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined);
      }
    }).finally(() => {
      pendingTasks.delete(task);
    });
    pendingTasks.add(task);
  };

  cdp.on('Fetch.requestPaused', handlePausedRequest);
  await cdp.send('Network.enable');
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Response' }],
  });
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });

  return {
    result,
    dispose: async () => {
      cdp.off('Fetch.requestPaused', handlePausedRequest);
      await Promise.allSettled(Array.from(pendingTasks));
      await cdp.send('Fetch.disable').catch(() => undefined);
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined);
      await cdp.send('Network.setBypassServiceWorker', { bypass: false }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}

async function runProductsRscReplayProbe(mode: ReplayMode, page: Page): Promise<{
  navigation: NavigationResult;
  probe: RscReplayProbeResult;
}> {
  let nextApp: ManagedServerProcess | undefined;
  let probe: Awaited<ReturnType<typeof installRscReplayProbe>> | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    await page.goto(`${nextBaseUrl}/`, { waitUntil: 'networkidle' });
    await expect(page.locator('#home-headline')).toHaveText('Original launch desk for field teams');

    probe = await installRscReplayProbe(page, `${nextBaseUrl}${PRODUCTS_RSC_PATH}`, mode);
    const navigation = await clickProductsAndWait(page);

    return {
      navigation,
      probe: probe.result,
    };
  } finally {
    try {
      if (probe) {
        await probe.dispose();
      }
    } finally {
      if (nextApp) {
        await nextApp.stop();
      }
    }
  }
}

async function captureFirstProductsRscBody(page: Page, nextBaseUrl: string, patched: boolean): Promise<CapturedRscBody> {
  const cdp = await page.context().newCDPSession(page);
  const urlPrefix = `${nextBaseUrl}${PRODUCTS_RSC_PATH}`;
  let captured: CapturedRscBody | undefined;
  const pendingTasks = new Set<Promise<void>>();

  const handlePausedRequest = (event: FetchRequestPausedEvent): void => {
    const task = (async () => {
      const requestId = event.requestId;
      const requestUrl = event.request?.url;
      if (!requestId || !requestUrl) {
        return;
      }

      if (!requestUrl.startsWith(urlPrefix)) {
        await cdp.send('Fetch.continueRequest', { requestId });
        return;
      }

      const body = await cdp.send<FetchGetResponseBodyResult>('Fetch.getResponseBody', { requestId });
      if (!captured) {
        const replayBody = buildReplayBody(body, patched ? 'fulfill-patched-each-request' : 'fulfill-minimal-headers');
        captured = {
          bodyBase64: replayBody.bodyBase64,
          bodyBytes: decodedBodyBytes(body),
          patchMatchCount: replayBody.patchMatchCount,
          contentType: headerValue(event.responseHeaders, 'content-type'),
          finalUrl: requestUrl,
        };
      }
      await cdp.send('Fetch.continueRequest', { requestId });
    })().catch(async () => {
      if (event.requestId) {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined);
      }
    }).finally(() => {
      pendingTasks.delete(task);
    });
    pendingTasks.add(task);
  };

  cdp.on('Fetch.requestPaused', handlePausedRequest);
  await cdp.send('Network.enable');
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Response' }],
  });

  try {
    await clickProductsAndWait(page);
    await Promise.allSettled(Array.from(pendingTasks));
    if (!captured) {
      throw new Error('No products RSC body was captured');
    }
    return captured;
  } finally {
    cdp.off('Fetch.requestPaused', handlePausedRequest);
    await Promise.allSettled(Array.from(pendingTasks));
    await cdp.send('Fetch.disable').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}

async function runProductsRscRequestStageFulfillProbe(patched: boolean, page: Page): Promise<{
  capture: CapturedRscBody;
  navigation: NavigationResult;
  probe: Pick<RscReplayProbeResult, 'matchedCount' | 'fulfilledCount'>;
}> {
  let nextApp: ManagedServerProcess | undefined;
  let cdp: CDPSession | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    await page.goto(`${nextBaseUrl}/`, { waitUntil: 'networkidle' });
    await expect(page.locator('#home-headline')).toHaveText('Original launch desk for field teams');

    const capture = await captureFirstProductsRscBody(page, nextBaseUrl, patched);
    await page.goto(`${nextBaseUrl}/`, { waitUntil: 'networkidle' });
    await expect(page.locator('#home-headline')).toHaveText('Original launch desk for field teams');

    const probe = {
      matchedCount: 0,
      fulfilledCount: 0,
    };
    const urlPrefix = `${nextBaseUrl}${PRODUCTS_RSC_PATH}`;
    cdp = await page.context().newCDPSession(page);
    cdp.on('Fetch.requestPaused', (event: FetchRequestPausedEvent) => {
      void (async () => {
        const requestId = event.requestId;
        const requestUrl = event.request?.url;
        if (!requestId || !requestUrl) {
          return;
        }

        if (!requestUrl.startsWith(urlPrefix)) {
          await cdp?.send('Fetch.continueRequest', { requestId });
          return;
        }

        probe.matchedCount += 1;
        await cdp?.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responsePhrase: 'OK',
          responseHeaders: minimalReplayHeaders(capture.contentType),
          body: capture.bodyBase64,
        });
        probe.fulfilledCount += 1;
      })().catch(async () => {
        if (event.requestId) {
          await cdp?.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined);
        }
      });
    });
    await cdp.send('Network.enable');
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });

    const navigation = await clickProductsAndWait(page);

    return {
      capture,
      navigation,
      probe,
    };
  } finally {
    try {
      if (cdp) {
        await cdp.send('Fetch.disable').catch(() => undefined);
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined);
        await cdp.send('Network.setBypassServiceWorker', { bypass: false }).catch(() => undefined);
        await cdp.detach().catch(() => undefined);
      }
    } finally {
      if (nextApp) {
        await nextApp.stop();
      }
    }
  }
}

test.describe('@full Next.js RSC replay investigation', () => {
  test('continues an inspected RSC flight response without breaking App Router navigation', async ({ page }) => {
    const { navigation, probe } = await runProductsRscReplayProbe('continue-after-read', page);

    expect(probe.matchedCount).toBeGreaterThanOrEqual(1);
    expect(probe.continuedCount).toBeGreaterThanOrEqual(1);
    expect(probe.fulfilledCount).toBe(0);
    expect(probe.finalUrl).toContain(PRODUCTS_RSC_PATH);
    expect(probe.contentType).toContain('text/x-component');
    expect(probe.bodyBytes).toBeGreaterThan(0);
    expect(navigation.pageErrors).toEqual([]);
    expect(navigation.succeeded).toBe(true);
    await expect(page.locator('#products-headline')).toHaveText('Original debugging kits');
  });

  test('replays an unmodified RSC flight response when original response headers are preserved', async ({ page }) => {
    const { navigation, probe } = await runProductsRscReplayProbe('fulfill-original-headers', page);

    expect(probe.matchedCount).toBeGreaterThanOrEqual(1);
    expect(probe.fulfilledCount).toBeGreaterThanOrEqual(1);
    expect(probe.finalUrl).toContain(PRODUCTS_RSC_PATH);
    expect(probe.contentType).toContain('text/x-component');
    expect(probe.bodyBytes).toBeGreaterThan(0);
    expect(navigation.pageErrors).toEqual([]);
    expect(navigation.succeeded).toBe(true);
    await expect(page.locator('#products-headline')).toHaveText('Original debugging kits');
  });

  test('replays an unmodified RSC flight response with minimal override headers when each request keeps its own body', async ({ page }) => {
    const { navigation, probe } = await runProductsRscReplayProbe('fulfill-minimal-headers', page);

    expect(probe.matchedCount).toBeGreaterThanOrEqual(1);
    expect(probe.fulfilledCount).toBeGreaterThanOrEqual(1);
    expect(probe.finalUrl).toContain(PRODUCTS_RSC_PATH);
    expect(probe.contentType).toContain('text/x-component');
    expect(probe.bodyBytes).toBeGreaterThan(0);
    expect(navigation.pageErrors).toEqual([]);
    expect(navigation.succeeded).toBe(true);
    await expect(page.locator('#products-headline')).toHaveText('Original debugging kits');
  });

  test('replays one unmodified RSC body for every prefix-matched request', async ({ page }) => {
    const { navigation, probe } = await runProductsRscReplayProbe('fulfill-first-body-for-all-requests', page);

    expect(probe.matchedCount).toBeGreaterThanOrEqual(2);
    expect(probe.fulfilledCount).toBeGreaterThanOrEqual(2);
    expect(probe.finalUrl).toContain(PRODUCTS_RSC_PATH);
    expect(probe.contentType).toContain('text/x-component');
    expect(probe.bodyBytes).toBeGreaterThan(0);
    expect(navigation.pageErrors).toEqual([]);
    expect(navigation.succeeded).toBe(true);
    await expect(page.locator('#products-headline')).toHaveText('Original debugging kits');
  });

  test('replays a literal-patched RSC flight response when each request keeps its own patched body', async ({ page }) => {
    const { navigation, probe } = await runProductsRscReplayProbe('fulfill-patched-each-request', page);

    expect(probe.matchedCount).toBeGreaterThanOrEqual(1);
    expect(probe.fulfilledCount).toBeGreaterThanOrEqual(1);
    expect(probe.finalUrl).toContain(PRODUCTS_RSC_PATH);
    expect(probe.contentType).toContain('text/x-component');
    expect(probe.bodyBytes).toBeGreaterThan(0);
    expect(probe.patchMatchCount).toBeGreaterThanOrEqual(RSC_TEXT_PATCHES.length);
    expect(navigation.pageErrors).toEqual([]);
    expect(navigation.succeeded).toBe(true);
    await expect(page.locator('#products-headline')).toHaveText('Override debugging kits');
    await expect(page.locator('#products-price')).toHaveText('$049');
  });

  test('replays one literal-patched RSC body for every prefix-matched request', async ({ page }) => {
    const { navigation, probe } = await runProductsRscReplayProbe('fulfill-patched-first-body-for-all-requests', page);

    expect(probe.matchedCount).toBeGreaterThanOrEqual(2);
    expect(probe.fulfilledCount).toBeGreaterThanOrEqual(2);
    expect(probe.finalUrl).toContain(PRODUCTS_RSC_PATH);
    expect(probe.contentType).toContain('text/x-component');
    expect(probe.bodyBytes).toBeGreaterThan(0);
    expect(probe.patchMatchCount).toBeGreaterThanOrEqual(RSC_TEXT_PATCHES.length);
    expect(navigation.pageErrors).toEqual([]);
    expect(navigation.succeeded).toBe(true);
    await expect(page.locator('#products-headline')).toHaveText('Override debugging kits');
    await expect(page.locator('#products-price')).toHaveText('$049');
  });

  test('fulfills a request-stage RSC request with a pre-captured patched body', async ({ page }) => {
    const { capture, navigation, probe } = await runProductsRscRequestStageFulfillProbe(true, page);

    expect(capture.finalUrl).toContain(PRODUCTS_RSC_PATH);
    expect(capture.contentType).toContain('text/x-component');
    expect(capture.bodyBytes).toBeGreaterThan(0);
    expect(capture.patchMatchCount).toBeGreaterThanOrEqual(RSC_TEXT_PATCHES.length);
    expect(probe.matchedCount).toBeGreaterThanOrEqual(1);
    expect(probe.fulfilledCount).toBeGreaterThanOrEqual(1);
    expect(navigation.pageErrors).toEqual([]);
    expect(navigation.succeeded).toBe(true);
    await expect(page.locator('#products-headline')).toHaveText('Override debugging kits');
    await expect(page.locator('#products-price')).toHaveText('$049');
  });
});
