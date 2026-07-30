# 澄场兼容版与真实预约 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 GitHub Pages 网站改为旧 Android WebView 也能读取和提交的静态兼容版本，并通过 Formspree 保存预约意向及发送邮件提醒。

**Architecture:** Next.js 继续作为唯一内容维护入口，并输出完整静态 HTML/CSS；GitHub Pages 发布步骤移除 Next/React 客户端运行脚本，只保留一个 ES5 风格的预约增强脚本。预约使用原生 HTML 表单提交到 Formspree，JavaScript 可用时原地显示结果，不可用时由浏览器直接提交。

**Tech Stack:** Next.js 16、React 19 服务端组件、TypeScript、CSS、原生 HTML 表单、ES5 风格 JavaScript、Formspree、GitHub Pages、ChatGPT Sites、Node.js 内置测试运行器

## Global Constraints

- 保留公开网址 `https://lingko-ljx.github.io/chengchang-pickle-club/`。
- 保留现有中文内容、暖白/墨黑/低饱和绿色视觉和响应式阅读顺序。
- 核心正文、导航和预约表单不得依赖 React hydration 才能显示或提交。
- 预约只收集意向；提交成功文案必须说明“等待人工确认”，不得声称已经锁定场次。
- 字段固定为 `preferred_date`、`preferred_time`、`party_size`、`name`、`phone`、`privacy_consent`、`status` 和 `source`。
- `status` 固定提交 `pending`；`source` 固定提交 `chengchang-public-site`。
- 收件邮箱、后台账号和管理密钥不得写入仓库；Formspree 表单 endpoint 可通过构建变量公开注入。
- 不实现余位库存、自动确认、取消、改期、付款、登录、会员或公开管理后台。
- 没有独立域名不阻塞本计划；域名级屏蔽 `github.io` 不属于代码能够绕过的范围。
- 保留 `.openai/hosting.json` 及现有 Sites 项目，GitHub Pages 作为主要公开入口。

---

## File Structure

- `app/BookingForm.tsx`：只负责输出可独立工作的原生预约表单和状态区域。
- `app/booking-config.ts`：校验构建时 Formspree endpoint，并生成 GitHub Pages 兼容脚本路径。
- `public/booking-form.js`：可选的 ES5 风格原地提交增强，不承担基本表单能力。
- `scripts/prepare-pages-output.mjs`：清理 GitHub Pages HTML 中的 Next 客户端脚本和脚本预加载。
- `tests/booking-config.test.mjs`：验证 endpoint 和脚本路径契约。
- `tests/booking-enhancement-contract.test.mjs`：验证增强脚本不包含目标旧 WebView 无法解析的语法/API。
- `tests/css-compatibility.test.mjs`：验证关键 CSS fallback 存在。
- `tests/pages-static-export.test.mjs`：验证最终发布 HTML 完整、可提交且不加载 Next/React 客户端脚本。
- `tests/pages-workflow.test.mjs`：验证 GitHub Actions 注入预约 endpoint。

---

### Task 1: 用原生表单替换 React 预约演示

**Files:**
- Create: `app/BookingForm.tsx`
- Create: `app/booking-config.ts`
- Create: `tests/booking-config.test.mjs`
- Modify: `app/page.tsx`
- Modify: `tests/rendered-html.test.mjs`
- Delete: `app/BookingPanel.tsx`
- Delete: `app/booking-model.ts`
- Delete: `tests/booking-model.test.mjs`

**Interfaces:**
- Produces: `resolveBookingEndpoint(value?: string): string`
- Produces: `resolveBookingScriptSrc(basePath?: string): string`
- Produces: `BookingForm({ formEndpoint, scriptSrc }: BookingFormProps): JSX.Element`
- Consumed by: `app/page.tsx` and the GitHub Pages export in later tasks.

- [ ] **Step 1: Write endpoint contract tests**

