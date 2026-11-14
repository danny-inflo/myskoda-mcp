import test from "node:test";
import assert from "node:assert/strict";
import { sendVentilationCommand, commandInput, safeError } from "../lib/skoda-core.mjs";
import { randomUUID } from "node:crypto";

const config = { vin: "TMBJB9NY5RF999999", apiKey: "synthetic-command-key" };
test("ventilation client sends only the two fixed POST paths without a body or redirect following", async () => {
  for (const action of ["start", "stop"]) {
    let calls = 0;
    const result = await sendVentilationCommand(config, action, async (url, init) => {
      calls++;
      assert.equal(url.href, `https://public.api.connect.skoda-auto.cz/api/v1/vehicles/${config.vin}/active-ventilation/${action}`);
      assert.equal(init.method, "POST"); assert.equal(init.body, undefined); assert.equal(init.redirect, "manual");
      assert.equal(init.headers["X-API-Key"], config.apiKey);
      return new Response(null, { status: 202, headers: { "RateLimit-Remaining": "17" } });
    });
    assert.equal(result.accepted, true); assert.equal(result.meta.remaining, 17); assert.equal(calls, 1);
  }
  await assert.rejects(sendVentilationCommand(config, "unlock", () => { throw new Error("must not fetch"); }), (e) => e.code === "INVALID_OPERATION");
});

test("command redirects, unexpected successes and transport failures never retry or expose credentials", async () => {
  for (const status of [200, 201, 204, 301, 302, 303, 307, 308, 500, 504]) {
    let calls = 0;
    await assert.rejects(sendVentilationCommand(config, "start", async () => { calls++; return new Response(null, { status, headers: { Location: "https://untrusted.invalid" } }); }), (e) => {
      const safe = safeError(e);
      assert.equal(safe.automaticRetryAllowed, false); assert.equal(safe.retryable, false); assert.equal(safe.commandMayHaveBeenSent, true);
      assert(!JSON.stringify(safe).includes(config.apiKey)); assert(!JSON.stringify(safe).includes(config.vin));
      return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(sendVentilationCommand(config, "stop", async () => { calls++; throw new Error(config.apiKey); }), (e) => e.code === "COMMAND_OUTCOME_UNKNOWN" && e.commandMayHaveBeenSent && !safeError(e).retryable);
  assert.equal(calls, 1);
});

test("explicit provider rejection remains distinct from an uncertain command outcome", async () => {
  for (const status of [400, 401, 403, 422, 429]) {
    await assert.rejects(sendVentilationCommand(config, "start", async () => Response.json({ type: "about:blank", detail: config.apiKey }, { status })), (e) => {
      const safe = safeError(e);
      assert.equal(e.commandMayHaveBeenSent, false); assert.equal(safe.automaticRetryAllowed, false);
      assert(!JSON.stringify(safe).includes(config.apiKey)); return true;
    });
  }
});

test("confirmation is action-specific and no secret, user or URL override is accepted", () => {
  const input = { requestId: randomUUID(), confirmation: "START_VENTILATION" };
  assert.equal(commandInput(input, "start").requestId, input.requestId);
  assert.throws(() => commandInput(input, "stop"), (e) => e.code === "ACTION_CONFIRMATION_REQUIRED");
  for (const extra of [{ apiKey: "x" }, { vin: config.vin }, { userId: "x" }, { url: "https://untrusted.invalid" }]) assert.throws(() => commandInput({ ...input, ...extra }, "start"));
});
