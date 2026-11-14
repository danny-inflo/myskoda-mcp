import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

// This process has no real credentials or network path. Every upstream request
// is intercepted here, including every POST used to test command behavior.
const sql = new DatabaseSync(":memory:");
// Keep the database clock aligned with the controllable service clock.
sql.function("unixepoch", { varargs: true }, () => Date.now() / 1000);
for (const name of readdirSync(new URL("../drizzle/", import.meta.url)).filter((p) => p.endsWith(".sql")).sort()) sql.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
function statement(query, args = []) {
  return { bind(...values) { return statement(query, values); }, async first() { return sql.prepare(query).get(...args) ?? null; }, async run() { return { meta: { changes: Number(sql.prepare(query).run(...args).changes) } }; } };
}
const db = { prepare: statement, async batch(statements) {
  sql.exec("BEGIN");
  try { const out = []; for (const s of statements) out.push(await s.run()); sql.exec("COMMIT"); return out; }
  catch (e) { sql.exec("ROLLBACK"); throw e; }
} };
globalThis.__controlTestEnv = { DB: db, VEHICLE_VAULT_KEY: randomBytes(32).toString("base64") };
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__controlTestEnv", shortCircuit: true };
  if (/\/lib\/(vehicle-service|http)$/.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
let sim;
function reset() {
  for (const table of ["connections", "vehicle_cache", "vehicle_quotas", "request_leases", "control_permissions", "vehicle_commands", "connection_attempts"]) sql.exec(`DELETE FROM ${table}`);
  sql.exec("UPDATE connection_gate SET window_start=0, attempts=0, last_token=NULL WHERE id=1");
  sim = { calls: [], remaining: 20, postStatus: 202, transportFailure: false, fresh: false, state: "OFF", measuredAt: "2026-10-29T08:00:00Z", partError: null, operations: ["startActiveVentilation", "stopActiveVentilation"], preflightHook: null, postHook: null, failVerification: false };
}
globalThis.fetch = async (url, init) => {
  assert.equal(url.origin, "https://public.api.connect.skoda-auto.cz");
  assert.equal(init.headers["X-API-Key"], "synthetic-control-key");
  assert.equal(init.redirect, "manual");
  sim.calls.push({ method: init.method, path: url.pathname, include: url.searchParams.get("include") });
  const headers = { "RateLimit-Limit": "20", "RateLimit-Remaining": String(--sim.remaining), "RateLimit-Reset": "3600", "X-API-Key-Expires-At": "2099-01-01T00:00:00Z" };
  if (init.method === "POST") {
    assert.match(url.pathname, /^\/api\/v1\/vehicles\/TMBJB9NY5RF999999\/active-ventilation\/(start|stop)$/);
    assert.equal(init.body, undefined);
    if (sim.postHook) await sim.postHook();
    if (sim.transportFailure) throw new Error("synthetic timeout");
    if (sim.postStatus !== 202) return Response.json({ type: "https://public.api.connect.skoda-auto.cz/problems/operation-disabled", detail: "synthetic-control-key" }, { status: sim.postStatus, headers });
    sim.state = url.pathname.endsWith("/start") ? "VENTILATION" : "OFF";
    sim.measuredAt = sim.fresh ? new Date().toISOString() : sim.measuredAt;
    return new Response(null, { status: 202, headers });
  }
  assert.equal(init.method, "GET");
  const include = url.searchParams.get("include").split(",");
  if (include.includes("operations") && include.length === 2 && sim.preflightHook) await sim.preflightHook();
  if (include.length === 1 && include[0] === "activeVentilation" && sim.failVerification) return Response.json({ type: "about:blank" }, { status: 503, headers });
  const vehicle = { vin: "TMBJB9NY5RF999999" };
  if (include.includes("info")) vehicle.name = "Synthetic test car";
  if (include.includes("activeVentilation") && !sim.partError) vehicle.activeVentilation = { state: sim.state, durationInSeconds: 600, carCapturedTimestamp: sim.measuredAt };
  if (include.includes("operations")) vehicle.operations = sim.operations.map((name) => ({ name }));
  return Response.json({ vehicle, errors: sim.partError ? [{ type: sim.partError }] : [] }, { headers });
};
const service = await import("../lib/vehicle-service.ts");
const { POST: permissionRoute } = await import("../app/api/ventilation-control/route.ts");
const { dispatchMcp } = await import("../lib/mcp.ts");
const config = { vin: "TMBJB9NY5RF999999", apiKey: "synthetic-control-key" };
const args = (action, requestId = randomUUID()) => ({ requestId, confirmation: action === "start" ? "START_VENTILATION" : "STOP_VENTILATION" });
const posts = () => sim.calls.filter((c) => c.method === "POST").length;
async function connect(user = "a") { await service.connectVehicle(user, config); return service.getConnectionStatus(user); }
async function permit(user = "a", enabled = true) {
  const status = await service.getConnectionStatus(user);
  return service.setVentilationPermission(user, { enabled, connectionRevision: status.connectionRevision, ...(enabled ? { acknowledgement: "ALLOW_VENTILATION_CONTROL" } : {}) });
}

test("control defaults off and permission changes never contact the vehicle", async () => {
  reset();
  const status = await connect();
  assert.equal(status.controls.ventilationEnabled, false);
  const before = sim.calls.length;
  await assert.rejects(service.executeVentilation("a", "start", args("start")), (e) => e.code === "CONTROL_NOT_ALLOWED");
  assert.equal(sim.calls.length, before);
  const enabled = await permit();
  assert.equal(enabled.controls.ventilationEnabled, true);
  assert.equal(sim.calls.length, before);
  await permit("a", false);
  assert.equal(sim.calls.length, before); assert.equal(posts(), 0);
});

test("permission route requires authentication, same origin, explicit acknowledgement and current connection", async () => {
  reset(); const status = await connect();
  const endpoint = "https://test.local/api/ventilation-control";
  const request = (input, origin = "https://test.local", user = "a") => new Request(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(user ? { "oai-authenticated-user-id": user } : {}) }, body: JSON.stringify(input) });
  const input = { enabled: true, connectionRevision: status.connectionRevision, acknowledgement: "ALLOW_VENTILATION_CONTROL" };
  assert.equal((await permissionRoute(request(input, "https://test.local", null))).status, 401);
  assert.equal((await permissionRoute(request(input, "https://evil.invalid"))).status, 403);
  assert.equal((await permissionRoute(request({ enabled: true, connectionRevision: status.connectionRevision }))).status, 400);
  assert.equal((await permissionRoute(request({ ...input, userId: "victim" }))).status, 400);
  assert.equal((await permissionRoute(request({ ...input, connectionRevision: "stale" }))).status, 409);
  const response = await permissionRoute(request(input));
  assert.equal(response.status, 200); assert.equal((await response.json()).controls.ventilationEnabled, true);
  assert.equal(posts(), 0);
});

