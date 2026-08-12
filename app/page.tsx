import { BookingForm } from "./BookingForm";
import {
  bookingCreateUrl,
  bookingResultPath,
  bookingStatusPath,
  resolveBookingApiBaseUrl,
  resolveBookingScriptSrc,
} from "./booking-config";
import { siteConfiguration } from "./site-config";
import { publicWechatEntryUrls } from "./wechat-entry";

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
const wechatEntryUrls = publicWechatEntryUrls(siteConfiguration.siteUrl);

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

const featuredCoaches = [
  {
    name: "刘栖睿",
    role: "职业教练",
    badge: "LQR",
    image: "coaches/coach-liu-qirui.jpg",
    imageAlt: "职业教练刘栖睿在匹克球赛场准备接球",
    imageHeight: 2160,
    imageWidth: 1440,
    detail: "以实战判断、技术拆解与竞赛能力提升为训练重点。",
    highlights: [
      "2026 李宁杯中国匹克球巡回赛呼和浩特站（CPC-1000）公开组男子单打第一名",
      "2026 WPC 海南站 4.0 男子双打冠军",
      "2025 CPC600 兰威杯男子单打冠军",
    ],
  },
  {
    name: "唐语彤",
    role: "特邀职业教练",
    badge: "TYT",
    image: "coaches/coach-tang-yutong.jpg",
    imageAlt: "特邀职业教练唐语彤在匹克球比赛中专注接球",
    imageHeight: 3200,
    imageWidth: 2133,
    detail: "以比赛节奏、双打配合与动作细节为训练重点。",
    highlights: [
      "职业赛场经验与双打协作训练",
      "课程与到馆时间请联系球馆确认",
    ],
  },
];

