# Vehicle behavior and MCP tools

Unofficial personal-use MCP integration. For deployment instructions, see [Sites](DEPLOY_SITES.md) or [Cloudflare](DEPLOY_CLOUDFLARE.md).
Read-only by default; each vehicle-control group is separately opt-in.
Official API: https://public.api.connect.skoda-auto.cz/docs
Contract reviewed: OpenAPI 1.1.0, 2026-10-31. The checked-in public contract snapshot is `docs/myskoda-public-api-1.1.0.yaml`.

## Connect

1. Follow the [Sites](DEPLOY_SITES.md) or [Cloudflare](DEPLOY_CLOUDFLARE.md) deployment guide to connect an MCP client.
2. Open your instance and sign in with its configured account.
3. Generate a vehicle-scoped key in MyŠkoda: https://go.skoda.eu/api-keys
4. Enter VIN and key in the setup form. Never paste keys into chat.
5. Ask about vehicle status, fuel/battery, charging, climate, supported functions,
   odometer, saved charging profiles or parking.

One connected vehicle per user. Replacing it verifies the new key first.
Disconnect deletes the connection, cached vehicle data, control permissions, heating S-PIN and
command audit records for that user.
Connection-attempt counters are retained separately for abuse prevention and
cannot be reset by disconnecting.
Disconnect also cancels any pending connection verification for that account.

The signed-out page uses Meta Astryx's login-card layout without a credential
form. Signed-in users without a car complete vehicle verification, permission
selection and a one-time success screen. The flow uses headings and explicit
actions, without a Stepper. Initial reads, connection verification and settings
mutations show native Astryx skeletons instead of loading text or spinners. A dismissible Astryx help dialog explains key
management with official app links and a locally served copy of the official QR.
Opening help does not submit credentials or contact the vehicle.
After key verification choose **Read only**
(the default), **All** (the four supported control groups), or **Custom**.
Custom settings select ventilation, charging/profiles, air conditioning and
auxiliary heating independently. An atomic, revision-guarded SQL batch applies the full
profile and marks setup complete, including for read-only users. Grants require explicit acknowledgement; a client cannot grant another
account's connection. Read-only revokes all four groups, including with an expired
key. Stored S-PIN remains separately manageable. Saving settings never sends a
vehicle command and does not change provider entitlements or client approvals.

The independent Vehicle Connect theme uses muted sage/olive accents and system
fonts, with light/dark modes. No vehicle-brand logo or login password form is used.
In the Sites variant, Sites/OpenAI owns sign-in; the Site-owned account panel cannot replace the
platform's private-site gate or native approval dialogs. Returning connected users
go directly to connection management, without a Stepper, welcome flow or editable
credentials. Separate editors handle permissions, replacing a car and renewing a
key. Renewal retrieves only the current account's encrypted VIN server-side and
checks the connection revision again in the final commit. It uses the same
verification admission limits as a new connection. A failed renewal preserves
the old connection; success clears control grants, PIN and cache, and preserves
the setup completion state. Expired keys remain manageable.

Migration 0005 backfills completion for existing connections, preserving their
ciphertext and permissions. New connections remain incomplete until the profile
is saved; interrupted setup resumes at Permissions on any browser. Completed
users return to management even when all controls are off. Initial loading and
errors never fall through to the onboarding form. Opening the page, refreshing
local status, and editing settings never automatically contact the vehicle.

## Read-only tools

| Tool | Data |
| --- | --- |
| `get_connection_status` | Local connection, key expiry and last reported quota; no provider request |
| `get_vehicle_overview` | Basic info, status, energy, odometer, climate, supported-operation names |
| `get_vehicle_status` | Doors, locks, side windows, sunroof, bonnet, trunk and lights |
| `get_charging_status` | Charging process, battery, plug connection/lock and all returned settings |
| `get_vehicle_capabilities` | Supported-operation names and service diagnostics; not executable actions |
| `get_climate_status` | Air conditioning, auxiliary heating, active ventilation and window heating |
| `get_energy_status` | Fuel, primary/secondary engines, traction battery, range, AdBlue and odometer |
| `get_charging_profiles` | Existing profiles, settings, preferred times, timers and current-location profile; only on a relevant user request |
| `get_parking_position` | Last reported parking coordinates and map link; only on an explicit location request |

These nine tools take no arguments and never send vehicle commands.
Supported-operation names describe the car and do not guarantee current
permission. All eleven published remote operations have separate control tools. `get_charging_profiles` also returns stable per-profile fingerprints for explicitly requested updates.

## Vehicle control

The server exposes **20 tools: nine existing readers and eleven controls**.
All tools remain authenticated to the current user and the single connected car.

