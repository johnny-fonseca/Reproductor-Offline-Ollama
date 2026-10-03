/* ==========================================================================
   2. UTILIDADES INTERNAS
   ========================================================================== */
(function (window) {
    'use strict';
    var VP = window.VP;
    if (!VP) return;

    // Copia las propiedades propias de "origen" dentro de "destino".
    // Se usa en lugar de Object.assign para no romper la compatibilidad
    // con navegadores antiguos (el resto del módulo evita ES6+ a propósito).
    function fusionarObjeto(destino, origen) {
        if (origen) {
            for (var clave in origen) {
                if (Object.prototype.hasOwnProperty.call(origen, clave)) {
                    destino[clave] = origen[clave];
                }
            }
        }
        return destino;
    }

    // Fusión profunda segura (no destructiva sobre subobjetos compartidos).
    function fusionarProfundo(destino, origen) {
        if (!origen) return destino;
        if (!destino || typeof destino !== 'object') destino = {};
        for (var clave in origen) {
            if (!Object.prototype.hasOwnProperty.call(origen, clave)) continue;
            var valor = origen[clave];
            if (valor && typeof valor === 'object' && !Array.isArray(valor) && !(valor instanceof Error)) {
                if (!destino[clave] || typeof destino[clave] !== 'object' || Array.isArray(destino[clave])) {
                    destino[clave] = {};
                }
                fusionarProfundo(destino[clave], valor);
            } else {
                destino[clave] = valor;
            }
        }
        return destino;
    }

    function isPlainObject(value) {
        if (value == null || typeof value !== 'object') return false;
        if (Array.isArray(value) || value instanceof Error) return false;
        var proto = Object.getPrototypeOf ? Object.getPrototypeOf(value) : Object.prototype;
        return proto === Object.prototype || proto === null;
    }

    function safeJsonParse(raw, fallback) {
        if (raw == null) return fallback;
        if (typeof raw !== 'string') return raw;
        if (!raw.trim()) return fallback;
        try {
            var parsed = JSON.parse(raw);
            return parsed == null ? fallback : parsed;
        } catch (_) { return fallback; }
    }

    function safeJsonStringify(value, fallback) {
        try {
            var out = JSON.stringify(value);
            return typeof out === 'string' ? out : (fallback == null ? '' : fallback);
        } catch (_) { return fallback == null ? '' : fallback; }
    }

    function describeError(err) {
        if (err == null) return { nombre: 'Error', mensaje: '' };
        if (err instanceof Error) {
            return {
                nombre: err.name || 'Error',
                mensaje: String(err.message || ''),
                codigo: err.code || undefined,
                status: err.status || undefined,
                stack: typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 4).join(' | ') : undefined
            };
        }
        return { nombre: typeof err, mensaje: String(err) };
    }

    function safeCall(fn, thisArg, args, onError) {
        if (typeof fn !== 'function') return undefined;
        try { return fn.apply(thisArg, args || []); }
        catch (e) {
            if (typeof onError === 'function') {
                try { onError(e); } catch (_) {}
            }
            return undefined;
        }
    }

    function once(fn) {
        var called = false, result;
        return function () {
            if (called) return result;
            called = true;
            result = fn.apply(this, arguments);
            return result;
        };
    }

    function throttle(fn, wait) {
        var last = 0, timer = null, lastArgs = null, lastCtx = null;
        wait = Math.max(0, Number(wait) || 0);
        function invoke() {
            last = Date.now();
            timer = null;
            if (lastArgs) fn.apply(lastCtx, lastArgs);
            lastArgs = lastCtx = null;
        }
        return function () {
            var now = Date.now();
            var remaining = wait - (now - last);
            lastArgs = arguments;
            lastCtx = this;
            if (remaining <= 0) {
                if (timer) { clearTimeout(timer); timer = null; }
                invoke();
            } else if (!timer) {
                timer = setTimeout(invoke, remaining);
            }
        };
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, Number(ms) || 0)); });
    }

    function stripControlChars(str) {
        if (str == null) return '';
        return String(str)
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
            .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
    }

    function normalizeWhitespace(str) {
        if (str == null) return '';
        return stripControlChars(str).replace(/\s+/g, ' ').trim();
    }

    function truncate(str, max, suffix) {
        var text = String(str == null ? '' : str);
        var limit = Math.max(0, Number(max) || 0);
        if (!limit || text.length <= limit) return text;
        var tail = suffix == null ? '…' : String(suffix);
        if (tail.length >= limit) return text.slice(0, limit);
        return text.slice(0, limit - tail.length) + tail;
    }

    function emitirEvento(evento, datos, nivel) {
        if (typeof console === 'undefined') return;
        if (typeof VP_DEBUG !== 'undefined' && VP_DEBUG.silenciarConsola === true && nivel !== 'warn' && nivel !== 'error') {
            var debugMochiActivo = VP_DEBUG.general === true || (VP_DEBUG.Mochi && (
                VP_DEBUG.Mochi.general === true || VP_DEBUG.Mochi.eventos === true ||
                VP_DEBUG.Mochi.solicitudesOllama === true || VP_DEBUG.Mochi.metricasOllama === true ||
                VP_DEBUG.Mochi.diagnosticoOllama === true
            ));
            if (!debugMochiActivo) return;
        }
        var metodo = nivel || 'info';
        var cfg = VP.mochiConfig || {};
        var nivelesOrden = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
        if (Object.prototype.hasOwnProperty.call(nivelesOrden, cfg.logLevel)) {
            if (nivelesOrden[metodo] < nivelesOrden[cfg.logLevel]) return;
        }
        var payload = fusionarObjeto({ evento: String(evento || 'registro') }, datos);
        var debugMochi = typeof VP_DEBUG !== 'undefined' && VP_DEBUG.Mochi ? VP_DEBUG.Mochi : {};
        var eventosDebug = {
            solicitudesOllama: ['contexto_enviado', 'ollama_request_sent'],
            metricasOllama: ['ollama_response_received'],
            diagnosticoOllama: [
                'ollama_circuito_abierto', 'ollama_reintento', 'ollama_solicitud_compatible',
                'prompt_excede_limite', 'respuesta_descartada', 'respuesta_ajustada',
                'respuesta_invalida', 'respuesta_validada', 'ollama_modelo_descargado', 'ollama_error'
            ]
        };
        var camposDebug = [
            'modelo', 'humor', 'prompt_eval_count', 'eval_count', 'prompt_eval_duration_ms',
            'eval_duration_ms', 'total_duration_ms', 'load_duration_ms', 'done_reason',
            'charsPrompt', 'charsSistema', 'temperature', 'num_predict', 'format',
            'promptChars', 'limite', 'lineasPriorizadas', 'lineasDeContexto',
            'segundoObjetivo', 'ventanaActualSegundos', 'seUsaronLineasPreviasPorFaltaDeActuales',
            'motivo', 'status', 'code', 'codigo', 'mensaje'
        ];
        for (var flagDebug in eventosDebug) {
            if (debugMochi[flagDebug] !== true || eventosDebug[flagDebug].indexOf(payload.evento) === -1) continue;
            // Ollama y el planificador notifican el mismo resultado. El evento
            // de Ollama incluye modelo y humor; omite el resumen duplicado.
            if (flagDebug === 'metricasOllama' && (!payload.modelo || !payload.humor)) return;
            // Conserva solo el envío detallado del cliente, que incluye tamaños.
            if (flagDebug === 'solicitudesOllama' && payload.evento === 'ollama_request_sent' && payload.charsPrompt == null) return;
            var datosDebug = {};
            for (var iDebug = 0; iDebug < camposDebug.length; iDebug++) {
                var campoDebug = camposDebug[iDebug];
                if (payload[campoDebug] !== undefined) datosDebug[campoDebug] = payload[campoDebug];
            }
            var etiquetaDebug = flagDebug === 'metricasOllama' ? 'Métricas' :
                (flagDebug === 'solicitudesOllama' ? 'Solicitud' : 'Diagnóstico');
            if (typeof console.info === 'function') console.info('[Mochi][Ollama] ' + etiquetaDebug + ':', payload.evento, datosDebug);
            else if (typeof console.log === 'function') console.log('[Mochi][Ollama] ' + etiquetaDebug + ':', payload.evento, datosDebug);
            return;
        }
        if ((VP_DEBUG.general || VP_DEBUG.Mochi.general || VP_DEBUG.Mochi.eventos) && typeof console[metodo] === 'function') console[metodo]('[Mochi]', payload);
        else if ((VP_DEBUG.general || VP_DEBUG.Mochi.general || VP_DEBUG.Mochi.eventos) && typeof console.log === 'function') console.log('[Mochi]', payload);
    }
    function emitirArgumentos(nivel, args) {
        var lista = Array.prototype.slice.call(args || []);
        var primero = lista.shift();
        // Antes: String(primero || '') convertía 0, false o '' en cadena vacía.
        // Ahora solo se trata como "sin mensaje" cuando es null/undefined.
        var mensaje = (primero == null) ? '' : String(primero);
        var payload = { mensaje: mensaje };
        if (lista.length === 1 && lista[0] && typeof lista[0] === 'object' &&
            !Array.isArray(lista[0]) && !(lista[0] instanceof Error)) {
            // Se excluyen los arrays de la fusión directa: antes un array como
            // único argumento extra se aplanaba en claves numéricas (0,1,2...)
            // dentro del payload en vez de conservarse como lista de detalle.
            fusionarObjeto(payload, lista[0]);
        } else if (lista.length) {
            payload.detalle = lista.map(function (valor) {
                return valor instanceof Error ? { nombre: valor.name, mensaje: valor.message, codigo: valor.code } : valor;
            });
        }
        emitirEvento('diagnostico', payload, nivel);
    }
    function debugActivo() { return !!(VP.mochiConfig && VP.mochiConfig.debug); }
    function log() {
        if (!debugActivo() || typeof console === 'undefined') return;
        emitirArgumentos('log', arguments);
    }
    function warn() {
        if (typeof console === 'undefined') return;
        emitirArgumentos('warn', arguments);
    }
    function error() {
        if (typeof console === 'undefined') return;
        emitirArgumentos('error', arguments);
    }
    function storageGet(key, fallback) {
        try {
            if (VP.util && typeof VP.util.storageGet === 'function') return VP.util.storageGet(key, fallback);
            if (typeof window.localStorage === 'undefined') return fallback;
            var raw = window.localStorage.getItem(key);
            return raw == null ? fallback : raw;
        } catch (_) { return fallback; }
    }
    function storageSet(key, value) {
        try {
            if (VP.util && typeof VP.util.storageSet === 'function') { VP.util.storageSet(key, value); return true; }
            if (typeof window.localStorage === 'undefined') return false;
            window.localStorage.setItem(key, value);
            return true;
        } catch (_) { return false; }
    }
    function debounce(fn, wait) {
        var t = null;
        return function () {
            var ctx = this, args = arguments;
            if (t) clearTimeout(t);
            t = setTimeout(function () { t = null; fn.apply(ctx, args); }, wait);
        };
    }
    function prefiereMovimientoReducido() {
        try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
        catch (_) { return false; }
    }
    function conJitter(ms, ratio) {
        var factor = 1 + (Math.random() * 2 - 1) * Math.max(0, Math.min(0.5, Number(ratio) || 0));
        return Math.max(0, Math.round(Number(ms) * factor));
    }
    function pickRandom(arr) {
        if (!Array.isArray(arr) || !arr.length) return '';
        return arr[Math.floor(Math.random() * arr.length)];
    }
    function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

    // Similitud Jaccard simple entre dos cadenas normalizadas (útil para
    // diagnóstico y detección temprana de duplicados). Punto ciego conocido:
    // compara vocabulario (tokens de 3+ caracteres), no plantillas; por ejemplo, "Mochi observa el
    // callejón con curiosidad" y "Mochi observa el callejón con curiosidad
    // renovada" pueden repetir la estructura sin que este detector lo señale.
    function computeSimilarity(a, b) {
        var norm = function (str) {
            return String(str || '').toLowerCase()
                .replace(/[^a-z0-9áéíóúñü]+/gi, ' ')
                .split(/\s+/).filter(function (w) { return w.length > 2; });
        };
        var ta = norm(a), tb = norm(b);
        if (!ta.length || !tb.length) return 0;
        var sa = {}, sb = {};
        ta.forEach(function (w) { sa[w] = true; });
        tb.forEach(function (w) { sb[w] = true; });
        var inter = 0, union = 0;
        for (var w in sa) { if (Object.prototype.hasOwnProperty.call(sa, w)) { if (sb[w]) inter++; union++; } }
        for (var w2 in sb) { if (Object.prototype.hasOwnProperty.call(sb, w2) && !sa[w2]) union++; }
        return union === 0 ? 0 : inter / union;
    }

    var FRASES_SESION_KEY = 'vp_mochi_frases_sesion_v1';
    var frasesSesion = null;
    function cargarFrasesSesion() {
        if (frasesSesion) return frasesSesion;
        frasesSesion = {};
        try {
            var guardadas = window.sessionStorage && window.sessionStorage.getItem(FRASES_SESION_KEY);
            var parsed = safeJsonParse(guardadas, null);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frasesSesion = parsed;
        } catch (_) {}
        return frasesSesion;
    }
    function seleccionarFraseSesion(lista, perfil, categoria) {
        if (!Array.isArray(lista) || !lista.length) return '';
        var unicas = lista.map(function (frase) { return String(frase || '').trim(); }).filter(function (frase, index, todas) {
            return !!frase && todas.indexOf(frase) === index;
        });
        if (!unicas.length) return '';
        var estado = cargarFrasesSesion();
        var clave = String(perfil || 'mochi') + ':' + String(categoria || 'general');
        var usadas = Array.isArray(estado[clave]) ? estado[clave].filter(function (frase) {
            return unicas.indexOf(frase) !== -1;
        }) : [];
        if (usadas.length >= unicas.length) usadas = [];
        var disponibles = unicas.filter(function (frase) { return usadas.indexOf(frase) === -1; });
        var seleccion = disponibles[Math.floor(Math.random() * disponibles.length)];
        estado[clave] = usadas.concat(seleccion);
        try {
            if (window.sessionStorage) window.sessionStorage.setItem(FRASES_SESION_KEY, safeJsonStringify(estado, '{}'));
        } catch (_) {}
        return seleccion;
    }

    VP._mochiUtil = {
        fusionarObjeto: fusionarObjeto,
        fusionarProfundo: fusionarProfundo,
        isPlainObject: isPlainObject,
        safeJsonParse: safeJsonParse,
        safeJsonStringify: safeJsonStringify,
        describeError: describeError,
        safeCall: safeCall,
        once: once,
        throttle: throttle,
        delay: delay,
        stripControlChars: stripControlChars,
        normalizeWhitespace: normalizeWhitespace,
        truncate: truncate,
        computeSimilarity: computeSimilarity,
        consoleEvent: emitirEvento,
        log: log,
        warn: warn,
        error: error,
        storageGet: storageGet,
        storageSet: storageSet,
        debounce: debounce,
        prefiereMovimientoReducido: prefiereMovimientoReducido,
        conJitter: conJitter,
        pickRandom: pickRandom,
        clamp: clamp,
        seleccionarFraseSesion: seleccionarFraseSesion
    };
})(window);
