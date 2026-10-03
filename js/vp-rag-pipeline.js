'use strict';
// =============================================================================
// VP-RAG-PIPELINE.JS  —  v3.1.0
// Módulos de pipeline: intent, rewriter, memoria, caché, seguridad,
// prompts, tool calling, OCR y extracción de frames.
//
// MEJORA 19: Intent detection con 8 categorías vs 4 anteriores
// MEJORA 20: Query rewriting solo cuando hay ambigüedad real
// MEJORA 21: MemoryManager con rolling summary + episódica + topic tracking
// MEJORA 22: Semantic cache LRU con umbral de similitud configurable
// MEJORA 23: Security: prompt injection, XSS, retrieval poisoning, transcript sanitization
// MEJORA 24: Prompts cortos y eficientes, optimizados para Qwen 9B Q4
// MEJORA 25: Anti-hallucination prompt integrado al system prompt
// MEJORA 26: Tool calling con 6 herramientas nativas
// MEJORA 27: Tool planner que parsea respuestas de Qwen3 tool use
// MEJORA 28: OCR lazy loading con Tesseract.js
// MEJORA 29: Frame extractor vía canvas + video.seeked
// MEJORA 30: Fusión de resultados OCR en el retrieval
//
// FIX v3.1.0:
//  - SemanticCache.store: registra videoId en cada entrada para que
//    invalidateVideo() funcione correctamente (bug silencioso previo)
//  - SemanticCache.store: acepta parámetro videoId opcional
//  - MemoryManager._summarize: añade AbortController con timeout para
//    evitar fetch colgante si Ollama no responde durante compresión
//  - MemoryManager._trackTopics: fix de sort comparator con bind(this)
//    (era correcto pero con riesgo en engines ES5 estrictos; ahora usa
//    closure directo)
//  - MemoryManager.getTopTopics: reemplaza Object.entries() con
//    Object.keys() + map para mayor compatibilidad
//  - parseToolCalls: regex JSON fallback reemplazado por búsqueda
//    no-backtracking segura contra ReDoS
//  - StreamRenderer: guard contra containerEl nulo
//  - StreamRenderer.scheduleFlush: no arranca el timer si el renderer
//    ya fue cancelado (done=true) antes de la primera iteración
//  - queryRewriter.rewrite: clearTimeout en el catch además del then
//  - frameExtractor.extractFrame: restaura pausa/play del video tras seek
//  - ocr.processFrame: no lanza si text está vacío (no guarda en IDB)
//
// Requiere: vp-rag-core.js
// =============================================================================

