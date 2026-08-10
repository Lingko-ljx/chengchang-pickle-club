import { BookingService } from "../../lib/booking/booking-service.ts";
import { BookingError } from "../../lib/booking/errors.ts";
import type {
  AdminBookingFilter,
  AuditLog,
  BookingMode,
  BookingRecord,
  BookingStatus,
  CourtRecord,
  SessionTemplateRecord,
} from "../../lib/booking/types.ts";
import { currentUser, requireBookingStaff, type AuthFetch } from "./auth/current-user.ts";
import {
  parseRequestBody,
  queryParameter,
  requestHeader,
  requestMethod,
  requestPath,
  type CloudBaseHttpEvent,
} from "./http/request.ts";
import { errorResponse, jsonResponse, type HttpResponse } from "./http/response.ts";
import { CloudBaseBookingRepository } from "./repositories/cloudbase-booking-repository.ts";
import { readAdminRuntimeConfiguration } from "./runtime-config.ts";

interface AdminBookingService {
  confirm(input: { bookingId: string; expectedVersion: number; actorId: string }): Promise<BookingRecord>;
  proposeReschedule(input: {
    bookingId: string;
    expectedVersion: number;
    actorId: string;
    sessionId: string;
  }): Promise<BookingRecord>;
  cancel(input: {
    bookingId: string;
    expectedVersion: number;
    actorType: "staff";
    actorId: string;
  }): Promise<BookingRecord>;
  complete(input: { bookingId: string; expectedVersion: number; actorId: string }): Promise<BookingRecord>;
  reassign(input: {
    bookingId: string;
    expectedVersion: number;
    actorId: string;
    courtId: string;
  }): Promise<BookingRecord>;
  redactPersonalData(
    bookingId: string,
    actorId: string,
    expectedVersion: number,
    actorType?: "staff" | "system",
  ): Promise<void>;
  listAvailability(date: string): Promise<unknown[]>;
  listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]>;
  listPendingBookings(date: string): Promise<BookingRecord[]>;
  listMatrixBookings(date: string): Promise<BookingRecord[]>;
  listCourts(): Promise<CourtRecord[]>;
  listSessionTemplates(): Promise<SessionTemplateRecord[]>;
  listAuditLogs(bookingId: string): Promise<AuditLog[]>;
  setCourtEnabled(
    courtId: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void>;
  setSessionTemplateEnabled(
    templateId: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void>;
}

export interface AdminApiDependencies {
  service: AdminBookingService;
  fetch?: AuthFetch;
  envId: string;
  allowedUserIds: readonly string[];
}

function privateAdminResponse(response: HttpResponse): HttpResponse {
  return {
    ...response,
    headers: {
      ...response.headers,
      "Cache-Control": "no-store, private",
      Pragma: "no-cache",
    },
  };
}

const statuses = new Set<BookingStatus>([
  "pending",
  "confirmed",
  "reschedule_proposed",
  "cancelled",
  "completed",
]);
const modes = new Set<BookingMode>(["private", "open"]);

function decoded(value: string): string {
  try {
    const result = decodeURIComponent(value).trim();
    if (!result) throw new BookingError("INVALID_INPUT");
    return result;
  } catch (error) {
    if (error instanceof BookingError) throw error;
    throw new BookingError("INVALID_INPUT");
  }
}

function dateValue(value: string | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BookingError("INVALID_INPUT");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BookingError("INVALID_INPUT");
  }
  return value;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function expectedVersion(body: Record<string, unknown>): number {
  const value = integer(body.expectedVersion ?? body.expected_version);
  if (value === null || value < 0) throw new BookingError("INVALID_INPUT");
  return value;
}

function stringField(body: Record<string, unknown>, camel: string, snake = camel): string {
  const value = body[camel] ?? body[snake];
  return typeof value === "string" ? value.trim() : "";
}

function booleanField(body: Record<string, unknown>, name: string): boolean {
  if (body[name] === true || body[name] === false) return body[name];
  throw new BookingError("INVALID_INPUT");
}

function adminBooking(value: BookingRecord): Record<string, unknown> {
  return {
    id: value.id,
    code: value.code,
    sessionId: value.sessionId,
    date: value.date,
    startAt: value.startAt,
    endAt: value.endAt,
    courtId: value.courtId,
    ...(value.proposedDate ? { proposedDate: value.proposedDate } : {}),
    ...(value.proposedSessionId ? { proposedSessionId: value.proposedSessionId } : {}),
    ...(value.proposedCourtId ? { proposedCourtId: value.proposedCourtId } : {}),
    ...(value.proposedStartAt ? { proposedStartAt: value.proposedStartAt } : {}),
    ...(value.proposedEndAt ? { proposedEndAt: value.proposedEndAt } : {}),
    mode: value.mode,
    partySize: value.partySize,
    status: value.status,
    ...(value.proposalPreviousStatus ? { proposalPreviousStatus: value.proposalPreviousStatus } : {}),
    ...(value.name ? { name: value.name } : {}),
    ...(value.phone ? { phone: value.phone } : {}),
    ...(value.email ? { email: value.email } : {}),
    ...(value.note ? { note: value.note } : {}),
    privacyConsentAt: value.privacyConsentAt,
    canCancelUntil: value.canCancelUntil,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.terminalAt ? { terminalAt: value.terminalAt } : {}),
    ...(value.personalDataRedactedAt
      ? { personalDataRedactedAt: value.personalDataRedactedAt }
      : {}),
    version: value.version,
  };
}

