import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const groups = pgTable("groups", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull().unique(),
  title: text("title").notNull(),
  memberCount: integer("member_count").default(0),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertGroupSchema = createInsertSchema(groups).omit({ id: true, createdAt: true });
export type InsertGroup = z.infer<typeof insertGroupSchema>;
export type Group = typeof groups.$inferSelect;

export const groupSettings = pgTable("group_settings", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull().unique(),
  welcomeEnabled: boolean("welcome_enabled").default(true),
  welcomeMessage: text("welcome_message").default("Selamat datang {user} di {group}! Silakan patuhi aturan grup."),
  forceJoinEnabled: boolean("force_join_enabled").default(false),
  forceJoinChannels: text("force_join_channels").array().default(sql`'{}'::text[]`),
  antiSpamEnabled: boolean("anti_spam_enabled").default(true),
  antiSpamMaxMessages: integer("anti_spam_max_messages").default(5),
  antiLinkEnabled: boolean("anti_link_enabled").default(false),
  wordFilterEnabled: boolean("word_filter_enabled").default(false),
  bannedWords: text("banned_words").array().default(sql`'{}'::text[]`),
  antiFloodEnabled: boolean("anti_flood_enabled").default(true),
  antiFloodMessages: integer("anti_flood_messages").default(10),
  antiFloodSeconds: integer("anti_flood_seconds").default(60),
  warnLimit: integer("warn_limit").default(3),
  warnAction: text("warn_action").default("mute"),
  muteNewMembers: boolean("mute_new_members").default(false),
  muteNewMembersDuration: integer("mute_new_members_duration").default(300),
  aiModeratorEnabled: boolean("ai_moderator_enabled").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertGroupSettingsSchema = createInsertSchema(groupSettings).omit({ id: true, createdAt: true });
export type InsertGroupSettings = z.infer<typeof insertGroupSettingsSchema>;
export type GroupSettings = typeof groupSettings.$inferSelect;

export const warnings = pgTable("warnings", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  odId: text("od_id").notNull(),
  odName: text("od_name").notNull(),
  reason: text("reason").notNull(),
  warnedBy: text("warned_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertWarningSchema = createInsertSchema(warnings).omit({ id: true, createdAt: true });
export type InsertWarning = z.infer<typeof insertWarningSchema>;
export type Warning = typeof warnings.$inferSelect;

export const botStats = pgTable("bot_stats", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  messagesProcessed: integer("messages_processed").default(0),
  messagesDeleted: integer("messages_deleted").default(0),
  usersWarned: integer("users_warned").default(0),
  usersBanned: integer("users_banned").default(0),
  usersKicked: integer("users_kicked").default(0),
  usersMuted: integer("users_muted").default(0),
  spamBlocked: integer("spam_blocked").default(0),
  forceJoinBlocked: integer("force_join_blocked").default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertBotStatsSchema = createInsertSchema(botStats).omit({ id: true, updatedAt: true });
export type InsertBotStats = z.infer<typeof insertBotStatsSchema>;
export type BotStats = typeof botStats.$inferSelect;

export const activityLogs = pgTable("activity_logs", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  action: text("action").notNull(),
  targetUser: text("target_user").notNull(),
  performedBy: text("performed_by").notNull(),
  details: text("details"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertActivityLogSchema = createInsertSchema(activityLogs).omit({ id: true, createdAt: true });
export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityLog = typeof activityLogs.$inferSelect;