| Tool | Operation / parameters |
| --- | --- |
| `start_active_ventilation` | Start active ventilation; no additional parameters |
| `stop_active_ventilation` | Stop active ventilation; no additional parameters |
| `start_charging` | Start charging |
| `stop_charging` | Stop charging |
| `set_charging_limit` | `targetStateOfChargeInPercent` (integer 1–100); the car may only accept narrower values/steps |
| `set_charge_mode` | `chargeMode`: one of the seven published modes; checked against available modes when reported |
| `update_charging_profile` | `profileId`, `expectedProfileFingerprint`, `changes` |
| `start_air_conditioning` | Optional `targetTemperature: {value, unit}` and `airConditioningWithoutExternalPower`; sends the required JSON object even when empty |
| `stop_air_conditioning` | Stop air conditioning |
| `start_auxiliary_heating` | Optional target temperature, positive int32 `durationInSeconds`, `startMode` HEATING/VENTILATION; S-PIN comes only from signed-in settings |
| `stop_auxiliary_heating` | Stop auxiliary heating; does not require a saved S-PIN |

Every control also requires a UUID `requestId` and its exact action-specific
`confirmation` enum. The tool schemas publish those values. They never accept a
VIN, key, S-PIN, user ID, arbitrary URL or arbitrary HTTP method.

### Permissions and heating S-PIN

Control is off by default. The signed-in setup page offers independent explicit
permissions for ventilation, charging/profile changes, air conditioning, and
auxiliary heating. Enabling a group never sends a vehicle command; every action
still needs a fresh, specific human request, including any changed parameters.
No MCP tool can grant permission. Permissions are bound to the authenticated
user and connection revision, and are reset on reconnection/disconnection.
Existing V3 ventilation permission is retained; migration 0003 grants no new
permissions. Revocation prevents new dispatches, but cannot undo a sent request.
Every permission/S-PIN change invalidates previously preparing command intents.

Heating start requires S-PIN from MyŠkoda, entered only in the signed-in setup
page. It is AES-GCM encrypted with user/connection-specific authenticated context.
Only its configured/not-configured flag is returned. It can be replaced or deleted
without contacting the car, and is cleared on reconnection/disconnection.
Saving it never enables control. It is sent only in the official heating-start
JSON body; provider errors redact it as well as the API key and full VIN.

### Profile updates

1. Read `get_charging_profiles` on the relevant explicit user request.
2. Use the selected profile's fingerprint from
   `normalized.chargingProfileRevisions`. Present the exact intended changes.
3. After an explicit request for that change, call `update_charging_profile`
   with that fingerprint and only the requested `changes`.

A fresh preflight rejects a missing or changed profile before sending a PUT.
The outgoing request contains the **complete** profile, preserving its ID,
unrequested settings and future provider fields. Settings merge, including the
nested minimum-battery setting. Supplied timer/preferred-time arrays replace
complete lists; omitted arrays are preserved and an explicit empty array clears
one. Existing entries retain unmodified future fields by ID. Times remain
vehicle-local HH:mm; do not invent a timezone. Numeric identifiers must be exactly
representable in JavaScript; unsafe int64 IDs are refused rather than rounded.
There are no invented profile create/delete endpoints.

The fingerprint is an integration-side check at preflight, not an upstream atomic
compare-and-swap: the public API has no documented ETag/version precondition.
An external change between the fresh GET and PUT cannot be ruled out. Provider
412 means path/body profile-ID mismatch, not optimistic concurrency rejection.

### Dispatch and results

Before dispatch, the server rechecks permission, connection, fresh operation
support, service availability, parameters and quota. It reserves budget for the
POST/PUT and one verification read. A VIN lease spans the sequence. A successful
command normally uses three provider requests: preflight GET, POST/PUT, and one
verification GET. There is no automatic command retry or background polling.

A request ID is bound to the connection, action and a canonical parameter
fingerprint. The same ID returns the stored pending/result without another
write; changing its parameters is rejected. Recent same-action requests and
unresolved commands also block rapid new-ID retries. Existing V3 ventilation
records remain replayable. Parameter fingerprints contain no API key or S-PIN.

Only HTTP 202 produces `status: accepted`, never a claim of completion. One
bounded read sets `executionConfirmed: true` only if the requested state/settings
match and the relevant vehicle timestamp is at/after dispatch and not in the
future. Profile updates compare the complete expected profile. Stale/missing
measurements and failed verification remain unconfirmed. Transport failures,
5xx, redirects and unexpected successes are uncertain; known 4xx rejections
remain distinct. Neither is automatically retried. Disconnecting during an
operation never restores deleted permission or audit rows.

