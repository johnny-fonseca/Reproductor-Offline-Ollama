'use strict';

// ============================================================
// VP-BASE.JS — v3.2.1
// Núcleo del reproductor de video.
// DEBE cargarse primero. Todos los módulos dependen de window.VP.
// Optimizado para 500+ videos con gestión de memoria agresiva.
//
// MEJORAS memoria (parche):
//   · §28 VP.memoria: auditoría (qué pesa y quién lo creó) + purga escalonada
//   · Keyval stub acotado por bytes (antes crecía sin límite)
//   · Consola/buffer ya no retienen objetos grandes (DevTools los mantiene vivos)
//   · LRUCache revoca el blob reemplazado; AsyncGuard ya no acumula ids de timers
//   · Limpieza de blobs respeta URLs en uso (DOM / miniaturas / video actual)
//
// MEJORAS v3.2.1:
//   · Contador de errores unificado (VP.metricas.errores)
//   · Visibilidad simplificada con compatibilidad hacia atrás
//   · LRUCache – evicción más segura de Blob URLs
//   · Barra de carga creada perezosamente (menor impacto inicial)
//   · Logs con mensajes truncados para evitar sobrecarga de buffer
//   · Histéresis en modo rendimiento adaptativo
//   · Notificación global de errores más robusta
//   · Paginación: nuevo método indicesPaginaActual() sin copia
// ============================================================

