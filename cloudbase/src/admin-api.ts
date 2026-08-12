import { BookingService, decodeBookingCursor, encodeBookingCursor } from "../../lib/booking/booking-service.ts";
import { defaultBookingPolicy } from "../../lib/booking/booking-window.ts";
import { BookingError } from "../../lib/booking/errors.ts";
import type {
  AdminBookingFilter,
  AuditLog,
  BookingMode,
  BookingRecord,
  BookingPage,
  BookingStatus,
  CourtRecord,
  SessionTemplateRecord,
} from "../../lib/booking/types.ts";
import {
  requireAllowedAdminUid,
  resolveTrustedRuntimeUid,
} from "./auth/current-user.ts";
import { cloudbaseApp } from "./cloudbase-app.ts";
import {
  parseRequestBody,
  queryParameter,
  requestMethod,
  requestPath,
  type CloudBaseHttpEvent,
} from "./http/request.ts";
import { errorResponse, jsonResponse, type HttpResponse } from "./http/response.ts";
import {
  createDefaultHomepageMediaService,
  handleAdminHomepageMedia,
  type HomepageMediaApiService,
} from "./homepage-media.ts";
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
  archiveBooking(bookingId: string, actorId: string, expectedVersion: number): Promise<BookingRecord>;
  restoreBooking(bookingId: string, actorId: string, expectedVersion: number): Promise<BookingRecord>;
  listAvailability(date: string): Promise<unknown[]>;
  listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]>;
  listBookingPage?(filter: AdminBookingFilter): Promise<BookingPage>;
  listCustomerHistory(bookingId: string, limit?: number): Promise<BookingRecord[]>;
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
  resolveTrustedUid(context: unknown): Promise<unknown>;
  allowedUserIds: readonly string[];
  mediaService?: HomepageMediaApiService;
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
    ...(value.archivedAt ? { archivedAt: value.archivedAt } : {}),
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

async function dashboardDto(service: AdminBookingService, date: string) {
  const [pending, slots] = await Promise.all([
    service.listPendingBookings(date),
    service.listAvailability(date),
  ]);
  return { date, pending: pending.map(adminBooking), slots };
}

async function settingsDto(service: AdminBookingService) {
  const [courts, sessionTemplates] = await Promise.all([
    service.listCourts(),
    service.listSessionTemplates(),
  ]);
  return {
    courts: courts.map(({ id, enabled, version }) => ({ id, enabled, version })),
    sessionTemplates: sessionTemplates.map(
      ({ id, startTime, endTime, enabled, version }) => ({
        id, startTime, endTime, enabled, version,
      }),
    ),
    bookingPolicy: { ...defaultBookingPolicy },
  };
}

