import { createRequire } from 'node:module';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js';
import BN from 'bn.js';
import {
  type AddLiquidityRequest,
  type BuiltSwap,
  type LpPosition,
  type PoolRef,
  type QuoteRequest,
  type QuoteResult,
  type RemoveLiquidityRequest,
  type SwapBuildRequest,
  type TokenInfo,
  applySlippageDown,
  applySlippageUp,
  createLogger,
  NATIVE_SOL_MINT,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
} from '@amm/shared';
import { Venue, VenueUnsupportedError } from './venue.js';
import { PumpBondingClient } from './pump-bonding.js';

const log = createLogger('venue:pumpswap');

/**
 * pump_amm program ID. Sourced from the on-chain anchor IDL
 * (`anchor idl fetch pAMMBay…`) so it stays in lock-step with the SDK.
 */
export const PUMP_AMM_PROGRAM_ID = new PublicKey(
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
);

/**
 * Discriminator for `pump_amm:transfer_creator_fees_to_pump`. This is the
 * permissionless ix that drains the pump_amm WSOL accumulator (where every
 * swap deposits its 0.05% creator fee) into the pump-bonding `creator_vault`
 * PDA, ready for `pump:distribute_creator_fees` to split it among
 * shareholders. Discriminator copied from the on-chain IDL — Anchor computes
 * it as sha256("global:transfer_creator_fees_to_pump").slice(0,8).
 */
const DISC_TRANSFER_CREATOR_FEES_TO_PUMP = Buffer.from([
  139, 52, 134, 85, 228, 229, 108, 241,
]);

/** Standard Anchor `__event_authority` PDA, derived under pump_amm. */
const PUMP_AMM_EVENT_AUTHORITY: PublicKey = (() => {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMP_AMM_PROGRAM_ID,
  );
  return pda;
})();

// The `@pump-fun/pump-swap-sdk` package ships a dual ESM/CJS build but its
// root `package.json` lacks `"type": "module"` and there is no
// `dist/esm/package.json` overriding it. Loaders that honour the `exports`
// `import` condition (Node ESM under tsx, etc.) pick `dist/esm/index.js`,
// which Node then attempts to parse as CJS and fails to expose named
// exports - producing `does not provide an export named 'PumpAmmSdk'`.
// Bundlers (Next.js webpack) don't hit this because they ignore Node's
// CJS heuristics. Use `createRequire` to force resolution through the CJS
// `dist/index.js` build, where named exports are well-formed via
// `module.exports = __toCommonJS(index_exports)`.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pumpSdk: any = requireCjs('@pump-fun/pump-swap-sdk');
const {
  PumpAmmSdk,
  OnlinePumpAmmSdk,
  buyQuoteInput,
  buyBaseInput,
  sellBaseInput,
  sellQuoteInput,
  canonicalPumpPoolPda,
  coinCreatorVaultAuthorityPda,
  coinCreatorVaultAtaPda,
} = pumpSdk;

// `swapSolanaState(poolKey, user)` requires a user pubkey only to derive
// ATAs that the *instruction* path needs. Quote math doesn't read them, so
// we pass a placeholder when called from `quote()`.
const QUOTE_STUB_USER = PublicKey.default;

/**
 * The SDK takes `slippage` as a *percent* (1 = 1%, 2 = 2%, 100 = 100%) - not
 * a fraction. Verified empirically: `slippage=2` produces a maxQuote of
 * `quote * 1.02`. Our public surface uses bps (200 = 2%), so divide by 100.
 */
function slippagePct(slippageBps: number): number {
  return slippageBps / 100;
}

