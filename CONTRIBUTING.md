# Contributing

Thanks for helping improve the Raycast download console.

## Scope

Please keep changes focused on the local macOS workflow:

- Raycast commands and task-list interactions
- detached worker lifecycle and failure recovery
- yt-dlp/ffmpeg integration
- documentation and reproducible validation

Do not include browser profiles, Cookies, downloaded media, task state, or machine-specific absolute paths in commits or issue reports.

## Development

```bash
npm install
npm run dev
npm run build
```

Before opening a pull request, describe the user-visible change and include the command output for the checks you ran.
