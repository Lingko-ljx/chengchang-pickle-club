import cloudbase from "@cloudbase/js-sdk";
import { createAdminApiClient } from "./api.ts";
import {
  initializePrivateAuth,
  readAdminConfig,
} from "./config.ts";
import { runAdminLoginFlow } from "./login-flow.ts";
import {
  BOOKING_ACTIONS,
  COURT_IDS,
  confirmationMessage,
  renderBookingDetail,
  renderBookingList,
  renderCourtMatrix,
  renderPendingQueue,
  type AdminAuditLog,
  type AdminBooking,
  type AvailabilitySlot,
} from "./render.ts";

type Dashboard = { date: string; pending: AdminBooking[]; slots: AvailabilitySlot[] };
type CourtSetting = { id: string; enabled: boolean; version: number };
type TemplateSetting = {
  id: string;
  startTime: string;
  endTime: string;
  enabled: boolean;
  version: number;
};
type Settings = { courts: CourtSetting[]; sessionTemplates: TemplateSetting[] };
type Bootstrap = {
  todayDashboard: Dashboard;
  selectedDashboard: Dashboard;
  bookings: AdminBooking[];
  matrixBookings: AdminBooking[];
  settings: Settings;
};

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

  const session = initializePrivateAuth(
    cloudbase as unknown as Parameters<typeof initializePrivateAuth>[0],
    config.cloudbaseEnvId,
  );
  let selected: AdminBooking | null = null;
  let selectedAudits: AdminAuditLog[] = [];
  let todayDashboard: Dashboard = { date: shanghaiDate(), pending: [], slots: [] };
  let selectedDashboard: Dashboard = { date: shanghaiDate(), pending: [], slots: [] };
  let bookings: AdminBooking[] = [];
  let matrixBookings: AdminBooking[] = [];
  let settings: Settings = { courts: [], sessionTemplates: [] };
  const selectedDate = required<HTMLInputElement>("admin-filter-date");
  selectedDate.value = selectedDashboard.date;

  const showMessage = (value: string, error = false) => {
    message.textContent = value;
    message.classList.toggle("is-error", error);
    setHidden(message, false);
  };
  const showLogin = async () => {
    await session.clear().catch(() => undefined);
    selected = null;
    selectedAudits = [];
    setHidden(dashboardElement, true);
    setHidden(signOutButton, true);
    setHidden(loginForm, false);
  };
  const api = createAdminApiClient({
    baseUrl: config.apiBaseUrl,
    getAccessToken: session.getAccessToken,
    onUnauthorized: showLogin,
  });

  const loadSelectedAudits = async () => {
    const bookingId = selected?.id;
    if (!bookingId) return;
    const logs = await api.getAuditLogs(bookingId) as AdminAuditLog[];
    if (selected?.id !== bookingId) return;
    selectedAudits = logs;
    renderBookingDetail(required("admin-booking-detail"), selected, selectedAudits);
    renderActions();
  };

  const onSelect = (booking: AdminBooking) => {
    selected = booking;
    selectedAudits = [];
    renderBookingDetail(required("admin-booking-detail"), booking, selectedAudits);
    renderActions();
    loadSelectedAudits()
      .catch((error) => showMessage(String(error), true));
  };

  const renderSettings = () => {
    const courtControls = required("admin-court-controls");
    courtControls.replaceChildren();
    for (const court of settings.courts) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = court.enabled;
      input.addEventListener("change", () => {
        const action = `${input.checked ? "启用" : "停用"}场地 ${court.id}`;
        if (!window.confirm(confirmationMessage({ code: "系统设置", date: shanghaiDate() }, action))) {
          input.checked = court.enabled;
          return;
        }
        api.setCourtEnabled(court.id, input.checked, court.version)
          .then(refresh)
          .then(() => showMessage(`${action}已保存。`))
          .catch((error) => {
            showMessage(String(error), true);
            refresh().catch((refreshError) => showMessage(String(refreshError), true));
          });
      });
      label.append(input, document.createTextNode(` 场地 ${court.id}`));
      courtControls.append(label);
    }

    const templateControls = required("admin-template-controls");
    templateControls.replaceChildren();
    for (const template of settings.sessionTemplates) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = template.enabled;
      input.addEventListener("change", () => {
        const action = `${input.checked ? "开放" : "关闭"} 60 分钟场次 ${template.startTime}`;
        if (!window.confirm(confirmationMessage({ code: template.id, date: shanghaiDate() }, action))) {
          input.checked = template.enabled;
          return;
        }
        api.setSessionTemplateEnabled(template.id, input.checked, template.version)
          .then(refresh)
          .then(() => showMessage(`${action}已保存。`))
          .catch((error) => {
            showMessage(String(error), true);
            refresh().catch((refreshError) => showMessage(String(refreshError), true));
          });
      });
      label.append(input, document.createTextNode(` ${template.startTime}–${template.endTime}`));
      templateControls.append(label);
    }
  };

  const renderAll = () => {
    required("admin-pending-count").textContent = String(todayDashboard.pending.length);
    renderPendingQueue(required("admin-pending-list"), todayDashboard.pending, onSelect);
    renderBookingList(required("admin-booking-list"), bookings, onSelect);
    renderCourtMatrix(required("admin-court-matrix"), selectedDashboard.slots, matrixBookings, onSelect);
    if (selected) {
      selected = [...bookings, ...matrixBookings, ...todayDashboard.pending]
        .find((booking) => booking.id === selected?.id) ?? null;
    }
    renderBookingDetail(required("admin-booking-detail"), selected, selectedAudits);
    renderActions();
    renderSettings();
  };

  const filters = () => ({
    date: selectedDate.value,
    status: required<HTMLSelectElement>("admin-filter-status").value,
    mode: required<HTMLSelectElement>("admin-filter-mode").value,
    q: required<HTMLInputElement>("admin-filter-query").value.trim(),
  });
  const refresh = async () => {
    const today = shanghaiDate();
    const date = selectedDate.value || today;
    const bootstrap = await api.getBootstrap(today, {
      ...filters(),
      date,
    }) as Bootstrap;
    todayDashboard = bootstrap.todayDashboard;
    selectedDashboard = bootstrap.selectedDashboard;
    bookings = bootstrap.bookings;
    matrixBookings = bootstrap.matrixBookings;
    settings = bootstrap.settings;
    renderAll();
    if (selected) await loadSelectedAudits();
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

  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const username = required<HTMLInputElement>("admin-username").value.trim();
    const passwordInput = required<HTMLInputElement>("admin-password");
    const password = passwordInput.value;
    passwordInput.value = "";
    loginMessage.textContent = "正在验证…";
    setHidden(loginMessage, false);
    void runAdminLoginFlow({
      login: () => session.login(username, password),
      onAuthenticated: () => {
        setHidden(loginForm, true);
        setHidden(dashboardElement, false);
        setHidden(signOutButton, false);
        setHidden(loginMessage, true);
      },
      refresh,
      onAuthFailure: async (failureMessage) => {
        await showLogin();
        loginMessage.textContent = failureMessage;
        setHidden(loginMessage, false);
      },
      onRefreshFailure: (failureMessage) => showMessage(failureMessage, true),
    });
  });

  signOutButton.addEventListener("click", () => {
    void showLogin();
  });
  required<HTMLFormElement>("admin-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    refresh().catch((error) => showMessage(String(error), true));
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
