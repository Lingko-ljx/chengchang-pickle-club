import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

async function readEnhancement() {
  return readFile(new URL("../public/booking-form.js", import.meta.url), "utf8");
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
    listener(name) {
      return listeners[name];
    },
  };
}

function option(value, text, sessionId = "") {
  const attributes = {};
  if (sessionId) attributes["data-session-id"] = sessionId;
  return {
    text,
    value,
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    setAttribute(name, attributeValue) {
      attributes[name] = String(attributeValue);
    },
  };
}

function selectControl(name, value, initialOptions) {
  const control = eventTarget({
    disabled: false,
    name,
    options: [...initialOptions],
    type: "select-one",
    value,
    add(entry) {
      this.options.push(entry);
    },
    remove(index) {
      this.options.splice(index, 1);
    },
  });
  return control;
}

function createStorage(options = {}) {
  const values = new Map();
  let removeCount = 0;
  return {
    getItem(key) {
      if (options.storageThrows) throw new Error("storage unavailable");
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (options.storageThrows) throw new Error("storage unavailable");
      values.set(key, String(value));
    },
    removeItem(key) {
      if (options.storageThrows) throw new Error("storage unavailable");
      removeCount += 1;
      values.delete(key);
    },
    peek() {
      return [...values.values()][0];
    },
    removeCount() {
      return removeCount;
    },
  };
}

function loadEnhancement(source, options = {}) {
  const fallbackOptions = [
    option("", "请选择时段"),
    option("07:00", "07:00"),
    option("08:00", "08:00"),
    option("09:00", "09:00"),
  ];
  const modeOpen = eventTarget({
    checked: options.mode !== "private",
    disabled: false,
    name: "mode",
    type: "radio",
    value: "open",
  });
  const modePrivate = eventTarget({
    checked: options.mode === "private",
    disabled: false,
    name: "mode",
    type: "radio",
    value: "private",
  });
  const date = eventTarget({
    disabled: false,
    name: "date",
    type: "date",
    value: options.date ?? "",
  });
  const startTime = selectControl("start_time", options.startTime ?? "07:00", fallbackOptions);
  const sessionId = eventTarget({
    disabled: false,
    name: "session_id",
    type: "hidden",
    value: "",
  });
  const partySize = selectControl("party_size", String(options.partySize ?? 3), [
    option("1", "1 位"),
    option("2", "2 位"),
    option("3", "3 位"),
    option("4", "4 位"),
  ]);
  const name = eventTarget({ disabled: false, name: "name", type: "text", value: "林澄" });
  const phone = eventTarget({ disabled: false, name: "phone", type: "tel", value: "13800138000" });
  const email = eventTarget({ disabled: false, name: "email", type: "email", value: "player@example.com" });
  const note = eventTarget({ disabled: false, name: "note", type: "textarea", value: "靠近入口" });
  const consent = eventTarget({
    checked: true,
    disabled: false,
    name: "privacy_consent",
    type: "checkbox",
    value: "yes",
  });
  const idempotencyKey = eventTarget({
    disabled: false,
    name: "idempotency_key",
    type: "hidden",
    value: "",
  });
  const honeypot = eventTarget({ disabled: false, name: "website", type: "text", value: "" });
  const controls = [
    modeOpen,
    modePrivate,
    date,
    startTime,
    sessionId,
    partySize,
    name,
    phone,
    email,
    note,
    consent,
    idempotencyKey,
    honeypot,
  ];
  const requests = [];
  const submitButton = { disabled: false };
  const errorBox = { hidden: true, textContent: "" };
  let preventedCount = 0;
  let resetCount = 0;

  const form = eventTarget({
    action: "https://booking-api.example.invalid/v1/bookings",
    elements: controls,
    checkValidity() {
      return options.valid !== false;
    },
    getAttribute(name) {
      const attributes = {
        "data-availability-url": "https://booking-api.example.invalid/v1/availability",
        "data-booking-result-path": "/chengchang-pickle-club/booking/result/",
        "data-booking-status-path": "/chengchang-pickle-club/booking/status/",
      };
      return attributes[name] ?? null;
    },
    querySelector(selector) {
      if (selector === 'button[type="submit"]') return submitButton;
      if (selector === 'input[name="mode"]:checked') {
        return modePrivate.checked ? modePrivate : modeOpen;
      }
      if (selector === 'input[name="mode"][value="open"]') return modeOpen;
      if (selector === 'input[name="mode"][value="private"]') return modePrivate;
      return null;
    },
    reset() {
      resetCount += 1;
    },
  });

  function XMLHttpRequest() {
    if (options.constructorThrows) throw new Error("constructor failed");
    this.headers = {};
    requests.push(this);
  }
  XMLHttpRequest.prototype.open = function (method, url) {
    if (options.openThrows) throw new Error("open failed");
    this.method = method;
    this.url = url;
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (options.headerThrows) throw new Error("header failed");
    this.headers[name] = value;
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (options.sendThrows) throw new Error("send failed");
    this.body = body;
    this.sent = true;
  };
  XMLHttpRequest.prototype.respond = function (status, body = "") {
    this.status = status;
    this.responseText = body;
    this.readyState = 4;
    this.onreadystatechange();
  };
  XMLHttpRequest.prototype.fail = function () {
    this.onerror();
  };

  const storage = options.storage ?? createStorage(options);
  const location = { href: "" };
  vm.runInNewContext(source, {
    document: {
      createElement(tagName) {
        assert.equal(tagName, "option");
        return option("", "");
      },
      getElementById(id) {
        const elements = {
          "booking-date": date,
          "booking-error": errorBox,
          "booking-form": form,
          "booking-idempotency-key": idempotencyKey,
          "booking-party-size": partySize,
          "booking-session-id": sessionId,
          "booking-start-time": startTime,
        };
        return elements[id] ?? null;
      },
    },
    window: {
      JSON,
      XMLHttpRequest,
      location,
      sessionStorage: storage,
    },
    XMLHttpRequest,
  });

  return {
    controls: {
      consent,
      date,
      email,
      honeypot,
      idempotencyKey,
      modeOpen,
      modePrivate,
      name,
      note,
      partySize,
      phone,
      sessionId,
      startTime,
    },
    errorBox,
    form,
    location,
    preventedCount: () => preventedCount,
    request: (index = 0) => requests[index],
    requests,
    resetCount: () => resetCount,
    storage,
    submit() {
      form.fire("submit", {
        preventDefault() {
          preventedCount += 1;
        },
      });
    },
    submitButton,
  };
}

