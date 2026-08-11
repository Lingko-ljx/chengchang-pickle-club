import assert from "node:assert/strict";
import test from "node:test";

import { sanitizePublicMediaItems } from "../homepage-media-client/index.ts";

test("homepage media client accepts only the public six-item HTTPS contract", () => {
  const good = {
    id: "media-1",
    kind: "video",
    url: "https://media.example.test/clip.mp4",
    mimeType: "video/mp4",
    title: "今日精彩回合",
    caption: "欢迎来球馆体验。",
    altText: "两名会员进行匹克球对打",
    publishedAt: "2026-08-12T01:00:00.000Z",
    pinned: true,
  };
  const input = [
    good,
    { ...good, id: "javascript", url: "javascript:alert(1)" },
    { ...good, id: "wrong-mime", kind: "image" },
    { ...good, id: "svg", kind: "image", mimeType: "image/svg+xml" },
    { ...good, id: "internal", storagePath: "daily-media/private", createdBy: "staff-1" },
    ...Array.from({ length: 8 }, (_, index) => ({ ...good, id: `later-${index}` })),
  ];

  const result = sanitizePublicMediaItems(input);
  assert.equal(result.length, 6);
  assert.equal(result[0].id, "media-1");
  assert.equal(JSON.stringify(result).includes("storagePath"), false);
  assert.equal(JSON.stringify(result).includes("createdBy"), false);
});

test("homepage media client rejects malformed text and non-array payloads", () => {
  const base = {
    id: "media-1",
    kind: "image",
    url: "https://media.example.test/photo.webp",
    mimeType: "image/webp",
    title: "今日球场",
    altText: "匹克球场照片",
    publishedAt: "2026-08-12T01:00:00.000Z",
    pinned: false,
  };
  assert.deepEqual(sanitizePublicMediaItems({ items: [base] }), []);
  assert.deepEqual(sanitizePublicMediaItems([{ ...base, title: "" }]), []);
  assert.deepEqual(sanitizePublicMediaItems([{ ...base, altText: "x\u0000" }]), []);
  assert.equal(sanitizePublicMediaItems([base]).length, 1);
});
