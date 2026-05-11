import { ClientPropCard } from '../client-prop-card';

export default async function RscSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const params = await searchParams;
  const mode = params.mode ?? 'none';
  const summary = `Original filter: ${mode}`;
  const clientProp = `Original search client prop: ${mode}`;

  return (
    <section className="lab-panel" data-rsc-search-mode={mode}>
      <h2 id="rsc-search-title">Original search-param RSC panel</h2>
      <p id="rsc-search-summary">{summary}</p>
      <ClientPropCard label="Search prop" value={clientProp} />
    </section>
  );
}