test("booking enhancement parses as ES5", async () => {
  const source = await readEnhancement();
  assert.doesNotThrow(() => parse(source, { ecmaVersion: 5 }));
});

test("valid dates fetch availability and filter each session by mode and whole party size", async () => {
  const source = await readEnhancement();
  const page = loadEnhancement(source);
  const { date, modeOpen, modePrivate, partySize, sessionId, startTime } = page.controls;

  date.value = "2026-02-31";
  date.fire("change");
  assert.equal(page.requests.length, 0);
  assert.equal(startTime.disabled, false);

  date.value = "2026-08-10";
  date.fire("change");
  const request = page.request();
  assert.equal(request.method, "GET");
  assert.equal(
    request.url,
    "https://booking-api.example.invalid/v1/availability?date=2026-08-10",
  );
  assert.equal(request.headers.Accept, "application/json");
  assert.equal(startTime.disabled, true);

  request.respond(
    200,
    JSON.stringify({
      data: [
        {
          sessionId: "2026-08-10__slot-0700",
          startTime: "07:00",
          acceptsOpenPartySizes: [1, 3],
          privateCourtCount: 0,
        },
        {
          sessionId: "2026-08-10__slot-0800",
          startTime: "08:00",
          acceptsOpenPartySizes: [],
          privateCourtCount: 1,
        },
        {
          sessionId: "2026-08-10__slot-0900",
          startTime: "09:00",
          acceptsOpenPartySizes: [1, 2],
          privateCourtCount: 2,
        },
      ],
    }),
  );

  assert.equal(startTime.disabled, false);
  assert.deepEqual(
    startTime.options.slice(1).map((entry) => entry.value),
    ["07:00"],
  );
  startTime.value = "07:00";
  startTime.fire("change");
  assert.equal(sessionId.value, "2026-08-10__slot-0700");

  modeOpen.checked = false;
  modePrivate.checked = true;
  modePrivate.fire("change");
  assert.equal(startTime.disabled, false);
  assert.deepEqual(
    startTime.options.slice(1).map((entry) => entry.value),
    ["08:00", "09:00"],
  );
  assert.equal(sessionId.value, "");
  startTime.value = "08:00";
  startTime.fire("change");
  assert.equal(sessionId.value, "2026-08-10__slot-0800");

  modeOpen.checked = true;
  modePrivate.checked = false;
  modeOpen.fire("change");
  partySize.value = "4";
  partySize.fire("change");
  assert.deepEqual(startTime.options.slice(1), []);
  assert.equal(startTime.disabled, false);
  assert.equal(page.requests.length, 1);
});

test("availability failures restore the enabled server-rendered time fallback", async () => {
  const source = await readEnhancement();
  const page = loadEnhancement(source, { date: "2026-08-10", startTime: "08:00" });
  const { date, startTime } = page.controls;
  const original = startTime.options.map((entry) => entry.value);

  date.fire("change");
  assert.equal(startTime.disabled, true);
  page.request().fail();

  assert.equal(startTime.disabled, false);
  assert.equal(startTime.value, "08:00");
  assert.deepEqual(startTime.options.map((entry) => entry.value), original);
});

