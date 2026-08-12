import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  defaultHomepageMediaDate,
  groupHomepageMediaByDate,
  sanitizePublicMediaItems,
} from "../homepage-media-client/index.ts";

const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("homepage media client accepts a bounded dated HTTPS archive contract", () => {
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
    mediaDate: "2026-08-12",
  };
  const input = [
    good,
    { ...good, id: "javascript", url: "javascript:alert(1)" },
    { ...good, id: "wrong-mime", kind: "image" },
    { ...good, id: "svg", kind: "image", mimeType: "image/svg+xml" },
    { ...good, id: "internal", storagePath: "daily-media/private", createdBy: "staff-1" },
    ...Array.from({ length: 70 }, (_, index) => ({ ...good, id: `later-${index}` })),
  ];

  const result = sanitizePublicMediaItems(input);
  assert.equal(result.length, 60);
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
    mediaDate: "2026-08-12",
  };
  assert.deepEqual(sanitizePublicMediaItems({ items: [base] }), []);
  assert.deepEqual(sanitizePublicMediaItems([{ ...base, title: "" }]), []);
  assert.deepEqual(sanitizePublicMediaItems([{ ...base, altText: "x\u0000" }]), []);
  assert.equal(sanitizePublicMediaItems([base]).length, 1);
});

test("homepage media client groups by Beijing media date and selects today or latest past day", () => {
  const base = {
    kind: "image",
    url: "https://media.example.test/photo.webp",
    mimeType: "image/webp",
    title: "球场时刻",
    altText: "匹克球场照片",
    publishedAt: "2026-08-10T16:30:00.000Z",
    pinned: false,
  };
  const items = sanitizePublicMediaItems([
    { ...base, id: "today", mediaDate: "2026-08-12" },
    { ...base, id: "past", mediaDate: "2026-08-11" },
    { ...base, id: "legacy" },
  ]);
  const groups = groupHomepageMediaByDate(items);

  assert.deepEqual([...groups.keys()], ["2026-08-12", "2026-08-11"]);
  assert.deepEqual(groups.get("2026-08-11")?.map(({ id }) => id), ["past", "legacy"]);
  assert.equal(defaultHomepageMediaDate(groups, "2026-08-12"), "2026-08-12");
  assert.equal(defaultHomepageMediaDate(groups, "2026-08-13"), "2026-08-12");
  assert.equal(defaultHomepageMediaDate(new Map(), "2026-08-12"), undefined);
});

test("daily moments exposes today and archive controls in a compact mobile track", () => {
  assert.match(pageSource, /data-homepage-media-title/);
  assert.match(pageSource, /data-homepage-media-today/);
  assert.match(pageSource, /data-homepage-media-dates/);
  assert.match(pageSource, /data-homepage-media-empty/);
  assert.match(pageSource, /今日球场/);
  assert.match(pageSource, /往日球场/);
  assert.match(globalStyles, /@media\s*\(max-width:\s*620px\)[\s\S]*\.daily-media-grid\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*x mandatory;/s);
  assert.match(globalStyles, /\.daily-media-date-track\s*\{[^}]*overflow-x:\s*auto;/s);
});
