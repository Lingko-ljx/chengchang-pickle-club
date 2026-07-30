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
          <label className="honeypot-field" hidden>
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
            tabIndex={-1}
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
