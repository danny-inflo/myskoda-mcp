import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { credentials, seal, unseal, fetchVehicle, metadata, projection, safeError, vehicleHash, SUMMARY_PARTS, ALL_PARTS, energySummary, lockSummary, freshness } from "../lib/skoda-core.mjs";
const vin = "TMBJB9NY5RF999999";
const key = "test-api-key-never-return";
const secret = randomBytes(32).toString("base64");
test("vault encrypts credentials and binds ciphertext to its user and purpose", async () => {
  const value = await seal({ vin, apiKey: key }, secret, "user-a:connection");
  assert(!value.includes(key)); assert(!value.includes(vin));
  assert.deepEqual(await unseal(value, secret, "user-a:connection"), { vin, apiKey: key });
  await assert.rejects(unseal(value, secret, "user-b:connection"));
  await assert.rejects(unseal(value, secret, "user-a:cache"));
  await assert.rejects(unseal(value, randomBytes(32).toString("base64"), "user-a:connection"));
  assert.notEqual(await seal({ vin }, secret, "x"), await seal({ vin }, secret, "x"));
  assert.equal(await vehicleHash(vin, secret), await vehicleHash(vin, secret));
});
test("VIN and header injection are rejected before network access", () => {
  assert.throws(() => credentials({ vin: "../malicious", apiKey: key }));
  assert.throws(() => credentials({ vin, apiKey: "abc\r\nInjected: value" }));
  assert.equal(credentials({ vin: vin.toLowerCase(), apiKey: key }).vin, vin);
});
test("fixed origin GET, header key, no redirects, no location in overview", async () => {
  let calls = 0;
  const result = await fetchVehicle({ vin, apiKey: key }, ["info", "charging"], async (url, init) => {
    calls++; assert.equal(url.origin, "https://public.api.connect.skoda-auto.cz");
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "manual");
    assert.equal(init.headers["X-API-Key"], key); assert(!url.href.includes(key));
    assert.equal(url.searchParams.get("include"), "info,charging");
    return Response.json({ vehicle: { vin, name: "Enyaq", charging: { battery: { stateOfChargeInPercent: 0 } }, parkingPosition: { latitude: 50 }, licensePlate: "PRIVATE" }, errors: [{ type: "PART_UNAVAILABLE", description: key }] }, { headers: { "X-API-Key-Expires-At": "2027-01-01T00:00:00Z" } });
  });
  assert.equal(calls, 1); assert(!JSON.stringify(result).includes(key));
  assert(!("parkingPosition" in result.data.vehicle)); assert.equal(result.data.vehicle.licensePlate, "PRIVATE");
  assert.deepEqual(result.data.errors, [{ type: "PART_UNAVAILABLE", description: "[REDACTED]" }]);
  const view = projection(result.data, "charging");
  assert(!view.vehicle.vin.includes(vin)); assert.equal(view.vehicle.charging.battery.stateOfChargeInPercent, 0);
});
test("partial responses preserve unknown data rather than inventing zeros", async () => {
  const result = await fetchVehicle({ vin, apiKey: key }, ["charging"], async () => Response.json({ vehicle: { vin }, errors: [{ type: "CHARGING_UNSUPPORTED" }] }));
  const view = projection(result.data, "charging");
  assert(!("charging" in view.vehicle)); assert.equal(view.errors[0].type, "CHARGING_UNSUPPORTED");
});
test("401,403,429,5xx bodies and transport errors cannot echo credentials", async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(fetchVehicle({ vin, apiKey: key }, ["info"], async () => Response.json({ type: "rate-limit-exceeded", detail: key }, { status, headers: { "Retry-After": "60" } })), (error) => {
      assert(!JSON.stringify(safeError(error)).includes(key));
      if (status === 429) { assert.equal(error.retryAfter, 60); assert.equal(error.code, "RATE_LIMITED"); }
      return true;
    });
  }
  await assert.rejects(fetchVehicle({ vin, apiKey: key }, ["info"], async () => { throw new Error(key); }), (e) => !JSON.stringify(safeError(e)).includes(key));
  await assert.rejects(fetchVehicle({ vin, apiKey: key }, ["info"], async () => Response.json({ vehicle: { vin: "OTHER" } })));
});
test("quota headers use delta-seconds; malformed and absent values remain unknown", () => {
  const meta = metadata(new Headers({ "RateLimit-Remaining": "0", "RateLimit-Limit": "20", "RateLimit-Reset": "40", "Retry-After": "30" }), 1000);
  assert.equal(meta.remaining, 0); assert.equal(meta.resetAt, 41000); assert.equal(meta.retryAfter, 30);
  assert.equal(metadata(new Headers()).remaining, null);
  assert.equal(metadata(new Headers({ "RateLimit-Remaining": "-1", "RateLimit-Reset": "garbage" })).resetAt, null);
  assert.equal(meta.resetAtIso, "1970-01-01T00:00:41.000Z");
  assert.equal(meta.resetAfterSeconds, 40);
  assert.equal(metadata(new Headers({ "RateLimit-Reset": "9007199254740991" })).resetAt, null);
});

