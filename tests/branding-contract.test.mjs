import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const bookingFormSource = await readFile(
  new URL("../app/BookingForm.tsx", import.meta.url),
  "utf8",
);
const layoutSource = await readFile(
  new URL("../app/layout.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const heroArtwork = await readFile(
  new URL("../public/ruiancheng-court-hero.png", import.meta.url),
);

test("the homepage hero presents the supplied Ruiancheng brand artwork without cropping", () => {
  assert.match(
    pageSource,
    /alt="睿安成 PICKLE CLUB 南昌匹克球馆主视觉"/,
  );
  assert.match(pageSource, /height=\{941\}/);
  assert.match(pageSource, /width=\{1672\}/);
  assert.match(pageSource, /fetchPriority="high"/);
  assert.match(pageSource, /loading="eager"/);
  assert.equal(
    createHash("sha256").update(heroArtwork).digest("hex"),
    "0c12d5478f38a570a7d5dfd69f250837bee062e1dc3056926d5aca953b7f8afd",
  );
  assert.match(
    globalStyles,
    /\.hero-visual\s*\{[^}]*aspect-ratio:\s*1672\s*\/\s*941;[^}]*\}/s,
  );
  assert.match(
    globalStyles,
    /\.hero-visual-image\s*\{[^}]*object-fit:\s*contain;[^}]*\}/s,
  );
});

test("the public site uses the approved Ruiancheng identity and contact details", () => {
  const publicSource = `${pageSource}\n${bookingFormSource}\n${layoutSource}`;

  assert.match(publicSource, /睿安成/);
  assert.match(pageSource, /职业教练/);
  assert.match(pageSource, /刘栖睿/);
  assert.match(pageSource, /特邀职业教练/);
  assert.match(pageSource, /唐语彤/);
  assert.match(pageSource, /普通教练/);
  for (const coach of ["曾海鑫", "毛智谦", "刘洋", "邹洪武"]) {
    assert.match(pageSource, new RegExp(coach));
  }
  assert.match(publicSource, /江西省南昌市青山湖区青山湖南大道260号14号楼/);
  assert.match(publicSource, /13807917663/);
  assert.match(pageSource, /ruiancheng-court-hero\.png/);

  assert.doesNotMatch(publicSource, /澄场|CHENGCHANG|陆予安|周澄|林岚|毛之谦|总教头|特约嘉宾/);
  assert.doesNotMatch(pageSource, /上海市徐汇区|社交媒体|小红书|微信视频号/);
  assert.doesNotMatch(pageSource, /城市球会邀请赛|年度新锐运动空间|公开赛混合双打|优秀组织/);
  assert.doesNotMatch(pageSource, /演示资料|首版演示|不代表真实营业信息/);
});

test("the public site transcribes Liu Qirui's supplied honors exactly", () => {
  const honors = [
    ["2025", "PPA 杭州站 19+ 男子单打 3.5+ 亚军"],
    ["2025", "CPC600 兰威杯男子单打冠军"],
    ["2026", "WPC 海南站 4.0 男双冠军"],
    ["2026", "WPC 海南站 3.5 混双冠军"],
    ["2026", "CPC600 鹤壁浚县站男双冠军"],
    ["2026", "CPC600 河北石家庄站混双冠军"],
    ["2026", "APBA 全球总决赛男单季军"],
    ["2026", "李宁杯中国匹克球巡回赛呼和浩特站（CPC-1000）公开组男子单打第一名"],
  ];

  let cursor = pageSource.indexOf("const honors = [");
  for (const [year, title] of honors) {
    const yearField = `year: "${year}",`;
    const titleField = `title: "${title}",`;
    const start = pageSource.indexOf(yearField, cursor);
    const end = pageSource.indexOf(titleField, start);
    const boundary = pageSource.indexOf("  },", start);
    assert.ok(
      start >= 0 && end > start && end < boundary,
      `missing supplied honor: ${year} ${title}`,
    );
    cursor = boundary + 4;
  }
  assert.doesNotMatch(pageSource, /荣誉留待书写|honor-list-empty|暂为空|codex-clipboard|微信截图/);
});

test("the coach section gives the two professional coaches a featured, gallery-ready layout", () => {
  assert.match(pageSource, /const featuredCoaches = \[/);
  assert.match(pageSource, /const supportCoaches = \[/);
  assert.match(pageSource, /className="coach-feature-grid"/);
  assert.match(pageSource, /className="coach-support-grid"/);
  assert.match(pageSource, /className="coach-gallery"/);
  assert.match(pageSource, /aria-label="教练赛场与荣誉照片画廊"/);
  assert.match(pageSource, /data-coach-media-slot=/);
  assert.match(globalStyles, /\.coach-feature-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(globalStyles, /\.coach-support-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(globalStyles, /@media\s*\(max-width:\s*760px\)[\s\S]*\.coach-feature-grid[\s\S]*grid-template-columns:\s*1fr/s);
});

test("coach media captions keep the supplied events and results correctly separated", () => {
  for (const asset of [
    "coaches/coach-liu-qirui.jpg",
    "coaches/coach-tang-yutong.jpg",
    "coaches/coaches-doubles-match.jpg",
    "coaches/liu-hohhot-cpc1000-podium.jpg",
    "coaches/liu-kaihua-cpc1000-singles-second.jpg",
    "coaches/liu-tang-hohhot-cpc1000-mixed-second.jpg",
  ]) {
    assert.match(pageSource, new RegExp(asset.replaceAll(".", "\\.")));
  }
  assert.match(pageSource, /浙江开化站公开组第二名/);
  assert.match(pageSource, /呼和浩特站公开混合双打第二名/);
  assert.match(pageSource, /CPC-1000 冠军领奖台/);
  assert.doesNotMatch(pageSource, /浙江桐乡站|呼和浩特站公开混合双打第一名/);
});

test("the first usable release does not collect email or promise email delivery", () => {
  assert.doesNotMatch(bookingFormSource, /name="email"|booking-email|电子邮箱/);
  assert.match(bookingFormSource, /我同意睿安成使用以上信息处理预约并与我联系。/);
  assert.match(bookingFormSource, /（选填）我同意首页公开姓名首字加 \*\*、预约时段、人数和散客\/包场性质/);
  assert.match(bookingFormSource, /不公开手机号、邮箱、预约号或备注/);
  assert.match(bookingFormSource, /不勾选也可预约，首页将匿名显示/);
  assert.doesNotMatch(bookingFormSource, /处理预约并与我联系；首页/);
});
