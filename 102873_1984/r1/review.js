/* Zoning map review page. Vanilla JS, no build step. Generated pages load this next to
   data.js (window.REVIEW_DATA) and ../scan/ (tile pyramid). Coordinates in the data and
   in saved annotations are map pixels of the upright frame (same as overlay.png). */
(function () {
  "use strict";
  const D = window.REVIEW_DATA;
  const $ = (id) => document.getElementById(id);
  const canvas = $("map"), ctx = canvas.getContext("2d");
  const stage = $("stage");
  const W = D.frame.width, H = D.frame.height;
  const DPR = () => window.devicePixelRatio || 1;

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const k in props || {}) {
      if (k === "class") e.className = props[k];
      else if (k === "on") for (const ev in props.on) e.addEventListener(ev, props.on[ev]);
      else if (k in e) e[k] = props[k];
      else e.setAttribute(k, props[k]);
    }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  }
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* private window */ } },
  };
  const fmtBox = (b) => b.map(Math.round).join(", ");

  /* ---------- state ---------- */
  const S = {
    tool: "pan", mode: "overlay", lastMode: "overlay", peek: false, swipe: false, swipeAt: 0.5,
    compare: false, opacity: 0.45, showDoubts: true, hidden: new Set(),
    hover: null, hoverZone: null, selected: null, activeDoubt: null,
    annotations: [], checked: {}, wrong: {}, editing: null, draft: null, nextId: 1,
  };
  const view = { x: 0, y: 0, s: 1 };      // device px = view.x + map px * view.s
  const goal = { x: 0, y: 0, s: 1, on: false };

  /* ---------- geometry ---------- */
  const zones = D.zones.map((z, i) => ({ ...z, i, features: [], paths: [null, null, null] }));
  const features = D.features.map((f, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of f.r) for (let k = 0; k < r.length; k += 2) {
      if (r[k] < x0) x0 = r[k]; if (r[k] > x1) x1 = r[k];
      if (r[k + 1] < y0) y0 = r[k + 1]; if (r[k + 1] > y1) y1 = r[k + 1];
    }
    const g = { i, z: f.z, area: f.a, r: f.r, bbox: [x0, y0, x1, y1], path: null };
    zones[f.z].features.push(g);
    return g;
  });
  function addRing(path, r, tol) {
    if (r.length < 6) return;
    path.moveTo(r[0], r[1]);
    let px = r[0], py = r[1], n = 1;
    const t2 = tol * tol;
    for (let k = 2; k < r.length; k += 2) {
      const dx = r[k] - px, dy = r[k + 1] - py;
      if (tol && dx * dx + dy * dy < t2 && k < r.length - 2) continue;
      path.lineTo(r[k], r[k + 1]); px = r[k]; py = r[k + 1]; n++;
    }
    path.closePath();
  }
  const LOD_TOL = [0, 1.5, 4];
  function zonePath(z, lod) {
    if (!z.paths[lod]) {
      const p = new Path2D();
      for (const f of z.features) for (const r of f.r) addRing(p, r, LOD_TOL[lod]);
      z.paths[lod] = p;
    }
    return z.paths[lod];
  }
  function featPath(f) {
    if (!f.path) { f.path = new Path2D(); for (const r of f.r) addRing(f.path, r, 0); }
    return f.path;
  }
  const hitCtx = document.createElement("canvas").getContext("2d");
  function featureAt(x, y) {
    for (const f of features) {
      const b = f.bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3] || S.hidden.has(f.z)) continue;
      if (hitCtx.isPointInPath(featPath(f), x, y, "evenodd")) return f;
    }
    return null;
  }
  function pathOfRings(rings) {
    const p = new Path2D();
    for (const r of rings) addRing(p, r, 0);
    return p;
  }
  const changes = (D.changes || []).map((c) => ({ ...c, path: pathOfRings(c.r) }));
  let prevPath = null;
  if (D.previous && D.previous.outlines) prevPath = pathOfRings(D.previous.outlines);

  function darken(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16 & 255) * f | 0},${(n >> 8 & 255) * f | 0},${(n & 255) * f | 0})`;
  }

  /* ---------- tiles ---------- */
  const I = D.scan;
  const tiles = new Map();
  let tileClock = 0, inflight = 0;
  const queue = [];
  const tileUrl = (L, x, y) => `${I.base}/${L}/${x}_${y}.${I.format}`;
  function pump() {
    while (inflight < 8 && queue.length) {
      const t = queue.pop();
      if (t.state !== "queued") continue;
      t.state = "loading"; inflight++;
      const img = new Image();
      img.onload = () => { t.state = "ready"; t.img = img; inflight--; (t.waiters || []).forEach((w) => w()); t.waiters = null; pump(); redraw(); };
      img.onerror = () => { t.state = "error"; inflight--; (t.waiters || []).forEach((w) => w()); t.waiters = null; pump(); };
      img.src = tileUrl(t.L, t.x, t.y);
    }
  }
  function tile(L, x, y, want) {
    const k = L + "/" + x + "/" + y;
    let t = tiles.get(k);
    if (!t) { t = { L, x, y, state: "new", used: 0 }; tiles.set(k, t); }
    t.used = tileClock;
    if (want && t.state === "new") { t.state = "queued"; queue.push(t); }
    return t;
  }
  function evictTiles() {
    if (tiles.size < 500) return;
    const all = [...tiles.values()].filter((t) => t.state === "ready" && t.L < I.levels.length - 1);
    all.sort((a, b) => a.used - b.used);
    for (const t of all.slice(0, tiles.size - 400)) tiles.delete(t.L + "/" + t.x + "/" + t.y);
  }
  function levelFor(s) {
    const L = Math.floor(Math.log2(1 / s) + 1e-6);
    return Math.max(0, Math.min(I.levels.length - 1, L));
  }
  function drawLevel(c, L, v, cw, ch, request) {
    const lev = I.levels[L], f = 2 ** L, ts = I.tile * f * v.s;
    const c0 = Math.max(0, Math.floor(-v.x / ts)), c1 = Math.min(lev.cols - 1, Math.floor((cw - v.x) / ts));
    const r0 = Math.max(0, Math.floor(-v.y / ts)), r1 = Math.min(lev.rows - 1, Math.floor((ch - v.y) / ts));
    let missing = 0;
    for (let r = r0; r <= r1; r++) for (let q = c0; q <= c1; q++) {
      const t = tile(L, q, r, request);
      if (t.state !== "ready") { missing++; continue; }
      const iw = t.img.naturalWidth, ih = t.img.naturalHeight;
      const x0 = Math.floor(v.x + q * ts), y0 = Math.floor(v.y + r * ts);
      const x1 = Math.ceil(v.x + (q * I.tile + iw) * f * v.s), y1 = Math.ceil(v.y + (r * I.tile + ih) * f * v.s);
      c.drawImage(t.img, x0, y0, x1 - x0, y1 - y0);
    }
    return missing;
  }

  /* ---------- drawing ---------- */
  let dirty = false;
  function redraw() { if (!dirty) { dirty = true; requestAnimationFrame(frame); } }
  function drawZones(c, v, opts) {
    const lod = v.s < 0.22 ? 2 : v.s < 0.5 ? 1 : 0;
    const op = opts.opacity;
    c.save();
    c.setTransform(v.s, 0, 0, v.s, v.x, v.y);
    for (const z of zones) {
      if (S.hidden.has(z.i) || !z.features.length) continue;
      const p = zonePath(z, lod);
      if (!opts.outlines) {
        c.globalAlpha = op; c.fillStyle = z.color; c.fill(p, "evenodd");
        c.globalAlpha = Math.min(1, op + 0.35); c.strokeStyle = darken(z.color, 0.55); c.lineWidth = opts.lw / v.s; c.stroke(p);
      } else {
        // Dark edge first: on a color map the zone color alone can vanish into the print
        c.globalAlpha = 0.9; c.strokeStyle = "#000"; c.lineWidth = opts.lw * 3 / v.s; c.stroke(p);
        c.globalAlpha = 1; c.strokeStyle = z.color; c.lineWidth = opts.lw * 1.6 / v.s; c.stroke(p);
      }
    }
    c.restore();
  }
  function frame() {
    dirty = false;
    tileClock++;
    stepGoal();
    const cw = canvas.width, ch = canvas.height, dpr = DPR();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#34373b"; ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(view.x, view.y, W * view.s, H * view.s);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = view.s > 1 ? "low" : "medium";
    const L = levelFor(view.s), top = I.levels.length - 1;
    drawLevel(ctx, top, view, cw, ch, true);
    for (let l = top - 1; l > L; l--) drawLevel(ctx, l, view, cw, ch, false);
    if (L < top) drawLevel(ctx, L, view, cw, ch, true);
    pump(); evictTiles();

    const mode = S.peek ? "scan" : S.mode;
    if (mode !== "scan" || S.swipe) {
      ctx.save();
      if (S.swipe) { ctx.beginPath(); ctx.rect(0, 0, cw * S.swipeAt, ch); ctx.clip(); }
      drawZones(ctx, view, { opacity: S.opacity, lw: 1.1 * dpr, outlines: mode === "outlines" });
      ctx.restore();
    }
    if (mode !== "scan" && !S.peek) drawHighlights(dpr);
    if (S.compare) drawCompare(dpr);
    if (S.showDoubts && !S.peek) drawDoubts(dpr);
    drawNotes(ctx, view, dpr);
    if (S.draft) drawNote(ctx, view, S.draft, "", dpr, true);
    if (goal.on) redraw();
    updateStatus();
  }
  function drawHighlights(dpr) {
    ctx.save();
    ctx.setTransform(view.s, 0, 0, view.s, view.x, view.y);
    const lw = 2.5 * dpr / view.s;
    if (S.hoverZone != null && !S.hidden.has(S.hoverZone)) {
      const z = zones[S.hoverZone];
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = lw * 1.6; ctx.stroke(zonePath(z, view.s < 0.22 ? 2 : 0));
      ctx.strokeStyle = "#111111"; ctx.lineWidth = lw * 0.7; ctx.stroke(zonePath(z, view.s < 0.22 ? 2 : 0));
    }
    for (const f of [S.hover, S.selected]) {
      if (!f) continue;
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = lw * 1.8; ctx.stroke(featPath(f));
      ctx.strokeStyle = "#111111"; ctx.lineWidth = lw * 0.8; ctx.stroke(featPath(f));
    }
    ctx.restore();
  }
  function drawCompare(dpr) {
    ctx.save();
    ctx.setTransform(view.s, 0, 0, view.s, view.x, view.y);
    if (prevPath) {
      ctx.setLineDash([6 * dpr / view.s, 5 * dpr / view.s]);
      ctx.strokeStyle = "#0a0a0a"; ctx.lineWidth = 1.2 * dpr / view.s; ctx.stroke(prevPath);
      ctx.setLineDash([]);
    }
    for (const c of changes) {
      ctx.fillStyle = "rgba(255,0,170,.45)"; ctx.fill(c.path, "evenodd");
      ctx.strokeStyle = "#ff00aa"; ctx.lineWidth = 2.5 * dpr / view.s; ctx.stroke(c.path);
    }
    ctx.restore();
    // Rings keep tiny changes visible when zoomed out
    ctx.strokeStyle = "#ff00aa"; ctx.lineWidth = 2 * dpr;
    for (const c of changes) {
      const b = c.bbox, w = (b[2] - b[0]) * view.s, h = (b[3] - b[1]) * view.s;
      if (Math.max(w, h) > 14 * dpr) continue;
      ctx.beginPath();
      ctx.arc(view.x + (b[0] + b[2]) / 2 * view.s, view.y + (b[1] + b[3]) / 2 * view.s, 11 * dpr, 0, 7);
      ctx.stroke();
    }
    drawPriorNotes(dpr);
  }
  function drawPriorNotes(dpr) {
    const prior = (D.prior && D.prior.annotations) || [];
    prior.forEach((a, i) => drawNote(ctx, view, a, "p" + (i + 1), dpr, false, "#6a3fb5"));
  }
  function drawDoubts(dpr) {
    D.doubts.forEach((d, i) => {
      if (!d.bbox) return;
      const b = d.bbox, active = S.activeDoubt === i;
      const x0 = view.x + b[0] * view.s, y0 = view.y + b[1] * view.s;
      const w = (b[2] - b[0]) * view.s, h = (b[3] - b[1]) * view.s;
      const big = Math.max(w, h) > 18 * dpr;
      ctx.save();
      if (big) {
        ctx.setLineDash(active ? [] : [5 * dpr, 4 * dpr]);
        ctx.lineWidth = (active ? 3 : 1.5) * dpr;
        ctx.strokeStyle = "#000"; ctx.globalAlpha = .55; ctx.lineWidth += 1.5 * dpr; ctx.strokeRect(x0, y0, w, h);
        ctx.globalAlpha = S.checked[d.id] ? .55 : 1; ctx.lineWidth -= 1.5 * dpr;
        ctx.strokeStyle = S.checked[d.id] ? "#7a7a7a" : "#f2a900"; ctx.strokeRect(x0, y0, w, h);
      }
      const cx = big ? x0 : x0 + w / 2, cy = big ? y0 : y0 + h / 2, r = (active ? 8 : 6) * dpr;
      ctx.setLineDash([]); ctx.globalAlpha = S.checked[d.id] ? .6 : 1;
      ctx.translate(cx, cy); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = S.checked[d.id] ? "#7a7a7a" : "#f2a900"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1 * dpr;
      ctx.fillRect(-r, -r, 2 * r, 2 * r); ctx.strokeRect(-r, -r, 2 * r, 2 * r);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = "#000"; ctx.font = `600 ${10 * dpr}px system-ui,sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), 0, 0);
      ctx.restore();
    });
  }
  function drawNote(c, v, a, label, dpr, draft, color) {
    const col = color || "#d0021b";
    const X = (x) => v.x + x * v.s, Y = (y) => v.y + y * v.s;
    c.save();
    c.lineJoin = "round"; c.lineCap = "round";
    let lx, ly;
    if (a.type === "pin") {
      lx = X(a.point[0]); ly = Y(a.point[1]);
      c.fillStyle = col; c.strokeStyle = "#fff"; c.lineWidth = 2 * dpr;
      c.beginPath(); c.arc(lx, ly, 6 * dpr, 0, 7); c.fill(); c.stroke();
    } else {
      c.beginPath();
      if (a.type === "box") {
        const b = a.bbox;
        c.rect(X(b[0]), Y(b[1]), (b[2] - b[0]) * v.s, (b[3] - b[1]) * v.s);
        lx = X(b[0]); ly = Y(b[1]);
      } else {
        a.points.forEach((p, i) => (i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))));
        lx = X(a.points[0][0]); ly = Y(a.points[0][1]);
      }
      c.strokeStyle = "#fff"; c.lineWidth = 4.5 * dpr; c.stroke();
      c.strokeStyle = col; c.lineWidth = 2.5 * dpr; c.stroke();
    }
    if (label) {
      c.font = `600 ${12 * dpr}px system-ui,sans-serif`;
      c.textAlign = "center"; c.textBaseline = "middle";
      const tw = c.measureText(label).width, r = Math.max(9 * dpr, tw / 2 + 4 * dpr);
      c.fillStyle = col; c.beginPath(); c.arc(lx, ly - (a.type === "pin" ? 14 * dpr : 0), r, 0, 7); c.fill();
      c.fillStyle = "#fff"; c.fillText(label, lx, ly - (a.type === "pin" ? 14 * dpr : 0));
    }
    c.restore();
  }
  function drawNotes(c, v, dpr) {
    S.annotations.forEach((a, i) => drawNote(c, v, a, String(i + 1), dpr));
  }

  /* ---------- view ---------- */
  let fitted = false;
  function resize() {
    const r = stage.getBoundingClientRect(), dpr = DPR();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    if (!fitted && r.width > 0 && r.height > 0) { fitted = true; fit(false); }
    placeDivider(); redraw();
  }
  function setGoal(x, y, s, animate) {
    goal.x = x; goal.y = y; goal.s = s;
    if (animate) { goal.on = true; } else { goal.on = false; view.x = x; view.y = y; view.s = s; }
    redraw();
  }
  function stepGoal() {
    if (!goal.on) return;
    const k = 0.28, ds = goal.s / view.s, r = Math.pow(ds, k);
    if (Math.abs(ds - 1) < 0.002) {
      view.x += (goal.x - view.x) * k; view.y += (goal.y - view.y) * k;
      if (Math.abs(goal.x - view.x) + Math.abs(goal.y - view.y) < 0.5) { view.x = goal.x; view.y = goal.y; view.s = goal.s; goal.on = false; }
      return;
    }
    // Keep the zoom's fixed point still so the spot under the cursor doesn't drift
    const fx = (goal.x * view.s - view.x * goal.s) / (view.s - goal.s);
    const fy = (goal.y * view.s - view.y * goal.s) / (view.s - goal.s);
    view.x = fx + (view.x - fx) * r; view.y = fy + (view.y - fy) * r; view.s *= r;
  }
  const minScale = () => Math.min(canvas.width / W, canvas.height / H) * 0.5;
  const maxScale = () => 8 * DPR();
  function fit(animate) {
    const pad = 54 * DPR();
    const s = Math.min(canvas.width / W, (canvas.height - pad) / H) * 0.98;
    setGoal((canvas.width - W * s) / 2, pad + (canvas.height - pad - H * s) / 2, s, animate);
  }
  function zoomAt(px, py, factor, animate) {
    const base = goal.on ? goal : view;
    const s = Math.max(minScale(), Math.min(maxScale(), base.s * factor));
    const ix = (px - base.x) / base.s, iy = (py - base.y) / base.s;
    setGoal(px - ix * s, py - iy * s, s, animate);
  }
  function jumpTo(b, minSize) {
    const pad = minSize || 120;
    const bw = Math.max(b[2] - b[0], pad), bh = Math.max(b[3] - b[1], pad);
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const s = Math.min(maxScale() / 2, Math.min(canvas.width / (bw * 1.8), canvas.height / (bh * 1.8)));
    setGoal(canvas.width / 2 - cx * s, canvas.height / 2 - cy * s, s, true);
  }
  function toMap(ev) {
    const r = canvas.getBoundingClientRect(), dpr = DPR();
    const px = (ev.clientX - r.left) * dpr, py = (ev.clientY - r.top) * dpr;
    return { px, py, x: (px - view.x) / view.s, y: (py - view.y) / view.s, cssX: ev.clientX - r.left, cssY: ev.clientY - r.top };
  }
  const clampX = (x) => Math.max(0, Math.min(W, x));
  const clampY = (y) => Math.max(0, Math.min(H, y));
  const roundPt = (x, y) => [Math.round(clampX(x)), Math.round(clampY(y))];

  /* ---------- pointer ---------- */
  const pointers = new Map();
  let drag = null, pinch = null;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (ev) => {
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, ev);
    const m = toMap(ev);
    goal.on = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), s: view.s };
      S.draft = null; drag = null;
      return;
    }
    const panning = S.tool === "pan" || ev.button === 1 || ev.button === 2;
    if (panning) {
      drag = { kind: "pan", sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false };
      canvas.classList.add("dragging");
    } else if (S.tool === "box") {
      S.draft = { type: "box", bbox: [...roundPt(m.x, m.y), ...roundPt(m.x, m.y)] };
      drag = { kind: "box", ox: m.x, oy: m.y };
    } else if (S.tool === "draw") {
      S.draft = { type: "freehand", points: [roundPt(m.x, m.y)] };
      drag = { kind: "draw", lx: m.px, ly: m.py };
    } else if (S.tool === "pin") {
      drag = { kind: "pin" };
    }
    hideTip();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, ev);
    const m = toMap(ev);
    lastPos = m;
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const r = canvas.getBoundingClientRect();
      const px = ((a.clientX + b.clientX) / 2 - r.left) * DPR(), py = ((a.clientY + b.clientY) / 2 - r.top) * DPR();
      zoomAt(px, py, (pinch.s * d / pinch.d) / view.s, false);
      return;
    }
    if (drag) {
      if (drag.kind === "pan") {
        const dx = (ev.clientX - drag.sx) * DPR(), dy = (ev.clientY - drag.sy) * DPR();
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        setGoal(drag.vx + dx, drag.vy + dy, view.s, false);
      } else if (drag.kind === "box") {
        const a = roundPt(Math.min(drag.ox, m.x), Math.min(drag.oy, m.y));
        const b = roundPt(Math.max(drag.ox, m.x), Math.max(drag.oy, m.y));
        S.draft.bbox = [a[0], a[1], b[0], b[1]]; redraw();
      } else if (drag.kind === "draw") {
        if (Math.hypot(m.px - drag.lx, m.py - drag.ly) >= 3 * DPR()) {
          S.draft.points.push(roundPt(m.x, m.y)); drag.lx = m.px; drag.ly = m.py; redraw();
        }
      }
      return;
    }
    if (S.tool === "pan" && !pointers.size) {
      const f = S.mode === "scan" ? null : featureAt(m.x, m.y);
      if (f !== S.hover) { S.hover = f; redraw(); }
      if (f) showTip(m.cssX, m.cssY, zones[f.z]); else hideTip();
    }
    updateStatus();
  });
  function endPointer(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    const d = drag; drag = null;
    canvas.classList.remove("dragging");
    if (!d || ev.type === "pointercancel") { S.draft = ev.type === "pointercancel" ? null : S.draft; return; }
    const m = toMap(ev);
    if (d.kind === "pan") { if (!d.moved) clickAt(m); return; }
    if (d.kind === "pin") { addNote({ type: "pin", point: roundPt(m.x, m.y) }); return; }
    const a = S.draft; S.draft = null;
    if (a.type === "box") {
      const b = a.bbox;
      if ((b[2] - b[0]) * view.s < 4 * DPR() || (b[3] - b[1]) * view.s < 4 * DPR()) { redraw(); return; }
      addNote(a);
    } else {
      if (a.points.length < 2) { redraw(); return; }
      const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]);
      a.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      addNote(a);
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => { if (S.hover) { S.hover = null; redraw(); } hideTip(); });
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const m = toMap(ev);
    const unit = ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 300 : 1;
    const dy = ev.deltaY * unit;
    if (!ev.ctrlKey && Math.abs(ev.deltaX) > Math.abs(dy) * 2) {   // sideways trackpad scroll
      setGoal(view.x - ev.deltaX * DPR(), view.y, view.s, false);
      return;
    }
    const f = Math.exp(-dy * (ev.ctrlKey ? 0.01 : 0.0022));
    zoomAt(m.px, m.py, f, Math.abs(dy) >= 40);
  }, { passive: false });

  let lastPos = null;
  function noteAt(m) {
    const tol = 10 * DPR() / view.s;
    for (let i = S.annotations.length - 1; i >= 0; i--) {
      const a = S.annotations[i];
      const b = a.type === "pin" ? [a.point[0], a.point[1], a.point[0], a.point[1]] : a.bbox;
      if (m.x >= b[0] - tol && m.x <= b[2] + tol && m.y >= b[1] - tol && m.y <= b[3] + tol) {
        if (a.type !== "box" && a.type !== "pin") { if (a.points.some((p) => Math.hypot(p[0] - m.x, p[1] - m.y) < tol * 2)) return a; continue; }
        if (a.type === "box" && !(Math.min(m.x - b[0], b[2] - m.x, m.y - b[1], b[3] - m.y) < tol)) continue;
        return a;
      }
    }
    return null;
  }
  function clickAt(m) {
    const n = noteAt(m);
    if (n) { openForm(n); return; }
    const f = S.mode === "scan" ? null : featureAt(m.x, m.y);
    S.selected = f;
    $("st-info").textContent = f ? `Selected: ${zones[f.z].code} (${zones[f.z].name}), ${Math.round(f.area).toLocaleString()} sq px` : "";
    redraw();
  }

  const tip = $("tip");
  function showTip(x, y, z) {
    tip.replaceChildren(el("b", { textContent: z.code }), " " + z.name);
    tip.hidden = false;
    const r = stage.getBoundingClientRect();
    tip.style.left = Math.min(x + 14, r.width - tip.offsetWidth - 6) + "px";
    tip.style.top = Math.min(y + 14, r.height - tip.offsetHeight - 6) + "px";
  }
  function hideTip() { tip.hidden = true; }
  function updateStatus() {
    const p = lastPos;
    $("st-pos").textContent = p && p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H ? `x ${Math.round(p.x)}, y ${Math.round(p.y)}` : "";
    $("st-zoom").textContent = Math.round(view.s / DPR() * 100) + "%";
  }

  /* ---------- swipe ---------- */
  const divider = $("divider");
  function placeDivider() { divider.style.left = (S.swipeAt * stage.clientWidth) + "px"; }
  divider.addEventListener("pointerdown", (ev) => { divider.setPointerCapture(ev.pointerId); divider.dragging = true; });
  divider.addEventListener("pointermove", (ev) => {
    if (!divider.dragging) return;
    const r = stage.getBoundingClientRect();
    S.swipeAt = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    placeDivider(); redraw();
  });
  divider.addEventListener("pointerup", () => { divider.dragging = false; });
  function setSwipe(on) {
    S.swipe = on; divider.hidden = !on;
    if (on && S.mode === "scan") setMode(S.lastMode);
    $("btn-swipe").setAttribute("aria-pressed", on);
    placeDivider(); redraw();
  }
  function setMode(m) {
    if (m !== "scan") S.lastMode = m;
    S.mode = m;
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === m));
    S.hover = null; hideTip(); redraw();
  }
  function setTool(t) {
    S.tool = t; S.draft = null;
    document.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tool === t));
    canvas.classList.toggle("tool", t !== "pan");
    S.hover = null; hideTip(); redraw();
  }
  function setOpacity(v) {
    S.opacity = Math.max(0, Math.min(1, v));
    $("opacity").value = Math.round(S.opacity * 100);
    if (S.opacity > 0 && S.mode === "scan") setMode(S.lastMode);
    redraw();
  }
  function setCompare(on) {
    if (!D.previous) return;
    S.compare = on;
    $("btn-cmp").setAttribute("aria-pressed", on);
    $("cmp-on").checked = on;
    redraw();
  }

  /* ---------- zones list ---------- */
  function renderZones() {
    const ul = $("zones"); ul.replaceChildren();
    let n = 0;
    zones.forEach((z) => {
      if (z.features.length) n++;
      const cb = el("input", { type: "checkbox", checked: !S.hidden.has(z.i), on: { change: () => {
        if (cb.checked) S.hidden.delete(z.i); else S.hidden.add(z.i);
        redraw();
      } } });
      z.cb = cb;
      const share = z.share != null ? (z.share * 100).toFixed(z.share < 0.1 ? 1 : 0) + "%" : "";
      const li = el("li", { title: `${z.code}: ${z.name}. ${z.features.length} area(s).`, on: {
        mouseenter: () => { S.hoverZone = z.i; redraw(); }, mouseleave: () => { S.hoverZone = null; redraw(); },
      } },
        el("label", {}, cb, el("span", { class: "chip", style: `background:${z.color}` }),
          el("span", { class: "zcode", textContent: z.code }), el("span", { class: "zname", textContent: z.name })),
        el("button", { class: "link only", type: "button", textContent: "only", title: "Show only this zone", on: { click: () => {
          zones.forEach((o) => { if (o.i === z.i) S.hidden.delete(o.i); else S.hidden.add(o.i); o.cb.checked = o.i === z.i; });
          redraw();
        } } }),
        el("span", { class: "zshare", textContent: z.features.length ? share : "unused" }));
      ul.append(li);
    });
    $("zone-count").textContent = `${n} used, ${features.length} areas`;
  }
  function setAllZones(show) {
    zones.forEach((z) => { if (show) S.hidden.delete(z.i); else S.hidden.add(z.i); z.cb.checked = show; });
    redraw();
  }

  /* ---------- doubts ---------- */
  function renderDoubts() {
    const ul = $("doubts"); ul.replaceChildren();
    D.doubts.forEach((d, i) => {
      const cb = el("input", { type: "checkbox", checked: !!S.checked[d.id], title: "I've looked at this", "aria-label": "Checked", on: { change: () => {
        S.checked[d.id] = cb.checked; saveDraft(); renderDoubts(); redraw();
      } } });
      const txt = el(d.bbox ? "button" : "span", { class: "dtext" + (d.bbox ? "" : " noloc"), textContent: `${i + 1}. ${d.text}` });
      if (d.bbox) { txt.type = "button"; txt.addEventListener("click", () => goDoubt(i)); }
      const meta = el("div", { class: "dmeta" },
        el("span", { textContent: d.bbox ? "" : "no location" }),
        el("button", { class: "link danger", type: "button", textContent: S.wrong[d.id] ? "marked wrong" : "Wrong", on: { click: () => doubtWrong(d, i) } }));
      ul.append(el("li", { class: (S.activeDoubt === i ? "active " : "") + (S.checked[d.id] ? "checked " : "") + (S.wrong[d.id] ? "wrong" : "") }, cb, txt, meta));
    });
    const seen = D.doubts.filter((d) => S.checked[d.id]).length;
    $("doubt-count").textContent = D.doubts.length ? `${seen} of ${D.doubts.length} checked` : "none";
  }
  function goDoubt(i) {
    S.activeDoubt = i;
    const d = D.doubts[i];
    if (d.bbox) jumpTo(d.bbox);
    renderDoubts();
    const li = $("doubts").children[i];
    if (li) li.scrollIntoView({ block: "nearest" });
    redraw();
  }
  function nextDoubt(step) {
    const located = D.doubts.map((d, i) => (d.bbox ? i : -1)).filter((i) => i >= 0);
    if (!located.length) return;
    const at = located.indexOf(S.activeDoubt);
    const n = at < 0 ? (step > 0 ? 0 : located.length - 1) : (at + step + located.length) % located.length;
    goDoubt(located[n]);
  }
  function doubtWrong(d, i) {
    S.checked[d.id] = true; S.wrong[d.id] = true; saveDraft();
    S.activeDoubt = i;
    if (d.bbox) {
      const b = d.bbox;
      jumpTo(b);
      addNote(b[2] - b[0] < 2 && b[3] - b[1] < 2 ? { type: "pin", point: [b[0], b[1]] } : { type: "box", bbox: [...b] }, { doubt: d.id, note: `About doubt ${i + 1}: ` });
    } else {
      $("sb-comment").value += ($("sb-comment").value ? "\n" : "") + `Doubt ${i + 1} is wrong: `;
      openSubmit("changes_requested");
    }
    renderDoubts();
  }

  /* ---------- changes and prior review ---------- */
  function renderCompare() {
    if (!D.previous) return;
    $("sec-compare").hidden = false; $("btn-cmp").hidden = false;
    $("change-count").textContent = changes.length ? `${changes.length} vs r${D.previous.revision}` : `none vs r${D.previous.revision}`;
    const ul = $("changes"); ul.replaceChildren();
    changes.forEach((c) => ul.append(el("li", { tabIndex: 0, title: "Jump to this change", on: {
      click: () => { setCompare(true); jumpTo(c.bbox, 80); },
      keydown: (e) => { if (e.key === "Enter") { setCompare(true); jumpTo(c.bbox, 80); } },
    } }, el("b", { textContent: `${c.from || "blank"} → ${c.to || "blank"}` }), ` ${Math.round(c.area).toLocaleString()} sq px`)));
    if (!changes.length) ul.append(el("li", { class: "hint", textContent: "No polygons changed." }));
  }
  function renderPrior() {
    const p = D.prior;
    if (!p || !p.annotations) return;
    $("sec-prior").hidden = false; $("sec-prior").open = true;
    $("prior-count").textContent = `${p.annotations.length} from r${p.revision}`;
    const replies = {};
    for (const r of p.responses || []) replies[r.id] = r;
    const ul = $("prior"); ul.replaceChildren();
    if (p.comment) ul.append(el("li", {}, el("b", { textContent: "Reviewer: " }), p.comment));
    p.annotations.forEach((a, i) => {
      const r = replies[a.id];
      const b = a.type === "pin" ? [a.point[0], a.point[1], a.point[0], a.point[1]] : a.bbox;
      ul.append(el("li", {},
        el("button", { class: "link", type: "button", textContent: `p${i + 1}`, title: "Jump to this note", on: { click: () => { setCompare(true); jumpTo(b, 100); } } }),
        ` ${a.problem || ""}${a.should_be ? " → " + a.should_be : ""}: ${a.note || ""}`,
        el("span", { class: "reply" }, el("b", { textContent: r ? (r.status || "reply") + ": " : "No reply recorded" }), r ? r.reply || "" : "")));
    });
  }

  /* ---------- annotations ---------- */
  const DRAFT_KEY = `zoning-review:${D.map_id}:r${D.revision}`;
  function saveDraft() {
    store.set(DRAFT_KEY, JSON.stringify({ annotations: S.annotations, checked: S.checked, wrong: S.wrong, nextId: S.nextId, comment: $("sb-comment").value }));
  }
  function loadDraft() {
    const raw = store.get(DRAFT_KEY);
    if (!raw) return;
    try {
      const d = JSON.parse(raw);
      S.annotations = d.annotations || []; S.checked = d.checked || {}; S.wrong = d.wrong || {}; S.nextId = d.nextId || 1;
      $("sb-comment").value = d.comment || "";
    } catch (e) { /* ignore a broken draft */ }
  }
  function noteCenter(a) {
    if (a.type === "pin") return a.point;
    return [(a.bbox[0] + a.bbox[2]) / 2, (a.bbox[1] + a.bbox[3]) / 2];
  }
  function addNote(a, extra) {
    const [cx, cy] = noteCenter(a);
    const f = featureAt(cx, cy);
    const note = { id: "a" + S.nextId++, ...a, problem: "wrong_zone", should_be: "", note: "", current_zone: f ? zones[f.z].code : null, ...(extra || {}) };
    S.annotations.push(note);
    saveDraft(); renderNotes(); redraw();
    openForm(note);
  }
  function deleteNote(a) {
    S.annotations = S.annotations.filter((o) => o !== a);
    if (a.doubt) { delete S.wrong[a.doubt]; renderDoubts(); }
    saveDraft(); renderNotes(); closeForm(); redraw();
  }
  const PROBLEMS = { wrong_zone: "Wrong zone", boundary_wrong: "Boundary", missing_area: "Missing area", extra_area: "Extra area", label_misread: "Label misread", other: "Other" };
  function renderNotes() {
    const ul = $("notes"); ul.replaceChildren();
    $("notes-empty").hidden = S.annotations.length > 0;
    $("note-count").textContent = S.annotations.length || "";
    S.annotations.forEach((a, i) => {
      const b = a.type === "pin" ? [a.point[0], a.point[1], a.point[0], a.point[1]] : a.bbox;
      const open = () => { jumpTo(b, 100); openForm(a); };
      ul.append(el("li", { tabIndex: 0, on: { click: open, keydown: (e) => { if (e.key === "Enter") open(); } } },
        el("span", { class: "num", textContent: i + 1 }),
        el("b", { textContent: PROBLEMS[a.problem] || a.problem }),
        a.should_be ? ` → ${a.should_be}` : "",
        a.note ? `: ${a.note}` : ""));
    });
  }
  const form = $("note-form");
  function openForm(a) {
    S.editing = a;
    const i = S.annotations.indexOf(a);
    $("nf-title").textContent = `Note ${i + 1} (${a.type})`;
    $("nf-problem").value = a.problem; $("nf-should").value = a.should_be; $("nf-note").value = a.note;
    form.hidden = false;
    placeForm(a);
    const n = $("nf-note");
    n.focus(); n.setSelectionRange(n.value.length, n.value.length);
  }
  function placeForm(a) {
    const [cx, cy] = noteCenter(a), dpr = DPR();
    const r = stage.getBoundingClientRect();
    const v = goal.on ? goal : view;    // where the map is heading, if it is moving
    const x = (v.x + cx * v.s) / dpr + 24, y = (v.y + cy * v.s) / dpr - 40;
    form.style.left = Math.max(8, Math.min(x, r.width - form.offsetWidth - 8)) + "px";
    form.style.top = Math.max(50, Math.min(y, r.height - form.offsetHeight - 8)) + "px";
  }
  function saveForm() {
    const a = S.editing; if (!a) return;
    a.problem = $("nf-problem").value; a.should_be = $("nf-should").value.trim(); a.note = $("nf-note").value.trim();
    saveDraft(); renderNotes(); closeForm(); redraw();
  }
  function closeForm() { S.editing = null; form.hidden = true; canvas.focus({ preventScroll: true }); }

  /* ---------- review document and marked-up image ---------- */
  function reviewDoc(decision, reviewer) {
    return {
      schema: 1, map_id: D.map_id, revision: D.revision, geojson_sha256: D.geojson_sha256,
      frame: { width: W, height: H, rotate: D.frame.rotate, note: "Coordinates are map pixels of overlay.png (upright frame). tools/annotations.py converts them to trace coordinates." },
      decision, reviewer: reviewer || null, submitted_at: new Date().toISOString(),
      comment: $("sb-comment").value.trim(),
      doubts: D.doubts.map((d) => ({ id: d.id, checked: !!S.checked[d.id], wrong: !!S.wrong[d.id] })),
      annotations: S.annotations.map((a) => JSON.parse(JSON.stringify(a))),
    };
  }
  function loadTileNow(L, x, y) {
    return new Promise((res) => {
      const t = tile(L, x, y, true);
      if (t.state === "ready" || t.state === "error") return res(t);
      (t.waiters = t.waiters || []).push(() => res(t));
      pump();
    });
  }
  async function renderMarkup() {
    const long = 1400;       // keeps the PNG small enough to commit (about 3 MB at worst)
    const scale = Math.min(1, long / Math.max(W, H));
    const L = Math.max(0, Math.min(I.levels.length - 1, Math.floor(Math.log2(1 / scale))));
    const lev = I.levels[L], jobs = [];
    for (let r = 0; r < lev.rows; r++) for (let q = 0; q < lev.cols; q++) jobs.push(loadTileNow(L, q, r));
    await Promise.all(jobs);
    const mw = Math.round(W * scale), mh = Math.round(H * scale);
    const lines = [`${D.title}, revision ${D.revision}`];
    S.annotations.forEach((a, i) => lines.push(`${i + 1}. ${PROBLEMS[a.problem] || a.problem}${a.should_be ? " -> " + a.should_be : ""}${a.current_zone ? " (now " + a.current_zone + ")" : ""}${a.note ? ": " + a.note : ""}`));
    const meas = document.createElement("canvas").getContext("2d");
    meas.font = "15px system-ui,sans-serif";
    const wrapped = [];
    for (const line of lines) {
      let cur = "";
      for (const w of line.split(" ")) {
        if (meas.measureText(cur + " " + w).width > mw - 24 && cur) { wrapped.push(cur); cur = w; } else cur = cur ? cur + " " + w : w;
      }
      wrapped.push(cur);
    }
    const textH = wrapped.length * 21 + 16;
    const out = document.createElement("canvas");
    out.width = mw; out.height = mh + textH;
    const c = out.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, out.width, out.height);
    const v = { x: 0, y: 0, s: scale };
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
    drawLevel(c, L, v, mw, mh, false);
    drawZones(c, v, { opacity: S.opacity, lw: 1, outlines: false });
    drawNotes(c, v, 1.3);
    c.fillStyle = "#111"; c.font = "15px system-ui,sans-serif"; c.textBaseline = "top"; c.textAlign = "left";
    wrapped.forEach((t, i) => c.fillText(t, 12, mh + 8 + i * 21));
    return new Promise((res) => {
      try { out.toBlob((b) => res(b), "image/png"); } catch (e) { res(null); }   // file:// pages taint the canvas
    });
  }
  function download(blob, name) {
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------- GitHub decision flow ---------- */
  const STATE_LABELS = ["queued", "tracing", "needs-review", "changes-requested", "approved", "failed"];
  const cfg = D.config || {};
  const API = (cfg.api_base || "https://api.github.com").replace(/\/$/, "");
  const BRANCH = cfg.branch || "main";
  const TOKEN_KEY = "zoning-review:token", REPO_KEY = "zoning-review:repo";
  async function gh(path, token, opts) {
    const res = await fetch(API + path, { ...(opts || {}), headers: {
      Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28",
      ...(opts && opts.body ? { "Content-Type": "application/json" } : {}),
    } });
    if (!res.ok) {
      let m = ""; try { m = (await res.json()).message || ""; } catch (e) { /* no body */ }
      const err = new Error(`GitHub said ${res.status}${m ? ": " + m : ""}`); err.status = res.status; throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  const b64text = (s) => {
    const bytes = new TextEncoder().encode(s); let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(bin);
  };
  const b64blob = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer()); let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(bin);
  };
  /** One commit containing all files, on top of the branch head; retried if someone else pushed. */
  async function commitFiles(repo, token, files, message) {
    const blobs = [];
    for (const f of files) {
      const b = await gh(`/repos/${repo}/git/blobs`, token, { method: "POST", body: JSON.stringify({ content: f.base64, encoding: "base64" }) });
      blobs.push({ path: f.path, mode: "100644", type: "blob", sha: b.sha });
    }
    for (let attempt = 0; ; attempt++) {
      const ref = await gh(`/repos/${repo}/git/ref/heads/${BRANCH}`, token);
      const head = await gh(`/repos/${repo}/git/commits/${ref.object.sha}`, token);
      const tree = await gh(`/repos/${repo}/git/trees`, token, { method: "POST", body: JSON.stringify({ base_tree: head.tree.sha, tree: blobs }) });
      const com = await gh(`/repos/${repo}/git/commits`, token, { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }) });
      try {
        await gh(`/repos/${repo}/git/refs/heads/${BRANCH}`, token, { method: "PATCH", body: JSON.stringify({ sha: com.sha }) });
        return com.sha;
      } catch (e) {
        if (attempt >= 3 || (e.status !== 409 && e.status !== 422)) throw e;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  async function findIssue(repo, token) {
    const q = new URLSearchParams(location.search).get("issue");
    if (q && /^\d+$/.test(q)) return Number(q);
    if (cfg.issue) return cfg.issue;
    for (let page = 1; page <= 10; page++) {
      const list = await gh(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`, token);
      const hit = list.find((i) => !i.pull_request && (i.title || "").includes(`[${D.map_id}]`));
      if (hit) return hit.number;
      if (list.length < 100) break;
    }
    throw new Error(`No open issue found for ${D.map_id}. Open this page from the link in the issue.`);
  }
  const md = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  function commentBody(doc, repo, hasPng) {
    const dir = `reviews/${D.map_id}/r${D.revision}`;
    const web = (cfg.web_base || "https://github.com").replace(/\/$/, "");
    const head = doc.decision === "approved" ? "**Approved**" : "**Changes requested**";
    const seen = doc.doubts.filter((d) => d.checked).length;
    const out = [`${head} on revision ${D.revision}${doc.reviewer ? ` by @${doc.reviewer}` : ""}.`, "",
      `Doubts checked: ${seen} of ${doc.doubts.length}. Notes: ${doc.annotations.length}.`];
    if (doc.comment) out.push("", "> " + doc.comment.replace(/\r?\n/g, "\n> "));
    if (doc.annotations.length) {
      out.push("", "| # | Type | Problem | Should be | Where | Note |", "|---|---|---|---|---|---|");
      doc.annotations.forEach((a, i) => {
        const b = a.type === "pin" ? a.point : a.bbox;
        out.push(`| ${i + 1} | ${a.type} | ${md(PROBLEMS[a.problem] || a.problem)} | ${md(a.should_be)} | ${b.join(", ")} | ${md(a.note)} |`);
      });
    }
    out.push("", `Saved in [${dir}/annotations.json](${web}/${repo}/blob/${BRANCH}/${dir}/annotations.json).`);
    if (hasPng) out.push("", `![marked-up map](${web}/${repo}/blob/${BRANCH}/${dir}/markup.png?raw=true)`);
    return out.join("\n");
  }
  let decision = null, doneSteps = {};
  function setStep(name, cls) {
    const list = $("sb-steps"); list.hidden = false;
    let li = list.querySelector(`[data-step="${name}"]`);
    if (!li) { li = el("li", { textContent: name }); li.dataset.step = name; list.append(li); }
    li.className = cls || "";
  }
  async function step(name, fn) {
    if (doneSteps[name] !== undefined) { setStep(name, "done"); return doneSteps[name]; }
    setStep(name);
    try {
      const v = await fn();
      doneSteps[name] = v === undefined ? true : v;
      setStep(name, "done");
      return v;
    } catch (e) { setStep(name, "fail"); throw e; }
  }
  async function send() {
    const repo = $("sb-repo").value.trim(), token = $("sb-token").value.trim();
    const errBox = $("sb-error"); errBox.hidden = true;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { errBox.textContent = "Repository should look like owner/name."; errBox.hidden = false; return; }
    if (!token) { errBox.textContent = "Paste your token, or use Download JSON to hand the review over without one."; errBox.hidden = false; return; }
    store.set(TOKEN_KEY, token); store.set(REPO_KEY, repo);
    $("sb-send").disabled = true;
    try {
      // A scoped token may not be allowed to read the profile (403): the name is only a courtesy
      const me = await step("Check token", () => gh("/user", token).catch((e) => { if (e.status === 403) return {}; throw e; }));
      $("sb-who").textContent = me.login ? "Signed in as " + me.login : "";
      const issue = await step("Find the issue", () => findIssue(repo, token));
      const doc = reviewDoc(decision, me.login);
      const png = await step("Render marked-up image", renderMarkup);
      const dir = `reviews/${D.map_id}/r${D.revision}`;
      await step("Save review to the repository", async () => {
        const files = [{ path: `${dir}/annotations.json`, base64: b64text(JSON.stringify(doc, null, 2) + "\n") }];
        if (png) files.push({ path: `${dir}/markup.png`, base64: await b64blob(png) });
        await commitFiles(repo, token, files, `Review ${D.map_id} r${D.revision}: ${decision}`);
      });
      await step("Post comment", () => gh(`/repos/${repo}/issues/${issue}/comments`, token, { method: "POST", body: JSON.stringify({ body: commentBody(doc, repo, !!png) }) }));
      await step("Update labels", async () => {
        const iss = await gh(`/repos/${repo}/issues/${issue}`, token);
        const keep = (iss.labels || []).map((l) => l.name).filter((n) => !STATE_LABELS.includes(n));
        keep.push(decision === "approved" ? "approved" : "changes-requested");
        await gh(`/repos/${repo}/issues/${issue}/labels`, token, { method: "PUT", body: JSON.stringify({ labels: keep }) });
      });
      store.del(DRAFT_KEY);
      $("sb-send").textContent = "Sent";
      $("sb-cancel").textContent = "Close";
      $("sb-title").textContent = decision === "approved" ? "Approved and sent" : "Changes requested and sent";
    } catch (e) {
      errBox.textContent = `${e.message}\nNothing is lost: your notes are still here. Fix the problem and press Send again, or use Download JSON.`;
      errBox.hidden = false;
      $("sb-send").disabled = false;
    }
  }
  function openSubmit(kind) {
    decision = kind; doneSteps = {};
    $("sb-steps").replaceChildren(); $("sb-steps").hidden = true; $("sb-error").hidden = true;
    $("sb-send").disabled = false; $("sb-send").textContent = "Send"; $("sb-cancel").textContent = "Cancel";
    $("sb-title").textContent = kind === "approved" ? `Approve revision ${D.revision}` : `Request changes on revision ${D.revision}`;
    $("sb-repo").value = store.get(REPO_KEY) || cfg.repo || "";
    $("sb-token").value = store.get(TOKEN_KEY) || "";
    const seen = D.doubts.filter((d) => S.checked[d.id]).length;
    $("sb-summary").textContent = `${S.annotations.length} note(s). ${seen} of ${D.doubts.length} doubts checked.`;
    const w = $("sb-warn"); w.hidden = true;
    const blank = S.annotations.filter((a) => !a.note && !a.should_be).length;
    if (kind === "approved" && S.annotations.length) { w.textContent = "You have notes on this map. Approving keeps them on record, but the agent won't act on them."; w.hidden = false; }
    else if (kind === "approved" && seen < D.doubts.length) { w.textContent = `${D.doubts.length - seen} doubt(s) not checked yet.`; w.hidden = false; }
    else if (kind !== "approved" && blank) { w.textContent = `${blank} note(s) have no text or correct zone. The agent will only have the location to go on.`; w.hidden = false; }
    $("submit").showModal();
  }
  async function checkLatest() {
    try {
      const r = await fetch("../latest.json", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (j.revision > D.revision) {
        const s = $("stale"); s.hidden = false;
        s.replaceChildren(`Revision ${j.revision} is newer. `, el("a", { href: `../r${j.revision}/${location.search}`, textContent: "Open it" }));
        $("btn-approve").disabled = true; $("btn-changes").disabled = true;
      }
    } catch (e) { /* opened from disk: no check */ }
  }

  /* ---------- keyboard ---------- */
  function typing(t) { return t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); }
  document.addEventListener("keydown", (ev) => {
    if (document.querySelector("dialog[open]")) return;
    if (typing(ev.target)) {
      if (ev.key === "Escape") { closeForm(); ev.preventDefault(); }
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && S.editing) { saveForm(); ev.preventDefault(); }
      return;
    }
    if (ev.altKey || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() !== "z")) return;
    const k = ev.key, cx = canvas.width / 2, cy = canvas.height / 2, step = 120 * DPR();
    const lower = k.length === 1 ? k.toLowerCase() : k;
    switch (lower) {
      case "v": setTool("pan"); break;
      case "p": setTool("pin"); break;
      case "b": setTool("box"); break;
      case "f": setTool("draw"); break;
      case "t": setMode(S.mode === "scan" ? S.lastMode : "scan"); break;
      case "o": setMode(S.mode === "outlines" ? "overlay" : "outlines"); break;
      case "s": setSwipe(!S.swipe); break;
      case "c": setCompare(!S.compare); break;
      case "d": S.showDoubts = !S.showDoubts; redraw(); break;
      case "n": nextDoubt(ev.shiftKey ? -1 : 1); break;
      case "x": {
        const d = D.doubts[S.activeDoubt];
        if (d) { S.checked[d.id] = true; saveDraft(); }
        nextDoubt(1);
        break;
      }
      case "[": setOpacity(S.opacity - 0.1); break;
      case "]": setOpacity(S.opacity + 0.1); break;
      case "+": case "=": zoomAt(cx, cy, 1.5, true); break;
      case "-": case "_": zoomAt(cx, cy, 1 / 1.5, true); break;
      case "0": fit(true); break;
      case "l": document.body.classList.toggle("noside"); break;
      case "?": $("help").showModal(); break;
      case "ArrowLeft": setGoal(view.x + step, view.y, view.s, true); break;
      case "ArrowRight": setGoal(view.x - step, view.y, view.s, true); break;
      case "ArrowUp": setGoal(view.x, view.y + step, view.s, true); break;
      case "ArrowDown": setGoal(view.x, view.y - step, view.s, true); break;
      case " ":
        if (!ev.repeat) { S.peek = true; redraw(); }
        break;
      case "Escape":
        if (S.draft) { S.draft = null; drag = null; redraw(); }
        else if (S.tool !== "pan") setTool("pan");
        else if (S.selected) { S.selected = null; $("st-info").textContent = ""; redraw(); }
        break;
      case "z":
        if (ev.ctrlKey || ev.metaKey) { const a = S.annotations[S.annotations.length - 1]; if (a) deleteNote(a); break; }
        return;
      default: return;
    }
    ev.preventDefault();
  });
  document.addEventListener("keyup", (ev) => { if (ev.key === " ") { S.peek = false; redraw(); } });
  window.addEventListener("blur", () => { if (S.peek) { S.peek = false; redraw(); } });

  /* ---------- wire up ---------- */
  document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("btn-swipe").addEventListener("click", () => setSwipe(!S.swipe));
  $("btn-cmp").addEventListener("click", () => setCompare(!S.compare));
  $("cmp-on").addEventListener("change", (e) => setCompare(e.target.checked));
  $("opacity").addEventListener("input", (e) => setOpacity(e.target.value / 100));
  $("zoom-in").addEventListener("click", () => zoomAt(canvas.width / 2, canvas.height / 2, 1.5, true));
  $("zoom-out").addEventListener("click", () => zoomAt(canvas.width / 2, canvas.height / 2, 1 / 1.5, true));
  $("zoom-fit").addEventListener("click", () => fit(true));
  $("zones-all").addEventListener("click", () => setAllZones(true));
  $("zones-none").addEventListener("click", () => setAllZones(false));
  $("btn-side").addEventListener("click", () => document.body.classList.toggle("noside"));
  $("btn-help").addEventListener("click", () => $("help").showModal());
  $("help-close").addEventListener("click", () => $("help").close());
  $("btn-approve").addEventListener("click", () => openSubmit("approved"));
  $("btn-changes").addEventListener("click", () => openSubmit("changes_requested"));
  $("sb-cancel").addEventListener("click", () => { saveDraft(); $("submit").close(); });
  $("sb-send").addEventListener("click", send);
  $("sb-forget").addEventListener("click", () => { store.del(TOKEN_KEY); $("sb-token").value = ""; $("sb-who").textContent = "Token removed from this browser."; });
  $("sb-json").addEventListener("click", () => {
    download(new Blob([JSON.stringify(reviewDoc(decision, null), null, 2) + "\n"], { type: "application/json" }), `${D.map_id}_r${D.revision}_annotations.json`);
  });
  $("sb-png").addEventListener("click", async () => {
    const b = await renderMarkup();
    if (b) download(b, `${D.map_id}_r${D.revision}_markup.png`);
    else { $("sb-error").textContent = "The browser blocked the image because this page was opened from disk. Host it, or serve it locally."; $("sb-error").hidden = false; }
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); saveForm(); });
  $("nf-close").addEventListener("click", saveForm);
  $("nf-delete").addEventListener("click", () => { if (S.editing) deleteNote(S.editing); });

  document.title = `${D.title}, revision ${D.revision}`;
  $("title").textContent = D.title;
  $("rev").textContent = `${D.map_id}, revision ${D.revision}`;
  const dl = $("nf-zones");
  zones.forEach((z) => dl.append(el("option", { value: z.code, label: z.name })));
  const agentNotes = $("agent-notes");
  (D.notes || []).forEach((n) => agentNotes.append(el("li", { textContent: n })));
  const facts = $("facts");
  (D.facts || []).forEach(([k, v]) => facts.append(el("dt", { textContent: k }), el("dd", { textContent: v })));

  loadDraft();
  if (S.annotations.length) $("sec-notes-mine").open = true;
  setTool("pan"); setMode("overlay"); setSwipe(false); setCompare(false);
  renderZones(); renderDoubts(); renderCompare(); renderPrior(); renderNotes();
  new ResizeObserver(resize).observe(stage);
  resize();
  loadTileNow(I.levels.length - 1, 0, 0);   // coarsest level first, so something shows at once
  redraw();
  checkLatest();
  window.__review = { S, view, D, frame, renderMarkup, reviewDoc, features, zones, featureAt, goDoubt, jumpTo, tiles, fit, setGoal, canvas, setSwipe, setMode, setCompare, addNote, saveForm };
})();
