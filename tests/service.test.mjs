import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

const sqlite = new DatabaseSync(":memory:");
// Keep the database clock aligned with the controllable service clock.
sqlite.function("unixepoch", { varargs: true }, () => Date.now() / 1000);
for (const name of readdirSync(new URL("../drizzle/", import.meta.url)).filter((p) => p.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
function statement(sql, values = []) {
  return {
    bind(...args) { return statement(sql, args); },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async run() { const info = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(info.changes) } }; },
  };
}
const db = { prepare: statement, async batch(statements) {
  sqlite.exec("BEGIN");
  try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec("COMMIT"); return results; }
  catch (e) { sqlite.exec("ROLLBACK"); throw e; }
} };
globalThis.__vehicleTestEnv = { DB: db, VEHICLE_VAULT_KEY: randomBytes(32).toString("base64") };
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__vehicleTestEnv", shortCircuit: true };
  return next(specifier, context);
} });
const { connectVehicle, disconnectVehicle, readVehicle, getConnectionStatus } = await import("../lib/vehicle-service.ts");
const vinA = "TMBJB9NY5RF999999", vinB = "TMBJB9NY5RF999998";
let upstreamCalls = 0;
let providerStatus = 200;
let hold = null;
let providerType = "rate-limit-exceeded";
let remaining = "17";
const requests = [];
globalThis.fetch = async (url, options) => {
  upstreamCalls++;
  requests.push({ parts: url.searchParams.get("include"), method: options.method });
  if (hold) await hold;
  if (providerStatus !== 200) return Response.json({ type: providerType, detail: options.headers["X-API-Key"] }, { status: providerStatus, headers: { "Retry-After": "60", "RateLimit-Remaining": remaining, "RateLimit-Reset": "60" } });
  const vin = url.pathname.split("/").pop();
  const a = vin === vinA;
  assert((a ? ["key-a", "key-a-other"] : ["key-b"]).includes(options.headers["X-API-Key"]));
  const include = url.searchParams.get("include");
  const vehicle = { vin, name: options.headers["X-API-Key"] === "key-a-other" ? "Scoped other" : a ? "Auto A" : "Auto B", licensePlate: "PRIVATEPLATE", renderUrl: "https://example.test/car.png" };
  if (include.includes("status")) vehicle.status = { overall: { locked: a ? "YES" : "NO" }, carCapturedTimestamp: "2026-10-30T08:00:00Z" };
  if (include.split(",").includes("charging")) vehicle.charging = { isVehicleInSavedLocation: false, status: { plugConnectionState: "CONNECTED", plugLockState: "UNLOCKED", battery: { stateOfChargeInPercent: a ? 61 : 42 } } };
  if (include.includes("parkingPosition")) vehicle.parkingPosition = { state: "PARKED", gpsCoordinates: { latitude: a ? 50 : 49, longitude: 14 } };
  if (include.includes("chargingProfiles")) vehicle.chargingProfiles = { profiles: [{ id: 1, name: "HOME", settings: { targetStateOfChargeInPercent: 80 }, preferredChargingTimes: [{ id: 2, enabled: true, startTime: "22:00", endTime: "06:00" }], timers: [{ id: 3, enabled: true, time: "07:00", type: "RECURRING", recurringOn: ["MONDAY"] }] }], currentVehiclePositionProfile: { id: 1, name: "HOME" } };
  if (include.includes("activeVentilation")) vehicle.activeVentilation = { state: "OFF", durationInSeconds: 600 };
  if (include.includes("operations")) vehicle.operations = [{ name: "startActiveVentilation" }, { name: "stopActiveVentilation" }];
  return Response.json({ vehicle, errors: [{ type: "AIR_CONDITIONING_UNSUPPORTED" }] }, { headers: { "RateLimit-Limit": "20", "RateLimit-Remaining": remaining, "RateLimit-Reset": "1000", "X-API-Key-Expires-At": "2099-01-01T00:00:00Z" } });
};
test("real service SQL: users, encrypted storage, cache, location, disconnect and backoff", async () => {
  assert.deepEqual((await getConnectionStatus("a")).connected, false);
  await connectVehicle("a", { vin: vinA, apiKey: "key-a" });
  await connectVehicle("b", { vin: vinB, apiKey: "key-b" });
  assert.equal(upstreamCalls, 2);
  const rows = sqlite.prepare("SELECT * FROM connections").all();
  assert(!JSON.stringify(rows).includes("key-a")); assert(!JSON.stringify(rows).includes(vinA));
  const a = await readVehicle("a", "overview");
  const b = await readVehicle("b", "overview");
  assert.equal(a.vehicle.name, "Auto A"); assert.equal(b.vehicle.name, "Auto B");
  assert(!("parkingPosition" in a.vehicle)); assert.equal(upstreamCalls, 4);
  const again = await readVehicle("a", "charging");
  assert.equal(again.cached, true); assert.equal(again.vehicle.charging.status.battery.stateOfChargeInPercent, 61); assert.equal(upstreamCalls, 4);
  const location = await readVehicle("a", "position");
  assert.equal(location.vehicle.parkingPosition.gpsCoordinates.latitude, 50); assert.equal(upstreamCalls, 5);
  await assert.rejects(readVehicle("unconnected", "overview"), (e) => e.code === "CONNECT_REQUIRED");
  assert.equal(upstreamCalls, 5);
  const recordA = sqlite.prepare("SELECT * FROM connections WHERE user_id='a'").get();
  sqlite.prepare("UPDATE connections SET sealed=? WHERE user_id='b'").run(recordA.sealed);
  await assert.rejects(getConnectionStatus("b"), (e) => e.code === "VAULT_ERROR");
  await disconnectVehicle("a");
  assert.equal(sqlite.prepare("SELECT count(*) as n FROM vehicle_cache WHERE user_id='a'").get().n, 0);
  await assert.rejects(readVehicle("a", "overview"), (e) => e.code === "CONNECT_REQUIRED");
  await connectVehicle("a", { vin: vinA, apiKey: "key-a" });
  providerStatus = 429;
  remaining = "0";
  await assert.rejects(readVehicle("a", "overview"), (e) => e.code === "RATE_LIMITED");
  const callsBefore = upstreamCalls;
  await assert.rejects(readVehicle("a", "overview"), (e) => e.code === "RATE_LIMITED");
  assert.equal(upstreamCalls, callsBefore);
  providerStatus = 200;
  remaining = "17";
  sqlite.exec("DELETE FROM vehicle_quotas");
  // An in-flight response may not restore a disconnected user's cache.
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const pending = readVehicle("a", "overview");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await disconnectVehicle("a"); release(); hold = null;
  await assert.rejects(pending, (e) => e.code === "CONNECTION_CHANGED");
  assert.equal(sqlite.prepare("SELECT count(*) as n FROM vehicle_cache WHERE user_id='a'").get().n, 0);
});

