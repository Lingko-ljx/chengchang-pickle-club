import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chooseCourt } from "./allocation.ts";
import { BookingError } from "./errors.ts";
import type { BookingRepository, BookingTransaction, Clock, IdProvider } from "./ports.ts";
import { assertTransition } from "./state-machine.ts";
import type {
  AdminBookingFilter,
  AuditLog,
  AvailabilitySlot,
  BookingRecord,
  BookingStatus,
  CourtAllocation,
  CourtRecord,
  NotificationEvent,
  SessionRecord,
} from "./types.ts";
import { validateCreateBooking } from "./validation.ts";

export const courtIds = Array.from({ length: 11 }, (_, index) =>
  String(index + 1).padStart(2, "0"),
);

export function allocationId(sessionId: string, courtId: string): string {
  return `${sessionId}__court-${courtId}`;
}

export function bookingCodeId(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function hash(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex");
}

function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\D/g, "");
  return normalized.length > 0 ? normalized : null;
}

function encodeBookingCode(bytes: Uint8Array): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let bits = 0;
  let bitCount = 0;
  let output = "";
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      output += alphabet[(bits >>> bitCount) & 31];
      bits &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0) output += alphabet[(bits << (5 - bitCount)) & 31];
  return output;
}

const systemClock: Clock = { now: () => new Date() };
const secureIds: IdProvider = {
  bookingId: () => randomUUID(),
  bookingCode: () => encodeBookingCode(randomBytes(20)),
  eventId: () => randomUUID(),
};

interface VersionedCommand {
  bookingId: string;
  expectedVersion: number;
}

export interface StaffMutationCommand extends VersionedCommand {
  actorId: string;
}

export interface ProposeRescheduleCommand extends StaffMutationCommand {
  sessionId: string;
}

export interface RespondToRescheduleCommand extends VersionedCommand {
  accept: boolean;
  actorType: "customer" | "staff";
  actorId?: string;
}

export interface CancelBookingCommand extends VersionedCommand {
  actorType: "customer" | "staff";
  actorId?: string;
}

export interface ReassignBookingCommand extends StaffMutationCommand {
  courtId: string;
}

interface PreparedSession {
  session: SessionRecord;
  currentCourts: CourtRecord[];
  allocations: CourtAllocation[];
  isNew: boolean;
}

function parseSessionId(sessionId: string): { date: string; templateId: string } {
  const match = /^(\d{4}-\d{2}-\d{2})__(.+)$/.exec(sessionId);
  if (!match || Number.isNaN(Date.parse(`${match[1]}T00:00:00.000Z`))) {
    throw new BookingError("INVALID_INPUT");
  }
  return { date: match[1], templateId: match[2] };
}

function shanghaiInstant(date: string, time: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BookingError("INVALID_INPUT");
  const instant = new Date(`${date}T${time}:00+08:00`);
  if (Number.isNaN(instant.getTime())) throw new BookingError("INVALID_INPUT");
  return instant.toISOString();
}

function emptyAllocation(sessionId: string, courtId: string): CourtAllocation {
  return {
    id: allocationId(sessionId, courtId),
    sessionId,
    courtId,
    mode: "empty",
    occupiedPlayers: 0,
    bookingIds: [],
    version: 0,
  };
}

function reserveAllocation(allocation: CourtAllocation, booking: BookingRecord): CourtAllocation {
  return {
    ...allocation,
    mode: booking.mode,
    occupiedPlayers: allocation.occupiedPlayers + booking.partySize,
    bookingIds: [...allocation.bookingIds, booking.id],
    version: allocation.version + 1,
  };
}

function releaseAllocation(allocation: CourtAllocation, booking: BookingRecord): CourtAllocation {
  const bookingIds = allocation.bookingIds.filter((id) => id !== booking.id);
  const occupiedPlayers = Math.max(0, allocation.occupiedPlayers - booking.partySize);
  return {
    ...allocation,
    mode: bookingIds.length === 0 ? "empty" : allocation.mode,
    occupiedPlayers: bookingIds.length === 0 ? 0 : occupiedPlayers,
    bookingIds,
    version: allocation.version + 1,
  };
}

