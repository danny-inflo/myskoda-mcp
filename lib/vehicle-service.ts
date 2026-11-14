import { env } from "cloudflare:workers";
import { admitConnection, CONNECTION_LIMITS } from "./connection-admission.ts";
import { controlProfileInput } from "./control-profile.mjs";
import { CACHE_SECONDS, SUMMARY_PARTS, VehicleError, commandInput, credentials, fetchVehicle, freshness, maskVin, projection, safeError, seal, sectionFor, sendVehicleCommand, unseal, vehicleHash, operationDefinition, fingerprint, mergeChargingProfile, commandObservation } from "./skoda-core.mjs";

type Connection = { user_id: string; sealed: string; revision: string; key_expires_at: string | null; setup_completed: number; updated_at: number };
type Cached = { sealed: string; fetched_at: number; expires_at: number };
type Quota = { remaining: number | null; quota_limit: number | null; reset_at: number | null; blocked_until: number; blocked_code: string | null; observed_at: number | null };
type Meta = ReturnType<typeof import("./skoda-core.mjs").metadata>;
type Permission = { user_id: string; revision: string; permission_version: string; ventilation_enabled: number; charging_enabled: number; air_conditioning_enabled: number; auxiliary_heating_enabled: number; sealed_spin: string | null; updated_at: number };
type Command = { user_id: string; request_id: string; revision: string; vehicle_hash: string; action: string; status: string; sealed_result: string | null; input_fingerprint: string | null; created_at: number; updated_at: number };
export type ControlScope = "ventilation" | "charging" | "airConditioning" | "auxiliaryHeating";
const scopeColumns = { ventilation: "ventilation_enabled", charging: "charging_enabled", airConditioning: "air_conditioning_enabled", auxiliaryHeating: "auxiliary_heating_enabled" } as const;
const scopeAcknowledgements = { ventilation: "ALLOW_VENTILATION_CONTROL", charging: "ALLOW_CHARGING_CONTROL", airConditioning: "ALLOW_AIR_CONDITIONING_CONTROL", auxiliaryHeating: "ALLOW_AUXILIARY_HEATING_CONTROL" } as const;
function controlFlags(permission: Permission | null) { return { ventilationEnabled: permission?.ventilation_enabled === 1, chargingEnabled: permission?.charging_enabled === 1, airConditioningEnabled: permission?.air_conditioning_enabled === 1, auxiliaryHeatingEnabled: permission?.auxiliary_heating_enabled === 1, auxiliaryHeatingSpinConfigured: !!permission?.sealed_spin, explicitActionRequestRequired: true }; }
async function present(data: Parameters<typeof projection>[0], kind: ReadKind, permission: Permission | null) {
  const result = projection(data, kind, controlFlags(permission));
  if (kind === "profiles" && Array.isArray(data.vehicle.chargingProfiles?.profiles)) return { ...result, normalized: { ...result.normalized, chargingProfileRevisions: await Promise.all(data.vehicle.chargingProfiles.profiles.map(async (profile: { id: number }) => ({ id: profile.id, fingerprint: Number.isSafeInteger(profile.id) ? await fingerprint(profile) : null }))) } };
  return result;
}
export type VentilationAction = "start" | "stop";
export type ReadKind = "overview" | "status" | "charging" | "energy" | "climate" | "capabilities" | "profiles" | "position";
import { setupUrl } from "./deployment-context.ts";
function database() {
  if (!env.DB || !env.VEHICLE_VAULT_KEY) throw new VehicleError("NOT_CONFIGURED", "Služba ještě není připravená.", 503);
  return env.DB;
}
function secret() { database(); return env.VEHICLE_VAULT_KEY!; }
async function connection(userId: string) {
  return database().prepare("SELECT * FROM connections WHERE user_id = ?").bind(userId).first<Connection>();
}
async function pruneQuotas() {
  const now = Date.now();
  await database().prepare("DELETE FROM vehicle_quotas WHERE updated_at < ? AND blocked_until <= ? AND COALESCE(reset_at, 0) <= ?")
    .bind(now - CONNECTION_LIMITS.retentionMs, now, now).run();
}
async function recordQuota(hash: string, meta: Meta, blockedCode: string | null = null, now = Date.now(), strictlyNewer = false) {
  // Empty error metadata is not a quota observation. Candidate failures never call this helper.
  if (meta.remaining === null && meta.limit === null && meta.resetAt === null && !blockedCode) return;
  const blockedUntil = blockedCode ? now + Math.max(meta.retryAfter ?? 60, 1) * 1000 : meta.remaining === 0 ? meta.resetAt ?? now + 60_000 : 0;
  const code = blockedCode ?? (meta.remaining === 0 ? "RATE_LIMITED" : null);
  const quotaObservedAt = meta.remaining !== null || meta.limit !== null || meta.resetAt !== null ? now : null;
  await pruneQuotas();
  await database().prepare("INSERT INTO vehicle_quotas (vehicle_hash, remaining, quota_limit, reset_at, blocked_until, blocked_code, observed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(vehicle_hash) DO UPDATE SET remaining=COALESCE(excluded.remaining, vehicle_quotas.remaining), quota_limit=COALESCE(excluded.quota_limit, vehicle_quotas.quota_limit), reset_at=COALESCE(excluded.reset_at, vehicle_quotas.reset_at), blocked_until=MAX(excluded.blocked_until, vehicle_quotas.blocked_until), blocked_code=CASE WHEN excluded.blocked_until >= vehicle_quotas.blocked_until THEN excluded.blocked_code ELSE vehicle_quotas.blocked_code END, observed_at=COALESCE(excluded.observed_at, vehicle_quotas.observed_at), updated_at=excluded.updated_at WHERE vehicle_quotas.updated_at < excluded.updated_at OR (? = 0 AND vehicle_quotas.updated_at = excluded.updated_at)")
    .bind(hash, meta.remaining, meta.limit, meta.resetAt, blockedUntil, code, quotaObservedAt, now, strictlyNewer ? 1 : 0).run();
}
async function withLease<T>(hash: string, fn: (assertLease: () => Promise<void>) => Promise<T>, ready?: () => Promise<T | null>, leaseMs = 45_000): Promise<T> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + 30_000;
  let delay = 100;
  for (;;) {
    const available = await ready?.();
    if (available) return available;
    const now = Date.now();
    const result = await database().prepare("INSERT INTO request_leases (vehicle_hash, token, expires_at) VALUES (?, ?, ?) ON CONFLICT(vehicle_hash) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at WHERE request_leases.expires_at < ?")
      .bind(hash, token, now + leaseMs, now).run();
    if (result.meta.changes) break;
    if (now >= deadline) throw new VehicleError("REQUEST_IN_PROGRESS", "Načítání ještě probíhá. Zkuste to za chvíli.", 503, 5);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 1000);
  }
  try {
    // A previous reader may have populated our cache before this lease was acquired.
    const available = await ready?.();
    if (available) return available;
    const now = Date.now();
    const quota = await database().prepare("SELECT * FROM vehicle_quotas WHERE vehicle_hash = ?").bind(hash).first<Quota>();
    const exhaustedUntil = quota?.remaining === 0 ? quota.reset_at ?? 0 : 0;
    const until = Math.max(quota?.blocked_until ?? 0, exhaustedUntil);
    if (until > now) {
      const code = exhaustedUntil > (quota?.blocked_until ?? 0) ? "RATE_LIMITED" : quota?.blocked_code ?? "RATE_LIMITED";
      throw new VehicleError(code, code === "VEHICLE_NOT_ACCEPTING_REQUESTS" ? "Auto dočasně odmítá požadavky. Počkej před dalším načtením." : code === "UPSTREAM_503" ? "Škoda API je dočasně nedostupné. Počkej před dalším načtením." : "Počkej před dalším načtením ze Škoda API.", code === "UPSTREAM_503" ? 503 : 429, Math.ceil((until - now) / 1000));
    }
    return await fn(async () => {
      const lease = await database().prepare("SELECT expires_at FROM request_leases WHERE vehicle_hash = ? AND token = ?").bind(hash, token).first<{ expires_at: number }>();
      if (!lease || lease.expires_at <= Date.now() + 15_000) throw new VehicleError("COMMAND_LEASE_EXPIRED", "Příprava příkazu trvala příliš dlouho. Příkaz nebyl odeslán.", 409);
    });
  } finally {
    await database().prepare("DELETE FROM request_leases WHERE vehicle_hash = ? AND token = ?").bind(hash, token).run();
  }
}
async function provider(hash: string, config: { vin: string; apiKey: string }, parts: string[]) {
  try {
    const result = await fetchVehicle(config, parts);
    await recordQuota(hash, result.meta);
    return result;
  } catch (error) {
    if (error instanceof VehicleError && error.meta) await recordQuota(hash, error.meta, error.status === 429 || (error.status === 503 && error.retryAfter !== null) ? error.code : null);
    throw error;
  }
}
export async function getConnectionStatus(userId: string) {
  const row = await connection(userId);
  if (!row) return { connected: false, controls: controlFlags(null), setupUrl: setupUrl() };
  const config = await unseal(row.sealed, secret(), `connection:${userId}:${row.revision}`);
  const hash = await vehicleHash(config.vin, secret());
  const quota = await database().prepare("SELECT * FROM vehicle_quotas WHERE vehicle_hash = ?").bind(hash).first<Quota>();
  const permission = await controlPermission(userId, row.revision);
  return { connected: true, setupCompleted: row.setup_completed === 1, connectionRevision: row.revision, controls: controlFlags(permission), vin: maskVin(config.vin), keyExpiresAt: row.key_expires_at, keyExpired: row.key_expires_at ? Date.parse(row.key_expires_at) <= Date.now() : null, updatedAt: new Date(row.updated_at).toISOString(), setupUrl: setupUrl(), sourceVerification: "not_performed", lastQuotaResponseAt: quota?.observed_at ? new Date(quota.observed_at).toISOString() : null, api: quota ? { lastReportedRemaining: quota.remaining, limit: quota.quota_limit, resetAt: quota.reset_at ? new Date(quota.reset_at).toISOString() : null, observedAt: quota.observed_at ? new Date(quota.observed_at).toISOString() : null, blockedUntil: quota.blocked_until > Date.now() ? new Date(quota.blocked_until).toISOString() : null, blockedReason: quota.blocked_until > Date.now() ? quota.blocked_code : null, reportedWindowActive: quota.reset_at ? quota.reset_at > Date.now() : null } : null, interpretation: "Local connection status only. Control permissions and saved S-PIN never initiate an action; a separate explicit user action request is always required. Last quota response may be an error and does not prove current key validity, vehicle reachability or service availability. Reported quota is a snapshot; other clients may consume it. A response without quota headers does not refresh the quota observation time." };
}
export async function connectVehicle(userId: string, input: unknown) {
  const config = credentials(input);
  return verifyAndSaveConnection(userId, config);
}

