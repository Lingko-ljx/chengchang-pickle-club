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
In GitHub **Settings → Pages**, set **Source** to **GitHub Actions** before the
first release; the legacy branch publisher must not remain active.

## Booking v2 operating rules

All customer and staff booking times are Beijing time (`Asia/Shanghai`). The
venue is open daily from **09:00 through 22:00**. A booking may start on each
half-hour (`:00` or `:30`), must last **1, 2, 3, or 4 whole hours**, and must end
no later than 22:00. For example, `09:30–11:30` is valid; `09:30–11:00`,
`08:30–09:30`, and `21:30–22:30` are invalid. The public form always submits an
explicit date, start time, and end time, and the staff calendar displays that
same interval rather than inferring an end time from a legacy session ID.

The current CloudBase free-experience tier fixes function timeout at **3
seconds** and does not allow it to be increased. The deployment verifier checks
that all three functions still report `Timeout: 3`; performance work must reduce
database round trips rather than trying to override the plan limit.

The compact **营业设置** panel is for enabling or disabling courts. Do not try
to recreate the booking window by checking dozens of individual hourly
templates: `system_state/booking-policy-v2` is the authoritative v2 policy. The
old `session_templates` documents remain only for compatibility with bookings
created by the previous interface.

## Daily homepage promotion

Staff can use **后台 → 首页宣传** to upload a daily court photo or video. Images
must be `image/jpeg` (JPG), `image/png`, or `image/webp` and no larger than 8 MB.
Videos must be `video/mp4` and no larger than 50 MB. Add a short title, optional
caption, and useful visual description, then choose **上传并发布**. The library
supports **发布**, **下架**, **置顶 / 取消置顶**, and **删除**; only one published
item is pinned at a time, and the homepage shows at most the configured public
selection rather than every historical upload.

The browser sends file bytes directly to CloudBase Storage with a short-lived,
server-signed `PUT`; file bytes never pass through the booking function. If an
upload fails or the page is closed during transfer, refresh the admin page and
inspect the media library. Delete any **等待上传完成** entry, then start a new
upload. Do not reuse the expired signed URL or assume that an interrupted item
was published.

## Staging-only CloudBase workflow

`.github/workflows/cloudbase.yml` is manual-only and targets the protected
`cloudbase-staging` GitHub environment. Configure these repository variables:

- `CLOUDBASE_DEPLOYMENT_STAGE=staging`
- `CLOUDBASE_ENV_ID` set to the exact, administrator-confirmed test environment
- `BOOKING_API_BASE_URL` set to the staging gateway origin
- `CLOUDBASE_SITE_URL` set to that environment's default static-hosting HTTPS
  root URL, with no path, credentials, query, or fragment

Configure GitHub secrets `TENCENTCLOUD_SECRET_ID` and
`TENCENTCLOUD_SECRET_KEY`. The workflow maps them to the no-underscore variable
names required by CloudBase CLI without printing either value.

CloudBase CLI 3.7.0 ignores those environment credentials when its default empty
login store wins credential resolution. The workflow therefore invokes the CLI
through `scripts/run-cloudbase-cli.mjs`. That wrapper creates an exclusive,
permission-restricted credential store immediately before each CLI process,
removes the two credential variables from the child environment, passes no
credential on the command line, and deletes the store in `finally` after either
success or failure. It refuses to overwrite any pre-existing credential store.

Automation cannot infer whether an opaque CloudBase environment ID belongs to a
production environment. Before every run, an administrator must confirm in the
CloudBase console that `CLOUDBASE_ENV_ID` is the isolated test environment, type
that exact ID into the dispatch prompt, and approve the protected GitHub
environment. Production deployment belongs to a separate protected workflow;
do not weaken `CLOUDBASE_DEPLOYMENT_STAGE=staging` here.

The workflow runs `npm ci`, then runs `npm test` with `GITHUB_PAGES=false` and
the staging public API/environment identifiers, and lints the source. It also
builds and verifies a root-directory static export with `PAGES_BASE_PATH=/`, but
does not publish that export yet. Only after the local gates pass does it build
all functions, atomically render the ignored root `cloudbaserc.json`, and
provision additive database resources.

