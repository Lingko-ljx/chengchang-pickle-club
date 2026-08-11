export const PUBLIC_CHANNEL_QUERY_PARAMETER = "src";
export const PUBLIC_BOOKING_ANCHOR = "booking";
export const PUBLIC_BOOKING_STATUS_ROUTE = "booking/status/";
export const WECHAT_MENU_CHANNEL = "wx_menu";
export const WECHAT_QR_CHANNEL = "wx_qr";

export type PublicChannelSource =
  | typeof WECHAT_MENU_CHANNEL
  | typeof WECHAT_QR_CHANNEL;

const PUBLIC_LINK_QUERY_ALLOWLIST = new Set(["code"]);
const PUBLIC_BOOKING_CODE = /^[A-Za-z0-9_-]{1,64}$/;

export function resolvePublicChannelSource(
  value: unknown,
): PublicChannelSource | null {
  return value === WECHAT_MENU_CHANNEL || value === WECHAT_QR_CHANNEL
    ? value
    : null;
}

function publicChannelSourceOrThrow(value: unknown): PublicChannelSource {
  const source = resolvePublicChannelSource(value);
  if (!source) throw new Error("Invalid public channel source");
  return source;
}

function cleanSiteUrl(siteUrl: string): URL {
  const url = new URL(siteUrl);
  const developmentLoopback =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !developmentLoopback) {
    throw new Error("Invalid public site URL");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url;
}

export function buildPublicBookingEntryUrl(
  siteUrl: string,
  sourceValue: unknown,
): string {
  const source = publicChannelSourceOrThrow(sourceValue);
  const url = cleanSiteUrl(siteUrl);
  url.searchParams.set(PUBLIC_CHANNEL_QUERY_PARAMETER, source);
  url.hash = PUBLIC_BOOKING_ANCHOR;
  return url.toString();
}

export function buildPublicBookingStatusUrl(
  siteUrl: string,
  sourceValue: unknown,
): string {
  const source = publicChannelSourceOrThrow(sourceValue);
  const url = new URL(PUBLIC_BOOKING_STATUS_ROUTE, cleanSiteUrl(siteUrl));
  url.searchParams.set(PUBLIC_CHANNEL_QUERY_PARAMETER, source);
  return url.toString();
}

export function sanitizePublicChannelPath(
  target: string,
  siteUrl: string,
  sourceValue: unknown,
  preserveParameters: readonly string[] = [],
): string {
  const source = publicChannelSourceOrThrow(sourceValue);
  const base = cleanSiteUrl(siteUrl);
  const url = new URL(target, base);
  if (url.origin !== base.origin) {
    throw new Error("Invalid public channel path");
  }

  const preserved = new URLSearchParams();
  for (const name of preserveParameters) {
    if (!PUBLIC_LINK_QUERY_ALLOWLIST.has(name)) continue;
    const values = url.searchParams.getAll(name);
    if (
      name === "code" &&
      values.length === 1 &&
      PUBLIC_BOOKING_CODE.test(values[0])
    ) {
      preserved.set(name, values[0]);
    }
  }
  preserved.set(PUBLIC_CHANNEL_QUERY_PARAMETER, source);
  url.search = preserved.toString();

  return `${url.pathname}${url.search}${url.hash}`;
}

export function publicWechatEntryUrls(siteUrl: string) {
  return {
    menuBooking: buildPublicBookingEntryUrl(siteUrl, WECHAT_MENU_CHANNEL),
    menuStatus: buildPublicBookingStatusUrl(siteUrl, WECHAT_MENU_CHANNEL),
    qrBooking: buildPublicBookingEntryUrl(siteUrl, WECHAT_QR_CHANNEL),
  } as const;
}
