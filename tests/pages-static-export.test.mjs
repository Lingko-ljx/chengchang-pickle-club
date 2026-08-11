import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rawBasePath = process.env.PAGES_BASE_PATH ?? "/chengchang-pickle-club";
const basePath = rawBasePath === "/" ? "" : rawBasePath.replace(/\/+$/, "");
const parsedSiteUrl = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ??
    "https://lingko-ljx.github.io/chengchang-pickle-club/",
);
if (!parsedSiteUrl.pathname.endsWith("/")) {
  parsedSiteUrl.pathname = `${parsedSiteUrl.pathname}/`;
}
const siteUrl = parsedSiteUrl.toString();
const cloudbaseEnvId =
  process.env.NEXT_PUBLIC_CLOUDBASE_ENV_ID ?? "booking-test-000000";
const prefixed = (pathname) => `${basePath}${pathname}`;

test("exports the real booking form without a framework client runtime", async () => {
  const html = await readFile(
    new URL("../out/index.html", import.meta.url),
    "utf8",
  );
  const apiBaseUrl = process.env.NEXT_PUBLIC_BOOKING_API_BASE_URL?.replace(
    /\/+$/,
    "",
  );

  assert.ok(apiBaseUrl, "Pages verification requires the booking API base URL");

  assert.match(html, /睿安成 PICKLE CLUB/);
  for (const content of [
    "总教头",
    "刘栖睿",
    "特约嘉宾",
    "唐语彤",
    "普通教练",
    "曾海鑫",
    "毛智谦",
    "刘洋",
    "邹洪武",
    "PPA 杭州站 19+ 男子单打 3.5+ 亚军",
    "CPC600 兰威杯男子单打冠军",
    "WPC 海南站 4.0 男双冠军",
    "WPC 海南站 3.5 混双冠军",
    "CPC600 鹤壁浚县站男双冠军",
    "CPC600 河北石家庄站混双冠军",
    "APBA 全球总决赛男单季军",
  ]) {
    assert.ok(html.includes(content), `static page is missing: ${content}`);
  }
  assert.equal((html.match(/class="honor-row"/g) ?? []).length, 7);
  for (const index of ["01", "02", "03", "04", "05", "06", "07"]) {
    assert.match(html, new RegExp(`class="honor-index"[^>]*>${index}<`));
  }
  assert.match(html, /江西省南昌市青山湖区青山湖南大道260号14号楼/);
  assert.match(html, /13807917663/);
  assert.ok(html.includes(`src="${prefixed("/ruiancheng-court-hero.png")}"`));
  assert.doesNotMatch(html, /澄场|CHENGCHANG|上海市徐汇区|社交媒体|演示资料|毛之谦|荣誉留待书写|暂为空/);
  assert.ok(html.includes(`${prefixed("/_next/")}`));
  if (basePath) assert.doesNotMatch(html, /(?:href|src)="\/_next\//);
  assert.ok(html.includes(`action="${apiBaseUrl}/v1/bookings"`));
  assert.ok(
    html.includes(
      `data-availability-url="${apiBaseUrl}/v2/availability"`,
    ),
  );
  assert.match(
    html,
    new RegExp(`data-booking-result-path="${prefixed("/booking/result/")}"`),
  );
  assert.match(
    html,
    new RegExp(`data-booking-status-path="${prefixed("/booking/status/")}"`),
  );
  assert.match(html, /name="session_id"/);
  assert.match(html, /name="end_time"/);
  assert.match(html, /北京时间/);
  assert.match(html, /09:00 — 22:00/);
  assert.match(html, /name="idempotency_key"/);
  assert.doesNotMatch(html, /Formspree|07:00 — 23:00|1—8|六片/);
  assert.ok(html.includes(`src="${prefixed("/booking-form.js")}"`));
  assert.ok(html.includes(`src="${prefixed("/homepage-media.js")}"`));
  assert.match(html, /data-homepage-media(?:="")?/);
  assert.match(html, /data-homepage-media-list(?:="")?/);
  assert.doesNotMatch(html, /_next\/static\/chunks\/[^"]+\.js/);
  assert.doesNotMatch(html, /self\.__next|__next_f|modulepreload/);
  assert.ok(html.includes(`<link rel="canonical" href="${siteUrl}"`));
  assert.ok(html.includes(`<meta property="og:url" content="${siteUrl}"`));
  assert.ok(
    html.includes(
      `<meta property="og:image" content="${new URL("og.png", siteUrl)}"`,
    ),
  );
  assert.match(html, /<meta property="og:image:width" content="1672"/);
  assert.match(html, /<meta property="og:image:height" content="941"/);
  assert.match(html, /<meta property="og:image:alt" content="[^"]+"/);

  const scriptTags = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
  assert.equal(scriptTags.length, 2);
  assert.ok(scriptTags.some((script) => /data-booking-form-client/.test(script)));
  assert.ok(scriptTags.some((script) => /data-homepage-media-client/.test(script)));
});

test("exports result and status pages with only their ES5 clients", async () => {
  const pages = [
    {
      file: "../out/booking/result/index.html",
      marker: /id="booking-result-shell"/,
      script: `src="${prefixed("/booking-result.js")}"`,
      client: /data-booking-result-client/,
    },
    {
      file: "../out/booking/status/index.html",
      marker: /id="booking-status-shell"/,
      script: `src="${prefixed("/booking-status.js")}"`,
      client: /data-booking-status-client/,
    },
  ];

  for (const page of pages) {
    const html = await readFile(new URL(page.file, import.meta.url), "utf8");
    assert.match(html, page.marker);
    assert.ok(html.includes(page.script));
    assert.doesNotMatch(html, /_next\/static\/chunks\/[^\"]+\.js/);
    assert.doesNotMatch(html, /self\.__next|__next_f|modulepreload/);
    const scripts = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0], page.client);
  }
});

test("exports the admin shell with only its generated client", async () => {
  const html = await readFile(new URL("../out/admin/index.html", import.meta.url), "utf8");
  const client = await readFile(new URL("../out/admin-app.js", import.meta.url), "utf8");
  const apiBaseUrl = process.env.NEXT_PUBLIC_BOOKING_API_BASE_URL?.replace(
    /\/+$/,
    "",
  );
  assert.ok(apiBaseUrl, "Pages verification requires the booking API base URL");
  assert.match(html, /id="admin-login-form"/);
  assert.ok(html.includes(`data-api-base-url="${apiBaseUrl}"`));
  assert.ok(html.includes(`data-cloudbase-env-id="${cloudbaseEnvId}"`));
  assert.ok(html.includes(`src="${prefixed("/admin-app.js")}"`));
  assert.doesNotMatch(html, /_next\/static\/chunks\/[^\"]+\.js|self\.__next|__next_f|modulepreload/);
  const scripts = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /data-admin-client/);
  assert.match(client, /^"use strict";/);
  assert.doesNotMatch(
    `${html}\n${client}`,
    /BOOKING_ADMIN_USER_IDS|BOOKING_SES_SECRET|TENCENTCLOUD_SECRET|PHONE_HASH_SALT|RATE_LIMIT_SALT|IDEMPOTENCY_SALT|AKID[A-Za-z0-9]+/,
  );
});

test("status form cannot place the reserved phone in a native URL submission", async () => {
  const html = await readFile(
    new URL("../out/booking/status/index.html", import.meta.url),
    "utf8",
  );
  const form = html.match(/<form\b[\s\S]*?<\/form>/i)?.[0] ?? "";
  const codeInput =
    form.match(/<input\b(?=[^>]*\bid="booking-status-code")[^>]*>/i)?.[0] ?? "";
  const phoneInput =
    form.match(/<input\b(?=[^>]*\bid="booking-status-phone")[^>]*>/i)?.[0] ?? "";

  assert.match(form, /\bmethod="post"/i);
  assert.match(
    form,
    new RegExp(`\\baction="${prefixed("/booking/status/")}"`, "i"),
  );
  assert.match(codeInput, /\bid="booking-status-code"/i);
  assert.match(phoneInput, /\bid="booking-status-phone"/i);
  assert.doesNotMatch(codeInput, /\bname=/i);
  assert.doesNotMatch(phoneInput, /\bname=/i);
});
