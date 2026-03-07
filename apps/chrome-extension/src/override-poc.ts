interface OverridePocServerConfig {
  enabled: boolean;
  targetAssetUrl: string;
  localFilePath: string;
  resolvedLocalFilePath: string;
  contentType: string;
  autoReload: boolean;
  configPath: string;
  fileExists: boolean;
  fileSizeBytes: number | null;
}

export interface OverridePocStatus {
  active: boolean;
  configuredEnabled: boolean;
  tabId?: number;
  targetAssetUrl?: string;
  localFilePath?: string;
  resolvedLocalFilePath?: string;
  contentType?: string;
  autoReload?: boolean;
  configPath?: string;
  fileExists?: boolean;
  fileSizeBytes?: number | null;
  matchedRequests: number;
  fulfilledRequests: number;
  lastMatchedAt?: number;
  lastFulfilledAt?: number;
  lastError?: string;
}

interface ActiveOverridePocRun extends OverridePocStatus {
  active: true;
  configuredEnabled: true;
  tabId: number;
  targetAssetUrl: string;
  localFilePath: string;
  resolvedLocalFilePath: string;
  contentType: string;
  autoReload: boolean;
  configPath: string;
  fileExists: boolean;
}

interface RequestPausedPayload {
  requestId?: string;
  request?: {
    url?: string;
  };
}

interface DebuggerHeader {
  name: string;
  value: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOverridePocConfig(value: unknown): OverridePocServerConfig {
  if (!isRecord(value)) {
    throw new Error('Override POC config response must be an object');
  }

  const requiredString = (fieldName: keyof OverridePocServerConfig): string => {
    const fieldValue = value[fieldName];
    if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
      throw new Error(`Override POC config field "${String(fieldName)}" is missing`);
    }
    return fieldValue.trim();
  };

  const requiredBoolean = (fieldName: keyof OverridePocServerConfig): boolean => {
    const fieldValue = value[fieldName];
    if (typeof fieldValue !== 'boolean') {
      throw new Error(`Override POC config field "${String(fieldName)}" must be a boolean`);
    }
    return fieldValue;
  };

  const fileSizeBytesValue = value.fileSizeBytes;
  if (fileSizeBytesValue !== null && (typeof fileSizeBytesValue !== 'number' || !Number.isFinite(fileSizeBytesValue))) {
    throw new Error('Override POC config field "fileSizeBytes" must be a finite number or null');
  }

