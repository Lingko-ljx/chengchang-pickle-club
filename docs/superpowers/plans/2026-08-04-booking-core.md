# 澄场预约核心系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有公开网站中交付不依赖微信和在线支付的真实预约闭环，支持 11 片场地、包场独占、散客自动补位、工作人员管理和用户状态查询。

**Architecture:** 公开介绍页继续由 Next.js 静态导出，并只保留明确白名单中的轻量客户端脚本；预约领域规则放在纯 TypeScript 模块中，由 CloudBase 公共 API、受保护管理 API 和本地测试共同复用。CloudBase 文档数据库通过确定性库存文档和服务端事务防止超卖，管理后台使用 CloudBase Auth，邮件通过事务后 Outbox 异步发送。

**Tech Stack:** Node.js `>=22.13.0`、TypeScript 5.9、Next.js 16、React 19 服务端组件、ES5 公开增强脚本、CloudBase Node SDK、CloudBase JS SDK 2.x、CloudBase Node.js 20.19 云函数、腾讯云 SES、GitHub Pages、Node 内置测试运行器、Playwright

## Global Constraints

- 场地固定为 11 片，初始编号 `01`–`11`。
- 每个场次固定 60 分钟；开放时段由后台配置。
- 包场和散客单笔均为 1–4 人，每片场地同时最多 4 人。
- 包场只占完全空闲场地，并独占整片场地；已有散客的场地不能转为包场。
- 散客优先补入“已占人数最多且仍容得下整组”的场地；一组人员不得拆分。
- 散客不足 4 人也照常开场，不设置成团门槛。
- `pending`、`confirmed` 和改期提案都占库存；首版不自动过期。
- 新预约先进入 `pending`，工作人员确认后才是 `confirmed`。
- 用户无需注册；查询必须同时验证随机预约编号和预留手机号。
- 第一阶段不实现微信、企业微信、小程序、在线支付、会员或营销。
- 用户可选邮箱和工作人员邮箱只作备用通知，邮件失败不得回滚预约。
- 所有场次、取消截止和后台日期边界统一使用 `Asia/Shanghai`；数据库时间戳保存为 UTC ISO 字符串。
- 已完成或已取消预约的个人信息默认保留 180 天，之后自动脱敏；审计摘要不保留姓名、完整手机号、邮箱或备注，管理员可提前执行同一脱敏操作。
- 所有管理写操作携带记录版本；旧版本更新返回 `409 CONFLICT`，不得静默覆盖新状态。
- 公开正文、表单主体和错误提示不得依赖 React hydration 才能显示。
- 公开增强脚本必须能被 Acorn 以 ES5 解析；管理后台可要求现代浏览器。
- 现有 GitHub Pages 地址继续作为第一阶段预览入口。
- CloudBase 生产密钥、管理员密码、SES 凭据和通知邮箱不得写入仓库。
- CloudBase 事务内只允许数据库 `doc(id)` 读写；不得使用 `where()` 或执行外部调用。
- 不修改或提交现有未跟踪目录 `.superpowers/`。

---

## File Structure

### Shared booking domain

- `lib/booking/types.ts`：唯一的预约、库存、状态和 API 数据类型来源。
- `lib/booking/errors.ts`：稳定错误码和 `BookingError`。
- `lib/booking/validation.ts`：姓名、手机号、邮箱、日期、人数和模式校验。
- `lib/booking/allocation.ts`：包场和散客的纯分配算法。
- `lib/booking/state-machine.ts`：确认、改期、取消和完结状态迁移。
- `lib/booking/ports.ts`：事务仓储、时钟、ID、通知事件端口。
- `lib/booking/booking-service.ts`：创建、查询和生命周期用例。
- `lib/booking/testing/memory-repository.ts`：本地与测试用原子内存仓储。

### CloudBase backend

- `cloudbase/src/repositories/cloudbase-booking-repository.ts`：文档数据库事务适配。
- `cloudbase/src/http/request.ts`：HTTP event、表单与 JSON 解析。
- `cloudbase/src/http/response.ts`：CORS、JSON、重定向和错误响应。
- `cloudbase/src/http/rate-limit.ts`：哈希限流键和窗口计数。
- `cloudbase/src/auth/current-user.ts`：使用 Access Token 获取当前用户和角色。
- `cloudbase/src/public-api.ts`：公开预约、查询、取消和改期答复路由。
- `cloudbase/src/admin-api.ts`：工作人员查询、确认、改期、取消和设置路由。
- `cloudbase/src/mailer.ts`：Outbox 领取、腾讯云 SES 发送和重试。
- `cloudbase/functions/booking-public-api/package.json`：公共函数运行依赖。
- `cloudbase/functions/booking-admin-api/package.json`：管理函数运行依赖。
- `cloudbase/functions/booking-mailer/package.json`：邮件函数运行依赖。
- `scripts/build-cloudbase-functions.mjs`：把共享 TypeScript 打包成三个 CommonJS `index.js`。
- `scripts/render-cloudbase-config.mjs`：从环境变量生成不含秘密的部署配置。
- `scripts/provision-cloudbase.mjs`：创建集合、索引、11 片场地和初始 60 分钟场次模板。

### Public site and admin client

- `app/BookingForm.tsx`：服务端输出可降级的真实预约表单。
- `app/booking-config.ts`：校验 API 地址并生成 Pages 子路径资源 URL。
- `app/booking/result/page.tsx`：静态提交结果页。
- `app/booking/status/page.tsx`：静态预约查询和用户操作页。
- `app/admin/page.tsx`：静态工作人员后台壳。
- `admin-client/index.ts`：CloudBase 登录、API 调用和后台交互入口。
- `admin-client/api.ts`：管理 API 客户端。
- `admin-client/render.ts`：待办、场地矩阵、详情和设置渲染。
- `public/booking-form.js`：ES5 可用性与提交增强。
- `public/booking-result.js`：ES5 结果页增强。
- `public/booking-status.js`：ES5 查询、取消和改期答复增强。
- `public/admin-app.js`：由 esbuild 生成的管理后台 bundle，不手工编辑。
- `scripts/build-browser-clients.mjs`：只打包管理后台，公开脚本保持手写 ES5。
- `scripts/prepare-pages-output.mjs`：移除 Next runtime 并保留白名单客户端脚本。

### Tests and operations

- `tests/booking-allocation.test.mjs`
- `tests/booking-validation.test.mjs`
- `tests/booking-state-machine.test.mjs`
- `tests/booking-service.test.mjs`
- `tests/cloudbase-repository-contract.test.mjs`
- `tests/public-api-contract.test.mjs`
- `tests/admin-api-contract.test.mjs`
- `tests/mailer.test.mjs`
- `tests/booking-status-client.test.mjs`
- `tests/admin-client-contract.test.mjs`
- `tests/e2e/booking-flow.spec.ts`
- `scripts/preview-booking-stack.mjs`：同源托管 `out/` 和内存 API，供 Playwright 使用。

---

### Task 1: Freeze the booking contract and pure business rules

**Files:**
- Create: `lib/booking/types.ts`
- Create: `lib/booking/errors.ts`
- Create: `lib/booking/validation.ts`
- Create: `lib/booking/allocation.ts`
- Create: `lib/booking/state-machine.ts`
- Create: `tests/booking-validation.test.mjs`
- Create: `tests/booking-allocation.test.mjs`
- Create: `tests/booking-state-machine.test.mjs`
- Create: `scripts/run-unit-tests.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `validateCreateBooking(input): CreateBookingCommand`
- Produces: `chooseCourt(mode, partySize, allocations): CourtAllocation | null`
- Produces: `assertTransition(from, to): void`
- Consumed by: all later service, API and UI contract tasks.

- [ ] **Step 1: Add failing validation and allocation tests**

Create focused tests with these exact cases:

```js
test("rejects every booking outside one to four players", () => {
  assert.throws(() => validateCreateBooking(validInput({ partySize: 0 })), /INVALID_PARTY_SIZE/);
  assert.throws(() => validateCreateBooking(validInput({ partySize: 5 })), /INVALID_PARTY_SIZE/);
});

