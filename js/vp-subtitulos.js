'use strict';

// ============================================================
// VP-SUBTITULOS.JS  —  v2.1.0
// Manejo completo de subtítulos: lectura, conversión,
// parseo de cues, caché en IDB y adjunción al reproductor.
//
// Optimizado para +500 videos simultáneos:
//   · Cola de procesamiento con concurrencia limitada
//   · Caché en memoria (LRU + TTL + presupuesto de bytes)
//   · Deduplicación de trabajos en vuelo
//   · Cancelación granular por video (AbortToken)
//   · Reintentos con back-off exponencial + jitter
//   · Métricas internas de rendimiento
//   · Limpieza proactiva de URLs de Blob
//   · Procesamiento diferido / idle para videos fuera del viewport
//
// Novedades v2.1.0 (todas retrocompatibles — nada se rompe):
//   · Fallbacks defensivos para dependencias opcionales
//     (util.srtAVtt / util.assAVtt / util.parsearCuesVtt / util.throttle)
//   · Detección de codificación: BOM UTF-8/UTF-16 + reintento latin-1
//     cuando el texto llega con caracteres de reemplazo (U+FFFD)
//   · Normalización y saneado de cues (orden, solapes, NaN, tags)
//   · Caché con TTL, presupuesto de memoria y purga manual
//   · Envejecimiento de prioridad en la cola (anti-inanición)
//   · Pausa automática de la cola con la pestaña oculta (opcional)
//   · Validación/normalización de configuración + VP.subtitulos.configurar()
//   · Nuevas utilidades públicas: ajustarDesfase, obtenerCues,
//     obtenerCuesEnRango, obtenerIndiceCueActivo, precargar,
//     estadisticasCache, purgarCache, reiniciarMetricas, destruir
//   · Registro de listeners del bus con capacidad de desuscripción
//   · Protección contra fugas: revocación de Blob-URLs en unload
//
// Soporta: SRT, VTT, ASS/SSA, SUB (MicroDVD), LRC (best-effort)
// Dependencias: vp-base.js · vp-utilidades.js · vp-dom.js · vp-db.js
// ============================================================