  return {
    enabled: requiredBoolean('enabled'),
    targetAssetUrl: requiredString('targetAssetUrl'),
    localFilePath: requiredString('localFilePath'),
    resolvedLocalFilePath: requiredString('resolvedLocalFilePath'),
    contentType: requiredString('contentType'),
    autoReload: requiredBoolean('autoReload'),
    configPath: requiredString('configPath'),
    fileExists: requiredBoolean('fileExists'),
    fileSizeBytes: fileSizeBytesValue === null ? null : Math.floor(fileSizeBytesValue),
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response but received: ${text.slice(0, 200)}`);
  }
}

async function attachDebugger(source: chrome.debugger.Debuggee): Promise<void> {
  await chrome.debugger.attach(source, '1.3');
}

async function detachDebugger(source: chrome.debugger.Debuggee): Promise<void> {
  await chrome.debugger.detach(source);
}

async function sendDebuggerCommand<T = unknown>(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const result = await chrome.debugger.sendCommand(source, method, params);
  return result as T;
}

async function reloadTab(tabId: number, bypassCache: boolean): Promise<void> {
  await chrome.tabs.reload(tabId, { bypassCache });
}

export class OverridePocController {
  private readonly serverBaseUrl: string;
  private activeRun: ActiveOverridePocRun | null = null;
  private expectedDetachTabId: number | null = null;

  constructor(serverBaseUrl: string) {
    this.serverBaseUrl = serverBaseUrl;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      void this.handleDebuggerEvent(source, method, params).catch((error) => {
        this.recordError(asErrorMessage(error));
      });
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
      this.handleDebuggerDetach(source, reason);
    });
  }

  async getStatus(): Promise<OverridePocStatus> {
    try {
      const config = await this.fetchConfig();
      return this.composeStatus(config);
    } catch (error) {
      const fallback = this.activeRun;
      return {
        active: fallback !== null,
        configuredEnabled: fallback?.configuredEnabled ?? false,
        tabId: fallback?.tabId,
        targetAssetUrl: fallback?.targetAssetUrl,
        localFilePath: fallback?.localFilePath,
        resolvedLocalFilePath: fallback?.resolvedLocalFilePath,
        contentType: fallback?.contentType,
        autoReload: fallback?.autoReload,
        configPath: fallback?.configPath,
        fileExists: fallback?.fileExists,
        fileSizeBytes: fallback?.fileSizeBytes,
        matchedRequests: fallback?.matchedRequests ?? 0,
        fulfilledRequests: fallback?.fulfilledRequests ?? 0,
        lastMatchedAt: fallback?.lastMatchedAt,
        lastFulfilledAt: fallback?.lastFulfilledAt,
        lastError: asErrorMessage(error),
      };
    }
  }

  async enableForTab(tabId: number): Promise<OverridePocStatus> {
    const config = await this.fetchConfig();
    if (!config.enabled) {
      throw new Error(`Override POC is disabled in ${config.configPath}`);
    }
    if (!config.fileExists) {
      throw new Error(`Configured local file does not exist: ${config.resolvedLocalFilePath}`);
    }

    if (this.activeRun) {
      await this.disable();
    }

    const source: chrome.debugger.Debuggee = { tabId };

    try {
      await attachDebugger(source);
      await sendDebuggerCommand(source, 'Network.enable');
      await sendDebuggerCommand(source, 'Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      });
      await sendDebuggerCommand(source, 'Network.setCacheDisabled', { cacheDisabled: true });
      await sendDebuggerCommand(source, 'Network.setBypassServiceWorker', { bypass: true });
      await sendDebuggerCommand(source, 'Network.clearBrowserCache');

      this.activeRun = {
        active: true,
        configuredEnabled: true,
        tabId,
        targetAssetUrl: config.targetAssetUrl,
        localFilePath: config.localFilePath,
        resolvedLocalFilePath: config.resolvedLocalFilePath,
        contentType: config.contentType,
        autoReload: config.autoReload,
        configPath: config.configPath,
        fileExists: config.fileExists,
        fileSizeBytes: config.fileSizeBytes,
        matchedRequests: 0,
        fulfilledRequests: 0,
      };

      console.info('[mcpdbg][override-poc] debugger attached', {
        tabId,
        targetAssetUrl: config.targetAssetUrl,
        localFilePath: config.resolvedLocalFilePath,
      });

      if (config.autoReload) {
        await reloadTab(tabId, true);
      }

      return this.composeStatus(config);
    } catch (error) {
      const message = asErrorMessage(error);
      this.recordError(message);

      try {
        await detachDebugger(source);
      } catch {
        // Ignore cleanup errors after a failed attach/setup flow.
      }

      this.activeRun = null;
      throw new Error(message);
    }
  }

  async disable(): Promise<OverridePocStatus> {
    const previousRun = this.activeRun;
    if (!previousRun) {
      return this.getStatus();
    }

    const source: chrome.debugger.Debuggee = { tabId: previousRun.tabId };
    this.expectedDetachTabId = previousRun.tabId;

    try {
      await sendDebuggerCommand(source, 'Fetch.disable').catch(() => undefined);
      await sendDebuggerCommand(source, 'Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined);
      await sendDebuggerCommand(source, 'Network.setBypassServiceWorker', { bypass: false }).catch(() => undefined);
      await detachDebugger(source).catch(() => undefined);

      console.info('[mcpdbg][override-poc] debugger detached', {
        tabId: previousRun.tabId,
      });
    } finally {
      this.activeRun = null;
    }

    return this.getStatus();
  }

  private composeStatus(config: OverridePocServerConfig): OverridePocStatus {
    return {
      active: this.activeRun !== null,
      configuredEnabled: config.enabled,
      tabId: this.activeRun?.tabId,
      targetAssetUrl: config.targetAssetUrl,
      localFilePath: config.localFilePath,
      resolvedLocalFilePath: config.resolvedLocalFilePath,
      contentType: config.contentType,
      autoReload: config.autoReload,
      configPath: config.configPath,
      fileExists: config.fileExists,
      fileSizeBytes: config.fileSizeBytes,
      matchedRequests: this.activeRun?.matchedRequests ?? 0,
      fulfilledRequests: this.activeRun?.fulfilledRequests ?? 0,
      lastMatchedAt: this.activeRun?.lastMatchedAt,
      lastFulfilledAt: this.activeRun?.lastFulfilledAt,
      lastError: this.activeRun?.lastError,
    };
  }

  private async fetchConfig(): Promise<OverridePocServerConfig> {
    const response = await fetch(`${this.serverBaseUrl}/overrides/poc/config`, {
      cache: 'no-store',
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      const errorMessage = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : `Override POC config request failed with ${response.status}`;
      throw new Error(errorMessage);
    }

    if (!isRecord(payload) || payload.ok !== true) {
      throw new Error('Override POC config endpoint returned an invalid payload');
    }

    return parseOverridePocConfig(payload);
  }

  private async fetchOverrideBody(targetAssetUrl: string): Promise<{
    bodyBase64: string;
    responseHeaders: DebuggerHeader[];
  }> {
    const response = await fetch(
      `${this.serverBaseUrl}/overrides/poc/asset?assetUrl=${encodeURIComponent(targetAssetUrl)}`,
      {
        cache: 'no-store',
      },
    );

    if (!response.ok) {
      const payload = await readJsonResponse(response).catch(() => ({}));
      const errorMessage = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : `Override asset request failed with ${response.status}`;
      throw new Error(errorMessage);
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('Content-Type') ?? 'application/javascript; charset=utf-8';
    return {
      bodyBase64: arrayBufferToBase64(buffer),
      responseHeaders: [
        { name: 'Content-Type', value: contentType },
        { name: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
        { name: 'Content-Length', value: String(buffer.byteLength) },
        { name: 'X-BDMCP-Override-Poc', value: '1' },
      ],
    };
  }

  private async handleDebuggerEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params: unknown,
  ): Promise<void> {
    const activeRun = this.activeRun;
    if (!activeRun || method !== 'Fetch.requestPaused' || source.tabId !== activeRun.tabId) {
      return;
    }

    const payload = params as RequestPausedPayload | undefined;
    const requestId = payload?.requestId;
    const requestUrl = payload?.request?.url;
    if (typeof requestId !== 'string' || typeof requestUrl !== 'string') {
      return;
    }

    const debuggee: chrome.debugger.Debuggee = { tabId: activeRun.tabId };
    if (requestUrl !== activeRun.targetAssetUrl) {
      await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
      return;
    }

    activeRun.matchedRequests += 1;
    activeRun.lastMatchedAt = Date.now();
    console.info('[mcpdbg][override-poc] matched request', {
      tabId: activeRun.tabId,
      requestUrl,
      matchedRequests: activeRun.matchedRequests,
    });

    try {
      const overrideBody = await this.fetchOverrideBody(requestUrl);
      await sendDebuggerCommand(debuggee, 'Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responsePhrase: 'OK',
        responseHeaders: overrideBody.responseHeaders,
        body: overrideBody.bodyBase64,
      });
      activeRun.fulfilledRequests += 1;
      activeRun.lastFulfilledAt = Date.now();
      delete activeRun.lastError;

      console.info('[mcpdbg][override-poc] fulfilled request', {
        tabId: activeRun.tabId,
        requestUrl,
        fulfilledRequests: activeRun.fulfilledRequests,
      });
    } catch (error) {
      const message = asErrorMessage(error);
      this.recordError(message);
      console.error('[mcpdbg][override-poc] fulfill failed', {
        tabId: activeRun.tabId,
        requestUrl,
        error: message,
      });
      await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId }).catch(() => undefined);
    }
  }

  private handleDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (typeof source.tabId !== 'number') {
      return;
    }

    if (this.expectedDetachTabId === source.tabId) {
      this.expectedDetachTabId = null;
      return;
    }

    if (!this.activeRun || this.activeRun.tabId !== source.tabId) {
      return;
    }

    this.recordError(`Debugger detached unexpectedly: ${reason}`);
    console.warn('[mcpdbg][override-poc] debugger detached unexpectedly', {
      tabId: source.tabId,
      reason,
    });
    this.activeRun = null;
  }

  private recordError(message: string): void {
    if (this.activeRun) {
      this.activeRun.lastError = message;
    }
  }
}
