import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

const NOTIFY_DELAY_MS = 1500

function session({ id = 'root', title = 'Session', origin = 'main', events = [] } = {}) {
  return {
    id,
    title,
    header: { origin, delegationDepth: origin === 'subagent' ? 1 : 0 },
    ownEvents: () => events,
  }
}

function assistant(text) {
  return {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  }
}

function assistantBlocks(blocks) {
  return {
    type: 'assistant/message',
    data: { message: { content: blocks } },
  }
}

function goal(overrides = {}) {
  return {
    id: 'g1',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 0,
    maxGoalRounds: 5,
    ...overrides,
  }
}

function makeCtx(sessions, {
  beforeApply,
  withSessions = true,
  withWebServer = true,
  lateSessionTitle = false,
  withWaterfall = true,
  activity,
  onActivity,
  agents,
  goals,
} = {}) {
  const listeners = new Map()
  const hooks = new Map()
  const pendingWebServer = []
  const logs = []
  let route
  const makeWebServer = () => ({
    register(options) {
      route = options.handler
      return () => {
        if (route === options.handler) route = undefined
      }
    },
  })
  let webServer = withWebServer ? makeWebServer() : undefined
  // The real title service injects more than the session store, so it can become
  // active after this plugin. `lateSessionTitle` models that ordering.
  let sessionTitle = lateSessionTitle ? undefined : { get: (value) => ({ title: value.title }) }
  const childCtx = () => ({
    webServer,
    effect(run) {
      return run()
    },
  })
  const ctx = {
    on(event, handler, options) {
      listeners.set(event, handler)
      const record = {
        handler,
        prepend: options === true || (typeof options === 'object' && options?.prepend === true),
      }
      const eventHooks = hooks.get(event) ?? []
      if (record.prepend) eventHooks.unshift(record)
      else eventHooks.push(record)
      hooks.set(event, eventHooks)
      return () => {
        const index = eventHooks.indexOf(record)
        if (index >= 0) eventHooks.splice(index, 1)
        if (listeners.get(event) === handler) listeners.delete(event)
      }
    },
    get(name) {
      if (name === 'sessions') return withSessions ? { get: (id) => sessions.get(id) } : undefined
      if (name === 'sessionTitle') return sessionTitle
      if (name === 'webServer') return webServer
      if (name === 'agents') return agents
      if (name === 'goals') return goals
      return undefined
    },
    inject(names, callback) {
      if (!names.includes('webServer')) return { dispose() {} }
      if (webServer === undefined) pendingWebServer.push(callback)
      else callback(childCtx())
      return { dispose() {} }
    },
    effect(run) {
      return run()
    },
    logger: {
      debug(message) {
        logs.push(String(message))
      },
    },
  }
  if (withWaterfall) {
    ctx.waterfall = (event, request, inner = () => Promise.resolve([])) => {
      if (event !== 'workspace/session-activity') return inner()
      if (typeof onActivity === 'function') return onActivity(request)
      return activity ?? []
    }
  }
  beforeApply?.(ctx)
  apply(ctx)
  return {
    listeners,
    logs,
    provideWebServer() {
      webServer = makeWebServer()
      for (const callback of pendingWebServer.splice(0)) callback(childCtx())
    },
    provideSessionTitle() {
      sessionTitle = { get: (value) => ({ title: value.title }) }
    },
    connect() {
      const chunks = []
      let close
      const response = {
        writeHead() {},
        setHeader() {},
        write(chunk) {
          chunks.push(String(chunk))
        },
        on(event, handler) {
          if (event === 'close') close = handler
        },
        end() {},
      }
      route({ method: 'GET' }, response)
      return {
        chunks,
        close() {
          close?.()
        },
        end() {},
      }
    },
    waterfall(event, request, inner = () => 'unavailable') {
      const eventHooks = [...(hooks.get(event) ?? [])]
      const run = () => {
        const hook = eventHooks.shift()
        if (hook === undefined) return inner()
        return hook.handler(request, () => run())
      }
      return run()
    },
  }
}

function frames(chunks) {
  return chunks
    .join('')
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)))
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

