/* houlahop shared animated terminal.
   Usage:
     <div class="hh-term">
       <div class="hh-term-bar"><span class="hh-term-dot"></span>×3</div>
       <pre class="hh-term-body" data-hh-terminal></pre>
     </div>
     <script>window.hhTerminalFrames = [{ cmd: "...", output: ["..."] }];</script>
     <script src="hh-terminal.js"></script>
   Types each command, prints output line by line, holds, then loops.
   prefers-reduced-motion renders the first frame statically. */

(function () {
  var el = document.querySelector("[data-hh-terminal]");
  var frames = window.hhTerminalFrames || [];
  if (!el || !frames.length) return;

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }

  function render(frame, typedLen, outCount, cursor) {
    var head = '<span class="hh-term-prompt">$</span> ' + esc(frame.cmd.slice(0, typedLen));
    if (cursor) head += '<span class="hh-term-cursor">▍</span>';
    var lines = [head];
    for (var n = 0; n < outCount; n++) {
      lines.push('<span class="hh-term-dim">' + esc(frame.output[n]) + "</span>");
    }
    el.innerHTML = lines.join("\n");
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    render(frames[0], frames[0].cmd.length, frames[0].output.length, false);
    return;
  }

  var fi = 0;
  function playFrame() {
    var frame = frames[fi % frames.length];
    fi++;
    var i = 0;
    function typeChar() {
      render(frame, i, 0, true);
      if (i < frame.cmd.length) {
        i++;
        setTimeout(typeChar, 28 + Math.random() * 45);
      } else {
        setTimeout(function () { printOut(0); }, 300);
      }
    }
    function printOut(n) {
      render(frame, frame.cmd.length, n, false);
      if (n < frame.output.length) {
        setTimeout(function () { printOut(n + 1); }, 90);
      } else {
        setTimeout(playFrame, 3800);
      }
    }
    typeChar();
  }
  playFrame();
})();