test("V2 SQL service: concurrent views coalesce, privacy sections and revisions stay isolated", async () => {
  sqlite.exec("DELETE FROM connections; DELETE FROM vehicle_cache; DELETE FROM vehicle_quotas; DELETE FROM request_leases; DELETE FROM connection_attempts; UPDATE connection_gate SET window_start=0, attempts=0, last_token=NULL WHERE id=1;");
  providerStatus = 200; remaining = "17";
  await connectVehicle("v2", { vin: vinA, apiKey: "key-a" });
  const before = upstreamCalls;
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const reads = [readVehicle("v2", "overview"), readVehicle("v2", "status"), readVehicle("v2", "climate"), readVehicle("v2", "capabilities"), readVehicle("v2", "energy")];
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(upstreamCalls, before + 1);
  release(); hold = null;
  const [overview, status, climate, capabilities, energy] = await Promise.all(reads);
  assert.equal(upstreamCalls, before + 1);
  assert.equal([overview, status, climate, capabilities, energy].filter((r) => !r.cached).length, 1);
  assert([overview, status, climate, capabilities, energy].every((r) => r.fetchedAt === overview.fetchedAt));
  assert.deepEqual(status.errors, []);
  assert.equal(status.diagnostics.sourceErrors[0].type, "AIR_CONDITIONING_UNSUPPORTED");
  assert.equal(climate.normalized.activeVentilation.configuredRunDurationSeconds, 600);
  assert.equal(capabilities.vehicle.operations[0].name, "startActiveVentilation");
  assert.equal(capabilities.normalized.operations.integrationControlEnabled, false);
  assert.equal(energy.normalized.energy.batteryStateOfChargePercent, 61);
  assert.equal(status.fetchedAt, overview.fetchedAt); assert.equal(status.api.quotaIsSnapshot, true);
  assert(!JSON.stringify(overview).includes("PRIVATEPLATE"));
  assert(!JSON.stringify(overview).includes("HOME"));
  assert(!requests.at(-1).parts.includes("parkingPosition")); assert(!requests.at(-1).parts.includes("chargingProfiles"));
  const profiles = await readVehicle("v2", "profiles");
  assert.equal(upstreamCalls, before + 2); assert.equal(requests.at(-1).parts, "chargingProfiles");
  assert.equal(profiles.vehicle.chargingProfiles.profiles[0].timers[0].recurringOn[0], "MONDAY");
  assert.equal(profiles.vehicle.chargingProfiles.currentVehiclePositionProfile.name, "HOME");
  await readVehicle("v2", "position");
  assert.equal(requests.at(-1).parts, "parkingPosition");
  assert.equal((await readVehicle("v2", "overview")).vehicle.chargingProfiles, undefined);
  const localBefore = upstreamCalls;
  const connectionStatus = await getConnectionStatus("v2");
  assert.equal(upstreamCalls, localBefore); assert.equal(connectionStatus.sourceVerification, "not_performed");
  assert(connectionStatus.lastQuotaResponseAt); assert.equal(connectionStatus.api.lastReportedRemaining, 17);
  await connectVehicle("scoped", { vin: vinA, apiKey: "key-a-other" });
  assert.equal((await readVehicle("scoped", "overview")).vehicle.name, "Scoped other");
  assert.equal((await readVehicle("v2", "overview")).vehicle.name, "Auto A");
  await connectVehicle("v2", { vin: vinA, apiKey: "key-a-other" });
  assert.equal((await readVehicle("v2", "overview")).vehicle.name, "Scoped other");
  assert(requests.every((r) => r.method === "GET"));
  await assert.rejects(readVehicle("v2", "bogus"), (e) => e.code === "INVALID_VIEW");
});

