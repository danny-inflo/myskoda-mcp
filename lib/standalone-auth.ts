import { OAuthProvider, AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers, ConsentDescription } from "@cloudflare/workers-oauth-provider";

type Env = Cloudflare.Env & { OAUTH_PROVIDER?: OAuthHelpers };
export type Owner = { userId: string; githubId: string; name: string };
type AppHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
const SESSION_COOKIE = "__Host-vc_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const privateHeaders = { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const encoder = new TextEncoder();

function token() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export async function hash(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function challenge(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function cookie(request: Request, name: string) {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(name + "="));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}
function setCookie(name: string, value: string, seconds: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
export function safeReturn(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://return.invalid");
    if (url.origin !== "https://return.invalid" || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/signin-") || url.pathname.startsWith("/signout-")) return "/";
    return url.pathname + url.search;
  } catch { return "/"; }
}
export function baseUrl(env: Env) {
  const url = new URL(env.PUBLIC_BASE_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("PUBLIC_BASE_URL must be an HTTPS origin.");
  return url.origin;
}
function configured(env: Env) {
  if (env.DEPLOYMENT_TARGET !== "cloudflare" || !env.DB || !env.OAUTH_KV || !env.VEHICLE_VAULT_KEY || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || typeof env.GITHUB_OWNER_ID !== "string" || !/^\d+$/.test(env.GITHUB_OWNER_ID)) throw new Error("Standalone configuration is incomplete.");
  return baseUrl(env);
}
function owner(value: unknown, env: Env): value is Owner {
  const user = value as Owner | null;
  return !!user && user.githubId === env.GITHUB_OWNER_ID && user.userId === `gh-${env.GITHUB_OWNER_ID}` && typeof user.name === "string";
}
export function authenticatedRequest(request: Request, user: Owner | null) {
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (key.startsWith("oai-authenticated-user-") || key.startsWith("x-vc-")) headers.delete(key);
  }
  if (user) {
    headers.set("oai-authenticated-user-id", user.userId);
    headers.set("oai-authenticated-user-full-name", encodeURIComponent(user.name));
    headers.set("oai-authenticated-user-full-name-encoding", "percent-encoded-utf-8");
  }
  return new Request(request, { headers });
}
function textResponse(message: string, status = 400) {
  return new Response(message, { status, headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}
function redirect(location: string, headers = new Headers()) {
  for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
}
async function prune(env: Env) {
  await env.DB!.batch([
    env.DB!.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").bind(Date.now()),
    env.DB!.prepare("DELETE FROM login_attempts WHERE expires_at <= ?").bind(Date.now()),
  ]);
}
export async function sessionUser(request: Request, env: Env): Promise<Owner | null> {
  const value = cookie(request, SESSION_COOKIE);
  if (!value || !/^[\w-]{43}$/.test(value)) return null;
  const row = await env.DB!.prepare("SELECT principal FROM web_sessions WHERE token_hash = ? AND expires_at > ?").bind(await hash(value), Date.now()).first<{ principal: string }>();
  if (!row) return null;
  try { const user: unknown = JSON.parse(row.principal); return owner(user, env) ? user : null; } catch { return null; }
}
async function createSession(user: Owner, env: Env, headers: Headers) {
  const value = token();
  await prune(env);
  await env.DB!.prepare("INSERT INTO web_sessions (token_hash, principal, expires_at) VALUES (?, ?, ?)").bind(await hash(value), JSON.stringify(user), Date.now() + SESSION_SECONDS * 1000).run();
  headers.append("Set-Cookie", setCookie(SESSION_COOKIE, value, SESSION_SECONDS));
}
function githubUrl(env: Env, state: string, verifier: string, origin: string) {
  return challenge(verifier).then(codeChallenge => {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID!, redirect_uri: `${origin}/auth/callback`, state, code_challenge: codeChallenge, code_challenge_method: "S256", scope: "" }).toString();
    return url.href;
  });
}
async function githubOwner(request: Request, verifier: string, env: Env, origin: string): Promise<Owner> {
  const code = new URL(request.url).searchParams.get("code");
  if (!code || code.length > 512) throw new AuthorizationError("access_denied", { description: "GitHub sign-in was cancelled or failed." });
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID!, client_secret: env.GITHUB_CLIENT_SECRET!, code, code_verifier: verifier, redirect_uri: `${origin}/auth/callback` }),
  });
  if (!response.ok) throw new Error("GitHub token exchange failed.");
  const result = await response.json() as { access_token?: string };
  if (!result.access_token) throw new AuthorizationError("access_denied", { description: "GitHub sign-in failed." });
  const profile = await fetch("https://api.github.com/user", { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${result.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "myskoda-mcp", "X-GitHub-Api-Version": "2022-11-28" } });
  if (!profile.ok) throw new Error("GitHub identity lookup failed.");
  const data = await profile.json() as { id?: number; login?: string; name?: string | null };
  if (!Number.isSafeInteger(data.id) || String(data.id) !== env.GITHUB_OWNER_ID || typeof data.login !== "string") throw new AuthorizationError("access_denied", { description: "This instance is restricted to its configured owner." });
  // The GitHub access token is used only for this identity lookup, never stored.
  return { userId: `gh-${data.id}`, githubId: String(data.id), name: data.name || data.login };
}
function sameOriginPost(request: Request, origin: string) {
  return request.method === "POST" && request.headers.get("origin") === origin && request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded");
}
function navigatedLocally(request: Request, origin: string) {
  return request.headers.get("sec-fetch-site") !== "cross-site" && (!request.headers.has("origin") || request.headers.get("origin") === origin);
}
async function webLogin(request: Request, env: Env, origin: string) {
  if (request.method !== "GET" || !navigatedLocally(request, origin)) return textResponse("Open sign-in from this instance.", 403);
  await prune(env);
  const state = token(), binding = token(), verifier = token();
  const stateHash = await hash(state);
  const name = `__Host-vc_login_${stateHash.slice(0, 16)}`;
  const payload = JSON.stringify({ bindingHash: await hash(binding), verifier, returnTo: safeReturn(new URL(request.url).searchParams.get("return_to")) });
  const admitted = await env.DB!.prepare("INSERT INTO login_attempts (token_hash, payload, expires_at) SELECT ?, ?, ? WHERE (SELECT count(*) FROM login_attempts) < 100").bind(stateHash, payload, Date.now() + 600_000).run();
  if (!admitted.meta.changes) return new Response("Too many pending sign-ins. Try again later.", { status: 429, headers: { ...privateHeaders, "Retry-After": "600" } });
  const headers = new Headers({ "Set-Cookie": setCookie(name, binding, 600) });
  return redirect(await githubUrl(env, `web.${state}`, verifier, origin), headers);
}
async function callback(request: Request, env: Env, origin: string) {
  if (request.method !== "GET") return textResponse("Method not allowed", 405);
  const state = new URL(request.url).searchParams.get("state") ?? "";
  if (state.startsWith("web.")) {
    const stateValue = state.slice(4);
    if (!/^[\w-]{43}$/.test(stateValue)) return textResponse("Invalid sign-in state.");
    const stateHash = await hash(stateValue), name = `__Host-vc_login_${stateHash.slice(0, 16)}`;
    const row = await env.DB!.prepare("SELECT payload FROM login_attempts WHERE token_hash = ? AND expires_at > ?").bind(stateHash, Date.now()).first<{ payload: string }>();
    const binding = cookie(request, name);
    if (!row || !binding) return textResponse("Sign-in expired or belongs to another browser.");
    const pending = JSON.parse(row.payload) as { bindingHash: string; verifier: string; returnTo: string };
    if (pending.bindingHash !== await hash(binding)) return textResponse("Sign-in belongs to another browser.");
    const consumed = await env.DB!.prepare("DELETE FROM login_attempts WHERE token_hash = ? AND payload = ? RETURNING token_hash").bind(stateHash, row.payload).first();
    if (!consumed) return textResponse("Sign-in was already used.");
    const headers = new Headers({ "Set-Cookie": setCookie(name, "", 0) });
    if (new URL(request.url).searchParams.has("error")) return redirect("/", headers);
    const user = await githubOwner(request, pending.verifier, env, origin);
    await createSession(user, env, headers);
    return redirect(safeReturn(pending.returnTo), headers);
  }
  const oauth = env.OAUTH_PROVIDER!;
  const resumed = await oauth.finishUpstream<{ verifier: string }>(request);
  if (new URL(request.url).searchParams.has("error")) return redirect(authorizationErrorRedirect(resumed.request, "access_denied"), resumed.headers);
  let user: Owner;
  try { user = await githubOwner(request, resumed.data.verifier, env, origin); }
  catch (error) {
    if (error instanceof AuthorizationError) return redirect(authorizationErrorRedirect(resumed.request, "access_denied"), resumed.headers);
    throw error;
  }
  const result = await oauth.completeAuthorization({ request: resumed.request, userId: user.userId, metadata: {}, scope: resumed.request.scope, props: user });
  await createSession(user, env, resumed.headers);
  return redirect(result.redirectTo, resumed.headers);
}
async function authorize(request: Request, env: Env, ctx: ExecutionContext, app: AppHandler, origin: string) {
  const oauth = env.OAUTH_PROVIDER!;
  if (request.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    const internal = authenticatedRequest(request, await sessionUser(request, env));
    internal.headers.set("x-vc-oauth-consent", encodeURIComponent(JSON.stringify({ details, handle: consent.handle })));
    const response = await app(internal, env, ctx);
    const headers = new Headers(response.headers);
    consent.headers.forEach((value, key) => { if (key.toLowerCase() !== "set-cookie") headers.set(key, value); });
    for (const value of consent.headers.getSetCookie()) headers.append("Set-Cookie", value);
    return new Response(response.body, { status: response.status, headers });
  }
  if (!sameOriginPost(request, origin)) return textResponse("A same-origin consent form is required.", 403);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); return textResponse("Consent form is too large.", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const form = new URLSearchParams(new TextDecoder().decode(bytes)), handle = form.get("handle") ?? "";
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return redirect(denied.headers.get("Location")!, denied.headers);
  }
  const approved = await oauth.approveConsent(request, handle);
  // Scope grants authorize this integration; vehicle controls still require
  // the separate, revision-bound group permissions and explicit user intent.
  const user = await sessionUser(request, env);
  if (user) {
    const result = await oauth.completeAuthorization({ request: approved.request, userId: user.userId, metadata: {}, scope: approved.request.scope, props: user });
    return redirect(result.redirectTo, approved.headers);
  }
  const verifier = token();
  const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  return redirect(await githubUrl(env, upstream.state, verifier, origin), upstream.headers);
}
export type Consent = { details: ConsentDescription; handle: string };

