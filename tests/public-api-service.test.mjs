import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { VEHICLE_OPERATIONS, fingerprint, unseal } from "../lib/skoda-core.mjs";

// No real VIN, key or S-PIN is used. All provider GET/POST/PUT calls are replaced.
const sql = new DatabaseSync(":memory:");
// Keep the database clock aligned with the controllable service clock.
sql.function("unixepoch", { varargs: true }, () => Date.now() / 1000);
for (const name of readdirSync(new URL("../drizzle/", import.meta.url)).filter((p) => p.endsWith(".sql")).sort()) sql.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
function statement(query, args = []) {
  return { bind(...values) { return statement(query, values); }, async first() { return sql.prepare(query).get(...args) ?? null; }, async run() { return { meta: { changes: Number(sql.prepare(query).run(...args).changes) } }; } };
}
const db = { prepare: statement, async batch(statements) { sql.exec("BEGIN"); try { const out = []; for (const s of statements) out.push(await s.run()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
globalThis.__publicApiEnv = { DB: db, VEHICLE_VAULT_KEY: randomBytes(32).toString("base64") };
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__publicApiEnv", shortCircuit: true };
  if (/\/lib\/(vehicle-service|http)$/.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const service = await import("../lib/vehicle-service.ts");
const { dispatchMcp } = await import("../lib/mcp.ts");
const { POST: permissionRoute } = await import("../app/api/control-permission/route.ts");
const { POST: spinRoute } = await import("../app/api/heating-spin/route.ts");
const { POST: renewalRoute } = await import("../app/api/connection-key/route.ts");
const { POST: profileRoute } = await import("../app/api/control-profile/route.ts");
const profile = { id: 3, name: "Synthetic profile", settings: { targetStateOfChargeInPercent: 80, minBatteryStateOfCharge: { enabled: true, minimumBatteryStateOfChargeInPercent: 30 }, futureSetting: true }, preferredChargingTimes: [{ id: 7, enabled: true, startTime: "22:00", endTime: "06:00" }], timers: [{ id: 8, enabled: true, type: "RECURRING", time: "08:00", recurringOn: ["MONDAY"] }], futureProfile: true };
const config = { vin: "TMBJB9NY5RF999999", apiKey: "synthetic-all-commands-key" };
let sim;
function reset() {
  for (const table of ["connections", "vehicle_cache", "vehicle_quotas", "request_leases", "control_permissions", "vehicle_commands", "connection_attempts"]) sql.exec(`DELETE FROM ${table}`);
  sql.exec("UPDATE connection_gate SET window_start=0, attempts=0, last_token=NULL WHERE id=1");
  sim = { calls: [], remaining: 20, writeStatus: 202, transportFailure: false, preflightHook: null, writeHook: null, verificationHook: null, error: null, stale: false, operations: VEHICLE_OPERATIONS.map((d) => ({ name: d.operationId })), vehicle: {
    charging: { isVehicleInSavedLocation: true, status: { state: "READY_FOR_CHARGING", plugConnectionState: "CONNECTED" }, settings: { targetStateOfChargeInPercent: 80, availableChargeModes: ["MANUAL", "TIMER"], preferredChargeMode: "MANUAL" } },
    chargingProfiles: { profiles: [structuredClone(profile)] }, airConditioning: { state: "OFF" }, auxiliaryHeating: { state: "OFF" }, activeVentilation: { state: "OFF" },
  } };
}
const writes = () => sim.calls.filter((c) => ["POST", "PUT"].includes(c.method));

test("V4 migration preserves V3 connections, ventilation permission and audit while granting no new controls", () => {
  const previous = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../drizzle/", import.meta.url)).filter((p) => /^000[0-2]_.*\.sql$/.test(p)).sort()) previous.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
  previous.exec("INSERT INTO connections VALUES ('old-user', 'encrypted-connection', 'old-revision', NULL, 1)");
  previous.exec("INSERT INTO control_permissions VALUES ('old-user', 'old-revision', 'old-permission-version', 1, 1)");
  previous.exec("INSERT INTO vehicle_commands VALUES ('old-user', 'old-request', 'old-revision', 'hashed-vin', 'start', 'accepted', 'encrypted-result', 1, 1)");
  previous.exec(readFileSync(new URL("../drizzle/0003_quiet_pandemic.sql", import.meta.url), "utf8"));
  const flags = previous.prepare("SELECT * FROM control_permissions").get();
  assert.equal(flags.ventilation_enabled, 1); assert.equal(flags.permission_version, "old-permission-version");
  for (const column of ["charging_enabled", "air_conditioning_enabled", "auxiliary_heating_enabled"]) assert.equal(flags[column], 0);
  assert.equal(flags.sealed_spin, null); assert.equal(previous.prepare("SELECT sealed FROM connections").get().sealed, "encrypted-connection");
  assert.equal(previous.prepare("SELECT sealed_result FROM vehicle_commands").get().sealed_result, "encrypted-result");
  assert.equal(previous.prepare("SELECT input_fingerprint FROM vehicle_commands").get().input_fingerprint, null);
  previous.close();
});
globalThis.fetch = async (url, init) => {
  assert.equal(url.origin, "https://public.api.connect.skoda-auto.cz"); assert.equal(init.headers["X-API-Key"], sim.expectedApiKey ?? config.apiKey); assert.equal(init.redirect, "manual");
  const body = init.body ? JSON.parse(init.body) : undefined;
  sim.calls.push({ method: init.method, path: url.pathname, include: url.searchParams.get("include"), body });
  const headers = { "RateLimit-Limit": "20", "RateLimit-Remaining": String(--sim.remaining), "RateLimit-Reset": "3600", "X-API-Key-Expires-At": "2099-01-01T00:00:00Z" };
  if (init.method !== "GET") {
    const d = VEHICLE_OPERATIONS.find((d) => `/api/v1/vehicles/${config.vin}/${d.path.replace("{id}", "3")}` === url.pathname);
    assert(d); assert.equal(init.method, d.method);
    if (sim.writeHook) await sim.writeHook();
    if (sim.transportFailure) throw new Error("synthetic timeout");
    if (sim.writeStatus !== 202) return Response.json({ type: "about:blank", detail: "9593 synthetic-all-commands-key" }, { status: sim.writeStatus, headers });
    if (d.action === "start_charging") sim.vehicle.charging.status.state = "CHARGING";
    if (d.action === "stop_charging") sim.vehicle.charging.status.state = "CHARGING_INTERRUPTED";
    if (d.action === "set_charging_limit") sim.vehicle.charging.settings.targetStateOfChargeInPercent = body.targetStateOfChargeInPercent;
    if (d.action === "set_charge_mode") sim.vehicle.charging.settings.preferredChargeMode = body.chargeMode;
    if (d.action === "update_charging_profile") sim.vehicle.chargingProfiles.profiles = [body];
    if (d.action === "start_air_conditioning") sim.vehicle.airConditioning = { state: "COOLING", ...body };
    if (d.action === "stop_air_conditioning") sim.vehicle.airConditioning.state = "OFF";
    if (d.action === "start_auxiliary_heating") sim.vehicle.auxiliaryHeating = { state: body.startMode === "VENTILATION" ? "VENTILATION" : "HEATING_AUXILIARY", durationInSeconds: body.durationInSeconds, ...(body.targetTemperature ? { targetTemperature: body.targetTemperature } : {}) };
    if (d.action === "stop_auxiliary_heating") sim.vehicle.auxiliaryHeating.state = "OFF";
    if (d.action === "start") sim.vehicle.activeVentilation.state = "VENTILATION";
    if (d.action === "stop") sim.vehicle.activeVentilation.state = "OFF";
    sim.vehicle[d.part].carCapturedTimestamp = new Date(sim.stale ? Date.now() - 3600_000 : Date.now()).toISOString();
    return new Response(null, { status: 202, headers });
  }
  const parts = url.searchParams.get("include").split(",");
  if (parts.includes("info") && sim.infoHook) { const response = await sim.infoHook(); if (response) return response; }
  if (parts.includes("operations") && parts.length === 2 && sim.preflightHook) await sim.preflightHook();
  if (parts.length === 1 && !parts.includes("info") && writes().length && sim.verificationHook) await sim.verificationHook();
  const vehicle = { vin: config.vin };
  for (const part of parts) {
    if (part === "info") vehicle.name = "Synthetic car";
    else if (part === "operations") vehicle.operations = sim.operations;
    else if (!sim.error?.startsWith(part === "chargingProfiles" ? "CHARGING_PROFILES_" : part === "airConditioning" ? "AIR_CONDITIONING_" : part === "auxiliaryHeating" ? "AUXILIARY_HEATING_" : part === "charging" ? "CHARGING_" : "ACTIVE_VENTILATION_")) vehicle[part] = sim.vehicle[part];
  }
  return Response.json({ vehicle, errors: sim.error ? [{ type: sim.error }] : [] }, { headers });
};
const acks = { ventilation: "ALLOW_VENTILATION_CONTROL", charging: "ALLOW_CHARGING_CONTROL", airConditioning: "ALLOW_AIR_CONDITIONING_CONTROL", auxiliaryHeating: "ALLOW_AUXILIARY_HEATING_CONTROL" };
async function connect(user = "a") { await service.connectVehicle(user, config); return service.getConnectionStatus(user); }
async function permit(scope, user = "a", enabled = true) {
  const status = await service.getConnectionStatus(user);
  return service.setControlPermission(user, scope, { connectionRevision: status.connectionRevision, enabled, ...(enabled ? { acknowledgement: acks[scope] } : {}) });
}
async function pin(value = "9593", user = "a") { const status = await service.getConnectionStatus(user); return service.setHeatingSpin(user, { connectionRevision: status.connectionRevision, spin: value }); }
async function args(action, overrides = {}) {
  const extra = action === "set_charging_limit" ? { targetStateOfChargeInPercent: 90 } : action === "set_charge_mode" ? { chargeMode: "TIMER" } : action === "update_charging_profile" ? { profileId: 3, expectedProfileFingerprint: await fingerprint(sim.vehicle.chargingProfiles.profiles[0]), changes: { settings: { targetStateOfChargeInPercent: 90 } } } : action === "start_air_conditioning" ? { targetTemperature: { value: 22.5, unit: "CELSIUS" }, airConditioningWithoutExternalPower: false } : action === "start_auxiliary_heating" ? { durationInSeconds: 600, startMode: "HEATING", targetTemperature: { value: 22, unit: "CELSIUS" } } : {};
  return { requestId: randomUUID(), confirmation: VEHICLE_OPERATIONS.find((d) => d.action === action).confirmation, ...extra, ...overrides };
}

for (const d of VEHICLE_OPERATIONS.filter((d) => !["start", "stop"].includes(d.action))) test(`full simulated service flow: ${d.operationId}`, async () => {
  reset(); await connect(); await permit(d.scope); if (d.action === "start_auxiliary_heating") await pin();
  const input = await args(d.action);
  const result = await service.executeVehicleCommand("a", d.action, input);
  assert.equal(result.status, "accepted"); assert.equal(result.executionConfirmed, true); assert.equal(writes().length, 1);
  assert.equal(writes()[0].method, d.method);
  assert.equal(sim.calls.at(-2).method, d.method); assert.equal(sim.calls.at(-1).include, d.part);
  const calls = sim.calls.length;
  assert.equal((await service.executeVehicleCommand("a", d.action, input)).reused, true); assert.equal(sim.calls.length, calls);
  assert(!JSON.stringify(result).includes(config.apiKey)); assert(!JSON.stringify(result).includes("9593"));
});

test("permission groups are independent, default off, cannot self-enable through MCP and reset on reconnect", async () => {
  reset(); const status = await connect();
  for (const key of ["ventilationEnabled", "chargingEnabled", "airConditioningEnabled", "auxiliaryHeatingEnabled", "auxiliaryHeatingSpinConfigured"]) assert.equal(status.controls[key], false);
  await permit("ventilation");
  const before = sim.calls.length;
  await assert.rejects(service.executeVehicleCommand("a", "start_charging", await args("start_charging")), (e) => e.code === "CONTROL_NOT_ALLOWED");
  assert.equal(sim.calls.length, before);
  await permit("charging"); await permit("airConditioning"); await permit("auxiliaryHeating"); await pin();
  await permit("charging", "a", false);
  const flags = (await service.getConnectionStatus("a")).controls;
  assert.equal(flags.ventilationEnabled, true); assert.equal(flags.chargingEnabled, false); assert.equal(flags.airConditioningEnabled, true); assert.equal(flags.auxiliaryHeatingEnabled, true); assert.equal(flags.auxiliaryHeatingSpinConfigured, true);
  assert.equal(sim.calls.length, before); assert.equal(writes().length, 0);
  const call = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "enable_charging_control", arguments: {} } }, "a", {});
  assert.equal(call.error.code, -32602);
  await connect(); const after = (await service.getConnectionStatus("a")).controls;
  for (const key of ["ventilationEnabled", "chargingEnabled", "airConditioningEnabled", "auxiliaryHeatingEnabled", "auxiliaryHeatingSpinConfigured"]) assert.equal(after[key], false);
});

test("profile read exposes a stable revision and update preserves all unrequested fields", async () => {
  reset(); await connect(); await permit("charging");
  const read = await service.readVehicle("a", "profiles");
  const expected = read.normalized.chargingProfileRevisions[0].fingerprint;
  assert.equal(expected, await fingerprint(profile));
  const result = await service.executeVehicleCommand("a", "update_charging_profile", await args("update_charging_profile", { expectedProfileFingerprint: expected, changes: { settings: { minBatteryStateOfCharge: { enabled: false } } } }));
  assert.equal(result.status, "accepted"); assert.equal(result.executionConfirmed, true);
  const sent = writes()[0].body;
  assert.equal(sent.id, 3); assert.equal(sent.name, profile.name); assert.equal(sent.futureProfile, true);
  assert.deepEqual(sent.timers, profile.timers); assert.deepEqual(sent.preferredChargingTimes, profile.preferredChargingTimes);
  assert.deepEqual(sent.settings.minBatteryStateOfCharge, { enabled: false, minimumBatteryStateOfChargeInPercent: 30 });
  assert.equal(sent.settings.futureSetting, true); assert.equal(sql.prepare("SELECT count(*) n FROM vehicle_cache").get().n, 0);
});

test("changed or missing profiles and unavailable charge modes never send a write", async () => {
  for (const mode of ["changed", "missing", "charge-mode"]) {
    reset(); await connect(); await permit("charging");
    if (mode === "charge-mode") await assert.rejects(service.executeVehicleCommand("a", "set_charge_mode", await args("set_charge_mode", { chargeMode: "ONLY_OWN_CURRENT" })), (e) => e.code === "CHARGE_MODE_UNAVAILABLE");
    else {
      const input = await args("update_charging_profile");
      sim.preflightHook = async () => { if (mode === "changed") sim.vehicle.chargingProfiles.profiles[0].name = "Changed externally"; else sim.vehicle.chargingProfiles.profiles = []; };
      await assert.rejects(service.executeVehicleCommand("a", "update_charging_profile", input), (e) => e.code === (mode === "changed" ? "PROFILE_CHANGED" : "PROFILE_NOT_FOUND"));
    }
    assert.equal(writes().length, 0);
  }
});

test("request IDs are bound to parameters, and concurrent PUT repeats dispatch only once", async () => {
  reset(); await connect(); await permit("charging");
  const input = await args("set_charging_limit");
  const result = await Promise.all([service.executeVehicleCommand("a", "set_charging_limit", input), service.executeVehicleCommand("a", "set_charging_limit", input)]);
  assert.equal(writes().length, 1); assert.equal(result.filter((x) => x.reused).length, 1);
  await assert.rejects(service.executeVehicleCommand("a", "set_charging_limit", { ...input, targetStateOfChargeInPercent: 80 }), (e) => e.code === "REQUEST_ID_CONFLICT");
  assert.equal(writes().length, 1);
});

test("new controls reject unsupported, disabled and unknown capabilities before dispatch", async () => {
  for (const d of VEHICLE_OPERATIONS.filter((d) => !["start", "stop"].includes(d.action))) {
    for (const [suffix, code] of [["UNSUPPORTED", "OPERATION_UNSUPPORTED"], ["DISABLED", "OPERATION_DISABLED"], ["UNAVAILABLE", "CAPABILITIES_UNAVAILABLE"]]) {
      reset(); await connect(); await permit(d.scope); if (d.action === "start_auxiliary_heating") await pin();
      const input = await args(d.action); sim.error = `${d.prefix}_${suffix}`;
      await assert.rejects(service.executeVehicleCommand("a", d.action, input), (e) => e.code === code, `${d.action} ${suffix}`); assert.equal(writes().length, 0);
    }
  }
});

test("S-PIN lives only in encrypted per-connection settings, is never returned and is required only for heating start", async () => {
  reset(); const status = await connect(); await permit("auxiliaryHeating");
  const before = sim.calls.length;
  await assert.rejects(service.executeVehicleCommand("a", "start_auxiliary_heating", await args("start_auxiliary_heating")), (e) => e.code === "HEATING_SPIN_REQUIRED");
  assert.equal(sim.calls.length, before);
  const saved = await pin(); assert.equal(saved.controls.auxiliaryHeatingSpinConfigured, true); assert.equal(sim.calls.length, before);
  assert(!JSON.stringify(saved).includes("9593")); assert(!JSON.stringify(sql.prepare("SELECT * FROM control_permissions").all()).includes("9593"));
  await assert.rejects(service.setHeatingSpin("b", { connectionRevision: status.connectionRevision, spin: "9593" }), (e) => e.code === "CONNECTION_CHANGED");
  await pin(null);
  assert.equal((await service.getConnectionStatus("a")).controls.auxiliaryHeatingSpinConfigured, false);
  assert.equal((await service.executeVehicleCommand("a", "stop_auxiliary_heating", await args("stop_auxiliary_heating"))).status, "accepted");
});

test("settings routes enforce identity, origin, exact acknowledgement, scope and payload; they never write to a car", async () => {
  reset(); const status = await connect();
  const req = (path, body, origin = "https://test.local", user = "a") => new Request(`https://test.local/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(user ? { "oai-authenticated-user-id": user } : {}) }, body: JSON.stringify(body) });
  const input = { scope: "charging", enabled: true, connectionRevision: status.connectionRevision, acknowledgement: acks.charging };
  assert.equal((await permissionRoute(req("control-permission", input, "https://test.local", null))).status, 401);
  assert.equal((await permissionRoute(req("control-permission", input, "https://evil.invalid"))).status, 403);
  assert.equal((await permissionRoute(req("control-permission", { ...input, scope: "unlock" }))).status, 400);
  assert.equal((await permissionRoute(req("control-permission", { ...input, acknowledgement: acks.ventilation }))).status, 400);
  assert.equal((await permissionRoute(req("control-permission", input))).status, 200);
  const spin = { spin: "9593", connectionRevision: status.connectionRevision };
  assert.equal((await spinRoute(req("heating-spin", spin, "https://evil.invalid"))).status, 403);
  assert.equal((await spinRoute(req("heating-spin", { ...spin, userId: "victim" }))).status, 400);
  const response = await spinRoute(req("heating-spin", spin)); assert.equal(response.status, 200); assert(!(await response.text()).includes("9593"));
  assert.equal(writes().length, 0);
});

test("permission or S-PIN changes during preparation cancel the old heating intent", async () => {
  for (const mode of ["revoke", "change-spin", "remove-spin"]) {
    reset(); await connect(); await permit("auxiliaryHeating"); await pin();
    sim.preflightHook = async () => { if (mode === "revoke") await permit("auxiliaryHeating", "a", false); else await pin(mode === "change-spin" ? "6162" : null); };
    await assert.rejects(service.executeVehicleCommand("a", "start_auxiliary_heating", await args("start_auxiliary_heating")), (e) => e.code === "CONTROL_NOT_ALLOWED");
    assert.equal(writes().length, 0);
  }
});

test("PUT timeouts, rejection, stale verification and connection changes never cause a repeat", async () => {
  for (const mode of ["timeout", "rejected", "stale", "disconnect"]) {
    reset(); await connect(); await permit("charging");
    sim.transportFailure = mode === "timeout"; sim.writeStatus = mode === "rejected" ? 412 : 202; sim.stale = mode === "stale";
    if (mode === "disconnect") sim.verificationHook = async () => { await service.disconnectVehicle("a"); };
    const input = await args("set_charging_limit");
    const result = await service.executeVehicleCommand("a", "set_charging_limit", input);
    assert.equal(result.status, mode === "timeout" ? "unknown" : mode === "rejected" ? "rejected" : "accepted");
    assert.equal(result.executionConfirmed, false); assert.equal(result.automaticRetryAllowed, false); assert.equal(writes().length, 1);
    if (mode !== "disconnect") { assert.equal((await service.executeVehicleCommand("a", "set_charging_limit", input)).reused, true); assert.equal(writes().length, 1); }
    else { assert.equal(result.verification.reason, "connection_changed_during_verification"); assert.equal(sql.prepare("SELECT count(*) n FROM vehicle_commands").get().n, 0); }
  }
});

test("permission profiles save all four groups atomically, isolate users and preserve encrypted S-PIN", async () => {
  reset(); const a = await connect(); await connect("b"); await pin();
  const before = sim.calls.length;
  const profile = (mode, extra = {}) => service.setControlProfile("a", { mode, connectionRevision: a.connectionRevision, ...extra });
  let status = await profile("all", { acknowledgement: "ALLOW_SELECTED_VEHICLE_CONTROLS" });
  for (const flag of ["ventilationEnabled", "chargingEnabled", "airConditioningEnabled", "auxiliaryHeatingEnabled"]) assert.equal(status.controls[flag], true);
  assert.equal(status.controls.auxiliaryHeatingSpinConfigured, true);
  assert.equal((await service.getConnectionStatus("b")).controls.chargingEnabled, false);
  const previousVersion = sql.prepare("SELECT permission_version FROM control_permissions WHERE user_id='a'").get().permission_version;
  status = await profile("custom", { permissions: { ventilation: true, charging: false, airConditioning: true, auxiliaryHeating: false }, acknowledgement: "ALLOW_SELECTED_VEHICLE_CONTROLS" });
  assert.equal(status.controls.ventilationEnabled, true); assert.equal(status.controls.chargingEnabled, false); assert.equal(status.controls.airConditioningEnabled, true); assert.equal(status.controls.auxiliaryHeatingEnabled, false);
  assert.notEqual(sql.prepare("SELECT permission_version FROM control_permissions WHERE user_id='a'").get().permission_version, previousVersion);
  status = await profile("readOnly");
  for (const flag of ["ventilationEnabled", "chargingEnabled", "airConditioningEnabled", "auxiliaryHeatingEnabled"]) assert.equal(status.controls[flag], false);
  assert.equal(status.controls.auxiliaryHeatingSpinConfigured, true);
  assert.equal(sim.calls.length, before); assert.equal(writes().length, 0);
});

test("profiles require exact fields, explicit grants and own connection revision; rejection never partially saves", async () => {
  reset(); const a = await connect(), b = await connect("b");
  const base = { mode: "all", connectionRevision: a.connectionRevision, acknowledgement: "ALLOW_SELECTED_VEHICLE_CONTROLS" };
  for (const input of [null, [], {}, { ...base, userId: "b" }, { ...base, apiKey: "override" }, { ...base, mode: "ALL" }, { ...base, acknowledgement: undefined }, { ...base, permissions: {} }, { ...base, mode: "custom", permissions: { ventilation: true } }, { ...base, mode: "custom", permissions: { ventilation: "true", charging: false, airConditioning: false, auxiliaryHeating: false } }, { ...base, mode: "custom", permissions: { ventilation: true, charging: false, airConditioning: false, auxiliaryHeating: false, unknown: true } }]) {
    await assert.rejects(service.setControlProfile("a", input), e => e.code === "INVALID_PERMISSION_INPUT");
    assert.equal((await service.getConnectionStatus("a")).controls.ventilationEnabled, false);
  }
  await assert.rejects(service.setControlProfile("a", { ...base, connectionRevision: b.connectionRevision }), e => e.code === "CONNECTION_CHANGED");
  await assert.rejects(service.setControlProfile("missing-account", base), e => e.code === "CONNECTION_CHANGED");
  assert.equal(sql.prepare("SELECT count(*) n FROM control_permissions").get().n, 0);
  assert.equal(writes().length, 0);
});

test("expired keys may revoke all permissions but cannot grant a profile; reconnect resets the selection", async () => {
  reset(); const a = await connect();
  const base = { connectionRevision: a.connectionRevision, acknowledgement: "ALLOW_SELECTED_VEHICLE_CONTROLS" };
  await service.setControlProfile("a", { ...base, mode: "all" });
  sql.exec("UPDATE connections SET key_expires_at='2000-01-01T00:00:00Z' WHERE user_id='a'");
  await assert.rejects(service.setControlProfile("a", { ...base, mode: "all" }), e => e.code === "KEY_EXPIRED");
  const revoked = await service.setControlProfile("a", { mode: "readOnly", connectionRevision: a.connectionRevision });
  assert.equal(revoked.controls.chargingEnabled, false); assert.equal(revoked.controls.ventilationEnabled, false);
  await connect();
  await assert.rejects(service.setControlProfile("a", { ...base, mode: "all" }), e => e.code === "CONNECTION_CHANGED");
  assert.equal((await service.getConnectionStatus("a")).controls.auxiliaryHeatingEnabled, false);
});

test("profile web route enforces authentication, origin, bounded input and never changes the car", async () => {
  reset(); const a = await connect(); const before = sim.calls.length;
  const send = (body, headers = {}) => profileRoute(new Request("https://fixture.invalid/api/control-profile", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://fixture.invalid", ...headers }, body }));
  const input = JSON.stringify({ mode: "all", connectionRevision: a.connectionRevision, acknowledgement: "ALLOW_SELECTED_VEHICLE_CONTROLS" });
  assert.equal((await send(input)).status, 401);
  assert.equal((await send(input, { "oai-authenticated-user-id": "a", Origin: "https://other.invalid" })).status, 403);
  assert.equal((await send("{", { "oai-authenticated-user-id": "a" })).status, 400);
  assert.equal((await send("x".repeat(17000), { "oai-authenticated-user-id": "a" })).status, 413);
  assert.equal((await send(input, { "oai-authenticated-user-id": "a", "Content-Type": "text/plain" })).status, 415);
  const saved = await send(input, { "oai-authenticated-user-id": "a" });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).controls.chargingEnabled, true);
  assert.match(saved.headers.get("Cache-Control"), /no-store/); assert.equal(sim.calls.length, before);
});

test("profile revocation invalidates an in-flight command before any synthetic provider write", async () => {
  reset(); const a = await connect(); await service.setControlProfile("a", { mode: "all", connectionRevision: a.connectionRevision, acknowledgement: "ALLOW_SELECTED_VEHICLE_CONTROLS" });
  sim.preflightHook = async () => { await service.setControlProfile("a", { mode: "readOnly", connectionRevision: a.connectionRevision }); };
  await assert.rejects(service.executeVehicleCommand("a", "start_charging", await args("start_charging")), e => e.code === "CONTROL_NOT_ALLOWED");
  assert.equal(writes().length, 0);
});

test("setup migration marks legacy connections complete without touching credentials or permissions", () => {
  const previous = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../drizzle/", import.meta.url)).filter(p => /^000[0-4]_.*\.sql$/.test(p)).sort()) previous.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
  previous.exec("INSERT INTO connections (user_id,sealed,revision,updated_at) VALUES ('returning','opaque','same',123), ('read-only','opaque-2','same-2',456)");
  previous.exec("INSERT INTO control_permissions (user_id,revision,permission_version,ventilation_enabled,sealed_spin,updated_at) VALUES ('returning','same','permission',1,'opaque-pin',123)");
  const permission = previous.prepare("SELECT * FROM control_permissions").get();
  previous.exec(readFileSync(new URL("../drizzle/0005_same_wither.sql", import.meta.url), "utf8"));
  assert.equal(previous.prepare("SELECT setup_completed FROM connections WHERE user_id='returning'").get().setup_completed, 1);
  assert.equal(previous.prepare("SELECT setup_completed FROM connections WHERE user_id='read-only'").get().setup_completed, 1);
  assert.equal(previous.prepare("SELECT sealed FROM connections WHERE user_id='returning'").get().sealed, "opaque");
  assert.deepEqual(previous.prepare("SELECT * FROM control_permissions").get(), permission);
  previous.exec("INSERT INTO connections (user_id,sealed,revision,updated_at,setup_completed) VALUES ('new','opaque-3','same-3',789,0)");
  assert.equal(previous.prepare("SELECT setup_completed FROM connections WHERE user_id='new'").get().setup_completed, 0);
  previous.close();
});
test("setup completion is durable, revision-bound and does not depend on granting controls", async () => {
  reset(); const a = await connect(), b = await connect("b");
  assert.equal(a.setupCompleted, false);
  await assert.rejects(service.setControlProfile("a", { mode: "readOnly", connectionRevision: b.connectionRevision }), e => e.code === "CONNECTION_CHANGED");
  assert.equal((await service.getConnectionStatus("a")).setupCompleted, false);
  const before = sim.calls.length;
  assert.equal((await service.setControlProfile("a", { mode: "readOnly", connectionRevision: a.connectionRevision })).setupCompleted, true);
  assert.equal((await service.getConnectionStatus("a")).setupCompleted, true);
  assert.equal((await service.getConnectionStatus("b")).setupCompleted, false);
  assert.equal(sim.calls.length, before);
  assert.equal((await connect()).setupCompleted, false); // A replacement requires its own profile review.
  assert.equal(writes().length, 0);
});
test("renewal uses only the owned stored VIN and keeps completion while resetting grants and PIN", async () => {
  reset(); const a = await connect(); await permit("ventilation"); await pin();
  await service.setControlProfile("a", { mode: "all", connectionRevision: a.connectionRevision, acknowledgement: "ALLOW_SELECTED_VEHICLE_CONTROLS" });
  await connect("b"); const bob = await service.getConnectionStatus("b");
  const before = sim.calls.length;
  sim.expectedApiKey = "synthetic-renewed-key";
  const renewed = await service.renewVehicleKey("a", { connectionRevision: a.connectionRevision, apiKey: sim.expectedApiKey });
  assert.notEqual(renewed.connectionRevision, a.connectionRevision); assert.equal(renewed.setupCompleted, true);
  assert.equal(renewed.vin, a.vin);
  for (const flag of ["ventilationEnabled", "chargingEnabled", "airConditioningEnabled", "auxiliaryHeatingEnabled", "auxiliaryHeatingSpinConfigured"]) assert.equal(renewed.controls[flag], false);
  assert.equal(sim.calls.length, before + 1); assert.equal(sim.calls.at(-1).include, "info"); assert(sim.calls.at(-1).path.includes(config.vin));
  assert.deepEqual(await service.getConnectionStatus("b"), { ...bob, api: renewed.api, lastQuotaResponseAt: renewed.lastQuotaResponseAt });
  assert(!JSON.stringify(renewed).includes(sim.expectedApiKey)); assert.equal(writes().length, 0);
});
test("failed renewal preserves the old connection, permissions, PIN and completion", async () => {
  reset(); const a = await connect(); await permit("ventilation"); await pin();
  await service.setControlProfile("a", { mode: "readOnly", connectionRevision: a.connectionRevision });
  const before = sql.prepare("SELECT * FROM connections WHERE user_id='a'").get();
  const permission = sql.prepare("SELECT * FROM control_permissions WHERE user_id='a'").get();
  sim.infoHook = () => Response.json({}, { status: 401 });
  await assert.rejects(service.renewVehicleKey("a", { connectionRevision: a.connectionRevision, apiKey: config.apiKey }));
  assert.deepEqual(sql.prepare("SELECT * FROM connections WHERE user_id='a'").get(), before);
  assert.deepEqual(sql.prepare("SELECT * FROM control_permissions WHERE user_id='a'").get(), permission);
  assert.equal(writes().length, 0);
});
test("renewal rejects injected VIN/user, foreign/stale revision and malformed keys before provider access", async () => {
  reset(); const a = await connect(), b = await connect("b"); const before = sim.calls.length;
  const base = { connectionRevision: a.connectionRevision, apiKey: config.apiKey };
  for (const input of [null, [], {}, { ...base, vin: config.vin }, { ...base, userId: "b" }, { ...base, connectionRevision: b.connectionRevision }, { ...base, apiKey: "bad\nkey" }]) await assert.rejects(service.renewVehicleKey("a", input));
  await assert.rejects(service.renewVehicleKey("no-account", base));
  assert.equal(sim.calls.length, before); assert.equal(sql.prepare("SELECT attempts FROM connection_attempts WHERE user_id='a'").get().attempts, 1);
  assert.equal(writes().length, 0);
});
test("renewal cannot resurrect a connection disconnected during key verification", async () => {
  reset(); const a = await connect();
  sim.infoHook = async () => { await service.disconnectVehicle("a"); };
  await assert.rejects(service.renewVehicleKey("a", { connectionRevision: a.connectionRevision, apiKey: config.apiKey }), e => ["CONNECTION_CHANGED", "CONNECTION_ATTEMPT_EXPIRED"].includes(e.code));
  assert.equal((await service.getConnectionStatus("a")).connected, false); assert.equal(writes().length, 0);
});
test("renewal route enforces authentication, same-origin JSON, payload limits and account ownership", async () => {
  reset(); const a = await connect(), b = await connect("b"); const before = sim.calls.length;
  const headers = { "oai-authenticated-user-id": "a", origin: "https://example.test", "content-type": "application/json" };
  const request = (body, override = {}) => new Request("https://example.test/api/connection-key", { method: "POST", headers: { ...headers, ...override }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const payload = { connectionRevision: a.connectionRevision, apiKey: config.apiKey };
  const unauthenticated = request(payload); unauthenticated.headers.delete("oai-authenticated-user-id");
  assert.equal((await renewalRoute(unauthenticated)).status, 401);
  assert.equal((await renewalRoute(request(payload, { origin: "https://attacker.test" }))).status, 403);
  assert.equal((await renewalRoute(request(payload, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await renewalRoute(request("{"))).status, 400);
  assert.equal((await renewalRoute(request("x".repeat(16385)))).status, 413);
  assert.equal((await renewalRoute(request({ ...payload, connectionRevision: b.connectionRevision }))).status, 409);
  assert.equal(sim.calls.length, before);
  const response = await renewalRoute(request(payload)); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(writes().length, 0);
});

test("profile and modal PIN save together, encrypted and isolated, without contacting the vehicle", async () => {
  reset(); const a = await connect(); await connect('b'); const before = sim.calls.length;
  const input = { mode: 'all', connectionRevision: a.connectionRevision, acknowledgement: 'ALLOW_SELECTED_VEHICLE_CONTROLS', spin: 'synthetic-modal-pin' };
  const response = await profileRoute(new Request('https://fixture.invalid/api/control-profile', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fixture.invalid', 'oai-authenticated-user-id': 'a' }, body: JSON.stringify(input) }));
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
  const status = await response.json();
  assert.equal(status.controls.auxiliaryHeatingEnabled, true); assert.equal(status.controls.auxiliaryHeatingSpinConfigured, true);
  assert.equal((await service.getConnectionStatus('b')).controls.auxiliaryHeatingSpinConfigured, false);
  let row = sql.prepare("SELECT * FROM control_permissions WHERE user_id='a'").get();
  const original = row.sealed_spin;
  assert(!row.sealed_spin.includes(input.spin)); assert(!JSON.stringify(status).includes(input.spin));
  assert.equal(await unseal(row.sealed_spin, globalThis.__publicApiEnv.VEHICLE_VAULT_KEY, `spin:a:${a.connectionRevision}`), input.spin);
  await assert.rejects(unseal(row.sealed_spin, globalThis.__publicApiEnv.VEHICLE_VAULT_KEY, `spin:b:${a.connectionRevision}`));
  await service.setControlProfile('a', { mode: 'all', connectionRevision: a.connectionRevision, acknowledgement: input.acknowledgement });
  assert.equal(sql.prepare("SELECT sealed_spin FROM control_permissions WHERE user_id='a'").get().sealed_spin, original);
  await service.setControlProfile('a', { ...input, spin: 'synthetic-replacement-pin' });
  row = sql.prepare("SELECT * FROM control_permissions WHERE user_id='a'").get();
  assert.notEqual(row.sealed_spin, original);
  assert.equal(await unseal(row.sealed_spin, globalThis.__publicApiEnv.VEHICLE_VAULT_KEY, `spin:a:${a.connectionRevision}`), 'synthetic-replacement-pin');
  assert.equal(sim.calls.length, before); assert.equal(writes().length, 0);
});

test("invalid or unrelated PIN and foreign revision cannot partially save a profile", async () => {
  reset(); const a = await connect(), b = await connect('b');
  const input = { mode: 'all', connectionRevision: a.connectionRevision, acknowledgement: 'ALLOW_SELECTED_VEHICLE_CONTROLS', spin: 'synthetic-valid-pin' };
  for (const spin of ['', null, 1234, 'bad\npin', 'x'.repeat(129)]) await assert.rejects(service.setControlProfile('a', { ...input, spin }), e => e.code === 'INVALID_SPIN_INPUT');
  await assert.rejects(service.setControlProfile('a', { ...input, mode: 'readOnly' }), e => e.code === 'INVALID_SPIN_INPUT');
  await assert.rejects(service.setControlProfile('a', { ...input, connectionRevision: b.connectionRevision }), e => e.code === 'CONNECTION_CHANGED');
  assert.equal(sql.prepare('SELECT count(*) n FROM control_permissions').get().n, 0);
  assert.equal((await service.getConnectionStatus('a')).setupCompleted, false);
  assert.equal(writes().length, 0);
});

test("a failed profile transaction rolls back both PIN and grants", async () => {
  reset(); const a = await connect(); await pin('synthetic-old-pin');
  const before = sql.prepare("SELECT * FROM control_permissions WHERE user_id='a'").get();
  sql.exec("CREATE TEMP TRIGGER reject_modal_profile BEFORE UPDATE OF setup_completed ON connections BEGIN SELECT RAISE(ABORT, 'synthetic profile failure'); END");
  try {
    await assert.rejects(service.setControlProfile('a', { mode: 'all', connectionRevision: a.connectionRevision, acknowledgement: 'ALLOW_SELECTED_VEHICLE_CONTROLS', spin: 'synthetic-new-pin' }));
    assert.deepEqual(sql.prepare("SELECT * FROM control_permissions WHERE user_id='a'").get(), before);
    assert.equal((await service.getConnectionStatus('a')).setupCompleted, false);
  } finally { sql.exec('DROP TRIGGER reject_modal_profile'); }
  assert.equal(writes().length, 0);
});
