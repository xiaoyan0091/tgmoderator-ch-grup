import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import { storage } from "./storage";
import { pushSchema } from "./db";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const spamTracker = new Map<string, number[]>();
const floodTracker = new Map<string, number[]>();

let bot: TelegramBot | null = null;
const BOT_OWNER_ID: number = 6444305696;

function getUserDisplayName(user: TelegramBot.User): string {
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

function getUserMention(user: TelegramBot.User): string {
  const name = user.first_name + (user.last_name ? ` ${user.last_name}` : "");
  return `<a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function isAdmin(chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await bot!.getChatMember(chatId, userId);
    return ["creator", "administrator"].includes(member.status);
  } catch {
    return false;
  }
}

async function isCreator(chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await bot!.getChatMember(chatId, userId);
    return member.status === "creator";
  } catch {
    return false;
  }
}

function isBotOwner(userId: number): boolean {
  return userId === BOT_OWNER_ID;
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

        const buttons: TelegramBot.InlineKeyboardButton[][] = settings.forceJoinChannels.map((ch: string) => ([{
          text: `Gabung @${ch}`,
          url: `https://t.me/${ch}`,
        }]));

        buttons.push([{
          text: "Sudah Gabung",
          callback_data: `forcejoin_check_${chatId}`,
        }]);

        const notification = await bot!.sendMessage(
          msg.chat.id,
          `${getUserMention(msg.from)}, kamu harus bergabung ke channel/grup yang diwajibkan sebelum bisa mengirim pesan di sini.`,
          {
            reply_markup: { inline_keyboard: buttons },
            parse_mode: "HTML",
          }
        );

        await storage.incrementStat(chatId, "forceJoinBlocked");
        await storage.incrementStat(chatId, "messagesDeleted");
        await storage.addLog({
          chatId,
          action: "force_join",
          targetUser: getUserDisplayName(msg.from),
          performedBy: "bot",
          details: `Pesan dihapus - belum bergabung ke channel wajib`,
        });

        setTimeout(async () => {
          try { await bot!.deleteMessage(msg.chat.id, notification.message_id); } catch {}
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
        `${getUserMention(msg.from)} telah dibisukan selama 5 menit karena spam.`,
        { parse_mode: "HTML" }
      );

      await storage.incrementStat(chatId, "spamBlocked");
      await storage.incrementStat(chatId, "usersMuted");
      await storage.addLog({
        chatId,
        action: "spam",
        targetUser: getUserDisplayName(msg.from),
        performedBy: "bot",
        details: "Otomatis dibisukan karena spam (terlalu banyak pesan dalam 10 detik)",
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
      const warn = await bot!.sendMessage(
        msg.chat.id,
        `${getUserMention(msg.from)}, mengirim link tidak diperbolehkan di grup ini.`,
        { parse_mode: "HTML" }
      );
      await storage.incrementStat(chatId, "messagesDeleted");
      await storage.addLog({
        chatId,
        action: "anti_link",
        targetUser: getUserDisplayName(msg.from),
        performedBy: "bot",
        details: "Pesan dihapus - mengandung link",
      });
      setTimeout(async () => {
        try { await bot!.deleteMessage(msg.chat.id, warn.message_id); } catch {}
      }, 10000);
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
      const warn = await bot!.sendMessage(
        msg.chat.id,
        `${getUserMention(msg.from)}, pesanmu mengandung kata terlarang dan telah dihapus.`,
        { parse_mode: "HTML" }
      );
      await storage.incrementStat(chatId, "messagesDeleted");
      await storage.addLog({
        chatId,
        action: "word_filter",
        targetUser: getUserDisplayName(msg.from),
        performedBy: "bot",
        details: "Pesan dihapus - mengandung kata terlarang",
      });
      setTimeout(async () => {
        try { await bot!.deleteMessage(msg.chat.id, warn.message_id); } catch {}
      }, 10000);
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
        `${getUserMention(msg.from)} telah dibisukan selama 10 menit karena flood.`,
        { parse_mode: "HTML" }
      );

      await storage.incrementStat(chatId, "usersMuted");
      await storage.addLog({
        chatId,
        action: "flood",
        targetUser: getUserDisplayName(msg.from),
        performedBy: "bot",
        details: `Otomatis dibisukan karena flood (melebihi ${maxMessages} pesan dalam ${settings.antiFloodSeconds} detik)`,
      });

      floodTracker.delete(key);
    } catch {}
    return false;
  }
  return true;
}

async function checkAiModerator(msg: TelegramBot.Message): Promise<boolean> {
  if (!msg.from || !msg.chat || msg.chat.type === "private" || !msg.text) return true;

  const chatId = msg.chat.id.toString();
  const settings = await storage.getSettings(chatId);
  if (!settings?.aiModeratorEnabled) return true;

  if (await isAdmin(msg.chat.id, msg.from.id)) return true;

  if (msg.text.length < 5) return true;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-nano",
      messages: [
        {
          role: "system",
          content: `Kamu adalah moderator grup Telegram. Analisis pesan berikut dan tentukan apakah pesan tersebut melanggar aturan.

Pesan dianggap MELANGGAR jika mengandung:
- Ujaran kebencian, SARA, rasisme
- Ancaman kekerasan atau intimidasi
- Pelecehan seksual atau konten tidak senonoh
- Penipuan, scam, atau phishing
- Spam promosi berlebihan
- Kata-kata kasar yang sangat vulgar dan menyerang

Pesan dianggap AMAN jika:
- Percakapan normal biasa
- Kritik sopan atau debat sehat
- Humor ringan tanpa menyerang
- Informasi atau pertanyaan umum
- Kata-kata slang yang umum dan tidak menyerang

Jawab HANYA dengan format JSON:
{"violation": true/false, "reason": "alasan singkat dalam bahasa Indonesia"}`,
        },
        {
          role: "user",
          content: msg.text,
        },
      ],
      max_completion_tokens: 100,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return true;

    const result = JSON.parse(content);
    if (result.violation === true) {
      try {
        await bot!.deleteMessage(msg.chat.id, msg.message_id);
        const warn = await bot!.sendMessage(
          msg.chat.id,
          `${getUserMention(msg.from)}, pesanmu dihapus oleh AI Moderator.\nAlasan: ${escapeHtml(result.reason || "Melanggar aturan grup")}`,
          { parse_mode: "HTML" }
        );

        await storage.incrementStat(chatId, "messagesDeleted");
        await storage.addLog({
          chatId,
          action: "ai_moderator",
          targetUser: getUserDisplayName(msg.from),
          performedBy: "AI Moderator",
          details: `Pesan dihapus - ${result.reason || "Melanggar aturan"}`,
        });

        setTimeout(async () => {
          try { await bot!.deleteMessage(msg.chat.id, warn.message_id); } catch {}
        }, 15000);
      } catch {}
      return false;
    }
  } catch (err) {
    console.error("AI Moderator error:", err);
  }
  return true;
}

