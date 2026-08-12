import { allocationId, bookingCodeId, decodeBookingCursor, encodeBookingCursor } from "../../../lib/booking/booking-service.ts";
import { courtDayInventoryId } from "../../../lib/booking/booking-window.ts";
import { BookingError } from "../../../lib/booking/errors.ts";
import type { BookingRepository, BookingTransaction, Clock } from "../../../lib/booking/ports.ts";
import type {
  AdminBookingFilter,
  AuditLog,
  AvailabilitySlot,
  BookingRecord,
  BookingPage,
  CourtAllocation,
  CourtDayInventory,
  CourtRecord,
  NotificationEvent,
  SessionRecord,
  SessionTemplateRecord,
} from "../../../lib/booking/types.ts";
import { database } from "../cloudbase-app.ts";

interface DocumentResponse {
  data?: unknown[] | Record<string, unknown>;
}

interface QueryCommand {
  and(...expressions: QueryCommand[]): QueryCommand;
}

type QueryCondition = Record<string, unknown> | QueryCommand;

interface DatabaseCommand {
  remove(): unknown;
  and(...conditions: QueryCondition[]): QueryCommand;
  or(...conditions: QueryCondition[]): QueryCommand;
  gte(value: unknown): QueryCommand;
  lte(value: unknown): QueryCommand;
  lt(value: unknown): QueryCommand;
  exists(value: boolean): QueryCommand;
}

interface DocumentReference {
  get(): Promise<DocumentResponse>;
  set(data: object): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
  remove(): Promise<unknown>;
}

interface QueryReference {
  doc(id: string): DocumentReference;
  get(): Promise<DocumentResponse>;
  where(condition: QueryCondition): QueryReference;
  orderBy(field: string, direction: "asc" | "desc"): QueryReference;
  skip(value: number): QueryReference;
  limit(value: number): QueryReference;
}

interface TransactionReference {
  collection(name: string): QueryReference;
}

interface DatabaseReference {
  command: DatabaseCommand;
  collection(name: string): QueryReference;
  runTransaction<T>(
    work: (transaction: TransactionReference) => Promise<T>,
    retries?: number,
  ): Promise<T>;
}

const systemClock: Clock = { now: () => new Date() };

function rows<T>(response: DocumentResponse): T[] {
  const values = Array.isArray(response.data)
    ? response.data
    : response.data
      ? [response.data]
      : [];
  return values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value as T;
    }
    const document: Record<string, unknown> = { ...value };
    delete document._id;
    return document as T;
  });
}

async function getDocument<T>(document: DocumentReference): Promise<T | null> {
  return rows<T>(await document.get())[0] ?? null;
}

function indexBookingId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "bookingId" in value &&
    typeof value.bookingId === "string"
  ) {
    return value.bookingId;
  }
  return null;
}

