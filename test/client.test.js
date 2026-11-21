import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const STORAGE_KEY = 'dsh-session-bell:settings:v1'

let notifyRender

const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: {
        ...(props ?? {}),
        ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
      },
    }
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    if (typeof notifyRender === 'function') subscribe(notifyRender)
    return getSnapshot()
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
}

function textOf(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return ''
  return textOf(node.props?.children)
}

function resolve(node) {
  if (Array.isArray(node)) return node.map(resolve)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return resolve(node.type(node.props))
  const children = node.props?.children
  return {
    ...node,
    props: {
      ...node.props,
      ...(children === undefined ? {} : { children: resolve(children) }),
    },
  }
}

function switches(tree) {
  const found = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node.props?.role === 'switch') found.push(node)
    walk(node.props?.children)
  }
  walk(tree)
  return found
}

const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UA_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

function fakeClock() {
  let now = 0
  let nextId = 1
  const pending = []
  return {
    setTimeout(handler, delay = 0) {
      const id = nextId
      nextId += 1
      pending.push({ id, at: now + delay, handler })
      return id
    },
    clearTimeout(id) {
      const index = pending.findIndex((entry) => entry.id === id)
      if (index >= 0) pending.splice(index, 1)
    },
    pending: () => pending.length,
    tick(delay) {
      now += delay
      for (const entry of [...pending]) {
        const index = pending.indexOf(entry)
        if (index < 0 || entry.at > now) continue
        pending.splice(index, 1)
        entry.handler()
      }
    },
  }
}

function setup({ permission = 'granted', settings, eventSourceThrows = false, browser, timers, protocol = 'dsh-app:' } = {}) {
  const storage = new Map()
  if (settings !== undefined) storage.set(STORAGE_KEY, JSON.stringify(settings))
  const notifications = []
  const sources = []
  const windowHandlers = new Map()
  let permissionRequests = 0

  class FakeNotification {
    static permission = permission
    static requestPermission = async () => {
      permissionRequests += 1
      return permission
    }
    constructor(title, options) {
      this.title = title
      this.options = options
      this.closeCount = 0
      notifications.push(this)
    }
    close() {
      this.closeCount += 1
      this.closed = true
    }
  }

  class FakeEventSource {
    static CLOSED = 2
    constructor(url) {
      if (eventSourceThrows) throw new Error('EventSource is unavailable')
      this.url = url
      this.readyState = 0
      this.closed = false
      sources.push(this)
    }
    close() {
      this.readyState = FakeEventSource.CLOSED
      this.closed = true
    }
    // A dropped connection stays retryable; EventSource reconnects by itself.
    drop() {
      this.readyState = 0
      if (typeof this.onerror === 'function') this.onerror({})
    }
    // A closed stream is final; the browser never retries it.
    fail() {
      this.readyState = FakeEventSource.CLOSED
      if (typeof this.onerror === 'function') this.onerror({})
    }
  }

  let focused = true
  const styles = []
  const document = {
    visibilityState: 'visible',
    hasFocus: () => focused,
    head: {
      append(style) {
        styles.push(style)
      },
    },
    createElement() {
      return {
        id: '',
        textContent: '',
        remove() {},
      }
    },
    getElementById(id) {
      return styles.find((style) => style.id === id) ?? null
    },
    addEventListener() {},
    removeEventListener() {},
  }

  const translations = new Map()
  const injected = []
  let loaded
  const sandbox = {
    console: { warn() {}, error() {}, log() {} },
    document,
    location: { protocol },
    Notification: FakeNotification,
    EventSource: FakeEventSource,
    setTimeout: timers?.setTimeout ?? setTimeout,
    clearTimeout: timers?.clearTimeout ?? clearTimeout,
    window: null,
  }
  sandbox.window = sandbox
  if (browser !== undefined) sandbox.navigator = browser
  sandbox.localStorage = {
    getItem(key) {
      return storage.get(key) ?? null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
  }
  sandbox.window.addEventListener = (type, handler) => {
    const handlers = windowHandlers.get(type) ?? []
    handlers.push(handler)
    windowHandlers.set(type, handlers)
  }
  sandbox.window.removeEventListener = (type, handler) => {
    windowHandlers.set(type, (windowHandlers.get(type) ?? []).filter((item) => item !== handler))
  }
  sandbox.window.focus = () => {}
  sandbox.window.__ModuleLoader__ = {
    load(config) {
      loaded = config
    },
  }

  vm.runInNewContext(CLIENT, sandbox, { filename: 'client.js' })
  assert.ok(loaded, 'client module registered')
  const client = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })

  let pageEntry
  let renderedTree
  const rerender = () => {
    assert.ok(pageEntry, 'row config page registered')
    renderedTree = resolve(pageEntry.component({ view: 'page' }))
  }
  let activeLocale = 'zh'
  let dictionaries = {}
  const locale = {
    register(_namespace, dictionary) {
      dictionaries = dictionary
      translations.clear()
      for (const [key, value] of Object.entries(dictionary.zh)) translations.set(key, value)
    },
    bind() {
      return (key, params = {}) => {
        const dictionary = dictionaries[activeLocale] ?? dictionaries.zh ?? {}
        const value = dictionary[key] ?? key
        return value.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '')
      }
    },
    getSnapshot() {
      return { active: activeLocale, revision: 1 }
    },
    subscribe() {
      return () => {}
    },
  }
  const slots = {
    inject(name, run) {
      injected.push(name)
      return run()
    },
    register(options, component) {
      pageEntry = { options, component }
      return () => {}
    },
  }
  const opened = []
  const disposers = []
  client.apply({
    locale,
    slots,
    uiWorkspace: {
      openSession(sessionId) {
        opened.push(sessionId)
      },
    },
    effect(run) {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  })
  notifyRender = rerender

  return {
    storage,
    notifications,
    sources,
    opened,
    injected,
    pageEntry,
    get permissionRequests() {
      return permissionRequests
    },
    setFocused(value) {
      focused = value
    },
    setLocale(value) {
      activeLocale = value
    },
    render() {
      if (renderedTree === undefined) rerender()
      return renderedTree
    },
    send(payload) {
      const open = sources.filter((source) => source.closed !== true)
      assert.ok(open.length > 0, 'event source opened')
      for (const source of open) source.onmessage({ data: JSON.stringify(payload) })
    },
    dispose() {
      for (const dispose of disposers) dispose()
    },
    fireStorage(key) {
      for (const handler of windowHandlers.get('storage') ?? []) handler({ key })
    },
  }
}

