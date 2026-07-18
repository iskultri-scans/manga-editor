/* =========================================================================
   tools/fill.js — fill current selection with a solid color.

   Spec compliance (Section 4.3):
   - Fill active selection (from Magic Wand or Lasso). If no selection, fills
     the whole image (standard editor behavior).
   - Respects feathered edges (blend fill color proportional to mask strength).
   - Used primarily for filling cleaned bubble backgrounds with white/off-white.
   ========================================================================= */
(function (global) {
  'use strict';

  const U = global.MangaUtils;

  class FillTool {
    constructor(engine, layers, history) {
      this.engine = engine;
      this.layers = layers;
      this.history = history;
    }

    /**
     * Fill active selection with color [r,g,b,a].
     * Records a single history step (rect-snapshot for memory efficiency).
     */
    fill(rgba) {
      if (!this.engine.hasImage()) return;
      const layer = this.layers.getEditLayer();
      const w = this.layers.width;
      const h = this.layers.height;
      const mask = this.layers.getSelection();
      const ctx = layer.ctx;

      // Compute bbox of operation.
      let bbox = { x: 0, y: 0, w: w, h: h };
      if (mask) {
        // Find tight bbox of selected pixels for efficient snapshot.
        bbox = this._maskBBox(mask, w, h) || bbox;
      }

      const [r, g, b, a] = rgba;

      // Snapshot BEFORE for undo (tight bbox, padded by 1 for safety).
      const padX = 1, padY = 1;
      const sb = {
        x: Math.max(0, bbox.x - padX),
        y: Math.max(0, bbox.y - padY),
        w: Math.min(w, bbox.w + padX * 2),
        h: Math.min(h, bbox.h + padY * 2)
      };
      const before = ctx.getImageData(sb.x, sb.y, sb.w, sb.h);

      // Apply fill.
      if (!mask) {
        ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
        ctx.fillRect(0, 0, w, h);
      } else {
        // Per-pixel blend respecting mask strength.
        // getImageData over the bbox, write to it, putImageData back.
        const imgData = ctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
        const data = imgData.data;
        const fw = bbox.w;
        for (let y = 0; y < bbox.h; y++) {
          for (let x = 0; x < fw; x++) {
            const m = mask[(bbox.y + y) * w + (bbox.x + x)];
            if (m === 0) continue;
            const k = m / 255; // selection strength
            const di = (y * fw + x) * 4;
            // Alpha-blend: out = src*a*k + dst*(1-a*k)
            const ak = (a / 255) * k;
            const inv = 1 - ak;
            data[di]     = r * ak + data[di]     * inv;
            data[di + 1] = g * ak + data[di + 1] * inv;
            data[di + 2] = b * ak + data[di + 2] * inv;
            data[di + 3] = Math.max(data[di + 3], a * k);
          }
        }
        ctx.putImageData(imgData, bbox.x, bbox.y);
      }

      // Snapshot AFTER for redo.
      const after = ctx.getImageData(sb.x, sb.y, sb.w, sb.h);

      this.history.push({
        label: 'Fill',
        undo: () => { ctx.putImageData(before, sb.x, sb.y); layer.invalidate(); },
        redo: () => { ctx.putImageData(after, sb.x, sb.y); layer.invalidate(); }
      });

      layer.invalidate();
    }

    /** Bounding box of non-zero mask pixels. Returns null if mask is empty. */
    _maskBBox(mask, w, h) {
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (mask[row + x] > 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null;
      return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }

    /** Eyedropper: sample color from original image at (ix,iy). Returns [r,g,b,a]. */
    pickColor(ix, iy) {
      if (!this.engine.hasImage()) return null;
      const w = this.layers.width, h = this.layers.height;
      ix = Math.floor(U.clamp(ix, 0, w - 1));
      iy = Math.floor(U.clamp(iy, 0, h - 1));
      // Sample from the composited edit layer (so user picks what they see).
      const ctx = this.layers.getEditLayer().ctx;
      // We need the composited result — temporarily draw it on a scratch canvas.
      const scratch = U.makeCanvas(w, h);
      this.layers.composite(scratch.ctx);
      const d = scratch.ctx.getImageData(ix, iy, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    }
  }

  global.FillTool = FillTool;
})(window);
