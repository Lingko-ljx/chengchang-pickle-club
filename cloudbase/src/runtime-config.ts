type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function requiredEnvironment(
  environment: RuntimeEnvironment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

function requiredShanghaiTimezone(
  environment: RuntimeEnvironment,
): "Asia/Shanghai" {
  const value = requiredEnvironment(environment, "DATA_TIMEZONE");
  if (value !== "Asia/Shanghai") {
    throw new Error("Invalid configuration: DATA_TIMEZONE");
  }
  return value;
}

function requiredCloudbaseEnvironmentId(environment: RuntimeEnvironment): string {
  const value = requiredEnvironment(environment, "CLOUDBASE_ENV_ID");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(value)) {
    throw new Error("Invalid configuration: CLOUDBASE_ENV_ID");
  }
  return value;
}

function invalidConfiguration(name: string): never {
  throw new Error(`Invalid configuration: ${name}`);
}

function requiredAllowedOrigins(environment: RuntimeEnvironment): string {
  const name = "PUBLIC_ALLOWED_ORIGINS";
  const raw = requiredEnvironment(environment, name);
  if (/[\r\n]/.test(raw)) invalidConfiguration(name);
  const candidates = raw.split(",").map((value) => value.trim());
  if (candidates.some((value) => value === "" || value === "*")) {
    invalidConfiguration(name);
  }
  const origins = candidates.map((candidate) => {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      invalidConfiguration(name);
    }
    const loopbackHttp =
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (
      (parsed.protocol !== "https:" && !loopbackHttp) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      invalidConfiguration(name);
    }
    return parsed.origin;
  });
  return [...new Set(origins)].join(",");
}

function requiredResultUrl(
  environment: RuntimeEnvironment,
  allowedOrigins: string,
): string {
  const name = "PUBLIC_RESULT_URL";
  const raw = requiredEnvironment(environment, name);
  if (/[\r\n?#]/.test(raw)) invalidConfiguration(name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    invalidConfiguration(name);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !new Set(allowedOrigins.split(",")).has(parsed.origin)
  ) {
    invalidConfiguration(name);
  }
  return parsed.toString();
}

export function readPublicRuntimeConfiguration(
  environment: RuntimeEnvironment,
) {
  const allowedOrigins = requiredAllowedOrigins(environment);
  return {
    rateLimitSalt: requiredEnvironment(environment, "RATE_LIMIT_SALT"),
    phoneHashSalt: requiredEnvironment(environment, "PHONE_HASH_SALT"),
    idempotencySalt: requiredEnvironment(environment, "IDEMPOTENCY_SALT"),
    allowedOrigins,
    resultUrl: requiredResultUrl(environment, allowedOrigins),
    timeZone: requiredShanghaiTimezone(environment),
  } as const;
}

export function readAdminRuntimeConfiguration(
  environment: RuntimeEnvironment,
) {
  return {
    envId: requiredCloudbaseEnvironmentId(environment),
    timeZone: requiredShanghaiTimezone(environment),
  } as const;
}
