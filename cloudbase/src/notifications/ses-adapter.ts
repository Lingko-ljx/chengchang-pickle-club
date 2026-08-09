import { ses } from "tencentcloud-sdk-nodejs-ses";
import type { ProviderDelivery } from "../../../lib/booking/outbox-ports.ts";
import type {
  BookingMode,
  BookingStatus,
  NotificationKind,
} from "../../../lib/booking/types.ts";

export interface SesAdapterConfig {
  secretId: string;
  secretKey: string;
  region: string;
  fromEmail: string;
  templateId: number;
  replyTo: string;
  staffEmail: string;
}

export interface NotificationTemplateData {
  kind: NotificationKind;
  code: string;
  date: string;
  startAt: string;
  endAt: string;
  status: BookingStatus;
  courtId: string;
  mode: BookingMode;
  partySize: number;
  displayName: string;
}

export interface NotificationMail {
  recipient: string;
  templateData: NotificationTemplateData;
}

interface SesClientLike {
  SendEmail(request: {
    FromEmailAddress: string;
    Subject: string;
    Destination: string[];
    ReplyToAddresses: string;
    Template: { TemplateID: number; TemplateData: string };
    TriggerType: number;
  }): Promise<{ RequestId?: string; MessageId?: string }>;
}

export interface ClassifiedSesError {
  code:
    | "AUTH_ERROR"
    | "CONFIGURATION_ERROR"
    | "INTERNAL_ERROR"
    | "INVALID_ADDRESS"
    | "INVALID_PARAMETER"
    | "INVALID_PROVIDER_RESPONSE"
    | "INVALID_TEMPLATE"
    | "NETWORK_ERROR"
    | "REQUEST_LIMITED"
    | "RESOURCE_INSUFFICIENT"
    | "RESOURCE_UNAVAILABLE"
    | "SERVICE_UNAVAILABLE"
    | "TEMPORARY_BLOCKED"
    | "UNKNOWN_ERROR";
  retryable: boolean;
}

export class SesDeliveryError extends Error implements ClassifiedSesError {
  readonly code: ClassifiedSesError["code"];
  readonly retryable: boolean;

  constructor(code: ClassifiedSesError["code"], retryable: boolean) {
    super(code);
    this.name = "SesDeliveryError";
    this.code = code;
    this.retryable = retryable;
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function httpCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("httpCode" in error)) return undefined;
  return typeof error.httpCode === "number" ? error.httpCode : undefined;
}

const exactSesErrors: Readonly<Record<string, ClassifiedSesError>> = {
  ["failedoperation.serviceNotavailable".toLowerCase()]: {
    code: "SERVICE_UNAVAILABLE",
    retryable: true,
  },
  ["failedoperation.highRejectionRate".toLowerCase()]: {
    code: "TEMPORARY_BLOCKED",
    retryable: true,
  },
  ["failedoperation.temporaryBlocked".toLowerCase()]: {
    code: "TEMPORARY_BLOCKED",
    retryable: true,
  },
  ["failedoperation.frequencyLimit".toLowerCase()]: {
    code: "TEMPORARY_BLOCKED",
    retryable: true,
  },
  ["failedoperation.exceedSendLimit".toLowerCase()]: {
    code: "TEMPORARY_BLOCKED",
    retryable: true,
  },
  ["failedoperation.templateContentIsTooLong".toLowerCase()]: {
    code: "INVALID_TEMPLATE",
    retryable: false,
  },
  ["failedoperation.invalidTemplateID".toLowerCase()]: {
    code: "INVALID_TEMPLATE",
    retryable: false,
  },
  ["failedoperation.templateContentToolarge".toLowerCase()]: {
    code: "INVALID_TEMPLATE",
    retryable: false,
  },
  ["failedoperation.emailAddressIsNotVerified".toLowerCase()]: {
    code: "INVALID_ADDRESS",
    retryable: false,
  },
  ["failedoperation.emailAddrIsNotVerified".toLowerCase()]: {
    code: "INVALID_ADDRESS",
    retryable: false,
  },
  ["failedoperation.incorrectEmail".toLowerCase()]: {
    code: "INVALID_ADDRESS",
    retryable: false,
  },
  ["failedoperation.emailAddrInBlacklist".toLowerCase()]: {
    code: "INVALID_ADDRESS",
    retryable: false,
  },
  ["failedoperation.receiverHasUnsubscribed".toLowerCase()]: {
    code: "INVALID_ADDRESS",
    retryable: false,
  },
  ["failedoperation.rejectedByRecipients".toLowerCase()]: {
    code: "INVALID_ADDRESS",
    retryable: false,
  },
  ["failedoperation.emailContentToolarge".toLowerCase()]: {
    code: "INVALID_PARAMETER",
    retryable: false,
  },
  ["failedoperation.tooManyRecipients".toLowerCase()]: {
    code: "INVALID_PARAMETER",
    retryable: false,
  },
  ["failedoperation.wrongContentJson".toLowerCase()]: {
    code: "INVALID_PARAMETER",
    retryable: false,
  },
  ["failedoperation.protocolCheckErr".toLowerCase()]: {
    code: "INVALID_PARAMETER",
    retryable: false,
  },
  ["failedoperation.notAuthenticatedSender".toLowerCase()]: {
    code: "AUTH_ERROR",
    retryable: false,
  },
  ["failedoperation.withOutPermission".toLowerCase()]: {
    code: "AUTH_ERROR",
    retryable: false,
  },
  ["failedoperation.incorrectSender".toLowerCase()]: {
    code: "CONFIGURATION_ERROR",
    retryable: false,
  },
  ["failedoperation.dkimNotApplied".toLowerCase()]: {
    code: "CONFIGURATION_ERROR",
    retryable: false,
  },
  ["failedoperation.insufficientBalance".toLowerCase()]: {
    code: "CONFIGURATION_ERROR",
    retryable: false,
  },
  ["failedoperation.insufficientQuota".toLowerCase()]: {
    code: "CONFIGURATION_ERROR",
    retryable: false,
  },
  ["failedoperation.unsupportMailType".toLowerCase()]: {
    code: "CONFIGURATION_ERROR",
    retryable: false,
  },
};

