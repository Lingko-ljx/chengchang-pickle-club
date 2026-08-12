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
          场地已经为你锁定。请保存下面的预约编号，用于随时查询或取消预约。
        </p>
        <div className="booking-code-panel">
          <span>预约编号</span>
          <strong id="booking-result-code">正在读取…</strong>
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
          如球馆需要调整时间，工作人员会通过预约电话与你联系。
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
