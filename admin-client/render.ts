export const COURT_IDS = Object.freeze([
  "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11",
]);
export const sessionTemplateDuration = 60;
export const BOOKING_ACTIONS = [
  ["confirm", "确认预约"],
  ["reschedule", "提出改期"],
  ["cancel", "取消预约"],
  ["complete", "完结预约"],
  ["reassign", "调整场地"],
  ["redact", "提前脱敏"],
];

export type AdminBooking = {
  id: string;
  code: string;
  sessionId: string;
  date: string;
  startAt: string;
  endAt: string;
  courtId?: string;
  proposedSessionId?: string;
  mode: "private" | "open";
  partySize: number;
  status: string;
  name?: string;
  phone?: string;
  email?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
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
    text("strong", booking.code),
    text("span", `${booking.startAt} · ${booking.courtId ?? "待分配"}`),
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
      const assigned = bookings.filter(
        (booking) => booking.sessionId === slot.sessionId && booking.courtId === courtId,
      );
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

export function renderBookingDetail(container: Element, booking: AdminBooking | null) {
  empty(container);
  if (!booking) {
    container.append(text("p", "选择一条预约查看详情和操作。", "admin-empty"));
    return;
  }
  container.append(
    text("h3", booking.code),
    text("p", `${booking.date} · ${booking.startAt}–${booking.endAt}`),
    text("p", `${booking.mode === "private" ? "包场" : "散客"} · ${booking.partySize} 人 · 场地 ${booking.courtId ?? "待分配"}`),
    text("p", `${booking.name ?? "已脱敏"} · ${booking.phone ?? "号码已脱敏"}`),
    text("p", booking.email ?? "未留邮箱"),
    text("p", booking.note ?? "无备注"),
  );
  const timeline = document.createElement("ol");
  timeline.className = "admin-detail-timeline";
  timeline.append(
    text("li", `提交 · ${booking.createdAt}`),
    text("li", `${statusLabels[booking.status] ?? booking.status} · ${booking.updatedAt}`),
  );
  container.append(timeline);
}
