import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

// Real migrations and service/route SQL; all provider traffic is a GET-only fixture.
const sql = new DatabaseSync(":memory:");
// Keep the database clock aligned with the controllable service clock.
sql.function("unixepoch", { varargs: true }, () => Date.now() / 1000);
for (const f of readdirSync(new URL("../drizzle/", import.meta.url)).filter(x => x.endsWith(".sql")).sort()) sql.exec(readFileSync(new URL("../drizzle/" + f, import.meta.url), "utf8"));
let beforeCommit = null;
function statement(query, args = []) {
  const run = () => ({ meta: { changes: Number(sql.prepare(query).run(...args).changes) } });
  return { bind(...v) { return statement(query, v); }, async first() { return sql.prepare(query).get(...args) ?? null; }, runSync: run, async run() { return run(); }, query };
}
const db = { prepare: statement, async batch(ss) {
  if (ss.some(s => s.query.startsWith("INSERT INTO connections"))) beforeCommit?.();
  // D1 batches are atomic/serialized; keep the in-memory adapter equally atomic.
  sql.exec("BEGIN");
  try { const result = ss.map(s => s.runSync()); sql.exec("COMMIT"); return result; }
  catch (e) { sql.exec("ROLLBACK"); throw e; }
} };
globalThis.__securityFixEnv = { DB: db, VEHICLE_VAULT_KEY: randomBytes(32).toString("base64") };
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__securityFixEnv", shortCircuit: true };
  if (/\/lib\/(vehicle-service|http)$/.test(specifier)) return next(specifier + ".ts", context);
  return next(specifier, context);
} });
const service = await import("../lib/vehicle-service.ts");
const { CONNECTION_LIMITS: limits } = await import("../lib/connection-admission.ts");
const { vehicleHash } = await import("../lib/skoda-core.mjs");
const { dispatchMcp } = await import("../lib/mcp.ts");
const { POST: connectRoute } = await import("../app/api/connection/route.ts");
const A = "TMBJB9NY5RF111111", B = "TMBJB9NY5RF222222";
const candidate = i => "TMBJB9NY5RF" + String(300000 + i);
const connect = (user, vin = A, apiKey = "alice-key") => service.connectVehicle(user, { vin, apiKey });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let now, calls, onInvalid, onValid, invalidReply;
test.beforeEach(t => {
  for (const table of ["connections", "vehicle_cache", "vehicle_quotas", "request_leases", "control_permissions", "vehicle_commands", "connection_attempts"]) sql.exec(`DELETE FROM ${table}`);
  sql.exec("UPDATE connection_gate SET window_start=0, attempts=0, last_token=NULL WHERE id=1");
  now = Date.parse("2026-10-31T12:00:00Z"); calls = []; onInvalid = null; onValid = null; beforeCommit = null;
  invalidReply = () => Response.json({ type: "about:blank" }, { status: 401 });
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url.origin, "https://public.api.connect.skoda-auto.cz");
    assert.equal(init.method, "GET", "Security regression must never dispatch a car command");
    const vin = url.pathname.split("/").at(-1), key = init.headers["X-API-Key"];
    calls.push({ vin, key, include: url.searchParams.get("include") });
    if (!((vin === A && ["alice-key", "other-key"].includes(key)) || (vin === B && key === "bob-key"))) {
      await onInvalid?.(); return invalidReply(vin);
    }
    const response = Response.json({ vehicle: { vin, name: key, status: { overall: { locked: "YES" } },
      parkingPosition: { state: "PARKED", gpsCoordinates: { latitude: vin === A ? 50 : 49, longitude: 14 } },
      activeVentilation: { state: "OFF" }, operations: [{ name: "startActiveVentilation" }, { name: "stopActiveVentilation" }] }, errors: [] },
    { headers: { "RateLimit-Remaining": "19", "RateLimit-Limit": "20", "RateLimit-Reset": "3600", "X-API-Key-Expires-At": "2099-01-01T00:00:00Z" } });
    return onValid ? await onValid(response) : response;
  });
});

