import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";

// Exercise the real, pinned OAuth provider with real migration SQL. Only the
// WorkerEntrypoint base class and external GitHub responses are substitutes.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
  return next(specifier, context);
} });
const { standaloneFetch, safeReturn, authenticatedRequest, hash } = await import("../lib/standalone-auth.ts");
const sql = new DatabaseSync(":memory:");
for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter(name => name.endsWith(".sql")).sort()) sql.exec(readFileSync(new URL("../drizzle/" + file, import.meta.url), "utf8"));
function statement(query, args = []) {
  return {
    bind(...values) { return statement(query, values); },
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async run() { return { meta: { changes: Number(sql.prepare(query).run(...args).changes) } }; },
  };
}
const entries = new Map();
const kv = {
  async get(key, options) {
    const row = entries.get(key);
    if (!row || row.expires <= Date.now()) return null;
    return (typeof options === "string" ? options : options?.type) === "json" ? JSON.parse(row.value) : row.value;
  },
  async put(key, value, options = {}) { entries.set(key, { value, expires: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : Infinity }); },
  async delete(key) { entries.delete(key); },
  async list(options = {}) { return { keys: [...entries.keys()].filter(key => key.startsWith(options.prefix ?? "")).map(name => ({ name })), list_complete: true, cursor: "" }; },
};
const origin = "https://vehicle.example";
let env, githubId, upstreamCalls;
const ctx = { waitUntil() {}, passThroughOnException() {} };
const app = async request => Response.json({
  path: new URL(request.url).pathname,
  userId: request.headers.get("oai-authenticated-user-id"),
  consent: request.headers.has("x-vc-oauth-consent") ? JSON.parse(decodeURIComponent(request.headers.get("x-vc-oauth-consent"))) : null,
});
async function call(path, init = {}, jar) {
  const headers = new Headers(init.headers);
  if (jar?.size) headers.set("Cookie", [...jar].map(([key, value]) => `${key}=${value}`).join("; "));
  const response = await standaloneFetch(new Request(new URL(path, origin), { ...init, headers }), env, ctx, app);
  if (jar) for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";"); const split = pair.indexOf("=");
    if (pair.slice(split + 1)) jar.set(pair.slice(0, split), pair.slice(split + 1)); else jar.delete(pair.slice(0, split));
  }
  return response;
}
async function webSignIn(jar, returnTo = "/") {
  const login = await call(`/auth/login?return_to=${encodeURIComponent(returnTo)}`, {}, jar);
  assert.equal(login.status, 302);
  const target = new URL(login.headers.get("Location"));
  assert.equal(target.origin, "https://github.com");
  assert.equal(target.searchParams.get("scope"), "");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  return call(`/auth/callback?code=synthetic-code&state=${target.searchParams.get("state")}`, {}, jar);
}
async function registeredClient() {
  const response = await call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Synthetic MCP <client>", redirect_uris: ["http://localhost:43123/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
async function consent(client, jar) {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: "http://localhost:43123/callback", response_type: "code", scope: "vehicle:access offline_access", state: "client-state", resource: `${origin}/mcp`, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const response = await call("/authorize?" + params, {}, jar);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  const info = (await response.json()).consent;
  assert.equal(info.details.redirectHost, "localhost");
  assert.equal(info.details.redirectIsLoopback, true);
  assert.equal(info.details.clientName, "Synthetic MCP <client>");
  return { ...info, verifier };
}
function form(handle, decision = "approve") {
  return { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, decision }).toString() };
}
async function exchange(client, code, verifier, resource = `${origin}/mcp`) {
  return call("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: "http://localhost:43123/callback", code, code_verifier: verifier, resource }).toString() });
}
async function grant(client, jar) {
  const details = await consent(client, jar);
  let response = await call("/authorize", form(details.handle), jar);
  assert.equal(response.status, 302, await response.clone().text());
  let target = new URL(response.headers.get("Location"));
  if (target.hostname === "github.com") {
    response = await call(`/auth/callback?code=synthetic-code&state=${target.searchParams.get("state")}`, {}, jar);
    assert.equal(response.status, 302, await response.clone().text());
    target = new URL(response.headers.get("Location"));
  }
  assert.equal(target.origin, "http://localhost:43123");
  assert.equal(target.searchParams.get("state"), "client-state");
  assert.equal(target.searchParams.get("iss"), origin);
  return { code: target.searchParams.get("code"), verifier: details.verifier };
}
test.beforeEach(t => {
  sql.exec("DELETE FROM web_sessions; DELETE FROM login_attempts;"); entries.clear(); githubId = 42; upstreamCalls = [];
  env = { DB: { prepare: statement, async batch(statements) { return Promise.all(statements.map(s => s.run())); } }, OAUTH_KV: kv, VEHICLE_VAULT_KEY: randomBytes(32).toString("base64"), PUBLIC_BASE_URL: origin, DEPLOYMENT_TARGET: "cloudflare", GITHUB_CLIENT_ID: "synthetic-client-id", GITHUB_CLIENT_SECRET: "synthetic-client-secret", GITHUB_OWNER_ID: "42" };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const actual = new URL(url); upstreamCalls.push(actual.href);
    assert.equal(init.redirect, "manual");
    if (actual.href === "https://github.com/login/oauth/access_token") {
      assert.equal(new URLSearchParams(init.body).get("redirect_uri"), `${origin}/auth/callback`);
      return Response.json({ access_token: "synthetic-github-token" });
    }
    assert.equal(actual.href, "https://api.github.com/user", "No vehicle API call or arbitrary outbound URL is permitted");
    return Response.json({ id: githubId, login: "synthetic-owner", name: "Synthetic Owner" });
  });
});

