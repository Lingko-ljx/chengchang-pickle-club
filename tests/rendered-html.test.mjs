import assert from "node:assert/strict";
import test from "node:test";

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

test("server renders the finished pickleball club page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>澄场 PICKLE CLUB/);
  assert.match(html, /匹克球介绍/);
  assert.match(html, /场地介绍/);
  assert.match(html, /教练团队/);
  assert.match(html, /荣誉时刻/);
  assert.match(html, /预约体验/);
  assert.match(html, /联系我们/);
  assert.doesNotMatch(
    html,
    /codex-preview|Building your site|react-loading-skeleton/,
  );
});
