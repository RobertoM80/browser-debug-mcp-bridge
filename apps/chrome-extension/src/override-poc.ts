import {
  type OverridePocFailureCode,
  type OverridePocRequestRecord,
  type OverridePocRunRecord,
  type OverridePocRunStatus,
} from '../../../libs/shared/src';

interface OverridePocServerRuleConfig {
  ruleId: string;
  enabled: boolean;
  targetAssetUrl: string;
  localFilePath: string;
  resolvedLocalFilePath: string;
  contentType: string;
  fileExists: boolean;
  fileSizeBytes: number | null;
}

interface OverridePocServerConfig {
  enabled: boolean;
  activeProfileId?: string;
  profileId?: string;
  profileName?: string;
  rules: OverridePocServerRuleConfig[];
  ruleCount: number;
  enabledRuleCount: number;
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
  runId?: string;
  sessionId?: string;
  runStatus?: OverridePocRunStatus;
  startedAt?: number;
  endedAt?: number;
  selectedTabId?: number;
  tabId?: number;
  activeProfileId?: string;
  profileId?: string;
  profileName?: string;
  ruleCount?: number;
  enabledRuleCount?: number;
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
  lastErrorCode?: OverridePocFailureCode;
  lastError?: string;
  auditPendingRequests?: number;
  auditLastError?: string;
  auditLastErrorAt?: number;
}

interface ActiveOverridePocRun extends OverridePocStatus {
  active: true;
  configuredEnabled: true;
  runId: string;
  sessionId: string;
  runStatus: OverridePocRunStatus;
  startedAt: number;
  tabId: number;
  targetAssetUrl: string;
  localFilePath: string;
  resolvedLocalFilePath: string;
  contentType: string;
  autoReload: boolean;
  configPath: string;
  fileExists: boolean;
  rules: OverridePocServerRuleConfig[];
  ruleCount: number;
  enabledRuleCount: number;
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

interface AuditQueueEntry {
  path: string;
  body: unknown;
  attempts: number;
  nextAttemptAt: number;
}

const AUDIT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const MAX_AUDIT_QUEUE_SIZE = 100;

class OverridePocControllerError extends Error {
  readonly code: OverridePocFailureCode;

