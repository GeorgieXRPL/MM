'use client';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { LogPanel } from '@/components/LogPanel';

const VENUES = ['jupiter', 'pumpswap', 'raydium-amm-v4', 'raydium-cpmm', 'raydium-clmm', 'orca-whirlpools', 'meteora-dlmm'] as const;

export default function RunsPage() {
  const utils = trpc.useUtils();
  const runs = trpc.runs.list.useQuery({ limit: 50 });
  const active = trpc.runs.active.useQuery();
  const wallets = trpc.vault.listWallets.useQuery();
  const invalidateAll = () => {
    utils.runs.list.invalidate();
    utils.runs.active.invalidate();
  };
  const start = trpc.runs.startVolume.useMutation({ onSuccess: invalidateAll });
  const startMet = trpc.runs.startMeteoraLp.useMutation({ onSuccess: invalidateAll });
  const startInv = trpc.runs.startInventoryRebalance.useMutation({ onSuccess: invalidateAll });
  const startCm = trpc.runs.startCounterMomentum.useMutation({ onSuccess: invalidateAll });
  const stop = trpc.runs.stop.useMutation({ onSuccess: invalidateAll });
  const pause = trpc.runs.pause.useMutation({ onSuccess: invalidateAll });
  const resume = trpc.runs.resume.useMutation({ onSuccess: invalidateAll });
  const update = trpc.runs.update.useMutation({ onSuccess: invalidateAll });

  const [poolId, setPoolId] = useState('');
  const [venue, setVenue] = useState<(typeof VENUES)[number]>('jupiter');
  const [baseMint, setBaseMint] = useState('');
  const [quoteMint, setQuoteMint] = useState('So11111111111111111111111111111111111111112');
  const [walletTag, setWalletTag] = useState('volume');
  const [meanSize, setMeanSize] = useState(0.05);
  const [minSize, setMinSize] = useState(0.005);
  const [maxSize, setMaxSize] = useState(1);
  const [sizeLogStd, setSizeLogStd] = useState(0.6);
  const [slippageBps, setSlippageBps] = useState(100);
  const [dryRun, setDryRun] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Volume preset + rotation knobs
  const [volMode, setVolMode] = useState<'organic' | 'passive' | 'scheduled'>('organic');
  const [activeStartHour, setActiveStartHour] = useState(14);
  const [activeEndHour, setActiveEndHour] = useState(22);
  const [globalIntervalSec, setGlobalIntervalSec] = useState(0);
  const [minIntervalSec, setMinIntervalSec] = useState(0);
  const [walletTradeCap, setWalletTradeCap] = useState(0);
  const [walletCooldownSec, setWalletCooldownSec] = useState(0);
  const [slippageJitter, setSlippageJitter] = useState(0);
  const [priorityFee, setPriorityFee] = useState(0);
  const [priorityFeeJitter, setPriorityFeeJitter] = useState(0);
  const [cuJitter, setCuJitter] = useState(0);
  const [useJito, setUseJito] = useState(true);

  // Inventory-rebalance form state
  const [invPool, setInvPool] = useState('');
  const [invVenue, setInvVenue] = useState<(typeof VENUES)[number]>('jupiter');
  const [invBaseMint, setInvBaseMint] = useState('');
  const [invQuoteMint, setInvQuoteMint] = useState('So11111111111111111111111111111111111111112');
  const [invWallet, setInvWallet] = useState('');
  const [invTargetFrac, setInvTargetFrac] = useState(0.5);
  const [invDrift, setInvDrift] = useState(0.05);
  const [invSlippage, setInvSlippage] = useState(100);
  const [invMaxTrade, setInvMaxTrade] = useState(1);
  const [invDryRun, setInvDryRun] = useState(true);

  // Counter-momentum form state
  const [cmPool, setCmPool] = useState('');
  const [cmVenue, setCmVenue] = useState<(typeof VENUES)[number]>('jupiter');
  const [cmBaseMint, setCmBaseMint] = useState('');
  const [cmQuoteMint, setCmQuoteMint] = useState('So11111111111111111111111111111111111111112');
  const [cmWallet, setCmWallet] = useState('');
  const [cmTrigger, setCmTrigger] = useState(0.02);
  const [cmLookbackSec, setCmLookbackSec] = useState(300);
  const [cmSizeFrac, setCmSizeFrac] = useState(0.1);
  const [cmMaxSize, setCmMaxSize] = useState(0.5);
  const [cmSlippage, setCmSlippage] = useState(100);
  const [cmDryRun, setCmDryRun] = useState(true);

  // Meteora LP form state
  const [mlPool, setMlPool] = useState('');
  const [mlWallet, setMlWallet] = useState('');
  const [mlMode, setMlMode] = useState<'two-sided' | 'quote-only' | 'base-only'>('two-sided');
  const [mlStrategy, setMlStrategy] = useState<'spot' | 'curve' | 'bid-ask'>('spot');
  const [mlWidth, setMlWidth] = useState(0.05);
  const [mlBinOffset, setMlBinOffset] = useState(1);
  const [mlHysteresis, setMlHysteresis] = useState(0.01);
  const [mlSlippage, setMlSlippage] = useState(80);
  const [mlCompound, setMlCompound] = useState(true);
  const [mlAutoRedeploy, setMlAutoRedeploy] = useState(true);
  const [mlInventorySwap, setMlInventorySwap] = useState(true);
  const [mlTargetBaseFrac, setMlTargetBaseFrac] = useState(0.5);
  const [mlDryRun, setMlDryRun] = useState(true);

  // Edit modal
  const [editRunId, setEditRunId] = useState<number | null>(null);
  const [editWidth, setEditWidth] = useState('');
  const [editHyst, setEditHyst] = useState('');
  const [editSlip, setEditSlip] = useState('');
  const [editFeeMs, setEditFeeMs] = useState('');
  const [editTargetFrac, setEditTargetFrac] = useState('');
  const [editCompound, setEditCompound] = useState<'' | 'true' | 'false'>('');
  const [editAutoRedeploy, setEditAutoRedeploy] = useState<'' | 'true' | 'false'>('');
  const [editDryRun, setEditDryRun] = useState<'' | 'true' | 'false'>('');

  function openEdit(runId: number) {
    setEditRunId(runId);
    setEditWidth('');
    setEditHyst('');
    setEditSlip('');
    setEditFeeMs('');
    setEditTargetFrac('');
    setEditCompound('');
    setEditAutoRedeploy('');
    setEditDryRun('');
  }

  function submitEdit() {
    if (editRunId === null) return;
    const patch: Record<string, unknown> = {};
    if (editWidth) patch.widthFraction = parseFloat(editWidth);
    if (editHyst) patch.rebalanceHysteresis = parseFloat(editHyst);
    if (editSlip) patch.slippageBps = parseInt(editSlip, 10);
    if (editFeeMs) patch.feeClaimIntervalMs = parseInt(editFeeMs, 10);
    if (editTargetFrac) patch.targetBaseFraction = parseFloat(editTargetFrac);
    if (editCompound) patch.compoundFees = editCompound === 'true';
    if (editAutoRedeploy) patch.autoRedeployOnFill = editAutoRedeploy === 'true';
    if (editDryRun) patch.dryRun = editDryRun === 'true';
    update.mutate(
      { runId: editRunId, patch },
      { onSettled: () => setEditRunId(null) },
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-3">Start volume run</h3>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="pool id"><input value={poolId} onChange={(e) => setPoolId(e.target.value)} className="input mono" placeholder="pool pubkey" /></Field>
          <Field label="venue">
            <select value={venue} onChange={(e) => setVenue(e.target.value as typeof venue)} className="input">
              {VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="base mint (req for jupiter)"><input value={baseMint} onChange={(e) => setBaseMint(e.target.value)} className="input mono" /></Field>
          <Field label="quote mint"><input value={quoteMint} onChange={(e) => setQuoteMint(e.target.value)} className="input mono" /></Field>
          <Field label="wallet tag"><input value={walletTag} onChange={(e) => setWalletTag(e.target.value)} className="input mono" /></Field>
          <Field label="mean size (quote, SOL)"><input type="number" step="0.0001" min={0} value={meanSize} onChange={(e) => setMeanSize(parseFloat(e.target.value) || 0)} className="input mono" /></Field>
          <Field label="slippage bps"><input type="number" value={slippageBps} onChange={(e) => { const n = parseInt(e.target.value, 10); if (Number.isFinite(n) && n >= 0) setSlippageBps(n); }} className="input mono" /></Field>
          <Field label="behaviour">
            <select value={volMode} onChange={(e) => setVolMode(e.target.value as typeof volMode)} className="input">
              <option value="organic">organic (FSM, generative)</option>
              <option value="passive">passive (flat + alternate)</option>
              <option value="scheduled">scheduled (passive + UTC window)</option>
            </select>
          </Field>
          <Field label="dry run">
            <label className="flex items-center gap-2 mt-2">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> log only
            </label>
          </Field>
          <Field label="route via Jito (recommended)">
            <label className="flex items-center gap-2 mt-2">
              <input type="checkbox" checked={useJito} onChange={(e) => setUseJito(e.target.checked)} />
              {useJito ? 'on - bypasses public mempool, costs tip per trade' : 'off - public mempool'}
            </label>
          </Field>
          {volMode === 'scheduled' && (
            <>
              <Field label="active start hour (UTC)">
                <input type="number" min={0} max={23} value={activeStartHour} onChange={(e) => setActiveStartHour(parseInt(e.target.value, 10) || 0)} className="input mono" />
              </Field>
              <Field label="active end hour (UTC)">
                <input type="number" min={0} max={23} value={activeEndHour} onChange={(e) => setActiveEndHour(parseInt(e.target.value, 10) || 0)} className="input mono" />
              </Field>
            </>
          )}
        </div>
        <p className="mt-2 text-[10px] text-[var(--color-muted)] leading-snug">
          <strong>organic</strong>: Markov FSM (quiet/accumulate/distribute/burst) with natural-looking
          variance — manipulative volume manufacturing.{' '}
          <strong>passive</strong>: flat FSM, low rate (~1 trade per 3 min), strict buy/sell
          alternation — net-zero price impact, just "presence".{' '}
          <strong>scheduled</strong>: passive + sleeps outside the configured UTC window. Wraps over
          midnight, e.g. <span className="mono">22 → 6</span> = 22:00–06:00 UTC.
        </p>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="mt-3 text-xs text-[var(--color-muted)] hover:underline"
        >
          {showAdvanced ? '▾ hide advanced sizing' : '▸ show advanced sizing'}
        </button>
        {showAdvanced && (
          <div className="grid md:grid-cols-3 gap-3 mt-2 p-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
            <Field label="min size (quote, SOL)">
              <input type="number" step="0.0001" min={0} value={minSize} onChange={(e) => setMinSize(parseFloat(e.target.value) || 0)} className="input mono" />
            </Field>
            <Field label="max size (quote, SOL)">
              <input type="number" step="0.0001" min={0} value={maxSize} onChange={(e) => setMaxSize(parseFloat(e.target.value) || 0)} className="input mono" />
            </Field>
            <Field label="lognormal std (spread)">
              <input type="number" step="0.05" min={0.01} value={sizeLogStd} onChange={(e) => setSizeLogStd(parseFloat(e.target.value) || 0)} className="input mono" />
            </Field>
            <p className="md:col-span-3 text-[10px] text-[var(--color-muted)] leading-snug">
              <strong>min/max</strong> hard-clamp the per-swap size after sampling. <strong>std</strong> controls
              the lognormal spread: 0.3 = tight cluster around mean, 0.6 = ~95% within ~3x of mean (default),
              1.0+ = wide tails with occasional whales.
              <br />
              <strong>State multiplier:</strong> the volume strategy modulates size by an organic-flow state
              machine — <span className="mono">quiet</span>×0.5, <span className="mono">accumulate/distribute</span>×1.0,{' '}
              <span className="mono">burst</span>×1.8. Runs <em>start in quiet</em> for the first 4–12 trades, so
              early sizes will be roughly half of the values below.
              <br />
              Sample preview at mean={meanSize.toFixed(4)} std={sizeLogStd.toFixed(2)} (1.0× state):
              ~50% of swaps in{' '}
              <strong>
                {(meanSize * Math.exp(-sizeLogStd * 0.6745)).toFixed(4)} – {(meanSize * Math.exp(sizeLogStd * 0.6745)).toFixed(4)} SOL
              </strong>
              , ~95% in{' '}
              <strong>
                {Math.max(minSize, meanSize * Math.exp(-sizeLogStd * 1.96)).toFixed(4)} – {Math.min(maxSize, meanSize * Math.exp(sizeLogStd * 1.96)).toFixed(4)} SOL
              </strong>
              . In <span className="mono">quiet</span> divide by 2; in <span className="mono">burst</span> multiply by ~1.8 (still capped by max).
            </p>
            <Field label="global interval (sec, 0=auto)">
              <input type="number" min={0} value={globalIntervalSec} onChange={(e) => setGlobalIntervalSec(parseInt(e.target.value, 10) || 0)} className="input mono" />
            </Field>
            <Field label="min interval (sec, 0=off)">
              <input type="number" min={0} value={minIntervalSec} onChange={(e) => setMinIntervalSec(parseInt(e.target.value, 10) || 0)} className="input mono" />
            </Field>
            <Field label="wallet trade cap (0=off)">
              <input type="number" min={0} value={walletTradeCap} onChange={(e) => setWalletTradeCap(parseInt(e.target.value, 10) || 0)} className="input mono" />
            </Field>
            <Field label="per-wallet cooldown (sec)">
              <input type="number" min={0} value={walletCooldownSec} onChange={(e) => setWalletCooldownSec(parseInt(e.target.value, 10) || 0)} className="input mono" />
            </Field>
            <Field label="slippage jitter (±frac)">
              <input type="number" step="0.05" min={0} max={0.9} value={slippageJitter} onChange={(e) => setSlippageJitter(parseFloat(e.target.value) || 0)} className="input mono" />
            </Field>
            <Field label="priority fee (μlamports/CU, 0=default)">
              <input type="number" min={0} value={priorityFee} onChange={(e) => setPriorityFee(parseInt(e.target.value, 10) || 0)} className="input mono" />
            </Field>
            <Field label="priority fee jitter (±frac)">
              <input type="number" step="0.05" min={0} max={0.9} value={priorityFeeJitter} onChange={(e) => setPriorityFeeJitter(parseFloat(e.target.value) || 0)} className="input mono" />
            </Field>
            <Field label="CU limit jitter (±frac)">
              <input type="number" step="0.05" min={0} max={0.9} value={cuJitter} onChange={(e) => setCuJitter(parseFloat(e.target.value) || 0)} className="input mono" />
            </Field>
            <p className="md:col-span-3 text-[10px] text-[var(--color-muted)] leading-snug">
              <strong>global interval</strong>: average seconds between trades GLOBALLY across all
              wallets. 0 = let the FSM decide (organic ~10s avg, passive ~50s avg). Set this to
              480 for ~8 min spacing, 600 for ~10 min, etc. Sleeps are sampled from a Poisson
              distribution with this mean and capped at 4× to avoid pathological waits.{' '}
              <strong>min interval</strong>: hard floor between any two trades. Poisson sampling
              has a heavy tail - ~28% of samples are under 1/3 of the mean. Setting min to e.g.
              ~30% of `global interval` (180 if global=600) tames bursty short gaps without
              killing the natural variance you want above the floor.{' '}
              <strong>wallet trade cap</strong>: retire a sub-wallet after this many successful trades.
              The loop drops it from the rotation pool after the cap; once every wallet is retired the
              run stops cleanly. Useful to keep the same N pubkeys from being forever associated with
              the same token.{' '}
              <strong>per-wallet cooldown</strong>: a wallet that just traded is skipped for at least
              this many seconds. Stops back-to-back txs from the same address - a strong forensic
              correlator.{' '}
              <strong>slippage jitter</strong>: ±fraction applied to the configured slippage on every
              trade (e.g. 0.3 with 200 bps = 140-260 bps range). Defeats slippage fingerprinting.
              <br />
              <strong>priority fee</strong> + jitter: jitter ±frac applied to the base micro-lamports/CU
              tip per trade. 0 base = use the executor default. Realistic real-wallet behaviour - the
              priority fee is one of the easiest tx-level fingerprints.{' '}
              <strong>CU jitter</strong>: ±frac applied to the CU limit per trade (cap floor 50_000).
              Real wallets vary their CU request based on simulator output; a fixed 600_000 across all
              your txs is a tell.
            </p>
          </div>
        )}
        {start.error && <p className="text-sm text-[var(--color-danger)] mt-3">{start.error.message}</p>}
        <button
          disabled={!poolId || start.isPending}
          onClick={() =>
            start.mutate({
              poolId,
              venue,
              baseMint: baseMint || undefined,
              quoteMint: quoteMint || undefined,
              walletTag,
              meanQuoteSize: meanSize,
              minQuoteSize: minSize,
              maxQuoteSize: maxSize,
              sizeLogStd,
              slippageBps,
              mode: volMode,
              activeStartHourUtc: volMode === 'scheduled' ? activeStartHour : undefined,
              activeEndHourUtc: volMode === 'scheduled' ? activeEndHour : undefined,
              globalIntervalSec,
              minIntervalSec,
              walletTradeCap,
              walletCooldownMs: walletCooldownSec * 1000,
              slippageJitter,
              priorityMicroLamports: priorityFee,
              priorityFeeJitter,
              cuJitter,
              useJito,
              dryRun,
            })
          }
          className="mt-4 px-4 py-2 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
        >
          {start.isPending ? 'starting...' : 'start'}
        </button>
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-3">Start Meteora LP</h3>
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="pool id"><input value={mlPool} onChange={(e) => setMlPool(e.target.value)} className="input mono" placeholder="lbPair pubkey" /></Field>
          <Field label="wallet">
            <select value={mlWallet} onChange={(e) => setMlWallet(e.target.value)} className="input">
              <option value="">— pick —</option>
              {wallets.data?.map((w) => <option key={w.label} value={w.label}>{w.label}</option>)}
            </select>
          </Field>
          <Field label="mode">
            <select value={mlMode} onChange={(e) => setMlMode(e.target.value as typeof mlMode)} className="input">
              <option value="two-sided">two-sided</option>
              <option value="quote-only">quote-only (buy ladder)</option>
              <option value="base-only">base-only (sell ladder)</option>
            </select>
          </Field>
          <Field label="strategy type">
            <select value={mlStrategy} onChange={(e) => setMlStrategy(e.target.value as typeof mlStrategy)} className="input">
              <option value="spot">spot (uniform)</option>
              <option value="curve">curve (centered)</option>
              <option value="bid-ask">bid-ask (edges)</option>
            </select>
          </Field>
          <Field label="width fraction"><input type="number" step="0.001" value={mlWidth} onChange={(e) => setMlWidth(parseFloat(e.target.value))} className="input mono" /></Field>
          {mlMode !== 'two-sided' && (
            <Field label="bin offset"><input type="number" value={mlBinOffset} onChange={(e) => setMlBinOffset(parseInt(e.target.value, 10) || 0)} className="input mono" /></Field>
          )}
          <Field label="rebalance hysteresis"><input type="number" step="0.001" value={mlHysteresis} onChange={(e) => setMlHysteresis(parseFloat(e.target.value))} className="input mono" /></Field>
          <Field label="slippage bps"><input type="number" value={mlSlippage} onChange={(e) => { const n = parseInt(e.target.value, 10); if (Number.isFinite(n) && n >= 0) setMlSlippage(n); }} className="input mono" /></Field>
          {mlMode === 'two-sided' && (
            <Field label="target base fraction"><input type="number" step="0.05" value={mlTargetBaseFrac} onChange={(e) => setMlTargetBaseFrac(parseFloat(e.target.value))} className="input mono" /></Field>
          )}
          <Field label="compound fees">
            <label className="flex items-center gap-2 mt-2">
              <input type="checkbox" checked={mlCompound} onChange={(e) => setMlCompound(e.target.checked)} /> on
            </label>
          </Field>
          {mlMode !== 'two-sided' && (
            <Field label="auto redeploy on fill">
              <label className="flex items-center gap-2 mt-2">
                <input type="checkbox" checked={mlAutoRedeploy} onChange={(e) => setMlAutoRedeploy(e.target.checked)} /> on
              </label>
            </Field>
          )}
          {mlMode === 'two-sided' && (
            <Field label="inventory swap to target">
              <label className="flex items-center gap-2 mt-2">
                <input type="checkbox" checked={mlInventorySwap} onChange={(e) => setMlInventorySwap(e.target.checked)} /> on
              </label>
            </Field>
          )}
          <Field label="dry run">
            <label className="flex items-center gap-2 mt-2">
              <input type="checkbox" checked={mlDryRun} onChange={(e) => setMlDryRun(e.target.checked)} /> log only
            </label>
          </Field>
        </div>
        {startMet.error && <p className="text-sm text-[var(--color-danger)] mt-3">{startMet.error.message}</p>}
        <button
          disabled={!mlPool || !mlWallet || startMet.isPending}
          onClick={() =>
            startMet.mutate({
              poolId: mlPool,
              walletLabel: mlWallet,
              mode: mlMode,
              strategyType: mlStrategy,
              widthFraction: mlWidth,
              binOffset: mlBinOffset,
              rebalanceHysteresis: mlHysteresis,
              slippageBps: mlSlippage,
              compoundFees: mlCompound,
              autoRedeployOnFill: mlAutoRedeploy,
              inventorySwapToTarget: mlInventorySwap,
              targetBaseFraction: mlTargetBaseFrac,
              dryRun: mlDryRun,
            })
          }
          className="mt-4 px-4 py-2 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
        >
          {startMet.isPending ? 'starting...' : 'start meteora-lp'}
        </button>
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-1">Start inventory rebalance</h3>
        <p className="text-xs text-[var(--color-muted)] mb-3">
          Reactive, non-manipulative LP-support strategy. Watches your wallet's base/quote ratio and
          only trades when it drifts past the threshold - direct response to real flow on the pool.
        </p>
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="pool id"><input value={invPool} onChange={(e) => setInvPool(e.target.value)} className="input mono" placeholder="pool pubkey" /></Field>
          <Field label="venue">
            <select value={invVenue} onChange={(e) => setInvVenue(e.target.value as typeof invVenue)} className="input">
              {VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="wallet">
            <select value={invWallet} onChange={(e) => setInvWallet(e.target.value)} className="input">
              <option value="">— pick —</option>
              {wallets.data?.map((w) => <option key={w.label} value={w.label}>{w.label}</option>)}
            </select>
          </Field>
          <Field label="base mint (req for jupiter)"><input value={invBaseMint} onChange={(e) => setInvBaseMint(e.target.value)} className="input mono" /></Field>
          <Field label="quote mint"><input value={invQuoteMint} onChange={(e) => setInvQuoteMint(e.target.value)} className="input mono" /></Field>
          <Field label="target base fraction"><input type="number" step="0.05" min={0} max={1} value={invTargetFrac} onChange={(e) => setInvTargetFrac(parseFloat(e.target.value) || 0)} className="input mono" /></Field>
          <Field label="drift threshold (frac)"><input type="number" step="0.005" min={0.005} max={0.5} value={invDrift} onChange={(e) => setInvDrift(parseFloat(e.target.value) || 0)} className="input mono" /></Field>
          <Field label="slippage bps"><input type="number" value={invSlippage} onChange={(e) => { const n = parseInt(e.target.value, 10); if (Number.isFinite(n) && n >= 0) setInvSlippage(n); }} className="input mono" /></Field>
          <Field label="max trade (SOL)"><input type="number" step="0.01" value={invMaxTrade} onChange={(e) => setInvMaxTrade(parseFloat(e.target.value) || 0)} className="input mono" /></Field>
          <Field label="dry run">
            <label className="flex items-center gap-2 mt-2">
              <input type="checkbox" checked={invDryRun} onChange={(e) => setInvDryRun(e.target.checked)} /> log only
            </label>
          </Field>
        </div>
        {startInv.error && <p className="text-sm text-[var(--color-danger)] mt-3">{startInv.error.message}</p>}
        <button
          disabled={!invPool || !invWallet || startInv.isPending}
          onClick={() =>
            startInv.mutate({
              poolId: invPool,
              venue: invVenue,
              walletLabel: invWallet,
              baseMint: invBaseMint || undefined,
              quoteMint: invQuoteMint || undefined,
              targetBaseFraction: invTargetFrac,
              driftThreshold: invDrift,
              slippageBps: invSlippage,
              maxTradeQuote: invMaxTrade,
              dryRun: invDryRun,
            })
          }
          className="mt-4 px-4 py-2 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
        >
          {startInv.isPending ? 'starting...' : 'start inventory-rebalance'}
        </button>
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-1">Start counter-momentum</h3>
        <p className="text-xs text-[var(--color-muted)] mb-3">
          Mean-reversion strategy. Holds a rolling price baseline and only fires when price moves
          past the trigger threshold: buys dips, sells rallies. Provides counter-flow liquidity to
          natural market moves; does not generate fake volume.
        </p>
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="pool id"><input value={cmPool} onChange={(e) => setCmPool(e.target.value)} className="input mono" placeholder="pool pubkey" /></Field>
          <Field label="venue">
            <select value={cmVenue} onChange={(e) => setCmVenue(e.target.value as typeof cmVenue)} className="input">
              {VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="wallet">
            <select value={cmWallet} onChange={(e) => setCmWallet(e.target.value)} className="input">
              <option value="">— pick —</option>
              {wallets.data?.map((w) => <option key={w.label} value={w.label}>{w.label}</option>)}
            </select>
          </Field>
          <Field label="base mint (req for jupiter)"><input value={cmBaseMint} onChange={(e) => setCmBaseMint(e.target.value)} className="input mono" /></Field>
          <Field label="quote mint"><input value={cmQuoteMint} onChange={(e) => setCmQuoteMint(e.target.value)} className="input mono" /></Field>
          <Field label="trigger pct (frac)"><input type="number" step="0.005" min={0.001} max={0.5} value={cmTrigger} onChange={(e) => setCmTrigger(parseFloat(e.target.value) || 0)} className="input mono" /></Field>
          <Field label="lookback (sec)"><input type="number" min={30} value={cmLookbackSec} onChange={(e) => setCmLookbackSec(parseInt(e.target.value, 10) || 0)} className="input mono" /></Field>
          <Field label="size fraction (of bal)"><input type="number" step="0.05" min={0.001} max={1} value={cmSizeFrac} onChange={(e) => setCmSizeFrac(parseFloat(e.target.value) || 0)} className="input mono" /></Field>
          <Field label="max trade (SOL)"><input type="number" step="0.01" value={cmMaxSize} onChange={(e) => setCmMaxSize(parseFloat(e.target.value) || 0)} className="input mono" /></Field>
          <Field label="slippage bps"><input type="number" value={cmSlippage} onChange={(e) => { const n = parseInt(e.target.value, 10); if (Number.isFinite(n) && n >= 0) setCmSlippage(n); }} className="input mono" /></Field>
          <Field label="dry run">
            <label className="flex items-center gap-2 mt-2">
              <input type="checkbox" checked={cmDryRun} onChange={(e) => setCmDryRun(e.target.checked)} /> log only
            </label>
          </Field>
        </div>
        {startCm.error && <p className="text-sm text-[var(--color-danger)] mt-3">{startCm.error.message}</p>}
        <button
          disabled={!cmPool || !cmWallet || startCm.isPending}
          onClick={() =>
            startCm.mutate({
              poolId: cmPool,
              venue: cmVenue,
              walletLabel: cmWallet,
              baseMint: cmBaseMint || undefined,
              quoteMint: cmQuoteMint || undefined,
              triggerPct: cmTrigger,
              lookbackSec: cmLookbackSec,
              sizeFraction: cmSizeFrac,
              maxSizeQuote: cmMaxSize,
              slippageBps: cmSlippage,
              dryRun: cmDryRun,
            })
          }
          className="mt-4 px-4 py-2 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
        >
          {startCm.isPending ? 'starting...' : 'start counter-momentum'}
        </button>
      </div>

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-3">Active</h3>
        {!active.data || active.data.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">none.</p>
        ) : (
          <ul className="space-y-2">
            {active.data.map((r) => {
              const isMet = r.id === 'meteora-lp';
              return (
                <li key={r.runId} className="flex items-center justify-between text-sm">
                  <span className="mono">
                    #{r.runId} {r.id} {r.paused ? 'paused' : r.running ? 'running' : 'stopped'}
                  </span>
                  <span className="flex gap-3">
                    {isMet && !r.paused && (
                      <button
                        onClick={() => pause.mutate({ runId: r.runId })}
                        disabled={!r.running || pause.isPending}
                        className="text-[var(--color-warn)] hover:underline text-xs"
                      >
                        pause
                      </button>
                    )}
                    {isMet && r.paused && (
                      <button
                        onClick={() => resume.mutate({ runId: r.runId })}
                        disabled={resume.isPending}
                        className="text-[var(--color-accent)] hover:underline text-xs"
                      >
                        resume
                      </button>
                    )}
                    {isMet && (
                      <button
                        onClick={() => openEdit(r.runId)}
                        className="text-xs hover:underline"
                      >
                        edit
                      </button>
                    )}
                    <button
                      onClick={() => stop.mutate({ runId: r.runId })}
                      disabled={!r.running || stop.isPending}
                      className="text-[var(--color-danger)] hover:underline text-xs"
                    >
                      stop
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editRunId !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-6 w-[480px] max-w-[90vw]">
            <h3 className="font-medium mb-3">Edit run #{editRunId}</h3>
            <p className="text-xs text-[var(--color-muted)] mb-3">
              Leave blank to keep current value. Mode / strategyType cannot be changed at runtime.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="width fraction"><input value={editWidth} onChange={(e) => setEditWidth(e.target.value)} className="input mono" /></Field>
              <Field label="hysteresis"><input value={editHyst} onChange={(e) => setEditHyst(e.target.value)} className="input mono" /></Field>
              <Field label="slippage bps"><input value={editSlip} onChange={(e) => setEditSlip(e.target.value)} className="input mono" /></Field>
              <Field label="fee claim ms"><input value={editFeeMs} onChange={(e) => setEditFeeMs(e.target.value)} className="input mono" /></Field>
              <Field label="target base frac"><input value={editTargetFrac} onChange={(e) => setEditTargetFrac(e.target.value)} className="input mono" /></Field>
              <Field label="compound fees">
                <select value={editCompound} onChange={(e) => setEditCompound(e.target.value as typeof editCompound)} className="input">
                  <option value="">(no change)</option>
                  <option value="true">on</option>
                  <option value="false">off</option>
                </select>
              </Field>
              <Field label="auto redeploy">
                <select value={editAutoRedeploy} onChange={(e) => setEditAutoRedeploy(e.target.value as typeof editAutoRedeploy)} className="input">
                  <option value="">(no change)</option>
                  <option value="true">on</option>
                  <option value="false">off</option>
                </select>
              </Field>
              <Field label="dry run">
                <select value={editDryRun} onChange={(e) => setEditDryRun(e.target.value as typeof editDryRun)} className="input">
                  <option value="">(no change)</option>
                  <option value="true">on</option>
                  <option value="false">off</option>
                </select>
              </Field>
            </div>
            {update.error && <p className="text-sm text-[var(--color-danger)] mt-3">{update.error.message}</p>}
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => setEditRunId(null)} className="px-3 py-1 rounded border border-[var(--color-border)] text-sm">cancel</button>
              <button onClick={submitEdit} disabled={update.isPending} className="px-3 py-1 rounded bg-[var(--color-accent)] text-black text-sm">
                {update.isPending ? 'saving...' : 'save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <LogPanel />

      <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <h3 className="font-medium mb-3">History</h3>
        {!runs.data || runs.data.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">no runs.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-muted)] text-xs uppercase">
              <tr><th className="py-1">id</th><th>strategy</th><th>pool</th><th>status</th><th className="text-right">started</th></tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="border-t border-[var(--color-border)]">
                  <td className="py-2 mono">#{r.id}</td>
                  <td>{r.strategy}</td>
                  <td className="mono">{r.pool.slice(0, 14)}...</td>
                  <td>
                    <span className={r.status === 'running' ? 'text-[var(--color-accent)]' : r.status === 'errored' ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted)]'}>
                      {r.status}
                    </span>
                  </td>
                  <td className="text-right mono text-xs">{new Date(r.startedAt).toLocaleString()}</td>
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
