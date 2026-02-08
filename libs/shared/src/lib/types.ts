export interface Session {
  id: string;
  url: string;
  startedAt: Date;
  endedAt?: Date;
  status: 'active' | 'closed';
}

export interface Event {
  id: string;
  sessionId: string;
  type: EventType;
  timestamp: Date;
  data: Record<string, unknown>;
}

export type EventType = 
  | 'navigation' 
  | 'console' 
  | 'error' 
  | 'network' 
  | 'click' 
  | 'custom';

export interface NetworkEvent extends Event {
  type: 'network';
  data: {
    method: string;
    url: string;
    status: number;
    duration: number;
    errorType?: NetworkErrorType;
  };
}

export type NetworkErrorType = 
  | 'timeout' 
  | 'cors' 
  | 'dns' 
  | 'blocked' 
  | 'http_error';

export interface ConsoleEvent extends Event {
  type: 'console';
  data: {
    level: 'error' | 'warn' | 'info' | 'debug';
    message: string;
    args?: unknown[];
  };
}

export interface ErrorEvent extends Event {
  type: 'error';
  data: {
    message: string;
    stack?: string;
    filename?: string;
    line?: number;
    column?: number;
    fingerprint?: string;
  };
}

export interface NavigationEvent extends Event {
  type: 'navigation';
  data: {
    from?: string;
    to: string;
    timestamp: number;
  };
}

export interface ClickEvent extends Event {
  type: 'click';
  data: {
    selector: string;
    timestamp: number;
  };
}
