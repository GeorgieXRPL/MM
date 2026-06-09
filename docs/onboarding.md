# Onboarding: run the bot on devnet (explain-like-I'm-5)

Hi! This guide takes you from "I just cloned the repo" to "I have a market-making bot running on Solana" in about an hour. **No prior Solana knowledge is required.** I'll explain every word the first time it comes up.

If something below doesn't match what you see on your screen, scroll down to the **"Help, something broke"** section at the very bottom. There's a 99% chance it's listed.

---

## What is this thing, in plain English?

You're about to run a **market maker bot**. Here's what every word in that sentence means:

- **Solana** — a blockchain. Think of a blockchain as a giant shared spreadsheet that everyone can see and nobody can secretly edit.
- **Devnet** — Solana's free "practice mode". The coins on devnet aren't worth real money. You can lose all of them and nothing bad happens. We'll only ever use devnet in this guide.
- **Token** — a coin that lives on Solana. Like USDC, BONK, or the test "TEST" token we'll make up.
- **Pool** — a pile of two tokens that people can swap between. Example: a SOL/USDC pool lets people trade SOL for USDC.
- **Liquidity Provider (LP)** — someone who puts tokens into a pool so other people can trade against them. The LP earns a small fee on every trade.
- **DLMM** — "Dynamic Liquidity Market Maker". A specific kind of pool made by a company called Meteora. It lets the LP be very precise about *what price* their tokens are available at.
- **Single-sided LP** — putting only ONE of the two tokens into the pool, instead of both. Like saying "I'll sell my TEST tokens, but only if someone offers me at least 0.001 SOL each".
- **Market maker bot** — a program that automatically puts tokens in and out of the pool to earn fees and keep the price fair. That's what we're running.

This guide will:
1. Make a fake throwaway wallet
2. Get free practice SOL into it
3. Make up a brand-new token called "TEST"
4. Create a pool where people can trade TEST for SOL
5. Run the bot to provide liquidity to that pool
6. Watch it work

**You won't spend a single cent of real money.** Devnet SOL is free.

---

## Step 0 — Install the things you need

You only do this **once on your computer, ever**. Skip ahead if you already have them.

### 0a. Install Node.js

Node.js lets your computer run JavaScript programs. Our bot is written in JavaScript.

1. Go to https://nodejs.org/
2. Click the big green button that says **LTS** (currently version 20 or 22)
3. Run the installer. Click "Next" through all the screens.
4. **Important**: when it asks "Automatically install necessary tools" — say **YES** (check the box)

To check it worked, open **PowerShell** (press the Windows key, type `PowerShell`, click the blue icon) and run:

```powershell
node --version
```

You should see something like `v22.22.0` or `v20.19.0`. If it says "command not found", restart your computer and try again.

### 0b. Install pnpm

`pnpm` is a tool that downloads code libraries our bot needs. It's like a delivery truck for code.

In PowerShell, run:

```powershell
npm install -g pnpm
```

Check it worked:

```powershell
pnpm --version
```

You should see `10.x.x` or similar.

### 0c. Install Git

Git is what we use to download the code from GitHub.

1. Go to https://git-scm.com/download/win
2. Run the installer. Click "Next" through everything (defaults are fine).

Check it:

```powershell
git --version
```

You should see `git version 2.x`. If not, restart your computer.

That's it for installs.

---

## Step 1 — Get the code onto your computer

Pick a folder where you want the project to live. I'll use your Desktop:

```powershell
cd $env:USERPROFILE\Desktop
git clone https://github.com/GeorgieXRPL/MyMM.git
cd MyMM
```

> **What just happened?** `cd` means "change directory" (move into a folder). `git clone` downloads a copy of the entire repo. The last `cd MyMM` moves you into the folder you just downloaded.

You should now be inside the `MyMM` folder. To prove it:

```powershell
ls
```

You should see folders like `apps`, `packages`, `docs`, plus files like `README.md`. If you do, great. If not, double-check you ran `cd MyMM`.

---

## Step 2 — Install the bot's dependencies

The bot uses ~400 small libraries. We need to download them all.

```powershell
pnpm install
```

This takes **2–4 minutes** the first time. You'll see a wall of text scrolling. Most of it is normal.

> **What if I see warnings?** Lines that start with `WARN` are usually fine — they're just notes, not errors. Lines that start with `ERROR` or `ELIFECYCLE` are real problems — scroll down to "Help, something broke".

When it's done, you'll see something like `Done in 1m 42s`.

Now compile the bot's code (turn the TypeScript into JavaScript the computer can run):

