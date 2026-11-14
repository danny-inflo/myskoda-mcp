import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { VEHICLE_OPERATIONS, ALL_PARTS, CHARGE_MODES, commandInput, sendVehicleCommand, fingerprint, mergeChargingProfile, commandObservation, safeError } from "../lib/skoda-core.mjs";

const config = { vin: "TMBJB9NY5RF999999", apiKey: "synthetic-public-api-key", spin: "9593" };
const profile = { id: 3, name: "Synthetic home", settings: { maxChargingCurrent: "MAXIMUM", targetStateOfChargeInPercent: 80, minBatteryStateOfCharge: { enabled: true, minimumBatteryStateOfChargeInPercent: 30, future: "keep" }, futureSetting: true }, preferredChargingTimes: [{ id: 7, enabled: true, startTime: "22:00", endTime: "06:00", future: "keep" }], timers: [{ id: 8, enabled: true, time: "08:00", type: "RECURRING", recurringOn: ["MONDAY"], future: "keep" }], futureProfileField: { retain: true } };
const definition = (action) => VEHICLE_OPERATIONS.find((item) => item.action === action);
const input = (action, parameters = {}) => ({ requestId: randomUUID(), confirmation: definition(action).confirmation, ...parameters });

// This snapshot was downloaded from the official public URL, not generated from
// the integration's operation registry. Test endpoint + method + operationId.
test("all published API operations and read sections are represented by the implementation", () => {
  const schema = readFileSync(new URL("../docs/myskoda-public-api-1.1.0.yaml", import.meta.url), "utf8");
  const endpoints = [...schema.matchAll(/^  (\/api\/v1\/vehicles\/\{vin\}[^:]*):\n    (get|post|put):([\s\S]*?)(?=^  \/api|^components:)/gm)].map((m) => ({ path: m[1], method: m[2].toUpperCase(), operationId: m[3].match(/operationId: (\w+)/)[1] }));
  assert.equal(endpoints.length, 12);
  assert.deepEqual(endpoints.filter((e) => e.method !== "GET").sort((a,b) => a.operationId.localeCompare(b.operationId)), VEHICLE_OPERATIONS.map((d) => ({ path: `/api/v1/vehicles/{vin}/${d.path}`, method: d.method, operationId: d.operationId })).sort((a,b) => a.operationId.localeCompare(b.operationId)));
  const parts = schema.match(/    VehiclePart:[\s\S]*?(?=^    \w+:)/m)[0];
  assert.deepEqual([...parts.matchAll(/^      - (\w+)/gm)].map((m) => m[1]).sort(), [...ALL_PARTS].sort());
});

test("new commands use the exact official method, body and fixed path", async () => {
  const cases = [
    ["start_charging", {}, "POST", "charging/start", undefined],
    ["stop_charging", {}, "POST", "charging/stop", undefined],
    ["set_charging_limit", { targetStateOfChargeInPercent: 90 }, "PUT", "charging/limit", { targetStateOfChargeInPercent: 90 }],
    ["set_charge_mode", { chargeMode: "TIMER" }, "PUT", "charging/mode", { chargeMode: "TIMER" }],
    ["start_air_conditioning", { targetTemperature: { value: 72.5, unit: "FAHRENHEIT" }, airConditioningWithoutExternalPower: false }, "POST", "air-conditioning/start", { targetTemperature: { value: 72.5, unit: "FAHRENHEIT" }, airConditioningWithoutExternalPower: false }],
    ["stop_air_conditioning", {}, "POST", "air-conditioning/stop", undefined],
    ["start_auxiliary_heating", { durationInSeconds: 600, startMode: "VENTILATION" }, "POST", "auxiliary-heating/start", { durationInSeconds: 600, startMode: "VENTILATION", spin: config.spin }],
    ["stop_auxiliary_heating", {}, "POST", "auxiliary-heating/stop", undefined],
    ["update_charging_profile", { profileId: 3, profile }, "PUT", "charging-profiles/3", profile],
  ];
  for (const [action, parameters, method, path, body] of cases) {
    let calls = 0;
    const result = await sendVehicleCommand(config, action, parameters, async (url, options) => {
      calls++;
      assert.equal(url.href, `https://public.api.connect.skoda-auto.cz/api/v1/vehicles/${config.vin}/${path}`);
      assert.equal(options.method, method); assert.equal(options.redirect, "manual");
      assert.deepEqual(options.body ? JSON.parse(options.body) : undefined, body);
      assert.equal(options.headers["Content-Type"], body ? "application/json" : undefined);
      return new Response(null, { status: 202 });
    });
    assert.equal(result.accepted, true); assert.equal(calls, 1);
  }
  for (const action of ["start_air_conditioning", "start_auxiliary_heating"]) await sendVehicleCommand(config, action, {}, async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), action === "start_air_conditioning" ? {} : { spin: config.spin });
    return new Response(null, { status: 202 });
  });
});

