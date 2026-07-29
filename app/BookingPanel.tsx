"use client";

import { FormEvent, useState } from "react";
import {
  type BookingDraft,
  type BookingErrors,
  formatBookingSummary,
  validateBooking,
} from "./booking-model";

const initialDraft: BookingDraft = {
  date: "",
  time: "",
  partySize: 2,
  name: "",
  phone: "",
};

const dates = [
  { day: "30", month: "7月", week: "周四", value: "7月30日 周四" },
  { day: "31", month: "7月", week: "周五", value: "7月31日 周五" },
  { day: "01", month: "8月", week: "周六", value: "8月1日 周六" },
  { day: "02", month: "8月", week: "周日", value: "8月2日 周日" },
];

const times = ["10:00", "14:00", "16:30", "19:00", "20:30"];

export function BookingPanel() {
  const [draft, setDraft] = useState<BookingDraft>(initialDraft);
  const [errors, setErrors] = useState<BookingErrors>({});
  const [submitted, setSubmitted] = useState(false);

  function updateDraft<K extends keyof BookingDraft>(
    key: K,
    value: BookingDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateBooking(draft);

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setSubmitted(true);
  }

  function resetBooking() {
    setDraft(initialDraft);
    setErrors({});
    setSubmitted(false);
  }

  if (submitted) {
    return (
      <div className="booking-success" aria-live="polite">
        <div className="success-mark" aria-hidden="true">
          <span>✓</span>
        </div>
        <p className="booking-overline">RESERVATION PREVIEW</p>
        <h2>体验席位已为你预留</h2>
        <p className="success-summary">{formatBookingSummary(draft)}</p>
        <p className="success-name">{draft.name}，期待与你在球场见面。</p>
        <div className="success-notice">
          <span aria-hidden="true">i</span>
          当前为演示预约，信息没有被保存或发送。
        </div>
        <button className="secondary-button" type="button" onClick={resetBooking}>
          重新预约
        </button>
      </div>
    );
  }

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
            <span>2—8</span>
            <p>位好友均可参与</p>
          </div>
        </div>
      </div>

      <form className="booking-form" onSubmit={handleSubmit} noValidate>
        <div className="form-group">
          <div className="form-label-row">
            <span className="form-step">01</span>
            <fieldset>
              <legend>选择日期</legend>
              <div className="date-options">
                {dates.map((date) => (
                  <button
                    aria-pressed={draft.date === date.value}
                    className={draft.date === date.value ? "selected" : ""}
                    key={date.value}
                    onClick={() => updateDraft("date", date.value)}
                    type="button"
                  >
                    <span>
                      {date.month} · {date.week}
                    </span>
                    <strong>{date.day}</strong>
                  </button>
                ))}
              </div>
              {errors.date ? (
                <p className="field-error" role="alert">
                  {errors.date}
                </p>
              ) : null}
            </fieldset>
          </div>
        </div>

        <div className="form-group">
          <div className="form-label-row">
            <span className="form-step">02</span>
            <fieldset>
              <legend>选择时段</legend>
              <div className="time-options">
                {times.map((time) => (
                  <button
                    aria-pressed={draft.time === time}
                    className={draft.time === time ? "selected" : ""}
                    key={time}
                    onClick={() => updateDraft("time", time)}
                    type="button"
                  >
                    {time}
                  </button>
                ))}
              </div>
              {errors.time ? (
                <p className="field-error" role="alert">
                  {errors.time}
                </p>
              ) : null}
            </fieldset>
          </div>
        </div>

        <div className="form-group">
          <div className="form-label-row">
            <span className="form-step">03</span>
            <div className="contact-fields">
              <p className="form-legend">留下联系信息</p>
              <div className="input-grid">
                <label>
                  <span>您的称呼</span>
                  <input
                    autoComplete="name"
                    name="name"
                    onChange={(event) => updateDraft("name", event.target.value)}
                    placeholder="例如：林先生"
                    type="text"
                    value={draft.name}
                  />
                  {errors.name ? (
                    <small className="field-error" role="alert">
                      {errors.name}
                    </small>
                  ) : null}
                </label>
                <label>
                  <span>联系电话</span>
                  <input
                    autoComplete="tel"
                    inputMode="tel"
                    name="phone"
                    onChange={(event) => updateDraft("phone", event.target.value)}
                    placeholder="用于接收预约确认"
                    type="tel"
                    value={draft.phone}
                  />
                  {errors.phone ? (
                    <small className="field-error" role="alert">
                      {errors.phone}
                    </small>
                  ) : null}
                </label>
                <label>
                  <span>参与人数</span>
                  <select
                    name="partySize"
                    onChange={(event) =>
                      updateDraft("partySize", Number(event.target.value))
                    }
                    value={draft.partySize}
                  >
                    {Array.from({ length: 8 }, (_, index) => index + 1).map(
                      (size) => (
                        <option key={size} value={size}>
                          {size} 位
                        </option>
                      ),
                    )}
                  </select>
                  {errors.partySize ? (
                    <small className="field-error" role="alert">
                      {errors.partySize}
                    </small>
                  ) : null}
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="form-submit-row">
          <p>
            <span aria-hidden="true">●</span>
            当前为演示预约，不会保存或发送信息
          </p>
          <button className="primary-button" type="submit">
            确认体验时间
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </form>
    </div>
  );
}
