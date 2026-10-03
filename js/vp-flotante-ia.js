/* =====================================================================
   vp-flotante-ia.js — Ventanas flotantes arrastrables (con persistencia)
   Versión corregida: evita guardar (0,0) al cerrar la ventana
   ===================================================================== */
(function () {
    'use strict';

    if (window.__VP_FLOTANTE_IA_LOADED__) return;
    window.__VP_FLOTANTE_IA_LOADED__ = true;

    var log = (function () {
        var vpLog = window.VP && window.VP.log;
        if (!vpLog) return console;
        var w = {};
        function _wrap(level) {
            return function () {
                var args = arguments;
                vpLog.withContext('Floating', function () {
                    vpLog[level].apply(vpLog, args);
                });
            };
        }
        w.debug = _wrap('debug'); w.info = _wrap('info');
        w.warn  = _wrap('warn');  w.error = _wrap('error');
        return w;
    })();

    const EDGE_SNAP       = 12;
    const SNAP_THRESHOLD  = 48;
    const Z_BASE          = 220;
    const DRAG_DEAD_ZONE  = 4;
    const SNAP_DURATION   = 220;
    const CENTER_DURATION = 300;
    const STORAGE_PREFIX  = 'vp_floatPos_';

    var _vpFloatState = {
        _initialized: false,
        _destroyed: false,
        _docListeners: [],
        _gObserver: null,
    };

    var _debouncedResize = null;

    let activeWin  = null;
    let startX     = 0, startY   = 0;
    let origLeft   = 0, origTop  = 0;
    let wasDragged = false;
    let zCounter   = Z_BASE;

    const WINDOW_IDS = [
    { id: 'summaryModal',      key: 'summary'   },
    { id: 'chaptersIAModal',   key: 'chapters'  },
    { id: 'chatIAModal',       key: 'chat'      },
    { id: 'translateIAModal',  key: 'translate' },
    { id: 'visionIAModal',     key: 'vision'    },
    { id: 'tagsIAModal',       key: 'tags'      },
    { id: 'commentsIAModal',   key: 'comments'  },
    { id: 'settingsModal',     key: 'settings'  } 
	];

    const windows = [];

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        if (_vpFloatState._initialized || _vpFloatState._destroyed) return;
        _vpFloatState._initialized = true;

        WINDOW_IDS.forEach(def => registerById(def.id, def.key));
        observeNewWindows();

        _debouncedResize = debounce(onWindowResize, 150);

        document.addEventListener('mousemove',   onDragMove);
        document.addEventListener('mouseup',     onDragEnd);
        document.addEventListener('touchmove',   onDragMoveTouch, { passive: false });
        document.addEventListener('touchend',    onDragEnd);
        document.addEventListener('touchcancel', onDragEnd);
        window.addEventListener('resize',        _debouncedResize);

        _vpFloatState._docListeners.push(
            { target: document, event: 'mousemove',   handler: onDragMove },
            { target: document, event: 'mouseup',     handler: onDragEnd },
            { target: document, event: 'touchmove',   handler: onDragMoveTouch },
            { target: document, event: 'touchend',    handler: onDragEnd },
            { target: document, event: 'touchcancel', handler: onDragEnd },
            { target: window,   event: 'resize',      handler: _debouncedResize }
        );

        // Restaurar ventanas que ya estén activas al cargar la página
        windows.forEach(w => {
            if (w.overlay.classList.contains('active')) onOpen(w);
        });
    }

    /* ─── Registro ─── */
    function registerById(id, key) {
        if (windows.find(w => w.id === id)) return false;

        const overlay = document.getElementById(id);
        if (!overlay) return false;

        const content = overlay.querySelector('.modal-content');
        if (!content) {
            log.warn(`#${id}: no tiene .modal-content`);
            return false;
        }

        const header = findHeader(overlay);
        if (!header) {
            log.warn(`#${id}: sin cabecera arrastrable`);
            return false;
        }

        const w = {
            overlay, content, header,
            id, key,
            wasMoved:  false,
            savedLeft: null,
            savedTop:  null
        };

        windows.push(w);
        setupWindowEvents(w);
        setupPositionObserver(w);
        setupPositionRadios(w);

        log.info(`✓ Registrada: #${id} | key: ${key}`);
        return true;
    }

    function findHeader(overlay) {
        const selectors = [
            '.floating-window__header',
            '.modal-header',
            '.comments-ia-header',
            '.commentary-ia-header',
            '.chat-ia-header',
            '.vision-ia-header',
            '.tags-ia-header',
            '.translate-ia-header',
            '[data-drag-handle]'
        ];

        for (const sel of selectors) {
            const el = overlay.querySelector(sel);
            if (el) return el;
        }

        const content = overlay.querySelector('.modal-content');
        if (content && content.firstElementChild) {
            log.warn('Usando primer hijo como header:', content.firstElementChild.tagName);
            return content.firstElementChild;
        }
        return null;
    }

    function observeNewWindows() {
        let pending = WINDOW_IDS.filter(def => !windows.find(w => w.id === def.id));
        if (!pending.length) return;

        var obs = new MutationObserver(function () {
            pending = pending.filter(function (def) {
                if (windows.find(function (w) { return w.id === def.id; })) return false;
                return !registerById(def.id, def.key);
            });
            if (!pending.length) obs.disconnect();
        });
        _vpFloatState._gObserver = obs;
        obs.observe(document.body, { childList: true, subtree: true });
    }

    /* ─── Eventos de ventana ─── */
    function setupWindowEvents(w) {
        const { header, content } = w;

        header.style.cursor      = 'grab';
        header.style.userSelect  = 'none';
        header.style.touchAction = 'none';

        header.addEventListener('mousedown', e => {
            if (isInteractive(e.target)) return;
            e.preventDefault();
            startDrag(w, e.clientX, e.clientY);
        });

        header.addEventListener('touchstart', e => {
            if (isInteractive(e.target)) return;
            e.preventDefault();
            startDrag(w, e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });

        header.addEventListener('dblclick', e => {
            if (isInteractive(e.target)) return;
            animateCenterWindow(w);
        });

        content.addEventListener('mousedown',  () => bringToFront(w));
        content.addEventListener('touchstart', () => bringToFront(w), { passive: true });
    }

    function isInteractive(el) {
        if (!el || typeof el.closest !== 'function') return false;
        return !!el.closest(
            'button, a, input, select, textarea, label, ' +
            '.floating-pos-btn, .floating-pos-switch, ' +
            '[role="button"], [tabindex]:not([tabindex="-1"])'
        );
    }

    /* ─── Arrastre ─── */
    var _cachedWinW = 0, _cachedWinH = 0;

    function startDrag(w, x, y) {
        if (_vpFloatState._destroyed) return;
        if (w.content.classList.contains('minimized')) return;

        activeWin  = w;
        wasDragged = false;

        const rect = w.content.getBoundingClientRect();
        clearRadios(w.overlay);
        applyFixedPosition(w.content, rect.left, rect.top);

        _cachedWinW = rect.width;
        _cachedWinH = rect.height;
        origLeft = rect.left;
        origTop  = rect.top;
        startX   = x;
        startY   = y;

        w.header.style.cursor      = 'grabbing';
        w.content.style.transition = 'none';
        w.content.style.willChange = 'left, top';
        w.content.classList.add('floating-dragging');
        w.content.classList.remove('snapping');

        bringToFront(w);
    }

    function onDragMove(e) { if (activeWin) { e.preventDefault(); moveTo(e.clientX, e.clientY); } }
    function onDragMoveTouch(e) { if (activeWin) { e.preventDefault(); moveTo(e.touches[0].clientX, e.touches[0].clientY); } }

    function moveTo(x, y) {
        const dx = x - startX;
        const dy = y - startY;

        if (!wasDragged && (Math.abs(dx) > DRAG_DEAD_ZONE || Math.abs(dy) > DRAG_DEAD_ZONE)) {
            wasDragged = true;
        }
        if (!wasDragged) return;

        const cw   = _cachedWinW;
        const ch   = _cachedWinH;
        const maxX = window.innerWidth  - cw;
        const maxY = window.innerHeight - ch;

        const nL = Math.max(EDGE_SNAP, Math.min(origLeft + dx, maxX - EDGE_SNAP));
        const nT = Math.max(EDGE_SNAP, Math.min(origTop  + dy, maxY - EDGE_SNAP));

        activeWin.content.style.left = nL + 'px';
        activeWin.content.style.top  = nT + 'px';
    }

    function onDragEnd() {
        if (!activeWin) return;
        const w = activeWin;

        w.header.style.cursor      = 'grab';
        w.content.style.willChange = '';
        w.content.classList.remove('floating-dragging');

        if (wasDragged) {
            w.wasMoved = true;
            snapToEdge(w.content);
            savePosition(w);
        } else {
            w.content.style.transition = '';
        }

        activeWin = null;
    }

    /* ─── Snap ─── */
    function snapToEdge(el) {
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;

        const nL = rect.left           < SNAP_THRESHOLD;
        const nR = (vw - rect.right)   < SNAP_THRESHOLD;
        const nT = rect.top            < SNAP_THRESHOLD;
        const nB = (vh - rect.bottom)  < SNAP_THRESHOLD;

        let tL = null, tT = null;

        if      (nL && nT) { tL = EDGE_SNAP;                   tT = EDGE_SNAP; }
        else if (nR && nT) { tL = vw - rect.width - EDGE_SNAP; tT = EDGE_SNAP; }
        else if (nL && nB) { tL = EDGE_SNAP;                   tT = vh - rect.height - EDGE_SNAP; }
        else if (nR && nB) { tL = vw - rect.width - EDGE_SNAP; tT = vh - rect.height - EDGE_SNAP; }
        else {
            if (nL) tL = EDGE_SNAP;
            if (nR) tL = vw - rect.width - EDGE_SNAP;
            if (nT) tT = EDGE_SNAP;
            if (nB) tT = vh - rect.height - EDGE_SNAP;
        }

        if (tL !== null || tT !== null) {
            el.classList.add('snapping');
            el.style.transition = `left ${SNAP_DURATION}ms cubic-bezier(0.34,1.56,0.64,1),` +
                                  `top  ${SNAP_DURATION}ms cubic-bezier(0.34,1.56,0.64,1)`;
            if (tL !== null) el.style.left = tL + 'px';
            if (tT !== null) el.style.top  = tT + 'px';
            setTimeout(() => {
                el.style.transition = '';
                el.classList.remove('snapping');
            }, SNAP_DURATION + 30);
        } else {
            el.style.transition = '';
        }
    }

    /* ─── Centro ─── */
    function animateCenterWindow(w) {
        const el   = w.content;
        const rect = el.getBoundingClientRect();
        applyFixedPosition(el, rect.left, rect.top);

        const x = Math.max(EDGE_SNAP, (window.innerWidth  - rect.width)  / 2);
        const y = Math.max(EDGE_SNAP, (window.innerHeight - rect.height) / 2);

        el.style.transition = `left ${CENTER_DURATION}ms cubic-bezier(0.34,1.56,0.64,1),` +
                              `top  ${CENTER_DURATION}ms cubic-bezier(0.34,1.56,0.64,1)`;
        el.style.left = x + 'px';
        el.style.top  = y + 'px';

        setTimeout(() => {
            el.style.transition = '';
            w.wasMoved = true;
            savePosition(w);
        }, CENTER_DURATION + 50);
    }

    function placeCenterImmediate(el) {
        const w = el.offsetWidth  || parseInt(getComputedStyle(el).width)  || 420;
        const h = el.offsetHeight || parseInt(getComputedStyle(el).height) || 400;

        const x = Math.max(EDGE_SNAP, (window.innerWidth  - w) / 2);
        const y = Math.max(EDGE_SNAP, (window.innerHeight - h) / 2);

        applyFixedPosition(el, x, y);
    }

    /* ─── Helpers de posición ─── */
    function applyFixedPosition(el, left, top) {
        el.style.position  = 'fixed';
        el.style.left      = left + 'px';
        el.style.top       = top  + 'px';
        el.style.right     = 'auto';
        el.style.bottom    = 'auto';
        el.style.margin    = '0';
        el.style.transform = 'none';
    }

    function clampToViewport(el) {
        if (!el.style.left) return;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        const maxX = window.innerWidth  - rect.width  - EDGE_SNAP;
        const maxY = window.innerHeight - rect.height - EDGE_SNAP;
        const cL   = Math.max(EDGE_SNAP, Math.min(rect.left, maxX));
        const cT   = Math.max(EDGE_SNAP, Math.min(rect.top,  maxY));

        if (Math.abs(cL - rect.left) > 1 || Math.abs(cT - rect.top) > 1) {
            el.style.left   = cL + 'px';
            el.style.top    = cT + 'px';
            el.style.right  = 'auto';
            el.style.bottom = 'auto';
        }
    }

    /* ─── Persistencia (IndexedDB keyval) ─── */
    function storageKey(key) { return STORAGE_PREFIX + key; }

    function savePosition(w) {
        if (!w.content || !w.key) {
            log.warn('⚠ savePosition: ventana inválida', w.key);
            return;
        }

        // No guardar si la ventana está oculta (ancho/alto 0)
        const rect = w.content.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            log.warn(`⚠ savePosition ignorada para "${w.key}" (ventana invisible)`);
            return;
        }

        w.savedLeft = rect.left;
        w.savedTop  = rect.top;

        try {
            const data = { left: rect.left, top: rect.top, moved: w.wasMoved };
            VP.db.guardarKeyVal(storageKey(w.key), data);
            log.info(`💾 Guardada "${w.key}":`, data);
        } catch (e) {
            log.warn('Error al guardar en keyval:', e);
        }
    }

    function restorePosition(w) {
        // 1. Memoria
        if (w.savedLeft !== null && w.savedTop !== null) {
            applyFixedPosition(w.content, w.savedLeft, w.savedTop);
            log.info(`🔄 Restaurada "${w.key}" desde memoria:`, w.savedLeft, w.savedTop);
            return true;
        }

        // 2. keyval store
        try {
            const data = VP.db.obtenerKeyVal(storageKey(w.key));
            if (data && typeof data.left === 'number' && typeof data.top === 'number') {
                w.savedLeft = data.left;
                w.savedTop  = data.top;
                w.wasMoved  = data.moved === true;
                applyFixedPosition(w.content, data.left, data.top);
                log.info(`🔄 Restaurada "${w.key}" desde keyval:`, data.left, data.top);
                return true;
            }
        } catch (e) {
            try { VP.db.eliminarKeyVal(storageKey(w.key)); } catch (ex) {}
        }
        log.info(`⚠ Sin posición guardada para "${w.key}", se centrará.`);
        return false;
    }

    /* ─── Z-index ─── */
    function bringToFront(w) {
        zCounter++;
        w.content.style.zIndex = zCounter;
        w.content.classList.add('floating-focused');
        windows.forEach(o => { if (o !== w && o.content) o.content.classList.remove('floating-focused'); });
    }

    /* ─── Radios CSS ─── */
    function clearRadios(overlay) {
        overlay.querySelectorAll('.float-pos-input').forEach(r => { r.checked = false; });
    }

    function setupPositionRadios(w) {
        const radios = w.overlay.querySelectorAll('.float-pos-input');
        if (!radios.length) return;
        radios.forEach(radio => {
            radio.addEventListener('change', () => {
                w.content.style.left = w.content.style.top = w.content.style.right = w.content.style.bottom = '';
                w.content.style.transform = '';
                waitForRender(() => {
                    const rect = w.content.getBoundingClientRect();
                    applyFixedPosition(w.content, rect.left, rect.top);
                    clampToViewport(w.content);
                    w.wasMoved = true;
                    savePosition(w);
                });
            });
        });
    }

    /* ─── Observer de apertura/cierre ─── */
    function setupPositionObserver(w) {
        const obs = new MutationObserver(mutations => {
            for (const m of mutations) {
                if (m.attributeName !== 'class') continue;
                if (w.overlay.classList.contains('active')) {
                    onOpen(w);
                } else {
                    onClose(w);
                }
            }
        });
        w._observer = obs;
        obs.observe(w.overlay, { attributes: true, attributeFilter: ['class'] });
    }

    function onOpen(w) {
        if (_vpFloatState._destroyed || !w || !w.content) return;
        var mainEl = document.getElementById('main-content');
        if (mainEl) mainEl.inert = true;

        if (w.content.offsetWidth && w.content.offsetHeight) {
            clearRadios(w.overlay);

            var hasStored = VP.db.obtenerKeyVal(storageKey(w.key)) !== null;
            log.info(`📂 onOpen "${w.key}" | wasMoved: ${w.wasMoved} | keyval: ${!!hasStored}`);

            if ((w.wasMoved || hasStored) && restorePosition(w)) {
                clampToViewport(w.content);
                w.wasMoved = true;
            } else {
                log.info(`🎯 Centrando "${w.key}"`);
                placeCenterImmediate(w.content);
            }

            bringToFront(w);
        } else {
            waitForRender(() => {
                if (!w.content.offsetWidth || !w.content.offsetHeight) {
                    requestAnimationFrame(() => onOpen(w));
                    return;
                }
                onOpen(w);
            });
        }
    }

    function onClose(w) {
        if (_vpFloatState._destroyed || !w || !w.content) return;

        // Guardar usando los últimos valores en memoria, no el rect (que puede ser 0,0)
        if (w.savedLeft !== null && w.savedTop !== null) {
            // Ya tenemos posición fiable
            try {
                const data = { left: w.savedLeft, top: w.savedTop, moved: w.wasMoved };
                VP.db.guardarKeyVal(storageKey(w.key), data);
                log.info(`🚪 onClose "${w.key}" → guardada desde memoria:`, data);
            } catch (e) {}
        } else {
            log.info(`🚪 onClose "${w.key}" → sin posición en memoria, no se guarda.`);
        }

        w.content.classList.remove('floating-focused', 'floating-dragging');

        // Solo quitar inert si no queda ningún modal abierto
        var algunoAbierto = windows.some(function (o) {
            return o.overlay.classList.contains('active');
        });
        if (!algunoAbierto) {
            var mainEl = document.getElementById('main-content');
            if (mainEl) mainEl.inert = false;
        }
    }

    /* ─── Resize ─── */
    var _resizeSaveTimer = null;
    function onWindowResize() {
        if (_vpFloatState._destroyed) return;
        windows.forEach(function (w) {
            if (!w.overlay.classList.contains('active')) return;
            clampToViewport(w.content);
        });
        // Debounce escritura IDB: agrupar todos los saves en un solo timer
        clearTimeout(_resizeSaveTimer);
        _resizeSaveTimer = setTimeout(function () {
            if (_vpFloatState._destroyed) return;
            windows.forEach(function (w) {
                if (!w.overlay.classList.contains('active')) return;
                savePosition(w);
            });
        }, 400);
    }

    /* ─── Destruir ─── */
    function _destroy() {
        _vpFloatState._destroyed = true;
        clearTimeout(_resizeSaveTimer);
        activeWin = null;
        // Remove document/window listeners
        for (var i = 0; i < _vpFloatState._docListeners.length; i++) {
            var l = _vpFloatState._docListeners[i];
            try { l.target.removeEventListener(l.event, l.handler); } catch (_) {}
        }
        _vpFloatState._docListeners.length = 0;
        _debouncedResize = null;

        // Disconnect gallery observer
        if (_vpFloatState._gObserver) {
            try { _vpFloatState._gObserver.disconnect(); } catch (_) {}
            _vpFloatState._gObserver = null;
        }

        // Disconnect per-window observers and clear
        for (var j = 0; j < windows.length; j++) {
            if (windows[j]._observer) {
                try { windows[j]._observer.disconnect(); } catch (_) {}
                windows[j]._observer = null;
            }
        }
        windows.length = 0;

        _vpFloatState._initialized = false;
        activeWin = null;
    }

    /* ─── API pública ─── */
    window.VPFloating = {
        register(id, key) { return registerById(id, key); },
        center(key)        { const w = find(key); if (w) animateCenterWindow(w); },
        focus(key)         { const w = find(key); if (w) bringToFront(w); },
        reset(key) {
            const w = find(key);
            if (w) {
                w.wasMoved = false;
                w.savedLeft = null;
                w.savedTop  = null;
                try { VP.db.eliminarKeyVal(storageKey(key)); } catch (e) {}
                log.info(`🧹 Reset "${key}"`);
            }
        },
        getAll() { return windows.map(w => ({ id: w.id, key: w.key })); },
        destroy: _destroy,
        debug() {
            return windows.map(w => ({
                id: w.id, key: w.key,
                wasMoved: w.wasMoved,
                saved: { left: w.savedLeft, top: w.savedTop },
                storage: (() => { try { return VP.db.obtenerKeyVal(storageKey(w.key)); } catch(e) { return null; } })()
            }));
        }
    };

    function find(key) { return windows.find(w => w.key === key) || null; }

    /* ─── Utilidades ─── */
    function waitForRender(fn) { requestAnimationFrame(() => requestAnimationFrame(fn)); }

    function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-flotante-ia.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})();
