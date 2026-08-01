import { Action, ActionPanel, Detail, Icon, List, showToast, Toast } from "@raycast/api";
import { homedir } from "node:os";
import { useEffect, useState } from "react";
import { retryTask } from "./task-runner";
import {
  listTaskStates,
  readTaskAppState,
  type TaskErrorKind,
  type TaskRecord,
  type TaskStatus,
  writeTaskAppState,
  writeTaskState,
} from "./task-store";

const QUEUED_START_TIMEOUT_MS = 30_000;

function isProcessAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function displayTask(task: TaskRecord): TaskRecord {
  const isStaleQueued =
    task.status === "queued" &&
    task.pid === null &&
    Date.now() - new Date(task.createdAt).getTime() > QUEUED_START_TIMEOUT_MS;
  if (isStaleQueued || (task.status === "queued" && task.pid !== null && !isProcessAlive(task.pid))) {
    return {
      ...task,
      status: "interrupted",
      phase: "finished",
      pid: null,
      error: task.error ?? "后台 worker 未能启动",
      errorKind: task.errorKind ?? "interrupted",
      errorHint: task.errorHint ?? "任务没有在 30 秒内启动，点击“重试任务”重新排队。",
    };
  }
  if (task.status === "running" && task.pid !== null && !isProcessAlive(task.pid)) {
    return {
      ...task,
      phase: "finished",
      status: "interrupted",
      pid: null,
      error: task.error ?? "后台 worker 已退出，任务未完成",
      errorKind: task.errorKind ?? "interrupted",
      errorHint: task.errorHint ?? "后台进程已退出，点击“重试任务”继续下载。",
    };
  }
  if (task.status === "running" && task.pid === null && Date.now() - new Date(task.updatedAt).getTime() > QUEUED_START_TIMEOUT_MS) {
    return {
      ...task,
      status: "interrupted",
      phase: "finished",
      error: task.error ?? "任务没有可用的后台进程",
      errorKind: task.errorKind ?? "interrupted",
      errorHint: task.errorHint ?? "任务状态已停止更新，点击“重试任务”重新排队。",
    };
  }
  return task;
}

function statusLabel(task: TaskRecord): string {
  if (task.status === "queued") return task.phase === "waiting" ? "排队中" : "等待启动";
  if (task.status === "running") {
    if (task.phase === "preflight") return "检查环境中";
    if (task.phase === "extracting") return "解析中";
    if (task.phase === "post-processing") return "合并/转码中";
    return task.percent === null ? "下载中" : `下载中 · ${task.percent.toFixed(1)}%`;
  }
  if (task.status === "success") return "已完成";
  if (task.status === "cancelled") return "已取消";
  if (task.status === "interrupted") return "已中断";
  return task.error ? `失败 · ${task.error}` : "失败";
}

function statusIcon(status: TaskStatus): Icon {
  if (status === "queued") return Icon.Hourglass;
  if (status === "running") return Icon.CircleProgress;
  if (status === "success") return Icon.Checkmark;
  if (status === "cancelled") return Icon.Stop;
  if (status === "interrupted") return Icon.Bolt;
  return Icon.XMarkCircle;
}

function renderLog(lines: string[]): string {
  const visible = lines.slice(-120).join("\n").replaceAll("```", "``\\`");
  return visible ? `\n\n\`\`\`text\n${visible}\n\`\`\`` : "";
}

function errorKindLabel(kind?: TaskErrorKind): string {
  if (kind === "invalid_input") return "链接/参数";
  if (kind === "authentication") return "登录/Cookies";
  if (kind === "unavailable") return "媒体不可用";
  if (kind === "network") return "网络/代理";
  if (kind === "rate_limited") return "站点限流";
  if (kind === "storage") return "目录/磁盘";
  if (kind === "ffmpeg") return "ffmpeg 后处理";
  if (kind === "environment") return "本机环境";
  if (kind === "cancelled") return "用户取消";
  if (kind === "interrupted") return "后台进程";
  return "未知原因";
}

function taskMarkdown(task: TaskRecord): string {
  const error = task.error
    ? `\n\n> **原因：${errorKindLabel(task.errorKind)}**\n> ${task.error}\n\n> **建议：** ${task.errorHint ?? "查看日志最后一行后重试。"}`
    : "";
  const attempt = task.attempt && task.attempt > 1 ? `\n\n第 ${task.attempt} 次尝试` : "";
  const output = task.outputPath ? `\n\n输出文件：\`${task.outputPath}\`` : "";
  return `# ${statusLabel(task)}\n\n${task.url}${attempt}${output}${error}${renderLog(task.lines)}`;
}

