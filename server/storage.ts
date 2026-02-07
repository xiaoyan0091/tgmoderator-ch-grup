import {
  type User, type InsertUser,
  type Group, type InsertGroup,
  type GroupSettings, type InsertGroupSettings,
  type Warning, type InsertWarning,
  type BotStats, type InsertBotStats,
  type ActivityLog, type InsertActivityLog,
  users, groups, groupSettings, warnings, botStats, activityLogs, botOwnerData,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, sql, and } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getGroup(chatId: string): Promise<Group | undefined>;
  getGroups(): Promise<Group[]>;
  upsertGroup(group: InsertGroup): Promise<Group>;
  deleteGroup(chatId: string): Promise<void>;

  getSettings(chatId: string): Promise<GroupSettings | undefined>;
  updateSettings(chatId: string, settings: Partial<InsertGroupSettings>): Promise<GroupSettings>;

  getWarnings(chatId: string, odId: string): Promise<Warning[]>;
  addWarning(warning: InsertWarning): Promise<Warning>;
  clearWarnings(chatId: string, odId: string): Promise<void>;
  getWarningCount(chatId: string, odId: string): Promise<number>;

  getStats(chatId: string): Promise<BotStats | undefined>;
  getAllStats(): Promise<BotStats[]>;
  incrementStat(chatId: string, stat: string, amount?: number): Promise<void>;

  getLogs(chatId: string, limit?: number): Promise<ActivityLog[]>;
  getRecentLogs(limit?: number): Promise<ActivityLog[]>;
  addLog(log: InsertActivityLog): Promise<ActivityLog>;

  getOwnerData(): Promise<any>;
  saveOwnerData(data: any): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async getGroup(chatId: string): Promise<Group | undefined> {
    const [group] = await db.select().from(groups).where(eq(groups.chatId, chatId));
    return group;
  }

  async getGroups(): Promise<Group[]> {
    return db.select().from(groups);
  }

  async upsertGroup(group: InsertGroup): Promise<Group> {
    const [result] = await db
      .insert(groups)
      .values(group)
      .onConflictDoUpdate({
        target: groups.chatId,
        set: {
          title: group.title,
          memberCount: group.memberCount,
          isActive: group.isActive,
        },
      })
      .returning();
    return result;
  }

  async deleteGroup(chatId: string): Promise<void> {
    await db.delete(groups).where(eq(groups.chatId, chatId));
  }

  async getSettings(chatId: string): Promise<GroupSettings | undefined> {
    const [settings] = await db.select().from(groupSettings).where(eq(groupSettings.chatId, chatId));
    return settings;
  }

  async updateSettings(chatId: string, settings: Partial<InsertGroupSettings>): Promise<GroupSettings> {
    const existing = await this.getSettings(chatId);
    if (existing) {
      const [updated] = await db
        .update(groupSettings)
        .set(settings)
        .where(eq(groupSettings.chatId, chatId))
        .returning();
      return updated;
    }
    const [created] = await db
      .insert(groupSettings)
      .values({ chatId, ...settings })
      .returning();
    return created;
  }

  async getWarnings(chatId: string, odId: string): Promise<Warning[]> {
    return db
      .select()
      .from(warnings)
      .where(and(eq(warnings.chatId, chatId), eq(warnings.odId, odId)))
      .orderBy(desc(warnings.createdAt));
  }

  async addWarning(warning: InsertWarning): Promise<Warning> {
    const [result] = await db.insert(warnings).values(warning).returning();
    return result;
  }

  async clearWarnings(chatId: string, odId: string): Promise<void> {
    await db
      .delete(warnings)
      .where(and(eq(warnings.chatId, chatId), eq(warnings.odId, odId)));
  }

  async getWarningCount(chatId: string, odId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(warnings)
      .where(and(eq(warnings.chatId, chatId), eq(warnings.odId, odId)));
    return result[0]?.count ?? 0;
  }

  async getStats(chatId: string): Promise<BotStats | undefined> {
    const [stats] = await db.select().from(botStats).where(eq(botStats.chatId, chatId));
    return stats;
  }

  async getAllStats(): Promise<BotStats[]> {
    return db.select().from(botStats);
  }

  async incrementStat(chatId: string, stat: string, amount: number = 1): Promise<void> {
    const existing = await this.getStats(chatId);
    if (!existing) {
      const values: any = { chatId };
      values[stat] = amount;
      await db.insert(botStats).values(values);
      return;
    }

    const columnMap: Record<string, any> = {
      messagesProcessed: botStats.messagesProcessed,
      messagesDeleted: botStats.messagesDeleted,
      usersWarned: botStats.usersWarned,
      usersBanned: botStats.usersBanned,
      usersKicked: botStats.usersKicked,
      usersMuted: botStats.usersMuted,
      spamBlocked: botStats.spamBlocked,
      forceJoinBlocked: botStats.forceJoinBlocked,
    };

    const column = columnMap[stat];
    if (column) {
      await db
        .update(botStats)
        .set({
          [stat]: sql`${column} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(botStats.chatId, chatId));
    }
  }

  async getLogs(chatId: string, limit: number = 50): Promise<ActivityLog[]> {
    return db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.chatId, chatId))
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit);
  }

  async getRecentLogs(limit: number = 20): Promise<ActivityLog[]> {
    return db
      .select()
      .from(activityLogs)
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit);
  }

  async addLog(log: InsertActivityLog): Promise<ActivityLog> {
    const [result] = await db.insert(activityLogs).values(log).returning();
    return result;
  }

  async getOwnerData(): Promise<any> {
    const [row] = await db.select().from(botOwnerData).limit(1);
    if (!row) return null;
    try {
      return JSON.parse(row.dataJson);
    } catch {
      return null;
    }
  }

  async saveOwnerData(data: any): Promise<void> {
    const json = JSON.stringify(data);
    const [existing] = await db.select().from(botOwnerData).limit(1);
    if (existing) {
      await db.update(botOwnerData).set({ dataJson: json, updatedAt: new Date() }).where(eq(botOwnerData.id, existing.id));
    } else {
      await db.insert(botOwnerData).values({ dataJson: json });
    }
  }
}

export const storage = new DatabaseStorage();