Immediately after provisioning and before any function deployment, the workflow
enforces the CloudBase Storage upload-CORS postcondition documented below. A
configuration or verification failure stops the release before function or
static-site publication.

Booking v2 then uses a mandatory two-phase cutover:

1. Deploy the backward-compatible functions first. While the readiness marker
   is absent, the new availability path stays closed and v2 creates are denied;
   the legacy v1 path remains usable and dual-writes the new daily inventory.
2. Run `scripts/migrate-booking-inventory-v2.mjs --apply`, then
   `scripts/verify-booking-inventory-v2.mjs`. Verification must reject missing,
   conflicting, or stale cell ownership before it writes or accepts the exact
   `system_state/booking-inventory-v2-migration` marker with `status="ready"`
   and `schemaVersion=2`. Never set this marker manually. Only after that ready
   gate passes may the workflow verify the functions/API and publish the static
   v2 interface.

This ordering means a failed migration leaves the already deployed compatible
functions in their safe gated state and prevents the new static booking form
from going live. Every function must then be Active
with Node.js 20.19, `index.main`, dependency installation enabled, and the
current commit revision in its description. The mailer must also expose exactly
the `booking-mailer-every-minute` timer with `0 * * * * * *`.

Function exact-key verification and a bounded public API availability/CORS smoke
run before any static publication. Only then does the credential wrapper run
`hosting deploy out`; it never deletes remote files. A final bounded HTTP smoke
requires the root and `/admin/` pages to contain the real API/environment/client
markers and rejects framework runtime or secret material. The free-tier admin
URL is `CLOUDBASE_SITE_URL` plus `/admin/`.

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
fields, and fails closed on collection, index, seed, or ACL response drift. It
uses the TCB `DescribeDatabaseACL` and `ModifyDatabaseACL` APIs to move every
managed collection only toward the `ADMINONLY` client ACL. It will never lower
that ACL. It will never delete or rebuild a collection, index, or document.

