# dsh-session-bell

English | [简体中文](README.zh.md)

Desktop notifications for DeepSeek Harness.

A turn that finishes, a question that waits for your answer, or an approval that
waits for your decision raises one native notification. The sender is DeepSeek
Harness itself, not a helper app. A click opens the Session that raised it.

![A test notification from DeepSeek Harness](assets/screenshot-notification.png)

## What it does

| Event | Notification |
| --- | --- |
| A turn stops (`agent/turn-stopping`) | Session title, then the last assistant text |
| A question waits for a human (`user-questions/request`) | Session title, then the question |
| An approval waits for a human (`approval/request`) | Session title, then the tool name |

- Every root Session can report. Subagent Sessions stay quiet for all three
  events; their parent turn still reports.
- Notifications are keyed by Session: a newer event for a Session closes that
  Session's previous banner, whatever its kind.
- Click: focus the window, then select that Session in the Conversation panel.

## Settings

Open More → Settings, then choose Notifications in the settings sidebar.

![Notifications in More → Settings](assets/screenshot-settings.png)

| Switch | What it does |
| --- | --- |
| Turn finished | Notify when a turn stops. |
| Question | Notify when a question waits for an answer. |
| Approval | Notify when an approval waits for a decision. |
| Only notify while this window is in the background | When on, a focused window shows no notifications. When off, every event notifies. Default on. |

Switches apply immediately; there is no save button. Settings are stored locally
in the app (localStorage), not in the app configuration. The section shows
the browser notification permission and a Send test action. This is the page
permission, not the operating system permission. The hint gives the path of the
system that renders the page: System Settings → Notifications on macOS, Settings
→ System → Notifications on Windows, and the system notification settings
elsewhere. If no banner appears, allow DeepSeek Harness to send notifications
there.

Approval notifications appear only when the session asks for approval. A session
whose approval policy never asks sends no approval notification.

## Requirements

- DeepSeek Harness with the Web GUI (Desktop app or `dsh web`).
- The window must be open. The page raises the notification, so a closed window sends nothing.
- The operating system must allow notifications for DeepSeek Harness. On macOS,
  open System Settings → Notifications. On Windows, open Settings → System →
  Notifications.

## Install

In DeepSeek Harness, open the Plugins page from the sidebar, choose Install
bundle, and enter:

```
dsh-session-bell
```

After the first install, reload the page once (⇧⌘R). The Host half is live at
install time, but the page half is a browser module and loads only with a fresh page.
After an update, reload the page and toggle the plugin once. The Host half and the
page half must come from the same version.

## How it works

Two halves, one route.

1. Host half (`index.js`) listens to `agent/turn-stopping`,
   `user-questions/request`, and `approval/request`. It turns each event into a
   Server-Sent Event on `/session-bell/events`. For approval it sends the tool
   name only, not the command or reason. No Web server means no route and no
   work, so the CLI stays silent.
2. Page half (`client.js`) subscribes to that route, filters events by the
   switches, suppresses notifications while the window is focused, and calls the
   page's own `Notification` constructor. A newer event for the same Session
   closes that Session's previous banner first. On click it calls
   `ctx.uiWorkspace.openSession(sessionId)`. Empty bodies are localized in the
   page. When the browser permanently closes the stream (`readyState` CLOSED),
   the page opens a new one after 3 seconds, so a Host that starts late does not
   leave the window silent for good.

The route carries Session id, title, a clipped body, the event kind, and for
approval the tool name. Settings stay in localStorage. Nothing leaves the
machine; there is no network egress.

## Local development

```bash
npm install
npm test
```

Link the directory as a bundle, then toggle the plugin once to reload the Host half
and reload the page for the Client half:

```
plugin_manager install_bundle  <absolute path to this directory>
plugin_manager set_plugin      include:session-bell  enabled:false
plugin_manager set_plugin      include:session-bell  enabled:true
```

Reload the page after changing `client.js`. Reload the plugin after changing `index.js`.

## Releasing

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) publishes on every push to
`main`, but only when `package.json` names a version that npm does not have yet. It uses npm
trusted publishing (OIDC), so the repository stores no token, and it attaches provenance.

1. Bump the version and add the CHANGELOG entry.
2. Push to `main`.

```bash
npm version patch          # or minor, major
git push --follow-tags
```

One setup step lives on npmjs.com: Settings → Trusted publishing must name this repository
and the workflow file `publish.yml`. Without it the job fails with `ENEEDAUTH`.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | Host half: events to Server-Sent Events |
| `client.js` | Page half: settings page, notification, click to open the Session |
| `cordis.patch.yml` | Bundle patch that inserts the Host row |
| `locale/*.json` | Plugin Manager title and description |
| `icon.svg` | Plugin Manager icon |
| `test/` | Node tests for Host events and client filtering |

## License

MIT
