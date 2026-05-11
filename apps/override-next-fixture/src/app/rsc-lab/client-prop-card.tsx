'use client';

export function ClientPropCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <article className="lab-card">
      <span className="product-index">{label}</span>
      <p id="rsc-client-prop">{value}</p>
    </article>
  );
}
