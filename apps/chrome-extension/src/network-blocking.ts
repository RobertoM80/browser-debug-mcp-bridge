import {
  type NetworkBlockingFailureCode,
  type NetworkBlockingRequestRecord,
  type NetworkBlockingResourceType,
  type NetworkBlockingRule,
  type NetworkBlockingRunRecord,
  type NetworkBlockingRunStatus,
} from '../../../libs/shared/src';

interface RequestPausedPayload {
  requestId?: string;
  frameId?: string;
  resourceType?: string;
  request?: {
    url?: string;
    method?: string;
  };
}

export interface NetworkBlockingStatus {
  active: boolean;
  runId?: string;
  sessionId?: string;
  runStatus?: NetworkBlockingRunStatus;
  startedAt?: number;
  endedAt?: number;
  tabId?: number;
  selectedTabId?: number;
  ruleCount: number;
  blockedRequests: number;
  lastBlockedAt?: number;
  lastErrorCode?: NetworkBlockingFailureCode;
  lastError?: string;
  rules: NetworkBlockingRule[];
}

interface ActiveNetworkBlockingRun extends NetworkBlockingStatus {
  active: true;
  runId: string;
  sessionId: string;
  runStatus: NetworkBlockingRunStatus;
  startedAt: number;
  tabId: number;
  clearCache: boolean;
  bypassServiceWorker: boolean;
}

type PersistableNetworkBlockingRun = Pick<
  NetworkBlockingStatus,
  'active'
  | 'runId'
  | 'sessionId'
  | 'startedAt'
  | 'endedAt'
  | 'runStatus'
  | 'tabId'
  | 'selectedTabId'
  | 'ruleCount'
  | 'blockedRequests'
  | 'lastBlockedAt'
  | 'lastErrorCode'
  | 'lastError'
  | 'rules'
>;

class NetworkBlockingControllerError extends Error {
  readonly code: NetworkBlockingFailureCode;

