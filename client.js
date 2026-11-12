window.__ModuleLoader__.load({
  id: 'dsh-session-bell',
  factory() {
    return {
      inject: ['uiWorkspace'],
      apply(ctx) {
        if (typeof Notification === 'undefined') return
        if (Notification.permission === 'default') {
          Notification.requestPermission?.().catch(() => {})
        }
        let warned = false

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
          if (Notification.permission === 'denied') {
            if (!warned) {
              warned = true
              console.warn('[session-bell] notifications are denied for DeepSeek Harness')
            }
            return
          }
          const notification = new Notification(payload.title || 'DeepSeek Harness', {
            body: payload.body || '',
            tag: payload.sessionId,
          })
          notification.onclick = () => {
            open(payload.sessionId)
            notification.close()
          }
        }

        ctx.effect(() => {
          const source = new EventSource('/session-bell/events')
          source.onmessage = (event) => {
            try {
              show(JSON.parse(event.data))
            } catch {
              // A malformed frame must not close the stream.
            }
          }
          return () => source.close()
        })
      },
    }
  },
})
