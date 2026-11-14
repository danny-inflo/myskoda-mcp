import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { configureToolEnvironment } from "./tool-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
configureToolEnvironment(root);
const [command, ...extra] = process.argv.slice(2);
const cli = name => fileURLToPath(new URL(name, import.meta.url));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env, VEHICLE_DEPLOYMENT_TARGET: "cloudflare" } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
function deploymentConfig() {
  const config = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
  let validOrigin = false;
  try { const url = new URL(config.vars?.PUBLIC_BASE_URL); validOrigin = url.protocol === "https:" && url.origin === config.vars.PUBLIC_BASE_URL; } catch {}
  if (!config.d1_databases?.some(db => db.binding === "DB" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(db.database_id ?? "") && db.database_id !== "00000000-0000-4000-8000-000000000000") ||
      !config.kv_namespaces?.some(kv => kv.binding === "OAUTH_KV" && /^[\da-f]{32}$/i.test(kv.id ?? "") && kv.id !== "00000000000000000000000000000000") ||
      config.vars?.DEPLOYMENT_TARGET !== "cloudflare" || typeof config.vars?.GITHUB_OWNER_ID !== "string" || !/^\d+$/.test(config.vars.GITHUB_OWNER_ID) ||
      !config.vars?.GITHUB_CLIENT_ID || config.vars.GITHUB_CLIENT_ID.startsWith("REPLACE_") ||
      !validOrigin || config.vars.PUBLIC_BASE_URL.includes("YOUR-SUBDOMAIN")) {
    throw new Error("Complete wrangler.json with your own D1/KV IDs, HTTPS URL, GitHub OAuth client ID and numeric owner ID before deployment.");
  }
  return config;
}
if (command === "build") {
  const theme = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["astryx", "theme", "build", "app/astryx/theme.ts", "--out", "app/astryx/vehicle-connect.css"], { cwd: root, stdio: "inherit" });
  if (theme.error) throw theme.error;
  if (theme.status !== 0) process.exit(theme.status || 1);
  run([cli("run-framework.mjs"), "build", ...extra]);
} else if (command === "dev") {
  run([cli("run-framework.mjs"), "dev", ...extra]);
} else if (command === "deploy") {
  deploymentConfig();
  const artifact = JSON.parse(readFileSync(new URL("../dist/deployment-target.json", import.meta.url), "utf8"));
  const configHash = createHash("sha256").update(readFileSync(new URL("../wrangler.json", import.meta.url))).digest("hex");
  if (artifact.target !== "cloudflare" || artifact.configHash !== configHash) throw new Error("Run npm run build:cloudflare after configuring this instance; the current artifact belongs to another target or configuration.");
  run([cli("../node_modules/wrangler/bin/wrangler.js"), "whoami"]);
  run([cli("../node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", "dist/server/wrangler.json", ...extra]);
} else if (["migrate-local", "migrate-remote"].includes(command)) {
  if (command === "migrate-remote") { deploymentConfig(); run([cli("../node_modules/wrangler/bin/wrangler.js"), "whoami"]); }
  run([cli("../node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", "wrangler.json", command === "migrate-local" ? "--local" : "--remote", ...extra]);
} else {
  throw new Error("Use build, dev, deploy, migrate-local or migrate-remote.");
}
