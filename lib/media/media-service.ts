import { MediaError } from "./errors.ts";
import type {
  HomepageMediaRepository,
  HomepageMediaStorage,
  MediaClock,
  MediaIdProvider,
} from "./ports.ts";
import type {
  HomepageMediaAudit,
  HomepageMediaItem,
  HomepageMediaManifest,
  MediaUploadRequest,
  PublicHomepageMediaArchive,
  PublicHomepageMediaItem,
} from "./types.ts";
import { validateManifestVersion, validateMediaDate, validateMediaUpload } from "./validation.ts";

const systemClock: MediaClock = { now: () => new Date() };
const MAX_ITEMS = 400;
const MAX_PUBLISHED_PER_DATE = 6;
const PUBLIC_LIMIT = 6;
const AVAILABLE_DATE_LIMIT = MAX_ITEMS;
const AUDIT_LIMIT = 100;

function audit(itemId: string, action: HomepageMediaAudit["action"], actorId: string, at: string): HomepageMediaAudit {
  return { id: `${itemId}__${action}__${at}`, itemId, action, actorId, at };
}

function canonicalActor(actorId: string): string {
  const normalized = actorId.trim();
  if (!normalized || normalized.length > 64 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new MediaError("INVALID_MEDIA_INPUT");
  }
  return normalized;
}

function nextManifest(
  current: HomepageMediaManifest,
  items: HomepageMediaItem[],
  entry: HomepageMediaAudit,
  at: string,
): HomepageMediaManifest {
  return {
    ...current,
    version: current.version + 1,
    items,
    audit: [...current.audit, entry].slice(-AUDIT_LIMIT),
    updatedAt: at,
  };
}

function itemById(manifest: HomepageMediaManifest, itemId: string): HomepageMediaItem {
  const item = manifest.items.find(({ id }) => id === itemId);
  if (!item) throw new MediaError("MEDIA_NOT_FOUND");
  return item;
}

function shanghaiDate(instant: Date | string): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new MediaError("INVALID_MEDIA_INPUT");
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function itemMediaDate(item: HomepageMediaItem): string {
  if (item.mediaDate) {
    try { return validateMediaDate(item.mediaDate); } catch { /* legacy fallback */ }
  }
  return shanghaiDate(item.publishedAt ?? item.createdAt);
}

function publicOrder(left: HomepageMediaItem, right: HomepageMediaItem): number {
  const pinned = Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt));
  return pinned || String(right.pinnedAt ?? right.publishedAt).localeCompare(String(left.pinnedAt ?? left.publishedAt)) || left.id.localeCompare(right.id);
}

export class HomepageMediaService {
  private readonly repository: HomepageMediaRepository;
  private readonly storage: HomepageMediaStorage;
  private readonly clock: MediaClock;
  private readonly ids: MediaIdProvider;

  constructor(
    repository: HomepageMediaRepository,
    storage: HomepageMediaStorage,
    dependencies: { clock?: MediaClock; mediaId(): string },
  ) {
    this.repository = repository;
    this.storage = storage;
    this.clock = dependencies.clock ?? systemClock;
    this.ids = dependencies;
  }

  async listAdmin(): Promise<HomepageMediaManifest> {
    return this.repository.read();
  }

  async listPublished(): Promise<PublicHomepageMediaItem[]> {
    return (await this.listPublicArchive({ now: this.clock.now() })).items;
  }

