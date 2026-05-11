import Link from 'next/link';

export default function RscLabLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="fixture-page rsc-lab-page" data-fixture-page="rsc-lab">
      <section className="lab-shell" aria-label="RSC lab shell">
        <p className="eyebrow">App Router lab</p>
        <h1 id="rsc-lab-shell">Original nested RSC shell</h1>
        <p id="rsc-lab-shell-note" className="lead">
          Nested layouts, dynamic route output, search params, suspense, and client props share one RSC fixture.
        </p>
        <nav className="lab-nav" aria-label="RSC lab routes">
          <Link id="rsc-alpha-link" href="/rsc-lab/alpha" prefetch>Alpha</Link>
          <Link id="rsc-bravo-link" href="/rsc-lab/bravo" prefetch={false}>Bravo</Link>
          <Link id="rsc-search-link" href="/rsc-lab/search?mode=calm" prefetch={false}>Search</Link>
          <Link id="rsc-search-loud-link" href="/rsc-lab/search?mode=loud" prefetch={false}>Search loud</Link>
        </nav>
      </section>
      {children}
    </main>
  );
}
