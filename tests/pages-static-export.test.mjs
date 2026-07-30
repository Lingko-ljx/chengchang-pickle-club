import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("exports a script-light GitHub Pages homepage", async () => {
  const html = await readFile(
    new URL("../out/index.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /\u6f84\u573a PICKLE CLUB/);
  assert.match(html, /\/chengchang-pickle-club\/_next\//);
  assert.doesNotMatch(html, /(?:href|src)="\/_next\//);
  assert.match(
    html,
    /action="https:\/\/formspree\.io\/f\/testcontract"/,
  );
  assert.match(html, /name="privacy_consent"/);
  assert.match(
    html,
    /src="\/chengchang-pickle-club\/booking-form\.js"/,
  );
  assert.doesNotMatch(html, /_next\/static\/chunks\/[^\"]+\.js/);
  assert.doesNotMatch(html, /self\.__next|__next_f|modulepreload/);

  const scriptTags = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
  assert.equal(scriptTags.length, 1);
  assert.match(scriptTags[0], /data-booking-enhancement/);
});
