(function () {
  var form = document.getElementById("booking-form");

  if (
    !form ||
    !form.addEventListener ||
    !form.elements ||
    !form.getAttribute ||
    !form.querySelector ||
    !document.createElement ||
    !window.XMLHttpRequest ||
    !window.JSON ||
    !window.JSON.parse
  ) {
    return;
  }

  var availabilityUrl = form.getAttribute("data-availability-url") || "";
  var resultPath = form.getAttribute("data-booking-result-path") || "";
  var dateInput = document.getElementById("booking-date");
  var timeSelect = document.getElementById("booking-start-time");
  var partySizeSelect = document.getElementById("booking-party-size");
  var sessionIdInput = document.getElementById("booking-session-id");
  var idempotencyInput = document.getElementById("booking-idempotency-key");
  var errorBox = document.getElementById("booking-error");
  var submitButton = form.querySelector('button[type="submit"]');
  var storageName = "chengchang-booking-unsent-v1";
  var memoryIdempotencyKey = "";
  var availableSessions = null;
  var fallbackOptions = [];

  function showError(message) {
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
  }

  function hideError() {
    if (errorBox) {
      errorBox.hidden = true;
      errorBox.textContent = "";
    }
  }

  function finishSubmission() {
    if (submitButton) {
      submitButton.disabled = false;
    }
  }

  function validStoredKey(value) {
    return typeof value === "string" && /^[A-Za-z0-9._-]{16,128}$/.test(value);
  }

  function newIdempotencyKey() {
    return (
      "bk-" +
      new Date().getTime().toString(36) +
      "-" +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2)
    );
  }

  function ensureIdempotencyKey() {
    var stored = "";

    if (!idempotencyInput) {
      return "";
    }
    if (validStoredKey(idempotencyInput.value)) {
      return idempotencyInput.value;
    }
    try {
      stored = window.sessionStorage.getItem(storageName) || "";
    } catch (error) {
      void error;
      stored = "";
    }
    if (!validStoredKey(stored)) {
      stored = validStoredKey(memoryIdempotencyKey)
        ? memoryIdempotencyKey
        : newIdempotencyKey();
    }

    memoryIdempotencyKey = stored;
    idempotencyInput.value = stored;
    try {
      window.sessionStorage.setItem(storageName, stored);
    } catch (error) {
      void error;
    }
    return stored;
  }

  function clearIdempotencyKey() {
    memoryIdempotencyKey = "";
    if (idempotencyInput) {
      idempotencyInput.value = "";
    }
    try {
      window.sessionStorage.removeItem(storageName);
    } catch (error) {
      void error;
    }
  }

  function isValidDate(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    var parsed;
    if (!match) return false;
    parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return (
      parsed.getFullYear() === Number(match[1]) &&
      parsed.getMonth() === Number(match[2]) - 1 &&
      parsed.getDate() === Number(match[3])
    );
  }

  function readFallbackOptions() {
    var index;
    if (!timeSelect || !timeSelect.options) return;
    for (index = 0; index < timeSelect.options.length; index += 1) {
      fallbackOptions.push({
        text: timeSelect.options[index].text,
        value: timeSelect.options[index].value,
      });
    }
  }

  function replaceTimeOptions(entries, selectedValue) {
    var index;
    var option;
    var selectedExists = false;

    if (!timeSelect) return;
    while (timeSelect.options.length) {
      timeSelect.remove(0);
    }
    for (index = 0; index < entries.length; index += 1) {
      option = document.createElement("option");
      option.value = entries[index].value;
      option.text = entries[index].text;
      if (entries[index].sessionId) {
        option.setAttribute("data-session-id", entries[index].sessionId);
      }
      timeSelect.add(option);
      if (entries[index].value === selectedValue) {
        selectedExists = true;
      }
    }
    timeSelect.value = selectedExists ? selectedValue : "";
  }

  function restoreFallbackOptions() {
    var selectedValue = timeSelect ? timeSelect.value : "";
    replaceTimeOptions(fallbackOptions, selectedValue);
    if (sessionIdInput) sessionIdInput.value = "";
  }

  function selectedMode() {
    var selected = form.querySelector('input[name="mode"]:checked');
    return selected ? selected.value : "";
  }

  function acceptsPartySize(session, partySize) {
    var values = session.acceptsOpenPartySizes;
    var index;
    if (!values || typeof values.length !== "number") return false;
    for (index = 0; index < values.length; index += 1) {
      if (Number(values[index]) === partySize) return true;
    }
    return false;
  }

  function sessionCanBeBooked(session, mode, partySize) {
    if (!session || typeof session !== "object") return false;
    if (typeof session.sessionId !== "string") return false;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(session.startTime || "")) return false;
    if (mode === "private") return Number(session.privateCourtCount) > 0;
    return mode === "open" && acceptsPartySize(session, partySize);
  }

  function syncCanonicalSessionId() {
    var index;
    var selected;
    if (!sessionIdInput || !timeSelect) return;
    sessionIdInput.value = "";
    for (index = 0; index < timeSelect.options.length; index += 1) {
      selected = timeSelect.options[index];
      if (selected.value === timeSelect.value) {
        sessionIdInput.value = selected.getAttribute("data-session-id") || "";
        return;
      }
    }
  }

  function filterSessions() {
    var mode;
    var partySize;
    var selectedValue;
    var entries = [{ value: "", text: "请选择可用时段" }];
    var index;
    var session;

    if (!availableSessions || !timeSelect || !partySizeSelect) return;
    mode = selectedMode();
    partySize = Number(partySizeSelect.value);
    selectedValue = timeSelect.value;
    for (index = 0; index < availableSessions.length; index += 1) {
      session = availableSessions[index];
      if (sessionCanBeBooked(session, mode, partySize)) {
        entries.push({
          sessionId: session.sessionId,
          text: session.startTime,
          value: session.startTime,
        });
      }
    }
    replaceTimeOptions(entries, selectedValue);
    syncCanonicalSessionId();
  }

  function availabilityFailure() {
    availableSessions = null;
    if (timeSelect) timeSelect.disabled = false;
    restoreFallbackOptions();
    showError("暂时无法刷新实时场次，你仍可使用日期和时间提交预约。");
  }

  function fetchAvailability() {
    var request;
    var requestedDate;

    if (!dateInput || !timeSelect || !availabilityUrl) return;
    requestedDate = dateInput.value;
    if (!isValidDate(requestedDate)) {
      availableSessions = null;
      timeSelect.disabled = false;
      restoreFallbackOptions();
      return;
    }

    if (sessionIdInput) sessionIdInput.value = "";
    timeSelect.disabled = true;
    hideError();
    try {
      request = new XMLHttpRequest();
      request.open("GET", availabilityUrl + "?date=" + encodeURIComponent(requestedDate), true);
      request.setRequestHeader("Accept", "application/json");
      request.onreadystatechange = function () {
        var payload;
        if (request.readyState !== 4) return;
        if (request.status !== 200) {
          availabilityFailure();
          return;
        }
        try {
          payload = window.JSON.parse(request.responseText);
          if (!payload || !payload.data || typeof payload.data.length !== "number") {
            availabilityFailure();
            return;
          }
          availableSessions = payload.data;
          timeSelect.disabled = false;
          filterSessions();
        } catch (error) {
          void error;
          availabilityFailure();
        }
      };
      request.onerror = availabilityFailure;
      request.ontimeout = availabilityFailure;
      request.send(null);
    } catch (error) {
      void error;
      availabilityFailure();
    }
  }

  function serializeForm() {
    var pairs = [];
    var index;
    var control;
    var type;

    for (index = 0; index < form.elements.length; index += 1) {
      control = form.elements[index];
      type = (control.type || "").toLowerCase();
      if (!control.name || control.disabled) continue;
      if (type === "button" || type === "submit" || type === "reset" || type === "file") {
        continue;
      }
      if ((type === "checkbox" || type === "radio") && !control.checked) continue;
      pairs.push(
        encodeURIComponent(control.name) + "=" + encodeURIComponent(control.value || "")
      );
    }
    return pairs.join("&");
  }

  function submissionFailure(status) {
    finishSubmission();
    if (status === 429) {
      showError("提交较频繁，请稍后再试；表单内容已保留。");
    } else if (status === 409) {
      showError("该时段刚刚已满，请刷新场次或选择其他时间；表单内容已保留。");
    } else if (status === 400) {
      showError("预约信息未通过校验，请检查后重试；已填写内容不会清除。");
    } else {
      showError("提交未成功，表单内容已保留，请检查网络后重试。");
    }
  }

  function submitWithXhr(event) {
    var request;
    var body;

    if (form.checkValidity && !form.checkValidity()) return;
    ensureIdempotencyKey();
    hideError();
    try {
      request = new XMLHttpRequest();
      request.open("POST", form.action, true);
      request.setRequestHeader("Accept", "application/json");
      request.setRequestHeader(
        "Content-Type",
        "application/x-www-form-urlencoded;charset=UTF-8"
      );
      body = serializeForm();
      request.onreadystatechange = function () {
        var payload;
        var code;
        if (request.readyState !== 4) return;
        if (request.status === 201) {
          try {
            payload = window.JSON.parse(request.responseText);
            code = payload && payload.data && payload.data.code;
          } catch (error) {
            void error;
            code = "";
          }
          if (typeof code === "string" && code !== "") {
            clearIdempotencyKey();
            form.reset();
            window.location.href = resultPath + "?code=" + encodeURIComponent(code);
            return;
          }
        }
        submissionFailure(request.status);
      };
      request.onerror = function () {
        submissionFailure(0);
      };
      request.ontimeout = request.onerror;
      request.send(body);
      if (submitButton) submitButton.disabled = true;
      event.preventDefault();
    } catch (error) {
      void error;
      finishSubmission();
      showError("增强提交不可用，将使用浏览器原生提交。");
    }
  }

  readFallbackOptions();
  ensureIdempotencyKey();
  if (dateInput) dateInput.addEventListener("change", fetchAvailability);
  if (timeSelect) timeSelect.addEventListener("change", syncCanonicalSessionId);
  if (partySizeSelect) partySizeSelect.addEventListener("change", filterSessions);
  if (form.querySelector) {
    var openMode = form.querySelector('input[name="mode"][value="open"]');
    var privateMode = form.querySelector('input[name="mode"][value="private"]');
    if (openMode) openMode.addEventListener("change", filterSessions);
    if (privateMode) privateMode.addEventListener("change", filterSessions);
  }
  form.addEventListener("submit", submitWithXhr);
})();
