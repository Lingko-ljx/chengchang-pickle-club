import { MediaError } from "./errors.ts";
import type { HomepageMediaKind, MediaUploadRequest } from "./types.ts";

const IMAGE_LIMIT = 8 * 1024 * 1024;
const VIDEO_LIMIT = 50 * 1024 * 1024;
const MIME_RULES: Record<HomepageMediaKind, ReadonlySet<string>> = {
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/mp4"]),
};
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

function length(value: string): number {
  return Array.from(value).length;
}

function requiredText(value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new MediaError("INVALID_MEDIA_INPUT");
  const normalized = value.trim();
  if (!normalized || length(normalized) > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return normalized;
}

function optionalText(value: unknown, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, maximum);
}

export function validateMediaDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return value;
}

export function validateMediaUpload(input: MediaUploadRequest): Omit<MediaUploadRequest, "expectedManifestVersion"> & { extension: string } {
  if (input.kind !== "image" && input.kind !== "video") {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  if (!MIME_RULES[input.kind].has(input.mimeType)) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  const maximum = input.kind === "image" ? IMAGE_LIMIT : VIDEO_LIMIT;
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > maximum) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  const originalName = requiredText(input.originalName, 255);
  if (/[\\/]/u.test(originalName) || originalName === "." || originalName === "..") {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return {
    kind: input.kind,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    originalName,
    title: requiredText(input.title, 60),
    caption: optionalText(input.caption, 200),
    altText: requiredText(input.altText, 120),
    ...(input.mediaDate === undefined ? {} : { mediaDate: validateMediaDate(input.mediaDate) }),
    extension: EXTENSIONS[input.mimeType],
  };
}

export function validateManifestVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return Number(value);
}