test("anonymous and forged identity headers cannot reach either owner's data", async () => {
  const forged = { "oai-authenticated-user-id": "gh-42", "oai-authenticated-user-email": "fake@example.invalid", "x-vc-oauth-consent": "forged", Cookie: "__sites_local_auth=1" };
  assert.equal((await (await call("/", { headers: forged })).json()).userId, null);
  const response = await call("/mcp", { method: "POST", headers: forged, body: "{}" });
  assert.equal(response.status, 401); assert.match(response.headers.get("WWW-Authenticate"), /oauth-protected-resource/);
  assert.equal(upstreamCalls.length, 0);
});
test("browser sign-in is bound to this browser, single-use, owner-only and revocable", async () => {
  const jar = new Map();
  assert.equal((await webSignIn(jar, "/?settings=1")).headers.get("Location"), "/?settings=1");
  assert.equal((await (await call("/", {}, jar)).json()).userId, "gh-42");
  const rows = sql.prepare("SELECT * FROM web_sessions").all();
  assert.equal(rows.length, 1); assert(!JSON.stringify(rows).includes(jar.get("__Host-vc_session")));
  assert(!JSON.stringify(rows).includes("synthetic-github-token"));
  assert.equal((await call("/mcp", { method: "POST", body: "{}" }, jar)).status, 401);
  env.GITHUB_OWNER_ID = "99";
  assert.equal((await (await call("/", {}, jar)).json()).userId, null);
  env.GITHUB_OWNER_ID = "42";
  await call("/auth/logout", {}, jar);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM web_sessions").get().n, 0);
  githubId = 99;
  assert.equal((await webSignIn(new Map())).status, 400);
});
test("login callbacks reject missing binding, replay, expiration and external return paths", async () => {
  for (const value of ["https://attacker.invalid", "//attacker.invalid", "/\\attacker.invalid", "/auth/login"]) assert.equal(safeReturn(value), "/");
  const jar = new Map();
  const start = await call("/auth/login?return_to=//attacker.invalid", {}, jar);
  const state = new URL(start.headers.get("Location")).searchParams.get("state");
  const callbackPath = `/auth/callback?code=synthetic-code&state=${state}`;
  assert.equal((await call(callbackPath)).status, 400); assert.equal(upstreamCalls.length, 0);
  assert.equal((await call(callbackPath, {}, jar)).headers.get("Location"), "/");
  assert.equal((await call(callbackPath, {}, jar)).status, 400);
  const stale = await call("/auth/login", {}, jar);
  sql.exec("UPDATE login_attempts SET expires_at=0");
  assert.equal((await call(`/auth/callback?code=synthetic-code&state=${new URL(stale.headers.get("Location")).searchParams.get("state")}`, {}, jar)).status, 400);
  assert.equal((await call("/auth/login", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
});
test("MCP consent is browser-bound, cannot be forged cross-origin, and denial issues no token", async () => {
  const client = await registeredClient(), jar = new Map();
  const details = await consent(client, jar);
  assert.equal((await call("/authorize", form(details.handle))).status, 400);
  assert.equal((await call("/authorize", { ...form(details.handle), headers: { Origin: "https://attacker.invalid", "Content-Type": "application/x-www-form-urlencoded" } }, jar)).status, 403);
  const denied = await call("/authorize", form(details.handle, "deny"), jar);
  assert.equal(new URL(denied.headers.get("Location")).searchParams.get("error"), "access_denied");
  assert.equal(upstreamCalls.length, 0);
  assert.equal((await call("/authorize", form(details.handle), jar)).status, 400);
});
test("real OAuth issuance, PKCE, audience binding, refresh, current-owner checks and revocation", async () => {
  const client = await registeredClient(), jar = new Map();
  const intent = await grant(client, jar);
  const response = await exchange(client, intent.code, intent.verifier);
  assert.equal(response.status, 200, await response.clone().text());
  const tokens = await response.json(); assert(tokens.access_token); assert(tokens.refresh_token);
  assert.equal(tokens.expires_in, 900);
  const authorized = await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "oai-authenticated-user-id": "victim" }, body: "{}" });
  assert.equal(authorized.status, 200, await authorized.clone().text());
  assert.equal((await authorized.json()).userId, "gh-42");
  env.GITHUB_OWNER_ID = "99";
  assert.equal((await call("/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 403);
  env.GITHUB_OWNER_ID = "42";
  const fresh = await call("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource: `${origin}/mcp` }).toString() });
  assert.equal(fresh.status, 200, await fresh.clone().text());
  const renewed = await fresh.json();
  const metadata = await (await call("/.well-known/oauth-authorization-server")).json();
  const revoked = await call(metadata.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: client.client_id, token: renewed.access_token }).toString() });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.equal((await call("/mcp", { headers: { Authorization: `Bearer ${renewed.access_token}` } })).status, 401);
  assert.equal((await exchange(client, intent.code, intent.verifier)).status, 400);
  const other = await grant(client, jar);
  assert.equal((await exchange(client, other.code, other.verifier, "https://other.invalid/mcp")).status, 400);
  const wrongPkce = await grant(client, jar);
  assert.equal((await exchange(client, wrongPkce.code, "wrong-verifier-with-sufficient-entropy-1234567890")).status, 400);
  assert(upstreamCalls.every(url => !url.includes("skoda")));
});
test("missing configuration, alternate origin and malformed principal fail closed", async () => {
  assert.equal((await call("https://other.invalid/")).status, 421);
  delete env.GITHUB_CLIENT_SECRET;
  assert.equal((await call("/")).status, 503);
  const clean = authenticatedRequest(new Request(origin, { headers: { "oai-authenticated-user-id": "victim", "x-vc-auth-provider": "forged" } }), null);
  assert.equal(clean.headers.get("oai-authenticated-user-id"), null);
  assert.equal(clean.headers.get("x-vc-auth-provider"), null);
  assert.equal((await hash("synthetic")).length, 64);
});
test("pending sign-in storage is bounded, expires, and consent bodies are size-limited", async () => {
  const insert = sql.prepare("INSERT INTO login_attempts VALUES (?, ?, ?)");
  for (let i = 0; i < 100; i++) insert.run(`synthetic-${i}`, "{}", Date.now() + 600_000);
  assert.equal((await call("/auth/login")).status, 429);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM login_attempts").get().n, 100);
  sql.exec("UPDATE login_attempts SET expires_at=0");
  assert.equal((await call("/auth/login")).status, 302);
  const tooLarge = await call("/authorize", { ...form("unused"), body: "handle=" + "x".repeat(5000) });
  assert.equal(tooLarge.status, 413);
  const jar = new Map();
  await webSignIn(jar);
  sql.exec("UPDATE web_sessions SET expires_at=0");
  assert.equal((await (await call("/", {}, jar)).json()).userId, null);
  assert.equal(upstreamCalls.length, 2);
});