test("simulated accepted start is not completed by stale data; stop can be confirmed by a fresh measurement", async () => {
  reset(); await connect(); await permit();
  await service.readVehicle("a", "overview");
  assert.equal(sql.prepare("SELECT count(*) n FROM vehicle_cache").get().n, 1);
  const input = args("start");
  const result = await service.executeVentilation("a", "start", input);
  assert.equal(result.status, "accepted"); assert.equal(result.executionConfirmed, false);
  assert.equal(result.verification.status, "unconfirmed"); assert.equal(result.automaticRetryAllowed, false);
  assert.equal(posts(), 1);
  assert.equal(sql.prepare("SELECT count(*) n FROM vehicle_cache").get().n, 0);
  const calls = sim.calls.length;
  const duplicate = await service.executeVentilation("a", "start", input);
  assert.equal(duplicate.reused, true); assert.equal(sim.calls.length, calls);
  const stored = JSON.stringify(sql.prepare("SELECT * FROM vehicle_commands").all());
  assert(!stored.includes(config.apiKey)); assert(!stored.includes(config.vin)); assert(!stored.includes(result.message));
  sim.fresh = true;
  const stopped = await service.executeVentilation("a", "stop", args("stop"));
  assert.equal(stopped.status, "accepted"); assert.equal(stopped.executionConfirmed, true);
  assert.equal(stopped.verification.state, "OFF"); assert.equal(posts(), 2);
});

test("concurrent same-ID commands and new-ID duplicate clicks send only one simulated POST", async () => {
  reset(); await connect(); await permit();
  const input = args("start");
  const results = await Promise.all([service.executeVentilation("a", "start", input), service.executeVentilation("a", "start", input)]);
  assert.equal(posts(), 1); assert.equal(results.filter((r) => r.reused).length, 1);
  await assert.rejects(service.executeVentilation("a", "start", args("start")), (e) => e.code === "COMMAND_RECENTLY_SENT");
  assert.equal(posts(), 1);
  await assert.rejects(service.executeVentilation("a", "stop", args("stop", input.requestId)), (e) => e.code === "REQUEST_ID_CONFLICT");
  assert.equal(posts(), 1);
});

