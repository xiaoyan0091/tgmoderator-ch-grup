import TelegramBot from "node-telegram-bot-api";
import { storage } from "./storage";
import { pushSchema } from "./db";

const spamTracker = new Map<string, number[]>();
const floodTracker = new Map<string, number[]>();

let bot: TelegramBot | null = null;
let BOT_OWNER_ID: number | null = null;

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
  return BOT_OWNER_ID !== null && userId === BOT_OWNER_ID;
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

function buildMainMenuKeyboard(chatId: string): TelegramBot.InlineKeyboardButton[][] {
  return [
    [
      { text: "Pengaturan Grup", callback_data: `menu_settings_${chatId}` },
      { text: "Moderasi", callback_data: `menu_moderation_${chatId}` },
    ],
    [
      { text: "Wajib Gabung", callback_data: `menu_forcejoin_${chatId}` },
      { text: "Filter & Proteksi", callback_data: `menu_filters_${chatId}` },
    ],
    [
      { text: "Statistik", callback_data: `menu_stats_${chatId}` },
      { text: "Peringatan", callback_data: `menu_warnings_${chatId}` },
    ],
    [
      { text: "Tutup Menu", callback_data: `menu_close` },
    ],
  ];
}

function buildSettingsKeyboard(chatId: string, settings: any): TelegramBot.InlineKeyboardButton[][] {
  return [
    [
      {
        text: `Pesan Sambutan: ${settings.welcomeEnabled ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_welcomeEnabled_${chatId}`,
      },
    ],
    [
      {
        text: `Anti-Spam: ${settings.antiSpamEnabled ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_antiSpamEnabled_${chatId}`,
      },
    ],
    [
      {
        text: `Anti-Link: ${settings.antiLinkEnabled ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_antiLinkEnabled_${chatId}`,
      },
    ],
    [
      {
        text: `Filter Kata: ${settings.wordFilterEnabled ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_wordFilterEnabled_${chatId}`,
      },
    ],
    [
      {
        text: `Anti-Flood: ${settings.antiFloodEnabled ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_antiFloodEnabled_${chatId}`,
      },
    ],
    [
      {
        text: `Bisukan Member Baru: ${settings.muteNewMembers ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_muteNewMembers_${chatId}`,
      },
    ],
    [
      { text: "Kembali ke Menu Utama", callback_data: `menu_main_${chatId}` },
    ],
  ];
}

function buildForceJoinKeyboard(chatId: string, settings: any): TelegramBot.InlineKeyboardButton[][] {
  const kb: TelegramBot.InlineKeyboardButton[][] = [
    [
      {
        text: `Wajib Gabung: ${settings.forceJoinEnabled ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_forceJoinEnabled_${chatId}`,
      },
    ],
  ];

  const channels = settings.forceJoinChannels || [];
  if (channels.length > 0) {
    channels.forEach((ch: string) => {
      kb.push([
        { text: `@${ch}`, callback_data: `noop` },
        { text: "Hapus", callback_data: `removechannel_${chatId}_${ch}` },
      ]);
    });
  }

  kb.push([
    { text: "Tambah Channel", callback_data: `addchannel_${chatId}` },
  ]);
  kb.push([
    { text: "Kembali ke Menu Utama", callback_data: `menu_main_${chatId}` },
  ]);

  return kb;
}

