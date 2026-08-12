export type HomepageMediaKind = "image" | "video";
export type HomepageMediaStatus = "uploading" | "draft" | "published" | "deleting";

export interface HomepageMediaItem {
  id: string;
  kind: HomepageMediaKind;
  storagePath: string;
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  title: string;
  caption?: string;
  altText: string;
  mediaDate?: string;
  status: HomepageMediaStatus;
  uploadExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  publishedAt?: string;
  pinnedAt?: string;
  version: number;
}

export interface HomepageMediaAudit {
  id: string;
  itemId: string;
  action: "upload_intent_created" | "upload_finalized" | "published" | "unpublished" | "pinned" | "unpinned" | "deleted";
  actorId: string;
  at: string;
}

export interface HomepageMediaManifest {
  id: "homepage-media-v1";
  schemaVersion: 1;
  version: number;
  items: HomepageMediaItem[];
  audit: HomepageMediaAudit[];
  updatedAt: string;
}

export interface PublicHomepageMediaItem {
  id: string;
  kind: HomepageMediaKind;
  url: string;
  mimeType: string;
  title: string;
  caption?: string;
  altText: string;
  mediaDate: string;
  publishedAt: string;
  pinned: boolean;
}

export interface MediaUploadRequest {
  kind: HomepageMediaKind;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  title: string;
  caption?: string;
  altText: string;
  mediaDate?: string;
  expectedManifestVersion: number;
}

export interface PublicHomepageMediaArchive {
  items: PublicHomepageMediaItem[];
  availableDates: string[];
  selectedDate: string | null;
  isToday: boolean;
}

export interface SignedMediaUpload {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
  fileId: string;
}
