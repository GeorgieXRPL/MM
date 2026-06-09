import {
  AddressLookupTableAccount,
  PublicKey,
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
  createLogger,
  JUPITER_API_BASE,
} from '@amm/shared';
import { fetchJson } from '@amm/core';
import { Venue, VenueUnsupportedError } from './venue.js';

const log = createLogger('venue:jupiter');

/** Jupiter's shared-token-account mode is cheaper but can fail sim with `AccountNotFound` on some routes; set `JUPITER_USE_SHARED_ACCOUNTS=false` to fall back to discrete accounts. */
function jupiterUseSharedAccounts(): boolean {
  const v = process.env.JUPITER_USE_SHARED_ACCOUNTS?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

interface JupQuoteResp {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  contextSlot?: number;
}

interface JupSwapInstructionsResp {
  tokenLedgerInstruction?: {
    programId: string;
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: string;
  };
  computeBudgetInstructions: {
    programId: string;
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: string;
  }[];
  setupInstructions: {
    programId: string;
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: string;
  }[];
  swapInstruction: {
    programId: string;
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: string;
  };
  cleanupInstruction?: {
    programId: string;
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: string;
  };
  addressLookupTableAddresses: string[];
  prioritizationFeeLamports?: number;
}

function decodeIx(jix: {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(jix.programId),
    keys: jix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(jix.data, 'base64'),
  });
}

/**
 * Jupiter v6 aggregator. Pseudo-venue: it doesn't have its own pools, it
 * routes across all of them. Used by the volume strategy for best-price
 * execution.
 *
 * `poolId` is interpreted as the *output* mint when used as a "venue" - we
 * don't need a real pool ID. Strategies that already know which mint they're
 * trading should call jupiter directly via `quoteByMints` / `buildSwapByMints`.
 */
export class JupiterVenue implements Venue {
  readonly id = 'jupiter' as const;

  constructor(
    private readonly connection: Connection,
    private readonly apiBase: string = JUPITER_API_BASE,
  ) {}

  async getPool(): Promise<never> {
    throw new VenueUnsupportedError(this.id, 'getPool');
  }

  async getTokenInfo(mint: PublicKey): Promise<TokenInfo> {
    const info = await this.connection.getParsedAccountInfo(mint);
    const decimals =
      (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
        ?.decimals ?? 0;
    return { mint, decimals };
  }

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    const url =
      `${this.apiBase}/quote?inputMint=${req.inputMint.toBase58()}` +
      `&outputMint=${req.outputMint.toBase58()}` +
      `&amount=${req.amountIn.toString()}` +
      `&slippageBps=${req.slippageBps}`;
    const resp = await fetchJson<JupQuoteResp>(url);
    return {
      amountIn: new BN(resp.inAmount),
      amountOut: new BN(resp.outAmount),
      minAmountOut: new BN(resp.otherAmountThreshold),
      priceImpactBps: Math.round(parseFloat(resp.priceImpactPct ?? '0') * 10_000),
      route: resp,
    };
  }

  async buildSwap(req: SwapBuildRequest): Promise<BuiltSwap> {
    const quoteResp =
      (req.quote?.route as JupQuoteResp | undefined) ??
      (await this.quote(req).then((q) => q.route as JupQuoteResp));

    const useShared = jupiterUseSharedAccounts();
    if (!useShared) {
      log.debug({ user: req.user.toBase58().slice(0, 6) }, 'Jupiter swap: useSharedAccounts=false');
    }
    const swapResp = await fetchJson<JupSwapInstructionsResp>(`${this.apiBase}/swap-instructions`, {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse: quoteResp,
        userPublicKey: req.user.toBase58(),
        wrapAndUnwrapSol: true,
        useSharedAccounts: useShared,
        // We add our own compute budget in the executor.
        prioritizationFeeLamports: 0,
      }),
    });

    const ixs: TransactionInstruction[] = [];
    if (swapResp.tokenLedgerInstruction) ixs.push(decodeIx(swapResp.tokenLedgerInstruction));
    for (const six of swapResp.setupInstructions ?? []) ixs.push(decodeIx(six));
    ixs.push(decodeIx(swapResp.swapInstruction));
    if (swapResp.cleanupInstruction) ixs.push(decodeIx(swapResp.cleanupInstruction));

    // Resolve LUTs.
    const lutAddrs = (swapResp.addressLookupTableAddresses ?? []).map((s) => new PublicKey(s));
    const luts: PublicKey[] = lutAddrs;

    return { instructions: ixs, addressLookupTables: luts };
  }

  /**
   * Load every LUT Jupiter returned for this swap. Omitting even one LUT
   * compiles an incomplete v0 message; simulation typically fails with an
   * opaque `AccountNotFound` rather than surfacing \"missing LUT\".
   */
  async loadLuts(addrs: PublicKey[]): Promise<AddressLookupTableAccount[]> {
    const out: AddressLookupTableAccount[] = [];
    for (const a of addrs) {
      try {
        const acc = await this.connection.getAddressLookupTable(a);
        if (!acc.value) {
          throw new Error(`lookup table account empty or unknown: ${a.toBase58()}`);
        }
        out.push(acc.value);
      } catch (e) {
        const lut = a.toBase58();
        const cause = e instanceof Error ? e.message : String(e);
        log.error({ lut, err: cause }, 'failed to load Jupiter swap LUT');
        throw new Error(`Jupiter LUT load failed (${lut}): ${cause}`);
      }
    }
    return out;
  }

  async getPositions(): Promise<LpPosition[]> {
    return [];
  }

  async buildAddLiquidity(_req: AddLiquidityRequest): Promise<BuiltSwap> {
    throw new VenueUnsupportedError(this.id, 'addLiquidity');
  }

  async buildRemoveLiquidity(_req: RemoveLiquidityRequest): Promise<BuiltSwap> {
    throw new VenueUnsupportedError(this.id, 'removeLiquidity');
  }

  /** applySlippageDown not currently used here but exported for downstream. */
  static applyMinOut = applySlippageDown;
}
