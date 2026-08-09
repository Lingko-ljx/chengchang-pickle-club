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
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/lingko-ljx\.github\.io\/chengchang-pickle-club\/"/,
  );
  assert.match(
    html,
    /<meta property="og:url" content="https:\/\/lingko-ljx\.github\.io\/chengchang-pickle-club\/"/,
  );
  assert.match(
    html,
    /<meta property="og:image" content="https:\/\/lingko-ljx\.github\.io\/chengchang-pickle-club\/og\.png"/,
  );
  assert.match(html, /<meta property="og:image:width" content="1734"/);
  assert.match(html, /<meta property="og:image:height" content="907"/);
  assert.match(html, /<meta property="og:image:alt" content="[^"]+"/);

  const scriptTags = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
  assert.equal(scriptTags.length, 1);
  assert.match(scriptTags[0], /data-booking-form-client/);
});

test("exports result and status pages with only their ES5 clients", async () => {
  const pages = [
    {
      file: "../out/booking/result/index.html",
      marker: /id="booking-result-shell"/,
      script: /src="\/chengchang-pickle-club\/booking-result\.js"/,
      client: /data-booking-result-client/,
    },
    {
      file: "../out/booking/status/index.html",
      marker: /id="booking-status-shell"/,
      script: /src="\/chengchang-pickle-club\/booking-status\.js"/,
      client: /data-booking-status-client/,
    },
  ];

  for (const page of pages) {
    const html = await readFile(new URL(page.file, import.meta.url), "utf8");
    assert.match(html, page.marker);
    assert.match(html, page.script);
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
  assert.match(html, /id="admin-login-form"/);
  assert.match(html, /src="\/chengchang-pickle-club\/admin-app\.js"/);
  assert.doesNotMatch(html, /_next\/static\/chunks\/[^\"]+\.js|self\.__next|__next_f|modulepreload/);
  const scripts = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /data-admin-client/);
  assert.match(client, /^"use strict";/);
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
    /\baction="\/chengchang-pickle-club\/booking\/status\/"/i,
  );
  assert.match(codeInput, /\bid="booking-status-code"/i);
  assert.match(phoneInput, /\bid="booking-status-phone"/i);
  assert.doesNotMatch(codeInput, /\bname=/i);
  assert.doesNotMatch(phoneInput, /\bname=/i);
});
