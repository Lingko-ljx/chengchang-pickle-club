import assert from "node:assert/strict";
import test from "node:test";

import {
  handleAdminHomepageMedia,
  handlePublicHomepageMedia,
} from "../cloudbase/src/homepage-media.ts";

function fakeService() {
  const calls = [];
  return {
    calls,
    async listAdmin() { calls.push(["listAdmin"]); return { version: 0, items: [] }; },
    async listPublished() { calls.push(["listPublished"]); return [{ id: "media-1" }]; },
    async listPublicArchive(input) { calls.push(["listPublicArchive", input]); return { items: [{ id: "media-1", mediaDate: "2026-08-12" }], availableDates: ["2026-08-12"], selectedDate: "2026-08-12", isToday: true }; },
    async createUploadIntent(input, actorId) { calls.push(["create", input, actorId]); return { item: { id: "media-1" }, upload: { method: "PUT" } }; },
    async finalizeUpload(input, actorId) { calls.push(["finalize", input, actorId]); return { id: input.itemId, status: "published" }; },
    async setPublished(input, actorId) { calls.push(["publication", input, actorId]); return { id: input.itemId, status: input.published ? "published" : "draft" }; },
    async setPinned(input, actorId) { calls.push(["pin", input, actorId]); return { id: input.itemId, pinned: input.pinned }; },
    async deleteItem(input, actorId) { calls.push(["delete", input, actorId]); },
  };
}

test("public homepage media route exposes the dated archive projection", async () => {
  const service = fakeService();
  const now = new Date("2026-08-12T03:00:00.000Z");
  const response = await handlePublicHomepageMedia("GET", "/v1/homepage-media", service, "2026-08-12", now);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { data: { items: [{ id: "media-1", mediaDate: "2026-08-12" }], availableDates: ["2026-08-12"], selectedDate: "2026-08-12", isToday: true } });
  assert.deepEqual(service.calls[0], ["listPublicArchive", { date: "2026-08-12", now }]);
  assert.equal(await handlePublicHomepageMedia("POST", "/v1/homepage-media", service), null);
});

test("admin upload intent forwards a strict typed request and trusted actor", async () => {
  const service = fakeService();
  const response = await handleAdminHomepageMedia({
    method: "POST",
    path: "/v1/admin/homepage-media/upload-intents",
    actorId: "trusted-uid",
    service,
    body: {
      kind: "image",
      mimeType: "image/webp",
      sizeBytes: 1024,
      originalName: "today.webp",
      title: "今日球场",
      caption: "一起打球",
      altText: "匹克球场照片",
      mediaDate: "2026-08-12",
      expectedManifestVersion: 3,
    },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(service.calls[0], ["create", {
    kind: "image",
    mimeType: "image/webp",
    sizeBytes: 1024,
    originalName: "today.webp",
    title: "今日球场",
    caption: "一起打球",
    altText: "匹克球场照片",
    mediaDate: "2026-08-12",
    expectedManifestVersion: 3,
  }, "trusted-uid"]);
});

test("admin media state routes require exact booleans, versions and server ids", async () => {
  const service = fakeService();
  const base = { actorId: "trusted-uid", service };
  await handleAdminHomepageMedia({ ...base, method: "POST", path: "/v1/admin/homepage-media/media-1/finalize", body: { expectedManifestVersion: 1, publish: true } });
  await handleAdminHomepageMedia({ ...base, method: "PUT", path: "/v1/admin/homepage-media/media-1/publication", body: { expectedManifestVersion: 2, published: false } });
  await handleAdminHomepageMedia({ ...base, method: "PUT", path: "/v1/admin/homepage-media/media-1/pin", body: { expectedManifestVersion: 3, pinned: true } });
  await handleAdminHomepageMedia({ ...base, method: "POST", path: "/v1/admin/homepage-media/media-1/delete", body: { expectedManifestVersion: 4 } });
  assert.deepEqual(service.calls.map(([action]) => action), ["finalize", "publication", "pin", "delete"]);
  await assert.rejects(
    () => handleAdminHomepageMedia({ ...base, method: "PUT", path: "/v1/admin/homepage-media/media-1/pin", body: { expectedManifestVersion: 3, pinned: "true" } }),
    /INVALID_MEDIA_INPUT/,
  );
  assert.equal(await handleAdminHomepageMedia({ ...base, method: "GET", path: "/v1/admin/homepage-media/..", body: {} }), null);
});
