/**
 * Host half of the session notify plugin.
 *
 * It turns three Host events into Server-Sent Events on one Web route: a turn
 * that is about to close, a question that waits for a human answer, and an
 * approval that waits for a human decision. The Client half raises the native
 * notification, so macOS shows DeepSeek Harness as the sender and a click can
 * select that Session.
 *
 * Subagent Sessions are skipped for all three events: their parent turn still
 * reports.
 */

const ROUTE_PATH = '/session-bell/events'
const HEARTBEAT_MS = 20_000
const BODY_LIMIT = 80

export const inject = ['sessions']

const collapse = text => String(text ?? '').replace(/\s+/gu, ' ').trim()

const clip = (text) => {
  const flat = Array.from(collapse(text))
  return flat.length <= BODY_LIMIT ? flat.join('') : `${flat.slice(0, BODY_LIMIT - 1).join('')}…`
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
  if (sessions === undefined) return
  const sessionTitle = ctx.get('sessionTitle')

  const sessionOf = sessionId => sessions?.get(sessionId)

  const isSubagent = (sessionId) => {
    const session = sessionOf(sessionId)
    if (session === undefined) return true
    const header = session.header
    return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
  }

  const notifyable = sessionId => typeof sessionId === 'string' && !isSubagent(sessionId)

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

  const describe = (kind, sessionId, body, meta) => ({
    kind,
    sessionId,
    title: titleOf(sessionId),
    body: clip(body),
    ...(meta === undefined ? {} : { meta }),
    time: Date.now(),
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent === undefined || !notifyable(agent.id)) return
    push(describe('turn-end', agent.id, firstSentence(plainText(lastAssistantText(agent.id)))))
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
      const toolName = request?.toolName
      push(describe('approval', sessionId, '', typeof toolName === 'string' ? { toolName: clip(toolName) } : undefined))
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