(function (window, document) {

    // ── Protección doble inicialización ────────────────────────
    if (window.VP) {
        console.warn('[VP] vp-base.js ya fue cargado. Ignorando.');
        return;
    }

    // ============================================================
    // §1  NAMESPACE PRINCIPAL
    // ============================================================

    var VP = {
        version:      '3.2.1',
        estado:       {},
        runtime:      {},
        cache:        {},
        config:       {},      // ← NO frozen, para que ajustes lo muten
        ajustes:      {},
        metricas:     {},
        features:     {},
        bus:          null,
        log:          null,
        util:         {},
        dom:          {},
        db:           {},      // ← stub completo en §11
        subtitulos:   {},
        miniaturas:   {},
        listas:       {},
        carga:        {},
        reproductor:  {},
        ui:           {},
        eventos:      {},
        refs:         {},
        modulos:      {},
        LRUCache:     null,    // ← clase expuesta en §9
    };

    window.VP = VP;

    // ============================================================
    // §2  CONSTANTES DE CONFIGURACIÓN — Objeto mutable
    //     Otros módulos (vp-ajustes.js) NECESITAN poder escribir
    //     propiedades como pasoSeek, pasoVolumen, etc.
    // ============================================================

    VP.config = {

        // ── Extensiones ─────────────────────────────────────────
        extensionesVideo: [
            '.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv',
            '.m4v', '.3gp', '.flv', '.wmv', '.ts', '.m2ts',
            '.mts', '.vob', '.divx', '.xvid', '.rmvb', '.rm'
        ],
        extensionesSub: ['.vtt', '.srt', '.ass', '.ssa'],

        // ── MIME ────────────────────────────────────────────────
        mapasMime: {
            mp4:  'video/mp4',   webm: 'video/webm',  ogg:  'video/ogg',
            mov:  'video/quicktime', avi: 'video/x-msvideo',
            mkv:  'video/x-matroska', m4v: 'video/mp4',
            '3gp':'video/3gpp',  flv:  'video/x-flv',
            wmv:  'video/x-ms-wmv',   ts:   'video/mp2t',
            m2ts: 'video/mp2t',  mts:  'video/mp2t',
            vob:  'video/mpeg',  divx: 'video/divx',
            xvid: 'video/x-xvid', rmvb:'video/x-pn-realvideo',
            rm:   'video/x-pn-realvideo'
        },

        // ── Base de datos ───────────────────────────────────────
        nombreDB:            'VideoPlayerDB',
        versionDB:           7,
        maxEntradasCache:    500,
        ratioEviccion:       0.25,
        reintentoIDB:        3,
        demoraReintentoIDB:  600,

        // ── Miniaturas ──────────────────────────────────────────
        anchoMiniatura:      240,
        altoMiniatura:       135,
        anchoPreview:        120,
        altoPreview:         68,
        calidadMiniatura:    0.60,
        cantMiniaturas:      6,
        porcentajeBusqueda:  0.12,

        // ── Tiempos (ms) ────────────────────────────────────────
        guardarProgresoMs:   2000,
        ocultarIdleMs:       3000,
        mostrarControlsMs:   3000,
        timeoutSondeo:       7000,
        timeoutMiniatura:    9000,
        timeoutArrayMinis:   14000,
        timeoutCarga:        15000,
        timeoutSubtitulo:    15000,

        // ── Procesamiento por lotes ─────────────────────────────
        tamLoteArchivos:     20,
        demoraLoteArchivos:  30,
        tamLoteRender:       12,
        demoraLoteRender:    80,
        tamGrupoDuracion:    4,
        demoraGrupoDuracion: 500,
        demoraInicioMinis:   1500,
        demoraEntreMiniaturas: 100,

        // ── Límites absolutos ───────────────────────────────────
        maxVideos:           2000,
        maxEntradasLog:      300,
        maxHistorial:        100,
        maxErroresLog:       50,
        maxErroresVentanaMs:  60000,
        maxErroresRepetidos:  6,
        maxStorageItemBytes:  4 * 1024 * 1024,
        storageTrimRatio:     0.25,
        maxPayloadOllamaChars: 180000,
        maxColaOllama:        12,
        maxColaEventBus:      500,

        // ── Controles ───────────────────────────────────────────
        pasoSeek:            5,
        pasoVolumen:         0.1,
        demoraSigVideo:      5,

        // ── Rendimiento ─────────────────────────────────────────
        intervaloRendimiento: 30000,

        // ── Claves localStorage ─────────────────────────────────
        claveAjustes:        'vp_settings_v3',
        claveOrdenPlaylist:  'vp_playlist_order_v2',
        claveTema:           'videoPlayerTheme',
        claveVideosExcluidos: 'vp_excluded_videos_v1',

        // ── Paralelismo ─────────────────────────────────────────
        maxParaleloMiniaturas: 2,
        maxParaleloDuracion:   4,

        // ── Umbrales adaptativos ────────────────────────────────
        umbralBlobsModoLento:    60,
        umbralMemoriaModoLento:  400,
        umbralErroresModoLento:  15,
        umbralVideosModoLento:   400,

        // ── Paginación de galería ───────────────────────────────
        paginaTamano:            60,

        // ── Galería virtual ─────────────────────────────────────
        itemGaleriaMinWidth:     210,
        itemGaleriaHeight:       181,
        galeriaGap:              14,
    };

    // ============================================================
    // §3  ESTADO GLOBAL
    // ============================================================

    VP.estado = {
        videos:                [],
        playlist:              [],
        videoProgress:         [],

        currentVideoIndex:     -1,

        subtitulosActivos:     false,
        hdrActivo:             false,
        mostrarTiempoRestante: false,

        archivosEliminados:    [],
        capitulos:             [],
        abRepeat:              { a: null, b: null, activo: false },
        velocidadActual:       1,
        historialReproduccion: [],

        // Paginación virtual de galería
        paginaGaleria:         0,
        totalPaginasGaleria:   0,
    };

    // ============================================================
    // §4  RUNTIME
    // ============================================================

    VP.runtime = {
        db:                 null,
        idb: {
            listo:          false,
            fallido:        false,
            version:        0,
        },

        dirHandle:          null,
        urlActual:          null,

        // Timers
        notifTimeout:       null,
        shortcutsTimeout:   null,
        controlsHideTimer:  null,
        idleTimer:          null,
        upNextTimer:        null,
        sleepTimerInterval: null,
        watchdogInterval:   null,
        autoSaveInterval:   null,
        rendimientoInterval:null,
        galleryRenderTimer: null,
        playlistRenderTimer:null,

        dragSrcIndex:       null,
        isScrubbing:        false,
        playGeneration:     0,
        contadorId:         0,

        tabVisible:         true,

        estadoCarga: {
            activo:     false,
            cancelado:  false,
            total:      0,
            procesados: 0,
            inicio:     0,
            fase:       '',
        },

        colaMiniaturas:     [],
        miniaturasActivas:  0,
        colaDuracion:       [],
        duracionActiva:     0,

        notifListo:         false,
        inicializado:       false,
        modoLento:          false,
        dialogoNativo:      false,

        guards:             Object.create(null),

        _ultimoFrame:       0,
        _fps:               60,

    };

    // ============================================================
    // §5  CACHÉ E ÍNDICES
    // ============================================================

    VP.cache = {
        mapaProgreso:        Object.create(null),
        mapaVideoPorId:      Object.create(null),
        mapaVideoPorNombre:  Object.create(null),

        poolBlobURLs:        [],
        blobURLSet:          typeof Set !== 'undefined' ? new Set() : null,

        domData:             typeof WeakMap !== 'undefined' ? new WeakMap() : null,

        // LRU — se inicializan en §10 (después de definir la clase)
        lruThumbs:           null,
        lruProgress:         null,

        snapshotUltraPerf: {
            generarMiniaturas:       true,
            habilitarPreviews:       true,
            autoGenerarArrayPreview: true,
        },

        paginasGaleria:      [],
    };

    // ============================================================
    // §6  AJUSTES DE USUARIO
    // ============================================================

    VP.ajustes = {
        autoReanudar:             true,
        generarMiniaturas:        true,
        habilitarPreviews:        true,
        habilitarAtajos:          true,
        repetir:                  false,
        aleatorio:                false,
        colorAcento:              '#ff0033',
        volumenGlobal:            1,
        silenciadoGlobal:         false,
        velocidadGlobal:          1,
        temporizadorSueno:        0,
        hdr:                      false,
        fijarReproductor:         false,
        fijarEncabezado:          true,
        activarMochiIA:           false,
        vozMochiActivada:         false,
        ttsVolume:                1,
        ttsLastVolume:            1,
        scrollPlaylistIndep:      true,
        scrollGaleriaIndep:       false,
        ultraRendimiento:         false,
        nivelLog:                 'INFO',
        autoGenerarArrayPreview:  true,
        confirmarEliminar:        true,
        confirmarLimpiarCache:    true,
        habilitarSiguiente:       true,
        demoraSiguiente:          5,
        pasoSeek:                 5,
        pasoVolumen:              0.1,
        maxHistorialReciente:     100,
        rendimientoAdaptativo:    true,
        paginacionVirtual:        true,
        lazyLoadMiniaturas:       true,
        comprimirThumbs:          true,
    };

    VP.ajustes._claves = Object.keys(VP.ajustes).filter(function (k) {
        return k !== '_claves';
    });

    // ============================================================
    // §7  MÉTRICAS
    // ============================================================

    VP.metricas = {
        errores:               0,
        miniaturasGeneradas:   0,
        miniaturasFallidas:    0,
        miniaturasDesdeIDB:    0,
        miniaturasEvictadas:   0,
        lecturasIDB:           0,
        escriturasIDB:         0,
        erroresIDB:            0,
        bulkWritesIDB:         0,
        videosCargados:        0,
        videosReproducidos:    0,
        ciclosRender:          0,
        blobsCreados:          0,
        blobsRevocados:        0,
        promedioRenderMs:      0,
        picoMemoriaMB:         0,
        inicioSesion:          Date.now(),
        initTotalMs:           0,
        dbInitMs:              0,
        renderFrames:          0,
        eviccionesLRU:         0,
        paginasCargadas:       0,
        eventosEmitidos:       0,
        erroresEventBus:       0,
        erroresGlobales:       0,
        erroresSuprimidos:     0,
        storageFallbacks:      0,
        storageEvicciones:     0,
        ollamaTimeouts:        0,
        ollamaCanceladas:      0,
    };

    // ============================================================
    // §8  DETECCIÓN DE CAPACIDADES
    // ============================================================

    VP.features = (function () {
        function probar(fn) {
            try { return !!fn(); } catch (_) { return false; }
        }
        return {
            indexedDB:         probar(function () {
                var idb = window.indexedDB || window.mozIndexedDB ||
                       window.webkitIndexedDB || window.msIndexedDB;
                return !!(idb && typeof idb.open === 'function');
            }),
            localStorage:      probar(function () {
                var k = '__vp_test__';
                window.localStorage.setItem(k, '1');
                window.localStorage.removeItem(k);
                return true;
            }),
            sessionStorage:    probar(function () {
                var k = '__vp_test__';
                window.sessionStorage.setItem(k, '1');
                window.sessionStorage.removeItem(k);
                return true;
            }),
            wakeLock:          probar(function () {
                return navigator.wakeLock && typeof navigator.wakeLock.request === 'function';
            }),
            isBrave:           probar(function () {
                return !!(navigator.brave && typeof navigator.brave.isBrave === 'function') ||
                       Boolean(window.chrome && (navigator.userAgent.includes('Brave') || navigator.userAgent.includes('Brave/')));
            }),
            fileSystemAccess:  probar(function () {
                return typeof window.showDirectoryPicker === 'function' || typeof window.showOpenFilePicker === 'function';
            }),
            pictureInPicture:  probar(function () {
                return document.pictureInPictureEnabled ||
                       ('requestPictureInPicture' in HTMLVideoElement.prototype);
            }),
            fullscreen:        probar(function () {
                return document.fullscreenEnabled ||
                       document.webkitFullscreenEnabled ||
                       document.mozFullScreenEnabled ||
                       document.msFullscreenEnabled;
            }),
            resizeObserver:    probar(function () { return typeof ResizeObserver !== 'undefined'; }),
            mutationObserver:  probar(function () { return typeof MutationObserver !== 'undefined'; }),
            intersectionObs:   probar(function () { return typeof IntersectionObserver !== 'undefined'; }),
            crypto:            probar(function () {
                return window.crypto && typeof window.crypto.getRandomValues === 'function';
            }),
            blobURL:           probar(function () {
                return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
            }),
            touch:             probar(function () {
                return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
            }),
            fileReader:        probar(function () { return typeof FileReader !== 'undefined'; }),
            blob:              probar(function () { return typeof Blob !== 'undefined'; }),
            weakMap:           probar(function () { return typeof WeakMap !== 'undefined'; }),
            weakSet:           probar(function () { return typeof WeakSet !== 'undefined'; }),
            weakRef:           probar(function () { return typeof WeakRef !== 'undefined'; }),
            set:               probar(function () { return typeof Set !== 'undefined'; }),
            map:               probar(function () { return typeof Map !== 'undefined'; }),
            raf:               probar(function () { return typeof requestAnimationFrame === 'function'; }),
            performance:       probar(function () {
                return typeof performance !== 'undefined' && typeof performance.now === 'function';
            }),
            performanceMemory: probar(function () {
                return performance && performance.memory &&
                       typeof performance.memory.usedJSHeapSize === 'number';
            }),
            idleCallback:      probar(function () { return typeof requestIdleCallback === 'function'; }),
            pageVisibility:    probar(function () { return typeof document.hidden !== 'undefined'; }),
            clipboard:         probar(function () {
                return navigator.clipboard && typeof navigator.clipboard.writeText === 'function';
            }),
            serviceWorker:     probar(function () { return 'serviceWorker' in navigator; }),
            webGL:             probar(function () {
                var c = document.createElement('canvas');
                return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
            }),
            dialog:            probar(function () {
                return typeof document.createElement('dialog').showModal === 'function';
            }),
            mediaSession:      probar(function () { return 'mediaSession' in navigator; }),
            storageEstimate:   probar(function () {
                return navigator.storage && typeof navigator.storage.estimate === 'function';
            }),
            offscreenCanvas:   probar(function () { return typeof OffscreenCanvas !== 'undefined'; }),
            structuredClone:   probar(function () { return typeof structuredClone === 'function'; }),
            promiseAll:        probar(function () {
                return typeof Promise !== 'undefined' && typeof Promise.all === 'function';
            }),
            arrayFrom:         probar(function () { return typeof Array.from === 'function'; }),
        };
    })();

    // Verificación asíncrona de Brave
    if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
        try {
            navigator.brave.isBrave().then(function (res) {
                if (res && VP.features) VP.features.isBrave = true;
            }).catch(function () {});
        } catch (_) {}
    }

    // ============================================================
    // §9  LRUCACHE
    //     Integrada aquí para que vp-db.js y cualquier otro módulo
    //     puedan usarla como VP.LRUCache sin dependencias externas.
    //     Acceso O(1) via Map (moderno) o Object+Array (fallback).
    // ============================================================

    function LRUCache(capacidad, onEvict) {
        if (!(this instanceof LRUCache)) {
            return new LRUCache(capacidad, onEvict);
        }

        capacidad = (typeof capacidad === 'number' && capacidad > 0)
            ? Math.floor(capacidad) : 300;

        this._cap     = capacidad;
        this._onEvict = typeof onEvict === 'function' ? onEvict : null;
        this.size     = 0;

        if (typeof Map !== 'undefined') {
            this._map  = new Map();
            this._mode = 'map';
        } else {
            this._obj  = Object.create(null);
            this._keys = [];
            this._mode = 'obj';
        }
    }

    LRUCache.prototype = {
        constructor: LRUCache,

        /** Obtiene valor; mueve al frente (más reciente). */
        get: function (clave) {
            if (this._mode === 'map') {
                if (!this._map.has(clave)) return undefined;
                var val = this._map.get(clave);
                this._map.delete(clave);
                this._map.set(clave, val);
                return val;
            }
            if (!(clave in this._obj)) return undefined;
            var idx = this._keys.indexOf(clave);
            if (idx > -1) {
                this._keys.splice(idx, 1);
                this._keys.push(clave);
            }
            return this._obj[clave];
        },

        /** Inserta/actualiza; evicta la más antigua si es necesario. */
        set: function (clave, valor) {
            if (this._mode === 'map') {
                if (this._map.has(clave)) {
                    var previo = this._map.get(clave);
                    this._map.delete(clave);
                    this._map.set(clave, valor);
                    // Si el valor cambió, el anterior (p. ej. blob URL) quedaría huérfano
                    if (previo !== valor && this._onEvict) {
                        try { this._onEvict(clave, previo); } catch (_) {}
                    }
                    return this;
                }
                if (this._map.size >= this._cap) this._evictarUno();
                this._map.set(clave, valor);
                this.size = this._map.size;
            } else {
                if (clave in this._obj) {
                    this._obj[clave] = valor;
                    var i = this._keys.indexOf(clave);
                    if (i > -1) { this._keys.splice(i, 1); this._keys.push(clave); }
                    return this;
                }
                if (this._keys.length >= this._cap) this._evictarUno();
                this._obj[clave] = valor;
                this._keys.push(clave);
                this.size = this._keys.length;
            }
            return this;
        },

        /** Verifica existencia sin alterar orden. */
        has: function (clave) {
            return this._mode === 'map'
                ? this._map.has(clave)
                : clave in this._obj;
        },

        /** Elimina entrada específica. */
        delete: function (clave) {
            if (this._mode === 'map') {
                var ok = this._map.delete(clave);
                this.size = this._map.size;
                return ok;
            }
            if (!(clave in this._obj)) return false;
            delete this._obj[clave];
            var idx = this._keys.indexOf(clave);
            if (idx > -1) this._keys.splice(idx, 1);
            this.size = this._keys.length;
            return true;
        },

        /** Vacía todo. */
        clear: function () {
            if (this._onEvict) {
                this.forEach(function (valor, clave) {
                    try { this._onEvict(clave, valor); } catch (_) {}
                }, this);
            }
            if (this._mode === 'map') {
                this._map.clear();
            } else {
                this._obj  = Object.create(null);
                this._keys = [];
            }
            this.size = 0;
        },

        /** Itera (antiguo → reciente). */
        forEach: function (fn, ctx) {
            if (this._mode === 'map') {
                this._map.forEach(fn, ctx || this);
            } else {
                for (var i = 0; i < this._keys.length; i++) {
                    fn.call(ctx || this, this._obj[this._keys[i]], this._keys[i]);
                }
            }
        },

        /** Retorna array de claves. */
        keys: function () {
            if (this._mode === 'map') {
                var arr = [];
                this._map.forEach(function (_, k) { arr.push(k); });
                return arr;
            }
            return this._keys.slice();
        },

        /** Retorna array de valores. */
        values: function () {
            if (this._mode === 'map') {
                var arr = [];
                this._map.forEach(function (v) { arr.push(v); });
                return arr;
            }
            var self = this;
            return this._keys.map(function (k) { return self._obj[k]; });
        },

        /** Reduce a `max` entradas evictando las más antiguas. */
        recortar: function (max) {
            max = Math.max(0, Math.floor(max));
            var guard = 0;
            while (this.size > max && guard++ < 100000) {
                var antes = this.size;
                this._evictarUno();
                if (this.size >= antes) break;
            }
            return this.size;
        },

        /** Diagnóstico. */
        stats: function () {
            return {
                size:      this.size,
                capacidad: this._cap,
                modo:      this._mode,
                uso:       ((this.size / this._cap) * 100).toFixed(1) + '%',
            };
        },

        // ── Privado ──────────────────────────────────────────

        _evictarUno: function () {
            var clave, valor;
            if (this._mode === 'map') {
                var primera = this._map.keys().next();
                if (primera.done) return;
                clave = primera.value;
                valor = this._map.get(clave);
                this._map.delete(clave);
                this.size = this._map.size;
            } else {
                if (!this._keys.length) return;
                clave = this._keys.shift();
                valor = this._obj[clave];
                delete this._obj[clave];
                this.size = this._keys.length;
            }
            VP.metricas.eviccionesLRU++;
            if (this._onEvict) {
                try { this._onEvict(clave, valor); } catch (_) {}
            }
        },
    };

    // Exponer clase
    VP.LRUCache = LRUCache;

    // ============================================================
    // §10  INICIALIZAR INSTANCIAS LRU
    // ============================================================

    (function () {
        VP.cache.lruThumbs = new LRUCache(VP.config.maxEntradasCache, function (clave, valor) {
            // Solo revocar si es una URL blob (para evitar intentos con data URLs u otros)
            if (typeof valor === 'string' && valor.lastIndexOf('blob:', 0) === 0) {
                VP.revocarSeguro(valor);
            }
        });
        VP.cache.lruProgress = new LRUCache(VP.config.maxEntradasCache * 2);
    })();

    // ============================================================
    // §11  STUB COMPLETO DE VP.DB
    //      vp-db.js SOBREESCRIBIRÁ estas funciones.
    //      Si vp-db.js falla, el resto de módulos seguirá usando
    //      estos stubs que resuelven gracefully sin errores.
    // ============================================================

    (function () {

        // ── Helpers internos del stub ────────────────────────────

        function _noop()      { return Promise.resolve(null); }
        function _noopFalse() { return Promise.resolve(false); }
        function _noopTrue()  { return Promise.resolve(true); }
        function _noopArr()   { return Promise.resolve([]); }
        function _noopZero()  { return Promise.resolve(0); }
        function _noopVoid()  { return Promise.resolve(); }

        // Cache en memoria para keyval stub — ACOTADO por presupuesto de bytes
        // (antes era un objeto sin límite que retenía embeddings/chats/transcripciones IA).
        var _kv      = new Map();   // clave → { v, b }  (orden de inserción = recencia)
        var _kvBytes = 0;
        var _kvPrefijosCache = ['vpRecIA_','vpTagsIA_','vpChapIA_','vpChatIA_','vpTransIA_','vpVisionIA_','vpCommentIA_','vp_ai_','summaryIA_'];

        function _kvEstimar(v) {
            try {
                if (v === null || v === undefined) return 8;
                var t = typeof v;
                if (t === 'string') return v.length * 2;
                if (t !== 'object') return 8;
                if (typeof v.byteLength === 'number') return v.byteLength;
                if (typeof Blob !== 'undefined' && v instanceof Blob) return 0;
                return JSON.stringify(v).length * 2;
            } catch (_) { return 1024; }
        }
        function _kvQuitar(k) {
            var e = _kv.get(k);
            if (e) { _kvBytes -= e.b; _kv.delete(k); }
        }
        function _kvEsCache(k) {
            for (var i = 0; i < _kvPrefijosCache.length; i++) {
                if (String(k).lastIndexOf(_kvPrefijosCache[i], 0) === 0) return true;
            }
            return false;
        }
        function _kvRecortar(maxBytes, protegida) {
            var liberado = 0;
            // Pasada 1: solo cachés de IA (regenerables). Pasada 2: cualquier clave.
            for (var pasada = 0; pasada < 2 && _kvBytes > maxBytes; pasada++) {
                var claves = Array.from(_kv.keys());
                for (var i = 0; i < claves.length && _kvBytes > maxBytes; i++) {
                    var k = claves[i];
                    if (k === protegida) continue;
                    if (pasada === 0 && !_kvEsCache(k)) continue;
                    var e = _kv.get(k);
                    if (e) { liberado += e.b; _kvQuitar(k); }
                }
            }
            return liberado;
        }
        function _kvPresupuesto() {
            var c = VP.config && VP.config.memoria;
            return ((c && c.keyValStubMaxMB) || 24) * 1048576;
        }

        // ── Stub API ─────────────────────────────────────────────

        VP.db = {

            // ── Estado ──────────────────────────────────────────
            get listo()   { return VP.runtime.idb.listo; },
            get fallido() { return VP.runtime.idb.fallido; },

            // ── Inicialización ───────────────────────────────────
            inicializar: function () {
                VP.log.warn('VP.db.inicializar: usando stub (vp-db.js no cargado)');
                VP.runtime.idb.fallido = true;
                return _noopFalse();
            },

            reinicializar: function () {
                return VP.db.inicializar();
            },

            cerrar: function () {
                VP.runtime.idb.listo = false;
            },

            borrarTodo: function () {
                VP.log.warn('VP.db.borrarTodo: stub');
                return _noopFalse();
            },

            // ── CRUD base ────────────────────────────────────────
            obtener:            _noop,
            guardar:            _noopFalse,
            eliminar:           _noopFalse,
            limpiarStore:       _noopFalse,
            obtenerTodos:       _noopArr,
            obtenerTodosOrdenados: _noopArr,
            contar:             _noopZero,
            transaccion:        function () { return Promise.reject(new Error('stub')); },

            // ── Lotes ────────────────────────────────────────────
            guardarLote:        _noopZero,
            eliminarLote:       _noopZero,

            // ── Reintentos ───────────────────────────────────────
            conReintentos: function (fn) {
                try { return Promise.resolve(fn()); }
                catch (e) { return Promise.resolve(null); }
            },

            // ── Progreso: TODOS los nombres que usan los módulos ─
            cargarProgreso: _noopVoid,

            guardarProgreso: _noopVoid,

            guardarProgresoUno: function (fileName) {
                VP.db.guardarProgreso();
                return _noopFalse();
            },

            indiceDe: function (fileName) {
                if (!fileName) return -1;
                var mapa = VP.cache.mapaProgreso;
                var idx  = mapa[fileName];
                if (idx !== undefined &&
                    idx >= 0 &&
                    idx < VP.estado.videoProgress.length) {
                    var entry = VP.estado.videoProgress[idx];
                    if (entry && entry.fileName === fileName) return idx;
                }
                var arr = VP.estado.videoProgress;
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i] && arr[i].fileName === fileName) {
                        mapa[fileName] = i;
                        return i;
                    }
                }
                return -1;
            },

            obtenerProgresoPor: function (fileName) {
                if (!fileName) return null;
                var i = VP.db.indiceDe(fileName);
                return i >= 0 ? VP.estado.videoProgress[i] : null;
            },

            actualizarProgreso: function (fileName, currentTime, duracion, extra) {
                if (!fileName) return;
                extra    = extra || {};
                duracion = duracion || 0;

                var obj = {
                    fileName:    fileName,
                    id:          fileName,
                    currentTime: currentTime || 0,
                    duration:    duracion,
                    completado:  duracion > 0 && (currentTime / duracion) > 0.93,
                    _ts:         Date.now(),
                };
                var claves = Object.keys(extra);
                for (var j = 0; j < claves.length; j++) {
                    obj[claves[j]] = extra[claves[j]];
                }

                var i = VP.db.indiceDe(fileName);
                if (i >= 0) {
                    VP.estado.videoProgress[i] = obj;
                } else {
                    VP.estado.videoProgress.push(obj);
                    VP.cache.mapaProgreso[fileName] =
                        VP.estado.videoProgress.length - 1;
                }
            },

            // ── Miniaturas ───────────────────────────────────────
            obtenerMiniatura:       _noop,
            guardarMiniatura:       _noopFalse,
            guardarMiniaturaLote:   _noopZero,
            eliminarMiniatura:      _noopFalse,

            // ── Directorio ───────────────────────────────────────
            guardarDirectorio:      _noopFalse,
            obtenerDirectorio:      _noop,
            eliminarDirectorio:     _noopFalse,

            // ── Metadatos ────────────────────────────────────────
            obtenerMetadatos:       _noop,
            guardarMetadatos:       _noopFalse,
            guardarMetadatosLote:   _noopZero,

            // ── Preferencias ─────────────────────────────────────
            guardarPreferencia:     _noopFalse,
            obtenerPreferencia: function (clave, porDefecto) {
                return Promise.resolve(
                    porDefecto !== undefined ? porDefecto : null
                );
            },
            guardarPreferenciasLote: _noopZero,

            // ── Evicción / Limpieza ──────────────────────────────
            eviccionarLote:         _noopZero,
            limpiarHuerfanas:       _noopZero,
            limpiarCacheAntigua:    _noopVoid,
            limpiarCacheCompleta: function () {
                var todosVideos = (VP.estado && VP.estado.videos) || [];
                var claves = VP.db && typeof VP.db.clavesKeyVal === 'function' ? VP.db.clavesKeyVal() : [];
                var prefijosIA = ['vpRecIA_','vpRecIA_emb_','vpTagsIA_','vpChapIA_','vpChatIA_','vpTransIA_','vpVisionIA_','vpCommentIA_','vp_ai_','vp_floatPos_','summaryIA_','vp_orden_playlist'];
                for (var ci = 0; ci < claves.length; ci++) {
                    var ck = claves[ci];
                    for (var pi = 0; pi < prefijosIA.length; pi++) {
                        if (ck.indexOf(prefijosIA[pi]) === 0) {
                            if (prefijosIA[pi] === 'vp_orden_playlist') {
                                if (VP.db && typeof VP.db.eliminarKeyVal === 'function') VP.db.eliminarKeyVal(ck);
                            } else {
                                for (var ni = 0; ni < todosVideos.length; ni++) {
                                    if (ck === prefijosIA[pi] + todosVideos[ni].name) {
                                        if (VP.db && typeof VP.db.eliminarKeyVal === 'function') VP.db.eliminarKeyVal(ck);
                                        break;
                                    }
                                }
                            }
                            break;
                        }
                    }
                }
                for (var i = 0; i < todosVideos.length; i++) {
                    if (!todosVideos[i]) continue;
                    todosVideos[i].thumbnail      = null;
                    todosVideos[i].thumbnailArray = null;
                    todosVideos[i]._tagsIA        = null;
                }
                VP.bus.emit('cacheVaciada');
                return _noopTrue();
            },
            limpiarMiniaturas:      _noopZero,

            // ── Almacenamiento ───────────────────────────────────
            iniciarMonitorAlmacenamiento: function () {},
            estimarEspacio: function () {
                return Promise.resolve({ usado: 0, total: 0 });
            },

            // ── Export / Import ──────────────────────────────────
            exportarDatos: function () {
                return {
                    version:     VP.version,
                    exportadoEn: new Date().toISOString(),
                    ajustes:     {},
                    progreso:    VP.estado.videoProgress.slice(),
                    historial:   VP.estado.historialReproduccion.slice(),
                };
            },
            importarDatos: function () { return false; },

            // ── Keyval store (stubs) ──────────────────────────────
            guardarKeyVal: function (clave, valor) {
                _kvQuitar(clave);
                var b = _kvEstimar(valor);
                _kv.set(clave, { v: valor, b: b });
                _kvBytes += b;
                var max = _kvPresupuesto();
                if (_kvBytes > max) _kvRecortar(max * 0.8, clave);
            },
            obtenerKeyVal: function (clave) {
                var e = _kv.get(clave);
                if (!e) return null;
                _kv.delete(clave); _kv.set(clave, e);   // refresca recencia
                return e.v;
            },
            eliminarKeyVal:  function (clave) { _kvQuitar(clave); },
            clavesKeyVal:    function () { return Array.from(_kv.keys()); },
            limpiarKeyVal:   function () { _kv.clear(); _kvBytes = 0; },
            _kvStats: function () {
                var top = [];
                _kv.forEach(function (e, k) { top.push({ clave: String(k).slice(0, 60), mb: +(e.b / 1048576).toFixed(2) }); });
                top.sort(function (a, b) { return b.mb - a.mb; });
                return { claves: _kv.size, mb: +(_kvBytes / 1048576).toFixed(2), presupuestoMB: _kvPresupuesto() / 1048576, top: top.slice(0, 5) };
            },
            _kvPurgar: function (nivel) {
                var antes = _kvBytes;
                _kvRecortar(_kvPresupuesto() * (nivel === 'critico' ? 0.15 : 0.5), null);
                return { keyvalAntesMB: +(antes / 1048576).toFixed(2), keyvalDespuesMB: +(_kvBytes / 1048576).toFixed(2) };
            },

            // ── Diagnóstico ──────────────────────────────────────
            diagnostico: function () {
                return Promise.resolve({
                    estado: 'STUB',
                    fallido: true,
                    stores: {},
                });
            },

            // ── Cola diferida ────────────────────────────────────
            cuandoLista: function (fn) {
                try { fn(); } catch (e) {
                    VP.log.error('VP.db.cuandoLista stub error:', e);
                }
            },
        };

    })();

    // ============================================================
    // §12  SISTEMA DE LOGGING
    // ============================================================

    var NIVELES_LOG = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, NONE: 4 };
    var _nivelLog   = NIVELES_LOG.INFO;
    var _bufferLog  = [];
    var _maxLog     = VP.config.maxEntradasLog;

    // ── Deduplicación O(1) — hash map por contexto+nivel+mensaje ──
    var _logMap = Object.create(null);
    var _groupedWarnMap = Object.create(null);
    var _logMapMaxSize = 50;
    var _logLastKey = null;
    var _logSuppressCap = 127;

    function _ts() {
        var d = new Date();
        return ('0' + d.getHours()).slice(-2) + ':' +
               ('0' + d.getMinutes()).slice(-2) + ':' +
               ('0' + d.getSeconds()).slice(-2);
    }

    // Resumen acotado de objetos para log. Evita (a) que DevTools retenga objetos
    // grandes mientras la consola está abierta y (b) JSON.stringify de estructuras enormes.
    function _resumen(v, prof, cuenta) {
        if (v === null) return 'null';
        var t = typeof v;
        if (t === 'string') {
            return v.length > 200 ? JSON.stringify(v.slice(0, 200)) + '…(+' + (v.length - 200) + ')' : JSON.stringify(v);
        }
        if (t === 'number' || t === 'boolean' || t === 'undefined' || t === 'symbol' || t === 'bigint') return String(v);
        if (t === 'function') return '[fn]';
        if (cuenta.n++ > 400) return '…';
        try {
            if (v instanceof Error) return '[Error ' + (v.message || '') + ']';
            if (typeof Node !== 'undefined' && v instanceof Node) return '[' + v.nodeName + ']';
            if (typeof Blob !== 'undefined' && v instanceof Blob) return '[Blob ' + v.size + 'B]';
            if (typeof v.byteLength === 'number') return '[Binary ' + v.byteLength + 'B]';
            if (typeof Map !== 'undefined' && v instanceof Map) return '[Map(' + v.size + ')]';
            if (typeof Set !== 'undefined' && v instanceof Set) return '[Set(' + v.size + ')]';
            if (prof <= 0) return Array.isArray(v) ? '[Array(' + v.length + ')]' : '[Object]';
            var partes = [], i;
            if (Array.isArray(v)) {
                var lim = Math.min(v.length, 10);
                for (i = 0; i < lim; i++) partes.push(_resumen(v[i], prof - 1, cuenta));
                if (v.length > lim) partes.push('…+' + (v.length - lim));
                return '[' + partes.join(',') + ']';
            }
            var ks = Object.keys(v), lk = Math.min(ks.length, 25);
            for (i = 0; i < lk; i++) {
                var val;
                try { val = v[ks[i]]; } catch (_) { val = '[getter]'; }
                partes.push(JSON.stringify(ks[i]) + ':' + _resumen(val, prof - 1, cuenta));
            }
            if (ks.length > lk) partes.push('…+' + (ks.length - lk) + ' keys');
            return '{' + partes.join(',') + '}';
        } catch (_) {
            return '[obj]';
        }
    }

    function _argConsola(a) {
        if (a === null || a === undefined) return a;
        var t = typeof a;
        if (t !== 'object' && t !== 'function') return a;
        if (typeof VP_DEBUG !== 'undefined' && VP_DEBUG && VP_DEBUG.objetosEnConsola === true) return a;
        if (t === 'function') return '[fn ' + (a.name || 'anon') + ']';
        if (a instanceof Error) return a.stack || a.message || String(a);
        return _resumen(a, 3, { n: 0 });
    }

    function _fmtArgs(args) {
        var out = [], len = args.length;
        for (var i = 0; i < len; i++) {
            var a = args[i];
            var t = typeof a;
            if (t === 'string')                         { out.push(a); }
            else if (t === 'number' || t === 'boolean') { out.push(String(a)); }
            else if (a === null)                         { out.push('null'); }
            else if (a === undefined)                    { out.push('undefined'); }
            else if (a instanceof Error)                 { out.push(a.message || String(a)); }
            else {
                out.push(_resumen(a, 3, { n: 0 }));
            }
        }
        return out.join(' ');
    }

    function _truncMsg(s) {
        return s.length > 500 ? s.slice(0, 497) + '...' : s;
    }

    function _consoleOut(nivel, module, args, suffix) {
        var tag  = nivel === 'DEBUG' ? '/D' : '';
        var pre  = '[' + _ts() + '] [VP' + tag + ']';
        if (module) pre += ' [' + module + ']';
        var fn   = nivel === 'ERROR' ? 'error'
                 : nivel === 'WARN'  ? 'warn'
                 : nivel === 'DEBUG' ? 'debug'
                 :                     'log';
        var out  = [pre];
        for (var i = 0; i < args.length; i++) out.push(_argConsola(args[i]));
        if (suffix) out.push(suffix);
        console[fn].apply(console, out);
    }

    function _pushBuffer(nivel, msg) {
        if (_bufferLog.length >= _maxLog) {
            _bufferLog.splice(0, Math.ceil(_maxLog * 0.2));
        }
        _bufferLog.push({ ts: Date.now(), nivel: nivel, msg: msg });
    }

    function _log(nivel, args) {
        var depuracionSilenciosa = typeof VP_DEBUG !== 'undefined' && VP_DEBUG.silenciarConsola === true;
        var debugGlobalActivo = typeof VP_DEBUG !== 'undefined' &&
            (VP_DEBUG.general === true || (VP_DEBUG.VP && VP_DEBUG.VP.general === true));
        var debugModuloActivo = typeof VP_DEBUG !== 'undefined' && VP_DEBUG.VP &&
            VP_DEBUG.VP[VP.log._context || ''] === true;
        if (depuracionSilenciosa && nivel !== 'ERROR' && nivel !== 'WARN' && !debugGlobalActivo && !debugModuloActivo) {
            _pushBuffer(nivel, _truncMsg(_fmtArgs(args)));
            return;
        }
        if (nivel !== 'ERROR' && nivel !== 'WARN') {
            if (typeof VP_DEBUG !== 'undefined' && !VP_DEBUG.general && !VP_DEBUG.VP.general && !(VP_DEBUG.VP && VP_DEBUG.VP[VP.log._context || ''])) return;
        }
        var msg = _truncMsg(_fmtArgs(args));
        _pushBuffer(nivel, msg);
        if (_nivelLog > NIVELES_LOG[nivel]) return;

        var module = VP.log._context || null;
        var key   = (module || '') + '|' + nivel + '|' + msg;

        var entry = _logMap[key];
        if (entry) {
            // Misma clave: incrementar contador
            entry.count++;
            if (entry.count <= 3) {
                // Primeras 3 repeticiones: imprimir con contador visible
                _consoleOut(nivel, module, args, '(' + entry.count + 'x)');
            } else if (entry.count === _logSuppressCap) {
                // Cap reached: anunciar supresión y dejar de contar
                _consoleOut(nivel, module, args, '[repeated ' + _logSuppressCap + ' times — suppressing]');
            }
            // 4+ sin imprimir (supresión silenciosa)
            return;
        }

        // Llegó un mensaje nuevo: flushear el resumen del anterior si tenía repeticiones
        if (_logLastKey) {
            var lastEntry = _logMap[_logLastKey];
            if (lastEntry && lastEntry.count > 1) {
                var repeats = lastEntry.count;
                if (repeats > _logSuppressCap) repeats = _logSuppressCap;
                var fmsg = '↺ previous repeated ' + repeats + ' times';
                _pushBuffer('WARN', fmsg);
                console.warn('[' + _ts() + '] [VP] ' + fmsg);
            }
        }

        // Registrar nueva entrada
        _logMap[key] = { count: 1 };
        _logLastKey = key;

        // Poda del mapa si crece demasiado (evitar memory leak)
        var keys = Object.keys(_logMap);
        if (keys.length > _logMapMaxSize) {
            var claves = keys.slice(0, keys.length - _logMapMaxSize + 10);
            for (var ci = 0; ci < claves.length; ci++) {
                delete _logMap[claves[ci]];
            }
        }

        _consoleOut(nivel, module, args, '');
    }

    VP.log = {
        setNivel: function (n) {
            if (typeof n === 'string') {
                var clave = n.toUpperCase();
                n = NIVELES_LOG[clave] !== undefined
                    ? NIVELES_LOG[clave]
                    : NIVELES_LOG.INFO;
            }
            _nivelLog = n;
        },

        setContext: function (ctx) {
            // Push: guarda contexto anterior en la pila
            if (!this._contextStack) this._contextStack = [];
            this._contextStack.push(this._context);
            this._context = ctx;
        },

        restoreContext: function () {
            // Pop: restaura el último contexto guardado
            if (this._contextStack && this._contextStack.length > 0) {
                this._context = this._contextStack.pop();
            } else {
                this._context = null;
            }
        },

        pushContext: function (ctx) {
            return this.setContext(ctx);
        },

        popContext: function () {
            return this.restoreContext();
        },

        getCurrentContext: function () {
            return this._context || null;
        },

        withContext: function (ctx, fn) {
            this.pushContext(ctx);
            try {
                return fn();
            } finally {
                this.popContext();
            }
        },

        clearContext: function () {
            this._context = null;
            this._contextStack = [];
        },

        debug: function () { _log('DEBUG', arguments); },
        info:  function () { _log('INFO',  arguments); },
        warn:  function () { _log('WARN',  arguments); },
        warnGrouped: function (key) {
            var args = Array.prototype.slice.call(arguments, 1);
            var context = this._context || '';
            var groupKey = context + '|' + String(key || _fmtArgs(args));
            var entry = _groupedWarnMap[groupKey];
            if (entry) { entry.count++; return; }

            entry = _groupedWarnMap[groupKey] = { count: 1 };
            this.warn.apply(this, args);
            setTimeout(function () {
                if (_groupedWarnMap[groupKey] !== entry) return;
                delete _groupedWarnMap[groupKey];
                if (entry.count < 2) return;
                var previousContext = VP.log._context;
                VP.log._context = context || null;
                try {
                    VP.log.warn('Aviso repetido ' + entry.count + ' veces en 10s:', String(key));
                } finally {
                    VP.log._context = previousContext;
                }
            }, 10000);
        },
        error: function () { _log('ERROR', arguments); },

        volcar:  function () { return _bufferLog.slice(); },
        limpiar: function () { _bufferLog = []; _dedupCnt = 0; _dedupMsg = null; },

        exportar: function () {
            return _bufferLog.map(function (e) {
                return new Date(e.ts).toISOString() +
                       ' [' + e.nivel + '] ' + e.msg;
            }).join('\n');
        },
    };

    // ============================================================
    // §13  EVENTBUS
    // ============================================================

    VP.bus = (function () {
        var _handlers       = Object.create(null);
        var _pausado        = false;
        var _colaPausada    = [];
        var _stats          = {
            emitidos:       0,
            errores:        0,
            erroresAsync:   0,
            eventosDescartados: 0,
            maxColaPausada: 0,
            ultimoEvento:   null,
            ultimoTs:       0
        };
        var _moduleListeners = Object.create(null);

        return {
            on: function (evento, fn, ctx) {
                if (!evento || typeof fn !== 'function') return this;
                evento = String(evento);
                if (!_handlers[evento]) _handlers[evento] = [];
                var contexto = ctx || null;
                for (var i = 0; i < _handlers[evento].length; i++) {
                    var existente = _handlers[evento][i];
                    if (existente.fn === fn && existente.ctx === contexto && !existente.once) return this;
                }
                _handlers[evento].push({ fn: fn, ctx: contexto, once: false, moduleId: null });
                return this;
            },

            once: function (evento, fn, ctx) {
                if (!evento || typeof fn !== 'function') return this;
                evento = String(evento);
                if (!_handlers[evento]) _handlers[evento] = [];
                var contexto = ctx || null;
                for (var i = 0; i < _handlers[evento].length; i++) {
                    var existente = _handlers[evento][i];
                    if (existente.fn === fn && existente.ctx === contexto && existente.once) return this;
                }
                _handlers[evento].push({ fn: fn, ctx: contexto, once: true, moduleId: null });
                return this;
            },

            off: function (evento, fn) {
                evento = String(evento || '');
                if (!_handlers[evento]) return this;
                if (!fn) { delete _handlers[evento]; return this; }
                _handlers[evento] = _handlers[evento].filter(function (h) {
                    return h.fn !== fn;
                });
                if (!_handlers[evento].length) delete _handlers[evento];
                return this;
            },

            // ── Auto-cleanup por módulo ──────────────────────────────
            onModule: function (moduleId, evento, fn) {
                if (!moduleId || !evento || typeof fn !== 'function') return this;
                moduleId = String(moduleId);
                evento = String(evento);
                if (!_handlers[evento]) _handlers[evento] = [];
                var registrado = false;
                for (var ri = 0; ri < _handlers[evento].length; ri++) {
                    if (_handlers[evento][ri].fn === fn && _handlers[evento][ri].moduleId === moduleId) {
                        registrado = true;
                        break;
                    }
                }
                if (!registrado) _handlers[evento].push({ fn: fn, ctx: null, once: false, moduleId: moduleId });
                if (!_moduleListeners[moduleId]) _moduleListeners[moduleId] = [];
                var yaListado = _moduleListeners[moduleId].some(function (entrada) {
                    return entrada.evento === evento && entrada.fn === fn;
                });
                if (!yaListado) _moduleListeners[moduleId].push({ evento: evento, fn: fn });
                return this;
            },

            offModule: function (moduleId) {
                var list = _moduleListeners[moduleId];
                if (!list) return this;
                for (var i = 0; i < list.length; i++) {
                    var handlers = _handlers[list[i].evento];
                    if (!handlers) continue;
                    _handlers[list[i].evento] = handlers.filter(function (handler) {
                        return !(handler.fn === list[i].fn && handler.moduleId === String(moduleId));
                    });
                    if (!_handlers[list[i].evento].length) delete _handlers[list[i].evento];
                }
                delete _moduleListeners[moduleId];
                return this;
            },

            emit: function (evento) {
                evento = String(evento || '');
                if (!evento) return this;
                if (_pausado) {
                    _colaPausada.push(Array.prototype.slice.call(arguments));
                    var limiteCola = Number(VP.config.maxColaEventBus);
                    if (!isFinite(limiteCola) || limiteCola < 1) limiteCola = 500;
                    while (_colaPausada.length > limiteCola) {
                        _colaPausada.shift();
                        _stats.eventosDescartados++;
                    }
                    if (_colaPausada.length > _stats.maxColaPausada) {
                        _stats.maxColaPausada = _colaPausada.length;
                    }
                    return this;
                }
                _stats.emitidos++;
                _stats.ultimoEvento = evento;
                _stats.ultimoTs = Date.now();
                if (VP.metricas) VP.metricas.eventosEmitidos = _stats.emitidos;
                if (!_handlers[evento]) return this;

                var args = Array.prototype.slice.call(arguments, 1);
                var hs   = _handlers[evento].slice();
                var keep = [];

                for (var i = 0; i < hs.length; i++) {
                    try {
                        var resultado = hs[i].fn.apply(hs[i].ctx, args);
                        if (resultado && (typeof resultado === 'object' || typeof resultado === 'function')) {
                            var then = resultado.then;
                            if (typeof then === 'function') {
                                (function (promesa, handler, eventName) {
                                    Promise.resolve(promesa).catch(function (reason) {
                                        _stats.errores++;
                                        _stats.erroresAsync++;
                                        if (VP.metricas) {
                                            VP.metricas.erroresEventBus = _stats.errores;
                                            VP.metricas.erroresEventBusAsync = _stats.erroresAsync;
                                        }
                                        try {
                                            if (typeof VP.anotarErrorModulo === 'function') {
                                                VP.anotarErrorModulo(reason, handler.moduleId, 'event:' + eventName);
                                            }
                                            VP.log.error('EventBus async [' + eventName + ']:', reason && (reason.message || reason));
                                        } catch (_) {}
                                    });
                                })(resultado, hs[i], evento);
                            }
                        }
                    } catch (e) {
                        _stats.errores++;
                        if (VP.metricas) VP.metricas.erroresEventBus = _stats.errores;
                        try {
                            if (typeof VP.anotarErrorModulo === 'function') {
                                VP.anotarErrorModulo(e, hs[i].moduleId, 'event:' + evento);
                            }
                            VP.log.error('EventBus [' + evento + ']:', e && (e.message || e));
                        } catch (_) {}
                    }
                    if (!hs[i].once) keep.push(hs[i]);
                }

                if (keep.length) {
                    _handlers[evento] = keep;
                } else {
                    delete _handlers[evento];
                }
                return this;
            },

            pausar: function () { _pausado = true; },

            reanudar: function () {
                _pausado = false;
                var cola = _colaPausada.splice(0);
                for (var i = 0; i < cola.length; i++) {
                    this.emit.apply(this, cola[i]);
                }
            },

            listarEventos: function () { return Object.keys(_handlers); },
            listarDetalle: function () {
                var detalle = {};
                var eventos = Object.keys(_handlers);
                for (var i = 0; i < eventos.length; i++) {
                    detalle[eventos[i]] = _handlers[eventos[i]].length;
                }
                return detalle;
            },
            oyenteCount:   function (ev) {
                return _handlers[ev] ? _handlers[ev].length : 0;
            },
            estadisticas: function () {
                return {
                    emitidos:       _stats.emitidos,
                    errores:        _stats.errores,
                    erroresAsync:   _stats.erroresAsync,
                    eventosDescartados: _stats.eventosDescartados,
                    pausado:        _pausado,
                    colaPausada:    _colaPausada.length,
                    maxColaPausada: _stats.maxColaPausada,
                    ultimoEvento:   _stats.ultimoEvento,
                    ultimoTs:       _stats.ultimoTs,
                    listeners:      this.listarDetalle()
                };
            },
            reset: function () {
                _handlers    = Object.create(null);
                _colaPausada = [];
                _pausado     = false;
                _stats       = {
                    emitidos:       0,
                    errores:        0,
                    erroresAsync:   0,
                    eventosDescartados: 0,
                    maxColaPausada: 0,
                    ultimoEvento:   null,
                    ultimoTs:       0
                };
            },
        };
    })();

    // ============================================================
    // §14  REGISTRO DE MÓDULOS Y GUARDS DE REENTRANCIA
    // ============================================================

    VP.registrarModulo = function (nombre, meta) {
        if (!nombre) return null;
        var clave = String(nombre);
        var anterior = VP.modulos[clave] || {};
        var info = {};
        var k;

        for (k in anterior) {
            if (Object.prototype.hasOwnProperty.call(anterior, k)) {
                info[k] = anterior[k];
            }
        }
        if (meta && typeof meta === 'object') {
            for (k in meta) {
                if (Object.prototype.hasOwnProperty.call(meta, k)) {
                    info[k] = meta[k];
                }
            }
        }

        info.nombre = clave;
        info.cargado = info.cargado !== false;
        info.ts = info.ts || Date.now();
        info.ultimaActualizacion = Date.now();
        VP.modulos[clave] = info;
        return info;
    };

    /** Registra el script que está ejecutándose para mostrar su salud en diagnósticos. */
    VP.registrarScriptActual = function (scriptActual) {
        try {
            var script = scriptActual || document.currentScript;
            var src = typeof script === 'string' ? script : (script && script.src) || '';
            if (!src && script && typeof script.getAttribute === 'function') src = script.getAttribute('src') || '';
            var limpio = String(src).split('#')[0].split('?')[0].replace(/\\/g, '/');
            var archivo = limpio.slice(limpio.lastIndexOf('/') + 1);
            var modulo = archivo.replace(/\.js$/i, '').toLowerCase();
            if (!modulo) return null;
            var existente = VP.modulos[modulo] || {};
            return VP.registrarModulo(modulo, {
                tipo: 'script',
                archivo: archivo,
                src: src,
                cargado: existente.cargado !== false,
                ultimaCarga: Date.now()
            });
        } catch (error) {
            try { VP.log.warn('No se pudo registrar el script actual:', error && (error.message || error)); } catch (_) {}
            return null;
        }
    };

    /** Asocia un fallo de ejecución con el módulo del que procede, si se conoce. */
    VP.anotarErrorModulo = function (error, origen, tipo) {
        try {
            var textoOrigen = typeof origen === 'string' ? origen : '';
            if (!textoOrigen && error) textoOrigen = error.stack || error.message || String(error);
            var coincidencia = String(textoOrigen || '').replace(/\\/g, '/').match(/(?:^|\/)(vp-[a-z0-9-]+)\.js(?:[?:]|$)/i);
            var modulo = coincidencia ? coincidencia[1].toLowerCase() :
                (/^vp-[a-z0-9-]+$/i.test(textoOrigen) ? textoOrigen.toLowerCase() : 'runtime');
            var mensaje = error && (error.stack || error.message) ? (error.stack || error.message) : String(error || 'Error desconocido');
            var info = VP.registrarModulo(modulo, { tipo: 'script' });
            info.erroresRuntime = (Number(info.erroresRuntime) || 0) + 1;
            info.ultimoErrorRuntime = String(mensaje).slice(0, 2000);
            info.ultimoErrorTipo = String(tipo || 'runtime');
            info.ultimoErrorTs = Date.now();
            if (!Array.isArray(info.historialErroresRuntime)) info.historialErroresRuntime = [];
            info.historialErroresRuntime.push({
                ts: info.ultimoErrorTs,
                tipo: info.ultimoErrorTipo,
                mensaje: String(mensaje).slice(0, 500)
            });
            if (info.historialErroresRuntime.length > 20) info.historialErroresRuntime.splice(0, info.historialErroresRuntime.length - 20);
            return info;
        } catch (_) {
            return null;
        }
    };

    VP.marcarModuloError = function (nombre, error, extra) {
        var info = VP.registrarModulo(nombre, { cargado: false });
        info.error = error ? (error.stack || error.message || String(error)) : 'desconocido';
        info.errorTs = Date.now();
        if (extra && typeof extra === 'object') info.extra = extra;
        if (VP.metricas) VP.metricas.errores++;
        try { VP.bus.emit('moduleError', { modulo: nombre, mensaje: info.error }); } catch (_) {}
        return info;
    };

    VP.obtenerSalud = function () {
        var eventos = VP.bus && typeof VP.bus.estadisticas === 'function'
            ? VP.bus.estadisticas()
            : {};
        var memoria = null;
        var scripts = [];

        try {
            if (VP.features.performanceMemory && performance.memory) {
                memoria = {
                    usadoMB:  +(performance.memory.usedJSHeapSize / 1048576).toFixed(2),
                    totalMB:  +(performance.memory.totalJSHeapSize / 1048576).toFixed(2),
                    limiteMB: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(2)
                };
            }
        } catch (_) {}
        try {
            var tags = document.querySelectorAll('script[src*="js/"]');
            for (var si = 0; si < tags.length; si++) {
                scripts.push({
                    src: tags[si].getAttribute('src'),
                    defer: !!tags[si].defer,
                    async: !!tags[si].async
                });
            }
        } catch (_) {}

        return {
            ok:             VP.metricas.errores < VP.config.maxErroresLog,
            version:        VP.version,
            inicializado:   !!VP.runtime.inicializado,
            modoLento:      !!VP.runtime.modoLento,
            online:         ('onLine' in navigator) ? navigator.onLine : null,
            modulos:        JSON.parse(JSON.stringify(VP.modulos || {})),
            scripts:        scripts,
            metricas:       JSON.parse(JSON.stringify(VP.metricas || {})),
            eventos:        eventos,
            memoria:        memoria,
            videos:         VP.estado && VP.estado.videos ? VP.estado.videos.length : 0,
            playlist:       VP.estado && VP.estado.playlist ? VP.estado.playlist.length : 0,
            blobs:          VP.cache && VP.cache.poolBlobURLs ? VP.cache.poolBlobURLs.length : 0,
            guardsActivos:  Object.keys(VP.runtime.guards || {}).filter(function (k) {
                return !!VP.runtime.guards[k];
            })
        };
    };

    VP.guardarGuard = function (clave) {
        if (VP.runtime.guards[clave]) return false;
        VP.runtime.guards[clave] = true;
        return true;
    };

    VP.liberarGuard = function (clave) {
        VP.runtime.guards[clave] = false;
    };

    /**
     * Ejecuta fn con guard automático. Libera el guard incluso si
     * fn lanza excepción. Retorna false si el guard ya estaba activo.
     */
    VP.conGuard = function (clave, fn) {
        if (!VP.guardarGuard(clave)) return false;
        try {
            fn();
        } catch (e) {
            VP.log.error('conGuard [' + clave + ']:', e.message || e);
        } finally {
            VP.liberarGuard(clave);
        }
        return true;
    };

    /**
     * Versión async del guard: retorna Promise.
     */
    VP.conGuardAsync = function (clave, fn) {
        if (!VP.guardarGuard(clave)) return Promise.resolve(false);
        var p;
        try {
            p = fn();
        } catch (e) {
            VP.liberarGuard(clave);
            VP.log.error('conGuardAsync [' + clave + ']:', e.message || e);
            return Promise.resolve(false);
        }
        return Promise.resolve(p).then(function (resultado) {
            VP.liberarGuard(clave);
            return resultado;
        }).catch(function (err) {
            VP.liberarGuard(clave);
            VP.log.error('conGuardAsync [' + clave + ']:', err.message || err);
            return false;
        });
    };

    // ============================================================
    // §14b  AsyncGuard — infraestructura async determinista
    // ============================================================

    /**
     * Guardia de ciclo de vida para módulos async.
     * Agrupa timers, AbortControllers, generaciones y promesas
     * trackeadas en una sola unidad destruible.
     *
     * Uso:
     *   var guard = new VP.AsyncGuard({ name: 'MiModulo' });
     *   guard.setTimeout(fn, 1000);
     *   var ctrl = guard.createController();
     *   var gen  = guard.nextGeneration();
     *   guard.destroy();  // idempotente
     */
    VP.AsyncGuard = function (opts) {
        opts = opts || {};
        this._name        = opts.name || 'unnamed';
        this._destroyed   = false;
        this._timers      = [];
        this._controllers = [];
        this._generation  = 0;
        this._tracked     = [];
    };

    VP.AsyncGuard.prototype = {

        // ── Destrucción (idempotente) ────────────────────────────
        destroy: function () {
            if (this._destroyed) return;
            this._destroyed = true;
            this.abortAll();
            this.clearAllTimers();
            this._tracked.length = 0;
            this._generation = 0;
        },

        isDestroyed: function () {
            return this._destroyed;
        },

        // ── Timers ────────────────────────────────────────────────
        setTimeout: function (fn, delay) {
            if (this._destroyed) return null;
            var self = this;
            var id = setTimeout(function () {
                var ix = self._timers.indexOf(id);
                if (ix >= 0) self._timers.splice(ix, 1);
                if (self._destroyed) return;
                fn();
            }, delay);
            this._timers.push(id);
            return id;
        },

        setInterval: function (fn, delay) {
            if (this._destroyed) return null;
            var self = this;
            var id = setInterval(function () {
                if (self._destroyed) { clearInterval(id); return; }
                fn();
            }, delay);
            this._timers.push(id);
            return id;
        },

        clearAllTimers: function () {
            for (var i = 0; i < this._timers.length; i++) {
                clearTimeout(this._timers[i]);
                clearInterval(this._timers[i]);
            }
            this._timers.length = 0;
        },

        // ── AbortControllers ──────────────────────────────────────
        createController: function () {
            if (this._destroyed) return null;
            var ctrl = new AbortController();
            this._controllers.push(ctrl);
            return ctrl;
        },

        releaseController: function (controller) {
            if (!controller) return false;
            var index = this._controllers.indexOf(controller);
            if (index < 0) return false;
            this._controllers.splice(index, 1);
            return true;
        },

        abortAll: function () {
            for (var i = 0; i < this._controllers.length; i++) {
                try { this._controllers[i].abort(); } catch (_) {}
            }
            this._controllers.length = 0;
        },

        // ── Generation guards ─────────────────────────────────────
        nextGeneration: function () {
            return ++this._generation;
        },

        getGeneration: function () {
            return this._generation;
        },

        isStale: function (gen) {
            return this._destroyed || gen !== this._generation;
        },

        // ── Promise tracking (observabilidad, no cancelación) ────
        track: function (promise) {
            if (this._destroyed || !promise) return promise;
            this._tracked.push(promise);
            var self = this;
            var cleanup = function () {
                var idx = self._tracked.indexOf(promise);
                if (idx >= 0) self._tracked.splice(idx, 1);
            };
            promise.then(cleanup, cleanup);
            return promise;
        },

        getTrackedCount: function () {
            return this._tracked.length;
        },

        // ── Diagnóstico ───────────────────────────────────────────
        getStats: function () {
            return {
                name:        this._name,
                destroyed:   this._destroyed,
                timers:      this._timers.length,
                controllers: this._controllers.length,
                generation:  this._generation,
                tracked:     this._tracked.length
            };
        }
    };

    // ============================================================
    // §15  GESTIÓN DE BLOB URLs
    // ============================================================

    VP.crearBlobURL = function (archivo) {
        if (!archivo || !VP.features.blobURL) return null;
        try {
            var url = URL.createObjectURL(archivo);
            VP.cache.poolBlobURLs.push(url);
            if (VP.cache.blobURLSet) VP.cache.blobURLSet.add(url);
            VP.metricas.blobsCreados++;

            // Auto-limpieza si el pool crece demasiado
            var _maxPool = (VP.config.memoria && VP.config.memoria.maxBlobsPool) || 120;
            if (VP.cache.poolBlobURLs.length > _maxPool) {
                VP._limpiarPoolBlobURLs();
            }

            return url;
        } catch (e) {
            VP.log.warn('crearBlobURL falló:', e.message || e);
            return null;
        }
    };

    VP.revocarBlobURL = function (url) {
        VP.revocarSeguro(url);
        var pool = VP.cache.poolBlobURLs;
        var i    = pool.indexOf(url);
        if (i !== -1) pool.splice(i, 1);
        if (VP.cache.blobURLSet) VP.cache.blobURLSet.delete(url);
    };

    VP.revocarSeguro = function (url) {
        if (url && typeof url === 'string' && url.lastIndexOf('blob:', 0) === 0) {
            try {
                URL.revokeObjectURL(url);
                VP.metricas.blobsRevocados++;
            } catch (_) {}
        }
    };

    VP.revocarTodosBlobURLs = function () {
        var pool = VP.cache.poolBlobURLs;
        var n    = pool.length;
        for (var i = 0; i < n; i++) VP.revocarSeguro(pool[i]);
        VP.cache.poolBlobURLs = [];
        if (VP.cache.blobURLSet) VP.cache.blobURLSet.clear();
        VP.log.debug('Revocados', n, 'Blob URLs');
    };

    /**
     * Limpia blob URLs huérfanos del pool.
     * Conserva: video actual, URLs referenciadas por el DOM, miniaturas en LRU /
     * campos de video, y las creadas hace menos de blobGraciaMs (cargas en curso).
     * @param {boolean} agresivo  ignora el periodo de gracia (limpieza manual)
     */
    VP._limpiarPoolBlobURLs = function (agresivo) {
        var pool      = VP.cache.poolBlobURLs;
        var nuevaPool = [];
        var prot      = (typeof VP._urlsProtegidas === 'function')
                        ? VP._urlsProtegidas()
                        : new Set([VP.runtime.urlActual]);
        var gracia    = agresivo ? 0 : ((VP.config.memoria && VP.config.memoria.blobGraciaMs) || 20000);
        
        for (var i = 0; i < pool.length; i++) {
            var url = pool[i];
            if (prot.has(url) || (!agresivo && VP._blobEdadMs && VP._blobEdadMs(url) < gracia)) {
                nuevaPool.push(url);
            } else {
                VP.revocarSeguro(url);
            }
        }

        var eliminados = pool.length - nuevaPool.length;
        VP.cache.poolBlobURLs = nuevaPool;

        if (VP.cache.blobURLSet) {
            VP.cache.blobURLSet.clear();
            for (var j = 0; j < nuevaPool.length; j++) {
                VP.cache.blobURLSet.add(nuevaPool[j]);
            }
        }

        if (eliminados > 0) {
            VP.log.debug('_limpiarPoolBlobURLs: liberados', eliminados, 'blobs');
        }
    };

    // ============================================================
    // §16  DOM DATA (WeakMap seguro)
    // ============================================================

    VP.setDomData = function (el, data) {
        if (VP.cache.domData && el) {
            try { VP.cache.domData.set(el, data); } catch (_) {}
        }
    };

    VP.getDomData = function (el) {
        if (VP.cache.domData && el) {
            try {
                var d = VP.cache.domData.get(el);
                return d !== undefined ? d : null;
            } catch (_) {}
        }
        return null;
    };

    VP.deleteDomData = function (el) {
        if (VP.cache.domData && el) {
            try { VP.cache.domData.delete(el); } catch (_) {}
        }
    };

    // ============================================================
    // §17  RECONSTRUCCIÓN DE MAPAS
    // ============================================================

    VP.reconstruirMapaProgreso = function () {
        var mapa     = Object.create(null);
        var progreso = VP.estado.videoProgress;
        for (var i = 0; i < progreso.length; i++) {
            var p = progreso[i];
            if (p && p.fileName) mapa[p.fileName] = i;
        }
        VP.cache.mapaProgreso = mapa;
    };

    VP.reconstruirMapaVideoPorId = function () {
        var mapa   = Object.create(null);
        var videos = VP.estado.videos;
        for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            if (v && v.id) mapa[v.id] = v;
        }
        VP.cache.mapaVideoPorId = mapa;
    };

    VP.reconstruirMapaVideoPorNombre = function () {
        var mapa   = Object.create(null);
        var videos = VP.estado.videos;
        for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            if (v && v.nombre) mapa[v.nombre] = true;
        }
        VP.cache.mapaVideoPorNombre = mapa;
    };

    /** Reconstruye los 3 mapas en un solo barrido. */
    VP.reconstruirTodosMapas = function () {
        var mapaProg = Object.create(null);
        var mapaId   = Object.create(null);
        var mapaNom  = Object.create(null);
        var videos   = VP.estado.videos;
        var progreso = VP.estado.videoProgress;

        for (var i = 0; i < progreso.length; i++) {
            var p = progreso[i];
            if (p && p.fileName) mapaProg[p.fileName] = i;
        }
        for (var j = 0; j < videos.length; j++) {
            var v = videos[j];
            if (!v) continue;
            if (v.id)     mapaId[v.id]     = v;
            if (v.nombre) mapaNom[v.nombre] = true;
        }

        VP.cache.mapaProgreso       = mapaProg;
        VP.cache.mapaVideoPorId     = mapaId;
        VP.cache.mapaVideoPorNombre = mapaNom;
    };

    // ============================================================
    // §18  PAGINACIÓN VIRTUAL DE GALERÍA
    // ============================================================

    VP.recalcularPaginasGaleria = function () {
        var tam     = VP.config.paginaTamano;
        var videos  = VP.estado.videos;
        var total   = videos.length;
        var paginas = [];

        for (var i = 0; i < total; i += tam) {
            paginas.push({
                inicio: i,
                fin:    Math.min(i + tam, total) - 1,
                count:  Math.min(tam, total - i),
            });
        }

        VP.cache.paginasGaleria      = paginas;
        VP.estado.totalPaginasGaleria = paginas.length;
        VP.estado.paginaGaleria       = Math.min(
            VP.estado.paginaGaleria,
            Math.max(0, paginas.length - 1)
        );

        VP.bus.emit('paginasGaleriaActualizadas', paginas.length);
        return paginas;
    };

    VP.videosEnPaginaActual = function () {
        var pg = VP.cache.paginasGaleria[VP.estado.paginaGaleria];
        if (!pg) return [];
        return VP.estado.videos.slice(pg.inicio, pg.fin + 1);
    };

    /**
     * Alternativa sin copia: devuelve el rango de índices.
     * Uso: var r = VP.indicesPaginaActual(); for (var i = r.inicio; i <= r.fin; i++) { ... }
     */
    VP.indicesPaginaActual = function () {
        var pg = VP.cache.paginasGaleria[VP.estado.paginaGaleria];
        return pg ? { inicio: pg.inicio, fin: pg.fin } : { inicio: 0, fin: -1 };
    };

    VP.irAPagina = function (numPagina) {
        var max = VP.estado.totalPaginasGaleria - 1;
        var n   = Math.max(0, Math.min(numPagina, max));
        if (n === VP.estado.paginaGaleria) return false;
        VP.estado.paginaGaleria = n;
        VP.bus.emit('paginaGaleriaChanged', n);
        return true;
    };

    // ============================================================
    // §19  HISTORIAL DE REPRODUCCIÓN
    // ============================================================

    VP.agregarAlHistorial = function (vObj) {
        if (!vObj) return;
        var historial = VP.estado.historialReproduccion;
        var max       = VP.config.maxHistorial;

        var ultimo = historial[historial.length - 1];
        if (ultimo && ultimo.id === vObj.id) return;

        historial.push({
            id:        vObj.id,
            nombre:    vObj.nombre || vObj.name || '',
            timestamp: Date.now(),
        });

        if (historial.length > max) {
            historial.splice(0, historial.length - max);
        }

        VP.bus.emit('historialActualizado', historial);
    };

    VP.limpiarHistorial = function () {
        VP.estado.historialReproduccion = [];
        VP.bus.emit('historialActualizado', []);
    };

    // ============================================================
    // §20  RENDIMIENTO ADAPTATIVO (con histéresis)
    // ============================================================

    VP.actualizarPicoMemoria = function () {
        try {
            if (VP.features.performanceMemory) {
                var mb = performance.memory.usedJSHeapSize / 1048576;
                if (mb > VP.metricas.picoMemoriaMB) {
                    VP.metricas.picoMemoriaMB = mb;
                }
                return mb;
            }
        } catch (_) {}
        return 0;
    };

    VP.verificarRendimientoAdaptativo = function () {
        if (!VP.ajustes.rendimientoAdaptativo) return;

        var mb       = VP.actualizarPicoMemoria();
        var nBlobs   = VP.cache.poolBlobURLs.length;
        var nVideos  = VP.estado.videos.length;
        var nErrores = VP.metricas.errores;
        var c        = VP.config;

        try { if (VP.memoria && VP.memoria.evaluar) VP.memoria.evaluar(mb); } catch (_) {}

        var debeRalentizar = (
            nBlobs   > c.umbralBlobsModoLento   ||
            mb       > c.umbralMemoriaModoLento  ||
            nErrores > c.umbralErroresModoLento  ||
            nVideos  > c.umbralVideosModoLento
        );

        // Histéresis: solo salir del modo lento si los valores bajan del 80% de los umbrales
        var margen = 0.8;
        if (!debeRalentizar && VP.runtime.modoLento) {
            var puedeSalir = true;
            if (nBlobs   > c.umbralBlobsModoLento   * margen) puedeSalir = false;
            if (mb       > c.umbralMemoriaModoLento  * margen) puedeSalir = false;
            if (nErrores > c.umbralErroresModoLento  * margen) puedeSalir = false;
            if (nVideos  > c.umbralVideosModoLento   * margen) puedeSalir = false;
            if (!puedeSalir) {
                // No cambiar aún, mantener modo lento
                return;
            }
        }

        if (debeRalentizar === VP.runtime.modoLento) return;
        VP.runtime.modoLento = debeRalentizar;

        if (debeRalentizar) {
            c.maxParaleloMiniaturas = 1;
            c.maxParaleloDuracion   = 2;
            c.tamLoteRender         = 6;
            c.demoraLoteRender      = 150;
            c.demoraEntreMiniaturas = 200;

            VP.log.warn(
                'Adaptativo: MODO LENTO |',
                'blobs:', nBlobs,
                '| mem:', Math.round(mb) + 'MB',
                '| videos:', nVideos
            );
        } else {
            c.maxParaleloMiniaturas = 2;
            c.maxParaleloDuracion   = 4;
            c.tamLoteRender         = 12;
            c.demoraLoteRender      = 80;
            c.demoraEntreMiniaturas = 100;

            VP.log.info('Adaptativo: modo normal restaurado');
        }

        // Comprimir miniaturas si hay muchos videos
        if (nVideos > 300 && VP.ajustes.comprimirThumbs) {
            c.calidadMiniatura = 0.45;
        } else {
            c.calidadMiniatura = 0.60;
        }

        VP.bus.emit('rendimientoAdaptativo', debeRalentizar);
    };

    // ============================================================
    // §21  BARRA DE PROGRESO DE CARGA MASIVA (creación perezosa)
    // ============================================================

    VP.baraCarga = (function () {
        var _wrap;
        var _relleno;
        var _etiqueta;
        var _archivoLabel;
        var _etaEtiqueta;
        var _btnCancelar;
        var _insertada = false;
        var _cssInyectado = false;

        function _inyectarCSS() {
            if (_cssInyectado) return;
            _cssInyectado = true;
            var style = document.createElement('style');
            style.textContent = [
                '#vp-load-bar{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);width:auto;min-width:400px;max-width:800px;z-index:99999;background:linear-gradient(180deg,#222,#1a1a1a);padding:10px 16px;box-sizing:border-box;display:none;flex-direction:column;gap:5px;border:1px solid #333;border-radius:10px;font-family:sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.6)}',
                '#vp-load-bar .vp-load-row{display:flex;align-items:center;gap:12px}',
                '#vp-load-bar .vp-load-track{flex:1;height:8px;background:#2a2a2a;border-radius:4px;overflow:hidden;position:relative}',
                '#vp-load-bar .vp-load-fill{height:100%;width:0%;border-radius:4px;transition:width .3s cubic-bezier(.4,0,.2,1);position:relative;overflow:hidden}',
                '#vp-load-bar .vp-load-fill::after{content:"";position:absolute;top:0;left:-100%;width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.2),transparent);animation:vpLoadShimmer 1.5s infinite}',
                '@keyframes vpLoadShimmer{0%{left:-100%}100%{left:100%}}',
                '#vp-load-bar .vp-load-fill.complete{background:linear-gradient(90deg,#27ae60,#2ecc71)}',
                '#vp-load-bar .vp-load-fill.complete::after{display:none}',
                '#vp-load-bar .vp-load-label{color:#ccc;font-size:12px;white-space:nowrap;min-width:140px;text-align:right;font-weight:500}',
                '#vp-load-bar .vp-load-file{color:#888;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px;text-align:left;flex:1}',
                '#vp-load-bar .vp-load-eta{color:#777;font-size:11px;white-space:nowrap;min-width:80px;text-align:right}',
                '#vp-load-bar .vp-load-cancel{background:linear-gradient(180deg,#e74c3c,#c0392b);color:#fff;border:none;padding:5px 14px;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;flex-shrink:0;transition:filter .2s,transform .1s;text-transform:uppercase;letter-spacing:.5px}',
                '#vp-load-bar .vp-load-cancel:hover{filter:brightness(1.15)}',
                '#vp-load-bar .vp-load-cancel:active{transform:scale(.97)}',
                '#vp-load-bar .vp-load-pct{color:var(--vp-acento,#ff0033);font-size:13px;font-weight:700;min-width:40px;text-align:right}',
            ].join('');
            document.head.appendChild(style);
        }

        function _asegurarWrap() {
            if (_wrap) return;
            _inyectarCSS();
            _wrap = document.createElement('div');
            _wrap.id = 'vp-load-bar';
            _wrap.setAttribute('role', 'progressbar');
            _wrap.setAttribute('aria-label', 'Cargando archivos');

            // Row 1: barra + porcentaje + ETA + cancelar
            var row1 = document.createElement('div');
            row1.className = 'vp-load-row';

            var barraWrap = document.createElement('div');
            barraWrap.className = 'vp-load-track';

            _relleno = document.createElement('div');
            _relleno.className = 'vp-load-fill';
            barraWrap.appendChild(_relleno);

            var pctSpan = document.createElement('span');
            pctSpan.className = 'vp-load-pct';
            pctSpan.textContent = '0%';

            _etaEtiqueta = document.createElement('span');
            _etaEtiqueta.className = 'vp-load-eta';

            _btnCancelar = document.createElement('button');
            _btnCancelar.className = 'vp-load-cancel';
            _btnCancelar.textContent = '✕ Cancelar';
            _btnCancelar.addEventListener('click', function () {
                VP.bus.emit('cancelarCarga');
            });

            row1.appendChild(barraWrap);
            row1.appendChild(pctSpan);
            row1.appendChild(_etaEtiqueta);
            row1.appendChild(_btnCancelar);

            // Row 2: label de fase + archivo actual
            var row2 = document.createElement('div');
            row2.className = 'vp-load-row';

            _etiqueta = document.createElement('span');
            _etiqueta.className = 'vp-load-label';

            _archivoLabel = document.createElement('span');
            _archivoLabel.className = 'vp-load-file';

            row2.appendChild(_etiqueta);
            row2.appendChild(_archivoLabel);

            _wrap.appendChild(row1);
            _wrap.appendChild(row2);

            if (document.body) {
                document.body.appendChild(_wrap);
                _insertada = true;
            } else {
                document.addEventListener('DOMContentLoaded', function () {
                    document.body.appendChild(_wrap);
                    _insertada = true;
                });
            }
        }

        function _fmtETA(s) {
            if (s < 0) return '';
            if (s < 60) return Math.round(s) + 's';
            var m = Math.floor(s / 60);
            var seg = Math.round(s % 60);
            return m + 'm ' + seg + 's';
        }

        return {
            mostrar: function (fase) {
                _asegurarWrap();
                if (_wrap) {
                    _wrap.style.display = 'flex';
                    if (fase && _etiqueta) _etiqueta.textContent = fase;
                    if (_relleno) {
                        _relleno.classList.remove('complete');
                        _relleno.style.background = '';
                    }
                    if (!VP.runtime.estadoCarga.inicio) {
                        VP.runtime.estadoCarga.inicio = Date.now();
                    }
                }
            },

            ocultar: function () {
                if (_wrap) _wrap.style.display = 'none';
            },

            actualizar: function (n, total, fase, archivoActual) {
                if (!_wrap || _wrap.style.display === 'none') return;

                var pct = total > 0
                    ? Math.min(100, (n / total) * 100).toFixed(1)
                    : 0;

                if (_relleno) _relleno.style.width = pct + '%';
                if (_archivoLabel) {
                    _archivoLabel.textContent = archivoActual || '';
                }

                var txt = fase || 'Procesando ' + n + ' / ' + total;
                if (_etiqueta) _etiqueta.textContent = txt;

                var pctSpan = _wrap && _wrap.querySelector('.vp-load-pct');
                if (pctSpan) pctSpan.textContent = Math.round(pct) + '%';

                var inicio = VP.runtime.estadoCarga.inicio;
                if (n > 5 && inicio && _etaEtiqueta) {
                    var transcurrido = (Date.now() - inicio) / 1000;
                    var tasa         = n / transcurrido;
                    var restante     = tasa > 0 ? Math.ceil((total - n) / tasa) : 0;
                    _etaEtiqueta.textContent = restante > 0
                        ? '~' + _fmtETA(restante)
                        : '';
                } else if (_etaEtiqueta) {
                    _etaEtiqueta.textContent = '';
                }

                if (_wrap) _wrap.setAttribute('aria-valuenow', String(pct));
            },

            completar: function (msg) {
                if (_relleno) {
                    _relleno.style.width = '100%';
                    _relleno.style.background = 'linear-gradient(90deg,#27ae60,#2ecc71)';
                    _relleno.classList.add('complete');
                }
                if (_etiqueta) _etiqueta.textContent = msg || '✓ Completado';
                if (_archivoLabel) _archivoLabel.textContent = '';
                if (_etaEtiqueta) _etaEtiqueta.textContent = '';
                var pctSpan = _wrap && _wrap.querySelector('.vp-load-pct');
                if (pctSpan) pctSpan.textContent = '✓';
                setTimeout(function () {
                    if (_wrap) {
                        _wrap.style.display = 'none';
                        if (_relleno) {
                            _relleno.style.width = '0%';
                            _relleno.style.background = '';
                            _relleno.classList.remove('complete');
                        }
                    }
                }, 2500);
            },

            setFase: function (fase) {
                if (_etiqueta) _etiqueta.textContent = fase || '';
            },

            setArchivoActual: function (nombre) {
                if (_archivoLabel) _archivoLabel.textContent = nombre || '';
            },
        };
    })();

    // ============================================================
    // §22  VISIBILIDAD DE PESTAÑA
    // ============================================================

    if (VP.features.pageVisibility) {
        document.addEventListener('visibilitychange', function () {
            VP.runtime.tabVisible = !document.hidden;
            VP.bus.emit('visibilidad', VP.runtime.tabVisible);
            VP.log.debug('Visibilidad:', VP.runtime.tabVisible ? 'visible' : 'oculta');
        });
    }

    // ============================================================
    // §23  RED
    // ============================================================

    if ('onLine' in navigator) {
        window.addEventListener('online', function () {
            VP.bus.emit('redConectada');
            VP.log.info('Red: conectada');
        });
        window.addEventListener('offline', function () {
            VP.bus.emit('redDesconectada');
            VP.log.warn('Red: desconectada');
        });
    }

    // ============================================================
    // §24  PROTECCIÓN GLOBAL ANTI-CRASH (contador unificado)
    // ============================================================

    var _erroresGlobalesRecientes = Object.create(null);

    function _extraerMensajeErrorGlobal(e) {
        if (!e) return 'Error desconocido';
        var objetivo = e.target || e.srcElement;
        if (objetivo && objetivo !== window) {
            var recurso = objetivo.currentSrc || objetivo.src ||
                (typeof objetivo.getAttribute === 'function' && objetivo.getAttribute('href')) || '';
            var etiqueta = String(objetivo.tagName || 'RECURSO').toLowerCase();
            if (recurso) return 'No se pudo cargar <' + etiqueta + '>: ' + String(recurso).slice(0, 500);
        }
        var err = e.error || e.reason || null;
        return err
            ? (err.stack || err.message || String(err))
            : (e.message || String(e));
    }

    function _esRuidoLocalEsperado(msg, filename) {
        msg = String(msg || '');
        filename = String(filename || '');
        return msg.indexOf('localhost:11434') !== -1 ||
               filename.indexOf('localhost:11434') !== -1 ||
               msg.indexOf('ERR_CONNECTION_REFUSED') !== -1 ||
               msg.indexOf('Failed to fetch') !== -1 ||
               msg.indexOf('Ollama') !== -1;
    }

    function _debeRegistrarErrorGlobal(tipo, msg) {
        var ahora = Date.now();
        var ventana = VP.config.maxErroresVentanaMs || 60000;
        var maxRep = VP.config.maxErroresRepetidos || 6;
        var firma = tipo + ':' + String(msg || '').slice(0, 220);
        var item = _erroresGlobalesRecientes[firma];

        if (!item || ahora - item.ts > ventana) {
            _erroresGlobalesRecientes[firma] = { ts: ahora, count: 1 };
            return true;
        }

        item.count++;
        if (item.count > maxRep) {
            VP.metricas.erroresSuprimidos++;
            return false;
        }
        return true;
    }

    function _notificarErrorGlobal(texto) {
        if (typeof VP.ui === 'object' && typeof VP.ui.mostrarNotificacion === 'function') {
            VP.ui.mostrarNotificacion(texto, 'error');
        }
    }

    window.addEventListener('error', function (e) {
        if (VP.metricas.errores >= VP.config.maxErroresLog) return;

        var objetivo = e && (e.target || e.srcElement);
        if (objetivo && String(objetivo.tagName).toUpperCase() === 'VIDEO' &&
            objetivo !== VP.refs?.videoPlayer) {
            return;
        }

        // Silenciar errores de conexión a Ollama (no es un error crítico)
        var msg = _extraerMensajeErrorGlobal(e);
        if (_esRuidoLocalEsperado(msg, e && e.filename)) {
            return;
        }
        if (!_debeRegistrarErrorGlobal('error', msg)) return;

        VP.metricas.errores++;
        VP.metricas.erroresGlobales++;
        try {
            VP.anotarErrorModulo(e && (e.error || e), e && (e.filename || msg), 'error');
            VP.log.error('Error global:', msg);
            _notificarErrorGlobal('Error inesperado. Revisa la consola.');
        } catch (_) {}
    }, true);

    window.addEventListener('unhandledrejection', function (e) {
        if (VP.metricas.errores >= VP.config.maxErroresLog) return;
        
        // Silenciar errores de conexión a Ollama (no es un error crítico)
        var razon = e.reason;
        var razonMsg = _extraerMensajeErrorGlobal(e);
        if (_esRuidoLocalEsperado(razonMsg, '')) {
            if (e.preventDefault) e.preventDefault();
            return;
        }
        if (!_debeRegistrarErrorGlobal('promise', razonMsg)) {
            if (e.preventDefault) e.preventDefault();
            return;
        }

        VP.metricas.errores++;
        VP.metricas.erroresGlobales++;
        try {
            razonMsg = razon
                ? (razon.stack || razon.message || String(razon))
                : 'Promise rechazada sin razón';
            VP.anotarErrorModulo(razon, razonMsg, 'unhandledrejection');
            VP.log.error('Promise no manejada:', razonMsg);
            if (e.preventDefault) e.preventDefault();
            _notificarErrorGlobal('Error en proceso interno');
        } catch (_) {}
    });

    // ============================================================
    // §25  LIMPIEZA AL CERRAR
    // ============================================================

    window.addEventListener('beforeunload', function () {
        try { VP.revocarTodosBlobURLs(); } catch (_) {}

        var intervalos = [
            'sleepTimerInterval', 'watchdogInterval',
            'autoSaveInterval',   'rendimientoInterval',
        ];
        var timeouts = [
            'controlsHideTimer', 'idleTimer', 'notifTimeout',
            'shortcutsTimeout',  'galleryRenderTimer',
            'playlistRenderTimer', 'upNextTimer',
        ];

        try {
            for (var i = 0; i < intervalos.length; i++) {
                if (VP.runtime[intervalos[i]]) {
                    clearInterval(VP.runtime[intervalos[i]]);
                }
            }
            for (var j = 0; j < timeouts.length; j++) {
                if (VP.runtime[timeouts[j]]) {
                    clearTimeout(VP.runtime[timeouts[j]]);
                }
            }
        } catch (_) {}

        try {
            if (VP.db && typeof VP.db.cerrar === 'function') {
                VP.db.cerrar();
            }
        } catch (_) {}
    });

    // ============================================================
    // §26  DIAGNÓSTICO EN CONSOLA
    // ============================================================

    window.__vpDiag = function () {
        return {
            version:           VP.version,
            metricas:          JSON.parse(JSON.stringify(VP.metricas)),
            features:          JSON.parse(JSON.stringify(VP.features)),
            ajustes:           JSON.parse(JSON.stringify(VP.ajustes)),
            snapshotUltra:     JSON.parse(JSON.stringify(VP.cache.snapshotUltraPerf)),
            videos:            VP.estado.videos.length,
            playlist:          VP.estado.playlist.length,
            poolBlobs:         VP.cache.poolBlobURLs.length,
            progreso:          VP.estado.videoProgress.length,
            indiceActual:      VP.estado.currentVideoIndex,
            playGeneration:    VP.runtime.playGeneration,
            idb: {
                listo:    VP.runtime.idb.listo,
                fallido:  VP.runtime.idb.fallido,
                version:  VP.runtime.idb.version,
            },
            lruThumbs:         VP.cache.lruThumbs  ? VP.cache.lruThumbs.stats()  : null,
            lruProgress:       VP.cache.lruProgress ? VP.cache.lruProgress.stats(): null,
            paginacion: {
                pagina: VP.estado.paginaGaleria,
                total:  VP.estado.totalPaginasGaleria,
            },
            modoLento:         VP.runtime.modoLento,
            colaMiniaturas:    VP.runtime.colaMiniaturas.length,
            miniaturasActivas: VP.runtime.miniaturasActivas,
            colaDuracion:      VP.runtime.colaDuracion.length,
            duracionActiva:    VP.runtime.duracionActiva,
            estadoCarga:       JSON.parse(JSON.stringify(VP.runtime.estadoCarga)),
            guards:            JSON.parse(JSON.stringify(VP.runtime.guards)),
            eliminados:        VP.estado.archivosEliminados.slice(),
            inicializado:      VP.runtime.inicializado,
            errores:           VP.metricas.errores,
            eventosActivos:    VP.bus.listarEventos(),
            eventosDetalle:    VP.bus.listarDetalle ? VP.bus.listarDetalle() : {},
            salud:             VP.obtenerSalud ? VP.obtenerSalud() : null,
            logBuffer:         VP.log.volcar().slice(-30),
        };
    };

    window.__vpMemoria = function () {
        var info = {
            blobURLs:        VP.cache.poolBlobURLs.length,
            videosEnMemoria: VP.estado.videos.length,
            playlist:        VP.estado.playlist.length,
            progreso:        VP.estado.videoProgress.length,
            miniaturasEnMem: 0,
            arraysMinis:     0,
            historial:       VP.estado.historialReproduccion.length,
            lruThumbs:       VP.cache.lruThumbs  ? VP.cache.lruThumbs.stats()  : null,
            lruProgress:     VP.cache.lruProgress ? VP.cache.lruProgress.stats(): null,
        };

        var vs = VP.estado.videos;
        for (var i = 0; i < vs.length; i++) {
            if (vs[i] && vs[i].thumbnail)      info.miniaturasEnMem++;
            if (vs[i] && vs[i].thumbnailArray) info.arraysMinis++;
        }

        if (VP.features.performanceMemory) {
            info.heapUsado  = (performance.memory.usedJSHeapSize  / 1048576).toFixed(1) + ' MB';
            info.heapTotal  = (performance.memory.totalJSHeapSize / 1048576).toFixed(1) + ' MB';
            info.heapLimite = (performance.memory.jsHeapSizeLimit / 1048576).toFixed(1) + ' MB';
        }

        return info;
    };

    window.__vpHistorial = function () {
        return VP.estado.historialReproduccion.slice();
    };

    window.__vpLimpiarBlobs = function () {
        VP._limpiarPoolBlobURLs(true);
        return 'Pool limpiado. Restantes: ' + VP.cache.poolBlobURLs.length;
    };

    window.__vpLRUStats = function () {
        return {
            thumbs:   VP.cache.lruThumbs  ? VP.cache.lruThumbs.stats()  : null,
            progress: VP.cache.lruProgress ? VP.cache.lruProgress.stats(): null,
        };
    };

    window.__vpVersion = VP.version;
    VP.registrarModulo('base', {
        version: VP.version,
        critico: true,
        descripcion: 'Núcleo VP, EventBus, configuración y diagnóstico'
    });

    // ============================================================
    // §28  GOBERNADOR DE MEMORIA (VP.memoria)
    //
    //  · Instrumenta Blob URLs, <video>, <audio> y <canvas> para saber
    //    QUIÉN los creó (archivo:línea) y cuánto pesan.
    //  · Auditoría bajo demanda: qué objeto, campo de video o módulo
    //    retiene más heap  →  VP.memoria.auditar() / __vpAuditoriaMemoria()
    //  · Purga escalonada (alto / crítico) con cooldown, backoff e
    //    histéresis para no entrar en bucles de limpieza.
    //  · Registro de purgadores: otros módulos (ComentariosIA,
    //    MemoryMonitor, vp-db...) pueden sumar su propia limpieza con
    //    VP.memoria.registrar(nombre, { limpiar(nivel), tamano() }).
    //  · Hook para el monitor externo: VP.memoria.notificarPresion(mb)
    // ============================================================

    VP.memoria = (function () {

        var MB = 1048576;
        var DEFAULTS = {
            habilitado:                 true,
            intervaloMs:                15000,
            umbralAltoMB:               VP.config.umbralMemoriaModoLento || 400,
            umbralCriticoMB:            650,
            histeresis:                 0.85,    // vuelve a "normal" al bajar del 85 % del umbral
            cooldownAltoMs:             60000,
            cooldownCriticoMs:          20000,
            maxBlobsPool:               120,
            blobGraciaMs:               20000,   // un blob recién creado nunca se revoca
            blobHuerfanoAltoMs:         120000,  // Blob en RAM sin referencias (nivel alto)
            blobHuerfanoCriticoMs:      30000,   // idem (nivel crítico)
            mediaHuerfanaNormalMs:      300000,  // <video>/<audio> fuera del DOM sin usar
            mediaHuerfanaAltoMs:        90000,
            mediaHuerfanaCriticoMs:     45000,
            canvasHuerfanoMs:           120000,
            canvasMinPixeles:           200000,  // solo canvas grandes (las miniaturas 240x135 no se tocan)
            liberarCanvas:              true,
            liberarMediaHuerfana:       true,
            keyValStubMaxMB:            24,
            crecimientoSospechosoMBmin: 25,
            auditoriaAutoMs:            300000,
            logMaxChars:                2000
        };
        var cfg = VP.config.memoria = VP.config.memoria || {};
        for (var kd in DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(DEFAULTS, kd) && cfg[kd] === undefined) cfg[kd] = DEFAULTS[kd];
        }

        var _blobs      = new Map();   // url → { ts, size, esFile, tipo, origen }
        var _media      = [];          // [{ ref: WeakRef, ts, tag, origen }]
        var _purgables  = Object.create(null);
        var _muestras   = [];
        var _nivel      = 'normal';
        var _ultPurga   = { alto: 0, critico: 0 };
        var _backoff    = { alto: 1, critico: 1 };
        var _ultInfo    = null;
        var _tasa       = 0;
        var _ultAuditoriaAuto = 0;
        var _timer      = null;

        function _r(n, d) { var f = Math.pow(10, d === undefined ? 1 : d); return Math.round(n * f) / f; }

        function _mb() {
            try {
                if (window.performance && window.performance.memory) {
                    return window.performance.memory.usedJSHeapSize / MB;
                }
            } catch (_) {}
            return 0;
        }

        function _origen() {
            try {
                var lineas = String(new Error().stack || '').split('\n');
                for (var i = 1; i < lineas.length; i++) {
                    if (lineas[i].indexOf('vp-base.js') !== -1) continue;
                    var m = lineas[i].match(/([\w.\-]+\.js):(\d+)/);
                    if (m) return m[1] + ':' + m[2];
                }
            } catch (_) {}
            return 'desconocido';
        }

        // ── Instrumentación (una sola vez) ───────────────────────
        function _instalar() {
            try {
                if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && !URL.__vpMem) {
                    var crear   = URL.createObjectURL;
                    var revocar = URL.revokeObjectURL;
                    URL.createObjectURL = function (obj) {
                        var url = crear.apply(URL, arguments);
                        try {
                            _blobs.set(url, {
                                ts:     Date.now(),
                                size:   (obj && obj.size) || 0,
                                esFile: typeof File !== 'undefined' && obj instanceof File,
                                tipo:   (typeof MediaSource !== 'undefined' && obj instanceof MediaSource)
                                            ? 'MediaSource' : ((obj && obj.type) || ''),
                                origen: _origen()
                            });
                        } catch (_) {}
                        return url;
                    };
                    URL.revokeObjectURL = function (url) {
                        try { _blobs.delete(url); } catch (_) {}
                        return revocar.apply(URL, arguments);
                    };
                    URL.__vpMem = true;
                }
            } catch (_) {}

            try {
                if (typeof WeakRef !== 'undefined' && !document.__vpMem) {
                    var ce = document.createElement;
                    document.createElement = function (tag) {
                        var el = ce.apply(document, arguments);
                        try {
                            var t = String(tag).toLowerCase();
                            if (t === 'video' || t === 'audio' || t === 'canvas') {
                                _media.push({ ref: new WeakRef(el), ts: Date.now(), tag: t, origen: _origen() });
                                if (_media.length > 1500) _compactarMedia();
                            }
                        } catch (_) {}
                        return el;
                    };
                    document.__vpMem = true;
                }
            } catch (_) {}
        }

        function _compactarMedia() {
            var vivos = [];
            for (var i = 0; i < _media.length; i++) {
                if (_media[i].ref.deref()) vivos.push(_media[i]);
            }
            _media = vivos;
        }

        // ── URLs que NO se pueden revocar ────────────────────────
        function _urlsProtegidas() {
            var set = new Set();
            var i, j, k;
            function add(u) { if (typeof u === 'string' && u.lastIndexOf('blob:', 0) === 0) set.add(u); }

            try { add(VP.runtime.urlActual); } catch (_) {}

            try {
                var els = document.querySelectorAll(
                    'video,audio,img,source,track,iframe,embed,object,a[href^="blob:"],link[href^="blob:"],[style*="blob:"]'
                );
                for (i = 0; i < els.length; i++) {
                    var e = els[i];
                    add(e.currentSrc); add(e.src); add(e.data); add(e.poster);
                    if (e.getAttribute) {
                        add(e.getAttribute('src')); add(e.getAttribute('href'));
                        var st = e.getAttribute('style');
                        if (st && st.indexOf('blob:') !== -1) {
                            var mm = st.match(/blob:[^'")\s]+/g);
                            if (mm) for (j = 0; j < mm.length; j++) add(mm[j]);
                        }
                    }
                }
            } catch (_) {}

            try {
                if (VP.cache.lruThumbs) VP.cache.lruThumbs.forEach(function (v) { add(v); });
            } catch (_) {}

            try {
                var vs = VP.estado.videos || [];
                for (i = 0; i < vs.length; i++) {
                    var v = vs[i];
                    if (!v || typeof v !== 'object') continue;
                    var ks = Object.keys(v);
                    for (k = 0; k < ks.length; k++) {
                        var val = v[ks[k]];
                        if (typeof val === 'string') add(val);
                        else if (Array.isArray(val) && val.length < 64) {
                            for (j = 0; j < val.length; j++) add(val[j]);
                        }
                    }
                }
            } catch (_) {}
            return set;
        }

        // ── PURGAS ───────────────────────────────────────────────

        function _purgarBlobs(nivel) {
            var prot  = _urlsProtegidas();
            var ahora = Date.now();
            var ttl   = nivel === 'critico' ? cfg.blobHuerfanoCriticoMs : cfg.blobHuerfanoAltoMs;
            var lista = [];
            var bytes = 0;

            _blobs.forEach(function (m, url) {
                if (prot.has(url))             return;
                if (m.tipo === 'MediaSource')  return;
                if (ahora - m.ts < ttl)        return;
                if (m.esFile)                  return;   // respaldado en disco: no ocupa RAM
                lista.push(url);
                bytes += m.size;
            });
            for (var i = 0; i < lista.length; i++) VP.revocarBlobURL(lista[i]);

            // Pool de VP: limpieza segura (respeta protegidas)
            var antesPool = VP.cache.poolBlobURLs.length;
            if (antesPool > cfg.maxBlobsPool) VP._limpiarPoolBlobURLs();

            return {
                revocadosEnRAM: lista.length,
                liberadoMB:     _r(bytes / MB),
                poolAntes:      antesPool,
                poolDespues:    VP.cache.poolBlobURLs.length
            };
        }

        function _purgarMedia(nivel) {
            if (!cfg.liberarMediaHuerfana) return 'desactivado';
            var ahora = Date.now();
            var edad  = nivel === 'critico' ? cfg.mediaHuerfanaCriticoMs
                      : nivel === 'alto'    ? cfg.mediaHuerfanaAltoMs
                      :                       cfg.mediaHuerfanaNormalMs;
            var media = 0, canvas = 0, vivos = [];

            for (var i = 0; i < _media.length; i++) {
                var rec = _media[i];
                var el  = rec.ref.deref();
                if (!el) continue;
                vivos.push(rec);
                if (el.isConnected) continue;                 // en pantalla → intocable
                var antig = ahora - rec.ts;

                if (rec.tag !== 'canvas') {
                    if (antig < edad) continue;
                    if (el === VP.runtime.videoEl) continue;
                    try {
                        if (!el.paused || el.seeking) continue;
                        if (el.getAttribute('src') || el.currentSrc || el.srcObject) {
                            el.pause();
                            el.removeAttribute('src');
                            el.srcObject = null;
                            el.load();
                            media++;
                        }
                    } catch (_) {}
                } else if (cfg.liberarCanvas && nivel !== 'normal' && antig >= cfg.canvasHuerfanoMs) {
                    try {
                        if (el.width * el.height >= cfg.canvasMinPixeles) {
                            el.width = 0; el.height = 0;
                            canvas++;
                        }
                    } catch (_) {}
                }
            }
            _media = vivos;
            return { mediaLiberados: media, canvasLiberados: canvas };
        }

        function _purgarMiniaturas(nivel) {
            var vs   = VP.estado.videos || [];
            var r    = VP.indicesPaginaActual ? VP.indicesPaginaActual() : { inicio: 0, fin: -1 };
            var cur  = VP.estado.currentVideoIndex;
            var arr  = 0, thumbs = 0;

            for (var i = 0; i < vs.length; i++) {
                var v = vs[i];
                if (!v) continue;
                if (i >= r.inicio && i <= r.fin) continue;   // página visible
                if (i === cur) continue;                      // video en reproducción
                if (v.thumbnailArray) { v.thumbnailArray = null; arr++; }
                if (nivel === 'critico') {
                    if (v.thumbnail) {
                        if (typeof v.thumbnail === 'string') VP.revocarSeguro(v.thumbnail);
                        v.thumbnail = null; thumbs++;
                    }
                    if (v._tagsIA) v._tagsIA = null;
                }
            }

            var lru = VP.cache.lruThumbs, antes = 0, despues = 0;
            if (lru && typeof lru.recortar === 'function') {
                antes = lru.size;
                lru.recortar(Math.floor(lru._cap * (nivel === 'critico' ? 0.25 : 0.6)));
                despues = lru.size;
            }
            return { arraysLiberados: arr, miniaturasLiberadas: thumbs, lruAntes: antes, lruDespues: despues };
        }

        function _purgarKeyVal(nivel) {
            if (VP.db && typeof VP.db._kvPurgar === 'function') return VP.db._kvPurgar(nivel);
            return 'n/a (VP.db real: registrar su caché con VP.memoria.registrar)';
        }

        function _purgarLogs(nivel) {
            var antes = _bufferLog.length;
            if (nivel === 'critico') {
                _bufferLog = [];
                _logMap = Object.create(null);
                _groupedWarnMap = Object.create(null);
                _logLastKey = null;
            } else if (_bufferLog.length > 100) {
                _bufferLog.splice(0, _bufferLog.length - 100);
            }
            return { logAntes: antes, logDespues: _bufferLog.length };
        }

        function _recortarEstado(nivel) {
            var out = {};
            var h = VP.estado.historialReproduccion;
            var maxH = VP.config.maxHistorial || 100;
            if (h && h.length > maxH) { h.splice(0, h.length - maxH); out.historial = maxH; }
            var el = VP.estado.archivosEliminados;
            if (el && el.length > 1000) { el.splice(0, el.length - 1000); out.eliminados = 1000; }
            return out;
        }

        function purgar(nivel, motivo) {
            nivel = nivel === 'critico' ? 'critico' : 'alto';
            var t0    = Date.now();
            var antes = _mb();
            var res   = { nivel: nivel, motivo: motivo || 'manual', antesMB: _r(antes), acciones: {} };

            var pasos = [
                ['blobs',      _purgarBlobs],
                ['media',      _purgarMedia],
                ['miniaturas', _purgarMiniaturas],
                ['keyval',     _purgarKeyVal],
                ['logs',       _purgarLogs],
                ['estado',     _recortarEstado]
            ];
            for (var i = 0; i < pasos.length; i++) {
                try { res.acciones[pasos[i][0]] = pasos[i][1](nivel); }
                catch (e) { res.acciones[pasos[i][0]] = 'error: ' + (e && e.message || e); }
            }

            var nombres = Object.keys(_purgables).sort(function (a, b) {
                return _purgables[a].prioridad - _purgables[b].prioridad;
            });
            for (var j = 0; j < nombres.length; j++) {
                try {
                    var rr = _purgables[nombres[j]].limpiar(nivel);
                    res.acciones['ext:' + nombres[j]] = rr === undefined ? 'ok' : rr;
                } catch (e2) {
                    res.acciones['ext:' + nombres[j]] = 'error: ' + (e2 && e2.message || e2);
                }
            }

            res.ms = Date.now() - t0;
            _ultPurga[nivel] = Date.now();
            _ultInfo = res;
            try { if (typeof window.gc === 'function') window.gc(); } catch (_) {}

            VP.log.withContext('Memoria', function () {
                VP.log.warn('Purga ' + nivel + ' (' + res.motivo + ') | antes: ' + _r(antes) + 'MB | ' +
                    JSON.stringify(res.acciones));
            });
            try { VP.bus.emit('memoriaPurgada', res); } catch (_) {}

            // Medir efectividad cuando el GC haya tenido oportunidad
            setTimeout(function () {
                var d = _mb();
                res.despuesMB = _r(d);
                if (antes > 0 && (antes - d) < antes * 0.05) {
                    _backoff[nivel] = Math.min(_backoff[nivel] * 2, 10);   // poco efecto → espaciar
                } else {
                    _backoff[nivel] = 1;
                }
                VP.log.withContext('Memoria', function () {
                    VP.log.info('Post-purga ' + nivel + ': ' + _r(antes) + ' → ' + _r(d) + 'MB | backoff x' + _backoff[nivel]);
                });
            }, 8000);

            return res;
        }

        // ── GOBERNADOR ───────────────────────────────────────────

        function _nivelPara(mb) {
            var h = cfg.histeresis;
            if (mb >= cfg.umbralCriticoMB) return 'critico';
            if (_nivel === 'critico' && mb >= cfg.umbralCriticoMB * h) return 'critico';
            if (mb >= cfg.umbralAltoMB) return 'alto';
            if (_nivel !== 'normal' && mb >= cfg.umbralAltoMB * h) return 'alto';
            return 'normal';
        }

        function _vigilarCrecimiento(ahora) {
            if (_muestras.length < 6) return;
            var a = _muestras[0], b = _muestras[_muestras.length - 1];
            var min = (b.t - a.t) / 60000;
            if (min < 1) return;
            _tasa = (b.mb - a.mb) / min;
            if (_tasa >= cfg.crecimientoSospechosoMBmin && (ahora - _ultAuditoriaAuto) > cfg.auditoriaAutoMs) {
                _ultAuditoriaAuto = ahora;
                var idle = window.requestIdleCallback || function (f) { return setTimeout(f, 300); };
                var tasa = _tasa;
                idle(function () {
                    try {
                        var rep = auditar({ silencioso: true });
                        VP.log.withContext('Memoria', function () {
                            VP.log.warn('Crecimiento sospechoso +' + _r(tasa) + ' MB/min | principales: ' + rep.resumen);
                        });
                    } catch (_) {}
                });
            }
        }

        function _procesar(mb) {
            if (!cfg.habilitado || !mb) return _nivel;
            var ahora = Date.now();
            _muestras.push({ t: ahora, mb: mb });
            if (_muestras.length > 16) _muestras.shift();

            var nuevo = _nivelPara(mb);
            if (nuevo !== _nivel) {
                var previo = _nivel;
                _nivel = nuevo;
                VP.log.withContext('Memoria', function () {
                    VP.log.info('Nivel ' + previo + ' → ' + nuevo + ' (' + _r(mb) + 'MB)');
                });
                try { VP.bus.emit('memoriaNivel', nuevo, previo, mb); } catch (_) {}
            }
            _vigilarCrecimiento(ahora);

            if (_nivel === 'normal') {
                try {
                    if (VP.cache.poolBlobURLs.length > cfg.maxBlobsPool) VP._limpiarPoolBlobURLs();
                    _purgarMedia('normal');
                } catch (_) {}
                return _nivel;
            }
            var base = _nivel === 'critico' ? cfg.cooldownCriticoMs : cfg.cooldownAltoMs;
            if (ahora - _ultPurga[_nivel] >= base * _backoff[_nivel]) purgar(_nivel, 'auto');
            return _nivel;
        }

        function iniciar() {
            if (_timer || !cfg.habilitado) return;
            _timer = setInterval(function () { _procesar(_mb()); }, cfg.intervaloMs);
        }
        function detener() {
            if (_timer) { clearInterval(_timer); _timer = null; }
        }

        // ── AUDITORÍA ────────────────────────────────────────────

        /** Estima bytes de heap alcanzables desde `raiz` (aprox., acotado en nodos y profundidad). */
        function _peso(raiz, vistos, limiteNodos, profMax) {
            var bytes = 0, nodos = 0, ext = 0, trunc = false;
            var pila = [raiz, 0];

            function meter(x, d) {
                var t = typeof x;
                if (t === 'string')      bytes += x.length * 2 + 16;
                else if (t === 'number' || t === 'boolean') bytes += 8;
                else if (t === 'object' && x !== null) { pila.push(x); pila.push(d); }
            }

            while (pila.length) {
                var d = pila.pop();
                var v = pila.pop();
                if (nodos++ > limiteNodos) { trunc = true; break; }
                if (v === null || v === undefined) continue;
                var t = typeof v;
                if (t === 'string')  { bytes += v.length * 2 + 16; continue; }
                if (t === 'number' || t === 'boolean') { bytes += 8; continue; }
                if (t !== 'object') continue;
                if (vistos.has(v)) continue;
                vistos.add(v);
                if (v === window || v === document) continue;
                if (typeof Node !== 'undefined' && v instanceof Node) continue;
                if (typeof Blob !== 'undefined' && v instanceof Blob) { ext += v.size || 0; continue; }
                if (v instanceof ArrayBuffer) { bytes += v.byteLength; continue; }
                if (ArrayBuffer.isView(v))    { bytes += v.byteLength; continue; }
                if (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) { bytes += v.width * v.height * 4; continue; }
                bytes += 32;
                if (d >= profMax) continue;

                if (v instanceof Map) {
                    v.forEach(function (val, key) { meter(key, d + 1); meter(val, d + 1); });
                    bytes += v.size * 16;
                    continue;
                }
                if (v instanceof Set) {
                    v.forEach(function (val) { meter(val, d + 1); });
                    bytes += v.size * 8;
                    continue;
                }
                if (Array.isArray(v)) {
                    bytes += v.length * 8;
                    for (var i = 0; i < v.length; i++) meter(v[i], d + 1);
                    continue;
                }
                var ks;
                try { ks = Object.keys(v); } catch (_) { continue; }
                bytes += ks.length * 16;
                for (var j = 0; j < ks.length; j++) {
                    var x;
                    try { x = v[ks[j]]; } catch (_) { continue; }
                    meter(x, d + 1);
                }
            }
            return { bytes: bytes, ext: ext, trunc: trunc, nodos: nodos };
        }

        function _filasDe(obj, nombre, drill) {
            var vistos = new WeakSet();
            var filas = [], ks;
            try { ks = Object.keys(obj); } catch (_) { return filas; }
            for (var i = 0; i < ks.length; i++) {
                var val;
                try { val = obj[ks[i]]; } catch (_) { continue; }
                if (typeof val === 'function') continue;
                var p = _peso(val, vistos, 150000, 6);
                filas.push({ ruta: nombre + '.' + ks[i], mb: p.bytes / MB, extMB: p.ext / MB, trunc: p.trunc, _val: val });
            }
            filas.sort(function (a, b) { return b.mb - a.mb; });
            var out = [];
            for (var k = 0; k < filas.length; k++) {
                var f = filas[k];
                var val2 = f._val; delete f._val;
                out.push(f);
                if (drill > 0 && k < 3 && f.mb > 2 && val2 && typeof val2 === 'object' &&
                    !Array.isArray(val2) && !(val2 instanceof Map) && !(val2 instanceof Set)) {
                    var hijos = _filasDe(val2, f.ruta, drill - 1);
                    if (hijos.length) f.tieneHijos = true;
                    for (var h = 0; h < hijos.length && h < 5; h++) { hijos[h].hijo = true; out.push(hijos[h]); }
                }
            }
            return out;
        }

        function _camposDeVideos() {
            var vs = VP.estado.videos || [];
            var porCampo = Object.create(null);
            var porVideo = [];
            for (var i = 0; i < vs.length; i++) {
                var v = vs[i];
                if (!v || typeof v !== 'object') continue;
                var vistos = new WeakSet();
                var total = 0;
                var ks = Object.keys(v);
                for (var k = 0; k < ks.length; k++) {
                    var x;
                    try { x = v[ks[k]]; } catch (_) { continue; }
                    if (x === null || x === undefined || typeof x === 'function') continue;
                    var p = _peso(x, vistos, 20000, 5);
                    var c = porCampo[ks[k]] || (porCampo[ks[k]] = { campo: ks[k], bytes: 0, conValor: 0, extBytes: 0 });
                    c.bytes += p.bytes; c.extBytes += p.ext; c.conValor++;
                    total += p.bytes;
                }
                porVideo.push({ i: i, nombre: String(v.name || v.nombre || v.id || i).slice(0, 60), mb: total / MB });
            }
            var campos = Object.keys(porCampo).map(function (k) {
                return { campo: 'videos[*].' + k, mb: _r(porCampo[k].bytes / MB, 2), conValor: porCampo[k].conValor,
                         archivoMB: _r(porCampo[k].extBytes / MB, 1) };
            }).sort(function (a, b) { return b.mb - a.mb; });
            porVideo.sort(function (a, b) { return b.mb - a.mb; });
            return { campos: campos.slice(0, 12), videosMasPesados: porVideo.slice(0, 5).map(function (x) {
                return { i: x.i, nombre: x.nombre, mb: _r(x.mb, 2) };
            }) };
        }

        function _auditarBlobs() {
            var prot = _urlsProtegidas();
            var ahora = Date.now();
            var filas = [], ram = 0, disco = 0;
            _blobs.forEach(function (m, url) {
                if (m.esFile) disco += m.size; else ram += m.size;
                filas.push({ url: url.slice(-12), mb: _r(m.size / MB, 2), tipo: m.tipo || '-', enRAM: !m.esFile,
                             edadS: Math.round((ahora - m.ts) / 1000), origen: m.origen, protegido: prot.has(url) });
            });
            filas.sort(function (a, b) { return b.mb - a.mb; });
            return { total: _blobs.size, ramMB: _r(ram / MB), discoMB: _r(disco / MB),
                     poolVP: VP.cache.poolBlobURLs.length, top: filas.slice(0, 10) };
        }

        function _auditarMedia() {
            var out = { video: 0, audio: 0, canvas: 0, huerfanosConSrc: 0, canvasHuerfanoMB: 0, porOrigen: {} };
            for (var i = 0; i < _media.length; i++) {
                var el = _media[i].ref.deref();
                if (!el) continue;
                out[_media[i].tag]++;
                if (el.isConnected) continue;
                var key = _media[i].tag + '@' + _media[i].origen;
                out.porOrigen[key] = (out.porOrigen[key] || 0) + 1;
                try {
                    if (_media[i].tag === 'canvas') out.canvasHuerfanoMB += (el.width * el.height * 4) / MB;
                    else if (el.getAttribute('src') || el.currentSrc || el.srcObject) out.huerfanosConSrc++;
                } catch (_) {}
            }
            out.canvasHuerfanoMB = _r(out.canvasHuerfanoMB);
            return out;
        }

        function auditar(opts) {
            opts = opts || {};
            var t0 = Date.now();
            var rep = { heapMB: _r(_mb()), nivel: _nivel, tasaMBmin: _r(_tasa) };
            try {
                var pm = window.performance.memory;
                rep.totalMB = _r(pm.totalJSHeapSize / MB); rep.limiteMB = _r(pm.jsHeapSizeLimit / MB);
            } catch (_) {}

            rep.blobs  = _auditarBlobs();
            rep.media  = _auditarMedia();
            try { rep.dom = { nodos: document.getElementsByTagName('*').length,
                              video: document.getElementsByTagName('video').length,
                              img:   document.getElementsByTagName('img').length }; } catch (_) {}

            try {
                var det = VP.bus.listarDetalle(), tot = 0;
                var evs = Object.keys(det).map(function (k) { tot += det[k]; return { evento: k, oyentes: det[k] }; })
                    .sort(function (a, b) { return b.oyentes - a.oyentes; });
                rep.bus = { oyentes: tot, top: evs.slice(0, 5) };
            } catch (_) {}

            try { rep.keyVal = VP.db && VP.db._kvStats ? VP.db._kvStats() : null; } catch (_) {}
            try { rep.lru = { thumbs: VP.cache.lruThumbs.stats(), progress: VP.cache.lruProgress.stats() }; } catch (_) {}

            rep.videos = _camposDeVideos();
            rep.vp     = _filasDe(VP, 'VP', 2).slice(0, 18).map(function (f) {
                return { ruta: f.ruta, mb: _r(f.mb, 2), archivoMB: _r(f.extMB, 1), truncado: f.trunc, tieneHijos: !!f.tieneHijos };
            });

            // Globales de window (cachés de otros módulos)
            var glob = [], vistosW = new WeakSet();
            try {
                var wk = Object.keys(window);
                for (var i = 0; i < wk.length; i++) {
                    var k = wk[i];
                    if (k === 'VP' || k === 'window' || k === 'self' || k === 'document') continue;
                    var d;
                    try { d = Object.getOwnPropertyDescriptor(window, k); } catch (_) { continue; }
                    if (!d || !('value' in d) || d.value === null || typeof d.value !== 'object') continue;
                    var p = _peso(d.value, vistosW, 150000, 6);
                    if (p.bytes > 512 * 1024) glob.push({ ruta: 'window.' + k, mb: _r(p.bytes / MB, 2), truncado: p.trunc });
                }
            } catch (_) {}
            glob.sort(function (a, b) { return b.mb - a.mb; });
            rep.globales = glob.slice(0, 10);

            // Purgadores externos (auto-reportan tamaño)
            rep.registrados = Object.keys(_purgables).map(function (n) {
                var t = null;
                try { if (_purgables[n].tamano) t = _purgables[n].tamano(); } catch (_) {}
                return { nombre: n, tamanoMB: t };
            });

            // Ranking unificado
            var c = [];
            if (rep.blobs.ramMB > 0.5) c.push({ f: 'Blobs en RAM (' + rep.blobs.total + ' vivos)', mb: rep.blobs.ramMB });
            if (rep.media.canvasHuerfanoMB > 0.5) c.push({ f: 'canvas huérfanos', mb: rep.media.canvasHuerfanoMB });
            rep.videos.campos.forEach(function (x) { c.push({ f: x.campo, mb: x.mb }); });
            // Solo hojas del desglose y sin contar VP.estado.videos (ya desglosado por campo arriba)
            rep.vp.forEach(function (x) {
                if (x.tieneHijos || x.ruta === 'VP.estado.videos') return;
                c.push({ f: x.ruta, mb: x.mb });
            });
            rep.globales.forEach(function (x) { c.push({ f: x.ruta, mb: x.mb }); });
            c.sort(function (a, b) { return b.mb - a.mb; });
            rep.resumen = c.slice(0, 6).map(function (x) { return x.f + ' ≈ ' + _r(x.mb) + 'MB'; }).join(' | ') || 'sin culpables claros en JS heap';
            rep.duracionMs = Date.now() - t0;

            if (!opts.silencioso) {
                try { console.log('[VP] Auditoría de memoria\n' + JSON.stringify(rep, null, 2)); } catch (_) {}
            }
            return rep;
        }

        // ── API PÚBLICA ──────────────────────────────────────────
        _instalar();

        var api = {
            config:   cfg,
            iniciar:  iniciar,
            detener:  detener,
            purgar:   purgar,
            auditar:  auditar,
            evaluar:  function (mb) { return _procesar(typeof mb === 'number' && mb > 0 ? mb : _mb()); },
            notificarPresion: function (mb) {
                // Para MemoryMonitor externo: fuerza evaluación inmediata respetando cooldown.
                return _procesar(typeof mb === 'number' && mb > 0 ? mb : _mb());
            },
            registrar: function (nombre, def) {
                if (!nombre || !def || typeof def.limpiar !== 'function') return false;
                _purgables[String(nombre)] = {
                    limpiar:   def.limpiar,
                    tamano:    typeof def.tamano === 'function' ? def.tamano : null,
                    prioridad: Number(def.prioridad) || 50
                };
                return true;
            },
            desregistrar: function (nombre) { delete _purgables[String(nombre)]; },
            estado: function () {
                return { nivel: _nivel, heapMB: _r(_mb()), tasaMBmin: _r(_tasa), ultimaPurga: _ultInfo,
                         backoff: { alto: _backoff.alto, critico: _backoff.critico },
                         blobsRastreados: _blobs.size, mediaRastreada: _media.length,
                         purgadores: Object.keys(_purgables) };
            },
            _urlsProtegidas: _urlsProtegidas,
            _blobEdadMs: function (url) {
                var m = _blobs.get(url);
                return m ? (Date.now() - m.ts) : Infinity;   // sin dato → se considera antiguo
            }
        };
        return api;
    })();

    // Reemplaza la limpieza ciega del pool: ahora respeta lo que sigue en uso.
    VP._urlsProtegidas = VP.memoria._urlsProtegidas;
    VP._blobEdadMs     = VP.memoria._blobEdadMs;

    VP.memoria.iniciar();
    window.addEventListener('pagehide', function () { try { VP.memoria.detener(); } catch (_) {} });

    window.__vpAuditoriaMemoria = function () { return VP.memoria.auditar(); };
    window.__vpPurgarMemoria    = function (nivel) { return VP.memoria.purgar(nivel || 'alto', 'manual'); };
    window.__vpEstadoMemoria    = function () { return VP.memoria.estado(); };

    VP.registrarModulo('memoria', { version: '1.0.0', descripcion: 'Gobernador de memoria: auditoría + purga escalonada' });

    // ============================================================
    // §27  LOG DE ARRANQUE
    // ============================================================

    VP.log.info(
        'vp-base.js cargado · v' + VP.version +
        ' · Touch: '   + VP.features.touch +
        ' · IDB: '     + VP.features.indexedDB +
        ' · FS API: '  + VP.features.fileSystemAccess +
        ' · LRU: '     + VP.config.maxEntradasCache +
        ' · MaxVid: '  + VP.config.maxVideos
    );

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-base.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