test("private booking chooses only an empty court", () => {
  assert.equal(chooseCourt("private", 4, [openCourt("01", 1), emptyCourt("02")]).courtId, "02");
});

test("open booking fills the fullest court that fits the whole group", () => {
  const chosen = chooseCourt("open", 2, [openCourt("01", 1), openCourt("02", 2), emptyCourt("03")]);
  assert.equal(chosen.courtId, "02");
});
```

- [ ] **Step 2: Run the tests and verify red state**

Run:

```powershell
node --test tests/booking-validation.test.mjs tests/booking-allocation.test.mjs tests/booking-state-machine.test.mjs
```

Expected: FAIL because `lib/booking/*` does not exist.

- [ ] **Step 3: Define the shared types and stable errors**

Use these public types in `lib/booking/types.ts`:

```ts
export type BookingMode = "private" | "open";
export type BookingStatus =
  | "pending"
  | "confirmed"
  | "reschedule_proposed"
  | "cancelled"
  | "completed";

export type AllocationMode = "empty" | BookingMode;

export interface CourtAllocation {
  id: string;
  sessionId: string;
  courtId: string;
  mode: AllocationMode;
  occupiedPlayers: number;
  bookingIds: string[];
  version: number;
}

export interface CreateBookingCommand {
  idempotencyKey: string;
  sessionId: string;
  mode: BookingMode;
  partySize: number;
  name: string;
  phone: string;
  email?: string;
  note?: string;
  privacyConsent: true;
}

export interface BookingRecord {
  id: string;
  code: string;
  idempotencyKeyHash?: string;
  sessionId: string;
  date: string;
  startAt: string;
  endAt: string;
  courtId: string;
  proposedSessionId?: string;
  proposedCourtId?: string;
  proposedStartAt?: string;
  proposedEndAt?: string;
  mode: BookingMode;
  partySize: number;
  status: BookingStatus;
  proposalPreviousStatus?: "pending" | "confirmed";
  name?: string;
  phone?: string;
  phoneHash?: string;
  email?: string;
  note?: string;
  privacyConsentAt: string;
  canCancelUntil: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  personalDataRedactedAt?: string;
  version: number;
}

export interface CourtRecord {
  id: string;
  enabled: boolean;
  version: number;
}

export interface SessionTemplateRecord {
  id: string;
  startTime: string;
  endTime: string;
  enabled: boolean;
  version: number;
}

export interface SessionRecord {
  id: string;
  date: string;
  templateId: string;
  startAt: string;
  endAt: string;
  status: "open" | "closed";
  enabledCourtIds: string[];
  version: number;
}

export interface AuditLog {
  id: string;
  bookingId: string;
  action: string;
  actorType: "customer" | "staff" | "system";
  actorId?: string;
  fromStatus?: BookingStatus;
  toStatus?: BookingStatus;
  at: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface NotificationEvent {
  id: string;
  bookingId: string;
  kind: string;
  recipientType: "customer" | "staff";
  status: "pending" | "sending" | "retry" | "sent" | "failed";
  attemptCount: number;
  nextAttemptAt: string;
  leaseUntil?: string;
  createdAt: string;
}

export interface AvailabilitySlot {
  sessionId: string;
  date: string;
  startTime: string;
  endTime: string;
  openCapacity: number;
  acceptsOpenPartySizes: Array<1 | 2 | 3 | 4>;
  privateCourtCount: number;
  acceptsOpen: boolean;
  acceptsPrivate: boolean;
}

export interface AdminBookingFilter {
  date?: string;
  status?: BookingStatus;
  mode?: BookingMode;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface AdminDashboard {
  date: string;
  pending: BookingRecord[];
  slots: AvailabilitySlot[];
  courts: CourtRecord[];
}

export interface BookingPage {
  items: BookingRecord[];
  nextCursor?: string;
}
```

Define `BookingError` with stable codes `INVALID_INPUT`, `INVALID_PARTY_SIZE`, `INVALID_TRANSITION`, `SESSION_NOT_FOUND`, `SESSION_FULL`, `SESSION_CLOSED`, `BOOKING_NOT_FOUND`, `AUTH_REQUIRED`, `FORBIDDEN`, `RATE_LIMITED`, and `CONFLICT`.

- [ ] **Step 4: Implement validation, allocation and transitions**

The allocation implementation must preserve whole groups:

```ts
export function chooseCourt(
  mode: BookingMode,
  partySize: number,
  allocations: readonly CourtAllocation[],
): CourtAllocation | null {
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 4) {
    throw new BookingError("INVALID_PARTY_SIZE");
  }

  if (mode === "private") {
    return allocations.find((item) => item.mode === "empty") ?? null;
  }

  const partial = allocations
    .filter((item) => item.mode === "open" && item.occupiedPlayers + partySize <= 4)
    .sort((a, b) => b.occupiedPlayers - a.occupiedPlayers || a.courtId.localeCompare(b.courtId));

  return partial[0] ?? allocations.find((item) => item.mode === "empty") ?? null;
}
```

Allowed state transitions are exactly:

```ts
const transitions: Record<BookingStatus, readonly BookingStatus[]> = {
  pending: ["confirmed", "reschedule_proposed", "cancelled"],
  confirmed: ["reschedule_proposed", "cancelled", "completed"],
  reschedule_proposed: ["confirmed", "pending", "cancelled"],
  cancelled: [],
  completed: [],
};
```

- [ ] **Step 5: Make all Node contract tests discoverable and run source checks**

Create `scripts/run-unit-tests.mjs` to enumerate top-level `tests/*.test.mjs`, sort them, exclude exactly `pages-static-export.test.mjs` because it requires a prior Pages build, and run the remaining files with `spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" })`. Change the package scripts to keep the build gate while automatically including every non-E2E contract test added later:

```json
{
  "test": "npm run build && npm run test:unit",
  "test:unit": "node scripts/run-unit-tests.mjs"
}
```

Then run:

```powershell
node --test tests/booking-validation.test.mjs tests/booking-allocation.test.mjs tests/booking-state-machine.test.mjs
npm run lint
```

Expected: all focused tests PASS and lint exits 0.

- [ ] **Step 6: Commit**

```powershell
git add lib/booking tests/booking-validation.test.mjs tests/booking-allocation.test.mjs tests/booking-state-machine.test.mjs scripts/run-unit-tests.mjs package.json
git commit -m "feat: define booking domain rules"
```

---

### Task 2: Implement the atomic booking service with an in-memory repository

**Files:**
- Create: `lib/booking/ports.ts`
- Create: `lib/booking/booking-service.ts`
- Create: `lib/booking/testing/memory-repository.ts`
- Create: `tests/booking-service.test.mjs`

**Interfaces:**
- Consumes: Task 1 domain types and rule functions.
- Produces: `BookingService.create`, `lookup`, `confirm`, `proposeReschedule`, `respondToReschedule`, `cancel`, `complete`, `reassign`, `redactPersonalData`, `listAvailability`, `listBookings`, `setCourtEnabled`, and `setSessionTemplateEnabled`.
- Produces: `BookingRepository.runTransaction(work)` implemented later by CloudBase.

- [ ] **Step 1: Write service tests for capacity, idempotency and lifecycle**

Add tests that prove:

```js
test("eleven private bookings fill eleven courts and the twelfth fails", async () => {
  for (let index = 0; index < 11; index += 1) {
    await service.create(command({ mode: "private", idempotencyKey: `private-${index}` }));
  }
  await assert.rejects(() => service.create(command({ mode: "private", idempotencyKey: "private-12" })), /SESSION_FULL/);
});

test("forty-four single open bookings fill all courts", async () => {
  await Promise.all(Array.from({ length: 44 }, (_, index) =>
    service.create(command({ mode: "open", partySize: 1, idempotencyKey: `open-${index}` }))
  ));
  await assert.rejects(() => service.create(command({ mode: "open", partySize: 1, idempotencyKey: "open-45" })), /SESSION_FULL/);
});

test("repeating an idempotency key returns the original booking", async () => {
  const first = await service.create(command({ idempotencyKey: "same-request" }));
  const second = await service.create(command({ idempotencyKey: "same-request" }));
  assert.equal(second.id, first.id);
});
```

Also cover cancellation inventory release, disabled courts, deterministic first-use session snapshots, retaining both old and proposed allocations during reschedule, accepting and rejecting proposals, and refusing user cancellation after session start. Cancellation and completion set `terminalAt` exactly once. Proposing a reschedule writes `proposalPreviousStatus`; acceptance releases the old allocation and clears all proposal fields; rejection releases the proposed allocation, restores exactly `proposalPreviousStatus`, and then clears all proposal fields.

- [ ] **Step 2: Run the service test and verify failure**

```powershell
node --test tests/booking-service.test.mjs
```

Expected: FAIL because the service and repository ports do not exist.

- [ ] **Step 3: Define transaction ports**

`lib/booking/ports.ts` must expose document-oriented operations rather than query-shaped operations:

```ts
export interface BookingTransaction {
  getBooking(id: string): Promise<BookingRecord | null>;
  getBookingIdByCodeHash(codeHash: string): Promise<string | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  getSessionTemplate(id: string): Promise<SessionTemplateRecord | null>;
  getCourts(courtIds: readonly string[]): Promise<CourtRecord[]>;
  getIdempotency(keyHash: string): Promise<string | null>;
  getAllocations(sessionId: string, courtIds: readonly string[]): Promise<CourtAllocation[]>;
  putSession(value: SessionRecord): Promise<void>;
  putAllocation(value: CourtAllocation): Promise<void>;
  putBooking(value: BookingRecord): Promise<void>;
  putBookingCode(codeHash: string, bookingId: string): Promise<void>;
  putIdempotency(keyHash: string, bookingId: string): Promise<void>;
  appendAudit(value: AuditLog): Promise<void>;
  enqueueNotification(value: NotificationEvent): Promise<void>;
}

export interface BookingRepository {
  runTransaction<T>(work: (transaction: BookingTransaction) => Promise<T>): Promise<T>;
  listAvailability(date: string): Promise<AvailabilitySlot[]>;
  listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]>;
  listExpiredPersonalData(cutoff: string, limit: number): Promise<BookingRecord[]>;
  redactBooking(bookingId: string, actorId: string): Promise<void>;
  setCourtEnabled(courtId: string, enabled: boolean, actorId: string): Promise<void>;
  setSessionTemplateEnabled(templateId: string, enabled: boolean, actorId: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdProvider {
  bookingId(): string;
  bookingCode(): string;
  eventId(): string;
}
```

The production `bookingCode()` uses at least 128 bits from `crypto.randomBytes`, encoded without ambiguous characters; tests inject deterministic IDs. Normalize codes to uppercase for lookup and never use sequential numbers.

Every created booking, allocation update, idempotency record, audit record and Outbox event must be written in the same transaction.
All lifecycle mutation commands include `expectedVersion`; the service compares it with the transactional booking record and throws `CONFLICT` before any write when they differ.

- [ ] **Step 4: Implement the service and deterministic identifiers**

Use IDs that can be known before entering a CloudBase transaction:

```ts
import { createHash } from "node:crypto";

export const courtIds = Array.from({ length: 11 }, (_, index) =>
  String(index + 1).padStart(2, "0"),
);

export function allocationId(sessionId: string, courtId: string): string {
  return `${sessionId}__court-${courtId}`;
}

export function bookingCodeId(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}
```

`BookingService.create()` must validate syntax before the transaction, generate booking/audit/outbox IDs, and parse the deterministic session ID into date plus template ID. Inside the transaction it reads the idempotency document and the deterministic `booking_codes/{sha256(normalizedCode)}` document; reads or creates the deterministic session snapshot from one template document; always re-reads the 11 current court documents; reads all 11 deterministic allocation documents; calls `chooseCourt` using only courts enabled both in the session snapshot and currently; updates one allocation; stores the code-hash-to-booking-ID lookup document; and stores a `pending` booking. Missing template, disabled template, closed session, a past start time or the improbable code-hash collision must fail before any write.

- [ ] **Step 5: Implement a serialized in-memory transaction adapter**

`MemoryBookingRepository.runTransaction()` must clone the current maps, execute the callback against the clone, and publish the clone only when the callback succeeds. Serialize callbacks with a promise queue so the concurrency test models an atomic commit rather than unsafe parallel map writes.

- [ ] **Step 6: Run service and domain tests**

```powershell
node --test tests/booking-service.test.mjs tests/booking-allocation.test.mjs tests/booking-state-machine.test.mjs
```

Expected: PASS, including the 44-player concurrent case.

- [ ] **Step 7: Commit**

```powershell
git add lib/booking tests/booking-service.test.mjs
git commit -m "feat: add atomic booking service"
```

---

### Task 3: Add the CloudBase transaction repository and function build

**Files:**
- Create: `cloudbase/src/repositories/cloudbase-booking-repository.ts`
- Create: `cloudbase/src/cloudbase-app.ts`
- Create: `scripts/build-cloudbase-functions.mjs`
- Create: `tests/cloudbase-repository-contract.test.mjs`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `BookingRepository` from Task 2.
- Produces: `CloudBaseBookingRepository` using only transaction `doc(id)` operations.
- Produces: a target-aware bundler used by later tasks to create CommonJS `index.js` files for Node.js 20.19.

- [ ] **Step 1: Install pinned-major CloudBase and build dependencies**

```powershell
npm install @cloudbase/node-sdk
npm install --save-dev @cloudbase/cli @cloudbase/manager-node esbuild
```

Use the lockfile versions for reproducibility. Do not add Tencent credentials to npm scripts.

- [ ] **Step 2: Write the repository contract test**

The fake SDK must reject any transaction call whose collection reference uses `.where()` and assert that `create()` reads exactly the 11 deterministic allocation document IDs before committing.

```js
assert.deepEqual(
  transaction.readIds.filter((id) => id.includes("__court-")),
  Array.from({ length: 11 }, (_, index) => `2026-08-10__slot-1900__court-${String(index + 1).padStart(2, "0")}`),
);
assert.equal(transaction.whereCalls, 0);
```

- [ ] **Step 3: Run the repository test and verify failure**

```powershell
node --test tests/cloudbase-repository-contract.test.mjs
```

Expected: FAIL because the CloudBase adapter does not exist.

- [ ] **Step 4: Implement the Node SDK adapter**

Initialize inside CloudBase without static credentials:

```ts
import cloudbase from "@cloudbase/node-sdk";

export const cloudbaseApp = cloudbase.init({
  env: cloudbase.SYMBOL_CURRENT_ENV,
});

export const database = cloudbaseApp.database();
```

Map the service transaction to `database.runTransaction(async (transaction) => { ... }, 3)`. Resolve codes only through `transaction.collection("booking_codes").doc(codeHash).get()` followed by `bookings.doc(bookingId)`; never query the booking collection by code. Read each allocation with `transaction.collection("court_allocations").doc(allocationId).get()`. `redactBooking` deletes the deterministic code-index and idempotency documents, then removes personal fields plus `idempotencyKeyHash` from the booking in one transaction. Do not call email, auth APIs, other functions or `where()` inside any callback.

- [ ] **Step 5: Add a target-aware function bundler**

`scripts/build-cloudbase-functions.mjs` must map the explicit targets `booking-public-api`, `booking-admin-api` and `booking-mailer` to their source entry and output directory. It accepts one or more target names, rejects unknown targets, and fails when a requested source entry is missing. Each requested target uses:

```js
await build({
  bundle: true,
  entryPoints: [entry],
  external: ["@cloudbase/node-sdk", "tencentcloud-sdk-nodejs-ses"],
  format: "cjs",
  outfile,
  platform: "node",
  target: "node20",
});
```

Add generated `cloudbase/functions/*/index.js` to `.gitignore`. Add these package scripts now; Tasks 4, 5 and 9 create the corresponding source entries and manifests before running them:

```json
{
  "build:cloudbase:public": "node scripts/build-cloudbase-functions.mjs booking-public-api",
  "build:cloudbase:admin": "node scripts/build-cloudbase-functions.mjs booking-admin-api",
  "build:cloudbase:mailer": "node scripts/build-cloudbase-functions.mjs booking-mailer",
  "build:cloudbase": "node scripts/build-cloudbase-functions.mjs booking-public-api booking-admin-api booking-mailer"
}
```

- [ ] **Step 6: Test bundler configuration without requiring future entries**

Export the target map and argument parser from the build script. Extend `tests/cloudbase-repository-contract.test.mjs` to verify all three exact source/output pairs and that an unknown target exits non-zero. Do not create placeholder function entries or return temporary 501 responses.

- [ ] **Step 7: Verify the adapter and build configuration**

```powershell
node --test tests/cloudbase-repository-contract.test.mjs
npm run lint
```

Expected: test PASS, no transaction uses `.where()`, and no generated function entry is required yet.

- [ ] **Step 8: Commit**

```powershell
git add cloudbase/src/repositories/cloudbase-booking-repository.ts cloudbase/src/cloudbase-app.ts scripts/build-cloudbase-functions.mjs tests/cloudbase-repository-contract.test.mjs .gitignore package.json package-lock.json
git commit -m "feat: add cloudbase booking repository"
```

---

### Task 4: Implement the public HTTP API

**Files:**
- Create: `cloudbase/src/http/request.ts`
- Create: `cloudbase/src/http/response.ts`
- Create: `cloudbase/src/http/rate-limit.ts`
- Create: `cloudbase/src/public-api.ts`
- Create: `cloudbase/functions/booking-public-api/package.json`
- Create: `tests/public-api-contract.test.mjs`

**Interfaces:**
- Produces: unauthenticated HTTP routes under `/v1`.
- Consumes: `BookingService` and CloudBase repository.
- Produces: stable JSON envelope `{ data }` or `{ error: { code, message, retryable } }`.

- [ ] **Step 1: Write failing HTTP contract tests**

Cover these routes and exact status classes:

```text
GET  /v1/availability?date=2026-08-10          200
POST /v1/bookings                              201 or 303
POST /v1/bookings/lookup                       200 or 404
POST /v1/bookings/{code}/cancel                200, 404 or 409
POST /v1/bookings/{code}/reschedule-response   200, 404 or 409
OPTIONS any route                              204
```

Assert a fifth player receives `400 INVALID_PARTY_SIZE`, the honeypot receives a generic `202`, and an exhausted session receives `409 SESSION_FULL`. Availability returns `acceptsOpenPartySizes` derived per court rather than from aggregate free seats, so two courts with two free seats each do not advertise availability for a three-person group.
Lookup, cancel and reschedule-response requests all require the full normalized phone; mutation requests also require `expectedVersion`. Wrong code and wrong phone return the same sanitized not-found envelope.

- [ ] **Step 2: Run and verify red state**

```powershell
node --test tests/public-api-contract.test.mjs
```

Expected: FAIL because the handler is missing.

- [ ] **Step 3: Implement request parsing and responses**

Accept `application/json` and `application/x-www-form-urlencoded`. Decode `event.body` when `event.isBase64Encoded` is true. Creation accepts either a canonical `session_id` or the native-fallback pair `date + start_time`; the latter is normalized to the same deterministic session ID before validation. XHR/JSON creation requires the client idempotency key. A native URL-encoded form with a blank key receives a server key computed as HMAC-SHA256 over normalized booking fields plus the current Shanghai hour using `IDEMPOTENCY_SALT`, so refresh/resubmit is safe without embedding a shared static key. Return CORS only when the request origin exactly matches a comma-separated value in `PUBLIC_ALLOWED_ORIGINS`; never return `*`.

For a native form POST, detect the absence of `Accept: application/json` and return:

```ts
return {
  statusCode: 303,
  headers: { Location: `${process.env.PUBLIC_RESULT_URL}?code=${encodeURIComponent(booking.code)}` },
  body: "",
};
```

- [ ] **Step 4: Implement rate limiting before business transactions**

Hash all keys with `RATE_LIMIT_SALT` and SHA-256. Enforce:

- create: 5 requests per IP per 10 minutes;
- lookup: 10 requests per IP and 5 requests per booking-code-plus-phone per 10 minutes;
- cancel or reschedule response: 5 requests per booking code per 10 minutes.

Store only hashes and counters in `rate_limits`; never store raw IP addresses in logs.
Use only the client address supplied by the configured CloudBase gateway request context; ignore caller-controlled forwarding headers in direct test events. If no trusted address is present, apply a stricter shared anonymous bucket rather than skipping rate limiting.

- [ ] **Step 5: Wire the public entry**

`cloudbase/src/public-api.ts` exports `main(event)` and routes only the five public endpoints. It must not import admin route code. Create a non-secret function package manifest with `"main": "index.js"` and `@cloudbase/node-sdk` as its runtime dependency, then build the entry into `cloudbase/functions/booking-public-api/index.js`.

- [ ] **Step 6: Run API, service and bundle checks**

```powershell
node --test tests/public-api-contract.test.mjs tests/booking-service.test.mjs
npm run build:cloudbase:public
```

Expected: PASS and no secret values appear in the bundle.

- [ ] **Step 7: Commit**

```powershell
git add cloudbase/src/http cloudbase/src/public-api.ts cloudbase/functions/booking-public-api/package.json tests/public-api-contract.test.mjs
git commit -m "feat: expose public booking api"
```

---

### Task 5: Implement the authenticated admin API

**Files:**
- Create: `cloudbase/src/auth/current-user.ts`
- Create: `cloudbase/src/admin-api.ts`
- Create: `cloudbase/functions/booking-admin-api/package.json`
- Create: `tests/admin-api-contract.test.mjs`

**Interfaces:**
- Produces: protected staff routes under `/v1/admin`.
- Consumes: a CloudBase Access Token already checked by the HTTP gateway.
- Requires: CloudBase role/group `booking_staff`.

- [ ] **Step 1: Write failing authorization and lifecycle tests**

Tests must prove missing tokens return 401, users without `booking_staff` return 403, and allowed staff can confirm, propose reschedule, cancel, complete, reassign, change court availability, redact personal data and export CSV. Every booking mutation test sends `expectedVersion`; a stale version must return `409 CONFLICT` without changing the booking.

```js
assert.equal((await handler(eventWithoutToken())).statusCode, 401);
assert.equal((await handler(eventWithGroups(["user"]))).statusCode, 403);
assert.equal((await handler(eventWithGroups(["booking_staff"]))).statusCode, 200);
```

- [ ] **Step 2: Resolve the authenticated user outside database transactions**

Call the official user endpoint with the incoming bearer token:

```ts
const response = await fetch(
  `https://${process.env.CLOUDBASE_ENV_ID}.api.tcloudbasegateway.com/auth/v1/user/me`,
  { headers: { Authorization: authorization } },
);
```

Require `response.ok` and `profile.groups.some((group) => group.id === "booking_staff")`. Pass `profile.user_id` into the service as the audit actor. This call happens before any `runTransaction` callback.

- [ ] **Step 3: Implement exact admin routes**

```text
GET  /v1/admin/dashboard?date=YYYY-MM-DD
GET  /v1/admin/bookings?date=&status=&mode=&q=
POST /v1/admin/bookings/{id}/confirm
POST /v1/admin/bookings/{id}/reschedule
POST /v1/admin/bookings/{id}/cancel
POST /v1/admin/bookings/{id}/complete
POST /v1/admin/bookings/{id}/reassign
POST /v1/admin/bookings/{id}/redact
PUT  /v1/admin/courts/{courtId}
PUT  /v1/admin/session-templates/{templateId}
GET  /v1/admin/export.csv?from=&to=
```

The redact route removes name, full phone, phone hash, email, note, idempotency hash and both lookup documents while retaining only booking code, allocation, status, timestamps and non-sensitive audit summary. The CSV response must escape commas, quotes and newlines, neutralize cells whose trimmed value begins with `=`, `+`, `-` or `@`, and never contain internal hashes, tokens or idempotency keys.

- [ ] **Step 4: Build and run focused checks**

Create a non-secret function package manifest with `"main": "index.js"` and `@cloudbase/node-sdk` as its runtime dependency. Then run:

```powershell
node --test tests/admin-api-contract.test.mjs tests/booking-service.test.mjs
npm run build:cloudbase:public
npm run build:cloudbase:admin
```

Expected: PASS; public and admin entries are separate bundles.

- [ ] **Step 5: Commit**

```powershell
git add cloudbase/src/auth cloudbase/src/admin-api.ts cloudbase/functions/booking-admin-api/package.json tests/admin-api-contract.test.mjs
git commit -m "feat: add protected booking administration api"
```

---

### Task 6: Replace Formspree with the real public booking form

**Files:**
- Modify: `app/BookingForm.tsx`
- Modify: `app/booking-config.ts`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `public/booking-form.js`
- Modify: `scripts/prepare-pages-output.mjs`
- Modify: `.github/workflows/pages.yml`
- Modify: `tests/booking-config.test.mjs`
- Modify: `tests/booking-enhancement-contract.test.mjs`
- Modify: `tests/rendered-html.test.mjs`
- Modify: `tests/pages-workflow.test.mjs`
- Modify: `tests/pages-static-export.test.mjs`

**Interfaces:**
- Consumes: Task 4 availability and create routes.
- Produces: ES5 enhanced form with native POST fallback.

- [ ] **Step 1: Rewrite the page contracts as failing tests**

Assert the rendered HTML contains `mode`, `date`, enabled fallback `start_time`, hidden `session_id`, `party_size` limited to 1–4, optional `email`, `note`, `privacy_consent`, `idempotency_key` and honeypot fields. Assert it says 60 minutes, 11 courts and no longer contains `Formspree`, `90 分钟`, `1—8` or `六片`.

- [ ] **Step 2: Replace endpoint configuration**

`resolveBookingApiBaseUrl` accepts only HTTPS in production and `http://127.0.0.1` or `http://localhost` in development. Produce:

