import { MediaError } from "../media/errors.ts";
import type {
  HonorMediaKind,
  HonorMediaMetadataRequest,
  HonorMediaOwner,
  HonorMediaUploadRequest,
} from "./types.ts";

const IMAGE_LIMIT = 8 * 1024 * 1024;
const VIDEO_LIMIT = 50 * 1024 * 1024;
const OWNERS = new Set<HonorMediaOwner>(["liu-qirui", "tang-yutong", "coach-team"]);
const MIME_RULES: Record<HonorMediaKind, ReadonlySet<string>> = {
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/mp4"]),
};
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new MediaError("INVALID_MEDIA_INPUT");
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return normalized;
}

function owner(value: unknown): HonorMediaOwner {
  if (typeof value !== "string" || !OWNERS.has(value as HonorMediaOwner)) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return value as HonorMediaOwner;
}

function year(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1900 || Number(value) > 2100) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return Number(value);
}

function sortOrder(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 9999) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return Number(value);
}

export function validateHonorMetadata(input: HonorMediaMetadataRequest): HonorMediaMetadataRequest {
  return {
    title: text(input.title, 80),
    owner: owner(input.owner),
    year: year(input.year),
    awardDescription: text(input.awardDescription, 300),
    altText: text(input.altText, 160),
    sortOrder: sortOrder(input.sortOrder),
  };
}

export function validateHonorUpload(input: HonorMediaUploadRequest): Omit<HonorMediaUploadRequest, "expectedManifestVersion"> & { extension: string } {
  if (input.kind !== "image" && input.kind !== "video") throw new MediaError("INVALID_MEDIA_INPUT");
  if (!MIME_RULES[input.kind].has(input.mimeType)) throw new MediaError("INVALID_MEDIA_INPUT");
  const maximum = input.kind === "image" ? IMAGE_LIMIT : VIDEO_LIMIT;
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > maximum) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  const originalName = text(input.originalName, 255);
  if (/[\\/]/u.test(originalName) || originalName === "." || originalName === "..") {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return {
    kind: input.kind,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    originalName,
    ...validateHonorMetadata(input),
    extension: EXTENSIONS[input.mimeType],
  };
}

export function validateManifestVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new MediaError("INVALID_MEDIA_INPUT");
  return Number(value);
}
