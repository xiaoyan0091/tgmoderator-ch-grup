import TelegramBot from "node-telegram-bot-api";
import { storage } from "./storage";
import { pushSchema } from "./db";

const spamTracker = new Map<string, number[]>();
const floodTracker = new Map<string, number[]>();

let bot: TelegramBot | null = null;

function getUserDisplayName(user: TelegramBot.User): string {
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

async function isAdmin(chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await bot!.getChatMember(chatId, userId);
    return ["creator", "administrator"].includes(member.status);
  } catch {
    return false;
  }
}

async function ensureGroupAndSettings(chatId: string, title: string) {
  await storage.upsertGroup({ chatId, title, memberCount: 0, isActive: true });
  const settings = await storage.getSettings(chatId);
  if (!settings) {
    await storage.updateSettings(chatId, {});
  }
}

async function checkForceJoin(msg: TelegramBot.Message): Promise<boolean> {
  if (!msg.from || !msg.chat || msg.chat.type === "private") return true;

  const chatId = msg.chat.id.toString();
  const settings = await storage.getSettings(chatId);
  if (!settings?.forceJoinEnabled || !settings.forceJoinChannels?.length) return true;

  if (await isAdmin(msg.chat.id, msg.from.id)) return true;

  for (const channel of settings.forceJoinChannels) {
    try {
      const member = await bot!.getChatMember(`@${channel}`, msg.from.id);
      if (["left", "kicked"].includes(member.status)) {
        await bot!.deleteMessage(msg.chat.id, msg.message_id);

        const buttons = settings.forceJoinChannels.map((ch: string) => ([{
          text: `Join ${ch}`,
          url: `https://t.me/${ch}`,
        }]));

        const notification = await bot!.sendMessage(
          msg.chat.id,
          `${getUserDisplayName(msg.from)}, you must join the required channels before sending messages.`,
          { reply_markup: { inline_keyboard: buttons } }
        );

        await storage.incrementStat(chatId, "forceJoinBlocked");
        await storage.incrementStat(chatId, "messagesDeleted");
        await storage.addLog({
          chatId,
          action: "force_join_blocked",
          targetUser: getUserDisplayName(msg.from),
          performedBy: "bot",
          details: `Message deleted - user not in required channels`,
        });

        setTimeout(async () => {
          try {
            await bot!.deleteMessage(msg.chat.id, notification.message_id);
          } catch {}
        }, 30000);

        return false;
      }
    } catch {
      continue;
    }
  }
  return true;
}

async function checkAntiSpam(msg: TelegramBot.Message): Promise<boolean> {
  if (!msg.from || !msg.chat || msg.chat.type === "private") return true;

  const chatId = msg.chat.id.toString();
  const settings = await storage.getSettings(chatId);
  if (!settings?.antiSpamEnabled) return true;

  if (await isAdmin(msg.chat.id, msg.from.id)) return true;

  const key = `${chatId}:${msg.from.id}`;
  const now = Date.now();
  const timestamps = spamTracker.get(key) || [];
  const recent = timestamps.filter((t) => now - t < 10000);
  recent.push(now);
  spamTracker.set(key, recent);

  const maxMessages = settings.antiSpamMaxMessages ?? 5;
  if (recent.length > maxMessages) {
    try {
      await bot!.restrictChatMember(msg.chat.id, msg.from.id, {
        permissions: {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
        },
        until_date: Math.floor(Date.now() / 1000) + 300,
      } as any);

      await bot!.sendMessage(
        msg.chat.id,
        `${getUserDisplayName(msg.from)} has been muted for 5 minutes for spamming.`
      );

      await storage.incrementStat(chatId, "spamBlocked");
      await storage.incrementStat(chatId, "usersMuted");
      await storage.addLog({
        chatId,
        action: "spam_blocked",
        targetUser: getUserDisplayName(msg.from),
        performedBy: "bot",
        details: "Auto-muted for spamming (too many messages in 10 seconds)",
      });

      spamTracker.delete(key);
    } catch {}
    return false;
  }
  return true;
}

async function checkAntiLink(msg: TelegramBot.Message): Promise<boolean> {
  if (!msg.from || !msg.chat || msg.chat.type === "private" || !msg.text) return true;

  const chatId = msg.chat.id.toString();
  const settings = await storage.getSettings(chatId);
  if (!settings?.antiLinkEnabled) return true;

  if (await isAdmin(msg.chat.id, msg.from.id)) return true;

  const urlRegex = /https?:\/\/[^\s]+|www\.[^\s]+|t\.me\/[^\s]+/i;
  if (urlRegex.test(msg.text)) {
    try {
      await bot!.deleteMessage(msg.chat.id, msg.message_id);
      await bot!.sendMessage(
        msg.chat.id,
        `${getUserDisplayName(msg.from)}, links are not allowed in this group.`
      );
      await storage.incrementStat(chatId, "messagesDeleted");
      await storage.addLog({
        chatId,
        action: "link_blocked",
        targetUser: getUserDisplayName(msg.from),
        performedBy: "bot",
        details: "Message deleted - contained a link",
      });
    } catch {}
    return false;
  }
  return true;
}