```ts
export function bookingCreateUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/bookings`;
}

export function bookingResultPath(basePath = ""): string {
  return `${basePath}/booking/result/`;
}

export function bookingStatusPath(basePath = ""): string {
  return `${basePath}/booking/status/`;
}
```

Only the final Pages build (`GITHUB_PAGES=true`) fails closed when `NEXT_PUBLIC_BOOKING_API_BASE_URL` is absent or invalid. Ordinary Sites/local builds keep the introduction page available and render an explicit “预约暂不可用” panel instead of a broken form.

- [ ] **Step 3: Update the server-rendered form and truthful copy**

Render mode radio buttons, date, an enabled `start_time` select with the 60-minute fallback starts `07:00` through `22:00`, a hidden `session_id`, 1–4 participants, name, phone, optional email/notes and consent. The form action points to the public API and its data attributes contain base-path-aware result and status paths. The copy states “提交后等待工作人员确认”. Update venue copy from six courts to eleven and the experience duration from 90 to 60 minutes.

- [ ] **Step 4: Rewrite the ES5 enhancement**

The script must:

1. disable the time select only while fetching availability after a valid date is chosen;
2. retain only sessions whose `acceptsOpenPartySizes` contains the selected group size, or that have a private court for private mode, then write the selected canonical ID to `session_id`;
3. create and persist one idempotency key per unsent form in `sessionStorage`, with an in-memory fallback;
4. submit URL-encoded data through XHR with `Accept: application/json`;
5. redirect to the configured base-path-aware result page only after a 201 response containing a booking code;
6. keep all entered values after 400, 409, 429 or network errors;
7. leave the server-rendered `date + start_time` native submission available if enhancement APIs are absent.

Keep the existing Acorn `ecmaVersion: 5` assertion.

- [ ] **Step 5: Generalize the Pages sanitizer and replace the workflow endpoint**

Replace the Formspree assertion with checks for the configured booking API and preserve only scripts carrying one of these attributes:

```text
data-booking-form-client
data-booking-result-client
data-booking-status-client
data-admin-client
```

All Next/React runtime and module preload tags remain removed from the public static pages.

Change the Pages workflow to provide:

```yaml
NEXT_PUBLIC_BOOKING_API_BASE_URL: ${{ vars.BOOKING_API_BASE_URL }}
```

Remove `FORMSPREE_ENDPOINT` completely and update `tests/pages-workflow.test.mjs` to require `BOOKING_API_BASE_URL` plus the post-build static verification step.

- [ ] **Step 6: Run public form checks**

```powershell
node --test tests/booking-config.test.mjs tests/booking-enhancement-contract.test.mjs tests/rendered-html.test.mjs tests/pages-workflow.test.mjs
npm run lint
$env:GITHUB_PAGES="true"
$env:PAGES_BASE_PATH="/chengchang-pickle-club"
$env:NEXT_PUBLIC_SITE_URL="https://lingko-ljx.github.io/chengchang-pickle-club/"
$env:NEXT_PUBLIC_BOOKING_API_BASE_URL="https://booking-api.example.invalid"
npm run build:pages
npm run test:pages
```

Expected: PASS; the homepage artifact references the configured API, preserves only `data-booking-form-client`, and contains no Formspree or Next runtime.

- [ ] **Step 7: Commit**

```powershell
git add app/BookingForm.tsx app/booking-config.ts app/page.tsx app/globals.css public/booking-form.js scripts/prepare-pages-output.mjs .github/workflows/pages.yml tests/booking-config.test.mjs tests/booking-enhancement-contract.test.mjs tests/rendered-html.test.mjs tests/pages-workflow.test.mjs tests/pages-static-export.test.mjs
git commit -m "feat: connect public form to booking inventory"
```

---

### Task 7: Add result, status query and customer actions

**Files:**
- Create: `app/booking/result/page.tsx`
- Create: `app/booking/status/page.tsx`
- Create: `public/booking-result.js`
- Create: `public/booking-status.js`
- Create: `tests/booking-status-client.test.mjs`
- Modify: `app/globals.css`
- Modify: `app/page.tsx`
- Modify: `tests/pages-static-export.test.mjs`

**Interfaces:**
- Consumes: public lookup, cancel and reschedule-response routes.
- Produces: secure accountless customer lifecycle UI.

- [ ] **Step 1: Write failing static-page and ES5 client tests**

Assert both pages render without Next runtime, both clients parse as ES5, status lookup sends code plus full phone, and response rendering uses only masked fields from the server.

- [ ] **Step 2: Implement the result page**

Read only the `code` query parameter in `booking-result.js`, render it as text, and provide a link generated by `bookingStatusPath(basePath)` with the code prefilled. Do not hard-code a domain-root path, and do not put name, phone or email in the result URL or browser storage.

- [ ] **Step 3: Implement secure status lookup**

`app/booking/status/page.tsx` writes the already validated API base and repository base path into controlled `data-*` attributes; `booking-status.js` reads only those values and shows “查询服务暂不可用” if configuration is missing.

`booking-status.js` posts:

```json
{
  "code": "random-booking-code",
  "phone": "full-reserved-phone"
}
```

Render status, 60-minute session, mode, party size, masked contact and timeline. The lookup response exposes an opaque `actionVersion` but no database ID. For `reschedule_proposed`, show accept and reject buttons. Show cancel only before the server-provided `canCancelUntil` timestamp. Every action sends code, the full phone held in memory and `expectedVersion: actionVersion`; a 409 asks the user to refresh status.

- [ ] **Step 4: Preserve compatibility and privacy**

Use `textContent`, not `innerHTML`, for all server values. Clear the full phone field after a successful lookup and keep it only in a closure for the current page session. Rate-limit messages must not reveal whether a booking code exists.

- [ ] **Step 5: Run page and artifact tests**

```powershell
node --test tests/booking-status-client.test.mjs
$env:GITHUB_PAGES="true"
$env:PAGES_BASE_PATH="/chengchang-pickle-club"
$env:NEXT_PUBLIC_SITE_URL="https://lingko-ljx.github.io/chengchang-pickle-club/"
$env:NEXT_PUBLIC_BOOKING_API_BASE_URL="https://booking-api.example.invalid"
npm run build:pages
npm run test:pages
```

Expected: PASS; the invalid example hostname is used only for artifact generation and no network request occurs.

- [ ] **Step 6: Commit**

```powershell
git add app/booking/result/page.tsx app/booking/status/page.tsx public/booking-result.js public/booking-status.js app/globals.css app/page.tsx tests/booking-status-client.test.mjs tests/pages-static-export.test.mjs
git commit -m "feat: add booking status self-service"
```

---

### Task 8: Build the mobile staff administration client

**Files:**
- Create: `app/admin/page.tsx`
- Create: `admin-client/index.ts`
- Create: `admin-client/config.ts`
- Create: `admin-client/api.ts`
- Create: `admin-client/render.ts`
- Create: `scripts/build-browser-clients.mjs`
- Create: `tests/admin-client-contract.test.mjs`
- Modify: `app/globals.css`
- Modify: `.github/workflows/pages.yml`
- Modify: `tests/pages-workflow.test.mjs`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 5 admin routes.
- Produces: bundled `public/admin-app.js`.
- Uses: CloudBase Auth username/password and role `booking_staff`.

- [ ] **Step 1: Install and lock CloudBase Web SDK major 2**

```powershell
npm install @cloudbase/js-sdk@2
```

Do not use v3 login method names in this client.

- [ ] **Step 2: Write failing admin bundle contracts**

Assert the static HTML contains a login form and hidden dashboard, the generated client contains no API key or secret name value, and `admin-client/api.ts` attaches `Authorization: Bearer` for every management request.

- [ ] **Step 3: Implement login and session handling**

`app/admin/page.tsx` writes only validated public values to `data-cloudbase-env-id`, `data-api-base-url` and `data-site-base-path` on the admin shell. `admin-client/config.ts` reads those attributes and fails with a visible “后台暂不可用” state when either required value is absent. A final `GITHUB_PAGES=true` build fails closed on missing values; ordinary Sites/local builds retain the visible unavailable shell. No client module reads `process.env` at runtime.

Use the v2 API:

```ts
const app = cloudbase.init({ env: config.cloudbaseEnvId });
const auth = app.auth();
const loginState = await auth.signIn({ username, password });
const accessToken = loginState.credential.accessToken;
```

Keep the token only inside the SDK/session wrapper. On any 401 response, clear the visible dashboard and show the login form again. Never place an API Key in `NEXT_PUBLIC_*`, HTML or the bundle.

- [ ] **Step 4: Implement the mobile-first dashboard**

Render:

- today’s pending queue;
- 11-column court matrix with horizontal scrolling on narrow screens;
- filters for date, status and mode;
- booking detail timeline;
- confirm, propose reschedule, cancel, complete and reassign actions;
- court enable/disable controls;
- 60-minute session template controls;
- CSV export link.

Every mutation requires a confirmation dialog containing booking code, date and action.

- [ ] **Step 5: Bundle without React hydration**

`scripts/build-browser-clients.mjs` bundles `admin-client/index.ts` as an IIFE to `public/admin-app.js` with `target: "es2017"`. `app/admin/page.tsx` is a server-rendered shell with `<script data-admin-client defer ...>`.

Add `public/admin-app.js` to `.gitignore`; it is always generated. Add `build:clients` and prepend it to both existing site build scripts:

```json
{
  "build:clients": "node scripts/build-browser-clients.mjs",
  "build": "npm run build:clients && vinext build",
  "build:pages": "npm run build:clients && next build && node scripts/prepare-pages-output.mjs"
}
```

Add `NEXT_PUBLIC_CLOUDBASE_ENV_ID: ${{ vars.CLOUDBASE_ENV_ID }}` to the Pages workflow and assert it in `tests/pages-workflow.test.mjs`.

- [ ] **Step 6: Run admin and Pages checks**

```powershell
$env:GITHUB_PAGES="true"
$env:PAGES_BASE_PATH="/chengchang-pickle-club"
$env:NEXT_PUBLIC_SITE_URL="https://lingko-ljx.github.io/chengchang-pickle-club/"
$env:NEXT_PUBLIC_BOOKING_API_BASE_URL="https://booking-api.example.invalid"
$env:NEXT_PUBLIC_CLOUDBASE_ENV_ID="booking-test-000000"
npm run build:clients
node --test tests/admin-client-contract.test.mjs
npm run build:pages
npm run test:pages
```

Expected: PASS; admin assets load from the repository base path and the marketing homepage remains script-light.

- [ ] **Step 7: Commit**

```powershell
git add app/admin admin-client scripts/build-browser-clients.mjs tests/admin-client-contract.test.mjs app/globals.css .github/workflows/pages.yml tests/pages-workflow.test.mjs .gitignore package.json package-lock.json
git commit -m "feat: add mobile booking administration"
```

---

### Task 9: Add asynchronous email Outbox delivery

**Files:**
- Create: `lib/booking/outbox-ports.ts`
- Create: `cloudbase/src/repositories/cloudbase-outbox-repository.ts`
- Create: `cloudbase/src/notifications/ses-adapter.ts`
- Create: `cloudbase/src/privacy/redact-expired.ts`
- Create: `cloudbase/src/mailer.ts`
- Create: `cloudbase/functions/booking-mailer/package.json`
- Create: `tests/mailer.test.mjs`
- Create: `tests/cloudbase-outbox-repository-contract.test.mjs`
- Create: `tests/privacy-retention.test.mjs`
- Modify: `scripts/build-cloudbase-functions.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `notification_outbox` events written in Task 2.
- Produces: SES send attempts with leases and bounded retries.

