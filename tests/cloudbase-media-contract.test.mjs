import assert from "node:assert/strict";
import test from "node:test";

import { CloudBaseHomepageMediaRepository } from "../cloudbase/src/repositories/cloudbase-media-repository.ts";
import { CloudBaseHomepageMediaStorage } from "../cloudbase/src/storage/cloudbase-media-storage.ts";
import { errorResponse } from "../cloudbase/src/http/response.ts";
import { MediaError } from "../lib/media/errors.ts";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeMediaDatabase {
  constructor(value) {
    this.value = clone(value);
    this.retries = [];
    this.setPayloads = [];
  }

  collection(name) {
    assert.equal(name, "system_state");
    return this.collectionFor(this, false);
  }

  collectionFor(state, transactional) {
    return {
      doc: (id) => {
        assert.equal(id, "homepage-media-v1");
        return {
          get: async () => ({ data: state.value ? (transactional ? { _id: id, ...clone(state.value) } : [{ _id: id, ...clone(state.value) }]) : transactional ? null : [] }),
          set: async (value) => {
            assert.equal(Object.hasOwn(value, "_id"), false);
            this.setPayloads.push(clone(value));
            state.value = clone(value);
          },
        };
      },
    };
  }

  async runTransaction(work, retries) {
    this.retries.push(retries);
    const state = { value: clone(this.value) };
    const result = await work({ collection: (name) => {
      assert.equal(name, "system_state");
      return this.collectionFor(state, true);
    } });
    this.value = state.value;
    return result;
  }
}

test("media manifest repository creates version one and strips CloudBase document metadata", async () => {
  const database = new FakeMediaDatabase();
  const repository = new CloudBaseHomepageMediaRepository(database);
  const empty = await repository.read();
  assert.equal(empty.version, 0);

  await repository.replace(0, { ...empty, version: 1, updatedAt: "2026-08-12T00:00:00.000Z" });
  const stored = await repository.read();
  assert.equal(stored.version, 1);
  assert.equal(Object.hasOwn(stored, "_id"), false);
  assert.deepEqual(database.retries, [3]);
});

test("media manifest repository rejects stale writers inside the transaction", async () => {
  const seed = {
    id: "homepage-media-v1",
    schemaVersion: 1,
    version: 4,
    items: [],
    audit: [],
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  const database = new FakeMediaDatabase(seed);
  const repository = new CloudBaseHomepageMediaRepository(database);
  await assert.rejects(
    () => repository.replace(3, { ...seed, version: 4 }),
    /MEDIA_CONFLICT/,
  );
  assert.equal(database.setPayloads.length, 0);
});

test("CloudBase media storage returns an exact signed PUT and verifies the uploaded object", async () => {
  const calls = [];
  const storage = new CloudBaseHomepageMediaStorage({
    async getUploadMetadata({ cloudPath }) {
      calls.push(["metadata", cloudPath]);
      return { data: {
        url: "https://upload.example.test/object",
        token: "temporary-token",
        authorization: "temporary-signature",
        fileId: "cloud://bucket/media-1.webp",
        cosFileId: "cos-file-id",
      } };
    },
    async getFileInfo({ fileList }) {
      calls.push(["info", ...fileList]);
      return { fileList: [{ code: "SUCCESS", fileID: fileList[0], mime: "image/webp", size: 1024 }] };
    },
    async getTempFileURL({ fileList }) {
      calls.push(["url", fileList[0].maxAge]);
      return { fileList: [{ code: "SUCCESS", fileID: fileList[0].fileID, tempFileURL: "https://download.example.test/media-1.webp" }] };
    },
    async deleteFile({ fileList }) {
      calls.push(["delete", ...fileList]);
      return { fileList: [{ code: "SUCCESS", fileID: fileList[0] }] };
    },
  });

  const upload = await storage.createUpload({
    storagePath: "daily-media/2026/08/media-1.webp",
    mimeType: "image/webp",
    sizeBytes: 1024,
    expiresAt: "2026-08-12T00:10:00.000Z",
  });
  assert.equal(upload.method, "PUT");
  assert.deepEqual(upload.headers, {
    "Content-Type": "image/webp",
    Signature: "temporary-signature",
    authorization: "temporary-signature",
    "x-cos-security-token": "temporary-token",
    "x-cos-meta-fileid": "cos-file-id",
    key: "daily-media%2F2026%2F08%2Fmedia-1.webp",
  });
  assert.deepEqual(await storage.inspect(upload.fileId), {
    exists: true,
    mimeType: "image/webp",
    sizeBytes: 1024,
  });
  assert.deepEqual(await storage.publicUrls([upload.fileId]), {
    [upload.fileId]: "https://download.example.test/media-1.webp",
  });
  await storage.delete(upload.fileId);
  assert.deepEqual(calls.map(([name]) => name), ["metadata", "info", "url", "delete"]);
});

test("media failures use a closed public error vocabulary without raw provider text", () => {
  assert.deepEqual(errorResponse(new MediaError("MEDIA_UPLOAD_INCOMPLETE")), {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      error: {
        code: "MEDIA_UPLOAD_INCOMPLETE",
        message: "Upload is not complete",
        retryable: true,
      },
    }),
  });
  const unknown = errorResponse(new Error("temporary-token should never be exposed"));
  assert.equal(unknown.body.includes("temporary-token"), false);
});
