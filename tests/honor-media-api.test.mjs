import assert from "node:assert/strict";
import test from "node:test";

import { handleAdminHonorMedia, handlePublicHonorMedia } from "../cloudbase/src/honor-media.ts";

function fakeService() {
  const calls = [];
  return {
    calls,
    async listAdmin() { calls.push(["listAdmin"]); return { id: "honor-media-v1", version: 0, items: [] }; },
    async listPublished() { calls.push(["listPublished"]); return [{ id: "honor-1", title: "冠军" }]; },
    async createUploadIntent(input, actorId) { calls.push(["create", input, actorId]); return { item: { id: "honor-1" }, upload: { method: "PUT" } }; },
    async finalizeUpload(input, actorId) { calls.push(["finalize", input, actorId]); return { id: input.itemId }; },
    async updateItem(input, actorId) { calls.push(["update", input, actorId]); return { id: input.itemId }; },
    async setPublished(input, actorId) { calls.push(["publication", input, actorId]); return { id: input.itemId }; },
    async deleteItem(input, actorId) { calls.push(["delete", input, actorId]); },
  };
}

test("public honor route exposes only the service projection", async () => {
  const service = fakeService();
  const response = await handlePublicHonorMedia("GET", "/v1/honor-media", service);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { data: { items: [{ id: "honor-1", title: "冠军" }] } });
  assert.equal(await handlePublicHonorMedia("POST", "/v1/honor-media", service), null);
});

test("admin honor routes forward strict fields and trusted actor", async () => {
  const service = fakeService();
  const common = { actorId: "trusted-uid", service };
  await handleAdminHonorMedia({ ...common, method: "POST", path: "/v1/admin/honor-media/upload-intents", body: {
    kind: "image", mimeType: "image/webp", sizeBytes: 100, originalName: "award.webp",
    title: "冠军", owner: "liu-qirui", year: 2026, awardDescription: "公开组男子单打第一名",
    altText: "获奖证书", sortOrder: 1, expectedManifestVersion: 0,
  }});
  await handleAdminHonorMedia({ ...common, method: "POST", path: "/v1/admin/honor-media/honor-1/finalize", body: { expectedManifestVersion: 1, publish: true } });
  await handleAdminHonorMedia({ ...common, method: "PUT", path: "/v1/admin/honor-media/honor-1", body: {
    expectedManifestVersion: 2, title: "新标题", owner: "coach-team", year: 2025,
    awardDescription: "团队荣誉", altText: "团队证书", sortOrder: 3,
  }});
  await handleAdminHonorMedia({ ...common, method: "PUT", path: "/v1/admin/honor-media/honor-1/publication", body: { expectedManifestVersion: 3, published: false } });
  await handleAdminHonorMedia({ ...common, method: "DELETE", path: "/v1/admin/honor-media/honor-1", body: { expectedManifestVersion: 4 } });
  assert.deepEqual(service.calls.map(([name]) => name), ["create", "finalize", "update", "publication", "delete"]);
  assert.equal(service.calls[0][2], "trusted-uid");
});

test("admin honor routes reject coercion and unsafe ids", async () => {
  const service = fakeService();
  await assert.rejects(() => handleAdminHonorMedia({
    method: "PUT", path: "/v1/admin/honor-media/honor-1/publication", actorId: "uid", service,
    body: { expectedManifestVersion: 1, published: "true" },
  }), /INVALID_MEDIA_INPUT/);
  assert.equal(await handleAdminHonorMedia({ method: "GET", path: "/v1/admin/honor-media/..", actorId: "uid", service, body: {} }), null);
});