const supportCoaches = [
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

const coachGallery = [
  {
    slot: "doubles-match",
    image: "coaches/coaches-doubles-match.jpg",
    imageAlt: "刘栖睿和唐语彤搭档参加匹克球双打比赛",
    imageHeight: 960,
    imageWidth: 1440,
    label: "MATCH · 双打赛场",
    title: "职业教练组合实战",
    copy: "刘栖睿 · 唐语彤",
    layout: "wide",
  },
  {
    slot: "hohhot-podium",
    image: "coaches/liu-hohhot-cpc1000-podium.jpg",
    imageAlt: "刘栖睿站上呼和浩特站冠军领奖台",
    imageHeight: 968,
    imageWidth: 1440,
    label: "PODIUM · 呼和浩特",
    title: "CPC-1000 冠军领奖台",
    copy: "刘栖睿 · 2026",
    layout: "wide",
  },
  {
    slot: "liu-tang-lushan-runner-up",
    image: "coaches/moments/liu-tang-lushan-runner-up.jpg",
    imageAlt: "刘栖睿与唐语彤手持庐山西海站匹克球巡回赛亚军奖牌和奖牌板",
    imageHeight: 2662,
    imageWidth: 3998,
    label: "PODIUM · 庐山西海",
    title: "混合双打赛场搭档",
    copy: "刘栖睿 · 唐语彤 · 2026",
    layout: "wide",
  },
  {
    slot: "liu-tang-doubles-teamwork",
    image: "coaches/moments/liu-tang-doubles-teamwork.jpg",
    imageAlt: "刘栖睿与唐语彤在匹克球双打比赛中击掌配合",
    imageHeight: 2492,
    imageWidth: 3744,
    label: "MATCH · 双打协作",
    title: "每一分都从沟通开始",
    copy: "刘栖睿 · 唐语彤",
    layout: "wide",
  },
  {
    slot: "liu-tang-hohhot-award",
    image: "coaches/moments/liu-tang-hohhot-award.jpg",
    imageAlt: "刘栖睿与唐语彤在呼和浩特站匹克球巡回赛颁奖现场",
    imageHeight: 959,
    imageWidth: 1440,
    label: "AWARD · 呼和浩特",
    title: "赛后颁奖时刻",
    copy: "刘栖睿 · 唐语彤 · 2026",
    layout: "wide",
  },
  {
    slot: "liu-match-backhand",
    image: "coaches/moments/liu-qirui-match-backhand.jpg",
    imageAlt: "刘栖睿在匹克球比赛中准备反手击球",
    imageHeight: 960,
    imageWidth: 1440,
    label: "MATCH · 男子单打",
    title: "刘栖睿赛场瞬间",
    copy: "职业教练 · 实战",
    layout: "wide",
  },
  {
    slot: "tang-match-focus",
    image: "coaches/moments/tang-yutong-match-focus.jpg",
    imageAlt: "唐语彤在匹克球比赛中专注准备接球",
    imageHeight: 3200,
    imageWidth: 2133,
    label: "MATCH · 赛场专注",
    title: "唐语彤赛场瞬间",
    copy: "特邀职业教练 · 实战",
    layout: "portrait",
  },
];

const championHighlights = [
  {
    year: "2026",
    short: "CPC-1000 · 呼和浩特",
    title: "公开组男子单打第一名",
  },
  {
    year: "2026",
    short: "WPC · 海南站",
    title: "4.0 男子双打冠军",
  },
  {
    year: "2025",
    short: "CPC600 · 兰威杯",
    title: "男子单打冠军",
  },
];

const staticHonorMedia = [
  {
    slot: "liu-kaihua-certificate",
    image: "coaches/honors/liu-kaihua-cpc1000-singles-second-certificate.jpg",
    imageAlt: "刘栖睿浙江开化站CPC-1000公开组男子单打第二名证书",
    year: 2026,
    owner: "liu-qirui",
    title: "浙江开化站公开组第二名",
    description: "CPC-1000 · 男子单打",
    imageHeight: 1110,
    imageWidth: 790,
  },
  {
    slot: "liu-tang-hohhot-certificate",
    image: "coaches/honors/liu-tang-hohhot-cpc1000-mixed-second-certificate.jpg",
    imageAlt: "刘栖睿和唐语彤呼和浩特站CPC-1000公开混合双打第二名证书",
    year: 2026,
    owner: "coach-team",
    title: "呼和浩特站混合双打第二名",
    description: "CPC-1000 · 刘栖睿 / 唐语彤",
    imageHeight: 900,
    imageWidth: 640,
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
  {
    year: "2026",
    title: "李宁杯中国匹克球巡回赛呼和浩特站（CPC-1000）公开组男子单打第一名",
  },
];

export default function Home() {
  return (
    <main
      data-public-channel-page="booking"
      data-wechat-menu-booking-url={wechatEntryUrls.menuBooking}
      data-wechat-menu-status-url={wechatEntryUrls.menuStatus}
      data-wechat-qr-booking-url={wechatEntryUrls.qrBooking}
    >
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

      <details className="mobile-site-nav">
        <summary>浏览目录</summary>
        <nav aria-label="手机页面目录">
          <a href="#home">首页</a>
          <a href="#daily-moments">今日 / 往日球场</a>
          <a href="#team">教练</a>
          <a href="#honors">荣誉</a>
          <a href="#booking">预约</a>
          <a href="#contact">联系</a>
        </nav>
      </details>

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
            alt="睿安成 PICKLE CLUB 南昌匹克球馆主视觉"
            className="hero-visual-image"
            decoding="async"
            fetchPriority="high"
            height={941}
            loading="eager"
            src={`${basePath}/ruiancheng-court-hero.png`}
            width={1672}
          />
        </div>
      </section>

      <section
        className="daily-media section-shell"
        data-api-base={bookingApiBaseUrl}
        data-homepage-media
        id="daily-moments"
      >
        <div className="daily-media-heading">
          <div>
            <p>DAILY MOMENTS</p>
            <h2 data-homepage-media-title>今日球场</h2>
          </div>
          <div className="daily-media-heading-actions">
            <p>每天更新球场里的好回合、好照片和新鲜动态。</p>
            <button data-homepage-media-today hidden type="button">回到最新</button>
          </div>
        </div>
        <div className="daily-media-date-track" data-homepage-media-dates hidden />
        <div className="daily-media-grid" data-homepage-media-list>
          <p className="daily-media-empty" data-homepage-media-empty>今日内容更新后将在这里呈现，也可浏览往日球场。</p>
        </div>
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
        <div className="coach-feature-grid">
          {featuredCoaches.map((coach, index) => (
            <article className="coach-feature-card" key={coach.name}>
              <div className="coach-feature-photo" data-coach-media-slot={`featured-${coach.badge.toLowerCase()}`}>
                {/* Static hosts serve the supplied coach photos without an image optimizer. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={coach.imageAlt}
                  decoding="async"
                  height={coach.imageHeight}
                  loading="lazy"
                  src={`${basePath}/${coach.image}`}
                  width={coach.imageWidth}
                />
                <span className="coach-feature-index">0{index + 1}</span>
                <span className="coach-feature-role">{coach.role}</span>
              </div>
              <div className="coach-feature-copy">
                <p>PRO COACH · {coach.badge}</p>
                <div>
                  <h3>{coach.name}</h3>
                  <span>{coach.role}</span>
                </div>
                <p>{coach.detail}</p>
                <ul>
                  {coach.highlights.map((highlight) => (
                    <li key={highlight}>{highlight}</li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
        <div className="coach-support-heading">
          <div>
            <p>COACHING TEAM</p>
            <h3>教练阵容</h3>
          </div>
          <p>基础入门、日常陪练与专项提升，可按需求联系球馆安排。</p>
        </div>
        <div className="coach-support-grid">
          {supportCoaches.map((coach, index) => (
            <article className="coach-support-card" key={coach.name}>
              <span>0{index + 3}</span>
              <div>
                <h3>{coach.name}</h3>
                <p>{coach.role}</p>
              </div>
              <strong>{coach.badge}</strong>
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
          <div className="honor-overview">
            <div className="honor-champion-track" aria-label="刘栖睿重点冠军荣誉">
              {championHighlights.map((honor, index) => (
                <article className="honor-champion-card" key={honor.title}>
                  <span>0{index + 1}</span>
                  <time>{honor.year}</time>
                  <p>{honor.short}</p>
                  <h3>{honor.title}</h3>
                </article>
              ))}
            </div>
            <details className="honor-history">
              <summary>查看完整赛事履历 <span>{honors.length} 项</span></summary>
              <div className="honor-history-track honor-list" aria-label="刘栖睿个人赛事荣誉">
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
            </details>
          </div>
        </div>
        <div className="coach-gallery-heading">
          <div>
            <p>FIELD NOTES</p>
            <h2>赛场与荣誉影像</h2>
          </div>
          <p>将比赛动作、领奖时刻和证书分开呈现，快速看清每位教练的赛场经历。</p>
        </div>
        <div className="coach-gallery honor-media-track" aria-label="教练赛场与荣誉照片画廊">
          {coachGallery.map((item) => (
            <figure
              className={`coach-gallery-item is-${item.layout}`}
              data-coach-media-slot={item.slot}
              key={item.slot}
            >
              <div className="coach-gallery-frame">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={item.imageAlt}
                  decoding="async"
                  height={item.imageHeight}
                  loading="lazy"
                  src={`${basePath}/${item.image}`}
                  width={item.imageWidth}
                />
              </div>
              <figcaption>
                <span>{item.label}</span>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </figcaption>
            </figure>
          ))}
        </div>
        <section className="honor-media" data-api-base={bookingApiBaseUrl} data-honor-media>
          <div className="honor-media-track honor-media-fallback" data-honor-media-fallback data-honor-media-list>
            {staticHonorMedia.map((item) => (
              <figure
                className="honor-media-card is-fallback"
                data-honor-fallback-key={`${item.owner}|${item.year}|${item.title}`}
                data-coach-media-slot={item.slot}
                key={item.slot}
              >
                <div className="honor-media-frame">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt={item.imageAlt}
                    decoding="async"
                    height={item.imageHeight}
                    loading="lazy"
                    src={`${basePath}/${item.image}`}
                    width={item.imageWidth}
                  />
                </div>
                <figcaption>
                  <span>{item.year} · CERTIFICATE</span>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
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
            publicScheduleScriptSrc={`${basePath}/public-schedule.js`}
            resultPath={bookingResultPath(basePath)}
            scriptSrc={bookingScriptSrc}
            statusPath={bookingStatusPath(basePath)}
          />
          <div className="booking-status-entry">
            <span>已经提交过预约？</span>
            <a data-preserve-public-channel href={bookingStatusPath(basePath)}>
              查询状态、取消或回应改期 →
            </a>
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
      <script data-honor-media-client defer src={`${basePath}/honor-media.js`} />
      <script data-wechat-entry-client defer src={`${basePath}/wechat-entry.js`} />
    </main>
  );
}
