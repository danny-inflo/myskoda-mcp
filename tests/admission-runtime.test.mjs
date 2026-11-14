import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { Miniflare } from "miniflare";

// Execute the production admission helper against actual workerd/D1. This worker
// has no vault or provider credentials and never makes an external request.
const bundled = buildSync({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), contents: `
import { admitConnection, CONNECTION_LIMITS } from './lib/connection-admission.ts';
const active = new Map();
export default { async fetch(request, env) {
  const user = new URL(request.url).searchParams.get('user');
  try {
    if (request.method === 'DELETE') { await active.get(user)?.finish(true); active.delete(user); return Response.json({ released: true }); }
    const admission = await admitConnection(env.DB, user); active.set(user, admission);
    return Response.json({ admitted: true });
  } catch (e) { return Response.json({ code: e.code }, { status: e.status ?? 500 }); }
} };` }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" }).outputFiles[0].text;
const mf = new Miniflare({ modules: true, compatibilityDate: "2026-05-15", cf: false, d1Databases: ["DB"], script: bundled });
test.after(() => mf.dispose());

test("D1 transactions atomically enforce account/global admission with runtime-compatible SQL", async () => {
  const db = await mf.getD1Database("DB");
  for (const f of readdirSync(new URL("../drizzle/", import.meta.url)).filter(x => x.endsWith(".sql")).sort()) {
    for (const query of readFileSync(new URL("../drizzle/" + f, import.meta.url), "utf8").split("--> statement-breakpoint").filter(x => x.trim())) await db.prepare(query).run();
  }
  const clock = await db.prepare("SELECT unixepoch('subsec') * 1000 AS now").first();
  assert(Math.abs(clock.now - Date.now()) < 5000);
  const statuses = await Promise.all(Array.from({ length: 32 }, (_, i) => mf.dispatchFetch("http://localhost/?user=runtime-" + i).then(r => r.status)));
  assert.equal(statuses.filter(x => x === 200).length, 8);
  assert.equal(statuses.filter(x => x === 429).length, 24);
  assert.equal((await db.prepare("SELECT count(*) n FROM connection_attempts").first()).n, 8);
  assert.equal((await db.prepare("SELECT attempts FROM connection_gate").first()).attempts, 8);
  const account = await db.prepare("SELECT user_id FROM connection_attempts LIMIT 1").first();
  assert.equal((await mf.dispatchFetch("http://localhost/?user=" + account.user_id)).status, 429);
  await mf.dispatchFetch("http://localhost/?user=" + account.user_id, { method: "DELETE" });
  assert.equal((await mf.dispatchFetch("http://localhost/?user=" + account.user_id)).status, 429);
  assert.equal((await mf.dispatchFetch("http://localhost/?user=after-release")).status, 200);
  assert.equal((await db.prepare("SELECT attempts FROM connection_gate").first()).attempts, 9);
});
