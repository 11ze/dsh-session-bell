# Changelog

## 0.3.0 - 2026-11-21

### Features

- Turn-end notifications now distinguish how the turn ended. A completed turn
  keeps the last reply's first sentence, a failed turn shows the failure text,
  and a turn that hits the output limit says so. Aborted, interrupted, and
  blocked turns stay silent.
- A completed turn waits 1.5 seconds before notifying. If a subagent or a
  background job still runs for the same Session, or the next round of an active
  goal is already queued, the notification is dropped; a team lead's intermediate
  round is no longer reported as the team's result. An active goal with no queued
  round still notifies, so a disabled goal driver cannot silence a Session. A
  failing activity query, a missing provider, or a missing goal service never
  silences a notification.
- Approval notifications carry DSH's reason as well as the tool name, so the
  banner says what the approval is for. A localized `displayReason` is preferred
  and the raw `reason` is the fallback.
- The reply body is taken from the last assistant text block instead of every
  text block, keeps the first sentence including a polite opening such as
  `好的，`, falls back to the whole reply when the first sentence is shorter than
  12 characters, and clips at a word boundary.

### Fixes

- A running schedule is not treated as work in progress. DSH reports every
  enabled schedule, so treating it as blocking would keep a recurring Session
  silent forever; a schedule that starts a turn cancels the pending notification
  through `turn/start` instead.
## 0.2.11 - 2026-11-20

### Fixes

- Notification titles stop at 30 characters. DSH already caps a fallback title
  at 40 bytes and a renamed or LLM-written title at 80 bytes, which is longer
  than a banner's title line. The Host now collapses the title's whitespace and
  clips it with an ellipsis, the same way it already clipped the body at 80
  characters, and falls back to the app name when the title is blank or not a
  string. README.md and README.zh.md document the title budget.
- The page no longer asks for notification permission on load. It asks when the
  user turns on a notification switch or clicks Send test, so the request
  follows a user gesture. Safari may ignore a request without one, and a denial
  is sticky.
- README.md and README.zh.md note that the route inherits the web server's
  binding and has no authentication of its own.

## 0.2.10 - 2026-11-19

### Fixes

- The permission hint names the sender the system actually lists. A `dsh web`
  page runs in a browser, so the operating system attributes its notifications
  to that browser: System Settings names Chrome or Safari, not DeepSeek Harness,
  and the hint sent web users to an entry that does not exist. The page now
  treats the Desktop origin `dsh-app:` as the app sender and every other origin
  as browser mode; a browser page points at the browser instead. README.md,
  README.zh.md, and the Plugin Manager description qualify the sender and the
  system permission the same way.

### Changes

- Tests also run on pull requests and on Node 20, 22, and 24. The publish
  workflow waits for that matrix before publishing.

## 0.2.9 - 2026-11-19

### Fixes

- Notification titles name the Session again. Every banner showed the app name
  `DeepSeek Harness` instead, because the host half read `ctx.sessionTitle` once
  during `apply`: that service injects more than the session store, so it can
  become active after this plugin, and the captured handle stayed `undefined`
  for the life of the process. The title is now read per notification, and the
  app name remains the fallback when no title service is mounted. A missing
  title service logs one debug line instead of staying silent; the fallback was
  otherwise indistinguishable from a real title.

## 0.2.8 - 2026-11-19

### Fixes

- A turn-end body no longer stops at an English title or a Latin abbreviation.
  `Dr. Smith pushed the fix.` reached the banner as `Dr.` because the sentence
  rule saw a capital letter after the stop. Titles (`Dr.`, `Mr.`, `Prof.`),
  Latin forms (`e.g.`, `i.e.`, `etc.`, `vs.`), dotted forms (`U.S.`, `U.K.`,
  `Ph.D.`) and a few similar forms (`approx.`, `Bros.`, `Esq.`) now read on to
  the real end, including when a Chinese word follows the stop, as in
  `由 Dr. 王 负责。`. An ordinary short word still ends the sentence, so
  `He said no. Then we left.` keeps `He said no.`. The price is the other
  direction: an abbreviation that really does end a sentence now carries the
  next one along, as in `He finished his Ph.D. Then he moved.`, still under the
  80-character limit.

## 0.2.7 - 2026-11-18

### Fixes

- Notification bodies read as plain text. A native notification does not draw
  Markdown, so a reply that ended in a table reached the banner as
  `**改动** | 文件 | 内容 | | --- | --- |` with backticks and pipes. The host half
  now drops tables, code fences, links and emphasis marks, unwraps inline code,
  keeps the first sentence of a turn-end reply, and clips the body to 80
  characters instead of 140. A question is not cut at a sentence, but the same
  limit applies. A reply with nothing left falls back to the localized label,
  as before.

## 0.2.6 - 2026-11-17

### Changes

- One banner per Session. A newer event for a Session closes that Session's
  previous banner, whatever its kind, so a question no longer stacks on the
  turn-end banner of the same Session. The tag is now the Session hash alone;
  it previously carried the event kind. The page closes the previous banner
  itself instead of waiting for the operating system to replace it by tag.

## 0.2.5 - 2026-11-16

### Fixes

- Real notifications reach Windows at all. The page used the raw
  `<sessionId>:<kind>` pair as the notification tag, which is 53 characters for
  a Session id. Chromium builds the Windows toast tag as `n#<origin>#<tag>` — 16
  more characters for the desktop origin `dsh-app://app` — and Windows silently
  drops a toast whose tag exceeds 64 characters, with no constructor error and
  nothing in the console. The tag is now a short hash of the Session id plus the
  kind: still one tag per Session and kind, at most 16 characters, so every
  origin fits. Send test was never affected because its tag is 17 characters,
  which is why the failure looked like "test works, real turns do not".

## 0.2.4 - 2026-11-16

### Fixes

- The page half reopens `/session-bell/events` three seconds after the browser
  permanently closes the stream (`readyState` CLOSED). Before this change the
  page opened the stream once at load and never reopened it, so a stream that
  failed once left the window silent for the rest of its life: Send test still
  worked, but real turns, questions, and approvals raised nothing. Observed on
  the Windows Desktop app.

## 0.2.3 - 2026-11-16

### Features

- The notification permission hint names the settings path of the system that
  renders the page: System Settings → Notifications on macOS, Settings → System →
  Notifications on Windows, and the generic system notification settings on any
  other system. Before this change the hint named the macOS path only.

### Changes

- README.md links to the Simplified Chinese README and stays the English default.

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
