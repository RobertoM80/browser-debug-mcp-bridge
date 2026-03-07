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
  | {
      ok: true;
      config?: {
        automation?: {
          enabled?: boolean;
          allowSensitiveFields?: boolean;
        };
      };
    }
  | { ok: false; error: string };

test.describe('@full extension popup and db-viewer controls', () => {
  let server: ManagedServerProcess | undefined;
  let extension: ExtensionContextHandle | undefined;
  let popupPage: Page | undefined;
  let targetPage: Page | undefined;

  test.beforeAll(async () => {
    server = await startHttpServer(createTempDataDir('bdmcp-e2e-full-ui-data-'));
    extension = await launchExtensionContext();
    targetPage = await extension.context.newPage();
    await targetPage.goto('http://127.0.0.1:8065/?e2e-ui=1');
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

  test('settings, retention, tab binding, transfer, and danger-zone controls are wired', async () => {
    if (!popupPage || !targetPage || !extension) {
      throw new Error('Test setup did not complete');
    }

    await popupPage.fill('#allowlist-domains', '127.0.0.1');
    await popupPage.uncheck('#safe-mode');
    await popupPage.check('#snapshots-enabled');
    await popupPage.check('#automation-enabled');
    await popupPage.selectOption('#snapshot-mode', 'both');
    await popupPage.selectOption('#snapshot-style-mode', 'computed-full');
    await popupPage.check('#snapshot-trigger-navigation');
    await popupPage.check('#snapshot-trigger-error');
    await popupPage.fill('#snapshot-max-images', '5');
    await popupPage.fill('#snapshot-max-bytes', '131072');
    await popupPage.fill('#snapshot-min-interval', '1000');
    await popupPage.click('#save-config');
    await expect(popupPage.locator('#config-status')).toContainText(/Settings saved/i);
    await expect(popupPage.locator('#automation-status')).toContainText(/Sensitive-field actions remain blocked/i);

    const configResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_GET_CONFIG' });
    expect(configResponse.ok).toBe(true);
    if (configResponse.ok && configResponse.config?.automation) {
      expect(configResponse.config.automation.enabled).toBe(true);
      expect(configResponse.config.automation.allowSensitiveFields).toBe(false);
    }

    await targetPage.bringToFront();
    await popupPage.click('#start-session');
    await expect(popupPage.locator('#status')).toContainText(/Session active/i);

    await popupPage.click('#refresh-session-tabs');
    await expect(popupPage.locator('#session-base-origin')).toContainText(/Base origin:/i);

    const toggledTab = await popupPage.evaluate(() => {
      const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('#session-tabs-list input.session-tab-checkbox'));
      const unchecked = checkboxes.find((checkbox) => !checkbox.checked);
      if (!unchecked) {
        return false;
      }
      unchecked.click();
      return true;
    });
    if (toggledTab) {
      await popupPage.click('#refresh-session-tabs');
      await expect(popupPage.locator('#session-base-origin')).toContainText(/Bound tabs:/i);
    }

    const retentionPanel = popupPage.locator('details.retention-settings');
    if (!(await retentionPanel.evaluate((node) => (node as HTMLDetailsElement).open))) {
      await popupPage.locator('details.retention-settings > summary').click();
    }

    await popupPage.fill('#retention-days', '31');
    await popupPage.fill('#max-db-mb', '512');
    await popupPage.fill('#max-sessions', '5000');
    await popupPage.click('#save-retention');
    await expect(popupPage.locator('#retention-status')).toContainText(/Retention settings saved/i);

    await popupPage.click('#run-cleanup-now');
    await expect(popupPage.locator('#retention-status')).toContainText(/cleanup/i);

    await popupPage.click('#pin-session');
    await expect(popupPage.locator('#retention-status')).toContainText(/pinned/i);

    await popupPage.click('#unpin-session');
    await expect(popupPage.locator('#retention-status')).toContainText(/unpinned/i);

    await popupPage.click('#export-session');
    await expect(popupPage.locator('#retention-status')).toContainText(/Exported/i);

    await popupPage.click('#import-session');
    await expect(popupPage.locator('#retention-status')).toContainText(/Choose an exported JSON file first/i);

    const dbViewerPromise = extension.context.waitForEvent('page');
    await popupPage.click('#show-db-entries');
    const dbViewer = await dbViewerPromise;
    await dbViewer.waitForLoadState('domcontentloaded');
    await expect(dbViewer).toHaveURL(/db-viewer\.html/);
    await expect(dbViewer.locator('#entries-status')).toContainText(/Showing|No DB entries yet|Loading/i);

    await popupPage.click('#stop-session');
    await expect(popupPage.locator('#status')).toContainText(/No active session/i);

    await popupPage.click('#automation-emergency-stop');
    await expect(popupPage.locator('#automation-status')).toContainText(/Live automation is off/i);

    const dangerPanel = popupPage.locator('details.danger-zone');
    if (!(await dangerPanel.evaluate((node) => (node as HTMLDetailsElement).open))) {
      await popupPage.locator('details.danger-zone > summary').click();
    }

    await popupPage.click('#reset-db');
    await expect(popupPage.locator('#reset-confirm-modal')).toBeVisible();
    await popupPage.click('#reset-confirm-cancel');

    await popupPage.click('#reset-db');
    await popupPage.click('#reset-confirm-yes');
    await expect(popupPage.locator('#reset-db-status')).toContainText(/Database reset successfully/i);

    await dbViewer.close();
  });
});
