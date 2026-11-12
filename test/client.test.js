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

function setup({ permission = 'granted', settings, eventSourceThrows = false } = {}) {
  const storage = new Map()
  if (settings !== undefined) storage.set(STORAGE_KEY, JSON.stringify(settings))
  const notifications = []
  const sources = []
  const windowHandlers = new Map()

  class FakeNotification {
    static permission = permission
    static requestPermission = async () => permission
    constructor(title, options) {
      this.title = title
      this.options = options
      notifications.push(this)
    }
    close() {
      this.closed = true
    }
  }

  class FakeEventSource {
    constructor(url) {
      if (eventSourceThrows) throw new Error('EventSource is unavailable')
      this.url = url
      sources.push(this)
    }
    close() {
      this.closed = true
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
    Notification: FakeNotification,
    EventSource: FakeEventSource,
    setTimeout,
    clearTimeout,
    window: null,
  }
  sandbox.window = sandbox
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
  const locale = {
    register(_namespace, dictionary) {
      translations.clear()
      for (const [key, value] of Object.entries(dictionary.zh)) translations.set(key, value)
    },
    bind() {
      return (key, params = {}) => {
        const value = translations.get(key) ?? key
        return value.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '')
      }
    },
    getSnapshot() {
      return { revision: 1 }
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
  client.apply({
    locale,
    slots,
    uiWorkspace: {
      openSession(sessionId) {
        opened.push(sessionId)
      },
    },
    effect(run) {
      return run()
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
    setFocused(value) {
      focused = value
    },
    render() {
      if (renderedTree === undefined) rerender()
      return renderedTree
    },
    send(payload) {
      assert.ok(sources[0], 'event source opened')
      sources[0].onmessage({ data: JSON.stringify(payload) })
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
  assert.equal(page.notifications[0].options.tag, 's1:turn-end')
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
  assert.equal(page.notifications[0].options.tag, 's1:approval')
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
  const granted = textOf(setup().render())
  assert.match(granted, /浏览器通知已允许/)
  assert.match(granted, /系统设置/)
  assert.doesNotMatch(granted, /系统通知已允许/)

  const denied = textOf(setup({ permission: 'denied' }).render())
  assert.match(denied, /浏览器通知已被拒绝/)
  assert.match(denied, /在浏览器中允许/)
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
