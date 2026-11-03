/*
 * render-grid.js: draws a terminal capture (frames.json + images.json from
 * cast-to-frames.mjs) as DOM on an exact cell grid. No dependencies, no
 * canvas, no bitmaps for text, so it stays crisp at any CSS scale.
 *
 *   const grid = TerminalGrid.mount(el, {
 *     frames,            // the frames.json object
 *     images,            // the images.json object (or its `images` array)
 *     theme,             // {fg, bg, cursor, palette: [16 colors]}; defaults to the recorded theme
 *     fontFamily, fontSize, lineHeight,   // lineHeight: a multiplier, or px when > 4
 *     cellWidth, cellHeight,              // optional: pin the cell in CSS px
 *     imageBase,         // URL prefix for image files (default '')
 *     cursor,            // draw the cursor when the app shows it (default true)
 *   });
 *   grid.seek(t);        // show the frame at time t (seconds); returns the frame index
 *   await grid.ready();  // resolves when the images on screen are decoded
 *
 * A HyperFrames timeline drives it with seek(), so every render of time t
 * is the same DOM.
 */
(function (global) {
  'use strict';

  var FONT = '"JetBrainsMono Nerd Font", "JetBrains Mono", "SF Mono", Menlo, monospace';

  function cube(i) {
    if (i < 232) {
      var n = i - 16;
      var steps = [0, 95, 135, 175, 215, 255];
      return rgb(steps[Math.floor(n / 36)], steps[Math.floor(n / 6) % 6], steps[n % 6]);
    }
    var v = 8 + (i - 232) * 10;
    return rgb(v, v, v);
  }

  function rgb(r, g, b) {
    return '#' + [r, g, b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }

  function parseHex(hex) {
    var h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function mix(a, b, amount) {
    var x = parseHex(a);
    var y = parseHex(b);
    return rgb.apply(null, x.map(function (v, i) { return Math.round(v + (y[i] - v) * amount); }));
  }

  function normalizeTheme(theme) {
    var palette = theme.palette;
    if (typeof palette === 'string') palette = palette.split(':');
    var out = {fg: theme.fg, bg: theme.bg, cursor: theme.cursor || theme.fg, palette: palette.slice(0, 16)};
    while (out.palette.length < 16) out.palette.push(out.palette[out.palette.length - 8] || out.fg);
    return out;
  }

  // ---- box drawing and block elements, drawn as divs ---------------------
  // Arms: [up, right, down, left]; 1 light, 2 heavy, 3 double.
  var BOX = {
    0x2500: [0, 1, 0, 1], 0x2501: [0, 2, 0, 2], 0x2502: [1, 0, 1, 0], 0x2503: [2, 0, 2, 0],
    0x250c: [0, 1, 1, 0], 0x250d: [0, 2, 1, 0], 0x250e: [0, 1, 2, 0], 0x250f: [0, 2, 2, 0],
    0x2510: [0, 0, 1, 1], 0x2511: [0, 0, 1, 2], 0x2512: [0, 0, 2, 1], 0x2513: [0, 0, 2, 2],
    0x2514: [1, 1, 0, 0], 0x2515: [1, 2, 0, 0], 0x2516: [2, 1, 0, 0], 0x2517: [2, 2, 0, 0],
    0x2518: [1, 0, 0, 1], 0x2519: [1, 0, 0, 2], 0x251a: [2, 0, 0, 1], 0x251b: [2, 0, 0, 2],
    0x251c: [1, 1, 1, 0], 0x251d: [1, 2, 1, 0], 0x2520: [2, 1, 2, 0], 0x2523: [2, 2, 2, 0],
    0x2524: [1, 0, 1, 1], 0x2525: [1, 0, 1, 2], 0x2528: [2, 0, 2, 1], 0x252b: [2, 0, 2, 2],
    0x252c: [0, 1, 1, 1], 0x252f: [0, 2, 1, 2], 0x2530: [0, 1, 2, 1], 0x2533: [0, 2, 2, 2],
    0x2534: [1, 1, 0, 1], 0x2537: [1, 2, 0, 2], 0x2538: [2, 1, 0, 1], 0x253b: [2, 2, 0, 2],
    0x253c: [1, 1, 1, 1], 0x253f: [1, 2, 1, 2], 0x2542: [2, 1, 2, 1], 0x254b: [2, 2, 2, 2],
    0x2550: [0, 3, 0, 3], 0x2551: [3, 0, 3, 0], 0x2552: [0, 3, 1, 0], 0x2553: [0, 1, 3, 0],
    0x2554: [0, 3, 3, 0], 0x2555: [0, 0, 1, 3], 0x2556: [0, 0, 3, 1], 0x2557: [0, 0, 3, 3],
    0x2558: [1, 3, 0, 0], 0x2559: [3, 1, 0, 0], 0x255a: [3, 3, 0, 0], 0x255b: [1, 0, 0, 3],
    0x255c: [3, 0, 0, 1], 0x255d: [3, 0, 0, 3], 0x255e: [1, 3, 1, 0], 0x255f: [3, 1, 3, 0],
    0x2560: [3, 3, 3, 0], 0x2561: [1, 0, 1, 3], 0x2562: [3, 0, 3, 1], 0x2563: [3, 0, 3, 3],
    0x2564: [0, 3, 1, 3], 0x2565: [0, 1, 3, 1], 0x2566: [0, 3, 3, 3], 0x2567: [1, 3, 0, 3],
    0x2568: [3, 1, 0, 1], 0x2569: [3, 3, 0, 3], 0x256a: [1, 3, 1, 3], 0x256b: [3, 1, 3, 1],
    0x256c: [3, 3, 3, 3],
    0x2574: [0, 0, 0, 1], 0x2575: [1, 0, 0, 0], 0x2576: [0, 1, 0, 0], 0x2577: [0, 0, 1, 0],
    0x2578: [0, 0, 0, 2], 0x2579: [2, 0, 0, 0], 0x257a: [0, 2, 0, 0], 0x257b: [0, 0, 2, 0],
    0x257c: [0, 2, 0, 1], 0x257d: [1, 0, 2, 0], 0x257e: [0, 1, 0, 2], 0x257f: [2, 0, 1, 0],
  };
  // Dashed lines: [vertical?, weight].
  var DASH = {
    0x2504: [0, 1], 0x2505: [0, 2], 0x2508: [0, 1], 0x2509: [0, 2], 0x254c: [0, 1], 0x254d: [0, 2],
    0x2506: [1, 1], 0x2507: [1, 2], 0x250a: [1, 1], 0x250b: [1, 2], 0x254e: [1, 1], 0x254f: [1, 2],
  };
  // Rounded corners: which two arms they join.
  var ROUND = {0x256d: 'rd', 0x256e: 'ld', 0x256f: 'lu', 0x2570: 'ru'};

  function isDrawn(cp) {
    return BOX[cp] !== undefined || DASH[cp] !== undefined || ROUND[cp] !== undefined || (cp >= 0x2580 && cp <= 0x259f);
  }

  function rect(parent, x, y, w, h, color, opacity) {
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;background:' + color + (opacity ? ';opacity:' + opacity : '');
    parent.appendChild(d);
    return d;
  }

  // One drawn glyph in a cell box at (x, 0) of size cw × ch.
  function drawGlyph(parent, cp, x, cw, ch, color, thin) {
    var heavy = thin * 2;
    var cx = x + cw / 2;
    var cy = ch / 2;
    var arms = BOX[cp];
    if (arms) {
      var weights = [0, thin, heavy, thin];
      for (var a = 0; a < 4; a++) {
        var kind = arms[a];
        if (!kind) continue;
        var t = weights[kind];
        var offsets = kind === 3 ? [-thin, thin] : [0];
        // Arms stretch past the center by the widest crossing line, so joins are solid.
        var reach = Math.max(arms[0] ? weights[arms[0]] : 0, arms[2] ? weights[arms[2]] : 0, arms[1] ? weights[arms[1]] : 0, arms[3] ? weights[arms[3]] : 0) / 2 + (kind === 3 || arms.indexOf(3) >= 0 ? thin : 0);
        for (var o = 0; o < offsets.length; o++) {
          var off = offsets[o];
          if (a === 0) rect(parent, cx - t / 2 + off, 0, t, cy + reach, color);
          if (a === 2) rect(parent, cx - t / 2 + off, cy - reach, t, ch - cy + reach, color);
          if (a === 1) rect(parent, cx - reach, cy - t / 2 + off, x + cw - cx + reach, t, color);
          if (a === 3) rect(parent, x, cy - t / 2 + off, cx - x + reach, t, color);
        }
      }
      return;
    }
    var dash = DASH[cp];
    if (dash) {
      var dt = dash[1] === 2 ? heavy : thin;
      var d = document.createElement('div');
      if (dash[0]) d.style.cssText = 'position:absolute;left:' + (cx - dt / 2) + 'px;top:0;width:0;height:' + ch + 'px;border-left:' + dt + 'px dashed ' + color;
      else d.style.cssText = 'position:absolute;left:' + x + 'px;top:' + (cy - dt / 2) + 'px;width:' + cw + 'px;height:0;border-top:' + dt + 'px dashed ' + color;
      parent.appendChild(d);
      return;
    }
    var round = ROUND[cp];
    if (round) {
      var r = Math.min(cw, ch) / 2;
      var box = document.createElement('div');
      var right = round[0] === 'r';
      var down = round[1] === 'd';
      var w = cw / 2 + thin / 2;
      var h = ch / 2 + thin / 2;
      var left = right ? cx - thin / 2 : x;
      var top = down ? cy - thin / 2 : 0;
      var borders = (down ? 'border-top' : 'border-bottom') + ':' + thin + 'px solid ' + color + ';' + (right ? 'border-left' : 'border-right') + ':' + thin + 'px solid ' + color + ';';
      var radius = (down ? 'border-top-' : 'border-bottom-') + (right ? 'left' : 'right') + '-radius:' + r + 'px;';
      box.style.cssText = 'position:absolute;box-sizing:border-box;left:' + left + 'px;top:' + top + 'px;width:' + (w + (right ? thin : 0)) + 'px;height:' + (h + (down ? thin : 0)) + 'px;' + borders + radius;
      // Extend the straight ends to the cell edge.
      box.style.width = (right ? x + cw - left : cx + thin / 2 - x) + 'px';
      box.style.height = (down ? ch - top : cy + thin / 2) + 'px';
      parent.appendChild(box);
      return;
    }
    // Block elements.
    if (cp === 0x2580) return rect(parent, x, 0, cw, ch / 2, color);
    if (cp >= 0x2581 && cp <= 0x2588) { var hh = ch * (cp - 0x2580) / 8; return rect(parent, x, ch - hh, cw, hh, color); }
    if (cp >= 0x2589 && cp <= 0x258f) { var ww = cw * (0x2590 - cp) / 8; return rect(parent, x, 0, ww, ch, color); }
    if (cp === 0x2590) return rect(parent, x + cw / 2, 0, cw / 2, ch, color);
    if (cp >= 0x2591 && cp <= 0x2593) return rect(parent, x, 0, cw, ch, color, [0.25, 0.5, 0.75][cp - 0x2591]);
    if (cp === 0x2594) return rect(parent, x, 0, cw, ch / 8, color);
    if (cp === 0x2595) return rect(parent, x + cw * 7 / 8, 0, cw / 8, ch, color);
    // Quadrants 2596-259F: bits are UL, UR, LL, LR.
    var quads = {0x2596: 4, 0x2597: 8, 0x2598: 1, 0x2599: 13, 0x259a: 9, 0x259b: 7, 0x259c: 11, 0x259d: 2, 0x259e: 6, 0x259f: 14};
    var q = quads[cp];
    if (q) {
      if (q & 1) rect(parent, x, 0, cw / 2, ch / 2, color);
      if (q & 2) rect(parent, x + cw / 2, 0, cw / 2, ch / 2, color);
      if (q & 4) rect(parent, x, ch / 2, cw / 2, ch / 2, color);
      if (q & 8) rect(parent, x + cw / 2, ch / 2, cw / 2, ch / 2, color);
    }
  }

  function measureAdvance(fontFamily, fontSize) {
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-kerning:none;font-variant-ligatures:none;font-family:' + fontFamily + ';font-size:' + fontSize + 'px';
    probe.textContent = new Array(201).join('M');
    document.body.appendChild(probe);
    var width = probe.offsetWidth / 200;
    probe.remove();
    return width || fontSize * 0.6;
  }

  function mount(el, opts) {
    var cap = opts.frames;
    var imageList = opts.images ? (Array.isArray(opts.images) ? opts.images : opts.images.images) : [];
    var images = {};
    imageList.forEach(function (img) { images[img.key] = img; });
    var fontFamily = opts.fontFamily || FONT;
    var fontSize = opts.fontSize || 15;
    var lh = opts.lineHeight || 1.25;
    var ch = opts.cellHeight || (lh > 4 ? lh : fontSize * lh);
    var advance = measureAdvance(fontFamily, fontSize);
    var cw = opts.cellWidth || advance;
    var spacing = cw - advance;
    var thin = opts.lineWidth || Math.max(1, Math.round(ch / 19 * 100) / 100);
    var imageBase = opts.imageBase || '';
    var showCursor = opts.cursor !== false;
    var theme;
    var cache;

    var root = document.createElement('div');
    root.className = 'tg-root';
    var under = document.createElement('div');
    var text = document.createElement('div');
    var over = document.createElement('div');
    var cursorEl = document.createElement('div');
    [under, text, over].forEach(function (layer, i) {
      layer.style.cssText = 'position:absolute;inset:0;z-index:' + i;
      root.appendChild(layer);
    });
    cursorEl.style.cssText = 'position:absolute;z-index:3;display:none;width:' + cw + 'px;height:' + ch + 'px;opacity:0.75';
    root.appendChild(cursorEl);
    el.appendChild(root);

    var state = {frame: -2, size: null, rowEls: [], rowIdx: [], overlayIdx: -2, overlayEls: []};

    function color(value, isFg) {
      if (value === undefined || value === null) return isFg ? theme.fg : null;
      if (typeof value === 'number') return value < 16 ? theme.palette[value] : cube(value);
      return value;
    }

    function styleColors(s) {
      var fg = color(s.fg, true);
      var bg = color(s.bg, false);
      if (s.inv) {
        var t = fg;
        fg = bg || theme.bg;
        bg = t;
      }
      if (s.d) fg = mix(fg, bg || theme.bg, 0.45);
      return {fg: fg, bg: bg};
    }

    function buildRow(idx) {
      if (cache[idx]) return cache[idx];
      var row = document.createElement('div');
      row.style.cssText = 'position:absolute;left:0;height:' + ch + 'px;width:100%;white-space:pre;line-height:' + ch + 'px';
      var runs = cap.lines[idx];
      for (var i = 0; i < runs.length; i++) {
        var run = runs[i];
        var col = run[0];
        var width = run[1];
        var str = run[2];
        var s = cap.styles[run[3]];
        var glyphW = run[4];
        var c = styleColors(s);
        var x = col * cw;
        if (c.bg) rect(row, x, 0, width * cw, ch, c.bg);
        if (!str || s.x) continue;
        var deco = (s.u ? 'underline' : '') + (s.s ? ' line-through' : '');
        var font = (s.b ? 'font-weight:700;' : '') + (s.i ? 'font-style:italic;' : '') + (deco ? 'text-decoration:' + deco + ';text-underline-offset:' + Math.round(ch * 0.12) + 'px;' : '');
        if (!glyphW) {
          if (str.trim() === '' && !s.u && !s.s) continue;
          var span = document.createElement('span');
          span.style.cssText = 'position:absolute;top:0;left:' + x + 'px;width:' + width * cw + 'px;letter-spacing:' + spacing + 'px;color:' + c.fg + ';' + font;
          span.textContent = str;
          row.appendChild(span);
          continue;
        }
        var cp = str.codePointAt(0);
        var count = Math.max(1, Math.round(width / glyphW));
        for (var k = 0; k < count; k++) {
          var gx = x + k * glyphW * cw;
          if (isDrawn(cp)) {
            drawGlyph(row, cp, gx, cw, ch, c.fg, thin);
          } else {
            var g = document.createElement('span');
            g.style.cssText = 'position:absolute;top:0;left:' + gx + 'px;width:' + glyphW * cw + 'px;overflow:visible;text-align:' + (glyphW === 2 ? 'center' : 'left') + ';color:' + c.fg + ';' + font;
            g.textContent = str;
            row.appendChild(g);
          }
        }
      }
      cache[idx] = row;
      return row;
    }

    function frameAt(t) {
      var frames = cap.frames;
      var lo = 0;
      var hi = frames.length - 1;
      if (!frames.length || t < frames[0].t) return -1;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (frames[mid].t <= t) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }

    function setSize(cols, rows) {
      var key = cols + 'x' + rows;
      if (state.size === key) return;
      state.size = key;
      root.style.cssText = 'position:relative;overflow:hidden;width:' + cols * cw + 'px;height:' + rows * ch + 'px;background:' + theme.bg + ';color:' + theme.fg + ';font-family:' + fontFamily + ';font-size:' + fontSize + 'px;font-kerning:none;font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;-webkit-font-smoothing:antialiased';
      text.textContent = '';
      state.rowEls = [];
      state.rowIdx = [];
      for (var y = 0; y < rows; y++) {
        var holder = document.createElement('div');
        holder.style.cssText = 'position:absolute;left:0;top:' + y * ch + 'px;width:100%;height:' + ch + 'px';
        text.appendChild(holder);
        state.rowEls.push(holder);
        state.rowIdx.push(-1);
      }
    }

    function imageFrameSrc(img, t) {
      var anim = img.animation;
      if (!anim || !anim.frames || anim.frames.length < 2 || anim.loopStartedAt == null) return imageBase + img.file;
      var total = 0;
      anim.frames.forEach(function (f) { total += f.delay; });
      if (total <= 0) return imageBase + img.file;
      var phase = ((t - anim.loopStartedAt) * 1000) % total;
      if (phase < 0) phase += total;
      for (var i = 0; i < anim.frames.length; i++) {
        phase -= anim.frames[i].delay;
        if (phase < 0) return imageBase + anim.frames[i].file;
      }
      return imageBase + img.file;
    }

    function drawOverlays(list, t) {
      under.textContent = '';
      over.textContent = '';
      state.overlayEls = [];
      (list || []).forEach(function (o) {
        var img = images[o.k];
        if (!img) return;
        var pc = img.placement ? img.placement.cols : o.w;
        var pr = img.placement ? img.placement.rows : o.h;
        if (o.pc) { pc = o.pc; pr = o.pr; }
        var boxW = pc * cw;
        var boxH = pr * ch;
        var dw = boxW;
        var dh = boxH;
        if (o.fit !== 'stretch') {
          var scale = Math.min(boxW / img.width, boxH / img.height);
          dw = img.width * scale;
          dh = img.height * scale;
        }
        var ox = (boxW - dw) / 2;
        var oy = (boxH - dh) / 2;
        var clip = document.createElement('div');
        clip.style.cssText = 'position:absolute;overflow:hidden;left:' + o.c * cw + 'px;top:' + o.r * ch + 'px;width:' + o.w * cw + 'px;height:' + o.h * ch + 'px';
        var im = document.createElement('img');
        im.decoding = 'sync';
        im.src = imageFrameSrc(img, t);
        im.style.cssText = 'position:absolute;max-width:none;left:' + (ox - o.sc * cw) + 'px;top:' + (oy - o.sr * ch) + 'px;width:' + dw + 'px;height:' + dh + 'px';
        clip.appendChild(im);
        (o.z < 0 ? under : over).appendChild(clip);
        state.overlayEls.push({img: im, data: img});
      });
    }

    function render(index, t) {
      var frame = index >= 0 ? cap.frames[index] : null;
      var size = (frame && frame.s) || [cap.cols, cap.rows];
      setSize(size[0], size[1]);
      for (var y = 0; y < state.rowEls.length; y++) {
        var idx = frame ? frame.r[y] : -1;
        if (idx === undefined) idx = -1;
        if (state.rowIdx[y] === idx) continue;
        state.rowIdx[y] = idx;
        var holder = state.rowEls[y];
        holder.textContent = '';
        if (idx >= 0) holder.appendChild(buildRow(idx).cloneNode(true));
      }
      var overlayIdx = frame && frame.o !== undefined ? frame.o : -1;
      if (overlayIdx !== state.overlayIdx) {
        state.overlayIdx = overlayIdx;
        drawOverlays(overlayIdx >= 0 ? cap.overlays[overlayIdx] : [], t);
      } else {
        state.overlayEls.forEach(function (o) {
          if (o.data.animation) {
            var src = imageFrameSrc(o.data, t);
            if (o.img.getAttribute('src') !== src) o.img.src = src;
          }
        });
      }
      var cur = frame && frame.c;
      if (showCursor && cur && cur[2]) {
        cursorEl.style.display = 'block';
        cursorEl.style.left = cur[0] * cw + 'px';
        cursorEl.style.top = cur[1] * ch + 'px';
        cursorEl.style.background = theme.cursor;
      } else {
        cursorEl.style.display = 'none';
      }
    }

    function setTheme(next) {
      theme = normalizeTheme(next || (cap.recorded && cap.recorded.theme) || {fg: '#d8dee9', bg: '#111318', palette: []});
      cache = {};
      state.size = null;
      state.overlayIdx = -2;
      var frame = state.frame;
      state.frame = -2;
      if (frame !== -2) api.seek(state.t || 0);
    }

    var api = {
      root: root,
      cellWidth: cw,
      cellHeight: ch,
      get width() { return parseFloat(root.style.width); },
      get height() { return parseFloat(root.style.height); },
      frameAt: frameAt,
      seek: function (t) {
        var index = frameAt(t);
        state.t = t;
        if (index !== state.frame || (state.overlayEls.some(function (o) { return o.data.animation; }))) {
          state.frame = index;
          render(index, t);
        }
        return index;
      },
      /** The CSS-pixel box of a cell range, for camera moves: {x, y, width, height}. */
      cellRect: function (col, row, cols, rows) {
        return {x: col * cw, y: row * ch, width: (cols || 1) * cw, height: (rows || 1) * ch};
      },
      ready: function () {
        var waits = Array.prototype.map.call(root.querySelectorAll('img'), function (im) {
          return im.decode ? im.decode().catch(function () {}) : Promise.resolve();
        });
        var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
        return Promise.all(waits.concat([fonts]));
      },
      setTheme: setTheme,
      destroy: function () { root.remove(); },
    };
    setTheme(opts.theme);
    api.seek(opts.start || 0);
    return api;
  }

  global.TerminalGrid = {mount: mount, normalizeTheme: normalizeTheme};
})(typeof window !== 'undefined' ? window : globalThis);