function stateWithoutPath(task: TaskRecord) {
  const { statePath: _statePath, ...state } = task;
  return state;
}

function completedAt(task: TaskRecord): number {
  return task.finishedAt ? new Date(task.finishedAt).getTime() : 0;
}

function openTarget(task: TaskRecord): string {
  return task.outputPath ?? task.outputDir;
}

function completionSubtitle(task: TaskRecord): string {
  return task.outputPath ? `已完成 · ${task.outputPath}` : "已完成 · 文件路径暂未识别，可打开下载目录";
}

function cancelTask(task: TaskRecord): void {
  if (task.status === "queued") {
    const timestamp = new Date().toISOString();
    writeTaskState(task.statePath, {
      ...stateWithoutPath(task),
      status: "cancelled",
      phase: "finished",
      pid: null,
      error: "任务已取消",
      errorKind: "cancelled",
      errorHint: "如果只是暂时中断，可以在任务列表中重试。",
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
    if (task.pid !== null) {
      try {
        process.kill(task.pid, "SIGTERM");
      } catch {
        // The worker may not have started yet; the cancelled state prevents a late start.
      }
    }
    return;
  }

  if (task.status !== "running" || task.pid === null) return;
  try {
    process.kill(task.pid, "SIGTERM");
  } catch {
    writeTaskState(task.statePath, {
      ...stateWithoutPath(task),
      status: "interrupted",
      phase: "finished",
      pid: null,
      error: "Could not reach the background worker",
      errorKind: "interrupted",
      errorHint: "后台进程无法访问，点击“重试任务”重新排队。",
      updatedAt: new Date().toISOString(),
    });
  }
}

export function DownloadTasks() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [completionNotice, setCompletionNotice] = useState<TaskRecord[]>([]);

  const refresh = () => {
    const nextTasks = listTaskStates().map(displayTask);
    const appState = readTaskAppState();
    const completedTasks = nextTasks.filter((task) => task.status === "success");
    const newestCompletedAt = Math.max(0, ...completedTasks.map(completedAt));
    const unseenIds = appState.unseenCompletionIds ?? [];
    const unseenCompletions = completedTasks
      .filter((task) => unseenIds.includes(task.id))
      .sort((left, right) => completedAt(right) - completedAt(left));
    const lastViewedCompletionAt = appState.lastViewedCompletionAt
      ? new Date(appState.lastViewedCompletionAt).getTime()
      : appState.lastSeenCompletionAt
        ? new Date(appState.lastSeenCompletionAt).getTime()
        : null;
    const latestWorkerCompletionAt = appState.lastCompletedAt ? new Date(appState.lastCompletedAt).getTime() : 0;
    const newCompletions =
      unseenCompletions.length > 0
        ? unseenCompletions
        : lastViewedCompletionAt !== null
        ? completedTasks
            .filter((task) => completedAt(task) > lastViewedCompletionAt)
            .sort((left, right) => completedAt(right) - completedAt(left))
        : latestWorkerCompletionAt > 0
          ? completedTasks
              .filter((task) => completedAt(task) >= latestWorkerCompletionAt - 10 * 60 * 1000)
              .sort((left, right) => completedAt(right) - completedAt(left))
          : [];
    if (newCompletions.length > 0) {
      setCompletionNotice(newCompletions);
      const newestCompletion = newCompletions[0];
      if (newestCompletion.finishedAt) {
        writeTaskAppState({
          ...appState,
          unseenCompletionIds: unseenIds.filter((id) => !newCompletions.some((task) => task.id === id)),
          lastViewedCompletionAt: newestCompletion.finishedAt,
        });
      }
    } else if (lastViewedCompletionAt === null && newestCompletedAt > 0) {
      writeTaskAppState({ ...appState, lastViewedCompletionAt: new Date(newestCompletedAt).toISOString() });
    }
    setTasks(nextTasks);
    setIsLoading(false);
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, []);

  const activeTasks = tasks.filter((task) => task.status === "queued" || task.status === "running");
  const historyTasks = tasks.filter((task) => !activeTasks.includes(task));

  const handleCancel = (task: TaskRecord) => {
    cancelTask(task);
    void showToast({ style: Toast.Style.Success, title: "Cancellation requested" });
    setTimeout(refresh, 300);
  };

  const handleRetry = (task: TaskRecord) => {
    retryTask(task);
    void showToast({ style: Toast.Style.Success, title: "任务已重新排队", message: "新任务会出现在列表顶部" });
    refresh();
  };

  return (
    <List
      isLoading={isLoading}
      navigationTitle={`Download Tasks · ${activeTasks.length} active`}
      searchBarPlaceholder="Filter downloads"
      actions={
        <ActionPanel>
          <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={refresh} />
          <Action.Open
            title="Open Download Folder"
            target={tasks[0]?.outputDir ?? `${homedir()}/Downloads/yt-dlp`}
            icon={Icon.Folder}
          />
        </ActionPanel>
      }
    >
      {tasks.length === 0 ? (
        <List.EmptyView title="No download tasks" description="Start a download from the yt-dlp command." icon={Icon.Download} />
      ) : (
        <>
          {completionNotice.length > 0 && (
            <List.Section title={`✅ 刚刚完成 · ${completionNotice.length}`}>
              {completionNotice.map((task) => (
                <CompletedTaskItem key={task.id} task={task} />
              ))}
            </List.Section>
          )}
          {activeTasks.length > 0 && (
            <List.Section title={`进行中 · ${activeTasks.length}`}>
              {activeTasks.map((task) => (
                <TaskListItem key={task.id} task={task} isActive onCancel={() => handleCancel(task)} onRetry={() => handleRetry(task)} />
              ))}
            </List.Section>
          )}
          {historyTasks.length > 0 && (
            <List.Section title={`历史 · ${historyTasks.length}`}>
              {historyTasks.map((task) => (
                <TaskListItem key={task.id} task={task} onCancel={() => handleCancel(task)} onRetry={() => handleRetry(task)} />
              ))}
            </List.Section>
          )}
        </>
      )}
    </List>
  );
}

function CompletedTaskItem({ task }: { task: TaskRecord }) {
  return (
    <List.Item
      title={task.url}
      subtitle={completionSubtitle(task)}
      icon={Icon.Checkmark}
      accessories={[{ text: "已完成" }]}
      actions={
        <ActionPanel>
          <Action.Open
            title="Open Downloaded File"
            target={openTarget(task)}
            icon={Icon.ArrowRight}
            shortcut={{ modifiers: ["cmd"], key: "o" }}
          />
          <Action.ShowInFinder
            title="Show Download in Finder"
            path={openTarget(task)}
            shortcut={{ modifiers: ["cmd", "shift"], key: "o" }}
          />
          <Action.Open title="Open Download Folder" target={task.outputDir} icon={Icon.Folder} />
          <Action.CopyToClipboard title="Copy Downloaded File Path" content={task.outputPath ?? task.outputDir} />
        </ActionPanel>
      }
    />
  );
}

function TaskListItem({
  task,
  isActive = false,
  onCancel,
  onRetry,
}: {
  task: TaskRecord;
  isActive?: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const progress = task.status === "running" && task.percent !== null ? `${task.percent.toFixed(1)}%` : statusLabel(task);
  const subtitle = task.errorHint
    ? `${statusLabel(task)} · ${task.errorHint}`
    : task.error && task.status !== "failure"
      ? `${statusLabel(task)} · ${task.error}`
      : statusLabel(task);

  return (
    <List.Item
      title={task.url}
      subtitle={subtitle}
      icon={statusIcon(task.status)}
      accessories={[{ text: progress }]}
      actions={
        <ActionPanel>
          <Action.Push title="View Log" icon={Icon.Document} target={<Detail markdown={taskMarkdown(task)} />} />
          {isActive && (
            <Action title="Cancel Task" icon={Icon.Stop} style={Action.Style.Destructive} onAction={onCancel} />
          )}
          {(task.status === "failure" || task.status === "cancelled" || task.status === "interrupted") && (
            <Action title="Retry Task" icon={Icon.ArrowClockwise} onAction={onRetry} />
          )}
          {task.status === "success" && (
            <Action.Open
              title="Open Downloaded File"
              target={openTarget(task)}
              icon={Icon.ArrowRight}
              shortcut={{ modifiers: ["cmd"], key: "o" }}
            />
          )}
          <Action.Open
            title="Open Download Folder"
            target={task.outputDir}
            icon={Icon.Folder}
            shortcut={{ modifiers: ["cmd", "shift"], key: "o" }}
          />
          <Action.ShowInFinder title="Show Folder in Finder" path={task.outputDir} />
          <Action.CopyToClipboard title="Copy Task Log" content={task.lines.join("\n")} />
        </ActionPanel>
      }
    />
  );
}
