export type BookingDraft = {
  date: string;
  time: string;
  partySize: number;
  name: string;
  phone: string;
};

export type BookingErrors = Partial<Record<keyof BookingDraft, string>>;

export function validateBooking(draft: BookingDraft): BookingErrors {
  const errors: BookingErrors = {};

  if (!draft.date) {
    errors.date = "请选择体验日期";
  }

  if (!draft.time) {
    errors.time = "请选择体验时段";
  }

  if (draft.partySize < 1 || draft.partySize > 8) {
    errors.partySize = "请选择 1–8 位参与者";
  }

  if (!draft.name.trim()) {
    errors.name = "请填写您的称呼";
  }

  if (!/^[0-9+\-\s]{7,20}$/.test(draft.phone.trim())) {
    errors.phone = "请填写有效的联系电话";
  }

  return errors;
}

export function formatBookingSummary(draft: BookingDraft): string {
  return `${draft.date} · ${draft.time} · ${draft.partySize}位`;
}
