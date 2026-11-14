import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { configureToolEnvironment } from "./tool-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
configureToolEnvironment(root);
assert.equal(JSON.parse(readFileSync(new URL("../dist/deployment-target.json", import.meta.url), "utf8")).target, "cloudflare", "Build the Cloudflare variant first.");
const options = unstable_getMiniflareWorkerOptions(fileURLToPath(new URL("../dist/server/wrangler.json", import.meta.url)));
const origin = "https://vehicle.example";
const serverRoot = fileURLToPath(new URL("../dist/server/", import.meta.url));
const modules = ["index.js", ...readdirSync(serverRoot, { recursive: true }).filter(name => name.endsWith(".js") && name !== "index.js")].map(name => ({ type: "ESModule", path: serverRoot + name }));
const mf = new Miniflare({
  ...options.workerOptions, modules, modulesRoot: serverRoot, cf: false,
  bindings: { ...options.workerOptions.bindings, PUBLIC_BASE_URL: origin, DEPLOYMENT_TARGET: "cloudflare", GITHUB_CLIENT_ID: "synthetic-client", GITHUB_CLIENT_SECRET: "synthetic-secret", GITHUB_OWNER_ID: "42", VEHICLE_VAULT_KEY: randomBytes(32).toString("base64") },
  outboundService: async request => {
    if (request.url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "synthetic-token" });
    assert.equal(request.url, "https://api.github.com/user", "This verification must not contact a real provider or vehicle.");
    return Response.json({ id: 42, login: "synthetic-owner", name: "Synthetic Owner" });
  },
});
const jar = new Map();
async function call(path, init = {}) {
  const headers = new Headers(init.headers);
  if (jar.size) headers.set("Cookie", [...jar].map(([key, value]) => `${key}=${value}`).join("; "));
  const response = await mf.dispatchFetch(new URL(path, origin).href, { ...init, headers, redirect: "manual" });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0], split = pair.indexOf("="); jar.set(pair.slice(0, split), pair.slice(split + 1));
  }
  return response;
}
try {
  const db = await mf.getD1Database("DB");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter(name => name.endsWith(".sql")).sort()) {
    for (const sql of readFileSync(new URL("../drizzle/" + file, import.meta.url), "utf8").split(/;\s*(?:--> statement-breakpoint\s*)?/).map(value => value.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const anonymous = await call("/");
  assert.equal(anonymous.status, 200);
  const html = await anonymous.text();
  assert.match(html, /GitHub/); assert.match(html, /\/auth\/login/);
  assert.equal((await call("/api/connection")).status, 401);
  assert.equal((await call("/mcp", { method: "POST", body: "{}" })).status, 401);
  const login = await call("/auth/login");
  assert.equal(login.status, 302);
  const state = new URL(login.headers.get("Location")).searchParams.get("state");
  assert.equal((await call(`/auth/callback?code=synthetic-code&state=${state}`)).status, 302);
  const signedIn = await call("/api/connection");
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json()).connected, false);
  const client = await (await call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Untrusted <script>client</script>", redirect_uris: ["http://localhost:43123/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) })).json();
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: "http://localhost:43123/callback", response_type: "code", scope: "vehicle:access", state: "synthetic-state", resource: origin + "/mcp", code_challenge: randomBytes(32).toString("base64url"), code_challenge_method: "S256" });
  const consent = await call("/authorize?" + params);
  assert.equal(consent.status, 200, await consent.clone().text());
  const consentHtml = await consent.text();
  assert.match(consentHtml, /Allow connection/);
  assert.match(consentHtml, /name="handle"/);
  assert.match(consentHtml, /name="decision"/);
  assert.match(consentHtml, /localhost/);
  assert(!consentHtml.includes("Untrusted <script>client</script>"));
  assert.equal(consent.headers.get("X-Frame-Options"), "DENY");
  console.log("Standalone production artifact verified: HTML sign-in, authenticated local connection API, MCP challenge, escaped consent form and isolated D1/KV. No real vehicle requests.");
} finally {
  await mf.dispose();
}
