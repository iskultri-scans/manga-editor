/* =========================================================================
   canvas-engine.js — pan/zoom/render, coordinate transforms, overlays.

   Architecture:
   - "Source" = offscreen canvas at full image resolution (the source of truth).
   - "Display" = onscreen canvas, scaled/translated by current view transform.
     Its backing store is at source resolution; CSS transform handles zoom.
   - "Overlay" = same onscreen size as stage, for tool previews (selection
     marching ants, brush cursor, lasso outline, text box handles).
     pointer-events:none.

   The engine owns a continuous RAF render loop ONLY when something needs
   animation (marching ants, busy spinner). Otherwise it renders on demand.
   ========================================================================= */
(function (global) {
  'use strict';

  const U = global.MangaUtils;

  class CanvasEngine {
    constructor(displayCanvas, overlayCanvas, stage) {
      this.display = displayCanvas;
      this.overlay = overlayCanvas;
      this.stage = stage;

      this.source = null;
      this.sourceWidth = 0;
      this.sourceHeight = 0;

      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.minScale = 0.1;
      this.maxScale = 8;

      this.stageW = 0;
      this.stageH = 0;

      this._renderPending = false;
      this._sourceDirty = true;
      this._overlayRenderFn = null;

      // Animation: marching ants offset advances every frame while a selection
      // is active OR a tool requests cursor preview. We run RAF continuously
      // only while _animating is true.
      this._animating = false;
      this._antOffset = 0;
      this._rafId = null;
      this._cursorPos = null; // screen coords for brush cursor preview
      this._cursorRadius = 0; // image-pixel radius
      this._cursorColor = '#ffffff';
      this._cursorKind = null; // 'brush'|'eraser'|null

      // Pinch state.
      this._pinchPrevDist = 0;
      this._pinchPrevMid = null;

      this._resizeHandler = () => this._cacheStageSize();
      window.addEventListener('resize', this._resizeHandler);
      window.addEventListener('orientationchange', this._resizeHandler);
      this._cacheStageSize();
    }

    _cacheStageSize() {
      const r = this.stage.getBoundingClientRect();
      this.stageW = r.width;
      this.stageH = r.height;
      this.overlay.width = this.stageW;
      this.overlay.height = this.stageH;
      this.overlay.style.width = this.stageW + 'px';
      this.overlay.style.height = this.stageH + 'px';
      this.requestRender();
    }

    /* ----------------- Image loading ----------------- */

    setImage(img) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) throw new Error('Invalid image dimensions');

      this.sourceWidth = w;
      this.sourceHeight = h;

      const off = U.makeCanvas(w, h);
      off.ctx.drawImage(img, 0, 0);
      this.source = off;

      this.display.width = w;
      this.display.height = h;
      this.display.style.width = w + 'px';
      this.display.style.height = h + 'px';

      this._sourceDirty = true;
      this.fitToView();
    }

    hasImage() { return this.source !== null; }

    /* ----------------- View transforms ----------------- */

    fitToView() {
      if (!this.hasImage()) return;
      const s = Math.min(
        this.stageW / this.sourceWidth,
        this.stageH / this.sourceHeight,
        1
      );
      this.scale = U.clamp(s, this.minScale, this.maxScale);
      this.offsetX = (this.stageW - this.sourceWidth * this.scale) / 2;
      this.offsetY = (this.stageH - this.sourceHeight * this.scale) / 2;
      this._applyTransform();
      this.requestRender();
    }

    /** Reset zoom to 100% centered. */
    resetView() {
      if (!this.hasImage()) return;
      this.scale = 1;
      this.offsetX = (this.stageW - this.sourceWidth) / 2;
      this.offsetY = (this.stageH - this.sourceHeight) / 2;
      this._applyTransform();
      this.requestRender();
    }

    zoomAt(focalScreenX, focalScreenY, ratio) {
      const newScale = U.clamp(this.scale * ratio, this.minScale, this.maxScale);
      if (newScale === this.scale) return;
      const k = newScale / this.scale;
      this.offsetX = focalScreenX - (focalScreenX - this.offsetX) * k;
      this.offsetY = focalScreenY - (focalScreenY - this.offsetY) * k;
      this.scale = newScale;
      this._applyTransform();
      this.requestRender();
    }

    panBy(dxScreen, dyScreen) {
      this.offsetX += dxScreen;
      this.offsetY += dyScreen;
      this._applyTransform();
      this.requestRender();
    }

    _applyTransform() {
      const t = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`;
      this.display.style.transform = t;
    }

    /* ----------------- Coordinate conversion ----------------- */

    screenToImage(sx, sy) {
      return {
        x: (sx - this.offsetX) / this.scale,
        y: (sy - this.offsetY) / this.scale
      };
    }

    imageToScreen(ix, iy) {
      return {
        x: ix * this.scale + this.offsetX,
        y: iy * this.scale + this.offsetY
      };
    }

    eventToImage(e) {
      const r = this.stage.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      return { x: (sx - this.offsetX) / this.scale, y: (sy - this.offsetY) / this.scale, sx, sy };
    }

    /* ----------------- Render loop ----------------- */

    requestRender() {
      if (this._renderPending) return;
      this._renderPending = true;
      requestAnimationFrame(() => {
        this._renderPending = false;
        this._render();
      });
    }

    _render() {
      if (!this.hasImage()) return;

      if (this._sourceDirty) {
        const ctx = this.display.getContext('2d');
        ctx.clearRect(0, 0, this.sourceWidth, this.sourceHeight);
        if (this._compositeFn) this._compositeFn(ctx);
        this._sourceDirty = false;
      }

      this._renderOverlay();
    }

    setCompositeFn(fn) {
      this._compositeFn = fn;
      this._sourceDirty = true;
      this.requestRender();
    }

    setOverlayRenderFn(fn) {
      this._overlayRenderFn = fn;
      // Start the animation loop if the overlay fn requests continuous redraw.
      this._updateAnimation();
      this.requestRender();
    }

    /** Mark source dirty; repaint on next frame. */
    invalidateSource() {
      this._sourceDirty = true;
      this.requestRender();
    }

    invalidateOverlay() {
      this.requestRender();
    }

    /* ----------------- Brush/eraser cursor preview ----------------- */

    /**
     * Set the brush/eraser cursor preview. Pass null to hide.
     * kind: 'brush' | 'eraser'
     * radius is in IMAGE pixels.
     */
    setCursor(kind, radius, color) {
      this._cursorKind = kind;
      this._cursorRadius = radius;
      this._cursorColor = color || '#ffffff';
      this._updateAnimation();
      this.requestRender();
    }

    /** Update cursor screen position (call on pointer move). */
    updateCursorPos(screenX, screenY) {
      this._cursorPos = { x: screenX, y: screenY };
      if (this._cursorKind) this.requestRender();
    }

    clearCursor() {
      this._cursorKind = null;
      this._updateAnimation();
      this.requestRender();
    }

    /* ----------------- Animation loop ----------------- */

    /**
     * Run a continuous RAF loop while we need animation: marching ants (when
     * a selection is active) or brush cursor (when a brush/eraser is active).
     * Stops when neither is needed to save battery.
     */
    _updateAnimation() {
      const needAnim = this._needsAnimation();
      if (needAnim && !this._animating) {
        this._animating = true;
        this._animLoop();
      } else if (!needAnim && this._animating) {
        this._animating = false;
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
    }

    _needsAnimation() {
      // Marching ants are now static (professional look, no distracting animation),
      // so we only animate when the brush/eraser cursor preview is active.
      return this._cursorKind !== null;
    }

    setMarchingAntsActive(active) {
      this._marchingAntsActive = active;
      // Selection is now a static outline (no marching ants animation).
      // Just trigger one redraw to show/hide the outline.
      this.requestRender();
    }

    _animLoop() {
      if (!this._animating) return;
      this._antOffset = (this._antOffset + 0.5) % 8;
      this._renderOverlay();
      this._rafId = requestAnimationFrame(() => this._animLoop());
    }

    _renderOverlay() {
      const ctx = this.overlay.getContext('2d');
      ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);

      // Tool-specific overlay (lasso outline, text handles, etc.)
      if (this._overlayRenderFn) {
        ctx.save();
        this._overlayRenderFn(ctx);
        ctx.restore();
      }

      // Marching ants for active selection.
      if (this._marchingAntsActive && this._drawAntsFn) {
        ctx.save();
        this._drawAntsFn(ctx, this._antOffset);
        ctx.restore();
      }

      // Brush/eraser cursor preview.
      if (this._cursorKind && this._cursorPos) {
        ctx.save();
        this._drawCursor(ctx);
        ctx.restore();
      }
    }

    _drawCursor(ctx) {
      if (!this._cursorPos) return;
      const { x, y } = this._cursorPos;
      const r = Math.max(2, this._cursorRadius * this.scale);
      ctx.lineWidth = 1.5;
      // Outer ring (dark for visibility on light backgrounds).
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath();
      ctx.arc(x, y, r + 1, 0, Math.PI * 2);
      ctx.stroke();
      // Inner ring (light).
      ctx.strokeStyle = this._cursorKind === 'eraser' ? '#ffffff' : this._cursorColor;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      // Crosshair dot in center.
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    /**
     * Set the marching-ants drawing function. Called by main.js whenever
     * a selection is set. The fn receives (ctx, antOffset).
     */
    setMarchingAntsFn(fn) {
      this._drawAntsFn = fn;
    }

    /* ----------------- Pinch helpers ----------------- */

    pinchInfo(t1, t2) {
      const r = this.stage.getBoundingClientRect();
      const dx = t2.clientX - t1.clientX;
      const dy = t2.clientY - t1.clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const midX = (t1.clientX + t2.clientX) / 2 - r.left;
      const midY = (t1.clientY + t2.clientY) / 2 - r.top;
      return { dist, midX, midY };
    }

    updatePinch(t1, t2) {
      const info = this.pinchInfo(t1, t2);
      if (this._pinchPrevDist > 0 && info.dist > 0) {
        const ratio = info.dist / this._pinchPrevDist;
        const safe = U.clamp(ratio, 0.5, 2.0);
        this.zoomAt(info.midX, info.midY, safe);
        if (this._pinchPrevMid) {
          this.panBy(info.midX - this._pinchPrevMid.x, info.midY - this._pinchPrevMid.y);
        }
      }
      this._pinchPrevDist = info.dist;
      this._pinchPrevMid = { x: info.midX, y: info.midY };
      return info;
    }

    resetPinch() {
      this._pinchPrevDist = 0;
      this._pinchPrevMid = null;
    }

    destroy() {
      this._animating = false;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      window.removeEventListener('resize', this._resizeHandler);
      window.removeEventListener('orientationchange', this._resizeHandler);
    }
  }

  global.CanvasEngine = CanvasEngine;
})(window);
