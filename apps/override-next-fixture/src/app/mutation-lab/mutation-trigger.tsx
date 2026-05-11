'use client';

import { useState } from 'react';

export function MutationTrigger() {
  const [status, setStatus] = useState('Original mutation idle.');

  return (
    <div className="action-row">
      <button
        id="mutation-lab-submit"
        className="primary-action"
        type="button"
        onClick={async () => {
          setStatus('Sending original mutation...');
          const response = await fetch('/api/mutation-signal', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              mode: 'original-mutation',
              label: 'fixture mutation',
            }),
          });
          const payload = await response.json() as { message?: string };
          setStatus(payload.message ?? 'Original mutation completed.');
        }}
      >
        Send original mutation
      </button>
      <span id="mutation-lab-status">{status}</span>
    </div>
  );
}
