import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("runbook identifies automated database ACLs and console identity hard gates", () => {
  for (const collection of [
    "courts",
    "session_templates",
    "sessions",
    "court_allocations",
    "bookings",
    "booking_codes",
    "audit_logs",
    "notification_outbox",
    "rate_limits",
    "idempotency",
    "system_state",
    "court_day_allocations",
  ]) {
    assert.match(readme, new RegExp(`\\b${collection}\\b`), collection);
  }
  assert.match(readme, /DescribeDatabaseACL/);
  assert.match(readme, /ModifyDatabaseACL/);
  assert.match(readme, /ADMINONLY/);
  assert.match(readme, /anonymous Web SDK client/i);
  assert.match(readme, /ordinary staff Web SDK client/i);
  assert.match(readme, /Auth v2/i);
  assert.match(readme, /username\/password/i);
  assert.match(readme, /self-registration[^\n]*disabled/i);
  assert.match(readme, /initial staff account/i);
  assert.match(readme, /organization member/i);
  assert.match(readme, /BOOKING_ADMIN_USER_IDS/);
  assert.match(readme, /\["2086466604197666817"\]/);
  assert.match(
    readme,
    /2086466604197666817[\s\S]{0,120}built-in administrator[\s\S]{0,120}must not/i,
  );
  assert.match(readme, /trusted per-invocation[\s\S]{0,100}function context UID/i);
  assert.match(readme, /exact[\s\S]{0,80}BOOKING_ADMIN_USER_IDS[\s\S]{0,80}second authorization/i);
  assert.doesNotMatch(readme, /booking_staff[\s\S]{0,160}(?:paid|upgrade)/i);
  assert.doesNotMatch(readme, /Create a custom role/i);
});

test("runbook fixes the Beijing booking-v2 window and compact settings ownership", () => {
  const section = readme.match(
    /## Booking v2 operating rules[\s\S]*?(?=## Daily homepage promotion)/,
  )?.[0] ?? "";

  assert.match(section, /Asia\/Shanghai/);
  assert.match(section, /09:00 through 22:00/);
  assert.match(section, /half-hour/);
  assert.match(section, /`:00` or `:30`/);
  assert.match(section, /1, 2, 3, or 4 whole hours/);
  assert.match(section, /09:30–11:30.*valid/);
  assert.match(section, /09:30–11:00/);
  assert.match(section, /21:30–22:30/);
  assert.match(section, /explicit date, start time, and end time/);
  assert.match(section, /free-experience tier fixes function timeout at \*\*3\s+seconds\*\*/);
  assert.match(section, /deployment verifier checks[\s\S]*`Timeout: 3`/);
  assert.match(section, /GET `?\/v1\/availability`?/);
  assert.match(section, /GET `?\/v1\/availability\/windows`?/);
  assert.match(section, /Do not publish a separate `\/v2` gateway[\s\S]{0,20}path/);
  assert.match(section, /营业设置/);
  assert.match(section, /system_state\/booking-policy-v2[\s\S]{0,100}authoritative/i);
  assert.match(section, /session_templates[\s\S]{0,100}compatibility/i);
});

test("runbook gives staff a complete daily homepage-media workflow and recovery path", () => {
  const section = readme.match(
    /## Daily homepage promotion[\s\S]*?(?=## Staging-only CloudBase workflow)/,
  )?.[0] ?? "";

  for (const mimeType of ["image/jpeg", "image/png", "image/webp", "video/mp4"]) {
    assert.ok(section.includes(mimeType), mimeType);
  }
  assert.match(section, /8 MB/);
  assert.match(section, /50 MB/);
  for (const action of ["上传并发布", "发布", "下架", "置顶", "取消置顶", "删除"]) {
    assert.ok(section.includes(action), action);
  }
  assert.match(section, /directly to CloudBase Storage/);
  assert.match(section, /server-signed `PUT`/);
  assert.match(section, /refresh the admin page/);
  assert.match(section, /等待上传完成/);
  assert.match(section, /Delete[\s\S]{0,100}等待上传完成/i);
  assert.match(section, /Do not reuse the expired signed URL/i);
});

test("runbook makes the migration-ready gate precede static v2 publication", () => {
  const section = readme.match(
    /## Staging-only CloudBase workflow[\s\S]*?(?=## What the scripts do)/,
  )?.[0] ?? "";
  const storageCorsIndex = section.indexOf("Storage upload-CORS postcondition");
  const deployIndex = section.indexOf("Deploy the backward-compatible functions first");
  const migrateIndex = section.indexOf("migrate-booking-inventory-v2.mjs --apply");
  const publishIndex = section.indexOf("publish the static");

  assert.ok(storageCorsIndex >= 0);
  assert.ok(deployIndex > storageCorsIndex);
  assert.ok(migrateIndex > deployIndex);
  assert.ok(publishIndex > migrateIndex);
  assert.match(section, /readiness marker[\s\S]{0,180}availability path stays closed/i);
  assert.match(section, /legacy v1 path[\s\S]{0,100}dual-writes/i);
  assert.match(section, /system_state\/booking-inventory-v2-migration/);
  assert.match(section, /status="ready"/);
  assert.match(section, /schemaVersion=2/);
  assert.match(section, /Never set this marker manually/i);
  assert.match(section, /failed migration[\s\S]{0,160}safe gated state/i);
});

