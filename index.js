/**
 * Host half of the session notify plugin.
 *
 * It turns three Host events into Server-Sent Events on one Web route: a turn
 * that is about to close, a question that waits for a human answer, and an
 * approval that waits for a human decision. The Client half raises the native
 * notification, so the Desktop app shows DeepSeek Harness as the sender and a
 * click can select that Session.
 *
 * Subagent Sessions are skipped for all three events: their parent turn still
 * reports.
 */

const ROUTE_PATH = '/session-bell/events'
const HEARTBEAT_MS = 20_000
const BODY_LIMIT = 80
const TITLE_LIMIT = 30
const NOTIFY_DELAY_MS = 1500
const REPLY_LIMIT = 4000
const ERROR_LIMIT = 80
const WORD_BREAK_LOOKBACK = 20
// A one-word answer such as `Done.` is useless as a banner; show the whole reply.
const MIN_BODY = 12
// Sender the system shows for the app itself; the last resort for a title.
const APP_NAME = 'DeepSeek Harness'

export const inject = ['sessions']

const collapse = text => String(text ?? '').replace(/\s+/gu, ' ').trim()

const isAlnum = char => char !== undefined && /[A-Za-z0-9]/u.test(char)

/**
 * A native banner has one line. Cut at the limit, but do not split an English
 * word: back up to the space before it, within a short lookback so one very long
 * token still gets cut instead of swallowed.
 */
const clip = (text, limit = BODY_LIMIT) => {
  const flat = Array.from(collapse(text))
  if (flat.length <= limit) return flat.join('')
  let end = limit - 1
  if (isAlnum(flat[end - 1]) && isAlnum(flat[end])) {
    let back = end
    while (back > 0 && end - back < WORD_BREAK_LOOKBACK && isAlnum(flat[back - 1])) back -= 1
    if (back > 0 && /\s/u.test(flat[back - 1])) end = back - 1
  }
  while (end > 0 && /\s/u.test(flat[end - 1])) end -= 1
  return `${flat.slice(0, Math.max(1, end)).join('')}…`
}

/**
 * A native notification draws plain text only. A table leaves its pipes and
 * alignment row, a fence leaves its backticks, and emphasis leaves its marks,
 * so a raw Markdown reply reads as noise there. Keep the words, drop the marks.
 */
const INLINE_MARKS = [
  [/!\[([^\]]*)\]\([^)]*\)/gu, '$1'],
  [/\[([^\]]+)\]\([^)]*\)/gu, '$1'],
  [/^#{1,6}\s+/u, ''],
  [/^>\s?/u, ''],
  [/^(?:[-*+]|\d+[.)])\s+/u, ''],
  [/\*\*([^*]+)\*\*/gu, '$1'],
  [/(^|[^*])\*([^*\n]+)\*(?!\*)/gu, '$1$2'],
  [/(^|[^_])__([^_]+)__(?!_)/gu, '$1$2'],
  [/(^|[^\w\u3400-\u9fff])_([^_]+)_(?=[^\w]|$)/gu, '$1$2'],
  [/~~([^~]+)~~/gu, '$1'],
]

/**
 * Inline code is raw text: `a*b*c` and `__init__.py` must reach the banner
 * unchanged, so a placeholder holds each span while the emphasis rules run.
 */
const stripMarks = (line) => {
  const code = []
  let value = line.replace(/`+([^`]*)`+/gu, (_, inner) => {
    code.push(inner)
    return `\u0000${code.length - 1}\u0000`
  })
  // Twice: a bold span can hold an italic one, and the first pass uncovers it.
  for (let pass = 0; pass < 2; pass += 1) {
    value = INLINE_MARKS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), value)
  }
  return value.replace(/\u0000(\d+)\u0000/gu, (_, index) => code[Number(index)] ?? '')
}

const DELIMITER_ROW = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u

const plainText = (text) => {
  const lines = String(text ?? '')
    .replace(/```[^\n]*\n[\s\S]*?```/gu, '\n')
    .replace(/~~~[^\n]*\n[\s\S]*?~~~/gu, '\n')
    // An unclosed fence runs to the end of the reply.
    .replace(/(?:^|\n)[ \t]*(?:```|~~~)[\s\S]*$/u, '\n')
    .split('\n')
    .map(line => line.trim())
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '') {
      kept.push('')
      continue
    }
    if (DELIMITER_ROW.test(line)) {
      // The header sits on the line before, the rows after. Markdown does not
      // require a leading pipe on either, so the delimiter row is the signal.
      if (kept.length > 0 && kept[kept.length - 1].includes('|')) kept.pop()
      while (index + 1 < lines.length && lines[index + 1].includes('|')) index += 1
      continue
    }
    if (line.startsWith('|')) continue
    if (/^[-*_]{3,}$/u.test(line)) continue
    kept.push(line)
  }
  return kept
    .map(line => collapse(stripMarks(line)))
    .filter(line => line !== '')
    .join(' ')
}

