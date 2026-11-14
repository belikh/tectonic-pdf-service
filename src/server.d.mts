import type { Server } from "node:http";
export const DEFAULT_BUNDLE: string;
export const LOG_TAIL_BYTES: number;
export const ENV_KEYS: string[];
export type AppOptions = { tectonicBin?: string; cacheDir?: string; bundle?: string; jupiterDir?: string; jobRoot?: string; timeoutMs?: number; concurrency?: number; maxQueue?: number };
export function createApp(options?: AppOptions): Promise<{ server: Server; stats: { active: number; waiting: number; maxActive: number; served: number }; config: Record<string, unknown> }>;
