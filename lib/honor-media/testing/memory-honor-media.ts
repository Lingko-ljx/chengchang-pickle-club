import { MediaError } from "../../media/errors.ts";
import type { StoredMediaInfo } from "../../media/ports.ts";
import type { SignedMediaUpload } from "../../media/types.ts";
import type { HonorMediaRepository, HonorMediaStorage } from "../ports.ts";
import type { HonorMediaManifest } from "../types.ts";

function initialManifest(): HonorMediaManifest {
  return { id: "honor-media-v1", schemaVersion: 1, version: 0, items: [], audit: [], updatedAt: "1970-01-01T00:00:00.000Z" };
}

export class MemoryHonorMediaRepository implements HonorMediaRepository {
  private manifest = initialManifest();

  async read(): Promise<HonorMediaManifest> { return structuredClone(this.manifest); }

  async replace(expectedVersion: number, manifest: HonorMediaManifest): Promise<void> {
    if (this.manifest.version !== expectedVersion || manifest.version !== expectedVersion + 1) {
      throw new MediaError("MEDIA_CONFLICT");
    }
    this.manifest = structuredClone(manifest);
  }
}

export class MemoryHonorMediaStorage implements HonorMediaStorage {
  readonly createdIntents: Array<{ storagePath: string; mimeType: string; sizeBytes: number; expiresAt: string }> = [];
  readonly deletedFileIds: string[] = [];
  private readonly files = new Map<string, StoredMediaInfo>();

  async createUpload(input: { storagePath: string; mimeType: string; sizeBytes: number; expiresAt: string }): Promise<SignedMediaUpload> {
    this.createdIntents.push(structuredClone(input));
    const id = input.storagePath.split("/").at(-1)?.split(".")[0] ?? "file";
    const fileId = `cloud://${id}`;
    this.files.set(fileId, { exists: false });
    return { method: "PUT", url: `https://upload.test/${id}`, headers: { "Content-Type": input.mimeType }, expiresAt: input.expiresAt, fileId };
  }

  complete(fileId: string, info: { mimeType: string; sizeBytes: number }): void {
    this.files.set(fileId, { exists: true, ...structuredClone(info) });
  }

  async inspect(fileId: string): Promise<StoredMediaInfo> { return structuredClone(this.files.get(fileId) ?? { exists: false }); }
  async publicUrls(fileIds: readonly string[]): Promise<Record<string, string>> {
    return Object.fromEntries(fileIds.map((fileId) => [fileId, `https://honors.test/${fileId.replace(/^cloud:\/\//u, "")}`]));
  }
  async delete(fileId: string): Promise<void> { this.deletedFileIds.push(fileId); this.files.delete(fileId); }
}
