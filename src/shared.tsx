import {
  Action,
  ActionPanel,
  Clipboard,
  Form,
  Icon,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { FormValidation, useForm } from "@raycast/utils";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { useEffect, useState } from "react";
import { DownloadTasks } from "./task-ui";
import { enqueueTask, type CookieSource, type DownloadJob, type DownloadMode } from "./task-runner";
import { listTaskStates, readTaskAppState, writeTaskAppState } from "./task-store";

const YTDLP_PATH = "/opt/homebrew/bin/yt-dlp";
const DEFAULT_OUTPUT_DIR = join(homedir(), "Downloads", "yt-dlp");

export interface DownloadFormValues {
  urls: string;
  mode: string;
  outputDir: string;
  subtitles: boolean;
  cookies: string;
}

function extractUrls(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//i.test(item));
}

function expandPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_OUTPUT_DIR;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function getUnseenCompletionText(): string | null {
  const appState = readTaskAppState();
  if (appState.unseenCompletionIds && appState.unseenCompletionIds.length > 0) {
    const unseenCount = listTaskStates().filter(
      (task) => task.status === "success" && appState.unseenCompletionIds?.includes(task.id),
    ).length;
    if (unseenCount > 0) {
      return unseenCount === 1
        ? "✅ 有 1 个下载任务刚刚完成 · 打开 Download Tasks 查看"
        : `✅ 有 ${unseenCount} 个下载任务刚刚完成 · 打开 Download Tasks 查看`;
    }
  }
  const lastViewedAt = appState.lastViewedCompletionAt
    ? new Date(appState.lastViewedCompletionAt).getTime()
    : appState.lastSeenCompletionAt
      ? new Date(appState.lastSeenCompletionAt).getTime()
      : appState.lastCompletedAt
        ? new Date(appState.lastCompletedAt).getTime() - 10 * 60 * 1000
        : 0;
  const completed = listTaskStates()
    .filter((task) => task.status === "success" && task.finishedAt && new Date(task.finishedAt).getTime() > lastViewedAt)
    .sort((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""));
  if (completed.length === 0) return null;
  return completed.length === 1
    ? "✅ 有 1 个下载任务刚刚完成 · 打开 Download Tasks 查看"
    : `✅ 有 ${completed.length} 个下载任务刚刚完成 · 打开 Download Tasks 查看`;
}

export function DownloadForm() {
  const navigation = useNavigation();
  const [completionNotice, setCompletionNotice] = useState<string | null>(null);
  const { handleSubmit, itemProps, setValue } = useForm<DownloadFormValues>({
    initialValues: {
      urls: "",
      mode: "mp4",
      outputDir: DEFAULT_OUTPUT_DIR,
      subtitles: false,
      cookies: "none",
    },
    validation: {
      urls: (value) => (extractUrls(value ?? "").length > 0 ? undefined : "Paste at least one http(s) URL"),
      outputDir: FormValidation.Required,
    },
    onSubmit(values) {
      const urls = extractUrls(values.urls);
      if (urls.length === 0) return;
      const inputCount = values.urls.split(/\s+/).filter(Boolean).length;

      const job: DownloadJob = {
        mode: values.mode as DownloadMode,
        outputDir: expandPath(values.outputDir),
        subtitles: values.subtitles,
        cookies: values.cookies as CookieSource,
      };
      urls.forEach((url) => enqueueTask(job, url));
      void showToast({
        style: Toast.Style.Success,
        title: `${urls.length} task${urls.length === 1 ? "" : "s"} queued`,
        message:
          inputCount > urls.length
            ? `${inputCount - urls.length} invalid item${inputCount - urls.length === 1 ? "" : "s"} skipped · Download Tasks 查看状态`
            : "You can close Raycast; use Download Tasks to monitor them",
      });

      navigation.push(<DownloadTasks />);
    },
  });

  useEffect(() => {
    setCompletionNotice(getUnseenCompletionText());
  }, []);

  const openCompletionTasks = () => {
    const appState = readTaskAppState();
    writeTaskAppState({ ...appState, lastViewedCompletionAt: new Date().toISOString(), unseenCompletionIds: [] });
    setCompletionNotice(null);
    navigation.push(<DownloadTasks />);
  };

  const pasteFromClipboard = async () => {
    const text = await Clipboard.readText();
    const urls = extractUrls(text ?? "");
    if (urls.length === 0) {
      void showToast({ style: Toast.Style.Failure, title: "剪贴板里没有 http(s) URL" });
      return;
    }
    setValue("urls", urls.join("\n"));
    void showToast({ style: Toast.Style.Success, title: `已粘贴 ${urls.length} 个 URL` });
  };

  return (
    <Form
      enableDrafts
      actions={
        <ActionPanel>
          <Action title="Paste URL(s) from Clipboard" icon={Icon.Clipboard} onAction={() => void pasteFromClipboard()} />
          {completionNotice && (
            <Action title="View Completed Downloads" icon={Icon.Checkmark} onAction={openCompletionTasks} />
          )}
          <Action.SubmitForm title="Start Download" onSubmit={handleSubmit} icon={Icon.Download} />
        </ActionPanel>
      }
    >
      {completionNotice && <Form.Description title="Download update" text={completionNotice} />}
      <Form.TextArea
        title="URL"
        placeholder="Paste one or more video URLs, one per line"
        autoFocus
        storeValue
        {...itemProps.urls}
      />
      <Form.Dropdown title="Mode" storeValue {...itemProps.mode}>
        <Form.Dropdown.Item value="mp4" title="MP4 · best available quality" />
        <Form.Dropdown.Item value="video" title="Video · keep best available format" />
        <Form.Dropdown.Item value="audio" title="MP3 · extract audio" />
      </Form.Dropdown>
      <Form.TextField title="Output Folder" placeholder={DEFAULT_OUTPUT_DIR} storeValue {...itemProps.outputDir} />
      <Form.Checkbox
        title="Subtitles"
        label="Download Chinese/English subtitles when available"
        storeValue
        {...itemProps.subtitles}
      />
      <Form.Dropdown title="Browser Cookies" storeValue {...itemProps.cookies}>
        <Form.Dropdown.Item value="none" title="Do not use browser login" />
        <Form.Dropdown.Item value="chrome" title="Chrome login" />
        <Form.Dropdown.Item value="safari" title="Safari login" />
        <Form.Dropdown.Item value="firefox" title="Firefox login" />
      </Form.Dropdown>
      <Form.Description
        title="When to use Cookies"
        text="For X, Instagram, or other sites that hide media unless you are logged in. Cookies stay on this Mac."
      />
      <Form.Description title="Runtime" text={`${YTDLP_PATH} + ffmpeg`} />
    </Form>
  );
}
