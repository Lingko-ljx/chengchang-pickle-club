import { BookingForm } from "./BookingForm";
import {
  bookingCreateUrl,
  bookingResultPath,
  bookingStatusPath,
  resolveBookingApiBaseUrl,
  resolveBookingScriptSrc,
} from "./booking-config";
import { siteConfiguration } from "./site-config";

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
const bookingScriptSrc = resolveBookingScriptSrc(basePath);

const values = [
  {
    number: "01",
    title: "轻松上手",
    copy: "更小的场地、更短的球拍，让第一次挥拍也能快速形成多拍回合。",
  },
  {
    number: "02",
    title: "节奏恰好",
    copy: "既有网球的策略，也有羽毛球的敏捷；对抗有趣，但身体负担更温和。",
  },
  {
    number: "03",
    title: "自然社交",
    copy: "双打是这项运动最迷人的打开方式，在轻快攻防里认识同频的人。",
  },
];

const coaches = [
  {
    name: "刘栖睿",
    role: "总教头",
    badge: "LQR",
    style: "portrait-one",
    detail: "课程安排与训练计划请联系球馆确认",
  },
  {
    name: "唐语彤",
    role: "特约嘉宾",
    badge: "TYT",
    style: "portrait-two",
    detail: "课程安排与训练计划请联系球馆确认",
  },
  {
    name: "曾海鑫",
    role: "普通教练",
    badge: "ZHX",
    style: "portrait-three",
    detail: "课程安排与训练计划请联系球馆确认",
  },
  {
    name: "毛智谦",
    role: "普通教练",
    badge: "MZQ",
    style: "portrait-four",
    detail: "课程安排与训练计划请联系球馆确认",
  },
  {
    name: "刘洋",
    role: "普通教练",
    badge: "LY",
    style: "portrait-five",
    detail: "课程安排与训练计划请联系球馆确认",
  },
  {
    name: "邹洪武",
    role: "普通教练",
    badge: "ZHW",
    style: "portrait-six",
    detail: "课程安排与训练计划请联系球馆确认",
  },
];

