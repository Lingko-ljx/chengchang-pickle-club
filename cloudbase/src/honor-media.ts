import { randomUUID } from "node:crypto";

import { HonorMediaService } from "../../lib/honor-media/honor-media-service.ts";
import type {
  HonorMediaItem,
  HonorMediaManifest,
  HonorMediaMetadataRequest,
  HonorMediaUploadRequest,
  PublicHonorMediaItem,
} from "../../lib/honor-media/types.ts";
import { MediaError } from "../../lib/media/errors.ts";
import { jsonResponse, type HttpResponse } from "./http/response.ts";
import { CloudBaseHonorMediaRepository } from "./repositories/cloudbase-honor-media-repository.ts";
import { CloudBaseHomepageMediaStorage } from "./storage/cloudbase-media-storage.ts";

export interface HonorMediaApiService {
  listAdmin(): Promise<HonorMediaManifest>;
  listPublished(): Promise<PublicHonorMediaItem[]>;
  createUploadIntent(input: HonorMediaUploadRequest, actorId: string): Promise<unknown>;
  finalizeUpload(command: { itemId: string; expectedManifestVersion: number; publish: boolean }, actorId: string): Promise<HonorMediaItem>;
  updateItem(command: { itemId: string; expectedManifestVersion: number } & HonorMediaMetadataRequest, actorId: string): Promise<HonorMediaItem>;
  setPublished(command: { itemId: string; expectedManifestVersion: number; published: boolean }, actorId: string): Promise<HonorMediaItem>;
  deleteItem(command: { itemId: string; expectedManifestVersion: number }, actorId: string): Promise<void>;
}

export function createDefaultHonorMediaService(): HonorMediaApiService {
  return new HonorMediaService(
    new CloudBaseHonorMediaRepository(),
    new CloudBaseHomepageMediaStorage(),
    { mediaId: () => randomUUID() },
  );
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") throw new MediaError("INVALID_MEDIA_INPUT");
  return value;
}
function integer(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (!Number.isSafeInteger(value)) throw new MediaError("INVALID_MEDIA_INPUT");
  return Number(value);
}
function boolean(body: Record<string, unknown>, name: string): boolean {
  const value = body[name];
  if (value !== true && value !== false) throw new MediaError("INVALID_MEDIA_INPUT");
  return value;
}
function metadata(body: Record<string, unknown>): HonorMediaMetadataRequest {
  return {
    title: requiredString(body, "title"),
    owner: requiredString(body, "owner") as HonorMediaMetadataRequest["owner"],
    year: integer(body, "year"),
    awardDescription: requiredString(body, "awardDescription"),
    altText: requiredString(body, "altText"),
    sortOrder: integer(body, "sortOrder"),
  };
}
function itemRoute(path: string): { itemId: string; action?: string } | null {
  const match = /^\/v1\/admin\/honor-media\/([A-Za-z0-9_-]{1,64})(?:\/(finalize|publication))?$/.exec(path);
  return match ? { itemId: match[1], ...(match[2] ? { action: match[2] } : {}) } : null;
}

export async function handlePublicHonorMedia(method: string, path: string, service: HonorMediaApiService): Promise<HttpResponse | null> {
  if (method !== "GET" || path !== "/v1/honor-media") return null;
  return jsonResponse(200, { items: await service.listPublished() }, { "Cache-Control": "no-store" });
}

export async function handleAdminHonorMedia(input: {
  method: string;
  path: string;
  body: Record<string, unknown>;
  actorId: string;
  service: HonorMediaApiService;
}): Promise<HttpResponse | null> {
  const { method, path, body, actorId, service } = input;
  if (method === "GET" && path === "/v1/admin/honor-media") return jsonResponse(200, await service.listAdmin());
  if (method === "POST" && path === "/v1/admin/honor-media/upload-intents") {
    return jsonResponse(201, await service.createUploadIntent({
      kind: requiredString(body, "kind") as HonorMediaUploadRequest["kind"],
      mimeType: requiredString(body, "mimeType"),
      sizeBytes: integer(body, "sizeBytes"),
      originalName: requiredString(body, "originalName"),
      ...metadata(body),
      expectedManifestVersion: integer(body, "expectedManifestVersion"),
    }, actorId));
  }
  const route = itemRoute(path);
  if (!route) return null;
  const expectedManifestVersion = integer(body, "expectedManifestVersion");
  if (method === "POST" && route.action === "finalize") {
    return jsonResponse(200, await service.finalizeUpload({ itemId: route.itemId, expectedManifestVersion, publish: boolean(body, "publish") }, actorId));
  }
  if (method === "PUT" && route.action === "publication") {
    return jsonResponse(200, await service.setPublished({ itemId: route.itemId, expectedManifestVersion, published: boolean(body, "published") }, actorId));
  }
  if (method === "PUT" && !route.action) {
    return jsonResponse(200, await service.updateItem({ itemId: route.itemId, expectedManifestVersion, ...metadata(body) }, actorId));
  }
  if (method === "DELETE" && !route.action) {
    await service.deleteItem({ itemId: route.itemId, expectedManifestVersion }, actorId);
    return jsonResponse(200, { deleted: true });
  }
  return null;
}
