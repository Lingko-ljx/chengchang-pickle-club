import type { NotificationEvent } from "./types.ts";

export interface ProviderDelivery {
  providerRequestId: string;
  providerMessageId?: string;
}

export interface NotificationOutboxRepository {
  listEligible(limit: number, now: string): Promise<NotificationEvent[]>;
  claim(
    eventId: string,
    workerId: string,
    leaseToken: string,
    now: string,
    leaseUntil: string,
  ): Promise<NotificationEvent | null>;
  markSent(
    eventId: string,
    leaseToken: string,
    sentAt: string,
    delivery: ProviderDelivery,
  ): Promise<boolean>;
  markRetry(
    eventId: string,
    leaseToken: string,
    updatedAt: string,
    nextAttemptAt: string,
    errorCode: string,
  ): Promise<boolean>;
  markFailed(
    eventId: string,
    leaseToken: string,
    failedAt: string,
    errorCode: string,
  ): Promise<boolean>;
}
