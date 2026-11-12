# dsh-session-bell

Desktop notifications for DeepSeek Harness.

A turn that finishes, or a question that waits for your answer, raises one native
notification. The sender is DeepSeek Harness itself, not a helper app. A click
opens the Session that raised it.

## What it does

| Event | Notification |
| --- | --- |
| A turn stops (`agent/turn-stopping`) | Session title, then the last assistant text |
| A question waits for a human (`user-questions/request`) | Session title, then the question |

- Every Session reports. Subagent Sessions stay quiet; their parent turn still reports.
- Notifications are keyed by Session, so a new one replaces the older banner of the same Session.
- Click: focus the window, then select that Session in the Conversation panel.

## Requirements

- DeepSeek Harness with the Web GUI (Desktop app or `dsh web`).
- The window must be open. The page raises the notification, so a closed window sends nothing.
- macOS must allow notifications for DeepSeek Harness. If the first banner never shows,
  open System Settings → Notifications → DeepSeek Harness and enable it.

## Install

In DeepSeek Harness, open Settings → Plugins, choose Install bundle, and enter:

```
dsh-session-bell
```

After the first install, reload the page once (⇧⌘R). The Host half is live at
install time, but the page half is a browser module and loads only with a fresh page.

## How it works

Two halves, one route.

1. Host half (`index.js`) listens to `agent/turn-stopping` and `user-questions/request`.
   It turns each event into a Server-Sent Event on `/session-bell/events`.
   No Web server means no route and no work, so the CLI stays silent.
2. Page half (`client.js`) subscribes to that route, calls the page's own
   `Notification` constructor, and on click calls `ctx.uiWorkspace.openSession(sessionId)`.

The route carries Session id, title, a clipped body, and the event kind. Nothing else
leaves the machine; there is no network egress and no configuration file.

## Local development

```bash
npm install
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
| `client.js` | Page half: notification, click to open the Session |
| `cordis.patch.yml` | Bundle patch that inserts the Host row |
| `locale/*.json` | Plugin Manager title and description |
| `icon.svg` | Plugin Manager icon |

## License

MIT
