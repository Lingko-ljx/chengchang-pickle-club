import cloudbase from "@cloudbase/js-sdk";
import { createAdminApiClient } from "./api.ts";
import { createAuthenticatedSession, readAdminConfig } from "./config.ts";
import {
  BOOKING_ACTIONS,
  COURT_IDS,
  confirmationMessage,
  renderBookingDetail,
  renderBookingList,
  renderCourtMatrix,
  renderPendingQueue,
  type AdminBooking,
  type AvailabilitySlot,
} from "./render.ts";

type Dashboard = { date: string; pending: AdminBooking[]; slots: AvailabilitySlot[] };

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing admin element: ${id}`);
  return element as T;
}

function setHidden(element: HTMLElement, hidden: boolean) {
  element.hidden = hidden;
}

function shanghaiDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function startAdmin() {
  const shell = required<HTMLElement>("admin-shell");
  const loginForm = required<HTMLFormElement>("admin-login-form");
  const dashboardElement = required<HTMLElement>("admin-dashboard");
  const signOutButton = required<HTMLButtonElement>("admin-sign-out");
  const unavailable = required<HTMLElement>("admin-unavailable");
  const loginMessage = required<HTMLElement>("admin-login-message");
  const message = required<HTMLElement>("admin-message");
  let config;
  try {
    config = readAdminConfig(shell);
  } catch {
    setHidden(unavailable, false);
    setHidden(loginForm, true);
    return;
  }

  const app = cloudbase.init({ env: config.cloudbaseEnvId });
  const auth = app.auth();
  const session = createAuthenticatedSession(auth as unknown as Parameters<typeof createAuthenticatedSession>[0]);
  let selected: AdminBooking | null = null;
  let dashboard: Dashboard = { date: shanghaiDate(), pending: [], slots: [] };
  let bookings: AdminBooking[] = [];
  const selectedDate = required<HTMLInputElement>("admin-filter-date");
  selectedDate.value = dashboard.date;

  const showMessage = (value: string, error = false) => {
    message.textContent = value;
    message.classList.toggle("is-error", error);
    setHidden(message, false);
  };
  const showLogin = () => {
    session.clear();
    selected = null;
    setHidden(dashboardElement, true);
    setHidden(signOutButton, true);
    setHidden(loginForm, false);
  };
  const api = createAdminApiClient({
    baseUrl: config.apiBaseUrl,
    getAccessToken: session.getAccessToken,
    onUnauthorized: showLogin,
  });

  const onSelect = (booking: AdminBooking) => {
    selected = booking;
    renderBookingDetail(required("admin-booking-detail"), booking);
    renderActions();
  };
  const renderAll = () => {
    required("admin-pending-count").textContent = String(dashboard.pending.length);
    renderPendingQueue(required("admin-pending-list"), dashboard.pending, onSelect);
    renderBookingList(required("admin-booking-list"), bookings, onSelect);
    renderCourtMatrix(required("admin-court-matrix"), dashboard.slots, bookings, onSelect);
    if (selected) {
      selected = bookings.find((booking) => booking.id === selected?.id) ?? null;
    }
    renderBookingDetail(required("admin-booking-detail"), selected);
    renderActions();
  };

  const filters = () => ({
    date: selectedDate.value,
    status: required<HTMLSelectElement>("admin-filter-status").value,
    mode: required<HTMLSelectElement>("admin-filter-mode").value,
    q: required<HTMLInputElement>("admin-filter-query").value.trim(),
  });
  const refresh = async () => {
    const date = selectedDate.value || shanghaiDate();
    [dashboard, bookings] = await Promise.all([
      api.getDashboard(date) as Promise<Dashboard>,
      api.listBookings(filters()) as Promise<AdminBooking[]>,
    ]);
    renderAll();
  };

  async function runBookingAction(action: string, label: string) {
    if (!selected) return;
    const body: Record<string, unknown> = { expectedVersion: selected.version };
    if (action === "reschedule") {
      const sessionId = window.prompt("请输入目标场次 ID");
      if (!sessionId?.trim()) return;
      body.sessionId = sessionId.trim();
    }
    if (action === "reassign") {
      const courtId = window.prompt("请输入目标场地编号（01–11）");
      if (!courtId || !COURT_IDS.includes(courtId)) return;
      body.courtId = courtId;
    }
    if (!window.confirm(confirmationMessage(selected, label))) return;
    await api.mutateBooking(selected.id, action, body);
    await refresh();
    showMessage(`${label}已提交。`);
  }

  function renderActions() {
    const detail = required("admin-booking-detail");
    detail.querySelector(".admin-detail-actions")?.remove();
    if (!selected) return;
    const actions = document.createElement("div");
    actions.className = "admin-detail-actions";
    for (const [action, label] of BOOKING_ACTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        runBookingAction(action, label).catch((error) => showMessage(String(error), true));
      });
      actions.append(button);
    }
    detail.append(actions);
  }

  for (const courtId of COURT_IDS) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.addEventListener("change", () => {
      const action = `${input.checked ? "启用" : "停用"}场地 ${courtId}`;
      if (!window.confirm(confirmationMessage({ code: "系统设置", date: selectedDate.value }, action))) {
        input.checked = !input.checked;
        return;
      }
      api.setCourtEnabled(courtId, input.checked, Number(input.dataset.version ?? 0))
        .then(() => {
          input.dataset.version = String(Number(input.dataset.version ?? 0) + 1);
          showMessage(`${action}已保存。`);
        })
        .catch((error) => {
          input.checked = !input.checked;
          showMessage(String(error), true);
        });
    });
    label.append(input, document.createTextNode(` 场地 ${courtId}`));
    required("admin-court-controls").append(label);
  }

  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const username = required<HTMLInputElement>("admin-username").value.trim();
    const passwordInput = required<HTMLInputElement>("admin-password");
    const password = passwordInput.value;
    passwordInput.value = "";
    loginMessage.textContent = "正在验证…";
    setHidden(loginMessage, false);
    session.login(username, password)
      .then(async () => {
        setHidden(loginForm, true);
        setHidden(dashboardElement, false);
        setHidden(signOutButton, false);
        setHidden(loginMessage, true);
        await refresh();
      })
      .catch(() => {
        showLogin();
        loginMessage.textContent = "登录失败，请检查账号、密码和工作人员权限。";
        setHidden(loginMessage, false);
      });
  });

  signOutButton.addEventListener("click", () => {
    showLogin();
    Promise.resolve(auth.signOut()).catch(() => undefined);
  });
  required<HTMLFormElement>("admin-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    refresh().catch((error) => showMessage(String(error), true));
  });
  required<HTMLFormElement>("admin-template-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const templateId = required<HTMLInputElement>("admin-template-id").value.trim();
    const enabled = required<HTMLInputElement>("admin-template-enabled").checked;
    const versionInput = required<HTMLInputElement>("admin-template-version");
    const expectedVersion = Number(versionInput.value);
    const action = `${enabled ? "开放" : "关闭"} 60 分钟场次模板 ${templateId}`;
    if (!window.confirm(confirmationMessage({ code: "系统设置", date: selectedDate.value }, action))) return;
    api.setSessionTemplateEnabled(templateId, enabled, expectedVersion)
      .then(() => {
        versionInput.value = String(expectedVersion + 1);
        showMessage(`${action}已保存。`);
      })
      .catch((error) => showMessage(String(error), true));
  });
  required<HTMLFormElement>("admin-export-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const from = required<HTMLInputElement>("admin-export-from").value;
    const to = required<HTMLInputElement>("admin-export-to").value;
    api.exportCsv(from, to)
      .then((result) => {
        const url = URL.createObjectURL(result as Blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `bookings-${from}-${to}.csv`;
        link.click();
        URL.revokeObjectURL(url);
      })
      .catch((error) => showMessage(String(error), true));
  });
}

startAdmin();
