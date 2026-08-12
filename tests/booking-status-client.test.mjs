import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

async function readClient(name) {
  return readFile(new URL(`../public/${name}.js`, import.meta.url), "utf8");
}

function eventTarget(properties = {}) {
  const listeners = {};
  return {
    ...properties,
    addEventListener(name, handler) {
      listeners[name] = handler;
    },
    fire(name, event = {}) {
      if (listeners[name]) listeners[name](event);
    },
  };
}

test("booking result and status clients parse as ES5", async () => {
  const sources = await Promise.all([
    readClient("booking-result"),
    readClient("booking-status"),
  ]);

  for (const source of sources) {
    assert.doesNotThrow(() => parse(source, { ecmaVersion: 5 }));
    assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage/);
  }
});

test("result client shows the phone suffix while keeping the unique code as a security credential", async () => {
  const source = await readClient("booking-result");
  const displayCode = { textContent: "" };
  const secureCode = { textContent: "" };
  const link = { href: "" };
  const shell = {
    getAttribute(name) {
      assert.equal(name, "data-site-base-path");
      return "/chengchang-pickle-club";
    },
  };

  vm.runInNewContext(source, {
    decodeURIComponent,
    document: {
      getElementById(id) {
        return {
          "booking-result-code": displayCode,
          "booking-result-secure-code": secureCode,
          "booking-result-shell": shell,
          "booking-result-status-link": link,
        }[id] ?? null;
      },
    },
    encodeURIComponent,
    window: {
      location: {
        search:
          "?code=BOOK%2F42&name=Private&phone=13800138000&email=p%40example.com",
        hash: "#display_code=8000",
      },
    },
  });

  assert.equal(displayCode.textContent, "8000");
  assert.equal(secureCode.textContent, "BOOK/42");
  assert.equal(
    link.href,
    "/chengchang-pickle-club/booking/status/?code=BOOK%2F42",
  );
  assert.doesNotMatch(link.href, /Private|13800138000|example/);
});

test("malformed query keys cannot stop either client from finding a valid code", async () => {
  const resultSource = await readClient("booking-result");
  const statusSource = await readClient("booking-status");
  const resultCode = { textContent: "" };
  const resultLink = { href: "" };

  assert.doesNotThrow(() =>
    vm.runInNewContext(resultSource, {
      decodeURIComponent,
      document: {
        getElementById(id) {
          return {
            "booking-result-code": resultCode,
            "booking-result-secure-code": { textContent: "" },
            "booking-result-shell": { getAttribute: () => "" },
            "booking-result-status-link": resultLink,
          }[id] ?? null;
        },
      },
      encodeURIComponent,
      window: { location: { search: "?%=bad&code=BOOK-42", hash: "#display_code=0042" } },
    }),
  );
  assert.equal(resultCode.textContent, "0042");

  let statusPage;
  assert.doesNotThrow(() => {
    statusPage = loadStatusClient(statusSource, {
      code: "",
      search: "?%=bad&code=BOOK-42",
    });
  });
  assert.equal(statusPage.elements["booking-status-code"].value, "BOOK-42");
});

function element(properties = {}) {
  const node = eventTarget({
    children: [],
    disabled: false,
    hidden: false,
    textContent: "",
    value: "",
    ...properties,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children.splice(this.children.indexOf(child), 1);
      return child;
    },
  });
  Object.defineProperty(node, "firstChild", {
    get() {
      return this.children[0] ?? null;
    },
  });
  return node;
}

function loadStatusClient(source, options = {}) {
  const requests = [];
  const elements = {
    "booking-status-shell": element({
      getAttribute(name) {
        const values = {
          "data-api-base-url": options.apiBaseUrl ?? "https://booking.example/api",
          "data-site-base-path": "/chengchang-pickle-club",
        };
        return values[name] ?? null;
      },
    }),
    "booking-status-form": element({
      checkValidity() {
        return options.valid !== false;
      },
    }),
    "booking-status-code": element({ value: options.code ?? "BOOK-42" }),
    "booking-status-phone": element({ value: options.phone ?? "13800138000" }),
    "booking-status-message": element({ hidden: true }),
    "booking-status-result": element({ hidden: true }),
    "booking-status-value": element(),
    "booking-status-session": element(),
    "booking-status-mode": element(),
    "booking-status-party-size": element(),
    "booking-status-contact": element(),
    "booking-status-timeline": element(),
    "booking-status-proposed": element({ hidden: true }),
    "booking-status-cancel": element({ hidden: true }),
    "booking-status-accept": element({ hidden: true }),
    "booking-status-reject": element({ hidden: true }),
  };

  function XMLHttpRequest() {
    this.headers = {};
    requests.push(this);
  }
  XMLHttpRequest.prototype.open = function (method, url) {
    this.method = method;
    this.url = url;
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    this.headers[name] = value;
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.body = body;
  };
  XMLHttpRequest.prototype.respond = function (status, body) {
    this.status = status;
    this.responseText = body;
    this.readyState = 4;
    this.onreadystatechange();
  };
  XMLHttpRequest.prototype.fail = function () {
    this.onerror();
  };

  vm.runInNewContext(source, {
    Date,
    document: {
      createElement() {
        return element();
      },
      getElementById(id) {
        return elements[id] ?? null;
      },
    },
    encodeURIComponent,
    window: {
      JSON,
      XMLHttpRequest,
      location: { search: options.search ?? "" },
    },
    XMLHttpRequest,
  });

  return { elements, request: (index = 0) => requests[index], requests };
}

