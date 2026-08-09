# Chengchang Pickle Club booking stack

This repository contains a statically exported public and staff site plus three
Tencent CloudBase functions: `booking-public-api`, `booking-admin-api`, and
`booking-mailer`. Node.js `>=22.13.0` is required for local builds.

## Local verification

```bash
npm ci
npm test
npm run lint
npm run build:cloudbase
```

A GitHub Pages build also requires the public booking API and CloudBase IDs:

```powershell
$env:GITHUB_PAGES="true"
$env:PAGES_BASE_PATH="/chengchang-pickle-club"
$env:NEXT_PUBLIC_SITE_URL="https://lingko-ljx.github.io/chengchang-pickle-club/"
$env:NEXT_PUBLIC_BOOKING_API_BASE_URL="https://booking-api.example.invalid"
$env:NEXT_PUBLIC_CLOUDBASE_ENV_ID="booking-test-000000"
npm run build:pages
npm run test:pages
```

`NEXT_PUBLIC_SITE_URL` is normalized as a directory URL and must match
`PAGES_BASE_PATH`. Production URLs must use HTTPS and cannot contain credentials,
a query, or a fragment. The Pages workflow consumes `actions/configure-pages`
outputs, so both a GitHub project URL and a custom-domain root URL are supported.

## Staging-only CloudBase workflow

`.github/workflows/cloudbase.yml` is manual-only and targets the protected
`cloudbase-staging` GitHub environment. Configure these repository variables:

- `CLOUDBASE_DEPLOYMENT_STAGE=staging`
- `CLOUDBASE_ENV_ID` set to the exact, administrator-confirmed test environment
- `BOOKING_API_BASE_URL` set to the staging gateway origin

Configure GitHub secrets `TENCENTCLOUD_SECRET_ID` and
`TENCENTCLOUD_SECRET_KEY`. The workflow maps them to the no-underscore variable
names required by CloudBase CLI without printing either value.

Automation cannot infer whether an opaque CloudBase environment ID belongs to a
production environment. Before every run, an administrator must confirm in the
CloudBase console that `CLOUDBASE_ENV_ID` is the isolated test environment, type
that exact ID into the dispatch prompt, and approve the protected GitHub
environment. Production deployment belongs to a separate protected workflow;
do not weaken `CLOUDBASE_DEPLOYMENT_STAGE=staging` here.

The workflow runs `npm ci`, then runs `npm test` with `GITHUB_PAGES=false` and
the staging public API/environment identifiers, and lints the source. Only after
both gates pass does it build all functions, atomically render the ignored root
`cloudbaserc.json`, provision additive database resources, deploy, and read each
function detail independently. Every function must be Active
with Node.js 20.19, `index.main`, dependency installation enabled, and the
current commit revision in its description. The mailer must also expose exactly
the `booking-mailer-every-minute` timer with `0 * * * * * *`.

A successful deploy does not prove the timer exists: CloudBase CLI 3.7 can
report trigger or per-function errors without a failing process exit. Treat the
independent detail check as mandatory. If the CLI reports a trigger warning,
repair and verify the timer in the console, then rerun the workflow. Never infer
timer health from the deploy step alone.

## What the scripts do—and do not do

`scripts/render-cloudbase-config.mjs` writes only the repository-root
`cloudbaserc.json`. It includes three function definitions and the timer, but
zero `envVariables`, secret names, or secret values. It requires the explicit
environment ID and a 40-character deployment revision.

`scripts/provision-cloudbase.mjs` uses `@cloudbase/manager-node` 5.6.6 and
`@cloudbase/node-sdk` 3.18.3. It creates missing resources, verifies their
postconditions with bounded retries, preserves existing `enabled` and `version`
fields, and fails closed on collection, index, or seed drift. It will never
delete or rebuild a collection, index, or document.

Provisioning covers these eleven collections:

```text
courts
session_templates
sessions
court_allocations
bookings
booking_codes
audit_logs
notification_outbox
rate_limits
idempotency
system_state
```

It creates the nine planned compound indexes, courts `01` through `11`, and the
sixteen 60-minute templates `slot-0700` through `slot-2200`.

The scripts cannot configure database ACLs, Auth, RBAC, gateway routes, CORS,
function runtime environment values, SES approval, snapshots, or rollback.
Those are manual hard gates below. A green workflow is not production approval.

## Manual hard gates before staging is ready

Record the operator, time, environment ID, and evidence for every item. Complete
the snapshot and change-control gate below before the first workflow run. That
run additively provisions the database and creates or updates the functions, but
it does not configure ACLs, Auth/RBAC, gateway/CORS, runtime environment values,
or SES. The bootstrap run is therefore expected to fail its final function-detail
verification after provisioning and deployment because the exact runtime key
sets are not present yet. Complete those console gates, manually re-check the
keys, rerun the workflow, and run synthetic smoke tests before allowing traffic.

### 1. Snapshot and change control

- Confirm the environment is the isolated test environment.
- Take a restorable database snapshot before provisioning or redeployment and
  record its identifier and retention period.
- Record the currently deployed function versions, descriptions, routes,
  triggers, and environment-variable key names. Do not copy secret values into
  tickets or logs.