function adminAudit(value: AuditLog): Record<string, unknown> {
  return {
    id: value.id,
    action: value.action,
    actorType: value.actorType,
    ...(value.fromStatus ? { fromStatus: value.fromStatus } : {}),
    ...(value.toStatus ? { toStatus: value.toStatus } : {}),
    at: value.at,
  };
}

const csvColumns: Array<[string, (booking: BookingRecord) => unknown]> = [
  ["booking_code", (booking) => booking.code],
  ["date", (booking) => booking.date],
  ["start_at", (booking) => booking.startAt],
  ["end_at", (booking) => booking.endAt],
  ["court_id", (booking) => booking.courtId],
  ["mode", (booking) => booking.mode],
  ["party_size", (booking) => booking.partySize],
  ["status", (booking) => booking.status],
  ["name", (booking) => booking.name],
  ["phone", (booking) => booking.phone],
  ["email", (booking) => booking.email],
  ["note", (booking) => booking.note],
  ["created_at", (booking) => booking.createdAt],
  ["updated_at", (booking) => booking.updatedAt],
  ["terminal_at", (booking) => booking.terminalAt],
  ["personal_data_redacted_at", (booking) => booking.personalDataRedactedAt],
  ["version", (booking) => booking.version],
];

function safeCsvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  const first = text.search(/\S/);
  if (first >= 0 && /^[=+\-@]/.test(text.slice(first))) {
    text = `${text.slice(0, first)}'${text.slice(first)}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function csvResponse(bookings: BookingRecord[]): HttpResponse {
  const rows = [
    csvColumns.map(([name]) => safeCsvCell(name)).join(","),
    ...bookings.map((booking) =>
      csvColumns.map(([, project]) => safeCsvCell(project(booking))).join(","),
    ),
  ];
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="bookings.csv"',
    },
    body: `${rows.join("\r\n")}\r\n`,
  };
}

function listFilter(event: CloudBaseHttpEvent): AdminBookingFilter {
  const filter: AdminBookingFilter = { limit: 100 };
  const date = queryParameter(event, "date")?.trim();
  const status = queryParameter(event, "status")?.trim() as BookingStatus | undefined;
  const mode = queryParameter(event, "mode")?.trim() as BookingMode | undefined;
  const query = queryParameter(event, "q")?.trim();
  if (date) filter.date = dateValue(date);
  if (status) {
    if (!statuses.has(status)) throw new BookingError("INVALID_INPUT");
    filter.status = status;
  }
  if (mode) {
    if (!modes.has(mode)) throw new BookingError("INVALID_INPUT");
    filter.mode = mode;
  }
  if (query) filter.query = query;
  return filter;
}

export function createAdminApiHandler(dependencies: AdminApiDependencies) {
  async function handleAdminApi(event: CloudBaseHttpEvent): Promise<HttpResponse> {
    try {
      const profile = await currentUser(
        requestHeader(event, "authorization"),
        dependencies.envId,
        dependencies.fetch,
      );
      requireBookingStaff(profile, dependencies.allowedUserIds);
      const actorId = profile.user_id;
      const method = requestMethod(event);
      const path = requestPath(event);

      if (method === "GET" && path === "/v1/admin/dashboard") {
        const date = dateValue(queryParameter(event, "date")?.trim());
        const [pending, slots] = await Promise.all([
          dependencies.service.listPendingBookings(date),
          dependencies.service.listAvailability(date),
        ]);
        return jsonResponse(200, { date, pending: pending.map(adminBooking), slots });
      }

      if (method === "GET" && path === "/v1/admin/matrix") {
        const date = dateValue(queryParameter(event, "date")?.trim());
        const bookings = await dependencies.service.listMatrixBookings(date);
        return jsonResponse(200, bookings.map(adminBooking));
      }

      if (method === "GET" && path === "/v1/admin/bookings") {
        const bookings = await dependencies.service.listBookings(listFilter(event));
        return jsonResponse(200, bookings.map(adminBooking));
      }

      if (method === "GET" && path === "/v1/admin/settings") {
        const [courts, sessionTemplates] = await Promise.all([
          dependencies.service.listCourts(),
          dependencies.service.listSessionTemplates(),
        ]);
        return jsonResponse(200, {
          courts: courts.map(({ id, enabled, version }) => ({ id, enabled, version })),
          sessionTemplates: sessionTemplates.map(
            ({ id, startTime, endTime, enabled, version }) => ({
              id, startTime, endTime, enabled, version,
            }),
          ),
        });
      }

      const auditHistory = /^\/v1\/admin\/bookings\/([^/]+)\/audit-logs$/.exec(path);
      if (method === "GET" && auditHistory) {
        const logs = await dependencies.service.listAuditLogs(decoded(auditHistory[1]));
        return jsonResponse(200, logs.map(adminAudit));
      }

      if (method === "GET" && path === "/v1/admin/export.csv") {
        const from = dateValue(queryParameter(event, "from")?.trim());
        const to = dateValue(queryParameter(event, "to")?.trim());
        if (from > to) throw new BookingError("INVALID_INPUT");
        const bookings = await dependencies.service.listBookings({
          fromDate: from,
          toDate: to,
          limit: 500,
        });
        if (bookings.length >= 500) throw new BookingError("EXPORT_TOO_LARGE");
        return csvResponse(bookings);
      }

      const mutation = /^\/v1\/admin\/bookings\/([^/]+)\/(confirm|reschedule|cancel|complete|reassign|redact)$/.exec(path);
      if (method === "POST" && mutation) {
        const bookingId = decoded(mutation[1]);
        const action = mutation[2];
        const body = parseRequestBody(event).values;
        const version = expectedVersion(body);
        if (action === "confirm") {
          return jsonResponse(200, adminBooking(await dependencies.service.confirm({ bookingId, expectedVersion: version, actorId })));
        }
        if (action === "reschedule") {
          const sessionId = stringField(body, "sessionId", "session_id");
          if (!sessionId) throw new BookingError("INVALID_INPUT");
          return jsonResponse(200, adminBooking(await dependencies.service.proposeReschedule({ bookingId, expectedVersion: version, actorId, sessionId })));
        }
        if (action === "cancel") {
          return jsonResponse(200, adminBooking(await dependencies.service.cancel({ bookingId, expectedVersion: version, actorType: "staff", actorId })));
        }
        if (action === "complete") {
          return jsonResponse(200, adminBooking(await dependencies.service.complete({ bookingId, expectedVersion: version, actorId })));
        }
        if (action === "reassign") {
          const courtId = stringField(body, "courtId", "court_id");
          if (!courtId) throw new BookingError("INVALID_INPUT");
          return jsonResponse(200, adminBooking(await dependencies.service.reassign({ bookingId, expectedVersion: version, actorId, courtId })));
        }
        await dependencies.service.redactPersonalData(bookingId, actorId, version, "staff");
        return jsonResponse(200, { redacted: true });
      }

      const court = /^\/v1\/admin\/courts\/([^/]+)$/.exec(path);
      if (method === "PUT" && court) {
        const body = parseRequestBody(event).values;
        await dependencies.service.setCourtEnabled(
          decoded(court[1]),
          booleanField(body, "enabled"),
          actorId,
          expectedVersion(body),
        );
        return jsonResponse(200, { updated: true });
      }

      const template = /^\/v1\/admin\/session-templates\/([^/]+)$/.exec(path);
      if (method === "PUT" && template) {
        const body = parseRequestBody(event).values;
        await dependencies.service.setSessionTemplateEnabled(
          decoded(template[1]),
          booleanField(body, "enabled"),
          actorId,
          expectedVersion(body),
        );
        return jsonResponse(200, { updated: true });
      }

      throw new BookingError("BOOKING_NOT_FOUND");
    } catch (error) {
      return errorResponse(error);
    }
  }
  return async function adminApi(event: CloudBaseHttpEvent): Promise<HttpResponse> {
    return privateAdminResponse(await handleAdminApi(event));
  };
}

let productionHandler: ReturnType<typeof createAdminApiHandler> | undefined;

export async function main(event: CloudBaseHttpEvent): Promise<HttpResponse> {
  try {
    const configuration = readAdminRuntimeConfiguration(process.env);
    productionHandler ??= createAdminApiHandler({
      service: new BookingService(new CloudBaseBookingRepository()),
      envId: configuration.envId,
      allowedUserIds: configuration.allowedUserIds,
    });
    return await productionHandler(event);
  } catch (error) {
    return privateAdminResponse(errorResponse(error));
  }
}