test("two accounts isolate location, same-VIN cache, permissions, PIN, ciphertext and disconnect", async () => {
  await connect("alice"); await connect("bob", B, "bob-key");
  assert.equal((await service.readVehicle("alice", "position")).vehicle.parkingPosition.gpsCoordinates.latitude, 50);
  assert.equal((await service.readVehicle("bob", "position")).vehicle.parkingPosition.gpsCoordinates.latitude, 49);
  await connect("same-vin", A, "other-key");
  assert.equal((await service.readVehicle("same-vin", "overview")).vehicle.name, "other-key");
  assert.equal((await service.readVehicle("alice", "overview")).vehicle.name, "alice-key");
  const override = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_parking_position", arguments: { userId: "alice", vin: A } } }, "bob", { read: service.readVehicle });
  assert.equal(override.error.code, -32602);
  const status = await service.getConnectionStatus("alice");
  await assert.rejects(service.setControlPermission("bob", "ventilation", { enabled: true, connectionRevision: status.connectionRevision, acknowledgement: "ALLOW_VENTILATION_CONTROL" }), e => e.code === "CONNECTION_CHANGED");
  await assert.rejects(service.setHeatingSpin("bob", { connectionRevision: status.connectionRevision, spin: "1234" }), e => e.code === "CONNECTION_CHANGED");
  const before = calls.length;
  await assert.rejects(service.executeVehicleCommand("bob", "start", { requestId: randomUUID(), confirmation: "START_VENTILATION" }), e => e.code === "CONTROL_NOT_ALLOWED");
  assert.equal(calls.length, before);
  const a = sql.prepare("SELECT sealed FROM connections WHERE user_id='alice'").get(), b = sql.prepare("SELECT sealed FROM connections WHERE user_id='bob'").get();
  sql.prepare("UPDATE connections SET sealed=? WHERE user_id='bob'").run(a.sealed);
  await assert.rejects(service.getConnectionStatus("bob"), e => e.code === "VAULT_ERROR");
  sql.prepare("UPDATE connections SET sealed=? WHERE user_id='bob'").run(b.sealed);
  await service.disconnectVehicle("bob");
  assert.equal((await service.getConnectionStatus("alice")).connected, true);
  assert.equal((await service.getConnectionStatus("bob")).connected, false);
});

test("32 changing-VIN route attempts make one GET, no shared rows; disconnect cannot reset limits", async () => {
  const route = i => connectRoute(new Request("https://fixture.invalid/api/connection", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://fixture.invalid", "oai-authenticated-user-id": "attacker" },
    body: JSON.stringify({ vin: candidate(i), apiKey: "bad-key-" + i, userId: "other-account" }) }));
  assert.equal((await route(0)).status, 401);
  for (let i = 1; i < 32; i++) { const r = await route(i); assert.equal(r.status, 429); assert.equal(r.headers.get("Retry-After"), "30"); }
  assert.equal(calls.length, 1);
  assert.equal(sql.prepare("SELECT count(*) n FROM vehicle_quotas").get().n, 0);
  assert.equal(sql.prepare("SELECT count(*) n FROM request_leases").get().n, 0);
  assert.equal(sql.prepare("SELECT count(*) n FROM connection_attempts").get().n, 1);
  await service.disconnectVehicle("attacker");
  assert.equal((await route(33)).status, 429); assert.equal(calls.length, 1);
  assert.equal(sql.prepare("SELECT attempts FROM connection_gate").get().attempts, 1);
  for (let i = 1; i < limits.accountAttempts; i++) { now += limits.failureDelayMs; assert.equal((await route(40 + i)).status, 401); }
  now += limits.failureDelayMs;
  assert.equal((await route(50)).status, 429); assert.equal(calls.length, limits.accountAttempts);
  await connect("ordinary-other-user", B, "bob-key");
  now = Date.parse("2026-10-31T12:00:00Z") + limits.windowMs;
  assert.equal((await route(51)).status, 401);
  assert.equal(sql.prepare("SELECT attempts FROM connection_attempts WHERE user_id='attacker'").get().attempts, 1);
});

test("a held wrong key for the victim VIN cannot hold its lease or delay an uncached read", async () => {
  await connect("victim");
  const entered = deferred(), release = deferred();
  onInvalid = async () => { entered.resolve(); await release.promise; };
  const rejected = assert.rejects(connect("attacker", A, "bad"), e => e.code === "UPSTREAM_401");
  await entered.promise;
  assert.equal(sql.prepare("SELECT count(*) n FROM request_leases").get().n, 0);
  const outcome = await Promise.race([service.readVehicle("victim", "status"), new Promise(resolve => setTimeout(() => resolve(null), 500))]);
  release.resolve(); await rejected;
  assert(outcome, "Victim read must complete before invalid verification is released");
  assert.equal(outcome.vehicle.name, "alice-key");
  assert.equal((await service.getConnectionStatus("attacker")).connected, false);
});

