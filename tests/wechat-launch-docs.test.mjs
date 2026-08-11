import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test("WeChat menu template is account-independent and public-only", async () => {
  const source = await readFile(
    projectFile("docs/wechat-menu-template.json"),
    "utf8",
  );
  const template = JSON.parse(source);

  assert.deepEqual(
    template.button.map(({ name, type }) => ({ name, type })),
    [
      { name: "预约场地", type: "view" },
      { name: "球馆动态", type: "view" },
      { name: "联系我们", type: "view" },
    ],
  );
  assert.deepEqual(
    template.button.map(({ url }) => url),
    [
      "{{BOOKING_MENU_URL}}",
      "{{DAILY_MENU_URL}}",
      "{{CONTACT_MENU_URL}}",
    ],
  );
  assert.doesNotMatch(source, /\/admin\/|AppSecret|access[_ -]?token|openid/i);
});

test("WeChat launch runbook keeps deferred credentials out of the repository", async () => {
  const [readme, runbook] = await Promise.all([
    readFile(projectFile("README.md"), "utf8"),
    readFile(projectFile("docs/wechat-official-account-launch.md"), "utf8"),
  ]);

  assert.match(readme, /docs\/wechat-official-account-launch\.md/);
  assert.match(readme, /docs\/wechat-menu-template\.json/);
  assert.match(runbook, /公众号二维码/);
  assert.match(runbook, /预约网页二维码/);
  assert.match(runbook, /iOS/);
  assert.match(runbook, /Android/);
  assert.match(runbook, /OAuth/);
  assert.match(runbook, /JS-SDK/);
  assert.match(runbook, /PUBLIC_ALLOWED_ORIGINS/);
  assert.match(runbook, /src=wx_menu/);
  assert.match(runbook, /src=wx_qr/);
  assert.doesNotMatch(runbook, /src=wechat_(?:menu|qr)/);
  assert.match(runbook, /不要.*AppSecret|永远不把 AppSecret/);
  assert.match(runbook, /不要.*\/admin\/|永远不在.*\/admin\//);
  assert.doesNotMatch(runbook, /appid\s*[=:]\s*[A-Za-z0-9_-]{8,}/i);
});
