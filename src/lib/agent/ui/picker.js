// In-frame element/text picker for the siteio in-site editor. This script runs
// INSIDE the framed live site (injected by the editor shell in Phase 1; served
// via a document-injection proxy in Phase 2) and talks to the shell ONLY over
// window.postMessage — never direct DOM calls — so it is identical before and
// after the shell/site origin split. See
// docs/plans/2026-08-23-in-site-editor-element-picker.md.
//
// Protocol
//   shell → frame:  { source:"siteio-shell", type:"pick-mode", on:<bool> }
//                   { source:"siteio-shell", type:"clear" }
//   frame → shell:  { source:"siteio-picker", type:"ready" }
//                   { source:"siteio-picker", type:"target", target:<ChatTarget> }
//                   { source:"siteio-picker", type:"cancel" }
//
// The highlight/overlay is drawn here, in native frame coordinates, so it
// survives the cross-origin split (the parent never paints over the iframe).
;(function () {
  "use strict"
  // Idempotent: the shell re-injects on every frame (re)load; bail if we're
  // already live in this document.
  if (window.__siteioPickerLive) return
  window.__siteioPickerLive = true

  var MAX_TEXT = 500
  var MAX_HTML = 800
  var STYLE_KEYS = [
    "color",
    "backgroundColor",
    "fontSize",
    "fontWeight",
    "fontFamily",
    "textAlign",
    "lineHeight",
  ]

  // Where to send messages back to the shell. Learned from the first inbound
  // shell message's origin (referrer is stripped by the shell's no-referrer
  // policy, so we can't derive it up front). "*" until then — only structured,
  // non-sensitive target data ever flows this way.
  var shellOrigin = "*"
  var pickMode = false

  function truncate(s, n) {
    s = s == null ? "" : String(s)
    return s.length > n ? s.slice(0, n - 1) + "…" : s
  }
  function collapse(s) {
    return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim()
  }
  function cssIdent(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s)
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&")
  }
  function isUnique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1
    } catch (e) {
      return false
    }
  }

  // Build a selector that resolves back to `node`. Preference order per the plan:
  // a unique #id, then a unique tag.class on the leaf, then a short nth-of-type
  // path walked up until the accumulated path is unique. "Good enough to
  // disambiguate" beats a brittle full path; `text` is the real anchor.
  function selectorFor(node) {
    if (!node || node.nodeType !== 1) return ""
    if (node.id) {
      var byId = "#" + cssIdent(node.id)
      if (isUnique(byId)) return byId
    }
    if (node.classList && node.classList.length) {
      var tag = node.tagName.toLowerCase()
      for (var i = 0; i < node.classList.length; i++) {
        var withClass = tag + "." + cssIdent(node.classList[i])
        if (isUnique(withClass)) return withClass
      }
    }
    var parts = []
    var cur = node
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var seg = cur.tagName.toLowerCase()
      var parent = cur.parentElement
      if (parent) {
        var sameTag = []
        for (var c = 0; c < parent.children.length; c++) {
          if (parent.children[c].tagName === cur.tagName) sameTag.push(parent.children[c])
        }
        if (sameTag.length > 1) seg += ":nth-of-type(" + (sameTag.indexOf(cur) + 1) + ")"
      }
      parts.unshift(seg)
      if (isUnique(parts.join(" > "))) break
      cur = parent
    }
    return parts.join(" > ")
  }

  function styleSubset(node) {
    var out = {}
    try {
      var cs = getComputedStyle(node)
      for (var i = 0; i < STYLE_KEYS.length; i++) {
        var v = cs[STYLE_KEYS[i]]
        if (v) out[STYLE_KEYS[i]] = truncate(v, 120)
      }
    } catch (e) {
      /* ignore */
    }
    return out
  }

  function captureElement(node) {
    return {
      kind: "element",
      selector: selectorFor(node),
      tag: node.tagName.toLowerCase(),
      text: truncate(collapse(node.innerText || node.textContent), MAX_TEXT),
      outerHTML: truncate(node.outerHTML || "", MAX_HTML),
      styles: styleSubset(node),
    }
  }

  function captureText(selectedText, node) {
    return {
      kind: "text",
      selector: node ? selectorFor(node) : "",
      tag: node ? node.tagName.toLowerCase() : undefined,
      text: truncate(collapse(selectedText), MAX_TEXT),
      styles: node ? styleSubset(node) : {},
    }
  }

  function post(msg) {
    msg.source = "siteio-picker"
    try {
      window.parent.postMessage(msg, shellOrigin)
    } catch (e) {
      /* parent gone */
    }
  }

  // --- overlay (highlight box + text-edit affordance) ----------------------
  var highlight = null
  var textBtn = null

  function ensureOverlay() {
    if (highlight) return
    highlight = document.createElement("div")
    highlight.setAttribute("data-siteio-overlay", "highlight")
    highlight.style.cssText =
      "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2563eb;" +
      "background:rgba(37,99,235,.12);border-radius:3px;display:none;box-shadow:0 0 0 1px rgba(255,255,255,.6);"
    document.documentElement.appendChild(highlight)
  }

  function showHighlight(rect) {
    ensureOverlay()
    highlight.style.display = "block"
    highlight.style.left = rect.left + "px"
    highlight.style.top = rect.top + "px"
    highlight.style.width = rect.width + "px"
    highlight.style.height = rect.height + "px"
  }
  function hideHighlight() {
    if (highlight) highlight.style.display = "none"
  }

  // An element we injected (overlay/affordance) should never be a pick target.
  function isOurs(node) {
    return !!(node && node.closest && node.closest("[data-siteio-overlay]"))
  }

  // --- pick mode (crosshair) ----------------------------------------------
  function onMove(ev) {
    if (!pickMode) return
    var node = ev.target
    if (!node || node.nodeType !== 1 || isOurs(node)) return hideHighlight()
    showHighlight(node.getBoundingClientRect())
  }

  function onClick(ev) {
    if (!pickMode) return
    ev.preventDefault()
    ev.stopPropagation()
    var node = ev.target
    if (!node || node.nodeType !== 1 || isOurs(node)) return
    post({ type: "target", target: captureElement(node) })
    setPickMode(false)
  }

  function onKey(ev) {
    if (pickMode && ev.key === "Escape") {
      setPickMode(false)
      post({ type: "cancel" })
    }
  }

  function setPickMode(on) {
    pickMode = !!on
    hideHighlight()
    // A live "edit this text" affordance would otherwise float over the page in
    // crosshair mode as a dead zone (its node is ours, so it can't be picked).
    if (pickMode && textBtn) textBtn.style.display = "none"
    document.documentElement.style.cursor = pickMode ? "crosshair" : ""
  }

  // --- text selection (works without the crosshair toggle) -----------------
  function ensureTextBtn() {
    if (textBtn) return
    textBtn = document.createElement("button")
    textBtn.setAttribute("data-siteio-overlay", "text-edit")
    textBtn.type = "button"
    textBtn.textContent = "✎ Edit this text"
    textBtn.style.cssText =
      "position:fixed;z-index:2147483647;display:none;border:0;border-radius:8px;" +
      "background:#2563eb;color:#fff;font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "padding:7px 10px;cursor:pointer;box-shadow:0 4px 14px rgba(15,23,42,.28);"
    textBtn.addEventListener("click", function (ev) {
      ev.preventDefault()
      ev.stopPropagation()
      commitTextSelection()
    })
    // mousedown must not clear the selection before the click fires.
    textBtn.addEventListener("mousedown", function (ev) {
      ev.preventDefault()
    })
    document.documentElement.appendChild(textBtn)
  }

  function currentSelection() {
    var sel = window.getSelection && window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
    var str = collapse(sel.toString())
    if (!str) return null
    return sel
  }

  function selectionAnchorNode(sel) {
    var node = sel.anchorNode
    if (node && node.nodeType !== 1) node = node.parentElement
    return node && node.nodeType === 1 ? node : null
  }

  function onSelectionChange() {
    if (pickMode) return
    var sel = currentSelection()
    if (!sel) {
      if (textBtn) textBtn.style.display = "none"
      return
    }
    ensureTextBtn()
    var rect = sel.getRangeAt(0).getBoundingClientRect()
    textBtn.style.display = "block"
    // Offer the affordance just below the selection, clamped into view.
    var top = Math.min(rect.bottom + 6, window.innerHeight - 40)
    var left = Math.max(6, Math.min(rect.left, window.innerWidth - 140))
    textBtn.style.top = top + "px"
    textBtn.style.left = left + "px"
  }

  function commitTextSelection() {
    var sel = currentSelection()
    if (!sel) return
    var node = selectionAnchorNode(sel)
    post({ type: "target", target: captureText(sel.toString(), node) })
    if (textBtn) textBtn.style.display = "none"
    try {
      sel.removeAllRanges()
    } catch (e) {
      /* ignore */
    }
  }

  // --- shell messages ------------------------------------------------------
  window.addEventListener("message", function (ev) {
    // Only the shell (our parent window) may drive the picker — so a co-resident
    // or sub-framed script on the (untrusted, Phase 2) host can't force pick mode
    // or poison shellOrigin. Mirrors the shell's own ev.source check.
    if (ev.source !== window.parent) return
    var data = ev.data
    if (!data || data.source !== "siteio-shell") return
    // Learn (and thereafter trust) the shell origin from its own messages.
    if (ev.origin && ev.origin !== "null") shellOrigin = ev.origin
    if (data.type === "pick-mode") setPickMode(data.on)
    else if (data.type === "clear") {
      setPickMode(false)
      if (textBtn) textBtn.style.display = "none"
    }
  })

  document.addEventListener("mousemove", onMove, true)
  document.addEventListener("click", onClick, true)
  document.addEventListener("keydown", onKey, true)
  document.addEventListener("selectionchange", onSelectionChange)

  // Exposed for tests/debugging only — the picker's real captures use the
  // closure functions above, so overriding this object can't spoof a target.
  window.__siteioPicker = {
    selectorFor: selectorFor,
    captureElement: captureElement,
    captureText: captureText,
    styleSubset: styleSubset,
  }

  post({ type: "ready" })
})()
