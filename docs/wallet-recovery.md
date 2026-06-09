# Wallet recovery & emergency procedures

This document explains where private keys live, how the encryption works, what backups you should make, and what to do if something goes wrong.

**TL;DR**: keys are AES-256-GCM encrypted on disk under a passphrase you choose. There is no recovery if you forget the passphrase. Make backups. Read the rest of this doc.

---

## Where keys are stored

A single file per environment, encrypted at rest:

| Environment | Default path | Override |
|---|---|---|
| Devnet | `./.amm-devnet/vault.enc` | `VAULT_PATH` env var |
| Mainnet | `./.amm-mainnet/vault.enc` | `VAULT_PATH` env var |
| If `VAULT_PATH` unset | `~/.amm/vault.enc` | n/a |

The path resolution is here:

```79:82:packages/core/src/vault.ts
export function defaultVaultPath(): string {
  if (process.env.VAULT_PATH) return process.env.VAULT_PATH;
  return path.join(os.homedir(), '.amm', 'vault.enc');
}
```

---

## File format

The vault is a single JSON document. The header is plaintext (we need to read the KDF parameters to decrypt). Everything sensitive is inside the encrypted blob.

```18:40:packages/core/src/vault.ts
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
```

---

## How the encryption works

### Crypto parameters

```42:47:packages/core/src/vault.ts
const KDF_N = 16384;
const KDF_R = 8;
const KDF_P = 1;
const KDF_KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
```

- **scrypt** with N=16384, r=8, p=1 — the OWASP-recommended interactive-login parameter set. Slows brute-force attempts to ~10ms per guess on a fast CPU.
- **AES-256-GCM** — authenticated encryption. Tampering with the file is detected and rejected.
- **Fresh random salt + IV per write** — re-encrypting after a wallet add doesn't reuse keystream.

### Key derivation

```84:86:packages/core/src/vault.ts
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KDF_KEY_LEN, { N: KDF_N, r: KDF_R, p: KDF_P });
}
```

### Encryption (called from `save()`)

```88:104:packages/core/src/vault.ts
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
```

### Decryption (the only way back to the keys)

```106:115:packages/core/src/vault.ts
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
```

### Atomic save (prevents half-written corrupt vaults)

```216:222:packages/core/src/vault.ts
async save(): Promise<void> {
  const pt = this.requireUnlocked();
  const file = encrypt(Buffer.from(JSON.stringify(pt), 'utf8'), this.passphrase!);
  const tmp = `${this.filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
  await fs.rename(tmp, this.filePath);
}
```

`mode: 0o600` = readable/writable by your OS user only. Other users on the same machine cannot read it.

---

## What "no recovery" means

**There is no password reset, no admin override, no escrow, no hint, no recovery seed.** The vault file plus the passphrase is the only path back to the keys.

If you forget the passphrase, the file is mathematically unrecoverable. Brute-forcing scrypt(N=16384) at ~10ms per guess means a 12-character random alphanumeric passphrase takes ~30 trillion years on a single CPU. Nobody (me, the repo author, the Solana team, Anthropic) can help you get back in.

---

## Mandatory backups

Do **at least one** of these immediately after creating any vault that holds real money. Doing **both** is much safer.

### Backup A: write the passphrase down

Pick one:
- Paper, in a fireproof safe / safe deposit box
- Password manager (1Password, Bitwarden, KeePass) under a master password you memorise
- Split into 2–3 pieces stored in separate physical locations (Shamir-style)

**Do not** put the passphrase in a text file on the same disk as the vault. If your laptop dies you lose both at once.

### Backup B: export the secret keys to paper

Run this once per wallet, copy the output, then `Clear-Host` your terminal:

```76:93:apps/cli/src/commands/wallet.ts
  w.command('show')
    .description('reveal the secret key for a wallet (DANGEROUS)')
    .requiredOption('-l, --label <label>', 'wallet label')
    .action(async (opts: { label: string }) => {
      const v = new Vault();
      const p = await password({ message: 'vault passphrase:', mask: '*' });
      await v.unlock(p);
      const w2 = v.get(opts.label);
      if (!w2) {
        console.error(`no wallet '${opts.label}'`);
        process.exit(1);
      }
      const kp = Keypair.fromSecretKey(bs58.decode(w2.secretKeyB58));
      console.log(`label:      ${w2.label}`);
      console.log(`pubkey:     ${kp.publicKey.toBase58()}`);
      console.log(`secret b58: ${w2.secretKeyB58}`);
      console.log(`secret arr: [${Array.from(kp.secretKey).join(',')}]`);
    });