const CJK = /[\u3400-\u9fff]/u
const ENGLISH_STOP = /^(?:\s+["“（(A-Z]|\s*$)/u
const CHINESE_STOP = /^\s+[\u3400-\u9fff]/u
const ALNUM_END = /[A-Za-z0-9]$/u
// The stop must follow a whole word: `1st.` must not read as the title `st.`
// just because the digits in front are not letters.
const WORD_BEFORE_DOT = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z.]*)$/u

/**
 * Titles, Latin abbreviations and dotted proper nouns never end an English
 * sentence, so `Dr. Smith` and `U.S. Army` keep going. The list stays short on
 * purpose: an ordinary word such as `no.` must still close the sentence.
 */
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'st', 'mt', 'rev', 'gen', 'col', 'sgt', 'hon',
  'e.g', 'i.e', 'etc', 'vs', 'cf', 'al', 'viz',
  'u.s', 'u.k', 'a.m', 'p.m',
  'fig', 'eq', 'ref', 'inc', 'ltd', 'corp', 'dept',
  'ph.d', 'approx', 'bros', 'esq',
])

const abbreviationBefore = (head) => {
  const word = head.match(WORD_BEFORE_DOT)?.[1].toLowerCase()
  return word !== undefined && ABBREVIATIONS.has(word)
}

/**
 * The first stop that `accepts` allows, unless the word before it is an
 * abbreviation: then the stop is not an end and the scan moves on. The check
 * covers every rule, so a title that a Chinese word follows does not cut there
 * either.
 */
const dotEnd = (text, accepts) => {
  for (let dot = text.indexOf('.'); dot !== -1; dot = text.indexOf('.', dot + 1)) {
    const head = text.slice(0, dot)
    if (!accepts(head, text.slice(dot + 1))) continue
    if (abbreviationBefore(head)) continue
    return `${head}.`
  }
  return null
}

// An English stop closes a sentence only while the words before it are English.
const englishDotEnd = text => dotEnd(
  text, (head, tail) => !CJK.test(head) && ENGLISH_STOP.test(tail),
)

// A stop in English that a Chinese word follows still ends the English part.
const chineseDotEnd = text => dotEnd(
  text, (head, tail) => ALNUM_END.test(head) && CHINESE_STOP.test(tail),
)

/**
 * A notification gets one line of attention. Cut at the first sentence end, and
 * keep whichever rule ends soonest.
 *
 * A full stop, question mark or exclamation mark in full width always ends a
 * sentence. An ASCII one does only before a space, the end, or Chinese text, so
 * the question mark in `a?b=1` stays. An English full stop ends a sentence only
 * when the words before it are English, and never right after a title or a Latin
 * abbreviation, so `Dr. Smith` and `vs. B` keep going. One that a Chinese
 * sentence follows still ends the English part, as in `Bumped to v1.2. 已发版。`.
 */
const firstSentence = (text) => {
  const endings = [
    text.match(/^[^。！？]*[。！？]/u)?.[0],
    text.match(/^[^。！？!?]*[!?](?=\s|$|[\u3400-\u9fff])/u)?.[0],
    englishDotEnd(text),
    chineseDotEnd(text),
  ].filter(value => typeof value === 'string')
  return endings.reduce((best, value) => (value.length < best.length ? value : best), text)
}

