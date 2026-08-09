export type AdminConfig = {
  cloudbaseEnvId: string;
  apiBaseUrl: string;
  siteBasePath: string;
};

type V2Auth = {
  signIn(input: { username: string; password: string }): Promise<unknown>;
  getAccessToken(): Promise<unknown>;
  signOut(): Promise<unknown>;
};

export type MemoryAuthStorage = {
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  setItem(key: string, value: string): Promise<void>;
  getItemSync(key: string): string | null;
  removeItemSync(key: string): void;
  setItemSync(key: string, value: string): void;
  clear(): void;
};

export function createMemoryAuthStorage(): MemoryAuthStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => { values.delete(key); },
    setItem: async (key, value) => { values.set(key, value); },
    getItemSync: (key) => values.get(key) ?? null,
    removeItemSync: (key) => { values.delete(key); },
    setItemSync: (key, value) => { values.set(key, value); },
    clear: () => { values.clear(); },
  };
}

type V2AuthApp = {
  auth(options: { persistence: "none"; storage: MemoryAuthStorage }): V2Auth;
};

type CloudBaseSdk = {
  init(options: {
    env: string;
    persistence: "none";
    storage: MemoryAuthStorage;
  }): V2AuthApp;
};

export function initializePrivateAuth(sdk: CloudBaseSdk, env: string) {
  const storage = createMemoryAuthStorage();
  const app = sdk.init({ env, persistence: "none", storage });
  return createAuthenticatedSession(app, storage);
}

export function createAuthenticatedSession(
  app: V2AuthApp,
  storage: MemoryAuthStorage = createMemoryAuthStorage(),
) {
  const auth = app.auth({ persistence: "none", storage });
  let accessToken = "";
  return {
    async login(username: string, password: string) {
      const loginState = await auth.signIn({ username, password });
      if (
        !loginState ||
        typeof loginState !== "object" ||
        !("user" in loginState) ||
        !loginState.user
      ) {
        throw new Error("AUTH_REQUIRED");
      }
      const tokenState = await auth.getAccessToken();
      if (
        !tokenState ||
        typeof tokenState !== "object" ||
        !("accessToken" in tokenState) ||
        typeof tokenState.accessToken !== "string" ||
        !tokenState.accessToken.trim()
      ) {
        throw new Error("AUTH_REQUIRED");
      }
      accessToken = tokenState.accessToken;
    },
    getAccessToken: () => accessToken,
    async clear() {
      accessToken = "";
      try {
        const result = await auth.signOut();
        if (result && typeof result === "object" && "error" in result && result.error) {
          throw new Error("AUTH_SIGN_OUT_FAILED");
        }
      } finally {
        storage.clear();
      }
    },
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