function exactBody(body: Record<string, unknown>, allowed: string[]): void {
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.includes(key))) throw new BookingError("INVALID_INPUT");
  for (const [camel, snake] of [
    ["expectedVersion", "expected_version"],
    ["sessionId", "session_id"],
    ["courtId", "court_id"],
  ] as const) {
    if (
      Object.prototype.hasOwnProperty.call(body, camel) &&
      Object.prototype.hasOwnProperty.call(body, snake)
    ) throw new BookingError("INVALID_INPUT");
  }
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
  ["archived_at", (booking) => booking.archivedAt],
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
  const parameters = event.queryStringParameters;
  const allowed = new Set(["date", "from", "to", "status", "mode", "q", "archive", "cursor", "limit"]);
  if (parameters && typeof parameters === "object") {
    for (const [name, value] of Object.entries(parameters)) {
      if (!allowed.has(name) || typeof value !== "string" || !value.trim()) {
        throw new BookingError("INVALID_INPUT");
      }
    }
  }
  const filter: AdminBookingFilter = { limit: 50, archive: "active" };
  const date = queryParameter(event, "date")?.trim();
  const from = queryParameter(event, "from")?.trim();
  const to = queryParameter(event, "to")?.trim();
  const status = queryParameter(event, "status")?.trim() as BookingStatus | undefined;
  const mode = queryParameter(event, "mode")?.trim() as BookingMode | undefined;
  const query = queryParameter(event, "q")?.trim();
  const archive = queryParameter(event, "archive")?.trim() as AdminBookingFilter["archive"];
  const cursor = queryParameter(event, "cursor")?.trim();
  const requestedLimit = queryParameter(event, "limit")?.trim();
  if (date) filter.date = dateValue(date);
  if (from) filter.fromDate = dateValue(from);
  if (to) filter.toDate = dateValue(to);
  if (filter.date && (filter.fromDate || filter.toDate)) throw new BookingError("INVALID_INPUT");
  if (filter.fromDate && filter.toDate && filter.fromDate > filter.toDate) {
    throw new BookingError("INVALID_INPUT");
  }
  if (status) {
    if (!statuses.has(status)) throw new BookingError("INVALID_INPUT");
    filter.status = status;
  }
  if (mode) {
    if (!modes.has(mode)) throw new BookingError("INVALID_INPUT");
    filter.mode = mode;
  }
  if (query) {
    if (query.length > 100 || /[\u0000-\u001f\u007f]/u.test(query)) {
      throw new BookingError("INVALID_INPUT");
    }
    filter.query = query;
  }
  if (archive) {
    if (archive !== "active" && archive !== "archived" && archive !== "all") {
      throw new BookingError("INVALID_INPUT");
    }
    filter.archive = archive;
  }
  if (cursor) {
    if (cursor.length > 200 || /[\u0000-\u001f\u007f]/u.test(cursor)) {
      throw new BookingError("INVALID_INPUT");
    }
    decodeBookingCursor(cursor);
    filter.cursor = cursor;
  }
  if (requestedLimit) {
    const limit = integer(requestedLimit);
    if (limit === null || limit < 1 || limit > 100) throw new BookingError("INVALID_INPUT");
    filter.limit = limit;
  }
  if ((filter.query || filter.archive !== "active") && !filter.date && !(filter.fromDate && filter.toDate)) {
    throw new BookingError("INVALID_INPUT");
  }
  return filter;
}

const bootstrapParameters = new Set(["today", "date", "status", "mode", "q"]);

function strictQueryParameter(
  event: CloudBaseHttpEvent,
  name: string,
  required = false,
): string | undefined {
  const parameters = event.queryStringParameters;
  if (
    !parameters ||
    typeof parameters !== "object" ||
    !Object.prototype.hasOwnProperty.call(parameters, name)
  ) {
    if (required) throw new BookingError("INVALID_INPUT");
    return undefined;
  }
  const value = (parameters as Record<string, unknown>)[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new BookingError("INVALID_INPUT");
  }
  return value.trim();
}

function bootstrapInput(event: CloudBaseHttpEvent): {
  today: string;
  selectedDate: string;
  filter: AdminBookingFilter;
} {
  const parameters = event.queryStringParameters;
  if (!parameters || typeof parameters !== "object") {
    throw new BookingError("INVALID_INPUT");
  }
  if (Object.keys(parameters).some((name) => !bootstrapParameters.has(name))) {
    throw new BookingError("INVALID_INPUT");
  }
  const today = dateValue(strictQueryParameter(event, "today", true));
  const selectedDate = dateValue(strictQueryParameter(event, "date", true));
  const status = strictQueryParameter(event, "status") as BookingStatus | undefined;
  const mode = strictQueryParameter(event, "mode") as BookingMode | undefined;
  const query = strictQueryParameter(event, "q");
  if (status && !statuses.has(status)) throw new BookingError("INVALID_INPUT");
  if (mode && !modes.has(mode)) throw new BookingError("INVALID_INPUT");
  if (query && (query.length > 100 || /[\u0000-\u001f\u007f]/u.test(query))) {
    throw new BookingError("INVALID_INPUT");
  }
  return {
    today,
    selectedDate,
    filter: {
      date: selectedDate,
      ...(status ? { status } : {}),
      ...(mode ? { mode } : {}),
      ...(query ? { query } : {}),
      limit: 100,
    },
  };
}

