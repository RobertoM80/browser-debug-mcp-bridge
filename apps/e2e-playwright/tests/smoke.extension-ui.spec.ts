import { expect, test, type Page } from '@playwright/test';
import {
  createTempDataDir,
  launchExtensionContext,
  openExtensionPage,
  sendRuntimeMessage,
  startHttpServer,
  type ExtensionContextHandle,
  type ManagedServerProcess,
} from './utils/runtime';

type RuntimeResponse =
  | { ok: true; state?: { isActive: boolean; sessionId: string | null }; config?: { allowlist: string[] } }
  | { ok: false; error: string };

test.describe('@smoke extension popup wiring', () => {
  let server: ManagedServerProcess | undefined;
  let extension: ExtensionContextHandle | undefined;
  let popupPage: Page | undefined;
  let targetPage: Page | undefined;

  test.beforeAll(async () => {
    server = await startHttpServer(createTempDataDir('bdmcp-e2e-smoke-ui-data-'));
    extension = await launchExtensionContext();
    targetPage = await extension.context.newPage();
    await targetPage.goto('http://127.0.0.1:8065/?e2e-smoke=1');
    popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
  });

  test.afterAll(async () => {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      if (server) {
        await server.stop();
      }
    }
  });

  test('popup controls render and config save is wired', async () => {
    if (!popupPage) {
      throw new Error('Test setup did not complete');
    }

    await expect(popupPage.locator('#start-session')).toBeVisible();
    await expect(popupPage.locator('#stop-session')).toBeVisible();
    await expect(popupPage.locator('#save-config')).toBeVisible();
    await expect(popupPage.locator('#refresh-session-tabs')).toBeVisible();

    await popupPage.fill('#allowlist-domains', '127.0.0.1');
    await popupPage.check('#snapshots-enabled');
    await popupPage.selectOption('#snapshot-mode', 'both');
    await popupPage.click('#save-config');

    await expect(popupPage.locator('#config-status')).toContainText(/Settings saved/i);

    const configResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_GET_CONFIG' });
    expect(configResponse.ok).toBe(true);
    if (configResponse.ok && configResponse.config) {
      expect(configResponse.config.allowlist).toContain('127.0.0.1');
    }
  });

  test('start and stop session buttons are connected to background runtime', async () => {
    if (!popupPage || !targetPage) {
      throw new Error('Test setup did not complete');
    }

    await popupPage.fill('#allowlist-domains', '127.0.0.1');
    await popupPage.click('#save-config');
    await expect(popupPage.locator('#config-status')).toContainText(/Settings saved/i);

    await targetPage.bringToFront();
    await popupPage.click('#start-session');
    await expect(popupPage.locator('#status')).toContainText(/Session active/i);
    await expect(popupPage.locator('#session-id')).not.toHaveText('-');

    const stateResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_GET_STATE' });
    expect(stateResponse.ok).toBe(true);
    if (stateResponse.ok && stateResponse.state) {
      expect(stateResponse.state.isActive).toBe(true);
      expect(stateResponse.state.sessionId).toBeTruthy();
    }

    await popupPage.click('#stop-session');
    await expect(popupPage.locator('#status')).toContainText(/No active session/i);
  });
});
