export const COURT_IDS = Object.freeze([
  "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11",
]);
export const HALF_HOUR_SLOTS = Object.freeze([
  "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00",
  "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30",
  "16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:00",
  "19:30", "20:00", "20:30", "21:00", "21:30",
]);
export const BOOKING_ACTIONS = [
  ["confirm", "确认预约"],
  ["cancel", "取消预约"],
  ["complete", "完结预约"],
  ["redact", "提前脱敏"],
] as const;

export function bookingActionsFor(booking: {
  status: string;
  personalDataRedactedAt?: string;
}): Array<(typeof BOOKING_ACTIONS)[number]> {
  const [confirm, cancel, complete, redact] = BOOKING_ACTIONS;
  if (booking.status === "pending") return [confirm, cancel];
  if (booking.status === "confirmed") return [complete, cancel];
  if (booking.status === "reschedule_proposed") return [cancel];
  if (
    (booking.status === "cancelled" || booking.status === "completed") &&
    !booking.personalDataRedactedAt
  ) {
    return [redact];
  }
  return [];
}

export type AdminBooking = {
  id: string;
  code: string;
  sessionId: string;
  date: string;
  startAt: string;
  endAt: string;
  courtId?: string;
  proposedDate?: string;
  proposedSessionId?: string;
  proposedCourtId?: string;
  proposedStartAt?: string;
  proposedEndAt?: string;
  mode: "private" | "open";
  partySize: number;
  status: string;
  name?: string;
  phone?: string;
  email?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  personalDataRedactedAt?: string;
  version: number;
};

export type AdminAuditLog = {
  id: string;
  action: string;
  actorType: "customer" | "staff" | "system";
  fromStatus?: string;
  toStatus?: string;
  at: string;
};

export type AvailabilitySlot = {
  sessionId: string;
  startTime: string;
  endTime: string;
};

const statusLabels: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  reschedule_proposed: "等待改期答复",
  cancelled: "已取消",
  completed: "已完成",
};

export function confirmationMessage(
  booking: Pick<AdminBooking, "code" | "date">,
  action: string,
): string {
  return `${action} · 预约 ${booking.code} · ${booking.date}\n确认继续吗？`;
}

type ShanghaiInstantParts = {
  date: string;
  time: string;
};

export type AdminHomepageMediaItem = {
  id: string;
  kind: "image" | "video";
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  title: string;
  caption?: string;
  altText: string;
  status: "uploading" | "draft" | "published" | "deleting";
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  pinnedAt?: string;
};

export type AdminHomepageMediaManifest = {
  version: number;
  items: AdminHomepageMediaItem[];
};

type HomepageMediaAction = "publish" | "unpublish" | "pin" | "unpin" | "delete";

export function homepageMediaActionsFor(
  item: Pick<AdminHomepageMediaItem, "status" | "pinnedAt">,
): Array<[HomepageMediaAction, string]> {
  if (item.status === "deleting") return [["delete", "重试删除"]];
  const definitions: Array<[HomepageMediaAction, string]> = [];
  if (item.status === "draft") definitions.push(["publish", "发布"]);
  if (item.status === "published") {
    definitions.push([item.pinnedAt ? "unpin" : "pin", item.pinnedAt ? "取消置顶" : "置顶"]);
    definitions.push(["unpublish", "下架"]);
  }
  definitions.push(["delete", "删除"]);
  return definitions;
}

export function bookingDisplayName(booking: { name?: string }): string {
  return booking.name?.trim() || "已脱敏预约";
}

export function retainSelectedBooking<T extends { id: string }>(
  selected: T | null,
  candidates: readonly T[],
): T | null {
  if (!selected) return null;
  return candidates.find((booking) => booking.id === selected.id) ?? selected;
}

const explicitOffsetInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function shanghaiInstantParts(instant: string): ShanghaiInstantParts | null {
  if (!explicitOffsetInstant.test(instant)) return null;
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!values.year || !values.month || !values.day || !values.hour || !values.minute) {
    return null;
  }
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

export function formatShanghaiDateTime(instant: string): string {
  const value = shanghaiInstantParts(instant);
  return value ? `${value.date} ${value.time}` : "时间不可用";
}

export function formatShanghaiDateTimeRange(startAt: string, endAt: string): string {
  const start = shanghaiInstantParts(startAt);
  const end = shanghaiInstantParts(endAt);
  if (!start || !end) return "时间不可用";
  if (start.date === end.date) return `${start.date} ${start.time}–${end.time}`;
  return `${start.date} ${start.time}–${end.date} ${end.time}`;
}

export function formatShanghaiBookingSchedule(
  booking: Pick<AdminBooking, "date" | "startAt" | "endAt">,
): string {
  const start = shanghaiInstantParts(booking.startAt);
  if (!start) return "时间不可用";
  if (start.date !== booking.date) return "时间数据异常";
  return formatShanghaiDateTimeRange(booking.startAt, booking.endAt);
}