test("all charge modes and contractual limit boundaries validate; malformed parameters do not", () => {
  for (const mode of CHARGE_MODES) assert.equal(commandInput(input("set_charge_mode", { chargeMode: mode }), "set_charge_mode").parameters.chargeMode, mode);
  for (const n of [1, 50, 80, 100]) assert.equal(commandInput(input("set_charging_limit", { targetStateOfChargeInPercent: n }), "set_charging_limit").parameters.targetStateOfChargeInPercent, n);
  const invalid = [["set_charging_limit", {}], ["set_charging_limit", { targetStateOfChargeInPercent: 0 }], ["set_charging_limit", { targetStateOfChargeInPercent: 101 }], ["set_charging_limit", { targetStateOfChargeInPercent: 80.5 }], ["set_charge_mode", { chargeMode: "GUESS" }], ["start_air_conditioning", { targetTemperature: { value: 22 } }], ["start_air_conditioning", { targetTemperature: { value: Infinity, unit: "CELSIUS" } }], ["start_auxiliary_heating", { durationInSeconds: -1 }], ["start_auxiliary_heating", { spin: "9593" }], ["stop_charging", { vin: config.vin }]];
  for (const [action, parameters] of invalid) assert.throws(() => commandInput(input(action, parameters), action));
  for (const d of VEHICLE_OPERATIONS) assert.throws(() => commandInput({ ...input(d.action), confirmation: "NOT_CONFIRMED" }, d.action), (e) => e.code === "ACTION_CONFIRMATION_REQUIRED");
});

test("profile changes preserve unrelated and future fields, deep settings, exact IDs and explicit list replacements", () => {
  const source = structuredClone(profile);
  const result = mergeChargingProfile(source, { settings: { minBatteryStateOfCharge: { enabled: false } }, preferredChargingTimes: [{ id: 7, enabled: false, startTime: "23:00", endTime: "06:00" }], timers: [{ id: 8, enabled: true, time: "09:00", type: "ONE_OFF", oneOffDay: "TUESDAY" }] });
  assert.deepEqual(source, profile);
  assert.equal(result.id, 3); assert.equal(result.name, profile.name);
  assert.deepEqual(result.settings.minBatteryStateOfCharge, { enabled: false, minimumBatteryStateOfChargeInPercent: 30, future: "keep" });
  assert.equal(result.settings.futureSetting, true); assert.equal(result.futureProfileField.retain, true);
  assert.equal(result.preferredChargingTimes[0].future, "keep"); assert.equal(result.timers[0].future, "keep");
  assert.equal(result.timers[0].recurringOn, undefined); assert.equal(result.timers[0].oneOffDay, "TUESDAY");
  assert.deepEqual(mergeChargingProfile(profile, { timers: [] }).timers, []);
  assert.equal(mergeChargingProfile(profile, { settings: { minBatteryStateOfCharge: { minimumBatteryStateOfChargeInPercent: 0 } } }).settings.minBatteryStateOfCharge.minimumBatteryStateOfChargeInPercent, 0);
  assert.throws(() => mergeChargingProfile(profile, { timers: [{ id: 8, enabled: true, type: "ONE_OFF", recurringOn: ["MONDAY"] }] }));
  for (const changes of [{}, { id: 9 }, { settings: { unknown: true } }, { preferredChargingTimes: [{ id: 7, enabled: true, startTime: "24:00", endTime: "06:00" }] }, { timers: [{ id: 8, enabled: false, type: "RECURRING" }, { id: 8, enabled: true, type: "RECURRING" }] }]) assert.throws(() => mergeChargingProfile(profile, changes));
  assert.throws(() => mergeChargingProfile({ ...profile, id: Number.MAX_SAFE_INTEGER + 1 }, { name: "x" }));
});

