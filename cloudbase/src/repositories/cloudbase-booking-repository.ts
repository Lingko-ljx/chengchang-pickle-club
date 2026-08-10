import { allocationId, bookingCodeId } from "../../../lib/booking/booking-service.ts";
import { BookingError } from "../../../lib/booking/errors.ts";
import type { BookingRepository, BookingTransaction, Clock } from "../../../lib/booking/ports.ts";
import type {
  AdminBookingFilter,
  AuditLog,
  AvailabilitySlot,
  BookingRecord,
  CourtAllocation,
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

interface DatabaseCommand {
  remove(): unknown;
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
  where(condition: Record<string, unknown>): QueryReference;
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
  if (Array.isArray(response.data)) return response.data as T[];
  return response.data ? [response.data as T] : [];
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
    const courts = await Promise.all(
      courtIds.map((id) => getDocument<CourtRecord>(this.transaction.collection("courts").doc(id))),
    );
    return courts.filter((court): court is CourtRecord => court !== null);
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
    const allocations = await Promise.all(
      courtIds.map((courtId) =>
        getDocument<CourtAllocation>(
          this.transaction.collection("court_allocations").doc(allocationId(sessionId, courtId)),
        ),
      ),
    );
    return allocations.filter((allocation): allocation is CourtAllocation => allocation !== null);
  }

  async putSession(value: SessionRecord): Promise<void> {
    await this.set("sessions", value.id, value);
  }

  async putAllocation(value: CourtAllocation): Promise<void> {
    await this.set("court_allocations", value.id, value);
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
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    const queryLimit = normalizedQuery || filter.cursor ? 500 : limit;
    return (await this.query<BookingRecord>("bookings", condition, queryLimit, [
      ["date", "asc"],
      ["createdAt", "asc"],
    ]))
      .filter((booking) => !filter.cursor || booking.id > filter.cursor)
      .filter(
        (booking) =>
          !normalizedQuery ||
          [booking.id, booking.code, booking.name, booking.phone, booking.email]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLowerCase().includes(normalizedQuery)),
      )
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit);
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
