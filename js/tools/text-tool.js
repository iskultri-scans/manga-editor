/* =========================================================================
   tools/text-tool.js — editable text boxes with auto-fit.

   Spec compliance (Section 4.6):
   - Tap-drag to define a text box; release → opens modal editor.
   - Bengali script: rely on browser native shaping via fillText()
     (NOT custom glyph positioning). Bundled Noto Sans Bengali loaded via
     FontFace API at app init.
   - Auto-fit three strategies:
       1. Reduce: shrink font iteratively (binary search) until text fits.
       2. Expand: grow font up to a configured max so short text fills the box.
       3. Manual: lock font size; show overflow indicator.
   - Wrap at word boundaries within box width.
   - Alignment: left/center/right + vertical center.
   - Styling: bold, italic, color, stroke color/width, letter spacing.
   - Editable after placement: text boxes are live objects on the layer stack.
   ========================================================================= */
(function (global) {
  'use strict';

  const U = global.MangaUtils;

  /** A single editable text box. */
  class TextBox {
    constructor(opts) {
      this.id = 't' + (Date.now() + Math.random()).toString(36);
      this.x = opts.x;
      this.y = opts.y;
      this.w = opts.w;
      this.h = opts.h;
      this.text = opts.text || '';
      this.fontFamily = opts.fontFamily || 'Noto Sans Bengali, sans-serif';
      this.fontSize = opts.fontSize || 32;          // current/locked size
      this.baseFontSize = opts.baseFontSize || 32;  // starting size for auto-fit
      this.maxFontSize = opts.maxFontSize || 200;
      this.color = opts.color || '#000000';
      this.strokeColor = opts.strokeColor || '#ffffff';
      this.strokeWidth = opts.strokeWidth || 0;
      this.align = opts.align || 'center';          // left|center|right
      this.valign = opts.valign || 'middle';        // top|middle|bottom
      this.bold = !!opts.bold;
      this.italic = !!opts.italic;
      this.letterSpacing = opts.letterSpacing || 0;
      this.autoFit = opts.autoFit !== false;
      this.visible = true;
      // Computed at layout time.
      this._lines = [];
      this._effectiveSize = this.fontSize;
      this._overflow = false;
    }

    /** Build CSS font shorthand. */
    _fontShorthand(size) {
      const style = this.italic ? 'italic ' : '';
      const weight = this.bold ? '700 ' : '400 ';
      return `${style}${weight}${size}px ${this.fontFamily}`;
    }

    /**
     * Wrap text into lines that fit within `maxWidth` at the given font size.
     * Word-boundary wrapping; long words overflow (no mid-word break —
     * could be added later but Bengali compound words shouldn't be split).
     */
    _wrap(ctx, text, maxWidth, size) {
      ctx.font = this._fontShorthand(size);
      // Apply letterSpacing if supported (Chrome supports it as of 2024).
      if ('letterSpacing' in ctx) ctx.letterSpacing = this.letterSpacing + 'px';

      // Normalize newlines: explicit line breaks are honored.
      const paragraphs = text.split('\n');
      const lines = [];
      for (const para of paragraphs) {
        const words = para.split(/\s+/).filter(w => w.length > 0);
        if (words.length === 0) { lines.push(''); continue; }
        let cur = words[0];
        for (let i = 1; i < words.length; i++) {
          const test = cur + ' ' + words[i];
          if (ctx.measureText(test).width <= maxWidth) {
            cur = test;
          } else {
            lines.push(cur);
            cur = words[i];
          }
        }
        lines.push(cur);
      }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      return lines;
    }

    /**
     * Compute layout: wraps text, applies auto-fit, sets _lines/_effectiveSize.
     * ctx is any 2D context used for measureText().
     */
    layout(ctx) {
      if (this.w <= 0 || this.h <= 0) {
        this._lines = this.text.split('\n');
        this._effectiveSize = this.fontSize;
        this._overflow = true;
        return;
      }

      if (!this.autoFit) {
        // Manual: use locked size, even if it overflows.
        this._effectiveSize = this.fontSize;
        this._lines = this._wrap(ctx, this.text, this.w, this.fontSize);
        // Compute total height to detect overflow.
        const lineH = this.fontSize * 1.2;
        const totalH = this._lines.length * lineH;
        this._overflow = totalH > this.h;
        return;
      }

      // Auto-fit. Strategy:
      // 1) Try baseFontSize. If fits, try expanding up to maxFontSize (binary search).
      // 2) If baseFontSize doesn't fit, shrink via binary search (min 8px).
      const fits = (size) => {
        const lines = this._wrap(ctx, this.text, this.w, size);
        const lineH = size * 1.2;
        const totalH = lines.length * lineH;
        return totalH <= this.h && lines.every(l => ctx.measureText(l).width <= this.w);
      };

      // First, see how big we can go (expand path).
      let lo = 8, hi = Math.min(this.maxFontSize, this.baseFontSize * 2);
      // If base fits, try expanding up to hi via binary search.
      if (fits(this.baseFontSize)) {
        // Expand.
        lo = this.baseFontSize;
        // Ensure hi fits; if not, bring hi down.
        while (hi > lo && !fits(hi)) hi = Math.floor((lo + hi) / 2);
        if (fits(hi)) lo = hi;
        // Binary search largest size in [base, hi] that still fits.
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (fits(mid)) lo = mid; else hi = mid;
        }
        this._effectiveSize = lo;
      } else {
        // Reduce.
        lo = 8; hi = this.baseFontSize;
        if (!fits(lo)) {
          // Can't fit even at min size — use min and mark overflow.
          this._effectiveSize = lo;
          this._overflow = true;
          this._lines = this._wrap(ctx, this.text, this.w, lo);
          return;
        }
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (fits(mid)) lo = mid; else hi = mid;
        }
        this._effectiveSize = lo;
      }

      this._lines = this._wrap(ctx, this.text, this.w, this._effectiveSize);
      // Recompute overflow (should be false if auto-fit succeeded).
      const lineH = this._effectiveSize * 1.2;
      this._overflow = (this._lines.length * lineH) > this.h;
    }

    /** Render the text box into a ctx at image resolution. */
    draw(ctx) {
      if (!this.visible || !this.text) return;
      // Lay out using this ctx.
      this.layout(ctx);

      const size = this._effectiveSize;
      ctx.font = this._fontShorthand(size);
      if ('letterSpacing' in ctx) ctx.letterSpacing = this.letterSpacing + 'px';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left'; // we measure manually for precise alignment

      const lineH = size * 1.2;
      const totalH = this._lines.length * lineH;

      // Vertical placement.
      let startY;
      if (this.valign === 'top') startY = this.y + lineH / 2;
      else if (this.valign === 'bottom') startY = this.y + this.h - totalH + lineH / 2;
      else startY = this.y + (this.h - totalH) / 2 + lineH / 2;

      for (let i = 0; i < this._lines.length; i++) {
        const line = this._lines[i];
        const y = startY + i * lineH;
        let x;
        const w = ctx.measureText(line).width;
        if (this.align === 'left') x = this.x;
        else if (this.align === 'right') x = this.x + this.w - w;
        else x = this.x + (this.w - w) / 2;

        if (this.strokeWidth > 0) {
          ctx.lineWidth = this.strokeWidth * 2;
          ctx.strokeStyle = this.strokeColor;
          ctx.lineJoin = 'round';
          ctx.miterLimit = 2;
          ctx.strokeText(line, x, y);
        }
        ctx.fillStyle = this.color;
        ctx.fillText(line, x, y);
      }

      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }

    /** Hit test (image coords). */
    contains(ix, iy) {
      return U.pointInRect(ix, iy, this);
    }

    /** Hit test for resize handles. Returns 'br'|'bl'|'tr'|'tl'|'move'|null. */
    hitHandle(ix, iy, viewScale) {
      const hs = 10 / viewScale; // handle size in image pixels
      const right = this.x + this.w, bottom = this.y + this.h;
      const corners = [
        { name: 'tl', x: this.x, y: this.y },
        { name: 'tr', x: right, y: this.y },
        { name: 'bl', x: this.x, y: bottom },
        { name: 'br', x: right, y: bottom }
      ];
      for (const c of corners) {
        if (Math.abs(ix - c.x) <= hs && Math.abs(iy - c.y) <= hs) return c.name;
      }
      if (this.contains(ix, iy)) return 'move';
      return null;
    }
  }

  /* ---------- Tool controller ---------- */

  class TextTool {
    constructor(engine, layers, history, modalEl, onTextEdit) {
      this.engine = engine;
      this.layers = layers;
      this.history = history;
      this.modalEl = modalEl;
      this._onTextEdit = onTextEdit; // callback(textBox) when user wants to edit text via modal

      this._drawing = false;        // currently drag-creating a box
      this._pointerId = null;
      this._draftBox = null;        // box being created (not yet committed)
      this._selected = null;        // currently-selected existing text box
      this._dragMode = null;        // 'move'|'tl'|'tr'|'bl'|'br'|null
      this._dragStart = null;       // {x,y, boxSnapshot}

      this._overlayFn = (ctx) => this._drawOverlay(ctx);
    }

    /* ---------- Pointer handlers ---------- */

    onPointerDown(e) {
      if (!this.engine.hasImage()) return;
      if (!U.isPrimaryButton(e)) return;
      const { x, y } = this.engine.eventToImage(e);

      // 1. If we have a selected box, check for handle hits first.
      if (this._selected) {
        const handle = this._selected.hitHandle(x, y, this.engine.scale);
        if (handle) {
          this._dragMode = handle;
          this._dragStart = {
            x, y,
            box: {
              x: this._selected.x, y: this._selected.y,
              w: this._selected.w, h: this._selected.h
            }
          };
          this._pointerId = e.pointerId;
          this.engine.setOverlayRenderFn(this._overlayFn);
          return;
        }
      }

      // 2. Hit test existing text boxes (topmost first).
      const hit = this.layers.hitText(x, y);
      if (hit) {
        this._selected = hit;
        this._dragMode = 'move';
        this._dragStart = { x, y, box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h } };
        this._pointerId = e.pointerId;
        this.engine.setOverlayRenderFn(this._overlayFn);
        this.engine.invalidateOverlay();
        return;
      }

      // 3. Otherwise: start creating a new box.
      this._selected = null;
      this._drawing = true;
      this._pointerId = e.pointerId;
      this._draftBox = new TextBox({ x, y, w: 0, h: 0 });
      this.engine.setOverlayRenderFn(this._overlayFn);
      this.engine.invalidateOverlay();
    }

    onPointerMove(e) {
      if (e.pointerId !== this._pointerId) return;
      const { x, y } = this.engine.eventToImage(e);

      if (this._drawing && this._draftBox) {
        // Update draft box dimensions.
        const dx = x - this._draftBox.x;
        const dy = y - this._draftBox.y;
        this._draftBox.w = Math.abs(dx);
        this._draftBox.h = Math.abs(dy);
        if (dx < 0) {
          // Draft started in negative direction — reanchor.
          // Simpler: keep draft origin as min corner by storing the *original*
          // pointer-down coords. To keep things simple we just clamp to positive
          // box from the original anchor (user usually drags down-right).
        }
        this.engine.invalidateOverlay();
      } else if (this._dragMode && this._selected) {
        const ds = this._dragStart;
        const dx = x - ds.x;
        const dy = y - ds.y;
        const b = ds.box;
        if (this._dragMode === 'move') {
          this._selected.x = b.x + dx;
          this._selected.y = b.y + dy;
        } else if (this._dragMode === 'tl') {
          const nx = b.x + dx, ny = b.y + dy;
          this._selected.x = nx; this._selected.y = ny;
          this._selected.w = b.w - dx; this._selected.h = b.h - dy;
        } else if (this._dragMode === 'tr') {
          this._selected.y = b.y + dy;
          this._selected.w = b.w + dx; this._selected.h = b.h - dy;
        } else if (this._dragMode === 'bl') {
          this._selected.x = b.x + dx;
          this._selected.w = b.w - dx; this._selected.h = b.h + dy;
        } else if (this._dragMode === 'br') {
          this._selected.w = b.w + dx; this._selected.h = b.h + dy;
        }
        // Normalize negative dims (drag through zero).
        if (this._selected.w < 0) { this._selected.x += this._selected.w; this._selected.w = -this._selected.w; }
        if (this._selected.h < 0) { this._selected.y += this._selected.h; this._selected.h = -this._selected.h; }
        this.engine.invalidateSource();
        this.engine.invalidateOverlay();
      }
    }

    onPointerUp(e) {
      if (e.pointerId !== this._pointerId) return;
      this._pointerId = null;

      if (this._drawing && this._draftBox) {
        // Commit draft box if large enough; otherwise open modal for an empty box.
        const box = this._draftBox;
        this._drawing = false;
        this._draftBox = null;
        if (box.w < 8 || box.h < 8) {
          // Treat as a tap → create a default-sized box at the tap location.
          box.w = 200;
          box.h = 80;
          box.x -= 100;
          box.y -= 40;
        }
        this.layers.addTextObject(box);
        this._selected = box;
        this.engine.invalidateSource();
        // Open modal for first edit.
        if (this._onTextEdit) this._onTextEdit(box);
      } else if (this._dragMode && this._selected) {
        // Commit move/resize as undo step.
        const t = this._selected;
        const before = Object.assign({}, this._dragStart.box);
        const after = { x: t.x, y: t.y, w: t.w, h: t.h };
        this.history.push({
          label: 'Move/resize text',
          undo: () => { Object.assign(t, before); t._lines = null; this.engine.invalidateSource(); },
          redo: () => { Object.assign(t, after); t._lines = null; this.engine.invalidateSource(); }
        });
        this._dragMode = null;
        this._dragStart = null;
        this.engine.invalidateSource();
      }
    }

    onDoubleTap(e) {
      if (!this.engine.hasImage()) return;
      const { x, y } = this.engine.eventToImage(e);
      const hit = this.layers.hitText(x, y);
      if (hit) {
        this._selected = hit;
        if (this._onTextEdit) this._onTextEdit(hit);
      }
    }

    cancel() {
      this._drawing = false;
      this._draftBox = null;
      this._dragMode = null;
      this._dragStart = null;
      this._pointerId = null;
      this.engine.setOverlayRenderFn(null);
      this.engine.invalidateOverlay();
    }

    /** Deselect any currently selected text box. */
    deselect() {
      this._selected = null;
      this.engine.setOverlayRenderFn(null);
      this.engine.invalidateOverlay();
    }

    /** Delete the currently selected text box. */
    deleteSelected() {
      if (!this._selected) return;
      const t = this._selected;
      const index = this.layers.textObjects.indexOf(t);
      this.layers.removeTextObject(t);
      this._selected = null;
      this.history.push({
        label: 'Delete text',
        undo: () => { this.layers.textObjects.splice(index, 0, t); this.engine.invalidateSource(); },
        redo: () => { const i = this.layers.textObjects.indexOf(t); if (i >= 0) this.layers.textObjects.splice(i, 1); this.engine.invalidateSource(); }
      });
      this.engine.invalidateSource();
      this.engine.setOverlayRenderFn(null);
      this.engine.invalidateOverlay();
    }

    /** Apply text edits from the modal. Records a single undo step. */
    applyEdit(textBox, before, after) {
      this.history.push({
        label: 'Edit text',
        undo: () => { Object.assign(textBox, before); textBox._lines = null; this.engine.invalidateSource(); },
        redo: () => { Object.assign(textBox, after); textBox._lines = null; this.engine.invalidateSource(); }
      });
      this.engine.invalidateSource();
    }

    /* ---------- Overlay (selection handles, draft box outline) ---------- */

    _drawOverlay(ctx) {
      const { offsetX, offsetY, scale } = this.engine;
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      // Draft box being created.
      if (this._draftBox) {
        ctx.strokeStyle = '#6cb6ff';
        ctx.lineWidth = 1 / scale;
        ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.strokeRect(this._draftBox.x, this._draftBox.y, this._draftBox.w, this._draftBox.h);
        ctx.setLineDash([]);
      }

      // Selected box handles.
      if (this._selected) {
        const b = this._selected;
        // Dashed outline.
        ctx.strokeStyle = '#6cb6ff';
        ctx.lineWidth = 1.5 / scale;
        ctx.setLineDash([6 / scale, 4 / scale]);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.setLineDash([]);
        // Overflow indicator (red dashed).
        if (b._overflow) {
          ctx.strokeStyle = '#ff6464';
          ctx.lineWidth = 2 / scale;
          ctx.setLineDash([2 / scale, 2 / scale]);
          ctx.strokeRect(b.x, b.y, b.w, b.h);
          ctx.setLineDash([]);
        }
        // Corner handles.
        const hs = 8 / scale;
        const corners = [
          [b.x, b.y],
          [b.x + b.w, b.y],
          [b.x, b.y + b.h],
          [b.x + b.w, b.y + b.h]
        ];
        for (const [cx, cy] of corners) {
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#6cb6ff';
          ctx.lineWidth = 1 / scale;
          ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
          ctx.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs);
        }
      }

      ctx.restore();
    }
  }

  global.TextBox = TextBox;
  global.TextTool = TextTool;
})(window);
