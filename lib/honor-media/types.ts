export type HonorMediaKind = "image" | "video";
export type HonorMediaStatus = "uploading" | "draft" | "published" | "deleting";
export type HonorMediaOwner = "liu-qirui" | "tang-yutong" | "coach-team";

export interface HonorMediaItem {
  id: string;
  kind: HonorMediaKind;
  storagePath: string;
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  title: string;
  owner: HonorMediaOwner;
  year: number;
  awardDescription: string;
  altText: string;
  sortOrder: number;
  status: HonorMediaStatus;
  uploadExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  publishedAt?: string;
  version: number;
}

export interface HonorMediaAudit {
  id: string;
  itemId: string;
  action: "upload_intent_created" | "upload_finalized" | "published" | "unpublished" | "updated" | "deleted";
  actorId: string;
  at: string;
}

export interface HonorMediaManifest {
  id: "honor-media-v1";
  schemaVersion: 1;
  version: number;
  items: HonorMediaItem[];
  audit: HonorMediaAudit[];
  updatedAt: string;
}

export interface PublicHonorMediaItem {
  id: string;
  kind: HonorMediaKind;
  url: string;
  mimeType: string;
  title: string;
  owner: HonorMediaOwner;
  year: number;
  awardDescription: string;
  altText: string;
  sortOrder: number;
}

export interface HonorMediaUploadRequest {
  kind: HonorMediaKind;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  title: string;
  owner: HonorMediaOwner;
  year: number;
  awardDescription: string;
  altText: string;
  sortOrder: number;
  expectedManifestVersion: number;
}

export interface HonorMediaMetadataRequest {
  title: string;
  owner: HonorMediaOwner;
  year: number;
  awardDescription: string;
  altText: string;
  sortOrder: number;
}
