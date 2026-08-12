import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createAdminApiClient } from "../admin-client/api.ts";
import { bookingActionsFor, bookingRecordActionsFor } from "../admin-client/render.ts";
import { createAdminApiHandler } from "../cloudbase/src/admin-api.ts";
import { BookingService, courtIds } from "../lib/booking/booking-service.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";

const DATE = "2099-01-05";
const STAFF_UID = "2086466604197666817";

function ids() {
  let booking = 0;
  let event = 0;
  return {
    bookingId: () => `staff-booking-${++booking}`,
    bookingCode: () => "UNUSED-STAFF-CODE",
    eventId: () => `staff-event-${++event}`,
  };
}

function setup() {
  const repository = new MemoryBookingRepository({
    bookingInventoryV2Ready: true,
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
    sessionTemplates: [],
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    ids(),
    { hash: () => "not-used" },
  );
  return { repository, service };
}

function staffCommand(overrides = {}) {
  return {
    title: "青山湖羽协包场",
    date: DATE,
    startTime: "09:00",
    endTime: "09:30",
    courtId: "01",
    actorId: STAFF_UID,
    ...overrides,
  };
}

function httpEvent(method, path, body) {
  return {
    httpMethod: method,
    path,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test("staff can reserve one exact court for half-hour or longer-than-four-hour windows", async () => {
  const { repository, service } = setup();

  const halfHour = await service.createStaffReservation(staffCommand());
  const longWindow = await service.createStaffReservation(staffCommand({
    title: "高校联赛",
    startTime: "10:00",
    endTime: "15:30",
  }));

  assert.deepEqual(
    {
      kind: halfHour.bookingKind,
      title: halfHour.staffReservationTitle,
      status: halfHour.status,
      mode: halfHour.mode,
      partySize: halfHour.partySize,
      courtId: halfHour.courtId,
      name: halfHour.name,
      phone: halfHour.phone,
      email: halfHour.email,
      privacyConsentAt: halfHour.privacyConsentAt,
      publicScheduleConsentVersion: halfHour.publicScheduleConsentVersion,
      publicScheduleConsentAt: halfHour.publicScheduleConsentAt,
    },
    {
      kind: "staff_reservation",
      title: "青山湖羽协包场",
      status: "confirmed",
      mode: "private",
      partySize: 4,
      courtId: "01",
      name: undefined,
      phone: undefined,
      email: undefined,
      privacyConsentAt: undefined,
      publicScheduleConsentVersion: undefined,
      publicScheduleConsentAt: undefined,
    },
  );
  assert.equal(longWindow.staffReservationTitle, "高校联赛");
  const inventory = (await repository.listCourtDayInventories(DATE))
    .find(({ courtId }) => courtId === "01");
  assert.deepEqual(inventory.cells["0900"].bookingIds, [halfHour.id]);
  assert.deepEqual(inventory.cells["1000"].bookingIds, [longWindow.id]);
  assert.deepEqual(inventory.cells["1500"].bookingIds, [longWindow.id]);
  assert.equal((await repository.listAuditLogs(halfHour.id))[0].action, "staff_reservation_created");
});

test("staff reservations reject overlap and invalid public-contact or time data atomically", async () => {
  const { repository, service } = setup();
  const first = await service.createStaffReservation(staffCommand());

  await assert.rejects(
    () => service.createStaffReservation(staffCommand({ title: "重复包场" })),
    /SESSION_FULL/,
  );
  for (const invalid of [
    { startTime: "08:30", endTime: "09:30" },
    { startTime: "09:15", endTime: "10:15" },
    { startTime: "21:30", endTime: "22:30" },
    { startTime: "10:00", endTime: "10:00" },
    { title: "\u0000联系人" },
    { courtId: "99" },
  ]) {
    await assert.rejects(
      () => service.createStaffReservation(staffCommand({ ...invalid, courtId: invalid.courtId ?? "02" })),
      /INVALID_INPUT|SESSION_CLOSED/,
    );
  }
  assert.deepEqual((await repository.listBookings({ date: DATE })).map(({ id }) => id), [first.id]);
});

test("editing a staff reservation atomically releases old cells and preserves them on conflict", async () => {
  const { repository, service } = setup();
  const editable = await service.createStaffReservation(staffCommand({ endTime: "10:00" }));
  await service.createStaffReservation(staffCommand({
    title: "已占用",
    startTime: "10:00",
    endTime: "11:00",
    courtId: "02",
  }));

  await assert.rejects(
    () => service.updateStaffReservation({
      bookingId: editable.id,
      expectedVersion: editable.version,
      ...staffCommand({ title: "冲突修改", startTime: "10:00", endTime: "11:00", courtId: "02" }),
    }),
    /SESSION_FULL/,
  );
  let inventories = await repository.listCourtDayInventories(DATE);
  assert.ok(inventories.find(({ courtId }) => courtId === "01").cells["0900"].bookingIds.includes(editable.id));

  const updated = await service.updateStaffReservation({
    bookingId: editable.id,
    expectedVersion: editable.version,
    ...staffCommand({ title: "单位包场（已改）", startTime: "11:30", endTime: "13:00", courtId: "02" }),
  });
  assert.equal(updated.staffReservationTitle, "单位包场（已改）");
  assert.equal(updated.courtId, "02");
  assert.equal(updated.version, editable.version + 1);
  inventories = await repository.listCourtDayInventories(DATE);
  assert.equal(inventories.find(({ courtId }) => courtId === "01").cells["0900"], undefined);
  assert.ok(inventories.find(({ courtId }) => courtId === "02").cells["1130"].bookingIds.includes(editable.id));
  assert.deepEqual(
    (await repository.listAuditLogs(editable.id)).map(({ action }) => action),
    ["staff_reservation_created", "staff_reservation_updated"],
  );
});

test("a staff reservation uses the normal cancel and recoverable archive lifecycle", async () => {
  const { repository, service } = setup();
  const created = await service.createStaffReservation(staffCommand());
  const cancelled = await service.cancel({
    bookingId: created.id,
    expectedVersion: created.version,
    actorType: "staff",
    actorId: STAFF_UID,
  });
  const archived = await service.archiveBooking(
    cancelled.id,
    STAFF_UID,
    cancelled.version,
  );

  assert.equal(cancelled.status, "cancelled");
  assert.ok(archived.archivedAt);
  assert.deepEqual(await service.listBookings({ date: DATE }), []);
  assert.equal((await service.listBookings({ date: DATE, archive: "archived" }))[0].id, created.id);
  const inventory = (await repository.listCourtDayInventories(DATE))
    .find(({ courtId }) => courtId === "01");
  assert.equal(inventory?.cells["0900"], undefined);
  assert.deepEqual(bookingActionsFor(created), [
    ["complete", "完结预约"],
    ["cancel", "取消预约"],
  ]);
  assert.deepEqual(bookingRecordActionsFor(cancelled), [["archive", "删除记录"]]);
});

test("admin API creates and updates staff reservations without accepting contact or forged actor fields", async () => {
  const { service } = setup();
  const handler = createAdminApiHandler({
    service,
    resolveTrustedUid: async () => STAFF_UID,
    allowedUserIds: [STAFF_UID],
  });

  const createdResponse = await handler(httpEvent("POST", "/v1/admin/staff-reservations", {
    title: "企业团建",
    date: DATE,
    startTime: "09:30",
    endTime: "11:00",
    courtId: "03",
  }));
  assert.equal(createdResponse.statusCode, 201);
  const created = JSON.parse(createdResponse.body).data;
  assert.equal(created.bookingKind, "staff_reservation");
  assert.equal(created.staffReservationTitle, "企业团建");
  assert.equal(created.phone, undefined);
  assert.equal(created.partySize, undefined);
  assert.equal(created.occupancyLabel, "整场占用");
  assert.equal(created.participantCountLabel, "人数未登记");
  assert.equal(created.privacyConsentAt, undefined);

  const updatedResponse = await handler(httpEvent(
    "PUT",
    `/v1/admin/staff-reservations/${encodeURIComponent(created.id)}`,
    {
      title: "企业团建（改期）",
      date: DATE,
      startTime: "12:30",
      endTime: "14:00",
      courtId: "04",
      expectedVersion: created.version,
    },
  ));
  assert.equal(updatedResponse.statusCode, 200);
  assert.equal(JSON.parse(updatedResponse.body).data.staffReservationTitle, "企业团建（改期）");

  for (const body of [
    { title: "泄露联系人", date: DATE, startTime: "15:00", endTime: "16:00", courtId: "01", contact: "13800138000" },
    { title: "伪造操作人", date: DATE, startTime: "15:00", endTime: "16:00", courtId: "01", actorId: "forged" },
  ]) {
    const rejected = await handler(httpEvent("POST", "/v1/admin/staff-reservations", body));
    assert.equal(rejected.statusCode, 400);
  }
});

test("admin client exposes authenticated create/update routes and the page has an editable court form", async () => {
  const requests = [];
  const client = createAdminApiClient({
    baseUrl: "https://booking-api.example.invalid",
    getAccessToken: () => "staff-token",
    onUnauthorized() {},
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { id: "staff-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const createBody = { title: "单位包场", date: DATE, startTime: "09:00", endTime: "09:30", courtId: "01" };
  await client.createStaffReservation(createBody);
  await client.updateStaffReservation("staff/1", { ...createBody, expectedVersion: 2 });

  assert.equal(new URL(requests[0].url).pathname, "/v1/admin/staff-reservations");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(new URL(requests[1].url).pathname, "/v1/admin/staff-reservations/staff%2F1");
  assert.equal(requests[1].init.method, "PUT");
  assert.equal(requests.every(({ init }) => init.headers.Authorization === "Bearer staff-token"), true);

  const page = await readFile(new URL("../app/admin/page.tsx", import.meta.url), "utf8");
  for (const marker of [
    'id="admin-staff-reservation-form"',
    'id="admin-staff-reservation-title"',
    'id="admin-staff-reservation-date"',
    'id="admin-staff-reservation-start"',
    'id="admin-staff-reservation-end"',
    'id="admin-staff-reservation-court"',
    'id="admin-staff-reservation-cancel-edit"',
  ]) assert.match(page, new RegExp(marker));
});
