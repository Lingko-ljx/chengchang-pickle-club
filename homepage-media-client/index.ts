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
  mediaDate: string;
}

interface HomepageMediaPayload {
  items?: unknown;
  availableDates?: unknown;
  selectedDate?: unknown;
  isToday?: unknown;
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
    if (result.length >= 60) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const id = text(item.id, 64);
    const title = text(item.title, 60);
    const altText = text(item.altText, 120);
    const url = safeUrl(item.url);
    const mimeType = typeof item.mimeType === "string" && allowedMime.has(item.mimeType) ? item.mimeType : undefined;
    const kind = item.kind === "image" || item.kind === "video" ? item.kind : undefined;
    const publishedAt = typeof item.publishedAt === "string" && Number.isFinite(Date.parse(item.publishedAt)) ? item.publishedAt : undefined;
    const mediaDate = typeof item.mediaDate === "string" && validCalendarDate(item.mediaDate)
      ? item.mediaDate
      : publishedAt
        ? beijingDate(publishedAt)
        : undefined;
    if (!id || !title || !altText || !url || !mimeType || !kind || !publishedAt || !mediaDate) continue;
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
      mediaDate,
    });
  }
  return result;
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function beijingDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const field = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}`;
}

export function groupHomepageMediaByDate(items: PublicHomepageMediaItem[]): Map<string, PublicHomepageMediaItem[]> {
  const groups = new Map<string, PublicHomepageMediaItem[]>();
  for (const item of items) {
    const group = groups.get(item.mediaDate) ?? [];
    if (group.length < 6) group.push(item);
    groups.set(item.mediaDate, group);
  }
  return new Map([...groups.entries()].sort(([left], [right]) => right.localeCompare(left)));
}

export function defaultHomepageMediaDate(
  groups: Map<string, PublicHomepageMediaItem[]>,
  today: string,
): string | undefined {
  if (groups.has(today)) return today;
  return [...groups.keys()].find((date) => date <= today) ?? [...groups.keys()][0];
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
  if (!list) return;
  list.replaceChildren();
  if (items.length === 0) {
    const empty = documentRef.createElement("p");
    empty.className = "daily-media-empty";
    empty.textContent = "这一天暂无可展示的动态，可以选择其他日期。";
    list.append(empty);
  }
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
}

function dateLabel(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function renderDateChoices(
  container: HTMLElement,
  dates: string[],
  selectedDate: string,
  onSelect: (date: string) => void,
): void {
  const track = container.querySelector<HTMLElement>("[data-homepage-media-dates]");
  if (!track) return;
  track.replaceChildren();
  const documentRef = container.ownerDocument;
  const label = documentRef.createElement("label");
  label.textContent = "翻看往日球场 ";
  const select = documentRef.createElement("select");
  select.setAttribute("aria-label", "选择球场动态日期");
  for (const date of dates) {
    const option = documentRef.createElement("option");
    option.value = date;
    option.textContent = dateLabel(date);
    select.append(option);
  }
  select.value = selectedDate;
  select.addEventListener("change", () => onSelect(select.value));
  label.append(select);
  track.append(label);
  track.hidden = dates.length <= 1;
}

function updateDailyHeading(container: HTMLElement, selectedDate: string, today: string): void {
  const heading = container.querySelector<HTMLElement>("[data-homepage-media-title]");
  const todayButton = container.querySelector<HTMLButtonElement>("[data-homepage-media-today]");
  if (heading) heading.textContent = selectedDate === today ? "今日球场" : `往日球场 · ${dateLabel(selectedDate)}`;
  if (todayButton) {
    todayButton.hidden = selectedDate === today;
    todayButton.setAttribute("aria-pressed", String(selectedDate === today));
  }
}

function extractPayload(value: unknown): HomepageMediaPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as HomepageMediaPayload;
}

function sanitizedDates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((date): date is string => typeof date === "string" && validCalendarDate(date)))].sort().reverse();
}

export async function loadHomepageMedia(documentRef: Document = document, fetchImpl: typeof fetch = fetch): Promise<void> {
  const container = documentRef.querySelector<HTMLElement>("[data-homepage-media]");
  if (!container) return;
  const apiBase = container.dataset.apiBase;
  if (!apiBase) {
    return;
  }
  const status = container.querySelector<HTMLElement>("[data-homepage-media-status]");
  const retry = container.querySelector<HTMLButtonElement>("[data-homepage-media-retry]");
  const todayButton = container.querySelector<HTMLButtonElement>("[data-homepage-media-today]");
  let generation = 0;
  let dates: string[] = [];
  let lastSelection: string | undefined;
  let failedSelection: string | undefined;
  const showStatus = (message: string, error = false) => {
    if (status) { status.textContent = message; status.hidden = !message; }
    if (retry) retry.hidden = !error;
  };
  const today = beijingDate(new Date());
  const endpoint = `${apiBase.replace(/\/$/u, "")}/v1/homepage-media`;
  const request = async (date?: string): Promise<HomepageMediaPayload> => {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(`${endpoint}${date ? `?date=${encodeURIComponent(date)}` : ""}`, {
            headers: { Accept: "application/json" },
            signal: controller?.signal,
          });
          if (!response.ok) throw new Error("MEDIA_UNAVAILABLE");
          const responseBody = await response.json() as { data?: unknown };
          return Array.isArray(responseBody.data) ? { items: responseBody.data } : extractPayload(responseBody.data);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller?.abort(); reject(new Error("MEDIA_TIMEOUT")); }, 15000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const renderSelection = async (date?: string) => {
    const current = ++generation;
    container.setAttribute("aria-busy", "true");
    showStatus("正在读取球场动态…");
    try {
      const payload = await request(date);
      if (current !== generation) return;
      const items = sanitizePublicMediaItems(payload.items);
      const groups = groupHomepageMediaByDate(items);
      const receivedDates = sanitizedDates(payload.availableDates);
      dates = [...new Set([...dates, ...receivedDates, ...groups.keys()])].sort().reverse();
      const selected = date ?? (typeof payload.selectedDate === "string" && validCalendarDate(payload.selectedDate)
        ? payload.selectedDate : defaultHomepageMediaDate(groups, today));
      renderHomepageMedia(container, selected ? items.filter((item) => item.mediaDate === selected) : []);
      if (selected) {
        lastSelection = selected;
        updateDailyHeading(container, selected, today);
        renderDateChoices(container, dates, selected, (next) => void renderSelection(next));
      }
      if (todayButton) todayButton.hidden = !selected || selected === (dates.includes(today) ? today : dates[0]);
      showStatus("");
    } catch {
      if (current !== generation) return;
      failedSelection = date;
      if (lastSelection) renderDateChoices(container, dates, lastSelection, (next) => void renderSelection(next));
      showStatus(lastSelection ? "未能加载所选日期，仍显示上次内容。请重试。" : "动态暂时未能加载，请重试。", true);
    } finally {
      if (current === generation) container.setAttribute("aria-busy", "false");
    }
  };
  if (retry) retry.onclick = () => void renderSelection(failedSelection);
  if (todayButton) todayButton.onclick = () => void renderSelection(dates.includes(today) ? today : dates[0]);
  await renderSelection();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void loadHomepageMedia());
  } else {
    void loadHomepageMedia();
  }
}