// Only the current account's encrypted VIN may be used for a key renewal.
// Both the initial lookup and the final atomic write check the expected revision.
export async function renewVehicleKey(userId: string, input: unknown) {
  const value = input as { connectionRevision?: unknown; apiKey?: unknown } | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["connectionRevision", "apiKey"].includes(key)) || typeof value.connectionRevision !== "string" || !value.connectionRevision) throw new VehicleError("INVALID_CONNECTION_INPUT", "Pro obnovu klíče je potřeba aktuální připojení a nový API klíč.");
  const row = await connection(userId);
  if (!row || row.revision !== value.connectionRevision) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Obnovte stránku nastavení.", 409);
  const saved = await unseal(row.sealed, secret(), `connection:${userId}:${row.revision}`);
  const config = credentials({ vin: saved.vin, apiKey: value.apiKey });
  return verifyAndSaveConnection(userId, config, { revision: row.revision, setupCompleted: row.setup_completed });
}

async function verifyAndSaveConnection(userId: string, config: { vin: string; apiKey: string }, previous?: { revision: string; setupCompleted: number }) {
  secret(); // Fail closed before allocating admission state if the vault is unavailable.
  const admission = await admitConnection(database(), userId);
  let failed = true;
  try {
    await pruneQuotas();
    // An unverified candidate cannot acquire a vehicle lease or publish quota/backoff,
    // even if an authorization error contains quota headers or a Retry-After value.
    const result = await fetchVehicle(config, ["info"]);
    const receivedAt = Date.now();
    const revision = crypto.randomUUID();
    const hash = await vehicleHash(config.vin, secret());
    const encrypted = await seal(config, secret(), `connection:${userId}:${revision}`);
    await withLease(hash, async () => {
      await admission.assertCurrent();
      const committed = await database().batch([
        database().prepare("INSERT INTO connections (user_id, sealed, revision, key_expires_at, updated_at, setup_completed) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connection_attempts WHERE user_id = ? AND token = ? AND expires_at > unixepoch('subsec') * 1000) AND (? IS NULL OR EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND revision = ?)) ON CONFLICT(user_id) DO UPDATE SET sealed=excluded.sealed, revision=excluded.revision, key_expires_at=excluded.key_expires_at, updated_at=excluded.updated_at, setup_completed=excluded.setup_completed")
          .bind(userId, encrypted, revision, result.meta.keyExpiresAt, Date.now(), previous?.setupCompleted ?? 0, userId, admission.token, previous?.revision ?? null, userId, previous?.revision ?? null),
        database().prepare("DELETE FROM vehicle_cache WHERE user_id = ? AND EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND revision = ?)").bind(userId, userId, revision),
        database().prepare("DELETE FROM control_permissions WHERE user_id = ? AND EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND revision = ?)").bind(userId, userId, revision),
      ]);
      if (!committed[0].meta.changes) throw new VehicleError(previous ? "CONNECTION_CHANGED" : "CONNECTION_ATTEMPT_EXPIRED", "Připojení se změnilo nebo ověření vypršelo. Obnovte stránku nastavení.", 409);
      // A delayed verification must not overwrite a newer established response.
      await recordQuota(hash, result.meta, null, receivedAt, true);
    });
    failed = false;
    return await getConnectionStatus(userId);
  } finally {
    await admission.finish(failed);
  }
}
export async function disconnectVehicle(userId: string) {
  await database().batch([
    // Cancel an in-flight candidate without refunding its attempt or window.
    database().prepare("UPDATE connection_attempts SET token = NULL, expires_at = 0, blocked_until = MAX(blocked_until, ?), updated_at = ? WHERE user_id = ? AND token IS NOT NULL")
      .bind(Date.now() + CONNECTION_LIMITS.failureDelayMs, Date.now(), userId),
    database().prepare("DELETE FROM connections WHERE user_id = ?").bind(userId),
    database().prepare("DELETE FROM vehicle_cache WHERE user_id = ?").bind(userId),
    database().prepare("DELETE FROM control_permissions WHERE user_id = ?").bind(userId),
    database().prepare("DELETE FROM vehicle_commands WHERE user_id = ?").bind(userId),
  ]);
  return { connected: false, setupUrl: setupUrl() };
}
export async function readVehicle(userId: string, kind: ReadKind) {
  const section = sectionFor(kind);
  const row = await connection(userId);
  if (!row) throw new VehicleError("CONNECT_REQUIRED", `Nejprve připojte své vozidlo na ${setupUrl()}. API klíč zadávejte pouze do formuláře na této stránce.`, 409);
  if (row.key_expires_at && Date.parse(row.key_expires_at) <= Date.now()) throw new VehicleError("KEY_EXPIRED", "API klíč expiroval. Připojte nový klíč na stránce nastavení.", 409);
  const assertCurrent = async () => {
    if ((await connection(userId))?.revision !== row.revision) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Zkuste načtení znovu.", 409);
  };
  const fromCache = async () => {
    await assertCurrent();
    const cached = await database().prepare("SELECT sealed, fetched_at, expires_at FROM vehicle_cache WHERE user_id = ? AND section = ? AND revision = ? AND expires_at > ?")
      .bind(userId, section, row.revision, Date.now()).first<Cached>();
    if (!cached) return null;
    const result = await unseal(cached.sealed, secret(), `cache:${userId}:${row.revision}:${section}`);
    await assertCurrent();
    const permission = await controlPermission(userId, row.revision);
    return { ...await present(result.data, kind, permission), fetchedAt: new Date(cached.fetched_at).toISOString(), cacheExpiresAt: new Date(cached.expires_at).toISOString(), cached: true, freshness: freshness(result.data, cached.fetched_at), api: { ...result.meta, quotaObservedAt: new Date(cached.fetched_at).toISOString(), quotaIsSnapshot: true } };
  };
  const cached = await fromCache();
  if (cached) return cached;
  const config = await unseal(row.sealed, secret(), `connection:${userId}:${row.revision}`);
  const hash = await vehicleHash(config.vin, secret());
  return withLease(hash, async () => {
    const result = await provider(hash, config, section === "position" ? ["parkingPosition"] : section === "profiles" ? ["chargingProfiles"] : SUMMARY_PARTS);
    const current = await connection(userId);
    if (!current || current.revision !== row.revision) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Zkuste načtení znovu.", 409);
    const now = Date.now();
    const expires = now + CACHE_SECONDS * 1000;
    const encrypted = await seal(result, secret(), `cache:${userId}:${row.revision}:${section}`);
    // Guard against a disconnect/reconnect while an upstream request was in flight.
    await database().batch([
      database().prepare("INSERT INTO vehicle_cache (user_id, section, revision, sealed, fetched_at, expires_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND revision = ?) ON CONFLICT(user_id, section) DO UPDATE SET revision=excluded.revision, sealed=excluded.sealed, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at")
        .bind(userId, section, row.revision, encrypted, now, expires, userId, row.revision),
      database().prepare("UPDATE connections SET key_expires_at = COALESCE(?, key_expires_at) WHERE user_id = ? AND revision = ?").bind(result.meta.keyExpiresAt, userId, row.revision),
      database().prepare("DELETE FROM vehicle_cache WHERE expires_at <= ?").bind(now),
    ]);
    // Re-check before disclosing data after a concurrent disconnect.
    if ((await connection(userId))?.revision !== row.revision) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Zkuste to znovu.", 409);
    const permission = await controlPermission(userId, row.revision);
    return { ...await present(result.data, kind, permission), fetchedAt: new Date(now).toISOString(), cacheExpiresAt: new Date(expires).toISOString(), cached: false, freshness: freshness(result.data, now), api: { ...result.meta, quotaObservedAt: new Date(now).toISOString(), quotaIsSnapshot: true } };
  }, fromCache);
}