function turnEnd(kind = 'completed', extra = {}) {
  return { type: 'turn/end', data: { turn: 1, reason: { kind, ...extra } } }
}

function emit(listeners, sessionValue, event) {
  listeners.get('session/event')(sessionValue, event)
}

async function runTurn(t, sessions, {
  sessionId = 'root',
  reason = { kind: 'completed' },
  tick = NOTIFY_DELAY_MS,
  ...options
} = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const harness = makeCtx(sessions, options)
  const { chunks, close } = harness.connect()
  t.after(close)
  emit(harness.listeners, sessions.get(sessionId), { type: 'turn/end', data: { turn: 1, reason } })
  t.mock.timers.tick(tick)
  await flush()
  return { ...harness, chunks, close }
}

async function turnEndBody(t, text, options = {}) {
  const sessions = new Map([['root', session({ title: options.title ?? 'Build', events: [assistant(text)] })]])
  const { chunks, close } = await runTurn(t, sessions, options)
  close()
  return frames(chunks)[0]?.body
}

async function turnEndTitle(t, title, options = {}) {
  const sessions = new Map([['root', session({ title, events: [assistant('Done.')] })]])
  const { chunks, close } = await runTurn(t, sessions, options)
  close()
  return frames(chunks)[0]?.title
}

test('turn-end notification carries the title, body and status', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions)
  const payloads = frames(chunks)
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].kind, 'turn-end')
  assert.equal(payloads[0].sessionId, 'root')
  assert.equal(payloads[0].title, 'Build')
  assert.equal(payloads[0].body, 'Done.')
  assert.deepEqual(payloads[0].meta, { status: 'completed' })
  assert.ok(Number.isFinite(payloads[0].time))
})

test('turn-end keeps the Session title when the title service mounts after the plugin', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const harness = makeCtx(sessions, { lateSessionTitle: true })
  const { chunks, close } = harness.connect()
  t.after(close)
  harness.provideSessionTitle()
  emit(harness.listeners, sessions.get('root'), turnEnd())
  t.mock.timers.tick(NOTIFY_DELAY_MS)
  await flush()
  assert.equal(frames(chunks)[0].title, 'Build')
})

test('turn-end falls back to the app name without a title service', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { listeners, connect } = makeCtx(sessions, { lateSessionTitle: true })
  const { chunks, close } = connect()
  t.after(close)
  emit(listeners, sessions.get('root'), turnEnd())
  t.mock.timers.tick(NOTIFY_DELAY_MS)
  await flush()
  assert.equal(frames(chunks)[0].title, 'DeepSeek Harness')
})

test('turn-end title stops at 30 characters', async (t) => {
  const title = 'Read-only architecture/test-fidelity rev'
  assert.equal(await turnEndTitle(t, title), `${Array.from(title).slice(0, 29).join('')}…`)
})

test('turn-end title of exactly 30 characters is unchanged', async (t) => {
  const title = 'A'.repeat(30)
  assert.equal(await turnEndTitle(t, title), title)
})

test('turn-end title clips an emoji title without splitting a code point', async (t) => {
  const title = '😀'.repeat(31)
  const clipped = await turnEndTitle(t, title)
  assert.equal(Array.from(clipped).length, 30)
  assert.equal(clipped, `${'😀'.repeat(29)}…`)
})

test('turn-end falls back to the app name for a blank title', async (t) => {
  assert.equal(await turnEndTitle(t, '   '), 'DeepSeek Harness')
})

test('turn-end falls back to the app name for a non-string title', async (t) => {
  assert.equal(await turnEndTitle(t, 42), 'DeepSeek Harness')
})

test('a missing title service is logged once, not once per notification', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { listeners, connect, logs } = makeCtx(sessions, { lateSessionTitle: true })
  const { close } = connect()
  t.after(close)
  emit(listeners, sessions.get('root'), turnEnd())
  t.mock.timers.tick(NOTIFY_DELAY_MS)
  await flush()
  emit(listeners, sessions.get('root'), turnEnd())
  t.mock.timers.tick(NOTIFY_DELAY_MS)
  await flush()
  assert.equal(logs.length, 1)
  assert.match(logs[0], /title service/u)
})

