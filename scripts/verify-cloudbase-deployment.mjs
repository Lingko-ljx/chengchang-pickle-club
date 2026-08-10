import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const expectedFunctions = [
  "booking-public-api",
  "booking-admin-api",
  "booking-mailer",
];

const expectedRuntimeEnvironmentKeys = {
  "booking-public-api": [
    "PUBLIC_ALLOWED_ORIGINS",
    "PUBLIC_RESULT_URL",
    "DATA_TIMEZONE",
    "RATE_LIMIT_SALT",
    "PHONE_HASH_SALT",
    "IDEMPOTENCY_SALT",
  ],
  "booking-admin-api": ["CLOUDBASE_ENV_ID", "DATA_TIMEZONE"],
  "booking-mailer": [
    "BOOKING_SES_SECRET_ID",
    "BOOKING_SES_SECRET_KEY",
    "SES_REGION",
    "SES_FROM_EMAIL",
    "SES_TEMPLATE_ID",
    "SES_REPLY_TO",
    "STAFF_NOTIFICATION_EMAIL",
  ],
};

export function hasExactRuntimeEnvironment(detail, name) {
  const expected = expectedRuntimeEnvironmentKeys[name];
  const variables = detail?.Environment?.Variables;
  if (!expected || !Array.isArray(variables) || variables.length !== expected.length) {
    return false;
  }
  const keys = variables.map((variable) =>
    variable && typeof variable === "object" && typeof variable.Key === "string"
      ? variable.Key
      : null,
  );
  if (keys.includes(null)) return false;
  const uniqueKeys = new Set(keys);
  return (
    uniqueKeys.size === expected.length &&
    expected.every((key) => uniqueKeys.has(key))
  );
}

function validTrigger(trigger) {
  return (
    trigger?.TriggerName === "booking-mailer-every-minute" &&
    trigger?.Type === "timer" &&
    trigger?.TriggerDesc === "0 * * * * * *"
  );
}

function validDetail(detail, name, revision) {
  if (
    !detail ||
    detail.FunctionName !== name ||
    detail.Status !== "Active" ||
    detail.Description !== `deployment-revision:${revision}` ||
    detail.Runtime !== "Nodejs20.19" ||
    detail.Handler !== "index.main" ||
    detail.InstallDependency !== "TRUE" ||
    !Array.isArray(detail.Triggers) ||
    !hasExactRuntimeEnvironment(detail, name)
  ) {
    return false;
  }
  if (name === "booking-mailer") {
    return detail.Triggers.length === 1 && validTrigger(detail.Triggers[0]);
  }
  return detail.Triggers.length === 0;
}

async function verify(directory, revision) {
  if (!directory || !/^[0-9a-f]{40}$/.test(revision ?? "")) return "invalid";
  const details = [];
  for (const name of expectedFunctions) {
    let envelope;
    try {
      envelope = JSON.parse(
        await readFile(path.join(directory, `${name}.json`), "utf8"),
      );
    } catch {
      return "invalid";
    }
    if (
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      Object.keys(envelope).length !== 1 ||
      !("data" in envelope) ||
      !envelope.data ||
      typeof envelope.data !== "object" ||
      envelope.data.FunctionName !== name
    ) {
      return "invalid";
    }
    details.push([name, envelope.data]);
  }
  if (
    details.some(([, detail]) =>
      ["CreateFailed", "UpdateFailed"].includes(detail.Status),
    )
  ) {
    return "invalid";
  }
  if (details.some(([, detail]) => detail.Status !== "Active")) return "retry";
  return details.every(([name, detail]) => validDetail(detail, name, revision))
    ? "valid"
    : "invalid";
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  const result = await verify(process.argv[2], process.argv[3]);
  if (result === "valid") {
    process.stdout.write("CloudBase deployment configuration verified\n");
  } else if (result === "retry") {
    process.stderr.write("CloudBase functions are not active yet\n");
    process.exitCode = 2;
  } else {
    process.stderr.write("CloudBase deployment verification failed\n");
    process.exitCode = 1;
  }
}
