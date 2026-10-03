// ============================================================
// VP-LISTAS.JS — OPTIMIZADO PARA 500+ VIDEOS
// Renderizado virtualizado, pool de DOM, lazy loading,
// búsqueda indexada, drag & drop robusto, context menu,
// navegación por teclado, persistencia y métricas.
// Requiere: vp-base.js, vp-utilidades.js, vp-dom.js,
//           vp-db.js, vp-miniaturas.js
// ============================================================

'use strict';

// ============================================================
// VP-LISTAS.JS — OPTIMIZADO PARA 500+ VIDEOS
// ============================================================

(function (window, document) {
    'use strict';

    if (!window || !document) return; // Robustez: Entorno inválido

    // ============================================================
    // VERIFICACIÓN DE DEPENDENCIAS
    // ============================================================

    var DEPS_REQUERIDAS = ['VP', 'VP.util', 'VP.dom', 'VP.log',
                           'VP.bus', 'VP.config', 'VP.db'];

    for (var _d = 0; _d < DEPS_REQUERIDAS.length; _d++) {
        var _partes = DEPS_REQUERIDAS[_d].split('.');
        var _obj    = window;
        var _ok     = true;

        for (var _p = 0; _p < _partes.length; _p++) {
            if (_obj == null || typeof _obj !== 'object' || !_obj[_partes[_p]]) {
                _ok = false;
                break;
            }
            _obj = _obj[_partes[_p]];
        }

        if (!_ok) {
            throw new Error(
                '[VP] vp-listas.js: dependencia faltante → ' +
                DEPS_REQUERIDAS[_d]
            );
        }
    }

    var VP   = window.VP;
    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;
    var cfg  = VP.config || {}; // Robustez: fallback a objeto vacío
    log.setContext('Listas');

    // ============================================================
    // NAMESPACE Y ESTADO INTERNO
    // ============================================================

    VP.listas = VP.listas || {};

    // Estado privado del módulo
    var _estado = {
        // ---- Timers ----
        timers: {
            galleryRender    : null,
            playlistRender   : null,
            busqueda         : null,
            progreso         : null,
            guardadoOrden    : null,
            alturaPlaylist   : null,
            scrollActivo     : null,
        },

        // ---- Virtualización galería ----
        galeria: {
            elementosCache   : [],
            itemHeight       : 0,
            itemWidth        : 0,
            columnas         : 1,
            rangoVisible     : { inicio: 0, fin: 0 },
            observer         : null,
            renderizando     : false,
            pendiente        : false,
            scrollListener   : null,
            espaciador       : null,
            scrollParent     : null,
            renderedMap      : null,
        },

        // ---- Virtualización playlist ----
        playlist: {
            itemHeight       : 82,
            rangoVisible     : { inicio: 0, fin: 0 },
            observer         : null,
            renderizando     : false,
            pendiente        : false,
            scrollListener   : null,
            espaciador       : null,
            renderedMap      : null,
        },

        // ---- Pool de elementos DOM ----
        pool: {
            galeria          : [],
            playlist         : [],
            MAX_POOL         : 100,
        },

        // ---- Drag & Drop ----
        drag: {
            srcIndex         : null,
            srcEl            : null,
            placeholder      : null,
            isDragging       : false,
            ghostEl          : null,
            overEl           : null,
        },

        // ---- Handles de limpieza de delegación ----
        limpiadoresEventos  : [],

        // ---- Observers ----
        lazyObserver       : null,
        resizeObserver     : null,

        // ---- Menú contextual ----
        menuCtx: {
            el               : null,
            vidActual        : null,
            abierto          : false,
        },

        // ---- Modo virtualización ----
        UMBRAL_VIRTUAL     : 50,

        // ---- Métricas internas ----
        metricas: {
            renderGaleriaMs  : 0,
            renderPlaylistMs : 0,
            itemsRenderizados: 0,
            reciclajes       : 0,
        },
    };

    // ============================================================
    // CONSTANTES
    // ============================================================

    var CONST = {
        SELECTOR_GALLERY_ITEM   : '.gallery-item',
        SELECTOR_PLAYLIST_ITEM  : '.playlist-item',
        SELECTOR_PL_ACTIONS     : '.pl-action',
        SELECTOR_THUMB_AUDIO    : '.thumbnail-audio-btn',
        SELECTOR_TC             : '.thumbnail-container',
        SELECTOR_PVID           : '.thumbnail-preview video',
        SELECTOR_GAL_BAR        : '.gallery-progress-bar',
        SELECTOR_PL_BAR         : '.playlist-progress-bar',
        CLS_ACTIVE              : 'active',
        CLS_DRAGGING            : 'dragging',
        CLS_DRAG_OVER           : 'drag-over',
        CLS_KB_FOCUS            : 'kb-focus',
        CLS_LAZY                : 'lazy-thumb',
        CLS_LAZY_LOADED         : 'lazy-loaded',
        // CORRECCIÓN: dataset no admite guiones → usar camelCase
        // el atributo HTML es data-lazy-src pero el dataset key es lazySrc
        DATASET_LAZY_SRC        : 'lazySrc',          // el.dataset.lazySrc
        ATTR_LAZY_SRC           : 'data-lazy-src',    // setAttribute
        ATTR_VID_ID             : 'data-vid-id',
        ATTR_IDX                : 'data-idx',
        ATTR_MUTED              : 'data-muted',
        DEBOUNCE_RESIZE         : 80,
        DEBOUNCE_SCROLL         : 60,
        THROTTLE_PROGRESO       : 800,
        BATCH_SIZE_GALERIA      : 20,
        BATCH_SIZE_PLAYLIST     : 30,
        BATCH_DELAY             : 8,
        ITEM_ESTIM_GALERIA      : 220,
        ITEM_ESTIM_PLAYLIST     : 82,
        OVERSCAN                : 5,
    };

    // ============================================================
    // DETECCIÓN DE FUNCIÓN DE STORAGE
    // ============================================================

    var _storageGet = function (clave) {
        try { return VP.util.obtenerItem(clave); } catch(e) { return null; }
    };

    var _storageSet = function (clave, valor) {
        try { VP.util.guardarItem(clave, valor); } catch(e) { log.warn('Error en storageSet', e); }
    };

    // ============================================================
    // UTILIDADES INTERNAS
    // ============================================================

    function _cancelarTimer(nombre) {
        if (_estado.timers[nombre]) {
            clearTimeout(_estado.timers[nombre]);
            _estado.timers[nombre] = null;
        }
    }

    function _programarTimer(nombre, fn, ms) {
        _cancelarTimer(nombre);
        _estado.timers[nombre] = setTimeout(fn, ms || 0);
    }

    function _cancelarTodosLosTimers() {
        var claves = Object.keys(_estado.timers);
        for (var i = 0; i < claves.length; i++) {
            _cancelarTimer(claves[i]);
        }
    }

    function _obtenerMapaRenderizado(tipo, espaciador) {
        var estadoTipo = _estado[tipo];
        if (!estadoTipo) return null;
        if (!estadoTipo.renderedMap) {
            estadoTipo.renderedMap = new WeakMap();
        }
        var mapa = estadoTipo.renderedMap.get(espaciador);
        if (!mapa) {
            mapa = new Map();
            estadoTipo.renderedMap.set(espaciador, mapa);
        }
        return mapa;
    }

    function _obtenerDelPool(tipo, tag, className) {
        var pool = _estado.pool[tipo];
        if (pool && pool.length > 0) {
            var el = pool.pop();
            _estado.metricas.reciclajes++;
            el.className     = className || '';
            el.innerHTML     = '';
            el.style.cssText = '';
            el.removeAttribute('draggable');
            el.removeAttribute('role');
            el.removeAttribute('tabindex');
            el.removeAttribute('aria-selected');
            el.removeAttribute('aria-label');
            // Limpiar dataset de forma robusta
            var dsKeys = Object.keys(el.dataset || {});
            for (var i = 0; i < dsKeys.length; i++) {
                try {
                    delete el.dataset[dsKeys[i]];
                } catch(e) {
                    // Fallback para navegadores antiguos en strict mode
                    var attrName = 'data-' + dsKeys[i].replace(/[A-Z]/g, function(m){ return '-' + m.toLowerCase(); });
                    el.removeAttribute(attrName);
                }
            }
            return el;
        }
        var nuevo = document.createElement(tag || 'div');
        if (className) nuevo.className = className;
        return nuevo;
    }

    function _devolverAlPool(tipo, el) {
        if (!el || !_estado.pool[tipo]) return;
        if (_estado.pool[tipo].length < _estado.pool.MAX_POOL) {
            _estado.pool[tipo].push(el);
        }
    }

    function _formatTime(t) {
        if (t == null || isNaN(t)) return ''; // Robustez
        try { return util.formatearTiempo(t) || ''; } catch (e) { return ''; }
    }

    function _formatSize(s) {
        if (s == null || isNaN(s)) return ''; // Robustez
        try { return util.formatearTamano(s) || ''; } catch (e) { return ''; }
    }

    function _escHTML(str) {
        try {
            return util.escaparHTML(String(str || ''));
        } catch (e) {
            return String(str || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }
    }

    var _progCache = Object.create(null);
    var _progCacheDirty = true;

    function _reconstruirProgCache() {
        var arr = VP.estado.videoProgress;
        if (!Array.isArray(arr)) { // Robustez
            _progCache = Object.create(null);
            _progCacheDirty = false;
            return;
        }
        var m = Object.create(null);
        for (var i = 0; i < arr.length; i++) {
            var p = arr[i];
            if (p && p.fileName) m[p.fileName] = p;
        }
        _progCache = m;
        _progCacheDirty = false;
    }

    function _marcarProgCacheDirty() {
        _progCacheDirty = true;
    }

    function _obtenerPct(v) {
        try {
            if (!v || !v.name) return 0; // Robustez
            if (_progCacheDirty) _reconstruirProgCache();
            var prog = _progCache[v.name];
            if (prog && prog.duration > 0 && !isNaN(prog.duration)) {
                var ratio = prog.currentTime / prog.duration;
                if (isNaN(ratio)) return 0;
                return Math.min(100, Math.max(0, ratio * 100));
            }
        } catch (e) { /* silencioso */ }
        return 0;
    }

    function _esVideoValido(v) {
        if (util && typeof util.validarVideoBasico === 'function') {
            return util.validarVideoBasico(v) && v.id != null;
        }
        return v != null &&
               typeof v === 'object' &&
               !Array.isArray(v) && // Robustez: Evitar que pase un array como objeto
               v.id != null &&
               typeof v.name === 'string' &&
               v.name.trim().length > 0;
    }

    function _normalizarColeccionVideos(lista, contexto) {
        if (!Array.isArray(lista)) return [];
        var res = null;
        var descartados = 0;
        for (var i = 0; i < lista.length; i++) {
            if (_esVideoValido(lista[i])) {
                if (res) res.push(lista[i]);
            } else {
                descartados++;
                if (!res) res = lista.slice(0, i);
            }
        }
        if (descartados && log && log.warn) {
            log.warn((contexto || 'lista') + ': descartados ' + descartados + ' items invalidos.');
        }
        return res || lista;
    }

    function _usarVirtualizacion(count) {
        return count > _estado.UMBRAL_VIRTUAL;
    }

    function _notificar(mensaje, tipo) {
        try {
            if (VP.ui && typeof VP.ui.mostrarNotificacion === 'function') {
                VP.ui.mostrarNotificacion(mensaje, tipo || 'info');
            }
        } catch (e) { /* silencioso */ }
    }

    bus.on('playlistCambiada', _marcarProgCacheDirty);
    bus.on('videoProgressActualizado', _marcarProgCacheDirty);

    function _mostrarEmpty(el, mostrar) {
        if (!el) return;
        el.style.display = mostrar ? 'flex' : 'none';
    }

    function _limpiarContenedorConPool(contenedor, tipoPool, claseExcluir) {
        if (!contenedor) return;
        var hijo = contenedor.lastElementChild;
        while (hijo) {
            var anterior = hijo.previousElementSibling;
            if (claseExcluir && hijo.classList && hijo.classList.contains(claseExcluir)) {
                hijo = anterior;
                continue;
            }
            if (_estado.lazyObserver) {
                try { _estado.lazyObserver.unobserve(hijo); } catch (e) {}
            }
            contenedor.removeChild(hijo);
            _devolverAlPool(tipoPool, hijo);
            hijo = anterior;
        }
    }

    function _actualizarMapas() {
        try {
            if (typeof VP.reconstruirMapaVideoPorId === 'function')
                VP.reconstruirMapaVideoPorId();
            if (typeof VP.reconstruirMapaVideoPorNombre === 'function')
                VP.reconstruirMapaVideoPorNombre();
        } catch (e) { log.warn('Error actualizando mapas:', e); }
    }

    function _registrarEliminado(v) {
        try {
            var eliminados = VP.estado.archivosEliminados;
            if (!Array.isArray(eliminados)) return;
            if (!util.incluye(eliminados, v.name)) eliminados.push(v.name);
            if (v.subtitleName && !util.incluye(eliminados, v.subtitleName))
                eliminados.push(v.subtitleName);
        } catch (e) { log.warn('Error registrando eliminado:', e); }
    }

    function _registrarExclusionPersistente(videoObj) {
        if (!videoObj || !videoObj.name) return;
        try {
            var clave = cfg.claveVideosExcluidos || 'vp_excluded_videos_v1';
            var lastMod = (videoObj.file && videoObj.file.lastModified) || videoObj.lastModified || 0;
            var fp = videoObj.name + '|' + (videoObj.size || 0) + '|' + lastMod;
            var lista = VP.db.obtenerKeyVal(clave) || [];
            if (!Array.isArray(lista)) lista = [];
            if (lista.indexOf(fp) === -1) {
                lista.push(fp);
                VP.db.guardarKeyVal(clave, lista);
            }
        } catch (e) { log.warn('Error registrando exclusión:', e); }
    }

    function _encontrarScrollParent(el) {
        if (!el) return window;
        var padre = el.parentNode;
        while (padre && padre !== document.body && padre !== document.documentElement) {
            try {
                var style     = window.getComputedStyle(padre);
                var overflow  = style.overflow;
                var overflowY = style.overflowY;
                if (/auto|scroll|overlay/.test(overflow) ||
                    /auto|scroll|overlay/.test(overflowY)) {
                    return padre;
                }
            } catch (e) { /* ignorar */ }
            padre = padre.parentNode;
        }
        return window;
    }

    // ============================================================
    // LAZY LOADING DE THUMBNAILS
    // ============================================================

    VP.listas._inicializarLazyObserver = function () {
        // Verificar soporte real (no solo la feature flag)
        var soportado = (typeof IntersectionObserver === 'function') &&
                        (VP.features && VP.features.intersectionObserver);

        if (!soportado) {
            log.debug('LazyObserver no disponible; thumbnails carga inmediata.');
            return;
        }

        if (_estado.lazyObserver) {
            try { _estado.lazyObserver.disconnect(); } catch (e) {}
        }

        _estado.lazyObserver = new IntersectionObserver(
            function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    var entry = entries[i];
                    if (!entry.isIntersecting) continue;

                    var el = entry.target;
                    // CORRECCIÓN: usar camelCase en dataset
                    var src = el.dataset ? el.dataset[CONST.DATASET_LAZY_SRC] : null;

                    if (src && !el.classList.contains(CONST.CLS_LAZY_LOADED)) {
                        _cargarThumbInmediato(el, src);
                        try { _estado.lazyObserver.unobserve(el); } catch (e) {}
                    }
                }
            },
            { rootMargin: '200px 0px', threshold: 0 }
        );

        log.debug('LazyObserver inicializado.');
    };

    /**
     * Carga una thumbnail inmediatamente (sin lazy).
     */
    function _cargarThumbInmediato(el, src) {
        if (!el || !src) return;
        var img = el.querySelector('.thumbnail-image');
        if (img) {
            img.style.backgroundImage = 'url(' + src + ')';
            el.classList.add(CONST.CLS_LAZY_LOADED);
            el.classList.remove(CONST.CLS_LAZY);
        }
    }

    // ============================================================
    // GALERÍA — RENDERIZADO PRINCIPAL
    // ============================================================

    VP.listas.renderizarGaleria = function () {
        _cancelarTimer('galleryRender');
        _marcarProgCacheDirty();

        if (_estado.galeria.renderizando) {
            _estado.galeria.pendiente = true;
            return;
        }

        VP.metricas = VP.metricas || {}; // Robustez
        VP.metricas.ciclosRender = (VP.metricas.ciclosRender || 0) + 1;

        var t0        = util.ahora();
        var galleryEl = VP.refs.galleryEl;

        if (!galleryEl) {
            log.error('renderizarGaleria: galleryEl no encontrado.');
            return;
        }

        // Limpiar scroll listener anterior de galería
        _desconectarScrollGaleria();

        _limpiarContenedorConPool(galleryEl, 'galeria', 'empty-state');
        _estado.galeria.rangoVisible = { inicio: 0, fin: 0 };

        var videos = _normalizarColeccionVideos(VP.estado.videos, 'galeria');

        if (!Array.isArray(videos) || !videos.length) {
            _mostrarEmpty(VP.refs.galleryEmpty, true);
            bus.emit('galeriaRenderizada');
            return;
        }

        _mostrarEmpty(VP.refs.galleryEmpty, false);

        _estado.galeria.renderizando = true;

        if (_usarVirtualizacion(videos.length)) {
            VP.listas._inicializarVirtualGaleria(galleryEl, videos, t0);
        } else {
            VP.listas._renderizarGaleriaBatch(0, videos, galleryEl, t0);
        }
    };

    function _desconectarScrollGaleria() {
        if (_estado.galeria.scrollParent && _estado.galeria.scrollListener) {
            try {
                _estado.galeria.scrollParent.removeEventListener(
                    'scroll', _estado.galeria.scrollListener
                );
            } catch (e) {}
        }
        _estado.galeria.scrollListener = null;
        _estado.galeria.scrollParent   = null;
    }

    // ============================================================
    // GALERÍA — MODO VIRTUALIZADO
    // ============================================================

    VP.listas._inicializarVirtualGaleria = function (galleryEl, videos, t0) {
        var containerW = galleryEl.clientWidth || 800;
        var style      = window.getComputedStyle(galleryEl);
        var padLR      = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        var contentW   = containerW - padLR;
        var itemMinW   = cfg.itemGaleriaMinWidth || CONST.ITEM_ESTIM_GALERIA;
        var gap        = cfg.galeriaGap || 12;
        var columnas   = Math.max(1, Math.floor(
            (contentW + gap) / (itemMinW + gap)
        ));
        var itemW      = itemMinW;
        var totalRowW  = columnas * itemW + (columnas - 1) * gap;
        _estado.galeria.centerOffset = Math.max(0, Math.floor((contentW - totalRowW) / 2));
        var itemH      = cfg.itemGaleriaHeight || CONST.ITEM_ESTIM_GALERIA;
        var filas      = Math.ceil(videos.length / columnas);
        var alturaTotal = filas * (itemH + gap) - gap;

        _estado.galeria.columnas   = columnas;
        _estado.galeria.itemHeight = itemH;
        _estado.galeria.itemWidth  = itemW;

        var espaciador           = document.createElement('div');
        espaciador.className     = 'gallery-virtual-spacer';
        espaciador.style.height  = alturaTotal + 'px';
        espaciador.style.position = 'relative';
        espaciador.style.width   = '100%';
        galleryEl.appendChild(espaciador);
        _estado.galeria.espaciador = espaciador;

        var scrollParent = _encontrarScrollParent(galleryEl);
        _estado.galeria.scrollParent = scrollParent;

        var fnScroll = util.throttle(function () {
            VP.listas._actualizarVirtualGaleria(
                espaciador, videos, scrollParent, columnas, itemH, gap
            );
        }, CONST.DEBOUNCE_SCROLL);

        _estado.galeria.scrollListener = fnScroll;
        scrollParent.addEventListener('scroll', fnScroll, { passive: true });

        VP.listas._actualizarVirtualGaleria(
            espaciador, videos, scrollParent, columnas, itemH, gap
        );

        _estado.galeria.renderizando = false;

        if (t0) {
            var elapsed = util.ahora() - t0;
            _estado.metricas.renderGaleriaMs = elapsed;
            log.debug('Galería virtual inicializada en',
                Math.round(elapsed) + 'ms',
                '| Videos:', videos.length,
                '| Columnas:', columnas);
        }

        bus.emit('galeriaRenderizada');
        _procesarPendiente('galeria');
    };

    VP.listas._actualizarVirtualGaleria = function (
        espaciador, videos, scrollParent, columnas, itemH, gap
    ) {
        if (!espaciador || !videos || !document.body.contains(espaciador)) return; // Robustez

        var scrollTop = scrollParent === window
            ? (window.pageYOffset || window.scrollY || 0)
            : scrollParent.scrollTop;
        var viewH = scrollParent === window
            ? window.innerHeight
            : scrollParent.clientHeight;

        // Calcular rango de filas visibles
        var filaInicio = Math.max(0,
            Math.floor(scrollTop / (itemH + gap)) - CONST.OVERSCAN
        );
        var filaFin = Math.min(
            Math.ceil(videos.length / columnas) - 1,
            Math.floor((scrollTop + viewH) / (itemH + gap)) + CONST.OVERSCAN
        );

        var idxInicio = filaInicio * columnas;
        var idxFin    = Math.min(videos.length - 1,
            (filaFin + 1) * columnas - 1
        );

        var rango = _estado.galeria.rangoVisible;

        var espaciadorVacio = espaciador.firstElementChild === null;
        if (!espaciadorVacio && rango.inicio === idxInicio && rango.fin === idxFin) return;
        rango.inicio = idxInicio;
        rango.fin    = idxFin;

        var yaRendered = _obtenerMapaRenderizado('galeria', espaciador);
        // Mantener el mapa de elementos visibles entre scrolls y retirar solo los
        // que salieron de rango o fueron removidos externamente del espaciador.
        yaRendered.forEach(function (elemento, indice) {
            if (indice < idxInicio || indice > idxFin || elemento.parentNode !== espaciador) {
                if (_estado.lazyObserver) {
                    try { _estado.lazyObserver.unobserve(elemento); }
                    catch (_) {}
                }
                if (elemento.parentNode === espaciador) {
                    espaciador.removeChild(elemento);
                    _devolverAlPool('galeria', elemento);
                }
                yaRendered.delete(indice);
            }
        });

        // Añadir items faltantes
        var frag = document.createDocumentFragment();
        var itemWReal   = _estado.galeria.itemWidth   || 220;
        var centerOffset = _estado.galeria.centerOffset || 0;

        for (var i = idxInicio; i <= idxFin; i++) {
            if (yaRendered.has(i)) continue;
            var video = videos[i];
            if (!_esVideoValido(video)) continue;

            var fila = Math.floor(i / columnas);
            var col  = i % columnas;
            var top  = fila * (itemH + gap);
            var left = centerOffset + col * (itemWReal + gap);

            var el   = VP.listas._construirItemGaleria(video, i);
            el.dataset.virtualIdx = String(i);
            el.style.position     = 'absolute';
            el.style.top          = top  + 'px';
            el.style.left         = left + 'px';
            el.style.width        = itemWReal + 'px';

            yaRendered.set(i, el);
            frag.appendChild(el);
            _estado.metricas.itemsRenderizados++;
        }

        espaciador.appendChild(frag);
    };

    // ============================================================
    // GALERÍA — MODO BATCH (≤ UMBRAL_VIRTUAL items)
    // ============================================================

    VP.listas._renderizarGaleriaBatch = function (inicio, videos, galleryEl, t0) {
        if (!document.body.contains(galleryEl)) {
            _estado.galeria.renderizando = false;
            return; // Robustez: Elemento ya no está en el DOM
        }

        if (inicio >= videos.length) {
            _estado.galeria.renderizando = false;

            if (t0) {
                var elapsed = util.ahora() - t0;
                _estado.metricas.renderGaleriaMs = elapsed;
                VP.metricas.promedioRenderMs =
                    ((VP.metricas.promedioRenderMs || 0) + elapsed) / 2; // Robustez
                log.debug('Galería (batch) renderizada en',
                    Math.round(elapsed) + 'ms');
            }

            bus.emit('galeriaRenderizada');
            _procesarPendiente('galeria');
            return;
        }

        var tamLote = cfg.tamLoteRender || CONST.BATCH_SIZE_GALERIA;
        var fin     = Math.min(inicio + tamLote, videos.length);
        var frag    = document.createDocumentFragment();

        for (var i = inicio; i < fin; i++) {
            if (!_esVideoValido(videos[i])) continue;
            frag.appendChild(VP.listas._construirItemGaleria(videos[i], i));
            _estado.metricas.itemsRenderizados++;
        }

        galleryEl.appendChild(frag);

        if (fin < videos.length) {
            _programarTimer('galleryRender', function () {
                VP.listas._renderizarGaleriaBatch(fin, videos, galleryEl, t0);
            }, CONST.BATCH_DELAY);
        } else {
            _estado.galeria.renderizando = false;

            if (t0) {
                var e2 = util.ahora() - t0;
                _estado.metricas.renderGaleriaMs = e2;
                VP.metricas.promedioRenderMs =
                    ((VP.metricas.promedioRenderMs || 0) + e2) / 2; // Robustez
            }

            bus.emit('galeriaRenderizada');
            _procesarPendiente('galeria');
        }
    };

    function _procesarPendiente(tipo) {
        if (tipo === 'galeria' && _estado.galeria.pendiente) {
            _estado.galeria.pendiente = false;
            _programarTimer('galleryRender', VP.listas.renderizarGaleria, 16);
        } else if (tipo === 'playlist' && _estado.playlist.pendiente) {
            _estado.playlist.pendiente = false;
            _programarTimer('playlistRender', VP.listas.renderizarPlaylist, 16);
        }
    }

    // ============================================================
    // GALERÍA — CONSTRUIR ITEM
    // ============================================================

    VP.listas._construirItemGaleria = function (v, virtualIdx) {
        if (!_esVideoValido(v)) {
            log.warn('_construirItemGaleria: video inválido', v);
            return document.createElement('div');
        }

        var el = _obtenerDelPool('galeria', 'div', 'gallery-item');
        el.dataset.vidId = String(v.id);

        if (virtualIdx !== undefined && virtualIdx !== null) {
            el.dataset.virtualIdx = String(virtualIdx);
        }

        try { el.title = v.name; } catch (e) {}

        // CORRECCIÓN CRÍTICA: dataset solo admite camelCase
        // data-lazy-src → dataset.lazySrc (NO dataset['lazy-src'])
        if (v.thumbnail) {
            el.dataset[CONST.DATASET_LAZY_SRC] = v.thumbnail;
            el.classList.add(CONST.CLS_LAZY);
        }

        var pct      = _obtenerPct(v);
        var duracion = v.duration ? _formatTime(v.duration) : '';

        el.innerHTML = _htmlItemGaleria(v, pct, duracion);
        _actualizarBadgeResolucionItem(el, v);
        _cargarResolucionCacheada(el, v);

        // Cargar thumbnail
        if (v.thumbnail) {
            if (_estado.lazyObserver) {
                try { _estado.lazyObserver.observe(el); } catch (e) {
                    // Si falla el observer, cargar inmediatamente
                    _cargarThumbInmediato(el, v.thumbnail);
                }
            } else {
                // Sin lazy observer: cargar directamente
                _cargarThumbInmediato(el, v.thumbnail);
            }
        }

        _vincularItemGaleria(el, v);

        return el;
    };

    function _actualizarBadgeResolucionItem(el, v) {
        if (!el || !v) return;
        var badge = el.querySelector('.thumbnail-quality');
        if (!badge) return;
        var ancho = Number(v.videoWidth) || 0;
        var alto = Number(v.videoHeight) || 0;
        if (alto < 720) {
            badge.hidden = true;
            badge.removeAttribute('data-quality');
            badge.removeAttribute('title');
            return;
        }
        var calidad = alto >= 2160 ? '4K' : alto >= 1440 ? 'QHD' :
            alto >= 1080 ? 'Full HD' : 'HD';
        badge.textContent = calidad;
        badge.setAttribute('data-quality', calidad);
        badge.setAttribute('aria-label', 'Resolución: ' + ancho + ' × ' + alto + ' (' + calidad + ')');
        badge.title = 'Resolución: ' + ancho + ' × ' + alto;
        var contenedor = badge.closest('.thumbnail-container');
        badge.hidden = !!(contenedor && contenedor.classList.contains('preview-hovering'));
    }

    function _cargarResolucionCacheada(el, v) {
        if (!el || !v || (v.videoHeight > 0 && v.videoWidth > 0) ||
                !VP.db || typeof VP.db.obtenerMetadatos !== 'function') return;
        var id = String(v.id);
        function aplicar(meta) {
            if (!meta || !(meta.videoWidth > 0) || !(meta.videoHeight > 0)) return false;
            v.videoWidth = meta.videoWidth;
            v.videoHeight = meta.videoHeight;
            if (el.dataset.vidId === id) _actualizarBadgeResolucionItem(el, v);
            return true;
        }
        VP.db.obtenerMetadatos(v.id).then(function (meta) {
            if (aplicar(meta) || !v.name || String(v.name) === id) return;
            return VP.db.obtenerMetadatos(v.name).then(aplicar);
        }).catch(function () {});
    }

    VP.listas.actualizarBadgeResolucionVideo = function (v) {
        if (!v || v.id == null || !VP.refs.galleryEl) return;
        var items = VP.refs.galleryEl.querySelectorAll(CONST.SELECTOR_GALLERY_ITEM);
        for (var i = 0; i < items.length; i++) {
            if (items[i].dataset.vidId === String(v.id)) {
                _actualizarBadgeResolucionItem(items[i], v);
            }
        }
    };

    function _htmlItemGaleria(v, pct, duracion) {
        var svgPelicula = (util.svg && util.svg.pelicula) || '';
        var svgAudioOff = (util.svg && util.svg.audioOff) || '';
        var pctStr      = (isNaN(pct) ? 0 : pct).toFixed(1); // Robustez
        var nombre      = _escHTML(v.name);

        return (
            '<div class="thumbnail-container">' +
                '<div class="thumbnail-image">' +
                    (v.thumbnail ? '' : svgPelicula) +
                '</div>' +
                '<div class="thumbnail-preview">' +
                    '<video muted loop preload="none" playsinline></video>' +
                '</div>' +
                (duracion
                    ? '<span class="thumbnail-duration">' + duracion + '</span>'
                    : '') +
                '<span class="thumbnail-quality" aria-label="Resolución del video" hidden></span>' +
                '<button type="button" class="thumbnail-audio-btn" ' +
                    'data-muted="true" title="Activar audio" aria-pressed="false" ' +
                    'aria-label="Activar audio del preview">' +
                    svgAudioOff +
                '</button>' +
            '</div>' +
            '<div class="gallery-title" title="' + nombre + '">' +
                nombre +
            '</div>' +
            '<div class="gallery-progress-container" ' +
                'role="progressbar" ' +
                'aria-valuenow="' + pctStr + '" ' +
                'aria-valuemin="0" aria-valuemax="100">' +
                '<div class="gallery-progress-bar" ' +
                    'style="width:' + pctStr + '%"></div>' +
            '</div>'
        );
    }

    function _vincularItemGaleria(el, v) {
        el.setAttribute('role',       'button');
        el.setAttribute('tabindex',   '0');
        el.setAttribute('aria-label', 'Reproducir ' + v.name);

        var tc = el.querySelector(CONST.SELECTOR_TC);
        if (tc && VP.miniaturas && typeof VP.miniaturas.adjuntarPreview === 'function') {
            try { VP.miniaturas.adjuntarPreview(tc, v); }
            catch (err) { log.warn('Error adjuntando preview:', err); }
        }
    }

    // ============================================================
    // PLAYLIST — RENDERIZADO PRINCIPAL
    // ============================================================

    VP.listas.renderizarPlaylist = function () {
        var searchInput = VP.refs.searchInput;
        var activeQuery = searchInput && typeof searchInput.value === 'string'
            ? searchInput.value.trim()
            : '';
        if (activeQuery && VP.busqueda && typeof VP.busqueda.ejecutarBusqueda === 'function') {
            VP.busqueda.ejecutarBusqueda(activeQuery, true);
            return;
        }

        _cancelarTimer('playlistRender');
        _marcarProgCacheDirty();

        if (_estado.playlist.renderizando) {
            _estado.playlist.pendiente = true;
            return;
        }

        var t0         = util.ahora();
        var playlistEl = VP.refs.playlistEl;

        if (!playlistEl) {
            log.error('renderizarPlaylist: playlistEl no encontrado.');
            return;
        }

        // Desconectar scroll listener anterior
        _desconectarScrollPlaylist();
        _limpiarContenedorConPool(playlistEl, 'playlist', 'empty-state');
        // CORRECCIÓN: invalidar rangoVisible al limpiar el contenedor
        // para evitar que _actualizarVirtualPlaylist retorne sin renderizar
        // cuando el nuevo rango coincida con el viejo (caso típico tras borrado)
        _estado.playlist.rangoVisible = { inicio: 0, fin: 0 };

        var playlist = _normalizarColeccionVideos(VP.estado.playlist, 'playlist');

        if (!Array.isArray(playlist) || !playlist.length) {
            _mostrarEmpty(VP.refs.playlistEmpty, true);
            bus.emit('playlistRenderizada');
            _procesarPendiente('playlist');
            return;
        }

        _mostrarEmpty(VP.refs.playlistEmpty, false);

        _estado.playlist.renderizando = true;

        if (_usarVirtualizacion(playlist.length)) {
            VP.listas._inicializarVirtualPlaylist(playlistEl, playlist, t0);
        } else {
            VP.listas._renderizarPlaylistBatch(0, playlist, playlistEl, t0);
        }
    };

    VP.listas.renderizarPlaylistFiltrada = function (videos, indicesOriginales, query) {
        _cancelarTimer('playlistRender');
        _desconectarScrollPlaylist();
        _marcarProgCacheDirty();

        var playlistEl = VP.refs.playlistEl;
        if (!playlistEl) return;

        _estado.playlist.renderizando = false;
        _estado.playlist.pendiente = false;
        _estado.playlist.rangoVisible = { inicio: 0, fin: 0 };
        _estado.playlist.espaciador = null;
        playlistEl.scrollTop = 0;
        _limpiarContenedorConPool(playlistEl, 'playlist', 'empty-state');

        var filtrados = _normalizarColeccionVideos(videos, 'playlist filtrada');
        if (!filtrados.length) {
            _mostrarEmpty(VP.refs.playlistEmpty, true);
            bus.emit('playlistRenderizada');
            return;
        }

        _mostrarEmpty(VP.refs.playlistEmpty, false);
        _estado.playlist.renderizando = true;
        var contextoBusqueda = {
            indicesOriginales: Array.isArray(indicesOriginales) ? indicesOriginales : [],
            query: query || '',
        };

        if (_usarVirtualizacion(filtrados.length)) {
            VP.listas._inicializarVirtualPlaylist(playlistEl, filtrados, null, contextoBusqueda);
            return;
        }

        var frag = document.createDocumentFragment();
        for (var i = 0; i < filtrados.length; i++) {
            var idxOriginal = contextoBusqueda.indicesOriginales[i];
            if (typeof idxOriginal !== 'number' || !isFinite(idxOriginal)) idxOriginal = i;
            var item = _crearItemPlaylistBusqueda(filtrados[i], idxOriginal, contextoBusqueda.query);
            frag.appendChild(item);
            _estado.metricas.itemsRenderizados++;
        }
        playlistEl.appendChild(frag);
        _estado.playlist.renderizando = false;
        bus.emit('playlistRenderizada');
        _procesarPendiente('playlist');
    };

    function _desconectarScrollPlaylist() {
        var playlistEl = VP.refs.playlistEl;
        if (playlistEl && _estado.playlist.scrollListener) {
            try {
                playlistEl.removeEventListener(
                    'scroll', _estado.playlist.scrollListener
                );
            } catch (e) {}
        }
        _estado.playlist.scrollListener = null;
    }

    // ============================================================
    // PLAYLIST — MODO VIRTUALIZADO
    // ============================================================

    VP.listas._inicializarVirtualPlaylist = function (
        playlistEl, playlist, t0, contextoBusqueda
    ) {
        var itemH       = _estado.playlist.itemHeight || 82; // Robustez
        var alturaTotal = playlist.length * itemH;

        var espaciador           = document.createElement('div');
        espaciador.className     = 'playlist-virtual-spacer';
        espaciador.style.height  = alturaTotal + 'px';
        espaciador.style.position = 'relative';
        espaciador.style.width   = '100%';
        playlistEl.appendChild(espaciador);
        _estado.playlist.espaciador = espaciador;

        var fnScroll = util.throttle(function () {
            VP.listas._actualizarVirtualPlaylist(
                espaciador, playlist, playlistEl, _estado.playlist.itemHeight,
                contextoBusqueda
            );
        }, CONST.DEBOUNCE_SCROLL);

        _estado.playlist.scrollListener = fnScroll;
        playlistEl.addEventListener('scroll', fnScroll, { passive: true });

        VP.listas._actualizarVirtualPlaylist(
            espaciador, playlist, playlistEl, itemH, contextoBusqueda
        );

        _estado.playlist.renderizando = false;

        if (t0) {
            var elapsed = util.ahora() - t0;
            _estado.metricas.renderPlaylistMs = elapsed;
            log.debug('Playlist virtual inicializada en',
                Math.round(elapsed) + 'ms',
                '| Items:', playlist.length);
        }

        bus.emit('playlistRenderizada');
        _procesarPendiente('playlist');
    };

    VP.listas._actualizarVirtualPlaylist = function (
        espaciador, playlist, playlistEl, itemH, contextoBusqueda
    ) {
        if (!espaciador || !playlist || !document.body.contains(espaciador)) return; // Robustez

        var scrollTop = playlistEl.scrollTop || 0;
        var viewH     = playlistEl.clientHeight || window.innerHeight;

        var idxInicio = Math.max(0,
            Math.floor(scrollTop / itemH) - CONST.OVERSCAN
        );
        var idxFin = Math.min(
            playlist.length - 1,
            Math.ceil((scrollTop + viewH) / itemH) + CONST.OVERSCAN
        );

        var rango = _estado.playlist.rangoVisible;

        // CORRECCIÓN: si el espaciador está vacío (no tiene items renderizados),
        // forzar render aunque el rango calculado coincida con el caché.
        // Esto ocurre cuando se reinicializa la lista tras borrado/batch y el
        // rango visible no ha cambiado — sin esto el early return dejaría el
        // espaciador vacío hasta el próximo scroll.
        var espaciadorVacio = espaciador.firstElementChild === null;
        if (!espaciadorVacio && rango.inicio === idxInicio && rango.fin === idxFin) return;
        rango.inicio = idxInicio;
        rango.fin    = idxFin;

        var yaRendered = _obtenerMapaRenderizado('playlist', espaciador);
        // El mapa es la fuente de los elementos creados para esta ventana; evita
        // consultar el DOM y volver a analizar cada dataset en cada scroll.
        yaRendered.forEach(function (elemento, indice) {
            if (indice < idxInicio || indice > idxFin || elemento.parentNode !== espaciador) {
                if (elemento.parentNode === espaciador) {
                    espaciador.removeChild(elemento);
                    _devolverAlPool('playlist', elemento);
                }
                yaRendered.delete(indice);
            }
        });

        // Añadir faltantes
        var frag = document.createDocumentFragment();
        for (var i = idxInicio; i <= idxFin; i++) {
            if (yaRendered.has(i)) continue;
            var video = playlist[i];
            if (!_esVideoValido(video)) continue;

            var idxOriginal = contextoBusqueda && contextoBusqueda.indicesOriginales
                ? contextoBusqueda.indicesOriginales[i]
                : i;
            if (typeof idxOriginal !== 'number' || !isFinite(idxOriginal)) idxOriginal = i;
            var el = contextoBusqueda
                ? _crearItemPlaylistBusqueda(video, idxOriginal, contextoBusqueda.query)
                : VP.listas._construirItemPlaylist(video, i);
            el.dataset.virtualIdx = String(i);
            el.style.position     = 'absolute';
            el.style.top          = (i * itemH) + 'px';
            el.style.left         = '0';
            el.style.right        = '0';

            yaRendered.set(i, el);
            frag.appendChild(el);
            _estado.metricas.itemsRenderizados++;
        }
        espaciador.appendChild(frag);

        // Autoajuste de itemH
        var primerItem = espaciador.querySelector(CONST.SELECTOR_PLAYLIST_ITEM);
        var alturaPrimerItem = primerItem ? primerItem.offsetHeight : 0;
        if (alturaPrimerItem > 0 &&
            alturaPrimerItem !== _estado.playlist.itemHeight) {
            _estado.playlist.itemHeight = alturaPrimerItem;
            espaciador.style.height =
                (playlist.length * _estado.playlist.itemHeight) + 'px';
        }
    };

    // ============================================================
    // PLAYLIST — MODO BATCH
    // ============================================================

    VP.listas._renderizarPlaylistBatch = function (
        inicio, playlist, playlistEl, t0
    ) {
        if (!document.body.contains(playlistEl)) {
            _estado.playlist.renderizando = false;
            return; // Robustez
        }

        if (inicio >= playlist.length) {
            _estado.playlist.renderizando = false;

            if (t0) {
                var elapsed = util.ahora() - t0;
                _estado.metricas.renderPlaylistMs = elapsed;
                log.debug('Playlist (batch) renderizada en',
                    Math.round(elapsed) + 'ms');
            }

            bus.emit('playlistRenderizada');
            _procesarPendiente('playlist');
            return;
        }

        var tamLote = cfg.tamLoteRender || CONST.BATCH_SIZE_PLAYLIST;
        var fin     = Math.min(inicio + tamLote, playlist.length);
        var frag    = document.createDocumentFragment();

        for (var i = inicio; i < fin; i++) {
            if (!_esVideoValido(playlist[i])) continue;
            frag.appendChild(VP.listas._construirItemPlaylist(playlist[i], i));
            _estado.metricas.itemsRenderizados++;
        }

        playlistEl.appendChild(frag);

        if (fin < playlist.length) {
            _programarTimer('playlistRender', function () {
                VP.listas._renderizarPlaylistBatch(
                    fin, playlist, playlistEl, t0
                );
            }, CONST.BATCH_DELAY);
        } else {
            _estado.playlist.renderizando = false;

            if (t0) {
                var e2 = util.ahora() - t0;
                _estado.metricas.renderPlaylistMs = e2;
            }

            bus.emit('playlistRenderizada');
            _procesarPendiente('playlist');
        }
    };

    // ============================================================
    // PLAYLIST — CONSTRUIR ITEM
    // ============================================================

    VP.listas._construirItemPlaylist = function (v, idx) {
        if (!_esVideoValido(v)) {
            log.warn('_construirItemPlaylist: video inválido', v);
            return document.createElement('div');
        }

        var estaActivo = idx === VP.estado.currentVideoIndex;
        var el = _obtenerDelPool('playlist', 'div',
            'playlist-item' + (estaActivo ? ' ' + CONST.CLS_ACTIVE : '')
        );

        el.dataset.idx   = String(idx);
        el.dataset.vidId = String(v.id);
        el.draggable     = true;
        el.setAttribute('role',         'option');
        el.setAttribute('tabindex',     estaActivo ? '0' : '-1');
        el.setAttribute('aria-selected', estaActivo ? 'true' : 'false');
        el.setAttribute('aria-label',   v.name);

        var pct    = _obtenerPct(v);
        var nombre = _escHTML(v.name);
        var pctStr = (isNaN(pct) ? 0 : pct).toFixed(1); // Robustez

        el.innerHTML = _htmlItemPlaylist(v, nombre, pctStr);
        VP.listas._vincularItemPlaylist(el, v, idx);
        return el;
    };

    function _crearItemPlaylistBusqueda(video, idxOriginal, query) {
        var item = VP.listas._construirItemPlaylist(video, idxOriginal);
        if (!item || !query || !VP.busqueda || typeof VP.busqueda.resaltarTexto !== 'function') {
            return item;
        }
        var titulo = item.querySelector('.playlist-title');
        if (titulo) {
            titulo.innerHTML = VP.busqueda.resaltarTexto(titulo.textContent || '', query);
        }
        return item;
    }

    function _htmlItemPlaylist(v, nombre, pctStr) {
        var estiloThumb = v.thumbnail
            ? 'background-image:url(' + v.thumbnail + ')'
            : '';
        var svgPeq  = (util.svg && util.svg.peliculaPeq) || '';
        var svgDl   = (util.svg && util.svg.descargar)   || '⬇';
        var svgDel  = (util.svg && util.svg.eliminar)    || '✕';
        var tam     = _formatSize(v.size);
        var dur     = v.duration ? _formatTime(v.duration) : '';

        return (
            '<div class="playlist-thumb-wrap" data-vid-id="' + v.id + '">' +
                '<div class="thumbnail-container">' +
                    '<div class="thumbnail-image" style="' + estiloThumb + '">' +
                        (v.thumbnail ? '' : svgPeq) +
                    '</div>' +
                    '<div class="thumbnail-preview">' +
                        '<video muted loop preload="none" playsinline></video>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="playlist-info">' +
                '<div class="playlist-title" title="' + nombre + '">' +
                    nombre +
                '</div>' +
                '<div class="playlist-meta">' +
                    (tam ? '<span>' + tam + '</span>' : '') +
                    (dur ? '<span>' + dur + '</span>' : '') +
                '</div>' +
                '<div class="playlist-progress-container" ' +
                    'role="progressbar" ' +
                    'aria-valuenow="' + pctStr + '" ' +
                    'aria-valuemin="0" aria-valuemax="100">' +
                    '<div class="playlist-progress-bar" ' +
                        'style="width:' + pctStr + '%"></div>' +
                '</div>' +
            '</div>' +
            '<div class="playlist-actions">' +
                '<button type="button" class="pl-action" ' +
                    'title="Descargar" data-action="descargar" ' +
                    'aria-label="Descargar ' + nombre + '">' +
                    svgDl +
                '</button>' +
                '<button type="button" class="pl-action del" ' +
                    'title="Eliminar de la lista" data-action="eliminar" ' +
                    'aria-label="Eliminar ' + nombre + ' de la lista">' +
                    svgDel +
                '</button>' +
            '</div>'
        );
    }

    // ============================================================
    // PLAYLIST — VINCULAR EVENTOS
    // ============================================================

    VP.listas._vincularItemPlaylist = function (el, v, idx) {
        if (!el || !v) return;

        var tc = el.querySelector(CONST.SELECTOR_TC);
        if (tc && VP.miniaturas && typeof VP.miniaturas.adjuntarPreview === 'function') {
            try { VP.miniaturas.adjuntarPreview(tc, v); }
            catch (err) { log.warn('Error adjuntando preview en playlist:', err); }
        }
    };

    // ============================================================
    // DRAG & DROP (manejado por delegación de eventos)
    // ============================================================

    function _limpiarDragUI() {
        var playlistEl = VP.refs.playlistEl;
        if (_estado.drag.overEl) {
            _estado.drag.overEl.classList.remove(CONST.CLS_DRAG_OVER);
            _estado.drag.overEl = null;
        }
        if (playlistEl && _estado.drag.srcEl) {
            _estado.drag.srcEl.classList.remove(CONST.CLS_DRAGGING);
        } else if (playlistEl) {
            var items = playlistEl.querySelectorAll(CONST.SELECTOR_PLAYLIST_ITEM);
            for (var x = 0; x < items.length; x++) {
                items[x].classList.remove(CONST.CLS_DRAGGING);
            }
        }

        if (_estado.drag.placeholder && _estado.drag.placeholder.parentNode) {
            _estado.drag.placeholder.parentNode.removeChild(
                _estado.drag.placeholder
            );
        }
        _estado.drag.placeholder = null;

        if (_estado.drag.ghostEl) {
            try { document.body.removeChild(_estado.drag.ghostEl); } catch (e) {}
            _estado.drag.ghostEl = null;
        }

        _estado.drag.srcIndex   = null;
        _estado.drag.srcEl      = null;
        _estado.drag.isDragging = false;
    }

    function _reordenarPlaylist(desde, hasta) {
        var playlist = VP.estado.playlist;
        if (!Array.isArray(playlist)) return; // Robustez
        if (desde < 0 || desde >= playlist.length) return;
        hasta = Math.max(0, Math.min(hasta, playlist.length));

        var movido   = playlist.splice(desde, 1)[0];
        var destReal = desde < hasta ? hasta - 1 : hasta;
        playlist.splice(destReal, 0, movido);

        var ci = VP.estado.currentVideoIndex;
        if      (ci === desde)                VP.estado.currentVideoIndex = destReal;
        else if (desde < ci && destReal >= ci) VP.estado.currentVideoIndex--;
        else if (desde > ci && destReal <= ci) VP.estado.currentVideoIndex++;

        VP.listas.renderizarPlaylist();
        bus.emit('playlistCambiada');
        log.debug('Playlist reordenada:', desde, '→', destReal);
    }

    // ============================================================
    // AÑADIR A PLAYLIST
    // ============================================================

    VP.listas.agregarAPlaylist = function (v) {
        if (!_esVideoValido(v)) {
            log.warn('agregarAPlaylist: video inválido', v);
            return;
        }

        var playlist = VP.estado.playlist;
        if (!Array.isArray(playlist)) return; // Robustez

        for (var i = 0; i < playlist.length; i++) {
            if (playlist[i] && playlist[i].id === v.id) {
                bus.emit('reproducirVideo', i);
                _notificar('"' + v.name + '" ya está en la playlist', 'info');
                return;
            }
        }

        playlist.push(v);
        VP.listas._invalidarIndices();
        VP.listas.renderizarPlaylist();
        _notificar('"' + v.name + '" añadido a la playlist', 'exito');
        bus.emit('playlistCambiada');
        log.debug('Video añadido a playlist:', v.name);
    };

    // ============================================================
    // ELIMINAR DE PLAYLIST
    // ============================================================

    VP.listas.eliminarDePlaylist = function (idx) {
        var playlist = VP.estado.playlist;

        if (!Array.isArray(playlist) || typeof idx !== 'number' || isNaN(idx) ||
            idx < 0 || idx >= playlist.length) {
            log.warn('eliminarDePlaylist: índice inválido', idx);
            return;
        }

        var v = playlist[idx];
        if (!_esVideoValido(v)) {
            log.warn('eliminarDePlaylist: video inválido en idx', idx);
            return;
        }

        if (VP.ajustes && VP.ajustes.confirmarEliminar) {
            try {
                if (!window.confirm(
                    '¿Eliminar "' + v.name + '" de la lista?'
                )) return;
            } catch (_) {}
        }

        _registrarEliminado(v);
        playlist.splice(idx, 1);

        var videos = VP.estado.videos;
        if (Array.isArray(videos)) {
            for (var i = videos.length - 1; i >= 0; i--) {
                if (videos[i] && videos[i].id === v.id) {
                    videos.splice(i, 1);
                    break;
                }
            }
        }

        _actualizarMapas();
        VP.listas._invalidarIndices();

        var ci = VP.estado.currentVideoIndex;
        if (ci === idx) {
            bus.emit('detenerVideo');
            VP.estado.currentVideoIndex = Math.min(idx, playlist.length - 1);
        } else if (ci > idx) {
            VP.estado.currentVideoIndex--;
        }

        VP.listas.renderizarPlaylist();
        VP.listas.renderizarGaleria();
        bus.emit('playlistCambiada');

        // Reaplicar búsqueda activa después de renderizar (Bug 1 fix)
        if (VP.busqueda && VP.refs.searchInput && VP.refs.searchInput.value) {
            var queryActual = VP.refs.searchInput.value;
            VP.busqueda.ejecutarBusqueda(queryActual, true);
        }

        // Registrar exclusión persistente (no recargar este video)
        _registrarExclusionPersistente(v);

        // Generar archivo .bat para eliminar los archivos físicos
        if (VP.bat && typeof VP.bat.generarBat === 'function') {
            VP.bat.generarBat(v.name, v.subtitleName);
        } else {
            // Fallback al método antiguo si VP.bat no está disponible
            bus.emit('generarBatFile');
        }
        
        log.debug('Video eliminado de playlist:', v.name, '| idx:', idx);
    };

    // ============================================================
    // DESCARGAR VIDEO
    // ============================================================

    VP.listas.descargarVideo = function (v) {
        if (!_esVideoValido(v)) {
            log.warn('descargarVideo: video inválido', v);
            return;
        }
        if (!v.file) {
            _notificar('No hay archivo disponible para descargar', 'error');
            return;
        }

        var url = null;
        var a   = null;

        try {
            if (typeof util.crearBlobURLSeguro === 'function') {
                url = util.crearBlobURLSeguro(v.file);
            } else {
                url = URL.createObjectURL(v.file);
            }
        } catch (e) {
            log.error('Error creando URL para descarga:', e);
        }

        if (!url) {
            _notificar('Error al preparar la descarga', 'error');
            return;
        }

        try {
            a          = document.createElement('a');
            a.href     = url;
            a.download = v.name;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
        } catch (err) {
            log.error('Error iniciando descarga:', err);
            _notificar('Error al descargar', 'error');
        } finally {
            try {
                if (a && a.parentNode) a.parentNode.removeChild(a);
            } catch (_) {}
            setTimeout(function () {
                try {
                    if (typeof VP.revocarSeguro === 'function')
                        VP.revocarSeguro(url);
                    else
                        URL.revokeObjectURL(url);
                } catch (_) {}
            }, 3000);
        }

        // ---- Descargar subtítulos si existen ----
        _descargarSubtitulos(v);

        log.debug('Descarga iniciada:', v.name);
    };

    /**
     * Descarga el archivo de subtítulos asociado a un video.
     * @param {Object} v - Objeto de video
     */
    function _descargarSubtitulos(v) {
        var subFile = v.subtitleFile;
        if (!subFile) return;

        var nombreBase = '';
        try {
            nombreBase = util.obtenerNombreBase(v.name);
        } catch (_) {
            nombreBase = util.obtenerNombreBase(subFile.name) || 'subtitulos';
        }

        var ext = subFile.name.split('.').pop();
        if (ext) ext = ext.toLowerCase();

        var subUrl = null;
        try {
            if (typeof util.crearBlobURLSeguro === 'function') {
                subUrl = util.crearBlobURLSeguro(subFile);
            } else {
                subUrl = URL.createObjectURL(subFile);
            }
        } catch (e) {
            log.warn('Error creando URL para subtítulo:', e);
            return;
        }

        if (!subUrl) return;

        try {
            var aSub = document.createElement('a');
            aSub.href     = subUrl;
            aSub.download = nombreBase + '.' + (ext || 'srt');
            aSub.style.display = 'none';
            document.body.appendChild(aSub);
            aSub.click();
            document.body.removeChild(aSub);
        } catch (err) {
            log.warn('Error al descargar subtítulo:', err);
        } finally {
            setTimeout(function () {
                try {
                    if (typeof VP.revocarSeguro === 'function')
                        VP.revocarSeguro(subUrl);
                    else
                        URL.revokeObjectURL(subUrl);
                } catch (_) {}
            }, 3000);
        }
    };

    // ============================================================
    // RESALTAR ITEM ACTIVO
    // ============================================================

    VP.listas.resaltarItemActivo = function () {
        var playlistEl = VP.refs.playlistEl;
        if (!playlistEl) return;

        var items = playlistEl.querySelectorAll(CONST.SELECTOR_PLAYLIST_ITEM);
        var ci    = VP.estado.currentVideoIndex;

        for (var i = 0; i < items.length; i++) {
            var itemIdx  = util.parsearEntero(items[i].dataset.idx, -1);
            var esActivo = itemIdx === ci;
            items[i].classList.toggle(CONST.CLS_ACTIVE, esActivo);
            items[i].setAttribute('aria-selected', esActivo ? 'true' : 'false');
            items[i].setAttribute('tabindex', esActivo ? '0' : '-1');
        }

        var galleryEl = VP.refs.galleryEl;
        if (!galleryEl) return;

        var currentVideo = (Array.isArray(VP.estado.playlist) && ci >= 0 && ci < VP.estado.playlist.length)
            ? VP.estado.playlist[ci] : null;
        var currentVidId = currentVideo ? currentVideo.id : null;

        var galleryItems = galleryEl.querySelectorAll(CONST.SELECTOR_GALLERY_ITEM);
        for (var j = 0; j < galleryItems.length; j++) {
            var vidId  = galleryItems[j].dataset.vidId;
            var activo = vidId && vidId === currentVidId;
            galleryItems[j].classList.toggle(CONST.CLS_ACTIVE, activo);
        }
    };

    // ============================================================
    // SCROLL AL ITEM ACTIVO
    // ============================================================

    VP.listas.scrollAlItemActivo = function () {
        var ci         = VP.estado.currentVideoIndex;
        var playlistEl = VP.refs.playlistEl;
        if (ci < 0 || !playlistEl || !VP.estado.playlist) return;

        if (_usarVirtualizacion(VP.estado.playlist.length)) {
            var targetTop = ci * (_estado.playlist.itemHeight || 82);
            var viewH     = playlistEl.clientHeight;
            var scrollTop = playlistEl.scrollTop;

            if (targetTop < scrollTop ||
                targetTop + (_estado.playlist.itemHeight || 82) > scrollTop + viewH) {
                try {
                    playlistEl.scrollTo({
                        top     : Math.max(0, targetTop - viewH / 2),
                        behavior: 'smooth',
                    });
                } catch (e) {
                    playlistEl.scrollTop = Math.max(0, targetTop - viewH / 2);
                }
            }
            return;
        }

        var activo = playlistEl.querySelector(
            CONST.SELECTOR_PLAYLIST_ITEM + '.' + CONST.CLS_ACTIVE
        );
        if (!activo) return;

        try { dom.scrollHacia(activo); }
        catch (e) {
            try {
                activo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (_) {}
        }
    };

    // ============================================================
    // BARRAS DE PROGRESO
    // ============================================================

    VP.listas._actualizarBarrasProgreso = function () {
        try { _actualizarMapas(); } catch (e) {}

        var galleryEl  = VP.refs.galleryEl;
        var playlistEl = VP.refs.playlistEl;

        // ---- Galería ----
        if (galleryEl) {
            var itemsGal = galleryEl.querySelectorAll(CONST.SELECTOR_GALLERY_ITEM);
            for (var g = 0; g < itemsGal.length; g++) {
                try {
                    var vidId = itemsGal[g].dataset.vidId;
                    if (!vidId) continue;
                    var vid   = (VP.cache && VP.cache.mapaVideoPorId)
                        ? VP.cache.mapaVideoPorId[vidId] : null;
                    if (!vid) continue;

                    var pc  = _obtenerPct(vid);
                    var pcFixed = (isNaN(pc) ? 0 : pc).toFixed(1); // Robustez
                    var bar = itemsGal[g].querySelector(CONST.SELECTOR_GAL_BAR);
                    if (bar) {
                        bar.style.width = pcFixed + '%';
                        var cont = bar.parentNode;
                        if (cont) cont.setAttribute('aria-valuenow', pcFixed);
                    }
                } catch (e) { /* silencioso */ }
            }
        }

        // ---- Playlist ----
        if (playlistEl) {
            var itemsPL  = playlistEl.querySelectorAll(CONST.SELECTOR_PLAYLIST_ITEM);
            var playlist = VP.estado.playlist;

            if (Array.isArray(playlist)) {
                for (var p = 0; p < itemsPL.length; p++) {
                    try {
                        var pidx = util.parsearEntero(itemsPL[p].dataset.idx, -1);
                        if (pidx < 0 || !playlist[pidx]) continue;

                        var ppc = _obtenerPct(playlist[pidx]);
                        var ppcFixed = (isNaN(ppc) ? 0 : ppc).toFixed(1); // Robustez
                        var pb  = itemsPL[p].querySelector(CONST.SELECTOR_PL_BAR);
                        if (pb) {
                            pb.style.width = ppcFixed + '%';
                            var cont2 = pb.parentNode;
                            if (cont2) cont2.setAttribute('aria-valuenow', ppcFixed);
                        }
                    } catch (e) { /* silencioso */ }
                }
            }
        }
    };

    VP.listas.actualizarBarraProgresoVideo = function (videoObj, porcentaje) {
        if (!videoObj || videoObj.id == null) return;

        var galleryEl = VP.refs.galleryEl;
        var playlistEl = VP.refs.playlistEl;
        var id = String(videoObj.id);
        var idSelector = window.CSS && typeof window.CSS.escape === 'function'
            ? window.CSS.escape(id)
            : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        var selector = '[data-vid-id="' + idSelector + '"]';
        var width = Math.max(0, Math.min(100, Number(porcentaje) || 0)).toFixed(1) + '%';
        var contenedores = [galleryEl, playlistEl];

        for (var c = 0; c < contenedores.length; c++) {
            var contenedor = contenedores[c];
            if (!contenedor) continue;
            var items = contenedor.querySelectorAll(selector);
            for (var i = 0; i < items.length; i++) {
                var barra = items[i].querySelector(
                    contenedor === galleryEl ? CONST.SELECTOR_GAL_BAR : CONST.SELECTOR_PL_BAR
                );
                if (!barra) continue;
                if (barra.style.width !== width) barra.style.width = width;
                var valor = width.slice(0, -1);
                var aria = barra.parentNode;
                if (aria && aria.getAttribute('aria-valuenow') !== valor) {
                    aria.setAttribute('aria-valuenow', valor);
                }
            }
        }
    };

    VP.listas.actualizarBarrasProgreso = util.throttle(
        function() {
            try { VP.listas._actualizarBarrasProgreso(); } catch(e) { log.error('Error en throttle progreso:', e); }
        },
        CONST.THROTTLE_PROGRESO
    );

    // ============================================================
    // NAVEGACIÓN POR TECLADO
    // ============================================================

    VP.listas.inicializarNavTeclado = function () {
        var playlistEl = VP.refs.playlistEl;
        if (!playlistEl) {
            log.debug('inicializarNavTeclado: playlistEl no encontrado.');
            return;
        }

        playlistEl.setAttribute('tabindex',            '0');
        playlistEl.setAttribute('role',                'listbox');
        playlistEl.setAttribute('aria-label',          'Lista de reproducción');
        playlistEl.setAttribute('aria-multiselectable','false');

        playlistEl.addEventListener('keydown', _manejarTecladoPlaylist);
        log.debug('Navegación por teclado en playlist inicializada.');
    };

    function _manejarTecladoPlaylist(e) {
        var playlist   = VP.estado.playlist;
        var playlistEl = VP.refs.playlistEl;
        if (!playlist || !playlist.length || !playlistEl) return;

        var items   = playlistEl.querySelectorAll(CONST.SELECTOR_PLAYLIST_ITEM);
        if (!items.length) return;

        var focIdx  = -1;
        var focused = playlistEl.querySelector(
            CONST.SELECTOR_PLAYLIST_ITEM + ':focus,' +
            CONST.SELECTOR_PLAYLIST_ITEM + '.' + CONST.CLS_KB_FOCUS
        );
        for (var i = 0; i < items.length; i++) {
            if (items[i] === focused) { focIdx = i; break; }
        }

        switch (e.key) {
            case 'ArrowDown': case 'j':
                e.preventDefault();
                VP.listas._focarItemPlaylist(items,
                    focIdx < items.length - 1 ? focIdx + 1 : 0);
                break;
            case 'ArrowUp': case 'k':
                e.preventDefault();
                VP.listas._focarItemPlaylist(items,
                    focIdx > 0 ? focIdx - 1 : items.length - 1);
                break;
            case 'Home':
                e.preventDefault();
                VP.listas._focarItemPlaylist(items, 0);
                break;
            case 'End':
                e.preventDefault();
                VP.listas._focarItemPlaylist(items, items.length - 1);
                break;
            case 'PageDown':
                e.preventDefault();
                VP.listas._focarItemPlaylist(items,
                    Math.min(focIdx + 10, items.length - 1));
                break;
            case 'PageUp':
                e.preventDefault();
                VP.listas._focarItemPlaylist(items,
                    Math.max(focIdx - 10, 0));
                break;
            case 'Enter': case ' ':
                e.preventDefault();
                if (focIdx >= 0) {
                    var pidx = util.parsearEntero(items[focIdx].dataset.idx, -1);
                    if (pidx >= 0) bus.emit('reproducirVideo', pidx);
                }
                break;
            case 'Backspace':
                e.preventDefault();
                if (focIdx >= 0) {
                    var didx = util.parsearEntero(items[focIdx].dataset.idx, -1);
                    if (didx >= 0) {
                        var sigIdx = Math.min(focIdx, items.length - 2);
                        VP.listas.eliminarDePlaylist(didx);
                        setTimeout(function () {
                            var nuevos = VP.refs.playlistEl
                                ? VP.refs.playlistEl.querySelectorAll(
                                    CONST.SELECTOR_PLAYLIST_ITEM)
                                : [];
                            if (nuevos.length > 0) {
                                VP.listas._focarItemPlaylist(nuevos,
                                    Math.min(sigIdx, nuevos.length - 1));
                            }
                        }, 120);
                    }
                }
                break;
            case 'f': case 'F':
                if (VP.refs.searchInput) {
                    e.preventDefault();
                    VP.refs.searchInput.focus();
                }
                break;
        }
    }

    VP.listas._focarItemPlaylist = function (items, idx) {
        if (!items || !items.length) return;

        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove(CONST.CLS_KB_FOCUS);
            items[i].setAttribute('tabindex', '-1');
        }

        var target = items[idx];
        if (!target) return;

        target.classList.add(CONST.CLS_KB_FOCUS);
        target.setAttribute('tabindex', '0');

        try { target.focus({ preventScroll: true }); }
        catch (e) { try { target.focus(); } catch (_) {} }

        try { dom.scrollHacia(target); }
        catch (e) {
            try {
                target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (_) {}
        }
    };

    // ============================================================
    // MENÚ CONTEXTUAL
    // ============================================================

    VP.listas.inicializarMenuContextual = function () {
        var menu = _crearElementoMenu();
        _estado.menuCtx.el = menu;

        function mostrarMenu(x, y, vObj) {
            if (!vObj || !menu) return;
            _estado.menuCtx.vidActual = vObj;
            _estado.menuCtx.abierto   = true;

            _construirContenidoMenu(menu, vObj);
            menu.style.display  = 'block';
            menu.style.opacity  = '0';
            menu.style.left     = '0';
            menu.style.top      = '0';

            requestAnimationFrame(function () {
                var mw   = menu.offsetWidth  || 200;
                var mh   = menu.offsetHeight || 100;
                // Robustez: Usar clientWidth/Height para considerar las barras de scroll
                var vW   = document.documentElement.clientWidth || window.innerWidth;
                var vH   = document.documentElement.clientHeight || window.innerHeight;
                
                var left = (x + mw + 8 > vW) ? Math.max(4, x - mw) : x;
                var top  = (y + mh + 8 > vH) ? Math.max(4, y - mh) : y;

                menu.style.left    = left + 'px';
                menu.style.top     = top  + 'px';
                menu.style.opacity = '1';

                var primer = menu.querySelector('[role="menuitem"]:not([disabled])');
                if (primer) primer.focus();
            });
        }

        function ocultarMenu() {
            if (!menu || !_estado.menuCtx.abierto) return;
            menu.style.display      = 'none';
            menu.style.opacity      = '0';
            _estado.menuCtx.abierto   = false;
            _estado.menuCtx.vidActual = null;
        }

        VP.listas._ocultarMenuContextual = ocultarMenu;

        document.addEventListener('click',   ocultarMenu);
        document.addEventListener('scroll',  ocultarMenu, { passive: true });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && _estado.menuCtx.abierto) ocultarMenu();
        });

        document.addEventListener('contextmenu', function (e) {
            var target  = e.target;
            var itemGal = null;

            while (target && target !== document.body) {
                if (target.classList &&
                    target.classList.contains('gallery-item')) {
                    itemGal = target;
                    break;
                }
                target = target.parentNode;
            }

            if (!itemGal) { ocultarMenu(); return; }

            e.preventDefault();

            var vidId = itemGal.dataset.vidId;
            var vObj  = (VP.cache && VP.cache.mapaVideoPorId)
                ? VP.cache.mapaVideoPorId[vidId] : null;

            if (vObj) mostrarMenu(e.clientX, e.clientY, vObj);
            else log.warn('Menú contextual: video no encontrado, id:', vidId);
        });

        log.debug('Menú contextual de galería inicializado.');
    };

    function _crearElementoMenu() {
        // Intentar helper de dom primero
        if (dom && typeof dom.crearMenuContextual === 'function') {
            try { return dom.crearMenuContextual(); } catch (e) {}
        }

        var menu = document.getElementById('vp-ctx-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id        = 'vp-ctx-menu';
            menu.className = 'context-menu';
            menu.style.cssText = [
                'position:fixed', 'display:none', 'z-index:9000',
                'min-width:180px',
                'background:var(--bg-secondary,#1e1e2e)',
                'border:1px solid var(--border,#444)',
                'border-radius:8px',
                'box-shadow:0 8px 32px rgba(0,0,0,0.4)',
                'padding:4px 0', 'font-size:14px',
                'user-select:none', 'transition:opacity 0.1s',
            ].join(';');
            document.body.appendChild(menu);
        }
        return menu;
    }

    function _construirContenidoMenu(menu, vObj) {
        menu.innerHTML = '';
        menu.setAttribute('role',       'menu');
        menu.setAttribute('aria-label', 'Opciones: ' + vObj.name);

        var estaEnPlaylist = false;
        var playlist       = VP.estado.playlist;
        if (Array.isArray(playlist)) {
            for (var i = 0; i < playlist.length; i++) {
                if (playlist[i] && playlist[i].id === vObj.id) { estaEnPlaylist = true; break; }
            }
        }

        var opciones = [
            {
                etiqueta: 'Reproducir ahora', icono: '▶️',
                accion: function (v) { VP.listas.agregarAPlaylist(v); },
            },
            {
                etiqueta    : estaEnPlaylist ? 'Ya en la playlist' : 'Añadir a playlist',
                icono       : estaEnPlaylist ? '✅' : '➕',
                deshabilitado: estaEnPlaylist,
                accion: function (v) {
                    if (!estaEnPlaylist && Array.isArray(VP.estado.playlist)) {
                        VP.estado.playlist.push(v);
                        VP.listas._invalidarIndices();
                        VP.listas.renderizarPlaylist();
                        bus.emit('playlistCambiada');
                        _notificar('"' + v.name + '" añadido', 'exito');
                    }
                },
            },
            { separador: true },
            {
                etiqueta: 'Descargar', icono: '⬇️',
                accion: function (v) { VP.listas.descargarVideo(v); },
            },
            {
                etiqueta: 'Copiar nombre', icono: '📋',
                accion: function (v) { _copiarAlPortapapeles(v.name); },
            },
            { separador: true },
            {
                etiqueta     : vObj.duration
                    ? 'Duración: ' + _formatTime(vObj.duration) : '',
                icono        : 'ℹ️',
                deshabilitado: true, accion: null,
            },
            {
                etiqueta     : vObj.size
                    ? 'Tamaño: ' + _formatSize(vObj.size) : '',
                icono        : '💾',
                deshabilitado: true, accion: null,
            },
        ].filter(function (op) {
            return op.separador || (op.etiqueta && op.etiqueta.length > 0);
        });

        for (var o = 0; o < opciones.length; o++) {
            var op = opciones[o];

            if (op.separador) {
                var sep = document.createElement('div');
                sep.className = 'ctx-menu-separator';
                sep.setAttribute('role', 'separator');
                menu.appendChild(sep);
                continue;
            }

            var item = document.createElement('button');
            item.type      = 'button';
            item.className = 'ctx-menu-item' +
                (op.deshabilitado ? ' disabled' : '');
            item.setAttribute('role', 'menuitem');
            if (op.deshabilitado) item.setAttribute('aria-disabled', 'true');
            item.innerHTML = (op.icono || '') + ' ' + _escHTML(op.etiqueta);

            if (!op.deshabilitado && typeof op.accion === 'function') {
                (function (accion) {
                    item.addEventListener('click', function (e) {
                        e.stopPropagation();
                        try { accion(vObj); } catch (err) {
                            log.error('Error en opción de menú:', err);
                        }
                    });
                })(op.accion);
            }

            menu.appendChild(item);
        }
    }

    function _copiarAlPortapapeles(texto) {
        var soportaClipboard = (VP.features && VP.features.clipboard) &&
                               navigator.clipboard &&
                               typeof navigator.clipboard.writeText === 'function';

        if (soportaClipboard) {
            navigator.clipboard.writeText(texto)
                .then(function () { _notificar('Copiado', 'exito'); })
                .catch(function () { _copiarFallback(texto); });
        } else {
            _copiarFallback(texto);
        }
    }

    function _copiarFallback(texto) {
        try {
            var ta = document.createElement('textarea');
            ta.value = texto;
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            _notificar('Copiado', 'exito');
        } catch (e) {
            _notificar('No se pudo copiar', 'error');
        }
    }

    // ============================================================
    // DELEGACIÓN DE EVENTOS (reduce O(n) listeners a O(1))
    // ============================================================

    /**
     * Obtiene el objeto video desde un elemento DOM de galería.
     * Estrategia:
     * 1. virtualIdx → VP.estado.videos[idx]  (O(1), modo virtual)
     * 2. mapaVideoPorId[vidId]               (O(1), con rebuild automático)
     * 3. Búsqueda lineal en videos[]         (O(n), solo en fallback)
     */
    function _obtenerVideoDesdeElemento(el) {
        if (!el || !el.dataset) return null; // Robustez

        // 1. virtualIdx (modo virtualizado)
        var idx = util.parsearEntero(el.dataset.virtualIdx, -1);
        if (idx >= 0 && VP.estado.videos && VP.estado.videos[idx]) {
            return VP.estado.videos[idx];
        }

        var vidId = el.dataset.vidId;
        if (!vidId) return null;

        // 2. Mapa por id (O(1))
        if (VP.cache && VP.cache.mapaVideoPorId) {
            var v = VP.cache.mapaVideoPorId[vidId];
            if (v) return v;
        }

        // 3. Reconstruir mapa si es necesario
        if (typeof VP.reconstruirMapaVideoPorId === 'function') {
            VP.reconstruirMapaVideoPorId();
            if (VP.cache && VP.cache.mapaVideoPorId) {
                var v2 = VP.cache.mapaVideoPorId[vidId];
                if (v2) return v2;
            }
        }

        // 4. Fallback: búsqueda lineal en videos[]
        var videos = VP.estado.videos;
        if (Array.isArray(videos)) {
            for (var i = 0; i < videos.length; i++) {
                if (videos[i] && String(videos[i].id) === vidId) {
                    return videos[i];
                }
            }
        }

        return null;
    }

    function _delegar(contenedor, evento, selector, callback) {
        if (!contenedor || !selector || typeof callback !== 'function') return function () {};
        function handler(e) {
            var target = e.target;
            while (target && target !== contenedor) {
                try {
                    if (target.matches && target.matches(selector)) {
                        callback(e, target);
                        return;
                    }
                } catch (_) {}
                target = target.parentElement;
            }
        }
        contenedor.addEventListener(evento, handler);
        return function () { contenedor.removeEventListener(evento, handler); };
    }

    function _aplicarVolumenPreview(pvid, audioActivado) {
        if (!pvid) return;
        var principal = VP.refs && VP.refs.videoPlayer;
        var volumen = principal && isFinite(Number(principal.volume))
            ? Number(principal.volume)
            : Number(VP.ajustes && VP.ajustes.volumenGlobal);
        if (!isFinite(volumen)) volumen = 1;
        volumen = Math.max(0, Math.min(1, volumen));
        var silenciadoPrincipal = principal
            ? !!principal.muted
            : !!(VP.ajustes && VP.ajustes.silenciadoGlobal);
        pvid.volume = volumen;
        pvid.muted = !audioActivado || silenciadoPrincipal || volumen === 0;
    }

    function _sincronizarVolumenPreviews() {
        var galleryEl = VP.refs && VP.refs.galleryEl;
        if (!galleryEl || !galleryEl.querySelectorAll) return;
        var botones = galleryEl.querySelectorAll('.thumbnail-audio-btn[data-muted="false"]');
        for (var i = 0; i < botones.length; i++) {
            var tc = botones[i].parentNode;
            while (tc && !tc.classList.contains('thumbnail-container')) tc = tc.parentNode;
            if (tc) _aplicarVolumenPreview(tc.querySelector(CONST.SELECTOR_PVID), true);
        }
    }
    VP.listas.sincronizarVolumenPreviews = _sincronizarVolumenPreviews;

    VP.listas.silenciarAudioPreview = function (contenedor) {
        if (!contenedor) return;
        var boton = contenedor.querySelector(CONST.SELECTOR_THUMB_AUDIO);
        var pvid = contenedor.querySelector(CONST.SELECTOR_PVID);
        if (pvid) {
            pvid.muted = true;
            pvid.volume = 0;
        }
        if (boton) {
            boton.dataset.muted = 'true';
            boton.title = 'Activar audio';
            boton.setAttribute('aria-label', 'Activar audio del preview');
            boton.setAttribute('aria-pressed', 'false');
            boton.innerHTML = (util.svg && util.svg.audioOff) || '🔇';
        }
    };

    VP.listas._inicializarDelegacionEventos = function () {
        var galleryEl  = VP.refs.galleryEl;
        var playlistEl = VP.refs.playlistEl;
        var limp       = _estado.limpiadoresEventos;
        limp.length    = 0;

        // ---- Gallery ----
        if (galleryEl && !VP.dom.esNulo(galleryEl)) {
            limp.push(_delegar(galleryEl, 'click', '.gallery-item',
                function (e, target) {
                    var t = e.target;
                    while (t && t !== target) {
                        if (t.classList && t.classList.contains('thumbnail-audio-btn')) return;
                        t = t.parentNode;
                    }
                    var v = _obtenerVideoDesdeElemento(target);
                    if (v) VP.listas.agregarAPlaylist(v);
                }
            ));
            limp.push(_delegar(galleryEl, 'click', '.thumbnail-audio-btn',
                function (e, btn) {
                    var tc = btn.parentNode;
                    while (tc && !tc.classList.contains('thumbnail-container')) tc = tc.parentNode;
                    if (!tc) return;
                    var pvid = tc.querySelector(CONST.SELECTOR_PVID);
                    if (!pvid) return;
                    var silenciado = btn.dataset.muted !== 'false';
                    var audioActivado = silenciado;
                    _aplicarVolumenPreview(pvid, audioActivado);
                    btn.dataset.muted = String(!audioActivado);
                    btn.title = audioActivado ? 'Silenciar' : 'Activar audio';
                    btn.setAttribute('aria-label', audioActivado ? 'Silenciar audio del preview' : 'Activar audio del preview');
                    btn.setAttribute('aria-pressed', audioActivado ? 'true' : 'false');
                    btn.innerHTML = silenciado
                        ? ((util.svg && util.svg.audioOn)  || '🔊')
                        : ((util.svg && util.svg.audioOff) || '🔇');
                    if (audioActivado && pvid.paused && typeof pvid.play === 'function') {
                        var reproduccion = pvid.play();
                        if (reproduccion && typeof reproduccion.catch === 'function') reproduccion.catch(function () {});
                    }
                }
            ));
            limp.push(_delegar(galleryEl, 'keydown', '.gallery-item',
                function (e, target) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        var v = _obtenerVideoDesdeElemento(target);
                        if (v) VP.listas.agregarAPlaylist(v);
                    }
                }
            ));
        } else {
            log.warn('Delegacion galeria: contenedor invalido');
        }

        var videoPrincipal = VP.refs.videoPlayer;
        if (videoPrincipal && videoPrincipal.addEventListener) {
            var sincronizarVolumen = function () { _sincronizarVolumenPreviews(); };
            videoPrincipal.addEventListener('volumechange', sincronizarVolumen);
            limp.push(function () { videoPrincipal.removeEventListener('volumechange', sincronizarVolumen); });
        }

        // ---- Playlist ----
        if (playlistEl && !VP.dom.esNulo(playlistEl)) {
            limp.push(_delegar(playlistEl, 'click', '.playlist-item',
                function (e, target) {
                    var t = e.target;
                    while (t && t !== target) {
                        if (t.classList && t.classList.contains('pl-action')) return;
                        t = t.parentNode;
                    }
                    var idx = util.parsearEntero(target.dataset.idx, -1);
                    if (idx >= 0) bus.emit('reproducirVideo', idx);
                }
            ));
            limp.push(_delegar(playlistEl, 'click', '[data-action="descargar"]',
                function (e, btn) {
                    e.stopPropagation();
                    var item = btn.parentNode;
                    while (item && !item.classList.contains('playlist-item')) item = item.parentNode;
                    if (!item) return;
                    var idx = util.parsearEntero(item.dataset.idx, -1);
                    if (idx >= 0 && VP.estado.playlist && VP.estado.playlist[idx]) VP.listas.descargarVideo(VP.estado.playlist[idx]);
                }
            ));
            limp.push(_delegar(playlistEl, 'click', '[data-action="eliminar"]',
                function (e, btn) {
                    e.stopPropagation();
                    var item = btn.parentNode;
                    while (item && !item.classList.contains('playlist-item')) item = item.parentNode;
                    if (!item) return;
                    var idx = util.parsearEntero(item.dataset.idx, -1);
                    if (idx >= 0) VP.listas.eliminarDePlaylist(idx);
                }
            ));
            limp.push(_delegar(playlistEl, 'dragstart', '.playlist-item',
                function (e, target) {
                    var realIdx = util.parsearEntero(target.dataset.idx, -1);
                    _estado.drag.srcIndex   = realIdx;
                    _estado.drag.srcEl      = target;
                    _estado.drag.isDragging = true;
                    target.classList.add(CONST.CLS_DRAGGING);
                    if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', String(realIdx));
                    }
                }
            ));
            limp.push(_delegar(playlistEl, 'dragend', '.playlist-item',
                function (e, target) {
                    target.classList.remove(CONST.CLS_DRAGGING);
                    _limpiarDragUI();
                }
            ));
            limp.push(_delegar(playlistEl, 'dragover', '.playlist-item',
                function (e, target) {
                    e.preventDefault();
                    if (!_estado.drag.isDragging) return;
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                    if (_estado.drag.overEl === target) return;
                    if (_estado.drag.overEl) {
                        _estado.drag.overEl.classList.remove(CONST.CLS_DRAG_OVER);
                    }
                    _estado.drag.overEl = target;
                    target.classList.add(CONST.CLS_DRAG_OVER);
                }
            ));
            limp.push(_delegar(playlistEl, 'dragleave', '.playlist-item',
                function (e, target) {
                    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
                    if (_estado.drag.overEl === target) {
                        target.classList.remove(CONST.CLS_DRAG_OVER);
                        _estado.drag.overEl = null;
                    }
                }
            ));
            limp.push(_delegar(playlistEl, 'drop', '.playlist-item',
                function (e, target) {
                    e.preventDefault();
                    e.stopPropagation();
                    var srcIdx = _estado.drag.srcIndex;
                    var dstIdx = util.parsearEntero(target.dataset.idx, -1);
                    if (srcIdx === null || srcIdx < 0 || dstIdx < 0 || srcIdx === dstIdx) {
                        _limpiarDragUI(); return;
                    }
                    var playlist = VP.estado.playlist;
                    if (!Array.isArray(playlist) || srcIdx >= playlist.length || dstIdx >= playlist.length) { // Robustez
                        _limpiarDragUI(); return;
                    }
                    var rect  = target.getBoundingClientRect();
                    var antes = e.clientY < rect.top + rect.height / 2;
                    // Prevenir reordenamiento sobre sí mismo o posiciones adyacentes redundantes
                    var indexObjetivo = antes ? dstIdx : dstIdx + 1;
                    if (indexObjetivo !== srcIdx && indexObjetivo !== srcIdx + 1) {
                        _reordenarPlaylist(srcIdx, indexObjetivo);
                    }
                    _limpiarDragUI();
                }
            ));
        } else {
            log.warn('Delegacion playlist: contenedor invalido');
        }

        log.debug('Delegacion de eventos inicializada (' + limp.length + ' handlers).');
    };

    // ============================================================
    // ALTURA DINÁMICA DE PLAYLIST
    // ============================================================

    VP.listas.actualizarAlturaPlaylist = function () {
        try {
            var playerEl     = document.querySelector('.video-player');
            var playlistSect = VP.refs.playlistSection;
            if (!playerEl || !playlistSect) return;

            playlistSect.style.maxHeight =
                (VP.ajustes && VP.ajustes.scrollPlaylistIndep)
                    ? Math.max(200, playerEl.offsetHeight) + 'px'
                    : '';
        } catch (e) {
            log.warn('Error actualizando altura de playlist:', e);
        }
    };

    VP.listas.inicializarAlturaPlaylist = function () {
        var playerEl = document.querySelector('.video-player');
        if (!playerEl) {
            log.debug('inicializarAlturaPlaylist: .video-player no encontrado.');
            return;
        }

        if (VP.features && VP.features.resizeObserver &&
            typeof ResizeObserver === 'function') {
            if (_estado.resizeObserver) {
                try { _estado.resizeObserver.disconnect(); } catch (e) {}
            }
            _estado.resizeObserver = new ResizeObserver(
                util.debounce(VP.listas.actualizarAlturaPlaylist,
                    CONST.DEBOUNCE_RESIZE)
            );
            _estado.resizeObserver.observe(playerEl);
        }

        window.addEventListener('resize',
            util.debounce(VP.listas.actualizarAlturaPlaylist,
                CONST.DEBOUNCE_RESIZE * 2),
            { passive: true }
        );

        var eventosFS = [
            'fullscreenchange', 'webkitfullscreenchange',
            'mozfullscreenchange', 'MSFullscreenChange',
        ];
        for (var i = 0; i < eventosFS.length; i++) {
            document.addEventListener(eventosFS[i],
                VP.listas.actualizarAlturaPlaylist);
        }

        if (VP.refs.fullscreenBtn) {
            VP.refs.fullscreenBtn.addEventListener('click', function () {
                setTimeout(VP.listas.actualizarAlturaPlaylist, 150);
            });
        }

        VP.listas.actualizarAlturaPlaylist();
        log.debug('Altura dinámica de playlist inicializada.');
    };

    // ============================================================
    // CONTROLES MÓVILES
    // ============================================================

    VP.listas.aplicarControlesMobiles = function () {
        try {
            var vc       = VP.refs.videoControls;
            var esMobile = window.innerWidth <= 768;
            var esTablet = window.innerWidth <= 1024;

            if (vc) {
                vc.classList.toggle('always-visible', esMobile);
                vc.classList.toggle('tablet-mode',    esTablet && !esMobile);
            }

            CONST.OVERSCAN = esMobile ? 2 : 5;
        } catch (e) {
            log.warn('Error aplicando controles mobile:', e);
        }
    };

    VP.listas.inicializarControlesMobiles = function () {
        window.addEventListener('resize',
            util.debounce(VP.listas.aplicarControlesMobiles, 200),
            { passive: true }
        );
        VP.listas.aplicarControlesMobiles();
        log.debug('Controles móviles inicializados.');
    };

    // ============================================================
    // PERSISTENCIA DEL ORDEN DE PLAYLIST
    // ============================================================

    VP.listas._guardarOrdenPlaylist = function () {
        try {
            var playlist = VP.estado.playlist;
            if (!Array.isArray(playlist)) return;

            var orden = [];
            for (var i = 0; i < playlist.length; i++) {
                var v = playlist[i];
                if (!_esVideoValido(v)) continue;
                orden.push({ nombre: v.name, id: v.id, indice: i });
            }

            var clave = (cfg && cfg.claveOrdenPlaylist) || 'vp_orden_playlist';
            _storageSet(clave, orden);
            log.debug('Orden de playlist guardado:', orden.length, 'items');
        } catch (e) {
            log.error('Error guardando orden de playlist:', e);
        }
    };

    /**
     * Restaura el orden de la playlist desde storage.
     * CORRECCIÓN: usa _storageGet en lugar de util.leerItem directamente.
     */
    VP.listas.restaurarOrdenPlaylist = function () {
        try {
            var clave = (cfg && cfg.claveOrdenPlaylist) || 'vp_orden_playlist';
            var orden = _storageGet(clave);

            if (!Array.isArray(orden) || !orden.length) return;

            var playlist = VP.estado.playlist;
            if (!Array.isArray(playlist) || !playlist.length) return;

            // Mapa por id para búsqueda O(1)
            var mapa = {};
            for (var i = 0; i < playlist.length; i++) {
                var v = playlist[i];
                if (v && v.id != null) mapa[String(v.id)] = v;
            }

            var nuevaPlaylist = [];
            for (var o = 0; o < orden.length; o++) {
                var entry = orden[o];
                if (!entry || entry.id == null) continue;
                var key   = String(entry.id);
                if (mapa[key]) {
                    nuevaPlaylist.push(mapa[key]);
                    delete mapa[key];
                }
            }

            // Añadir los que no estaban en el orden guardado
            var restantes = Object.keys(mapa);
            for (var r = 0; r < restantes.length; r++) {
                nuevaPlaylist.push(mapa[restantes[r]]);
            }

            VP.estado.playlist = nuevaPlaylist;
            log.debug('Orden de playlist restaurado:',
                nuevaPlaylist.length, 'items');
        } catch (e) {
            log.error('Error restaurando orden de playlist:', e);
        }
    };

    // ============================================================
    // MÉTRICAS Y DIAGNÓSTICO
    // ============================================================

    VP.listas.obtenerMetricas = function () {
        return {
            renderGaleriaMs   : _estado.metricas.renderGaleriaMs,
            renderPlaylistMs  : _estado.metricas.renderPlaylistMs,
            itemsRenderizados : _estado.metricas.itemsRenderizados,
            reciclajes        : _estado.metricas.reciclajes,
            poolGaleriaSize   : _estado.pool.galeria.length,
            poolPlaylistSize  : _estado.pool.playlist.length,
            rangoGaleria      : {
                inicio: _estado.galeria.rangoVisible.inicio,
                fin   : _estado.galeria.rangoVisible.fin,
            },
            rangoPlaylist     : {
                inicio: _estado.playlist.rangoVisible.inicio,
                fin   : _estado.playlist.rangoVisible.fin,
            },
            indiceGaleriaSize : VP.busqueda
                ? (VP.busqueda.obtenerEstado().indiceGaleriaSize || 0) : 0,
            indicePlaylistSize: VP.busqueda
                ? (VP.busqueda.obtenerEstado().indicePlaylistSize || 0) : 0,
        };
    };

    // ============================================================
    // DELEGACIÓN A VP.BUSQUEDA (backward compatible)
    // ============================================================

    VP.listas._construirIndice = function (videos) {
        return VP.busqueda ? VP.busqueda._construirIndice(videos) : new Map();
    };

    VP.listas._buscarEnIndice = function (indice, query) {
        return VP.busqueda ? VP.busqueda._buscarEnIndice(indice, query) : new Set();
    };

    VP.listas._invalidarIndices = function () {
        if (VP.busqueda) VP.busqueda._invalidarIndices();
    };

    VP.listas.inicializarBusqueda = function () {
        if (VP.busqueda) VP.busqueda.inicializarBusqueda();
    };

    VP.listas.ejecutarBusqueda = function (q) {
        if (VP.busqueda) VP.busqueda.ejecutarBusqueda(q);
    };

    VP.listas.destruir = function () {
        _cancelarTodosLosTimers();
        _desconectarScrollGaleria();
        _desconectarScrollPlaylist();

        // Limpiar delegación de eventos
        var limp = _estado.limpiadoresEventos;
        for (var i = 0; i < limp.length; i++) {
            try { limp[i](); } catch (e) {}
        }
        limp.length = 0;

        if (_estado.lazyObserver) {
            try { _estado.lazyObserver.disconnect(); } catch (e) {}
            _estado.lazyObserver = null;
        }
        if (_estado.resizeObserver) {
            try { _estado.resizeObserver.disconnect(); } catch (e) {}
            _estado.resizeObserver = null;
        }

        _estado.pool.galeria  = [];
        _estado.pool.playlist = [];

        if (_estado.menuCtx.el && _estado.menuCtx.el.parentNode) {
            try {
                _estado.menuCtx.el.parentNode.removeChild(_estado.menuCtx.el);
            } catch (e) {}
        }

        log.info('VP.listas destruido y recursos liberados.');
    };

    // ============================================================
    // INICIALIZAR
    // ============================================================

    VP.listas.inicializar = function () {
        try {
            VP.listas._inicializarDelegacionEventos();
            VP.listas._inicializarLazyObserver();
            VP.listas.inicializarBusqueda();
            VP.listas.inicializarNavTeclado();
            VP.listas.inicializarMenuContextual();
            VP.listas.inicializarAlturaPlaylist();
            VP.listas.inicializarControlesMobiles();
            VP.listas.restaurarOrdenPlaylist();

            log.info('VP.listas inicializado correctamente.',
                '| Umbral virtualización:', _estado.UMBRAL_VIRTUAL,
                '| Pool máx:', _estado.pool.MAX_POOL,
                '| storageGet:', _storageGet.toString().indexOf('localStorage') !== -1
                    ? 'localStorage directo' : 'util wrapper');
        } catch (e) {
            log.error('Error al inicializar VP.listas:', e);
            throw e; // Robustez: Dejar que el error suba a la app principal para no silenciar el crash de inicio
        }
    };

    // ============================================================
    // LISTENERS DEL BUS
    // ============================================================

    bus.on('renderGaleria', function () {
        try { VP.listas.renderizarGaleria(); }
        catch (e) { log.error('renderGaleria bus error:', e); }
    });

    bus.on('renderPlaylist', function () {
        try {
            VP.listas.renderizarPlaylist();
        }
        catch (e) { log.error('renderPlaylist bus error:', e); }
    });

    bus.on('videoReproduciendo', function () {
        try {
            VP.listas.resaltarItemActivo();
            _programarTimer('scrollActivo',
                VP.listas.scrollAlItemActivo, 80);
            // Reaplicar búsqueda activa después de cambiar el estado (Bug 2 fix)
            if (VP.busqueda && VP.refs.searchInput && VP.refs.searchInput.value) {
                var queryActual = VP.refs.searchInput.value;
                VP.busqueda.ejecutarBusqueda(queryActual, true);
            }
        } catch (e) { log.warn('videoReproduciendo bus error:', e); }
    });

    bus.on('videoDetenido', function () {
        try { VP.listas.resaltarItemActivo(); }
        catch (e) { log.warn('videoDetenido bus error:', e); }
    });

    bus.on('progresoActualizado', function () {
        try { VP.listas.actualizarBarrasProgreso(); }
        catch (e) { log.warn('progresoActualizado bus error:', e); }
    });

    bus.on('duracionLista', function (vObj) {
        try {
            if (VP.miniaturas) {
                if (typeof VP.miniaturas.actualizarDuracionPlaylist === 'function')
                    VP.miniaturas.actualizarDuracionPlaylist(vObj);
                if (typeof VP.miniaturas.actualizarDuracionGaleria === 'function')
                    VP.miniaturas.actualizarDuracionGaleria(vObj);
            }
        } catch (e) { log.warn('duracionLista bus error:', e); }
    });

    bus.on('videosActualizados', function () {
        try { VP.listas._invalidarIndices(); }
        catch (e) { log.warn('videosActualizados bus error:', e); }
    });

    var guardarOrdenPlaylistDebounced = util.debounce(function () {
        try { VP.listas._guardarOrdenPlaylist(); }
        catch (e) { log.warn('playlistCambiada guardar orden error:', e); }
    }, 1200);

    bus.on('playlistCambiada', function () {
        // El índice se invalida inmediatamente para que la siguiente búsqueda
        // ya incluya las altas, bajas y reordenamientos recientes.
        try { VP.listas._invalidarIndices(); }
        catch (e) { log.warn('playlistCambiada invalidar búsqueda error:', e); }
        guardarOrdenPlaylistDebounced();
    });

    bus.on('galeriaRenderizada', function () {
        log.debug('Galería renderizada completamente.');
    });

    bus.on('playlistRenderizada', function () {
        log.debug('Playlist renderizada completamente.');
    });

    bus.on('limpiarTodo', function () {
        try { VP.listas.destruir(); }
        catch (e) { log.warn('limpiarTodo bus error:', e); }
    });

    // CORRECCIÓN: cuando VP.eliminar.video() completa una eliminación
    // (incluyendo DB, IA, subtítulos, .bat), emite 'videoEliminado' pero
    // NO dispara re-render. Este handler garantiza que la UI refleje
    // el cambio incluso si la eliminación no pasó por eliminarDePlaylist.
    bus.on('videoEliminado', function () {
        try { VP.listas._invalidarIndices(); } catch (e) { log.warn('videoEliminado invalidar búsqueda:', e); }
        try { VP.listas.renderizarPlaylist(); } catch (e) { log.warn('videoEliminado re-render playlist:', e); }
        try { VP.listas.renderizarGaleria(); } catch (e) { log.warn('videoEliminado re-render galeria:', e); }
    });

    // ============================================================
    // VERIFICACIÓN DE MÓDULO
    // ============================================================

    (function _verificarModulo() {
        var REQUERIDAS = [
            'renderizarGaleria',    'renderizarPlaylist', 'renderizarPlaylistFiltrada',
            '_construirItemGaleria','_construirItemPlaylist',
            'agregarAPlaylist',     'eliminarDePlaylist',
            'descargarVideo',       'resaltarItemActivo',
            'scrollAlItemActivo',   'actualizarBarrasProgreso',
            'inicializarBusqueda',  'ejecutarBusqueda',
            '_construirIndice',     '_buscarEnIndice',
            '_invalidarIndices',    'inicializarNavTeclado',
            '_focarItemPlaylist',   'inicializarMenuContextual',
            'actualizarAlturaPlaylist', 'inicializarAlturaPlaylist',
            'aplicarControlesMobiles', 'inicializarControlesMobiles',
            '_guardarOrdenPlaylist', 'restaurarOrdenPlaylist',
            '_inicializarLazyObserver', 'obtenerMetricas',
            'destruir', 'inicializar',
        ];

        var faltantes = [];
        for (var i = 0; i < REQUERIDAS.length; i++) {
            if (typeof VP.listas[REQUERIDAS[i]] !== 'function')
                faltantes.push(REQUERIDAS[i]);
        }

        if (faltantes.length) {
            log.error('vp-listas.js: funciones faltantes →',
                faltantes.join(', '));
        } else {
            log.debug('vp-listas.js: verificación ✓ (' +
                REQUERIDAS.length + ' funciones OK)');
        }
    })();

    // ============================================================
    // LOG DE CARGA
    // ============================================================

    log.info(
        'vp-listas.js cargado.',
        '| Virtualización: >' + _estado.UMBRAL_VIRTUAL + ' items',
        '| Pool: máx ' + _estado.pool.MAX_POOL,
        '| LazyObserver:',
        (typeof IntersectionObserver === 'function' &&
         VP.features && VP.features.intersectionObserver)
            ? 'disponible' : 'desactivado'
    );

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-listas.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
