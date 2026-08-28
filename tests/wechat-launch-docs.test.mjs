import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test("WeChat menu template matches the manually published content structure", async () => {
  const source = await readFile(
    projectFile("docs/wechat-menu-template.json"),
    "utf8",
  );
  const template = JSON.parse(source);

  assert.deepEqual(template.menu.map(({ name }) => name), [
    "预约场地",
    "球馆动态",
    "联系我们",
  ]);
  assert.deepEqual(
    template.menu[1].submenus.map(({ name }) => name),
    ["每日动态", "教练团队", "赛事荣誉", "球馆介绍"],
  );
  assert.equal(template.menu[0].action, "send_message");
  assert.match(template.menu[0].content, /\{\{BOOKING_MENU_URL\}\}/);
  assert.doesNotMatch(
    JSON.stringify(template.menu[1].submenus),
    /预约场地/,
  );
  assert.equal(template.menu[2].action, "send_message");
  assert.match(template.menu[2].content, /刘华/);
  assert.match(template.menu[2].content, /13807917663/);
  assert.match(template.menu[2].content, /青山湖南大道260号14号楼/);
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