function buildFiltersKeyboard(chatId: string, settings: any): TelegramBot.InlineKeyboardButton[][] {
  const bannedWords = settings.bannedWords || [];
  const kb: TelegramBot.InlineKeyboardButton[][] = [
    [
      {
        text: `Anti-Spam: ${settings.antiSpamEnabled ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_antiSpamEnabled_${chatId}`,
      },
    ],
    [
      {
        text: `Batas Spam: ${settings.antiSpamMaxMessages ?? 5} pesan/10 detik`,
        callback_data: `noop`,
      },
    ],
    [
      {
        text: `Anti-Link: ${settings.antiLinkEnabled ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_antiLinkEnabled_${chatId}`,
      },
    ],
    [
      {
        text: `Anti-Flood: ${settings.antiFloodEnabled ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_antiFloodEnabled_${chatId}`,
      },
    ],
    [
      {
        text: `Filter Kata: ${settings.wordFilterEnabled ? "Aktif" : "Nonaktif"}`,
        callback_data: `toggle_wordFilterEnabled_${chatId}`,
      },
    ],
  ];

  if (bannedWords.length > 0) {
    kb.push([{
      text: `Kata Terlarang: ${bannedWords.join(", ")}`,
      callback_data: `noop`,
    }]);
  }

  kb.push([
    { text: "Tambah Kata Terlarang", callback_data: `addword_${chatId}` },
  ]);

  if (bannedWords.length > 0) {
    kb.push([
      { text: "Hapus Semua Kata Terlarang", callback_data: `clearwords_${chatId}` },
    ]);
  }

  kb.push([
    { text: "Kembali ke Menu Utama", callback_data: `menu_main_${chatId}` },
  ]);

  return kb;
}

function buildWarningsKeyboard(chatId: string, settings: any): TelegramBot.InlineKeyboardButton[][] {
  return [
    [
      { text: `Batas Peringatan: ${settings.warnLimit ?? 3}`, callback_data: `noop` },
    ],
    [
      { text: "Batas: 3", callback_data: `setwarnlimit_${chatId}_3` },
      { text: "Batas: 5", callback_data: `setwarnlimit_${chatId}_5` },
      { text: "Batas: 7", callback_data: `setwarnlimit_${chatId}_7` },
    ],
    [
      { text: `Aksi: ${settings.warnAction === "ban" ? "Banned" : settings.warnAction === "kick" ? "Tendang" : "Bisukan"}`, callback_data: `noop` },
    ],
    [
      { text: "Bisukan", callback_data: `setwarnaction_${chatId}_mute` },
      { text: "Tendang", callback_data: `setwarnaction_${chatId}_kick` },
      { text: "Banned", callback_data: `setwarnaction_${chatId}_ban` },
    ],
    [
      { text: "Kembali ke Menu Utama", callback_data: `menu_main_${chatId}` },
    ],
  ];
}

function buildModerationKeyboard(chatId: string): TelegramBot.InlineKeyboardButton[][] {
  return [
    [
      { text: "Cara Moderasi", callback_data: `modhelp_${chatId}` },
    ],
    [
      { text: "Kembali ke Menu Utama", callback_data: `menu_main_${chatId}` },
    ],
  ];
}

