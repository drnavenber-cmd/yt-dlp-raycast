"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const statePath = process.argv[2];
if (!statePath) process.exit(2);

const YTDLP_PATH = "/opt/homebrew/bin/yt-dlp";
const FFMPEG_PATH = "/opt/homebrew/bin/ffmpeg";
const HOMEBREW_BIN = "/opt/homebrew/bin";
const MAX_CONCURRENT_DOWNLOADS = 3;
const MIN_FREE_BYTES = 50 * 1024 * 1024;

let state;
let child = null;
let slotPath = null;
let cancelled = false;
let finalized = false;
let stateWriteError = null;
let stdoutBuffer = "";
let stderrBuffer = "";

try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch (error) {
  process.exitCode = 2;
  process.stderr.write(`Could not read task state: ${String(error)}\n`);
  process.exit();
}

function now() {
  return new Date().toISOString();
}

function writeState(patch) {
  state = { ...state, ...patch, updatedAt: now() };
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    stateWriteError = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not persist task state: ${stateWriteError}\n`);
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // There is no useful recovery if the filesystem cannot accept the state file.
    }
    if (child && child.exitCode === null && !cancelled) child.kill("SIGTERM");
  }
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function phaseForLine(line) {
  if (/\[download\]\s+\d+(?:\.\d+)?%/i.test(line)) return "downloading";
  if (/merging formats|post-process|postprocessing|extractaudio|ffmpeg/i.test(line)) return "post-processing";
  if (/extracting|downloading webpage|downloading api json|downloading .*json|loading/i.test(line)) return "extracting";
  return undefined;
}

function outputPathFromLine(line) {
  const plainPath = line.trim();
  if (path.isAbsolute(plainPath) && (fs.existsSync(plainPath) || /\.[a-z0-9]{2,5}$/i.test(plainPath))) {
    return { path: plainPath, priority: 4 };
  }
  const merger = line.match(/\[Merger\].*?into:?\s+["']?(.+?)["']?\s*$/i);
  if (merger) return { path: normalizeOutputPath(merger[1].trim()), priority: 3 };
  const audio = line.match(/\[ExtractAudio\].*?Destination:\s+["']?(.+?)["']?\s*$/i);
  if (audio) return { path: normalizeOutputPath(audio[1].trim()), priority: 3 };
  const destination = line.match(/\[download\]\s+Destination:\s+["']?(.+?)["']?\s*$/i);
  if (destination) return { path: normalizeOutputPath(destination[1].trim()), priority: 1 };
  return null;
}

function normalizeOutputPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(state.outputDir, value);
}

function appendLines(lines, percent) {
  if (!lines.length && percent === undefined) return;
  const phase = [...lines].reverse().map(phaseForLine).find(Boolean);
  const output = lines
    .map(outputPathFromLine)
    .filter(Boolean)
    .sort((left, right) => right.priority - left.priority)[0];
  writeState({
    lines: [...(Array.isArray(state.lines) ? state.lines : []), ...lines].slice(-160),
    ...(percent === undefined ? {} : { percent }),
    ...(phase ? { phase } : {}),
    ...(output ? { outputPath: output.path } : {}),
    lastActivityAt: now(),
  });
}

function consumeChunk(chunk, stream) {
  if (stream === "stdout") stdoutBuffer += chunk.toString();
  else stderrBuffer += chunk.toString();

  const buffer = stream === "stdout" ? stdoutBuffer : stderrBuffer;
  const complete = buffer.split(/\r?\n|\r/);
  if (stream === "stdout") stdoutBuffer = complete.pop() || "";
  else stderrBuffer = complete.pop() || "";

  const lines = complete
    .map((line) => stripAnsi(line).trimEnd())
    .filter(Boolean);
  const lastProgress = [...lines].reverse().find((line) => /\[download\]\s+\d+(?:\.\d+)?%/i.test(line));
  const match = lastProgress && lastProgress.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
  appendLines(lines, match ? Number(match[1]) : undefined);
}

function flushBuffers() {
  const lines = [stdoutBuffer, stderrBuffer]
    .map((line) => stripAnsi(line).trimEnd())
    .filter(Boolean);
  stdoutBuffer = "";
  stderrBuffer = "";
  appendLines(lines);
}

function buildArguments() {
  const args = [
    "--newline",
    "--no-playlist",
    "--continue",
    "--no-overwrites",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--retry-sleep",
    "1",
    "--socket-timeout",
    "30",
    "--ffmpeg-location",
    FFMPEG_PATH,
    "-P",
    state.outputDir,
    "-o",
    "%(title)s.%(ext)s",
    "--print",
    "after_move:%(filepath)s",
  ];

  if (state.mode === "audio") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else if (state.mode === "mp4") {
    args.push("-f", "bv*+ba/b", "--merge-output-format", "mp4");
  } else {
    args.push("-f", "bv*+ba/b");
  }

  if (state.subtitles) {
    args.push("--write-subs", "--sub-langs", "zh-Hans,zh,en", "--sub-format", "vtt");
  }

  if (state.cookies && state.cookies !== "none") {
    args.push("--cookies-from-browser", state.cookies);
  }

  args.push(state.url);
  return args;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function slotsDirectory() {
  return path.join(path.dirname(path.dirname(statePath)), "slots");
}

function removeStaleSlot(candidatePath) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(candidatePath, "owner.json"), "utf8"));
    if (pidAlive(owner.pid)) return;
  } catch {
    // An unreadable owner file cannot represent a live worker.
  }
  try {
    fs.rmSync(candidatePath, { recursive: true, force: true });
  } catch {
    // Another worker may have cleaned it first.
  }
}

function tryAcquireSlot() {
  const directory = slotsDirectory();
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 1; index <= MAX_CONCURRENT_DOWNLOADS; index += 1) {
    const candidatePath = path.join(directory, `slot-${index}`);
    try {
      fs.mkdirSync(candidatePath);
      fs.writeFileSync(path.join(candidatePath, "owner.json"), JSON.stringify({ pid: process.pid, statePath }), "utf8");
      return candidatePath;
    } catch (error) {
      if (error && error.code === "EEXIST") removeStaleSlot(candidatePath);
    }
  }
  return null;
}

function releaseSlot() {
  if (!slotPath) return;
  try {
    fs.rmSync(slotPath, { recursive: true, force: true });
  } catch {
    // A later worker can remove a stale slot after this process exits.
  }
  slotPath = null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function wasExternallyCancelled() {
  try {
    const latest = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return latest.status === "cancelled";
  } catch {
    return false;
  }
}

async function waitForSlot() {
  if (wasExternallyCancelled()) {
    cancelled = true;
    return false;
  }
  writeState({ status: "queued", phase: "waiting", pid: process.pid, lastActivityAt: now() });
  while (!cancelled) {
    if (wasExternallyCancelled()) {
      cancelled = true;
      return false;
    }
    slotPath = tryAcquireSlot();
    if (slotPath) return true;
    await sleep(1000);
  }
  return false;
}

function assertExecutable(filePath, label) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
  } catch {
    const error = new Error(`${label} 不存在或不可执行：${filePath}`);
    error.kind = "environment";
    error.hint = label === "yt-dlp" ? "请在终端运行 brew install yt-dlp，或确认 Homebrew 路径未变化。" : "请安装或修复 ffmpeg，然后重试。";
    throw error;
  }
}

function runPreflight() {
  if (typeof state.url !== "string") {
    const error = new Error("任务没有有效 URL");
    error.kind = "invalid_input";
    error.hint = "回到下载表单，粘贴完整的 http(s) 链接。";
    throw error;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(state.url);
  } catch {
    const error = new Error("URL 格式无效");
    error.kind = "invalid_input";
    error.hint = "回到下载表单，粘贴完整的 http(s) 链接。";
    throw error;
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    const error = new Error("只支持 http(s) URL");
    error.kind = "invalid_input";
    error.hint = "请使用以 http:// 或 https:// 开头的网页链接。";
    throw error;
  }

  if (!["video", "mp4", "audio"].includes(state.mode)) {
    const error = new Error(`不支持的下载模式：${String(state.mode)}`);
    error.kind = "invalid_input";
    error.hint = "重新提交任务并选择 MP4、视频或 MP3。";
    throw error;
  }

  assertExecutable(YTDLP_PATH, "yt-dlp");
  assertExecutable(FFMPEG_PATH, "ffmpeg");

  if (typeof state.outputDir !== "string" || !state.outputDir.trim()) {
    const error = new Error("输出目录为空");
    error.kind = "storage";
    error.hint = "重新提交任务并填写可写的下载目录。";
    throw error;
  }

  try {
    fs.mkdirSync(state.outputDir, { recursive: true });
    const directoryInfo = fs.statSync(state.outputDir);
    if (!directoryInfo.isDirectory()) {
      const error = new Error("输出路径不是文件夹");
      error.kind = "storage";
      error.hint = "选择一个文件夹作为输出目录。";
      throw error;
    }

    const probePath = path.join(state.outputDir, `.yt-dlp-raycast-write-test-${process.pid}`);
    fs.writeFileSync(probePath, "ok", "utf8");
    fs.unlinkSync(probePath);

    if (typeof fs.statfsSync === "function") {
      const stats = fs.statfsSync(state.outputDir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(freeBytes) && freeBytes < MIN_FREE_BYTES) {
        const error = new Error("磁盘可用空间低于 50 MB");
        error.kind = "storage";
        error.hint = "清理磁盘空间后再重试；下载文件大小无法在开始前准确预测。";
        throw error;
      }
    }
  } catch (error) {
    if (error.kind) throw error;
    const storageError = new Error(`输出目录检查失败：${error.message || String(error)}`);
    storageError.kind = "storage";
    storageError.hint = "检查输出目录权限和磁盘剩余空间，然后重试。";
    throw storageError;
  }
}

function classifyFailure(lines, code, signal) {
  const text = lines.join("\n").toLowerCase();
  if (/no space left|permission denied|read-only file system|not a directory|disk full/.test(text)) {
    return { kind: "storage", error: "输出目录不可写或磁盘空间不足", hint: "检查输出目录权限和磁盘剩余空间，然后重试。" };
  }
  if (/ffmpeg|ffprobe|postprocessing|post-process|extractaudio/.test(text)) {
    return { kind: "ffmpeg", error: "ffmpeg 后处理失败", hint: "确认 ffmpeg 可执行；也可以改用“视频”模式再试。" };
  }
  if (/too many requests|http error 429|rate.?limit|temporarily blocked/.test(text)) {
    return { kind: "rate_limited", error: "站点限流或暂时封锁请求", hint: "稍后重试，减少同时下载数量，必要时使用已登录浏览器 Cookies。" };
  }
  if (/no video could be found|video(?:\s+#\d+)?\s+unavailable|video unavailable|deleted|not available|geo.?restricted/.test(text)) {
    return { kind: "unavailable", error: "链接中的媒体不可用或站点不支持", hint: "确认原帖仍公开可见，尝试原帖链接，不要使用失效的 /video/1 变体。" };
  }
  if (/sign in|log in|login|authentication|cookies?\b|guest token|private video|members-only|age.?restricted|confirm you('re| are) not a bot/.test(text)) {
    return { kind: "authentication", error: "站点要求登录或 Cookies 不可用", hint: "在表单里选择已登录的 Chrome、Safari 或 Firefox；只读取本机 Cookies。" };
  }
  if (/timed out|timeout|unable to connect|connection|network|proxy|dns|temporary failure|tls|ssl|http error 5\d\d/.test(text)) {
    return { kind: "network", error: "网络、代理或站点连接失败", hint: "检查网络和代理后重试；任务已保留，不需要重新粘贴 URL。" };
  }
  if (/unsupported url|invalid url|url .*invalid/.test(text)) {
    return { kind: "invalid_input", error: "URL 无效或不受支持", hint: "粘贴完整的 http(s) 页面链接，然后重试。" };
  }
  return {
    kind: "unknown",
    error: `yt-dlp 下载失败（${signal ? signal : `退出码 ${code ?? "未知"}`}）`,
    hint: "打开任务日志查看最后一条错误；如果是临时问题，可以直接重试。",
  };
}

function finishFailure(kind, error, hint) {
  if (finalized) return;
  finalized = true;
  releaseSlot();
  writeState({
    status: "failure",
    phase: "finished",
    pid: null,
    error,
    errorKind: kind,
    errorHint: hint,
    finishedAt: now(),
  });
  process.exitCode = 1;
}

function finishSuccess() {
  if (finalized) return;
  finalized = true;
  releaseSlot();
  writeState({
    status: "success",
    phase: "finished",
    percent: 100,
    pid: null,
    outputPath: resolveOutputPath(),
    finishedAt: now(),
  });
  recordCompletion();
  process.exitCode = 0;
}

function recordCompletion() {
  const appStatePath = path.join(path.dirname(path.dirname(path.dirname(statePath))), "app-state.json");
  const temporaryPath = `${appStatePath}.${process.pid}.tmp`;
  try {
    let appState = {};
    try {
      appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
    } catch {
      // The first completed task creates the app state file.
    }
    appState.lastCompletedAt = now();
    appState.unseenCompletionIds = [...new Set([...(appState.unseenCompletionIds || []), state.id])].slice(-100);
    fs.writeFileSync(temporaryPath, `${JSON.stringify(appState, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, appStatePath);
  } catch {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // The task itself is complete even if the optional reminder marker cannot be saved.
    }
  }
}