test("runbook assigns route, CORS, OPTIONS, and exact runtime configuration ownership", () => {
  assert.match(readme, /Pages[^\n]*Source[^\n]*GitHub Actions/i);
  assert.match(readme, /same API origin/i);
  assert.match(readme, /\/v1\/admin[^\n]*enableAuth=true/i);
  assert.match(readme, /admin[^\n]*OPTIONS/i);
  assert.match(readme, /gateway[^\n]*CORS/i);
  assert.match(readme, /Web\s+security sources/i);
  assert.doesNotMatch(readme, /add the matching host entries to CloudBase \*\*Web\s+security sources/i);
  for (const source of [
    "lingko-ljx.github.io",
    "127.0.0.1:3001",
    "localhost:3001",
  ]) {
    assert.match(readme, new RegExp(source.replaceAll(".", "\\.")), source);
  }
  for (const name of [
    "PUBLIC_ALLOWED_ORIGINS",
    "PUBLIC_RESULT_URL",
    "RATE_LIMIT_SALT",
    "PHONE_HASH_SALT",
    "IDEMPOTENCY_SALT",
    "CLOUDBASE_ENV_ID",
    "BOOKING_ADMIN_USER_IDS",
    "DATA_TIMEZONE",
    "SES_REGION",
    "SES_FROM_EMAIL",
    "SES_TEMPLATE_ID",
    "SES_REPLY_TO",
    "STAFF_NOTIFICATION_EMAIL",
    "BOOKING_SES_SECRET_ID",
    "BOOKING_SES_SECRET_KEY",
  ]) {
    assert.match(readme, new RegExp(`\\b${name}\\b`), name);
  }
  const runtimeSection = readme.match(/### 5\.[\s\S]*?(?=### 6\.)/)?.[0] ?? "";
  assert.match(runtimeSection, /TENCENTCLOUD_[^\n]*reserved/i);
  assert.doesNotMatch(
    runtimeSection,
    /\bTENCENTCLOUD_SECRET_(?:ID|KEY)\b/,
  );
  assert.match(
    runtimeSection,
    /booking-admin-api[\s\S]{0,400}must not read or receive[\s\S]{0,80}PHONE_HASH_SALT/i,
  );
  assert.match(readme, /booking-mailer[\s\S]{0,100}(?:receives|requires) exactly seven/i);
});

test("runbook records the real manager-generated Storage CORS contract", () => {
  const section = readme.match(
    /#### CloudBase Storage CORS[\s\S]*?(?=### 5\.)/,
  )?.[0] ?? "";

  assert.match(section, /ensure-cloudbase-storage-cors\.mjs/);
  assert.match(section, /CLOUDBASE_SITE_URL/);
  assert.match(section, /https:\/\/lingko-ljx\.github\.io/);
  assert.match(section, /@cloudbase\/manager-node@5\.6\.6/);
  assert.match(section, /modifyCosCorsDomain\(\)/);
  assert.match(section, /Storage ACL[\s\S]{0,160}`ADMINONLY`/i);
  assert.match(section, /final ACL is exactly `ADMINONLY`/i);
  assert.match(section, /CORS success alone[\s\S]{0,100}authorization proof/i);
  assert.match(section, /both `http:\/\/` and[\s\S]{0,40}`https:\/\/`/);
  assert.match(section, /GET, POST, PUT, DELETE, HEAD/);
  assert.match(section, /AllowedHeader: \["\*"\]/);
  for (const header of [
    "Authorization",
    "Content-Type",
    "Signature",
    "key",
    "x-cos-security-token",
    "x-cos-meta-fileid",
  ]) {
    assert.ok(section.includes(header), header);
  }
  assert.match(section, /does\s+not authorize an unsigned operation/i);
  assert.match(section, /No routine console CORS edit is\s+required/i);
  assert.match(section, /all twelve database[\s\S]{0,180}ADMINONLY/i);
  assert.match(section, /homepage-media-v1/);
});

test("runbook documents the free static-hosting admin URL without overclaiming paid controls", () => {
  assert.match(readme, /free(?:-tier| experience)/i);
  assert.match(readme, /CLOUDBASE_SITE_URL/);
  assert.match(readme, /CLOUDBASE_SITE_URL[^\n]*\/admin\//i);
  assert.match(readme, /hosting deploy out/);
  assert.match(readme, /function[\s\S]{0,120}exact[\s\S]{0,160}before[\s\S]{0,120}static/i);
  assert.match(readme, /public API[\s\S]{0,100}before[\s\S]{0,100}static/i);
  assert.match(readme, /does not create or add CloudBase \*\*Web\s+security sources/i);
  assert.doesNotMatch(
    readme,
    /(?:^|\n)\s*(?:create|add)[^\n]*Web\s+security sources/im,
  );
});

test("runbook does not overclaim automation and requires staging, SES, timer, and rollback checks", () => {
  assert.match(readme, /cannot infer[\s\S]{0,100}production environment/i);
  assert.match(readme, /CLOUDBASE_DEPLOYMENT_STAGE[^\n]*staging/);
  assert.match(readme, /SES[\s\S]{0,100}(?:approved|approval)/i);
  assert.match(readme, /deploy[\s\S]{0,100}(?:does not|is not)[\s\S]{0,80}timer/i);
  assert.match(readme, /snapshot/i);
  assert.match(readme, /rollback/i);
  assert.match(readme, /never\s+delete or rebuild/i);
  assert.doesNotMatch(readme, /Formspree/i);
});