export function createAdminApiHandler(dependencies: AdminApiDependencies) {
  async function handleAdminApi(
    event: CloudBaseHttpEvent,
    context: unknown,
  ): Promise<HttpResponse> {
    try {
      const actorId = requireAllowedAdminUid(
        await dependencies.resolveTrustedUid(context),
        dependencies.allowedUserIds,
      );
      const method = requestMethod(event);
      const path = requestPath(event);

      if (dependencies.mediaService && path.startsWith("/v1/admin/homepage-media")) {
        const mediaResponse = await handleAdminHomepageMedia({
          method,
          path,
          body: method === "GET" ? {} : parseRequestBody(event).values,
          actorId,
          service: dependencies.mediaService,
        });
        if (mediaResponse) return mediaResponse;
      }

      if (method === "GET" && path === "/v1/admin/bootstrap") {
        const { today, selectedDate, filter } = bootstrapInput(event);
        const todayDashboardPromise = dashboardDto(dependencies.service, today);
        const selectedDashboardPromise = selectedDate === today
          ? todayDashboardPromise
          : dashboardDto(dependencies.service, selectedDate);
        const [todayDashboard, selectedDashboard, bookings, matrixBookings, settings] =
          await Promise.all([
            todayDashboardPromise,
            selectedDashboardPromise,
            dependencies.service.listBookings(filter),
            dependencies.service.listMatrixBookings(selectedDate),
            settingsDto(dependencies.service),
          ]);
        return jsonResponse(200, {
          todayDashboard,
          selectedDashboard,
          bookings: bookings.map(adminBooking),
          matrixBookings: matrixBookings.map(adminBooking),
          settings,
        });
      }

      if (method === "GET" && path === "/v1/admin/dashboard") {
        const date = dateValue(queryParameter(event, "date")?.trim());
        return jsonResponse(200, await dashboardDto(dependencies.service, date));
      }

      if (method === "GET" && path === "/v1/admin/matrix") {
        const date = dateValue(queryParameter(event, "date")?.trim());
        const bookings = await dependencies.service.listMatrixBookings(date);
        return jsonResponse(200, bookings.map(adminBooking));
      }

      if (method === "GET" && path === "/v1/admin/bookings") {
        const filter = listFilter(event);
        const requestedLimit = filter.limit ?? 50;
        const page = dependencies.service.listBookingPage
          ? await dependencies.service.listBookingPage({ ...filter, limit: requestedLimit })
          : { items: await dependencies.service.listBookings({
          ...filter,
          limit: Math.min(100, requestedLimit + 1),
        }) };
        if (!dependencies.service.listBookingPage && page.items.length > requestedLimit) {
          const visible = page.items.slice(0, requestedLimit);
          page.nextCursor = visible.length > 0
            ? encodeBookingCursor(visible[visible.length - 1])
            : undefined;
        }
        const bookings = page.items;
        return jsonResponse(200, {
          items: bookings.slice(0, requestedLimit).map(adminBooking),
          nextCursor: page.nextCursor ?? null,
          hasMore: Boolean(page.nextCursor),
        });
      }

      if (method === "GET" && path === "/v1/admin/settings") {
        return jsonResponse(200, await settingsDto(dependencies.service));
      }

      const auditHistory = /^\/v1\/admin\/bookings\/([^/]+)\/audit-logs$/.exec(path);
      if (method === "GET" && auditHistory) {
        const logs = await dependencies.service.listAuditLogs(decoded(auditHistory[1]));
        return jsonResponse(200, logs.map(adminAudit));
      }

      const customerHistory = /^\/v1\/admin\/bookings\/([^/]+)\/customer-history$/.exec(path);
      if (method === "GET" && customerHistory) {
        const parameters = event.queryStringParameters;
        if (parameters && typeof parameters === "object" && Object.keys(parameters).some((name) => name !== "limit")) {
          throw new BookingError("INVALID_INPUT");
        }
        if (parameters && typeof parameters === "object" && Object.prototype.hasOwnProperty.call(parameters, "limit") && typeof (parameters as Record<string, unknown>).limit !== "string") {
          throw new BookingError("INVALID_INPUT");
        }
        const requestedLimit = queryParameter(event, "limit")?.trim();
        const limit = requestedLimit ? integer(requestedLimit) : 50;
        if (limit === null || limit < 1 || limit > 100) throw new BookingError("INVALID_INPUT");
        const bookings = await dependencies.service.listCustomerHistory(decoded(customerHistory[1]), limit);
        return jsonResponse(200, { items: bookings.map(adminBooking) });
      }

      if (method === "GET" && path === "/v1/admin/export.csv") {
        const parameters = event.queryStringParameters;
        if (!parameters || typeof parameters !== "object" || Object.keys(parameters).some((name) => name !== "from" && name !== "to")) {
          throw new BookingError("INVALID_INPUT");
        }
        const from = dateValue(queryParameter(event, "from")?.trim());
        const to = dateValue(queryParameter(event, "to")?.trim());
        if (from > to) throw new BookingError("INVALID_INPUT");
        const bookings = await dependencies.service.listBookings({
          fromDate: from,
          toDate: to,
          archive: "all",
          limit: 500,
        });
        if (bookings.length >= 500) throw new BookingError("EXPORT_TOO_LARGE");
        return csvResponse(bookings);
      }

      const mutation = /^\/v1\/admin\/bookings\/([^/]+)\/(confirm|reschedule|cancel|complete|reassign|archive|restore)$/.exec(path);
      if (method === "POST" && mutation) {
        const bookingId = decoded(mutation[1]);
        const action = mutation[2];
        const body = parseRequestBody(event).values;
        const allowedFields = action === "reschedule"
          ? ["expectedVersion", "expected_version", "sessionId", "session_id"]
          : action === "reassign"
            ? ["expectedVersion", "expected_version", "courtId", "court_id"]
            : ["expectedVersion", "expected_version"];
        exactBody(body, allowedFields);
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
        if (action === "archive") {
          return jsonResponse(200, adminBooking(await dependencies.service.archiveBooking(bookingId, actorId, version)));
        }
        if (action === "restore") {
          return jsonResponse(200, adminBooking(await dependencies.service.restoreBooking(bookingId, actorId, version)));
        }
        throw new BookingError("NOT_FOUND");
      }

      const court = /^\/v1\/admin\/courts\/([^/]+)$/.exec(path);
      if (method === "PUT" && court) {
        const body = parseRequestBody(event).values;
        exactBody(body, ["enabled", "expectedVersion", "expected_version"]);
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
        exactBody(body, ["enabled", "expectedVersion", "expected_version"]);
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
  return async function adminApi(
    event: CloudBaseHttpEvent,
    context?: unknown,
  ): Promise<HttpResponse> {
    return privateAdminResponse(await handleAdminApi(event, context));
  };
}

let productionHandler: ReturnType<typeof createAdminApiHandler> | undefined;

export async function main(
  event: CloudBaseHttpEvent,
  context?: unknown,
): Promise<HttpResponse> {
  try {
    const configuration = readAdminRuntimeConfiguration(process.env);
    const runtimeAuth = cloudbaseApp.auth();
    productionHandler ??= createAdminApiHandler({
      service: new BookingService(new CloudBaseBookingRepository()),
      mediaService: createDefaultHomepageMediaService(),
      resolveTrustedUid: (runtimeContext) =>
        resolveTrustedRuntimeUid(
          {
            getAuthContext: (trustedContext) =>
              runtimeAuth.getAuthContext(
                trustedContext as Parameters<typeof runtimeAuth.getAuthContext>[0],
              ),
          },
          runtimeContext,
        ),
      allowedUserIds: configuration.allowedUserIds,
    });
    return await productionHandler(event, context);
  } catch (error) {
    return privateAdminResponse(errorResponse(error));
  }
}
