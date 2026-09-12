import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  passwordSalt: text('password_salt').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [uniqueIndex('idx_accounts_email').on(table.email)]);

export const authSessions = sqliteTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [index('idx_auth_sessions_user_expiry').on(table.userId, table.expiresAt)]);

export const studySessions = sqliteTable('study_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  studyDate: text('study_date').notNull(),
  minutes: integer('minutes').notNull(),
  topic: text('topic').notNull(),
  note: text('note'),
  createdAt: integer('created_at').notNull(),
}, (table) => [index('idx_study_sessions_user_date').on(table.userId, table.studyDate)]);
