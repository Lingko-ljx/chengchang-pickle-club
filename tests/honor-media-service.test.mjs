import assert from "node:assert/strict";
import test from "node:test";

import { HonorMediaService } from "../lib/honor-media/honor-media-service.ts";
import {
  MemoryHonorMediaRepository,
  MemoryHonorMediaStorage,
} from "../lib/honor-media/testing/memory-honor-media.ts";

function setup() {
  let sequence = 0;
  const repository = new MemoryHonorMediaRepository();
  const storage = new MemoryHonorMediaStorage();
  const service = new HonorMediaService(repository, storage, {
    clock: { now: () => new Date("2026-08-12T03:00:00.000Z") },
    mediaId: () => `honor-${++sequence}`,
  });
  return { repository, storage, service };
}

function image(overrides = {}) {
  return {
    kind: "image",
    mimeType: "image/webp",
    sizeBytes: 2048,
    originalName: "championship.webp",
    title: "呼和浩特站男单冠军",
    owner: "liu-qirui",
    year: 2026,
    awardDescription: "2026 李宁杯中国匹克球巡回赛呼和浩特站（CPC-1000）公开组男子单打第一名",
    altText: "刘栖睿获得男子单打第一名的获奖证书",
    sortOrder: 10,
    expectedManifestVersion: 0,
    ...overrides,
  };
}

test("honor media uses an isolated storage prefix and publishes a privacy-safe projection", async () => {
  const { repository, storage, service } = setup();
  const intent = await service.createUploadIntent(image(), "trusted-staff-uid");

  assert.match(intent.item.storagePath, /^honor-media\/2026\/honor-1\.webp$/);
  assert.equal(intent.item.status, "uploading");
  storage.complete(intent.item.fileId, { mimeType: "image/webp", sizeBytes: 2048 });
  await service.finalizeUpload(
    { itemId: intent.item.id, expectedManifestVersion: 1, publish: true },
    "trusted-staff-uid",
  );

  const publicItems = await service.listPublished();
  assert.deepEqual(publicItems, [{
    id: "honor-1",
    kind: "image",
    url: "https://honors.test/honor-1",
    mimeType: "image/webp",
    title: "呼和浩特站男单冠军",
    owner: "liu-qirui",
    year: 2026,
    awardDescription: "2026 李宁杯中国匹克球巡回赛呼和浩特站（CPC-1000）公开组男子单打第一名",
    altText: "刘栖睿获得男子单打第一名的获奖证书",
    sortOrder: 10,
  }]);
  const serialized = JSON.stringify(publicItems);
  for (const secret of ["trusted-staff-uid", "originalName", "storagePath", "createdBy", "audit"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal((await repository.read()).id, "honor-media-v1");
});

test("draft honors stay private and metadata plus numeric ordering are editable", async () => {
  const { storage, service } = setup();
  const first = await service.createUploadIntent(image({ sortOrder: 20 }), "staff-1");
  storage.complete(first.item.fileId, { mimeType: "image/webp", sizeBytes: 2048 });
  await service.finalizeUpload({ itemId: first.item.id, expectedManifestVersion: 1, publish: false }, "staff-1");
  assert.deepEqual(await service.listPublished(), []);

  const updated = await service.updateItem({
    itemId: first.item.id,
    expectedManifestVersion: 2,
    title: "杭州站男子单打亚军",
    owner: "liu-qirui",
    year: 2025,
    awardDescription: "2025 PPPA 杭州站 19+ 男子单打 3.5+ 亚军",
    altText: "刘栖睿杭州站比赛荣誉",
    sortOrder: 1,
  }, "staff-1");
  assert.equal(updated.sortOrder, 1);
  assert.equal(updated.year, 2025);
  await service.setPublished({ itemId: first.item.id, expectedManifestVersion: 3, published: true }, "staff-1");
  assert.equal((await service.listPublished())[0].title, "杭州站男子单打亚军");
});

test("published honors are sorted by sortOrder then year and can be unpublished or deleted", async () => {
  const { repository, storage, service } = setup();
  const a = await service.createUploadIntent(image({ sortOrder: 2 }), "staff-1");
  storage.complete(a.item.fileId, { mimeType: "image/webp", sizeBytes: 2048 });
  await service.finalizeUpload({ itemId: a.item.id, expectedManifestVersion: 1, publish: true }, "staff-1");
  const b = await service.createUploadIntent(image({ title: "第二项", sortOrder: 1, expectedManifestVersion: 2 }), "staff-1");
  storage.complete(b.item.fileId, { mimeType: "image/webp", sizeBytes: 2048 });
  await service.finalizeUpload({ itemId: b.item.id, expectedManifestVersion: 3, publish: true }, "staff-1");
  assert.deepEqual((await service.listPublished()).map(({ id }) => id), ["honor-2", "honor-1"]);

  await service.setPublished({ itemId: b.item.id, expectedManifestVersion: 4, published: false }, "staff-1");
  assert.deepEqual((await service.listPublished()).map(({ id }) => id), ["honor-1"]);
  await service.deleteItem({ itemId: b.item.id, expectedManifestVersion: 5 }, "staff-1");
  assert.deepEqual(storage.deletedFileIds, [b.item.fileId]);
  assert.equal((await repository.read()).items.length, 1);
});

test("honor metadata, owner, year, sort order and upload limits fail closed", async () => {
  const { storage, service } = setup();
  for (const invalid of [
    image({ owner: "unknown" }),
    image({ year: "2026" }),
    image({ year: 1899 }),
    image({ sortOrder: -1 }),
    image({ awardDescription: "" }),
    image({ mimeType: "image/svg+xml", originalName: "award.svg" }),
    image({ sizeBytes: 8 * 1024 * 1024 + 1 }),
  ]) {
    await assert.rejects(() => service.createUploadIntent(invalid, "staff-1"), /INVALID_MEDIA_INPUT/);
  }
  assert.equal(storage.createdIntents.length, 0);
});

test("MP4 honors reuse the safe fifty-megabyte upload contract", async () => {
  const { storage, service } = setup();
  const intent = await service.createUploadIntent(image({
    kind: "video",
    mimeType: "video/mp4",
    sizeBytes: 50 * 1024 * 1024,
    originalName: "award.mp4",
  }), "staff-1");
  storage.complete(intent.item.fileId, { mimeType: "video/mp4", sizeBytes: 50 * 1024 * 1024 });
  await service.finalizeUpload({ itemId: intent.item.id, expectedManifestVersion: 1, publish: true }, "staff-1");
  assert.equal((await service.listPublished())[0].kind, "video");
});
