export const LOGIN_FAILED_MESSAGE = "登录失败，请检查账号、密码和工作人员权限。";

type LoginFlowResult = "ready" | "auth_failed" | "refresh_failed";

type AdminLoginFlowOptions = {
  login: () => Promise<void>;
  onAuthenticated: () => void;
  refresh: () => Promise<void>;
  onAuthFailure: (message: string) => void | Promise<void>;
  onRefreshFailure: (message: string) => void;
};

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function refreshFailureMessage(error: unknown): string | null {
  const status = statusOf(error);
  if (status === 401) return null;
  if (status === 403) return "登录成功，但工作人员权限校验未通过（403）。";
  if (status !== undefined && status >= 500 && status <= 599) {
    return "登录成功，但后台服务暂时不可用（5xx），请稍后重试。";
  }
  return "登录成功，但后台数据暂时加载失败，请稍后重试。";
}

export async function runAdminLoginFlow(
  options: AdminLoginFlowOptions,
): Promise<LoginFlowResult> {
  try {
    await options.login();
  } catch {
    await options.onAuthFailure(LOGIN_FAILED_MESSAGE);
    return "auth_failed";
  }

  options.onAuthenticated();
  try {
    await options.refresh();
    return "ready";
  } catch (error) {
    const message = refreshFailureMessage(error);
    if (message) options.onRefreshFailure(message);
    return "refresh_failed";
  }
}
