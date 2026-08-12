import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

import { createPublicApiHandler } from "../cloudbase/src/public-api.ts";

const DATE = "2026-08-12";

function booking(overrides = {}) {
  return {
    id: "private-booking-id",
    code: "PRIVATE-CODE",
    date: DATE,
    startAt: "2026-08-12T01:00:00.000Z",
    endAt: "2026-08-12T02:00:00.000Z",
    mode: "open",
    partySize: 2,
    status: "confirmed",
    name: "刘栖睿",
    phone: "13800138000",
    phoneHash: "private-phone-hash",
    email: "private@example.com",
    note: "private note",
    courtId: "01",
    version: 4,
    publicScheduleConsentVersion: 1,
    publicScheduleConsentAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function handlerFor(service) {
  return createPublicApiHandler({
    service,
    rateLimiter: { consume: async () => true },
    now: () => new Date("2026-08-12T00:00:00.000Z"),
    allowedOrigins: "https://example.test",
    resultUrl: "https://example.test/booking/result/",
    idempotencySalt: "public-schedule-test",
  });
}

function event(date = DATE) {
  return {
    httpMethod: "GET",
    path: "/v1/public-schedule",
    headers: { origin: "https://example.test" },
    queryStringParameters: { date },
  };
}

test("public schedule returns only active, masked, public-safe fields", async () => {
  const calls = [];
  const response = await handlerFor({
    async listPublicSchedule(date) {
      calls.push(date);
      return [
        booking(),
        booking({
          id: "latin",
          code: "OTHER-CODE",
          startAt: "2026-08-12T02:30:00.000Z",
          endAt: "2026-08-12T04:30:00.000Z",
          mode: "private",
          partySize: 3,
          name: "Ada Lovelace",
          status: "reschedule_proposed",
        }),
        booking({
          id: "staff-reservation",
          bookingKind: "staff_reservation",
          staffReservationTitle: "某单位内部活动",
          startAt: "2026-08-12T05:00:00.000Z",
          endAt: "2026-08-12T06:00:00.000Z",
          partySize: 4,
          name: undefined,
          phone: undefined,
          status: "confirmed",
        }),
        booking({
          id: "legacy-no-public-consent",
          publicScheduleConsentVersion: undefined,
          publicScheduleConsentAt: undefined,
          name: "历史真名不应出现",
        }),
        booking({
          id: "proposal-other-date",
          date: "2026-08-11",
          proposedDate: DATE,
          proposedStartAt: "2026-08-12T07:00:00.000Z",
          proposedEndAt: "2026-08-12T08:00:00.000Z",
          status: "reschedule_proposed",
          name: "改期记录不应错误投影",
        }),
        booking({ id: "cancelled", status: "cancelled", name: "不应出现" }),
        booking({ id: "completed", status: "completed", name: "也不应出现" }),
        booking({ id: "archived", archivedAt: "2026-08-12T07:00:00.000Z", name: "归档记录" }),
      ];
    },
  })(event());

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [DATE]);
  assert.deepEqual(JSON.parse(response.body), {
    data: {
      date: DATE,
      bookingCount: 4,
      participantCount: 7,
      staffReservationCount: 1,
      items: [
        {
          name: "匿名球友",
          startTime: "09:00",
          endTime: "10:00",
          kind: "customer",
          partySize: 2,
          mode: "open",
          status: "active",
        },
        {
          name: "刘**",
          startTime: "09:00",
          endTime: "10:00",
          kind: "customer",
          partySize: 2,
          mode: "open",
          status: "active",
        },
        {
          name: "A**",
          startTime: "10:30",
          endTime: "12:30",
          kind: "customer",
          partySize: 3,
          mode: "private",
          status: "active",
        },
        {
          name: "单位包场",
          startTime: "13:00",
          endTime: "14:00",
          kind: "staff_reservation",
          mode: "private",
          status: "active",
        },
      ],
    },
  });
  for (const privateValue of [
    "private-booking-id",
    "PRIVATE-CODE",
    "13800138000",
    "private-phone-hash",
    "private@example.com",
    "private note",
    "某单位内部活动",
    "01",
    "不应出现",
    "也不应出现",
    "归档记录",
    "历史真名不应出现",
    "改期记录不应错误投影",
  ]) {
    assert.equal(response.body.includes(privateValue), false, privateValue);
  }
});

test("public schedule validates a real Beijing calendar date before reading bookings", async () => {
  let calls = 0;
  const handler = handlerFor({
    async listPublicSchedule() {
      calls += 1;
      return [];
    },
  });
  for (const invalid of ["", "2026-02-29", "2026-08-32"]) {
    const response = await handler(event(invalid));
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error.code, "INVALID_INPUT");
  }
  assert.equal(calls, 0);
});

