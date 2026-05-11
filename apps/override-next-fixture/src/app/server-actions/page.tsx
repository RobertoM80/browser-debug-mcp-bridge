export const dynamic = 'force-dynamic';

async function queueFixtureServerAction(formData: FormData) {
  'use server';

  const labelValue = formData.get('label');
  const label = typeof labelValue === 'string' && labelValue.trim().length > 0 ? labelValue.trim() : 'fixture server action';
  void label;
}

export default function ServerActionsPage() {
  return (
    <main className="fixture-page server-action-page" data-fixture-page="server-actions">
      <section className="hero-card">
        <p className="eyebrow">Next.js server action fixture</p>
        <h1 id="server-action-title">Original server action workflow</h1>
        <p id="server-action-copy" className="lead">
          This page exists to prove that production override planning blocks real server-action requests instead of replaying them.
        </p>
        <form action={queueFixtureServerAction} className="action-row">
          <input type="hidden" name="label" value="fixture server action" />
          <button id="server-action-submit" className="primary-action" type="submit">Submit original server action</button>
          <span id="server-action-note">Server action requests should stay blocked by production override planning.</span>
        </form>
      </section>
    </main>
  );
}
