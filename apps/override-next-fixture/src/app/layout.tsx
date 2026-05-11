import './global.css';
import Link from 'next/link';

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
            <Link href="/" prefetch={false}>Home</Link>
            <Link href="/about" prefetch={false}>About</Link>
            <Link href="/products" prefetch={false}>Products</Link>
            <Link id="nav-rsc-lab" href="/rsc-lab/alpha" prefetch={false}>RSC Lab</Link>
            <Link id="nav-server-actions" href="/server-actions" prefetch={false}>Server Action</Link>
            <Link id="nav-mutation-lab" href="/mutation-lab" prefetch={false}>Mutation</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