test("public schedule rate limits abusive anonymous refreshes before repository reads", async () => {
  let reads = 0;
  const response = await createPublicApiHandler({
    service: {
      async listPublicSchedule() {
        reads += 1;
        return [];
      },
    },
    rateLimiter: {
      async consume(request) {
        assert.deepEqual(request, {
          scope: "public-schedule-ip",
          key: "anonymous",
          limit: 60,
          windowMs: 10 * 60 * 1000,
        });
        return false;
      },
    },
    now: () => new Date("2026-08-12T00:00:00.000Z"),
    allowedOrigins: "https://example.test",
    resultUrl: "https://example.test/booking/result/",
    idempotencySalt: "public-schedule-test",
  })(event());
  assert.equal(response.statusCode, 429);
  assert.equal(reads, 0);
});

test("public schedule browser client parses as ES5 and never renders server text as HTML", async () => {
  const source = await readFile(new URL("../public/public-schedule.js", import.meta.url), "utf8");
  assert.doesNotThrow(() => parse(source, { ecmaVersion: 5 }));
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);

  const listeners = {};
  const root = {
    getAttribute: () => "https://api.example.test/v1/public-schedule",
  };
  const dateInput = {
    value: "2026-08-13",
    addEventListener(name, listener) {
      listeners[name] = listener;
    },
  };
  const summary = { textContent: "" };
  const status = { textContent: "" };
  const list = {
    children: [],
    textContent: "",
    appendChild(child) {
      this.children.push(child);
    },
  };
  const requests = [];
  function XMLHttpRequest() {
    requests.push(this);
  }
  XMLHttpRequest.prototype.open = function (method, url) {
    this.method = method;
    this.url = url;
  };
  XMLHttpRequest.prototype.setRequestHeader = function () {};
  XMLHttpRequest.prototype.send = function () {};
  XMLHttpRequest.prototype.respond = function (statusCode, body) {
    this.status = statusCode;
    this.responseText = body;
    this.readyState = 4;
    this.onreadystatechange();
  };
  function element(tagName) {
    return {
      tagName,
      children: [],
      className: "",
      textContent: "",
      appendChild(child) {
        this.children.push(child);
      },
    };
  }
  vm.runInNewContext(source, {
    Date,
    XMLHttpRequest,
    document: {
      createElement: element,
      getElementById(id) {
        return {
          "booking-date": dateInput,
          "public-schedule": root,
          "public-schedule-list": list,
          "public-schedule-status": status,
          "public-schedule-summary": summary,
        }[id] ?? null;
      },
    },
    window: { JSON, XMLHttpRequest },
  });

  assert.match(requests[0].url, /\?date=\d{4}-\d{2}-\d{2}$/);
  dateInput.value = DATE;
  listeners.change();
  assert.equal(requests[1].url, `https://api.example.test/v1/public-schedule?date=${DATE}`);
  requests[1].respond(200, JSON.stringify({
    data: {
      date: DATE,
      bookingCount: 1,
      participantCount: 2,
      staffReservationCount: 0,
      items: [{
        name: "<img src=x onerror=alert(1)>",
        startTime: "09:00",
        endTime: "10:00",
        kind: "customer",
        mode: "open",
        partySize: 2,
        status: "active",
      }],
    },
  }));
  assert.match(summary.textContent, /1 场.*2 位/);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].textContent, "<img src=x onerror=alert(1)>");
});