async function controlPermission(userId: string, revision: string) {
  return database().prepare("SELECT * FROM control_permissions WHERE user_id = ? AND revision = ?").bind(userId, revision).first<Permission>();
}

// This setting is writable only through the authenticated, same-origin web route.
// No MCP tool can grant its own permission.
export async function setVentilationPermission(userId: string, input: unknown) { return setControlPermission(userId, "ventilation", input); }

export async function setControlPermission(userId: string, scope: ControlScope, input: unknown) {
  if (typeof scope !== "string" || !Object.hasOwn(scopeColumns, scope)) throw new VehicleError("INVALID_PERMISSION_INPUT", "Neplatná skupina ovládání.");
  const column = scopeColumns[scope];
  const value = input as { enabled?: unknown; connectionRevision?: unknown; acknowledgement?: unknown } | null;
  if (!value || Array.isArray(value) || Object.keys(value).some((key) => !["enabled", "connectionRevision", "acknowledgement"].includes(key)) || typeof value.enabled !== "boolean" || typeof value.connectionRevision !== "string" || (value.enabled && value.acknowledgement !== scopeAcknowledgements[scope])) throw new VehicleError("INVALID_PERMISSION_INPUT", "Pro povolení je potřeba výslovně potvrdit konkrétní skupinu ovládání.");
  const row = await connection(userId);
  if (!row || row.revision !== value.connectionRevision) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Obnovte stránku nastavení.", 409);
  if (value.enabled && row.key_expires_at && Date.parse(row.key_expires_at) <= Date.now()) throw new VehicleError("KEY_EXPIRED", "Nejdříve obnovte připojení s platným klíčem.", 409);
  const result = await database().prepare(`INSERT INTO control_permissions (user_id, revision, permission_version, ${column}, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND revision = ?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision, permission_version=excluded.permission_version, ${column}=excluded.${column}, updated_at=excluded.updated_at`)
    .bind(userId, row.revision, crypto.randomUUID(), value.enabled ? 1 : 0, Date.now(), userId, row.revision).run();
  if (!result.meta.changes) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Obnovte stránku nastavení.", 409);
  return getConnectionStatus(userId);
}

