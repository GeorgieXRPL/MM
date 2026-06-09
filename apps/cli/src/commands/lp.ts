import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import type { VenueId } from '@amm/shared';
import { getContext } from '../common.js';

export function registerLpCommands(program: Command): void {
  const lp = program.command('lp').description('manual LP deposit / withdraw / list');

  lp.command('positions')
    .description('list LP positions across selected venues')
    .requiredOption('--owner <label>', 'owner wallet label')
    .requiredOption('--pool <pubkey>', 'pool id')
    .requiredOption('--venue <id>', 'venue id (raydium-clmm, orca-whirlpools, meteora-dlmm, pumpswap)')
    .action(async (opts: { owner: string; pool: string; venue: VenueId }) => {
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.owner);
      if (!kp) throw new Error(`no wallet '${opts.owner}'`);
      const positions = await ctx.lpManager.listAllPositions(
        kp.publicKey,
        [opts.venue],
        [{ venue: opts.venue, poolId: new PublicKey(opts.pool) }],
      );
      if (positions.length === 0) {
        console.log('no positions found.');
        return;
      }
      for (const p of positions) {
        const range =
          p.lowerPrice !== undefined && p.upperPrice !== undefined
            ? `[${p.lowerPrice.toFixed(6)} .. ${p.upperPrice.toFixed(6)}]`
            : 'full-range';
        console.log(
          `  ${p.positionId.toBase58().slice(0, 8)}... ${range} ${p.inRange ? 'IN' : 'OUT'}  base=${p.baseAmount.toString()}  quote=${p.quoteAmount.toString()}`,
        );
      }
    });

  lp.command('deposit')
    .description('deposit liquidity into a pool')
    .requiredOption('--venue <id>', 'venue id')
    .requiredOption('--pool <pubkey>', 'pool id')
    .requiredOption('--wallet <label>', 'wallet label')
    .requiredOption('--base <atomic>', 'base amount (raw atomic)')
    .requiredOption('--quote <atomic>', 'quote amount (raw atomic)')
    .option('--center <price>', 'center price (CLMM only)')
    .option('--width <frac>', 'half-width fraction (CLMM only)', '0.05')
    .option('--slippage-bps <n>', 'slippage in bps', '50')
    .option(
      '--mode <mode>',
      'two-sided | quote-only | base-only (DLMM only)',
      'two-sided',
    )
    .option(
      '--strategy-type <type>',
      'spot | curve | bid-ask (DLMM only)',
      'spot',
    )
    .option(
      '--bin-offset <n>',
      'gap in bins from active bin (single-sided DLMM only)',
      '1',
    )
    .action(async (opts) => {
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.wallet);
      if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
      const mode = opts.mode as 'two-sided' | 'quote-only' | 'base-only';
      if (mode !== 'two-sided' && mode !== 'quote-only' && mode !== 'base-only') {
        throw new Error(`invalid --mode '${opts.mode}'`);
      }
      const stype = opts.strategyType as 'spot' | 'curve' | 'bid-ask';
      if (stype !== 'spot' && stype !== 'curve' && stype !== 'bid-ask') {
        throw new Error(`invalid --strategy-type '${opts.strategyType}'`);
      }
      // Force the un-funded side to 0 in single-sided mode to avoid surprises.
      const baseAmt =
        mode === 'quote-only' ? new BN(0) : new BN(opts.base);
      const quoteAmt =
        mode === 'base-only' ? new BN(0) : new BN(opts.quote);

      const sig = await ctx.lpManager.deposit({
        venue: opts.venue,
        poolId: new PublicKey(opts.pool),
        wallet: kp,
        baseAmountMax: baseAmt,
        quoteAmountMax: quoteAmt,
        centerPrice: opts.center ? parseFloat(opts.center) : undefined,
        widthFraction: parseFloat(opts.width ?? '0.05'),
        slippageBps: parseInt(opts.slippageBps ?? '50', 10),
        mode,
        strategyType: stype,
        binOffset: parseInt(opts.binOffset ?? '1', 10),
      });
      console.log(`deposit confirmed: ${sig}`);
    });

  lp.command('claim-fees')
    .description('claim accrued fees from a Meteora DLMM position')
    .requiredOption('--venue <id>', 'venue id (must be meteora-dlmm)', 'meteora-dlmm')
    .requiredOption('--pool <pubkey>', 'pool (lbPair) id')
    .requiredOption('--position <pubkey>', 'position id')
    .requiredOption('--wallet <label>', 'wallet label')
    .action(async (opts) => {
      if (opts.venue !== 'meteora-dlmm') {
        throw new Error('claim-fees only supports --venue meteora-dlmm');
      }
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.wallet);
      if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
      const sig = await ctx.lpManager.claimFees({
        poolId: new PublicKey(opts.pool),
        positionId: new PublicKey(opts.position),
        wallet: kp,
      });
      console.log(`fees claimed: ${sig}`);
    });

  lp.command('withdraw')
    .description('withdraw from a position')
    .requiredOption('--venue <id>', 'venue id')
    .requiredOption('--position <pubkey>', 'position id')
    .requiredOption('--wallet <label>', 'wallet label')
    .option('--fraction <frac>', '1.0')
    .option('--close', 'close position after withdraw')
    .option('--slippage-bps <n>', '50')
    .action(async (opts) => {
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.wallet);
      if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
      const sig = await ctx.lpManager.withdraw({
        venue: opts.venue,
        positionId: new PublicKey(opts.position),
        wallet: kp,
        fraction: parseFloat(opts.fraction ?? '1.0'),
        closePosition: !!opts.close,
        slippageBps: parseInt(opts.slippageBps ?? '50', 10),
      });
      console.log(`withdraw confirmed: ${sig}`);
    });
}
