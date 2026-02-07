# TG Moderator Bot

## Overview
A Telegram Group Moderator Bot with a web dashboard. The bot provides comprehensive group moderation features including force sub (subscribe), anti-spam, word filtering, and more. The web dashboard allows managing bot settings for each group. All bot messages are in Indonesian (Bahasa Indonesia).

## Architecture
- **Frontend**: React + Vite + TailwindCSS + Shadcn UI
- **Backend**: Express.js + Node.js
- **Database**: PostgreSQL with Drizzle ORM
- **Bot**: node-telegram-bot-api (polling mode)

## Key Features
- Force Sub - require users to subscribe to channels before chatting
- Welcome Messages - customizable greetings for new members
- Anti-Spam - message rate limiting
- Anti-Link - block URL messages
- Word Filter - ban specific words
- Anti-Flood - prevent message flooding
- Warning System - warn/mute/ban/kick with configurable limits
- Mute New Members - temporarily restrict new members
- Inline Keyboard Button Menus - full admin menu with interactive buttons
- Bot Owner Panel - broadcast, global stats, group management
- PM Group Configuration - /setgroup command for full button-based group config via PM
- AI Moderator - OpenAI-powered content moderation (hate speech, violence, harassment, spam detection)
- Web Dashboard - manage all settings via browser

## Project Structure
```
client/src/
  App.tsx - Main app with routing and sidebar layout
  pages/
    dashboard.tsx - Overview with stats and activity
    groups.tsx - List of managed groups
    group-detail.tsx - Settings, stats, activity for a group
  components/
    app-sidebar.tsx - Navigation sidebar
    theme-provider.tsx - Dark/light mode
    theme-toggle.tsx - Theme switch button

server/
  index.ts - Express server entry point
  routes.ts - API routes + bot startup
  bot.ts - Telegram bot with all moderation features (Indonesian language)
  storage.ts - Database CRUD operations
  db.ts - PostgreSQL connection + schema push

shared/
  schema.ts - Drizzle schema + Zod validation types
```

## API Endpoints
- GET /api/groups - list all groups
- GET /api/groups/:chatId/settings - get group settings
- PATCH /api/groups/:chatId/settings - update settings (Zod validated)
- GET /api/groups/:chatId/stats - get group statistics
- GET /api/groups/:chatId/logs - get activity logs
- GET /api/groups/:chatId/warnings - get warnings
- GET /api/stats/overview - aggregated stats across all groups
- GET /api/logs/recent - recent activity across all groups

## Environment Variables
- DATABASE_URL - PostgreSQL connection string
- TELEGRAM_BOT_TOKEN - Bot token from @BotFather
- SESSION_SECRET - Session encryption key

## Running
```
npm run dev
```

## Bot Commands (Indonesian / Bahasa Indonesia)

### Umum
- /start - Perkenalan bot
- /help - Daftar semua perintah
- /menu - Menu pengaturan grup dengan tombol inline (Admin)
- /rules - Lihat aturan grup

### Moderasi (Khusus Admin, balas pesan pengguna)
- /warn [alasan] - Beri peringatan
- /unwarn - Hapus semua peringatan
- /warnings - Cek peringatan
- /ban - Banned pengguna
- /unban - Buka banned
- /kick - Tendang pengguna
- /mute [menit] - Bisukan pengguna
- /unmute - Buka bisukan
- /del - Hapus pesan
- /purge - Hapus banyak pesan (balas pesan pertama)
- /pin - Sematkan pesan
- /unpin - Lepas sematan

### Pengaturan Grup (Admin)
- /setTitle [judul] - Ubah judul grup
- /promote - Jadikan admin (pemilik grup saja)
- /demote - Cabut admin (pemilik grup saja)
- /lock - Kunci chat
- /unlock - Buka kunci chat
- /slow [detik] - Mode lambat

### Pengaturan Fitur (Admin)
- /setwelcome [pesan] - Atur pesan sambutan
- /welcome on/off - Aktifkan/nonaktifkan sambutan
- /setgoodbye [pesan] - Atur pesan perpisahan
- /goodbye on/off - Aktifkan/nonaktifkan perpisahan
- /format - Panduan format markdown, fillings, dan button
- /setforcesub [username] - Tambah channel force sub
- /delforcesub [username] - Hapus channel force sub
- /addword [kata] - Tambah kata terlarang
- /delword [kata] - Hapus kata terlarang

### Pengaturan via PM
- /setgroup - Pengaturan grup lengkap via PM dengan tombol inline (pilih grup, toggle fitur, atur peringatan, filter, wajib sub, statistik)

### Jadwal Donghua (Group Commands)
- /jadwal - Tampilkan jadwal hari ini (20-menit cooldown anti-spam)
- /rules - Tampilkan rules bot (20-menit cooldown, auto-delete 10 detik)

### Pemilik Bot
- /owner atau /menuowner - Panel pemilik bot dengan status lengkap dan tombol inline (termasuk jadwal donghua management)
- /broadcast [pesan] - Kirim pesan ke semua grup

## Jadwal Donghua System (Bot Owner Only)
Integrated schedule management system accessible from /owner panel:
- **Data Structure**: In-memory `jadwalData` object backed by PostgreSQL (`botOwnerData` table)
- **Schedule Management**: Add/delete harian (daily per day) and upcoming schedules with pagination
- **Channel Management**: Add/delete channels for auto-posting with test messages
- **Auto-Post**: Daily automated posting at configurable WIB time with 1-minute rotating channel delays
- **Telegraph Integration**: Create/update Telegraph pages for schedule viewing
- **Rules Management**: Set/preview HTML rules for groups
- **Media Management**: Set photo/video/GIF per day (via file_id or URL) for schedule posts
- **Owner State Tracking**: `ownerWaitingState` Map tracks PM input states for the owner
- **All callback_data prefixed with `jd_`** to avoid conflicts with moderation callbacks
- **All messages in Indonesian (Bahasa Indonesia)** matching original Python bot exactly

### Jadwal Callback Handlers (jd_* prefix)
- jd_tambah, jd_hapus, jd_lihat, jd_preview, jd_send_now
- jd_manage_channels, jd_add_channel, jd_dc_N (delete channel)
- jd_set_time, jd_toggle_auto, jd_setup_telegraph, jd_create_telegraph, jd_update_telegraph
- jd_set_rules, jd_preview_rules
- jd_set_media, jd_mu_HARI (upload media), jd_md_HARI (delete media)
- jd_dh_HARI_HASH (delete harian), jd_du_INDEX (delete upcoming), jd_dp_N (pagination)
- jd_back (back to owner panel)
