import path from "node:path";
import { pathToFileURL } from "node:url";

const smokeDate = "2099-01-01";
const defaultAttempts = 30;
const defaultRetryDelayMs = 10_000;
const defaultRequestTimeoutMs = 10_000;
const maximumHtmlBytes = 2_000_000;

function invalidConfiguration() {
  throw new Error("Invalid CloudBase hosting configuration");
}

function requiredHttpsRoot(environment, name) {
  const candidate = environment[name]?.trim();
  if (!candidate || /[\r\n]/.test(candidate)) invalidConfiguration();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    invalidConfiguration();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    invalidConfiguration();
  }
  return parsed;
}

export function readCloudBaseHostingConfiguration(environment = process.env) {
  const site = requiredHttpsRoot(environment, "CLOUDBASE_SITE_URL");
  const api = requiredHttpsRoot(environment, "BOOKING_API_BASE_URL");
  const envId = environment.CLOUDBASE_ENV_ID?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(envId)) invalidConfiguration();
  return {
    siteUrl: `${site.origin}/`,
    apiBaseUrl: api.origin,
    envId,
  };
}

function retryOptions(options) {
  const attempts = options.attempts ?? defaultAttempts;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > defaultAttempts) {
    throw new Error("Invalid smoke verification options");
  }
  return {
    attempts,
    delay:
      options.delay ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
    retryDelayMs: options.retryDelayMs ?? defaultRetryDelayMs,
    requestTimeoutMs: options.requestTimeoutMs ?? defaultRequestTimeoutMs,
  };
}

async function boundedRetry(operation, options, failureMessage) {
  const { attempts, delay, retryDelayMs } = retryOptions(options);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch {
      if (attempt === attempts) break;
      await delay(retryDelayMs);
    }
  }
  throw new Error(failureMessage);
}

function requestSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

async function html(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    headers: { Accept: "text/html", "Cache-Control": "no-cache" },
    redirect: "error",
    signal: requestSignal(timeoutMs),
  });
  if (!response.ok || !/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) {
    throw new Error("INVALID_HTML_RESPONSE");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumHtmlBytes) {
    throw new Error("HTML_RESPONSE_TOO_LARGE");
  }
  const body = await response.text();
  if (body.length === 0 || body.length > maximumHtmlBytes) {
    throw new Error("INVALID_HTML_RESPONSE");
  }
  return body;
}

const forbiddenStaticContent =
  /\/_next\/static\/chunks\/|self\.__next|__next_f|modulepreload|BOOKING_ADMIN_USER_IDS|BOOKING_SES_SECRET|TENCENTCLOUD_SECRET|PHONE_HASH_SALT|RATE_LIMIT_SALT|IDEMPOTENCY_SALT|AKID[A-Za-z0-9]+|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i;

function verifyRootHtml(body, configuration) {
  if (
    !body.includes(`action="${configuration.apiBaseUrl}/v1/bookings"`) ||
    !body.includes(
      `data-availability-url="${configuration.apiBaseUrl}/v1/availability"`,
    ) ||
    !/\bdata-booking-form-client(?:\s|=|>)/i.test(body) ||
    forbiddenStaticContent.test(body)
  ) {
    throw new Error("INVALID_ROOT_HTML");
  }
}

function verifyAdminHtml(body, configuration) {
  if (
    !body.includes(`data-api-base-url="${configuration.apiBaseUrl}"`) ||
    !body.includes(`data-cloudbase-env-id="${configuration.envId}"`) ||
    !/\bdata-admin-client(?:\s|=|>)/i.test(body) ||
    forbiddenStaticContent.test(body)
  ) {
    throw new Error("INVALID_ADMIN_HTML");
  }
}

export async function verifyCloudBaseHosting(configuration, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { requestTimeoutMs } = retryOptions(options);
  await boundedRetry(
    async () => {
      const root = await html(fetchImpl, configuration.siteUrl, requestTimeoutMs);
      verifyRootHtml(root, configuration);
      const admin = await html(
        fetchImpl,
        new URL("admin/", configuration.siteUrl).toString(),
        requestTimeoutMs,
      );
      verifyAdminHtml(admin, configuration);
    },
    options,
    "CloudBase hosting smoke verification failed",
  );
}

