/* =====================================================================
   vp-ollama-client.js — Cliente compartido para Ollama  v2.2
   Proporciona:
     fetchWithTimeout, fetchJSON, readStream (NDJSON), fetchModels ← API v1 intacta
     OllamaError, RetryError                                 ← Tipos de error
     ping, fetchModelInfo, keepAlive                         ← Gestión de modelos
     chat, generate, embed                                   ← Wrappers de alto nivel
     requestQueue                                            ← Cola de peticiones
     modelCache                                              ← Caché con TTL
     StreamStats                                             ← Estadísticas de streaming
   Compatible con Ollama ≥ 0.1.x | Qwen3.5-9B-Q4_K_M.gguf | RTX 4060 8 GB
   ===================================================================== */
(function () {
    'use strict';

    if (window.__VP_OLLAMA_CLIENT_LOADED__) return;

    var VP = window.VP;
    if (!VP) { console.error('[VP] vp-ollama-client.js: VP no existe.'); return; }
    window.__VP_OLLAMA_CLIENT_LOADED__ = true;
    var activeRequests = 0;
    var log = VP.log || console;
    if (VP.log) VP.log.setContext('Ollama');

    /* ═══════════════════════════════════════════════════════════════════
       §1  TIPOS DE ERROR PERSONALIZADOS
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * OllamaError — error semántico devuelto por el servidor Ollama.
     * @param {string} message  Mensaje legible.
     * @param {number} [status] Código HTTP, si aplica.
     * @param {string} [code]   Código corto: 'MODEL_NOT_FOUND', 'SERVER_ERROR', etc.
     */
    function OllamaError(message, status, code) {
        this.name    = 'OllamaError';
        this.message = message;
        this.status  = status || 0;
        this.code    = code   || 'UNKNOWN';
        if (Error.captureStackTrace) Error.captureStackTrace(this, OllamaError);
    }
    OllamaError.prototype = Object.create(Error.prototype);
    OllamaError.prototype.constructor = OllamaError;

    /**
     * RetryError — se lanza cuando se agotan todos los reintentos.
     * @param {string} message     Mensaje legible.
     * @param {Error}  lastCause   Último error original.
     * @param {number} attempts    Número de intentos realizados.
     */
    function RetryError(message, lastCause, attempts) {
        this.name      = 'RetryError';
        this.message   = message;
        this.lastCause = lastCause;
        this.attempts  = attempts;
        if (Error.captureStackTrace) Error.captureStackTrace(this, RetryError);
    }
    RetryError.prototype = Object.create(Error.prototype);
    RetryError.prototype.constructor = RetryError;

    /* ═══════════════════════════════════════════════════════════════════
       §2  UTILIDADES INTERNAS
       ═══════════════════════════════════════════════════════════════════ */

    /** Espera ms milisegundos (Promise). */
    function sleep(ms, signal) {
        return new Promise(function (resolve, reject) {
            if (signal && signal.aborted) {
                reject(abortError('Petición cancelada durante la espera'));
                return;
            }
            var timer = setTimeout(done, ms);
            var abortHandler = null;
            function cleanup() {
                clearTimeout(timer);
                if (signal && abortHandler && typeof signal.removeEventListener === 'function') {
                    try { signal.removeEventListener('abort', abortHandler); } catch (_) {}
                }
            }
            function done() { cleanup(); resolve(); }
            if (signal && typeof signal.addEventListener === 'function') {
                abortHandler = function () {
                    cleanup();
                    reject(abortError('Petición cancelada durante la espera'));
                };
                signal.addEventListener('abort', abortHandler, { once: true });
            }
        });
    }

    function abortError(message) {
        var err = new OllamaError(message || 'Petición cancelada', 0, 'ABORTED');
        err.name = 'AbortError';
        return err;
    }

    function finiteNumber(value, fallback, min, max) {
        var n = Number(value);
        if (!isFinite(n)) n = fallback;
        if (typeof min === 'number') n = Math.max(min, n);
        if (typeof max === 'number') n = Math.min(max, n);
        return n;
    }

    /**
     * Normaliza una URL base: elimina barras finales.
     * @param {string} url
     * @returns {string}
     */
    function normalizeBase(url) {
        var raw = (url || 'http://localhost:11434');
        if (typeof raw !== 'string') raw = String(raw || '');
        raw = raw.trim() || 'http://localhost:11434';
        raw = raw.replace(/\/+$/, '');
        try {
            var parsed = new URL(raw);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error('protocolo no permitido');
            }
            return parsed.href.replace(/\/+$/, '');
        } catch (e) {
            throw new OllamaError('URL de Ollama inválida: ' + raw, 0, 'BAD_URL');
        }
    }

    function isAbortError(err) {
        return !!(err && (
            err.name === 'AbortError' ||
            err.code === 'ABORTED' ||
            err.code === 'ABORT_ERR'
        ));
    }

    function shouldRetryError(err) {
        if (isAbortError(err)) return false;
        if (!(err instanceof OllamaError)) return true;
        if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) return false;
        return [
            'BAD_URL', 'BAD_ARGUMENT', 'BAD_PAYLOAD', 'PAYLOAD_TOO_LARGE',
            'BAD_REQUEST', 'NOT_FOUND', 'MODEL_NOT_FOUND', 'BAD_RESPONSE',
            'QUEUE_FULL', 'QUEUE_CLEARED', 'ABORTED', 'STREAM_LIMIT',
            'NO_FETCH', 'NO_STREAM', 'RESPONSE_TOO_LARGE'
        ].indexOf(err.code) === -1;
    }

    function safeStringifyBody(body) {
        var text;
        try {
            text = JSON.stringify(body);
        } catch (e) {
            throw new OllamaError('No se pudo serializar la peticion', 0, 'BAD_PAYLOAD');
        }
        if (typeof text !== 'string') {
            throw new OllamaError('El cuerpo de la petición está vacío o no es serializable', 0, 'BAD_PAYLOAD');
        }
        var max = finiteNumber(VP.config && VP.config.maxPayloadOllamaChars, 180000, 1);
        if (text.length > max) {
            throw new OllamaError(
                'Payload demasiado grande para Ollama (' + text.length + ' caracteres)',
                0,
                'PAYLOAD_TOO_LARGE'
            );
        }
        return text;
    }

    /**
     * Interpreta el código HTTP de Ollama y devuelve un OllamaError descriptivo.
     * @param {Response} res
     * @returns {Promise<OllamaError>}
     */
    function httpErrorFromResponse(res) {
        return res.text().then(function (body) {
            var code = 'SERVER_ERROR';
            var msg  = 'HTTP ' + res.status;
            if (res.status === 404) { code = 'NOT_FOUND';       msg = 'Recurso no encontrado (404)'; }
            if (res.status === 400) { code = 'BAD_REQUEST';     msg = 'Petición inválida (400)'; }
            if (res.status === 500) { code = 'SERVER_ERROR';    msg = 'Error interno del servidor (500)'; }
            try {
                var json = JSON.parse(body);
                if (json.error) msg = String(json.error);
            } catch (_) {
                if (body) msg += ': ' + body.slice(0, 120);
            }
            if (res.status === 404 && /model|modelo/i.test(msg)) code = 'MODEL_NOT_FOUND';
            if (res.status === 408 || res.status === 429 || res.status >= 500) code = 'SERVER_ERROR';
            return new OllamaError(msg, res.status, code);
        });
    }

    /* ═══════════════════════════════════════════════════════════════════
       §3  fetchWithTimeout  (v1 — sin cambios en firma pública)
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * fetch() con timeout basado en AbortController.
     * @param {string} url
     * @param {RequestInit} [opts]
     * @param {number} [ms=15000]
     * @returns {Promise<Response>}
     */
    function fetchWithTimeout(url, opts, ms) {
        ms = finiteNumber(ms, 15000, 1, 2147483647);
        return new Promise(function (resolve, reject) {
            if (typeof fetch !== 'function') {
                reject(new OllamaError('fetch no disponible en este entorno', 0, 'NO_FETCH'));
                return;
            }

            opts = Object.assign({}, opts || {});
            if (opts.signal && opts.signal.aborted) {
                reject(abortError('Petición cancelada'));
                return;
            }
            activeRequests++;
            var requestCounted = true;

            var controller = typeof AbortController !== 'undefined'
                ? new AbortController()
                : null;
            var outer = opts.signal || null;
            var outerAbort = null;
            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                if (controller) controller.abort();
                cleanup();
                if (VP.metricas && typeof VP.metricas.ollamaTimeouts === 'number') VP.metricas.ollamaTimeouts++;
                reject(new OllamaError('Timeout de conexión (' + ms + 'ms)', 0, 'TIMEOUT'));
            }, ms);

            if (outer && typeof outer.addEventListener === 'function') {
                outerAbort = function () {
                    if (settled) return;
                    if (controller) controller.abort();
                    else {
                        settled = true;
                        cleanup();
                        if (VP.metricas && typeof VP.metricas.ollamaCanceladas === 'number') VP.metricas.ollamaCanceladas++;
                        reject(abortError('Petición cancelada'));
                    }
                };
                outer.addEventListener('abort', outerAbort, { once: true });
            }
            if (controller) opts.signal = controller.signal;

            function cleanup() {
                clearTimeout(timer);
                if (requestCounted) {
                    requestCounted = false;
                    activeRequests = Math.max(0, activeRequests - 1);
                }
                if (outer && outerAbort && typeof outer.removeEventListener === 'function') {
                    try { outer.removeEventListener('abort', outerAbort); } catch (_) {}
                }
            }

            Promise.resolve()
                .then(function () { return fetch(url, opts); })
                .then(function (res) {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(res);
                })
                .catch(function (err) {
                    if (settled) return;
                    // Fallback automático localhost <-> 127.0.0.1 para Brave Shields y protecciones de red local
                    if (err && (err.name === 'TypeError' || err.message === 'Failed to fetch') && url.indexOf('localhost:11434') !== -1) {
                        var altUrl = url.replace('localhost:11434', '127.0.0.1:11434');
                        fetch(altUrl, opts)
                            .then(function (res) {
                                if (settled) return;
                                settled = true;
                                cleanup();
                                resolve(res);
                            })
                            .catch(function () {
                                if (settled) return;
                                settled = true;
                                cleanup();
                                var msg = 'Error de conexión con Ollama (' + url + '). En Brave o Chrome verifica que Ollama esté ejecutándose y que no esté bloqueado por los escudos del navegador.';
                                reject(new OllamaError(msg, 0, 'NETWORK_ERROR'));
                            });
                        return;
                    }
                    settled = true;
                    cleanup();
                    if (isAbortError(err)) {
                        if (VP.metricas && typeof VP.metricas.ollamaCanceladas === 'number') VP.metricas.ollamaCanceladas++;
                        reject(abortError('Petición cancelada'));
                    } else {
                        var isNetErr = err && (err.name === 'TypeError' || err.message === 'Failed to fetch');
                        var finalErr = isNetErr ? new OllamaError('Error de red al conectar con Ollama. Revisa si Ollama está en ejecución y la configuración del navegador/escudos.', 0, 'NETWORK_ERROR') : err;
                        reject(finalErr);
                    }
                });
        });
    }

    /** Fetch + JSON con un timeout que cubre red, cuerpo y parseo. */
    function fetchJSON(url, opts, ms) {
        opts = Object.assign({}, opts || {});
        ms = finiteNumber(ms, 15000, 1, 2147483647);
        var outer = opts.signal || null;
        if (outer && outer.aborted) return Promise.reject(abortError('Petición cancelada'));
        if (typeof fetch !== 'function') {
            return Promise.reject(new OllamaError('fetch no disponible en este entorno', 0, 'NO_FETCH'));
        }
        activeRequests++;
        var requestCounted = true;
        function releaseRequest() {
            if (!requestCounted) return;
            requestCounted = false;
            activeRequests = Math.max(0, activeRequests - 1);
        }

        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var settled = false;
        var timer = null;
        var outerAbort = null;
        if (controller) opts.signal = controller.signal;

        function cleanup() {
            if (timer !== null) clearTimeout(timer);
            if (outer && outerAbort && typeof outer.removeEventListener === 'function') {
                try { outer.removeEventListener('abort', outerAbort); } catch (_) {}
            }
        }
        return new Promise(function (resolve, reject) {
            function rejectOnce(err) {
                if (settled) return;
                settled = true;
                cleanup();
                releaseRequest();
                reject(err);
            }

            timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                if (controller) controller.abort();
                cleanup();
                releaseRequest();
                if (VP.metricas && typeof VP.metricas.ollamaTimeouts === 'number') VP.metricas.ollamaTimeouts++;
                reject(new OllamaError('Timeout de respuesta (' + ms + 'ms)', 0, 'TIMEOUT'));
            }, ms);
            if (outer && typeof outer.addEventListener === 'function') {
                outerAbort = function () {
                    if (settled) return;
                    if (controller) controller.abort();
                    else {
                        if (VP.metricas && typeof VP.metricas.ollamaCanceladas === 'number') VP.metricas.ollamaCanceladas++;
                        rejectOnce(abortError('Petición cancelada'));
                    }
                };
                outer.addEventListener('abort', outerAbort, { once: true });
            }

            Promise.resolve()
                .then(function () { return fetch(url, opts); })
                .then(function (res) {
                    if (settled) return null;
                    if (!res || typeof res.text !== 'function') {
                        throw new OllamaError('Respuesta HTTP inválida de Ollama', 0, 'BAD_RESPONSE');
                    }
                    if (!res.ok) return httpErrorFromResponse(res).then(function (err) { throw err; });
                    return res.text().then(function (body) {
                        if (settled) return null;
                        var maxResponse = 8 * 1024 * 1024;
                        if (body.length > maxResponse) {
                            throw new OllamaError('Respuesta de Ollama demasiado grande', 0, 'RESPONSE_TOO_LARGE');
                        }
                        var data;
                        try { data = JSON.parse(body); }
                        catch (_) { throw new OllamaError('Ollama devolvió JSON inválido', 0, 'BAD_RESPONSE'); }
                        if (data && typeof data === 'object' && data.error) {
                            var message = String(data.error);
                            var code = /model|modelo/i.test(message) && /not found|no encontrado/i.test(message)
                                ? 'MODEL_NOT_FOUND'
                                : 'SERVER_ERROR';
                            throw new OllamaError(message, 0, code);
                        }
                        return data;
                    });
                })
                .then(function (data) {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    releaseRequest();
                    resolve(data);
                })
                .catch(function (err) {
                    if (settled) return;
                    if (isAbortError(err) || (outer && outer.aborted)) {
                        if (VP.metricas && typeof VP.metricas.ollamaCanceladas === 'number') VP.metricas.ollamaCanceladas++;
                        rejectOnce(abortError('Petición cancelada'));
                        return;
                    }
                    rejectOnce(err);
                });
        });
    }

    /* ═══════════════════════════════════════════════════════════════════
       §4  StreamStats — Estadísticas de generación en tiempo real
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Acumula estadísticas de un stream de tokens.
     * Útil para monitorear rendimiento con RTX 4060 8 GB.
     */
    function StreamStats() {
        this._startedAt    = null;
        this._firstTokenAt = null;
        this.tokenCount    = 0;
        this.charCount     = 0;
        this.evalCount     = null;
        this.evalDurationMs = null;
    }

    /** Marca el inicio del stream (antes del primer chunk). */
    StreamStats.prototype.start = function () {
        this._startedAt = Date.now();
        this._firstTokenAt = null;
        this.tokenCount = 0;
        this.charCount  = 0;
    };

    /** Registra un token recibido. Llámalo desde onToken. */
    StreamStats.prototype.record = function (token) {
        if (this._firstTokenAt === null) this._firstTokenAt = Date.now();
        this.tokenCount++;
        this.charCount += (token || '').length;
    };

    /** Tiempo hasta primer token en ms (TTFT). */
    StreamStats.prototype.ttft = function () {
        if (this._startedAt === null || this._firstTokenAt === null) return null;
        return this._firstTokenAt - this._startedAt;
    };

    /** Tokens por segundo desde el inicio del stream. */
    StreamStats.prototype.tokensPerSec = function () {
        if (this.evalCount === null || !(this.evalDurationMs > 0)) return null;
        return +(this.evalCount / (this.evalDurationMs / 1000)).toFixed(2);
    };

    /** Duración total del stream en ms. */
    StreamStats.prototype.elapsed = function () {
        if (this._startedAt === null) return 0;
        return Date.now() - this._startedAt;
    };

    /** Resumen listo para logs. */
    StreamStats.prototype.summary = function () {
        return {
            tokens:      this.evalCount,
            chunks:      this.tokenCount,
            chars:       this.charCount,
            ttft_ms:     this.ttft(),
            elapsed_ms:  this.elapsed(),
            tok_per_sec: this.tokensPerSec()
        };
    };

    /* ═══════════════════════════════════════════════════════════════════
       §5  readStream  (v1 — firma pública ampliada, compatible hacia atrás)
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Lee un stream NDJSON de Ollama (/api/chat o /api/generate).
     *
     * @param {ReadableStream} responseBody   response.body de fetch
     * @param {object} [callbacks]
     *   @param {AbortSignal}            [callbacks.signal]
     *   @param {function(string,string)}[callbacks.onToken]   (token, fullText)
     *   @param {function(string,object,object)}[callbacks.onDone] (fullText, stats?, message?)
     *   @param {function(Error)}        [callbacks.onError]   se invoca antes del rechazo
     *   @param {number}                 [callbacks.maxTokens=50000]
     *   @param {number}                 [callbacks.maxChars=8388608]
     *   @param {number}                 [callbacks.timeout=300000]
     *   @param {boolean}                [callbacks.trackStats=false]
     * @returns {Promise<string>} fullText
     */
    function readStream(responseBody, callbacks) {
        callbacks = callbacks || {};
        var signal     = callbacks.signal    || null;
        var onToken    = typeof callbacks.onToken === 'function' ? callbacks.onToken : function () {};
        var onDone     = typeof callbacks.onDone === 'function' ? callbacks.onDone : function () {};
        var onError    = typeof callbacks.onError === 'function' ? callbacks.onError : null;
        var maxTokens  = Math.floor(finiteNumber(callbacks.maxTokens, 50000, 1, 1000000));
        var maxChars   = Math.floor(finiteNumber(callbacks.maxChars, 8 * 1024 * 1024, 1, 64 * 1024 * 1024));
        var timeoutMs  = callbacks.timeout == null
            ? 300000
            : finiteNumber(callbacks.timeout, 300000, 1, 2147483647);
        var trackStats = callbacks.trackStats || false;

        var stats = trackStats ? new StreamStats() : null;
        if (stats) stats.start();

        if (!responseBody || typeof responseBody.getReader !== 'function') {
            var noBody = new OllamaError('Respuesta sin stream legible', 0, 'NO_STREAM');
            if (onError) { try { onError(noBody); } catch (_) {} }
            return Promise.reject(noBody);
        }

        var reader;
        try { reader = responseBody.getReader(); }
        catch (readerError) { return Promise.reject(readerError); }
        var decoder  = new TextDecoder('utf-8');
        var buffer   = '';
        var fullText = '';
        var fullMessage = { role: 'assistant', content: '', tool_calls: [] };
        var records  = 0;
        var sawDone  = false;
        var settled  = false;
        var timeoutId = null;
        var abortHandler = null;
        var abortErrorValue = null;

        function cleanup() {
            if (timeoutId !== null) clearTimeout(timeoutId);
            if (signal && abortHandler && typeof signal.removeEventListener === 'function') {
                try { signal.removeEventListener('abort', abortHandler); } catch (_) {}
            }
        }

        function cancelReader() {
            try {
                var cancellation = reader.cancel();
                if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(function () {});
            } catch (_) {}
        }

        var rejectAbort;
        var abortPromise = new Promise(function (_, reject) { rejectAbort = reject; });

        function fail(err) {
            if (settled) throw err;
            if (!err || typeof err !== 'object') {
                err = new OllamaError(String(err || 'Error desconocido al leer el stream'), 0, 'STREAM_ERROR');
            }
            settled = true;
            cleanup();
            cancelReader();
            if (err && typeof err === 'object' && fullText) {
                try {
                    err.hasPartialOutput = true;
                    err.partialText = fullText;
                } catch (_) {}
            }
            if (onError) {
                try { onError(err); }
                catch (callbackError) { log.warn('onError de stream falló:', callbackError); }
            }
            throw err;
        }

        // Cancela y rechaza si se cancela mientras ya se lee el cuerpo.
        if (signal) {
            if (signal.aborted) {
                abortErrorValue = abortError('Lectura del stream cancelada');
                cancelReader();
                if (VP.metricas && typeof VP.metricas.ollamaCanceladas === 'number') VP.metricas.ollamaCanceladas++;
                if (onError) { try { onError(abortErrorValue); } catch (_) {} }
                return Promise.reject(abortErrorValue);
            }
            abortHandler = function () {
                if (settled) return;
                abortErrorValue = abortError('Lectura del stream cancelada');
                cancelReader();
                if (VP.metricas && typeof VP.metricas.ollamaCanceladas === 'number') VP.metricas.ollamaCanceladas++;
                rejectAbort(abortErrorValue);
            };
            if (typeof signal.addEventListener === 'function') {
                signal.addEventListener('abort', abortHandler, { once: true });
            }
        }
        activeRequests++;
        var rejectTimeout;
        var timeoutPromise = new Promise(function (_, reject) { rejectTimeout = reject; });
        timeoutId = setTimeout(function () {
            abortErrorValue = new OllamaError(
                'Timeout al leer la respuesta de Ollama (' + timeoutMs + 'ms)',
                0,
                'TIMEOUT'
            );
            abortErrorValue.name = 'TimeoutError';
            if (VP.metricas && typeof VP.metricas.ollamaTimeouts === 'number') VP.metricas.ollamaTimeouts++;
            cancelReader();
            rejectTimeout(abortErrorValue);
        }, timeoutMs);

        function finish() {
            if (settled) return fullText;
            settled = true;
            cleanup();
            var summary = stats ? stats.summary() : null;
            if (summary) {
                log.info
                    ? log.info('[Ollama] Stream completo:', summary)
                    : console.info('[Ollama] Stream completo:', summary);
            }
            try { onDone(fullText, summary, fullMessage); }
            catch (callbackError) { log.warn('onDone de stream falló:', callbackError); }
            return fullText;
        }

        function step() {
            if (abortErrorValue) return Promise.reject(abortErrorValue);
            var readPromise;
            try { readPromise = Promise.resolve(reader.read()); }
            catch (readError) { return Promise.reject(readError); }
            return readPromise.then(function (result) {
                if (abortErrorValue) throw abortErrorValue;
                if (result.done) {
                    buffer += decoder.decode();
                    if (buffer.trim()) processLines([buffer]);
                    if (!sawDone) {
                        throw new OllamaError('El stream de Ollama terminó sin el marcador done', 0, 'STREAM_INCOMPLETE');
                    }
                    return finish();
                }
                buffer += decoder.decode(result.value, { stream: true });
                if (buffer.length > maxChars + 65536) {
                    throw new OllamaError('El stream contiene una línea demasiado grande', 0, 'STREAM_LIMIT');
                }
                var lines = buffer.split('\n');
                buffer = lines.pop() || '';
                processLines(lines);
                return step();
            });
        }

        function processLines(lines) {
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line) continue;
                try {
                    var json = JSON.parse(line);
                    if (!json || typeof json !== 'object' || Array.isArray(json)) {
                        throw new OllamaError('Mensaje NDJSON inválido de Ollama', 0, 'BAD_RESPONSE');
                    }
                    if (json.error) {
                        throw new OllamaError('Ollama: ' + String(json.error), 0, 'STREAM_ERROR');
                    }
                    if (json.done === true) {
                        sawDone = true;
                        if (stats) {
                            if (typeof json.eval_count === 'number' && isFinite(json.eval_count)) {
                                stats.evalCount = json.eval_count;
                            }
                            if (typeof json.eval_duration === 'number' && isFinite(json.eval_duration)) {
                                stats.evalDurationMs = json.eval_duration / 1e6;
                            }
                        }
                    }
                    // Conserva la respuesta estructurada de /api/chat, incluyendo
                    // tool_calls. Algunos servidores pueden enviar los argumentos
                    // por partes; se combinan por índice, id o posición.
                    if (json.message && typeof json.message === 'object') {
                        if (json.message.role) fullMessage.role = String(json.message.role);
                        if (json.message.tool_calls && Array.isArray(json.message.tool_calls)) {
                            json.message.tool_calls.forEach(function (call, position) {
                                if (!call || typeof call !== 'object') return;
                                var key = call.index != null ? 'index:' + call.index
                                    : (call.id ? 'id:' + call.id : 'position:' + position);
                                var existing = null;
                                for (var ci = 0; ci < fullMessage.tool_calls.length; ci++) {
                                    var current = fullMessage.tool_calls[ci];
                                    var currentKey = current.index != null ? 'index:' + current.index
                                        : (current.id ? 'id:' + current.id : 'position:' + ci);
                                    if (currentKey === key || ci === position) { existing = current; break; }
                                }
                                if (!existing) {
                                    existing = {};
                                    fullMessage.tool_calls.push(existing);
                                }
                                Object.keys(call).forEach(function (prop) {
                                    if (prop !== 'function') { existing[prop] = call[prop]; return; }
                                    var incomingFn = call.function || {};
                                    existing.function = existing.function || {};
                                    Object.keys(incomingFn).forEach(function (fnProp) {
                                        var incoming = incomingFn[fnProp];
                                        var previous = existing.function[fnProp];
                                        if (fnProp === 'arguments' && typeof incoming === 'string' && typeof previous === 'string') {
                                            existing.function[fnProp] = previous + incoming;
                                        } else if (fnProp === 'arguments' && incoming && typeof incoming === 'object' && previous && typeof previous === 'object') {
                                            existing.function[fnProp] = Object.assign({}, previous, incoming);
                                        } else {
                                            existing.function[fnProp] = incoming;
                                        }
                                    });
                                });
                            });
                        }
                    }
                    // /api/chat  → message.content
                    // /api/generate → response
                    var token = json.message
                        ? (json.message.content == null ? '' : String(json.message.content))
                        : (json.response != null ? String(json.response) : '');

                    if (token !== '') {
                        records++;
                        if (records > maxTokens) {
                            throw new OllamaError(
                                'El stream superó el límite de fragmentos (' + maxTokens + ')',
                                0,
                                'STREAM_LIMIT'
                            );
                        }
                        if (fullText.length + token.length > maxChars) {
                            throw new OllamaError('La respuesta superó el límite de texto (' + maxChars + ' caracteres)', 0, 'STREAM_LIMIT');
                        }
                        fullText += token;
                        if (json.message) fullMessage.content += token;
                        if (stats) stats.record(token);
                        onToken(token, fullText);
                    }
                    if (!json.message && json.response != null) fullMessage.content += String(json.response);
                } catch (e) {
                    if (e instanceof OllamaError) throw e;
                    if (!(e instanceof OllamaError)) {
                        throw new OllamaError('Ollama envió una línea NDJSON inválida', 0, 'BAD_RESPONSE');
                    }
                    throw e;
                }
            }
        }

        return Promise.race([step(), timeoutPromise, abortPromise]).then(function (value) {
            activeRequests = Math.max(0, activeRequests - 1);
            return value;
        }, function (err) {
            activeRequests = Math.max(0, activeRequests - 1);
            return fail(abortErrorValue || err);
        });
    }

    /* ═══════════════════════════════════════════════════════════════════
       §6  Caché de modelos con TTL
       ═══════════════════════════════════════════════════════════════════ */

    var _modelCache = {
        _store: Object.create(null), // { baseUrl: { models: [], ts: Date } }
        TTL_MS: 60000,           // 60 s por defecto

        get: function (baseUrl) {
            var entry = this._store[baseUrl];
            if (!entry) return null;
            if (Date.now() - entry.ts > this.TTL_MS) {
                delete this._store[baseUrl];
                return null;
            }
            return entry.models.slice();
        },

        set: function (baseUrl, models) {
            this._store[baseUrl] = { models: Array.isArray(models) ? models.slice() : [], ts: Date.now() };
        },

        invalidate: function (baseUrl) {
            if (baseUrl) delete this._store[baseUrl];
            else this._store = Object.create(null);
        }
    };

    /* ═══════════════════════════════════════════════════════════════════
       §7  fetchModels  (v1 — firma pública; ahora con caché + retry)
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Obtiene la lista de modelos desde /api/tags.
     * Usa caché interna (TTL 60 s). Reintenta en caso de error transitorio.
     *
     * @param {string} baseUrl
     * @param {object} [opts]
     *   @param {AbortSignal} [opts.signal]
     *   @param {number}      [opts.timeout=12000]
     *   @param {boolean}     [opts.cache=true]
     *   @param {number}      [opts.retries=2]
     * @returns {Promise<string[]>}
     */
    function fetchModels(baseUrl, opts) {
        opts = opts || {};
        baseUrl = normalizeBase(baseUrl);
        var timeout  = finiteNumber(opts.timeout, 5000, 1000, 2147483647);
        var useCache = opts.cache !== false;
        var retries  = Math.floor(finiteNumber(opts.retries, 0, 0, 5));

        if (useCache) {
            var cached = _modelCache.get(baseUrl);
            if (cached) return Promise.resolve(cached);
        }

        var url = baseUrl + '/api/tags';

        function attempt(left) {
            return fetchJSON(url, { signal: opts.signal }, timeout)
                .then(function (data) {
                    if (!data || !Array.isArray(data.models)) {
                        throw new OllamaError('Respuesta inválida de /api/tags', 0, 'BAD_RESPONSE');
                    }
                    var models = data.models.map(function (m) {
                        if (typeof m === 'string') return m.trim();
                        if (!m || typeof m !== 'object') return '';
                        var name = typeof m.name === 'string' ? m.name : m.model;
                        return typeof name === 'string' ? name.trim() : '';
                    }).filter(Boolean).filter(function (name, index, all) {
                        return all.indexOf(name) === index;
                    }).sort();
                    if (useCache) _modelCache.set(baseUrl, models);
                    return models;
                })
                .catch(function (err) {
                    if (isAbortError(err) || (err instanceof OllamaError && err.code === 'ABORTED')) {
                        throw err;
                    }
                    if (left > 0 && shouldRetryError(err)) {
                        return sleep(400, opts.signal).then(function () { return attempt(left - 1); });
                    }
                    throw err;
                });
        }

        return attempt(retries);
    }

    /* ═══════════════════════════════════════════════════════════════════
       §8  ping — Health-check ligero
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Comprueba si el servidor Ollama responde.
     * @param {string} baseUrl
     * @param {number} [timeoutMs=5000]
     * @returns {Promise<{ok: boolean, latency_ms: number}>}
     */
    function ping(baseUrl, timeoutMs) {
        baseUrl   = normalizeBase(baseUrl);
        timeoutMs = timeoutMs || 5000;
        var t0 = Date.now();
        return fetchWithTimeout(baseUrl + '/', {}, timeoutMs)
            .then(function (res) {
                return { ok: res.ok, latency_ms: Date.now() - t0, status: res.status };
            })
            .catch(function () {
                return { ok: false, latency_ms: Date.now() - t0, status: 0 };
            });
    }

    /* ═══════════════════════════════════════════════════════════════════
       §9  fetchModelInfo — Detalles de un modelo concreto
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Obtiene metadatos de un modelo vía POST /api/show.
     * @param {string} baseUrl
     * @param {string} modelName
     * @param {object} [opts]
     *   @param {number} [opts.timeout=10000]
     * @returns {Promise<object>}  { modelfile, parameters, template, details, … }
     */
    function fetchModelInfo(baseUrl, modelName, opts) {
        baseUrl   = normalizeBase(baseUrl);
        opts      = opts || {};
        var timeout = finiteNumber(opts.timeout, 10000, 1, 2147483647);
        return fetchJSON(
            baseUrl + '/api/show',
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    safeStringifyBody({ name: validarModelo(modelName) }),
                signal:  opts.signal
            },
            timeout
        );
    }

    /* ═══════════════════════════════════════════════════════════════════
       §10  keepAlive — Mantiene el modelo en VRAM
       Importante para RTX 4060 8 GB: evita recargas costosas.
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Envía una petición vacía para mantener el modelo cargado en GPU.
     * Usa keep_alive en segundos (-1 = indefinido, 0 = descargar).
     *
     * @param {string} baseUrl
     * @param {string} modelName
     * @param {number} [keepAliveSecs=300]  5 min por defecto
     * @returns {Promise<void>}
     */
    function keepAlive(baseUrl, modelName, keepAliveSecs) {
        baseUrl        = normalizeBase(baseUrl);
        keepAliveSecs  = finiteNumber(keepAliveSecs, 300, -1, 2147483647);

        return fetchWithTimeout(
            baseUrl + '/api/generate',
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    safeStringifyBody({
                    model:      validarModelo(modelName),
                    prompt:     '',
                    keep_alive: keepAliveSecs
                })
            },
            8000
        )
        .then(function (res) {
            if (!res.ok) log.warn
                ? log.warn('[Ollama] keepAlive: respuesta no-ok', res.status)
                : console.warn('[Ollama] keepAlive: respuesta no-ok', res.status);
            // Consumir cuerpo para liberar la conexión
            return res.text();
        })
        .catch(function (err) {
            log.warn
                ? log.warn('[Ollama] keepAlive error (ignorado):', err.message)
                : console.warn('[Ollama] keepAlive error (ignorado):', err.message);
        });
    }

    /* ═══════════════════════════════════════════════════════════════════
       §11  Cola de peticiones — Serializa llamadas para no saturar la GPU
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Cola FIFO simple para serializar peticiones a Ollama.
     * Útil cuando hay múltiples agentes o paneles llamando en paralelo.
     */
    function RequestQueue() {
        this._queue    = [];
        this._running  = false;
    }

    /**
     * Encola una función que devuelve una Promise.
     * @param {function(): Promise} fn
     * @returns {Promise<any>}
     */
    RequestQueue.prototype.enqueue = function (fn, opts) {
        var self = this;
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            if (typeof fn !== 'function') {
                reject(new OllamaError('La cola requiere una función', 0, 'BAD_ARGUMENT'));
                return;
            }
            var signal = opts.signal || null;
            if (signal && signal.aborted) {
                reject(abortError('Petición cancelada antes de entrar en la cola'));
                return;
            }
            var maxQueue = Math.floor(finiteNumber(VP.config && VP.config.maxColaOllama, 12, 1, 1000));
            if (self._queue.length >= maxQueue) {
                reject(new OllamaError('Cola de Ollama saturada', 0, 'QUEUE_FULL'));
                return;
            }
            var item = { fn: fn, resolve: resolve, reject: reject, signal: signal, abortHandler: null };
            if (signal && typeof signal.addEventListener === 'function') {
                item.abortHandler = function () {
                    var index = self._queue.indexOf(item);
                    if (index < 0) return;
                    self._queue.splice(index, 1);
                    try { signal.removeEventListener('abort', item.abortHandler); } catch (_) {}
                    item.reject(abortError('Petición cancelada mientras esperaba en la cola'));
                };
                signal.addEventListener('abort', item.abortHandler, { once: true });
            }
            self._queue.push(item);
            if (!self._running) self._run();
        });
    };

    RequestQueue.prototype._run = function () {
        if (this._queue.length === 0) { this._running = false; return; }
        this._running = true;
        var self = this;
        var item = this._queue.shift();
        if (item.signal && item.abortHandler) {
            try { item.signal.removeEventListener('abort', item.abortHandler); } catch (_) {}
        }
        Promise.resolve()
            .then(function () {
                if (item.signal && item.signal.aborted) throw abortError('Petición cancelada antes de ejecutarse');
                return item.fn();
            })
            .then(function (v) { item.resolve(v); })
            .catch(function (e) { item.reject(e); })
            .then(function () { self._run(); });
    };

    /** Número de peticiones pendientes (sin contar la activa). */
    RequestQueue.prototype.size = function () { return this._queue.length; };

    /** Indica si hay una petición activa o esperando en esta cola. */
    RequestQueue.prototype.isBusy = function () {
        return this._running || this._queue.length > 0;
    };

    /**
     * Ejecuta una tarea sólo cuando la cola está completamente libre.
     * La comprobación y reserva ocurren de forma síncrona para evitar
     * carreras entre isBusy() y enqueue(). La tarea no se agrega detrás
     * de solicitudes existentes.
     */
    RequestQueue.prototype.runIfIdle = function (fn) {
        var self = this;
        if (typeof fn !== 'function') {
            return Promise.reject(new OllamaError('runIfIdle requiere una función', 0, 'BAD_ARGUMENT'));
        }
        if (self.isBusy()) return Promise.resolve({ busy: true });
        self._running = true;
        return Promise.resolve().then(fn).then(function (value) {
            self._run();
            return { busy: false, value: value };
        }, function (err) {
            self._run();
            throw err;
        });
    };

    RequestQueue.prototype.stats = function () {
        return {
            pending: this._queue.length,
            running: this._running,
            limit: Math.floor(finiteNumber(VP.config && VP.config.maxColaOllama, 12, 1, 1000))
        };
    };

    /** Vacía la cola (las pendientes rechazarán con un OllamaError). */
    RequestQueue.prototype.clear = function () {
        var err = new OllamaError('Cola vaciada', 0, 'QUEUE_CLEARED');
        while (this._queue.length) {
            var item = this._queue.shift();
            if (item.signal && item.abortHandler) {
                try { item.signal.removeEventListener('abort', item.abortHandler); } catch (_) {}
            }
            item.reject(err);
        }
    };

    /* Cola global predeterminada */
    var defaultQueue = new RequestQueue();

    /* ═══════════════════════════════════════════════════════════════════
       §12  withRetry — Envuelve cualquier función con reintentos
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Reintenta fn() hasta maxAttempts veces con backoff exponencial.
     * @param {function(): Promise} fn
     * @param {object} [opts]
     *   @param {number} [opts.maxAttempts=3]
     *   @param {number} [opts.baseDelayMs=500]
     *   @param {number} [opts.maxDelayMs=8000]
     *   @param {function(Error,number): boolean} [opts.shouldRetry]  retorna true si debe reintentar
     * @returns {Promise<any>}
     */
    var retryWarningsByMessage = Object.create(null);
    var retryWarningWindowMs = 10000;

    // Mantiene visible el primer aviso de reintento y resume las repeticiones
    // idénticas en una sola línea al cerrar la ventana de agrupación.
    function warnRetryGrouped(message) {
        var key = String(message || 'Error de Ollama');
        if (log.warnGrouped) {
            log.warnGrouped('ollama-retry:' + key, '[Ollama] ' + key);
            return;
        }
        var entry = retryWarningsByMessage[key];
        if (entry) {
            entry.count++;
            return;
        }

        entry = retryWarningsByMessage[key] = { count: 1, message: key };
        if (log.warn) log.warn('[Ollama] ' + key);
        else if (typeof console !== 'undefined' && console.warn) console.warn('[Ollama] ' + key);

        setTimeout(function () {
            if (retryWarningsByMessage[key] !== entry) return;
            delete retryWarningsByMessage[key];
            if (entry.count < 2) return;
            var resumen = '[Ollama] Aviso repetido ' + entry.count + ' veces en ' +
                Math.round(retryWarningWindowMs / 1000) + 's — ' + entry.message;
            if (log.warn) log.warn(resumen);
            else if (typeof console !== 'undefined' && console.warn) console.warn(resumen);
        }, retryWarningWindowMs);
    }

    function withRetry(fn, opts) {
        opts = opts || {};
        if (typeof fn !== 'function') {
            return Promise.reject(new OllamaError('withRetry requiere una función', 0, 'BAD_ARGUMENT'));
        }
        var maxAttempts  = Math.floor(finiteNumber(opts.maxAttempts, 3, 1, 20));
        var baseDelayMs  = finiteNumber(opts.baseDelayMs, 500, 0, 60000);
        var maxDelayMs   = finiteNumber(opts.maxDelayMs, 8000, baseDelayMs, 120000);
        var jitterMs     = finiteNumber(opts.jitterMs, 120, 0, 10000);
        var signal       = opts.signal || null;
        var shouldRetry  = opts.shouldRetry  || function (err) {
            return shouldRetryError(err);
        };

        function waitBeforeRetry(delay) {
            return new Promise(function (resolve, reject) {
                if (signal && signal.aborted) {
                    reject(abortError('Petición cancelada durante el reintento'));
                    return;
                }
                var timer = setTimeout(done, delay);
                function done() {
                    if (signal && abortHandler) {
                        try { signal.removeEventListener('abort', abortHandler); } catch (_) {}
                    }
                    resolve();
                }
                var abortHandler = null;
                if (signal && typeof signal.addEventListener === 'function') {
                    abortHandler = function () {
                        clearTimeout(timer);
                        try { signal.removeEventListener('abort', abortHandler); } catch (_) {}
                        reject(abortError('Petición cancelada durante el reintento'));
                    };
                    signal.addEventListener('abort', abortHandler, { once: true });
                }
            });
        }

        function attempt(n) {
            if (signal && signal.aborted) return Promise.reject(abortError('Petición cancelada'));
            return Promise.resolve().then(fn).catch(function (err) {
                if (signal && signal.aborted) throw abortError('Petición cancelada');
                var retryable = false;
                try { retryable = !!shouldRetry(err, n); }
                catch (retryCheckError) { throw retryCheckError; }
                if (n >= maxAttempts || !retryable) {
                    if (n > 1) {
                        throw new RetryError(
                            'Fallaron ' + n + ' intentos: ' + (err && err.message ? err.message : String(err)), err, n
                        );
                    }
                    throw err;
                }
                var delay = Math.min(baseDelayMs * Math.pow(2, n - 1), maxDelayMs);
                if (jitterMs > 0) delay += Math.floor(Math.random() * jitterMs);
                var message = err && err.message ? err.message : String(err);
                warnRetryGrouped('Reintento ' + n + '/' + maxAttempts + ' en ' + delay + 'ms — ' + message);
                return waitBeforeRetry(delay).then(function () { return attempt(n + 1); });
            });
        }

        return attempt(1);
    }

    function validarModelo(modelo) {
        if (!modelo || typeof modelo !== 'string' || !modelo.trim()) {
            throw new OllamaError('Modelo de Ollama no especificado', 0, 'BAD_ARGUMENT');
        }
        return modelo.trim();
    }

    function normalizarMensajes(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            throw new OllamaError('chat requiere al menos un mensaje', 0, 'BAD_ARGUMENT');
        }
        var normalizados = messages.map(function (m) {
            if (!m || typeof m !== 'object') {
                return { role: 'user', content: String(m || '') };
            }
            var normalized = Object.assign({}, m);
            normalized.role = typeof m.role === 'string' ? m.role.trim() : 'user';
            if (!normalized.role) normalized.role = 'user';
            if (['system', 'user', 'assistant', 'tool'].indexOf(normalized.role) === -1) {
                throw new OllamaError('Rol de mensaje inválido: ' + normalized.role, 0, 'BAD_ARGUMENT');
            }
            normalized.content = m.content == null ? '' : String(m.content);
            if (m.images != null && !Array.isArray(m.images)) {
                throw new OllamaError('Las imágenes del mensaje deben ser un array', 0, 'BAD_ARGUMENT');
            }
            return normalized;
        }).filter(function (m) {
            return m.content.trim() !== '' || (Array.isArray(m.images) && m.images.length > 0) ||
                (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) || !!m.tool_name;
        });
        if (normalizados.length === 0) {
            throw new OllamaError('chat no tiene contenido útil para enviar', 0, 'BAD_ARGUMENT');
        }
        return normalizados;
    }

    /* ═══════════════════════════════════════════════════════════════════
       §13  chat — Wrapper de alto nivel para /api/chat
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Llama al endpoint /api/chat con soporte completo de streaming.
     * Internamente aplica la cola global y reintentos.
     *
     * @param {string} baseUrl
     * @param {object} params
     *   @param {string}   params.model               Nombre del modelo
     *   @param {object[]} params.messages             Array de mensajes {role, content}
     *   @param {boolean}  [params.stream=true]
     *   @param {object}   [params.options]            Opciones Ollama: temperature, top_p, …
     *   @param {number}   [params.keep_alive]         Segundos en VRAM tras la llamada
     * @param {object} [callbacks]                     Igual que readStream()
     * @param {object} [requestOpts]
     *   @param {number}   [requestOpts.timeout=120000]
     *   @param {number}   [requestOpts.retries=2]
     *   @param {boolean}  [requestOpts.queued=true]
     * @returns {Promise<string>} Texto completo generado
     */
    function chat(baseUrl, params, callbacks, requestOpts) {
        baseUrl     = normalizeBase(baseUrl);
        params      = params && typeof params === 'object' ? Object.assign({}, params) : {};
        callbacks   = callbacks   || {};
        requestOpts = requestOpts || {};

        params.model = validarModelo(params.model);
        params.messages = normalizarMensajes(params.messages);

        var timeout = finiteNumber(requestOpts.timeout, 120000, 1000, 2147483647);
        var retries = Math.floor(finiteNumber(requestOpts.retries, 2, 0, 19));
        var queued  = requestOpts.queued  !== false;

        var body = Object.assign({ stream: true }, params);
        var emittedOutput = false;
        var originalOnToken = callbacks.onToken;
        var streamCallbacks = Object.assign({ trackStats: true, timeout: timeout }, callbacks, {
            onToken: function (token, fullText) {
                if (token) emittedOutput = true;
                if (typeof originalOnToken === 'function') originalOnToken(token, fullText);
            }
        });

        function doRequest() {
            return withRetry(function () {
                var requestOptions = {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    safeStringifyBody(body),
                    signal:  callbacks.signal
                };
                if (!body.stream) {
                    return fetchJSON(baseUrl + '/api/chat', requestOptions, timeout).then(function (data) {
                        if (!data || typeof data !== 'object') {
                            throw new OllamaError('Respuesta inválida de /api/chat', 0, 'BAD_RESPONSE');
                        }
                        if (typeof callbacks.onResponse === 'function') {
                            try { callbacks.onResponse(data); }
                            catch (callbackError) { log.warn('onResponse de chat falló:', callbackError); }
                        }
                        var text = data.message ? (data.message.content == null ? '' : String(data.message.content)) : '';
                        if (typeof callbacks.onDone === 'function') {
                            try { callbacks.onDone(text, null, data.message || { role: 'assistant', content: text }); }
                            catch (callbackError) { log.warn('onDone de chat falló:', callbackError); }
                        }
                        return text;
                    });
                }
                return fetchWithTimeout(
                    baseUrl + '/api/chat',
                    requestOptions,
                    timeout
                ).then(function (res) {
                    if (!res.ok) {
                        return httpErrorFromResponse(res).then(function (e) { throw e; });
                    }
                    return readStream(res.body, streamCallbacks);
                });
            }, {
                maxAttempts: retries + 1,
                signal: callbacks.signal,
                shouldRetry: function (err) { return !emittedOutput && shouldRetryError(err); }
            });
        }

        return queued ? defaultQueue.enqueue(doRequest, { signal: callbacks.signal }) : doRequest();
    }

    /* ═══════════════════════════════════════════════════════════════════
       §14  generate — Wrapper de alto nivel para /api/generate
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Llama al endpoint /api/generate (completion clásico).
     *
     * @param {string} baseUrl
     * @param {object} params
     *   @param {string}  params.model
     *   @param {string}  params.prompt
     *   @param {string}  [params.system]
     *   @param {string}  [params.template]
     *   @param {boolean} [params.stream=true]
     *   @param {object}  [params.options]
     *   @param {number}  [params.keep_alive]
     * @param {object} [callbacks]  mismo contrato que readStream()
     * @param {object} [requestOpts]
     * @returns {Promise<string>}
     */
    function generate(baseUrl, params, callbacks, requestOpts) {
        baseUrl     = normalizeBase(baseUrl);
        params      = params && typeof params === 'object' ? Object.assign({}, params) : {};
        callbacks   = callbacks   || {};
        requestOpts = requestOpts || {};

        params.model = validarModelo(params.model);
        params.prompt = params.prompt == null ? '' : String(params.prompt);

        var timeout = finiteNumber(requestOpts.timeout, 120000, 1000, 2147483647);
        var retries = Math.floor(finiteNumber(requestOpts.retries, 2, 0, 19));
        var queued  = requestOpts.queued  !== false;

        var body = Object.assign({ stream: true }, params);
        var emittedOutput = false;
        var originalOnToken = callbacks.onToken;
        var streamCallbacks = Object.assign({ trackStats: true, timeout: timeout }, callbacks, {
            onToken: function (token, fullText) {
                if (token) emittedOutput = true;
                if (typeof originalOnToken === 'function') originalOnToken(token, fullText);
            }
        });

        function doRequest() {
            return withRetry(function () {
                var requestOptions = {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    safeStringifyBody(body),
                    signal:  callbacks.signal
                };
                if (!body.stream) {
                    return fetchJSON(baseUrl + '/api/generate', requestOptions, timeout).then(function (data) {
                        if (!data || typeof data !== 'object') {
                            throw new OllamaError('Respuesta inválida de /api/generate', 0, 'BAD_RESPONSE');
                        }
                        var text = data.response == null ? '' : String(data.response);
                        if (typeof callbacks.onDone === 'function') {
                            try { callbacks.onDone(text, null); }
                            catch (callbackError) { log.warn('onDone de generate falló:', callbackError); }
                        }
                        return text;
                    });
                }
                return fetchWithTimeout(
                    baseUrl + '/api/generate',
                    requestOptions,
                    timeout
                ).then(function (res) {
                    if (!res.ok) {
                        return httpErrorFromResponse(res).then(function (e) { throw e; });
                    }
                    return readStream(res.body, streamCallbacks);
                });
            }, {
                maxAttempts: retries + 1,
                signal: callbacks.signal,
                shouldRetry: function (err) { return !emittedOutput && shouldRetryError(err); }
            });
        }

        return queued ? defaultQueue.enqueue(doRequest, { signal: callbacks.signal }) : doRequest();
    }

    /* ═══════════════════════════════════════════════════════════════════
       §15  embed — Embeddings vía /api/embed  (Ollama ≥ 0.1.26)
       ═══════════════════════════════════════════════════════════════════ */

    /**
     * Genera embeddings para uno o varios textos.
     * Útil para búsqueda semántica local.
     *
     * @param {string}          baseUrl
     * @param {string}          modelName   Modelo con soporte de embeddings
     * @param {string|string[]} input       Texto o array de textos
     * @param {object}          [opts]
     *   @param {number}  [opts.timeout=30000]
     *   @param {object}  [opts.options]     Opciones extras (truncate, etc.)
     * @returns {Promise<number[][]>}        Array de vectores
     */
    function embed(baseUrl, modelName, input, opts) {
        baseUrl = normalizeBase(baseUrl);
        opts    = opts || {};
        var timeout = finiteNumber(opts.timeout, 30000, 1000, 2147483647);
        if (typeof input !== 'string' && !Array.isArray(input)) {
            return Promise.reject(new OllamaError('embed requiere texto o un array de textos', 0, 'BAD_ARGUMENT'));
        }
        if (typeof input === 'string' && !input.trim()) {
            return Promise.reject(new OllamaError('embed requiere texto no vacío', 0, 'BAD_ARGUMENT'));
        }
        if (Array.isArray(input) && !input.length) {
            return Promise.reject(new OllamaError('embed requiere al menos un texto', 0, 'BAD_ARGUMENT'));
        }
        if (Array.isArray(input) && input.some(function (item) { return typeof item !== 'string'; })) {
            return Promise.reject(new OllamaError('Todos los elementos de input deben ser texto', 0, 'BAD_ARGUMENT'));
        }
        if (Array.isArray(input) && input.some(function (item) { return !item.trim(); })) {
            return Promise.reject(new OllamaError('Todos los elementos de input deben contener texto', 0, 'BAD_ARGUMENT'));
        }
        var expectedCount = Array.isArray(input) ? input.length : 1;

        var body = {
            model:  validarModelo(modelName),
            input:  input,
        };
        if (opts.options) body.options = opts.options;

        return fetchJSON(
            baseUrl + '/api/embed',
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    safeStringifyBody(body),
                signal:  opts.signal
            },
            timeout
        )
        .then(function (data) {
            if (!data || !Array.isArray(data.embeddings) || data.embeddings.length !== expectedCount ||
                data.embeddings.some(function (embedding) {
                    return !Array.isArray(embedding) || !embedding.length || embedding.some(function (value) {
                        return typeof value !== 'number' || !isFinite(value);
                    });
                })) {
                throw new OllamaError('Respuesta de embeddings inválida', 0, 'BAD_RESPONSE');
            }
            var dimensions = data.embeddings[0].length;
            if (data.embeddings.some(function (embedding) { return embedding.length !== dimensions; })) {
                throw new OllamaError('Dimensiones inconsistentes en la respuesta de embeddings', 0, 'BAD_RESPONSE');
            }
            return data.embeddings; // number[][]
        });
    }

    /* ═══════════════════════════════════════════════════════════════════
       §16  API PÚBLICA
       ═══════════════════════════════════════════════════════════════════ */

    VP.ollama = {
        /* ── v1 — compatibilidad total ── */
        fetchWithTimeout: fetchWithTimeout,
        fetchJSON:        fetchJSON,
        readStream:       readStream,
        fetchModels:      fetchModels,

        /* ── v2 — nuevas utilidades ── */
        normalizeBase:     normalizeBase,
        isAbortError:      isAbortError,
        isRetryableError:  shouldRetryError,
        ping:             ping,
        fetchModelInfo:   fetchModelInfo,
        keepAlive:        keepAlive,
        withRetry:        withRetry,
        chat:             chat,
        generate:         generate,
        embed:            embed,

        /* ── Clases exportadas ── */
        OllamaError:      OllamaError,
        RetryError:       RetryError,
        StreamStats:      StreamStats,
        RequestQueue:     RequestQueue,

        /* ── Cola global (reutilizable o reemplazable) ── */
        queue:            defaultQueue,
        isBusy:           function () { return defaultQueue.isBusy() || activeRequests > 0; },
        runIfIdle:        function (fn) {
            if (defaultQueue.isBusy() || activeRequests > 0) return Promise.resolve({ busy: true });
            return defaultQueue.runIfIdle(fn);
        },

        /* ── Caché de modelos ── */
        modelCache:       _modelCache,

        /* ── Meta ── */
        version: '2.2.0'
    };

    if (typeof VP.registrarModulo === 'function') {
        VP.registrarModulo('ollama', {
            version: VP.ollama.version,
            critico: false,
            endpoints: ['/api/tags', '/api/chat', '/api/generate', '/api/embed']
        });
    }

    log.info
        ? log.info('[VP] vp-ollama-client v2.2 cargado OK')
        : console.info('[VP] vp-ollama-client v2.2 cargado OK');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-ollama-client.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})();
