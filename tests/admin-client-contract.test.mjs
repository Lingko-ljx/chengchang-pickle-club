import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { parse } from "acorn";
import { build } from "esbuild";

import { createAdminApiClient } from "../admin-client/api.ts";
import {
  createAuthenticatedSession,
  readAdminConfig,
} from "../admin-client/config.ts";
import {
  BOOKING_ACTIONS,
  COURT_IDS,
  confirmationMessage,
  sessionTemplateDuration,
} from "../admin-client/render.ts";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authRequiredResponse() {
  return new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function containsRuntimeProcessEnv(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsRuntimeProcessEnv);
  if (
    value.type === "MemberExpression" &&
    value.object?.type === "Identifier" &&
    value.object.name === "process" &&
    value.property?.type === "Identifier" &&
    value.property.name === "env"
  ) {
    return true;
  }
  return Object.values(value).some(containsRuntimeProcessEnv);
}

async function renderAdminPage() {
  const result = await build({
    stdin: {
      contents: `
        import Page from "./app/admin/page.tsx";
        import { renderToStaticMarkup } from "react-dom/server";
        export default renderToStaticMarkup(Page());
      `,
      loader: "tsx",
      resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"),
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    packages: "external",
    write: false,
    logLevel: "silent",
    define: {
      "process.env.GITHUB_PAGES": '"true"',
      "process.env.NODE_ENV": '"production"',
      "process.env.PAGES_BASE_PATH": '"/chengchang-pickle-club"',
      "process.env.NEXT_PUBLIC_BOOKING_API_BASE_URL": '"https://booking-api.example.invalid"',
      "process.env.NEXT_PUBLIC_CLOUDBASE_ENV_ID": '"booking-test-000000"',
    },
  });
  const loadedModule = { exports: {} };
  const evaluate = new Function("require", "module", "exports", result.outputFiles[0].text);
  evaluate(createRequire(import.meta.url), loadedModule, loadedModule.exports);
  return loadedModule.exports.default;
}

test("every management request carries the current bearer token", async () => {
  const requests = [];
  const client = createAdminApiClient({
    baseUrl: "https://booking-api.example.invalid",
    getAccessToken: () => "staff-access-token",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ ok: true });
    },
    onUnauthorized() {},
  });

  await client.getDashboard("2026-08-09");
  await client.listBookings({ date: "2026-08-09", status: "pending", mode: "open" });
  await client.mutateBooking("booking-1", "confirm", { expectedVersion: 2 });
  await client.setCourtEnabled("01", false, 3);
  await client.setSessionTemplateEnabled("mon-0900", true, 4);
  await client.exportCsv("2026-08-01", "2026-08-31");

  assert.equal(requests.length, 6);
  for (const request of requests) {
    assert.equal(request.init.headers.Authorization, "Bearer staff-access-token");
  }
});

test("a 401 clears the client session before surfacing the error", async () => {
  let unauthorizedCount = 0;
  const client = createAdminApiClient({
    baseUrl: "https://booking-api.example.invalid",
    getAccessToken: () => "expired-token",
    fetchImpl: async () => authRequiredResponse(),
    onUnauthorized() {
      unauthorizedCount += 1;
    },
  });

  await assert.rejects(() => client.getDashboard("2026-08-09"), /AUTH_REQUIRED/);
  assert.equal(unauthorizedCount, 1);
});

test("admin config accepts only public env, API and base-path attributes", () => {
  const shell = {
    dataset: {
      cloudbaseEnvId: "booking-test-000000",
      apiBaseUrl: "https://booking-api.example.invalid",
      siteBasePath: "/chengchang-pickle-club",
    },
  };

  assert.deepEqual(readAdminConfig(shell), {
    cloudbaseEnvId: "booking-test-000000",
    apiBaseUrl: "https://booking-api.example.invalid",
    siteBasePath: "/chengchang-pickle-club",
  });
});

test("admin config fails closed when a required public value is absent", () => {
  assert.throws(
    () => readAdminConfig({ dataset: { siteBasePath: "" } }),
    /后台暂不可用/,
  );
});

test("the court matrix always exposes the eleven planned court columns", () => {
  assert.deepEqual(COURT_IDS, [
    "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11",
  ]);
});

test("mutation confirmation identifies the booking, date and action", () => {
  const message = confirmationMessage(
    { code: "BOOK-42", date: "2026-08-09" },
    "取消预约",
  );

  assert.match(message, /BOOK-42/);
  assert.match(message, /2026-08-09/);
  assert.match(message, /取消预约/);
});

test("session templates are fixed to exactly sixty minutes", () => {
  assert.equal(sessionTemplateDuration, 60);
});

test("booking detail offers every protected lifecycle and privacy action", () => {
  assert.deepEqual(BOOKING_ACTIONS, [
    ["confirm", "确认预约"],
    ["reschedule", "提出改期"],
    ["cancel", "取消预约"],
    ["complete", "完结预约"],
    ["reassign", "调整场地"],
    ["redact", "提前脱敏"],
  ]);
});

test("staff login uses the v2 signIn object contract and keeps its token in closure", async () => {
  const credentials = [];
  const session = createAuthenticatedSession({
    async signIn(input) {
      credentials.push(input);
      return { credential: { accessToken: "private-access-token" } };
    },
  });

  await session.login("staff-user", "staff-password");
  assert.deepEqual(credentials, [{ username: "staff-user", password: "staff-password" }]);
  assert.equal(session.getAccessToken(), "private-access-token");
  session.clear();
  assert.equal(session.getAccessToken(), "");
  assert.equal("accessToken" in session, false);
});

test("the generated admin client is an ES2017 IIFE without runtime config or secrets", async () => {
  const source = await readFile(
    new URL("../public/admin-app.js", import.meta.url),
    "utf8",
  );

  const program = parse(source, { ecmaVersion: 2017, sourceType: "script" });
  assert.match(source, /^"use strict";\(\(\)=>\{/);
  assert.equal(containsRuntimeProcessEnv(program), false);
  assert.doesNotMatch(source, /NEXT_PUBLIC_|CLOUDBASE_SECRET|API[_-]?KEY/i);
  assert.doesNotMatch(source, /staff-password|private-access-token/);
});

test("the server-rendered admin page contains login and a hidden dashboard", async () => {
  const html = await renderAdminPage();
  assert.match(html, /id="admin-login-form"/);
  assert.match(html, /<div\b(?=[^>]*\bid="admin-dashboard")(?=[^>]*\bhidden(?:="")?)[^>]*>/);
  assert.match(html, /data-cloudbase-env-id="booking-test-000000"/);
  assert.match(html, /data-api-base-url="https:\/\/booking-api\.example\.invalid"/);
  assert.match(html, /data-site-base-path="\/chengchang-pickle-club"/);
  assert.match(html, /data-admin-client="true"/);
  assert.match(html, /src="\/chengchang-pickle-club\/admin-app\.js"/);
});
