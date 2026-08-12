import cloudbase from "@cloudbase/js-sdk";
import { createAdminApiClient } from "./api.ts";
import {
  initializePrivateAuth,
  readAdminConfig,
} from "./config.ts";
import { runAdminLoginFlow } from "./login-flow.ts";
import { uploadHomepageMedia, uploadHonorMedia } from "./media-upload.ts";
import {
  bookingActionsFor,
  bookingRecordActionsFor,
  confirmationMessage,
  normalizeBookingPage,
  nextAdminSchedulingWindow,
  renderBookingDetail,
  renderBookingList,
  renderCourtMatrix,
  renderCustomerHistory,
  renderHomepageMediaAdmin,
  renderHonorMediaAdmin,
  renderPendingQueue,
  recordDateRange,
  recordWeekRange,
  retainSelectedBooking,
  summarizeBookings,
  type AdminAuditLog,
  type AdminBooking,
  type AdminCourtTimeBlock,
  type AdminHomepageMediaItem,
  type AdminHomepageMediaManifest,
  type AdminHonorMediaItem,
  type AdminHonorMediaManifest,
  type AvailabilitySlot,
  type BookingRecordView,
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
  matrixBookings: AdminBooking[] | {
    bookings: AdminBooking[];
    timeBlocks?: AdminCourtTimeBlock[];
    inventoryVersions?: Record<string, number>;
  };
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
  let selectedCustomerHistory: AdminBooking[] = [];
  let activeAction: string | null = null;
  let todayDashboard: Dashboard = { date: shanghaiDate(), pending: [], slots: [] };
  let selectedDashboard: Dashboard = { date: shanghaiDate(), pending: [], slots: [] };
  let bookings: AdminBooking[] = [];
  let recordView: BookingRecordView = "active";
  let recordNextCursor: string | null = null;
  let recordHasMore = false;
  let recordLoading = false;
  let matrixBookings: AdminBooking[] = [];
  let timeBlocks: AdminCourtTimeBlock[] = [];
  let inventoryVersions: Record<string, number> = {};
  let editingStaffReservation: AdminBooking | null = null;
  let savingStaffReservation = false;
  let editingTimeBlock: AdminCourtTimeBlock | null = null;
  let savingTimeBlock = false;
  let settings: Settings = { courts: [], sessionTemplates: [] };
  let courtDraft: Record<string, boolean> = {};
  let savingCourts = false;
  let mediaManifest: AdminHomepageMediaManifest = { version: 0, items: [] };
  let mediaBusy = false;
  let honorManifest: AdminHonorMediaManifest = { version: 0, items: [] };
  let honorBusy = false;
  let editingHonor: AdminHonorMediaItem | null = null;
  const selectedDate = required<HTMLInputElement>("admin-filter-date");
  selectedDate.value = selectedDashboard.date;
  const staffReservationDate = required<HTMLInputElement>("admin-staff-reservation-date");
  const staffReservationStart = required<HTMLSelectElement>("admin-staff-reservation-start");
  const staffReservationEnd = required<HTMLSelectElement>("admin-staff-reservation-end");
  const staffReservationCourt = required<HTMLSelectElement>("admin-staff-reservation-court");
  const staffReservationSubmit = required<HTMLButtonElement>("admin-staff-reservation-submit");
  const staffReservationCancelEdit = required<HTMLButtonElement>("admin-staff-reservation-cancel-edit");
  const timeBlockDate = required<HTMLInputElement>("admin-time-block-date");
  const timeBlockStart = required<HTMLSelectElement>("admin-time-block-start");
  const timeBlockEnd = required<HTMLSelectElement>("admin-time-block-end");
  const timeBlockCourt = required<HTMLSelectElement>("admin-time-block-court");
  const timeBlockReason = required<HTMLSelectElement>("admin-time-block-reason");
  const timeBlockSubmit = required<HTMLButtonElement>("admin-time-block-submit");
  const timeBlockCancelEdit = required<HTMLButtonElement>("admin-time-block-cancel-edit");
  const staffTimes = Array.from({ length: 27 }, (_, index) => {
    const minutes = 9 * 60 + index * 30;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  });
  const setSelectOptions = (
    select: HTMLSelectElement,
    values: readonly string[],
    label: (value: string) => string = (value) => value,
  ) => {
    select.replaceChildren(...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label(value);
      return option;
    }));
  };
  setSelectOptions(staffReservationStart, staffTimes.slice(0, -1));
  setSelectOptions(staffReservationEnd, staffTimes.slice(1));
  setSelectOptions(staffReservationCourt, Array.from({ length: 11 }, (_, index) => String(index + 1).padStart(2, "0")), (id) => `场地 ${id}`);
  setSelectOptions(timeBlockStart, staffTimes.slice(0, -1));
  setSelectOptions(timeBlockEnd, staffTimes.slice(1));
  setSelectOptions(timeBlockCourt, Array.from({ length: 11 }, (_, index) => String(index + 1).padStart(2, "0")), (id) => `场地 ${id}`);
  const initialStaffWindow = nextAdminSchedulingWindow(new Date(), 60, selectedDashboard.date);
  const initialTimeBlockWindow = nextAdminSchedulingWindow(new Date(), 30, selectedDashboard.date);
  staffReservationDate.value = initialStaffWindow.date;
  staffReservationStart.value = initialStaffWindow.startTime;
  staffReservationEnd.value = initialStaffWindow.endTime;
  staffReservationCourt.value = "01";
  timeBlockDate.value = initialTimeBlockWindow.date;
  timeBlockStart.value = initialTimeBlockWindow.startTime;
  timeBlockEnd.value = initialTimeBlockWindow.endTime;
  timeBlockCourt.value = "01";
  const recordFrom = required<HTMLInputElement>("admin-filter-from");
  const recordTo = required<HTMLInputElement>("admin-filter-to");
  const applyRecordRange = (preset: "today" | "7" | "30" | "all") => {
    const range = recordDateRange(shanghaiDate(), preset);
    recordFrom.value = range.from;
    recordTo.value = range.to;
  };
  const applyRecordWeek = (offsetWeeks: number) => {
    const range = recordWeekRange(shanghaiDate(), offsetWeeks);
    recordFrom.value = range.from;
    recordTo.value = range.to;
  };
  applyRecordWeek(0);

  const renderRecordSummary = () => {
    const summary = summarizeBookings(bookings);
    required("admin-record-count").textContent = String(summary.loaded);
    required("admin-summary-loaded").textContent = String(summary.loaded);
    required("admin-summary-pending").textContent = String(summary.pending);
    required("admin-summary-confirmed").textContent = String(summary.confirmed);
    required("admin-summary-finished").textContent = String(summary.finished);
    required("admin-record-results-title").textContent = recordView === "archived"
      ? "回收站记录"
      : "预约记录";
    const loadMore = required<HTMLButtonElement>("admin-load-more");
    loadMore.hidden = !recordHasMore;
    loadMore.disabled = recordLoading;
    loadMore.textContent = recordLoading ? "正在加载…" : "加载更多记录";
    required("admin-record-loading").textContent = recordLoading
      ? "正在加载…"
      : recordHasMore
        ? `已加载 ${summary.loaded} 条，还有更多`
        : `已加载 ${summary.loaded} 条`;
  };

  const renderRecordView = () => {
    const active = required<HTMLButtonElement>("admin-record-view-active");
    const archived = required<HTMLButtonElement>("admin-record-view-archived");
    active.classList.toggle("is-active", recordView === "active");
    archived.classList.toggle("is-active", recordView === "archived");
    active.setAttribute("aria-pressed", String(recordView === "active"));
    archived.setAttribute("aria-pressed", String(recordView === "archived"));
    required("admin-record-view-help").textContent = recordView === "archived"
      ? "回收站记录可恢复；隐私保留期内可查看客人资料，过期后仅保留脱敏记录。"
      : "已取消或已完成的记录可移入回收站；隐私保留期内可恢复查看，过期后仅保留脱敏记录。";
  };

  const showMessage = (value: string, error = false) => {
    message.textContent = value;
    message.classList.toggle("is-error", error);
    setHidden(message, false);
  };
  const showLogin = async () => {
    await session.clear().catch(() => undefined);
    selected = null;
    selectedAudits = [];
    selectedCustomerHistory = [];
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
  const honorSubmit = required<HTMLButtonElement>("admin-honor-submit");
  const honorCancelEdit = required<HTMLButtonElement>("admin-honor-cancel-edit");
  const showMediaStatus = (value: string, error = false) => {
    mediaStatus.textContent = value;
    mediaStatus.classList.toggle("is-error", error);
    setHidden(mediaStatus, !value);
  };
  required<HTMLInputElement>("admin-media-date").value = shanghaiDate();
  const showHonorStatus = (value: string, error = false) => {
    const status = required("admin-honor-status");
    status.textContent = value;
    status.classList.toggle("is-error", error);
    setHidden(status, !value);
  };
  const shanghaiTime = (instant: string) => new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
  const resetStaffReservationForm = () => {
    editingStaffReservation = null;
    required<HTMLFormElement>("admin-staff-reservation-form").reset();
    required("admin-staff-reservation-form-title").textContent = "新增单位占场";
    staffReservationSubmit.textContent = "保存占场";
    staffReservationCancelEdit.hidden = true;
    const window = nextAdminSchedulingWindow(new Date(), 60, selectedDate.value || shanghaiDate());
    staffReservationDate.value = window.date;
    staffReservationStart.value = window.startTime;
    staffReservationEnd.value = window.endTime;
    staffReservationCourt.value = "01";
  };
  const editStaffReservation = (booking: AdminBooking) => {
    if (booking.bookingKind !== "staff_reservation") return;
    editingStaffReservation = booking;
    required<HTMLInputElement>("admin-staff-reservation-title").value = booking.staffReservationTitle ?? "";
    staffReservationDate.value = booking.date;
    staffReservationStart.value = shanghaiTime(booking.startAt);
    staffReservationEnd.value = shanghaiTime(booking.endAt);
    staffReservationCourt.value = booking.courtId ?? "01";
    required("admin-staff-reservation-form-title").textContent = "修改单位占场";
    staffReservationSubmit.textContent = "保存修改";
    staffReservationCancelEdit.hidden = false;
    required("admin-staff-reservation-form").scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const resetTimeBlockForm = () => {
    editingTimeBlock = null;
    required<HTMLFormElement>("admin-time-block-form").reset();
    required("admin-time-block-form-title").textContent = "临时关闭时段";
    timeBlockSubmit.textContent = "关闭时段";
    timeBlockCancelEdit.hidden = true;
    const window = nextAdminSchedulingWindow(new Date(), 30, selectedDate.value || shanghaiDate());
    timeBlockDate.value = window.date;
    timeBlockStart.value = window.startTime;
    timeBlockEnd.value = window.endTime;
    timeBlockCourt.value = "01";
    timeBlockDate.disabled = false;
    timeBlockCourt.disabled = false;
  };
  const editTimeBlock = (block: AdminCourtTimeBlock) => {
    editingTimeBlock = block;
    timeBlockDate.value = block.date;
    timeBlockCourt.value = block.courtId;
    timeBlockStart.value = block.startTime;
    timeBlockEnd.value = block.endTime;
    timeBlockReason.value = block.reason ?? "";
    timeBlockDate.disabled = true;
    timeBlockCourt.disabled = true;
    required("admin-time-block-form-title").textContent = "修改关闭时段";
    timeBlockSubmit.textContent = "保存修改";
    timeBlockCancelEdit.hidden = false;
    required("admin-time-block-form").scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const renderTimeBlockList = () => {
    const container = required("admin-time-block-list");
    container.replaceChildren();
    if (!timeBlocks.length) {
      const empty = document.createElement("p");
      empty.className = "admin-empty";
      empty.textContent = "这一天没有临时关闭时段。";
      container.append(empty);
      return;
    }
    for (const block of timeBlocks) {
      const row = document.createElement("article");
      const label = document.createElement("strong");
      label.textContent = `场地 ${block.courtId} · ${block.startTime}–${block.endTime}`;
      const reason = document.createElement("span");
      reason.textContent = block.reason || "临时停用";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "修改";
      edit.disabled = savingTimeBlock;
      edit.addEventListener("click", () => editTimeBlock(block));
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "恢复开放";
      restore.disabled = savingTimeBlock;
      restore.addEventListener("click", () => {
        if (!window.confirm(`恢复场地 ${block.courtId} ${block.startTime}–${block.endTime} 开放吗？`)) return;
        savingTimeBlock = true;
        api.restoreCourtTimeBlock(block.id, {
          date: block.date,
          courtId: block.courtId,
          expectedVersion: inventoryVersions[block.courtId] ?? block.version,
        }).then(async () => {
          resetTimeBlockForm();
          await refresh();
          showMessage("该时段已恢复开放。");
        }).catch((error) => showMessage(`恢复失败：${String(error)}`, true))
          .finally(() => { savingTimeBlock = false; renderTimeBlockList(); });
      });
      row.append(label, reason, edit, restore);
      container.append(row);
    }
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

  const resetHonorForm = () => {
    editingHonor = null;
    required<HTMLFormElement>("admin-honor-upload-form").reset();
    required<HTMLInputElement>("admin-honor-year").value = shanghaiDate().slice(0, 4);
    required<HTMLInputElement>("admin-honor-sort").value = String(honorManifest.items.length + 1);
    required<HTMLInputElement>("admin-honor-file").required = true;
    required("admin-honor-form-title").textContent = "新增荣誉素材";
    honorSubmit.textContent = "上传并发布";
    honorCancelEdit.hidden = true;
  };
  const editHonor = (item: AdminHonorMediaItem) => {
    editingHonor = item;
    required<HTMLInputElement>("admin-honor-file").required = false;
    required<HTMLInputElement>("admin-honor-title").value = item.title;
    required<HTMLSelectElement>("admin-honor-owner").value = item.owner;
    required<HTMLInputElement>("admin-honor-year").value = String(item.year);
    required<HTMLTextAreaElement>("admin-honor-description").value = item.awardDescription;
    required<HTMLInputElement>("admin-honor-alt").value = item.altText;
    required<HTMLInputElement>("admin-honor-sort").value = String(item.sortOrder);
    required("admin-honor-form-title").textContent = "编辑荣誉信息";
    honorSubmit.textContent = "保存修改";
    honorCancelEdit.hidden = false;
    required("admin-honor-upload-form").scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const renderHonors = () => {
    required("admin-honor-count").textContent = `${honorManifest.items.length} 条`;
    renderHonorMediaAdmin(required("admin-honor-list"), honorManifest, (action, item) => {
      if (action === "edit") { editHonor(item); return; }
      runHonorAction(action, item).catch((error) => showHonorStatus(mediaErrorMessage(error), true));
    });
  };
  const refreshHonors = async () => {
    try {
      honorManifest = await api.getHonorMedia() as AdminHonorMediaManifest;
      renderHonors();
    } catch (error) {
      renderHonorMediaAdmin(required("admin-honor-list"), { version: 0, items: [] }, () => undefined);
      showHonorStatus(mediaErrorMessage(error), true);
    }
  };
  async function runHonorAction(action: "publish" | "unpublish" | "delete", item: AdminHonorMediaItem) {
    if (honorBusy) return;
    const label = action === "publish" ? "发布" : action === "unpublish" ? "下架" : "删除";
    if (!window.confirm(`${label}“${item.title}”？`)) return;
    honorBusy = true;
    try {
      if (action === "delete") await api.deleteHonorMedia(item.id, honorManifest.version);
      else await api.setHonorMediaPublished(item.id, action === "publish", honorManifest.version);
      await refreshHonors();
      showHonorStatus(`${label}成功。`);
    } finally { honorBusy = false; }
  }
  const honorFields = () => ({
    title: required<HTMLInputElement>("admin-honor-title").value.trim(),
    owner: required<HTMLSelectElement>("admin-honor-owner").value as AdminHonorMediaItem["owner"],
    year: Number(required<HTMLInputElement>("admin-honor-year").value),
    awardDescription: required<HTMLTextAreaElement>("admin-honor-description").value.trim(),
    altText: required<HTMLInputElement>("admin-honor-alt").value.trim(),
    sortOrder: Number(required<HTMLInputElement>("admin-honor-sort").value),
  });
  async function submitHonor() {
    if (honorBusy) return;
    honorBusy = true;
    honorSubmit.disabled = true;
    const wasEditing = Boolean(editingHonor);
    try {
      const fields = honorFields();
      if (editingHonor) {
        await api.updateHonorMedia(editingHonor.id, { ...fields, expectedManifestVersion: honorManifest.version });
      } else {
        const file = required<HTMLInputElement>("admin-honor-file").files?.[0];
        if (!file) throw new Error("INVALID_MEDIA_INPUT");
        await uploadHonorMedia({ api, file, ...fields, expectedManifestVersion: honorManifest.version, publish: true });
      }
      await refreshHonors();
      resetHonorForm();
      showHonorStatus(wasEditing ? "修改成功。" : "上传成功，荣誉已发布。" );
    } catch (error) {
      await refreshHonors().catch(() => undefined);
      throw error;
    } finally { honorBusy = false; honorSubmit.disabled = false; }
  }

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
    const mediaDate = required<HTMLInputElement>("admin-media-date").value;
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
        mediaDate,
        expectedManifestVersion: mediaManifest.version,
        publish: true,
      });
      required<HTMLFormElement>("admin-media-upload-form").reset();
      required<HTMLInputElement>("admin-media-date").value = shanghaiDate();
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

  const loadSelectedCustomerHistory = async () => {
    const bookingId = selected?.id;
    if (!bookingId) return;
    selectedCustomerHistory = [];
    renderCustomerHistory(required("admin-customer-history"), selected, [], "loading");
    try {
      const page = normalizeBookingPage(await api.getCustomerHistory(bookingId, 50) as
        AdminBooking[] | { items?: AdminBooking[]; nextCursor?: string | null });
      if (selected?.id !== bookingId) return;
      selectedCustomerHistory = page.items;
      renderCustomerHistory(
        required("admin-customer-history"),
        selected,
        selectedCustomerHistory,
      );
    } catch {
      if (selected?.id !== bookingId) return;
      renderCustomerHistory(required("admin-customer-history"), selected, [], "error");
    }
  };

  const onSelect = (booking: AdminBooking) => {
    selected = booking;
    selectedAudits = [];
    selectedCustomerHistory = [];
    renderBookingDetail(required("admin-booking-detail"), booking, selectedAudits);
    renderBookingList(required("admin-booking-list"), bookings, onSelect, booking.id);
    renderCustomerHistory(required("admin-customer-history"), booking, [], "loading");
    renderActions();
    loadSelectedAudits()
      .catch((error) => showMessage(String(error), true));
    loadSelectedCustomerHistory().catch(() => undefined);
    if (booking.bookingKind === "staff_reservation") {
      renderCustomerHistory(required("admin-customer-history"), null, []);
    }
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
    renderBookingList(required("admin-booking-list"), bookings, onSelect, selected?.id);
    renderCourtMatrix(
      required("admin-court-matrix"),
      selectedDashboard.date,
      matrixBookings,
      onSelect,
      timeBlocks,
      editTimeBlock,
    );
    renderTimeBlockList();
    if (selected) {
      selected = retainSelectedBooking(
        selected,
        [...bookings, ...matrixBookings, ...todayDashboard.pending],
      );
    }
    renderBookingDetail(required("admin-booking-detail"), selected, selectedAudits);
    renderCustomerHistory(required("admin-customer-history"), selected, selectedCustomerHistory);
    renderRecordView();
    renderRecordSummary();
    renderActions();
    renderSettings();
  };

  const filters = () => {
    if (!recordFrom.value || !recordTo.value) applyRecordWeek(0);
    return {
      from: recordFrom.value,
      to: recordTo.value,
      status: required<HTMLSelectElement>("admin-filter-status").value,
      mode: required<HTMLSelectElement>("admin-filter-mode").value,
      q: required<HTMLInputElement>("admin-filter-query").value.trim(),
      archive: recordView,
    };
  };

  const refreshRecords = async (append = false) => {
    if (recordLoading) return;
    recordLoading = true;
    renderRecordSummary();
    try {
      const page = normalizeBookingPage(await api.listBookings({
        ...filters(),
        ...(append && recordNextCursor ? { cursor: recordNextCursor } : {}),
        limit: 50,
      }) as AdminBooking[] | {
        items?: AdminBooking[];
        nextCursor?: string | null;
        hasMore?: boolean;
      });
      bookings = append
        ? [...bookings, ...page.items.filter((candidate) =>
            !bookings.some((booking) => booking.id === candidate.id)
          )]
        : page.items;
      recordNextCursor = page.nextCursor;
      recordHasMore = page.hasMore;
      selected = retainSelectedBooking(selected, bookings);
      renderBookingList(required("admin-booking-list"), bookings, onSelect, selected?.id);
      renderBookingDetail(required("admin-booking-detail"), selected, selectedAudits);
      renderCustomerHistory(required("admin-customer-history"), selected, selectedCustomerHistory);
      renderActions();
    } finally {
      recordLoading = false;
      renderRecordSummary();
    }
  };

  const refresh = async () => {
    const today = shanghaiDate();
    const date = selectedDate.value || today;
    const bootstrap = await api.getBootstrap(today, {
      date,
    }) as Bootstrap;
    todayDashboard = bootstrap.todayDashboard;
    selectedDashboard = bootstrap.selectedDashboard;
    matrixBookings = Array.isArray(bootstrap.matrixBookings)
      ? bootstrap.matrixBookings
      : bootstrap.matrixBookings?.bookings ?? [];
    timeBlocks = Array.isArray(bootstrap.matrixBookings)
      ? []
      : bootstrap.matrixBookings?.timeBlocks ?? [];
    inventoryVersions = Array.isArray(bootstrap.matrixBookings)
      ? {}
      : bootstrap.matrixBookings?.inventoryVersions ?? {};
    settings = bootstrap.settings;
    courtDraft = {};
    renderAll();
    await Promise.all([refreshMedia(), refreshHonors(), refreshRecords()]);
    if (selected) await Promise.all([loadSelectedAudits(), loadSelectedCustomerHistory()]);
  };

  async function runBookingAction(action: string, label: string) {
    if (!selected || activeAction) return;
    const target = selected;
    const body: Record<string, unknown> = { expectedVersion: target.version };
    const prompt = action === "archive"
      ? `删除“${target.name?.trim() || target.displayCode || "已脱敏预约"}”的预约记录？\n\n记录将移入回收站，可以恢复；客户历史和操作记录不会丢失。`
      : action === "restore"
        ? `恢复“${target.name?.trim() || target.displayCode || "已脱敏预约"}”的预约记录？`
        : confirmationMessage(target, label);
    if (!window.confirm(prompt)) return;
    activeAction = action;
    renderActions();
    if (window.matchMedia("(max-width: 760px)").matches) {
      required("admin-booking-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    try {
      const updated = action === "archive"
        ? await api.archiveBooking(target.id, target.version)
        : action === "restore"
          ? await api.restoreBooking(target.id, target.version)
          : await api.mutateBooking(target.id, action, body);
      if (action === "archive" || action === "restore") {
        bookings = bookings.filter((booking) => booking.id !== target.id);
        recordHasMore = Boolean(recordNextCursor) || recordHasMore;
      }
      if (selected?.id === target.id) {
        selected = action === "archive" || action === "restore"
          ? null
          : updated as AdminBooking;
        selectedAudits = [];
        if (action === "archive" || action === "restore") selectedCustomerHistory = [];
        renderBookingDetail(required("admin-booking-detail"), selected, selectedAudits);
        renderCustomerHistory(required("admin-customer-history"), selected, selectedCustomerHistory);
      }
      if (action === "archive" || action === "restore") {
        renderBookingList(required("admin-booking-list"), bookings, onSelect);
        renderRecordSummary();
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

  async function saveStaffReservation() {
    if (savingStaffReservation) return;
    const title = required<HTMLInputElement>("admin-staff-reservation-title").value.trim();
    const date = staffReservationDate.value;
    const startTime = staffReservationStart.value;
    const endTime = staffReservationEnd.value;
    const courtId = staffReservationCourt.value;
    if (!title || !date || !startTime || !endTime || !courtId || endTime <= startTime) {
      showMessage("请填写名称、日期、场地，并确保结束时间晚于开始时间。", true);
      return;
    }
    const editing = editingStaffReservation;
    savingStaffReservation = true;
    staffReservationSubmit.disabled = true;
    staffReservationCancelEdit.disabled = true;
    staffReservationSubmit.textContent = editing ? "正在保存修改…" : "正在锁定场地…";
    try {
      const body = { title, date, startTime, endTime, courtId };
      const updated = editing
        ? await api.updateStaffReservation(editing.id, {
            ...body,
            expectedVersion: editing.version,
          })
        : await api.createStaffReservation(body);
      selectedDate.value = date;
      resetStaffReservationForm();
      selected = updated as AdminBooking;
      await refresh();
      showMessage(editing ? "单位占场已修改，旧时段已释放。" : "单位占场已保存并锁定。", false);
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      showMessage(
        /SESSION_FULL/.test(code)
          ? "该场地与已有预约或关闭时段冲突，请换时间或场地。"
          : /CONFLICT/.test(code)
            ? "这条占场刚被其他人修改，请刷新后再试。"
            : `占场未保存：${code}`,
        true,
      );
    } finally {
      savingStaffReservation = false;
      staffReservationSubmit.disabled = false;
      staffReservationCancelEdit.disabled = false;
      staffReservationSubmit.textContent = editingStaffReservation ? "保存修改" : "保存占场";
    }
  }

  async function saveTimeBlock() {
    if (savingTimeBlock) return;
    const date = timeBlockDate.value;
    const courtId = timeBlockCourt.value;
    const startTime = timeBlockStart.value;
    const endTime = timeBlockEnd.value;
    const reason = timeBlockReason.value;
    if (!date || !courtId || !startTime || !endTime || endTime <= startTime) {
      showMessage("请选择日期、场地，并确保结束时间晚于开始时间。", true);
      return;
    }
    const editing = editingTimeBlock;
    savingTimeBlock = true;
    timeBlockSubmit.disabled = true;
    timeBlockCancelEdit.disabled = true;
    try {
      if (editing) {
        await api.updateCourtTimeBlock(editing.id, {
          date, courtId, startTime, endTime, ...(reason ? { reason } : {}),
          expectedVersion: inventoryVersions[editing.courtId] ?? editing.version,
        });
      } else {
        await api.createCourtTimeBlocks({
          date, courtIds: [courtId], startTime, endTime, ...(reason ? { reason } : {}),
          expectedVersions: { [courtId]: inventoryVersions[courtId] ?? 0 },
        });
      }
      selectedDate.value = date;
      resetTimeBlockForm();
      await refresh();
      showMessage(editing ? "关闭时段已修改。" : "时段已关闭，预约页会立即排除该场地。", false);
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      showMessage(
        /CONFLICT/.test(code)
          ? "该时段已有预约、候选改期或刚被其他管理员修改，请刷新后重选。"
          : /SESSION_CLOSED/.test(code)
            ? "场地库存尚未准备好，请稍后刷新重试。"
            : `关闭时段未保存：${code}`,
        true,
      );
    } finally {
      savingTimeBlock = false;
      timeBlockSubmit.disabled = false;
      timeBlockCancelEdit.disabled = false;
      timeBlockSubmit.textContent = editingTimeBlock ? "保存修改" : "关闭时段";
      renderTimeBlockList();
    }
  }

  function renderActions() {
    const detail = required("admin-booking-detail");
    detail.querySelector(".admin-detail-actions")?.remove();
    if (!selected) return;
    const actions = document.createElement("div");
    actions.className = "admin-detail-actions";
    const selectedView: BookingRecordView = selected.archivedAt ? "archived" : "active";
    const definitions = [
      ...(selectedView === "active" ? bookingActionsFor(selected) : []),
      ...bookingRecordActionsFor(selected),
    ];
    if (
      selectedView === "active" &&
      selected.bookingKind === "staff_reservation" &&
      selected.status === "confirmed"
    ) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.disabled = activeAction !== null || savingStaffReservation;
      editButton.dataset.adminAction = "edit-staff-reservation";
      editButton.textContent = "修改占场";
      editButton.addEventListener("click", () => editStaffReservation(selected as AdminBooking));
      actions.append(editButton);
    }
    for (const [action, label] of definitions) {
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = activeAction !== null;
      button.dataset.adminAction = action;
      if (action === "archive") button.classList.add("admin-danger-button");
      button.textContent = activeAction === action ? `${label}处理中…` : label;
      button.addEventListener("click", () => {
        runBookingAction(action, label).catch((error) => showMessage(String(error), true));
      });
      actions.append(button);
    }
    if (
      selectedView === "active" &&
      selected.status !== "cancelled" &&
      selected.status !== "completed"
    ) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.disabled = true;
      deleteButton.className = "admin-danger-button";
      deleteButton.textContent = "删除记录";
      deleteButton.title = "请先取消或完结当前预约";
      actions.append(deleteButton);
      const hint = document.createElement("p");
      hint.className = "admin-detail-action-help";
      hint.textContent = "当前预约需先取消或完结，之后才能删除到可恢复的回收站。";
      actions.append(hint);
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
    recordNextCursor = null;
    refreshRecords().catch((error) => showMessage(String(error), true));
  });
  required<HTMLFormElement>("admin-matrix-form").addEventListener("submit", (event) => {
    event.preventDefault();
    refresh().catch((error) => showMessage(String(error), true));
  });
  required<HTMLFormElement>("admin-staff-reservation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveStaffReservation().catch((error) => showMessage(String(error), true));
  });
  required<HTMLFormElement>("admin-time-block-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveTimeBlock().catch((error) => showMessage(String(error), true));
  });
  timeBlockCancelEdit.addEventListener("click", resetTimeBlockForm);
  timeBlockDate.addEventListener("change", () => {
    if (!editingTimeBlock) selectedDate.value = timeBlockDate.value;
  });
  staffReservationCancelEdit.addEventListener("click", resetStaffReservationForm);
  staffReservationDate.addEventListener("change", () => {
    if (!editingStaffReservation) selectedDate.value = staffReservationDate.value;
  });
  required<HTMLButtonElement>("admin-load-more").addEventListener("click", () => {
    refreshRecords(true).catch((error) => showMessage(String(error), true));
  });
  const setRecordView = (view: BookingRecordView) => {
    if (recordView === view || recordLoading) return;
    recordView = view;
    selected = null;
    selectedAudits = [];
    selectedCustomerHistory = [];
    recordNextCursor = null;
    bookings = [];
    recordHasMore = false;
    renderAll();
    refreshRecords().catch((error) => showMessage(String(error), true));
  };
  required<HTMLButtonElement>("admin-record-view-active").addEventListener("click", () => setRecordView("active"));
  required<HTMLButtonElement>("admin-record-view-archived").addEventListener("click", () => setRecordView("archived"));
  required<HTMLButtonElement>("admin-filter-reset").addEventListener("click", () => {
    required<HTMLFormElement>("admin-filter-form").reset();
    applyRecordWeek(0);
    recordNextCursor = null;
    refreshRecords().catch((error) => showMessage(String(error), true));
  });
  const setRange = (days: string) => {
    applyRecordRange(days as "today" | "7" | "30" | "all");
    recordNextCursor = null;
    refreshRecords().catch((error) => showMessage(String(error), true));
  };
  document.querySelectorAll<HTMLButtonElement>("[data-record-range]").forEach((button) => {
    button.addEventListener("click", () => setRange(button.dataset.recordRange ?? "all"));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-record-week]").forEach((button) => {
    button.addEventListener("click", () => {
      applyRecordWeek(Number.parseInt(button.dataset.recordWeek ?? "0", 10) || 0);
      recordNextCursor = null;
      refreshRecords().catch((error) => showMessage(String(error), true));
    });
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
  required<HTMLFormElement>("admin-honor-upload-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitHonor().catch((error) => showHonorStatus(mediaErrorMessage(error), true));
  });
  honorCancelEdit.addEventListener("click", resetHonorForm);
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
