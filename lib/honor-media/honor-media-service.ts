import { MediaError } from "../media/errors.ts";
import type { HonorMediaRepository, HonorMediaStorage, HonorMediaClock } from "./ports.ts";
import type {
  HonorMediaAudit,
  HonorMediaItem,
  HonorMediaManifest,
  HonorMediaMetadataRequest,
  HonorMediaUploadRequest,
  PublicHonorMediaItem,
} from "./types.ts";
import { validateHonorMetadata, validateHonorUpload, validateManifestVersion } from "./validation.ts";

const systemClock: HonorMediaClock = { now: () => new Date() };
const MAX_ITEMS = 60;
const MAX_PUBLISHED = 12;
const PUBLIC_LIMIT = 12;
const AUDIT_LIMIT = 150;

function canonicalActor(actorId: string): string {
  const value = actorId.trim();
  if (!value || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return value;
}

function audit(itemId: string, action: HonorMediaAudit["action"], actorId: string, at: string): HonorMediaAudit {
  return { id: `${itemId}__${action}__${at}`, itemId, action, actorId, at };
}

function nextManifest(current: HonorMediaManifest, items: HonorMediaItem[], entry: HonorMediaAudit, at: string): HonorMediaManifest {
  return {
    ...current,
    version: current.version + 1,
    items,
    audit: [...current.audit, entry].slice(-AUDIT_LIMIT),
    updatedAt: at,
  };
}

function itemById(manifest: HonorMediaManifest, itemId: string): HonorMediaItem {
  const item = manifest.items.find(({ id }) => id === itemId);
  if (!item) throw new MediaError("MEDIA_NOT_FOUND");
  return item;
}

export class HonorMediaService {
  private readonly repository: HonorMediaRepository;
  private readonly storage: HonorMediaStorage;
  private readonly clock: HonorMediaClock;
  private readonly ids: { mediaId(): string };

  constructor(
    repository: HonorMediaRepository,
    storage: HonorMediaStorage,
    dependencies: { clock?: HonorMediaClock; mediaId(): string },
  ) {
    this.repository = repository;
    this.storage = storage;
    this.clock = dependencies.clock ?? systemClock;
    this.ids = dependencies;
  }

  listAdmin(): Promise<HonorMediaManifest> {
    return this.repository.read();
  }

  async listPublished(): Promise<PublicHonorMediaItem[]> {
    const manifest = await this.repository.read();
    const visible = manifest.items
      .filter((item) => item.status === "published" && item.publishedAt)
      .sort((left, right) => left.sortOrder - right.sortOrder || right.year - left.year || left.id.localeCompare(right.id))
      .slice(0, PUBLIC_LIMIT);
    const urls = await this.storage.publicUrls(visible.map(({ fileId }) => fileId));
    return visible.flatMap((item) => {
      const url = urls[item.fileId];
      return url ? [{
        id: item.id,
        kind: item.kind,
        url,
        mimeType: item.mimeType,
        title: item.title,
        owner: item.owner,
        year: item.year,
        awardDescription: item.awardDescription,
        altText: item.altText,
        sortOrder: item.sortOrder,
      }] : [];
    });
  }

  async createUploadIntent(input: HonorMediaUploadRequest, actorId: string) {
    const expectedVersion = validateManifestVersion(input.expectedManifestVersion);
    const value = validateHonorUpload(input);
    const actor = canonicalActor(actorId);
    const manifest = await this.repository.read();
    if (manifest.version !== expectedVersion) throw new MediaError("MEDIA_CONFLICT");
    if (manifest.items.length >= MAX_ITEMS) throw new MediaError("MEDIA_LIMIT_REACHED");
    const id = this.ids.mediaId();
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id) || manifest.items.some((item) => item.id === id)) {
      throw new MediaError("MEDIA_CONFLICT");
    }
    const now = this.clock.now();
    const at = now.toISOString();
    const uploadExpiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const storagePath = `honor-media/${value.year}/${id}.${value.extension}`;
    const upload = await this.storage.createUpload({
      storagePath,
      mimeType: value.mimeType,
      sizeBytes: value.sizeBytes,
      expiresAt: uploadExpiresAt,
    });
    const item: HonorMediaItem = {
      id,
      kind: value.kind,
      storagePath,
      fileId: upload.fileId,
      mimeType: value.mimeType,
      sizeBytes: value.sizeBytes,
      originalName: value.originalName,
      title: value.title,
      owner: value.owner,
      year: value.year,
      awardDescription: value.awardDescription,
      altText: value.altText,
      sortOrder: value.sortOrder,
      status: "uploading",
      uploadExpiresAt,
      createdAt: at,
      updatedAt: at,
      createdBy: actor,
      version: 1,
    };
    await this.repository.replace(expectedVersion, nextManifest(
      manifest,
      [...manifest.items, item],
      audit(id, "upload_intent_created", actor, at),
      at,
    ));
    return { item: structuredClone(item), upload };
  }

  async finalizeUpload(command: { itemId: string; expectedManifestVersion: number; publish: boolean }, actorId: string): Promise<HonorMediaItem> {
    const actor = canonicalActor(actorId);
    const manifest = await this.checkedManifest(command.expectedManifestVersion);
    const item = itemById(manifest, command.itemId);
    if (item.status !== "uploading") throw new MediaError("MEDIA_CONFLICT");
    const info = await this.storage.inspect(item.fileId);
    if (!info.exists) throw new MediaError("MEDIA_UPLOAD_INCOMPLETE");
    if (info.mimeType !== item.mimeType || info.sizeBytes !== item.sizeBytes) throw new MediaError("MEDIA_UPLOAD_MISMATCH");
    if (command.publish && manifest.items.filter(({ status }) => status === "published").length >= MAX_PUBLISHED) {
      throw new MediaError("MEDIA_LIMIT_REACHED");
    }
    const at = this.clock.now().toISOString();
    const updated: HonorMediaItem = {
      ...item,
      status: command.publish ? "published" : "draft",
      ...(command.publish ? { publishedAt: at } : {}),
      updatedAt: at,
      version: item.version + 1,
    };
    await this.replaceItem(manifest, updated, audit(item.id, command.publish ? "published" : "upload_finalized", actor, at), at);
    return structuredClone(updated);
  }

  async updateItem(command: { itemId: string; expectedManifestVersion: number } & HonorMediaMetadataRequest, actorId: string): Promise<HonorMediaItem> {
    const actor = canonicalActor(actorId);
    const metadata = validateHonorMetadata(command);
    const manifest = await this.checkedManifest(command.expectedManifestVersion);
    const item = itemById(manifest, command.itemId);
    if (item.status !== "draft" && item.status !== "published") throw new MediaError("MEDIA_CONFLICT");
    const at = this.clock.now().toISOString();
    const updated = { ...item, ...metadata, updatedAt: at, version: item.version + 1 };
    await this.replaceItem(manifest, updated, audit(item.id, "updated", actor, at), at);
    return structuredClone(updated);
  }

  async setPublished(command: { itemId: string; expectedManifestVersion: number; published: boolean }, actorId: string): Promise<HonorMediaItem> {
    const actor = canonicalActor(actorId);
    const manifest = await this.checkedManifest(command.expectedManifestVersion);
    const item = itemById(manifest, command.itemId);
    if (item.status !== "draft" && item.status !== "published") throw new MediaError("MEDIA_CONFLICT");
    if (command.published && item.status !== "published" && manifest.items.filter(({ status }) => status === "published").length >= MAX_PUBLISHED) {
      throw new MediaError("MEDIA_LIMIT_REACHED");
    }
    const at = this.clock.now().toISOString();
    const base = { ...item };
    delete base.publishedAt;
    const updated: HonorMediaItem = {
      ...base,
      status: command.published ? "published" : "draft",
      ...(command.published ? { publishedAt: at } : {}),
      updatedAt: at,
      version: item.version + 1,
    };
    await this.replaceItem(manifest, updated, audit(item.id, command.published ? "published" : "unpublished", actor, at), at);
    return structuredClone(updated);
  }

  async deleteItem(command: { itemId: string; expectedManifestVersion: number }, actorId: string): Promise<void> {
    const actor = canonicalActor(actorId);
    const manifest = await this.checkedManifest(command.expectedManifestVersion);
    const item = itemById(manifest, command.itemId);
    let current = manifest;
    if (item.status !== "deleting") {
      const at = this.clock.now().toISOString();
      const hidden = { ...item, status: "deleting" as const, publishedAt: undefined, updatedAt: at, version: item.version + 1 };
      await this.replaceItem(manifest, hidden, audit(item.id, "unpublished", actor, at), at);
      current = await this.repository.read();
    }
    await this.storage.delete(item.fileId);
    const at = this.clock.now().toISOString();
    const final = nextManifest(current, current.items.filter(({ id }) => id !== item.id), audit(item.id, "deleted", actor, at), at);
    await this.repository.replace(current.version, final);
  }

  private async checkedManifest(expected: unknown): Promise<HonorMediaManifest> {
    const version = validateManifestVersion(expected);
    const manifest = await this.repository.read();
    if (manifest.version !== version) throw new MediaError("MEDIA_CONFLICT");
    return manifest;
  }

  private async replaceItem(manifest: HonorMediaManifest, updated: HonorMediaItem, entry: HonorMediaAudit, at: string): Promise<void> {
    await this.repository.replace(manifest.version, nextManifest(
      manifest,
      manifest.items.map((item) => item.id === updated.id ? updated : item),
      entry,
      at,
    ));
  }
}