test('registers the notification switches as a settings section', () => {
  const page = setup()
  assert.deepEqual(page.injected, ['settings.section'])
  assert.equal(page.pageEntry.options.name, 'settings.section')
  assert.equal(page.pageEntry.options.id, 'session-bell')
  assert.equal(page.pageEntry.options.order, 20)
  assert.equal(page.pageEntry.options.locale, 'session-bell')
  assert.equal(page.pageEntry.options.label(), '会话通知')
  assert.equal(switches(page.render()).length, 4)
})

test('persists a switch immediately', () => {
  const page = setup()
  const first = switches(page.render())
  const turnEnd = first.find((row) => textOf(row) === '回合结束')
  assert.ok(turnEnd)
  turnEnd.props.onClick()
  assert.deepEqual(JSON.parse(page.storage.get(STORAGE_KEY)), {
    turnEnd: false,
    question: true,
    approval: true,
    onlyUnfocused: true,
  })
  const second = switches(page.render())
  assert.equal(second.find((row) => textOf(row) === '回合结束').props['aria-checked'], false)
  assert.equal(second.find((row) => textOf(row) === '仅在窗口处于后台时通知').props['aria-checked'], true)
})

test('an event source failure does not remove the settings page', () => {
  const page = setup({ eventSourceThrows: true })
  assert.equal(page.pageEntry.options.id, 'session-bell')
  assert.equal(switches(page.render()).length, 4)
})

test('turn-end is silent while focused and uses a localized fallback when backgrounded', () => {
  const page = setup()
  page.setFocused(true)
  page.send({ kind: 'turn-end', sessionId: 's1', title: 'Build', body: '' })
  assert.equal(page.notifications.length, 0)
  page.setFocused(false)
  page.send({ kind: 'turn-end', sessionId: 's1', title: 'Build', body: '' })
  assert.equal(page.notifications.length, 1)
  assert.equal(page.notifications[0].title, 'Build')
  assert.equal(page.notifications[0].options.body, '回合已完成')
  assert.equal(page.notifications[0].options.tag, '2b3jk9')
})

