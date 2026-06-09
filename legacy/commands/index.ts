export const commandList = [
    { command: 'start', description: 'Start the bot' },
];

import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ADDITIONAL_FEE, BUY_INTERVAL_MAX, BUY_INTERVAL_MIN, BUY_LOWER_AMOUNT, BUY_UPPER_AMOUNT, DAO_CONFIRM_FEE, DAO_PUBLIC_KEY, DEV_CONFIRM_FEE, DISTRIBUTE_WALLET_NUM, DISTRIBUTION_AMOUNT, LAMPORTS_PER_SOL, OWNER_PUBLIC_KEY, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT, SELL_ALL_BY_TIMES, SLIPPAGE, solanaConnection, webSite } from "../config";
import * as helper from "./helper"
import { startVolumeBot } from "../volume_bot";
import base58 from "bs58";
import { cancelProcess, getTokenAddress, startProcess } from "./helper";
import { getPoolKeys } from "../volume_bot/utils/getPoolInfo";
import { gather } from "../volume_bot/gather";

export const welcome = async (chatId: number, username?: string) => {
    const userInfo = await helper.findOfUser(chatId, username);

    if (userInfo?.publicKey) {
        console.log("This is already registered User. User's wallet is set: ", userInfo?.publicKey)

        const publicKey: PublicKey = new PublicKey(userInfo?.publicKey!);
        const solAmount = (await solanaConnection.getBalance(publicKey)) / LAMPORTS_PER_SOL;
        const title = `😎 Welcome to MassVol.
        💹 Your Wallet SecretKey: <code>${userInfo.privateKey}</code>
        
        💹 Your Wallet PublicKey: <code>${userInfo.publicKey}</code>
        
        💰 Your Balance: ${solAmount} sol`
        const content = [[{ text: '⚡ Boost Volume ⚡', callback_data: 'boostVolume' }]]

        return { title, content }
    } else {
        console.log("User's wallet is not set.")
        const title = `📢 Here's How: Click Boost Volume below and choose Default or GOD Mode

        💸 Volume Boost: Generate MASSIVE Volume! ⚡

        🍒 GOD Mode: Default mode is available if this is your first timee using <b>MassVol<b> 

        💼 Customizable Parameters: Go GOD mode and Customize your experience 😎

        🌟 Organic Trending: High transaction rates and Volume with <b>MassVol/b> 
        
        Get MASSIVE!`
        const content = [[{ text: 'Boost Volume 🚀', callback_data: 'boostVolume' }]]
        return { title, content }
    }
}

export const selectOption = async (chatId: number) => {
    const title = `📢 Select one of the options to run volume booster 📢

    🍒 <b>Default</b> Generates 8 wallets and distributes 0.1 Solana to each wallet.

    ⚡ <b>GOD Mode</b> Fully customize your experience ⚡
    `
    const content = [[{ text: 'Default 🚀', callback_data: 'package1' }, { text: 'GOD Mode 🚈', callback_data: 'customOption' }]]
    return { title, content }
}