// Save the entire user-selected profile in one guarded mutation: no partial grants.
// This is a web setting, never an MCP tool or a request to operate the vehicle.
export async function setControlProfile(userId: string, input: unknown) {
  const value = controlProfileInput(input);
  const row = await connection(userId);
  if (!row || row.revision !== value.connectionRevision) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Obnovte stránku nastavení.", 409);
  if (value.enabled && row.key_expires_at && Date.parse(row.key_expires_at) <= Date.now()) throw new VehicleError("KEY_EXPIRED", "Nejdříve obnovte připojení s platným klíčem.", 409);
  const p = value.permissions;
  const encryptedSpin = value.spin === undefined ? null : await seal(value.spin, secret(), `spin:${userId}:${row.revision}`);
  const result = await database().batch([
    database().prepare("INSERT INTO control_permissions (user_id, revision, permission_version, ventilation_enabled, charging_enabled, air_conditioning_enabled, auxiliary_heating_enabled, sealed_spin, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND revision = ?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision, permission_version=excluded.permission_version, ventilation_enabled=excluded.ventilation_enabled, charging_enabled=excluded.charging_enabled, air_conditioning_enabled=excluded.air_conditioning_enabled, auxiliary_heating_enabled=excluded.auxiliary_heating_enabled, sealed_spin=CASE WHEN ? = 1 THEN excluded.sealed_spin ELSE control_permissions.sealed_spin END, updated_at=excluded.updated_at")
      .bind(userId, row.revision, crypto.randomUUID(), p.ventilation ? 1 : 0, p.charging ? 1 : 0, p.airConditioning ? 1 : 0, p.auxiliaryHeating ? 1 : 0, encryptedSpin, Date.now(), userId, row.revision, value.spin === undefined ? 0 : 1),
    database().prepare("UPDATE connections SET setup_completed = 1 WHERE user_id = ? AND revision = ?").bind(userId, row.revision),
  ]);
  if (!result[0].meta.changes || !result[1].meta.changes) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Obnovte stránku nastavení.", 409);
  return getConnectionStatus(userId);
}