```powershell
pnpm -r build
```

This also takes 1–3 minutes. When it's done, you should see a list ending with `@amm/web build` finishing successfully.

Quick sanity check — make sure the bot runs:

```powershell
node apps/cli/dist/index.js --help
```

You should see a list of commands like `vault`, `wallet`, `volume`, `lp`, `meteora-lp`, `devnet`, etc. If you do, the install worked.

---

## Step 3 — Set up your shell to use devnet

Devnet is the practice version of Solana. We need to tell the bot "use devnet, not the real one."

We do this by setting a few **environment variables** (named values that programs can read). In PowerShell, paste this **whole block** at once:

```powershell
$env:SOLANA_CLUSTER='devnet'
$env:RPC_PUBLIC='https://api.devnet.solana.com'
$env:RPC_WS_PUBLIC='wss://api.devnet.solana.com'
$env:VAULT_PATH='./.amm-devnet/vault.enc'
$env:VAULT_PASSPHRASE='devnet-test-pass'
$env:JITO_BLOCK_ENGINE_URL=''
```

> **What does each one mean?**
> - `SOLANA_CLUSTER=devnet` → "Use the practice Solana, not the real one."
> - `RPC_PUBLIC=https://...` → The web address of a Solana server we can talk to.
> - `VAULT_PATH=./.amm-devnet/vault.enc` → Where the bot will store your wallet keys (in a folder called `.amm-devnet` inside the project). Encrypted, so even on your hard drive it's safe.
> - `VAULT_PASSPHRASE=devnet-test-pass` → The password to unlock the vault. We're hard-coding it here so you don't have to type it every time. **Never do this with real money.**
> - `JITO_BLOCK_ENGINE_URL=''` → Jito is a service that only exists on the real Solana, not devnet. We're saying "don't use it."

> **IMPORTANT**: These variables only last as long as this **one PowerShell window** stays open. If you close the window and open a new one, **paste the block again**. Many problems further down come from forgetting this.

---

## Step 4 — Make a wallet

A **wallet** on Solana is just a private/public key pair. The public key is your "address" (you can share it). The private key is the password to spend the money — never share that.

Our bot stores wallets in an **encrypted vault** (a single file, locked with the password you set above).

### 4a. Create the empty vault

```powershell
node apps/cli/dist/index.js vault init --from-env
```

You should see:
```
vault created at ./.amm-devnet/vault.enc
```

### 4b. Generate one wallet inside the vault

```powershell
node apps/cli/dist/index.js wallet generate --count 1 --prefix devnet --tag lp
```

You should see:
```
generated 1 wallets:
  devnet-1
```

`devnet-1` is the **label** (a friendly name) of your new wallet. We'll use it everywhere from now on.

### 4c. See your wallet's public address

```powershell
node apps/cli/dist/index.js wallet list
```

You'll see a line like:
```
devnet-1             4Az37RSFdC8UDp8NpisoPrfJ2eV5aqZjCKTHKqJoRT2p [lp]
```

The long mess of letters in the middle is your **public address**. **Highlight it and copy it now** — you need it in the next step.

> **What if I see a different address?** That's expected. Every wallet is unique. Use *your* address, not the one in this guide.

---

## Step 5 — Get free practice SOL

Right now your wallet has 0 SOL. We need some to pay transaction fees and create stuff. Devnet has a **faucet** — a website that gives away free practice SOL.

1. Open this URL in your browser, but **replace `YOUR_PUBKEY` with the address you copied**:
   ```
   https://faucet.solana.com/?address=YOUR_PUBKEY&amount=2&cluster=devnet
   ```
2. The page should pre-fill your address. Make sure the dropdown says **devnet**.
3. Solve the captcha (click "I'm not a robot").
4. Click **Confirm Airdrop**.
5. Wait ~10 seconds. You should see a green "Success" message.
6. **Do this twice.** You need at least 4 SOL for everything in this guide. Creating the pool eats ~1.3 SOL on its own.

Now check the SOL landed in your wallet:

```powershell
node apps/cli/dist/index.js devnet doctor --wallet devnet-1
```

You should see:
```
SOLANA_CLUSTER=devnet
RPC_PUBLIC=https://api.devnet.solana.com
current slot: 458123456
devnet-1 (4Az37...): 4.000000 SOL
devnet state: missing
```

The `4.000000 SOL` line is what you want. If it says `0.000000 SOL`, the airdrop didn't work — wait 30 seconds and check again, or do the faucet page once more.

