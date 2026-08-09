type BookingApiOptions = {
  development?: boolean;
  required?: boolean;
};

function invalidBookingApi(options: BookingApiOptions): string {
  if (options.required) {
    throw new Error(
      "NEXT_PUBLIC_BOOKING_API_BASE_URL must be a valid public booking API URL",
    );
  }
  return "";
}

export function resolveBookingApiBaseUrl(
  value?: string,
  options: BookingApiOptions = {},
): string {
  const candidate = value?.trim() ?? "";
  if (!candidate) return invalidBookingApi(options);
  const absoluteHttps = /^https:\/\//i.test(candidate);
  const absoluteDevelopmentHttp =
    options.development === true && /^http:\/\//i.test(candidate);
  if (!absoluteHttps && !absoluteDevelopmentHttp) {
    return invalidBookingApi(options);
  }

  try {
    const parsed = new URL(candidate);
    const secure = parsed.protocol === "https:";
    const developmentLoopback =
      options.development === true &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");

    if (
      (!secure && !developmentLoopback) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return invalidBookingApi(options);
    }

    return candidate;
  } catch {
    return invalidBookingApi(options);
  }
}

export function bookingCreateUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/bookings`;
}

export function bookingResultPath(basePath = ""): string {
  return `${basePath}/booking/result/`;
}

export function bookingStatusPath(basePath = ""): string {
  return `${basePath}/booking/status/`;
}

export function resolveBookingScriptSrc(basePath = ""): string {
  const normalizedBasePath =
    basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  return `${normalizedBasePath}/booking-form.js`;
}
