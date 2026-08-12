export type BookingFilters = {
  date?: string;
  from?: string;
  to?: string;
  status?: string;
  mode?: string;
  q?: string;
  archive?: "active" | "archived" | "all";
  cursor?: string;
  limit?: number;
};

export type AdminBootstrapFilters = BookingFilters & { date: string };

export type AdminApiClientOptions = {
  baseUrl: string;
  getAccessToken: () => string;
  onUnauthorized: () => void | Promise<void>;
  fetchImpl?: typeof fetch;
};

export class AdminApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function createAdminApiClient(options: AdminApiClientOptions) {
  const request = async (path: string, init: RequestInit = {}) => {
    const token = options.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    const response = await (options.fetchImpl ?? fetch)(
      `${options.baseUrl.replace(/\/+$/, "")}${path}`,
      { ...init, headers },
    );
    if (response.status === 401) await options.onUnauthorized();
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as {
        error?: { code?: string };
      };
      throw new AdminApiError(
        payload.error?.code ?? `HTTP_${response.status}`,
        response.status,
      );
    }
    if (response.headers.get("content-type")?.includes("text/csv")) {
      return response.blob();
    }
    const payload = await response.json() as { data: unknown };
    return payload.data;
  };

  const query = (values: Record<string, string | number | undefined>) => {
    const parameters = new URLSearchParams();
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined && value !== "") parameters.set(name, String(value));
    }
    const encoded = parameters.toString();
    return encoded ? `?${encoded}` : "";
  };

  const json = (method: string, body: object): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  return {
    getBootstrap: (today: string, filters: AdminBootstrapFilters) =>
      request(`/v1/admin/bootstrap${query({ today, ...filters })}`),
    getDashboard: (date: string) => request(`/v1/admin/dashboard${query({ date })}`),
    getMatrixBookings: (date: string) => request(`/v1/admin/matrix${query({ date })}`),
    listBookings: (filters: BookingFilters) =>
      request(`/v1/admin/bookings${query(filters)}`),
    archiveBooking: (bookingId: string, expectedVersion: number) =>
      request(
        `/v1/admin/bookings/${encodeURIComponent(bookingId)}/archive`,
        json("POST", { expectedVersion }),
      ),
    restoreBooking: (bookingId: string, expectedVersion: number) =>
      request(
        `/v1/admin/bookings/${encodeURIComponent(bookingId)}/restore`,
        json("POST", { expectedVersion }),
      ),
    createStaffReservation: (body: {
      title: string;
      date: string;
      startTime: string;
      endTime: string;
      courtId: string;
    }) => request("/v1/admin/staff-reservations", json("POST", body)),
    updateStaffReservation: (
      bookingId: string,
      body: {
        title: string;
        date: string;
        startTime: string;
        endTime: string;
        courtId: string;
        expectedVersion: number;
      },
    ) => request(
      `/v1/admin/staff-reservations/${encodeURIComponent(bookingId)}`,
      json("PUT", body),
    ),
    createCourtTimeBlocks: (body: {
      date: string;
      courtIds: string[];
      startTime: string;
      endTime: string;
      reason?: string;
      expectedVersions: Record<string, number>;
    }) => request("/v1/admin/court-time-blocks", json("POST", body)),
    updateCourtTimeBlock: (
      blockId: string,
      body: {
        date: string;
        courtId: string;
        startTime: string;
        endTime: string;
        reason?: string;
        expectedVersion: number;
      },
    ) => request(
      `/v1/admin/court-time-blocks/${encodeURIComponent(blockId)}`,
      json("PUT", body),
    ),
    restoreCourtTimeBlock: (
      blockId: string,
      body: { date: string; courtId: string; expectedVersion: number },
    ) => request(
      `/v1/admin/court-time-blocks/${encodeURIComponent(blockId)}`,
      json("DELETE", body),
    ),
    getSettings: () => request("/v1/admin/settings"),
    getAuditLogs: (bookingId: string) =>
      request(`/v1/admin/bookings/${encodeURIComponent(bookingId)}/audit-logs`),
    getCustomerHistory: (bookingId: string, limit = 50) =>
      request(
        `/v1/admin/bookings/${encodeURIComponent(bookingId)}/customer-history${query({ limit })}`,
      ),
    mutateBooking: (
      bookingId: string,
      action: string,
      body: Record<string, unknown>,
    ) => request(
      `/v1/admin/bookings/${encodeURIComponent(bookingId)}/${action}`,
      json("POST", body),
    ),
    setCourtEnabled: (courtId: string, enabled: boolean, expectedVersion: number) =>
      request(
        `/v1/admin/courts/${encodeURIComponent(courtId)}`,
        json("PUT", { enabled, expectedVersion }),
      ),
    setSessionTemplateEnabled: (
      templateId: string,
      enabled: boolean,
      expectedVersion: number,
    ) => request(
      `/v1/admin/session-templates/${encodeURIComponent(templateId)}`,
      json("PUT", { enabled, expectedVersion }),
    ),
    exportCsv: (from: string, to: string) =>
      request(`/v1/admin/export.csv${query({ from, to })}`),
    getHomepageMedia: () => request("/v1/admin/homepage-media"),
    createMediaUploadIntent: (body: Record<string, unknown>) =>
      request("/v1/admin/homepage-media/upload-intents", json("POST", body)),
    finalizeMediaUpload: (
      itemId: string,
      expectedManifestVersion: number,
      publish: boolean,
    ) => request(
      `/v1/admin/homepage-media/${encodeURIComponent(itemId)}/finalize`,
      json("POST", { expectedManifestVersion, publish }),
    ),
    setHomepageMediaPublished: (
      itemId: string,
      published: boolean,
      expectedManifestVersion: number,
    ) => request(
      `/v1/admin/homepage-media/${encodeURIComponent(itemId)}/publication`,
      json("PUT", { published, expectedManifestVersion }),
    ),
    setHomepageMediaPinned: (
      itemId: string,
      pinned: boolean,
      expectedManifestVersion: number,
    ) => request(
      `/v1/admin/homepage-media/${encodeURIComponent(itemId)}/pin`,
      json("PUT", { pinned, expectedManifestVersion }),
    ),
    deleteHomepageMedia: (itemId: string, expectedManifestVersion: number) =>
      request(
        `/v1/admin/homepage-media/${encodeURIComponent(itemId)}/delete`,
        json("POST", { expectedManifestVersion }),
      ),
  };
}
