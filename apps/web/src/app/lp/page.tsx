'use client';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { shorten } from '@/lib/utils';

const CLMM_VENUES = ['raydium-clmm', 'orca-whirlpools', 'meteora-dlmm', 'pumpswap'] as const;

export default function LpPage() {
  const wallets = trpc.vault.listWallets.useQuery();
  const [owner, setOwner] = useState('');
  const [pools, setPools] = useState<{ venue: string; poolId: string }[]>([]);
  const [draftVenue, setDraftVenue] = useState<(typeof CLMM_VENUES)[number]>('meteora-dlmm');
  const [draftPool, setDraftPool] = useState('');

  const positions = trpc.lp.positions.useQuery(
    { ownerLabel: owner, pools },
    { enabled: !!owner && pools.length > 0 },
  );

  const utils = trpc.useUtils();
  const withdraw = trpc.lp.withdraw.useMutation({
    onSuccess: () => utils.lp.positions.invalidate(),
  });
  const claimFees = trpc.lp.claimFees.useMutation({
    onSuccess: () => utils.lp.positions.invalidate(),
  });

  // Deposit panel state
  const [depVenue, setDepVenue] = useState<(typeof CLMM_VENUES)[number]>('meteora-dlmm');
  const [depPool, setDepPool] = useState('');
  const [depWallet, setDepWallet] = useState('');
  const [depMode, setDepMode] = useState<'two-sided' | 'quote-only' | 'base-only'>('two-sided');
  const [depStrategy, setDepStrategy] = useState<'spot' | 'curve' | 'bid-ask'>('spot');
  const [depBase, setDepBase] = useState('0');
  const [depQuote, setDepQuote] = useState('0');
  const [depWidth, setDepWidth] = useState('0.05');
  const [depBinOffset, setDepBinOffset] = useState('1');
  const [depSlippage, setDepSlippage] = useState('80');
  const [depLogs, setDepLogs] = useState<string[] | null>(null);

  const simulate = trpc.lp.simulateDeposit.useMutation({
    onSuccess: (r) => setDepLogs(r.logs),
    onError: (e) => setDepLogs([`error: ${e.message}`]),
  });
  const deposit = trpc.lp.deposit.useMutation({
    onSuccess: () => {
      setDepLogs([`deposit confirmed`]);
      utils.lp.positions.invalidate();
    },
    onError: (e) => setDepLogs([`error: ${e.message}`]),
  });

  const isDlmm = depVenue === 'meteora-dlmm';
  const baseDisabled = isDlmm && depMode === 'quote-only';
  const quoteDisabled = isDlmm && depMode === 'base-only';

  function buildDepositInput() {
    return {
      venue: depVenue,
      poolId: depPool,
      walletLabel: depWallet,
      baseAmount: baseDisabled ? '0' : depBase,
      quoteAmount: quoteDisabled ? '0' : depQuote,
      widthFraction: parseFloat(depWidth) || undefined,
      slippageBps: parseInt(depSlippage, 10) || 80,
      mode: isDlmm ? depMode : undefined,
      strategyType: isDlmm ? depStrategy : undefined,
      binOffset: isDlmm && depMode !== 'two-sided'
        ? parseInt(depBinOffset, 10) || 1
        : undefined,
    };
  }

  return (
    <div className="space-y-6">
      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-3">LP scanner</h3>
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="owner wallet">
            <select value={owner} onChange={(e) => setOwner(e.target.value)} className="input">
              <option value="">— pick —</option>
              {wallets.data?.map((w) => (
                <option key={w.label} value={w.label}>{w.label}</option>
              ))}
            </select>
          </Field>
          <Field label="venue">
            <select value={draftVenue} onChange={(e) => setDraftVenue(e.target.value as typeof draftVenue)} className="input">
              {CLMM_VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="pool id">
            <div className="flex gap-2">
              <input value={draftPool} onChange={(e) => setDraftPool(e.target.value)} className="input mono" placeholder="pool pubkey" />
              <button
                disabled={!draftPool}
                onClick={() => {
                  setPools([...pools, { venue: draftVenue, poolId: draftPool }]);
                  setDraftPool('');
                }}
                className="px-3 py-1 rounded border border-[var(--color-border)] text-sm"
              >
                add
              </button>
            </div>
          </Field>
        </div>
        {pools.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {pools.map((p, i) => (
              <span key={i} className="text-xs mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1">
                {p.venue} · {shorten(p.poolId, 6, 4)}
                <button onClick={() => setPools(pools.filter((_, j) => j !== i))} className="ml-2 text-[var(--color-danger)]">×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-3">Deposit liquidity</h3>
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="venue">
            <select value={depVenue} onChange={(e) => setDepVenue(e.target.value as typeof depVenue)} className="input">
              {CLMM_VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="pool id">
            <input value={depPool} onChange={(e) => setDepPool(e.target.value)} className="input mono" placeholder="pool pubkey" />
          </Field>
          <Field label="wallet">
            <select value={depWallet} onChange={(e) => setDepWallet(e.target.value)} className="input">
              <option value="">— pick —</option>
              {wallets.data?.map((w) => (
                <option key={w.label} value={w.label}>{w.label}</option>
              ))}
            </select>
          </Field>
          {isDlmm && (
            <>
              <Field label="mode (DLMM)">
                <select value={depMode} onChange={(e) => setDepMode(e.target.value as typeof depMode)} className="input">
                  <option value="two-sided">two-sided</option>
                  <option value="quote-only">quote-only (buy ladder)</option>
                  <option value="base-only">base-only (sell ladder)</option>
                </select>
              </Field>
              <Field label="strategy type">
                <select value={depStrategy} onChange={(e) => setDepStrategy(e.target.value as typeof depStrategy)} className="input">
                  <option value="spot">spot (uniform)</option>
                  <option value="curve">curve (centered)</option>
                  <option value="bid-ask">bid-ask (edges)</option>
                </select>
              </Field>
              {depMode !== 'two-sided' && (
                <Field label="bin offset">
                  <input value={depBinOffset} onChange={(e) => setDepBinOffset(e.target.value)} className="input mono" />
                </Field>
              )}
            </>
          )}
          <Field label="base amount (atomic)">
            <input
              value={baseDisabled ? '0' : depBase}
              onChange={(e) => setDepBase(e.target.value)}
              disabled={baseDisabled}
              className="input mono"
            />
          </Field>
          <Field label="quote amount (atomic)">
            <input
              value={quoteDisabled ? '0' : depQuote}
              onChange={(e) => setDepQuote(e.target.value)}
              disabled={quoteDisabled}
              className="input mono"
            />
          </Field>
          <Field label="width fraction">
            <input value={depWidth} onChange={(e) => setDepWidth(e.target.value)} className="input mono" />
          </Field>
          <Field label="slippage bps">
            <input value={depSlippage} onChange={(e) => setDepSlippage(e.target.value)} className="input mono" />
          </Field>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            disabled={!depPool || !depWallet || simulate.isPending}
            onClick={() => {
              setDepLogs(null);
              const i = buildDepositInput();
              simulate.mutate({
                venue: i.venue,
                poolId: i.poolId,
                owner: i.walletLabel,
                baseAmount: i.baseAmount,
                quoteAmount: i.quoteAmount,
                widthFraction: i.widthFraction,
                slippageBps: i.slippageBps,
                mode: i.mode,
                strategyType: i.strategyType,
                binOffset: i.binOffset,
              });
            }}
            className="px-3 py-1 rounded border border-[var(--color-border)] text-sm"
          >
            {simulate.isPending ? 'simulating…' : 'simulate'}
          </button>
          <button
            disabled={!depPool || !depWallet || deposit.isPending}
            onClick={() => {
              if (!confirm('deploy liquidity?')) return;
              setDepLogs(null);
              deposit.mutate(buildDepositInput());
            }}
            className="px-3 py-1 rounded border border-[var(--color-border)] text-sm bg-[var(--color-accent)]/10"
          >
            {deposit.isPending ? 'deploying…' : 'deploy'}
          </button>
        </div>
        {depLogs && (
          <pre className="mt-3 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">
            {depLogs.join('\n')}
          </pre>
        )}
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-3">Positions</h3>
        {positions.isFetching && <p className="text-sm text-[var(--color-muted)]">scanning...</p>}
        {positions.data && positions.data.length === 0 && <p className="text-sm text-[var(--color-muted)]">none found.</p>}
        {positions.data && positions.data.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-muted)] text-xs uppercase">
              <tr>
                <th className="py-1">venue</th>
                <th>position</th>
                <th>range</th>
                <th>status</th>
                <th>amounts</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.data.map((p) => (
                <tr key={p.positionId} className="border-t border-[var(--color-border)]">
                  <td className="py-2">{p.venue}</td>
                  <td className="mono">{shorten(p.positionId, 6, 4)}</td>
                  <td className="text-xs mono">
                    {p.lowerPrice !== null && p.upperPrice !== null
                      ? `${p.lowerPrice.toFixed(6)} – ${p.upperPrice.toFixed(6)}`
                      : 'full-range'}
                  </td>
                  <td>
                    <span className={p.inRange ? 'text-[var(--color-accent)]' : 'text-[var(--color-warn)]'}>
                      {p.inRange ? 'in range' : 'out of range'}
                    </span>
                  </td>
                  <td className="text-xs mono">b={p.baseAmount} q={p.quoteAmount}</td>
                  <td className="text-right space-x-3">
                    {p.venue === 'meteora-dlmm' && (
                      <button
                        onClick={() => {
                          claimFees.mutate({
                            poolId: p.poolId,
                            positionId: p.positionId,
                            walletLabel: owner,
                          });
                        }}
                        disabled={claimFees.isPending}
                        className="text-xs text-[var(--color-accent)] hover:underline"
                      >
                        claim fees
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirm('withdraw 100% and close?')) {
                          withdraw.mutate({
                            venue: p.venue,
                            positionId: p.positionId,
                            walletLabel: owner,
                            fraction: 1,
                            closePosition: true,
                            slippageBps: 100,
                          });
                        }
                      }}
                      className="text-xs text-[var(--color-danger)] hover:underline"
                    >
                      close
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <style jsx>{`
        :global(.input) {
          background: var(--color-bg);
          border: 1px solid var(--color-border);
          border-radius: 6px;
          padding: 6px 10px;
          width: 100%;
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}
