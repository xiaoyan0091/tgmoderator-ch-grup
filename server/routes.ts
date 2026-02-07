import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { startBot } from "./bot";
import { insertGroupSettingsSchema } from "@shared/schema";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/groups", async (_req, res) => {
    try {
      const groups = await storage.getGroups();
      res.json(groups);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch groups" });
    }
  });

  app.get("/api/groups/:chatId/settings", async (req, res) => {
    try {
      const settings = await storage.getSettings(req.params.chatId);
      if (!settings) {
        return res.status(404).json({ message: "Settings not found" });
      }
      res.json(settings);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch settings" });
    }
  });

  app.patch("/api/groups/:chatId/settings", async (req, res) => {
    try {
      const parsed = insertGroupSettingsSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid settings data", errors: parsed.error.flatten() });
      }
      const updated = await storage.updateSettings(req.params.chatId, parsed.data);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: "Failed to update settings" });
    }
  });

  app.get("/api/groups/:chatId/stats", async (req, res) => {
    try {
      const stats = await storage.getStats(req.params.chatId);
      if (!stats) {
        return res.json({
          chatId: req.params.chatId,
          messagesProcessed: 0,
          messagesDeleted: 0,
          usersWarned: 0,
          usersBanned: 0,
          usersKicked: 0,
          usersMuted: 0,
          spamBlocked: 0,
          forceJoinBlocked: 0,
        });
      }
      res.json(stats);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch stats" });
    }
  });

  app.get("/api/groups/:chatId/logs", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const logs = await storage.getLogs(req.params.chatId, limit);
      res.json(logs);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch logs" });
    }
  });

  app.get("/api/groups/:chatId/warnings", async (req, res) => {
    try {
      const chatId = req.params.chatId;
      const allLogs = await storage.getLogs(chatId, 200);
      const warnLogs = allLogs.filter(l => l.action === "warn");
      res.json(warnLogs);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch warnings" });
    }
  });

  app.get("/api/logs/recent", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const logs = await storage.getRecentLogs(limit);
      res.json(logs);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch recent logs" });
    }
  });

  app.get("/api/stats/overview", async (_req, res) => {
    try {
      const groups = await storage.getGroups();
      const allStats = await storage.getAllStats();

      let totalMessages = 0;
      let totalDeleted = 0;
      let totalWarned = 0;
      let totalBanned = 0;
      let totalKicked = 0;
      let totalMuted = 0;
      let totalSpam = 0;
      let totalForceJoin = 0;

      for (const s of allStats) {
        totalMessages += s.messagesProcessed ?? 0;
        totalDeleted += s.messagesDeleted ?? 0;
        totalWarned += s.usersWarned ?? 0;
        totalBanned += s.usersBanned ?? 0;
        totalKicked += s.usersKicked ?? 0;
        totalMuted += s.usersMuted ?? 0;
        totalSpam += s.spamBlocked ?? 0;
        totalForceJoin += s.forceJoinBlocked ?? 0;
      }

      res.json({
        totalGroups: groups.length,
        activeGroups: groups.filter(g => g.isActive).length,
        totalMessages,
        totalDeleted,
        totalWarned,
        totalBanned,
        totalKicked,
        totalMuted,
        totalSpam,
        totalForceJoin,
      });
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch overview stats" });
    }
  });

  startBot().catch((err) => {
    console.error("Failed to start bot:", err);
  });

  return httpServer;
}
