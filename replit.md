# TG Moderator Bot

## Overview
A Telegram Group Moderator Bot with a web dashboard. The bot provides comprehensive group moderation features including force join, anti-spam, word filtering, and more. The web dashboard allows managing bot settings for each group.

## Architecture
- **Frontend**: React + Vite + TailwindCSS + Shadcn UI
- **Backend**: Express.js + Node.js
- **Database**: PostgreSQL with Drizzle ORM
- **Bot**: node-telegram-bot-api (polling mode)

## Key Features
- Force Join - require users to join channels before chatting
- Welcome Messages - customizable greetings for new members
- Anti-Spam - message rate limiting
- Anti-Link - block URL messages
- Word Filter - ban specific words
- Anti-Flood - prevent message flooding
- Warning System - warn/mute/ban/kick with configurable limits
- Mute New Members - temporarily restrict new members
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
  bot.ts - Telegram bot with all moderation features
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

## Bot Commands
- /start - Bot introduction
- /help - List commands
- /warn - Warn a user (reply)
- /unwarn - Clear warnings (reply)
- /warnings - Check warnings (reply)
- /ban, /unban - Ban/unban (reply)
- /kick - Kick user (reply)
- /mute, /unmute - Mute/unmute (reply)
- /settings - View group settings (admin)
- /stats - View group stats (admin)
