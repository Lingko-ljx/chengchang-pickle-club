interface PublicHonorMediaItem {
  id: string;
  kind: "image" | "video";
  url: string;
  mimeType: string;
  title: string;
  owner: "liu-qirui" | "tang-yutong" | "coach-team";
  year: number;
  awardDescription: string;
  altText: string;
  sortOrder: number;
}

const allowedMime = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4"]);
const allowedOwners = new Set(["liu-qirui", "tang-yutong", "coach-team"]);

function cleanText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  return normalized;
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizePublicHonorMediaItems(value: unknown): PublicHonorMediaItem[] {
  if (!Array.isArray(value)) return [];
  const result: PublicHonorMediaItem[] = [];
  for (const candidate of value) {
    if (result.length >= 12) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const id = cleanText(item.id, 64);
    const title = cleanText(item.title, 80);
    const awardDescription = cleanText(item.awardDescription, 160);
    const altText = cleanText(item.altText, 160);
    const url = safeHttpsUrl(item.url);
    const mimeType = typeof item.mimeType === "string" && allowedMime.has(item.mimeType) ? item.mimeType : undefined;
    const kind = item.kind === "image" || item.kind === "video" ? item.kind : undefined;
    const owner = typeof item.owner === "string" && allowedOwners.has(item.owner)
      ? item.owner as PublicHonorMediaItem["owner"]
      : undefined;
    const year = Number.isSafeInteger(item.year) && Number(item.year) >= 2000 && Number(item.year) <= 2100
      ? Number(item.year)
      : undefined;
    const sortOrder = Number.isSafeInteger(item.sortOrder) && Number(item.sortOrder) >= 0
      ? Number(item.sortOrder)
      : undefined;
    if (!id || !title || !awardDescription || !altText || !url || !mimeType || !kind || !owner || year === undefined || sortOrder === undefined) continue;
    if ((kind === "video") !== (mimeType === "video/mp4")) continue;
    result.push({ id, kind, url, mimeType, title, owner, year, awardDescription, altText, sortOrder });
  }
  return result;
}

function ownerLabel(owner: PublicHonorMediaItem["owner"]): string {
  if (owner === "liu-qirui") return "刘栖睿";
  if (owner === "tang-yutong") return "唐语彤";
  return "教练团队";
}

function mediaNode(documentRef: Document, item: PublicHonorMediaItem): HTMLElement {
  if (item.kind === "video") {
    const video = documentRef.createElement("video");
    video.src = item.url;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("aria-label", item.altText);
    return video;
  }
  const image = documentRef.createElement("img");
  image.src = item.url;
  image.alt = item.altText;
  image.loading = "lazy";
  image.decoding = "async";
  return image;
}

function fallbackSignature(item: PublicHonorMediaItem): string {
  return `${item.owner}|${item.year}|${item.title}`.toLocaleLowerCase("zh-CN");
}

export function renderHonorMedia(container: HTMLElement, items: PublicHonorMediaItem[]): void {
  const documentRef = container.ownerDocument;
  const list = container.querySelector<HTMLElement>("[data-honor-media-list]");
  if (!list || items.length === 0) return;

  list.querySelectorAll(".honor-media-card.is-dynamic").forEach((card) => card.remove());
  const firstFallback = list.querySelector("[data-honor-fallback-key]");
  const dynamicSignatures = new Set<string>();
  for (const item of items) {
    dynamicSignatures.add(fallbackSignature(item));
    const card = documentRef.createElement("figure");
    card.className = "honor-media-card is-dynamic";
    card.dataset.honorMediaId = item.id;
    const frame = documentRef.createElement("div");
    frame.className = "honor-media-frame";
    frame.append(mediaNode(documentRef, item));
    const caption = documentRef.createElement("figcaption");
    const meta = documentRef.createElement("span");
    meta.textContent = `${item.year} · ${ownerLabel(item.owner)}`;
    const title = documentRef.createElement("h3");
    title.textContent = item.title;
    const description = documentRef.createElement("p");
    description.textContent = item.awardDescription;
    caption.append(meta, title, description);
    card.append(frame, caption);
    list.insertBefore(card, firstFallback);
  }

  list.querySelectorAll<HTMLElement>("[data-honor-fallback-key]").forEach((card) => {
    card.hidden = dynamicSignatures.has((card.dataset.honorFallbackKey ?? "").toLocaleLowerCase("zh-CN"));
  });
}

export async function loadHonorMedia(documentRef: Document = document): Promise<void> {
  const container = documentRef.querySelector<HTMLElement>("[data-honor-media]");
  if (!container) return;
  const apiBase = container.dataset.apiBase;
  if (!apiBase) return;
  try {
    const response = await fetch(`${apiBase.replace(/\/$/u, "")}/v1/honor-media`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("HONOR_MEDIA_UNAVAILABLE");
    const payload = await response.json() as { data?: unknown };
    const data = payload.data;
    const items = sanitizePublicHonorMediaItems(
      data && typeof data === "object" && !Array.isArray(data) && "items" in data
        ? (data as { items?: unknown }).items
        : data,
    );
    renderHonorMedia(container, items);
  } catch {
    // Static certificate cards stay visible when the independent manifest is unavailable.
  }
}

export function bindMobileSiteNavigation(documentRef: Document = document): void {
  const menu = documentRef.querySelector<HTMLDetailsElement>(".mobile-site-nav");
  if (!menu) return;
  menu.querySelectorAll<HTMLAnchorElement>("a[href^='#']").forEach((link) => {
    link.addEventListener("click", () => { menu.open = false; });
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      menu.open = false;
      menu.querySelector<HTMLElement>("summary")?.focus();
    }
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      bindMobileSiteNavigation();
      void loadHonorMedia();
    });
  } else {
    bindMobileSiteNavigation();
    void loadHonorMedia();
  }
}
