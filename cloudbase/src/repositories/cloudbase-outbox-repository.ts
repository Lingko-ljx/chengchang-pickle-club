import type {
  NotificationOutboxRepository,
  ProviderDelivery,
} from "../../../lib/booking/outbox-ports.ts";
import type { NotificationEvent } from "../../../lib/booking/types.ts";
import { database } from "../cloudbase-app.ts";

interface DocumentResponse {
  data?: unknown[] | Record<string, unknown>;
}

interface DocumentReference {
  get(): Promise<DocumentResponse>;
  update(data: Record<string, unknown>): Promise<unknown>;
}

interface QueryReference {
  doc(id: string): DocumentReference;
  where(condition: Record<string, unknown>): QueryReference;
  orderBy(field: string, direction: "asc" | "desc"): QueryReference;
  skip(value: number): QueryReference;
  limit(value: number): QueryReference;
  get(): Promise<DocumentResponse>;
}

interface TransactionReference {
  collection(name: string): QueryReference;
}

interface DatabaseReference {
  command: {
    lte(value: unknown): unknown;
    remove(): unknown;
  };
  collection(name: string): QueryReference;
  runTransaction<T>(
    work: (transaction: TransactionReference) => Promise<T>,
    retries?: number,
  ): Promise<T>;
}

function rows<T>(response: DocumentResponse): T[] {
  if (Array.isArray(response.data)) return response.data as T[];
  return response.data ? [response.data as T] : [];
}

async function readEvent(document: DocumentReference): Promise<NotificationEvent | null> {
  return rows<NotificationEvent>(await document.get())[0] ?? null;
}

const safeErrorCodes = new Set([
  "ATTEMPTS_EXHAUSTED",
  "AUTH_ERROR",
  "BOOKING_NOT_FOUND",
  "CONFIGURATION_ERROR",
  "EVENT_SUPERSEDED",
  "INTERNAL_ERROR",
  "INVALID_ADDRESS",
  "INVALID_PARAMETER",
  "INVALID_PROVIDER_RESPONSE",
  "INVALID_TEMPLATE",
  "NETWORK_ERROR",
  "RECIPIENT_UNAVAILABLE",
  "REQUEST_LIMITED",
  "RESOURCE_INSUFFICIENT",
  "RESOURCE_UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
  "TEMPORARY_BLOCKED",
  "UNKNOWN_ERROR",
]);

function normalizeErrorCode(value: string): string {
  return safeErrorCodes.has(value) ? value : "UNKNOWN_ERROR";
}

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const messageIdPattern =
  /^qcloudses-\d{1,10}-\d{1,20}-date-\d{14}-[A-Za-z0-9]{1,64}$/;

function normalizeProviderId(value: string, pattern: RegExp): string {
  const normalized = value.trim();
  return pattern.test(normalized) ? normalized : "REDACTED";
}

export class CloudBaseOutboxRepository implements NotificationOutboxRepository {
  private readonly db: DatabaseReference;

  constructor(db: DatabaseReference = database as unknown as DatabaseReference) {
    this.db = db;
  }

  async listEligible(limit: number, now: string): Promise<NotificationEvent[]> {
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (boundedLimit === 0) return [];
    const states: NotificationEvent["status"][] = ["pending", "retry", "sending"];
    const grouped = await Promise.all(
      states.map((status) => this.listDueStatus(status, boundedLimit, now)),
    );
    return grouped
      .flat()
      .sort(
        (left, right) =>
          left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.id.localeCompare(right.id),
      )
      .slice(0, boundedLimit);
  }

  claim(
    eventId: string,
    workerId: string,
    leaseToken: string,
    now: string,
    leaseUntil: string,
  ): Promise<NotificationEvent | null> {
    return this.db.runTransaction(async (transaction) => {
      const document = transaction.collection("notification_outbox").doc(eventId);
      const current = await readEvent(document);
      if (
        !current ||
        !this.isClaimable(current, now) ||
        workerId.trim() === "" ||
        leaseToken.trim() === "" ||
        current.leaseToken === leaseToken
      ) {
        return null;
      }
      if (current.attemptCount >= 5) {
        const remove = this.db.command.remove();
        await document.update({
          status: "failed",
          lastErrorCode: "ATTEMPTS_EXHAUSTED",
          failedAt: now,
          updatedAt: now,
          leaseOwner: remove,
          leaseToken: remove,
          leaseUntil: remove,
        });
        return null;
      }
      const claimed: NotificationEvent = {
        ...current,
        status: "sending",
        attemptCount: current.attemptCount + 1,
        nextAttemptAt: leaseUntil,
        leaseOwner: workerId,
        leaseToken,
        leaseUntil,
        updatedAt: now,
      };
      await document.update({
        status: claimed.status,
        attemptCount: claimed.attemptCount,
        nextAttemptAt: claimed.nextAttemptAt,
        leaseOwner: claimed.leaseOwner,
        leaseToken: claimed.leaseToken,
        leaseUntil: claimed.leaseUntil,
        updatedAt: claimed.updatedAt,
      });
      return claimed;
    }, 3);
  }