Create `tests/booking-config.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBookingEndpoint,
  resolveBookingScriptSrc,
} from "../app/booking-config.ts";

test("accepts only a Formspree HTTPS form endpoint", () => {
  assert.equal(
    resolveBookingEndpoint("https://formspree.io/f/testcontract"),
    "https://formspree.io/f/testcontract",
  );
  assert.equal(resolveBookingEndpoint("http://formspree.io/f/testcontract"), "");
  assert.equal(resolveBookingEndpoint("https://example.com/f/testcontract"), "");
  assert.equal(resolveBookingEndpoint(""), "");
});

test("builds the booking enhancement path for project pages", () => {
  assert.equal(resolveBookingScriptSrc(), "/booking-form.js");
  assert.equal(
    resolveBookingScriptSrc("/chengchang-pickle-club"),
    "/chengchang-pickle-club/booking-form.js",
  );
});
```

- [ ] **Step 2: Extend the rendered-page test with the native form contract**

Add these assertions after reading `html` in `tests/rendered-html.test.mjs`:

```js
assert.match(html, /<form[^>]+id="booking-form"[^>]+method="post"/i);
assert.match(html, /name="preferred_date"/);
assert.match(html, /name="preferred_time"/);
assert.match(html, /name="party_size"/);
assert.match(html, /name="name"/);
assert.match(html, /name="phone"/);
assert.match(html, /name="privacy_consent"/);
assert.match(html, /name="status"[^>]+value="pending"/);
assert.match(
  html,
  /name="source"[^>]+value="chengchang-public-site"/,
);
assert.match(html, /预约意向提交后仍需人工确认/);
assert.doesNotMatch(html, /当前为演示预约|信息没有被保存或发送/);
```

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```powershell
node --test tests/booking-config.test.mjs
```

Expected: FAIL because `app/booking-config.ts` does not exist.

Run:

```powershell
npm run build
node --test tests/rendered-html.test.mjs
```

Expected: FAIL because the current React form does not emit the new field names or truthful confirmation copy.

- [ ] **Step 4: Implement the endpoint helpers**

Create `app/booking-config.ts`:

```ts
const formspreeEndpointPattern =
  /^https:\/\/formspree\.io\/f\/[A-Za-z0-9_-]+$/;

export function resolveBookingEndpoint(value?: string): string {
  const endpoint = value?.trim() ?? "";
  return formspreeEndpointPattern.test(endpoint) ? endpoint : "";
}

export function resolveBookingScriptSrc(basePath = ""): string {
  const normalizedBasePath =
    basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  return `${normalizedBasePath}/booking-form.js`;
}
```

- [ ] **Step 5: Implement the static BookingForm component**

Create `app/BookingForm.tsx` with this public interface and form structure:

