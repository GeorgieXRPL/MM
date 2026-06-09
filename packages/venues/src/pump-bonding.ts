import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js';
import BN from 'bn.js';
import { createLogger } from '@amm/shared';

const log = createLogger('venue:pump-bonding');

/**
 * Pump.fun bonding-curve program. Houses the *new* fee-distribution path
 * (`pump:distribute_creator_fees`) that supersedes the deprecated
 * `pump_amm:collect_coin_creator_fee` for any pool whose creator vault
 * has been migrated to a sharing-config (multi-recipient) model.
 *
 * On-chain since Apr 2025; verified by reading the on-chain anchor IDL
 * at the standard PDA. See `treasury/README.md` "claim path" for context.
 */
export const PUMP_BONDING_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
);

/**
 * Pump fee-sharing program. Owns the SharingConfig PDA that
 * `pump:distribute_creator_fees` reads to figure out who gets what %
 * of the `creator_vault` lamports. The IDL pins this program ID as a
 * `const` value inside the `sharing_config` account constraint, so it
 * cannot be substituted by a malicious caller — verified by inflating
 * the on-chain anchor IDL and decoding the bytes.
 */
export const PUMP_FEE_SHARING_PROGRAM_ID = new PublicKey(
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
);

/**
 * Discriminator for `pump:distribute_creator_fees`, copied directly from
 * the on-chain anchor IDL. Anchor computes this as
 *   sha256("global:distribute_creator_fees").slice(0, 8)
 * so it's stable across program upgrades unless the instruction is renamed.
 */
const DISC_DISTRIBUTE_CREATOR_FEES = Buffer.from([
  165, 114, 103, 0, 121, 206, 247, 81,
]);

/**
 * Discriminator for `pump:get_minimum_distributable_fee`, the lightweight
 * read-only sibling we use to decide whether a distribute call would
 * actually pay out anything (saves a wasted tx fee on dust).
 */
// const DISC_GET_MIN_DISTRIBUTABLE_FEE = Buffer.from([
//   117, 225, 127, 202, 134, 95, 68, 35,
// ]);

const SHARING_CONFIG_SEED = Buffer.from('sharing-config');
const BONDING_CURVE_SEED = Buffer.from('bonding-curve');
const CREATOR_VAULT_SEED = Buffer.from('creator-vault');
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');

export interface PumpBondingPdas {
  bondingCurve: PublicKey;
  sharingConfig: PublicKey;
  creatorVault: PublicKey;
  eventAuthority: PublicKey;
}

/**
 * Decoded SharingConfig state. Mirrors the on-chain layout:
 *   bump: u8, version: u8, status: u8 enum, mint: Pubkey, admin: Pubkey,
 *   admin_revoked: bool, shareholders: Vec<Shareholder { recipient: Pubkey, bps: u16 }>
 *
 * The full account is allocated for ~30 shareholders; we only return what's
 * actually present (`shareholders.length === count`).
 */
export interface SharingConfigState {
  bump: number;
  version: number;
  status: number;
  mint: PublicKey;
  admin: PublicKey;
  adminRevoked: boolean;
  shareholders: { recipient: PublicKey; bps: number }[];
}

export class PumpBondingClient {
  /** Re-export of {@link PUMP_BONDING_PROGRAM_ID} for ergonomic
   * `PumpBondingClient.PROGRAM_ID` access from sibling modules. */
  static readonly PROGRAM_ID = PUMP_BONDING_PROGRAM_ID;

  constructor(private readonly conn: Connection) {}