test('the toast tag fits the Windows 64-character budget for every origin', () => {
  const sessionId = 'session-8ddbc9d2-b69c-4156-808e-8e4b81fb1614'
  const page = setup()
  page.setFocused(false)
  page.send({ kind: 'turn-end', sessionId, title: 'Build', body: '' })
  assert.equal(page.notifications.length, 1)
  const tag = page.notifications[0].options.tag
  // Chromium builds the Windows toast tag as `n#<origin>#<tag>`, and Windows
  // drops a toast whose tag is longer than 64 characters.
  assert.ok(`n#dsh-app://app#${tag}`.length <= 64, `desktop origin too long: ${tag}`)
  assert.ok(`n#http://127.0.0.1:65535#${tag}`.length <= 64, `loopback origin too long: ${tag}`)
})

test('one Session keeps only its latest banner and another Session keeps its own', () => {
  const page = setup()
  page.setFocused(false)
  page.send({ kind: 'turn-end', sessionId: 'session-1', title: 'One', body: 'Done.' })
  page.send({ kind: 'question', sessionId: 'session-1', title: 'One', body: 'Which?' })
  page.send({ kind: 'turn-end', sessionId: 'session-2', title: 'Two', body: '' })
  assert.equal(page.notifications.length, 3)
  const [first, latest, other] = page.notifications
  assert.equal(first.options.tag, latest.options.tag, 'kinds share one Session banner')
  assert.notEqual(latest.options.tag, other.options.tag, 'another Session keeps its own banner')
  assert.equal(first.closed, true, 'the older banner is closed')
  assert.notEqual(latest.closed, true)
  assert.notEqual(other.closed, true)
})

test('a banner the platform closes is forgotten and not closed again', () => {
  const page = setup()
  page.setFocused(false)
  page.send({ kind: 'turn-end', sessionId: 's1', title: 'Build', body: 'Done.' })
  const first = page.notifications[0]
  first.onclose?.()
  page.send({ kind: 'question', sessionId: 's1', title: 'Build', body: 'Which?' })
  assert.equal(page.notifications.length, 2)
  assert.equal(first.closeCount, 0)
  assert.equal(page.notifications[1].closeCount, 0)
})

test('disabled kinds are filtered and approval uses the tool name', () => {
  const page = setup()
  const question = switches(page.render()).find((row) => textOf(row) === '提问')
  question.props.onClick()
  page.setFocused(false)
  page.send({ kind: 'question', sessionId: 's1', title: 'Build', body: '' })
  assert.equal(page.notifications.length, 0)
  page.send({ kind: 'approval', sessionId: 's1', title: 'Build', body: '', meta: { toolName: 'Bash' } })
  assert.equal(page.notifications.length, 1)
  assert.equal(page.notifications[0].options.body, '等待批准：Bash')
  assert.equal(page.notifications[0].options.tag, '2b3jk9')
})

test('loading the page does not request notification permission', () => {
  const page = setup({ permission: 'default' })
  assert.equal(page.permissionRequests, 0)
})

test('enabling a notification switch requests permission', () => {
  const page = setup({
    permission: 'default',
    settings: { turnEnd: false, question: true, approval: true, onlyUnfocused: true },
  })
  const turnEnd = switches(page.render()).find((row) => textOf(row) === '回合结束')
  assert.ok(turnEnd)
  turnEnd.props.onClick()
  assert.equal(page.permissionRequests, 1)
})

test('turning a notification switch off does not request permission', () => {
  const page = setup({ permission: 'default' })
  const turnEnd = switches(page.render()).find((row) => textOf(row) === '回合结束')
  assert.ok(turnEnd)
  turnEnd.props.onClick()
  assert.equal(page.permissionRequests, 0)
})

test('denied permission suppresses notifications', () => {
  const page = setup({ permission: 'denied' })
  page.setFocused(false)
  page.send({ kind: 'turn-end', sessionId: 's1', title: 'Build', body: '' })
  assert.equal(page.notifications.length, 0)
})