async function requireControl(userId: string, row: Connection, scope: ControlScope, permissionVersion?: string) {
  const current = await connection(userId);
  const permission = await controlPermission(userId, row.revision);
  if (!current || current.revision !== row.revision) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Příkaz nebyl odeslán.", 409);
  if (current.key_expires_at && Date.parse(current.key_expires_at) <= Date.now()) throw new VehicleError("KEY_EXPIRED", "API klíč expiroval. Příkaz nebyl odeslán.", 409);
  if (permission?.[scopeColumns[scope]] !== 1 || (permissionVersion && permission.permission_version !== permissionVersion)) throw new VehicleError("CONTROL_NOT_ALLOWED", "Tato skupina ovládání není povolená. Povol ho výslovně ve stránce nastavení. Příkaz nebyl odeslán.", 403);
  return permission;
}

async function existingCommand(userId: string, requestId: string, revision: string, action: string, inputFingerprint: string) {
  const row = await database().prepare("SELECT * FROM vehicle_commands WHERE user_id = ? AND request_id = ?").bind(userId, requestId).first<Command>();
  if (!row) return null;
  if (row.revision !== revision || row.action !== action || (row.input_fingerprint !== null ? row.input_fingerprint !== inputFingerprint : !["start", "stop"].includes(action))) throw new VehicleError("REQUEST_ID_CONFLICT", "Tento identifikátor patří jinému příkazu nebo připojení. Nic nebylo odesláno.", 409);
  const stored = row.sealed_result ? await unseal(row.sealed_result, secret(), `command:${userId}:${revision}:${requestId}`) : { requestId, action, status: "pending", executionConfirmed: false, automaticRetryAllowed: false, message: "Příkaz se již zpracovává. Neodesílejte další příkaz ani nový identifikátor." };
  return { ...stored, reused: true };
}