function lookup(page) {
  let prevented = false;
  page.elements["booking-status-form"].fire("submit", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  return page.request();
}

const bookingFixture = {
  actionVersion: 7,
  canCancel: true,
  canCancelUntil: "2099-08-11T00:00:00.000Z",
  code: "BOOK-42",
  date: "2026-08-12",
  email: "must-not-render@example.com",
  endTime: "10:00",
  mode: "open",
  name: "林*",
  partySize: 3,
  phone: "138****8000",
  proposed: {
    date: "2026-08-13",
    endTime: "11:00",
    startTime: "10:00",
  },
  startTime: "09:00",
  status: "reschedule_proposed",
};

test("status lookup sends code and full phone then renders only masked public data", async () => {
  const source = await readClient("booking-status");
  const page = loadStatusClient(source);
  const request = lookup(page);

  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://booking.example/api/v1/bookings/lookup");
  assert.equal(request.headers.Accept, "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    code: "BOOK-42",
    phone: "13800138000",
  });

  request.respond(200, JSON.stringify({ data: bookingFixture }));

  assert.equal(page.elements["booking-status-phone"].value, "");
  assert.equal(page.elements["booking-status-result"].hidden, false);
  assert.equal(page.elements["booking-status-value"].textContent, "等待确认改期");
  assert.match(page.elements["booking-status-session"].textContent, /1 小时，北京时间/);
  assert.match(page.elements["booking-status-session"].textContent, /09:00/);
  assert.equal(page.elements["booking-status-mode"].textContent, "散客拼场");
  assert.equal(page.elements["booking-status-party-size"].textContent, "3 人");
  assert.equal(page.elements["booking-status-contact"].textContent, "林* · 138****8000");
  assert.doesNotMatch(
    Object.values(page.elements).map((node) => node.textContent).join(" "),
    /13800138000|must-not-render/,
  );
  assert.ok(page.elements["booking-status-timeline"].children.length >= 2);
  assert.equal(page.elements["booking-status-proposed"].hidden, false);
  assert.equal(page.elements["booking-status-cancel"].hidden, false);
  assert.equal(page.elements["booking-status-accept"].hidden, false);
  assert.equal(page.elements["booking-status-reject"].hidden, false);
});

test("customer actions retain the verified phone only in memory and carry action version", async () => {
  const source = await readClient("booking-status");
  const page = loadStatusClient(source);
  lookup(page).respond(200, JSON.stringify({ data: bookingFixture }));

  page.elements["booking-status-cancel"].fire("click");
  assert.equal(
    page.request(1).url,
    "https://booking.example/api/v1/bookings/BOOK-42/cancel",
  );
  assert.deepEqual(JSON.parse(page.request(1).body), {
    code: "BOOK-42",
    expectedVersion: 7,
    phone: "13800138000",
  });

  page.request(1).respond(409, JSON.stringify({ error: { code: "CONFLICT" } }));
  assert.match(page.elements["booking-status-message"].textContent, /重新查询/);

  page.elements["booking-status-phone"].value = "13800138000";
  lookup(page).respond(200, JSON.stringify({ data: bookingFixture }));
  page.elements["booking-status-accept"].fire("click");
  assert.equal(
    page.request(3).url,
    "https://booking.example/api/v1/bookings/BOOK-42/reschedule-response",
  );
  assert.deepEqual(JSON.parse(page.request(3).body), {
    accept: true,
    code: "BOOK-42",
    expectedVersion: 7,
    phone: "13800138000",
  });

  page.elements["booking-status-reject"].fire("click");
  assert.equal(JSON.parse(page.request(4).body).accept, false);
});

test("expired cancellation, missing configuration and rate limits fail safely", async () => {
  const source = await readClient("booking-status");
  const expired = loadStatusClient(source);
  lookup(expired).respond(
    200,
    JSON.stringify({
      data: { ...bookingFixture, canCancelUntil: "2000-01-01T00:00:00.000Z" },
    }),
  );
  assert.equal(expired.elements["booking-status-cancel"].hidden, true);

  const unavailable = loadStatusClient(source, { apiBaseUrl: "" });
  assert.equal(unavailable.requests.length, 0);
  assert.equal(unavailable.elements["booking-status-form"].hidden, true);
  assert.match(
    unavailable.elements["booking-status-message"].textContent,
    /查询服务暂不可用/,
  );

  const limited = loadStatusClient(source);
  lookup(limited).respond(429, JSON.stringify({ error: { code: "RATE_LIMITED" } }));
  assert.match(limited.elements["booking-status-message"].textContent, /稍后再试/);
  assert.doesNotMatch(limited.elements["booking-status-message"].textContent, /存在|不存在/);
});