test('turn-end body drops Markdown a native notification cannot draw', async (t) => {
  const text = [
    '**改动**：`InterfaceStyle.swift` 新增 `selectedRowText`。',
    '',
    '| 文件 | 内容 |',
    '| --- | --- |',
    '| `Sidebar.swift` | 改用 `selectedRowText` |',
  ].join('\n')
  assert.equal(await turnEndBody(t, text), '改动：InterfaceStyle.swift 新增 selectedRowText。')
})

test('turn-end body keeps the first sentence only', async (t) => {
  assert.equal(
    await turnEndBody(t, '原生已按设计稿全部同步完。已跑 `swift build`，通过。'),
    '原生已按设计稿全部同步完。',
  )
})

test('turn-end body stops at 80 characters', async (t) => {
  const body = await turnEndBody(t, '一'.repeat(200))
  assert.equal(Array.from(body).length, 80)
  assert.ok(body.endsWith('…'))
})

test('an empty turn-end body stays empty so the client can localize it', async (t) => {
  assert.equal(await turnEndBody(t, ''), '')
})

test('a turn-end body made only of a table stays empty so the client can localize it', async (t) => {
  assert.equal(await turnEndBody(t, '| 文件 | 内容 |\n| --- | --- |\n| A.swift | 新增 |'), '')
})

test('turn-end body cuts English at a sentence, not at a version number', async (t) => {
  assert.equal(await turnEndBody(t, 'Released v0.2.6. Tests pass.'), 'Released v0.2.6.')
})

test('turn-end body drops a fenced code block before the first sentence', async (t) => {
  assert.equal(await turnEndBody(t, '```bash\nswift build\n```\n构建已通过。'), '构建已通过。')
})

test('turn-end body keeps link text without its URL', async (t) => {
  assert.equal(await turnEndBody(t, '见 [日志](https://example.com/log) 里的第 3 行。'), '见 日志 里的第 3 行。')
})

test('turn-end body cuts the first sentence of mixed Chinese and English', async (t) => {
  assert.equal(await turnEndBody(t, 'Fixed the bug. 重启后生效。'), 'Fixed the bug.')
})

test('turn-end body cuts after a version number that ends a sentence', async (t) => {
  assert.equal(await turnEndBody(t, 'Bumped to v1.2. 已发版。'), 'Bumped to v1.2.')
})

test('turn-end body keeps a version number before a Chinese sentence', async (t) => {
  assert.equal(await turnEndBody(t, '版本 v0.2.6 已发布。'), '版本 v0.2.6 已发布。')
})

test('turn-end body does not cut at a question mark inside a URL', async (t) => {
  assert.equal(
    await turnEndBody(t, 'See https://example.com/a?b=1 for details.'),
    'See https://example.com/a?b=1 for details.',
  )
})

test('turn-end body does not cut at an abbreviation before Chinese', async (t) => {
  assert.equal(await turnEndBody(t, '见 Dr. Smith 的说明。'), '见 Dr. Smith 的说明。')
})

test('turn-end body does not cut at an English title abbreviation', async (t) => {
  assert.equal(
    await turnEndBody(t, 'Dr. Smith pushed the fix. Tests pass.'),
    'Dr. Smith pushed the fix.',
  )
})

test('turn-end body does not cut at a dotted abbreviation', async (t) => {
  assert.equal(
    await turnEndBody(t, 'The U.S. team shipped it. Then we rest.'),
    'The U.S. team shipped it.',
  )
})

test('a short first sentence falls back to the whole reply', async (t) => {
  assert.equal(await turnEndBody(t, 'He said no. Then we left.'), 'He said no. Then we left.')
})

test('turn-end body does not read a word ending in an abbreviation as one', async (t) => {
  assert.equal(await turnEndBody(t, 'He finished 1st. Then we left.'), 'He finished 1st.')
})

test('a short abbreviation-led sentence also falls back to the whole reply', async (t) => {
  assert.equal(await turnEndBody(t, '由 Dr. 王 负责。下一句也一样。'), '由 Dr. 王 负责。下一句也一样。')
})