Provisioning covers these twelve collections:

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
court_day_allocations
```

It creates the ten planned compound indexes, courts `01` through `11`, the
sixteen legacy 60-minute templates `slot-0700` through `slot-2200`, and the
authoritative `booking-policy-v2` seed (`09:00–22:00`, 30-minute starts,
60-minute duration steps, 60-minute minimum, and 240-minute maximum).

The provisioning script configures only the twelve collection ACLs described
above. It cannot configure Auth, RBAC, gateway routes/API CORS, function runtime
environment values, SES approval, snapshots, or rollback. The separate Storage
security step enforces the `ADMINONLY` Storage ACL and the signed-upload CORS
rule documented below; the other items remain manual hard gates. A green
workflow is not production approval.

## Manual hard gates before staging is ready

Record the operator, time, environment ID, and evidence for every item. Complete
the snapshot and change-control gate below before the first workflow run. That
run additively provisions the database, enforces `ADMINONLY` on its twelve
collections, and creates or updates the functions, but it does not configure
Auth/RBAC, gateway routes/API CORS, runtime environment values, or SES. The bootstrap run
is therefore expected to fail its final function-detail
verification after provisioning and deployment because the exact runtime key
sets are not present yet. The workflow stops before public API validation or
static publication in that state. Complete those console gates, manually
re-check the keys, rerun the workflow, and run synthetic smoke tests before
allowing traffic.

### 1. Snapshot and change control

- Confirm the environment is the isolated test environment.
- Take a restorable database snapshot before provisioning or redeployment and
  record its identifier and retention period.
- Record the currently deployed function versions, descriptions, routes,
  triggers, and environment-variable key names. Do not copy secret values into
  tickets or logs.
- Agree on the rollback owner and maintenance window before making changes.

### 2. Deny direct database access

Provisioning reads each collection's current basic ACL and changes only drifted
collections to `ADMINONLY`, which the CloudBase console presents as no direct
client access. A partial run can be rerun safely: collections already at
`ADMINONLY` receive no write. The workflow also reads all twelve ACLs again with
bounded retries and fails unless every result is exactly `ADMINONLY`.

As the release hard gate, verify both an anonymous Web SDK client and an
authenticated ordinary staff Web SDK client are denied direct reads and writes
for every collection. All booking data access must traverse the public or admin
HTTP function; CloudBase login alone must not grant database access.

### 3. Configure Auth v2 and least-privilege staff access

- Enable CloudBase Auth v2 username/password authentication.
- Keep public self-registration explicitly disabled.
- For the free experience, create the initial staff account as a normal CloudBase
  Auth organization member. Do not use the built-in super administrator, a CAM
  sub-user, or an automatically privileged account.
- As a one-time operator setup step after login, call `/auth/v1/user/me`, record
  the exact `user_id`, and set the admin function runtime value to the strict JSON array
  `BOOKING_ADMIN_USER_IDS=["<verified decimal user_id>"]`; similar IDs do not
  match. The previously observed value `["2086466604197666817"]` belongs to the
  built-in administrator and must not appear in the formal allowlist. If it is
  present during setup, stop deployment, create the ordinary member, and replace
  it before rerunning the workflow.
- The admin function does not forward browser authorization headers to `/me`.
  With gateway authentication enabled it resolves the trusted per-invocation
  CloudBase function context UID, then requires an exact
  `BOOKING_ADMIN_USER_IDS` match as a second authorization check. Missing,
  malformed, or merely similar UIDs fail closed.
- Keep the public route anonymous and keep `/v1/admin` `enableAuth=true` at the
  gateway. A future role-based path requires a trusted
  server-side role lookup and must not trust body, header, or gateway-event
  group assertions.

### 4. Configure one gateway origin and CORS ownership

Expose public and admin paths under the same API origin stored in
`BOOKING_API_BASE_URL`; do not publish unrelated cross-origin admin endpoints.
The public path has gateway authentication off. The admin path has identity
authentication on.

The public handler owns its CORS allowlist and preflight response. The gateway
owns admin CORS because the admin handler intentionally emits no CORS headers.
Do not configure duplicate, conflicting headers. `PUBLIC_ALLOWED_ORIGINS` must
include the exact origin of `CLOUDBASE_SITE_URL` before static publication; the
workflow's public API smoke sends that Origin and requires an exact allow-origin
response. Retain only separately approved public/development origins:

```text
https://lingko-ljx.github.io
http://127.0.0.1:3001
http://localhost:3001
```

The workflow does not create or add CloudBase **Web security sources** (WEB
safety domains). The free experience uses the environment's default static
hosting origin. Treat GitHub Pages and loopback entries as separate pre-existing
operator approvals when they are needed; do not silently broaden that list or
promise that the free-tier workflow provisions new safety domains.

Validate admin `OPTIONS` at the deployed gateway before login testing: it must
return the intended allow-origin/method/header policy without invoking business
logic. Also verify an unlisted origin receives no permissive CORS response.

#### CloudBase Storage CORS for signed homepage-media uploads

API CORS does not authorize the browser's direct Storage upload. Before function
deployment, the workflow runs `scripts/ensure-cloudbase-storage-cors.mjs`. It
strictly derives the HTTPS hostname from `CLOUDBASE_SITE_URL` and ensures the
CloudBase/COS compatibility rule. The only hostnames the script automatically
manages are:

```text
<exact origin extracted from CLOUDBASE_SITE_URL>
https://lingko-ljx.github.io
```

The same step reads the CloudBase Storage ACL, changes it only toward
`ADMINONLY` when drifted, and reads it back with bounded retries. The workflow
stops unless the final ACL is exactly `ADMINONLY`; CORS success alone is never
treated as authorization proof.

For each hostname, pinned `@cloudbase/manager-node@5.6.6`
`modifyCosCorsDomain()` writes its fixed compatibility shape: both `http://` and
`https://`, methods `GET, POST, PUT, DELETE, HEAD`, and
`AllowedHeader: ["*"]`. The required postcondition is that the rule includes the
HTTPS origin and `PUT`; the provider header wildcard covers the signed direct
upload's generated request headers:

```text
Authorization
Content-Type
Signature
key
x-cos-security-token
x-cos-meta-fileid
```

Do not describe the manager-generated rule as an HTTPS-only or PUT-only rule,
and do not copy its wildcard/method set into API-gateway CORS. Storage CORS does
not authorize an unsigned operation: object upload still requires the
short-lived signature. The script preserves unrelated existing CORS rules,
performs no write when the required postcondition already exists, and fails the
workflow if that postcondition is not visible. No routine console CORS edit is
required. CloudBase/COS handles the preflight `OPTIONS`; this application uses
the signed `PUT` operation.

After the workflow passes, perform one small JPG canary upload from the
CloudBase-hosted admin page and one from the GitHub Pages admin page. Publish,
view, unpublish, and delete the canary before accepting the release. If either
browser preflight fails, stop; do not loosen the rule to make the test pass.

Storage CORS never changes database authorization. All twelve database
collections, including `system_state` (which contains the
`homepage-media-v1` manifest and both booking policy/migration markers), remain
`ADMINONLY`. Storage must not allow anonymous public writes or broad public
listing/reading: the admin function issues a short-lived signed upload, and the
public function returns short-lived download URLs only for published items.

### 5. Set exact function runtime configuration

Set values directly on each CloudBase function. Do not put them in GitHub
variables, `cloudbaserc.json`, source files, screenshots, or logs.

- `booking-public-api` requires exactly
  `PUBLIC_ALLOWED_ORIGINS`, `PUBLIC_RESULT_URL`, `DATA_TIMEZONE`,
  `RATE_LIMIT_SALT`, `PHONE_HASH_SALT`, and `IDEMPOTENCY_SALT`.
  `DATA_TIMEZONE` must equal `Asia/Shanghai`. Use independent high-entropy salts.
  `PUBLIC_RESULT_URL` must be HTTPS, contain no query/fragment/credentials, and
  use one of the configured allowed origins.
- `booking-admin-api` requires exactly `CLOUDBASE_ENV_ID`, `DATA_TIMEZONE`, and
  `BOOKING_ADMIN_USER_IDS`, with `DATA_TIMEZONE=Asia/Shanghai`.
  `BOOKING_ADMIN_USER_IDS` must be a strict JSON array of canonical decimal Auth
  `user_id` strings (`^[1-9][0-9]{0,31}$`); duplicates and
  malformed, blank, username-like, or overlong IDs fail closed. The admin
  function must not read or receive
  `PHONE_HASH_SALT`; hashing is performed only by the public API paths.
  The value `[]` is valid for the first safe configuration or emergency
  revocation: it denies every admin user.
- `booking-mailer` receives exactly seven variables:
  `BOOKING_SES_SECRET_ID`, `BOOKING_SES_SECRET_KEY`, `SES_REGION`,
  `SES_FROM_EMAIL`, `SES_TEMPLATE_ID`, `SES_REPLY_TO`, and
  `STAFF_NOTIFICATION_EMAIL`.
  The `TENCENTCLOUD_` prefix is reserved by CloudBase, so do not use the GitHub
  CAM secret names as function runtime variable names. Their values are copied
  into the two `BOOKING_SES_*` variables directly in the CloudBase console.

Missing or invalid public/admin configuration fails closed with a sanitized
variable-name-only error. After setting the variables, invoke each handler with
synthetic input and inspect sanitized logs; merely seeing the keys in the
console is not a runtime smoke test.
Every admin JSON, error, and CSV response also sets `Cache-Control: no-store,
private` and `Pragma: no-cache`; public availability caching remains independent.

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
- Confirm the ordinary Auth user's exact ID is allowlisted and a lookalike ID is
  rejected. Do not test with or configure the built-in super administrator.
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
