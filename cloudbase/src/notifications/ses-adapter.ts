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

export function classifySesError(error: unknown): ClassifiedSesError {
  if (error instanceof SesDeliveryError) {
    return { code: error.code, retryable: error.retryable };
  }
  const code = errorCode(error);
  if (code) {
    if (/^(InternalError)/i.test(code)) return { code: "INTERNAL_ERROR", retryable: true };
    if (/^(RequestLimitExceeded)/i.test(code)) {
      return { code: "REQUEST_LIMITED", retryable: true };
    }
    if (/^(ServiceUnavailable)/i.test(code)) {
      return { code: "SERVICE_UNAVAILABLE", retryable: true };
    }
    if (/^(ResourceUnavailable)/i.test(code)) {
      return { code: "RESOURCE_UNAVAILABLE", retryable: true };
    }
    if (/^(ResourceInsufficient)/i.test(code)) {
      return { code: "RESOURCE_INSUFFICIENT", retryable: true };
    }
    if (/(FrequencyLimit|SendLimit|Throttl|Temporar|Blocked)/i.test(code)) {
      return { code: "TEMPORARY_BLOCKED", retryable: true };
    }
    if (/(AuthFailure|Unauthorized|InvalidCredential|SecretId|Signature)/i.test(code)) {
      return { code: "AUTH_ERROR", retryable: false };
    }
    if (/Template/i.test(code)) return { code: "INVALID_TEMPLATE", retryable: false };
    if (/(EmailAddress|Address|BlackList|Unsubscribe)/i.test(code)) {
      return { code: "INVALID_ADDRESS", retryable: false };
    }
    if (/(InvalidParameter|MissingParameter|UnsupportedOperation)/i.test(code)) {
      return { code: "INVALID_PARAMETER", retryable: false };
    }
    if (/^(FailedOperation|InvalidAction|InvalidConfiguration)/i.test(code)) {
      return { code: "CONFIGURATION_ERROR", retryable: false };
    }
    return { code: "UNKNOWN_ERROR", retryable: true };
  }
  if ((httpCode(error) ?? 0) >= 500) {
    return { code: "SERVICE_UNAVAILABLE", retryable: true };
  }
  return { code: "NETWORK_ERROR", retryable: true };
}

function validProviderId(value: unknown): value is string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return (
    !/^\d{8,15}$/.test(normalized) &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized)
  );
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
    if (!validProviderId(response.RequestId)) {
      throw new SesDeliveryError("INVALID_PROVIDER_RESPONSE", true);
    }
    if (response.MessageId !== undefined && !validProviderId(response.MessageId)) {
      throw new SesDeliveryError("INVALID_PROVIDER_RESPONSE", true);
    }
    return {
      providerRequestId: response.RequestId.trim(),
      ...(response.MessageId ? { providerMessageId: response.MessageId.trim() } : {}),
    };
  }
}
