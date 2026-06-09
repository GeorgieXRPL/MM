import "dotenv/config";
import TelegramBot, { CallbackQuery } from "node-telegram-bot-api";
import fs from 'fs'
import { ReadStream } from 'fs'

import * as commands from "./commands";
import { botToken, init } from "./config";
import { PublicKey } from "@solana/web3.js";
// import { init } from "./commands/helper";

const token = botToken;
const bot = new TelegramBot(token!, { polling: true });
export const CHATID: string = "";
let botName: string;
let editText: string;
let poolId: PublicKey;

console.log("Bot started");

bot.getMe().then((user) => {
  botName = user.username!.toString();
});

bot.setMyCommands(commands.commandList);

init();

bot.on(`message`, async (msg) => {
  const chatId = msg.chat.id!;
  const text = msg.text!;
  const msgId = msg.message_id!;
  const username = msg.from!.username!;
  if (text) console.log(`message : ${chatId} -> ${text}`);
  else return;
  try {
    let result;
    switch (text) {
      case `/start`:
        const fileStream = fs.createReadStream('./start.mp4');
        const captionText = `Welcome to the MASSVOL Volume Bot ❤️‍🔥❤️‍🔥❤️‍🔥
      Generate MASSIVE Volume and a better Dex ranking.
      The Best Volume Bot on Solana, Pump.Fun, and Moonshot.
Benefits:
      🛂 Fully customizable  
      🎁 Revenue Share for holders of $MASSVOL  
      🎉 Clear and transparent  
      ⚡ Lightning Fast with low fees
  Support contact: https://t.me/Massvol / @Massvol`
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Start Volume Bot', callback_data: 'welcome' }  // Button text and callback data
              ]
            ]
          }
        };

        await bot.sendVideo(chatId, fileStream, {
          caption: captionText,  // Add the caption here
          ...keyboard
        });
        console.log('One user successfully started');

        break;

      default:
        await bot.deleteMessage(chatId, msgId);
    }
  } catch (e) {
    console.log("error -> \n", e);
  }
});