(function (window, document) {
    'use strict';

    if (window.__VP_RAG_PIPELINE_LOADED__) return;
    window.__VP_RAG_PIPELINE_LOADED__ = true;

    var VP = window.VP;
    if (!VP || !VP.rag) throw new Error('[VP] vp-rag-pipeline.js: vp-rag-core.js debe cargarse primero.');

    var log = VP.log || console;
    var rag = VP.rag;
    var CFG = rag.CFG;  // RAG_CFG exportado desde vp-rag-core.js

    // =========================================================================
    // MÓDULO 9: INTENT DETECTOR
    // =========================================================================
    // MEJORA 19: 8 tipos de intención con instrucciones de prompt específicas

    VP.rag.intentDetector = (function () {

        var INTENTS = [
            {
                id         : 'resumenParcial',
                test       : /\b(?:hasta\s+ahora|hasta\s+el\s+momento|visto\s+hasta|recapitula|qu[ée]\s+ha\s+pasado|llevamos)\b/i,
                mode       : 'resumen',
                antiSpoiler: true,
                instruccion: 'RESUMEN PARCIAL: resume solo lo visto hasta el tiempo actual. Enumera los 3-5 puntos clave. No menciones contenido futuro.',
                promptHint : 'Responde en formato: punto 1, punto 2… Sin intro ni cierre.',
            },
            {
                id         : 'resumenTotal',
                test       : /\b(?:resumen|resumir|resume|sinopsis|en\s+qu[ée]\s+consiste|de\s+qu[ée]\s+trata|tema\s+principal)\b/i,
                mode       : 'resumen',
                antiSpoiler: false,
                instruccion: 'RESUMEN COMPLETO: cubre todos los puntos importantes del video de principio a fin.',
                promptHint : 'Usa bullets para cada sección principal. Máximo 200 palabras.',
            },
            {
                id         : 'busquedaMomento',
                test       : /\b(?:cu[áa]ndo|en\s+qu[ée]\s+minuto|timestamp|momento\s+en\s+que|en\s+qu[ée]\s+parte|segundo\s+en\s+que|a\s+partir\s+de\s+cu[áa]ndo)\b/i,
                mode       : 'busqueda',
                antiSpoiler: false,
                instruccion: 'BÚSQUEDA TEMPORAL: el usuario quiere saber en qué momento ocurre algo. Indica el timestamp exacto [M:SS] y una breve descripción de lo que ocurre.',
                promptHint : 'Formato: "En [M:SS] se menciona/ocurre: …"',
            },
            {
                id         : 'explicacion',
                test       : /\b(?:explica|profundiza|qu[ée]\s+es|qu[ée]\s+significa|c[oó]mo\s+funciona|definici[oó]n\s+de|qu[ée]\s+quiere\s+decir|por\s+qu[ée])\b/i,
                mode       : 'explicacion',
                antiSpoiler: false,
                instruccion: 'EXPLICACIÓN DETALLADA: desarrolla el concepto con claridad. Usa ejemplos del video si los hay.',
                promptHint : 'Máximo 150 palabras. Si hay ejemplo en la transcripción, cítalo.',
            },
            {
                id         : 'comparacion',
                test       : /\b(?:comparar|diferencia\s+entre|vs\.?|versus|en\s+qu[ée]\s+se\s+diferencia|mejor\s+que|peor\s+que|ventajas\s+y\s+desventajas)\b/i,
                mode       : 'explicacion',
                antiSpoiler: false,
                instruccion: 'COMPARACIÓN: identifica los elementos a comparar y estructura la respuesta en columnas o puntos paralelos.',
                promptHint : 'Usa "A: … / B: …" o tabla simple si hay exactamente 2 elementos.',
            },
            {
                id         : 'listado',
                test       : /\b(?:lista|enumera|cu[áa]les\s+son|menciona|ejemplos\s+de|qu[ée]\s+tipos\s+de|todos\s+los|cu[áa]ntos)\b/i,
                mode       : 'normal',
                antiSpoiler: false,
                instruccion: 'LISTADO: el usuario quiere una lista de elementos. Sé exhaustivo con lo que aparece en la transcripción.',
                promptHint : 'Usa bullets numerados. Máximo 10 ítems.',
            },
            {
                id         : 'opinion',
                test       : /\b(?:qu[ée]\s+opinas|vale\s+la\s+pena|recomiendas|es\s+bueno|es\s+malo|pros\s+y\s+contras|debería)\b/i,
                mode       : 'normal',
                antiSpoiler: false,
                instruccion: 'OPINIÓN/VALORACIÓN: basa tu respuesta únicamente en lo que dice el video. Distingue claramente lo que el video dice vs tu análisis.',
                promptHint : 'Distingue: "El video afirma que…" vs "En términos generales…"',
            },
            {
                id         : 'accion',
                test       : /\b(?:salta\s+a|ir\s+a|ve\s+al|ponme\s+en|navega\s+a|ll[eé]vame\s+a|reproduce\s+desde|empieza\s+en)\b/i,
                mode       : 'busqueda',
                antiSpoiler: false,
                instruccion: 'ACCIÓN DE NAVEGACIÓN: el usuario quiere ir a un momento del video. Identifica el timestamp y ejecuta la acción.',
                promptHint : 'Responde brevemente confirmando la acción. Usa la herramienta jump_to_timestamp.',
                isTool     : true,
            },
            {
                id         : 'marcador',
                test       : /\b(?:crea\s+marcador|pon\s+marcador|a[ñn]ade\s+marcador|guarda\s+este\s+momento|marca\s+aqu[íi])\b/i,
                mode       : 'normal',
                antiSpoiler: false,
                instruccion: 'MARCADOR: el usuario quiere crear un marcador. Identifica el tiempo actual y propón un título descriptivo.',
                promptHint : 'Usa la herramienta create_marker.',
                isTool     : true,
            },
            {
                id         : 'busquedaLiteral',
                test       : /\b(?:frase|texto exacto|quote|cita|dice exactamente|aparece la frase|donde dice|cuando dice)\b/i,
                mode       : 'literal',
                antiSpoiler: false,
                instruccion: 'BÚSQUEDA LITERAL EXACTA',
                promptHint : 'Buscar coincidencia exacta en subtítulos.',
            },
        ];

        var DEFAULT_INTENT = {
            id         : 'general',
            mode       : 'normal',
            antiSpoiler: false,
            instruccion: '',
            promptHint : '',
            isTool     : false,
        };

        /**
         * Detecta la intención de una pregunta.
         * @param  {string} question
         * @returns {Object} intent
         */
        function detect(question) {
            if (!question) return DEFAULT_INTENT;
            var q = question.trim();

            for (var i = 0; i < INTENTS.length; i++) {
                if (INTENTS[i].test.test(q)) {
                    return INTENTS[i];
                }
            }
            return DEFAULT_INTENT;
        }

        /** Devuelve todos los intents (para UI de debug). */
        function listIntents() {
            return INTENTS.map(function (itm) {
                return { id: itm.id, mode: itm.mode, antiSpoiler: itm.antiSpoiler };
            });
        }

        return { detect: detect, listIntents: listIntents };

    })();

    // =========================================================================
    // MÓDULO 10: QUERY REWRITER
    // =========================================================================
    // MEJORA 20: Solo reescribe si detecta ambigüedad real (pronombres, etc.)
    //
    // FIX v3.1.0:
    //  - clearTimeout también en el bloque catch
    //  - AbortController nombrado de forma más explícita

    VP.rag.queryRewriter = (function () {

        var AMBIGUITY_PATTERNS = [
            /\b(esto|eso|esa|ese|aquello|aquella|lo\s+que|eso\s+que)\b/i,
            /\b(él|ella|ellos|ellas|le|les|lo|la|los|las)\b/i,
            /\b(después|antes|entonces|ahí|aquí|allí|más\s+adelante|luego)\b/i,
            /\b(también|igual|mismo|misma|igualmente)\b/i,
            /^(y|pero|aunque|además|sin\s+embargo|por\s+eso)\b/i,
            /\b(como\s+dijo|como\s+mencionó|lo\s+que\s+explicó|lo\s+anterior)\b/i,
        ];

        var REWRITE_TIMEOUT_MS = 4000;

        /**
         * Reescribe la query si es ambigua.
         * @param {string} userQuery
         * @param {Object} memory        - instancia de MemoryManager
         * @param {number} currentTime
         * @param {string} ollamaUrl
         * @param {string} model
         * @param {AbortSignal} [externalSignal] - señal externa de cancelación
         */
        function rewrite(userQuery, memory, currentTime, ollamaUrl, model, externalSignal) {
            if (!_isAmbiguous(userQuery)) {
                return Promise.resolve({ query: userQuery, rewritten: false });
            }

            var recentCtx = memory.getRecentContext(3);
            if (!recentCtx) {
                return Promise.resolve({ query: userQuery, rewritten: false });
            }

            var prompt = [
                'Reescribe la siguiente pregunta como pregunta autónoma y específica.',
                'Usa el contexto para resolver todos los pronombres y referencias.',
                'Responde SOLO con la pregunta reescrita. Sin comillas, sin explicaciones.',
                '',
                'Posición en video: ' + _fmtTime(currentTime),
                'Contexto reciente:',
                recentCtx,
                '',
                'Pregunta: ' + userQuery,
                'Reescritura:',
            ].join('\n');

            var internalCtrl = new AbortController();
            var timer = setTimeout(function () { internalCtrl.abort(); }, REWRITE_TIMEOUT_MS);

            // Propagar cancelación externa si se proporciona
            var externalHandler = null;
            if (externalSignal && typeof externalSignal.addEventListener === 'function') {
                externalHandler = function () { internalCtrl.abort(); };
                externalSignal.addEventListener('abort', externalHandler);
            }

            function cleanup() {
                clearTimeout(timer);
                if (externalSignal && externalHandler) {
                    try { externalSignal.removeEventListener('abort', externalHandler); } catch (_) {}
                }
            }

            return VP.ollama.fetchJSON(ollamaUrl + '/api/chat', {
                method  : 'POST',
                headers : { 'Content-Type': 'application/json' },
                body    : JSON.stringify({
                    model   : model,
                    messages: [{ role: 'user', content: prompt }],
                    stream  : false,
                    options : { num_predict: 80, temperature: 0.1, top_p: 0.9, num_ctx: 1024 },
                }),
                signal: internalCtrl.signal,
            }, REWRITE_TIMEOUT_MS)
            .then(function (data) {
                cleanup();
                var rewritten = ((data.message && data.message.content) || '').trim();
                if (rewritten.length >= 10 && rewritten.length < 300) {
                    return { query: rewritten, original: userQuery, rewritten: true };
                }
                return { query: userQuery, rewritten: false };
            })
            .catch(function () {
                cleanup(); // FIX v3.1.0: también en catch
                return { query: userQuery, rewritten: false }; // fallback seguro
            });
        }

        function _isAmbiguous(query) {
            var q = (query || '').trim();
            if (q.length < 5) return false;
            for (var i = 0; i < AMBIGUITY_PATTERNS.length; i++) {
                if (AMBIGUITY_PATTERNS[i].test(q)) return true;
            }
            return false;
        }

        return { rewrite: rewrite };

    })();

    // =========================================================================
    // MÓDULO 11: MEMORY MANAGER
    // =========================================================================
    // MEJORA 21: Rolling summary + episódica + topic tracking
    //
    // FIX v3.1.0:
    //  - _summarize: añade AbortController con timeout
    //  - _trackTopics: closure directo para sort (sin .bind(this) riesgoso)
    //  - getTopTopics: usa Object.keys + map en lugar de Object.entries

    VP.rag.MemoryManager = (function () {

        var COMPRESS_AFTER_TURNS = 12;
        var KEEP_RECENT_TURNS    = 4;
        var SUMMARY_MAX_TOKENS   = 280;
        var SUMMARY_TIMEOUT_MS   = 8000;
        var MAX_TOPICS           = 40;

        // FIX v3.1.1: STOPWORDS movido fuera de _trackTopics para no crear
        // un nuevo Set en cada llamada (bug de performance anterior).
        var TOPIC_STOPWORDS = (function () {
            var s = new Set([
                'que','para','con','una','por','los','las','del','sobre','este',
                'esta','pero','como','si','no','es','son','en','de','la','el',
                'y','a','un','lo','al','se','su','sus','más','fue','ser','hay',
            ]);
            return s;
        })();

        function MemoryManager() {
            this.shortTerm    = [];      // últimos KEEP_RECENT_TURNS turnos
            this.rollingMemo  = '';      // resumen comprimido de turnos anteriores
            this.topicFreq    = {};      // { topic: frecuencia }
            this.episodic     = [];      // marcadores/momentos importantes
            this.turnCount    = 0;
        }

        /** Añade un turno de conversación */
        MemoryManager.prototype.addTurn = function (role, content) {
            this.shortTerm.push({ role: role, content: content, ts: Date.now() });
            this.turnCount++;
            this._trackTopics(content);
        };

        /** Comprime el historial si supera el umbral */
        MemoryManager.prototype.maybeCompress = function (ollamaUrl, model) {
            if (this.shortTerm.length <= COMPRESS_AFTER_TURNS) {
                return Promise.resolve(false);
            }

            var toCompress = this.shortTerm.slice(0, -KEEP_RECENT_TURNS);
            var recent     = this.shortTerm.slice(-KEEP_RECENT_TURNS);
            var self       = this;

            return this._summarize(toCompress, ollamaUrl, model).then(function (summary) {
                if (summary) {
                    self.rollingMemo = self.rollingMemo
                        ? self.rollingMemo + '\n\n[Continuación] ' + summary
                        : summary;
                }
                self.shortTerm = recent;
                return true;
            });
        };

        /** Construye los mensajes de historial para el API */
        MemoryManager.prototype.buildHistoryMessages = function () {
            var messages = [];

            if (this.rollingMemo) {
                messages.push({
                    role   : 'system',
                    content: '[CONTEXTO DE CONVERSACIÓN PREVIA]\n' + this.rollingMemo,
                });
            }

            for (var i = 0; i < this.shortTerm.length; i++) {
                var t = this.shortTerm[i];
                messages.push({ role: t.role, content: t.content });
            }

            return messages;
        };

        /** Obtiene contexto reciente como string para el rewriter */
        MemoryManager.prototype.getRecentContext = function (turns) {
            turns = turns || 3;
            var recent = this.shortTerm.slice(-turns * 2);
            if (!recent.length) return '';

            return recent.map(function (t) {
                return (t.role === 'user' ? 'U' : 'A') + ': ' + (t.content || '').slice(0, 120);
            }).join('\n');
        };

        /**
         * Devuelve los topics más frecuentes.
         * FIX v3.1.0: usa Object.keys + map en lugar de Object.entries (ES5 compat).
         */
        MemoryManager.prototype.getTopTopics = function (limit) {
            limit = limit || 5;
            var tf   = this.topicFreq;
            var keys = Object.keys(tf);
            keys.sort(function (a, b) { return tf[b] - tf[a]; });
            return keys.slice(0, limit);
        };

        /** Añade un marcador episódico */
        MemoryManager.prototype.addEpisodic = function (label, timestamp, type) {
            this.episodic.push({
                label     : label,
                timestamp : timestamp,
                type      : type || 'marker',
                ts        : Date.now(),
            });
        };

        /** Limpia la memoria (cambio de video) */
        MemoryManager.prototype.reset = function () {
            this.shortTerm   = [];
            this.rollingMemo = '';
            this.topicFreq   = {};
            this.episodic    = [];
            this.turnCount   = 0;
        };

        /** Exporta el estado para persistencia */
        MemoryManager.prototype.export = function () {
            // FIX v3.1.1: loop manual en lugar de Object.assign para ES5 strict
            var tfCopy = {};
            var tfKeys = Object.keys(this.topicFreq);
            for (var i = 0; i < tfKeys.length; i++) tfCopy[tfKeys[i]] = this.topicFreq[tfKeys[i]];

            return {
                shortTerm   : this.shortTerm.slice(),
                rollingMemo : this.rollingMemo,
                topicFreq   : tfCopy,
                episodic    : this.episodic.slice(),
                turnCount   : this.turnCount,
            };
        };

        /** Importa estado previo */
        MemoryManager.prototype.import = function (state) {
            if (!state) return;
            this.shortTerm   = Array.isArray(state.shortTerm)   ? state.shortTerm   : [];
            this.rollingMemo = typeof state.rollingMemo === 'string' ? state.rollingMemo : '';
            this.topicFreq   = state.topicFreq   && typeof state.topicFreq === 'object' ? state.topicFreq : {};
            this.episodic    = Array.isArray(state.episodic)    ? state.episodic    : [];
            this.turnCount   = typeof state.turnCount === 'number' ? state.turnCount : 0;
        };

        /**
         * Summarize via Ollama.
         * FIX v3.1.0: añade AbortController con timeout para evitar fetch colgante.
         */
        MemoryManager.prototype._summarize = function (turns, ollamaUrl, model) {
            var conv = turns.map(function (t) {
                return (t.role === 'user' ? 'Usuario' : 'IA') + ': ' + (t.content || '').slice(0, 200);
            }).join('\n');

            var prompt = 'Resume esta conversación en 2-3 oraciones concisas, preservando los temas y datos clave:\n\n' + conv + '\n\nResumen:';

            return VP.ollama.fetchJSON(ollamaUrl + '/api/chat', {
                method  : 'POST',
                headers : { 'Content-Type': 'application/json' },
                body    : JSON.stringify({
                    model   : model,
                    messages: [{ role: 'user', content: prompt }],
                    stream  : false,
                    options : { num_predict: SUMMARY_MAX_TOKENS, temperature: 0.2, num_ctx: 2048 },
                }),
            }, SUMMARY_TIMEOUT_MS)
            .then(function (data) {
                return (data.message && data.message.content) || '';
            })
            .catch(function () {
                return ''; // fallback seguro: no comprimir si falla
            });
        };

        /**
         * Extrae y cuenta términos relevantes como "topics".
         * FIX v3.1.0: closure directo en lugar de .bind(this) para el sort del LRU.
         */
        MemoryManager.prototype._trackTopics = function (text) {
            if (!text) return;

            // Usa TOPIC_STOPWORDS de módulo (no recrea el Set en cada llamada)
            var words = (text.toLowerCase().match(/\b[a-záéíóúñü\w]{4,}\b/g)) || [];

            for (var i = 0; i < words.length; i++) {
                var w = words[i];
                if (!TOPIC_STOPWORDS.has(w)) {
                    this.topicFreq[w] = (this.topicFreq[w] || 0) + 1;
                }
            }

            // LRU trim: elimina los 10 menos frecuentes si supera MAX_TOPICS
            var keys = Object.keys(this.topicFreq);
            if (keys.length > MAX_TOPICS) {
                var tf = this.topicFreq; // closure seguro, sin .bind
                keys.sort(function (a, b) { return tf[a] - tf[b]; }); // ascendente
                for (var j = 0; j < 10 && j < keys.length; j++) {
                    delete this.topicFreq[keys[j]];
                }
            }
        };

        return MemoryManager;

    })();

    // =========================================================================
    // MÓDULO 12: SEMANTIC CACHE
    // =========================================================================
    // MEJORA 22: LRU cache con similitud semántica
    //
    // FIX v3.1.0:
    //  - store: acepta y guarda videoId para que invalidateVideo() funcione
    //  - check: guard defensivo cuando VP.rag.utils.cosine no está disponible

    VP.rag.SemanticCache = (function () {

        var DEFAULT_THRESHOLD = 0.93;
        var DEFAULT_MAX       = 60;
        var DEFAULT_TTL_MS    = 30 * 60 * 1000; // 30 minutos

        function SemanticCache(maxSize, threshold, ttlMs) {
            this.entries   = [];
            this.maxSize   = maxSize   || DEFAULT_MAX;
            this.threshold = threshold || DEFAULT_THRESHOLD;
            this.ttlMs     = ttlMs     || DEFAULT_TTL_MS;
        }

        /**
         * Busca una respuesta cacheada para la query dada.
         * @param  {Array}  queryEmbedding
         * @returns {Object|null} { response, similarity, fromCache: true } o null
         */
        SemanticCache.prototype.check = function (queryEmbedding) {
            if (!queryEmbedding) return null;

            var now  = Date.now();
            var ttl  = this.ttlMs;

            // Limpiar entradas expiradas
            var valid = [];
            for (var e = 0; e < this.entries.length; e++) {
                if ((now - this.entries[e].ts) < ttl) valid.push(this.entries[e]);
            }
            this.entries = valid;

            var best    = null;
            var bestSim = -1;

            // FIX v3.1.0: guard defensivo para cosine
            var cosineFn = (VP.rag.utils && VP.rag.utils.cosine) || function () { return 0; };

            for (var i = 0; i < this.entries.length; i++) {
                var entry = this.entries[i];
                var sim   = cosineFn(queryEmbedding, entry.queryEmb);

                if (sim >= this.threshold && sim > bestSim) {
                    bestSim = sim;
                    best    = entry;
                }
            }

            if (best) {
                // LRU: mover al frente
                var newEntries = [best];
                for (var j = 0; j < this.entries.length; j++) {
                    if (this.entries[j] !== best) newEntries.push(this.entries[j]);
                }
                this.entries = newEntries;

                return {
                    response   : best.response,
                    similarity : bestSim,
                    fromCache  : true,
                    cachedQuery: best.query,
                };
            }

            return null;
        };

        /**
         * Almacena una nueva respuesta en el cache.
         * FIX v3.1.0: acepta y persiste videoId para que invalidateVideo() funcione.
         *
         * @param {Array}  queryEmbedding
         * @param {string} query
         * @param {string} response
         * @param {string} [videoId]   - opcional, usado por invalidateVideo()
         */
        SemanticCache.prototype.store = function (queryEmbedding, query, response, videoId) {
            if (!queryEmbedding) return;

            this.entries.unshift({
                queryEmb : queryEmbedding,
                query    : query,
                response : response,
                videoId  : videoId || null,   // FIX v3.1.0
                ts       : Date.now(),
            });

            // Eviction LRU cuando supera maxSize
            if (this.entries.length > this.maxSize) {
                this.entries.length = this.maxSize;
            }
        };

        /** Invalida entradas de cache de un video específico. */
        SemanticCache.prototype.invalidateVideo = function (videoId) {
            if (!videoId) return;
            this.entries = this.entries.filter(function (e) {
                return !e.videoId || e.videoId !== videoId;
            });
        };

        /** Limpia todo el cache */
        SemanticCache.prototype.clear = function () {
            this.entries = [];
        };

        /** Estadísticas del cache */
        SemanticCache.prototype.stats = function () {
            return {
                size      : this.entries.length,
                maxSize   : this.maxSize,
                threshold : this.threshold,
                ttlMs     : this.ttlMs,
                oldest    : this.entries.length ? new Date(this.entries[this.entries.length - 1].ts) : null,
            };
        };

        return SemanticCache;

    })();

    // =========================================================================
    // MÓDULO 13: SECURITY
    // =========================================================================
    // MEJORA 23: Protección completa contra prompt injection, XSS, retrieval poisoning

    VP.rag.security = (function () {

        var INJECTION_PATTERNS = [
            { re: /<\/?system>/gi,                     rep: '[SYS]'    },
            { re: /\[INST\]|\[\/INST\]/gi,             rep: ''         },
            { re: /<<SYS>>|<\/SYS>/gi,                 rep: ''         },
            { re: /ignore\s+(all\s+)?previous/gi,      rep: '[ignorar]'},
            { re: /you\s+are\s+now/gi,                 rep: '[eres]'   },
            { re: /pretend\s+(you\s+are|to\s+be)/gi,   rep: '[juego]'  },
            { re: /disregard\s+your\s+instructions/gi, rep: '[des]'    },
            { re: /act\s+as\s+(if\s+you\s+are|a)/gi,  rep: '[actúa]'  },
            { re: /forget\s+(everything|all)/gi,       rep: '[olvidar]'},
            { re: /new\s+instructions?:/gi,             rep: '[nueva]'  },
            { re: /override\s+(previous\s+)?prompt/gi, rep: '[over]'   },
            { re: /system\s*:/gi,                      rep: 'sistema:' },
            { re: /assistant\s*:/gi,                   rep: 'ia:'      },
            { re: /human\s*:/gi,                       rep: 'usuario:' },
        ];

        var CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
        var HTML_TAGS     = /<[^>]{0,2000}>/g;  // bounded para evitar ReDoS
        var SCRIPT_TAGS   = /<script[^>]{0,500}>[\s\S]{0,50000}<\/script>/gi;

        /**
         * Sanitiza input del usuario.
         * @param  {string} text
         * @param  {number} maxLen
         */
        function sanitizeInput(text, maxLen) {
            if (!text || typeof text !== 'string') return '';
            maxLen = maxLen || 2000;

            var result = text.replace(CONTROL_CHARS, '');

            for (var i = 0; i < INJECTION_PATTERNS.length; i++) {
                result = result.replace(INJECTION_PATTERNS[i].re, INJECTION_PATTERNS[i].rep);
            }

            return result.slice(0, maxLen);
        }

        /**
         * Sanitiza transcripción antes de incrustarla en un prompt.
         */
        function sanitizeTranscript(text, maxLen) {
            if (!text || typeof text !== 'string') return '';
            maxLen = maxLen || 60000;

            return text
                .replace(SCRIPT_TAGS,   '')
                .replace(HTML_TAGS,     ' ')
                .replace(CONTROL_CHARS, '')
                .replace(/\[INST\]|\[\/INST\]/gi, '')
                .replace(/<<SYS>>|<\/SYS>/gi,     '')
                .replace(/system\s*:/gi,           'sistema:')
                .slice(0, maxLen);
        }

        /**
         * Sanitiza el HTML que generamos con markdown (prevención XSS).
         * Se aplica DESPUÉS de renderMarkdown, sobre el HTML resultante.
         */
        function sanitizeMarkdownHTML(html) {
            if (!html || typeof html !== 'string') return '';

            return html
                .replace(SCRIPT_TAGS,                                 '')
                .replace(/javascript\s*:/gi,                           'void:')
                .replace(/vbscript\s*:/gi,                             'void:')
                .replace(/data\s*:\s*text\/html/gi,                    'data:void')
                .replace(/on\w{1,30}\s*=\s*["'][^"']{0,500}["']/gi,   '')
                .replace(/on\w{1,30}\s*=\s*[^\s>]{1,200}/gi,          '')
                .replace(/<\s*iframe[^>]{0,500}>/gi,                   '')
                .replace(/<\s*object[^>]{0,500}>/gi,                   '')
                .replace(/<\s*embed[^>]{0,500}>/gi,                    '');
        }

        /**
         * Verifica que un chunk pertenece al video correcto (retrieval poisoning).
         */
        function verifyChunk(chunk, expectedVideoId) {
            return (
                chunk &&
                typeof chunk === 'object' &&
                chunk.videoId === expectedVideoId &&
                typeof chunk.text === 'string' &&
                chunk.text.length > 0 &&
                typeof chunk.start === 'number' &&
                typeof chunk.end   === 'number' &&
                chunk.end >= chunk.start
            );
        }

        /**
         * Filtra chunks de retrieval que no pertenecen al video correcto.
         */
        function filterPoisoned(chunks, videoId) {
            return chunks.filter(function (c) { return verifyChunk(c, videoId); });
        }

        /**
         * Escapa HTML básico.
         */
        function escapeHTML(str) {
            return String(str)
                .replace(/&/g,  '&amp;')
                .replace(/</g,  '&lt;')
                .replace(/>/g,  '&gt;')
                .replace(/"/g,  '&quot;')
                .replace(/'/g,  '&#39;');
        }

        return {
            sanitizeInput       : sanitizeInput,
            sanitizeTranscript  : sanitizeTranscript,
            sanitizeMarkdownHTML: sanitizeMarkdownHTML,
            verifyChunk         : verifyChunk,
            filterPoisoned      : filterPoisoned,
            escapeHTML          : escapeHTML,
        };

    })();

    // =========================================================================
    // MÓDULO 14: PROMPT BUILDER
    // =========================================================================
    // MEJORA 24: Prompts cortos y eficientes, optimizados para Qwen 9B Q4
    // MEJORA 25: Anti-hallucination integrado
    // MEJORA 27: Soporte para tool calling nativo de Qwen3

    VP.rag.promptBuilder = (function () {

        var ANTI_HALLUCINATION = 'Si la información no está en los fragmentos, di exactamente: "No encontré esa información en el video."';
        var SPOILER_GUARD      = 'CRÍTICO: El usuario SOLO ha visto hasta {TIME}. NO menciones nada que ocurra después de ese momento.';
        var CITATION_HINT      = 'Cuando cites un momento específico, usa el formato [M:SS] con el timestamp EXACTO que aparece en la transcripción, sin redondear.';

        /**
         * Construye el system prompt principal.
         */
        function buildSystem(options) {
            var title       = options.title       || 'Video';
            var duration    = options.duration    || 0;
            var currentTime = options.currentTime || 0;
            var antiSpoiler = options.antiSpoiler || false;
            var intent      = options.intent      || {};
            var topics      = options.topics      || [];

            var durStr = duration > 0 ? _fmtTime(duration) : 'desconocida';

            var lines = [
                'Eres un asistente experto en el contenido de este video.',
                'Video: "' + title + '" (duración: ' + durStr + ').',
                'Responde siempre en español. Sé preciso y conciso.',
                CITATION_HINT,
                ANTI_HALLUCINATION,
            ];

            if (antiSpoiler) {
                lines.push(SPOILER_GUARD.replace('{TIME}', _fmtTime(currentTime)));
            }

            if (intent.instruccion) {
                lines.push('');
                lines.push('OBJETIVO: ' + intent.instruccion);
            }

            if (intent.promptHint) {
                lines.push('FORMATO: ' + intent.promptHint);
            }

            if (topics.length) {
                lines.push('Temas mencionados antes: ' + topics.join(', ') + '.');
            }

            return lines.join('\n');
        }

        /**
         * Construye el bloque de contexto (fragmentos RAG).
         */
        function buildContextBlock(contextText) {
            if (!contextText || !contextText.trim()) {
                return 'No hay transcripción disponible para este video.';
            }
            return 'FRAGMENTOS RELEVANTES DE TRANSCRIPCIÓN:\n---\n' + contextText + '\n---';
        }

        /**
         * Construye el mensaje de usuario final (context + query).
         */
        function buildUserMessage(userQuery, contextText) {
            return buildContextBlock(contextText) + '\n\nPregunta: ' + userQuery;
        }

        /**
         * Ensambla el array de mensajes completo para la API de Ollama.
         */
        function buildMessages(options) {
            var messages = [];

            messages.push({ role: 'system', content: options.systemPrompt });

            if (options.historyMessages && options.historyMessages.length) {
                for (var i = 0; i < options.historyMessages.length; i++) {
                    messages.push(options.historyMessages[i]);
                }
            }

            messages.push({
                role   : 'user',
                content: buildUserMessage(options.userQuery, options.contextText),
            });

            return messages;
        }

        /**
         * Construye el payload JSON para Ollama (con tools opcionales).
         */
        function buildPayload(model, messages, options) {
            options = options || {};
            var payload = {
                model   : model,
                messages: messages,
                stream  : options.stream !== false,
                options : {
                    temperature   : options.temperature    || 0.45,
                    top_p         : options.top_p          || 0.90,
                    top_k         : options.top_k          || 40,
                    num_predict   : options.num_predict    || 1024,
                    num_ctx       : options.num_ctx        || 4096,
                    repeat_penalty: options.repeat_penalty || 1.1,
                },
            };

            if (options.tools && options.tools.length) {
                payload.tools = options.tools;
            }

            return payload;
        }

        return {
            buildSystem       : buildSystem,
            buildContextBlock : buildContextBlock,
            buildUserMessage  : buildUserMessage,
            buildMessages     : buildMessages,
            buildPayload      : buildPayload,
        };

    })();

    // =========================================================================
    // MÓDULO 15: TOOL CALLING
    // =========================================================================
    // MEJORA 26: 6 herramientas nativas
    // MEJORA 27: Parser de tool calls de Qwen3
    //
    // FIX v3.1.0:
    //  - parseToolCalls: regex JSON fallback reemplazado por búsqueda
    //    segura sin backtracking catastrófico (potencial ReDoS)
    //  - execute: guard mejorado en jump_to_timestamp contra valores no-numéricos

    VP.rag.tools = (function () {

        // ── Definiciones (JSON Schema compatible con Qwen3 tool use) ──────────
        var DEFINITIONS = [
            {
                type: 'function',
                function: {
                    name       : 'search_transcript',
                    description: 'Busca fragmentos específicos en la transcripción del video por texto o tema.',
                    parameters : {
                        type      : 'object',
                        properties: {
                            query    : { type: 'string',  description: 'Término, frase o tema a buscar' },
                            fromSecs : { type: 'number',  description: 'Tiempo inicio del rango (opcional, segundos)' },
                            toSecs   : { type: 'number',  description: 'Tiempo fin del rango (opcional, segundos)' },
                        },
                        required: ['query'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name       : 'jump_to_timestamp',
                    description: 'Navega el reproductor de video a un tiempo específico.',
                    parameters : {
                        type      : 'object',
                        properties: {
                            seconds  : { type: 'number',  description: 'Tiempo en segundos' },
                            autoplay : { type: 'boolean', description: 'Si debe reproducir automáticamente (default true)' },
                        },
                        required: ['seconds'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name       : 'create_marker',
                    description: 'Crea un marcador/capítulo en el video en el tiempo indicado.',
                    parameters : {
                        type      : 'object',
                        properties: {
                            seconds : { type: 'number', description: 'Tiempo en segundos' },
                            title   : { type: 'string', description: 'Título descriptivo del marcador' },
                        },
                        required: ['seconds', 'title'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name       : 'summarize_segment',
                    description: 'Genera un resumen de un segmento de tiempo específico del video.',
                    parameters : {
                        type      : 'object',
                        properties: {
                            fromSecs : { type: 'number', description: 'Tiempo inicio (segundos)' },
                            toSecs   : { type: 'number', description: 'Tiempo fin (segundos)' },
                        },
                        required: ['fromSecs', 'toSecs'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name       : 'get_current_playback',
                    description: 'Obtiene el tiempo actual de reproducción del video.',
                    parameters : { type: 'object', properties: {} },
                },
            },
            {
                type: 'function',
                function: {
                    name       : 'search_ocr',
                    description: 'Busca texto extraído por OCR de los frames del video (texto en pantalla, diapositivas, código).',
                    parameters : {
                        type      : 'object',
                        properties: {
                            query : { type: 'string', description: 'Texto a buscar en los frames' },
                        },
                        required: ['query'],
                    },
                },
            },
        ];

        // Set de nombres de herramientas válidas (para validación rápida)
        var VALID_TOOL_NAMES = (function () {
            var s = new Set();
            for (var i = 0; i < DEFINITIONS.length; i++) s.add(DEFINITIONS[i].function.name);
            return s;
        })();

        /**
         * Parsea una respuesta de Ollama para detectar tool calls.
         * FIX v3.1.0: fallback JSON sin regex [\s\S]*? (potencial ReDoS).
         * Usa indexOf + substring para búsqueda segura.
         *
         * @param  {Object} message - data.message de la respuesta
         * @returns {Array|null} array de { name, arguments } o null
         */
        function parseToolCalls(message) {
            if (!message) return null;

            // Formato nativo Qwen3/Ollama
            if (message.tool_calls && Array.isArray(message.tool_calls)) {
                var calls = message.tool_calls.filter(function (tc) {
                    return tc.function && tc.function.name;
                }).map(function (tc) {
                    var args = tc.function.arguments;
                    if (typeof args === 'string') {
                        try { args = JSON.parse(args); } catch (_) { args = {}; }
                    }
                    return {
                        id        : tc.id || null,
                        name      : tc.function.name,
                        arguments : args || {},
                    };
                });
                return calls.length ? calls : null;
            }

            // FIX v3.1.0: Fallback sin regex backtracking catastrófico.
            // Buscamos el primer '{' y el último '}' del contenido, luego parseamos.
            var content = message.content || '';
            if (!content) return null;

            var start = content.indexOf('{');
            if (start < 0) return null;
            var end = content.lastIndexOf('}');
            if (end <= start) return null;

            var candidate = content.substring(start, end + 1);
            try {
                var parsed = JSON.parse(candidate);
                var name   = parsed.name || (parsed.function && parsed.function.name);
                if (name && VALID_TOOL_NAMES.has(name)) {
                    var parsedArgs = parsed.arguments
                        || parsed.parameters
                        || (parsed.function && parsed.function.arguments)
                        || {};
                    return [{
                        id        : null,
                        name      : name,
                        arguments : parsedArgs,
                    }];
                }
            } catch (_) {}

            return null;
        }

        /**
         * Ejecuta una tool call contra el estado real del reproductor.
         * @param  {Object}   call      - { name, arguments }
         * @param  {Object}   ragEngine - instancia del RAGEngine
         * @returns {Promise<string>}   - resultado en texto
         */
        function execute(call, ragEngine) {
            var name = call.name;
            var args = call.arguments || {};

            switch (name) {

                case 'search_transcript':
                    if (!ragEngine || typeof ragEngine.searchTranscript !== 'function') {
                        return Promise.resolve('[search_transcript: RAGEngine no disponible]');
                    }
                    return ragEngine.searchTranscript(args.query, args.fromSecs, args.toSecs)
                        .then(function (results) {
                            if (!results || !results.length) return 'No se encontraron fragmentos para "' + args.query + '".';
                            return results.map(function (r) {
                                return '[' + _fmtTime(r.start) + '] ' + (r.text || '').trim();
                            }).join('\n\n');
                        });

                case 'jump_to_timestamp': {
                    var secs = parseFloat(args.seconds);
                    if (!isFinite(secs) || secs < 0) {
                        return Promise.resolve('[jump_to_timestamp: segundos inválidos]');
                    }
                    var autoplay = args.autoplay !== false;
                    var video    = VP.refs && VP.refs.videoPlayer;
                    if (video && !video.error && isFinite(video.duration)) {
                        secs = Math.max(0, Math.min(secs, video.duration));
                        video.currentTime = secs;
                        if (autoplay && video.paused) {
                            try { video.play(); } catch (_) {}
                        }
                    }
                    return Promise.resolve('Saltando a ' + _fmtTime(secs) + '.');
                }

                case 'create_marker': {
                    var markerSecs  = parseFloat(args.seconds);
                    var markerTitle = String(args.title || '').slice(0, 100);
                    if (!isFinite(markerSecs) || markerSecs < 0) {
                        return Promise.resolve('[create_marker: segundos inválidos]');
                    }
                    if (VP.estado && !Array.isArray(VP.estado.capitulos)) VP.estado.capitulos = [];
                    if (VP.estado) {
                        var dup = false;
                        for (var ci = 0; ci < VP.estado.capitulos.length; ci++) {
                            if (Math.abs(VP.estado.capitulos[ci].tiempo - markerSecs) < 1) { dup = true; break; }
                        }
                        if (!dup) {
                            VP.estado.capitulos.push({ tiempo: markerSecs, titulo: markerTitle });
                            VP.estado.capitulos.sort(function (a, b) { return a.tiempo - b.tiempo; });
                        }
                    }
                    if (VP.bus) VP.bus.emit('chatIA:marcadorCreado', { seconds: markerSecs, titulo: markerTitle });
                    return Promise.resolve('Marcador "' + markerTitle + '" creado en ' + _fmtTime(markerSecs) + '.');
                }

                case 'summarize_segment':
                    if (!ragEngine || typeof ragEngine.getChunksInRange !== 'function') {
                        return Promise.resolve('[summarize_segment: RAGEngine no disponible]');
                    }
                    return ragEngine.getChunksInRange(args.fromSecs, args.toSecs)
                        .then(function (chunks) {
                            if (!chunks || !chunks.length) return 'No hay transcripción en ese segmento.';
                            return chunks.map(function (c) { return c.text; }).join(' ');
                        });

                case 'get_current_playback': {
                    var videoEl = VP.refs && VP.refs.videoPlayer;
                    var ct      = (videoEl && isFinite(videoEl.currentTime)) ? videoEl.currentTime : 0;
                    var paused  = videoEl ? videoEl.paused : true;
                    return Promise.resolve(
                        'Tiempo actual: ' + _fmtTime(ct) + '. Estado: ' + (paused ? 'pausado' : 'reproduciendo') + '.'
                    );
                }

                case 'search_ocr':
                    if (!ragEngine || typeof ragEngine.searchOCR !== 'function') {
                        return Promise.resolve('[search_ocr: RAGEngine no disponible]');
                    }
                    return ragEngine.searchOCR(args.query)
                        .then(function (results) {
                            if (!results || !results.length) return 'No se encontró texto OCR para "' + args.query + '".';
                            return results.map(function (r) {
                                return '[' + _fmtTime(r.timeSeconds) + '] ' + (r.text || '');
                            }).join('\n\n');
                        });

                default:
                    return Promise.resolve('[Tool "' + name + '" no reconocida]');
            }
        }

        return {
            definitions   : DEFINITIONS,
            parseToolCalls: parseToolCalls,
            execute       : execute,
        };

    })();

    // =========================================================================
    // MÓDULO 16: FRAME EXTRACTOR
    // =========================================================================
    // MEJORA 29: Extracción vía canvas + video.seeked event
    //
    // FIX v3.1.0:
    //  - extractFrame: restaura también el estado play/pause del video

    VP.rag.frameExtractor = (function () {

        var DEFAULT_QUALITY  = 0.80;
        var DEFAULT_MAX_W    = 1280;
        var DEFAULT_MAX_H    = 720;

        /**
         * Extrae un frame del video en un tiempo dado.
         * FIX v3.1.0: restaura currentTime Y estado paused/playing tras el seek.
         *
         * @param  {HTMLVideoElement} videoEl
         * @param  {number}          timeSeconds
         * @returns {Promise<string>} base64 JPEG
         */
        function extractFrame(videoEl, timeSeconds) {
            if (!videoEl || typeof videoEl.duration !== 'number') {
                return Promise.reject(new Error('Video element no válido'));
            }

            var prevTime   = videoEl.currentTime;
            var prevPaused = videoEl.paused;

            return new Promise(function (resolve, reject) {
                var timeout = setTimeout(function () {
                    videoEl.removeEventListener('seeked', onSeeked);
                    reject(new Error('Timeout al extraer frame en ' + _fmtTime(timeSeconds)));
                }, 8000);

                function onSeeked() {
                    clearTimeout(timeout);
                    videoEl.removeEventListener('seeked', onSeeked);

                    try {
                        var canvas = document.createElement('canvas');
                        var w = Math.min(videoEl.videoWidth  || DEFAULT_MAX_W, DEFAULT_MAX_W);
                        var h = Math.min(videoEl.videoHeight || DEFAULT_MAX_H, DEFAULT_MAX_H);
                        canvas.width  = w;
                        canvas.height = h;

                        var ctx = canvas.getContext('2d');
                        ctx.drawImage(videoEl, 0, 0, w, h);

                        var dataURL = canvas.toDataURL('image/jpeg', DEFAULT_QUALITY);

                        // FIX v3.1.0: restaurar posición y estado de reproducción
                        videoEl.currentTime = prevTime;
                        if (!prevPaused && videoEl.paused) {
                            try { videoEl.play(); } catch (_) {}
                        }

                        resolve(dataURL);
                    } catch (err) {
                        reject(err);
                    }
                }

                videoEl.addEventListener('seeked', onSeeked);
                videoEl.currentTime = Math.max(0, Math.min(timeSeconds, videoEl.duration - 0.1));
            });
        }

        /**
         * Extrae múltiples frames a intervalos regulares.
         * @param {HTMLVideoElement} videoEl
         * @param {number}           intervalSecs
         * @param {number}           fromSecs
         * @param {number}           toSecs
         * @param {Function}         onFrame - callback(dataURL, time)
         */
        function extractFrames(videoEl, intervalSecs, fromSecs, toSecs, onFrame) {
            if (!videoEl) return Promise.reject(new Error('No video element'));

            var duration = videoEl.duration || 0;
            var from     = fromSecs  || 0;
            var to       = toSecs    || duration;
            var step     = Math.max(intervalSecs || 30, 1);
            var times    = [];

            for (var t = from; t <= to; t += step) {
                times.push(Math.min(t, duration - 0.1));
            }

            function processNext(idx) {
                if (idx >= times.length) return Promise.resolve();

                return extractFrame(videoEl, times[idx]).then(function (dataURL) {
                    if (onFrame) onFrame(dataURL, times[idx]);
                    // Yield cooperativo entre frames
                    return new Promise(function (res) {
                        setTimeout(function () { res(processNext(idx + 1)); }, 100);
                    });
                }).catch(function (err) {
                    if (log.warn) log.warn('Error extrayendo frame en', _fmtTime(times[idx]), ':', err.message || err);
                    return processNext(idx + 1);
                });
            }

            return processNext(0);
        }

        /** Extrae base64 puro (sin prefijo data:...) para enviar a Ollama vision */
        function toBase64Pure(dataURL) {
            var idx = dataURL.indexOf(',');
            return idx >= 0 ? dataURL.substring(idx + 1) : dataURL;
        }

        return {
            extractFrame  : extractFrame,
            extractFrames : extractFrames,
            toBase64Pure  : toBase64Pure,
        };

    })();

    // =========================================================================
    // MÓDULO 17: OCR
    // =========================================================================
    // MEJORA 28: Lazy loading de Tesseract.js
    // MEJORA 30: Fusión de OCR en el retrieval
    //
    // FIX v3.1.0:
    //  - processFrame: no guarda en IDB si text está vacío (evitaba guardar nulos)

    VP.rag.ocr = (function () {

        var TESSERACT_CDN     = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js';
        var _tesseractLoaded  = false;
        var _tesseractPromise = null;

        /**
         * Carga Tesseract.js de forma lazy.
         */
        function loadTesseract() {
            if (_tesseractLoaded && window.Tesseract) return Promise.resolve(window.Tesseract);
            if (_tesseractPromise) return _tesseractPromise;

            _tesseractPromise = new Promise(function (resolve, reject) {
                var script   = document.createElement('script');
                script.src   = TESSERACT_CDN;
                script.async = true;
                script.onload = function () {
                    _tesseractLoaded  = true;
                    _tesseractPromise = null;
                    resolve(window.Tesseract);
                };
                script.onerror = function (err) {
                    _tesseractPromise = null;
                    reject(err);
                };
                document.head.appendChild(script);
            });

            return _tesseractPromise;
        }

        /**
         * Extrae texto de una imagen (base64 o URL).
         * @param  {string} imageSource - dataURL o URL
         * @param  {string} langs       - idiomas Tesseract ('spa+eng')
         * @returns {Promise<string>}
         */
        function extractText(imageSource, langs) {
            langs = langs || 'spa+eng';

            return loadTesseract().then(function (Tesseract) {
                return Tesseract.recognize(imageSource, langs, { logger: function () {} });
            }).then(function (result) {
                var text  = (result.data.text || '').trim();
                var words = text.split(/\s+/).filter(function (w) { return w.length > 2; });
                return words.length >= 3 ? text : '';
            });
        }

        /**
         * Pipeline completo: extrae frame → OCR → guarda en IndexedDB.
         * FIX v3.1.0: solo guarda si text no está vacío.
         *
         * @param {HTMLVideoElement} videoEl
         * @param {number}           timeSeconds
         * @param {string}           videoId
         * @returns {Promise<Object>} { timeSeconds, text }
         */
        function processFrame(videoEl, timeSeconds, videoId) {
            return VP.rag.frameExtractor.extractFrame(videoEl, timeSeconds)
                .then(function (dataURL) { return extractText(dataURL); })
                .then(function (text) {
                    var entry = { timeSeconds: timeSeconds, text: text, videoId: videoId };
                    // FIX v3.1.0: solo guarda si hay texto útil
                    if (text && text.trim().length > 0) {
                        VP.rag.vectorStore.saveOCR(videoId, entry).catch(function () {});
                    }
                    return entry;
                });
        }

        /**
         * Busca texto OCR para una query (simple keyword match sobre los stored).
         */
        function searchOCR(videoId, query) {
            return VP.rag.vectorStore.getOCR(videoId).then(function (entries) {
                if (!query) return entries || [];
                var q = query.toLowerCase();
                return (entries || []).filter(function (e) {
                    return e.text && e.text.toLowerCase().indexOf(q) >= 0;
                }).sort(function (a, b) { return (a.timeSeconds || 0) - (b.timeSeconds || 0); });
            });
        }

        return {
            loadTesseract : loadTesseract,
            extractText   : extractText,
            processFrame  : processFrame,
            searchOCR     : searchOCR,
        };

    })();

    // =========================================================================
    // MÓDULO 18: STREAM RENDERER OPTIMIZADO
    // =========================================================================
    // MEJORA 31: Token buffering con RAF + interval
    // MEJORA 32: Incremental markdown (no renderiza bloques incompletos)
    // MEJORA 33: DOM patching solo cuando hay cambio real
    //
    // FIX v3.1.0:
    //  - constructor: guard contra containerEl nulo
    //  - scheduleFlush: no inicia el timer si _done ya es true
    //  - _flush: guard adicional contra el nodo eliminado del DOM

    VP.rag.StreamRenderer = (function () {

        /**
         * @param {Element}  containerEl     - elemento del DOM donde renderizar
         * @param {Function} renderMarkdownFn - función de renderizado de markdown
         */
        function StreamRenderer(containerEl, renderMarkdownFn) {
            // FIX v3.1.0: guard contra null
            this.el      = containerEl || null;
            this._render = renderMarkdownFn || function (t) { return t; };

            this._buffer   = '';
            this._pending  = '';
            this._rafId    = null;
            this._timer    = null;
            this._lastHTML = '';
            this._done     = false;

            // Safety-net flush periódico
            var self = this;
            (function scheduleFlush() {
                if (self._done) return; // FIX v3.1.0
                self._timer = setTimeout(function () {
                    if (!self._done) {
                        self._flush();
                        scheduleFlush();
                    }
                }, 300);
            })();
        }

        /** Recibe un nuevo token de streaming */
        StreamRenderer.prototype.push = function (token) {
            if (this._done) return;
            this._pending += token;

            if (!this._rafId) {
                var self = this;
                this._rafId = requestAnimationFrame(function () {
                    self._rafId = null;
                    self._flush();
                });
            }
        };

        /** Aplica el buffer pendiente al DOM */
        StreamRenderer.prototype._flush = function () {
            if (!this._pending || !this.el) return;

            this._buffer  += this._pending;
            this._pending  = '';

            // FIX v3.1.0: guard si el nodo fue eliminado del DOM
            if (!document.contains(this.el)) return;

            var html = this._renderIncremental(this._buffer);

            if (html !== this._lastHTML) {
                this.el.innerHTML = VP.rag.security.sanitizeMarkdownHTML(html);
                this._lastHTML    = html;
                this._scrollParent();
            }
        };

        /** Finaliza el streaming: flush final + post-procesado */
        StreamRenderer.prototype.finalize = function (onTimestampInject) {
            this._done = true;
            this._flush();

            clearTimeout(this._timer);
            if (this._rafId) {
                cancelAnimationFrame(this._rafId);
                this._rafId = null;
            }

            if (!this.el) return;

            // Render final completo (sin limitaciones de bloques incompletos)
            var finalHTML = VP.rag.security.sanitizeMarkdownHTML(
                this._render(this._buffer)
            );
            this.el.innerHTML = finalHTML;
            this._lastHTML    = finalHTML;

            if (typeof onTimestampInject === 'function') {
                onTimestampInject(this.el);
            }

            this._scrollParent();
        };

        /** Cancela el renderer sin finalizar el DOM */
        StreamRenderer.prototype.cancel = function () {
            clearTimeout(this._timer);
            if (this._rafId) {
                cancelAnimationFrame(this._rafId);
                this._rafId = null;
            }
            this._done = true;
        };

        /** Devuelve el texto acumulado */
        StreamRenderer.prototype.getText = function () {
            return this._buffer;
        };

        /**
         * Renderizado incremental: no renderiza bloques de código sin cerrar.
         */
        StreamRenderer.prototype._renderIncremental = function (text) {
            var fenceCount = 0;
            var pos        = 0;
            var next;
            while ((next = text.indexOf('```', pos)) >= 0) {
                fenceCount++;
                pos = next + 3;
            }

            if (fenceCount % 2 !== 0) {
                var cutAt = text.lastIndexOf('```');
                var safe  = cutAt > 0 ? text.substring(0, cutAt) : text;
                return this._render(safe) + '<span class="streaming-cursor">▊</span>';
            }

            return this._render(text) + '<span class="streaming-cursor">▊</span>';
        };

        StreamRenderer.prototype._scrollParent = function () {
            if (!this.el) return;
            var parent = this.el.closest
                ? this.el.closest('.chat-ia-messages')
                : null;
            if (parent) {
                requestAnimationFrame(function () {
                    parent.scrollTop = parent.scrollHeight;
                });
            }
        };

        return StreamRenderer;

    })();

    // =========================================================================
    // HELPER compartido (local)
    // =========================================================================
    function _fmtTime(s) {
        s = Math.max(0, Number(s) || 0);
        var h   = Math.floor(s / 3600);
        var m   = Math.floor((s % 3600) / 60);
        var sec = Math.floor(s % 60);
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
    }

    if (log.info) log.info('vp-rag-pipeline.js v3.1.1 cargado. Módulos: intentDetector, queryRewriter, MemoryManager, SemanticCache, security, promptBuilder, tools, frameExtractor, ocr, StreamRenderer.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-rag-pipeline.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