test('turning off background-only lets a focused turn-end notify', () => {
  const page = setup()
  const onlyUnfocused = switches(page.render()).find((row) => textOf(row) === '仅在窗口处于后台时通知')
  onlyUnfocused.props.onClick()
  page.setFocused(true)
  page.send({ kind: 'turn-end', sessionId: 's1', title: 'Build', body: 'Done.' })
  assert.equal(page.notifications.length, 1)
  assert.equal(page.notifications[0].options.body, 'Done.')
})

test('the settings page can raise a test notification', async () => {
  const page = setup()
  const all = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node.props?.type === 'button' && textOf(node) === '发送测试') all.push(node)
    walk(node.props?.children)
  }
  walk(page.render())
  assert.equal(all.length, 1)
  all[0].props.onClick()
  await Promise.resolve()
  assert.equal(page.notifications.length, 1)
  assert.equal(page.notifications[0].options.tag, 'session-bell:test')
})

test('clearing settings in another tab restores the defaults', () => {
  const page = setup({ settings: { turnEnd: false, question: true, approval: true, onlyUnfocused: true } })
  const before = switches(page.render()).find((row) => textOf(row) === '回合结束')
  assert.equal(before.props['aria-checked'], false)
  page.storage.delete(STORAGE_KEY)
  page.fireStorage(null)
  const after = switches(page.render()).find((row) => textOf(row) === '回合结束')
  assert.equal(after.props['aria-checked'], true)
})

test('unknown event kinds are ignored', () => {
  const page = setup()
  page.setFocused(false)
  page.send({ kind: 'future', sessionId: 's1', title: 'Build', body: 'New activity' })
  assert.equal(page.notifications.length, 0)
})

test('permission status names the browser permission and points to system settings', () => {
  const granted = textOf(setup({ browser: { userAgent: UA_MAC } }).render())
  assert.match(granted, /浏览器通知已允许/)
  assert.match(granted, /系统设置/)
  assert.doesNotMatch(granted, /系统通知已允许/)

  const denied = textOf(setup({ permission: 'denied' }).render())
  assert.match(denied, /浏览器通知已被拒绝/)
  assert.match(denied, /在浏览器中允许/)
})

test('the permission hint names the Windows settings path on Windows', () => {
  const text = textOf(setup({ browser: { userAgent: UA_WINDOWS } }).render())
  assert.match(text, /设置 → 系统 → 通知/)
  assert.doesNotMatch(text, /系统设置/)
})

test('the permission hint stays generic on an unknown platform', () => {
  const text = textOf(setup({ browser: { userAgent: UA_LINUX } }).render())
  assert.match(text, /系统通知设置/)
  assert.doesNotMatch(text, /系统设置/)
  assert.doesNotMatch(text, /Windows/)
})

test('the declared platform wins over the user agent', () => {
  const text = textOf(setup({
    browser: { userAgentData: { platform: 'macOS' }, userAgent: UA_WINDOWS },
  }).render())
  assert.match(text, /系统设置 → 通知/)
  assert.doesNotMatch(text, /设置 → 系统/)
})

test('an unknown declared platform falls back to the user agent', () => {
  const text = textOf(setup({
    browser: { userAgentData: { platform: 'Unknown' }, userAgent: UA_WINDOWS },
  }).render())
  assert.match(text, /设置 → 系统 → 通知/)
})

test('the Windows hint follows the declared platform', () => {
  const text = textOf(setup({
    browser: { userAgentData: { platform: 'Windows' }, userAgent: UA_MAC },
  }).render())
  assert.match(text, /设置 → 系统 → 通知/)
  assert.doesNotMatch(text, /系统设置/)
})

test('a declared non-desktop platform stays generic over the user agent', () => {
  const text = textOf(setup({
    browser: { userAgentData: { platform: 'Linux' }, userAgent: UA_WINDOWS },
  }).render())
  assert.match(text, /系统通知设置/)
  assert.doesNotMatch(text, /设置 → 系统/)
})

