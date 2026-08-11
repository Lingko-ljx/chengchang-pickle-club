(function () {
  var shell = document.getElementById("booking-status-shell");
  var form = document.getElementById("booking-status-form");
  var codeInput = document.getElementById("booking-status-code");
  var phoneInput = document.getElementById("booking-status-phone");
  var message = document.getElementById("booking-status-message");
  var result = document.getElementById("booking-status-result");
  var statusValue = document.getElementById("booking-status-value");
  var sessionValue = document.getElementById("booking-status-session");
  var modeValue = document.getElementById("booking-status-mode");
  var partySizeValue = document.getElementById("booking-status-party-size");
  var contactValue = document.getElementById("booking-status-contact");
  var timeline = document.getElementById("booking-status-timeline");
  var proposedValue = document.getElementById("booking-status-proposed");
  var cancelButton = document.getElementById("booking-status-cancel");
  var acceptButton = document.getElementById("booking-status-accept");
  var rejectButton = document.getElementById("booking-status-reject");
  var apiBase = shell && shell.getAttribute
    ? shell.getAttribute("data-api-base-url") || ""
    : "";
  var verifiedPhone = "";
  var currentCode = "";
  var actionVersion = null;

  function showMessage(text) {
    if (!message) return;
    message.textContent = text;
    message.hidden = !text;
  }

  function hideActions() {
    if (cancelButton) cancelButton.hidden = true;
    if (acceptButton) acceptButton.hidden = true;
    if (rejectButton) rejectButton.hidden = true;
  }

  function statusLabel(status) {
    var labels = {
      pending: "待工作人员确认",
      confirmed: "已确认",
      reschedule_proposed: "等待确认改期",
      cancelled: "已取消",
      completed: "已完成",
    };
    return labels[status] || "状态更新中";
  }

  function modeLabel(mode) {
    if (mode === "open") return "散客拼场";
    if (mode === "private") return "包场独享";
    return "预约模式待确认";
  }

  function durationHours(startTime, endTime) {
    var startMatch = /^(\d{2}):(\d{2})$/.exec(startTime || "");
    var endMatch = /^(\d{2}):(\d{2})$/.exec(endTime || "");
    var minutes;
    if (!startMatch || !endMatch) return 0;
    minutes =
      Number(endMatch[1]) * 60 +
      Number(endMatch[2]) -
      Number(startMatch[1]) * 60 -
      Number(startMatch[2]);
    return minutes > 0 && minutes % 60 === 0 ? minutes / 60 : 0;
  }

  function renderTimeline(status) {
    var entries = ["预约已提交"];
    var index;
    var item;
    if (status === "pending") entries.push("等待工作人员确认");
    if (status === "confirmed") entries.push("预约已确认");
    if (status === "reschedule_proposed") {
      entries.push("工作人员提出改期");
      entries.push("等待您的选择");
    }
    if (status === "cancelled") entries.push("预约已取消");
    if (status === "completed") {
      entries.push("预约已确认");
      entries.push("活动已完成");
    }
    if (!timeline) return;
    while (timeline.firstChild) timeline.removeChild(timeline.firstChild);
    for (index = 0; index < entries.length; index += 1) {
      item = document.createElement("li");
      item.textContent = entries[index];
      timeline.appendChild(item);
    }
  }

  function renderBooking(data) {
    var cancelDeadline;
    var cancellable = false;
    var contact = [];
    var proposed;
    var hours;
    if (!data || typeof data !== "object") return false;
    if (typeof data.code !== "string" || typeof data.status !== "string") return false;
    if (typeof data.actionVersion !== "number") return false;

    currentCode = data.code;
    actionVersion = data.actionVersion;
    if (statusValue) statusValue.textContent = statusLabel(data.status);
    if (sessionValue) {
      hours = durationHours(data.startTime, data.endTime);
      sessionValue.textContent =
        (data.date || "日期待确认") +
        " · " +
        (data.startTime || "--:--") +
        "–" +
        (data.endTime || "--:--") +
        (hours ? "（" + hours + " 小时，北京时间）" : "（北京时间）");
    }
    if (modeValue) modeValue.textContent = modeLabel(data.mode);
    if (partySizeValue) partySizeValue.textContent = String(data.partySize || "-") + " 人";
    if (typeof data.name === "string" && data.name) contact.push(data.name);
    if (typeof data.phone === "string" && data.phone) contact.push(data.phone);
    if (contactValue) contactValue.textContent = contact.join(" · ") || "已验证预留手机号";
    renderTimeline(data.status);

    proposed = data.proposed;
    if (proposedValue) {
      if (data.status === "reschedule_proposed" && proposed) {
        hours = durationHours(proposed.startTime, proposed.endTime);
        proposedValue.textContent =
          "建议改至 " +
          (proposed.date || "日期待确认") +
          " · " +
          (proposed.startTime || "--:--") +
          "–" +
          (proposed.endTime || "--:--") +
          (hours ? " · " + hours + " 小时（北京时间）" : "（北京时间）");
        proposedValue.hidden = false;
      } else {
        proposedValue.textContent = "";
        proposedValue.hidden = true;
      }
    }

    cancelDeadline = Date.parse(data.canCancelUntil || "");
    cancellable =
      data.canCancel === true &&
      !isNaN(cancelDeadline) &&
      new Date().getTime() < cancelDeadline;
    hideActions();
    if (cancelButton) cancelButton.hidden = !cancellable;
    if (data.status === "reschedule_proposed" && proposed) {
      if (acceptButton) acceptButton.hidden = false;
      if (rejectButton) rejectButton.hidden = false;
    }
    if (result) result.hidden = false;
    return true;
  }

  function sendJson(url, body, callback) {
    var request;
    try {
      request = new XMLHttpRequest();
      request.open("POST", url, true);
      request.setRequestHeader("Accept", "application/json");
      request.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
      request.onreadystatechange = function () {
        var payload = null;
        if (request.readyState !== 4) return;
        try {
          payload = window.JSON.parse(request.responseText || "{}");
        } catch (error) {
          void error;
        }
        callback(request.status, payload);
      };
      request.onerror = function () {
        callback(0, null);
      };
      request.ontimeout = request.onerror;
      request.send(window.JSON.stringify(body));
    } catch (error) {
      void error;
      callback(0, null);
    }
  }

  function lookupFailure(status) {
    verifiedPhone = "";
    currentCode = "";
    actionVersion = null;
    hideActions();
    if (result) result.hidden = true;
    if (status === 429) {
      showMessage("操作较频繁，请稍后再试。");
    } else if (status === 0) {
      showMessage("查询暂未完成，请检查网络后重试。");
    } else {
      showMessage("无法查询预约，请检查输入后稍后再试。");
    }
  }

  function submitLookup(event) {
    var code;
    var phone;
    if (form.checkValidity && !form.checkValidity()) return;
    if (event && event.preventDefault) event.preventDefault();
    code = (codeInput.value || "").replace(/^\s+|\s+$/g, "");
    phone = (phoneInput.value || "").replace(/^\s+|\s+$/g, "");
    if (!code || !phone) {
      lookupFailure(400);
      return;
    }
    hideActions();
    showMessage("正在安全查询…");
    sendJson(apiBase + "/v1/bookings/lookup", { code: code, phone: phone }, function (status, payload) {
      if (status === 200 && payload && renderBooking(payload.data)) {
        verifiedPhone = phone;
        currentCode = payload.data.code;
        phoneInput.value = "";
        showMessage("");
        return;
      }
      lookupFailure(status);
    });
  }

  function actionFailure(status) {
    hideActions();
    if (status === 409) {
      showMessage("预约状态已更新，请重新查询后再操作。");
    } else if (status === 429) {
      showMessage("操作较频繁，请稍后再试。");
    } else {
      showMessage("操作暂未完成，请重新查询预约状态后再试。");
    }
  }

  function sendAction(kind, accept) {
    var url;
    var body;
    if (!verifiedPhone || !currentCode || typeof actionVersion !== "number") {
      actionFailure(409);
      return;
    }
    body = {
      code: currentCode,
      phone: verifiedPhone,
      expectedVersion: actionVersion,
    };
    if (kind === "cancel") {
      url = apiBase + "/v1/bookings/" + encodeURIComponent(currentCode) + "/cancel";
    } else {
      url =
        apiBase +
        "/v1/bookings/" +
        encodeURIComponent(currentCode) +
        "/reschedule-response";
      body.accept = accept === true;
    }
    hideActions();
    showMessage("正在提交操作…");
    sendJson(url, body, function (status, payload) {
      if (status === 200 && payload && renderBooking(payload.data)) {
        showMessage("操作已完成，状态已更新。");
        return;
      }
      actionFailure(status);
    });
  }

  function prefillCode() {
    var search = window.location && window.location.search
      ? window.location.search.replace(/^\?/, "").split("&")
      : [];
    var index;
    var pair;
    var key;
    for (index = 0; index < search.length; index += 1) {
      pair = search[index].split("=");
      try {
        key = decodeURIComponent(pair[0] || "");
      } catch (error) {
        void error;
        continue;
      }
      if (key === "code") {
        try {
          codeInput.value = decodeURIComponent(
            (pair.slice(1).join("=") || "").replace(/\+/g, " ")
          );
        } catch (error) {
          void error;
        }
        return;
      }
    }
  }

  if (!shell || !form || !codeInput || !phoneInput || !message) return;
  if (!apiBase || !window.XMLHttpRequest || !window.JSON) {
    form.hidden = true;
    showMessage("查询服务暂不可用，请稍后再试或联系我们。");
    return;
  }

  apiBase = apiBase.replace(/\/+$/, "");
  hideActions();
  prefillCode();
  form.addEventListener("submit", submitLookup);
  if (cancelButton) {
    cancelButton.addEventListener("click", function () {
      sendAction("cancel", false);
    });
  }
  if (acceptButton) {
    acceptButton.addEventListener("click", function () {
      sendAction("reschedule", true);
    });
  }
  if (rejectButton) {
    rejectButton.addEventListener("click", function () {
      sendAction("reschedule", false);
    });
  }
})();