export const customOption = async (chatId: number, username?: string) => {
    const userData = {
        username: username,
        distributionAmount: DISTRIBUTION_AMOUNT,
        buyUpperAmount: BUY_UPPER_AMOUNT,
        buyLowerAmount: BUY_LOWER_AMOUNT,
        buyIntervalMax: BUY_INTERVAL_MAX,
        buyIntervalMin: BUY_INTERVAL_MIN,
        distributeWalletNum: DISTRIBUTE_WALLET_NUM,
        sellAllByTimes: SELL_ALL_BY_TIMES
    }
    const userInfo = await helper.findOfUser(chatId, username);

    if (userInfo) {
        const title = `🎄 Variables for Trading
    Amount of SOL to distribute to each wallet: ${userInfo.distributionAmount} 
        (Min 0.05)
    Number of wallets to distribute SOL to: ${userInfo.distributeWalletNum} 
        (Max 500 for now 😎) 

    Lower amount for Buying per Transaction: ${userInfo.buyLowerAmount} 
        (Must be set lower than Upper amount)
    Upper amount for Buying per Transaction: ${userInfo.buyUpperAmount} 
        (Must be set lower than distribution amount)

    Minimum interval between buys in milliseconds: ${userInfo.buyIntervalMin} 
        (Recommended to stay above 500)
    Maximum interval between buys in milliseconds: ${userInfo.buyIntervalMax} 
        (Recommended to stay below 10000000)
       `
        const content = [[{ text: '💵Distribute Amount', callback_data: 'setDistributionAmt' }, { text: '💸Distribute Wallets', callback_data: 'setDistributionWalletNum' }],
        [{ text: '💰Buy Lower', callback_data: 'setBuyLowerAmount' }, { text: '💰Buy Upper', callback_data: 'setBuyUpperAmount' }],
        [{ text: '⌚Buy Interval Min', callback_data: 'setBuyIntervalMin' }, { text: '⏰Buy Interval Max', callback_data: 'setBuyIntervalMax' }],
        [{ text: 'FINISH', callback_data: 'sendTokenAddr' }]]

        return { title, content };
    } else {
        const userInfo = await helper.saveInfo(chatId, userData);
        const title = `🎄 Variables for Trading
        Amount of SOL to distribute to each wallet: ${DISTRIBUTION_AMOUNT} 
            (Min 0.05)
        Number of wallets to distribute SOL to: ${DISTRIBUTE_WALLET_NUM} 
            (Max 500 for now 😎) 

        Upper amount for Buying per Transaction: ${BUY_UPPER_AMOUNT} 
            (Must be set lower than distribution amount)
        Lower amount for Buying per Transaction: ${BUY_LOWER_AMOUNT} 
            (Must be ste lower than Upper amount)

        Maximum interval between buys in milliseconds: ${BUY_INTERVAL_MAX} 
            (Recommended to stay below 10000000)
        Minimum interval between buys in milliseconds: ${BUY_INTERVAL_MIN} 
            (Recommended to stay above 500)
        `
        const content = [[{ text: '💵Distribute Amount', callback_data: 'setDistributionAmt' }, { text: '💸Distribute Wallets', callback_data: 'setDistributionWalletNum' }],
        [{ text: '💰Buy Lower', callback_data: 'setBuyLowerAmount' }, { text: '💰Buy Upper', callback_data: 'setBuyUpperAmount' }],
        [{ text: '⌚Buy Interval Min', callback_data: 'setBuyIntervalMin' }, { text: '⏰Buy Interval Max', callback_data: 'setBuyIntervalMax' }],
        [{ text: 'FINISH', callback_data: 'sendTokenAddr' }]]

        return { title, content };
    }

}

export const displaySettings = async (chatId: number, username?: string) => {
    const userData = {
        username: username,
        distributionAmount: DISTRIBUTION_AMOUNT,
        buyUpperAmount: BUY_UPPER_AMOUNT,
        buyLowerAmount: BUY_LOWER_AMOUNT,
        buyIntervalMax: BUY_INTERVAL_MAX,
        buyIntervalMin: BUY_INTERVAL_MIN,
        distributeWalletNum: DISTRIBUTE_WALLET_NUM,
        sellAllByTimes: SELL_ALL_BY_TIMES
    }
    const userInfo = await helper.saveInfo(chatId, userData);
    const title = `🎄 Variables for Trading
    Amount of SOL to distribute to each wallet: ${DISTRIBUTION_AMOUNT}   
    Number of wallets to distribute SOL to: ${DISTRIBUTE_WALLET_NUM}

    Upper amount for Buying per Transaction: ${BUY_UPPER_AMOUNT} 
    Lower amount for Buying per Transaction: ${BUY_LOWER_AMOUNT}
    
    Maximum interval between buys in milliseconds: ${BUY_INTERVAL_MAX}
    Minimum interval between buys in milliseconds: ${BUY_INTERVAL_MIN}
       `
    const content = [[{ text: ' Send Token Address 📨', callback_data: 'sendTokenAddr' }]]
    return { title, content }
}

