import { bookingStatusPath } from "../../booking-config";
import { siteConfiguration } from "../../site-config";

const basePath = siteConfiguration.basePath;

export default function BookingResultPage() {
  const statusPath = bookingStatusPath(basePath);

  return (
    <main className="booking-flow-page" data-public-channel-page="result">
      <section
        className="booking-flow-card booking-result-card"
        data-site-base-path={basePath}
        id="booking-result-shell"
      >
        <p className="booking-flow-kicker">BOOKING CONFIRMED</p>
        <h1>预约已自动确认</h1>
        <p className="booking-flow-lead">
          场地已经为你锁定。4 位预约编号方便前台核对；安全查询码用于在线查询或取消预约。
        </p>
        <div className="booking-code-panel">
          <span>预约编号 · 手机号后四位</span>
          <strong id="booking-result-code">正在读取…</strong>
          <div className="booking-secure-code">
            <span>安全查询码</span>
            <code id="booking-result-secure-code">正在读取…</code>
            <small>为防止相同尾号串单，请和预留手机号一起保存。</small>
          </div>
        </div>
        <div className="booking-flow-actions">
          <a
            className="primary-button"
            data-preserve-public-channel="code"
            href={statusPath}
            id="booking-result-status-link"
          >
            查询预约状态
            <span aria-hidden="true">→</span>
          </a>
          <a
            className="booking-flow-back"
            data-preserve-public-channel
            href={`${basePath}/#booking`}
          >
            返回预约页面
          </a>
        </div>
        <p className="booking-flow-note">
          如球馆需要调整时间，工作人员会通过预约电话与你联系；到店只需报 4 位预约编号。
        </p>
      </section>
      <script
        data-booking-result-client
        defer
        src={`${basePath}/booking-result.js`}
      />
      <script data-wechat-entry-client defer src={`${basePath}/wechat-entry.js`} />
    </main>
  );
}
