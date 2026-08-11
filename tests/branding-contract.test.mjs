import assert from "node:assert/strict";
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

test("the public site uses the approved Ruiancheng identity and contact details", () => {
  const publicSource = `${pageSource}\n${bookingFormSource}\n${layoutSource}`;

  assert.match(publicSource, /睿安成/);
  assert.match(publicSource, /刘栖睿/);
  assert.match(publicSource, /毛之谦/);
  assert.match(publicSource, /江西省南昌市青山湖区青山湖南大道260号14号楼/);
  assert.match(publicSource, /13807917663/);
  assert.match(pageSource, /ruiancheng-court-hero\.png/);

  assert.doesNotMatch(publicSource, /澄场|CHENGCHANG|陆予安|周澄|林岚/);
  assert.doesNotMatch(pageSource, /上海市徐汇区|社交媒体|小红书|微信视频号/);
  assert.doesNotMatch(pageSource, /城市球会邀请赛|年度新锐运动空间|公开赛混合双打|优秀组织/);
  assert.doesNotMatch(pageSource, /演示资料|首版演示|不代表真实营业信息/);
});

test("the first usable release does not collect email or promise email delivery", () => {
  assert.doesNotMatch(bookingFormSource, /name="email"|booking-email|电子邮箱/);
  assert.match(bookingFormSource, /睿安成仅使用以上信息处理预约并与我联系/);
});
