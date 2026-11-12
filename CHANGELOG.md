# Changelog

## 1.0.0 - 2026-11-12

### Features

- Native notification when a turn finishes, raised by DeepSeek Harness itself.
- Native notification when a question waits for an answer.
- Click opens the Session that raised the notification.
- Subagent Sessions stay quiet; their parent turn still reports.
- One Server-Sent Events route carries Session id, title, clipped body, and kind.
