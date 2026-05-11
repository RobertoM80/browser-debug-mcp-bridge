import { MutationTrigger } from './mutation-trigger';

export default function MutationLabPage() {
  return (
    <main className="fixture-page mutation-lab-page" data-fixture-page="mutation-lab">
      <section className="hero-card">
        <p className="eyebrow">Next.js mutation fixture</p>
        <h1 id="mutation-lab-title">Original mutation route handler</h1>
        <p id="mutation-lab-copy" className="lead">
          This page sends a real POST request so the production override path can prove it blocks mutation response replay.
        </p>
        <MutationTrigger />
      </section>
    </main>
  );
}
