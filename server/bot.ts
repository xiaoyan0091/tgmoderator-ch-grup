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

interface JadwalItem {
  judul: string;
  link?: string;
}

interface UpcomingItem {
  judul: string;
  hari: string;
  tanggal: string;
  link?: string;
  season?: string;
}

interface MediaItem {
  type: string;
  url: string;
}

interface JadwalData {
  harian: Record<string, (string | JadwalItem)[]>;
  upcoming: UpcomingItem[];
  channels: string[];
  post_time: string;
  auto_post_enabled: boolean;
  telegraph_token: string;
  telegraph_url: string;
  rules_text: string;
  media_jadwal: Record<string, MediaItem>;
}

let jadwalData: JadwalData = {
  harian: { Senin: [], Selasa: [], Rabu: [], Kamis: [], Jumat: [], Sabtu: [], Minggu: [] },
  upcoming: [],
  channels: [],
  post_time: "06:00",
  auto_post_enabled: false,
  telegraph_token: "",
  telegraph_url: "",
  rules_text: "",
  media_jadwal: {
    Senin: { type: "", url: "" },
    Selasa: { type: "", url: "" },
    Rabu: { type: "", url: "" },
    Kamis: { type: "", url: "" },
    Jumat: { type: "", url: "" },
    Sabtu: { type: "", url: "" },
    Minggu: { type: "", url: "" },
  },
};

const ownerWaitingState = new Map<number, { type: string; extra?: string }>();
let autoPostInterval: NodeJS.Timeout | null = null;
let lastAutoPostDate: string = "";
let lastJadwalTime: number | null = null;
let lastRulesTime: number | null = null;
const VALID_DAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

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

interface ResolvedTarget {
  userId: number;
  displayName: string;
  mentionHtml: string;
}

async function resolveTargetUser(
  msg: TelegramBot.Message,
  args: string
): Promise<ResolvedTarget | null> {
  if (msg.reply_to_message?.from) {
    const t = msg.reply_to_message.from;
    return { userId: t.id, displayName: getUserDisplayName(t), mentionHtml: getUserMention(t) };
  }

  const trimmed = args.trim().split(/\s+/)[0] || "";
  if (!trimmed) return null;

  if (trimmed.startsWith("@")) {
    const username = trimmed.substring(1);
    try {
      const chat = await bot!.getChat(`@${username}`) as any;
      if (chat && chat.id) {
        const name = chat.first_name || username;
        const lastName = chat.last_name || "";
        const fullName = lastName ? `${name} ${lastName}` : name;
        return {
          userId: chat.id,
          displayName: `@${username}`,
          mentionHtml: `<a href="tg://user?id=${chat.id}">${escapeHtml(fullName)}</a>`,
        };
      }
    } catch {
      try {
        await bot!.sendMessage(msg.chat.id, `Tidak dapat menemukan pengguna @${escapeHtml(username)}. Coba gunakan user_id.`, { parse_mode: "HTML" });
      } catch {}
    }
    return null;
  }

  const userId = parseInt(trimmed, 10);
  if (!isNaN(userId) && userId > 0) {
    try {
      const chat = await bot!.getChat(userId) as any;
      const name = chat.first_name || String(userId);
      const lastName = chat.last_name || "";
      const fullName = lastName ? `${name} ${lastName}` : name;
      const displayName = chat.username ? `@${chat.username}` : fullName;
      return {
        userId,
        displayName,
        mentionHtml: `<a href="tg://user?id=${userId}">${escapeHtml(fullName)}</a>`,
      };
    } catch {
      return { userId, displayName: String(userId), mentionHtml: `<a href="tg://user?id=${userId}">${userId}</a>` };
    }
  }

  return null;
}

function getArgsAfterTarget(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/\s+/);
  if (parts[0].startsWith("@") || /^\d+$/.test(parts[0])) {
    return parts.slice(1).join(" ");
  }
  return trimmed;
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
          text: `Subscribe @${ch}`,
          url: `https://t.me/${ch}`,
        }]));

        buttons.push([{
          text: "Sudah Subscribe",
          callback_data: `forcejoin_check_${chatId}`,
        }]);

        const notification = await bot!.sendMessage(
          msg.chat.id,
          `${getUserMention(msg.from)}, kamu harus subscribe ke channel/grup yang diwajibkan sebelum bisa mengirim pesan di sini.`,
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
          details: `Pesan dihapus - belum subscribe ke channel wajib`,
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
    [{ text: "Wajib Sub", callback_data: `menu_forcejoin_${chatId}` },
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
    [{ text: `Wajib Sub: ${s(settings.forceJoinEnabled)}`, callback_data: `${prefix}_forceJoinEnabled_${chatId}` }],
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
  return `${t}\n\nPesan: <b>${stats.messagesProcessed}</b> | Dihapus: <b>${stats.messagesDeleted}</b>\nPeringatan: <b>${stats.usersWarned}</b> | Banned: <b>${stats.usersBanned}</b>\nTendang: <b>${stats.usersKicked}</b> | Mute: <b>${stats.usersMuted}</b>\nSpam: <b>${stats.spamBlocked}</b> | Wajib Sub: <b>${stats.forceJoinBlocked}</b>`;
}

function buildPmConfigKeyboard(groupId: string): TelegramBot.InlineKeyboardButton[][] {
  return [
    [{ text: "Pengaturan Fitur", callback_data: `pm_settings_${groupId}` }],
    [{ text: "Wajib Sub", callback_data: `pm_forcejoin_${groupId}` },
     { text: "Filter Kata", callback_data: `pm_wordfilter_${groupId}` }],
    [{ text: "Peringatan", callback_data: `pm_warnings_${groupId}` },
     { text: "Statistik", callback_data: `pm_stats_${groupId}` }],
    [{ text: "Kembali", callback_data: `pm_back_groups` }],
  ];
}

async function loadJadwalData() {
  try {
    const data = await storage.getOwnerData();
    if (data) {
      Object.assign(jadwalData, data);
      if (!jadwalData.harian) jadwalData.harian = { Senin: [], Selasa: [], Rabu: [], Kamis: [], Jumat: [], Sabtu: [], Minggu: [] };
      if (!jadwalData.upcoming) jadwalData.upcoming = [];
      if (!jadwalData.channels) jadwalData.channels = [];
      if (!jadwalData.media_jadwal) {
        jadwalData.media_jadwal = {};
        for (const d of VALID_DAYS) jadwalData.media_jadwal[d] = { type: "", url: "" };
      }
    }
    console.log("Jadwal data loaded successfully");
  } catch (err) {
    console.error("Error loading jadwal data (using defaults):", err);
  }
}

async function saveJadwalData() {
  try {
    await storage.saveOwnerData(jadwalData);
  } catch (err) {
    console.error("Error saving jadwal data:", err);
  }
}

function getTodayIndo(): string {
  const now = new Date();
  const days: Record<string, string> = {
    Monday: "Senin", Tuesday: "Selasa", Wednesday: "Rabu",
    Thursday: "Kamis", Friday: "Jumat", Saturday: "Sabtu", Sunday: "Minggu",
  };
  const englishDay = now.toLocaleDateString("en-US", { timeZone: "Asia/Jakarta", weekday: "long" });
  return days[englishDay] || "Senin";
}

function formatJadwalHariIni(): string {
  const today = getTodayIndo();
  let msg = `<b>Jadwal Donghua Hari Ini :</b>\n`;

  if (jadwalData.harian[today] && jadwalData.harian[today].length > 0) {
    jadwalData.harian[today].forEach((anime, idx) => {
      const i = idx + 1;
      if (typeof anime === "object" && anime.link) {
        msg += `  ${i}. <a href="${anime.link}">${anime.judul}</a>\n`;
      } else if (typeof anime === "object") {
        msg += `  ${i}. ${anime.judul}\n`;
      } else {
        msg += `  ${i}. ${anime}\n`;
      }
    });
  } else {
    msg += `\u274C <i>Tidak ada jadwal donghua hari ini dalam waktu dekat</i>\n`;
  }

  msg += `\n<b>Upcoming Donghua :\n</b>`;

  if (jadwalData.upcoming.length > 0) {
    jadwalData.upcoming.forEach((up, idx) => {
      const i = idx + 1;
      msg += `<blockquote>${i}. <b>${up.judul}</b>`;
      if (up.season) msg += `[Season ${up.season}]`;
      if (up.link) {
        msg += `\n(${up.hari}, ${up.tanggal}) (<a href="${up.link}">PV</a>)</blockquote>\n`;
      } else {
        msg += `\n(${up.hari}, ${up.tanggal})</blockquote>\n`;
      }
    });
  } else {
    msg += `<blockquote>Belum ada donghua dalam waktu dekat</blockquote>\n\n`;
  }

  if (jadwalData.telegraph_url) {
    msg += `<a href="${jadwalData.telegraph_url}"><b>Jadwal Donghua Semua Hari</b></a>\n#botjadwal`;
  } else {
    msg += `<b>Jadwal Donghua Semua Hari</b>\n#botjadwal`;
  }

  return msg;
}

function formatJadwalLengkap(): string {
  const today = getTodayIndo();
  let msg = `<b>Jadwal Donghua Hari Ini :</b>\n`;

  if (jadwalData.harian[today] && jadwalData.harian[today].length > 0) {
    jadwalData.harian[today].forEach((anime, idx) => {
      const i = idx + 1;
      if (typeof anime === "object" && anime.link) {
        msg += ` ${i}. <a href="${anime.link}">${anime.judul}</a>\n`;
      } else if (typeof anime === "object") {
        msg += ` ${i}. ${anime.judul}\n`;
      } else {
        msg += ` ${i}. ${anime}\n`;
      }
    });
  } else {
    msg += `Tidak ada jadwal hari ini\n`;
  }

  msg += `\n<b>Upcoming Donghua :\n</b>`;

  if (jadwalData.upcoming.length > 0) {
    jadwalData.upcoming.forEach((up, idx) => {
      const i = idx + 1;
      msg += `<blockquote>${i}. <b>${up.judul}</b>`;
      if (up.season) msg += `[Season ${up.season}]`;
      if (up.link) {
        msg += `\n(${up.hari}, ${up.tanggal}) (<a href="${up.link}">PV</a>)</blockquote>\n`;
      } else {
        msg += `\n(${up.hari}, ${up.tanggal})</blockquote>\n`;
      }
    });
  } else {
    msg += `<blockquote> Belum ada donghua dalam waktu dekat </blockquote>\n\n`;
  }

  if (jadwalData.telegraph_url) {
    msg += `<a href="${jadwalData.telegraph_url}"><b>Jadwal Donghua Semua Hari</b></a>\n#botjadwal`;
  } else {
    msg += `<b>Jadwal Donghua Semua Hari</b>\n#botjadwal`;
  }

  return msg;
}

function formatRulesMessage(): string {
  if (!jadwalData.rules_text) {
    return `\u274C <i>Rules belum diset oleh admin</i>\n\n#rulesbot`;
  }
  return `${jadwalData.rules_text}\n\n#rulesbot`;
}

function getMediaForToday(): MediaItem {
  const today = getTodayIndo();
  return jadwalData.media_jadwal[today] || { type: "", url: "" };
}

async function sendJadwalWithMedia(chatId: string | number, messageText: string) {
  try {
    const todayMedia = getMediaForToday();
    if (todayMedia.url && todayMedia.type) {
      if (todayMedia.type === "video") {
        await bot!.sendVideo(chatId, todayMedia.url, { caption: messageText, parse_mode: "HTML" });
      } else if (todayMedia.type === "photo") {
        await bot!.sendPhoto(chatId, todayMedia.url, { caption: messageText, parse_mode: "HTML" });
      }
    } else {
      await bot!.sendMessage(chatId, messageText, { parse_mode: "HTML", disable_web_page_preview: true });
    }
  } catch (err) {
    try {
      await bot!.sendMessage(chatId, messageText, { parse_mode: "HTML", disable_web_page_preview: true });
    } catch (fallbackErr) {
      console.error("Send text fallback error:", fallbackErr);
    }
  }
}

async function createTelegraphAccount(): Promise<string | null> {
  try {
    const res = await fetch("https://api.telegra.ph/createAccount", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        short_name: "JadwalDonghua",
        author_name: "Jadwal Donghua Bot",
        author_url: "https://t.me/AnimeStreamingID",
      }),
    });
    const result = await res.json();
    if (result.ok) return result.result.access_token;
  } catch (e) { console.error("Telegraph account creation error:", e); }
  return null;
}

async function createTelegraphPage(token: string, title: string, content: any[]): Promise<string | null> {
  try {
    const res = await fetch("https://api.telegra.ph/createPage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token, title, content, return_content: false }),
    });
    const result = await res.json();
    if (result.ok) return result.result.url;
  } catch (e) { console.error("Telegraph page creation error:", e); }
  return null;
}

async function updateTelegraphPage(token: string, path: string, title: string, content: any[]): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegra.ph/editPage/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token, title, content, return_content: false }),
    });
    const result = await res.json();
    if (result.ok) return result.result.url;
  } catch (e) { console.error("Telegraph page update error:", e); }
  return null;
}

function generateTelegraphContent(): any[] {
  const now = new Date();
  const wibNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const today = getTodayIndo();
  const bulanIndo: Record<number, string> = {
    1: "Januari", 2: "Februari", 3: "Maret", 4: "April", 5: "Mei", 6: "Juni",
    7: "Juli", 8: "Agustus", 9: "September", 10: "Oktober", 11: "November", 12: "Desember",
  };
  const date = wibNow.getDate();
  const month = bulanIndo[wibNow.getMonth() + 1];
  const year = wibNow.getFullYear();
  const updateTime = `${String(wibNow.getHours()).padStart(2, "0")}:${String(wibNow.getMinutes()).padStart(2, "0")}`;

  const content: any[] = [];
  content.push({ tag: "p", children: [`Pembaruan pada ${today}, ${date} ${month} ${year} pukul ${updateTime} WIB`] });
  content.push({ tag: "br" });
  content.push({ tag: "br" });

  for (const hari of VALID_DAYS) {
    if (jadwalData.harian[hari] && jadwalData.harian[hari].length > 0) {
      content.push({ tag: "p", children: [{ tag: "strong", children: [hari] }] });
      jadwalData.harian[hari].forEach((anime, idx) => {
        const i = idx + 1;
        if (typeof anime === "object" && anime.link) {
          content.push({ tag: "p", children: [`   ${i}. `, { tag: "a", attrs: { href: anime.link }, children: [anime.judul] }] });
        } else if (typeof anime === "object") {
          content.push({ tag: "p", children: [`   ${i}. ${anime.judul}`] });
        } else {
          content.push({ tag: "p", children: [`   ${i}. ${anime}`] });
        }
      });
      content.push({ tag: "br" });
      content.push({ tag: "br" });
    }
  }
  return content;
}