test('turn-end body does not cut at a degree abbreviation', async (t) => {
  assert.equal(
    await turnEndBody(t, 'The Ph.D. Program starts in fall. Then we rest.'),
    'The Ph.D. Program starts in fall.',
  )
})

test('turn-end body does not cut at an approximate-value label', async (t) => {
  assert.equal(await turnEndBody(t, 'Approx. Time: 5 min. Then we ship.'), 'Approx. Time: 5 min.')
})

test('turn-end body does not cut inside a company name', async (t) => {
  assert.equal(
    await turnEndBody(t, 'Warner Bros. Pictures owns it. Then we rest.'),
    'Warner Bros. Pictures owns it.',
  )
})

test('turn-end body does not cut at an honorific suffix', async (t) => {
  assert.equal(
    await turnEndBody(t, 'Write to Jane Doe, Esq. Notary Public. Then wait.'),
    'Write to Jane Doe, Esq. Notary Public.',
  )
})

test('a short exclamation sentence falls back to the whole reply', async (t) => {
  assert.equal(await turnEndBody(t, 'Done! The build is green.'), 'Done! The build is green.')
})

test('turn-end body keeps underscores inside a file name', async (t) => {
  assert.equal(
    await turnEndBody(t, '文件 报告_2026_终稿.docx 已上传。'),
    '文件 报告_2026_终稿.docx 已上传。',
  )
})

test('turn-end body drops a table whose rows have no leading pipe', async (t) => {
  assert.equal(
    await turnEndBody(t, '文件 | 内容\n--- | ---\nA.swift | 新增\n\n已跑 swift build。'),
    '已跑 swift build。',
  )
})

test('a body of emoji is clipped by character, not by UTF-16 unit', async (t) => {
  const body = await turnEndBody(t, '😀'.repeat(200))
  assert.equal(Array.from(body).length, 80)
  assert.ok(body.endsWith('😀…'))
})

test('turn-end body keeps asterisks and underscores inside inline code', async (t) => {
  assert.equal(await turnEndBody(t, '用 `a*b*c` 和 `__init__.py` 都行。'), '用 a*b*c 和 __init__.py 都行。')
})

test('turn-end body drops an unclosed fenced code block', async (t) => {
  assert.equal(await turnEndBody(t, '结果如下：\n\n```js\nconst a = 1.5\nreturn a'), '结果如下：')
})

test('turn-end body strips nested emphasis', async (t) => {
  assert.equal(await turnEndBody(t, '**改动用 *斜体* 说明**。'), '改动用 斜体 说明。')
})

test('turn-end body strips underscore emphasis without touching identifiers', async (t) => {
  assert.equal(
    await turnEndBody(t, '变量 foo_bar_baz 保留，_注意_ 去掉。'),
    '变量 foo_bar_baz 保留，注意 去掉。',
  )
})

test('turn-end body keeps a polite opening', async (t) => {
  assert.equal(
    await turnEndBody(t, '好的，原生已按设计稿全部同步完。已跑 swift build。'),
    '好的，原生已按设计稿全部同步完。',
  )
})

test('turn-end body uses only the last assistant text block', async (t) => {
  const sessions = new Map([['root', session({
    title: 'Build',
    events: [assistantBlocks([
      { type: 'text', text: 'I will check the build.' },
      { type: 'tool_use', id: 'call-1', name: 'Bash', input: {} },
      { type: 'text', text: '构建已通过。' },
    ])],
  })]])
  const { chunks } = await runTurn(t, sessions)
  assert.equal(frames(chunks)[0].body, '构建已通过。')
})

test('turn-end body clips at a word boundary', async (t) => {
  const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'
  const body = await turnEndBody(t, text)
  assert.ok(Array.from(body).length <= 80)
  assert.ok(body.endsWith('…'))
  const stem = body.slice(0, -1).trimEnd()
  const last = stem.slice(stem.lastIndexOf(' ') + 1)
  assert.ok(text.split(' ').includes(last), `cut inside a word: ${last}`)
})

