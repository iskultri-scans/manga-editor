/* =========================================================================
   main.js — app init, state management, event wiring, tool dispatch.

   This module owns:
   - The singleton instances of engine, layers, history, and each tool.
   - Tool switching (one active tool at a time; others receive no events).
   - Pointer event routing: pan/zoom (multi-touch) vs. active tool (single touch).
     Crucial: palm-rejection logic prevents accidental pan/zoom during a stroke.
   - UI: options sheet population, undo/redo button states, file open, export.
   - Font loading (Noto Sans Bengali) via FontFace API.
   ========================================================================= */
(function (global) {
  'use strict';

  const U = global.MangaUtils;

  /* ---------- App state ---------- */
  const App = {
    engine: null,
    layers: null,
    history: null,
    tools: {},
    activeTool: 'pan',
    optionsSheet: null,
    _pointerSession: null, // tracks active pointer id for tools
    _activePointers: new Map(), // pointerId → {x,y} for pan/zoom
    _panLast: null,
    _showOriginal: false,
  };

  /* ---------- Tool settings (shared with options sheet) ---------- */
  const Settings = {
    wand: { tolerance: 40 },  // single smart-default tolerance
    brush: { size: 24, hardness: 0.8, color: '#000000', opacity: 1 },
    eraser: { size: 24, hardness: 0.8 },
    fill: { color: '#ffffff', opacity: 100 },
    text: {
      fontFamily: 'Noto Sans Bengali, sans-serif',
      baseFontSize: 32,
      maxFontSize: 200,
      color: '#000000',
      strokeColor: '#ffffff',
      strokeWidth: 0,
      align: 'center',
      bold: false,
      italic: false,
      letterSpacing: 0,
      autoFit: true,
    },
    lasso: { mode: 'freehand' }
  };

  /* ---------- Init ---------- */
  function init() {
    const display = document.getElementById('display-canvas');
    const overlay = document.getElementById('overlay-canvas');
    const stage = document.getElementById('stage');

    App.engine = new global.CanvasEngine(display, overlay, stage);
    App.history = new global.History();
    App.history.onChange((canUndo, canRedo) => updateHistoryButtons(canUndo, canRedo));

    // Layers created on image load.
    // Tools created lazily after first image load.

    // Wire UI events.
    wireAppBar();
    wireToolBar();
    wireCanvas();
    wireFileInput();
    wireKeyboard();
    wireOrientation();
    loadFonts();

    // Hide empty state initially visible (CSS-controlled).
    // Status pill shows initial zoom once image loads.

    // Active tool defaults to 'pan'.
    setActiveTool('pan');
  }

  /* ---------- Font loading ---------- */
  function loadFonts() {
    // Load bundled Bengali font via FontFace API so it's available to
    // ctx.fillText() without depending on Google Fonts CDN at runtime.
    const faces = [
      { family: 'Noto Sans Bengali', weight: '400', url: 'assets/fonts/NotoSansBengali-Regular.ttf' },
      { family: 'Noto Sans Bengali', weight: '700', url: 'assets/fonts/NotoSansBengali-Bold.ttf' }
    ];
    for (const f of faces) {
      try {
        const face = new FontFace(f.family, `url(${f.url})`, { weight: f.weight });
        face.load().then(() => {
          document.fonts.add(face);
        }).catch(err => {
          console.warn(`Font load failed for ${f.url}:`, err.message);
        });
      } catch (err) {
        console.warn('FontFace API error:', err);
      }
    }
  }

  /* ---------- File input ---------- */
  function wireFileInput() {
    const input = document.getElementById('file-input');
    const btnOpen = document.getElementById('btn-open');
    const btnOpenHero = document.getElementById('btn-open-hero');

    if (btnOpen) btnOpen.addEventListener('click', () => input.click());
    if (btnOpenHero) btnOpenHero.addEventListener('click', () => input.click());

    input.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) loadImageFile(file);
      input.value = ''; // allow re-picking same file
    });

    // Drag-and-drop on stage.
    const stage = document.getElementById('stage');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); });
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) loadImageFile(file);
    });
  }

  function loadImageFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      onImageLoaded(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      U.toast('Could not load image');
    };
    img.src = url;
  }

  function onImageLoaded(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) { U.toast('Invalid image'); return; }

    // Create fresh layer stack.
    App.layers = global.LayerStack.create(w, h);
    App.layers.setOriginalImage(img);
    App.layers.originalLayer.onInvalidate(() => App.engine.invalidateSource());
    App.layers.getEditLayer().onInvalidate(() => App.engine.invalidateSource());
    App.layers.onChange(() => {
      App.engine.invalidateSource();
      // Update marching ants based on selection state.
      updateMarchingAnts();
    });

    // Tell engine about the new image.
    App.engine.setImage(img);
    // Hook composite function so engine paints our layer stack.
    App.engine.setCompositeFn((ctx) => {
      if (App._showOriginal) {
        ctx.drawImage(App.layers.originalLayer.canvas, 0, 0);
        return;
      }
      App.layers.composite(ctx);
    });

    // Set up marching ants drawing function once.
    App.engine.setMarchingAntsFn((ctx, offset) => drawMarchingAnts(ctx, offset));

    // (Re)init tools.
    initTools();

    // Hide empty state.
    const es = document.getElementById('empty-state');
    if (es) es.classList.add('hidden');

    // Reset history.
    App.history.clear();

    // Update status pill with zoom.
    updateStatusPill();
    updateToolPill(App.activeTool);

    U.toast('Image loaded (' + w + '×' + h + ')');
  }

  /** Draw professional selection overlay — clean static outline + subtle fill.
   *  No childish marching ants. Inspired by Figma / Photoshop's static mode. */
  function drawMarchingAnts(ctx, offset) {
    if (!App.layers || !App.layers.hasSelection()) return;
    const edges = App.layers.getSelectionEdges();
    if (!edges || edges.length === 0) return;
    const { offsetX, offsetY, scale } = App.engine;
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Subtle selection fill — barely visible blue tint to show what's selected
    // without obscuring the underlying pixels.
    // (We can't cheaply fill the mask region; instead, the marching-ants edges
    // already convey the boundary. Skip the fill for performance and clarity.)

    // Outer dark stroke (for contrast against light backgrounds).
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([]);
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    for (const e of edges) {
      ctx.moveTo(e[0], e[1]);
      ctx.lineTo(e[2], e[3]);
    }
    ctx.stroke();

    // Inner light stroke (for contrast against dark backgrounds).
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 0.75 / scale;
    ctx.beginPath();
    for (const e of edges) {
      ctx.moveTo(e[0], e[1]);
      ctx.lineTo(e[2], e[3]);
    }
    ctx.stroke();

    ctx.restore();
  }

  /** Enable/disable marching ants based on whether a selection is active. */
  function updateMarchingAnts() {
    if (!App.engine || !App.layers) return;
    App.engine.setMarchingAntsActive(App.layers.hasSelection());
  }

  function initTools() {
    const E = App.engine, L = App.layers, H = App.history;
    App.tools.wand = new global.MagicWand(E, L, H);
    App.tools.wand.init();
    App.tools.brush = new global.BrushTool(E, L, H);
    App.tools.eraser = new global.EraserTool(E, L, H);
    App.tools.fill = new global.FillTool(E, L, H);
    App.tools.lasso = new global.LassoTool(E, L, H);
    App.tools.text = new global.TextTool(E, L, H, document.getElementById('text-modal'), (tb) => openTextModal(tb));
  }

  /* ---------- App bar (top) ---------- */
  function wireAppBar() {
    document.getElementById('btn-undo').addEventListener('click', () => App.history.undo());
    document.getElementById('btn-redo').addEventListener('click', () => App.history.redo());
    document.getElementById('btn-export').addEventListener('click', exportPNG);
    document.getElementById('btn-toggle-original').addEventListener('click', toggleOriginal);
  }

  function updateHistoryButtons(canUndo, canRedo) {
    document.getElementById('btn-undo').disabled = !canUndo;
    document.getElementById('btn-redo').disabled = !canRedo;
  }

  function toggleOriginal() {
    if (!App.layers) return;
    App._showOriginal = !App._showOriginal;
    App.engine.invalidateSource();
    U.toast(App._showOriginal ? 'Showing original' : 'Showing edits');
  }

  /* ---------- Tool bar (bottom) ---------- */
  function wireToolBar() {
    const buttons = document.querySelectorAll('.tool-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.getAttribute('data-tool');
        setActiveTool(tool);
      });
    });

    // Grip to collapse/expand options sheet.
    const grip = document.getElementById('sheet-grip');
    if (grip) {
      grip.addEventListener('click', () => {
        const sheet = document.getElementById('options-sheet');
        sheet.classList.toggle('hidden');
      });
    }
  }

  function setActiveTool(name) {
    // If no image loaded yet, route everything except pan to a no-op with a toast.
    if (!App.layers && name !== 'pan') {
      U.toast('Open an image first');
      name = 'pan';
    }
    // Deactivate previous tool (cleanup cursors, overlays).
    const prev = App.activeTool;
    if (prev !== name && App.tools) {
      if (App.tools.brush && prev === 'brush') App.tools.brush.onDeactivate();
      if (App.tools.eraser && prev === 'eraser') App.tools.eraser.onDeactivate();
      // Lasso and text already have cancel() — call it.
      if (App.tools.lasso && prev === 'lasso') App.tools.lasso.cancel();
      if (App.tools.text && prev === 'text') App.tools.text.cancel();
    }
    // Cancel any in-progress state on the *previous* tool before switching.
    cancelActiveToolState();

    App.activeTool = name;
    // Update button states.
    document.querySelectorAll('.tool-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-tool') === name);
    });

    // Update the tool-name pill at top-left of stage.
    updateToolPill(name);

    // Activate new tool.
    if (App.tools) {
      if (App.tools.brush && name === 'brush') App.tools.brush.onActivate();
      if (App.tools.eraser && name === 'eraser') App.tools.eraser.onActivate();
    }

    // Show/hide options sheet.
    renderOptionsSheet(name);
  }

  /** Show the active tool name in a small pill at top-left of the stage. */
  function updateToolPill(toolName) {
    let pill = document.getElementById('tool-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'tool-pill';
      pill.className = 'tool-pill';
      document.getElementById('stage').appendChild(pill);
    }
    const labels = {
      pan: 'Pan', wand: 'Magic Wand', lasso: 'Lasso', brush: 'Brush',
      eraser: 'Eraser', fill: 'Fill', eyedropper: 'Eyedropper', text: 'Text'
    };
    pill.textContent = labels[toolName] || toolName;
    if (toolName === 'pan') pill.classList.add('hidden');
    else pill.classList.remove('hidden');
  }

  /** Cancel any in-progress operation on the currently active tool. */
  function cancelActiveToolState() {
    if (!App.tools) return;
    if (App.tools.brush) App.tools.brush.onPointerCancel({});
    if (App.tools.eraser) App.tools.eraser.onPointerCancel({});
    if (App.tools.lasso) App.tools.lasso.cancel();
    if (App.tools.text) App.tools.text.cancel();
    // Reset pointer session so a dangling pointer-up doesn't route to a
    // now-inactive tool.
    App._pointerSession = null;
  }

  /* ---------- Options sheet (per-tool UI) ---------- */
  function renderOptionsSheet(tool) {
    const sheet = document.getElementById('options-sheet');
    const content = document.getElementById('sheet-content');
    content.innerHTML = '';

    const addRow = (html) => {
      const div = document.createElement('div');
      div.className = 'sheet-row';
      div.innerHTML = html;
      content.appendChild(div);
      return div;
    };

    if (tool === 'pan') {
      // Pan tool gets a small nav panel: fit, 100%, zoom slider.
      addRow(`<label>Zoom</label>
        <input type="range" min="10" max="800" step="5" value="${(App.engine.scale * 100) | 0}" id="opt-zoom">
        <span class="value-pill" id="opt-zoom-val">${(App.engine.scale * 100) | 0}%</span>`);
      addRow(`<div class="sheet-actions" style="width:100%">
        <button id="opt-pan-fit">Fit to view</button>
        <button id="opt-pan-100">100%</button>
        <button id="opt-pan-200">200%</button>
      </div>`);
      const zoomEl = content.querySelector('#opt-zoom');
      const zoomVal = content.querySelector('#opt-zoom-val');
      zoomEl.addEventListener('input', (e) => {
        const targetScale = +e.target.value / 100;
        // Zoom around stage center.
        const cx = App.engine.stageW / 2, cy = App.engine.stageH / 2;
        const ratio = targetScale / App.engine.scale;
        App.engine.zoomAt(cx, cy, ratio);
        zoomVal.textContent = e.target.value + '%';
      });
      content.querySelector('#opt-pan-fit').addEventListener('click', () => {
        App.engine.fitToView();
        zoomEl.value = (App.engine.scale * 100) | 0;
        zoomVal.textContent = ((App.engine.scale * 100) | 0) + '%';
        updateStatusPill();
      });
      content.querySelector('#opt-pan-100').addEventListener('click', () => {
        App.engine.resetView();
        zoomEl.value = (App.engine.scale * 100) | 0;
        zoomVal.textContent = ((App.engine.scale * 100) | 0) + '%';
        updateStatusPill();
      });
      content.querySelector('#opt-pan-200').addEventListener('click', () => {
        const cx = App.engine.stageW / 2, cy = App.engine.stageH / 2;
        const ratio = 2 / App.engine.scale;
        App.engine.zoomAt(cx, cy, ratio);
        zoomEl.value = (App.engine.scale * 100) | 0;
        zoomVal.textContent = ((App.engine.scale * 100) | 0) + '%';
        updateStatusPill();
      });
      sheet.classList.remove('hidden');
      return;
    }

    if (tool === 'wand') {
      // Minimal — just tolerance slider + selection ops.
      // Smart defaults: anti-alias on, luminance for B/W manga friendliness,
      // 3x3 sample for noise tolerance. Tap = select. That's it.
      addRow(`<label>Tolerance</label>
        <input type="range" min="0" max="120" step="1" value="${Settings.wand.tolerance}" id="opt-tolerance">
        <span class="value-pill" id="opt-tolerance-val">${Settings.wand.tolerance}</span>`);
      addRow(`<div class="sheet-actions" style="width:100%">
        <button id="opt-wand-invert">Invert</button>
        <button id="opt-wand-expand">Expand</button>
        <button id="opt-wand-contract">Contract</button>
        <button id="opt-wand-feather">Feather</button>
        <button class="danger" id="opt-wand-clear">Clear</button>
      </div>`);

      // Force smart defaults on the tool whenever the sheet opens.
      if (App.tools.wand) {
        App.tools.wand.tolerance = Settings.wand.tolerance;
        App.tools.wand.contiguous = true;
        App.tools.wand.connected = 8;
        App.tools.wand.colorSpace = 'luminance';
        App.tools.wand.sampleSize = 3;
        App.tools.wand.sampleSource = 'original';
        App.tools.wand.antiAlias = 1;
        App.tools.wand.gradient = false;
        App.tools.wand.combineMode = 'new';
      }

      content.querySelector('#opt-tolerance').addEventListener('input', (e) => {
        Settings.wand.tolerance = +e.target.value;
        if (App.tools.wand) App.tools.wand.tolerance = Settings.wand.tolerance;
        content.querySelector('#opt-tolerance-val').textContent = e.target.value;
      });
      content.querySelector('#opt-wand-invert').addEventListener('click', invertSelection);
      content.querySelector('#opt-wand-expand').addEventListener('click', () => expandContract(3));
      content.querySelector('#opt-wand-contract').addEventListener('click', () => expandContract(-3));
      content.querySelector('#opt-wand-feather').addEventListener('click', featherSelection);
      content.querySelector('#opt-wand-clear').addEventListener('click', () => {
        App.layers.clearSelection();
        App.engine.invalidateOverlay();
      });
    }

    else if (tool === 'lasso') {
      addRow(`<label>Mode</label>
        <div class="seg-group">
          <button class="seg-btn ${Settings.lasso.mode === 'freehand' ? 'active' : ''}" data-mode="freehand">Freehand</button>
          <button class="seg-btn ${Settings.lasso.mode === 'polygon' ? 'active' : ''}" data-mode="polygon">Polygon</button>
        </div>`);
      addRow(`<div class="sheet-actions" style="width:100%">
        <button id="opt-lasso-invert">Invert</button>
        <button id="opt-lasso-feather">Feather</button>
        <button class="danger" id="opt-lasso-clear">Clear</button>
      </div>`);
      content.querySelectorAll('[data-mode]').forEach(b => {
        b.addEventListener('click', () => {
          Settings.lasso.mode = b.getAttribute('data-mode');
          content.querySelectorAll('[data-mode]').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          if (App.tools.lasso) App.tools.lasso.setMode(Settings.lasso.mode);
        });
      });
      content.querySelector('#opt-lasso-invert').addEventListener('click', invertSelection);
      content.querySelector('#opt-lasso-feather').addEventListener('click', featherSelection);
      content.querySelector('#opt-lasso-clear').addEventListener('click', () => {
        App.layers.clearSelection();
        App.engine.invalidateOverlay();
      });
    }

    else if (tool === 'brush') {
      addRow(`<label>Size</label>
        <input type="range" min="2" max="200" step="1" value="${Settings.brush.size}" id="opt-size">
        <span class="value-pill" id="opt-size-val">${Settings.brush.size}</span>`);
      addRow(`<label>Hardness</label>
        <input type="range" min="0" max="1" step="0.05" value="${Settings.brush.hardness}" id="opt-hardness">
        <span class="value-pill" id="opt-hardness-val">${(Settings.brush.hardness * 100) | 0}%</span>`);
      addRow(`<label>Color</label>
        <input type="color" value="${Settings.brush.color}" id="opt-color">
        <span class="value-pill"></span>`);
      content.querySelector('#opt-size').addEventListener('input', (e) => {
        Settings.brush.size = +e.target.value;
        App.tools.brush.setSize(Settings.brush.size);
        content.querySelector('#opt-size-val').textContent = e.target.value;
      });
      content.querySelector('#opt-hardness').addEventListener('input', (e) => {
        Settings.brush.hardness = +e.target.value;
        App.tools.brush.setHardness(Settings.brush.hardness);
        content.querySelector('#opt-hardness-val').textContent = (e.target.value * 100) | 0 + '%';
      });
      content.querySelector('#opt-color').addEventListener('input', (e) => {
        Settings.brush.color = e.target.value;
        const c = U.parseColor(e.target.value);
        if (c) App.tools.brush.setColor(c);
      });
      // Initialize tool values.
      App.tools.brush.setSize(Settings.brush.size);
      App.tools.brush.setHardness(Settings.brush.hardness);
      const c = U.parseColor(Settings.brush.color);
      if (c) App.tools.brush.setColor(c);
    }

    else if (tool === 'eraser') {
      addRow(`<label>Size</label>
        <input type="range" min="2" max="200" step="1" value="${Settings.eraser.size}" id="opt-size">
        <span class="value-pill" id="opt-size-val">${Settings.eraser.size}</span>`);
      addRow(`<label>Hardness</label>
        <input type="range" min="0" max="1" step="0.05" value="${Settings.eraser.hardness}" id="opt-hardness">
        <span class="value-pill" id="opt-hardness-val">${(Settings.eraser.hardness * 100) | 0}%</span>`);
      content.querySelector('#opt-size').addEventListener('input', (e) => {
        Settings.eraser.size = +e.target.value;
        App.tools.eraser.setSize(Settings.eraser.size);
        content.querySelector('#opt-size-val').textContent = e.target.value;
      });
      content.querySelector('#opt-hardness').addEventListener('input', (e) => {
        Settings.eraser.hardness = +e.target.value;
        App.tools.eraser.setHardness(Settings.eraser.hardness);
        content.querySelector('#opt-hardness-val').textContent = (e.target.value * 100) | 0 + '%';
      });
      App.tools.eraser.setSize(Settings.eraser.size);
      App.tools.eraser.setHardness(Settings.eraser.hardness);
    }

    else if (tool === 'fill') {
      addRow(`<label>Color</label>
        <input type="color" value="${Settings.fill.color}" id="opt-color">
        <span class="value-pill"></span>`);
      addRow(`<label>Opacity</label>
        <input type="range" min="0" max="100" step="1" value="${Settings.fill.opacity !== undefined ? Settings.fill.opacity : 100}" id="opt-fill-opacity">
        <span class="value-pill" id="opt-fill-opacity-val">${Settings.fill.opacity !== undefined ? Settings.fill.opacity : 100}%</span>`);
      addRow(`<div style="flex:1; font-size:11px; color:var(--text-3); padding:6px 0;">Tap on the canvas to fill, or use the button below.</div>`);
      addRow(`<div class="sheet-actions" style="width:100%">
        <button class="primary" id="opt-fill-apply">Apply Fill</button>
        <button class="danger" id="opt-fill-clear-sel">Clear Selection</button>
      </div>`);
      content.querySelector('#opt-color').addEventListener('input', (e) => {
        Settings.fill.color = e.target.value;
      });
      const opacityEl = content.querySelector('#opt-fill-opacity');
      const opacityVal = content.querySelector('#opt-fill-opacity-val');
      opacityEl.addEventListener('input', (e) => {
        Settings.fill.opacity = +e.target.value;
        opacityVal.textContent = e.target.value + '%';
      });
      if (Settings.fill.opacity === undefined) Settings.fill.opacity = 100;
      content.querySelector('#opt-fill-apply').addEventListener('click', () => {
        const c = U.parseColor(Settings.fill.color);
        if (c) {
          c[3] = Math.round((Settings.fill.opacity / 100) * 255);
          App.tools.fill.fill(c);
        }
      });
      content.querySelector('#opt-fill-clear-sel').addEventListener('click', () => {
        App.layers.clearSelection();
        App.engine.invalidateOverlay();
      });
    }

    else if (tool === 'eyedropper') {
      addRow(`<label>Hint</label>
        <div style="flex:1; font-size:12px; color:#b0b0b6;">Tap anywhere on the image to sample its color. The result becomes the fill color and brush color.</div>`);
      // Eyedropper has no settings; tapping on canvas triggers the pick action.
    }

    else if (tool === 'text') {
      addRow(`<label>Base size</label>
        <input type="number" min="8" max="400" step="1" value="${Settings.text.baseFontSize}" id="opt-text-size">
        <span class="value-pill"></span>`);
      addRow(`<label>Color</label>
        <input type="color" value="${Settings.text.color}" id="opt-text-color">
        <span class="value-pill"></span>`);
      addRow(`<label>Stroke</label>
        <input type="color" value="${Settings.text.strokeColor}" id="opt-text-stroke">
        <input type="number" min="0" max="20" step="0.5" value="${Settings.text.strokeWidth}" id="opt-text-stroke-w" style="flex:0 0 60px">`);
      addRow(`<label>Align</label>
        <div class="seg-group">
          <button class="seg-btn ${Settings.text.align === 'left' ? 'active' : ''}" data-align="left">L</button>
          <button class="seg-btn ${Settings.text.align === 'center' ? 'active' : ''}" data-align="center">C</button>
          <button class="seg-btn ${Settings.text.align === 'right' ? 'active' : ''}" data-align="right">R</button>
        </div>`);
      addRow(`<label>Style</label>
        <div class="seg-group">
          <button class="seg-btn ${Settings.text.bold ? 'active' : ''}" id="opt-text-bold">Bold</button>
          <button class="seg-btn ${Settings.text.italic ? 'active' : ''}" id="opt-text-italic">Italic</button>
          <button class="seg-btn ${Settings.text.autoFit ? 'active' : ''}" id="opt-text-autofit">Auto-fit</button>
        </div>`);
      addRow(`<div class="sheet-actions" style="width:100%">
        <button id="opt-text-add">+ New Text Box</button>
        <button class="danger" id="opt-text-delete">Delete Selected</button>
      </div>`);
      content.querySelector('#opt-text-size').addEventListener('input', (e) => {
        Settings.text.baseFontSize = +e.target.value;
        if (App.tools.text && App.tools.text._selected) {
          App.tools.text._selected.baseFontSize = Settings.text.baseFontSize;
          App.tools.text._selected.fontSize = Settings.text.baseFontSize;
          App.engine.invalidateSource();
        }
      });
      content.querySelector('#opt-text-color').addEventListener('input', (e) => {
        Settings.text.color = e.target.value;
        if (App.tools.text && App.tools.text._selected) {
          App.tools.text._selected.color = e.target.value;
          App.engine.invalidateSource();
        }
      });
      content.querySelector('#opt-text-stroke').addEventListener('input', (e) => {
        Settings.text.strokeColor = e.target.value;
        if (App.tools.text && App.tools.text._selected) {
          App.tools.text._selected.strokeColor = e.target.value;
          App.engine.invalidateSource();
        }
      });
      content.querySelector('#opt-text-stroke-w').addEventListener('input', (e) => {
        Settings.text.strokeWidth = +e.target.value;
        if (App.tools.text && App.tools.text._selected) {
          App.tools.text._selected.strokeWidth = Settings.text.strokeWidth;
          App.engine.invalidateSource();
        }
      });
      content.querySelectorAll('[data-align]').forEach(b => {
        b.addEventListener('click', () => {
          Settings.text.align = b.getAttribute('data-align');
          content.querySelectorAll('[data-align]').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          if (App.tools.text && App.tools.text._selected) {
            App.tools.text._selected.align = Settings.text.align;
            App.engine.invalidateSource();
          }
        });
      });
      content.querySelector('#opt-text-bold').addEventListener('click', (e) => {
        Settings.text.bold = !Settings.text.bold;
        e.currentTarget.classList.toggle('active', Settings.text.bold);
        if (App.tools.text && App.tools.text._selected) {
          App.tools.text._selected.bold = Settings.text.bold;
          App.engine.invalidateSource();
        }
      });
      content.querySelector('#opt-text-italic').addEventListener('click', (e) => {
        Settings.text.italic = !Settings.text.italic;
        e.currentTarget.classList.toggle('active', Settings.text.italic);
        if (App.tools.text && App.tools.text._selected) {
          App.tools.text._selected.italic = Settings.text.italic;
          App.engine.invalidateSource();
        }
      });
      content.querySelector('#opt-text-autofit').addEventListener('click', (e) => {
        Settings.text.autoFit = !Settings.text.autoFit;
        e.currentTarget.classList.toggle('active', Settings.text.autoFit);
        if (App.tools.text && App.tools.text._selected) {
          App.tools.text._selected.autoFit = Settings.text.autoFit;
          App.engine.invalidateSource();
        }
      });
      content.querySelector('#opt-text-add').addEventListener('click', () => {
        // Add a new text box centered in the current viewport.
        if (!App.layers) return;
        const cx = App.engine.stageW / 2;
        const cy = App.engine.stageH / 2;
        const { x, y } = App.engine.screenToImage(cx, cy);
        const tb = new global.TextBox({
          x: x - 100, y: y - 40, w: 200, h: 80,
          text: '',
          ...Settings.text
        });
        App.layers.addTextObject(tb);
        App.tools.text._selected = tb;
        App.engine.invalidateSource();
        openTextModal(tb);
      });
      content.querySelector('#opt-text-delete').addEventListener('click', () => {
        if (App.tools.text) App.tools.text.deleteSelected();
      });
    }

    sheet.classList.remove('hidden');
  }

  /* ---------- Selection operations ---------- */
  function invertSelection() {
    if (!App.layers || !App.layers.hasSelection()) { U.toast('No selection'); return; }
    const w = App.layers.width, h = App.layers.height;
    const mask = App.layers.getSelection().slice();
    global.SelectionOps.invert(mask);
    const before = App.layers.getSelection();
    App.layers.setSelection(mask);
    App.history.push({
      label: 'Invert selection',
      undo: () => App.layers.setSelection(before.slice(0)),
      redo: () => App.layers.setSelection(mask.slice(0))
    });
    App.engine.invalidateOverlay();
  }

  function expandContract(radius) {
    if (!App.layers || !App.layers.hasSelection()) { U.toast('No selection'); return; }
    const w = App.layers.width, h = App.layers.height;
    const before = App.layers.getSelection();
    const m = before.slice();
    const after = radius > 0
      ? global.SelectionOps.dilate(m, w, h, radius)
      : global.SelectionOps.erode(m, w, h, -radius);
    App.layers.setSelection(after);
    App.history.push({
      label: (radius > 0 ? 'Expand' : 'Contract') + ' selection',
      undo: () => App.layers.setSelection(before.slice(0)),
      redo: () => App.layers.setSelection(after.slice(0))
    });
    App.engine.invalidateOverlay();
  }

  function featherSelection() {
    if (!App.layers || !App.layers.hasSelection()) { U.toast('No selection'); return; }
    const w = App.layers.width, h = App.layers.height;
    const before = App.layers.getSelection();
    const after = global.SelectionOps.feather(before.slice(), w, h, 3);
    App.layers.setSelection(after);
    App.history.push({
      label: 'Feather selection',
      undo: () => App.layers.setSelection(before.slice(0)),
      redo: () => App.layers.setSelection(after.slice(0))
    });
    App.engine.invalidateOverlay();
  }

  /* ---------- Text modal ---------- */
  function openTextModal(textBox) {
    const modal = document.getElementById('text-modal');
    const input = document.getElementById('text-modal-input');
    const sizeEl = document.getElementById('text-modal-size');
    const colorEl = document.getElementById('text-modal-color');
    const alignEl = document.getElementById('text-modal-align');
    const valignEl = document.getElementById('text-modal-valign');
    const strokeEl = document.getElementById('text-modal-stroke');
    const strokeWEl = document.getElementById('text-modal-stroke-w');
    const boldEl = document.getElementById('text-modal-bold');
    const italicEl = document.getElementById('text-modal-italic');
    const autofitEl = document.getElementById('text-modal-autofit');
    const fontFamilyEl = document.getElementById('text-modal-font-family');
    const fontWeightEl = document.getElementById('text-modal-font-weight');
    const letterSpacingEl = document.getElementById('text-modal-letter-spacing');
    const lineHeightEl = document.getElementById('text-modal-line-height');
    const rotationEl = document.getElementById('text-modal-rotation');
    const opacityEl = document.getElementById('text-modal-opacity');
    const bgColorEl = document.getElementById('text-modal-bg-color');
    const bgOpacityEl = document.getElementById('text-modal-bg-opacity');
    const shadowEl = document.getElementById('text-modal-shadow');

    // Snapshot for undo.
    const before = {
      text: textBox.text,
      fontSize: textBox.fontSize,
      baseFontSize: textBox.baseFontSize,
      color: textBox.color,
      align: textBox.align,
      valign: textBox.valign,
      strokeColor: textBox.strokeColor,
      strokeWidth: textBox.strokeWidth,
      bold: textBox.bold,
      italic: textBox.italic,
      autoFit: textBox.autoFit,
      fontFamily: textBox.fontFamily,
      fontWeight: textBox.fontWeight || '400',
      letterSpacing: textBox.letterSpacing || 0,
      lineHeight: textBox.lineHeight || 1.2,
      rotation: textBox.rotation || 0,
      opacity: textBox.opacity !== undefined ? textBox.opacity : 1,
      bgColor: textBox.bgColor || '#ffffff',
      bgOpacity: textBox.bgOpacity || 0,
      shadow: !!textBox.shadow
    };

    input.value = textBox.text || '';
    sizeEl.value = textBox.fontSize;
    colorEl.value = textBox.color;
    alignEl.value = textBox.align;
    valignEl.value = textBox.valign || 'middle';
    strokeEl.value = textBox.strokeColor;
    strokeWEl.value = textBox.strokeWidth;
    boldEl.checked = textBox.bold;
    italicEl.checked = textBox.italic;
    autofitEl.checked = textBox.autoFit;
    fontFamilyEl.value = textBox.fontFamily.split(',')[0] || 'Noto Sans Bengali';
    fontWeightEl.value = textBox.fontWeight || '400';
    letterSpacingEl.value = textBox.letterSpacing || 0;
    lineHeightEl.value = textBox.lineHeight || 1.2;
    rotationEl.value = textBox.rotation || 0;
    opacityEl.value = textBox.opacity !== undefined ? textBox.opacity : 1;
    bgColorEl.value = textBox.bgColor || '#ffffff';
    bgOpacityEl.value = textBox.bgOpacity || 0;
    shadowEl.checked = !!textBox.shadow;

    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);

    const cancelBtn = document.getElementById('text-modal-cancel');
    const applyBtn = document.getElementById('text-modal-apply');

    const onApply = () => {
      const after = {
        text: input.value,
        fontSize: +sizeEl.value,
        baseFontSize: +sizeEl.value,
        color: colorEl.value,
        align: alignEl.value,
        valign: valignEl.value,
        strokeColor: strokeEl.value,
        strokeWidth: +strokeWEl.value,
        bold: boldEl.checked,
        italic: italicEl.checked,
        autoFit: autofitEl.checked,
        fontFamily: fontFamilyEl.value,
        fontWeight: fontWeightEl.value,
        letterSpacing: +letterSpacingEl.value,
        lineHeight: +lineHeightEl.value,
        rotation: +rotationEl.value,
        opacity: +opacityEl.value,
        bgColor: bgColorEl.value,
        bgOpacity: +bgOpacityEl.value,
        shadow: shadowEl.checked
      };
      Object.assign(textBox, after);
      textBox._lines = null; // force relayout
      App.tools.text.applyEdit(textBox, before, after);
      modal.classList.add('hidden');
      cleanup();
    };
    const onCancel = () => {
      modal.classList.add('hidden');
      cleanup();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onApply();
    };
    function cleanup() {
      applyBtn.removeEventListener('click', onApply);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('keydown', onKey);
    }
    applyBtn.addEventListener('click', onApply);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('keydown', onKey);
  }

  /* ---------- Canvas pointer routing ---------- */
  function wireCanvas() {
    const display = document.getElementById('display-canvas');

    display.addEventListener('pointerdown', onPointerDown);
    display.addEventListener('pointermove', onPointerMove);
    display.addEventListener('pointerup', onPointerUp);
    display.addEventListener('pointercancel', onPointerCancel);
    display.addEventListener('pointerleave', onPointerLeave);
    // Prevent context menu (long-press on Android).
    display.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * Pointer routing logic:
   * - If 2+ pointers are down: pan/zoom mode (we own them, regardless of tool).
   * - If 1 pointer down and active tool is 'pan': pan.
   * - If 1 pointer down and active tool is a drawing tool: route to tool.
   * - Eyedropper: any tap samples color.
   *
   * Palm rejection: if a tool is mid-stroke and a second pointer lands, the
   * stroke continues (its first pointer stays owned by the tool); the second
   * pointer is ignored unless a third pointer lands (then we let engine pan
   * using the latest two). This matches user expectation: rest palm while
   * drawing → stroke continues; pinch with two clean fingers → zoom.
   */
  function onPointerDown(e) {
    if (!App.layers) return;
    App._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.preventDefault();

    // Capture pointer so we keep getting events even if the finger drifts
    // off the canvas (common when drawing near the edge).
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    // Double-tap detection (for closing polygon lasso, editing text boxes).
    const now = Date.now();
    if (App._lastTapTime && now - App._lastTapTime < 300 &&
        App._lastTapX !== undefined &&
        Math.abs(e.clientX - App._lastTapX) < 30 &&
        Math.abs(e.clientY - App._lastTapY) < 30) {
      // It's a double-tap.
      App._lastTapTime = 0;
      if (App.activeTool === 'lasso' && App.tools.lasso) {
        App.tools.lasso.onDoubleTap();
        return;
      }
      if (App.activeTool === 'text' && App.tools.text) {
        App.tools.text.onDoubleTap(e);
        return;
      }
    }
    App._lastTapTime = now;
    App._lastTapX = e.clientX;
    App._lastTapY = e.clientY;

    if (App.activeTool === 'eyedropper') {
      const { x, y } = App.engine.eventToImage(e);
      const c = App.tools.fill.pickColor(x, y);
      if (c) {
        const hex = U.rgbToHex(c[0], c[1], c[2]);
        Settings.fill.color = hex;
        Settings.brush.color = hex;
        const bc = U.parseColor(hex);
        if (bc) App.tools.brush.color = bc;
        U.toast('Picked: ' + hex);
        // Refresh options sheet if open.
        const cEl = document.getElementById('opt-color');
        if (cEl) cEl.value = hex;
      }
      App._activePointers.delete(e.pointerId);
      return;
    }

    if (App.activeTool === 'pan') {
      // Pan/zoom is handled here.
      if (App._activePointers.size === 1) {
        App._panLast = { x: e.clientX, y: e.clientY };
        App._pointerSession = e.pointerId;
      } else if (App._activePointers.size === 2) {
        App._panLast = null;
        const pts = [...App._activePointers.values()];
        App.engine.resetPinch();
        App.engine.updatePinch(
          { clientX: pts[0].x, clientY: pts[0].y },
          { clientX: pts[1].x, clientY: pts[1].y }
        );
      }
      return;
    }

    // Active drawing/selection/text tool.
    if (App._activePointers.size === 1) {
      // Single pointer → route to active tool.
      App._pointerSession = e.pointerId;
      routeToTool('down', e);
    } else if (App._activePointers.size >= 2 && !App._pointerSession) {
      // Multi-touch and no tool session in progress → pan/zoom.
      const pts = [...App._activePointers.values()];
      App.engine.resetPinch();
      App.engine.updatePinch(
        { clientX: pts[0].x, clientY: pts[0].y },
        { clientX: pts[1].x, clientY: pts[1].y }
      );
    }
    // If a tool session is in progress and a second pointer lands, ignore the
    // second pointer (palm rejection). Tool keeps its first pointer.
  }

  function onPointerMove(e) {
    if (!App.layers) return;
    if (App._activePointers.has(e.pointerId)) {
      App._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    e.preventDefault();

    if (App.activeTool === 'pan') {
      if (App._activePointers.size === 1 && App._panLast) {
        const dx = e.clientX - App._panLast.x;
        const dy = e.clientY - App._panLast.y;
        App._panLast = { x: e.clientX, y: e.clientY };
        App.engine.panBy(dx, dy);
        updateStatusPill();
      } else if (App._activePointers.size >= 2) {
        const pts = [...App._activePointers.values()];
        App.engine.updatePinch(
          { clientX: pts[0].x, clientY: pts[0].y },
          { clientX: pts[1].x, clientY: pts[1].y }
        );
        updateStatusPill();
      }
      return;
    }

    if (e.pointerId === App._pointerSession) {
      // Active stroke — route to tool.
      routeToTool('move', e);
    } else if (App._activePointers.size >= 2 && !App._pointerSession) {
      // Pinch with two fingers (no active stroke).
      const pts = [...App._activePointers.values()];
      App.engine.updatePinch(
        { clientX: pts[0].x, clientY: pts[0].y },
        { clientX: pts[1].x, clientY: pts[1].y }
      );
      updateStatusPill();
    } else if (!App._pointerSession) {
      // Hover (no buttons pressed) — route to tool for cursor preview updates.
      // Tools that don't need hover (wand, fill, etc.) simply ignore non-stroke moves.
      const t = App.activeTool;
      if (t === 'brush' || t === 'eraser') {
        routeToTool('move', e);
      }
    }
  }

  function onPointerUp(e) {
    if (!App.layers) return;
    App._activePointers.delete(e.pointerId);

    if (App.activeTool === 'pan') {
      if (App._activePointers.size === 0) {
        App._panLast = null;
        App.engine.resetPinch();
      } else if (App._activePointers.size === 1) {
        // Was pinch, now single-finger pan.
        const p = [...App._activePointers.values()][0];
        App._panLast = p;
        App.engine.resetPinch();
      }
      return;
    }

    if (e.pointerId === App._pointerSession) {
      routeToTool('up', e);
      App._pointerSession = null;
    }

    // If more pointers remain after tool's session ended, they may start a pinch.
    if (App._activePointers.size >= 2) {
      const pts = [...App._activePointers.values()];
      App.engine.resetPinch();
      App.engine.updatePinch(
        { clientX: pts[0].x, clientY: pts[0].y },
        { clientX: pts[1].x, clientY: pts[1].y }
      );
    }
  }

  function onPointerCancel(e) {
    onPointerUp(e);
    routeToTool('cancel', e);
  }

  function onPointerLeave(e) {
    // Don't cancel tool strokes if pointer leaves canvas briefly (common on mobile).
    // Only act if the pointer actually went up (handled by pointerup).
    // But hide the brush cursor preview when leaving the canvas (desktop).
    if (!App._pointerSession && (App.activeTool === 'brush' || App.activeTool === 'eraser')) {
      // Just clear the cursor position so it doesn't show outside the canvas.
      // We keep the cursor kind so it reappears on pointer enter.
      // Actually, easier: clear cursor position to null.
      if (App.engine) App.engine._cursorPos = null;
      if (App.engine) App.engine.invalidateOverlay();
    }
  }

  function routeToTool(phase, e) {
    const tool = App.activeTool;
    if (tool === 'brush' && App.tools.brush) {
      if (phase === 'down') App.tools.brush.onPointerDown(e);
      else if (phase === 'move') App.tools.brush.onPointerMove(e);
      else if (phase === 'up') App.tools.brush.onPointerUp(e);
      else if (phase === 'cancel') App.tools.brush.onPointerCancel(e);
    } else if (tool === 'eraser' && App.tools.eraser) {
      if (phase === 'down') App.tools.eraser.onPointerDown(e);
      else if (phase === 'move') App.tools.eraser.onPointerMove(e);
      else if (phase === 'up') App.tools.eraser.onPointerUp(e);
      else if (phase === 'cancel') App.tools.eraser.onPointerCancel(e);
    } else if (tool === 'wand' && App.tools.wand) {
      if (phase === 'down') {
        const { x, y } = App.engine.eventToImage(e);
        App.tools.wand.select(x, y).then(mask => {
          if (!mask) return;
          let count = 0;
          for (let i = 0; i < mask.length; i++) if (mask[i]) { count++; break; }
          if (count === 0) { U.toast('Nothing selected'); return; }
          const prev = App.layers.getSelection();
          App.layers.setSelection(mask);
          App.history.push({
            label: 'Magic wand',
            undo: () => { if (prev) App.layers.setSelection(prev.slice(0)); else App.layers.clearSelection(); },
            redo: () => App.layers.setSelection(mask.slice(0))
          });
        }).catch(err => {
          console.error(err);
          U.toast('Selection failed');
        });
      }
    } else if (tool === 'lasso' && App.tools.lasso) {
      if (phase === 'down') App.tools.lasso.onPointerDown(e);
      else if (phase === 'move') App.tools.lasso.onPointerMove(e);
      else if (phase === 'up') App.tools.lasso.onPointerUp(e);
      else if (phase === 'cancel') App.tools.lasso.onPointerCancel(e);
    } else if (tool === 'text' && App.tools.text) {
      if (phase === 'down') App.tools.text.onPointerDown(e);
      else if (phase === 'move') App.tools.text.onPointerMove(e);
      else if (phase === 'up') App.tools.text.onPointerUp(e);
    } else if (tool === 'fill' && App.tools.fill) {
      // Tap on canvas = fill active selection (or whole image).
      if (phase === 'down') {
        const c = U.parseColor(Settings.fill.color);
        if (c) {
          c[3] = Math.round((Settings.fill.opacity / 100) * 255);
          App.tools.fill.fill(c);
        }
      }
    }
  }

  /* ---------- Keyboard (desktop secondary) ---------- */
  function wireKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Ignore if typing in an input/textarea.
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) App.history.redo(); else App.history.undo();
      } else if (meta && e.key === 'y') {
        e.preventDefault();
        App.history.redo();
      } else if (e.key === 'Escape') {
        if (App.layers) App.layers.clearSelection();
        if (App.tools.text) App.tools.text.deselect();
        App.engine.invalidateOverlay();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete selected pixels (clear edit layer inside selection).
        if (App.layers && App.layers.hasSelection()) deleteSelectionPixels();
        else if (App.tools.text && App.tools.text._selected) App.tools.text.deleteSelected();
      } else {
        // Quick tool switch via single keys.
        const map = { 'w': 'wand', 'l': 'lasso', 'b': 'brush', 'e': 'eraser',
                      'f': 'fill', 'i': 'eyedropper', 't': 'text', 'h': 'pan' };
        if (map[e.key.toLowerCase()] && !meta) setActiveTool(map[e.key.toLowerCase()]);
      }
    });
  }

  function deleteSelectionPixels() {
    if (!App.layers || !App.layers.hasSelection()) return;
    const editLayer = App.layers.getEditLayer();
    const mask = App.layers.getSelection();
    const w = App.layers.width, h = App.layers.height;
    const before = editLayer.ctx.getImageData(0, 0, w, h);
    // Erase selected pixels.
    const imgData = editLayer.ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      if (mask[p] > 0) data[i + 3] = 0; // clear alpha
    }
    editLayer.ctx.putImageData(imgData, 0, 0);
    const after = editLayer.ctx.getImageData(0, 0, w, h);
    App.history.push({
      label: 'Delete selection',
      undo: () => { editLayer.ctx.putImageData(before, 0, 0); editLayer.invalidate(); },
      redo: () => { editLayer.ctx.putImageData(after, 0, 0); editLayer.invalidate(); }
    });
    editLayer.invalidate();
  }

  /* ---------- Export ---------- */
  function exportPNG() {
    if (!App.layers) { U.toast('No image'); return; }
    const w = App.layers.width, h = App.layers.height;
    const out = U.makeCanvas(w, h);
    App.layers.composite(out.ctx);
    out.canvas.toBlob((blob) => {
      if (!blob) { U.toast('Export failed'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'manga-edit-' + Date.now() + '.png';
      // Append to DOM for iOS Safari; harmless elsewhere.
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
      U.toast('Exported PNG');
    }, 'image/png');
  }

  /* ---------- Status pill ---------- */
  function updateStatusPill() {
    const pill = document.getElementById('status-pill');
    if (!pill) return;
    if (!App.engine.hasImage()) { pill.classList.add('hidden'); return; }
    if (App.tools && App.tools.wand && App.tools.wand.busy) return; // busy state owns the pill
    pill.textContent = U.formatZoom(App.engine.scale);
    pill.classList.remove('hidden');
    pill.classList.remove('busy');
  }

  /* ---------- Orientation ---------- */
  function wireOrientation() {
    window.addEventListener('orientationchange', () => {
      setTimeout(() => updateStatusPill(), 200);
    });
  }

  /* ---------- Boot ---------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging.
  global.MangaEditor = App;
})(window);
