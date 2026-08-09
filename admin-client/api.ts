export type BookingFilters = {
  date?: string;
  status?: string;
  mode?: string;
  q?: string;
};

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

  const query = (values: Record<string, string | undefined>) => {
    const parameters = new URLSearchParams();
    for (const [name, value] of Object.entries(values)) {
      if (value) parameters.set(name, value);
    }
    const encoded = parameters.toString();
    return encoded ? `?${encoded}` : "";
  };

  const json = (method: string, body: Record<string, unknown>): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  return {
    getDashboard: (date: string) => request(`/v1/admin/dashboard${query({ date })}`),
    listBookings: (filters: BookingFilters) =>
      request(`/v1/admin/bookings${query(filters)}`),
    getSettings: () => request("/v1/admin/settings"),
    getAuditLogs: (bookingId: string) =>
      request(`/v1/admin/bookings/${encodeURIComponent(bookingId)}/audit-logs`),
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
  };
}
