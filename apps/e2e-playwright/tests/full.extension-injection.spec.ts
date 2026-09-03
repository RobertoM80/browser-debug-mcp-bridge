import { expect, test, type Page } from '@playwright/test';
import {
  getServerBaseUrl,
  launchExtensionContext,
  startNextFixtureApp,
  type ExtensionContextHandle,
  type ManagedServerProcess,
} from './utils/runtime';

test.describe('@full @issue53 page-world injection', () => {
  let app: ManagedServerProcess | undefined;
  let extension: ExtensionContextHandle | undefined;
  let page: Page | undefined;

  test.beforeAll(async () => {
    app = await startNextFixtureApp();
    extension = await launchExtensionContext();
    page = await extension.context.newPage();
  });

  test.afterAll(async () => {
    try {
      await extension?.close();
    } finally {
      await app?.stop();
    }
  });

  test('is hydration-safe and can be evaluated again on the same document', async () => {
    if (!app || !extension || !page) {
      throw new Error('Test setup did not complete');
    }

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(getServerBaseUrl(app.port), { waitUntil: 'networkidle' });

    await page.evaluate(async (scriptUrl) => {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = scriptUrl;
        script.onload = () => {
          script.remove();
          resolve();
        };
        script.onerror = () => {
          script.remove();
          reject(new Error('Injected script did not load'));
        };
        document.documentElement.appendChild(script);
      });
    }, `chrome-extension://${extension.extensionId}/injected-script.js`);

    await page.waitForTimeout(100);

    expect.soft(await page.locator('html').getAttribute('data-bdmcp-injected')).toBeNull();
    expect.soft(pageErrors).not.toContainEqual(expect.stringMatching(/Identifier '.+' has already been declared/));
  });
});
