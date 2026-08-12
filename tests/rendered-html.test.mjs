import assert from "node:assert/strict";
import test from "node:test";
import { resolvePagesBasePath } from "../app/site-config.ts";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server renders the real booking form and current venue contract", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const basePath = resolvePagesBasePath(process.env.PAGES_BASE_PATH);
  const apiBaseUrl = process.env.NEXT_PUBLIC_BOOKING_API_BASE_URL;
  assert.ok(apiBaseUrl, "configured rendering requires a booking API base URL");
  assert.match(html, /<form[^>]+id="booking-form"[^>]+method="post"/i);
  assert.ok(html.includes(`action="${apiBaseUrl}/v1/bookings"`));
  assert.ok(
    html.includes(`data-availability-url="${apiBaseUrl}/v1/availability/windows"`),
  );
  assert.ok(
    html.includes(`data-booking-result-path="${basePath}/booking/result/"`),
  );
  assert.ok(
    html.includes(`data-booking-status-path="${basePath}/booking/status/"`),
  );
  assert.match(html, /name="mode"[^>]+value="open"/);
  assert.match(html, /name="mode"[^>]+value="private"/);
  assert.match(html, /name="date"/);
  assert.match(html, /<select(?=[^>]*name="start_time")(?![^>]*disabled)/i);
  assert.match(html, /<select(?=[^>]*name="end_time")(?![^>]*disabled)/i);
  assert.match(
    html,
    /<input(?=[^>]*name="session_id")(?=[^>]*type="hidden")[^>]*>/i,
  );
  assert.match(html, /name="party_size"/);
  assert.match(html, /<option(?=[^>]*value="1")[^>]*>1 位<\/option>/);
  assert.match(html, /<option(?=[^>]*value="4")[^>]*>4 位<\/option>/);
  assert.doesNotMatch(
    html,
    /<option(?=[^>]*value="[5-9]")[^>]*>[5-9] 位<\/option>/,
  );
  assert.match(html, /name="name"/);
  assert.match(html, /name="phone"/);
  assert.doesNotMatch(html, /name="email"|电子邮箱/i);
  assert.match(html, /<textarea(?=[^>]*name="note")(?![^>]*required)[^>]*>/i);
  assert.match(html, /name="privacy_consent"/);
  assert.match(
    html,
    /<input(?=[^>]*name="idempotency_key")(?=[^>]*type="hidden")[^>]*>/i,
  );
  assert.match(html, /name="website"/);
  assert.match(html, />09:00<\/option>/);
  assert.match(html, />09:30<\/option>/);
  assert.match(html, /北京时间/);
  assert.match(html, /整小时计费/);
  assert.match(html, /09:00 — 22:00/);
  assert.match(html, /11 片/);
  assert.match(html, /提交后等待工作人员确认/);
  assert.doesNotMatch(html, /Formspree|07:00 — 23:00|1—8|六片/);
  assert.match(html, /<script[^>]+data-booking-form-client[^>]+defer/);
  assert.match(html, /data-homepage-media(?:="")?/);
  assert.match(html, /data-homepage-media-list(?:="")?/);
  assert.match(html, /<script[^>]+data-homepage-media-client[^>]+defer/);
  assert.match(html, /<script[^>]+data-wechat-entry-client[^>]+defer/);
  assert.match(html, /data-public-channel-page="booking"/);
  assert.match(html, /data-wechat-menu-booking-url=/);
  assert.match(html, /data-wechat-qr-booking-url=/);
  assert.match(html, /DAILY MOMENTS/);
  assert.match(html, /<title>睿安成 PICKLE CLUB/);
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
    assert.ok(html.includes(content), `rendered page is missing: ${content}`);
  }
  assert.equal((html.match(/class="honor-row"/g) ?? []).length, 7);
  for (const index of ["01", "02", "03", "04", "05", "06", "07"]) {
    assert.match(html, new RegExp(`class="honor-index"[^>]*>${index}<`));
  }
  assert.match(html, /江西省南昌市青山湖区青山湖南大道260号14号楼/);
  assert.match(html, /13807917663/);
  assert.match(
    html,
    /<img(?=[^>]*alt="睿安成 PICKLE CLUB 南昌匹克球馆主视觉")(?=[^>]*src="[^"]*\/ruiancheng-court-hero\.png")(?=[^>]*width="1672")(?=[^>]*height="941")[^>]*>/,
  );
  assert.doesNotMatch(html, /澄场|CHENGCHANG|上海市徐汇区|社交媒体|演示资料|毛之谦|荣誉留待书写|暂为空/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/);
});
