import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

export async function pushSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        member_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS group_settings (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL UNIQUE,
        welcome_enabled BOOLEAN DEFAULT true,
        welcome_message TEXT DEFAULT 'Welcome {user} to {group}! Please follow the rules.',
        force_join_enabled BOOLEAN DEFAULT false,
        force_join_channels TEXT[] DEFAULT '{}',
        anti_spam_enabled BOOLEAN DEFAULT true,
        anti_spam_max_messages INTEGER DEFAULT 5,
        anti_link_enabled BOOLEAN DEFAULT false,
        word_filter_enabled BOOLEAN DEFAULT false,
        banned_words TEXT[] DEFAULT '{}',
        anti_flood_enabled BOOLEAN DEFAULT true,
        anti_flood_messages INTEGER DEFAULT 10,
        anti_flood_seconds INTEGER DEFAULT 60,
        warn_limit INTEGER DEFAULT 3,
        warn_action TEXT DEFAULT 'mute',
        mute_new_members BOOLEAN DEFAULT false,
        mute_new_members_duration INTEGER DEFAULT 300,
        ai_moderator_enabled BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE group_settings ADD COLUMN IF NOT EXISTS ai_moderator_enabled BOOLEAN DEFAULT false;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS warnings (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        od_id TEXT NOT NULL,
        od_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        warned_by TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_stats (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        messages_processed INTEGER DEFAULT 0,
        messages_deleted INTEGER DEFAULT 0,
        users_warned INTEGER DEFAULT 0,
        users_banned INTEGER DEFAULT 0,
        users_kicked INTEGER DEFAULT 0,
        users_muted INTEGER DEFAULT 0,
        spam_blocked INTEGER DEFAULT 0,
        force_join_blocked INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_user TEXT NOT NULL,
        performed_by TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_owner_data (
        id SERIAL PRIMARY KEY,
        data_json TEXT NOT NULL DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("Database schema pushed successfully");
  } catch (error) {
    console.error("Error pushing schema:", error);
    throw error;
  } finally {
    client.release();
  }
}
