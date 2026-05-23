(() => {
    'use strict';

    // ========== DOM ==========
    const $ = id => document.getElementById(id);
    const canvas = $('main-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const overlay = $('overlay-canvas');
    const octx = overlay.getContext('2d');
    const textCanvas = $('text-canvas');
    const tctx = textCanvas.getContext('2d');
    const area = $('canvas-area');
    const fileInput = $('file-input');
    const dropZone = $('drop-zone');
    const placeholder = $('placeholder');
    const undoBtn = $('undo-btn');
    const redoBtn = $('redo-btn');
    const fitBtn = $('fit-btn');
    const exportBtn = $('export-btn');
    const zoomDisplay = $('zoom-display');
    const pickedColorPreview = $('picked-color-preview');
    const brushPanel = $('brush-panel');
    const brushTrigger = $('brush-trigger');
    const brushTriggerSwatch = $('brush-trigger-swatch');
    const brushSizeEl = $('brush-size');
    const brushSizeVal = $('brush-size-val');
    const brushHardnessEl = $('brush-hardness');
    const brushHardnessVal = $('brush-hardness-val');
    const brushOpacityEl = $('brush-opacity');
    const brushOpacityVal = $('brush-opacity-val');
    const brushFlowEl = $('brush-flow');
    const brushFlowVal = $('brush-flow-val');
    const brushPreviewCanvas = $('brush-preview');
    const brushPreviewCtx = brushPreviewCanvas.getContext('2d');

    // Color panel
    const colorBtn = $('color-btn');
    const colorBtnSwatch = $('color-btn-swatch');
    const colorPanel = $('color-panel');
    const cpGradient = $('cp-gradient');
    const cpGradientCtx = cpGradient.getContext('2d');
    const cpCrosshair = $('cp-crosshair');
    const cpHueEl = $('cp-hue');
    const cpHueCtx = cpHueEl.getContext('2d');
    const cpHueIndicator = $('cp-hue-indicator');
    const cpHexInput = $('cp-hex');
    const cpPalette = $('cp-palette');
    const cpRecent = $('cp-recent');
    const cpRGBSliders = $('cp-rgb-sliders');
    const cpHSLSliders = $('cp-hsl-sliders');

    // Layer panel
    const layerPanel = $('layer-panel');
    const layerBtn = $('layer-btn');
    const lpList = $('lp-list');
    const lpOpacity = $('lp-opacity');
    const lpOpacityVal = $('lp-opacity-val');
    const lpBlendMode = $('lp-blend-mode');
    const lpAddBtn = $('lp-add-btn');
    const lpDupBtn = $('lp-dup-btn');
    const lpDelBtn = $('lp-del-btn');
    const lpMergeBtn = $('lp-merge-btn');

    // Text toolbar
    const textToolbar = $('text-toolbar');

    // ========== STATE ==========
    let img = null;
    let fileName = 'image';
    let off = null;      // compositing scratch buffer
    let offCtx = null;

    // Layers
    let layers = [];
    let activeLayerId = null;
    let layerIdCounter = 0;
    const MAX_UNDO = 40;

    // View
    let zoom = 1;
    let panX = 0, panY = 0;
    let baseWidth = 0, baseHeight = 0;

    // Tool
    let currentTool = 'select';
    let prevTool = 'select';

    // Selection (image coords)
    let sel = null;
    let selActive = false;
    let selStart = { x: 0, y: 0 };

    // Crop selection
    let cropSel = null;

    // Brush / Eraser
    let brushSize = 12;
    let brushHardness = 100;
    let brushOpacity = 100;
    let brushFlow = 100;
    let brushColor = '#000000';
    let eraserSize = 20;

    // Color panel
    let cpHue = 0, cpSat = 100, cpLit = 50;
    let savedPalette = [];
    let recentColors = [];
    const MAX_RECENT = 16;
    let drawing = false;
    let lastPt = null;

    // Text — new architecture
    let textObjects = [];
    let selectedText = null;
    let textDragActive = false;
    let textDragStart = null;
    let textRotating = false;
    let textRotateStart = null;
    let textResizing = false;
    let textResizeEdge = null;
    let textResizeStart = null;
    let textModalOpen = false;
    let lastTapTime = 0;
    let lastTapTarget = null;

    // Fill
    let fillColor = '#ffffff';
    let fillTolerance = 30;

    // Touch
    let touchCache = [];
    let lastPinchDist = 0;
    let lastPinchCenter = { x: 0, y: 0 };
    let isPinching = false;
    let touchPending = false;
    let touchStartPt = null;
    const TOUCH_THRESHOLD = 8;

    // Pointer (mouse/pen)
    let pointerDown = false;

    // ========== LAYER SYSTEM ==========
    function createLayer(name, w, h) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cx = c.getContext('2d', { willReadFrequently: true });
        return {
            id: layerIdCounter++,
            name: name,
            canvas: c,
            ctx: cx,
            visible: true,
            opacity: 100,
            locked: false,
            blendMode: 'source-over',
            undoStack: [],
            redoStack: []
        };
    }

    function getActiveLayer() {
        return layers.find(l => l.id === activeLayerId) || null;
    }

    function addLayer(name) {
        const w = off ? off.width : 100;
        const h = off ? off.height : 100;
        const layer = createLayer(name || ('Layer ' + layerIdCounter), w, h);
        const activeIdx = layers.findIndex(l => l.id === activeLayerId);
        layers.splice(activeIdx + 1, 0, layer);
        activeLayerId = layer.id;
        renderLayerPanel();
        renderAll();
        updateUndoButtons();
    }

    function deleteLayer(id) {
        if (layers.length <= 1) {
            const layer = layers[0];
            layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
            layer.undoStack = [];
            layer.redoStack = [];
            renderLayerPanel();
            renderAll();
            updateUndoButtons();
            return;
        }
        const idx = layers.findIndex(l => l.id === id);
        if (idx === -1) return;
        layers.splice(idx, 1);
        if (activeLayerId === id) {
            activeLayerId = layers[Math.min(idx, layers.length - 1)].id;
        }
        renderLayerPanel();
        renderAll();
        updateUndoButtons();
    }

    function duplicateLayer(id) {
        const src = layers.find(l => l.id === id);
        if (!src) return;
        const layer = createLayer(src.name + ' copy', src.canvas.width, src.canvas.height);
        layer.ctx.drawImage(src.canvas, 0, 0);
        layer.visible = src.visible;
        layer.opacity = src.opacity;
        layer.blendMode = src.blendMode;
        const idx = layers.findIndex(l => l.id === id);
        layers.splice(idx + 1, 0, layer);
        activeLayerId = layer.id;
        renderLayerPanel();
        renderAll();
        updateUndoButtons();
    }

    function mergeDown(id) {
        const idx = layers.findIndex(l => l.id === id);
        if (idx <= 0) return;
        const top = layers[idx];
        const bot = layers[idx - 1];
        bot.ctx.save();
        bot.ctx.globalAlpha = top.opacity / 100;
        bot.ctx.globalCompositeOperation = top.blendMode;
        bot.ctx.drawImage(top.canvas, 0, 0);
        bot.ctx.restore();
        layers.splice(idx, 1);
        activeLayerId = bot.id;
        renderLayerPanel();
        renderAll();
        updateUndoButtons();
    }

    function moveLayer(fromIdx, toIdx) {
        if (fromIdx === toIdx) return;
        const [layer] = layers.splice(fromIdx, 1);
        layers.splice(toIdx, 0, layer);
        renderLayerPanel();
        renderAll();
    }

    function setActiveLayer(id) {
        if (textModalOpen) commitTextModal();
        activeLayerId = id;
        renderLayerPanel();
        updateUndoButtons();
    }

    function compositeAll() {
        if (!off) return;
        offCtx.clearRect(0, 0, off.width, off.height);
        for (const layer of layers) {
            if (!layer.visible) continue;
            offCtx.save();
            offCtx.globalAlpha = layer.opacity / 100;
            offCtx.globalCompositeOperation = layer.blendMode;
            offCtx.drawImage(layer.canvas, 0, 0);
            offCtx.restore();
        }
    }

    function saveAllLayerStates() {
        for (const layer of layers) {
            const c = layer.canvas;
            layer.undoStack.push(layer.ctx.getImageData(0, 0, c.width, c.height));
            if (layer.undoStack.length > MAX_UNDO) layer.undoStack.shift();
            layer.redoStack = [];
        }
    }

    // ========== INIT ==========
    function init() {
        setupFileLoading();
        setupDragDrop();
        setupToolButtons();
        setupOptions();
        setupPointer();
        setupTouch();
        setupKeyboard();
        setupResize();
        setupLayerPanel();
        showToolOptions('select');
    }

    // ========== FILE LOADING ==========
    function setupFileLoading() {
        fileInput.addEventListener('change', e => {
            if (e.target.files[0]) loadFile(e.target.files[0]);
            fileInput.value = '';
        });
    }

    function setupDragDrop() {
        let dc = 0;
        area.addEventListener('dragenter', e => { e.preventDefault(); dc++; dropZone.classList.remove('hidden'); });
        area.addEventListener('dragover', e => e.preventDefault());
        area.addEventListener('dragleave', () => { dc--; if (dc <= 0) { dc = 0; dropZone.classList.add('hidden'); } });
        area.addEventListener('drop', e => {
            e.preventDefault(); dc = 0; dropZone.classList.add('hidden');
            if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
        });
    }

    function loadFile(file) {
        if (!file.type.startsWith('image/')) return;
        fileName = file.name.replace(/\.[^.]+$/, '');
        const reader = new FileReader();
        reader.onload = e => {
            const image = new Image();
            image.onload = () => {
                img = image;

                off = document.createElement('canvas');
                off.width = img.width;
                off.height = img.height;
                offCtx = off.getContext('2d', { willReadFrequently: true });

                const bg = createLayer('Background', img.width, img.height);
                bg.ctx.drawImage(img, 0, 0);
                layers = [bg];
                activeLayerId = bg.id;

                syncCanvasSize();

                sel = null;
                cropSel = null;

                baseWidth = img.width;
                baseHeight = img.height;
                fitToView();
                placeholder.classList.add('hidden');
                area.classList.add('interactive');
                saveState();
                renderLayerPanel();
            };
            image.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    function fitToView() {
        if (!img) return;
        const w = area.clientWidth;
        const h = area.clientHeight;
        zoom = Math.min(w / img.width, h / img.height, 1);
        panX = (w - img.width * zoom) / 2;
        panY = (h - img.height * zoom) / 2;
        renderAll();
        updateZoomDisplay();
    }

    // ========== RENDERING ==========
    let isZooming = false;
    let zoomEndTimer = null;

    function syncCanvasSize() {
        canvas.width = off.width;
        canvas.height = off.height;
        overlay.width = off.width;
        overlay.height = off.height;
        resizeTextCanvas();
    }

    function resizeTextCanvas() {
        textCanvas.width = area.clientWidth;
        textCanvas.height = area.clientHeight;
    }

    function applyZoomView() {
        const t = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        canvas.style.transform = t;
        overlay.style.transform = t;
    }

    function renderContent() {
        compositeAll();
        ctx.clearRect(0, 0, off.width, off.height);
        ctx.drawImage(off, 0, 0);
    }

    function renderAll() {
        if (!img) return;
        renderContent();
        renderOverlay();
        applyZoomView();
        renderTextObjects();
    }

    function zoomRender() {
        isZooming = true;
        applyZoomView();
        overlay.style.display = 'none';
        renderTextObjects(); // Keep text visible during zoom
        clearTimeout(zoomEndTimer);
        zoomEndTimer = setTimeout(onZoomEnd, 120);
    }

    function onZoomEnd() {
        isZooming = false;
        overlay.style.display = '';
        renderAll();
    }

    function renderOverlay() {
        octx.clearRect(0, 0, overlay.width, overlay.height);

        // Selection
        if (sel && currentTool !== 'crop') {
            octx.save();
            octx.strokeStyle = '#7c6cf0';
            octx.lineWidth = 2 / zoom;
            octx.setLineDash([6 / zoom, 4 / zoom]);
            octx.strokeRect(sel.x, sel.y, sel.w, sel.h);
            octx.setLineDash([]);
            octx.fillStyle = 'rgba(0,0,0,0.3)';
            octx.fillRect(0, 0, overlay.width, sel.y);
            octx.fillRect(0, sel.y, sel.x, sel.h);
            octx.fillRect(sel.x + sel.w, sel.y, overlay.width - (sel.x + sel.w), sel.h);
            octx.fillRect(0, sel.y + sel.h, overlay.width, overlay.height - (sel.y + sel.h));
            const hs = 5 / zoom;
            octx.fillStyle = '#7c6cf0';
            corners(sel).forEach(([cx, cy]) => {
                octx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2);
            });
            octx.restore();
        }

        // Crop selection
        if (cropSel && currentTool === 'crop') {
            octx.save();
            octx.strokeStyle = '#2ed573';
            octx.lineWidth = 2 / zoom;
            octx.setLineDash([6 / zoom, 4 / zoom]);
            octx.strokeRect(cropSel.x, cropSel.y, cropSel.w, cropSel.h);
            octx.setLineDash([]);
            octx.fillStyle = 'rgba(0,0,0,0.5)';
            octx.fillRect(0, 0, overlay.width, cropSel.y);
            octx.fillRect(0, cropSel.y, cropSel.x, cropSel.h);
            octx.fillRect(cropSel.x + cropSel.w, cropSel.y, overlay.width - (cropSel.x + cropSel.w), cropSel.h);
            octx.fillRect(0, cropSel.y + cropSel.h, overlay.width, overlay.height - (cropSel.y + cropSel.h));
            octx.strokeStyle = 'rgba(255,255,255,0.3)';
            octx.lineWidth = 1 / zoom;
            for (let i = 1; i <= 2; i++) {
                const lx = cropSel.x + cropSel.w * i / 3;
                octx.beginPath(); octx.moveTo(lx, cropSel.y); octx.lineTo(lx, cropSel.y + cropSel.h); octx.stroke();
                const ly = cropSel.y + cropSel.h * i / 3;
                octx.beginPath(); octx.moveTo(cropSel.x, ly); octx.lineTo(cropSel.x + cropSel.w, ly); octx.stroke();
            }
            octx.restore();
        }
    }

    function corners(r) {
        return [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
    }

    // ========== COORDINATE CONVERSION ==========
    function screenToImg(cx, cy) {
        const rect = area.getBoundingClientRect();
        return {
            x: (cx - rect.left - panX) / zoom,
            y: (cy - rect.top - panY) / zoom
        };
    }

    // Convert image coords to screen coords (relative to area element)
    function imageToScreen(x, y) {
        return { x: x * zoom + panX, y: y * zoom + panY };
    }

    // Convert screen coords (relative to area) to image coords
    function screenPtToImg(sx, sy) {
        return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
    }

    // Get screen point relative to area from a client event
    function getAreaScreenPt(e) {
        const rect = area.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // ========== TEXT SYSTEM ==========
    function createTextObject(x, y, value) {
        return {
            x, y,                    // image coordinates
            text: value || '',
            fontSize: 24,
            fontFamily: "'Noto Sans Bengali', sans-serif",
            color: '#000000',
            align: 'left',
            bold: false,
            italic: false,
            lineHeight: 1.4,
            boxWidth: 200,           // in image pixels — controls word wrap
            boxHeight: 0,            // in image pixels — bounding box height (set by computeLines)
            rotation: 0,             // degrees
            _lines: [],              // computed wrapped lines
            _h: 0                    // computed height in image pixels
        };
    }

    function computeLines(obj) {
        const tc = textCanvas.getContext('2d');
        tc.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? 'bold ' : ''}${obj.fontSize}px ${obj.fontFamily}`;
        const words = obj.text.split(' ');
        const lines = [];
        let current = '';
        for (const word of words) {
            const test = current ? current + ' ' + word : word;
            if (tc.measureText(test).width > obj.boxWidth) {
                if (current) lines.push(current);
                current = word;
            } else {
                current = test;
            }
        }
        if (current) lines.push(current);
        // Also split on \n
        obj._lines = lines.flatMap(l => l.split('\n'));
        obj._h = obj._lines.length * obj.fontSize * obj.lineHeight;
        if (!obj.boxHeight) obj.boxHeight = obj._h;
    }

    // Transform screen point (relative to area) into text object's local coordinate system
    // (zoomed, rotated). Used for rotation-aware hit testing.
    function screenToTextLocal(obj, sx, sy) {
        const screen = imageToScreen(obj.x, obj.y);
        const dx = sx - screen.x;
        const dy = sy - screen.y;
        const rad = -(obj.rotation * Math.PI) / 180; // reverse rotation
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return {
            x: dx * cos - dy * sin,
            y: dx * sin + dy * cos
        };
    }

    function hitTestTextScreen(obj, pt) {
        if (!obj || !obj.text) return false;
        const local = screenToTextLocal(obj, pt.x, pt.y);
        const w = obj.boxWidth * zoom;
        const h = obj.boxHeight * zoom;
        return local.x >= 0 && local.x <= w && local.y >= 0 && local.y <= h;
    }

    // Hit test edge handles — returns 'top'|'bottom'|'left'|'right' or null
    function hitTestEdgeHandle(obj, pt) {
        if (!obj || !obj.text) return null;
        const local = screenToTextLocal(obj, pt.x, pt.y);
        const w = obj.boxWidth * zoom;
        const h = obj.boxHeight * zoom;
        const r = 14; // hit radius (mobile-friendly, ~28px hit area)

        const handles = [
            { edge: 'top',    x: w / 2, y: 0 },
            { edge: 'bottom', x: w / 2, y: h },
            { edge: 'left',   x: 0,     y: h / 2 },
            { edge: 'right',  x: w,     y: h / 2 }
        ];

        for (const handle of handles) {
            if (Math.abs(local.x - handle.x) < r && Math.abs(local.y - handle.y) < r) {
                return handle.edge;
            }
        }
        return null;
    }

    function hitTestRotationHandle(obj, pt) {
        if (!obj || !obj.text) return false;
        const local = screenToTextLocal(obj, pt.x, pt.y);
        const w = obj.boxWidth * zoom;
        const h = obj.boxHeight * zoom;
        // Rotation handle circle is at (w/2, h+37) in local coords
        const handleX = w / 2;
        const handleY = h + 37;
        return Math.abs(local.x - handleX) < 14 && Math.abs(local.y - handleY) < 14;
    }

    // ========== TEXT POINTER EVENTS (screen coordinates) ==========
    function textPointerDown(pt) {
        if (textModalOpen) return;

        // Check handles on selected text first
        if (selectedText) {
            // Rotation handle
            if (hitTestRotationHandle(selectedText, pt)) {
                textRotating = true;
                const screen = imageToScreen(selectedText.x, selectedText.y);
                const cx = screen.x + (selectedText.boxWidth * zoom) / 2;
                const cy = screen.y + (selectedText.boxHeight * zoom) / 2;
                textRotateStart = {
                    startAngle: Math.atan2(pt.y - cy, pt.x - cx),
                    startRotation: selectedText.rotation
                };
                hideTextToolbar();
                return;
            }

            // Edge handles
            const edge = hitTestEdgeHandle(selectedText, pt);
            if (edge) {
                textResizing = true;
                textResizeEdge = edge;
                textResizeStart = {
                    px: pt.x,
                    py: pt.y,
                    boxWidth: selectedText.boxWidth,
                    boxHeight: selectedText.boxHeight,
                    ox: selectedText.x,
                    oy: selectedText.y
                };
                hideTextToolbar();
                return;
            }
        }

        // Check double-tap on existing text objects
        const now = Date.now();
        for (let i = textObjects.length - 1; i >= 0; i--) {
            if (hitTestTextScreen(textObjects[i], pt)) {
                // Double-tap detection
                if (lastTapTarget === textObjects[i] && now - lastTapTime < 300) {
                    openTextModal(textObjects[i]);
                    lastTapTime = 0;
                    lastTapTarget = null;
                    return;
                }
                lastTapTime = now;
                lastTapTarget = textObjects[i];

                // Select and start drag
                selectedText = textObjects[i];
                textDragActive = true;
                textDragStart = { px: pt.x, py: pt.y, ox: textObjects[i].x, oy: textObjects[i].y };
                hideTextToolbar();
                renderTextObjects();
                return;
            }
        }

        // Tapped on empty space — deselect
        lastTapTime = 0;
        lastTapTarget = null;
        selectedText = null;
        textDragActive = false;
        hideTextToolbar();
        renderTextObjects();
    }

    function textPointerMove(pt) {
        if (textDragActive && selectedText) {
            const dx = (pt.x - textDragStart.px) / zoom;
            const dy = (pt.y - textDragStart.py) / zoom;
            selectedText.x = textDragStart.ox + dx;
            selectedText.y = textDragStart.oy + dy;
            textCanvas.style.cursor = 'move';
            renderTextObjects();
            return;
        }

        if (textRotating && selectedText) {
            const screen = imageToScreen(selectedText.x, selectedText.y);
            const cx = screen.x + (selectedText.boxWidth * zoom) / 2;
            const cy = screen.y + (selectedText.boxHeight * zoom) / 2;
            const angle = Math.atan2(pt.y - cy, pt.x - cx);
            selectedText.rotation = textRotateStart.startRotation +
                (angle - textRotateStart.startAngle) * (180 / Math.PI);
            textCanvas.style.cursor = 'grab';
            renderTextObjects();
            return;
        }

        if (textResizing && selectedText) {
            // Project screen delta onto the object's local axes (accounting for rotation)
            const sdx = pt.x - textResizeStart.px;
            const sdy = pt.y - textResizeStart.py;
            const rad = (selectedText.rotation * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            // localDx: component along local x-axis (image pixels)
            // localDy: component along local y-axis (image pixels)
            const localDx = (sdx * cos + sdy * sin) / zoom;
            const localDy = (-sdx * sin + sdy * cos) / zoom;
            const minBox = 30;

            switch (textResizeEdge) {
                case 'right':
                    selectedText.boxWidth = Math.max(minBox, textResizeStart.boxWidth + localDx);
                    computeLines(selectedText);
                    textCanvas.style.cursor = 'ew-resize';
                    break;
                case 'left':
                    selectedText.x = textResizeStart.ox + localDx;
                    selectedText.boxWidth = Math.max(minBox, textResizeStart.boxWidth - localDx);
                    computeLines(selectedText);
                    textCanvas.style.cursor = 'ew-resize';
                    break;
                case 'bottom':
                    selectedText.boxHeight = Math.max(minBox, textResizeStart.boxHeight + localDy);
                    textCanvas.style.cursor = 'ns-resize';
                    break;
                case 'top':
                    selectedText.y = textResizeStart.oy + localDy;
                    selectedText.boxHeight = Math.max(minBox, textResizeStart.boxHeight - localDy);
                    textCanvas.style.cursor = 'ns-resize';
                    break;
            }
            renderTextObjects();
            return;
        }

        // Hover cursor update
        if (selectedText) {
            if (hitTestRotationHandle(selectedText, pt)) {
                textCanvas.style.cursor = 'grab';
                return;
            }
            const edge = hitTestEdgeHandle(selectedText, pt);
            if (edge) {
                textCanvas.style.cursor = (edge === 'top' || edge === 'bottom') ? 'ns-resize' : 'ew-resize';
                return;
            }
        }
        for (let i = textObjects.length - 1; i >= 0; i--) {
            if (hitTestTextScreen(textObjects[i], pt)) {
                textCanvas.style.cursor = 'move';
                return;
            }
        }
        textCanvas.style.cursor = 'default';
    }

    function textPointerUp() {
        const wasDragging = textDragActive || textRotating || textResizing;
        textDragActive = false;
        textRotating = false;
        textResizing = false;
        textDragStart = null;
        textRotateStart = null;
        textResizeStart = null;
        if (selectedText && wasDragging) {
            showTextToolbar();
        }
        renderTextObjects();
    }

    // ========== TEXT MODAL ==========
    function openTextModal(obj) {
        if (textModalOpen) return;
        textModalOpen = true;
        selectedText = obj;
        const savedText = obj.text;

        // Create dim overlay
        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'text-modal-overlay';

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'text-modal';

        const textarea = document.createElement('textarea');
        textarea.value = obj.text;
        textarea.setAttribute('dir', 'auto');
        textarea.setAttribute('placeholder', 'Enter text...');

        const btns = document.createElement('div');
        btns.className = 'text-modal-btns';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'text-modal-cancel';
        cancelBtn.textContent = 'Cancel';

        const doneBtn = document.createElement('button');
        doneBtn.className = 'text-modal-done';
        doneBtn.textContent = 'Done';

        btns.appendChild(cancelBtn);
        btns.appendChild(doneBtn);
        modal.appendChild(textarea);
        modal.appendChild(btns);
        modalOverlay.appendChild(modal);
        document.body.appendChild(modalOverlay);

        // Focus textarea
        requestAnimationFrame(() => textarea.focus());
        if ('ontouchstart' in window) {
            setTimeout(() => textarea.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
        }

        // Done handler
        function doDone() {
            obj.text = textarea.value;
            if (!obj.text.trim()) {
                // Remove empty text objects
                textObjects = textObjects.filter(o => o !== obj);
                if (selectedText === obj) selectedText = null;
            } else {
                computeLines(obj);
                obj.boxHeight = obj._h; // auto-fit box to text
            }
            closeModal();
            showTextToolbar();
            renderTextObjects();
        }

        // Cancel handler
        function doCancel() {
            if (savedText === '' && !obj.text) {
                // New object with no text — remove it
                textObjects = textObjects.filter(o => o !== obj);
                if (selectedText === obj) selectedText = null;
            } else {
                obj.text = savedText;
                computeLines(obj);
                obj.boxHeight = obj._h; // auto-fit box to text
            }
            closeModal();
            if (selectedText) showTextToolbar();
            renderTextObjects();
        }

        function closeModal() {
            textModalOpen = false;
            modalOverlay.remove();
        }

        doneBtn.addEventListener('click', doDone);
        cancelBtn.addEventListener('click', doCancel);

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doDone(); }
            if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
        });

        // Prevent modal clicks from reaching canvas
        modalOverlay.addEventListener('pointerdown', e => e.stopPropagation());
        modalOverlay.addEventListener('touchstart', e => e.stopPropagation());
    }

    function commitTextModal() {
        // If modal is open, close it (text is already saved in the object)
        const modalOverlay = document.querySelector('.text-modal-overlay');
        if (modalOverlay) {
            textModalOpen = false;
            modalOverlay.remove();
        }
    }

    // ========== TEXT RENDERING ==========
    function renderTextObjects() {
        tctx.clearRect(0, 0, textCanvas.width, textCanvas.height);

        if (currentTool !== 'text') return;

        for (const obj of textObjects) {
            if (!obj.text) continue;
            computeLines(obj);
            const screen = imageToScreen(obj.x, obj.y);

            tctx.save();
            tctx.translate(screen.x, screen.y);
            tctx.rotate((obj.rotation * Math.PI) / 180);

            // Draw text
            tctx.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? 'bold ' : ''}${obj.fontSize * zoom}px ${obj.fontFamily}`;
            tctx.fillStyle = obj.color;
            tctx.textAlign = obj.align;
            tctx.textBaseline = 'top';
            const startX = obj.align === 'center' ? (obj.boxWidth * zoom) / 2 :
                           obj.align === 'right' ? obj.boxWidth * zoom : 0;
            obj._lines.forEach((line, i) => {
                tctx.fillText(line, startX, i * obj.fontSize * obj.lineHeight * zoom);
            });

            // Draw selection box and handles only when selected and not dragging
            if (obj === selectedText && !textDragActive && !textRotating && !textResizing) {
                const w = obj.boxWidth * zoom;
                const h = obj.boxHeight * zoom;

                // Dashed selection border
                tctx.strokeStyle = '#4f9eff';
                tctx.lineWidth = 1.5;
                tctx.setLineDash([5, 3]);
                tctx.strokeRect(0, 0, w, h);
                tctx.setLineDash([]);

                // Edge handles — small filled rectangles
                // Top handle: wide and short (horizontal bar)
                tctx.fillStyle = '#4f9eff';
                tctx.strokeStyle = '#ffffff';
                tctx.lineWidth = 1.5;
                // Top center
                tctx.fillRect(w / 2 - 12, -5, 24, 10);
                tctx.strokeRect(w / 2 - 12, -5, 24, 10);
                // Bottom center
                tctx.fillRect(w / 2 - 12, h - 5, 24, 10);
                tctx.strokeRect(w / 2 - 12, h - 5, 24, 10);
                // Left center
                tctx.fillRect(-5, h / 2 - 12, 10, 24);
                tctx.strokeRect(-5, h / 2 - 12, 10, 24);
                // Right center
                tctx.fillRect(w - 5, h / 2 - 12, 10, 24);
                tctx.strokeRect(w - 5, h / 2 - 12, 10, 24);

                // Rotation handle — line extending below bottom-center handle
                tctx.beginPath();
                tctx.moveTo(w / 2, h + 5);
                tctx.lineTo(w / 2, h + 29);
                tctx.strokeStyle = '#4f9eff';
                tctx.lineWidth = 1.5;
                tctx.stroke();
                tctx.beginPath();
                tctx.arc(w / 2, h + 37, 8, 0, Math.PI * 2);
                tctx.fillStyle = '#4f9eff';
                tctx.fill();
            }

            tctx.restore();
        }
    }

    // ========== TEXT TOOLBAR ==========
    function showTextToolbar() {
        if (!selectedText || textModalOpen) return;
        textToolbar.classList.remove('hidden');
        updateTextToolbarValues();
    }

    function hideTextToolbar() {
        textToolbar.classList.add('hidden');
    }

    function updateTextToolbarValues() {
        if (!selectedText) return;
        $('tt-size-val').textContent = selectedText.fontSize;
        $('tt-color').value = selectedText.color;
        $('tt-bold').classList.toggle('on', selectedText.bold);
        $('tt-italic').classList.toggle('on', selectedText.italic);
        $('tt-line-height').value = Math.round(selectedText.lineHeight * 10);
        // Update alignment buttons
        document.querySelectorAll('.tt-align').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.align === selectedText.align);
        });
    }

    function setupTextToolbar() {
        // Font size +/-
        $('tt-size-down').addEventListener('click', () => {
            if (!selectedText) return;
            selectedText.fontSize = Math.max(6, selectedText.fontSize - 2);
            computeLines(selectedText);
            selectedText.boxHeight = selectedText._h;
            updateTextToolbarValues();
            renderTextObjects();
        });
        $('tt-size-up').addEventListener('click', () => {
            if (!selectedText) return;
            selectedText.fontSize = Math.min(200, selectedText.fontSize + 2);
            computeLines(selectedText);
            selectedText.boxHeight = selectedText._h;
            updateTextToolbarValues();
            renderTextObjects();
        });

        // Color
        $('tt-color').addEventListener('input', e => {
            if (!selectedText) return;
            selectedText.color = e.target.value;
            renderTextObjects();
        });

        // Bold
        $('tt-bold').addEventListener('click', () => {
            if (!selectedText) return;
            selectedText.bold = !selectedText.bold;
            computeLines(selectedText);
            selectedText.boxHeight = selectedText._h;
            updateTextToolbarValues();
            renderTextObjects();
        });

        // Italic
        $('tt-italic').addEventListener('click', () => {
            if (!selectedText) return;
            selectedText.italic = !selectedText.italic;
            computeLines(selectedText);
            selectedText.boxHeight = selectedText._h;
            updateTextToolbarValues();
            renderTextObjects();
        });

        // Alignment
        document.querySelectorAll('.tt-align').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!selectedText) return;
                selectedText.align = btn.dataset.align;
                updateTextToolbarValues();
                renderTextObjects();
            });
        });

        // Line height
        $('tt-line-height').addEventListener('input', e => {
            if (!selectedText) return;
            selectedText.lineHeight = +e.target.value / 10;
            computeLines(selectedText);
            selectedText.boxHeight = selectedText._h;
            renderTextObjects();
        });

        // Add Text button
        $('add-text-btn').addEventListener('click', () => {
            if (!img) return;
            // Create new text at center of visible area
            const cx = (area.clientWidth / 2 - panX) / zoom;
            const cy = (area.clientHeight / 2 - panY) / zoom;
            const obj = createTextObject(cx, cy);
            textObjects.push(obj);
            selectedText = obj;
            openTextModal(obj);
            renderTextObjects();
        });
    }

    // ========== FLATTEN TEXT ==========
    function flattenText() {
        const layer = getActiveLayer();
        if (!layer || textObjects.length === 0) return;
        saveState();
        for (const obj of textObjects) {
            if (!obj.text) continue;
            computeLines(obj);
            layer.ctx.save();
            layer.ctx.translate(obj.x, obj.y);
            layer.ctx.rotate((obj.rotation * Math.PI) / 180);
            layer.ctx.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? 'bold ' : ''}${obj.fontSize}px ${obj.fontFamily}`;
            layer.ctx.fillStyle = obj.color || '#000000';
            layer.ctx.textAlign = obj.align;
            layer.ctx.textBaseline = 'top';
            const startX = obj.align === 'center' ? obj.boxWidth / 2 :
                           obj.align === 'right' ? obj.boxWidth : 0;
            obj._lines.forEach((line, i) => {
                layer.ctx.fillText(line, startX, i * obj.fontSize * obj.lineHeight);
            });
            layer.ctx.restore();
        }
        textObjects = [];
        selectedText = null;
        hideTextToolbar();
        tctx.clearRect(0, 0, textCanvas.width, textCanvas.height);
        renderAll();
        updateActiveThumbnail();
    }

    // ========== POINTER EVENTS ==========
    function setupPointer() {
        overlay.addEventListener('pointerdown', onPointerDown);
        overlay.addEventListener('dblclick', onDblClick);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);

        // Text canvas pointer events
        textCanvas.addEventListener('pointerdown', onTextPointerDown);
        window.addEventListener('pointermove', onTextPointerMove);
        window.addEventListener('pointerup', onTextPointerUp);
    }

    function onPointerDown(e) {
        if (!img || e.pointerType === 'touch') return;
        if (currentTool === 'text') return; // handled by text canvas
        e.preventDefault();
        overlay.setPointerCapture(e.pointerId);
        pointerDown = true;
        const pt = screenToImg(e.clientX, e.clientY);
        toolDown(pt);
    }

    function onPointerMove(e) {
        if (!img || e.pointerType === 'touch' || !pointerDown) return;
        if (currentTool === 'text') return;
        const pt = screenToImg(e.clientX, e.clientY);
        toolMove(pt);
    }

    function onPointerUp(e) {
        if (e.pointerType === 'touch') return;
        if (currentTool === 'text') return;
        pointerDown = false;
        toolUp();
    }

    function onDblClick(e) {
        if (!img || currentTool !== 'text' || textModalOpen) return;
        const pt = getAreaScreenPt(e);
        for (let i = textObjects.length - 1; i >= 0; i--) {
            if (hitTestTextScreen(textObjects[i], pt)) {
                selectedText = textObjects[i];
                openTextModal(textObjects[i]);
                return;
            }
        }
    }

    // Text canvas pointer handlers
    let textPointerDownActive = false;

    function onTextPointerDown(e) {
        if (!img || currentTool !== 'text' || e.pointerType === 'touch') return;
        e.preventDefault();
        e.stopPropagation();
        textCanvas.setPointerCapture(e.pointerId);
        textPointerDownActive = true;
        const pt = getAreaScreenPt(e);
        textPointerDown(pt);
    }

    function onTextPointerMove(e) {
        if (!textPointerDownActive || currentTool !== 'text') return;
        const pt = getAreaScreenPt(e);
        textPointerMove(pt);
    }

    function onTextPointerUp(e) {
        if (!textPointerDownActive) return;
        textPointerDownActive = false;
        textPointerUp();
    }

    // ========== TOUCH EVENTS ==========
    function setupTouch() {
        area.addEventListener('touchstart', onTouchStart, { passive: false });
        area.addEventListener('touchmove', onTouchMove, { passive: false });
        area.addEventListener('touchend', onTouchEnd, { passive: false });
        area.addEventListener('touchcancel', onTouchEnd, { passive: false });
    }

    function onTouchStart(e) {
        if (!img) return;
        e.preventDefault();
        touchCache = Array.from(e.touches);
        if (touchCache.length === 1) {
            if (currentTool === 'text' && !textModalOpen) {
                const t = touchCache[0];
                const rect = area.getBoundingClientRect();
                const screenPt = { x: t.clientX - rect.left, y: t.clientY - rect.top };
                textPointerDown(screenPt);
                touchStartPt = { cx: t.clientX, cy: t.clientY };
                return;
            }
            touchPending = true;
            const t = touchCache[0];
            touchStartPt = { cx: t.clientX, cy: t.clientY };
        } else if (touchCache.length === 2) {
            touchPending = false;
            drawing = false;
            selActive = false;
            textDragActive = false;
            textRotating = false;
            textResizing = false;
            isPinching = true;
            lastPinchDist = pinchDist(touchCache);
            lastPinchCenter = pinchCenter(touchCache);
        }
    }

    function onTouchMove(e) {
        if (!img) return;
        e.preventDefault();
        touchCache = Array.from(e.touches);
        if (touchCache.length === 1 && !isPinching) {
            const t = touchCache[0];
            if (currentTool === 'text' && !textModalOpen) {
                const rect = area.getBoundingClientRect();
                const screenPt = { x: t.clientX - rect.left, y: t.clientY - rect.top };
                textPointerMove(screenPt);
                return;
            }
            if (touchPending) {
                const dx = t.clientX - touchStartPt.cx;
                const dy = t.clientY - touchStartPt.cy;
                if (Math.hypot(dx, dy) < TOUCH_THRESHOLD) return;
                touchPending = false;
                toolDown(screenToImg(touchStartPt.cx, touchStartPt.cy));
            }
            toolMove(screenToImg(t.clientX, t.clientY));
        } else if (touchCache.length === 2 && isPinching) {
            const dist = pinchDist(touchCache);
            const center = pinchCenter(touchCache);
            const scale = dist / lastPinchDist;
            const newZoom = clamp(zoom * scale, 0.05, 20);
            const rect = area.getBoundingClientRect();
            const cx = center.x - rect.left;
            const cy = center.y - rect.top;
            panX = cx - (cx - panX) * (newZoom / zoom) + (center.x - lastPinchCenter.x);
            panY = cy - (cy - panY) * (newZoom / zoom) + (center.y - lastPinchCenter.y);
            zoom = newZoom;
            lastPinchDist = dist;
            lastPinchCenter = center;
            updateZoomDisplay();
            zoomRender();
        }
    }

    function onTouchEnd(e) {
        e.preventDefault();
        touchCache = Array.from(e.touches);
        if (touchCache.length < 2) { isPinching = false; }
        if (touchCache.length === 0) {
            if (currentTool === 'text' && !textModalOpen) {
                textPointerUp();
                return;
            }
            if (touchPending) {
                touchPending = false;
                toolDown(screenToImg(touchStartPt.cx, touchStartPt.cy));
                toolUp();
            } else {
                toolUp();
            }
        }
    }

    function pinchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
    function pinchCenter(t) { return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 }; }

    // ========== TOOL DISPATCH ==========
    function toolDown(pt) {
        switch (currentTool) {
            case 'select': selectDown(pt); break;
            case 'brush': brushDown(pt); break;
            case 'eraser': eraserDown(pt); break;
            case 'eyedropper': eyedropperDown(pt); break;
            case 'fill': fillDown(pt); break;
            case 'crop': cropDown(pt); break;
        }
    }

    function toolMove(pt) {
        switch (currentTool) {
            case 'select': selectMove(pt); break;
            case 'brush': brushMove(pt); break;
            case 'eraser': eraserMove(pt); break;
            case 'crop': cropMove(pt); break;
        }
    }

    function toolUp() {
        switch (currentTool) {
            case 'select': selectUp(); break;
            case 'brush': brushUp(); break;
            case 'eraser': eraserUp(); break;
            case 'crop': cropUp(); break;
        }
    }

    // ========== TOOL 1: SELECT ==========
    function selectDown(pt) {
        sel = null;
        selActive = true;
        selStart = { x: pt.x, y: pt.y };
        showOptSelect(false);
        renderOverlay();
    }

    function selectMove(pt) {
        if (!selActive) return;
        sel = normalizeRect(selStart.x, selStart.y, pt.x, pt.y);
        renderOverlay();
    }

    function selectUp() {
        selActive = false;
        if (sel && sel.w > 2 && sel.h > 2) {
            showOptSelect(true);
        } else {
            sel = null;
            showOptSelect(false);
        }
        renderOverlay();
    }

    function showOptSelect(show) {
        $('opt-select').classList.toggle('active', show);
    }

    // ========== TOOL 2: BRUSH ==========
    function brushDown(pt) {
        const layer = getActiveLayer();
        if (!layer || layer.locked) return;
        saveState();
        drawing = true;
        lastPt = pt;
        drawStroke(layer.ctx, pt, pt, brushSize, brushColor, brushOpacity, brushHardness, brushFlow);
        renderAll();
    }

    function brushMove(pt) {
        if (!drawing) return;
        const layer = getActiveLayer();
        if (!layer) return;
        drawStroke(layer.ctx, lastPt, pt, brushSize, brushColor, brushOpacity, brushHardness, brushFlow);
        lastPt = pt;
        renderAll();
    }

    function brushUp() {
        drawing = false;
        lastPt = null;
        updateActiveThumbnail();
    }

    // ========== TOOL 3: ERASER ==========
    function eraserDown(pt) {
        const layer = getActiveLayer();
        if (!layer || layer.locked) return;
        saveState();
        drawing = true;
        lastPt = pt;
        eraseStroke(layer.ctx, pt, pt, eraserSize);
        renderAll();
    }

    function eraserMove(pt) {
        if (!drawing) return;
        const layer = getActiveLayer();
        if (!layer) return;
        eraseStroke(layer.ctx, lastPt, pt, eraserSize);
        lastPt = pt;
        renderAll();
    }

    function eraserUp() {
        drawing = false;
        lastPt = null;
        updateActiveThumbnail();
    }

    // ========== TOOL 5: EYEDROPPER ==========
    function eyedropperDown(pt) {
        compositeAll();
        const x = Math.floor(clamp(pt.x, 0, off.width - 1));
        const y = Math.floor(clamp(pt.y, 0, off.height - 1));
        const px = offCtx.getImageData(x, y, 1, 1).data;
        const hex = rgbToHex(px[0], px[1], px[2]);
        applyColor(hex, 'eyedropper');
    }

    // ========== TOOL 6: FILL ==========
    function fillDown(pt) {
        const layer = getActiveLayer();
        if (!layer || layer.locked) return;
        const x = Math.floor(clamp(pt.x, 0, layer.canvas.width - 1));
        const y = Math.floor(clamp(pt.y, 0, layer.canvas.height - 1));
        const targetColor = layer.ctx.getImageData(x, y, 1, 1).data;
        const fc = hexToRgb(fillColor);
        if (fc[0] === targetColor[0] && fc[1] === targetColor[1] && fc[2] === targetColor[2]) return;
        saveState();
        floodFill(layer.ctx, layer.canvas.width, layer.canvas.height, x, y, targetColor, fc, fillTolerance);
        renderAll();
        updateActiveThumbnail();
    }

    function floodFill(context, w, h, startX, startY, target, fill, tolerance) {
        const imageData = context.getImageData(0, 0, w, h);
        const data = imageData.data;
        const visited = new Uint8Array(w * h);
        const stack = [[startX, startY]];
        const tR = target[0], tG = target[1], tB = target[2], tA = target[3];
        const fR = fill[0], fG = fill[1], fB = fill[2];

        while (stack.length > 0) {
            const [cx, cy] = stack.pop();
            const idx = cy * w + cx;
            if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
            if (visited[idx]) continue;
            const pi = idx * 4;
            const dr = data[pi] - tR;
            const dg = data[pi + 1] - tG;
            const db = data[pi + 2] - tB;
            const da = data[pi + 3] - tA;
            if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) + Math.abs(da) > tolerance * 4) continue;
            visited[idx] = 1;
            data[pi] = fR;
            data[pi + 1] = fG;
            data[pi + 2] = fB;
            data[pi + 3] = 255;
            stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
        context.putImageData(imageData, 0, 0);
    }

    // ========== TOOL 7: CROP ==========
    function cropDown(pt) {
        cropSel = null;
        selActive = true;
        selStart = { x: pt.x, y: pt.y };
        renderOverlay();
    }

    function cropMove(pt) {
        if (!selActive) return;
        cropSel = normalizeRect(selStart.x, selStart.y, pt.x, pt.y);
        renderOverlay();
    }

    function cropUp() {
        selActive = false;
        if (!cropSel || cropSel.w < 5 || cropSel.h < 5) {
            cropSel = null;
            renderOverlay();
        }
    }

    function applyCrop() {
        if (!cropSel) return;
        const { x, y, w, h } = cropSel;
        const sx = Math.max(0, Math.floor(x));
        const sy = Math.max(0, Math.floor(y));
        const sw = Math.min(off.width - sx, Math.ceil(w));
        const sh = Math.min(off.height - sy, Math.ceil(h));

        saveAllLayerStates();

        for (const layer of layers) {
            const imageData = layer.ctx.getImageData(sx, sy, sw, sh);
            layer.canvas.width = sw;
            layer.canvas.height = sh;
            layer.ctx.putImageData(imageData, 0, 0);
        }

        off.width = sw;
        off.height = sh;

        img = new Image();
        img.width = sw;
        img.height = sh;

        cropSel = null;
        syncCanvasSize();
        fitToView();
        renderLayerPanel();
    }

    function cancelCrop() {
        cropSel = null;
        renderOverlay();
    }

    // ========== ROTATE / FLIP ==========
    function rotateCanvas(degrees) {
        saveAllLayerStates();

        const w = off.width, h = off.height;
        const newW = degrees % 180 === 0 ? w : h;
        const newH = degrees % 180 === 0 ? h : w;

        for (const layer of layers) {
            const temp = document.createElement('canvas');
            temp.width = newW;
            temp.height = newH;
            const tctx = temp.getContext('2d');
            tctx.translate(newW / 2, newH / 2);
            tctx.rotate(degrees * Math.PI / 180);
            tctx.drawImage(layer.canvas, -w / 2, -h / 2);
            layer.canvas.width = newW;
            layer.canvas.height = newH;
            layer.ctx.drawImage(temp, 0, 0);
        }

        off.width = newW;
        off.height = newH;

        img = new Image();
        img.width = newW;
        img.height = newH;

        syncCanvasSize();
        fitToView();
        renderLayerPanel();
    }

    function flipCanvas(horizontal) {
        saveAllLayerStates();

        for (const layer of layers) {
            const temp = document.createElement('canvas');
            temp.width = layer.canvas.width;
            temp.height = layer.canvas.height;
            const tctx = temp.getContext('2d');
            if (horizontal) {
                tctx.translate(layer.canvas.width, 0);
                tctx.scale(-1, 1);
            } else {
                tctx.translate(0, layer.canvas.height);
                tctx.scale(1, -1);
            }
            tctx.drawImage(layer.canvas, 0, 0);
            layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
            layer.ctx.drawImage(temp, 0, 0);
        }

        renderAll();
        renderLayerPanel();
    }

    // ========== DRAWING HELPERS ==========
    function makeBrushStamp(size, color, hardness) {
        const r = size / 2;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const cx = c.getContext('2d');
        if (hardness >= 100) {
            cx.fillStyle = color;
            cx.beginPath();
            cx.arc(r, r, r, 0, Math.PI * 2);
            cx.fill();
        } else {
            const grad = cx.createRadialGradient(r, r, 0, r, r, r);
            const hardR = hardness / 100;
            grad.addColorStop(0, color);
            grad.addColorStop(hardR, color);
            grad.addColorStop(1, 'transparent');
            cx.fillStyle = grad;
            cx.beginPath();
            cx.arc(r, r, r, 0, Math.PI * 2);
            cx.fill();
        }
        return c;
    }

    function drawStroke(context, from, to, size, color, opacity, hardness, flow) {
        if (hardness === undefined) hardness = 100;
        if (flow === undefined) flow = 100;
        context.save();
        context.globalAlpha = (opacity / 100) * (flow / 100);
        if (hardness >= 100) {
            context.strokeStyle = color;
            context.lineWidth = size;
            context.lineCap = 'round';
            context.lineJoin = 'round';
            context.beginPath();
            context.moveTo(from.x, from.y);
            context.lineTo(to.x, to.y);
            context.stroke();
        } else {
            const stamp = makeBrushStamp(size, color, hardness);
            const r = size / 2;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const dist = Math.hypot(dx, dy);
            const steps = Math.max(1, Math.ceil(dist / (size * 0.25)));
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const x = from.x + dx * t - r;
                const y = from.y + dy * t - r;
                context.drawImage(stamp, x, y);
            }
        }
        context.restore();
    }

    function eraseStroke(context, from, to, size) {
        context.save();
        context.globalCompositeOperation = 'destination-out';
        context.strokeStyle = 'rgba(0,0,0,1)';
        context.lineWidth = size;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
        context.restore();
    }

    // ========== UNDO / REDO ==========
    function saveState() {
        const layer = getActiveLayer();
        if (!layer) return;
        const c = layer.canvas;
        layer.undoStack.push(layer.ctx.getImageData(0, 0, c.width, c.height));
        if (layer.undoStack.length > MAX_UNDO) layer.undoStack.shift();
        layer.redoStack = [];
        updateUndoButtons();
    }

    function undo() {
        const layer = getActiveLayer();
        if (!layer || layer.undoStack.length === 0) return;
        const c = layer.canvas;
        layer.redoStack.push(layer.ctx.getImageData(0, 0, c.width, c.height));
        layer.ctx.putImageData(layer.undoStack.pop(), 0, 0);
        sel = null;
        cropSel = null;
        showOptSelect(false);
        renderAll();
        updateUndoButtons();
        updateActiveThumbnail();
    }

    function redo() {
        const layer = getActiveLayer();
        if (!layer || layer.redoStack.length === 0) return;
        const c = layer.canvas;
        layer.undoStack.push(layer.ctx.getImageData(0, 0, c.width, c.height));
        layer.ctx.putImageData(layer.redoStack.pop(), 0, 0);
        sel = null;
        cropSel = null;
        showOptSelect(false);
        renderAll();
        updateUndoButtons();
        updateActiveThumbnail();
    }

    function updateUndoButtons() {
        const layer = getActiveLayer();
        undoBtn.disabled = !layer || layer.undoStack.length === 0;
        redoBtn.disabled = !layer || layer.redoStack.length === 0;
    }

    // ========== ZOOM ==========
    function setZoom(newZoom, cx, cy) {
        if (!img) return;
        const oldZ = zoom;
        zoom = clamp(newZoom, 0.05, 20);
        if (cx !== undefined) {
            panX = cx - (cx - panX) * (zoom / oldZ);
            panY = cy - (cy - panY) * (zoom / oldZ);
        } else {
            const rcx = area.clientWidth / 2;
            const rcy = area.clientHeight / 2;
            panX = rcx - (rcx - panX) * (zoom / oldZ);
            panY = rcy - (rcy - panY) * (zoom / oldZ);
        }
        updateZoomDisplay();
        zoomRender();
    }

    function updateZoomDisplay() {
        zoomDisplay.textContent = Math.round(zoom * 100) + '%';
    }

    // ========== EXPORT ==========
    function exportPNG() {
        if (!off) return;
        compositeAll();
        const link = document.createElement('a');
        link.download = fileName + '_edited.png';
        link.href = off.toDataURL('image/png');
        link.click();
    }

    // ========== TOOL SELECTION ==========
    function setupToolButtons() {
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => selectTool(btn.dataset.tool));
        });
    }

    function selectTool(tool) {
        prevTool = currentTool;
        currentTool = tool;

        document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
        area.setAttribute('data-tool', tool);

        brushPanel.classList.remove('open');
        colorPanel.classList.remove('open');

        if (tool !== 'select') {
            sel = null;
            showOptSelect(false);
        }
        if (tool !== 'crop') {
            cropSel = null;
        }
        if (tool !== 'text') {
            if (textModalOpen) commitTextModal();
            flattenText();
            selectedText = null;
            textDragActive = false;
            textRotating = false;
            textResizing = false;
            hideTextToolbar();
            textCanvas.classList.remove('text-active');
        } else {
            textCanvas.classList.add('text-active');
        }

        showToolOptions(tool);
        renderOverlay();
        renderTextObjects();
    }

    function showToolOptions(tool) {
        document.querySelectorAll('.opt-group').forEach(g => {
            g.classList.toggle('active', g.dataset.tools && g.dataset.tools.split(',').includes(tool));
        });
    }

    // ========== OPTIONS SETUP ==========
    function setupOptions() {
        setupBrushPanel();
        setupColorPanel();
        setupTextToolbar();

        // Eraser
        $('eraser-size').addEventListener('input', e => { eraserSize = +e.target.value; $('eraser-size-val').textContent = eraserSize; });

        // Select actions
        $('sel-erase-btn').addEventListener('click', () => {
            const layer = getActiveLayer();
            if (!sel || !layer || layer.locked) return;
            saveState();
            layer.ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
            sel = null;
            showOptSelect(false);
            renderAll();
            updateActiveThumbnail();
        });
        $('sel-fill-btn').addEventListener('click', () => {
            const layer = getActiveLayer();
            if (!sel || !layer || layer.locked) return;
            saveState();
            layer.ctx.fillStyle = '#ffffff';
            layer.ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
            sel = null;
            showOptSelect(false);
            renderAll();
            updateActiveThumbnail();
        });
        $('sel-cancel-btn').addEventListener('click', () => { sel = null; showOptSelect(false); renderOverlay(); });

        // Fill
        $('fill-color').addEventListener('input', e => { fillColor = e.target.value; });
        $('fill-tolerance').addEventListener('input', e => { fillTolerance = +e.target.value; $('fill-tolerance-val').textContent = fillTolerance; });

        // Crop
        $('crop-apply-btn').addEventListener('click', applyCrop);
        $('crop-cancel-btn').addEventListener('click', cancelCrop);

        // Rotate
        $('rotate-ccw-btn').addEventListener('click', () => rotateCanvas(-90));
        $('rotate-cw-btn').addEventListener('click', () => rotateCanvas(90));
        $('flip-h-btn').addEventListener('click', () => flipCanvas(true));
        $('flip-v-btn').addEventListener('click', () => flipCanvas(false));
    }

    // ========== LAYER PANEL ==========
    function setupLayerPanel() {
        layerBtn.addEventListener('click', e => {
            e.stopPropagation();
            layerPanel.classList.toggle('open');
        });

        document.addEventListener('click', e => {
            if (layerPanel.classList.contains('open') &&
                !layerPanel.contains(e.target) &&
                !layerBtn.contains(e.target)) {
                layerPanel.classList.remove('open');
            }
        });

        lpAddBtn.addEventListener('click', () => addLayer());

        lpDupBtn.addEventListener('click', () => {
            if (activeLayerId !== null) duplicateLayer(activeLayerId);
        });

        lpDelBtn.addEventListener('click', () => {
            if (activeLayerId !== null) deleteLayer(activeLayerId);
        });

        lpMergeBtn.addEventListener('click', () => {
            if (activeLayerId !== null) mergeDown(activeLayerId);
        });

        lpOpacity.addEventListener('input', () => {
            const layer = getActiveLayer();
            if (!layer) return;
            layer.opacity = +lpOpacity.value;
            lpOpacityVal.textContent = lpOpacity.value + '%';
            renderAll();
        });

        lpBlendMode.addEventListener('change', () => {
            const layer = getActiveLayer();
            if (!layer) return;
            layer.blendMode = lpBlendMode.value;
            renderAll();
        });
    }

    function renderLayerPanel() {
        if (!lpList) return;
        lpList.innerHTML = '';

        for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i];
            const row = document.createElement('div');
            row.className = 'lp-layer' + (layer.id === activeLayerId ? ' active' : '');
            row.dataset.id = layer.id;
            row.dataset.idx = i;

            const thumbWrap = document.createElement('div');
            thumbWrap.className = 'lp-thumb';
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = 36;
            thumbCanvas.height = 28;
            const tctx = thumbCanvas.getContext('2d');
            tctx.drawImage(layer.canvas, 0, 0, 36, 28);
            thumbWrap.appendChild(thumbCanvas);
            row.appendChild(thumbWrap);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'lp-name';
            nameSpan.textContent = layer.name;
            row.appendChild(nameSpan);

            const visBtn = document.createElement('button');
            visBtn.className = 'lp-icon' + (layer.visible ? '' : ' hidden-state');
            visBtn.title = 'Toggle visibility';
            visBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
            visBtn.addEventListener('click', e => {
                e.stopPropagation();
                layer.visible = !layer.visible;
                renderLayerPanel();
                renderAll();
            });
            row.appendChild(visBtn);

            const lockBtn = document.createElement('button');
            lockBtn.className = 'lp-icon' + (layer.locked ? ' active' : '');
            lockBtn.title = 'Toggle lock';
            lockBtn.innerHTML = layer.locked
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 019.9-1"/></svg>';
            lockBtn.addEventListener('click', e => {
                e.stopPropagation();
                layer.locked = !layer.locked;
                renderLayerPanel();
            });
            row.appendChild(lockBtn);

            row.addEventListener('click', () => {
                if (layer.id !== activeLayerId) setActiveLayer(layer.id);
            });

            nameSpan.addEventListener('dblclick', e => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'lp-name-input';
                input.value = layer.name;
                nameSpan.replaceWith(input);
                input.focus();
                input.select();
                const finish = () => {
                    layer.name = input.value.trim() || layer.name;
                    renderLayerPanel();
                };
                input.addEventListener('blur', finish);
                input.addEventListener('keydown', ev => {
                    if (ev.key === 'Enter') { ev.preventDefault(); finish(); }
                    if (ev.key === 'Escape') { ev.preventDefault(); renderLayerPanel(); }
                });
            });

            row.draggable = true;
            row.addEventListener('dragstart', e => {
                e.dataTransfer.setData('text/plain', i.toString());
                e.dataTransfer.effectAllowed = 'move';
                row.style.opacity = '0.4';
            });
            row.addEventListener('dragend', () => { row.style.opacity = ''; });
            row.addEventListener('dragover', e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                row.classList.add('drag-over');
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('drag-over');
            });
            row.addEventListener('drop', e => {
                e.preventDefault();
                row.classList.remove('drag-over');
                const fromIdx = +e.dataTransfer.getData('text/plain');
                const toIdx = +row.dataset.idx;
                if (fromIdx !== toIdx) moveLayer(fromIdx, toIdx);
            });

            lpList.appendChild(row);
        }

        const active = getActiveLayer();
        if (active) {
            lpOpacity.value = active.opacity;
            lpOpacityVal.textContent = active.opacity + '%';
            lpBlendMode.value = active.blendMode;
        }
    }

    function updateActiveThumbnail() {
        const layer = getActiveLayer();
        if (!layer) return;
        const row = lpList.querySelector(`.lp-layer[data-id="${layer.id}"]`);
        if (!row) return;
        const thumbCanvas = row.querySelector('.lp-thumb canvas');
        if (!thumbCanvas) return;
        const tctx = thumbCanvas.getContext('2d');
        tctx.clearRect(0, 0, 36, 28);
        tctx.drawImage(layer.canvas, 0, 0, 36, 28);
    }

    // ========== KEYBOARD ==========
    function setupKeyboard() {
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
            else if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }
            else if (e.key === 'v' || e.key === 'V') selectTool('select');
            else if (e.key === 'b' || e.key === 'B') selectTool('brush');
            else if (e.key === 'e' || e.key === 'E') selectTool('eraser');
            else if (e.key === 't' || e.key === 'T') selectTool('text');
            else if (e.key === 'i' || e.key === 'I') selectTool('eyedropper');
            else if (e.key === 'g' || e.key === 'G') selectTool('fill');
            else if (e.key === 'c' && !e.ctrlKey) selectTool('crop');
            else if (e.key === 'r' || e.key === 'R') selectTool('rotate');
            else if (e.key === '[') { brushSize = Math.max(1, brushSize - 2); brushSizeEl.value = brushSize; brushSizeVal.textContent = brushSize; updateBrushPreview(); }
            else if (e.key === ']') { brushSize = Math.min(100, brushSize + 2); brushSizeEl.value = brushSize; brushSizeVal.textContent = brushSize; updateBrushPreview(); }
            else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.15);
            else if (e.key === '-') setZoom(zoom / 1.15);
            else if (e.key === '0') fitToView();
            else if (e.key === 'Delete' || e.key === 'Backspace') {
                if (currentTool === 'text' && selectedText) {
                    textObjects = textObjects.filter(o => o !== selectedText);
                    selectedText = null;
                    hideTextToolbar();
                    renderTextObjects();
                }
            }
            else if (e.key === 'Escape') {
                if (currentTool === 'text' && selectedText) {
                    selectedText = null;
                    hideTextToolbar();
                    renderTextObjects();
                } else {
                    sel = null; cropSel = null; showOptSelect(false); renderOverlay();
                }
            }
        });

        area.addEventListener('wheel', e => {
            if (!img) return;
            e.preventDefault();
            const rect = area.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            setZoom(zoom * factor, cx, cy);
        }, { passive: false });
    }

    // ========== RESIZE ==========
    function setupResize() {
        window.addEventListener('resize', () => {
            if (img) {
                resizeTextCanvas();
                renderAll();
            }
        });

        undoBtn.addEventListener('click', undo);
        redoBtn.addEventListener('click', redo);
        fitBtn.addEventListener('click', fitToView);
        exportBtn.addEventListener('click', exportPNG);
    }

    // ========== UTILITIES ==========
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    function normalizeRect(x1, y1, x2, y2) {
        return {
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            w: Math.abs(x2 - x1),
            h: Math.abs(y2 - y1)
        };
    }

    function rgbToHex(r, g, b) {
        return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    }

    function hexToRgb(hex) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return [r, g, b, 255];
    }

    // ========== BRUSH PANEL ==========
    function setupBrushPanel() {
        brushTrigger.addEventListener('click', () => {
            brushPanel.classList.toggle('open');
        });

        document.addEventListener('click', e => {
            if (brushPanel.classList.contains('open') &&
                !brushPanel.contains(e.target) &&
                !brushTrigger.contains(e.target)) {
                brushPanel.classList.remove('open');
            }
        });

        brushSizeEl.addEventListener('input', e => {
            brushSize = +e.target.value;
            brushSizeVal.textContent = brushSize;
            updateBrushPreview();
        });

        brushHardnessEl.addEventListener('input', e => {
            brushHardness = +e.target.value;
            brushHardnessVal.textContent = brushHardness + '%';
            updateBrushPreview();
        });

        brushOpacityEl.addEventListener('input', e => {
            brushOpacity = +e.target.value;
            brushOpacityVal.textContent = brushOpacity + '%';
            updateBrushPreview();
        });

        brushFlowEl.addEventListener('input', e => {
            brushFlow = +e.target.value;
            brushFlowVal.textContent = brushFlow + '%';
            updateBrushPreview();
        });

        updateBrushPreview();
    }

    function updateBrushPreview() {
        const s = brushPreviewCanvas.width;
        brushPreviewCtx.clearRect(0, 0, s, s);
        const cs = 6;
        for (let y = 0; y < s; y += cs) {
            for (let x = 0; x < s; x += cs) {
                brushPreviewCtx.fillStyle = ((x + y) / cs) % 2 === 0 ? '#3a3a4a' : '#2a2a3a';
                brushPreviewCtx.fillRect(x, y, cs, cs);
            }
        }
        const previewSize = Math.min(brushSize, s - 4);
        const cx = s / 2, cy = s / 2, r = previewSize / 2;
        brushPreviewCtx.save();
        brushPreviewCtx.globalAlpha = brushOpacity / 100;
        if (brushHardness >= 100) {
            brushPreviewCtx.fillStyle = brushColor;
            brushPreviewCtx.beginPath();
            brushPreviewCtx.arc(cx, cy, r, 0, Math.PI * 2);
            brushPreviewCtx.fill();
        } else {
            const grad = brushPreviewCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
            const hardR = brushHardness / 100;
            grad.addColorStop(0, brushColor);
            grad.addColorStop(hardR, brushColor);
            grad.addColorStop(1, 'transparent');
            brushPreviewCtx.fillStyle = grad;
            brushPreviewCtx.beginPath();
            brushPreviewCtx.arc(cx, cy, r, 0, Math.PI * 2);
            brushPreviewCtx.fill();
        }
        brushPreviewCtx.restore();
    }

    // ========== COLOR PANEL ==========
    function setupColorPanel() {
        drawHueStrip();
        updateColorPanel('init');

        colorBtn.addEventListener('click', e => {
            e.stopPropagation();
            colorPanel.classList.toggle('open');
        });

        document.addEventListener('click', e => {
            if (colorPanel.classList.contains('open') &&
                !colorPanel.contains(e.target) &&
                !colorBtn.contains(e.target)) {
                colorPanel.classList.remove('open');
            }
        });

        setupGradientDrag();
        setupHueDrag();

        ['r', 'g', 'b'].forEach(ch => {
            const slider = $('cp-' + ch);
            const num = $('cp-' + ch + '-val');
            slider.addEventListener('input', () => {
                num.value = slider.value;
                const r = +$('cp-r').value, g = +$('cp-g').value, b = +$('cp-b').value;
                const [h, s, l] = rgbToHsl(r, g, b);
                cpHue = h; cpSat = s; cpLit = l;
                updateColorPanel('rgb');
            });
            num.addEventListener('input', () => {
                slider.value = num.value;
                slider.dispatchEvent(new Event('input'));
            });
        });

        ['h', 's', 'l'].forEach(ch => {
            const slider = $('cp-' + ch + '-slider');
            const num = $('cp-' + ch + '-val');
            slider.addEventListener('input', () => {
                num.value = slider.value;
                cpHue = +$('cp-h-slider').value;
                cpSat = +$('cp-s-slider').value;
                cpLit = +$('cp-l-slider').value;
                updateColorPanel('hsl');
            });
            num.addEventListener('input', () => {
                slider.value = num.value;
                slider.dispatchEvent(new Event('input'));
            });
        });

        cpHexInput.addEventListener('input', () => {
            const val = cpHexInput.value.replace(/[^0-9a-fA-F]/g, '');
            if (val.length === 6) {
                const hex = '#' + val;
                const [r, g, b] = hexToRgbArr(hex);
                const [h, s, l] = rgbToHsl(r, g, b);
                cpHue = h; cpSat = s; cpLit = l;
                updateColorPanel('hex');
            }
        });

        document.querySelectorAll('.cp-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.cp-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const mode = tab.dataset.mode;
                cpRGBSliders.classList.toggle('hidden', mode !== 'rgb');
                cpHSLSliders.classList.toggle('hidden', mode !== 'hsl');
            });
        });

        $('cp-add-palette').addEventListener('click', () => {
            const hex = brushColor;
            if (!savedPalette.includes(hex)) {
                savedPalette.push(hex);
                renderPalette();
            }
        });

        cpPalette.addEventListener('click', e => {
            const swatch = e.target.closest('.cp-swatch');
            if (!swatch || swatch.classList.contains('empty')) return;
            const color = swatch.dataset.color;
            if (e.shiftKey || e.ctrlKey) {
                savedPalette = savedPalette.filter(c => c !== color);
                renderPalette();
            } else {
                applyColor(color, 'palette');
            }
        });

        cpRecent.addEventListener('click', e => {
            const swatch = e.target.closest('.cp-swatch');
            if (!swatch) return;
            applyColor(swatch.dataset.color, 'recent');
        });

        $('cp-eyedropper').addEventListener('click', () => {
            selectTool('eyedropper');
            colorPanel.classList.remove('open');
        });

        renderPalette();
        renderRecent();
    }

    function drawGradientField() {
        const w = cpGradient.width, h = cpGradient.height;
        const ctx = cpGradientCtx;
        ctx.fillStyle = `hsl(${cpHue}, 100%, 50%)`;
        ctx.fillRect(0, 0, w, h);
        const whiteGrad = ctx.createLinearGradient(0, 0, w, 0);
        whiteGrad.addColorStop(0, 'rgba(255,255,255,1)');
        whiteGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = whiteGrad;
        ctx.fillRect(0, 0, w, h);
        const blackGrad = ctx.createLinearGradient(0, 0, 0, h);
        blackGrad.addColorStop(0, 'rgba(0,0,0,0)');
        blackGrad.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = blackGrad;
        ctx.fillRect(0, 0, w, h);
    }

    function drawHueStrip() {
        const w = cpHueEl.width, h = cpHueEl.height;
        const grad = cpHueCtx.createLinearGradient(0, 0, 0, h);
        for (let i = 0; i <= 360; i += 30) {
            grad.addColorStop(i / 360, `hsl(${i}, 100%, 50%)`);
        }
        cpHueCtx.fillStyle = grad;
        cpHueCtx.fillRect(0, 0, w, h);
    }

    function setupGradientDrag() {
        let dragging = false;
        const rect = () => cpGradient.getBoundingClientRect();

        function move(clientX, clientY) {
            const r = rect();
            const x = clamp(clientX - r.left, 0, r.width) / r.width;
            const y = clamp(clientY - r.top, 0, r.height) / r.height;
            cpSat = Math.round(x * 100);
            cpLit = Math.round((1 - y) * 100);
            cpLit = clamp(cpLit, 0, 100);
            updateColorPanel('gradient');
        }

        cpGradient.addEventListener('pointerdown', e => {
            e.preventDefault();
            cpGradient.setPointerCapture(e.pointerId);
            dragging = true;
            move(e.clientX, e.clientY);
        });
        cpGradient.addEventListener('pointermove', e => {
            if (dragging) move(e.clientX, e.clientY);
        });
        cpGradient.addEventListener('pointerup', () => { dragging = false; });
        cpGradient.addEventListener('pointercancel', () => { dragging = false; });
    }

    function setupHueDrag() {
        let dragging = false;
        const rect = () => cpHueEl.getBoundingClientRect();

        function move(clientY) {
            const r = rect();
            const y = clamp(clientY - r.top, 0, r.height) / r.height;
            cpHue = Math.round(y * 360);
            updateColorPanel('hue');
        }

        cpHueEl.addEventListener('pointerdown', e => {
            e.preventDefault();
            cpHueEl.setPointerCapture(e.pointerId);
            dragging = true;
            move(e.clientY);
        });
        cpHueEl.addEventListener('pointermove', e => {
            if (dragging) move(e.clientY);
        });
        cpHueEl.addEventListener('pointerup', () => { dragging = false; });
        cpHueEl.addEventListener('pointercancel', () => { dragging = false; });
    }

    function updateColorPanel(source) {
        const [r, g, b] = hslToRgb(cpHue, cpSat, cpLit);
        const hex = rgbToHex(r, g, b);

        brushColor = hex;
        colorBtnSwatch.style.background = hex;
        brushTriggerSwatch.style.background = hex;
        pickedColorPreview.style.background = hex;
        updateBrushPreview();

        // Also update selected text color
        if (selectedText) {
            selectedText.color = hex;
            $('tt-color').value = hex;
            renderTextObjects();
        }

        if (source === 'hue' || source === 'hex' || source === 'hsl' || source === 'init' || source === 'rgb' || source === 'eyedropper' || source === 'palette' || source === 'recent') {
            drawGradientField();
        }

        const gx = (cpSat / 100) * cpGradient.width;
        const gy = ((100 - cpLit) / 100) * cpGradient.height;
        cpCrosshair.style.left = gx + 'px';
        cpCrosshair.style.top = gy + 'px';

        cpHueIndicator.style.top = (cpHue / 360) * cpHueEl.height + 'px';

        if (source !== 'rgb') {
            $('cp-r').value = r; $('cp-r-val').value = r;
            $('cp-g').value = g; $('cp-g-val').value = g;
            $('cp-b').value = b; $('cp-b-val').value = b;
        }

        if (source !== 'hsl') {
            $('cp-h-slider').value = cpHue; $('cp-h-val').value = cpHue;
            $('cp-s-slider').value = cpSat; $('cp-s-val').value = cpSat;
            $('cp-l-slider').value = cpLit; $('cp-l-val').value = cpLit;
        }

        if (source !== 'hex') {
            cpHexInput.value = hex.slice(1).toUpperCase();
        }

        if (source !== 'init' && source !== 'gradient' && source !== 'hue') {
            addRecent(hex);
        }
    }

    function applyColor(hex, source) {
        const [r, g, b] = hexToRgbArr(hex);
        const [h, s, l] = rgbToHsl(r, g, b);
        cpHue = h; cpSat = s; cpLit = l;
        updateColorPanel(source);
    }

    function addRecent(hex) {
        recentColors = recentColors.filter(c => c !== hex);
        recentColors.unshift(hex);
        if (recentColors.length > MAX_RECENT) recentColors.pop();
        renderRecent();
    }

    function renderPalette() {
        cpPalette.innerHTML = '';
        savedPalette.forEach(color => {
            const el = document.createElement('div');
            el.className = 'cp-swatch';
            el.style.background = color;
            el.dataset.color = color;
            el.title = color + '\nShift+click to remove';
            cpPalette.appendChild(el);
        });
        if (savedPalette.length === 0) {
            const el = document.createElement('div');
            el.className = 'cp-swatch empty';
            el.title = 'Click + to save colors';
            cpPalette.appendChild(el);
        }
    }

    function renderRecent() {
        cpRecent.innerHTML = '';
        recentColors.forEach(color => {
            const el = document.createElement('div');
            el.className = 'cp-swatch';
            el.style.background = color;
            el.dataset.color = color;
            el.title = color;
            cpRecent.appendChild(el);
        });
    }

    // ========== COLOR CONVERSIONS ==========
    function hslToRgb(h, s, l) {
        s /= 100; l /= 100;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = l - c / 2;
        let r, g, b;
        if (h < 60)       { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else              { r = c; g = 0; b = x; }
        return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    }

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        let h = 0, s = 0;
        const l = (max + min) / 2;
        if (d !== 0) {
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
            else if (max === g) h = ((b - r) / d + 2) * 60;
            else h = ((r - g) / d + 4) * 60;
        }
        return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
    }

    function hexToRgbArr(hex) {
        return [
            parseInt(hex.slice(1, 3), 16),
            parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16)
        ];
    }

    // ========== START ==========
    init();
})();