export async function standaloneFetch(request: Request, env: Env, ctx: ExecutionContext, app: AppHandler): Promise<Response> {
  try {
    const origin = configured(env);
    if (new URL(request.url).origin !== origin) return textResponse("Use this instance's configured HTTPS address.", 421);
    const clean = authenticatedRequest(request, null);
    const provider = new OAuthProvider<Env>({
      apiRoute: "/mcp", authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true, accessTokenTTL: 900, refreshTokenTTL: 2_592_000,
      scopesSupported: ["vehicle:access", "offline_access"], requiredScopes: ["vehicle:access"],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      apiHandler: { async fetch(req, bindings, context) {
        const authenticated = context as unknown as { props: unknown; auth: { scope: string[] } };
        if (!owner(authenticated.props, bindings) || !authenticated.auth.scope.includes("vehicle:access")) return textResponse("Access denied.", 403);
        if (new URL(req.url).pathname !== "/mcp") return textResponse("Not found", 404);
        return app(authenticatedRequest(req, authenticated.props), bindings, context);
      } },
      defaultHandler: { async fetch(req, bindings, context) {
        const path = new URL(req.url).pathname;
        if (path === "/auth/login") return webLogin(req, bindings, origin);
        if (path === "/auth/callback") return callback(req, bindings, origin);
        if (path === "/authorize") return authorize(req, bindings, context, app, origin);
        if (path === "/auth/logout") {
          if (!["GET", "POST"].includes(req.method) || !navigatedLocally(req, origin) || (req.method === "POST" && req.headers.get("origin") !== origin)) return textResponse("Invalid sign-out request.", 403);
          const value = cookie(req, SESSION_COOKIE);
          if (value) await bindings.DB!.prepare("DELETE FROM web_sessions WHERE token_hash = ?").bind(await hash(value)).run();
          return redirect("/", new Headers({ "Set-Cookie": setCookie(SESSION_COOKIE, "", 0) }));
        }
        // Never let a browser session substitute for an MCP bearer token.
        if (path === "/mcp" || path.startsWith("/mcp/")) return textResponse("MCP authorization required.", 401);
        return app(authenticatedRequest(req, await sessionUser(req, bindings)), bindings, context);
      } },
    });
    return await provider.fetch(clean, env, ctx);
  } catch (error) {
    if (error instanceof AuthorizationError) return textResponse(error.description, 400);
    if (error instanceof CimdFetchError) return textResponse("The MCP client's identity could not be verified.");
    // Do not serialize provider failures, authorization codes, tokens or secrets.
    return textResponse("Authentication is unavailable. Check the instance configuration and try again.", 503);
  }
}
