import { BookingForm } from "./BookingForm";
import {
  bookingCreateUrl,
  bookingResultPath,
  bookingStatusPath,
  resolveBookingApiBaseUrl,
  resolveBookingScriptSrc,
} from "./booking-config";

const basePath =
  process.env.PAGES_BASE_PATH === "/"
    ? ""
    : (process.env.PAGES_BASE_PATH ?? "").replace(/\/+$/, "");
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
    name: "陆予安",
    role: "竞技总教练",
    badge: "LYA",
    style: "portrait-one",
    detail: "前职业网球运动员 · PPR 认证教练",
    quote: "把复杂的击球，讲成身体能记住的节奏。",
  },
  {
    name: "周澄",
    role: "入门与体能教练",
    badge: "ZC",
    style: "portrait-two",
    detail: "运动康复背景 · 青少年课程负责人",
    quote: "好的第一堂课，是让你离开时已经期待下一次。",
  },
  {
    name: "林岚",
    role: "球会主理人",
    badge: "LL",
    style: "portrait-three",
    detail: "赛事策划人 · 城市社群发起者",
    quote: "我们经营的不只是球场，也是人与人相遇的方式。",
  },
];

const honors = [
  {
    year: "2025",
    title: "城市球会邀请赛 · 团体冠军",
    meta: "华东赛区 / 公开组",
  },
  {
    year: "2024",
    title: "年度新锐运动空间",
    meta: "CITY SPORTS AWARDS",
  },
  {
    year: "2024",
    title: "公开赛混合双打 · 冠军",
    meta: "澄场教练团队",
  },
  {
    year: "2023",
    title: "青少年推广计划 · 优秀组织",
    meta: "城市体育公益联盟",
  },
];

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#home" aria-label="澄场首页">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span className="brand-name">
            澄场
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
            SHANGHAI · PRIVATE PICKLEBALL CLUB
          </p>
          <h1>
            为城市留一块
            <br />
            <em>会呼吸的球场</em>
          </h1>
          <div className="hero-copy-bottom">
            <p>
              从第一次挥拍，到每一次默契配合。
              <br />
              澄场让运动回到轻松、专注和愉悦。
            </p>
            <a className="text-link" href="#about">
              认识匹克球
              <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>

        <div
          className="hero-visual"
          role="img"
          aria-label="暖绿色匹克球场的抽象俯视图"
        >
          <div className="hero-court">
            <span className="court-line court-line-v" />
            <span className="court-line court-line-h" />
            <span className="court-line court-line-top" />
            <span className="court-line court-line-bottom" />
            <span className="court-net" />
          </div>
          <div className="hero-ball" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="hero-caption">
            <span>PLAY SLOW</span>
            <span>FEEL MORE</span>
          </div>
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
              11 片专业缓震场地，独立新风与定向照明。每一处细节都服务于更清晰的球路、
              更自在的脚步和更纯粹的一场球。
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
                <span>净高</span>
                <strong>8.2 M</strong>
                <p>无立柱开阔空间</p>
              </div>
              <div>
                <span>地面</span>
                <strong>ACRYLIC</strong>
                <p>专业多层缓震系统</p>
              </div>
              <div>
                <span>开放</span>
                <strong>07 — 23</strong>
                <p>每日预约制开放</p>
              </div>
              <div>
                <span>配套</span>
                <strong>FULL SET</strong>
                <p>淋浴、更衣与装备租赁</p>
              </div>
            </div>
          </div>
          <p className="demo-note">场地参数为首版演示资料，可替换</p>
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
          <p>专业方法、清晰反馈，也保留每个人独特的运动节奏。</p>
        </div>
        <div className="coach-grid">
          {coaches.map((coach, index) => (
            <article className="coach-card" key={coach.name}>
              <div
                className={`coach-portrait ${coach.style}`}
                role="img"
                aria-label={`${coach.name}示意肖像`}
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
                <blockquote>“{coach.quote}”</blockquote>
              </div>
            </article>
          ))}
        </div>
        <p className="demo-note dark-note">人物经历为首版演示资料，可替换</p>
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
              成绩会被记录，
              <br />
              <span>热爱一直在继续。</span>
            </h2>
          </div>
          <div className="honor-list">
            {honors.map((honor) => (
              <article className="honor-row" key={`${honor.year}-${honor.title}`}>
                <time>{honor.year}</time>
                <div>
                  <h3>{honor.title}</h3>
                  <p>{honor.meta}</p>
                </div>
                <span aria-hidden="true">↗</span>
              </article>
            ))}
            <p className="demo-note">获奖信息为首版演示资料，可替换</p>
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
              <p>上海市徐汇区龙腾大道 88 号</p>
              <small>演示地址，可替换</small>
            </div>
            <div>
              <span>电话 TELEPHONE</span>
              <p>021 — 8888 7290</p>
              <small>演示号码，可替换</small>
            </div>
            <div>
              <span>营业时间 OPENING</span>
              <p>周一至周日 07:00 — 23:00</p>
              <small>法定节假日以公告为准</small>
            </div>
            <div>
              <span>社交媒体 SOCIAL</span>
              <p>小红书 / 微信视频号 @澄场</p>
              <small>演示账号，可替换</small>
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
            澄场
            <small>PICKLE CLUB</small>
          </span>
        </a>
        <p>© 2026 CHENGCHANG PICKLE CLUB</p>
        <p>当前内容为首版演示，不代表真实营业信息</p>
      </footer>
    </main>
  );
}
