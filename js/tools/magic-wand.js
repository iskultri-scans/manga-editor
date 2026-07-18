/* =========================================================================
   tools/magic-wand.js — Advanced flood-fill selection.

   Features:
   - Scanline flood fill (Heckbert's algorithm) — fast, no stack overflow.
   - Sample size: 1x1 (point), 3x3, 5x5 average — anti-noise.
   - Sample source: original layer | composite (original + edits) | edit layer.
   - Color space: RGB | Luminance | Hue (luminance is best for B/W manga).
   - Anti-alias: smooth gradient edges (intermediate mask values 0..255).
   - Multi-seed: shift+tap adds to selection; tap without shift replaces.
   - Selection modes: New | Add | Subtract | Intersect.
   - Live preview during drag (drag radius = tolerance scrub).
   - Runs in Web Worker for large images.
   ========================================================================= */
(function (global) {
  'use strict';

  const U = global.MangaUtils;

  /* ---------- Worker source ---------- */
  function _workerMain() {
    self.onmessage = function (e) {
      const msg = e.data;
      try {
        let mask;
        if (msg.op === 'flood') {
          mask = floodFill(msg);
        } else if (msg.op === 'global') {
          mask = globalSelect(msg);
        } else {
          self.postMessage({ op: 'error', message: 'Unknown op: ' + msg.op, requestId: msg.requestId });
          return;
        }
        self.postMessage({ op: 'done', mask: mask, requestId: msg.requestId }, [mask.buffer]);
      } catch (err) {
        self.postMessage({ op: 'error', message: String(err && err.message || err), requestId: msg.requestId });
      }
    };

    /* ---------- Color sampling ---------- */

    /** Average color in NxN window centered at (x,y). Returns [r,g,b,a]. */
    function sampleAvg(data, w, h, x, y, size) {
      if (size <= 1) {
        const i = (y * w + x) * 4;
        return [data[i], data[i+1], data[i+2], data[i+3]];
      }
      const half = (size - 1) >> 1;
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w - 1, x + half);
      const y0 = Math.max(0, y - half);
      const y1 = Math.min(h - 1, y + half);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const i = (yy * w + xx) * 4;
          r += data[i]; g += data[i+1]; b += data[i+2]; a += data[i+3];
          cnt++;
        }
      }
      if (cnt === 0) return [0,0,0,0];
      return [r/cnt, g/cnt, b/cnt, a/cnt];
    }

    /** Compute color distance based on selected color space. */
    function colorDistance(data, idx, seed, colorSpace) {
      const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];
      if (colorSpace === 'luminance') {
        // Use perceptual luminance; ignores chroma noise. Great for B/W manga.
        const lum1 = 0.299*r + 0.587*g + 0.114*b;
        const lum2 = 0.299*seed[0] + 0.587*seed[1] + 0.114*seed[2];
        const dl = lum1 - lum2;
        const da = a - seed[3];
        return dl*dl + da*da*0.5;
      } else if (colorSpace === 'hue') {
        // Hue distance (for selecting by chroma, ignoring brightness).
        // Convert to HSL-ish hue.
        const max1 = Math.max(r,g,b), min1 = Math.min(r,g,b);
        const max2 = Math.max(seed[0],seed[1],seed[2]), min2 = Math.min(seed[0],seed[1],seed[2]);
        // If nearly gray, distance is just luminance diff (no meaningful hue).
        if (max1 - min1 < 10 || max2 - min2 < 10) {
          const lum1 = 0.299*r + 0.587*g + 0.114*b;
          const lum2 = 0.299*seed[0] + 0.587*seed[1] + 0.114*seed[2];
          const dl = lum1 - lum2;
          return dl*dl;
        }
        const h1 = rgbToHue(r, g, b);
        const h2 = rgbToHue(seed[0], seed[1], seed[2]);
        let dh = Math.abs(h1 - h2);
        if (dh > 180) dh = 360 - dh;
        return dh * dh * 4;
      } else {
        // Default: RGB euclidean.
        const dr = r - seed[0], dg = g - seed[1], db = b - seed[2], da = a - seed[3];
        return dr*dr + dg*dg + db*db + da*da;
      }
    }

    function rgbToHue(r, g, b) {
      const max = Math.max(r,g,b), min = Math.min(r,g,b);
      const d = max - min;
      if (d === 0) return 0;
      let h;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      return h;
    }

    /* ---------- Anti-alias edge smoothing ---------- */

    /**
     * Smooth the mask boundary by setting each boundary pixel's strength
     * proportional to how much of its neighborhood is selected. This gives
     * the mask a soft edge (intermediate values 0..255) without losing
     * the overall selection shape.
     */
    function antiAlias(mask, w, h, passes) {
      if (passes <= 0) return mask;
      const tmp = new Float32Array(mask.length);
      for (let p = 0; p < passes; p++) {
        // Copy mask to float.
        for (let i = 0; i < mask.length; i++) tmp[i] = mask[i] / 255;
        // 3x3 box blur on boundary pixels only.
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            // Only blur if it's a boundary pixel (has both sel & unsel neighbors).
            const c = tmp[idx];
            if (c > 0 && c < 1) continue; // already softened
            let selNeighbors = 0, unselNeighbors = 0, total = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= h) continue;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                if (nx < 0 || nx >= w) continue;
                const nv = tmp[ny * w + nx];
                total++;
                if (nv > 0) selNeighbors++;
                else unselNeighbors++;
              }
            }
            if (selNeighbors > 0 && unselNeighbors > 0) {
              // Boundary pixel — set to fraction selected.
              let sum = 0, cnt = 0;
              for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                  const nx = x + dx;
                  if (nx < 0 || nx >= w) continue;
                  sum += tmp[ny * w + nx];
                  cnt++;
                }
              }
              mask[idx] = Math.round((sum / cnt) * 255);
            }
          }
        }
      }
      return mask;
    }

    /* ---------- Contiguous flood fill (scanline) ---------- */

    function floodFill(msg) {
      const data = msg.data;
      const w = msg.w, h = msg.h;
      const startX = msg.startX, startY = msg.startY;
      const tolerance = msg.tolerance;
      const connected = msg.connected || 4;
      const colorSpace = msg.colorSpace || 'rgb';
      const sampleSize = msg.sampleSize || 1;
      const aaPasses = msg.antiAlias || 0;

      const mask = new Uint8Array(w * h);
      if (startX < 0 || startY < 0 || startX >= w || startY >= h) return mask;

      // Sample seed color (averaged over NxN window).
      const seed = sampleAvg(data, w, h, startX, startY, sampleSize);
      // Tolerance is 0..255; convert to squared distance threshold.
      // We use a relative scale so the slider feels consistent across color spaces.
      const tolScale = (tolerance / 255);
      const tolSq = tolScale * tolScale * (4 * 255 * 255);

      const match = (idx) => colorDistance(data, idx, seed, colorSpace) <= tolSq;

      const stack = [[startX, startY]];
      const inStack = new Uint8Array(w * h);
      while (stack.length) {
        const pt = stack.pop();
        const x = pt[0], y = pt[1];
        const idx = y * w + x;
        if (inStack[idx]) continue;
        inStack[idx] = 1;

        // Find left/right bounds of matching span.
        let lx = x;
        while (lx > 0 && !inStack[y * w + (lx - 1)] && match((y * w + (lx - 1)) * 4)) {
          lx--;
          inStack[y * w + lx] = 1;
        }
        let rx = x;
        while (rx < w - 1 && !inStack[y * w + (rx + 1)] && match((y * w + (rx + 1)) * 4)) {
          rx++;
          inStack[y * w + rx] = 1;
        }
        for (let xi = lx; xi <= rx; xi++) mask[y * w + xi] = 255;

        // Check rows above/below for new seeds.
        const rows = [];
        if (y > 0) rows.push(y - 1);
        if (y < h - 1) rows.push(y + 1);
        for (const yi of rows) {
          let inside = false;
          for (let xi = lx; xi <= rx; xi++) {
            const p = yi * w + xi;
            const m = !inStack[p] && match(p * 4);
            if (m && !inside) { stack.push([xi, yi]); inside = true; }
            else if (!m) inside = false;
            // 8-connected: diagonal seeds at span ends.
            if (connected === 8 && xi === lx && lx > 0) {
              const dp = yi * w + (lx - 1);
              if (!inStack[dp] && match(dp * 4)) stack.push([lx - 1, yi]);
            }
            if (connected === 8 && xi === rx && rx < w - 1) {
              const dp = yi * w + (rx + 1);
              if (!inStack[dp] && match(dp * 4)) stack.push([rx + 1, yi]);
            }
          }
        }
      }

      // Anti-alias edge smoothing.
      if (aaPasses > 0) antiAlias(mask, w, h, aaPasses);
      return mask;
    }

    /* ---------- Global (non-contiguous) selection ---------- */

    function globalSelect(msg) {
      const data = msg.data;
      const w = msg.w, h = msg.h;
      const startX = msg.startX, startY = msg.startY;
      const tolerance = msg.tolerance;
      const colorSpace = msg.colorSpace || 'rgb';
      const sampleSize = msg.sampleSize || 1;
      const aaPasses = msg.antiAlias || 0;

      const mask = new Uint8Array(w * h);
      if (startX < 0 || startY < 0 || startX >= w || startY >= h) return mask;

      const seed = sampleAvg(data, w, h, startX, startY, sampleSize);
      const tolScale = (tolerance / 255);
      const tolSq = tolScale * tolScale * (4 * 255 * 255);

      // Optional: gradient mask — pixels closer to seed color are more selected.
      // We compute sqrt(distance)/maxDistance as 0..1 unselected fraction,
      // so mask = 255 * (1 - clamp(d/tol)). This gives nice soft edges for global mode.
      const useGradient = msg.gradient || false;

      if (useGradient) {
        for (let p = 0, i = 0; p < w * h; p++, i += 4) {
          const d = Math.sqrt(colorDistance(data, i, seed, colorSpace));
          const ratio = d / (tolScale * Math.sqrt(4 * 255 * 255));
          if (ratio < 1) {
            mask[p] = Math.round((1 - ratio) * 255);
          }
        }
      } else {
        for (let p = 0, i = 0; p < w * h; p++, i += 4) {
          if (colorDistance(data, i, seed, colorSpace) <= tolSq) mask[p] = 255;
        }
        if (aaPasses > 0) antiAlias(mask, w, h, aaPasses);
      }
      return mask;
    }
  }

  /* ---------- Main-thread API ---------- */

  // Selection combine modes.
  const SEL_NEW = 'new';
  const SEL_ADD = 'add';
  const SEL_SUBTRACT = 'subtract';
  const SEL_INTERSECT = 'intersect';

  class MagicWand {
    constructor(engine, layers, history) {
      this.engine = engine;
      this.layers = layers;
      this.history = history;
      this.worker = null;
      this.busy = false;
      this._busyEl = null;
      this._requestId = 0;
      this._pendingResolve = null;
      this._pendingReject = null;

      // Smart defaults — optimized for manga editing. No user-facing settings
      // beyond a single tolerance slider.
      this.tolerance = 40;
      this.contiguous = true;
      this.connected = 8;
      this.colorSpace = 'luminance';  // best for B/W manga — ignores scan color noise
      this.sampleSize = 3;            // 3x3 — anti-halftone noise
      this.sampleSource = 'original';
      this.antiAlias = 1;             // soft edges by default
      this.gradient = false;
      this.combineMode = SEL_NEW;
    }

    init() { this._initWorker(); }

    _initWorker() {
      try {
        this.worker = U.createInlineWorker(_workerMain);
        this.worker.onmessage = (e) => this._onWorkerMessage(e.data);
        this.worker.onerror = (e) => {
          console.warn('Magic-wand worker error:', e.message || e);
          this.worker = null;
          if (this._pendingReject) {
            this._pendingReject(new Error('Worker error'));
            this._pendingReject = null;
            this._pendingResolve = null;
            this._setBusy(false);
          }
        };
      } catch (err) {
        console.warn('Worker creation failed; using sync fallback:', err);
        this.worker = null;
      }
    }

    _onWorkerMessage(msg) {
      if (msg.requestId !== this._requestId) return;
      this._setBusy(false);
      if (msg.op === 'done') {
        if (this._pendingResolve) this._pendingResolve(msg.mask);
      } else if (msg.op === 'error') {
        if (this._pendingReject) this._pendingReject(new Error(msg.message));
      }
      this._pendingResolve = null;
      this._pendingReject = null;
    }

    _setBusy(b) {
      this.busy = b;
      if (!this._busyEl) this._busyEl = document.getElementById('status-pill');
      if (this._busyEl) {
        if (b) {
          this._busyEl.textContent = 'Selecting';
          this._busyEl.classList.add('busy');
          this._busyEl.classList.remove('hidden');
        } else {
          this._busyEl.classList.remove('busy');
        }
      }
    }

    /**
     * Build ImageData for sampling based on the configured source.
     * - 'original': original layer only (default — stable, edits don't change selection)
     * - 'composite': original + edits + text objects baked in (what you see)
     * - 'edit': edit layer only (useful for selecting brush strokes)
     */
    _getSourceImageData() {
      const w = this.layers.width, h = this.layers.height;
      let ctx;
      if (this.sampleSource === 'original') {
        ctx = this.layers.originalLayer.ctx;
      } else if (this.sampleSource === 'edit') {
        ctx = this.layers.getEditLayer().ctx;
      } else {
        // Composite — draw to a temp canvas.
        const tmp = U.makeCanvas(w, h);
        this.layers.composite(tmp.ctx);
        ctx = tmp.ctx;
      }
      return ctx.getImageData(0, 0, w, h);
    }

    /**
     * Run a flood-fill selection from (startX,startY).
     * Respects combineMode: New | Add | Subtract | Intersect.
     * @returns Promise<Uint8Array> resolved with the FINAL combined mask.
     */
    select(startX, startY) {
      return new Promise((resolve, reject) => {
        if (!this.engine.hasImage()) { reject(new Error('No image')); return; }
        const w = this.layers.width, h = this.layers.height;
        startX = Math.floor(startX);
        startY = Math.floor(startY);
        if (startX < 0 || startY < 0 || startX >= w || startY >= h) {
          // Out of bounds: for "New" mode, return empty mask; for others, no change.
          if (this.combineMode === SEL_NEW) {
            resolve(new Uint8Array(w * h));
            return;
          }
          // Add/Subtract/Intersect with no new data = no change.
          const prev = this.layers.getSelection();
          resolve(prev ? prev.slice(0) : null);
          return;
        }

        const imageData = this._getSourceImageData();
        const opts = {
          data: imageData.data,
          w, h,
          startX, startY,
          tolerance: this.tolerance,
          contiguous: this.contiguous,
          connected: this.connected,
          colorSpace: this.colorSpace,
          sampleSize: this.sampleSize,
          antiAlias: this.antiAlias,
          gradient: this.gradient
        };

        const runWorker = () => {
          if (!this.worker || this.busy) return false;
          this._requestId++;
          this._pendingResolve = (rawMask) => {
            // Combine with existing selection per combineMode.
            const final = this._combine(rawMask);
            resolve(final);
          };
          this._pendingReject = reject;
          this._setBusy(true);
          const dataCopy = new Uint8ClampedArray(imageData.data);
          try {
            const opName = this.contiguous ? 'flood' : 'global';
            this.worker.postMessage(Object.assign({ op: opName, requestId: this._requestId }, opts, { data: dataCopy }), [dataCopy.buffer]);
          } catch (err) {
            this._setBusy(false);
            this._pendingResolve = null;
            this._pendingReject = null;
            return false;
          }
          return true;
        };

        if (!runWorker()) {
          // Synchronous fallback.
          this._setBusy(true);
          setTimeout(() => {
            try {
              const rawMask = this._syncRun(opts);
              this._setBusy(false);
              const final = this._combine(rawMask);
              resolve(final);
            } catch (err) {
              this._setBusy(false);
              reject(err);
            }
          }, 0);
        }
      });
    }

    /** Combine new mask with existing selection based on combineMode. */
    _combine(newMask) {
      const w = this.layers.width, h = this.layers.height;
      const prev = this.layers.getSelection();
      if (this.combineMode === SEL_NEW || !prev) {
        return newMask;
      }
      const out = new Uint8Array(w * h);
      const len = w * h;
      if (this.combineMode === SEL_ADD) {
        for (let i = 0; i < len; i++) {
          out[i] = Math.max(prev[i], newMask[i]);
        }
      } else if (this.combineMode === SEL_SUBTRACT) {
        for (let i = 0; i < len; i++) {
          // newMask is what to subtract; subtract proportionally to its strength.
          const sub = newMask[i] / 255;
          out[i] = Math.round(prev[i] * (1 - sub));
        }
      } else if (this.combineMode === SEL_INTERSECT) {
        for (let i = 0; i < len; i++) {
          // Intersection strength = min(prev, new).
          out[i] = Math.min(prev[i], newMask[i]);
        }
      }
      return out;
    }

    _syncRun(opts) {
      // Inline sync versions of the worker functions.
      const data = opts.data;
      const w = opts.w, h = opts.h;
      const startX = opts.startX, startY = opts.startY;
      const tolerance = opts.tolerance;
      const colorSpace = opts.colorSpace || 'rgb';
      const sampleSize = opts.sampleSize || 1;
      const aaPasses = opts.antiAlias || 0;
      const useGradient = opts.gradient || false;
      const connected = opts.connected || 4;

      const sampleAvg = (x, y, size) => {
        if (size <= 1) {
          const i = (y * w + x) * 4;
          return [data[i], data[i+1], data[i+2], data[i+3]];
        }
        const half = (size - 1) >> 1;
        let r = 0, g = 0, b = 0, a = 0, cnt = 0;
        const x0 = Math.max(0, x - half);
        const x1 = Math.min(w - 1, x + half);
        const y0 = Math.max(0, y - half);
        const y1 = Math.min(h - 1, y + half);
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const i = (yy * w + xx) * 4;
            r += data[i]; g += data[i+1]; b += data[i+2]; a += data[i+3];
            cnt++;
          }
        }
        if (cnt === 0) return [0,0,0,0];
        return [r/cnt, g/cnt, b/cnt, a/cnt];
      };

      const colorDist = (idx, seed) => {
        const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];
        if (colorSpace === 'luminance') {
          const lum1 = 0.299*r + 0.587*g + 0.114*b;
          const lum2 = 0.299*seed[0] + 0.587*seed[1] + 0.114*seed[2];
          const dl = lum1 - lum2;
          const da = a - seed[3];
          return dl*dl + da*da*0.5;
        }
        // Default RGB.
        const dr = r - seed[0], dg = g - seed[1], db = b - seed[2], da = a - seed[3];
        return dr*dr + dg*dg + db*db + da*da;
      };

      const mask = new Uint8Array(w * h);
      const seed = sampleAvg(startX, startY, sampleSize);
      const tolScale = (tolerance / 255);
      const tolSq = tolScale * tolScale * (4 * 255 * 255);

      if (!this.contiguous) {
        if (useGradient) {
          for (let p = 0, i = 0; p < w * h; p++, i += 4) {
            const d = Math.sqrt(colorDist(i, seed));
            const ratio = d / (tolScale * Math.sqrt(4 * 255 * 255));
            if (ratio < 1) mask[p] = Math.round((1 - ratio) * 255);
          }
        } else {
          for (let p = 0, i = 0; p < w * h; p++, i += 4) {
            if (colorDist(i, seed) <= tolSq) mask[p] = 255;
          }
        }
        return mask;
      }

      const match = (idx) => colorDist(idx, seed) <= tolSq;
      const stack = [[startX, startY]];
      const inStack = new Uint8Array(w * h);
      while (stack.length) {
        const pt = stack.pop();
        const x = pt[0], y = pt[1];
        const idx = y * w + x;
        if (inStack[idx]) continue;
        inStack[idx] = 1;
        let lx = x;
        while (lx > 0 && !inStack[y * w + (lx - 1)] && match((y * w + (lx - 1)) * 4)) {
          lx--; inStack[y * w + lx] = 1;
        }
        let rx = x;
        while (rx < w - 1 && !inStack[y * w + (rx + 1)] && match((y * w + (rx + 1)) * 4)) {
          rx++; inStack[y * w + rx] = 1;
        }
        for (let xi = lx; xi <= rx; xi++) mask[y * w + xi] = 255;
        const rows = [];
        if (y > 0) rows.push(y - 1);
        if (y < h - 1) rows.push(y + 1);
        for (const yi of rows) {
          let inside = false;
          for (let xi = lx; xi <= rx; xi++) {
            const p = yi * w + xi;
            const m = !inStack[p] && match(p * 4);
            if (m && !inside) { stack.push([xi, yi]); inside = true; }
            else if (!m) inside = false;
            if (connected === 8 && xi === lx && lx > 0) {
              const dp = yi * w + (lx - 1);
              if (!inStack[dp] && match(dp * 4)) stack.push([lx - 1, yi]);
            }
            if (connected === 8 && xi === rx && rx < w - 1) {
              const dp = yi * w + (rx + 1);
              if (!inStack[dp] && match(dp * 4)) stack.push([rx + 1, yi]);
            }
          }
        }
      }
      return mask;
    }

    /* ---------- Presets (one-click settings) ---------- */

    applyPreset(name) {
      switch (name) {
        case 'strict':
          // Pixel-perfect hard selection. Best for clean line art.
          this.tolerance = 12;
          this.antiAlias = 0;
          this.sampleSize = 1;
          this.gradient = false;
          this.colorSpace = 'rgb';
          this.contiguous = true;
          this.connected = 4;
          break;
        case 'normal':
          // Balanced default for general use.
          this.tolerance = 32;
          this.antiAlias = 1;
          this.sampleSize = 1;
          this.gradient = false;
          this.colorSpace = 'rgb';
          this.contiguous = true;
          this.connected = 4;
          break;
        case 'loose':
          // Wide tolerance, smooth edges. Good for gradients & photos.
          this.tolerance = 80;
          this.antiAlias = 2;
          this.sampleSize = 3;
          this.gradient = false;
          this.colorSpace = 'rgb';
          this.contiguous = true;
          this.connected = 8;
          break;
        case 'manga-bw':
          // Optimized for black-and-white manga pages: luminance space
          // (ignores color noise from scans), 3x3 sample (anti-halftone),
          // medium tolerance, anti-aliased edges. THE preset for manga.
          this.tolerance = 40;
          this.antiAlias = 1;
          this.sampleSize = 3;
          this.colorSpace = 'luminance';
          this.gradient = false;
          this.contiguous = true;
          this.connected = 8;
          break;
        case 'soft':
          // Gradient falloff — selection strength decreases with color
          // distance. Produces soft, paintable masks for blending fills.
          this.tolerance = 50;
          this.antiAlias = 0;
          this.sampleSize = 1;
          this.colorSpace = 'rgb';
          this.gradient = true;
          this.contiguous = false;
          break;
      }
    }
  }

  MagicWand.SEL_NEW = SEL_NEW;
  MagicWand.SEL_ADD = SEL_ADD;
  MagicWand.SEL_SUBTRACT = SEL_SUBTRACT;
  MagicWand.SEL_INTERSECT = SEL_INTERSECT;

  global.MagicWand = MagicWand;
})(window);
