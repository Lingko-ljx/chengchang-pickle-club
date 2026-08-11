import cloudbase from "@cloudbase/js-sdk";
import { createAdminApiClient } from "./api.ts";
import {
  initializePrivateAuth,
  readAdminConfig,
} from "./config.ts";
import { runAdminLoginFlow } from "./login-flow.ts";
import { uploadHomepageMedia } from "./media-upload.ts";
import {
  bookingActionsFor,
  confirmationMessage,
  renderBookingDetail,
  renderBookingList,
  renderCourtMatrix,
  renderHomepageMediaAdmin,
  renderPendingQueue,
  retainSelectedBooking,
  type AdminAuditLog,
  type AdminBooking,
  type AdminHomepageMediaItem,
  type AdminHomepageMediaManifest,
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
type BookingPolicy = {
  openingTime: string;
  closingTime: string;
  startIntervalMinutes: number;
  minimumDurationMinutes: number;
  durationStepMinutes: number;
  maximumDurationMinutes: number;
  timezone: string;
};
type Settings = {
  courts: CourtSetting[];
  sessionTemplates: TemplateSetting[];
  bookingPolicy?: BookingPolicy;
};
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
  let activeAction: string | null = null;
  let todayDashboard: Dashboard = { date: shanghaiDate(), pending: [], slots: [] };
  let selectedDashboard: Dashboard = { date: shanghaiDate(), pending: [], slots: [] };
  let bookings: AdminBooking[] = [];
  let matrixBookings: AdminBooking[] = [];
  let settings: Settings = { courts: [], sessionTemplates: [] };
  let courtDraft: Record<string, boolean> = {};
  let savingCourts = false;
  let mediaManifest: AdminHomepageMediaManifest = { version: 0, items: [] };
  let mediaBusy = false;
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

  const mediaStatus = required<HTMLElement>("admin-media-form-status");
  const mediaUploadButton = required<HTMLButtonElement>("admin-media-upload");
  const showMediaStatus = (value: string, error = false) => {
    mediaStatus.textContent = value;
    mediaStatus.classList.toggle("is-error", error);
    setHidden(mediaStatus, !value);
  };
  const mediaErrorMessage = (error: unknown) => {
    const code = error instanceof Error ? error.message : "";
    if (/MEDIA_CONFLICT/.test(code)) return "内容列表刚刚有更新，请刷新后重试。";
    if (/MEDIA_LIMIT_REACHED/.test(code)) return "宣传内容数量已达上限，请先下架或删除旧内容。";
    if (/INVALID_MEDIA_INPUT|INVALID_FILE/.test(code)) return "文件或文字信息不符合要求，请检查格式和大小后重试。";
    if (/MEDIA_UPLOAD|UPLOAD_FAILED|INVALID_UPLOAD_INTENT/.test(code)) return "文件上传尚未完成，请检查网络后重新上传。";
    return "宣传内容操作未完成，请检查网络后重试。";
  };
  const renderMedia = () => {
    required("admin-media-count").textContent = `${mediaManifest.items.length} 条`;
    renderHomepageMediaAdmin(
      required("admin-media-list"),
      mediaManifest,
      (action, item) => {
        runMediaAction(action, item).catch((error) => {
          showMediaStatus(mediaErrorMessage(error), true);
        });
      },
    );
  };
  const refreshMedia = async () => {
    try {
      mediaManifest = await api.getHomepageMedia() as AdminHomepageMediaManifest;
      renderMedia();
    } catch (error) {
      renderHomepageMediaAdmin(required("admin-media-list"), { version: 0, items: [] }, () => undefined);
      showMediaStatus(mediaErrorMessage(error), true);
    }
  };

  async function runMediaAction(
    action: "publish" | "unpublish" | "pin" | "unpin" | "delete",
    item: AdminHomepageMediaItem,
  ) {
    if (mediaBusy) return;
    const labels = {
      publish: "发布",
      unpublish: "下架",
      pin: "置顶",
      unpin: "取消置顶",
      delete: "永久删除",
    };
    if (!window.confirm(`${labels[action]}“${item.title}”？`)) return;
    mediaBusy = true;
    showMediaStatus(`${labels[action]}处理中…`);
    try {
      if (action === "publish" || action === "unpublish") {
        await api.setHomepageMediaPublished(item.id, action === "publish", mediaManifest.version);
      } else if (action === "pin" || action === "unpin") {
        await api.setHomepageMediaPinned(item.id, action === "pin", mediaManifest.version);
      } else {
        await api.deleteHomepageMedia(item.id, mediaManifest.version);
      }
      await refreshMedia();
      showMediaStatus(`${labels[action]}成功。`);
    } finally {
      mediaBusy = false;
    }
  }

  async function submitMediaUpload() {
    if (mediaBusy) return;
    const fileInput = required<HTMLInputElement>("admin-media-file");
    const file = fileInput.files?.[0];
    const title = required<HTMLInputElement>("admin-media-title").value.trim();
    const caption = required<HTMLTextAreaElement>("admin-media-caption").value.trim();
    const altText = required<HTMLInputElement>("admin-media-alt").value.trim() || title;
    if (!file || !title) throw new Error("INVALID_MEDIA_INPUT");
    mediaBusy = true;
    mediaUploadButton.disabled = true;
    showMediaStatus("正在安全上传并发布，请不要关闭页面…");
    try {
      await uploadHomepageMedia({
        api,
        file,
        title,
        ...(caption ? { caption } : {}),
        altText,
        expectedManifestVersion: mediaManifest.version,
        publish: true,
      });
      required<HTMLFormElement>("admin-media-upload-form").reset();
      await refreshMedia();
      showMediaStatus("上传成功，内容已经显示在首页。");
    } catch (error) {
      await refreshMedia().catch(() => undefined);
      throw error;
    } finally {
      mediaBusy = false;
      mediaUploadButton.disabled = false;
    }
  }

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
    const policy = settings.bookingPolicy ?? {
      openingTime: "09:00",
      closingTime: "22:00",
      startIntervalMinutes: 30,
      minimumDurationMinutes: 60,
      durationStepMinutes: 60,
      maximumDurationMinutes: 240,
      timezone: "Asia/Shanghai",
    };
    required("admin-policy-opening").textContent = `${policy.openingTime}–${policy.closingTime}`;
    required("admin-policy-interval").textContent = `${policy.startIntervalMinutes} 分钟`;
    required("admin-policy-minimum").textContent = `${policy.minimumDurationMinutes / 60} 小时`;
    required("admin-policy-billing").textContent = policy.durationStepMinutes === 60
      ? "整小时"
      : `${policy.durationStepMinutes} 分钟`;
    required("admin-policy-maximum").textContent = `${policy.maximumDurationMinutes / 60} 小时`;

    const courtControls = required("admin-court-controls");
    courtControls.replaceChildren();
    for (const court of settings.courts) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      const visual = document.createElement("span");
      const name = document.createElement("strong");
      const state = document.createElement("small");
      label.className = "admin-court-toggle";
      input.type = "checkbox";
      input.checked = courtDraft[court.id] ?? court.enabled;
      input.setAttribute("aria-label", `场地 ${court.id}`);
      visual.className = "admin-court-toggle-visual";
      name.textContent = `场地 ${court.id}`;
      state.textContent = input.checked ? "开放" : "关闭";
      visual.append(name, state);
      input.addEventListener("change", () => {
        courtDraft[court.id] = input.checked;
        state.textContent = input.checked ? "开放" : "关闭";
        updateCourtDraftSummary();
      });
      label.append(input, visual);
      courtControls.append(label);
    }
    updateCourtDraftSummary();
  };

  const updateCourtDraftSummary = () => {
    const changed = settings.courts.filter(
      (court) => (courtDraft[court.id] ?? court.enabled) !== court.enabled,
    );
    const enabled = settings.courts.filter(
      (court) => courtDraft[court.id] ?? court.enabled,
    ).length;
    required("admin-enabled-court-count").textContent = `${enabled} / ${settings.courts.length || 11} 开放`;
    required("admin-court-draft-status").textContent = changed.length
      ? `${changed.length} 项修改尚未保存`
      : "当前没有未保存修改";
    required<HTMLButtonElement>("admin-save-courts").disabled = !changed.length || savingCourts;
  };

  const setAllCourtDraft = (enabled: boolean) => {
    for (const court of settings.courts) courtDraft[court.id] = enabled;
    renderSettings();
  };

  const saveCourtSettings = async () => {
    const changed = settings.courts.filter(
      (court) => (courtDraft[court.id] ?? court.enabled) !== court.enabled,
    );
    if (!changed.length || savingCourts) return;
    if (!window.confirm(`保存 ${changed.length} 项场地开关修改？`)) return;
    savingCourts = true;
    updateCourtDraftSummary();
    try {
      for (const court of changed) {
        await api.setCourtEnabled(
          court.id,
          courtDraft[court.id] ?? court.enabled,
          court.version,
        );
      }
      courtDraft = {};
      await refresh();
      showMessage("场地设置已保存。");
    } catch (error) {
      showMessage(String(error), true);
      await refresh().catch((refreshError) => showMessage(String(refreshError), true));
    } finally {
      savingCourts = false;
      updateCourtDraftSummary();
    }
  };

  const renderAll = () => {
    required("admin-pending-count").textContent = String(todayDashboard.pending.length);
    renderPendingQueue(required("admin-pending-list"), todayDashboard.pending, onSelect);
    renderBookingList(required("admin-booking-list"), bookings, onSelect);
    renderCourtMatrix(required("admin-court-matrix"), selectedDashboard.date, matrixBookings, onSelect);
    if (selected) {
      selected = retainSelectedBooking(
        selected,
        [...bookings, ...matrixBookings, ...todayDashboard.pending],
      );
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
    courtDraft = {};
    renderAll();
    await refreshMedia();
    if (selected) await loadSelectedAudits();
  };

  async function runBookingAction(action: string, label: string) {
    if (!selected || activeAction) return;
    const target = selected;
    const body: Record<string, unknown> = { expectedVersion: target.version };
    if (!window.confirm(confirmationMessage(target, label))) return;
    activeAction = action;
    renderActions();
    try {
      const updated = await api.mutateBooking(target.id, action, body);
      if (selected?.id === target.id) {
        selected = action === "redact"
          ? {
              ...target,
              name: undefined,
              phone: undefined,
              email: undefined,
              note: undefined,
              personalDataRedactedAt: new Date().toISOString(),
              version: target.version + 1,
            }
          : updated as AdminBooking;
        selectedAudits = [];
        renderBookingDetail(required("admin-booking-detail"), selected, selectedAudits);
      }
      showMessage(`${label}成功。`);
      try {
        await refresh();
      } catch {
        showMessage(`${label}成功，但列表未能自动刷新，请点击“筛选”重试。`);
      }
    } finally {
      activeAction = null;
      renderActions();
    }
  }

  function renderActions() {
    const detail = required("admin-booking-detail");
    detail.querySelector(".admin-detail-actions")?.remove();
    if (!selected) return;
    const actions = document.createElement("div");
    actions.className = "admin-detail-actions";
    for (const [action, label] of bookingActionsFor(selected)) {
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = activeAction !== null;
      button.textContent = activeAction === action ? `${label}处理中…` : label;
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
  required<HTMLFormElement>("admin-media-upload-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitMediaUpload().catch((error) => {
      mediaBusy = false;
      mediaUploadButton.disabled = false;
      showMediaStatus(mediaErrorMessage(error), true);
    });
  });
  required<HTMLButtonElement>("admin-enable-all-courts").addEventListener("click", () => {
    setAllCourtDraft(true);
  });
  required<HTMLButtonElement>("admin-disable-all-courts").addEventListener("click", () => {
    setAllCourtDraft(false);
  });
  required<HTMLButtonElement>("admin-save-courts").addEventListener("click", () => {
    saveCourtSettings().catch((error) => showMessage(String(error), true));
  });
}

startAdmin();