async function checkWordFilter(msg: TelegramBot.Message): Promise<boolean> {
  if (!msg.from || !msg.chat || msg.chat.type === "private" || !msg.text) return true;

  const chatId = msg.chat.id.toString();
  const settings = await storage.getSettings(chatId);
  if (!settings?.wordFilterEnabled || !settings.bannedWords?.length) return true;

  if (await isAdmin(msg.chat.id, msg.from.id)) return true;

  const lowerText = msg.text.toLowerCase();
  const hasBannedWord = settings.bannedWords.some((word: string) =>
    lowerText.includes(word.toLowerCase())
  );

  if (hasBannedWord) {
    try {
      await bot!.deleteMessage(msg.chat.id, msg.message_id);
      await bot!.sendMessage(
        msg.chat.id,
        `${getUserDisplayName(msg.from)}, your message contained a banned word and was deleted.`
      );
      await storage.incrementStat(chatId, "messagesDeleted");
      await storage.addLog({
        chatId,
        action: "word_filter",
        targetUser: getUserDisplayName(msg.from),
        performedBy: "bot",
        details: "Message deleted - contained a banned word",
      });
    } catch {}
    return false;
  }
  return true;
}

async function checkAntiFlood(msg: TelegramBot.Message): Promise<boolean> {
  if (!msg.from || !msg.chat || msg.chat.type === "private") return true;

  const chatId = msg.chat.id.toString();
  const settings = await storage.getSettings(chatId);
  if (!settings?.antiFloodEnabled) return true;

  if (await isAdmin(msg.chat.id, msg.from.id)) return true;

  const key = `flood:${chatId}:${msg.from.id}`;
  const now = Date.now();
  const windowMs = (settings.antiFloodSeconds ?? 60) * 1000;
  const timestamps = floodTracker.get(key) || [];
  const recent = timestamps.filter((t) => now - t < windowMs);
  recent.push(now);
  floodTracker.set(key, recent);

  const maxMessages = settings.antiFloodMessages ?? 10;
  if (recent.length > maxMessages) {
    try {
      await bot!.restrictChatMember(msg.chat.id, msg.from.id, {
        permissions: {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
        },
        until_date: Math.floor(Date.now() / 1000) + 600,
      } as any);

      await bot!.sendMessage(
        msg.chat.id,
        `${getUserDisplayName(msg.from)} has been muted for 10 minutes for flooding.`
      );

      await storage.incrementStat(chatId, "usersMuted");
      await storage.addLog({
        chatId,
        action: "flood_blocked",
        targetUser: getUserDisplayName(msg.from),
        performedBy: "bot",
        details: `Auto-muted for flooding (exceeded ${maxMessages} messages in ${settings.antiFloodSeconds}s)`,
      });

      floodTracker.delete(key);
    } catch {}
    return false;
  }
  return true;
}

async function handleWarnAction(chatId: number, chatIdStr: string, userId: number, userName: string, settings: any) {
  const action = settings.warnAction || "mute";
  try {
    if (action === "ban") {
      await bot!.banChatMember(chatId, userId);
      await bot!.sendMessage(chatId, `${userName} has been banned for reaching the warning limit.`);
      await storage.incrementStat(chatIdStr, "usersBanned");
      await storage.addLog({
        chatId: chatIdStr,
        action: "ban",
        targetUser: userName,
        performedBy: "bot",
        details: "Auto-banned for reaching warning limit",
      });
    } else if (action === "kick") {
      await bot!.banChatMember(chatId, userId);
      await bot!.unbanChatMember(chatId, userId);
      await bot!.sendMessage(chatId, `${userName} has been kicked for reaching the warning limit.`);
      await storage.incrementStat(chatIdStr, "usersKicked");
      await storage.addLog({
        chatId: chatIdStr,
        action: "kick",
        targetUser: userName,
        performedBy: "bot",
        details: "Auto-kicked for reaching warning limit",
      });
    } else {
      await bot!.restrictChatMember(chatId, userId, {
        permissions: {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
        },
        until_date: Math.floor(Date.now() / 1000) + 3600,
      } as any);
      await bot!.sendMessage(chatId, `${userName} has been muted for 1 hour for reaching the warning limit.`);
      await storage.incrementStat(chatIdStr, "usersMuted");
      await storage.addLog({
        chatId: chatIdStr,
        action: "mute",
        targetUser: userName,
        performedBy: "bot",
        details: "Auto-muted for reaching warning limit",
      });
    }
    await storage.clearWarnings(chatIdStr, userId.toString());
  } catch (err) {
    console.error("Error executing warn action:", err);
  }
}