/**
 * PumpSwap adapter - wraps the `@pump-fun/pump-swap-sdk` v1.14+ SDK.
 *
 * The SDK splits responsibilities across three surfaces and our adapter has
 * to use all three:
 *
 *   - `OnlinePumpAmmSdk(connection)` - network-aware: `fetchPool`,
 *     `swapSolanaState`, `liquiditySolanaState`, etc. Reads pool reserves
 *     and assembles the per-call solana state struct.
 *
 *   - `PumpAmmSdk()` - offline: instruction builders that take an already-
 *     fetched solana state and return `TransactionInstruction[]`. Methods
 *     such as `buyQuoteInput(state, amount, slippage)`.
 *
 *   - top-level functions `buyQuoteInput({ quote, baseReserve, ... })`,
 *     `sellBaseInput`, etc. These are *quote computation* helpers that
 *     return a result struct (`base`, `uiQuote`, `maxQuote`, ...) without
 *     building any instructions. Note the name collision with the offline
 *     SDK methods - they share names but take different shapes.
 *
 * Earlier this adapter only constructed `PumpAmmSdk(connection)` and tried
 * to call `fetchPool` / `swapSolanaState` on it. Those methods don't exist
 * on the offline class, the optional chains in `getPool` collapsed into
 * `new PublicKey('')` and the volume strategy crashed on its first live
 * iteration with `Invalid public key input` before any swap was attempted.
 */
export class PumpSwapVenue implements Venue {
  readonly id = 'pumpswap' as const;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly offline: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly online: any;

  /**
   * Maps the input pubkey (as the user supplied it) to the actual pumpswap
   * pool pubkey. Pump.fun users typically copy the *token mint* (vanity
   * `…pump` prefix) and expect it to "just work"; we transparently resolve
   * it via `canonicalPumpPoolPda` and cache so we only burn one extra RPC
   * per fresh input.
   */
  private readonly poolKeyCache = new Map<string, PublicKey>();

  constructor(private readonly connection: Connection) {
    this.offline = new PumpAmmSdk();
    this.online = new OnlinePumpAmmSdk(connection);
  }

  /**
   * Resolves whatever the caller passed (pool address OR token mint) to a
   * real pump_amm pool account. Tries the input directly first; if the
   * account fails to decode as a Pool we fall back to the canonical pump
   * pool PDA derived from treating the input as a base mint.
   */
  private async resolvePoolKey(input: PublicKey): Promise<PublicKey> {
    const key = input.toBase58();
    const cached = this.poolKeyCache.get(key);
    if (cached) return cached;

    try {
      await this.online.fetchPool(input);
      this.poolKeyCache.set(key, input);
      return input;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // Anchor surfaces this as "Invalid account discriminator" when the
      // account exists but isn't a Pool struct; surface anything else as-is.
      if (!/discriminator|account does not exist|invalid public key/i.test(msg)) {
        throw e;
      }
      const canonical: PublicKey = canonicalPumpPoolPda(input);
      log.warn(
        { input: key, canonical: canonical.toBase58() },
        'pumpswap: input is not a pool, treating as token mint and resolving canonical pool',
      );
      // Validate the canonical pool decodes; if not, the input was bogus.
      await this.online.fetchPool(canonical);
      this.poolKeyCache.set(key, canonical);
      return canonical;
    }
  }

