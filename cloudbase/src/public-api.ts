import { createHmac } from "node:crypto";
import { BookingService } from "../../lib/booking/booking-service.ts";
import { requireCalendarDate } from "../../lib/booking/calendar-date.ts";
import { BookingError } from "../../lib/booking/errors.ts";
import { currentPublicScheduleConsentVersion } from "../../lib/booking/types.ts";
import type { BookingRecord } from "../../lib/booking/types.ts";
import { CloudBaseBookingRepository } from "./repositories/cloudbase-booking-repository.ts";
import {
  parseRequestBody,
  queryParameter,
  requestHeader,
  requestMethod,
  requestPath,
  trustedClientAddress,
  type CloudBaseHttpEvent,
} from "./http/request.ts";
import { createRateLimiter, type RateLimiter } from "./http/rate-limit.ts";
import { errorResponse, jsonResponse, type HttpResponse } from "./http/response.ts";
import {
  createDefaultHomepageMediaService,
  handlePublicHomepageMedia,
  type HomepageMediaApiService,
} from "./homepage-media.ts";
import { readPublicRuntimeConfiguration } from "./runtime-config.ts";

const TEN_MINUTES = 10 * 60 * 1000;

interface PublicBookingService {
  create(input: unknown): Promise<BookingRecord>;
  lookup(code: string, phone: string): Promise<BookingRecord | null>;
  cancel(input: {
    bookingId: string;
    expectedVersion: number;
    actorType: "customer";
  }): Promise<BookingRecord>;
  respondToReschedule(input: {
    bookingId: string;
    expectedVersion: number;
    accept: boolean;
    actorType: "customer";
  }): Promise<BookingRecord>;
  listAvailability(date: string): Promise<unknown[]>;
  listWindowAvailability(query: { date: string }): Promise<unknown>;
  listPublicSchedule(date: string): Promise<BookingRecord[]>;
}

export interface PublicApiDependencies {
  service: PublicBookingService;
  rateLimiter: RateLimiter;
  now?: () => Date;
  allowedOrigins: string;
  resultUrl: string;
  idempotencySalt: string;
  mediaService?: HomepageMediaApiService;
}

function field(body: Record<string, unknown>, snake: string, camel = snake): unknown {
  return body[snake] ?? body[camel];
}

function stringField(body: Record<string, unknown>, snake: string, camel = snake): string {
  const value = field(body, snake, camel);
  return typeof value === "string" ? value.trim() : "";
}

function integerField(body: Record<string, unknown>, snake: string, camel: string): number | null {
  const value = field(body, snake, camel);
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function booleanField(body: Record<string, unknown>, snake: string, camel: string): boolean | null {
  const value = field(body, snake, camel);
  if (value === true || value === "true" || value === "1" || value === "on" || value === "yes") {
    return true;
  }
  if (value === false || value === "false" || value === "0" || value === "off" || value === "no") {
    return false;
  }
  return null;
}

function normalizePhone(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function completePhone(value: unknown): string {
  const phone = normalizePhone(value);
  if (!/^\d{8,15}$/.test(phone)) throw new BookingError("INVALID_INPUT");
  return phone;
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function legacySlotWithinCurrentPolicy(value: string): boolean {
  const match = /^\d{4}-\d{2}-\d{2}__slot-(\d{2})(\d{2})$/.exec(value);
  if (!match) return true;
  const start = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) < 60 && start >= 9 * 60 && start + 60 <= 22 * 60;
}

function publicLegacyAvailabilitySlot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const slot = value as { startTime?: unknown; endTime?: unknown };
  if (typeof slot.startTime !== "string" || typeof slot.endTime !== "string") return false;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(slot.startTime);
  const end = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(slot.endTime);
  if (!match || !end) return false;
  const startMinutes = Number(match[1]) * 60 + Number(match[2]);
  const endMinutes = Number(end[1]) * 60 + Number(end[2]);
  return startMinutes >= 9 * 60 && endMinutes <= 22 * 60 && endMinutes - startMinutes === 60;
}

function canonicalSessionId(body: Record<string, unknown>): string {
  const supplied = stringField(body, "session_id", "sessionId");
  if (supplied) {
    if (!legacySlotWithinCurrentPolicy(supplied)) {
      throw new BookingError("SESSION_CLOSED");
    }
    const submittedStart = stringField(body, "start_time", "startTime");
    if (
      submittedStart &&
      !legacySlotWithinCurrentPolicy(`${supplied.slice(0, 10)}__slot-${submittedStart.replace(":", "")}`)
    ) {
      throw new BookingError("SESSION_CLOSED");
    }
    return supplied;
  }
  const date = stringField(body, "date");
  const startTime = stringField(body, "start_time", "startTime");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
    throw new BookingError("INVALID_INPUT");
  }
  const sessionId = `${date}__slot-${startTime.replace(":", "")}`;
  if (!legacySlotWithinCurrentPolicy(sessionId)) throw new BookingError("SESSION_CLOSED");
  return sessionId;
}