> **The faucet page isn't working / says "rate limited"?** This happens often. Alternatives:
> - Try https://www.helius.dev/faucet (sign up for a free account, paste your address)
> - Try https://faucet.quicknode.com/solana/devnet
> - Ask a friend who already has devnet SOL to send you 4 — devnet SOL is worthless, they won't mind

---

## Step 6 — Make up a brand-new token

A **token** is just a coin on Solana. We're going to invent one called "TEST" so we have something to trade. We'll also wrap 1 of our SOL into "WSOL" (Wrapped SOL) — some pools want SOL packaged as a token, like every other token.

```powershell
node apps/cli/dist/index.js devnet mint-test-tokens --wallet devnet-1 --base-supply 1000000 --wrap-sol 1
```

> **What's happening?**
> - `--base-supply 1000000` → make 1 million TEST tokens
> - `--wrap-sol 1` → take 1 SOL out of your wallet and convert it to WSOL (a tradeable token version)

This takes ~30 seconds. You should see something like:
```
creating base SPL token...
  base mint: 7nQy...long_address
minting initial supply to wallet...
  minted 1000000 TEST (raw=1000000000000) -> AbC1...
wrapping 1 SOL into WSOL...
  wsol funded: DeF2...  sig=ZxY3...
state saved to C:\Users\you\Desktop\MyMM\.amm-devnet\test-pool.json
```

The bot saved the addresses to a file so it remembers them. To see what it saved:

```powershell
node apps/cli/dist/index.js devnet show-state
```

To check your wallet now has the tokens:

```powershell
node apps/cli/dist/index.js devnet balances --wallet devnet-1
```

You should see something like:
```
SOL: 2.998500 SOL
  7nQy...   1000000  [TEST]
  So111...  1        [WSOL]
```

The `[TEST]` and `[WSOL]` tags confirm the bot recognises them.

---

## Step 7 — Create a Meteora DLMM pool

Now we'll create the trading pool itself: a place where people can swap TEST for WSOL.

```powershell
node apps/cli/dist/index.js devnet create-pool --wallet devnet-1 --bin-step 25 --initial-price 0.001
```

> **What do these numbers mean?**
> - `--bin-step 25` → Meteora pools work in "bins" (price buckets). 25 means each bin is 0.25% wide. Smaller = tighter trading prices but more bins to manage. 25 is a sensible default.
> - `--initial-price 0.001` → start price: 1 TEST is worth 0.001 WSOL. (You can change this later, this just sets where trading starts.)

This takes ~30 seconds. You should see:
```
discovering preset parameters...
  preset: GwK2...  (binStep=25)
  activeId: -27631 (price=0.001)
building createLbPair2 transaction...
  pool created. signature=AbC1...
  pool pubkey: BvLp...long_address
state saved to C:\...
next steps:
  amm meteora-lp start ...
```

**Copy the `pool pubkey` line — that's your pool's address. You need it for the next steps.**

Save it as a variable so you can paste it easily:

```powershell
$POOL='PASTE_YOUR_POOL_PUBKEY_HERE'
```

(Replace `PASTE_YOUR_POOL_PUBKEY_HERE` with the actual address from the line above.)

To check the pool was actually created on-chain:

```powershell
node apps/cli/dist/index.js devnet doctor --wallet devnet-1
```

You should now also see:
```
devnet state: present
  pool: BvLp...
  meteora venue: OK (loaded pool from chain)
```

**That `meteora venue: OK` line is the gold star.** It means the bot successfully read your pool back from the blockchain. If you see it, you're winning.

---

## Step 8 — Test a manual deposit (optional but recommended)

Before letting the bot run on its own, let's manually put some liquidity into the pool to make sure everything works. We'll do a **single-sided buy ladder**: 0.1 WSOL, no TEST. This means the bot is offering to buy TEST tokens at slightly below the current price.

```powershell
node apps/cli/dist/index.js lp deposit `
  --venue meteora-dlmm `
  --pool $POOL `
  --wallet devnet-1 `
  --mode quote-only `
  --strategy-type spot `
  --bin-offset 1 `
  --base 0 `
  --quote 0.1 `
  --width 0.05 `
  --slippage 100
```

