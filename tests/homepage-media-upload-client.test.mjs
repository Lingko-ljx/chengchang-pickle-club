import assert from "node:assert/strict";
import test from "node:test";

import { uploadHomepageMedia } from "../admin-client/media-upload.ts";

function file(name = "today.webp", type = "image/webp", size = 1024) {
  const blob = new Blob([new Uint8Array(size)], { type });
  return Object.assign(blob, { name });
}

test("admin media upload performs signed PUT before finalize and never sends bytes through admin API", async () => {
  const calls = [];
  const api = {
    async createMediaUploadIntent(input) {
      calls.push(["intent", input]);
      return {
        item: { id: "media-1" },
        upload: {
          method: "PUT",
          url: "https://upload.example.test/media-1",
          headers: {
            "Content-Type": "image/webp",
            Signature: "signature",
            authorization: "signature",
            "x-cos-security-token": "token",
            "x-cos-meta-fileid": "file-id",
            key: "daily-media%2Fmedia-1.webp",
          },
        },
      };
    },
    async finalizeMediaUpload(itemId, expectedVersion, publish) {
      calls.push(["finalize", itemId, expectedVersion, publish]);
      return { id: itemId, status: "published" };
    },
  };
  const result = await uploadHomepageMedia({
    api,
    file: file(),
    title: "今日球场",
    caption: "欢迎来打球",
    altText: "会员在匹克球场训练",
    expectedManifestVersion: 7,
    publish: true,
    fetchImpl: async (url, init) => {
      calls.push(["put", url, init.method, init.body.size, init.headers]);
      return new Response(null, { status: 200 });
    },
  });
  assert.deepEqual(result, { id: "media-1", status: "published" });
  assert.deepEqual(calls.map(([name]) => name), ["intent", "put", "finalize"]);
  assert.equal("file" in calls[0][1], false);
  assert.deepEqual(calls[2], ["finalize", "media-1", 8, true]);
});

test("admin media upload rejects unsafe files and malformed signed responses", async () => {
  const never = async () => { throw new Error("must not be called"); };
  await assert.rejects(
    () => uploadHomepageMedia({
      api: { createMediaUploadIntent: never, finalizeMediaUpload: never },
      file: file("payload.svg", "image/svg+xml"),
      title: "x",
      altText: "x",
      expectedManifestVersion: 0,
      publish: true,
      fetchImpl: never,
    }),
    /INVALID_FILE/,
  );

  await assert.rejects(
    () => uploadHomepageMedia({
      api: {
        createMediaUploadIntent: async () => ({
          item: { id: "media-1" },
          upload: {
            method: "PUT",
            url: "javascript:alert(1)",
            headers: { "Content-Type": "image/webp" },
          },
        }),
        finalizeMediaUpload: never,
      },
      file: file(),
      title: "x",
      altText: "x",
      expectedManifestVersion: 0,
      publish: true,
      fetchImpl: never,
    }),
    /INVALID_UPLOAD_INTENT/,
  );
});
