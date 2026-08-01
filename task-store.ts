import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const TASKS_DIR = join(homedir(), "Library", "Application Support", "yt-dlp-raycast", "tasks");
export const APP_STATE_PATH = join(TASKS_DIR, "..", "app-state.json");

export type TaskStatus = "queued" | "running" | "success" | "failure" | "cancelled" | "interrupted";
export type TaskPhase = "queued" | "waiting" | "preflight" | "extracting" | "downloading" | "post-processing" | "finished";
export type TaskErrorKind =
  | "invalid_input"
  | "environment"
  | "authentication"
  | "unavailable"
  | "network"
  | "rate_limited"
  | "storage"
  | "ffmpeg"
  | "cancelled"
  | "interrupted"
  | "unknown";

export interface TaskState {
  version: 1 | 2;
  id: string;
  url: string;
  mode: "video" | "mp4" | "audio";
  outputDir: string;
  subtitles: boolean;
  cookies: "none" | "chrome" | "safari" | "firefox";
  status: TaskStatus;
  phase?: TaskPhase;
  percent: number | null;
  lines: string[];
  pid: number | null;
  outputPath?: string;
  attempt?: number;
  retryOf?: string;
  error?: string;
  errorKind?: TaskErrorKind;
  errorHint?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastActivityAt?: string;
  updatedAt: string;
}

export type TaskRecord = TaskState & { statePath: string };

export interface TaskAppState {
  lastCompletedAt?: string;
  unseenCompletionIds?: string[];
  lastSeenCompletionAt?: string;
  lastViewedCompletionAt?: string;
}

export function createTaskState(input: {
  url: string;
  mode: TaskState["mode"];
  outputDir: string;
  subtitles: boolean;
  cookies: TaskState["cookies"];
  attempt?: number;
  retryOf?: string;
}): TaskRecord {
  ensureTasksDir();
  const id = randomUUID();
  const taskDir = join(TASKS_DIR, id);
  const statePath = join(taskDir, "state.json");
  const timestamp = new Date().toISOString();
  const state: TaskState = {
    version: 2,
    id,
    ...input,
    status: "queued",
    phase: "queued",
    percent: null,
    lines: [],
    pid: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  mkdirSync(taskDir, { recursive: true });
  writeTaskState(statePath, state);
  return { ...state, statePath };
}

export function ensureTasksDir(): void {
  mkdirSync(TASKS_DIR, { recursive: true });
}

export function readTaskAppState(): TaskAppState {
  try {
    return JSON.parse(readFileSync(APP_STATE_PATH, "utf8")) as TaskAppState;
  } catch {
    return {};
  }
}

export function writeTaskAppState(state: TaskAppState): void {
  ensureTasksDir();
  const temporaryPath = `${APP_STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, APP_STATE_PATH);
}

export function writeTaskState(statePath: string, state: TaskState): void {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, statePath);
}

export function readTaskState(statePath: string): TaskState | null {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as TaskState;
  } catch {
    return null;
  }
}

export function listTaskStates(): TaskRecord[] {
  ensureTasksDir();
  return readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const statePath = join(TASKS_DIR, entry.name, "state.json");
      const state = readTaskState(statePath);
      return state ? { ...state, statePath } : null;
    })
    .filter((state): state is TaskRecord => state !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