async function saveCommandResult(userId: string, revision: string, requestId: string, result: Record<string, unknown>) {
  const encrypted = await seal(result, secret(), `command:${userId}:${revision}:${requestId}`);
  await database().prepare("UPDATE vehicle_commands SET status = ?, sealed_result = ?, updated_at = ? WHERE user_id = ? AND request_id = ? AND revision = ?")
    .bind(result.status, encrypted, Date.now(), userId, requestId, revision).run();
}

export async function executeVentilation(userId: string, action: VentilationAction, input: unknown) { return executeVehicleCommand(userId, action, input); }

export async function executeVehicleCommand(userId: string, action: string, input: unknown) {
  const { requestId, parameters } = commandInput(input, action);
  const definition = operationDefinition(action);
  const scope = definition.scope as ControlScope;
  const column = scopeColumns[scope];
  const inputFingerprint = await fingerprint(parameters);
  const row = await connection(userId);
  if (!row) throw new VehicleError("CONNECT_REQUIRED", "Nejdřív připojte své vozidlo.", 409);
  if (row.key_expires_at && Date.parse(row.key_expires_at) <= Date.now()) throw new VehicleError("KEY_EXPIRED", "Nejdříve obnovte API klíč.", 409);
  const previous = await existingCommand(userId, requestId, row.revision, action, inputFingerprint);
  if (previous) return previous;
  const permission = await requireControl(userId, row, scope);
  if (action === "start_auxiliary_heating" && !permission.sealed_spin) throw new VehicleError("HEATING_SPIN_REQUIRED", "S-PIN zadej pouze na přihlášené stránce nastavení, nikdy do chatu.", 409);
  const config = await unseal(row.sealed, secret(), `connection:${userId}:${row.revision}`);
  const hash = await vehicleHash(config.vin, secret());
  return withLease(hash, async (assertLease) => {
    const previous = await existingCommand(userId, requestId, row.revision, action, inputFingerprint);
    if (previous) return previous;
    await requireControl(userId, row, scope, permission.permission_version);
    const recent = await database().prepare("SELECT * FROM vehicle_commands WHERE vehicle_hash = ? AND created_at > ? AND (status IN ('pending', 'unknown') OR (status = 'accepted' AND action = ?)) ORDER BY created_at DESC LIMIT 1")
      .bind(hash, Date.now() - 60_000, action).first<Command>();
    if (recent) throw new VehicleError("COMMAND_RECENTLY_SENT", "Podobný nebo nepotvrzený příkaz už byl odeslán. Neopakujte ho automaticky; nejdřív zkontrolujte stav vozidla.", 409);
    const preflight = await provider(hash, config, [definition.part, "operations"]);
    const vehicle = preflight.data.vehicle as Record<string, any>;
    const capability = vehicle[definition.part];
    const reasons = preflight.data.errors.map((e: { type: string }) => e.type);
    if (reasons.includes(`${definition.prefix}_DISABLED`)) throw new VehicleError("OPERATION_DISABLED", "Služba je pro vozidlo zakázaná. Příkaz nebyl odeslán.", 422);
    if (reasons.includes(`${definition.prefix}_UNSUPPORTED`) || capability?.state === "UNSUPPORTED") throw new VehicleError("OPERATION_UNSUPPORTED", "Vozidlo tuto funkci nepodporuje. Příkaz nebyl odeslán.", 422);
    if (reasons.includes(`${definition.prefix}_UNAVAILABLE`) || reasons.includes("OPERATIONS_UNAVAILABLE") || !capability || !Array.isArray(vehicle.operations)) throw new VehicleError("CAPABILITIES_UNAVAILABLE", "Podporu funkce se nepodařilo ověřit. Příkaz nebyl odeslán.", 503);
    if (!vehicle.operations.some((o: { name: string }) => o.name === definition.operationId)) throw new VehicleError("OPERATION_UNSUPPORTED", "Požadovaná operace není podporovaná. Příkaz nebyl odeslán.", 422);
    let dispatchParameters = parameters;
    if (action === "set_charge_mode" && Array.isArray(capability.settings?.availableChargeModes) && !capability.settings.availableChargeModes.includes(parameters.chargeMode)) throw new VehicleError("CHARGE_MODE_UNAVAILABLE", "Tento režim vozidlo aktuálně nenabízí. Příkaz nebyl odeslán.", 422);
    if (action === "update_charging_profile") {
      const profile = capability.profiles?.find((p: { id: number }) => p.id === parameters.profileId);
      if (!profile) throw new VehicleError("PROFILE_NOT_FOUND", "Profil v aktuálních datech není. Nic nebylo změněno.", 404);
      if (await fingerprint(profile) !== parameters.expectedProfileFingerprint) throw new VehicleError("PROFILE_CHANGED", "Profil se od posledního přečtení změnil. Načti jej a potvrď zamýšlenou změnu znovu.", 409);
      dispatchParameters = { profileId: parameters.profileId, profile: mergeChargingProfile(profile, parameters.changes) };
    }
    if (preflight.meta.remaining === null || preflight.meta.remaining < 2) throw new VehicleError("COMMAND_QUOTA_RESERVE_REQUIRED", "Pro příkaz a ověření výsledku není potvrzený dostatečný zůstatek API. Příkaz nebyl odeslán.", 429, preflight.meta.resetAfterSeconds);
    await requireControl(userId, row, scope, permission.permission_version);
    const reservedAt = Date.now();
    const reserved = await database().prepare(`INSERT INTO vehicle_commands (user_id, request_id, revision, vehicle_hash, action, input_fingerprint, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND revision = ?) AND EXISTS (SELECT 1 FROM control_permissions WHERE user_id = ? AND revision = ? AND permission_version = ? AND ${column} = 1)`)
      .bind(userId, requestId, row.revision, hash, action, inputFingerprint, reservedAt, reservedAt, userId, row.revision, userId, row.revision, permission.permission_version).run();
    if (!reserved.meta.changes) throw new VehicleError("CONTROL_NOT_ALLOWED", "Povolení nebo připojení se změnilo. Příkaz nebyl odeslán.", 403);
    // Invalidate both ordinary and profile data for the acting account.
    await database().prepare("DELETE FROM vehicle_cache WHERE user_id = ? AND section IN ('summary-v2', 'profiles')").bind(userId).run();
    let accepted;
    let sentAt = reservedAt;
    try {
      const currentPermission = await requireControl(userId, row, scope, permission.permission_version);
      const sendConfig = action === "start_auxiliary_heating" ? { ...config, spin: await unseal(currentPermission.sealed_spin!, secret(), `spin:${userId}:${row.revision}`) } : config;
      await requireControl(userId, row, scope, permission.permission_version);
      await assertLease();
      sentAt = Date.now();
      accepted = await sendVehicleCommand(sendConfig, action, dispatchParameters);
    } catch (cause) {
      const error = cause instanceof VehicleError ? cause : new VehicleError("COMMAND_OUTCOME_UNKNOWN", "Výsledek příkazu není známý. Neopakujte jej automaticky.", 503);
      if (!(cause instanceof VehicleError)) error.commandMayHaveBeenSent = true;
      if (error.meta) await recordQuota(hash, error.meta, error.status === 429 || (error.status === 503 && error.retryAfter !== null) ? error.code : null);
      error.noAutomaticRetry = true;
      const result = { requestId, action, status: error.commandMayHaveBeenSent ? "unknown" : "rejected", executionConfirmed: false, automaticRetryAllowed: false, error: safeError(error), sentAt: new Date(sentAt).toISOString(), message: error.message };
      await saveCommandResult(userId, row.revision, requestId, result);
      return result;
    }
    const result: Record<string, unknown> = { requestId, action, status: "accepted", executionConfirmed: false, automaticRetryAllowed: false, sentAt: new Date(sentAt).toISOString(), message: "Požadavek byl přijat. Změna stavu vozidla zatím není potvrzená.", verification: { status: "not_checked" } };
    // Persist acceptance before any fallible bookkeeping/verification.
    await saveCommandResult(userId, row.revision, requestId, result);
    await recordQuota(hash, accepted.meta);
    if ((await connection(userId))?.revision !== row.revision) result.verification = { status: "not_checked", reason: "connection_changed_after_send" };
    else if (accepted.meta.remaining !== null && accepted.meta.remaining > 0) {
      try {
        const observation = await provider(hash, config, [definition.part]);
        if ((await connection(userId))?.revision !== row.revision) result.verification = { status: "not_checked", reason: "connection_changed_during_verification" };
        else {
          const verification = commandObservation(definition, dispatchParameters, observation.data.vehicle, sentAt, Date.now());
          result.executionConfirmed = verification.status === "confirmed";
          result.verification = verification;
          if (result.executionConfirmed) result.message = "Požadavek byl přijat a nový stav potvrzuje následné měření vozidla.";
        }
      } catch (cause) { result.verification = { status: "unavailable", error: safeError(cause) }; }
    } else result.verification = { status: "not_checked", reason: "quota_unknown_or_exhausted" };
    await saveCommandResult(userId, row.revision, requestId, result);
    await database().prepare("DELETE FROM vehicle_commands WHERE user_id = ? AND created_at < ?").bind(userId, Date.now() - 30 * 86400_000).run();
    return result;
  }, () => existingCommand(userId, requestId, row.revision, action, inputFingerprint), 90_000);
}