export const sendTokenAddr = async (chatId: number, tokenAddr: String) => {
    const userInfo = await helper.findOfUser(chatId);
    // const totalAmount = await solanaconnection.getbalalcne(new PublicKey(userInfo.publicKey))

    await helper.updateTokenAddr(chatId, tokenAddr);
    const title = `💵 Token address is set correctly: <code>${tokenAddr}</code>
    👨‍💼 Press Continue button to continue or Press Reset button to start over`
    const content = [[{ text: `Continue`, callback_data: `makeVolumeWallet` }, { text: `Reset`, callback_data: `sendTokenAddr` }]]

    return { title, content };
}
export const makeVolumeWallet = async (chatId: number, username?: string) => {
    const userData = await helper.findOfUser(chatId);
    const publicKey: PublicKey | undefined = userData?.publicKey ? new PublicKey(userData.publicKey) : undefined;
    const newWalletFee = 0.00015
    if (publicKey) {
        const solBalance = (await solanaConnection.getBalance(publicKey)) / LAMPORTS_PER_SOL;
        const volumeAmt = (userData?.distributionAmount! + newWalletFee) * userData?.distributeWalletNum! * (100 + DEV_CONFIRM_FEE + DAO_CONFIRM_FEE) / 100;
        if (solBalance >= volumeAmt) {
            const title = `Your volume bot wallet:
    <code>${publicKey}</code>
    sol Balance in your MassVol wallet: ${solBalance.toFixed(3)}
    sol amount for volume booster: ${volumeAmt.toFixed(3)}
    Your wallet Sol balance is enough for trading`
            const content = [[{ text: '🏆 OK', callback_data: 'confirmWallet' }]]
            return { title, content }
        } else {
            const depositAmt = volumeAmt - solBalance;
            const title = `Your volume bot wallet:  
    <code>${publicKey}</code>
    sol Balance in your MassVol wallets: ${solBalance.toFixed(3)}
    sol amount for volume booster: ${volumeAmt}
        💹 Please Deposit ${depositAmt} sol for volume booster:`
            const content = [[{ text: '💰 Deposit Sol', callback_data: 'deposit' }]]
            return { title, content }
        }
    } else {
        const wallet = Keypair.generate();
        const newPublicKey = await helper.addWallet(chatId, wallet);
        const volumeAmt = (userData?.distributionAmount! + newWalletFee) * userData?.distributeWalletNum! * (100 + DEV_CONFIRM_FEE + DAO_CONFIRM_FEE) / 100;

        const title = `Your volume bot wallet:  
    <code>${newPublicKey}</code>
    💹 Please input ${volumeAmt} sol for volume booster:`
        const content = [[{ text: '💰 Deposit Sol', callback_data: 'deposit' }]]
        return { title, content }
    }
}

export const checkDeposit = async (chatId: number) => {
    const title = `Did you deposit sol?💸 `
    const content = [[{ text: '🏆 Yes', callback_data: 'confirmWallet' }, { text: '❌ Not yet', callback_data: 'deposit' }]]
    return { title, content }
}

