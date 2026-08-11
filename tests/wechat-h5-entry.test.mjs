import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PUBLIC_BOOKING_ANCHOR,
  PUBLIC_CHANNEL_QUERY_PARAMETER,
  WECHAT_MENU_CHANNEL,
  WECHAT_QR_CHANNEL,
  buildPublicBookingEntryUrl,
  buildPublicBookingStatusUrl,
  resolvePublicChannelSource,
  sanitizePublicChannelPath,
} from "../app/wechat-entry.ts";

test("only the two non-sensitive WeChat channel values are accepted", () => {
  assert.equal(resolvePublicChannelSource("wx_menu"), WECHAT_MENU_CHANNEL);
  assert.equal(resolvePublicChannelSource("wx_qr"), WECHAT_QR_CHANNEL);

  for (const value of [
    "",
    "WX_MENU",
    "openid",
    "13807917663",
    "wx_menu&openid=secret",
    null,
    undefined,
  ]) {
    assert.equal(resolvePublicChannelSource(value), null, String(value));
  }
});

test("stable menu and QR entry URLs contain only the allowlisted source", () => {
  const siteUrl = "https://booking.example.com/pickle/";

  assert.equal(
    buildPublicBookingEntryUrl(siteUrl, WECHAT_MENU_CHANNEL),
    `https://booking.example.com/pickle/?${PUBLIC_CHANNEL_QUERY_PARAMETER}=wx_menu#${PUBLIC_BOOKING_ANCHOR}`,
  );
  assert.equal(
    buildPublicBookingEntryUrl(siteUrl, WECHAT_QR_CHANNEL),
    `https://booking.example.com/pickle/?${PUBLIC_CHANNEL_QUERY_PARAMETER}=wx_qr#${PUBLIC_BOOKING_ANCHOR}`,
  );
  assert.equal(
    buildPublicBookingStatusUrl(siteUrl, WECHAT_MENU_CHANNEL),
    "https://booking.example.com/pickle/booking/status/?src=wx_menu",
  );
});

test("channel propagation strips phone, openid and every unapproved query key", () => {
  assert.equal(
    sanitizePublicChannelPath(
      "/pickle/booking/status/?code=L3JSR8PC&phone=13807917663&openid=oSecret&campaign=summer#lookup",
      "https://booking.example.com/pickle/",
      WECHAT_MENU_CHANNEL,
      ["code"],
    ),
    "/pickle/booking/status/?code=L3JSR8PC&src=wx_menu#lookup",
  );

  assert.equal(
    sanitizePublicChannelPath(
      "/pickle/booking/result/?phone=13807917663&openid=oSecret",
      "https://booking.example.com/pickle/",
      WECHAT_QR_CHANNEL,
    ),
    "/pickle/booking/result/?src=wx_qr",
  );

  assert.throws(
    () =>
      sanitizePublicChannelPath(
        "https://attacker.example/collect?code=L3JSR8PC",
        "https://booking.example.com/pickle/",
        WECHAT_MENU_CHANNEL,
        ["code"],
      ),
    /public channel path/i,
  );
});

test("public pages expose copyable WeChat entry markers and load the bridge", async () => {
  const [home, result, status, layout, buildScript, exportScript] =
    await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/booking/result/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/booking/status/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../scripts/build-browser-clients.mjs", import.meta.url), "utf8"),
      readFile(new URL("../scripts/prepare-pages-output.mjs", import.meta.url), "utf8"),
    ]);

  assert.match(home, /data-public-channel-page="booking"/);
  assert.match(home, /data-wechat-menu-booking-url=/);
  assert.match(home, /data-wechat-qr-booking-url=/);
  assert.match(home, /data-wechat-menu-status-url=/);
  assert.match(home, /data-wechat-entry-client/);
  assert.match(home, /data-preserve-public-channel/);
  assert.match(result, /data-public-channel-page="result"/);
  assert.match(result, /data-preserve-public-channel="code"/);
  assert.match(result, /data-wechat-entry-client/);
  assert.match(status, /data-public-channel-page="status"/);
  assert.match(status, /data-wechat-entry-client/);
  assert.match(status, /data-preserve-public-channel/);
  assert.match(buildScript, /"wechat-entry"\s*:/);
  assert.match(exportScript, /data-wechat-entry-client/);

  assert.match(layout, /viewportFit:\s*"cover"/);
  assert.match(layout, /referrer:\s*"strict-origin-when-cross-origin"/);
  assert.match(layout, /siteName:\s*"睿安成 PICKLE CLUB"/);
  assert.doesNotMatch(`${home}\n${result}\n${status}\n${layout}`, /AppID|openid|unionid/i);
});

test("mobile CSS accounts for WeChat WebView safe areas and form zoom", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  assert.match(css, /-webkit-text-size-adjust:\s*100%/);
  assert.match(css, /viewport-fit|safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /min-height:\s*100dvh/);
  assert.match(css, /touch-action:\s*manipulation/);
  assert.match(css, /font-size:\s*16px;\s*\/\* WeChat form zoom guard \*\//);
});
