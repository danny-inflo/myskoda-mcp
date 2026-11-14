# Agent deployment procedure

This procedure is shared by the repository's Codex and Claude Code skills.
It automates the deployment workflow only when the user requests deployment;
answer explanatory questions without provisioning resources.

## Choose the target and check capabilities

- `sites`: follow [DEPLOY_SITES.md](DEPLOY_SITES.md) and the installed Sites
  plugin's current skill/workflow. Require authenticated tools to create/inspect
  Sites, configure runtime secrets, synchronize source, publish and check the
  deployment. Local scripts alone cannot supply these capabilities.
- `cloudflare`: follow [DEPLOY_CLOUDFLARE.md](DEPLOY_CLOUDFLARE.md). Require the
  owner's Cloudflare account access through Wrangler and their GitHub OAuth app.
- Preserve the user's choice. If a required connector or account is unavailable,
  name what is missing. Do not silently switch provider or substitute an
  unsupported API. Ask only for information/access actually needed at that step.

Claude Code can read the same workflow and use Wrangler for Cloudflare. This
repository does not expose Sites' deployment tools to Claude Code. A Codex Sites
plugin is not installed into Claude Code by copying a skill. Assess actual
capabilities instead of treating the two clients as interchangeable.

## Sites: new owner-private instance

1. Read the native Sites workflow before provisioning. Use a fresh clone for a
   genuinely new installation. Keep the public repository as the template, not
   the destination for instance-specific source or settings.
2. Inspect `.openai/hosting.json`. An unprovisioned template has no `project_id`,
   uses D1 binding `DB`, no R2, and capability `mcp`. Run `npm run prepare:sites`
   only against an unprovisioned template. If there is already an ID or an earlier
   creation attempt in this task, reconcile it first. Resume the same Site when
   appropriate; never erase the ID or retry creation by making another project.
3. For native template setup, export authored source to a sanitized directory
   without `.git`, `node_modules`, build output, `.agents`, `.claude`, runtime
   state, local environment files or provisioned identity. Use the plugin's
   retained-template/source workflow; preserve the app instead of replacing it
   with a new starter. Helper paths come from the installed plugin, not this repo.
4. Create the new **owner-private** Site in the currently authenticated account
   and selected workspace. Persist its returned project ID immediately and use
   that exact identity throughout source sync, secret setup and publication.
   Never use another installation's ID, credentials, database or stored records.
5. Configure a new `VEHICLE_VAULT_KEY`: 32 cryptographically random bytes encoded
   as base64. Use a supported secure secret mechanism without printing it in
   chat, committing it or placing it in an archive. If owner entry is required,
   direct the user to Site settings and verify the key's presence through
   redacted metadata. Preserve the vault key on retries and later updates.
6. Install dependencies using the supported Sites workflow. Run `npm test`,
   `npm run typecheck`, build the **Sites** target, and run
   `npx astryx doctor --built dist`. Confirm `dist/deployment-target.json` says
   `sites`. Package/synchronize the exact checked source through the native
   workflow, retaining the supplied project/commit/archive identities.
7. Publish owner-private through the supported native operation. Let Sites apply
   the checked-in D1 migrations; do not bypass the platform to find Cloudflare
   credentials or run unrelated remote migrations. Reconcile a returned saved
   version or deployment before retrying. Stop polling at a terminal result.
8. Get the provisioned personal MCP connection/plugin and offer its supported
   installation flow. A plugin ID is not evidence that it is installed. When
   tools are available, use only `get_connection_status` for a local metadata
   smoke check. Missing vehicle setup is expected for a new instance.

## Cloudflare: independent single-owner instance

Follow the Cloudflare guide rather than translating the Sites build into a raw
Worker deployment. Check `wrangler whoami`, provision independent D1/KV, configure
the exact HTTPS origin and numeric GitHub owner ID, and store secrets through
supported secret prompts. A human may need to sign in or register their OAuth
app. Keep secrets out of chat/source and avoid unrelated account changes.

Apply the documented migrations, run tests/types, build with
`npm run build:cloudflare`, run Astryx doctor and `npm run verify:cloudflare`, then
deploy the generated artifact. Its target/configuration stamp must match this
instance. Do not substitute this route when the user explicitly selected Sites.

## Completion and boundaries

- Report the actual deployed URL, target, access scope and connection step.
  Distinguish deployment success from live browser/client verification.
- Explain that the owner enters VIN and their MyŠkoda API key only in the
  signed-in application. Do not collect those credentials in chat.
- Keep vehicle controls off. Do not call control tools, location or charging
  profiles merely to verify installation. Do not publish publicly or submit an
  app-directory listing as part of owner-private setup.
- A live deployment needs a successful native result; a local build or template
  preflight alone is not a completed deployment. Do not claim a new client or
  account flow was tested when it was not.
