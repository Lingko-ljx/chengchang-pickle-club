import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("runbook identifies every console-only database and identity hard gate", () => {
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
  ]) {
    assert.match(readme, new RegExp(`\\b${collection}\\b`), collection);
  }
  assert.match(readme, /deny direct client read and write/i);
  assert.match(readme, /Auth v2/i);
  assert.match(readme, /username\/password/i);
  assert.match(readme, /self-registration[^\n]*disabled/i);
  assert.match(readme, /booking_staff/);
  assert.match(readme, /initial staff account/i);
  assert.match(readme, /organization member/i);
  assert.match(readme, /groups\[\]\.id[^\n]*booking_staff/i);
});

test("runbook assigns route, CORS, OPTIONS, and exact runtime configuration ownership", () => {
  assert.match(readme, /Pages[^\n]*Source[^\n]*GitHub Actions/i);
  assert.match(readme, /same API origin/i);
  assert.match(readme, /admin[^\n]*OPTIONS/i);
  assert.match(readme, /gateway[^\n]*CORS/i);
  assert.match(readme, /Web\s+security sources/i);
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
    readme,
    /booking-admin-api[\s\S]{0,200}must not read or receive[\s\S]{0,80}PHONE_HASH_SALT/i,
  );
  assert.match(readme, /booking-mailer[\s\S]{0,100}(?:receives|requires) exactly seven/i);
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
