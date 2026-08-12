import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { build } from "esbuild";

import { createAdminApiClient } from "../admin-client/api.ts";
import {
  createAuthenticatedSession,
  createMemoryAuthStorage,
  initializePrivateAuth,
  readAdminConfig,
} from "../admin-client/config.ts";
import {
  BOOKING_ACTIONS,
  COURT_IDS,
  bookingActionsFor,
  bookingRecordActionsFor,
  bookingDurationHours,
  bookingDisplayName,
  confirmationMessage,
  formatShanghaiBookingSchedule,
  formatShanghaiDateTime,
  formatShanghaiDateTimeRange,
  homepageMediaActionsFor,
  matrixAssignmentsForCell,
  matrixBookingsForCell,
  normalizeBookingPage,
  recordDateRange,
  retainSelectedBooking,
  statusLabel,
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

async function renderAdminPage(basePath = "/chengchang-pickle-club") {
  const result = await build({
    stdin: {
      contents: `
        import Page from "./app/admin/page.tsx";
        import { renderToStaticMarkup } from "react-dom/server";
        export default renderToStaticMarkup(Page());
      `,
      loader: "tsx",
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
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
      "process.env.PAGES_BASE_PATH": JSON.stringify(basePath),
      "process.env.NEXT_PUBLIC_SITE_URL": '"https://lingko-ljx.github.io/chengchang-pickle-club/"',
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
  await client.getBootstrap("2026-08-09", {
    date: "2026-08-10",
    status: "pending",
    mode: "open",
    q: "Ada",
  });
  await client.listBookings({ date: "2026-08-09", status: "pending", mode: "open" });
  await client.mutateBooking("booking-1", "confirm", { expectedVersion: 2 });
  await client.setCourtEnabled("01", false, 3);
  await client.setSessionTemplateEnabled("mon-0900", true, 4);
  await client.getSettings();
  await client.getAuditLogs("booking-1");
  await client.getMatrixBookings("2026-08-09");
  await client.exportCsv("2026-08-01", "2026-08-31");
  await client.getHomepageMedia();
  await client.createMediaUploadIntent({
    kind: "image",
    mimeType: "image/webp",
    sizeBytes: 1024,
    originalName: "today.webp",
    title: "今日球场",
    altText: "匹克球场",
    expectedManifestVersion: 0,
  });
  await client.finalizeMediaUpload("media-1", 1, true);
  await client.setHomepageMediaPublished("media-1", false, 2);
  await client.setHomepageMediaPinned("media-1", true, 3);
  await client.deleteHomepageMedia("media-1", 4);

  assert.equal(requests.length, 16);
  const bootstrapUrl = new URL(requests[1].url);
  assert.equal(bootstrapUrl.pathname, "/v1/admin/bootstrap");
  assert.deepEqual(Object.fromEntries(bootstrapUrl.searchParams), {
    today: "2026-08-09",
    date: "2026-08-10",
    status: "pending",
    mode: "open",
    q: "Ada",
  });
  for (const request of requests) {
    assert.equal(request.init.headers.Authorization, "Bearer staff-access-token");
  }
  assert.equal(new URL(requests[10].url).pathname, "/v1/admin/homepage-media");
  assert.equal(new URL(requests[11].url).pathname, "/v1/admin/homepage-media/upload-intents");
  assert.equal(requests[11].init.method, "POST");
  assert.equal(requests[13].init.method, "PUT");
  assert.equal(new URL(requests[15].url).pathname, "/v1/admin/homepage-media/media-1/delete");
  assert.equal(requests[15].init.method, "POST");
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

test("login success is not rolled back when the first dashboard refresh fails", async () => {
  const { runAdminLoginFlow } = await import("../admin-client/login-flow.ts");
  const reportedMessages = [];
  for (const refreshError of [
    new Error("network details containing A_SECRET"),
    Object.assign(new Error("FORBIDDEN_INTERNAL_DETAIL"), { status: 403 }),
    Object.assign(new Error("DATABASE_INTERNAL_DETAIL"), { status: 500 }),
  ]) {
    const events = [];
    const result = await runAdminLoginFlow({
      async login() { events.push("login"); },
      onAuthenticated() { events.push("authenticated"); },
      async refresh() {
        events.push("refresh");
        throw refreshError;
      },
      async onAuthFailure() { events.push("clear-session-and-show-login"); },
      onRefreshFailure(message) {
        events.push(["refresh-failure", message]);
        reportedMessages.push(message);
      },
    });

    assert.equal(result, "refresh_failed");
    assert.deepEqual(events.slice(0, 3), ["login", "authenticated", "refresh"]);
    assert.equal(events.includes("clear-session-and-show-login"), false);
    assert.equal(events.at(-1)[0], "refresh-failure");
    assert.doesNotMatch(events.at(-1)[1], /A_SECRET|INTERNAL_DETAIL/);
  }
  assert.match(reportedMessages[0], /后台数据暂时加载失败/);
  assert.match(reportedMessages[1], /权限校验未通过（403）/);
  assert.match(reportedMessages[2], /后台服务暂时不可用（5xx）/);
  assert.equal(new Set(reportedMessages).size, 3);
});

test("an authentication failure still uses the single login-failure path", async () => {
  const { LOGIN_FAILED_MESSAGE, runAdminLoginFlow } = await import("../admin-client/login-flow.ts");
  const events = [];
  const result = await runAdminLoginFlow({
    async login() { throw new Error("raw identity-provider response"); },
    onAuthenticated() { events.push("authenticated"); },
    async refresh() { events.push("refresh"); },
    async onAuthFailure(message) { events.push(["auth-failure", message]); },
    onRefreshFailure(message) { events.push(["refresh-failure", message]); },
  });

  assert.equal(result, "auth_failed");
  assert.deepEqual(events, [["auth-failure", LOGIN_FAILED_MESSAGE]]);
});

test("a 401 during initial refresh remains owned by the API unauthorized handler", async () => {
  const { runAdminLoginFlow } = await import("../admin-client/login-flow.ts");
  const events = [];
  const result = await runAdminLoginFlow({
    async login() {},
    onAuthenticated() { events.push("authenticated"); },
    async refresh() {
      events.push("api-unauthorized-handler");
      throw Object.assign(new Error("AUTH_REQUIRED raw response"), { status: 401 });
    },
    async onAuthFailure() { events.push("auth-failure"); },
    onRefreshFailure() { events.push("refresh-failure"); },
  });

  assert.equal(result, "refresh_failed");
  assert.deepEqual(events, ["authenticated", "api-unauthorized-handler"]);
});

test("the admin entrypoint delegates login and initial refresh to the phased flow", async () => {
  const source = await readFile(new URL("../admin-client/index.ts", import.meta.url), "utf8");
  assert.match(source, /runAdminLoginFlow\s*\(\s*\{/);
});

test("the admin refresh performs one bootstrap API request", async () => {
  const source = await readFile(new URL("../admin-client/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const refresh = async () => {");
  const end = source.indexOf("\n  };", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const refresh = source.slice(start, end);
  assert.equal((refresh.match(/api\.getBootstrap\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(
    refresh,
    /api\.(?:getDashboard|listBookings|getMatrixBookings|getSettings)\s*\(/,
  );
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

test("the half-hour matrix uses interval overlap and excludes terminal bookings", () => {
  const current = {
    id: "current",
    date: "2026-08-12",
    sessionId: "window-a",
    startAt: "2026-08-12T01:30:00.000Z",
    endAt: "2026-08-12T03:30:00.000Z",
    courtId: "01",
    status: "confirmed",
  };
  const proposed = {
    id: "proposed",
    date: "2026-08-12",
    sessionId: "slot-old",
    startAt: "2026-08-12T00:00:00.000Z",
    endAt: "2026-08-12T01:00:00.000Z",
    courtId: "02",
    proposedStartAt: "2026-08-12T02:00:00.000Z",
    proposedEndAt: "2026-08-12T03:00:00.000Z",
    proposedCourtId: "01",
    status: "reschedule_proposed",
  };
  const cancelled = { ...current, id: "cancelled", status: "cancelled" };
  assert.deepEqual(
    matrixBookingsForCell(
      [current, proposed, cancelled],
      "2026-08-12",
      "10:00",
      "10:30",
      "01",
    ).map((item) => item.id),
    ["current", "proposed"],
  );
  assert.deepEqual(
    matrixBookingsForCell([current], "2026-08-12", "11:30", "12:00", "01"),
    [],
  );

  const currentStart = matrixAssignmentsForCell(
    [current, proposed],
    "2026-08-12",
    "09:30",
    "10:00",
    "01",
  );
  assert.deepEqual(
    currentStart.map(({ booking, kind, startsHere }) => ({ id: booking.id, kind, startsHere })),
    [{ id: "current", kind: "current", startsHere: true }],
  );

  const proposalStart = matrixAssignmentsForCell(
    [current, proposed],
    "2026-08-12",
    "10:00",
    "10:30",
    "01",
  );
  assert.deepEqual(
    proposalStart.map(({ booking, kind, startsHere, startAt, endAt, courtId }) => ({
      id: booking.id,
      kind,
      startsHere,
      startAt,
      endAt,
      courtId,
    })),
    [
      {
        id: "current",
        kind: "current",
        startsHere: false,
        startAt: current.startAt,
        endAt: current.endAt,
        courtId: "01",
      },
      {
        id: "proposed",
        kind: "proposed",
        startsHere: true,
        startAt: proposed.proposedStartAt,
        endAt: proposed.proposedEndAt,
        courtId: "01",
      },
    ],
  );
});

test("booking management API supports range pagination and the recoverable recycle bin", async () => {
  const requests = [];
  const client = createAdminApiClient({
    baseUrl: "https://booking-api.example.invalid",
    getAccessToken: () => "staff-access-token",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ items: [], nextCursor: null });
    },
    onUnauthorized() {},
  });

  await client.listBookings({
    from: "2026-08-01",
    to: "2026-08-31",
    status: "completed",
    mode: "private",
    q: "1380",
    archive: "archived",
    cursor: "next page",
    limit: 50,
  });
  await client.archiveBooking("booking/1", 7);
  await client.restoreBooking("booking/1", 8);
  await client.getCustomerHistory("booking/1", 50);

  const listUrl = new URL(requests[0].url);
  assert.equal(listUrl.pathname, "/v1/admin/bookings");
  assert.deepEqual(Object.fromEntries(listUrl.searchParams), {
    from: "2026-08-01",
    to: "2026-08-31",
    status: "completed",
    mode: "private",
    q: "1380",
    archive: "archived",
    cursor: "next page",
    limit: "50",
  });
  assert.equal(new URL(requests[1].url).pathname, "/v1/admin/bookings/booking%2F1/archive");
  assert.equal(requests[1].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[1].init.body), { expectedVersion: 7 });
  assert.equal(new URL(requests[2].url).pathname, "/v1/admin/bookings/booking%2F1/restore");
  assert.equal(requests[2].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[2].init.body), { expectedVersion: 8 });
  assert.equal(new URL(requests[3].url).pathname, "/v1/admin/bookings/booking%2F1/customer-history");
  assert.equal(new URL(requests[3].url).searchParams.get("limit"), "50");
});

test("booking pages normalize both the paginated and legacy list contracts", () => {
  const booking = { id: "booking-1" };
  assert.deepEqual(normalizeBookingPage([booking]), {
    items: [booking],
    nextCursor: null,
    hasMore: false,
  });
  assert.deepEqual(normalizeBookingPage({ items: [booking], nextCursor: "cursor-2" }), {
    items: [booking],
    nextCursor: "cursor-2",
    hasMore: true,
  });
});

test("record management never presents permanent deletion and restores archived records", () => {
  assert.deepEqual(bookingRecordActionsFor({ status: "pending" }), []);
  assert.deepEqual(bookingRecordActionsFor({ status: "cancelled" }), [
    ["archive", "删除记录"],
  ]);
  assert.deepEqual(bookingRecordActionsFor({ status: "completed" }), [
    ["archive", "删除记录"],
  ]);
  assert.deepEqual(bookingRecordActionsFor({ status: "cancelled", archivedAt: "2026-08-12T01:00:00.000Z" }), [
    ["restore", "恢复记录"],
  ]);
  assert.deepEqual(
    bookingRecordActionsFor({ status: "pending", archivedAt: "2026-08-12T01:00:00.000Z" }),
    [["restore", "恢复记录"]],
  );
  assert.equal(statusLabel("reschedule_proposed"), "等待改期答复");
  assert.equal(statusLabel("unknown"), "未知状态");
});

test("record ranges keep every search and recycle-bin query bounded", () => {
  assert.deepEqual(recordDateRange("2026-08-12", "30"), {
    from: "2026-07-14",
    to: "2026-08-12",
  });
  assert.deepEqual(recordDateRange("2026-08-12", "all"), {
    from: "2026-01-01",
    to: "2026-08-12",
  });
  assert.deepEqual(recordDateRange("2026-08-12", "today"), {
    from: "2026-08-12",
    to: "2026-08-12",
  });
});

test("customer history is loaded through the selected booking, never a phone-number URL", async () => {
  const source = await readFile(new URL("../admin-client/index.ts", import.meta.url), "utf8");
  const renderSource = await readFile(new URL("../admin-client/render.ts", import.meta.url), "utf8");
  assert.match(source, /api\.getCustomerHistory\(bookingId, 50\)/);
  assert.doesNotMatch(source, /customer-history[^\n]*phone/);
  assert.match(renderSource, /正在读取该客人的历史记录/);
});

test("admin page exposes scalable booking controls and a customer history surface", async () => {
  const html = await renderAdminPage();
  assert.match(html, /id="admin-record-view-active"/);
  assert.match(html, /id="admin-record-view-archived"/);
  assert.match(html, /id="admin-filter-from"/);
  assert.match(html, /id="admin-filter-to"/);
  assert.match(html, /id="admin-load-more"/);
  assert.match(html, /id="admin-customer-history"/);
  assert.match(html, /可移入回收站/);
  assert.doesNotMatch(html, /永久删除预约/);
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

test("admin booking and audit instants render in Asia/Shanghai instead of raw UTC", () => {
  assert.equal(
    formatShanghaiDateTime("2026-08-13T23:00:00.000Z"),
    "2026-08-14 07:00",
  );
  assert.equal(
    formatShanghaiDateTimeRange(
      "2026-08-13T23:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
    ),
    "2026-08-14 07:00–08:00",
  );
  assert.equal(formatShanghaiDateTime("not-an-instant"), "时间不可用");
  assert.equal(formatShanghaiDateTime("2026-08-14T07:00:00"), "时间不可用");
  assert.equal(formatShanghaiBookingSchedule({
    date: "2026-08-14",
    startAt: "2026-08-13T23:00:00.000Z",
    endAt: "2026-08-14T00:00:00.000Z",
  }), "2026-08-14 07:00–08:00");
  assert.equal(formatShanghaiBookingSchedule({
    date: "2026-08-13",
    startAt: "2026-08-13T23:00:00.000Z",
    endAt: "2026-08-14T00:00:00.000Z",
  }), "时间数据异常");
});

test("booking cards calculate whole billable hours from the real interval", () => {
  assert.equal(bookingDurationHours({
    startAt: "2026-08-12T01:30:00.000Z",
    endAt: "2026-08-12T03:30:00.000Z",
  }), 2);
});

test("homepage media that failed while deleting still exposes a retry action", () => {
  assert.deepEqual(
    homepageMediaActionsFor({ status: "deleting" }).map(([action]) => action),
    ["delete"],
  );
});

test("booking cards lead with the customer name and use a redacted fallback", async () => {
  assert.equal(bookingDisplayName({ name: "刘栖睿" }), "刘栖睿");
  assert.equal(bookingDisplayName({ name: "  毛之谦  " }), "毛之谦");
  assert.equal(bookingDisplayName({}), "已脱敏预约");
  assert.equal(bookingDisplayName({ name: "   " }), "已脱敏预约");

  const source = await readFile(new URL("../admin-client/render.ts", import.meta.url), "utf8");
  assert.match(source, /text\("strong", bookingDisplayName\(booking\)\)/);
  const cardSource = source.slice(
    source.indexOf("function bookingButton"),
    source.indexOf("export function renderPendingQueue"),
  );
  assert.doesNotMatch(cardSource, /预约号/);
  assert.match(cardSource, /北京时间/);
  const detailName = source.indexOf('text("h3", bookingDisplayName(booking))');
  const detailCode = source.indexOf(
    'text("p", `预约号 ${booking.code}`, "admin-detail-code")',
    detailName,
  );
  assert.notEqual(detailName, -1);
  assert.ok(detailCode > detailName);
});

test("booking actions expose only valid core actions for each status", () => {
  assert.deepEqual(BOOKING_ACTIONS, [
    ["confirm", "确认预约"],
    ["cancel", "取消预约"],
    ["complete", "完结预约"],
  ]);
  assert.deepEqual(bookingActionsFor({ status: "pending" }), [
    ["confirm", "确认预约"],
    ["cancel", "取消预约"],
  ]);
  assert.deepEqual(bookingActionsFor({ status: "confirmed" }), [
    ["complete", "完结预约"],
    ["cancel", "取消预约"],
  ]);
  assert.deepEqual(bookingActionsFor({ status: "cancelled" }), []);
  assert.deepEqual(bookingActionsFor({ status: "completed" }), []);
  assert.deepEqual(
    bookingActionsFor({
      status: "cancelled",
      personalDataRedactedAt: "2026-08-11T14:00:00.000Z",
    }),
    [],
  );
  assert.deepEqual(bookingActionsFor({ status: "reschedule_proposed" }), [
    ["cancel", "取消预约"],
  ]);
});

test("refresh retains the selected booking when a status filter removes it", () => {
  const selected = { id: "booking-1", status: "pending", version: 1 };
  const refreshed = { id: "booking-1", status: "confirmed", version: 2 };
  assert.equal(retainSelectedBooking(selected, [refreshed]), refreshed);
  assert.equal(retainSelectedBooking(selected, []), selected);
  assert.equal(retainSelectedBooking(null, [refreshed]), null);
});

test("admin mutation UI has an in-flight state and reports success before best-effort refresh", async () => {
  const source = await readFile(new URL("../admin-client/index.ts", import.meta.url), "utf8");
  assert.match(source, /let activeAction: string \| null = null/);
  assert.match(source, /button\.disabled = activeAction !== null/);
  assert.match(source, /activeAction === action \? `\$\{label\}处理中…` : label/);
  assert.match(source, /await api\.mutateBooking/);
  assert.match(source, /await api\.archiveBooking/);
  assert.match(source, /await api\.restoreBooking/);
  assert.doesNotMatch(source, /personalDataRedactedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(source, /列表未能自动刷新/);
});

test("staff login uses the v2 auth contract and keeps its token in closure", async () => {
  const operations = [];
  let privateStorage;
  const session = createAuthenticatedSession({
    auth(options) {
      privateStorage = options.storage;
      operations.push(["auth", options.persistence]);
      return {
        async signIn(input) {
          operations.push(["signIn", input]);
          return { user: { uid: "staff-user" } };
        },
        async getAccessToken() {
          operations.push(["getAccessToken"]);
          return { accessToken: "private-access-token", env: "booking-test-000000" };
        },
        async signOut() {
          operations.push(["signOut"]);
        },
      };
    },
  });

  await session.login("staff-user", "staff-password");
  assert.deepEqual(operations, [
    ["auth", "none"],
    ["signIn", { username: "staff-user", password: "staff-password" }],
    ["getAccessToken"],
  ]);
  assert.equal(session.getAccessToken(), "private-access-token");
  assert.equal(typeof privateStorage.getItemSync, "function");
  privateStorage.setItemSync("credentials_test", "private-access-token");
  await session.clear();
  assert.equal(session.getAccessToken(), "");
  assert.equal(privateStorage.getItemSync("credentials_test"), null);
  assert.deepEqual(operations.at(-1), ["signOut"]);
  assert.equal("accessToken" in session, false);
});

test("private auth injects one memory store at init and auth boundaries", () => {
  const trace = [];
  const auth = {
    async signIn() { return { user: { uid: "staff" } }; },
    async getAccessToken() { return { accessToken: "token", env: "booking-test" }; },
    async signOut() {},
  };
  initializePrivateAuth({
    init(options) {
      trace.push(["init", options]);
      return {
        auth(authOptions) {
          trace.push(["auth", authOptions]);
          return auth;
        },
      };
    },
  }, "booking-test");
  assert.equal(trace[0][1].persistence, "none");
  assert.equal(trace[1][1].persistence, "none");
  assert.equal(trace[0][1].storage, trace[1][1].storage);
  assert.notEqual(trace[0][1].storage, globalThis.localStorage);
  assert.notEqual(trace[0][1].storage, globalThis.sessionStorage);
});

test("auth rejects malformed SDK states and clears memory even when signOut reports an error", async () => {
  const storageValues = [];
  const app = (signInResult, tokenResult, signOutResult) => ({
    auth(options) {
      storageValues.push(options.storage);
      return {
        async signIn() { return signInResult; },
        async getAccessToken() { return tokenResult; },
        async signOut() { return signOutResult; },
      };
    },
  });
  await assert.rejects(
    () => createAuthenticatedSession(app(null, { accessToken: "x", env: "e" })).login("u", "p"),
    /AUTH_REQUIRED/,
  );
  await assert.rejects(
    () => createAuthenticatedSession(app({ user: undefined }, { accessToken: "x", env: "e" })).login("u", "p"),
    /AUTH_REQUIRED/,
  );
  await assert.rejects(
    () => createAuthenticatedSession(app({ user: {} }, { accessToken: "", env: "e" })).login("u", "p"),
    /AUTH_REQUIRED/,
  );
  const session = createAuthenticatedSession(app({ user: {} }, { accessToken: "x", env: "e" }, { error: "failed" }));
  await session.login("u", "p");
  storageValues.at(-1).setItemSync("credentials_test", "x");
  await assert.rejects(() => session.clear(), /AUTH_SIGN_OUT_FAILED/);
  assert.equal(storageValues.at(-1).getItemSync("credentials_test"), null);
  assert.equal(session.getAccessToken(), "");
});

test("the installed SDK private-auth wrapper never touches browser credential stores", async () => {
  const calls = [];
  const browserStore = (name) => ({
    getItem(key) { calls.push([name, "get", key]); return null; },
    setItem(key, value) { calls.push([name, "set", key, value]); },
    removeItem(key) { calls.push([name, "remove", key]); },
  });
  const names = ["localStorage", "sessionStorage", "window", "navigator", "XMLHttpRequest"];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const localStorage = browserStore("local");
  const sessionStorage = browserStore("session");
  class XMLHttpRequest {
    open() {}
    setRequestHeader() {}
    send() {}
  }
  const navigator = { userAgent: "node-sdk-contract" };
  const window = {
    localStorage,
    sessionStorage,
    navigator,
    XMLHttpRequest,
    location: { protocol: "https:", host: "localhost", href: "https://localhost/" },
  };
  for (const [name, value] of Object.entries({ localStorage, sessionStorage, window, navigator, XMLHttpRequest })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  try {
    const sdk = createRequire(import.meta.url)("@cloudbase/js-sdk");
    const storage = createMemoryAuthStorage();
    const app = sdk.init({ env: "booking-test-storage-spy", persistence: "none", storage });
    const auth = app.auth({ persistence: "none", storage });
    await auth.setCredentials({
      access_token: "A_SECRET",
      refresh_token: "R_SECRET",
      expires_in: 3600,
    });
    assert.deepEqual(await auth.getAccessToken(), {
      accessToken: "A_SECRET",
      env: "booking-test-storage-spy",
    });
    assert.equal(calls.some((call) => /credentials_/i.test(String(call[2]))), false);
    assert.equal(calls.some((call) => call.some((value) => /A_SECRET|R_SECRET/.test(String(value)))), false);
  } finally {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("refresh keeps today, matrix, filters and selected audit history independent", async () => {
  const source = await readFile(new URL("../admin-client/index.ts", import.meta.url), "utf8");
  assert.match(source, /api\.getBootstrap\(today,/);
  assert.doesNotMatch(source, /bookings\s*=\s*bootstrap\.bookings/);
  assert.match(source, /if \(selected\) await Promise\.all\(\[loadSelectedAudits\(\), loadSelectedCustomerHistory\(\)\]\)/);
  assert.doesNotMatch(source, /admin-template-(?:start|version)/);
  assert.doesNotMatch(await readFile(new URL("../admin-client/render.ts", import.meta.url), "utf8"), /`提交 · \$\{booking\.createdAt\}`/);
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
  assert.match(html, /睿安成 STAFF/);
  assert.doesNotMatch(html, /CHENGCHANG STAFF/);
  assert.match(html, /id="admin-login-form"/);
  assert.match(html, /<div\b(?=[^>]*\bid="admin-dashboard")(?=[^>]*\bhidden(?:="")?)[^>]*>/);
  assert.match(html, /data-cloudbase-env-id="booking-test-000000"/);
  assert.match(html, /data-api-base-url="https:\/\/booking-api\.example\.invalid"/);
  assert.match(html, /data-site-base-path="\/chengchang-pickle-club"/);
  assert.match(html, /data-admin-client="true"/);
  assert.match(html, /src="\/chengchang-pickle-club\/admin-app\.js"/);
  assert.match(html, /09:00–22:00/);
  assert.match(html, /30 分钟/);
  assert.match(html, /id="admin-save-courts"/);
  assert.doesNotMatch(html, /admin-template-controls|60 分钟场次模板/);
  assert.match(html, /id="admin-media-upload-form"/);
  assert.match(html, /id="admin-media-file"/);
  assert.match(html, /id="admin-media-list"/);
  assert.match(html, /首页宣传/);
  const altInput = html.match(/<input(?=[^>]*id="admin-media-alt")[^>]*>/)?.[0] ?? "";
  assert.ok(altInput);
  assert.doesNotMatch(altInput, /\brequired\b/);
});

test("record actions use the selected booking context and successful moves update immediately", async () => {
  const source = await readFile(new URL("../admin-client/index.ts", import.meta.url), "utf8");
  const onSelect = source.slice(source.indexOf("  const onSelect ="), source.indexOf("  const renderSettings ="));
  const actions = source.slice(source.indexOf("  function renderActions()"), source.indexOf("  loginForm.addEventListener"));
  assert.doesNotMatch(onSelect, /recordView\s*=/);
  assert.match(actions, /const selectedView(?:: BookingRecordView)? = selected\.archivedAt \? "archived" : "active"/);
  assert.match(actions, /bookingRecordActionsFor\(selected\)/);
  assert.doesNotMatch(actions, /bookingRecordActionsFor\(selected, recordView\)/);
  const mutation = source.slice(source.indexOf("  async function runBookingAction"), source.indexOf("  function renderActions"));
  const removal = mutation.indexOf("bookings = bookings.filter");
  const refresh = mutation.indexOf("await refresh()");
  assert.ok(removal > -1 && refresh > removal, "the current page must update before background refresh");
});

test("record reset, all-history and mobile controls remain safe at scale", async () => {
  const source = await readFile(new URL("../admin-client/index.ts", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(source, /applyRecordRange\("30"\)/);
  assert.match(source, /recordDateRange\(shanghaiDate\(\), preset\)/);
  assert.doesNotMatch(source, /days === "all"[\s\S]{0,120}from\.value = ""/);
  assert.match(css, /\.admin-record-results \.admin-booking-list\s*\{[^}]*max-height:\s*62dvh/s);
  assert.match(css, /\.admin-page (?:input|input,)[\s\S]{0,160}font-size:\s*16px/s);
});

test("the server rejects unsafe and dot-segment Pages base paths before emitting a script URL", async () => {
  for (const basePath of ["//evil.example/x", "/.", "/..", "/safe/./admin", "/safe/../admin"]) {
    await assert.rejects(() => renderAdminPage(basePath), /PAGES_BASE_PATH/, basePath);
  }
});