function commaSeparatedHeader(response, name) {
  return new Set(
    (response.headers.get(name) ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function verifyPreflight({
  fetchImpl,
  url,
  siteOrigin,
  requestedMethod,
  requestedHeaders,
  requiredMethods,
  requiredHeaders,
  requestTimeoutMs,
}) {
  const response = await fetchImpl(url, {
    method: "OPTIONS",
    headers: {
      Origin: siteOrigin,
      "Access-Control-Request-Method": requestedMethod,
      "Access-Control-Request-Headers": requestedHeaders.join(","),
    },
    redirect: "error",
    signal: requestSignal(requestTimeoutMs),
  });
  const methods = commaSeparatedHeader(response, "access-control-allow-methods");
  const headers = commaSeparatedHeader(response, "access-control-allow-headers");
  if (
    response.status !== 204 ||
    response.headers.get("access-control-allow-origin") !== siteOrigin ||
    requiredMethods.some((method) => !methods.has(method.toLowerCase())) ||
    requiredHeaders.some((header) => !headers.has(header.toLowerCase()))
  ) {
    throw new Error("INVALID_PREFLIGHT_RESPONSE");
  }
}

export async function verifyCloudBaseApi(configuration, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { requestTimeoutMs } = retryOptions(options);
  const siteOrigin = new URL(configuration.siteUrl).origin;
  await boundedRetry(
    async () => {
      await verifyPreflight({
        fetchImpl,
        url: `${configuration.apiBaseUrl}/v1/bookings`,
        siteOrigin,
        requestedMethod: "POST",
        requestedHeaders: ["content-type", "idempotency-key"],
        requiredMethods: ["POST", "OPTIONS"],
        requiredHeaders: ["Content-Type", "Idempotency-Key"],
        requestTimeoutMs,
      });
      await verifyPreflight({
        fetchImpl,
        url: `${configuration.apiBaseUrl}/v1/admin/dashboard`,
        siteOrigin,
        requestedMethod: "GET",
        requestedHeaders: ["authorization", "content-type"],
        requiredMethods: ["GET", "POST", "PUT", "OPTIONS"],
        requiredHeaders: ["Authorization", "Content-Type"],
        requestTimeoutMs,
      });
      const response = await fetchImpl(
        `${configuration.apiBaseUrl}/v1/availability?date=${smokeDate}`,
        {
          headers: { Accept: "application/json", Origin: siteOrigin },
          redirect: "error",
          signal: requestSignal(requestTimeoutMs),
        },
      );
      if (
        !response.ok ||
        !/^application\/json\b/i.test(response.headers.get("content-type") ?? "") ||
        response.headers.get("access-control-allow-origin") !== siteOrigin
      ) {
        throw new Error("INVALID_API_RESPONSE");
      }
      const body = await response.json();
      if (!body || typeof body !== "object" || !Array.isArray(body.data) || body.data.length === 0) {
        throw new Error("INVALID_API_RESPONSE");
      }
    },
    options,
    "CloudBase public API smoke verification failed",
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    const configuration = readCloudBaseHostingConfiguration(process.env);
    if (process.argv[2] === "--check-config") {
      process.stdout.write("CloudBase hosting configuration verified\n");
    } else if (process.argv[2] === "--api-smoke") {
      await verifyCloudBaseApi(configuration);
      process.stdout.write("CloudBase public API smoke verified\n");
    } else if (process.argv[2] === "--smoke") {
      await verifyCloudBaseHosting(configuration);
      process.stdout.write("CloudBase hosting smoke verified\n");
    } else {
      throw new Error("INVALID_MODE");
    }
  } catch {
    process.stderr.write("CloudBase hosting verification failed\n");
    process.exitCode = 1;
  }
}
