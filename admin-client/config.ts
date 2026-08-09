export type AdminConfig = {
  cloudbaseEnvId: string;
  apiBaseUrl: string;
  siteBasePath: string;
};

type V2Auth = {
  signIn(input: { username: string; password: string }): Promise<{
    credential: { accessToken: string };
  }>;
};

export function createAuthenticatedSession(auth: V2Auth) {
  let accessToken = "";
  return {
    async login(username: string, password: string) {
      const loginState = await auth.signIn({ username, password });
      accessToken = loginState.credential.accessToken;
      if (!accessToken) throw new Error("AUTH_REQUIRED");
    },
    getAccessToken: () => accessToken,
    clear: () => { accessToken = ""; },
  };
}

type ConfigElement = {
  dataset: {
    cloudbaseEnvId?: string;
    apiBaseUrl?: string;
    siteBasePath?: string;
  };
};

function unavailable(): never {
  throw new Error("后台暂不可用");
}

export function readAdminConfig(shell: ConfigElement): AdminConfig {
  const cloudbaseEnvId = shell.dataset.cloudbaseEnvId?.trim() ?? "";
  const apiBaseUrl = shell.dataset.apiBaseUrl?.trim() ?? "";
  const rawBasePath = shell.dataset.siteBasePath?.trim() ?? "";

  if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(cloudbaseEnvId)) unavailable();

  try {
    const parsed = new URL(apiBaseUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      unavailable();
    }
  } catch {
    unavailable();
  }

  const siteBasePath = rawBasePath === "/" ? "" : rawBasePath.replace(/\/+$/, "");
  if (siteBasePath && !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(siteBasePath)) {
    unavailable();
  }

  return { cloudbaseEnvId, apiBaseUrl, siteBasePath };
}
