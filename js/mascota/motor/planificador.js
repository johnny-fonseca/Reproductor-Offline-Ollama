    /* ==========================================================================
       5. SCHEDULER ADAPTATIVO CON DISYUNTOR
       ========================================================================== */
    (function (window) {
        'use strict';
        var VP = window.VP;
        var CFG = VP.mochiConfig;
        var U = VP._mochiUtil || {};
        var log = U.log || function () {};
        var errLog = U.error || function () {};
        var conJitter = U.conJitter || function (ms) { return ms; };
        var consoleEvent = U.consoleEvent || function () {};
        var safeJsonStringify = U.safeJsonStringify || function (v) { try { return JSON.stringify(v); } catch (_) { return ''; } };
        var normalizeWhitespace = U.normalizeWhitespace || function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
        var truncate = U.truncate || function (s, n) {
            s = String(s == null ? '' : s);
            return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
        };

        // La capa visual puede no estar disponible todavía (o fallar al iniciar).
        // Sus errores no deben interrumpir el ciclo de subtítulos y Ollama.
        function llamarMascota(metodo, args) {
            var mascota = VP.mochiMascota;
            if (!mascota || typeof mascota[metodo] !== 'function') return false;
            try {
                mascota[metodo].apply(mascota, args || []);
                return true;
            } catch (e) {
                log('No se pudo ejecutar la acción visual «' + metodo + '».', e);
                return false;
            }
        }

        var timer = null;
        var controller = null;
        var running = false;
        var active = false;
        var seeking = false;
        var generation = 0;
        var interval = VP.mochiParametro('baseIntervalMs');
        var fallosConsecutivos = 0;
        var esperasSeguidas = 0;
        var disyuntorAbierto = false;
        var reintentoManualPendiente = false;
        var ultimoEstado = 'en espera';
        var estadoTecnico = 'IDLE';
        var ultimoError = '';
        var ultimaLongitudContexto = 0;
        var ultimoDetalleEstado = '';
        var comentarioPendiente = null;
        var ultimaRespuestaGenerada = '';
        var respuestasIdenticasSeguidas = 0;
        var siguienteComentarioEn = 0;
        var latenciaGeneracionMs = 8000;
        // Métricas ampliadas para diagnóstico externo.
        var metricas = {
            comentariosMostrados: 0,
            skipsRecibidos: 0,
            descartesPorDesfase: 0,
            respuestasRepetidas: 0,
            fallosTotales: 0,
            abortsPorSeek: 0,
            ultimoCicloMs: 0
        };

        // Máquina de estados explícita: define transiciones válidas para evitar
        // quedar atrapado en estados transitorios por un error inesperado.
        var TRANSICIONES_VALIDAS = {
            'en espera': ['buscando contexto', 'video pausado', 'pausa de seguridad'],
            'buscando contexto': ['leyendo subtítulos', 'esperando subtítulos', 'esperando subtítulos nuevos', 'video pausado', 'error al leer subtítulos', 'pausa de seguridad'],
            'leyendo subtítulos': ['esperando momento del subtítulo', 'esperando subtítulos', 'esperando subtítulos nuevos', 'generando con Ollama', 'error al leer subtítulos'],
            'generando con Ollama': ['comentario mostrado', 'Ollama ocupado', 'Ollama respondió SKIP o texto vacío', 'buscando otra forma', 'error de Ollama', 'comentario descartado por desfase'],
            'sin presupuesto para reintentar': ['buscando contexto', 'leyendo subtítulos', 'esperando subtítulos nuevos'],
            'esperando momento del subtítulo': ['comentario mostrado', 'comentario descartado por desfase', 'video pausado', 'buscando contexto'],
            'comentario mostrado': ['buscando contexto', 'leyendo subtítulos', 'video pausado'],
            'video pausado': ['buscando contexto', 'leyendo subtítulos'],
            'Ollama ocupado': ['buscando contexto', 'leyendo subtítulos', 'generando con Ollama'],
            'buscando otra forma': ['generando con Ollama', 'sin alternativa nueva', 'comentario mostrado'],
            'sin alternativa nueva': ['buscando contexto', 'esperando subtítulos nuevos'],
            'error de Ollama': ['buscando contexto', 'pausa de seguridad', 'esperando subtítulos nuevos'],
            'pausa de seguridad': ['buscando contexto', 'en espera']
        };

        var ESTADOS_TECNICOS = {
            'en espera': 'IDLE', 'buscando contexto': 'READING_SUBTITLES',
            'leyendo subtítulos': 'READING_SUBTITLES', 'esperando subtítulos': 'WAITING_SUBTITLES',
            'esperando subtítulos nuevos': 'WAITING_SUBTITLES', 'subtítulo futuro seleccionado': 'CONTEXT_READY',
            'generando con Ollama': 'REQUESTING_OLLAMA', 'esperando respuesta de Ollama': 'WAITING_OLLAMA',
            'procesando respuesta': 'PROCESSING_RESPONSE', 'esperando momento del subtítulo': 'WAITING_TIMING',
            'comentario mostrado': 'SPEAKING', 'pausa de seguridad': 'COOLDOWN',
            'error de Ollama': 'ERROR', 'error al leer subtítulos': 'ERROR', 'video pausado': 'IDLE',
            'Ollama ocupado': 'WAITING_OLLAMA', 'buscando otra forma': 'PROCESSING_RESPONSE',
            'sin alternativa nueva': 'WAITING_SUBTITLES', 'comentario descartado por desfase': 'WAITING_SUBTITLES',
            'sin presupuesto para reintentar': 'READING_SUBTITLES'
        };

        function puedeReintentar(video, segundoObjetivo, ultimaGeneracionMs, margenSegundos) {
            if (!video || !isFinite(Number(video.currentTime))) return false;
            margenSegundos = margenSegundos == null ? 1.5 : Number(margenSegundos);
            var restanteMs = (Number(segundoObjetivo) - Number(video.currentTime)) * 1000;
            var reservaMs = Number(ultimaGeneracionMs) * 1.25 + margenSegundos * 1000;
            return isFinite(restanteMs) && isFinite(reservaMs) && restanteMs > reservaMs;
        }

        function esTransicionValida(desde, hacia) {
            var permitidas = TRANSICIONES_VALIDAS[desde];
            if (!permitidas) return true; // si el estado actual no está en la tabla, permitir
            return permitidas.indexOf(hacia) !== -1;
        }

        // Este helper debe vivir en el scheduler: el homónimo dentro del
        // módulo de Ollama no es visible desde esta función autoejecutable.
        function logRespuestaOmitida(motivo) {
            try {
                consoleEvent('respuesta_descartada', { motivo: motivo });
            } catch (_) {}
        }

        function reportarEstado(estado, detalle, silencioso) {
            detalle = String(detalle || '');
            if (estado === ultimoEstado && detalle === ultimoDetalleEstado) return;
            if (!esTransicionValida(ultimoEstado, estado)) {
                log('Transición de estado inesperada: ' + ultimoEstado + ' → ' + estado + ' (' + detalle + ')');
            }
            ultimoEstado = estado;
            ultimoDetalleEstado = detalle;
            var nuevoEstadoTecnico = ESTADOS_TECNICOS[estado] || estadoTecnico;
            if (nuevoEstadoTecnico !== estadoTecnico) {
                estadoTecnico = nuevoEstadoTecnico;
                consoleEvent('estado_tecnico', { estado: estadoTecnico, fase: estado });
            }
            llamarMascota('setTechnicalState', [nuevoEstadoTecnico, detalle]);
            if (silencioso) return;
            if (estado === 'leyendo subtítulos' || estado === 'generando con Ollama' ||
                estado === 'comentario mostrado' || estado === 'video pausado') return;
            var mensajes = {
                'en espera': 'Estoy lista cuando empiece el video.',
                'buscando contexto': 'El video está en marcha; buscaré subtítulos para encontrar algo que contarte.',
                'video pausado': 'Estoy descansando mientras el video está en pausa.',
                'esperando subtítulos': 'Aún no encuentro subtítulos para comentar; seguiré pendiente.',
                'esperando subtítulos nuevos': 'Ya revisé este fragmento; espero algo nuevo para contarte.',
                'leyendo subtítulos': 'Estoy leyendo los subtítulos para buscar algo interesante.',
                'esperando una pausa': 'Ya preparé un comentario; espero una pausa natural para compartirlo.',
                'esperando momento del subtítulo': 'Ya preparé mi reacción; la mostraré cuando llegue ese momento del video.',
                'comentario descartado por desfase': 'El subtítulo ya pasó; esperaré al siguiente para que la reacción llegue a tiempo.',
                'generando con Ollama': 'Estoy conversando con Ollama para preparar una curiosidad…',
                'Ollama ocupado': 'Ollama está ocupado; esperaré un momento y volveré a intentar.',
                'Ollama respondió SKIP o texto vacío': 'No encontré un dato suficientemente claro para compartir todavía.',
                'limpiando Ollama por respuesta repetida': 'Ollama repitió una idea; dejaré avanzar el video y buscaré otro detalle.',
                'Ollama sigue repitiendo': 'Ollama sigue repitiendo; esperaré un fragmento nuevo antes de volver a intervenir.',
                'respuesta repetida descartada': 'Esa idea se parece a algo que ya te conté; esperaré otro detalle.',
                'buscando otra forma': 'Eso me suena a algo que ya te conté; pediré a Ollama otra forma de verlo.',
                'sin alternativa nueva': 'No encontré otro enfoque para este fragmento; esperaré un detalle distinto.',
                'comentario mostrado': 'Ya tengo algo que contarte. ¡Mira mi burbuja! ✨',
                'error al leer subtítulos': 'Tuve un problema leyendo los subtítulos.',
                'error de Ollama': 'No pude completar mi conversación con Ollama.' + (detalle ? ' ' + detalle : ''),
                'pausa de seguridad': 'Necesito una pausa breve antes de volver a intentarlo.'
            };
            var texto = mensajes[estado] || 'Mi estado cambió: ' + estado + (detalle ? ' (' + detalle + ')' : '');
            consoleEvent('estado', { estado: estado, mensaje: texto, detalle: detalle || undefined },
                estado.indexOf('error') === 0 ? 'warn' : 'info');
        }
        // Firmas de cues confirmados por Ollama; las claves incluyen el texto
        // para distinguir subtítulos distintos que empiezan en el mismo segundo.
        var cuesConfirmados = Object.create(null);
        var recentFacts = [];
        // Umbral de similitud Jaccard para descartar comentarios casi repetidos.
        var UMBRAL_SIMILITUD_JACCARD = 0.72;
        var videoIdentity = '';
        var noContextAvisado = false;

        function clampInterval(value) {
            var min = Math.max(1000, Number(VP.mochiParametro('minIntervalMs')) || 22000);
            var max = Math.max(min, Number(VP.mochiParametro('maxIntervalMs')) || 120000);
            return Math.max(min, Math.min(max, Number(value) || Number(VP.mochiParametro('baseIntervalMs')) || 42000));
        }
        function currentVideo() { return VP.refs && VP.refs.videoPlayer; }
        function identity(video) {
            var current = window.vpCurrentVideo;
            return String((current && (current.id || current.name)) || (video && (video.currentSrc || video.src)) || '');
        }
        function cancelTimer() { if (timer) clearTimeout(timer); timer = null; }
        function scheduleEntrega(video) {
            cancelTimer();
            if (!active || !running || seeking || disyuntorAbierto || !comentarioPendiente) return;
            // Sin un video activo no hay un reloj fiable para programar la
            // entrega. Evita propagar NaN desde Number(undefined) a setTimeout.
            if (!video) return;
            var currentRate = Number(video.playbackRate);
            var currentTime = Number(video.currentTime);
            if (!isFinite(currentTime)) return;
            var rate = isFinite(currentRate) && currentRate > 0
                ? Math.max(0.25, currentRate)
                : 1;
            var restante = (Number(comentarioPendiente.mostrarEn) - currentTime) / rate;
            if (!isFinite(restante)) return;
            var delayMs = restante > 2
                ? Math.min(1000, Math.max(100, (restante - 1) * 1000))
                : Math.max(20, Math.min(100, restante * 1000));
            timer = setTimeout(attempt, delayMs);
        }
        function schedule(delay) {
            cancelTimer();
            if (!active || !running || seeking || disyuntorAbierto) return;
            timer = setTimeout(attempt, conJitter(clampInterval(delay), VP.mochiParametro('jitterRatio')));
        }
        function waitUntilIdle() {
            cancelTimer();
            if (!active || !running || seeking || disyuntorAbierto) return;
            var minEspera = Math.max(Number(VP.mochiParametro('busyPollMinMs')) || 2500, esperasSeguidas * 1500);
            var maxEspera = Number(VP.mochiParametro('busyPollMaxMs')) || 10000;
            timer = setTimeout(function () {
                timer = null;
                if (!active || !running || seeking || disyuntorAbierto) return;
                if (VP.mochiOllama.isBusy()) { consoleEvent('ollama_busy', { esperaMs: Math.min(maxEspera, minEspera) }); ajustarPorEspera(); waitUntilIdle(); }
                else { esperasSeguidas = 0; schedule(interval); }
            }, Math.min(maxEspera, minEspera));
        }
        function abrirDisyuntor() {
            disyuntorAbierto = true;
            consoleEvent('circuito_abierto', { fallosConsecutivos: fallosConsecutivos, cooldownMs: VP.mochiParametro('sleepCooldownMs') });
            comentarioPendiente = null;
            metricas.fallosTotales++;
            reportarEstado('pausa de seguridad', 'Hubo varios intentos fallidos; haré una pausa y reintentaré después.');
            cancelTimer();
            if (controller) { try { controller.abort(); } catch (_) {} controller = null; }
            llamarMascota('dormir');
            log('Disyuntor abierto tras ' + fallosConsecutivos + ' fallos consecutivos; pausa de ' + VP.mochiParametro('sleepCooldownMs') + 'ms.');
            timer = setTimeout(function () {
                timer = null;
                disyuntorAbierto = false;
                consoleEvent('circuito_semiabierto', { fallosConsecutivos: fallosConsecutivos });
                fallosConsecutivos = 0;
                esperasSeguidas = 0;
                interval = clampInterval(VP.mochiParametro('baseIntervalMs'));
                if (active && running && !seeking) schedule(VP.mochiParametro('minIntervalMs'));
            }, VP.mochiParametro('sleepCooldownMs'));
        }
        function ajustarPorEspera() {
            esperasSeguidas++;
            interval = clampInterval(Math.max(interval * 1.3, VP.mochiParametro('baseIntervalMs')));
        }
        function registrarFallo() {
            fallosConsecutivos++;
            metricas.fallosTotales++;
            interval = clampInterval(Math.max(interval * 1.5, VP.mochiParametro('baseIntervalMs')) * (fallosConsecutivos > 1 ? 1.2 : 1));
            if (reintentoManualPendiente) {
                reintentoManualPendiente = false;
                abrirDisyuntor();
                return;
            }
            if (fallosConsecutivos >= (Number(VP.mochiParametro('maxConsecutiveFailures')) || 5)) abrirDisyuntor();
        }
        function normalize(text) {
            var normalized = String(text || '').toLowerCase();
            try { if (typeof normalized.normalize === 'function') normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
            // Une formas numéricas comunes para comparar la misma idea cuando
            // el modelo alterna cifras y palabras ("3 carreras" / "tres").
            normalized = normalized.replace(/\bquince\b/g, '15')
                .replace(/\buno\b|\buna\b/g, '1')
                .replace(/\bdos\b/g, '2').replace(/\btres\b/g, '3')
                .replace(/\bcuatro\b/g, '4').replace(/\bcinco\b/g, '5')
                .replace(/\bcarreras?\b/g, 'carrera');
            // La normalización anterior ya convierte las letras acentuadas
            // comunes en ASCII; evita property escapes para navegadores viejos.
            return normalized.replace(/[^a-z0-9]+/g, ' ').trim();
        }
        function contarRespuestaConsecutiva(text) {
            var firma = normalize(text);
            if (!firma) {
                ultimaRespuestaGenerada = '';
                respuestasIdenticasSeguidas = 0;
                return 0;
            }
            if (firma === ultimaRespuestaGenerada) respuestasIdenticasSeguidas++;
            else { ultimaRespuestaGenerada = firma; respuestasIdenticasSeguidas = 1; }
            return respuestasIdenticasSeguidas;
        }
        function reiniciarPorRespuestaRepetida(token, videoKey, video) {
            if (!requestIsCurrent(token, videoKey, video)) return Promise.resolve();
            // Reiniciar Ollama no mejora una repetición. Conserva los cues ya
            // consumidos y deja que avance el video, evitando el POST inválido
            // de descarga que /api/chat rechaza cuando no hay mensajes.
            reportarEstado('Ollama sigue repitiendo');
            metricas.respuestasRepetidas++;
            ultimaRespuestaGenerada = '';
            respuestasIdenticasSeguidas = 0;
            siguienteComentarioEn = Math.max(siguienteComentarioEn, Number(video.currentTime) + 18);
            llamarMascota('setState', ['idle']);
            return Promise.resolve();
        }
        function mismaIdeaCaptura(text) {
            var t = normalize(text);
            var hablaDeCaptura = /\b(?:atrap\w*|captur\w*|caz\w*|deten\w*|arrest\w*|prend\w*)\b/.test(t);
            var hablaDeNoHacerDano = /\b(?:vivos?|sin\s+(?:mat\w*|lastim\w*|her\w*|dañ\w*|asust\w*)|no\s+(?:mat\w*|lastim\w*|her\w*|dañ\w*|asust\w*))\b/.test(t);
            var hablaDeBichos = /\b(?:rat\w*|polill\w*|insect\w*|mosc\w*|bich\w*)\b/.test(t);
            return hablaDeCaptura && (hablaDeNoHacerDano || hablaDeBichos);
        }
        function isRepeated(text) {
            var candidate = normalize(text);
            if (!candidate) return true;
            var ignorar = /^(?:algo|alguien|alguna|algunas|alguno|algunos|ante|aqui|asi|como|con|cual|cuando|de|del|desde|donde|el|ella|ellas|ellos|en|entre|era|eres|es|esa|esas|ese|eso|esos|esta|estas|este|esto|estos|fue|ha|hay|la|las|le|les|lo|los|mas|me|mi|mis|muy|no|nos|o|para|pero|por|que|se|si|sin|sobre|su|sus|te|tiene|todo|tu|tus|un|una|unas|uno|unos|y|ya)$/;
            var tokens = candidate.split(/\s+/).filter(function (word) { return (word.length > 2 || /^\d{1,2}$/.test(word)) && !ignorar.test(word); });
            var conjuntoCandidatoJaccard = Object.create(null);
            tokens.filter(function (word) { return word.length > 2; }).forEach(function (word) { conjuntoCandidatoJaccard[word] = true; });
            var palabrasCandidatoJaccard = Object.keys(conjuntoCandidatoJaccard);
            var comentariosRecientes = recentFacts.slice(-5);
            for (var j = 0; j < comentariosRecientes.length && palabrasCandidatoJaccard.length; j++) {
                var conjuntoAnteriorJaccard = Object.create(null);
                normalize(comentariosRecientes[j]).split(/\s+/).filter(function (word) { return word.length > 2; })
                    .forEach(function (word) { conjuntoAnteriorJaccard[word] = true; });
                var palabrasAnterioresJaccard = Object.keys(conjuntoAnteriorJaccard);
                var unionJaccard = Object.create(null);
                palabrasCandidatoJaccard.forEach(function (word) { unionJaccard[word] = true; });
                palabrasAnterioresJaccard.forEach(function (word) { unionJaccard[word] = true; });
                var interseccionJaccard = palabrasCandidatoJaccard.filter(function (word) { return conjuntoAnteriorJaccard[word]; }).length;
                var similitudJaccard = interseccionJaccard / Math.max(1, Object.keys(unionJaccard).length);
                if (similitudJaccard >= UMBRAL_SIMILITUD_JACCARD) {
                    consoleEvent('respuesta_similar_descartada', { similitud: Math.round(similitudJaccard * 100) / 100, metodo: 'jaccard' });
                    return true;
                }
            }
            for (var i = 0; i < recentFacts.length; i++) {
                var old = normalize(recentFacts[i]);
                if (candidate === old) { consoleEvent('respuesta_repetida', { texto: truncate(text, 180) }); return true; }
                var candidateWords = candidate.split(/\s+/);
                var oldWords = old.split(/\s+/);
                var oldTrigrams = Object.create(null);
                for (var tri = 0; tri <= oldWords.length - 3; tri++) {
                    oldTrigrams[oldWords.slice(tri, tri + 3).join(' ')] = true;
                }
                var repeatedPhrases = 0;
                for (var phraseIndex = 0; phraseIndex <= candidateWords.length - 3; phraseIndex++) {
                    if (oldTrigrams[candidateWords.slice(phraseIndex, phraseIndex + 3).join(' ')]) repeatedPhrases++;
                }
                if (repeatedPhrases >= 2) { consoleEvent('respuesta_similar_descartada', { similitud: 'frases_compartidas' }); return true; }
                // Variaciones del mismo chiste de capturar algo sin hacerle daño
                // suelen cambiar todas las palabras; evita reciclar esa premisa.
                if (mismaIdeaCaptura(candidate) && mismaIdeaCaptura(old)) return true;
                var oldTokens = old.split(/\s+/).filter(function (word) { return (word.length > 2 || /^\d{1,2}$/.test(word)) && !ignorar.test(word); });
                // Una misma persona + el mismo tipo de conjetura cuenta como el
                // mismo enfoque aunque Ollama cambie sus palabras (p. ej. "negocio
                // sospechoso" frente a "planes personales").
                var enfoqueEspeculativo = /\b(?:sospech|ol[ií]a|negocio|planes? personales|tram|intenci[oó]n|inter[eé]s personal|enga[nñ]|culpa|ventaja|beneficio)\w*\b/;
                if (tokens.length >= 3 && oldTokens.length >= 3 && enfoqueEspeculativo.test(candidate) && enfoqueEspeculativo.test(old)) {
                    var tokensViejos = Object.create(null);
                    oldTokens.forEach(function (word) { tokensViejos[word] = true; });
                    if (tokens.some(function (word) { return word.length >= 5 && tokensViejos[word]; })) return true;
                }
                // Para frases cortas solo el duplicado literal cuenta como repetición.
                if (tokens.length < 5 || oldTokens.length < 5) continue;
                var set = Object.create(null);
                tokens.forEach(function (word) { set[word] = true; });
                var oldSet = Object.create(null);
                oldTokens.forEach(function (word) { oldSet[word] = true; });
                var overlap = 0;
                Object.keys(set).forEach(function (word) { if (oldSet[word]) overlap++; });
                var union = Object.keys(set).length + Object.keys(oldSet).length - overlap;
                var umbralRepeticion = Math.max(0.9,
                    Math.min(1, Number(VP.mochiParametro('duplicateSimilarity')) || 0.9));
                var proporcionDelMenor = overlap / Math.max(1, Math.min(Object.keys(set).length, Object.keys(oldSet).length));
                if (overlap >= 3 && union > 0 &&
                    (overlap / union >= Math.min(0.55, umbralRepeticion) || proporcionDelMenor >= 0.48)) {
                    consoleEvent('respuesta_similar_descartada', { similitud: Math.round((overlap / union) * 100) / 100 });
                    return true;
                }
            }
            return false;
        }
        function rememberFact(text) {
            recentFacts.push(text);
            if (recentFacts.length > Math.max(1, Number(VP.mochiParametro('recentFactCount')) || 5)) recentFacts.shift();
        }
        function registrarComentario(text, video) {
            rememberFact(text);
            metricas.comentariosMostrados++;
            // Mantiene la cadencia solicitada entre comentarios visibles.
            var pausaSegundos = 8;
            siguienteComentarioEn = (Number(video && video.currentTime) || 0) + pausaSegundos;
        }
        function programarComentario(text, mood, token, videoKey, video, cue) {
            llamarMascota('setOllamaStatus', ['respuesta']);
            comentarioPendiente = {
                text: text,
                mood: mood,
                token: token,
                key: videoKey,
                video: video,
                mostrarEn: cue.start,
                firma: cue.firma
            };
            reportarEstado('esperando momento del subtítulo');
            consoleEvent('comentario_programado', { segundoObjetivo: cue.start, texto: truncate(text, 300) });
            scheduleEntrega(video);
        }
        function errorMessage(error) {
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                return '¡Oh no! Me quedé sin internet... ♡';
            }
            var code = error && error.code;
            var message = String((error && error.message) || '').toLowerCase();
            if (code === 'MODEL_NOT_FOUND' || /model.*not found|modelo.*no encontrado/.test(message)) {
                return '¡No encuentro mi modelito! ¿Está bien el nombre? ♡';
            }
            if (code === 'BAD_URL' || /url.*inv[aá]lida/.test(message)) {
                return 'Mi casita Ollama tiene la dirección rara...';
            }
            if (code === 'AUTH' || /401|403|unauthorized|forbidden/.test(message)) {
                return 'Ollama me pidió credenciales que no tengo... ♡';
            }
            if (code === 'CONN_REFUSED' || /failed to fetch|networkerror|refused|econnrefused/.test(message)) {
                return 'No logro despertar a Ollama... ¿está encendido? ♡';
            }
            if (code === 'TIMEOUT' || /timeout|tiempo de espera/.test(message) || (error && error.name === 'AbortError')) {
                return 'Ollama está pensativo, le daré tiempito...';
            }
            if (/429|too many requests/.test(message)) {
                return '¡Ollama está ocupadito! Lo intento luego~';
            }
            if (code === 'SERVER_ERROR' || /5\d\d/.test(message)) {
                return 'Ollama tropezó un momento; ya vuelvo a intentar.';
            }
            return 'Ollama está tomando siesta. ¡Ya volveré! ♡';
        }
        function requestIsCurrent(token, videoKey, video) {
            if (token !== generation || !active || !running || seeking) return false;
            if (currentVideo() !== video || identity(video) !== videoKey) return false;
            return true;
        }
        function programarEntregaComentario(text, token, videoKey, video, mood, cue) {
            programarComentario(text, mood, token, videoKey, video, cue);
        }
        function attempt() {
            timer = null;
            if (!active || !running || seeking || disyuntorAbierto) return;
            var video = currentVideo();
            if (!video || video.paused || video.ended) { reportarEstado('video pausado'); return; }
            var key = identity(video);
            if (videoIdentity && key !== videoIdentity) resetHistory();
            videoIdentity = key;
            if (comentarioPendiente) {
                var pendiente = comentarioPendiente;
                if (pendiente.token !== generation || pendiente.video !== video || pendiente.key !== key) {
                    comentarioPendiente = null;
                } else if (Number(video.currentTime) >= pendiente.mostrarEn) {
                    comentarioPendiente = null;
                    if (pendiente.firma) cuesConfirmados[pendiente.firma] = true;
                    registrarComentario(pendiente.text, video);
                    consoleEvent('comentario_mostrado', { segundo: Number(video.currentTime), texto: truncate(pendiente.text, 300) });
                    llamarMascota('setOllamaStatus', ['idle']);
                    reportarEstado('comentario mostrado');
                    llamarMascota('hablar', [pendiente.text, pendiente.mood]);
                    schedule(interval);
                    return;
                } else {
                    reportarEstado('esperando momento del subtítulo');
                    scheduleEntrega(video);
                    return;
                }
            }
            if (VP.mochiOllama.isBusy()) { llamarMascota('setState', ['pensando']); ajustarPorEspera(); waitUntilIdle(); return; }
            var context = '';
            var cueObjetivo = null;
            var requestTime = Number(video.currentTime);
            var margenProgramacion = Math.max(0.5, Number(VP.mochiParametro('commentaryTimingMarginSeconds')) || 1.5);
            var anticipacion = Math.max(4, Math.min(35, latenciaGeneracionMs / 1000 + margenProgramacion));
            try {
                reportarEstado('leyendo subtítulos');
                var futuros = VP.mochiSubtitulos.obtenerCuesFuturos(requestTime, 0.5, 60, 16);
                for (var indiceFuturo = 0; indiceFuturo < futuros.length; indiceFuturo++) {
                    var candidato = futuros[indiceFuturo];
                    if (candidato.start < requestTime + anticipacion) continue;
                    var firmaCandidato = String(Number(candidato.start)) + '|' + normalizeWhitespace(candidato.text).toLowerCase();
                    if (!cuesConfirmados[firmaCandidato]) {
                        cueObjetivo = { start: candidato.start, end: candidato.end, text: candidato.text, firma: firmaCandidato };
                        break;
                    }
                }
                // Si no existe un subtítulo suficientemente adelantado, prepara
                // el próximo disponible en vez de reaccionar al pasado.
                if (!cueObjetivo) {
                    for (var indiceProximo = 0; indiceProximo < futuros.length; indiceProximo++) {
                        var proximo = futuros[indiceProximo];
                        if (proximo.start <= requestTime + 0.5) continue;
                        var firmaProximo = String(Number(proximo.start)) + '|' + normalizeWhitespace(proximo.text).toLowerCase();
                        if (!cuesConfirmados[firmaProximo]) {
                            cueObjetivo = { start: proximo.start, end: proximo.end, text: proximo.text, firma: firmaProximo };
                            break;
                        }
                    }
                }
                if (cueObjetivo) {
                    context = VP.mochiSubtitulos.obtenerContextoEn(cueObjetivo.start,
                        Math.max(20, anticipacion + 8), VP.mochiParametro('maxSubtitleChars'));
                } else {
                    context = VP.mochiSubtitulos.obtenerContexto(requestTime,
                        VP.mochiParametro('bufferSeconds'), VP.mochiParametro('maxSubtitleChars'));
                }
            } catch (e) {
                ultimoError = String((e && e.message) || e);
                reportarEstado('error al leer subtítulos', ultimoError);
                errLog('Error leyendo subtítulos:', e);
                schedule(interval);
                return;
            }
            ultimaLongitudContexto = context ? context.replace(/\[[^\]]+\]/g, '').trim().length : 0;
            if (!cueObjetivo) {
                reportarEstado(context ? 'esperando subtítulos nuevos' : 'esperando subtítulos');
                if (!context && !noContextAvisado) {
                    noContextAvisado = true;
                    var perfilSinContexto = VP.mochiPerfilActual();
                    var frasesSinContexto = perfilSinContexto.frases && perfilSinContexto.frases.sinContexto;
                    var avisoSinContexto = U.seleccionarFraseSesion
                        ? U.seleccionarFraseSesion(frasesSinContexto, perfilSinContexto.id || CFG.genero, 'sinContexto')
                        : (perfilSinContexto.seleccionarFrase ? perfilSinContexto.seleccionarFrase('sinContexto') : '');
                    if (!avisoSinContexto) avisoSinContexto = 'Aún no recibo subtítulos para comentar.';
                    llamarMascota('hablarLocal', [avisoSinContexto, 4200]);
                }
                schedule(interval);
                return;
            }
            noContextAvisado = false;
            var esperaComentario = siguienteComentarioEn - Number(video.currentTime);
            if (esperaComentario > 0) {
                reportarEstado('esperando subtítulos nuevos', 'Dejo avanzar la escena antes de comentar otra vez.', true);
                schedule(Math.max(1000, Math.min(15000, esperaComentario * 1000)));
                return;
            }
            var contextoParaEnviar = context;
            consoleEvent('subtitulo_futuro_seleccionado', {
                segundoActual: requestTime,
                segundoObjetivo: cueObjetivo.start,
                anticipacionSegundos: Math.round((cueObjetivo.start - requestTime) * 100) / 100,
                latenciaEstimadaMs: Math.round(latenciaGeneracionMs),
                texto: truncate(cueObjetivo.text, 180)
            });
            reportarEstado('subtítulo futuro seleccionado', truncate(cueObjetivo.text, 180), true);

            controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var localController = controller;
            var token = generation;
            var startedAt = Date.now();
            ultimoError = '';
            reportarEstado('generando con Ollama', VP.mochiOllama.configuracion().modelo);
            consoleEvent('ollama_request_sent', { modelo: VP.mochiOllama.configuracion().modelo, segundoObjetivo: cueObjetivo.start });
            llamarMascota('setOllamaStatus', ['waiting']);
            llamarMascota('setState', ['pensando']);

            var solicitud;
            try {
                solicitud = VP.mochiOllama.generarDato(contextoParaEnviar, localController ? localController.signal : null, recentFacts.slice(),
                    (window.vpCurrentVideo && window.vpCurrentVideo.name) || '', cueObjetivo.start, requestTime, video);
            } catch (e) { solicitud = Promise.reject(e); }
            reportarEstado('esperando respuesta de Ollama', '', true);

            Promise.resolve(solicitud)
                .then(function (result) {
                    if (!requestIsCurrent(token, key, video)) return;
                    var elapsedGeneration = Date.now() - startedAt;
                    metricas.ultimoCicloMs = elapsedGeneration;
                    latenciaGeneracionMs = Math.max(2500, Math.min(90000,
                        latenciaGeneracionMs * 0.65 + elapsedGeneration * 0.35));
                    consoleEvent('latencia_mochi', {
                        generacionMs: elapsedGeneration,
                        estimacionMs: Math.round(latenciaGeneracionMs),
                        segundoObjetivo: cueObjetivo.start
                    });
                    var totalDurationMs = result && result.total_duration != null ? result.total_duration / 1e6 : null;
                    consoleEvent('ollama_response_received', {
                        generacionMs: elapsedGeneration,
                        total_duration_ms: totalDurationMs,
                        diferenciaMs: totalDurationMs == null ? null : elapsedGeneration - totalDurationMs,
                        load_duration_ms: result && result.load_duration != null ? result.load_duration / 1e6 : null,
                        prompt_eval_count: result && result.prompt_eval_count != null ? result.prompt_eval_count : null,
                        prompt_eval_duration_ms: result && result.prompt_eval_duration != null ? result.prompt_eval_duration / 1e6 : null,
                        eval_count: result && result.eval_count != null ? result.eval_count : null,
                        eval_duration_ms: result && result.eval_duration != null ? result.eval_duration / 1e6 : null,
                        segundoObjetivo: cueObjetivo.start
                    });
                    reportarEstado('procesando respuesta', '', true);
                    if (Math.abs(Number(video.currentTime) - requestTime) > Math.max(30, Number(VP.mochiParametro('staleContextSeconds')) || Number(VP.mochiParametro('bufferSeconds')) || 90)) {
                        llamarMascota('setOllamaStatus', ['idle']);
                        llamarMascota('setState', ['idle']);
                        return;
                    }
                    if (Number(video.currentTime) > cueObjetivo.start + 3) {
                        cuesConfirmados[cueObjetivo.firma] = true;
                        metricas.descartesPorDesfase++;
                        consoleEvent('comentario_descartado_por_desfase', { segundoActual: Number(video.currentTime), segundoObjetivo: cueObjetivo.start, latenciaMs: elapsedGeneration });
                        reportarEstado('comentario descartado por desfase');
                        llamarMascota('setState', ['idle']);
                        return;
                    }
                    if (typeof result === 'string') result = { text: result };
                    if (!result || typeof result !== 'object') result = { skip: true };
                    if (result.busy) { consoleEvent('ollama_busy', { motivo: 'peticion_en_vuelo' }); reportarEstado('Ollama ocupado'); llamarMascota('setState', ['pensando']); ajustarPorEspera(); waitUntilIdle(); return; }
                    reintentoManualPendiente = false;
                    fallosConsecutivos = 0;
                    esperasSeguidas = 0;
                    // Una generación lenta no debe alejar la siguiente revisión;
                    // Ollama ya serializa las peticiones cuando sigue ocupado.
                    interval = clampInterval(Math.min(interval, Number(VP.mochiParametro('baseIntervalMs')) || interval));
                    if (result.skip || typeof result.text !== 'string' || !result.text.trim()) {
                        // SKIP y las respuestas definitivamente vacías/inválidas
                        // son resultados terminales: consume estos cues para no
                        // volver a pedir el mismo comentario en cada intervalo.
                        cuesConfirmados[cueObjetivo.firma] = true;
                        metricas.skipsRecibidos++;
                        consoleEvent(result.sinPresupuestoReintento ? 'reintento_omitido' : result.terminal ? 'respuesta_skipped' : 'respuesta_invalida', {
                            segundoObjetivo: cueObjetivo.start,
                            estado: result.sinPresupuestoReintento ? 'sin presupuesto para reintentar' : undefined
                        });
                        llamarMascota('setOllamaStatus', [result.terminal ? 'idle' : 'invalida']);
                        contarRespuestaConsecutiva('');
                        reportarEstado(result.sinPresupuestoReintento ? 'sin presupuesto para reintentar' : 'Ollama respondió SKIP o texto vacío');
                        llamarMascota('setState', ['idle']);
                        return;
                    }
                    contarRespuestaConsecutiva(result.text);
                    if (isRepeated(result.text)) {
                        logRespuestaOmitida('respuesta repetida; se pide otro enfoque');
                        cuesConfirmados[cueObjetivo.firma] = true;
                        if (!puedeReintentar(video, cueObjetivo.start, elapsedGeneration, 1.5)) {
                            consoleEvent('reintento_omitido', { segundoObjetivo: cueObjetivo.start, estado: 'sin presupuesto para reintentar' });
                            reportarEstado('sin presupuesto para reintentar');
                            llamarMascota('setState', ['idle']);
                            return;
                        }
                        reportarEstado('buscando otra forma');
                        llamarMascota('setState', ['pensando']);
                        var historialAlternativa = recentFacts.slice();
                        historialAlternativa.push(result.text);
                        cuesConfirmados[cueObjetivo.firma] = true;
                        return Promise.resolve(VP.mochiOllama.generarDato(contextoParaEnviar,
                            localController ? localController.signal : null,
                            historialAlternativa,
                            (window.vpCurrentVideo && window.vpCurrentVideo.name) || '',
                            cueObjetivo.start, requestTime, video))
                            .then(function (alternativa) {
                                if (!requestIsCurrent(token, key, video)) return;
                                if (Math.abs(Number(video.currentTime) - requestTime) > Math.max(30,
                                    Number(VP.mochiParametro('staleContextSeconds')) ||
                                    Number(VP.mochiParametro('bufferSeconds')) || 90)) return;
                                if (Number(video.currentTime) > cueObjetivo.start + 3) {
                                    reportarEstado('comentario descartado por desfase');
                                    metricas.descartesPorDesfase++;
                                    llamarMascota('setState', ['idle']);
                                    return;
                                }
                                if (alternativa && !alternativa.busy && !alternativa.skip && alternativa.text &&
                                    contarRespuestaConsecutiva(alternativa.text) >= 3) {
                                    return reiniciarPorRespuestaRepetida(token, key, video);
                                }
                                if (!alternativa || alternativa.busy || alternativa.skip || isRepeated(alternativa.text)) {
                                    if (alternativa && alternativa.skip) contarRespuestaConsecutiva('');
                                    reportarEstado('sin alternativa nueva');
                                    llamarMascota('setState', ['idle']);
                                    return;
                                }
                                programarEntregaComentario(alternativa.text, token, key, video, alternativa.mood, cueObjetivo);
                            });
                    }
                    programarEntregaComentario(result.text, token, key, video, result.mood, cueObjetivo);
                })
                .catch(function (error) {
                    if (!requestIsCurrent(token, key, video) || (error && error.name === 'AbortError')) return;
                    contarRespuestaConsecutiva('');
                    ultimoError = String((error && error.message) || error);
                    consoleEvent('ollama_error', { codigo: error && error.code || '', mensaje: truncate(ultimoError, 240) }, 'warn');
                    if (VP.log && typeof VP.log.warnGrouped === 'function') {
                        VP.log.withContext('Mochi', function () {
                            VP.log.warnGrouped(
                                'mochi-ollama-error:' + String(error && error.code || '') + ':' + ultimoError,
                                'Error de Ollama:', ultimoError
                            );
                        });
                    }
                    var ollamaNoDisponible = !!(error && error.code === 'CONN_REFUSED') || /failed to fetch|econnrefused|connection refused|actively refused|conexi[oó]n rechazada|conexi[oó]n rehusada/i.test(ultimoError);
                    reportarEstado('error de Ollama', ultimoError + (ollamaNoDisponible ? ' OLLAMA_UNAVAILABLE' : ''));
                    llamarMascota('setOllamaStatus', ['idle']);
                    registrarFallo();
                    llamarMascota('mostrarAviso', [errorMessage(error)]);
                    if (disyuntorAbierto) {
                        setTimeout(function () {
                            if (disyuntorAbierto) llamarMascota('dormir');
                        }, 4200);
                    }
                })
                .then(function () {
                    if (controller === localController) controller = null;
                    if (requestIsCurrent(token, key, video) && !timer && !disyuntorAbierto) schedule(interval);
                })
                .catch(function (e) {
                    errLog('Error inesperado en el ciclo de Mochi-IA:', e);
                    llamarMascota('setOllamaStatus', ['idle']);
                    if (controller === localController) controller = null;
                    if (requestIsCurrent(token, key, video) && !timer && !disyuntorAbierto) schedule(interval);
                });
        }
        function resetHistory() {
            cuesConfirmados = Object.create(null); recentFacts = []; noContextAvisado = false; comentarioPendiente = null;
            ultimaRespuestaGenerada = ''; respuestasIdenticasSeguidas = 0;
            siguienteComentarioEn = 0;
        }
        function cancelForSeek() {
            seeking = true;
            reintentoManualPendiente = false;
            llamarMascota('setOllamaStatus', ['idle']);
            generation++;
            metricas.abortsPorSeek++;
            comentarioPendiente = null;
            cancelTimer();
            if (controller) { try { controller.abort(); } catch (_) {} }
            controller = null;
        }

        VP.mochiScheduler = {
            puedeReintentar: puedeReintentar,
            start: function () {
                if (running) return;
                active = true;
                running = true;
                seeking = false;
                disyuntorAbierto = false;
                reportarEstado('buscando contexto');
                generation++;
                var video = currentVideo();
                videoIdentity = identity(video);
                if (comentarioPendiente && comentarioPendiente.video === video && comentarioPendiente.key === videoIdentity) {
                    comentarioPendiente.token = generation;
                    scheduleEntrega(video);
                } else {
                    comentarioPendiente = null;
                    schedule(VP.mochiParametro('minIntervalMs'));
                }
            },
            wake: function () {
                if (!active || !running || seeking || disyuntorAbierto) return;
                if (comentarioPendiente) scheduleEntrega(currentVideo());
                else schedule(VP.mochiParametro('minIntervalMs'));
            },
            invalidateContext: function () {
                if (controller) { try { controller.abort(); } catch (_) {} controller = null; }
                generation++; comentarioPendiente = null; cancelTimer();
                if (active && running && !seeking && !disyuntorAbierto) schedule(VP.mochiParametro('minIntervalMs'));
            },
            seekStart: cancelForSeek,
            seekEnd: function () { if (!active || !running) return; resetHistory(); seeking = false; generation++; schedule(VP.mochiParametro('minIntervalMs')); },
            pause: function () {
                running = false;
                llamarMascota('setOllamaStatus', ['idle']);
                generation++;
                if (comentarioPendiente) comentarioPendiente.token = generation;
                cancelTimer();
                if (controller) { try { controller.abort(); } catch (_) {} }
                controller = null;
                reportarEstado('video pausado');
            },
            stop: function () {
                active = false;
                running = false;
                seeking = false;
                disyuntorAbierto = false;
                reintentoManualPendiente = false;
                llamarMascota('setOllamaStatus', ['idle']);
                comentarioPendiente = null;
                generation++;
                cancelTimer();
                if (controller) {
                    try { controller.abort(); } catch (_) {}
                    controller = null;
                }
                resetHistory();
                videoIdentity = '';
                if (VP.mochiMascota && typeof VP.mochiMascota.setState === 'function') {
                    try { VP.mochiMascota.setState('idle'); } catch (_) {}
                }
            },
            reset: function () { this.stop(); fallosConsecutivos = 0; esperasSeguidas = 0; interval = clampInterval(VP.mochiParametro('baseIntervalMs')); },
            destrabar: function () {
                if (!active || !running) return false;
                generation++;
                cancelTimer();
                if (controller) { try { controller.abort(); } catch (_) {} }
                controller = null;
                disyuntorAbierto = false;
                fallosConsecutivos = 0;
                esperasSeguidas = 0;
                interval = clampInterval(VP.mochiParametro('baseIntervalMs'));
                resetHistory();
                videoIdentity = identity(currentVideo());
                reportarEstado('buscando contexto');
                attempt();
                return true;
            },
            despertarPorClic: function () {
                if (!disyuntorAbierto) return false;
                reintentoManualPendiente = true;
                return this.destrabar();
            },
            forzarAhora: function () { if (!active || !running) return false; cancelTimer(); attempt(); return true; },
            estado: function () {
                return {
                    activo: active, corriendo: running, buscando: seeking,
                    disyuntorAbierto: disyuntorAbierto, fallosConsecutivos: fallosConsecutivos,
                    respuestasIdenticasSeguidas: respuestasIdenticasSeguidas,
                    intervaloMs: interval, hechosRecordados: recentFacts.length,
                    ultimoEstado: ultimoEstado, estadoTecnico: estadoTecnico, ultimoError: ultimoError,
                    longitudContexto: ultimaLongitudContexto,
                    metricas: {
                        comentariosMostrados: metricas.comentariosMostrados,
                        skipsRecibidos: metricas.skipsRecibidos,
                        descartesPorDesfase: metricas.descartesPorDesfase,
                        respuestasRepetidas: metricas.respuestasRepetidas,
                        fallosTotales: metricas.fallosTotales,
                        abortsPorSeek: metricas.abortsPorSeek,
                        ultimoCicloMs: metricas.ultimoCicloMs
                    }
                };
            },
            getInterval: function () { return interval; },
            // Expuesto para diagnóstico externo.
            metricas: function () {
                var copia = {};
                for (var clave in metricas) {
                    if (Object.prototype.hasOwnProperty.call(metricas, clave)) copia[clave] = metricas[clave];
                }
                return copia;
            }
        };
    })(window);
