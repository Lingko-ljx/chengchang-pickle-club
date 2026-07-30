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
    var request;

    if (form.checkValidity && !form.checkValidity()) {
      return;
    }

    if (submitButton) {
      submitButton.disabled = true;
    }
    if (errorBox) {
      errorBox.hidden = true;
    }
    if (successBox) {
      successBox.hidden = true;
    }

    try {
      request = new XMLHttpRequest();
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
          showError("\u63d0\u4ea4\u8f83\u9891\u7e41\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u6216\u7535\u8bdd\u8054\u7cfb\u6211\u4eec\u3002");
          return;
        }

        showError("\u63d0\u4ea4\u672a\u6210\u529f\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5\u6216\u7535\u8bdd\u8054\u7cfb\u6211\u4eec\u3002");
      };

      request.onerror = function () {
        finishRequest();
        showError("\u7f51\u7edc\u8fde\u63a5\u5931\u8d25\uff0c\u8868\u5355\u5185\u5bb9\u5df2\u4fdd\u7559\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u6216\u7535\u8bdd\u8054\u7cfb\u6211\u4eec\u3002");
      };

      request.send(new FormData(form));
      event.preventDefault();
    } catch (error) {
      void error;
      finishRequest();
    }
  });
})();
