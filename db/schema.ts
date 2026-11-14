import { integer, sqliteTable, text, primaryKey, index } from "drizzle-orm/sqlite-core";

// Standalone Cloudflare only. Sites continues to provide its own identity.
export const webSessions = sqliteTable("web_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  principal: text("principal").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (t) => [index("web_sessions_expiry").on(t.expiresAt)]);
export const loginAttempts = sqliteTable("login_attempts", {
  tokenHash: text("token_hash").primaryKey(),
  payload: text("payload").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (t) => [index("login_attempts_expiry").on(t.expiresAt)]);

export const connections = sqliteTable("connections", {
  userId: text("user_id").primaryKey(),
  sealed: text("sealed").notNull(),
  revision: text("revision").notNull(),
  keyExpiresAt: text("key_expires_at"),
  setupCompleted: integer("setup_completed").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});
export const cache = sqliteTable("vehicle_cache", {
  userId: text("user_id").notNull(),
  section: text("section").notNull(),
  revision: text("revision").notNull(),
  sealed: text("sealed").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.section] })]);
export const quotas = sqliteTable("vehicle_quotas", {
  vehicleHash: text("vehicle_hash").primaryKey(),
  remaining: integer("remaining"),
  limit: integer("quota_limit"),
  resetAt: integer("reset_at"),
  blockedUntil: integer("blocked_until").notNull().default(0),
  blockedCode: text("blocked_code"),
  observedAt: integer("observed_at"),
  updatedAt: integer("updated_at").notNull().default(0),
}, (t) => [index("quotas_updated").on(t.updatedAt)]);
export const leases = sqliteTable("request_leases", {
  vehicleHash: text("vehicle_hash").primaryKey(),
  token: text("token").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const connectionAttempts = sqliteTable("connection_attempts", {
  userId: text("user_id").primaryKey(),
  windowStart: integer("window_start").notNull(),
  attempts: integer("attempts").notNull(),
  blockedUntil: integer("blocked_until").notNull().default(0),
  token: text("token"),
  expiresAt: integer("expires_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("connection_attempts_expiry").on(t.expiresAt), index("connection_attempts_updated").on(t.updatedAt)]);
export const connectionGate = sqliteTable("connection_gate", {
  id: integer("id").primaryKey(),
  windowStart: integer("window_start").notNull(),
  attempts: integer("attempts").notNull(),
  lastToken: text("last_token"),
});

export const controlPermissions = sqliteTable("control_permissions", {
  userId: text("user_id").primaryKey(),
  revision: text("revision").notNull(),
  permissionVersion: text("permission_version").notNull(),
  ventilationEnabled: integer("ventilation_enabled").notNull().default(0),
  chargingEnabled: integer("charging_enabled").notNull().default(0),
  airConditioningEnabled: integer("air_conditioning_enabled").notNull().default(0),
  auxiliaryHeatingEnabled: integer("auxiliary_heating_enabled").notNull().default(0),
  sealedSpin: text("sealed_spin"),
  updatedAt: integer("updated_at").notNull(),
});

export const commands = sqliteTable("vehicle_commands", {
  userId: text("user_id").notNull(),
  requestId: text("request_id").notNull(),
  revision: text("revision").notNull(),
  vehicleHash: text("vehicle_hash").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull(),
  sealedResult: text("sealed_result"),
  inputFingerprint: text("input_fingerprint"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.requestId] }), index("commands_vehicle_created").on(t.vehicleHash, t.createdAt)]);