  async listPublicArchive(input: { date?: string; now?: Date } = {}): Promise<PublicHomepageMediaArchive> {
    const manifest = await this.repository.read();
    const today = shanghaiDate(input.now ?? this.clock.now());
    const published = manifest.items.filter(
      (item) => item.status === "published" && item.publishedAt && itemMediaDate(item) <= today,
    );
    const availableDates = [...new Set(published.map(itemMediaDate))]
      .sort((left, right) => right.localeCompare(left))
      .slice(0, AVAILABLE_DATE_LIMIT);
    const requested = input.date === undefined ? undefined : validateMediaDate(input.date);
    if (requested && requested > today) throw new MediaError("INVALID_MEDIA_INPUT");
    const selectedDate = requested ?? (availableDates.includes(today)
      ? today
      : availableDates.find((date) => date <= today) ?? availableDates[0] ?? null);
    const visible = selectedDate === null ? [] : published
      .filter((item) => itemMediaDate(item) === selectedDate)
      .sort(publicOrder)
      .slice(0, PUBLIC_LIMIT);
    const urls = await this.storage.publicUrls(visible.map(({ fileId }) => fileId));
    const result: PublicHomepageMediaItem[] = [];
    for (const item of visible) {
      const url = urls[item.fileId];
      if (!url) continue;
      result.push({
        id: item.id,
        kind: item.kind,
        url,
        mimeType: item.mimeType,
        title: item.title,
        ...(item.caption ? { caption: item.caption } : {}),
        altText: item.altText,
        mediaDate: itemMediaDate(item),
        publishedAt: item.publishedAt!,
        pinned: Boolean(item.pinnedAt),
      });
    }
    return { items: result, availableDates, selectedDate, isToday: selectedDate === today };
  }