export const confirmWallet = async (chatId: number) => {
    try {
        const newWalletFee = 0.00015
        const userData = await helper.findOfUser(chatId);
        const publicKey: PublicKey | undefined = userData?.publicKey ? new PublicKey(userData.publicKey) : undefined;
        const privateKey: string = userData?.privateKey!;

        // Create a Keypair from the private key
        const keypair = Keypair.fromSecretKey(base58.decode(privateKey))
        const ownerPublicKey: PublicKey = new PublicKey(OWNER_PUBLIC_KEY);
        const daoPublicKey: PublicKey = new PublicKey(DAO_PUBLIC_KEY);
        const minSolBalance = (userData?.distributionAmount! + newWalletFee) * userData?.distributeWalletNum! * (100 + DEV_CONFIRM_FEE + DAO_CONFIRM_FEE) / 100;
        // const minSolBalance = (userData?.distributionAmount! + newWalletFee) * userData?.distributeWalletNum!;

        if (publicKey) {
            const solBalance = (await solanaConnection.getBalance(publicKey)) / LAMPORTS_PER_SOL;
            const devFee = userData?.distributionAmount! * userData?.distributeWalletNum! * DEV_CONFIRM_FEE / 100;
            const daoFee = userData?.distributionAmount! * userData?.distributeWalletNum! * DAO_CONFIRM_FEE / 100;
            console.log(`SOL Balance: ${solBalance}`);

            if (solBalance != 0) {
                if (solBalance > minSolBalance) {
                    const sendSolTx: TransactionInstruction[] = []
                    sendSolTx.push(
                        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
                        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 })
                    )
                    sendSolTx.push(
                        SystemProgram.transfer({
                            fromPubkey: publicKey,
                            toPubkey: ownerPublicKey,
                            lamports: Math.round(devFee * LAMPORTS_PER_SOL)
                        })
                    )
                    sendSolTx.push(
                        SystemProgram.transfer({
                            fromPubkey: publicKey,
                            toPubkey: daoPublicKey,
                            lamports: Math.round(daoFee * LAMPORTS_PER_SOL)
                        })
                    )
                    const solanaConnection = new Connection(RPC_ENDPOINT, {
                        wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
                    })
                    const siTx = new Transaction().add(...sendSolTx)
                    const latestBlockhash = await solanaConnection.getLatestBlockhash()
                    siTx.feePayer = publicKey
                    siTx.recentBlockhash = latestBlockhash.blockhash
                    // const messageV0 = new TransactionMessage({
                    //     payerKey: publicKey,
                    //     recentBlockhash: latestBlockhash.blockhash,
                    //     instructions: sendSolTx,
                    // }).compileToV0Message()
                    // const transaction = new VersionedTransaction(messageV0)
                    // transaction.sign([keypair])

                    const simRes = (await solanaConnection.simulateTransaction(siTx))
                    console.log('Fee pay transaction simulation', simRes.value.logs)

                    const signature = await solanaConnection.sendTransaction(siTx, [keypair], { skipPreflight: true })

                    // let i = 0;
                    // while (i < 5) {
                    const confirmation = await solanaConnection.confirmTransaction(
                        {
                            signature,
                            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                            blockhash: latestBlockhash.blockhash,
                        }
                    );

                    if (confirmation.value.err) {
                        console.log("confirm error");
                        // i++;
                    } else {
                        const feePayTx = signature ? `https://solscan.io/tx/${signature}` : ''
                        console.log("Fee paid successfully: ", feePayTx);
                        const volumeWalletAmount = (await solanaConnection.getBalance(publicKey)) / LAMPORTS_PER_SOL;
                        const title = `SOL Balance: ${volumeWalletAmount}`;
                        const content = [[{ text: '🏆 Start', callback_data: 'start' }]]
                        return { title, content }
                    }
                    // }

                    const title = `Retry to Confirm`;
                    const content = [[{ text: '🔁 Retry', callback_data: 'confirmWallet' }]]
                    return { title, content }

                } else {
                    const title = `SOL Balance: ${solBalance}
    You must deposit ${minSolBalance} at least for Trading. `
                    const content = [[{ text: '💰 Deposit Sol', callback_data: 'deposit' }]]
                    return { title, content }
                }
            } else {
                const title = `Retry to Confirm`;
                const content = [[{ text: '🔁 Retry', callback_data: 'confirmWallet' }]]
                return { title, content }
            }

        } else {
            console.log("Public key not found.");

            const title = `ReTry Confirm`;
            const content = [[{ text: '🔁 Retry', callback_data: 'confirmWallet' }]]
            return { title, content }
        }
    } catch (error) {
        console.error("Error confirming wallet:", error);

        const title = `An error occurred`;
        const content = [[{ text: '🔁 Retry', callback_data: 'confirmWallet' }]];
        return { title, content };
    }
}

export const setDistributionAmt = async (chatId: number, distributionAmt: number) => {
    console.log('setDistributionAmt function amount', distributionAmt);
    if (distributionAmt < 0.05) {
        const title = `💵 Distribution amount should be greater than 0.05Sol
        👨‍💼 please ReInput the valid value`
        const content = [[{ text: `✏️ Reset`, callback_data: `resetDistributionAmt` }]]

        return { title, content };
    }

    await helper.updateDistributionAmt(chatId, distributionAmt);
    const title = `💵 Amount of SOL to distribute to each wallet is set correctly: ${distributionAmt} sol
        👨‍💼 press Continue button`
    const content = [[{ text: `✏️ Continue`, callback_data: `customOption` }, { text: `✏️ Reset`, callback_data: `setDistributionAmt` }]]

    return { title, content };
}

