import { bookingStatusPath } from "../../booking-config";
import { siteConfiguration } from "../../site-config";

const basePath = siteConfiguration.basePath;

export default function BookingResultPage() {
  const statusPath = bookingStatusPath(basePath);

  return (
    <main className="booking-flow-page">
      <section
        className="booking-flow-card booking-result-card"
        data-site-base-path={basePath}
        id="booking-result-shell"
      >
        <p className="booking-flow-kicker">BOOKING RECEIVED</p>
        <h1>预约申请已收到</h1>
        <p className="booking-flow-lead">
          工作人员确认前，场次仍显示为待确认。请保存下面的预约编号，用于随时查询进度。
        </p>
        <div className="booking-code-panel">
          <span>预约编号</span>
          <strong id="booking-result-code">正在读取…</strong>
        </div>
        <div className="booking-flow-actions">
          <a className="primary-button" href={statusPath} id="booking-result-status-link">
            查询预约状态
            <span aria-hidden="true">→</span>
          </a>
          <a className="booking-flow-back" href={`${basePath}/#booking`}>
            返回预约页面
          </a>
        </div>
        <p className="booking-flow-note">
          提交成功不等于场次已确认；如需取消或回应改期，请在状态页完成。
        </p>
      </section>
      <script
        data-booking-result-client
        defer
        src={`${basePath}/booking-result.js`}
      />
    </main>
  );
}