test('an iPhone user agent stays generic', () => {
  const text = textOf(setup({ browser: { userAgent: UA_IPHONE } }).render())
  assert.match(text, /系统通知设置/)
  assert.doesNotMatch(text, /系统设置/)
})

test('an iPad in desktop mode stays generic', () => {
  const text = textOf(setup({
    browser: { userAgent: UA_MAC, platform: 'MacIntel', maxTouchPoints: 5 },
  }).render())
  assert.match(text, /系统通知设置/)
  assert.doesNotMatch(text, /系统设置/)
})

test('a browser page points the permission hint at the browser, not the app', () => {
  const browserMac = textOf(setup({ browser: { userAgent: UA_MAC }, protocol: 'http:' }).render())
  assert.match(browserMac, /系统设置 → 通知 里允许你的浏览器/)
  assert.doesNotMatch(browserMac, /DeepSeek Harness/)

  const browserWindows = textOf(setup({ browser: { userAgent: UA_WINDOWS }, protocol: 'http:' }).render())
  assert.match(browserWindows, /设置 → 系统 → 通知 里允许你的浏览器/)
  assert.doesNotMatch(browserWindows, /DeepSeek Harness/)

  // The Desktop page keeps the app as the sender: it is the app that raises the banner there.
  const desktop = textOf(setup({ browser: { userAgent: UA_MAC } }).render())
  assert.match(desktop, /系统设置 → 通知 → DeepSeek Harness/)
})

test('a focused window suppresses questions and approvals too', () => {
  const page = setup()
  page.setFocused(true)
  page.send({ kind: 'question', sessionId: 's1', title: 'Build', body: '' })
  page.send({ kind: 'approval', sessionId: 's1', title: 'Build', body: '', meta: { toolName: 'Bash' } })
  assert.equal(page.notifications.length, 0)
  page.setFocused(false)
  page.send({ kind: 'question', sessionId: 's1', title: 'Build', body: '' })
  page.send({ kind: 'approval', sessionId: 's1', title: 'Build', body: '', meta: { toolName: 'Bash' } })
  assert.equal(page.notifications.length, 2)
})

test('question fallback is localized when the body is empty', () => {
  const page = setup()
  page.setFocused(false)
  page.send({ kind: 'question', sessionId: 's1', title: 'Build', body: '' })
  assert.equal(page.notifications.length, 1)
  assert.equal(page.notifications[0].options.body, '需要你回答')
})

test('a closed event stream is reopened and keeps notifying', () => {
  const clock = fakeClock()
  const page = setup({ timers: clock })
  assert.equal(page.sources.length, 1)
  page.sources[0].fail()
  assert.equal(page.sources[0].closed, true)
  assert.equal(page.sources.length, 1)
  // A second error from the already replaced stream must not add a retry.
  page.sources[0].fail()
  assert.equal(clock.pending(), 1)
  clock.tick(2999)
  assert.equal(page.sources.length, 1)
  clock.tick(1)
  assert.equal(page.sources.length, 2)
  page.setFocused(false)
  page.send({ kind: 'turn-end', sessionId: 's1', title: 'Build', body: 'Done.' })
  assert.equal(page.notifications.length, 1)
  assert.equal(page.notifications[0].options.body, 'Done.')
})

test('a dropped connection stays with the browser retry loop', () => {
  const clock = fakeClock()
  const page = setup({ timers: clock })
  page.sources[0].drop()
  clock.tick(60_000)
  assert.equal(page.sources.length, 1)
  assert.equal(page.sources[0].closed, false)
  page.setFocused(false)
  page.send({ kind: 'turn-end', sessionId: 's1', title: 'Build', body: 'Done.' })
  assert.equal(page.notifications.length, 1)
})

test('a pending reopen is cancelled when the plugin unloads', () => {
  const clock = fakeClock()
  const page = setup({ timers: clock })
  page.sources[0].fail()
  assert.equal(clock.pending(), 1)
  page.dispose()
  assert.equal(page.sources[0].closed, true)
  assert.equal(clock.pending(), 0)
  clock.tick(60_000)
  assert.equal(page.sources.length, 1)
})