export const setDistributionWalletNum = async (chatId: number, distributionWalletNum: number) => {
    const userInfo = await helper.findOfUser(chatId);

    if (distributionWalletNum > 500) {
        const title = `💵 Number of wallets should be less than 500
        👨‍💼 press Continue button`
        const content = [[{ text: `✏️ Reset`, callback_data: `resetDistributionWalletNum` }]]

        return { title, content }
    }

    await helper.updateDistributionWalletNum(chatId, distributionWalletNum);
    const title = `💵 Number of wallets for trading is set correctly: ${distributionWalletNum}
        👨‍💼 press Continue button`
    const content = [[{ text: `✏️ Continue`, callback_data: `customOption` }, { text: `✏️ Reset`, callback_data: `setDistributionWalletNum` }]]

    return { title, content };
}

export const setBuyUpperAmount = async (chatId: number, buyUpperAmount: number) => {
    const userInfo = await helper.findOfUser(chatId);

    let title: string
    let reset: boolean = false
    let content: any
    if (userInfo?.distributionAmount! < buyUpperAmount || userInfo?.buyLowerAmount! > buyUpperAmount) {
        title = `💵 The maximum random buy amount must be less than the total distribution amount accounting for transaction fees and greater than the lower buy amount.
                👨‍💼 press Reset button`
        content = [[{ text: `✏️ Reset`, callback_data: `resetBuyUpperAmount` }]]
        reset = true
    }
    else {
        await helper.updateBuyUpperAmount(chatId, buyUpperAmount);
        title = `💵 The Upper limit for random buy amount is set correctly: ${buyUpperAmount}Sol
            👨‍💼 press Continue button`
        content = [[{ text: `✏️ Continue`, callback_data: `customOption` }, { text: `✏️ Reset`, callback_data: `setBuyUpperAmount` }]]
    }

    return { title, content, reset };
}

export const setBuyLowerAmount = async (chatId: number, buyLowerAmount: number) => {
    const userInfo = await helper.findOfUser(chatId);

    let title: string
    let content: any
    let reset: boolean = false

    if (0.001 > buyLowerAmount || userInfo?.distributionAmount! < buyLowerAmount || userInfo?.buyUpperAmount! < buyLowerAmount) {
        title = `💵 The lower buy amount must be less than the distribution amount accounting for transaction fees and the upper buy amount, and greater than the minimum allowed value 0.001.
                    👨‍💼 Press Reset button`
        content = [[{ text: `✏️ Reset`, callback_data: `resetBuyLowerAmount` }]]
        reset = true
    } else {
        await helper.updateBuyLowerAmount(chatId, buyLowerAmount);
        title = `💵 The Lower limit for the random buy amount is set correctly: ${buyLowerAmount}Sol
            👨‍💼 Press Continue button`
        content = [[{ text: `✏️ Continue`, callback_data: `customOption` }, { text: `✏️ Reset`, callback_data: `setBuyLowerAmount` }]]
    }

    return { title, content, reset };
}

export const setBuyIntervalMax = async (chatId: number, buyIntervalMax: number) => {
    const MAX_INTERVAL = 10000000
    const userInfo = await helper.findOfUser(chatId);

    let title: string
    let content: any
    let reset: boolean = false

    if (buyIntervalMax >= MAX_INTERVAL || userInfo?.buyIntervalMin! >= buyIntervalMax) {
        title = `💵 Maximum buy interval must be smaller than MAX limit amount and greater than Minimum buy interval.
                👨‍💼 Press Reset button`
        content = [[{ text: `✏️ Reset`, callback_data: `resetBuyIntervalMax` }]]
        reset = true
    }
    else {
        await helper.updateBuyIntervalMax(chatId, buyIntervalMax);

        title = `💵 Maximum interval between buys in milliseconds is set correctly: ${buyIntervalMax}
            👨‍💼 press Continue button`
        content = [[{ text: `✏️ Continue`, callback_data: `customOption` }, { text: `✏️ Reset`, callback_data: `setBuyIntervalMax` }]]
    }

    return { title, content, reset };
}