function buildOwnerMenuKeyboard(): TelegramBot.InlineKeyboardButton[][] {
  return [
    [
      { text: "Daftar Semua Grup", callback_data: `owner_groups` },
      { text: "Statistik Global", callback_data: `owner_stats` },
    ],
    [
      { text: "Broadcast Pesan", callback_data: `owner_broadcast` },
    ],
    [
      { text: "Tutup", callback_data: `menu_close` },
    ],
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

  // /start - Perkenalan bot
  bot.onText(/\/start/, async (msg) => {
    try {
      if (msg.chat.type !== "private") {
        await bot!.sendMessage(
          msg.chat.id,
          "Halo! Saya adalah <b>Bot Moderator Grup</b>. Gunakan /menu untuk melihat pengaturan grup.\n\nGunakan /help untuk melihat semua perintah yang tersedia.",
          { parse_mode: "HTML" }
        );
        return;
      }

      const isOwner = msg.from && isBotOwner(msg.from.id);

      const text = `Halo! Saya adalah <b>Bot Moderator Grup</b>.

Tambahkan saya ke grup Telegram dan jadikan saya sebagai admin untuk mulai moderasi.

<b>Fitur Utama:</b>
- Wajib Gabung - Wajibkan anggota gabung ke channel
- Anti-Spam - Deteksi dan blokir pesan spam
- Anti-Link - Hapus pesan yang mengandung link
- Filter Kata - Blokir kata-kata terlarang
- Anti-Flood - Cegah banjir pesan
- Sistem Peringatan - Peringatan otomatis dengan aksi
- Bisukan Member Baru - Batasi member baru sementara
- Pesan Sambutan - Sambut member baru

Gunakan /help untuk melihat semua perintah.${isOwner ? "\nGunakan /owner untuk panel pemilik bot." : ""}`;

      await bot!.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /start:", err);
    }
  });

  // /help - Bantuan perintah
  bot.onText(/\/help/, async (msg) => {
    try {
      const helpText = `<b>Daftar Perintah Bot Moderator</b>

<b>Umum:</b>
/start - Perkenalan bot
/help - Tampilkan daftar perintah ini
/menu - Menu pengaturan grup (Admin)
/rules - Lihat aturan grup

<b>Moderasi (Khusus Admin):</b>
/warn - Beri peringatan (balas pesan pengguna)
/unwarn - Hapus semua peringatan (balas pesan)
/warnings - Cek jumlah peringatan (balas pesan)
/ban - Banned pengguna (balas pesan)
/unban - Buka banned pengguna (balas pesan)
/kick - Tendang pengguna (balas pesan)
/mute - Bisukan pengguna (balas pesan, opsional: durasi dalam menit)
/unmute - Buka bisukan pengguna (balas pesan)
/pin - Sematkan pesan (balas pesan)
/unpin - Lepas sematan pesan (balas pesan)
/del - Hapus pesan (balas pesan yang ingin dihapus)
/purge - Hapus banyak pesan (balas pesan pertama yang ingin dihapus)
/setTitle - Ubah judul grup (contoh: /setTitle Judul Baru)
/promote - Jadikan admin (balas pesan)
/demote - Cabut admin (balas pesan)
/lock - Kunci chat (hanya admin yang bisa kirim pesan)
/unlock - Buka kunci chat (semua bisa kirim pesan)
/slow - Mode lambat (contoh: /slow 30 untuk 30 detik)

<b>Pengaturan (Khusus Admin):</b>
/menu - Buka menu pengaturan lengkap dengan tombol
/settings - Lihat pengaturan grup saat ini
/stats - Lihat statistik grup
/setwelcome - Atur pesan sambutan (contoh: /setwelcome Halo {user}!)
/setforcejoin - Tambah channel wajib gabung (contoh: /setforcejoin channel_username)
/delforcejoin - Hapus channel wajib gabung (contoh: /delforcejoin channel_username)
/addword - Tambah kata terlarang (contoh: /addword kata1)
/delword - Hapus kata terlarang (contoh: /delword kata1)

<b>Pemilik Bot:</b>
/owner - Panel pemilik bot
/setowner - Jadikan diri sendiri pemilik bot (sekali pakai)
/broadcast - Kirim pesan ke semua grup

<b>Keterangan:</b>
- Admin dan Pemilik Grup dikecualikan dari semua filter
- {user} = nama pengguna, {group} = nama grup`;

      await bot!.sendMessage(msg.chat.id, helpText, { parse_mode: "HTML" });
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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

<b>Bisukan Member Baru:</b> ${settings.muteNewMembers ? "Aktif" : "Nonaktif"} (${settings.muteNewMembersDuration} detik)`;

      await bot!.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error handling /settings:", err);
    }
  });

  // /stats - Statistik grup
  bot.onText(/\/stats/, async (msg) => {
    try {
      if (!msg.from || msg.chat.type === "private") return;
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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
      if (!(await isAdmin(msg.chat.id, msg.from.id))) {
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

  // /setowner - Jadikan pemilik bot
  bot.onText(/\/setowner/, async (msg) => {
    try {
      if (!msg.from) return;

      if (BOT_OWNER_ID !== null) {
        await bot!.sendMessage(msg.chat.id, "Pemilik bot sudah ditetapkan. Perintah ini hanya bisa digunakan sekali.");
        return;
      }

      BOT_OWNER_ID = msg.from.id;
      await bot!.sendMessage(
        msg.chat.id,
        `${getUserMention(msg.from)} telah ditetapkan sebagai <b>Pemilik Bot</b>.\n\nGunakan /owner untuk membuka panel pemilik bot.`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      console.error("Error handling /setowner:", err);
    }
  });

  // /owner - Panel pemilik bot
  bot.onText(/\/owner/, async (msg) => {
    try {
      if (!msg.from) return;

      if (!isBotOwner(msg.from.id)) {
        await bot!.sendMessage(msg.chat.id, "Perintah ini hanya untuk pemilik bot.\nGunakan /setowner untuk menetapkan pemilik (sekali pakai).");
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

      // Main menu
      if (data.startsWith("menu_main_")) {
        const groupId = data.replace("menu_main_", "");
        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa menggunakan menu ini.", show_alert: true });
          return;
        }

        const chat = await bot!.getChat(chatId);
        await bot!.editMessageText(
          `<b>Menu Pengaturan Grup</b>\n<i>${escapeHtml(chat.title || "Grup")}</i>\n\nPilih menu di bawah untuk mengelola pengaturan grup:`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildMainMenuKeyboard(groupId) },
          }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Settings menu
      if (data.startsWith("menu_settings_")) {
        const groupId = data.replace("menu_settings_", "");
        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa menggunakan menu ini.", show_alert: true });
          return;
        }

        const settings = await storage.getSettings(groupId);
        if (!settings) {
          await bot!.answerCallbackQuery(query.id, { text: "Pengaturan tidak ditemukan.", show_alert: true });
          return;
        }

        await bot!.editMessageText(
          `<b>Pengaturan Grup</b>\n\nTekan tombol untuk mengaktifkan/menonaktifkan fitur:`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildSettingsKeyboard(groupId, settings) },
          }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Moderation menu
      if (data.startsWith("menu_moderation_")) {
        const groupId = data.replace("menu_moderation_", "");
        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa menggunakan menu ini.", show_alert: true });
          return;
        }

        await bot!.editMessageText(
          `<b>Menu Moderasi</b>\n\n<b>Perintah Moderasi (balas pesan pengguna):</b>\n/warn [alasan] - Beri peringatan\n/unwarn - Hapus semua peringatan\n/warnings - Cek peringatan\n/ban - Banned pengguna\n/unban - Buka banned\n/kick - Tendang pengguna\n/mute [menit] - Bisukan pengguna\n/unmute - Buka bisukan\n/del - Hapus pesan\n/purge - Hapus banyak pesan\n\n<b>Perintah Grup:</b>\n/pin - Sematkan pesan\n/unpin - Lepas sematan\n/setTitle [judul] - Ubah judul grup\n/promote - Jadikan admin (pemilik grup)\n/demote - Cabut admin (pemilik grup)\n/lock - Kunci chat\n/unlock - Buka kunci chat\n/slow [detik] - Mode lambat (0 untuk nonaktif)`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildModerationKeyboard(groupId) },
          }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Moderation help
      if (data.startsWith("modhelp_")) {
        await bot!.answerCallbackQuery(query.id, {
          text: "Untuk menggunakan perintah moderasi, balas pesan pengguna yang ingin dimoderasi, lalu ketik perintahnya.",
          show_alert: true,
        });
        return;
      }

      // Force join menu
      if (data.startsWith("menu_forcejoin_")) {
        const groupId = data.replace("menu_forcejoin_", "");
        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa menggunakan menu ini.", show_alert: true });
          return;
        }

        const settings = await storage.getSettings(groupId);
        if (!settings) {
          await bot!.answerCallbackQuery(query.id, { text: "Pengaturan tidak ditemukan.", show_alert: true });
          return;
        }

        const channels = settings.forceJoinChannels || [];

        await bot!.editMessageText(
          `<b>Pengaturan Wajib Gabung</b>\n\nFitur ini mewajibkan anggota untuk bergabung ke channel/grup tertentu sebelum bisa mengirim pesan.\n\n<b>Status:</b> ${settings.forceJoinEnabled ? "Aktif" : "Nonaktif"}\n<b>Channel Terdaftar:</b> ${channels.length > 0 ? channels.map((c: string) => `@${c}`).join(", ") : "Belum ada"}\n\n<b>Cara menambah channel:</b>\nGunakan perintah /setforcejoin username_channel\n<b>Cara menghapus channel:</b>\nGunakan perintah /delforcejoin username_channel`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildForceJoinKeyboard(groupId, settings) },
          }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Filters menu
      if (data.startsWith("menu_filters_")) {
        const groupId = data.replace("menu_filters_", "");
        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa menggunakan menu ini.", show_alert: true });
          return;
        }

        const settings = await storage.getSettings(groupId);
        if (!settings) {
          await bot!.answerCallbackQuery(query.id, { text: "Pengaturan tidak ditemukan.", show_alert: true });
          return;
        }

        await bot!.editMessageText(
          `<b>Filter & Proteksi</b>\n\nKelola filter otomatis untuk melindungi grup:\n\n<b>Cara menambah kata terlarang:</b>\nGunakan perintah /addword kata\n<b>Cara menghapus kata terlarang:</b>\nGunakan perintah /delword kata`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildFiltersKeyboard(groupId, settings) },
          }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Stats menu
      if (data.startsWith("menu_stats_")) {
        const groupId = data.replace("menu_stats_", "");
        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa menggunakan menu ini.", show_alert: true });
          return;
        }

        const stats = await storage.getStats(groupId);

        const text = stats
          ? `<b>Statistik Grup</b>\n\nPesan Diproses: <b>${stats.messagesProcessed}</b>\nPesan Dihapus: <b>${stats.messagesDeleted}</b>\nPengguna Diperingatkan: <b>${stats.usersWarned}</b>\nPengguna Dibanned: <b>${stats.usersBanned}</b>\nPengguna Ditendang: <b>${stats.usersKicked}</b>\nPengguna Dibisukan: <b>${stats.usersMuted}</b>\nSpam Diblokir: <b>${stats.spamBlocked}</b>\nWajib Gabung Diblokir: <b>${stats.forceJoinBlocked}</b>`
          : `<b>Statistik Grup</b>\n\nBelum ada statistik yang tersedia.`;

        await bot!.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Perbarui", callback_data: `menu_stats_${groupId}` }],
              [{ text: "Kembali ke Menu Utama", callback_data: `menu_main_${groupId}` }],
            ],
          },
        });
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Warnings menu
      if (data.startsWith("menu_warnings_")) {
        const groupId = data.replace("menu_warnings_", "");
        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa menggunakan menu ini.", show_alert: true });
          return;
        }

        const settings = await storage.getSettings(groupId);
        if (!settings) {
          await bot!.answerCallbackQuery(query.id, { text: "Pengaturan tidak ditemukan.", show_alert: true });
          return;
        }

        await bot!.editMessageText(
          `<b>Pengaturan Peringatan</b>\n\nAtur batas peringatan dan aksi yang dilakukan saat batas tercapai.\n\nPengguna akan di-<b>${settings.warnAction === "ban" ? "banned" : settings.warnAction === "kick" ? "tendang" : "bisukan"}</b> setelah menerima <b>${settings.warnLimit}</b> peringatan.`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildWarningsKeyboard(groupId, settings) },
          }
        );
        await bot!.answerCallbackQuery(query.id);
        return;
      }

      // Toggle settings
      if (data.startsWith("toggle_")) {
        const parts = data.replace("toggle_", "").split("_");
        const groupId = parts.pop()!;
        const field = parts.join("_");

        // Convert camelCase field names
        const fieldMap: Record<string, string> = {
          welcomeEnabled: "welcomeEnabled",
          antiSpamEnabled: "antiSpamEnabled",
          antiLinkEnabled: "antiLinkEnabled",
          wordFilterEnabled: "wordFilterEnabled",
          antiFloodEnabled: "antiFloodEnabled",
          muteNewMembers: "muteNewMembers",
          forceJoinEnabled: "forceJoinEnabled",
        };

        const dbField = fieldMap[field];
        if (!dbField) {
          await bot!.answerCallbackQuery(query.id, { text: "Field tidak dikenal.", show_alert: true });
          return;
        }

        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa mengubah pengaturan.", show_alert: true });
          return;
        }

        const settings = await storage.getSettings(groupId);
        if (!settings) {
          await bot!.answerCallbackQuery(query.id, { text: "Pengaturan tidak ditemukan.", show_alert: true });
          return;
        }

        const currentVal = (settings as any)[dbField];
        await storage.updateSettings(groupId, { [dbField]: !currentVal } as any);

        const updatedSettings = await storage.getSettings(groupId);
        if (!updatedSettings) return;

        const labelMap: Record<string, string> = {
          welcomeEnabled: "Pesan Sambutan",
          antiSpamEnabled: "Anti-Spam",
          antiLinkEnabled: "Anti-Link",
          wordFilterEnabled: "Filter Kata",
          antiFloodEnabled: "Anti-Flood",
          muteNewMembers: "Bisukan Member Baru",
          forceJoinEnabled: "Wajib Gabung",
        };

        await bot!.answerCallbackQuery(query.id, {
          text: `${labelMap[field] || field} telah di${!currentVal ? "aktifkan" : "nonaktifkan"}.`,
        });

        // Determine which submenu to rebuild
        if (field === "forceJoinEnabled") {
          await bot!.editMessageText(
            `<b>Pengaturan Wajib Gabung</b>\n\nFitur ini mewajibkan anggota untuk bergabung ke channel/grup tertentu sebelum bisa mengirim pesan.\n\n<b>Status:</b> ${updatedSettings.forceJoinEnabled ? "Aktif" : "Nonaktif"}\n<b>Channel Terdaftar:</b> ${(updatedSettings.forceJoinChannels || []).length > 0 ? (updatedSettings.forceJoinChannels as string[]).map(c => `@${c}`).join(", ") : "Belum ada"}\n\n<b>Cara menambah channel:</b>\nGunakan perintah /setforcejoin username_channel\n<b>Cara menghapus channel:</b>\nGunakan perintah /delforcejoin username_channel`,
            {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: buildForceJoinKeyboard(groupId, updatedSettings) },
            }
          );
        } else if (["antiSpamEnabled", "antiLinkEnabled", "wordFilterEnabled", "antiFloodEnabled"].includes(field)) {
          await bot!.editMessageText(
            `<b>Filter & Proteksi</b>\n\nKelola filter otomatis untuk melindungi grup:\n\n<b>Cara menambah kata terlarang:</b>\nGunakan perintah /addword kata\n<b>Cara menghapus kata terlarang:</b>\nGunakan perintah /delword kata`,
            {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: buildFiltersKeyboard(groupId, updatedSettings) },
            }
          );
        } else {
          await bot!.editMessageText(
            `<b>Pengaturan Grup</b>\n\nTekan tombol untuk mengaktifkan/menonaktifkan fitur:`,
            {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: buildSettingsKeyboard(groupId, updatedSettings) },
            }
          );
        }
        return;
      }

      // Set warn limit
      if (data.startsWith("setwarnlimit_")) {
        const parts = data.replace("setwarnlimit_", "").split("_");
        const limit = parseInt(parts.pop()!, 10);
        const groupId = parts.join("_");

        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa mengubah pengaturan.", show_alert: true });
          return;
        }

        await storage.updateSettings(groupId, { warnLimit: limit });
        const settings = await storage.getSettings(groupId);
        if (!settings) return;

        await bot!.answerCallbackQuery(query.id, { text: `Batas peringatan diubah menjadi ${limit}.` });

        await bot!.editMessageText(
          `<b>Pengaturan Peringatan</b>\n\nAtur batas peringatan dan aksi yang dilakukan saat batas tercapai.\n\nPengguna akan di-<b>${settings.warnAction === "ban" ? "banned" : settings.warnAction === "kick" ? "tendang" : "bisukan"}</b> setelah menerima <b>${settings.warnLimit}</b> peringatan.`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildWarningsKeyboard(groupId, settings) },
          }
        );
        return;
      }

      // Set warn action
      if (data.startsWith("setwarnaction_")) {
        const parts = data.replace("setwarnaction_", "").split("_");
        const action = parts.pop()!;
        const groupId = parts.join("_");

        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa mengubah pengaturan.", show_alert: true });
          return;
        }

        await storage.updateSettings(groupId, { warnAction: action });
        const settings = await storage.getSettings(groupId);
        if (!settings) return;

        const actionLabel = action === "ban" ? "Banned" : action === "kick" ? "Tendang" : "Bisukan";
        await bot!.answerCallbackQuery(query.id, { text: `Aksi peringatan diubah menjadi: ${actionLabel}.` });

        await bot!.editMessageText(
          `<b>Pengaturan Peringatan</b>\n\nAtur batas peringatan dan aksi yang dilakukan saat batas tercapai.\n\nPengguna akan di-<b>${settings.warnAction === "ban" ? "banned" : settings.warnAction === "kick" ? "tendang" : "bisukan"}</b> setelah menerima <b>${settings.warnLimit}</b> peringatan.`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildWarningsKeyboard(groupId, settings) },
          }
        );
        return;
      }

      // Remove channel from force join
      if (data.startsWith("removechannel_")) {
        const rest = data.replace("removechannel_", "");
        const firstUnderscore = rest.indexOf("_");
        const groupId = rest.substring(0, firstUnderscore);
        const channel = rest.substring(firstUnderscore + 1);

        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa mengubah pengaturan.", show_alert: true });
          return;
        }

        const settings = await storage.getSettings(groupId);
        if (!settings) return;

        const channels = ((settings.forceJoinChannels as string[]) ?? []).filter(c => c !== channel);
        await storage.updateSettings(groupId, { forceJoinChannels: channels });

        const updatedSettings = await storage.getSettings(groupId);
        if (!updatedSettings) return;

        await bot!.answerCallbackQuery(query.id, { text: `Channel @${channel} dihapus.` });

        await bot!.editMessageText(
          `<b>Pengaturan Wajib Gabung</b>\n\nFitur ini mewajibkan anggota untuk bergabung ke channel/grup tertentu sebelum bisa mengirim pesan.\n\n<b>Status:</b> ${updatedSettings.forceJoinEnabled ? "Aktif" : "Nonaktif"}\n<b>Channel Terdaftar:</b> ${(updatedSettings.forceJoinChannels || []).length > 0 ? (updatedSettings.forceJoinChannels as string[]).map(c => `@${c}`).join(", ") : "Belum ada"}\n\n<b>Cara menambah channel:</b>\nGunakan perintah /setforcejoin username_channel\n<b>Cara menghapus channel:</b>\nGunakan perintah /delforcejoin username_channel`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildForceJoinKeyboard(groupId, updatedSettings) },
          }
        );
        return;
      }

      // Add channel prompt
      if (data.startsWith("addchannel_")) {
        const groupId = data.replace("addchannel_", "");
        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa mengubah pengaturan.", show_alert: true });
          return;
        }

        await bot!.answerCallbackQuery(query.id, {
          text: "Gunakan perintah:\n/setforcejoin username_channel\n\nContoh: /setforcejoin mychannel",
          show_alert: true,
        });
        return;
      }

      // Add word prompt
      if (data.startsWith("addword_")) {
        const groupId = data.replace("addword_", "");
        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa mengubah pengaturan.", show_alert: true });
          return;
        }

        await bot!.answerCallbackQuery(query.id, {
          text: "Gunakan perintah:\n/addword kata_terlarang\n\nContoh: /addword spam",
          show_alert: true,
        });
        return;
      }

      // Clear all banned words
      if (data.startsWith("clearwords_")) {
        const groupId = data.replace("clearwords_", "");
        if (!(await isAdmin(chatId, query.from.id))) {
          await bot!.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa mengubah pengaturan.", show_alert: true });
          return;
        }

        await storage.updateSettings(groupId, { bannedWords: [] });
        const updatedSettings = await storage.getSettings(groupId);
        if (!updatedSettings) return;

        await bot!.answerCallbackQuery(query.id, { text: "Semua kata terlarang telah dihapus." });

        await bot!.editMessageText(
          `<b>Filter & Proteksi</b>\n\nKelola filter otomatis untuk melindungi grup:\n\n<b>Cara menambah kata terlarang:</b>\nGunakan perintah /addword kata\n<b>Cara menghapus kata terlarang:</b>\nGunakan perintah /delword kata`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buildFiltersKeyboard(groupId, updatedSettings) },
          }
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
