(function () {
  var root = document.getElementById("public-schedule");
  var dateInput = document.getElementById("booking-date");
  var list = document.getElementById("public-schedule-list");
  var summary = document.getElementById("public-schedule-summary");
  var status = document.getElementById("public-schedule-status");
  var endpoint = root && root.getAttribute
    ? root.getAttribute("data-public-schedule-url") || ""
    : "";
  var generation = 0;

  if (!root || !dateInput || !list || !summary || !status || !endpoint) return;

  function localDate() {
    var now = new Date();
    var shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
  }

  function validDate(value) {
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

  function clearList() {
    list.textContent = "";
    if (list.children && list.children.length && list.removeChild) {
      while (list.children.length) list.removeChild(list.children[0]);
    }
  }

  function itemText(item) {
    if (item.kind === "staff_reservation") {
      return item.startTime + "–" + item.endTime + " · 单位包场";
    }
    var mode = item.mode === "private" ? "包场" : "散客拼场";
    return item.startTime + "–" + item.endTime + " · " + mode + " · " + item.partySize + " 位";
  }

  function render(payload) {
    var items = payload && payload.items && typeof payload.items.length === "number"
      ? payload.items
      : [];
    var index;
    var article;
    var name;
    var detail;
    clearList();
    summary.textContent = "已有 " + Number(payload.bookingCount || 0) + " 场安排";
    if (Number(payload.participantCount || 0) > 0) {
      summary.textContent += " · " + Number(payload.participantCount || 0) + " 位球友";
    }
    if (Number(payload.staffReservationCount || 0) > 0) {
      summary.textContent += " · " + Number(payload.staffReservationCount || 0) + " 场单位包场";
    }
    if (!items.length) {
      status.textContent = "这一天还没有公开预约，欢迎来开第一场。";
      return;
    }
    status.textContent = "仅展示脱敏称呼与打球时间，联系方式始终保密。";
    for (index = 0; index < items.length; index += 1) {
      article = document.createElement("article");
      article.className = "public-schedule-item";
      name = document.createElement("strong");
      name.textContent = String(items[index].name || "球友**");
      detail = document.createElement("span");
      detail.textContent = itemText(items[index]);
      article.appendChild(name);
      article.appendChild(detail);
      list.appendChild(article);
    }
  }

  function fail(activeGeneration) {
    if (activeGeneration !== generation) return;
    clearList();
    summary.textContent = "预约热度暂未刷新";
    status.textContent = "你仍可正常选择日期和提交预约。";
  }

  function load() {
    var date = validDate(dateInput.value) ? dateInput.value : localDate();
    var request;
    var activeGeneration;
    generation += 1;
    activeGeneration = generation;
    request = new XMLHttpRequest();
    request.open("GET", endpoint + "?date=" + encodeURIComponent(date), true);
    request.setRequestHeader("Accept", "application/json");
    request.onreadystatechange = function () {
      var body;
      if (request.readyState !== 4 || activeGeneration !== generation) return;
      if (request.status !== 200) {
        fail(activeGeneration);
        return;
      }
      try {
        body = window.JSON.parse(request.responseText);
        render(body && body.data ? body.data : {});
      } catch (error) {
        void error;
        fail(activeGeneration);
      }
    };
    request.onerror = function () { fail(activeGeneration); };
    request.ontimeout = request.onerror;
    request.send(null);
  }

  dateInput.addEventListener("change", load);
  load();
})();
