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
    html.includes(`data-availability-url="${apiBaseUrl}/v1/availability"`),
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
  assert.match(html, /<input(?=[^>]*name="email")(?![^>]*required)[^>]*>/i);
  assert.match(html, /<textarea(?=[^>]*name="note")(?![^>]*required)[^>]*>/i);
  assert.match(html, /name="privacy_consent"/);
  assert.match(
    html,
    /<input(?=[^>]*name="idempotency_key")(?=[^>]*type="hidden")[^>]*>/i,
  );
  assert.match(html, /name="website"/);
  assert.match(html, />07:00<\/option>/);
  assert.match(html, />22:00<\/option>/);
  assert.match(html, /60 分钟/);
  assert.match(html, /11 片/);
  assert.match(html, /提交后等待工作人员确认/);
  assert.doesNotMatch(html, /Formspree|90 分钟|1—8|六片/);
  assert.match(html, /<script[^>]+data-booking-form-client[^>]+defer/);
  assert.match(html, /<title>澄场 PICKLE CLUB/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/);
});