function shanghaiTime(instant: string): string {
  return new Date(new Date(instant).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

class CloudBaseBookingTransaction implements BookingTransaction {
  private readonly transaction: TransactionReference;

  constructor(transaction: TransactionReference) {
    this.transaction = transaction;
  }

  getBooking(id: string): Promise<BookingRecord | null> {
    return getDocument(this.transaction.collection("bookings").doc(id));
  }

  async getBookingIdByCodeHash(codeHash: string): Promise<string | null> {
    return indexBookingId(
      await getDocument(this.transaction.collection("booking_codes").doc(codeHash)),
    );
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return getDocument(this.transaction.collection("sessions").doc(id));
  }

  getSessionTemplate(id: string): Promise<SessionTemplateRecord | null> {
    return getDocument(this.transaction.collection("session_templates").doc(id));
  }

  async getCourts(courtIds: readonly string[]): Promise<CourtRecord[]> {
    const courts: CourtRecord[] = [];
    for (const id of courtIds) {
      const court = await getDocument<CourtRecord>(this.transaction.collection("courts").doc(id));
      if (court) courts.push(court);
    }
    return courts;
  }

  async getIdempotency(keyHash: string): Promise<string | null> {
    return indexBookingId(
      await getDocument(this.transaction.collection("idempotency").doc(keyHash)),
    );
  }

  async getAllocations(
    sessionId: string,
    courtIds: readonly string[],
  ): Promise<CourtAllocation[]> {
    const allocations: CourtAllocation[] = [];
    for (const courtId of courtIds) {
      const allocation = await getDocument<CourtAllocation>(
        this.transaction.collection("court_allocations").doc(allocationId(sessionId, courtId)),
      );
      if (allocation) allocations.push(allocation);
    }
    return allocations;
  }

  async isBookingInventoryV2Ready(): Promise<boolean> {
    const state = await getDocument<{ status?: unknown; schemaVersion?: unknown }>(
      this.transaction
        .collection("system_state")
        .doc("booking-inventory-v2-migration"),
    );
    return state?.status === "ready" && state.schemaVersion === 2;
  }

  async getCourtDayInventories(
    date: string,
    courtIds: readonly string[],
  ): Promise<CourtDayInventory[]> {
    const inventories: CourtDayInventory[] = [];
    for (const courtId of courtIds) {
      const inventory = await getDocument<CourtDayInventory>(
        this.transaction
          .collection("court_day_allocations")
          .doc(courtDayInventoryId(date, courtId)),
      );
      if (inventory) inventories.push(inventory);
    }
    return inventories;
  }

  async putSession(value: SessionRecord): Promise<void> {
    await this.set("sessions", value.id, value);
  }

  async putAllocation(value: CourtAllocation): Promise<void> {
    await this.set("court_allocations", value.id, value);
  }

  async putCourtDayInventory(value: CourtDayInventory): Promise<void> {
    await this.set("court_day_allocations", value.id, value);
  }

  async putBooking(value: BookingRecord): Promise<void> {
    await this.set("bookings", value.id, value);
  }

  async putBookingCode(codeHash: string, bookingId: string): Promise<void> {
    await this.set("booking_codes", codeHash, { bookingId });
  }

  async putIdempotency(keyHash: string, bookingId: string): Promise<void> {
    await this.set("idempotency", keyHash, { bookingId });
  }

  async appendAudit(value: AuditLog): Promise<void> {
    await this.set("audit_logs", value.id, value);
  }

  async enqueueNotification(value: NotificationEvent): Promise<void> {
    await this.set("notification_outbox", value.id, value);
  }

  private async set(
    collection: string,
    id: string,
    value: object,
  ): Promise<void> {
    await this.transaction.collection(collection).doc(id).set(value);
  }
}

export class CloudBaseBookingRepository implements BookingRepository {
  private readonly db: DatabaseReference;
  private readonly clock: Clock;

  constructor(
    db: DatabaseReference = database as unknown as DatabaseReference,
    clock: Clock = systemClock,
  ) {
    this.db = db;
    this.clock = clock;
  }

  runTransaction<T>(work: (transaction: BookingTransaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction(
      (transaction) => work(new CloudBaseBookingTransaction(transaction)),
      3,
    );
  }

  getBookingById(bookingId: string): Promise<BookingRecord | null> {
    return getDocument(this.db.collection("bookings").doc(bookingId));
  }

  async listCustomerHistory(bookingId: string, limit: number): Promise<BookingRecord[]> {
    const selected = await this.getBookingById(bookingId);
    if (!selected) throw new BookingError("BOOKING_NOT_FOUND");
    if (!selected.phoneHash) return [];
    return this.query<BookingRecord>(
      "bookings",
      { phoneHash: selected.phoneHash },
      Math.max(1, Math.min(limit, 100)),
      [["createdAt", "desc"]],
    );
  }

  async isBookingInventoryV2Ready(): Promise<boolean> {
    const state = await getDocument<{ status?: unknown; schemaVersion?: unknown }>(
      this.db.collection("system_state").doc("booking-inventory-v2-migration"),
    );
    return state?.status === "ready" && state.schemaVersion === 2;
  }

  async listAvailability(date: string): Promise<AvailabilitySlot[]> {
    const sessions = await this.query<SessionRecord>(
      "sessions",
      { date, status: "open" },
      100,
      [["startAt", "asc"]],
    );
    const courts = await this.query<CourtRecord>("courts", { enabled: true }, 100);
    const enabledCourtIds = new Set(courts.map((court) => court.id));
    const slots = await Promise.all(
      sessions.map(async (session) => {
        const allocations = await this.query<CourtAllocation>(
          "court_allocations",
          { sessionId: session.id },
          100,
        );
        const byCourt = new Map(allocations.map((allocation) => [allocation.courtId, allocation]));
        const currentCourtIds = session.enabledCourtIds.filter((id) => enabledCourtIds.has(id));
        const currentAllocations = currentCourtIds.map((id) => byCourt.get(id));
        const privateCourtCount = currentAllocations.filter(
          (allocation) => !allocation || allocation.mode === "empty",
        ).length;
        const openCapacity = currentAllocations.reduce((total, allocation) => {
          if (!allocation || allocation.mode === "empty") return total + 4;
          return allocation.mode === "open" ? total + 4 - allocation.occupiedPlayers : total;
        }, 0);
        const acceptsOpenPartySizes = ([1, 2, 3, 4] as const).filter((partySize) =>
          currentAllocations.some(
            (allocation) =>
              !allocation ||
              allocation.mode === "empty" ||
              (allocation.mode === "open" && allocation.occupiedPlayers + partySize <= 4),
          ),
        );
        return {
          sessionId: session.id,
          date: session.date,
          startTime: shanghaiTime(session.startAt),
          endTime: shanghaiTime(session.endAt),
          openCapacity,
          acceptsOpenPartySizes,
          privateCourtCount,
          acceptsOpen: acceptsOpenPartySizes.length > 0,
          acceptsPrivate: privateCourtCount > 0,
        };
      }),
    );
    return slots;
  }

  listSessions(date: string): Promise<SessionRecord[]> {
    return this.query<SessionRecord>("sessions", { date }, 100, [["startAt", "asc"]]);
  }

  listCourtDayInventories(date: string): Promise<CourtDayInventory[]> {
    return this.query<CourtDayInventory>("court_day_allocations", { date }, 100);
  }

  async listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]> {
    const condition: Record<string, unknown> = {};
    if (filter.date) condition.date = filter.date;
    else if (filter.fromDate && filter.toDate) {
      condition.date = this.db.command.gte(filter.fromDate).and(this.db.command.lte(filter.toDate));
    } else if (filter.fromDate) {
      condition.date = this.db.command.gte(filter.fromDate);
    } else if (filter.toDate) {
      condition.date = this.db.command.lte(filter.toDate);
    }
    if (filter.status) condition.status = filter.status;
    if (filter.mode) condition.mode = filter.mode;
    const normalizedQuery = filter.query?.trim().toLowerCase();
    const archive = filter.archive ?? "active";
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    const results: BookingRecord[] = [];
    let cursor = filter.cursor ? decodeBookingCursor(filter.cursor) : undefined;

    // Export/list compatibility is deliberately capped at five SDK pages. CSV asks
    // for 500 rows so the API can reject that detectable hard cap instead of
    // silently returning a truncated file.
    for (let request = 0; request < 5 && results.length < limit; request += 1) {
      let query = this.db.collection("bookings");
      const where = this.withBookingCursor(condition, cursor);
      if (where) query = query.where(where);
      for (const [field, direction] of [["date", "desc"], ["createdAt", "desc"], ["id", "desc"]] as const) {
        query = query.orderBy(field, direction);
      }
      const candidates = rows<BookingRecord>(await query.limit(Math.min(100, limit)).get());
      for (const booking of candidates) {
        cursor = booking;
        const archiveMatches = archive === "all" ||
          (archive === "archived" ? Boolean(booking.archivedAt) : !booking.archivedAt);
        const queryMatches = !normalizedQuery ||
          [booking.id, booking.code, booking.name, booking.phone, booking.email]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLowerCase().includes(normalizedQuery));
        if (archiveMatches && queryMatches) results.push(booking);
        if (results.length >= limit) break;
      }
      if (candidates.length < Math.min(100, limit)) break;
    }
    return results.slice(0, limit);
  }

  listPendingBookings(date: string): Promise<BookingRecord[]> {
    return this.queryAll<BookingRecord>(
      "bookings",
      { date, status: "pending" },
      [["createdAt", "asc"], ["id", "asc"]],
    );
  }

  async listMatrixBookings(date: string): Promise<BookingRecord[]> {
    const [current, proposed] = await Promise.all([
      this.queryAll<BookingRecord>(
        "bookings",
        { date },
        [["createdAt", "asc"], ["id", "asc"]],
      ),
      this.queryAll<BookingRecord>(
        "bookings",
        { proposedDate: date, status: "reschedule_proposed" },
        [["createdAt", "asc"], ["id", "asc"]],
      ),
    ]);
    const active = [...current, ...proposed].filter(
      (booking) => booking.status !== "cancelled" && booking.status !== "completed",
    );
    const byId = new Map(active.map((booking) => [booking.id, booking]));
    return Array.from(byId.values()).sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }

  listCourts(): Promise<CourtRecord[]> {
    return this.query<CourtRecord>("courts", {}, 100, [["id", "asc"]]);
  }

  listSessionTemplates(): Promise<SessionTemplateRecord[]> {
    return this.query<SessionTemplateRecord>("session_templates", {}, 100, [
      ["startTime", "asc"],
      ["id", "asc"],
    ]);
  }

  listAuditLogs(bookingId: string): Promise<AuditLog[]> {
    return this.queryAll<AuditLog>("audit_logs", { bookingId }, [
      ["at", "asc"],
      ["id", "asc"],
    ]);
  }

  async listExpiredPersonalData(cutoff: string, limit: number): Promise<BookingRecord[]> {
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (boundedLimit === 0) return [];
    const [cancelled, completed] = await Promise.all(
      (["cancelled", "completed"] as const).map((status) =>
        this.queryExpiredStatus(status, cutoff, boundedLimit),
      ),
    );
    return [...cancelled, ...completed]
      .sort(
        (left, right) =>
          (left.terminalAt ?? "").localeCompare(right.terminalAt ?? "") ||
          left.id.localeCompare(right.id),
      )
      .slice(0, boundedLimit);
  }

  redactBooking(
    bookingId: string,
    actorId: string,
    expectedVersion: number,
    actorType: "staff" | "system" = "system",
  ): Promise<void> {
    return this.db.runTransaction(async (transaction) => {
      const bookings = transaction.collection("bookings");
      const booking = await getDocument<BookingRecord>(bookings.doc(bookingId));
      if (!booking) throw new BookingError("BOOKING_NOT_FOUND");
      if (booking.version !== expectedVersion) throw new BookingError("CONFLICT");
      const now = this.clock.now().toISOString();
      await transaction.collection("booking_codes").doc(bookingCodeId(booking.code)).remove();
      if (booking.idempotencyKeyHash) {
        await transaction.collection("idempotency").doc(booking.idempotencyKeyHash).remove();
      }
      const remove = this.db.command.remove();
      await bookings.doc(bookingId).update({
        name: remove,
        phone: remove,
        phoneHash: remove,
        email: remove,
        note: remove,
        idempotencyKeyHash: remove,
        personalDataRedactedAt: now,
        updatedAt: now,
        version: booking.version + 1,
      });
      const audit: AuditLog = {
        id: `redact-${bookingId}-${booking.version + 1}`,
        bookingId,
        action: "personal_data_redacted",
        actorType,
        actorId,
        at: now,
        metadata: {},
      };
      await transaction.collection("audit_logs").doc(audit.id).set(audit);
    }, 3);
  }

  async listBookingPage(filter: AdminBookingFilter): Promise<BookingPage> {
    const condition: Record<string, unknown> = {};
    if (filter.date) condition.date = filter.date;
    else if (filter.fromDate && filter.toDate) {
      condition.date = this.db.command.gte(filter.fromDate).and(this.db.command.lte(filter.toDate));
    } else if (filter.fromDate) condition.date = this.db.command.gte(filter.fromDate);
    else if (filter.toDate) condition.date = this.db.command.lte(filter.toDate);
    if (filter.status) condition.status = filter.status;
    if (filter.mode) condition.mode = filter.mode;

    const normalizedQuery = filter.query?.trim().toLowerCase();
    const archive = filter.archive ?? "active";
    if ((normalizedQuery || archive !== "active") && !filter.date && !(filter.fromDate && filter.toDate)) {
      throw new BookingError("INVALID_INPUT");
    }
    const requested = Math.max(1, Math.min(filter.limit ?? 50, 100));
    const cursor = filter.cursor ? decodeBookingCursor(filter.cursor) : undefined;
    let scanned = 0;
    let queryCount = 0;
    const items: BookingRecord[] = [];
    let lastScanned: BookingRecord | undefined;
    let mayHaveMore = false;
    let scanCursor = cursor;

    // CloudBase pages are at most 100 rows. Bound post-filter scans to three pages so
    // a keyword/recycle-bin request cannot load the complete history or exhaust the
    // free-tier three-second function budget. The opaque keyset cursor resumes from
    // the last stable (date, createdAt, id) tuple rather than a mutation-sensitive offset.
    while (items.length < requested && scanned < 300 && queryCount < 3) {
      let query = this.db.collection("bookings");
      const where = this.withBookingCursor(condition, scanCursor);
      if (where) query = query.where(where);
      for (const [field, direction] of [["date", "desc"], ["createdAt", "desc"], ["id", "desc"]] as const) {
        query = query.orderBy(field, direction);
      }
      const raw = rows<BookingRecord>(await query.limit(100).get());
      queryCount += 1;
      if (raw.length === 0) {
        mayHaveMore = false;
        break;
      }
      let consumed = 0;
      for (const booking of raw) {
        consumed += 1;
        scanned += 1;
        lastScanned = booking;
        const archiveMatches = archive === "all" ||
          (archive === "archived" ? Boolean(booking.archivedAt) : !booking.archivedAt);
        const queryMatches = !normalizedQuery ||
          [booking.id, booking.code, booking.name, booking.phone, booking.email]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLowerCase().includes(normalizedQuery));
        if (archiveMatches && queryMatches) items.push(booking);
        if (items.length >= requested || scanned >= 300) break;
      }
      mayHaveMore = consumed < raw.length || raw.length === 100;
      if (items.length >= requested || scanned >= 300 || raw.length < 100) break;
      scanCursor = lastScanned;
    }
    return {
      items,
      ...(mayHaveMore && lastScanned
        ? { nextCursor: encodeBookingCursor(lastScanned) }
        : {}),
    };
  }

  private withBookingCursor(
    condition: Record<string, unknown>,
    cursor?: Pick<BookingRecord, "date" | "createdAt" | "id">,
  ): QueryCondition | undefined {
    if (!cursor) return Object.keys(condition).length > 0 ? condition : undefined;
    const after = this.db.command.or(
      { date: this.db.command.lt(cursor.date) },
      { date: cursor.date, createdAt: this.db.command.lt(cursor.createdAt) },
      { date: cursor.date, createdAt: cursor.createdAt, id: this.db.command.lt(cursor.id) },
    );
    return Object.keys(condition).length > 0
      ? this.db.command.and(condition, after)
      : after;
  }

  setBookingArchived(
    bookingId: string,
    archived: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<BookingRecord> {
    return this.db.runTransaction(async (transaction) => {
      const document = transaction.collection("bookings").doc(bookingId);
      const booking = await getDocument<BookingRecord>(document);
      if (!booking) throw new BookingError("BOOKING_NOT_FOUND");
      if (booking.version !== expectedVersion) throw new BookingError("CONFLICT");
      if (booking.status !== "cancelled" && booking.status !== "completed") {
        throw new BookingError("INVALID_TRANSITION");
      }
      if (archived === Boolean(booking.archivedAt)) throw new BookingError("CONFLICT");
      const at = this.clock.now().toISOString();
      const version = booking.version + 1;
      const remove = this.db.command.remove();
      await document.update(
        archived
          ? { archivedAt: at, archivedBy: actorId, updatedAt: at, version }
          : { archivedAt: remove, archivedBy: remove, updatedAt: at, version },
      );
      const action = archived ? "booking_archived" : "booking_restored";
      const audit: AuditLog = {
        id: `${action}-${bookingId}-${version}`,
        bookingId,
        action,
        actorType: "staff",
        actorId,
        fromStatus: booking.status,
        toStatus: booking.status,
        at,
        metadata: {},
      };
      await transaction.collection("audit_logs").doc(audit.id).set(audit);
      const updated: BookingRecord = {
        ...booking,
        ...(archived ? { archivedAt: at, archivedBy: actorId } : {}),
        updatedAt: at,
        version,
      };
      if (!archived) {
        delete updated.archivedAt;
        delete updated.archivedBy;
      }
      return updated;
    }, 3);
  }

  setCourtEnabled(
    courtId: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void> {
    return this.updateEnabled(
      "courts",
      "court",
      "court_enabled_changed",
      courtId,
      enabled,
      actorId,
      expectedVersion,
    );
  }

  setSessionTemplateEnabled(
    templateId: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void> {
    return this.updateEnabled(
      "session_templates",
      "session-template",
      "session_template_enabled_changed",
      templateId,
      enabled,
      actorId,
      expectedVersion,
    );
  }

  private updateEnabled(
    collectionName: "courts" | "session_templates",
    entity: "court" | "session-template",
    action: "court_enabled_changed" | "session_template_enabled_changed",
    id: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void> {
    return this.db.runTransaction(async (transaction) => {
      const document = transaction.collection(collectionName).doc(id);
      const record = await getDocument<{ version: number }>(document);
      if (!record) throw new BookingError("SESSION_NOT_FOUND");
      if (record.version !== expectedVersion) throw new BookingError("CONFLICT");
      const version = record.version + 1;
      const at = this.clock.now().toISOString();
      const audit: AuditLog = {
        id: `config-${entity}-${encodeURIComponent(id)}-v${version}`,
        bookingId: `${entity}:${id}`,
        action,
        actorType: "staff",
        actorId,
        at,
        metadata: { entity, id, enabled, version },
      };
      await document.update({ enabled, version });
      await transaction.collection("audit_logs").doc(audit.id).set(audit);
    }, 3);
  }

  private async query<T>(
    collectionName: string,
    condition: Record<string, unknown>,
    limit: number,
    orders: Array<[string, "asc" | "desc"]> = [],
  ): Promise<T[]> {
    let query = this.db.collection(collectionName);
    if (Object.keys(condition).length > 0) query = query.where(condition);
    for (const order of orders) query = query.orderBy(order[0], order[1]);
    return rows<T>(await query.limit(limit).get());
  }

  private async queryAll<T>(
    collectionName: string,
    condition: Record<string, unknown>,
    orders: Array<[string, "asc" | "desc"]>,
  ): Promise<T[]> {
    const pageSize = 100;
    const values: T[] = [];
    for (let offset = 0; ; offset += pageSize) {
      let query = this.db.collection(collectionName);
      if (Object.keys(condition).length > 0) query = query.where(condition);
      for (const order of orders) query = query.orderBy(order[0], order[1]);
      const page = rows<T>(await query.skip(offset).limit(pageSize).get());
      values.push(...page);
      if (page.length < pageSize) return values;
    }
  }

  private async queryExpiredStatus(
    status: "cancelled" | "completed",
    cutoff: string,
    limit: number,
  ): Promise<BookingRecord[]> {
    const pageSize = 100;
    const values: BookingRecord[] = [];
    let offset = 0;
    while (values.length < limit) {
      const requested = Math.min(pageSize, limit - values.length);
      const page = rows<BookingRecord>(
        await this.db
          .collection("bookings")
          .where({
            status,
            terminalAt: this.db.command.lt(cutoff),
            personalDataRedactedAt: this.db.command.exists(false),
          })
          .orderBy("terminalAt", "asc")
          .orderBy("id", "asc")
          .skip(offset)
          .limit(requested)
          .get(),
      );
      values.push(...page);
      offset += page.length;
      if (page.length < requested) break;
    }
    return values;
  }
}
