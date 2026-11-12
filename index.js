/**
 * Host half of the session notify plugin.
 *
 * It turns two Host events into newline-delimited Server-Sent Events on one
 * Web route: a turn that is about to close, and a question that waits for a
 * human answer. The Client half raises the native notification, so macOS shows
 * DeepSeek Harness as the sender and a click can select that Session.
 *
 * Subagent Sessions are skipped: their parent turn still reports.
 */

const ROUTE_PATH = '/session-bell/events'
const HEARTBEAT_MS = 20_000
const BODY_LIMIT = 140

const collapse = text => text.replace(/\s+/gu, ' ').trim()

const clip = (text) => {
  const flat = collapse(text)
  return flat.length <= BODY_LIMIT ? flat : `${flat.slice(0, BODY_LIMIT - 1)}…`
}

const textOf = blocks => (Array.isArray(blocks)
  ? blocks.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  : '')

export function apply(ctx) {
  const streams = new Set()

  const push = (payload) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`
    for (const stream of streams) {
      try {
        stream.write(frame)
      } catch {
        streams.delete(stream)
      }
    }
  }

  const sessions = ctx.get('sessions')
  const sessionTitle = ctx.get('sessionTitle')

  const sessionOf = sessionId => sessions?.get(sessionId)

  const isSubagent = (sessionId) => {
    const session = sessionOf(sessionId)
    if (session === undefined) return false
    const header = session.header
    return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
  }

  const titleOf = (sessionId) => {
    const session = sessionOf(sessionId)
    if (session === undefined) return 'DeepSeek Harness'
    return sessionTitle?.get(session)?.title ?? 'DeepSeek Harness'
  }

  const lastAssistantText = (sessionId) => {
    const session = sessionOf(sessionId)
    if (session === undefined) return ''
    const events = session.ownEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'assistant/message') continue
      const text = textOf(event.data?.message?.content)
      if (text.trim() !== '') return text
    }
    return ''
  }

  const describe = (kind, sessionId, body) => ({
    kind,
    sessionId,
    title: titleOf(sessionId),
    body: clip(body),
    time: Date.now(),
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent === undefined || isSubagent(agent.id)) return
    const text = lastAssistantText(agent.id)
    push(describe('turn-end', agent.id, text === '' ? '回合已完成' : text))
  })

  ctx.on('user-questions/request', (request, next) => {
    const sessionId = request?.agent?.id
    if (sessionId !== undefined && !isSubagent(sessionId)) {
      const question = request?.questions?.[0]?.question
      push(describe('question', sessionId, typeof question === 'string' ? question : '需要你回答'))
    }
    return typeof next === 'function' ? next() : undefined
  })

  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('Allow', 'GET')
        res.end()
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(': connected\n\n')
      streams.add(res)
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          // The close handler owns cleanup.
        }
      }, HEARTBEAT_MS)
      const close = () => {
        clearInterval(heartbeat)
        streams.delete(res)
      }
      res.on('close', close)
      res.on('error', close)
    },
  }))
}
