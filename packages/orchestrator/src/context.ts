import { PriceOracle, RpcManager, Store, TxExecutor, Vault } from '@amm/core';
import { VenueRegistry } from '@amm/venues';
import { LpManager } from '@amm/strategies';

export interface AppContext {
  vault: Vault;
  rpc: RpcManager;
  exec: TxExecutor;
  store: Store;
  oracle: PriceOracle;
  venues: VenueRegistry;
  lpManager: LpManager;
}

export function buildContext(vault: Vault): AppContext {
  const rpc = new RpcManager();
  const exec = new TxExecutor(rpc);
  const store = new Store();
  const oracle = new PriceOracle();
  // pickConnection is called per-request; the registry needs *a* connection for
  // SDK loaders but RPC requests inside SDKs will go through that connection.
  // For best balancing, swap to `rpc.pickConnection()` per call inside adapters.
  const venues = new VenueRegistry(rpc.pickConnection());
  const lpManager = new LpManager({ rpc, exec, venues });
  return { vault, rpc, exec, store, oracle, venues, lpManager };
}