test("diesel raw SoC is preserved but never becomes traction battery charge", () => {
  const fuelStatus = { carType: "DIESEL", adBlueRange: 7000, totalRangeInKm: 350, primaryEngineRange: { engineType: "DIESEL", currentFuelLevelInPercent: 47, currentSoCInPercent: 47, remainingRangeInKm: 350 } };
  const view = projection({ vehicle: { vin, fuelStatus }, errors: [], requestedParts: SUMMARY_PARTS }, "energy");
  assert.equal(view.vehicle.fuelStatus.primaryEngineRange.currentSoCInPercent, 47);
  assert.equal(view.normalized.energy.engines[0].fuelLevelPercent, 47);
  assert.equal(view.normalized.energy.batteryStateOfChargePercent, null);
  assert.equal(view.normalized.energy.adBlueRangeKm, 7000);
  assert.equal(view.warnings[0].code, "COMBUSTION_SOC_AMBIGUOUS");
  assert.equal(fuelStatus.primaryEngineRange.currentSoCInPercent, 47);
});

test("EV, hybrid, alternative-fuel, zero and future engine values retain correct semantics", () => {
  const ev = energySummary({ charging: { status: { battery: { stateOfChargeInPercent: 0, remainingCruisingRangeInMeters: 123456 } } } });
  assert.equal(ev.batteryStateOfChargePercent, 0); assert.equal(ev.electricRangeKm, 123.456);
  const hybrid = energySummary({ fuelStatus: { carType: "HYBRID", primaryEngineRange: { engineType: "GASOLINE", currentFuelLevelInPercent: 50, currentSoCInPercent: 50 }, secondaryEngineRange: { engineType: "ELECTRIC", currentSoCInPercent: 30, remainingRangeInKm: 42 } } });
  assert.equal(hybrid.engines.length, 2); assert.equal(hybrid.batteryStateOfChargePercent, 30); assert.equal(hybrid.electricRangeKm, 42);
  for (const engineType of ["CNG", "LPG"]) assert.equal(energySummary({ fuelStatus: { primaryEngineRange: { engineType, currentFuelLevelInPercent: 0 } } }).engines[0].fuelLevelPercent, 0);
  const future = energySummary({ fuelStatus: { primaryEngineRange: { engineType: "FUTURE_ENGINE", currentSoCInPercent: 25 } } });
  assert.equal(future.engines[0].engineType, "FUTURE_ENGINE"); assert.equal(future.batteryStateOfChargePercent, null);
});

test("per-view errors remain relevant and full partial-data diagnostics survive", () => {
  const data = { vehicle: { vin, status: { overall: { doors: "CLOSED" } } }, requestedParts: SUMMARY_PARTS, errors: [{ type: "CHARGING_UNSUPPORTED" }, { type: "AIR_CONDITIONING_DISABLED" }, { type: "OPERATIONS_UNAVAILABLE" }] };
  const status = projection(data, "status");
  assert.deepEqual(status.errors, []);
  assert.equal(status.diagnostics.sourceErrors.length, 3);
  assert.equal(status.diagnostics.parts.charging.state, "unsupported");
  assert.equal(status.diagnostics.parts.airConditioning.state, "disabled");
  assert.equal(status.diagnostics.parts.operations.state, "unavailable");
  assert.equal(status.diagnostics.parts.parkingPosition.state, "not_requested");
  assert.equal(status.diagnostics.parts.odometer.state, "unknown");
  assert.equal(projection(data, "capabilities").errors[0].type, "OPERATIONS_UNAVAILABLE");
});

test("unsupported charging profiles are informational without inventing an empty list", () => {
  const error = { type: "CHARGING_PROFILES_UNSUPPORTED", description: "Profiles are not supported." };
  const view = projection({ vehicle: { vin }, requestedParts: ["chargingProfiles"], errors: [error] }, "profiles");
  assert.equal(view.presentation.readSucceeded, true);
  assert.equal(view.presentation.status, "unsupported");
  assert.equal(view.presentation.severity, "info");
  assert.match(view.presentation.summary, /nepodporuje/);
  assert.match(view.presentation.summary, /nejde o poruchu/);
  assert.equal(view.presentation.services[0].label, "Nabíjecí profily");
  assert.equal(view.presentation.services[0].severity, "info");
  assert.equal(view.vehicle.chargingProfiles, undefined);
  assert.deepEqual(view.errors, [error]);
  assert.deepEqual(view.diagnostics.sourceErrors, [error]);

  const empty = projection({ vehicle: { vin, chargingProfiles: { profiles: [] } }, requestedParts: ["chargingProfiles"], errors: [] }, "profiles");
  assert.equal(empty.presentation.status, "ok");
  assert.deepEqual(empty.vehicle.chargingProfiles.profiles, []);
});

