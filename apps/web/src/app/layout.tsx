import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { DockedLogPanel } from '@/components/LogPanel';

export const metadata: Metadata = {
  title: 'AMM Suite',
  description: 'Local Solana market-making console',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="min-h-screen">
            <header className="border-b border-[var(--color-border)] px-6 py-4 flex items-center justify-between">
              <div>
                <h1 className="text-xl font-semibold">AMM Suite</h1>
                <p className="text-xs text-[var(--color-muted)] mono">localhost only · 127.0.0.1:4317</p>
              </div>
              <nav className="flex gap-4 text-sm">
                <a href="/" className="hover:text-[var(--color-accent)]">overview</a>
                <a href="/wallets" className="hover:text-[var(--color-accent)]">wallets</a>
                <a href="/runs" className="hover:text-[var(--color-accent)]">runs</a>
                <a href="/lp" className="hover:text-[var(--color-accent)]">lp</a>
              </nav>
            </header>
            {/* pb-12 leaves room for the collapsed DockedLogPanel header strip */}
            <main className="p-6 pb-12 max-w-7xl mx-auto">{children}</main>
          </div>
          <DockedLogPanel />
        </Providers>
      </body>
    </html>
  );
}
