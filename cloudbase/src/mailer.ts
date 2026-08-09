import { randomUUID } from "node:crypto";
import { BookingService } from "../../lib/booking/booking-service.ts";
import type { NotificationOutboxRepository } from "../../lib/booking/outbox-ports.ts";
import type { BookingRepository, Clock } from "../../lib/booking/ports.ts";
import type { BookingRecord, NotificationEvent } from "../../lib/booking/types.ts";
import {
  SesAdapter,
  classifySesError,
  type NotificationMail,
  type SesAdapterConfig,
} from "./notifications/ses-adapter.ts";
import { runPrivacyRetention } from "./privacy/redact-expired.ts";
import { CloudBaseBookingRepository } from "./repositories/cloudbase-booking-repository.ts";
import { CloudBaseOutboxRepository } from "./repositories/cloudbase-outbox-repository.ts";

const environmentNames = [
  "TENCENTCLOUD_SECRET_ID",
  "TENCENTCLOUD_SECRET_KEY",
  "SES_REGION",
  "SES_FROM_EMAIL",
  "SES_TEMPLATE_ID",
  "SES_REPLY_TO",
  "STAFF_NOTIFICATION_EMAIL",
] as const;

type MailEnvironmentName = (typeof environmentNames)[number];
type MailEnvironment = Record<MailEnvironmentName, string | undefined>;

interface NotificationSender {
  send(mail: NotificationMail): Promise<{
    providerRequestId: string;
    providerMessageId?: string;
  }>;
}

interface MailerLogger {
  warn(message: string, details: { variable: MailEnvironmentName }): void;
}

export interface MailerDependencies {
  environment: MailEnvironment;
  outbox: NotificationOutboxRepository;
  bookings: Pick<BookingRepository, "getBookingById">;
  createSender?: (config: SesAdapterConfig) => NotificationSender;
  clock?: Clock;
  randomId?: () => string;
  runRetention: () => Promise<unknown>;
  logger?: MailerLogger;
}

const systemClock: Clock = { now: () => new Date() };

function readConfiguration(environment: MailEnvironment):
  | { config: SesAdapterConfig }
  | { missing: MailEnvironmentName } {
  const values = Object.fromEntries(
    environmentNames.map((name) => [name, environment[name]?.trim()]),
  ) as Record<MailEnvironmentName, string | undefined>;
  for (const name of environmentNames) {
    if (!values[name]) return { missing: name };
  }
  const templateId = Number(values.SES_TEMPLATE_ID);
  if (!Number.isSafeInteger(templateId) || templateId <= 0) {
    return { missing: "SES_TEMPLATE_ID" };
  }
  return {
    config: {
      secretId: values.TENCENTCLOUD_SECRET_ID as string,
      secretKey: values.TENCENTCLOUD_SECRET_KEY as string,
      region: values.SES_REGION as string,
      fromEmail: values.SES_FROM_EMAIL as string,
      templateId,
      replyTo: values.SES_REPLY_TO as string,
      staffEmail: values.STAFF_NOTIFICATION_EMAIL as string,
    },
  };
}

function recipientFor(
  event: NotificationEvent,
  booking: BookingRecord,
  config: SesAdapterConfig,
): string | null {
  if (event.recipientType === "staff") return config.staffEmail;
  if (typeof booking.email !== "string" || booking.email.trim() === "") return null;
  return booking.email.trim();
}

function mailFor(
  event: NotificationEvent,
  booking: BookingRecord,
  recipient: string,
): NotificationMail {
  const proposal = event.kind === "reschedule_proposed";
  return {
    recipient,
    templateData: {
      kind: event.kind,
      code: booking.code,
      date: proposal ? (booking.proposedDate as string) : booking.date,
      startAt: proposal ? (booking.proposedStartAt as string) : booking.startAt,
      endAt: proposal ? (booking.proposedEndAt as string) : booking.endAt,
      status: booking.status,
      courtId: proposal ? (booking.proposedCourtId as string) : booking.courtId,
      mode: booking.mode,
      partySize: booking.partySize,
      displayName: booking.name?.trim() || "预约用户",
    },
  };
}

