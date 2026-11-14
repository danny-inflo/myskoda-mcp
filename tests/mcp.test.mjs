import test from "node:test";
import assert from "node:assert/strict";
import { dispatchMcp, tools } from "../lib/mcp.ts";
import { boundedJson, requireSameOrigin, userFromRequest } from "../lib/http.ts";
const call = (name, args = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
test("discovery preserves nine read-only tools and adds all eleven explicitly gated public API controls", async () => {
  const r = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null, {});
  assert.equal(r.result.tools.length, 20);
  for (const tool of tools) { assert.equal(tool.annotations.readOnlyHint, true); assert.deepEqual(tool.inputSchema.properties, {}); }
  const controls = r.result.tools.filter((tool) => !tool.annotations.readOnlyHint);
  assert.equal(controls.length, 11);
  assert.equal(new Set(controls.map((tool) => tool.name)).size, 11);
  assert.deepEqual(controls.slice(0, 2).map((tool) => tool.name), ["start_active_ventilation", "stop_active_ventilation"]);
  for (const tool of controls) { assert.equal(tool.annotations.idempotentHint, false); assert(tool.inputSchema.required.includes("requestId")); assert(tool.inputSchema.required.includes("confirmation")); }
});
test("unauthenticated calls and user/key overrides never invoke services", async () => {
  let called = false;
  const services = { status: async () => { called = true; } };
  const missing = await dispatchMcp(call("get_connection_status"), null, services);
  assert.equal(missing.result.isError, true); assert.equal(called, false);
  for (const args of [{ userId: "victim" }, { vin: "OTHER" }, { apiKey: "secret" }, []]) {
    const r = await dispatchMcp(call("get_connection_status", args), "a", services);
    assert.equal(r.error.code, -32602); assert.equal(called, false);
  }
});
test("tools pass authenticated identity and the correct privacy section", async () => {
  const calls = [];
  const services = { status: async (u) => ({ user: u }), read: async (u, k) => { calls.push([u, k]); return { ok: true }; } };
  for (const [name, kind] of [["get_vehicle_overview", "overview"], ["get_vehicle_status", "status"], ["get_charging_status", "charging"], ["get_parking_position", "position"], ["get_vehicle_capabilities", "capabilities"], ["get_climate_status", "climate"], ["get_energy_status", "energy"], ["get_charging_profiles", "profiles"]]) {
    const r = await dispatchMcp(call(name), "user-a", services); assert.equal(r.result.isError, false); assert.deepEqual(calls.at(-1), ["user-a", kind]);
  }
  assert.equal((await dispatchMcp(call("unlock_vehicle"), "a", services)).error.code, -32602);
});

test("temporary failures have an explicit code and are never classified as invalid arguments", async () => {
  const { VehicleError } = await import("../lib/skoda-core.mjs");
  const r = await dispatchMcp(call("get_vehicle_overview"), "a", { read: async () => { throw new VehicleError("REQUEST_IN_PROGRESS", "Wait", 503, 5); } });
  assert.equal(r.result.isError, true); assert.equal(r.result.structuredContent.error_code, "REQUEST_IN_PROGRESS");
  assert.equal(r.result.structuredContent.category, "temporary"); assert.equal(r.result.structuredContent.error.retryAfterSeconds, 5);
  for (const tool of tools) assert(tool.name.startsWith("get_"));
});

test("all public controls dispatch the authenticated user, exact action and parameters without any secret input", async () => {
  const { VEHICLE_OPERATIONS } = await import("../lib/skoda-core.mjs");
  const { randomUUID } = await import("node:crypto");
  const received = [];
  for (const d of VEHICLE_OPERATIONS) {
    const parameters = d.action === "set_charging_limit" ? { targetStateOfChargeInPercent: 80 } : d.action === "set_charge_mode" ? { chargeMode: "MANUAL" } : d.action === "update_charging_profile" ? { profileId: 3, expectedProfileFingerprint: "a".repeat(64), changes: { name: "Explicit new name" } } : {};
    const input = { requestId: randomUUID(), confirmation: d.confirmation, ...parameters };
    const services = { execute: async (...args) => { received.push(args); return { status: "accepted", executionConfirmed: false }; } };
    const result = await dispatchMcp(call(d.tool, input), "owner-a", services);
    assert.equal(result.result.isError, false); assert.deepEqual(received.at(-1), ["owner-a", d.action, input]);
    const count = received.length;
    for (const extra of [{ spin: "9593" }, { apiKey: "override" }, { userId: "victim" }, { url: "https://evil.invalid" }]) {
      assert.equal((await dispatchMcp(call(d.tool, { ...input, ...extra }), "owner-a", services)).result.isError, true);
      assert.equal(received.length, count);
    }
  }
});

test("unsupported-only profiles are a successful MCP result with informational presentation", async () => {
  const { projection } = await import("../lib/skoda-core.mjs");
  const value = projection({ vehicle: { vin: "TMBJB9NY5RF999999" }, requestedParts: ["chargingProfiles"], errors: [{ type: "CHARGING_PROFILES_UNSUPPORTED" }] }, "profiles");
  const response = await dispatchMcp(call("get_charging_profiles"), "a", { read: async () => value });
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.presentation.status, "unsupported");
  assert.equal(response.result.structuredContent.presentation.severity, "info");
  assert.equal(response.result.structuredContent.errors[0].type, "CHARGING_PROFILES_UNSUPPORTED");
  const discovery = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "server/discover" }, null, {});
  assert.equal(discovery.result.serverInfo.version, "0.6.1");
  assert.match(discovery.result.instructions, /presentation.summary/);
});
test("malformed JSON-RPC and notifications handled without vehicle calls", async () => {
  assert.equal((await dispatchMcp([], null, {})).error.code, -32600);
  assert.equal(await dispatchMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, null, {}), null);
  const r = await dispatchMcp(call("get_connection_status"), "a", { status: async () => { throw new Error("private-key"); } });
  assert(!JSON.stringify(r).includes("private-key")); assert.equal(r.result.isError, true);
});
test("connection writes require authenticated identity and exact same origin", () => {
  assert.throws(() => userFromRequest(new Request("https://example.test/api/connection")));
  for (const origin of ["https://evil.test", "null", ""]) assert.throws(() => requireSameOrigin(new Request("https://example.test/api/connection", { headers: { Origin: origin, "Content-Type": "application/json" } })));
  assert.doesNotThrow(() => requireSameOrigin(new Request("https://example.test/api/connection", { headers: { Origin: "https://example.test", "Content-Type": "application/json" } })));
});
test("request size bounded and invalid JSON rejected", async () => {
  await assert.rejects(boundedJson(new Request("https://example.test", { method: "POST", body: "x".repeat(17000) })), (e) => e.code === "PAYLOAD_TOO_LARGE");
  await assert.rejects(boundedJson(new Request("https://example.test", { method: "POST", body: "{" })), (e) => e.code === "INVALID_JSON");
});
