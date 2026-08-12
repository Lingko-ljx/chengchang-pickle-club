import type { HomepageMediaStorage, MediaClock, MediaIdProvider } from "../media/ports.ts";
import type { HonorMediaManifest } from "./types.ts";

export interface HonorMediaRepository {
  read(): Promise<HonorMediaManifest>;
  replace(expectedVersion: number, manifest: HonorMediaManifest): Promise<void>;
}

export type HonorMediaStorage = HomepageMediaStorage;
export type HonorMediaClock = MediaClock;
export type HonorMediaIdProvider = MediaIdProvider;
