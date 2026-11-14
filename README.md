# MyŠkoda MCP

**Vehicle Connect for MyŠkoda** is an unofficial personal-use integration connecting your own vehicle to an MCP client. Read vehicle status, fuel or battery, range, climate, charging profiles and parking position. Optional controls cover ventilation, charging, air conditioning and auxiliary heating where supported.

Vehicle control is **off by default**. Each control group needs permission in settings, and each command needs a separate, explicit user request. API keys and heating S-PIN belong only in the signed-in setup page, never in chat.

## Choose a deployment

| | ChatGPT Sites | Your Cloudflare account |
| --- | --- | --- |
| Hosting | Managed by Sites | Workers, D1 and KV in your account |
| Sign-in | Provided by Sites | Your GitHub OAuth app; restricted to your numeric GitHub ID |
| MCP access | Personal plugin provisioned by Sites | Remote `/mcp` endpoint with OAuth 2.1 |
| Setup | Codex with the Sites plugin | Wrangler and your own accounts |
| Costs and limits | Current Sites plan and hosting terms | Cloudflare plan and resource usage |
| Instructions | [Deploy with Sites](docs/DEPLOY_SITES.md) | [Deploy to Cloudflare](docs/DEPLOY_CLOUDFLARE.md) |

Each installation has its own database and encryption key. The repository includes no running Site identity, production credentials or user data. Publishing the code does not connect anyone to the author's service.

The standalone deployment is **single-owner**. Sites retains its platform-managed per-user access and data isolation. The two deployments do not share accounts, data or authorizations.

## Requirements

- Node.js 24 or newer and npm.
- A supported vehicle and your own vehicle-scoped [MyŠkoda API key](https://go.skoda.eu/api-keys).
- Either an available, connected Sites plugin, or your own Cloudflare account and GitHub OAuth app.

The provider controls capabilities, entitlements, availability and usage limits. Source-code licensing does not grant commercial rights to the MyŠkoda API. Read its current [documentation](https://public.api.connect.skoda-auto.cz/docs) and terms for your intended use.

## Development

```sh
npm ci
npm test
npm run typecheck
```

`npm run dev` starts a localhost Sites preview with synthetic identity. This development sign-in stub is restricted to localhost and must never secure an Internet-facing Worker. Standalone login requires a configured HTTPS origin; see its guide.

Build Sites with `npm run build`, or standalone with `npm run build:cloudflare`. Both write to `dist/`: build the selected target immediately before publication. Never deploy a Sites build directly with Wrangler: it relies on Sites' trusted authentication boundary.

Before delivering a build:

```sh
npx astryx doctor --built dist
```

Astryx 0.7.5 and the generated theme are pinned. `npm run theme:check` checks the theme; `npm run db:generate` generates migrations. Commit SQL, snapshots and the journal together.

## Behavior and verification

Nine readers and eleven optional controls share conservative interpretation of missing/stale data. Compatible views normally use a 180-second cache. Parking means the last reported position, not live tracking.

Commands have parameter-bound request IDs, fresh preflight checks, permission and quota gates, bounded verification and no automatic retry. Accepted does not mean completed. Disconnect removes local vehicle data and control grants; it does not revoke the MyŠkoda API key or cancel dispatched commands.

See [all tools and vehicle behavior](docs/VEHICLE_BEHAVIOR.md), [API coverage](docs/API_COVERAGE.md), and [manual acceptance](docs/ACCEPTANCE.md).

Tests use synthetic identities/data, real SQLite migrations, provider stubs and selected workerd checks. They never send commands to a real vehicle. `npm run verify:cloudflare` additionally exercises the built standalone application locally with temporary storage and synthetic GitHub responses. Local success does not prove live account permissions, GitHub registration or approval behavior in a particular MCP client. Verify each new installation.

The connection UI has 18 languages; standalone MCP consent is currently English. Native-speaker review remains advisable for translated control wording.

## License and affiliation

Project code uses the [MIT License](LICENSE), with [third-party notices](THIRD_PARTY_NOTICES.md). Dependencies, provider documentation and contracts retain their own terms.

Independent community project; not an official Škoda Auto, Volkswagen Group, OpenAI or Cloudflare product. Product names identify compatibility and remain the property of their owners.
