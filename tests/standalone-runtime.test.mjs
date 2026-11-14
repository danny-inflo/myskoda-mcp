import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";

// Run our real boundary and the OAuth library in workerd, with actual D1/KV.
// GitHub is a local outbound stub; contacting a real provider is forbidden.
const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: { resolveDir: root, contents: `import { standaloneFetch } from './lib/standalone-auth.ts';
    export default { fetch(request,env,ctx) {
      return standaloneFetch(request,env,ctx, async req => Response.json({
        userId:req.headers.get('oai-authenticated-user-id'),
        consent:req.headers.has('x-vc-oauth-consent')?JSON.parse(decodeURIComponent(req.headers.get('x-vc-oauth-consent'))):null
      }));
    }};`, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "neutral", mainFields: ["module", "main"], target: "es2022", external: ["cloudflare:workers"],
});
let githubId = 42;
const origin = "https://vehicle.example";
const mf = new Miniflare({
  modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], cf: false,
  d1Databases: ["DB"], kvNamespaces: ["OAUTH_KV"],
  bindings: { PUBLIC_BASE_URL: origin, DEPLOYMENT_TARGET: "cloudflare", GITHUB_CLIENT_ID: "synthetic-github-client", GITHUB_CLIENT_SECRET: "synthetic-github-secret", GITHUB_OWNER_ID: "42", VEHICLE_VAULT_KEY: randomBytes(32).toString("base64") },
  outboundService: async request => {
    if (request.url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "synthetic-upstream-token" });
    assert.equal(request.url, "https://api.github.com/user", "No vehicle or arbitrary outbound requests");
    return Response.json({ id: githubId, login: "synthetic-owner" });
  },
});
test.after(async () => mf.dispose());
async function call(path, init = {}, jar = new Map()) {
  const headers = new Headers(init.headers);
  if (jar.size) headers.set("Cookie", [...jar].map(([key, value]) => `${key}=${value}`).join("; "));
  const response = await mf.dispatchFetch(new URL(path, origin).href, { ...init, headers, redirect: "manual" });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0], split = pair.indexOf("=");
    jar.set(pair.slice(0, split), pair.slice(split + 1));
  }
  return response;
}
test("workerd: anonymous access, real D1 login session, MCP consent/PKCE/KV token and owner denial", async () => {
  const db = await mf.getD1Database("DB");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter(name => name.endsWith(".sql")).sort()) {
    for (const sql of readFileSync(new URL("../drizzle/" + file, import.meta.url), "utf8").split(/;\s*(?:--> statement-breakpoint\s*)?/).map(value => value.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  assert.equal((await call("/mcp", { method: "POST", headers: { "oai-authenticated-user-id": "victim" }, body: "{}" })).status, 401);
  const jar = new Map();
  const login = await call("/auth/login", {}, jar);
  assert.equal(login.status, 302, await login.clone().text());
  const upstream = new URL(login.headers.get("Location"));
  const signedIn = await call(`/auth/callback?code=synthetic-code&state=${upstream.searchParams.get("state")}`, {}, jar);
  assert.equal(signedIn.status, 302, await signedIn.clone().text());
  assert.equal((await (await call("/", {}, jar)).json()).userId, "gh-42");
  const metadata = await (await call("/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.client_id_metadata_document_supported, true, "CIMD must be available in the configured Worker runtime");
  const registered = await call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Runtime client", redirect_uris: ["http://localhost:43123/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  assert.equal(registered.status, 201, await registered.clone().text());
  const client = await registered.json(), verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: "http://localhost:43123/callback", response_type: "code", scope: "vehicle:access offline_access", state: "runtime-state", resource: origin + "/mcp", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const page = await call("/authorize?" + params, {}, jar);
  assert.equal(page.status, 200, await page.clone().text());
  const details = (await page.json()).consent;
  const approved = await call("/authorize", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle: details.handle, decision: "approve" }).toString() }, jar);
  assert.equal(approved.status, 302, await approved.clone().text());
  const callback = new URL(approved.headers.get("Location"));
  const exchanged = await call("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: "http://localhost:43123/callback", code: callback.searchParams.get("code"), code_verifier: verifier, resource: origin + "/mcp" }).toString() });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const tokens = await exchanged.json();
  const authorized = await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "oai-authenticated-user-id": "victim" }, body: "{}" });
  assert.equal(authorized.status, 200, await authorized.clone().text());
  assert.equal((await authorized.json()).userId, "gh-42");
  const forged = await call("/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}invalid` } });
  assert.equal(forged.status, 401);
  githubId = 99;
  const otherJar = new Map();
  const otherLogin = await call("/auth/login", {}, otherJar);
  const otherState = new URL(otherLogin.headers.get("Location")).searchParams.get("state");
  assert.equal((await call(`/auth/callback?code=other-code&state=${otherState}`, {}, otherJar)).status, 400);
  const persisted = await db.prepare("SELECT principal FROM web_sessions").all();
  assert(!JSON.stringify(persisted).includes("synthetic-upstream-token"));
});