- [ ] **Step 1: Install the product-specific SES SDK**

```powershell
npm install tencentcloud-sdk-nodejs-ses
```

- [ ] **Step 2: Write failing lease, success and retry tests**

Define `NotificationOutboxRepository.listEligible(limit, now)`, `claim(eventId, workerId, leaseUntil)`, `markSent`, `markRetry` and `markFailed`. The CloudBase adapter may use an indexed query only in `listEligible`, outside any transaction; `claim` and every state update must use `notification_outbox.doc(eventId)`. Tests must prove two workers cannot send the same event, success marks `sent`, transient errors schedule retries, permanent template/address errors mark `failed`, and booking state never changes because of mail outcomes. Add retention tests proving only completed/cancelled records older than 180 days are selected, personal fields and the code-index document are removed atomically, and audit summaries retain no personal values.

- [ ] **Step 3: Claim work transactionally, then call SES outside the transaction**

Process at most 20 eligible events per invocation. For each event:

1. use a short transaction on `notification_outbox/{eventId}` to set `status: "sending"` and a five-minute lease;
2. commit;
3. call SES;
4. set `sent` with provider request ID, or set `retry` with exponential delay;
5. stop after five attempts and set `failed`.

No SES call may occur inside `runTransaction`.

After processing email, the same scheduled invocation transactionally claims the deterministic `system_state/retention-daily` marker. Only the first worker after 03:15 `Asia/Shanghai` each day may redact at most 100 eligible bookings through `BookingService.redactPersonalData(bookingId, "retention-worker")`; later invocations skip the query. The indexed expiry query happens before per-booking transactions; active, pending, confirmed and reschedule-proposed bookings are never selected.

