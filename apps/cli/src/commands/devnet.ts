import { Command } from 'commander';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountIdempotent,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import BN from 'bn.js';
import { getContext, fmtSol } from '../common.js';

const STATE_DIR = '.amm-devnet';
const STATE_FILE = join(STATE_DIR, 'test-pool.json');

interface DevnetState {
  wallet: string;
  baseMint: string;
  baseDecimals: number;
  baseSymbol: string;
  quoteMint: string;
  quoteDecimals: number;
  quoteSymbol: string;
  poolId?: string;
  binStep?: number;
  activeBinId?: number;
  presetParameter?: string;
}

function loadState(): DevnetState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as DevnetState;
}

function saveState(s: DevnetState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function ensureDevnet(): void {
  if ((process.env.SOLANA_CLUSTER ?? '') !== 'devnet') {
    throw new Error(
      "SOLANA_CLUSTER is not 'devnet'. Run with `dotenv -e .env.devnet -- amm devnet ...` or set the env var.",
    );
  }
}

export function registerDevnetCommands(program: Command): void {
  const d = program
    .command('devnet')
    .description('devnet test helpers: airdrop, mint test tokens, create DLMM pool');

  d.command('airdrop')
    .description('request a devnet SOL airdrop to a vault wallet')
    .requiredOption('-w, --wallet <label>', 'wallet label')
    .option('-a, --amount <sol>', 'amount of SOL (max 2 per request on public faucet)', '1')
    .option('-r, --retries <n>', 'retry count on faucet failure', '4')
    .action(async (opts: { wallet: string; amount: string; retries: string }) => {
      ensureDevnet();
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.wallet);
      if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
      const conn = ctx.rpc.pickConnection();
      const sol = Math.min(parseFloat(opts.amount), 2);
      const retries = parseInt(opts.retries, 10);
      const pk = kp.publicKey.toBase58();
      console.log(`requesting ${sol} SOL airdrop to ${pk}...`);

      let lastErr: Error | undefined;
      for (let i = 0; i < retries; i++) {
        try {
          const sig = await conn.requestAirdrop(kp.publicKey, Math.floor(sol * LAMPORTS_PER_SOL));
          const bh = await conn.getLatestBlockhash();
          await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
          const bal = await conn.getBalance(kp.publicKey);
          console.log(`done. signature=${sig}`);
          console.log(`new balance: ${fmtSol(bal)}`);
          return;
        } catch (e) {
          lastErr = e as Error;
          const wait = 2000 * (i + 1);
          console.log(`  attempt ${i + 1}/${retries} failed (${lastErr.message}); retrying in ${wait}ms...`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      console.error(`\npublic faucet appears throttled. fall back to one of:`);
      console.error(`  1) web faucet:    https://faucet.solana.com/?address=${pk}&amount=${sol}&cluster=devnet`);
      console.error(`  2) solana CLI:    solana airdrop ${sol} ${pk} --url devnet`);
      console.error(`  3) helius faucet: https://www.helius.dev/faucet (set RPC_HELIUS in .env first)`);
      throw lastErr ?? new Error('airdrop failed');
    });

  d.command('mint-test-tokens')
    .description('create two SPL test tokens (TEST + WSOL pair) and mint initial supply')
    .requiredOption('-w, --wallet <label>', 'wallet that will own / hold the supply')
    .option('--base-decimals <n>', 'decimals for the test base token', '6')
    .option(
      '--base-supply <n>',
      'initial supply of the test base token in UI units',
      '1000000',
    )
    .option('--wrap-sol <n>', 'amount of SOL to wrap into WSOL for the quote side', '1')
    .option('--symbol <s>', 'human label for the test base token', 'TEST')
    .action(
      async (opts: {
        wallet: string;
        baseDecimals: string;
        baseSupply: string;
        wrapSol: string;
        symbol: string;
      }) => {
        ensureDevnet();
        const ctx = await getContext();
        const kp = ctx.vault.getKeypair(opts.wallet);
        if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
        const conn = ctx.rpc.pickConnection();

        const baseDecimals = parseInt(opts.baseDecimals, 10);
        const baseSupplyUi = parseFloat(opts.baseSupply);
        const wrapSol = parseFloat(opts.wrapSol);

        console.log('creating base SPL token...');
        const baseMint = await createMint(conn, kp, kp.publicKey, null, baseDecimals);
        console.log(`  base mint: ${baseMint.toBase58()}`);

        console.log('minting initial supply to wallet...');
        const baseAta = await createAssociatedTokenAccountIdempotent(conn, kp, baseMint, kp.publicKey);
        const baseRaw = BigInt(Math.round(baseSupplyUi * 10 ** baseDecimals));
        await mintTo(conn, kp, baseMint, baseAta, kp, baseRaw);
        console.log(`  minted ${baseSupplyUi} ${opts.symbol} (raw=${baseRaw}) -> ${baseAta.toBase58()}`);

        console.log(`wrapping ${wrapSol} SOL into WSOL...`);
        const wsolAta = await getOrCreateAssociatedTokenAccount(conn, kp, NATIVE_MINT, kp.publicKey);
        const wrapLamports = Math.floor(wrapSol * LAMPORTS_PER_SOL);
        const wrapTx = new Transaction()
          .add(
            SystemProgram.transfer({
              fromPubkey: kp.publicKey,
              toPubkey: wsolAta.address,
              lamports: wrapLamports,
            }),
          )
          .add(createSyncNativeInstruction(wsolAta.address));
        const wrapSig = await sendAndConfirmTransaction(conn, wrapTx, [kp]);
        console.log(`  wsol funded: ${wsolAta.address.toBase58()}  sig=${wrapSig}`);

        const state: DevnetState = {
          wallet: opts.wallet,
          baseMint: baseMint.toBase58(),
          baseDecimals,
          baseSymbol: opts.symbol,
          quoteMint: NATIVE_MINT.toBase58(),
          quoteDecimals: 9,
          quoteSymbol: 'WSOL',
        };
        const prev = loadState();
        if (prev?.poolId) state.poolId = prev.poolId;
        saveState(state);
        console.log(`\nstate saved to ${resolve(STATE_FILE)}`);
      },
    );

  d.command('create-pool')
    .description('create a Meteora DLMM lbPair from the test tokens (must run mint-test-tokens first)')
    .requiredOption('-w, --wallet <label>', 'pool creator wallet')
    .option('--bin-step <n>', 'bin step (1, 2, 5, 8, 10, 20, 25, 50, 100). lower = tighter spreads', '25')
    .option(
      '--initial-price <p>',
      'initial price as quote-per-base, UI units (e.g. 0.001 = 1 TEST = 0.001 WSOL)',
      '0.001',
    )
    .action(async (opts: { wallet: string; binStep: string; initialPrice: string }) => {
      ensureDevnet();
      const state = loadState();
      if (!state) {
        throw new Error("no test state. run `amm devnet mint-test-tokens` first.");
      }
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.wallet);
      if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
      const conn = ctx.rpc.pickConnection();

      const binStep = parseInt(opts.binStep, 10);
      const price = parseFloat(opts.initialPrice);

      // Dynamic import via Function() so TypeScript doesn't try to resolve types
      // (the SDK is a transitive dep through @amm/venues, not a direct CLI dep).
      const specifier = '@meteora-ag/dlmm';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await (Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(
        specifier,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const DLMM = (mod as any).default ?? (mod as any).DLMM;

      console.log('discovering preset parameters...');
      const presets = await DLMM.getAllPresetParameters(conn, { cluster: 'devnet' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const candidates: any[] = [
        ...(presets.presetParameter ?? []),
        ...(presets.presetParameter2 ?? []),
      ];
      const preset = candidates.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p: any) => Number(p.account.binStep) === binStep,
      );
      if (!preset) {
        throw new Error(
          `no preset parameter with binStep=${binStep} on devnet. tried: ${candidates
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((p: any) => p.account.binStep.toString())
            .join(',')}`,
        );
      }
      console.log(`  preset: ${preset.publicKey.toBase58()} (binStep=${binStep})`);

      // Convert UI price -> activeId. DLMM has helper getBinIdFromPrice when an
      // instance exists, but for createLbPair we need the formula directly:
      //   price = (1 + binStep/10000) ^ binId
      //   binId = log(price) / log(1 + binStep/10000)
      const binIdFloat =
        Math.log(price * 10 ** (state.quoteDecimals - state.baseDecimals)) /
        Math.log(1 + binStep / 10_000);
      const activeId = new BN(Math.round(binIdFloat));
      console.log(`  activeId: ${activeId.toString()} (price=${price})`);

      const baseMint = new PublicKey(state.baseMint);
      const quoteMint = new PublicKey(state.quoteMint);

      console.log('building createLbPair2 transaction...');
      const tx = await DLMM.createLbPair2(
        conn,
        kp.publicKey,
        baseMint,
        quoteMint,
        preset.publicKey,
        activeId,
        { cluster: 'devnet' },
      );
      tx.feePayer = kp.publicKey;
      const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
      console.log(`  pool created. signature=${sig}`);

      // Derive the lbPair pda the SDK uses. Use deriveLbPairWithPresetParamWithIndexKey if exposed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const programIdStr = (mod as any).LBCLMM_PROGRAM_IDS?.devnet;
      const programId = new PublicKey(programIdStr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const derive = (mod as any).deriveLbPairWithPresetParamWithIndexKey;
      let poolPk: PublicKey;
      if (typeof derive === 'function') {
        const [pk] = derive(preset.publicKey, baseMint, quoteMint, programId);
        poolPk = pk;
      } else {
        // Fallback: ask for all pairs by token X/Y filter
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = await (DLMM as any).getLbPairs(conn, { cluster: 'devnet' });
        const found = list.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) =>
            new PublicKey(p.account.tokenXMint).equals(baseMint) &&
            new PublicKey(p.account.tokenYMint).equals(quoteMint),
        );
        if (!found) throw new Error('could not find created lbPair on chain');
        poolPk = new PublicKey(found.publicKey);
      }
      console.log(`  pool pubkey: ${poolPk.toBase58()}`);

      const updated: DevnetState = {
        ...state,
        poolId: poolPk.toBase58(),
        binStep,
        activeBinId: activeId.toNumber(),
        presetParameter: preset.publicKey.toBase58(),
      };
      saveState(updated);
      console.log(`\nstate saved to ${resolve(STATE_FILE)}`);
      console.log('\nnext steps:');
      console.log(`  amm meteora-lp start \\`);
      console.log(`    --pool ${poolPk.toBase58()} \\`);
      console.log(`    --wallet ${opts.wallet} \\`);
      console.log(`    --mode two-sided --strategy-type spot --width 0.05 --dry-run`);
    });

  d.command('show-state')
    .description('print the current devnet test state')
    .action(() => {
      const s = loadState();
      if (!s) {
        console.log('no devnet state. run `amm devnet mint-test-tokens` first.');
        return;
      }
      console.log(JSON.stringify(s, null, 2));
    });

  d.command('balances')
    .description('show token balances for a wallet')
    .requiredOption('-w, --wallet <label>', 'wallet label')
    .action(async (opts: { wallet: string }) => {
      ensureDevnet();
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.wallet);
      if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
      const conn = ctx.rpc.pickConnection();
      const sol = await conn.getBalance(kp.publicKey);
      console.log(`SOL: ${fmtSol(sol)}`);

      const accs = await conn.getParsedTokenAccountsByOwner(kp.publicKey, {
        programId: TOKEN_PROGRAM_ID,
      });
      const state = loadState();
      for (const acc of accs.value) {
        const info = (acc.account.data as { parsed: { info: { mint: string; tokenAmount: { uiAmountString: string } } } })
          .parsed.info;
        let tag = '';
        if (state) {
          if (info.mint === state.baseMint) tag = `  [${state.baseSymbol}]`;
          else if (info.mint === state.quoteMint) tag = '  [WSOL]';
        }
        console.log(`  ${info.mint}  ${info.tokenAmount.uiAmountString}${tag}`);
      }
    });

  // Convenience: a simple end-to-end "doctor" check that everything is wired.
  d.command('doctor')
    .description('verify devnet RPC reachable, vault unlocked, wallet funded')
    .requiredOption('-w, --wallet <label>', 'wallet label to probe')
    .action(async (opts: { wallet: string }) => {
      ensureDevnet();
      console.log(`SOLANA_CLUSTER=${process.env.SOLANA_CLUSTER}`);
      console.log(`RPC_PUBLIC=${process.env.RPC_PUBLIC}`);
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.wallet);
      if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
      const conn = ctx.rpc.pickConnection();
      const slot = await conn.getSlot();
      console.log(`current slot: ${slot}`);
      const bal = await conn.getBalance(kp.publicKey);
      console.log(`${opts.wallet} (${kp.publicKey.toBase58()}): ${fmtSol(bal)}`);
      const state = loadState();
      console.log(`devnet state: ${state ? 'present' : 'missing'}`);
      if (state?.poolId) console.log(`  pool: ${state.poolId}`);

      // Confirm the Meteora venue can load the pool when present.
      if (state?.poolId) {
        try {
          const v = ctx.venues.get('meteora-dlmm');
          await v.getPool(new PublicKey(state.poolId));
          console.log('  meteora venue: OK (loaded pool from chain)');
        } catch (e) {
          console.log(`  meteora venue: FAIL - ${(e as Error).message}`);
        }
      }
    });

  // Suppress lint - these helpers are not always used yet but kept for docs.
  void dirname;
}