test("candidate errors with empty/quota headers, backoff, mismatched VIN or redirects cannot poison shared state", async () => {
  await connect("victim");
  const initial = sql.prepare("SELECT * FROM vehicle_quotas").all();
  const replies = [
    () => Response.json({}, { status: 401 }),
    () => Response.json({}, { status: 403, headers: { "RateLimit-Remaining": "0", "RateLimit-Reset": "99999" } }),
    () => Response.json({ type: "rate-limit-exceeded" }, { status: 429, headers: { "Retry-After": "99999" } }),
    () => Response.json({}, { status: 503, headers: { "Retry-After": "99999" } }),
    () => Response.json({ vehicle: { vin: B } }, { headers: { "RateLimit-Remaining": "0" } }),
    () => new Response(null, { status: 302, headers: { Location: "https://other.invalid" } }),
  ];
  for (let i = 0; i < replies.length; i++) {
    invalidReply = replies[i]; await assert.rejects(connect("bad-" + i, A, "bad"));
    assert.deepEqual(sql.prepare("SELECT * FROM vehicle_quotas").all(), initial);
    assert.equal(sql.prepare("SELECT count(*) n FROM request_leases").get().n, 0);
  }
  assert.equal((await service.readVehicle("victim", "status")).vehicle.name, "alice-key");
});

test("concurrent same-account submissions admit once across independent requests", async () => {
  const entered = deferred(), release = deferred();
  onInvalid = async () => { entered.resolve(); await release.promise; };
  const pending = Array.from({ length: 32 }, (_, i) => connect("one-account", candidate(i), "bad-" + i).then(() => "ok", e => e.code));
  await entered.promise;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(sql.prepare("SELECT attempts FROM connection_gate").get().attempts, 1);
  release.resolve();
  const codes = await Promise.all(pending);
  assert.equal(codes.filter(x => x === "CONNECTION_ATTEMPT_LIMITED").length, 31);
  assert.equal(codes.filter(x => x === "UPSTREAM_401").length, 1);
});

test("global concurrent gate rejects before allocation and recovers without affecting established reads", async () => {
  await connect("victim");
  const release = deferred(); onInvalid = () => release.promise;
  const pending = Array.from({ length: 24 }, (_, i) => connect("parallel-" + i, candidate(i), "bad").then(() => "ok", e => e.code));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 1 + limits.concurrent);
  assert.equal(sql.prepare("SELECT count(*) n FROM connection_attempts WHERE expires_at > ?").get(now).n, limits.concurrent);
  assert.equal(sql.prepare("SELECT count(*) n FROM connection_attempts").get().n, 1 + limits.concurrent);
  assert.equal((await service.readVehicle("victim", "status")).vehicle.name, "alice-key");
  release.resolve();
  const codes = await Promise.all(pending);
  assert.equal(codes.filter(x => x === "CONNECTION_ATTEMPT_LIMITED").length, 24 - limits.concurrent);
  onInvalid = null;
  await connect("new-ordinary-user", B, "bob-key");
});

test("global window bounds changing-account allocations, then resets and expires idle state", async () => {
  for (let i = 0; i < limits.globalAttempts; i++) await assert.rejects(connect("account-" + i, candidate(i), "bad"), e => e.code === "UPSTREAM_401");
  for (let i = 0; i < 50; i++) await assert.rejects(connect("denied-" + i, candidate(i), "bad"), e => e.code === "CONNECTION_ATTEMPT_LIMITED");
  assert.equal(calls.length, limits.globalAttempts);
  assert.equal(sql.prepare("SELECT count(*) n FROM connection_attempts").get().n, limits.globalAttempts);
  now += limits.windowMs;
  await assert.rejects(connect("window-reset", B, "bad"), e => e.code === "UPSTREAM_401");
  now += limits.retentionMs + 1;
  // Legacy quota rows are cleaned only after their backoff/reset is no longer active.
  sql.exec("INSERT INTO vehicle_quotas (vehicle_hash, blocked_until) VALUES ('legacy-rejected', 0)");
  sql.prepare("INSERT INTO vehicle_quotas (vehicle_hash, reset_at, blocked_until) VALUES ('active', ?, ?)").run(now + 60_000, now + 60_000);
  await assert.rejects(connect("after-retention", B, "bad"));
  assert.equal(sql.prepare("SELECT count(*) n FROM connection_attempts").get().n, 1);
  assert.equal(sql.prepare("SELECT vehicle_hash FROM vehicle_quotas").get().vehicle_hash, "active");
});