- [ ] **Step 4: Use exact secret names**

Read only these server environment variables:

```text
TENCENTCLOUD_SECRET_ID
TENCENTCLOUD_SECRET_KEY
SES_REGION
SES_FROM_EMAIL
SES_TEMPLATE_ID
SES_REPLY_TO
STAFF_NOTIFICATION_EMAIL
```

If configuration is incomplete, the worker leaves events retryable and logs only the missing variable name, never its value.

- [ ] **Step 5: Build and test the mailer**

Create the mailer function manifest with `"main": "index.js"` and runtime dependencies on `@cloudbase/node-sdk` and `tencentcloud-sdk-nodejs-ses`. Extend the bundler's all-target verification now that all three entries exist. Then run:

```powershell
node --test tests/mailer.test.mjs tests/cloudbase-outbox-repository-contract.test.mjs tests/privacy-retention.test.mjs
npm run build:cloudbase
Get-Item cloudbase/functions/booking-mailer/index.js
```

Expected: PASS and the mailer bundle exists.

- [ ] **Step 6: Commit**

```powershell
git add lib/booking/outbox-ports.ts cloudbase/src/repositories/cloudbase-outbox-repository.ts cloudbase/src/notifications cloudbase/src/privacy cloudbase/src/mailer.ts cloudbase/functions/booking-mailer/package.json tests/mailer.test.mjs tests/cloudbase-outbox-repository-contract.test.mjs tests/privacy-retention.test.mjs package.json package-lock.json scripts/build-cloudbase-functions.mjs
git commit -m "feat: deliver booking email notifications"
```