```

What you get:
- `secret b58` — the format Phantom / Solflare / Backpack use when importing a private key
- `secret arr` — the format Solana CLI's `keypair.json` uses

Save **both** lines. Phantom can recover the wallet from the b58 string at any time, completely independently of this bot.

### Backup C: copy the encrypted file off-disk

```powershell
Copy-Item .amm-mainnet/vault.enc D:\Backups\vault-mainnet-2026-04-30.enc
# Or to cloud:
Copy-Item .amm-mainnet/vault.enc $env:USERPROFILE\Dropbox\vault-mainnet.enc
```

The file is encrypted, so it's safe to put on Dropbox / iCloud / a USB stick. **Whoever finds the file still needs the passphrase**. Combine with Backup A and you've got a complete disaster-recovery plan: lose the laptop, restore the file from cloud, unlock with the passphrase from your password manager.

---

## What gets imported how

The bot accepts three ways to put a key into the vault:

```33:65:apps/cli/src/commands/wallet.ts
  w.command('generate')
    .description('generate new keypairs into the vault')
    .option('-c, --count <n>', 'number of wallets', '1')
    .option('-p, --prefix <s>', 'label prefix', 'wallet')
    .option('-t, --tag <tag...>', 'tags to attach')
    .action(async (opts: { count: string; prefix: string; tag?: string[] }) => {
      const ctx = await getContext();
      const labels = await ctx.vault.generate(parseInt(opts.count, 10), opts.prefix, opts.tag ?? []);
      console.log(`generated ${labels.length} wallets:`);
      for (const l of labels) console.log(`  ${l}`);
    });

  w.command('import')
    .description('import a wallet from a base58 secret key')
    .requiredOption('-l, --label <label>', 'wallet label')
    .option('-t, --tag <tag...>', 'tags to attach')
    .action(async (opts: { label: string; tag?: string[] }) => {
      const ctx = await getContext();
      const sk = await password({ message: 'base58 secret key:', mask: '*' });
      await ctx.vault.importFromBase58(opts.label, sk, opts.tag ?? []);
      console.log(`imported wallet '${opts.label}'`);
    });

  w.command('import-file')
    .description('import a wallet from a Solana CLI keypair JSON file')
    .requiredOption('-l, --label <label>', 'wallet label')
    .requiredOption('-f, --file <path>', 'keypair json file')
    .option('-t, --tag <tag...>', 'tags to attach')
    .action(async (opts: { label: string; file: string; tag?: string[] }) => {
      const ctx = await getContext();
      await ctx.vault.importFromKeypairFile(opts.label, opts.file, opts.tag ?? []);
      console.log(`imported wallet '${opts.label}' from ${opts.file}`);
    });
```

The validation paths inside the vault layer:

```282:304:packages/core/src/vault.ts
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
```

Note we **deliberately do not** support importing keys via env vars. Reasons:
- Env vars leak via shell history, process lists (`tasklist` / `ps`), crash dumps, error logs
- Anyone screen-recording you typing `$env:WALLET_KEY=...` captures the key
- Encrypted-at-rest is meaningless if the unencrypted form lives in your shell session

The masked `password()` prompt at line 51 of `wallet.ts` reads the secret without echoing it and without saving it to history.

---

## Memory hygiene

While the vault is unlocked, the keys exist in JavaScript memory as base58 strings. When you call `lock()`:

```198:206:packages/core/src/vault.ts
  /** Wipe in-memory plaintext and passphrase. */
  lock(): void {
    if (this.passphrase) {
      // Best-effort overwrite (V8 won't actually wipe but no harm).
      this.passphrase = '\0'.repeat(this.passphrase.length);
    }
    this.plaintext = null;
    this.passphrase = null;
  }
