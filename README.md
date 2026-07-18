# Manga Panel Editor

A browser-based image editor purpose-built for manga/comic page editing — cleaning speech bubbles, removing original text, and typesetting translated text (including Bengali script) back onto pages. Mobile-first, offline-capable, zero build tooling.

## How to run

**Option A — double-click:**
Open `index.html` in any modern mobile or desktop browser (Chrome / Firefox / Safari).

**Option B — trivial static server (recommended for full Web Worker support):**
```bash
cd manga-editor
python3 -m http.server 8000
# then visit http://localhost:8000/ on your phone (same Wi-Fi)
```

> ⚠️ Opening directly via `file://` works, but some browsers restrict Web Workers under that protocol. The magic-wand tool falls back to synchronous mode automatically — it still works, just without the busy-spinner. For best results use Option B.

No `npm install`. No build step. No internet required after first load.

## File layout

```
manga-editor/
├── index.html                # App shell + UI structure
├── README.md                 # This file
├── css/
│   └── style.css             # All styling, mobile-first
├── js/
│   ├── main.js               # App init, state, event wiring, tool dispatch
│   ├── canvas-engine.js      # Pan/zoom/render, coordinate transforms
│   ├── history.js            # Undo/redo stack
│   ├── layers.js             # Layer + selection-mask model
│   ├── utils.js              # Color distance, geometry, helpers
│   └── tools/
│       ├── magic-wand.js     # Flood-fill selection (scanline, Web Worker)
│       ├── selection.js      # Mask ops: invert, expand, contract, feather
│       ├── fill.js           # Fill current selection + eyedropper
│       ├── brush.js          # Soft brush with Bezier-smoothed strokes
│       ├── eraser.js         # Eraser (non-destructive on edit layer)
│       ├── lasso.js          # Freehand + polygon selection
│       └── text-tool.js      # Editable text boxes with auto-fit
└── assets/
    └── fonts/
        ├── NotoSansBengali-Regular.ttf   # Bundled locally
        └── NotoSansBengali-Bold.ttf
```

## Tools (one-line reference)

| Tool | What it does |
|---|---|
| **Wand** | Tap a pixel → flood-fill select contiguous pixels within tolerance. Toggle 4-way/8-way, contiguous/global. Invert / expand / contract / feather / clear from the options sheet. |
| **Lasso** | Freehand drag or polygon-tap to select irregular regions (whole bubbles, SFX embedded in artwork). |
| **Brush** | Soft-edged freehand brush for manual cleanup. Size + hardness sliders. Respects active selection. Pressure-sensitive on supported devices. |
| **Erase** | Erases the edit layer (reveals the original image beneath). Non-destructive. Same smoothing/pressure as Brush. |
| **Fill** | Fill the current selection with a color. Alpha-blends at feathered edges. |
| **Pick** | Eyedropper — tap anywhere to sample a color into Brush + Fill. |
| **Text** | Drag to create a text box. Auto-fits font size to the box (reduce on overflow, expand if short). Manual override available. Supports Bengali + Latin. Bold/italic/outline/alignment. Editable after placement. |
| **Pan** | Default. Single-finger pan, two-finger pinch-zoom. Mouse wheel zoom on desktop. |

## Keyboard shortcuts (desktop)

- `W` / `L` / `B` / `E` / `F` / `I` / `T` / `H` — switch tools
- `Ctrl/Cmd+Z` — undo, `Ctrl/Cmd+Shift+Z` or `Ctrl+Y` — redo
- `Delete` / `Backspace` — delete selection pixels (or selected text box)
- `Esc` — deselect / cancel

## Mobile notes

- Two-finger pinch zooms around the pinch midpoint; single-finger drag pans.
- `touch-action: none` on the canvas prevents the browser from hijacking gestures (pull-to-refresh, page-zoom).
- Palm rejection: a second finger landing mid-stroke does NOT cancel the stroke — only a clean two-finger pinch (when no tool is active) triggers zoom.
- All tap targets ≥44×44px.
- Bottom-sheet options panel keeps controls reachable in portrait.
- Bengali font is bundled — works fully offline once the page is loaded.

## Architecture notes (for future maintainers)

- **Source of truth**: an offscreen canvas at full image resolution. The display canvas's backing store matches source resolution; CSS `transform: translate() scale()` handles pan/zoom cheaply via the GPU.
- **Coordinate transforms**: every tool converts pointer events from screen→image space via `engine.eventToImage(e)` before doing pixel work. This is the single most common source of bugs in canvas editors, so centralizing it here is intentional.
- **Layer model**: v1 has Original + Edit + Text-objects. Original is read-only; Edit holds destructive cleanup work; Text-objects are live and only "baked" on PNG export.
- **Selection mask**: a `Uint8Array` of length `width*height` (0=unselected, 255=fully selected, intermediate values for feathered edges). Owned by `LayerStack`; tools query via `layers.isSelectedAt(x,y)` or `layers.selectionStrengthAt(x,y)`.
- **History**: each step is a `{undo, redo}` closure, not a full-canvas snapshot. Brush strokes snapshot only their bounding box (so a 100px stroke on a 2000×3000 image stores ~100×100×4 = 40KB, not 24MB). Limit: 50 steps.
- **Magic Wand**: scanline flood fill (Heckbert's algorithm) running in a Web Worker created from a Blob URL — this makes it work even under `file://` protocol where separate worker files would be blocked. Falls back to synchronous if the worker can't start.
- **Text auto-fit**: binary search on font size, both for shrink-on-overflow and grow-to-fill. Honors explicit newlines; wraps at word boundaries. Bengali conjuncts/reordering are handled by the browser's text shaping engine (via `ctx.fillText`) — no custom glyph logic.

## Known limitations / scope cuts (per spec Section 7)

- No AI/ML features (no auto-OCR, no inpainting). This is a manual editor.
- No cloud sync, no accounts.
- No general photo filters.
- Text fitting uses the bounding box, not the actual bubble curve. (Full arbitrary-shape text fitting was explicitly out of scope per the brief.)
- Project save/load (JSON of layers + text objects) is not implemented in v1. Use PNG export to persist results. Adding JSON save is a small extension — `LayerStack` and `TextBox` are already serializable.

## License

MIT-style: do whatever, attribution appreciated. Bundled Noto Sans Bengali is under the SIL Open Font License.
