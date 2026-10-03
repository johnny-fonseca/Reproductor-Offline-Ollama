/* ==========================================================================
       4. CLIENTE DE OLLAMA — con personalidad Mochi   (v2.0.0, reforzado)
       --------------------------------------------------------------------------
       Responsabilidades de este módulo:
         - Definir los textos/instrucciones (prompts) que Mochi usa para comentar
           los subtítulos del video, según el idioma configurado.
         - Proveer un cliente de Ollama autónomo de respaldo (fetch + timeout +
           reintentos con backoff) por si `VP.ollama` no viene ya inyectado.
         - Construir el prompt a partir del contexto de subtítulos, enviarlo al
           modelo y validar/depurar la respuesta antes de mostrarla.
         - Proteger al reproductor de fallos en cascada (disyuntor), llevar
           estadísticas de uso y ofrecer diagnóstico (conexión, modelos).

       Dependencias esperadas en `window.VP` (todas opcionales y con fallback
       seguro, para que un entorno incompleto no rompa el módulo):
         - VP.mochiConfig        { idioma, endpoint, model, ... }
         - VP._mochiUtil         { warn, pickRandom, consoleEvent, storageGet,
                                   normalizeWhitespace, truncate,
                                   safeJsonStringify, describeError }
         - VP.mochiParametro(nombre)      -> valor de configuración
         - VP.mochiPerfilActual()         -> { tono, promptFormato, promptSistema,
                                               humor, validarRespuesta }
         - VP.mochiMascota.setState(estado)
         - VP.mochiScheduler.puedeReintentar(video, t, ms, factor)
         - VP.ollama             cliente externo opcional con la forma
                                  { isBusy(), runIfIdle(tarea), chat(endpoint, body, ctx, opts) }

       Claves opcionales de VP.mochiConfig reconocidas por este módulo:
         maxEndpointLength (512)      maxModelLength (128)
         maxPromptChars (8000)        maxContextChars (20000)
         maxRawResponseChars (20000)  keepAliveLimpieza (0)
         circuitBreakerThreshold (5)  circuitBreakerCooldownMs (30000)
         featureFlags.promptHardening / featureFlags.circuitBreaker

       Este archivo no depende de sintaxis moderna (usa `var` y funciones
       clásicas) para mantener compatibilidad con el resto de la base de código.
       ========================================================================== */
    (function (window) {
        'use strict';
        var VP = window && window.VP;
        if (!VP) return;

        var VERSION_MODULO = '2.0.0';

        var VALORES_POR_DEFECTO = {
            idioma: 'es',
            endpoint: 'http://localhost:11434',
            model: 'llama3'
        };

        // Constantes de comportamiento (ajustables sin tocar la lógica).
        var VENTANA_COMENTARIO_SEGUNDOS = 20;
        var LIMPIEZA_INTENTOS_OCUPADO = 20;
        var LIMPIEZA_ESPERA_MS = 300;
        var DIAGNOSTICO_TIMEOUT_MS = 5000;

        var INSTRUCCIONES_REINTENTO = 'Reacciona al mismo subtítulo desde otro ángulo. Mismas reglas que antes: no menciones el subtítulo ni su brevedad, no hables del "comentario" ni del "narrador", reacciona a lo que ocurre en la escena. Enfócate en un elemento distinto: personaje, lugar, consecuencia o emoción. No empieces con "Mochi observa" ni hables de Mochi en tercera persona.';

        var INSTRUCCIONES_PERSONALIDAD = {
            'chispita': ' Usa frases vivas y expresivas cuando el fragmento lo permita, sin forzar entusiasmo ni cambiar el humor elegido.',
            'traviesa': ' Usa giros ingeniosos solo si nacen del fragmento; no fuerces bromas ni cambies el humor elegido.',
            'mimosa': ' Mantén una voz amable y cercana, sin añadir ternura emocional ni cambiar el humor elegido.',
            'dulce-curiosa': ' Mantén una voz amable y cercana, sin predeterminar la emoción del comentario.'
        };

        var CAMPOS_METRICAS = [
            'total_duration', 'load_duration', 'prompt_eval_count',
            'prompt_eval_duration', 'eval_count', 'eval_duration'
        ];

        // --------------------------------------------------------------------
        // Utilidades del host, envueltas para que un fallo en ellas nunca
        // interrumpa la generación de un comentario.
        // --------------------------------------------------------------------
        var U = VP._mochiUtil || {};

        function envolverSeguro(fn, respaldo) {
            if (typeof fn !== 'function') return respaldo;
            return function () {
                try { return fn.apply(U, arguments); }
                catch (_) { return respaldo.apply(null, arguments); }
            };
        }

        function describeErrorBasico(e) {
            return {
                nombre: (e && e.name) || 'Error',
                mensaje: (e && e.message) || String(e || ''),
                codigo: (e && e.code) || null,
                estado: (e && e.status) || null
            };
        }

        var warn = envolverSeguro(U.warn, function () {});
        var pickRandom = envolverSeguro(U.pickRandom, function (a) { return (a && a[0]) || ''; });
        var consoleEvent = envolverSeguro(U.consoleEvent, function () {});
        var normalizeWhitespace = envolverSeguro(U.normalizeWhitespace, function (s) {
            return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        });
        var truncate = envolverSeguro(U.truncate, function (s, n) {
            s = String(s == null ? '' : s);
            return s.length <= n ? s : s.slice(0, n) + '…';
        });
        var safeJsonStringify = envolverSeguro(U.safeJsonStringify, function (v, defecto) {
            try {
                var s = JSON.stringify(v);
                return typeof s === 'string' ? s : (defecto != null ? defecto : '');
            } catch (_) { return defecto != null ? defecto : ''; }
        });
        var describeError = envolverSeguro(U.describeError, describeErrorBasico);

        function copiarObjeto(origen) {
            var copia = {};
            if (origen && typeof origen === 'object') {
                for (var clave in origen) {
                    if (Object.prototype.hasOwnProperty.call(origen, clave)) copia[clave] = origen[clave];
                }
            }
            return copia;
        }

        function mezclarObjetos(base, extra) {
            for (var clave in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, clave)) base[clave] = extra[clave];
            }
            return base;
        }

        // --------------------------------------------------------------------
        // Configuración: se completa campo por campo con valores por defecto.
        // --------------------------------------------------------------------
        var CFG = VP.mochiConfig;
        if (!CFG || typeof CFG !== 'object') {
            CFG = VP.mochiConfig = copiarObjeto(VALORES_POR_DEFECTO);
        } else {
            ['idioma', 'endpoint', 'model'].forEach(function (clave) {
                if (!CFG[clave]) {
                    warn('VP.mochiConfig.' + clave + ' no está definido; se usará "' + VALORES_POR_DEFECTO[clave] + '".');
                    CFG[clave] = VALORES_POR_DEFECTO[clave];
                }
            });
        }

        // Wrappers perezosos: se resuelven en cada llamada, así el módulo no
        // depende del orden de carga de los demás archivos del host.
        function mochiParametro(nombre) {
            try {
                return typeof VP.mochiParametro === 'function' ? VP.mochiParametro(nombre) : undefined;
            } catch (e) {
                warn('No se pudo leer el parámetro "' + nombre + '": ' + (e && e.message));
                return undefined;
            }
        }

        function mochiPerfilActual() {
            try {
                var perfil = typeof VP.mochiPerfilActual === 'function' ? VP.mochiPerfilActual() : null;
                return (perfil && typeof perfil === 'object') ? perfil : {};
            } catch (e) {
                warn('No se pudo obtener el perfil actual de Mochi: ' + (e && e.message));
                return {};
            }
        }

        function estadoMascota(estado) {
            try {
                if (VP.mochiMascota && typeof VP.mochiMascota.setState === 'function') VP.mochiMascota.setState(estado);
            } catch (_) {}
        }

        // --------------------------------------------------------------------
        // Números y errores
        // --------------------------------------------------------------------

        /**
         * Convierte un valor arbitrario en número finito, o `undefined` si no es
         * válido. `null`, cadenas vacías y booleanos se consideran ausentes (no
         * deben convertirse en 0 ni 1), para no enviar datos corruptos a Ollama:
         * es preferible omitir la opción y dejar que use su valor por defecto.
         */
        function numeroValido(valor) {
            if (valor === null || valor === undefined || typeof valor === 'boolean') return undefined;
            if (typeof valor === 'string' && valor.trim() === '') return undefined;
            var n = Number(valor);
            return isFinite(n) ? n : undefined;
        }

        function numeroEnRango(valor, min, max) {
            var n = numeroValido(valor);
            if (n === undefined) return undefined;
            return Math.min(max, Math.max(min, n));
        }

        function enteroEnRango(valor, min, max) {
            var n = numeroEnRango(valor, min, max);
            return n === undefined ? undefined : Math.round(n);
        }

        /** Lee un número positivo de VP.mochiConfig o devuelve el valor por defecto. */
        function cfgNum(nombre, defecto) {
            var n = numeroValido(CFG[nombre]);
            return (n !== undefined && n > 0) ? n : defecto;
        }

        function crearError(codigo, mensaje, nombre) {
            var err = new Error(mensaje);
            err.code = codigo;
            if (nombre) err.name = nombre;
            return err;
        }

        /** Etiqueta con `code` los errores de red que el navegador no clasifica. */
        function clasificarError(error) {
            if (error && typeof error === 'object' && !error.code &&
                /failed to fetch|networkerror|network request failed|load failed|refused|econnrefused/i.test(String(error.message))) {
                error.code = 'CONN_REFUSED';
            }
            return error;
        }

        /** true si el error proviene de una cancelación externa (no de un fallo real). */
        function esCancelacion(error) {
            return !!error && (error.code === 'CANCELLED' || (error.name === 'AbortError' && error.code !== 'TIMEOUT'));
        }

        function codigoDeEstado(status) {
            if (status === 404) return 'MODEL_NOT_FOUND';
            if (status === 400) return 'BAD_REQUEST';
            if (status === 401 || status === 403) return 'AUTH';
            if (status === 429) return 'RATE_LIMITED';
            if (status >= 500) return 'SERVER_ERROR';
            return 'HTTP_ERROR';
        }

        // --------------------------------------------------------------------
        // Estadísticas y disyuntor (circuit breaker)
        //
        // Tras N fallos consecutivos de red/servidor se "abre" el disyuntor y
        // se dejan de enviar peticiones durante un enfriamiento, para no
        // saturar un Ollama caído ni llenar la consola de errores. Pasado el
        // enfriamiento se permite un intento: si funciona, se cierra; si
        // falla, se vuelve a abrir de inmediato.
        // --------------------------------------------------------------------
        function crearEstadisticas() {
            return {
                solicitudes: 0,
                exitosas: 0,
                omitidas: 0,
                invalidas: 0,
                ocupado: 0,
                errores: 0,
                reintentosModelo: 0,
                reintentosRed: 0,
                latenciaTotalMs: 0,
                respuestasMedidas: 0,
                ultimaLatenciaMs: null,
                ultimoError: null,
                ultimoExitoEn: null,
                erroresConsecutivos: 0
            };
        }

        var estadisticas = crearEstadisticas();
        var disyuntor = { abiertoHasta: 0, aperturas: 0 };

        function disyuntorHabilitado() {
            return !(CFG.featureFlags && CFG.featureFlags.circuitBreaker === false);
        }

        function estadoDisyuntor() {
            var restante = disyuntor.abiertoHasta - Date.now();
            return {
                habilitado: disyuntorHabilitado(),
                abierto: disyuntorHabilitado() && restante > 0,
                restanteMs: restante > 0 ? restante : 0,
                aperturas: disyuntor.aperturas
            };
        }

        function registrarExito(ms) {
            estadisticas.erroresConsecutivos = 0;
            estadisticas.ultimoExitoEn = Date.now();
            estadisticas.ultimaLatenciaMs = ms;
            estadisticas.latenciaTotalMs += ms;
            estadisticas.respuestasMedidas++;
            disyuntor.abiertoHasta = 0;
        }

        function registrarFallo(error) {
            if (esCancelacion(error)) return;
            estadisticas.errores++;
            estadisticas.erroresConsecutivos++;
            estadisticas.ultimoError = { error: describeError(error), en: Date.now() };
            var umbral = Math.max(1, Math.floor(cfgNum('circuitBreakerThreshold', 5)));
            if (disyuntorHabilitado() && estadisticas.erroresConsecutivos >= umbral) {
                var enfriamiento = cfgNum('circuitBreakerCooldownMs', 30000);
                disyuntor.abiertoHasta = Date.now() + enfriamiento;
                disyuntor.aperturas++;
                consoleEvent('ollama_circuito_abierto', {
                    erroresConsecutivos: estadisticas.erroresConsecutivos,
                    enfriamientoMs: enfriamiento,
                    ultimoError: truncate(String((error && error.message) || error || ''), 200)
                }, 'warn');
            }
        }

        function contabilizarResultado(resultado) {
            if (!resultado || resultado.busy) return;
            if (resultado.text) estadisticas.exitosas++;
            else if (resultado.validationErrors && resultado.validationErrors.length) estadisticas.invalidas++;
            else estadisticas.omitidas++;
        }

        function obtenerEstadisticas() {
            var copia = copiarObjeto(estadisticas);
            copia.latenciaMediaMs = estadisticas.respuestasMedidas
                ? Math.round(estadisticas.latenciaTotalMs / estadisticas.respuestasMedidas)
                : null;
            copia.disyuntor = estadoDisyuntor();
            return copia;
        }

        // --------------------------------------------------------------------
        // Detección de respuestas "meta" (el modelo habla del prompt, no de la escena)
        // --------------------------------------------------------------------
        var patronesRespuestaMeta = [
            /\bcomentarios previos presentes\b/,
            /\bsin subtitulos? (en )?formato valido\b/,
            /\bpara analisis escenico\b/,
            /\bno hay subtitulos? validos?\b/,
            /\bno puedo analizar\b/,
            /\bcomo modelo de lenguaje\b/,
            /\bsegun las instrucciones\b/,
            /\bformato json\b/,
            /\bdebo devolver\b/,
            /\bno has proporcionado\b/,
            /\bcontexto (proporcionado|recibido)\b/,
            /\bprompt\b/,
            /\bnada que comentar\b/,
            /\bes muy breve\b/,
            /\b(un|el) comentario sobre\b/,
            /\bmochi comenta\b/,
            /\b\d+[–-]\d+ frases\b/,
            /\bmaximo \d+ (caracteres|chars)\b/,
            /\bvideo, ficcion, documental\b/
        ];

        function esRespuestaMeta(texto) {
            var normalizado = normalizeWhitespace(texto).toLowerCase();
            try {
                if (typeof normalizado.normalize === 'function') {
                    normalizado = normalizado.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                }
            } catch (_) {}
            return patronesRespuestaMeta.some(function (patron) { return patron.test(normalizado); });
        }

        // --------------------------------------------------------------------
        // Textos por idioma
        // --------------------------------------------------------------------
        var TEXTOS = {
            es: {
                instruccionesVariantes: [''],
                historial: 'Comentarios anteriores (solo para evitar repetir una idea):',
                sinTitulo: 'sin título',
                // Texto adicional de endurecimiento del prompt contra inyección.
                hardening: ''
            }
        };

        /**
         * Devuelve el diccionario de textos para el idioma configurado, cayendo
         * de vuelta a español si el idioma no existe o no está definido.
         */
        function textos() {
            var idioma = (CFG.idioma && TEXTOS[CFG.idioma]) ? CFG.idioma : 'es';
            return TEXTOS[idioma] || TEXTOS.es;
        }

        /**
         * Lee un ajuste persistido de forma segura; si `storageGet` no existe o
         * lanza una excepción (p. ej. almacenamiento deshabilitado), se
         * devuelve el valor por defecto sin propagar el error.
         */
        function setting(key, fallback) {
            try {
                return U.storageGet ? U.storageGet(key, fallback) : fallback;
            } catch (e) {
                warn('No se pudo leer el ajuste "' + key + '": ' + (e && e.message));
                return fallback;
            }
        }

        /** Lee el valor de un campo de la UI si el DOM existe (no falla en workers/tests). */
        function leerCampoUI(id) {
            try {
                if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return '';
                var el = document.getElementById(id);
                return (el && typeof el.value === 'string') ? el.value : '';
            } catch (_) { return ''; }
        }

        // --------------------------------------------------------------------
        // Endpoint y modelo
        // --------------------------------------------------------------------

        /**
         * Normaliza una URL de Ollama: recorta espacios y barras finales, quita
         * un sufijo /api o /api/chat pegado por error y exige http(s). Devuelve
         * '' si el valor no es utilizable.
         */
        function normalizarEndpoint(valor, maxLen) {
            if (typeof valor !== 'string') return '';
            var v = valor.trim().replace(/\/+$/, '');
            var sinApi = v.replace(/\/api(?:\/(?:chat|generate|tags|version))?$/i, '').replace(/\/+$/, '');
            if (/^https?:\/\/[^\/\s]+/i.test(sinApi)) v = sinApi;
            if (!v || v.length > maxLen) return '';
            return /^https?:\/\/[^\s]+$/i.test(v) ? v : '';
        }

        var PATRON_MODELO = /^[A-Za-z0-9][\w.\-:\/@+]*$/;

        function normalizarModelo(valor, maxLen) {
            if (typeof valor !== 'string') return '';
            var v = valor.trim();
            if (!v || v.length > maxLen) return '';
            return PATRON_MODELO.test(v) ? v : '';
        }

        /**
         * Resuelve el endpoint de Ollama a usar. Prioridad: campo de la UI,
         * valor persistido y configuración. Se usa el primer candidato válido;
         * si ninguno lo es, el valor por defecto del módulo.
         */
        function getEndpoint() {
            var maxLen = cfgNum('maxEndpointLength', 512);
            var candidatos = [leerCampoUI('ollamaUrl'), setting('vp_ollama_url', ''), CFG.endpoint];
            for (var i = 0; i < candidatos.length; i++) {
                var valido = normalizarEndpoint(candidatos[i], maxLen);
                if (valido) return valido;
            }
            warn('Ningún endpoint de Ollama válido; se usa ' + VALORES_POR_DEFECTO.endpoint + '.');
            return VALORES_POR_DEFECTO.endpoint;
        }

        /** Resuelve el modelo con la misma prioridad que getEndpoint(). */
        function getModel() {
            var maxLen = cfgNum('maxModelLength', 128);
            var candidatos = [leerCampoUI('ollamaModel'), setting('summaryIA_model', ''), CFG.model];
            for (var i = 0; i < candidatos.length; i++) {
                var valido = normalizarModelo(candidatos[i], maxLen);
                if (valido) return valido;
            }
            warn('Ningún modelo de Ollama válido; se usa ' + VALORES_POR_DEFECTO.model + '.');
            return VALORES_POR_DEFECTO.model;
        }

        // --------------------------------------------------------------------
        // Capa HTTP: fetch con límite de tiempo, cancelación y lectura de errores
        // --------------------------------------------------------------------

        /**
         * Ejecuta un fetch con límite de tiempo y soporte de cancelación
         * externa. El temporizador sigue activo mientras `procesar(res)` lee el
         * cuerpo, así un servidor que responde cabeceras y luego se cuelga
         * tampoco bloquea indefinidamente. Etiqueta el error con `code` =
         * 'TIMEOUT' o 'CANCELLED' según la causa del abort.
         */
        function fetchConLimite(url, opciones, timeoutMs, signalExterna, procesar) {
            if (typeof fetch !== 'function') {
                return Promise.reject(crearError('NO_FETCH', 'fetch no está disponible en este entorno.'));
            }
            var tiempoEspera = Math.max(1000, Number(timeoutMs) || 60000);
            var controlador = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            if (!controlador && signalExterna && signalExterna.aborted) {
                return Promise.reject(crearError('CANCELLED', 'La solicitud fue cancelada.', 'AbortError'));
            }
            var motivoAbort = null;
            var temporizador = null;
            var manualTimeoutId = null;
            var onAbortExterno = null;
            var liberado = false;

            function limpiar() {
                if (liberado) return;
                liberado = true;
                if (temporizador) clearTimeout(temporizador);
                if (manualTimeoutId) clearTimeout(manualTimeoutId);
                if (signalExterna && onAbortExterno) {
                    try { signalExterna.removeEventListener('abort', onAbortExterno); } catch (_) {}
                }
            }

            if (controlador) {
                temporizador = setTimeout(function () {
                    motivoAbort = 'TIMEOUT';
                    controlador.abort();
                }, tiempoEspera);
                if (signalExterna) {
                    if (signalExterna.aborted) {
                        motivoAbort = 'CANCELLED';
                        controlador.abort();
                    } else {
                        onAbortExterno = function () { motivoAbort = 'CANCELLED'; controlador.abort(); };
                        // `false` (useCapture) por compatibilidad con motores
                        // antiguos; se elimina explícitamente en limpiar().
                        signalExterna.addEventListener('abort', onAbortExterno, false);
                    }
                }
            }

            var opts = copiarObjeto(opciones);
            if (controlador) opts.signal = controlador.signal;

            var peticion;
            try {
                peticion = fetch(url, opts);
            } catch (e) {
                limpiar();
                return Promise.reject(e);
            }

            var resultado = Promise.resolve(peticion).then(function (res) {
                return typeof procesar === 'function' ? procesar(res) : res;
            }).then(function (valor) {
                limpiar();
                return valor;
            }, function (err) {
                limpiar();
                if (err && err.name === 'AbortError' && !err.code) err.code = motivoAbort || 'ABORTED';
                throw err;
            });

            if (!controlador) {
                // Sin AbortController se emula el timeout con una carrera de
                // promesas (la petición no se puede cancelar, pero el llamador
                // no queda bloqueado indefinidamente).
                resultado = Promise.race([
                    resultado,
                    new Promise(function (_, reject) {
                        manualTimeoutId = setTimeout(function () {
                            reject(crearError('TIMEOUT', 'Tiempo de espera agotado.'));
                        }, tiempoEspera);
                    })
                ]);
            }
            return resultado;
        }

        function leerTextoSeguro(res) {
            try {
                return Promise.resolve(res && typeof res.text === 'function' ? res.text() : '').then(
                    function (t) { return String(t || ''); },
                    function () { return ''; }
                );
            } catch (_) { return Promise.resolve(''); }
        }

        /** Construye un error descriptivo a partir de una respuesta HTTP no exitosa. */
        function errorHttp(res, detalle) {
            var mensaje = String(detalle || '').trim();
            try {
                var json = JSON.parse(mensaje);
                if (json && json.error) mensaje = String(json.error);
            } catch (_) {}
            var err = crearError(codigoDeEstado(res.status),
                'Ollama respondió con estado ' + res.status + (mensaje ? ': ' + mensaje.slice(0, 300) : ''));
            err.status = res.status;
            try {
                var retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('Retry-After') : null;
                var segundos = numeroValido(retryAfter);
                if (segundos !== undefined && segundos >= 0) err.retryAfterMs = Math.round(segundos * 1000);
            } catch (_) {}
            return err;
        }

        function leerJsonRespuesta(res) {
            if (!res.ok) {
                return leerTextoSeguro(res).then(function (detalle) { throw errorHttp(res, detalle); });
            }
            return res.json().catch(function (e) {
                if (e && e.name === 'AbortError') throw e;
                throw crearError('INVALID_JSON', 'La respuesta de Ollama no es JSON válido.');
            });
        }

        /** GET de un recurso JSON de Ollama (p. ej. /api/version, /api/tags). */
        function obtenerJson(endpoint, ruta, timeoutMs, signal) {
            return fetchConLimite(endpoint + ruta, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            }, timeoutMs, signal, leerJsonRespuesta);
        }

        // --------------------------------------------------------------------
        // Cliente autónomo de respaldo
        // --------------------------------------------------------------------

        /**
         * Crea un cliente de Ollama autónomo (fetch con timeout, cancelación y
         * reintentos con backoff exponencial y jitter) para usar cuando el host
         * no provee su propio `VP.ollama`.
         */
        function crearOllamaAutonomo() {
            var enVuelo = false;

            /**
             * Realiza una única llamada a /api/chat y normaliza tanto los
             * errores HTTP como el formato de la respuesta exitosa. Invoca
             * `onResponse(json)` con la respuesta cruda, si se proporcionó.
             */
            function unaLlamada(endpoint, body, signal, timeoutMs, onResponse) {
                var cuerpo;
                try { cuerpo = JSON.stringify(body); }
                catch (e) {
                    return Promise.reject(crearError('BAD_REQUEST', 'No se pudo serializar la petición: ' + (e && e.message)));
                }
                return fetchConLimite(endpoint + '/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: cuerpo
                }, timeoutMs, signal, leerJsonRespuesta).then(function (json) {
                    if (json && json.error) {
                        throw crearError('OLLAMA_ERROR', 'Ollama devolvió un error: ' + truncate(String(json.error), 300));
                    }
                    if (typeof onResponse === 'function') {
                        try { onResponse(json); } catch (_) {}
                    }
                    var contenido = json && json.message && json.message.content;
                    return {
                        value: typeof contenido === 'string' ? contenido : '',
                        model: json && json.model,
                        done_reason: json && json.done_reason,
                        total_duration: json && json.total_duration,
                        load_duration: json && json.load_duration,
                        prompt_eval_duration: json && json.prompt_eval_duration,
                        eval_count: json && json.eval_count,
                        prompt_eval_count: json && json.prompt_eval_count,
                        eval_duration: json && json.eval_duration
                    };
                });
            }

            /**
             * Errores que no vale la pena reintentar porque la petición volvería
             * a fallar igual (modelo inexistente, petición malformada, auth) o
             * porque son aborts deliberados (timeout propio o cancelación).
             */
            function esReintentable(error) {
                if (!error) return true;
                if (error.name === 'AbortError') return false;
                switch (error.code) {
                    case 'MODEL_NOT_FOUND':
                    case 'BAD_REQUEST':
                    case 'BAD_ENDPOINT':
                    case 'AUTH':
                    case 'NO_FETCH':
                    case 'TIMEOUT':
                    case 'CANCELLED':
                    case 'ABORTED':
                        return false;
                    default:
                        return true;
                }
            }

            function pausa(ms) {
                return new Promise(function (resolve) { setTimeout(resolve, ms); });
            }

            /**
             * Orquesta una conversación con reintentos y backoff exponencial con
             * jitter (respetando Retry-After si el servidor lo envía).
             */
            function chat(endpoint, body, ctx, opts) {
                if (typeof endpoint !== 'string' || !/^https?:\/\/[^\s]+$/i.test(endpoint)) {
                    return Promise.reject(crearError('BAD_ENDPOINT', 'El endpoint de Ollama no es una URL http(s) válida.'));
                }
                if (!body || typeof body !== 'object') {
                    return Promise.reject(crearError('BAD_REQUEST', 'El cuerpo de la petición es inválido.'));
                }
                var signal = ctx && ctx.signal;
                var onResponse = ctx && ctx.onResponse;
                var timeoutMs = Math.max(1000, numeroValido(opts && opts.timeoutMs) || numeroValido(opts && opts.timeout) || 60000);
                var maxRetries = Math.max(0, Math.min(5, Math.floor(numeroValido(opts && opts.retries) || 0)));
                var intento = 0;

                function ejecutar() {
                    if (signal && signal.aborted) {
                        return Promise.reject(crearError('CANCELLED', 'La solicitud fue cancelada.', 'AbortError'));
                    }
                    var promesa;
                    try { promesa = unaLlamada(endpoint, body, signal, timeoutMs, onResponse); }
                    catch (e) { promesa = Promise.reject(e); }
                    return promesa.catch(function (error) {
                        clasificarError(error);
                        if (!esReintentable(error) || intento >= maxRetries) throw error;
                        intento++;
                        estadisticas.reintentosRed++;
                        var espera = (error && error.retryAfterMs)
                            ? Math.min(15000, error.retryAfterMs)
                            : Math.min(4000, 400 * Math.pow(2, intento - 1)) + Math.floor(Math.random() * 150);
                        consoleEvent('ollama_reintento', {
                            intento: intento,
                            maxRetries: maxRetries,
                            esperaMs: espera,
                            codigo: (error && error.code) || 'DESCONOCIDO',
                            mensaje: (error && error.message) || ''
                        });
                        return pausa(espera).then(ejecutar);
                    });
                }
                return ejecutar();
            }

            return {
                isBusy: function () { return enVuelo; },
                runIfIdle: function (tarea) {
                    if (typeof tarea !== 'function') return Promise.reject(new TypeError('runIfIdle requiere una función.'));
                    if (enVuelo) return Promise.resolve({ busy: true });
                    enVuelo = true;
                    var liberado = false;
                    var liberar = function () { if (!liberado) { liberado = true; enVuelo = false; } };
                    var promesa;
                    try { promesa = Promise.resolve(tarea()); }
                    catch (e) { liberar(); return Promise.reject(e); }
                    return promesa.then(function (r) { liberar(); return r; }, function (e) { liberar(); throw e; });
                },
                chat: chat
            };
        }

        // Si el host no provee un `VP.ollama` utilizable (ausente o incompleto),
        // se instala el cliente autónomo de respaldo.
        if (!VP.ollama || typeof VP.ollama.chat !== 'function') {
            if (VP.ollama) warn('VP.ollama no expone chat(); se reemplaza por un cliente de Ollama autónomo integrado.');
            else warn('VP.ollama no estaba definido; se usará un cliente de Ollama autónomo integrado.');
            VP.ollama = crearOllamaAutonomo();
        }

        // --------------------------------------------------------------------
        // Procesamiento de subtítulos y construcción del prompt
        // --------------------------------------------------------------------

        /** Separa "[12.3s] texto" en { segundo, texto }. Sin marca => segundo null. */
        function parsearLinea(linea) {
            var match = /^\[(\d+(?:\.\d+)?)s\]\s*/.exec(linea);
            return {
                segundo: match ? Number(match[1]) : null,
                texto: match ? linea.slice(match[0].length) : linea
            };
        }

        /**
         * Elige el subtítulo "actual" (el más reciente dentro de la ventana) y,
         * como máximo, un subtítulo previo para aclarar pronombres. Si no hay
         * nada dentro de la ventana, usa la última línea disponible.
         */
        function seleccionarCues(contexto, tiempoActual, ventana) {
            var cues = contexto.split(/\r?\n/).filter(function (l) { return l && l.trim(); }).map(parsearLinea);
            var t = numeroValido(tiempoActual);
            var limiteReciente = t === undefined ? Infinity : Math.max(0, t - ventana);
            var actuales = [];
            var anteriores = [];
            cues.forEach(function (cue) {
                if (cue.segundo == null || cue.segundo >= limiteReciente) actuales.push(cue);
                else anteriores.push(cue);
            });
            var usoFallback = actuales.length === 0 && cues.length > 0;
            if (usoFallback) {
                actuales = cues.slice(-1);
                anteriores = anteriores.slice(0, Math.max(0, anteriores.length - 1));
            }
            return {
                actuales: actuales.slice(-1),
                anteriores: anteriores.slice(-1),
                usoFallback: usoFallback,
                totalLineas: cues.length
            };
        }

        /**
         * Serializa los datos del prompt respetando el límite de caracteres SIN
         * producir JSON truncado: primero descarta el contexto previo y luego
         * acorta el texto del subtítulo actual y el título.
         */
        function construirPromptDatos(titulo, actuales, anteriores, limite) {
            var tituloL = titulo;
            var actualesL = actuales.map(copiarObjeto);
            var anterioresL = anteriores.map(copiarObjeto);
            function armar() {
                return safeJsonStringify({
                    titulo: tituloL,
                    subtitulos_actuales: actualesL,
                    contexto_previo: anterioresL
                }, '{}');
            }
            var json = armar();
            if (json.length <= limite) return json;
            anterioresL = [];
            json = armar();
            var guardia = 0;
            while (json.length > limite && guardia++ < 12) {
                var exceso = json.length - limite;
                var cue = actualesL[actualesL.length - 1];
                if (cue && typeof cue.texto === 'string' && cue.texto.length > 40) {
                    cue.texto = cue.texto.slice(0, Math.max(40, cue.texto.length - exceso - 1));
                } else if (tituloL.length > 40) {
                    tituloL = tituloL.slice(0, Math.max(40, tituloL.length - exceso - 1));
                } else {
                    break;
                }
                json = armar();
            }
            return json;
        }

        // --------------------------------------------------------------------
        // Limpieza y clasificación de la respuesta del modelo
        // --------------------------------------------------------------------

        function desdeCodigo(code) {
            if (!(code > 0 && code <= 0x10ffff)) return ' ';
            try {
                if (typeof String.fromCodePoint === 'function') return String.fromCodePoint(code);
            } catch (_) {}
            return code <= 0xffff ? String.fromCharCode(code) : ' ';
        }

        /** Limpia envolturas de formato que algunos modelos añaden a la respuesta. */
        function limpiarTextoModelo(entrada) {
            var text = String(entrada == null ? '' : entrada)
                .replace(/\\r\\n|\\n|\\r/g, '\n')
                .replace(/\\([*_`~#])/g, '$1')
                .replace(/&#(?:x([\da-f]{1,6})|(\d{1,7}));?/gi, function (entity, hex, decimal) {
                    return desdeCodigo(parseInt(hex || decimal, hex ? 16 : 10));
                })
                .replace(/&(?:nbsp|#160);/gi, ' ')
                .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
                .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
                .replace(/<br\s*\/?\s*>/gi, '\n')
                // Quita el contenido de canales de razonamiento; solo
                // queremos la respuesta visible, nunca sus notas internas.
                .replace(/<(?:think|analysis|reasoning|scratchpad)\b[^>]*>[\s\S]*?<\/(?:think|analysis|reasoning|scratchpad)\s*>/gi, ' ')
                .replace(/<(?:think|analysis|reasoning|scratchpad)\b[^>]*>[\s\S]*$/gi, ' ')
                // Elimina wrappers conocidos y etiquetas XML/HTML de modelo
                // aunque vengan con atributos o capitalización distinta.
                .replace(/<\/?(?:result|output|response|respuesta|answer|comment|comentario|final|video_comment|text)\b[^>]*>/gi, '')
                .replace(/<\|\/?[a-z][\w:.-]*\|>/gi, '')
                .replace(/\[\/?(?:result|output|response|respuesta|answer|comment|comentario|final|analysis|reasoning|text|assistant)\]/gi, '')
                // Cubre nombres de etiqueta arbitrarios (namespaces, guiones,
                // puntos, atributos y autocierre) sin lista manual de wrappers.
                .replace(/<\/?[a-z_][\w:.-]*(?:\s+[^<>]*?)?\s*\/?>/gi, '')
                .replace(/&lt;\/?(?:result|output|response|respuesta|answer|comment|comentario|final|video_comment|text)\b[^&]*?&gt;/gi, '')
                .replace(/^\s*\[?\s*(?:assistant|user|system|developer|final(?:\s+answer)?|answer|response|result|output|comment|comentario|respuesta|conclusion|summary|analysis)\s*\]?\s*:\s*/gim, '')
                .replace(/^\s*```[^\n]*\s*$|^\s*```\s*$/gm, '')
                .replace(/^\s*['"“”]?\s*(?:[*_~-]\s*){3,}['"“”]?\s*$/gm, '')
                .replace(/^[ \t]*['"“”*_\-–— ]{3,}[ \t]*$/gm, '')
                .replace(/^\s*#{1,6}\s*/gm, '')
                .replace(/^\s*(?:\*{1,3}|_{1,3})?\s*(?:comentario(?:\s+(?:generado|de\s+mochi(?:-ia)?|seleccionado|elegido))?|respuesta(?:\s+(?:generada|seleccionada))?|video_comment|answer|comment)\s*:\s*(?:\*{1,3}|_{1,3})?\s*/gim, '')
                .replace(/\*\*([^*\n]+)\*\*/g, '$1')
                .replace(/__([^_\n]+)__/g, '$1')
                .replace(/^\s*[*_`~]+\s*$/gm, '')
                .replace(/[\t ]+\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            text = text.replace(/^\*{1,3}|\*{1,3}$/g, '').trim();
            if (/^["“][\s\S]*["”]$/.test(text)) text = text.slice(1, -1).trim();
            return text;
        }

        /**
         * Decide si una respuesta ya limpia debe descartarse (marcador SKIP,
         * texto meta, solo formato, encabezado suelto, error técnico o informe
         * de análisis). Devuelve el motivo para poder diagnosticarlo.
         */
        function clasificarRespuesta(respuesta) {
            var sinAsteriscos = respuesta.replace(/\*{1,3}/g, '').trim();
            var esSkip = /^\[?SKIP\]?(?:\s*(?:[-:–—(].*)?)?$/i.test(sinAsteriscos);
            var esMeta = esRespuestaMeta(respuesta);
            var esSoloFormato = /^(?:[*_~`#>|-]+|(?:---|\*\*\*|___))+$/.test(respuesta.replace(/\s/g, ''));
            var esAnalisisOInforme = /^\s*(?:#{1,6}\s*)?(?:an[aá]lisis|analysis|resumen|summary|informe|report|desglose|breakdown|thinking process|mi proceso de pensamiento|razonamiento|chain of thought|system instructions|pautas del sistema)\b/i.test(respuesta) ||
                /^\s*<\/?(?:analysis|reasoning|think)\b/i.test(respuesta) ||
                /^\s*(?:i notice this request|let me think|revisando minuciosamente|a[uú]n no has proporcionado|no has proporcionado los nuevos subt[ií]tulos)\b/i.test(respuesta);
            var esSoloEncabezado = /^(?:comentario(?:\s+(?:de\s+mochi(?:-ia)?|seleccionado|elegido))?|respuesta(?:\s+(?:seleccionada|generada))?|answer|comment)\s*:?\s*$/i.test(respuesta.replace(/^\*{1,2}|\*{1,2}$/g, ''));
            var esErrorTecnico = /^(?:error\s*[:：-]\s*(?:ollama|model|modelo|connection|conexi[oó]n|fetch|network|servidor|server|http|\d{3})\b.*|(?:ollama\s+)?(?:is not running|no est[aá]\s+(?:iniciado|ejecut[aá]ndose)|no se pudo conectar|connection refused|failed to connect|fetch failed|network error|request failed|model not found)\.?|(?:404|429|5\d\d)\s*(?:error|not found|too many requests|internal server error)?|ECONNREFUSED|TIMEOUT|BAD_REQUEST)\s*$/i.test(respuesta);
            var motivo = !respuesta ? 'vacia'
                : esSkip ? 'skip'
                : esMeta ? 'meta'
                : esSoloFormato ? 'solo_formato'
                : esSoloEncabezado ? 'solo_encabezado'
                : esErrorTecnico ? 'error_tecnico'
                : esAnalisisOInforme ? 'analisis_o_informe'
                : null;
            return { descartar: motivo !== null, motivo: motivo, esSkip: esSkip };
        }

        function describirErroresValidacion(errores) {
            var descripciones = {
                mas_de_600_caracteres: 'máximo 600 caracteres',
                mas_de_100_palabras: 'máximo 100 palabras',
                marcado_o_enlace: 'sin etiquetas, formato ni enlaces',
                emoji_no_permitido: 'sin emojis',
                emoticon_no_permitido: 'sin emoticonos',
                muletilla_felina: 'sin muletillas felinas',
                gestos_no_permitidos: 'sin acciones entre asteriscos',
                asteriscos_invalidos: 'sin asteriscos',
                respuesta_excesiva: 'una respuesta breve',
                vacia: 'incluye una reacción breve y comprensible',
                tipo_invalido: 'devuelve texto plano',
                error_validador: 'devuelve una respuesta breve y comprensible'
            };
            return (Array.isArray(errores) ? errores : []).map(function (error) {
                return descripciones[error] || String(error);
            });
        }

        /**
         * Si el único problema de una respuesta es su longitud, la recorta a la
         * primera frase completa en lugar de descartarla. Devuelve null si hay
         * otros errores o no se puede ajustar.
         */
        function ajustarLongitudRespuesta(texto, errores) {
            var permitidos = ['mas_de_600_caracteres', 'mas_de_100_palabras'];
            if (!Array.isArray(errores) || !errores.length || errores.some(function (error) {
                return permitidos.indexOf(error) === -1;
            })) return null;

            var candidato = String(texto || '').split(/\r?\n/)[0].trim()
                .replace(/^(?:comentario|respuesta|mochi)(?:\s+de\s+mochi)?\s*:\s*/i, '')
                .replace(/\s+/g, ' ');
            // Si el modelo dio varias frases, conserva solo la primera.
            var primeraFrase = candidato.match(/^(.+?[.!?])(?:\s|$)/);
            if (primeraFrase) candidato = primeraFrase[1].trim();

            var palabras = candidato.split(/\s+/).filter(Boolean);
            if (palabras.length > 100) candidato = palabras.slice(0, 100).join(' ');
            if (candidato.length > 600) {
                candidato = candidato.slice(0, 600);
                var ultimoEspacio = candidato.lastIndexOf(' ');
                if (ultimoEspacio > 0) candidato = candidato.slice(0, ultimoEspacio);
            }
            candidato = candidato.replace(/[\s,;:–—-]+$/g, '').trim();
            if (candidato && !/[.!?…]$/.test(candidato)) candidato += '.';
            return candidato || null;
        }

        /** Llama al validador del perfil sin que una excepción rompa el flujo. */
        function validarConPerfil(perfil, texto) {
            if (typeof perfil.validarRespuesta !== 'function') return null;
            try {
                return perfil.validarRespuesta(texto);
            } catch (e) {
                warn('El validador del perfil lanzó una excepción: ' + (e && e.message));
                return { valida: false, errores: ['error_validador'] };
            }
        }

        /**
         * Extrae { text, mood } de la respuesta cruda usando el contrato de
         * humor del perfil. Si el contrato falla, devuelve texto vacío (que
         * luego se descarta) en lugar de mostrar JSON crudo al usuario.
         */
        function extraerSalidaHumor(result, texto, contratoHumor) {
            var salida = null;
            try {
                if (result && result.forcedMood) {
                    salida = {
                        text: texto,
                        mood: typeof contratoHumor.normalizar === 'function'
                            ? contratoHumor.normalizar(result.forcedMood)
                            : result.forcedMood
                    };
                } else if (typeof contratoHumor.extraerRespuesta === 'function') {
                    salida = contratoHumor.extraerRespuesta(texto);
                } else {
                    salida = { text: texto, mood: 'neutral' };
                }
            } catch (e) {
                warn('No se pudo extraer la respuesta con el contrato de humor: ' + (e && e.message));
                return { text: '', mood: 'neutral', invalidFormat: true };
            }
            if (!salida || typeof salida !== 'object') return { text: '', mood: 'neutral', invalidFormat: true };
            salida.text = String(salida.text == null ? '' : salida.text);
            if (!salida.mood) salida.mood = 'neutral';
            return salida;
        }

        // --------------------------------------------------------------------
        // Metadatos de Ollama
        // --------------------------------------------------------------------
        function extraerMetadatosRespuesta(response) {
            var m = {
                done_reason: response && response.done_reason,
                message_content: response && response.message && response.message.content
            };
            CAMPOS_METRICAS.forEach(function (campo) { m[campo] = response && response[campo]; });
            return m;
        }

        /** Métricas de la respuesta: prioriza `onResponse` y cae al resultado normalizado. */
        function extraerMetricas(result, meta) {
            var salida = {};
            CAMPOS_METRICAS.forEach(function (campo) {
                salida[campo] = (meta && meta[campo] != null)
                    ? meta[campo]
                    : (result && typeof result === 'object' ? result[campo] : undefined);
            });
            return salida;
        }

        function nsAMs(valor) { return (Number(valor) || 0) / 1e6 || null; }

        // --------------------------------------------------------------------
        // Compatibilidad con modelos que no admiten `think`
        // --------------------------------------------------------------------
        var modelosSinThink = {};

        function esErrorThinkNoSoportado(error) {
            var mensaje = String((error && error.message) || '');
            return /think/i.test(mensaje) &&
                /(unsupported|not support|unknown|invalid|no soporta|no admite)/i.test(mensaje);
        }

        function opcionesModelo() {
            var candidatas = {
                temperature: numeroEnRango(mochiParametro('temperature'), 0, 2),
                num_predict: enteroEnRango(mochiParametro('numPredict'), -2, 8192),
                top_p: numeroEnRango(mochiParametro('topP'), 0, 1),
                repeat_penalty: numeroEnRango(mochiParametro('repeatPenalty'), 0, 3)
            };
            var limpias = {};
            for (var clave in candidatas) {
                if (candidatas[clave] !== undefined) limpias[clave] = candidatas[clave];
            }
            return limpias;
        }

        function opcionesDeRed() {
            var timeout = numeroEnRango(mochiParametro('timeoutMs'), 1000, 600000);
            return {
                timeout: timeout,
                timeoutMs: timeout,
                retries: enteroEnRango(mochiParametro('maxRetries'), 0, 5),
                queued: false
            };
        }

        // --------------------------------------------------------------------
        // Generación de comentarios
        // --------------------------------------------------------------------

        /**
         * Genera un comentario de Mochi a partir del contexto de subtítulos.
         *
         * @param {string} contexto        Líneas con marca de tiempo, p.ej. "[12.3s] ...".
         * @param {AbortSignal} [signal]   Señal externa para cancelar la petición en curso.
         * @param {string[]} [historial]   Reservado (no se envía al modelo para evitar que lo eche de vuelta).
         * @param {string} [titulo]        Título del video, solo informativo para el prompt.
         * @param {number} [tiempoActual]  Segundo objetivo del comentario, para priorizar líneas recientes.
         * @param {number} [tiempoReproduccion] Segundo real de reproducción (solo para registro).
         * @param {Object} [video]         Video actual, usado por el planificador para decidir reintentos.
         * @returns {Promise<{busy?: boolean, skip?: boolean, text?: string, mood?: string}>}
         */
        function generarDato(contexto, signal, historial, titulo, tiempoActual, tiempoReproduccion, video) {
            try {
                return generarDatoInterno(contexto, signal, historial, titulo, tiempoActual, tiempoReproduccion, video);
            } catch (e) {
                return Promise.reject(e);
            }
        }

        function puedeReintentar(video, tiempoActual, ultimaGeneracionMs) {
            var scheduler = VP.mochiScheduler;
            if (!scheduler || typeof scheduler.puedeReintentar !== 'function') return false;
            try {
                return !!scheduler.puedeReintentar(video, tiempoActual, ultimaGeneracionMs, 1.5);
            } catch (e) {
                warn('El planificador falló al evaluar el reintento: ' + (e && e.message));
                return false;
            }
        }

        function generarDatoInterno(contexto, signal, historial, titulo, tiempoActual, tiempoReproduccion, video) {
            var metadatosRespuesta = {};

            if (!VP.ollama || typeof VP.ollama.chat !== 'function') {
                return Promise.reject(crearError('NO_CLIENT', 'El cliente de Ollama no está disponible.'));
            }
            if (!contexto || typeof contexto !== 'string' || !contexto.trim()) {
                return Promise.resolve({ busy: false, skip: true, motivo: 'sin_contexto' });
            }
            if (signal && signal.aborted) {
                return Promise.reject(crearError('CANCELLED', 'La solicitud fue cancelada antes de enviarse.', 'AbortError'));
            }
            var proteccion = estadoDisyuntor();
            if (proteccion.abierto) {
                estadisticas.omitidas++;
                return Promise.resolve({ busy: false, skip: true, circuitoAbierto: true, reintentarEnMs: proteccion.restanteMs });
            }

            // Acota el contexto conservando las líneas más recientes.
            var maxContexto = cfgNum('maxContextChars', 20000);
            if (contexto.length > maxContexto) {
                contexto = contexto.slice(-maxContexto);
                var salto = contexto.indexOf('\n');
                if (salto > -1 && salto < contexto.length - 1) contexto = contexto.slice(salto + 1);
            }

            var t = textos();
            var model = getModel();
            var variantes = (Array.isArray(t.instruccionesVariantes) && t.instruccionesVariantes.length) ? t.instruccionesVariantes : [''];
            var variante = String(pickRandom(variantes) || variantes[0] || '');
            var limiteTexto = Math.min(Number(mochiParametro('maxFactChars')) || 300, 300);
            var instruccion = variante.replace('{N}', String(limiteTexto));
            var perfil = mochiPerfilActual();
            var contratoHumor = perfil.humor || {};
            var instruccionSalidaHumor = contratoHumor.instruccionSalida || '';
            if (perfil.tono) instruccion += ' ' + perfil.tono;
            if (perfil.promptFormato) instruccion += ' ' + perfil.promptFormato;
            var instruccionPersonalidad = INSTRUCCIONES_PERSONALIDAD[mochiParametro('personalidad')] || '';

            // Mochi comenta un detalle por turno: una ventana corta reduce la
            // tentación de resumir varios subtítulos de una sola vez.
            var ventanaComentario = cfgNum('ventanaComentarioSegundos', VENTANA_COMENTARIO_SEGUNDOS);
            var seleccion = seleccionarCues(contexto, tiempoActual, ventanaComentario);
            var actuales = seleccion.actuales;
            var anteriores = seleccion.anteriores;
            var subtituloActual = actuales.map(function (cue) { return cue.texto; }).join(' ');

            var tituloSeguro = normalizeWhitespace(titulo || t.sinTitulo);
            if (tituloSeguro.length > 200) tituloSeguro = tituloSeguro.slice(0, 200) + '…';
            var limitePrompt = cfgNum('maxPromptChars', 8000);
            var promptDatos = construirPromptDatos(tituloSeguro, actuales, anteriores, limitePrompt);
            if (promptDatos.length > limitePrompt) {
                consoleEvent('prompt_excede_limite', { promptChars: promptDatos.length, limite: limitePrompt }, 'warn');
            }

            estadoMascota('leyendo');
            var fragmentoRegistro = safeJsonStringify(actuales, '[]');
            consoleEvent('contexto_enviado', {
                modelo: model,
                segundoActual: Number(tiempoReproduccion != null ? tiempoReproduccion : tiempoActual) || 0,
                segundoObjetivo: Number(tiempoActual) || 0,
                ventanaActualSegundos: ventanaComentario,
                seUsaronLineasPreviasPorFaltaDeActuales: seleccion.usoFallback,
                lineasPriorizadas: actuales.length,
                lineasDeContexto: anteriores.length,
                fragmentoActual: truncate(fragmentoRegistro, 500),
                fragmentoTruncado: fragmentoRegistro.length > 500,
                promptChars: promptDatos.length
            });

            function construirCuerpo(promptUsuario, instruccionesAdicionales) {
                var sistema = [
                    perfil.promptSistema || '',
                    '',
                    (CFG.featureFlags && CFG.featureFlags.promptHardening !== false) ? (t.hardening || '') : '',
                    instruccion,
                    instruccionPersonalidad,
                    instruccionSalidaHumor,
                    instruccionesAdicionales || ''
                ].filter(Boolean).join('\n\n');
                var cuerpo = {
                    model: model,
                    messages: [
                        { role: 'system', content: sistema },
                        { role: 'user', content: promptUsuario }
                    ],
                    stream: false,
                    format: 'json',
                    options: opcionesModelo()
                };
                if (!modelosSinThink[model]) cuerpo.think = false;
                return cuerpo;
            }

            function registrarMetadatos(response) {
                metadatosRespuesta = extraerMetadatosRespuesta(response);
            }

            /**
             * Envía una petición de chat a Ollama con las opciones actuales del
             * perfil/parámetros. Si el modelo no admite `think`, reintenta sin él
             * y recuerda la incompatibilidad para no volver a fallar.
             */
            function solicitar(promptUsuario, instruccionesAdicionales) {
                var llamada = function () {
                    // Cada intento parte de metadatos limpios para no mezclar
                    // los de un intento anterior con los del actual.
                    metadatosRespuesta = {};
                    var endpoint = getEndpoint();
                    var body = construirCuerpo(promptUsuario, instruccionesAdicionales);
                    var redOpts = opcionesDeRed();
                    consoleEvent('ollama_request_sent', {
                        modelo: model,
                        endpoint: endpoint,
                        charsPrompt: String(promptUsuario || '').length,
                        charsSistema: String(body.messages[0].content || '').length,
                        systemPrompt: body.messages[0].content,
                        format: body.format,
                        stream: body.stream,
                        temperature: body.options.temperature,
                        num_predict: body.options.num_predict
                    });
                    var ctx = { signal: signal, onResponse: registrarMetadatos };
                    return Promise.resolve(VP.ollama.chat(endpoint, body, ctx, redOpts)).catch(function (error) {
                        if (!esErrorThinkNoSoportado(error)) throw error;
                        modelosSinThink[model] = true;
                        var bodyCompatible = copiarObjeto(body);
                        delete bodyCompatible.think;
                        consoleEvent('ollama_solicitud_compatible', {
                            modelo: model,
                            endpoint: endpoint,
                            motivo: truncate(String((error && error.message) || ''), 200)
                        });
                        return VP.ollama.chat(endpoint, bodyCompatible, ctx, redOpts);
                    });
                };
                var peticion = typeof VP.ollama.runIfIdle === 'function'
                    ? VP.ollama.runIfIdle(llamada)
                    : Promise.resolve().then(llamada);
                return Promise.resolve(peticion);
            }

            /** Igual que solicitar(), pero alimenta estadísticas y disyuntor. */
            function solicitarMonitoreado(promptUsuario, instruccionesAdicionales) {
                estadisticas.solicitudes++;
                var inicio = Date.now();
                return solicitar(promptUsuario, instruccionesAdicionales).then(function (resultado) {
                    if (resultado && resultado.busy) estadisticas.ocupado++;
                    else registrarExito(Date.now() - inicio);
                    return resultado;
                }, function (error) {
                    registrarFallo(error);
                    throw error;
                });
            }

            /** Convierte el resultado crudo del cliente en { text, mood } o { skip }. */
            function interpretar(result, esReintento) {
                if (!result || result.busy) return { busy: true };

                var rawContent = String(typeof result === 'string' ? result :
                    (result.value || result.content || (result.message && result.message.content) || ''));
                var maxRaw = cfgNum('maxRawResponseChars', 20000);
                if (rawContent.length > maxRaw) rawContent = rawContent.slice(0, maxRaw);

                var salidaMochi = extraerSalidaHumor(result, rawContent, contratoHumor);
                var humor = salidaMochi.mood;
                if (!salidaMochi.invalidFormat && typeof contratoHumor.verificarCoherencia === 'function') {
                    try { contratoHumor.verificarCoherencia(subtituloActual, humor); }
                    catch (e) { warn('verificarCoherencia lanzó una excepción: ' + (e && e.message)); }
                }

                var text = limpiarTextoModelo(salidaMochi.text);
                var respuestaRecortada = text.trim();
                var metricas = extraerMetricas(result, metadatosRespuesta);

                consoleEvent('ollama_response_received', {
                    modelo: model,
                    humor: humor,
                    formatoValido: salidaMochi.invalidFormat !== true,
                    raw_message_content: truncate(String(metadatosRespuesta.message_content != null ? metadatosRespuesta.message_content : rawContent), 1200),
                    ollama_respuesta: truncate(respuestaRecortada, 600),
                    done_reason: metadatosRespuesta.done_reason || (result && result.done_reason) || null,
                    total_duration_ms: nsAMs(metricas.total_duration),
                    load_duration_ms: nsAMs(metricas.load_duration),
                    prompt_eval_duration_ms: nsAMs(metricas.prompt_eval_duration),
                    eval_count: metricas.eval_count || null,
                    prompt_eval_count: metricas.prompt_eval_count || null,
                    eval_duration_ms: nsAMs(metricas.eval_duration),
                    segundoObjetivo: Number(tiempoActual) || 0
                });

                var clasificacion = clasificarRespuesta(respuestaRecortada);
                if (clasificacion.descartar) {
                    consoleEvent('respuesta_descartada', { motivo: clasificacion.motivo, respuesta: truncate(respuestaRecortada, 300) });
                    return mezclarObjetos({ busy: false, skip: true, terminal: clasificacion.esSkip }, metricas);
                }

                var validacion = validarConPerfil(perfil, text);
                if (validacion !== null || typeof perfil.validarRespuesta === 'function') {
                    if (!validacion || !validacion.valida) {
                        var textoAjustado = ajustarLongitudRespuesta(text, validacion && validacion.errores);
                        if (textoAjustado) {
                            var validacionAjustada = validarConPerfil(perfil, textoAjustado);
                            if (validacionAjustada && validacionAjustada.valida) {
                                consoleEvent('respuesta_ajustada', {
                                    motivo: 'limite_de_longitud',
                                    erroresOriginales: (validacion.errores || []).join(', ')
                                });
                                validacion = validacionAjustada;
                            }
                        }
                    }
                    if (!validacion || !validacion.valida) {
                        consoleEvent('respuesta_invalida', {
                            motivo: 'validacion_perfil',
                            errores: ((validacion && validacion.errores) || []).join(', '),
                            respuestaOllama: truncate(normalizeWhitespace(text), 600),
                            reintentoAutomatico: !esReintento
                        }, esReintento ? 'warn' : 'info');
                        return { busy: false, skip: true, validationErrors: (validacion && validacion.errores) || [] };
                    }
                    if (typeof validacion.texto === 'string') text = validacion.texto;
                }

                consoleEvent('respuesta_validada', { comentario: truncate(text, 600), humor: humor });
                return mezclarObjetos({ busy: false, text: text, mood: humor }, metricas);
            }

            var inicioPrimerIntento = Date.now();
            return solicitarMonitoreado(promptDatos).then(function (result) {
                var primera = interpretar(result);
                if (primera.busy || primera.terminal) return primera;
                if (!primera.skip) return primera;

                var ultimaGeneracionMs = Date.now() - inicioPrimerIntento;
                if (!puedeReintentar(video, tiempoActual, ultimaGeneracionMs)) {
                    return { busy: false, skip: true, sinPresupuestoReintento: true };
                }
                var instruccionesSegundoIntento = [
                    INSTRUCCIONES_REINTENTO,
                    contratoHumor.instruccionReintento || ''
                ].filter(Boolean).join('\n\n');
                if (primera.validationErrors && primera.validationErrors.length) {
                    instruccionesSegundoIntento += '\nLa respuesta anterior incumplió estas reglas: ' +
                        describirErroresValidacion(primera.validationErrors).join('; ') +
                        '. Corrige esos puntos, conserva el estado emocional basado solo en subtitulos_actuales y devuelve el JSON indicado.';
                }
                estadisticas.reintentosModelo++;
                return solicitarMonitoreado(promptDatos, instruccionesSegundoIntento).then(function (reintento) {
                    return interpretar(reintento, true);
                });
            }).then(function (final) {
                contabilizarResultado(final);
                return final;
            });
        }

        // --------------------------------------------------------------------
        // Mantenimiento del modelo
        // --------------------------------------------------------------------

        /**
         * Descarga el modelo de la memoria de Ollama (útil cuando devuelve
         * respuestas idénticas repetidas). Espera si Ollama está ocupado.
         * `keep_alive` es 0 por defecto, que es lo que descarga el modelo;
         * puede cambiarse con VP.mochiConfig.keepAliveLimpieza.
         */
        function limpiarModelo() {
            if (!VP.ollama || typeof VP.ollama.chat !== 'function') {
                return Promise.reject(crearError('NO_CLIENT', 'No hay un cliente de Ollama disponible para descargar el modelo.'));
            }
            var endpoint = getEndpoint();
            var model = getModel();
            var keepAlive = (CFG.keepAliveLimpieza !== undefined && CFG.keepAliveLimpieza !== null) ? CFG.keepAliveLimpieza : 0;
            // Mensaje mínimo y num_predict 1: evita generar texto mientras se descarga.
            var body = {
                model: model,
                messages: [{ role: 'user', content: ' ' }],
                keep_alive: keepAlive,
                stream: false,
                options: { num_predict: 1 }
            };
            var timeoutMs = Math.min(30000, Number(mochiParametro('timeoutMs')) || 30000);

            function intentar(restantes) {
                var descarga = function () {
                    return VP.ollama.chat.call(VP.ollama, endpoint, body, { signal: null }, {
                        timeout: timeoutMs, timeoutMs: timeoutMs, retries: 0, queued: false
                    });
                };
                var operacion;
                try {
                    operacion = typeof VP.ollama.runIfIdle === 'function'
                        ? VP.ollama.runIfIdle(descarga)
                        : descarga();
                } catch (e) { operacion = Promise.reject(e); }
                return Promise.resolve(operacion).then(function (resultado) {
                    if (resultado && resultado.busy) {
                        if (restantes <= 0) throw crearError('BUSY', 'Ollama siguió ocupado y no se pudo descargar el modelo.');
                        return new Promise(function (resolve) { setTimeout(resolve, LIMPIEZA_ESPERA_MS); }).then(function () {
                            return intentar(restantes - 1);
                        });
                    }
                    consoleEvent('ollama_modelo_descargado', { modelo: model, endpoint: endpoint, motivo: 'respuesta idéntica repetida' });
                    return resultado;
                });
            }
            return intentar(LIMPIEZA_INTENTOS_OCUPADO);
        }

        // --------------------------------------------------------------------
        // Diagnóstico
        // --------------------------------------------------------------------
        function nombreModeloCoincide(a, b) {
            function canon(n) {
                n = String(n || '').trim().toLowerCase();
                return n.indexOf(':') === -1 ? n + ':latest' : n;
            }
            return canon(a) === canon(b);
        }

        /**
         * Lista los modelos instalados en el servidor de Ollama.
         * @returns {Promise<string[]>}
         */
        function listarModelos(opciones) {
            opciones = opciones || {};
            var timeoutMs = numeroEnRango(opciones.timeoutMs, 1000, 60000) || DIAGNOSTICO_TIMEOUT_MS;
            return obtenerJson(getEndpoint(), '/api/tags', timeoutMs, opciones.signal).then(function (json) {
                var modelos = json && Array.isArray(json.models) ? json.models : [];
                return modelos.map(function (m) { return m && (m.name || m.model); })
                    .filter(function (nombre) { return typeof nombre === 'string' && nombre; });
            }).catch(function (e) { throw clasificarError(e); });
        }

        /** @returns {Promise<boolean>} true si el modelo configurado está instalado. */
        function modeloDisponible(nombre, opciones) {
            var buscado = nombre || getModel();
            return listarModelos(opciones).then(function (nombres) {
                return nombres.some(function (n) { return nombreModeloCoincide(n, buscado); });
            });
        }

        /**
         * Comprueba que Ollama responde y que el modelo configurado existe.
         * Nunca rechaza: devuelve un informe con `ok` y, si falla, `error`.
         */
        function verificarConexion(opciones) {
            opciones = opciones || {};
            var timeoutMs = numeroEnRango(opciones.timeoutMs, 1000, 60000) || DIAGNOSTICO_TIMEOUT_MS;
            var endpoint = getEndpoint();
            var modelo = getModel();
            var inicio = Date.now();
            var informe = {
                ok: false,
                endpoint: endpoint,
                modelo: modelo,
                version: null,
                modeloDisponible: null,
                latenciaMs: null,
                error: null
            };
            return obtenerJson(endpoint, '/api/version', timeoutMs, opciones.signal).then(function (json) {
                informe.ok = true;
                informe.version = (json && json.version) || null;
                informe.latenciaMs = Date.now() - inicio;
                return listarModelos(opciones).then(function (nombres) {
                    informe.modeloDisponible = nombres.some(function (n) { return nombreModeloCoincide(n, modelo); });
                    return informe;
                }, function () { return informe; });
            }).catch(function (e) {
                informe.ok = false;
                informe.latenciaMs = Date.now() - inicio;
                informe.error = describeError(clasificarError(e));
                return informe;
            });
        }

        // --------------------------------------------------------------------
        // API pública
        // --------------------------------------------------------------------
        VP.mochiOllama = {
            version: VERSION_MODULO,
            isBusy: function () {
                try {
                    if (!VP.ollama) return false;
                    return typeof VP.ollama.isBusy === 'function' ? !!VP.ollama.isBusy() : false;
                } catch (_) { return false; }
            },
            configuracion: function () {
                var ocupado = false;
                try { ocupado = !!(VP.ollama && typeof VP.ollama.isBusy === 'function' && VP.ollama.isBusy()); } catch (_) {}
                return {
                    version: VERSION_MODULO,
                    disponible: !!(VP.ollama && typeof VP.ollama.chat === 'function'),
                    endpoint: getEndpoint(),
                    modelo: getModel(),
                    ocupado: ocupado,
                    disyuntor: estadoDisyuntor()
                };
            },
            generarDato: generarDato,
            limpiarModelo: limpiarModelo,
            verificarConexion: verificarConexion,
            listarModelos: listarModelos,
            modeloDisponible: modeloDisponible,
            estadisticas: obtenerEstadisticas,
            reiniciarEstadisticas: function () { estadisticas = crearEstadisticas(); },
            reiniciarDisyuntor: function () {
                disyuntor.abiertoHasta = 0;
                estadisticas.erroresConsecutivos = 0;
            },
            // Expuestos para diagnóstico y pruebas externas.
            describeError: describeError,
            utilidades: {
                limpiarTextoModelo: limpiarTextoModelo,
                esRespuestaMeta: esRespuestaMeta,
                clasificarRespuesta: clasificarRespuesta,
                normalizarEndpoint: function (v) { return normalizarEndpoint(v, cfgNum('maxEndpointLength', 512)); }
            }
        };
    })(window);