export const COURT_IDS = Object.freeze([
  "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11",
]);
export const sessionTemplateDuration = 60;
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

function empty(element: Element) {
  element.replaceChildren();
}

function text(tag: string, value: string, className?: string) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function bookingButton(booking: AdminBooking, onSelect: (booking: AdminBooking) => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "admin-booking-row";
  button.append(
    text("strong", bookingDisplayName(booking)),
    text("span", `预约号 ${booking.code}`, "admin-booking-code"),
    text("span", `${formatShanghaiBookingSchedule(booking)} · ${booking.courtId ?? "待分配"}`),
    text("span", `${statusLabels[booking.status] ?? booking.status} · ${booking.partySize} 人`),
  );
  button.addEventListener("click", () => onSelect(booking));
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
  slots: AvailabilitySlot[],
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
  for (const slot of slots) {
    const row = document.createElement("tr");
    row.append(text("th", `${slot.startTime}–${slot.endTime}`));
    for (const courtId of COURT_IDS) {
      const cell = document.createElement("td");
      const assigned = matrixBookingsForCell(bookings, slot.sessionId, courtId);
      if (!assigned.length) {
        cell.append(text("span", "空闲", "admin-court-empty"));
      } else {
        for (const booking of assigned) cell.append(bookingButton(booking, onSelect));
      }
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  container.append(table);
}

export function matrixBookingsForCell<T extends {
  status: string;
  sessionId: string;
  courtId?: string;
  proposedSessionId?: string;
  proposedCourtId?: string;
}>(bookings: T[], sessionId: string, courtId: string): T[] {
  return bookings.filter((booking) =>
    booking.status !== "cancelled" &&
    booking.status !== "completed" &&
    ((booking.sessionId === sessionId && booking.courtId === courtId) ||
      (booking.proposedSessionId === sessionId && booking.proposedCourtId === courtId)),
  );
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
    text("p", formatShanghaiBookingSchedule(booking)),
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