test('a completed turn waits 1.5 seconds before notifying', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  emit(listeners, sessions.get('root'), turnEnd())
  await flush()
  assert.deepEqual(frames(chunks), [])
  t.mock.timers.tick(NOTIFY_DELAY_MS - 1)
  await flush()
  assert.deepEqual(frames(chunks), [])
  t.mock.timers.tick(1)
  await flush()
  assert.equal(frames(chunks).length, 1)
})

test('turn-start cancels the pending completion notification', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  emit(listeners, sessions.get('root'), turnEnd())
  t.mock.timers.tick(1000)
  emit(listeners, sessions.get('root'), { type: 'turn/start', data: { turn: 2 } })
  t.mock.timers.tick(1000)
  await flush()
  assert.deepEqual(frames(chunks), [])
})

test('an error turn notifies immediately with the failure text', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    reason: { kind: 'error', error: { message: 'model overloaded', code: 'overloaded' } },
    tick: 0,
  })
  const payloads = frames(chunks)
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].body, '')
  assert.deepEqual(payloads[0].meta, { status: 'error', error: 'model overloaded' })
})

test('an error turn without a message still reports the failure', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build' })]])
  const { chunks } = await runTurn(t, sessions, { reason: { kind: 'error' }, tick: 0 })
  assert.deepEqual(frames(chunks)[0].meta, { status: 'error' })
})

test('an error message is plain text clipped like a body', async (t) => {
  const message = `**失败** ${'x'.repeat(200)}`
  const sessions = new Map([['root', session({ title: 'Build' })]])
  const { chunks } = await runTurn(t, sessions, {
    reason: { kind: 'error', error: { message } },
    tick: 0,
  })
  const error = frames(chunks)[0].meta.error
  assert.ok(error.startsWith('失败 x'))
  assert.equal(Array.from(error).length, 80)
  assert.ok(error.endsWith('…'))
})

test('a max-tokens turn notifies immediately', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('partial')] })]])
  const { chunks } = await runTurn(t, sessions, { reason: { kind: 'max-tokens' }, tick: 0 })
  assert.deepEqual(frames(chunks)[0].meta, { status: 'max-tokens' })
  assert.equal(frames(chunks)[0].body, '')
})

for (const kind of ['aborted', 'interrupted', 'blocked']) {
  test(`a ${kind} turn stays silent`, async (t) => {
    const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
    const { chunks } = await runTurn(t, sessions, { reason: { kind } })
    assert.deepEqual(frames(chunks), [])
  })
}

test('an unknown turn-end reason stays silent', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, { reason: { kind: 'future' } })
  assert.deepEqual(frames(chunks), [])
})

test('subagent turn-end remains silent', async (t) => {
  const sessions = new Map([['child', session({ id: 'child', origin: 'subagent', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, { sessionId: 'child' })
  assert.deepEqual(frames(chunks), [])
})

test('a running subagent suppresses the completion notification', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    activity: [{ kind: 'subagent', items: [{ id: 'child', label: 'reviewer' }] }],
  })
  assert.deepEqual(frames(chunks), [])
})

test('a running background job suppresses the completion notification', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    activity: [{ kind: 'job', items: [{ id: 'job-1', label: 'tests' }] }],
  })
  assert.deepEqual(frames(chunks), [])
})

test('the ending turn itself does not suppress its notification', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    activity: [{ kind: 'turn', items: [{ id: 'root', label: 'Build' }] }],
  })
  assert.equal(frames(chunks).length, 1)
})

test('an active schedule does not suppress the notification', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    activity: [{ kind: 'schedule', items: [{ id: 'schedule-1', label: 'daily' }] }],
  })
  assert.equal(frames(chunks).length, 1)
})

test('an unknown activity kind does not suppress the notification', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, { activity: [{ kind: 'future' }] })
  assert.equal(frames(chunks).length, 1)
})

test('the activity query receives the session id', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const seen = []
  await runTurn(t, sessions, {
    onActivity(request) {
      seen.push(request)
      return []
    },
  })
  assert.deepEqual(seen, [{ sessionId: 'root' }])
})

test('a failing activity query still notifies', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    onActivity() {
      throw new Error('no provider')
    },
  })
  assert.equal(frames(chunks).length, 1)
})