  constructor(code: OverridePocFailureCode, message: string) {
    super(message);
    this.code = code;
  }
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

function asOverridePocError(error: unknown, fallbackCode: OverridePocFailureCode = 'UNKNOWN'): OverridePocControllerError {
  if (error instanceof OverridePocControllerError) {
    return error;
  }

  return new OverridePocControllerError(fallbackCode, asErrorMessage(error));
}

function createRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `override-run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

  const parseRule = (entry: unknown, index: number): OverridePocServerRuleConfig => {
    if (!isRecord(entry)) {
      throw new Error(`Override POC config rule at index ${index} must be an object`);
    }

    const ruleFileSizeBytes = entry.fileSizeBytes;
    if (ruleFileSizeBytes !== null && (typeof ruleFileSizeBytes !== 'number' || !Number.isFinite(ruleFileSizeBytes))) {
      throw new Error(`Override POC config rule at index ${index} field "fileSizeBytes" must be a finite number or null`);
    }

    const requiredRuleString = (fieldName: keyof OverridePocServerRuleConfig): string => {
      const fieldValue = entry[fieldName];
      if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
        throw new Error(`Override POC config rule at index ${index} field "${String(fieldName)}" is missing`);
      }
      return fieldValue.trim();
    };

    const enabledValue = entry.enabled;
    const fileExistsValue = entry.fileExists;
    if (typeof enabledValue !== 'boolean') {
      throw new Error(`Override POC config rule at index ${index} field "enabled" must be a boolean`);
    }
    if (typeof fileExistsValue !== 'boolean') {
      throw new Error(`Override POC config rule at index ${index} field "fileExists" must be a boolean`);
    }

    return {
      ruleId: requiredRuleString('ruleId'),
      enabled: enabledValue,
      targetAssetUrl: requiredRuleString('targetAssetUrl'),
      localFilePath: requiredRuleString('localFilePath'),
      resolvedLocalFilePath: requiredRuleString('resolvedLocalFilePath'),
      contentType: requiredRuleString('contentType'),
      fileExists: fileExistsValue,
      fileSizeBytes: ruleFileSizeBytes === null ? null : Math.floor(ruleFileSizeBytes),
    };
  };

  const rules = Array.isArray(value.rules)
    ? value.rules.map(parseRule)
    : [{
      ruleId: 'default',
      enabled: true,
      targetAssetUrl: requiredString('targetAssetUrl'),
      localFilePath: requiredString('localFilePath'),
      resolvedLocalFilePath: requiredString('resolvedLocalFilePath'),
      contentType: requiredString('contentType'),
      fileExists: requiredBoolean('fileExists'),
      fileSizeBytes: fileSizeBytesValue === null ? null : Math.floor(fileSizeBytesValue),
    }];

  if (rules.length === 0) {
    throw new Error('Override POC config must define at least one rule');
  }

  return {
    enabled: requiredBoolean('enabled'),
    activeProfileId: typeof value.activeProfileId === 'string' ? value.activeProfileId.trim() : undefined,
    profileId: typeof value.profileId === 'string' ? value.profileId.trim() : undefined,
    profileName: typeof value.profileName === 'string' ? value.profileName.trim() : undefined,
    rules,
    ruleCount: typeof value.ruleCount === 'number' && Number.isFinite(value.ruleCount)
      ? Math.floor(value.ruleCount)
      : rules.length,
    enabledRuleCount: typeof value.enabledRuleCount === 'number' && Number.isFinite(value.enabledRuleCount)
      ? Math.floor(value.enabledRuleCount)
      : rules.filter((rule) => rule.enabled).length,
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
  private serverBaseUrl: string;
  private activeRun: ActiveOverridePocRun | null = null;
  private expectedDetachTabId: number | null = null;
  private auditQueue: AuditQueueEntry[] = [];
  private auditFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private auditLastError: string | undefined;
  private auditLastErrorAt: number | undefined;

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

  setServerBaseUrl(serverBaseUrl: string): void {
    const trimmed = serverBaseUrl.trim();
    if (!trimmed || trimmed === this.serverBaseUrl) {
      return;
    }

    this.serverBaseUrl = trimmed;
  }

  getActiveTabId(): number | undefined {
    return this.activeRun?.tabId;
  }

  isActiveForTab(tabId: number): boolean {
    return this.activeRun?.tabId === tabId;
  }

  async getStatus(): Promise<OverridePocStatus> {
    this.scheduleAuditFlush(0);

    try {
      const config = await this.fetchConfig();
      return this.composeStatus(config);
    } catch (error) {
      const fallback = this.activeRun;
      return {
        active: fallback !== null,
        configuredEnabled: fallback?.configuredEnabled ?? false,
        runId: fallback?.runId,
        sessionId: fallback?.sessionId,
        runStatus: fallback?.runStatus,
        startedAt: fallback?.startedAt,
        endedAt: fallback?.endedAt,
        tabId: fallback?.tabId,
        activeProfileId: fallback?.activeProfileId,
        profileId: fallback?.profileId,
        profileName: fallback?.profileName,
        ruleCount: fallback?.ruleCount,
        enabledRuleCount: fallback?.enabledRuleCount,
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
        lastErrorCode: fallback?.lastErrorCode,
        lastError: asErrorMessage(error),
        ...this.getAuditStatusFields(),
      };
    }
  }

  async enableForTab(options: { sessionId: string; tabId: number; selectedTabId?: number }): Promise<OverridePocStatus> {
    const runId = createRunId();
    const startedAt = Date.now();
    const { sessionId, tabId, selectedTabId } = options;
    const config = await this.fetchConfig();
    if (!config.enabled) {
      const failure = new OverridePocControllerError('CONFIG_DISABLED', `Override POC is disabled in ${config.configPath}`);
      await this.persistTerminalRun({
        runId,
        sessionId,
        startedAt,
        tabId,
        selectedTabId,
        config,
        failure,
      });
      throw failure;
    }
    if (!config.fileExists) {
      const failure = new OverridePocControllerError('LOCAL_FILE_MISSING', `Configured local file does not exist: ${config.resolvedLocalFilePath}`);
      await this.persistTerminalRun({
        runId,
        sessionId,
        startedAt,
        tabId,
        selectedTabId,
        config,
        failure,
      });
      throw failure;
    }

    if (this.activeRun) {
      await this.disable();
    }

    const source: chrome.debugger.Debuggee = { tabId };

    try {
      try {
        await attachDebugger(source);
      } catch (error) {
        throw new OverridePocControllerError('DEBUGGER_ATTACH_FAILED', asErrorMessage(error));
      }

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
        runId,
        sessionId,
        runStatus: 'active',
        startedAt,
        selectedTabId,
        tabId,
        targetAssetUrl: config.targetAssetUrl,
        localFilePath: config.localFilePath,
        resolvedLocalFilePath: config.resolvedLocalFilePath,
        contentType: config.contentType,
        autoReload: config.autoReload,
        configPath: config.configPath,
        fileExists: config.fileExists,
        activeProfileId: config.activeProfileId,
        profileId: config.profileId,
        profileName: config.profileName,
        rules: config.rules,
        ruleCount: config.ruleCount,
        enabledRuleCount: config.enabledRuleCount,
        fileSizeBytes: config.fileSizeBytes,
        matchedRequests: 0,
        fulfilledRequests: 0,
      };

      await this.persistRun(this.activeRun);

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
      const failure = asOverridePocError(error, 'DEBUGGER_SETUP_FAILED');
      this.recordError(failure.message, failure.code);

      try {
        await detachDebugger(source);
      } catch {
        // Ignore cleanup errors after a failed attach/setup flow.
      }

      await this.persistTerminalRun({
        runId,
        sessionId,
        startedAt,
        tabId,
        selectedTabId,
        config,
        failure,
      });
      this.activeRun = null;
      throw failure;
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
      await this.persistRun({
        ...previousRun,
        endedAt: Date.now(),
        runStatus: previousRun.lastErrorCode ? 'failed' : 'disabled',
      });
    }

    return this.getStatus();
  }

  private composeStatus(config: OverridePocServerConfig): OverridePocStatus {
    return {
      active: this.activeRun !== null,
      configuredEnabled: config.enabled,
      runId: this.activeRun?.runId,
      sessionId: this.activeRun?.sessionId,
      runStatus: this.activeRun?.runStatus,
      startedAt: this.activeRun?.startedAt,
      endedAt: this.activeRun?.endedAt,
      selectedTabId: this.activeRun?.selectedTabId,
      tabId: this.activeRun?.tabId,
      activeProfileId: config.activeProfileId,
      profileId: config.profileId,
      profileName: config.profileName,
      ruleCount: config.ruleCount,
      enabledRuleCount: config.enabledRuleCount,
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
      lastErrorCode: this.activeRun?.lastErrorCode,
      lastError: this.activeRun?.lastError,
      ...this.getAuditStatusFields(),
    };
  }

  private getAuditStatusFields(): Pick<OverridePocStatus, 'auditPendingRequests' | 'auditLastError' | 'auditLastErrorAt'> {
    return {
      auditPendingRequests: this.auditQueue.length,
      auditLastError: this.auditLastError,
      auditLastErrorAt: this.auditLastErrorAt,
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
    const matchedRule = activeRun.rules.find((rule) => rule.enabled && requestUrl === rule.targetAssetUrl);
    if (!matchedRule) {
      await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
      return;
    }

    activeRun.matchedRequests += 1;
    activeRun.lastMatchedAt = Date.now();
    const requestLogId = `${activeRun.runId}:${requestId}`;
    void this.persistRequest({
      requestLogId,
      runId: activeRun.runId,
      sessionId: activeRun.sessionId,
      requestId,
      timestamp: activeRun.lastMatchedAt,
      requestUrl,
      status: 'matched',
    });
    void this.persistRun(activeRun);
    console.info('[mcpdbg][override-poc] matched request', {
      tabId: activeRun.tabId,
      ruleId: matchedRule.ruleId,
      requestUrl,
      matchedRequests: activeRun.matchedRequests,
    });

    try {
      let overrideBody: Awaited<ReturnType<OverridePocController['fetchOverrideBody']>>;
      try {
        overrideBody = await this.fetchOverrideBody(matchedRule.targetAssetUrl);
      } catch (error) {
        const failure = asOverridePocError(error, 'OVERRIDE_ASSET_FETCH_FAILED');
        this.recordError(failure.message, failure.code);
        void this.persistRequest({
          requestLogId,
          runId: activeRun.runId,
          sessionId: activeRun.sessionId,
          requestId,
          timestamp: Date.now(),
          requestUrl,
          status: 'failed',
          failureCode: failure.code,
          errorMessage: failure.message,
        });
        void this.persistRun(activeRun);
        throw failure;
      }

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
      delete activeRun.lastErrorCode;
      void this.persistRequest({
        requestLogId,
        runId: activeRun.runId,
        sessionId: activeRun.sessionId,
        requestId,
        timestamp: activeRun.lastFulfilledAt,
        requestUrl,
        status: 'fulfilled',
        responseCode: 200,
      });
      void this.persistRun(activeRun);

      console.info('[mcpdbg][override-poc] fulfilled request', {
        tabId: activeRun.tabId,
        ruleId: matchedRule.ruleId,
        requestUrl,
        fulfilledRequests: activeRun.fulfilledRequests,
      });
    } catch (error) {
      const failure = asOverridePocError(error, 'FULFILL_FAILED');
      this.recordError(failure.message, failure.code);
      void this.persistRequest({
        requestLogId,
        runId: activeRun.runId,
        sessionId: activeRun.sessionId,
        requestId,
        timestamp: Date.now(),
        requestUrl,
        status: 'failed',
        failureCode: failure.code,
        errorMessage: failure.message,
      });
      void this.persistRun(activeRun);
      console.error('[mcpdbg][override-poc] fulfill failed', {
        tabId: activeRun.tabId,
        requestUrl,
        error: failure.message,
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

    this.recordError(`Debugger detached unexpectedly: ${reason}`, 'DEBUGGER_DETACHED');
    console.warn('[mcpdbg][override-poc] debugger detached unexpectedly', {
      tabId: source.tabId,
      reason,
    });
    const endedRun = {
      ...this.activeRun,
      active: false as const,
      endedAt: Date.now(),
      runStatus: 'failed' as const,
    };
    this.activeRun = null;
    void this.persistRun(endedRun);
  }

  private recordError(message: string, code: OverridePocFailureCode = 'UNKNOWN'): void {
    if (this.activeRun) {
      this.activeRun.lastError = message;
      this.activeRun.lastErrorCode = code;
    }
  }

  private toRunRecord(run: Pick<
    ActiveOverridePocRun,
    'runId'
    | 'sessionId'
    | 'startedAt'
    | 'endedAt'
    | 'runStatus'
    | 'tabId'
    | 'selectedTabId'
    | 'targetAssetUrl'
    | 'localFilePath'
    | 'resolvedLocalFilePath'
    | 'contentType'
    | 'autoReload'
    | 'configPath'
    | 'fileExists'
    | 'fileSizeBytes'
    | 'matchedRequests'
    | 'fulfilledRequests'
    | 'lastMatchedAt'
    | 'lastFulfilledAt'
    | 'lastErrorCode'
    | 'lastError'
  >): OverridePocRunRecord {
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      runStatus: run.runStatus,
      tabId: run.tabId,
      selectedTabId: run.selectedTabId ?? null,
      targetAssetUrl: run.targetAssetUrl,
      localFilePath: run.localFilePath,
      resolvedLocalFilePath: run.resolvedLocalFilePath,
      contentType: run.contentType,
      autoReload: run.autoReload,
      configPath: run.configPath,
      fileExists: run.fileExists,
      fileSizeBytes: run.fileSizeBytes,
      matchedRequests: run.matchedRequests,
      fulfilledRequests: run.fulfilledRequests,
      lastMatchedAt: run.lastMatchedAt ?? null,
      lastFulfilledAt: run.lastFulfilledAt ?? null,
      lastErrorCode: run.lastErrorCode ?? null,
      lastErrorMessage: run.lastError ?? null,
    };
  }

  private async postJson(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.serverBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const payload = await readJsonResponse(response).catch(() => ({}));
      const errorMessage = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : `Override audit request failed with ${response.status}`;
      throw new Error(errorMessage);
    }
  }

  private recordAuditError(error: unknown): void {
    this.auditLastError = asErrorMessage(error);
    this.auditLastErrorAt = Date.now();
  }

  private clearAuditErrorIfRecovered(): void {
    if (this.auditQueue.length > 0) {
      return;
    }

    this.auditLastError = undefined;
    this.auditLastErrorAt = undefined;
  }

  private enqueueAuditPost(path: string, body: unknown, error: unknown): void {
    this.recordAuditError(error);

    if (this.auditQueue.length >= MAX_AUDIT_QUEUE_SIZE) {
      this.auditQueue.shift();
    }

    this.auditQueue.push({
      path,
      body,
      attempts: 0,
      nextAttemptAt: Date.now() + AUDIT_RETRY_DELAYS_MS[0],
    });
    this.scheduleAuditFlush(AUDIT_RETRY_DELAYS_MS[0]);
  }

  private scheduleAuditFlush(delayMs: number): void {
    if (this.auditFlushTimer) {
      return;
    }

    this.auditFlushTimer = setTimeout(() => {
      this.auditFlushTimer = null;
      void this.flushAuditQueue();
    }, Math.max(0, delayMs));
  }

  private scheduleNextAuditFlush(): void {
    if (this.auditQueue.length === 0) {
      this.clearAuditErrorIfRecovered();
      return;
    }

    const nextAttemptAt = Math.min(...this.auditQueue.map((entry) => entry.nextAttemptAt));
    this.scheduleAuditFlush(Math.max(0, nextAttemptAt - Date.now()));
  }

  private async flushAuditQueue(): Promise<void> {
    if (this.auditQueue.length === 0) {
      this.clearAuditErrorIfRecovered();
      return;
    }

    const now = Date.now();
    const entries = this.auditQueue;
    this.auditQueue = [];

    for (const entry of entries) {
      if (entry.nextAttemptAt > now) {
        this.auditQueue.push(entry);
        continue;
      }

      try {
        await this.postJson(entry.path, entry.body);
      } catch (error) {
        const attempts = entry.attempts + 1;
        this.recordAuditError(error);

        if (attempts < AUDIT_RETRY_DELAYS_MS.length) {
          this.auditQueue.push({
            ...entry,
            attempts,
            nextAttemptAt: Date.now() + AUDIT_RETRY_DELAYS_MS[attempts],
          });
        } else {
          console.warn('[mcpdbg][override-poc] dropping audit record after retries', {
            path: entry.path,
            error: asErrorMessage(error),
          });
        }
      }
    }

    this.scheduleNextAuditFlush();
  }

  private async persistAuditPost(path: string, body: unknown): Promise<void> {
    try {
      await this.postJson(path, body);
      this.clearAuditErrorIfRecovered();
    } catch (error) {
      this.enqueueAuditPost(path, body, error);
      throw error;
    }
  }

  private async persistRun(run: Pick<
    ActiveOverridePocRun,
    'runId'
    | 'sessionId'
    | 'startedAt'
    | 'endedAt'
    | 'runStatus'
    | 'tabId'
    | 'selectedTabId'
    | 'targetAssetUrl'
    | 'localFilePath'
    | 'resolvedLocalFilePath'
    | 'contentType'
    | 'autoReload'
    | 'configPath'
    | 'fileExists'
    | 'fileSizeBytes'
    | 'matchedRequests'
    | 'fulfilledRequests'
    | 'lastMatchedAt'
    | 'lastFulfilledAt'
    | 'lastErrorCode'
    | 'lastError'
  >): Promise<void> {
    try {
      await this.persistAuditPost(
        `/sessions/${encodeURIComponent(run.sessionId)}/overrides/runs`,
        this.toRunRecord(run),
      );
    } catch (error) {
      console.warn('[mcpdbg][override-poc] failed to persist run audit', {
        runId: run.runId,
        error: asErrorMessage(error),
      });
    }
  }

  private async persistRequest(record: OverridePocRequestRecord): Promise<void> {
    try {
      await this.persistAuditPost(
        `/sessions/${encodeURIComponent(record.sessionId)}/overrides/requests`,
        record,
      );
    } catch (error) {
      console.warn('[mcpdbg][override-poc] failed to persist request audit', {
        runId: record.runId,
        requestLogId: record.requestLogId,
        error: asErrorMessage(error),
      });
    }
  }

  private async persistTerminalRun(options: {
    runId: string;
    sessionId: string;
    startedAt: number;
    tabId: number;
    selectedTabId?: number;
    config: OverridePocServerConfig;
    failure: OverridePocControllerError;
  }): Promise<void> {
    await this.persistRun({
      runId: options.runId,
      sessionId: options.sessionId,
      runStatus: 'failed',
      startedAt: options.startedAt,
      endedAt: Date.now(),
      selectedTabId: options.selectedTabId,
      tabId: options.tabId,
      targetAssetUrl: options.config.targetAssetUrl,
      localFilePath: options.config.localFilePath,
      resolvedLocalFilePath: options.config.resolvedLocalFilePath,
      contentType: options.config.contentType,
      autoReload: options.config.autoReload,
      configPath: options.config.configPath,
      fileExists: options.config.fileExists,
      fileSizeBytes: options.config.fileSizeBytes,
      matchedRequests: 0,
      fulfilledRequests: 0,
      lastErrorCode: options.failure.code,
      lastError: options.failure.message,
    });
  }
}