```tsx
type BookingFormProps = {
  formEndpoint: string;
  scriptSrc: string;
};

const times = ["10:00", "14:00", "16:30", "19:00", "20:30"];
const partySizes = [1, 2, 3, 4, 5, 6, 7, 8];

export function BookingForm({
  formEndpoint,
  scriptSrc,
}: BookingFormProps) {
  const configured = Boolean(formEndpoint);

  return (
    <div className="booking-layout">
      <div className="booking-copy">
        <p className="booking-overline">FIRST SESSION</p>
        <h2>
          选择一个时间，
          <br />
          <span>来打一场刚刚好的球。</span>
        </h2>
        <p>
          首次体验包含 90 分钟场地、基础装备和 20 分钟入门指导。
          无需自带球拍，也不需要任何运动基础。
        </p>
        <div className="booking-facts">
          <div>
            <span>90</span>
            <p>分钟完整体验</p>
          </div>
          <div>
            <span>1—8</span>
            <p>位参与者均可提交意向</p>
          </div>
        </div>
      </div>

      <div>
        <form
          acceptCharset="UTF-8"
          action={formEndpoint || undefined}
          className="booking-form"
          id="booking-form"
          method="post"
        >
          <input name="status" type="hidden" value="pending" />
          <input
            name="source"
            type="hidden"
            value="chengchang-public-site"
          />
          <label className="honeypot-field" aria-hidden="true">
            请勿填写
            <input autoComplete="off" name="_gotcha" tabIndex={-1} />
          </label>

          <div className="form-group">
            <label htmlFor="preferred-date">期望日期</label>
            <input
              id="preferred-date"
              name="preferred_date"
              required
              type="date"
            />
          </div>

          <div className="form-group">
            <label htmlFor="preferred-time">期望时段</label>
            <select id="preferred-time" name="preferred_time" required>
              <option value="">请选择时段</option>
              {times.map((time) => (
                <option key={time} value={time}>
                  {time}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group input-grid">
            <label htmlFor="booking-name">您的称呼</label>
            <input
              autoComplete="name"
              id="booking-name"
              name="name"
              required
              type="text"
            />
            <label htmlFor="booking-phone">联系电话</label>
            <input
              autoComplete="tel"
              id="booking-phone"
              inputMode="tel"
              name="phone"
              pattern="[0-9+() -]{7,20}"
              required
              type="tel"
            />
            <label htmlFor="party-size">参与人数</label>
            <select id="party-size" name="party_size" required>
              {partySizes.map((size) => (
                <option key={size} value={size}>
                  {size} 位
                </option>
              ))}
            </select>
          </div>

          <label className="privacy-consent">
            <input name="privacy_consent" required type="checkbox" value="yes" />
            <span>我同意澄场仅使用以上信息与我联系确认本次预约。</span>
          </label>

          <p className="booking-disclaimer">
            预约意向提交后仍需人工确认，提交成功不代表场次已锁定。
          </p>
          <p id="booking-error" className="field-error" hidden role="alert" />
          <div
            id="booking-success"
            className="booking-success-message"
            hidden
            role="status"
          >
            已收到预约意向，我们会尽快电话联系你确认。
          </div>
          <button
            className="primary-button"
            disabled={!configured}
            type="submit"
          >
            提交预约意向
            <span aria-hidden="true">↗</span>
          </button>
          {!configured ? (
            <p className="field-error" role="alert">
              预约通道正在配置，请稍后再试。
            </p>
          ) : null}
        </form>
        <script data-booking-enhancement defer src={scriptSrc} />
      </div>
    </div>
  );
}
```

Keep the existing visual class names where they already express the intended layout; add only the new form-specific classes shown above.

- [ ] **Step 6: Wire the server component into the page**

Replace the `BookingPanel` import and usage in `app/page.tsx`:

```tsx
import { BookingForm } from "./BookingForm";
import {
  resolveBookingEndpoint,
  resolveBookingScriptSrc,
} from "./booking-config";

const formEndpoint = resolveBookingEndpoint(
  process.env.NEXT_PUBLIC_FORMSPREE_ENDPOINT,
);
const bookingScriptSrc = resolveBookingScriptSrc(
  process.env.PAGES_BASE_PATH,
);
```

Render:

```tsx
<BookingForm
  formEndpoint={formEndpoint}
  scriptSrc={bookingScriptSrc}
/>
```

Delete `app/BookingPanel.tsx`, `app/booking-model.ts`, and `tests/booking-model.test.mjs` after no imports remain.

- [ ] **Step 7: Run tests and verify pass**

Run:

```powershell
node --test tests/booking-config.test.mjs
npm run build
node --test tests/rendered-html.test.mjs
```

Expected: all focused tests PASS. The Sites build may render a disabled form when no endpoint is configured; the GitHub Pages production contract will reject that state in Task 4.

- [ ] **Step 8: Commit**

```powershell
git add app tests
git commit -m "feat: replace booking demo with native form"
```

---

### Task 2: Add optional ES5-style booking enhancement

