'use client';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { shorten, fmtSol } from '@/lib/utils';

export default function WalletsPage() {
  const wallets = trpc.vault.listWallets.useQuery();
  const utils = trpc.useUtils();
  const generate = trpc.vault.generateWallets.useMutation({
    onSuccess: () => utils.vault.listWallets.invalidate(),
  });
  const remove = trpc.vault.removeWallet.useMutation({
    onSuccess: () => utils.vault.listWallets.invalidate(),
  });
  const fund = trpc.vault.fundSubWallets.useMutation({
    onSuccess: () => utils.vault.listWallets.invalidate(),
  });
  const importMut = trpc.vault.importWallet.useMutation({
    onSuccess: () => utils.vault.listWallets.invalidate(),
  });
  const gatherMut = trpc.vault.gatherFunds.useMutation({
    onSuccess: () => utils.vault.listWallets.invalidate(),
  });
  const liquidateMut = trpc.vault.liquidateTokens.useMutation({
    onSuccess: () => utils.vault.listWallets.invalidate(),
  });

  const [count, setCount] = useState(5);
  const [prefix, setPrefix] = useState('vol');
  const [tag, setTag] = useState('volume');

  // Import panel state
  const [importLabel, setImportLabel] = useState('funder');
  const [importTag, setImportTag] = useState('mainnet-funder');
  const [importSecret, setImportSecret] = useState('');

  // Funding panel state
  const [funder, setFunder] = useState('');
  const [recipientTag, setRecipientTag] = useState('volume');
  const [perWallet, setPerWallet] = useState(0.01);
  const [multiHop, setMultiHop] = useState(true);
  const [minHops, setMinHops] = useState(3);
  const [maxHops, setMaxHops] = useState(7);
  const [jitter, setJitter] = useState(0.15);

  // Liquidate panel state — converts SPL token balances back to SOL on each
  // matching wallet without sweeping. Designed for the volume-strategy
  // recovery flow: after a stop/restart the strategy's `walletLastSide`
  // map is wiped, the strict-alternate FSM forces every wallet's first
  // trade to be a buy, and any wallet that holds residual tokens (with low
  // SOL) gets stuck on `trade skipped: native SOL below swap + rent reserve`.
  // Running liquidate here clears those balances and restores SOL headroom
  // so the next run starts from a clean all-SOL state.
  const [liqSourceTag, setLiqSourceTag] = useState('volume');
  const [liqMint, setLiqMint] = useState('');
  const [liqSlippage, setLiqSlippage] = useState(300);
  const [liqConcurrency, setLiqConcurrency] = useState(4);

  // Gather panel state
  const [gatherSourceTag, setGatherSourceTag] = useState('volume');
  const [gatherDest, setGatherDest] = useState('');
  const [gatherDests, setGatherDests] = useState<string[]>([]); // multi-destination
  const [gatherIncludeTokens, setGatherIncludeTokens] = useState(true);
  const [gatherConcurrency, setGatherConcurrency] = useState(4);
  const [gatherShowAdvanced, setGatherShowAdvanced] = useState(false);
  const [gatherLiquidate, setGatherLiquidate] = useState(false);
  const [gatherLiquidateSlippage, setGatherLiquidateSlippage] = useState(300);
  const [gatherPhaseMin, setGatherPhaseMin] = useState(0);
  const [gatherPhaseMax, setGatherPhaseMax] = useState(0);

  const recipientCount = useMemo(
    () => (wallets.data ?? []).filter((w) => w.tags.includes(recipientTag)).length,
    [wallets.data, recipientTag],
  );
  const totalNeeded = perWallet * recipientCount;

  const gatherSourceWallets = useMemo(
    () =>
      (wallets.data ?? []).filter(
        (w) => w.tags.includes(gatherSourceTag) && w.label !== gatherDest,
      ),
    [wallets.data, gatherSourceTag, gatherDest],
  );
  const gatherSourceTotalLamports = useMemo(
    () => gatherSourceWallets.reduce((s, w) => s + w.balanceLamports, 0),
    [gatherSourceWallets],
  );

  const liqSourceWallets = useMemo(
    () => (wallets.data ?? []).filter((w) => w.tags.includes(liqSourceTag)),
    [wallets.data, liqSourceTag],
  );

  return (
    <div className="space-y-6">
      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-1">Import wallet</h3>
        <p className="text-xs text-[var(--color-muted)] mb-3">
          Paste a base58 secret key (~88 chars) <em>or</em> a Solana CLI keypair
          JSON array (<span className="mono">[1,2,...,64]</span>). The secret never leaves
          this machine. Typical use: import your mainnet funder wallet, then generate
          sub-wallets below and use Fund to spread SOL into them.
        </p>
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="label">
            <input
              value={importLabel}
              onChange={(e) => setImportLabel(e.target.value)}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
            />
          </Field>
          <Field label="tag">
            <input
              value={importTag}
              onChange={(e) => setImportTag(e.target.value)}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
            />
          </Field>
          <div />
          <div className="md:col-span-3">
            <Field label="secret key (base58 or JSON array)">
              <textarea
                value={importSecret}
                onChange={(e) => setImportSecret(e.target.value)}
                rows={3}
                spellCheck={false}
                autoComplete="off"
                placeholder="paste secret key here..."
                className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full text-xs"
                style={{ WebkitTextSecurity: 'disc' } as React.CSSProperties}
              />
            </Field>
          </div>
        </div>
        {importMut.error && (
          <p className="text-sm text-[var(--color-danger)] mt-3">{importMut.error.message}</p>
        )}
        {importMut.data && (
          <p className="text-sm text-[var(--color-accent)] mt-3">
            ✓ imported <span className="mono">{importMut.data.label}</span> ({shorten(importMut.data.pubkey, 8, 6)})
          </p>
        )}
        <button
          onClick={() => {
            const trimmed = importSecret.trim();
            if (!importLabel.trim() || !trimmed) return;
            importMut.mutate(
              {
                label: importLabel.trim(),
                tags: importTag.trim() ? [importTag.trim()] : [],
                secret: trimmed,
              },
              { onSuccess: () => setImportSecret('') },
            );
          }}
          disabled={!importLabel.trim() || !importSecret.trim() || importMut.isPending}
          className="mt-4 px-4 py-2 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
        >
          {importMut.isPending ? 'importing...' : 'import'}
        </button>
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-3">Generate sub-wallets</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <Field label="count">
            <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(parseInt(e.target.value || '1', 10))} className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-20" />
          </Field>
          <Field label="prefix">
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-32" />
          </Field>
          <Field label="tag">
            <input value={tag} onChange={(e) => setTag(e.target.value)} className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-32" />
          </Field>
          <button
            onClick={() => generate.mutate({ count, prefix, tags: [tag] })}
            disabled={generate.isPending}
            className="px-4 py-1 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
          >
            generate
          </button>
        </div>
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-1">Fund sub-wallets</h3>
        <p className="text-xs text-[var(--color-muted)] mb-3">
          Distribute SOL from a funder wallet to all wallets matching a tag. With multi-hop on,
          the SOL passes through 3-7 freshly-generated intermediate wallets to break the
          on-chain trace from operator to sub-wallets.
        </p>
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="from (funder)">
            <select value={funder} onChange={(e) => setFunder(e.target.value)} className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full">
              <option value="">— pick —</option>
              {(wallets.data ?? []).map((w) => (
                <option key={w.label} value={w.label}>
                  {w.label} ({fmtSol(w.balanceLamports)} SOL)
                </option>
              ))}
            </select>
          </Field>
          <Field label="recipient tag">
            <input value={recipientTag} onChange={(e) => setRecipientTag(e.target.value)} className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full" />
          </Field>
          <Field label={`per wallet (SOL) — ${recipientCount} recipients, total ~${totalNeeded.toFixed(4)} SOL`}>
            <input type="number" step="0.001" min={0} value={perWallet} onChange={(e) => setPerWallet(parseFloat(e.target.value) || 0)} className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full" />
          </Field>
          <Field label="multi-hop indirection">
            <label className="flex items-center gap-2 mt-2">
              <input type="checkbox" checked={multiHop} onChange={(e) => setMultiHop(e.target.checked)} />
              {multiHop ? 'on (recommended)' : 'off (direct, on-chain trace visible)'}
            </label>
          </Field>
          {multiHop && (
            <>
              <Field label="min hops">
                <input type="number" min={1} max={10} value={minHops} onChange={(e) => setMinHops(parseInt(e.target.value || '3', 10))} className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full" />
              </Field>
              <Field label="max hops">
                <input type="number" min={1} max={15} value={maxHops} onChange={(e) => setMaxHops(parseInt(e.target.value || '7', 10))} className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full" />
              </Field>
            </>
          )}
          <Field label="jitter (+/- frac of mean)">
            <input type="number" step="0.01" min={0} max={0.5} value={jitter} onChange={(e) => setJitter(parseFloat(e.target.value) || 0)} className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full" />
          </Field>
        </div>
        {fund.error && (
          <div className="mt-3 text-sm">
            <p className="text-[var(--color-danger)]">{fund.error.message}</p>
            <p className="text-xs text-[var(--color-muted)] mt-1">
              The browser request errored, but the server may have completed the funding
              anyway (large multi-hop runs can take 1-2 minutes). Check the docked Logs panel
              below for <span className="mono">funding</span> events, then refresh the wallet
              balances above to confirm.
            </p>
          </div>
        )}
        {fund.data && (
          <div className="mt-3 text-xs">
            <p className="text-[var(--color-accent)]">
              ✓ Distributed {fund.data.totalSol.toFixed(4)} SOL to {fund.data.recipients.length} wallets
              {fund.data.failed.length > 0 && (
                <span className="text-[var(--color-warn)]">
                  {' '}
                  ({fund.data.failed.length} failed)
                </span>
              )}
              .
            </p>
            <ul className="mt-1 space-y-0.5 mono text-[var(--color-muted)] max-h-32 overflow-auto">
              {fund.data.recipients.map((r) => (
                <li key={r.pubkey}>
                  {shorten(r.pubkey, 8, 6)} → {r.sol.toFixed(4)} SOL ({r.hops} hop{r.hops === 1 ? '' : 's'})
                </li>
              ))}
            </ul>
            {fund.data.failed.length > 0 && (
              <>
                <p className="text-[var(--color-warn)] mt-2">failed:</p>
                <ul className="mt-1 space-y-0.5 mono text-[var(--color-muted)] max-h-32 overflow-auto">
                  {fund.data.failed.map((r) => (
                    <li key={r.pubkey}>
                      {shorten(r.pubkey, 8, 6)} — {r.error}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <button
          onClick={() =>
            fund.mutate({
              funderLabel: funder,
              recipientTag,
              perWalletSol: perWallet,
              jitterFraction: jitter,
              multiHop,
              minHops,
              maxHops,
            })
          }
          disabled={!funder || !recipientCount || perWallet <= 0 || fund.isPending}
          className="mt-4 px-4 py-2 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
        >
          {fund.isPending ? 'distributing...' : `fund ${recipientCount} wallets`}
        </button>
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-1">Liquidate tokens (no sweep)</h3>
        <p className="text-xs text-[var(--color-muted)] mb-3">
          Swap residual SPL token balances back to <strong>SOL</strong> on every wallet
          matching <span className="mono">{liqSourceTag}</span> via Jupiter. SOL stays on
          each wallet — nothing is swept. Use this to <strong>unstick</strong> the volume
          strategy after a stop/restart: the strict-alternate FSM forces every wallet's
          first trade to be a buy, but wallets that still hold tokens from the prior run
          have low SOL and skip on <span className="mono">native SOL below swap + rent
          reserve</span>. Liquidate clears those balances, refilling SOL so the next run
          starts cleanly. Leave <em>mint</em> blank to liquidate every non-SOL balance, or
          paste a mint to target just one (e.g. the active pool's base mint).
        </p>
        <div className="grid md:grid-cols-4 gap-3">
          <Field label={`source tag — ${liqSourceWallets.length} wallets`}>
            <input
              value={liqSourceTag}
              onChange={(e) => setLiqSourceTag(e.target.value)}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
            />
          </Field>
          <Field label="mint (optional)">
            <input
              value={liqMint}
              onChange={(e) => setLiqMint(e.target.value)}
              placeholder="leave blank for all"
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
            />
          </Field>
          <Field label="slippage (bps)">
            <input
              type="number"
              min={1}
              max={5_000}
              value={liqSlippage}
              onChange={(e) => setLiqSlippage(parseInt(e.target.value || '300', 10))}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
            />
          </Field>
          <Field label="concurrency">
            <input
              type="number"
              min={1}
              max={16}
              value={liqConcurrency}
              onChange={(e) => setLiqConcurrency(parseInt(e.target.value || '4', 10))}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
            />
          </Field>
        </div>
        {liquidateMut.error && (
          <p className="text-sm text-[var(--color-danger)] mt-3">
            {liquidateMut.error.message}
          </p>
        )}
        {liquidateMut.data && (
          <div className="mt-3 text-xs space-y-2">
            <p className="text-[var(--color-accent)]">
              ✓ Liquidated {liquidateMut.data.totalLiquidated} balance
              {liquidateMut.data.totalLiquidated === 1 ? '' : 's'} across{' '}
              {liquidateMut.data.wallets.length} wallet
              {liquidateMut.data.wallets.length === 1 ? '' : 's'} ({liquidateMut.data.totalTxs}{' '}
              tx{liquidateMut.data.totalTxs === 1 ? '' : 's'}).
            </p>
            <ul className="space-y-0.5 mono text-[var(--color-muted)] max-h-32 overflow-auto">
              {liquidateMut.data.wallets.map((w) => (
                <li key={w.pubkey}>
                  {shorten(w.pubkey, 8, 6)} · liq {w.liquidatedTokens} · {w.txCount} tx
                  {w.txCount === 1 ? '' : 's'}
                </li>
              ))}
            </ul>
            {liquidateMut.data.failed.length > 0 && (
              <div>
                <p className="text-[var(--color-danger)] font-medium">
                  ✗ {liquidateMut.data.failed.length} failed:
                </p>
                <ul className="space-y-0.5 mono text-[var(--color-danger)] max-h-32 overflow-auto">
                  {liquidateMut.data.failed.map((f) => (
                    <li key={f.source}>
                      {shorten(f.source, 8, 6)} — {f.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <button
          onClick={() => {
            if (liqSourceWallets.length === 0) return;
            const lines = [
              `Liquidate residual tokens on ${liqSourceWallets.length} wallet${
                liqSourceWallets.length === 1 ? '' : 's'
              } tagged '${liqSourceTag}'.`,
              liqMint
                ? `Mint filter: ${liqMint.slice(0, 8)}…`
                : 'All non-SOL balances will be swapped.',
              `Slippage ${liqSlippage} bps. SOL stays on each wallet (no sweep).`,
            ];
            if (!confirm(lines.join('\n'))) return;
            liquidateMut.mutate({
              sourceTag: liqSourceTag,
              mint: liqMint.trim() || undefined,
              slippageBps: liqSlippage,
              concurrency: liqConcurrency,
            });
          }}
          disabled={liqSourceWallets.length === 0 || liquidateMut.isPending}
          className="mt-4 px-4 py-2 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
        >
          {liquidateMut.isPending
            ? 'liquidating...'
            : `liquidate ${liqSourceWallets.length} wallet${liqSourceWallets.length === 1 ? '' : 's'}`}
        </button>
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-1">Gather funds</h3>
        <p className="text-xs text-[var(--color-muted)] mb-3">
          Sweep every lamport (and optionally every SPL token balance) from all wallets
          matching a tag back to one or more destination wallets in this vault. Token
          accounts are closed on the way to recover their rent. Source wallets end at zero.
          Destinations are excluded from the source list automatically.{' '}
          <strong>Advanced</strong> exposes <em>multi-destination</em>,{' '}
          <em>phased delay</em>, and <em>liquidate-before-sweep</em> for opsec-aware
          gathering. To sweep to an address outside this vault, use{' '}
          <span className="mono">pnpm cli sweep --to &lt;pubkey&gt;</span>.
        </p>
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="source tag">
            <input
              value={gatherSourceTag}
              onChange={(e) => setGatherSourceTag(e.target.value)}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
            />
          </Field>
          <Field
            label={`destination wallet — ${gatherSourceWallets.length} sources, total ${(
              gatherSourceTotalLamports / 1e9
            ).toFixed(4)} SOL`}
          >
            <select
              value={gatherDest}
              onChange={(e) => setGatherDest(e.target.value)}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
            >
              <option value="">— pick —</option>
              {(wallets.data ?? []).map((w) => (
                <option key={w.label} value={w.label}>
                  {w.label} ({fmtSol(w.balanceLamports)} SOL)
                </option>
              ))}
            </select>
          </Field>
          <Field label="concurrency">
            <input
              type="number"
              min={1}
              max={16}
              value={gatherConcurrency}
              onChange={(e) =>
                setGatherConcurrency(parseInt(e.target.value || '4', 10))
              }
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
            />
          </Field>
          <Field label="sweep tokens">
            <label className="flex items-center gap-2 mt-2">
              <input
                type="checkbox"
                checked={gatherIncludeTokens}
                onChange={(e) => setGatherIncludeTokens(e.target.checked)}
              />
              {gatherIncludeTokens
                ? 'on (move SPL balances + close ATAs)'
                : 'off (SOL only)'}
            </label>
          </Field>
        </div>
        <button
          type="button"
          onClick={() => setGatherShowAdvanced((v) => !v)}
          className="mt-3 text-xs text-[var(--color-muted)] hover:underline"
        >
          {gatherShowAdvanced ? '▾ hide advanced gather options' : '▸ show advanced gather options'}
        </button>
        {gatherShowAdvanced && (
          <div className="mt-2 p-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] space-y-3">
            <Field label={`extra destinations (round-robin) — ${gatherDests.length} selected`}>
              <select
                multiple
                size={Math.min(6, Math.max(2, (wallets.data?.length ?? 2)))}
                value={gatherDests}
                onChange={(e) =>
                  setGatherDests(
                    Array.from(e.target.selectedOptions, (o) => o.value),
                  )
                }
                className="bg-[var(--color-card)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
              >
                {(wallets.data ?? []).map((w) => (
                  <option key={w.label} value={w.label}>
                    {w.label} ({fmtSol(w.balanceLamports)} SOL)
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-[10px] text-[var(--color-muted)] leading-snug">
              Multi-destination breaks the "all roads lead to wallet X" pattern. Pick 2-3
              collector wallets here (in addition to the primary destination above) and
              the gather will randomly assign each source to one of them. Hold ctrl/cmd to
              select multiple. Empty = single-destination behaviour.
            </p>
            <div className="grid md:grid-cols-2 gap-3">
              <Field label="phase delay min (sec)">
                <input
                  type="number"
                  step="1"
                  min={0}
                  value={gatherPhaseMin}
                  onChange={(e) => setGatherPhaseMin(parseFloat(e.target.value) || 0)}
                  className="bg-[var(--color-card)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
                />
              </Field>
              <Field label="phase delay max (sec)">
                <input
                  type="number"
                  step="1"
                  min={0}
                  value={gatherPhaseMax}
                  onChange={(e) => setGatherPhaseMax(parseFloat(e.target.value) || 0)}
                  className="bg-[var(--color-card)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
                />
              </Field>
            </div>
            <p className="text-[10px] text-[var(--color-muted)] leading-snug">
              Phasing forces sequential sweeps with a random uniform delay drawn from
              [min, max] seconds between each source. Removes the "all sources sweep in
              the same minute" temporal correlation. When non-zero, concurrency is
              ignored. e.g. <span className="mono">min=300 max=1800</span> = 5-30 min
              between each sub-wallet sweep.
            </p>
            <div className="grid md:grid-cols-2 gap-3">
              <Field label="liquidate tokens to SOL first">
                <label className="flex items-center gap-2 mt-2">
                  <input
                    type="checkbox"
                    checked={gatherLiquidate}
                    onChange={(e) => setGatherLiquidate(e.target.checked)}
                  />
                  {gatherLiquidate ? 'on (Jupiter swap → SOL)' : 'off (transfer tokens as-is)'}
                </label>
              </Field>
              {gatherLiquidate && (
                <Field label="liquidate slippage bps">
                  <input
                    type="number"
                    min={1}
                    max={5_000}
                    value={gatherLiquidateSlippage}
                    onChange={(e) =>
                      setGatherLiquidateSlippage(parseInt(e.target.value || '300', 10))
                    }
                    className="bg-[var(--color-card)] border border-[var(--color-border)] rounded px-2 py-1 mono w-full"
                  />
                </Field>
              )}
            </div>
            <p className="text-[10px] text-[var(--color-muted)] leading-snug">
              Liquidate sells residual non-SOL token balances on each source (via Jupiter)
              before the sweep. The destination then only ever receives SOL — never the
              token — so the on-chain trace from "sub-wallet bought GLOOM" to "destination
              received GLOOM" never forms. One Jupiter swap per non-zero, non-quote token
              per source; pair with high slippage if the residual balances are small.
            </p>
          </div>
        )}
        {gatherMut.error && (
          <p className="text-sm text-[var(--color-danger)] mt-3">
            {gatherMut.error.message}
          </p>
        )}
        {gatherMut.data && (
          <div className="mt-3 text-xs space-y-2">
            <p className="text-[var(--color-accent)]">
              ✓ Swept {gatherMut.data.wallets.length} wallets ({gatherMut.data.totalTxs} txs)
              into {gatherMut.data.destinations.length} destination
              {gatherMut.data.destinations.length === 1 ? '' : 's'}
              {gatherMut.data.totalLiquidated > 0
                ? ` — liquidated ${gatherMut.data.totalLiquidated} token balance${gatherMut.data.totalLiquidated === 1 ? '' : 's'} via Jupiter`
                : ''}.
            </p>
            <ul className="space-y-0.5 mono text-[var(--color-muted)] max-h-32 overflow-auto">
              {gatherMut.data.wallets.map((w) => (
                <li key={w.pubkey}>
                  {shorten(w.pubkey, 8, 6)} → {shorten(w.destination, 8, 6)} ·{' '}
                  {w.txCount} tx{w.txCount === 1 ? '' : 's'}
                  {w.liquidatedTokens > 0 ? ` · liq ${w.liquidatedTokens}` : ''}
                </li>
              ))}
            </ul>
            {gatherMut.data.failed.length > 0 && (
              <div>
                <p className="text-[var(--color-danger)] font-medium">
                  ✗ {gatherMut.data.failed.length} failed:
                </p>
                <ul className="space-y-0.5 mono text-[var(--color-danger)] max-h-32 overflow-auto">
                  {gatherMut.data.failed.map((f) => (
                    <li key={f.source}>
                      {shorten(f.source, 8, 6)} — {f.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <button
          onClick={() => {
            if (!gatherDest || gatherSourceWallets.length === 0) return;
            const allDests = Array.from(new Set([gatherDest, ...gatherDests]));
            const summary = gatherSourceWallets.length;
            const totalSol = (gatherSourceTotalLamports / 1e9).toFixed(4);
            const phased = gatherPhaseMin > 0 || gatherPhaseMax > 0;
            const lines = [
              `Sweep ${summary} wallet${summary === 1 ? '' : 's'} (~${totalSol} SOL` +
                `${gatherIncludeTokens ? ' + tokens' : ''}) to ${allDests.length} ` +
                `destination${allDests.length === 1 ? '' : 's'}: ${allDests.join(', ')}.`,
              gatherLiquidate
                ? `Tokens will be liquidated to SOL on each source via Jupiter first ` +
                  `(slippage ${gatherLiquidateSlippage} bps).`
                : null,
              phased
                ? `Phased: sequential, ${gatherPhaseMin}-${gatherPhaseMax}s delay between sources.`
                : null,
              'Source wallets will end at zero.',
            ].filter(Boolean);
            if (!confirm(lines.join('\n'))) return;
            gatherMut.mutate({
              sourceTag: gatherSourceTag,
              destinationLabels: allDests,
              includeTokens: gatherIncludeTokens,
              liquidate: gatherLiquidate,
              liquidateSlippageBps: gatherLiquidateSlippage,
              phaseMinDelaySec: gatherPhaseMin,
              phaseMaxDelaySec: gatherPhaseMax,
              concurrency: gatherConcurrency,
            });
          }}
          disabled={
            !gatherDest ||
            gatherSourceWallets.length === 0 ||
            gatherMut.isPending
          }
          className="mt-4 px-4 py-2 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
        >
          {gatherMut.isPending
            ? 'sweeping...'
            : `gather ${gatherSourceWallets.length} wallet${gatherSourceWallets.length === 1 ? '' : 's'}`}
        </button>
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-3">Wallets ({wallets.data?.length ?? 0})</h3>
        {wallets.isLoading && <p className="text-sm text-[var(--color-muted)]">loading...</p>}
        {wallets.data && wallets.data.length === 0 && <p className="text-sm text-[var(--color-muted)]">vault is empty.</p>}
        {wallets.data && wallets.data.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-muted)] text-xs uppercase">
              <tr>
                <th className="py-1">label</th>
                <th>pubkey</th>
                <th>tags</th>
                <th className="text-right">balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {wallets.data.map((w) => (
                <tr key={w.label} className="border-t border-[var(--color-border)]">
                  <td className="py-2 mono">{w.label}</td>
                  <td className="mono">{shorten(w.pubkey, 8, 6)}</td>
                  <td className="text-xs">{w.tags.join(', ')}</td>
                  <td className="text-right mono">
                    {w.balanceError ? (
                      <span
                        className="text-[var(--color-danger)] cursor-help"
                        title={w.balanceError}
                      >
                        rpc err
                      </span>
                    ) : (
                      <>{fmtSol(w.balanceLamports)} SOL</>
                    )}
                  </td>
                  <td className="text-right">
                    <button
                      onClick={() => {
                        if (confirm(`remove ${w.label}?`)) remove.mutate({ label: w.label });
                      }}
                      className="text-xs text-[var(--color-danger)] hover:underline"
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
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
