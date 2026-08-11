import {
  bookingStatusPath,
  resolveBookingApiBaseUrl,
} from "../../booking-config";
import { siteConfiguration } from "../../site-config";

const basePath = siteConfiguration.basePath;
const bookingApiBaseUrl = resolveBookingApiBaseUrl(
  process.env.NEXT_PUBLIC_BOOKING_API_BASE_URL,
  {
    development: process.env.NODE_ENV === "development",
    required: process.env.GITHUB_PAGES === "true",
  },
);

export default function BookingStatusPage() {
  return (
    <main className="booking-flow-page" data-public-channel-page="status">
      <section
        className="booking-flow-card booking-status-card"
        data-api-base-url={bookingApiBaseUrl}
        data-site-base-path={basePath}
        id="booking-status-shell"
      >
        <p className="booking-flow-kicker">BOOKING STATUS</p>
        <h1>查询预约状态</h1>
        <p className="booking-flow-lead">
          输入预约编号和预留手机号。验证成功后可查看进度、取消预约或回应改期。
        </p>

        <form
          action={bookingStatusPath(basePath)}
          className="booking-status-form"
          id="booking-status-form"
          method="post"
        >
          <label htmlFor="booking-status-code">
            <span>预约编号</span>
            <input
              autoComplete="off"
              id="booking-status-code"
              required
              type="text"
            />
          </label>
          <label htmlFor="booking-status-phone">
            <span>预留手机号</span>
            <input
              autoComplete="tel"
              id="booking-status-phone"
              inputMode="tel"
              pattern="[0-9+() -]{8,20}"
              required
              type="tel"
            />
          </label>
          <button className="primary-button" type="submit">
            安全查询
            <span aria-hidden="true">→</span>
          </button>
        </form>

        <p
          className="booking-flow-message"
          hidden
          id="booking-status-message"
          role="status"
        />

        <section
          aria-live="polite"
          className="booking-status-result"
          hidden
          id="booking-status-result"
        >
          <div className="booking-status-heading">
            <span>当前状态</span>
            <strong id="booking-status-value" />
          </div>
          <dl className="booking-status-summary">
            <div>
              <dt>场次</dt>
              <dd id="booking-status-session" />
            </div>
            <div>
              <dt>预约方式</dt>
              <dd id="booking-status-mode" />
            </div>
            <div>
              <dt>参与人数</dt>
              <dd id="booking-status-party-size" />
            </div>
            <div>
              <dt>脱敏联系人</dt>
              <dd id="booking-status-contact" />
            </div>
          </dl>

          <div className="booking-timeline-panel">
            <h2>状态进度</h2>
            <ol className="booking-timeline" id="booking-status-timeline" />
          </div>

          <p
            className="booking-proposed-session"
            hidden
            id="booking-status-proposed"
          />
          <div className="booking-action-row">
            <button
              className="secondary-button"
              hidden
              id="booking-status-cancel"
              type="button"
            >
              取消预约
            </button>
            <button
              className="primary-button"
              hidden
              id="booking-status-accept"
              type="button"
            >
              接受改期
            </button>
            <button
              className="secondary-button"
              hidden
              id="booking-status-reject"
              type="button"
            >
              拒绝改期
            </button>
          </div>
        </section>

        <a
          className="booking-flow-back"
          data-preserve-public-channel
          href={`${basePath}/#booking`}
        >
          返回预约页面
        </a>
      </section>
      <script
        data-booking-status-client
        defer
        src={`${basePath}/booking-status.js`}
      />
      <script data-wechat-entry-client defer src={`${basePath}/wechat-entry.js`} />
    </main>
  );
}
