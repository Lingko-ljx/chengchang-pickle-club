import { createHmac } from "node:crypto";
import { BookingService } from "../../lib/booking/booking-service.ts";
import { BookingError } from "../../lib/booking/errors.ts";
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
}

export interface PublicApiDependencies {
  service: PublicBookingService;
  rateLimiter: RateLimiter;
  now?: () => Date;
  allowedOrigins: string;
  resultUrl: string;
  idempotencySalt: string;
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

function canonicalSessionId(body: Record<string, unknown>): string {
  const supplied = stringField(body, "session_id", "sessionId");
  if (supplied) return supplied;
  const date = stringField(body, "date");
  const startTime = stringField(body, "start_time", "startTime");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
    throw new BookingError("INVALID_INPUT");
  }
  return `${date}__slot-${startTime.replace(":", "")}`;
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
  return [
    command.sessionId,
    command.mode,
    command.partySize,
    command.name,
    command.phone,
    command.email ?? "",
    command.note ?? "",
    command.privacyConsent,
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
    "public-api-client-v1",
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
  const command: Record<string, unknown> = {
    sessionId: canonicalSessionId(body),
    mode: stringField(body, "mode"),
    partySize,
    name: stringField(body, "name"),
    phone: completePhone(field(body, "phone")),
    privacyConsent,
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

      if (method === "GET" && path === "/v1/availability") {
        const date = queryParameter(event, "date")?.trim() ?? "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BookingError("INVALID_INPUT");
        const slots = await dependencies.service.listAvailability(date);
        return jsonResponse(200, slots, headers);
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
    });
    return await productionHandler(event);
  } catch (error) {
    return errorResponse(error);
  }
}
