'use strict';

// ============================================================
// VP-DOM.JS — VERSIÓN OPTIMIZADA PARA 500+ VIDEOS
// Acceso seguro al DOM, virtualización, pool de elementos,
// batch de operaciones y observadores de intersección.
// Debe cargarse después de vp-base.js y vp-utilidades.js
// ============================================================

(function (window, document) {

    // ============================================================
    // GUARD — DEPENDENCIA DE VP-BASE.JS
    // ============================================================

    var VP = window.VP;
    if (!VP) {
        throw new Error('[VP] vp-dom.js: vp-base.js debe cargarse primero.');
    }
    VP.log.setContext('DOM');

    // ============================================================
    // CONSTANTES DE RENDIMIENTO
    // ============================================================

    var PERF = Object.freeze({
        NULL_CACHE_MAX:      200,
        POOL_MAX_POR_TAG:    100,
        CHUNK_LIMPIAR:       25,
        CHUNK_DELAY:         10,
        RENDER_CHUNK_DELAY:  8,
        RENDER_CHUNK_SIZE:   20,
        BATCH_TIMEOUT:       16,
        IO_MARGEN:           '200px',
        IO_THRESHOLD:        0.01,
        NULL_WARN_MAX:       50,
        RAF_QUEUE_MAX:       50,
    });

    // ============================================================
    // NULL ELEMENT
    // ============================================================
    // CORRECCIÓN CRÍTICA:
    // El prototipo NO debe congelarse con Object.freeze() porque
    // el constructor necesita sobreescribir propiedades por instancia
    // (style, dataset, id).
    //
    // Solución: usar Object.defineProperties con writable:false
    // solo en las propiedades que deben ser compartidas e inmutables,
    // y dejar las instancias libres para sus propias propiedades.
    //
    // Alternativa más simple y robusta adoptada aquí:
    // NO congelar el prototipo. Las noops son funciones que no hacen
    // nada — no hay daño en que sean "mutables" en teoría.
    // ============================================================

    var _nullCache    = VP.cache.nullElCache  || Object.create(null);
    var _nullWarned   = VP.cache.nullElWarned || Object.create(null);
    var _nullCacheKeys = [];
    var _nullWarnCount = 0;

    VP.cache.nullElCache  = _nullCache;
    VP.cache.nullElWarned = _nullWarned;

    // ---- Noops compartidas (una sola copia en memoria) ----
    var _noop       = function () {};
    var _noopFalso  = function () { return false; };
    var _noopNulo   = function () { return null; };
    var _noopArr    = function () { return []; };
    var _noopStr    = function () { return ''; };
    var _noopPromOk = function () { return Promise.resolve(); };
    var _noopPromKo = function () {
        return Promise.reject(new Error('NullElement — operación no disponible'));
    };
    var _noopBCR    = function () {
        return {
            left: 0, top: 0, width: 1, height: 1,
            right: 1, bottom: 1, x: 0, y: 0,
        };
    };

    // ---- classList compartido e inmutable ----
    // No necesita ser por instancia porque todos los NullElements
    // hacen exactamente nada con las clases.
    var _sharedClassList = {
        add:      _noop,
        remove:   _noop,
        toggle:   _noopFalso,
        contains: _noopFalso,
        replace:  _noop,
        item:     _noopNulo,
        toString: _noopStr,
    };
    // NO congelar — ver nota arriba

    // ---- buffered / played / textTracks compartidos ----
    var _sharedBuffered = {
        length: 0,
        start:  _noop,
        end:    _noop,
    };
    var _sharedPlayed = {
        length: 0,
        start:  _noop,
        end:    _noop,
    };
    var _sharedTextTracks = { length: 0 };

    // ============================================================
    // PROTOTIPO DE NULL ELEMENT
    // ============================================================
    // REGLA: solo propiedades que son IGUALES para todas las
    // instancias van aquí. Las que varían por instancia (id, style,
    // dataset) se asignan en el constructor.
    // NO llamar Object.freeze() sobre este objeto.
    // ============================================================

    function NullElement(id) {
        // ---- Propiedades por instancia ----
        // Estas son las únicas que varían entre instancias.
        // Al asignarlas en el constructor se crean como
        // "own properties" y no interfieren con el prototipo.
        this.id      = typeof id === 'string' ? id : '__desconocido__';
        this.style   = Object.create(null);   // Objeto vacío independiente
        this.dataset = Object.create(null);   // Objeto vacío independiente
    }

    // Asignar prototipo DESPUÉS de definir el constructor
    NullElement.prototype = {
        // ---- Identificación ----
        __isNullElement:    true,
        // id, style, dataset → en constructor (por instancia)
        tagName:            'DIV',
        nodeType:           1,

        // ---- Contenido ----
        className:          '',
        innerHTML:          '',
        textContent:        '',
        title:              '',
        value:              '',
        checked:            false,
        disabled:           false,
        src:                '',
        href:               '',
        open:               false,

        // ---- Árbol DOM ----
        children:           [],
        parentNode:         null,
        parentElement:      null,
        firstChild:         null,
        lastChild:          null,
        nextSibling:        null,
        previousSibling:    null,

        // ---- Dimensiones ----
        offsetWidth:        0,
        offsetHeight:       0,
        offsetTop:          0,
        offsetLeft:         0,
        clientWidth:        0,
        clientHeight:       0,
        scrollWidth:        0,
        scrollHeight:       0,
        scrollTop:          0,
        scrollLeft:         0,

        // ---- classList compartido ----
        classList:          _sharedClassList,

        // ---- Métodos DOM ----
        addEventListener:    _noop,
        removeEventListener: _noop,
        dispatchEvent:       _noopFalso,
        appendChild:         _noop,
        removeChild:         _noop,
        remove:              _noop,
        contains:            _noopFalso,
        insertBefore:        _noop,
        replaceChild:        _noop,
        setAttribute:        _noop,
        getAttribute:        _noopNulo,
        removeAttribute:     _noop,
        hasAttribute:        _noopFalso,
        focus:               _noop,
        blur:                _noop,
        click:               _noop,
        scrollIntoView:      _noop,
        querySelector:       _noopNulo,
        querySelectorAll:    _noopArr,
        getBoundingClientRect: _noopBCR,

        // cloneNode devuelve la misma instancia
        // (suficiente para evitar crashes)
        cloneNode: function () { return this; },

        // ---- Video ----
        error:               null,
        videoWidth:          0,
        videoHeight:         0,
        paused:              true,
        ended:               false,
        volume:              1,
        muted:               false,
        currentTime:         0,
        duration:            NaN,
        playbackRate:        1,
        defaultPlaybackRate: 1,
        readyState:          0,
        networkState:        0,
        seeking:             false,
        autoplay:            false,
        loop:                false,
        controls:            false,
        preload:             'none',
        buffered:            _sharedBuffered,
        textTracks:          _sharedTextTracks,
        played:              _sharedPlayed,
        play:                _noopPromOk,
        pause:               _noop,
        load:                _noop,
        canPlayType:         _noopStr,
        requestPictureInPicture: _noopPromKo,
        getVideoPlaybackQuality: _noopNulo,

        // ---- Dialog ----
        showModal:           _noop,
        close:               _noop,

        // ---- Formulario ----
        submit:              _noop,
        reset:               _noop,
    };

    // ============================================================
    // LRU EVICTION DEL CACHE DE NULL ELEMENTS
    // ============================================================

    function _evictarNullCache() {
        var sobrante = _nullCacheKeys.length - PERF.NULL_CACHE_MAX;
        if (sobrante <= 0) return;
        var victimas = _nullCacheKeys.splice(0, sobrante);
        for (var i = 0; i < victimas.length; i++) {
            delete _nullCache[victimas[i]];
        }
    }

    function crearNullElement(id) {
        var clave = (typeof id === 'string' && id) ? id : '__desconocido__';

        if (_nullCache[clave]) return _nullCache[clave];

        var el = new NullElement(clave);

        _nullCache[clave] = el;
        _nullCacheKeys.push(clave);
        _evictarNullCache();

        return el;
    }

    VP.dom.limpiarNullCache = function () {
        var ids = Object.keys(_nullCache);
        for (var i = 0; i < ids.length; i++) {
            delete _nullCache[ids[i]];
        }
        _nullCacheKeys.length = 0;
        VP.log.debug('vp-dom: NullElement cache limpiado (' + ids.length + ' entradas).');
    };

    // ============================================================
    // POOL DE ELEMENTOS DOM
    // ============================================================

    var _pool = Object.create(null);
    var _poolStats = { hits: 0, misses: 0, devueltos: 0 };

    function _limpiarElementoDePool(el) {
        if (!el) return;
        try {
            el.innerHTML  = '';
            el.className  = '';
            el.removeAttribute('style');
            el.removeAttribute('id');
            el.removeAttribute('data-id');
            el.removeAttribute('data-index');
            el.removeAttribute('data-vs-idx');
            el.removeAttribute('title');
            el.removeAttribute('tabindex');
            el.removeAttribute('aria-label');
            el.removeAttribute('role');

            if (el.tagName === 'IMG') {
                el.removeAttribute('src');
                el.removeAttribute('alt');
            } else if (el.tagName === 'VIDEO') {
                try { el.pause(); } catch (_) {}
                el.removeAttribute('src');
                try { el.load(); } catch (_) {}
            }
        } catch (_) {}
    }

    function _contarPool() {
        var total = 0;
        var tags  = Object.keys(_pool);
        for (var i = 0; i < tags.length; i++) {
            total += _pool[tags[i]].length;
        }
        return total;
    }

    VP.dom.pool = {
        obtener: function (tag) {
            tag = (tag || 'DIV').toUpperCase();
            var lista = _pool[tag];
            if (lista && lista.length > 0) {
                _poolStats.hits++;
                var el = lista.pop();
                _limpiarElementoDePool(el);
                return el;
            }
            _poolStats.misses++;
            return document.createElement(tag);
        },

        devolver: function (el) {
            if (!el || !el.tagName) return;
            var tag   = el.tagName.toUpperCase();
            var lista = _pool[tag] || (_pool[tag] = []);

            if (lista.length >= PERF.POOL_MAX_POR_TAG) return;

            if (el.parentNode) {
                try { el.parentNode.removeChild(el); } catch (_) {}
            }
            _limpiarElementoDePool(el);
            lista.push(el);
            _poolStats.devueltos++;
        },

        devolverLista: function (elementos) {
            if (!elementos) return;
            for (var i = 0; i < elementos.length; i++) {
                VP.dom.pool.devolver(elementos[i]);
            }
        },

        stats: function () {
            return {
                hits:      _poolStats.hits,
                misses:    _poolStats.misses,
                devueltos: _poolStats.devueltos,
                enPool:    _contarPool(),
            };
        },

        vaciar: function () {
            var tags = Object.keys(_pool);
            for (var i = 0; i < tags.length; i++) {
                _pool[tags[i]].length = 0;
            }
            VP.log.debug('vp-dom: pool de elementos vaciado.');
        },
    };

    // ============================================================
    // BATCH DE OPERACIONES DOM (RAF)
    // ============================================================

    var _batchQueue = [];
    var _batchRafId = null;
    var _batchLock  = false;

    function _flushBatch() {
        _batchRafId = null;
        if (_batchLock) return;
        _batchLock = true;

        var CHUNK = 8;
        var queue = _batchQueue.slice(0);
        _batchQueue.length = 0;

        function ejecutarLote(inicio) {
            var fin = Math.min(inicio + CHUNK, queue.length);
            for (var i = inicio; i < fin; i++) {
                try {
                    queue[i]();
                } catch (e) {
                    VP.log.warn('vp-dom batch: error en operación', e);
                }
            }
            if (fin < queue.length) {
                _raf(function () { ejecutarLote(fin); });
            } else {
                _batchLock = false;
            }
        }
        ejecutarLote(0);
    }

    var _raf = window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : function (f) { return setTimeout(f, PERF.BATCH_TIMEOUT); };

    var _caf = window.cancelAnimationFrame
        ? window.cancelAnimationFrame.bind(window)
        : clearTimeout;

    VP.dom.batch = function (fn) {
        if (typeof fn !== 'function') return;

        if (_batchQueue.length >= PERF.RAF_QUEUE_MAX) {
            VP.log.warn('vp-dom: batch queue llena, ejecutando directamente.');
            try { fn(); } catch (e) { VP.log.warn('batch directo error:', e); }
            return;
        }

        _batchQueue.push(fn);
        if (!_batchRafId) {
            _batchRafId = _raf(_flushBatch);
        }
    };

    VP.dom.flushBatch = function () {
        if (_batchRafId) {
            _caf(_batchRafId);
            _batchRafId = null;
        }
        _flushBatch();
    };

    // ============================================================
    // FUNCIONES DE ACCESO AL DOM
    // ============================================================

    VP.dom.$ = function (id) {
        if (!id || typeof id !== 'string') {
            return crearNullElement('__id_invalido__');
        }
        return document.getElementById(id) || crearNullElement(id);
    };

    VP.dom.$$ = function (selector, raiz) {
        if (!selector || typeof selector !== 'string') return [];
        try {
            return (raiz || document).querySelectorAll(selector);
        } catch (e) {
            VP.log.warn('vp-dom.$$: selector inválido →', selector, e.message);
            return [];
        }
    };

    VP.dom.$q = function (selector, raiz) {
        if (!selector || typeof selector !== 'string') return null;
        try {
            return (raiz || document).querySelector(selector);
        } catch (e) {
            VP.log.warn('vp-dom.$q: selector inválido →', selector, e.message);
            return null;
        }
    };

    VP.dom.esNulo = function (el) {
        return !el || el.__isNullElement === true;
    };

    VP.dom.estaConectado = function (el) {
        if (!el || VP.dom.esNulo(el)) return false;
        if (typeof el.isConnected === 'boolean') return el.isConnected;
        try {
            return document.body ? document.body.contains(el) : false;
        } catch (_) {
            return false;
        }
    };

    // ============================================================
    // CACHÉ DE REFERENCIAS DOM
    // ============================================================
    // CORRECCIÓN: eliminar refs.virtualScroller y refs.virtualContent
    // porque esos elementos no existen en el HTML.
    // El scroller virtual se crea dinámicamente cuando se necesita.
    // ============================================================

    VP.dom.cachearRefs = function () {
        var $    = VP.dom.$;
        var $q   = VP.dom.$q;
        var refs = VP.refs;

        // ---- Reproductor principal ----
        refs.videoPlayer        = $('videoPlayer');
        refs.videoPlayerWrap    = $('videoPlayerWrap');
        refs.loadingOverlay     = $('loadingOverlay');
        refs.emptyState         = $('emptyState');
        refs.videoControls      = $('videoControls');

        // ---- Barra de progreso ----
        refs.progressContainer  = $('progressContainer');
        refs.progressBar        = $('progressBar');
        refs.progressBuffered   = $('progressBuffered');
        refs.progressScrubber   = $('progressScrubber');
        refs.progressHoverTime  = $('progressHoverTime');

        // ---- Preview hover ----
        refs.hoverPreview       = $('hoverPreview');
        refs.hoverPreviewImg    = $('hoverPreviewImg');
        refs.hoverPreviewTime   = $('hoverPreviewTime');
        refs.hoverPreviewChapter= $('hoverPreviewChapter');

        // ---- Controles de reproducción ----
        refs.playPauseBtn       = $('playPauseBtn');
        refs.iconPlay           = $('iconPlay');
        refs.iconPause          = $('iconPause');
        refs.centerPlayOverlay  = $('centerPlayOverlay');
        refs.centerPlayBtn      = $('centerPlayBtn');
        refs.centerIconPlay     = $('centerIconPlay');
        refs.centerIconPause    = $('centerIconPause');
        refs.prevBtn            = $('prevBtn');
        refs.nextBtn            = $('nextBtn');

        // ---- Título del video ----
        refs.videoTitleOverlay  = $('videoTitleOverlay');

        // ---- Up Next ----
        refs.upNextOverlay      = $('upNextOverlay');
        refs.upNextThumb        = $('upNextThumb');
        refs.upNextTitle        = $('upNextTitle');
        refs.upNextCountdown    = $('upNextCountdown');
        refs.cancelUpNextBtn    = $('cancelUpNext');

        // ---- Volumen ----
        refs.volumeBtn          = $('volumeBtn');
        refs.volumeSlider       = $('volumeSlider');
        refs.volumeBar          = $('volumeBar');
        refs.iconVolUp          = $('iconVolUp');
        refs.iconVolDown        = $('iconVolDown');
        refs.iconMute           = $('iconMute');

        // ---- Velocidad ----
        refs.speedBtn           = $('speedBtn');
        refs.speedMenu          = $('speedMenu');

        // ---- Fullscreen ----
        refs.fullscreenBtn      = $('fullscreenBtn');
        refs.iconExpand         = $('iconExpand');
        refs.iconCompress       = $('iconCompress');

        // ---- Otros controles ----
        refs.snapshotBtn        = $('snapshotBtn');
        refs.subtitleBtn        = $('subtitleBtn');
        refs.ttsVolumeBtn       = $('ttsVolumeBtn');
        refs.ttsVolumeSlider    = $('ttsVolumeSlider');
        refs.ttsVolumeBar       = $('ttsVolumeBar');
        refs.ttsIconVolUp       = $('ttsIconVolUp');
        refs.ttsIconVolDown     = $('ttsIconVolDown');
        refs.ttsIconMute        = $('ttsIconMute');
        refs.pipBtn             = $('pipBtn');
        refs.hdrBtn             = $('hdrBtn');
        refs.loopBtn            = $('loopBtn');
        refs.shuffleBtn         = $('shuffleBtn');
        refs.abRepeatBtn        = $('abRepeatBtn');
        refs.chapterBtn         = $('chapterBtn');
        refs.statsBtn           = $('statsBtn');
        refs.statsPanel         = $('statsPanel');

        // ---- Tiempo ----
        refs.timeDisplay        = $('timeDisplay');

        // ---- Galería ----
        refs.galleryEl          = $('gallery');
        refs.galleryEmpty       = $('galleryEmpty');
        refs.gallerySectionWrap = $('gallerySectionWrap');
        refs.addVideosBtn       = $('addVideosBtn');
        refs.addFilesBtn        = $('addFilesBtn');

        // ---- Playlist ----
        refs.playlistEl         = $('playlistEl');
        refs.playlistEmpty      = $('playlistEmpty');
        refs.playlistSection    = $q('.playlist-section');

        // ---- Búsqueda ----
        refs.searchInput        = $('search-input');

        // ---- Ajustes ----
        refs.settingsBtn        = $('settingsBtn');
        refs.settingsModal      = $('settingsModal');
        refs.modalClose         = $('modalClose');
        refs.saveSettingsBtn    = $('saveSettingsBtn');
        refs.clearCacheBtn      = $('clearCacheBtn');

        // ---- Checkboxes de ajustes ----
        refs.autoResumeChk          = $('autoResume');
        refs.genThumbChk            = $('genThumb');
        refs.enablePreviewChk       = $('enablePreviews');
        refs.enableShortChk         = $('enableShortcuts');
        refs.sleepTimerInput        = $('sleepTimer');
        refs.pinPlayerChk           = $('pinPlayer');
        refs.pinHeaderChk           = $('pinHeader');
        refs.enableMochiAiChk       = $('enableMochiAi');
        refs.mochiVoiceEnabledChk   = $('mochiVoiceEnabled');
        refs.playlistScrollIndepChk = $('playlistScrollIndep');
        refs.galleryScrollIndepChk  = $('galleryScrollIndep');
        refs.ultraPerfChk           = $('ultraPerformance');
        refs.accentColorPicker      = $('accentColorPicker');

        // ---- Import / Export ----
        refs.exportConfigBtn    = $('exportConfigBtn');
        refs.importConfigBtn    = $('importConfigBtn');
        refs.importConfigInput  = $('importConfigInput');

        // ---- Notificaciones ----
        refs.notification       = $('notification');
        refs.notifIcon          = $('notifIcon');
        refs.notifMsg           = $('notifMsg');
        refs.notifClose         = $('notifClose');

        // ---- Atajos de teclado ----
        refs.shortcutsPanel     = $('shortcutsPanel');
        refs.shortcutsClose     = $('shortcutsClose');

        // ---- Entrada de archivos ----
        refs.fileInput          = $('fileInput');
        refs.folderInput        = $('folderInput');

        // NOTA: virtualScroller y virtualContent se crean
        // dinámicamente — no cachear aquí.

        VP.log.info('vp-dom.js: referencias DOM cacheadas correctamente.');
        VP.dom._verificarRefsEsenciales();
    };

    // ============================================================
    // VERIFICACIÓN DE REFERENCIAS ESENCIALES
    // ============================================================

    VP.dom._verificarRefsEsenciales = function () {
        var esenciales = [
            'videoPlayer',
            'videoPlayerWrap',
            'galleryEl',
            'playlistEl',
            'progressContainer',
            'progressBar',
        ];

        var faltantes = [];
        for (var i = 0; i < esenciales.length; i++) {
            var ref = VP.refs[esenciales[i]];
            if (!ref || VP.dom.esNulo(ref)) {
                faltantes.push(esenciales[i]);
            }
        }

        if (faltantes.length > 0) {
            VP.log.error(
                'vp-dom.js: elementos esenciales no encontrados en el DOM:',
                faltantes.join(', ')
            );
        } else {
            VP.log.debug('vp-dom.js: todos los elementos esenciales encontrados.');
        }

        return faltantes.length === 0;
    };

    // ============================================================
    // REVOCACIÓN DE BLOB URLS
    // ============================================================

    function _revocarBlobsDeElemento(nodo) {
        if (!nodo || typeof nodo.querySelectorAll !== 'function') return;
        try {
            var conSrc = nodo.querySelectorAll('[src^="blob:"]');
            for (var i = 0; i < conSrc.length; i++) {
                try {
                    if (VP.revocarBlobURL) VP.revocarBlobURL(conSrc[i].src);
                } catch (_) {}
            }
        } catch (_) {}
    }

    // ============================================================
    // LIMPIEZA DE VIDEOS DE PREVIEW
    // ============================================================

    VP.dom._limpiarVideosPreview = function (nodo) {
        if (!nodo || typeof nodo.querySelectorAll !== 'function') return;
        try {
            var vids = nodo.querySelectorAll('.thumbnail-preview video');
            for (var i = 0; i < vids.length; i++) {
                try {
                    vids[i].pause();
                    var src = vids[i].src;
                    vids[i].removeAttribute('src');
                    vids[i].load();
                    if (src && src.indexOf('blob:') === 0) {
                        if (VP.revocarBlobURL) VP.revocarBlobURL(src);
                    }
                } catch (_) {}
            }
        } catch (_) {}
    };

    // ============================================================
    // LIMPIEZA ASÍNCRONA DE HIJOS — PARA 500+ NODOS
    // ============================================================

    VP.dom.limpiarHijosAsync = function (padre, claseExcluir, onComplete) {
        if (!padre || VP.dom.esNulo(padre)) {
            if (typeof onComplete === 'function') onComplete();
            return;
        }

        var hijos    = padre.children;
        var eliminar = [];

        for (var c = 0; c < hijos.length; c++) {
            var hijo = hijos[c];
            if (claseExcluir &&
                hijo.classList &&
                hijo.classList.contains(claseExcluir)) continue;
            eliminar.push(hijo);
        }

        if (eliminar.length === 0) {
            if (typeof onComplete === 'function') onComplete();
            return;
        }

        VP.log.debug(
            'vp-dom.limpiarHijosAsync: ' + eliminar.length +
            ' nodos en chunks de ' + PERF.CHUNK_LIMPIAR
        );

        var indice = 0;

        function procesarChunk() {
            var limite = Math.min(indice + PERF.CHUNK_LIMPIAR, eliminar.length);

            for (var i = indice; i < limite; i++) {
                var el = eliminar[i];

                // Llamar destructor si existe
                try {
                    var datos = VP.getDomData ? VP.getDomData(el) : null;
                    if (datos && typeof datos.destruir === 'function') {
                        datos.destruir();
                    }
                } catch (_) {}

                VP.dom._limpiarVideosPreview(el);
                _revocarBlobsDeElemento(el);

                if (el.parentNode === padre) {
                    try { padre.removeChild(el); } catch (_) {}
                }

                VP.dom.pool.devolver(el);
            }

            indice = limite;

            if (indice < eliminar.length) {
                setTimeout(procesarChunk, PERF.CHUNK_DELAY);
            } else {
                VP.log.debug('vp-dom.limpiarHijosAsync: completo.');
                if (typeof onComplete === 'function') {
                    try { onComplete(); } catch (_) {}
                }
            }
        }

        procesarChunk();
    };

    // ---- Versión síncrona para listas < 50 items ----
    VP.dom.limpiarHijos = function (padre, claseExcluir) {
        if (!padre || VP.dom.esNulo(padre)) return;

        var hijos    = padre.children;
        var eliminar = [];

        for (var c = 0; c < hijos.length; c++) {
            if (claseExcluir &&
                hijos[c].classList &&
                hijos[c].classList.contains(claseExcluir)) continue;
            eliminar.push(hijos[c]);
        }

        for (var r = 0; r < eliminar.length; r++) {
            var el = eliminar[r];

            try {
                var datos = VP.getDomData ? VP.getDomData(el) : null;
                if (datos && typeof datos.destruir === 'function') {
                    datos.destruir();
                }
            } catch (_) {}

            VP.dom._limpiarVideosPreview(el);
            _revocarBlobsDeElemento(el);

            if (el.parentNode) {
                try { el.parentNode.removeChild(el); } catch (_) {}
            }
        }
    };

    // ============================================================
    // RENDERIZADO MASIVO CON FRAGMENTOS
    // ============================================================

    VP.dom.renderizarLista = function (opciones) {
        if (!opciones || typeof opciones !== 'object') return;

        var datos        = opciones.datos         || [];
        var contenedor   = opciones.contenedor;
        var crearEl      = opciones.crearElemento;
        var onProgreso   = opciones.onProgreso;
        var onCompleto   = opciones.onCompleto;
        var claseExcluir = opciones.claseExcluir  || null;
        var limpiar      = opciones.limpiarAntes  !== false;
        var chunkSize    = opciones.chunkSize     || PERF.RENDER_CHUNK_SIZE;

        if (!contenedor || VP.dom.esNulo(contenedor)) {
            VP.log.warn('vp-dom.renderizarLista: contenedor inválido.');
            if (typeof onCompleto === 'function') onCompleto();
            return;
        }

        if (typeof crearEl !== 'function') {
            VP.log.warn('vp-dom.renderizarLista: crearElemento no es función.');
            if (typeof onCompleto === 'function') onCompleto();
            return;
        }

        var total = datos.length;

        VP.log.debug(
            'vp-dom.renderizarLista: ' + total +
            ' items, chunks de ' + chunkSize
        );

        function ejecutar() {
            if (limpiar) {
                VP.dom.limpiarHijos(contenedor, claseExcluir);
            }

            if (total === 0) {
                if (typeof onCompleto === 'function') {
                    try { onCompleto(); } catch (_) {}
                }
                return;
            }

            var indice = 0;

            function procesarChunk() {
                var fragment = document.createDocumentFragment();
                var limite   = Math.min(indice + chunkSize, total);
                var errores  = 0;

                for (var i = indice; i < limite; i++) {
                    try {
                        var el = crearEl(datos[i], i);
                        if (el && el.nodeType) {
                            fragment.appendChild(el);
                        }
                    } catch (e) {
                        errores++;
                        if (errores <= 3) {
                            VP.log.warn(
                                'vp-dom.renderizarLista: error en item ' + i,
                                e.message
                            );
                        }
                    }
                }

                try {
                    contenedor.appendChild(fragment);
                } catch (e) {
                    VP.log.error(
                        'vp-dom.renderizarLista: error al insertar fragment', e
                    );
                }

                indice = limite;

                if (typeof onProgreso === 'function') {
                    try { onProgreso(indice, total); } catch (_) {}
                }

                if (indice < total) {
                    setTimeout(procesarChunk, PERF.RENDER_CHUNK_DELAY);
                } else {
                    VP.log.debug(
                        'vp-dom.renderizarLista: completo (' + total + ' items)'
                    );
                    if (typeof onCompleto === 'function') {
                        try { onCompleto(); } catch (_) {}
                    }
                }
            }

            procesarChunk();
        }

        VP.dom.batch(ejecutar);
    };

    // ============================================================
    // SCROLLER VIRTUAL
    // ============================================================

    VP.dom.crearScrollerVirtual = function (opciones) {
        if (!opciones) return null;

        var contenedor     = opciones.contenedor;
        var datos          = opciones.datos          || [];
        var alturaItem     = opciones.alturaItem     || 80;
        var crearItem      = opciones.crearItem;
        var actualizarItem = opciones.actualizarItem;
        var overscan       = opciones.overscan       || 5;

        if (!contenedor || VP.dom.esNulo(contenedor)) {
            VP.log.warn('crearScrollerVirtual: contenedor inválido.');
            return null;
        }
        if (typeof crearItem !== 'function') {
            VP.log.warn('crearScrollerVirtual: crearItem no es función.');
            return null;
        }

        var _datos         = datos.slice();
        var _rafId         = null;
        var _destruido     = false;
        var _nodosMontados = Object.create(null);

        var spacerTop = document.createElement('div');
        spacerTop.style.cssText = 'width:100%;pointer-events:none;flex-shrink:0;';

        var spacerBot = document.createElement('div');
        spacerBot.style.cssText = 'width:100%;pointer-events:none;flex-shrink:0;';

        var montados = document.createElement('div');

        contenedor.appendChild(spacerTop);
        contenedor.appendChild(montados);
        contenedor.appendChild(spacerBot);

        function _calcularRango() {
            var scrollTop     = contenedor.scrollTop  || 0;
            var alturaVisible = contenedor.clientHeight || 400;
            var primer = Math.max(
                0,
                Math.floor(scrollTop / alturaItem) - overscan
            );
            var ultimo = Math.min(
                _datos.length - 1,
                Math.ceil((scrollTop + alturaVisible) / alturaItem) + overscan
            );
            return { primer: primer, ultimo: ultimo };
        }

        function _montar(indice) {
            if (_nodosMontados[indice]) return;
            var dato = _datos[indice];
            if (dato === undefined) return;
            var el;
            try { el = crearItem(dato, indice); } catch (e) {
                VP.log.warn('scrollerVirtual._montar idx=' + indice, e);
                return;
            }
            if (!el || !el.nodeType) return;
            el.style.height    = alturaItem + 'px';
            el.style.boxSizing = 'border-box';
            el.dataset.vsIdx   = String(indice);
            montados.appendChild(el);
            _nodosMontados[indice] = el;
        }

        function _desmontar(indice) {
            var el = _nodosMontados[indice];
            if (!el) return;
            VP.dom.pool.devolver(el);
            delete _nodosMontados[indice];
        }

        function _actualizarItem(indice) {
            var el = _nodosMontados[indice];
            if (!el || typeof actualizarItem !== 'function') return;
            try { actualizarItem(el, _datos[indice], indice); } catch (e) {
                VP.log.warn('scrollerVirtual._actualizarItem idx=' + indice, e);
            }
        }

        function _render() {
            if (_destruido) return;
            var rango  = _calcularRango();
            var primer = rango.primer;
            var ultimo = rango.ultimo;

            // Desmontar fuera de rango
            var keys = Object.keys(_nodosMontados);
            for (var k = 0; k < keys.length; k++) {
                var idx = parseInt(keys[k], 10);
                if (idx < primer || idx > ultimo) _desmontar(idx);
            }

            // Montar en rango
            for (var i = primer; i <= ultimo; i++) {
                if (!_nodosMontados[i]) {
                    _montar(i);
                } else {
                    _actualizarItem(i);
                }
            }

            // Ajustar spacers
            spacerTop.style.height =
                (primer * alturaItem) + 'px';
            spacerBot.style.height =
                Math.max(0, (_datos.length - ultimo - 1) * alturaItem) + 'px';
        }

        function _onScroll() {
            if (_rafId) return;
            _rafId = _raf(function () {
                _rafId = null;
                if (!_destruido) _render();
            });
        }

        _render();
        contenedor.addEventListener('scroll', _onScroll, { passive: true });

        return {
            setDatos: function (nuevosDatos) {
                var keys = Object.keys(_nodosMontados);
                for (var k = 0; k < keys.length; k++) {
                    _desmontar(parseInt(keys[k], 10));
                }
                _datos = (nuevosDatos || []).slice();
                _render();
            },
            actualizarDato: function (indice, nuevoDato) {
                if (indice < 0 || indice >= _datos.length) return;
                _datos[indice] = nuevoDato;
                _actualizarItem(indice);
            },
            scrollAIdx: function (indice, comportamiento) {
                if (indice < 0 || indice >= _datos.length) return;
                var top = indice * alturaItem;
                try {
                    contenedor.scrollTo({
                        top:      top,
                        behavior: comportamiento || 'smooth',
                    });
                } catch (_) {
                    contenedor.scrollTop = top;
                }
            },
            refrescar: function () { _render(); },
            getMontados: function () {
                return Object.keys(_nodosMontados).length;
            },
            destruir: function () {
                _destruido = true;
                if (_rafId) { _caf(_rafId); _rafId = null; }
                contenedor.removeEventListener('scroll', _onScroll);
                var keys = Object.keys(_nodosMontados);
                for (var k = 0; k < keys.length; k++) {
                    _desmontar(parseInt(keys[k], 10));
                }
                try { contenedor.removeChild(spacerTop); } catch (_) {}
                try { contenedor.removeChild(montados);  } catch (_) {}
                try { contenedor.removeChild(spacerBot); } catch (_) {}
                VP.log.debug('crearScrollerVirtual: destruido.');
            },
        };
    };

    // ============================================================
    // INTERSECTION OBSERVER — LAZY RENDER
    // ============================================================

    var _observerInstancia = null;

    // Almacenamiento de callbacks compatible con entornos sin Map
    var _obsCallbacks;
    var _usarMap = typeof Map !== 'undefined';
    if (_usarMap) {
        _obsCallbacks = new Map();
    } else {
        _obsCallbacks = Object.create(null);
    }
    var _obsIdCounter = 0;

    function _obsRegistrar(el, callback) {
        if (_usarMap) {
            _obsCallbacks.set(el, callback);
        } else {
            if (!el._vpObsId) {
                el._vpObsId = '__obs' + (++_obsIdCounter) + '__';
            }
            _obsCallbacks[el._vpObsId] = callback;
        }
    }

    function _obsObtener(el) {
        if (_usarMap) return _obsCallbacks.get(el);
        return el._vpObsId ? _obsCallbacks[el._vpObsId] : null;
    }

    function _obsEliminar(el) {
        if (_usarMap) {
            _obsCallbacks.delete(el);
        } else {
            if (el._vpObsId) {
                delete _obsCallbacks[el._vpObsId];
                try { delete el._vpObsId; } catch (_) {}
            }
        }
    }

    function _inicializarObserver() {
        if (_observerInstancia) return;
        if (typeof IntersectionObserver === 'undefined') {
            VP.log.warn('vp-dom: IntersectionObserver no disponible.');
            return;
        }
        _observerInstancia = new IntersectionObserver(
            function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    var entry = entries[i];
                    var cb    = _obsObtener(entry.target);
                    if (typeof cb === 'function') {
                        try { cb(entry.isIntersecting, entry); } catch (e) {
                            VP.log.warn('vp-dom observer callback:', e);
                        }
                    }
                }
            },
            {
                rootMargin: PERF.IO_MARGEN,
                threshold:  PERF.IO_THRESHOLD,
            }
        );
        VP.log.debug('vp-dom: IntersectionObserver inicializado.');
    }

    VP.dom.observar = function (el, callback) {
        if (!el || VP.dom.esNulo(el)) return;
        if (typeof callback !== 'function') return;

        _inicializarObserver();

        if (!_observerInstancia) {
            // Fallback inmediato
            try { callback(true, null); } catch (_) {}
            return;
        }
        _obsRegistrar(el, callback);
        _observerInstancia.observe(el);
    };

    VP.dom.desObservar = function (el) {
        if (!el || !_observerInstancia) return;
        try { _observerInstancia.unobserve(el); } catch (_) {}
        _obsEliminar(el);
    };

    VP.dom.destruirObserver = function () {
        if (!_observerInstancia) return;
        try { _observerInstancia.disconnect(); } catch (_) {}
        _observerInstancia = null;
        if (_usarMap) {
            _obsCallbacks.clear();
        } else {
            _obsCallbacks = Object.create(null);
        }
        VP.log.debug('vp-dom: IntersectionObserver destruido.');
    };

    // ============================================================
    // CREACIÓN DE ELEMENTOS OPTIMIZADA
    // ============================================================

    VP.dom.crearElemento = function (tag, atributos, estilos, usarPool) {
        var el = usarPool
            ? VP.dom.pool.obtener(tag)
            : document.createElement(tag || 'div');

        if (atributos && typeof atributos === 'object') {
            var claves = Object.keys(atributos);
            for (var i = 0; i < claves.length; i++) {
                var clave = claves[i];
                var valor = atributos[clave];
                if (valor === null || valor === undefined) continue;

                switch (clave) {
                    case 'className':
                        el.className = valor;
                        break;
                    case 'textContent':
                        el.textContent = valor;
                        break;
                    case 'innerHTML':
                        el.innerHTML = VP.util && typeof VP.util.sanitizarHTMLBasico === 'function'
                            ? VP.util.sanitizarHTMLBasico(String(valor))
                            : String(valor);
                        break;
                    case 'id':
                        el.id = valor;
                        break;
                    case 'tabIndex':
                    case 'tabindex':
                        el.tabIndex = parseInt(valor, 10) || 0;
                        break;
                    default:
                        try { el.setAttribute(clave, valor); } catch (_) {}
                }
            }
        }

        if (estilos && typeof estilos === 'object') {
            var props = Object.keys(estilos);
            for (var j = 0; j < props.length; j++) {
                try {
                    el.style[props[j]] = estilos[props[j]];
                } catch (_) {}
            }
        }

        return el;
    };

    VP.dom.setTexto = function (el, texto) {
        if (!el || VP.dom.esNulo(el)) return false;
        try {
            el.textContent = texto == null ? '' : String(texto);
            return true;
        } catch (_) { return false; }
    };

    VP.dom.setHTMLSeguro = function (el, html) {
        if (!el || VP.dom.esNulo(el)) return false;
        try {
            if (VP.util && typeof VP.util.insertarHTMLSeguro === 'function') {
                VP.util.insertarHTMLSeguro(el, String(html || ''), { sanitizar: true });
            } else {
                el.textContent = String(html || '');
            }
            return true;
        } catch (_) { return false; }
    };

    VP.dom.rectSeguro = function (el) {
        try {
            if (!el || VP.dom.esNulo(el) || typeof el.getBoundingClientRect !== 'function') {
                return { left: 0, top: 0, width: 0, height: 0 };
            }
            var r = el.getBoundingClientRect();
            return {
                left: Number(r.left) || 0,
                top: Number(r.top) || 0,
                width: Math.max(0, Number(r.width) || 0),
                height: Math.max(0, Number(r.height) || 0)
            };
        } catch (_) {
            return { left: 0, top: 0, width: 0, height: 0 };
        }
    };

    // ============================================================
    // GESTIÓN CENTRALIZADA DE LISTENERS
    // ============================================================

    var _registroListeners = [];
    var _MAX_LISTENERS     = 5000;

    VP.dom.agregarListeners = function (el, eventos, registrar) {
        if (!el || VP.dom.esNulo(el)) return;
        if (!eventos || typeof eventos !== 'object') return;

        var debeRegistrar = registrar !== false;
        var claves        = Object.keys(eventos);

        for (var i = 0; i < claves.length; i++) {
            var evento   = claves[i];
            var opciones = null;
            var fn       = eventos[evento];

            if (fn && typeof fn === 'object' && typeof fn.fn === 'function') {
                opciones = fn.opciones !== undefined ? fn.opciones : null;
                fn       = fn.fn;
            }

            if (typeof fn !== 'function') continue;

            try {
                if (opciones !== null) {
                    el.addEventListener(evento, fn, opciones);
                } else {
                    el.addEventListener(evento, fn);
                }

                if (debeRegistrar &&
                    _registroListeners.length < _MAX_LISTENERS) {
                    _registroListeners.push({
                        el:       el,
                        evento:   evento,
                        fn:       fn,
                        opciones: opciones,
                    });
                }
            } catch (e) {
                VP.log.warn(
                    'vp-dom.agregarListeners: error "' + evento + '"',
                    e.message
                );
            }
        }
    };

    VP.dom.removerListenersDeElemento = function (el) {
        if (!el) return;
        var restantes = [];
        for (var i = 0; i < _registroListeners.length; i++) {
            var reg = _registroListeners[i];
            if (reg.el === el) {
                try {
                    if (reg.opciones !== null) {
                        el.removeEventListener(reg.evento, reg.fn, reg.opciones);
                    } else {
                        el.removeEventListener(reg.evento, reg.fn);
                    }
                } catch (_) {}
            } else {
                restantes.push(reg);
            }
        }
        _registroListeners = restantes;
    };

    VP.dom.limpiarTodosLosListeners = function () {
        var total = _registroListeners.length;
        for (var i = 0; i < _registroListeners.length; i++) {
            var reg = _registroListeners[i];
            try {
                if (reg.el && !VP.dom.esNulo(reg.el)) {
                    if (reg.opciones !== null) {
                        reg.el.removeEventListener(reg.evento, reg.fn, reg.opciones);
                    } else {
                        reg.el.removeEventListener(reg.evento, reg.fn);
                    }
                }
            } catch (_) {}
        }
        _registroListeners.length = 0;
        VP.log.debug('vp-dom: ' + total + ' listeners limpiados.');
    };

    VP.dom.statsListeners = function () {
        return {
            total:      _registroListeners.length,
            maximo:     _MAX_LISTENERS,
            porcentaje: ((_registroListeners.length / _MAX_LISTENERS) * 100)
                            .toFixed(1) + '%',
        };
    };

    // ============================================================
    // DELEGACIÓN DE EVENTOS
    // ============================================================

    VP.dom.delegarEvento = function (contenedor, evento, selector, callback, opciones) {
        if (!contenedor || VP.dom.esNulo(contenedor)) return _noop;
        if (typeof callback !== 'function') return _noop;

        function handler(e) {
            var target = e.target;
            while (target && target !== contenedor) {
                var coincide = false;
                try {
                    coincide = typeof target.matches === 'function'
                        ? target.matches(selector)
                        : (target.msMatchesSelector
                            ? target.msMatchesSelector(selector)
                            : false);
                } catch (_) {}

                if (coincide) {
                    try { callback(e, target); } catch (err) {
                        VP.log.warn(
                            'vp-dom.delegarEvento "' + evento + '" error:',
                            err.message
                        );
                    }
                    return;
                }
                target = target.parentElement;
            }
        }

        try {
            if (opciones) {
                contenedor.addEventListener(evento, handler, opciones);
            } else {
                contenedor.addEventListener(evento, handler);
            }
        } catch (e) {
            VP.log.warn('vp-dom.delegarEvento: error al agregar listener', e.message);
            return _noop;
        }

        if (_registroListeners.length < _MAX_LISTENERS) {
            _registroListeners.push({
                el:       contenedor,
                evento:   evento,
                fn:       handler,
                opciones: opciones || null,
            });
        }

        return function () {
            try {
                if (opciones) {
                    contenedor.removeEventListener(evento, handler, opciones);
                } else {
                    contenedor.removeEventListener(evento, handler);
                }
            } catch (_) {}
        };
    };

    // ============================================================
    // SCROLL
    // ============================================================

    VP.dom.scrollHacia = function (el, comportamiento) {
        if (!el || VP.dom.esNulo(el)) return;
        try {
            el.scrollIntoView({
                block:    'nearest',
                behavior: comportamiento || 'smooth',
            });
        } catch (_) {
            try { el.scrollIntoView(false); } catch (__) {}
        }
    };

    VP.dom.onScrollThrottled = function (contenedor, callback, delay) {
        if (!contenedor || VP.dom.esNulo(contenedor)) return _noop;
        if (typeof callback !== 'function') return _noop;

        var _ticking = false;

        function handler() {
            if (_ticking) return;
            _ticking = true;
            _raf(function () {
                try { callback(); } catch (e) {
                    VP.log.warn('onScrollThrottled error:', e);
                }
                _ticking = false;
            });
        }

        contenedor.addEventListener('scroll', handler, { passive: true });

        return function () {
            contenedor.removeEventListener('scroll', handler);
        };
    };

    // ============================================================
    // ARIA LIVE
    // ============================================================

    VP.dom.ariaLive = (function () {
        var el    = null;
        var timer = null;

        function inicializar() {
            if (el) return;
            el = document.createElement('div');
            el.setAttribute('role',        'status');
            el.setAttribute('aria-live',   'polite');
            el.setAttribute('aria-atomic', 'true');
            el.style.cssText = [
                'position:absolute',
                'width:1px',
                'height:1px',
                'overflow:hidden',
                'clip:rect(0,0,0,0)',
                'white-space:nowrap',
                'border:0',
                'padding:0',
                'margin:-1px',
            ].join(';');

            function append() { document.body.appendChild(el); }
            if (document.body) {
                append();
            } else {
                document.addEventListener('DOMContentLoaded', append);
            }
        }

        return {
            inicializar: inicializar,
            anunciar: function (msg) {
                inicializar();
                clearTimeout(timer);
                el.textContent = '';
                timer = setTimeout(function () {
                    el.textContent = String(msg || '');
                }, 100);
            },
        };
    })();

    // ============================================================
    // OVERLAY DE DRAG & DROP
    // ============================================================

    VP.dom.crearOverlayDrop = function (contenedor) {
        if (!contenedor || VP.dom.esNulo(contenedor)) return null;

        var existente = contenedor.querySelector('#vp-drop-overlay');
        if (existente) return existente;

        var overlay = document.createElement('div');
        overlay.id  = 'vp-drop-overlay';
        overlay.style.cssText = [
            'position:absolute',
            'inset:0',
            'z-index:99998',
            'background:rgba(0,0,0,.7)',
            'display:none',
            'align-items:center',
            'justify-content:center',
            'pointer-events:none',
            'border:3px dashed var(--yt-red,#ff0033)',
            'border-radius:12px',
            'transition:opacity .2s',
        ].join(';');

        overlay.innerHTML =
            '<span style="color:#fff;font-size:1.4rem;font-weight:600;' +
            'pointer-events:none">Suelta archivos de video aquí</span>';

        try {
            var pos = contenedor.style.position;
            if (!pos || pos === 'static') {
                contenedor.style.position = 'relative';
            }
        } catch (_) {}

        contenedor.appendChild(overlay);
        return overlay;
    };

    // ============================================================
    // CSS DE GESTOS
    // ============================================================

    VP.dom.inyectarCSSGestos = function () {
        if (document.getElementById('vp-gesture-css')) return;
        var style = document.createElement('style');
        style.id  = 'vp-gesture-css';
        style.textContent = [
            '@keyframes vpFadeOut{',
            '  0%  {opacity:1;transform:translateY(-50%) scale(1)}',
            '  100%{opacity:0;transform:translateY(-60%) scale(1.3)}',
            '}',
            '.vp-feedback{',
            '  position:absolute;top:50%;',
            '  transform:translateY(-50%);',
            '  color:#fff;font-size:1.6rem;font-weight:700;',
            '  text-shadow:0 2px 8px rgba(0,0,0,.7);',
            '  pointer-events:none;z-index:999;',
            '  animation:vpFadeOut .7s ease forwards;',
            '}',
        ].join('');
        document.head.appendChild(style);
    };

    // ============================================================
    // FEEDBACK VISUAL DE TOQUE DOBLE
    // ============================================================

    var _feedbackPool = [];

    VP.dom.mostrarFeedbackToque = function (texto, lado, contenedor) {
        if (!contenedor || VP.dom.esNulo(contenedor)) return;

        VP.dom.inyectarCSSGestos();

        var fb = _feedbackPool.pop() || document.createElement('div');
        fb.className   = 'vp-feedback';
        fb.textContent = String(texto || '');
        fb.style.left  = lado === 'izquierda' ? '15%' : '';
        fb.style.right = lado === 'izquierda' ? '' : '15%';
        fb.style.animation = 'none';

        contenedor.appendChild(fb);
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                fb.style.animation = 'vpFadeOut .7s ease forwards';
            });
        });

        setTimeout(function () {
            if (fb.parentNode) {
                try { fb.parentNode.removeChild(fb); } catch (_) {}
            }
            fb.textContent    = '';
            fb.style.animation = '';
            if (_feedbackPool.length < 10) _feedbackPool.push(fb);
        }, 800);
    };

    // ============================================================
    // MENÚ CONTEXTUAL
    // ============================================================

    var _menuContextual = null;

    VP.dom.crearMenuContextual = function () {
        if (_menuContextual && VP.dom.estaConectado(_menuContextual)) {
            return _menuContextual;
        }

        var menu = document.createElement('div');
        menu.id  = 'vp-context-menu';
        menu.setAttribute('role', 'menu');
        menu.style.cssText = [
            'position:fixed',
            'z-index:100000',
            'display:none',
            'background:#222',
            'border:1px solid #444',
            'border-radius:8px',
            'padding:6px 0',
            'min-width:180px',
            'box-shadow:0 8px 24px rgba(0,0,0,.5)',
            'font-family:inherit',
            'font-size:13px',
            'color:#ddd',
        ].join(';');

        function append() { document.body.appendChild(menu); }
        if (document.body) {
            append();
        } else {
            document.addEventListener('DOMContentLoaded', append);
        }

        _menuContextual = menu;
        return menu;
    };

    VP.dom.crearItemMenu = function (etiqueta, icono, accion, videoObj) {
        var item = document.createElement('div');
        item.setAttribute('role',     'menuitem');
        item.setAttribute('tabindex', '0');
        item.style.cssText = [
            'padding:8px 16px',
            'cursor:pointer',
            'display:flex',
            'align-items:center',
            'gap:8px',
            'transition:background .15s',
        ].join(';');

        var iconoSeg    = icono ? String(icono) : '';
        var etiquetaSeg = VP.util && VP.util.escaparHTML
            ? VP.util.escaparHTML(String(etiqueta || ''))
            : String(etiqueta || '');

        item.innerHTML = iconoSeg + '<span>' + etiquetaSeg + '</span>';

        item.addEventListener('mouseenter', function () {
            item.style.background = '#333';
        });
        item.addEventListener('mouseleave', function () {
            item.style.background = '';
        });

        if (typeof accion === 'function') {
            function ejecutar(e) {
                e.stopPropagation();
                try { accion(videoObj); } catch (err) {
                    VP.log.warn('crearItemMenu: error en acción', err);
                }
            }
            item.addEventListener('click', ejecutar);
            item.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    ejecutar(e);
                }
            });
        }

        return item;
    };

    VP.dom.crearSeparadorMenu = function () {
        var sep = document.createElement('div');
        sep.setAttribute('role', 'separator');
        sep.style.cssText = [
            'height:1px',
            'background:#444',
            'margin:4px 8px',
            'pointer-events:none',
        ].join(';');
        return sep;
    };

    // ============================================================
    // DETECCIÓN Y CONTROL DE DIÁLOGO
    // ============================================================

    VP.dom.detectarTipoDialogo = function () {
        var modal = VP.refs.settingsModal;
        VP.runtime.dialogoNativo = (
            VP.features && VP.features.dialog &&
            !VP.dom.esNulo(modal) &&
            typeof modal.showModal === 'function'
        );
        VP.log.debug(
            'Tipo de diálogo:',
            VP.runtime.dialogoNativo ? 'nativo <dialog>' : 'div + clase CSS'
        );
    };

    VP.dom.modalEstaAbierto = function () {
        var modal = VP.refs.settingsModal;
        if (VP.dom.esNulo(modal)) return false;
        return (VP.runtime && VP.runtime.dialogoNativo)
            ? modal.open
            : modal.classList.contains('active');
    };

    var _ultimoFoco = null;

    VP.dom.abrirModal = function (triggerEl) {
        var modal = VP.refs.settingsModal;
        if (VP.dom.esNulo(modal)) return;
        _ultimoFoco = triggerEl || document.activeElement;
        try {
            if (VP.runtime && VP.runtime.dialogoNativo) {
                if (!modal.open) modal.showModal();
            } else {
                modal.classList.add('active');
                modal.removeAttribute('aria-hidden');
                modal.setAttribute('aria-modal', 'true');
                modal.setAttribute('tabindex', '-1');
                modal.focus();
            }
        } catch (e) {
            VP.log.warn('abrirModal: showModal falló, fallback CSS', e.message);
            try {
                modal.classList.add('active');
                modal.removeAttribute('aria-hidden');
                modal.setAttribute('aria-modal', 'true');
                modal.setAttribute('tabindex', '-1');
                modal.focus();
            } catch (_) {}
        }
        VP.dom.inertMainContent(true);
        if (VP.bus && typeof VP.bus.emit === 'function') {
            VP.bus.emit('modalAbierto');
        }
    };

    VP.dom.inertMainContent = function (inert) {
        var mainContent = document.getElementById('main-content');
        if (mainContent) mainContent.inert = !!inert;
    };

    VP.dom.cerrarModal = function () {
        var modal = VP.refs.settingsModal;
        if (VP.dom.esNulo(modal)) return;
        try {
            if (VP.runtime && VP.runtime.dialogoNativo) {
                if (modal.open) modal.close();
            } else {
                modal.classList.remove('active');
                modal.setAttribute('aria-hidden', 'true');
            }
        } catch (e) {
            VP.log.warn('cerrarModal: close falló', e.message);
            try {
                modal.classList.remove('active');
                modal.setAttribute('aria-hidden', 'true');
            } catch (_) {}
        }
        VP.dom.inertMainContent(false);
        if (_ultimoFoco && typeof _ultimoFoco.focus === 'function') {
            try { _ultimoFoco.focus(); } catch (_) {}
            _ultimoFoco = null;
        }
        if (VP.bus && typeof VP.bus.emit === 'function') {
            VP.bus.emit('modalCerrado');
        }
    };

    // ============================================================
    // MEDICIÓN DE RENDIMIENTO
    // ============================================================

    VP.dom.medirRendimiento = function (nombre, fn) {
        if (!VP.config || !VP.config.debug) {
            try { return fn(); } catch (e) {
                VP.log.warn('medirRendimiento [' + nombre + ']:', e);
            }
            return undefined;
        }
        var t0     = (window.performance && performance.now) ? performance.now() : Date.now();
        var result;
        try { result = fn(); } catch (e) {
            VP.log.warn('[PERF] ' + nombre + ' error:', e);
        }
        var durMs  = ((window.performance && performance.now)
            ? performance.now()
            : Date.now()) - t0;
        var durStr = durMs.toFixed(2) + 'ms';

        VP.log.debug('[PERF] ' + nombre + ': ' + durStr);
        if (durMs > 16) {
            VP.log.warn(
                '[PERF] ' + nombre + ': ' + durStr +
                ' — supera 1 frame (16ms). Revisar.'
            );
        }
        return result;
    };

    // ============================================================
    // DIAGNÓSTICO
    // ============================================================

    VP.dom.diagnostico = function () {
        var info = {
            nullCache:     _nullCacheKeys.length,
            nullWarnings:  _nullWarnCount,
            pool:          VP.dom.pool.stats(),
            listeners:     VP.dom.statsListeners(),
            observer:      !!_observerInstancia,
            batchPendiente: _batchQueue.length,
            feedbackPool:  _feedbackPool.length,
        };
        VP.log.info('vp-dom diagnóstico:', JSON.stringify(info, null, 2));
        return info;
    };

    // ============================================================
    // VERIFICACIÓN DE MÓDULO COMPLETO
    // ============================================================

    (function verificarModulo() {
        var requeridos = [
            '$', '$$', '$q',
            'esNulo', 'estaConectado',
            'cachearRefs',
            'limpiarHijos', 'limpiarHijosAsync', 'limpiarNullCache',
            'crearElemento', 'setTexto', 'setHTMLSeguro', 'rectSeguro',
            'agregarListeners', 'removerListenersDeElemento',
            'limpiarTodosLosListeners', 'delegarEvento',
            'scrollHacia', 'onScrollThrottled',
            'abrirModal', 'cerrarModal', 'modalEstaAbierto',
            'observar', 'desObservar', 'destruirObserver',
            'renderizarLista', 'crearScrollerVirtual',
            'batch', 'flushBatch',
            'diagnostico', 'medirRendimiento',
        ];

        var faltantes = [];
        for (var i = 0; i < requeridos.length; i++) {
            if (typeof VP.dom[requeridos[i]] !== 'function') {
                faltantes.push(requeridos[i]);
            }
        }

        if (faltantes.length > 0) {
            VP.log.error(
                'vp-dom.js: funciones faltantes →', faltantes.join(', ')
            );
        } else {
            VP.log.debug(
                'vp-dom.js: verificación OK (' + requeridos.length + ' funciones).'
            );
        }
    })();

    VP.log.info('vp-dom.js cargado correctamente. Optimizado para 500+ videos.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-dom.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
