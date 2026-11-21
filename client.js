window.__ModuleLoader__.load({
  id: 'dsh-session-bell',
  factory(require) {
    const React = require('react')

    const ROUTE_PATH = '/session-bell/events'
    const STORAGE_KEY = 'dsh-session-bell:settings:v1'
    const STYLE_ID = 'dsh-session-bell-settings'
    const NS = 'session-bell'
    const RETRY_MS = 3000
    const BODY_LIMIT = 80
    const WORD_BREAK_LOOKBACK = 20

    // The banner is raised by the page, so the platform that matters is the one
    // that renders it: a hosted `dsh web` page can be open on another machine.
    const PLATFORM = detectPlatform()
    // The Desktop page raises the banner as DeepSeek Harness; a browser page
    // raises it as that browser, so the system notification settings list the
    // browser instead. Name the sender the user will actually find there.
    const DESKTOP_PAGE = typeof location !== 'undefined' && location.protocol === 'dsh-app:'
    const HINT_KEY = {
      macos: DESKTOP_PAGE ? 'permissionHintMac' : 'permissionHintBrowserMac',
      windows: DESKTOP_PAGE ? 'permissionHintWindows' : 'permissionHintBrowserWindows',
    }[PLATFORM] ?? (DESKTOP_PAGE ? 'permissionHintOther' : 'permissionHintBrowserOther')

    function detectPlatform() {
      if (typeof navigator === 'undefined') return 'other'
      const declared = navigator.userAgentData?.platform
      if (declared === 'Windows') return 'windows'
      if (declared === 'macOS') return 'macos'
      if (declared !== undefined && declared !== '' && declared !== 'Unknown') return 'other'
      const agent = typeof navigator.userAgent === 'string' ? navigator.userAgent : ''
      // iOS and iPadOS render "like Mac OS X" in the user agent; iPadOS in
      // desktop mode is indistinguishable from macOS except for its touch points.
      if (/iphone|ipad|ipod/iu.test(agent)) return 'other'
      if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return 'other'
      if (/windows/iu.test(agent)) return 'windows'
      if (/macintosh|mac os x/iu.test(agent)) return 'macos'
      return 'other'
    }

    const DEFAULTS = Object.freeze({
      turnEnd: true,
      question: true,
      approval: true,
      onlyUnfocused: true,
    })

    const en = {
      nav: 'Notifications',
      title: 'Notifications',
      intro: 'Choose when to interrupt you. Changes apply immediately.',
      turnEnd: 'Turn finished',
      question: 'Question',
      approval: 'Approval',
      onlyUnfocused: 'Only notify while this window is in the background',
      permissionGranted: 'Browser notifications are allowed',
      permissionDenied: 'Browser notifications are denied',
      permissionDefault: 'Browser notifications are not enabled',
      permissionUnsupported: 'Browser notifications are not available here',
      deniedHint: 'Allow notifications for this page in the browser.',
      permissionHintMac: 'No banner? Check System Settings → Notifications → DeepSeek Harness.',
      permissionHintWindows: 'No banner? Allow DeepSeek Harness in Settings → System → Notifications.',
      permissionHintOther: 'No banner? Allow DeepSeek Harness in the system notification settings.',
      permissionHintBrowserMac: 'No banner? Allow your browser in System Settings → Notifications.',
      permissionHintBrowserWindows: 'No banner? Allow your browser in Settings → System → Notifications.',
      permissionHintBrowserOther: 'No banner? Allow your browser in the system notification settings.',
      request: 'Request permission',
      requestAgain: 'Request again',
      test: 'Send test',
      testTitle: 'Session notifications',
      testBody: 'This is a test notification.',
      bodyTurnEnd: 'Turn finished',
      bodyQuestion: 'Your answer is needed',
      bodyApproval: 'Your approval is needed',
      bodyApprovalTool: 'Approval needed: {tool}',
      bodyApprovalReason: 'Approval needed: {tool} — {reason}',
      bodyError: 'Generation failed: {message}',
      bodyErrorBare: 'Generation failed',
      bodyMaxTokens: 'Output token limit reached',
      bodyGeneric: 'New activity',
      appName: 'DeepSeek Harness',
    }

    const zh = {
      nav: '会话通知',
      title: '通知',
      intro: '只在这些时刻打扰你。修改立即生效。',
      turnEnd: '回合结束',
      question: '提问',
      approval: '审批',
      onlyUnfocused: '仅在窗口处于后台时通知',
      permissionGranted: '浏览器通知已允许',
      permissionDenied: '浏览器通知已被拒绝',
      permissionDefault: '浏览器通知尚未授权',
      permissionUnsupported: '此环境不支持浏览器通知',
      deniedHint: '在浏览器中允许此页面的通知。',
      permissionHintMac: '没有横幅？到 系统设置 → 通知 → DeepSeek Harness 打开。',
      permissionHintWindows: '没有横幅？到 设置 → 系统 → 通知 → DeepSeek Harness 打开。',
      permissionHintOther: '没有横幅？在系统通知设置里允许 DeepSeek Harness 发通知。',
      permissionHintBrowserMac: '没有横幅？在 系统设置 → 通知 里允许你的浏览器发通知。',
      permissionHintBrowserWindows: '没有横幅？在 设置 → 系统 → 通知 里允许你的浏览器发通知。',
      permissionHintBrowserOther: '没有横幅？在系统通知设置里允许当前浏览器发通知。',
      request: '请求权限',
      requestAgain: '重新请求',
      test: '发送测试',
      testTitle: '会话通知',
      testBody: '这是一条测试通知。',
      bodyTurnEnd: '回合已完成',
      bodyQuestion: '需要你回答',
      bodyApproval: '需要你批准',
      bodyApprovalTool: '等待批准：{tool}',
      bodyApprovalReason: '等待批准：{tool} — {reason}',
      bodyError: '生成失败：{message}',
      bodyErrorBare: '生成失败',
      bodyMaxTokens: '已达到输出 token 上限',
      bodyGeneric: '有新动态',
      appName: 'DeepSeek Harness',
    }

    const CSS = `
      .sb-form {
        box-sizing: border-box;
        max-width: 720px;
        color: var(--dsw-alias-label-primary);
        font-family: inherit;
        font-size: 13px;
        line-height: 20px;
      }
      .sb-title {
        margin: 0;
        font-size: 16px;
        line-height: 24px;
        font-weight: 600;
      }
      .sb-intro {
        margin: 4px 0 0;
        font-size: 13px;
        line-height: 20px;
      }
      .sb-list {
        margin-top: 14px;
        overflow: hidden;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1);
      }
      .sb-row {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        width: 100%;
        padding: 12px 14px;
        border: 0;
        border-top: .5px solid var(--dsw-alias-border-l1);
        border-radius: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .sb-row:first-child { border-top: 0; }
      .sb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .sb-row:focus-visible {
        outline: 2px solid var(--dsw-alias-state-business-primary);
        outline-offset: -2px;
      }
      .sb-row-label { font-size: 13px; line-height: 20px; }
      .sb-switch {
        position: relative;
        width: 36px;
        height: 20px;
        flex: none;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2);
        transition: background .15s ease, border-color .15s ease;
      }
      .sb-switch::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 15px;
        height: 15px;
        border-radius: 50%;
        background: var(--dsw-alias-switch-thumb, #fff);
        box-shadow: 0 1px 2px rgb(0 0 0 / 18%);
        transition: transform .15s ease, background .15s ease;
      }
      .sb-row[aria-checked="true"] .sb-switch {
        border-color: var(--dsw-alias-button-primary-fill);
        background: var(--dsw-alias-button-primary-fill);
      }
      .sb-row[aria-checked="true"] .sb-switch::after {
        background: var(--dsw-alias-label-primary-foreground);
        transform: translateX(16px);
      }
      .sb-permission {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 7px;
        min-height: 28px;
        margin-top: 14px;
        font-size: 13px;
        line-height: 20px;
      }
      .sb-dot {
        width: 7px;
        height: 7px;
        flex: none;
        border-radius: 50%;
        background: var(--dsw-alias-label-tertiary);
      }
      .sb-dot-granted { background: var(--dsw-alias-state-success-primary); }
      .sb-dot-denied { background: var(--dsw-alias-state-error-primary); }
      .sb-dot-default { background: var(--dsw-alias-state-warn-label, var(--dsw-alias-label-tertiary)); }
      .sb-link {
        box-sizing: border-box;
        padding: 2px 4px;
        border: 0;
        border-radius: var(--dsw-radius-xs, 4px);
        background: transparent;
        font: inherit;
        text-decoration: underline;
        text-decoration-color: var(--dsw-alias-border-l3);
        text-underline-offset: 3px;
        cursor: pointer;
      }
      .sb-link:hover {
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-interactive-bg-hover);
      }
      .sb-link:focus-visible {
        outline: 2px solid var(--dsw-alias-state-business-primary);
        outline-offset: 1px;
      }
      @media (prefers-reduced-motion: reduce) {
        .sb-switch, .sb-switch::after { transition: none; }
      }
    `

    function normalizeSettings(value) {
      const next = { ...DEFAULTS }
      if (value === null || typeof value !== 'object') return next
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof value[key] === 'boolean') next[key] = value[key]
      }
      return next
    }

    function readSettings() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        return raw === null ? { ...DEFAULTS } : normalizeSettings(JSON.parse(raw))
      } catch {
        return { ...DEFAULTS }
      }
    }

    const store = {
      value: readSettings(),
      listeners: new Set(),
      getSnapshot() {
        return store.value
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
      emit() {
        for (const listener of [...store.listeners]) {
          try {
            listener()
          } catch {
            // A UI subscriber must not stop persistence.
          }
        }
      },
      set(patch) {
        store.value = normalizeSettings({ ...store.value, ...patch })
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store.value))
        } catch {
          // Keep the in-memory value when storage is unavailable.
        }
        store.emit()
      },
      reload() {
        const next = readSettings()
        if (JSON.stringify(next) === JSON.stringify(store.value)) return
        store.value = next
        store.emit()
      },
    }

    function notificationSupported() {
      return typeof Notification !== 'undefined'
    }

    function currentPermission() {
      if (!notificationSupported()) return 'unsupported'
      return Notification.permission ?? 'default'
    }

    const permission = {
      value: currentPermission(),
      listeners: new Set(),
      getSnapshot() {
        return permission.value
      },
      subscribe(listener) {
        permission.listeners.add(listener)
        return () => permission.listeners.delete(listener)
      },
      refresh() {
        const next = currentPermission()
        if (next === permission.value) return
        permission.value = next
        for (const listener of [...permission.listeners]) {
          try {
            listener()
          } catch {
            // Keep the permission state authoritative.
          }
        }
      },
    }

    async function requestPermission() {
      if (!notificationSupported()) return 'unsupported'
      if (typeof Notification.requestPermission !== 'function') return currentPermission()
      let result
      try {
        result = await Notification.requestPermission()
      } catch {
        // The browser may refuse the request without a gesture.
        result = currentPermission()
      }
      permission.refresh()
      return result ?? currentPermission()
    }

    function approvalReason(payload, locale) {
      const meta = payload.meta ?? {}
      const localized = meta.displayReason
      if (localized !== null && typeof localized === 'object' && !Array.isArray(localized)) {
        const keys = [locale, typeof locale === 'string' ? locale.split('-')[0] : '', 'en']
        for (const key of keys) {
          if (typeof key !== 'string' || key === '') continue
          const value = localized[key]
          if (typeof value === 'string' && value !== '') return value
        }
      }
      return typeof meta.reason === 'string' ? meta.reason : ''
    }

    function fallbackBody(payload, t, locale) {
      if (payload.kind === 'question') return t('bodyQuestion')
      if (payload.kind === 'approval') {
        const tool = typeof payload.meta?.toolName === 'string' ? payload.meta.toolName : ''
        const reason = approvalReason(payload, locale)
        if (tool !== '' && reason !== '') return t('bodyApprovalReason', { tool, reason })
        if (tool !== '') return t('bodyApprovalTool', { tool })
        return t('bodyApproval')
      }
      if (payload.kind === 'turn-end') {
        if (payload.meta?.status === 'error') {
          const message = typeof payload.meta.error === 'string' ? payload.meta.error : ''
          return message !== '' ? t('bodyError', { message }) : t('bodyErrorBare')
        }
        if (payload.meta?.status === 'max-tokens') return t('bodyMaxTokens')
        return t('bodyTurnEnd')
      }
      return t('bodyGeneric')
    }

    const isAlnum = char => char !== undefined && /[A-Za-z0-9]/u.test(char)

    // The Host already clips its own text; a composed body needs the same cap,
    // and the same rule: do not split an English word at the boundary.
    function clipBody(body) {
      const chars = Array.from(body)
      if (chars.length <= BODY_LIMIT) return body
      let end = BODY_LIMIT - 1
      if (isAlnum(chars[end - 1]) && isAlnum(chars[end])) {
        let back = end
        while (back > 0 && end - back < WORD_BREAK_LOOKBACK && isAlnum(chars[back - 1])) back -= 1
        if (back > 0 && /\s/u.test(chars[back - 1])) end = back - 1
      }
      while (end > 0 && /\s/u.test(chars[end - 1])) end -= 1
      return `${chars.slice(0, Math.max(1, end)).join('')}…`
    }

    /**
     * One banner per Session: the tag carries the Session only, so a newer
     * event replaces the previous banner whatever its kind. It cannot be the
     * raw Session id: Chromium builds the Windows toast tag as
     * `n#<origin>#<tag>`, that wrapper takes 16 characters for
     * `dsh-app://app`, and Windows silently drops a toast whose tag is longer
     * than 64 characters. A 32-bit FNV-1a hash of the Session id is at most
     * seven base-36 characters, which leaves room for any origin.
     */
    function tagOf(sessionId) {
      let hash = 0x811c9dc5
      for (let index = 0; index < sessionId.length; index += 1) {
        hash = Math.imul(hash ^ sessionId.charCodeAt(index), 0x01000193) >>> 0
      }
      return hash.toString(36)
    }

    function isWindowFocused() {
      return typeof document !== 'undefined'
        && document.visibilityState === 'visible'
        && typeof document.hasFocus === 'function'
        && document.hasFocus()
    }

    async function sendTest(t) {
      if (!notificationSupported()) return
      const state = currentPermission() === 'granted'
        ? 'granted'
        : await requestPermission()
      if (state !== 'granted') return
      try {
        const test = new Notification(t('testTitle'), {
          body: t('testBody'),
          tag: 'session-bell:test',
        })
        test.onclick = () => test.close()
      } catch {
        // A notification can fail if the platform revokes permission.
      }
    }

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.append(style)
      return () => style.remove()
    }

    function SwitchRow({ label, checked, onChange }) {
      return React.createElement('button', {
        type: 'button',
        className: 'sb-row',
        role: 'switch',
        'aria-checked': checked,
        onClick: () => onChange(!checked),
      },
        React.createElement('span', { className: 'sb-row-label' }, label),
        React.createElement('span', { className: 'sb-switch', 'aria-hidden': 'true' }),
      )
    }

    function SettingsForm({ t, locale }) {
      const settings = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const permissionState = React.useSyncExternalStore(permission.subscribe, permission.getSnapshot, permission.getSnapshot)

      // The bound translator reads the active locale at call time; this
      // subscription only makes the form re-render when that locale changes.
      React.useSyncExternalStore(
        (listener) => locale.subscribe(listener),
        () => locale.getSnapshot().revision,
        () => locale.getSnapshot().revision,
      )

      function change(key, value) {
        store.set({ [key]: value })
        // Ask from the click that turns notifications on: Safari ignores a
        // permission request without a user gesture, and a denial is sticky.
        if (value && key !== 'onlyUnfocused' && currentPermission() === 'default') {
          void requestPermission()
        }
      }

      function row(key, label) {
        return React.createElement(SwitchRow, {
          key,
          label,
          checked: settings[key],
          onChange: (value) => change(key, value),
        })
      }

      let permissionNode
      if (permissionState === 'unsupported') {
        permissionNode = React.createElement('div', { className: 'sb-permission' },
          React.createElement('span', { className: 'sb-dot sb-dot-default' }),
          React.createElement('span', null, t('permissionUnsupported')),
        )
      } else if (permissionState === 'granted') {
        permissionNode = React.createElement('div', { className: 'sb-permission' },
          React.createElement('span', { className: 'sb-dot sb-dot-granted' }),
          React.createElement('span', null, t('permissionGranted')),
          React.createElement('button', {
            type: 'button',
            className: 'sb-link',
            onClick: () => { void sendTest(t) },
          }, t('test')),
          React.createElement('span', null, t(HINT_KEY)),
        )
      } else if (permissionState === 'denied') {
        permissionNode = React.createElement('div', { className: 'sb-permission' },
          React.createElement('span', { className: 'sb-dot sb-dot-denied' }),
          React.createElement('span', null, t('permissionDenied')),
          React.createElement('button', {
            type: 'button',
            className: 'sb-link',
            onClick: () => { void requestPermission() },
          }, t('requestAgain')),
          React.createElement('span', null, t('deniedHint')),
        )
      } else {
        permissionNode = React.createElement('div', { className: 'sb-permission' },
          React.createElement('span', { className: 'sb-dot sb-dot-default' }),
          React.createElement('span', null, t('permissionDefault')),
          React.createElement('button', {
            type: 'button',
            className: 'sb-link',
            onClick: () => { void requestPermission() },
          }, t('request')),
          React.createElement('span', null, t(HINT_KEY)),
        )
      }

      return React.createElement('section', { className: 'sb-form', 'aria-label': t('title') },
        React.createElement('h2', { className: 'sb-title' }, t('title')),
        React.createElement('p', { className: 'sb-intro' }, t('intro')),
        React.createElement('div', { className: 'sb-list' },
          row('turnEnd', t('turnEnd')),
          row('question', t('question')),
          row('approval', t('approval')),
          row('onlyUnfocused', t('onlyUnfocused')),
        ),
        permissionNode,
      )
    }

    function makeSettingsPage(t, locale) {
      return function SettingsPage({ view }) {
        if (view === 'summary') return null
        return React.createElement(SettingsForm, { t, locale })
      }
    }

    return {
      inject: ['uiWorkspace', 'slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        permission.refresh()
        let warned = false
        // The banners this page raised, by Session tag. A newer event for the
        // same Session closes the previous one, so a Session never stacks two.
        const banners = new Map()

        const open = (sessionId) => {
          window.focus()
          try {
            ctx.uiWorkspace.openSession(sessionId)
          } catch (error) {
            console.error('[session-bell] cannot open the session', error)
          }
        }

        const show = (payload) => {
          if (payload === null || typeof payload !== 'object') return
          if (typeof payload.sessionId !== 'string') return
          if (!notificationSupported()) return
          if (Notification.permission !== 'granted') {
            if (Notification.permission === 'denied' && !warned) {
              warned = true
              console.warn('[session-bell] notifications are denied for DeepSeek Harness')
            }
            return
          }

          const settings = store.getSnapshot()
          let enabled
          if (payload.kind === 'turn-end') enabled = settings.turnEnd
          else if (payload.kind === 'question') enabled = settings.question
          else if (payload.kind === 'approval') enabled = settings.approval
          else return
          if (!enabled) return
          if (settings.onlyUnfocused && isWindowFocused()) return

          const body = clipBody(typeof payload.body === 'string' && payload.body !== ''
            ? payload.body
            : fallbackBody(payload, t, ctx.locale.getSnapshot?.()?.active))
          const title = typeof payload.title === 'string' && payload.title !== ''
            ? payload.title
            : t('appName')
          const tag = tagOf(payload.sessionId)

          const previous = banners.get(tag)
          if (previous !== undefined) {
            banners.delete(tag)
            previous.close()
          }

          let notification
          try {
            notification = new Notification(title, {
              body,
              tag,
            })
          } catch (error) {
            console.error('[session-bell] cannot show the notification', error)
            return
          }
          banners.set(tag, notification)
          notification.onclose = () => {
            if (banners.get(tag) === notification) banners.delete(tag)
          }
          notification.onclick = () => {
            open(payload.sessionId)
            notification.close()
            if (banners.get(tag) === notification) banners.delete(tag)
          }
        }

        ctx.effect(() => ctx.locale.register(NS, { en, zh }))
        ctx.effect(installStyles)

        ctx.effect(() => {
          const refresh = () => permission.refresh()
          window.addEventListener('focus', refresh)
          document.addEventListener('visibilitychange', refresh)
          return () => {
            window.removeEventListener('focus', refresh)
            document.removeEventListener('visibilitychange', refresh)
          }
        })

        ctx.effect(() => {
          const onStorage = (event) => {
            if (event.key === STORAGE_KEY || event.key === null) store.reload()
          }
          window.addEventListener('storage', onStorage)
          return () => window.removeEventListener('storage', onStorage)
        })

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'session-bell',
          order: 20,
          label: () => t('nav'),
          locale: NS,
        }, makeSettingsPage(t, ctx.locale))))

        ctx.effect(() => {
          let source = null
          let timer = null
          let disposed = false

          const closeStream = () => {
            if (source === null) return
            source.onmessage = null
            source.onerror = null
            source.close()
            source = null
          }

          const retry = () => {
            if (disposed || timer !== null) return
            timer = setTimeout(() => {
              timer = null
              connect()
            }, RETRY_MS)
          }

          const connect = () => {
            if (disposed) return
            closeStream()
            let next
            try {
              next = new EventSource(ROUTE_PATH)
            } catch (error) {
              // No constructor means this surface cannot subscribe at all; a
              // retry cannot fix that.
              console.warn('[session-bell] cannot subscribe to events', error)
              return
            }
            source = next
            next.onmessage = (event) => {
              try {
                show(JSON.parse(event.data))
              } catch {
                // A malformed frame must not close the stream.
              }
            }
            // A dropped connection is the browser's retry job. A permanently
            // closed stream is not: the first answer was not an event stream, for
            // example while the Host was starting or before the route was
            // registered. Reopen it here, otherwise this window stays silent for
            // its whole life.
            next.onerror = () => {
              if (next.readyState !== EventSource.CLOSED) return
              closeStream()
              retry()
            }
          }

          connect()

          return () => {
            disposed = true
            if (timer !== null) clearTimeout(timer)
            timer = null
            closeStream()
          }
        })
      },
    }
  },
})
