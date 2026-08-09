import assert from "node:assert/strict";
import test from "node:test";
import { ses } from "tencentcloud-sdk-nodejs-ses";
import {
  SesAdapter,
  classifySesError,
  createSesClient,
} from "../cloudbase/src/notifications/ses-adapter.ts";
import { runMailer, runMailerSafely } from "../cloudbase/src/mailer.ts";

const NOW = "2026-08-09T04:00:00.000Z";
const OFFICIAL_REQUEST_ID = "8979fc1e-9564-4fc9-bf7d-2958ce679b72";
const OFFICIAL_MESSAGE_ID = "qcloudses-30-4123414323-date-20210101094334-syNARhMTbKI1";

function mailEnvironment(overrides = {}) {
  return {
    TENCENTCLOUD_SECRET_ID: "secret-id-canary",
    TENCENTCLOUD_SECRET_KEY: "secret-key-canary",
    SES_REGION: "ap-guangzhou",
    SES_FROM_EMAIL: "service@example.invalid",
    SES_TEMPLATE_ID: "12345",
    SES_REPLY_TO: "reply@example.invalid",
    STAFF_NOTIFICATION_EMAIL: "staff@example.invalid",
    ...overrides,
  };
}

function booking(overrides = {}) {
  return {
    id: "booking-001",
    code: "PICKLE2345",
    sessionId: "2026-08-10__slot-1900",
    date: "2026-08-10",
    startAt: "2026-08-10T11:00:00.000Z",
    endAt: "2026-08-10T12:00:00.000Z",
    courtId: "03",
    mode: "open",
    partySize: 2,
    status: "confirmed",
    name: "Ada Lovelace",
    phone: "13800138000",
    phoneHash: "phone-hash-secret",
    email: "ada@example.invalid",
    note: "private note",
    privacyConsentAt: "2026-08-01T00:00:00.000Z",
    canCancelUntil: "2026-08-10T11:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 2,
    ...overrides,
  };
}

