import { BookingError } from "../../../lib/booking/errors.ts";

export interface CloudBaseHttpEvent {
  httpMethod?: unknown;
  path?: unknown;
  rawPath?: unknown;
  headers?: unknown;
  queryStringParameters?: unknown;
  requestContext?: unknown;
  body?: unknown;
  isBase64Encoded?: unknown;
}

export interface ParsedBody {
  values: Record<string, unknown>;
  isForm: boolean;
  acceptsJson: boolean;
}

function headerEntries(event: CloudBaseHttpEvent): Array<[string, string]> {
  if (!event.headers || typeof event.headers !== "object") return [];
  return Object.entries(event.headers as Record<string, unknown>).flatMap(([name, value]) =>
    typeof value === "string" ? [[name.toLowerCase(), value]] : [],
  );
}

export function requestHeader(event: CloudBaseHttpEvent, name: string): string | undefined {
  return new Map(headerEntries(event)).get(name.toLowerCase());
}

export function requestMethod(event: CloudBaseHttpEvent): string {
  if (typeof event.httpMethod === "string") return event.httpMethod.toUpperCase();
  const context = event.requestContext;
  if (context && typeof context === "object") {
    const http = (context as Record<string, unknown>).http;
    if (http && typeof http === "object") {
      const method = (http as Record<string, unknown>).method;
      if (typeof method === "string") return method.toUpperCase();
    }
  }
  return "GET";
}

export function requestPath(event: CloudBaseHttpEvent): string {
  const value = typeof event.path === "string" ? event.path : event.rawPath;
  if (typeof value !== "string") return "/";
  const path = value.split("?", 1)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function queryParameter(event: CloudBaseHttpEvent, name: string): string | undefined {
  if (!event.queryStringParameters || typeof event.queryStringParameters !== "object") {
    return undefined;
  }
  const value = (event.queryStringParameters as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

export function trustedClientAddress(event: CloudBaseHttpEvent): string | null {
  if (!event.requestContext || typeof event.requestContext !== "object") return null;
  const context = event.requestContext as Record<string, unknown>;
  const http = context.http;
  if (http && typeof http === "object") {
    const sourceIp = (http as Record<string, unknown>).sourceIp;
    if (typeof sourceIp === "string" && sourceIp.trim()) return sourceIp.trim();
  }
  const sourceIp = context.sourceIp;
  return typeof sourceIp === "string" && sourceIp.trim() ? sourceIp.trim() : null;
}

function decodeBody(event: CloudBaseHttpEvent): string {
  if (event.body === undefined || event.body === null || event.body === "") return "";
  if (typeof event.body !== "string") throw new BookingError("INVALID_INPUT");
  try {
    return event.isBase64Encoded === true
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
  } catch {
    throw new BookingError("INVALID_INPUT");
  }
}

export function parseRequestBody(event: CloudBaseHttpEvent): ParsedBody {
  const contentType = (requestHeader(event, "content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const acceptsJson = (requestHeader(event, "accept") ?? "")
    .toLowerCase()
    .includes("application/json");
  const raw = decodeBody(event);

  if (contentType === "application/x-www-form-urlencoded") {
    const values: Record<string, unknown> = Object.create(null);
    for (const [name, value] of new URLSearchParams(raw)) values[name] = value;
    return { values, isForm: true, acceptsJson };
  }
  if (contentType !== "application/json") throw new BookingError("INVALID_INPUT");
  try {
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BookingError("INVALID_INPUT");
    }
    return { values: value as Record<string, unknown>, isForm: false, acceptsJson };
  } catch (error) {
    if (error instanceof BookingError) throw error;
    throw new BookingError("INVALID_INPUT");
  }
}