  markSent(
    eventId: string,
    leaseToken: string,
    sentAt: string,
    delivery: ProviderDelivery,
  ): Promise<boolean> {
    return this.mark(eventId, leaseToken, async (document, remove) => {
      const providerRequestId = normalizeProviderId(delivery.providerRequestId, requestIdPattern);
      const providerMessageId = delivery.providerMessageId
        ? normalizeProviderId(delivery.providerMessageId, messageIdPattern)
        : undefined;
      await document.update({
        status: "sent",
        providerRequestId,
        ...(providerMessageId ? { providerMessageId } : { providerMessageId: remove }),
        lastErrorCode: remove,
        sentAt,
        failedAt: remove,
        updatedAt: sentAt,
        leaseOwner: remove,
        leaseToken: remove,
        leaseUntil: remove,
      });
    });
  }

  markRetry(
    eventId: string,
    leaseToken: string,
    updatedAt: string,
    nextAttemptAt: string,
    errorCode: string,
  ): Promise<boolean> {
    return this.mark(eventId, leaseToken, async (document, remove) => {
      await document.update({
        status: "retry",
        nextAttemptAt,
        lastErrorCode: normalizeErrorCode(errorCode),
        updatedAt,
        leaseOwner: remove,
        leaseToken: remove,
        leaseUntil: remove,
      });
    });
  }

  markFailed(
    eventId: string,
    leaseToken: string,
    failedAt: string,
    errorCode: string,
  ): Promise<boolean> {
    return this.mark(eventId, leaseToken, async (document, remove) => {
      await document.update({
        status: "failed",
        lastErrorCode: normalizeErrorCode(errorCode),
        failedAt,
        updatedAt: failedAt,
        leaseOwner: remove,
        leaseToken: remove,
        leaseUntil: remove,
      });
    });
  }

  private isClaimable(event: NotificationEvent, now: string): boolean {
    if ((event.status === "pending" || event.status === "retry") && event.nextAttemptAt <= now) {
      return true;
    }
    return (
      event.status === "sending" &&
      typeof event.leaseUntil === "string" &&
      event.leaseUntil <= now &&
      event.nextAttemptAt <= now
    );
  }

  private async listDueStatus(
    status: NotificationEvent["status"],
    limit: number,
    now: string,
  ): Promise<NotificationEvent[]> {
    const pageSize = 100;
    const values: NotificationEvent[] = [];
    let offset = 0;
    while (values.length < limit) {
      const requested = Math.min(pageSize, limit - values.length);
      const page = rows<NotificationEvent>(
        await this.db
          .collection("notification_outbox")
          .where({ status, nextAttemptAt: this.db.command.lte(now) })
          .orderBy("nextAttemptAt", "asc")
          .orderBy("id", "asc")
          .skip(offset)
          .limit(requested)
          .get(),
      );
      offset += page.length;
      values.push(
        ...page.filter(
          (event) =>
            status !== "sending" ||
            (typeof event.leaseUntil === "string" && event.leaseUntil <= now),
        ),
      );
      if (page.length < requested) break;
    }
    return values;
  }

  private mark(
    eventId: string,
    leaseToken: string,
    update: (document: DocumentReference, remove: unknown) => Promise<void>,
  ): Promise<boolean> {
    return this.db.runTransaction(async (transaction) => {
      const document = transaction.collection("notification_outbox").doc(eventId);
      const current = await readEvent(document);
      if (!current || current.status !== "sending" || current.leaseToken !== leaseToken) {
        return false;
      }
      await update(document, this.db.command.remove());
      return true;
    }, 3);
  }
}
