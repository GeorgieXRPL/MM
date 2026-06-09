import { Command } from 'commander';
import { simulateObMm, simulateVolume, syntheticTape } from '@amm/strategies';

export function registerBacktestCommands(program: Command): void {
  const b = program.command('backtest').description('offline strategy simulation');

  b.command('volume')
    .description('replay the volume strategy against a synthetic tape')
    .option('--ticks <n>', 'number of ticks to simulate', '3600')
    .option('--tick-ms <n>', 'milliseconds per tick', '1000')
    .option('--start-price <n>', 'starting mid price', '100')
    .option('--vol <n>', 'annualised vol (e.g. 0.6 = 60%)', '0.6')
    .option('--mean-size <n>', 'mean trade size (quote)', '0.05')
    .action((opts) => {
      const tape = syntheticTape({
        startPrice: parseFloat(opts.startPrice),
        ticks: parseInt(opts.ticks, 10),
        tickMs: parseInt(opts.tickMs, 10),
        vol: parseFloat(opts.vol),
      });
      const r = simulateVolume(tape, { sizeLogMean: Math.log(parseFloat(opts.meanSize)) });
      console.log(`trades:    ${r.trades.length} (buys=${r.buys}, sells=${r.sells})`);
      console.log(`volume:    ${r.totalVolumeQuote.toFixed(4)} quote`);
      console.log(`est. cost: ${r.estCostQuote.toFixed(4)} quote`);
    });

  b.command('ob-mm')
    .description('replay Avellaneda-Stoikov against a synthetic tape')
    .option('--ticks <n>', 'number of ticks to simulate', '3600')
    .option('--tick-ms <n>', 'milliseconds per tick', '1000')
    .option('--start-price <n>', 'starting mid price', '100')
    .option('--vol <n>', 'annualised vol (e.g. 0.6 = 60%)', '0.6')
    .option('--gamma <n>', 'risk aversion (higher = pulls inventory back faster)', '0.1')
    .option('--horizon <n>', 'AS horizon T in [0,1]', '1.0')
    .option('--k <n>', 'order book intensity', '1.5')
    .option('--fill-prob <n>', 'per-tick fill probability per side', '0.05')
    .option('--fill-size <n>', 'base size per fill', '0.1')
    .action((opts) => {
      const tape = syntheticTape({
        startPrice: parseFloat(opts.startPrice),
        ticks: parseInt(opts.ticks, 10),
        tickMs: parseInt(opts.tickMs, 10),
        vol: parseFloat(opts.vol),
      });
      const r = simulateObMm(tape, {
        asParams: {
          gamma: parseFloat(opts.gamma),
          T: parseFloat(opts.horizon),
          k: parseFloat(opts.k),
        },
        fillProbability: parseFloat(opts.fillProb),
        fillSize: parseFloat(opts.fillSize),
      });
      console.log(`fills:     ${r.fills}`);
      console.log(`pnl:       ${r.pnlQuote.toFixed(4)} quote`);
      console.log(`final inv: ${r.finalInventory.toFixed(4)}`);
    });
}