test("fingerprints ignore object property order and change with any profile change", async () => {
  assert.equal(await fingerprint({ a: 1, b: { z: 0, c: 2 } }), await fingerprint({ b: { c: 2, z: 0 }, a: 1 }));
  assert.notEqual(await fingerprint(profile), await fingerprint({ ...profile, name: "Changed" }));
});

test("S-PIN is required outside tool input and is redacted from all provider problem fields", async () => {
  await assert.rejects(sendVehicleCommand({ ...config, spin: undefined }, "start_auxiliary_heating"), (e) => e.code === "HEATING_SPIN_REQUIRED");
  await assert.rejects(sendVehicleCommand(config, "start_auxiliary_heating", {}, async () => Response.json({ type: "about:blank", title: config.spin, detail: `${config.apiKey} ${config.spin} ${config.vin}`, instance: config.spin }, { status: 403 })), (e) => {
    const result = JSON.stringify(safeError(e));
    for (const secret of [config.spin, config.apiKey, config.vin]) assert(!result.includes(secret));
    return true;
  });
  await assert.rejects(sendVehicleCommand(config, "update_charging_profile", { profileId: 4, profile }), (e) => e.code === "PROFILE_ID_MISMATCH");
});

test("each command confirms only a matching fresh vehicle measurement", () => {
  const now = Date.now(), timestamp = new Date(now).toISOString();
  const cases = [
    ["start", {}, { activeVentilation: { state: "VENTILATION" } }], ["stop", {}, { activeVentilation: { state: "OFF" } }],
    ["start_charging", {}, { charging: { status: { state: "CHARGING" } } }], ["stop_charging", {}, { charging: { status: { state: "CHARGING_INTERRUPTED" } } }],
    ["set_charging_limit", { targetStateOfChargeInPercent: 80 }, { charging: { settings: { targetStateOfChargeInPercent: 80 } } }],
    ["set_charge_mode", { chargeMode: "TIMER" }, { charging: { settings: { preferredChargeMode: "TIMER" } } }],
    ["start_air_conditioning", { targetTemperature: { value: 22, unit: "CELSIUS" } }, { airConditioning: { state: "COOLING", targetTemperature: { unit: "CELSIUS", value: 22 } } }],
    ["stop_air_conditioning", {}, { airConditioning: { state: "OFF" } }],
    ["start_auxiliary_heating", { startMode: "VENTILATION", durationInSeconds: 600 }, { auxiliaryHeating: { state: "VENTILATION", durationInSeconds: 600 } }],
    ["stop_auxiliary_heating", {}, { auxiliaryHeating: { state: "OFF" } }],
    ["update_charging_profile", { profileId: 3, profile }, { chargingProfiles: { profiles: [profile] } }],
  ];
  for (const [action, parameters, vehicle] of cases) {
    const d = definition(action);
    vehicle[d.part].carCapturedTimestamp = timestamp;
    assert.equal(commandObservation(d, parameters, vehicle, now, now).status, "confirmed", action);
    for (const t of [undefined, new Date(now - 1).toISOString(), new Date(now + 1).toISOString()]) {
      vehicle[d.part].carCapturedTimestamp = t;
      assert.equal(commandObservation(d, parameters, vehicle, now, now).status, "unconfirmed", action);
    }
    assert.equal(commandObservation(d, parameters, {}, now, now).status, "unconfirmed");
  }
});