The acting account's ordinary and profile caches are invalidated before dispatch.
Audit results are encrypted; VIN identity is hashed. Audit retention is 30 days
with opportunistic cleanup after accepted commands, not scheduled deletion.
Disconnect removes that account's records immediately. Never reuse an old ID as
a new intent, including after retention cleanup.

See [API coverage and verification](docs/API_COVERAGE.md) and
[manual acceptance steps](docs/ACCEPTANCE.md).

## Data contract

- Raw provider fields remain under `vehicle`. License plate is masked by default;
  an HTTPS render URL is returned when supplied. A user-defined vehicle name is
  not evidence of the model name or production year.
- Use `normalized.energy` for interpretation. Combustion-engine SoC is preserved
  in raw data and flagged as ambiguous; it is never called traction-battery
  charge. Both hybrid engines are retained. Battery range is converted from
  metres to kilometres. Zero is distinct from missing data.
- `errors` is scoped to the requested view. `diagnostics.sourceErrors` preserves
  sanitized provider errors, and `diagnostics.parts` distinguishes available,
  unsupported, disabled, unavailable, unknown and not-requested data. Partial
  HTTP 200 responses are successful.
- `presentation.summary` and `presentation.services` provide user-facing Czech
  availability messages and severity. Unsupported functions are informational,
  including an unsupported-only profile result; they are not malfunctions or
  failed tool calls. Disabled and temporarily unavailable services stay distinct
  warnings. Missing data remains unknown, and unsupported profiles are never
  converted into an empty list. The existing `errors` array remains unchanged
  for compatibility and diagnostics; clients should not use its length as a
  failure flag.
- `normalized.lock` is conservative when official lock fields disagree. Raw
  lock semantics remain intact. Side-window state excludes the sunroof.
- Charging process state, cable connection and cable lock are independent.
  Missing charging state is not evidence of a disconnected cable. Future enum
  values are preserved rather than coerced to false/off.
- Heating and ventilation duration is configured run time after starting, not
  time remaining. Charging profile times are vehicle-local; the contract does
  not supply the vehicle timezone.
- `freshness.parts` reports measurement ages separately. `fetchedAt` is source
  retrieval time; `freshness.servedAt` is response time. Cache reuse never moves
  the source or measurement timestamps. Parking has no measurement timestamp in
  API 1.1.0; its age stays explicitly unknown.
- Quota metadata is a snapshot. `resetAt` remains Unix milliseconds for backward
  compatibility; `resetAtIso` and `resetAfterSeconds` make its units explicit.
  Connection-status timestamps are ISO 8601. Responses without quota headers do
  not refresh the last quota observation.
- Problems retain HTTP status, canonical problem type and redacted detail and
  instance. Retryable failures carry an explicit `error_code`; vehicle refusal,
  quota exhaustion, disabled functions and authorization errors stay distinct.

## Architecture and privacy

The selected deployment authenticates visitors and MCP callers; the server authorizes all data by
the injected `oai-authenticated-user-id`. Browser and tool identities must match.
No tool accepts a user ID, VIN or API key. User credentials and cached vehicle
responses use AES-256-GCM, random IVs and authenticated context binding each
ciphertext to its user, purpose and connection revision. The vault master key is
the runtime secret `VEHICLE_VAULT_KEY` (base64, 32 random bytes), never source.
Do not rotate this secret without a migration: doing so invalidates saved keys.

Reads use fixed-origin GET; the only provider writes are the eleven allowlisted public-API operations
behind the corresponding group permission and action gates. There are no arbitrary
fetches, analytics, or third-party scripts. Summary
requests explicitly exclude parking position and charging profiles. Separate
encrypted cache sections handle those sensitive reads. API credentials are sent
only in a header to the fixed official origin; redirects fail closed.

Results may be reused for 180 seconds; retrieval time is distinct from the car's
measurement timestamp. Expired encrypted rows become unreadable to tools and are
removed during subsequent successful reads; no scheduled physical deletion is
configured. Disconnect removes rows immediately. Platform backups have their own
retention. Quota rows contain keyed hashes of VINs, counters and reset times.
Established requests for the same VIN use an atomic database lease and upstream quota / retry
headers. Compatible concurrent views wait for the shared encrypted cache instead
of failing immediately. Cache identity includes user, connection revision and
section. A cache hit rechecks connection revision before disclosure. Quota is
shared across the same VIN, while vehicle data is never shared across accounts.
Currently documented upstream limit is 20 requests/hour/VIN and may
change. Calls outside this plugin can also consume that quota.

New connection candidates are verified outside the shared VIN lease. Only a
successful provider response for the exact submitted VIN can join that lease
and publish shared quota metadata. Candidate failures, including errors with
quota/retry headers, cannot create shared VIN rows or impose backoff on another
account. Delayed verified metadata cannot overwrite a newer quota observation.

