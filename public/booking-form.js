(function () {
  var form = document.getElementById("booking-form");
  var errorBox = document.getElementById("booking-error");
  var successBox = document.getElementById("booking-success");

  if (!form || !window.XMLHttpRequest || !window.FormData) {
    return;
  }

  var submitButton = form.querySelector('button[type="submit"]');

  function finishRequest() {
    if (submitButton) {
      submitButton.disabled = false;
    }
  }

  function showError(message) {
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    if (successBox) {
      successBox.hidden = true;
    }
  }

  form.addEventListener("submit", function (event) {
    if (form.checkValidity && !form.checkValidity()) {
      return;
    }

    event.preventDefault();

    if (submitButton) {
      submitButton.disabled = true;
    }
    if (errorBox) {
      errorBox.hidden = true;
    }

    var request = new XMLHttpRequest();
    request.open("POST", form.action, true);
    request.setRequestHeader("Accept", "application/json");

    request.onreadystatechange = function () {
      if (request.readyState !== 4) {
        return;
      }

      finishRequest();

      if (request.status >= 200 && request.status < 300) {
        form.reset();
        if (successBox) {
          successBox.hidden = false;
          successBox.focus();
        }
        return;
      }

      if (request.status === 429) {
        showError("提交较频繁，请稍后再试或电话联系我们。");
        return;
      }

      showError("提交未成功，请检查网络后重试或电话联系我们。");
    };

    request.onerror = function () {
      finishRequest();
      showError("网络连接失败，表单内容已保留，请稍后重试。");
    };

    request.send(new FormData(form));
  });
})();
