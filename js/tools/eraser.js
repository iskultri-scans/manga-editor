/* =========================================================================
   tools/eraser.js — eraser.

   Spec compliance (Section 4.4):
   - Reveals transparent (checkerboard) on the edit layer. Since the original
     image lives in its own layer below, erasing the edit layer effectively
     "uncovers" the original — non-destructive.
   - Same stroke smoothing & pressure support as Brush.
   - Respects selection mask.
   - Coalesces a stroke into one undo step.
   ========================================================================= */
(function (global) {
  'use strict';

  const U = global.MangaUtils;

  class EraserTool {
    constructor(engine, layers, history) {
      this.engine = engine;
      this.layers = layers;
      this.history = history;
      this.size = 24;
      this.hardness = 0.8;

      this._stroke = null;
      this._pointerId = null;
    }

    onActivate() { this._updateCursor(); }
    onDeactivate() { this.engine.clearCursor(); }

    _updateCursor() {
      this.engine.setCursor('eraser', this.size / 2, '#ffffff');
    }

    setSize(s) { this.size = s; this._updateCursor(); }
    setHardness(h) { this.hardness = h; }

    onPointerDown(e) {
      if (!this.engine.hasImage() || this._stroke) return;
      if (!U.isPrimaryButton(e)) return;
      const img = this.engine.eventToImage(e);
      const x = img.x, y = img.y;
      const p = (typeof e.pressure === 'number' && e.pressure > 0 && e.pressure < 1)
        ? e.pressure : 1;
      this.engine.clearCursor();
      const w = this.layers.width, h = this.layers.height;
      const made = U.makeCanvas(w, h);
      this._stroke = {
        points: [{ x, y, p }],
        overlay: made.canvas,
        ctx: made.ctx,
        rect: { minX: x, minY: y, maxX: x, maxY: y },
        lastStampX: x,
        lastStampY: y
      };
      this._pointerId = e.pointerId;
      this._stamp(x, y, p);
      this._installOverlay();
      this.engine.invalidateOverlay();
    }

    onPointerMove(e) {
      if (!this._stroke) {
        const img = this.engine.eventToImage(e);
        this.engine.updateCursorPos(img.sx, img.sy);
        return;
      }
      if (e.pointerId !== this._pointerId) return;
      const img = this.engine.eventToImage(e);
      const x = img.x, y = img.y;
      const p = (typeof e.pressure === 'number' && e.pressure > 0 && e.pressure < 1)
        ? e.pressure : 1;
      this._stroke.points.push({ x, y, p });
      const r = this._stroke.rect;
      if (x < r.minX) r.minX = x;
      if (y < r.minY) r.minY = y;
      if (x > r.maxX) r.maxX = x;
      if (y > r.maxY) r.maxY = y;
      this._stampAlongPath();
      this.engine.invalidateOverlay();
    }

    onPointerUp(e) {
      if (!this._stroke) return;
      if (e.pointerId !== this._pointerId) return;
      this._stampAlongPath();
      const stroke = this._stroke;
      this._stroke = null;
      this._pointerId = null;
      this._uninstallOverlay();
      this._commit(stroke);
      this._updateCursor();
      this.engine.invalidateOverlay();
    }

    onPointerCancel() {
      this._stroke = null;
      this._pointerId = null;
      this._uninstallOverlay();
      this._updateCursor();
      this.engine.invalidateOverlay();
    }

    /* ---------- Stamping ---------- */

    _stamp(x, y, pressure) {
      // Eraser stamp: we paint onto the stroke overlay using 'destination-out'
      // so when the overlay is composited onto the edit layer it punches holes.
      // But for live preview we render the overlay with composite 'destination-out'
      // *applied to a copy of the edit layer* — simpler: just paint opaque black
      // circles on the overlay; on commit, use destination-out composite op.
      const ctx = this._stroke.ctx;
      const radius = Math.max(0.5, this.size / 2 * (0.4 + 0.6 * pressure));
      const hardness = this.hardness;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      if (hardness >= 1) {
        grad.addColorStop(1, 'rgba(0,0,0,1)');
      } else {
        const hStop = U.clamp(hardness, 0, 0.99);
        grad.addColorStop(hStop, 'rgba(0,0,0,1)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      this._stroke.lastStampX = x;
      this._stroke.lastStampY = y;
    }

    _stampAlongPath() {
      const pts = this._stroke.points;
      if (pts.length < 2) return;
      const lx = this._stroke.lastStampX;
      const ly = this._stroke.lastStampY;
      const last = pts[pts.length - 1];
      const dist = U.dist(lx, ly, last.x, last.y);
      const step = Math.max(1, this.size / 8);
      if (dist < step) return;
      const n = Math.ceil(dist / step);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const x = lx + (last.x - lx) * t;
        const y = ly + (last.y - ly) * t;
        this._stamp(x, y, last.p);
      }
    }

    _installOverlay() {
      this.engine.setOverlayRenderFn((ctx) => {
        if (!this._stroke) return;
        const { offsetX, offsetY, scale } = this.engine;
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        // For eraser preview, use destination-out so we visually erase during stroke.
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(this._stroke.overlay, 0, 0);
        ctx.restore();
      });
    }

    _uninstallOverlay() {
      this.engine.setOverlayRenderFn(null);
    }

    _commit(stroke) {
      const editLayer = this.layers.getEditLayer();
      const mask = this.layers.getSelection();
      const w = this.layers.width, h = this.layers.height;

      // Process only the stroke's bbox (not full image) for speed.
      const pad = Math.ceil(this.size);
      const bx = Math.max(0, Math.floor(stroke.rect.minX - pad));
      const by = Math.max(0, Math.floor(stroke.rect.minY - pad));
      const bw = Math.min(w - bx, Math.ceil(stroke.rect.maxX - stroke.rect.minX + pad * 2));
      const bh = Math.min(h - by, Math.ceil(stroke.rect.maxY - stroke.rect.minY + pad * 2));
      if (bw <= 0 || bh <= 0) return;

      const before = editLayer.ctx.getImageData(bx, by, bw, bh);

      // Apply stroke as eraser. If selection active, mask the stroke first.
      if (!mask) {
        editLayer.ctx.save();
        editLayer.ctx.globalCompositeOperation = 'destination-out';
        editLayer.ctx.drawImage(stroke.overlay, bx, by, bw, bh, bx, by, bw, bh);
        editLayer.ctx.restore();
      } else {
        // Clip the eraser stroke by mask, operating only on the bbox.
        const tmp = U.makeCanvas(bw, bh);
        tmp.ctx.drawImage(stroke.overlay, bx, by, bw, bh, 0, 0, bw, bh);
        const td = tmp.ctx.getImageData(0, 0, bw, bh);
        const tdata = td.data;
        for (let y = 0; y < bh; y++) {
          const maskRow = (by + y) * w;
          const dataRow = y * bw;
          for (let x = 0; x < bw; x++) {
            const m = mask[maskRow + bx + x] / 255;
            if (m < 1) {
              const di = (dataRow + x) * 4 + 3;
              tdata[di] = Math.round(tdata[di] * m);
            }
          }
        }
        tmp.ctx.putImageData(td, 0, 0);
        editLayer.ctx.save();
        editLayer.ctx.globalCompositeOperation = 'destination-out';
        editLayer.ctx.drawImage(tmp.canvas, bx, by);
        editLayer.ctx.restore();
      }

      const after = editLayer.ctx.getImageData(bx, by, bw, bh);
      this.history.push({
        label: 'Erase',
        undo: () => { editLayer.ctx.putImageData(before, bx, by); editLayer.invalidate(); },
        redo: () => { editLayer.ctx.putImageData(after, bx, by); editLayer.invalidate(); }
      });
      editLayer.invalidate();
    }
  }

  global.EraserTool = EraserTool;
})(window);
