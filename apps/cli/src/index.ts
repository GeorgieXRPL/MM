#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { registerVaultCommands } from './commands/vault.js';
import { registerWalletCommands } from './commands/wallet.js';
import { registerVolumeCommands } from './commands/volume.js';
import { registerLpCommands } from './commands/lp.js';
import { registerClmmCommands } from './commands/clmm-mm.js';
import { registerMeteoraLpCommands } from './commands/meteora-lp.js';
import { registerObCommands } from './commands/ob-mm.js';
import { registerSweepCommands } from './commands/sweep.js';
import { registerStatusCommands } from './commands/status.js';
import { registerBacktestCommands } from './commands/backtest.js';
import { registerDevnetCommands } from './commands/devnet.js';

const program = new Command();
program
  .name('amm')
  .description('Anonymous Solana market-making suite')
  .version('0.1.0');

registerVaultCommands(program);
registerWalletCommands(program);
registerVolumeCommands(program);
registerLpCommands(program);
registerClmmCommands(program);
registerMeteoraLpCommands(program);
registerObCommands(program);
registerSweepCommands(program);
registerStatusCommands(program);
registerBacktestCommands(program);
registerDevnetCommands(program);

program.parseAsync(process.argv).catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