export async function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("TELEGRAM_BOT_TOKEN not set. Bot will not start.");
    return;
  }

  await pushSchema();

  bot = new TelegramBot(token, { polling: true });
  console.log("Telegram bot started in polling mode");

  bot.on("polling_error", (error) => {
    console.error("Polling error:", error.message);
  });

  bot.on("new_chat_members", async (msg) => {
    try {
      if (!msg.chat || msg.chat.type === "private") return;
      const chatId = msg.chat.id.toString();
      await ensureGroupAndSettings(chatId, msg.chat.title || "Unknown Group");

      const settings = await storage.getSettings(chatId);

      for (const member of msg.new_chat_members || []) {
        if (member.is_bot) continue;

        if (settings?.muteNewMembers) {
          try {
            const duration = settings.muteNewMembersDuration ?? 300;
            await bot!.restrictChatMember(msg.chat.id, member.id, {
              permissions: {
                can_send_messages: false,
                can_send_media_messages: false,
                can_send_other_messages: false,
                can_add_web_page_previews: false,
              },
              until_date: Math.floor(Date.now() / 1000) + duration,
            } as any);
          } catch {}
        }

        if (settings?.welcomeEnabled) {
          const welcomeMsg = (settings.welcomeMessage || "Welcome {user} to {group}! Please follow the rules.")
            .replace(/\{user\}/g, getUserDisplayName(member))
            .replace(/\{group\}/g, msg.chat.title || "the group");
          await bot!.sendMessage(msg.chat.id, welcomeMsg);
        }
      }
    } catch (err) {
      console.error("Error handling new members:", err);
    }
  });

  bot.onText(/\/start/, async (msg) => {
    try {
      await bot!.sendMessage(
        msg.chat.id,
        "Hello! I'm a Group Moderator Bot. Add me to your group and make me an admin to get started.\n\nUse /help to see all available commands."
      );
    } catch (err) {
      console.error("Error handling /start:", err);
    }
  });

  bot.onText(/\/help/, async (msg) => {
    try {
      const helpText = `Available Commands:

General:
/start - Bot introduction
/help - Show this help message

Moderation (Admin only):
/warn - Warn a user (reply to message)
/unwarn - Remove all warnings (reply to message)
/warnings - Check user warnings (reply to message)
/ban - Ban a user (reply to message)
/unban - Unban a user (reply to message)
/kick - Kick a user (reply to message)
/mute - Mute a user (reply to message, optional duration in minutes)
/unmute - Unmute a user (reply to message)

Settings (Admin only):
/settings - View current group settings
/stats - View group statistics

Features:
- Anti-Spam protection
- Anti-Link detection
- Word filter
- Anti-Flood protection
- Force join channels
- Welcome messages
- Warning system with auto-actions`;
      await bot!.sendMessage(msg.chat.id, helpText);
    } catch (err) {
      console.error("Error handling /help:", err);
    }
  });

  bot.onText(/\/settings/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
        await bot!.sendMessage(msg.chat.id, "This command is only available for admins.");
        return;
      }

      const chatId = msg.chat.id.toString();
      await ensureGroupAndSettings(chatId, msg.chat.title || "Unknown Group");
      const settings = await storage.getSettings(chatId);
      if (!settings) return;

      const text = `Group Settings:

Welcome: ${settings.welcomeEnabled ? "Enabled" : "Disabled"}
Welcome Message: ${settings.welcomeMessage}

Force Join: ${settings.forceJoinEnabled ? "Enabled" : "Disabled"}
Force Join Channels: ${settings.forceJoinChannels?.length ? settings.forceJoinChannels.join(", ") : "None"}

Anti-Spam: ${settings.antiSpamEnabled ? "Enabled" : "Disabled"}
Anti-Spam Max Messages: ${settings.antiSpamMaxMessages}/10s

Anti-Link: ${settings.antiLinkEnabled ? "Enabled" : "Disabled"}

Word Filter: ${settings.wordFilterEnabled ? "Enabled" : "Disabled"}
Banned Words: ${settings.bannedWords?.length ? settings.bannedWords.join(", ") : "None"}

Anti-Flood: ${settings.antiFloodEnabled ? "Enabled" : "Disabled"}
Anti-Flood: ${settings.antiFloodMessages} messages/${settings.antiFloodSeconds}s

Warning Limit: ${settings.warnLimit}
Warning Action: ${settings.warnAction}

Mute New Members: ${settings.muteNewMembers ? "Enabled" : "Disabled"}
Mute Duration: ${settings.muteNewMembersDuration}s`;

      await bot!.sendMessage(msg.chat.id, text);
    } catch (err) {
      console.error("Error handling /settings:", err);
    }
  });

  bot.onText(/\/stats/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
        await bot!.sendMessage(msg.chat.id, "This command is only available for admins.");
        return;
      }

      const chatId = msg.chat.id.toString();
      const stats = await storage.getStats(chatId);
      if (!stats) {
        await bot!.sendMessage(msg.chat.id, "No statistics available yet.");
        return;
      }

      const text = `Group Statistics:

Messages Processed: ${stats.messagesProcessed}
Messages Deleted: ${stats.messagesDeleted}
Users Warned: ${stats.usersWarned}
Users Banned: ${stats.usersBanned}
Users Kicked: ${stats.usersKicked}
Users Muted: ${stats.usersMuted}
Spam Blocked: ${stats.spamBlocked}
Force Join Blocked: ${stats.forceJoinBlocked}`;

      await bot!.sendMessage(msg.chat.id, text);
    } catch (err) {
      console.error("Error handling /stats:", err);
    }
  });

  bot.onText(/\/warn(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
        await bot!.sendMessage(msg.chat.id, "This command is only available for admins.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Reply to a user's message to warn them.");
        return;
      }

      const target = msg.reply_to_message.from;
      if (target.is_bot) {
        await bot!.sendMessage(msg.chat.id, "Cannot warn bots.");
        return;
      }

      const reason = match?.[1]?.trim() || "No reason provided";
      const chatId = msg.chat.id.toString();
      const targetName = getUserDisplayName(target);
      const adminName = getUserDisplayName(msg.from);

      await storage.addWarning({
        chatId,
        odId: target.id.toString(),
        odName: targetName,
        reason,
        warnedBy: adminName,
      });

      const count = await storage.getWarningCount(chatId, target.id.toString());
      const settings = await storage.getSettings(chatId);
      const warnLimit = settings?.warnLimit ?? 3;

      await bot!.sendMessage(
        msg.chat.id,
        `${targetName} has been warned. (${count}/${warnLimit})\nReason: ${reason}`
      );

      await storage.incrementStat(chatId, "usersWarned");
      await storage.addLog({
        chatId,
        action: "warn",
        targetUser: targetName,
        performedBy: adminName,
        details: `Warning ${count}/${warnLimit}: ${reason}`,
      });

      if (count >= warnLimit && settings) {
        await handleWarnAction(msg.chat.id, chatId, target.id, targetName, settings);
      }
    } catch (err) {
      console.error("Error handling /warn:", err);
    }
  });

  bot.onText(/\/unwarn/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
        await bot!.sendMessage(msg.chat.id, "This command is only available for admins.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Reply to a user's message to clear their warnings.");
        return;
      }

      const target = msg.reply_to_message.from;
      const chatId = msg.chat.id.toString();
      const targetName = getUserDisplayName(target);

      await storage.clearWarnings(chatId, target.id.toString());
      await bot!.sendMessage(msg.chat.id, `All warnings for ${targetName} have been cleared.`);

      await storage.addLog({
        chatId,
        action: "unwarn",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: "All warnings cleared",
      });
    } catch (err) {
      console.error("Error handling /unwarn:", err);
    }
  });

  bot.onText(/\/warnings/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Reply to a user's message to check their warnings.");
        return;
      }

      const target = msg.reply_to_message.from;
      const chatId = msg.chat.id.toString();
      const targetName = getUserDisplayName(target);
      const warns = await storage.getWarnings(chatId, target.id.toString());

      if (warns.length === 0) {
        await bot!.sendMessage(msg.chat.id, `${targetName} has no warnings.`);
        return;
      }

      let text = `Warnings for ${targetName} (${warns.length}):\n\n`;
      warns.forEach((w, i) => {
        text += `${i + 1}. ${w.reason} - by ${w.warnedBy}\n`;
      });

      await bot!.sendMessage(msg.chat.id, text);
    } catch (err) {
      console.error("Error handling /warnings:", err);
    }
  });

  bot.onText(/\/ban/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
        await bot!.sendMessage(msg.chat.id, "This command is only available for admins.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Reply to a user's message to ban them.");
        return;
      }

      const target = msg.reply_to_message.from;
      const targetName = getUserDisplayName(target);
      const chatId = msg.chat.id.toString();

      await bot!.banChatMember(msg.chat.id, target.id);
      await bot!.sendMessage(msg.chat.id, `${targetName} has been banned.`);

      await storage.incrementStat(chatId, "usersBanned");
      await storage.addLog({
        chatId,
        action: "ban",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: "Manually banned by admin",
      });
    } catch (err) {
      console.error("Error handling /ban:", err);
    }
  });

  bot.onText(/\/unban/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
        await bot!.sendMessage(msg.chat.id, "This command is only available for admins.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Reply to a user's message to unban them.");
        return;
      }

      const target = msg.reply_to_message.from;
      const targetName = getUserDisplayName(target);
      const chatId = msg.chat.id.toString();

      await bot!.unbanChatMember(msg.chat.id, target.id);
      await bot!.sendMessage(msg.chat.id, `${targetName} has been unbanned.`);

      await storage.addLog({
        chatId,
        action: "unban",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: "Manually unbanned by admin",
      });
    } catch (err) {
      console.error("Error handling /unban:", err);
    }
  });

  bot.onText(/\/kick/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
        await bot!.sendMessage(msg.chat.id, "This command is only available for admins.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Reply to a user's message to kick them.");
        return;
      }

      const target = msg.reply_to_message.from;
      const targetName = getUserDisplayName(target);
      const chatId = msg.chat.id.toString();

      await bot!.banChatMember(msg.chat.id, target.id);
      await bot!.unbanChatMember(msg.chat.id, target.id);
      await bot!.sendMessage(msg.chat.id, `${targetName} has been kicked.`);

      await storage.incrementStat(chatId, "usersKicked");
      await storage.addLog({
        chatId,
        action: "kick",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: "Manually kicked by admin",
      });
    } catch (err) {
      console.error("Error handling /kick:", err);
    }
  });

  bot.onText(/\/mute(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
        await bot!.sendMessage(msg.chat.id, "This command is only available for admins.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Reply to a user's message to mute them.");
        return;
      }

      const target = msg.reply_to_message.from;
      const targetName = getUserDisplayName(target);
      const chatId = msg.chat.id.toString();

      const durationMin = parseInt(match?.[1]?.trim() || "60", 10);
      const durationSec = isNaN(durationMin) ? 3600 : durationMin * 60;

      await bot!.restrictChatMember(msg.chat.id, target.id, {
        permissions: {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
        },
        until_date: Math.floor(Date.now() / 1000) + durationSec,
      } as any);

      await bot!.sendMessage(
        msg.chat.id,
        `${targetName} has been muted for ${isNaN(durationMin) ? 60 : durationMin} minutes.`
      );

      await storage.incrementStat(chatId, "usersMuted");
      await storage.addLog({
        chatId,
        action: "mute",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: `Manually muted for ${isNaN(durationMin) ? 60 : durationMin} minutes`,
      });
    } catch (err) {
      console.error("Error handling /mute:", err);
    }
  });

  bot.onText(/\/unmute/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
        await bot!.sendMessage(msg.chat.id, "This command is only available for admins.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Reply to a user's message to unmute them.");
        return;
      }

      const target = msg.reply_to_message.from;
      const targetName = getUserDisplayName(target);
      const chatId = msg.chat.id.toString();

      await bot!.restrictChatMember(msg.chat.id, target.id, {
        permissions: {
          can_send_messages: true,
          can_send_media_messages: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
        },
      } as any);

      await bot!.sendMessage(msg.chat.id, `${targetName} has been unmuted.`);

      await storage.addLog({
        chatId,
        action: "unmute",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: "Manually unmuted by admin",
      });
    } catch (err) {
      console.error("Error handling /unmute:", err);
    }
  });

  bot.on("message", async (msg) => {
    try {
      if (!msg.from || !msg.chat || msg.chat.type === "private") return;
      if (msg.text?.startsWith("/")) return;

      const chatId = msg.chat.id.toString();
      await ensureGroupAndSettings(chatId, msg.chat.title || "Unknown Group");
      await storage.incrementStat(chatId, "messagesProcessed");

      const passed = await checkForceJoin(msg);
      if (!passed) return;

      const spamOk = await checkAntiSpam(msg);
      if (!spamOk) return;

      const linkOk = await checkAntiLink(msg);
      if (!linkOk) return;

      const wordOk = await checkWordFilter(msg);
      if (!wordOk) return;

      await checkAntiFlood(msg);
    } catch (err) {
      console.error("Error processing message:", err);
    }
  });
}
