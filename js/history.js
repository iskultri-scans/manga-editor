/* =========================================================================
   history.js — undo/redo stack.

   Strategy:
   - Each "step" is a self-contained action descriptor with `undo()` and `redo()`
     closures. This avoids the memory cost of storing full ImageData snapshots
     at every step (a 2000x3000x4 = 24MB ImageData × 50 steps = 1.2GB!).
   - For per-stroke/per-fill operations we snapshot the affected *layer canvas*
     region (or full layer canvas if simpler). Brush strokes are coalesced into
     a single step by the brush tool — it calls beginStroke() on pointer-down
     and commitStroke() on pointer-up.
   - Limit: 50 entries. Older entries are dropped (FIFO).
   ========================================================================= */
(function (global) {
  'use strict';

  const MAX_HISTORY = 50;

  class History {
    constructor() {
      this.undoStack = [];
      this.redoStack = [];
      this._onChange = null;
    }

    onChange(fn) { this._onChange = fn; }
    _notify() { if (this._onChange) this._onChange(this.canUndo(), this.canRedo()); }

    /** Push a step {label, undo, redo}. Clears redo stack. */
    push(step) {
      if (!step || typeof step.undo !== 'function' || typeof step.redo !== 'function') {
        throw new Error('History step must have undo() and redo() functions');
      }
      this.undoStack.push(step);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      this._notify();
    }

    undo() {
      if (!this.undoStack.length) return false;
      const step = this.undoStack.pop();
      try {
        step.undo();
      } catch (e) {
        console.error('Undo failed:', e);
        // Push back so user can retry / inspect.
        this.undoStack.push(step);
        return false;
      }
      this.redoStack.push(step);
      this._notify();
      return true;
    }

    redo() {
      if (!this.redoStack.length) return false;
      const step = this.redoStack.pop();
      try {
        step.redo();
      } catch (e) {
        console.error('Redo failed:', e);
        this.redoStack.push(step);
        return false;
      }
      this.undoStack.push(step);
      this._notify();
      return true;
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    /** Wipe everything (e.g. on new image load). */
    clear() {
      this.undoStack = [];
      this.redoStack = [];
      this._notify();
    }

    /* ---------- Convenience builders for common operation types ---------- */

    /**
     * Snapshot a canvas's full contents, returning a step that swaps the
     * current canvas state with the snapshot. Use for operations like fills
     * that affect an arbitrary region.
     */
    snapshotStep(label, layer, onApply) {
      const w = layer.canvas.width;
      const h = layer.canvas.height;
      const before = layer.ctx.getImageData(0, 0, w, h);
      // Apply the operation now.
      if (onApply) onApply();
      const after = layer.ctx.getImageData(0, 0, w, h);
      return {
        label,
        undo: () => { layer.ctx.putImageData(before, 0, 0); layer.invalidate(); },
        redo: () => { layer.ctx.putImageData(after, 0, 0); layer.invalidate(); }
      };
    }

    /**
     * Snapshot a sub-rect of a canvas (for brush strokes — only the bounding
     * box of the stroke needs to be saved).
     */
    rectSnapshotStep(label, layer, rect, onApply) {
      const w = layer.canvas.width;
      const h = layer.canvas.height;
      // Clamp rect to canvas.
      const x = Math.max(0, Math.floor(rect.x));
      const y = Math.max(0, Math.floor(rect.y));
      const rw = Math.min(w - x, Math.ceil(rect.w));
      const rh = Math.min(h - y, Math.ceil(rect.h));
      if (rw <= 0 || rh <= 0) {
        if (onApply) onApply();
        return null;
      }
      const before = layer.ctx.getImageData(x, y, rw, rh);
      if (onApply) onApply();
      const after = layer.ctx.getImageData(x, y, rw, rh);
      return {
        label,
        undo: () => { layer.ctx.putImageData(before, x, y); layer.invalidate(); },
        redo: () => { layer.ctx.putImageData(after, x, y); layer.invalidate(); }
      };
    }
  }

  global.History = History;
})(window);
