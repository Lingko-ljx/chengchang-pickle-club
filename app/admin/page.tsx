import { resolveBookingApiBaseUrl } from "../booking-config";

function validatedBasePath(value: string | undefined): string {
  const candidate = value?.trim() ?? "";
  const normalized = candidate === "/" ? "" : candidate.replace(/\/+$/, "");
  if (normalized && !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalized)) {
    throw new Error("PAGES_BASE_PATH must be empty or a safe absolute path");
  }
  return normalized;
}

const basePath = validatedBasePath(process.env.PAGES_BASE_PATH);
const required = process.env.GITHUB_PAGES === "true";
const apiBaseUrl = resolveBookingApiBaseUrl(
  process.env.NEXT_PUBLIC_BOOKING_API_BASE_URL,
  { development: process.env.NODE_ENV === "development", required },
);
const envCandidate = process.env.NEXT_PUBLIC_CLOUDBASE_ENV_ID?.trim() ?? "";
const cloudbaseEnvId = /^[a-z0-9][a-z0-9-]{2,63}$/i.test(envCandidate)
  ? envCandidate
  : "";

if (required && !cloudbaseEnvId) {
  throw new Error("NEXT_PUBLIC_CLOUDBASE_ENV_ID must be a valid public CloudBase env ID");
}

export default function AdminPage() {
  const unavailable = !apiBaseUrl || !cloudbaseEnvId;

  return (
    <main className="admin-page">
      <section
        className="admin-shell"
        data-api-base-url={apiBaseUrl}
        data-cloudbase-env-id={cloudbaseEnvId}
        data-site-base-path={basePath}
        id="admin-shell"
      >
        <header className="admin-header">
          <div>
            <p className="admin-kicker">CHENGCHANG STAFF</p>
            <h1>场务管理</h1>
          </div>
          <button hidden id="admin-sign-out" type="button">退出登录</button>
        </header>

        <p className="admin-unavailable" hidden={!unavailable} id="admin-unavailable" role="alert">
          后台暂不可用，请联系系统管理员检查公开配置。
        </p>

        <form className="admin-login" hidden={unavailable} id="admin-login-form">
          <h2>工作人员登录</h2>
          <p>使用已配置为 booking_staff 的 CloudBase 账号登录。</p>
          <label htmlFor="admin-username">
            <span>用户名</span>
            <input autoComplete="username" id="admin-username" required type="text" />
          </label>
          <label htmlFor="admin-password">
            <span>密码</span>
            <input autoComplete="current-password" id="admin-password" required type="password" />
          </label>
          <button className="primary-button" type="submit">登录后台</button>
          <p className="admin-message" hidden id="admin-login-message" role="status" />
        </form>

        <div hidden id="admin-dashboard">
          <nav aria-label="后台视图" className="admin-tabs">
            <a href="#admin-today">今日待办</a>
            <a href="#admin-calendar">场地矩阵</a>
            <a href="#admin-settings">场地设置</a>
          </nav>

          <section className="admin-panel" id="admin-today">
            <div className="admin-section-heading">
              <div><span>TODAY</span><h2>今日待确认</h2></div>
              <strong id="admin-pending-count">0</strong>
            </div>
            <div className="admin-booking-list" id="admin-pending-list" />
          </section>

          <section className="admin-panel" id="admin-calendar">
            <div className="admin-section-heading">
              <div><span>OPERATIONS</span><h2>预约与场地</h2></div>
            </div>
            <form className="admin-filters" id="admin-filter-form">
              <label htmlFor="admin-filter-date"><span>日期</span><input id="admin-filter-date" required type="date" /></label>
              <label htmlFor="admin-filter-status"><span>状态</span><select id="admin-filter-status"><option value="">全部</option><option value="pending">待确认</option><option value="confirmed">已确认</option><option value="reschedule_proposed">等待改期</option><option value="cancelled">已取消</option><option value="completed">已完成</option></select></label>
              <label htmlFor="admin-filter-mode"><span>模式</span><select id="admin-filter-mode"><option value="">全部</option><option value="private">包场</option><option value="open">散客</option></select></label>
              <label htmlFor="admin-filter-query"><span>手机号 / 编号</span><input id="admin-filter-query" type="search" /></label>
              <button type="submit">筛选</button>
            </form>
            <div className="admin-matrix-scroll" id="admin-court-matrix" tabIndex={0} />
            <div className="admin-workspace">
              <div className="admin-booking-list" id="admin-booking-list" />
              <aside className="admin-detail" id="admin-booking-detail" />
            </div>
          </section>

          <section className="admin-panel admin-settings" id="admin-settings">
            <div className="admin-section-heading"><div><span>SETTINGS</span><h2>场地与开放时段</h2></div></div>
            <div className="admin-settings-grid">
              <div><h3>11 片场地</h3><div className="admin-court-controls" id="admin-court-controls" /></div>
              <div><h3>60 分钟场次模板</h3><div id="admin-template-controls" /><p>每个模板固定 60 分钟。</p></div>
            </div>
            <form className="admin-export" id="admin-export-form"><h3>CSV 导出</h3><label htmlFor="admin-export-from"><span>开始日期</span><input id="admin-export-from" required type="date" /></label><label htmlFor="admin-export-to"><span>结束日期</span><input id="admin-export-to" required type="date" /></label><button type="submit">下载 CSV</button></form>
          </section>
        </div>

        <p className="admin-message" hidden id="admin-message" role="status" />
      </section>
      <script data-admin-client defer src={`${basePath}/admin-app.js`} />
    </main>
  );
}