  async createUploadIntent(input: MediaUploadRequest, actorId: string) {
    const expectedVersion = validateManifestVersion(input.expectedManifestVersion);
    const value = validateMediaUpload(input);
    const actor = canonicalActor(actorId);
    const now = this.clock.now().toISOString();
    const mediaDate = value.mediaDate ?? shanghaiDate(now);
    const manifest = await this.repository.read();
    if (manifest.version !== expectedVersion) throw new MediaError("MEDIA_CONFLICT");
    if (manifest.items.length >= MAX_ITEMS) throw new MediaError("MEDIA_LIMIT_REACHED");
    const id = this.ids.mediaId();
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id) || manifest.items.some((item) => item.id === id)) {
      throw new MediaError("MEDIA_CONFLICT");
    }
    const month = now.slice(0, 7).replace("-", "/");
    const storagePath = `daily-media/${month}/${id}.${value.extension}`;
    const uploadExpiresAt = new Date(this.clock.now().getTime() + 10 * 60 * 1000).toISOString();
    const upload = await this.storage.createUpload({
      storagePath,
      mimeType: value.mimeType,
      sizeBytes: value.sizeBytes,
      expiresAt: uploadExpiresAt,
    });
    const item: HomepageMediaItem = {
      id,
      kind: value.kind,
      storagePath,
      fileId: upload.fileId,
      mimeType: value.mimeType,
      sizeBytes: value.sizeBytes,
      originalName: value.originalName,
      title: value.title,
      ...(value.caption ? { caption: value.caption } : {}),
      altText: value.altText,
      mediaDate,
      status: "uploading",
      uploadExpiresAt,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      version: 1,
    };
    const next = nextManifest(manifest, [...manifest.items, item], audit(id, "upload_intent_created", actor, now), now);
    await this.repository.replace(expectedVersion, next);
    return { item: structuredClone(item), upload };
  }

  async finalizeUpload(command: { itemId: string; expectedManifestVersion: number; publish: boolean }, actorId: string): Promise<HomepageMediaItem> {
    const actor = canonicalActor(actorId);
    const manifest = await this.checkedManifest(command.expectedManifestVersion);
    const item = itemById(manifest, command.itemId);
    if (item.status !== "uploading") throw new MediaError("MEDIA_CONFLICT");
    const info = await this.storage.inspect(item.fileId);
    if (!info.exists) throw new MediaError("MEDIA_UPLOAD_INCOMPLETE");
    if (info.mimeType !== item.mimeType || info.sizeBytes !== item.sizeBytes) {
      throw new MediaError("MEDIA_UPLOAD_MISMATCH");
    }
    if (command.publish && manifest.items.filter((candidate) => candidate.status === "published" && itemMediaDate(candidate) === itemMediaDate(item)).length >= MAX_PUBLISHED_PER_DATE) {
      throw new MediaError("MEDIA_LIMIT_REACHED");
    }
    const now = this.clock.now().toISOString();
    const updated: HomepageMediaItem = {
      ...item,
      status: command.publish ? "published" : "draft",
      ...(command.publish ? { publishedAt: now } : {}),
      updatedAt: now,
      version: item.version + 1,
    };
    const action = command.publish ? "published" : "upload_finalized";
    await this.replaceItem(manifest, updated, audit(item.id, action, actor, now), now);
    return structuredClone(updated);
  }

  async setPublished(command: { itemId: string; expectedManifestVersion: number; published: boolean }, actorId: string): Promise<HomepageMediaItem> {
    const actor = canonicalActor(actorId);
    const manifest = await this.checkedManifest(command.expectedManifestVersion);
    const item = itemById(manifest, command.itemId);
    if (item.status !== "draft" && item.status !== "published") throw new MediaError("MEDIA_CONFLICT");
    if (command.published && item.status !== "published" && manifest.items.filter((candidate) => candidate.status === "published" && itemMediaDate(candidate) === itemMediaDate(item)).length >= MAX_PUBLISHED_PER_DATE) {
      throw new MediaError("MEDIA_LIMIT_REACHED");
    }
    const now = this.clock.now().toISOString();
    const baseItem = { ...item };
    delete baseItem.publishedAt;
    delete baseItem.pinnedAt;
    const updated: HomepageMediaItem = {
      ...baseItem,
      status: command.published ? "published" : "draft",
      ...(command.published ? { publishedAt: now } : {}),
      updatedAt: now,
      version: item.version + 1,
    };
    await this.replaceItem(manifest, updated, audit(item.id, command.published ? "published" : "unpublished", actor, now), now);
    return structuredClone(updated);
  }

  async setPinned(command: { itemId: string; expectedManifestVersion: number; pinned: boolean }, actorId: string): Promise<HomepageMediaItem> {
    const actor = canonicalActor(actorId);
    const manifest = await this.checkedManifest(command.expectedManifestVersion);
    const item = itemById(manifest, command.itemId);
    if (item.status !== "published") throw new MediaError("MEDIA_CONFLICT");
    const now = this.clock.now().toISOString();
    const items = manifest.items.map((candidate) => {
      if (candidate.id === item.id) {
        return { ...candidate, pinnedAt: command.pinned ? now : undefined, updatedAt: now, version: candidate.version + 1 };
      }
      if (command.pinned && candidate.pinnedAt) {
        return { ...candidate, pinnedAt: undefined, updatedAt: now, version: candidate.version + 1 };
      }
      return candidate;
    });
    const updated = items.find(({ id }) => id === item.id)!;
    const next = nextManifest(manifest, items, audit(item.id, command.pinned ? "pinned" : "unpinned", actor, now), now);
    await this.repository.replace(manifest.version, next);
    return structuredClone(updated);
  }

  async deleteItem(command: { itemId: string; expectedManifestVersion: number }, actorId: string): Promise<void> {
    const actor = canonicalActor(actorId);
    const manifest = await this.checkedManifest(command.expectedManifestVersion);
    const item = itemById(manifest, command.itemId);
    const now = this.clock.now().toISOString();
    const deleting = { ...item, status: "deleting" as const, pinnedAt: undefined, publishedAt: undefined, updatedAt: now, version: item.version + 1 };
    await this.replaceItem(manifest, deleting, audit(item.id, "unpublished", actor, now), now);
    await this.storage.delete(item.fileId);
    const latest = await this.repository.read();
    const final = nextManifest(latest, latest.items.filter(({ id }) => id !== item.id), audit(item.id, "deleted", actor, now), now);
    await this.repository.replace(latest.version, final);
  }

  private async checkedManifest(expected: unknown): Promise<HomepageMediaManifest> {
    const version = validateManifestVersion(expected);
    const manifest = await this.repository.read();
    if (manifest.version !== version) throw new MediaError("MEDIA_CONFLICT");
    return manifest;
  }

  private async replaceItem(manifest: HomepageMediaManifest, updated: HomepageMediaItem, entry: HomepageMediaAudit, at: string): Promise<void> {
    const next = nextManifest(manifest, manifest.items.map((item) => item.id === updated.id ? updated : item), entry, at);
    await this.repository.replace(manifest.version, next);
  }
}