test('an error turn shows the localized failure text', () => {
  const page = setup()
  page.setFocused(false)
  page.send({
    kind: 'turn-end',
    sessionId: 's1',
    title: 'Build',
    body: '',
    meta: { status: 'error', error: 'model overloaded' },
  })
  assert.equal(page.notifications.length, 1)
  assert.equal(page.notifications[0].options.body, '生成失败：model overloaded')
})

test('an error turn without a message shows the bare failure text', () => {
  const page = setup()
  page.setFocused(false)
  page.send({ kind: 'turn-end', sessionId: 's1', title: 'Build', body: '', meta: { status: 'error' } })
  assert.equal(page.notifications[0].options.body, '生成失败')
})

test('a max-tokens turn shows the output limit text', () => {
  const page = setup()
  page.setFocused(false)
  page.send({ kind: 'turn-end', sessionId: 's1', title: 'Build', body: '', meta: { status: 'max-tokens' } })
  assert.equal(page.notifications[0].options.body, '已达到输出 token 上限')
})

test('an approval with a reason shows the tool and the reason', () => {
  const page = setup()
  page.setFocused(false)
  page.send({
    kind: 'approval',
    sessionId: 's1',
    title: 'Build',
    body: '',
    meta: { toolName: 'Bash', reason: '需要写入 /tmp/out.txt' },
  })
  assert.equal(page.notifications[0].options.body, '等待批准：Bash — 需要写入 /tmp/out.txt')
})

test('an approval reason without a tool falls back to the plain approval text', () => {
  const page = setup()
  page.setFocused(false)
  page.send({ kind: 'approval', sessionId: 's1', title: 'Build', body: '', meta: { reason: '确认一下' } })
  assert.equal(page.notifications[0].options.body, '需要你批准')
})

test('an approval display reason follows the active locale', () => {
  const page = setup()
  page.setFocused(false)
  const meta = {
    toolName: 'Bash',
    reason: 'escalate sandbox to danger-full-access',
    displayReason: { en: 'Allow sandbox escalation?', zh: '允许升级沙箱？' },
  }
  page.send({ kind: 'approval', sessionId: 's1', title: 'Build', body: '', meta })
  assert.equal(page.notifications[0].options.body, '等待批准：Bash — 允许升级沙箱？')
  page.setLocale('en')
  page.send({ kind: 'approval', sessionId: 's2', title: 'Build', body: '', meta })
  assert.equal(page.notifications[1].options.body, 'Approval needed: Bash — Allow sandbox escalation?')
})

test('an approval display reason falls back to the raw reason', () => {
  const page = setup()
  page.setFocused(false)
  page.send({
    kind: 'approval',
    sessionId: 's1',
    title: 'Build',
    body: '',
    meta: {
      toolName: 'Bash',
      reason: 'escalate sandbox to danger-full-access',
      displayReason: { ja: 'サンドボックスを昇格しますか？' },
    },
  })
  assert.equal(
    page.notifications[0].options.body,
    '等待批准：Bash — escalate sandbox to danger-full-access',
  )
})

test('a composed body splits at a word boundary', () => {
  const page = setup()
  page.setFocused(false)
  page.send({
    kind: 'approval',
    sessionId: 's1',
    title: 'Build',
    body: '',
    meta: { toolName: 'Bash', reason: `${'x'.repeat(60)} supercalifragilisticexpialidocious` },
  })
  const body = page.notifications[0].options.body
  assert.ok(Array.from(body).length <= 80)
  assert.ok(body.endsWith('…'))
  assert.ok(!body.includes('super'))
})

test('a composed body is clipped at 80 characters', () => {
  const page = setup()
  page.setFocused(false)
  page.send({
    kind: 'approval',
    sessionId: 's1',
    title: 'Build',
    body: '',
    meta: { toolName: 'Bash', reason: 'x'.repeat(200) },
  })
  const body = page.notifications[0].options.body
  assert.equal(Array.from(body).length, 80)
  assert.ok(body.endsWith('…'))
})

test('a completed turn keeps the host body when it has one', () => {
  const page = setup()
  page.setFocused(false)
  page.send({
    kind: 'turn-end',
    sessionId: 's1',
    title: 'Build',
    body: '构建已通过。',
    meta: { status: 'completed' },
  })
  assert.equal(page.notifications[0].options.body, '构建已通过。')
})