test("permissions are user-scoped, revocable during preflight and reset by reconnect", async () => {
  reset(); await connect("a"); await connect("b"); await permit("a");
  await assert.rejects(service.executeVentilation("b", "start", args("start")), (e) => e.code === "CONTROL_NOT_ALLOWED");
  sim.preflightHook = async () => { await permit("a", false); };
  await assert.rejects(service.executeVentilation("a", "start", args("start")), (e) => e.code === "CONTROL_NOT_ALLOWED");
  assert.equal(posts(), 0);
  sim.preflightHook = null;
  await permit("a");
  await connect("a");
  assert.equal((await service.getConnectionStatus("a")).controls.ventilationEnabled, false);
  await assert.rejects(service.executeVentilation("a", "start", args("start")), (e) => e.code === "CONTROL_NOT_ALLOWED");
  assert.equal(posts(), 0);
});

test("revoking and re-enabling permission during preflight cancels the old action intent", async () => {
  reset(); await connect(); await permit();
  sim.preflightHook = async () => { await permit("a", false); await permit("a", true); };
  await assert.rejects(service.executeVentilation("a", "start", args("start")), (e) => e.code === "CONTROL_NOT_ALLOWED");
  assert.equal(posts(), 0);
});

test("saved command results remain retrievable after the last quota token without resending", async () => {
  reset(); await connect(); await permit(); sim.remaining = 3;
  const input = args("start");
  const result = await service.executeVentilation("a", "start", input);
  assert.equal(result.status, "accepted"); assert.equal(sim.remaining, 0);
  const before = sim.calls.length;
  const replay = await service.executeVentilation("a", "start", input);
  assert.equal(replay.reused, true); assert.equal(replay.status, "accepted");
  assert.equal(sim.calls.length, before); assert.equal(posts(), 1);
});

test("a worker resuming after lease expiry cannot dispatch a stale command", async (t) => {
  reset(); await connect(); await permit();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  sim.preflightHook = async () => { now += 100_000; };
  const result = await service.executeVentilation("a", "start", args("start"));
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "COMMAND_LEASE_EXPIRED");
  assert.equal(posts(), 0);
});

test("unsupported, disabled, unknown capabilities and quota shortage all prevent POST", async () => {
  for (const [reason, code] of [["ACTIVE_VENTILATION_UNSUPPORTED", "OPERATION_UNSUPPORTED"], ["ACTIVE_VENTILATION_DISABLED", "OPERATION_DISABLED"], ["ACTIVE_VENTILATION_UNAVAILABLE", "CAPABILITIES_UNAVAILABLE"], ["OPERATIONS_UNAVAILABLE", "CAPABILITIES_UNAVAILABLE"]]) {
    reset(); await connect(); await permit(); sim.partError = reason;
    await assert.rejects(service.executeVentilation("a", "start", args("start")), (e) => e.code === code);
    assert.equal(posts(), 0);
  }
  reset(); await connect(); await permit(); sim.operations = [];
  await assert.rejects(service.executeVentilation("a", "start", args("start")), (e) => e.code === "OPERATION_UNSUPPORTED");
  assert.equal(posts(), 0);
  reset(); await connect(); await permit(); sim.remaining = 2;
  await assert.rejects(service.executeVentilation("a", "start", args("start")), (e) => e.code === "COMMAND_QUOTA_RESERVE_REQUIRED");
  assert.equal(posts(), 0);
});

test("ambiguous POST outcomes are encrypted and never automatically repeated", async () => {
  for (const failure of ["timeout", "server-error"]) {
    reset(); await connect(); await permit();
    sim.transportFailure = failure === "timeout"; sim.postStatus = failure === "timeout" ? 202 : 503;
    const input = args("start");
    const result = await service.executeVentilation("a", "start", input);
    assert.equal(result.status, "unknown"); assert.equal(result.executionConfirmed, false);
    assert.equal(result.automaticRetryAllowed, false); assert.equal(result.error.retryable, false);
    assert.equal(result.error.commandMayHaveBeenSent, true); assert.equal(posts(), 1);
    const calls = sim.calls.length;
    const repeated = await service.executeVentilation("a", "start", input);
    assert.equal(repeated.reused, true); assert.equal(repeated.status, "unknown");
    assert.equal(sim.calls.length, calls);
    sim.transportFailure = false; sim.postStatus = 202;
    await assert.rejects(service.executeVentilation("a", "start", args("start")), (e) => e.code === "COMMAND_RECENTLY_SENT" || e.code === "UPSTREAM_503");
    assert.equal(posts(), 1);
  }
});

