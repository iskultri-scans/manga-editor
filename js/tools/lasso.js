/* =========================================================================
   tools/lasso.js — freehand & polygon selection.

   Spec compliance (Section 4.5):
   - Freehand lasso: hold and drag to draw a closed path. On release, the path
     is auto-closed (last point connects to first) and converted to a mask.
   - Polygon lasso mode: tap to add vertices; double-tap (or tap first vertex
     to close).
   - Output mask is compatible with Fill/Delete/etc., same as Magic Wand.

   Fixes:
   - Mode switching now clears in-progress state.
   - Polygon mode: tap-and-release (not drag) adds a vertex. Drag moves the
     "rubber band" preview line.
   - Both modes can be re-used in sequence without needing to switch tools.
   - Freehand: paths auto-close; polygon: explicit close.
   ========================================================================= */
(function (global) {
  'use strict';

  const U = global.MangaUtils;

  class LassoTool {
    constructor(engine, layers, history) {
      this.engine = engine;
      this.layers = layers;
      this.history = history;

      this.mode = 'freehand';
      this._drawing = false;
      this._pointerId = null;
      this._polygonPoints = [];
      this._cursorPos = null; // for polygon rubber-band preview
      this._prevSelection = null;

      this._overlayFn = (ctx) => this._drawOverlay(ctx);
    }

    setMode(mode) {
      if (this.mode !== mode) {
        // Clear in-progress state when switching modes.
        this.cancel();
      }
      this.mode = mode;
    }

    onPointerDown(e) {
      if (!this.engine.hasImage()) return;
      if (!U.isPrimaryButton(e)) return;
      const { x, y, sx, sy } = this.engine.eventToImage(e);

      if (this.mode === 'freehand') {
        if (this._drawing) return;
        this._drawing = true;
        this._pointerId = e.pointerId;
        this._polygonPoints = [[x, y]];
        this.engine.setOverlayRenderFn(this._overlayFn);
        this.engine.invalidateOverlay();
      } else {
        // Polygon mode.
        // First tap starts a new polygon.
        if (this._polygonPoints.length === 0) {
          this._polygonPoints = [[x, y]];
          this._cursorPos = { x, y };
          this.engine.setOverlayRenderFn(this._overlayFn);
        } else {
          // Check if tapped near first point to close.
          const first = this._polygonPoints[0];
          const closeThreshold = 14 / this.engine.scale;
          if (U.dist(x, y, first[0], first[1]) < closeThreshold && this._polygonPoints.length >= 3) {
            this._closePolygon();
            return;
          }
          // Ignore taps that are essentially duplicates of the last vertex.
          const last = this._polygonPoints[this._polygonPoints.length - 1];
          if (U.dist(x, y, last[0], last[1]) < 3 / this.engine.scale) return;
          this._polygonPoints.push([x, y]);
        }
        this._cursorPos = { x, y };
        this.engine.invalidateOverlay();
      }
    }

    onPointerMove(e) {
      const { x, y } = this.engine.eventToImage(e);

      if (this.mode === 'freehand') {
        if (!this._drawing || e.pointerId !== this._pointerId) return;
        const pts = this._polygonPoints;
        const last = pts[pts.length - 1];
        // Coalesce: only add if moved more than ~1.5 image pixels.
        if (U.dist(x, y, last[0], last[1]) < 1.5) return;
        pts.push([x, y]);
        this.engine.invalidateOverlay();
      } else {
        // Polygon: update cursor pos for rubber-band preview.
        if (this._polygonPoints.length === 0) return;
        this._cursorPos = { x, y };
        this.engine.invalidateOverlay();
      }
    }

    onPointerUp(e) {
      if (this.mode !== 'freehand') return;
      if (!this._drawing || e.pointerId !== this._pointerId) return;
      this._drawing = false;
      this._pointerId = null;
      if (this._polygonPoints.length >= 3) {
        this._closePolygon();
      } else {
        this._polygonPoints = [];
        this.engine.setOverlayRenderFn(null);
        this.engine.invalidateOverlay();
        U.toast('Path too short');
      }
    }

    onPointerCancel() {
      this._drawing = false;
      this._pointerId = null;
      this._polygonPoints = [];
      this._cursorPos = null;
      this.engine.setOverlayRenderFn(null);
      this.engine.invalidateOverlay();
    }

    onDoubleTap() {
      if (this.mode === 'polygon' && this._polygonPoints.length >= 3) {
        this._closePolygon();
      }
    }

    cancel() {
      this._drawing = false;
      this._pointerId = null;
      this._polygonPoints = [];
      this._cursorPos = null;
      this.engine.setOverlayRenderFn(null);
      this.engine.invalidateOverlay();
    }

    _closePolygon() {
      const w = this.layers.width, h = this.layers.height;
      const mask = global.SelectionOps.fromPolygon(this._polygonPoints, w, h);
      this._polygonPoints = [];
      this._cursorPos = null;
      this.engine.setOverlayRenderFn(null);
      this.layers.setSelection(mask);
      this.engine.invalidateOverlay();
      const prevMask = this._prevSelection;
      this._prevSelection = mask;
      this.history.push({
        label: 'Lasso selection',
        undo: () => {
          if (prevMask) this.layers.setSelection(prevMask.slice(0));
          else this.layers.clearSelection();
        },
        redo: () => { this.layers.setSelection(mask.slice(0)); }
      });
    }

    _drawOverlay(ctx) {
      const pts = this._polygonPoints;
      if (pts.length === 0) return;
      const { offsetX, offsetY, scale } = this.engine;
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      // Subtle selection fill (only when path is closed or being drawn).
      if (pts.length >= 3) {
        ctx.fillStyle = 'rgba(74, 158, 255, 0.08)';
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        if (this.mode === 'polygon' && this._cursorPos) {
          ctx.lineTo(this._cursorPos.x, this._cursorPos.y);
        }
        ctx.closePath();
        ctx.fill();
      }

      // Outline — clean double-stroke (dark + light) for contrast on any bg.
      const drawOutline = (color, width) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width / scale;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
      };

      if (this.mode === 'freehand' && this._drawing) {
        // Solid clean line for in-progress freehand path.
        drawOutline('rgba(0, 0, 0, 0.85)', 2.5);
        drawOutline('rgba(255, 255, 255, 0.95)', 1.25);
      } else if (this.mode === 'polygon') {
        // Solid line through committed vertices.
        drawOutline('rgba(0, 0, 0, 0.85)', 2.5);
        drawOutline('rgba(255, 255, 255, 0.95)', 1.25);

        // Thin rubber-band line from last vertex to cursor (preview).
        if (this._cursorPos && pts.length > 0) {
          const last = pts[pts.length - 1];
          ctx.setLineDash([3 / scale, 3 / scale]);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
          ctx.lineWidth = 1 / scale;
          ctx.beginPath();
          ctx.moveTo(last[0], last[1]);
          ctx.lineTo(this._cursorPos.x, this._cursorPos.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Vertex handles — minimal dots, white fill + dark border.
        for (let i = 0; i < pts.length; i++) {
          const isFirst = i === 0;
          const r = (isFirst ? 4 : 3) / scale;
          // White dot.
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(pts[i][0], pts[i][1], r, 0, Math.PI * 2);
          ctx.fill();
          // Dark border.
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
          ctx.lineWidth = 1 / scale;
          ctx.stroke();

          // Subtle highlight ring on first vertex when ready to close.
          if (isFirst && pts.length >= 3 && this._cursorPos) {
            const d = U.dist(this._cursorPos.x, this._cursorPos.y, pts[0][0], pts[0][1]);
            const threshold = 14 / scale;
            if (d < threshold) {
              ctx.strokeStyle = 'rgba(74, 222, 128, 0.9)';
              ctx.lineWidth = 1.5 / scale;
              ctx.beginPath();
              ctx.arc(pts[0][0], pts[0][1], (r + 4 / scale), 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }
      }

      ctx.restore();
    }
  }

  global.LassoTool = LassoTool;
})(window);