> **What do these flags mean?**
> - `--mode quote-only` → put in only the QUOTE token (WSOL), nothing of the BASE token (TEST). This is what "single-sided" means.
> - `--strategy-type spot` → spread the WSOL evenly across all the bins in our range.
> - `--bin-offset 1` → start the position 1 bin away from the current price (so we're slightly below current price = a buy order).
> - `--base 0` → 0 TEST tokens deployed
> - `--quote 0.1` → 0.1 WSOL deployed
> - `--width 0.05` → spread the position over a 5% price range
> - `--slippage 100` → tolerate 1% price slip during the deposit (slippage is measured in basis points, 100 = 1%)

After ~10 seconds you should see something like:
```
deposit succeeded. position=Pos1...  signature=Sig1...
```

Now list your positions to confirm:

```powershell
node apps/cli/dist/index.js lp positions --venue meteora-dlmm --pool $POOL --wallet devnet-1
```

You should see one position. Copy its address.

Now close the position to free up the WSOL before we run the auto-strategy:

```powershell
node apps/cli/dist/index.js lp withdraw `
  --venue meteora-dlmm `
  --pool $POOL `
  --position PASTE_POSITION_ADDRESS `
  --wallet devnet-1 `
  --bps 10000
```

`--bps 10000` means "withdraw 100% of the position" (basis points: 10000 = 100%).

If both deposit and withdraw worked, the venue layer is healthy and we're ready for the real test.

---

## Step 9 — Run the bot in DRY-RUN mode

**Dry-run** means the bot will *think out loud* about what it would do, but **send zero transactions**. This is the safest way to see what the bot is going to do before letting it loose.

```powershell
node apps/cli/dist/index.js meteora-lp start `
  --pool $POOL `
  --wallet devnet-1 `
  --mode quote-only `
  --strategy-type spot `
  --width 0.05 `
  --bin-offset 1 `
  --slippage 100 `
  --rebalance-hysteresis 0.5 `
  --compound-fees `
  --auto-redeploy `
  --dry-run
```

> **What's new here vs the manual deposit?**
> - `--rebalance-hysteresis 0.5` → only rebalance when the price moves more than half the position width (so 0.5 × 5% = 2.5%). This stops the bot rebalancing every tiny tick.
> - `--compound-fees` → re-add earned fees back into the position automatically.
> - `--auto-redeploy` → when a single-sided position gets fully filled (someone bought all our TEST), open a new one in the opposite direction.
> - `--dry-run` → don't actually send transactions.

The bot will start logging. **It runs forever until you stop it.** You should see lines like:
```
meteora-lp loop tick
[dry-run] would open position: lower=-27640, upper=-27620, base=0, quote=0.05
position in range, holding
meteora-lp loop tick
position in range, holding
```

**Read these logs carefully — this is the bot's brain talking.** Every "tick" is one decision cycle (every ~30 seconds).

When you've seen enough, press **`Ctrl+C`** to stop the bot.

---

## Step 10 — Run the bot LIVE (small amounts)

Now we'll run it for real. Same command, but we **remove `--dry-run`** and add explicit deploy amounts. **Keep amounts tiny** so a mistake costs nothing:

```powershell
node apps/cli/dist/index.js meteora-lp start `
  --pool $POOL `
  --wallet devnet-1 `
  --mode quote-only `
  --strategy-type spot `
  --width 0.05 `
  --bin-offset 1 `
  --slippage 100 `
  --rebalance-hysteresis 0.5 `
  --base-amount 0 `
  --quote-amount 0.05 `
  --compound-fees `
  --auto-redeploy
```

You should see real activity:
```
meteora-lp loop tick
opened position 9zXq...  signature AbC1...
meteora-lp loop tick
position in range, holding
meteora-lp loop tick
position in range, holding
... (this is the boring happy path) ...
```

To see your position on Solana Explorer (a website that shows blockchain data):

1. Open: `https://explorer.solana.com/address/YOUR_WALLET_PUBKEY?cluster=devnet`
   (replace `YOUR_WALLET_PUBKEY` with your address from Step 4c)
2. Click the **"Tokens"** tab to see your TEST and WSOL balances
3. Click the **"Transactions"** tab to see the bot's activity

When you've seen enough, press **`Ctrl+C`**. The bot stops, but **does not** automatically close the position. You can leave it open or close it via Step 8's withdraw command.

---

## Step 11 — Use the web dashboard (much nicer than CLI)

The bot also has a web UI. Open a **second** PowerShell window. Paste the env-var block from Step 3 again (remember: env vars don't carry over between windows). Then:

```powershell
cd $env:USERPROFILE\Desktop\MyMM
pnpm --filter @amm/web dev
```

You'll see something like:
```
▲ Next.js 15.x
- Local:    http://127.0.0.1:4317
- ready in 2.1s
```

Open http://127.0.0.1:4317 in your browser. It'll ask for the vault password — type `devnet-test-pass` and click Unlock.

You'll see three pages in the top nav:
- **`/wallets`** — see balances of all your wallets
- **`/lp`** — manual deposits, claim fees, close positions (same as Step 8 but with buttons)
- **`/runs`** — start strategies and control them with **Pause / Resume / Edit / Stop** buttons

Try it: scroll to "Start Meteora LP" on the `/runs` page, paste your pool address, pick `devnet-1`, fill in the same fields as Step 10, click **Start**. The active runs list at the top will now show your run with controls.

The **Edit** button lets you change settings *while the bot is running* — e.g. tighten the width or turn off compounding without restarting.

To stop the dashboard, go back to the terminal window where you ran `pnpm --filter @amm/web dev` and press `Ctrl+C`.

---

## Step 12 — Reset between runs (when you want a clean slate)

When you want to start over with a brand-new wallet and pool:

```powershell
# 1. Close any open positions first (Step 8 withdraw, or click Close in the web UI)
# 2. Then nuke the local devnet state:
Remove-Item -Recurse -Force .amm-devnet
```

This deletes your devnet vault and forgets the pool address. Then start again from Step 4. (The mints + pool stay on devnet forever — you can't "delete" things from a blockchain — but the bot won't know about them anymore.)

---

## You did it!

You now have:
- A working dev environment for a Solana market-maker
- A live (devnet) auto-LP strategy you can run from the CLI or web UI
- Enough understanding to read the code and start contributing

---

## Where to read next

Read these files in this exact order to learn how the bot is organised:

1. **`packages/shared/src/types.ts`** — every kind of data the bot uses
2. **`packages/venues/src/venue.ts`** — the contract every DEX adapter follows
3. **`packages/venues/src/meteora.ts`** — the Meteora adapter (the most fully-built one)
4. **`packages/strategies/src/strategy.ts`** — the lifecycle every strategy follows
5. **`packages/strategies/src/meteora-lp/meteora-lp-strategy.ts`** — the auto-LP brain (~400 lines, well-commented)
6. **`packages/orchestrator/src/orchestrator.ts`** — how the strategies get started and stopped
7. **`apps/cli/src/commands/`** — one file per CLI command group; small and easy to read
8. **`apps/web/src/app/runs/page.tsx`** — the React UI for starting strategies
9. **`apps/cli/src/commands/devnet.ts`** — the test harness you used in this guide

Always run `pnpm -r build` from the project root before you commit code — it does a strict TypeScript check across all packages and catches most mistakes.

---

## Help, something broke

| What you see | What it means | What to do |
|---|---|---|
| `command not found: node` | Node.js isn't on your PATH | Restart your computer; if still broken, reinstall Node and tick "add to PATH" |
| `command not found: pnpm` | pnpm isn't installed | Run `npm install -g pnpm` |
| `pnpm install` errors with `EACCES` | Permission problem | Don't use `sudo`. Run PowerShell as Administrator once, then never again. |
| `pnpm -r build` fails with `TS2307: Cannot find module` | Out-of-order build | Run `pnpm install` then `pnpm -r build` again |
| `airdrop ... 429 Too Many Requests` | Public faucet is throttled | Use the web faucet at https://faucet.solana.com/ instead |
| `airdrop ... faucet has run dry` | Faucet pool is empty | Try a different faucet (Helius, QuickNode) — listed in Step 5 |
| `no preset parameter with binStep=25 on devnet` | Devnet doesn't have that bin step | Try `--bin-step 10`, `20`, `50`, or `100` |
| `Insufficient funds` on `create-pool` | Wallet too low on SOL | Get more from the faucet — pool creation needs ~1.3 SOL |
| `pool not found` from `meteora-lp` | Wrong cluster | Confirm `$env:SOLANA_CLUSTER='devnet'` is set IN THIS SHELL |
| `vault locked` in web dashboard | Wrong/missing password | Re-enter `devnet-test-pass`; if env var not set, restart `pnpm dev` after pasting Step 3's block |
| `bigint: Failed to load bindings, pure JS will be used` | Cosmetic warning from bn.js | Ignore it. Nothing's broken. |
| Strategy never opens a position | Wallet doesn't have the right token | For `quote-only` you need WSOL. For `base-only` you need TEST. Check with `devnet balances`. |
| Web dashboard says `Failed to fetch` everywhere | Backend isn't running on devnet env | The `pnpm dev` process needs the env vars from Step 3 set in ITS shell window |
| You get totally stuck | Read the bot's logs | They almost always say what went wrong in plain English |

If none of the above helps, open an issue on the GitHub repo and paste:
1. The exact command you ran
2. The full output (copy from PowerShell with right-click → Mark → select → Enter to copy)
3. Your OS (Windows / macOS / Linux)