const sesErrorFamilies: ReadonlyArray<readonly [string, ClassifiedSesError]> = [
  ["internalerror", { code: "INTERNAL_ERROR", retryable: true }],
  ["requestlimitexceeded", { code: "REQUEST_LIMITED", retryable: true }],
  ["serviceunavailable", { code: "SERVICE_UNAVAILABLE", retryable: true }],
  ["resourceunavailable", { code: "RESOURCE_UNAVAILABLE", retryable: true }],
  ["resourceinsufficient", { code: "RESOURCE_INSUFFICIENT", retryable: true }],
  ["authfailure", { code: "AUTH_ERROR", retryable: false }],
  ["unauthorizedoperation", { code: "AUTH_ERROR", retryable: false }],
  ["invalidcredential", { code: "AUTH_ERROR", retryable: false }],
  ["secretidnotfound", { code: "AUTH_ERROR", retryable: false }],
  ["signaturefailure", { code: "AUTH_ERROR", retryable: false }],
  ["invalidparameter", { code: "INVALID_PARAMETER", retryable: false }],
  ["invalidparametervalue", { code: "INVALID_PARAMETER", retryable: false }],
  ["missingparameter", { code: "INVALID_PARAMETER", retryable: false }],
  ["unknownparameter", { code: "INVALID_PARAMETER", retryable: false }],
  ["unsupportedoperation", { code: "INVALID_PARAMETER", retryable: false }],
  ["invalidaction", { code: "CONFIGURATION_ERROR", retryable: false }],
  ["invalidconfiguration", { code: "CONFIGURATION_ERROR", retryable: false }],
  ["operationdenied", { code: "CONFIGURATION_ERROR", retryable: false }],
];

function inSesErrorFamily(code: string, family: string): boolean {
  return code === family || code.startsWith(`${family}.`);
}

export function classifySesError(error: unknown): ClassifiedSesError {
  if (error instanceof SesDeliveryError) {
    return { code: error.code, retryable: error.retryable };
  }
  const code = errorCode(error);
  if (code) {
    const normalizedCode = code.trim().toLowerCase();
    const exact = exactSesErrors[normalizedCode];
    if (exact) return exact;
    for (const [family, classification] of sesErrorFamilies) {
      if (inSesErrorFamily(normalizedCode, family)) return classification;
    }
    return { code: "UNKNOWN_ERROR", retryable: true };
  }
  if ((httpCode(error) ?? 0) >= 500) {
    return { code: "SERVICE_UNAVAILABLE", retryable: true };
  }
  return { code: "NETWORK_ERROR", retryable: true };
}

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const messageIdPattern =
  /^qcloudses-\d{1,10}-\d{1,20}-date-\d{14}-[A-Za-z0-9]{1,64}$/;

function normalizeRequestId(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "") return undefined;
  return requestIdPattern.test(normalized) ? normalized : "REDACTED";
}

function normalizeMessageId(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "") return undefined;
  return messageIdPattern.test(normalized) ? normalized : "REDACTED";
}

export function createSesClient(config: SesAdapterConfig): InstanceType<typeof ses.v20201002.Client> {
  return new ses.v20201002.Client({
    credential: {
      secretId: config.secretId,
      secretKey: config.secretKey,
    },
    region: config.region,
    profile: {
      signMethod: "TC3-HMAC-SHA256",
      httpProfile: {
        reqMethod: "POST",
        reqTimeout: 10,
      },
    },
  });
}

export class SesAdapter {
  private readonly config: SesAdapterConfig;
  private readonly client: SesClientLike;

  constructor(config: SesAdapterConfig, client: SesClientLike = createSesClient(config)) {
    this.config = config;
    this.client = client;
  }

  async send(mail: NotificationMail): Promise<ProviderDelivery> {
    let response: { RequestId?: string; MessageId?: string };
    try {
      response = await this.client.SendEmail({
        FromEmailAddress: this.config.fromEmail,
        Subject: "预约服务通知",
        Destination: [mail.recipient],
        ReplyToAddresses: this.config.replyTo,
        Template: {
          TemplateID: this.config.templateId,
          TemplateData: JSON.stringify(mail.templateData),
        },
        TriggerType: 1,
      });
    } catch (error) {
      const classified = classifySesError(error);
      throw new SesDeliveryError(classified.code, classified.retryable);
    }
    const providerRequestId = normalizeRequestId(response.RequestId);
    if (!providerRequestId) {
      throw new SesDeliveryError("INVALID_PROVIDER_RESPONSE", true);
    }
    const providerMessageId = normalizeMessageId(response.MessageId);
    return {
      providerRequestId,
      ...(providerMessageId ? { providerMessageId } : {}),
    };
  }
}
