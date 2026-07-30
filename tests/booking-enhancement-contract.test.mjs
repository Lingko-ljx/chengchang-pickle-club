import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

async function readEnhancement() {
  return readFile(new URL("../public/booking-form.js", import.meta.url), "utf8");
}

function loadEnhancement(source, options) {
  var submitHandler;
  var requests = [];
  var resetCount = 0;
  var prevented = false;
  var focusCount = 0;
  var submitButton = { disabled: false };
  var errorBox = { hidden: true, textContent: "" };
  var successBox = {
    hidden: options.successHidden !== false,
    focus: function () {
      focusCount += 1;
    },
  };
  var form = {
    action: "https://formspree.io/f/testcontract",
    addEventListener: function (name, handler) {
      if (name === "submit") submitHandler = handler;
    },
    checkValidity: function () {
      return options.valid !== false;
    },
    querySelector: function () {
      return submitButton;
    },
    reset: function () {
      resetCount += 1;
    },
  };

  function XMLHttpRequest() {
    if (options.constructorThrows) throw new Error("constructor failed");
    requests.push(this);
    this.headers = {};
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
  XMLHttpRequest.prototype.send = function () {
    if (options.sendThrows) throw new Error("send failed");
    this.sent = true;
  };
  XMLHttpRequest.prototype.respond = function (status) {
    this.status = status;
    this.readyState = 4;
    this.onreadystatechange();
  };
  XMLHttpRequest.prototype.fail = function () {
    this.onerror();
  };
  function FormData(receivedForm) {
    if (options.formDataThrows) throw new Error("FormData failed");
    this.form = receivedForm;
  }

  vm.runInNewContext(source, {
    document: {
      getElementById: function (id) {
        if (id === "booking-form") return form;
        if (id === "booking-error") return errorBox;
        if (id === "booking-success") return successBox;
        return null;
      },
    },
    FormData: FormData,
    XMLHttpRequest: XMLHttpRequest,
    window: {
      FormData: FormData,
      XMLHttpRequest: XMLHttpRequest,
    },
  });

  return {
    errorBox: errorBox,
    focusCount: function () {
      return focusCount;
    },
    prevented: function () {
      return prevented;
    },
    request: function () {
      return requests[0];
    },
    resetCount: function () {
      return resetCount;
    },
    submit: function () {
      submitHandler({
        preventDefault: function () {
          prevented = true;
        },
      });
    },
    submitButton: submitButton,
    successBox: successBox,
  };
}

test("booking enhancement parses as ES5, clears stale success, and submits through XHR", async () => {
  const source = await readEnhancement();
  const page = loadEnhancement(source, { successHidden: false });

  assert.doesNotThrow(() => parse(source, { ecmaVersion: 5 }));
  page.submit();

  var request = page.request();
  assert.equal(page.prevented(), true);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://formspree.io/f/testcontract");
  assert.equal(request.headers.Accept, "application/json");
  assert.equal(request.sent, true);
  assert.equal(page.successBox.hidden, true);
  assert.equal(page.submitButton.disabled, true);

  request.respond(200);

  assert.equal(page.resetCount(), 1);
  assert.equal(page.successBox.hidden, false);
  assert.equal(page.focusCount(), 1);
  assert.equal(page.errorBox.hidden, true);
  assert.equal(page.submitButton.disabled, false);
});

test("booking enhancement preserves native validation when the form is invalid", async () => {
  const source = await readEnhancement();
  const page = loadEnhancement(source, { valid: false });

  page.submit();

  assert.equal(page.prevented(), false);
  assert.equal(page.request(), undefined);
  assert.equal(page.resetCount(), 0);
  assert.equal(page.submitButton.disabled, false);
});

test("booking enhancement preserves form contents for asynchronous errors", async () => {
  const source = await readEnhancement();
  const cases = [
    {
      trigger: function (request) {
        request.respond(429);
      },
      message: "\u63d0\u4ea4\u8f83\u9891\u7e41\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u6216\u7535\u8bdd\u8054\u7cfb\u6211\u4eec\u3002",
    },
    {
      trigger: function (request) {
        request.respond(500);
      },
      message: "\u63d0\u4ea4\u672a\u6210\u529f\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5\u6216\u7535\u8bdd\u8054\u7cfb\u6211\u4eec\u3002",
    },
    {
      trigger: function (request) {
        request.fail();
      },
      message: "\u7f51\u7edc\u8fde\u63a5\u5931\u8d25\uff0c\u8868\u5355\u5185\u5bb9\u5df2\u4fdd\u7559\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u6216\u7535\u8bdd\u8054\u7cfb\u6211\u4eec\u3002",
    },
  ];

  for (const entry of cases) {
    const page = loadEnhancement(source, {});
    page.submit();
    entry.trigger(page.request());

    assert.equal(page.prevented(), true);
    assert.equal(page.resetCount(), 0);
    assert.equal(page.errorBox.hidden, false);
    assert.equal(page.errorBox.textContent, entry.message);
    assert.equal(page.successBox.hidden, true);
    assert.equal(page.submitButton.disabled, false);
  }
});

test("booking enhancement keeps native submission available after synchronous setup failures", async () => {
  const source = await readEnhancement();
  const cases = [
    { name: "constructor", options: { constructorThrows: true } },
    { name: "open", options: { openThrows: true } },
    { name: "setRequestHeader", options: { headerThrows: true } },
    { name: "FormData", options: { formDataThrows: true } },
    { name: "send", options: { sendThrows: true } },
  ];

  for (const entry of cases) {
    const page = loadEnhancement(source, {
      ...entry.options,
      successHidden: false,
    });

    page.submit();

    assert.equal(page.prevented(), false, entry.name);
    assert.equal(page.resetCount(), 0, entry.name);
    assert.equal(page.submitButton.disabled, false, entry.name);
    assert.equal(page.successBox.hidden, true, entry.name);
  }
});

test("booking enhancement preserves native submission without required APIs", async () => {
  const source = await readEnhancement();
  var listenerCount = 0;
  var form = {
    addEventListener: function () {
      listenerCount += 1;
    },
  };

  vm.runInNewContext(source, {
    document: {
      getElementById: function (id) {
        if (id === "booking-form") return form;
        return null;
      },
    },
    window: {},
  });

  assert.equal(listenerCount, 0);
});
