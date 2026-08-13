type BookingFormProps = {
  apiBaseUrl: string;
  formEndpoint: string;
  publicScheduleScriptSrc: string;
  resultPath: string;
  scriptSrc: string;
  statusPath: string;
};

const fallbackStartTimes = [
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
  "12:30",
  "13:00",
  "13:30",
  "14:00",
  "14:30",
  "15:00",
  "15:30",
  "16:00",
  "16:30",
  "17:00",
  "17:30",
  "18:00",
  "18:30",
  "19:00",
  "19:30",
  "20:00",
  "20:30",
  "21:00",
];
const partySizes = [1, 2, 3, 4];

export function BookingForm({
  apiBaseUrl,
  formEndpoint,
  publicScheduleScriptSrc,
  resultPath,
  scriptSrc,
  statusPath,
}: BookingFormProps) {
  const configured = Boolean(apiBaseUrl && formEndpoint);

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
          每天 09:00–22:00 开放预约，开始时间可选整点或半点。
          每次至少 1 小时，之后按整小时增加，可选择散客拼场或包场。
        </p>
        <div className="booking-facts">
          <div>
            <span>30</span>
            <p>分钟可选开始间隔</p>
          </div>
          <div>
            <span>1—4H</span>
            <p>按实际整小时计费</p>
          </div>
        </div>
        {configured ? (
          <section
            className="public-schedule"
            data-public-schedule-url={`${apiBaseUrl.replace(/\/+$/, "")}/v1/public-schedule`}
            id="public-schedule"
          >
            <div className="public-schedule-heading">
              <div>
              <span>WHO IS PLAYING</span>
                <h3>这一天，谁来打球</h3>
              </div>
              <strong id="public-schedule-summary">正在读取预约热度…</strong>
            </div>
            <div className="public-schedule-list" id="public-schedule-list" />
            <p aria-live="polite" id="public-schedule-status">
              默认展示预约人的完整姓名与打球时间；选择不公开姓名的球友仅显示脱敏称呼。手机号、邮箱、预约编号和备注始终保密。
            </p>
          </section>
        ) : null}
      </div>

      <div>
        {configured ? (
          <>
            <form
              acceptCharset="UTF-8"
              action={formEndpoint}
              className="booking-form"
              data-availability-url={`${apiBaseUrl.replace(/\/+$/, "")}/v1/availability/windows`}
              data-booking-result-path={resultPath}
              data-booking-status-path={statusPath}
              id="booking-form"
              method="post"
            >
              <input id="booking-session-id" name="session_id" type="hidden" />
              <input
                id="booking-idempotency-key"
                name="idempotency_key"
                type="hidden"
              />
              <label className="honeypot-field" hidden>
                请勿填写
                <input
                  autoComplete="off"
                  name="website"
                  tabIndex={-1}
                  type="text"
                />
              </label>

              <fieldset className="form-group booking-mode-group">
                <legend>预约方式</legend>
                <div className="mode-options">
                  <label>
                    <input defaultChecked name="mode" type="radio" value="open" />
                    <span>散客拼场</span>
                  </label>
                  <label>
                    <input name="mode" type="radio" value="private" />
                    <span>包场独享</span>
                  </label>
                </div>
              </fieldset>

              <div className="form-group input-grid booking-time-grid">
                <label htmlFor="booking-date">
                  <span>预约日期</span>
                  <input id="booking-date" name="date" required type="date" />
                </label>
                <label htmlFor="booking-start-time">
                  <span>开始时间</span>
                  <select
                    id="booking-start-time"
                    name="start_time"
                    required
                  >
                    <option value="">请选择开始时间</option>
                    {fallbackStartTimes.map((time) => (
                      <option key={time} value={time}>
                        {time}
                      </option>
                    ))}
                  </select>
                </label>
                <label htmlFor="booking-end-time">
                  <span>结束时间</span>
                  <select id="booking-end-time" name="end_time" required>
                    <option value="">请选择结束时间</option>
                  </select>
                </label>
                <div
                  aria-live="polite"
                  className="booking-time-summary"
                  id="booking-time-summary"
                  role="status"
                >
                  <strong>北京时间</strong>
                  <span>请选择开始与结束时间</span>
                </div>
                <p
                  aria-live="polite"
                  className="booking-availability-status"
                  id="booking-availability-status"
                  role="status"
                >
                  营业时间 09:00–22:00 · 最少 1 小时 · 整小时计费
                </p>
              </div>

              <div className="form-group input-grid">
                <label htmlFor="booking-party-size">
                  <span>参与人数</span>
                  <select
                    defaultValue="1"
                    id="booking-party-size"
                    name="party_size"
                    required
                  >
                    {partySizes.map((size) => (
                      <option key={size} value={size}>{`${size} 位`}</option>
                    ))}
                  </select>
                </label>
                <label htmlFor="booking-name">
                  <span>您的称呼</span>
                  <input
                    autoComplete="name"
                    id="booking-name"
                    maxLength={40}
                    name="name"
                    required
                    type="text"
                  />
                  <small className="field-help">请填写大家熟悉的真实称呼，默认会在首页完整展示。</small>
                </label>
                <label htmlFor="booking-phone">
                  <span>联系电话</span>
                  <input
                    autoComplete="tel"
                    id="booking-phone"
                    inputMode="tel"
                    name="phone"
                    pattern="[0-9+() -]{8,20}"
                    required
                    type="tel"
                  />
                </label>
                <label className="form-wide" htmlFor="booking-note">
                  <span>备注（选填）</span>
                  <textarea id="booking-note" name="note" rows={3} />
                </label>
              </div>

              <label className="privacy-consent">
                <input
                  name="privacy_consent"
                  required
                  type="checkbox"
                  value="yes"
                />
                <span>
                  我同意睿安成使用以上信息处理预约并与我联系，并已知悉姓名默认会在首页公开展示。
                </span>
              </label>

              <input
                name="public_schedule_consent_version"
                type="hidden"
                value="2"
              />
              <label className="privacy-consent public-schedule-consent">
                <input
                  name="hide_public_name"
                  type="checkbox"
                  value="true"
                />
                <span>
                  我不想公开完整姓名（选填）。勾选后首页仅显示脱敏称呼；不勾选则默认显示完整姓名。预约时段、人数和散客/包场性质仍会展示，手机号、邮箱、预约编号和备注始终保密。
                </span>
              </label>

              <p className="booking-disclaimer">
                所有时间均为北京时间。余位校验通过后，提交成功后系统将自动确认并锁定场地；如需调整，工作人员会电话联系。
              </p>
              <p id="booking-error" className="field-error" hidden role="alert" />
              <button className="primary-button" type="submit">
                提交预约
                <span aria-hidden="true">↗</span>
              </button>
            </form>
            <script data-booking-form-client defer src={scriptSrc} />
            <script data-public-schedule-client defer src={publicScheduleScriptSrc} />
          </>
        ) : (
          <div className="booking-unavailable" role="status">
            <p className="booking-overline">BOOKING OFFLINE</p>
            <h3>预约暂不可用</h3>
            <p>预约服务正在配置中。介绍内容仍可浏览，请稍后再试或电话联系我们。</p>
          </div>
        )}
      </div>
    </div>
  );
}
