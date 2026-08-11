import { resolveBookingApiBaseUrl } from "../booking-config";
import { siteConfiguration } from "../site-config";

const basePath = siteConfiguration.basePath;
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
            <p className="admin-kicker">睿安成 STAFF</p>
            <h1>场务管理</h1>
          </div>
          <button hidden id="admin-sign-out" type="button">退出登录</button>
        </header>

        <p className="admin-unavailable" hidden={!unavailable} id="admin-unavailable" role="alert">
          后台暂不可用，请联系系统管理员检查公开配置。
        </p>

        <form className="admin-login" hidden={unavailable} id="admin-login-form">
          <h2>工作人员登录</h2>
          <p>使用已授权的 CloudBase 工作人员账号登录。</p>
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
            <a href="#admin-media">首页宣传</a>
            <a href="#admin-settings">营业设置</a>
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
              <label htmlFor="admin-filter-query"><span>姓名 / 手机号后四位</span><input id="admin-filter-query" type="search" /></label>
              <button type="submit">筛选</button>
            </form>
            <div className="admin-matrix-scroll" id="admin-court-matrix" tabIndex={0} />
            <div className="admin-workspace">
              <div className="admin-booking-list" id="admin-booking-list" />
              <aside className="admin-detail" id="admin-booking-detail" />
            </div>
          </section>

          <section className="admin-panel admin-media" id="admin-media">
            <div className="admin-section-heading">
              <div><span>DAILY MOMENTS</span><h2>首页宣传</h2></div>
            </div>
            <div className="admin-media-layout">
              <form className="admin-media-form" id="admin-media-upload-form">
                <div>
                  <h3>上传今日图片或视频</h3>
                  <p>图片支持 JPG、PNG、WebP（不超过 8MB）；视频支持 MP4（不超过 50MB）。上传完成后立即发布到首页。</p>
                </div>
                <label htmlFor="admin-media-file"><span>图片或视频</span><input accept="image/jpeg,image/png,image/webp,video/mp4" id="admin-media-file" required type="file" /></label>
                <label htmlFor="admin-media-title"><span>标题</span><input id="admin-media-title" maxLength={60} placeholder="例如：今日精彩回合" required type="text" /></label>
                <label htmlFor="admin-media-caption"><span>说明（选填）</span><textarea id="admin-media-caption" maxLength={200} placeholder="一句话介绍今天的球场瞬间" rows={3} /></label>
                <label htmlFor="admin-media-alt"><span>画面描述（选填）</span><input id="admin-media-alt" maxLength={120} placeholder="未填写时自动使用标题" type="text" /></label>
                <button className="primary-button" id="admin-media-upload" type="submit">上传并发布</button>
                <p className="admin-media-form-status" hidden id="admin-media-form-status" role="status" />
              </form>
              <div className="admin-media-library">
                <div className="admin-media-library-heading"><h3>已上传内容</h3><span id="admin-media-count">0 条</span></div>
                <div className="admin-media-list" id="admin-media-list" />
              </div>
            </div>
          </section>

          <section className="admin-panel admin-settings" id="admin-settings">
            <div className="admin-section-heading"><div><span>SETTINGS</span><h2>营业规则与场地</h2></div></div>
            <div className="admin-settings-grid">
              <article className="admin-policy-card">
                <p className="admin-setting-eyebrow">营业规则</p>
                <h3><span id="admin-policy-opening">09:00–22:00</span> 每日开放</h3>
                <dl className="admin-policy-summary">
                  <div><dt>开始间隔</dt><dd id="admin-policy-interval">30 分钟</dd></div>
                  <div><dt>最短预约</dt><dd id="admin-policy-minimum">1 小时</dd></div>
                  <div><dt>计费方式</dt><dd id="admin-policy-billing">整小时</dd></div>
                  <div><dt>最长预约</dt><dd id="admin-policy-maximum">4 小时</dd></div>
                </dl>
                <p className="admin-policy-note">所有时间均为北京时间。预约人可从整点或半点开始。</p>
              </article>
              <article className="admin-court-settings-card">
                <div className="admin-court-settings-heading">
                  <div><p className="admin-setting-eyebrow">场地开关</p><h3>11 片场地</h3></div>
                  <strong id="admin-enabled-court-count">0 / 11 开放</strong>
                </div>
                <div className="admin-court-toolbar">
                  <button id="admin-enable-all-courts" type="button">全部开放</button>
                  <button id="admin-disable-all-courts" type="button">全部关闭</button>
                </div>
                <div className="admin-court-controls" id="admin-court-controls" />
                <div className="admin-court-save-row">
                  <span id="admin-court-draft-status">当前没有未保存修改</span>
                  <button disabled id="admin-save-courts" type="button">保存场地设置</button>
                </div>
              </article>
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
