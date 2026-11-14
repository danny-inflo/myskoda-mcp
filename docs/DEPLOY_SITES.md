# Deploy with ChatGPT Sites

Sites manages hosting and authentication. No personal Cloudflare account is required. You need the Sites plugin available and connected in the account/workspace that will own the instance. Availability, limits and costs follow your current Sites plan; do not assume unlimited free hosting.

## Create an instance

1. Clone or fork this repository into a fresh directory. Do not copy another deployment's runtime files, database, `.dev.vars`, `.sites-runtime`, Git credentials or provisioned hosting manifest.
2. Open the directory in Codex with the Sites plugin enabled.
3. Give Codex this instruction:

   > Deploy this repository as a NEW owner-private ChatGPT Site in my currently authenticated account using the Sites plugin. Read AGENTS.md and docs/AGENT_DEPLOYMENT.md, then follow the deploy-myskoda procedure with target sites. Complete the deployment and return its URL and provisioned personal MCP plugin. If the required Sites tools are unavailable, explain what is missing without switching hosting providers.

4. If the platform requires owner entry, save `VEHICLE_VAULT_KEY` directly in the Site's settings with **Secret** enabled. Generate a new value locally with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"`. Do not paste it into chat. Keep a secure backup: losing/changing the key makes existing encrypted data unreadable.
5. Open the new Site, sign in, and enter your VIN and MyŠkoda API key in the setup form. Choose **Read only** initially.
6. Connect the personal plugin created for this Site. First call `get_connection_status`: it reads local metadata without contacting the vehicle.

`npm run prepare:sites` checks the unprovisioned template locally. It does not create or publish a Site. The installed Sites plugin supplies its own helpers and handles provisioning, source synchronization, storage and publication; no machine-specific helper path is required in the public repository.

## One prompt from the repository URL

In Codex with the Sites plugin connected, use:

```text
Clone https://github.com/danny-inflo/myskoda-mcp into a fresh directory and deploy it as a NEW owner-private ChatGPT Site in my currently authenticated account using the Sites plugin.
Read AGENTS.md and docs/AGENT_DEPLOYMENT.md from the clone, then follow the deploy-myskoda procedure with target sites.
Complete the deployment and return its URL and provisioned personal MCP plugin. If Sites tools are unavailable, explain what is missing without switching hosting providers.
```

If the clone is already open as the Codex project and its repository skills are
loaded, the shorter invocation is `$deploy-myskoda sites`. Otherwise, read the
shared procedure directly; deployment does not depend on skill auto-discovery.

The checked-in skill gives the agent the procedure. It does not sign in, install
the Sites connector or grant account access. Account/workspace selection,
platform approvals and owner-only secret entry may still require the user.

## Claude Code

Claude Code can load the repository's `/deploy-myskoda` skill too, but the repo
does not give it the Codex Sites plugin or Sites provisioning credentials. Do
not assume that `/deploy-myskoda sites` can publish from a plain Claude Code
installation. Its capability check must report missing Sites tools.

For deployment from Claude Code, use `/deploy-myskoda cloudflare` with your own
Cloudflare account and follow the [Cloudflare guide](DEPLOY_CLOUDFLARE.md).
Deploying the application and connecting to its resulting MCP endpoint are
separate operations. A standalone HTTP/OAuth endpoint can be configured as a
Claude Code MCP server; this is not a claim of a completed live Claude Code test.

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
