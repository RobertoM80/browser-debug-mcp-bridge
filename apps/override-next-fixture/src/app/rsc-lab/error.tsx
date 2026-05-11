'use client';

export default function RscLabError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <section className="lab-panel" aria-label="RSC lab error">
      <h2 id="rsc-error-title">Original RSC error boundary</h2>
      <p id="rsc-error-message">{error.message}</p>
      <button className="primary-action" type="button" onClick={reset}>Retry original lab route</button>
    </section>
  );
}