test("expired/replaced admission cannot overwrite a connection or release a newer account slot", async () => {
  await connect("alice"); const original = await service.getConnectionStatus("alice");
  const release = deferred(), entered = deferred(); let first = true;
  onValid = async response => { if (first) { first = false; entered.resolve(); await release.promise; } return response; };
  const old = assert.rejects(connect("alice", B, "bob-key"), e => e.code === "CONNECTION_ATTEMPT_EXPIRED");
  await entered.promise; now += limits.leaseMs + 1;
  await connect("alice", A, "other-key");
  const newer = await service.getConnectionStatus("alice");
  release.resolve(); await old;
  assert.notEqual(newer.connectionRevision, original.connectionRevision);
  assert.equal((await service.getConnectionStatus("alice")).connectionRevision, newer.connectionRevision);
  assert.equal((await service.readVehicle("alice", "overview")).vehicle.name, "other-key");
});

test("connection commit checks the admission token atomically and preserves old permissions on expiry", async () => {
  await connect("alice"); const original = await service.getConnectionStatus("alice");
  await service.setControlPermission("alice", "ventilation", { enabled: true, connectionRevision: original.connectionRevision, acknowledgement: "ALLOW_VENTILATION_CONTROL" });
  await service.readVehicle("alice", "overview");
  beforeCommit = () => { now += limits.leaseMs; };
  await assert.rejects(connect("alice", B, "bob-key"), e => e.code === "CONNECTION_ATTEMPT_EXPIRED");
  beforeCommit = null;
  const preserved = await service.getConnectionStatus("alice");
  assert.equal(preserved.connectionRevision, original.connectionRevision); assert.equal(preserved.controls.ventilationEnabled, true);
  assert.equal(sql.prepare("SELECT count(*) n FROM vehicle_cache WHERE user_id='alice'").get().n, 1);
});

test("disconnect cancels pending verified reconnect without refunding attempts or affecting another user", async () => {
  await connect("alice"); await connect("bob", B, "bob-key");
  const entered = deferred(), release = deferred();
  onValid = async response => { entered.resolve(); await release.promise; return response; };
  const pending = assert.rejects(connect("alice", A, "other-key"), e => e.code === "CONNECTION_ATTEMPT_EXPIRED");
  await entered.promise;
  const attempts = sql.prepare("SELECT attempts FROM connection_attempts WHERE user_id='alice'").get().attempts;
  await service.disconnectVehicle("alice");
  assert.equal((await service.getConnectionStatus("alice")).connected, false);
  release.resolve(); await pending; onValid = null;
  assert.equal((await service.getConnectionStatus("alice")).connected, false);
  assert.equal((await service.getConnectionStatus("bob")).connected, true);
  assert.equal(sql.prepare("SELECT attempts FROM connection_attempts WHERE user_id='alice'").get().attempts, attempts);
  await assert.rejects(connect("alice"), e => e.code === "CONNECTION_ATTEMPT_LIMITED");
  now += limits.failureDelayMs;
  await connect("alice");
});

test("failed reconnect preserves existing connection; successful reconnect clears only caller permissions/cache", async () => {
  await connect("alice"); await connect("bob", B, "bob-key");
  const original = await service.getConnectionStatus("alice");
  await service.setControlPermission("alice", "ventilation", { enabled: true, connectionRevision: original.connectionRevision, acknowledgement: "ALLOW_VENTILATION_CONTROL" });
  await service.readVehicle("alice", "overview"); await service.readVehicle("bob", "overview");
  await assert.rejects(connect("alice", B, "bad"));
  assert.equal((await service.getConnectionStatus("alice")).connectionRevision, original.connectionRevision);
  assert.equal((await service.getConnectionStatus("alice")).controls.ventilationEnabled, true);
  now += limits.failureDelayMs;
  await connect("alice", A, "other-key");
  assert.equal((await service.getConnectionStatus("alice")).controls.ventilationEnabled, false);
  assert.equal(sql.prepare("SELECT count(*) n FROM vehicle_cache WHERE user_id='alice'").get().n, 0);
  assert.equal(sql.prepare("SELECT count(*) n FROM vehicle_cache WHERE user_id='bob'").get().n, 1);
});

test("delayed verified metadata cannot overwrite newer quota observations", async () => {
  await connect("alice");
  const hash = await vehicleHash(A, globalThis.__securityFixEnv.VEHICLE_VAULT_KEY);
  onValid = async response => {
    sql.prepare("INSERT INTO request_leases (vehicle_hash, token, expires_at) VALUES (?, 'fixture-holder', ?)").run(hash, now + 1000);
    setTimeout(() => {
      now += 1;
      sql.prepare("UPDATE vehicle_quotas SET remaining=7, updated_at=?, observed_at=? WHERE vehicle_hash=?").run(now, now, hash);
      sql.prepare("DELETE FROM request_leases WHERE vehicle_hash=?").run(hash);
    }, 10);
    return response;
  };
  await connect("other", A, "other-key");
  assert.equal(sql.prepare("SELECT remaining FROM vehicle_quotas WHERE vehicle_hash=?").get(hash).remaining, 7);
});

