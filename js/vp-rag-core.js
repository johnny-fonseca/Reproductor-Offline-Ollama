'use strict';
// =============================================================================
// VP-RAG-CORE.JS  —  v3.1.0
// Módulos core del sistema RAG avanzado para VP-Chat-IA.
//
// MEJORA 01: Chunking temporal con overlap inteligente
// MEJORA 02: Detección de silencios como límites semánticos
// MEJORA 03: Preservación de metadatos (speaker, capítulo) en chunks
// MEJORA 04: Embedding con prefijos correctos para nomic-embed-text-v2
// MEJORA 05: Batching adaptativo según VRAM disponible
// MEJORA 06: Persistencia de embeddings en IndexedDB (evita re-embedding)
// MEJORA 07: Verificación de integridad de embeddings (dimensión, NaN)
// MEJORA 08: BM25 Okapi con IDF suavizado
// MEJORA 09: Extracción de keywords con stopwords en español e inglés
// MEJORA 10: Normalización de scores independiente por algoritmo
// MEJORA 11: Temporal scoring gaussiano + anti-spoiler exponencial
// MEJORA 12: Hybrid scoring con pesos adaptativos por modo/intención
// MEJORA 13: RRF (Reciprocal Rank Fusion) sin dependencia de scores crudos
// MEJORA 14: MMR con penalización de redundancia entre chunks seleccionados
// MEJORA 15: Context builder con deduplicación por overlap temporal
// MEJORA 16: Compresión de contexto respetando budget de tokens
// MEJORA 17: Limpieza automática de IndexedDB (eviction LRU por video)
// MEJORA 18: Web Worker opcional para indexación sin bloquear UI
//
// FIX v3.1.0:
//  - saveChunks: guard contra array vacío (TypeError chunks[0] eliminado)
//  - vectorStore.open(): handler onversionchange para multi-tab seguro
//  - semanticSearch: early exit cuando no hay chunks válidos; mejor perf
//  - embedBatch: cooperative yielding con requestIdleCallback + fallback
//  - _validEmb: muestreo completo de NaN, no solo primeros 10 elementos
//  - _evictOldVideos: ejecución en idle time, errores silenciados
//  - deleteVideo: cursor en lugar de getAll para eficiencia en datasets grandes
//  - _clone: renombrado interno en vectorStore para evitar shadowing
//  - clearAll(): nuevo método público en vectorStore
//  - getChunkCount(): diagnóstico sin cargar embeddings completos
//  - BM25Index: `Object.values` reemplazado por loop compatible con ES5 strict
//  - hybridSearch: `Object.values` reemplazado por loop compatible
//  - reranker.mmr: shortcircuit cuando candidates.length === 0
//
// Dependencias: vp-base.js · vp-utilidades.js
// =============================================================================

