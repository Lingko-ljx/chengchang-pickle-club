export type MediaErrorCode =
  | "INVALID_MEDIA_INPUT"
  | "MEDIA_NOT_FOUND"
  | "MEDIA_CONFLICT"
  | "MEDIA_UPLOAD_INCOMPLETE"
  | "MEDIA_UPLOAD_MISMATCH"
  | "MEDIA_LIMIT_REACHED";

export class MediaError extends Error {
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode) {
    super(code);
    this.name = "MediaError";
    this.code = code;
  }
}
