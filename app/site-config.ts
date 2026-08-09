export const DEFAULT_SITE_URL =
  "https://chengchang-pickle-club.hujingseuits.chatgpt.site/";

type SiteEnvironment = {
  GITHUB_PAGES?: string;
  NODE_ENV?: string;
  PAGES_BASE_PATH?: string;
  NEXT_PUBLIC_SITE_URL?: string;
};

export type SiteConfiguration = {
  basePath: string;
  siteUrl: string;
};

function configurationError(name: "PAGES_BASE_PATH" | "NEXT_PUBLIC_SITE_URL"): never {
  throw new Error(`${name} must be a valid public site directory configuration`);
}

export function resolvePagesBasePath(value?: string): string {
  const candidate = value?.trim() ?? "";
  if (candidate === "" || candidate === "/") return "";
  const normalized = candidate.replace(/\/+$/, "");
  const hasDotSegment = normalized
    .split("/")
    .some((segment) => segment === "." || segment === "..");
  if (
    hasDotSegment ||
    !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalized)
  ) {
    return configurationError("PAGES_BASE_PATH");
  }
  return normalized;
}

function resolveSiteUrl(
  value: string | undefined,
  basePath: string,
  options: { development: boolean; required: boolean },
): string {
  const candidate = value?.trim() ?? "";
  if (!candidate) {
    if (options.required) return configurationError("NEXT_PUBLIC_SITE_URL");
    if (basePath !== "") return configurationError("NEXT_PUBLIC_SITE_URL");
    return DEFAULT_SITE_URL;
  }
  if (
    /[\r\n?#]/.test(candidate) ||
    (!/^https:\/\//i.test(candidate) &&
      !(options.development && /^http:\/\//i.test(candidate)))
  ) {
    return configurationError("NEXT_PUBLIC_SITE_URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return configurationError("NEXT_PUBLIC_SITE_URL");
  }
  const developmentLoopback =
    options.development &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  const expectedPath = `${basePath}/`;
  const directoryPath = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  if (
    (parsed.protocol !== "https:" && !developmentLoopback) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    directoryPath !== expectedPath
  ) {
    return configurationError("NEXT_PUBLIC_SITE_URL");
  }

  parsed.pathname = expectedPath;
  return parsed.toString();
}

export function resolveSiteConfiguration(
  environment: SiteEnvironment,
): SiteConfiguration {
  const basePath = resolvePagesBasePath(environment.PAGES_BASE_PATH);
  return {
    basePath,
    siteUrl: resolveSiteUrl(environment.NEXT_PUBLIC_SITE_URL, basePath, {
      development: environment.NODE_ENV === "development",
      required: environment.GITHUB_PAGES === "true",
    }),
  };
}

export const siteConfiguration = resolveSiteConfiguration({
  GITHUB_PAGES: process.env.GITHUB_PAGES,
  NODE_ENV: process.env.NODE_ENV,
  PAGES_BASE_PATH: process.env.PAGES_BASE_PATH,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
});