function plusMinutes(instant: string, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

async function processClaimed(
  event: NotificationEvent,
  leaseToken: string,
  outbox: NotificationOutboxRepository,
  bookings: Pick<BookingRepository, "getBookingById">,
  sender: NotificationSender,
  config: SesAdapterConfig,
  clock: Clock,
): Promise<void> {
  let booking: BookingRecord | null;
  try {
    booking = await bookings.getBookingById(event.bookingId);
  } catch (error) {
    await recordFailure(event, leaseToken, outbox, clock, error);
    return;
  }
  if (!booking) {
    await outbox.markFailed(
      event.id,
      leaseToken,
      clock.now().toISOString(),
      "BOOKING_NOT_FOUND",
    );
    return;
  }
  const proposalUnavailable =
    event.kind === "reschedule_proposed" &&
    (booking.status !== "reschedule_proposed" ||
      !booking.proposedDate ||
      !booking.proposedStartAt ||
      !booking.proposedEndAt ||
      !booking.proposedCourtId);
  if (booking.version !== event.bookingVersion || proposalUnavailable) {
    await outbox.markFailed(
      event.id,
      leaseToken,
      clock.now().toISOString(),
      "EVENT_SUPERSEDED",
    );
    return;
  }
  const recipient = recipientFor(event, booking, config);
  if (!recipient) {
    await outbox.markFailed(
      event.id,
      leaseToken,
      clock.now().toISOString(),
      "RECIPIENT_UNAVAILABLE",
    );
    return;
  }
  let delivery: Awaited<ReturnType<NotificationSender["send"]>>;
  try {
    delivery = await sender.send(mailFor(event, booking, recipient));
  } catch (error) {
    await recordFailure(event, leaseToken, outbox, clock, error);
    return;
  }
  await outbox.markSent(event.id, leaseToken, clock.now().toISOString(), delivery);
}

async function recordFailure(
  event: NotificationEvent,
  leaseToken: string,
  outbox: NotificationOutboxRepository,
  clock: Clock,
  error: unknown,
): Promise<void> {
  const resultNow = clock.now().toISOString();
  const classified = classifySesError(error);
  if (!classified.retryable || event.attemptCount >= 5) {
    await outbox.markFailed(event.id, leaseToken, resultNow, classified.code);
    return;
  }
  const delayMinutes = 2 ** (event.attemptCount - 1);
  await outbox.markRetry(
    event.id,
    leaseToken,
    resultNow,
    plusMinutes(resultNow, delayMinutes),
    classified.code,
  );
}

export async function runMailer(dependencies: MailerDependencies): Promise<void> {
  const clock = dependencies.clock ?? systemClock;
  const randomId = dependencies.randomId ?? randomUUID;
  const logger = dependencies.logger ?? console;
  try {
    const configured = readConfiguration(dependencies.environment);
    if ("missing" in configured) {
      logger.warn("MISSING_CONFIGURATION", { variable: configured.missing });
      return;
    }
    const sender = dependencies.createSender
      ? dependencies.createSender(configured.config)
      : new SesAdapter(configured.config);
    const listNow = clock.now().toISOString();
    const workerId = randomId();
    const events = await dependencies.outbox.listEligible(20, listNow);
    for (const event of events.slice(0, 20)) {
      const leaseToken = randomId();
      const claimNow = clock.now().toISOString();
      const claimed = await dependencies.outbox.claim(
        event.id,
        workerId,
        leaseToken,
        claimNow,
        plusMinutes(claimNow, 5),
      );
      if (!claimed) continue;
      await processClaimed(
        claimed,
        leaseToken,
        dependencies.outbox,
        dependencies.bookings,
        sender,
        configured.config,
        clock,
      );
    }
  } finally {
    await dependencies.runRetention();
  }
}

export async function runMailerSafely(dependencies: MailerDependencies): Promise<void> {
  try {
    await runMailer(dependencies);
  } catch {
    throw new Error("MAILER_INVOCATION_FAILED");
  }
}

export async function main(): Promise<{ ok: true }> {
  const bookingRepository = new CloudBaseBookingRepository();
  const bookingService = new BookingService(bookingRepository);
  await runMailerSafely({
    environment: process.env as MailEnvironment,
    outbox: new CloudBaseOutboxRepository(),
    bookings: bookingRepository,
    runRetention: () =>
      runPrivacyRetention({
        repository: bookingRepository,
        service: bookingService,
      }),
  });
  return { ok: true };
}
