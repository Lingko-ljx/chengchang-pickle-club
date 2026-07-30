import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("exports a GitHub Pages-ready homepage", async () => {
  const html = await readFile(
    new URL("../out/index.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /澄场 PICKLE CLUB/);
  assert.match(html, /\/chengchang-pickle-club\/_next\//);
  assert.doesNotMatch(html, /(?:href|src)="\/_next\//);
});
