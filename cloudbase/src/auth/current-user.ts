import { BookingError } from "../../../lib/booking/errors.ts";

export interface TrustedRuntimeAuth {
  getAuthContext(context: unknown): Promise<unknown>;
}

const canonicalUid = /^[1-9][0-9]{0,31}$/;

function runtimeUid(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BookingError("AUTH_REQUIRED");
  }
  const uid = (value as Record<string, unknown>).uid;
  if (typeof uid !== "string" || !canonicalUid.test(uid)) {
    throw new BookingError("AUTH_REQUIRED");
  }
  return uid;
}

export async function resolveTrustedRuntimeUid(
  auth: TrustedRuntimeAuth,
  context: unknown,
): Promise<string> {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new BookingError("AUTH_REQUIRED");
  }
  try {
    return runtimeUid(await auth.getAuthContext(context));
  } catch {
    throw new BookingError("AUTH_REQUIRED");
  }
}

export function requireAllowedAdminUid(
  value: unknown,
  allowedUserIds: readonly string[],
): string {
  const uid = runtimeUid({ uid: value });
  if (!allowedUserIds.includes(uid)) {
    throw new BookingError("FORBIDDEN");
  }
  return uid;
}
