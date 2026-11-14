# Deploy to your own Cloudflare account

This variant runs a Worker, D1 database and OAuth KV namespace in your account. GitHub identifies the configured owner; OAuth 2.1 authorizes remote MCP clients. No GitHub repository permissions are requested, and GitHub access tokens are not stored.

Start with a fresh clone and new resources. This procedure does not migrate Sites identities, encrypted data or the existing personal plugin.

## 1. Install and provision

```sh
npm ci
npx wrangler login
npx wrangler whoami
cp wrangler.example.json wrangler.json
npx wrangler d1 create myskoda-mcp
npx wrangler kv namespace create OAUTH_KV
```

Check the selected Cloudflare account. Copy the returned D1 and KV IDs into the `DB` and `OAUTH_KV` entries in `wrangler.json`; preserve `migrations_dir: "drizzle"`. This instance-specific file is ignored by Git.

Choose the final HTTPS address, normally `https://myskoda-mcp.<your-workers-subdomain>.workers.dev`. Find the actual subdomain in your Workers & Pages settings. Custom domains are optional and configured in your account.

## 2. Configure sign-in

Create your own [GitHub OAuth app](https://github.com/settings/developers):

| Field | Value |
| --- | --- |
| Application name | `MyŠkoda MCP` or your instance name |
| Homepage URL | Your exact HTTPS origin |
| Authorization callback URL | That origin followed by `/auth/callback` |

Fill these `wrangler.json` variables:

| Variable | Value and code use |
| --- | --- |
| `DEPLOYMENT_TARGET` | Exactly `cloudflare`; selects the standalone web sign-in paths |
| `PUBLIC_BASE_URL` | Exact HTTPS origin without a path/trailing slash; used for origin enforcement, callback, MCP resource and setup URL |
| `GITHUB_CLIENT_ID` | Your OAuth app's client ID; used for GitHub authorization and code exchange |
| `GITHUB_OWNER_ID` | Numeric GitHub user ID as a JSON string, e.g. `"1234567"`, **not username**; checked at sign-in and on every session/MCP request |

Find your public numeric ID in the `id` field of `https://api.github.com/users/YOUR_USERNAME`. Other GitHub accounts are denied access even if they authorize the OAuth app.

Store secrets directly through Wrangler:

```sh
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.json
npx wrangler secret put VEHICLE_VAULT_KEY --config wrangler.json
```

`GITHUB_CLIENT_SECRET` is the OAuth app secret. `VEHICLE_VAULT_KEY` must be **32 random bytes encoded as base64**, generated separately for this installation, for example with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"`. Enter values only in secret prompts. Keep the vault key in a secure backup. Do not put secrets in chat, source or `wrangler.json`. These secrets are separate from the MyŠkoda API key entered later.

If Wrangler proposes creating the Worker before uploading secrets, verify its name/account first. Avoid request-body and authentication-header logging.

## 3. Migrate, build and deploy

```sh
npm run db:migrate:remote
npm test
npm run typecheck
npm run build:cloudflare
npx astryx doctor --built dist
npm run verify:cloudflare
npm run deploy:cloudflare
```

Remote migrations mutate the selected database: use only your new or deliberately updated instance. `npm run db:migrate:local` applies the same migrations to local D1. Vehicle data is never copied from another deployment.

The deploy helper checks configuration, requires a standalone build and runs `wrangler whoami`. Review the account. Rebuild after changing configuration. Deployment uses the generated `dist/server/wrangler.json`, including the bundled Worker and assets.

## 4. Connect and check

1. Open `PUBLIC_BASE_URL`, sign in through GitHub as the configured owner, and enter VIN/API key in the signed-in setup page. Leave controls off.
2. Add `PUBLIC_BASE_URL/mcp` to a remote HTTP MCP client with OAuth support, following that client's current instructions.
3. Check the consent screen's client identity, redirect hostname and scopes. Approval grants integration access; it does not enable vehicle controls.
4. Call `get_connection_status` first. Check the instance URL and disabled controls. Do not send a vehicle command as a smoke test.

The pinned Cloudflare OAuth library handles MCP discovery, PKCE, token issuance, revocation and refresh. Access tokens last 15 minutes, refresh grants 30 days. Browser sessions last seven days. Browser sign-out deletes the current session; it does **not** revoke MCP grants. Disconnect the MCP client through its OAuth revocation flow when access should end. Vehicle disconnect separately removes the stored vehicle connection and control grants.

## Verification and operation

The Sites localhost preview has a development identity stub. Standalone login requires HTTPS, `Secure`/`HttpOnly` host-only cookies and the configured callback. Do not weaken these requirements for plain HTTP development. Use a separate HTTPS test deployment with separate storage, OAuth app and vault key for interactive testing.

Automated auth tests use synthetic GitHub responses and isolated storage. `npm run verify:cloudflare` also boots the actual built Worker locally and checks the HTML sign-in, signed-in connection API, MCP challenge and escaped consent form with temporary D1/KV. It needs permission to bind a localhost port and does not contact a real vehicle. Local success does not prove live OAuth registration, Cloudflare permissions or a particular MCP client's approval flow. Verify those on each new instance. No live vehicle command is required.

Missing configuration fails closed. Source updates are not database backups. Manage exports/backups and retention for your installation; losing the vault key makes existing ciphertext unrecoverable from this repository.

References: [Cloudflare MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/), [OAuth library](https://github.com/cloudflare/workers-oauth-provider), [GitHub OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
