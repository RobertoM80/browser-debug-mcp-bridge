'use client';

import { useEffect, useState } from 'react';

interface ApiSignal {
  mode: string;
  message: string;
  badge: string;
}

const loadingSignal: ApiSignal = {
  mode: 'loading',
  message: 'Loading Next API signal.',
  badge: 'pending',
};

function normalizeApiSignal(value: unknown): ApiSignal {
  if (!value || typeof value !== 'object') {
    return {
      mode: 'invalid',
      message: 'Invalid Next API signal.',
      badge: 'invalid',
    };
  }

  const record = value as Partial<Record<keyof ApiSignal, unknown>>;
  return {
    mode: typeof record.mode === 'string' ? record.mode : 'missing-mode',
    message: typeof record.message === 'string' ? record.message : 'Missing API message.',
    badge: typeof record.badge === 'string' ? record.badge : 'missing',
  };
}

export function ApiSignalPanel() {
  const [signal, setSignal] = useState<ApiSignal>(loadingSignal);

  useEffect(() => {
    let mounted = true;

    fetch('/api/override-signal', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`API signal failed with ${response.status}`);
        }
        return response.json() as Promise<unknown>;
      })
      .then((payload) => {
        if (mounted) {
          setSignal(normalizeApiSignal(payload));
        }
      })
      .catch(() => {
        if (mounted) {
          setSignal({
            mode: 'error',
            message: 'Unable to load Next API signal.',
            badge: 'error',
          });
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <section className="api-signal" aria-label="Next API signal">
      <p className="eyebrow">Next API route</p>
      <h2 id="next-api-mode">{signal.mode}</h2>
      <p id="next-api-message">{signal.message}</p>
      <span id="next-api-badge" className="marker">{signal.badge}</span>
    </section>
  );
}