const honors = [
  {
    year: "2025",
    title: "PPA 杭州站 19+ 男子单打 3.5+ 亚军",
  },
  {
    year: "2025",
    title: "CPC600 兰威杯男子单打冠军",
  },
  {
    year: "2026",
    title: "WPC 海南站 4.0 男双冠军",
  },
  {
    year: "2026",
    title: "WPC 海南站 3.5 混双冠军",
  },
  {
    year: "2026",
    title: "CPC600 鹤壁浚县站男双冠军",
  },
  {
    year: "2026",
    title: "CPC600 河北石家庄站混双冠军",
  },
  {
    year: "2026",
    title: "APBA 全球总决赛男单季军",
  },
];

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#home" aria-label="睿安成 Pickle Club 首页">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span className="brand-name">
            睿安成
            <small>PICKLE CLUB</small>
          </span>
        </a>
        <nav className="nav-links" aria-label="主要导航">
          <a href="#about">匹克球</a>
          <a href="#venue">场地</a>
          <a href="#team">团队</a>
          <a href="#honors">荣誉</a>
          <a href="#contact">联系</a>
        </nav>
        <a className="header-cta" href="#booking">
          预约体验
          <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="hero section-shell" id="home">
        <div className="hero-copy">
          <p className="eyebrow">
            NANCHANG · PICKLEBALL CLUB
          </p>
          <h1>
            每一次挥拍，
            <br />
            <em>都有新的回合</em>
          </h1>
          <div className="hero-copy-bottom">
            <p>
              从第一次上场，到每一次默契配合。
              <br />
              睿安成 Pickle Club，让运动更轻松、更专注。
            </p>
            <a className="text-link" href="#about">
              认识匹克球
              <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>

        <div className="hero-visual">
          {/* The static hosts serve this generated public asset without an image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="蓝绿色匹克球场、球拍与黄色匹克球"
            className="hero-visual-image"
            src={`${basePath}/ruiancheng-court-hero.png`}
          />
          <div className="hero-caption">
            <span>RUIANCHENG</span>
            <span>NANCHANG</span>
          </div>
        </div>
      </section>

      <section
        className="daily-media section-shell"
        data-api-base={bookingApiBaseUrl}
        data-homepage-media
        hidden
        id="daily-moments"
      >
        <div className="daily-media-heading">
          <div>
            <p>DAILY MOMENTS</p>
            <h2>今日球场</h2>
          </div>
          <p>每天更新球场里的好回合、好照片和新鲜动态。</p>
        </div>
        <div className="daily-media-grid" data-homepage-media-list />
      </section>

      <section className="intro section-shell" id="about">
        <div className="section-kicker">
          <span>01</span>
          <p>匹克球介绍</p>
        </div>
        <div className="intro-heading">
          <h2>
            上手很快，
            <br />
            <span>却值得反复打磨。</span>
          </h2>
          <p>
            匹克球融合了网球、羽毛球与乒乓球的乐趣。它简单友好，
            又保留了足够多的策略空间——适合所有想认真运动，也想自在社交的人。
          </p>
        </div>
        <div className="value-grid">
          {values.map((value) => (
            <article className="value-card" key={value.number}>
              <span>{value.number}</span>
              <h3>{value.title}</h3>
              <p>{value.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="venue" id="venue">
        <div className="venue-inner section-shell">
          <div className="section-kicker light">
            <span>02</span>
            <p>场地介绍</p>
          </div>
          <div className="venue-heading">
            <h2>
              专业，是让你
              <br />
              <span>感觉不到打扰。</span>
            </h2>
            <p>
              11 片场地按小时开放预约。你可以选择散客拼场，也可以选择包场，
              在线查看可用时段后直接提交。
            </p>
          </div>
          <div className="venue-display">
            <div className="venue-board" aria-hidden="true">
              <span className="venue-board-number">11</span>
              <div className="venue-court">
                <span />
                <span />
                <span />
              </div>
              <p>INDOOR COURTS</p>
            </div>
            <div className="venue-details">
              <div>
                <span>场地</span>
                <strong>11</strong>
                <p>预约系统内开放场地</p>
              </div>
              <div>
                <span>场次</span>
                <strong>30 MIN</strong>
                <p>整点或半点均可开始</p>
              </div>
              <div>
                <span>开放</span>
                <strong>09 — 22</strong>
                <p>每日 09:00 — 22:00 开放</p>
              </div>
              <div>
                <span>方式</span>
                <strong>2 MODES</strong>
                <p>散客拼场或包场预约</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="team section-shell" id="team">
        <div className="section-kicker">
          <span>03</span>
          <p>教练团队</p>
        </div>
        <div className="team-heading">
          <h2>
            好教练不替你击球，
            <br />
            <span>只让每一拍更像你。</span>
          </h2>
          <p>具体课程内容、时间与适合人群，请联系球馆确认。</p>
        </div>
        <div className="coach-grid">
          {coaches.map((coach, index) => (
            <article className="coach-card" key={coach.name}>
              <div
                className={`coach-portrait ${coach.style}`}
                role="img"
                aria-label={`${coach.name}匹克球主题图形`}
              >
                <span className="portrait-index">0{index + 1}</span>
                <span className="portrait-monogram">{coach.badge}</span>
                <span className="portrait-orbit" aria-hidden="true" />
              </div>
              <div className="coach-meta">
                <div>
                  <h3>{coach.name}</h3>
                  <span>{coach.role}</span>
                </div>
                <p>{coach.detail}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="honors section-shell" id="honors">
        <div className="section-kicker">
          <span>04</span>
          <p>荣誉时刻</p>
        </div>
        <div className="honors-layout">
          <div className="honors-title">
            <p>OUR MOMENTS</p>
            <h2>
              刘栖睿
              <br />
              <span>个人赛事荣誉</span>
            </h2>
          </div>
          <div className="honor-list" aria-label="刘栖睿个人赛事荣誉">
            {honors.map((honor, index) => (
              <article className="honor-row" key={honor.title}>
                <time>{honor.year}</time>
                <div>
                  <h3>{honor.title}</h3>
                  <p>刘栖睿 · 个人赛事荣誉</p>
                </div>
                <span className="honor-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="booking-section" id="booking">
        <div className="section-shell">
          <div className="section-kicker light">
            <span>05</span>
            <p>预约体验</p>
          </div>
          <BookingForm
            apiBaseUrl={bookingApiBaseUrl}
            formEndpoint={formEndpoint}
            resultPath={bookingResultPath(basePath)}
            scriptSrc={bookingScriptSrc}
            statusPath={bookingStatusPath(basePath)}
          />
          <div className="booking-status-entry">
            <span>已经提交过预约？</span>
            <a href={bookingStatusPath(basePath)}>查询状态、取消或回应改期 →</a>
          </div>
        </div>
      </section>

      <section className="contact section-shell" id="contact">
        <div className="section-kicker">
          <span>06</span>
          <p>联系我们</p>
        </div>
        <div className="contact-layout">
          <div className="contact-title">
            <h2>
              下一场好球，
              <br />
              <span>从一次见面开始。</span>
            </h2>
            <a href="#booking" className="circle-link" aria-label="前往预约体验">
              <span>BOOK</span>
              <i aria-hidden="true">↗</i>
            </a>
          </div>
          <div className="contact-grid">
            <div>
              <span>地址 ADDRESS</span>
              <p>江西省南昌市青山湖区青山湖南大道260号14号楼</p>
              <small>到店前建议先完成线上预约</small>
            </div>
            <div>
              <span>电话 TELEPHONE</span>
              <p><a href="tel:+8613807917663">13807917663</a></p>
              <small>点击号码可直接拨打</small>
            </div>
            <div>
              <span>营业时间 OPENING</span>
              <p>周一至周日 09:00 — 22:00</p>
              <small>法定节假日以公告为准</small>
            </div>
          </div>
        </div>
      </section>

      <footer className="site-footer section-shell">
        <a className="brand footer-brand" href="#home" aria-label="返回顶部">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span className="brand-name">
            睿安成
            <small>PICKLE CLUB</small>
          </span>
        </a>
        <p>© 2026 睿安成 PICKLE CLUB</p>
        <p>江西 · 南昌</p>
      </footer>
      <script data-homepage-media-client defer src={`${basePath}/homepage-media.js`} />
    </main>
  );
}