test("one persisted idempotency key survives failed submissions and clears only on 201 with a code", async () => {
  const source = await readEnhancement();
  const storage = createStorage();
  const page = loadEnhancement(source, { date: "2026-08-10", storage });
  const key = page.controls.idempotencyKey.value;

  assert.ok(key.length >= 16);
  assert.equal(storage.peek(), key);

  page.submit();
  const first = page.request();
  assert.equal(page.preventedCount(), 1);
  assert.equal(first.method, "POST");
  assert.equal(first.url, "https://booking-api.example.invalid/v1/bookings");
  assert.equal(first.headers.Accept, "application/json");
  assert.equal(
    first.headers["Content-Type"],
    "application/x-www-form-urlencoded;charset=UTF-8",
  );
  assert.match(first.body, /(?:^|&)mode=open(?:&|$)/);
  assert.match(first.body, /(?:^|&)date=2026-08-10(?:&|$)/);
  assert.match(first.body, /(?:^|&)start_time=07%3A00(?:&|$)/);
  assert.match(first.body, /(?:^|&)party_size=3(?:&|$)/);
  assert.match(first.body, /(?:^|&)name=%E6%9E%97%E6%BE%84(?:&|$)/);
  assert.match(first.body, /(?:^|&)privacy_consent=yes(?:&|$)/);
  assert.match(first.body, new RegExp(`(?:^|&)idempotency_key=${key}(?:&|$)`));

  first.respond(409, JSON.stringify({ error: { code: "SESSION_FULL" } }));
  assert.equal(page.resetCount(), 0);
  assert.equal(page.controls.name.value, "林澄");
  assert.equal(page.controls.phone.value, "13800138000");
  assert.equal(page.controls.idempotencyKey.value, key);
  assert.equal(storage.peek(), key);
  assert.equal(storage.removeCount(), 0);

  page.submit();
  const retry = page.request(1);
  assert.match(retry.body, new RegExp(`(?:^|&)idempotency_key=${key}(?:&|$)`));
  retry.respond(201, JSON.stringify({ data: { code: "BOOK/42" } }));

  assert.equal(page.resetCount(), 1);
  assert.equal(page.controls.idempotencyKey.value, "");
  assert.equal(storage.peek(), undefined);
  assert.equal(storage.removeCount(), 1);
  assert.equal(
    page.location.href,
    "/chengchang-pickle-club/booking/result/?code=BOOK%2F42",
  );
});

test("400, 429, network, and malformed success responses preserve every field and key", async () => {
  const source = await readEnhancement();
  const cases = [
    { name: "400", trigger: (request) => request.respond(400, "{}") },
    { name: "429", trigger: (request) => request.respond(429, "{}") },
    { name: "network", trigger: (request) => request.fail() },
    {
      name: "200 with code",
      trigger: (request) => request.respond(200, JSON.stringify({ data: { code: "NOT-201" } })),
    },
    {
      name: "201 without code",
      trigger: (request) => request.respond(201, JSON.stringify({ data: {} })),
    },
  ];

  for (const entry of cases) {
    const page = loadEnhancement(source, { date: "2026-08-10" });
    const key = page.controls.idempotencyKey.value;
    const values = page.form.elements.map((control) => control.value);
    page.submit();
    entry.trigger(page.request());

    assert.equal(page.resetCount(), 0, entry.name);
    assert.equal(page.location.href, "", entry.name);
    assert.equal(page.controls.idempotencyKey.value, key, entry.name);
    assert.deepEqual(
      page.form.elements.map((control) => control.value),
      values,
      entry.name,
    );
    assert.equal(page.errorBox.hidden, false, entry.name);
    assert.equal(page.submitButton.disabled, false, entry.name);
  }
});

test("sessionStorage errors use one in-memory key for retries", async () => {
  const source = await readEnhancement();
  const page = loadEnhancement(source, { date: "2026-08-10", storageThrows: true });
  const key = page.controls.idempotencyKey.value;

  page.submit();
  page.request().respond(400, "{}");
  page.submit();

  assert.ok(key.length >= 16);
  assert.equal(page.controls.idempotencyKey.value, key);
  assert.match(page.request(1).body, new RegExp(`idempotency_key=${key}`));
});

test("synchronous XHR setup failures leave the native POST unprevented", async () => {
  const source = await readEnhancement();
  const cases = [
    { name: "constructor", options: { constructorThrows: true } },
    { name: "open", options: { openThrows: true } },
    { name: "header", options: { headerThrows: true } },
    { name: "send", options: { sendThrows: true } },
  ];

  for (const entry of cases) {
    const page = loadEnhancement(source, { date: "2026-08-10", ...entry.options });
    page.submit();

    assert.equal(page.preventedCount(), 0, entry.name);
    assert.equal(page.resetCount(), 0, entry.name);
    assert.equal(page.submitButton.disabled, false, entry.name);
  }
});

test("missing DOM enhancement APIs leave native date and time submission untouched", async () => {
  const source = await readEnhancement();
  let listenerCount = 0;
  const form = {
    elements: [],
    addEventListener() {
      listenerCount += 1;
    },
  };

  vm.runInNewContext(source, {
    document: {
      getElementById(id) {
        if (id === "booking-form") return form;
        return null;
      },
    },
    window: { JSON, XMLHttpRequest: function () {} },
    XMLHttpRequest: function () {},
  });

  assert.equal(listenerCount, 0);
});