test("a provider rejection is distinguished from uncertain execution; verification failure does not resend", async () => {
  reset(); await connect(); await permit(); sim.postStatus = 422;
  const rejected = await service.executeVentilation("a", "start", args("start"));
  assert.equal(rejected.status, "rejected"); assert.equal(rejected.error.code, "OPERATION_DISABLED");
  assert.equal(posts(), 1); assert(!JSON.stringify(rejected).includes(config.apiKey));
  reset(); await connect(); await permit(); sim.failVerification = true;
  const input = args("start");
  const accepted = await service.executeVentilation("a", "start", input);
  assert.equal(accepted.status, "accepted"); assert.equal(accepted.verification.status, "unavailable");
  assert.equal(posts(), 1);
  await service.executeVentilation("a", "start", input);
  assert.equal(posts(), 1);
});

test("disconnect during a simulated POST does not restore permission, audit or perform another vehicle read", async () => {
  reset(); await connect(); await permit();
  sim.postHook = async () => { await service.disconnectVehicle("a"); };
  const result = await service.executeVentilation("a", "start", args("start"));
  assert.equal(result.status, "accepted");
  assert.equal(result.verification.reason, "connection_changed_after_send");
  assert.equal(posts(), 1); assert.equal(sim.calls.at(-1).method, "POST");
  assert.equal(sql.prepare("SELECT count(*) n FROM connections").get().n, 0);
  assert.equal(sql.prepare("SELECT count(*) n FROM vehicle_commands").get().n, 0);
  assert.equal(sql.prepare("SELECT count(*) n FROM control_permissions").get().n, 0);
});

test("MCP requires exact confirmation, rejects overrides and cannot enable its own control permission", async () => {
  reset(); await connect(); await permit();
  const services = { status: service.getConnectionStatus, read: service.readVehicle, execute: service.executeVentilation };
  const call = (name, input) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } });
  for (const input of [{}, { ...args("start"), confirmation: "STOP_VENTILATION" }, { ...args("start"), userId: "victim" }, { ...args("start"), apiKey: "override" }, { ...args("start"), requestId: "not-a-uuid" }]) {
    assert.equal((await dispatchMcp(call("start_active_ventilation", input), "a", services)).result.isError, true);
  }
  assert.equal(posts(), 0);
  assert.equal((await dispatchMcp(call("enable_ventilation_control", {}), "a", services)).error.code, -32602);
  assert.equal((await dispatchMcp(call("start_active_ventilation", args("start")), null, services)).result.isError, true);
  assert.equal(posts(), 0);
  const enabledRead = await service.readVehicle("a", "capabilities");
  assert.equal(enabledRead.normalized.operations.integrationControlEnabled, true);
  assert.deepEqual(enabledRead.normalized.operations.enabledOperations, ["startActiveVentilation", "stopActiveVentilation"]);
  await permit("a", false);
  const disabledRead = await service.readVehicle("a", "capabilities");
  assert.equal(disabledRead.cached, true);
  assert.equal(disabledRead.normalized.operations.integrationControlEnabled, false);
  assert.equal(posts(), 0);
});

test("MCP accepted and uncertain command results preserve their status and prohibit automatic retry", async () => {
  for (const uncertain of [false, true]) {
    reset(); await connect(); await permit(); sim.transportFailure = uncertain;
    const response = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start_active_ventilation", arguments: args("start") } }, "a", { status: service.getConnectionStatus, read: service.readVehicle, execute: service.executeVentilation });
    assert.equal(response.result.isError, uncertain);
    assert.equal(response.result.structuredContent.status, uncertain ? "unknown" : "accepted");
    assert.equal(response.result.structuredContent.automaticRetryAllowed, false);
    if (uncertain) assert.equal(response.result.structuredContent.error_code, "COMMAND_OUTCOME_UNKNOWN");
    assert.equal(posts(), 1);
  }
});
