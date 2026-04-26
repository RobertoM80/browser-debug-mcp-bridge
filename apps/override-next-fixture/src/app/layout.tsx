import './global.css';

export const metadata = {
  title: 'Northstar Supply',
  description: 'A small fixture commerce site for browser override e2e coverage',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header className="site-shell">
          <a className="brand" href="/" aria-label="Northstar Supply home">
            <span className="brand-mark">NS</span>
            <span>Northstar Supply</span>
          </a>
          <nav aria-label="Fixture pages">
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/products">Products</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