async function handleWarnAction(chatId: number, chatIdStr: string, userId: number, userName: string, settings: any) {
  const action = settings.warnAction || "mute";
  try {
    if (action === "ban") {
      await bot!.banChatMember(chatId, userId);
      await bot!.sendMessage(chatId, `${userName} telah <b>dibanned</b> karena mencapai batas peringatan.`, { parse_mode: "HTML" });
      await storage.incrementStat(chatIdStr, "usersBanned");
      await storage.addLog({
        chatId: chatIdStr,
        action: "ban",
        targetUser: userName,
        performedBy: "bot",
        details: "Otomatis dibanned karena mencapai batas peringatan",
      });
    } else if (action === "kick") {
      await bot!.banChatMember(chatId, userId);
      await bot!.unbanChatMember(chatId, userId);
      await bot!.sendMessage(chatId, `${userName} telah <b>ditendang</b> karena mencapai batas peringatan.`, { parse_mode: "HTML" });
      await storage.incrementStat(chatIdStr, "usersKicked");
      await storage.addLog({
        chatId: chatIdStr,
        action: "kick",
        targetUser: userName,
        performedBy: "bot",
        details: "Otomatis ditendang karena mencapai batas peringatan",
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
      await bot!.sendMessage(chatId, `${userName} telah <b>dibisukan</b> selama 1 jam karena mencapai batas peringatan.`, { parse_mode: "HTML" });
      await storage.incrementStat(chatIdStr, "usersMuted");
      await storage.addLog({
        chatId: chatIdStr,
        action: "mute",
        targetUser: userName,
        performedBy: "bot",
        details: "Otomatis dibisukan selama 1 jam karena mencapai batas peringatan",
      });
    }
    await storage.clearWarnings(chatIdStr, userId.toString());
  } catch (err) {
    console.error("Error executing warn action:", err);
  }
}

function s(val: boolean): string {
  return val ? "ON" : "OFF";
}

function warnActionLabel(action: string): string {
  return action === "ban" ? "Banned" : action === "kick" ? "Tendang" : "Bisukan";
}

function buildMainMenuKeyboard(chatId: string): TelegramBot.InlineKeyboardButton[][] {
  return [
    [{ text: "Pengaturan Fitur", callback_data: `menu_settings_${chatId}` }],
    [{ text: "Wajib Gabung", callback_data: `menu_forcejoin_${chatId}` },
     { text: "Filter Kata", callback_data: `menu_wordfilter_${chatId}` }],
    [{ text: "Peringatan", callback_data: `menu_warnings_${chatId}` },
     { text: "Statistik", callback_data: `menu_stats_${chatId}` }],
    [{ text: "Tutup", callback_data: `menu_close` }],
  ];
}

function buildSettingsKeyboard(chatId: string, settings: any, prefix = "toggle"): TelegramBot.InlineKeyboardButton[][] {
  const back = prefix === "pmtoggle" ? `pm_group_${chatId}` : `menu_main_${chatId}`;
  return [
    [{ text: `Sambutan: ${s(settings.welcomeEnabled)}`, callback_data: `${prefix}_welcomeEnabled_${chatId}` },
     { text: `Anti-Spam: ${s(settings.antiSpamEnabled)}`, callback_data: `${prefix}_antiSpamEnabled_${chatId}` }],
    [{ text: `Anti-Link: ${s(settings.antiLinkEnabled)}`, callback_data: `${prefix}_antiLinkEnabled_${chatId}` },
     { text: `Anti-Flood: ${s(settings.antiFloodEnabled)}`, callback_data: `${prefix}_antiFloodEnabled_${chatId}` }],
    [{ text: `Filter Kata: ${s(settings.wordFilterEnabled)}`, callback_data: `${prefix}_wordFilterEnabled_${chatId}` },
     { text: `Mute Baru: ${s(settings.muteNewMembers)}`, callback_data: `${prefix}_muteNewMembers_${chatId}` }],
    [{ text: `AI Moderator: ${s(settings.aiModeratorEnabled)}`, callback_data: `${prefix}_aiModeratorEnabled_${chatId}` }],
    [{ text: "Kembali", callback_data: back }],
  ];
}

function buildForceJoinKeyboard(chatId: string, settings: any, prefix = "toggle", removePrefix = "removechannel", addPrefix = "addchannel"): TelegramBot.InlineKeyboardButton[][] {
  const back = prefix === "pmtoggle" ? `pm_group_${chatId}` : `menu_main_${chatId}`;
  const kb: TelegramBot.InlineKeyboardButton[][] = [
    [{ text: `Wajib Gabung: ${s(settings.forceJoinEnabled)}`, callback_data: `${prefix}_forceJoinEnabled_${chatId}` }],
  ];
  const channels = settings.forceJoinChannels || [];
  if (channels.length > 0) {
    channels.forEach((ch: string) => {
      kb.push([
        { text: `@${ch}`, callback_data: `noop` },
        { text: "Hapus", callback_data: `${removePrefix}_${chatId}_${ch}` },
      ]);
    });
  }
  kb.push([{ text: "Tambah Channel", callback_data: `${addPrefix}_${chatId}` }]);
  kb.push([{ text: "Kembali", callback_data: back }]);
  return kb;
}

function buildWarningsKeyboard(chatId: string, settings: any, limitPrefix = "setwarnlimit", actionPrefix = "setwarnaction"): TelegramBot.InlineKeyboardButton[][] {
  const back = limitPrefix === "pmwarnlimit" ? `pm_group_${chatId}` : `menu_main_${chatId}`;
  return [
    [{ text: `Batas: ${settings.warnLimit ?? 3}`, callback_data: `noop` }],
    [{ text: "3", callback_data: `${limitPrefix}_${chatId}_3` },
     { text: "5", callback_data: `${limitPrefix}_${chatId}_5` },
     { text: "7", callback_data: `${limitPrefix}_${chatId}_7` }],
    [{ text: `Aksi: ${warnActionLabel(settings.warnAction || "mute")}`, callback_data: `noop` }],
    [{ text: "Bisukan", callback_data: `${actionPrefix}_${chatId}_mute` },
     { text: "Tendang", callback_data: `${actionPrefix}_${chatId}_kick` },
     { text: "Banned", callback_data: `${actionPrefix}_${chatId}_ban` }],
    [{ text: "Kembali", callback_data: back }],
  ];
}

function buildWordFilterKeyboard(chatId: string, settings: any, prefix = "toggle", clearPrefix = "clearwords", addPrefix = "addword"): TelegramBot.InlineKeyboardButton[][] {
  const back = prefix === "pmtoggle" ? `pm_group_${chatId}` : `menu_main_${chatId}`;
  const bannedWords = settings.bannedWords || [];
  const kb: TelegramBot.InlineKeyboardButton[][] = [
    [{ text: `Filter Kata: ${s(settings.wordFilterEnabled)}`, callback_data: `${prefix}_wordFilterEnabled_${chatId}` }],
  ];
  if (bannedWords.length > 0) {
    kb.push([{ text: `Kata: ${(bannedWords as string[]).join(", ")}`, callback_data: `noop` }]);
    kb.push([{ text: "Hapus Semua", callback_data: `${clearPrefix}_${chatId}` }]);
  }
  kb.push([{ text: "Tambah Kata", callback_data: `${addPrefix}_${chatId}` }]);
  kb.push([{ text: "Kembali", callback_data: back }]);
  return kb;
}

function buildStatsText(stats: any, title?: string): string {
  const t = title ? `<b>Statistik: ${escapeHtml(title)}</b>` : `<b>Statistik Grup</b>`;
  if (!stats) return `${t}\n\nBelum ada data.`;
  return `${t}\n\nPesan: <b>${stats.messagesProcessed}</b> | Dihapus: <b>${stats.messagesDeleted}</b>\nPeringatan: <b>${stats.usersWarned}</b> | Banned: <b>${stats.usersBanned}</b>\nTendang: <b>${stats.usersKicked}</b> | Mute: <b>${stats.usersMuted}</b>\nSpam: <b>${stats.spamBlocked}</b> | Wajib Gabung: <b>${stats.forceJoinBlocked}</b>`;
}

function buildPmConfigKeyboard(groupId: string): TelegramBot.InlineKeyboardButton[][] {
  return [
    [{ text: "Pengaturan Fitur", callback_data: `pm_settings_${groupId}` }],
    [{ text: "Wajib Gabung", callback_data: `pm_forcejoin_${groupId}` },
     { text: "Filter Kata", callback_data: `pm_wordfilter_${groupId}` }],
    [{ text: "Peringatan", callback_data: `pm_warnings_${groupId}` },
     { text: "Statistik", callback_data: `pm_stats_${groupId}` }],
    [{ text: "Kembali", callback_data: `pm_back_groups` }],
  ];
}

function buildOwnerMenuKeyboard(): TelegramBot.InlineKeyboardButton[][] {
  return [
    [{ text: "Daftar Grup", callback_data: `owner_groups` },
     { text: "Kelola Grup", callback_data: `owner_manage` }],
    [{ text: "Statistik Global", callback_data: `owner_stats` },
     { text: "Log Aktivitas", callback_data: `owner_logs` }],
    [{ text: "Broadcast", callback_data: `owner_broadcast` }],
    [{ text: "Tutup", callback_data: `menu_close` }],
  ];
}

function buildStartMenuKeyboard(userId: number, groupId?: string): TelegramBot.InlineKeyboardButton[][] {
  const kb: TelegramBot.InlineKeyboardButton[][] = [];
  if (groupId) {
    kb.push(
      [{ text: "Pengaturan Fitur", callback_data: `pm_settings_${groupId}` }],
      [{ text: "Wajib Gabung", callback_data: `pm_forcejoin_${groupId}` },
       { text: "Filter Kata", callback_data: `pm_wordfilter_${groupId}` }],
      [{ text: "Peringatan", callback_data: `pm_warnings_${groupId}` },
       { text: "Statistik", callback_data: `pm_stats_${groupId}` }],
    );
  }
  kb.push(
    [{ text: "Kelola Grup", callback_data: `start_setgroup` }],
    [{ text: "Bantuan Umum", callback_data: `help_main` }],
    [{ text: "Perintah Moderasi", callback_data: `help_moderasi` },
     { text: "Perintah Pengaturan", callback_data: `help_pengaturan` }],
  );
  if (isBotOwner(userId)) {
    kb.push([{ text: "Panel Pemilik Bot", callback_data: `start_owner` }]);
  }
  kb.push([{ text: "Tutup", callback_data: `menu_close` }]);
  return kb;
}

function buildHelpMainKeyboard(): TelegramBot.InlineKeyboardButton[][] {
  return [
    [{ text: "\ud83d\udcd6 Petunjuk Konfigurasi Bot \ud83d\udcd6", callback_data: `help_konfigurasi` }],
    [{ text: "\ud83d\udcdd Perintah Dasar", callback_data: `help_umum` },
     { text: "Lanjutan \ud83d\udee0\ufe0f", callback_data: `help_moderasi` }],
    [{ text: "\u2699\ufe0f Ahli", callback_data: `help_pengaturan` },
     { text: "Panduan Pro \ud83d\ude80", callback_data: `help_pemilik` }],
    [{ text: "\u2b05\ufe0f Kembali", callback_data: `start_back` }],
  ];
}

const pendingActions = new Map<string, { action: string; data?: any }>();

export async function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("TELEGRAM_BOT_TOKEN not set. Bot will not start.");
    return;
  }

  await pushSchema();

  bot = new TelegramBot(token, { polling: true });
  console.log("Telegram bot started in polling mode");

  try {
    const me = await bot.getMe();
    console.log(`Bot info: @${me.username} (ID: ${me.id})`);
  } catch {}

  bot.on("polling_error", (error) => {
    console.error("Polling error:", error.message);
  });

  bot.on("new_chat_members", async (msg) => {
    try {
      if (!msg.chat || msg.chat.type === "private") return;
      const chatId = msg.chat.id.toString();
      await ensureGroupAndSettings(chatId, msg.chat.title || "Grup Tidak Dikenal");

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
          const welcomeMsg = (settings.welcomeMessage || "Selamat datang {user} di {group}! Silakan patuhi aturan grup.")
            .replace(/\{user\}/g, getUserMention(member))
            .replace(/\{group\}/g, escapeHtml(msg.chat.title || "grup"));

          const kb: TelegramBot.InlineKeyboardButton[][] = [];
          if (settings.forceJoinEnabled && settings.forceJoinChannels?.length) {
            settings.forceJoinChannels.forEach((ch: string) => {
              kb.push([{ text: `Gabung @${ch}`, url: `https://t.me/${ch}` }]);
            });
          }

          await bot!.sendMessage(msg.chat.id, welcomeMsg, {
            parse_mode: "HTML",
            reply_markup: kb.length > 0 ? { inline_keyboard: kb } : undefined,
          });
        }
      }
    } catch (err) {
      console.error("Error handling new members:", err);
    }
  });

  // /start - Menu utama full button
  bot.onText(/\/start/, async (msg) => {
    try {
      if (!msg.from) return;

      if (msg.chat.type !== "private") {
        const chatId = msg.chat.id.toString();
        await ensureGroupAndSettings(chatId, msg.chat.title || "Grup Tidak Dikenal");

        const isAdm = await isAdmin(msg.chat.id, msg.from.id) || isBotOwner(msg.from.id);
        if (isAdm) {
          try {
            const me = await bot!.getMe();
            await bot!.sendMessage(
              msg.from.id,
              `<b>Menu Utama Bot Moderator</b>\n\nHalo ${getUserMention(msg.from)}!\nGrup aktif: <i>${escapeHtml(msg.chat.title || "Grup")}</i>`,
              { parse_mode: "HTML", reply_markup: { inline_keyboard: buildStartMenuKeyboard(msg.from.id, chatId) } }
            );
            await bot!.sendMessage(
              msg.chat.id,
              `${getUserMention(msg.from)}, menu lengkap dikirim ke PM. <a href="https://t.me/${me.username}">Buka PM Bot</a>`,
              { parse_mode: "HTML" }
            );
          } catch {
            const me = await bot!.getMe();
            await bot!.sendMessage(
              msg.chat.id,
              `${getUserMention(msg.from)}, silakan mulai chat dengan bot dulu: <a href="https://t.me/${me.username}?start=setup">Buka PM Bot</a>`,
              { parse_mode: "HTML" }
            );
          }
        } else {
          const kb: TelegramBot.InlineKeyboardButton[][] = [
            [{ text: "Bantuan", callback_data: `help_main` },
             { text: "Aturan Grup", callback_data: `show_rules_${chatId}` }],
          ];
          await bot!.sendMessage(
            msg.chat.id,
            `Halo ${getUserMention(msg.from)}! Saya adalah <b>Bot Moderator Grup</b>.`,
            { parse_mode: "HTML", reply_markup: { inline_keyboard: kb } }
          );
        }
        return;
      }

      await bot!.sendMessage(
        msg.chat.id,
        `<b>Menu Utama Bot Moderator</b>\n\nHalo ${getUserMention(msg.from)}! Selamat datang di Bot Moderator Grup Telegram.`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: buildStartMenuKeyboard(msg.from.id) } }
      );
    } catch (err) {
      console.error("Error handling /start:", err);
    }
  });

  // /help - Bantuan perintah full button
  bot.onText(/\/help/, async (msg) => {
    try {
      if (!msg.from) return;
      await bot!.sendMessage(
        msg.chat.id,
        `\u2728 <b>Selamat datang di menu panduan</b> \u2728`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: buildHelpMainKeyboard() } }
      );
    } catch (err) {
      console.error("Error handling /help:", err);
    }
  });

  // /menu - Menu utama dengan tombol inline
  bot.onText(/\/menu/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") {
        await bot!.sendMessage(msg.chat.id, "Perintah ini hanya bisa digunakan di dalam grup.");
        return;
      }
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const chatId = msg.chat.id.toString();
      await ensureGroupAndSettings(chatId, msg.chat.title || "Grup Tidak Dikenal");

      const text = `<b>Menu Pengaturan Grup</b>\n<i>${escapeHtml(msg.chat.title || "Grup")}</i>\n\nPilih menu di bawah untuk mengelola pengaturan grup:`;

      await bot!.sendMessage(msg.chat.id, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildMainMenuKeyboard(chatId) },
      });
    } catch (err) {
      console.error("Error handling /menu:", err);
    }
  });

  // /settings - Lihat pengaturan grup
  bot.onText(/\/settings/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const chatId = msg.chat.id.toString();
      await ensureGroupAndSettings(chatId, msg.chat.title || "Grup Tidak Dikenal");
      const settings = await storage.getSettings(chatId);
      if (!settings) return;

      const channels = settings.forceJoinChannels || [];
      const bannedWords = settings.bannedWords || [];

      const text = `<b>Pengaturan Grup Saat Ini</b>

<b>Pesan Sambutan:</b> ${settings.welcomeEnabled ? "Aktif" : "Nonaktif"}
<b>Isi Sambutan:</b> ${escapeHtml(settings.welcomeMessage || "-")}

<b>Wajib Gabung:</b> ${settings.forceJoinEnabled ? "Aktif" : "Nonaktif"}
<b>Channel Wajib:</b> ${channels.length > 0 ? channels.map((c: string) => `@${c}`).join(", ") : "Belum diatur"}

<b>Anti-Spam:</b> ${settings.antiSpamEnabled ? "Aktif" : "Nonaktif"} (maks ${settings.antiSpamMaxMessages}/10 detik)
<b>Anti-Link:</b> ${settings.antiLinkEnabled ? "Aktif" : "Nonaktif"}
<b>Filter Kata:</b> ${settings.wordFilterEnabled ? "Aktif" : "Nonaktif"}
<b>Kata Terlarang:</b> ${bannedWords.length > 0 ? bannedWords.join(", ") : "Belum diatur"}

<b>Anti-Flood:</b> ${settings.antiFloodEnabled ? "Aktif" : "Nonaktif"} (${settings.antiFloodMessages} pesan/${settings.antiFloodSeconds} detik)

<b>Batas Peringatan:</b> ${settings.warnLimit}
<b>Aksi Peringatan:</b> ${settings.warnAction === "ban" ? "Banned" : settings.warnAction === "kick" ? "Tendang" : "Bisukan"}

<b>Bisukan Member Baru:</b> ${settings.muteNewMembers ? "Aktif" : "Nonaktif"} (${settings.muteNewMembersDuration} detik)

<b>AI Moderator:</b> ${settings.aiModeratorEnabled ? "Aktif" : "Nonaktif"}`;

      await bot!.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /settings:", err);
    }
  });

  // /stats - Statistik grup
  bot.onText(/\/stats/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const chatId = msg.chat.id.toString();
      const stats = await storage.getStats(chatId);
      if (!stats) {
        await bot!.sendMessage(msg.chat.id, "Belum ada statistik yang tersedia.");
        return;
      }

      const text = `<b>Statistik Grup</b>

Pesan Diproses: <b>${stats.messagesProcessed}</b>
Pesan Dihapus: <b>${stats.messagesDeleted}</b>
Pengguna Diperingatkan: <b>${stats.usersWarned}</b>
Pengguna Dibanned: <b>${stats.usersBanned}</b>
Pengguna Ditendang: <b>${stats.usersKicked}</b>
Pengguna Dibisukan: <b>${stats.usersMuted}</b>
Spam Diblokir: <b>${stats.spamBlocked}</b>
Wajib Gabung Diblokir: <b>${stats.forceJoinBlocked}</b>`;

      await bot!.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /stats:", err);
    }
  });

  // /rules - Aturan grup
  bot.onText(/\/rules/, async (msg) => {
    try {
      if (msg.chat.type === "private") return;
      const chatId = msg.chat.id.toString();
      const settings = await storage.getSettings(chatId);

      const channels = settings?.forceJoinChannels || [];
      let rulesText = `<b>Aturan Grup ${escapeHtml(msg.chat.title || "")}</b>\n\n`;

      if (settings?.forceJoinEnabled && channels.length > 0) {
        rulesText += `- Wajib bergabung ke: ${channels.map((c: string) => `@${c}`).join(", ")}\n`;
      }
      if (settings?.antiSpamEnabled) {
        rulesText += `- Dilarang spam (maks ${settings.antiSpamMaxMessages} pesan/10 detik)\n`;
      }
      if (settings?.antiLinkEnabled) {
        rulesText += `- Dilarang mengirim link\n`;
      }
      if (settings?.wordFilterEnabled && settings.bannedWords?.length) {
        rulesText += `- Dilarang menggunakan kata terlarang\n`;
      }
      if (settings?.antiFloodEnabled) {
        rulesText += `- Dilarang flood (maks ${settings.antiFloodMessages} pesan/${settings.antiFloodSeconds} detik)\n`;
      }
      rulesText += `\nPelanggaran akan ditindak sesuai pengaturan grup.`;

      await bot!.sendMessage(msg.chat.id, rulesText, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /rules:", err);
    }
  });

  // /setwelcome - Atur pesan sambutan
  bot.onText(/\/setwelcome (.+)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const chatId = msg.chat.id.toString();
      await ensureGroupAndSettings(chatId, msg.chat.title || "Grup Tidak Dikenal");

      const newMessage = match![1];
      await storage.updateSettings(chatId, { welcomeMessage: newMessage, welcomeEnabled: true });

      await bot!.sendMessage(
        msg.chat.id,
        `Pesan sambutan berhasil diperbarui:\n\n<i>${escapeHtml(newMessage)}</i>\n\nGunakan {user} untuk nama pengguna dan {group} untuk nama grup.`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      console.error("Error handling /setwelcome:", err);
    }
  });

  // /setforcejoin - Tambah channel wajib gabung
  bot.onText(/\/setforcejoin (.+)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const chatId = msg.chat.id.toString();
      await ensureGroupAndSettings(chatId, msg.chat.title || "Grup Tidak Dikenal");
      const settings = await storage.getSettings(chatId);

      const channel = match![1].replace("@", "").trim();
      const current = (settings?.forceJoinChannels as string[]) ?? [];

      if (current.includes(channel)) {
        await bot!.sendMessage(msg.chat.id, `Channel @${channel} sudah ada di daftar wajib gabung.`);
        return;
      }

      await storage.updateSettings(chatId, {
        forceJoinChannels: [...current, channel],
        forceJoinEnabled: true,
      });

      await bot!.sendMessage(
        msg.chat.id,
        `Channel @${channel} berhasil ditambahkan ke daftar wajib gabung.\nWajib gabung telah diaktifkan.`,
      );
    } catch (err) {
      console.error("Error handling /setforcejoin:", err);
    }
  });

  // /delforcejoin - Hapus channel wajib gabung
  bot.onText(/\/delforcejoin (.+)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const chatId = msg.chat.id.toString();
      const settings = await storage.getSettings(chatId);

      const channel = match![1].replace("@", "").trim();
      const current = (settings?.forceJoinChannels as string[]) ?? [];

      if (!current.includes(channel)) {
        await bot!.sendMessage(msg.chat.id, `Channel @${channel} tidak ditemukan di daftar wajib gabung.`);
        return;
      }

      const updated = current.filter(c => c !== channel);
      await storage.updateSettings(chatId, { forceJoinChannels: updated });

      await bot!.sendMessage(
        msg.chat.id,
        `Channel @${channel} berhasil dihapus dari daftar wajib gabung.${updated.length === 0 ? "\nTidak ada channel tersisa." : ""}`,
      );
    } catch (err) {
      console.error("Error handling /delforcejoin:", err);
    }
  });

  // /addword - Tambah kata terlarang
  bot.onText(/\/addword (.+)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const chatId = msg.chat.id.toString();
      await ensureGroupAndSettings(chatId, msg.chat.title || "Grup Tidak Dikenal");
      const settings = await storage.getSettings(chatId);

      const word = match![1].trim().toLowerCase();
      const current = (settings?.bannedWords as string[]) ?? [];

      if (current.includes(word)) {
        await bot!.sendMessage(msg.chat.id, `Kata "${word}" sudah ada di daftar kata terlarang.`);
        return;
      }

      await storage.updateSettings(chatId, {
        bannedWords: [...current, word],
        wordFilterEnabled: true,
      });

      await bot!.sendMessage(msg.chat.id, `Kata "${word}" berhasil ditambahkan ke daftar kata terlarang.\nFilter kata telah diaktifkan.`);
    } catch (err) {
      console.error("Error handling /addword:", err);
    }
  });

  // /delword - Hapus kata terlarang
  bot.onText(/\/delword (.+)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const chatId = msg.chat.id.toString();
      const settings = await storage.getSettings(chatId);

      const word = match![1].trim().toLowerCase();
      const current = (settings?.bannedWords as string[]) ?? [];

      if (!current.includes(word)) {
        await bot!.sendMessage(msg.chat.id, `Kata "${word}" tidak ditemukan di daftar kata terlarang.`);
        return;
      }

      const updated = current.filter(w => w !== word);
      await storage.updateSettings(chatId, { bannedWords: updated });

      await bot!.sendMessage(msg.chat.id, `Kata "${word}" berhasil dihapus dari daftar kata terlarang.`);
    } catch (err) {
      console.error("Error handling /delword:", err);
    }
  });

  // /warn - Beri peringatan
  bot.onText(/\/warn(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan pengguna yang ingin diperingatkan.");
        return;
      }

      const target = msg.reply_to_message.from;
      if (target.is_bot) {
        await bot!.sendMessage(msg.chat.id, "Tidak bisa memperingatkan bot.");
        return;
      }

      if (await isAdmin(msg.chat.id, target.id)) {
        await bot!.sendMessage(msg.chat.id, "Tidak bisa memperingatkan admin.");
        return;
      }

      const reason = match?.[1]?.trim() || "Tidak ada alasan";
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
        `${getUserMention(target)} telah diperingatkan. (<b>${count}/${warnLimit}</b>)\nAlasan: ${escapeHtml(reason)}`,
        { parse_mode: "HTML" }
      );

      await storage.incrementStat(chatId, "usersWarned");
      await storage.addLog({
        chatId,
        action: "warn",
        targetUser: targetName,
        performedBy: adminName,
        details: `Peringatan ${count}/${warnLimit}: ${reason}`,
      });

      if (count >= warnLimit && settings) {
        await handleWarnAction(msg.chat.id, chatId, target.id, targetName, settings);
      }
    } catch (err) {
      console.error("Error handling /warn:", err);
    }
  });

  // /unwarn - Hapus semua peringatan
  bot.onText(/\/unwarn/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan pengguna untuk menghapus semua peringatannya.");
        return;
      }

      const target = msg.reply_to_message.from;
      const chatId = msg.chat.id.toString();
      const targetName = getUserDisplayName(target);

      await storage.clearWarnings(chatId, target.id.toString());
      await bot!.sendMessage(
        msg.chat.id,
        `Semua peringatan untuk ${getUserMention(target)} telah dihapus.`,
        { parse_mode: "HTML" }
      );

      await storage.addLog({
        chatId,
        action: "unwarn",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: "Semua peringatan dihapus",
      });
    } catch (err) {
      console.error("Error handling /unwarn:", err);
    }
  });

  // /warnings - Cek peringatan
  bot.onText(/\/warnings/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan pengguna untuk melihat peringatannya.");
        return;
      }

      const target = msg.reply_to_message.from;
      const chatId = msg.chat.id.toString();
      const targetName = getUserDisplayName(target);
      const warns = await storage.getWarnings(chatId, target.id.toString());

      if (warns.length === 0) {
        await bot!.sendMessage(
          msg.chat.id,
          `${getUserMention(target)} tidak memiliki peringatan.`,
          { parse_mode: "HTML" }
        );
        return;
      }

      let text = `<b>Peringatan untuk ${escapeHtml(targetName)}</b> (${warns.length}):\n\n`;
      warns.forEach((w, i) => {
        text += `${i + 1}. ${escapeHtml(w.reason)} - oleh ${escapeHtml(w.warnedBy)}\n`;
      });

      await bot!.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /warnings:", err);
    }
  });

  // /ban - Banned pengguna
  bot.onText(/\/ban/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan pengguna yang ingin di-banned.");
        return;
      }

      const target = msg.reply_to_message.from;
      if (await isAdmin(msg.chat.id, target.id)) {
        await bot!.sendMessage(msg.chat.id, "Tidak bisa mem-banned admin.");
        return;
      }

      const targetName = getUserDisplayName(target);
      const chatId = msg.chat.id.toString();

      await bot!.banChatMember(msg.chat.id, target.id);
      await bot!.sendMessage(
        msg.chat.id,
        `${getUserMention(target)} telah <b>dibanned</b> dari grup.`,
        { parse_mode: "HTML" }
      );

      await storage.incrementStat(chatId, "usersBanned");
      await storage.addLog({
        chatId,
        action: "ban",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: "Dibanned oleh admin",
      });
    } catch (err) {
      console.error("Error handling /ban:", err);
    }
  });

  // /unban - Buka banned
  bot.onText(/\/unban/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan pengguna yang ingin dibuka banned-nya.");
        return;
      }

      const target = msg.reply_to_message.from;
      const targetName = getUserDisplayName(target);
      const chatId = msg.chat.id.toString();

      await bot!.unbanChatMember(msg.chat.id, target.id);
      await bot!.sendMessage(
        msg.chat.id,
        `${getUserMention(target)} telah <b>dibuka banned-nya</b>.`,
        { parse_mode: "HTML" }
      );

      await storage.addLog({
        chatId,
        action: "unban",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: "Dibuka banned-nya oleh admin",
      });
    } catch (err) {
      console.error("Error handling /unban:", err);
    }
  });

  // /kick - Tendang pengguna
  bot.onText(/\/kick/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan pengguna yang ingin ditendang.");
        return;
      }

      const target = msg.reply_to_message.from;
      if (await isAdmin(msg.chat.id, target.id)) {
        await bot!.sendMessage(msg.chat.id, "Tidak bisa menendang admin.");
        return;
      }

      const targetName = getUserDisplayName(target);
      const chatId = msg.chat.id.toString();

      await bot!.banChatMember(msg.chat.id, target.id);
      await bot!.unbanChatMember(msg.chat.id, target.id);
      await bot!.sendMessage(
        msg.chat.id,
        `${getUserMention(target)} telah <b>ditendang</b> dari grup.`,
        { parse_mode: "HTML" }
      );

      await storage.incrementStat(chatId, "usersKicked");
      await storage.addLog({
        chatId,
        action: "kick",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: "Ditendang oleh admin",
      });
    } catch (err) {
      console.error("Error handling /kick:", err);
    }
  });

  // /mute - Bisukan pengguna
  bot.onText(/\/mute(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan pengguna yang ingin dibisukan.\n\nContoh: /mute 30 (bisukan 30 menit)");
        return;
      }

      const target = msg.reply_to_message.from;
      if (await isAdmin(msg.chat.id, target.id)) {
        await bot!.sendMessage(msg.chat.id, "Tidak bisa membisukan admin.");
        return;
      }

      const targetName = getUserDisplayName(target);
      const chatId = msg.chat.id.toString();

      const durationMin = parseInt(match?.[1]?.trim() || "60", 10);
      const durationSec = isNaN(durationMin) ? 3600 : durationMin * 60;
      const displayMin = isNaN(durationMin) ? 60 : durationMin;

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
        `${getUserMention(target)} telah <b>dibisukan</b> selama ${displayMin} menit.`,
        { parse_mode: "HTML" }
      );

      await storage.incrementStat(chatId, "usersMuted");
      await storage.addLog({
        chatId,
        action: "mute",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: `Dibisukan selama ${displayMin} menit`,
      });
    } catch (err) {
      console.error("Error handling /mute:", err);
    }
  });

  // /unmute - Buka bisukan
  bot.onText(/\/unmute/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan pengguna yang ingin dibuka bisukannya.");
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

      await bot!.sendMessage(
        msg.chat.id,
        `${getUserMention(target)} telah <b>dibuka bisukannya</b>.`,
        { parse_mode: "HTML" }
      );

      await storage.addLog({
        chatId,
        action: "unmute",
        targetUser: targetName,
        performedBy: getUserDisplayName(msg.from),
        details: "Dibuka bisukannya oleh admin",
      });
    } catch (err) {
      console.error("Error handling /unmute:", err);
    }
  });

  // /pin - Sematkan pesan
  bot.onText(/\/pin/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan yang ingin disematkan.");
        return;
      }

      await bot!.pinChatMessage(msg.chat.id, msg.reply_to_message.message_id);
      await bot!.sendMessage(msg.chat.id, "Pesan berhasil disematkan.");
    } catch (err) {
      console.error("Error handling /pin:", err);
    }
  });

  // /unpin - Lepas sematan
  bot.onText(/\/unpin/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (msg.reply_to_message) {
        await bot!.unpinChatMessage(msg.chat.id, { message_id: msg.reply_to_message.message_id } as any);
      } else {
        await bot!.unpinChatMessage(msg.chat.id);
      }
      await bot!.sendMessage(msg.chat.id, "Sematan pesan berhasil dilepas.");
    } catch (err) {
      console.error("Error handling /unpin:", err);
    }
  });

  // /del - Hapus pesan
  bot.onText(/\/del/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan yang ingin dihapus.");
        return;
      }

      await bot!.deleteMessage(msg.chat.id, msg.reply_to_message.message_id);
      try { await bot!.deleteMessage(msg.chat.id, msg.message_id); } catch {}

      const chatId = msg.chat.id.toString();
      await storage.incrementStat(chatId, "messagesDeleted");
    } catch (err) {
      console.error("Error handling /del:", err);
    }
  });

  // /purge - Hapus banyak pesan
  bot.onText(/\/purge/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan pertama yang ingin dihapus. Semua pesan dari pesan tersebut sampai perintah ini akan dihapus.");
        return;
      }

      const startId = msg.reply_to_message.message_id;
      const endId = msg.message_id;
      let deleted = 0;

      for (let i = startId; i <= endId; i++) {
        try {
          await bot!.deleteMessage(msg.chat.id, i);
          deleted++;
        } catch {}
      }

      const chatId = msg.chat.id.toString();
      await storage.incrementStat(chatId, "messagesDeleted", deleted);

      const notice = await bot!.sendMessage(msg.chat.id, `Berhasil menghapus ${deleted} pesan.`);
      setTimeout(async () => {
        try { await bot!.deleteMessage(msg.chat.id, notice.message_id); } catch {}
      }, 5000);
    } catch (err) {
      console.error("Error handling /purge:", err);
    }
  });

  // /setTitle - Ubah judul grup
  bot.onText(/\/setTitle (.+)/i, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const newTitle = match![1];
      await bot!.setChatTitle(msg.chat.id, newTitle);
      await bot!.sendMessage(msg.chat.id, `Judul grup berhasil diubah menjadi: <b>${escapeHtml(newTitle)}</b>`, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /setTitle:", err);
      await bot!.sendMessage(msg.chat.id, "Gagal mengubah judul grup. Pastikan bot memiliki izin yang cukup.");
    }
  });

  // /promote - Jadikan admin
  bot.onText(/\/promote/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isCreator(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya pemilik grup atau pemilik bot yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan pengguna yang ingin dijadikan admin.");
        return;
      }

      const target = msg.reply_to_message.from;
      await bot!.promoteChatMember(msg.chat.id, target.id, {
        can_delete_messages: true,
        can_restrict_members: true,
        can_pin_messages: true,
        can_invite_users: true,
      } as any);

      await bot!.sendMessage(
        msg.chat.id,
        `${getUserMention(target)} telah <b>dijadikan admin</b>.`,
        { parse_mode: "HTML" }
      );

      await storage.addLog({
        chatId: msg.chat.id.toString(),
        action: "promote",
        targetUser: getUserDisplayName(target),
        performedBy: getUserDisplayName(msg.from),
        details: "Dijadikan admin",
      });
    } catch (err) {
      console.error("Error handling /promote:", err);
      await bot!.sendMessage(msg.chat.id, "Gagal menjadikan admin. Pastikan bot memiliki izin yang cukup.");
    }
  });

  // /demote - Cabut admin
  bot.onText(/\/demote/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isCreator(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya pemilik grup atau pemilik bot yang bisa menggunakan perintah ini.");
        return;
      }

      if (!msg.reply_to_message?.from) {
        await bot!.sendMessage(msg.chat.id, "Balas pesan admin yang ingin dicabut jabatannya.");
        return;
      }

      const target = msg.reply_to_message.from;
      await bot!.promoteChatMember(msg.chat.id, target.id, {
        can_delete_messages: false,
        can_restrict_members: false,
        can_pin_messages: false,
        can_invite_users: false,
        can_change_info: false,
        can_manage_chat: false,
      } as any);

      await bot!.sendMessage(
        msg.chat.id,
        `${getUserMention(target)} telah <b>dicabut jabatan admin-nya</b>.`,
        { parse_mode: "HTML" }
      );

      await storage.addLog({
        chatId: msg.chat.id.toString(),
        action: "demote",
        targetUser: getUserDisplayName(target),
        performedBy: getUserDisplayName(msg.from),
        details: "Dicabut jabatan admin",
      });
    } catch (err) {
      console.error("Error handling /demote:", err);
      await bot!.sendMessage(msg.chat.id, "Gagal mencabut jabatan admin. Pastikan bot memiliki izin yang cukup.");
    }
  });

  // /lock - Kunci chat
  bot.onText(/\/lock/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      await bot!.setChatPermissions(msg.chat.id, {
        can_send_messages: false,
        can_send_media_messages: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
      } as any);

      await bot!.sendMessage(msg.chat.id, "Chat telah <b>dikunci</b>. Hanya admin yang bisa mengirim pesan.", { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /lock:", err);
      await bot!.sendMessage(msg.chat.id, "Gagal mengunci chat. Pastikan bot memiliki izin yang cukup.");
    }
  });

  // /unlock - Buka kunci chat
  bot.onText(/\/unlock/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      await bot!.setChatPermissions(msg.chat.id, {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
      } as any);

      await bot!.sendMessage(msg.chat.id, "Chat telah <b>dibuka</b>. Semua anggota bisa mengirim pesan.", { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /unlock:", err);
      await bot!.sendMessage(msg.chat.id, "Gagal membuka kunci chat. Pastikan bot memiliki izin yang cukup.");
    }
  });

  // /slow - Mode lambat
  bot.onText(/\/slow(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const seconds = parseInt(match?.[1]?.trim() || "0", 10);

      await (bot as any).setChatSlowMode?.(msg.chat.id, seconds) ??
        bot!.sendMessage(msg.chat.id, "Fitur mode lambat tidak didukung pada versi API ini.");

      if (seconds === 0) {
        await bot!.sendMessage(msg.chat.id, "Mode lambat telah <b>dinonaktifkan</b>.", { parse_mode: "HTML" });
      } else {
        await bot!.sendMessage(msg.chat.id, `Mode lambat diaktifkan: <b>${seconds} detik</b> antar pesan.`, { parse_mode: "HTML" });
      }
    } catch (err) {
      console.error("Error handling /slow:", err);
      await bot!.sendMessage(msg.chat.id, "Gagal mengatur mode lambat.");
    }
  });

  // /owner - Panel pemilik bot
  bot.onText(/\/owner/, async (msg) => {
    try {
      if (!msg.from) return;

      if (!isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Perintah ini hanya untuk pemilik bot.");
        return;
      }

      const allGroups = await storage.getGroups();

      const text = `<b>Panel Pemilik Bot</b>

Total Grup: <b>${allGroups.length}</b>
Pemilik: ${getUserMention(msg.from)}

Pilih menu di bawah:`;

      await bot!.sendMessage(msg.chat.id, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildOwnerMenuKeyboard() },
      });
    } catch (err) {
      console.error("Error handling /owner:", err);
    }
  });

  // /broadcast - Kirim pesan ke semua grup
  bot.onText(/\/broadcast (.[\s\S]+)/, async (msg, match) => {
    try {
      if (!msg.from) return;

      if (!isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Perintah ini hanya untuk pemilik bot.");
        return;
      }

      const message = match![1];
      const allGroups = await storage.getGroups();

      let sent = 0;
      let failed = 0;

      for (const group of allGroups) {
        try {
          await bot!.sendMessage(group.chatId, message, { parse_mode: "HTML" });
          sent++;
        } catch {
          failed++;
        }
      }

      await bot!.sendMessage(
        msg.chat.id,
        `<b>Broadcast selesai</b>\n\nBerhasil terkirim: ${sent}\nGagal: ${failed}\nTotal grup: ${allGroups.length}`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      console.error("Error handling /broadcast:", err);
    }
  });

  // /setgroup - Daftarkan grup / pengaturan via PM
  bot.onText(/\/setgroup/, async (msg) => {
    try {
      if (!msg.from) return;

      if (msg.chat.type !== "private") {
        if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
          await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
          return;
        }

        const chatId = msg.chat.id.toString();
        await ensureGroupAndSettings(chatId, msg.chat.title || "Grup Tidak Dikenal");

        try {
          const chatInfo = await bot!.getChat(msg.chat.id);
          const memberCount = await bot!.getChatMemberCount(msg.chat.id);
          await storage.upsertGroup({ chatId, title: chatInfo.title || msg.chat.title || "Grup", memberCount, isActive: true });
        } catch {}

        const me = await bot!.getMe();
        await bot!.sendMessage(
          msg.chat.id,
          `Grup <b>${escapeHtml(msg.chat.title || "Grup")}</b> berhasil didaftarkan!\n\nID Grup: <code>${chatId}</code>\n\nPengaturan lengkap bisa diakses via PM bot.\n<a href="https://t.me/${me.username}?start=setup">Buka PM Bot</a> lalu ketik /setgroup`,
          { parse_mode: "HTML" }
        );

        try {
          const pmKb: TelegramBot.InlineKeyboardButton[][] = [
            [{ text: "Pengaturan Fitur", callback_data: `pm_settings_${chatId}` }],
            [{ text: "Wajib Gabung", callback_data: `pm_forcejoin_${chatId}` },
             { text: "Filter Kata", callback_data: `pm_wordfilter_${chatId}` }],
            [{ text: "Peringatan", callback_data: `pm_warnings_${chatId}` },
             { text: "Statistik", callback_data: `pm_stats_${chatId}` }],
          ];
          await bot!.sendMessage(
            msg.from.id,
            `<b>Grup Terdaftar!</b>\n<i>${escapeHtml(msg.chat.title || "Grup")}</i>\n\nID: <code>${chatId}</code>\n\nPilih menu untuk mengelola:`,
            { parse_mode: "HTML", reply_markup: { inline_keyboard: pmKb } }
          );
        } catch {}
        return;
      }

      const allGroups = await storage.getGroups();
      if (allGroups.length === 0) {
        await bot!.sendMessage(msg.chat.id, "Belum ada grup yang terdaftar.\n\nGunakan /setgroup di dalam grup untuk mendaftarkan grup terlebih dahulu.");
        return;
      }

      const adminGroups: { chatId: string; title: string }[] = [];
      for (const group of allGroups) {
        try {
          const isAdm = await isAdmin(parseInt(group.chatId), msg.from.id);
          if (isAdm || isBotOwner(msg.from.id)) {
            adminGroups.push({ chatId: group.chatId, title: group.title });
          }
        } catch {}
      }

      if (adminGroups.length === 0) {
        await bot!.sendMessage(msg.chat.id, "Kamu bukan admin di grup manapun yang terdaftar di bot ini.\n\nGunakan /setgroup di dalam grup untuk mendaftarkan grup.");
        return;
      }

      const kb: TelegramBot.InlineKeyboardButton[][] = adminGroups.map(g => ([
        { text: g.title, callback_data: `pm_group_${g.chatId}` },
      ]));

      await bot!.sendMessage(
        msg.chat.id,
        `<b>Pengaturan Grup via PM</b>\n\nPilih grup yang ingin diatur:`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: kb } }
      );
    } catch (err) {
      console.error("Error handling /setgroup:", err);
    }
  });

  // Callback query handler untuk tombol inline
  bot.on("callback_query", async (query) => {
    try {
      if (!query.message || !query.from || !query.data) {
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      const data = query.data;
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;

      // Force join check callback
      if (data.startsWith("forcejoin_check_")) {
        const groupChatId = data.replace("forcejoin_check_", "");
        const settings = await storage.getSettings(groupChatId);

        if (!settings?.forceJoinEnabled || !settings.forceJoinChannels?.length) {
          await bot!.answerCallbackQuery(query.id, { text: "Wajib gabung tidak aktif.", show_alert: true });
          return;
        }

        let allJoined = true;
        for (const channel of settings.forceJoinChannels) {
          try {
            const member = await bot!.getChatMember(`@${channel}`, query.from.id);
            if (["left", "kicked"].includes(member.status)) {
              allJoined = false;
              break;
            }
          } catch {
            allJoined = false;
            break;
          }
        }

        if (allJoined) {
          await bot!.answerCallbackQuery(query.id, { text: "Terverifikasi! Kamu sudah bergabung ke semua channel. Silakan kirim pesan.", show_alert: true });
          try { await bot!.deleteMessage(chatId, msgId); } catch {}
        } else {
          await bot!.answerCallbackQuery(query.id, { text: "Kamu belum bergabung ke semua channel yang diwajibkan.", show_alert: true });
        }
        return;
      }

      // Start menu buttons
      if (data === "start_setgroup") {
        const allGroups = await storage.getGroups();
        const adminGroups: { chatId: string; title: string }[] = [];
        for (const group of allGroups) {
          try {
            if (await isAdmin(parseInt(group.chatId), query.from.id) || isBotOwner(query.from.id))
              adminGroups.push({ chatId: group.chatId, title: group.title });
          } catch {}
        }
        if (adminGroups.length === 0) {
          await bot!.answerCallbackQuery(query.id, { text: "Belum ada grup yang terdaftar. Gunakan /setgroup di grup terlebih dahulu.", show_alert: true });
          return;
        }
        await bot!.editMessageText(
          `<b>Pengaturan Grup via PM</b>\n\nPilih grup yang ingin diatur:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: adminGroups.map(g => [{ text: g.title, callback_data: `pm_group_${g.chatId}` }]) } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Help main menu
      if (data === "help_main") {
        await bot!.editMessageText(
          `\u2728 <b>Selamat datang di menu panduan</b> \u2728`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildHelpMainKeyboard() } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "help_konfigurasi") {
        await bot!.editMessageText(
          `\ud83d\udcd6 <b>Petunjuk Konfigurasi Bot</b> \ud83d\udcd6\n\n` +
          `<b>Langkah 1:</b> Tambahkan bot ke grup sebagai admin\n` +
          `<b>Langkah 2:</b> Ketik /setgroup di grup untuk mendaftarkan\n` +
          `<b>Langkah 3:</b> Ketik /menu di grup untuk buka pengaturan\n` +
          `<b>Langkah 4:</b> Atur fitur sesuai kebutuhan grup\n\n` +
          `\ud83d\udca1 <b>Tips:</b>\n` +
          `\u2022 Pastikan bot memiliki izin admin penuh\n` +
          `\u2022 Gunakan /setgroup di PM untuk kelola via PM\n` +
          `\u2022 Gunakan /start di grup untuk menu cepat\n` +
          `\u2022 Semua pengaturan bisa diakses via tombol`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [
            [{ text: "\ud83d\udcdd Perintah Dasar", callback_data: `help_umum` },
             { text: "Lanjutan \ud83d\udee0\ufe0f", callback_data: `help_moderasi` }],
            [{ text: "\u2b05\ufe0f Kembali", callback_data: `help_main` }],
          ] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "help_umum") {
        await bot!.editMessageText(
          `\ud83d\udcdd <b>Perintah Dasar</b>\n\n` +
          `<b>/start</b> - Menu utama bot\n` +
          `<b>/help</b> - Tampilkan bantuan ini\n` +
          `<b>/menu</b> - Menu pengaturan grup (Admin)\n` +
          `<b>/rules</b> - Lihat aturan grup\n` +
          `<b>/setgroup</b> - Daftarkan grup ke bot\n` +
          `<b>/settings</b> - Lihat pengaturan saat ini\n` +
          `<b>/stats</b> - Lihat statistik grup\n\n` +
          `<i>Semua perintah tersedia di grup maupun PM.</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [
            [{ text: "Lanjutan \ud83d\udee0\ufe0f", callback_data: `help_moderasi` },
             { text: "\u2699\ufe0f Ahli", callback_data: `help_pengaturan` }],
            [{ text: "\u2b05\ufe0f Kembali", callback_data: `help_main` }],
          ] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "help_moderasi") {
        await bot!.editMessageText(
          `\ud83d\udee0\ufe0f <b>Perintah Lanjutan (Moderasi)</b>\n` +
          `<i>Khusus Admin \u2022 Balas pesan pengguna</i>\n\n` +
          `<b>\u26a0\ufe0f Peringatan:</b>\n` +
          `<b>/warn</b> [alasan] - Beri peringatan\n` +
          `<b>/unwarn</b> - Hapus semua peringatan\n` +
          `<b>/warnings</b> - Cek jumlah peringatan\n\n` +
          `<b>\ud83d\udeab Tindakan:</b>\n` +
          `<b>/ban</b> - Banned pengguna\n` +
          `<b>/unban</b> - Buka banned\n` +
          `<b>/kick</b> - Tendang pengguna\n` +
          `<b>/mute</b> [menit] - Bisukan\n` +
          `<b>/unmute</b> - Buka bisukan\n\n` +
          `<b>\ud83d\udcac Pesan:</b>\n` +
          `<b>/del</b> - Hapus pesan\n` +
          `<b>/purge</b> - Hapus banyak pesan\n` +
          `<b>/pin</b> - Sematkan pesan\n` +
          `<b>/unpin</b> - Lepas sematan\n\n` +
          `<b>\ud83d\udc51 Manajemen:</b>\n` +
          `<b>/promote</b> - Jadikan admin\n` +
          `<b>/demote</b> - Cabut admin\n` +
          `<b>/lock</b> - Kunci chat\n` +
          `<b>/unlock</b> - Buka kunci\n` +
          `<b>/slow</b> [detik] - Mode lambat\n` +
          `<b>/setTitle</b> [judul] - Ubah judul grup`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [
            [{ text: "\ud83d\udcdd Perintah Dasar", callback_data: `help_umum` },
             { text: "\u2699\ufe0f Ahli", callback_data: `help_pengaturan` }],
            [{ text: "\u2b05\ufe0f Kembali", callback_data: `help_main` }],
          ] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "help_pengaturan") {
        await bot!.editMessageText(
          `\u2699\ufe0f <b>Perintah Ahli (Pengaturan)</b>\n` +
          `<i>Khusus Admin</i>\n\n` +
          `<b>\ud83d\udc4b Sambutan:</b>\n` +
          `<b>/setwelcome</b> [pesan] - Atur sambutan\n` +
          `Gunakan <code>{user}</code> dan <code>{group}</code>\n\n` +
          `<b>\ud83d\udd17 Wajib Gabung:</b>\n` +
          `<b>/setforcejoin</b> [username] - Tambah channel\n` +
          `<b>/delforcejoin</b> [username] - Hapus channel\n\n` +
          `<b>\ud83d\udeab Filter Kata:</b>\n` +
          `<b>/addword</b> [kata] - Tambah kata terlarang\n` +
          `<b>/delword</b> [kata] - Hapus kata terlarang\n\n` +
          `<i>\ud83d\udca1 Semua fitur juga bisa diatur via tombol /menu</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [
            [{ text: "\ud83d\udcdd Perintah Dasar", callback_data: `help_umum` },
             { text: "Panduan Pro \ud83d\ude80", callback_data: `help_pemilik` }],
            [{ text: "\u2b05\ufe0f Kembali", callback_data: `help_main` }],
          ] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "help_pemilik") {
        await bot!.editMessageText(
          `\ud83d\ude80 <b>Panduan Pro</b>\n\n` +
          `<b>\ud83d\udc51 Perintah Pemilik Bot:</b>\n` +
          `<b>/owner</b> - Panel pemilik bot (tombol)\n` +
          `<b>/broadcast</b> [pesan] - Kirim ke semua grup\n\n` +
          `<b>\ud83d\udd10 Hak Akses:</b>\n` +
          `\u2022 Pemilik bot memiliki akses penuh tanpa batasan\n` +
          `\u2022 Pemilik bot dikecualikan dari semua filter\n` +
          `\u2022 Admin grup dikecualikan dari filter grup\n\n` +
          `<b>\ud83e\udd16 Fitur AI Moderasi:</b>\n` +
          `\u2022 Deteksi ujaran kebencian otomatis\n` +
          `\u2022 Filter kekerasan & pelecehan\n` +
          `\u2022 Deteksi spam cerdas\n` +
          `\u2022 Aktifkan via /menu > AI Moderasi`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [
            [{ text: "Lanjutan \ud83d\udee0\ufe0f", callback_data: `help_moderasi` },
             { text: "\u2699\ufe0f Ahli", callback_data: `help_pengaturan` }],
            [{ text: "\u2b05\ufe0f Kembali", callback_data: `help_main` }],
          ] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "start_owner") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const allGroups = await storage.getGroups();
        await bot!.editMessageText(
          `<b>Panel Pemilik Bot</b>\n\nTotal Grup: <b>${allGroups.length}</b>\nPemilik: ${getUserMention(query.from)}\n\nPilih menu di bawah:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildOwnerMenuKeyboard() } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "start_back") {
        await bot!.editMessageText(
          `<b>Menu Utama Bot Moderator</b>\n\nPilih menu di bawah:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildStartMenuKeyboard(query.from.id) } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Show rules button
      if (data.startsWith("show_rules_")) {
        await bot!.answerCallbackQuery(query.id, { text: "Belum ada aturan yang ditetapkan untuk grup ini. Admin bisa mengatur aturan melalui /menu.", show_alert: true });
        return;
      }

      // Noop
      if (data === "noop") {
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Close menu
      if (data === "menu_close") {
        try { await bot!.deleteMessage(chatId, msgId); } catch {}
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // PM group selection
      if (data.startsWith("pm_group_")) {
        const groupId = data.replace("pm_group_", "");
        let isAdm = false;
        try { isAdm = await isAdmin(parseInt(groupId), query.from.id) || isBotOwner(query.from.id); } catch {}
        if (!isAdm) { await bot!.answerCallbackQuery(query.id, { text: "Kamu bukan admin di grup ini.", show_alert: true }); return; }

        const group = await storage.getGroup(groupId);
        await bot!.editMessageText(
          `<b>${escapeHtml(group?.title || "Grup")}</b>\n\nPilih menu:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildPmConfigKeyboard(groupId) } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // PM back to group list
      if (data === "pm_back_groups") {
        const allGroups = await storage.getGroups();
        const adminGroups: { chatId: string; title: string }[] = [];
        for (const group of allGroups) {
          try {
            if (await isAdmin(parseInt(group.chatId), query.from.id) || isBotOwner(query.from.id))
              adminGroups.push({ chatId: group.chatId, title: group.title });
          } catch {}
        }
        await bot!.editMessageText(
          `<b>Pengaturan Grup via PM</b>\n\nPilih grup:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: adminGroups.map(g => [{ text: g.title, callback_data: `pm_group_${g.chatId}` }]) } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // PM settings submenu
      if (data.startsWith("pm_settings_")) {
        const groupId = data.replace("pm_settings_", "");
        const settings = await storage.getSettings(groupId);
        if (!settings) { await bot!.answerCallbackQuery(query.id, { text: "Tidak ditemukan.", show_alert: true }); return; }
        const group = await storage.getGroup(groupId);
        await bot!.editMessageText(
          `<b>Pengaturan Fitur</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTekan untuk toggle:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildSettingsKeyboard(groupId, settings, "pmtoggle") } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // PM force join submenu
      if (data.startsWith("pm_forcejoin_")) {
        const groupId = data.replace("pm_forcejoin_", "");
        const settings = await storage.getSettings(groupId);
        if (!settings) { await bot!.answerCallbackQuery(query.id, { text: "Tidak ditemukan.", show_alert: true }); return; }
        const group = await storage.getGroup(groupId);
        await bot!.editMessageText(
          `<b>Wajib Gabung</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTambah channel: <code>/setforcejoin username</code> di grup`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildForceJoinKeyboard(groupId, settings, "pmtoggle", "pmremovech") } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // PM word filter submenu
      if (data.startsWith("pm_wordfilter_")) {
        const groupId = data.replace("pm_wordfilter_", "");
        const settings = await storage.getSettings(groupId);
        if (!settings) { await bot!.answerCallbackQuery(query.id, { text: "Tidak ditemukan.", show_alert: true }); return; }
        const group = await storage.getGroup(groupId);
        await bot!.editMessageText(
          `<b>Filter Kata</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTambah: <code>/addword kata</code> di grup`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWordFilterKeyboard(groupId, settings, "pmtoggle", "pmclearwords", "pmaddword") } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // PM warnings submenu
      if (data.startsWith("pm_warnings_")) {
        const groupId = data.replace("pm_warnings_", "");
        const settings = await storage.getSettings(groupId);
        if (!settings) { await bot!.answerCallbackQuery(query.id, { text: "Tidak ditemukan.", show_alert: true }); return; }
        const group = await storage.getGroup(groupId);
        await bot!.editMessageText(
          `<b>Peringatan</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nAksi setelah <b>${settings.warnLimit}</b> peringatan: <b>${warnActionLabel(settings.warnAction || "mute")}</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWarningsKeyboard(groupId, settings, "pmwarnlimit", "pmwarnaction") } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // PM stats submenu
      if (data.startsWith("pm_stats_")) {
        const groupId = data.replace("pm_stats_", "");
        const stats = await storage.getStats(groupId);
        const group = await storage.getGroup(groupId);
        await bot!.editMessageText(buildStatsText(stats, group?.title), {
          chat_id: chatId, message_id: msgId, parse_mode: "HTML",
          reply_markup: { inline_keyboard: [
            [{ text: "Perbarui", callback_data: `pm_stats_${groupId}` }],
            [{ text: "Kembali", callback_data: `pm_group_${groupId}` }],
          ] },
        });
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // PM toggle handler
      if (data.startsWith("pmtoggle_")) {
        const rest = data.replace("pmtoggle_", "");
        const parts = rest.split("_");
        const groupId = parts.pop()!;
        const field = parts.join("_");
        const fieldMap: Record<string, string> = {
          welcomeEnabled: "welcomeEnabled", antiSpamEnabled: "antiSpamEnabled",
          antiLinkEnabled: "antiLinkEnabled", wordFilterEnabled: "wordFilterEnabled",
          antiFloodEnabled: "antiFloodEnabled", muteNewMembers: "muteNewMembers",
          forceJoinEnabled: "forceJoinEnabled", aiModeratorEnabled: "aiModeratorEnabled",
        };
        const dbField = fieldMap[field];
        if (!dbField) { await bot!.answerCallbackQuery(query.id, { text: "Tidak dikenal.", show_alert: true }); return; }
        const settings = await storage.getSettings(groupId);
        if (!settings) return;
        const currentVal = (settings as any)[dbField];
        await storage.updateSettings(groupId, { [dbField]: !currentVal } as any);
        const updated = await storage.getSettings(groupId);
        if (!updated) return;

        const labelMap: Record<string, string> = {
          welcomeEnabled: "Sambutan", antiSpamEnabled: "Anti-Spam", antiLinkEnabled: "Anti-Link",
          wordFilterEnabled: "Filter Kata", antiFloodEnabled: "Anti-Flood", muteNewMembers: "Mute Baru",
          forceJoinEnabled: "Wajib Gabung", aiModeratorEnabled: "AI Moderator",
        };
        await bot!.answerCallbackQuery(query.id, { text: `${labelMap[field]} ${!currentVal ? "diaktifkan" : "dinonaktifkan"}.` });

        const group = await storage.getGroup(groupId);
        if (field === "forceJoinEnabled") {
          await bot!.editMessageText(
            `<b>Wajib Gabung</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTambah channel: <code>/setforcejoin username</code> di grup`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildForceJoinKeyboard(groupId, updated, "pmtoggle", "pmremovech", "pmaddch") } }
          );
        } else if (field === "wordFilterEnabled") {
          await bot!.editMessageText(
            `<b>Filter Kata</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTambah: <code>/addword kata</code> di grup`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWordFilterKeyboard(groupId, updated, "pmtoggle", "pmclearwords", "pmaddword") } }
          );
        } else {
          await bot!.editMessageText(
            `<b>Pengaturan Fitur</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTekan untuk toggle:`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildSettingsKeyboard(groupId, updated, "pmtoggle") } }
          );
        }
        return;
      }

      // PM warn limit
      if (data.startsWith("pmwarnlimit_")) {
        const parts = data.replace("pmwarnlimit_", "").split("_");
        const limit = parseInt(parts.pop()!, 10);
        const groupId = parts.join("_");
        await storage.updateSettings(groupId, { warnLimit: limit });
        const settings = await storage.getSettings(groupId);
        if (!settings) return;
        const group = await storage.getGroup(groupId);
        await bot!.answerCallbackQuery(query.id, { text: `Batas peringatan: ${limit}.` });
        await bot!.editMessageText(
          `<b>Peringatan</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nAksi setelah <b>${settings.warnLimit}</b> peringatan: <b>${warnActionLabel(settings.warnAction || "mute")}</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWarningsKeyboard(groupId, settings, "pmwarnlimit", "pmwarnaction") } }
        );
        return;
      }

      // PM warn action
      if (data.startsWith("pmwarnaction_")) {
        const parts = data.replace("pmwarnaction_", "").split("_");
        const action = parts.pop()!;
        const groupId = parts.join("_");
        await storage.updateSettings(groupId, { warnAction: action });
        const settings = await storage.getSettings(groupId);
        if (!settings) return;
        const group = await storage.getGroup(groupId);
        await bot!.answerCallbackQuery(query.id, { text: `Aksi: ${warnActionLabel(action)}.` });
        await bot!.editMessageText(
          `<b>Peringatan</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nAksi setelah <b>${settings.warnLimit}</b> peringatan: <b>${warnActionLabel(settings.warnAction || "mute")}</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWarningsKeyboard(groupId, settings, "pmwarnlimit", "pmwarnaction") } }
        );
        return;
      }

      // PM remove channel
      if (data.startsWith("pmremovech_")) {
        const rest = data.replace("pmremovech_", "");
        const firstUnderscore = rest.indexOf("_");
        const groupId = rest.substring(0, firstUnderscore);
        const channel = rest.substring(firstUnderscore + 1);
        const settings = await storage.getSettings(groupId);
        if (!settings) return;
        const channels = ((settings.forceJoinChannels as string[]) ?? []).filter(c => c !== channel);
        await storage.updateSettings(groupId, { forceJoinChannels: channels });
        const updated = await storage.getSettings(groupId);
        if (!updated) return;
        const group = await storage.getGroup(groupId);
        await bot!.answerCallbackQuery(query.id, { text: `@${channel} dihapus.` });
        await bot!.editMessageText(
          `<b>Wajib Gabung</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTambah channel: <code>/setforcejoin username</code> di grup`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildForceJoinKeyboard(groupId, updated, "pmtoggle", "pmremovech") } }
        );
        return;
      }

      // Main menu
      if (data.startsWith("menu_main_")) {
        const groupId = data.replace("menu_main_", "");
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }
        const chat = await bot!.getChat(chatId);
        await bot!.editMessageText(
          `<b>${escapeHtml(chat.title || "Grup")}</b>\n\nPilih menu:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildMainMenuKeyboard(groupId) } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Settings menu
      if (data.startsWith("menu_settings_")) {
        const groupId = data.replace("menu_settings_", "");
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }
        const settings = await storage.getSettings(groupId);
        if (!settings) { await bot!.answerCallbackQuery(query.id, { text: "Tidak ditemukan.", show_alert: true }); return; }
        await bot!.editMessageText(
          `<b>Pengaturan Fitur</b>\n\nTekan untuk toggle:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildSettingsKeyboard(groupId, settings) } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Force join menu
      if (data.startsWith("menu_forcejoin_")) {
        const groupId = data.replace("menu_forcejoin_", "");
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }
        const settings = await storage.getSettings(groupId);
        if (!settings) { await bot!.answerCallbackQuery(query.id, { text: "Tidak ditemukan.", show_alert: true }); return; }
        await bot!.editMessageText(
          `<b>Wajib Gabung</b>\n\nTambah: <code>/setforcejoin username</code>\nHapus: <code>/delforcejoin username</code>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildForceJoinKeyboard(groupId, settings) } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Word filter menu (in-group)
      if (data.startsWith("menu_wordfilter_")) {
        const groupId = data.replace("menu_wordfilter_", "");
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }
        const settings = await storage.getSettings(groupId);
        if (!settings) { await bot!.answerCallbackQuery(query.id, { text: "Tidak ditemukan.", show_alert: true }); return; }
        await bot!.editMessageText(
          `<b>Filter Kata</b>\n\nTambah: <code>/addword kata</code>\nHapus: <code>/delword kata</code>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWordFilterKeyboard(groupId, settings) } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Stats menu
      if (data.startsWith("menu_stats_")) {
        const groupId = data.replace("menu_stats_", "");
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }
        const stats = await storage.getStats(groupId);
        await bot!.editMessageText(buildStatsText(stats), {
          chat_id: chatId, message_id: msgId, parse_mode: "HTML",
          reply_markup: { inline_keyboard: [
            [{ text: "Perbarui", callback_data: `menu_stats_${groupId}` }],
            [{ text: "Kembali", callback_data: `menu_main_${groupId}` }],
          ] },
        });
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Warnings menu
      if (data.startsWith("menu_warnings_")) {
        const groupId = data.replace("menu_warnings_", "");
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }
        const settings = await storage.getSettings(groupId);
        if (!settings) { await bot!.answerCallbackQuery(query.id, { text: "Tidak ditemukan.", show_alert: true }); return; }
        await bot!.editMessageText(
          `<b>Peringatan</b>\n\nAksi setelah <b>${settings.warnLimit}</b> peringatan: <b>${warnActionLabel(settings.warnAction || "mute")}</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWarningsKeyboard(groupId, settings) } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Toggle settings (in-group)
      if (data.startsWith("toggle_")) {
        const parts = data.replace("toggle_", "").split("_");
        const groupId = parts.pop()!;
        const field = parts.join("_");
        const fieldMap: Record<string, string> = {
          welcomeEnabled: "welcomeEnabled", antiSpamEnabled: "antiSpamEnabled",
          antiLinkEnabled: "antiLinkEnabled", wordFilterEnabled: "wordFilterEnabled",
          antiFloodEnabled: "antiFloodEnabled", muteNewMembers: "muteNewMembers",
          forceJoinEnabled: "forceJoinEnabled", aiModeratorEnabled: "aiModeratorEnabled",
        };
        const dbField = fieldMap[field];
        if (!dbField) { await bot!.answerCallbackQuery(query.id, { text: "Tidak dikenal.", show_alert: true }); return; }
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }
        const settings = await storage.getSettings(groupId);
        if (!settings) { await bot!.answerCallbackQuery(query.id, { text: "Tidak ditemukan.", show_alert: true }); return; }

        const currentVal = (settings as any)[dbField];
        await storage.updateSettings(groupId, { [dbField]: !currentVal } as any);
        const updated = await storage.getSettings(groupId);
        if (!updated) return;

        const labelMap: Record<string, string> = {
          welcomeEnabled: "Sambutan", antiSpamEnabled: "Anti-Spam", antiLinkEnabled: "Anti-Link",
          wordFilterEnabled: "Filter Kata", antiFloodEnabled: "Anti-Flood", muteNewMembers: "Mute Baru",
          forceJoinEnabled: "Wajib Gabung", aiModeratorEnabled: "AI Moderator",
        };
        await bot!.answerCallbackQuery(query.id, { text: `${labelMap[field]} ${!currentVal ? "diaktifkan" : "dinonaktifkan"}.` });

        if (field === "forceJoinEnabled") {
          await bot!.editMessageText(
            `<b>Wajib Gabung</b>\n\nTambah: <code>/setforcejoin username</code>\nHapus: <code>/delforcejoin username</code>`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildForceJoinKeyboard(groupId, updated) } }
          );
        } else if (field === "wordFilterEnabled") {
          await bot!.editMessageText(
            `<b>Filter Kata</b>\n\nTambah: <code>/addword kata</code>\nHapus: <code>/delword kata</code>`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWordFilterKeyboard(groupId, updated) } }
          );
        } else {
          await bot!.editMessageText(
            `<b>Pengaturan Fitur</b>\n\nTekan untuk toggle:`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildSettingsKeyboard(groupId, updated) } }
          );
        }
        return;
      }

      // Set warn limit
      if (data.startsWith("setwarnlimit_")) {
        const parts = data.replace("setwarnlimit_", "").split("_");
        const limit = parseInt(parts.pop()!, 10);
        const groupId = parts.join("_");
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }
        await storage.updateSettings(groupId, { warnLimit: limit });
        const settings = await storage.getSettings(groupId);
        if (!settings) return;
        await bot!.answerCallbackQuery(query.id, { text: `Batas peringatan: ${limit}.` });
        await bot!.editMessageText(
          `<b>Peringatan</b>\n\nAksi setelah <b>${settings.warnLimit}</b> peringatan: <b>${warnActionLabel(settings.warnAction || "mute")}</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWarningsKeyboard(groupId, settings) } }
        );
        return;
      }

      // Set warn action
      if (data.startsWith("setwarnaction_")) {
        const parts = data.replace("setwarnaction_", "").split("_");
        const action = parts.pop()!;
        const groupId = parts.join("_");
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }
        await storage.updateSettings(groupId, { warnAction: action });
        const settings = await storage.getSettings(groupId);
        if (!settings) return;
        await bot!.answerCallbackQuery(query.id, { text: `Aksi: ${warnActionLabel(action)}.` });
        await bot!.editMessageText(
          `<b>Peringatan</b>\n\nAksi setelah <b>${settings.warnLimit}</b> peringatan: <b>${warnActionLabel(settings.warnAction || "mute")}</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWarningsKeyboard(groupId, settings) } }
        );
        return;
      }

      // Add channel prompt (in-group)
      if (data.startsWith("addchannel_")) {
        await bot!.answerCallbackQuery(query.id, { text: "Kirim perintah:\n/setforcejoin username\n\nContoh: /setforcejoin mychannel", show_alert: true });
        return;
      }

      // Add channel prompt (PM)
      if (data.startsWith("pmaddch_")) {
        await bot!.answerCallbackQuery(query.id, { text: "Kirim di grup:\n/setforcejoin username\n\nContoh: /setforcejoin mychannel", show_alert: true });
        return;
      }

      // Add word prompt (in-group)
      if (data.startsWith("addword_")) {
        await bot!.answerCallbackQuery(query.id, { text: "Kirim perintah:\n/addword kata\n\nContoh: /addword spam", show_alert: true });
        return;
      }

      // Add word prompt (PM)
      if (data.startsWith("pmaddword_")) {
        await bot!.answerCallbackQuery(query.id, { text: "Kirim di grup:\n/addword kata\n\nContoh: /addword spam", show_alert: true });
        return;
      }

      // Clear words (in-group)
      if (data.startsWith("clearwords_")) {
        const groupId = data.replace("clearwords_", "");
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }
        await storage.updateSettings(groupId, { bannedWords: [] });
        const updated = await storage.getSettings(groupId);
        if (!updated) return;
        await bot!.answerCallbackQuery(query.id, { text: "Semua kata terlarang dihapus." });
        await bot!.editMessageText(
          `<b>Filter Kata</b>\n\nTambah: <code>/addword kata</code>\nHapus: <code>/delword kata</code>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWordFilterKeyboard(groupId, updated) } }
        );
        return;
      }

      // Clear words (PM)
      if (data.startsWith("pmclearwords_")) {
        const groupId = data.replace("pmclearwords_", "");
        await storage.updateSettings(groupId, { bannedWords: [] });
        const updated = await storage.getSettings(groupId);
        if (!updated) return;
        const group = await storage.getGroup(groupId);
        await bot!.answerCallbackQuery(query.id, { text: "Semua kata terlarang dihapus." });
        await bot!.editMessageText(
          `<b>Filter Kata</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTambah: <code>/addword kata</code> di grup`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildWordFilterKeyboard(groupId, updated, "pmtoggle", "pmclearwords", "pmaddword") } }
        );
        return;
      }

      // Remove channel from force join
      if (data.startsWith("removechannel_")) {
        const rest = data.replace("removechannel_", "");
        const firstUnderscore = rest.indexOf("_");
        const groupId = rest.substring(0, firstUnderscore);
        const channel = rest.substring(firstUnderscore + 1);
        if (!(await isAdmin(chatId, query.from.id)) && !isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya admin.", show_alert: true }); return; }

        const settings = await storage.getSettings(groupId);
        if (!settings) return;

        const channels = ((settings.forceJoinChannels as string[]) ?? []).filter(c => c !== channel);
        await storage.updateSettings(groupId, { forceJoinChannels: channels });
        const updated = await storage.getSettings(groupId);
        if (!updated) return;
        await bot!.answerCallbackQuery(query.id, { text: `@${channel} dihapus.` });
        await bot!.editMessageText(
          `<b>Wajib Gabung</b>\n\nTambah: <code>/setforcejoin username</code>\nHapus: <code>/delforcejoin username</code>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildForceJoinKeyboard(groupId, updated) } }
        );
        return;
      }

      // Owner menu: list groups
      if (data === "owner_groups") {
        if (!isBotOwner(query.from.id)) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true });
          return;
        }

        const allGroups = await storage.getGroups();
        let text = `<b>Daftar Semua Grup</b>\n\n`;

        if (allGroups.length === 0) {
          text += "Belum ada grup yang terdaftar.";
        } else {
          allGroups.forEach((g, i) => {
            text += `${i + 1}. <b>${escapeHtml(g.title)}</b>\n   ID: <code>${g.chatId}</code> | Status: ${g.isActive ? "Aktif" : "Nonaktif"}\n\n`;
          });
        }

        await bot!.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Kembali", callback_data: `owner_back` }],
            ],
          },
        });
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Owner menu: global stats
      if (data === "owner_stats") {
        if (!isBotOwner(query.from.id)) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true });
          return;
        }

        const allStats = await storage.getAllStats();
        let totalMessages = 0, totalDeleted = 0, totalWarned = 0, totalBanned = 0;
        let totalKicked = 0, totalMuted = 0, totalSpam = 0, totalForceJoin = 0;

        allStats.forEach(s => {
          totalMessages += s.messagesProcessed ?? 0;
          totalDeleted += s.messagesDeleted ?? 0;
          totalWarned += s.usersWarned ?? 0;
          totalBanned += s.usersBanned ?? 0;
          totalKicked += s.usersKicked ?? 0;
          totalMuted += s.usersMuted ?? 0;
          totalSpam += s.spamBlocked ?? 0;
          totalForceJoin += s.forceJoinBlocked ?? 0;
        });

        const allGroups = await storage.getGroups();

        const text = `<b>Statistik Global Bot</b>

Total Grup: <b>${allGroups.length}</b>

Pesan Diproses: <b>${totalMessages}</b>
Pesan Dihapus: <b>${totalDeleted}</b>
Pengguna Diperingatkan: <b>${totalWarned}</b>
Pengguna Dibanned: <b>${totalBanned}</b>
Pengguna Ditendang: <b>${totalKicked}</b>
Pengguna Dibisukan: <b>${totalMuted}</b>
Spam Diblokir: <b>${totalSpam}</b>
Wajib Gabung Diblokir: <b>${totalForceJoin}</b>`;

        await bot!.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Perbarui", callback_data: `owner_stats` }],
              [{ text: "Kembali", callback_data: `owner_back` }],
            ],
          },
        });
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Owner manage groups - list groups for per-group config
      if (data === "owner_manage") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const allGroups = await storage.getGroups();
        if (allGroups.length === 0) {
          await bot!.answerCallbackQuery(query.id, { text: "Belum ada grup terdaftar.", show_alert: true });
          return;
        }
        const kb: TelegramBot.InlineKeyboardButton[][] = allGroups.map(g => [{ text: g.title, callback_data: `pm_group_${g.chatId}` }]);
        kb.push([{ text: "Kembali", callback_data: `owner_back` }]);
        await bot!.editMessageText(
          `<b>Kelola Grup</b>\n\nPilih grup untuk mengelola pengaturan:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Owner logs - recent activity across all groups
      if (data === "owner_logs") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const logs = await storage.getRecentLogs(15);
        let text = `<b>Log Aktivitas Terbaru</b>\n\n`;
        if (logs.length === 0) {
          text += "Belum ada aktivitas.";
        } else {
          for (const log of logs) {
            const actionLabel: Record<string, string> = { warn: "Peringatan", ban: "Banned", kick: "Tendang", mute: "Bisukan", delete: "Hapus", spam_blocked: "Spam", link_blocked: "Link", word_filtered: "Filter Kata", flood_blocked: "Flood", force_join: "Wajib Gabung", ai_moderated: "AI Moderasi" };
            const d = log.createdAt ? new Date(log.createdAt) : new Date();
            text += `<code>${d.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</code>\n[${actionLabel[log.action] || log.action}] ${log.details || ""}\n\n`;
          }
        }
        await bot!.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "Perbarui", callback_data: `owner_logs` }], [{ text: "Kembali", callback_data: `owner_back` }]] },
        });
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Owner broadcast prompt
      if (data === "owner_broadcast") {
        if (!isBotOwner(query.from.id)) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true });
          return;
        }

        await bot!.answerCallbackQuery(query.id, {
          text: "Gunakan perintah:\n/broadcast pesan_anda\n\nContoh: /broadcast Halo semua!",
          show_alert: true,
        });
        return;
      }

      // Owner back to panel
      if (data === "owner_back") {
        if (!isBotOwner(query.from.id)) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true });
          return;
        }

        const allGroups = await storage.getGroups();
        await bot!.editMessageText(
          `<b>Panel Pemilik Bot</b>\n\nTotal Grup: <b>${allGroups.length}</b>\nPemilik: ${getUserMention(query.from)}\n\nPilih menu di bawah:`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildOwnerMenuKeyboard() },
          }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      await bot!.answerCallbackQuery(query.id);
    } catch (err) {
      console.error("Error handling callback query:", err);
      try { await bot!.answerCallbackQuery(query.id); } catch {}
    }
  });

  // Message handler for filters
  bot.on("message", async (msg) => {
    try {
      if (!msg.from || !msg.chat || msg.chat.type === "private") return;
      if (msg.text?.startsWith("/")) return;

      const chatId = msg.chat.id.toString();
      await ensureGroupAndSettings(chatId, msg.chat.title || "Grup Tidak Dikenal");
      await storage.incrementStat(chatId, "messagesProcessed");

      if (isBotOwner(msg.from.id)) return;

      const passed = await checkForceJoin(msg);
      if (!passed) return;

      const spamOk = await checkAntiSpam(msg);
      if (!spamOk) return;

      const linkOk = await checkAntiLink(msg);
      if (!linkOk) return;

      const wordOk = await checkWordFilter(msg);
      if (!wordOk) return;

      const floodOk = await checkAntiFlood(msg);
      if (!floodOk) return;

      await checkAiModerator(msg);
    } catch (err) {
      console.error("Error processing message:", err);
    }
  });
}
