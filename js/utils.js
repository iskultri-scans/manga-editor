/* =========================================================================
   utils.js — shared helpers
   Attached to window.MangaUtils (no module system; loaded via plain <script>).
   ========================================================================= */
(function (global) {
  'use strict';

  const Utils = {};

  /* ---------- Color helpers ---------- */

  /**
   * Squared RGB Euclidean distance (skip sqrt for speed; tolerance compared squared).
   * Uses RGB only — sufficient for manga bubbles which are mostly gray/white.
   * Alpha is included so transparent regions don't match opaque ones.
   */
  Utils.colorDistSq = function (r1, g1, b1, a1, r2, g2, b2, a2) {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2, da = a1 - a2;
    return dr * dr + dg * dg + db * db + da * da;
  };

  /**
   * Linear interpolation between two colors. t in [0,1]. Returns [r,g,b,a].
   */
  Utils.lerpColor = function (c1, c2, t) {
    return [
      c1[0] + (c2[0] - c1[0]) * t,
      c1[1] + (c2[1] - c1[1]) * t,
      c1[2] + (c2[2] - c1[2]) * t,
      c1[3] + (c2[3] - c1[3]) * t
    ];
  };

  /** Parse "#rrggbb" or "#rgb" or "rgb(r,g,b)" into [r,g,b] ints. Returns null on failure. */
  Utils.parseColor = function (str) {
    if (!str || typeof str !== 'string') return null;
    let s = str.trim();
    if (s.startsWith('#')) {
      let hex = s.slice(1);
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      if (hex.length !== 6) return null;
      const n = parseInt(hex, 16);
      if (isNaN(n)) return null;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    }
    const m = s.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      const parts = m[1].split(',').map(x => parseFloat(x));
      if (parts.length < 3 || parts.some(isNaN)) return null;
      return [parts[0] | 0, parts[1] | 0, parts[2] | 0, parts[3] === undefined ? 255 : parts[3] | 0];
    }
    return null;
  };

  /** Convert [r,g,b] (alpha assumed 255) to "#rrggbb" string. */
  Utils.rgbToHex = function (r, g, b) {
    const h = n => n.toString(16).padStart(2, '0');
    return '#' + h(r & 255) + h(g & 255) + h(b & 255);
  };

  /* ---------- Geometry helpers ---------- */

  Utils.dist = function (x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  };

  /** Squared distance — cheaper, use when comparing only. */
  Utils.distSq = function (x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    return dx * dx + dy * dy;
  };

  /** Distance from point P to segment AB. */
  Utils.pointSegDist = function (px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Utils.dist(px, py, ax, ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Utils.dist(px, py, ax + t * dx, ay + t * dy);
  };

  /** Test if point (x,y) is inside an axis-aligned rect {x,y,w,h}. */
  Utils.pointInRect = function (px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  };

  /**
   * Point-in-polygon test (ray casting). polygon = [[x,y],...].
   * Robust for any simple polygon (convex or concave).
   */
  Utils.pointInPolygon = function (px, py, polygon) {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };

  /** Bounding box of a polygon. Returns {x,y,w,h} or null if empty. */
  Utils.polygonBBox = function (polygon) {
    if (!polygon || !polygon.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of polygon) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  };

  /* ---------- Misc ---------- */

  /** Clamp value to [min,max]. */
  Utils.clamp = function (v, min, max) {
    return v < min ? min : v > max ? max : v;
  };

  /** Throttle via requestAnimationFrame — coalesces multiple calls per frame. */
  Utils.rafThrottle = function (fn) {
    let scheduled = false;
    let lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        fn.apply(this, lastArgs);
      });
    };
  };

  /** Debounce — fire only after `ms` of inactivity. */
  Utils.debounce = function (fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  };

  /** Short toast message. Optional second arg = duration in ms (default 1800). */
  let toastEl = null, toastTimer = null;
  Utils.toast = function (msg, duration) {
    if (!toastEl) toastEl = document.getElementById('toast');
    if (!toastEl) { console.log('[toast]', msg); return; }
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), duration || 1800);
  };

  /** Format zoom percentage for display. */
  Utils.formatZoom = function (scale) {
    return Math.round(scale * 100) + '%';
  };

  /**
   * Construct a Web Worker from an in-memory function (via Blob URL).
   * This makes workers work even under file:// protocol, where separate
   * .js worker files would be blocked by the same-origin policy.
   * Returns the Worker instance.
   */
  Utils.createInlineWorker = function (workerFn) {
    const src = '(' + workerFn.toString() + ')();';
    const blob = new Blob([src], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      return new Worker(url);
    } finally {
      // Revoke after a tick — Worker has already loaded the script by then.
      // (We don't revoke synchronously to be safe across browsers.)
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  };

  /**
   * Create a separate canvas + context. Centralized so we always set the same
   * defaults (willReadFrequently=true so getImageData doesn't trigger GPU→CPU
   * readback penalties on Chrome/Android).
   */
  Utils.makeCanvas = function (w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return { canvas: c, ctx: ctx };
  };

  /** Determine if running on a touch-primary device. */
  Utils.isTouch = function () {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  };

  /** Get a stable pointer id from a PointerEvent (works for touch + mouse + pen). */
  Utils.isPrimaryButton = function (e) {
    return e.button === 0 || e.button === -1 || e.pointerType === 'touch';
  };

  global.MangaUtils = Utils;
})(window);
