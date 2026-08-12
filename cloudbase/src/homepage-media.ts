import { randomUUID } from "node:crypto";

import { HomepageMediaService } from "../../lib/media/media-service.ts";
import type {
  HomepageMediaItem,
  HomepageMediaManifest,
  MediaUploadRequest,
  PublicHomepageMediaItem,
  PublicHomepageMediaArchive,
} from "../../lib/media/types.ts";
import { MediaError } from "../../lib/media/errors.ts";
import { jsonResponse, type HttpResponse } from "./http/response.ts";
import { CloudBaseHomepageMediaRepository } from "./repositories/cloudbase-media-repository.ts";
import { CloudBaseHomepageMediaStorage } from "./storage/cloudbase-media-storage.ts";

export interface HomepageMediaApiService {
  listAdmin(): Promise<HomepageMediaManifest>;
  listPublished(): Promise<PublicHomepageMediaItem[]>;
  listPublicArchive(input?: { date?: string; now?: Date }): Promise<PublicHomepageMediaArchive>;
  createUploadIntent(input: MediaUploadRequest, actorId: string): Promise<unknown>;
  finalizeUpload(command: { itemId: string; expectedManifestVersion: number; publish: boolean }, actorId: string): Promise<HomepageMediaItem>;
  setPublished(command: { itemId: string; expectedManifestVersion: number; published: boolean }, actorId: string): Promise<HomepageMediaItem>;
  setPinned(command: { itemId: string; expectedManifestVersion: number; pinned: boolean }, actorId: string): Promise<HomepageMediaItem>;
  deleteItem(command: { itemId: string; expectedManifestVersion: number }, actorId: string): Promise<void>;
}

export function createDefaultHomepageMediaService(): HomepageMediaApiService {
  return new HomepageMediaService(
    new CloudBaseHomepageMediaRepository(),
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

function itemRoute(path: string): { itemId: string; action?: string } | null {
  const match = /^\/v1\/admin\/homepage-media\/([A-Za-z0-9_-]{1,64})(?:\/(finalize|publication|pin|delete))?$/.exec(path);
  return match ? { itemId: match[1], ...(match[2] ? { action: match[2] } : {}) } : null;
}

export async function handlePublicHomepageMedia(
  method: string,
  path: string,
  service: HomepageMediaApiService,
  date?: string,
  now?: Date,
): Promise<HttpResponse | null> {
  if (method !== "GET" || path !== "/v1/homepage-media") return null;
  if (typeof service.listPublicArchive !== "function") {
    return jsonResponse(200, { items: await service.listPublished() }, { "Cache-Control": "no-store" });
  }
  return jsonResponse(200, await service.listPublicArchive({ ...(date ? { date } : {}), ...(now ? { now } : {}) }), { "Cache-Control": "no-store" });
}

export async function handleAdminHomepageMedia(input: {
  method: string;
  path: string;
  body: Record<string, unknown>;
  actorId: string;
  service: HomepageMediaApiService;
}): Promise<HttpResponse | null> {
  const { method, path, body, actorId, service } = input;
  if (method === "GET" && path === "/v1/admin/homepage-media") {
    return jsonResponse(200, await service.listAdmin());
  }
  if (method === "POST" && path === "/v1/admin/homepage-media/upload-intents") {
    const request: MediaUploadRequest = {
      kind: requiredString(body, "kind") as MediaUploadRequest["kind"],
      mimeType: requiredString(body, "mimeType"),
      sizeBytes: integer(body, "sizeBytes"),
      originalName: requiredString(body, "originalName"),
      title: requiredString(body, "title"),
      ...(typeof body.caption === "string" ? { caption: body.caption } : {}),
      altText: requiredString(body, "altText"),
      ...(typeof body.mediaDate === "string" ? { mediaDate: body.mediaDate } : {}),
      expectedManifestVersion: integer(body, "expectedManifestVersion"),
    };
    return jsonResponse(201, await service.createUploadIntent(request, actorId));
  }
  const route = itemRoute(path);
  if (!route) return null;
  const expectedManifestVersion = integer(body, "expectedManifestVersion");
  if (method === "POST" && route.action === "finalize") {
    return jsonResponse(200, await service.finalizeUpload({
      itemId: route.itemId,
      expectedManifestVersion,
      publish: boolean(body, "publish"),
    }, actorId));
  }
  if (method === "PUT" && route.action === "publication") {
    return jsonResponse(200, await service.setPublished({
      itemId: route.itemId,
      expectedManifestVersion,
      published: boolean(body, "published"),
    }, actorId));
  }
  if (method === "PUT" && route.action === "pin") {
    return jsonResponse(200, await service.setPinned({
      itemId: route.itemId,
      expectedManifestVersion,
      pinned: boolean(body, "pinned"),
    }, actorId));
  }
  if (method === "POST" && route.action === "delete") {
    await service.deleteItem({ itemId: route.itemId, expectedManifestVersion }, actorId);
    return jsonResponse(200, { deleted: true });
  }
  return null;
}
