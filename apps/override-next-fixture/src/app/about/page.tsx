import { ScenarioBoot } from '../scenario-boot';

export default function AboutPage() {
  return (
    <main className="fixture-page about-page" data-fixture-page="about">
      <section className="split-panel">
        <div>
          <p className="eyebrow">About the test shop</p>
          <h1 id="about-headline">Original quality promise</h1>
          <p id="about-story" className="lead">
            Northstar Supply ships calm, well-labeled debugging kits to teams practicing live browser diagnosis.
          </p>
          <div className="action-row">
            <button id="about-action" className="primary-action" type="button">Open original proof pack</button>
            <span id="about-action-status">Original proof pack idle.</span>
          </div>
        </div>

        <aside className="proof-card" aria-label="Fixture trust proof">
          <span id="about-override-marker" className="marker">original</span>
          <p id="about-proof">Original proof: 42 inspection notes reviewed by humans.</p>
          <p className="fine-print">This is fake content built only for override e2e tests.</p>
        </aside>
      </section>

      <ScenarioBoot page="about" />
    </main>
  );
}
