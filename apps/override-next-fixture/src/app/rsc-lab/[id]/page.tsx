import { Suspense } from 'react';
import { ClientPropCard } from '../client-prop-card';

export const dynamic = 'force-dynamic';

const routeLabels: Record<string, { title: string; detail: string; prop: string; suspense: string }> = {
  alpha: {
    title: 'Original alpha deployment',
    detail: 'Original alpha route detail: nested layout context stayed stable.',
    prop: 'Original client prop from alpha server data.',
    suspense: 'Original alpha suspense payload',
  },
  bravo: {
    title: 'Original bravo deployment',
    detail: 'Original bravo route detail: this page must not receive alpha overrides.',
    prop: 'Original client prop from bravo server data.',
    suspense: 'Original bravo suspense payload',
  },
};

async function SuspenseProof({ value }: { value: string }) {
  await Promise.resolve();
  return <p id="rsc-suspense-value">{value}</p>;
}

export default async function RscDynamicPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const route = routeLabels[id] ?? {
    title: `Original ${id} deployment`,
    detail: `Original ${id} route detail: dynamic fallback rendered.`,
    prop: `Original client prop from ${id} server data.`,
    suspense: `Original ${id} suspense payload`,
  };

  if (id === 'broken') {
    throw new Error('Original RSC lab failure');
  }

  return (
    <section className="lab-panel" data-rsc-route={id}>
      <h2 id="rsc-dynamic-title">{route.title}</h2>
      <p id="rsc-dynamic-detail">{route.detail}</p>
      <div className="lab-grid">
        <ClientPropCard label="Client prop" value={route.prop} />
        <article className="lab-card">
          <span className="product-index">Suspense</span>
          <Suspense fallback={<p id="rsc-suspense-value">Original suspense fallback</p>}>
            <SuspenseProof value={route.suspense} />
          </Suspense>
        </article>
      </div>
    </section>
  );
}
