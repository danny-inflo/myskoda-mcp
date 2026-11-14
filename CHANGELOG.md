# Changelog

## Unreleased

- Prepare a portable public template with separate Sites and standalone Cloudflare builds, configuration examples and deployment guides; remove the original Site identity and embedded chatbot.
- Add owner-restricted GitHub web sign-in and OAuth 2.1 for standalone MCP clients, browser-bound consent, hashed sessions and default-off vehicle controls.
- Add authentication migrations and regression tests; validate both deployment targets in CI.

- Add 18 complete application languages, server-side preference detection, an accessible language switcher, localized validation, notices, dates and Astryx system labels. Language changes preserve draft inputs and do not send vehicle requests.
- Add the standalone Vehicle Connect mark above the shared connection card.

- Clarify separately which existing permissions and S-PIN are reset when replacing a vehicle or renewing its API key; use concise action labels throughout the connection UI.
- Standardize Czech service copy on formal address and vehicle terminology; simplify connection management and use native confirmation dialogs.
- Collect heating S-PIN in control consent when needed; atomically save encrypted PIN and permissions without contacting the vehicle.
- Remove the Stepper throughout the connection flow.
- Use native Astryx skeletons for initial metadata loads and pending verification/settings, hiding actions during each request.
- Consolidate availability guidance into the permissions subtitle and remove duplicate explanatory paragraphs while retaining explicit control grants and client approval behavior.

## 0.6.1

- Hide the Stepper on the initial vehicle form; retain it for Permissions and Done.
- Simplify the introductory copy and replace the key-management link with a right-aligned Astryx help button in both connection and key-renewal forms. Remove key reveal; the input always remains masked.
- Include Czech official key-management guidance, the original locally served QR code, app links and a direct documentation link. Opening help does not contact a vehicle or submit the credential form.

## 0.6.0

- Separate sign-in, three-step first setup and returning-user connection management while retaining Astryx and the existing theme.
- Persist completion independently of control grants; resume incomplete setup at Permissions. Backfill existing connections without altering their secrets or grants.
- Add a same-origin, authenticated key-renewal route using the owned encrypted VIN, bounded verification attempts and a final revision guard. Failed verification preserves existing state; successful renewal resets grants/PIN/cache.
- Standalone permission/key/car editors, expired-key management, neutral loading/error screens and explicit disconnect confirmation. No new MCP tools or vehicle commands.

## 0.5.0

- Replace the connection page with Meta Astryx 0.7.5 components, based on its
  login-card template, and a four-step account/vehicle/permissions/completion flow.
- Add an independent muted sage/olive theme, Czech component translations and
  system light/dark appearance. Remove the previous car-brand logo references.
- Offer read-only, all four control groups, or a custom selection after verification.
  Save the profile atomically through a same-origin authenticated settings route;
  require explicit acknowledgement for grants and preserve client confirmations.
- Keep existing account connections, permissions, encrypted S-PIN and the twenty
  MCP tools. Initial page loading only reads local connection metadata.
- Test profile isolation, revocation, expired-key behavior and input validation,
  plus native Astryx rendering and localhost-only browser flows. No live commands.

## 0.4.1

- Verify connection candidates outside shared vehicle leases and quota state;
  publish metadata only after provider authorization for the exact VIN.
- Add durable, atomic account/global attempt and concurrency budgets, failure
  cooldown, token-fenced commits and opportunistic state retention cleanup.
  Disconnect and VIN/key rotation cannot bypass the account budget.
- Preserve established read/cache/command paths and native-client approvals;
  migration 0004 retains saved credentials and permissions without new grants.
- Add SQL/route tenant-isolation, failure/rotation/concurrency/expiry/recovery
  regressions and actual-workerd/D1 admission tests using local fixtures only.

## 0.4.0

- Complete the eleven public remote operations with charging start/stop,
  charging limit/mode, complete-profile updates, air-conditioning start/stop
  and auxiliary-heating start/stop. Keep the existing nine readers and two
  ventilation tool interfaces.
- Add independent, default-off control groups and signed-in encrypted S-PIN
  settings. Preserve existing connections and V3 ventilation permissions;
  migration 0003 grants no new permission.
- Bind request-ID replay to the exact parameters. Reuse the common fresh
  capability/quota preflight, no-retry dispatch and timestamp-aware verification
  for all POST/PUT operations.
- Add profile revision fingerprints and fresh conflict checks; preserve
  unrelated/future profile data while applying explicit changes.
- Add the official 1.1.0 contract snapshot, endpoint coverage tests, simulated
  full-service flows, migration/permission/profile/S-PIN cases, UI rendering and
  actual-workerd JSON PUT tests. No real vehicle control command is used.

## 0.3.0

- Add start/stop active ventilation tools behind separate signed-in, per-connection
  permission and an action-specific explicit request. Existing nine readers stay
  read-only. Permission is off by default and reset on reconnection.
- Add fresh capability/quota preflight, replay prevention, bounded verification,
  explicit accepted/unconfirmed/uncertain outcomes and no automatic POST retries.
- Add encrypted command audit and permission tables in migration 0002; existing
  connections and credentials are retained without granting control.
- Add permission UI, revocation, same-origin route enforcement and simulated
  control/runtime/UI tests. No real vehicle command is used for release testing.

## 0.2.1

- Add user-facing service availability summaries and severity while preserving
  legacy error diagnostics. Unsupported services are informational; disabled,
  temporarily unavailable and unknown states remain distinct.
- Add exact cache-expiry boundary coverage, concurrent refresh verification,
  source measurement timestamp preservation and failed-refresh/backoff coverage
  using a controlled clock and real service SQL.
- Keep all nine tools read-only. No schema, credentials or access changes.

## 0.2.0

- Add read-only capability, climate, energy and charging-profile tools. Keep all
  five existing tool names and their argument-free interfaces.
- Retain all 11 published data sections through explicit privacy-separated
  reads; preserve operation support without exposing vehicle controls.
- Add conservative energy/lock interpretation, per-part freshness, relevant
  errors, full sanitized diagnostics and explicit unknown states.
- Coalesce compatible concurrent reads using the encrypted cache and a shared
  VIN lease. Recheck connection revision before returning cached results.
- Distinguish API quota exhaustion, vehicle refusal and temporary unavailability;
  preserve problem details with credential/VIN redaction and explicit time units.
- Display local-only connection status and last observed quota in setup.
- Add nullable quota reason and observation fields through migration 0001.

## 0.1.0

- Initial personal-use, read-only integration with encrypted per-user vehicle
  credentials and cache, five MCP tools and a signed-in setup page.
