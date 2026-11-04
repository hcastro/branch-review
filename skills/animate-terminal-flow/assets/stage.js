/*
 * stage.js: shared helpers for the branch-review promo scenes.
 *
 * - Stage.look: the active look ('night' | 'paper' | 'grid'), from assets/js/look.js.
 * - Stage.grid(el, key, opts): mounts a captured terminal (window.CAPTURES[key]) with
 *   TerminalGrid at the film's cell size (18 x 38 CSS px, JetBrains Mono 30 px), so a
 *   read at scale 1 has 38 px lines (3.5% of 1080).
 * - Stage.play(tl, grid, from, to, at, dur): plays capture time from..to over dur seconds,
 *   starting at `at` on the timeline (linear, through a proxy tween's onUpdate).
 * - Stage.hold(tl, grid, t, at): shows capture time t from `at` on.
 * - Stage.find(key, t, re): the cell {row, col, len} of the first match of re on screen at t.
 * - Stage.fit(rect, box): the camera {x, y, scale} that fits a CSS-px rect into a frame box.
 * Everything is a function of timeline time: no clocks, no randomness.
 */
(function (global) {
  'use strict';

  var CELL_W = 18;
  var CELL_H = 38;
  var FONT = '"JetBrains Mono", monospace';

  var THEMES = {
    // The recorded theme: branch-review's own fallback background and palette.
    recorded: null,
    // A light terminal for the paper look's agent card (palette-only text recolors cleanly).
    light: {
      fg: '#1f1d1a', bg: '#FDFDFD', cursor: '#D67554',
      palette: ['#1f1d1a', '#b4232a', '#2f7d3a', '#8a6100', '#1f5fae', '#7a3fb0', '#1c7c83', '#5c5650',
        '#8a8580', '#c9473c', '#3b9149', '#a87a12', '#3a77c4', '#9254c8', '#2a8c93', '#131110'],
    },
  };

  function capture(key) {
    var c = global.CAPTURES && global.CAPTURES[key];
    if (!c) throw new Error('capture not loaded: ' + key);
    return c;
  }

  function grid(el, key, opts) {
    opts = opts || {};
    var c = capture(key);
    return global.TerminalGrid.mount(el, {
      frames: c.frames,
      images: c.images,
      theme: opts.theme || undefined,
      fontFamily: FONT,
      fontSize: 30,
      cellWidth: CELL_W,
      cellHeight: CELL_H,
      imageBase: 'assets/captures/' + key + '/',
      cursor: opts.cursor !== false,
      start: opts.start || 0,
    });
  }

  function play(tl, g, from, to, at, dur, ease) {
    var proxy = {t: from};
    tl.fromTo(proxy, {t: from}, {
      t: to, duration: dur, ease: ease || 'none',
      onUpdate: function () { g.seek(proxy.t); },
    }, at);
    return proxy;
  }

  // One driver per grid for the whole scene: keys are [sceneTime, captureTime] pairs,
  // linear between keys and held outside them, so any seek lands on the same frame.
  function drive(tl, g, keys, dur) {
    keys = keys.slice().sort(function (a, b) { return a[0] - b[0]; });
    function map(p) {
      if (p <= keys[0][0]) return keys[0][1];
      for (var i = 1; i < keys.length; i++) {
        if (p <= keys[i][0]) {
          var a = keys[i - 1], b = keys[i];
          var span = b[0] - a[0];
          return span <= 0 ? b[1] : a[1] + (b[1] - a[1]) * (p - a[0]) / span;
        }
      }
      return keys[keys.length - 1][1];
    }
    var proxy = {p: 0};
    tl.fromTo(proxy, {p: 0}, {p: dur, duration: dur, ease: 'none', onUpdate: function () { g.seek(map(proxy.p)); }}, 0);
    g.seek(map(0));
    return map;
  }

  function hold(tl, g, t, at) {
    var proxy = {t: t};
    tl.fromTo(proxy, {t: t}, {t: t, duration: 0.001, onUpdate: function () { g.seek(t); }, onStart: function () { g.seek(t); }}, at);
  }

  function rowText(cap, frame, y) {
    var idx = frame.r[y];
    if (idx === undefined || idx < 0) return '';
    var runs = cap.lines[idx];
    var out = [];
    runs.forEach(function (run) {
      var col = run[0], width = run[1], str = run[2] || '', glyphW = run[4];
      if (glyphW) {
        var n = Math.max(1, Math.round(width / glyphW));
        for (var k = 0; k < n; k++) out[col + k * glyphW] = str;
        return;
      }
      for (var i = 0; i < str.length; i++) out[col + i] = str[i];
    });
    var s = '';
    for (var x = 0; x < out.length; x++) s += out[x] === undefined ? ' ' : out[x];
    return s;
  }

  function frameAtCap(cap, t) {
    var frames = cap.frames, lo = 0, hi = frames.length - 1;
    if (!frames.length || t < frames[0].t) return null;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (frames[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return frames[lo];
  }

  function find(key, t, re, startRow) {
    var cap = capture(key).frames;
    var frame = frameAtCap(cap, t);
    if (!frame) return null;
    for (var y = startRow || 0; y < frame.r.length; y++) {
      var s = rowText(cap, frame, y);
      var m = s.match(re);
      if (m) return {row: y, col: m.index, len: m[0].length, text: s};
    }
    return null;
  }

  function cells(col, row, cols, rows) {
    return {x: col * CELL_W, y: row * CELL_H, width: cols * CELL_W, height: rows * CELL_H};
  }

  // Fit rect (CSS px inside the grid) into box {x, y, width, height} of the 1920 x 1080 frame.
  // Returns the transform for a wrapper with transform-origin 0 0: translate(x, y) scale(s).
  function fit(rect, box, maxScale) {
    var s = Math.min(box.width / rect.width, box.height / rect.height);
    if (maxScale) s = Math.min(s, maxScale);
    var x = box.x + (box.width - rect.width * s) / 2 - rect.x * s;
    var y = box.y + (box.height - rect.height * s) / 2 - rect.y * s;
    return {x: Math.round(x), y: Math.round(y), scale: Math.round(s * 1000) / 1000};
  }

  // A camera pose that puts rect at scale s with its center at (cx, cy) in the frame.
  function at(rect, s, cx, cy) {
    return {
      x: Math.round(cx - (rect.x + rect.width / 2) * s),
      y: Math.round(cy - (rect.y + rect.height / 2) * s),
      scale: s,
    };
  }

  var FRAME = {x: 0, y: 0, width: 1920, height: 1080};

  // ---- the look's mark on a run of cells ------------------------------------
  // night: a teal-to-violet bar drawn left to right under the text.
  // paper: a hand-drawn clay loop around it (fixed wobble, so every render matches).
  // grid: the cells themselves light up one by one.
  function mark(container, col, row, len, opts) {
    opts = opts || {};
    var look = global.LOOK || 'night';
    var color = opts.color || 'var(--accent)';
    var x = col * CELL_W, y = row * CELL_H, w = len * CELL_W, h = CELL_H;
    var el = document.createElement('div');
    el.className = 'mark mark-' + look;
    el.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:5';
    container.appendChild(el);
    var parts = [];
    if (look === 'paper') {
      var pad = 16, padY = 6;
      var W = w + pad * 2, H = h + padY * 2;
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', W + 40);
      svg.setAttribute('height', H + 40);
      svg.setAttribute('viewBox', '-20 -20 ' + (W + 40) + ' ' + (H + 40));
      svg.style.cssText = 'position:absolute;overflow:visible;left:' + (x - pad - 20) + 'px;top:' + (y - padY - 20) + 'px';
      // A loose ellipse that overshoots its start, like a marker loop.
      var cx = W / 2, cy = H / 2, rx = W / 2 + 6, ry = H / 2 + 4;
      var wob = [0, 2.5, -1.5, 3, -2, 1.5, -2.5, 2, -1, 2.5, -1.8, 1.2, 0.5, -1];
      var d = '';
      var steps = 52;
      for (var i = 0; i <= steps + 6; i++) {
        var a = -Math.PI * 0.62 + (i / steps) * Math.PI * 2;
        var k = wob[i % wob.length];
        var px = cx + (rx + k) * Math.cos(a);
        var py = cy + (ry + k * 0.6) * Math.sin(a) + (i / steps) * 6;
        d += (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
      }
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', opts.paperColor || color);
      path.setAttribute('stroke-width', '7');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      el.appendChild(svg);
      var lenPx = 0, prev = null;
      d.split(/(?=[ML])/).forEach(function (seg) {
        var p = seg.slice(1).split(' ').map(Number);
        if (prev) lenPx += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        prev = p;
      });
      path.style.strokeDasharray = lenPx;
      path.style.strokeDashoffset = lenPx;
      parts.push({kind: 'stroke', el: path, length: lenPx});
    } else if (look === 'grid') {
      for (var c = 0; c < len; c++) {
        var cell = document.createElement('div');
        cell.style.cssText = 'position:absolute;left:' + (x + c * CELL_W) + 'px;top:' + y + 'px;width:' + CELL_W + 'px;height:' + CELL_H + 'px;background:' + color + ';opacity:0;mix-blend-mode:screen';
        el.appendChild(cell);
        parts.push({kind: 'cell', el: cell});
      }
      var base = document.createElement('div');
      base.style.cssText = 'position:absolute;left:' + x + 'px;top:' + (y + h + 2) + 'px;width:' + w + 'px;height:4px;background:' + color + ';transform-origin:0 50%;transform:scaleX(0)';
      el.appendChild(base);
      parts.push({kind: 'bar', el: base});
    } else {
      var bar = document.createElement('div');
      bar.style.cssText = 'position:absolute;left:' + (x - 4) + 'px;top:' + (y + h - 2) + 'px;width:' + (w + 8) + 'px;height:7px;border-radius:4px;background:linear-gradient(90deg,' + (opts.from || '#5CD1DE') + ',' + (opts.to || '#CCAAFD') + ');transform-origin:0 50%;transform:scaleX(0)';
      el.appendChild(bar);
      parts.push({kind: 'bar', el: bar});
      var glowless = document.createElement('div');
      glowless.style.cssText = 'position:absolute;left:' + (x - 6) + 'px;top:' + (y - 2) + 'px;width:' + (w + 12) + 'px;height:' + (h + 4) + 'px;border-radius:6px;background:' + (opts.tint || 'rgba(86,212,221,0.16)') + ';opacity:0';
      el.insertBefore(glowless, bar);
      parts.push({kind: 'tint', el: glowless});
    }
    return {el: el, parts: parts};
  }

  function drawMark(tl, m, at, dur) {
    dur = dur || 0.45;
    m.parts.forEach(function (p, i) {
      if (p.kind === 'stroke') tl.fromTo(p.el, {strokeDashoffset: p.length}, {strokeDashoffset: 0, duration: dur * 1.6, ease: 'power2.inOut'}, at);
      else if (p.kind === 'cell') tl.fromTo(p.el, {opacity: 0}, {opacity: 0.38, duration: 0.001}, at + i / 30);
      else if (p.kind === 'bar') tl.fromTo(p.el, {scaleX: 0}, {scaleX: 1, duration: dur, ease: 'expo.out'}, at + (m.parts.length > 2 && m.parts[0].kind === 'cell' ? (m.parts.length - 1) / 30 : 0));
      else if (p.kind === 'tint') tl.fromTo(p.el, {opacity: 0}, {opacity: 1, duration: 0.25, ease: 'power2.out'}, at + 0.1);
    });
  }

  function clearMark(tl, m, at) {
    tl.to(m.el, {opacity: 0, duration: 0.15, ease: 'power2.in'}, at);
  }

  // ---- titles: per-word blur in, one accent word (*word*) ---------------------
  function title(el, text) {
    el.textContent = '';
    if ((global.LOOK || 'night') === 'grid') {
      // Cell grid: one span per character, so the line types in cell by cell.
      var accentOn = false;
      text.split('').forEach(function (ch) {
        if (ch === '*') { accentOn = !accentOn; return; }
        var c = document.createElement('span');
        c.textContent = ch;
        c.className = 'w' + (accentOn ? ' accent' : '');
        c.style.display = 'inline-block';
        c.style.whiteSpace = 'pre';
        el.appendChild(c);
      });
      return el.querySelectorAll('.w');
    }
    var words = text.split(' ');
    words.forEach(function (w, i) {
      var span = document.createElement('span');
      var accent = /^\*.*\*[.,]?$/.test(w);
      span.textContent = w.replace(/\*/g, '');
      span.className = 'w' + (accent ? ' accent' : '');
      span.style.display = 'inline-block';
      el.appendChild(span);
      if (i < words.length - 1) el.appendChild(document.createTextNode(' '));
    });
    return el.querySelectorAll('.w');
  }

  function titleIn(tl, el, at) {
    var words = el.querySelectorAll('.w');
    if ((global.LOOK || 'night') === 'grid') {
      tl.fromTo(words, {opacity: 0}, {opacity: 1, duration: 0.001, stagger: 1 / 30}, at);
      return;
    }
    tl.fromTo(words, {opacity: 0, filter: 'blur(8px)'}, {opacity: 1, filter: 'blur(0px)', duration: 0.16, ease: 'power3.out', stagger: 0.067}, at);
  }

  function titleOut(tl, el, at) {
    var words = el.querySelectorAll('.w');
    tl.to(words, {opacity: 0, filter: 'blur(8px)', duration: 0.14, ease: 'power2.in', stagger: 0.03}, at);
  }

  // ---- a key cap the viewer sees pressed -----------------------------------
  function keyIn(tl, el, at) {
    tl.fromTo(el, {opacity: 0, y: 26, scale: 0.9}, {opacity: 1, y: 0, scale: 1, duration: 0.35, ease: 'expo.out'}, at);
  }
  function keyPress(tl, el, at) {
    var face = el.querySelector('.face');
    tl.to(face, {y: 9, duration: 0.06, ease: 'power2.in'}, at);
    tl.to(face, {y: 0, duration: 0.14, ease: 'power3.out'}, at + 0.08);
  }
  function keyOut(tl, el, at) {
    tl.to(el, {opacity: 0, y: 14, duration: 0.18, ease: 'power2.in'}, at);
  }

  global.Stage = {
    look: global.LOOK || 'night',
    CELL_W: CELL_W, CELL_H: CELL_H, FONT: FONT, THEMES: THEMES, FRAME: FRAME,
    capture: capture, grid: grid, play: play, hold: hold, drive: drive, find: find, cells: cells, fit: fit, at: at,
    mark: mark, drawMark: drawMark, clearMark: clearMark,
    title: title, titleIn: titleIn, titleOut: titleOut,
    keyIn: keyIn, keyPress: keyPress, keyOut: keyOut,
  };
})(window);