function resolveOutputPath() {
  if (typeof state.outputPath === "string" && fs.existsSync(state.outputPath)) return state.outputPath;
  try {
    const taskStartTime = new Date(state.startedAt || state.createdAt).getTime() - 1000;
    const candidates = fs
      .readdirSync(state.outputDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.endsWith(".part") && !entry.name.endsWith(".ytdl"))
      .map((entry) => {
        const fullPath = path.join(state.outputDir, entry.name);
        return { fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .filter((entry) => entry.mtime >= taskStartTime)
      .sort((left, right) => right.mtime - left.mtime);
    return candidates[0]?.fullPath;
  } catch {
    return state.outputPath;
  }
}

function markCancelled() {
  if (finalized) return;
  cancelled = true;
  if (child && child.exitCode === null) child.kill("SIGTERM");
  finalized = true;
  releaseSlot();
  writeState({
    status: "cancelled",
    phase: "finished",
    pid: null,
    error: "任务已取消",
    errorKind: "cancelled",
    errorHint: "如果只是暂时中断，可以在任务列表中重试；已下载的临时文件会按 yt-dlp 规则续传。",
    finishedAt: now(),
  });
  process.exitCode = 143;
}

process.on("SIGTERM", markCancelled);
process.on("SIGINT", markCancelled);

if (["success", "failure", "cancelled"].includes(state.status)) process.exit(0);

const heartbeat = setInterval(() => {
  if (!finalized) writeState({ lastActivityAt: now() });
}, 5000);
heartbeat.unref();

(async () => {
  try {
    if (!(await waitForSlot())) return;
    writeState({ status: "running", phase: "preflight", pid: process.pid, startedAt: now(), error: undefined, errorKind: undefined, errorHint: undefined });
    try {
      runPreflight();
    } catch (error) {
      const kind = error.kind || "environment";
      const message = error instanceof Error ? error.message : String(error);
      const hint = error.hint || "打开任务日志查看具体原因，然后重试。";
      appendLines([`[preflight] ${message}`]);
      finishFailure(kind, message, hint);
      return;
    }

    writeState({ phase: "extracting", lastActivityAt: now() });
    child = spawn(YTDLP_PATH, buildArguments(), {
      cwd: state.outputDir,
      env: {
        ...process.env,
        PATH: `${HOMEBREW_BIN}:${process.env.PATH || "/usr/bin:/bin"}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => consumeChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk) => consumeChunk(chunk, "stderr"));
    child.once("error", (error) => {
      if (cancelled || finalized) return;
      appendLines([`[worker] Could not start yt-dlp: ${error.message}`]);
      finishFailure("environment", "yt-dlp 启动失败", "确认 /opt/homebrew/bin/yt-dlp 存在且可执行，然后重试。");
    });
    child.once("close", (code, signal) => {
      flushBuffers();
      if (cancelled || finalized) return;
      const lines = Array.isArray(state.lines) ? state.lines : [];
      if (code === 0) {
        finishSuccess();
        return;
      }
      const classified = classifyFailure(lines, code, signal);
      finishFailure(classified.kind, classified.error, classified.hint);
    });
  } catch (error) {
    if (cancelled || finalized) return;
    const message = stateWriteError ? `任务状态无法保存：${stateWriteError}` : String(error);
    finishFailure(stateWriteError ? "storage" : "environment", message, stateWriteError ? "检查任务目录和磁盘权限；如果磁盘已满，先清理空间。" : "检查 yt-dlp、ffmpeg 和输出目录后重试。");
  }
})();