- Agree on the rollback owner and maintenance window before making changes.

### 2. Deny direct database access

In CloudBase database security rules, set all eleven collections listed above to
deny direct client read and write. Verify both an anonymous client and an
authenticated staff client are denied. All booking data access must traverse the
public or admin HTTP function; CloudBase login alone must not grant database
access.

### 3. Configure Auth v2 and least-privilege staff access

- Enable CloudBase Auth v2 username/password authentication.
- Keep public self-registration explicitly disabled.
- Create `booking_staff` with permission to invoke only the admin HTTP resource;
  do not grant system-administrator, database, public-function, or deployment
  privileges.
- Create the initial staff account in the console, assign only `booking_staff`,
  and verify a non-member token receives 403 while that account can sign in.
- Keep the public route anonymous and require identity authentication on the
  admin route.

### 4. Configure one gateway origin and CORS ownership

Expose public and admin paths under the same API origin stored in
`BOOKING_API_BASE_URL`; do not publish unrelated cross-origin admin endpoints.
The public path has gateway authentication off. The admin path has identity
authentication on.

The public handler owns its CORS allowlist and preflight response. The gateway
owns admin CORS because the admin handler intentionally emits no CORS headers.
Do not configure duplicate, conflicting headers. Allow exactly these current
site/development origins unless an approved domain migration updates both code
and operations:

```text
https://lingko-ljx.github.io
http://127.0.0.1:3001
http://localhost:3001
```

Validate admin `OPTIONS` at the deployed gateway before login testing: it must
return the intended allow-origin/method/header policy without invoking business
logic. Also verify an unlisted origin receives no permissive CORS response.

### 5. Set exact function runtime configuration

Set values directly on each CloudBase function. Do not put them in GitHub
variables, `cloudbaserc.json`, source files, screenshots, or logs.

- `booking-public-api` requires exactly
  `PUBLIC_ALLOWED_ORIGINS`, `PUBLIC_RESULT_URL`, `DATA_TIMEZONE`,
  `RATE_LIMIT_SALT`, `PHONE_HASH_SALT`, and `IDEMPOTENCY_SALT`.
  `DATA_TIMEZONE` must equal `Asia/Shanghai`. Use independent high-entropy salts.
  `PUBLIC_RESULT_URL` must be HTTPS, contain no query/fragment/credentials, and
  use one of the configured allowed origins.
- `booking-admin-api` requires only `CLOUDBASE_ENV_ID` and `DATA_TIMEZONE`, with
  `DATA_TIMEZONE=Asia/Shanghai`. The admin function must not read or receive
  `PHONE_HASH_SALT`; hashing is performed only by the public API paths. This
  is an intentional least-privilege refinement of the older planning table.
- `booking-mailer` receives exactly seven variables:
  `TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY`, `SES_REGION`,
  `SES_FROM_EMAIL`, `SES_TEMPLATE_ID`, `SES_REPLY_TO`, and
  `STAFF_NOTIFICATION_EMAIL`.

Missing or invalid public/admin configuration fails closed with a sanitized
variable-name-only error. After setting the variables, invoke each handler with
synthetic input and inspect sanitized logs; merely seeing the keys in the
console is not a runtime smoke test.

### 6. Complete SES approval and timer verification

Confirm the SES sending domain/address and service-notification template are
approved, and that `SES_TEMPLATE_ID` is the numeric ID for that approved
template. Send one synthetic staff notification and one optional customer
notification. Confirm delivery/provider IDs, then remove synthetic personal data
and Outbox entries according to the test-data procedure.

Independently inspect `booking-mailer` after deployment. It must be Active and
have exactly one timer named `booking-mailer-every-minute` with the seven-field
schedule `0 * * * * * *`. Review the next invocation log and verify the
deterministic daily retention marker prevents duplicate daily retention work.

### 7. Staging acceptance

- Exercise availability, create, lookup, cancel, and reschedule-response routes
  with synthetic data; confirm matching audit and Outbox records.
- Exercise authenticated dashboard and mutation routes with the initial staff
  account; confirm anonymous and wrong-role requests fail.
- Repeat the admin `OPTIONS` and disallowed-origin checks against the final
  gateway URL.
- Verify the Pages repository variables point to this staging API/environment,
  then build and test the static site.
- Do not mark staging ready until runtime variables, ACLs, Auth/RBAC, routes,
  CORS, SES, timer, and synthetic smoke evidence are all signed off.

## Rollback

Stop traffic first if authorization, privacy, or allocation invariants fail.
Restore the previous gateway routing and deploy the last known-good function
revision/configuration. The provisioning script is additive and deliberately
has no destructive rollback; do not delete/rebuild resources to resolve drift.
Escalate drift for review.

Restore a database snapshot only under the recorded change procedure, after
preserving evidence and reconciling bookings created since the snapshot. Rotate
credentials or salts if exposure is suspected; understand that rotating
`PHONE_HASH_SALT` changes lookup compatibility and therefore requires an
approved data-migration plan. After any rollback, rerun authorization, CORS,
booking lifecycle, Outbox, timer, and privacy checks before reopening traffic.
