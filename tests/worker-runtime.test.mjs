import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";

// Run the real client inside workerd. Node's Request accepts redirect: "error",
// while Cloudflare rejects it before any upstream request is sent.
const core = readFileSync(new URL("../lib/skoda-core.mjs", import.meta.url), "utf8").replace(/^export /gm, "");
const mf = new Miniflare({
  modules: true,
  compatibilityDate: "2026-05-15",
  cf: false,
  script: `${core}
export default { async fetch(request) {
  let calls = 0;
  let requestConfig;
  const mode = new URL(request.url).pathname.slice(1);
  try {
    if (mode === "put-success") {
      const result = await sendVehicleCommand({ vin: "TMBJB9NY5RF999999", apiKey: "runtime-test-only" }, "set_charging_limit", { targetStateOfChargeInPercent: 90 }, async (url, init) => {
        const actual = new Request(url, init);
        calls++;
        requestConfig = { method: actual.method, redirect: actual.redirect, body: await actual.json(), contentType: actual.headers.get("Content-Type") };
        return new Response(null, { status: 202 });
      });
      return Response.json({ result, calls, requestConfig });
    }
    if (mode.startsWith("command-")) {
      const result = await sendVentilationCommand({ vin: "TMBJB9NY5RF999999", apiKey: "runtime-test-only" }, "start", async (url, init) => {
        const actual = new Request(url, init);
        calls++;
        requestConfig = { method: actual.method, redirect: actual.redirect, origin: new URL(actual.url).origin };
        return new Response(null, { status: mode === "command-success" ? 202 : 302, headers: { Location: "https://untrusted.invalid/" } });
      });
      return Response.json({ result, calls, requestConfig });
    }
    const result = await fetchVehicle({ vin: "TMBJB9NY5RF999999", apiKey: "runtime-test-only" }, ["info"], async (url, init) => {
      const actual = new Request(url, init);
      calls++;
      requestConfig = { method: actual.method, redirect: actual.redirect, origin: new URL(actual.url).origin };
      if (mode !== "success") return new Response(null, { status: Number(mode), headers: { Location: "https://untrusted.invalid/" } });
      return Response.json({ vehicle: { vin: "TMBJB9NY5RF999999", name: "Test vehicle" }, errors: [] });
    });
    return Response.json({ result, calls, requestConfig });
  } catch(error) { return Response.json({ error: safeError(error), calls, requestConfig }); }
} };`,
});
test.after(async () => { await mf.dispose(); });

test("vehicle requests use options supported by the actual Cloudflare runtime", async () => {
  const result = await (await mf.dispatchFetch("http://localhost/success")).json();
  assert.equal(result.error, undefined);
  assert.equal(result.result.data.vehicle.name, "Test vehicle");
  assert.deepEqual(result.requestConfig, { method: "GET", redirect: "manual", origin: "https://public.api.connect.skoda-auto.cz" });
  assert.equal(result.calls, 1);
});

test("all upstream redirects fail closed inside Cloudflare without forwarding the API key", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const result = await (await mf.dispatchFetch(`http://localhost/${status}`)).json();
    assert.equal(result.error.code, "UPSTREAM_REDIRECT");
    assert.equal(result.calls, 1);
    assert.equal(result.requestConfig.redirect, "manual");
    assert(!JSON.stringify(result).includes("runtime-test-only"));
    assert(!JSON.stringify(result).includes("untrusted.invalid"));
  }
});

test("ventilation POST options and redirect rejection work in actual Cloudflare runtime using only a stub", async () => {
  const accepted = await (await mf.dispatchFetch("http://localhost/command-success")).json();
  assert.equal(accepted.result.accepted, true); assert.equal(accepted.calls, 1);
  assert.deepEqual(accepted.requestConfig, { method: "POST", redirect: "manual", origin: "https://public.api.connect.skoda-auto.cz" });
  const redirect = await (await mf.dispatchFetch("http://localhost/command-redirect")).json();
  assert.equal(redirect.error.code, "UPSTREAM_REDIRECT"); assert.equal(redirect.calls, 1);
  assert.equal(redirect.error.automaticRetryAllowed, false); assert.equal(redirect.error.commandMayHaveBeenSent, true);
});

test("new JSON PUT requests work in actual Cloudflare runtime using only a stub", async () => {
  const result = await (await mf.dispatchFetch("http://localhost/put-success")).json();
  assert.equal(result.result.accepted, true); assert.equal(result.calls, 1);
  assert.deepEqual(result.requestConfig, { method: "PUT", redirect: "manual", body: { targetStateOfChargeInPercent: 90 }, contentType: "application/json" });
});
