'use strict';

// ============================================================
// VP-UTILIDADES.JS  v2.0
// Funciones puras reutilizables — Optimizado para 500+ videos.
// Depende únicamente de vp-base.js (debe cargarse antes).
// ============================================================

(function (window, document) {

    // ----------------------------------------------------------
    // GUARDIA INICIAL
    // ----------------------------------------------------------
    var VP = window.VP;
    if (!VP) {
        throw new Error('[VP] vp-utilidades.js: vp-base.js debe cargarse primero.');
    }
    VP.log.setContext('Util');

    // ----------------------------------------------------------
    // CONSTANTES INTERNAS (evitan reconstrucción en cada llamada)
    // ----------------------------------------------------------
    var NOOP       = function () {};
    var STR_EMPTY  = '';
    var REG_CRLF   = /\r\n|\r/g;
    var REG_BOM    = /^\uFEFF/;
    var REG_MULTI_NL = /\n{2,}/;
    var REG_COMMA_TS = /,(\d{3})/g;
    var REG_HTML_TAGS      = /<[^>]+>/g;
    var REG_VTT_TS_INLINE  = /<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g;
    var REG_SOLO_NUMERO    = /^\d+$/;
    var REG_ESPACIOS       = /\s+/g;
    var REG_PELIGRO        = /[;|&`$<>]/g;
    var REG_CONTROL        = /[\x00-\x1f\x7f]/g;

    /** Expresión regular VTT timestamp reutilizada en parse */
    var REG_VTT_TS = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})/;

    /** Expresión regular SRT timestamp */
    var REG_SRT_TS = /^(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3})/;

    /** Expresión regular ASS/SSA Dialogue */
    var REG_ASS_DIALOGUE = /^Dialogue:\s*\d+,(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2}),([^,]*),([^,]*),\d+,\d+,\d+,([^,]*),(.*)/;
    var REG_ASS_TS_FIX   = /\.(\d{2})$/;
    var REG_ASS_NEWLINE  = /\\N/g;
    var REG_ASS_OVERRIDE = /\{[^}]*\}/g;

    // HTML entities map (más rápido que múltiples replace encadenados)
    var HTML_ENTITIES = {
        '&amp;':  '&',
        '&lt;':   '<',
        '&gt;':   '>',
        '&nbsp;': '\u00a0',
        '&quot;': '"',
        '&#39;':  "'"
    };
    var REG_HTML_ENTITIES = /&(?:amp|lt|gt|nbsp|quot|#39);/g;

    function reemplazarEntidad(m) {
        return HTML_ENTITIES[m] || m;
    }

    // ----------------------------------------------------------
    // ALIAS DE FEATURES
    // VP.features.set existe en vp-base.js pero el código
    // interno usa VP.features.setNativo — definir el alias aquí.
    // ----------------------------------------------------------
    if (VP.features && VP.features.set !== undefined &&
        VP.features.setNativo === undefined) {
        VP.features.setNativo = VP.features.set;
    }

    // ----------------------------------------------------------
    // POOL DE OBJETOS: cues VTT (reduce GC en listas grandes)
    // ----------------------------------------------------------
    var _cuePool = [];
    var _CUE_POOL_MAX = 4096; // Ajustable según RAM objetivo

    function _adquirirCue() {
        return _cuePool.length ? _cuePool.pop() : {};
    }

    /**
     * Devuelve cues al pool una vez consumidos (llamar desde
     * el módulo que usa parsearCuesVtt cuando ya no los necesita).
     */
    VP.util.liberarCues = function (cues) {
        if (!Array.isArray(cues)) return;
        for (var i = 0, len = cues.length; i < len; i++) {
            var c = cues[i];
            if (!c) continue;
            c.inicio = c.fin = c.indice = 0;
            c.texto  = c.raw = STR_EMPTY;
            if (_cuePool.length < _CUE_POOL_MAX) {
                _cuePool.push(c);
            }
        }
        cues.length = 0;
    };

    // ============================================================
    // SECCIÓN 1 — ARRAYS Y OBJETOS
    // ============================================================

    /**
     * Comprueba si `val` existe en `arr`.
     * Usa indexOf nativo si disponible; fallback manual para IE.
     */
    VP.util.incluye = function (arr, val) {
        if (!Array.isArray(arr)) return false;
        return arr.indexOf(val) !== -1;
    };

    VP.util.eliminarDeArray = function (arr, val) {
        if (!Array.isArray(arr)) return false;
        var i = arr.indexOf(val);
        if (i !== -1) arr.splice(i, 1);
        return i !== -1;
    };

    /**
     * Mezcla N objetos en `destino`.
     */
    VP.util.asignarObjeto = function (destino) {
        if (destino === null || destino === undefined) destino = {};
        for (var a = 1; a < arguments.length; a++) {
            var src = arguments[a];
            if (!src || typeof src !== 'object') continue;
            var claves = Object.keys(src);
            for (var k = 0, kl = claves.length; k < kl; k++) {
                destino[claves[k]] = src[claves[k]];
            }
        }
        return destino;
    };

    VP.util.clonarObjeto = function (obj) {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj !== 'object') return obj;
        try {
            return JSON.parse(JSON.stringify(obj));
        } catch (_) {
            return VP.util.asignarObjeto({}, obj);
        }
    };

    /**
     * Elimina duplicados de un array (primitivos).
     * Usa Set si disponible; fallback con objeto hash.
     */
    VP.util.unicosDeArray = function (arr) {
        if (!Array.isArray(arr)) return [];
        if (VP.features.setNativo) {
            try { return Array.from(new Set(arr)); } catch (_) {}
        }
        var visto   = {};
        var res     = [];
        for (var i = 0, len = arr.length; i < len; i++) {
            var k = String(arr[i]);
            if (!visto[k]) { visto[k] = true; res.push(arr[i]); }
        }
        return res;
    };

    /**
     * Ordena un array de objetos por una clave numérica o de cadena.
     * No muta el original; devuelve nueva referencia.
     */
    VP.util.ordenarPor = function (arr, clave, desc) {
        if (!Array.isArray(arr)) return [];
        var copia = arr.slice();
        copia.sort(function (a, b) {
            var av = a ? a[clave] : undefined;
            var bv = b ? b[clave] : undefined;
            if (av === bv) return 0;
            var res = av < bv ? -1 : 1;
            return desc ? -res : res;
        });
        return copia;
    };

    /**
     * Agrupa un array de objetos por valor de una clave.
     */
    VP.util.agruparPor = function (arr, clave) {
        if (!Array.isArray(arr)) return {};
        var resultado = Object.create(null);
        for (var i = 0, len = arr.length; i < len; i++) {
            var item = arr[i];
            if (!item) continue;
            var gk = String(item[clave] !== undefined ? item[clave] : '_sin_clave_');
            if (!resultado[gk]) resultado[gk] = [];
            resultado[gk].push(item);
        }
        return resultado;
    };

    /**
     * Trocea un array en sub-arrays de tamaño `tam`.
     */
    VP.util.trocearArray = function (arr, tam) {
        if (!Array.isArray(arr)) return [];
        tam = (tam > 0 ? tam : 50) | 0;
        var trozos = [];
        for (var i = 0, len = arr.length; i < len; i += tam) {
            trozos.push(arr.slice(i, i + tam));
        }
        return trozos;
    };

    // ============================================================
    // SECCIÓN 2 — PROCESAMIENTO POR LOTES (BATCH)
    // ============================================================

    /**
     * Procesa `items` en lotes con pausa entre cada uno.
     */
    VP.util.procesarEnLotes = function (items, fnProcesar, opciones) {
        if (!Array.isArray(items) || typeof fnProcesar !== 'function') {
            VP.log.warn('procesarEnLotes: argumentos inválidos.');
            return;
        }
        var op = VP.util.asignarObjeto({
            tamLote:    50,
            pausaMs:    0,
            onProgreso: NOOP,
            onFin:      NOOP,
            onError:    NOOP,
            señal:      null
        }, opciones || {});

        var total   = items.length;
        var indice  = 0;
        var errores = [];
        var tamLote = Math.max(1, op.tamLote | 0);

        function procesarLote() {
            if (op.señal && op.señal.cancelado) {
                op.onFin(errores);
                return;
            }

            var limite = Math.min(indice + tamLote, total);

            while (indice < limite) {
                try {
                    fnProcesar(items[indice], indice);
                } catch (err) {
                    errores.push({ indice: indice, error: err });
                    try { op.onError(err, items[indice], indice); } catch (_) {}
                }
                indice++;
            }

            try { op.onProgreso(indice, total); } catch (_) {}

            if (indice >= total) {
                op.onFin(errores);
                return;
            }

            if (op.pausaMs > 0) {
                setTimeout(procesarLote, op.pausaMs);
            } else if (VP.features.idleCallback) {
                requestIdleCallback(procesarLote, { timeout: 1000 });
            } else {
                setTimeout(procesarLote, 0);
            }
        }

        setTimeout(procesarLote, 0);
    };

    /**
     * Versión Promise de procesarEnLotes.
     */
    VP.util.procesarEnLotesAsync = function (items, fnProcesar, opciones) {
        if (typeof Promise === 'undefined') {
            VP.util.procesarEnLotes(items, fnProcesar, opciones);
            return null;
        }
        return new Promise(function (resolve, reject) {
            var op2 = VP.util.asignarObjeto({}, opciones || {}, {
                onFin: function (errs) {
                    if (errs && errs.length && opciones && opciones.fallarConError) {
                        reject(errs);
                    } else {
                        resolve(errs);
                    }
                }
            });
            VP.util.procesarEnLotes(items, fnProcesar, op2);
        });
    };

    // ============================================================
    // SECCIÓN 3 — ARCHIVOS Y EXTENSIONES
    // ============================================================

    var _cacheExt      = Object.create(null);
    var _CACHE_EXT_MAX = 2048;
    var _cacheExtCount = 0;

    VP.util.obtenerExtension = function (nombre) {
        if (!nombre || typeof nombre !== 'string') return STR_EMPTY;

        var cached = _cacheExt[nombre];
        if (cached !== undefined) return cached;

        var d   = nombre.lastIndexOf('.');
        var ext = d >= 0 ? nombre.slice(d).toLowerCase() : STR_EMPTY;

        if (_cacheExtCount < _CACHE_EXT_MAX) {
            _cacheExt[nombre] = ext;
            _cacheExtCount++;
        }
        return ext;
    };

    VP.util.limpiarCacheExtension = function () {
        _cacheExt      = Object.create(null);
        _cacheExtCount = 0;
    };

    var _cacheEsVideo = Object.create(null);

    VP.util.esArchivoVideo = function (nombre) {
        if (!nombre) return false;
        var c = _cacheEsVideo[nombre];
        if (c !== undefined) return c;
        var r = VP.util.incluye(
            VP.config.extensionesVideo,
            VP.util.obtenerExtension(nombre)
        );
        _cacheEsVideo[nombre] = r;
        return r;
    };

    VP.util.esArchivoSubtitulo = function (nombre) {
        return VP.util.incluye(
            VP.config.extensionesSub,
            VP.util.obtenerExtension(nombre)
        );
    };

    VP.util.obtenerNombreBase = function (nombre) {
        var s = nombre ? String(nombre) : STR_EMPTY;
        var d = s.lastIndexOf('.');
        return d > 0 ? s.substring(0, d) : s;
    };

    VP.util.sanitizarNombreArchivo = function (nombre) {
        if (!nombre || typeof nombre !== 'string') return '_desconocido_';
        var r = nombre
            .replace(REG_PELIGRO, '_')
            .replace(REG_CONTROL, STR_EMPTY)
            .trim();
        return r || '_sin_nombre_';
    };

    VP.util.mapearArchivosPorBase = function (listaArchivos) {
        if (!Array.isArray(listaArchivos)) return Object.create(null);

        var mapa = Object.create(null);

        for (var i = 0, len = listaArchivos.length; i < len; i++) {
            var arch = listaArchivos[i];
            if (!arch || !arch.name) continue;

            var nombre = arch.name;
            var base   = VP.util.obtenerNombreBase(nombre);

            if (VP.util.esArchivoVideo(nombre)) {
                if (!mapa[base]) mapa[base] = { video: null, subs: [] };
                mapa[base].video = arch;
            } else if (VP.util.esArchivoSubtitulo(nombre)) {
                if (!mapa[base]) mapa[base] = { video: null, subs: [] };
                mapa[base].subs.push(arch);
            }
        }
        return mapa;
    };

    // ============================================================
    // SECCIÓN 4 — NÚMEROS Y RANGOS
    // ============================================================

    VP.util.clampNum = function (v, mn, mx) {
        var n = +v;
        if (n !== n) return mn;
        return n < mn ? mn : n > mx ? mx : n;
    };

    VP.util.clampInt = function (v, mn, mx) {
        return Math.round(VP.util.clampNum(v, mn, mx));
    };

    VP.util.parsearEntero = function (v, porDefecto) {
        var n = v | 0;
        if (n === 0 && v !== 0 && v !== '0') {
            n = parseInt(v, 10);
            return isNaN(n) ? (porDefecto | 0) : n;
        }
        return n;
    };

    VP.util.parsearDecimal = function (v, porDefecto) {
        var n = +v;
        return (n !== n) ? (porDefecto || 0) : n;
    };

    // ============================================================
    // SECCIÓN 5 — FORMATO DE TIEMPO Y TAMAÑO
    // ============================================================

    var _cacheTiempo = Object.create(null);

    VP.util.formatearTiempo = function (s) {
        if (!isFinite(s) || s < 0) return '0:00';
        s = s | 0;

        var cached = _cacheTiempo[s];
        if (cached) return cached;

        var h   = (s / 3600) | 0;
        var m   = ((s % 3600) / 60) | 0;
        var sec = s % 60;
        var mm  = (h > 0 && m < 10) ? '0' + m : ('' + m);
        var ss  = sec < 10 ? '0' + sec : ('' + sec);
        var res = h > 0
            ? h + ':' + mm + ':' + ss
            : m + ':' + ss;

        if (s <= 86400) _cacheTiempo[s] = res;
        return res;
    };

    VP.util.limpiarCacheTiempo = function () {
        _cacheTiempo = Object.create(null);
    };

    VP.util.formatearDuracion = function (segundos) {
        if (!isFinite(segundos) || segundos < 0) return STR_EMPTY;
        var s = +segundos;
        if (s < 60)   return (s | 0) + 's';
        if (s < 3600) return ((s / 60) | 0) + 'm ' + Math.round(s % 60) + 's';
        return ((s / 3600) | 0) + 'h ' + (((s % 3600) / 60) | 0) + 'm';
    };

    VP.util.formatearTamano = function (bytes) {
        var b = +bytes;
        if (!b || b <= 0 || b !== b) return STR_EMPTY;
        if (b < 1024)       return b + ' B';
        if (b < 1048576)    return (b / 1024).toFixed(1) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
    };

    // ============================================================
    // SECCIÓN 6 — GENERADOR DE IDs ÚNICOS
    // ============================================================

    (function () {
        var _ts_prev    = 0;
        var _ts_seq     = 0;
        var _global_seq = 0;
        var _HEX_POOL   = '0123456789abcdef';

        function _hex4() {
            var n = (Math.random() * 0x10000) | 0;
            return _HEX_POOL[(n >> 12) & 15] +
                   _HEX_POOL[(n >>  8) & 15] +
                   _HEX_POOL[(n >>  4) & 15] +
                   _HEX_POOL[ n        & 15];
        }

        VP.util.generarId = function () {
            _global_seq++;
            var ts = Date.now();

            if (ts === _ts_prev) {
                _ts_seq++;
            } else {
                _ts_prev = ts;
                _ts_seq  = 0;
            }

            var base = ts.toString(36) + '-' +
                       _global_seq.toString(36) + '-' +
                       _ts_seq.toString(36);

            if (VP.features.crypto) {
                try {
                    var u = new Uint32Array(2);
                    crypto.getRandomValues(u);
                    return base + '-' + ((u[0] ^ u[1]) >>> 0).toString(36);
                } catch (_) {}
            }
            return base + '-' + _hex4() + _hex4();
        };
    })();

    // ============================================================
    // SECCIÓN 7 — HTML Y TEXTO
    // ============================================================

    var _ESCAPE_MAP = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    var REG_ESCAPE_HTML = /[&<>"']/g;

    function _escaparCaracter(c) {
        return _ESCAPE_MAP[c] || c;
    }

    VP.util.escaparHTML = function (str) {
        if (str === null || str === undefined) return STR_EMPTY;
        return String(str).replace(REG_ESCAPE_HTML, _escaparCaracter);
    };

    VP.util.ajustarColor = function (hex, cantidad) {
        if (!hex || typeof hex !== 'string') return '#ff0033';
        var h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
        if (h.length === 3) {
            h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        }
        var n = parseInt(h, 16);
        if (isNaN(n)) return hex;
        var r  = VP.util.clampNum((n >> 16)         + cantidad, 0, 255) | 0;
        var g  = VP.util.clampNum(((n >> 8) & 0xFF) + cantidad, 0, 255) | 0;
        var bv = VP.util.clampNum((n & 0xFF)         + cantidad, 0, 255) | 0;
        return '#' + (0x1000000 + (r << 16) + (g << 8) + bv)
            .toString(16).slice(1);
    };

    VP.util.truncarTexto = function (texto, maxChars) {
        if (!texto || typeof texto !== 'string') return STR_EMPTY;
        maxChars = maxChars > 0 ? maxChars : 60;
        if (texto.length <= maxChars) return texto;
        var corte = texto.lastIndexOf(' ', maxChars - 1);
        return (corte > 0 ? texto.slice(0, corte) : texto.slice(0, maxChars)) + '…';
    };

    VP.util.normalizarBusqueda = function (str) {
        if (!str || typeof str !== 'string') return STR_EMPTY;
        var s = str.toLowerCase().replace(REG_ESPACIOS, ' ').trim();
        if (typeof s.normalize === 'function') {
            s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, STR_EMPTY);
        }
        return s;
    };

    VP.util.filtrarLista = function (lista, termino, claves) {
        if (!Array.isArray(lista) || !termino) return lista || [];
        var t = VP.util.normalizarBusqueda(termino);
        if (!t) return lista;

        var ks = Array.isArray(claves) ? claves : [claves || 'nombre'];

        return lista.filter(function (item) {
            if (!item) return false;
            for (var k = 0, kl = ks.length; k < kl; k++) {
                var val = item[ks[k]];
                if (val && VP.util.normalizarBusqueda(String(val)).indexOf(t) !== -1) {
                    return true;
                }
            }
            return false;
        });
    };

    // ============================================================
    // SECCIÓN 8 — CONVERSORES DE SUBTÍTULOS
    // ============================================================

    VP.util.srtAVtt = function (srt) {
        if (!srt || typeof srt !== 'string') return 'WEBVTT\n\n';

        var norm = srt
            .replace(REG_BOM,    STR_EMPTY)
            .replace(REG_CRLF,   '\n')
            .trim();

        if (!norm) return 'WEBVTT\n\n';

        var bloques = norm.split(REG_MULTI_NL);
        var partes  = new Array(bloques.length + 1);
        partes[0]   = 'WEBVTT\n';
        var pIdx    = 1;

        for (var b = 0, bl = bloques.length; b < bl; b++) {
            var bloque = bloques[b].trim();
            if (!bloque) continue;

            var lineas = bloque.split('\n');
            var tiIdx  = -1;

            for (var l = 0, ll = lineas.length; l < ll; l++) {
                if (REG_SRT_TS.test(lineas[l].trim())) { tiIdx = l; break; }
            }

            if (tiIdx < 0) continue;

            var lineaTs = lineas[tiIdx].trim().replace(REG_COMMA_TS, '.$1');
            var cuerpo  = STR_EMPTY;

            for (var i = tiIdx + 1; i < lineas.length; i++) {
                var tl = lineas[i].trim();
                if (tl) cuerpo += tl + '\n';
            }

            if (!cuerpo) continue;
            partes[pIdx++] = '\n' + lineaTs + '\n' + cuerpo;
        }

        partes.length = pIdx;
        return partes.join(STR_EMPTY) + '\n';
    };

    VP.util.assAVtt = function (ass) {
        if (!ass || typeof ass !== 'string') return 'WEBVTT\n\n';

        var lineas = ass.replace(REG_CRLF, '\n').split('\n');
        var partes = ['WEBVTT\n'];

        for (var i = 0, len = lineas.length; i < len; i++) {
            var m = REG_ASS_DIALOGUE.exec(lineas[i]);
            if (!m) continue;

            var s   = m[1].replace(REG_ASS_TS_FIX, '.$10');
            var e   = m[2].replace(REG_ASS_TS_FIX, '.$10');
            var txt = m[6]
                .replace(REG_ASS_NEWLINE,  '\n')
                .replace(REG_ASS_OVERRIDE, STR_EMPTY)
                .trim();

            if (!txt) continue;
            partes.push('\n' + s + ' --> ' + e + '\n' + txt + '\n');
        }

        return partes.join(STR_EMPTY) + '\n';
    };

    // ============================================================
    // SECCIÓN 9 — PARSER DE CUES VTT
    // ============================================================

    function _seg(h, m, s, ms) {
        return ((+h || 0) * 3600) +
               ((+m || 0) * 60)   +
               ( +s || 0)          +
               ((+ms || 0) / 1000);
    }

    function _limpiarCue(raw) {
        if (!raw) return STR_EMPTY;
        return raw
            .replace(REG_VTT_TS_INLINE, STR_EMPTY)
            .replace(REG_HTML_TAGS,     STR_EMPTY)
            .replace(REG_HTML_ENTITIES, reemplazarEntidad)
            .replace(REG_ESPACIOS,      ' ')
            .trim();
    }

    VP.util.parsearCuesVtt = function (textoVtt) {
        if (!textoVtt || typeof textoVtt !== 'string') return [];

        var lineas;
        try {
            lineas = textoVtt
                .replace(REG_BOM,  STR_EMPTY)
                .replace(REG_CRLF, '\n')
                .split('\n');
        } catch (e) {
            VP.log.warn('parsearCuesVtt — preprocesado falló:', e);
            return [];
        }

        var totalLineas = lineas.length;
        var cues        = [];
        var i           = 0;

        while (i < totalLineas && lineas[i].indexOf('WEBVTT') === -1) i++;
        i++;

        while (i < totalLineas) {
            var linea;
            try { linea = lineas[i].trim(); }
            catch (_) { i++; continue; }

            var m = REG_VTT_TS.exec(linea);
            if (!m) { i++; continue; }

            var inicio, fin;
            try {
                inicio = _seg(m[1], m[2], m[3], m[4]);
                fin    = _seg(m[5], m[6], m[7], m[8]);
            } catch (_) { i++; continue; }

            if (!isFinite(inicio) || !isFinite(fin) || fin <= inicio) {
                i++; continue;
            }

            i++;

            var rawPartes  = [];
            var limpPartes = [];

            while (i < totalLineas) {
                var tl;
                try { tl = lineas[i].trim(); }
                catch (_) { i++; break; }

                if (tl === STR_EMPTY) break;

                if (REG_SOLO_NUMERO.test(tl)) { i++; continue; }

                rawPartes.push(tl);
                var limpio = _limpiarCue(tl);
                if (limpio) limpPartes.push(limpio);
                i++;
            }

            if (limpPartes.length === 0) continue;

            var textoUnido = limpPartes.join(' ');

            var ultimo = cues.length ? cues[cues.length - 1] : null;
            if (ultimo && ultimo.texto === textoUnido &&
                Math.abs(ultimo.fin - inicio) < 0.1) continue;

            var cue    = _adquirirCue();
            cue.inicio = inicio;
            cue.fin    = fin;
            cue.texto  = textoUnido;
            cue.raw    = rawPartes.join('\n');
            cue.indice = cues.length;

            cues.push(cue);
        }

        return cues;
    };

    VP.util.cueActivoEn = function (cues, tiempo) {
        if (!Array.isArray(cues) || cues.length === 0) return null;

        var bajo  = 0;
        var alto  = cues.length - 1;
        var found = null;

        while (bajo <= alto) {
            var mid = (bajo + alto) >>> 1;
            var c   = cues[mid];

            if (tiempo >= c.inicio && tiempo <= c.fin) {
                found = c;
                break;
            } else if (tiempo < c.inicio) {
                alto = mid - 1;
            } else {
                bajo = mid + 1;
            }
        }

        return found;
    };

    VP.util.cuesEnRango = function (cues, t0, t1) {
        if (!Array.isArray(cues) || cues.length === 0) return [];
        if (!isFinite(t0) || !isFinite(t1) || t1 < t0) return [];

        var bajo = 0, alto = cues.length - 1, inicio = cues.length;

        while (bajo <= alto) {
            var mid = (bajo + alto) >>> 1;
            if (cues[mid].fin >= t0) { inicio = mid; alto = mid - 1; }
            else                      { bajo = mid + 1; }
        }

        var res = [];
        for (var i = inicio; i < cues.length; i++) {
            if (cues[i].inicio > t1) break;
            res.push(cues[i]);
        }
        return res;
    };

    // ============================================================
    // SECCIÓN 10 — ALMACENAMIENTO PERSISTENTE (IndexedDB keyval)
    // ============================================================

    var _LS_QUOTA_BYTES = VP.config.maxStorageItemBytes || (4 * 1024 * 1024);

    function _estimarBytesTexto(txt) {
        return String(txt || '').length * 2;
    }

    VP.util.guardarItem = function (clave, valor) {
        if (clave === null || clave === undefined || clave === STR_EMPTY) return false;
        try {
            var serializado = JSON.stringify(valor);
            if (_estimarBytesTexto(serializado) > _LS_QUOTA_BYTES) {
                VP.log.warn('keyval: valor demasiado grande para "' + clave + '"');
                return false;
            }
            if (VP.db && typeof VP.db.guardarKeyVal === 'function') {
                VP.db.guardarKeyVal(clave, valor);
            }
            return true;
        } catch (_) { return false; }
    };

    VP.util.obtenerItem = function (clave) {
        if (clave === null || clave === undefined || clave === STR_EMPTY) return null;
        try {
            if (VP.db && typeof VP.db.obtenerKeyVal === 'function') {
                return VP.db.obtenerKeyVal(clave);
            }
            return null;
        } catch (_) { return null; }
    };

    VP.util.eliminarItem = function (clave) {
        try {
            if (VP.db && typeof VP.db.eliminarKeyVal === 'function') {
                VP.db.eliminarKeyVal(clave);
            }
        } catch (_) {}
    };

    VP.util.limpiarStorageAntiguo = function (opciones) {
        try {
            opciones = opciones || {};
            var claves = (VP.db && typeof VP.db.clavesKeyVal === 'function')
                ? VP.db.clavesKeyVal()
                : [];
            var eliminadas = 0;
            for (var j = 0; j < claves.length; j++) {
                var c = claves[j];
                if (opciones.soloIA && !/RecIA|TagsIA|ChapIA|ChatIA|TransIA|VisionIA|CommentIA/i.test(c)) continue;
                if (opciones.parcial && /settings|ajustes|playlist|orden/i.test(c)) continue;
                VP.db.eliminarKeyVal(c);
                eliminadas++;
            }
            if (VP.metricas) VP.metricas.storageEvicciones += eliminadas;
            VP.log.info('limpiarStorageAntiguo: eliminadas ' + eliminadas + ' entradas.');
        } catch (_) {}
    };

    VP.util.guardarProgresoBulk = function (mapaProgreso) {
        if (!mapaProgreso || typeof mapaProgreso !== 'object') return false;

        var compacto = Object.create(null);
        var claves   = Object.keys(mapaProgreso);

        for (var i = 0, len = claves.length; i < len; i++) {
            var k = claves[i];
            var v = mapaProgreso[k];
            if (v && v.t > 0) {
                compacto[k] = { t: Math.round(v.t), d: Math.round(v.d || 0) };
            }
        }
        return VP.util.guardarItem('progreso_bulk', compacto);
    };

    VP.util.obtenerProgresoBulk = function () {
        return VP.util.obtenerItem('progreso_bulk') || {};
    };

    // ============================================================
    // SECCIÓN 10b — STORAGE GET/SET UNIFICADO
    // Usado por vp-capitulos-ia.js y vp-resumen-ia.js a través de
    // VP.util.storageGet / VP.util.storageSet
    // ============================================================

    /**
     * Lee un valor del storage.
     * Alias de VP.util.obtenerItem con soporte de valor por defecto.
     *
     * @param {string} clave
     * @param {*}      [porDefecto=null]
     * @returns {*}
     */
    VP.util.storageGet = function (clave, porDefecto) {
        var val = VP.util.obtenerItem(clave);
        return (val !== null && val !== undefined) ? val : (porDefecto !== undefined ? porDefecto : null);
    };

    /**
     * Guarda un valor en el storage.
     * Alias de VP.util.guardarItem.
     *
     * @param {string} clave
     * @param {*}      valor
     * @returns {boolean}
     */
    VP.util.storageSet = function (clave, valor) {
        return VP.util.guardarItem(clave, valor);
    };

    // ============================================================
    // SECCIÓN 10c — ROBUSTEZ GENERAL Y JSON DEFENSIVO
    // ============================================================

    VP.util.ejecutarSeguro = function (fn, contexto, fallback) {
        if (typeof fn !== 'function') return fallback;
        try {
            return fn();
        } catch (e) {
            if (VP.log && typeof VP.log.warn === 'function') {
                VP.log.warn('ejecutarSeguro[' + (contexto || '?') + ']:', e.message || e);
            }
            return fallback;
        }
    };

    VP.util.parsearJSONSeguro = function (texto, fallback) {
        if (texto === null || texto === undefined || texto === STR_EMPTY) {
            return fallback !== undefined ? fallback : null;
        }
        if (typeof texto !== 'string') return texto;
        try {
            return JSON.parse(texto);
        } catch (e) {
            if (VP.log && typeof VP.log.warn === 'function') {
                VP.log.warn('parsearJSONSeguro: JSON inválido:', e.message || e);
            }
            return fallback !== undefined ? fallback : null;
        }
    };

    VP.util.serializarJSONSeguro = function (valor, fallback) {
        try {
            return JSON.stringify(valor);
        } catch (e) {
            if (VP.log && typeof VP.log.warn === 'function') {
                VP.log.warn('serializarJSONSeguro:', e.message || e);
            }
            return fallback !== undefined ? fallback : null;
        }
    };

    VP.util.normalizarArray = function (valor, fallback) {
        if (Array.isArray(valor)) return valor;
        if (valor === null || valor === undefined) return fallback || [];
        return [valor];
    };

    VP.util.esObjetoPlano = function (valor) {
        if (!valor || Object.prototype.toString.call(valor) !== '[object Object]') {
            return false;
        }
        var proto = Object.getPrototypeOf ? Object.getPrototypeOf(valor) : valor.__proto__;
        return proto === Object.prototype || proto === null;
    };

    VP.util.aplicarDefaults = function (valor, defaults) {
        var base = VP.util.esObjetoPlano(defaults) ? VP.util.clonarObjeto(defaults) : {};
        if (!VP.util.esObjetoPlano(valor)) return base;
        var claves = Object.keys(valor);
        for (var i = 0; i < claves.length; i++) {
            var k = claves[i];
            if (valor[k] !== undefined) base[k] = valor[k];
        }
        return base;
    };

    VP.util.obtenerRuta = function (obj, ruta, fallback) {
        if (!obj || !ruta) return fallback;
        var partes = Array.isArray(ruta) ? ruta : String(ruta).split('.');
        var actual = obj;
        for (var i = 0; i < partes.length; i++) {
            if (actual == null || !(partes[i] in Object(actual))) return fallback;
            actual = actual[partes[i]];
        }
        return actual === undefined ? fallback : actual;
    };

    VP.util.normalizarNumeroFinito = function (valor, fallback, min, max) {
        var n = Number(valor);
        if (!isFinite(n)) n = fallback || 0;
        if (isFinite(min) && n < min) n = min;
        if (isFinite(max) && n > max) n = max;
        return n;
    };

    VP.util.compactarTexto = function (texto, maxChars) {
        texto = texto == null ? STR_EMPTY : String(texto);
        texto = texto.replace(REG_CONTROL, ' ').replace(REG_ESPACIOS, ' ').trim();
        maxChars = maxChars > 0 ? maxChars : 0;
        return maxChars && texto.length > maxChars ? texto.slice(0, maxChars) : texto;
    };

    VP.util.validarVideoBasico = function (video) {
        if (!video || typeof video !== 'object') return false;
        var nombre = video.name || video.nombre || video.fileName;
        if (!nombre || typeof nombre !== 'string') return false;
        if (!VP.util.esArchivoVideo(nombre)) return false;
        if ('duration' in video && !isFinite(Number(video.duration))) return false;
        if ('size' in video && Number(video.size) < 0) return false;
        return true;
    };

    VP.util.promesaConTimeout = function (promesa, ms, mensaje) {
        if (typeof Promise === 'undefined') return promesa;
        ms = ms > 0 ? ms : 10000;
        return new Promise(function (resolve, reject) {
            var cerrado = false;
            var t = setTimeout(function () {
                if (cerrado) return;
                cerrado = true;
                reject(new Error(mensaje || ('Timeout tras ' + ms + 'ms')));
            }, ms);

            Promise.resolve(promesa).then(function (v) {
                if (cerrado) return;
                cerrado = true;
                clearTimeout(t);
                resolve(v);
            }).catch(function (e) {
                if (cerrado) return;
                cerrado = true;
                clearTimeout(t);
                reject(e);
            });
        });
    };

    VP.util.crearAbortControllerSeguro = function () {
        if (typeof AbortController === 'undefined') return null;
        try { return new AbortController(); }
        catch (_) { return null; }
    };

    VP.util.esAbortado = function (err) {
        return !!(err && (
            err.name === 'AbortError' ||
            err.code === 'ABORT_ERR' ||
            err.code === 'ABORTED'
        ));
    };

    // ============================================================
    // SECCIÓN 11 — THROTTLE / DEBOUNCE / RAF-THROTTLE
    // ============================================================

    VP.util.throttle = function (fn, limite) {
        limite = Number.isFinite(limite) && limite > 0 ? Math.max(1, Math.floor(limite)) : 300;
        var ultimo = -Infinity;
        var timer  = null;
        var contextoPendiente = null;
        var argumentosPendientes = null;

        function ejecutarPendiente() {
            timer = null;
            ultimo = VP.util.ahora();
            var contexto = contextoPendiente;
            var argumentos = argumentosPendientes;
            contextoPendiente = null;
            argumentosPendientes = null;
            fn.apply(contexto, argumentos);
        }

        return function () {
            contextoPendiente = this;
            argumentosPendientes = arguments;
            var ahora    = VP.util.ahora();
            var restante = limite - (ahora - ultimo);

            if (restante <= 0) {
                if (timer !== null) { clearTimeout(timer); timer = null; }
                ultimo = ahora;
                var contexto = contextoPendiente;
                var argumentos = argumentosPendientes;
                contextoPendiente = null;
                argumentosPendientes = null;
                fn.apply(contexto, argumentos);
            } else if (timer === null) {
                timer = setTimeout(ejecutarPendiente, restante);
            }
        };
    };

    VP.util.debounce = function (fn, ms) {
        ms = ms > 0 ? ms : 300;
        var t = null;
        var wrapper = function () {
            var ctx  = this;
            var args = arguments;
            clearTimeout(t);
            t = setTimeout(function () {
                t = null;
                fn.apply(ctx, args);
            }, ms);
        };
        wrapper.cancelar = function () { clearTimeout(t); t = null; };
        return wrapper;
    };

    VP.util.rafThrottle = function (fn) {
        if (!VP.features.raf) return VP.util.throttle(fn, 16);
        var id = null;
        return function () {
            var ctx  = this;
            var args = arguments;
            if (id !== null) return;
            id = requestAnimationFrame(function () {
                id = null;
                fn.apply(ctx, args);
            });
        };
    };

    // ============================================================
    // SECCIÓN 12 — TIEMPO Y PROGRAMACIÓN
    // ============================================================

    VP.util.ahora = (function () {
        if (VP.features.performance) {
            return function () { return performance.now(); };
        }
        return function () { return Date.now(); };
    })();

    VP.util.programarIdle = function (fn, timeout) {
        if (typeof fn !== 'function') return;
        if (VP.features.idleCallback) {
            requestIdleCallback(fn, { timeout: timeout > 0 ? timeout : 2000 });
        } else {
            setTimeout(fn, 0);
        }
    };

    VP.util.diferir = function (fn, ms, señal) {
        if (typeof fn !== 'function') return -1;
        return setTimeout(function () {
            if (señal && señal.cancelado) return;
            try { fn(); } catch (e) {
                VP.log.warn('diferir — fn lanzó error:', e);
            }
        }, ms >= 0 ? ms : 0);
    };

    // ============================================================
    // SECCIÓN 13 — SCROLL VIRTUAL
    // ============================================================

    VP.util.calcularVentanaVirtual = function (
        scrollTop, alturaVentana, alturaItem, totalItems, margen
    ) {
        if (alturaItem <= 0 || totalItems <= 0) {
            return { primero: 0, ultimo: 0, offsetTop: 0 };
        }
        margen = margen >= 0 ? (margen | 0) : 3;

        var primero = Math.max(0, ((scrollTop / alturaItem) | 0) - margen);
        var visible = Math.ceil(alturaVentana / alturaItem);
        var ultimo  = Math.min(totalItems - 1, primero + visible + margen * 2);

        return {
            primero:   primero,
            ultimo:    ultimo,
            offsetTop: primero * alturaItem
        };
    };

    // ============================================================
    // SECCIÓN 14 — DOM SEGURO
    // ============================================================

    VP.util.eliminarElemento = function (el) {
        if (!el) return;
        try { el.remove(); return; } catch (_) {}
        try { if (el.parentNode) el.parentNode.removeChild(el); } catch (_) {}
    };

    VP.util.crearBlobURLSeguro = function (archivo) {
        if (!archivo || !VP.features.blobURL) return null;
        try { return URL.createObjectURL(archivo); }
        catch (_) { return null; }
    };

    VP.util.revocarBlobURL = function (mapa, clave) {
        if (!mapa || !clave) return;
        var url = mapa[clave];
        if (url && typeof url === 'string' && url.indexOf('blob:') === 0) {
            try { URL.revokeObjectURL(url); } catch (_) {}
        }
        delete mapa[clave];
    };

    VP.util.revocarTodasBlobURLs = function (mapa) {
        if (!mapa || typeof mapa !== 'object') return;
        var claves = Object.keys(mapa);
        for (var i = 0, len = claves.length; i < len; i++) {
            VP.util.revocarBlobURL(mapa, claves[i]);
        }
    };

    VP.util.sanitizarHTMLBasico = function (html) {
        if (typeof html !== 'string' || !html) return STR_EMPTY;
        try {
            var tpl = document.createElement('template');
            tpl.innerHTML = html;
            var prohibidos = tpl.content.querySelectorAll(
                'script, iframe, object, embed, link[rel="import"]'
            );
            for (var i = prohibidos.length - 1; i >= 0; i--) {
                if (prohibidos[i].parentNode) prohibidos[i].parentNode.removeChild(prohibidos[i]);
            }

            var nodos = tpl.content.querySelectorAll('*');
            for (var n = 0; n < nodos.length; n++) {
                var attrs = nodos[n].attributes;
                for (var a = attrs.length - 1; a >= 0; a--) {
                    var nombre = attrs[a].name;
                    var valor  = attrs[a].value || '';
                    if (/^on/i.test(nombre) || /^\s*javascript:/i.test(valor)) {
                        nodos[n].removeAttribute(nombre);
                    }
                }
            }
            return tpl.innerHTML;
        } catch (_) {
            return VP.util.escaparHTML(html);
        }
    };

    VP.util.insertarHTMLSeguro = function (contenedor, html, opciones) {
        if (!contenedor || typeof html !== 'string') return;
        opciones = opciones || {};
        if (opciones.sanitizar) html = VP.util.sanitizarHTMLBasico(html);
        try {
            var frag = document.createRange
                ? document.createRange().createContextualFragment(html)
                : null;

            if (frag) {
                contenedor.innerHTML = STR_EMPTY;
                contenedor.appendChild(frag);
            } else {
                contenedor.innerHTML = html;
            }
        } catch (_) {
            contenedor.innerHTML = html;
        }
    };

    // ============================================================
    // SECCIÓN 15 — ICONOS SVG INTERNOS
    // ============================================================

    VP.util.svg = Object.freeze({
        pelicula: '<svg class="icon" viewBox="0 0 24 24" ' +
            'style="opacity:.2;width:28px;height:28px" aria-hidden="true">' +
            '<path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1' +
            ' 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>',

        peliculaPeq: '<svg class="icon" viewBox="0 0 24 24" ' +
            'style="opacity:.2;width:18px;height:18px" aria-hidden="true">' +
            '<path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1' +
            ' 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>',

        audioOn: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5' +
            '-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86' +
            ' 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77' +
            's-2.99-7.86-7-8.77z"/></svg>',

        audioOff: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03' +
            '-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63' +
            ' 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54' +
            ' 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52' +
            '-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21' +
            ' 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>',

        descargar: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',

        eliminar: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12z' +
            'M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    });

    // ============================================================
    // SECCIÓN 16 — ICONOS DE NOTIFICACIÓN
    // ============================================================

    VP.util.iconosNotif = Object.freeze({
        exito: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>',

        error: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10' +
            '-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',

        advertencia: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',

        info: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10' +
            '-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
    });

    // ============================================================
    // SECCIÓN 17 — MÉTRICAS DE RENDIMIENTO INTERNAS
    // ============================================================

    var _metricas = Object.create(null);

    VP.util.medirInicio = function (nombre) {
        var t = VP.util.ahora();
        _metricas[nombre] = _metricas[nombre] || {
            llamadas: 0, total: 0, max: 0, min: Infinity
        };
        return { nombre: nombre, inicio: t };
    };

    VP.util.medirFin = function (token) {
        if (!token || !token.nombre) return 0;
        var dur = VP.util.ahora() - token.inicio;
        var m   = _metricas[token.nombre];
        if (!m) return dur;
        m.llamadas++;
        m.total += dur;
        if (dur > m.max) m.max = dur;
        if (dur < m.min) m.min = dur;
        return dur;
    };

    VP.util.obtenerMetricas = function () {
        return VP.util.clonarObjeto(_metricas);
    };

    VP.util.resetearMetricas = function () {
        _metricas = Object.create(null);
    };

    // ============================================================
    // SECCIÓN 18 — VERIFICACIÓN DE CONSISTENCIA
    // ============================================================

    (function verificarIntegridad() {
        var requeridos = [
            // Arrays
            'incluye', 'eliminarDeArray', 'asignarObjeto', 'clonarObjeto',
            'unicosDeArray', 'ordenarPor', 'agruparPor', 'trocearArray',
            // Batch
            'procesarEnLotes',
            // Archivos
            'obtenerExtension', 'esArchivoVideo', 'esArchivoSubtitulo',
            'obtenerNombreBase', 'sanitizarNombreArchivo', 'mapearArchivosPorBase',
            // Números
            'clampNum', 'clampInt', 'parsearEntero', 'parsearDecimal',
            // Tiempo
            'formatearTiempo', 'formatearDuracion', 'formatearTamano',
            // IDs
            'generarId',
            // HTML
            'escaparHTML', 'ajustarColor', 'truncarTexto',
            'normalizarBusqueda', 'filtrarLista',
            // Subtítulos
            'srtAVtt', 'assAVtt',
            // VTT
            'parsearCuesVtt', 'liberarCues', 'cueActivoEn', 'cuesEnRango',
            // Storage
            'guardarItem', 'obtenerItem', 'eliminarItem',
            'guardarProgresoBulk', 'obtenerProgresoBulk',
            // Storage unificado
            'storageGet', 'storageSet',
            // Robustez / JSON
            'ejecutarSeguro', 'parsearJSONSeguro', 'serializarJSONSeguro',
            'normalizarArray', 'esObjetoPlano', 'aplicarDefaults',
            'obtenerRuta', 'normalizarNumeroFinito', 'compactarTexto',
            'validarVideoBasico', 'promesaConTimeout', 'crearAbortControllerSeguro',
            'esAbortado',
            // Control
            'throttle', 'debounce', 'rafThrottle',
            // Tiempo / scheduling
            'ahora', 'programarIdle', 'diferir',
            // DOM
            'eliminarElemento', 'crearBlobURLSeguro',
            'revocarBlobURL', 'revocarTodasBlobURLs',
            'sanitizarHTMLBasico', 'insertarHTMLSeguro',
            // Virtual scroll
            'calcularVentanaVirtual',
            // Métricas
            'medirInicio', 'medirFin', 'obtenerMetricas',
        ];

        var faltan = [];
        for (var i = 0, len = requeridos.length; i < len; i++) {
            if (typeof VP.util[requeridos[i]] !== 'function') {
                faltan.push(requeridos[i]);
            }
        }

        if (faltan.length > 0) {
            VP.log.error(
                'vp-utilidades.js: funciones faltantes (' + faltan.length + '):',
                faltan.join(', ')
            );
        }

        var featuresReq = ['raf', 'performance', 'crypto', 'blobURL', 'idleCallback'];
        for (var f = 0; f < featuresReq.length; f++) {
            if (VP.features[featuresReq[f]] === undefined) {
                VP.log.warn(
                    'vp-utilidades.js: VP.features.' + featuresReq[f] +
                    ' no definido — usando fallback.'
                );
            }
        }
    })();

    // ============================================================
    // LOG DE CARGA
    // ============================================================

    if (typeof VP.registrarModulo === 'function') {
        VP.registrarModulo('utilidades', {
            version: '2.1',
            critico: true,
            funciones: Object.keys(VP.util).length
        });
    }

    VP.log.info('vp-utilidades.js v2.1 cargado. Pool VTT: ' +
                _CUE_POOL_MAX + ' cues.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-utilidades.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
