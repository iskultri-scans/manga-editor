(() => {
    'use strict';

    // ========== DOM ==========
    const $ = id => document.getElementById(id);
    const canvas = $('main-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const overlay = $('overlay-canvas');
    const octx = overlay.getContext('2d');
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

    // Text
    let textSize = 20;
    let textColor = '#000000';
    let textBold = false;
    let textItalic = false;
    let textEditing = false;
    let textObjects = [];
    let selectedTextObj = null;
    let textDragObj = null;
    let textDragPending = null;
    let textDragPendingOff = null;
    let textDragPendingStart = null;
    let textDragOff = null;
    let textResizeObj = null;
    let textResizeStart = null;
    let lastTapTime = 0;
    let lastTapObj = null;

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
            // Clear instead of delete
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
        if (idx <= 0) return; // can't merge bottom layer down
        const top = layers[idx];
        const bot = layers[idx - 1];
        // Composite top onto bottom
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
        if (textEditing) commitText();
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

                // Create compositing buffer
                off = document.createElement('canvas');
                off.width = img.width;
                off.height = img.height;
                offCtx = off.getContext('2d', { willReadFrequently: true });

                // Create first layer
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
    }

    function zoomRender() {
        isZooming = true;
        applyZoomView();
        overlay.style.display = 'none';
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

        // Text objects
        if (currentTool === 'text' && !textEditing) {
            for (const obj of textObjects) {
                if (!obj.text) continue;
                octx.save();
                octx.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? 'bold ' : ''}${obj.fontSize}px 'Noto Sans Bengali', sans-serif`;
                octx.fillStyle = obj.color || '#000000';
                octx.textBaseline = 'top';
                const lines = obj.text.split('\n');
                lines.forEach((line, i) => {
                    octx.fillText(line, obj.x, obj.y + obj.fontSize * 1.2 * i + obj.fontSize);
                });
                octx.restore();

                if (obj === selectedTextObj) {
                    octx.save();
                    octx.strokeStyle = '#7c3aed';
                    octx.lineWidth = 1.5 / zoom;
                    octx.setLineDash([5 / zoom, 3 / zoom]);
                    octx.strokeRect(obj.x - 2, obj.y - 2, obj._w + 4, obj._h + 4);
                    octx.setLineDash([]);

                    // Resize handle
                    const isMob = 'ontouchstart' in window;
                    const hSize = (isMob ? 12 : 5) / zoom;
                    octx.fillStyle = '#7c3aed';
                    octx.fillRect(obj.x + obj._w - hSize, obj.y + obj._h - hSize, hSize * 2, hSize * 2);
                    octx.restore();
                }
            }
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

    // ========== POINTER EVENTS ==========
    function setupPointer() {
        overlay.addEventListener('pointerdown', onPointerDown);
        overlay.addEventListener('dblclick', onDblClick);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
    }

    function onPointerDown(e) {
        if (!img || e.pointerType === 'touch') return;
        e.preventDefault();
        overlay.setPointerCapture(e.pointerId);
        pointerDown = true;
        const pt = screenToImg(e.clientX, e.clientY);
        toolDown(pt);
    }

    function onPointerMove(e) {
        if (!img || e.pointerType === 'touch' || !pointerDown) return;
        const pt = screenToImg(e.clientX, e.clientY);
        toolMove(pt);
    }

    function onPointerUp(e) {
        if (e.pointerType === 'touch') return;
        pointerDown = false;
        toolUp();
    }

    function onDblClick(e) {
        if (!img || currentTool !== 'text' || textEditing) return;
        const pt = screenToImg(e.clientX, e.clientY);
        for (let i = textObjects.length - 1; i >= 0; i--) {
            if (hitTestText(textObjects[i], pt.x, pt.y)) {
                selectedTextObj = textObjects[i];
                startEditText(textObjects[i]);
                return;
            }
        }
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
            if (currentTool === 'text' && !textEditing) {
                const t = touchCache[0];
                const pt = screenToImg(t.clientX, t.clientY);
                // Double-tap detection
                let tappedObj = null;
                for (let i = textObjects.length - 1; i >= 0; i--) {
                    if (hitTestText(textObjects[i], pt.x, pt.y)) { tappedObj = textObjects[i]; break; }
                }
                if (tappedObj) {
                    if (handleTextTouchStart(pt, tappedObj)) return;
                }
                // Normal touch down
                textDown(pt);
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
            case 'text': textDown(pt); break;
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
            case 'text': textMove(pt); break;
            case 'crop': cropMove(pt); break;
        }
    }

    function toolUp() {
        switch (currentTool) {
            case 'select': selectUp(); break;
            case 'brush': brushUp(); break;
            case 'eraser': eraserUp(); break;
            case 'text': textUp(); break;
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

    // ========== TEXT OBJECTS ==========
    function createTextObject(x, y) {
        return {
            x, y,
            fontSize: textSize,
            bold: textBold,
            italic: textItalic,
            color: textColor,
            text: '',
            _w: 0,
            _h: 0,
            _savedText: ''
        };
    }

    function measureTextObject(obj) {
        const tc = document.createElement('canvas').getContext('2d');
        tc.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? 'bold ' : ''}${obj.fontSize}px 'Noto Sans Bengali', sans-serif`;
        const lines = obj.text.split('\n');
        obj._w = Math.max(...lines.map(l => tc.measureText(l).width), 40);
        obj._h = lines.length * obj.fontSize * 1.2;
    }

    function hitTestText(obj, x, y) {
        return x >= obj.x && x <= obj.x + obj._w &&
               y >= obj.y && y <= obj.y + obj._h;
    }

    function hitTestResizeHandle(obj, x, y) {
        const isMob = 'ontouchstart' in window;
        const hSize = (isMob ? 24 : 10) / zoom;
        const hx = obj.x + obj._w;
        const hy = obj.y + obj._h;
        return Math.abs(x - hx) < hSize && Math.abs(y - hy) < hSize;
    }

    function handleTextTouchStart(pt, obj) {
        const now = Date.now();
        if (lastTapObj === obj && now - lastTapTime < 300) {
            startEditText(obj);
            lastTapTime = 0;
            lastTapObj = null;
            return true;
        }
        lastTapTime = now;
        lastTapObj = obj;
        return false;
    }

    // ========== TOOL 4: TEXT ==========
    function textDown(pt) {
        if (textEditing) { commitText(); return; }

        // 1. Resize handle check FIRST
        if (selectedTextObj && hitTestResizeHandle(selectedTextObj, pt.x, pt.y)) {
            textResizeObj = selectedTextObj;
            textResizeStart = {
                x: pt.x, y: pt.y,
                fontSize: selectedTextObj.fontSize,
                w: selectedTextObj._w,
                h: selectedTextObj._h
            };
            return;
        }

        // 2. Hit test existing objects (top to bottom z-order)
        for (let i = textObjects.length - 1; i >= 0; i--) {
            if (hitTestText(textObjects[i], pt.x, pt.y)) {
                selectedTextObj = textObjects[i];
                textDragPending = selectedTextObj;
                textDragPendingOff = { x: pt.x - selectedTextObj.x, y: pt.y - selectedTextObj.y };
                textDragPendingStart = { x: pt.x, y: pt.y };
                renderOverlay();
                return;
            }
        }

        // 3. Click on empty space
        if (selectedTextObj) {
            selectedTextObj = null;
            renderOverlay();
            return;
        }

        // 4. Second click on empty = create new text object
        const obj = createTextObject(pt.x, pt.y);
        textObjects.push(obj);
        selectedTextObj = obj;
        startEditText(obj);
        renderOverlay();
    }

    function textMove(pt) {
        if (textDragPending && !textDragObj) {
            const dx = pt.x - textDragPendingStart.x;
            const dy = pt.y - textDragPendingStart.y;
            if (Math.hypot(dx, dy) > (('ontouchstart' in window) ? 15 : 3) / zoom) {
                textDragObj = textDragPending;
                textDragOff = textDragPendingOff;
            }
        }

        if (textDragObj) {
            textDragObj.x = pt.x - textDragOff.x;
            textDragObj.y = pt.y - textDragOff.y;
            overlay.style.cursor = 'move';
            renderOverlay();
            return;
        }

        if (textResizeObj) {
            const dx = pt.x - textResizeStart.x;
            const dy = pt.y - textResizeStart.y;
            const dist = Math.hypot(dx, dy);
            const startDist = Math.hypot(textResizeStart.w, textResizeStart.h);
            const scale = Math.max(0.2, (startDist + dist) / startDist);
            textResizeObj.fontSize = Math.max(6, Math.round(textResizeStart.fontSize * scale));
            overlay.style.cursor = 'nwse-resize';
            measureTextObject(textResizeObj);
            renderOverlay();
            return;
        }

        // Hover cursor update
        if (selectedTextObj && hitTestResizeHandle(selectedTextObj, pt.x, pt.y)) {
            overlay.style.cursor = 'nwse-resize';
            return;
        }
        for (let i = textObjects.length - 1; i >= 0; i--) {
            if (hitTestText(textObjects[i], pt.x, pt.y)) {
                overlay.style.cursor = 'move';
                return;
            }
        }
        overlay.style.cursor = 'text';
    }

    function textUp() {
        textDragObj = null;
        textDragOff = null;
        textDragPending = null;
        textDragPendingOff = null;
        textDragPendingStart = null;
        textResizeObj = null;
        textResizeStart = null;
        overlay.style.cursor = 'text';
        renderOverlay();
    }

    function startEditText(obj) {
        obj._savedText = obj.text;
        textEditing = true;

        const textarea = document.createElement('textarea');
        textarea.className = 'canvas-text-input';
        textarea.value = obj.text;
        textarea.style.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? 'bold ' : ''}${obj.fontSize}px 'Noto Sans Bengali', sans-serif`;
        textarea.style.color = obj.color;
        textarea.style.background = 'rgba(255,255,255,0.85)';
        textarea.style.border = '2px dashed #7c3aed';
        textarea.style.borderRadius = '4px';
        textarea.style.padding = '2px 4px';
        textarea.style.resize = 'none';
        textarea.style.minWidth = '80px';
        textarea.style.minHeight = `${obj.fontSize * 1.4}px`;
        textarea.style.lineHeight = '1.2';
        textarea.setAttribute('dir', 'auto');

        // Position over canvas object
        textarea.style.left = (obj.x * zoom + panX) + 'px';
        textarea.style.top = (obj.y * zoom + panY) + 'px';

        area.appendChild(textarea);
        requestAnimationFrame(() => textarea.focus());

        if ('ontouchstart' in window) {
            setTimeout(() => textarea.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
        }

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
            if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
        });

        textarea.addEventListener('input', () => {
            obj.text = textarea.value;
            measureTextObject(obj);
            renderOverlay();
        });

        textarea.addEventListener('blur', () => {
            setTimeout(commitText, 100);
        });

        textarea.addEventListener('pointerdown', e => e.stopPropagation());

        obj._textarea = textarea;
    }

    function commitText() {
        if (!textEditing) return;
        textEditing = false;
        if (selectedTextObj && selectedTextObj._textarea) {
            selectedTextObj.text = selectedTextObj._textarea.value;
            if (!selectedTextObj.text.trim()) {
                textObjects = textObjects.filter(o => o !== selectedTextObj);
                selectedTextObj = null;
            } else {
                measureTextObject(selectedTextObj);
            }
            selectedTextObj && selectedTextObj._textarea && selectedTextObj._textarea.remove();
            if (selectedTextObj) selectedTextObj._textarea = null;
        }
        renderOverlay();
    }

    function cancelText() {
        if (!textEditing) return;
        textEditing = false;
        if (selectedTextObj) {
            selectedTextObj._textarea && selectedTextObj._textarea.remove();
            selectedTextObj._textarea = null;
            if (selectedTextObj._savedText === '') {
                textObjects = textObjects.filter(o => o !== selectedTextObj);
                selectedTextObj = null;
            } else {
                selectedTextObj.text = selectedTextObj._savedText;
                measureTextObject(selectedTextObj);
            }
        }
        renderOverlay();
    }

    function flattenText() {
        const layer = getActiveLayer();
        if (!layer || textObjects.length === 0) return;
        saveState();
        for (const obj of textObjects) {
            if (!obj.text) continue;
            measureTextObject(obj);
            layer.ctx.save();
            layer.ctx.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? 'bold ' : ''}${obj.fontSize}px 'Noto Sans Bengali', sans-serif`;
            layer.ctx.fillStyle = obj.color || '#000000';
            layer.ctx.textBaseline = 'top';
            obj.text.split('\n').forEach((line, i) => {
                layer.ctx.fillText(line, obj.x, obj.y + obj.fontSize * 1.2 * i + obj.fontSize);
            });
            layer.ctx.restore();
        }
        textObjects = [];
        selectedTextObj = null;
        renderAll();
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
            if (textEditing) commitText();
            flattenText();
            selectedTextObj = null;
            textDragObj = null;
            textDragPending = null;
            textDragOff = null;
            textResizeObj = null;
            overlay.style.cursor = '';
        }

        showToolOptions(tool);
        renderOverlay();
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

        // Eraser
        $('eraser-size').addEventListener('input', e => { eraserSize = +e.target.value; $('eraser-size-val').textContent = eraserSize; });

        // Text
        $('text-size').addEventListener('input', e => { textSize = +e.target.value; $('text-size-val').textContent = textSize; if (selectedTextObj) { selectedTextObj.fontSize = textSize; measureTextObject(selectedTextObj); renderOverlay(); } });
        $('text-color').addEventListener('input', e => { textColor = e.target.value; if (selectedTextObj) { selectedTextObj.color = textColor; renderOverlay(); } });
        $('text-bold-btn').addEventListener('click', () => { textBold = !textBold; $('text-bold-btn').classList.toggle('on', textBold); if (selectedTextObj) { selectedTextObj.bold = textBold; measureTextObject(selectedTextObj); renderOverlay(); } });
        $('text-italic-btn').addEventListener('click', () => { textItalic = !textItalic; $('text-italic-btn').classList.toggle('on', textItalic); if (selectedTextObj) { selectedTextObj.italic = textItalic; measureTextObject(selectedTextObj); renderOverlay(); } });

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
        // Toggle
        layerBtn.addEventListener('click', e => {
            e.stopPropagation();
            layerPanel.classList.toggle('open');
        });

        // Close on outside click
        document.addEventListener('click', e => {
            if (layerPanel.classList.contains('open') &&
                !layerPanel.contains(e.target) &&
                !layerBtn.contains(e.target)) {
                layerPanel.classList.remove('open');
            }
        });

        // Add layer
        lpAddBtn.addEventListener('click', () => addLayer());

        // Duplicate layer
        lpDupBtn.addEventListener('click', () => {
            if (activeLayerId !== null) duplicateLayer(activeLayerId);
        });

        // Delete layer
        lpDelBtn.addEventListener('click', () => {
            if (activeLayerId !== null) deleteLayer(activeLayerId);
        });

        // Merge down
        lpMergeBtn.addEventListener('click', () => {
            if (activeLayerId !== null) mergeDown(activeLayerId);
        });

        // Opacity slider
        lpOpacity.addEventListener('input', () => {
            const layer = getActiveLayer();
            if (!layer) return;
            layer.opacity = +lpOpacity.value;
            lpOpacityVal.textContent = lpOpacity.value + '%';
            renderAll();
        });

        // Blend mode
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

        // Display top-to-bottom (reverse of array order)
        for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i];
            const row = document.createElement('div');
            row.className = 'lp-layer' + (layer.id === activeLayerId ? ' active' : '');
            row.dataset.id = layer.id;
            row.dataset.idx = i;

            // Thumbnail
            const thumbWrap = document.createElement('div');
            thumbWrap.className = 'lp-thumb';
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = 36;
            thumbCanvas.height = 28;
            const tctx = thumbCanvas.getContext('2d');
            tctx.drawImage(layer.canvas, 0, 0, 36, 28);
            thumbWrap.appendChild(thumbCanvas);
            row.appendChild(thumbWrap);

            // Name
            const nameSpan = document.createElement('span');
            nameSpan.className = 'lp-name';
            nameSpan.textContent = layer.name;
            row.appendChild(nameSpan);

            // Visibility button
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

            // Lock button
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

            // Click to select layer
            row.addEventListener('click', () => {
                if (layer.id !== activeLayerId) setActiveLayer(layer.id);
            });

            // Double-click to rename
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

            // Drag to reorder
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

        // Update opacity/blend controls for active layer
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
            else if (e.key === 'Escape') { sel = null; cropSel = null; showOptSelect(false); renderOverlay(); }
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
        window.addEventListener('resize', () => { if (img) renderAll(); });

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
        textColor = hex;
        $('text-color').value = hex;
        pickedColorPreview.style.background = hex;
        updateBrushPreview();

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