export async function setHeatingSpin(userId: string, input: unknown) {
  const value = input as { connectionRevision?: unknown; spin?: unknown } | null;
  if (!value || Array.isArray(value) || Object.keys(value).some((key) => !["connectionRevision", "spin"].includes(key)) || typeof value.connectionRevision !== "string" || (value.spin !== null && (typeof value.spin !== "string" || !/^[\x21-\x7E]{1,128}$/.test(value.spin)))) throw new VehicleError("INVALID_SPIN_INPUT", "Zadejte S-PIN pouze v nastavení, nebo jej smažte.");
  const row = await connection(userId);
  if (!row || row.revision !== value.connectionRevision) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Obnovte stránku.", 409);
  const encrypted = value.spin === null ? null : await seal(value.spin, secret(), `spin:${userId}:${row.revision}`);
  const result = await database().prepare("INSERT INTO control_permissions (user_id, revision, permission_version, sealed_spin, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND revision = ?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision, permission_version=excluded.permission_version, sealed_spin=excluded.sealed_spin, updated_at=excluded.updated_at")
    .bind(userId, row.revision, crypto.randomUUID(), encrypted, Date.now(), userId, row.revision).run();
  if (!result.meta.changes) throw new VehicleError("CONNECTION_CHANGED", "Připojení se změnilo. Obnovte stránku.", 409);
  return getConnectionStatus(userId);
}