test("available fuel plus unsupported charging is a successful informational result", () => {
  const data = { vehicle: { vin, fuelStatus: { carType: "DIESEL", primaryEngineRange: { engineType: "DIESEL", currentFuelLevelInPercent: 47 } } }, requestedParts: SUMMARY_PARTS, errors: [{ type: "CHARGING_UNSUPPORTED" }] };
  const view = projection(data, "charging");
  assert.equal(view.presentation.status, "ok");
  assert.equal(view.presentation.severity, "info");
  assert.equal(view.normalized.energy.engines[0].fuelLevelPercent, 47);
  assert.equal(view.presentation.services.find((s) => s.part === "charging").status, "unsupported");
  assert.equal(view.presentation.services.some((s) => ["parkingPosition", "chargingProfiles"].includes(s.part)), false);
  assert.deepEqual(view.errors, [{ type: "CHARGING_UNSUPPORTED" }]);
});

test("disabled and unavailable remain warnings while unknown support is never inferred", () => {
  for (const [code, state] of [["CHARGING_PROFILES_DISABLED", "disabled"], ["CHARGING_PROFILES_UNAVAILABLE", "unavailable"]]) {
    const view = projection({ vehicle: { vin }, requestedParts: ["chargingProfiles"], errors: [{ type: code }] }, "profiles");
    assert.equal(view.presentation.status, state);
    assert.equal(view.presentation.severity, "warning");
    assert.equal(view.presentation.services[0].status, state);
    assert(!view.presentation.summary.includes("nepodporuje"));
  }
  const missing = projection({ vehicle: { vin }, requestedParts: ["chargingProfiles"], errors: [] }, "profiles");
  assert.equal(missing.presentation.status, "unknown");
  assert.equal(missing.presentation.services[0].status, "unknown");
  assert.equal(missing.vehicle.chargingProfiles, undefined);
  const mixed = projection({ vehicle: { vin, activeVentilation: { state: "OFF" } }, requestedParts: SUMMARY_PARTS, errors: [{ type: "AIR_CONDITIONING_UNSUPPORTED" }, { type: "AUXILIARY_HEATING_UNAVAILABLE" }] }, "climate");
  assert.equal(mixed.presentation.status, "partial");
  assert.equal(mixed.presentation.severity, "warning");
  assert.equal(mixed.presentation.services.find((s) => s.part === "airConditioning").severity, "info");
});

test("status presentation excludes unrelated feature diagnostics", () => {
  const view = projection({ vehicle: { vin, status: { overall: { locked: "YES" } } }, requestedParts: SUMMARY_PARTS, errors: [{ type: "CHARGING_UNSUPPORTED" }, { type: "AIR_CONDITIONING_UNAVAILABLE" }] }, "status");
  assert.equal(view.presentation.status, "ok");
  assert.equal(view.presentation.services.length, 1);
  assert.equal(view.presentation.services[0].part, "status");
  assert.equal(view.presentation.services[0].severity, "info");
  assert.equal(view.diagnostics.sourceErrors.length, 2);
});

test("unknown charging state never means cable disconnected", () => {
  const charging = { status: { plugConnectionState: "CONNECTED", plugLockState: "UNLOCKED", chargeType: "FUTURE_CHARGE_TYPE" } };
  const view = projection({ vehicle: { vin, charging }, errors: [] }, "charging");
  assert.equal(view.vehicle.charging.status.plugConnectionState, "CONNECTED");
  assert.equal(view.vehicle.charging.status.state, undefined);
  assert.equal(view.vehicle.charging.status.chargeType, "FUTURE_CHARGE_TYPE");
});

test("lock disagreements are unknown and roof is separate from side windows", () => {
  const status = { overall: { doorsLocked: "YES", locked: "NO", windows: "CLOSED" }, detail: { sunroof: "OPEN" } };
  assert.equal(lockSummary(status).state, "unknown"); assert.equal(lockSummary(status).conflict, true);
  assert.equal(lockSummary(status).sideWindows, "CLOSED"); assert.equal(lockSummary(status).sunroof, "OPEN");
  assert.equal(lockSummary({ overall: { reliableLockStatus: "FUTURE" } }).state, "unknown");
  assert.equal(lockSummary({ overall: { doorsLocked: "TRUNK_OPENED" } }).state, "open");
});