test("invalid credential shapes never consume admission or reach the provider", async () => {
  for (const input of [null, {}, { vin: "invalid", apiKey: "key" }, { vin: A, apiKey: "key\nheader" }]) await assert.rejects(service.connectVehicle("bad-format", input));
  assert.equal(calls.length, 0);
  assert.equal(sql.prepare("SELECT count(*) n FROM connection_attempts").get().n, 0);
});

test("security migration preserves existing encrypted account state and permissions", () => {
  const previous = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../drizzle/", import.meta.url)).filter(x => /^000[0-3]_.*\.sql$/.test(x)).sort()) previous.exec(readFileSync(new URL("../drizzle/" + f, import.meta.url), "utf8"));
  previous.exec("INSERT INTO connections (user_id, sealed, revision, updated_at) VALUES ('existing', 'opaque-ciphertext', 'existing-revision', 123)");
  previous.exec("INSERT INTO control_permissions (user_id, revision, permission_version, ventilation_enabled, sealed_spin, updated_at) VALUES ('existing', 'existing-revision', 'existing-intent', 1, 'opaque-pin', 123)");
  previous.exec("INSERT INTO vehicle_quotas (vehicle_hash, remaining, blocked_until) VALUES ('existing-hash', 9, 0)");
  const connection = previous.prepare("SELECT * FROM connections").get(), permission = previous.prepare("SELECT * FROM control_permissions").get();
  previous.exec(readFileSync(new URL("../drizzle/0004_closed_blur.sql", import.meta.url), "utf8"));
  assert.deepEqual(previous.prepare("SELECT * FROM connections").get(), connection);
  assert.deepEqual(previous.prepare("SELECT * FROM control_permissions").get(), permission);
  assert.equal(previous.prepare("SELECT remaining FROM vehicle_quotas").get().remaining, 9);
  assert.equal(previous.prepare("SELECT count(*) n FROM connection_attempts").get().n, 0);
  assert.equal(previous.prepare("SELECT attempts FROM connection_gate WHERE id=1").get().attempts, 0);
  previous.close();
});

test("renewal shares the account attempt budget with connection verification", async () => {
  await connect("alice"); const status = await service.getConnectionStatus("alice");
  const payload = { connectionRevision: status.connectionRevision, apiKey: "wrong-renewal-key" };
  for (let attempt = 1; attempt < limits.accountAttempts; attempt++) {
    await assert.rejects(service.renewVehicleKey("alice", payload), e => e.code !== "CONNECTION_ATTEMPT_LIMITED");
    const before = calls.length;
    await assert.rejects(service.renewVehicleKey("alice", payload), e => e.code === "CONNECTION_ATTEMPT_LIMITED");
    assert.equal(calls.length, before);
    now += limits.failureDelayMs;
  }
  const before = calls.length;
  await assert.rejects(service.renewVehicleKey("alice", { ...payload, apiKey: "other-key" }), e => e.code === "CONNECTION_ATTEMPT_LIMITED");
  await assert.rejects(connect("alice"), e => e.code === "CONNECTION_ATTEMPT_LIMITED");
  assert.equal(calls.length, before);
  assert.equal((await service.getConnectionStatus("alice")).connectionRevision, status.connectionRevision);
});

test("renewal's final SQL guard rejects a revision changed after verification and preserves newer grants", async () => {
  await connect("alice"); const original = await service.getConnectionStatus("alice");
  await service.setControlProfile("alice", { mode: "all", connectionRevision: original.connectionRevision, acknowledgement: "ALLOW_SELECTED_VEHICLE_CONTROLS" });
  beforeCommit = () => {
    sql.prepare("UPDATE connections SET revision='newer-revision' WHERE user_id='alice'").run();
    sql.prepare("UPDATE control_permissions SET revision='newer-revision' WHERE user_id='alice'").run();
  };
  await assert.rejects(service.renewVehicleKey("alice", { connectionRevision: original.connectionRevision, apiKey: "other-key" }), e => e.code === "CONNECTION_CHANGED");
  assert.equal(sql.prepare("SELECT revision FROM connections WHERE user_id='alice'").get().revision, "newer-revision");
  assert.equal(sql.prepare("SELECT ventilation_enabled FROM control_permissions WHERE user_id='alice'").get().ventilation_enabled, 1);
  assert.equal(sql.prepare("SELECT charging_enabled FROM control_permissions WHERE user_id='alice'").get().charging_enabled, 1);
});