export function bookingDurationHours(
  booking: Pick<AdminBooking, "startAt" | "endAt">,
): number {
  const start = Date.parse(booking.startAt);
  const end = Date.parse(booking.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const hours = (end - start) / 3_600_000;
  return Number.isInteger(hours) ? hours : 0;
}

function bookingDurationLabel(booking: Pick<AdminBooking, "startAt" | "endAt">) {
  const hours = bookingDurationHours(booking);
  return hours ? `${hours} 小时` : "时长待确认";
}

function empty(element: Element) {
  element.replaceChildren();
}

function text(tag: string, value: string, className?: string) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function bookingButton(
  booking: AdminBooking,
  onSelect: (booking: AdminBooking) => void,
  selectedBooking: AdminBooking = booking,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "admin-booking-row";
  button.append(
    text("strong", bookingDisplayName(booking)),
    text("span", `北京时间 ${formatShanghaiBookingSchedule(booking)} · ${bookingDurationLabel(booking)}`),
    text("span", `场地 ${booking.courtId ?? "待分配"}`),
    text("span", `${statusLabels[booking.status] ?? booking.status} · ${booking.partySize} 人`),
  );
  button.addEventListener("click", () => onSelect(selectedBooking));
  return button;
}

export function renderPendingQueue(
  container: Element,
  bookings: AdminBooking[],
  onSelect: (booking: AdminBooking) => void,
) {
  empty(container);
  if (!bookings.length) {
    container.append(text("p", "今天没有待确认预约。", "admin-empty"));
    return;
  }
  for (const booking of bookings) container.append(bookingButton(booking, onSelect));
}

export function renderBookingList(
  container: Element,
  bookings: AdminBooking[],
  onSelect: (booking: AdminBooking) => void,
) {
  empty(container);
  if (!bookings.length) {
    container.append(text("p", "没有符合筛选条件的预约。", "admin-empty"));
    return;
  }
  for (const booking of bookings) container.append(bookingButton(booking, onSelect));
}

export function renderCourtMatrix(
  container: Element,
  date: string,
  bookings: AdminBooking[],
  onSelect: (booking: AdminBooking) => void,
) {
  empty(container);
  const table = document.createElement("table");
  table.className = "admin-court-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(text("th", "场次"));
  for (const courtId of COURT_IDS) headRow.append(text("th", courtId));
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (let index = 0; index < HALF_HOUR_SLOTS.length; index += 1) {
    const startTime = HALF_HOUR_SLOTS[index];
    const endTime = index + 1 < HALF_HOUR_SLOTS.length
      ? HALF_HOUR_SLOTS[index + 1]
      : "22:00";
    const row = document.createElement("tr");
    row.append(text("th", `${startTime}–${endTime}`));
    for (const courtId of COURT_IDS) {
      const cell = document.createElement("td");
      const assigned = matrixAssignmentsForCell(bookings, date, startTime, endTime, courtId);
      if (!assigned.length) {
        cell.append(text("span", "空闲", "admin-court-empty"));
      } else {
        for (const assignment of assigned) {
          const { booking, kind, startsHere } = assignment;
          if (startsHere) {
            const displayBooking: AdminBooking = {
              ...booking,
              date,
              startAt: assignment.startAt,
              endAt: assignment.endAt,
              courtId: assignment.courtId,
            };
            const card = bookingButton(displayBooking, onSelect, booking);
            if (kind === "proposed") {
              card.classList.add("admin-booking-proposal");
              card.prepend(text("span", "改期候选", "admin-booking-kind"));
            }
            cell.append(card);
          } else {
            const continuation = document.createElement("button");
            continuation.type = "button";
            continuation.className = "admin-matrix-continuation";
            continuation.textContent = `${bookingDisplayName(booking)} · ${kind === "proposed" ? "改期候选持续" : "持续占用"}`;
            continuation.addEventListener("click", () => onSelect(booking));
            cell.append(continuation);
          }
        }
      }
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  container.append(table);
}

type MatrixBooking = {
  status: string;
  startAt: string;
  endAt: string;
  courtId?: string;
  proposedStartAt?: string;
  proposedEndAt?: string;
  proposedCourtId?: string;
};

export type MatrixAssignment<T> = {
  booking: T;
  kind: "current" | "proposed";
  startsHere: boolean;
  startAt: string;
  endAt: string;
  courtId: string;
};

export function matrixAssignmentsForCell<T extends MatrixBooking>(
  bookings: T[],
  date: string,
  startTime: string,
  endTime: string,
  courtId: string,
): Array<MatrixAssignment<T>> {
  const cellStart = Date.parse(`${date}T${startTime}:00+08:00`);
  const cellEnd = Date.parse(`${date}T${endTime}:00+08:00`);
  const overlaps = (startAt?: string, endAt?: string) => {
    const start = startAt ? Date.parse(startAt) : Number.NaN;
    const end = endAt ? Date.parse(endAt) : Number.NaN;
    return Number.isFinite(start) && Number.isFinite(end) && start < cellEnd && end > cellStart;
  };
  const assignments: Array<MatrixAssignment<T>> = [];
  for (const booking of bookings) {
    if (booking.status === "cancelled" || booking.status === "completed") continue;
    if (booking.courtId === courtId && overlaps(booking.startAt, booking.endAt)) {
      assignments.push({
        booking,
        kind: "current",
        startsHere: Date.parse(booking.startAt) === cellStart,
        startAt: booking.startAt,
        endAt: booking.endAt,
        courtId,
      });
    }
    if (
      booking.status === "reschedule_proposed" &&
      booking.proposedCourtId === courtId &&
      overlaps(booking.proposedStartAt, booking.proposedEndAt)
    ) {
      assignments.push({
        booking,
        kind: "proposed",
        startsHere: Date.parse(booking.proposedStartAt as string) === cellStart,
        startAt: booking.proposedStartAt as string,
        endAt: booking.proposedEndAt as string,
        courtId,
      });
    }
  }
  return assignments;
}

export function matrixBookingsForCell<T extends MatrixBooking>(
  bookings: T[],
  date: string,
  startTime: string,
  endTime: string,
  courtId: string,
): T[] {
  return Array.from(new Set(
    matrixAssignmentsForCell(bookings, date, startTime, endTime, courtId)
      .map(({ booking }) => booking),
  ));
}

function mediaStatusLabel(item: AdminHomepageMediaItem) {
  if (item.status === "published") return item.pinnedAt ? "已发布 · 首页置顶" : "已发布";
  if (item.status === "draft") return "草稿 · 未展示";
  if (item.status === "uploading") return "等待上传完成";
  return "正在删除";
}

function mediaSizeLabel(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "大小未知";
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

export function renderHomepageMediaAdmin(
  container: Element,
  manifest: AdminHomepageMediaManifest,
  onAction: (action: HomepageMediaAction, item: AdminHomepageMediaItem) => void,
) {
  empty(container);
  if (!manifest.items.length) {
    container.append(text("p", "还没有宣传内容。上传第一张球场图片或视频吧。", "admin-empty"));
    return;
  }
  const sorted = [...manifest.items].sort((left, right) =>
    Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)) ||
    right.updatedAt.localeCompare(left.updatedAt),
  );
  for (const item of sorted) {
    const card = document.createElement("article");
    card.className = "admin-media-item";
    const icon = text("span", item.kind === "video" ? "VIDEO" : "IMAGE", "admin-media-kind");
    const copy = document.createElement("div");
    copy.className = "admin-media-item-copy";
    copy.append(
      text("strong", item.title),
      text("span", `${mediaStatusLabel(item)} · ${mediaSizeLabel(item.sizeBytes)}`),
    );
    if (item.caption) copy.append(text("p", item.caption));
    const actions = document.createElement("div");
    actions.className = "admin-media-actions";
    for (const [action, label] of homepageMediaActionsFor(item)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => onAction(action, item));
      actions.append(button);
    }
    card.append(icon, copy, actions);
    container.append(card);
  }
}

export function renderBookingDetail(
  container: Element,
  booking: AdminBooking | null,
  audits: AdminAuditLog[] = [],
) {
  empty(container);
  if (!booking) {
    container.append(text("p", "选择一条预约查看详情和操作。", "admin-empty"));
    return;
  }
  container.append(
    text("h3", bookingDisplayName(booking)),
    text("p", `预约号 ${booking.code}`, "admin-detail-code"),
    text("p", `状态：${statusLabels[booking.status] ?? booking.status}`, "admin-detail-status"),
    text("p", `北京时间 ${formatShanghaiBookingSchedule(booking)} · ${bookingDurationLabel(booking)}`),
    text("p", `${booking.mode === "private" ? "包场" : "散客"} · ${booking.partySize} 人 · 场地 ${booking.courtId ?? "待分配"}`),
    text("p", booking.phone ?? "号码已脱敏"),
    text("p", booking.email ?? "未留邮箱"),
    text("p", booking.note ?? "无备注"),
  );
  if (audits.length) {
    const timeline = document.createElement("ol");
    timeline.className = "admin-detail-timeline";
    for (const audit of audits) {
      const transition = audit.fromStatus && audit.toStatus
        ? ` ${audit.fromStatus} → ${audit.toStatus}`
        : "";
      timeline.append(text("li", `${audit.action}${transition} · ${formatShanghaiDateTime(audit.at)}`));
    }
    container.append(timeline);
  }
}