  /**
   * Derive every PDA needed to call `distribute_creator_fees` for a given
   * mint. Pure derivation, no RPC. The bonding-curve account itself doesn't
   * need to exist for this to succeed.
   */
  static derivePdas(mint: PublicKey): PumpBondingPdas {
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [BONDING_CURVE_SEED, mint.toBuffer()],
      PUMP_BONDING_PROGRAM_ID,
    );
    // Sharing config is owned by the pfee program; the bonding-curve program
    // verifies it via a const-program constraint in the IDL.
    const [sharingConfig] = PublicKey.findProgramAddressSync(
      [SHARING_CONFIG_SEED, mint.toBuffer()],
      PUMP_FEE_SHARING_PROGRAM_ID,
    );
    // The creator-vault PDA is keyed by `bonding_curve.creator`, NOT by the
    // mint. For migrated pools `bonding_curve.creator` is the sharing-config
    // PDA itself (the migration moves authority off the original wallet).
    // For non-migrated pools it would be the original creator wallet.
    const [creatorVault] = PublicKey.findProgramAddressSync(
      [CREATOR_VAULT_SEED, sharingConfig.toBuffer()],
      PUMP_BONDING_PROGRAM_ID,
    );
    const [eventAuthority] = PublicKey.findProgramAddressSync(
      [EVENT_AUTHORITY_SEED],
      PUMP_BONDING_PROGRAM_ID,
    );
    return { bondingCurve, sharingConfig, creatorVault, eventAuthority };
  }

  /**
   * Lamports currently sitting in the migrated `creator_vault` PDA. This is
   * the *gross* unclaimed amount — when distribute fires, each shareholder
   * gets `bps/10_000` of this minus a tiny floor reserve.
   *
   * Returns 0 if the vault account doesn't exist yet (no fees ever accrued
   * for this mint under the new model).
   */
  async getCreatorVaultLamports(mint: PublicKey): Promise<BN> {
    const { creatorVault } = PumpBondingClient.derivePdas(mint);
    const acc = await this.conn.getAccountInfo(creatorVault);
    if (!acc) return new BN(0);
    return new BN(acc.lamports);
  }

  /**
   * Read + decode the SharingConfig at the canonical PDA for this mint.
   * Returns null if the account doesn't exist (the pool hasn't been migrated
   * to the new fee-sharing model — the legacy `collect_coin_creator_fee`
   * path still applies in that case).
   *
   * Throws if the account exists but its layout doesn't match (defensive —
   * indicates a program upgrade has changed the schema).
   */
  async readSharingConfig(mint: PublicKey): Promise<SharingConfigState | null> {
    const { sharingConfig } = PumpBondingClient.derivePdas(mint);
    const acc = await this.conn.getAccountInfo(sharingConfig);
    if (!acc) return null;
    if (!acc.owner.equals(PUMP_FEE_SHARING_PROGRAM_ID)) {
      throw new Error(
        `sharing_config ${sharingConfig.toBase58()} owned by ${acc.owner.toBase58()}, expected ${PUMP_FEE_SHARING_PROGRAM_ID.toBase58()}`,
      );
    }
    return decodeSharingConfig(acc.data);
  }

  /**
   * Build the single instruction for `pump:distribute_creator_fees`. No args,
   * no signers required. Anyone can call this — the caller just needs a fee
   * payer.
   *
   * The IDL declares only 7 fixed accounts, but the program reads each
   * shareholder wallet from `ctx.remaining_accounts` at runtime so it can
   * credit them via `SystemProgram::transfer`. Anchor doesn't surface
   * `remaining_accounts` in the IDL — calling distribute without them
   * raises `NotEnoughRemainingAccounts (6027)`. Caller MUST pass the
   * shareholder list (typically obtained from {@link readSharingConfig}).
   *
   * Each shareholder pubkey is appended as `isSigner=false, isWritable=true`
   * (writable because their lamports change). Order matters and must match
   * the on-chain `sharing_config.shareholders` order, since the program
   * iterates the two lists in lockstep — passing them out of order trips a
   * different runtime check.
   */
  buildDistributeCreatorFees(
    mint: PublicKey,
    shareholders: PublicKey[],
  ): TransactionInstruction {
    if (shareholders.length === 0) {
      throw new Error(
        'distribute_creator_fees requires at least one shareholder in remaining_accounts',
      );
    }
    const { bondingCurve, sharingConfig, creatorVault, eventAuthority } =
      PumpBondingClient.derivePdas(mint);
    const keys = [
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: false },
      { pubkey: sharingConfig, isSigner: false, isWritable: false },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_BONDING_PROGRAM_ID, isSigner: false, isWritable: false },
      ...shareholders.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
    ];
    return new TransactionInstruction({
      programId: PUMP_BONDING_PROGRAM_ID,
      keys,
      data: Buffer.from(DISC_DISTRIBUTE_CREATOR_FEES),
    });
  }
}

/**
 * SharingConfig decoder. Layout (Anchor borsh):
 *   0..8    discriminator
 *   8       bump (u8)
 *   9       version (u8)
 *   10      status (u8 enum)
 *   11..43  mint (Pubkey)
 *   43..75  admin (Pubkey)
 *   75      admin_revoked (bool, 1 byte)
 *   76..80  shareholders.len (u32 LE)
 *   80..    Shareholder[len], each = { Pubkey (32), u16 LE bps (2) } = 34 bytes
 *
 * The on-chain account is allocated 1024 bytes (room for ~27 shareholders);
 * everything past the active shareholders is zero-padded and ignored.
 */
function decodeSharingConfig(data: Buffer): SharingConfigState {
  if (data.length < 80) {
    throw new Error(`sharing_config too short (${data.length} bytes)`);
  }
  const bump = data.readUInt8(8);
  const version = data.readUInt8(9);
  const status = data.readUInt8(10);
  const mint = new PublicKey(data.slice(11, 43));
  const admin = new PublicKey(data.slice(43, 75));
  const adminRevoked = data.readUInt8(75) !== 0;
  const count = data.readUInt32LE(76);
  if (count > 64) {
    // Sanity guard: the account is 1024 bytes, real configs cap well under
    // 30 recipients. A wildly-large count means we're decoding garbage.
    throw new Error(`sharing_config: implausible shareholder count ${count}`);
  }
  const shareholders: { recipient: PublicKey; bps: number }[] = [];
  let off = 80;
  for (let i = 0; i < count; i++) {
    if (off + 34 > data.length) {
      throw new Error(
        `sharing_config: shareholder[${i}] runs past account data (${data.length} bytes)`,
      );
    }
    const recipient = new PublicKey(data.slice(off, off + 32));
    const bps = data.readUInt16LE(off + 32);
    shareholders.push({ recipient, bps });
    off += 34;
  }
  const totalBps = shareholders.reduce((s, x) => s + x.bps, 0);
  if (totalBps !== 0 && totalBps !== 10_000) {
    log.warn(
      { totalBps, count, mint: mint.toBase58() },
      'sharing_config shareholders do not sum to 10000 bps',
    );
  }
  return { bump, version, status, mint, admin, adminRevoked, shareholders };
}