---

### Task 10: Provision CloudBase, authentication, roles and deployment configuration

**Files:**
- Create: `scripts/provision-cloudbase.mjs`
- Create: `scripts/render-cloudbase-config.mjs`
- Create: `.github/workflows/cloudbase.yml`
- Modify: `README.md`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: deployment environment variables and GitHub secrets.
- Produces: test CloudBase environment, collections, indexes, 11 courts, HTTP routes and staff role.

- [ ] **Step 1: Generate CloudBase CLI configuration from environment**

Require `CLOUDBASE_ENV_ID` and generate the ignored root file `cloudbaserc.json` with three Node.js 20.19 functions, `handler: "index.main"`, `installDependency: true`, and no secret `envVariables`. Configure `booking-mailer` with a one-minute timer trigger; its deterministic daily marker gates retention work. Add `/cloudbaserc.json` to `.gitignore`; the render script overwrites only that exact path. Run deployment with:

```powershell
npm run build:cloudbase
npx tcb fn deploy --all -e $env:CLOUDBASE_ENV_ID --yes
```

Validate runtime configuration before each handler starts:

| Function | Required non-secret configuration | Required secret configuration |
|---|---|---|
| `booking-public-api` | `PUBLIC_ALLOWED_ORIGINS`, `PUBLIC_RESULT_URL`, `DATA_TIMEZONE=Asia/Shanghai` | `RATE_LIMIT_SALT`, `PHONE_HASH_SALT`, `IDEMPOTENCY_SALT` |
| `booking-admin-api` | `PUBLIC_ALLOWED_ORIGINS`, `CLOUDBASE_ENV_ID`, `DATA_TIMEZONE=Asia/Shanghai` | `PHONE_HASH_SALT` |
| `booking-mailer` | `SES_REGION`, `SES_FROM_EMAIL`, `SES_TEMPLATE_ID`, `SES_REPLY_TO`, `STAFF_NOTIFICATION_EMAIL`, `PII_RETENTION_DAYS=180` | `TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY` |