function notification(overrides = {}) {
  return {
    id: "event-001",
    bookingId: "booking-001",
    bookingVersion: 2,
    kind: "confirmed",
    recipientType: "customer",
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function sesConfig(overrides = {}) {
  return {
    secretId: "secret-id-canary",
    secretKey: "secret-key-canary",
    region: "ap-guangzhou",
    fromEmail: "service@example.invalid",
    templateId: 12345,
    replyTo: "reply@example.invalid",
    staffEmail: "staff@example.invalid",
    ...overrides,
  };
}

function mail(overrides = {}) {
  return {
    recipient: "ada@example.invalid",
    templateData: {
      kind: "confirmed",
      code: "PICKLE2345",
      date: "2026-08-10",
      startAt: "2026-08-10T11:00:00.000Z",
      endAt: "2026-08-10T12:00:00.000Z",
      status: "confirmed",
      courtId: "03",
      mode: "open",
      partySize: 2,
      displayName: "Ada Lovelace",
    },
    ...overrides,
  };
}

class WorkerOutbox {
  constructor(events) {
    this.events = events.map((value) => structuredClone(value));
    this.listCalls = [];
    this.claimCalls = [];
    this.sent = [];
    this.retries = [];
    this.failed = [];
  }

  async listEligible(limit, now) {
    this.listCalls.push({ limit, now });
    return this.events.slice(0, limit).map((value) => structuredClone(value));
  }

  async claim(eventId, workerId, leaseToken, now, leaseUntil) {
    this.claimCalls.push({ eventId, workerId, leaseToken, now, leaseUntil });
    const value = this.events.find((item) => item.id === eventId);
    if (!value) return null;
    return {
      ...structuredClone(value),
      status: "sending",
      attemptCount: value.attemptCount + 1,
      nextAttemptAt: leaseUntil,
      leaseOwner: workerId,
      leaseToken,
      leaseUntil,
      updatedAt: now,
    };
  }

  async markSent(...args) {
    this.sent.push(structuredClone(args));
    return true;
  }

  async markRetry(...args) {
    this.retries.push(structuredClone(args));
    return true;
  }

  async markFailed(...args) {
    this.failed.push(structuredClone(args));
    return true;
  }
}

function workerDependencies(overrides = {}) {
  let id = 0;
  return {
    environment: mailEnvironment(),
    outbox: new WorkerOutbox([notification()]),
    bookings: { getBookingById: async () => booking() },
    createSender: () => ({
      send: async () => ({
        providerRequestId: OFFICIAL_REQUEST_ID,
        providerMessageId: OFFICIAL_MESSAGE_ID,
      }),
    }),
    clock: { now: () => new Date(NOW) },
    randomId: () => `random-${++id}`,
    runRetention: async () => undefined,
    logger: { warn: () => undefined },
    ...overrides,
  };
}

test("adapter uses the locked real SES client and sends exactly one template recipient", async () => {
  // Catches wrong SDK import paths or Tencent SendEmail field names.
  const realClient = createSesClient(sesConfig());
  assert.equal(realClient instanceof ses.v20201002.Client, true);
  assert.equal(realClient.apiVersion, "2020-10-02");
  assert.equal(realClient.endpoint, "ses.tencentcloudapi.com");
  assert.equal(realClient.region, "ap-guangzhou");
  assert.equal(realClient.profile.httpProfile.reqTimeout, 10);

  const requests = [];
  const client = {
    async SendEmail(request) {
      requests.push(structuredClone(request));
      return { RequestId: OFFICIAL_REQUEST_ID, MessageId: OFFICIAL_MESSAGE_ID };
    },
  };
  const adapter = new SesAdapter(sesConfig(), client);
  const delivery = await adapter.send(mail());

  assert.deepEqual(delivery, {
    providerRequestId: OFFICIAL_REQUEST_ID,
    providerMessageId: OFFICIAL_MESSAGE_ID,
  });
  assert.deepEqual(requests, [
    {
      FromEmailAddress: "service@example.invalid",
      Subject: "预约服务通知",
      Destination: ["ada@example.invalid"],
      ReplyToAddresses: "reply@example.invalid",
      Template: {
        TemplateID: 12345,
        TemplateData: JSON.stringify(mail().templateData),
      },
      TriggerType: 1,
    },
  ]);
  assert.equal(requests[0].Destination.length, 1);
  assert.equal("Cc" in requests[0] || "Bcc" in requests[0], false);
});

test("SES errors map to a closed permanent or retryable code without raw text", () => {
  // Catches raw provider codes/messages reaching persisted lastErrorCode.
  const cases = [
    [{ code: "InvalidParameterValue", message: "bad ada@example.invalid" }, "INVALID_PARAMETER", false],
    [{ code: "FailedOperation.TemplateContentIsTooLong" }, "INVALID_TEMPLATE", false],
    [{ code: "FailedOperation.EmailAddressIsNotVerified" }, "INVALID_ADDRESS", false],
    [{ code: "AuthFailure.SignatureFailure" }, "AUTH_ERROR", false],
    [{ code: "InternalError.DbError" }, "INTERNAL_ERROR", true],
    [{ code: "RequestLimitExceeded.UinLimitExceeded" }, "REQUEST_LIMITED", true],
    [{ code: "ServiceUnavailable" }, "SERVICE_UNAVAILABLE", true],
    [{ code: "ResourceUnavailable" }, "RESOURCE_UNAVAILABLE", true],
    [{ code: "ResourceInsufficient" }, "RESOURCE_INSUFFICIENT", true],
    [{ code: "FailedOperation.FrequencyLimit" }, "TEMPORARY_BLOCKED", true],
    [new Error("connect ETIMEDOUT ada@example.invalid"), "NETWORK_ERROR", true],
  ];

  for (const [input, code, retryable] of cases) {
    const classified = classifySesError(input);
    assert.deepEqual(classified, { code, retryable });
    assert.equal(JSON.stringify(classified).includes("ada"), false);
  }
});

test("official SES availability and temporary-block codes remain retryable", () => {
  const cases = [
    ["FailedOperation.ServiceNotAvailable", "SERVICE_UNAVAILABLE", true],
    ["FailedOperation.HighRejectionRate", "TEMPORARY_BLOCKED", true],
    ["FailedOperation.TemporaryBlocked", "TEMPORARY_BLOCKED", true],
    ["FailedOperation.SendEmailErr", "UNKNOWN_ERROR", true],
    ["FailedOperation.FutureProviderCode", "UNKNOWN_ERROR", true],
    ["InvalidConfiguration.MissingSender", "CONFIGURATION_ERROR", false],
  ];

  assert.deepEqual(
    cases.map(([providerCode]) => classifySesError({ code: providerCode })),
    cases.map(([, code, retryable]) => ({ code, retryable })),
  );
});

test("official SES address, template, sender, permission, and quota codes remain permanent", () => {
  const cases = [
    ["FailedOperation.IncorrectEmail", "INVALID_ADDRESS"],
    ["FailedOperation.EmailAddrInBlacklist", "INVALID_ADDRESS"],
    ["FailedOperation.ReceiverHasUnsubscribed", "INVALID_ADDRESS"],
    ["FailedOperation.RejectedByRecipients", "INVALID_ADDRESS"],
    ["FailedOperation.InvalidTemplateID", "INVALID_TEMPLATE"],
    ["FailedOperation.TemplateContentToolarge", "INVALID_TEMPLATE"],
    ["FailedOperation.EmailContentToolarge", "INVALID_PARAMETER"],
    ["FailedOperation.TooManyRecipients", "INVALID_PARAMETER"],
    ["FailedOperation.WrongContentJson", "INVALID_PARAMETER"],
    ["FailedOperation.NotAuthenticatedSender", "AUTH_ERROR"],
    ["FailedOperation.WithOutPermission", "AUTH_ERROR"],
    ["FailedOperation.IncorrectSender", "CONFIGURATION_ERROR"],
    ["FailedOperation.DKIMNotApplied", "CONFIGURATION_ERROR"],
    ["FailedOperation.InsufficientBalance", "CONFIGURATION_ERROR"],
    ["FailedOperation.InsufficientQuota", "CONFIGURATION_ERROR"],
    ["FailedOperation.UnsupportMailType", "CONFIGURATION_ERROR"],
  ];

  assert.deepEqual(
    cases.map(([providerCode]) => classifySesError({ code: providerCode })),
    cases.map(([, code]) => ({ code, retryable: false })),
  );
  assert.deepEqual(classifySesError({ code: "FailedOperation.SendEmailErr" }), {
    code: "UNKNOWN_ERROR",
    retryable: true,
  });
});

test("SES classification never infers permanence from words inside an unknown FailedOperation", () => {
  const unknown = [
    "FailedOperation.TemplateBackendGlitch",
    "FailedOperation.AddressServiceUnavailable",
    "FailedOperation.InvalidParameterCacheTimeout",
  ];
  assert.deepEqual(
    unknown.map((code) => classifySesError({ code })),
    unknown.map(() => ({ code: "UNKNOWN_ERROR", retryable: true })),
  );

  assert.deepEqual(
    [
      classifySesError({ code: "FailedOperation.ProtocolCheckErr" }),
      classifySesError({ code: "UnknownParameter.FutureField" }),
      classifySesError({ code: "OperationDenied.FuturePolicy" }),
    ],
    [
      { code: "INVALID_PARAMETER", retryable: false },
      { code: "INVALID_PARAMETER", retryable: false },
      { code: "CONFIGURATION_ERROR", retryable: false },
    ],
  );
});

test("adapter redacts every non-official non-empty provider ID without repeating a resolved send", async () => {
  for (const unsafeId of ["AdaLovelace", "Alice123", "alice@example.invalid", "13800138000"]) {
    let sends = 0;
    const adapter = new SesAdapter(sesConfig(), {
      SendEmail: async () => {
        sends += 1;
        return { RequestId: unsafeId, MessageId: unsafeId };
      },
    });

    assert.deepEqual(await adapter.send(mail()), {
      providerRequestId: "REDACTED",
      providerMessageId: "REDACTED",
    });
    assert.equal(sends, 1);
  }
});

test("adapter treats a missing request ID as a safe provider-response failure", async () => {
  const adapter = new SesAdapter(sesConfig(), { SendEmail: async () => ({}) });
  await assert.rejects(
    () => adapter.send(mail()),
    (error) =>
      error.code === "INVALID_PROVIDER_RESPONSE" &&
      error.retryable === true &&
      !JSON.stringify(error).includes("alice"),
  );
});

test("successful and failed mail outcomes never mutate booking state", async () => {
  // Catches notification handling coupling delivery outcomes back into the booking aggregate.
  const source = booking();
  const snapshot = structuredClone(source);
  Object.freeze(source);

  for (const outcome of ["success", "failure"]) {
    const outbox = new WorkerOutbox([notification()]);
    await runMailer(
      workerDependencies({
        outbox,
        bookings: { getBookingById: async () => source },
        createSender: () => ({
          send: async () => {
            if (outcome === "failure") throw { code: "InvalidParameterValue" };
            return { providerRequestId: OFFICIAL_REQUEST_ID };
          },
        }),
      }),
    );
    assert.deepEqual(source, snapshot);
  }
});

test("worker sends only after the fenced claim promise has committed", async () => {
  // Catches SES being invoked from inside or before the claim transaction commits.
  const order = [];
  let releaseClaim;
  const outbox = new WorkerOutbox([notification()]);
  outbox.claim = async (...args) => {
    order.push("claim-started");
    await new Promise((resolve) => {
      releaseClaim = () => {
        order.push("claim-committed");
        resolve();
      };
    });
    return WorkerOutbox.prototype.claim.apply(outbox, args);
  };
  const running = runMailer(
    workerDependencies({
      outbox,
      createSender: () => ({
        send: async () => {
          order.push("ses-send");
          return { providerRequestId: OFFICIAL_REQUEST_ID };
        },
      }),
    }),
  );

  while (!releaseClaim) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["claim-started"]);
  releaseClaim();
  await running;
  assert.deepEqual(order, ["claim-started", "claim-committed", "ses-send"]);
  assert.equal(outbox.sent.length, 1);
});

test("worker caps one invocation at twenty and uses a unique five-minute fence per event", async () => {
  const events = Array.from({ length: 25 }, (_, index) =>
    notification({ id: `event-${String(index).padStart(2, "0")}` }),
  );
  const outbox = new WorkerOutbox(events);
  const sentMail = [];

  await runMailer(
    workerDependencies({
      outbox,
      createSender: () => ({
        send: async (message) => {
          sentMail.push(structuredClone(message));
          return { providerRequestId: OFFICIAL_REQUEST_ID };
        },
      }),
    }),
  );

  assert.deepEqual(outbox.listCalls, [{ limit: 20, now: NOW }]);
  assert.equal(outbox.claimCalls.length, 20);
  assert.equal(sentMail.length, 20);
  assert.equal(outbox.sent.length, 20);
  assert.equal(new Set(outbox.claimCalls.map(({ leaseToken }) => leaseToken)).size, 20);
  assert.equal(outbox.claimCalls.every(({ leaseUntil }) => leaseUntil === "2026-08-09T04:05:00.000Z"), true);
});

test("slow sends use a fresh claim lease and schedule retries from the failure instant", async () => {
  // Catches one invocation-wide timestamp producing expired leases for later events.
  const instants = [
    "2026-08-09T04:00:00.000Z",
    "2026-08-09T04:00:00.000Z",
    "2026-08-09T04:04:00.000Z",
    "2026-08-09T04:06:00.000Z",
    "2026-08-09T04:10:00.000Z",
  ];
  let instant = 0;
  const outbox = new WorkerOutbox([
    notification(),
    notification({ id: "event-002" }),
  ]);
  let sends = 0;

  await runMailer(
    workerDependencies({
      outbox,
      clock: { now: () => new Date(instants[instant++]) },
      createSender: () => ({
        send: async () => {
          sends += 1;
          if (sends === 2) throw { code: "InternalError.DbError" };
          return { providerRequestId: OFFICIAL_REQUEST_ID };
        },
      }),
    }),
  );

  assert.deepEqual(outbox.claimCalls.map(({ now, leaseUntil }) => ({ now, leaseUntil })), [
    { now: "2026-08-09T04:00:00.000Z", leaseUntil: "2026-08-09T04:05:00.000Z" },
    { now: "2026-08-09T04:06:00.000Z", leaseUntil: "2026-08-09T04:11:00.000Z" },
  ]);
  assert.equal(outbox.sent[0][2], "2026-08-09T04:04:00.000Z");
  assert.deepEqual(outbox.retries, [[
    "event-002",
    "random-3",
    "2026-08-09T04:10:00.000Z",
    "2026-08-09T04:11:00.000Z",
    "INTERNAL_ERROR",
  ]]);
});

test("worker sends an allowlisted transient template payload to the correct recipient", async () => {
  const outbox = new WorkerOutbox([
    notification({ kind: "created", recipientType: "staff" }),
    notification({ id: "event-002", kind: "confirmed", recipientType: "customer" }),
  ]);
  const messages = [];

  await runMailer(
    workerDependencies({
      outbox,
      createSender: () => ({
        send: async (message) => {
          messages.push(structuredClone(message));
          return { providerRequestId: OFFICIAL_REQUEST_ID };
        },
      }),
    }),
  );

  assert.deepEqual(messages.map(({ recipient }) => recipient), [
    "staff@example.invalid",
    "ada@example.invalid",
  ]);
  const allowedKeys = [
    "kind",
    "code",
    "date",
    "startAt",
    "endAt",
    "status",
    "courtId",
    "mode",
    "partySize",
    "displayName",
  ].sort();
  assert.deepEqual(Object.keys(messages[0].templateData).sort(), allowedKeys);
  const serialized = JSON.stringify(messages);
  assert.equal(serialized.includes("13800138000"), false);
  assert.equal(serialized.includes("phone-hash-secret"), false);
  assert.equal(serialized.includes("private note"), false);
});

test("reschedule proposal mail uses the proposed session rather than the current booking session", async () => {
  const outbox = new WorkerOutbox([
    notification({ kind: "reschedule_proposed", bookingVersion: 2 }),
  ]);
  const messages = [];
  await runMailer(
    workerDependencies({
      outbox,
      bookings: {
        getBookingById: async () =>
          booking({
            version: 2,
            status: "reschedule_proposed",
            proposedDate: "2026-08-12",
            proposedSessionId: "2026-08-12__slot-2000",
            proposedStartAt: "2026-08-12T12:00:00.000Z",
            proposedEndAt: "2026-08-12T13:00:00.000Z",
            proposedCourtId: "09",
          }),
      },
      createSender: () => ({
        send: async (message) => {
          messages.push(structuredClone(message));
          return { providerRequestId: OFFICIAL_REQUEST_ID };
        },
      }),
    }),
  );

  assert.deepEqual(messages[0].templateData, {
    ...mail().templateData,
    kind: "reschedule_proposed",
    date: "2026-08-12",
    startAt: "2026-08-12T12:00:00.000Z",
    endAt: "2026-08-12T13:00:00.000Z",
    status: "reschedule_proposed",
    courtId: "09",
  });
});

test("superseded or incomplete proposal events terminate without invoking SES", async () => {
  const cases = [
    booking({ version: 3, status: "confirmed" }),
    booking({ version: 3, status: "pending" }),
    booking({ version: 3, status: "cancelled" }),
    booking({ version: 2, status: "reschedule_proposed" }),
  ];

  for (const currentBooking of cases) {
    const outbox = new WorkerOutbox([
      notification({ kind: "reschedule_proposed", bookingVersion: 2 }),
    ]);
    let sends = 0;
    await runMailer(
      workerDependencies({
        outbox,
        bookings: { getBookingById: async () => currentBooking },
        createSender: () => ({
          send: async () => {
            sends += 1;
            return { providerRequestId: OFFICIAL_REQUEST_ID };
          },
        }),
      }),
    );
    assert.equal(sends, 0);
    assert.deepEqual(outbox.failed, [[
      "event-001",
      "random-2",
      NOW,
      "EVENT_SUPERSEDED",
    ]]);
  }
});

test("every current notification kind remains deliverable", async () => {
  for (const kind of [
    "created",
    "confirmed",
    "reschedule_proposed",
    "reschedule_accepted",
    "reschedule_rejected",
    "cancelled",
  ]) {
    const outbox = new WorkerOutbox([notification({ kind, bookingVersion: 2 })]);
    const currentBooking = booking({
      version: 2,
      ...(kind === "reschedule_proposed"
        ? {
            status: "reschedule_proposed",
            proposedDate: "2026-08-12",
            proposedStartAt: "2026-08-12T12:00:00.000Z",
            proposedEndAt: "2026-08-12T13:00:00.000Z",
            proposedCourtId: "09",
          }
        : {}),
    });
    await runMailer(
      workerDependencies({
        outbox,
        bookings: { getBookingById: async () => currentBooking },
      }),
    );
    assert.equal(outbox.sent.length, 1, kind);
    assert.deepEqual(outbox.failed, [], kind);
  }
});

test("transient retries use 1, 2, 4, 8 minutes and the fifth failure is immediately terminal", async () => {
  // Catches a fifth retry or sixth provider call.
  const expected = [
    [0, "2026-08-09T04:01:00.000Z"],
    [1, "2026-08-09T04:02:00.000Z"],
    [2, "2026-08-09T04:04:00.000Z"],
    [3, "2026-08-09T04:08:00.000Z"],
  ];
  for (const [attemptCount, nextAttemptAt] of expected) {
    const outbox = new WorkerOutbox([notification({ attemptCount })]);
    await runMailer(
      workerDependencies({
        outbox,
        createSender: () => ({
          send: async () => {
            throw { code: "InternalError.DbError", message: "raw private failure" };
          },
        }),
      }),
    );
    assert.deepEqual(outbox.retries, [[
      "event-001",
      "random-2",
      NOW,
      nextAttemptAt,
      "INTERNAL_ERROR",
    ]]);
    assert.deepEqual(outbox.failed, []);
    assert.equal(JSON.stringify(outbox.retries).includes("raw private failure"), false);
  }

  const fifth = new WorkerOutbox([notification({ attemptCount: 4 })]);
  let sends = 0;
  await runMailer(
    workerDependencies({
      outbox: fifth,
      createSender: () => ({
        send: async () => {
          sends += 1;
          throw { code: "InternalError.DbError", message: "raw private failure" };
        },
      }),
    }),
  );
  assert.equal(sends, 1);
  assert.deepEqual(fifth.retries, []);
  assert.deepEqual(fifth.failed, [["event-001", "random-2", NOW, "INTERNAL_ERROR"]]);
});

test("permanent SES failure and unavailable recipients fail safely without retries", async () => {
  const permanent = new WorkerOutbox([notification()]);
  await runMailer(
    workerDependencies({
      outbox: permanent,
      createSender: () => ({
        send: async () => {
          throw { code: "InvalidParameterValue", message: "ada@example.invalid is bad" };
        },
      }),
    }),
  );
  assert.deepEqual(permanent.retries, []);
  assert.deepEqual(permanent.failed, [["event-001", "random-2", NOW, "INVALID_PARAMETER"]]);
  assert.equal(JSON.stringify(permanent.failed).includes("ada"), false);

  const unavailable = new WorkerOutbox([notification()]);
  let sendCalls = 0;
  await runMailer(
    workerDependencies({
      outbox: unavailable,
      bookings: { getBookingById: async () => booking({ email: "   " }) },
      createSender: () => ({
        send: async () => {
          sendCalls += 1;
          return { providerRequestId: OFFICIAL_REQUEST_ID };
        },
      }),
    }),
  );
  assert.equal(sendCalls, 0);
  assert.deepEqual(unavailable.failed, [[
    "event-001",
    "random-2",
    NOW,
    "RECIPIENT_UNAVAILABLE",
  ]]);
});

test("missing configuration performs no Outbox work, logs only its name, and still runs retention", async () => {
  // Catches a configuration outage blocking privacy retention or leaking a secret value.
  const accessed = [];
  const environment = new Proxy(mailEnvironment({ SES_REGION: undefined }), {
    get(target, property) {
      if (typeof property === "string") accessed.push(property);
      return target[property];
    },
  });
  const outbox = {
    listEligible: async () => {
      throw new Error("OUTBOX_MUST_NOT_BE_READ");
    },
  };
  const warnings = [];
  let retentionRuns = 0;

  await runMailer(
    workerDependencies({
      environment,
      outbox,
      createSender: () => {
        throw new Error("SENDER_MUST_NOT_BE_CREATED");
      },
      logger: { warn: (...args) => warnings.push(structuredClone(args)) },
      runRetention: async () => {
        retentionRuns += 1;
      },
    }),
  );

  assert.equal(retentionRuns, 1);
  assert.deepEqual(warnings, [["MISSING_CONFIGURATION", { variable: "SES_REGION" }]]);
  const warningJson = JSON.stringify(warnings);
  assert.equal(warningJson.includes("secret-id-canary"), false);
  assert.equal(warningJson.includes("secret-key-canary"), false);
  assert.deepEqual(
    [...new Set(accessed)].sort(),
    [
      "SES_FROM_EMAIL",
      "SES_REGION",
      "SES_REPLY_TO",
      "SES_TEMPLATE_ID",
      "STAFF_NOTIFICATION_EMAIL",
      "TENCENTCLOUD_SECRET_ID",
      "TENCENTCLOUD_SECRET_KEY",
    ],
  );
});

test("production boundary rejects a fixed error while retention still runs after raw SDK failure", async () => {
  // Catches CloudBase platform logs receiving raw DB messages that may contain PII or secrets.
  let retentionRuns = 0;
  const dependencies = workerDependencies({
    outbox: {
      listEligible: async () => {
        throw new Error("database failed for alice@example.invalid secret-key-canary");
      },
    },
    runRetention: async () => {
      retentionRuns += 1;
    },
  });

  await assert.rejects(
    () => runMailerSafely(dependencies),
    (error) =>
      error instanceof Error &&
      error.message === "MAILER_INVOCATION_FAILED" &&
      !JSON.stringify(error).includes("alice") &&
      !JSON.stringify(error).includes("secret-key-canary") &&
      !("cause" in error),
  );
  assert.equal(retentionRuns, 1);
});
