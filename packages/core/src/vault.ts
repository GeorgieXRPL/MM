import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import { createLogger } from '@amm/shared';

const log = createLogger('vault');

/* ---------- file format ----------------------------------------------------

A vault file is a single JSON document on disk. All key material lives inside
the encrypted blob. The header (version, kdf params, salt, iv) is plaintext so
we can decrypt with just the passphrase.

{
  "v": 1,
  "kdf": "scrypt",
  "kdfParams": { "N": 16384, "r": 8, "p": 1, "saltB64": "..." },
  "cipher": "aes-256-gcm",
  "ivB64": "...",
  "tagB64": "...",
  "ctB64": "..."
}

The plaintext is a JSON object:
{
  "createdAt": <ms>,
  "wallets": [ { "label": "...", "secretKeyB58": "...", "tags": ["..."], "createdAt": <ms> } ]
}

-------------------------------------------------------------------------- */

const KDF_N = 16384;
const KDF_R = 8;
const KDF_P = 1;
const KDF_KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

const VaultFileSchema = z.object({
  v: z.literal(1),
  kdf: z.literal('scrypt'),
  kdfParams: z.object({
    N: z.number(),
    r: z.number(),
    p: z.number(),
    saltB64: z.string(),
  }),
  cipher: z.literal('aes-256-gcm'),
  ivB64: z.string(),
  tagB64: z.string(),
  ctB64: z.string(),
});

const WalletEntrySchema = z.object({
  label: z.string(),
  secretKeyB58: z.string(),
  tags: z.array(z.string()).default([]),
  createdAt: z.number(),
});

const PlaintextSchema = z.object({
  createdAt: z.number(),
  wallets: z.array(WalletEntrySchema),
});

export type WalletEntry = z.infer<typeof WalletEntrySchema>;
export type VaultPlaintext = z.infer<typeof PlaintextSchema>;

/**
 * Resolve the vault file path with **app-namespaced** env precedence so the
 * MM and the treasury can never accidentally open each other's vault when
 * both are launched from the same shell. Order:
 *
 *   1. AMM_VAULT_PATH      — explicit MM-side override (preferred)
 *   2. VAULT_PATH          — legacy generic; emits a one-time warning so the
 *                            operator knows it's about to bite them
 *   3. ~/.amm/vault.enc    — last-resort default
 *
 * The treasury intentionally does NOT use this default — it always loads its
 * vault path from `treasury.config.json` (or the `TREASURY_VAULT_PATH` env
 * var via that config), so the two systems can coexist on the same machine
 * with zero env-var coupling.
 */
let warnedLegacyVaultPath = false;
export function defaultVaultPath(): string {
  if (process.env.AMM_VAULT_PATH) return process.env.AMM_VAULT_PATH;
  if (process.env.VAULT_PATH) {
    if (!warnedLegacyVaultPath) {
      warnedLegacyVaultPath = true;
      log.warn(
        { path: process.env.VAULT_PATH },
        'using legacy VAULT_PATH env var; rename to AMM_VAULT_PATH to avoid collision with sibling deployments (e.g. treasury)',
      );
    }
    return process.env.VAULT_PATH;
  }
  return path.join(os.homedir(), '.amm', 'vault.enc');
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KDF_KEY_LEN, { N: KDF_N, r: KDF_R, p: KDF_P });
}

function encrypt(plain: Buffer, passphrase: string): z.infer<typeof VaultFileSchema> {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: 'scrypt',
    kdfParams: { N: KDF_N, r: KDF_R, p: KDF_P, saltB64: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    ivB64: iv.toString('base64'),
    tagB64: tag.toString('base64'),
    ctB64: ct.toString('base64'),
  };
}