```

**Honest limitation**: V8 (Node's JS engine) does not give us a guaranteed `secure_zero_memory`. The strings may persist in the heap until garbage collection, and even after GC the memory pages aren't wiped. A full memory dump of the running process while the vault is unlocked could recover the keys.

Mitigations:
- Don't unlock the vault on shared machines
- Don't run the bot inside a VM you don't control
- `lock()` (or exit the process) as soon as you're done with privileged ops
- The web dashboard auto-locks after configurable inactivity (see `apps/web/src/server/session.ts`)

---

## Disaster scenarios — what to do

| Scenario | What to do |
|---|---|
| **Forgot passphrase, have paper backup of secret keys** | Re-import each key into a new vault: `amm vault init` → `amm wallet import --label X` → paste b58 secret. Or import directly into Phantom and continue from there. |
| **Lost the vault file, have passphrase + cloud backup of `vault.enc`** | Restore the file: `Copy-Item D:\Backups\vault.enc .amm-mainnet/vault.enc`. Unlock as normal. |
| **Lost the vault file, no backup, but you wrote down the secret keys** | Same as "forgot passphrase" path: new vault, import each key. |
| **Forgot passphrase AND no backup of either** | Funds are unrecoverable. Sorry. This is the single most common way self-custody users lose money. |
| **Computer compromised by malware** | Assume the vault file + passphrase are stolen the moment they're both on the machine. Move funds to a fresh wallet on a clean machine ASAP. The bot has no way to "freeze" or "revoke" — Solana doesn't work that way. |
| **Suspect someone shoulder-surfed your `wallet show` output** | Move funds to a new wallet immediately. Generate a new key, transfer everything, retire the compromised key. |
| **The bot crashes mid-transaction and you're not sure if a tx landed** | Run `amm wallet list --balances` to see balance after the crash. Check Solana Explorer for your wallet pubkey. The bot uses idempotent on-chain primitives — re-running won't double-spend. |
| **You committed `vault.enc` to a public git repo by accident** | The file is encrypted, so funds are **probably** safe — but only as strong as your passphrase. If your passphrase is short/guessable, move funds immediately. Either way, generate a new vault, force-push to remove the file from history (`git filter-repo`), and rotate keys. |

---

## What's intentionally NOT in this system

- **No telemetry.** The bot makes zero outbound calls except to RPC endpoints + DEX SDKs.
- **No remote DB.** All state lives in `~/.amm/state.db` (SQLite) and the local vault.
- **No fee skim.** No portion of P&L is sent anywhere.
- **No password recovery.** By design.
- **No env var for secret keys.** By design.
- **No vault sync between machines.** Manual file copy only.
- **No multi-sig support yet.** Single-key wallets only. (Multi-sig would be a future addition.)

---

## File checklist for going to mainnet

Before you put real money in:

- [ ] Vault created with a strong passphrase (16+ chars, not in any wordlist)
- [ ] Passphrase backed up in a password manager OR on paper in a safe
- [ ] Each wallet's secret-key b58 backed up in Phantom OR on paper
- [ ] `vault.enc` copied to a separate disk / cloud
- [ ] Tested the recovery: can you import the b58 secret into a fresh Phantom and see the same address?
- [ ] Wallet has only as much funding as you're willing to lose on this run
- [ ] You ran `--dry-run` first and read every log line
- [ ] You're on a personal machine, not a shared one
- [ ] You closed all other apps that might leak screen contents (screen-share, OBS, remote-desktop)

If any item is unchecked, fix it before proceeding.