test("cached readers succeed after the last quota token; errors preserve refusal reason", async () => {
  sqlite.exec("DELETE FROM connections; DELETE FROM vehicle_cache; DELETE FROM vehicle_quotas; DELETE FROM request_leases; DELETE FROM connection_attempts; UPDATE connection_gate SET window_start=0, attempts=0, last_token=NULL WHERE id=1;");
  providerStatus = 200; remaining = "17";
  await connectVehicle("quota", { vin: vinA, apiKey: "key-a" });
  remaining = "0";
  const before = upstreamCalls;
  const [a, b] = await Promise.all([readVehicle("quota", "overview"), readVehicle("quota", "status")]);
  assert.equal(upstreamCalls, before + 1); assert.equal([a, b].filter((r) => !r.cached).length, 1); assert.equal(a.fetchedAt, b.fetchedAt); assert.equal(a.api.remaining, 0);
  const consumed = upstreamCalls;
  await assert.rejects(readVehicle("quota", "position"), (e) => e.code === "RATE_LIMITED");
  assert.equal(upstreamCalls, consumed);
  sqlite.exec("DELETE FROM vehicle_quotas; DELETE FROM vehicle_cache;");
  providerStatus = 429; providerType = "vehicle-not-accepting-requests"; remaining = "17";
  await assert.rejects(readVehicle("quota", "overview"), (e) => e.code === "VEHICLE_NOT_ACCEPTING_REQUESTS");
  const refused = upstreamCalls;
  await assert.rejects(readVehicle("quota", "overview"), (e) => e.code === "VEHICLE_NOT_ACCEPTING_REQUESTS");
  assert.equal(upstreamCalls, refused);
  sqlite.exec("DELETE FROM vehicle_quotas;");
  providerStatus = 503; providerType = "about:blank";
  await assert.rejects(readVehicle("quota", "overview"), (e) => e.status === 503);
  const unavailable = upstreamCalls;
  await assert.rejects(readVehicle("quota", "overview"), (e) => e.code === "UPSTREAM_503");
  assert.equal(upstreamCalls, unavailable);
  providerStatus = 200; providerType = "rate-limit-exceeded";
});

