(function () {
  var shell = document.getElementById("booking-result-shell");
  var codeNode = document.getElementById("booking-result-code");
  var secureCodeNode = document.getElementById("booking-result-secure-code");
  var statusLink = document.getElementById("booking-result-status-link");
  var search = window.location && window.location.search
    ? window.location.search.replace(/^\?/, "").split("&")
    : [];
  var fragment = window.location && window.location.hash
    ? window.location.hash.replace(/^#/, "").split("&")
    : [];
  var code = "";
  var displayCode = "";
  var basePath = shell && shell.getAttribute
    ? shell.getAttribute("data-site-base-path") || ""
    : "";
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
        code = decodeURIComponent((pair.slice(1).join("=") || "").replace(/\+/g, " "));
      } catch (error) {
        void error;
        code = "";
      }
    }
  }

  for (index = 0; index < fragment.length; index += 1) {
    pair = fragment[index].split("=");
    try {
      key = decodeURIComponent(pair[0] || "");
      if (key === "display_code") {
        displayCode = decodeURIComponent((pair.slice(1).join("=") || "").replace(/\+/g, " "));
      }
    } catch (error) {
      void error;
      displayCode = "";
    }
  }

  if (!/^\d{4}$/.test(displayCode)) displayCode = "";
  if (codeNode) codeNode.textContent = displayCode || "未获取到预约编号";
  if (secureCodeNode) secureCodeNode.textContent = code || "未获取到安全查询码";
  if (statusLink) {
    statusLink.href =
      basePath.replace(/\/+$/, "") +
      "/booking/status/" +
      (code ? "?code=" + encodeURIComponent(code) : "");
  }
})();