Missing configuration must produce a sanitized startup error naming only the variable. Public values may be written through deployment configuration; secret values are set directly in CloudBase and never rendered into the repository or generated config.

- [ ] **Step 2: Provision database collections and deterministic seed data**

Using `@cloudbase/manager-node`, create if missing:

```text
courts
session_templates
sessions
court_allocations
bookings
booking_codes
audit_logs
notification_outbox
rate_limits
idempotency
system_state
```

Seed courts `01`–`11`. Seed hourly 60-minute templates with deterministic IDs `slot-0700` through `slot-2200`, matching the current displayed 07:00–23:00 opening window; staff can disable any template before production. Canonical session IDs are `${date}__${templateId}` and therefore never require a query inside a booking transaction.

Create indexes for bookings by `(sessionId,status)`, `(date,createdAt,id)`, `(date,status,createdAt,id)`, `(proposedDate,status,createdAt,id)`, `(phoneHash,createdAt)`, and `(status,terminalAt,personalDataRedactedAt)`; `booking_codes` uses `sha256(normalizedCode)` as the deterministic document ID and stores only the booking ID; audit logs by `(bookingId,at,id)`; sessions by `(date,startAt)`; Outbox by `(status,nextAttemptAt)`.

- [ ] **Step 3: Lock direct database access**

In the CloudBase console, set every booking collection to deny direct client read and write. All public and staff data access must go through the two HTTP functions.

- [ ] **Step 4: Configure CloudBase Auth and RBAC**

In the test environment:

1. enable username/password authentication;
2. disable public self-registration;
3. create role/group `booking_staff`;
4. grant it permission to invoke only the admin HTTP resource;
5. create the initial staff account in the console and assign `booking_staff`;
6. keep the public API path unauthenticated;
7. enable identity authentication for the admin API path.

Do not grant system administrator permissions to the staff role.

- [ ] **Step 5: Configure CORS and gateway paths**

Allow exactly:

```text
https://lingko-ljx.github.io
http://127.0.0.1:3001
http://localhost:3001
```

Map the public and admin function paths separately. The public path has gateway authentication off; the admin path has authentication on. Configure OPTIONS at the gateway or retain the tested function-level OPTIONS handler, but not both with conflicting headers.

- [ ] **Step 6: Add CloudBase deployment workflow and validate repository variables**

Verify the Pages workflow already uses the repository variables introduced in Tasks 6 and 8:

```yaml
NEXT_PUBLIC_BOOKING_API_BASE_URL: ${{ vars.BOOKING_API_BASE_URL }}
NEXT_PUBLIC_CLOUDBASE_ENV_ID: ${{ vars.CLOUDBASE_ENV_ID }}
```

Add a manual CloudBase workflow that consumes GitHub secrets `TENCENTCLOUD_SECRET_ID` and `TENCENTCLOUD_SECRET_KEY`, builds functions, and deploys with the repository variable `CLOUDBASE_ENV_ID`. The workflow must fail before deployment when `BOOKING_API_BASE_URL` or `CLOUDBASE_ENV_ID` is absent. Function runtime secrets remain configured in CloudBase and are not overwritten by `cloudbaserc.json`.