  constructor(code: NetworkBlockingFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asNetworkBlockingError(
  error: unknown,
  fallbackCode: NetworkBlockingFailureCode = 'UNKNOWN',
): NetworkBlockingControllerError {
  return error instanceof NetworkBlockingControllerError
    ? error
    : new NetworkBlockingControllerError(fallbackCode, asErrorMessage(error));
}

function createRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `network-block-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeMethod(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toUpperCase() : 'GET';
}

function normalizeResourceType(value: unknown): NetworkBlockingResourceType {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'document') {
    return 'document';
  }
  if (normalized === 'script') {
    return 'script';
  }
  if (normalized === 'xhr') {
    return 'xhr';
  }
  if (normalized === 'fetch') {
    return 'fetch';
  }
  if (normalized === 'image') {
    return 'image';
  }
  if (normalized === 'stylesheet') {
    return 'stylesheet';
  }
  if (normalized === 'font') {
    return 'font';
  }
  if (normalized === 'media') {
    return 'media';
  }
  if (normalized === 'websocket') {
    return 'websocket';
  }
  return 'other';
}

function normalizeFrameId(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

function doesRuleMatchUrl(rule: NetworkBlockingRule, requestUrl: string): boolean {
  if (rule.exactUrl && requestUrl === rule.exactUrl) {
    return true;
  }
  if (rule.urlContains && requestUrl.includes(rule.urlContains)) {
    return true;
  }
  if (rule.urlRegex) {
    try {
      return new RegExp(rule.urlRegex).test(requestUrl);
    } catch {
      return false;
    }
  }
  return false;
}

function findMatchingRule(
  rules: NetworkBlockingRule[],
  requestUrl: string,
  requestMethod: string,
  resourceType: NetworkBlockingResourceType,
): NetworkBlockingRule | undefined {
  return rules.find((rule) => {
    return rule.enabled
      && (!rule.method || normalizeMethod(rule.method) === requestMethod)
      && (!rule.resourceTypes || rule.resourceTypes.includes(resourceType))
      && doesRuleMatchUrl(rule, requestUrl);
  });
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

async function sendRequiredDebuggerCommand<T = unknown>(
  source: chrome.debugger.Debuggee,
  method: string,
  failureCode: NetworkBlockingFailureCode,
  params?: Record<string, unknown>,
): Promise<T> {
  try {
    return await sendDebuggerCommand<T>(source, method, params);
  } catch (error) {
    throw new NetworkBlockingControllerError(failureCode, `${method} failed: ${asErrorMessage(error)}`);
  }
}

async function reloadTab(tabId: number, bypassCache: boolean): Promise<void> {
  await chrome.tabs.reload(tabId, { bypassCache });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export class NetworkBlockingController {
  private serverBaseUrl: string;
  private activeRun: ActiveNetworkBlockingRun | null = null;
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

  setServerBaseUrl(serverBaseUrl: string): void {
    const trimmed = serverBaseUrl.trim();
    if (trimmed && trimmed !== this.serverBaseUrl) {
      this.serverBaseUrl = trimmed;
    }
  }

  isActiveForTab(tabId: number): boolean {
    return this.activeRun?.tabId === tabId;
  }

  getStatus(): NetworkBlockingStatus {
    return this.composeStatus();
  }

  async enableForTab(options: {
    sessionId: string;
    tabId: number;
    selectedTabId?: number;
    rules: NetworkBlockingRule[];
    reload?: boolean;
    clearCache?: boolean;
    bypassServiceWorker?: boolean;
  }): Promise<NetworkBlockingStatus> {
    const runId = createRunId();
    const startedAt = Date.now();
    const clearCache = options.clearCache !== false;
    const bypassServiceWorker = options.bypassServiceWorker !== false;
    const source: chrome.debugger.Debuggee = { tabId: options.tabId };

    if (this.activeRun) {
      await this.disable();
    }

    try {
      try {
        await attachDebugger(source);
      } catch (error) {
        throw new NetworkBlockingControllerError('DEBUGGER_ATTACH_FAILED', asErrorMessage(error));
      }

      await sendRequiredDebuggerCommand(source, 'Network.enable', 'NETWORK_ENABLE_FAILED');
      await sendRequiredDebuggerCommand(source, 'Fetch.enable', 'FETCH_ENABLE_FAILED', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      });
      if (clearCache) {
        await sendRequiredDebuggerCommand(source, 'Network.setCacheDisabled', 'CACHE_DISABLE_FAILED', { cacheDisabled: true });
        await sendDebuggerCommand(source, 'Network.clearBrowserCache').catch(() => undefined);
      }
      if (bypassServiceWorker) {
        await sendRequiredDebuggerCommand(source, 'Network.setBypassServiceWorker', 'SERVICE_WORKER_BYPASS_FAILED', { bypass: true });
      }

      this.activeRun = {
        active: true,
        runId,
        sessionId: options.sessionId,
        runStatus: 'active',
        startedAt,
        selectedTabId: options.selectedTabId,
        tabId: options.tabId,
        clearCache,
        bypassServiceWorker,
        ruleCount: options.rules.filter((rule) => rule.enabled).length,
        blockedRequests: 0,
        rules: options.rules,
      };
      await this.persistRun(this.activeRun);

      if (options.reload === true) {
        try {
          await reloadTab(options.tabId, true);
        } catch (error) {
          throw new NetworkBlockingControllerError('TAB_RELOAD_FAILED', asErrorMessage(error));
        }
      }

      return this.composeStatus();
    } catch (error) {
      const failure = asNetworkBlockingError(error, 'DEBUGGER_SETUP_FAILED');
      await sendDebuggerCommand(source, 'Fetch.disable').catch(() => undefined);
      if (clearCache) {
        await sendDebuggerCommand(source, 'Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined);
      }
      if (bypassServiceWorker) {
        await sendDebuggerCommand(source, 'Network.setBypassServiceWorker', { bypass: false }).catch(() => undefined);
      }
      this.expectedDetachTabId = options.tabId;
      await detachDebugger(source).catch(() => undefined);
      await this.persistRun({
        active: false,
        runId,
        sessionId: options.sessionId,
        runStatus: 'failed',
        startedAt,
        endedAt: Date.now(),
        selectedTabId: options.selectedTabId,
        tabId: options.tabId,
        ruleCount: options.rules.filter((rule) => rule.enabled).length,
        blockedRequests: 0,
        rules: options.rules,
        lastErrorCode: failure.code,
        lastError: failure.message,
      });
      this.activeRun = null;
      throw failure;
    }
  }

  async disable(): Promise<NetworkBlockingStatus> {
    const previousRun = this.activeRun;
    if (!previousRun) {
      return this.composeStatus();
    }

    const source: chrome.debugger.Debuggee = { tabId: previousRun.tabId };
    this.expectedDetachTabId = previousRun.tabId;
    try {
      await sendDebuggerCommand(source, 'Fetch.disable').catch(() => undefined);
      if (previousRun.clearCache) {
        await sendDebuggerCommand(source, 'Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined);
      }
      if (previousRun.bypassServiceWorker) {
        await sendDebuggerCommand(source, 'Network.setBypassServiceWorker', { bypass: false }).catch(() => undefined);
      }
      await detachDebugger(source).catch(() => undefined);
    } finally {
      this.activeRun = null;
      await this.persistRun({
        ...previousRun,
        active: false,
        endedAt: Date.now(),
        runStatus: previousRun.lastErrorCode ? 'failed' : 'disabled',
      });
    }

    return this.composeStatus();
  }

  private composeStatus(): NetworkBlockingStatus {
    const activeRun = this.activeRun;
    return {
      active: activeRun !== null,
      runId: activeRun?.runId,
      sessionId: activeRun?.sessionId,
      runStatus: activeRun?.runStatus,
      startedAt: activeRun?.startedAt,
      selectedTabId: activeRun?.selectedTabId,
      tabId: activeRun?.tabId,
      ruleCount: activeRun?.ruleCount ?? 0,
      blockedRequests: activeRun?.blockedRequests ?? 0,
      lastBlockedAt: activeRun?.lastBlockedAt,
      lastErrorCode: activeRun?.lastErrorCode,
      lastError: activeRun?.lastError,
      rules: activeRun?.rules ?? [],
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

    const requestMethod = normalizeMethod(payload?.request?.method);
    const resourceType = normalizeResourceType(payload?.resourceType);
    const matchedRule = findMatchingRule(activeRun.rules, requestUrl, requestMethod, resourceType);
    const debuggee: chrome.debugger.Debuggee = { tabId: activeRun.tabId };

    if (!matchedRule) {
      await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
      return;
    }

    try {
      await sendDebuggerCommand(debuggee, 'Fetch.failRequest', {
        requestId,
        errorReason: matchedRule.errorReason,
      });
      this.recordBlockedRequest(activeRun, {
        requestId,
        requestUrl,
        requestMethod,
        resourceType,
        frameId: normalizeFrameId(payload?.frameId),
        rule: matchedRule,
      });
    } catch (error) {
      const failure = asNetworkBlockingError(error, 'BLOCK_FAILED');
      this.recordError(failure.message, failure.code);
      await this.persistRun(activeRun);
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
    const endedRun = {
      ...this.activeRun,
      active: false as const,
      endedAt: Date.now(),
      runStatus: 'failed' as const,
    };
    this.activeRun = null;
    void this.persistRun(endedRun);
  }

  private recordBlockedRequest(
    activeRun: ActiveNetworkBlockingRun,
    options: {
      requestId: string;
      requestUrl: string;
      requestMethod: string;
      resourceType: NetworkBlockingResourceType;
      frameId: number | null;
      rule: NetworkBlockingRule;
    },
  ): void {
    const timestamp = Date.now();
    activeRun.blockedRequests += 1;
    activeRun.lastBlockedAt = timestamp;
    delete activeRun.lastErrorCode;
    delete activeRun.lastError;

    const requestLogId = `${activeRun.runId}:${options.requestId}`;
    void this.persistRequest({
      requestLogId,
      runId: activeRun.runId,
      sessionId: activeRun.sessionId,
      requestId: options.requestId,
      timestamp,
      tabId: activeRun.tabId,
      frameId: options.frameId,
      requestUrl: options.requestUrl,
      requestMethod: options.requestMethod,
      resourceType: options.resourceType,
      ruleId: options.rule.ruleId,
      errorReason: options.rule.errorReason,
    });
    void this.persistRun(activeRun);
  }

  private recordError(message: string, code: NetworkBlockingFailureCode = 'UNKNOWN'): void {
    if (this.activeRun) {
      this.activeRun.lastError = message;
      this.activeRun.lastErrorCode = code;
    }
  }

  private toRunRecord(run: PersistableNetworkBlockingRun): NetworkBlockingRunRecord {
    if (!run.runId || !run.sessionId || !run.runStatus || !run.startedAt || typeof run.tabId !== 'number') {
      throw new Error('Cannot persist incomplete network blocking run');
    }
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      runStatus: run.runStatus,
      tabId: run.tabId,
      selectedTabId: run.selectedTabId ?? null,
      ruleCount: run.ruleCount,
      blockedRequests: run.blockedRequests,
      lastBlockedAt: run.lastBlockedAt ?? null,
      lastErrorCode: run.lastErrorCode ?? null,
      lastErrorMessage: run.lastError ?? null,
      rules: run.rules,
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
      const errorMessage = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Network blocking audit request failed with ${response.status}`;
      throw new Error(errorMessage);
    }
  }

  private async persistRun(run: PersistableNetworkBlockingRun): Promise<void> {
    try {
      const record = this.toRunRecord(run);
      await this.postJson(
        `/sessions/${encodeURIComponent(record.sessionId)}/network-blocking/runs`,
        record,
      );
    } catch (error) {
      console.warn('[mcpdbg][network-blocking] failed to persist run audit', {
        error: asErrorMessage(error),
      });
    }
  }

  private async persistRequest(record: NetworkBlockingRequestRecord): Promise<void> {
    try {
      await this.postJson(
        `/sessions/${encodeURIComponent(record.sessionId)}/network-blocking/requests`,
        record,
      );
    } catch (error) {
      console.warn('[mcpdbg][network-blocking] failed to persist request audit', {
        runId: record.runId,
        requestLogId: record.requestLogId,
        error: asErrorMessage(error),
      });
    }
  }
}
