import { ScenarioBoot } from '../scenario-boot';

const products = [
  { name: 'Trace Compass', price: '$129', detail: 'Maps browser evidence into a clean incident path.' },
  { name: 'Selector Lens', price: '$89', detail: 'Finds the stubborn UI node before coffee gets cold.' },
  { name: 'Console Net', price: '$59', detail: 'Catches noisy logs and failed calls in one sweep.' },
];

export default function ProductsPage() {
  return (
    <main className="fixture-page products-page" data-fixture-page="products">
      <section className="catalog-header">
        <p className="eyebrow">Fake product catalog</p>
        <h1 id="products-headline">Original debugging kits</h1>
        <p id="products-story" className="lead">
          Three imaginary products give the override suite real cards, prices, and behavior to change.
        </p>
        <div className="action-row">
          <button id="products-action" className="primary-action" type="button">Sort original catalog</button>
          <span id="products-action-status">Original catalog order.</span>
        </div>
      </section>

      <section className="product-grid" aria-label="Fixture products">
        {products.map((product, index) => (
          <article className="product-card" key={product.name}>
            <span className="product-index">0{index + 1}</span>
            <h2>{product.name}</h2>
            <p>{product.detail}</p>
            <strong id={index === 0 ? 'products-price' : undefined}>{product.price}</strong>
          </article>
        ))}
      </section>

      <p className="runtime-note">
        Runtime mode: <span id="products-override-marker" className="marker">original</span>
      </p>

      <ScenarioBoot page="products" />
    </main>
  );
}
