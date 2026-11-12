# Changelog

## 0.2.2 - 2026-11-12

### Fixes

- The background-only switch now applies to every notification kind. Question
  and approval events no longer raise a banner while the window is focused. The
  switch is a normal row and reads "Only notify while this window is in the
  background".
- The settings section label is "Notifications". The longer label was clipped in
  the settings sidebar.
- All settings text uses one size and color. Removed the storage note.

## 0.2.1 - 2026-11-12

### Fixes

- The Plugin Manager description names a desktop notification instead of a macOS
  notification. The page uses the browser Notification API, so the text no longer
  claims one platform.

## 0.2.0 - 2026-11-12

### Features

- A Session notifications section in More → Settings, with switches for turn
  end, question, and approval. Changes apply immediately and are stored per
  browser in localStorage.
- Approval notifications. The notification carries the tool name only, not the
  command or reason.
- Turn-end notifications stay quiet while the window is focused by default. Turn
  off “Only notify turn-end when this window is in the background” to restore a
  notification for every turn end.
- Browser notification permission status and a Send test action in the settings
  page. The status is the page permission, not the macOS permission.

### Changes

- Subagent Sessions stay quiet for turn-end, question, and approval events; their
  parent turn still reports.
- Notification tags include the event kind, so a question does not replace a
  turn-end banner for the same Session.
- Empty notification bodies are localized in the page.
- Open Server-Sent Event streams close when the plugin unloads.
- The switches moved from the plugin row configuration to a dedicated Session
  notifications settings section.
- The page registers its settings entry before subscribing to events, so an
  unavailable EventSource no longer hides the settings page.
- The Host registers the event route when the Web server service becomes
  available, so a late `webServer` no longer leaves `/session-bell/events`
  unregistered.
- Question and approval listeners run before the Web Remote bridge. Without this
  order, the bridge can answer the request and skip the notification listener.
- The Host requires the sessions service and stays silent for unknown Session ids.
  An unknown Session cannot bypass the subagent filter.
- Approval tool names are clipped to the same limit as notification bodies.
- After an update, reload the page and toggle the plugin once. The Host half and
  the page half must come from the same version.

## 0.1.0 - 2026-11-12

### Features

- Native notification when a turn finishes, raised by DeepSeek Harness itself.
- Native notification when a question waits for an answer.
- Click opens the Session that raised the notification.
- Subagent Sessions stay quiet; their parent turn still reports.
- One Server-Sent Events route carries Session id, title, clipped body, and kind.
