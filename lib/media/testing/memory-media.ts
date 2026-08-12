import { MediaError } from "../errors.ts";
import type { HomepageMediaRepository, HomepageMediaStorage, StoredMediaInfo } from "../ports.ts";
import type { HomepageMediaManifest, SignedMediaUpload } from "../types.ts";

function initialManifest(): HomepageMediaManifest {
  return {
    id: "homepage-media-v1",
    schemaVersion: 1,
    version: 0,
    items: [],
    audit: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

export class MemoryHomepageMediaRepository implements HomepageMediaRepository {
  private manifest = initialManifest();

  async read(): Promise<HomepageMediaManifest> {
    return structuredClone(this.manifest);
  }

  async replace(expectedVersion: number, manifest: HomepageMediaManifest): Promise<void> {
    if (this.manifest.version !== expectedVersion || manifest.version !== expectedVersion + 1) {
      throw new MediaError("MEDIA_CONFLICT");
    }
    this.manifest = structuredClone(manifest);
  }
}

export class MemoryHomepageMediaStorage implements HomepageMediaStorage {
  readonly createdIntents: Array<{ storagePath: string; mimeType: string; sizeBytes: number; expiresAt: string }> = [];
  readonly deletedFileIds: string[] = [];
  readonly publicUrlRequests: string[][] = [];
  private readonly files = new Map<string, StoredMediaInfo>();

  async createUpload(input: { storagePath: string; mimeType: string; sizeBytes: number; expiresAt: string }): Promise<SignedMediaUpload> {
    this.createdIntents.push(structuredClone(input));
    const id = input.storagePath.split("/").at(-1)?.split(".")[0] ?? "file";
    const fileId = `cloud://${id}`;
    this.files.set(fileId, { exists: false });
    return {
      method: "PUT",
      url: `https://upload.test/${id}`,
      headers: { "Content-Type": input.mimeType },
      expiresAt: input.expiresAt,
      fileId,
    };
  }

  complete(fileId: string, info: { mimeType: string; sizeBytes: number }): void {
    this.files.set(fileId, { exists: true, ...structuredClone(info) });
  }

  async inspect(fileId: string): Promise<StoredMediaInfo> {
    return structuredClone(this.files.get(fileId) ?? { exists: false });
  }

  async publicUrls(fileIds: readonly string[]): Promise<Record<string, string>> {
    this.publicUrlRequests.push([...fileIds]);
    return Object.fromEntries(
      fileIds.map((fileId) => [fileId, `https://media.test/${fileId.replace(/^cloud:\/\//u, "")}`]),
    );
  }

  async delete(fileId: string): Promise<void> {
    this.deletedFileIds.push(fileId);
    this.files.delete(fileId);
  }
}
