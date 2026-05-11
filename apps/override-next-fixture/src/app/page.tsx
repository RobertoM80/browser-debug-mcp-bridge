import { ApiSignalPanel } from './api-signal-panel';
import { ScenarioBoot } from './scenario-boot';

export default function Page() {
  return (
    <main className="fixture-page home-page" data-fixture-page="home">
      <section className="hero-card">
        <p className="eyebrow">Browser override lab</p>
        <h1 id="home-headline">Original launch desk for field teams</h1>
        <p id="home-story" className="lead">
          Plan realistic local asset swaps against a production-shaped Next.js site without editing source files.
        </p>
        <div className="action-row">
          <button id="home-action" className="primary-action" type="button">Queue original demo</button>
          <span id="home-action-status">Original demo idle.</span>
        </div>
      </section>

      <section className="signal-grid" aria-label="Fixture home signals">
        <article>
          <span className="metric">3</span>
          <p>pages with one override assertion each</p>
        </article>
        <article>
          <span className="metric">0</span>
          <p>repo files changed by browser overrides</p>
        </article>
        <article>
          <span id="home-override-marker" className="marker">original</span>
          <p>home runtime mode</p>
        </article>
      </section>

      <ApiSignalPanel />

      <ScenarioBoot page="home" />
    </main>
  );
}
