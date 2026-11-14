import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";

const file = new URL("../.openai/hosting.json", import.meta.url);
const config = JSON.parse(readFileSync(file, "utf8"));
if (config.project_id) throw new Error("This checkout already belongs to a Site. Use a fresh clone to create a different instance.");
// Never reset a provisioned identity, copy data, or deploy from this helper.
const temp = new URL(`../.openai/.hosting-${randomUUID()}.json`, import.meta.url);
writeFileSync(temp, JSON.stringify({ ...config, d1: "DB", r2: null, capabilities: ["mcp"] }, null, 2) + "\n");
renameSync(temp, file);
console.log("Sites template is ready. Ask Codex with the Sites plugin to create a NEW private Site from this checkout, configure a NEW VEHICLE_VAULT_KEY secret, then build and publish it.");
