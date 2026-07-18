/* =========================================================================
   layers.js — layer management + selection mask + marching ants outline.

   v1 layer model (per spec Section 4.8):
   - Original image layer (read-only, baseline)
   - Edit layer (brush strokes, fills, erases)
   - Text layer (vector text objects, kept editable until export)

   Selection mask is owned by this module. When set, the engine draws
   "marching ants" — an animated dashed outline around the selection boundary.
   The outline is computed from the mask as a set of edges (transitions
   between selected and unselected pixels).
   ========================================================================= */
(function (global) {
  'use strict';

  const U = global.MangaUtils;

  class Layer {
    constructor(id, name, w, h, opts = {}) {
      this.id = id;
      this.name = name;
      const made = U.makeCanvas(w, h);
      this.canvas = made.canvas;
      this.ctx = made.ctx;
      this.visible = opts.visible !== false;
      this.opacity = opts.opacity !== undefined ? opts.opacity : 1;
      this.kind = opts.kind || 'edit';
      this._onInvalidate = null;
    }

    invalidate() { if (this._onInvalidate) this._onInvalidate(); }
    onInvalidate(fn) { this._onInvalidate = fn; }
  }

  class LayerStack {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.layers = [];
      this.activeEditLayer = null;
      this.originalLayer = null;
      this.textObjects = [];
      this._onChange = null;

      this.selectionMask = null;
      this.selectionBBox = null;
      // Cached selection boundary path (array of [x1,y1,x2,y2] segments) for
      // drawing marching ants. Recomputed when selection changes.
      this._selectionEdges = null;
    }

    onChange(fn) { this._onChange = fn; }
    _notify() { if (this._onChange) this._onChange(); }

    static create(width, height) {
      const stack = new LayerStack(width, height);
      stack.originalLayer = new Layer('original', 'Original', width, height, { kind: 'image' });
      stack.layers.push(stack.originalLayer);
      stack.activeEditLayer = new Layer('edit', 'Edits', width, height, { kind: 'edit' });
      stack.layers.push(stack.activeEditLayer);
      return stack;
    }

    getEditLayer() { return this.activeEditLayer; }

    setOriginalImage(img) {
      const ctx = this.originalLayer.ctx;
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.drawImage(img, 0, 0);
      this.originalLayer.invalidate();
    }

    composite(ctx) {
      ctx.clearRect(0, 0, this.width, this.height);
      for (const layer of this.layers) {
        if (!layer.visible) continue;
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(layer.canvas, 0, 0);
      }
      ctx.globalAlpha = 1;
      for (const t of this.textObjects) {
        if (t.visible !== false) t.draw(ctx);
      }
    }

    /* ---------- Selection mask ---------- */

    setSelection(mask, bbox) {
      this.selectionMask = mask;
      this.selectionBBox = bbox || (mask ? { x: 0, y: 0, w: this.width, h: this.height } : null);
      this._selectionEdges = null; // invalidate cache
      this._notify();
    }

    clearSelection() {
      this.selectionMask = null;
      this.selectionBBox = null;
      this._selectionEdges = null;
      this._notify();
    }

    hasSelection() { return this.selectionMask !== null; }
    getSelection() { return this.selectionMask; }

    isSelectedAt(x, y) {
      if (!this.selectionMask) return true;
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
      return this.selectionMask[y * this.width + x] > 0;
    }

    selectionStrengthAt(x, y) {
      if (!this.selectionMask) return 255;
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
      return this.selectionMask[y * this.width + x];
    }

    /**
     * Compute selection boundary edges (for marching ants). Returns an array
     * of [x1,y1,x2,y2] line segments in image coords, marking transitions
     * between selected and unselected pixels. Cached.
     *
     * Algorithm: for each pixel that is selected, check its 4 neighbors. For
     * each unselected neighbor (or image boundary), emit an edge segment
     * along that side. This produces a crisp boundary outline.
     */
    getSelectionEdges() {
      if (this._selectionEdges) return this._selectionEdges;
      if (!this.selectionMask) return [];
      const w = this.width, h = this.height;
      const mask = this.selectionMask;
      const edges = [];
      const bbox = this.selectionBBox || { x: 0, y: 0, w, h };
      const x0 = Math.max(0, Math.floor(bbox.x));
      const y0 = Math.max(0, Math.floor(bbox.y));
      const x1 = Math.min(w - 1, Math.ceil(bbox.x + bbox.w));
      const y1 = Math.min(h - 1, Math.ceil(bbox.y + bbox.h));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const sel = mask[y * w + x] > 0;
          if (!sel) continue;
          // Top edge.
          if (y === 0 || mask[(y - 1) * w + x] === 0) edges.push([x, y, x + 1, y]);
          // Bottom edge.
          if (y === h - 1 || mask[(y + 1) * w + x] === 0) edges.push([x, y + 1, x + 1, y + 1]);
          // Left edge.
          if (x === 0 || mask[y * w + (x - 1)] === 0) edges.push([x, y, x, y + 1]);
          // Right edge.
          if (x === w - 1 || mask[y * w + (x + 1)] === 0) edges.push([x + 1, y, x + 1, y + 1]);
        }
      }
      this._selectionEdges = edges;
      return edges;
    }

    /* ---------- Text objects ---------- */

    addTextObject(t) { this.textObjects.push(t); this._notify(); }
    removeTextObject(t) {
      const i = this.textObjects.indexOf(t);
      if (i >= 0) { this.textObjects.splice(i, 1); this._notify(); }
    }
    getTextObjects() { return this.textObjects; }

    hitText(ix, iy) {
      for (let i = this.textObjects.length - 1; i >= 0; i--) {
        const t = this.textObjects[i];
        if (t.contains(ix, iy)) return t;
      }
      return null;
    }
  }

  global.LayerStack = LayerStack;
})(window);
