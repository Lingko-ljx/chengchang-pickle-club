import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

async function readEnhancement() {
  return readFile(new URL("../public/booking-form.js", import.meta.url), "utf8");
}

test("booking enhancement parses as ES5 and submits through XHR", async () => {
  const source = await readEnhancement();

  assert.doesNotThrow(() => parse(source, { ecmaVersion: 5 }));

  var submitHandler;
  var requests = [];
  var resetCount = 0;
  var prevented = false;
  var submitButton = { disabled: false };
  var errorBox = { hidden: true, textContent: "" };
  var successBox = { hidden: true, focus: function () {} };
  var form = {
    action: "https://formspree.io/f/testcontract",
    addEventListener: function (name, handler) {
      if (name === "submit") submitHandler = handler;
    },
    checkValidity: function () {
      return true;
    },
    querySelector: function () {
      return submitButton;
    },
    reset: function () {
      resetCount += 1;
    },
  };

  function XMLHttpRequest() {
    requests.push(this);
    this.headers = {};
  }
  XMLHttpRequest.prototype.open = function (method, url) {
    this.method = method;
    this.url = url;
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    this.headers[name] = value;
  };
  XMLHttpRequest.prototype.send = function () {
    this.status = 200;
    this.readyState = 4;
    this.onreadystatechange();
  };
  function FormData(receivedForm) {
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

  assert.equal(typeof submitHandler, "function");
  submitHandler({
    preventDefault: function () {
      prevented = true;
    },
  });

  var request = requests[0];
  assert.equal(prevented, true);
  assert.equal(request.method, "POST");
  assert.equal(request.url, form.action);
  assert.equal(request.headers.Accept, "application/json");
  assert.equal(resetCount, 1);
  assert.equal(successBox.hidden, false);
  assert.equal(errorBox.hidden, true);
  assert.equal(submitButton.disabled, false);
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
