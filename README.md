# yt-dlp Download for Raycast

一个只在本机运行的 Raycast Extension，用于调用 Homebrew 安装的 `yt-dlp`。

## 当前命令

- **Download with Yt-Dlp**：唯一的下载入口。输入一个或多个 URL，选择 MP4、视频或 MP3；在 Action 面板中也可以一键从剪贴板粘贴 URL。
- **Download Tasks**：查看所有进行中、已完成、失败、取消和中断的任务。

每个 URL 都会启动独立的后台 worker，并把状态保存在本机。关闭 Raycast 后任务继续运行；重新打开 **Download Tasks** 可以查看进度、日志和任务是否被中断。

下载完成后，下一次唤起下载入口会显示本地完成提示；打开 **Download Tasks** 时，刚完成的任务会置顶。已完成任务支持直接打开文件、打开下载目录、在 Finder 中显示和复制文件路径。快捷键为 `⌘O` 打开文件，`⌘⇧O` 打开所在目录。

任务列表会把失败分成几类，并给出下一步建议：链接/参数、媒体不可用、登录/Cookies、网络/代理、站点限流、输出目录/磁盘、ffmpeg、本机环境和后台进程。每个失败、取消或中断的任务都可以直接 **Retry Task**，重试会创建新的尝试记录，原任务日志仍保留。

下载前会检查 URL、yt-dlp、ffmpeg、输出目录可写性和最低磁盘空间；下载过程中默认最多同时运行 3 个任务，其余显示为“排队中”。yt-dlp 本身也会对网络请求和分片做有限次数重试。任务超过 30 秒仍没有启动，列表会标记为“已中断”，不会一直假装在下载。

对 X、Instagram 等需要登录才能看到媒体的站点，可以在表单中选择已登录的浏览器。扩展只在本机把浏览器 Cookies 传给本机的 yt-dlp，不上传到云端。

默认调用：

- yt-dlp：`/opt/homebrew/bin/yt-dlp`
- ffmpeg：`/opt/homebrew/bin/ffmpeg`
- 下载目录：`~/Downloads/yt-dlp`

## 开发

```bash
npm install
npm run dev
```

开发模式会把扩展加载到 Raycast 中。构建检查：

```bash
npm run build
```

提交前可检查公开内容：

```bash
rg -n "(/Users/|token|password|secret|Cookies|task state|downloaded media)" --glob '!node_modules/**' --glob '!dist/**' --glob '!package-lock.json' .
```

## 作品定位

这是一个面向 macOS 的 Raycast 下载控制台：用 yt-dlp 负责媒体获取，用独立后台 worker 保证关闭 Raycast 后任务仍可继续，用本地任务状态把排队、进度、失败、重试和完成后的文件打开收敛到一个入口。

它解决的不是“再包一层下载命令”，而是命令行下载最容易丢失的控制面：我发起了哪些任务、现在是否仍在运行、为什么失败、是否可以恢复，以及文件完成后在哪里。

公开作品边界：不包含浏览器 Cookies、任务记录或任何账号凭证；依赖本机安装的 yt-dlp 和 ffmpeg；只用于下载你有权保存或处理的内容。

仅下载你有权保存或处理的内容，并遵守来源网站的规则。