function requireBooking(booking: BookingRecord | null): BookingRecord {
  if (!booking) throw new BookingError("BOOKING_NOT_FOUND");
  return booking;
}

function requireVersion(booking: BookingRecord, expectedVersion: number): void {
  if (booking.version !== expectedVersion) throw new BookingError("CONFLICT");
}

function clearProposal(booking: BookingRecord): BookingRecord {
  const updated = { ...booking };
  delete updated.proposedSessionId;
  delete updated.proposedCourtId;
  delete updated.proposedStartAt;
  delete updated.proposedEndAt;
  delete updated.proposalPreviousStatus;
  return updated;
}

export class BookingService {
  private readonly repository: BookingRepository;
  private readonly clock: Clock;
  private readonly ids: IdProvider;

  constructor(
    repository: BookingRepository,
    clock: Clock = systemClock,
    ids: IdProvider = secureIds,
  ) {
    this.repository = repository;
    this.clock = clock;
    this.ids = ids;
  }

  async create(input: unknown): Promise<BookingRecord> {
    const command = validateCreateBooking(input);
    const phone = normalizePhone(command.phone);
    if (!phone) throw new BookingError("INVALID_INPUT");
    const parsed = parseSessionId(command.sessionId);
    const now = this.clock.now().toISOString();
    const bookingId = this.ids.bookingId();
    const code = this.ids.bookingCode().trim().toUpperCase();
    const codeHash = bookingCodeId(code);
    const idempotencyKeyHash = hash(command.idempotencyKey);
    const auditId = this.ids.eventId();
    const notificationId = this.ids.eventId();

    return this.repository.runTransaction(async (transaction) => {
      const previousId = await transaction.getIdempotency(idempotencyKeyHash);
      if (previousId) return requireBooking(await transaction.getBooking(previousId));
      if (await transaction.getBookingIdByCodeHash(codeHash)) throw new BookingError("CONFLICT");

      const prepared = await this.prepareSession(transaction, command.sessionId, now);
      const enabled = new Set(
        prepared.currentCourts
          .filter((court) => court.enabled && prepared.session.enabledCourtIds.includes(court.id))
          .map((court) => court.id),
      );
      const eligibleAllocations = prepared.allocations.filter((item) => enabled.has(item.courtId));
      const selected = chooseCourt(command.mode, command.partySize, eligibleAllocations);
      if (!selected) throw new BookingError("SESSION_FULL");

      const booking: BookingRecord = {
        id: bookingId,
        code,
        idempotencyKeyHash,
        sessionId: command.sessionId,
        date: parsed.date,
        startAt: prepared.session.startAt,
        endAt: prepared.session.endAt,
        courtId: selected.courtId,
        mode: command.mode,
        partySize: command.partySize,
        status: "pending",
        name: command.name.trim(),
        phone,
        phoneHash: hash(phone),
        ...(command.email === undefined ? {} : { email: command.email.trim() }),
        ...(command.note === undefined ? {} : { note: command.note.trim() }),
        privacyConsentAt: now,
        canCancelUntil: prepared.session.startAt,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      if (prepared.isNew) await transaction.putSession(prepared.session);
      await transaction.putAllocation(reserveAllocation(selected, booking));
      await transaction.putBooking(booking);
      await transaction.putBookingCode(codeHash, booking.id);
      await transaction.putIdempotency(idempotencyKeyHash, booking.id);
      await transaction.appendAudit(
        this.audit(auditId, booking, "created", "system", now, undefined, "pending"),
      );
      await transaction.enqueueNotification(this.notification(notificationId, booking.id, "created", now));
      return booking;
    });
  }

  async lookup(code: string, phone: string): Promise<BookingRecord | null> {
    const normalizedPhone = normalizePhone(phone);
    if (typeof code !== "string" || code.trim() === "" || !normalizedPhone) return null;
    const requestedPhoneHash = hash(normalizedPhone);
    return this.repository.runTransaction(async (transaction) => {
      const id = await transaction.getBookingIdByCodeHash(bookingCodeId(code));
      if (!id) return null;
      const booking = await transaction.getBooking(id);
      return booking?.phoneHash === requestedPhoneHash ? booking : null;
    });
  }

  confirm(command: StaffMutationCommand): Promise<BookingRecord> {
    return this.changeStatus(command, "confirmed", "confirmed");
  }

  async proposeReschedule(command: ProposeRescheduleCommand): Promise<BookingRecord> {
    parseSessionId(command.sessionId);
    const now = this.clock.now().toISOString();
    const auditId = this.ids.eventId();
    const notificationId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      assertTransition(booking.status, "reschedule_proposed");
      if (command.sessionId === booking.sessionId) throw new BookingError("INVALID_INPUT");
      const prepared = await this.prepareSession(transaction, command.sessionId, now);
      const enabled = new Set(
        prepared.currentCourts
          .filter((court) => court.enabled && prepared.session.enabledCourtIds.includes(court.id))
          .map((court) => court.id),
      );
      const selected = chooseCourt(
        booking.mode,
        booking.partySize,
        prepared.allocations.filter((item) => enabled.has(item.courtId)),
      );
      if (!selected) throw new BookingError("SESSION_FULL");
      const updated: BookingRecord = {
        ...booking,
        status: "reschedule_proposed",
        proposalPreviousStatus: booking.status as "pending" | "confirmed",
        proposedSessionId: prepared.session.id,
        proposedCourtId: selected.courtId,
        proposedStartAt: prepared.session.startAt,
        proposedEndAt: prepared.session.endAt,
        updatedAt: now,
        version: booking.version + 1,
      };
      if (prepared.isNew) await transaction.putSession(prepared.session);
      await transaction.putAllocation(reserveAllocation(selected, booking));
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(auditId, booking, "reschedule_proposed", "staff", now, booking.status, updated.status, command.actorId),
      );
      await transaction.enqueueNotification(
        this.notification(notificationId, booking.id, "reschedule_proposed", now),
      );
      return updated;
    });
  }

  async respondToReschedule(command: RespondToRescheduleCommand): Promise<BookingRecord> {
    const now = this.clock.now().toISOString();
    const auditId = this.ids.eventId();
    const notificationId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      if (
        booking.status !== "reschedule_proposed" ||
        !booking.proposalPreviousStatus ||
        !booking.proposedSessionId ||
        !booking.proposedCourtId ||
        !booking.proposedStartAt ||
        !booking.proposedEndAt
      ) {
        throw new BookingError("INVALID_TRANSITION");
      }
      const oldAllocation = await this.readAllocation(transaction, booking.sessionId, booking.courtId);
      const proposedAllocation = await this.readAllocation(
        transaction,
        booking.proposedSessionId,
        booking.proposedCourtId,
      );
      let updated: BookingRecord;
      if (command.accept) {
        assertTransition(booking.status, "confirmed");
        updated = clearProposal({
          ...booking,
          sessionId: booking.proposedSessionId,
          date: parseSessionId(booking.proposedSessionId).date,
          courtId: booking.proposedCourtId,
          startAt: booking.proposedStartAt,
          endAt: booking.proposedEndAt,
          canCancelUntil: booking.proposedStartAt,
          status: "confirmed",
          updatedAt: now,
          version: booking.version + 1,
        });
        await transaction.putAllocation(releaseAllocation(oldAllocation, booking));
      } else {
        assertTransition(booking.status, booking.proposalPreviousStatus);
        updated = clearProposal({
          ...booking,
          status: booking.proposalPreviousStatus,
          updatedAt: now,
          version: booking.version + 1,
        });
        await transaction.putAllocation(releaseAllocation(proposedAllocation, booking));
      }
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(
          auditId,
          booking,
          command.accept ? "reschedule_accepted" : "reschedule_rejected",
          command.actorType,
          now,
          booking.status,
          updated.status,
          command.actorId,
        ),
      );
      await transaction.enqueueNotification(
        this.notification(notificationId, booking.id, command.accept ? "reschedule_accepted" : "reschedule_rejected", now),
      );
      return updated;
    });
  }

  async cancel(command: CancelBookingCommand): Promise<BookingRecord> {
    const now = this.clock.now().toISOString();
    const auditId = this.ids.eventId();
    const notificationId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      if (command.actorType === "customer" && now >= booking.startAt) {
        throw new BookingError("SESSION_CLOSED");
      }
      assertTransition(booking.status, "cancelled");
      const allocation = await this.readAllocation(transaction, booking.sessionId, booking.courtId);
      await transaction.putAllocation(releaseAllocation(allocation, booking));
      if (booking.proposedSessionId && booking.proposedCourtId) {
        const proposed = await this.readAllocation(
          transaction,
          booking.proposedSessionId,
          booking.proposedCourtId,
        );
        await transaction.putAllocation(releaseAllocation(proposed, booking));
      }
      const updated = clearProposal({
        ...booking,
        status: "cancelled",
        terminalAt: booking.terminalAt ?? now,
        updatedAt: now,
        version: booking.version + 1,
      });
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(auditId, booking, "cancelled", command.actorType, now, booking.status, "cancelled", command.actorId),
      );
      await transaction.enqueueNotification(this.notification(notificationId, booking.id, "cancelled", now));
      return updated;
    });
  }

  async complete(command: StaffMutationCommand): Promise<BookingRecord> {
    const now = this.clock.now().toISOString();
    const auditId = this.ids.eventId();
    const notificationId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      assertTransition(booking.status, "completed");
      const allocation = await this.readAllocation(transaction, booking.sessionId, booking.courtId);
      const updated: BookingRecord = {
        ...booking,
        status: "completed",
        terminalAt: booking.terminalAt ?? now,
        updatedAt: now,
        version: booking.version + 1,
      };
      await transaction.putAllocation(releaseAllocation(allocation, booking));
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(auditId, booking, "completed", "staff", now, booking.status, "completed", command.actorId),
      );
      await transaction.enqueueNotification(this.notification(notificationId, booking.id, "completed", now));
      return updated;
    });
  }

  async reassign(command: ReassignBookingCommand): Promise<BookingRecord> {
    if (!courtIds.includes(command.courtId)) throw new BookingError("INVALID_INPUT");
    const now = this.clock.now().toISOString();
    const auditId = this.ids.eventId();
    const notificationId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      if (booking.status === "cancelled" || booking.status === "completed") {
        throw new BookingError("INVALID_TRANSITION");
      }
      if (booking.status === "reschedule_proposed") throw new BookingError("INVALID_TRANSITION");
      const session = await transaction.getSession(booking.sessionId);
      const courts = await transaction.getCourts([command.courtId]);
      if (!session || !session.enabledCourtIds.includes(command.courtId) || !courts[0]?.enabled) {
        throw new BookingError("SESSION_CLOSED");
      }
      if (command.courtId === booking.courtId) return booking;
      const oldAllocation = await this.readAllocation(transaction, booking.sessionId, booking.courtId);
      const target = await this.readAllocation(transaction, booking.sessionId, command.courtId);
      if (!chooseCourt(booking.mode, booking.partySize, [target])) throw new BookingError("SESSION_FULL");
      const updated = {
        ...booking,
        courtId: command.courtId,
        updatedAt: now,
        version: booking.version + 1,
      };
      await transaction.putAllocation(releaseAllocation(oldAllocation, booking));
      await transaction.putAllocation(reserveAllocation(target, booking));
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(auditId, booking, "reassigned", "staff", now, booking.status, booking.status, command.actorId),
      );
      await transaction.enqueueNotification(this.notification(notificationId, booking.id, "reassigned", now));
      return updated;
    });
  }

  redactPersonalData(
    bookingId: string,
    actorId: string,
    expectedVersion: number,
    actorType: "staff" | "system" = "system",
  ): Promise<void> {
    return this.repository.redactBooking(bookingId, actorId, expectedVersion, actorType);
  }

  listAvailability(date: string): Promise<AvailabilitySlot[]> {
    return this.repository.listAvailability(date);
  }

  listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]> {
    return this.repository.listBookings(filter);
  }

  setCourtEnabled(
    courtId: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void> {
    return this.repository.setCourtEnabled(courtId, enabled, actorId, expectedVersion);
  }

  setSessionTemplateEnabled(
    templateId: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void> {
    return this.repository.setSessionTemplateEnabled(
      templateId,
      enabled,
      actorId,
      expectedVersion,
    );
  }

  private async changeStatus(
    command: StaffMutationCommand,
    status: BookingStatus,
    action: string,
  ): Promise<BookingRecord> {
    const now = this.clock.now().toISOString();
    const auditId = this.ids.eventId();
    const notificationId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      assertTransition(booking.status, status);
      const updated = { ...booking, status, updatedAt: now, version: booking.version + 1 };
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(auditId, booking, action, "staff", now, booking.status, status, command.actorId),
      );
      await transaction.enqueueNotification(this.notification(notificationId, booking.id, action, now));
      return updated;
    });
  }

  private async prepareSession(
    transaction: BookingTransaction,
    sessionId: string,
    now: string,
  ): Promise<PreparedSession> {
    const parsed = parseSessionId(sessionId);
    let session = await transaction.getSession(sessionId);
    const currentCourts = await transaction.getCourts(courtIds);
    let isNew = false;
    if (!session) {
      const template = await transaction.getSessionTemplate(parsed.templateId);
      if (!template) throw new BookingError("SESSION_NOT_FOUND");
      if (!template.enabled) throw new BookingError("SESSION_CLOSED");
      const startAt = shanghaiInstant(parsed.date, template.startTime);
      const endAt = shanghaiInstant(parsed.date, template.endTime);
      if (Date.parse(endAt) - Date.parse(startAt) !== 60 * 60 * 1000) {
        throw new BookingError("SESSION_CLOSED");
      }
      session = {
        id: sessionId,
        date: parsed.date,
        templateId: parsed.templateId,
        startAt,
        endAt,
        status: "open",
        enabledCourtIds: currentCourts.filter((court) => court.enabled).map((court) => court.id),
        version: 1,
      };
      isNew = true;
    }
    if (session.status !== "open" || session.startAt <= now) throw new BookingError("SESSION_CLOSED");
    const storedAllocations = await transaction.getAllocations(sessionId, courtIds);
    const byCourt = new Map(storedAllocations.map((item) => [item.courtId, item]));
    return {
      session,
      currentCourts,
      allocations: courtIds.map((courtId) => byCourt.get(courtId) ?? emptyAllocation(sessionId, courtId)),
      isNew,
    };
  }

  private async readAllocation(
    transaction: BookingTransaction,
    sessionId: string,
    courtId: string,
  ): Promise<CourtAllocation> {
    return (await transaction.getAllocations(sessionId, [courtId]))[0] ?? emptyAllocation(sessionId, courtId);
  }

  private audit(
    id: string,
    booking: BookingRecord,
    action: string,
    actorType: AuditLog["actorType"],
    at: string,
    fromStatus?: BookingStatus,
    toStatus?: BookingStatus,
    actorId?: string,
  ): AuditLog {
    return {
      id,
      bookingId: booking.id,
      action,
      actorType,
      ...(actorId ? { actorId } : {}),
      ...(fromStatus ? { fromStatus } : {}),
      ...(toStatus ? { toStatus } : {}),
      at,
      metadata: {},
    };
  }

  private notification(id: string, bookingId: string, kind: string, now: string): NotificationEvent {
    return {
      id,
      bookingId,
      kind,
      recipientType: "customer",
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
    };
  }
}
