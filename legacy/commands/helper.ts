
import { Keypair } from "@solana/web3.js";
import UserModel from "../utils/model"
import base58 from "bs58";

export const saveInfo = async (userId: number, userData: any) => {
  try {
    const newData = new UserModel({ userId, ...userData })
    await newData.save();
  } catch (e) {
    return null
  }
}

export const addWallet = async (userId: number, wallet: Keypair) => {
  try {
    const privateKey = base58.encode(wallet.secretKey);
    const publicKey = wallet.publicKey.toBase58()
    const data = await UserModel.findOneAndUpdate({ userId }, { userId, privateKey, publicKey }, { new: true, upsert: true });
    return data.publicKey;
  } catch (e) {
    return undefined
  }
}

export const findOfUser = async (userId: number, username?: string) => {
  try {
    const info = await UserModel.findOne({ userId })
    return info;
  } catch (e) {
    return null
  }
}

export const startProcess = async (userId: number) => {
  try {
    const isWorking = true
    const data = await UserModel.findOneAndUpdate({ userId }, { isWorking }, { new: true });
    if (data) {
      console.log("process status: ", data?.isWorking);
      return data.publicKey;
    }
  } catch (e) {
    return undefined
  }
}

export const cancelProcess = async (userId: number) => {
  try {
    const isWorking = false
    const data = await UserModel.findOneAndUpdate({ userId }, { isWorking }, { new: true });
    if (data) {
      console.log("process status: ", data?.isWorking);
      return data.publicKey;
    }
  } catch (e) {
    return undefined
  }
}

export const updateSolAmount = async (userId: number, solAmount: number) => {
  try {
    const data = await UserModel.findOneAndUpdate({ userId }, { solAmount }, { new: true });
    if (data) {
      return data.publicKey;
    }
  } catch (e) {
    return undefined
  }
}

export const updateWalletNum = async (userId: number, walletNum: number) => {
  try {
    const data = await UserModel.findOneAndUpdate({ userId }, { walletNum }, { new: true });
    if (data) {
      return data.publicKey;
    }
  } catch (e) {
    return undefined
  }
}

export const updateDistributionAmt = async (userId: number, distributionAmt: number) => {
  try {
    const distributionAmount = distributionAmt;
    const data = await UserModel.findOneAndUpdate({ userId }, { userId, distributionAmount }, { new: true, upsert: true });
  } catch (e) {
    return undefined
  }
}

export const updateTokenAddr = async (userId: number, tokenAddr: String) => {
  try {
    const data = await UserModel.findOneAndUpdate({ userId }, { userId, tokenAddr }, { new: true, upsert: true });
  } catch (e) {
    return undefined
  }
}

export const updateDistributionWalletNum = async (userId: number, distributeWalletNum: number) => {
  try {
    const data = await UserModel.findOneAndUpdate({ userId }, { userId, distributeWalletNum }, { new: true, upsert: true });
  } catch (e) {
    return undefined
  }
}

export const updateBuyUpperAmount = async (userId: number, buyUpperAmount: number) => {
  try {
    const data = await UserModel.findOneAndUpdate({ userId }, { userId, buyUpperAmount }, { new: true, upsert: true });
  } catch (e) {
    return undefined
  }
}

export const updateBuyLowerAmount = async (userId: number, buyLowerAmount: number) => {
  try {
    const data = await UserModel.findOneAndUpdate({ userId }, { userId, buyLowerAmount }, { new: true, upsert: true });
  } catch (e) {
    return undefined
  }
}

export const updateBuyIntervalMax = async (userId: number, buyIntervalMax: number) => {
  try {
    const data = await UserModel.findOneAndUpdate({ userId }, { userId, buyIntervalMax }, { new: true, upsert: true });
  } catch (e) {
    return undefined
  }
}

export const updateBuyIntervalMin = async (userId: number, buyIntervalMin: number) => {
  try {
    const data = await UserModel.findOneAndUpdate({ userId }, { userId, buyIntervalMin }, { new: true, upsert: true });
  } catch (e) {
    return undefined
  }
}

export const updateSellAllByTimes = async (userId: number, sellAllByTimes: number) => {
  try {
    const data = await UserModel.findOneAndUpdate({ userId }, { userId, sellAllByTimes }, { new: true, upsert: true });
  } catch (e) {
    return undefined
  }
}

export const updateSlippage = async (userId: number, slippage: number) => {
  try {
    const data = await UserModel.findOneAndUpdate({ userId }, { userId, slippage }, { new: true, upsert: true });
  } catch (e) {
    return undefined
  }
}

export const addSubWallets = async (userId: number, wallets: string[]) => {
  try {
    const subWallets = wallets
    const data = await UserModel.findOneAndUpdate({ userId }, { subWallets }, { new: true, upsert: true });
    if(data) {
      console.log("Subwallets are updated.")
      return data.publicKey;
    }
  } catch (e) {
    return undefined
  }
}

export const getTokenAddress = async(userId: number) => {
  try {
    const info = await UserModel.findOne({ userId })
    return info?.tokenAddr
  } catch (e) {
    return undefined
  }
}

export const getSubWallets = async(userId: number) => {
  try {
    const info = await UserModel.findOne({ userId })
    return info?.subWallets
  } catch (e) {
    return
  }
}