test('a missing activity waterfall still notifies', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, { withWaterfall: false })
  assert.equal(frames(chunks).length, 1)
})

test('a non-array activity answer still notifies', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, { activity: { kind: 'job' } })
  assert.equal(frames(chunks).length, 1)
})

test('an active goal with a queued next round suppresses the completion notification', async (t) => {
  const agent = {
    id: 'root',
    inbox: { nextTurn: [{ source: { kind: 'goal', goalId: 'g1', round: 1 } }], nextStep: [] },
  }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Round done.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal()]]),
  })
  assert.deepEqual(frames(chunks), [])
})

test('a queued goal round in nextStep also suppresses', async (t) => {
  const agent = {
    id: 'root',
    inbox: { nextTurn: [], nextStep: [{ source: { kind: 'goal', goalId: 'g1', round: 1 } }] },
  }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Round done.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal()]]),
  })
  assert.deepEqual(frames(chunks), [])
})

test('an active goal without a queued round still notifies', async (t) => {
  const agent = { id: 'root' }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Goal idle.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal()]]),
  })
  assert.equal(frames(chunks).length, 1)
})

test('an active goal with an empty inbox still notifies', async (t) => {
  const agent = { id: 'root', inbox: { nextTurn: [], nextStep: [] } }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Goal idle.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal()]]),
  })
  assert.equal(frames(chunks).length, 1)
})

test('an active goal with only ordinary queued input notifies', async (t) => {
  const agent = {
    id: 'root',
    inbox: { nextTurn: [{ source: { kind: 'user' } }], nextStep: [] },
  }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Goal idle.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal()]]),
  })
  assert.equal(frames(chunks).length, 1)
})

test('a queued round for another goal does not suppress', async (t) => {
  const agent = {
    id: 'root',
    inbox: { nextTurn: [{ source: { kind: 'goal', goalId: 'g2', round: 1 } }], nextStep: [] },
  }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Goal idle.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal()]]),
  })
  assert.equal(frames(chunks).length, 1)
})

test('an unreadable inbox still notifies', async (t) => {
  const agent = {
    id: 'root',
    get inbox() {
      throw new Error('inbox unavailable')
    },
  }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Goal idle.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal()]]),
  })
  assert.equal(frames(chunks).length, 1)
})

test('a completed goal notifies', async (t) => {
  const agent = { id: 'root' }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Goal done.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal({ phase: 'complete' })]]),
  })
  assert.equal(frames(chunks).length, 1)
})

test('a blocked goal notifies', async (t) => {
  const agent = { id: 'root' }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Goal blocked.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal({ phase: 'blocked' })]]),
  })
  assert.equal(frames(chunks).length, 1)
})

test('a disarmed goal notifies', async (t) => {
  const agent = { id: 'root' }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Paused.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal({ activation: 'disarmed' })]]),
  })
  assert.equal(frames(chunks).length, 1)
})

