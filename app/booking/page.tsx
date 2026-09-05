import { BookingForm } from "../BookingForm";
import {
  bookingCreateUrl,
  bookingResultPath,
  bookingStatusPath,
  resolveBookingApiBaseUrl,
  resolveBookingScriptSrc,
} from "../booking-config";
import { siteConfiguration } from "../site-config";
import { publicWechatEntryUrls } from "../wechat-entry";

const basePath = siteConfiguration.basePath;
const bookingApiBaseUrl = resolveBookingApiBaseUrl(
  process.env.NEXT_PUBLIC_BOOKING_API_BASE_URL,
  {
    development: process.env.NODE_ENV === "development",
    required: process.env.GITHUB_PAGES === "true",
  },
);
const formEndpoint = bookingApiBaseUrl
  ? bookingCreateUrl(bookingApiBaseUrl)
  : "";
const wechatEntryUrls = publicWechatEntryUrls(siteConfiguration.siteUrl);

export default function BookingPage() {
  const statusPath = bookingStatusPath(basePath);

  return (
    <main
      className="booking-standalone-page"
      data-public-channel-page="booking"
      data-wechat-menu-booking-url={wechatEntryUrls.menuBooking}
      data-wechat-menu-status-url={wechatEntryUrls.menuStatus}
      data-wechat-qr-booking-url={wechatEntryUrls.qrBooking}
    >
      <header className="booking-standalone-header section-shell">
        <a className="brand" href={`${basePath}/`} aria-label="返回睿安成 Pickle Club 首页">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span className="brand-name">
            睿安成
            <small>PICKLE CLUB</small>
          </span>
        </a>
        <div className="booking-standalone-title">
          <span>COURT BOOKING</span>
          <strong>预约场地</strong>
          <small>09:00–22:00 · 半点可约 · 1–4 小时</small>
        </div>
        <a
          className="booking-standalone-status"
          data-preserve-public-channel
          href={statusPath}
        >
          查询预约
        </a>
      </header>
      <nav className="booking-page-shortcuts section-shell" aria-label="预约页导航">
        <a href="#booking-form">填写预约</a>
        <a href="#public-schedule">看看谁来打球</a>
        <a href="tel:+8613807917663">电话联系</a>
      </nav>

      <section className="booking-section booking-standalone-section">
        <div className="section-shell">
          <BookingForm
            apiBaseUrl={bookingApiBaseUrl}
            formEndpoint={formEndpoint}
            publicScheduleScriptSrc={`${basePath}/public-schedule.js`}
            resultPath={bookingResultPath(basePath)}
            scriptSrc={resolveBookingScriptSrc(basePath)}
            statusPath={statusPath}
            variant="standalone"
          />
        </div>
      </section>
      <script data-wechat-entry-client defer src={`${basePath}/wechat-entry.js`} />
    </main>
  );
}
