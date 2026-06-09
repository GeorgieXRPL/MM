'use client';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { UnlockScreen } from '@/components/unlock-screen';

export default function HomePage() {
  const status = trpc.vault.status.useQuery();
  const utils = trpc.useUtils();

  if (status.isLoading) return <p className="text-[var(--color-muted)]">loading...</p>;
  if (!status.data?.exists)
    return (
      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-6 max-w-xl mx-auto mt-24">
        <h2 className="text-lg font-semibold">No vault found</h2>
        <p className="text-sm text-[var(--color-muted)] mt-2">
          Create a vault from the CLI first:
        </p>
        <pre className="mono text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-3 mt-3">pnpm cli vault init</pre>
        <p className="text-sm text-[var(--color-muted)] mt-3">
          Vault path: <code>{status.data?.path}</code>
        </p>
      </div>
    );
  if (!status.data.unlocked) return <UnlockScreen onUnlocked={() => utils.vault.status.invalidate()} />;

  return <Overview />;
}

function Overview() {
  const wallets = trpc.vault.listWallets.useQuery();
  const runs = trpc.runs.list.useQuery({ limit: 10 });
  const active = trpc.runs.active.useQuery();

  const totalSol = wallets.data
    ? wallets.data.reduce((s, w) => s + w.balanceLamports, 0) / 1_000_000_000
    : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card title="Wallets" value={wallets.data?.length ?? '...'} subtitle="in vault" />
        <Card title="Total SOL" value={totalSol.toFixed(4)} subtitle="across all wallets" />
        <Card title="Active runs" value={active.data?.filter((r) => r.running).length ?? '...'} subtitle="strategies running now" />
      </div>

      <SystemStatusCard />

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-3">Recent runs</h3>
        {!runs.data || runs.data.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">no runs yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-muted)] text-xs uppercase">
              <tr>
                <th className="py-1">id</th>
                <th>strategy</th>
                <th>pool</th>
                <th>status</th>
                <th className="text-right">started</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="border-t border-[var(--color-border)]">
                  <td className="py-2 mono">#{r.id}</td>
                  <td>{r.strategy}</td>
                  <td className="mono">{r.pool.slice(0, 12)}...</td>
                  <td>
                    <span
                      className={
                        r.status === 'running'
                          ? 'text-[var(--color-accent)]'
                          : r.status === 'errored'
                            ? 'text-[var(--color-danger)]'
                            : 'text-[var(--color-muted)]'
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="text-right mono">{new Date(r.startedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Card({ title, value, subtitle }: { title: string; value: string | number; subtitle?: string }) {
  return (
    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <p className="text-xs uppercase text-[var(--color-muted)]">{title}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
      {subtitle && <p className="text-xs text-[var(--color-muted)] mt-1">{subtitle}</p>}
    </div>
  );
}

/**
 * System status card. Shows the network state of the dashboard process:
 *  - configured RPC endpoints (with API keys redacted)
 *  - Jito block-engine URL + tip
 *  - Tor SOCKS proxy state, with a "test now" button that probes a public
 *    IP service through both the shared dispatcher and a direct dispatcher
 *    and reports whether they differ (Tor is masking the real IP)
 *
 * Lets the user confirm at a glance whether their opsec env is what they
 * expect before kicking off a live run.
 */
function SystemStatusCard() {
  const [probeNow, setProbeNow] = useState(false);
  const status = trpc.system.status.useQuery({ probeProxy: probeNow });
  const hasPrivateRpc = (status.data?.rpcEndpoints ?? []).some(
    (e) => e.name !== 'public' && e.hasApiKey,
  );
  const proxy = status.data?.proxy;
  const proxyState: 'on' | 'off' | 'broken' | 'untested' = !proxy
    ? 'untested'
    : !proxy.configured
    ? 'off'
    : proxy.error
    ? 'broken'
    : proxy.fetchedAt === 0
    ? 'untested'
    : proxy.inPath
    ? 'on'
    : 'broken';
  const dot = (color: 'good' | 'warn' | 'bad' | 'mute'): string => {
    switch (color) {
      case 'good':
        return 'text-[var(--color-accent)]';
      case 'warn':
        return 'text-[var(--color-warn)]';
      case 'bad':
        return 'text-[var(--color-danger)]';
      default:
        return 'text-[var(--color-muted)]';
    }
  };
  return (
    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium">System</h3>
        <button
          type="button"
          onClick={() => setProbeNow(true)}
          className="text-xs text-[var(--color-muted)] hover:underline"
          disabled={status.isFetching}
        >
          {status.isFetching && probeNow ? 'probing tor...' : 'test tor now'}
        </button>
      </div>
      <div className="grid md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <p className="text-xs uppercase text-[var(--color-muted)]">Cluster</p>
          <p className="mono">{status.data?.cluster ?? '...'}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-[var(--color-muted)]">Jito</p>
          <p className="mono break-all text-xs">{status.data?.jito.url}</p>
          <p className="text-xs text-[var(--color-muted)]">
            tip {status.data?.jito.tipLamports ?? 0} lamports
          </p>
        </div>
        <div className="md:col-span-2">
          <p className="text-xs uppercase text-[var(--color-muted)]">RPC endpoints</p>
          <ul className="mono text-xs space-y-0.5">
            {(status.data?.rpcEndpoints ?? []).map((e) => (
              <li key={e.name}>
                <span
                  className={
                    e.name === 'public'
                      ? dot('warn')
                      : e.hasApiKey
                      ? dot('good')
                      : dot('mute')
                  }
                >
                  ●
                </span>{' '}
                <span>{e.name}</span> <span className="text-[var(--color-muted)]">{e.url}</span>
              </li>
            ))}
          </ul>
          {!hasPrivateRpc && (
            <p className="text-xs text-[var(--color-warn)] mt-1">
              No private RPC configured. Public mainnet is rate-limited and unreliable
              for live runs - get a Helius/Triton/Quicknode key and set{' '}
              <span className="mono">RPC_HELIUS</span> in{' '}
              <span className="mono">apps/web/.env.local</span>.
            </p>
          )}
        </div>
        <div className="md:col-span-2">
          <p className="text-xs uppercase text-[var(--color-muted)]">Tor SOCKS</p>
          {proxyState === 'on' && (
            <p className={dot('good')}>
              ● on — proxy IP <span className="mono">{proxy?.proxyIp}</span>
              {proxy?.realIp && (
                <span className="text-[var(--color-muted)]">
                  {' '}
                  (vs direct {proxy.realIp})
                </span>
              )}
            </p>
          )}
          {proxyState === 'off' && (
            <p className={dot('warn')}>
              ● off — no <span className="mono">TOR_PROXY</span> in env. RPC + Jupiter +
              Jito calls go from your real IP. Set{' '}
              <span className="mono">TOR_PROXY=socks5h://127.0.0.1:9050</span> in{' '}
              <span className="mono">apps/web/.env.local</span> and restart the dev
              server (after starting Tor on your machine).
            </p>
          )}
          {proxyState === 'broken' && (
            <p className={dot('bad')}>
              ● configured but not working: {proxy?.error ?? 'proxy IP matches direct IP'}.
              Check that Tor is running and listening on the configured port.
            </p>
          )}
          {proxyState === 'untested' && (
            <p className={dot('mute')}>
              {proxy?.configured
                ? `● configured (${proxy?.proxy}) — click "test tor now" to verify`
                : '● not configured — click "test tor now" to verify'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
