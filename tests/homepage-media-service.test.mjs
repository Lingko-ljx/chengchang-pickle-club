import assert from "node:assert/strict";
import test from "node:test";

import { HomepageMediaService } from "../lib/media/media-service.ts";
import {
  MemoryHomepageMediaRepository,
  MemoryHomepageMediaStorage,
} from "../lib/media/testing/memory-media.ts";

function setup() {
  let sequence = 0;
  const repository = new MemoryHomepageMediaRepository();
  const storage = new MemoryHomepageMediaStorage();
  const service = new HomepageMediaService(repository, storage, {
    clock: { now: () => new Date("2026-08-12T02:00:00.000Z") },
    mediaId: () => `media-${++sequence}`,
  });
  return { repository, storage, service };
}

function image(overrides = {}) {
  return {
    kind: "image",
    mimeType: "image/webp",
    sizeBytes: 1024,
    originalName: "今日训练.webp",
    title: "今日训练",
    caption: "一起上场，享受匹克球。",
    altText: "会员在匹克球场进行训练",
    expectedManifestVersion: 0,
    ...overrides,
  };
}

test("public archive selects Beijing today, exposes dates and signs only the selected day", async () => {
  const { storage, service } = setup();
  const today = await service.createUploadIntent(image({ mediaDate: "2026-08-12" }), "staff-1");
  storage.complete(today.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  await service.finalizeUpload({ itemId: today.item.id, expectedManifestVersion: 1, publish: true }, "staff-1");
  const yesterday = await service.createUploadIntent(image({ mediaDate: "2026-08-11", title: "昨日训练", expectedManifestVersion: 2 }), "staff-1");
  storage.complete(yesterday.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  await service.finalizeUpload({ itemId: yesterday.item.id, expectedManifestVersion: 3, publish: true }, "staff-1");

  const feed = await service.listPublicArchive({ now: new Date("2026-08-12T03:00:00.000Z") });
  assert.equal(feed.selectedDate, "2026-08-12");
  assert.equal(feed.isToday, true);
  assert.deepEqual(feed.availableDates, ["2026-08-12", "2026-08-11"]);
  assert.deepEqual(feed.items.map(({ id, mediaDate }) => ({ id, mediaDate })), [{ id: "media-1", mediaDate: "2026-08-12" }]);
  assert.deepEqual(storage.publicUrlRequests.at(-1), [today.item.fileId]);

  const old = await service.listPublicArchive({ date: "2026-08-11", now: new Date("2026-08-12T03:00:00.000Z") });
  assert.equal(old.selectedDate, "2026-08-11");
  assert.equal(old.isToday, false);
  assert.deepEqual(old.items.map(({ id }) => id), ["media-2"]);
});

test("future-dated published media stays hidden until its Beijing calendar day", async () => {
  const { storage, service } = setup();
  const intent = await service.createUploadIntent(image({ mediaDate: "2026-08-13" }), "staff-1");
  storage.complete(intent.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  await service.finalizeUpload({ itemId: intent.item.id, expectedManifestVersion: 1, publish: true }, "staff-1");

  const before = await service.listPublicArchive({ now: new Date("2026-08-12T03:00:00.000Z") });
  assert.deepEqual(before.availableDates, []);
  assert.deepEqual(before.items, []);
  await assert.rejects(
    () => service.listPublicArchive({ date: "2026-08-13", now: new Date("2026-08-12T03:00:00.000Z") }),
    /INVALID_MEDIA_INPUT/,
  );

  const onDay = await service.listPublicArchive({ now: new Date("2026-08-12T16:00:00.000Z") });
  assert.equal(onDay.selectedDate, "2026-08-13");
  assert.deepEqual(onDay.items.map(({ id }) => id), [intent.item.id]);
});

test("legacy published items without mediaDate remain visible using Shanghai fallback", async () => {
  const { repository, storage, service } = setup();
  const intent = await service.createUploadIntent(image({ mediaDate: "2026-08-12" }), "staff-1");
  storage.complete(intent.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  await service.finalizeUpload({ itemId: intent.item.id, expectedManifestVersion: 1, publish: true }, "staff-1");
  const manifest = await repository.read();
  delete manifest.items[0].mediaDate;
  manifest.items[0].publishedAt = "2026-08-11T16:30:00.000Z";
  manifest.version += 1;
  await repository.replace(manifest.version - 1, manifest);

  const feed = await service.listPublicArchive({ date: "2026-08-12", now: new Date("2026-08-12T03:00:00.000Z") });
  assert.equal(feed.items[0].mediaDate, "2026-08-12");
});

test("published daily limit applies per mediaDate and allows another day", async () => {
  const { storage, service } = setup();
  let version = 0;
  for (let index = 0; index < 6; index += 1) {
    const intent = await service.createUploadIntent(image({ title: `today-${index}`, mediaDate: "2026-08-12", expectedManifestVersion: version }), "staff-1");
    version += 1;
    storage.complete(intent.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
    await service.finalizeUpload({ itemId: intent.item.id, expectedManifestVersion: version, publish: true }, "staff-1");
    version += 1;
  }
  const seventh = await service.createUploadIntent(image({ title: "today-7", mediaDate: "2026-08-12", expectedManifestVersion: version }), "staff-1");
  version += 1;
  storage.complete(seventh.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  await assert.rejects(() => service.finalizeUpload({ itemId: seventh.item.id, expectedManifestVersion: version, publish: true }, "staff-1"), /MEDIA_LIMIT_REACHED/);

  const otherDay = await service.createUploadIntent(image({ title: "tomorrow", mediaDate: "2026-08-13", expectedManifestVersion: version }), "staff-1");
  storage.complete(otherDay.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  await service.finalizeUpload({ itemId: otherDay.item.id, expectedManifestVersion: version + 1, publish: true }, "staff-1");
});

test("an authenticated editor can upload, finalize and publish a safe homepage image", async () => {
  const { repository, storage, service } = setup();

  const intent = await service.createUploadIntent(image(), "2086921219279085570");
  assert.equal(intent.item.id, "media-1");
  assert.equal(intent.item.status, "uploading");
  assert.match(intent.item.storagePath, /^daily-media\/2026\/08\/media-1\.webp$/);
  assert.equal(intent.upload.method, "PUT");
  assert.equal(intent.upload.headers["Content-Type"], "image/webp");

  storage.complete(intent.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  const published = await service.finalizeUpload(
    { itemId: intent.item.id, expectedManifestVersion: 1, publish: true },
    "2086921219279085570",
  );
  assert.equal(published.status, "published");

  const publicItems = await service.listPublished();
  assert.deepEqual(publicItems, [
    {
      id: "media-1",
      kind: "image",
      url: "https://media.test/media-1",
      mimeType: "image/webp",
      title: "今日训练",
      caption: "一起上场，享受匹克球。",
      altText: "会员在匹克球场进行训练",
      mediaDate: "2026-08-12",
      publishedAt: "2026-08-12T02:00:00.000Z",
      pinned: false,
    },
  ]);

  const stored = await repository.read();
  assert.equal(stored.items[0].originalName, "今日训练.webp");
  assert.equal(stored.items[0].createdBy, "2086921219279085570");
  assert.equal(JSON.stringify(publicItems).includes("2086921219279085570"), false);
  assert.equal(JSON.stringify(publicItems).includes("daily-media/"), false);
});

test("unsafe media types, oversized files and unsafe names fail before storage is called", async () => {
  const { storage, service } = setup();
  for (const invalid of [
    image({ mimeType: "image/svg+xml", originalName: "payload.svg" }),
    image({ sizeBytes: 8 * 1024 * 1024 + 1 }),
    image({ originalName: "../today.webp" }),
    image({ title: "" }),
    image({ altText: "" }),
    image({ caption: "x".repeat(201) }),
  ]) {
    await assert.rejects(
      () => service.createUploadIntent(invalid, "staff-1"),
      /INVALID_MEDIA_INPUT/,
    );
  }
  assert.equal(storage.createdIntents.length, 0);
});

test("mp4 accepts fifty megabytes while larger video and mismatched uploads stay unpublished", async () => {
  const { storage, service } = setup();
  const intent = await service.createUploadIntent(
    image({
      kind: "video",
      mimeType: "video/mp4",
      sizeBytes: 50 * 1024 * 1024,
      originalName: "daily.mp4",
      title: "今日精彩回合",
      altText: "今日匹克球精彩回合视频",
    }),
    "staff-1",
  );
  storage.complete(intent.item.fileId, { mimeType: "video/mp4", sizeBytes: 49 });
  await assert.rejects(
    () => service.finalizeUpload({ itemId: intent.item.id, expectedManifestVersion: 1, publish: true }, "staff-1"),
    /MEDIA_UPLOAD_MISMATCH/,
  );
  assert.deepEqual(await service.listPublished(), []);

  await assert.rejects(
    () =>
      service.createUploadIntent(
        image({
          kind: "video",
          mimeType: "video/mp4",
          sizeBytes: 50 * 1024 * 1024 + 1,
          originalName: "too-large.mp4",
        }),
        "staff-1",
      ),
    /INVALID_MEDIA_INPUT/,
  );
});

test("only one published item is pinned and public order is deterministic", async () => {
  const { storage, service } = setup();
  const first = await service.createUploadIntent(image({ title: "第一条" }), "staff-1");
  storage.complete(first.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  await service.finalizeUpload({ itemId: first.item.id, expectedManifestVersion: 1, publish: true }, "staff-1");

  const second = await service.createUploadIntent(
    image({ title: "第二条", expectedManifestVersion: 2 }),
    "staff-1",
  );
  storage.complete(second.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  await service.finalizeUpload({ itemId: second.item.id, expectedManifestVersion: 3, publish: true }, "staff-1");

  await service.setPinned({ itemId: first.item.id, expectedManifestVersion: 4, pinned: true }, "staff-1");
  await service.setPinned({ itemId: second.item.id, expectedManifestVersion: 5, pinned: true }, "staff-1");

  const listed = await service.listPublished();
  assert.deepEqual(listed.map(({ id, pinned }) => ({ id, pinned })), [
    { id: "media-2", pinned: true },
    { id: "media-1", pinned: false },
  ]);
});

test("unpublish is reversible and permanent delete removes storage after hiding the item", async () => {
  const { repository, storage, service } = setup();
  const intent = await service.createUploadIntent(image(), "staff-1");
  storage.complete(intent.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  await service.finalizeUpload({ itemId: intent.item.id, expectedManifestVersion: 1, publish: true }, "staff-1");

  const draft = await service.setPublished(
    { itemId: intent.item.id, expectedManifestVersion: 2, published: false },
    "staff-1",
  );
  assert.equal(draft.status, "draft");
  assert.equal(Object.hasOwn(draft, "publishedAt"), false);
  assert.equal(Object.hasOwn(draft, "pinnedAt"), false);
  assert.deepEqual(await service.listPublished(), []);

  await service.setPublished(
    { itemId: intent.item.id, expectedManifestVersion: 3, published: true },
    "staff-1",
  );
  await service.deleteItem(
    { itemId: intent.item.id, expectedManifestVersion: 4 },
    "staff-1",
  );
  assert.deepEqual(await service.listPublished(), []);
  assert.deepEqual(storage.deletedFileIds, [intent.item.fileId]);
  assert.equal((await repository.read()).items.length, 0);
});

test("a failed storage delete remains hidden but can be retried to completion", async () => {
  const { repository, storage, service } = setup();
  const intent = await service.createUploadIntent(image(), "staff-1");
  storage.complete(intent.item.fileId, { mimeType: "image/webp", sizeBytes: 1024 });
  await service.finalizeUpload(
    { itemId: intent.item.id, expectedManifestVersion: 1, publish: true },
    "staff-1",
  );

  const deleteFromStorage = storage.delete.bind(storage);
  let failOnce = true;
  storage.delete = async (fileId) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("STORAGE_TEMPORARY_FAILURE");
    }
    await deleteFromStorage(fileId);
  };

  await assert.rejects(
    () => service.deleteItem({ itemId: intent.item.id, expectedManifestVersion: 2 }, "staff-1"),
    /STORAGE_TEMPORARY_FAILURE/,
  );
  const hidden = await repository.read();
  assert.equal(hidden.items[0].status, "deleting");
  assert.deepEqual(await service.listPublished(), []);

  await service.deleteItem(
    { itemId: intent.item.id, expectedManifestVersion: hidden.version },
    "staff-1",
  );
  assert.equal((await repository.read()).items.length, 0);
  assert.deepEqual(storage.deletedFileIds, [intent.item.fileId]);
});

test("stale editors fail closed without overwriting a newer manifest", async () => {
  const { service } = setup();
  await service.createUploadIntent(image(), "staff-1");
  await assert.rejects(
    () => service.createUploadIntent(image({ title: "过期操作" }), "staff-1"),
    /MEDIA_CONFLICT/,
  );
});

test("repository read failures are not mistaken for an empty media library", async () => {
  const storage = new MemoryHomepageMediaStorage();
  const service = new HomepageMediaService(
    {
      read: async () => { throw new Error("DATABASE_UNAVAILABLE"); },
      replace: async () => assert.fail("replace must not run after a failed read"),
    },
    storage,
    {
      clock: { now: () => new Date("2026-08-12T02:00:00.000Z") },
      mediaId: () => "media-1",
    },
  );

  await assert.rejects(
    () => service.createUploadIntent(image(), "staff-1"),
    /DATABASE_UNAVAILABLE/,
  );
  assert.equal(storage.createdIntents.length, 0);
});
