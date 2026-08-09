type BookingFormProps = {
  apiBaseUrl: string;
  formEndpoint: string;
  resultPath: string;
  scriptSrc: string;
  statusPath: string;
};

const fallbackStartTimes = [
  "07:00",
  "08:00",
  "09:00",
  "10:00",
  "11:00",
  "12:00",
  "13:00",
  "14:00",
  "15:00",
  "16:00",
  "17:00",
  "18:00",
  "19:00",
  "20:00",
  "21:00",
  "22:00",
];
const partySizes = [1, 2, 3, 4];

export function BookingForm({
  apiBaseUrl,
  formEndpoint,
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
          每个场次固定 60 分钟，可选择散客拼场或 1–4 人包场。
          页面展示实时可用场次，最终分配以提交结果为准。
        </p>
        <div className="booking-facts">
          <div>
            <span>60</span>
            <p>分钟固定场次</p>
          </div>
          <div>
            <span>1—4</span>
            <p>位参与者可提交预约</p>
          </div>
        </div>
      </div>

      <div>
        {configured ? (
          <>
            <form
              acceptCharset="UTF-8"
              action={formEndpoint}
              className="booking-form"
              data-availability-url={`${apiBaseUrl.replace(/\/+$/, "")}/v1/availability`}
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
                    <option value="">请选择时段</option>
                    {fallbackStartTimes.map((time) => (
                      <option key={time} value={time}>
                        {time}
                      </option>
                    ))}
                  </select>
                </label>
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
                    name="name"
                    required
                    type="text"
                  />
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
                <label htmlFor="booking-email">
                  <span>电子邮箱（选填）</span>
                  <input
                    autoComplete="email"
                    id="booking-email"
                    name="email"
                    type="email"
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
                <span>我同意澄场仅使用以上信息处理预约并与我联系。</span>
              </label>

              <p className="booking-disclaimer">
                提交后等待工作人员确认；提交成功不等于场次已确认。
              </p>
              <p id="booking-error" className="field-error" hidden role="alert" />
              <button className="primary-button" type="submit">
                提交预约
                <span aria-hidden="true">↗</span>
              </button>
            </form>
            <script data-booking-form-client defer src={scriptSrc} />
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
