import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bindMobileSiteNavigation,
  sanitizePublicHonorMediaItems,
} from "../honor-media-client/index.ts";

const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const buildScript = await readFile(new URL("../scripts/build-browser-clients.mjs", import.meta.url), "utf8");
const honorClientSource = await readFile(new URL("../honor-media-client/index.ts", import.meta.url), "utf8");

test("honor media client accepts a bounded public image and video manifest", () => {
  const image = {
    id: "honor-1",
    kind: "image",
    url: "https://media.example.test/certificate.webp",
    mimeType: "image/webp",
    title: "CPC-1000 获奖证书",
    owner: "liu-qirui",
    year: 2026,
    awardDescription: "公开组男子单打第一名",
    altText: "刘栖睿匹克球男子单打获奖证书",
    sortOrder: 1,
  };
  const video = {
    ...image,
    id: "honor-2",
    kind: "video",
    url: "https://media.example.test/podium.mp4",
    mimeType: "video/mp4",
    title: "冠军领奖时刻",
  };
  const result = sanitizePublicHonorMediaItems([
    image,
    video,
    { ...image, id: "unsafe", url: "javascript:alert(1)" },
    { ...image, id: "wrong-kind", kind: "video" },
    { ...image, id: "internal", storagePath: "private/file", createdBy: "staff" },
    ...Array.from({ length: 20 }, (_, index) => ({ ...image, id: `later-${index}` })),
  ]);

  assert.equal(result.length, 12);
  assert.deepEqual(result.slice(0, 2).map(({ id }) => id), ["honor-1", "honor-2"]);
  assert.equal(JSON.stringify(result).includes("storagePath"), false);
  assert.equal(JSON.stringify(result).includes("createdBy"), false);
});

test("honor media client rejects malformed public entries", () => {
  const valid = {
    id: "honor-1",
    kind: "image",
    url: "https://media.example.test/certificate.jpg",
    mimeType: "image/jpeg",
    title: "获奖证书",
    owner: "coach-team",
    year: 2026,
    awardDescription: "匹克球比赛获奖证书",
    altText: "匹克球比赛获奖证书",
    sortOrder: 2,
  };

  assert.deepEqual(sanitizePublicHonorMediaItems({ items: [valid] }), []);
  assert.deepEqual(sanitizePublicHonorMediaItems([{ ...valid, title: "" }]), []);
  assert.deepEqual(sanitizePublicHonorMediaItems([{ ...valid, altText: "bad\u0000text" }]), []);
  assert.equal(sanitizePublicHonorMediaItems([valid]).length, 1);
});

test("homepage provides an independent honor manifest target with static fallback", () => {
  assert.match(pageSource, /data-honor-media>/);
  assert.match(pageSource, /data-honor-media-list/);
  assert.match(pageSource, /data-honor-media-fallback/);
  assert.match(pageSource, /<script[^>]+data-honor-media-client[^>]+defer/);
  assert.match(buildScript, /"honor-media":\s*"honor-media-client\/index\.ts"/);
});

test("mobile users get a native sticky directory with stable section links", () => {
  assert.match(pageSource, /className="mobile-site-nav"/);
  assert.match(pageSource, /<summary>浏览目录<\/summary>/);
  for (const target of ["#home", "#daily-moments", "#team", "#honors", "#booking", "#contact"]) {
    assert.match(pageSource, new RegExp(`href="${target}"`));
  }
  assert.match(globalStyles, /\.mobile-site-nav\s*\{[^}]*display:\s*none;/s);
  assert.match(globalStyles, /@media\s*\(max-width:\s*860px\)[\s\S]*\.mobile-site-nav\s*\{[^}]*display:\s*block;[^}]*position:\s*sticky;/s);
  assert.match(globalStyles, /@media\s*\(max-width:\s*860px\)[\s\S]*\.mobile-site-nav\s*\{[^}]*top:\s*calc\(78px/s);
  assert.match(globalStyles, /@media\s*\(max-width:\s*620px\)[\s\S]*\.mobile-site-nav\s*\{[^}]*top:\s*calc\(70px/s);
  assert.match(globalStyles, /@media\s*\(max-width:\s*860px\)[\s\S]*scroll-padding-top:\s*calc\(122px/s);
  assert.match(globalStyles, /@media\s*\(max-width:\s*620px\)[\s\S]*scroll-padding-top:\s*calc\(114px/s);
  assert.match(globalStyles, /\.mobile-site-nav a\s*\{[^}]*min-height:\s*44px;/s);
  assert.equal(typeof bindMobileSiteNavigation, "function");
  assert.match(honorClientSource, /event\.key === "Escape"/);

  const handlers = {};
  const linkHandlers = {};
  let summaryFocused = false;
  const menu = {
    open: true,
    querySelectorAll: () => [{
      addEventListener: (event, handler) => { linkHandlers[event] = handler; },
    }],
    addEventListener: (event, handler) => { handlers[event] = handler; },
    querySelector: () => ({ focus: () => { summaryFocused = true; } }),
  };
  bindMobileSiteNavigation({ querySelector: () => menu });
  linkHandlers.click();
  assert.equal(menu.open, false);
  menu.open = true;
  handlers.keydown({ key: "Escape" });
  assert.equal(menu.open, false);
  assert.equal(summaryFocused, true);
});

test("mobile coach and honor sections use compact horizontal snap tracks", () => {
  assert.match(pageSource, /className="honor-champion-track"/);
  assert.match(pageSource, /className="honor-history-track honor-list"/);
  assert.match(pageSource, /className="[^"]*\bhonor-media-track\b[^"]*"/);
  assert.match(globalStyles, /@media\s*\(max-width:\s*760px\)[\s\S]*\.coach-feature-grid\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*x mandatory;/s);
  assert.match(globalStyles, /@media\s*\(max-width:\s*760px\)[\s\S]*\.honor-champion-track[\s\S]*overflow-x:\s*auto;[\s\S]*scroll-snap-type:\s*x mandatory;/s);
  assert.match(globalStyles, /@media\s*\(max-width:\s*760px\)[\s\S]*\.honor-history-track[\s\S]*overflow-x:\s*auto;/s);
  assert.match(globalStyles, /\.honor-media-track\s*\{[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*x mandatory;/s);
  assert.match(globalStyles, /@media\s*\(max-width:\s*760px\)[\s\S]*\.coach-support-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
});
