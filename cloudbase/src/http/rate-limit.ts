import { createHash } from "node:crypto";
import { database } from "../cloudbase-app.ts";

export interface RateLimitRequest {
  scope: string;
  key: string;
  limit: number;
  windowMs: number;
}

export interface RateLimiter {
  consume(request: RateLimitRequest): Promise<boolean>;
}

export interface RateLimitStore {
  increment(keyHash: string, windowStartedAt: string, expiresAt: string): Promise<number>;
}

interface DocumentResponse {
  data?: unknown[] | Record<string, unknown>;
}

interface DocumentReference {
  get(): Promise<DocumentResponse>;
  set(data: object): Promise<unknown>;
}

interface TransactionReference {
  collection(name: string): { doc(id: string): DocumentReference };
}

interface DatabaseReference {
  runTransaction<T>(work: (transaction: TransactionReference) => Promise<T>, retries?: number): Promise<T>;
}

function firstRecord(response: DocumentResponse): Record<string, unknown> | null {
  if (Array.isArray(response.data)) {
    const value = response.data[0];
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  }
  return response.data && typeof response.data === "object"
    ? (response.data as Record<string, unknown>)
    : null;
}

export class CloudBaseRateLimitStore implements RateLimitStore {
  private readonly db: DatabaseReference;

  constructor(db: DatabaseReference = database as unknown as DatabaseReference) {
    this.db = db;
  }

  increment(keyHash: string, windowStartedAt: string, expiresAt: string): Promise<number> {
    return this.db.runTransaction(async (transaction) => {
      const document = transaction.collection("rate_limits").doc(keyHash);
      const current = firstRecord(await document.get());
      const count =
        current?.windowStartedAt === windowStartedAt && typeof current.count === "number"
          ? current.count + 1
          : 1;
      await document.set({ keyHash, count, windowStartedAt, expiresAt });
      return count;
    }, 3);
  }
}

export function createRateLimiter(options: {
  store?: RateLimitStore;
  salt: string;
  now?: () => Date;
}): RateLimiter {
  const store = options.store ?? new CloudBaseRateLimitStore();
  const now = options.now ?? (() => new Date());
  return {
    async consume(request) {
      const instant = now().getTime();
      const windowStart = Math.floor(instant / request.windowMs) * request.windowMs;
      const windowStartedAt = new Date(windowStart).toISOString();
      const expiresAt = new Date(windowStart + request.windowMs).toISOString();
      const keyHash = createHash("sha256")
        .update(options.salt)
        .update("\0")
        .update(request.scope)
        .update("\0")
        .update(request.key)
        .update("\0")
        .update(windowStartedAt)
        .digest("hex");
      return (await store.increment(keyHash, windowStartedAt, expiresAt)) <= request.limit;
    },
  };
}