function decrypt(file: z.infer<typeof VaultFileSchema>, passphrase: string): Buffer {
  const salt = Buffer.from(file.kdfParams.saltB64, 'base64');
  const key = deriveKey(passphrase, salt);
  const iv = Buffer.from(file.ivB64, 'base64');
  const tag = Buffer.from(file.tagB64, 'base64');
  const ct = Buffer.from(file.ctB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export class VaultError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'BAD_PASSPHRASE' | 'CORRUPT' | 'EXISTS' | 'NOT_LOADED',
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

/**
 * Encrypted on-disk vault for Solana keypairs.
 *
 * Replaces the previous plaintext MongoDB schema. The vault is locked by a
 * single passphrase; the only way back to the wallets is via that passphrase.
 */
export class Vault {
  private plaintext: VaultPlaintext | null = null;
  private passphrase: string | null = null;

  constructor(private readonly filePath: string = defaultVaultPath()) {}

  get path(): string {
    return this.filePath;
  }

  get isLoaded(): boolean {
    return this.plaintext !== null;
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Create a new empty vault. Throws if one already exists at the path. */
  async init(passphrase: string): Promise<void> {
    if (await this.exists()) {
      throw new VaultError(`vault already exists at ${this.filePath}`, 'EXISTS');
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.plaintext = { createdAt: Date.now(), wallets: [] };
    this.passphrase = passphrase;
    await this.save();
    log.info({ path: this.filePath }, 'vault initialised');
  }

  /** Decrypt and load the vault into memory. */
  async unlock(passphrase: string): Promise<void> {
    if (!(await this.exists())) {
      throw new VaultError(`no vault at ${this.filePath}`, 'NOT_FOUND');
    }
    const raw = await fs.readFile(this.filePath, 'utf8');
    let parsed: z.infer<typeof VaultFileSchema>;
    try {
      parsed = VaultFileSchema.parse(JSON.parse(raw));
    } catch (e) {
      throw new VaultError(`vault file is corrupt: ${(e as Error).message}`, 'CORRUPT');
    }
    let plain: Buffer;
    try {
      plain = decrypt(parsed, passphrase);
    } catch {
      throw new VaultError('bad passphrase or corrupted vault', 'BAD_PASSPHRASE');
    }
    try {
      this.plaintext = PlaintextSchema.parse(JSON.parse(plain.toString('utf8')));
    } catch (e) {
      throw new VaultError(`vault payload is corrupt: ${(e as Error).message}`, 'CORRUPT');
    }
    this.passphrase = passphrase;
    log.info(
      { path: this.filePath, wallets: this.plaintext.wallets.length },
      'vault unlocked',
    );
  }

  /** Wipe in-memory plaintext and passphrase. */
  lock(): void {
    if (this.passphrase) {
      // Best-effort overwrite (V8 won't actually wipe but no harm).
      this.passphrase = '\0'.repeat(this.passphrase.length);
    }
    this.plaintext = null;
    this.passphrase = null;
  }

  private requireUnlocked(): VaultPlaintext {
    if (!this.plaintext || !this.passphrase) {
      throw new VaultError('vault is locked', 'NOT_LOADED');
    }
    return this.plaintext;
  }

  /** Persist the in-memory state back to disk. */
  async save(): Promise<void> {
    const pt = this.requireUnlocked();
    const file = encrypt(Buffer.from(JSON.stringify(pt), 'utf8'), this.passphrase!);
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  /** Verify the supplied passphrase matches the loaded vault (for re-auth). */
  verifyPassphrase(passphrase: string): boolean {
    if (!this.passphrase) return false;
    const a = Buffer.from(this.passphrase, 'utf8');
    const b = Buffer.from(passphrase, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ----- wallet management ------------------------------------------------

  list(): readonly WalletEntry[] {
    return this.requireUnlocked().wallets;
  }

  get(label: string): WalletEntry | undefined {
    return this.requireUnlocked().wallets.find((w) => w.label === label);
  }

  getKeypair(label: string): Keypair | undefined {
    const w = this.get(label);
    if (!w) return undefined;
    return Keypair.fromSecretKey(bs58.decode(w.secretKeyB58));
  }

  /** Returns Keypairs for all wallets matching any of the given tags (or all if tags is empty). */
  filterKeypairs(tags: readonly string[] = []): { entry: WalletEntry; keypair: Keypair }[] {
    const wallets = this.requireUnlocked().wallets;
    const filtered =
      tags.length === 0
        ? wallets
        : wallets.filter((w) => w.tags.some((t) => tags.includes(t)));
    return filtered.map((entry) => ({
      entry,
      keypair: Keypair.fromSecretKey(bs58.decode(entry.secretKeyB58)),
    }));
  }

  /** Generate `count` new keypairs and add them. Returns their labels. */
  async generate(count: number, prefix = 'wallet', tags: string[] = []): Promise<string[]> {
    const pt = this.requireUnlocked();
    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
      const kp = Keypair.generate();
      const label = `${prefix}-${pt.wallets.length + 1}`;
      pt.wallets.push({
        label,
        secretKeyB58: bs58.encode(kp.secretKey),
        tags: [...tags],
        createdAt: Date.now(),
      });
      labels.push(label);
    }
    await this.save();
    log.info({ count, prefix, tags }, 'generated wallets');
    return labels;
  }

  /** Import a wallet from a base58-encoded secret key. */
  async importFromBase58(label: string, secretKeyB58: string, tags: string[] = []): Promise<void> {
    const pt = this.requireUnlocked();
    if (pt.wallets.some((w) => w.label === label)) {
      throw new VaultError(`label '${label}' already exists`, 'EXISTS');
    }
    // Validate it's a real keypair before storing.
    Keypair.fromSecretKey(bs58.decode(secretKeyB58));
    pt.wallets.push({ label, secretKeyB58, tags, createdAt: Date.now() });
    await this.save();
    log.info({ label, tags }, 'imported wallet');
  }

  /**
   * Import a wallet from a raw 64-byte secret key (Uint8Array). Provided so
   * callers that already have the raw bytes (e.g. from parsing a Solana CLI
   * keypair JSON file in-memory, or anything that doesn't already have base58
   * on hand) don't need to depend on `bs58` themselves. Encodes to base58 for
   * on-disk storage to match `importFromBase58`.
   */
  async importFromSecretKey(label: string, secretKey: Uint8Array, tags: string[] = []): Promise<void> {
    if (secretKey.length !== 64) {
      throw new VaultError(`expected 64-byte secret key, got ${secretKey.length}`, 'CORRUPT');
    }
    // Validate before encoding.
    Keypair.fromSecretKey(secretKey);
    await this.importFromBase58(label, bs58.encode(secretKey), tags);
  }

  /** Import from a Solana CLI-style JSON keypair file (array of 64 numbers). */
  async importFromKeypairFile(label: string, filePath: string, tags: string[] = []): Promise<void> {
    const raw = await fs.readFile(filePath, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new VaultError(`${filePath} is not a valid solana keypair json`, 'CORRUPT');
    }
    const kp = Keypair.fromSecretKey(Uint8Array.from(arr));
    await this.importFromBase58(label, bs58.encode(kp.secretKey), tags);
  }

  async remove(label: string): Promise<void> {
    const pt = this.requireUnlocked();
    const before = pt.wallets.length;
    pt.wallets = pt.wallets.filter((w) => w.label !== label);
    if (pt.wallets.length === before) {
      throw new VaultError(`no wallet labelled '${label}'`, 'NOT_FOUND');
    }
    await this.save();
    log.info({ label }, 'removed wallet');
  }

  async retag(label: string, tags: string[]): Promise<void> {
    const pt = this.requireUnlocked();
    const w = pt.wallets.find((x) => x.label === label);
    if (!w) throw new VaultError(`no wallet labelled '${label}'`, 'NOT_FOUND');
    w.tags = tags;
    await this.save();
  }

  /**
   * Change the vault passphrase.
   * Re-encrypts in place. The vault must already be unlocked.
   */
  async changePassphrase(newPassphrase: string): Promise<void> {
    this.requireUnlocked();
    this.passphrase = newPassphrase;
    await this.save();
    log.info('vault passphrase changed');
  }
}