As soon as the staging gateway URL exists, set the repository variables to the staging API base and staging environment ID so branch/workflow tests have complete configuration. Do not push Tasks 1–11 to `main`; Task 12 replaces both variables with production values immediately before the public Pages deployment.

- [ ] **Step 7: Activate SES operational prerequisites**

In Tencent Cloud SES, verify a sending domain/address, approve the service-notification template, and place its numeric template ID plus credentials in CloudBase function environment variables. Send one synthetic message to the staff notification mailbox and one optional customer address, then delete test Outbox records.

- [ ] **Step 8: Verify workflows and staging endpoints**

```powershell
node --test tests/pages-workflow.test.mjs
npm run build:cloudbase
npm test
npm run lint
```

Call staging availability, create, lookup and authenticated dashboard routes with synthetic data. Expected: all return their documented status codes and the database contains matching audit and Outbox records.

- [ ] **Step 9: Commit**

```powershell
git add scripts/provision-cloudbase.mjs scripts/render-cloudbase-config.mjs .github/workflows/cloudbase.yml README.md .gitignore package.json
git commit -m "ci: provision cloudbase booking services"
```

---

### Task 11: Add end-to-end, concurrency and browser verification

**Files:**
- Create: `scripts/preview-booking-stack.mjs`
- Create: `playwright.config.ts`
- Create: `tests/e2e/booking-flow.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: complete public site, memory repository and API handlers.
- Produces: repeatable local and staging acceptance checks.

- [ ] **Step 1: Install Playwright and define one local stack command**

```powershell
npm install --save-dev @playwright/test
npx playwright install chromium webkit
```

`scripts/preview-booking-stack.mjs` serves the final `out/` files and routes `/api/*` to the same handlers backed by `MemoryBookingRepository`, all on `127.0.0.1:4173`.

- [ ] **Step 2: Write end-to-end customer tests**

Cover:

- private booking submission and result code;
- open booking auto-fill;
- lookup by code plus phone;
- worker confirm reflected on the status page;
- reschedule accept and reject;
- cancellation releases inventory;
- a fifth player is rejected;
- form values remain after simulated 409 and network errors.

- [ ] **Step 3: Write admin end-to-end tests with a fake auth provider**

In local mode only, inject a fake `booking_staff` token resolver. Verify the mobile dashboard displays 11 courts and that confirm, reschedule, cancel, complete, reassign, closure and CSV actions call the expected API routes.

- [ ] **Step 4: Run the complete automated suite**

```powershell
$env:GITHUB_PAGES="true"
$env:PAGES_BASE_PATH="/chengchang-pickle-club"
$env:NEXT_PUBLIC_SITE_URL="https://lingko-ljx.github.io/chengchang-pickle-club/"
$env:NEXT_PUBLIC_BOOKING_API_BASE_URL="https://booking-api.example.invalid"
$env:NEXT_PUBLIC_CLOUDBASE_ENV_ID="booking-test-000000"
npm test
npm run lint
npm run build:pages
npm run test:pages
npm run test:e2e
npm run build:cloudbase
```

Expected: every command exits 0.

- [ ] **Step 5: Run staging concurrency verification**

Against an isolated future session, submit 12 simultaneous private requests and verify exactly 11 succeed. Against another isolated session, submit 45 simultaneous one-player open requests and verify exactly 44 succeed. Query all 11 allocation documents and assert no court exceeds four players.

- [ ] **Step 6: Run the browser matrix**

Verify final Pages output on:

- Chromium desktop and 390×844 mobile emulation;
- WebKit/iPhone emulation;
- a real Android browser or Android WebView supplied for acceptance;
- a real iPhone Safari session;
- WeChat built-in browser for page opening only, without WeChat integration.

Record browser, OS, page, result and screenshot path in `README.md` under “预约验收记录”. Do not claim a real-device pass when only emulation was run.

- [ ] **Step 7: Verify production-safe failure behavior**

Disable the staging API temporarily and confirm the marketing site still loads, all booking pages show an explicit unavailable message, no white page appears, and no submission displays a false success.

- [ ] **Step 8: Commit**

```powershell
git add scripts/preview-booking-stack.mjs playwright.config.ts tests/e2e package.json package-lock.json README.md
git commit -m "test: verify booking core end to end"
```

---

### Task 12: Final review, public deployment and handoff

**Files:**
- Verify: all files from Tasks 1–11
- Verify: `docs/superpowers/specs/2026-08-04-booking-core-design.md`
- Verify: `out/`
- Verify: CloudBase staging and production resources

**Interfaces:**
- Produces: first-stage public booking system and documented staff handoff.

- [ ] **Step 1: Review implementation against every specification section**

Build a requirement-to-test checklist covering scope, roles, UX, allocation, concurrency, architecture, models, API, email, security, browsers and completion criteria. Any uncovered requirement receives a failing test before code changes.

- [ ] **Step 2: Run clean-build verification**

```powershell
npm ci
$env:GITHUB_PAGES="true"
$env:PAGES_BASE_PATH="/chengchang-pickle-club"
$env:NEXT_PUBLIC_SITE_URL="https://lingko-ljx.github.io/chengchang-pickle-club/"
$env:NEXT_PUBLIC_BOOKING_API_BASE_URL="https://booking-api.example.invalid"
$env:NEXT_PUBLIC_CLOUDBASE_ENV_ID="booking-test-000000"
npm test
npm run lint
npm run build:pages
npm run test:pages
npm run test:e2e
npm run build:cloudbase
git status --short
```

Expected: every command exits 0; only the pre-existing untracked `.superpowers/` directory may remain.

- [ ] **Step 3: Deploy production CloudBase resources**

Deploy the three functions to the production environment, provision collections and indexes, configure exact production origins, enable admin authentication/RBAC, set secrets in CloudBase, and run one synthetic private and one synthetic open booking through the entire lifecycle.

- [ ] **Step 4: Configure GitHub repository variables and deploy Pages**

Set `BOOKING_API_BASE_URL` and `CLOUDBASE_ENV_ID` to production values, push the implementation branch to `main` only after a fast-forward check, and wait for both CloudBase and Pages workflows to succeed.

- [ ] **Step 5: Verify anonymously and clean test data**

Open `https://lingko-ljx.github.io/chengchang-pickle-club/` without GitHub authentication. Verify homepage, booking, result, status and staff-login shell load; verify synthetic bookings reach the production database and staff email; then cancel/delete synthetic personal data while retaining non-sensitive audit proof.

- [ ] **Step 6: Handoff operations**

Document how staff log in, confirm, reschedule, cancel, close a court, edit 60-minute templates, export CSV and recover from an email failure. State explicitly that微信交互和在线支付仍未启用。

- [ ] **Step 7: Final commit if handoff documentation changed**

```powershell
git add README.md
git commit -m "docs: hand off booking operations"
```

## Official implementation references

- CloudBase transaction limits and `runTransaction`: https://docs.cloudbase.net/database/transaction
- CloudBase HTTP access event and response contract: https://docs.cloudbase.net/service/access-cloud-function
- CloudBase function layout and deployment: https://docs.cloudbase.net/cli-v1/functions/deploy
- CloudBase username/password authentication: https://docs.cloudbase.net/en/authentication-v2/method/username-login
- CloudBase HTTP authentication: https://docs.cloudbase.net/service/authentication
- CloudBase CORS configuration: https://docs.cloudbase.net/service/cors
- CloudBase secret handling: https://docs.cloudbase.net/en/recipes/secure-secrets-in-cloud-function
- Tencent Cloud SES SendEmail API: https://cloud.tencent.com/document/api/1288/51034