function shanghaiHour(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}`;
}

function canonicalBookingFields(command: Record<string, unknown>): unknown[] {
  const timing = typeof command.sessionId === "string"
    ? [command.sessionId]
    : ["booking-window-v2", command.date, command.startTime, command.endTime];
  return [
    ...timing,
    command.mode,
    command.partySize,
    command.name,
    command.phone,
    command.email ?? "",
    command.note ?? "",
    command.privacyConsent,
    command.publicScheduleConsentVersion ?? "",
  ];
}

function derivedNativeIdempotencyKey(
  salt: string,
  now: Date,
  command: Record<string, unknown>,
): string {
  const canonical = JSON.stringify([...canonicalBookingFields(command), shanghaiHour(now)]);
  return createHmac("sha256", salt).update(canonical).digest("hex");
}

function fingerprintClientIdempotencyKey(
  salt: string,
  clientKey: string,
  command: Record<string, unknown>,
): string {
  const canonical = JSON.stringify([
    typeof command.sessionId === "string"
      ? "public-api-client-v1"
      : "public-api-client-v2",
    clientKey.trim(),
    ...canonicalBookingFields(command),
  ]);
  return createHmac("sha256", salt).update(canonical).digest("hex");
}

function formatShanghaiTime(instant: string): string {
  return new Date(new Date(instant).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function maskName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return name
    .trim()
    .split(/\s+/)
    .map((part) => `${part.slice(0, 1)}${"*".repeat(Math.max(0, Array.from(part).length - 1))}`)
    .join(" ");
}

function maskPhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  if (phone.length < 8) return "*".repeat(phone.length);
  return `${phone.slice(0, 3)}${"*".repeat(phone.length - 7)}${phone.slice(-4)}`;
}

function publicBooking(booking: BookingRecord, now: Date): Record<string, unknown> {
  const result: Record<string, unknown> = {
    code: booking.code,
    status: booking.status,
    date: booking.date,
    startTime: formatShanghaiTime(booking.startAt),
    endTime: formatShanghaiTime(booking.endAt),
    mode: booking.mode,
    partySize: booking.partySize,
    actionVersion: booking.version,
    canCancelUntil: booking.canCancelUntil,
    canCancel:
      (booking.status === "pending" ||
        booking.status === "confirmed" ||
        booking.status === "reschedule_proposed") &&
      now.toISOString() < booking.canCancelUntil,
  };
  const name = maskName(booking.name);
  const phone = maskPhone(booking.phone);
  if (name) result.name = name;
  if (phone) result.phone = phone;
  if (
    booking.proposedSessionId &&
    booking.proposedStartAt &&
    booking.proposedEndAt
  ) {
    result.proposed = {
      date: booking.proposedSessionId.slice(0, 10),
      startTime: formatShanghaiTime(booking.proposedStartAt),
      endTime: formatShanghaiTime(booking.proposedEndAt),
    };
  }
  return result;
}

function publicScheduleName(booking: BookingRecord): string {
  if (booking.bookingKind === "staff_reservation") return "单位包场";
  if (
    booking.publicScheduleConsentVersion !== currentPublicScheduleConsentVersion ||
    !booking.publicScheduleConsentAt
  ) {
    return "匿名球友";
  }
  const raw = booking.name?.trim();
  if (!raw) return "球友**";
  const first = Array.from(raw)[0];
  return first ? `${first}**` : "球友**";
}

function publicScheduleItem(booking: BookingRecord): Record<string, unknown> {
  const isStaffReservation = booking.bookingKind === "staff_reservation";
  return {
    name: publicScheduleName(booking),
    startTime: formatShanghaiTime(booking.startAt),
    endTime: formatShanghaiTime(booking.endAt),
    kind: isStaffReservation ? "staff_reservation" : "customer",
    ...(isStaffReservation ? {} : { partySize: booking.partySize }),
    mode: isStaffReservation ? "private" : booking.mode,
    status: "active",
  };
}

function corsHeaders(event: CloudBaseHttpEvent, allowedOrigins: Set<string>): Record<string, string> {
  const origin = requestHeader(event, "origin");
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type, Idempotency-Key",
    Vary: "Origin",
  };
}

function isHoneypot(body: Record<string, unknown>): boolean {
  return ["website", "website_url", "company", "fax", "_gotcha"].some(
    (name) => typeof body[name] === "string" && body[name].trim() !== "",
  );
}

function createCommand(
  body: Record<string, unknown>,
  event: CloudBaseHttpEvent,
  isNativeForm: boolean,
  idempotencySalt: string,
  now: Date,
): Record<string, unknown> {
  const partySize = integerField(body, "party_size", "partySize");
  const privacyConsent = booleanField(body, "privacy_consent", "privacyConsent");
  const suppliedPublicScheduleConsent = field(
    body,
    "public_schedule_consent_version",
    "publicScheduleConsentVersion",
  );
  if (
    suppliedPublicScheduleConsent !== undefined &&
    suppliedPublicScheduleConsent !== currentPublicScheduleConsentVersion &&
    suppliedPublicScheduleConsent !== String(currentPublicScheduleConsentVersion)
  ) {
    throw new BookingError("INVALID_INPUT");
  }
  const publicScheduleConsentVersion = suppliedPublicScheduleConsent === undefined
    ? undefined
    : currentPublicScheduleConsentVersion;
  const endTime = stringField(body, "end_time", "endTime");
  const timing: Record<string, unknown> = {};
  if (endTime) {
    const date = requireCalendarDate(stringField(body, "date"));
    const startTime = stringField(body, "start_time", "startTime");
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)
    ) {
      throw new BookingError("INVALID_INPUT");
    }
    timing.date = date;
    timing.startTime = startTime;
    timing.endTime = endTime;
  } else {
    timing.sessionId = canonicalSessionId(body);
  }
  const command: Record<string, unknown> = {
    ...timing,
    mode: stringField(body, "mode"),
    partySize,
    name: stringField(body, "name"),
    phone: completePhone(field(body, "phone")),
    privacyConsent,
    ...(publicScheduleConsentVersion === currentPublicScheduleConsentVersion
      ? { publicScheduleConsentVersion: currentPublicScheduleConsentVersion }
      : {}),
  };
  const email = stringField(body, "email");
  const note = stringField(body, "note");
  if (email) command.email = email;
  if (note) command.note = note;
  const clientKey =
    stringField(body, "idempotency_key", "idempotencyKey") ||
    (requestHeader(event, "idempotency-key") ?? "").trim();
  const idempotencyKey = clientKey
    ? fingerprintClientIdempotencyKey(idempotencySalt, clientKey, command)
    : isNativeForm
      ? derivedNativeIdempotencyKey(idempotencySalt, now, command)
      : "";
  command.idempotencyKey = idempotencyKey;
  return command;
}

async function enforce(
  rateLimiter: RateLimiter,
  scope: string,
  key: string,
  limit: number,
): Promise<void> {
  if (!(await rateLimiter.consume({ scope, key, limit, windowMs: TEN_MINUTES }))) {
    throw new BookingError("RATE_LIMITED");
  }
}

function requiredVersion(body: Record<string, unknown>): number {
  const version = integerField(body, "expected_version", "expectedVersion");
  if (version === null || version < 0) throw new BookingError("INVALID_INPUT");
  return version;
}

function requiredOwnership(body: Record<string, unknown>): string {
  return completePhone(field(body, "phone"));
}

function allowedOriginSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => Boolean(origin) && origin !== "*"),
  );
}

export function createPublicApiHandler(dependencies: PublicApiDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const allowedOrigins = allowedOriginSet(dependencies.allowedOrigins);

  return async function publicApi(event: CloudBaseHttpEvent): Promise<HttpResponse> {
    const headers = corsHeaders(event, allowedOrigins);
    try {
      const method = requestMethod(event);
      const path = requestPath(event);
      if (method === "OPTIONS") {
        return { statusCode: 204, headers, body: "" };
      }

      if (dependencies.mediaService) {
        const mediaResponse = await handlePublicHomepageMedia(
          method,
          path,
          dependencies.mediaService,
        );
        if (mediaResponse) {
          return {
            ...mediaResponse,
            headers: { ...mediaResponse.headers, ...headers },
          };
        }
      }

      if (method === "GET" && path === "/v1/availability") {
        const date = requireCalendarDate(queryParameter(event, "date")?.trim() ?? "");
        const slots = await dependencies.service.listAvailability(date);
        return jsonResponse(200, slots.filter(publicLegacyAvailabilitySlot), headers);
      }

      if (method === "GET" && path === "/v1/availability/windows") {
        const date = requireCalendarDate(queryParameter(event, "date")?.trim() ?? "");
        const windows = await dependencies.service.listWindowAvailability({ date });
        return jsonResponse(200, windows, headers);
      }

      if (method === "GET" && path === "/v1/public-schedule") {
        const date = requireCalendarDate(queryParameter(event, "date")?.trim() ?? "");
        const address = trustedClientAddress(event);
        await enforce(
          dependencies.rateLimiter,
          "public-schedule-ip",
          address ?? "anonymous",
          60,
        );
        const bookings = (await dependencies.service.listPublicSchedule(date))
          .filter(
            (booking) =>
              !booking.archivedAt &&
              booking.date === date &&
              (booking.status === "confirmed" || booking.status === "reschedule_proposed"),
          )
          .sort(
            (left, right) =>
              left.startAt.localeCompare(right.startAt) ||
              left.endAt.localeCompare(right.endAt) ||
              left.id.localeCompare(right.id),
          );
        return jsonResponse(
          200,
          {
            date,
            bookingCount: bookings.length,
            participantCount: bookings.reduce(
              (total, booking) =>
                booking.bookingKind === "staff_reservation"
                  ? total
                  : total + booking.partySize,
              0,
            ),
            staffReservationCount: bookings.filter(
              (booking) => booking.bookingKind === "staff_reservation",
            ).length,
            items: bookings.map(publicScheduleItem),
          },
          { ...headers, "Cache-Control": "no-store" },
        );
      }

      if (method === "POST" && path === "/v1/bookings") {
        const parsed = parseRequestBody(event);
        if (isHoneypot(parsed.values)) return jsonResponse(202, { accepted: true }, headers);
        const nativeForm = parsed.isForm && !parsed.acceptsJson;
        const command = createCommand(
          parsed.values,
          event,
          nativeForm,
          dependencies.idempotencySalt,
          now(),
        );
        const address = trustedClientAddress(event);
        await enforce(
          dependencies.rateLimiter,
          "create-ip",
          address ?? "anonymous",
          address ? 5 : 2,
        );
        const booking = await dependencies.service.create(command);
        if (nativeForm) {
          return {
            statusCode: 303,
            headers: {
              Location: `${dependencies.resultUrl}?code=${encodeURIComponent(booking.code)}`,
            },
            body: "",
          };
        }
        return jsonResponse(201, publicBooking(booking, now()), headers);
      }

      if (method === "POST" && path === "/v1/bookings/lookup") {
        const body = parseRequestBody(event).values;
        const code = normalizeCode(stringField(body, "code"));
        const phone = requiredOwnership(body);
        if (!code) throw new BookingError("INVALID_INPUT");
        const address = trustedClientAddress(event);
        await enforce(
          dependencies.rateLimiter,
          "lookup-ip",
          address ?? "anonymous",
          address ? 10 : 3,
        );
        await enforce(dependencies.rateLimiter, "lookup-booking", `${code}\0${phone}`, 5);
        const booking = await dependencies.service.lookup(code, phone);
        if (!booking) throw new BookingError("BOOKING_NOT_FOUND");
        return jsonResponse(200, publicBooking(booking, now()), headers);
      }

      const cancellation = /^\/v1\/bookings\/([^/]+)\/cancel$/.exec(path);
      const reschedule = /^\/v1\/bookings\/([^/]+)\/reschedule-response$/.exec(path);
      if (method === "POST" && (cancellation || reschedule)) {
        const body = parseRequestBody(event).values;
        const code = normalizeCode(decodeURIComponent((cancellation ?? reschedule)![1]));
        const phone = requiredOwnership(body);
        const expectedVersion = requiredVersion(body);
        await enforce(dependencies.rateLimiter, "booking-mutation", code, 5);
        const booking = await dependencies.service.lookup(code, phone);
        if (!booking) throw new BookingError("BOOKING_NOT_FOUND");
        const updated = cancellation
          ? await dependencies.service.cancel({
              bookingId: booking.id,
              expectedVersion,
              actorType: "customer",
            })
          : await dependencies.service.respondToReschedule({
              bookingId: booking.id,
              expectedVersion,
              accept: booleanField(body, "accept", "accept") ?? (() => {
                throw new BookingError("INVALID_INPUT");
              })(),
              actorType: "customer",
            });
        return jsonResponse(200, publicBooking(updated, now()), headers);
      }

      throw new BookingError("BOOKING_NOT_FOUND");
    } catch (error) {
      return errorResponse(error, headers);
    }
  };
}

let productionHandler: ReturnType<typeof createPublicApiHandler> | undefined;

export async function main(event: CloudBaseHttpEvent): Promise<HttpResponse> {
  try {
    const configuration = readPublicRuntimeConfiguration(process.env);
    productionHandler ??= createPublicApiHandler({
      service: new BookingService(
        new CloudBaseBookingRepository(),
        undefined,
        undefined,
        {
          hash: (phone) =>
            createHmac("sha256", configuration.phoneHashSalt)
              .update(phone)
              .digest("hex"),
        },
      ),
      rateLimiter: createRateLimiter({ salt: configuration.rateLimitSalt }),
      allowedOrigins: configuration.allowedOrigins,
      resultUrl: configuration.resultUrl,
      idempotencySalt: configuration.idempotencySalt,
      mediaService: createDefaultHomepageMediaService(),
    });
    return await productionHandler(event);
  } catch (error) {
    return errorResponse(error);
  }
}
