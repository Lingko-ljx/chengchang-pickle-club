import { MediaError } from "../../../lib/media/errors.ts";
import type { HonorMediaRepository } from "../../../lib/honor-media/ports.ts";
import type { HonorMediaManifest } from "../../../lib/honor-media/types.ts";
import { database } from "../cloudbase-app.ts";

interface DocumentResponse { data?: unknown[] | Record<string, unknown>; }
interface DocumentReference { get(): Promise<DocumentResponse>; set(data: object): Promise<unknown>; }
interface CollectionReference { doc(id: string): DocumentReference; }
interface TransactionReference { collection(name: string): CollectionReference; }
interface DatabaseReference {
  collection(name: string): CollectionReference;
  runTransaction<T>(work: (transaction: TransactionReference) => Promise<T>, retries?: number): Promise<T>;
}

function manifestFrom(response: DocumentResponse): HonorMediaManifest | null {
  const value = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = { ...value } as Record<string, unknown>;
  delete record._id;
  return record as unknown as HonorMediaManifest;
}

function emptyManifest(): HonorMediaManifest {
  return { id: "honor-media-v1", schemaVersion: 1, version: 0, items: [], audit: [], updatedAt: "1970-01-01T00:00:00.000Z" };
}

export class CloudBaseHonorMediaRepository implements HonorMediaRepository {
  private readonly db: DatabaseReference;
  constructor(db: DatabaseReference = database as unknown as DatabaseReference) { this.db = db; }

  async read(): Promise<HonorMediaManifest> {
    return manifestFrom(await this.db.collection("system_state").doc("honor-media-v1").get()) ?? emptyManifest();
  }

  replace(expectedVersion: number, manifest: HonorMediaManifest): Promise<void> {
    return this.db.runTransaction(async (transaction) => {
      const document = transaction.collection("system_state").doc("honor-media-v1");
      const current = manifestFrom(await document.get());
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== expectedVersion || manifest.id !== "honor-media-v1" || manifest.schemaVersion !== 1 || manifest.version !== expectedVersion + 1) {
        throw new MediaError("MEDIA_CONFLICT");
      }
      await document.set(manifest);
    }, 3);
  }
}
