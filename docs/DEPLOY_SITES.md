# Deploy with ChatGPT Sites

Sites manages hosting and authentication. No personal Cloudflare account is required. You need the Sites plugin available and connected in the account/workspace that will own the instance. Availability, limits and costs follow your current Sites plan; do not assume unlimited free hosting.

## Create an instance

1. Clone or fork this repository into a fresh directory. Do not copy another deployment's runtime files, database, `.dev.vars`, `.sites-runtime`, Git credentials or provisioned hosting manifest.
2. Open the directory in Codex with the Sites plugin enabled.
3. Give Codex this instruction:

   > Deploy this repository as a NEW private Site in my current account using the Sites plugin. Follow its supported source and publishing workflow. Preserve the application and MCP tools. The template .openai/hosting.json must have no project_id; if it already has one, stop and use a fresh clone. Use D1 binding DB, no R2, and the mcp capability. Configure a NEW 32-byte base64 VEHICLE_VAULT_KEY secret for this instance without exposing it in chat or source. Apply the checked-in migrations, build the Sites variant and run npx astryx doctor --built dist. Never copy another instance's secrets or records. Do not enable controls or send vehicle commands. Report the deployed URL and provisioned personal MCP plugin.

4. If the platform requires owner entry, save `VEHICLE_VAULT_KEY` directly in the Site's settings with **Secret** enabled. Generate a new value locally with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"`. Do not paste it into chat. Keep a secure backup: losing/changing the key makes existing encrypted data unreadable.
5. Open the new Site, sign in, and enter your VIN and MyŠkoda API key in the setup form. Choose **Read only** initially.
6. Connect the personal plugin created for this Site. First call `get_connection_status`: it reads local metadata without contacting the vehicle.

`npm run prepare:sites` checks the unprovisioned template locally. It does not create or publish a Site. The installed Sites plugin supplies its own helpers and handles provisioning, source synchronization, storage and publication; no machine-specific helper path is required in the public repository.

## Configuration and updates

The public `.openai/hosting.json` contains only:

```json
{ "d1": "DB", "r2": null, "capabilities": ["mcp"] }
```

Sites adds a new `project_id` in your deployment checkout. Preserve it there; do not contribute it back to the public template. The setup URL follows the request origin, or optional `PUBLIC_BASE_URL`. GitHub OAuth and KV are not needed for this target.

**Never deploy a Sites build directly to an Internet-facing Worker.** This mode depends on identity headers validated and supplied by Sites. The standalone build supplies a different authentication boundary.

Manage the project at [ChatGPT Sites](https://chatgpt.com/sites). Source publication, Site sharing and plugin sharing are separate controls. Keep a new instance owner-private initially.

For updates, use the deployment checkout that already contains your Site ID and the plugin's existing-Site workflow. Review template updates before applying them, preserve the vault key and do not rerun new-instance creation against an existing Site.

Verify the real account's browser and MCP access before sharing. Local synthetic identities do not prove the hosting ingress boundary or native-client approvals. Never use a vehicle command as a deployment smoke test.

References: [Sites](https://learn.chatgpt.com/docs/sites), [manage a Site](https://learn.chatgpt.com/docs/sites/managing-a-site).
