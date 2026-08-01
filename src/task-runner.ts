import { environment } from "@raycast/api";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTaskState, writeTaskState, type TaskRecord, type TaskState } from "./task-store";

const HOMEBREW_BIN = "/opt/homebrew/bin";
const DEFAULT_OUTPUT_DIR = join(homedir(), "Downloads", "yt-dlp");

export type DownloadMode = "video" | "mp4" | "audio";
export type CookieSource = "none" | "chrome" | "safari" | "firefox";

export interface DownloadJob {
  mode: DownloadMode;
  outputDir: string;
  subtitles: boolean;
  cookies: CookieSource;
}

export function enqueueTask(
  job: DownloadJob,
  url: string,
  options: { attempt?: number; retryOf?: string } = {},
): TaskRecord {
  const workerPath = join(environment.assetsPath, "worker.js");
  const task = createTaskState({
    url,
    mode: job.mode,
    outputDir: job.outputDir || DEFAULT_OUTPUT_DIR,
    subtitles: job.subtitles,
    cookies: job.cookies,
    attempt: options.attempt ?? 1,
    retryOf: options.retryOf,
  });
  const { statePath: _statePath, ...baseState } = task;

  if (!existsSync(workerPath)) {
    const timestamp = new Date().toISOString();
    const failedState: TaskState = {
      ...baseState,
      status: "failure",
      phase: "finished",
      pid: null,
      error: "后台 worker 文件不存在",
      errorKind: "environment",
      errorHint: "请重新安装或重新加载 Raycast 扩展，然后再试。",
      finishedAt: timestamp,
      updatedAt: timestamp,
    };
    writeTaskSafely(task.statePath, failedState);
    return task;
  }

  const failToStart = (message: string) => {
    const timestamp = new Date().toISOString();
    writeTaskSafely(task.statePath, {
      ...baseState,
      status: "failure",
      phase: "finished",
      pid: null,
      error: "后台 worker 启动失败",
      errorKind: "environment",
      errorHint: message,
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
  };

  try {
    const child = spawn(process.execPath, [workerPath, task.statePath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: `${HOMEBREW_BIN}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    child.once("error", (error) => failToStart(error.message));
    child.unref();
  } catch (error) {
    failToStart(error instanceof Error ? error.message : String(error));
  }

  return task;
}

export function retryTask(task: TaskRecord): TaskRecord {
  return enqueueTask(
    {
      mode: task.mode,
      outputDir: task.outputDir,
      subtitles: task.subtitles,
      cookies: task.cookies,
    },
    task.url,
    {
      attempt: (task.attempt ?? 1) + 1,
      retryOf: task.id,
    },
  );
}

function writeTaskSafely(statePath: string, state: TaskState): void {
  try {
    writeTaskState(statePath, state);
  } catch {
    // The worker will surface an unreadable/unchanged state as interrupted after its startup timeout.
  }
}