Connection verification has database-atomic admission, shared across workers:
five attempts per account per 15-minute window, one in flight per account,
30 seconds of cooldown after failure, and a service-wide ceiling of 100 attempts
per 15-minute window and eight concurrent verifications. Changing VIN/key or
disconnecting does not reset these limits. Denials return HTTP 429 with
`CONNECTION_ATTEMPT_LIMITED` and `Retry-After`, before any provider request or
new account-state allocation. These budgets apply to verification, not cached
reads or established vehicle traffic. A 45-second token fences delayed commits;
expiry is rechecked atomically by the database when replacing the connection.
An unusually slow verification/lease wait can therefore expire safely and
require a new user attempt. There are no automatic retries.

Attempt rows contain account IDs, counters, timing and temporary random tokens;
they contain no candidate VIN, key or S-PIN. Idle attempt rows older than 24 hours
and inactive quota rows older than 24 hours are removed opportunistically on
subsequent relevant traffic. Active quota reset/backoff windows are retained;
there is no scheduled physical-deletion task. The migration grants no controls
and preserves existing connections, ciphertext and vault key.

These application limits bound provider amplification; they do not replace
hosting-layer DDoS protection. Before public release, verify Sites identity-header
sanitization/direct-ingress restrictions with two real accounts and validate
native-client approval behavior. The local suite uses synthetic identities and
does not prove those platform boundaries or perform live provider load tests.

Sites hosting controls access independently from plugin sharing. The first
deployment is owner-private. To share within a workspace, share both the Site
and its existing plugin using their supported sharing UI. User data remains
partitioned. No public-directory submission has been made.

MyŠkoda Public API permits personal end-user use only. Commercial products or
services require a different agreement/API, as described by the provider.

## Development

See the root [README](../README.md#development) for reproducible installation, tests and builds. Each deployment needs a new `VEHICLE_VAULT_KEY`; never commit credentials or runtime state.

## Verification scope

Tests cover real SQLite service SQL and migrations, authenticated MCP dispatch,
Cloudflare runtime request options, encrypted storage, cross-account and
revision isolation, concurrent cache fills, quota backoff, partial data and
representative diesel/EV/PHEV/CNG/LPG payloads. Synthetic electric payloads verify
the contract and normalization; they are not live acceptance on an EV/PHEV.
Tests may send control POSTs/PUTs only to injected local stubs, never to a real
vehicle. Do not call the production control tools for smoke tests or discovery.
Location/profile live tests require
the corresponding user request.

TTL tests use a controlled clock with the real service SQL: a read at 179.999
seconds reuses cache, simultaneous readers at exactly 180 seconds share one
refresh, and the refreshed result starts a new 180-second cache window. Source
measurements keep their own timestamps, including unchanged older measurements.
A failed refresh returns the upstream error and honors backoff instead of
returning expired data as a fresh successful response. These tests do not wait
three real minutes or consume the live vehicle quota.


Control tests cover off-by-default permission, same-origin/authenticated consent,
per-user isolation, reconnect reset, revocation races, capability and quota gates,
concurrent/repeated intents, uncertain outcomes, failed verification, disconnect
while sending, encrypted audit and Cloudflare POST/PUT/redirect behavior. UI rendering
tests check acknowledgement and revocation states using only a synthetic VIN.
A production smoke test may read `get_connection_status` to confirm control is
still disabled, but must not enable permission or call any control tool.

## Languages

The connection application supports Czech, Slovak, German, Polish, Hungarian, English, French, Italian, Spanish, Dutch, Danish, Turkish, Swedish, Norwegian Bokmål, Finnish, Romanian, Slovenian and Croatian.

The server uses an explicit `vc_language_v1` cookie preference first, then the weighted `Accept-Language` header, and finally English. The language selector provides an Automatic option and native language names. Manual choices last one year, are restricted to the supported allowlist, and use SameSite=Lax and Secure on HTTPS. Automatic mode follows browser language changes. Preferences contain no vehicle or account data. Switching language preserves draft fields and does not reload vehicle data.

Application messages live in `lib/i18n/messages`; every language must have all English message keys and matching interpolation placeholders. Existing Czech service notices and capability labels are mapped through `aliases.json`; web API errors are presented using stable codes rather than provider text. Machine-facing MCP tool names and parameters remain unchanged. Date formatting follows the UI language without changing the user's time zone. The used Astryx system labels are localized, including languages not shipped by the installed Astryx version.

Run `node --test tests/i18n.test.mjs tests/onboarding-ui.test.mjs` for preference negotiation, dictionary completeness, placeholder integrity, accessibility labels and rendering checks across all 18 languages. Native-speaker editorial review remains advisable for control-consent wording before wider promotion.