async function updateTelegraph(): Promise<boolean> {
  if (!jadwalData.telegraph_token) return false;
  const title = "Jadwal Donghua CA3D ";
  const content = generateTelegraphContent();

  if (jadwalData.telegraph_url) {
    try {
      const path = jadwalData.telegraph_url.split("/").pop()!;
      const url = await updateTelegraphPage(jadwalData.telegraph_token, path, title, content);
      if (url) {
        jadwalData.telegraph_url = url;
        await saveJadwalData();
        return true;
      }
    } catch (e) { console.error("Telegraph update error:", e); }
  }

  const url = await createTelegraphPage(jadwalData.telegraph_token, title, content);
  if (url) {
    jadwalData.telegraph_url = url;
    await saveJadwalData();
    return true;
  }
  return false;
}

interface ScheduleItem {
  type: string;
  text: string;
  hari?: string;
  anime?: string | JadwalItem;
  hash?: number;
  index?: number;
  data?: UpcomingItem;
}

function getAllScheduleItems(): ScheduleItem[] {
  const items: ScheduleItem[] = [];
  for (const hari of VALID_DAYS) {
    for (const anime of jadwalData.harian[hari]) {
      if (typeof anime === "object") {
        items.push({ type: "harian", text: `${anime.judul} (${hari})`, hari, anime, hash: Math.abs(hashCode(anime.judul)) % 1000 });
      } else {
        items.push({ type: "harian", text: `${anime} (${hari})`, hari, anime, hash: Math.abs(hashCode(anime)) % 1000 });
      }
    }
  }
  for (let i = 0; i < jadwalData.upcoming.length; i++) {
    items.push({ type: "upcoming", text: `${jadwalData.upcoming[i].judul} (Upcoming)`, index: i, data: jadwalData.upcoming[i] });
  }
  return items;
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}

function generateDeleteKeyboard(page: number = 1, itemsPerPage: number = 10): TelegramBot.InlineKeyboardButton[][] {
  const allItems = getAllScheduleItems();
  const totalItems = allItems.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);

  if (totalPages === 0) {
    return [[{ text: "Belum ada jadwal", callback_data: "jd_back" }], [{ text: "Kembali", callback_data: "jd_back" }]];
  }

  page = Math.max(1, Math.min(page, totalPages));
  const startIndex = (page - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
  const currentItems = allItems.slice(startIndex, endIndex);
  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

  for (let i = 0; i < currentItems.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [];
    for (let j = 0; j < 2; j++) {
      if (i + j < currentItems.length) {
        const item = currentItems[i + j];
        const displayText = item.text.length > 20 ? item.text.substring(0, 20) + "..." : item.text;
        let callbackData: string;
        if (item.type === "harian") {
          callbackData = `jd_dh_${item.hari}_${item.hash}`;
        } else {
          callbackData = `jd_du_${item.index}`;
        }
        row.push({ text: `\u274C ${displayText}`, callback_data: callbackData });
      }
    }
    if (row.length > 0) keyboard.push(row);
  }

  if (totalPages > 1) {
    const paginationRow: TelegramBot.InlineKeyboardButton[] = [];
    if (page > 1) paginationRow.push({ text: "\u25C0\uFE0F", callback_data: `jd_dp_${page - 1}` });
    let startPage = Math.max(1, page - 2);
    const endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);
    for (let p = startPage; p <= endPage; p++) {
      if (p === page) {
        paginationRow.push({ text: `\u2022 ${p} \u2022`, callback_data: `jd_dp_${p}` });
      } else {
        paginationRow.push({ text: String(p), callback_data: `jd_dp_${p}` });
      }
    }
    if (page < totalPages) paginationRow.push({ text: "\u25B6\uFE0F", callback_data: `jd_dp_${page + 1}` });
    keyboard.push(paginationRow);
  }

  keyboard.push([{ text: "Kembali", callback_data: "jd_back" }]);
  return keyboard;
}