test('a goal at its round limit notifies', async (t) => {
  const agent = { id: 'root' }
  const sessions = new Map([['root', session({ title: 'Goal', events: [assistant('Last round.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: new Map([[agent, goal({ roundsStarted: 5, maxGoalRounds: 5 })]]),
  })
  assert.equal(frames(chunks).length, 1)
})

test('a missing goal service still notifies', async (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions)
  assert.equal(frames(chunks).length, 1)
})

test('a goal lookup failure still notifies', async (t) => {
  const agent = { id: 'root' }
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { chunks } = await runTurn(t, sessions, {
    agents: new Map([['root', agent]]),
    goals: {
      get() {
        throw new Error('not live')
      },
    },
  })
  assert.equal(frames(chunks).length, 1)
})

test('question notification carries the question and delegates', (t) => {
  const sessions = new Map([['root', session({ title: 'Question' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  let calls = 0
  const result = listeners.get('user-questions/request')(
    { agent: { id: 'root' }, questions: [{ question: 'Which option?' }] },
    () => {
      calls += 1
      return 'answer'
    },
  )
  assert.equal(result, 'answer')
  assert.equal(calls, 1)
  assert.equal(frames(chunks)[0].kind, 'question')
  assert.equal(frames(chunks)[0].body, 'Which option?')
})

test('question body keeps every sentence and drops Markdown', (t) => {
  const sessions = new Map([['root', session({ title: 'Question' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('user-questions/request')({
    agent: { id: 'root' },
    questions: [{ question: '用 `pnpm` 还是 `npm`？两个都能装，你定。' }],
  }, () => 'answer')
  assert.equal(frames(chunks)[0].body, '用 pnpm 还是 npm？两个都能装，你定。')
})

test('question body stops at 80 characters', (t) => {
  const sessions = new Map([['root', session({ title: 'Question' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('user-questions/request')({
    agent: { id: 'root' },
    questions: [{ question: '一'.repeat(200) }],
  }, () => 'answer')
  const body = frames(chunks)[0].body
  assert.equal(Array.from(body).length, 80)
  assert.ok(body.endsWith('…'))
})

test('approval notification carries the tool name and delegates', (t) => {
  const sessions = new Map([['root', session({ title: 'Approval' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  let calls = 0
  const result = listeners.get('approval/request')(
    { agent: { id: 'root' }, toolName: 'Bash' },
    () => {
      calls += 1
      return 'allowed-once'
    },
  )
  assert.equal(result, 'allowed-once')
  assert.equal(calls, 1)
  assert.equal(frames(chunks)[0].kind, 'approval')
  assert.equal(frames(chunks)[0].body, '')
  assert.deepEqual(frames(chunks)[0].meta, { toolName: 'Bash' })
})

test('approval notification carries a plain-text reason', (t) => {
  const sessions = new Map([['root', session({ title: 'Approval' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('approval/request')(
    { agent: { id: 'root' }, toolName: 'Bash', reason: '**写入** `/tmp/out.txt`' },
    () => 'allowed-once',
  )
  assert.deepEqual(frames(chunks)[0].meta, { toolName: 'Bash', reason: '写入 /tmp/out.txt' })
})

test('approval notification carries the localized display reason', (t) => {
  const sessions = new Map([['root', session({ title: 'Approval' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('approval/request')(
    {
      agent: { id: 'root' },
      toolName: 'Bash',
      reason: 'escalate sandbox to danger-full-access: write /tmp/out.txt',
      displayReason: { en: 'Allow **writing** to /tmp/out.txt?', zh: '允许写入 /tmp/out.txt？' },
    },
    () => 'allowed-once',
  )
  assert.deepEqual(frames(chunks)[0].meta, {
    toolName: 'Bash',
    reason: 'escalate sandbox to danger-full-access: write /tmp/out.txt',
    displayReason: { en: 'Allow writing to /tmp/out.txt?', zh: '允许写入 /tmp/out.txt？' },
  })
})

test('approval display reasons are clipped like a body', (t) => {
  const sessions = new Map([['root', session({ title: 'Approval' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('approval/request')(
    {
      agent: { id: 'root' },
      toolName: 'Bash',
      displayReason: { en: 'x'.repeat(200) },
    },
    () => 'allowed-once',
  )
  const value = frames(chunks)[0].meta.displayReason.en
  assert.equal(Array.from(value).length, 80)
  assert.ok(value.endsWith('…'))
})

test('an invalid display reason is ignored', (t) => {
  const sessions = new Map([['root', session({ title: 'Approval' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('approval/request')(
    { agent: { id: 'root' }, toolName: 'Bash', displayReason: ['no'] },
    () => 'allowed-once',
  )
  assert.deepEqual(frames(chunks)[0].meta, { toolName: 'Bash' })
})

test('approval reason is clipped like a body', (t) => {
  const sessions = new Map([['root', session({ title: 'Approval' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('approval/request')(
    { agent: { id: 'root' }, toolName: 'Bash', reason: 'x'.repeat(200) },
    () => 'allowed-once',
  )
  const reason = frames(chunks)[0].meta.reason
  assert.equal(Array.from(reason).length, 80)
  assert.ok(reason.endsWith('…'))
})

test('approval tool name is clipped like a body', (t) => {
  const sessions = new Map([['root', session({ title: 'Approval' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('approval/request')(
    { agent: { id: 'root' }, toolName: 'x'.repeat(200) },
    () => 'allowed-once',
  )
  const toolName = frames(chunks)[0].meta.toolName
  assert.equal(toolName.length, 80)
  assert.ok(toolName.endsWith('…'))
})

test('approval notification runs before a consuming Web bridge', (t) => {
  const sessions = new Map([['root', session({ title: 'Approval' })]])
  let bridgeCalls = 0
  const { connect, waterfall } = makeCtx(sessions, {
    beforeApply(ctx) {
      ctx.on('approval/request', () => {
        bridgeCalls += 1
        return 'allowed-once'
      })
    },
  })
  const { chunks, close } = connect()
  t.after(close)
  const result = waterfall('approval/request', { agent: { id: 'root' }, toolName: 'Bash' })
  assert.equal(result, 'allowed-once')
  assert.equal(bridgeCalls, 1)
  assert.equal(frames(chunks)[0].kind, 'approval')
})

test('question notification runs before a consuming Web bridge', (t) => {
  const sessions = new Map([['root', session({ title: 'Question' })]])
  let bridgeCalls = 0
  const { connect, waterfall } = makeCtx(sessions, {
    beforeApply(ctx) {
      ctx.on('user-questions/request', () => {
        bridgeCalls += 1
        return 'answer'
      })
    },
  })
  const { chunks, close } = connect()
  t.after(close)
  const result = waterfall('user-questions/request', {
    agent: { id: 'root' },
    questions: [{ question: 'Which option?' }],
  })
  assert.equal(result, 'answer')
  assert.equal(bridgeCalls, 1)
  assert.equal(frames(chunks)[0].kind, 'question')
})

test('registers the event route when webServer becomes available after apply', async (t) => {
  const sessions = new Map([['root', session({ title: 'Late', events: [assistant('Done.')] })]])
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const harness = makeCtx(sessions, { withWebServer: false })
  harness.provideWebServer()
  const { chunks, close } = harness.connect()
  t.after(close)
  emit(harness.listeners, sessions.get('root'), turnEnd())
  t.mock.timers.tick(NOTIFY_DELAY_MS)
  await flush()
  assert.equal(frames(chunks)[0].kind, 'turn-end')
})

test('does not subscribe when the sessions service is unavailable', () => {
  const { listeners } = makeCtx(undefined, { withSessions: false })
  assert.equal(listeners.has('session/event'), false)
  assert.equal(listeners.has('user-questions/request'), false)
  assert.equal(listeners.has('approval/request'), false)
})

test('approval for an unknown session stays silent', (t) => {
  const sessions = new Map()
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('approval/request')(
    { agent: { id: 'missing' }, toolName: 'Bash' },
    () => 'allowed-once',
  )
  assert.deepEqual(frames(chunks), [])
})

test('subagent approval is silent but still delegates', (t) => {
  const sessions = new Map([['child', session({ id: 'child', origin: 'subagent' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  let calls = 0
  const result = listeners.get('approval/request')(
    { agent: { id: 'child' }, toolName: 'Bash' },
    () => {
      calls += 1
      return 'allowed-once'
    },
  )
  assert.equal(result, 'allowed-once')
  assert.equal(calls, 1)
  assert.deepEqual(frames(chunks), [])
})

test('subagent question is silent but still delegates', (t) => {
  const sessions = new Map([['child', session({ id: 'child', origin: 'subagent' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  let calls = 0
  const result = listeners.get('user-questions/request')(
    { agent: { id: 'child' }, questions: [{ question: 'Which option?' }] },
    () => {
      calls += 1
      return 'answer'
    },
  )
  assert.equal(result, 'answer')
  assert.equal(calls, 1)
  assert.deepEqual(frames(chunks), [])
})

test('an empty question body stays empty so the client can localize it', (t) => {
  const sessions = new Map([['root', session({ title: 'Question' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('user-questions/request')({ agent: { id: 'root' }, questions: [] }, () => 'answer')
  assert.equal(frames(chunks)[0].body, '')
})