export const setBuyIntervalMin = async (chatId: number, buyIntervalMin: number) => {
    const userInfo = await helper.findOfUser(chatId);

    let title: string
    let content: any
    let reset: boolean = false

    const MIN_INTERVAL = 500

    if (buyIntervalMin >= userInfo?.buyIntervalMax! || buyIntervalMin < MIN_INTERVAL) {
        title = `💵Minimum buy interval must be less than Maximum buy interval and greater than MINIMUM value.
                👨‍💼 Press Reset button`
        content = [[{ text: `✏️ Reset`, callback_data: `resetBuyIntervalMin` }]]
        reset = true
    } else {
        await helper.updateBuyIntervalMin(chatId, buyIntervalMin);
        title = `💵Minimum interval between buys in milliseconds is set correctly: ${buyIntervalMin}
            👨‍💼 press Continue button`
        content = [[{ text: `✏️ Continue`, callback_data: `customOption` }, { text: `✏️ Reset`, callback_data: `setBuyIntervalMin` }]]
    }

    return { title, content, reset };
}

export const setSellAllByTimes = async (chatId: number, sellAllByTimes: number) => {
    const userInfo = await helper.findOfUser(chatId);

    await helper.updateSellAllByTimes(chatId, sellAllByTimes);
    const title = `💵Number of times to sell all tokens in sub-wallets gradually is set correctly: ${sellAllByTimes}
    👨‍💼 Press Continue button`
    const content = [[{ text: `✏️ Continue`, callback_data: `customOption` }, { text: `✏️ Reset`, callback_data: `setSellAllByTimes` }]]

    return { title, content };
}

export const setSlippage = async (chatId: number, slippage: number) => {
    const userInfo = await helper.findOfUser(chatId);

    await helper.updateSlippage(chatId, slippage);
    const title = `💵Number of times to sell all tokens in sub-wallets gradually is set correctly: ${slippage}
    👨‍💼 Press Continue button`
    const content = [[{ text: `✏️ Continue`, callback_data: `customOption` }, { text: `✏️ Reset`, callback_data: `setSlippage` }]]

    return { title, content };
}

export const reclaim = async (chatId: number) => {
    const userInfo = await helper.findOfUser(chatId)
    await gather(chatId, Keypair.fromSecretKey(base58.decode(userInfo?.privateKey!)));
    const title = `💵Reclaiming the remaining Sol that you distributed...
    please wait for reclaim to finish before restarting.
    👨‍💼 If you want to restart, Press Restart Button once reclaim has finished.`
    const content = [[{ text: `✏️ Restart`, callback_data: `restart` }]]

    return { title, content }
}

export const start = async (chatId: number) => {
    const userInfo = await helper.findOfUser(chatId);
    const baseMint = await getTokenAddress(chatId)
    const poolKeys = await getPoolKeys(solanaConnection, new PublicKey(baseMint!))
    const poolId = poolKeys?.id
    // console.log("========================userInfo==============", userInfo)
    startProcess(chatId);
    startVolumeBot(userInfo, chatId);
    const title = `💵Now Distributing Sol and Trading.....`
    const content = [[{ text: `✏️ Click here to see transactions in Dexscreener`, url: `https://dexscreener.com/solana/${poolId!.toLowerCase()}` }],
    [{ text: `✏️Stop Volume Bot`, callback_data: `stop` }]]

    return { title, content };
}

export const stopProcess = async (chatId: number) => {
    cancelProcess(chatId);
    const title = `💵Trading is stopped!
    The volume boosting process is stopped.
    If you want to reclaim, click Reclaim button.
    If you want to run again, message /start again.`
    const content = [[{ text: `✏️ Reclaim`, callback_data: `reclaim` }]]

    return { title, content }
}
