import assert from "node:assert/strict";
import test from "node:test";
import { schedulingEndOptions, nextHonorSortOrder } from "../admin-client/form-helpers.ts";
import { loadHomepageMedia } from "../homepage-media-client/index.ts";

test("admin end options retain long/half-hour bookings and stop at closing time", () => {
  assert.equal(schedulingEndOptions("09:00", "", 60).selected, "10:00");
  assert.equal(schedulingEndOptions("09:00", "", 30).selected, "09:30");
  assert.equal(schedulingEndOptions("21:30", "20:00", 60).selected, "22:00");
  assert.deepEqual(schedulingEndOptions("21:30", "22:00", 30).options, ["22:00"]);
  assert.equal(schedulingEndOptions("09:00", "19:30", 60).selected, "19:30");
  assert.equal(schedulingEndOptions("09:00", "09:30", 60).selected, "09:30");
  assert.equal(schedulingEndOptions("10:00", "10:00", 60).selected, "11:00");
  assert.deepEqual(schedulingEndOptions("bad", "", 30), { options: [], selected: "" });
  assert.deepEqual(schedulingEndOptions("22:00", "", 30), { options: [], selected: "" });
});

test("honor sort follows the largest custom order without exceeding its limit", () => {
  assert.equal(nextHonorSortOrder([]), 1);
  assert.equal(nextHonorSortOrder([{sortOrder: 2}, {sortOrder: 30}]), 31);
  assert.equal(nextHonorSortOrder([{sortOrder: 9999}]), 9999);
});

function mediaHarness() {
  const document = { createElement: (tag) => node(tag), querySelector: () => container };
  function node(tag) {
    return { tag, ownerDocument: document, children: [], dataset: {}, attributes: {}, hidden: false,
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this[name] = handler; },
    };
  }
  const elements = Object.fromEntries(["list", "dates", "title", "today", "status", "retry"].map(key => [key, node("div")]));
  const container = node("section");
  container.dataset.apiBase = "https://example.test";
  container.querySelector = (selector) => elements[selector.match(/media-(\w+)/)[1]];
  const pending = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => pending.push({ url, init, resolve, reject }));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const respond = (index, data) => pending[index].resolve({ok: true, json: async () => ({data})});
  const choose = (date) => {
    const select = elements.dates.children[0].children[0];
    select.value = date;
    select.change();
  };
  return {document, elements, container, pending, fetchImpl, respond, choose, settle};
}

const dates = ["2026-08-12", "2026-08-11", "2026-08-10"];
const item = (date) => ({ id: date, title: date, kind: "image", mimeType: "image/jpeg", altText: "比赛照片",
  url: "https://example.test/photo.jpg", publishedAt: date + "T02:00:00Z", mediaDate: date, pinned: false });

test("archive uses a date select and latest selection wins even when replies arrive backwards", async () => {
  const h = mediaHarness();
  const initial = loadHomepageMedia(h.document, h.fetchImpl);
  h.respond(0, {items: [item(dates[0])], availableDates: dates});
  await initial;
  assert.equal(h.elements.dates.children[0].children[0].tag, "select");
  assert.equal(h.elements.dates.children[0].children[0].children.length, 3);
  h.choose(dates[1]); h.choose(dates[2]);
  h.respond(2, {items: [item(dates[2])]}); await h.settle();
  h.respond(1, {items: [item(dates[1])]}); await h.settle();
  assert.match(h.elements.title.textContent, /2026年8月10日/);
  assert.equal(h.elements.list.children[0].children[1].children[0].textContent, dates[2]);
  assert.equal(h.container.attributes["aria-busy"], "false");
});

test("empty or wrong-day archive responses cannot leave previous photos under a new date", async () => {
  const h = mediaHarness();
  const initial = loadHomepageMedia(h.document, h.fetchImpl);
  h.respond(0, {items: [item(dates[0])], availableDates: dates}); await initial;
  h.choose(dates[1]); h.respond(1, {items: [item(dates[0])]}); await h.settle();
  assert.equal(h.elements.list.children.length, 1);
  assert.equal(h.elements.list.children[0].className, "daily-media-empty");
  assert.match(h.elements.title.textContent, /8月11日/);
});

test("failed archive selection retains the previous date and has a working retry", async () => {
  const h = mediaHarness();
  const initial = loadHomepageMedia(h.document, h.fetchImpl);
  h.respond(0, {items: [item(dates[0])], availableDates: dates}); await initial;
  h.choose(dates[1]); h.pending[1].reject(new Error("offline")); await h.settle();
  assert.match(h.elements.title.textContent, /8月12日/);
  assert.equal(h.elements.retry.hidden, false);
  assert.match(h.elements.status.textContent, /仍显示上次/);
  h.elements.retry.onclick(); h.respond(2, {items: [item(dates[1])]}); await h.settle();
  assert.match(h.elements.title.textContent, /8月11日/);
  assert.equal(h.elements.retry.hidden, true);
});

test("initial media failure is retryable and an empty library is a real empty state", async () => {
  const h = mediaHarness();
  const initial = loadHomepageMedia(h.document, h.fetchImpl);
  h.pending[0].reject(new Error("offline")); await initial;
  assert.equal(h.elements.retry.hidden, false);
  h.elements.retry.onclick(); h.respond(1, {items: []}); await h.settle();
  assert.equal(h.elements.list.children[0].className, "daily-media-empty");
  assert.equal(h.elements.retry.hidden, true);
});