/**
 * The banner body for a completed turn: plain text, the first sentence unless
 * it is too short to say anything. A polite opening such as `好的，` stays.
 */
const replyBody = (text) => {
  const plain = plainText(text)
  const first = firstSentence(plain)
  return Array.from(first).length < MIN_BODY ? plain : first
}

/**
 * DSH sends a localized approval reason next to the raw one. Keep both: the
 * page picks its locale, while `reason` remains the fallback for a page that
 * has no translation.
 */
const displayReasonOf = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const [locale, text] of Object.entries(value)) {
    if (typeof text !== 'string') continue
    const plain = clip(plainText(text))
    if (plain !== '') out[locale] = plain
  }
  return Object.keys(out).length === 0 ? undefined : out
}

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
  if (sessions === undefined) return

  const sessionOf = sessionId => sessions?.get(sessionId)

  const isSubagent = (sessionId) => {
    const session = sessionOf(sessionId)
    if (session === undefined) return true
    const header = session.header
    return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
  }

  const notifyable = sessionId => typeof sessionId === 'string' && !isSubagent(sessionId)

  let reportedMissingTitles = false

  /**
   * The title service injects more than the session store, so it can become
   * active after this plugin; read it per notification instead of at apply, or
   * the handle stays undefined and every banner shows the app name. Say so once
   * in the log: this fallback is otherwise indistinguishable from a title.
   */
  const titleOf = (sessionId) => {
    const session = sessionOf(sessionId)
    if (session === undefined) return APP_NAME
    const titles = ctx.get('sessionTitle')
    if (titles === undefined) {
      if (!reportedMissingTitles) {
        reportedMissingTitles = true
        ctx.logger.debug('session-bell: no session title service; notifications show the app name')
      }
      return APP_NAME
    }
    const title = titles.get(session)?.title
    return typeof title === 'string' && title.trim() !== '' ? clip(title, TITLE_LIMIT) : APP_NAME
  }

  const lastAssistantText = (sessionId) => {
    const session = sessionOf(sessionId)
    if (session === undefined) return ''
    const events = session.ownEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'assistant/message') continue
      const blocks = event.data?.message?.content
      if (!Array.isArray(blocks)) continue
      // The last text block is the reply. Earlier ones are narration before a
      // tool call, which would read as the result when it is only a preamble.
      for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
        const block = blocks[blockIndex]
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          return block.text.slice(0, REPLY_LIMIT)
        }
      }
    }
    return ''
  }

  const describe = (kind, sessionId, body, meta) => ({
    kind,
    sessionId,
    title: titleOf(sessionId),
    body: clip(body),
    ...(meta === undefined ? {} : { meta }),
    time: Date.now(),
  })

  const errorText = (error) => {
    if (typeof error === 'string') return error
    if (typeof error?.message === 'string') return error.message
    return ''
  }

  const pending = new Map()
  // A turn/start invalidates an in-flight completion check, not just its timer.
  const generation = new Map()

  const clearPending = (sessionId) => {
    generation.set(sessionId, (generation.get(sessionId) ?? 0) + 1)
    const timer = pending.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    pending.delete(sessionId)
  }

  /**
   * A goal keeps driving the same Session round after round; every round ends
   * with `completed` while the goal is active. Only the last round is news.
   *
   * Suppress only when the next goal round is already in the inbox. An active
   * goal alone is not enough evidence: if the round driver is disabled or has
   * stopped, nothing will start another turn, and suppressing every completion
   * would silence the Session until the goal is paused or completed.
   */
  const goalRoundQueued = (sessionId) => {
    const agents = ctx.get('agents')
    const goals = ctx.get('goals')
    if (agents === undefined || goals === undefined) return false
    try {
      const agent = agents.get(sessionId)
      if (agent === undefined) return false
      const goal = goals.get(agent)
      if (goal === undefined || goal === null) return false
      if (goal.phase !== 'active' || goal.activation !== 'armed') return false
      if (typeof goal.roundsStarted !== 'number' || typeof goal.maxGoalRounds !== 'number') return false
      if (goal.roundsStarted >= goal.maxGoalRounds) return false
      const inbox = agent.inbox
      if (inbox === undefined || inbox === null) return false
      const queued = [...(inbox.nextTurn ?? []), ...(inbox.nextStep ?? [])]
      return queued.some((message) => {
        const source = message?.source
        return source?.kind === 'goal'
          && typeof source.round === 'number'
          && source.round > 0
          && (typeof goal.id !== 'string' || source.goalId === goal.id)
      })
    } catch {
      return false
    }
  }

  /**
   * A turn can end while a subagent or a background job still works for the
   * same Session. The finished turn itself still reports as `turn`, so only the
   * other kinds block the notification. A schedule is not blocking: DSH answers
   * with every enabled schedule, not only a running one, so a recurring reminder
   * would silence the Session forever. A schedule that starts a turn cancels the
   * pending notification through `turn/start`.
   */
  const hasRunningWork = async (sessionId) => {
    if (typeof ctx.waterfall !== 'function') return false
    try {
      const activity = await ctx.waterfall.call(
        ctx,
        'workspace/session-activity',
        { sessionId },
        () => Promise.resolve([]),
      )
      if (!Array.isArray(activity)) return false
      return activity.some(entry => entry?.kind === 'subagent' || entry?.kind === 'job')
    } catch {
      // Never silence a notification because the activity service is missing.
      return false
    }
  }

  const scheduleTurnEnd = (sessionId, body) => {
    clearPending(sessionId)
    const token = generation.get(sessionId)
    const timer = setTimeout(async () => {
      pending.delete(sessionId)
      if (!notifyable(sessionId)) return
      if (goalRoundQueued(sessionId)) return
      if (await hasRunningWork(sessionId)) return
      if (generation.get(sessionId) !== token) return
      push(describe('turn-end', sessionId, body, { status: 'completed' }))
    }, NOTIFY_DELAY_MS)
    timer.unref?.()
    pending.set(sessionId, timer)
  }

  const onTurnEnd = (sessionId, reason) => {
    const kind = reason?.kind
    if (kind === 'completed') {
      scheduleTurnEnd(sessionId, replyBody(lastAssistantText(sessionId)))
      return
    }
    if (kind === 'error') {
      const message = errorText(reason.error)
      const meta = message.trim() === ''
        ? { status: 'error' }
        : { status: 'error', error: clip(plainText(message), ERROR_LIMIT) }
      push(describe('turn-end', sessionId, '', meta))
      return
    }
    if (kind === 'max-tokens') {
      push(describe('turn-end', sessionId, '', { status: 'max-tokens' }))
    }
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!notifyable(sessionId)) return
    if (event?.type === 'turn/start') {
      clearPending(sessionId)
      return
    }
    if (event?.type !== 'turn/end') return
    onTurnEnd(sessionId, event.data?.reason)
  })

  ctx.effect(() => () => {
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
  })

  ctx.on('user-questions/request', (request, next) => {
    const sessionId = request?.agent?.id
    if (notifyable(sessionId)) {
      const question = request?.questions?.[0]?.question
      push(describe('question', sessionId, typeof question === 'string' ? plainText(question) : ''))
    }
    return typeof next === 'function' ? next() : undefined
  }, { prepend: true })

  ctx.on('approval/request', (request, next) => {
    const sessionId = request?.agent?.id
    if (notifyable(sessionId)) {
      const meta = {}
      const toolName = request?.toolName
      if (typeof toolName === 'string') meta.toolName = clip(toolName)
      const reason = request?.reason
      if (typeof reason === 'string' && reason.trim() !== '') meta.reason = clip(plainText(reason))
      const displayReason = displayReasonOf(request?.displayReason)
      if (displayReason !== undefined) meta.displayReason = displayReason
      push(describe('approval', sessionId, '', Object.keys(meta).length === 0 ? undefined : meta))
    }
    return typeof next === 'function' ? next() : undefined
  }, { prepend: true })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
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
      })
      return () => {
        dispose?.()
        for (const stream of streams) {
          try {
            stream.end()
          } catch {
            // The connection is already gone.
          }
        }
        streams.clear()
      }
    })
  })
}