  async getPool(
    poolId: PublicKey,
  ): Promise<PoolRef & { baseDecimals: number; quoteDecimals: number }> {
    const resolved = await this.resolvePoolKey(poolId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool: any = await this.online.fetchPool(resolved);
    if (!pool || !pool.baseMint || !pool.quoteMint) {
      throw new Error(`pumpswap pool ${resolved.toBase58()} not found or missing mints`);
    }
    const baseMint: PublicKey = pool.baseMint;
    const quoteMint: PublicKey = pool.quoteMint;

    const [bMint, qMint] = await Promise.all([
      this.connection.getParsedAccountInfo(baseMint),
      this.connection.getParsedAccountInfo(quoteMint),
    ]);
    const baseDecimals =
      (bMint.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
        ?.decimals ?? 6;
    const quoteDecimals =
      (qMint.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
        ?.decimals ?? 9;

    return {
      venue: this.id,
      poolId: resolved,
      baseMint,
      quoteMint,
      baseDecimals,
      quoteDecimals,
    };
  }

  async getTokenInfo(mint: PublicKey): Promise<TokenInfo> {
    const info = await this.connection.getParsedAccountInfo(mint);
    const decimals =
      (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
        ?.decimals ?? 0;
    return { mint, decimals };
  }

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    const resolvedPool = await this.resolvePoolKey(req.poolId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = await this.online.swapSolanaState(resolvedPool, QUOTE_STUB_USER);
    const isSellBase = req.inputMint.equals(state.baseMint);
    const slippage = slippagePct(req.slippageBps);

    const params = {
      slippage,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
    };

    let amountOutBn: BN;
    if (isSellBase) {
      // Sell N base tokens for quote (SOL).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = sellBaseInput({ base: req.amountIn, ...params });
      amountOutBn = new BN(r.uiQuote.toString());
    } else {
      // Buy base with N quote (SOL) - the common case in the volume probe.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = buyQuoteInput({ quote: req.amountIn, ...params });
      amountOutBn = new BN(r.base.toString());
    }

    return {
      amountIn: req.amountIn,
      amountOut: amountOutBn,
      minAmountOut: applySlippageDown(amountOutBn, req.slippageBps),
      priceImpactBps: 0,
      // The real `state` is keyed to QUOTE_STUB_USER and so cannot be
      // reused for instruction building (different ATAs); we deliberately
      // don't pass it through `route` to force buildSwap to fetch a fresh
      // state with the actual user.
      route: { isSellBase },
    };
  }

  /**
   * Read the pool's spot reserves (base + quote, both in atomic units).
   *
   * Used by callers that want a venue-native price source when third-party
   * APIs (Jupiter Price, etc.) don't index the token. Combined with the
   * caller's known decimals, the spot price is:
   *
   *   price_per_base_in_quote =
   *     (quoteReserve / 10^quoteDecimals) / (baseReserve / 10^baseDecimals)
   *
   * `anyUser` may be any pubkey; the SDK only uses it for ATA derivation and
   * the reserves are read from the pool's own vault accounts. We just pass
   * something stable to keep state caching happy.
   */
  async getReserves(
    poolId: PublicKey,
    anyUser: PublicKey,
  ): Promise<{ baseReserve: BN; quoteReserve: BN }> {
    const resolvedPool = await this.resolvePoolKey(poolId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = await this.online.swapSolanaState(resolvedPool, anyUser);
    return {
      baseReserve: new BN(state.poolBaseAmount.toString()),
      quoteReserve: new BN(state.poolQuoteAmount.toString()),
    };
  }

  async buildSwap(req: SwapBuildRequest): Promise<BuiltSwap> {
    const resolvedPool = await this.resolvePoolKey(req.poolId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = await this.online.swapSolanaState(resolvedPool, req.user);
    const isSellBase = req.inputMint.equals(state.baseMint);
    const slippage = slippagePct(req.slippageBps);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ixs: import('@solana/web3.js').TransactionInstruction[] = [];
    if (isSellBase) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ixs = await this.offline.sellBaseInput(state, req.amountIn, slippage);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ixs = await this.offline.buyQuoteInput(state, req.amountIn, slippage);
    }

    return { instructions: ixs };
  }

  async getPositions(poolId: PublicKey, owner: PublicKey): Promise<LpPosition[]> {
    try {
      const resolvedPool = await this.resolvePoolKey(poolId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const liq: any = await this.online.liquiditySolanaState(resolvedPool, owner);
      // The user's LP balance is exposed on the parsed user pool token
      // account info inside the solana state.
      const lpBalance: BN = (() => {
        const info = liq?.userPoolAccountInfo;
        // RawAccount-style: `{ amount: bigint }` after spl-token parse.
        const amt = (info as { amount?: bigint } | null)?.amount;
        return amt ? new BN(amt.toString()) : new BN(0);
      })();
      if (lpBalance.isZero()) return [];

      const pool = await this.getPool(resolvedPool);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wd: any = this.offline.withdrawAutoCompleteBaseAndQuoteFromLpToken?.(
        liq,
        lpBalance,
        0,
      );
      return [
        {
          venue: this.id,
          poolId: resolvedPool,
          // PumpSwap LP positions key off the pool itself (single LP mint
          // per pool); using the pool id keeps `buildRemoveLiquidity` calls
          // routing correctly.
          positionId: resolvedPool,
          owner,
          baseMint: pool.baseMint,
          quoteMint: pool.quoteMint,
          baseAmount: new BN(wd?.base?.toString?.() ?? '0'),
          quoteAmount: new BN(wd?.quote?.toString?.() ?? '0'),
          inRange: true,
        },
      ];
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'pumpswap getPositions failed');
      return [];
    }
  }

  async buildAddLiquidity(req: AddLiquidityRequest): Promise<BuiltSwap> {
    const resolvedPool = await this.resolvePoolKey(req.poolId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const liq: any = await this.online.liquiditySolanaState(resolvedPool, req.user);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ixs: import('@solana/web3.js').TransactionInstruction[] = await (
      this.offline as { depositInstructions?: (...a: unknown[]) => Promise<unknown> }
    ).depositInstructions
      ? ((await (this.offline as { depositInstructions: (...a: unknown[]) => Promise<unknown> }).depositInstructions(
          liq,
          req.baseAmountMax,
          slippagePct(req.slippageBps),
        )) as import('@solana/web3.js').TransactionInstruction[])
      : [];
    return { instructions: ixs };
  }

  /**
   * Returns the unclaimed WSOL balance sitting in the coin-creator vault for
   * `coinCreator`, in lamport units (atomic). The vault is hardcoded to WSOL
   * inside the pump-amm program (`OnlinePumpAmmSdk.collectCoinCreatorFeeSolanaState`
   * always sets `quoteMint = NATIVE_MINT`, regardless of the pool's actual
   * quote mint) so this is directly comparable to a SOL lamport threshold.
   *
   * Returns BN(0) if the vault account doesn't exist yet (no fees ever
   * accrued for this creator) — the SDK swallows the lookup error and
   * console-warns, which is fine for our polling use case.
   */
  async getCreatorVaultBalance(coinCreator: PublicKey): Promise<BN> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const balance: any = await this.online.getCoinCreatorVaultBalance(coinCreator);
    return new BN(balance.toString());
  }

  /**
   * Build the instruction list to claim all unclaimed coin-creator fees for
   * `coinCreator`. When `payer === coinCreator` (the standard case), the SDK
   * appends a `closeAccount(creatorWsolAta)` ix automatically, so after the
   * tx confirms the creator wallet just holds the new SOL natively.
   *
   * If a separate `payer` is configured, the auto-close is skipped and the
   * caller is responsible for unwrapping the WSOL ATA themselves (the
   * treasury engine handles that fallback path).
   */
  async buildCollectCreatorFee(
    coinCreator: PublicKey,
    payer: PublicKey,
  ): Promise<BuiltSwap> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = await this.online.collectCoinCreatorFeeSolanaState(
      coinCreator,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ixs: import('@solana/web3.js').TransactionInstruction[] =
      await this.offline.collectCoinCreatorFee(state, payer);
    return { instructions: ixs };
  }

  /**
   * Build `pump_amm:transfer_creator_fees_to_pump` for `coinCreator`.
   *
   * This is the **first half** of the migrated claim flow. Every PumpSwap
   * trade deposits its creator-fee slice as WSOL into the pump_amm vault ATA
   * (`coin_creator_vault_ata`); that's where the bulk of unclaimed fees
   * actually live for any pool whose creator vault has been migrated to a
   * fee-sharing config. This ix unwraps that WSOL into native SOL and moves
   * it into the `pump:creator_vault` PDA, where `distribute_creator_fees`
   * can then split it among the configured shareholders.
   *
   * Permissionless: no signers required beyond a fee payer. Returns the raw
   * ix so the caller can pack it next to `distribute_creator_fees` in a
   * single atomic tx.
   *
   * Account ordering and PDAs verified against the on-chain IDL — see
   * `treasury/README.md` "claim path" for the full account map.
   */
  static buildTransferCreatorFeesToPump(coinCreator: PublicKey): TransactionInstruction {
    const { vaultAuthority, vaultAta } = PumpSwapVenue.creatorVaultPdas(coinCreator);
    // The pump-bonding `creator-vault` PDA (note hyphen, vs underscore for
    // the pump_amm vault) is keyed by `coinCreator` under the bonding-curve
    // program. PumpBondingClient already derives this — reuse it so any
    // future seed/program change only has to be updated in one place.
    const [pumpCreatorVault] = PublicKey.findProgramAddressSync(
      [Buffer.from('creator-vault'), coinCreator.toBuffer()],
      PumpBondingClient.PROGRAM_ID,
    );
    return new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: [
        { pubkey: NATIVE_SOL_MINT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: coinCreator, isSigner: false, isWritable: false },
        { pubkey: vaultAuthority, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: pumpCreatorVault, isSigner: false, isWritable: true },
        { pubkey: PUMP_AMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(DISC_TRANSFER_CREATOR_FEES_TO_PUMP),
    });
  }

  /**
   * Read the WSOL balance currently sitting in the pump_amm vault ATA for
   * `coinCreator`. This is the *pre-transfer* unclaimed amount — what
   * `transfer_creator_fees_to_pump` would move into the bonding-curve
   * `creator_vault` if called right now.
   *
   * Returns BN(0) if the ATA doesn't exist on chain (no fees ever accrued).
   */
  async getPumpAmmVaultLamports(coinCreator: PublicKey): Promise<BN> {
    const { vaultAta } = PumpSwapVenue.creatorVaultPdas(coinCreator);
    const acc = await this.connection.getAccountInfo(vaultAta);
    if (!acc) return new BN(0);
    // SPL Token Account v1 layout: amount is u64 LE at offset 64.
    if (acc.data.length < 72) return new BN(0);
    const amount = acc.data.readBigUInt64LE(64);
    return new BN(amount.toString());
  }

  /** Derive the (vaultAuthority, vaultAta) PDAs for a given coin creator. */
  static creatorVaultPdas(coinCreator: PublicKey): {
    vaultAuthority: PublicKey;
    vaultAta: PublicKey;
  } {
    const vaultAuthority: PublicKey = coinCreatorVaultAuthorityPda(coinCreator);
    // The vault ATA is for WSOL via the legacy SPL Token program (matches the
    // SDK's own derivation in `collectCoinCreatorFeeSolanaState`).
    const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const vaultAta: PublicKey = coinCreatorVaultAtaPda(
      vaultAuthority,
      NATIVE_MINT,
      TOKEN_PROGRAM,
    );
    return { vaultAuthority, vaultAta };
  }

  async buildRemoveLiquidity(req: RemoveLiquidityRequest): Promise<BuiltSwap> {
    const resolvedPool = await this.resolvePoolKey(req.positionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const liq: any = await this.online.liquiditySolanaState(resolvedPool, req.user);
    const lpBalance: BN = (() => {
      const info = liq?.userPoolAccountInfo;
      const amt = (info as { amount?: bigint } | null)?.amount;
      return amt ? new BN(amt.toString()) : new BN(0);
    })();
    const lpAmount = lpBalance.muln(Math.round(req.fraction * 10_000)).divn(10_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ixs: import('@solana/web3.js').TransactionInstruction[] = await (
      this.offline as { withdrawInstructions: (...a: unknown[]) => Promise<unknown> }
    ).withdrawInstructions(liq, lpAmount, slippagePct(req.slippageBps)) as import('@solana/web3.js').TransactionInstruction[];
    return { instructions: ixs };
  }
}

// Suppress unused warnings for helpers reserved for fee math + future use.
void applySlippageUp;
void VenueUnsupportedError;
void buyBaseInput;
void sellQuoteInput;