test("all read sections are allowlisted; profile and position data never enter other views", async () => {
  assert.equal(ALL_PARTS.length, 11);
  const body = { vehicle: { vin, name: "Test", licensePlate: "SECRET-PLATE", renderUrl: "https://example.test/car.png", operations: [{ name: "startCharging" }, { name: "futureOperation" }], chargingProfiles: { profiles: [{ id: 1, name: "HOME" }] }, parkingPosition: { state: "PARKED", gpsCoordinates: { latitude: 50, longitude: 14 } } } };
  const result = await fetchVehicle({ vin, apiKey: key }, SUMMARY_PARTS, async () => Response.json(body));
  assert.equal(result.data.vehicle.parkingPosition, undefined); assert.equal(result.data.vehicle.chargingProfiles, undefined);
  const view = projection(result.data, "overview");
  assert.equal(view.vehicle.licensePlate, "•••• TE"); assert.equal(view.vehicle.renderUrl, "https://example.test/car.png");
  assert.equal(view.vehicle.operations[1].name, "futureOperation"); assert.equal(view.normalized.operations.integrationControlEnabled, false);
  assert.throws(() => projection(result.data, "invalid"), (e) => e.code === "INVALID_VIEW");
  await assert.rejects(fetchVehicle({ vin, apiKey: key }, ["commands"], () => { throw new Error("must not fetch"); }), (e) => e.code === "INVALID_PART");
});

test("parking has no invented measurement time and no coordinates in motion", () => {
  const view = projection({ vehicle: { vin, parkingPosition: { state: "PARKED", gpsCoordinates: { latitude: 50, longitude: 14 } } }, errors: [], requestedParts: ["parkingPosition"] }, "position");
  assert.equal(view.normalized.parking.measuredAt, null); assert.equal(view.normalized.parking.ageKnown, false);
  assert.equal(view.normalized.parking.mapUrl, "https://www.google.com/maps?q=50,14");
  const moving = projection({ vehicle: { vin, parkingPosition: { state: "IN_MOTION", gpsCoordinates: { latitude: 50, longitude: 14 }, formattedAddress: "stale" } }, errors: [], requestedParts: ["parkingPosition"] }, "position");
  assert.equal(moving.vehicle.parkingPosition.gpsCoordinates, undefined); assert.equal(moving.normalized.parking.mapUrl, undefined);
});

test("climate run duration and per-part measurement ages remain explicit", () => {
  const data = { vehicle: { vin, activeVentilation: { state: "OFF", durationInSeconds: 600, carCapturedTimestamp: "2026-10-29T23:34:51Z" }, status: { carCapturedTimestamp: "2026-10-29T19:32:44Z" } }, errors: [], requestedParts: SUMMARY_PARTS };
  assert.equal(projection(data, "climate").normalized.activeVentilation.configuredRunDurationSeconds, 600);
  const f = freshness(data, Date.parse("2026-10-30T10:56:27Z"), Date.parse("2026-10-30T10:57:27Z"));
  assert.equal(f.cacheAgeSeconds, 60); assert.notEqual(f.parts.status.ageSeconds, f.parts.activeVentilation.ageSeconds);
  assert.equal(f.parts.charging.measuredAt, null); assert.equal(f.parts.charging.ageSeconds, null);
});

test("problem types distinguish vehicle refusal, disabled services and key errors", async () => {
  for (const [status, type, code] of [[401,"api-key-expired","KEY_EXPIRED"],[403,"api-key-not-authorized","KEY_NOT_AUTHORIZED"],[403,"operation-not-authorized","OPERATION_NOT_AUTHORIZED"],[422,"operation-not-supported","OPERATION_UNSUPPORTED"],[422,"operation-disabled","OPERATION_DISABLED"],[429,"rate-limit-exceeded","RATE_LIMITED"],[429,"vehicle-not-accepting-requests","VEHICLE_NOT_ACCEPTING_REQUESTS"],[503,"about:blank","UPSTREAM_503"],[504,"about:blank","UPSTREAM_504"]]) {
    await assert.rejects(fetchVehicle({ vin, apiKey: key }, ["info"], async () => Response.json({ type: type === "about:blank" ? type : `https://public.api.connect.skoda-auto.cz/problems/${type}`, detail: `secret ${key} ${vin}`, instance: `/api/v1/vehicles/${vin}` }, { status, headers: { "Retry-After": "10", "RateLimit-Remaining": "7" } })), (e) => {
      const safe = safeError(e);
      assert.equal(safe.httpStatus, status); assert.equal(safe.code, code); assert.equal(safe.api.remaining, 7);
      assert(!JSON.stringify(safe).includes(key)); assert(!JSON.stringify(safe).includes(vin));
      assert.equal(safe.retryable, status >= 500 || status === 429); return true;
    });
  }
});