bot.on("callback_query", async (query: CallbackQuery) => {
  const chatId = query.message?.chat.id!;
  const msgId = query.message?.message_id!;
  const action = query.data!;
  const username = query.message?.chat?.username!;
  const callbackQueryId = query.id;

  console.log(`query : ${chatId} -> ${action}`);
  try {
    let result;
    switch (action) {
      case "welcome":
        result = await commands.welcome(chatId, username)
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
          },
          parse_mode: "HTML",
        });

        break;

      case "restart":
        result = await commands.welcome(chatId, username);
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
          },
          parse_mode: "HTML",
        });

        break;

      case "boostVolume":
        result = await commands.selectOption(chatId);
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
            force_reply: false, // Disable input field
          },
          parse_mode: "HTML",
        });

        break;

      case "package1":
        result = await commands.displaySettings(chatId, username);
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
            force_reply: false, // Disable input field
          },
          parse_mode: "HTML",
        });

        break;

      case "makeVolumeWallet":
        result = await commands.makeVolumeWallet(chatId, username);
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
            force_reply: false, // Disable input field
          },
          parse_mode: "HTML",
        });

        break;

      case "sendTokenAddr":
        const sendTokenAddr_msg = await bot.sendMessage(
          chatId,
          "Please send a token addr for volume market making."
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.sendTokenAddr(chatId, String(msg.text));
            await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, sendTokenAddr_msg.message_id);
          }
        });
        break;

      case "deposit":
        result = await commands.checkDeposit(chatId);
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
            force_reply: false, // Disable input field
          },
          parse_mode: "HTML",
        });

        break;

      case "confirmWallet":
        await bot.sendMessage(
          chatId,
          `Please wait for a second.`
        );
        result = await commands.confirmWallet(chatId);
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
            force_reply: false, // Disable input field
          },
          parse_mode: "HTML",
        });

        break;

      case "customOption":
        result = await commands.customOption(chatId, username);
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
            force_reply: false, // Disable input field
          },
          parse_mode: "HTML",
        });

        break;

      case "setDistributionAmt":
        const setDistributionAmt_msg = await bot.sendMessage(
          chatId,
          "Input amount of SOL to distribute to each wallet. It should be greater than 0.05 Solana."
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setDistributionAmt(
              chatId,
              Number(msg.text)
            );
            await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, setDistributionAmt_msg.message_id);
          }
        });
        break;

      case "resetDistributionAmt":
        const resetDistributionAmt_msg = await bot.sendMessage(
          chatId,
          "Input amount of SOL to distribute to each wallet. It should be greater than 0.05 Solana."
        );
        bot.once(`message`, async (msg) => {
          console.log(msg.text)
          if (msg.text) {
            result = await commands.setDistributionAmt(
              chatId,
              Number(msg.text)
            );
            const resetAmountMessage = await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, resetDistributionAmt_msg.message_id);
            if (Number(msg.text) < 0.05) {
              await bot.deleteMessage(chatId, resetAmountMessage.message_id);
            }
          }
        });
        break;

      case "setDistributionWalletNum":
        const setDistributionWalletNum_msg = await bot.sendMessage(
          chatId,
          "Input number of wallets for volume trading. It can be greater than 20. The more wallets, the more volume generating in the same time"
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setDistributionWalletNum(
              chatId,
              Number(msg.text)
            );
            await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, setDistributionWalletNum_msg.message_id);
          }
        });
        break;

      case "resetDistributionWalletNum":
        const resetDistributionWalletNum_msg = await bot.sendMessage(
          chatId,
          "Input number of wallets for volume trading. It can be greater than 20. The more wallets, the more volume generating in the same time"
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setDistributionWalletNum(
              chatId,
              Number(msg.text)
            );
            const resetWalletNumMessage = await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, resetDistributionWalletNum_msg.message_id);
            if (Number(msg.text) > 500) {
              await bot.deleteMessage(chatId, resetWalletNumMessage.message_id);
            }
          }
        });
        break;

      case "setBuyUpperAmount":
        const buyUpperAmount_msg = await bot.sendMessage(
          chatId,
          "Input upper limit for random buy amount. It should be less than distribution Sol amount."
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setBuyUpperAmount(chatId, Number(msg.text));
            await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, buyUpperAmount_msg.message_id);
          }
        });
        break;

      case "resetBuyUpperAmount":
        const rebuyUpperAmount_msg = await bot.sendMessage(
          chatId,
          "Input upper limit for random buy amount. It should be less than distribution Sol amount."
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setBuyUpperAmount(chatId, Number(msg.text));
            const resetBuyUpperMessage = await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, rebuyUpperAmount_msg.message_id);
            if (result.reset) {
              await bot.deleteMessage(chatId, resetBuyUpperMessage.message_id);
            }
          }
        });
        break;

      case "setBuyLowerAmount":
        const buyLowerAmount_msg = await bot.sendMessage(
          chatId,
          "Input Lower limit for random buy amount. It should be lower than Upper amount."
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setBuyLowerAmount(chatId, Number(msg.text));
            await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, buyLowerAmount_msg.message_id);
          }
        });
        break;

      case "resetBuyLowerAmount":
        const rebuyLowerAmount_msg = await bot.sendMessage(
          chatId,
          "Input Lower limit for random buy amount. It should be lower than Upper amount."
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setBuyLowerAmount(chatId, Number(msg.text));
            const resetBuyLowerMessage = await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, rebuyLowerAmount_msg.message_id);
            if (result.reset) await bot.deleteMessage(chatId, resetBuyLowerMessage.message_id);
          }
        });
        break;

      case "setBuyIntervalMax":
        const buyIntervalMax_msg = await bot.sendMessage(
          chatId,
          "Input Maximum interval between buys in milliseconds. It should be greater than minimum interval."
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setBuyIntervalMax(chatId, Number(msg.text));
            await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, buyIntervalMax_msg.message_id);
          }
        });
        break;

      case "resetBuyIntervalMax":
        const rebuyIntervalMax_msg = await bot.sendMessage(
          chatId,
          "Input Maximum interval between buys in milliseconds. It should be greater than minimum interval."
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setBuyIntervalMax(chatId, Number(msg.text));
            const resetMaxIntervalMessage = await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, rebuyIntervalMax_msg.message_id);
            if (result.reset) await bot.deleteMessage(chatId, resetMaxIntervalMessage.message_id);
          }
        });
        break;

      case "setBuyIntervalMin":
        const buyIntervalMin_msg = await bot.sendMessage(
          chatId,
          "Input Minimum interval between buys in milliseconds. It should be smaller than maximum interval."
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setBuyIntervalMin(chatId, Number(msg.text));
            await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, buyIntervalMin_msg.message_id);
          }
        });
        break;

      case "resetBuyIntervalMin":
        const rebuyIntervalMin_msg = await bot.sendMessage(
          chatId,
          "Input Minimum interval between buys in milliseconds. It should be smaller than maximum interval."
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setBuyIntervalMin(chatId, Number(msg.text));
            const resetMinIntervalMessage = await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, rebuyIntervalMin_msg.message_id);
            if (result.reset) await bot.deleteMessage(chatId, resetMinIntervalMessage.message_id);
          }
        });

        break;

      case "setSellAllByTimes":
        const sellAllByTimes_msg = await bot.sendMessage(
          chatId,
          "Input Number of times to sell all tokens in sub-wallets gradually"
        );
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setSellAllByTimes(chatId, Number(msg.text));
            await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, sellAllByTimes_msg.message_id);
          }
        });
        break;

      case "setSlippage":
        const slippage_msg = await bot.sendMessage(chatId, "Input Slippage you want.");
        bot.once(`message`, async (msg) => {
          if (msg.text) {
            result = await commands.setSlippage(chatId, Number(msg.text));
            await bot.sendMessage(chatId, result.title, {
              reply_markup: {
                inline_keyboard: result.content,
                force_reply: false, // Disable input field
              },
              parse_mode: "HTML",
            });

            await bot.deleteMessage(chatId, slippage_msg.message_id);
          }
        });
        break;

      case "reclaim":
        const reclaim_msg = await bot.sendMessage(chatId, "Reclaim from subwallets you distributed will be done by your volume wallet you created at first.");
        result = await commands.reclaim(chatId);
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
            force_reply: false,
          },
          parse_mode: "HTML"
        })
        await bot.deleteMessage(chatId, reclaim_msg.message_id);
        break;

      case "start":
        result = await commands.start(chatId);
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
            force_reply: false, // Disable input field
          },
          parse_mode: "HTML",
        });
        break;

      case "stop":
        // await bot.sendMessage(chatId, 'Trading is stopped! The volume boosting process is stopped. If you want to run again, message /start again.')

        result = await commands.stopProcess(chatId);
        await bot.sendMessage(chatId, result.title, {
          reply_markup: {
            inline_keyboard: result.content,
            force_reply: false, // Disable input field
          },
          parse_mode: "HTML",
        });
        break;

    }
  } catch (e) {
    console.log("error -> \n", e);
  }
});
