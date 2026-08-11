import type {
  HomepageMediaStorage,
  StoredMediaInfo,
} from "../../../lib/media/ports.ts";
import type { SignedMediaUpload } from "../../../lib/media/types.ts";
import { cloudbaseApp } from "../cloudbase-app.ts";

interface UploadMetadataResult {
  data?: {
    url?: unknown;
    token?: unknown;
    authorization?: unknown;
    fileId?: unknown;
    cosFileId?: unknown;
  };
}

interface FileInfoResult {
  fileList?: Array<{
    code?: unknown;
    fileID?: unknown;
    mime?: unknown;
    size?: unknown;
  }>;
}

interface FileUrlResult {
  fileList?: Array<{
    code?: unknown;
    fileID?: unknown;
    tempFileURL?: unknown;
  }>;
}

interface DeleteResult {
  fileList?: Array<{ code?: unknown; fileID?: unknown }>;
}

interface StorageClient {
  getUploadMetadata(input: { cloudPath: string }): Promise<UploadMetadataResult>;
  getFileInfo(input: { fileList: string[] }): Promise<FileInfoResult>;
  getTempFileURL(input: { fileList: Array<{ fileID: string; maxAge: number }> }): Promise<FileUrlResult>;
  deleteFile(input: { fileList: string[] }): Promise<DeleteResult>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("MEDIA_STORAGE_RESPONSE_INVALID");
  }
  return value;
}

export class CloudBaseHomepageMediaStorage implements HomepageMediaStorage {
  private readonly client: StorageClient;

  constructor(client: StorageClient = cloudbaseApp as unknown as StorageClient) {
    this.client = client;
  }

  async createUpload(input: {
    storagePath: string;
    mimeType: string;
    sizeBytes: number;
    expiresAt: string;
  }): Promise<SignedMediaUpload> {
    const metadata = await this.client.getUploadMetadata({ cloudPath: input.storagePath });
    const data = metadata.data;
    const url = requiredString(data?.url);
    const token = requiredString(data?.token);
    const authorization = requiredString(data?.authorization);
    const fileId = requiredString(data?.fileId);
    const cosFileId = requiredString(data?.cosFileId);
    return {
      method: "PUT",
      url,
      headers: {
        "Content-Type": input.mimeType,
        Signature: authorization,
        authorization,
        "x-cos-security-token": token,
        "x-cos-meta-fileid": cosFileId,
        key: encodeURIComponent(input.storagePath),
      },
      expiresAt: input.expiresAt,
      fileId,
    };
  }

  async inspect(fileId: string): Promise<StoredMediaInfo> {
    const result = await this.client.getFileInfo({ fileList: [fileId] });
    const item = result.fileList?.find((candidate) => candidate.fileID === fileId);
    if (!item || item.code !== "SUCCESS") return { exists: false };
    return {
      exists: true,
      mimeType: typeof item.mime === "string" ? item.mime : undefined,
      sizeBytes: typeof item.size === "number" ? item.size : undefined,
    };
  }

  async publicUrls(fileIds: readonly string[]): Promise<Record<string, string>> {
    if (fileIds.length === 0) return {};
    const result = await this.client.getTempFileURL({
      fileList: fileIds.map((fileID) => ({ fileID, maxAge: 60 * 60 })),
    });
    const urls: Record<string, string> = {};
    for (const fileId of fileIds) {
      const item = result.fileList?.find((candidate) => candidate.fileID === fileId);
      if (item?.code === "SUCCESS") urls[fileId] = requiredString(item.tempFileURL);
    }
    return urls;
  }

  async delete(fileId: string): Promise<void> {
    const result = await this.client.deleteFile({ fileList: [fileId] });
    const item = result.fileList?.find((candidate) => candidate.fileID === fileId);
    if (!item || item.code !== "SUCCESS") throw new Error("MEDIA_STORAGE_DELETE_FAILED");
  }
}