test("cache refresh at the exact TTL boundary coalesces readers and preserves provider measurement times", async (t) => {
  sqlite.exec("DELETE FROM connections; DELETE FROM vehicle_cache; DELETE FROM vehicle_quotas; DELETE FROM request_leases; DELETE FROM connection_attempts; UPDATE connection_gate SET window_start=0, attempts=0, last_token=NULL WHERE id=1;");
  providerStatus = 200; remaining = "17";
  let now = Date.parse("2026-10-30T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const originalFetch = globalThis.fetch;
  let generation = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await originalFetch(url, options);
    if (!url.searchParams.get("include").split(",").includes("status")) return response;
    generation++;
    const body = await response.json();
    body.vehicle.status = { overall: { locked: generation === 1 ? "YES" : "NO" }, carCapturedTimestamp: generation === 1 ? "2026-10-30T08:00:00Z" : "2026-10-30T09:00:00Z" };
    // Unchanged source measurements must not be made fresh by retrieval.
    body.vehicle.odometer = { mileageInKm: 71181, carCapturedTimestamp: "2026-10-30T08:00:00Z" };
    return Response.json(body, { status: response.status, headers: response.headers });
  });
  await connectVehicle("expiry", { vin: vinA, apiKey: "key-a" });
  const first = await readVehicle("expiry", "overview");
  const callsAfterFirstRead = upstreamCalls;
  const firstFetchedAt = now;
  assert.equal(first.cached, false);
  assert.equal(Date.parse(first.cacheExpiresAt) - Date.parse(first.fetchedAt), 180_000);
  assert.equal(first.vehicle.status.overall.locked, "YES");

  now += 179_999;
  const beforeExpiry = await readVehicle("expiry", "overview");
  assert.equal(beforeExpiry.cached, true);
  assert.equal(beforeExpiry.fetchedAt, first.fetchedAt);
  assert.equal(beforeExpiry.freshness.parts.status.measuredAt, first.freshness.parts.status.measuredAt);
  assert.equal(upstreamCalls, callsAfterFirstRead);

  now += 1;
  const refreshed = await Promise.all([readVehicle("expiry", "overview"), readVehicle("expiry", "status"), readVehicle("expiry", "climate")]);
  assert.equal(upstreamCalls, callsAfterFirstRead + 1);
  assert.equal(generation, 2);
  assert.equal(refreshed.filter((r) => !r.cached).length, 1);
  assert(refreshed.every((r) => Date.parse(r.fetchedAt) === firstFetchedAt + 180_000));
  assert(refreshed.every((r) => Date.parse(r.cacheExpiresAt) === firstFetchedAt + 360_000));
  const overview = refreshed[0];
  assert.equal(overview.vehicle.status.overall.locked, "NO");
  assert.equal(overview.freshness.parts.status.measuredAt, "2026-10-30T09:00:00Z");
  assert.notEqual(overview.freshness.parts.status.measuredAt, overview.fetchedAt);
  assert.equal(overview.freshness.parts.odometer.measuredAt, first.freshness.parts.odometer.measuredAt);
  assert.equal(overview.freshness.parts.odometer.ageSeconds, first.freshness.parts.odometer.ageSeconds + 180);
  assert.equal(overview.freshness.cacheAgeSeconds, 0);

  now += 1;
  const cachedAgain = await readVehicle("expiry", "overview");
  assert.equal(cachedAgain.cached, true);
  assert.equal(cachedAgain.fetchedAt, overview.fetchedAt);
  assert.equal(upstreamCalls, callsAfterFirstRead + 1);
});

test("a failed refresh never returns expired data as a successful fresh response", async (t) => {
  sqlite.exec("DELETE FROM connections; DELETE FROM vehicle_cache; DELETE FROM vehicle_quotas; DELETE FROM request_leases; DELETE FROM connection_attempts; UPDATE connection_gate SET window_start=0, attempts=0, last_token=NULL WHERE id=1;");
  providerStatus = 200; remaining = "17";
  t.after(() => { providerStatus = 200; providerType = "rate-limit-exceeded"; });
  let now = Date.parse("2026-10-30T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  await connectVehicle("failed-refresh", { vin: vinA, apiKey: "key-a" });
  const original = await readVehicle("failed-refresh", "overview");
  now = Date.parse(original.cacheExpiresAt);
  providerStatus = 503; providerType = "about:blank";
  const callsBefore = upstreamCalls;
  await assert.rejects(readVehicle("failed-refresh", "overview"), (e) => e.code === "UPSTREAM_503" && e.status === 503);
  assert.equal(upstreamCalls, callsBefore + 1);
  const row = sqlite.prepare("SELECT * FROM vehicle_cache WHERE user_id = ? AND section = ?").get("failed-refresh", "summary-v2");
  assert.equal(row.fetched_at, Date.parse(original.fetchedAt));
  assert(row.expires_at <= now);
  await assert.rejects(readVehicle("failed-refresh", "overview"), (e) => e.code === "UPSTREAM_503");
  assert.equal(upstreamCalls, callsBefore + 1);
});
