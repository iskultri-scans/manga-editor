/* =========================================================================
   tools/selection.js — selection mask operations.

   Mask format: Uint8Array of length width*height, 0=unselected, 255=selected.
   Soft edges use intermediate values (after feather).

   Operations:
   - invert(mask): swap selected/unselected
   - dilate(mask, radius): expand selection by `radius` pixels
   - erode(mask, radius): contract selection by `radius` pixels
   - feather(mask, radius): gaussian-ish blur on the mask boundary
   - fromPolygon(polygon, w, h): build a mask from a closed polygon

   These operate on full masks (no fancy tiling). On a 2000x3000 image the
   mask is 6MB which is fine to allocate; dilation/erosion is O(n*radius) which
   for radius=10 on 6MB is ~60M ops — sub-100ms on a mid-range phone.
   ========================================================================= */
(function (global) {
  'use strict';

  const Selection = {};

  /** Invert a mask in place (and return it). */
  Selection.invert = function (mask) {
    for (let i = 0; i < mask.length; i++) {
      mask[i] = mask[i] === 0 ? 255 : 0;
    }
    return mask;
  };

  /**
   * Dilate (expand) selection by `radius` pixels. Box-filter approximation:
   * cheap and visually similar to a circular dilation for small radii.
   * Returns a new mask; caller may pass it back in to chain.
   */
  Selection.dilate = function (mask, w, h, radius) {
    if (radius <= 0) return mask;
    const out = new Uint8Array(mask.length);
    // Horizontal pass: for each pixel, look `radius` left and right.
    const tmp = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let m = 0;
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(w - 1, x + radius);
        for (let xi = x0; xi <= x1; xi++) {
          if (mask[row + xi] > 0) { m = 255; break; }
        }
        tmp[row + x] = m;
      }
    }
    // Vertical pass on tmp.
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let m = 0;
        const y0 = Math.max(0, y - radius);
        const y1 = Math.min(h - 1, y + radius);
        for (let yi = y0; yi <= y1; yi++) {
          if (tmp[yi * w + x] > 0) { m = 255; break; }
        }
        out[y * w + x] = m;
      }
    }
    return out;
  };

  /**
   * Erode (contract) selection by `radius` pixels. Same box-filter approach
   * but AND instead of OR.
   */
  Selection.erode = function (mask, w, h, radius) {
    if (radius <= 0) return mask;
    const out = new Uint8Array(mask.length);
    const tmp = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let m = 255;
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(w - 1, x + radius);
        for (let xi = x0; xi <= x1; xi++) {
          if (mask[row + xi] === 0) { m = 0; break; }
        }
        tmp[row + x] = m;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let m = 255;
        const y0 = Math.max(0, y - radius);
        const y1 = Math.min(h - 1, y + radius);
        for (let yi = y0; yi <= y1; yi++) {
          if (tmp[yi * w + x] === 0) { m = 0; break; }
        }
        out[y * w + x] = m;
      }
    }
    return out;
  };

  /**
   * Feather selection edges using a separable box blur. radius=1 gives a
   * 1-pixel soft edge; radius=3 gives a few pixels. Preserves total mass
   * reasonably. Returns a new Uint8Array with values in [0,255].
   */
  Selection.feather = function (mask, w, h, radius) {
    if (radius <= 0) return mask;
    // Convert mask to float [0,1] for accurate averaging.
    const f = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) f[i] = mask[i] / 255;

    // Horizontal box blur (3 passes approximates Gaussian).
    let tmp = new Float32Array(mask.length);
    let src = f;
    const passes = 2;
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          let sum = 0, cnt = 0;
          const x0 = Math.max(0, x - radius);
          const x1 = Math.min(w - 1, x + radius);
          for (let xi = x0; xi <= x1; xi++) { sum += src[row + xi]; cnt++; }
          tmp[row + x] = sum / cnt;
        }
      }
      // Swap.
      const t = src; src = tmp; tmp = t;
    }
    // Vertical box blur, 2 passes.
    for (let p = 0; p < passes; p++) {
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          let sum = 0, cnt = 0;
          const y0 = Math.max(0, y - radius);
          const y1 = Math.min(h - 1, y + radius);
          for (let yi = y0; yi <= y1; yi++) { sum += src[yi * w + x]; cnt++; }
          tmp[y * w + x] = sum / cnt;
        }
      }
      const t = src; src = tmp; tmp = t;
    }

    // `src` now has the blurred result (after even number of swaps).
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) out[i] = Math.round(src[i] * 255);
    return out;
  };

  /**
   * Build a mask from a closed polygon. Polygon = [[x,y],...].
   * Uses scanline fill — for each row, find x-intersections of polygon edges
   * and fill spans between odd/even intersections.
   */
  Selection.fromPolygon = function (polygon, w, h) {
    const mask = new Uint8Array(w * h);
    if (polygon.length < 3) return mask;
    const bbox = global.MangaUtils.polygonBBox(polygon);
    const minY = Math.max(0, Math.floor(bbox.y));
    const maxY = Math.min(h - 1, Math.ceil(bbox.y + bbox.h));
    const n = polygon.length;
    for (let y = minY; y <= maxY; y++) {
      const yc = y + 0.5; // sample mid-row to avoid edge integer alignment issues
      const xs = [];
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i][0], yi = polygon[i][1];
        const xj = polygon[j][0], yj = polygon[j][1];
        if ((yi > yc) !== (yj > yc)) {
          const t = (yc - yi) / (yj - yi);
          xs.push(xi + t * (xj - xi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
        const x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
        const row = y * w;
        for (let x = x0; x <= x1; x++) mask[row + x] = 255;
      }
    }
    return mask;
  };

  /** Create an empty mask. */
  Selection.empty = function (w, h) { return new Uint8Array(w * h); };

  /** Create a fully-selected mask. */
  Selection.full = function (w, h) {
    const m = new Uint8Array(w * h);
    m.fill(255);
    return m;
  };

  global.SelectionOps = Selection;
})(window);
