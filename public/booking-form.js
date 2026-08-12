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
  var startSelect = document.getElementById("booking-start-time");
  var endSelect = document.getElementById("booking-end-time");
  var partySizeSelect = document.getElementById("booking-party-size");
  var sessionIdInput = document.getElementById("booking-session-id");
  var idempotencyInput = document.getElementById("booking-idempotency-key");
  var errorBox = document.getElementById("booking-error");
  var availabilityStatus = document.getElementById("booking-availability-status");
  var timeSummary = document.getElementById("booking-time-summary");
  var submitButton = form.querySelector('button[type="submit"]');
  var storageName = "chengchang-booking-unsent-v2";
  var memoryIdempotencyKey = "";
  var availableWindows = null;
  var bookingPolicy = null;
  var availabilityGeneration = 0;
  var fallbackStartOptions = [];

  if (!dateInput || !startSelect || !endSelect || !partySizeSelect) return;

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function hideError() {
    if (!errorBox) return;
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function setAvailabilityStatus(message) {
    if (!availabilityStatus) return;
    availabilityStatus.textContent = message;
    availabilityStatus.hidden = !message;
  }

  function finishSubmission() {
    if (submitButton) submitButton.disabled = false;
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
    if (!idempotencyInput) return "";
    if (validStoredKey(idempotencyInput.value)) return idempotencyInput.value;
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
    if (idempotencyInput) idempotencyInput.value = "";
    try {
      window.sessionStorage.removeItem(storageName);
    } catch (error) {
      void error;
    }
  }

  function appendQueryParameter(path, name, value) {
    var hashIndex = path.indexOf("#");
    var hash = hashIndex >= 0 ? path.slice(hashIndex) : "";
    var base = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
    var separator = base.indexOf("?") >= 0 ? "&" : "?";
    return base + separator + encodeURIComponent(name) + "=" + encodeURIComponent(value) + hash;
  }

  function appendFragmentParameter(path, name, value) {
    var hashIndex = path.indexOf("#");
    var base = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
    var fragment = hashIndex >= 0 ? path.slice(hashIndex + 1) : "";
    var separator = fragment ? "&" : "";
    return base + "#" + fragment + separator + encodeURIComponent(name) + "=" + encodeURIComponent(value);
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

  function timeMinutes(value) {
    var match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || "");
    if (!match) return -1;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function durationMinutes(startTime, endTime) {
    var start = timeMinutes(startTime);
    var end = timeMinutes(endTime);
    return start >= 0 && end > start ? end - start : 0;
  }

  function formattedTime(minutes) {
    var hours = Math.floor(minutes / 60);
    var remainder = minutes % 60;
    return (hours < 10 ? "0" : "") + hours + ":" + (remainder < 10 ? "0" : "") + remainder;
  }

  function localEndEntries(startTime) {
    var start = timeMinutes(startTime);
    var entries = [{ value: "", text: "请选择结束时间" }];
    var hours;
    var end;
    if (start < 540 || start >= 1320 || start % 30 !== 0) return entries;
    for (hours = 1; hours <= 4; hours += 1) {
      end = start + hours * 60;
      if (end > 1320) break;
      entries.push({
        value: formattedTime(end),
        text: formattedTime(end) + " · " + hours + " 小时",
      });
    }
    return entries;
  }

  function readOptions(select) {
    var entries = [];
    var index;
    for (index = 0; index < select.options.length; index += 1) {
      entries.push({ text: select.options[index].text, value: select.options[index].value });
    }
    return entries;
  }

  function replaceOptions(select, entries, selectedValue) {
    var index;
    var option;
    var selectedExists = false;
    while (select.options.length) select.remove(0);
    for (index = 0; index < entries.length; index += 1) {
      option = document.createElement("option");
      option.value = entries[index].value;
      option.text = entries[index].text;
      if (entries[index].sessionId) {
        option.setAttribute("data-session-id", entries[index].sessionId);
      }
      select.add(option);
      if (entries[index].value === selectedValue) selectedExists = true;
    }
    select.value = selectedExists ? selectedValue : "";
  }

  function selectedMode() {
    var selected = form.querySelector('input[name="mode"]:checked');
    return selected ? selected.value : "";
  }

  function acceptsPartySize(windowValue, partySize) {
    var values = windowValue.acceptsOpenPartySizes;
    var index;
    if (values && typeof values.length === "number") {
      for (index = 0; index < values.length; index += 1) {
        if (Number(values[index]) === partySize) return true;
      }
    }
    return Number(windowValue.openCapacity) >= partySize;
  }

  function validBookingWindow(windowValue) {
    var minutes;
    if (!windowValue || typeof windowValue !== "object") return false;
    minutes = durationMinutes(windowValue.startTime, windowValue.endTime);
    if (!minutes || minutes % 60 !== 0) return false;
    if (minutes < 60 || minutes > 240) return false;
    return timeMinutes(windowValue.startTime) >= 540 && timeMinutes(windowValue.endTime) <= 1320;
  }

  function windowCanBeBooked(windowValue, mode, partySize) {
    if (!validBookingWindow(windowValue)) return false;
    if (mode === "private") return Number(windowValue.privateCourtCount) > 0;
    return mode === "open" && acceptsPartySize(windowValue, partySize);
  }

  function filteredWindows() {
    var values = [];
    var mode = selectedMode();
    var partySize = Number(partySizeSelect.value);
    var index;
    if (!availableWindows) return values;
    for (index = 0; index < availableWindows.length; index += 1) {
      if (windowCanBeBooked(availableWindows[index], mode, partySize)) {
        values.push(availableWindows[index]);
      }
    }
    return values;
  }

  function updateTimeSummary() {
    var minutes = durationMinutes(startSelect.value, endSelect.value);
    if (!timeSummary) return;
    if (!minutes || minutes % 60 !== 0) {
      timeSummary.textContent = "北京时间 · 请选择开始与结束时间";
      return;
    }
    timeSummary.textContent =
      "北京时间 " +
      startSelect.value +
      "–" +
      endSelect.value +
      " · 共 " +
      minutes / 60 +
      " 小时 · 按 " +
      minutes / 60 +
      " 小时计费";
  }

  function syncCanonicalSessionId() {
    if (sessionIdInput) sessionIdInput.value = "";
    updateTimeSummary();
  }

  function renderEndOptions() {
    var values = filteredWindows();
    var selectedValue = endSelect.value;
    var entries = [{ value: "", text: "请选择结束时间" }];
    var seen = {};
    var index;
    var value;
    var hours;
    if (!availableWindows) {
      replaceOptions(endSelect, localEndEntries(startSelect.value), selectedValue);
      syncCanonicalSessionId();
      return;
    }
    for (index = 0; index < values.length; index += 1) {
      value = values[index];
      if (value.startTime !== startSelect.value || seen[value.endTime]) continue;
      seen[value.endTime] = true;
      hours = durationMinutes(value.startTime, value.endTime) / 60;
      entries.push({
        value: value.endTime,
        text: value.endTime + " · " + hours + " 小时",
        sessionId: value.sessionId || "",
      });
    }
    replaceOptions(endSelect, entries, selectedValue);
    syncCanonicalSessionId();
  }

  function filterWindows() {
    var values;
    var selectedValue;
    var entries = [{ value: "", text: "请选择可用开始时间" }];
    var seen = {};
    var index;
    var value;
    if (!availableWindows) return;
    values = filteredWindows();
    selectedValue = startSelect.value;
    for (index = 0; index < values.length; index += 1) {
      value = values[index];
      if (seen[value.startTime]) continue;
      seen[value.startTime] = true;
      entries.push({ value: value.startTime, text: value.startTime });
    }
    replaceOptions(startSelect, entries, selectedValue);
    renderEndOptions();
    if (values.length) {
      setAvailabilityStatus("已按当前人数和预约方式显示实时可用时间。");
    } else {
      setAvailabilityStatus("当天暂无符合条件的连续时段，请更换时间、人数或预约方式。");
    }
  }

  function restoreFallbackOptions() {
    var selectedStart = startSelect.value;
    var selectedEnd = endSelect.value;
    replaceOptions(startSelect, fallbackStartOptions, selectedStart);
    replaceOptions(endSelect, localEndEntries(startSelect.value), selectedEnd);
    if (sessionIdInput) sessionIdInput.value = "";
    updateTimeSummary();
  }

  function availabilityIsCurrent(generation, requestedDate) {
    return generation === availabilityGeneration && dateInput.value === requestedDate;
  }

  function availabilityFailure(generation, requestedDate) {
    if (!availabilityIsCurrent(generation, requestedDate)) return;
    availableWindows = null;
    bookingPolicy = null;
    startSelect.disabled = false;
    endSelect.disabled = false;
    restoreFallbackOptions();
    setAvailabilityStatus("实时余位暂未刷新；仍可选择营业时间，提交时会再次校验。");
    showError("暂时无法刷新实时场次，你仍可使用日期、开始和结束时间提交预约。");
  }

  function parseAvailability(payload) {
    var data = payload && payload.data;
    var windows;
    var policy = null;
    if (data && typeof data.length === "number") {
      windows = data;
    } else if (data && typeof data === "object") {
      windows = data.windows;
      policy = data.policy || data.bookingPolicy || null;
    }
    if (!windows || typeof windows.length !== "number") return null;
    return { windows: windows, policy: policy };
  }

  function fetchAvailability() {
    var request;
    var requestedDate;
    var generation;
    availabilityGeneration += 1;
    generation = availabilityGeneration;
    requestedDate = dateInput.value;
    if (!availabilityUrl) return;
    if (!isValidDate(requestedDate)) {
      availableWindows = null;
      bookingPolicy = null;
      startSelect.disabled = false;
      endSelect.disabled = false;
      restoreFallbackOptions();
      hideError();
      setAvailabilityStatus("营业时间 09:00–22:00 · 最少 1 小时 · 整小时计费");
      return;
    }

    if (sessionIdInput) sessionIdInput.value = "";
    startSelect.disabled = true;
    endSelect.disabled = true;
    hideError();
    setAvailabilityStatus("正在查询连续可用时段…");
    try {
      request = new XMLHttpRequest();
      request.open("GET", availabilityUrl + "?date=" + encodeURIComponent(requestedDate), true);
      request.setRequestHeader("Accept", "application/json");
      request.onreadystatechange = function () {
        var parsed;
        if (request.readyState !== 4) return;
        if (!availabilityIsCurrent(generation, requestedDate)) return;
        if (request.status !== 200) {
          availabilityFailure(generation, requestedDate);
          return;
        }
        try {
          parsed = parseAvailability(window.JSON.parse(request.responseText));
          if (!parsed) {
            availabilityFailure(generation, requestedDate);
            return;
          }
          availableWindows = parsed.windows;
          bookingPolicy = parsed.policy;
          void bookingPolicy;
          startSelect.disabled = false;
          endSelect.disabled = false;
          filterWindows();
        } catch (error) {
          void error;
          availabilityFailure(generation, requestedDate);
        }
      };
      request.onerror = function () {
        availabilityFailure(generation, requestedDate);
      };
      request.ontimeout = request.onerror;
      request.send(null);
    } catch (error) {
      void error;
      availabilityFailure(generation, requestedDate);
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
      if (
        control.name === "session_id" &&
        dateInput.value &&
        startSelect.value &&
        endSelect.value
      ) {
        continue;
      }
      if (type === "button" || type === "submit" || type === "reset" || type === "file") {
        continue;
      }
      if ((type === "checkbox" || type === "radio") && !control.checked) continue;
      pairs.push(encodeURIComponent(control.name) + "=" + encodeURIComponent(control.value || ""));
    }
    return pairs.join("&");
  }

  function submissionFailure(status) {
    finishSubmission();
    if (status === 429) {
      showError("提交较频繁，请稍后再试；表单内容已保留。");
    } else if (status === 409) {
      showError("所选连续时段刚刚已满，请刷新或选择其他时间；表单内容已保留。");
    } else if (status === 400) {
      showError("预约信息未通过校验，请检查日期、开始和结束时间后重试。");
    } else {
      showError("提交未成功，表单内容已保留，请检查网络后重试。");
    }
  }

  function submitWithXhr(event) {
    var request;
    var body;
    if (form.checkValidity && !form.checkValidity()) return;
    if (
      timeMinutes(startSelect.value) < 540 ||
      timeMinutes(endSelect.value) > 1320 ||
      durationMinutes(startSelect.value, endSelect.value) < 60 ||
      durationMinutes(startSelect.value, endSelect.value) > 240 ||
      durationMinutes(startSelect.value, endSelect.value) % 60 !== 0
    ) {
      if (event && event.preventDefault) event.preventDefault();
      showError("请选择营业时间内 1–4 小时的连续时段；开始时间可为整点或半点。");
      return;
    }
    ensureIdempotencyKey();
    hideError();
    try {
      request = new XMLHttpRequest();
      request.open("POST", form.action, true);
      request.setRequestHeader("Accept", "application/json");
      request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
      body = serializeForm();
      request.onreadystatechange = function () {
        var payload;
        var code;
        var displayCode;
        if (request.readyState !== 4) return;
        if (request.status === 201) {
          try {
            payload = window.JSON.parse(request.responseText);
            code = payload && payload.data && payload.data.code;
            displayCode = payload && payload.data && payload.data.displayCode;
          } catch (error) {
            void error;
            code = "";
            displayCode = "";
          }
          if (
            typeof code === "string" &&
            code !== "" &&
            typeof displayCode === "string" &&
            /^\d{4}$/.test(displayCode)
          ) {
            resultPath =
              form.getAttribute("data-booking-result-path") || resultPath;
            clearIdempotencyKey();
            form.reset();
            window.location.href = appendFragmentParameter(
              appendQueryParameter(resultPath, "code", code),
              "display_code",
              displayCode
            );
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

  fallbackStartOptions = readOptions(startSelect);
  ensureIdempotencyKey();
  renderEndOptions();
  dateInput.addEventListener("change", fetchAvailability);
  startSelect.addEventListener("change", renderEndOptions);
  endSelect.addEventListener("change", syncCanonicalSessionId);
  partySizeSelect.addEventListener("change", filterWindows);
  if (form.querySelector) {
    var openMode = form.querySelector('input[name="mode"][value="open"]');
    var privateMode = form.querySelector('input[name="mode"][value="private"]');
    if (openMode) openMode.addEventListener("change", filterWindows);
    if (privateMode) privateMode.addEventListener("change", filterWindows);
  }
  form.addEventListener("submit", submitWithXhr);
})();