(function (window, document) {
    'use strict';

    if (window.__VP_RAG_CORE_LOADED__) return;
    window.__VP_RAG_CORE_LOADED__ = true;

    var VP = window.VP;
    if (!VP) throw new Error('[VP] vp-rag-core.js: vp-base.js debe cargarse primero.');

    // =========================================================================
    // NAMESPACE
    // =========================================================================
    VP.rag = VP.rag || {};

    var log = VP.log || console;
    if (log.setContext) log.setContext('RAGCore');

    // =========================================================================
    // CONSTANTES GLOBALES RAG
    // =========================================================================
    var RAG_CFG = Object.freeze({
        // Chunking
        CHUNK_TARGET_TOKENS    : 700,    // tokens objetivo por chunk (~2800 chars)
        CHUNK_OVERLAP_SECS     : 15,     // segundos de overlap entre chunks
        SILENCE_THRESHOLD_S    : 2.2,    // gap entre cues → posible límite semántico
        MAX_CHUNK_TOKENS       : 1000,   // corte duro
        MIN_CHUNK_TOKENS       : 80,     // chunk mínimo viable
        CHARS_PER_TOKEN        : 4.1,    // estimación para español/inglés mixto

        // Embeddings
        EMBED_MODEL            : 'nomic-embed-text-v2-moe:q8_0',
        EMBED_DIM              : 768,    // nomic-embed-text-v2-moe:q8_0
        EMBED_BATCH_SIZE       : 2,      // Ajustado a 2 para 8GB VRAM (Qwen + Nomic simultáneos)
        EMBED_PREFIX_DOC       : 'search_document: ',
        EMBED_PREFIX_QUERY     : 'search_query: ',
        EMBED_MAX_CHARS        : 8192,   // límite de contexto de nomic (actualizado a 8192)
        EMBED_TIMEOUT_MS       : 20000,

        // IndexedDB
        DB_NAME                : 'vpRAGStore',
        DB_VERSION             : 2,
        STORE_CHUNKS           : 'chunks',
        STORE_VIDEOS           : 'videos',
        STORE_OCR              : 'ocr',
        MAX_CACHED_VIDEOS      : 15,     // LRU eviction

        // BM25
        BM25_K1                : 1.5,
        BM25_B                 : 0.75,
        BM25_DELTA             : 0.5,    // BM25+ variant (evita scores negativos)

        // Hybrid Search
        HYBRID_TOP_K_RETRIEVAL : 50,     // candidatos antes del reranking
        HYBRID_FINAL_K         : 18,     // chunks para el context builder
        WEIGHTS_NORMAL         : { sem: 0.55, bm25: 0.20, temp: 0.15, ctx: 0.10 },
        WEIGHTS_ANTISPOILER    : { sem: 0.48, bm25: 0.18, temp: 0.28, ctx: 0.06 },
        WEIGHTS_BUSQUEDA       : { sem: 0.32, bm25: 0.38, temp: 0.20, ctx: 0.10 },
        WEIGHTS_EXPLICACION    : { sem: 0.60, bm25: 0.22, temp: 0.10, ctx: 0.08 },
        WEIGHTS_RESUMEN        : { sem: 0.42, bm25: 0.18, temp: 0.25, ctx: 0.15 },

        // Temporal
        TEMPORAL_SIGMA_RATIO   : 0.08,   // sigma = duración * ratio
        TEMPORAL_SIGMA_MIN_S   : 180,    // sigma mínimo (3 min)
        TEMPORAL_DECAY_TAU_S   : 150,    // constante de decaimiento anti-spoiler
        TEMPORAL_RECENT_WINDOW : 30,     // bonus para contenido en últimos 30s

        // Context Builder
        CTX_MAX_TOKENS         : 2500,   // Reducido para encajar en el límite num_ctx de 4096
        CTX_OVERLAP_THRESHOLD  : 0.55,   // fracción de overlap para deduplicar
        CTX_SEPARATOR          : '\n---\n',

        // RRF
        RRF_K                  : 60,

        // MMR
        MMR_LAMBDA             : 0.72,   // relevancia vs diversidad
    });

    // =========================================================================
    // UTILIDADES INTERNAS
    // =========================================================================

    /** Formatea segundos como M:SS o H:MM:SS */
    function _fmtTime(s) {
        s = Math.max(0, Number(s) || 0);
        var h   = Math.floor(s / 3600);
        var m   = Math.floor((s % 3600) / 60);
        var sec = Math.floor(s % 60);
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
    }

    /** Estima tokens de una cadena */
    function _estTokens(text) {
        return Math.ceil((text || '').length / RAG_CFG.CHARS_PER_TOKEN);
    }

    /** Cosine similarity entre dos vectores validados */
    function _cosine(a, b) {
        if (!_validEmb(a) || !_validEmb(b) || a.length !== b.length) return 0;
        var dot = 0, na = 0, nb = 0;
        for (var i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na  += a[i] * a[i];
            nb  += b[i] * b[i];
        }
        var denom = Math.sqrt(na) * Math.sqrt(nb);
        if (!isFinite(denom) || denom < 1e-10 || !isFinite(dot)) return 0;
        var score = dot / denom;
        return isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
    }

    /** Normaliza un array de scores a [0, 1] */
    function _normalizeScores(items, field) {
        if (!items || !items.length) return [];
        var min = Infinity, max = -Infinity;
        for (var i = 0; i < items.length; i++) {
            var v = items[i][field] || 0;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        var range = max - min;
        return items.map(function (item) {
            var norm = {};
            var keys = Object.keys(item);
            for (var k = 0; k < keys.length; k++) norm[keys[k]] = item[keys[k]];
            norm['_norm_' + field] = range < 1e-10 ? 0 : (item[field] - min) / range;
            return norm;
        });
    }

    /**
     * Verifica que un embedding sea válido.
     * FIX v3.1.0: muestreo completo, no solo primeros 10 elementos.
     * Cada 32 posiciones para cubrir toda la dimensión sin ser O(n).
     */
    function _validEmb(emb) {
        if (!emb) return false;
        var isTypedArray = typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(emb);
        if (!Array.isArray(emb) && !isTypedArray) return false;
        if (emb.length !== RAG_CFG.EMBED_DIM) return false;
        for (var i = 0; i < emb.length; i++) {
            if (typeof emb[i] !== 'number' || !isFinite(emb[i])) return false;
        }
        return true;
    }

    /** Genera ID único para chunk */
    function _chunkId(videoId, idx) {
        return videoId + '::chunk::' + idx;
    }

    /** Clona objeto superficialmente con propiedades extra opcionales */
    function _shallowClone(obj, extra) {
        var result = {};
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) result[keys[i]] = obj[keys[i]];
        if (extra) {
            var ekeys = Object.keys(extra);
            for (var j = 0; j < ekeys.length; j++) result[ekeys[j]] = extra[ekeys[j]];
        }
        return result;
    }

    /**
     * Cooperative yield: usa requestIdleCallback si disponible, si no setTimeout(0).
     * FIX v3.1.0: reemplaza setTimeout(30) fijo en embedBatch.
     */
    function _yieldAsync(fn) {
        if (typeof requestIdleCallback === 'function') {
            return new Promise(function (resolve) {
                requestIdleCallback(function () { resolve(fn()); }, { timeout: 200 });
            });
        }
        return new Promise(function (resolve) {
            setTimeout(function () { resolve(fn()); }, 0);
        });
    }

    // =========================================================================
    // MÓDULO 1: CHUNKER TEMPORAL + SEMÁNTICO
    // =========================================================================
    // MEJORA 01: Chunking basado en tiempo real, no caracteres
    // MEJORA 02: Detección de silencios (gap > SILENCE_THRESHOLD_S)
    // MEJORA 03: Metadatos completos por chunk

    VP.rag.chunker = (function () {

        /** Stopwords básicas para no inflar keywords */
        var STOPWORDS = new Set([
            'de','la','el','en','y','a','los','del','se','las','un','por','con',
            'una','su','al','lo','como','mas','pero','sus','le','ya','o','fue',
            'este','había','era','si','sino','te','que','para','todo','ha','esta',
            'cuando','muy','sin','sobre','también','me','hasta','hay','donde',
            'quien','cual','han','sido','está','tiene','tienen','ser','hacer',
            'the','and','for','are','but','not','you','all','can','had','her',
            'was','one','our','out','day','get','has','him','his','how','its',
            'let','may','nor','off','old','own','put','say','she','too','use',
            'way','who','boy','did','its','let','now','man','new','see','two',
            'with','that','this','from','they','been','have','will','than','then',
            'some','what','into','more','also','when','your','there','their','about',
        ]);

        /**
         * Chunking temporal: agrupa cues en chunks respetando:
         *  - target de tokens por chunk
         *  - silencios semánticos (gap > SILENCE_THRESHOLD_S)
         *  - overlap de tiempo entre chunks consecutivos
         *
         * @param  {Array}  cues    - [{inicio, fin, texto}]
         * @param  {string} videoId
         * @returns {Array} chunks
         */
        function chunk(cues, videoId) {
            if (!Array.isArray(cues) || !cues.length) return [];

            var chunks    = [];
            var buffer    = [];
            var bufChars  = 0;
            var chunkIdx  = 0;

            for (var i = 0; i < cues.length; i++) {
                var cue  = cues[i];
                var next = cues[i + 1];

                if (!cue || typeof cue.texto !== 'string') continue;

                buffer.push(cue);
                bufChars += cue.texto.length;

                var budgetFull   = bufChars >= RAG_CFG.CHUNK_TARGET_TOKENS * RAG_CFG.CHARS_PER_TOKEN;
                var hardLimit    = bufChars >= RAG_CFG.MAX_CHUNK_TOKENS    * RAG_CFG.CHARS_PER_TOKEN;
                var silenceAfter = next && (next.inicio - (cue.fin || cue.inicio)) > RAG_CFG.SILENCE_THRESHOLD_S;
                var isLast       = !next;

                if (hardLimit || (budgetFull && silenceAfter) || isLast) {
                    if (bufChars >= RAG_CFG.MIN_CHUNK_TOKENS * RAG_CFG.CHARS_PER_TOKEN || isLast) {
                        chunks.push(_buildChunk(buffer, chunkIdx++, videoId));
                    }

                    // Overlap: mantener cues en los últimos CHUNK_OVERLAP_SECS
                    var lastCue     = buffer[buffer.length - 1];
                    var overlapFrom = (lastCue.fin || lastCue.inicio) - RAG_CFG.CHUNK_OVERLAP_SECS;
                    var newBuffer   = [];
                    var newChars    = 0;
                    for (var ob = 0; ob < buffer.length; ob++) {
                        if (buffer[ob].inicio >= overlapFrom) {
                            newBuffer.push(buffer[ob]);
                            newChars += buffer[ob].texto.length;
                        }
                    }
                    buffer   = newBuffer;
                    bufChars = newChars;
                }
            }

            return chunks;
        }

        /** Construye un objeto chunk desde un buffer de cues */
        function _buildChunk(cues, idx, videoId) {
            var text     = cues.map(function (c) { return c.texto.trim(); }).join(' ');
            var keywords = _extractKeywords(text);
            var startCue = cues[0];
            var endCue   = cues[cues.length - 1];

            return {
                id        : _chunkId(videoId, idx),
                videoId   : videoId,
                index     : idx,
                start     : startCue.inicio,
                end       : endCue.fin || endCue.inicio,
                midpoint  : (startCue.inicio + (endCue.fin || endCue.inicio)) / 2,
                text      : text,
                cues      : cues.map(function (c) { return { inicio: c.inicio, fin: c.fin, texto: c.texto }; }),
                cueCount  : cues.length,
                charCount : text.length,
                tokens    : _estTokens(text),
                keywords  : keywords,
                embedding : null,    // se llena después
                ts        : Date.now(),
            };
        }

        /**
         * Extrae frecuencia de keywords (para BM25).
         * Filtra stopwords, normaliza, cuenta frecuencias.
         */
        function _extractKeywords(text) {
            if (!text) return {};
            var words = text.toLowerCase()
                .replace(/[^\wáéíóúñü\s]/gi, ' ')
                .split(/\s+/);

            var freq = {};
            for (var i = 0; i < words.length; i++) {
                var w = words[i];
                if (w.length >= 3 && !STOPWORDS.has(w)) {
                    var stemmed = _stemBasic(w);
                    freq[stemmed] = (freq[stemmed] || 0) + 1;
                }
            }
            return freq;
        }

        /**
         * Stemming básico para español (sufijos comunes).
         * No reemplaza un stemmer real pero mejora el recall del BM25.
         */
        function _stemBasic(word) {
            if (word.length < 5) return word;
            var result = word
                .replace(/ando$|iendo$/, 'ar')
                .replace(/ación$|aciones$/, 'ar')
                .replace(/mente$/, '')
                .replace(/idades?$/, 'idad')
                .replace(/adores?$|adoras?$/, 'ador')
                .replace(/ísimo$|ísima$/, '')
                .replace(/[aeiou]s$/, function (m) { return m.slice(0, -1); });
            return result || word;
        }

        return {
            chunk           : chunk,
            extractKeywords : _extractKeywords,
        };

    })();

    // =========================================================================
    // MÓDULO 2: EMBEDDER  (nomic-embed-text vía Ollama)
    // =========================================================================
    // MEJORA 04: Prefijos correctos search_document / search_query
    // MEJORA 05: Batching adaptativo con cooperative yielding
    // MEJORA 07: Verificación de dimensión e integridad

    VP.rag.embedder = (function () {

        var _baseUrl = 'http://localhost:11434';

        function setBaseUrl(url) { _baseUrl = url; }

        /**
         * Embebe un único texto como documento.
         */
        function embedDocument(text) {
            if (typeof text !== 'string' || !text.trim()) {
                return Promise.reject(new Error('embedDocument requiere texto no vacío'));
            }
            var input = RAG_CFG.EMBED_PREFIX_DOC + text.slice(0, RAG_CFG.EMBED_MAX_CHARS);
            return _callEmbedAPI(input);
        }

        /**
         * Embebe un texto como query (prefijo diferente).
         */
        function embedQuery(text) {
            if (typeof text !== 'string' || !text.trim()) {
                return Promise.reject(new Error('embedQuery requiere texto no vacío'));
            }
            var input = RAG_CFG.EMBED_PREFIX_QUERY + text.slice(0, RAG_CFG.EMBED_MAX_CHARS);
            return _callEmbedAPI(input);
        }

        /**
         * Embebe un array de textos en batches con cooperative yielding.
         * FIX v3.1.0: usa _yieldAsync (requestIdleCallback) en lugar de setTimeout(30) fijo.
         *
         * @param {string[]} texts
         * @param {Function} onProgress - callback(done, total)
         */
        function embedBatch(texts, onProgress) {
            if (!Array.isArray(texts)) return Promise.reject(new Error('embedBatch requiere un array de textos'));
            if (!texts.length) return Promise.resolve([]);
            if (typeof onProgress !== 'undefined' && typeof onProgress !== 'function') {
                return Promise.reject(new Error('onProgress debe ser una función'));
            }

            var results   = new Array(texts.length);
            var batchSize = Math.max(1, Math.floor(Number(RAG_CFG.EMBED_BATCH_SIZE) || 1));

            function processBatch(startIdx) {
                if (startIdx >= texts.length) return Promise.resolve(results);

                var slice    = texts.slice(startIdx, startIdx + batchSize);
                var promises = slice.map(function (t, localIdx) {
                    return embedDocument(t).catch(function (err) {
                        if (log.warn) log.warn('embedBatch error en idx ' + (startIdx + localIdx) + ':', err.message || err);
                        return null; // placeholder: no rompe el batch
                    });
                });

                return Promise.all(promises).then(function (embeddings) {
                    for (var j = 0; j < embeddings.length; j++) {
                        // null indica que ese embedding falló — se deja null
                        // _validEmb lo filtrará en semanticSearch
                        results[startIdx + j] = embeddings[j] || null;
                    }
                    if (onProgress) {
                        try { onProgress(Math.min(startIdx + batchSize, texts.length), texts.length); }
                        catch (progressError) {
                            if (log.warn) log.warn('embedBatch: callback de progreso falló:', progressError.message || progressError);
                        }
                    }
                    // Cooperative yield entre batches para no bloquear el main thread
                    return _yieldAsync(function () {
                        return processBatch(startIdx + batchSize);
                    });
                });
            }

            return processBatch(0);
        }

        /** Llama a la API de embeddings de Ollama */
        function _callEmbedAPI(prompt) {
            if (!VP.ollama || typeof VP.ollama.embed !== 'function') {
                return Promise.reject(new Error('El cliente de embeddings local no está disponible'));
            }
            return Promise.resolve().then(function () {
                return VP.ollama.embed(_baseUrl, RAG_CFG.EMBED_MODEL, prompt, {
                timeout: RAG_CFG.EMBED_TIMEOUT_MS
                });
            }).then(function (embeddings) {
                var emb = embeddings && embeddings[0];
                if (!_validEmb(emb)) throw new Error('Embedding inválido recibido del modelo');
                return emb;
            });
        }

        return {
            setBaseUrl    : setBaseUrl,
            embedDocument : embedDocument,
            embedQuery    : embedQuery,
            embedBatch    : embedBatch,
        };

    })();

    // =========================================================================
    // MÓDULO 3: VECTOR STORE (IndexedDB)
    // =========================================================================
    // MEJORA 06: Persistencia de embeddings (no re-embebe en cada sesión)
    // MEJORA 17: LRU eviction de videos antiguos
    // MEJORA 07: Verificación de integridad en lectura
    //
    // FIX v3.1.0:
    //  - onversionchange: cierra conexión cuando otra tab actualiza la BD
    //  - saveChunks: guard contra array vacío (no accede a chunks[0] sin comprobar)
    //  - deleteVideo: usa cursor para evitar cargar todos los chunks en RAM
    //  - clearAll: nuevo método para borrar toda la BD
    //  - getChunkCount: cuenta chunks sin cargar embeddings

    VP.rag.vectorStore = (function () {

        var _db = null;
        var _dbOpenPromise = null;

        /** Abre (o crea) la base de datos IndexedDB */
        function open() {
            if (_db) return Promise.resolve(_db);
            if (_dbOpenPromise) return _dbOpenPromise;

            _dbOpenPromise = new Promise(function (resolve, reject) {
                var req;
                try {
                    req = indexedDB.open(RAG_CFG.DB_NAME, RAG_CFG.DB_VERSION);
                } catch (err) {
                    _dbOpenPromise = null;
                    if (log.warn) log.warn('[RAGCore] Error o bloqueo al abrir IndexedDB:', err.message || err);
                    return reject(err);
                }

                req.onupgradeneeded = function (e) {
                    var db = e.target.result;

                    if (!db.objectStoreNames.contains(RAG_CFG.STORE_CHUNKS)) {
                        var cs = db.createObjectStore(RAG_CFG.STORE_CHUNKS, { keyPath: 'id' });
                        cs.createIndex('videoId',  'videoId',  { unique: false });
                        cs.createIndex('midpoint', 'midpoint', { unique: false });
                    }

                    if (!db.objectStoreNames.contains(RAG_CFG.STORE_VIDEOS)) {
                        db.createObjectStore(RAG_CFG.STORE_VIDEOS, { keyPath: 'id' });
                    }

                    if (!db.objectStoreNames.contains(RAG_CFG.STORE_OCR)) {
                        var os = db.createObjectStore(RAG_CFG.STORE_OCR, { keyPath: 'id' });
                        os.createIndex('videoId', 'videoId', { unique: false });
                    }
                };

                req.onsuccess = function (e) {
                    _db = e.target.result;

                    // FIX v3.1.0: multi-tab safety
                    // Si otra pestaña abre una versión mayor, cerramos esta conexión
                    // para no bloquear la migración.
                    _db.onversionchange = function () {
                        if (_db) {
                            _db.close();
                            _db = null;
                            _dbOpenPromise = null;
                        }
                        if (log.warn) log.warn('[RAGCore] IndexedDB versionchange: conexión cerrada para migración.');
                    };

                    // Detectar cierre inesperado
                    _db.onclose = function () {
                        _db = null;
                        _dbOpenPromise = null;
                    };

                    resolve(_db);
                };

                req.onerror = function (e) {
                    _dbOpenPromise = null;
                    reject(e.target ? e.target.error : e);
                };

                req.onblocked = function () {
                    _dbOpenPromise = null;
                    reject(new Error('IndexedDB bloqueada: cierra otras pestañas de esta app.'));
                };
            });

            return _dbOpenPromise;
        }

        /**
         * Guarda un array de chunks (con embeddings) en IndexedDB.
         * FIX v3.1.0: guard contra chunks vacío.
         */
        function saveChunks(chunks) {
            if (!chunks || !chunks.length) return Promise.resolve(0);

            // Guard: el primer chunk debe tener videoId válido
            var videoId = chunks[0] && chunks[0].videoId;
            if (!videoId) {
                if (log.warn) log.warn('[RAGCore] saveChunks: chunks sin videoId, operación cancelada.');
                return Promise.resolve(0);
            }

            return open().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx         = db.transaction([RAG_CFG.STORE_CHUNKS, RAG_CFG.STORE_VIDEOS], 'readwrite');
                    var chunkStore = tx.objectStore(RAG_CFG.STORE_CHUNKS);
                    var videoStore = tx.objectStore(RAG_CFG.STORE_VIDEOS);

                    for (var i = 0; i < chunks.length; i++) {
                        chunkStore.put(chunks[i]);
                    }

                    // Registrar video con marca de tiempo para LRU
                    videoStore.put({
                        id         : videoId,
                        chunkCount : chunks.length,
                        ts         : Date.now(),
                    });

                    tx.oncomplete = function () { resolve(chunks.length); };
                    tx.onerror    = function (e) { reject(e.target.error); };
                    tx.onabort    = function (e) { reject(e.target.error || new Error('Transacción abortada')); };
                });
            }).then(function (count) {
                _evictOldVideos();
                return count;
            });
        }

        /** Obtiene todos los chunks de un video */
        function getChunksByVideo(videoId) {
            return open().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx  = db.transaction(RAG_CFG.STORE_CHUNKS, 'readonly');
                    var idx = tx.objectStore(RAG_CFG.STORE_CHUNKS).index('videoId');
                    var req = idx.getAll(videoId);
                    req.onsuccess = function (e) { resolve(e.target.result || []); };
                    req.onerror   = function (e) { reject(e.target.error); };
                });
            });
        }

        /** Verifica si un video ya está indexado */
        function isIndexed(videoId) {
            return open().then(function (db) {
                return new Promise(function (resolve) {
                    var tx  = db.transaction(RAG_CFG.STORE_VIDEOS, 'readonly');
                    var req = tx.objectStore(RAG_CFG.STORE_VIDEOS).get(videoId);
                    req.onsuccess = function (e) { resolve(!!e.target.result); };
                    req.onerror   = function ()  { resolve(false); };
                });
            }).catch(function () { return false; });
        }

        /**
         * Borra todos los chunks de un video.
         * FIX v3.1.0: usa cursor en lugar de getAll para evitar cargar
         * embeddings completos en RAM durante el borrado.
         */
        function deleteVideo(videoId) {
            return open().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx     = db.transaction([RAG_CFG.STORE_CHUNKS, RAG_CFG.STORE_VIDEOS], 'readwrite');
                    var cs     = tx.objectStore(RAG_CFG.STORE_CHUNKS);
                    var idxReq = cs.index('videoId').openKeyCursor(IDBKeyRange.only(videoId));

                    idxReq.onsuccess = function (e) {
                        var cursor = e.target.result;
                        if (cursor) {
                            cs.delete(cursor.primaryKey);
                            cursor.continue();
                        }
                    };
                    idxReq.onerror = function (e) { reject(e.target.error); };

                    tx.objectStore(RAG_CFG.STORE_VIDEOS).delete(videoId);
                    tx.oncomplete = function () { resolve(); };
                    tx.onerror    = function (e) { reject(e.target.error); };
                });
            });
        }

        /**
         * Búsqueda semántica: cosine similarity contra todos los chunks del video.
         * Sólo carga chunks que tengan embedding válido.
         * FIX v3.1.0: early exit cuando no hay candidatos válidos.
         */
        function semanticSearch(videoId, queryEmbedding, topK) {
            if (!_validEmb(queryEmbedding)) return Promise.resolve([]);
            topK = Math.floor(Number(topK) || RAG_CFG.HYBRID_TOP_K_RETRIEVAL);
            if (topK < 1) return Promise.resolve([]);

            return getChunksByVideo(videoId).then(function (chunks) {
                if (!chunks.length) return [];

                var scored = [];
                for (var i = 0; i < chunks.length; i++) {
                    var c = chunks[i];
                    if (c.embeddingModel !== RAG_CFG.EMBED_MODEL || !_validEmb(c.embedding)) continue;
                    var sim = _cosine(queryEmbedding, c.embedding);
                    var copy = _shallowClone(c);
                    copy.semanticScore = sim;
                    scored.push(copy);
                }

                if (!scored.length) return [];

                scored.sort(function (a, b) { return b.semanticScore - a.semanticScore; });
                return scored.slice(0, topK);
            });
        }

        /** Guarda resultados de OCR */
        function saveOCR(videoId, frameData) {
            return open().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx  = db.transaction(RAG_CFG.STORE_OCR, 'readwrite');
                    var entry = _shallowClone(frameData);
                    entry.id      = videoId + '_ocr_' + frameData.timeSeconds;
                    entry.videoId = videoId;
                    var req = tx.objectStore(RAG_CFG.STORE_OCR).put(entry);
                    req.onsuccess = resolve;
                    req.onerror   = function (e) { reject(e.target.error); };
                });
            });
        }

        /** Obtiene OCR de un video */
        function getOCR(videoId) {
            return open().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx  = db.transaction(RAG_CFG.STORE_OCR, 'readonly');
                    var idx = tx.objectStore(RAG_CFG.STORE_OCR).index('videoId');
                    var req = idx.getAll(videoId);
                    req.onsuccess = function (e) { resolve(e.target.result || []); };
                    req.onerror   = function (e) { reject(e.target.error); };
                });
            });
        }

        /**
         * Cuenta chunks de un video sin cargar embeddings completos.
         * Útil para diagnóstico y verificación de integridad.
         * FIX v3.1.0: método nuevo.
         */
        function getChunkCount(videoId) {
            return open().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx  = db.transaction(RAG_CFG.STORE_CHUNKS, 'readonly');
                    var req = tx.objectStore(RAG_CFG.STORE_CHUNKS).index('videoId').count(videoId);
                    req.onsuccess = function (e) { resolve(e.target.result || 0); };
                    req.onerror   = function (e) { reject(e.target.error); };
                });
            }).catch(function () { return 0; });
        }

        /**
         * Borra TODA la base de datos (reseteo completo).
         * FIX v3.1.0: método nuevo, útil para recuperación ante corrupción.
         */
        function clearAll() {
            return open().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var stores = [RAG_CFG.STORE_CHUNKS, RAG_CFG.STORE_VIDEOS, RAG_CFG.STORE_OCR];
                    var tx = db.transaction(stores, 'readwrite');
                    for (var i = 0; i < stores.length; i++) {
                        tx.objectStore(stores[i]).clear();
                    }
                    tx.oncomplete = function () { resolve(); };
                    tx.onerror    = function (e) { reject(e.target.error); };
                });
            });
        }

        /**
         * LRU eviction: elimina videos más antiguos si supera MAX_CACHED_VIDEOS.
         * FIX v3.1.0: ejecución en idle time, errores completamente silenciados.
         */
        function _evictOldVideos() {
            function doEvict() {
                open().then(function (db) {
                    var tx  = db.transaction(RAG_CFG.STORE_VIDEOS, 'readonly');
                    var req = tx.objectStore(RAG_CFG.STORE_VIDEOS).getAll();
                    req.onsuccess = function (e) {
                        var videos = e.target.result || [];
                        if (videos.length <= RAG_CFG.MAX_CACHED_VIDEOS) return;

                        videos.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
                        var toDelete = videos.slice(0, videos.length - RAG_CFG.MAX_CACHED_VIDEOS);

                        // Borrado secuencial: esperar cada promise antes de la siguiente
                        // para evitar múltiples transacciones simultáneas en IDB.
                        toDelete.reduce(function (p, vid) {
                            return p.then(function () {
                                return deleteVideo(vid.id);
                            }).catch(function () {});
                        }, Promise.resolve());
                    };
                }).catch(function () {});
            }

            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(doEvict, { timeout: 3000 });
            } else {
                setTimeout(doEvict, 500);
            }
        }

        return {
            open             : open,
            saveChunks       : saveChunks,
            getChunksByVideo : getChunksByVideo,
            isIndexed        : isIndexed,
            deleteVideo      : deleteVideo,
            semanticSearch   : semanticSearch,
            saveOCR          : saveOCR,
            getOCR           : getOCR,
            getChunkCount    : getChunkCount,
            clearAll         : clearAll,
        };

    })();

    // =========================================================================
    // MÓDULO 4: BM25 (Okapi BM25+ variant)
    // =========================================================================
    // MEJORA 08: BM25+ evita scores negativos para términos raros
    // MEJORA 09: Stemming básico y stopwords en keywords
    // MEJORA 10: Normalización por corpus propio
    //
    // FIX v3.1.0:
    //  - scoreChunk: reemplaza Object.values() con loop for..in para ES5 strict
    //  - _build: reemplaza Object.keys().reduce() con loop explícito más eficiente

    VP.rag.BM25 = (function () {

        /**
         * Crea un índice BM25 a partir de un array de chunks.
         * @param {Array} chunks - Array de chunks con campo `keywords`
         */
        function BM25Index(chunks) {
            this.chunks  = chunks || [];
            this.N       = chunks.length;
            this.avgLen  = 0;
            this.df      = {};  // document frequency: {term → count}
            this._build();
        }

        BM25Index.prototype._build = function () {
            var totalLen = 0;
            this.df      = {};  // reset df en cada rebuild
            for (var i = 0; i < this.chunks.length; i++) {
                var kw    = this.chunks[i].keywords || {};
                var terms = Object.keys(kw);
                for (var j = 0; j < terms.length; j++) {
                    var t = terms[j];
                    if (!t) continue;
                    totalLen   += kw[t];
                    this.df[t]  = (this.df[t] || 0) + 1;
                }
            }
            this.avgLen = this.N > 0 ? totalLen / this.N : 0;
        };

        /**
         * Calcula score BM25+ para un chunk dado una lista de términos.
         * FIX v3.1.0: loop for..in en lugar de Object.values() para ES5 strict.
         */
        BM25Index.prototype.scoreChunk = function (chunk, queryTerms) {
            var kw  = chunk.keywords || {};
            var dl  = 0;
            var kKey;
            // Suma de frecuencias = longitud del documento
            for (kKey in kw) {
                if (Object.prototype.hasOwnProperty.call(kw, kKey)) dl += kw[kKey];
            }

            var k1  = RAG_CFG.BM25_K1;
            var b   = RAG_CFG.BM25_B;
            var dlt = RAG_CFG.BM25_DELTA;
            var score = 0;

            for (var i = 0; i < queryTerms.length; i++) {
                var term = queryTerms[i];
                var tf   = kw[term] || 0;
                if (tf === 0) continue;

                var df     = this.df[term] || 0;
                var idf    = Math.log((this.N - df + 0.5) / (df + 0.5) + 1);
                var tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / Math.max(this.avgLen, 1))) + dlt;
                score += idf * tfNorm;
            }

            return Math.max(0, score);
        };

        /**
         * Tokeniza una query para BM25 (misma normalización que el indexado).
         */
        BM25Index.prototype.tokenizeQuery = function (query) {
            if (!query) return [];
            var kw = VP.rag.chunker.extractKeywords(query);
            return Object.keys(kw);
        };

        /**
         * Busca los topK chunks más relevantes para una query.
         */
        BM25Index.prototype.search = function (query, topK) {
            topK = topK || RAG_CFG.HYBRID_TOP_K_RETRIEVAL;
            var queryTerms = this.tokenizeQuery(query);

            if (!queryTerms.length) {
                return this.chunks.slice(0, topK).map(function (c) {
                    return _shallowClone(c, { bm25Score: 0 });
                });
            }

            var self   = this;
            var scored = [];
            for (var i = 0; i < this.chunks.length; i++) {
                var c = this.chunks[i];
                var copy = _shallowClone(c);
                copy.bm25Score = self.scoreChunk(c, queryTerms);
                scored.push(copy);
            }

            scored.sort(function (a, b) { return b.bm25Score - a.bm25Score; });
            return scored.slice(0, topK);
        };

        /** Actualiza el índice con nuevos chunks (incremental) */
        BM25Index.prototype.addChunks = function (newChunks) {
            if (!newChunks || !newChunks.length) return;
            for (var i = 0; i < newChunks.length; i++) {
                this.chunks.push(newChunks[i]);
            }
            this.N = this.chunks.length;
            this._build(); // rebuild completo (rápido para <500 chunks)
        };

        return {
            /** Crea un nuevo índice BM25. */
            create: function (chunks) { return new BM25Index(chunks); },
        };

    })();

    // =========================================================================
    // MÓDULO 5: TEMPORAL SCORING
    // =========================================================================
    // MEJORA 11: Gaussiana para modo normal, exponencial para anti-spoiler
    // MEJORA 12: Bonus para contenido reciente (últimos 30 segundos)

    VP.rag.temporal = (function () {

        /**
         * Calcula el score temporal de un chunk [0, 1].
         *
         * @param {Object} chunk       - {start, end, midpoint}
         * @param {number} currentTime - tiempo actual del video (segundos)
         * @param {number} duration    - duración total (segundos)
         * @param {string} mode        - 'normal' | 'antiSpoiler' | 'busqueda'
         */
        function score(chunk, currentTime, duration, mode) {
            var mid = chunk.midpoint || (chunk.start + chunk.end) / 2;

            if (mode === 'antiSpoiler') {
                // Chunks futuros: penalización absoluta (manejado en hybridSearch)
                if (chunk.start > currentTime + 1) return -1;

                // Decaimiento exponencial: cuanto más antiguo, menos relevante
                var delta = Math.max(0, currentTime - (chunk.end || chunk.start));
                var decay = Math.exp(-delta / RAG_CFG.TEMPORAL_DECAY_TAU_S);

                // Bonus extra para contenido muy reciente (últimos 30s)
                var recencyBonus = (delta < RAG_CFG.TEMPORAL_RECENT_WINDOW) ? 0.25 : 0;
                return Math.min(1, decay + recencyBonus);
            }

            if (currentTime > 0 && duration > 0) {
                // Campana gaussiana centrada en el tiempo actual
                var sigma = Math.max(
                    RAG_CFG.TEMPORAL_SIGMA_MIN_S,
                    duration * RAG_CFG.TEMPORAL_SIGMA_RATIO
                );
                var diff          = mid - currentTime;
                var gaussianScore = Math.exp(-(diff * diff) / (2 * sigma * sigma));

                // Bonus de recencia
                var recentDelta  = Math.abs(mid - currentTime);
                var recentBonus  = (recentDelta < RAG_CFG.TEMPORAL_RECENT_WINDOW) ? 0.15 : 0;
                return Math.min(1, gaussianScore + recentBonus);
            }

            // Sin referencia temporal: distribución lineal desde inicio
            if (duration > 0) {
                return 1 - (mid / duration) * 0.3; // ligero bias hacia el inicio
            }

            return 0.5; // sin información temporal
        }

        /**
         * Filtra chunks futuros para modo anti-spoiler.
         * @param {Array}  chunks
         * @param {number} currentTime
         * @param {number} toleranceSecs - margen de tolerancia (default 2s)
         */
        function filterFuture(chunks, currentTime, toleranceSecs) {
            var tol = toleranceSecs !== undefined ? toleranceSecs : 2;
            return chunks.filter(function (c) {
                return (c.start || 0) <= currentTime + tol;
            });
        }

        /**
         * Calcula el "contextual bonus": boost para chunks adyacentes al tiempo actual.
         */
        function contextualBonus(chunk, currentTime) {
            if (!currentTime || currentTime <= 0) return 0;
            var end   = chunk.end   || 0;
            var start = chunk.start || 0;

            // Chunk que acaba de terminar (últimos 30s)
            if (end <= currentTime && end >= currentTime - RAG_CFG.TEMPORAL_RECENT_WINDOW) return 1.0;

            // Chunk que está reproduciéndose ahora
            if (start <= currentTime && end >= currentTime) return 0.9;

            return 0;
        }

        return {
            score          : score,
            filterFuture   : filterFuture,
            contextualBonus: contextualBonus,
        };

    })();

    // =========================================================================
    // MÓDULO 6: HYBRID SEARCH
    // =========================================================================
    // MEJORA 12: Pesos adaptativos por intención
    // MEJORA 13: RRF como alternativa a scoring directo
    // MEJORA 10: Normalización independiente de cada señal
    //
    // FIX v3.1.0:
    //  - Object.values(mergedMap) → loop manual para ES5 strict
    //  - Guard contra mergedMap vacío

    VP.rag.hybridSearch = (function () {

        /**
         * Combina resultados semánticos y BM25 con scoring híbrido.
         *
         * @param {Array}  semanticResults - chunks con campo semanticScore
         * @param {Array}  bm25Results     - chunks con campo bm25Score
         * @param {Object} options
         *   - mode        {string}  'normal' | 'antiSpoiler' | 'busqueda' | 'explicacion' | 'resumen'
         *   - currentTime {number}
         *   - duration    {number}
         *   - antiSpoiler {boolean}
         *   - topK        {number}
         */
        function search(semanticResults, bm25Results, options) {
            options = options || {};
            var mode        = options.mode        || 'normal';
            var currentTime = options.currentTime || 0;
            var duration    = options.duration    || 0;
            var antiSpoiler = options.antiSpoiler || false;
            var topK        = options.topK        || RAG_CFG.HYBRID_TOP_K_RETRIEVAL;

            var weights = _getWeights(mode, antiSpoiler);

            // Normalizar scores semánticos y BM25 independientemente
            var normSem  = _normalizeScores(semanticResults || [], 'semanticScore');
            var normBM25 = _normalizeScores(bm25Results     || [], 'bm25Score');

            // Merge por ID de chunk
            var mergedMap = {};

            for (var i = 0; i < normSem.length; i++) {
                var c = normSem[i];
                mergedMap[c.id] = _shallowClone(c, {
                    _normSem  : c['_norm_semanticScore'] || 0,
                    _normBM25 : 0,
                });
            }
            for (var j = 0; j < normBM25.length; j++) {
                var d = normBM25[j];
                if (mergedMap[d.id]) {
                    mergedMap[d.id]._normBM25 = d['_norm_bm25Score'] || 0;
                } else {
                    mergedMap[d.id] = _shallowClone(d, {
                        _normSem  : 0,
                        _normBM25 : d['_norm_bm25Score'] || 0,
                    });
                }
            }

            // FIX v3.1.0: loop manual en lugar de Object.values()
            var mergedKeys = Object.keys(mergedMap);
            var results    = [];

            for (var k = 0; k < mergedKeys.length; k++) {
                var chunk = mergedMap[mergedKeys[k]];

                var tempScore = VP.rag.temporal.score(chunk, currentTime, duration,
                    antiSpoiler ? 'antiSpoiler' : mode);

                // Filtro estricto anti-spoiler
                if (antiSpoiler && tempScore < 0) continue;

                var ctxBonus = VP.rag.temporal.contextualBonus(chunk, currentTime);

                var finalScore =
                    weights.sem  * chunk._normSem  +
                    weights.bm25 * chunk._normBM25 +
                    weights.temp * Math.max(0, tempScore) +
                    weights.ctx  * ctxBonus;

                var entry = _shallowClone(chunk);
                entry.finalScore = finalScore;
                entry.tempScore  = tempScore;
                entry.ctxBonus   = ctxBonus;
                entry._weights   = weights;
                results.push(entry);
            }

            results.sort(function (a, b) { return b.finalScore - a.finalScore; });
            return results.slice(0, topK);
        }

        /** Selecciona pesos según modo e intención */
        function _getWeights(mode, antiSpoiler) {
            if (antiSpoiler) return RAG_CFG.WEIGHTS_ANTISPOILER;
            switch (mode) {
                case 'busqueda':    return RAG_CFG.WEIGHTS_BUSQUEDA;
                case 'explicacion': return RAG_CFG.WEIGHTS_EXPLICACION;
                case 'resumen':     return RAG_CFG.WEIGHTS_RESUMEN;
                default:            return RAG_CFG.WEIGHTS_NORMAL;
            }
        }

        return { search: search };

    })();

    // =========================================================================
    // MÓDULO 7: RERANKER (RRF + MMR)
    // =========================================================================
    // MEJORA 13: RRF no depende de calibración de scores brutos
    // MEJORA 14: MMR garantiza diversidad temática en el top-K
    //
    // FIX v3.1.0:
    //  - mmr: shortcircuit cuando candidates es vacío
    //  - rrf: Object.keys() loop en lugar de Object.keys().sort().map() encadenado

    VP.rag.reranker = (function () {

        /**
         * Reciprocal Rank Fusion.
         * Combina dos rankings (semántico y BM25) por posición, no por score.
         *
         * @param {Array}  rankA  - array de chunks (ordenado por relevancia A)
         * @param {Array}  rankB  - array de chunks (ordenado por relevancia B)
         * @param {number} k     - constante RRF (default 60)
         * @returns {Array} chunks ordenados por score RRF (descendente)
         */
        function rrf(rankA, rankB, k) {
            k = k || RAG_CFG.RRF_K;

            var scores   = {};
            var chunkMap = {};

            function addRank(ranking) {
                if (!ranking) return;
                for (var i = 0; i < ranking.length; i++) {
                    var c  = ranking[i];
                    var id = c.id;
                    scores[id]   = (scores[id] || 0) + 1 / (k + i + 1);
                    if (!chunkMap[id]) chunkMap[id] = c;
                }
            }

            addRank(rankA);
            addRank(rankB);

            var ids = Object.keys(scores);
            ids.sort(function (a, b) { return scores[b] - scores[a]; });
            return ids.map(function (id) {
                return _shallowClone(chunkMap[id], { rrfScore: scores[id] });
            });
        }

        /**
         * Maximal Marginal Relevance.
         * Selecciona los top-K chunks balanceando relevancia y diversidad.
         *
         * @param {Array}  candidates     - chunks con embedding y finalScore/rrfScore
         * @param {Array}  queryEmbedding - vector de la query
         * @param {number} topK
         * @param {number} lambda         - [0,1]: 1=solo relevancia, 0=solo diversidad
         */
        function mmr(candidates, queryEmbedding, topK, lambda) {
            topK   = topK   || RAG_CFG.HYBRID_FINAL_K;
            lambda = lambda !== undefined ? lambda : RAG_CFG.MMR_LAMBDA;

            // FIX v3.1.0: shortcircuit explícito
            if (!candidates || !candidates.length) return [];

            // Separar chunks con y sin embedding válido
            var valid    = [];
            var noEmb    = [];
            for (var ci = 0; ci < candidates.length; ci++) {
                if (candidates[ci].embeddingModel === RAG_CFG.EMBED_MODEL && _validEmb(candidates[ci].embedding)) valid.push(candidates[ci]);
                else noEmb.push(candidates[ci]);
            }

            var selected  = [];
            var remaining = valid.slice();

            // El primero siempre es el más relevante
            remaining.sort(function (a, b) {
                return ((b.finalScore || b.rrfScore || 0) - (a.finalScore || a.rrfScore || 0));
            });

            if (remaining.length) {
                selected.push(remaining.shift());
            }

            while (selected.length < topK && remaining.length) {
                var bestIdx   = -1;
                var bestScore = -Infinity;

                for (var i = 0; i < remaining.length; i++) {
                    var cand = remaining[i];

                    var relevance = queryEmbedding
                        ? _cosine(queryEmbedding, cand.embedding)
                        : (cand.finalScore || cand.rrfScore || 0);

                    // Máxima similitud con cualquier chunk ya seleccionado
                    var maxSim = 0;
                    for (var s = 0; s < selected.length; s++) {
                        var sim = _cosine(cand.embedding, selected[s].embedding);
                        if (sim > maxSim) maxSim = sim;
                    }

                    var mmrScore = lambda * relevance - (1 - lambda) * maxSim;

                    if (mmrScore > bestScore) {
                        bestScore = mmrScore;
                        bestIdx   = i;
                    }
                }

                if (bestIdx >= 0) {
                    selected.push(remaining.splice(bestIdx, 1)[0]);
                } else {
                    break;
                }
            }

            // Añadir chunks sin embedding al final si hay espacio
            var fillCount = topK - selected.length;
            if (fillCount > 0 && noEmb.length) {
                for (var n = 0; n < Math.min(fillCount, noEmb.length); n++) {
                    selected.push(noEmb[n]);
                }
            }

            return selected;
        }

        return { rrf: rrf, mmr: mmr };

    })();

    // =========================================================================
    // MÓDULO 8: CONTEXT BUILDER
    // =========================================================================
    // MEJORA 15: Deduplicación por overlap temporal
    // MEJORA 16: Budget de tokens respetado estrictamente
    // MEJORA 03: Metadatos de chunk preservados en el texto de contexto

    VP.rag.contextBuilder = (function () {

        /**
         * Construye el bloque de contexto a incluir en el prompt.
         *
         * @param {Array}  chunks
         * @param {Object} options
         *   - maxTokens   {number}
         *   - sortByTime  {boolean}
         *   - antiSpoiler {boolean}
         *   - currentTime {number}
         *   - ocrEntries  {Array}
         */
        function build(chunks, options) {
            options     = options || {};
            var maxTokens   = options.maxTokens   || RAG_CFG.CTX_MAX_TOKENS;
            var sortByTime  = options.sortByTime   !== false;
            var antiSpoiler = options.antiSpoiler  || false;
            var currentTime = options.currentTime  || 0;
            var ocrEntries  = options.ocrEntries   || [];

            if (!chunks || !chunks.length) {
                return { text: '', chunks: [], tokens: 0, chunkCount: 0 };
            }

            // 1. Filtro anti-spoiler
            var filtered = antiSpoiler
                ? VP.rag.temporal.filterFuture(chunks, currentTime, 1)
                : chunks.slice();

            // 2. Deduplicar chunks con alto overlap temporal
            filtered = _deduplicateByOverlap(filtered);

            // 3. Mezclar con OCR si existe
            if (ocrEntries.length) {
                filtered = _mergeOCR(filtered, ocrEntries);
            }

            // 4. Ordenar cronológicamente
            if (sortByTime) {
                filtered.sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
            }

            // 5. Construir texto con budget de tokens
            var lines      = [];
            var usedTokens = 0;

            for (var i = 0; i < filtered.length; i++) {
                var chunk = filtered[i];
                var isOCR = chunk._isOCR;

                var header = isOCR
                    ? '[' + _fmtTime(chunk.start) + ' — OCR/Texto visual]'
                    : '[' + _fmtTime(chunk.start) + '–' + _fmtTime(chunk.end) + ']';

                var line   = header + '\n' + (chunk.text || '').trim();
                var tokens = _estTokens(line);

                if (usedTokens + tokens > maxTokens && lines.length > 0) break;

                lines.push(line);
                usedTokens += tokens;
            }

            return {
                text       : lines.join(RAG_CFG.CTX_SEPARATOR),
                chunks     : filtered.slice(0, lines.length),
                tokens     : usedTokens,
                chunkCount : lines.length,
            };
        }

        /**
         * Deduplica chunks cuyo overlap temporal supera el umbral.
         * Mantiene el chunk con mayor score.
         */
        function _deduplicateByOverlap(chunks) {
            var result = [];

            for (var i = 0; i < chunks.length; i++) {
                var c     = chunks[i];
                var isDup = false;

                for (var j = 0; j < result.length; j++) {
                    var existing     = result[j];
                    var overlapStart = Math.max(existing.start || 0, c.start || 0);
                    var overlapEnd   = Math.min(existing.end   || 0, c.end   || 0);
                    var overlap      = Math.max(0, overlapEnd - overlapStart);
                    var shorter      = Math.min(
                        (existing.end || 0) - (existing.start || 0),
                        (c.end        || 0) - (c.start        || 0)
                    );

                    if (shorter > 0 && overlap / shorter > RAG_CFG.CTX_OVERLAP_THRESHOLD) {
                        isDup = true;
                        var scoreC   = c.finalScore        || c.rrfScore        || 0;
                        var scoreExg = existing.finalScore || existing.rrfScore || 0;
                        if (scoreC > scoreExg) result[j] = c;
                        break;
                    }
                }

                if (!isDup) result.push(c);
            }

            return result;
        }

        /**
         * Mezcla entradas de OCR con los chunks de texto.
         */
        function _mergeOCR(chunks, ocrEntries) {
            var ocrChunks = ocrEntries.map(function (ocr) {
                return {
                    id        : ocr.id || ('ocr_' + ocr.timeSeconds),
                    start     : ocr.timeSeconds || 0,
                    end       : (ocr.timeSeconds || 0) + 5,
                    midpoint  : ocr.timeSeconds || 0,
                    text      : ocr.text || '',
                    finalScore: 0.3,
                    _isOCR    : true,
                };
            });
            return chunks.concat(ocrChunks);
        }

        return { build: build };

    })();

    // =========================================================================
    // EXPORTAR CONSTANTES (para uso en otros módulos)
    // =========================================================================
    VP.rag.CFG = RAG_CFG;

    // =========================================================================
    // UTILIDADES COMPARTIDAS (accesibles desde otros módulos rag)
    // =========================================================================
    VP.rag.utils = {
        fmtTime         : _fmtTime,
        estTokens       : _estTokens,
        cosine          : _cosine,
        normalizeScores : _normalizeScores,
        validEmb        : _validEmb,
        chunkId         : _chunkId,
        shallowClone    : _shallowClone,
        yieldAsync      : _yieldAsync,
    };

    // =========================================================================
    // SUBTITLE INDEX  —  Índice de subtítulos exactos (búsqueda literal)
    // =========================================================================
    // FASE 2: índice plano de subtítulos sin embeddings ni chunks.
    //     { id, start, end, text, normalized }

    VP.rag.subtitleIndex = (function () {

        var WINDOW_SIZES = [2, 3, 4];

        function build(cues) {
            var index = [];
            for (var i = 0; i < cues.length; i++) {
                var cue = cues[i];
                if (!cue || !cue.texto) continue;
                index.push({
                    id        : i,
                    start     : cue.inicio || 0,
                    end       : cue.fin || cue.inicio || 0,
                    text      : cue.texto,
                    normalized: _norm(cue.texto),
                });

                // Ventanas deslizantes de 2-4 cues consecutivos
                for (var w = 0; w < WINDOW_SIZES.length; w++) {
                    var size = WINDOW_SIZES[w];
                    if (i + size > cues.length) break;

                    var windowText = '';
                    var valid = true;
                    for (var k = 0; k < size; k++) {
                        var wCue = cues[i + k];
                        if (!wCue || !wCue.texto) { valid = false; break; }
                        windowText += (windowText ? ' ' : '') + wCue.texto.trim();
                    }
                    if (!valid) continue;

                    var wStart = cues[i].inicio || 0;
                    var wEnd   = cues[i + size - 1].fin || cues[i + size - 1].inicio || 0;
                    index.push({
                        id        : -(i * 10 + size),
                        start     : wStart,
                        end       : wEnd,
                        text      : windowText,
                        normalized: _norm(windowText),
                    });
                }
            }
            return index;
        }

        function _norm(text) {
            var s = String(text || '');
            s = s.replace(/-\s*\n\s*/g, '');
            s = s.replace(/\n\s*/g, ' ');
            s = s.replace(/\u2018|\u2019|\u201A|\u201B|\u2032/g, "'");
            s = s.replace(/\u201C|\u201D|\u201E|\u201F|\u2033/g, '"');
            s = s.replace(/\u2013|\u2014/g, '-');
            s = s.replace(/\u00AD/g, '');
            s = s.replace(/\u00A0/g, ' ');
            s = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            s = s.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
            return s;
        }

        return {
            build    : build,
            normalize: _norm,
        };

    })();

    if (log.info) log.info('vp-rag-core.js v3.1.1 cargado. Módulos: chunker, embedder, vectorStore, BM25, temporal, hybridSearch, reranker, contextBuilder, subtitleIndex.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-rag-core.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
