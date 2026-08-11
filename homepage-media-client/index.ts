interface PublicHomepageMediaItem {
  id: string;
  kind: "image" | "video";
  url: string;
  mimeType: string;
  title: string;
  caption?: string;
  altText: string;
  publishedAt: string;
  pinned: boolean;
}

const allowedMime = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4"]);

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  return normalized;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizePublicMediaItems(value: unknown): PublicHomepageMediaItem[] {
  if (!Array.isArray(value)) return [];
  const result: PublicHomepageMediaItem[] = [];
  for (const candidate of value) {
    if (result.length >= 6) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const id = text(item.id, 64);
    const title = text(item.title, 60);
    const altText = text(item.altText, 120);
    const url = safeUrl(item.url);
    const mimeType = typeof item.mimeType === "string" && allowedMime.has(item.mimeType) ? item.mimeType : undefined;
    const kind = item.kind === "image" || item.kind === "video" ? item.kind : undefined;
    const publishedAt = typeof item.publishedAt === "string" && Number.isFinite(Date.parse(item.publishedAt)) ? item.publishedAt : undefined;
    if (!id || !title || !altText || !url || !mimeType || !kind || !publishedAt) continue;
    if ((kind === "video") !== (mimeType === "video/mp4")) continue;
    result.push({
      id,
      kind,
      url,
      mimeType,
      title,
      ...(text(item.caption, 200) ? { caption: text(item.caption, 200) } : {}),
      altText,
      publishedAt,
      pinned: item.pinned === true,
    });
  }
  return result;
}

function mediaNode(documentRef: Document, item: PublicHomepageMediaItem): HTMLElement {
  if (item.kind === "video") {
    const video = documentRef.createElement("video");
    video.src = item.url;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("aria-label", item.altText);
    video.disablePictureInPicture = false;
    return video;
  }
  const image = documentRef.createElement("img");
  image.src = item.url;
  image.alt = item.altText;
  image.loading = "lazy";
  image.decoding = "async";
  return image;
}

export function renderHomepageMedia(container: HTMLElement, items: PublicHomepageMediaItem[]): void {
  const documentRef = container.ownerDocument;
  const list = container.querySelector<HTMLElement>("[data-homepage-media-list]");
  if (!list || items.length === 0) {
    container.hidden = true;
    return;
  }
  list.replaceChildren();
  for (const item of items) {
    const card = documentRef.createElement("article");
    card.className = `daily-media-card${item.pinned ? " is-pinned" : ""}`;
    const frame = documentRef.createElement("div");
    frame.className = "daily-media-frame";
    frame.append(mediaNode(documentRef, item));
    const copy = documentRef.createElement("div");
    copy.className = "daily-media-copy";
    const title = documentRef.createElement("h3");
    title.textContent = item.title;
    copy.append(title);
    if (item.caption) {
      const caption = documentRef.createElement("p");
      caption.textContent = item.caption;
      copy.append(caption);
    }
    card.append(frame, copy);
    list.append(card);
  }
  container.hidden = false;
}

export async function loadHomepageMedia(documentRef: Document = document): Promise<void> {
  const container = documentRef.querySelector<HTMLElement>("[data-homepage-media]");
  if (!container) return;
  const apiBase = container.dataset.apiBase;
  if (!apiBase) {
    container.hidden = true;
    return;
  }
  try {
    const response = await fetch(`${apiBase.replace(/\/$/u, "")}/v1/homepage-media`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("MEDIA_UNAVAILABLE");
    const payload = await response.json() as { data?: unknown };
    const data = payload.data;
    const items = sanitizePublicMediaItems(
      data && typeof data === "object" && !Array.isArray(data) && "items" in data
        ? (data as { items?: unknown }).items
        : data,
    );
    renderHomepageMedia(container, items);
  } catch {
    container.hidden = true;
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void loadHomepageMedia());
  } else {
    void loadHomepageMedia();
  }
}
