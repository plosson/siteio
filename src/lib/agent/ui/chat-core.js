// Shared, framework-agnostic core for the siteio AI chat editor. Consumed by
// BOTH the admin panel (Alpine) and the in-site editor shell (vanilla JS). It
// owns only the fiddly SSE transport — a POST that returns a `text/event-stream`
// body, read incrementally and split into `ChatEvent`s — and knows nothing about
// how either UI renders them. Attaches to `window.SiteioChat`.
;(function (global) {
  // Parse one raw SSE frame (the text between blank lines) into ChatEvent
  // objects. `: ping` heartbeat comment lines carry no `data:` and are skipped.
  function parseFrame(frame) {
    var events = []
    var lines = frame.split("\n")
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (line.indexOf("data:") !== 0) continue
      var json = line.slice(5).trim()
      if (!json) continue
      try {
        events.push(JSON.parse(json))
      } catch (e) {
        /* ignore a partial/garbled frame */
      }
    }
    return events
  }

  // POST a chat turn and stream its events to `onEvent` until the stream ends.
  // Resolves `{ ok: true }` on normal completion or `{ ok: false, status }` for a
  // non-OK response (e.g. 401 expiry, 429 cap). Rejects only on a network/stream
  // failure — the turn keeps running server-side, so callers resync from history.
  //
  // opts: { url, headers?, body?, onEvent, credentials?, signal? }
  async function streamTurn(opts) {
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {})
    var res = await fetch(opts.url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(opts.body || {}),
      credentials: opts.credentials || "same-origin",
      signal: opts.signal,
    })
    if (!res.ok || !res.body) return { ok: false, status: res.status }

    var reader = res.body.getReader()
    var dec = new TextDecoder()
    var buf = ""
    while (true) {
      var chunk = await reader.read()
      if (chunk.done) break
      buf += dec.decode(chunk.value, { stream: true })
      var idx
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        var frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        var events = parseFrame(frame)
        for (var i = 0; i < events.length; i++) opts.onEvent(events[i])
      }
    }
    return { ok: true }
  }

  global.SiteioChat = { streamTurn: streamTurn }
})(window)
