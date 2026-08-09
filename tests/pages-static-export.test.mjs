import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("exports the real booking form without a framework client runtime", async () => {
  const html = await readFile(
    new URL("../out/index.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /\u6f84\u573a PICKLE CLUB/);
  assert.match(html, /\/chengchang-pickle-club\/_next\//);
  assert.doesNotMatch(html, /(?:href|src)="\/_next\//);
  assert.match(
    html,
    /action="https:\/\/booking-api\.example\.invalid\/v1\/bookings"/,
  );
  assert.match(
    html,
    /data-availability-url="https:\/\/booking-api\.example\.invalid\/v1\/availability"/,
  );
  assert.match(
    html,
    /data-booking-result-path="\/chengchang-pickle-club\/booking\/result\/"/,
  );
  assert.match(
    html,
    /data-booking-status-path="\/chengchang-pickle-club\/booking\/status\/"/,
  );
  assert.match(html, /name="session_id"/);
  assert.match(html, /name="idempotency_key"/);
  assert.doesNotMatch(html, /Formspree|90 分钟|1—8|六片/);
  assert.match(
    html,
    /src="\/chengchang-pickle-club\/booking-form\.js"/,
  );
  assert.doesNotMatch(html, /_next\/static\/chunks\/[^"]+\.js/);
  assert.doesNotMatch(html, /self\.__next|__next_f|modulepreload/);

  const scriptTags = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
  assert.equal(scriptTags.length, 1);
  assert.match(scriptTags[0], /data-booking-form-client/);
});
