import { BookingError } from "../../../lib/booking/errors.ts";
import type { BookingRepository, Clock } from "../../../lib/booking/ports.ts";
import type { BookingService } from "../../../lib/booking/booking-service.ts";
import { database } from "../cloudbase-app.ts";

const RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

interface DocumentResponse {
  data?: unknown[] | Record<string, unknown>;
}

interface DocumentReference {
  get(): Promise<DocumentResponse>;
  set(data: object): Promise<unknown>;
}

interface CollectionReference {
  doc(id: string): DocumentReference;
}

interface TransactionReference {
  collection(name: string): CollectionReference;
}

interface DatabaseReference {
  runTransaction<T>(
    work: (transaction: TransactionReference) => Promise<T>,
    retries?: number,
  ): Promise<T>;
}

export interface PrivacyRetentionDependencies {
  database?: DatabaseReference;
  repository: Pick<BookingRepository, "listExpiredPersonalData">;
  service: Pick<BookingService, "redactPersonalData">;
  clock?: Clock;
}

export interface PrivacyRetentionResult {
  claimed: boolean;
  selected: number;
  redacted: number;
  skipped: number;
}

const systemClock: Clock = { now: () => new Date() };

function firstRow<T>(response: DocumentResponse): T | null {
  if (Array.isArray(response.data)) return (response.data[0] as T | undefined) ?? null;
  return response.data ? (response.data as T) : null;
}

function shanghaiParts(instant: Date): { date: string; time: string } {
  const shifted = new Date(instant.getTime() + 8 * 60 * 60 * 1000).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 19) };
}

async function claimDailyMarker(
  db: DatabaseReference,
  now: Date,
): Promise<boolean> {
  const parts = shanghaiParts(now);
  if (parts.time < "03:15:00") return false;
  const claimedAt = now.toISOString();
  return db.runTransaction(async (transaction) => {
    const document = transaction.collection("system_state").doc("retention-daily");
    const current = firstRow<{ date?: string }>(await document.get());
    if (current?.date && current.date >= parts.date) return false;
    await document.set({ date: parts.date, claimedAt });
    return true;
  }, 3);
}

export async function runPrivacyRetention(
  dependencies: PrivacyRetentionDependencies,
): Promise<PrivacyRetentionResult> {
  const now = (dependencies.clock ?? systemClock).now();
  const db = dependencies.database ?? (database as unknown as DatabaseReference);
  const claimed = await claimDailyMarker(db, now);
  if (!claimed) return { claimed: false, selected: 0, redacted: 0, skipped: 0 };

  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();
  const candidates = await dependencies.repository.listExpiredPersonalData(cutoff, 100);
  let redacted = 0;
  let skipped = 0;
  for (const booking of candidates.slice(0, 100)) {
    try {
      await dependencies.service.redactPersonalData(
        booking.id,
        "retention-worker",
        booking.version,
        "system",
      );
      redacted += 1;
    } catch (error) {
      if (
        error instanceof BookingError &&
        (error.code === "CONFLICT" || error.code === "BOOKING_NOT_FOUND")
      ) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { claimed: true, selected: candidates.length, redacted, skipped };
}
