import { BookingError } from "../../../lib/booking/errors.ts";

export interface CurrentUserProfile {
  user_id: string;
  groups: Array<{ id: string }>;
}

interface AuthResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export type AuthFetch = (
  input: string,
  init: { headers: { Authorization: string } },
) => Promise<AuthResponse>;

function profileFrom(value: unknown): CurrentUserProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.user_id !== "string" || !candidate.user_id.trim()) return null;
  if (!Array.isArray(candidate.groups)) return null;
  const groups = candidate.groups.flatMap((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return [];
    const id = (group as Record<string, unknown>).id;
    return typeof id === "string" ? [{ id }] : [];
  });
  return { user_id: candidate.user_id, groups };
}

export async function currentUser(
  authorization: string | undefined,
  envId: string,
  fetchImpl: AuthFetch = fetch as AuthFetch,
): Promise<CurrentUserProfile> {
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization.trim())) {
    throw new BookingError("AUTH_REQUIRED");
  }
  try {
    const response = await fetchImpl(
      `https://${envId}.api.tcloudbasegateway.com/auth/v1/user/me`,
      { headers: { Authorization: authorization } },
    );
    if (!response.ok) throw new BookingError("AUTH_REQUIRED");
    const profile = profileFrom(await response.json());
    if (!profile) throw new BookingError("AUTH_REQUIRED");
    return profile;
  } catch {
    throw new BookingError("AUTH_REQUIRED");
  }
}

export function requireBookingStaff(profile: CurrentUserProfile): void {
  if (!profile.groups.some((group) => group.id === "booking_staff")) {
    throw new BookingError("FORBIDDEN");
  }
}