async function handleOwnerTextInput(msg: TelegramBot.Message, waiting: { type: string; extra?: string }) {
  const text = msg.text?.trim() || "";
  const chatId = msg.chat.id;

  try {

  if (waiting.type === "jd_media_url") {
    const hari = waiting.extra || "";
    if (text.startsWith("http://") || text.startsWith("https://")) {
      const lowerText = text.toLowerCase();
      let mediaType = "photo";
      if ([".mp4", ".mov", ".avi", ".gif"].some(ext => lowerText.includes(ext))) {
        mediaType = "video";
      }
      jadwalData.media_jadwal[hari] = { type: mediaType, url: text };
      await saveJadwalData();
      const typeDisplay = mediaType === "photo" ? "Foto" : "Video/GIF";
      await bot!.sendMessage(chatId,
        `\u2705 <b>MEDIA ${hari.toUpperCase()} BERHASIL DISET!</b>\n\n` +
        `\uD83C\uDFA8 <b>Type:</b> ${typeDisplay}\n` +
        `\uD83D\uDD17 <b>URL:</b> <code>${text.substring(0, 50)}...</code>\n` +
        `\uD83D\uDCC5 <b>Hari:</b> ${hari}\n\n` +
        `<b>\u2728 Fitur Aktif:</b>\n` +
        `\u2022 Media akan muncul saat jadwal hari ${hari}\n` +
        `\u2022 Caption berisi jadwal lengkap\n` +
        `\u2022 Otomatis di auto post\n` +
        `\u2022 Support berbagai format\n\n` +
        `<i>\uD83D\uDCA1 Jadwal hari ${hari} sekarang akan dikirim dengan ${typeDisplay.toLowerCase()}!</i>`,
        { parse_mode: "HTML" }
      );
    } else {
      await bot!.sendMessage(chatId,
        `\u274C <b>Format URL Tidak Valid!</b>\n\n` +
        `URL harus dimulai dengan <code>http://</code> atau <code>https://</code>\n\n` +
        `<b>Atau kirim media langsung:</b>\n` +
        `\u2022 Foto, video, atau GIF\n` +
        `\u2022 Forward dari chat lain\n\n` +
        `<b>Contoh URL yang benar:</b>\n` +
        `<code>https://example.com/jadwal.jpg</code>\n` +
        `<code>https://telegra.ph/file/abc123.mp4</code>`,
        { parse_mode: "HTML" }
      );
    }
    ownerWaitingState.delete(msg.from!.id);
    return;
  }

  if (waiting.type === "jd_set_rules") {
    if (!text) {
      await bot!.sendMessage(chatId, "\u274C Rules tidak boleh kosong!");
      return;
    }
    jadwalData.rules_text = text;
    await saveJadwalData();
    await bot!.sendMessage(chatId,
      `\u2705 <b>Rules Berhasil Diset!</b>\n\n` +
      `<b>\uD83D\uDCDC Preview Rules:</b>\n` +
      `<blockquote>${formatRulesMessage()}</blockquote>\n\n` +
      `<b>\u2728 Fitur Rules:</b>\n` +
      `\u2022 Command: <code>/rules</code>\n` +
      `\u2022 Anti spam: 20 menit\n` +
      `\u2022 Auto delete: 10 detik\n` +
      `\u2022 Support HTML tags\n\n` +
      `<i>\uD83D\uDCA1 User sekarang bisa ketik /rules untuk melihat rules!</i>`,
      { parse_mode: "HTML" }
    );
    ownerWaitingState.delete(msg.from!.id);
    return;
  }

  if (waiting.type === "jd_tambah") {
    if (!text.includes("|")) {
      await bot!.sendMessage(chatId,
        `\u274C <b>Format Salah!</b>\n\nHarus menggunakan separator <b>|</b>\n\nContoh:\n<code>Purple River Season 2|Senin</code>`,
        { parse_mode: "HTML" }
      );
      ownerWaitingState.delete(msg.from!.id);
      return;
    }

    const parts = text.split("|").map(p => p.trim());

    if (parts.length === 2) {
      const [judul, hari] = parts;
      if (!judul) { await bot!.sendMessage(chatId, "\u274C Judul anime tidak boleh kosong!"); return; }
      if (!VALID_DAYS.includes(hari)) { await bot!.sendMessage(chatId, "\u274C Hari tidak valid! Gunakan: Senin, Selasa, Rabu, Kamis, Jumat, Sabtu, Minggu"); return; }
      for (const anime of jadwalData.harian[hari]) {
        if ((typeof anime === "object" && anime.judul === judul) || (typeof anime === "string" && anime === judul)) {
          await bot!.sendMessage(chatId, `\u26A0\uFE0F <b>${judul}</b> sudah ada di hari ${hari}!`, { parse_mode: "HTML" }); return;
        }
      }
      jadwalData.harian[hari].push(judul);
      await saveJadwalData();
      let telegraphUpdated = "";
      if (jadwalData.telegraph_token) {
        telegraphUpdated = (await updateTelegraph()) ? "\n\uD83D\uDCF0 <b>Telegraph:</b> Otomatis terupdate \u2705" : "\n\uD83D\uDCF0 <b>Telegraph:</b> Gagal update \u274C";
      }
      await bot!.sendMessage(chatId,
        `\u2705 <b>Jadwal Harian Berhasil Ditambah!</b>\n\n\uD83D\uDCDD <b>Anime:</b> ${judul}\n\uD83D\uDCC5 <b>Hari:</b> ${hari}${telegraphUpdated}\n\n<i>\uD83D\uDCA1 Akan muncul di jadwal harian tanpa link!</i>`,
        { parse_mode: "HTML" }
      );
    } else if (parts.length === 3) {
      const [judul, hari, param3] = parts;
      if (!judul) { await bot!.sendMessage(chatId, "\u274C Judul anime tidak boleh kosong!"); return; }
      if (!VALID_DAYS.includes(hari)) { await bot!.sendMessage(chatId, "\u274C Hari tidak valid!"); return; }

      if (param3.startsWith("http://") || param3.startsWith("https://")) {
        for (const anime of jadwalData.harian[hari]) {
          if ((typeof anime === "object" && anime.judul === judul) || (typeof anime === "string" && anime === judul)) {
            await bot!.sendMessage(chatId, `\u26A0\uFE0F <b>${judul}</b> sudah ada di hari ${hari}!`, { parse_mode: "HTML" }); return;
          }
        }
        jadwalData.harian[hari].push({ judul, link: param3 });
        await saveJadwalData();
        let telegraphUpdated = "";
        if (jadwalData.telegraph_token) {
          telegraphUpdated = (await updateTelegraph()) ? "\n\uD83D\uDCF0 <b>Telegraph:</b> Otomatis terupdate \u2705" : "\n\uD83D\uDCF0 <b>Telegraph:</b> Gagal update \u274C";
        }
        await bot!.sendMessage(chatId,
          `\u2705 <b>Jadwal Harian dengan Link Berhasil Ditambah!</b>\n\n\uD83D\uDCDD <b>Anime:</b> ${judul}\n\uD83D\uDCC5 <b>Hari:</b> ${hari}\n\uD83D\uDD17 <b>Link:</b> <a href='${param3}'>Preview</a>${telegraphUpdated}\n\n<i>\uD83D\uDCA1 Akan muncul di jadwal harian sebagai hyperlink!</i>`,
          { parse_mode: "HTML" }
        );
      } else {
        const tanggal = param3;
        if (jadwalData.upcoming.some(up => up.judul === judul)) {
          await bot!.sendMessage(chatId, `\u26A0\uFE0F <b>${judul}</b> sudah ada di upcoming!`, { parse_mode: "HTML" }); return;
        }
        jadwalData.upcoming.push({ judul, hari, tanggal });
        await saveJadwalData();
        await bot!.sendMessage(chatId,
          `\u2705 <b>Upcoming Tanpa Link Berhasil Ditambah!</b>\n\n\uD83D\uDCDD <b>Anime:</b> ${judul}\n\uD83D\uDCC5 <b>Rilis:</b> ${hari}, ${tanggal}\n\n<i>\uD83D\uDCA1 Akan muncul di blockquote tanpa link preview!</i>`,
          { parse_mode: "HTML" }
        );
      }
    } else if (parts.length === 4) {
      const [judul, hari, tanggal, param4] = parts;
      if (!judul || !hari || !tanggal) { await bot!.sendMessage(chatId, "\u274C Judul, hari, dan tanggal harus diisi!"); return; }
      if (!VALID_DAYS.includes(hari)) { await bot!.sendMessage(chatId, "\u274C Hari tidak valid!"); return; }
      if (jadwalData.upcoming.some(up => up.judul === judul)) {
        await bot!.sendMessage(chatId, `\u26A0\uFE0F <b>${judul}</b> sudah ada di upcoming!`, { parse_mode: "HTML" }); return;
      }
      if (param4.startsWith("http://") || param4.startsWith("https://")) {
        jadwalData.upcoming.push({ judul, hari, tanggal, link: param4 });
        await saveJadwalData();
        await bot!.sendMessage(chatId,
          `\u2705 <b>Upcoming dengan Link Berhasil Ditambah!</b>\n\n\uD83D\uDCDD <b>Anime:</b> ${judul}\n\uD83D\uDCC5 <b>Rilis:</b> ${hari}, ${tanggal}\n\uD83D\uDD17 <b>Preview:</b> <a href='${param4}'>Link</a>\n\n<i>\uD83D\uDCA1 Akan muncul di blockquote hijau dengan link preview!</i>`,
          { parse_mode: "HTML" }
        );
      } else if (param4) {
        jadwalData.upcoming.push({ judul, hari, tanggal, season: param4 });
        await saveJadwalData();
        await bot!.sendMessage(chatId,
          `\u2705 <b>Upcoming dengan Season Berhasil Ditambah!</b>\n\n\uD83D\uDCDD <b>Anime:</b> ${judul}\n\uD83D\uDCFA <b>Season:</b> ${param4}\n\uD83D\uDCC5 <b>Rilis:</b> ${hari}, ${tanggal}\n\n<i>\uD83D\uDCA1 Akan muncul di blockquote tanpa link preview!</i>`,
          { parse_mode: "HTML" }
        );
      } else {
        jadwalData.upcoming.push({ judul, hari, tanggal });
        await saveJadwalData();
        await bot!.sendMessage(chatId,
          `\u2705 <b>Upcoming Tanpa Link dan Season Berhasil Ditambah!</b>\n\n\uD83D\uDCDD <b>Anime:</b> ${judul}\n\uD83D\uDCC5 <b>Rilis:</b> ${hari}, ${tanggal}\n\n<i>\uD83D\uDCA1 Akan muncul di blockquote tanpa link dan season!</i>`,
          { parse_mode: "HTML" }
        );
      }
    } else if (parts.length === 5) {
      const [judul, hari, tanggal, link, season] = parts;
      if (!judul || !hari || !tanggal || !link || !season) { await bot!.sendMessage(chatId, "\u274C Semua field harus diisi!"); return; }
      if (!VALID_DAYS.includes(hari)) { await bot!.sendMessage(chatId, "\u274C Hari tidak valid!"); return; }
      if (!link.startsWith("http://") && !link.startsWith("https://")) { await bot!.sendMessage(chatId, "\u274C Link harus dimulai dengan http:// atau https://"); return; }
      if (jadwalData.upcoming.some(up => up.judul === judul)) {
        await bot!.sendMessage(chatId, `\u26A0\uFE0F <b>${judul}</b> sudah ada di upcoming!`, { parse_mode: "HTML" }); return;
      }
      jadwalData.upcoming.push({ judul, hari, tanggal, link, season });
      await saveJadwalData();
      await bot!.sendMessage(chatId,
        `\u2705 <b>Upcoming Lengkap Berhasil Ditambah!</b>\n\n\uD83D\uDCDD <b>Anime:</b> ${judul}\n\uD83D\uDCFA <b>Season:</b> ${season}\n\uD83D\uDCC5 <b>Rilis:</b> ${hari}, ${tanggal}\n\uD83D\uDD17 <b>Preview:</b> <a href='${link}'>Link</a>\n\n<i>\uD83D\uDCA1 Akan muncul di blockquote hijau lengkap seperti foto contoh!</i>`,
        { parse_mode: "HTML" }
      );
    } else {
      await bot!.sendMessage(chatId,
        `\u274C <b>Format Salah!</b>\n\n` +
        `<b>Format yang didukung:</b>\n` +
        `\u2022 <code>Judul|Hari</code> (harian tanpa link)\n` +
        `\u2022 <code>Judul|Hari|Link</code> (harian dengan link)\n` +
        `\u2022 <code>Judul|Hari|Tanggal</code> (upcoming tanpa link/season)\n` +
        `\u2022 <code>Judul|Hari|Tanggal|Link</code> (upcoming dengan link)\n` +
        `\u2022 <code>Judul|Hari|Tanggal|Season</code> (upcoming dengan season)\n` +
        `\u2022 <code>Judul|Hari|Tanggal|Link|Season</code> (upcoming lengkap)`,
        { parse_mode: "HTML" }
      );
    }
    ownerWaitingState.delete(msg.from!.id);
    return;
  }

  if (waiting.type === "jd_add_channel") {
    if (!(text.startsWith("-") && text.length > 5)) {
      await bot!.sendMessage(chatId,
        `\u274C <b>Format Chat ID Salah!</b>\n\nChat ID channel/group harus:\n\u2022 Dimulai dengan tanda <b>-</b>\n\u2022 Berupa angka panjang\n\u2022 Contoh: <code>-1001234567890</code>\n\n<b>Support channel DAN group!</b>`,
        { parse_mode: "HTML" }
      );
      ownerWaitingState.delete(msg.from!.id);
      return;
    }
    if (jadwalData.channels.includes(text)) {
      await bot!.sendMessage(chatId,
        `\u26A0\uFE0F <b>Channel/Group Sudah Terdaftar!</b>\n\n\uD83D\uDCFA <b>Chat ID:</b> <code>${text}</code>\n\n<i>\uD83D\uDCA1 Channel/Group ini sudah ada dalam daftar auto posting bergiliran!</i>`,
        { parse_mode: "HTML" }
      );
      ownerWaitingState.delete(msg.from!.id);
      return;
    }
    try {
      const testMsg = await bot!.sendMessage(text, "\uD83D\uDD27 <i>Testing access...</i>", { parse_mode: "HTML" });
      try { await bot!.deleteMessage(text, testMsg.message_id); } catch {}
      jadwalData.channels.push(text);
      await saveJadwalData();
      await bot!.sendMessage(chatId,
        `\u2705 <b>Channel/Group Berhasil Ditambah!</b>\n\n` +
        `\uD83D\uDCFA <b>Chat ID:</b> <code>${text}</code>\n` +
        `\uD83D\uDD17 <b>Status:</b> Terhubung\n` +
        `\uD83D\uDCCA <b>Total Channel/Group:</b> ${jadwalData.channels.length}\n\n` +
        `<b>\uD83D\uDD04 Urutan Auto Posting Bergiliran:</b>\n` +
        jadwalData.channels.map((ch, i) => `  ${i + 1}. <code>${ch}</code> \u2192 +${i} menit`).join("\n") +
        `\n\n<i>\uD83D\uDCA1 Bot siap posting bergiliran format seperti foto contoh!</i>`,
        { parse_mode: "HTML" }
      );
    } catch (e: any) {
      const errorMsg = String(e).toLowerCase();
      if (errorMsg.includes("chat not found")) {
        await bot!.sendMessage(chatId, `\u274C <b>Channel/Group Tidak Ditemukan!</b>\n\nPastikan Chat ID benar dan bot pernah di-add`, { parse_mode: "HTML" });
      } else if (errorMsg.includes("not enough rights")) {
        await bot!.sendMessage(chatId, `\u274C <b>Permission Denied!</b>\n\nBot belum jadi admin atau tidak punya izin posting`, { parse_mode: "HTML" });
      } else {
        await bot!.sendMessage(chatId, `\u274C Error: ${String(e)}`, { parse_mode: "HTML" });
      }
    }
    ownerWaitingState.delete(msg.from!.id);
    return;
  }

  if (waiting.type === "jd_set_time") {
    if (!(text.includes(":") && text.length === 5)) {
      await bot!.sendMessage(chatId,
        `\u274C <b>Format Jam Salah!</b>\n\nHarus format <b>HH:MM</b>\n\nContoh: <code>06:00</code> atau <code>18:15</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }
    try {
      const [hourStr, minuteStr] = text.split(":");
      const hour = parseInt(hourStr, 10);
      const minute = parseInt(minuteStr, 10);
      if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
        await bot!.sendMessage(chatId, "\u274C Jam/menit tidak valid!", { parse_mode: "HTML" });
        return;
      }
      const oldTime = jadwalData.post_time;
      jadwalData.post_time = text;
      await saveJadwalData();
      const scheduleInfo = jadwalData.channels.length > 0
        ? jadwalData.channels.map((_, i) => {
          const pm = (minute + i) % 60;
          let ph = hour + Math.floor((minute + i) / 60);
          if (ph >= 24) ph = ph % 24;
          return `  \u2022 Channel/Group ${i + 1}: ${String(ph).padStart(2, "0")}:${String(pm).padStart(2, "0")} WIB`;
        }).join("\n")
        : "  Belum ada channel/group terdaftar";

      await bot!.sendMessage(chatId,
        `\u2705 <b>Jam Auto Post Berhasil Diupdate!</b>\n\n` +
        `\u23F0 <b>Jam lama:</b> ${oldTime} WIB\n` +
        `\u23F0 <b>Jam baru:</b> ${text} WIB\n\n` +
        `<b>\uD83D\uDD04 Jadwal Posting Bergiliran:</b>\n` +
        scheduleInfo +
        `\n\n<i>\uD83D\uDCA1 Bot akan posting otomatis bergiliran sesuai jam yang sudah diset!</i>\n` +
        `<i>\uD83C\uDF0F Menggunakan timezone WIB (UTC+7)</i>`,
        { parse_mode: "HTML" }
      );
    } catch {
      await bot!.sendMessage(chatId, "\u274C Format jam salah! Harus angka HH:MM");
    }
    return;
  }

  } finally {
    ownerWaitingState.delete(msg.from!.id);
  }
}

async function handleOwnerMediaInput(msg: TelegramBot.Message) {
  const waiting = ownerWaitingState.get(msg.from!.id);
  if (!waiting || waiting.type !== "jd_media_url") return;
  const hari = waiting.extra || "";
  const chatId = msg.chat.id;

  try {
    if (msg.photo && msg.photo.length > 0) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      jadwalData.media_jadwal[hari] = { type: "photo", url: fileId };
      await saveJadwalData();
      await bot!.sendMessage(chatId,
        `\u2705 <b>FOTO ${hari.toUpperCase()} BERHASIL DISET!</b>\n\n` +
        `\uD83D\uDCF8 <b>Type:</b> Foto\n\uD83D\uDCC5 <b>Hari:</b> ${hari}\n\uD83C\uDFA8 <b>Status:</b> Siap digunakan\n\n` +
        `<b>\u2728 Fitur Aktif:</b>\n\u2022 Foto akan muncul saat jadwal hari ${hari}\n\u2022 Caption berisi jadwal lengkap\n\u2022 Otomatis di auto post\n\n` +
        `<i>\uD83D\uDCA1 Jadwal hari ${hari} sekarang akan dikirim dengan foto!</i>`,
        { parse_mode: "HTML" }
      );
    } else if (msg.video) {
      const fileId = msg.video.file_id;
      jadwalData.media_jadwal[hari] = { type: "video", url: fileId };
      await saveJadwalData();
      await bot!.sendMessage(chatId,
        `\u2705 <b>VIDEO ${hari.toUpperCase()} BERHASIL DISET!</b>\n\n` +
        `\uD83C\uDFAC <b>Type:</b> Video/GIF\n\uD83D\uDCC5 <b>Hari:</b> ${hari}\n\uD83C\uDFA8 <b>Status:</b> Siap digunakan\n\n` +
        `<b>\u2728 Fitur Aktif:</b>\n\u2022 Video/GIF akan muncul saat jadwal hari ${hari}\n\u2022 Caption berisi jadwal lengkap\n\u2022 Otomatis di auto post\n\n` +
        `<i>\uD83D\uDCA1 Jadwal hari ${hari} sekarang akan dikirim dengan video/GIF!</i>`,
        { parse_mode: "HTML" }
      );
    } else if (msg.animation) {
      const fileId = msg.animation.file_id;
      jadwalData.media_jadwal[hari] = { type: "video", url: fileId };
      await saveJadwalData();
      await bot!.sendMessage(chatId,
        `\u2705 <b>VIDEO ${hari.toUpperCase()} BERHASIL DISET!</b>\n\n` +
        `\uD83C\uDFAC <b>Type:</b> Video/GIF\n\uD83D\uDCC5 <b>Hari:</b> ${hari}\n\uD83C\uDFA8 <b>Status:</b> Siap digunakan\n\n` +
        `<b>\u2728 Fitur Aktif:</b>\n\u2022 Video/GIF akan muncul saat jadwal hari ${hari}\n\u2022 Caption berisi jadwal lengkap\n\u2022 Otomatis di auto post\n\n` +
        `<i>\uD83D\uDCA1 Jadwal hari ${hari} sekarang akan dikirim dengan video/GIF!</i>`,
        { parse_mode: "HTML" }
      );
    } else {
      await bot!.sendMessage(chatId,
        `\u274C <b>Format Media Tidak Didukung!</b>\n\n<b>Format yang didukung:</b>\n\u2022 Foto: JPG, PNG, WEBP\n\u2022 Video: MP4, MOV, AVI\n\u2022 GIF: Animated GIF\n\n<b>Atau kirim URL media:</b>\n<code>https://example.com/media.jpg</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }
    ownerWaitingState.delete(msg.from!.id);
  } catch (e) {
    await bot!.sendMessage(chatId,
      `\u274C <b>Error Upload Media!</b>\n\n\uD83D\uDC1B <b>Error:</b> <code>${String(e).substring(0, 100)}</code>\n\n<i>\uD83D\uDCA1 Coba kirim media yang berbeda atau URL!</i>`,
      { parse_mode: "HTML" }
    );
  }
}

function startAutoPostScheduler() {
  if (autoPostInterval) clearInterval(autoPostInterval);
  autoPostInterval = setInterval(async () => {
    if (!jadwalData.auto_post_enabled || !jadwalData.channels.length || !bot) return;
    const now = new Date();
    const wibTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    const currentTime = `${String(wibTime.getHours()).padStart(2, "0")}:${String(wibTime.getMinutes()).padStart(2, "0")}`;
    const today = wibTime.toISOString().split("T")[0];

    if (currentTime === jadwalData.post_time && lastAutoPostDate !== today) {
      lastAutoPostDate = today;
      if (jadwalData.telegraph_token) await updateTelegraph();
      const message = formatJadwalHariIni();
      for (let i = 0; i < jadwalData.channels.length; i++) {
        setTimeout(async () => {
          try {
            await sendJadwalWithMedia(jadwalData.channels[i], message);
          } catch (err) { console.error(`Auto post to ${jadwalData.channels[i]} failed:`, err); }
        }, i * 60000);
      }
      try {
        await bot!.sendMessage(BOT_OWNER_ID, `Auto Post Bergiliran Berhasil!\n\nTarget: ${jadwalData.channels.length} channel/group`, { parse_mode: "HTML" });
      } catch {}
    }
  }, 30000);
}

function buildOwnerMenuKeyboard(page: number = 1): TelegramBot.InlineKeyboardButton[][] {
  const kb: TelegramBot.InlineKeyboardButton[][] = [];

  if (page === 1) {
    kb.push(
      [{ text: "\u2500\u2500\u2500 Jadwal Donghua \u2500\u2500\u2500", callback_data: "noop" }],
      [{ text: "\u2795 Tambah", callback_data: "jd_tambah" },
       { text: "\u2796 Hapus", callback_data: "jd_hapus" }],
      [{ text: "\uD83D\uDCCB Lihat Semua", callback_data: "jd_lihat" },
       { text: "\uD83D\uDC41 Preview", callback_data: "jd_preview" }],
      [{ text: "\uD83D\uDCE4 Kirim Sekarang", callback_data: "jd_send_now" }],
      [{ text: "\u2500\u2500\u2500 Channel & Posting \u2500\u2500\u2500", callback_data: "noop" }],
      [{ text: "\uD83D\uDCFA Kelola Channel", callback_data: "jd_manage_channels" },
       { text: "\u23F0 Set Jam Post", callback_data: "jd_set_time" }],
      [{ text: "\uD83D\uDD04 Toggle Auto Post", callback_data: "jd_toggle_auto" }],
    );
    kb.push(
      [{ text: "\u27A1\uFE0F Halaman 2/3", callback_data: "owner_page_2" }],
      [{ text: "\uD83D\uDD04 Perbarui", callback_data: "owner_refresh" },
       { text: "\u274C Tutup", callback_data: "menu_close" }],
    );
  } else if (page === 2) {
    kb.push(
      [{ text: "\u2500\u2500\u2500 Telegraph & Rules \u2500\u2500\u2500", callback_data: "noop" }],
      [{ text: "\uD83D\uDCF0 Setup Telegraph", callback_data: "jd_setup_telegraph" },
       { text: "\uD83D\uDCDD Update Telegraph", callback_data: "jd_update_telegraph" }],
      [{ text: "\uD83D\uDCDC Set Rules", callback_data: "jd_set_rules" },
       { text: "\uD83D\uDC41 Preview Rules", callback_data: "jd_preview_rules" }],
      [{ text: "\u2500\u2500\u2500 Media Jadwal \u2500\u2500\u2500", callback_data: "noop" }],
      [{ text: "\uD83C\uDFA8 Set Media per Hari", callback_data: "jd_set_media" }],
    );
    kb.push(
      [{ text: "\u2B05\uFE0F Halaman 1/3", callback_data: "owner_page_1" },
       { text: "\u27A1\uFE0F Halaman 3/3", callback_data: "owner_page_3" }],
      [{ text: "\uD83D\uDD04 Perbarui", callback_data: "owner_refresh" },
       { text: "\u274C Tutup", callback_data: "menu_close" }],
    );
  } else if (page === 3) {
    kb.push(
      [{ text: "\u2500\u2500\u2500 Manajemen Bot \u2500\u2500\u2500", callback_data: "noop" }],
      [{ text: "\uD83D\uDCCB Daftar Grup", callback_data: "owner_groups" },
       { text: "\u2699\uFE0F Kelola Grup", callback_data: "owner_manage" }],
      [{ text: "\uD83D\uDCCA Statistik Global", callback_data: "owner_stats" },
       { text: "\uD83D\uDCDD Log Aktivitas", callback_data: "owner_logs" }],
      [{ text: "\uD83D\uDCE2 Broadcast", callback_data: "owner_broadcast_menu" }],
    );
    kb.push(
      [{ text: "\u2B05\uFE0F Halaman 2/3", callback_data: "owner_page_2" }],
      [{ text: "\uD83D\uDD04 Perbarui", callback_data: "owner_refresh" },
       { text: "\u274C Tutup", callback_data: "menu_close" }],
    );
  }

  return kb;
}

async function buildOwnerPanelText(user: TelegramBot.User): Promise<string> {
  const allGroups = await storage.getGroups();
  const allStats = await storage.getAllStats();

  let totalMessages = 0, totalDeleted = 0, totalWarned = 0, totalBanned = 0;
  let totalKicked = 0, totalMuted = 0, totalSpam = 0, totalForceSub = 0;
  let activeGroups = 0;

  allGroups.forEach(g => { if (g.isActive) activeGroups++; });

  allStats.forEach(s => {
    totalMessages += s.messagesProcessed ?? 0;
    totalDeleted += s.messagesDeleted ?? 0;
    totalWarned += s.usersWarned ?? 0;
    totalBanned += s.usersBanned ?? 0;
    totalKicked += s.usersKicked ?? 0;
    totalMuted += s.usersMuted ?? 0;
    totalSpam += s.spamBlocked ?? 0;
    totalForceSub += s.forceJoinBlocked ?? 0;
  });

  const now = new Date();
  const waktu = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "long", timeStyle: "short" });

  const today = getTodayIndo();
  const channelsInfo = jadwalData.channels.length > 0 ? `${jadwalData.channels.length} channel/group` : "\u274C Belum diset";
  const timeInfo = jadwalData.post_time;
  const autoStatus = jadwalData.auto_post_enabled ? "\uD83D\uDFE2 AKTIF" : "\uD83D\uDD34 NONAKTIF";
  const telegraphStatus = jadwalData.telegraph_token ? "\uD83D\uDFE2 AKTIF" : "\uD83D\uDD34 NONAKTIF";
  const rulesStatus = jadwalData.rules_text ? "\uD83D\uDFE2 SUDAH DISET" : "\uD83D\uDD34 BELUM DISET";
  const mediaCount = Object.values(jadwalData.media_jadwal).filter(m => m.url).length;
  const mediaStatus = mediaCount > 0 ? `\uD83D\uDFE2 ${mediaCount}/7 HARI` : "\uD83D\uDD34 BELUM DISET";
  const jadwalHariIni = jadwalData.harian[today]?.length || 0;
  const totalMinggu = Object.values(jadwalData.harian).reduce((sum, arr) => sum + arr.length, 0);
  const nextPost = !jadwalData.auto_post_enabled ? "Tidak ada" : `Bergiliran setiap hari jam ${jadwalData.post_time}`;

  return `<b>\uD83C\uDFAC PANEL ADMIN JADWAL DONGHUA</b>

<b>\uD83D\uDCCA Status Sistem:</b>
\uD83D\uDCC5 Hari ini: <b>${today}</b>
\uD83D\uDCDD Jadwal hari ini: <b>${jadwalHariIni} anime</b>
\uD83D\uDCC8 Total minggu ini: <b>${totalMinggu} anime</b>
\uD83D\uDCFA Channel/Group: <b>${channelsInfo}</b>
\u23F0 Jam auto post: <b>${timeInfo} WIB</b>
\uD83E\uDD16 Status: <b>${autoStatus}</b>
\uD83D\uDCF0 Telegraph: <b>${telegraphStatus}</b>
\uD83D\uDCDC Rules: <b>${rulesStatus}</b>
\uD83C\uDFA8 Media Jadwal: <b>${mediaStatus}</b>
\u23ED\uFE0F Posting: <b>${nextPost}</b>

<b>Status Bot Moderasi:</b>
Pemilik: ${getUserMention(user)}
Waktu: <b>${waktu} WIB</b>
Total Grup: <b>${allGroups.length}</b>
Grup Aktif: <b>${activeGroups}</b>

<b>Statistik Global:</b>
Pesan Diproses: <b>${totalMessages}</b>
Pesan Dihapus: <b>${totalDeleted}</b>
Pengguna Diperingatkan: <b>${totalWarned}</b>
Pengguna Dibanned: <b>${totalBanned}</b>
Pengguna Ditendang: <b>${totalKicked}</b>
Pengguna Dibisukan: <b>${totalMuted}</b>
Spam Diblokir: <b>${totalSpam}</b>
Force Sub Diblokir: <b>${totalForceSub}</b>

Pilih menu di bawah:`;
}

function buildStartMenuKeyboard(userId: number, groupId?: string): TelegramBot.InlineKeyboardButton[][] {
  const kb: TelegramBot.InlineKeyboardButton[][] = [];
  if (groupId) {
    kb.push(
      [{ text: "\u2500\u2500\u2500 Pengaturan Grup \u2500\u2500\u2500", callback_data: "noop" }],
      [{ text: "\u2699\uFE0F Fitur", callback_data: `pm_settings_${groupId}` },
       { text: "\uD83D\uDD14 Wajib Sub", callback_data: `pm_forcejoin_${groupId}` }],
      [{ text: "\uD83D\uDEAB Filter Kata", callback_data: `pm_wordfilter_${groupId}` },
       { text: "\u26A0\uFE0F Peringatan", callback_data: `pm_warnings_${groupId}` }],
      [{ text: "\uD83D\uDCCA Statistik", callback_data: `pm_stats_${groupId}` }],
    );
  }
  kb.push(
    [{ text: "\u2500\u2500\u2500 Menu Utama \u2500\u2500\u2500", callback_data: "noop" }],
    [{ text: "\uD83D\uDCC2 Kelola Grup", callback_data: `start_setgroup` }],
    [{ text: "\u2753 Bantuan", callback_data: `help_main` }],
    [{ text: "\uD83D\uDEE1\uFE0F Moderasi", callback_data: `help_moderasi` },
     { text: "\u2699\uFE0F Pengaturan", callback_data: `help_pengaturan` }],
  );
  if (isBotOwner(userId)) {
    kb.push([{ text: "\uD83D\uDC51 Panel Pemilik Bot", callback_data: `start_owner` }]);
  }
  kb.push([{ text: "\u274C Tutup", callback_data: `menu_close` }]);
  return kb;
}

function buildHelpMainKeyboard(): TelegramBot.InlineKeyboardButton[][] {
  return [
    [{ text: "\uD83D\uDCD6 Perintah Umum", callback_data: `help_umum` }],
    [{ text: "\uD83D\uDEE1\uFE0F Perintah Moderasi", callback_data: `help_moderasi` }],
    [{ text: "\u2699\uFE0F Perintah Pengaturan", callback_data: `help_pengaturan` }],
    [{ text: "\uD83D\uDC51 Info Pemilik Bot", callback_data: `help_pemilik` }],
    [{ text: "\u2B05\uFE0F Kembali", callback_data: `start_back` }],
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

  await loadJadwalData();
  startAutoPostScheduler();

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

      await storage.upsertBotUser({
        odId: msg.from.id.toString(),
        firstName: msg.from.first_name || "",
        lastName: msg.from.last_name || "",
        username: msg.from.username || "",
      });

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
            [{ text: "\u2753 Bantuan", callback_data: `help_main` },
             { text: "\uD83D\uDCDC Aturan Grup", callback_data: `show_rules_${chatId}` }],
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
        `<b>\u2753 Bantuan Bot Moderator</b>\n\nPilih kategori perintah di bawah:`,
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

<b>Wajib Sub:</b> ${settings.forceJoinEnabled ? "Aktif" : "Nonaktif"}
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
Wajib Sub Diblokir: <b>${stats.forceJoinBlocked}</b>`;

      await bot!.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /stats:", err);
    }
  });

  // /rules - Aturan grup
  bot.onText(/\/rules/, async (msg) => {
    try {
      if (msg.chat.type === "private") return;

      if (jadwalData.rules_text) {
        const now = Date.now();
        if (!isBotOwner(msg.from?.id || 0) && lastRulesTime && (now - lastRulesTime) < 20 * 60 * 1000) {
          try { await bot!.deleteMessage(msg.chat.id, msg.message_id); } catch {}
          const remaining = Math.ceil((20 * 60 * 1000 - (now - lastRulesTime)) / 60000);
          const antiSpamMsg = await bot!.sendMessage(msg.chat.id,
            `\u26A0\uFE0F <i>Command /rules bisa digunakan lagi dalam ${remaining} menit</i>`,
            { parse_mode: "HTML" }
          );
          setTimeout(async () => { try { await bot!.deleteMessage(msg.chat.id, antiSpamMsg.message_id); } catch {} }, 10000);
          return;
        }
        lastRulesTime = now;
        try { await bot!.deleteMessage(msg.chat.id, msg.message_id); } catch {}
        const rulesMsg = formatRulesMessage();
        const sentMsg = await bot!.sendMessage(msg.chat.id, rulesMsg, { parse_mode: "HTML", disable_web_page_preview: true });
        setTimeout(async () => { try { await bot!.deleteMessage(msg.chat.id, sentMsg.message_id); } catch {} }, 10000);
        return;
      }

      const chatId = msg.chat.id.toString();
      const settings = await storage.getSettings(chatId);

      const channels = settings?.forceJoinChannels || [];
      let rulesText = `<b>Aturan Grup ${escapeHtml(msg.chat.title || "")}</b>\n\n`;

      if (settings?.forceJoinEnabled && channels.length > 0) {
        rulesText += `- Wajib subscribe ke: ${channels.map((c: string) => `@${c}`).join(", ")}\n`;
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

  bot.onText(/\/jadwal/, async (msg) => {
    try {
      if (msg.chat.type === "private") return;

      const now = Date.now();
      if (!isBotOwner(msg.from?.id || 0) && lastJadwalTime && (now - lastJadwalTime) < 20 * 60 * 1000) {
        try { await bot!.deleteMessage(msg.chat.id, msg.message_id); } catch {}
        const remaining = Math.ceil((20 * 60 * 1000 - (now - lastJadwalTime)) / 60000);
        const antiSpamMsg = await bot!.sendMessage(msg.chat.id,
          `\u26A0\uFE0F <i>Command /jadwal bisa digunakan lagi dalam ${remaining} menit</i>`,
          { parse_mode: "HTML" }
        );
        setTimeout(async () => { try { await bot!.deleteMessage(msg.chat.id, antiSpamMsg.message_id); } catch {} }, 10000);
        return;
      }
      lastJadwalTime = now;
      try { await bot!.deleteMessage(msg.chat.id, msg.message_id); } catch {}
      const jadwalText = formatJadwalHariIni();
      await sendJadwalWithMedia(msg.chat.id, jadwalText);
    } catch (err) {
      console.error("Error handling /jadwal:", err);
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

  // /setforcesub - Tambah channel wajib sub
  bot.onText(/\/setforcesub (.+)/, async (msg, match) => {
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
        await bot!.sendMessage(msg.chat.id, `Channel @${channel} sudah ada di daftar wajib sub.`);
        return;
      }

      await storage.updateSettings(chatId, {
        forceJoinChannels: [...current, channel],
        forceJoinEnabled: true,
      });

      await bot!.sendMessage(
        msg.chat.id,
        `Channel @${channel} berhasil ditambahkan ke daftar wajib sub.\nForce Sub telah diaktifkan.`,
      );
    } catch (err) {
      console.error("Error handling /setforcesub:", err);
    }
  });

  // /delforcesub - Hapus channel wajib sub
  bot.onText(/\/delforcesub (.+)/, async (msg, match) => {
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
        await bot!.sendMessage(msg.chat.id, `Channel @${channel} tidak ditemukan di daftar wajib sub.`);
        return;
      }

      const updated = current.filter(c => c !== channel);
      await storage.updateSettings(chatId, { forceJoinChannels: updated });

      await bot!.sendMessage(
        msg.chat.id,
        `Channel @${channel} berhasil dihapus dari daftar wajib sub.${updated.length === 0 ? "\nTidak ada channel tersisa." : ""}`,
      );
    } catch (err) {
      console.error("Error handling /delforcesub:", err);
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

  // /warn - Beri peringatan (reply, user_id, @username)
  bot.onText(/\/warn(?:\s|$|@)(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;

      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const args = match?.[1]?.trim() || "";
      const target = await resolveTargetUser(msg, args);

      if (!target) {
        await bot!.sendMessage(msg.chat.id,
          "Balas pesan pengguna, atau gunakan:\n<code>/warn @username alasan</code>\n<code>/warn user_id alasan</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      try {
        const memberInfo = await bot!.getChatMember(msg.chat.id, target.userId);
        if (memberInfo.user?.is_bot) {
          await bot!.sendMessage(msg.chat.id, "Tidak bisa memperingatkan bot.");
          return;
        }
      } catch {}

      if (await isAdmin(msg.chat.id, target.userId) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Tidak bisa memperingatkan admin.");
        return;
      }

      const reason = msg.reply_to_message?.from ? (args || "Tidak ada alasan") : (getArgsAfterTarget(args) || "Tidak ada alasan");
      const chatId = msg.chat.id.toString();
      const adminName = getUserDisplayName(msg.from);

      await storage.addWarning({
        chatId,
        odId: target.userId.toString(),
        odName: target.displayName,
        reason,
        warnedBy: adminName,
      });

      const count = await storage.getWarningCount(chatId, target.userId.toString());
      const settings = await storage.getSettings(chatId);
      const warnLimit = settings?.warnLimit ?? 3;

      await bot!.sendMessage(
        msg.chat.id,
        `${target.mentionHtml} telah diperingatkan. (<b>${count}/${warnLimit}</b>)\nAlasan: ${escapeHtml(reason)}`,
        { parse_mode: "HTML" }
      );

      await storage.incrementStat(chatId, "usersWarned");
      await storage.addLog({
        chatId,
        action: "warn",
        targetUser: target.displayName,
        performedBy: adminName,
        details: `Peringatan ${count}/${warnLimit}: ${reason}`,
      });

      if (count >= warnLimit && settings) {
        await handleWarnAction(msg.chat.id, chatId, target.userId, target.displayName, settings);
      }
    } catch (err) {
      console.error("Error handling /warn:", err);
    }
  });

  // /unwarn - Hapus semua peringatan (reply, user_id, @username)
  bot.onText(/\/unwarn(?:\s|$|@)(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const args = match?.[1]?.trim() || "";
      const target = await resolveTargetUser(msg, args);

      if (!target) {
        await bot!.sendMessage(msg.chat.id,
          "Balas pesan pengguna, atau gunakan:\n<code>/unwarn @username</code>\n<code>/unwarn user_id</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const chatId = msg.chat.id.toString();
      await storage.clearWarnings(chatId, target.userId.toString());
      await bot!.sendMessage(
        msg.chat.id,
        `Semua peringatan untuk ${target.mentionHtml} telah dihapus.`,
        { parse_mode: "HTML" }
      );

      await storage.addLog({
        chatId,
        action: "unwarn",
        targetUser: target.displayName,
        performedBy: getUserDisplayName(msg.from),
        details: "Semua peringatan dihapus",
      });
    } catch (err) {
      console.error("Error handling /unwarn:", err);
    }
  });

  // /warnings - Cek peringatan (reply, user_id, @username)
  bot.onText(/\/warnings(?:\s|$|@)(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;

      const args = match?.[1]?.trim() || "";
      const target = await resolveTargetUser(msg, args);

      if (!target) {
        await bot!.sendMessage(msg.chat.id,
          "Balas pesan pengguna, atau gunakan:\n<code>/warnings @username</code>\n<code>/warnings user_id</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const chatId = msg.chat.id.toString();
      const warns = await storage.getWarnings(chatId, target.userId.toString());

      if (warns.length === 0) {
        await bot!.sendMessage(
          msg.chat.id,
          `${target.mentionHtml} tidak memiliki peringatan.`,
          { parse_mode: "HTML" }
        );
        return;
      }

      let text = `<b>Peringatan untuk ${escapeHtml(target.displayName)}</b> (${warns.length}):\n\n`;
      warns.forEach((w, i) => {
        text += `${i + 1}. ${escapeHtml(w.reason)} - oleh ${escapeHtml(w.warnedBy)}\n`;
      });

      await bot!.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /warnings:", err);
    }
  });

  // /ban - Banned pengguna (reply, user_id, @username)
  bot.onText(/\/ban(?:\s|$|@)(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const args = match?.[1]?.trim() || "";
      const target = await resolveTargetUser(msg, args);

      if (!target) {
        await bot!.sendMessage(msg.chat.id,
          "Balas pesan pengguna, atau gunakan:\n<code>/ban @username [alasan]</code>\n<code>/ban user_id [alasan]</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      try {
        const memberInfo = await bot!.getChatMember(msg.chat.id, target.userId);
        if (memberInfo.user?.is_bot) {
          await bot!.sendMessage(msg.chat.id, "Tidak bisa mem-banned bot.");
          return;
        }
      } catch {}

      if (await isAdmin(msg.chat.id, target.userId) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Tidak bisa mem-banned admin.");
        return;
      }

      const reason = msg.reply_to_message?.from ? (args || "") : (getArgsAfterTarget(args) || "");
      const chatId = msg.chat.id.toString();

      await bot!.banChatMember(msg.chat.id, target.userId);

      let banMsg = `${target.mentionHtml} telah <b>dibanned</b> dari grup.`;
      if (reason) banMsg += `\nAlasan: ${escapeHtml(reason)}`;
      await bot!.sendMessage(msg.chat.id, banMsg, { parse_mode: "HTML" });

      await storage.incrementStat(chatId, "usersBanned");
      await storage.addLog({
        chatId,
        action: "ban",
        targetUser: target.displayName,
        performedBy: getUserDisplayName(msg.from),
        details: reason ? `Dibanned: ${reason}` : "Dibanned oleh admin",
      });
    } catch (err) {
      console.error("Error handling /ban:", err);
    }
  });

  // /unban - Buka banned (reply, user_id, @username)
  bot.onText(/\/unban(?:\s|$|@)(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const args = match?.[1]?.trim() || "";
      const target = await resolveTargetUser(msg, args);

      if (!target) {
        await bot!.sendMessage(msg.chat.id,
          "Balas pesan pengguna, atau gunakan:\n<code>/unban @username</code>\n<code>/unban user_id</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const chatId = msg.chat.id.toString();
      await bot!.unbanChatMember(msg.chat.id, target.userId);
      await bot!.sendMessage(
        msg.chat.id,
        `${target.mentionHtml} telah <b>dibuka banned-nya</b>.`,
        { parse_mode: "HTML" }
      );

      await storage.addLog({
        chatId,
        action: "unban",
        targetUser: target.displayName,
        performedBy: getUserDisplayName(msg.from),
        details: "Dibuka banned-nya oleh admin",
      });
    } catch (err) {
      console.error("Error handling /unban:", err);
    }
  });

  // /kick - Tendang pengguna (reply, user_id, @username)
  bot.onText(/\/kick(?:\s|$|@)(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const args = match?.[1]?.trim() || "";
      const target = await resolveTargetUser(msg, args);

      if (!target) {
        await bot!.sendMessage(msg.chat.id,
          "Balas pesan pengguna, atau gunakan:\n<code>/kick @username [alasan]</code>\n<code>/kick user_id [alasan]</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      try {
        const memberInfo = await bot!.getChatMember(msg.chat.id, target.userId);
        if (memberInfo.user?.is_bot) {
          await bot!.sendMessage(msg.chat.id, "Tidak bisa menendang bot.");
          return;
        }
      } catch {}

      if (await isAdmin(msg.chat.id, target.userId) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Tidak bisa menendang admin.");
        return;
      }

      const reason = msg.reply_to_message?.from ? (args || "") : (getArgsAfterTarget(args) || "");
      const chatId = msg.chat.id.toString();

      await bot!.banChatMember(msg.chat.id, target.userId);
      await bot!.unbanChatMember(msg.chat.id, target.userId);

      let kickMsg = `${target.mentionHtml} telah <b>ditendang</b> dari grup.`;
      if (reason) kickMsg += `\nAlasan: ${escapeHtml(reason)}`;
      await bot!.sendMessage(msg.chat.id, kickMsg, { parse_mode: "HTML" });

      await storage.incrementStat(chatId, "usersKicked");
      await storage.addLog({
        chatId,
        action: "kick",
        targetUser: target.displayName,
        performedBy: getUserDisplayName(msg.from),
        details: reason ? `Ditendang: ${reason}` : "Ditendang oleh admin",
      });
    } catch (err) {
      console.error("Error handling /kick:", err);
    }
  });

  // /mute - Bisukan pengguna (reply, user_id, @username)
  bot.onText(/\/mute(?:\s|$|@)(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;

      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const args = match?.[1]?.trim() || "";
      const target = await resolveTargetUser(msg, args);

      if (!target) {
        await bot!.sendMessage(msg.chat.id,
          "Balas pesan pengguna, atau gunakan:\n<code>/mute @username [menit]</code>\n<code>/mute user_id [menit]</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      try {
        const memberInfo = await bot!.getChatMember(msg.chat.id, target.userId);
        if (memberInfo.user?.is_bot) {
          await bot!.sendMessage(msg.chat.id, "Tidak bisa membisukan bot.");
          return;
        }
      } catch {}

      if (await isAdmin(msg.chat.id, target.userId) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Tidak bisa membisukan admin.");
        return;
      }

      const remainingArgs = msg.reply_to_message?.from ? args : getArgsAfterTarget(args);
      const durationMin = parseInt(remainingArgs || "60", 10);
      const durationSec = isNaN(durationMin) ? 3600 : durationMin * 60;
      const displayMin = isNaN(durationMin) ? 60 : durationMin;
      const chatId = msg.chat.id.toString();

      await bot!.restrictChatMember(msg.chat.id, target.userId, {
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
        `${target.mentionHtml} telah <b>dibisukan</b> selama ${displayMin} menit.`,
        { parse_mode: "HTML" }
      );

      await storage.incrementStat(chatId, "usersMuted");
      await storage.addLog({
        chatId,
        action: "mute",
        targetUser: target.displayName,
        performedBy: getUserDisplayName(msg.from),
        details: `Dibisukan selama ${displayMin} menit`,
      });
    } catch (err) {
      console.error("Error handling /mute:", err);
    }
  });

  // /unmute - Buka bisukan (reply, user_id, @username)
  bot.onText(/\/unmute(?:\s|$|@)(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya admin yang bisa menggunakan perintah ini.");
        return;
      }

      const args = match?.[1]?.trim() || "";
      const target = await resolveTargetUser(msg, args);

      if (!target) {
        await bot!.sendMessage(msg.chat.id,
          "Balas pesan pengguna, atau gunakan:\n<code>/unmute @username</code>\n<code>/unmute user_id</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const chatId = msg.chat.id.toString();
      await bot!.restrictChatMember(msg.chat.id, target.userId, {
        permissions: {
          can_send_messages: true,
          can_send_media_messages: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
        },
      } as any);

      await bot!.sendMessage(
        msg.chat.id,
        `${target.mentionHtml} telah <b>dibuka bisukannya</b>.`,
        { parse_mode: "HTML" }
      );

      await storage.addLog({
        chatId,
        action: "unmute",
        targetUser: target.displayName,
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

  // /promote - Jadikan admin (reply, user_id, @username)
  bot.onText(/\/promote(?:\s|$|@)(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isCreator(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya pemilik grup atau pemilik bot yang bisa menggunakan perintah ini.");
        return;
      }

      const args = match?.[1]?.trim() || "";
      const target = await resolveTargetUser(msg, args);

      if (!target) {
        await bot!.sendMessage(msg.chat.id,
          "Balas pesan pengguna, atau gunakan:\n<code>/promote @username</code>\n<code>/promote user_id</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      await bot!.promoteChatMember(msg.chat.id, target.userId, {
        can_delete_messages: true,
        can_restrict_members: true,
        can_pin_messages: true,
        can_invite_users: true,
      } as any);

      await bot!.sendMessage(
        msg.chat.id,
        `${target.mentionHtml} telah <b>dijadikan admin</b>.`,
        { parse_mode: "HTML" }
      );

      await storage.addLog({
        chatId: msg.chat.id.toString(),
        action: "promote",
        targetUser: target.displayName,
        performedBy: getUserDisplayName(msg.from),
        details: "Dijadikan admin",
      });
    } catch (err) {
      console.error("Error handling /promote:", err);
      await bot!.sendMessage(msg.chat.id, "Gagal menjadikan admin. Pastikan bot memiliki izin yang cukup.");
    }
  });

  // /demote - Cabut admin (reply, user_id, @username)
  bot.onText(/\/demote(?:\s|$|@)(.*)/, async (msg, match) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isCreator(msg.chat.id, msg.from.id)) && !isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Hanya pemilik grup atau pemilik bot yang bisa menggunakan perintah ini.");
        return;
      }

      const args = match?.[1]?.trim() || "";
      const target = await resolveTargetUser(msg, args);

      if (!target) {
        await bot!.sendMessage(msg.chat.id,
          "Balas pesan pengguna, atau gunakan:\n<code>/demote @username</code>\n<code>/demote user_id</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      await bot!.promoteChatMember(msg.chat.id, target.userId, {
        can_delete_messages: false,
        can_restrict_members: false,
        can_pin_messages: false,
        can_invite_users: false,
        can_change_info: false,
        can_manage_chat: false,
      } as any);

      await bot!.sendMessage(
        msg.chat.id,
        `${target.mentionHtml} telah <b>dicabut jabatan admin-nya</b>.`,
        { parse_mode: "HTML" }
      );

      await storage.addLog({
        chatId: msg.chat.id.toString(),
        action: "demote",
        targetUser: target.displayName,
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
  bot.onText(/\/(owner|menuowner)/, async (msg) => {
    try {
      if (!msg.from) return;

      if (!isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Perintah ini hanya untuk pemilik bot.");
        return;
      }

      const text = await buildOwnerPanelText(msg.from);

      await bot!.sendMessage(msg.chat.id, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildOwnerMenuKeyboard() },
      });
    } catch (err) {
      console.error("Error handling /owner:", err);
    }
  });

  function applyFillings(text: string, user: { id: number; first_name: string; last_name?: string; username?: string }, chatName?: string): { text: string; protect: boolean; preview: boolean; nonotif: boolean } {
    let protect = false;
    let preview = false;
    let nonotif = false;

    const firstName = user.first_name || "";
    const lastName = user.last_name || "";
    const fullName = lastName ? `${firstName} ${lastName}` : firstName;
    const username = user.username ? `@${user.username}` : `<a href="tg://user?id=${user.id}">${escapeHtml(firstName)}</a>`;
    const mention = `<a href="tg://user?id=${user.id}">${escapeHtml(firstName)}</a>`;

    let result = text;
    result = result.replace(/\{first\}/gi, escapeHtml(firstName));
    result = result.replace(/\{last\}/gi, escapeHtml(lastName));
    result = result.replace(/\{fullname\}/gi, escapeHtml(fullName));
    result = result.replace(/\{username\}/gi, username);
    result = result.replace(/\{mention\}/gi, mention);
    result = result.replace(/\{id\}/gi, String(user.id));
    result = result.replace(/\{chatname\}/gi, escapeHtml(chatName || "Private Chat"));

    if (/\{rules\}/gi.test(result)) {
      result = result.replace(/\{rules\}/gi, "");
    }
    if (/\{protect\}/gi.test(result)) {
      protect = true;
      result = result.replace(/\{protect\}/gi, "");
    }
    if (/\{preview\}/gi.test(result)) {
      preview = true;
      result = result.replace(/\{preview\}/gi, "");
    }
    if (/\{nonotif\}/gi.test(result)) {
      nonotif = true;
      result = result.replace(/\{nonotif\}/gi, "");
    }

    return { text: result.trim(), protect, preview, nonotif };
  }

  function parseMarkdownToHtml(text: string): string {
    let result = text;
    result = result.replace(/```([\s\S]*?)```/g, "<pre>$1</pre>");
    result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
    result = result.replace(/\*([^*]+)\*/g, "<b>$1</b>");
    result = result.replace(/__([^_]+)__/g, "<u>$1</u>");
    result = result.replace(/(?<![_a-zA-Z])_([^_]+)_(?![_a-zA-Z])/g, "<i>$1</i>");
    result = result.replace(/~([^~]+)~/g, "<s>$1</s>");
    result = result.replace(/\|\|([^|]+)\|\|/g, '<span class="tg-spoiler">$1</span>');
    result = result.replace(/\[([^\]]+)\]\((?!buttonurl:\/\/)([^)]+)\)/g, '<a href="$2">$1</a>');
    return result;
  }

  function extractButtonUrls(text: string): { cleanText: string; buttons: TelegramBot.InlineKeyboardButton[][] } {
    const buttons: TelegramBot.InlineKeyboardButton[][] = [];
    const buttonRegex = /\[([^\]]+)\]\(buttonurl:\/\/([^)]+)\)/g;
    let cleanText = text;
    const matches: { full: string; label: string; url: string; same: boolean }[] = [];

    let m;
    while ((m = buttonRegex.exec(text)) !== null) {
      let url = m[2];
      let same = false;
      if (url.endsWith(":same")) {
        same = true;
        url = url.slice(0, -5);
      }
      matches.push({ full: m[0], label: m[1], url, same });
    }

    for (const match of matches) {
      cleanText = cleanText.replace(match.full, "");
    }

    cleanText = cleanText.replace(/\n{3,}/g, "\n\n").trim();

    let currentRow: TelegramBot.InlineKeyboardButton[] = [];
    for (const match of matches) {
      if (match.same && currentRow.length > 0) {
        currentRow.push({ text: match.label, url: match.url });
      } else {
        if (currentRow.length > 0) {
          buttons.push(currentRow);
        }
        currentRow = [{ text: match.label, url: match.url }];
      }
    }
    if (currentRow.length > 0) {
      buttons.push(currentRow);
    }

    return { cleanText, buttons };
  }

  // /broadcast - Kirim pesan ke semua pengguna yang start bot
  // Support: text, reply media (photo, video, document, audio, sticker, animation, voice, video_note), caption
  bot.onText(/\/broadcast(?:\s|$)(.*)/, async (msg, match) => {
    try {
      if (!msg.from) return;

      if (!isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Perintah ini hanya untuk pemilik bot.");
        return;
      }

      const rawArgs = (match![1] || "").trim();
      const replyMsg = msg.reply_to_message;

      const hasMedia = replyMsg && (replyMsg.photo || replyMsg.video || replyMsg.document || replyMsg.audio || replyMsg.animation || replyMsg.sticker || replyMsg.voice || replyMsg.video_note);
      const replyText = replyMsg?.text || replyMsg?.caption || "";
      const rawMessage = rawArgs || replyText;

      if (!rawMessage && !hasMedia) {
        await bot!.sendMessage(msg.chat.id,
          "\u274C Pesan broadcast tidak boleh kosong!\n\n" +
          "<b>Cara penggunaan:</b>\n" +
          "1. <code>/broadcast pesan anda</code>\n" +
          "2. Reply media/pesan + <code>/broadcast</code>\n" +
          "3. Reply media + <code>/broadcast caption baru</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const allUsers = await storage.getAllBotUsers();

      if (allUsers.length === 0) {
        await bot!.sendMessage(msg.chat.id, "\u274C Belum ada pengguna yang memulai bot.", { parse_mode: "HTML" });
        return;
      }

      let mediaType: string | null = null;
      let mediaFileId: string | null = null;

      if (hasMedia && replyMsg) {
        if (replyMsg.photo && replyMsg.photo.length > 0) {
          mediaType = "photo";
          mediaFileId = replyMsg.photo[replyMsg.photo.length - 1].file_id;
        } else if (replyMsg.animation) {
          mediaType = "animation";
          mediaFileId = replyMsg.animation.file_id;
        } else if (replyMsg.video) {
          mediaType = "video";
          mediaFileId = replyMsg.video.file_id;
        } else if (replyMsg.document) {
          mediaType = "document";
          mediaFileId = replyMsg.document.file_id;
        } else if (replyMsg.audio) {
          mediaType = "audio";
          mediaFileId = replyMsg.audio.file_id;
        } else if (replyMsg.sticker) {
          mediaType = "sticker";
          mediaFileId = replyMsg.sticker.file_id;
        } else if (replyMsg.voice) {
          mediaType = "voice";
          mediaFileId = replyMsg.voice.file_id;
        } else if (replyMsg.video_note) {
          mediaType = "video_note";
          mediaFileId = replyMsg.video_note.file_id;
        }
      }

      const statusMsg = await bot!.sendMessage(
        msg.chat.id,
        `\u23F3 <b>Broadcast dimulai...</b>\n\nTarget: <b>${allUsers.length}</b> pengguna\n` +
        (mediaType ? `Media: <b>${mediaType}</b>\n` : "") +
        `Status: Mengirim...`,
        { parse_mode: "HTML" }
      );

      let sent = 0;
      let failed = 0;
      let blocked = 0;

      for (const user of allUsers) {
        try {
          const userObj = {
            id: parseInt(user.odId),
            first_name: user.firstName || "",
            last_name: user.lastName || "",
            username: user.username || "",
          };

          let processedText = rawMessage;
          if (processedText) {
            processedText = parseMarkdownToHtml(processedText);
          }
          const { cleanText, buttons } = extractButtonUrls(processedText || "");
          const fillings = applyFillings(cleanText, userObj);

          const baseOptions: any = {
            parse_mode: "HTML",
            disable_notification: fillings.nonotif,
          };

          if (fillings.protect) {
            baseOptions.protect_content = true;
          }

          if (buttons.length > 0) {
            baseOptions.reply_markup = { inline_keyboard: buttons };
          }

          if (mediaType && mediaFileId) {
            const captionOpts: any = { ...baseOptions };
            if (fillings.text && mediaType !== "sticker" && mediaType !== "video_note") {
              captionOpts.caption = fillings.text;
            }

            switch (mediaType) {
              case "photo":
                await bot!.sendPhoto(user.odId, mediaFileId, captionOpts);
                break;
              case "video":
                await bot!.sendVideo(user.odId, mediaFileId, captionOpts);
                break;
              case "animation":
                await bot!.sendAnimation(user.odId, mediaFileId, captionOpts);
                break;
              case "document":
                await bot!.sendDocument(user.odId, mediaFileId, captionOpts);
                break;
              case "audio":
                await bot!.sendAudio(user.odId, mediaFileId, captionOpts);
                break;
              case "sticker":
                await bot!.sendSticker(user.odId, mediaFileId, baseOptions);
                break;
              case "voice":
                await bot!.sendVoice(user.odId, mediaFileId, captionOpts);
                break;
              case "video_note":
                await bot!.sendVideoNote(user.odId, mediaFileId as any, baseOptions);
                break;
              default:
                await bot!.sendMessage(user.odId, fillings.text, { ...baseOptions, disable_web_page_preview: !fillings.preview });
            }
          } else {
            await bot!.sendMessage(user.odId, fillings.text, { ...baseOptions, disable_web_page_preview: !fillings.preview });
          }
          sent++;
        } catch (e: any) {
          const errStr = String(e).toLowerCase();
          if (errStr.includes("blocked") || errStr.includes("deactivated") || errStr.includes("not found")) {
            blocked++;
          }
          failed++;
        }

        if ((sent + failed) % 25 === 0) {
          try {
            await bot!.editMessageText(
              `\u23F3 <b>Broadcast sedang berjalan...</b>\n\nTarget: <b>${allUsers.length}</b> pengguna\nTerkirim: <b>${sent}</b>\nGagal: <b>${failed}</b>\nProgress: <b>${sent + failed}/${allUsers.length}</b>`,
              { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: "HTML" }
            );
          } catch {}
        }
      }

      try {
        await bot!.editMessageText(
          `\u2705 <b>Broadcast Selesai!</b>\n\n` +
          `\uD83D\uDCE8 <b>Total Target:</b> ${allUsers.length} pengguna\n` +
          (mediaType ? `\uD83C\uDFA8 <b>Media:</b> ${mediaType}\n` : "") +
          `\u2705 <b>Terkirim:</b> ${sent}\n` +
          `\u274C <b>Gagal:</b> ${failed}\n` +
          `\uD83D\uDEAB <b>Blocked/Deaktif:</b> ${blocked}\n\n` +
          `<i>Broadcast dikirim ke semua pengguna yang pernah /start bot.</i>`,
          { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: "HTML" }
        );
      } catch {}
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
            [{ text: "Wajib Sub", callback_data: `pm_forcejoin_${chatId}` },
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
          await bot!.answerCallbackQuery(query.id, { text: "Force Sub tidak aktif.", show_alert: true });
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
          await bot!.answerCallbackQuery(query.id, { text: "Terverifikasi! Kamu sudah subscribe ke semua channel. Silakan kirim pesan.", show_alert: true });
          try { await bot!.deleteMessage(chatId, msgId); } catch {}
        } else {
          await bot!.answerCallbackQuery(query.id, { text: "Kamu belum subscribe ke semua channel yang diwajibkan.", show_alert: true });
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
          `<b>\u2753 Bantuan Bot Moderator</b>\n\nPilih kategori perintah di bawah:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildHelpMainKeyboard() } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "help_umum") {
        await bot!.editMessageText(
          `<b>\uD83D\uDCD6 Perintah Umum</b>\n\n` +
          `<b>/start</b> - Menu utama bot\n` +
          `<b>/help</b> - Tampilkan bantuan ini\n` +
          `<b>/menu</b> - Menu pengaturan grup (Admin)\n` +
          `<b>/rules</b> - Lihat aturan grup\n` +
          `<b>/setgroup</b> - Daftarkan grup ke bot\n\n` +
          `<i>Semua perintah tersedia di grup maupun PM.</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [
            [{ text: "\uD83D\uDEE1\uFE0F Moderasi", callback_data: `help_moderasi` }, { text: "\u2699\uFE0F Pengaturan", callback_data: `help_pengaturan` }],
            [{ text: "\u2B05\uFE0F Kembali", callback_data: `help_main` }],
          ] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "help_moderasi") {
        await bot!.editMessageText(
          `<b>\uD83D\uDEE1\uFE0F Perintah Moderasi</b>\n<i>(Khusus Admin, balas pesan pengguna)</i>\n\n` +
          `<b>/warn</b> [alasan] - Beri peringatan\n` +
          `<b>/unwarn</b> - Hapus semua peringatan\n` +
          `<b>/warnings</b> - Cek jumlah peringatan\n` +
          `<b>/ban</b> - Banned pengguna\n` +
          `<b>/unban</b> - Buka banned\n` +
          `<b>/kick</b> - Tendang pengguna\n` +
          `<b>/mute</b> [menit] - Bisukan pengguna\n` +
          `<b>/unmute</b> - Buka bisukan\n` +
          `<b>/del</b> - Hapus pesan\n` +
          `<b>/purge</b> - Hapus banyak pesan\n` +
          `<b>/pin</b> - Sematkan pesan\n` +
          `<b>/unpin</b> - Lepas sematan\n` +
          `<b>/promote</b> - Jadikan admin\n` +
          `<b>/demote</b> - Cabut admin\n` +
          `<b>/lock</b> - Kunci chat\n` +
          `<b>/unlock</b> - Buka kunci chat\n` +
          `<b>/slow</b> [detik] - Mode lambat\n` +
          `<b>/setTitle</b> [judul] - Ubah judul grup`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [
            [{ text: "\uD83D\uDCD6 Umum", callback_data: `help_umum` }, { text: "\u2699\uFE0F Pengaturan", callback_data: `help_pengaturan` }],
            [{ text: "\u2B05\uFE0F Kembali", callback_data: `help_main` }],
          ] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "help_pengaturan") {
        await bot!.editMessageText(
          `<b>\u2699\uFE0F Perintah Pengaturan</b>\n<i>(Khusus Admin)</i>\n\n` +
          `<b>/menu</b> - Menu pengaturan lengkap (tombol)\n` +
          `<b>/settings</b> - Lihat pengaturan saat ini\n` +
          `<b>/stats</b> - Lihat statistik grup\n` +
          `<b>/setwelcome</b> [pesan] - Atur sambutan\n` +
          `<b>/setforcesub</b> [username] - Tambah channel wajib\n` +
          `<b>/delforcesub</b> [username] - Hapus channel wajib\n` +
          `<b>/addword</b> [kata] - Tambah kata terlarang\n` +
          `<b>/delword</b> [kata] - Hapus kata terlarang\n\n` +
          `<i>Gunakan {user} untuk nama pengguna, {group} untuk nama grup di pesan sambutan.</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [
            [{ text: "\uD83D\uDCD6 Umum", callback_data: `help_umum` }, { text: "\uD83D\uDEE1\uFE0F Moderasi", callback_data: `help_moderasi` }],
            [{ text: "\u2B05\uFE0F Kembali", callback_data: `help_main` }],
          ] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "help_pemilik") {
        await bot!.editMessageText(
          `<b>\uD83D\uDC51 Perintah Pemilik Bot</b>\n\n` +
          `<b>/owner</b> - Panel pemilik bot (tombol)\n` +
          `<b>/broadcast</b> [pesan] - Kirim ke semua pengguna\n\n` +
          `<b>Keterangan:</b>\n` +
          `- Pemilik bot memiliki akses penuh tanpa batasan\n` +
          `- Pemilik bot dikecualikan dari semua filter\n` +
          `- Admin grup dikecualikan dari filter grup`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [
            [{ text: "\uD83D\uDCD6 Umum", callback_data: `help_umum` }, { text: "\uD83D\uDEE1\uFE0F Moderasi", callback_data: `help_moderasi` }],
            [{ text: "\u2B05\uFE0F Kembali", callback_data: `help_main` }],
          ] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "start_owner") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const text = await buildOwnerPanelText(query.from);
        await bot!.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: "HTML",
          reply_markup: { inline_keyboard: buildOwnerMenuKeyboard() }
        });
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
          `<b>Wajib Sub</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTambah channel: <code>/setforcesub username</code> di grup`,
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
          forceJoinEnabled: "Wajib Sub", aiModeratorEnabled: "AI Moderator",
        };
        await bot!.answerCallbackQuery(query.id, { text: `${labelMap[field]} ${!currentVal ? "diaktifkan" : "dinonaktifkan"}.` });

        const group = await storage.getGroup(groupId);
        if (field === "forceJoinEnabled") {
          await bot!.editMessageText(
            `<b>Wajib Sub</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTambah channel: <code>/setforcesub username</code> di grup`,
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
          `<b>Wajib Sub</b>\n<i>${escapeHtml(group?.title || "Grup")}</i>\n\nTambah channel: <code>/setforcesub username</code> di grup`,
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
          `<b>Wajib Sub</b>\n\nTambah: <code>/setforcesub username</code>\nHapus: <code>/delforcesub username</code>`,
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
          forceJoinEnabled: "Wajib Sub", aiModeratorEnabled: "AI Moderator",
        };
        await bot!.answerCallbackQuery(query.id, { text: `${labelMap[field]} ${!currentVal ? "diaktifkan" : "dinonaktifkan"}.` });

        if (field === "forceJoinEnabled") {
          await bot!.editMessageText(
            `<b>Wajib Sub</b>\n\nTambah: <code>/setforcesub username</code>\nHapus: <code>/delforcesub username</code>`,
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
        await bot!.answerCallbackQuery(query.id, { text: "Kirim perintah:\n/setforcesub username\n\nContoh: /setforcesub mychannel", show_alert: true });
        return;
      }

      // Add channel prompt (PM)
      if (data.startsWith("pmaddch_")) {
        await bot!.answerCallbackQuery(query.id, { text: "Kirim di grup:\n/setforcesub username\n\nContoh: /setforcesub mychannel", show_alert: true });
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
          `<b>Wajib Sub</b>\n\nTambah: <code>/setforcesub username</code>\nHapus: <code>/delforcesub username</code>`,
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
        const allGroups = await storage.getGroups();

        let totalMessages = 0, totalDeleted = 0, totalWarned = 0, totalBanned = 0;
        let totalKicked = 0, totalMuted = 0, totalSpam = 0, totalForceSub = 0;

        allStats.forEach(s => {
          totalMessages += s.messagesProcessed ?? 0;
          totalDeleted += s.messagesDeleted ?? 0;
          totalWarned += s.usersWarned ?? 0;
          totalBanned += s.usersBanned ?? 0;
          totalKicked += s.usersKicked ?? 0;
          totalMuted += s.usersMuted ?? 0;
          totalSpam += s.spamBlocked ?? 0;
          totalForceSub += s.forceJoinBlocked ?? 0;
        });

        const activeGroups = allGroups.filter(g => g.isActive).length;

        const text = `<b>Statistik Global Bot</b>

<b>Ringkasan:</b>
Total Grup: <b>${allGroups.length}</b>
Grup Aktif: <b>${activeGroups}</b>

<b>Moderasi:</b>
Pesan Diproses: <b>${totalMessages}</b>
Pesan Dihapus: <b>${totalDeleted}</b>
Pengguna Diperingatkan: <b>${totalWarned}</b>
Pengguna Dibanned: <b>${totalBanned}</b>
Pengguna Ditendang: <b>${totalKicked}</b>
Pengguna Dibisukan: <b>${totalMuted}</b>

<b>Filter:</b>
Spam Diblokir: <b>${totalSpam}</b>
Force Sub Diblokir: <b>${totalForceSub}</b>`;

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
            const actionLabel: Record<string, string> = { warn: "Peringatan", ban: "Banned", kick: "Tendang", mute: "Bisukan", delete: "Hapus", spam_blocked: "Spam", link_blocked: "Link", word_filtered: "Filter Kata", flood_blocked: "Flood", force_join: "Wajib Sub", ai_moderated: "AI Moderasi" };
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

      if (data === "owner_broadcast_menu") {
        if (!isBotOwner(query.from.id)) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true });
          return;
        }

        const userCount = await storage.getBotUserCount();

        await bot!.editMessageText(
          `<b>\uD83D\uDCE2 Broadcast Pesan</b>\n\n` +
          `\uD83D\uDCE8 Target: <b>${userCount}</b> pengguna yang pernah /start bot\n\n` +
          `<b>Cara Broadcast:</b>\n` +
          `1. <code>/broadcast pesan anda</code>\n` +
          `2. Reply media/pesan + <code>/broadcast</code>\n` +
          `3. Reply media + <code>/broadcast caption baru</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `<code>/broadcast Halo {first}! Ada update baru.</code>\n\n` +

          `<b>\uD83D\uDCF7 Media yang Didukung (via Reply):</b>\n` +
          `Foto, Video, GIF/Animasi, Dokumen, Audio, Sticker, Voice, Video Note\n\n` +

          `<b>\u2728 Variabel Isian (Fillings):</b>\n` +
          `\u2022 <code>{first}</code> - Nama depan\n` +
          `\u2022 <code>{last}</code> - Nama belakang\n` +
          `\u2022 <code>{fullname}</code> - Nama lengkap\n` +
          `\u2022 <code>{username}</code> - Username/@mention\n` +
          `\u2022 <code>{mention}</code> - Mention nama depan\n` +
          `\u2022 <code>{id}</code> - ID pengguna\n` +
          `\u2022 <code>{chatname}</code> - Nama chat\n` +
          `\u2022 <code>{protect}</code> - Lindungi forward\n` +
          `\u2022 <code>{preview}</code> - Preview link\n` +
          `\u2022 <code>{nonotif}</code> - Tanpa notifikasi\n\n` +

          `<b>\uD83C\uDFA8 Format Markdown:</b>\n` +
          `\u2022 <code>\`kode\`</code> \u2192 <code>kode</code>\n` +
          `\u2022 <code>*tebal*</code> \u2192 <b>tebal</b>\n` +
          `\u2022 <code>_miring_</code> \u2192 <i>miring</i>\n` +
          `\u2022 <code>__garis bawah__</code> \u2192 <u>garis bawah</u>\n` +
          `\u2022 <code>~coret~</code> \u2192 <s>coret</s>\n` +
          `\u2022 <code>||spoiler||</code> \u2192 spoiler\n` +
          `\u2022 <code>\`\`\`blok kode\`\`\`</code> \u2192 preformat\n` +
          `\u2022 <code>[teks](url)</code> \u2192 hyperlink\n\n` +

          `<b>\uD83D\uDD18 Tombol URL:</b>\n` +
          `<code>[Tombol](buttonurl://url)</code>\n` +
          `<code>[Tombol 2](buttonurl://url:same)</code> (sebaris)\n\n` +

          `<i>Dikirim ke semua pengguna yang pernah /start bot.</i>`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "Kembali", callback_data: `owner_back` }],
              ],
            },
          }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Jadwal Donghua callback handlers
      if (data === "jd_back") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const text = await buildOwnerPanelText(query.from);
        await bot!.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: buildOwnerMenuKeyboard() } });
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_tambah") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        ownerWaitingState.set(query.from.id, { type: "jd_tambah" });
        await bot!.editMessageText(
          `<b>\uD83D\uDCDD TAMBAH JADWAL DONGHUA</b>\n\n` +
          `<b>Format Harian (tanpa link):</b>\n<code>Judul Anime|Hari</code>\nContoh: <code>Purple River Season 2|Senin</code>\n\n` +
          `<b>Format Harian (dengan link):</b>\n<code>Judul Anime|Hari|Link</code>\nContoh: <code>Battle Through the Heavens|Selasa|https://link.com</code>\n\n` +
          `<b>Format Upcoming (3 field):</b>\n<code>Judul|Hari|Tanggal</code>\nContoh: <code>Soul Land 2|Jumat|20 Januari 2025</code>\n\n` +
          `<b>Format Upcoming (4 field - link):</b>\n<code>Judul|Hari|Tanggal|Link</code>\n\n` +
          `<b>Format Upcoming (4 field - season):</b>\n<code>Judul|Hari|Tanggal|Season</code>\n\n` +
          `<b>Format Upcoming Lengkap (5 field):</b>\n<code>Judul|Hari|Tanggal|Link|Season</code>\n\n` +
          `<b>Hari yang valid:</b> Senin, Selasa, Rabu, Kamis, Jumat, Sabtu, Minggu\n\n` +
          `<i>\uD83D\uDCA1 Kirim data jadwal sekarang di PM ini!</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_hapus") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const keyboard = generateDeleteKeyboard(1);
        await bot!.editMessageText(
          `<b>\u274C HAPUS JADWAL DONGHUA</b>\n\nKlik tombol di bawah untuk menghapus jadwal:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_lihat") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const jadwalText = formatJadwalLengkap();
        await bot!.editMessageText(
          `<b>\uD83D\uDCCB LIHAT SEMUA JADWAL</b>\n\n${jadwalText}`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_preview") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const previewText = formatJadwalHariIni();
        await bot!.editMessageText(
          `<b>\uD83D\uDC41 PREVIEW JADWAL HARI INI</b>\n\n${previewText}`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "Kirim Sekarang", callback_data: "jd_send_now" }], [{ text: "Kembali", callback_data: "jd_back" }]] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_send_now") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        if (jadwalData.channels.length === 0) {
          await bot!.answerCallbackQuery(query.id, { text: "Belum ada channel/group terdaftar!", show_alert: true });
          return;
        }
        if (jadwalData.telegraph_token) await updateTelegraph();
        const message = formatJadwalHariIni();
        for (let i = 0; i < jadwalData.channels.length; i++) {
          setTimeout(async () => {
            try {
              await sendJadwalWithMedia(jadwalData.channels[i], message);
            } catch (err) { console.error(`Send now to ${jadwalData.channels[i]} failed:`, err); }
          }, i * 60000);
        }
        await bot!.editMessageText(
          `\u2705 <b>Jadwal Berhasil Dikirim Bergiliran!</b>\n\n` +
          `\uD83D\uDCFA Target: ${jadwalData.channels.length} channel/group\n` +
          `\u23F0 Interval: 1 menit per channel/group\n\n` +
          jadwalData.channels.map((ch, i) => `  ${i + 1}. <code>${ch}</code> \u2192 +${i} menit`).join("\n") +
          `\n\n<i>\uD83D\uDCA1 Posting sedang berjalan bergiliran!</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_manage_channels") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        let channelText = `<b>\uD83D\uDCFA KELOLA CHANNEL/GROUP</b>\n\n`;
        const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
        if (jadwalData.channels.length === 0) {
          channelText += `\u274C Belum ada channel/group terdaftar\n\n`;
        } else {
          channelText += `<b>Channel/Group Terdaftar:</b>\n`;
          jadwalData.channels.forEach((ch, i) => {
            channelText += `  ${i + 1}. <code>${ch}</code>\n`;
            keyboard.push([{ text: `\u274C Hapus ${ch}`, callback_data: `jd_dc_${i}` }]);
          });
          channelText += `\n`;
        }
        channelText += `<b>\uD83D\uDD04 Urutan Auto Posting Bergiliran:</b>\n`;
        if (jadwalData.channels.length > 0) {
          jadwalData.channels.forEach((_, i) => {
            channelText += `  Channel/Group ${i + 1} \u2192 +${i} menit\n`;
          });
        } else {
          channelText += `  Belum ada channel/group\n`;
        }
        keyboard.push([{ text: "\u2795 Tambah Channel/Group", callback_data: "jd_add_channel" }]);
        keyboard.push([{ text: "Kembali", callback_data: "jd_back" }]);
        await bot!.editMessageText(channelText, { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_add_channel") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        ownerWaitingState.set(query.from.id, { type: "jd_add_channel" });
        await bot!.editMessageText(
          `<b>\u2795 TAMBAH CHANNEL/GROUP</b>\n\n` +
          `Kirim <b>Chat ID</b> channel/group di PM ini\n\n` +
          `<b>Cara mendapatkan Chat ID:</b>\n` +
          `1. Add bot ke channel/group\n` +
          `2. Jadikan bot sebagai admin\n` +
          `3. Forward pesan dari channel ke @userinfobot\n` +
          `4. Atau gunakan @RawDataBot\n\n` +
          `<b>Format:</b> <code>-1001234567890</code>\n\n` +
          `<b>Bot support:</b> Channel DAN Group!\n\n` +
          `<i>\uD83D\uDCA1 Kirim Chat ID sekarang!</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data.startsWith("jd_dc_")) {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const idx = parseInt(data.replace("jd_dc_", ""), 10);
        if (idx >= 0 && idx < jadwalData.channels.length) {
          const removed = jadwalData.channels.splice(idx, 1)[0];
          await saveJadwalData();
          await bot!.answerCallbackQuery(query.id, { text: `Channel ${removed} dihapus!`, show_alert: true });
          let channelText = `<b>\uD83D\uDCFA KELOLA CHANNEL/GROUP</b>\n\n`;
          const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
          if (jadwalData.channels.length === 0) {
            channelText += `\u274C Belum ada channel/group terdaftar\n\n`;
          } else {
            channelText += `<b>Channel/Group Terdaftar:</b>\n`;
            jadwalData.channels.forEach((ch, i) => {
              channelText += `  ${i + 1}. <code>${ch}</code>\n`;
              keyboard.push([{ text: `\u274C Hapus ${ch}`, callback_data: `jd_dc_${i}` }]);
            });
          }
          keyboard.push([{ text: "\u2795 Tambah Channel/Group", callback_data: "jd_add_channel" }]);
          keyboard.push([{ text: "Kembali", callback_data: "jd_back" }]);
          await bot!.editMessageText(channelText, { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
        } else {
          await bot!.answerCallbackQuery(query.id, { text: "Channel tidak ditemukan!", show_alert: true });
        }
        return;
      }

      if (data === "jd_set_time") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        ownerWaitingState.set(query.from.id, { type: "jd_set_time" });
        await bot!.editMessageText(
          `<b>\u23F0 SET JAM AUTO POST</b>\n\n` +
          `Jam saat ini: <b>${jadwalData.post_time} WIB</b>\n\n` +
          `Kirim jam baru dalam format <b>HH:MM</b>\n\n` +
          `Contoh:\n` +
          `<code>06:00</code> - Pagi hari\n` +
          `<code>12:00</code> - Siang hari\n` +
          `<code>18:00</code> - Sore hari\n` +
          `<code>21:00</code> - Malam hari\n\n` +
          `<i>\uD83C\uDF0F Menggunakan timezone WIB (UTC+7)</i>\n\n` +
          `<i>\uD83D\uDCA1 Kirim jam baru sekarang!</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_toggle_auto") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        jadwalData.auto_post_enabled = !jadwalData.auto_post_enabled;
        await saveJadwalData();
        const status = jadwalData.auto_post_enabled ? "\uD83D\uDFE2 AKTIF" : "\uD83D\uDD34 NONAKTIF";
        await bot!.editMessageText(
          `<b>\uD83E\uDD16 AUTO POST TOGGLED!</b>\n\n` +
          `Status: <b>${status}</b>\n` +
          `Jam: <b>${jadwalData.post_time} WIB</b>\n` +
          `Channel/Group: <b>${jadwalData.channels.length}</b>\n\n` +
          (jadwalData.auto_post_enabled
            ? `<i>\uD83D\uDCA1 Bot akan otomatis posting bergiliran setiap hari!</i>`
            : `<i>\uD83D\uDCA1 Auto posting bergiliran dinonaktifkan!</i>`),
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_setup_telegraph") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
        let tgText = `<b>\uD83D\uDCF0 SETUP TELEGRAPH</b>\n\n`;
        if (jadwalData.telegraph_token) {
          tgText += `Status: <b>\uD83D\uDFE2 AKTIF</b>\n`;
          tgText += `Token: <code>${jadwalData.telegraph_token.substring(0, 10)}...</code>\n`;
          if (jadwalData.telegraph_url) {
            tgText += `URL: <a href="${jadwalData.telegraph_url}">Buka Telegraph</a>\n`;
          }
          tgText += `\n<i>\uD83D\uDCA1 Telegraph sudah aktif dan otomatis update saat jadwal berubah!</i>`;
          keyboard.push([{ text: "\uD83D\uDD04 Update Telegraph", callback_data: "jd_update_telegraph" }]);
        } else {
          tgText += `Status: <b>\uD83D\uDD34 BELUM DISET</b>\n\n`;
          tgText += `Telegraph digunakan untuk halaman jadwal lengkap semua hari.\n\n`;
          tgText += `<i>\uD83D\uDCA1 Klik tombol di bawah untuk membuat akun Telegraph!</i>`;
          keyboard.push([{ text: "\uD83D\uDD11 Buat Akun Telegraph", callback_data: "jd_create_telegraph" }]);
        }
        keyboard.push([{ text: "Kembali", callback_data: "jd_back" }]);
        await bot!.editMessageText(tgText, { chat_id: chatId, message_id: msgId, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_create_telegraph") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const token = await createTelegraphAccount();
        if (token) {
          jadwalData.telegraph_token = token;
          await saveJadwalData();
          const updated = await updateTelegraph();
          await bot!.editMessageText(
            `\u2705 <b>Akun Telegraph Berhasil Dibuat!</b>\n\n` +
            `\uD83D\uDD11 Token: <code>${token.substring(0, 10)}...</code>\n` +
            (jadwalData.telegraph_url ? `\uD83D\uDD17 URL: <a href="${jadwalData.telegraph_url}">Buka Telegraph</a>\n` : "") +
            `\uD83D\uDCF0 Page: ${updated ? "Berhasil dibuat" : "Gagal dibuat"}\n\n` +
            `<i>\uD83D\uDCA1 Telegraph akan otomatis update saat jadwal berubah!</i>`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
          );
        } else {
          await bot!.editMessageText(
            `\u274C <b>Gagal Membuat Akun Telegraph!</b>\n\nSilakan coba lagi nanti.`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
          );
        }
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_update_telegraph") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const updated = await updateTelegraph();
        if (updated) {
          await bot!.editMessageText(
            `\u2705 <b>Telegraph Berhasil Diupdate!</b>\n\n` +
            (jadwalData.telegraph_url ? `\uD83D\uDD17 URL: <a href="${jadwalData.telegraph_url}">Buka Telegraph</a>\n\n` : "") +
            `<i>\uD83D\uDCA1 Halaman telegraph sudah menampilkan jadwal terbaru!</i>`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
          );
        } else {
          await bot!.editMessageText(
            `\u274C <b>Gagal Update Telegraph!</b>\n\nPastikan token masih valid.`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
          );
        }
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_set_rules") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        ownerWaitingState.set(query.from.id, { type: "jd_set_rules" });
        await bot!.editMessageText(
          `<b>\uD83D\uDCDC SET RULES</b>\n\n` +
          `Kirim teks rules di PM ini.\n\n` +
          `<b>HTML Tags yang didukung:</b>\n` +
          `\u2022 <code>&lt;b&gt;bold&lt;/b&gt;</code>\n` +
          `\u2022 <code>&lt;i&gt;italic&lt;/i&gt;</code>\n` +
          `\u2022 <code>&lt;u&gt;underline&lt;/u&gt;</code>\n` +
          `\u2022 <code>&lt;a href="url"&gt;link&lt;/a&gt;</code>\n` +
          `\u2022 <code>&lt;code&gt;code&lt;/code&gt;</code>\n\n` +
          `<i>\uD83D\uDCA1 Kirim teks rules sekarang!</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_preview_rules") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const rulesMsg = formatRulesMessage();
        await bot!.editMessageText(
          `<b>\uD83D\uDCDC PREVIEW RULES</b>\n\n${rulesMsg}`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_back" }]] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data === "jd_set_media") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        let mediaText = `<b>\uD83C\uDFA8 SET MEDIA JADWAL</b>\n\n`;
        mediaText += `Pilih hari untuk set/hapus media:\n\n`;
        const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
        for (const hari of VALID_DAYS) {
          const media = jadwalData.media_jadwal[hari];
          const status = media && media.url ? `\uD83D\uDFE2 ${media.type}` : "\uD83D\uDD34 Belum diset";
          mediaText += `${hari}: ${status}\n`;
          keyboard.push([
            { text: `\uD83D\uDCE4 ${hari}`, callback_data: `jd_mu_${hari}` },
            { text: `\u274C ${hari}`, callback_data: `jd_md_${hari}` },
          ]);
        }
        keyboard.push([{ text: "Kembali", callback_data: "jd_back" }]);
        await bot!.editMessageText(mediaText, { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data.startsWith("jd_mu_")) {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const hari = data.replace("jd_mu_", "");
        if (!VALID_DAYS.includes(hari)) { await bot!.answerCallbackQuery(query.id, { text: "Hari tidak valid!", show_alert: true }); return; }
        ownerWaitingState.set(query.from.id, { type: "jd_media_url", extra: hari });
        await bot!.editMessageText(
          `<b>\uD83D\uDCE4 UPLOAD MEDIA ${hari.toUpperCase()}</b>\n\n` +
          `<b>Cara set media:</b>\n` +
          `1. Kirim <b>foto/video/GIF</b> langsung\n` +
          `2. Atau kirim <b>URL media</b>\n\n` +
          `<b>Format yang didukung:</b>\n` +
          `\u2022 Foto: JPG, PNG, WEBP\n` +
          `\u2022 Video: MP4, MOV, AVI\n` +
          `\u2022 GIF: Animated GIF\n\n` +
          `<b>Contoh URL:</b>\n` +
          `<code>https://example.com/jadwal.jpg</code>\n\n` +
          `<i>\uD83D\uDCA1 Kirim media atau URL sekarang!</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Kembali", callback_data: "jd_set_media" }]] } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      if (data.startsWith("jd_md_")) {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const hari = data.replace("jd_md_", "");
        if (!VALID_DAYS.includes(hari)) { await bot!.answerCallbackQuery(query.id, { text: "Hari tidak valid!", show_alert: true }); return; }
        jadwalData.media_jadwal[hari] = { type: "", url: "" };
        await saveJadwalData();
        await bot!.answerCallbackQuery(query.id, { text: `Media ${hari} dihapus!`, show_alert: true });
        let mediaText = `<b>\uD83C\uDFA8 SET MEDIA JADWAL</b>\n\nPilih hari untuk set/hapus media:\n\n`;
        const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
        for (const h of VALID_DAYS) {
          const media = jadwalData.media_jadwal[h];
          const status = media && media.url ? `\uD83D\uDFE2 ${media.type}` : "\uD83D\uDD34 Belum diset";
          mediaText += `${h}: ${status}\n`;
          keyboard.push([
            { text: `\uD83D\uDCE4 ${h}`, callback_data: `jd_mu_${h}` },
            { text: `\u274C ${h}`, callback_data: `jd_md_${h}` },
          ]);
        }
        keyboard.push([{ text: "Kembali", callback_data: "jd_back" }]);
        await bot!.editMessageText(mediaText, { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
        return;
      }

      if (data.startsWith("jd_dh_")) {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const parts = data.replace("jd_dh_", "").split("_");
        const hari = parts[0];
        const hash = parseInt(parts[1], 10);
        if (!jadwalData.harian[hari]) { await bot!.answerCallbackQuery(query.id, { text: "Hari tidak ditemukan!", show_alert: true }); return; }
        const idx = jadwalData.harian[hari].findIndex((anime) => {
          const title = typeof anime === "object" ? anime.judul : anime;
          return Math.abs(hashCode(title)) % 1000 === hash;
        });
        if (idx === -1) { await bot!.answerCallbackQuery(query.id, { text: "Jadwal tidak ditemukan!", show_alert: true }); return; }
        const removed = jadwalData.harian[hari].splice(idx, 1)[0];
        await saveJadwalData();
        if (jadwalData.telegraph_token) await updateTelegraph();
        const removedTitle = typeof removed === "object" ? removed.judul : removed;
        await bot!.answerCallbackQuery(query.id, { text: `${removedTitle} dihapus dari ${hari}!`, show_alert: true });
        const keyboard = generateDeleteKeyboard(1);
        await bot!.editMessageText(
          `<b>\u274C HAPUS JADWAL DONGHUA</b>\n\n\u2705 <b>${removedTitle}</b> berhasil dihapus dari <b>${hari}</b>!\n\nKlik tombol di bawah untuk menghapus jadwal lain:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } }
        );
        return;
      }

      if (data.startsWith("jd_du_")) {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const idx = parseInt(data.replace("jd_du_", ""), 10);
        if (idx >= 0 && idx < jadwalData.upcoming.length) {
          const removed = jadwalData.upcoming.splice(idx, 1)[0];
          await saveJadwalData();
          await bot!.answerCallbackQuery(query.id, { text: `${removed.judul} dihapus dari upcoming!`, show_alert: true });
          const keyboard = generateDeleteKeyboard(1);
          await bot!.editMessageText(
            `<b>\u274C HAPUS JADWAL DONGHUA</b>\n\n\u2705 <b>${removed.judul}</b> berhasil dihapus dari upcoming!\n\nKlik tombol di bawah untuk menghapus jadwal lain:`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } }
          );
        } else {
          await bot!.answerCallbackQuery(query.id, { text: "Jadwal tidak ditemukan!", show_alert: true });
        }
        return;
      }

      if (data.startsWith("jd_dp_")) {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const page = parseInt(data.replace("jd_dp_", ""), 10);
        const keyboard = generateDeleteKeyboard(page);
        await bot!.editMessageText(
          `<b>\u274C HAPUS JADWAL DONGHUA</b>\n\nKlik tombol di bawah untuk menghapus jadwal:`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Owner page navigation
      if (data === "owner_page_1" || data === "owner_page_2" || data === "owner_page_3") {
        if (!isBotOwner(query.from.id)) { await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true }); return; }
        const page = parseInt(data.replace("owner_page_", ""));
        const text = await buildOwnerPanelText(query.from);
        await bot!.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: "HTML",
          reply_markup: { inline_keyboard: buildOwnerMenuKeyboard(page) },
        });
        await bot!.answerCallbackQuery(query.id, { text: `Halaman ${page}/3`, show_alert: false });
        return;
      }

      // Owner refresh panel
      if (data === "owner_refresh") {
        if (!isBotOwner(query.from.id)) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true });
          return;
        }

        const text = await buildOwnerPanelText(query.from);
        await bot!.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buildOwnerMenuKeyboard() },
        });
        await bot!.answerCallbackQuery(query.id, { text: "Panel diperbarui!", show_alert: false });
        return;
      }

      // Owner back to panel
      if (data === "owner_back") {
        if (!isBotOwner(query.from.id)) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya pemilik bot.", show_alert: true });
          return;
        }

        const text = await buildOwnerPanelText(query.from);
        await bot!.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buildOwnerMenuKeyboard() },
        });
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
      if (!msg.from || !msg.chat) return;

      if (msg.chat.type === "private" && isBotOwner(msg.from.id)) {
        if (msg.text?.startsWith("/")) return;
        const waiting = ownerWaitingState.get(msg.from.id);
        if (waiting) {
          if (msg.photo || msg.video || msg.animation) {
            await handleOwnerMediaInput(msg);
            return;
          }
          if (msg.text) {
            await handleOwnerTextInput(msg, waiting);
            return;
          }
        }
        return;
      }

      if (msg.chat.type === "private") return;
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
