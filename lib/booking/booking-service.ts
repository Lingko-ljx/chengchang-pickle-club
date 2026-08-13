import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chooseCourt,
  chooseCourtDayInventory,
  releaseCourtDayInventory,
  reserveCourtDayInventory,
} from "./allocation.ts";
import {
  bookingWindowSessionId,
  clockMinutes,
  courtDayInventoryId,
  defaultBookingPolicy,
  inventoryCellKeys,
  listBookingWindows,
  parseBookingWindowSessionId,
  validateCourtTimeBlockWindow,
  validateBookingWindow,
  type ValidatedBookingWindow,
} from "./booking-window.ts";
import { requireCalendarDate } from "./calendar-date.ts";
import { BookingError } from "./errors.ts";
import type {
  BookingRepository,
  BookingTransaction,
  Clock,
  IdProvider,
  PhoneHasher,
} from "./ports.ts";
import { assertTransition } from "./state-machine.ts";
import type {
  AdminBookingFilter,
  AuditLog,
  AvailabilitySlot,
  BookingWindowAvailability,
  BookingWindowAvailabilityResult,
  BookingRecord,
  BookingPage,
  BookingStatus,
  CourtAllocation,
  CourtDayInventory,
  CourtRecord,
  CourtTimeBlock,
  CourtTimeBlockDay,
  CreateCourtTimeBlocksCommand,
  NotificationEvent,
  NotificationKind,
  SessionRecord,
  SessionTemplateRecord,
  RestoreCourtTimeBlockCommand,
  UpdateCourtTimeBlockCommand,
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

function hasNotificationEmail(booking: Pick<BookingRecord, "email">): boolean {
  return typeof booking.email === "string" && booking.email.trim() !== "";
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
const bookingCodeCandidateCount = 5;
const secureIds: IdProvider = {
  bookingId: () => randomUUID(),
  bookingCode: () => encodeBookingCode(randomBytes(5)),
  eventId: () => randomUUID(),
};
const unavailablePhoneHasher: PhoneHasher = {
  hash: () => {
    throw new Error("PHONE_HASHER_NOT_CONFIGURED");
  },
};

interface VersionedCommand {
  bookingId: string;
  expectedVersion: number;
}

export interface StaffMutationCommand extends VersionedCommand {
  actorId: string;
}

export interface ProposeRescheduleCommand extends StaffMutationCommand {
  sessionId?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
}

export function encodeBookingCursor(
  value: Pick<BookingRecord, "date" | "createdAt" | "id">,
): string {
  return Buffer.from(JSON.stringify([value.date, value.createdAt, value.id]), "utf8").toString("base64url");
}

export function decodeBookingCursor(value: string): { date: string; createdAt: string; id: string } {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(decoded) || decoded.length !== 3 ||
      decoded.slice(0, 3).some((part) => typeof part !== "string" || !part) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(decoded[0] as string) ||
      Number.isNaN(Date.parse(decoded[1] as string))
    ) throw new Error("invalid cursor");
    return {
      date: decoded[0] as string,
      createdAt: decoded[1] as string,
      id: decoded[2] as string,
    };
  } catch {
    throw new BookingError("INVALID_INPUT");
  }
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

export interface CreateStaffReservationCommand {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  courtId: string;
  actorId: string;
}

export interface UpdateStaffReservationCommand extends CreateStaffReservationCommand {
  bookingId: string;
  expectedVersion: number;
}

interface PreparedSession {
  session: SessionRecord;
  currentCourts: CourtRecord[];
  allocations: CourtAllocation[];
  isNew: boolean;
}

function parseSessionId(sessionId: string): { date: string; templateId: string } {
  const match = /^(\d{4}-\d{2}-\d{2})__(.+)$/.exec(sessionId);
  if (!match) throw new BookingError("INVALID_INPUT");
  return { date: requireCalendarDate(match[1]), templateId: match[2] };
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

function emptyCourtDayInventory(date: string, courtId: string): CourtDayInventory {
  return {
    id: courtDayInventoryId(date, courtId),
    date,
    courtId,
    cells: {},
    version: 0,
  };
}

function shanghaiLocalTime(instant: string): string {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) throw new BookingError("INVALID_INPUT");
  return new Date(parsed.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function bookingCellKeys(booking: Pick<BookingRecord, "startAt" | "endAt">): string[] {
  return inventoryCellKeys(shanghaiLocalTime(booking.startAt), shanghaiLocalTime(booking.endAt));
}

function inventoryContainsBooking(
  inventory: CourtDayInventory,
  cellKeys: readonly string[],
  bookingId: string,
): boolean {
  return cellKeys.some((key) => inventory.cells[key]?.bookingIds.includes(bookingId));
}

function normalizeTimeBlockReason(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new BookingError("INVALID_INPUT");
  const reason = value.trim();
  if (
    !reason ||
    Array.from(reason).length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(reason) ||
    /(?:1\d{10}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/u.test(reason)
  ) throw new BookingError("INVALID_INPUT");
  return reason;
}

function requireInventoryVersion(inventory: CourtDayInventory, expected: unknown): void {
  if (!Number.isInteger(expected) || expected !== inventory.version) {
    throw new BookingError("CONFLICT");
  }
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
  delete updated.proposedDate;
  delete updated.proposedSessionId;
  delete updated.proposedCourtId;
  delete updated.proposedStartAt;
  delete updated.proposedEndAt;
  delete updated.proposalPreviousStatus;
  return updated;
}

interface ValidatedStaffReservationWindow {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  courtId: string;
  cellKeys: string[];
}

function validateStaffReservationWindow(
  command: CreateStaffReservationCommand,
): ValidatedStaffReservationWindow {
  const title = typeof command.title === "string" ? command.title.trim() : "";
  if (
    !title ||
    Array.from(title).length > 40 ||
    /[\u0000-\u001f\u007f]/u.test(title) ||
    !courtIds.includes(command.courtId)
  ) {
    throw new BookingError("INVALID_INPUT");
  }
  const date = requireCalendarDate(command.date);
  const opening = clockMinutes(defaultBookingPolicy.openingTime);
  const closing = clockMinutes(defaultBookingPolicy.closingTime);
  const start = clockMinutes(command.startTime);
  const end = clockMinutes(command.endTime);
  if (
    start < opening ||
    end > closing ||
    end <= start ||
    start % 30 !== 0 ||
    end % 30 !== 0
  ) {
    throw new BookingError("INVALID_INPUT");
  }
  return {
    title,
    date,
    startTime: command.startTime,
    endTime: command.endTime,
    courtId: command.courtId,
    cellKeys: inventoryCellKeys(command.startTime, command.endTime),
  };
}

export class BookingService {
  private readonly repository: BookingRepository;
  private readonly clock: Clock;
  private readonly ids: IdProvider;
  private readonly phoneHasher: PhoneHasher;

  constructor(
    repository: BookingRepository,
    clock: Clock = systemClock,
    ids: IdProvider = secureIds,
    phoneHasher: PhoneHasher = unavailablePhoneHasher,
  ) {
    this.repository = repository;
    this.clock = clock;
    this.ids = ids;
    this.phoneHasher = phoneHasher;
  }

  async create(input: unknown): Promise<BookingRecord> {
    const command = validateCreateBooking(input);
    const phone = normalizePhone(command.phone);
    if (!phone) throw new BookingError("INVALID_INPUT");
    const phoneHash = this.phoneHasher.hash(phone);
    const email = command.email?.trim();
    const requestedWindow = command.date && command.startTime && command.endTime
      ? validateBookingWindow(command.date, command.startTime, command.endTime)
      : null;
    const legacySessionId = command.sessionId;
    const parsed = requestedWindow
      ? { date: requestedWindow.date }
      : parseSessionId(legacySessionId as string);
    const now = this.clock.now().toISOString();
    const bookingId = this.ids.bookingId();
    const codeCandidates = Array.from({ length: bookingCodeCandidateCount }, () =>
      this.ids.bookingCode().trim().toUpperCase(),
    );
    const idempotencyKeyHash = hash(command.idempotencyKey);
    const auditId = this.ids.eventId();
    const staffNotificationId = this.ids.eventId();
    const customerNotificationId = email ? this.ids.eventId() : undefined;
    const windowCandidateCourtIds = requestedWindow
      ? await this.rankWindowCourtCandidates(
          requestedWindow,
          command.mode,
          command.partySize,
        )
      : undefined;

    return this.repository.runTransaction(async (transaction) => {
      if (requestedWindow && !(await transaction.isBookingInventoryV2Ready())) {
        throw new BookingError("SESSION_CLOSED");
      }
      const previousId = await transaction.getIdempotency(idempotencyKeyHash);
      if (previousId) return requireBooking(await transaction.getBooking(previousId));

      let selectedCode: { code: string; codeHash: string } | undefined;
      for (const candidate of codeCandidates) {
        if (!candidate) continue;
        const candidateHash = bookingCodeId(candidate);
        if (!(await transaction.getBookingIdByCodeHash(candidateHash))) {
          selectedCode = { code: candidate, codeHash: candidateHash };
          break;
        }
      }
      if (!selectedCode) throw new BookingError("CONFLICT");
      const { code, codeHash } = selectedCode;

      let sessionId: string;
      let startAt: string;
      let endAt: string;
      let selectedCourtId: string;
      let selectedAllocation: CourtAllocation | undefined;
      let selectedInventory: CourtDayInventory;
      let legacyPrepared: PreparedSession | undefined;
      let cellKeys: string[];

      if (requestedWindow) {
        const selected = await this.selectWindowInventory(
          transaction,
          requestedWindow,
          now,
          command.mode,
          command.partySize,
          windowCandidateCourtIds as readonly string[],
        );
        sessionId = bookingWindowSessionId(
          requestedWindow.date,
          requestedWindow.startTime,
          requestedWindow.endTime,
        );
        startAt = shanghaiInstant(requestedWindow.date, requestedWindow.startTime);
        endAt = shanghaiInstant(requestedWindow.date, requestedWindow.endTime);
        selectedCourtId = selected.courtId;
        selectedInventory = selected;
        cellKeys = requestedWindow.cellKeys;
      } else {
        legacyPrepared = await this.prepareSession(transaction, legacySessionId as string, now);
        const enabled = new Set(
          legacyPrepared.currentCourts
            .filter(
              (court) =>
                court.enabled && legacyPrepared?.session.enabledCourtIds.includes(court.id),
            )
            .map((court) => court.id),
        );
        cellKeys = inventoryCellKeys(
          shanghaiLocalTime(legacyPrepared.session.startAt),
          shanghaiLocalTime(legacyPrepared.session.endAt),
        );
        const inventories = await this.readCourtDayInventories(
          transaction,
          legacyPrepared.session.date,
          courtIds,
        );
        const inventoryByCourt = new Map(inventories.map((item) => [item.courtId, item]));
        const eligibleAllocations = legacyPrepared.allocations.filter((allocation) => {
          if (!enabled.has(allocation.courtId)) return false;
          const inventory = inventoryByCourt.get(allocation.courtId);
          return Boolean(
            inventory &&
              chooseCourtDayInventory(
                command.mode,
                command.partySize,
                cellKeys,
                [inventory],
              ),
          );
        });
        selectedAllocation = chooseCourt(command.mode, command.partySize, eligibleAllocations) ?? undefined;
        if (!selectedAllocation) throw new BookingError("SESSION_FULL");
        sessionId = legacyPrepared.session.id;
        startAt = legacyPrepared.session.startAt;
        endAt = legacyPrepared.session.endAt;
        selectedCourtId = selectedAllocation.courtId;
        selectedInventory = inventoryByCourt.get(selectedCourtId) as CourtDayInventory;
      }

      const booking: BookingRecord = {
        id: bookingId,
        code,
        idempotencyKeyHash,
        sessionId,
        date: parsed.date,
        startAt,
        endAt,
        courtId: selectedCourtId,
        mode: command.mode,
        partySize: command.partySize,
        status: "confirmed",
        name: command.name.trim(),
        phone,
        phoneHash,
        ...(email ? { email } : {}),
        ...(command.note === undefined ? {} : { note: command.note.trim() }),
        privacyConsentAt: now,
        ...(command.publicScheduleConsentVersion !== undefined
          ? {
              publicScheduleConsentVersion: command.publicScheduleConsentVersion,
              publicScheduleConsentAt: now,
            }
          : {}),
        ...(command.hidePublicName === true ? { hidePublicName: true } : {}),
        canCancelUntil: startAt,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      if (legacyPrepared?.isNew) await transaction.putSession(legacyPrepared.session);
      if (selectedAllocation) {
        await transaction.putAllocation(reserveAllocation(selectedAllocation, booking));
      }
      await transaction.putCourtDayInventory(
        reserveCourtDayInventory(
          selectedInventory,
          booking.mode,
          booking.partySize,
          booking.id,
          cellKeys,
        ),
      );
      await transaction.putBooking(booking);
      await transaction.putBookingCode(codeHash, booking.id);
      await transaction.putIdempotency(idempotencyKeyHash, booking.id);
      await transaction.appendAudit(
        this.audit(auditId, booking, "created", "system", now, undefined, "confirmed"),
      );
      await transaction.enqueueNotification(
        this.notification(staffNotificationId, booking.id, booking.version, "created", "staff", now),
      );
      if (customerNotificationId) {
        await transaction.enqueueNotification(
          this.notification(
            customerNotificationId,
            booking.id,
            booking.version,
            "created",
            "customer",
            now,
          ),
        );
      }
      return booking;
    });
  }

  async lookup(code: string, phone: string): Promise<BookingRecord | null> {
    const normalizedPhone = normalizePhone(phone);
    if (typeof code !== "string" || code.trim() === "" || !normalizedPhone) return null;
    const requestedPhoneHash = this.phoneHasher.hash(normalizedPhone);
    return this.repository.runTransaction(async (transaction) => {
      const id = await transaction.getBookingIdByCodeHash(bookingCodeId(code));
      if (!id) return null;
      const booking = await transaction.getBooking(id);
      return booking?.phoneHash === requestedPhoneHash ? booking : null;
    });
  }

  confirm(command: StaffMutationCommand): Promise<BookingRecord> {
    return this.repository.runTransaction(async (transaction) => {
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      if (booking.status === "confirmed") return booking;
      if (booking.status !== "pending") throw new BookingError("INVALID_TRANSITION");
      const now = this.clock.now().toISOString();
      const updated: BookingRecord = {
        ...booking,
        status: "confirmed",
        updatedAt: now,
        version: booking.version + 1,
      };
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(
          this.ids.eventId(),
          booking,
          "confirmed",
          "staff",
          now,
          "pending",
          "confirmed",
          command.actorId,
        ),
      );
      if (hasNotificationEmail(booking)) {
        await transaction.enqueueNotification(
          this.notification(
            this.ids.eventId(),
            booking.id,
            updated.version,
            "confirmed",
            "customer",
            now,
          ),
        );
      }
      return updated;
    });
  }

  async proposeReschedule(command: ProposeRescheduleCommand): Promise<BookingRecord> {
    const requestedWindow = command.date && command.startTime && command.endTime
      ? validateBookingWindow(command.date, command.startTime, command.endTime)
      : null;
    const hasAnyWindowPart = [command.date, command.startTime, command.endTime].some(
      (value) => value !== undefined,
    );
    if (
      Boolean(command.sessionId) === Boolean(requestedWindow) ||
      (hasAnyWindowPart && !requestedWindow)
    ) {
      throw new BookingError("INVALID_INPUT");
    }
    if (command.sessionId) parseSessionId(command.sessionId);
    const now = this.clock.now().toISOString();
    const auditId = this.ids.eventId();
    const notificationId = this.ids.eventId();
    const proposalCandidateCourtIds = requestedWindow
      ? await this.rankRescheduleWindowCourtCandidates(
          requestedWindow,
          command.bookingId,
        )
      : undefined;
    return this.repository.runTransaction(async (transaction) => {
      if (requestedWindow && !(await transaction.isBookingInventoryV2Ready())) {
        throw new BookingError("SESSION_CLOSED");
      }
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      assertTransition(booking.status, "reschedule_proposed");
      let proposalSessionId: string;
      let proposalDate: string;
      let proposalStartAt: string;
      let proposalEndAt: string;
      let proposalCourtId: string;
      let proposalCellKeys: string[];
      let proposalInventory: CourtDayInventory;
      let proposalAllocation: CourtAllocation | undefined;
      let legacyPrepared: PreparedSession | undefined;

      if (requestedWindow) {
        proposalSessionId = bookingWindowSessionId(
          requestedWindow.date,
          requestedWindow.startTime,
          requestedWindow.endTime,
        );
        if (proposalSessionId === booking.sessionId) throw new BookingError("INVALID_INPUT");
        const selected = await this.selectWindowInventory(
          transaction,
          requestedWindow,
          now,
          booking.mode,
          booking.partySize,
          proposalCandidateCourtIds as readonly string[],
          booking.id,
        );
        proposalDate = requestedWindow.date;
        proposalStartAt = shanghaiInstant(requestedWindow.date, requestedWindow.startTime);
        proposalEndAt = shanghaiInstant(requestedWindow.date, requestedWindow.endTime);
        proposalCourtId = selected.courtId;
        proposalCellKeys = requestedWindow.cellKeys;
        proposalInventory = selected;
      } else {
        proposalSessionId = command.sessionId as string;
        if (proposalSessionId === booking.sessionId) throw new BookingError("INVALID_INPUT");
        legacyPrepared = await this.prepareSession(transaction, proposalSessionId, now);
        this.requireLegacyRescheduleWindowWithinPolicy(legacyPrepared.session);
        const enabled = new Set(
          legacyPrepared.currentCourts
            .filter(
              (court) =>
                court.enabled && legacyPrepared?.session.enabledCourtIds.includes(court.id),
            )
            .map((court) => court.id),
        );
        proposalCellKeys = inventoryCellKeys(
          shanghaiLocalTime(legacyPrepared.session.startAt),
          shanghaiLocalTime(legacyPrepared.session.endAt),
        );
        const inventories = await this.readCourtDayInventories(
          transaction,
          legacyPrepared.session.date,
          courtIds,
        );
        const byCourt = new Map(inventories.map((item) => [item.courtId, item]));
        proposalAllocation = chooseCourt(
          booking.mode,
          booking.partySize,
          legacyPrepared.allocations.filter((allocation) => {
            const inventory = byCourt.get(allocation.courtId);
            return (
              enabled.has(allocation.courtId) &&
              Boolean(
                inventory &&
                  !inventoryContainsBooking(
                    inventory,
                    proposalCellKeys,
                    booking.id,
                  ),
              ) &&
              Boolean(
                inventory &&
                  chooseCourtDayInventory(
                    booking.mode,
                    booking.partySize,
                    proposalCellKeys,
                    [inventory],
                  ),
              )
            );
          }),
        ) ?? undefined;
        if (!proposalAllocation) throw new BookingError("SESSION_FULL");
        proposalDate = legacyPrepared.session.date;
        proposalStartAt = legacyPrepared.session.startAt;
        proposalEndAt = legacyPrepared.session.endAt;
        proposalCourtId = proposalAllocation.courtId;
        proposalInventory = byCourt.get(proposalCourtId) as CourtDayInventory;
      }
      const updated: BookingRecord = {
        ...booking,
        status: "reschedule_proposed",
        proposalPreviousStatus: booking.status as "pending" | "confirmed",
        proposedDate: proposalDate,
        proposedSessionId: proposalSessionId,
        proposedCourtId: proposalCourtId,
        proposedStartAt: proposalStartAt,
        proposedEndAt: proposalEndAt,
        updatedAt: now,
        version: booking.version + 1,
      };
      if (legacyPrepared?.isNew) await transaction.putSession(legacyPrepared.session);
      if (proposalAllocation) {
        await transaction.putAllocation(reserveAllocation(proposalAllocation, booking));
      }
      await transaction.putCourtDayInventory(
        reserveCourtDayInventory(
          proposalInventory,
          booking.mode,
          booking.partySize,
          booking.id,
          proposalCellKeys,
        ),
      );
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(auditId, booking, "reschedule_proposed", "staff", now, booking.status, updated.status, command.actorId),
      );
      if (hasNotificationEmail(booking)) {
        await transaction.enqueueNotification(
          this.notification(
            notificationId,
            booking.id,
            updated.version,
            "reschedule_proposed",
            "customer",
            now,
          ),
        );
      }
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
      const proposedDate = booking.proposedDate ?? parseSessionId(booking.proposedSessionId).date;
      let updated: BookingRecord;
      if (command.accept) {
        assertTransition(booking.status, "confirmed");
        updated = clearProposal({
          ...booking,
          sessionId: booking.proposedSessionId,
          date: proposedDate,
          courtId: booking.proposedCourtId,
          startAt: booking.proposedStartAt,
          endAt: booking.proposedEndAt,
          canCancelUntil: booking.proposedStartAt,
          status: "confirmed",
          updatedAt: now,
          version: booking.version + 1,
        });
        await this.releaseBookingInventories(transaction, booking);
      } else {
        assertTransition(booking.status, booking.proposalPreviousStatus);
        updated = clearProposal({
          ...booking,
          status: booking.proposalPreviousStatus,
          updatedAt: now,
          version: booking.version + 1,
        });
        await this.releaseBookingInventories(transaction, booking, {
          sessionId: booking.proposedSessionId,
          date: proposedDate,
          courtId: booking.proposedCourtId,
          startAt: booking.proposedStartAt,
          endAt: booking.proposedEndAt,
        });
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
      if (hasNotificationEmail(booking)) {
        await transaction.enqueueNotification(
          this.notification(
            notificationId,
            booking.id,
            updated.version,
            command.accept ? "reschedule_accepted" : "reschedule_rejected",
            "customer",
            now,
          ),
        );
      }
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
      await this.releaseBookingInventories(transaction, booking);
      if (
        booking.proposedSessionId &&
        booking.proposedCourtId &&
        booking.proposedStartAt &&
        booking.proposedEndAt
      ) {
        await this.releaseBookingInventories(transaction, booking, {
          sessionId: booking.proposedSessionId,
          date: booking.proposedDate ?? parseSessionId(booking.proposedSessionId).date,
          courtId: booking.proposedCourtId,
          startAt: booking.proposedStartAt,
          endAt: booking.proposedEndAt,
        });
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
      if (hasNotificationEmail(booking)) {
        await transaction.enqueueNotification(
          this.notification(
            notificationId,
            booking.id,
            updated.version,
            "cancelled",
            "customer",
            now,
          ),
        );
      }
      return updated;
    });
  }

  async complete(command: StaffMutationCommand): Promise<BookingRecord> {
    const now = this.clock.now().toISOString();
    const auditId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      assertTransition(booking.status, "completed");
      const updated: BookingRecord = {
        ...booking,
        status: "completed",
        terminalAt: booking.terminalAt ?? now,
        updatedAt: now,
        version: booking.version + 1,
      };
      await this.releaseBookingInventories(transaction, booking);
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(auditId, booking, "completed", "staff", now, booking.status, "completed", command.actorId),
      );
      return updated;
    });
  }

  async reassign(command: ReassignBookingCommand): Promise<BookingRecord> {
    if (!courtIds.includes(command.courtId)) throw new BookingError("INVALID_INPUT");
    const now = this.clock.now().toISOString();
    const auditId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      if (booking.status === "cancelled" || booking.status === "completed") {
        throw new BookingError("INVALID_TRANSITION");
      }
      if (booking.status === "reschedule_proposed") throw new BookingError("INVALID_TRANSITION");
      const windowSession = parseBookingWindowSessionId(booking.sessionId);
      const session = windowSession ? null : await transaction.getSession(booking.sessionId);
      const courts = await transaction.getCourts([command.courtId]);
      if (
        !courts[0]?.enabled ||
        (!windowSession && (!session || !session.enabledCourtIds.includes(command.courtId)))
      ) {
        throw new BookingError("SESSION_CLOSED");
      }
      if (command.courtId === booking.courtId) return booking;
      const keys = bookingCellKeys(booking);
      const [targetInventory] = await this.readCourtDayInventories(
        transaction,
        booking.date,
        [command.courtId],
      );
      if (!chooseCourtDayInventory(booking.mode, booking.partySize, keys, [targetInventory])) {
        throw new BookingError("SESSION_FULL");
      }
      const targetAllocation = windowSession
        ? null
        : await this.readAllocation(transaction, booking.sessionId, command.courtId);
      if (
        targetAllocation &&
        !chooseCourt(booking.mode, booking.partySize, [targetAllocation])
      ) {
        throw new BookingError("SESSION_FULL");
      }
      const updated = {
        ...booking,
        courtId: command.courtId,
        updatedAt: now,
        version: booking.version + 1,
      };
      await this.releaseBookingInventories(transaction, booking);
      if (targetAllocation) {
        await transaction.putAllocation(reserveAllocation(targetAllocation, booking));
      }
      await transaction.putCourtDayInventory(
        reserveCourtDayInventory(
          targetInventory,
          booking.mode,
          booking.partySize,
          booking.id,
          keys,
        ),
      );
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(auditId, booking, "reassigned", "staff", now, booking.status, booking.status, command.actorId),
      );
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

  async createStaffReservation(
    command: CreateStaffReservationCommand,
  ): Promise<BookingRecord> {
    const window = validateStaffReservationWindow(command);
    const now = this.clock.now().toISOString();
    if (shanghaiInstant(window.date, window.startTime) <= now) {
      throw new BookingError("SESSION_CLOSED");
    }
    const bookingId = this.ids.bookingId();
    const auditId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      if (!(await transaction.isBookingInventoryV2Ready())) {
        throw new BookingError("SESSION_CLOSED");
      }
      const [court] = await transaction.getCourts([window.courtId]);
      if (!court?.enabled) throw new BookingError("SESSION_CLOSED");
      const [inventory] = await this.readCourtDayInventories(
        transaction,
        window.date,
        [window.courtId],
      );
      if (!chooseCourtDayInventory("private", 4, window.cellKeys, [inventory])) {
        throw new BookingError("SESSION_FULL");
      }
      const startAt = shanghaiInstant(window.date, window.startTime);
      const endAt = shanghaiInstant(window.date, window.endTime);
      const booking: BookingRecord = {
        id: bookingId,
        code: `STAFF-${bookingId}`,
        bookingKind: "staff_reservation",
        staffReservationTitle: window.title,
        sessionId: `${window.date}__staff-${bookingId}`,
        date: window.date,
        startAt,
        endAt,
        courtId: window.courtId,
        mode: "private",
        partySize: 4,
        status: "confirmed",
        canCancelUntil: startAt,
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
      await transaction.putCourtDayInventory(
        reserveCourtDayInventory(
          inventory,
          booking.mode,
          booking.partySize,
          booking.id,
          window.cellKeys,
        ),
      );
      await transaction.putBooking(booking);
      await transaction.appendAudit(
        this.audit(
          auditId,
          booking,
          "staff_reservation_created",
          "staff",
          now,
          undefined,
          "confirmed",
          command.actorId,
        ),
      );
      return booking;
    });
  }

  async updateStaffReservation(
    command: UpdateStaffReservationCommand,
  ): Promise<BookingRecord> {
    const window = validateStaffReservationWindow(command);
    const now = this.clock.now().toISOString();
    if (shanghaiInstant(window.date, window.startTime) <= now) {
      throw new BookingError("SESSION_CLOSED");
    }
    const auditId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      if (!(await transaction.isBookingInventoryV2Ready())) {
        throw new BookingError("SESSION_CLOSED");
      }
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      if (
        booking.bookingKind !== "staff_reservation" ||
        booking.status !== "confirmed" ||
        booking.archivedAt
      ) {
        throw new BookingError("INVALID_TRANSITION");
      }
      const [court] = await transaction.getCourts([window.courtId]);
      if (!court?.enabled) throw new BookingError("SESSION_CLOSED");
      const [targetInventory] = await this.readCourtDayInventories(
        transaction,
        window.date,
        [window.courtId],
      );
      const targetWithoutSelf = releaseCourtDayInventory(
        targetInventory,
        booking.partySize,
        booking.id,
        booking.date === window.date && booking.courtId === window.courtId
          ? bookingCellKeys(booking)
          : [],
      );
      if (!chooseCourtDayInventory("private", 4, window.cellKeys, [targetWithoutSelf])) {
        throw new BookingError("SESSION_FULL");
      }
      await this.releaseBookingInventories(transaction, booking);
      const refreshedTarget = booking.date === window.date && booking.courtId === window.courtId
        ? targetWithoutSelf
        : targetInventory;
      const startAt = shanghaiInstant(window.date, window.startTime);
      const endAt = shanghaiInstant(window.date, window.endTime);
      const updated: BookingRecord = {
        ...booking,
        staffReservationTitle: window.title,
        sessionId: `${window.date}__staff-${booking.id}`,
        date: window.date,
        startAt,
        endAt,
        courtId: window.courtId,
        canCancelUntil: startAt,
        updatedAt: now,
        version: booking.version + 1,
      };
      await transaction.putCourtDayInventory(
        reserveCourtDayInventory(
          refreshedTarget,
          updated.mode,
          updated.partySize,
          updated.id,
          window.cellKeys,
        ),
      );
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(
          auditId,
          booking,
          "staff_reservation_updated",
          "staff",
          now,
          booking.status,
          updated.status,
          command.actorId,
        ),
      );
      return updated;
    });
  }

  archiveBooking(
    bookingId: string,
    actorId: string,
    expectedVersion: number,
  ): Promise<BookingRecord> {
    return this.repository.setBookingArchived(bookingId, true, actorId, expectedVersion);
  }

  restoreBooking(
    bookingId: string,
    actorId: string,
    expectedVersion: number,
  ): Promise<BookingRecord> {
    return this.repository.setBookingArchived(bookingId, false, actorId, expectedVersion);
  }

  async listAvailability(date: string): Promise<AvailabilitySlot[]> {
    const calendarDate = requireCalendarDate(date);
    const now = this.clock.now().toISOString();
    const [storedAvailability, storedSessions, templates, courts, storedInventories] = await Promise.all([
      this.repository.listAvailability(calendarDate),
      this.repository.listSessions(calendarDate),
      this.repository.listSessionTemplates(),
      this.repository.listCourts(),
      this.repository.listCourtDayInventories(calendarDate),
    ]);
    const materializedSessionIds = new Set([
      ...storedSessions.map((session) => session.id),
      ...storedAvailability.map((slot) => slot.sessionId),
    ]);
    const enabledCourtCount = courts.filter(
      (court) => court.enabled && courtIds.includes(court.id),
    ).length;
    const synthetic = enabledCourtCount === 0
      ? []
      : templates.flatMap((template): AvailabilitySlot[] => {
          const sessionId = `${calendarDate}__${template.id}`;
          if (!template.enabled || materializedSessionIds.has(sessionId)) return [];
          const startAt = shanghaiInstant(calendarDate, template.startTime);
          const endAt = shanghaiInstant(calendarDate, template.endTime);
          if (Date.parse(endAt) - Date.parse(startAt) !== 60 * 60 * 1000 || startAt <= now) {
            return [];
          }
          return [{
            sessionId,
            date: calendarDate,
            startTime: template.startTime,
            endTime: template.endTime,
            openCapacity: enabledCourtCount * 4,
            acceptsOpenPartySizes: [1, 2, 3, 4],
            privateCourtCount: enabledCourtCount,
            acceptsOpen: true,
            acceptsPrivate: true,
          }];
        });

    const bySessionId = new Map(synthetic.map((slot) => [slot.sessionId, slot]));
    for (const slot of storedAvailability) bySessionId.set(slot.sessionId, slot);
    const inventoryByCourt = new Map(
      storedInventories.map((inventory) => [inventory.courtId, inventory]),
    );
    return Array.from(bySessionId.values())
      .map((slot): AvailabilitySlot => {
        const keys = inventoryCellKeys(slot.startTime, slot.endTime);
        const closedCourts = courts.filter(
          (court) => court.enabled && keys.some(
            (key) => Boolean(inventoryByCourt.get(court.id)?.blockedCells?.[key]),
          ),
        ).length;
        if (closedCourts === 0) return slot;
        const openCapacity = Math.max(0, slot.openCapacity - closedCourts * 4);
        const privateCourtCount = Math.max(0, slot.privateCourtCount - closedCourts);
        const acceptsOpenPartySizes = slot.acceptsOpenPartySizes.filter(
          (partySize) => partySize <= openCapacity,
        );
        return {
          ...slot,
          openCapacity,
          acceptsOpenPartySizes,
          privateCourtCount,
          acceptsOpen: acceptsOpenPartySizes.length > 0,
          acceptsPrivate: privateCourtCount > 0,
        };
      })
      .filter((slot) => shanghaiInstant(slot.date, slot.startTime) > now)
      .sort(
        (left, right) =>
          left.startTime.localeCompare(right.startTime) ||
          left.sessionId.localeCompare(right.sessionId),
      );
  }

  async listWindowAvailability(
    query: string | { date: string },
  ): Promise<BookingWindowAvailabilityResult> {
    const calendarDate = requireCalendarDate(typeof query === "string" ? query : query.date);
    if (!(await this.repository.isBookingInventoryV2Ready())) {
      return { policy: defaultBookingPolicy, windows: [] };
    }
    const now = this.clock.now().toISOString();
    const [listedCourts, storedInventories] = await Promise.all([
      this.repository.listCourts(),
      this.repository.listCourtDayInventories(calendarDate),
    ]);
    const courts = listedCourts.filter(
      (court) => court.enabled && courtIds.includes(court.id),
    );
    if (courts.length === 0) return { policy: defaultBookingPolicy, windows: [] };
    const inventoryByCourt = new Map(
      storedInventories.map((inventory) => [inventory.courtId, inventory]),
    );
    const inventories = courts.map(
      (court) =>
        inventoryByCourt.get(court.id) ?? emptyCourtDayInventory(calendarDate, court.id),
    );
    const windows = listBookingWindows(calendarDate)
      .filter((window) => shanghaiInstant(calendarDate, window.startTime) > now)
      .map((window): BookingWindowAvailability => {
        const privateCourtCount = inventories.filter((inventory) =>
          window.cellKeys.every(
            (key) => !inventory.cells[key] && !inventory.blockedCells?.[key],
          ),
        ).length;
        const openCapacity = inventories.reduce((total, inventory) => {
          const capacity = Math.min(
            ...window.cellKeys.map((key) => {
              const cell = inventory.cells[key];
              if (inventory.blockedCells?.[key]) return 0;
              if (!cell) return 4;
              return cell.mode === "open" ? Math.max(0, 4 - cell.occupiedPlayers) : 0;
            }),
          );
          return total + capacity;
        }, 0);
        const acceptsOpenPartySizes = ([1, 2, 3, 4] as const).filter((partySize) =>
          Boolean(
            chooseCourtDayInventory(
              "open",
              partySize,
              window.cellKeys,
              inventories,
            ),
          ),
        );
        return {
          sessionId: bookingWindowSessionId(
            calendarDate,
            window.startTime,
            window.endTime,
          ),
          date: calendarDate,
          startTime: window.startTime,
          endTime: window.endTime,
          durationMinutes: window.durationMinutes,
          openCapacity,
          acceptsOpenPartySizes,
          privateCourtCount,
          acceptsOpen: acceptsOpenPartySizes.length > 0,
          acceptsPrivate: privateCourtCount > 0,
        };
      });
    return { policy: defaultBookingPolicy, windows };
  }

  async listCourtTimeBlocks(date: string): Promise<CourtTimeBlock[]> {
    return (await this.listCourtTimeBlockDay(date)).items;
  }

  async listCourtTimeBlockDay(date: string): Promise<CourtTimeBlockDay> {
    const calendarDate = requireCalendarDate(date);
    const inventories = await this.repository.listCourtDayInventories(calendarDate);
    const inventoryByCourt = new Map(inventories.map((inventory) => [inventory.courtId, inventory]));
    const inventoryVersions = Object.fromEntries(
      courtIds.map((courtId) => [courtId, inventoryByCourt.get(courtId)?.version ?? 0]),
    );
    const items = inventories
      .flatMap((inventory) => Object.values(inventory.timeBlocks ?? {}).map((block) => ({
        ...block,
        version: inventory.version,
      })))
      .sort(
        (left, right) =>
          left.startTime.localeCompare(right.startTime) ||
          left.courtId.localeCompare(right.courtId) ||
          left.id.localeCompare(right.id),
      );
    return { items, inventoryVersions };
  }

  async createCourtTimeBlocks(
    command: CreateCourtTimeBlocksCommand,
  ): Promise<CourtTimeBlock[]> {
    const window = validateCourtTimeBlockWindow(command.date, command.startTime, command.endTime);
    const reason = normalizeTimeBlockReason(command.reason);
    const requestedCourtIds = Array.isArray(command.courtIds) ? command.courtIds : [];
    if (
      requestedCourtIds.length === 0 ||
      requestedCourtIds.length > 2 ||
      new Set(requestedCourtIds).size !== requestedCourtIds.length ||
      requestedCourtIds.some((courtId) => !courtIds.includes(courtId)) ||
      !command.expectedVersions ||
      typeof command.expectedVersions !== "object" ||
      !command.actorId?.trim()
    ) throw new BookingError("INVALID_INPUT");
    const now = this.clock.now().toISOString();
    if (shanghaiInstant(window.date, window.startTime) <= now) {
      throw new BookingError("SESSION_CLOSED");
    }
    return this.repository.runTransaction(async (transaction) => {
      if (!(await transaction.isBookingInventoryV2Ready())) {
        throw new BookingError("SESSION_CLOSED");
      }
      const courts = await transaction.getCourts(requestedCourtIds);
      if (courts.length !== requestedCourtIds.length) throw new BookingError("SESSION_NOT_FOUND");
      const inventories = await this.readCourtDayInventories(
        transaction,
        window.date,
        requestedCourtIds,
      );
      for (const inventory of inventories) {
        requireInventoryVersion(inventory, command.expectedVersions[inventory.courtId]);
        if (
          window.cellKeys.some(
            (key) => inventory.cells[key] || inventory.blockedCells?.[key],
          )
        ) throw new BookingError("CONFLICT");
      }

      const blocks: CourtTimeBlock[] = [];
      for (const inventory of inventories) {
        const version = inventory.version + 1;
        const id = `block-${this.ids.eventId()}`;
        const block: CourtTimeBlock = {
          id,
          date: window.date,
          courtId: inventory.courtId,
          startTime: window.startTime,
          endTime: window.endTime,
          cellKeys: [...window.cellKeys],
          ...(reason ? { reason } : {}),
          createdAt: now,
          createdBy: command.actorId,
          updatedAt: now,
          updatedBy: command.actorId,
          version,
        };
        const blockedCells = { ...(inventory.blockedCells ?? {}) };
        for (const key of window.cellKeys) {
          blockedCells[key] = { blockId: id, ...(reason ? { reason } : {}) };
        }
        await transaction.putCourtDayInventory({
          ...inventory,
          blockedCells,
          timeBlocks: { ...(inventory.timeBlocks ?? {}), [id]: block },
          version,
        });
        await transaction.appendAudit(this.timeBlockAudit(
          `court-time-block-created-${encodeURIComponent(id)}-v${version}`,
          "court_time_block_created",
          block,
          command.actorId,
          now,
        ));
        blocks.push(block);
      }
      return blocks;
    });
  }

  async updateCourtTimeBlock(
    command: UpdateCourtTimeBlockCommand,
  ): Promise<CourtTimeBlock> {
    const window = validateCourtTimeBlockWindow(command.date, command.startTime, command.endTime);
    const reason = normalizeTimeBlockReason(command.reason);
    if (!courtIds.includes(command.courtId) || !command.blockId?.trim() || !command.actorId?.trim()) {
      throw new BookingError("INVALID_INPUT");
    }
    const now = this.clock.now().toISOString();
    if (shanghaiInstant(window.date, window.startTime) <= now) {
      throw new BookingError("SESSION_CLOSED");
    }
    return this.repository.runTransaction(async (transaction) => {
      if (!(await transaction.isBookingInventoryV2Ready())) {
        throw new BookingError("SESSION_CLOSED");
      }
      const [inventory] = await this.readCourtDayInventories(
        transaction,
        window.date,
        [command.courtId],
      );
      requireInventoryVersion(inventory, command.expectedVersion);
      const previous = inventory.timeBlocks?.[command.blockId];
      if (!previous || previous.date !== window.date || previous.courtId !== command.courtId) {
        throw new BookingError("SESSION_NOT_FOUND");
      }
      if (
        window.cellKeys.some((key) => {
          const existingBlock = inventory.blockedCells?.[key];
          return Boolean(inventory.cells[key] || (existingBlock && existingBlock.blockId !== command.blockId));
        })
      ) throw new BookingError("CONFLICT");
      const version = inventory.version + 1;
      const updated: CourtTimeBlock = {
        ...previous,
        startTime: window.startTime,
        endTime: window.endTime,
        cellKeys: [...window.cellKeys],
        ...(reason ? { reason } : {}),
        updatedAt: now,
        updatedBy: command.actorId,
        version,
      };
      if (!reason) delete updated.reason;
      const blockedCells = { ...(inventory.blockedCells ?? {}) };
      for (const [key, value] of Object.entries(blockedCells)) {
        if (value.blockId === command.blockId) delete blockedCells[key];
      }
      for (const key of window.cellKeys) {
        blockedCells[key] = { blockId: command.blockId, ...(reason ? { reason } : {}) };
      }
      await transaction.putCourtDayInventory({
        ...inventory,
        blockedCells,
        timeBlocks: { ...(inventory.timeBlocks ?? {}), [command.blockId]: updated },
        version,
      });
      await transaction.appendAudit(this.timeBlockAudit(
        `court-time-block-updated-${encodeURIComponent(command.blockId)}-v${version}`,
        "court_time_block_updated",
        updated,
        command.actorId,
        now,
      ));
      return updated;
    });
  }

  async restoreCourtTimeBlock(command: RestoreCourtTimeBlockCommand): Promise<void> {
    const date = requireCalendarDate(command.date);
    if (!courtIds.includes(command.courtId) || !command.blockId?.trim() || !command.actorId?.trim()) {
      throw new BookingError("INVALID_INPUT");
    }
    const now = this.clock.now().toISOString();
    await this.repository.runTransaction(async (transaction) => {
      if (!(await transaction.isBookingInventoryV2Ready())) {
        throw new BookingError("SESSION_CLOSED");
      }
      const [inventory] = await this.readCourtDayInventories(transaction, date, [command.courtId]);
      requireInventoryVersion(inventory, command.expectedVersion);
      const block = inventory.timeBlocks?.[command.blockId];
      if (!block || block.date !== date || block.courtId !== command.courtId) {
        throw new BookingError("SESSION_NOT_FOUND");
      }
      const blockedCells = { ...(inventory.blockedCells ?? {}) };
      for (const [key, value] of Object.entries(blockedCells)) {
        if (value.blockId === command.blockId) delete blockedCells[key];
      }
      const timeBlocks = { ...(inventory.timeBlocks ?? {}) };
      delete timeBlocks[command.blockId];
      const version = inventory.version + 1;
      await transaction.putCourtDayInventory({
        ...inventory,
        blockedCells,
        timeBlocks,
        version,
      });
      await transaction.appendAudit(this.timeBlockAudit(
        `court-time-block-restored-${encodeURIComponent(command.blockId)}-v${version}`,
        "court_time_block_restored",
        { ...block, version },
        command.actorId,
        now,
      ));
    });
  }

  listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]> {
    return this.repository.listBookings(filter);
  }

  listBookingPage(filter: AdminBookingFilter): Promise<BookingPage> {
    return this.repository.listBookingPage(filter);
  }

  listCustomerHistory(bookingId: string, limit = 50): Promise<BookingRecord[]> {
    return this.repository.listCustomerHistory(bookingId, Math.max(1, Math.min(limit, 100)));
  }

  listPendingBookings(date: string): Promise<BookingRecord[]> {
    return this.repository.listPendingBookings(date);
  }

  listMatrixBookings(date: string): Promise<BookingRecord[]> {
    return this.repository.listMatrixBookings(date);
  }

  listPublicSchedule(date: string): Promise<BookingRecord[]> {
    return this.repository.listPublicSchedule(requireCalendarDate(date), 100);
  }

  listCourts(): Promise<CourtRecord[]> {
    return this.repository.listCourts();
  }

  listSessionTemplates(): Promise<SessionTemplateRecord[]> {
    return this.repository.listSessionTemplates();
  }

  listAuditLogs(bookingId: string): Promise<AuditLog[]> {
    return this.repository.listAuditLogs(bookingId);
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
    action: NotificationKind,
    requiredFrom?: BookingStatus,
  ): Promise<BookingRecord> {
    const now = this.clock.now().toISOString();
    const auditId = this.ids.eventId();
    const notificationId = this.ids.eventId();
    return this.repository.runTransaction(async (transaction) => {
      const booking = requireBooking(await transaction.getBooking(command.bookingId));
      requireVersion(booking, command.expectedVersion);
      if (requiredFrom && booking.status !== requiredFrom) {
        throw new BookingError("INVALID_TRANSITION");
      }
      assertTransition(booking.status, status);
      const updated = { ...booking, status, updatedAt: now, version: booking.version + 1 };
      await transaction.putBooking(updated);
      await transaction.appendAudit(
        this.audit(auditId, booking, action, "staff", now, booking.status, status, command.actorId),
      );
      if (hasNotificationEmail(booking)) {
        await transaction.enqueueNotification(
          this.notification(
            notificationId,
            booking.id,
            updated.version,
            action,
            "customer",
            now,
          ),
        );
      }
      return updated;
    });
  }

  private async rankWindowCourtCandidates(
    window: ValidatedBookingWindow,
    mode: BookingRecord["mode"],
    partySize: number,
  ): Promise<string[]> {
    const [currentCourts, storedInventories] = await Promise.all([
      this.repository.listCourts(),
      this.repository.listCourtDayInventories(window.date),
    ]);
    return this.orderWindowCourtCandidates(
      window,
      mode,
      partySize,
      currentCourts,
      storedInventories,
    );
  }

  private async rankRescheduleWindowCourtCandidates(
    window: ValidatedBookingWindow,
    bookingId: string,
  ): Promise<string[]> {
    const [booking, currentCourts, storedInventories] = await Promise.all([
      this.repository.getBookingById(bookingId),
      this.repository.listCourts(),
      this.repository.listCourtDayInventories(window.date),
    ]);
    if (!booking) return courtIds;
    return this.orderWindowCourtCandidates(
      window,
      booking.mode,
      booking.partySize,
      currentCourts,
      storedInventories,
      booking.id,
    );
  }

  private orderWindowCourtCandidates(
    window: ValidatedBookingWindow,
    mode: BookingRecord["mode"],
    partySize: number,
    currentCourts: readonly CourtRecord[],
    storedInventories: readonly CourtDayInventory[],
    excludedBookingId?: string,
  ): string[] {
    const enabled = new Set(
      currentCourts
        .filter((court) => court.enabled && courtIds.includes(court.id))
        .map((court) => court.id),
    );
    const byCourt = new Map(
      storedInventories
        .filter((inventory) => courtIds.includes(inventory.courtId))
        .map((inventory) => [inventory.courtId, inventory]),
    );
    const remaining = new Map(
      courtIds.map((courtId) => [
        courtId,
        byCourt.get(courtId) ?? emptyCourtDayInventory(window.date, courtId),
      ]),
    );
    const ranked: string[] = [];
    while (true) {
      const selected = chooseCourtDayInventory(
        mode,
        partySize,
        window.cellKeys,
        Array.from(remaining.values()).filter(
          (inventory) =>
            enabled.has(inventory.courtId) &&
            (!excludedBookingId ||
              !inventoryContainsBooking(inventory, window.cellKeys, excludedBookingId)),
        ),
      );
      if (!selected) break;
      ranked.push(selected.courtId);
      remaining.delete(selected.courtId);
    }
    return [
      ...ranked,
      ...Array.from(remaining.keys()).sort(
        (left, right) =>
          Number(enabled.has(right)) - Number(enabled.has(left)) || left.localeCompare(right),
      ),
    ];
  }

  private async selectWindowInventory(
    transaction: BookingTransaction,
    window: ValidatedBookingWindow,
    now: string,
    mode: BookingRecord["mode"],
    partySize: number,
    candidateCourtIds: readonly string[],
    excludedBookingId?: string,
  ): Promise<CourtDayInventory> {
    if (shanghaiInstant(window.date, window.startTime) <= now) {
      throw new BookingError("SESSION_CLOSED");
    }
    for (const courtId of candidateCourtIds) {
      const [inventory] = await this.readCourtDayInventories(
        transaction,
        window.date,
        [courtId],
      );
      if (
        excludedBookingId &&
        inventoryContainsBooking(inventory, window.cellKeys, excludedBookingId)
      ) {
        continue;
      }
      if (!chooseCourtDayInventory(mode, partySize, window.cellKeys, [inventory])) continue;
      const [court] = await transaction.getCourts([courtId]);
      if (court?.enabled) return inventory;
    }
    throw new BookingError("SESSION_FULL");
  }

  private async readCourtDayInventories(
    transaction: BookingTransaction,
    date: string,
    requestedCourtIds: readonly string[],
  ): Promise<CourtDayInventory[]> {
    const stored = await transaction.getCourtDayInventories(date, requestedCourtIds);
    const byCourt = new Map(stored.map((item) => [item.courtId, item]));
    return requestedCourtIds.map(
      (courtId) => byCourt.get(courtId) ?? emptyCourtDayInventory(date, courtId),
    );
  }

  private async releaseBookingInventories(
    transaction: BookingTransaction,
    booking: BookingRecord,
    location: {
      sessionId: string;
      date: string;
      courtId: string;
      startAt: string;
      endAt: string;
    } = booking,
  ): Promise<void> {
    const windowSession = parseBookingWindowSessionId(location.sessionId);
    if (!windowSession && booking.bookingKind !== "staff_reservation") {
      const allocation = await this.readAllocation(
        transaction,
        location.sessionId,
        location.courtId,
      );
      await transaction.putAllocation(releaseAllocation(allocation, booking));
    }
    const [inventory] = await this.readCourtDayInventories(
      transaction,
      location.date,
      [location.courtId],
    );
    const keys = inventoryCellKeys(
      shanghaiLocalTime(location.startAt),
      shanghaiLocalTime(location.endAt),
    );
    // A v2 booking is born in this inventory. Missing ownership indicates corrupted or
    // partially migrated data and must not be hidden by a successful lifecycle mutation.
    if (
      (windowSession || booking.bookingKind === "staff_reservation") &&
      keys.some((key) => !inventory.cells[key]?.bookingIds.includes(booking.id))
    ) {
      throw new BookingError("CONFLICT");
    }
    const released = releaseCourtDayInventory(
      inventory,
      booking.partySize,
      booking.id,
      keys,
    );
    if (released !== inventory) await transaction.putCourtDayInventory(released);
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

  private requireLegacyRescheduleWindowWithinPolicy(session: SessionRecord): void {
    try {
      validateBookingWindow(
        session.date,
        shanghaiLocalTime(session.startAt),
        shanghaiLocalTime(session.endAt),
      );
    } catch (error) {
      if (error instanceof BookingError) throw new BookingError("SESSION_CLOSED");
      throw error;
    }
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

  private timeBlockAudit(
    id: string,
    action: "court_time_block_created" | "court_time_block_updated" | "court_time_block_restored",
    block: CourtTimeBlock,
    actorId: string,
    at: string,
  ): AuditLog {
    return {
      id,
      bookingId: `court-time-block:${block.id}`,
      action,
      actorType: "staff",
      actorId,
      at,
      metadata: {
        entity: "court-time-block",
        id: block.id,
        date: block.date,
        courtId: block.courtId,
        startTime: block.startTime,
        endTime: block.endTime,
        ...(block.reason ? { reason: block.reason } : {}),
        version: block.version,
      },
    };
  }

  private notification(
    id: string,
    bookingId: string,
    bookingVersion: number,
    kind: NotificationKind,
    recipientType: NotificationEvent["recipientType"],
    now: string,
  ): NotificationEvent {
    return {
      id,
      bookingId,
      bookingVersion,
      kind,
      recipientType,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }
}
