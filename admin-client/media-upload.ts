export interface MediaFileLike extends Blob {
  name: string;
  type: string;
  size: number;
}

export interface HomepageMediaAdminApi {
  createMediaUploadIntent(input: Record<string, unknown>): Promise<unknown>;
  finalizeMediaUpload(itemId: string, expectedManifestVersion: number, publish: boolean): Promise<unknown>;
}

export class MediaUploadClientError extends Error {
  readonly code: "INVALID_FILE" | "INVALID_UPLOAD_INTENT" | "UPLOAD_FAILED";

  constructor(code: "INVALID_FILE" | "INVALID_UPLOAD_INTENT" | "UPLOAD_FAILED") {
    super(code);
    this.name = "MediaUploadClientError";
    this.code = code;
  }
}

const allowedHeaders = new Set([
  "authorization",
  "content-type",
  "key",
  "signature",
  "x-cos-meta-fileid",
  "x-cos-security-token",
]);

function uploadHeaders(value: unknown, mimeType: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaUploadClientError("INVALID_UPLOAD_INTENT");
  }
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!allowedHeaders.has(name.toLowerCase()) || typeof headerValue !== "string" || /[\r\n]/u.test(headerValue)) {
      throw new MediaUploadClientError("INVALID_UPLOAD_INTENT");
    }
    result[name] = headerValue;
  }
  const contentType = Object.entries(result).find(([name]) => name.toLowerCase() === "content-type")?.[1];
  if (contentType !== mimeType) throw new MediaUploadClientError("INVALID_UPLOAD_INTENT");
  return result;
}

function uploadUrl(value: unknown): string {
  if (typeof value !== "string") throw new MediaUploadClientError("INVALID_UPLOAD_INTENT");
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") throw new MediaUploadClientError("INVALID_UPLOAD_INTENT");
    return parsed.toString();
  } catch (error) {
    if (error instanceof MediaUploadClientError) throw error;
    throw new MediaUploadClientError("INVALID_UPLOAD_INTENT");
  }
}

function intentFields(value: unknown, mimeType: string): { itemId: string; url: string; headers: Record<string, string> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaUploadClientError("INVALID_UPLOAD_INTENT");
  }
  const response = value as { item?: unknown; upload?: unknown };
  const item = response.item;
  const upload = response.upload;
  if (!item || typeof item !== "object" || Array.isArray(item) || !upload || typeof upload !== "object" || Array.isArray(upload)) {
    throw new MediaUploadClientError("INVALID_UPLOAD_INTENT");
  }
  const itemId = (item as { id?: unknown }).id;
  const method = (upload as { method?: unknown }).method;
  if (typeof itemId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(itemId) || method !== "PUT") {
    throw new MediaUploadClientError("INVALID_UPLOAD_INTENT");
  }
  return {
    itemId,
    url: uploadUrl((upload as { url?: unknown }).url),
    headers: uploadHeaders((upload as { headers?: unknown }).headers, mimeType),
  };
}

export async function uploadHomepageMedia(input: {
  api: HomepageMediaAdminApi;
  file: MediaFileLike;
  title: string;
  caption?: string;
  altText: string;
  mediaDate?: string;
  expectedManifestVersion: number;
  publish: boolean;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const { file } = input;
  const kind = file.type === "video/mp4" ? "video" : "image";
  const allowed = kind === "video"
    ? file.type === "video/mp4" && file.size <= 50 * 1024 * 1024
    : ["image/jpeg", "image/png", "image/webp"].includes(file.type) && file.size <= 8 * 1024 * 1024;
  if (!allowed || file.size < 1) throw new MediaUploadClientError("INVALID_FILE");
  const intent = await input.api.createMediaUploadIntent({
    kind,
    mimeType: file.type,
    sizeBytes: file.size,
    originalName: file.name,
    title: input.title,
    ...(input.caption ? { caption: input.caption } : {}),
    altText: input.altText,
    ...(input.mediaDate ? { mediaDate: input.mediaDate } : {}),
    expectedManifestVersion: input.expectedManifestVersion,
  });
  const upload = intentFields(intent, file.type);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: file,
    });
  } catch {
    throw new MediaUploadClientError("UPLOAD_FAILED");
  }
  if (!response.ok) throw new MediaUploadClientError("UPLOAD_FAILED");
  return input.api.finalizeMediaUpload(
    upload.itemId,
    input.expectedManifestVersion + 1,
    input.publish,
  );
}

export interface HonorMediaAdminApi {
  createHonorMediaUploadIntent(input: Record<string, unknown>): Promise<unknown>;
  finalizeHonorMediaUpload(itemId: string, expectedManifestVersion: number, publish: boolean): Promise<unknown>;
}

export async function uploadHonorMedia(input: {
  api: HonorMediaAdminApi;
  file: MediaFileLike;
  title: string;
  owner: "liu-qirui" | "tang-yutong" | "coach-team";
  year: number;
  awardDescription: string;
  altText: string;
  sortOrder: number;
  expectedManifestVersion: number;
  publish: boolean;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const { file } = input;
  const kind = file.type === "video/mp4" ? "video" : "image";
  const allowed = kind === "video"
    ? file.type === "video/mp4" && file.size <= 50 * 1024 * 1024
    : ["image/jpeg", "image/png", "image/webp"].includes(file.type) && file.size <= 8 * 1024 * 1024;
  if (!allowed || file.size < 1) throw new MediaUploadClientError("INVALID_FILE");
  const intent = await input.api.createHonorMediaUploadIntent({
    kind,
    mimeType: file.type,
    sizeBytes: file.size,
    originalName: file.name,
    title: input.title,
    owner: input.owner,
    year: input.year,
    awardDescription: input.awardDescription,
    altText: input.altText,
    sortOrder: input.sortOrder,
    expectedManifestVersion: input.expectedManifestVersion,
  });
  const upload = intentFields(intent, file.type);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(upload.url, { method: "PUT", headers: upload.headers, body: file });
  } catch {
    throw new MediaUploadClientError("UPLOAD_FAILED");
  }
  if (!response.ok) throw new MediaUploadClientError("UPLOAD_FAILED");
  return input.api.finalizeHonorMediaUpload(upload.itemId, input.expectedManifestVersion + 1, input.publish);
}
