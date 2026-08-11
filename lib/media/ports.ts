import type {
  HomepageMediaManifest,
  SignedMediaUpload,
} from "./types.ts";

export interface HomepageMediaRepository {
  read(): Promise<HomepageMediaManifest>;
  replace(expectedVersion: number, manifest: HomepageMediaManifest): Promise<void>;
}

export interface StoredMediaInfo {
  exists: boolean;
  mimeType?: string;
  sizeBytes?: number;
}

export interface HomepageMediaStorage {
  createUpload(input: {
    storagePath: string;
    mimeType: string;
    sizeBytes: number;
    expiresAt: string;
  }): Promise<SignedMediaUpload>;
  inspect(fileId: string): Promise<StoredMediaInfo>;
  publicUrls(fileIds: readonly string[]): Promise<Record<string, string>>;
  delete(fileId: string): Promise<void>;
}

export interface MediaClock {
  now(): Date;
}

export interface MediaIdProvider {
  mediaId(): string;
}
