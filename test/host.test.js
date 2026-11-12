import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

function session({ title = 'Session', origin = 'main', events = [] } = {}) {
  return {
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

function makeCtx(sessions, { beforeApply, withSessions = true, withWebServer = true } = {}) {
  const listeners = new Map()
  const hooks = new Map()
  const pendingWebServer = []
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
      if (name === 'sessionTitle') return { get: (value) => ({ title: value.title }) }
      if (name === 'webServer') return webServer
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
  }
  beforeApply?.(ctx)
  apply(ctx)
  return {
    listeners,
    provideWebServer() {
      webServer = makeWebServer()
      for (const callback of pendingWebServer.splice(0)) callback(childCtx())
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

test('turn-end notification carries the title and the last assistant text', (t) => {
  const sessions = new Map([['root', session({ title: 'Build', events: [assistant('Done.')] })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('agent/turn-stopping')({ agent: { id: 'root' } })
  const payloads = frames(chunks)
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].kind, 'turn-end')
  assert.equal(payloads[0].sessionId, 'root')
  assert.equal(payloads[0].title, 'Build')
  assert.equal(payloads[0].body, 'Done.')
  assert.ok(Number.isFinite(payloads[0].time))
})

test('an empty turn-end body stays empty so the client can localize it', (t) => {
  const sessions = new Map([['root', session({ title: 'Build' })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('agent/turn-stopping')({ agent: { id: 'root' } })
  assert.equal(frames(chunks)[0].body, '')
})

test('subagent turn-end remains silent', (t) => {
  const sessions = new Map([['child', session({ origin: 'subagent', events: [assistant('Done.')] })]])
  const { listeners, connect } = makeCtx(sessions)
  const { chunks, close } = connect()
  t.after(close)
  listeners.get('agent/turn-stopping')({ agent: { id: 'child' } })
  assert.deepEqual(frames(chunks), [])
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
  assert.equal(toolName.length, 140)
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

test('registers the event route when webServer becomes available after apply', (t) => {
  const sessions = new Map([['root', session({ title: 'Late' })]])
  const harness = makeCtx(sessions, { withWebServer: false })
  harness.provideWebServer()
  const { chunks, close } = harness.connect()
  t.after(close)
  harness.listeners.get('agent/turn-stopping')({ agent: { id: 'root' } })
  assert.equal(frames(chunks)[0].kind, 'turn-end')
})

test('does not subscribe when the sessions service is unavailable', () => {
  const { listeners } = makeCtx(undefined, { withSessions: false })
  assert.equal(listeners.has('agent/turn-stopping'), false)
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
  const sessions = new Map([['child', session({ origin: 'subagent' })]])
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
  const sessions = new Map([['child', session({ origin: 'subagent' })]])
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
