import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createAdminApiClient } from "../admin-client/api.ts";
import { honorMediaActionsFor } from "../admin-client/render.ts";

function response(data = {}) {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("admin honor client exposes list, upload, edit, publication and delete routes", async () => {
  const calls = [];
  const api = createAdminApiClient({
    baseUrl: "https://api.test",
    getAccessToken: () => "token",
    onUnauthorized: () => {},
    fetchImpl: async (url, init) => { calls.push([url, init?.method ?? "GET", init?.body]); return response(); },
  });
  await api.getHonorMedia();
  await api.createHonorMediaUploadIntent({ title: "冠军" });
  await api.finalizeHonorMediaUpload("honor-1", 1, true);
  await api.updateHonorMedia("honor-1", { expectedManifestVersion: 2, sortOrder: 1 });
  await api.setHonorMediaPublished("honor-1", false, 3);
  await api.deleteHonorMedia("honor-1", 4);
  assert.deepEqual(calls.map(([url, method]) => [new URL(url).pathname, method]), [
    ["/v1/admin/honor-media", "GET"],
    ["/v1/admin/honor-media/upload-intents", "POST"],
    ["/v1/admin/honor-media/honor-1/finalize", "POST"],
    ["/v1/admin/honor-media/honor-1", "PUT"],
    ["/v1/admin/honor-media/honor-1/publication", "PUT"],
    ["/v1/admin/honor-media/honor-1", "DELETE"],
  ]);
});

test("honor action model is editable and supports publish, unpublish and retry delete", () => {
  assert.deepEqual(honorMediaActionsFor({ status: "draft" }).map(([action]) => action), ["edit", "publish", "delete"]);
  assert.deepEqual(honorMediaActionsFor({ status: "published" }).map(([action]) => action), ["edit", "unpublish", "delete"]);
  assert.deepEqual(honorMediaActionsFor({ status: "deleting" }), [["delete", "重试删除"]]);
});

test("admin page contains an operable honor form and daily media date", async () => {
  const source = await readFile(new URL("../app/admin/page.tsx", import.meta.url), "utf8");
  for (const id of [
    "admin-media-date", "admin-honor-upload-form", "admin-honor-file", "admin-honor-title",
    "admin-honor-owner", "admin-honor-year", "admin-honor-description", "admin-honor-alt",
    "admin-honor-sort", "admin-honor-submit", "admin-honor-list",
  ]) assert.match(source, new RegExp(`id=["']${id}["']`));
  const client = await readFile(new URL("../admin-client/index.ts", import.meta.url), "utf8");
  assert.match(client, /uploadHonorMedia/);
  assert.match(client, /mediaDate/);
  assert.match(client, /updateHonorMedia/);
  assert.match(client, /setHonorMediaPublished/);
  assert.match(client, /deleteHonorMedia/);
});
