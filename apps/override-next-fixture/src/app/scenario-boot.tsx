'use client';

import { useEffect } from 'react';

export type FixturePage = 'home' | 'about' | 'products';

const originalActionText: Record<FixturePage, string> = {
  home: 'Original demo queued from Home.',
  about: 'Original proof pack opened.',
  products: 'Original catalog sorted by stability.',
};

export function ScenarioBoot({ page }: { page: FixturePage }) {
  useEffect(() => {
    document.body.dataset[`${page}OverrideMode`] = 'original';

    const marker = document.getElementById(`${page}-override-marker`);
    if (marker) {
      marker.textContent = 'original';
    }

    const action = document.getElementById(`${page}-action`);
    const status = document.getElementById(`${page}-action-status`);
    const handleAction = () => {
      if (status) {
        status.textContent = originalActionText[page];
      }
    };

    action?.addEventListener('click', handleAction);
    return () => action?.removeEventListener('click', handleAction);
  }, [page]);

  return null;
}