**Files:**
- Create: `public/booking-form.js`
- Create: `tests/booking-enhancement-contract.test.mjs`
- Modify: `app/BookingForm.tsx`

**Interfaces:**
- Consumes: DOM ids `booking-form`, `booking-error`, and `booking-success`.
- Produces: progressive enhancement that sends FormData with XMLHttpRequest and never blocks native submission when required APIs are absent.

- [ ] **Step 1: Write the compatibility contract test**

Create `tests/booking-enhancement-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("booking enhancement stays parseable by old Android WebView", async () => {
  const source = await readFile(
    new URL("../public/booking-form.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /\b(?:const|let|class|async)\b/);
  assert.doesNotMatch(source, /=>|\?\.|\?\?|`/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bPromise\b/);
  assert.doesNotMatch(source, /Object\.hasOwn|\.at\s*\(/);
  assert.match(source, /new XMLHttpRequest\(\)/);
  assert.match(source, /new FormData\(form\)/);
  assert.match(source, /Accept", "application\/json"/);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```powershell
node --test tests/booking-enhancement-contract.test.mjs
```

Expected: FAIL because `public/booking-form.js` does not exist.

- [ ] **Step 3: Implement the enhancement**

Create `public/booking-form.js`:

```js
(function () {
  var form = document.getElementById("booking-form");
  var errorBox = document.getElementById("booking-error");
  var successBox = document.getElementById("booking-success");

  if (!form || !window.XMLHttpRequest || !window.FormData) {
    return;
  }

  var submitButton = form.querySelector('button[type="submit"]');

  function finishRequest() {
    if (submitButton) {
      submitButton.disabled = false;
    }
  }

  function showError(message) {
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    if (successBox) {
      successBox.hidden = true;
    }
  }

  form.addEventListener("submit", function (event) {
    if (form.checkValidity && !form.checkValidity()) {
      return;
    }

    event.preventDefault();

    if (submitButton) {
      submitButton.disabled = true;
    }
    if (errorBox) {
      errorBox.hidden = true;
    }

    var request = new XMLHttpRequest();
    request.open("POST", form.action, true);
    request.setRequestHeader("Accept", "application/json");

    request.onreadystatechange = function () {
      if (request.readyState !== 4) {
        return;
      }

      finishRequest();

      if (request.status >= 200 && request.status < 300) {
        form.reset();
        if (successBox) {
          successBox.hidden = false;
          successBox.focus();
        }
        return;
      }

      if (request.status === 429) {
        showError("提交较频繁，请稍后再试或电话联系我们。");
        return;
      }

      showError("提交未成功，请检查网络后重试或电话联系我们。");
    };

    request.onerror = function () {
      finishRequest();
      showError("网络连接失败，表单内容已保留，请稍后重试。");
    };

    request.send(new FormData(form));
  });
})();
```

In `app/BookingForm.tsx`, add `tabIndex={-1}` to `booking-success` so `.focus()` creates an announced, visible success state without entering normal keyboard order.

- [ ] **Step 4: Run the contract test**

Run:

```powershell
node --test tests/booking-enhancement-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add public/booking-form.js app/BookingForm.tsx tests/booking-enhancement-contract.test.mjs
git commit -m "feat: progressively enhance booking submission"
```

---

### Task 3: Add CSS fallbacks without changing the modern visual

**Files:**
- Create: `tests/css-compatibility.test.mjs`
- Modify: `app/globals.css`

**Interfaces:**
- Produces: fixed-value fallbacks before `clamp()`, physical-position fallbacks for logical properties, and explicit aspect-ratio/gap fallbacks.
- Consumed by: both Sites and GitHub Pages builds.

- [ ] **Step 1: Write the CSS fallback test**

Create `tests/css-compatibility.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("critical modern CSS has an old-browser fallback", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  const clampCount = [...css.matchAll(/font-size:\s*clamp\(/g)].length;
  const pairedFallbackCount = [
    ...css.matchAll(
      /font-size:\s*[^;\n]+;\s*\n\s*font-size:\s*clamp\(/g,
    ),
  ].length;

  assert.equal(pairedFallbackCount, clampCount);
  assert.match(css, /@supports not \(aspect-ratio: 1 \/ 1\)/);
  assert.match(css, /\.venue-board\s*\{[^}]*padding-bottom:/s);
  assert.match(css, /\.coach-portrait\s*\{[^}]*padding-bottom:/s);
  assert.match(css, /@supports not \(gap: 1rem\)/);
  assert.match(css, /margin-left:\s*auto;[\s\S]*margin-inline:\s*auto;/);
  assert.match(css, /padding-left:[^;]+;[\s\S]*padding-inline:/);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```powershell
node --test tests/css-compatibility.test.mjs
```

Expected: FAIL because the existing stylesheet has unpaired `clamp()` declarations and no aspect-ratio/gap fallback blocks.

- [ ] **Step 3: Add fallback values next to modern declarations**

For every existing declaration shaped like:

```css
font-size: clamp(42px, 4.4vw, 67px);
```

place a fixed or viewport-based value immediately before it:

```css
font-size: 52px;
font-size: clamp(42px, 4.4vw, 67px);
```

Use each declaration’s minimum-to-middle visual size rather than one global value. Add physical properties before logical properties, for example:

```css
.section-shell {
  margin-left: auto;
  margin-right: auto;
  margin-inline: auto;
}

.booking-success {
  padding-left: 20px;
  padding-right: 20px;
  padding-inline: 20px;
}
```

For rules using `inset: 0`, add:

```css
bottom: 0;
left: 0;
right: 0;
top: 0;
inset: 0;
```

- [ ] **Step 4: Add explicit aspect-ratio and gap fallback blocks**

Append before the reduced-motion block:

```css
@supports not (aspect-ratio: 1 / 1) {
  .venue-board {
    height: 0;
    padding-bottom: 74%;
  }

  .coach-portrait {
    height: 0;
    padding-bottom: 122%;
  }
}

@supports not (gap: 1rem) {
  .booking-layout > * + *,
  .contact-layout > * + *,
  .honors-layout > * + * {
    margin-top: 42px;
  }

  .input-grid > * + * {
    margin-top: 16px;
  }
}
```

Add styles for the new native controls, honeypot, consent, error, and success states while reusing the existing palette:

```css
.honeypot-field {
  height: 1px;
  left: -10000px;
  overflow: hidden;
  position: absolute;
  top: auto;
  width: 1px;
}

.privacy-consent {
  align-items: flex-start;
  display: flex;
  font-size: 11px;
  gap: 10px;
  line-height: 1.6;
  margin-top: 24px;
}

.booking-disclaimer {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.6;
}

.booking-success-message {
  background: rgba(169, 207, 69, 0.2);
  border: 1px solid var(--lime);
  margin: 20px 0;
  padding: 14px 16px;
}
```

- [ ] **Step 5: Run the CSS and page tests**

Run:

```powershell
node --test tests/css-compatibility.test.mjs
npm run build
node --test tests/rendered-html.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add app/globals.css tests/css-compatibility.test.mjs
git commit -m "fix: add legacy browser CSS fallbacks"
```

---

### Task 4: Produce a script-light GitHub Pages artifact

**Files:**
- Create: `scripts/prepare-pages-output.mjs`
- Modify: `tests/pages-static-export.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `out/**/*.html` with only the `data-booking-enhancement` script retained.
- Consumes: `NEXT_PUBLIC_FORMSPREE_ENDPOINT` and the existing Next static export.

- [ ] **Step 1: Strengthen the final artifact test**

Replace `tests/pages-static-export.test.mjs` with:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("exports a script-light GitHub Pages homepage", async () => {
  const html = await readFile(
    new URL("../out/index.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /澄场 PICKLE CLUB/);
  assert.match(html, /\/chengchang-pickle-club\/_next\//);
  assert.doesNotMatch(html, /(?:href|src)="\/_next\//);
  assert.match(
    html,
    /action="https:\/\/formspree\.io\/f\/testcontract"/,
  );
  assert.match(html, /name="privacy_consent"/);
  assert.match(
    html,
    /src="\/chengchang-pickle-club\/booking-form\.js"/,
  );
  assert.doesNotMatch(html, /_next\/static\/chunks\/[^"]+\.js/);
  assert.doesNotMatch(html, /self\.__next|__next_f|modulepreload/);

  const scriptTags = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
  assert.equal(scriptTags.length, 1);
  assert.match(scriptTags[0], /data-booking-enhancement/);
});
```

- [ ] **Step 2: Run a plain Pages build and verify failure**

Run:

```powershell
$env:GITHUB_PAGES="true"
$env:PAGES_BASE_PATH="/chengchang-pickle-club"
$env:NEXT_PUBLIC_SITE_URL="https://lingko-ljx.github.io/chengchang-pickle-club/"
$env:NEXT_PUBLIC_FORMSPREE_ENDPOINT="https://formspree.io/f/testcontract"
npm run build:pages
node --test tests/pages-static-export.test.mjs
```

Expected: FAIL because the Next export still contains framework scripts.

- [ ] **Step 3: Implement the HTML sanitizer**

Create `scripts/prepare-pages-output.mjs`:

```js
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve("out");

async function collectHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectHtmlFiles(target);
      return entry.isFile() && entry.name.endsWith(".html") ? [target] : [];
    }),
  );
  return nested.flat();
}

function removeClientRuntime(html) {
  const withoutScripts = html.replace(
    /<script\b([^>]*)>[\s\S]*?<\/script>/gi,
    (tag, attributes) =>
      /\bdata-booking-enhancement\b/i.test(attributes) ? tag : "",
  );

  return withoutScripts.replace(/<link\b[^>]*>/gi, (tag) => {
    const isModulePreload = /\brel=["']modulepreload["']/i.test(tag);
    const isScriptPreload =
      /\brel=["']preload["']/i.test(tag) &&
      /\bas=["']script["']/i.test(tag);
    return isModulePreload || isScriptPreload ? "" : tag;
  });
}

const htmlFiles = await collectHtmlFiles(outputDirectory);

for (const file of htmlFiles) {
  const html = await readFile(file, "utf8");
  await writeFile(file, removeClientRuntime(html), "utf8");
}

const homepage = await readFile(path.join(outputDirectory, "index.html"), "utf8");
if (
  !/action="https:\/\/formspree\.io\/f\/[A-Za-z0-9_-]+"/.test(homepage)
) {
  throw new Error(
    "NEXT_PUBLIC_FORMSPREE_ENDPOINT must be a valid Formspree endpoint",
  );
}
```

- [ ] **Step 4: Make Pages builds sanitize output**

Change `package.json`:

```json
"build:pages": "next build && node scripts/prepare-pages-output.mjs",
"test": "npm run build && node --test tests/booking-config.test.mjs tests/booking-enhancement-contract.test.mjs tests/css-compatibility.test.mjs tests/rendered-html.test.mjs",
"test:pages": "node --test tests/pages-static-export.test.mjs"
```

- [ ] **Step 5: Rebuild and verify the final artifact**

Run:

```powershell
npm run build:pages
node --test tests/pages-static-export.test.mjs
node --test tests/booking-enhancement-contract.test.mjs
```

Expected: PASS. `out/index.html` contains one custom script and no Next/React runtime scripts.

- [ ] **Step 6: Commit**

```powershell
git add scripts/prepare-pages-output.mjs tests/pages-static-export.test.mjs package.json
git commit -m "build: publish script-light pages output"
```

---

### Task 5: Connect Formspree and the GitHub deployment workflow

**Files:**
- Create: `tests/pages-workflow.test.mjs`
- Modify: `.github/workflows/pages.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: GitHub Actions variable `FORMSPREE_ENDPOINT`.
- Produces: build-time environment variable `NEXT_PUBLIC_FORMSPREE_ENDPOINT`.
- External output: a verified Formspree form that stores submissions and emails the user-provided recipient.

- [ ] **Step 1: Write the workflow contract test**

Create `tests/pages-workflow.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Pages build receives the public Formspree endpoint", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    workflow,
    /NEXT_PUBLIC_FORMSPREE_ENDPOINT:\s*\$\{\{\s*vars\.FORMSPREE_ENDPOINT\s*\}\}/,
  );
  assert.match(workflow, /run:\s*npm run test:pages/);
});
```

- [ ] **Step 2: Run the workflow test and verify failure**

Run:

```powershell
node --test tests/pages-workflow.test.mjs
```

Expected: FAIL because the workflow does not inject `FORMSPREE_ENDPOINT`.

- [ ] **Step 3: Add the repository variable to the build environment**

In `.github/workflows/pages.yml`, extend the existing “Build static site” environment:

```yaml
env:
  GITHUB_PAGES: "true"
  PAGES_BASE_PATH: /${{ github.event.repository.name }}
  NEXT_PUBLIC_SITE_URL: https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}/
  NEXT_PUBLIC_FORMSPREE_ENDPOINT: ${{ vars.FORMSPREE_ENDPOINT }}
```

Add this step immediately after “Build static site”:

```yaml
- name: Verify static site
  run: npm run test:pages
```

The `resolveBookingEndpoint()` helper returns an empty action for a missing or malformed value, `prepare-pages-output.mjs` fails the build, and the workflow test provides a second gate before deployment.

Also extend the explicit `test` script in `package.json` so the new workflow contract runs in normal source verification:

```json
"test": "npm run build && node --test tests/booking-config.test.mjs tests/booking-enhancement-contract.test.mjs tests/css-compatibility.test.mjs tests/pages-workflow.test.mjs tests/rendered-html.test.mjs"
```

- [ ] **Step 4: Document the operational setup**

Add a “真实预约配置” section to `README.md` stating:

```markdown
## 真实预约配置

生产构建需要 `NEXT_PUBLIC_FORMSPREE_ENDPOINT`，其值必须匹配
`^https://formspree\.io/f/[A-Za-z0-9_-]+$`。GitHub Pages 通过
仓库变量 `FORMSPREE_ENDPOINT` 注入该值。

Formspree 目标邮箱和后台登录信息只在 Formspree 中管理，不写入仓库。
当前预约是待人工确认的意向收集，不管理实时余位。免费方案当前提供
每月 50 次提交和 30 天提交历史；正式长期运营前应根据业务量决定升级
或迁移。
```

- [ ] **Step 5: Run the workflow and full source tests**

Run:

```powershell
node --test tests/pages-workflow.test.mjs
npm test
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Create and secure the Formspree form**

Using the user’s chosen receiving email:

1. Open Formspree’s official form creation page.
2. Let the user complete account sign-in and email verification if requested.
3. Create a form named `澄场预约`.
4. Keep the default email notification action enabled.
5. Set “Restrict to Domain” to `lingko-ljx.github.io`.
6. Copy the exact endpoint returned by Formspree.
7. Do not store the account password, email verification link, or management API key in files or chat output.

Expected: the dashboard shows one active form whose endpoint passes the `resolveBookingEndpoint()` contract.

- [ ] **Step 7: Configure the GitHub repository variable**

In repository `Lingko-ljx/chengchang-pickle-club`:

1. Open **Settings → Secrets and variables → Actions → Variables**.
2. Create or update `FORMSPREE_ENDPOINT`.
3. Set its value to the exact public endpoint returned in Step 6.

Expected: the workflow can read `vars.FORMSPREE_ENDPOINT`; no recipient email credentials are added to GitHub.

- [ ] **Step 8: Commit source changes**

```powershell
git add .github/workflows/pages.yml tests/pages-workflow.test.mjs README.md
git commit -m "ci: configure production booking endpoint"
```

---

### Task 6: Validate, publish, and verify the real booking flow

**Files:**
- Verify: `.openai/hosting.json`
- Verify: `out/index.html`
- Verify: `dist/server/index.js`
- Verify: all source and test files from Tasks 1–5

**Interfaces:**
- Produces: updated Sites version and updated public GitHub Pages deployment.
- Consumes: verified Formspree endpoint and existing Sites `project_id`.

- [ ] **Step 1: Run the full local verification with the real endpoint**

Set `NEXT_PUBLIC_FORMSPREE_ENDPOINT` to the exact Formspree endpoint obtained in Task 5, then run:

```powershell
npm test
npm run lint
$env:GITHUB_PAGES="true"
$env:PAGES_BASE_PATH="/chengchang-pickle-club"
$env:NEXT_PUBLIC_SITE_URL="https://lingko-ljx.github.io/chengchang-pickle-club/"
npm run build:pages
npm run test:pages
Remove-Item Env:GITHUB_PAGES
Remove-Item Env:PAGES_BASE_PATH
Remove-Item Env:NEXT_PUBLIC_SITE_URL
npm run build
```

Expected:

- all Node tests PASS;
- lint exits 0;
- `out/index.html` contains the real Formspree action and only the booking enhancement script;
- `dist/server/index.js` exists for Sites packaging.

- [ ] **Step 2: Run browser compatibility QA**

Serve `out/` locally over HTTP and verify:

1. Desktop width: homepage, anchors, native form controls, consent, error and success layout.
2. 390×844 mobile width: no horizontal overflow and submit button remains reachable.
3. JavaScript enabled: a synthetic test submission succeeds inline.
4. JavaScript blocked: the form still uses native POST behavior.
5. Android-style viewport: initial content appears before any script executes.

Use only synthetic data:

- name: `兼容性测试`
- phone: `13800000000`
- party size: `2`
- a future date
- time: `19:00`

Delete the synthetic record from Formspree after confirming the notification email arrives.

- [ ] **Step 3: Publish the validated source to Sites**

Reuse `.openai/hosting.json` and the existing Sites project. Package the exact successful `dist/` build, save one version, deploy it to the existing access level, and wait for deployment status `succeeded`.

Expected: Sites returns a successful deployment and the existing project remains intact. This is a secondary deployment; GitHub Pages remains the user-facing public URL.

- [ ] **Step 4: Push the implementation to GitHub main**

Fetch the remote state and verify the update is a fast-forward:

```powershell
git fetch github main
git merge-base --is-ancestor github/main HEAD
```

Expected: exit code 0.

Push:

```powershell
git push github HEAD:main
```

Expected: push succeeds and triggers `Deploy GitHub Pages`.

- [ ] **Step 5: Wait for GitHub Pages deployment**

Check the latest `Deploy GitHub Pages` workflow until it completes.

Expected: build and deploy jobs both succeed; the environment URL is:

```text
https://lingko-ljx.github.io/chengchang-pickle-club/
```

- [ ] **Step 6: Verify the production site anonymously**

Verify without GitHub authentication:

- homepage returns HTTP 200;
- HTML contains the real Formspree action;
- CSS and `booking-form.js` return HTTP 200;
- no Next JavaScript chunk is referenced from HTML;
- mobile viewport displays the full page;
- one final synthetic booking reaches the Formspree dashboard and notification inbox.

Delete the synthetic record after verification.

- [ ] **Step 7: Final repository check**

Run:

```powershell
git status --short --branch
git log -8 --oneline --decorate
```

Expected: working tree is clean and all compatibility/booking commits are present on the pushed branch.