(function (window, document, performance) {

    // ============================================================
    // 0. VERIFICACIÓN DE DEPENDENCIAS
    // ============================================================

    var VP = window.VP;

    if (!VP) {
        throw new Error(
            '[VP] vp-subtitulos.js: vp-base.js debe cargarse primero.'
        );
    }

    // Verificar dependencias críticas con mensajes descriptivos
    var _dependencias = {
        util : VP.util,
        dom  : VP.dom,
        log  : VP.log,
        bus  : VP.bus,
        db   : VP.db,
    };

    Object.keys(_dependencias).forEach(function (nombre) {
        if (!_dependencias[nombre]) {
            throw new Error(
                '[VP] vp-subtitulos.js: dependencia faltante → VP.' + nombre
            );
        }
    });

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    if (log && typeof log.setContext === 'function') {
        log.setContext('Subtitulos');
    }
    var bus  = VP.bus;

    // ---- Estructuras base que podrían no existir todavía ----
    VP.config   = VP.config   || {};
    VP.estado   = VP.estado   || {};
    VP.refs     = VP.refs     || {};
    VP.features = VP.features || {};
    VP.runtime  = VP.runtime  || {};

    // Detección perezosa de features si vp-base no las declaró
    if (typeof VP.features.fileReader === 'undefined') {
        VP.features.fileReader = (typeof window.FileReader === 'function');
    }
    if (typeof VP.features.blob === 'undefined') {
        VP.features.blob = (typeof window.Blob === 'function');
    }
    if (typeof VP.features.blobURL === 'undefined') {
        VP.features.blobURL = !!(window.URL &&
            typeof window.URL.createObjectURL === 'function');
    }

    // Log seguro: si al logger le falta algún nivel, se rellena con no-ops
    ['debug', 'info', 'warn', 'error'].forEach(function (nivel) {
        if (typeof log[nivel] !== 'function') {
            log[nivel] = function () {};
        }
    });

    var VERSION = '2.1.0';

    // ============================================================
    // 1. NAMESPACE Y ESTADO INTERNO
    // ============================================================

    VP.subtitulos = VP.subtitulos || {};

    /**
     * Estado interno del módulo.
     * Toda la mutabilidad del módulo vive aquí para facilitar
     * inspección, depuración y limpieza ordenada.
     */
    var _estado = {

        // ---- Cola de procesamiento ----
        cola          : [],          // Array<TrabajoCola>
        colaEnEjecucion: 0,          // trabajos activos ahora mismo
        colaPausada   : false,       // true durante flush / shutdown
        colaSecuencia : 0,           // contador monótono (orden estable)

        // ---- Trabajos en vuelo (deduplicación) ----
        // clave: vObj.id → Promise<string|null>
        enVuelo       : Object.create(null),

        // ---- Caché LRU en memoria ----
        // clave: vObj.id → { vtt, cues, ts, hits, bytes }
        cacheMemoria  : Object.create(null),
        cacheLRUOrder : [],          // ids en orden de uso (más viejo al frente)
        cacheBytes    : 0,           // bytes aproximados en memoria

        // ---- Mapa de Blob-URLs activos (para revocar) ----
        // clave: vObj.id → url string
        blobUrls      : Object.create(null),

        // ---- AbortTokens por video ----
        // clave: vObj.id → AbortToken
        abortTokens   : Object.create(null),

        // ---- Temporizadores pendientes (reintentos, diferidos) ----
        timers        : [],

        // ---- Desuscriptores del bus / listeners DOM ----
        desuscriptores: [],

        // ---- Desfase manual por video (segundos) ----
        desfases      : Object.create(null),

        // ---- Métricas ----
        metricas      : {
            procesados  : 0,
            errores     : 0,
            cacheHits   : 0,
            cacheMisses : 0,
            tiempoTotal : 0,   // ms acumulados de procesamiento
            colaMax     : 0,   // pico de cola
            reintentos  : 0,
            cancelados  : 0,
            timeouts    : 0,
            evicciones  : 0,
            bytesLeidos : 0,
            idbHits     : 0,
            idbEscrituras: 0,
        },

        // ---- Registro de pistas activas ----
        // clave: vObj.id → elemento <track>
        pistasActivas : Object.create(null),

        destruido     : false,
    };

    // ============================================================
    // 2. CONSTANTES Y CONFIGURACIÓN
    // ============================================================

    /**
     * Lee un número de VP.config con validación de rango.
     * Si el valor es inválido se usa el valor por defecto (igual que antes).
     */
    function _num(valor, porDefecto, min, max) {
        var n = Number(valor);
        if (!isFinite(n) || n <= 0) return porDefecto;
        if (typeof min === 'number' && n < min) return min;
        if (typeof max === 'number' && n > max) return max;
        return n;
    }

    var CFG = {
        // Concurrencia máxima de FileReaders simultáneos
        MAX_CONCURRENTES    : _num(VP.config.subMaxConcurrentes, 4, 1, 64),

        // Tamaño máximo del caché LRU en memoria (entradas)
        CACHE_LRU_MAX       : _num(VP.config.subCacheLruMax, 150, 1, 100000),

        // Presupuesto de memoria del caché (bytes aprox. de texto VTT): 48 MB
        CACHE_MAX_BYTES     : _num(VP.config.subCacheMaxBytes, 50331648, 65536),

        // Tiempo de vida de una entrada de caché (ms). 0 = sin caducidad
        CACHE_TTL_MS        : Math.max(0, Number(VP.config.subCacheTtlMs) || 0),

        // Timeout por lectura de archivo (ms)
        TIMEOUT_LECTURA_MS  : _num(VP.config.timeoutSubtitulo, 15000, 1000),

        // Reintentos máximos ante error de lectura
        MAX_REINTENTOS      : (function () {
            var n = Number(VP.config.subMaxReintentos);
            return (isFinite(n) && n >= 0) ? Math.min(n, 10) : 2;
        })(),

        // Back-off base entre reintentos (ms)
        BACKOFF_BASE_MS     : _num(VP.config.subBackoffBase, 500, 10),

        // Back-off máximo (ms)
        BACKOFF_MAX_MS      : _num(VP.config.subBackoffMax, 10000, 100),

        // Tamaño máximo de subtítulo aceptado (bytes): 20 MB
        MAX_BYTES           : _num(VP.config.subMaxBytes, 20971520, 1024),

        // Límite de caracteres para parsearCues (protección de CPU): 5 MB
        MAX_CHARS_PARSEO    : _num(VP.config.subMaxCharsParseo, 5 * 1024 * 1024, 1024),

        // Número máximo de cues conservados por subtítulo
        MAX_CUES            : _num(VP.config.subMaxCues, 60000, 10),

        // Formatos soportados (los nuevos son best-effort y no rompen nada)
        FORMATOS            : {
            srt: true, vtt: true, ass: true, ssa: true, sub: true, lrc: true,
        },

        // Extensiones a probar al buscar subtítulo automático
        EXTENSIONES_SUB     : (function () {
            var lista = VP.config.extensionesSub;
            if (Array.isArray(lista) && lista.length) {
                return lista.slice();
            }
            return ['.srt', '.vtt', '.ass', '.ssa'];
        })(),

        // Idioma por defecto de la pista <track>
        IDIOMA_PISTA        : (typeof VP.config.subIdioma === 'string' &&
                               VP.config.subIdioma) || 'es',

        // Tamaño del lote al procesar la cola en background
        LOTE_COLA           : _num(VP.config.subLoteCola, 8, 1, 1000),

        // Tiempo de debounce al disparar eventos de cola (ms)
        DEBOUNCE_COLA_MS    : _num(VP.config.subDebounceCola, 50, 0),

        // Envejecimiento: ms tras los cuales un trabajo normal sube de rango
        ENVEJECIMIENTO_MS   : _num(VP.config.subEnvejecimiento, 8000, 500),

        // Pausar la cola cuando la pestaña está oculta
        PAUSAR_OCULTO       : VP.config.subPausarOculto === true,

        // Reintentar lectura con latin-1 si aparecen caracteres inválidos
        FALLBACK_LATIN1     : VP.config.subFallbackLatin1 !== false,

        // Tolerancia (s) al buscar el cue activo
        TOLERANCIA_CUE      : (function () {
            var n = Number(VP.config.subToleranciaCue);
            return (isFinite(n) && n >= 0) ? n : 0;
        })(),
    };

    // Lista de extensiones normalizadas (sin punto, minúsculas) — cacheada
    var _EXT_NORMALIZADAS = CFG.EXTENSIONES_SUB.map(function (ext) {
        return String(ext).replace(/^\./, '').toLowerCase();
    });

    // ============================================================
    // 2.bis  POLYFILLS / FALLBACKS DE UTILIDADES
    // Si vp-utilidades.js no expone alguna función, se usa una
    // implementación interna equivalente. Nunca se sobrescribe la
    // implementación oficial si existe.
    // ============================================================

    var _u = {};

    _u.obtenerExtension = (typeof util.obtenerExtension === 'function')
        ? function (nombre) { return util.obtenerExtension(nombre); }
        : function (nombre) {
            var n = String(nombre || '');
            var p = n.lastIndexOf('.');
            return p > 0 ? n.slice(p) : '';
        };

    _u.obtenerNombreBase = (typeof util.obtenerNombreBase === 'function')
        ? function (nombre) { return util.obtenerNombreBase(nombre); }
        : function (nombre) {
            var n = String(nombre || '');
            var p = n.lastIndexOf('.');
            return p > 0 ? n.slice(0, p) : n;
        };

    _u.eliminarElemento = (typeof util.eliminarElemento === 'function')
        ? function (el) { return util.eliminarElemento(el); }
        : function (el) {
            try {
                if (el && el.parentNode) el.parentNode.removeChild(el);
            } catch (_) {}
        };

    _u.throttle = (typeof util.throttle === 'function')
        ? function (fn, ms) { return util.throttle(fn, ms); }
        : function (fn, ms) {
            var ultimo = 0;
            return function () {
                var ahora = Date.now();
                if (ahora - ultimo < ms) return;
                ultimo = ahora;
                return fn.apply(this, arguments);
            };
        };

    // ---- Conversores de formato (fallback interno) ----

    function _normalizarSaltos(texto) {
        return String(texto)
            .replace(/^\uFEFF/, '')
            .replace(/\r\n?/g, '\n');
    }

    function _srtAVttInterno(srt) {
        var cuerpo = _normalizarSaltos(srt)
            // 00:00:01,250 --> 00:00:03,000
            .replace(
                /(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g,
                function (_m, hms, ms) {
                    while (ms.length < 3) ms += '0';
                    return hms + '.' + ms;
                }
            )
            // Índices numéricos sueltos de SRT (sólo la línea del número)
            .replace(/^[ \t]*\d+[ \t]*\n(?=[ \t]*\d{1,2}:\d{2}:\d{2})/gm, '');

        return 'WEBVTT\n\n' + cuerpo.replace(/^\s+/, '');
    }

    function _tiempoAssASegundos(t) {
        var m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(
            String(t).trim()
        );
        if (!m) return null;
        var cs = m[4] || '0';
        while (cs.length < 3) cs += '0';
        return (parseInt(m[1], 10) * 3600) +
               (parseInt(m[2], 10) * 60) +
               parseInt(m[3], 10) +
               (parseInt(cs, 10) / 1000);
    }

    function _limpiarTagsAss(texto) {
        return String(texto)
            .replace(/\{[^}]*\}/g, '')
            .replace(/\\[Nn]/g, '\n')
            .replace(/\\h/g, ' ')
            .trim();
    }

    function _assAVttInterno(ass) {
        var lineas = _normalizarSaltos(ass).split('\n');
        var campos = null;
        var salida = ['WEBVTT', ''];

        for (var i = 0; i < lineas.length; i++) {
            var linea = lineas[i];

            if (/^\s*Format\s*:/i.test(linea)) {
                campos = linea.split(':').slice(1).join(':')
                    .split(',').map(function (c) {
                        return c.trim().toLowerCase();
                    });
                continue;
            }

            if (!/^\s*Dialogue\s*:/i.test(linea)) continue;
            if (!campos) {
                campos = ['layer', 'start', 'end', 'style', 'name',
                          'marginl', 'marginr', 'marginv', 'effect', 'text'];
            }

            var resto  = linea.replace(/^\s*Dialogue\s*:\s*/i, '');
            var partes = resto.split(',');
            var iTexto = campos.indexOf('text');
            if (iTexto < 0) iTexto = campos.length - 1;

            var valores = partes.slice(0, iTexto);
            valores.push(partes.slice(iTexto).join(','));

            var ini = _tiempoAssASegundos(valores[campos.indexOf('start')]);
            var fin = _tiempoAssASegundos(valores[campos.indexOf('end')]);
            if (ini === null || fin === null) continue;

            var texto = _limpiarTagsAss(valores[valores.length - 1]);
            if (!texto) continue;

            salida.push(
                _segundosATimestamp(ini) + ' --> ' + _segundosATimestamp(fin)
            );
            salida.push(texto);
            salida.push('');
        }

        return salida.join('\n');
    }

    /** MicroDVD (.sub): {inicio}{fin}texto — requiere FPS (25 por defecto). */
    function _subAVttInterno(sub, fps) {
        fps = _num(fps, 25, 1, 240);
        var lineas = _normalizarSaltos(sub).split('\n');
        var salida = ['WEBVTT', ''];

        for (var i = 0; i < lineas.length; i++) {
            var m = /^\{(\d+)\}\{(\d+)\}(.*)$/.exec(lineas[i]);
            if (!m) continue;
            var ini = parseInt(m[1], 10) / fps;
            var fin = parseInt(m[2], 10) / fps;
            var txt = m[3].replace(/\{[^}]*\}/g, '').replace(/\|/g, '\n').trim();
            if (!txt || !(fin > ini)) continue;
            salida.push(
                _segundosATimestamp(ini) + ' --> ' + _segundosATimestamp(fin)
            );
            salida.push(txt);
            salida.push('');
        }
        return salida.join('\n');
    }

    /** LRC (letras con tiempo). Cada línea dura hasta la siguiente. */
    function _lrcAVttInterno(lrc) {
        var lineas = _normalizarSaltos(lrc).split('\n');
        var items  = [];

        for (var i = 0; i < lineas.length; i++) {
            var linea = lineas[i];
            var re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
            var m, tiempos = [];
            while ((m = re.exec(linea)) !== null) {
                var frac = m[3] || '0';
                while (frac.length < 3) frac += '0';
                tiempos.push(
                    parseInt(m[1], 10) * 60 +
                    parseInt(m[2], 10) +
                    parseInt(frac, 10) / 1000
                );
            }
            if (!tiempos.length) continue;
            var texto = linea.replace(re, '').trim();
            if (!texto) continue;
            tiempos.forEach(function (t) {
                items.push({ t: t, texto: texto });
            });
        }

        items.sort(function (a, b) { return a.t - b.t; });

        var salida = ['WEBVTT', ''];
        for (var j = 0; j < items.length; j++) {
            var ini = items[j].t;
            var fin = (j + 1 < items.length)
                ? Math.max(items[j + 1].t, ini + 0.2)
                : ini + 4;
            salida.push(
                _segundosATimestamp(ini) + ' --> ' + _segundosATimestamp(fin)
            );
            salida.push(items[j].texto);
            salida.push('');
        }
        return salida.join('\n');
    }

    /** Parser VTT interno (fallback de util.parsearCuesVtt). */
    function _parsearCuesVttInterno(textoVtt) {
        var lineas = _normalizarSaltos(textoVtt).split('\n');
        var cues   = [];
        var i      = 0;

        var reTiempo = new RegExp(
            '^\\s*((?:\\d{1,3}:)?\\d{1,2}:\\d{1,2}[.,]\\d{1,3})' +
            '\\s*-->\\s*' +
            '((?:\\d{1,3}:)?\\d{1,2}:\\d{1,2}[.,]\\d{1,3})' +
            '(.*)$'
        );

        function aSegundos(ts) {
            var limpio = String(ts).trim().replace(',', '.');
            var partes = limpio.split(':');
            var seg = 0;
            for (var k = 0; k < partes.length; k++) {
                seg = seg * 60 + parseFloat(partes[k]);
            }
            return isFinite(seg) ? seg : null;
        }

        while (i < lineas.length) {
            var m = reTiempo.exec(lineas[i]);
            if (!m) { i++; continue; }

            var inicio = aSegundos(m[1]);
            var fin    = aSegundos(m[2]);
            var ajustes = (m[3] || '').trim();
            i++;

            var buffer = [];
            while (i < lineas.length && lineas[i].trim() !== '') {
                buffer.push(lineas[i]);
                i++;
            }

            if (inicio === null || fin === null) continue;

            var raw   = buffer.join('\n');
            var texto = raw.replace(/<[^>]+>/g, '').trim();
            if (!texto) continue;

            cues.push({
                inicio : inicio,
                fin    : fin,
                texto  : texto,
                raw    : raw,
                ajustes: ajustes,
            });

            if (cues.length >= CFG.MAX_CUES) break;
        }

        return cues;
    }

    _u.srtAVtt = (typeof util.srtAVtt === 'function')
        ? function (s) { return util.srtAVtt(s); }
        : _srtAVttInterno;

    _u.assAVtt = (typeof util.assAVtt === 'function')
        ? function (s) { return util.assAVtt(s); }
        : _assAVttInterno;

    _u.parsearCuesVtt = (typeof util.parsearCuesVtt === 'function')
        ? function (s) { return util.parsearCuesVtt(s); }
        : _parsearCuesVttInterno;

    // ============================================================
    // 3. ABORT TOKEN
    // Cancelación ligera sin depender de AbortController nativo
    // ============================================================

    /**
     * Crea un token de cancelación independiente para cada video.
     * @returns {{ cancelado: boolean, cancelar: function, alCancelar: function }}
     */
    function _crearAbortToken() {
        return {
            cancelado : false,
            _oyentes  : [],
            cancelar  : function () {
                if (this.cancelado) return;
                this.cancelado = true;
                var oyentes = this._oyentes;
                this._oyentes = [];
                for (var i = 0; i < oyentes.length; i++) {
                    try { oyentes[i](); } catch (_) {}
                }
            },
            alCancelar: function (fn) {
                if (typeof fn !== 'function') return;
                if (this.cancelado) { try { fn(); } catch (_) {} return; }
                this._oyentes.push(fn);
            },
        };
    }

    /**
     * Cancela el token existente de un video (si lo hay)
     * y crea uno nuevo.
     * @param {string} videoId
     * @returns {Object} nuevo AbortToken
     */
    function _renovarAbortToken(videoId) {
        if (_estado.abortTokens[videoId]) {
            try { _estado.abortTokens[videoId].cancelar(); } catch (_) {}
        }
        var token = _crearAbortToken();
        _estado.abortTokens[videoId] = token;
        return token;
    }

    /**
     * Obtiene el token activo de un video.
     * @param {string} videoId
     * @returns {Object|null}
     */
    function _obtenerToken(videoId) {
        return _estado.abortTokens[videoId] || null;
    }

    /** Libera tokens ya cancelados para evitar crecimiento indefinido. */
    function _podarTokens() {
        var ids = Object.keys(_estado.abortTokens);
        if (ids.length < 1000) return;
        ids.forEach(function (id) {
            var t = _estado.abortTokens[id];
            if (t && t.cancelado && !_estado.enVuelo[id]) {
                delete _estado.abortTokens[id];
            }
        });
    }

    // ---- Temporizadores gestionados (cancelables en destruir) ----

    function _setTimeout(fn, ms) {
        var id = setTimeout(function () {
            var i = _estado.timers.indexOf(id);
            if (i !== -1) _estado.timers.splice(i, 1);
            try { fn(); } catch (e) { log.warn('timer:', e); }
        }, ms);
        _estado.timers.push(id);
        return id;
    }

    function _limpiarTimers() {
        _estado.timers.forEach(function (id) {
            try { clearTimeout(id); } catch (_) {}
        });
        _estado.timers = [];
    }

    // ============================================================
    // 4. CACHÉ LRU EN MEMORIA
    // ============================================================

    function _bytesAprox(texto) {
        return (typeof texto === 'string') ? texto.length * 2 : 0;
    }

    function _expirada(entrada) {
        if (!entrada) return true;
        if (!CFG.CACHE_TTL_MS) return false;
        return (Date.now() - entrada.ts) > CFG.CACHE_TTL_MS;
    }

    /**
     * Lee una entrada del caché LRU.
     * Actualiza el orden LRU (más recientemente usado al final).
     * @param {string} id
     * @returns {{ vtt: string, cues: Array }|null}
     */
    function _cacheGet(id) {
        if (!id || !_estado.cacheMemoria[id]) return null;

        var entrada = _estado.cacheMemoria[id];

        // Caducidad opcional (TTL)
        if (_expirada(entrada)) {
            _cacheInvalidar(id);
            return null;
        }

        // Mover al final (más reciente)
        var idx = _estado.cacheLRUOrder.indexOf(id);
        if (idx !== -1) {
            _estado.cacheLRUOrder.splice(idx, 1);
        }
        _estado.cacheLRUOrder.push(id);

        entrada.hits++;
        entrada.ultimoAcceso = Date.now();
        _estado.metricas.cacheHits++;

        return { vtt: entrada.vtt, cues: entrada.cues };
    }

    /**
     * Escribe una entrada en el caché LRU.
     * Evicta las entradas más antiguas si se supera el límite de
     * entradas o el presupuesto de bytes.
     * @param {string} id
     * @param {string} vtt
     * @param {Array}  cues
     */
    function _cacheSet(id, vtt, cues) {
        if (!id || typeof vtt !== 'string') return;
        if (!Array.isArray(cues)) cues = [];

        var bytes = _bytesAprox(vtt);

        // Si ya existe, sólo actualizar
        if (_estado.cacheMemoria[id]) {
            var prev = _estado.cacheMemoria[id];
            _estado.cacheBytes -= (prev.bytes || 0);

            prev.vtt   = vtt;
            prev.cues  = cues;
            prev.ts    = Date.now();
            prev.bytes = bytes;
            prev.ultimoAcceso = prev.ts;

            // FIX: cuesOriginales guardaba los cues previos para el
            // desfase. Al cambiar el contenido hay que invalidarlo, o
            // ajustarDesfase seguiria desplazando el texto rancio.
            if (prev.cuesOriginales) {
                prev.cuesOriginales = null;
                delete prev.cuesOriginales;
            }

            _estado.cacheBytes += bytes;

            var idx = _estado.cacheLRUOrder.indexOf(id);
            if (idx !== -1) _estado.cacheLRUOrder.splice(idx, 1);
            _estado.cacheLRUOrder.push(id);

            _evictarSiNecesario(id);
            return;
        }

        // Insertar nueva entrada
        _estado.cacheMemoria[id] = {
            vtt   : vtt,
            cues  : cues,
            ts    : Date.now(),
            hits  : 0,
            bytes : bytes,
            ultimoAcceso: Date.now(),
        };
        _estado.cacheLRUOrder.push(id);
        _estado.cacheBytes += bytes;
        _estado.metricas.cacheMisses++;

        _evictarSiNecesario(id);
    }

    /**
     * Evicta entradas antiguas hasta respetar límites de tamaño.
     * Nunca evicta la entrada recién insertada (idProtegido).
     */
    function _evictarSiNecesario(idProtegido) {
        var guardas = 0;

        while (
            (_estado.cacheLRUOrder.length > CFG.CACHE_LRU_MAX ||
             _estado.cacheBytes > CFG.CACHE_MAX_BYTES) &&
            _estado.cacheLRUOrder.length > 1 &&
            guardas++ < 100000
        ) {
            var idEjectar = _estado.cacheLRUOrder[0];

            if (idEjectar === idProtegido) {
                if (_estado.cacheLRUOrder.length < 2) break;
                // Mover el protegido al final y evictar el siguiente
                _estado.cacheLRUOrder.shift();
                _estado.cacheLRUOrder.push(idEjectar);
                continue;
            }

            _estado.cacheLRUOrder.shift();

            var entrada = _estado.cacheMemoria[idEjectar];
            if (entrada) {
                _estado.cacheBytes -= (entrada.bytes || 0);
                delete _estado.cacheMemoria[idEjectar];
                _estado.metricas.evicciones++;

                log.debug(
                    'Caché LRU: evicta →', idEjectar,
                    '(tamaño:', _estado.cacheLRUOrder.length,
                    '· bytes:', _estado.cacheBytes, ')'
                );
            }
        }

        if (_estado.cacheBytes < 0) _estado.cacheBytes = 0;
    }

    /**
     * Invalida una entrada del caché LRU.
     * @param {string} id
     */
    function _cacheInvalidar(id) {
        if (!id) return;
        var entrada = _estado.cacheMemoria[id];
        if (entrada) _estado.cacheBytes -= (entrada.bytes || 0);
        if (_estado.cacheBytes < 0) _estado.cacheBytes = 0;

        delete _estado.cacheMemoria[id];
        var idx = _estado.cacheLRUOrder.indexOf(id);
        if (idx !== -1) _estado.cacheLRUOrder.splice(idx, 1);
    }

    /**
     * Vacía completamente el caché LRU.
     */
    function _cacheLimpiar() {
        _estado.cacheMemoria  = Object.create(null);
        _estado.cacheLRUOrder = [];
        _estado.cacheBytes    = 0;
        log.debug('Caché LRU vaciado.');
    }

    /**
     * Elimina únicamente las entradas caducadas (TTL).
     * @returns {number} entradas purgadas
     */
    function _cachePurgarExpirado() {
        if (!CFG.CACHE_TTL_MS) return 0;
        var purgadas = 0;
        _estado.cacheLRUOrder.slice().forEach(function (id) {
            if (_expirada(_estado.cacheMemoria[id])) {
                _cacheInvalidar(id);
                purgadas++;
            }
        });
        if (purgadas) log.debug('Caché LRU: purgadas', purgadas, 'entradas.');
        return purgadas;
    }

    // ============================================================
    // 5. COLA DE PROCESAMIENTO CON CONCURRENCIA LIMITADA
    // ============================================================

    /**
     * @typedef {Object} TrabajoCola
     * @property {Object}   vObj       - Objeto de video
     * @property {Function} resolver   - resolve de la Promise externa
     * @property {number}   intentos   - intentos realizados
     * @property {number}   prioridad  - 0 = normal, 1 = alta
     * @property {number}   ts         - timestamp de encolado
     * @property {number}   seq        - secuencia monótona (orden estable)
     * @property {Object}   token      - AbortToken asociado
     */

    /**
     * Encola un trabajo de procesamiento de subtítulos.
     * Si ya hay un trabajo en vuelo para el mismo video,
     * devuelve la Promise existente (deduplicación).
     *
     * @param {Object}  vObj
     * @param {number}  [prioridad=0]
     * @returns {Promise<string|null>}
     */
    function _encolar(vObj, prioridad) {
        if (!vObj || !vObj.id) return Promise.resolve(null);
        if (_estado.destruido) return Promise.resolve(null);

        var id = vObj.id;
        prioridad = (prioridad === 1) ? 1 : 0;

        // ---- Deduplicación: ya hay trabajo en vuelo ----
        if (_estado.enVuelo[id]) {
            log.debug('Cola: trabajo ya en vuelo para →', id);
            // Si ahora se pide con prioridad alta, promocionar el trabajo
            if (prioridad === 1) _promocionarEnCola(id);
            return _estado.enVuelo[id];
        }

        // ---- Caché en memoria ----
        var cacheado = _cacheGet(id);
        if (cacheado) {
            log.debug('Cola: hit caché memoria →', id);
            return Promise.resolve(cacheado.vtt);
        }

        // ---- Crear Promise de trabajo ----
        var promesa = new Promise(function (resolve) {
            var token = _renovarAbortToken(id);

            /** @type {TrabajoCola} */
            var trabajo = {
                vObj      : vObj,
                resolver  : _unaVez(resolve),
                intentos  : 0,
                prioridad : prioridad,
                ts        : Date.now(),
                seq       : ++_estado.colaSecuencia,
                token     : token,
            };

            // Insertar respetando prioridad
            if (prioridad === 1) {
                _estado.cola.unshift(trabajo);
            } else {
                _estado.cola.push(trabajo);
            }

            // Actualizar métrica de pico
            if (_estado.cola.length > _estado.metricas.colaMax) {
                _estado.metricas.colaMax = _estado.cola.length;
            }

            log.debug(
                'Cola: encolado →', id,
                '(cola:', _estado.cola.length,
                '· vuelo:', _estado.colaEnEjecucion, ')'
            );

            _procesarCola();
        });

        // Registrar en vuelo y limpiar cuando termine
        _estado.enVuelo[id] = promesa;
        promesa.then(
            function ()  { delete _estado.enVuelo[id]; _podarTokens(); },
            function ()  { delete _estado.enVuelo[id]; _podarTokens(); }
        );

        return promesa;
    }

    /** Garantiza que un resolver sólo se invoque una vez. */
    function _unaVez(fn) {
        var llamado = false;
        return function (valor) {
            if (llamado) return;
            llamado = true;
            try { fn(valor); } catch (e) { log.warn('resolver:', e); }
        };
    }

    /** Sube un trabajo pendiente al frente de la cola. */
    function _promocionarEnCola(videoId) {
        for (var i = 0; i < _estado.cola.length; i++) {
            if (_estado.cola[i].vObj && _estado.cola[i].vObj.id === videoId) {
                var t = _estado.cola.splice(i, 1)[0];
                t.prioridad = 1;
                _estado.cola.unshift(t);
                return true;
            }
        }
        return false;
    }

    /**
     * Envejecimiento: evita la inanición de trabajos normales cuando
     * llegan muchos de prioridad alta de forma continua.
     */
    function _envejecerCola() {
        if (_estado.cola.length < 2) return;
        var ahora = Date.now();
        var movidos = 0;

        for (var i = _estado.cola.length - 1; i >= 0; i--) {
            var t = _estado.cola[i];
            if (t.prioridad === 0 &&
                (ahora - t.ts) > CFG.ENVEJECIMIENTO_MS) {
                t.prioridad = 1;
                t.ts = ahora;
                _estado.cola.splice(i, 1);
                _estado.cola.unshift(t);
                movidos++;
                if (movidos >= CFG.LOTE_COLA) break;
            }
        }
    }

    /**
     * Avanza la cola mientras haya ranuras libres.
     * Llama a _ejecutarTrabajo para cada trabajo dequeued.
     */
    function _procesarCola() {
        if (_estado.colaPausada || _estado.destruido) return;

        _envejecerCola();

        var lanzados = 0;

        while (
            _estado.cola.length > 0 &&
            _estado.colaEnEjecucion < CFG.MAX_CONCURRENTES
        ) {
            var trabajo = _estado.cola.shift();
            if (!trabajo) break;

            // Si el token fue cancelado antes de ejecutar → resolver null
            if (trabajo.token && trabajo.token.cancelado) {
                log.debug(
                    'Cola: trabajo cancelado antes de ejecutar →',
                    trabajo.vObj && trabajo.vObj.id
                );
                _estado.metricas.cancelados++;
                trabajo.resolver(null);
                continue;
            }

            _estado.colaEnEjecucion++;
            _ejecutarTrabajo(trabajo);

            // Ceder el hilo cada LOTE_COLA lanzamientos para no bloquear UI
            if (++lanzados >= CFG.LOTE_COLA) {
                _setTimeout(_procesarCola, CFG.DEBOUNCE_COLA_MS);
                break;
            }
        }
    }

    /**
     * Ejecuta un trabajo de la cola.
     * Implementa reintentos con back-off exponencial + jitter.
     * @param {TrabajoCola} trabajo
     */
    function _ejecutarTrabajo(trabajo) {
        var t0 = _ahora();
        var finalizado = false;

        function liberarRanura() {
            if (finalizado) return;
            finalizado = true;
            _estado.colaEnEjecucion--;
            if (_estado.colaEnEjecucion < 0) _estado.colaEnEjecucion = 0;
        }

        var promesa;
        try {
            promesa = _leerYConvertirArchivo(trabajo);
        } catch (e) {
            promesa = Promise.reject(e);
        }

        Promise.resolve(promesa)
            .then(function (vtt) {
                liberarRanura();
                _estado.metricas.tiempoTotal += (_ahora() - t0);

                if (vtt !== null && vtt !== undefined) {
                    _estado.metricas.procesados++;
                }

                trabajo.resolver(vtt === undefined ? null : vtt);
                _procesarCola(); // avanzar cola
            })
            .catch(function (err) {
                liberarRanura();
                _estado.metricas.tiempoTotal += (_ahora() - t0);

                var cancelado = !!(trabajo.token && trabajo.token.cancelado);

                var reintentar = (
                    !cancelado &&
                    !_estado.destruido &&
                    trabajo.intentos < CFG.MAX_REINTENTOS &&
                    _esErrorReintenble(err)
                );

                if (reintentar) {
                    trabajo.intentos++;
                    _estado.metricas.reintentos++;

                    var base = CFG.BACKOFF_BASE_MS *
                               Math.pow(2, trabajo.intentos - 1);
                    var delay = Math.min(base, CFG.BACKOFF_MAX_MS);
                    // Jitter ±20 % para evitar tormentas sincronizadas
                    delay = Math.round(delay * (0.8 + Math.random() * 0.4));

                    log.warn(
                        'Cola: reintento', trabajo.intentos,
                        'de', CFG.MAX_REINTENTOS,
                        'para →', trabajo.vObj && trabajo.vObj.id,
                        '(delay', delay + 'ms)'
                    );

                    _setTimeout(function () {
                        if ((trabajo.token && trabajo.token.cancelado) ||
                            _estado.destruido) {
                            _estado.metricas.cancelados++;
                            trabajo.resolver(null);
                            _procesarCola();
                            return;
                        }
                        if (_estado.colaPausada) {
                            // Reencolar al frente y esperar reanudación
                            _estado.cola.unshift(trabajo);
                            return;
                        }
                        // FIX: respetar el tope de concurrencia. La
                        // ranura se libero en liberarRanura(); retomarla
                        // sin comprobar el limite permitia superar
                        // MAX_CONCURRENTES y abrir mas FileReaders de
                        // los permitidos.
                        if (_estado.colaEnEjecucion >= CFG.MAX_CONCURRENTES) {
                            _estado.cola.unshift(trabajo);
                            return;
                        }

                        _estado.colaEnEjecucion++;
                        _ejecutarTrabajo(trabajo);
                    }, delay);

                } else {
                    if (cancelado) {
                        _estado.metricas.cancelados++;
                    } else {
                        _estado.metricas.errores++;
                        log.error(
                            'Cola: trabajo fallido definitivamente →',
                            trabajo.vObj && trabajo.vObj.id, err
                        );
                        _emitirBus('subtitulosError', {
                            vObj : trabajo.vObj,
                            error: err,
                        });
                    }
                    trabajo.resolver(null);
                    _procesarCola();
                }
            });
    }

    function _ahora() {
        try {
            return (performance && typeof performance.now === 'function')
                ? performance.now()
                : Date.now();
        } catch (_) {
            return Date.now();
        }
    }

    /**
     * Determina si un error amerita reintento.
     * @param {Error|*} err
     * @returns {boolean}
     */
    function _esErrorReintenble(err) {
        if (!err) return false;

        // NOT_READABLE_ERR (4) es transitorio; SECURITY_ERR (2) no lo es
        if (typeof err.code === 'number') {
            if (err.code === 4) return true;
            if (err.code === 1 || err.code === 2 || err.code === 3) return false;
        }

        var nombre = String(err.name || '').toLowerCase();
        if (nombre === 'aborterror' ||
            nombre === 'notallowederror' ||
            nombre === 'securityerror') {
            return false;
        }
        if (nombre === 'notreadableerror' || nombre === 'notfounderror') {
            return nombre === 'notreadableerror';
        }

        if (err.message &&
            String(err.message).toLowerCase().indexOf('abort') === -1) {
            return true;
        }
        return false;
    }

    // ============================================================
    // 6. LECTURA Y CONVERSIÓN DEL ARCHIVO
    // ============================================================

    /** Heurística: ¿el texto decodificado parece corrupto? */
    function _pareceMalDecodificado(texto) {
        if (!texto) return false;
        var muestra = texto.length > 20000 ? texto.slice(0, 20000) : texto;
        var malos = muestra.split('\uFFFD').length - 1;
        return malos > 0 && (malos / muestra.length) > 0.0005;
    }

    /** Detecta la codificación por BOM. */
    function _codificacionPorBom(texto) {
        if (typeof texto !== 'string' || !texto.length) return null;
        var c = texto.charCodeAt(0);
        if (c === 0xFEFF) return 'utf-8';
        return null;
    }

    /**
     * Lee el archivo del trabajo y lo convierte a VTT.
     * Toda la lógica de FileReader vive aquí.
     * @param {TrabajoCola} trabajo
     * @returns {Promise<string|null>}
     */
    function _leerYConvertirArchivo(trabajo) {
        var vObj    = trabajo.vObj;
        var token   = trabajo.token || _crearAbortToken();
        var archivo = vObj && vObj.subtitleFile;

        return new Promise(function (resolve, reject) {

            // ---- Validar archivo ----
            if (!archivo ||
                typeof archivo.name !== 'string' ||
                !archivo.name) {
                return resolve(null);
            }

            // ---- Validar tamaño ----
            if (typeof archivo.size === 'number' &&
                archivo.size > CFG.MAX_BYTES) {
                log.warn(
                    'leerYConvertir: archivo demasiado grande →',
                    archivo.name,
                    '(' + Math.round(archivo.size / 1024) + ' KB)'
                );
                return resolve(null);
            }

            if (typeof archivo.size === 'number' && archivo.size === 0) {
                log.warn('leerYConvertir: archivo vacío →', archivo.name);
                return resolve(null);
            }

            // ---- Validar extensión ----
            var ext;
            try {
                ext = String(_u.obtenerExtension(archivo.name) || '')
                          .replace(/^\./, '')
                          .toLowerCase();
            } catch (e) {
                log.warn('leerYConvertir: obtenerExtension falló:', e);
                return resolve(null);
            }

            if (!CFG.FORMATOS[ext]) {
                log.warn(
                    'leerYConvertir: formato no soportado →',
                    ext, '·', archivo.name
                );
                return resolve(null);
            }

            // ---- Comprobación precancelación ----
            if (token.cancelado) {
                log.debug(
                    'leerYConvertir: cancelado antes de leer →',
                    vObj.id
                );
                return resolve(null);
            }

            // ---- FileReader ----
            var reader        = null;
            var resuelto      = false;
            var timerTimeout  = null;
            var intentoLatin1 = false;

            function desconectarReader() {
                try {
                    if (reader) {
                        reader.onload  = null;
                        reader.onerror = null;
                        reader.onabort = null;
                    }
                } catch (_) {}
            }

            function resolver(valor) {
                if (resuelto) return;
                resuelto = true;
                clearTimeout(timerTimeout);
                desconectarReader();
                resolve(valor);
            }

            function rechazar(err) {
                if (resuelto) return;
                resuelto = true;
                clearTimeout(timerTimeout);
                desconectarReader();
                reject(err);
            }

            // Cancelación externa → abortar lectura en curso
            token.alCancelar(function () {
                if (resuelto) return;
                try { if (reader) reader.abort(); } catch (_) {}
                resolver(null);
            });

            // ---- Timeout ----
            try {
                timerTimeout = setTimeout(function () {
                    log.warn(
                        'leerYConvertir: timeout →', archivo.name
                    );
                    _estado.metricas.timeouts++;
                    try { if (reader) reader.abort(); } catch (_) {}
                    resolver(null);
                }, CFG.TIMEOUT_LECTURA_MS);
            } catch (_) {}

            // ---- Crear FileReader ----
            try {
                reader = new FileReader();
            } catch (e) {
                log.error('leerYConvertir: new FileReader falló:', e);
                clearTimeout(timerTimeout);
                return resolve(null);
            }

            // ---- onload ----
            reader.onload = function (ev) {
                try {
                    // Verificar cancelación post-lectura
                    if (token.cancelado) {
                        log.debug(
                            'leerYConvertir: cancelado post-lectura →',
                            vObj.id
                        );
                        return resolver(null);
                    }

                    var raw = (ev && ev.target) ? ev.target.result : null;

                    // ---- Validar contenido ----
                    if (!raw ||
                        typeof raw !== 'string' ||
                        !raw.trim()) {
                        log.warn(
                            'leerYConvertir: contenido vacío →',
                            archivo.name
                        );
                        return resolver(null);
                    }

                    // Límite de seguridad adicional por caracteres
                    if (raw.length > CFG.MAX_BYTES) {
                        log.warn(
                            'leerYConvertir: contenido excede límite →',
                            archivo.name
                        );
                        return resolver(null);
                    }

                    // ---- Reintento de codificación (latin-1) ----
                    if (!intentoLatin1 &&
                        CFG.FALLBACK_LATIN1 &&
                        _pareceMalDecodificado(raw)) {

                        intentoLatin1 = true;
                        log.debug(
                            'leerYConvertir: reintentando con windows-1252 →',
                            archivo.name
                        );
                        try {
                            reader.readAsText(archivo, 'windows-1252');
                            return; // esperamos el segundo onload
                        } catch (e) {
                            log.debug(
                                'leerYConvertir: fallback latin-1 falló:', e
                            );
                            // continuar con el texto original
                        }
                    }

                    _estado.metricas.bytesLeidos += raw.length;

                    // ---- Conversión de formato ----
                    var textoVtt;
                    try {
                        textoVtt = _convertirAVtt(raw, ext, archivo.name, vObj);
                    } catch (e) {
                        log.warn(
                            'leerYConvertir: conversión falló →',
                            archivo.name, e
                        );
                        return resolver(null);
                    }

                    // ---- Validar VTT resultante ----
                    if (!textoVtt ||
                        textoVtt.indexOf('-->') === -1) {
                        log.warn(
                            'leerYConvertir: VTT sin timestamps →',
                            archivo.name
                        );
                        return resolver(null);
                    }

                    // ---- Parsear cues ----
                    var cues = [];
                    try {
                        cues = VP.subtitulos.parsearCues(textoVtt);
                        if (!Array.isArray(cues)) cues = [];
                    } catch (e) {
                        log.warn(
                            'leerYConvertir: parsearCues falló →',
                            archivo.name, e
                        );
                    }

                    // Validar que hay cues útiles
                    if (cues.length === 0) {
                        log.warn(
                            'leerYConvertir: sin cues parseables →',
                            archivo.name
                        );
                    }

                    // ---- Cachear en memoria ----
                    _cacheSet(vObj.id, textoVtt, cues);

                    // ---- Guardar en IDB (no bloqueante) ----
                    _guardarEnIDB(vObj.name, textoVtt);

                    // ---- Exponer si es el video actual ----
                    _exponerSiEsCurrent(vObj, cues, textoVtt, ext);

                    log.info(
                        'Subtítulo procesado:',
                        cues.length, 'cues ·',
                        archivo.name,
                        '(' + ext.toUpperCase() + ')'
                    );

                    resolver(textoVtt);

                } catch (e) {
                    log.error(
                        'leerYConvertir: error en onload →',
                        archivo.name, e
                    );
                    rechazar(e);
                }
            };

            // ---- onerror ----
            reader.onerror = function (ev) {
                var CODIGOS_FR = {
                    1: 'NOT_FOUND_ERR',
                    2: 'SECURITY_ERR',
                    3: 'ABORT_ERR',
                    4: 'NOT_READABLE_ERR',
                    5: 'ENCODING_ERR',
                };

                var errObj    = (ev && ev.target) ? ev.target.error : null;
                var codigo    = errObj ? errObj.code : 'desconocido';
                var nombreCod = CODIGOS_FR[codigo] || ('código ' + codigo);

                log.warn(
                    'leerYConvertir: error FileReader →',
                    nombreCod, '·', archivo.name
                );

                // Devolver error para que la cola decida reintento
                rechazar(errObj || new Error(nombreCod));
            };

            // ---- onabort ----
            reader.onabort = function () {
                log.debug(
                    'leerYConvertir: lectura abortada →', archivo.name
                );
                resolver(null);
            };

            // ---- Iniciar lectura ----
            try {
                reader.readAsText(archivo, 'utf-8');
            } catch (e) {
                log.error(
                    'leerYConvertir: readAsText falló →', archivo.name, e
                );
                clearTimeout(timerTimeout);
                resolve(null);
            }
        });
    }

    // ============================================================
    // 7. CONVERSIÓN DE FORMATOS
    // ============================================================

    /**
     * Convierte el texto crudo al formato VTT.
     * @param {string} raw      - Texto original
     * @param {string} ext      - Extensión sin punto: srt|vtt|ass|ssa|sub|lrc
     * @param {string} nombre   - Nombre del archivo (para logs)
     * @param {Object} [vObj]   - Video asociado (para FPS en MicroDVD)
     * @returns {string}        - Texto VTT
     */
    function _convertirAVtt(raw, ext, nombre, vObj) {
        var salida;

        switch (ext) {

            case 'srt':
                salida = _u.srtAVtt(raw);
                break;

            case 'ass':
            case 'ssa':
                salida = _u.assAVtt(raw);
                break;

            case 'sub':
                salida = _subAVttInterno(raw, (vObj && vObj.fps) || 25);
                break;

            case 'lrc':
                salida = _lrcAVttInterno(raw);
                break;

            case 'vtt': {
                // Asegurar cabecera WEBVTT correcta
                var recortado = raw.replace(/^\uFEFF/, '') // BOM
                                   .replace(/^\s+/, '');

                if (recortado.indexOf('WEBVTT') !== 0) {
                    log.warn(
                        '_convertirAVtt: VTT sin cabecera →',
                        nombre, '— añadiendo WEBVTT'
                    );
                    salida = 'WEBVTT\n\n' + raw;
                } else {
                    salida = raw;
                }
                break;
            }

            default:
                throw new Error(
                    '_convertirAVtt: formato inesperado → ' + ext
                );
        }

        if (typeof salida !== 'string') {
            throw new Error(
                '_convertirAVtt: el conversor no devolvió texto → ' + ext
            );
        }

        // Saneado final común: BOM, CRLF y cabecera garantizada
        salida = salida.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        if (salida.replace(/^\s+/, '').indexOf('WEBVTT') !== 0) {
            salida = 'WEBVTT\n\n' + salida.replace(/^\s+/, '');
        }

        return salida;
    }

    /**
     * Normaliza y sanea una lista de cues:
     *  · descarta entradas inválidas (NaN, fin <= inicio)
     *  · ordena por inicio
     *  · corrige solapes mínimos para que la búsqueda binaria sea fiable
     *  · recorta a CFG.MAX_CUES
     * @param {Array} cues
     * @returns {Array}
     */
    function _normalizarCues(cues) {
        if (!Array.isArray(cues) || cues.length === 0) return [];

        var limpios = [];

        for (var i = 0; i < cues.length; i++) {
            var c = cues[i];
            if (!c || typeof c !== 'object') continue;

            var ini = Number(c.inicio);
            var fin = Number(c.fin);

            if (!isFinite(ini) || ini < 0) continue;
            if (!isFinite(fin)) fin = ini + 2;
            if (fin <= ini) fin = ini + 0.1;

            var texto = (typeof c.texto === 'string')
                ? c.texto
                : (typeof c.raw === 'string' ? c.raw : '');

            limpios.push({
                inicio : ini,
                fin    : fin,
                texto  : texto,
                raw    : (typeof c.raw === 'string') ? c.raw : texto,
                ajustes: c.ajustes || '',
                indice : 0,
            });

            if (limpios.length >= CFG.MAX_CUES) {
                log.warn(
                    '_normalizarCues: recortado a', CFG.MAX_CUES, 'cues.'
                );
                break;
            }
        }

        limpios.sort(function (a, b) {
            if (a.inicio !== b.inicio) return a.inicio - b.inicio;
            return a.fin - b.fin;
        });

        for (var j = 0; j < limpios.length; j++) {
            limpios[j].indice = j;
        }

        return limpios;
    }

    // ============================================================
    // 8. PERSISTENCIA EN IDB
    // ============================================================

    /**
     * Guarda el VTT en IDB de forma silenciosa.
     * No lanza ni propaga errores.
     * @param {string} videoId
     * @param {string} textoVtt
     */
    function _guardarEnIDB(videoId, textoVtt) {
        if (!videoId || typeof textoVtt !== 'string') return;
        if (!VP.db || typeof VP.db.guardarMetadatos !== 'function') {
            return;
        }

        try {
            var resultado = VP.db.guardarMetadatos(videoId, {
                subtitleVtt : textoVtt,
                subtitleTs  : Date.now(),
            });

            _estado.metricas.idbEscrituras++;

            if (resultado && typeof resultado.catch === 'function') {
                resultado.catch(function (e) {
                    log.warn('_guardarEnIDB: guardarMetadatos falló:', e);
                });
            }
        } catch (e) {
            log.warn('_guardarEnIDB: excepción síncrona:', e);
        }
    }

    /**
     * Lee el VTT de IDB.
     * @param {Object} vObj
     * @returns {Promise<string|null>}
     */
    function _leerDeIDB(vObj) {
        if (!vObj || !vObj.subtitleFile) {
            return Promise.resolve(null);
        }
        if (!VP.db ||
            typeof VP.db.obtenerMetadatos !== 'function') {
            return Promise.resolve(null);
        }

        var lectura;
        try {
            lectura = VP.db.obtenerMetadatos(vObj.name);
        } catch (e) {
            log.warn('_leerDeIDB: excepción síncrona:', e);
            return Promise.resolve(null);
        }

        return Promise.resolve(lectura)
            .then(function (m) {
                if (!m || !m.subtitleVtt) return null;
                if (typeof m.subtitleVtt !== 'string') return null;

                // Hidratar caché en memoria con los datos de IDB
                // (cues se reparsean para no serializar arrays en IDB)
                var cues = [];
                try {
                    cues = VP.subtitulos.parsearCues(m.subtitleVtt);
                    if (!Array.isArray(cues)) cues = [];
                } catch (_) {}

                _cacheSet(vObj.id, m.subtitleVtt, cues);
                _estado.metricas.idbHits++;

                log.debug(
                    '_leerDeIDB: subtítulo hidratado desde IDB →',
                    vObj.id
                );
                return m.subtitleVtt;
            })
            .catch(function (e) {
                log.warn('_leerDeIDB: error:', e);
                return null;
            });
    }

    // ============================================================
    // 9. EXPOSICIÓN GLOBAL DE CUES
    // ============================================================

    function _emitirBus(evento, datos) {
        try {
            if (bus && typeof bus.emit === 'function') {
                bus.emit(evento, datos);
            }
        } catch (e) {
            log.warn('bus.emit(' + evento + '):', e);
        }
    }

    /**
     * Expone los cues globalmente sólo si vObj es el video actual.
     * @param {Object} vObj
     * @param {Array}  cues
     * @param {string} textoVtt
     * @param {string} ext
     */
    function _exponerSiEsCurrent(vObj, cues, textoVtt, ext) {
        try {
            var esCurrent = _esVideoCurrent(vObj && vObj.id);

            if (!esCurrent) {
                log.debug(
                    '_exponerSiEsCurrent: video no es current → ' +
                    'descartando exposición:', vObj && vObj.id
                );
                return;
            }

            // Asignar con versión para detectar actualizaciones
            window.vpSubtitleCues    = Array.isArray(cues) ? cues : [];
            window.vpSubtitleVersion = (window.vpSubtitleVersion || 0) + 1;
            window.vpSubtitleVideoId = (vObj && vObj.id) || '';

            // Emitir CustomEvent
            _emitirEventoCues(window.vpSubtitleCues, vObj, ext, textoVtt);

            // Notificar bus interno
            _emitirBus('subtitulosCargados', {
                vObj    : vObj,
                cues    : window.vpSubtitleCues,
                formato : ext,
                version : window.vpSubtitleVersion,
            });

        } catch (e) {
            log.warn('_exponerSiEsCurrent: error:', e);
        }
    }

    /**
     * Emite el evento `vpSubtitleCuesReady` en window.
     */
    function _emitirEventoCues(cues, vObj, ext, textoVtt) {
        cues = Array.isArray(cues) ? cues : [];

        var detalle = {
            cues       : cues,
            videoName  : (vObj && vObj.name)  || '',
            videoId    : (vObj && vObj.id)    || '',
            cueCount   : cues.length,
            formato    : ext || '',
            duracion   : cues.length > 0
                ? (cues[cues.length - 1].fin || 0)
                : 0,
            version    : window.vpSubtitleVersion || 1,
            bytes      : textoVtt ? textoVtt.length : 0,
        };

        try {
            var evento;
            if (typeof window.CustomEvent === 'function') {
                evento = new CustomEvent('vpSubtitleCuesReady', {
                    bubbles    : false,
                    cancelable : false,
                    detail     : detalle,
                });
            } else if (document.createEvent) {
                // Fallback para navegadores antiguos
                evento = document.createEvent('CustomEvent');
                evento.initCustomEvent(
                    'vpSubtitleCuesReady', false, false, detalle
                );
            } else {
                return;
            }
            window.dispatchEvent(evento);
        } catch (e) {
            log.warn('_emitirEventoCues: CustomEvent falló:', e);
        }
    }

    /**
     * Comprueba si un videoId coincide con el video actual.
     * @param {string} videoId
     * @returns {boolean}
     */
    function _esVideoCurrent(videoId) {
        if (!videoId) return false;
        try {
            var curr = window.vpCurrentVideo;
            if (curr && typeof curr === 'object' && curr.id === videoId) {
                return true;
            }
            // Respaldo: comparar con la playlist si vpCurrentVideo no existe
            if (!curr && VP.estado && Array.isArray(VP.estado.playlist)) {
                var actual = VP.estado.playlist[VP.estado.currentVideoIndex];
                return !!(actual && actual.id === videoId);
            }
            return false;
        } catch (_) {
            return false;
        }
    }

    // ============================================================
    // 10. GESTIÓN DE BLOB-URLs
    // ============================================================

    /**
     * Crea y registra un Blob-URL para el VTT.
     * Revoca cualquier URL previa del mismo video.
     * @param {string} videoId
     * @param {string} textoVtt
     * @returns {string|null} URL del Blob
     */
    function _crearBlobUrl(videoId, textoVtt) {
        // Revocar URL anterior si existe
        _revocarBlobUrl(videoId);

        if (!VP.features.blobURL || !VP.features.blob) {
            return null;
        }
        if (typeof textoVtt !== 'string' || !textoVtt) return null;

        try {
            var blob = new Blob([textoVtt], { type: 'text/vtt;charset=utf-8' });
            var url  = URL.createObjectURL(blob);
            if (videoId) _estado.blobUrls[videoId] = url;
            return url;
        } catch (e) {
            log.warn('_crearBlobUrl:', e);
            return null;
        }
    }

    /**
     * Revoca y elimina el Blob-URL registrado para un video.
     * @param {string} videoId
     */
    function _revocarBlobUrl(videoId) {
        if (!videoId) return;
        var url = _estado.blobUrls[videoId];
        if (!url) return;

        try { URL.revokeObjectURL(url); } catch (_) {}
        delete _estado.blobUrls[videoId];
    }

    /**
     * Revoca todos los Blob-URLs registrados.
     */
    function _revocarTodosBlobUrls() {
        Object.keys(_estado.blobUrls).forEach(function (id) {
            _revocarBlobUrl(id);
        });
        _estado.blobUrls = Object.create(null);
    }

    // ============================================================
    // 11. API PÚBLICA — VP.subtitulos.*
    // ============================================================

    // ---- 11.1 limpiarPistas ----

    VP.subtitulos.limpiarPistas = function () {
        var video = VP.refs.videoPlayer;
        if (dom.esNulo(video)) {
            _estado.pistasActivas = Object.create(null);
            // FIX: sin <video> no hay pistas que quitar, pero los Blob-URL
            // registrados seguian vivos: fuga de memoria real (el registro
            // de Blobs del navegador los retiene para siempre).
            _revocarTodosBlobUrls();
            return;
        }

        try {
            var pistas = video.querySelectorAll('track');

            for (var i = 0; i < pistas.length; i++) {
                var pista = pistas[i];

                // Desactivar la pista antes de quitarla (evita residuos)
                try {
                    if (pista.track) pista.track.mode = 'disabled';
                } catch (_) {}

                // Revocar URL de blob si la conocemos
                if (pista._vpVideoId) {
                    _revocarBlobUrl(pista._vpVideoId);
                }

                _u.eliminarElemento(pista);
            }
        } catch (e) {
            log.warn('limpiarPistas:', e);
        }

        // Limpiar mapa de pistas activas
        _estado.pistasActivas = Object.create(null);
    };

    // ---- 11.2 obtenerCacheado ----

    /**
     * Busca el VTT en memoria primero, luego en IDB.
     * @param {Object} vObj
     * @returns {Promise<string|null>}
     */
    VP.subtitulos.obtenerCacheado = function (vObj) {
        if (!vObj || !vObj.subtitleFile) {
            return Promise.resolve(null);
        }

        // 1. Caché en memoria (instantáneo)
        var memoryCached = _cacheGet(vObj.id);
        if (memoryCached) {
            return Promise.resolve(memoryCached.vtt);
        }

        // 2. IDB
        return _leerDeIDB(vObj);
    };

    // ---- 11.3 srtAVtt ----

    VP.subtitulos.srtAVtt = function (srt) {
        if (typeof srt !== 'string' || !srt) return '';
        try {
            return _u.srtAVtt(srt);
        } catch (e) {
            log.warn('srtAVtt:', e);
            return '';
        }
    };

    // ---- 11.4 assAVtt ----

    VP.subtitulos.assAVtt = function (ass) {
        if (typeof ass !== 'string' || !ass) return '';
        try {
            return _u.assAVtt(ass);
        } catch (e) {
            log.warn('assAVtt:', e);
            return '';
        }
    };

    // ---- 11.4.bis subAVtt / lrcAVtt (nuevos, best-effort) ----

    VP.subtitulos.subAVtt = function (sub, fps) {
        if (typeof sub !== 'string' || !sub) return '';
        try { return _subAVttInterno(sub, fps); }
        catch (e) { log.warn('subAVtt:', e); return ''; }
    };

    VP.subtitulos.lrcAVtt = function (lrc) {
        if (typeof lrc !== 'string' || !lrc) return '';
        try { return _lrcAVttInterno(lrc); }
        catch (e) { log.warn('lrcAVtt:', e); return ''; }
    };

    // ---- 11.5 parsearCues ----

    VP.subtitulos.parsearCues = function (textoVtt) {
        if (typeof textoVtt !== 'string' || !textoVtt.trim()) return [];

        if (textoVtt.length > CFG.MAX_CHARS_PARSEO) {
            log.warn('parsearCues: archivo VTT demasiado grande, se omite.');
            return [];
        }

        var cues;
        try {
            cues = _u.parsearCuesVtt(textoVtt);
        } catch (e) {
            log.warn('parsearCues: parser externo falló, usando interno:', e);
            try { cues = _parsearCuesVttInterno(textoVtt); }
            catch (e2) { log.error('parsearCues:', e2); return []; }
        }

        if (!Array.isArray(cues) || cues.length === 0) {
            // Segundo intento con el parser interno (más tolerante)
            try {
                var alternativos = _parsearCuesVttInterno(textoVtt);
                if (alternativos.length) cues = alternativos;
            } catch (_) {}
        }

        return _normalizarCues(cues);
    };

    // ---- 11.6 procesarYCachear ----

    /**
     * Procesa el subtítulo de un video.
     * Encola el trabajo respetando la concurrencia máxima.
     *
     * @param {Object}  vObj
     * @param {number}  [prioridad=0] — 1 para video actual
     * @returns {Promise<string|null>}
     */
    VP.subtitulos.procesarYCachear = function (vObj, prioridad) {
        // ---- Validaciones de entrada ----
        if (!vObj) {
            log.warn('procesarYCachear: vObj es null/undefined.');
            return Promise.resolve(null);
        }

        if (!vObj.id) {
            log.warn('procesarYCachear: vObj.id faltante.');
            return Promise.resolve(null);
        }

        if (!vObj.subtitleFile) {
            return Promise.resolve(null);
        }

        if (!VP.features.fileReader) {
            log.warn('procesarYCachear: FileReader no disponible.');
            return Promise.resolve(null);
        }

        try {
            var archivo = vObj.subtitleFile;
            if (typeof archivo.name !== 'string' || !archivo.name) {
                return Promise.resolve(null);
            }
        } catch (e) {
            log.warn('procesarYCachear: acceso a subtitleFile:', e);
            return Promise.resolve(null);
        }

        // Delegar en la cola de procesamiento
        return _encolar(vObj, prioridad);
    };

    // ---- 11.7 adjuntar ----

    /**
     * Adjunta la pista de subtítulo al reproductor.
     * Flujo: caché → IDB → procesamiento FileReader.
     *
     * @param {Object}  vObj
     * @param {boolean} [esPrioridad=false]
     * @returns {Promise<void>}
     */
    VP.subtitulos.adjuntar = function (vObj, esPrioridad) {
        VP.subtitulos.limpiarPistas();

        if (!vObj || !vObj.subtitleFile) {
            var btnSub = VP.refs.subtitleBtn;
            if (!dom.esNulo(btnSub)) {
                btnSub.style.color = '';
            }
            return Promise.resolve();
        }

        var prioridad = esPrioridad ? 1 : 0;

        return VP.subtitulos.obtenerCacheado(vObj)
            .then(function (cacheado) {
                if (cacheado) return cacheado;
                return VP.subtitulos.procesarYCachear(vObj, prioridad);
            })
            .then(function (textoVtt) {
                if (!textoVtt) return;

                // Verificar que el video sigue siendo el actual ANTES
                // de tocar los cues globales. Antes se escribian aqui y
                // el guard venia despues, asi que una continuacion tardia
                // dejaba window.vpSubtitleCues con los cues del video
                // ya sustituido (y Mochi leia el subtitulo equivocado).
                if (!_esVideoCurrent(vObj.id)) {
                    log.debug(
                        'adjuntar: video ya no es actual →',
                        vObj.id
                    );
                    return;
                }

                // Cuando los datos vienen de caché, _exponerSiEsCurrent
                // no se ejecutó, restaurar cues globalmente
                var cacheado = _cacheGet(vObj.id);
                if (cacheado && Array.isArray(cacheado.cues)) {
                    window.vpSubtitleCues    = cacheado.cues;
                    window.vpSubtitleVersion =
                        (window.vpSubtitleVersion || 0) + 1;
                    window.vpSubtitleVideoId = vObj.id || '';

                    _emitirBus('subtitulosCargados', {
                        vObj    : vObj,
                        cues    : cacheado.cues,
                        formato : '',
                        version : window.vpSubtitleVersion,
                    });
                }

                var video = VP.refs.videoPlayer;
                if (dom.esNulo(video)) {
                    log.debug('adjuntar: no hay reproductor donde adjuntar.');
                    return;
                }

                // Aplicar desfase manual si lo hay
                var textoFinal = textoVtt;
                var desfase = _estado.desfases[vObj.id];
                if (typeof desfase === 'number' && desfase !== 0 &&
                    cacheado && Array.isArray(cacheado.cues)) {
                    try {
                        textoFinal = VP.subtitulos._cuesAVtt(
                            _desplazarCues(cacheado.cues, desfase)
                        );
                    } catch (_) { textoFinal = textoVtt; }
                }

                var url = _crearBlobUrl(vObj.id, textoFinal);
                if (!url) return;

                var pista = document.createElement('track');
                pista.kind     = 'subtitles';
                pista.srclang  = vObj.subtitleLang || CFG.IDIOMA_PISTA;
                pista.src      = url;
                pista.label    =
                    vObj.subtitleName ||
                    (vObj.subtitleFile && vObj.subtitleFile.name) ||
                    'Subtítulos';

                // Marcar para limpieza posterior
                pista._vpVideoId = vObj.id;

                pista.addEventListener('load', function () {
                    try {
                        pista.track.mode =
                            VP.estado.subtitulosActivos
                                ? 'showing'
                                : 'hidden';
                    } catch (_) {}

                    _actualizarBotonSubtitulo();
                    _emitirBus('subtitulosAdjuntados', {
                        vObj: vObj, url: url,
                    });
                });

                pista.addEventListener('error', function () {
                    // FIX: revocar SOLO la URL que esta pista capturo.
                    // Antes se revocaba por vObj.id, que apunta a la URL
                    // registrada actualmente: si entre la creacion de
                    // esta pista y su error se creo otra para el mismo
                    // video, este handler revocaba la de la pista nueva
                    // y la dejaba sin subtitulo.
                    if (_estado.blobUrls[vObj.id] === url) {
                        _revocarBlobUrl(vObj.id);
                    }
                    if (_estado.pistasActivas[vObj.id] === pista) {
                        delete _estado.pistasActivas[vObj.id];
                    }
                    log.warn(
                        'adjuntar: error al cargar pista:', url
                    );
                    _emitirBus('subtitulosError', {
                        vObj : vObj,
                        error: new Error('No se pudo cargar la pista'),
                    });
                });

                video.appendChild(pista);
                _estado.pistasActivas[vObj.id] = pista;
            })
            .catch(function (e) {
                log.warn('adjuntar:', e);
            });
    };

    // ---- 11.8 toggle ----

    async function _recuperarSubtituloDesdeDirectorio(vObj) {
        if (!vObj || vObj.subtitleFile || !VP.subtitulos?.buscarEnDirectorio) return false;

        var archivoHandle = VP.carga?.obtenerHandleArchivoSeleccionado?.(vObj) || null;
        var directorio = VP.runtime?.dirHandle || null;
        if (!directorio) {
            try {
                directorio = await VP.db?.obtenerDirectorio?.() || null;
            } catch (_) {}
        }

        async function buscar(handle) {
            if (!handle) return null;
            try {
                if (typeof handle.queryPermission === 'function') {
                    var permiso = await handle.queryPermission({ mode: 'read' });
                    if (permiso !== 'granted' && typeof handle.requestPermission === 'function') {
                        permiso = await handle.requestPermission({ mode: 'read' });
                    }
                    if (permiso !== 'granted') return null;
                }
                // Con un FileSystemFileHandle disponible, buscar solo en su
                // carpeta real. La búsqueda recursiva por nombre se reserva
                // para videos que llegaron sin handle, para evitar homónimos.
                if (archivoHandle && VP.subtitulos.buscarHermanoDeArchivo) {
                    var hermano = await VP.subtitulos.buscarHermanoDeArchivo(
                        archivoHandle,
                        handle,
                        _u.obtenerNombreBase(vObj.name)
                    );
                    if (hermano) return hermano;
                    // Si el handle no pertenece a este directorio, se intenta
                    // la búsqueda indexada como último recurso.
                }
                return await VP.subtitulos.buscarEnDirectorio(
                    _u.obtenerNombreBase(vObj.name), handle
                );
            } catch (e) {
                log.debug('No se pudo buscar el subtítulo en el directorio:', e);
                return null;
            }
        }

        var subtitulo = await buscar(directorio);
        if (!subtitulo?.file && typeof window.showDirectoryPicker === 'function') {
            try {
                var opciones = { mode: 'read' };
                if (directorio) opciones.startIn = directorio;
                try {
                    directorio = await window.showDirectoryPicker(opciones);
                } catch (eInicio) {
                    if (eInicio?.name === 'AbortError') return false;
                    delete opciones.startIn;
                    directorio = await window.showDirectoryPicker(opciones);
                }
                VP.runtime = VP.runtime || {};
                VP.runtime.dirHandle = directorio;
                Promise.resolve(VP.db?.guardarDirectorio?.(directorio)).catch(() => {});
                VP.subtitulos.invalidarIndiceDirectorio?.(directorio);
                subtitulo = await buscar(directorio);
            } catch (e) {
                if (e?.name !== 'AbortError') log.debug('No se pudo elegir la carpeta de subtítulos:', e);
                return false;
            }
        }

        if (!subtitulo?.file) return false;
        vObj.subtitleFile = subtitulo.file;
        vObj.subtitleName = subtitulo.name || subtitulo.file.name || null;
        _emitirBus('videoActualizado', vObj);
        return true;
    }

    function _recuperarSubtituloConSelectorCarpeta(vObj) {
        var input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.webkitdirectory = true;
        input.setAttribute('directory', '');
        input.style.position = 'fixed';
        input.style.left = '-10000px';
        input.style.opacity = '0';

        if (!('webkitdirectory' in input)) {
            _notificar('Este navegador no permite buscar subtítulos en una carpeta.', 'advertencia');
            return;
        }

        var cerrado = false;
        function cerrar() {
            if (cerrado) return;
            cerrado = true;
            try { input.remove(); } catch (_) {}
        }

        input.addEventListener('change', function () {
            var subtitulo = null;
            try {
                var indice = VP.subtitulos.crearIndiceArchivos(input.files || []);
                subtitulo = indice?.buscarPorNombreBase?.(
                    _u.obtenerNombreBase(vObj.name), ''
                ) || null;
            } catch (e) {
                log.warn('Selector de carpeta: indexado falló:', e);
            }
            cerrar();

            if (!subtitulo?.file) {
                _notificar('No se encontró un subtítulo con el mismo nombre en esa carpeta.', 'advertencia');
                return;
            }

            vObj.subtitleFile = subtitulo.file;
            vObj.subtitleName = subtitulo.name || subtitulo.file.name || null;
            _emitirBus('videoActualizado', vObj);
            VP.estado.subtitulosActivos = true;
            _emitirBus('subtitulosToggle', true);
            VP.subtitulos.adjuntar(vObj, true);
        }, { once: true });

        // Red de seguridad: si el usuario cancela, el input queda huérfano
        window.addEventListener('focus', function alCancelar() {
            window.removeEventListener('focus', alCancelar);
            _setTimeout(cerrar, 60000);
        }, { once: true });

        document.body.appendChild(input);
        try {
            input.click();
        } catch (e) {
            cerrar();
            log.warn('No se pudo abrir el selector de carpetas:', e);
            _notificar('No se pudo abrir el selector de carpetas.', 'error');
        }
    }

    /**
     * No se encontró un subtítulo local para el video.
     *
     * Si el módulo OpenSubtitles está disponible, se abre su ventana
     * para buscar y descargar uno. Si no está cargado (error de red al
     * cargar el script, etc.), se mantiene la notificación original
     * para no cambiar el comportamiento previo.
     *
     * @param {Object} vObj
     */
    function _ofrecerBusquedaOnline(vObj) {
        if (VP.opensubtitles &&
            typeof VP.opensubtitles.abrir === 'function') {
            _notificar(
                'No hay subtítulos locales. Busca uno en OpenSubtitles.',
                'info'
            );
            try {
                VP.opensubtitles.abrir(vObj);
            } catch (e) {
                log.warn('_ofrecerBusquedaOnline:', e);
                _notificar('No se pudo abrir OpenSubtitles', 'error');
            }
            return;
        }

        // Fallback: comportamiento original
        _notificar('No hay subtítulos disponibles', 'advertencia');
    }

    VP.subtitulos.toggle = function () {
        var video  = VP.refs.videoPlayer;
        var pistas;

        try {
            pistas = dom.esNulo(video) ? null : video.textTracks;
        } catch (_) {
            pistas = null;
        }

        // Sin pistas: intentar cargar
        if (!pistas || pistas.length === 0) {
            var idx     = VP.estado.currentVideoIndex;
            var lista   = Array.isArray(VP.estado.playlist)
                ? VP.estado.playlist
                : [];
            var vActual = lista[idx] || window.vpCurrentVideo || null;

            if (vActual && vActual.subtitleFile) {
                VP.estado.subtitulosActivos = true;
                _emitirBus('subtitulosToggle', true);
                VP.subtitulos.adjuntar(vActual, true);
            } else if (vActual) {
                if (typeof window.showDirectoryPicker !== 'function') {
                    _recuperarSubtituloConSelectorCarpeta(vActual);
                } else {
                    _recuperarSubtituloDesdeDirectorio(vActual).then(function (encontrado) {
                        if (encontrado) {
                            VP.estado.subtitulosActivos = true;
                            _emitirBus('subtitulosToggle', true);
                            VP.subtitulos.adjuntar(vActual, true);
                        } else {
                            _ofrecerBusquedaOnline(vActual);
                        }
                    }).catch(function (e) {
                        log.warn('No se pudo recuperar el subtítulo del video:', e);
                        _ofrecerBusquedaOnline(vActual);
                    });
                }
            } else {
                _notificar(
                    'No hay subtítulos disponibles', 'advertencia'
                );
            }
            return;
        }

        // Alternar estado
        VP.estado.subtitulosActivos = !VP.estado.subtitulosActivos;

        for (var i = 0; i < pistas.length; i++) {
            try {
                if (pistas[i].kind === 'subtitles' ||
                    pistas[i].kind === 'captions') {
                    pistas[i].mode =
                        VP.estado.subtitulosActivos
                            ? 'showing'
                            : 'hidden';
                }
            } catch (e) {
                log.debug('toggle: no se pudo cambiar el modo de pista:', e);
            }
        }

        _actualizarBotonSubtitulo();

        _notificar(
            VP.estado.subtitulosActivos
                ? 'Subtítulos activados'
                : 'Subtítulos desactivados',
            'info'
        );

        _emitirBus('subtitulosToggle', VP.estado.subtitulosActivos);
        log.debug(
            'Subtítulos:', VP.estado.subtitulosActivos ? 'ON' : 'OFF'
        );
    };

    // ---- 11.9 buscarEnDirectorio ----

    var _cacheIndiceDirectorios = typeof WeakMap === 'function' ? new WeakMap() : null;

    function _normalizarRutaArchivoSubtitulo(archivo) {
        if (!archivo || typeof archivo !== 'object') return null;
        var nombre = archivo.name || archivo.file?.name || '';
        var ruta = archivo.webkitRelativePath || archivo.relativePath || archivo.path || nombre;
        if (typeof ruta !== 'string' || !ruta.trim()) return null;

        try { ruta = ruta.normalize('NFC'); } catch (_) {}
        ruta = ruta.replace(/\\/g, '/').replace(/\/+/g, '/');
        var partes = ruta.split('/').filter(function (parte) {
            return parte && parte !== '.';
        });
        if (!partes.length) return null;

        var nombreRuta = partes.pop();
        var punto = nombreRuta.lastIndexOf('.');
        var extension = punto > 0 ? nombreRuta.slice(punto + 1).toLowerCase() : '';
        var base = punto > 0 ? nombreRuta.slice(0, punto) : nombreRuta;
        var dir = partes.join('/').toLowerCase();
        var archivoReal = archivo.file || (typeof archivo.size === 'number' ? archivo : null);

        return {
            base      : base.toLowerCase(),
            dir       : dir,
            extension : extension,
            file      : archivoReal,
            handle    : archivo.handle || null,
            name      : nombreRuta,
            path      : (dir ? dir + '/' : '') + nombreRuta.toLowerCase(),
        };
    }

    function _esExtensionSubtitulo(extension) {
        if (!extension) return false;
        extension = String(extension).toLowerCase();
        if (CFG.FORMATOS[extension]) return true;
        return _EXT_NORMALIZADAS.indexOf(extension) !== -1;
    }

    function _categoriaCoincidenciaSubtitulo(baseVideo, baseSubtitulo) {
        if (!baseVideo || !baseSubtitulo) return 0;
        if (baseVideo === baseSubtitulo) return 4;
        if (baseSubtitulo.indexOf(baseVideo) !== 0) return 0;

        var sufijo = baseSubtitulo.slice(baseVideo.length);
        if (!/^[._\s-]/.test(sufijo)) return 0;
        var tokens = sufijo.replace(/^[._\s-]+/, '').split(/[._\s-]+/).filter(Boolean);
        if (!tokens.length || tokens.length > 4) return 0;

        var normalizados = tokens.map(function (token) {
            try { return token.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
            catch (_) { return token.toLowerCase(); }
        });
        var variantesEspanol = ['es', 'spa', 'spanish', 'espanol', 'castellano', 'latam', 'latino', 'esp'];
        if (normalizados.some(function (token) {
            return variantesEspanol.indexOf(token) !== -1;
        })) return 3;

        var variantesValidas = /^(?:[a-z]{2,3}(?:[0-9]{3}|[-_][a-z]{2,4})?|forced|sdh|cc|hi|default|full|signs|songs|commentary)$/;
        return normalizados.every(function (token) { return variantesValidas.test(token); }) ? 1 : 0;
    }

    function _elegirSubtitulo(baseVideo, directorioVideo, candidatos, exigirUnico) {
        var puntuados = [];

        (candidatos || []).forEach(function (candidato) {
            if (!candidato) return;
            var categoria = _categoriaCoincidenciaSubtitulo(baseVideo, candidato.base);
            if (!categoria) return;
            var extIndex = _EXT_NORMALIZADAS.indexOf(candidato.extension);
            puntuados.push({
                candidato: candidato,
                categoria: categoria,
                prioridadExtension: extIndex < 0 ? 999 : extIndex,
            });
        });

        puntuados.sort(function (a, b) {
            if (a.categoria !== b.categoria) return b.categoria - a.categoria;
            if (a.prioridadExtension !== b.prioridadExtension) return a.prioridadExtension - b.prioridadExtension;
            return String(a.candidato.path).localeCompare(String(b.candidato.path));
        });

        if (!puntuados.length) return null;
        if (exigirUnico && puntuados.length > 1 &&
            puntuados[0].categoria === puntuados[1].categoria &&
            puntuados[0].prioridadExtension === puntuados[1].prioridadExtension) {
            return null;
        }
        return puntuados[0].candidato;
    }

    function _crearIndiceArchivos(archivos) {
        var lista = [];
        try {
            lista = Array.prototype.slice.call(archivos || []);
        } catch (_) {
            lista = Array.isArray(archivos) ? archivos.slice() : [];
        }

        var subtitulos = [];
        var cantidadVideosPorBase = Object.create(null);

        lista.forEach(function (archivo) {
            var info = _normalizarRutaArchivoSubtitulo(archivo);
            if (!info) return;
            if (_esExtensionSubtitulo(info.extension)) {
                info.file = info.file || archivo.file || (typeof archivo.size === 'number' ? archivo : null);
                info.handle = archivo.handle || null;
                subtitulos.push(info);
            } else if (util.esArchivoVideo && util.esArchivoVideo(archivo.name || '')) {
                cantidadVideosPorBase[info.base] = (cantidadVideosPorBase[info.base] || 0) + 1;
            }
        });

        // Índice por directorio para evitar filtrados O(n) repetidos
        var porDirectorio = Object.create(null);
        subtitulos.forEach(function (sub) {
            (porDirectorio[sub.dir] || (porDirectorio[sub.dir] = [])).push(sub);
        });

        function buscarParaVideo(video) {
            var infoVideo = _normalizarRutaArchivoSubtitulo(video);
            if (!infoVideo || !infoVideo.base) return null;

            // showOpenFilePicker y algunos file inputs omiten la ruta relativa.
            // Si la selección contiene videos homónimos, no hay forma segura
            // de saber a cuál carpeta pertenece un .srt también homónimo.
            if (!infoVideo.dir && cantidadVideosPorBase[infoVideo.base] > 1) return null;

            var locales = porDirectorio[infoVideo.dir] || [];
            var elegido = _elegirSubtitulo(infoVideo.base, infoVideo.dir, locales, false);
            if (!elegido && cantidadVideosPorBase[infoVideo.base] === 1) {
                elegido = _elegirSubtitulo(infoVideo.base, infoVideo.dir, subtitulos, true);
            }
            if (!elegido || !elegido.file) return null;
            return { file: elegido.file, name: elegido.name };
        }

        function buscarPorNombreBase(nombreBase, directorio) {
            var base = String(nombreBase || '').toLowerCase();
            if (!base) return null;
            try { base = base.normalize('NFC'); } catch (_) {}

            var dir = String(directorio || '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
            var locales = porDirectorio[dir] || [];
            var elegido = _elegirSubtitulo(base, dir, locales, false);
            if (!elegido) elegido = _elegirSubtitulo(base, dir, subtitulos, true);
            return elegido || null;
        }

        return {
            buscarParaVideo     : buscarParaVideo,
            buscarPorNombreBase : buscarPorNombreBase,
            // Extras informativos (no rompen nada)
            total               : subtitulos.length,
            directorios         : Object.keys(porDirectorio).length,
            listar              : function () { return subtitulos.slice(); },
        };
    }

    VP.subtitulos.crearIndiceArchivos = _crearIndiceArchivos;

    async function _leerIndiceDirectorio(dirHandle) {
        var archivos = [];
        var visitados = 0;
        var limiteEntradas = _num(VP.config.subLimiteEntradasDir, 25000, 100);
        var limiteProfundidad = _num(VP.config.subLimiteProfundidadDir, 16, 1, 64);

        async function recorrer(directorio, ruta, profundidad) {
            if (profundidad > limiteProfundidad || visitados >= limiteEntradas) return;
            var iterador;
            if (typeof directorio.values === 'function') iterador = directorio.values();
            else if (typeof directorio.entries === 'function') iterador = directorio.entries();
            else return;

            for await (var valor of iterador) {
                if (++visitados > limiteEntradas) break;
                var entrada = Array.isArray(valor) ? valor[1] : valor;
                var nombre = Array.isArray(valor) ? valor[0] : entrada?.name;
                if (!entrada || !nombre) continue;

                if (entrada.kind === 'file' && _esExtensionSubtitulo(String(nombre).split('.').pop().toLowerCase())) {
                    archivos.push({ name: nombre, relativePath: ruta + nombre, handle: entrada });
                } else if (entrada.kind === 'directory') {
                    try { await recorrer(entrada, ruta + nombre + '/', profundidad + 1); }
                    catch (e) { log.debug('No se pudo recorrer subcarpeta de subtítulos:', nombre, e); }
                }
            }
        }

        await recorrer(dirHandle, '', 0);
        if (visitados >= limiteEntradas) log.warn('Búsqueda de subtítulos limitada a', limiteEntradas, 'entradas.');
        return _crearIndiceArchivos(archivos);
    }

    function _obtenerIndiceDirectorio(dirHandle) {
        if (_cacheIndiceDirectorios && _cacheIndiceDirectorios.has(dirHandle)) {
            return _cacheIndiceDirectorios.get(dirHandle);
        }
        var promesa = _leerIndiceDirectorio(dirHandle).catch(function (e) {
            log.warn('No se pudo indexar la carpeta de subtítulos:', e);
            // No cachear el fallo: permitir reintento posterior
            try {
                if (_cacheIndiceDirectorios) _cacheIndiceDirectorios.delete(dirHandle);
            } catch (_) {}
            return _crearIndiceArchivos([]);
        });
        if (_cacheIndiceDirectorios) _cacheIndiceDirectorios.set(dirHandle, promesa);
        return promesa;
    }

    VP.subtitulos.invalidarIndiceDirectorio = function (dirHandle) {
        try {
            if (_cacheIndiceDirectorios && dirHandle) _cacheIndiceDirectorios.delete(dirHandle);
        } catch (_) {}
    };

    function _buscarSubtituloPorNombreExacto(nombreBase, dirHandle) {
        if (!dirHandle || typeof dirHandle.getFileHandle !== 'function') return Promise.resolve(null);
        if (!nombreBase) return Promise.resolve(null);

        var sufijos = ['', '_es', '.es', '-es', '_spa', '.spa', '-spa',
                       '.es-ES', '.spa-ES', '.esp', '_esp'];
        var extensiones = CFG.EXTENSIONES_SUB;
        var nombres = [];

        sufijos.forEach(function (sufijo) {
            extensiones.forEach(function (extension) {
                nombres.push(nombreBase + sufijo + extension);
            });
        });

        // Prioridad: el orden de `nombres` ya refleja la preferencia.
        return Promise.all(nombres.map(function (nombre) {
            return Promise.resolve().then(function () {
                return dirHandle.getFileHandle(nombre);
            }).then(function (handle) {
                return handle.getFile().then(function (file) {
                    return file ? { file: file, name: nombre } : null;
                });
            }).catch(function () { return null; });
        })).then(function (resultados) {
            for (var i = 0; i < resultados.length; i++) {
                if (resultados[i]) return resultados[i];
            }
            return null;
        }).catch(function (e) {
            log.debug('_buscarSubtituloPorNombreExacto:', e);
            return null;
        });
    }

    /**
     * Busca automáticamente el archivo de subtítulo de un video
     * en el directorio o subdirectorios asociados al video.
     *
     * @param {string}              nombreBase  - Nombre sin extensión
     * @param {FileSystemDirectoryHandle} dirHandle
     * @returns {Promise<{file: File, name: string}|null>}
     */
    VP.subtitulos.buscarEnDirectorio = function (nombreBase, dirHandle) {
        if (!dirHandle || typeof dirHandle !== 'object') {
            return Promise.resolve(null);
        }

        if (!nombreBase || typeof nombreBase !== 'string') {
            return Promise.resolve(null);
        }

        return _obtenerIndiceDirectorio(dirHandle).then(function (indice) {
            var elegido = indice.buscarPorNombreBase(nombreBase, '');
            if (!elegido || typeof elegido.handle?.getFile !== 'function') {
                return _buscarSubtituloPorNombreExacto(nombreBase, dirHandle);
            }
            return elegido.handle.getFile().then(function (archivo) {
                return archivo ? { file: archivo, name: elegido.name } : _buscarSubtituloPorNombreExacto(nombreBase, dirHandle);
            }).catch(function () {
                return _buscarSubtituloPorNombreExacto(nombreBase, dirHandle);
            });
        }).catch(function (e) {
            log.warn('buscarEnDirectorio:', e);
            return null;
        });
    };

    /**
     * Busca un subtítulo hermano del archivo elegido por el usuario.
     *
     * showOpenFilePicker devuelve un FileSystemFileHandle, pero no revela su
     * directorio padre. Solo se puede resolver el hermano si el usuario ya
     * concedió acceso a un directorio que contiene ese archivo. `resolve()`
     * comprueba esa relación y permite bajar al directorio exacto, evitando
     * asociar por error otro .srt homónimo de una carpeta distinta.
     *
     * @param {FileSystemFileHandle} archivoHandle
     * @param {FileSystemDirectoryHandle} directorioHandle
     * @param {string} nombreBase
     * @returns {Promise<{file: File, name: string}|null>}
     */
    VP.subtitulos.buscarHermanoDeArchivo = async function (archivoHandle, directorioHandle, nombreBase) {
        if (!archivoHandle || archivoHandle.kind !== 'file' ||
            !directorioHandle || directorioHandle.kind !== 'directory' ||
            typeof directorioHandle.resolve !== 'function' ||
            typeof directorioHandle.getDirectoryHandle !== 'function') {
            return null;
        }

        var base = String(nombreBase || '').trim();
        if (!base) return null;

        try {
            var rutaRelativa = await directorioHandle.resolve(archivoHandle);
            if (!Array.isArray(rutaRelativa) || !rutaRelativa.length) return null;

            var directorioVideo = directorioHandle;
            for (var i = 0; i < rutaRelativa.length - 1; i++) {
                directorioVideo = await directorioVideo.getDirectoryHandle(rutaRelativa[i]);
            }

            return await _buscarSubtituloPorNombreExacto(base, directorioVideo);
        } catch (e) {
            // Fuera del directorio autorizado, permisos vencidos, archivo
            // movido o una implementación parcial de la API: no adivinar.
            log.debug('No se pudo resolver un subtítulo junto al archivo:', e);
            return null;
        }
    };

    // ---- 11.10 exponerCues ----

    VP.subtitulos.exponerCues = function (cues, vObj) {
        var lista = Array.isArray(cues) ? cues : [];

        try {
            window.vpSubtitleCues    = lista;
            window.vpSubtitleVersion = (window.vpSubtitleVersion || 0) + 1;
            window.vpSubtitleVideoId = (vObj && vObj.id) || '';
        } catch (e) {
            log.warn('exponerCues: asignación global falló:', e);
        }

        _emitirEventoCues(lista, vObj, '', '');
    };

    // ---- 11.11 limpiarEstado ----

    VP.subtitulos.limpiarEstado = function () {
        VP.estado.subtitulosActivos = false;

        var btnSub = VP.refs.subtitleBtn;
        if (!dom.esNulo(btnSub)) {
            btnSub.style.color = '';
        }

        // Limpiar exposición global
        try {
            window.vpSubtitleCues    = [];
            window.vpSubtitleVersion = 0;
            window.vpSubtitleVideoId = '';
        } catch (_) {}

        VP.subtitulos.limpiarPistas();
        _emitirBus('subtitulosLimpiados');
    };

    // ---- 11.12 obtenerCueActivo ----

    /**
     * Búsqueda binaria del cue activo en el tiempo dado.
     * O(log n) vs O(n) del original — crítico con +500 videos.
     *
     * @param {number} tiempoActual
     * @returns {Object|null}
     */
    VP.subtitulos.obtenerCueActivo = function (tiempoActual) {
        var idx = VP.subtitulos.obtenerIndiceCueActivo(tiempoActual);
        if (idx < 0) return null;
        return window.vpSubtitleCues[idx] || null;
    };

    /**
     * Igual que obtenerCueActivo pero devuelve el índice (−1 si no hay).
     * Útil para renderizados incrementales sin comparar objetos.
     * @param {number} tiempoActual
     * @returns {number}
     */
    VP.subtitulos.obtenerIndiceCueActivo = function (tiempoActual) {
        var cues = window.vpSubtitleCues;

        if (!Array.isArray(cues) || cues.length === 0) return -1;
        if (typeof tiempoActual !== 'number' ||
            !isFinite(tiempoActual)) return -1;

        var tol = CFG.TOLERANCIA_CUE;

        // Los cues deben estar ordenados por inicio (postcondición
        // de parsearCues). Búsqueda binaria por inicio.
        //
        // FIX: con cues solapados, un cue anterior puede seguir activo
        // aunque la búsqueda binaria haya agotado el rango. La red de
        // seguridad anterior solo miraba 3 cues hacia atrás, así que con
        // solapes largos devolvía un cue equivocado o -1 aunque el
        // primero siguiera en pantalla.
        //
        // Se usa un índice de "fin máximo acumulado" (maxFinPrefijo):
        // maxFinPrefijo[i] = el mayor .fin entre los cues [0..i].
        // El primer cue que puede contener el tiempo es el primer índice
        // con maxFinPrefijo[i] >= tiempo. A partir de ahí, cualquier cue
        // anterior es descartable de forma segura.
        var maxFinPrefijo = _maxFinPrefijo(cues);

        var primero = _primerIndiceConFin(maxFinPrefijo, tiempoActual - tol);
        if (primero > cues.length - 1) return -1;

        var bajo = primero;
        var alto = cues.length - 1;
        var encontrado = -1;

        while (bajo <= alto) {
            var medio = (bajo + alto) >>> 1;
            var cue   = cues[medio];

            if (!cue) break;

            if (tiempoActual < cue.inicio - tol) {
                alto = medio - 1;

            } else if (tiempoActual > cue.fin + tol) {
                bajo = medio + 1;

            } else {
                // tiempoActual >= cue.inicio && tiempoActual <= cue.fin.
                // Con solapes puede haber otro cue activo antes: seguir
                // hacia atras para devolver el mas reciente que lo cubre.
                encontrado = medio;
                alto = medio - 1;
            }
        }

        if (encontrado >= 0) return encontrado;

        // Ninguno contiene el tiempo. Comprobar por si un cue que
        // empezó justo antes lo cubre (borde con tolerancia).
        for (var k = primero; k <= alto; k++) {
            var c = cues[k];
            if (c && tiempoActual >= c.inicio - tol &&
                     tiempoActual <= c.fin + tol) {
                return k;
            }
        }

        return -1;
    };

    /**
     * Construye (con memoización por array de cues) el índice de fines
     * máximos acumulados: maxFinPrefijo[i] = max(cues[0..i].fin).
     *
     * Se cachea en una WeakMap para no recalcularlo en cada frame.
     * @param {Array} cues
     * @returns {Float64Array}
     */
    var _cacheMaxFin = (typeof WeakMap === 'function') ? new WeakMap() : null;

    function _maxFinPrefijo(cues) {
        if (_cacheMaxFin) {
            var guardado = _cacheMaxFin.get(cues);
            if (guardado && guardado.length === cues.length) return guardado;
        }

        var arr = new Float64Array(cues.length);
        var max = -Infinity;
        for (var i = 0; i < cues.length; i++) {
            var f = cues[i] ? cues[i].fin : -Infinity;
            if (f > max) max = f;
            arr[i] = max;
        }

        if (_cacheMaxFin) _cacheMaxFin.set(cues, arr);
        return arr;
    }

    /**
     * Primer índice cuyo fin máximo acumulado alcanza `tiempo`.
     * @param {Float64Array} maxFinPrefijo
     * @param {number} tiempo
     * @returns {number}
     */
    function _primerIndiceConFin(maxFinPrefijo, tiempo) {
        var lo = 0;
        var hi = maxFinPrefijo.length;
        while (lo < hi) {
            var mid = (lo + hi) >>> 1;
            if (maxFinPrefijo[mid] < tiempo) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /**
     * Devuelve todos los cues que intersectan un rango [desde, hasta].
     * @param {number} desde
     * @param {number} hasta
     * @returns {Array}
     */
    VP.subtitulos.obtenerCuesEnRango = function (desde, hasta) {
        var cues = window.vpSubtitleCues;
        if (!Array.isArray(cues) || cues.length === 0) return [];

        desde = Number(desde);
        hasta = Number(hasta);
        if (!isFinite(desde) || !isFinite(hasta)) return [];
        if (hasta < desde) { var t = desde; desde = hasta; hasta = t; }

        var resultado = [];
        for (var i = 0; i < cues.length; i++) {
            var c = cues[i];
            if (!c) continue;
            if (c.inicio > hasta) break;
            if (c.fin >= desde) resultado.push(c);
        }
        return resultado;
    };

    /** Devuelve una copia segura de los cues actuales. */
    VP.subtitulos.obtenerCues = function () {
        return Array.isArray(window.vpSubtitleCues)
            ? window.vpSubtitleCues.slice()
            : [];
    };

    // ---- 11.13 buscarCues ----

    VP.subtitulos.buscarCues = function (texto, opciones) {
        var cues = window.vpSubtitleCues;

        if (!Array.isArray(cues)) return [];
        if (typeof texto !== 'string' || !texto) return [];

        opciones = opciones || {};
        var limite = _num(opciones.limite, Infinity, 1);

        var q = texto.toLowerCase().trim();
        if (!q) return [];

        // Normalización opcional de acentos (por defecto activa, no rompe:
        // amplía los resultados en lugar de reducirlos)
        var normalizar = opciones.ignorarAcentos !== false;

        function limpiar(s) {
            s = String(s).toLowerCase();
            if (!normalizar) return s;
            try {
                return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            } catch (_) { return s; }
        }

        var consulta   = limpiar(q);
        var resultados = [];

        for (var i = 0; i < cues.length; i++) {
            var cue = cues[i];
            if (!cue || !cue.texto) continue;

            var contenido = cue.texto.toLowerCase();
            if (contenido.indexOf(q) !== -1 ||
                (normalizar && limpiar(contenido).indexOf(consulta) !== -1)) {
                resultados.push(cue);
                if (resultados.length >= limite) break;
            }
        }

        return resultados;
    };

    // ---- 11.13.bis ajustarDesfase ----

    function _desplazarCues(cues, segundos) {
        if (!Array.isArray(cues)) return [];
        var d = Number(segundos) || 0;
        return cues.map(function (c) {
            return {
                inicio : Math.max(0, (c.inicio || 0) + d),
                fin    : Math.max(0, (c.fin || 0) + d),
                texto  : c.texto,
                raw    : c.raw,
                ajustes: c.ajustes || '',
            };
        });
    }

    /**
     * Ajusta el desfase (en segundos) de los subtítulos del video actual.
     * Positivo = los subtítulos aparecen más tarde.
     *
     * @param {number} segundos      Desplazamiento a aplicar
     * @param {boolean} [absoluto]   true = fijar valor, false = acumular
     * @returns {number} desfase total aplicado
     */
    VP.subtitulos.ajustarDesfase = function (segundos, absoluto) {
        var d = Number(segundos);
        if (!isFinite(d)) return 0;

        var vObj = window.vpCurrentVideo ||
            (Array.isArray(VP.estado.playlist)
                ? VP.estado.playlist[VP.estado.currentVideoIndex]
                : null);

        if (!vObj || !vObj.id) {
            log.warn('ajustarDesfase: no hay video actual.');
            return 0;
        }

        var actual = _estado.desfases[vObj.id] || 0;
        var nuevo  = absoluto ? d : (actual + d);
        _estado.desfases[vObj.id] = nuevo;

        // Reaplicar sobre los cues cacheados
        var entrada = _cacheGet(vObj.id);
        if (entrada && Array.isArray(entrada.cues)) {
            var base = _estado.cacheMemoria[vObj.id];
            if (base && !base.cuesOriginales) {
                base.cuesOriginales = entrada.cues;
            }
            var origen = (base && base.cuesOriginales) || entrada.cues;
            window.vpSubtitleCues    = _desplazarCues(origen, nuevo);
            window.vpSubtitleVersion = (window.vpSubtitleVersion || 0) + 1;

            _emitirBus('subtitulosDesfase', {
                vObj: vObj, desfase: nuevo,
            });
        }

        // Regenerar la pista para que el <track> refleje el desfase
                if (_estado.pistasActivas[vObj.id]) {
                    // FIX: window.vpCurrentVideo es una COPIA creada en
                    // _exponerVideoActivo y no incluye subtitleFile, asi que
                    // adjuntar() abortaba en su guarda y la pista nunca se
                    // regeneraba (el desfase no se veia en el video). Buscar el
                    // objeto real en la playlist, que si lleva el File.
                    var vReal = vObj;
                    try {
                        var lista = VP.estado.playlist;
                        var idxReal = VP.estado.currentVideoIndex;
                        if (Array.isArray(lista) && lista[idxReal] &&
                            lista[idxReal].id === vObj.id) {
                            vReal = lista[idxReal];
                        }
                    } catch (_) {}

                    if (!vReal.subtitleFile) {
                        // Sin archivo no se puede regenerar la pista: al menos
                        // avisar, en vez de fallar en silencio.
                        log.warn(
                            'ajustarDesfase: sin subtitleFile para',
                            vObj.id, '- la pista no se regenera.'
                        );
                    } else {
                        VP.subtitulos.adjuntar(vReal, true);
                    }
                }

        log.debug('ajustarDesfase:', vObj.id, '→', nuevo, 's');
        return nuevo;
    };

    /** Devuelve el desfase aplicado a un video (0 si ninguno). */
    VP.subtitulos.obtenerDesfase = function (videoId) {
        return _estado.desfases[videoId] || 0;
    };

    // ---- 11.14 exportar ----

    VP.subtitulos.exportar = function (formato) {
        var cues = window.vpSubtitleCues;

        if (!Array.isArray(cues) || cues.length === 0) {
            _notificar('No hay subtítulos para exportar', 'advertencia');
            return;
        }

        formato = (formato === 'srt') ? 'srt' : 'vtt';

        var contenido;
        try {
            contenido = (formato === 'srt')
                ? VP.subtitulos._cuesASrt(cues)
                : VP.subtitulos._cuesAVtt(cues);
        } catch (e) {
            log.error('exportar: conversión de cues:', e);
            _notificar('Error al preparar exportación', 'error');
            return;
        }

        if (!contenido) {
            _notificar('No hay contenido que exportar', 'advertencia');
            return;
        }

        try {
            var blob = new Blob([contenido], {
                type: 'text/plain;charset=utf-8',
            });
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');

            var nombreBase = '';
            try {
                var idx = VP.estado.currentVideoIndex;
                var vid = Array.isArray(VP.estado.playlist)
                    ? VP.estado.playlist[idx]
                    : null;
                if (vid && vid.name) {
                    nombreBase = _u.obtenerNombreBase(vid.name);
                }
            } catch (_) {}

            a.href     = url;
            a.download = _nombreArchivoSeguro(
                (nombreBase || 'subtitulos') + '.' + formato
            );
            a.rel      = 'noopener';
            a.style.display = 'none';

            document.body.appendChild(a);
            a.click();
            _u.eliminarElemento(a);

            _setTimeout(function () {
                try { URL.revokeObjectURL(url); } catch (_) {}
            }, 2000);

            _notificar(
                'Subtítulos exportados como .' + formato, 'exito'
            );

        } catch (e) {
            log.error('exportar:', e);
            _notificar('Error al exportar subtítulos', 'error');
        }
    };

    /** Elimina caracteres problemáticos de un nombre de archivo. */
    function _nombreArchivoSeguro(nombre) {
        return String(nombre)
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180) || 'subtitulos.vtt';
    }

    // ---- 11.15 inicializar ----

    VP.subtitulos.inicializar = function () {
        var btnSub = VP.refs.subtitleBtn;
        if (dom.esNulo(btnSub)) return;

        // Verificar que no se inicializó ya
        if (btnSub._vpSubInicialized) return;
        btnSub._vpSubInicialized = true;

        var manejador = _u.throttle(VP.subtitulos.toggle, 300);
        btnSub.addEventListener('click', manejador);

        // Accesibilidad básica (no altera el comportamiento existente)
        try {
            if (!btnSub.getAttribute('aria-label')) {
                btnSub.setAttribute('aria-label', 'Subtítulos');
            }
            btnSub.setAttribute(
                'aria-pressed',
                VP.estado.subtitulosActivos ? 'true' : 'false'
            );
        } catch (_) {}

        _estado.desuscriptores.push(function () {
            try { btnSub.removeEventListener('click', manejador); } catch (_) {}
            try { delete btnSub._vpSubInicialized; } catch (_) {}
        });

        log.debug('Botón de subtítulos inicializado.');
    };

    // ---- 11.16 preProcesarPlaylist ----

    /**
     * Pre-procesa los subtítulos de toda la playlist en background.
     * Usa la cola con prioridad baja para no interferir con el video
     * actual. Fundamental para la fluidez con +500 videos.
     *
     * @param {Array}  playlist
     * @param {number} [indiceActual=-1]
     */
    VP.subtitulos.preProcesarPlaylist = function (playlist, indiceActual) {
        if (!Array.isArray(playlist) || playlist.length === 0) return;
        if (_estado.destruido) return;

        indiceActual = (typeof indiceActual === 'number')
            ? indiceActual
            : -1;

        var sinSubtitulo = 0;
        var encolados    = 0;
        var yaEnCache    = 0;

        // Procesar los N más cercanos al actual primero
        var ordenados = _ordenarPorProximidad(playlist, indiceActual);

        ordenados.forEach(function (vObj) {
            if (!vObj || !vObj.subtitleFile || !vObj.id) {
                sinSubtitulo++;
                return;
            }

            // Si ya está en caché en memoria, saltar
            if (_cacheGet(vObj.id)) {
                yaEnCache++;
                return;
            }

            // Encolar con prioridad baja (0)
            _encolar(vObj, 0).catch(function (e) {
                log.warn(
                    'preProcesarPlaylist: error para →',
                    vObj.id, e
                );
            });

            encolados++;
        });

        log.info(
            'preProcesarPlaylist:',
            playlist.length, 'videos ·',
            encolados, 'encolados ·',
            yaEnCache, 'en caché ·',
            sinSubtitulo, 'sin subtítulo'
        );
    };

    /**
     * Ordena la playlist por proximidad al índice actual.
     * Intercala siguiente/anterior: actual+1, actual-1, actual+2 …
     * @param {Array}  playlist
     * @param {number} indiceActual
     * @returns {Array}
     */
    function _ordenarPorProximidad(playlist, indiceActual) {
        if (indiceActual < 0) return playlist.slice();

        var ordenados = [];
        var n = playlist.length;

        // El actual ya se procesa con prioridad alta en adjuntar()
        var delante = indiceActual + 1;
        var detras  = indiceActual - 1;

        while (delante < n || detras >= 0) {
            if (delante < n) {
                ordenados.push(playlist[delante]);
                delante++;
            }
            if (detras >= 0) {
                ordenados.push(playlist[detras]);
                detras--;
            }
        }

        return ordenados;
    }

    /**
     * Precarga el subtítulo de un video concreto con prioridad alta.
     * @param {Object} vObj
     * @returns {Promise<string|null>}
     */
    VP.subtitulos.precargar = function (vObj) {
        if (!vObj || !vObj.id || !vObj.subtitleFile) {
            return Promise.resolve(null);
        }
        var cacheado = _cacheGet(vObj.id);
        if (cacheado) return Promise.resolve(cacheado.vtt);
        return VP.subtitulos.procesarYCachear(vObj, 1);
    };

    // ---- 11.17 cancelarVideo ----

    /**
     * Cancela el procesamiento en vuelo de un video concreto.
     * @param {string} videoId
     */
    VP.subtitulos.cancelarVideo = function (videoId) {
        if (!videoId) return;

        var token = _obtenerToken(videoId);
        if (token) {
            token.cancelar();
            log.debug('cancelarVideo:', videoId);
        }

        // Eliminar de la cola si aún no ejecutó
        _estado.cola = _estado.cola.filter(function (t) {
            if (t.vObj && t.vObj.id === videoId) {
                _estado.metricas.cancelados++;
                t.resolver(null);
                return false;
            }
            return true;
        });

        _procesarCola();
    };

    // ---- 11.18 cancelarTodo ----

    /**
     * Cancela todos los trabajos en cola y en vuelo.
     * Usado durante shutdown o reset completo.
     */
    VP.subtitulos.cancelarTodo = function () {
        _estado.colaPausada = true;

        // Cancelar tokens
        Object.keys(_estado.abortTokens).forEach(function (id) {
            try { _estado.abortTokens[id].cancelar(); } catch (_) {}
        });

        // Resolver todos los trabajos en cola con null
        var pendientes = _estado.cola;
        _estado.cola = [];
        pendientes.forEach(function (t) {
            _estado.metricas.cancelados++;
            try { t.resolver(null); } catch (_) {}
        });

        log.info('cancelarTodo: cola vaciada (' + pendientes.length + ').');

        _setTimeout(function () {
            _estado.colaPausada = false;
            _procesarCola();
        }, 100);
    };

    /** Pausa la cola manualmente (los trabajos en vuelo siguen). */
    VP.subtitulos.pausarCola = function () {
        _estado.colaPausada = true;
        log.debug('Cola pausada.');
    };

    /** Reanuda la cola tras pausarCola(). */
    VP.subtitulos.reanudarCola = function () {
        if (!_estado.colaPausada) return;
        _estado.colaPausada = false;
        log.debug('Cola reanudada.');
        _procesarCola();
    };

    // ---- 11.19 invalidarCachePorId ----

    /**
     * Invalida el caché en memoria y señala IDB para un video.
     * @param {string} videoId
     */
    VP.subtitulos.invalidarCache = function (videoId) {
        if (!videoId) return;
        _cacheInvalidar(videoId);
        log.debug('invalidarCache:', videoId);
    };

    /** Vacía por completo el caché en memoria. */
    VP.subtitulos.limpiarCache = function () {
        _cacheLimpiar();
    };

    /** Purga sólo las entradas caducadas por TTL. */
    VP.subtitulos.purgarCache = function () {
        return _cachePurgarExpirado();
    };

    /** Estadísticas detalladas del caché. */
    VP.subtitulos.estadisticasCache = function () {
        var entradas = _estado.cacheLRUOrder.map(function (id) {
            var e = _estado.cacheMemoria[id];
            return {
                id   : id,
                hits : e ? e.hits : 0,
                bytes: e ? e.bytes : 0,
                cues : (e && e.cues) ? e.cues.length : 0,
                edadMs: e ? (Date.now() - e.ts) : 0,
            };
        });

        return {
            entradas    : entradas.length,
            capacidad   : CFG.CACHE_LRU_MAX,
            bytes       : _estado.cacheBytes,
            bytesMax    : CFG.CACHE_MAX_BYTES,
            ttlMs       : CFG.CACHE_TTL_MS,
            evicciones  : _estado.metricas.evicciones,
            detalle     : entradas,
        };
    };

    // ---- 11.20 obtenerMetricas ----

    /**
     * Devuelve un snapshot de las métricas internas.
     * @returns {Object}
     */
    VP.subtitulos.obtenerMetricas = function () {
        var m = _estado.metricas;

        return {
            procesados       : m.procesados,
            errores          : m.errores,
            cacheHits        : m.cacheHits,
            cacheMisses      : m.cacheMisses,
            colaActual       : _estado.cola.length,
            colaMax          : m.colaMax,
            vuelo            : _estado.colaEnEjecucion,
            tiempoMedioMs    :
                m.procesados > 0
                    ? Math.round(m.tiempoTotal / m.procesados)
                    : 0,
            cacheEntradas    : _estado.cacheLRUOrder.length,
            cacheCapacidad   : CFG.CACHE_LRU_MAX,
            blobUrlsActivos  : Object.keys(_estado.blobUrls).length,

            // ---- Métricas adicionales (v2.1.0) ----
            reintentos       : m.reintentos,
            cancelados       : m.cancelados,
            timeouts         : m.timeouts,
            evicciones       : m.evicciones,
            idbHits          : m.idbHits,
            idbEscrituras    : m.idbEscrituras,
            bytesLeidos      : m.bytesLeidos,
            cacheBytes       : _estado.cacheBytes,
            tasaAciertos     : (m.cacheHits + m.cacheMisses) > 0
                ? Math.round(
                    (m.cacheHits / (m.cacheHits + m.cacheMisses)) * 100
                  )
                : 0,
            pistasActivas    : Object.keys(_estado.pistasActivas).length,
            colaPausada      : _estado.colaPausada,
            version          : VERSION,
        };
    };

    /** Reinicia los contadores de métricas (no toca el caché). */
    VP.subtitulos.reiniciarMetricas = function () {
        Object.keys(_estado.metricas).forEach(function (k) {
            _estado.metricas[k] = 0;
        });
        log.debug('Métricas reiniciadas.');
    };

    // ---- 11.21 configurar ----

    /**
     * Ajusta configuración en caliente. Sólo se aplican claves conocidas
     * y valores válidos; el resto se ignora sin romper nada.
     * @param {Object} opciones
     * @returns {Object} configuración resultante
     */
    VP.subtitulos.configurar = function (opciones) {
        if (!opciones || typeof opciones !== 'object') {
            return VP.subtitulos.obtenerConfig();
        }

        var numericas = {
            MAX_CONCURRENTES   : [1, 64],
            CACHE_LRU_MAX      : [1, 100000],
            CACHE_MAX_BYTES    : [65536, Infinity],
            TIMEOUT_LECTURA_MS : [1000, Infinity],
            BACKOFF_BASE_MS    : [10, Infinity],
            BACKOFF_MAX_MS     : [100, Infinity],
            MAX_BYTES          : [1024, Infinity],
            MAX_CHARS_PARSEO   : [1024, Infinity],
            MAX_CUES           : [10, Infinity],
            LOTE_COLA          : [1, 1000],
            ENVEJECIMIENTO_MS  : [500, Infinity],
        };

        Object.keys(opciones).forEach(function (clave) {
            if (numericas[clave]) {
                CFG[clave] = _num(
                    opciones[clave], CFG[clave],
                    numericas[clave][0], numericas[clave][1]
                );
            } else if (clave === 'MAX_REINTENTOS') {
                var n = Number(opciones[clave]);
                if (isFinite(n) && n >= 0) CFG.MAX_REINTENTOS = Math.min(n, 10);
            } else if (clave === 'CACHE_TTL_MS' ||
                       clave === 'TOLERANCIA_CUE') {
                var v = Number(opciones[clave]);
                if (isFinite(v) && v >= 0) CFG[clave] = v;
            } else if (clave === 'PAUSAR_OCULTO' ||
                       clave === 'FALLBACK_LATIN1') {
                CFG[clave] = !!opciones[clave];
            } else if (clave === 'IDIOMA_PISTA' &&
                       typeof opciones[clave] === 'string' && opciones[clave]) {
                CFG.IDIOMA_PISTA = opciones[clave];
            }
        });

        _evictarSiNecesario(null);
        _procesarCola();

        return VP.subtitulos.obtenerConfig();
    };

    /** Snapshot de sólo lectura de la configuración activa. */
    VP.subtitulos.obtenerConfig = function () {
        var copia = {};
        Object.keys(CFG).forEach(function (k) {
            var v = CFG[k];
            copia[k] = Array.isArray(v) ? v.slice()
                     : (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v))
                     : v;
        });
        return copia;
    };

    // ---- 11.22 destruir ----

    /**
     * Apaga el módulo de forma ordenada: cancela trabajos, revoca
     * Blob-URLs, limpia caché, temporizadores y listeners.
     * Idempotente.
     */
    VP.subtitulos.destruir = function () {
        if (_estado.destruido) return;
        _estado.destruido = true;

        try { VP.subtitulos.cancelarTodo(); } catch (_) {}
        try { VP.subtitulos.limpiarPistas(); } catch (_) {}
        _revocarTodosBlobUrls();
        _cacheLimpiar();
        _limpiarTimers();

        _estado.desuscriptores.forEach(function (fn) {
            try { fn(); } catch (_) {}
        });
        _estado.desuscriptores = [];

        _estado.abortTokens = Object.create(null);
        _estado.enVuelo     = Object.create(null);
        _estado.desfases    = Object.create(null);
        _estado.colaPausada = false;

        log.info('vp-subtitulos.js: módulo destruido.');
    };

    // ============================================================
    // 12. CONVERSIÓN DE CUES A TEXTO
    // ============================================================

    VP.subtitulos._cuesAVtt = function (cues) {
        if (!Array.isArray(cues)) return 'WEBVTT\n\n';

        var partes = ['WEBVTT\n'];

        for (var i = 0; i < cues.length; i++) {
            var cue = cues[i];

            if (!cue || typeof cue.inicio !== 'number' ||
                typeof cue.fin !== 'number') continue;
            if (!isFinite(cue.inicio) || !isFinite(cue.fin)) continue;

            partes.push(
                '\n' +
                _segundosATimestamp(cue.inicio) +
                ' --> ' +
                _segundosATimestamp(cue.fin) +
                '\n' +
                (cue.raw || cue.texto || '') +
                '\n'
            );
        }

        return partes.join('');
    };

    VP.subtitulos._cuesASrt = function (cues) {
        if (!Array.isArray(cues)) return '';

        var partes = [];
        var numero = 1;

        for (var i = 0; i < cues.length; i++) {
            var cue = cues[i];

            if (!cue || typeof cue.inicio !== 'number' ||
                typeof cue.fin !== 'number') continue;
            if (!isFinite(cue.inicio) || !isFinite(cue.fin)) continue;

            partes.push(
                numero + '\n' +
                _segundosATimestampSrt(cue.inicio) +
                ' --> ' +
                _segundosATimestampSrt(cue.fin) +
                '\n' +
                (cue.raw || cue.texto || '') +
                '\n\n'
            );
            numero++;
        }

        return partes.join('');
    };

    // ============================================================
    // 13. HELPERS DE FORMATO DE TIEMPO
    // ============================================================

    function _segundosATimestamp(s) {
        s = Number(s);
        if (!isFinite(s) || s < 0) s = 0;

        var h   = Math.floor(s / 3600);
        var m   = Math.floor((s % 3600) / 60);
        var sec = Math.floor(s % 60);
        var ms  = Math.round((s - Math.floor(s)) * 1000);

        // Ajustar desbordamiento de ms
        if (ms >= 1000) { ms -= 1000; sec++; }
        if (sec >= 60)  { sec -= 60;  m++;   }
        if (m >= 60)    { m   -= 60;  h++;   }

        return _pad2(h)  + ':' +
               _pad2(m)  + ':' +
               _pad2(sec) + '.' +
               _pad3(ms);
    }

    function _segundosATimestampSrt(s) {
        return _segundosATimestamp(s).replace('.', ',');
    }

    function _pad2(n) {
        return n < 10 ? '0' + n : String(n);
    }

    function _pad3(n) {
        if (n < 10)  return '00' + n;
        if (n < 100) return '0'  + n;
        return String(n);
    }

    // Exponer helpers de tiempo para otros módulos (solo lectura práctica)
    VP.subtitulos._segundosATimestamp    = _segundosATimestamp;
    VP.subtitulos._segundosATimestampSrt = _segundosATimestampSrt;

    // ============================================================
    // 14. HELPERS INTERNOS
    // ============================================================

    function _actualizarBotonSubtitulo() {
        var btnSub = VP.refs.subtitleBtn;
        if (dom.esNulo(btnSub)) return;

        btnSub.style.color = VP.estado.subtitulosActivos
            ? 'var(--yt-red)'
            : '';

        try {
            btnSub.setAttribute(
                'aria-pressed',
                VP.estado.subtitulosActivos ? 'true' : 'false'
            );
        } catch (_) {}
    }

    function _notificar(mensaje, tipo) {
        if (VP.ui && typeof VP.ui.mostrarNotificacion === 'function') {
            try {
                VP.ui.mostrarNotificacion(mensaje, tipo);
            } catch (e) {
                log.warn('_notificar:', e);
            }
        } else {
            log.debug('[notificación ' + (tipo || 'info') + ']', mensaje);
        }
    }

    // ============================================================
    // 15. LISTENERS DEL BUS
    // ============================================================

    /** Registra un listener del bus y guarda su desuscriptor. */
    function _escuchar(evento, manejador) {
        try {
            var off = bus.on(evento, manejador);
            _estado.desuscriptores.push(function () {
                try {
                    if (typeof off === 'function') off();
                    else if (typeof bus.off === 'function') bus.off(evento, manejador);
                } catch (_) {}
            });
        } catch (e) {
            log.warn('No se pudo registrar el listener de', evento, e);
        }
    }

    _escuchar('videoLimpiado', function () {
        VP.subtitulos.limpiarEstado();
    });

    _escuchar('videoReproduciendo', function (vObj) {
        if (vObj && vObj.subtitleFile) {
            // Alta prioridad para el video actual
            VP.subtitulos.adjuntar(vObj, true);
        } else {
            VP.subtitulos.limpiarEstado();
        }
    });

    // Pre-procesar en background cuando cambia la playlist
    _escuchar('playlistCargada', function (datos) {
        var playlist = datos && datos.playlist
            ? datos.playlist
            : VP.estado.playlist;

        var indice = (datos && typeof datos.indice === 'number')
            ? datos.indice
            : VP.estado.currentVideoIndex;

        // Diferir para no bloquear la UI (idle si está disponible)
        var lanzar = function () {
            VP.subtitulos.preProcesarPlaylist(playlist, indice);
        };

        if (typeof window.requestIdleCallback === 'function') {
            try {
                window.requestIdleCallback(lanzar, { timeout: 1500 });
                return;
            } catch (_) {}
        }
        _setTimeout(lanzar, 200);
    });

    // Cancelar todo al destruir el reproductor
    _escuchar('reproductorDestruido', function () {
        VP.subtitulos.cancelarTodo();
        _revocarTodosBlobUrls();
        _cacheLimpiar();
        _limpiarTimers();

        // FIX: _limpiarTimers() mata el temporizador que reanuda la cola
        // en cancelarTodo(). Sin esto, _estado.colaPausada se quedaba en
        // true para siempre y la cola nunca procesaba nada mas, aunque
        // el modulo siguiera vivo (destruido == false).
        _estado.colaPausada = false;
    });

    // Invalidar caché si un archivo de video es reemplazado
    _escuchar('videoActualizado', function (vObj) {
        if (vObj && vObj.id) {
            VP.subtitulos.invalidarCache(vObj.id);
        }
    });

    // ---- Listeners de ciclo de vida de la página ----

    (function registrarListenersDocumento() {
        function alCambiarVisibilidad() {
            if (!CFG.PAUSAR_OCULTO) return;
            if (document.hidden) {
                _estado.colaPausada = true;
                log.debug('Cola pausada: pestaña oculta.');
            } else {
                _estado.colaPausada = false;
                _procesarCola();
            }
        }

        function alDescargar() {
            try { _revocarTodosBlobUrls(); } catch (_) {}
        }

        try {
            document.addEventListener('visibilitychange', alCambiarVisibilidad);
            window.addEventListener('pagehide', alDescargar);
            window.addEventListener('beforeunload', alDescargar);

            _estado.desuscriptores.push(function () {
                try { document.removeEventListener('visibilitychange', alCambiarVisibilidad); } catch (_) {}
                try { window.removeEventListener('pagehide', alDescargar); } catch (_) {}
                try { window.removeEventListener('beforeunload', alDescargar); } catch (_) {}
            });
        } catch (e) {
            log.debug('No se pudieron registrar listeners de documento:', e);
        }
    })();

    // ============================================================
    // 16. EXPOSICIÓN GLOBAL PARA MÓDULOS EXTERNOS
    // ============================================================

    if (window.vpSubtitleCues === undefined) {
        window.vpSubtitleCues = [];
    }

    if (window.vpSubtitleVersion === undefined) {
        window.vpSubtitleVersion = 0;
    }

    if (window.vpSubtitleVideoId === undefined) {
        window.vpSubtitleVideoId = '';
    }

    /** API pública para módulos externos y consola de depuración */
    window.vpSubtitulos = {
        version            : VERSION,

        toggle             : VP.subtitulos.toggle,
        obtenerCueActivo   : VP.subtitulos.obtenerCueActivo,
        obtenerIndiceCueActivo: VP.subtitulos.obtenerIndiceCueActivo,
        obtenerCuesEnRango : VP.subtitulos.obtenerCuesEnRango,
        buscarCues         : VP.subtitulos.buscarCues,
        exportar           : VP.subtitulos.exportar,
        cancelarVideo      : VP.subtitulos.cancelarVideo,
        cancelarTodo       : VP.subtitulos.cancelarTodo,
        invalidarCache     : VP.subtitulos.invalidarCache,
        limpiarCache       : VP.subtitulos.limpiarCache,
        purgarCache        : VP.subtitulos.purgarCache,
        preProcesarPlaylist: VP.subtitulos.preProcesarPlaylist,
        precargar          : VP.subtitulos.precargar,
        ajustarDesfase     : VP.subtitulos.ajustarDesfase,
        obtenerDesfase     : VP.subtitulos.obtenerDesfase,
        pausarCola         : VP.subtitulos.pausarCola,
        reanudarCola       : VP.subtitulos.reanudarCola,
        configurar         : VP.subtitulos.configurar,
        obtenerConfig      : VP.subtitulos.obtenerConfig,
        reiniciarMetricas  : VP.subtitulos.reiniciarMetricas,
        destruir           : VP.subtitulos.destruir,

        getCues: function () {
            return window.vpSubtitleCues || [];
        },

        getVersion: function () {
            return window.vpSubtitleVersion || 0;
        },

        getMetricas: function () {
            return VP.subtitulos.obtenerMetricas();
        },

        getCache: function () {
            return VP.subtitulos.estadisticasCache();
        },

        debugEstado: function () {
            return {
                cola         : _estado.cola.length,
                vuelo        : _estado.colaEnEjecucion,
                colaPausada  : _estado.colaPausada,
                cacheEntradas: _estado.cacheLRUOrder.length,
                cacheBytes   : _estado.cacheBytes,
                enVuelo      : Object.keys(_estado.enVuelo).length,
                blobUrls     : Object.keys(_estado.blobUrls).length,
                pistas       : Object.keys(_estado.pistasActivas).length,
                tokens       : Object.keys(_estado.abortTokens).length,
                timers       : _estado.timers.length,
                destruido    : _estado.destruido,
                metricas     : VP.subtitulos.obtenerMetricas(),
            };
        },

        // Acceso controlado al estado interno (sólo depuración)
        _estado: _estado,
    };

    // ============================================================
    // 17. VERIFICACIÓN DE MÓDULO
    // ============================================================

    (function verificarModulo() {
        var requeridos = [
            'limpiarPistas',
            'obtenerCacheado',
            'srtAVtt',
            'assAVtt',
            'parsearCues',
            'procesarYCachear',
            'adjuntar',
            'toggle',
            'buscarEnDirectorio',
            'buscarHermanoDeArchivo',
            'crearIndiceArchivos',
            'invalidarIndiceDirectorio',
            'exponerCues',
            'limpiarEstado',
            'obtenerCueActivo',
            'obtenerIndiceCueActivo',
            'obtenerCuesEnRango',
            'obtenerCues',
            'buscarCues',
            'exportar',
            'inicializar',
            'preProcesarPlaylist',
            'precargar',
            'cancelarVideo',
            'cancelarTodo',
            'pausarCola',
            'reanudarCola',
            'invalidarCache',
            'limpiarCache',
            'purgarCache',
            'estadisticasCache',
            'obtenerMetricas',
            'reiniciarMetricas',
            'ajustarDesfase',
            'obtenerDesfase',
            'configurar',
            'obtenerConfig',
            'destruir',
            '_cuesAVtt',
            '_cuesASrt',
        ];

        var faltantes = requeridos.filter(function (nombre) {
            return typeof VP.subtitulos[nombre] !== 'function';
        });

        if (faltantes.length > 0) {
            log.error(
                'vp-subtitulos.js: funciones faltantes →',
                faltantes.join(', ')
            );
        } else {
            log.debug(
                'vp-subtitulos.js: todas las funciones requeridas presentes.'
            );
        }
    })();

    // ============================================================
    // 18. LOG DE CARGA
    // ============================================================

    log.info(
        'vp-subtitulos.js v' + VERSION + ' cargado. ' +
        'Concurrencia: ' + CFG.MAX_CONCURRENTES +
        ' · Caché LRU: '  + CFG.CACHE_LRU_MAX +
        ' · Reintentos: '  + CFG.MAX_REINTENTOS +
        ' · Formatos: '    + Object.keys(CFG.FORMATOS).join('/')
    );

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-subtitulos.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document, window.performance || { now: Date.now.bind(Date) });
