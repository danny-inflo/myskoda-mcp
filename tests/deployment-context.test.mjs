import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

globalThis.__deploymentTestEnv = {};
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env=globalThis.__deploymentTestEnv", shortCircuit: true };
  return next(specifier, context);
} });
const { withRequestOrigin, setupUrl } = await import("../lib/deployment-context.ts");

test("setup URLs stay request-scoped across concurrent independent Sites", async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const a = withRequestOrigin("https://first.example", async () => { await barrier; return setupUrl(); });
  const b = withRequestOrigin("https://second.example", async () => { release(); await Promise.resolve(); return setupUrl(); });
  assert.deepEqual(await Promise.all([a,b]), ["https://first.example", "https://second.example"]);
  assert.equal(setupUrl(), "/");
  globalThis.__deploymentTestEnv.PUBLIC_BASE_URL = "https://configured.example";
  assert.equal(withRequestOrigin("https://request.example", setupUrl), "https://configured.example");
  delete globalThis.__deploymentTestEnv.PUBLIC_BASE_URL;
});
test("portable configuration declares storage without embedded runtime secrets", () => {
  const manifest = JSON.parse(readFileSync(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  // A provisioned Sites checkout may legitimately have its own project_id.
  // The public release is separately checked before commit/publication.
  assert.equal(manifest.VEHICLE_VAULT_KEY, undefined);
  assert.equal(manifest.d1, "DB");
  assert.deepEqual(manifest.capabilities, ["mcp"]);
  const config = JSON.parse(readFileSync(new URL("../wrangler.example.json", import.meta.url), "utf8"));
  assert.equal(config.vars.DEPLOYMENT_TARGET, "cloudflare");
  assert.equal(config.d1_databases[0].database_id, "00000000-0000-4000-8000-000000000000");
  assert.equal(config.kv_namespaces[0].id, "00000000000000000000000000000000");
  assert(!JSON.stringify(config).includes("VEHICLE_VAULT_KEY"));
  assert(!JSON.stringify(config).includes("GITHUB_CLIENT_SECRET"));
});
