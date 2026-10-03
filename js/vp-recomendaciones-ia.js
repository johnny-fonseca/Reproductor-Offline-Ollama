'use strict';

// ============================================================
// VP-RECOMENDACIONES-IA.JS  —  v3.0.1
// Recomendación de vídeos por similitud multidimensional:
//   · Etiquetas IA (Jaccard ponderado por categoría)
//   · Similitud semántica por embeddings Ollama
//   · Similitud de nombre de archivo (tokenización avanzada)
//   · Proximidad de duración
//   · Señales colaborativas (clics del usuario)
//   · MMR (Maximal Marginal Relevance) para diversidad
//
// Novedades v3.0.0:
//   · Motor de embeddings vectoriales vía Ollama /api/embeddings
//   · Caché LRU independiente para vectores de embeddings
//   · Cola de cómputo BG de embeddings con prioridad y throttle
//   · Similitud coseno + similitud combinada 5 dimensiones
//   · Tracking de clics con boost colaborativo
//   · UI: filtros (etiqueta, duración), ordenamiento, vista compacta
//   · UI: tooltip "¿Por qué?" con desglose de puntuación
//   · UI: barra de progreso de embeddings
//   · UI: panel de estadísticas expandible
//   · Retry con backoff exponencial para llamadas Ollama
//   · Persistencia triple de embeddings (LRU → LS → IDB)
//   · Invalidación selectiva de caché por vídeo
//   · Configuración dinámica en caliente via setConfig()
//   · Soporte completo de destroy() sin fugas de memoria
//   · CACHE_VERSION = 5 para invalidar cachés de recomendaciones anteriores
//
// Fix v3.0.1:
//   · _embedKey() incluye modelo activo → vectores de modelos distintos
//     no se confunden entre sí (EMBED_CACHE_VERSION bumped a 2)
//   · _preloadEmbeddingsIDB() nueva: precarga vectores desde IDB al
//     arrancar, recuperando embeddings aunque LS esté vacío/purgado
//   · _enqueueAllEmbeddings() comprueba LRU→LS→IDB antes de llamar
//     a Ollama; solo genera los vectores genuinamente ausentes
//
// Requiere: vp-base.js, vp-utilidades.js, vp-db.js,
//           vp-etiquetas-ia.js, vp-ollama-client.js (opcional)
// ============================================================

(function (window, document) {

    if (window.__VP_RECOMENDACIONES_IA_LOADED__) return;
    window.__VP_RECOMENDACIONES_IA_LOADED__ = true;

    var VP = window.VP;
    if (!VP || typeof VP !== 'object') {
        console.error('[VPRecomendaciones] VP no disponible.');
        return;
    }

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;
    log.setContext('RecomendacionesIA');

    // ============================================================
    // SECCIÓN 1 — CONFIGURACIÓN
    // ============================================================

    var CFG = {
        // ---- Caché y persistencia ----
        STORAGE_PREFIX           : 'vpRecIA_',
        EMBED_STORAGE_PREFIX     : 'vpEmbIA_',
        LS_INDEX_KEY             : 'vpRecIA__index',
        LS_EMBED_INDEX_KEY       : 'vpEmbIA__index',
        CLICK_STORAGE_KEY        : 'vpRecIA__clicks',
        CACHE_LRU_MAX            : 500,
        EMBED_CACHE_LRU_MAX      : 300,
        CACHE_VERSION            : 5,
        EMBED_CACHE_VERSION      : 3,   // v3: separador de clave cambiado de \x00 a ||
        CACHE_TTL_MS             : 24 * 60 * 60 * 1000,
        EMBED_CACHE_TTL_MS       : 7  * 24 * 60 * 60 * 1000,
        IDB_META_KEY             : 'recomendacionesIA',
        IDB_EMBED_META_KEY       : 'embeddingIA',

        // ---- Límites de recomendaciones ----
        MAX_RECOMENDACIONES      : 12,
        MAX_RECOMMENDATION_CANDIDATES: 80,
        MAX_RECOMMENDATION_EMBEDDINGS: 24,
        MIN_SIMILARITY           : 0.01,
        UI_MAX_VISIBLE           : 8,

        // ---- Timings ----
        RECOMPUTE_DELAY_MS       : 800,
        BG_COMPUTE_DELAY_MS      : 200,
        EMBED_BATCH_DELAY_MS     : 600,

        // ---- Pesos de similitud — cuando hay embeddings + etiquetas ----
        TAG_WEIGHT               : 0.35,
        SEMANTIC_WEIGHT          : 0.37,
        NAME_WEIGHT              : 0.20,
        DURATION_WEIGHT          : 0.08,

        // ---- Pesos — embeddings sin etiquetas ----
        NONTAG_SEMANTIC_WEIGHT   : 0.72,
        NONTAG_NAME_WEIGHT       : 0.20,
        NONTAG_DURATION_WEIGHT   : 0.08,

        // ---- Pesos — solo etiquetas, sin embeddings ----
        NOTAG_EMBED_TAG_WEIGHT   : 0.55,
        NOTAG_EMBED_NAME_WEIGHT  : 0.35,
        NOTAG_EMBED_DUR_WEIGHT   : 0.10,

        // ---- Pesos — solo nombre + duración (fallback puro) ----
        FALLBACK_NAME_WEIGHT     : 0.85,
        FALLBACK_DURATION_WEIGHT : 0.15,

        // ---- Pesos de categorías de etiquetas ----
        CATEGORY_WEIGHTS: {
            genre      : 3.0,
            mood       : 2.5,
            topic      : 2.0,
            person     : 2.0,
            location   : 1.5,
            activity   : 1.5,
            style      : 1.2,
            resolution : 0.5,
            format     : 0.5,
            tag        : 1.0,
        },

        // ---- Boost colaborativo ----
        COLLAB_WEIGHT            : 0.08,
        COLLAB_MAX_CLICKS        : 50,
        COLLAB_DECAY             : 0.9,

        // ---- MMR ----
        MMR_LAMBDA               : 0.72,
        DURATION_PROXIMITY       : 0.20,

        // ---- Ollama embeddings ----
        OLLAMA_URL               : 'http://localhost:11434',
        EMBEDDING_MODEL          : 'nomic-embed-text-v2-moe:q8_0',
        EMBED_TIMEOUT_MS         : 30000,
        EMBED_MAX_RETRIES        : 3,
        EMBED_RETRY_BASE_MS      : 1000,
        EMBED_MAX_TEXT_CHARS     : 2000,

        // ---- Concurrency caps explícitos ----
        MAX_EMBED_CONCURRENCY    : 2,   // embeddings Ollama paralelos máximo
        MAX_BG_BATCH             : 1,   // recompute sincrónico por lote
        PRELOAD_TIMEOUT_MS       : 30000, // hard timeout precarga completa

        // ---- UI ----
        FILTER_DEBOUNCE_MS       : 350,
    };

    function _backgroundWorkAllowed() {
        try {
            if (typeof document !== 'undefined' && document.hidden) return false;
        } catch (_) {}
        if (VP.runtime && (VP.runtime.modoLento || VP.runtime.tabVisible === false)) return false;
        var totalVideos = VP.estado && VP.estado.videos ? VP.estado.videos.length : 0;
        if (totalVideos > 200) {
            var player = VP.refs && VP.refs.videoPlayer ? VP.refs.videoPlayer : null;
            var playerBusy = !!player && !player.paused && !player.ended && player.readyState >= 2;
            if (playerBusy) return false;
        }
        return true;
    }

    // ============================================================
    // SECCIÓN 2 — ESTADO INTERNO
    // ============================================================

    var _s = {
        _initialized         : false,
        _currentVidId        : null,
        _recoms              : [],
        _recomsFiltered      : [],
        _recomsVisible       : 0,
        _uiCreated           : false,
        _preloaded           : false,
        _preloadChunkTimer   : null,
        _preloadIdleHandle   : null,
        _preloadRun          : 0,
        _cssInjected         : false,
        _recomputeTimer      : null,
        _filterDebounceTimer : null,
        _bgProcessTimer      : null,
        _recommendationEpoch : 0,

        // Cola de recomendaciones BG
        _bgQueue             : [],
        _bgQueueHead         : 0,
        _bgQueueDedup        : new Set(),
        _bgRunning           : false,

        // Cola de embeddings BG
        _embedQueue          : [],
        _embedRunning        : false,
        _embedEnqueued       : false,    // evita llamadas duplicadas a _enqueueAllEmbeddings
        _embedTotal          : 0,
        _embedDone           : 0,
        _embedErrors         : 0,
        _embeddingEpoch      : 0,
        _embedProcessTimer   : null,

        // Listeners
        _docListeners        : [],
        _moduleId            : 'RecomendacionesIA',
        _guard               : new VP.AsyncGuard({ name: 'RecomendacionesIA' }),
        _readyCallbacks      : [],
        _ready               : false,

        // UI state
        _compactView         : false,
        _detailedView        : true,
        _sortMode            : 'score',       // 'score' | 'semantic' | 'name'
        _filterTag           : '',
        _filterDurMin        : 0,
        _filterDurMax        : Infinity,
        _statsExpanded       : false,

        // Ollama disponible
        _ollamaAvailable     : null,          // null=desconocido, true/false
        _embeddingModelAvailable : null,
        _ollamaChecked       : false,         // true si ya se verificó al menos una vez
        _ollamaChecking      : false,         // true mientras se está verificando
        _ollamaCheckEpoch    : 0,
        _ollamaCheckTimer    : null,
        _ollamaRetryCount    : 0,

        // Cancelación y dedup async
        _destroyed           : false,
        _pendingEmbeds       : Object.create(null),
        _embedQueueDedup     : Object.create(null),
        _embedKeyEpochs      : Object.create(null),
        _invalidatedEmbedKeys: Object.create(null),
    };

    // ============================================================
    // SECCIÓN 3 — CACHÉ LRU DE RECOMENDACIONES
    // ============================================================

    var _cacheLRU = (function () {
        var capacity = CFG.CACHE_LRU_MAX;
        var map = new Map();

        function touch(key) {
            var entry = map.get(key);
            if (entry) { map.delete(key); map.set(key, entry); }
            return entry || null;
        }

        function evict() {
            while (map.size > capacity) {
                map.delete(map.keys().next().value);
            }
        }

        return {
            get: function (id) {
                var entry = touch(id);
                if (!entry) return null;
                if (entry.version !== CFG.CACHE_VERSION) { map.delete(id); return null; }
                if (Date.now() - (entry.computedAt || 0) > CFG.CACHE_TTL_MS) {
                    map.delete(id); return null;
                }
                return entry;
            },
            set: function (id, data) {
                if (!id) return;
                map.set(id, {
                    recoms     : data.recoms || [],
                    computedAt : data.computedAt || Date.now(),
                    version    : CFG.CACHE_VERSION,
                });
                evict();
            },
            has: function (id) { return !!this.get(id); },
            del: function (id) { map.delete(id); },
            clear: function () { map.clear(); },
            size: function () { return map.size; },
            keys: function () { return Array.from(map.keys()); },
        };
    })();

    // ============================================================
    // SECCIÓN 4 — CACHÉ LRU DE EMBEDDINGS
    // ============================================================

    var _embeddingNormSquared = new WeakMap();

    function _calcularNormaCuadrada(vec) {
        var isTypedArray = typeof ArrayBuffer !== 'undefined' &&
            typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(vec);
        if (!vec || (!Array.isArray(vec) && !isTypedArray) || !vec.length || vec.length < 64) return null;

        var norma = 0;
        for (var i = 0; i < vec.length; i++) {
            if (typeof vec[i] !== 'number' || !isFinite(vec[i])) return null;
            norma += vec[i] * vec[i];
        }
        return norma;
    }

    function _obtenerNormaCuadrada(vec) {
        return vec && _embeddingNormSquared.has(vec)
            ? _embeddingNormSquared.get(vec)
            : _calcularNormaCuadrada(vec);
    }

    var _embedLRU = (function () {
        var capacity = CFG.EMBED_CACHE_LRU_MAX;
        var map = new Map();

        function touch(key) {
            var entry = map.get(key);
            if (entry) { map.delete(key); map.set(key, entry); }
            return entry || null;
        }

        function evict() {
            while (map.size > capacity) {
                map.delete(map.keys().next().value);
            }
        }

        return {
            get: function (key) {
                var entry = touch(key);
                if (!entry) return null;
                if (entry.version !== CFG.EMBED_CACHE_VERSION || !_embeddingNormSquared.has(entry.vec)) { map.delete(key); return null; }
                if (Date.now() - (entry.ts || 0) > CFG.EMBED_CACHE_TTL_MS) {
                    map.delete(key); return null;
                }
                return entry.vec;
            },
            set: function (key, vec) {
                if (!key) return;
                var norma = _calcularNormaCuadrada(vec);
                if (norma === null) return;
                var copia = Array.prototype.slice.call(vec);
                _embeddingNormSquared.set(copia, norma);
                map.set(key, { vec: copia, ts: Date.now(), version: CFG.EMBED_CACHE_VERSION });
                evict();
            },
            has: function (key) { return !!this.get(key); },
            del: function (key) { map.delete(key); },
            clear: function () { map.clear(); },
            size: function () { return map.size; },
            keys: function () { return Array.from(map.keys()); },
        };
    })();

    // ============================================================
    // SECCIÓN 5 — ÍNDICE LOCALSTORAGE DE RECOMENDACIONES
    // ============================================================

    var _index = {
        _data: null,
        _load: function () {
            if (this._data) return this._data;
            try {
                var raw = VP.db.obtenerKeyVal(CFG.LS_INDEX_KEY);
                this._data = raw || {};
            } catch (_) { this._data = {}; }
            return this._data;
        },
        _save: function () {
            try { VP.db.guardarKeyVal(CFG.LS_INDEX_KEY, this._data); } catch (_) {}
        },
        add: function (vidId) { this._load()[vidId] = Date.now(); this._save(); },
        remove: function (vidId) { delete this._load()[vidId]; this._save(); },
        removeMany: function (vidIds) {
            if (!Array.isArray(vidIds) || vidIds.length === 0) return;
            var data = this._load();
            var changed = false;
            for (var i = 0; i < vidIds.length; i++) {
                if (Object.prototype.hasOwnProperty.call(data, vidIds[i])) {
                    delete data[vidIds[i]];
                    changed = true;
                }
            }
            if (changed) this._save();
        },
        getAll: function () { return Object.keys(this._load()); },
        clear: function () { this._data = {}; try { VP.db.eliminarKeyVal(CFG.LS_INDEX_KEY); } catch (_) {} },
    };

    // ============================================================
    // SECCIÓN 6 — ÍNDICE LOCALSTORAGE DE EMBEDDINGS
    // ============================================================

    var _embedIndex = {
        _data: null,
        _load: function () {
            if (this._data) return this._data;
            try {
                var raw = VP.db.obtenerKeyVal(CFG.LS_EMBED_INDEX_KEY);
                this._data = raw || {};
            } catch (_) { this._data = {}; }
            return this._data;
        },
        _save: function () {
            try { VP.db.guardarKeyVal(CFG.LS_EMBED_INDEX_KEY, this._data); } catch (_) {}
        },
        add: function (key) { this._load()[key] = Date.now(); this._save(); },
        remove: function (key) { delete this._load()[key]; this._save(); },
        getAll: function () { return Object.keys(this._load()); },
        has: function (key) { return !!this._load()[key]; },
        clear: function () {
            this._data = {};
            try { VP.db.eliminarKeyVal(CFG.LS_EMBED_INDEX_KEY); } catch (_) {}
        },
    };

    // ============================================================
    // SECCIÓN 7 — TRACKING DE CLICS COLABORATIVO
    // ============================================================

    var _clicks = (function () {
        var _data = null;

        function _load() {
            if (_data) return _data;
            try {
                var raw = VP.db.obtenerKeyVal(CFG.CLICK_STORAGE_KEY);
                _data = raw || {};
            } catch (_) { _data = {}; }
            return _data;
        }

        function _save() {
            try { VP.db.guardarKeyVal(CFG.CLICK_STORAGE_KEY, _data); } catch (_) {}
        }

        return {
            record: function (fromId, toId) {
                if (!fromId || !toId) return;
                var d = _load();
                var key = String(fromId) + '_' + String(toId);
                d[key] = Math.min((d[key] || 0) + 1, CFG.COLLAB_MAX_CLICKS);
                _save();
            },
            getScore: function (fromId, toId) {
                if (!fromId || !toId) return 0;
                var d = _load();
                var key = String(fromId) + '_' + String(toId);
                var raw = d[key] || 0;
                return raw / CFG.COLLAB_MAX_CLICKS;
            },
            getTopFrom: function (fromId, n) {
                var d = _load();
                var prefix = String(fromId) + '_';
                var entries = [];
                Object.keys(d).forEach(function (k) {
                    if (k.indexOf(prefix) === 0) {
                        var toId = k.slice(prefix.length);
                        entries.push({ toId: toId, score: d[k] / CFG.COLLAB_MAX_CLICKS });
                    }
                });
                entries.sort(function (a, b) { return b.score - a.score; });
                return entries.slice(0, n || 10);
            },
            decay: function () {
                var d = _load();
                Object.keys(d).forEach(function (k) {
                    d[k] = Math.max(0, Math.floor(d[k] * CFG.COLLAB_DECAY));
                    if (d[k] === 0) delete d[k];
                });
                _save();
            },
            clear: function () { _data = {}; try { VP.db.eliminarKeyVal(CFG.CLICK_STORAGE_KEY); } catch (_) {} },
        };
    })();

    // ============================================================
    // SECCIÓN 8 — FUNCIONES DE SIMILITUD POR ETIQUETAS
    // ============================================================

    function _normTag(str) {
        return (str || '').toLowerCase().trim();
    }

    function _getTagObjects(video) {
        var raw = [];
        if (video._tagsIA && Array.isArray(video._tagsIA) && video._tagsIA.length > 0) {
            raw = video._tagsIA;
        } else if (VP.etiquetasIA && typeof VP.etiquetasIA.getTagsForVideo === 'function') {
            var name = video.name || (video.file && video.file.name) || '';
            if (name) {
                var fetched = VP.etiquetasIA.getTagsForVideo(name);
                if (fetched && fetched.length > 0) raw = fetched;
            }
        }
        var seen = {};
        var result = [];
        for (var i = 0; i < raw.length; i++) {
            var t = raw[i];
            var cat = _normTag(t.category || 'tag');
            var val = _normTag(t.value || '');
            var key = cat + ':' + val;
            if (key !== ':' && key !== 'tag:' && !seen[key]) {
                seen[key] = true;
                result.push({ category: cat, value: val, key: key });
            }
        }
        return result;
    }

    function _weightedJaccard(tagsA, tagsB) {
        if (!tagsA || !tagsB || tagsA.length === 0 || tagsB.length === 0) return 0;
        var mapB = {};
        for (var i = 0; i < tagsB.length; i++) mapB[tagsB[i].key] = tagsB[i];
        var weightIntersection = 0, weightA = 0, weightB = 0;
        var catWeights = CFG.CATEGORY_WEIGHTS;
        for (var j = 0; j < tagsA.length; j++) {
            var w = catWeights[tagsA[j].category] || 1.0;
            weightA += w;
            if (mapB[tagsA[j].key]) weightIntersection += w;
        }
        for (var k = 0; k < tagsB.length; k++) {
            weightB += catWeights[tagsB[k].category] || 1.0;
        }
        var weightUnion = weightA + weightB - weightIntersection;
        return weightUnion === 0 ? 0 : weightIntersection / weightUnion;
    }

    function _tokenizeName(name) {
        if (!name) return [];
        var clean = name.replace(/\.[^/.]+$/, '');
        clean = clean
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
            .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
            .replace(/[\-_.+\[\](){}]+/g, ' ')
            .toLowerCase();
        var stopwords = {
            'de':1,'la':1,'el':1,'en':1,'del':1,'los':1,'las':1,'un':1,'una':1,
            'video':1,'tutorial':1,'parte':1,'capitulo':1,'version':1,'vol':1,
            'hd':1,'full':1,'oficial':1,'y':1,'e':1,'o':1,'lo':1,'the':1,'a':1,
            'and':1,'or':1,'of':1,'in':1,'to':1,'for':1,'with':1,'ep':1,'eps':1
        };
        return clean.split(/\s+/).filter(function (t) {
            return t.length > 1 && !stopwords[t];
        });
    }

    function _nameSimilarity(videoA, videoB) {
        var nameA = videoA.name || (videoA.file && videoA.file.name) || '';
        var nameB = videoB.name || (videoB.file && videoB.file.name) || '';
        if (!nameA || !nameB) return 0;
        var tokA = _tokenizeName(nameA);
        var tokB = _tokenizeName(nameB);
        if (tokA.length === 0 && tokB.length === 0) return 0;
        var setB = {};
        for (var i = 0; i < tokB.length; i++) setB[tokB[i]] = true;
        var inter = 0;
        for (var j = 0; j < tokA.length; j++) if (setB[tokA[j]]) inter++;
        var union = tokA.length + tokB.length - inter;
        return union === 0 ? 0 : inter / union;
    }

    function _durationSimilarity(durA, durB) {
        if (!durA || !durB || durA <= 0 || durB <= 0) return 0;
        var diff = Math.abs(durA - durB) / Math.max(durA, durB);
        var threshold = CFG.DURATION_PROXIMITY;
        if (diff >= threshold) return 0;
        return 1 - (diff / threshold);
    }

    // ============================================================
    // SECCIÓN 9 — MOTOR DE EMBEDDINGS OLLAMA
    // ============================================================

    /**
     * Construye el texto de entrada para el embedding de un vídeo.
     * Combina nombre, etiquetas y contexto de subtítulo si disponible.
     */
    function _buildEmbedText(video) {
        var parts = [];

        // Nombre del archivo (normalizado)
        var name = video.name || (video.file && video.file.name) || '';
        if (name) {
            var tokens = _tokenizeName(name);
            if (tokens.length > 0) parts.push(tokens.join(' '));
        }

        // Etiquetas IA
        var tags = _getTagObjects(video);
        if (tags.length > 0) {
            var tagStr = tags.map(function (t) { return t.value; }).join(', ');
            parts.push(tagStr);
        }

        // Subtítulos (si disponibles en VP.etiquetasIA o vpSubtitleCues del vídeo actual)
        try {
            if (VP.etiquetasIA && typeof VP.etiquetasIA.getTagsForVideo === 'function') {
                // No hay API de subtítulos por video en el módulo público; omitir
            }
            // Subtítulos del vídeo actual si coincide
            var ci = VP.estado && VP.estado.currentVideoIndex;
            var pl = VP.estado && VP.estado.playlist;
            if (typeof ci === 'number' && pl && pl[ci] && String(pl[ci].id) === String(video.id)) {
                var cues = window.vpSubtitleCues;
                if (Array.isArray(cues) && cues.length > 0) {
                    var sampleLines = [];
                    var step = Math.max(1, Math.floor(cues.length / 20));
                    for (var c = 0; c < cues.length; c += step) {
                        if (cues[c] && cues[c].texto) {
                            sampleLines.push(cues[c].texto);
                        }
                    }
                    if (sampleLines.length > 0) {
                        parts.push(sampleLines.join(' '));
                    }
                }
            }
        } catch (_) {}

        var text = parts.join('. ');
        if (text.length > CFG.EMBED_MAX_TEXT_CHARS) {
            text = text.slice(0, CFG.EMBED_MAX_TEXT_CHARS);
        }
        return text.trim();
    }

    /**
     * Clave estable para embeddings: usa el nombre del archivo + modelo activo.
     * Incluir el modelo evita servir vectores de un modelo distinto al configurado.
     */
    function _embedKey(video, modelName) {
        if (!video) return '';
        var name  = video.name || (video.file && video.file.name) || String(video.id);
        var model = modelName || CFG.EMBEDDING_MODEL || 'default';
        return name + '||' + model;
    }

    /** Valida vectores completos, también cuando provienen de una caché persistida. */
    function _isValidEmbedding(vec) {
        var isTypedArray = typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(vec);
        if (!vec || (!Array.isArray(vec) && !isTypedArray) || vec.length < 64) return false;
        for (var i = 0; i < vec.length; i++) {
            if (typeof vec[i] !== 'number' || !isFinite(vec[i])) return false;
        }
        return true;
    }

    function _scheduleOllamaRetry(delay) {
        if (_s._destroyed || _s._ollamaCheckTimer) return;
        _s._ollamaCheckTimer = _s._guard.setTimeout(function () {
            _s._ollamaCheckTimer = null;
            _s._ollamaChecked = false;
            _s._ollamaChecking = false;
            _checkOllamaAvailability();
        }, delay);
    }

    /**
     * Comprueba si Ollama está disponible en la URL configurada.
     * Actualiza _s._ollamaAvailable.
     */
    function _checkOllamaAvailability() {
        if (_s._destroyed) return;
        if (_s._ollamaChecked || _s._ollamaChecking) return;
        if (!VP.ollama || typeof VP.ollama.fetchModels !== 'function') {
            _s._ollamaAvailable = false;
            _s._embeddingModelAvailable = false;
            _s._ollamaChecked = true;
            _s._ollamaChecking = false;
            _updateEmbedStatusUI();
            _updateStatsUI();
            return;
        }
        _s._ollamaChecking = true;
        var checkEpoch = ++_s._ollamaCheckEpoch;
        var controller = _s._guard.createController();
        if (!controller) { _s._ollamaChecking = false; return; }

        var availabilityPromise;
        try {
            availabilityPromise = VP.ollama.fetchModels(CFG.OLLAMA_URL, {
                cache: false,
                retries: 0,
                timeout: 2000,
                signal: controller.signal
            });
        } catch (checkError) {
            availabilityPromise = Promise.reject(checkError);
        }
        Promise.resolve(availabilityPromise)
            .then(function (models) {
                if (_s._destroyed || checkEpoch !== _s._ollamaCheckEpoch) return;
                _s._ollamaChecking = false;
                _s._ollamaAvailable = true;
                _s._ollamaChecked = true;
                _s._ollamaRetryCount = 0;
                var wantedModel = String(CFG.EMBEDDING_MODEL || '').trim().toLowerCase();
                _s._embeddingModelAvailable = (models || []).some(function (name) {
                    return String(name || '').trim().toLowerCase() === wantedModel;
                });
                if (!_s._embeddingModelAvailable) {
                    log.warnGrouped('ollama-embedding-model-missing:' + CFG.EMBEDDING_MODEL,
                        'Ollama está disponible, pero no encontró el modelo de embeddings:', CFG.EMBEDDING_MODEL);
                    _updateEmbedStatusUI();
                    _updateStatsUI();
                    return;
                }
                log.info('Ollama disponible en:', CFG.OLLAMA_URL);
                _updateEmbedStatusUI();
                _updateStatsUI();
                // Start only work explicitly queued by the user or an active request.
                if (_s._embedQueue.length > 0 && !_s._embedRunning) _startEmbedBg();
                else log.debug('Embeddings globales bajo demanda; se omite precarga automática.');
            })
            .catch(function (err) {
                if (_s._destroyed || checkEpoch !== _s._ollamaCheckEpoch) return;
                _s._ollamaChecking = false;
                if (err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'TIMEOUT')) {
                    log.debug('Ollama check timeout — no disponible');
                } else if (!_s._ollamaChecked) {
                    try {
                        if (typeof VP.ui.mostrarNotificacion === 'function') {
                            VP.ui.mostrarNotificacion('Ollama no disponible. Las funciones de IA requieren Ollama en ' + CFG.OLLAMA_URL, 'advertencia');
                        }
                    } catch (_) {}
                }
                _s._ollamaAvailable = false;
                _s._ollamaChecked = true;
                _updateEmbedStatusUI();
                _updateStatsUI();

                // Reintentar automáticamente si hay vídeos cargados (fallo transitorio en hard refresh)
                if (VP.estado && VP.estado.videos && VP.estado.videos.length > 0) {
                    var retryCount = _s._ollamaRetryCount || 0;
                    if (retryCount < 3) {
                        _s._ollamaRetryCount = retryCount + 1;
                        var delay = 3000 * _s._ollamaRetryCount;
                        log.info('Reintentando verificar Ollama en ' + delay + 'ms (intento ' + _s._ollamaRetryCount + '/3)');
                        _scheduleOllamaRetry(delay);
                    }
                }
            })
            .finally(function () { _s._guard.releaseController(controller); });
    }

    /**
     * Llama al endpoint Ollama /api/embed y retorna el vector.
     * Implementa retry con backoff exponencial.
     * @returns {Promise<number[]|null>}
     */
    function _fetchEmbedding(text, attempt, modelName, epoch) {
        attempt = attempt || 0;
        modelName = modelName || CFG.EMBEDDING_MODEL;
        epoch = typeof epoch === 'number' ? epoch : _s._embeddingEpoch;
        if (!text || !text.trim()) return Promise.resolve(null);
        if (_s._destroyed || epoch !== _s._embeddingEpoch) return Promise.resolve(null);
        if (_s._ollamaAvailable !== true || _s._embeddingModelAvailable === false) return Promise.resolve(null);

        var controller = null;
        var promise;

        try {
            controller = _s._guard.createController();
            if (!controller) return Promise.resolve(null);
            promise = VP.ollama.embed(CFG.OLLAMA_URL, modelName, text, {
                timeout: CFG.EMBED_TIMEOUT_MS,
                signal: controller.signal
            });
        } catch (e) {
            if (controller && typeof _s._guard.releaseController === 'function') _s._guard.releaseController(controller);
            return Promise.resolve(null);
        }

        var trackedPromise = promise
            .then(function (embeddings) {
                if (_s._destroyed || epoch !== _s._embeddingEpoch) return null;
                if (!embeddings || !_isValidEmbedding(embeddings[0])) {
                    throw new Error('Embedding inválido recibido de Ollama');
                }
                _s._ollamaAvailable = true;
                _s._embeddingModelAvailable = true;
                return embeddings[0];
            })
            .catch(function (err) {
                if (_s._destroyed || epoch !== _s._embeddingEpoch) return null;

                // Error de red → Ollama no disponible inmediatamente
                if (err && (err.message === 'Failed to fetch' || err.name === 'TypeError')) {
                    _s._ollamaAvailable = false;
                    _s._embeddingModelAvailable = null;
                    _s._ollamaChecked = false;
                    log.warnGrouped('ollama-embedding-unavailable:' + err.message,
                        'Embedding: Ollama no disponible —', err.message);
                    _updateEmbedStatusUI();
                    _updateStatsUI();
                    _scheduleOllamaRetry(3000);
                    return null;
                }
                if (err && err.code === 'MODEL_NOT_FOUND') {
                    _s._embeddingModelAvailable = false;
                    _s._ollamaChecked = false;
                    _updateEmbedStatusUI();
                    _updateStatsUI();
                    _scheduleOllamaRetry(10000);
                    log.warnGrouped('ollama-embedding-model-missing:' + modelName,
                        'No se encontró el modelo de embeddings configurado:', modelName);
                    return null;
                }

                var retryable = !VP.ollama || typeof VP.ollama.isRetryableError !== 'function' || VP.ollama.isRetryableError(err);
                if (!retryable) {
                    var rejectedMessage = err && err.message ? err.message : String(err);
                    log.warnGrouped('ollama-embedding-rejected:' + rejectedMessage,
                        'Embedding rechazado por Ollama; se omiten reintentos:', rejectedMessage);
                    return null;
                }

                if (attempt < CFG.EMBED_MAX_RETRIES) {
                    // Revalidar estado antes de reintentar
                    if (_s._ollamaAvailable === false || _s._destroyed) return null;
                    var delay = CFG.EMBED_RETRY_BASE_MS * Math.pow(2, attempt);
                    log.warnGrouped('ollama-embedding-retry:' + (err && err.message || String(err)),
                        'Embedding reintento', attempt + 1, 'en', delay + 'ms —', err.message);
                    return new Promise(function (res) {
                        setTimeout(function () {
                            _fetchEmbedding(text, attempt + 1, modelName, epoch).then(res);
                        }, delay);
                    });
                }
                log.warnGrouped('ollama-embedding-failed:' + (err && err.message || String(err)),
                    'Embedding falló definitivamente:', err.message);
                return null;
            })
            .finally(function () { _s._guard.releaseController(controller); });
        return _s._guard.track(trackedPromise);
    }

    /**
     * Obtiene el embedding de un vídeo.
     * Flujo: LRU → IDB → Ollama.
     * @param {Object} video
     * @returns {Promise<number[]|null>}
     */
    function _getEmbedding(video) {
        if (!video) return Promise.resolve(null);
        var modelName = CFG.EMBEDDING_MODEL;
        var epoch = _s._embeddingEpoch;
        var key = _embedKey(video, modelName);
        var keyEpoch = _s._embedKeyEpochs[key] || 0;
        var bypassPersistent = !!_s._invalidatedEmbedKeys[key];

        // 1. LRU
        var cached = _embedLRU.get(key);
        if (cached) return Promise.resolve(cached);

        // 2. Caché keyval
        var lsVec = bypassPersistent ? null : _loadEmbeddingLS(key);
        if (lsVec) {
            _embedLRU.set(key, lsVec);
            _updateEmbedStatusUI();
            _updateStatsUI();
            return Promise.resolve(lsVec);
        }

        // 3. In-flight dedup: si ya hay una petición para esta clave, reusarla
        if (_s._pendingEmbeds[key]) {
            if (VP.metricas) VP.metricas.embeddingsDuplicados = (VP.metricas.embeddingsDuplicados || 0) + 1;
            return _s._pendingEmbeds[key];
        }

        // 4. IDB
        var p = _loadEmbeddingIDB(key).then(function (idbVec) {
            if (_s._destroyed || epoch !== _s._embeddingEpoch || keyEpoch !== (_s._embedKeyEpochs[key] || 0)) return null;
            if (!bypassPersistent && idbVec) {
                _embedLRU.set(key, idbVec);
                _persistEmbeddingLS(key, idbVec);
                return idbVec;
            }
            // 5. Ollama
            var text = _buildEmbedText(video);
            if (!text) return null;
            return _fetchEmbedding(text, 0, modelName, epoch).then(function (vec) {
                if (_s._destroyed || epoch !== _s._embeddingEpoch || keyEpoch !== (_s._embedKeyEpochs[key] || 0)) return null;
                if (vec) {
                    delete _s._invalidatedEmbedKeys[key];
                    _embedLRU.set(key, vec);
                    _persistEmbeddingLS(key, vec);
                    _persistEmbeddingIDB(key, vec);
                    _embedIndex.add(key);
                }
                return vec;
            });
        }).finally(function () {
            if (_s._pendingEmbeds[key] === p) delete _s._pendingEmbeds[key];
            _updateEmbedStatusUI();
            _updateStatsUI();
        });

        _s._pendingEmbeds[key] = p;
        _updateEmbedStatusUI();
        return p;
    }

    // ============================================================
    // SECCIÓN 10 — SIMILITUD COSENO
    // ============================================================

    /**
     * Similitud coseno entre dos vectores de igual dimensión.
     * Retorna 0 si alguno es nulo o la norma es 0.
     */
    function _cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        var normaA = _obtenerNormaCuadrada(vecA);
        var normaB = _obtenerNormaCuadrada(vecB);
        if (normaA === null || normaB === null) return 0;

        var dot    = 0;
        for (var i = 0; i < vecA.length; i++) {
            dot   += vecA[i] * vecB[i];
        }
        var denom = Math.sqrt(normaA) * Math.sqrt(normaB);
        if (!isFinite(denom) || denom === 0 || !isFinite(dot)) return 0;
        var similarity = dot / denom;
        if (!isFinite(similarity)) return 0;
        // Clampear a [0,1] — coseno normalizado
        return Math.max(0, Math.min(1, (similarity + 1) / 2));
    }

    // ============================================================
    // SECCIÓN 11 — SIMILITUD COMBINADA MULTIDIMENSIONAL
    // ============================================================

    /**
     * Calcula la similitud combinada entre dos vídeos usando
     * todas las dimensiones disponibles.
     *
     * @param {Object}         videoA
     * @param {Object}         videoB
     * @param {number[]|null}  vecA   — embedding de A (null si no disponible)
     * @param {number[]|null}  vecB   — embedding de B (null si no disponible)
     * @returns {{score, tagScore, semanticScore, nameScore, durScore, collabScore, reasons, hasTags, hasEmbeddings}}
     */
    function _computeSimilarity(videoA, videoB, vecA, vecB, tagsAData, tagsBData) {
        var tagsA = tagsAData || _getTagObjects(videoA);
        var tagsB = tagsBData || _getTagObjects(videoB);
        var hasTags     = (tagsA.length > 0 && tagsB.length > 0);
        var hasEmbeddings = (Array.isArray(vecA) && vecA.length > 0 &&
                             Array.isArray(vecB) && vecB.length > 0);

        var tagScore      = hasTags      ? _weightedJaccard(tagsA, tagsB)        : 0;
        var semanticScore = hasEmbeddings ? _cosineSimilarity(vecA, vecB)         : 0;
        var nameScore     = _nameSimilarity(videoA, videoB);
        var durScore      = _durationSimilarity(videoA.duration || 0, videoB.duration || 0);
        var collabScore   = _clicks.getScore(videoA.id, videoB.id);

        var combined;

        if (hasTags && hasEmbeddings) {
            combined =
                tagScore      * CFG.TAG_WEIGHT      +
                semanticScore * CFG.SEMANTIC_WEIGHT  +
                nameScore     * CFG.NAME_WEIGHT      +
                durScore      * CFG.DURATION_WEIGHT;
        } else if (hasEmbeddings && !hasTags) {
            combined =
                semanticScore * CFG.NONTAG_SEMANTIC_WEIGHT +
                nameScore     * CFG.NONTAG_NAME_WEIGHT     +
                durScore      * CFG.NONTAG_DURATION_WEIGHT;
        } else if (hasTags && !hasEmbeddings) {
            combined =
                tagScore  * CFG.NOTAG_EMBED_TAG_WEIGHT  +
                nameScore * CFG.NOTAG_EMBED_NAME_WEIGHT  +
                durScore  * CFG.NOTAG_EMBED_DUR_WEIGHT;
        } else {
            // Fallback puro: nombre + duración
            combined =
                nameScore * CFG.FALLBACK_NAME_WEIGHT     +
                durScore  * CFG.FALLBACK_DURATION_WEIGHT;
        }

        // Boost colaborativo (aditivo, limitado)
        if (collabScore > 0) {
            combined = Math.min(1, combined + collabScore * CFG.COLLAB_WEIGHT);
        }

        var reasons = [];
        if (semanticScore > 0) reasons.push('semántica:' + (semanticScore * 100).toFixed(0) + '%');
        if (tagScore      > 0) reasons.push('etiquetas:' + (tagScore      * 100).toFixed(0) + '%');
        if (nameScore     > 0) reasons.push('nombre:'    + (nameScore     * 100).toFixed(0) + '%');
        if (durScore      > 0) reasons.push('duración:'  + (durScore      * 100).toFixed(0) + '%');
        if (collabScore   > 0) reasons.push('popular:'   + (collabScore   * 100).toFixed(0) + '%');
        if (!hasTags && !hasEmbeddings) reasons.push('solo-texto');

        return {
            score         : combined,
            tagScore      : tagScore,
            semanticScore : semanticScore,
            nameScore     : nameScore,
            durScore      : durScore,
            collabScore   : collabScore,
            reasons       : reasons,
            hasTags       : hasTags,
            hasEmbeddings : hasEmbeddings,
        };
    }

    // ============================================================
    // SECCIÓN 12 — MMR (MAXIMAL MARGINAL RELEVANCE)
    // ============================================================

    /**
     * Re-ranking MMR para maximizar relevancia y minimizar
     * redundancia entre las recomendaciones seleccionadas.
     * Usa embeddings si disponibles, fallback a Jaccard.
     */
    function _mmrRerank(candidates, k, lambda) {
        if (!candidates || candidates.length === 0) return [];
        lambda = (lambda === undefined) ? CFG.MMR_LAMBDA : lambda;

        // MMR solo compara candidatos del pool, no requiere recorrer toda la biblioteca.
        var embedMap = {};
        var tagsMap  = {};
        for (var i = 0; i < candidates.length; i++) {
            var candidate = candidates[i];
            var vid = String(candidate.videoId);
            tagsMap[vid] = candidate._mmrTags || [];
            if (candidate._mmrEmbedding) embedMap[vid] = candidate._mmrEmbedding;
        }

        function simBetween(idA, idB) {
            var vecA = embedMap[String(idA)];
            var vecB = embedMap[String(idB)];
            if (vecA && vecB) return _cosineSimilarity(vecA, vecB);
            var tA = tagsMap[String(idA)] || [];
            var tB = tagsMap[String(idB)] || [];
            return _weightedJaccard(tA, tB);
        }

        var selected  = [];
        var remaining = candidates.slice();

        while (selected.length < k && remaining.length > 0) {
            var bestIdx = -1;
            var bestVal = -Infinity;

            for (var r = 0; r < remaining.length; r++) {
                var cand      = remaining[r];
                var relevance = cand.score;
                var maxSim    = 0;
                for (var s = 0; s < selected.length; s++) {
                    var sim = simBetween(cand.videoId, selected[s].videoId);
                    if (sim > maxSim) maxSim = sim;
                }
                var mmrScore = lambda * relevance - (1 - lambda) * maxSim;
                if (mmrScore > bestVal) { bestVal = mmrScore; bestIdx = r; }
            }

            if (bestIdx < 0) break;
            selected.push(remaining[bestIdx]);
            remaining.splice(bestIdx, 1);
        }

        return selected;
    }

    // ============================================================
    // SECCIÓN 13 — CÁLCULO DE RECOMENDACIONES
    // ============================================================

    function _findVideoById(vidId) {
        var videos = VP.estado.videos || [];
        for (var i = 0; i < videos.length; i++) {
            if (String(videos[i].id) === String(vidId)) return videos[i];
        }
        return null;
    }

    function _esVideoValido(v) {
        if (!v) return false;
        if (!v.id && v.id !== 0) return false;
        if (!v.name) return false;
        if (v.hidden || v.deleted || v.disabled) return false;
        return true;
    }

    function _selectRecommendationCandidates(targetVideo, vidId, vecTarget, tagsTarget, maxResults) {
        var allVideos = VP.estado.videos || [];
        var ranked = [];
        var desired = Math.max(40, maxResults * 6);
        var limit = Math.max(maxResults, Math.min(CFG.MAX_RECOMMENDATION_CANDIDATES, desired));

        for (var i = 0; i < allVideos.length; i++) {
            var video = allVideos[i];
            if (String(video && video.id) === String(vidId) || !_esVideoValido(video)) continue;

            var tags = _getTagObjects(video);
            var embedding = _embedLRU.get(_embedKey(video)) || null;
            var score = _computeSimilarity(targetVideo, video, vecTarget, embedding, tagsTarget, tags).score;
            ranked.push({ video: video, score: score, order: i });
        }

        ranked.sort(function (a, b) {
            return b.score - a.score || a.order - b.order;
        });

        var candidates = [];
        for (var c = 0; c < ranked.length && c < limit; c++) {
            candidates.push(ranked[c].video);
        }
        return candidates;
    }

    /**
     * Cómputo sincrónico con embeddings ya disponibles en LRU.
     * Para embeddings pendientes se usa el modo asíncrono.
     */
    function _computeForVideoSync(vidId, opts, candidateVideos) {
        opts = opts || {};
        var maxResults = opts.maxResults || CFG.MAX_RECOMENDACIONES;

        var targetVideo = _findVideoById(vidId);
        if (!targetVideo) { log.warn('computeForVideo: vídeo no encontrado:', vidId); return []; }

        var targetKey = _embedKey(targetVideo);
        var vecTarget = _embedLRU.get(targetKey) || _loadEmbeddingLS(targetKey) || null;
        if (vecTarget && !_embedLRU.has(targetKey)) _embedLRU.set(targetKey, vecTarget);
        var tagsTarget = _getTagObjects(targetVideo);

        var candidates = Array.isArray(candidateVideos)
            ? candidateVideos
            : _selectRecommendationCandidates(targetVideo, vidId, vecTarget, tagsTarget, maxResults);
        var rawResults = [];

        for (var i = 0; i < candidates.length; i++) {
            var v = candidates[i];
            if (String(v.id) === String(vidId)) continue;
            if (!_esVideoValido(v)) continue;

            var vKey   = _embedKey(v);
            var vecV   = _embedLRU.get(vKey) || _loadEmbeddingLS(vKey) || null;
            if (vecV && !_embedLRU.has(vKey)) _embedLRU.set(vKey, vecV);
            var tagsV  = _getTagObjects(v);
            var sim    = _computeSimilarity(targetVideo, v, vecTarget, vecV, tagsTarget, tagsV);

            if (sim.score >= CFG.MIN_SIMILARITY) {
                rawResults.push({
                    videoId       : v.id,
                    name          : v.name || '',
                    score         : sim.score,
                    tagScore      : sim.tagScore,
                    semanticScore : sim.semanticScore,
                    nameScore     : sim.nameScore,
                    durScore      : sim.durScore,
                    collabScore   : sim.collabScore,
                    reasons       : sim.reasons,
                    duration      : v.duration || 0,
                    thumbnail     : v.thumbnail || null,
                    hasTags       : sim.hasTags,
                    hasEmbeddings : sim.hasEmbeddings,
                    tags          : tagsV.map(function (t) { return t.value; }),
                    _mmrTags      : tagsV,
                    _mmrEmbedding : vecV,
                });
            }
        }

        rawResults.sort(function (a, b) { return b.score - a.score; });

        var pool = rawResults.slice(0, Math.max(maxResults * 5, 50));
        var top  = opts.skipMMR ? pool.slice(0, maxResults) : _mmrRerank(pool, Math.min(maxResults, pool.length), CFG.MMR_LAMBDA);
        for (var ti = 0; ti < top.length; ti++) {
            delete top[ti]._mmrTags;
            delete top[ti]._mmrEmbedding;
        }

        var cacheData = { recoms: top, computedAt: Date.now() };
        _cacheLRU.set(String(vidId), cacheData);
        _persistToLocalStorage(String(vidId), cacheData);
        _index.add(String(vidId));
        _persistToIndexedDB(String(vidId), cacheData);

        log.info(
            'Recomendaciones para "' + targetVideo.name + '":',
            top.length, 'resultados',
            '(pool:', rawResults.length + ')',
            '| embeddings:', vecTarget ? 'SÍ' : 'NO'
        );
        return top;
    }

    /**
     * Cómputo asíncrono: espera a que se obtengan los embeddings
     * del vídeo objetivo y de los candidatos más relevantes por
     * nombre antes de calcular similitud final.
     */
    function _computeForVideoAsync(vidId, opts) {
        opts = opts || {};
        var maxResults = opts.maxResults || CFG.MAX_RECOMENDACIONES;
        var recommendationEpoch = _s._recommendationEpoch;

        var targetVideo = _findVideoById(vidId);
        if (!targetVideo) return Promise.resolve([]);

        function esperarEstadoOllama() {
            if (_s._ollamaAvailable !== null || _s._ollamaChecked || _s._destroyed) {
                return Promise.resolve();
            }
            if (!_s._ollamaChecking) _checkOllamaAvailability();
            return new Promise(function (resolve) {
                var intentos = 0;
                function comprobar() {
                    if (_s._ollamaAvailable !== null || _s._ollamaChecked ||
                            _s._destroyed || intentos++ >= 30) {
                        resolve();
                        return;
                    }
                    setTimeout(comprobar, 100);
                }
                comprobar();
            });
        }

        return esperarEstadoOllama().then(function () {
            return _getEmbedding(targetVideo);
        }).then(function (vecTarget) {
            if (_s._destroyed || recommendationEpoch !== _s._recommendationEpoch) return [];
            var tagsTarget = _getTagObjects(targetVideo);
            var candidates = _selectRecommendationCandidates(
                targetVideo, vidId, vecTarget, tagsTarget, maxResults
            );
            var embeddingCandidates = candidates.slice(
                0,
                Math.max(1, Number(CFG.MAX_RECOMMENDATION_EMBEDDINGS) || 24)
            );

            // Limitar solicitudes desde el inicio para no saturar Ollama.
            var BATCH = Math.max(1, Math.floor(Number(CFG.MAX_EMBED_CONCURRENCY) || 1));
            function resolveBatch(start) {
                if (start >= embeddingCandidates.length) return Promise.resolve();
                var lote = embeddingCandidates.slice(start, start + BATCH).map(function (candidate) {
                    return _getEmbedding(candidate);
                });
                return Promise.all(lote).then(function () {
                    return resolveBatch(start + BATCH);
                });
            }

            return resolveBatch(0).then(function () {
                if (_s._destroyed || recommendationEpoch !== _s._recommendationEpoch) return [];
                return _computeForVideoSync(vidId, opts, candidates);
            });
        });
    }

    function _getRecomendaciones(vidId, maxResults) {
        if (!vidId) return [];
        var strId = String(vidId);

        var cached = _cacheLRU.get(strId);
        if (cached && cached.recoms) {
            log.debug('getRecomendaciones: LRU hit para', strId);
            return cached.recoms.slice(0, maxResults || CFG.MAX_RECOMENDACIONES);
        }

        var lsData = _loadFromLocalStorage(strId);
        if (lsData && lsData.recoms && lsData.recoms.length > 0) {
            if (Date.now() - (lsData.computedAt || 0) <= CFG.CACHE_TTL_MS) {
                _cacheLRU.set(strId, lsData);
                log.debug('getRecomendaciones: LS hit para', strId);
                return lsData.recoms.slice(0, maxResults || CFG.MAX_RECOMENDACIONES);
            }
            log.debug('getRecomendaciones: LS expirado para', strId);
        }

        return _computeForVideoSync(strId, { maxResults: maxResults });
    }

    function _getFreshCachedRecommendations(vidId) {
        var key = String(vidId);
        var cached = _cacheLRU.get(key);
        if (!cached || !Array.isArray(cached.recoms)) {
            cached = _loadFromLocalStorage(key);
        }
        if (!cached || !Array.isArray(cached.recoms) ||
                Date.now() - (cached.computedAt || 0) > CFG.CACHE_TTL_MS) return null;

        _cacheLRU.set(key, cached);
        return cached.recoms.slice(0, CFG.MAX_RECOMENDACIONES);
    }

    // ============================================================
    // SECCIÓN 14 — PERSISTENCIA DE RECOMENDACIONES
    // ============================================================

    function _persistToLocalStorage(vidId, data) {
        try {
            var compact = {
                v: CFG.CACHE_VERSION,
                r: data.recoms.map(function (rec) {
                    return [
                        String(rec.videoId),
                        rec.name        || '',
                        Math.round((rec.score         || 0) * 10000) / 10000,
                        rec.reasons     ? rec.reasons.slice(0, 6) : [],
                        rec.duration    || 0,
                        rec.thumbnail   || '',
                        rec.hasTags     ? 1 : 0,
                        Math.round((rec.semanticScore || 0) * 10000) / 10000,
                        rec.hasEmbeddings ? 1 : 0,
                        rec.tags        ? rec.tags.slice(0, 6) : [],
                    ];
                }),
                t: data.computedAt,
            };
            util.storageSet(CFG.STORAGE_PREFIX + vidId, compact);
        } catch (e) {
            log.warn('persistToLocalStorage falló para', vidId, e);
        }
    }

    function _loadFromLocalStorage(vidId) {
        try {
            var raw = util.storageGet(CFG.STORAGE_PREFIX + vidId, null);
            if (!raw || raw.v !== CFG.CACHE_VERSION || !raw.r) return null;
            return {
                recoms: raw.r.map(function (item) {
                    return {
                        videoId       : item[0],
                        name          : item[1],
                        score         : item[2],
                        reasons       : item[3] || [],
                        duration      : item[4] || 0,
                        thumbnail     : item[5] || null,
                        hasTags       : item[6] !== 0,
                        semanticScore : item[7] || 0,
                        hasEmbeddings : item[8] !== 0,
                        tags          : item[9] || [],
                    };
                }),
                computedAt: raw.t || 0,
            };
        } catch (_) { return null; }
    }

    function _persistToIndexedDB(vidId, data) {
        if (!VP.db || typeof VP.db.guardarMetadatos !== 'function') return;
        var metaObj = {};
        metaObj[CFG.IDB_META_KEY] = {
            version    : CFG.CACHE_VERSION,
            computedAt : data.computedAt,
            recoms     : data.recoms.map(function (rec) {
                return {
                    videoId       : rec.videoId,
                    name          : rec.name,
                    score         : rec.score,
                    reasons       : rec.reasons,
                    duration      : rec.duration,
                    thumbnail     : rec.thumbnail,
                    hasTags       : rec.hasTags,
                    semanticScore : rec.semanticScore,
                    hasEmbeddings : rec.hasEmbeddings,
                    tags          : rec.tags,
                };
            }),
        };
        VP.db.guardarMetadatos(vidId, metaObj).catch(function (err) {
            log.warn('persistToIndexedDB falló para', vidId, err);
        });
    }

    function _loadFromIndexedDB(vidId) {
        if (!VP.db || typeof VP.db.obtenerMetadatos !== 'function') return Promise.resolve(null);
        return VP.db.obtenerMetadatos(vidId).then(function (meta) {
            if (meta && meta[CFG.IDB_META_KEY]) {
                var data = meta[CFG.IDB_META_KEY];
                if (data.version !== CFG.CACHE_VERSION) return null;
                if (Date.now() - (data.computedAt || 0) > CFG.CACHE_TTL_MS) return null;
                return { recoms: data.recoms || [], computedAt: data.computedAt || 0 };
            }
            return null;
        }).catch(function () { return null; });
    }

    // ============================================================
    // SECCIÓN 15 — PERSISTENCIA DE EMBEDDINGS
    // ============================================================

    function _persistEmbeddingLS(key, vec) {
        if (!key || !_isValidEmbedding(vec)) return;
        _embedIndex.add(key);
        try {
            var compact = {
                v  : CFG.EMBED_CACHE_VERSION,
                vec: Array.prototype.slice.call(vec),
                ts : Date.now(),
            };
            util.storageSet(CFG.EMBED_STORAGE_PREFIX + key, compact);
        } catch (e) {
            log.warn('persistEmbeddingLS falló para', key, e);
        }
    }

    function _loadEmbeddingLS(key) {
        try {
            var raw = util.storageGet(CFG.EMBED_STORAGE_PREFIX + key, null);
            if (!raw || raw.v !== CFG.EMBED_CACHE_VERSION || !_isValidEmbedding(raw.vec)) return null;
            if (typeof raw.ts !== 'number' || !isFinite(raw.ts) || raw.ts <= 0 || Date.now() - raw.ts > CFG.EMBED_CACHE_TTL_MS || raw.ts > Date.now() + 60000) return null;
            return raw.vec;
        } catch (_) { return null; }
    }

    function _persistEmbeddingIDB(key, vec) {
        if (!key || !_isValidEmbedding(vec) || !VP.db || typeof VP.db.guardarMetadatos !== 'function') return;
        var metaObj = {};
        metaObj[CFG.IDB_EMBED_META_KEY] = {
            version : CFG.EMBED_CACHE_VERSION,
            vec     : vec,
            ts      : Date.now(),
        };
        VP.db.guardarMetadatos(key, metaObj).catch(function (err) {
            log.warn('persistEmbeddingIDB falló para', key, err);
        });
    }

    function _loadEmbeddingIDB(key) {
        if (!VP.db || typeof VP.db.obtenerMetadatos !== 'function') return Promise.resolve(null);
        return VP.db.obtenerMetadatos(key).then(function (meta) {
            if (meta && meta[CFG.IDB_EMBED_META_KEY]) {
                var data = meta[CFG.IDB_EMBED_META_KEY];
                if (data.version !== CFG.EMBED_CACHE_VERSION) return null;
                if (typeof data.ts !== 'number' || !isFinite(data.ts) || data.ts <= 0 || Date.now() - data.ts > CFG.EMBED_CACHE_TTL_MS || data.ts > Date.now() + 60000) return null;
                return _isValidEmbedding(data.vec) ? data.vec : null;
            }
            return null;
        }).catch(function () { return null; });
    }

    // ============================================================
    // SECCIÓN 16 — PRECARGA Y COLA DE CÓMPUTO BG
    // ============================================================

    function _cancelPreloadWork() {
        _s._preloadRun++;
        if (_s._preloadChunkTimer !== null) clearTimeout(_s._preloadChunkTimer);
        if (_s._preloadIdleHandle !== null && typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(_s._preloadIdleHandle);
        }
        _s._preloadChunkTimer = null;
        _s._preloadIdleHandle = null;
    }

    function _preloadAll() {
        if (_s._preloaded) return;
        _cancelPreloadWork();
        _s._preloaded = true;
        var preloadRun = _s._preloadRun;
        var recommendationEpoch = _s._recommendationEpoch;
        var keys = _index.getAll();
        var removals = [];
        var cursor = 0;
        var cargados = 0;
        var expirados = 0;
        log.info('Precargando recomendaciones:', keys.length, 'vídeos');

        function procesarLote() {
            if (preloadRun !== _s._preloadRun) return;
            _s._preloadChunkTimer = null;
            _s._preloadIdleHandle = null;
            if (_s._destroyed || recommendationEpoch !== _s._recommendationEpoch) return;

            var fin = Math.min(cursor + 25, keys.length);
            for (; cursor < fin; cursor++) {
                var key = keys[cursor];
                if (_cacheLRU.has(key)) continue;
                var ls = _loadFromLocalStorage(key);
                if (ls && ls.recoms) {
                    if (Date.now() - (ls.computedAt || 0) <= CFG.CACHE_TTL_MS) {
                        _cacheLRU.set(key, ls);
                        cargados++;
                    } else {
                        removals.push(key);
                        expirados++;
                    }
                } else {
                    removals.push(key);
                }
            }

            if (cursor < keys.length) {
                if (typeof window.requestIdleCallback === 'function') {
                    _s._preloadIdleHandle = window.requestIdleCallback(procesarLote, { timeout: 500 });
                } else {
                    _s._preloadChunkTimer = setTimeout(procesarLote, 0);
                }
                return;
            }

            _index.removeMany(removals);
            log.info('Precarga REC: ' + cargados + ' cargados, ' + expirados + ' expirados');
            _preloadFromIndexedDB(keys, recommendationEpoch);
        }

        if (typeof window.requestIdleCallback === 'function') {
            _s._preloadIdleHandle = window.requestIdleCallback(procesarLote, { timeout: 500 });
        } else {
            _s._preloadChunkTimer = setTimeout(procesarLote, 0);
        }
    }

    /**
     * Precarga embeddings desde IndexedDB para los vídeos que no
     * pudieron cargarse desde el almacenamiento (cuota agotada, limpieza
     * del browser, etc.).  Actualiza LS desde IDB cuando lo encuentra.
     */
    function _preloadEmbeddingsIDB() {
        if (!VP.db || typeof VP.db.obtenerMetadatos !== 'function') return Promise.resolve();
        if (!_backgroundWorkAllowed()) return Promise.resolve();
        var allVideos = VP.estado && VP.estado.videos;
        if (!allVideos || allVideos.length === 0) return Promise.resolve();
        if (allVideos.length > 200) return Promise.resolve();

        var pendientes = [];
        for (var i = 0; i < allVideos.length; i++) {
            var v = allVideos[i];
            if (!_esVideoValido(v)) continue;
            var key = _embedKey(v);
            if (!_embedLRU.has(key)) pendientes.push(key);
        }
        if (pendientes.length === 0) {
            log.debug('Precarga EMB IDB: todos en LRU, nada que cargar.');
            return Promise.resolve();
        }

        log.debug('Precarga EMB IDB: consultando', pendientes.length, 'claves…');
        var loaded = 0;
        var epoch = _s._embeddingEpoch;
        var preloadTimedOut = false;
        var settled = false;
        var preloadTimer = setTimeout(function () {
            preloadTimedOut = true;
            log.warn('Precarga EMB IDB agotó timeout (' + CFG.PRELOAD_TIMEOUT_MS + 'ms), pendientes:', pendientes.length);
            finish();
        }, CFG.PRELOAD_TIMEOUT_MS);

        return new Promise(function (resolve) {
            function finish() {
                if (settled) return;
                settled = true;
                clearTimeout(preloadTimer);
                resolve();
            }

            function procesarLote(inicio) {
                if (settled || preloadTimedOut || _s._destroyed || epoch !== _s._embeddingEpoch) { finish(); return; }
                var LOTE = 10;
                var fin  = Math.min(inicio + LOTE, pendientes.length);
                var promises = [];
                for (var j = inicio; j < fin; j++) {
                    (function (key) {
                        promises.push(
                            _loadEmbeddingIDB(key).then(function (vec) {
                                if (!_s._destroyed && epoch === _s._embeddingEpoch && !_s._invalidatedEmbedKeys[key] && vec && !_embedLRU.has(key)) {
                                    _embedLRU.set(key, vec);
                                    _persistEmbeddingLS(key, vec);
                                    loaded++;
                                }
                            }).catch(function () {})
                        );
                    })(pendientes[j]);
                }
                Promise.all(promises).then(function () {
                    if (settled || preloadTimedOut || _s._destroyed || epoch !== _s._embeddingEpoch) { finish(); return; }
                    if (!preloadTimedOut && fin < pendientes.length) {
                        setTimeout(function () { procesarLote(fin); }, 80);
                    } else if (!preloadTimedOut) {
                        log.info('Precarga EMB IDB: ' + loaded + '/' + pendientes.length + ' vectores recuperados');
                        finish();
                    }
                }).catch(function (e) { log.warn('Error en precarga embeddings:', e.message || e); finish(); });
            }
            procesarLote(0);
        });
    }

    function _preloadFromIndexedDB(keys, recommendationEpoch) {
        if (!VP.db || typeof VP.db.obtenerMetadatos !== 'function') return;
        if (!_backgroundWorkAllowed()) return;
        if ((VP.estado && VP.estado.videos && VP.estado.videos.length > 200) || !keys || keys.length === 0) return;
        recommendationEpoch = typeof recommendationEpoch === 'number' ? recommendationEpoch : _s._recommendationEpoch;
        var pendientes = keys.filter(function (k) { return !_cacheLRU.has(k); });
        if (pendientes.length === 0) return;
        log.debug('Cargando', pendientes.length, 'desde IndexedDB…');

        var preloadTimedOut = false;
        var preloadTimer = setTimeout(function () {
            preloadTimedOut = true;
            log.warn('Precarga IDB agotó timeout (' + CFG.PRELOAD_TIMEOUT_MS + 'ms), pendientes:', pendientes.length);
        }, CFG.PRELOAD_TIMEOUT_MS);

        function procesarLote(inicio) {
            if (preloadTimedOut || _s._destroyed || recommendationEpoch !== _s._recommendationEpoch) {
                clearTimeout(preloadTimer);
                return;
            }
            var lote = 10;
            var fin  = Math.min(inicio + lote, pendientes.length);
            var promises = [];
            for (var i = inicio; i < fin; i++) {
                (function (id) {
                    promises.push(
                        _loadFromIndexedDB(id).then(function (data) {
                            if (!_s._destroyed && recommendationEpoch === _s._recommendationEpoch && data && data.recoms && data.recoms.length > 0) {
                                _cacheLRU.set(id, data);
                                _persistToLocalStorage(id, data);
                            }
                        })
                    );
                })(pendientes[i]);
            }
            if (promises.length > 0) {
                Promise.all(promises).then(function () {
                    if (_s._destroyed || recommendationEpoch !== _s._recommendationEpoch) {
                        clearTimeout(preloadTimer);
                        return;
                    }
                    clearTimeout(preloadTimer);
                    if (!preloadTimedOut && fin < pendientes.length) setTimeout(function () { procesarLote(fin); }, 100);
                }).catch(function (err) {
                    log.warn('Error en preload IDB:', err);
                    if (!preloadTimedOut && fin < pendientes.length) setTimeout(function () { procesarLote(fin); }, 100);
                });
            }
        }
        procesarLote(0);
    }
    function _enqueueBgCompute(vidIds) {
        if (_s._destroyed) return;
        for (var i = 0; i < vidIds.length; i++) {
            var id = String(vidIds[i]);
            if (!_s._bgQueueDedup.has(id) && !_cacheLRU.has(id)) {
                _s._bgQueue.push(id);
                _s._bgQueueDedup.add(id);
            }
        }
        _startBgCompute();
    }

    function _cantidadBgPendiente() {
        return _s._bgQueue.length - _s._bgQueueHead;
    }

    function _limpiarColaBg() {
        _s._bgQueue.length = 0;
        _s._bgQueueHead = 0;
        _s._bgQueueDedup.clear();
    }

    function _compactarColaBg() {
        var head = _s._bgQueueHead;
        var cola = _s._bgQueue;
        if (head >= cola.length) {
            _limpiarColaBg();
        } else if (head >= 128 && head * 2 >= cola.length) {
            _s._bgQueue = cola.slice(head);
            _s._bgQueueHead = 0;
        }
    }

    function _startBgCompute() {
        if (_s._destroyed || _s._bgRunning || _cantidadBgPendiente() === 0) return;
        if (!_backgroundWorkAllowed()) {
            _s._bgRunning = false;
            _s._bgProcessTimer = _s._guard.setTimeout(_startBgCompute, CFG.BG_COMPUTE_DELAY_MS * 2);
            return;
        }
        _s._bgRunning = true;
        _processBgBatch();
    }

    function _processBgBatch() {
        if (_s._destroyed) { _s._bgRunning = false; return; }
        if (!_backgroundWorkAllowed()) {
            _s._bgRunning = false;
            _s._bgProcessTimer = _s._guard.setTimeout(_processBgBatch, CFG.BG_COMPUTE_DELAY_MS * 2);
            return;
        }
        _s._bgProcessTimer = null;
        var inicio = _s._bgQueueHead;
        var fin = Math.min(inicio + CFG.MAX_BG_BATCH, _s._bgQueue.length);
        var batch = _s._bgQueue.slice(inicio, fin);
        _s._bgQueueHead = fin;
        for (var q = 0; q < batch.length; q++) _s._bgQueueDedup.delete(batch[q]);
        _compactarColaBg();
        if (batch.length === 0) { _s._bgRunning = false; return; }
        for (var i = 0; i < batch.length; i++) {
            if (!_cacheLRU.has(batch[i])) {
                _computeForVideoSync(batch[i], { skipMMR: true });
            }
        }
        if (_cantidadBgPendiente() > 0) {
            _s._bgProcessTimer = _s._guard.setTimeout(_processBgBatch, CFG.BG_COMPUTE_DELAY_MS);
        } else {
            _s._bgRunning = false;
            log.debug('Cola BG recomendaciones completada.');
        }
    }

    function _recomputeAll(force) {
        var allVideos = VP.estado.videos || [];
        var ids = [];
        for (var i = 0; i < allVideos.length; i++) {
            var v = allVideos[i];
            if (!_esVideoValido(v)) continue;
            if (!force && _cacheLRU.has(String(v.id))) continue;
            ids.push(v.id);
        }
        log.info('recomputeAll: encolando', ids.length, 'vídeos para BG');
        _enqueueBgCompute(ids);
    }

    // ============================================================
    // SECCIÓN 17 — COLA DE EMBEDDINGS EN SEGUNDO PLANO
    // ============================================================

    /**
     * Añade un video a la cola de embeddings con dedup.
     * Usa la clave de embedding como identificador único para evitar
     * que el mismo video se encolle múltiples veces.
     */
    function _enqueueEmbedVideo(video) {
        var ek = _embedKey(video);
        if (_s._embedQueueDedup[ek]) return;
        _s._embedQueueDedup[ek] = true;
        _s._embedQueue.push(video);
    }

    /**
     * Encola todos los vídeos sin embedding para cómputo BG.
     * Antes de encolar verifica LRU → LS → IDB para no regenerar
     * vectores que ya están persistidos.
     */
    function _enqueueAllEmbeddings() {
        if (_s._destroyed) return;
        if (_s._ollamaAvailable === false) return;
        if (_s._embeddingModelAvailable === false) return;
        if (_s._embedEnqueued) return;
        if (!_backgroundWorkAllowed()) {
            _s._embedEnqueued = false;
            _s._embedProcessTimer = _s._guard.setTimeout(_enqueueAllEmbeddings, CFG.EMBED_BATCH_DELAY_MS * 2);
            return;
        }
        _s._embedEnqueued = true;
        var epoch = _s._embeddingEpoch;
        var allVideos = VP.estado.videos || [];

        // Fase 1: separar los que ya están en LRU/LS de los que requieren IDB check
        var sinEmbeddingLocal = [];
        function escanearLoteLocal(inicio) {
            if (_s._destroyed || epoch !== _s._embeddingEpoch) return;
            var fin = Math.min(inicio + 32, allVideos.length);
            for (var i = inicio; i < fin; i++) {
                var v = allVideos[i];
                if (!_esVideoValido(v)) continue;
                var key = _embedKey(v);
                if (_embedLRU.has(key)) continue;           // en memoria
                var storedVec = _s._invalidatedEmbedKeys[key] ? null : _loadEmbeddingLS(key);
                if (storedVec) {                             // en LS → cargar en LRU
                    _embedLRU.set(key, storedVec);
                    continue;
                }
                sinEmbeddingLocal.push(v);
            }

            if (fin < allVideos.length) {
                var continuar = function () { escanearLoteLocal(fin); };
                if (typeof window.requestIdleCallback === 'function') {
                    window.requestIdleCallback(continuar, { timeout: 250 });
                } else {
                    setTimeout(continuar, 0);
                }
                return;
            }

            procesarSinEmbeddingLocal();
        }

        escanearLoteLocal(0);

        function procesarSinEmbeddingLocal() {
            if (_s._destroyed || epoch !== _s._embeddingEpoch) return;

            if (sinEmbeddingLocal.length === 0) {
                log.debug('Cola EMB: todos los vídeos ya tienen embedding en LRU/LS.');
                _s._embedEnqueued = false;
                _s._embedTotal = _s._embedDone = _s._embedErrors = 0;
                _updateEmbedProgressUI();
                return;
            }

            // Fase 2: consultar IDB para los restantes antes de encolar en Ollama
            if (VP.db && typeof VP.db.obtenerMetadatos === 'function') {
                var pendientesIDB = sinEmbeddingLocal.slice();
                var comprobados   = 0;

            function checkIDBLote(inicio) {
                if (_s._destroyed || epoch !== _s._embeddingEpoch) return;
                var LOTE = 8;
                var fin  = Math.min(inicio + LOTE, pendientesIDB.length);
                var promises = [];
                for (var j = inicio; j < fin; j++) {
                    (function (video) {
                        var key = _embedKey(video);
                        promises.push(
                            _loadEmbeddingIDB(key).then(function (vec) {
                                if (_s._destroyed || epoch !== _s._embeddingEpoch) return;
                                if (vec && !_s._invalidatedEmbedKeys[key]) {
                                    _embedLRU.set(key, vec);
                                    _persistEmbeddingLS(key, vec);
                                } else {
                                    // Realmente no está: encolar para Ollama
                                    _enqueueEmbedVideo(video);
                                }
                                comprobados++;
                            }).catch(function () {
                                if (!_s._destroyed && epoch === _s._embeddingEpoch) {
                                    _enqueueEmbedVideo(video);
                                    comprobados++;
                                }
                            })
                        );
                    })(pendientesIDB[j]);
                }
                Promise.all(promises).then(function () {
                    if (_s._destroyed || epoch !== _s._embeddingEpoch) return;
                    if (fin < pendientesIDB.length) {
                        setTimeout(function () { checkIDBLote(fin); }, 60);
                    } else {
                        // Todos comprobados: arrancar cola Ollama con los que faltan
                        if (_s._embedQueue.length > 0) {
                            _s._embedTotal  = _s._embedQueue.length;
                            _s._embedDone   = 0;
                            _s._embedErrors = 0;
                            log.info('Cola EMB: ' + _s._embedQueue.length + ' vídeos sin embedding (de ' + pendientesIDB.length + ' pendientes tras IDB check)');
                            _updateEmbedProgressUI();
                            _startEmbedBg();
                        } else {
                            log.info('Cola EMB: todos los vídeos tenían embedding en IDB — sin llamadas a Ollama.');
                            _s._embedEnqueued = false;
                            _s._embedTotal = _s._embedDone = _s._embedErrors = 0;
                            _updateEmbedProgressUI();
                        }
                    }
                });
            }
                checkIDBLote(0);
            } else {
                // Sin IDB disponible: encolar directamente
                _s._embedTotal  = sinEmbeddingLocal.length;
                _s._embedDone   = 0;
                _s._embedErrors = 0;
                _s._embedQueue  = sinEmbeddingLocal.slice();
                _s._embedQueueDedup = Object.create(null);
                for (var ei = 0; ei < _s._embedQueue.length; ei++) {
                    _s._embedQueueDedup[_embedKey(_s._embedQueue[ei])] = true;
                }
                log.info('Cola EMB: encolando', sinEmbeddingLocal.length, 'vídeos para embeddings BG');
                _updateEmbedProgressUI();
                _startEmbedBg();
            }
        }
    }

    function _startEmbedBg() {
        if (_s._destroyed || _s._embedRunning || _s._embedQueue.length === 0) return;
        if (!_backgroundWorkAllowed()) {
            _s._embedRunning = false;
            _s._embedProcessTimer = _s._guard.setTimeout(function () { _startEmbedBg(); }, CFG.EMBED_BATCH_DELAY_MS * 2);
            return;
        }
        _s._embedRunning = true;
        _processEmbedBatch(_s._embeddingEpoch);
    }

    function _processEmbedBatch(epoch) {
        epoch = typeof epoch === 'number' ? epoch : _s._embeddingEpoch;
        if (_s._destroyed || epoch !== _s._embeddingEpoch) return;
        if (!_backgroundWorkAllowed()) {
            _s._embedRunning = false;
            _s._embedProcessTimer = _s._guard.setTimeout(function () { _processEmbedBatch(epoch); }, CFG.EMBED_BATCH_DELAY_MS * 2);
            return;
        }
        _s._embedProcessTimer = null;
        if (_s._embedQueue.length === 0) {
            _s._embedRunning = false;
            _s._embedEnqueued = false;
            _s._embedQueueDedup = Object.create(null);
            log.info('Cola EMB completada. Éxitos:', _s._embedDone, '| Errores:', _s._embedErrors);
            // Recomputar recomendaciones con los nuevos embeddings
            if (_s._currentVidId) {
                _cacheLRU.del(_s._currentVidId);
                var recoms = _computeForVideoSync(_s._currentVidId);
                _mostrarRecomendaciones(recoms);
            }
            _updateEmbedProgressUI();
            return;
        }

        var batch = _s._embedQueue.splice(0, CFG.MAX_EMBED_CONCURRENCY);
        var promises = batch.map(function (v) {
            return _getEmbedding(v)
                .then(function (vec) {
                    if (vec) {
                        _s._embedDone++;
                    } else if ((_s._ollamaAvailable === false || _s._embeddingModelAvailable === false) && !_s._destroyed) {
                        var retryKey = _embedKey(v);
                        delete _s._embedQueueDedup[retryKey];
                        _enqueueEmbedVideo(v);
                    } else {
                        _s._embedErrors++;
                    }
                    return null;
                })
                .catch(function () { 
                    _s._embedErrors++; 
                    return null;
                });
        });

        Promise.all(promises).then(function () {
            if (_s._destroyed || epoch !== _s._embeddingEpoch) return;
            _updateEmbedProgressUI();
            if (_s._ollamaAvailable === false || _s._embeddingModelAvailable === false) {
                _s._embedRunning = false;
                return;
            }
            if (_s._embedQueue.length > 0) {
                _s._embedProcessTimer = _s._guard.setTimeout(function () { _processEmbedBatch(epoch); }, CFG.EMBED_BATCH_DELAY_MS);
            } else {
                _s._embedRunning = false;
                _s._embedEnqueued = false;
                _s._embedQueueDedup = Object.create(null);
                log.info('Cola EMB completada. Éxitos:', _s._embedDone, '| Errores:', _s._embedErrors);
                if (_s._currentVidId) {
                    _cacheLRU.del(_s._currentVidId);
                    var recoms = _computeForVideoSync(_s._currentVidId);
                    _mostrarRecomendaciones(recoms);
                }
                _updateEmbedProgressUI();
            }
        });
    }

    // ============================================================
    // SECCIÓN 18 — LIMPIEZA DE CACHÉ
    // ============================================================

    function _clearCache() {
        _s._recommendationEpoch++;
        _cancelPreloadWork();
        if (_s._recomputeTimer !== null) clearTimeout(_s._recomputeTimer);
        _s._recomputeTimer = null;
        if (_s._bgProcessTimer !== null) clearTimeout(_s._bgProcessTimer);
        _s._bgProcessTimer = null;
        _limpiarColaBg();
        _s._bgRunning = false;
        _s._guard.nextGeneration();
        _s._recoms = [];
        _s._recomsFiltered = [];
        _s._recomsVisible = 0;
        var idsCached = _cacheLRU.keys();
        var idsCachedSet = new Set(idsCached);
        var indexedIds = _index.getAll();
        for (var ii = 0; ii < indexedIds.length; ii++) {
            if (!idsCachedSet.has(indexedIds[ii])) {
                idsCached.push(indexedIds[ii]);
                idsCachedSet.add(indexedIds[ii]);
            }
        }
        _cacheLRU.clear();
        _index.clear();
        try {
            var kvKeys = VP.db.clavesKeyVal();
            for (var i = 0; i < kvKeys.length; i++) {
                if (kvKeys[i].indexOf(CFG.STORAGE_PREFIX) === 0) {
                    VP.db.eliminarKeyVal(kvKeys[i]);
                }
            }
        } catch (_) {}
        var idbTasks = [];
        if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
            for (var j = 0; j < idsCached.length; j++) {
                (function (id) {
                    var patch = {};
                    patch[CFG.IDB_META_KEY] = null;
                    idbTasks.push(Promise.resolve().then(function () {
                        return VP.db.guardarMetadatos(id, patch);
                    }).catch(function () {}));
                })(idsCached[j]);
            }
        }
        _s._preloaded = false;
        log.info('Caché de recomendaciones limpiada.');
        return Promise.all(idbTasks);
    }

    function _clearEmbeddingCache() {
        // Invalidar trabajo en vuelo para que una respuesta antigua no vuelva
        // a escribir en caché después de que el usuario la haya limpiado.
        _s._embeddingEpoch++;
        if (_s._embedProcessTimer !== null) clearTimeout(_s._embedProcessTimer);
        _s._embedProcessTimer = null;
        _s._embedQueue.length = 0;
        _s._embedQueueDedup = Object.create(null);
        _s._embedEnqueued = false;
        _s._embedRunning = false;
        _s._embedTotal = _s._embedDone = _s._embedErrors = 0;
        Object.keys(_s._pendingEmbeds).forEach(function (key) { delete _s._pendingEmbeds[key]; });
        _s._embedKeyEpochs = Object.create(null);
        _s._invalidatedEmbedKeys = Object.create(null);
        var recommendationClearPromise = _clearCache();
        _s._recoms = [];
        _s._recomsFiltered = [];
        _s._recomsVisible = 0;
        var panel = document.getElementById('relatedVideosPanel');
        if (panel) panel.style.display = 'none';

        var keys = _embedLRU.keys();
        var keysSet = new Set(keys);
        var indexedKeys = _embedIndex.getAll();
        for (var ki = 0; ki < indexedKeys.length; ki++) {
            if (!keysSet.has(indexedKeys[ki])) {
                keys.push(indexedKeys[ki]);
                keysSet.add(indexedKeys[ki]);
            }
        }
        _embedLRU.clear();
        _embedIndex.clear();
        _updateEmbedProgressUI();
        _updateStatsUI();
        try {
            var kvKeys = VP.db.clavesKeyVal();
            for (var i = 0; i < kvKeys.length; i++) {
                if (kvKeys[i].indexOf(CFG.EMBED_STORAGE_PREFIX) === 0) {
                    VP.db.eliminarKeyVal(kvKeys[i]);
                }
            }
        } catch (_) {}
        var metadataPromise = recommendationClearPromise.then(function () {
            if (!VP.db || typeof VP.db.obtenerTodos !== 'function') return [];
            return VP.db.obtenerTodos('metadata').then(function (records) {
                return Array.isArray(records) ? records : [];
            }).catch(function () { return []; });
        });
        if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
            metadataPromise = metadataPromise.then(function (records) {
                var recordsById = Object.create(null);
                var toUpdate = [];
                (records || []).forEach(function (record) {
                    if (!record || record.id == null) return;
                    var id = String(record.id);
                    recordsById[id] = record;
                    if (record[CFG.IDB_EMBED_META_KEY]) {
                        record[CFG.IDB_EMBED_META_KEY] = null;
                        toUpdate.push(record);
                        if (!keysSet.has(id)) {
                            keys.push(id);
                            keysSet.add(id);
                        }
                    }
                });
                var fallbackKeys = keys.filter(function (key) { return !recordsById[key]; });
                var batchPromise = Promise.resolve();
                if (toUpdate.length && typeof VP.db.guardarMetadatosLote === 'function') {
                    batchPromise = Promise.resolve().then(function () {
                        return VP.db.guardarMetadatosLote(toUpdate);
                    }).catch(function () {
                        return Promise.all(toUpdate.map(function (record) {
                            var patch = {};
                            patch[CFG.IDB_EMBED_META_KEY] = null;
                            return VP.db.guardarMetadatos(record.id, patch).catch(function () {});
                        }));
                    });
                } else if (toUpdate.length) {
                    batchPromise = Promise.all(toUpdate.map(function (record) {
                        var patch = {};
                        patch[CFG.IDB_EMBED_META_KEY] = null;
                        return VP.db.guardarMetadatos(record.id, patch).catch(function () {});
                    }));
                }
                var fallbackPromise = Promise.all(fallbackKeys.map(function (key) {
                    var patch = {};
                    patch[CFG.IDB_EMBED_META_KEY] = null;
                    return Promise.resolve().then(function () {
                        return VP.db.guardarMetadatos(key, patch);
                    }).catch(function () {});
                }));
                return Promise.all([batchPromise, fallbackPromise]);
            });
        }
        return Promise.all([metadataPromise, recommendationClearPromise]).then(function () {
            log.info('Caché de embeddings limpiada.');
            _updateEmbedProgressUI();
            _updateStatsUI();
            return true;
        });
    }

    function _invalidarVideo(vidId) {
        var strId = String(vidId);
        _cacheLRU.del(strId);
        _index.remove(strId);
        try { VP.db.eliminarKeyVal(CFG.STORAGE_PREFIX + strId); } catch (_) {}
        if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
            var patch = {};
            patch[CFG.IDB_META_KEY] = null;
            VP.db.guardarMetadatos(strId, patch).catch(function () {});
        }
    }

    function _invalidarEmbeddingVideo(video) {
        var key = _embedKey(video);
        _s._embedKeyEpochs[key] = (_s._embedKeyEpochs[key] || 0) + 1;
        _s._invalidatedEmbedKeys[key] = true;
        _embedLRU.del(key);
        _embedIndex.remove(key);
        if (_s._pendingEmbeds[key]) delete _s._pendingEmbeds[key];
        try { VP.db.eliminarKeyVal(CFG.EMBED_STORAGE_PREFIX + key); } catch (_) {}
        if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
            var patch = {};
            patch[CFG.IDB_EMBED_META_KEY] = null;
            VP.db.guardarMetadatos(key, patch).catch(function () {});
        }
    }

    // ============================================================
    // SECCIÓN 19 — UI: FILTROS Y ORDENAMIENTO
    // ============================================================

    function _aplicarFiltrosYOrden(recoms) {
        if (!recoms || recoms.length === 0) return [];
        var filtered = recoms.slice();

        // Filtrar por etiqueta
        var tagFilter = (_s._filterTag || '').trim().toLowerCase();
        if (tagFilter) {
            filtered = filtered.filter(function (rec) {
                if (!rec.tags || rec.tags.length === 0) return false;
                for (var i = 0; i < rec.tags.length; i++) {
                    if (rec.tags[i].toLowerCase().indexOf(tagFilter) >= 0) return true;
                }
                // Buscar también en el nombre
                return rec.name.toLowerCase().indexOf(tagFilter) >= 0;
            });
        }

        // Filtrar por duración
        if (_s._filterDurMin > 0 || _s._filterDurMax < Infinity) {
            filtered = filtered.filter(function (rec) {
                var dur = rec.duration || 0;
                return dur >= _s._filterDurMin && dur <= _s._filterDurMax;
            });
        }

        // Ordenar
        switch (_s._sortMode) {
            case 'semantic':
                filtered.sort(function (a, b) {
                    return (b.semanticScore || 0) - (a.semanticScore || 0);
                });
                break;
            case 'name':
                filtered.sort(function (a, b) {
                    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                });
                break;
            case 'duration':
                filtered.sort(function (a, b) { return (b.duration || 0) - (a.duration || 0); });
                break;
            case 'score':
            default:
                filtered.sort(function (a, b) { return b.score - a.score; });
                break;
        }

        return filtered;
    }

    function _onFilterChange() {
        clearTimeout(_s._filterDebounceTimer);
        _s._filterDebounceTimer = _s._guard.setTimeout(function () {
            _s._recomsFiltered = _aplicarFiltrosYOrden(_s._recoms);
            _renderGrid(_s._recomsFiltered, true);
        }, CFG.FILTER_DEBOUNCE_MS);
    }

    // ============================================================
    // SECCIÓN 20 — UI: CREAR PANEL
    // ============================================================

    function _crearUI() {
        if (_s._uiCreated) return;

        var gallerySection = document.getElementById('gallerySectionWrap');
        if (!gallerySection) { log.warn('crearUI: gallerySectionWrap no encontrado'); return; }

        var panel = document.createElement('div');
        panel.id        = 'relatedVideosPanel';
        panel.className = 'related-videos-panel';
        panel.setAttribute('aria-label', 'Videos relacionados');
        panel.style.display = 'none';

        panel.innerHTML =
            // ---- Cabecera ----
            '<div class="related-videos-header">' +
                '<h3 class="related-videos-title">' +
                    '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                        '<rect x="2" y="3" width="9" height="6" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.75"/>' +
                        '<rect x="13" y="3" width="9" height="6" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.75"/>' +
                        '<rect x="2" y="15" width="9" height="6" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.75"/>' +
                        '<rect x="13" y="15" width="9" height="6" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.75"/>' +
                    '</svg>' +
                    ' Relacionados' +
                '</h3>' +
                '<div class="related-header-actions">' +
                    '<div class="related-embed-status" id="relatedEmbedStatus" title="Estado de embeddings semánticos"></div>' +
                    '<button class="related-action-btn related-compact-btn" id="relatedCompactBtn" title="Cambiar a vista compacta" aria-label="Vista detallada activa. Cambiar a vista compacta" aria-pressed="true" type="button">' +
                        '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="3" width="7" height="5" rx="1" fill="currentColor" opacity=".8"/><rect x="14" y="3" width="7" height="5" rx="1" fill="currentColor" opacity=".8"/><rect x="3" y="12" width="7" height="5" rx="1" fill="currentColor" opacity=".8"/><rect x="14" y="12" width="7" height="5" rx="1" fill="currentColor" opacity=".8"/></svg>' +
                    '</button>' +
                    '<button class="related-action-btn related-refresh-btn" id="relatedRefreshBtn" title="Recomputar" type="button">' +
                        '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>' +
                    '</button>' +
                    '<button class="related-action-btn related-stats-btn" id="relatedStatsBtn" title="Estadísticas" type="button">⚙</button>' +
                '</div>' +
            '</div>' +
            // ---- Barra de progreso de embeddings ----
            '<div class="related-embed-progress" id="relatedEmbedProgress" style="display:none;">' +
                '<div class="related-embed-progress-bar" id="relatedEmbedProgressBar" style="width:0%"></div>' +
                '<span class="related-embed-progress-text" id="relatedEmbedProgressText"></span>' +
            '</div>' +
            // ---- Controles de filtro y ordenamiento ----
            '<div class="related-controls" id="relatedControls">' +
                '<div class="related-filter-wrap">' +
                    '<input class="related-filter-input" id="relatedFilterTag" type="search"' +
                    '       placeholder="Filtrar por etiqueta…" autocomplete="off" aria-label="Filtrar recomendaciones"/>' +
                '</div>' +
                '<div class="related-sort-wrap">' +
                    '<label class="related-sort-label" for="relatedSortSelect">Ordenar:</label>' +
                    '<select class="related-sort-select" id="relatedSortSelect" aria-label="Criterio de ordenamiento">' +
                        '<option value="score">Relevancia</option>' +
                        '<option value="semantic">Semántica</option>' +
                        '<option value="name">Nombre</option>' +
                        '<option value="duration">Duración</option>' +
                    '</select>' +
                '</div>' +
                '<div class="related-dur-filter" id="relatedDurFilter">' +
                    '<span class="related-dur-label">Duración:</span>' +
                    '<select class="related-sort-select" id="relatedDurSelect" aria-label="Filtro de duración">' +
                        '<option value="any">Cualquiera</option>' +
                        '<option value="short">Cortos (&lt;5min)</option>' +
                        '<option value="medium">Medios (5-20min)</option>' +
                        '<option value="long">Largos (&gt;20min)</option>' +
                    '</select>' +
                '</div>' +
            '</div>' +
            // ---- Panel de estadísticas (colapsable) ----
            '<div class="related-stats-panel" id="relatedStatsPanel" style="display:none;">' +
                '<div class="related-stats-grid">' +
                    '<div class="related-stat-item"><span class="related-stat-label">Caché REC</span><span class="related-stat-val" id="statCacheRec">—</span></div>' +
                    '<div class="related-stat-item"><span class="related-stat-label">Caché EMB</span><span class="related-stat-val" id="statCacheEmb">—</span></div>' +
                    '<div class="related-stat-item"><span class="related-stat-label">EMB computados</span><span class="related-stat-val" id="statEmbDone">—</span></div>' +
                    '<div class="related-stat-item"><span class="related-stat-label">EMB errores</span><span class="related-stat-val" id="statEmbErr">—</span></div>' +
                    '<div class="related-stat-item"><span class="related-stat-label">Ollama</span><span class="related-stat-val" id="statOllama">—</span></div>' +
                    '<div class="related-stat-item"><span class="related-stat-label">Modelo EMB</span><span class="related-stat-val" id="statEmbModel">—</span></div>' +
                '</div>' +
                '<div class="related-stats-actions">' +
                    '<button class="related-stats-action-btn" id="relatedClearCacheBtn" type="button">Limpiar caché REC</button>' +
                    '<button class="related-stats-action-btn" id="relatedClearEmbBtn" type="button">Limpiar caché EMB</button>' +
                    '<button class="related-stats-action-btn" id="relatedDecayClicksBtn" type="button">Decaer clics</button>' +
                    '<button class="related-stats-action-btn" id="relatedRecomputeEmbBtn" type="button">Recomputar EMB</button>' +
                '</div>' +
            '</div>' +
            // ---- Rejilla ----
            '<div class="related-videos-grid" id="relatedVideosGrid" aria-live="polite" aria-atomic="false"></div>' +
            // ---- Tooltip "¿Por qué?" ----
            '<div class="related-why-tooltip" id="relatedWhyTooltip" role="tooltip" style="display:none;"></div>';

        var container = gallerySection.parentNode;
        container.insertBefore(panel, gallerySection);

        _bindPanelEvents();
        _s._uiCreated = true;
        log.info('UI de recomendaciones v3.0.0 creada.');
    }

    function _bindPanelEvents() {
        // Ciclar entre vistas compacta, normal y detallada
        var compactBtn = document.getElementById('relatedCompactBtn');
        if (compactBtn) compactBtn.addEventListener('click', function () {
            if (_s._compactView) {
                _s._compactView = false;
                _s._detailedView = false;
            } else if (!_s._detailedView) {
                _s._detailedView = true;
            } else {
                _s._compactView = true;
                _s._detailedView = false;
            }
            compactBtn.setAttribute('aria-pressed', String(_s._compactView || _s._detailedView));
            var nextView = _s._compactView ? 'vista normal' : (_s._detailedView ? 'vista compacta' : 'vista detallada');
            compactBtn.title = 'Cambiar a ' + nextView;
            compactBtn.setAttribute('aria-label', 'Vista ' + (_s._compactView ? 'compacta' : (_s._detailedView ? 'detallada' : 'normal')) + ' activa. Cambiar a ' + nextView);
            var grid = document.getElementById('relatedVideosGrid');
            if (grid) {
                grid.classList.toggle('related-grid-compact', _s._compactView);
                grid.classList.toggle('related-grid-detailed', _s._detailedView);
            }
        });

        // Refresh
        var refreshBtn = document.getElementById('relatedRefreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', function () {
            if (!_s._currentVidId) return;
            _invalidarVideo(_s._currentVidId);
            var recoms = _computeForVideoSync(_s._currentVidId);
            _s._recoms = recoms;
            _s._recomsFiltered = _aplicarFiltrosYOrden(recoms);
            _mostrarRecomendaciones(_s._recomsFiltered);
        });

        // Estadísticas
        var statsBtn = document.getElementById('relatedStatsBtn');
        if (statsBtn) statsBtn.addEventListener('click', function () {
            _s._statsExpanded = !_s._statsExpanded;
            var sp = document.getElementById('relatedStatsPanel');
            if (sp) { sp.style.display = _s._statsExpanded ? '' : 'none'; }
            if (_s._statsExpanded) _updateStatsUI();
        });

        // Filtro por etiqueta
        var filterInput = document.getElementById('relatedFilterTag');
        if (filterInput) filterInput.addEventListener('input', function () {
            _s._filterTag = filterInput.value;
            _onFilterChange();
        });

        // Filtro por duración
        var durSelect = document.getElementById('relatedDurSelect');
        if (durSelect) durSelect.addEventListener('change', function () {
            switch (durSelect.value) {
                case 'short':  _s._filterDurMin = 0;    _s._filterDurMax = 300;      break;
                case 'medium': _s._filterDurMin = 300;  _s._filterDurMax = 1200;     break;
                case 'long':   _s._filterDurMin = 1200; _s._filterDurMax = Infinity; break;
                default:       _s._filterDurMin = 0;    _s._filterDurMax = Infinity; break;
            }
            _onFilterChange();
        });

        // Ordenamiento
        var sortSelect = document.getElementById('relatedSortSelect');
        if (sortSelect) sortSelect.addEventListener('change', function () {
            _s._sortMode = sortSelect.value;
            _onFilterChange();
        });

        // Acciones del panel de estadísticas
        var clearCacheBtn = document.getElementById('relatedClearCacheBtn');
        if (clearCacheBtn) clearCacheBtn.addEventListener('click', function () {
            _clearCache();
            _updateStatsUI();
            _onReset();
        });

        var clearEmbBtn = document.getElementById('relatedClearEmbBtn');
        if (clearEmbBtn) clearEmbBtn.addEventListener('click', function () {
            _clearEmbeddingCache();
            _updateStatsUI();
        });

        var decayBtn = document.getElementById('relatedDecayClicksBtn');
        if (decayBtn) decayBtn.addEventListener('click', function () {
            _clicks.decay();
            log.info('Decaimiento de clics aplicado.');
        });

        var reembBtn = document.getElementById('relatedRecomputeEmbBtn');
        if (reembBtn) reembBtn.addEventListener('click', function () {
            _clearEmbeddingCache().then(function () {
                VP.recomendacionesIA.checkOllama();
            });
        });

        // Cerrar tooltip al hacer click fuera
        document.addEventListener('click', function (e) {
            var tooltip = document.getElementById('relatedWhyTooltip');
            if (tooltip && tooltip.style.display !== 'none') {
                if (!tooltip.contains(e.target) &&
                    !(e.target && e.target.classList && e.target.classList.contains('related-why-btn'))) {
                    tooltip.style.display = 'none';
                }
            }
        });
    }

    // ============================================================
    // SECCIÓN 21 — UI: SKELETON LOADING
    // ============================================================

    function _mostrarSkeleton() {
        var panel = document.getElementById('relatedVideosPanel');
        var grid  = document.getElementById('relatedVideosGrid');
        if (!panel || !grid) return;

        var count = 4;
        var frag  = document.createDocumentFragment();
        for (var i = 0; i < count; i++) {
            var sk = document.createElement('div');
            sk.className = 'related-video-item related-skeleton';
            sk.setAttribute('aria-hidden', 'true');
            sk.innerHTML =
                '<div class="related-thumb-wrap related-sk-block"></div>' +
                '<div class="related-info">' +
                    '<div class="related-sk-line related-sk-title"></div>' +
                    '<div class="related-sk-line related-sk-sub"></div>' +
                    '<div class="related-sk-line related-sk-tags"></div>' +
                '</div>';
            frag.appendChild(sk);
        }
        grid.innerHTML = '';
        grid.appendChild(frag);
        panel.style.display = '';
        _s._recomsVisible = 0;
    }

    // ============================================================
    // SECCIÓN 22 — UI: RENDERIZAR RECOMENDACIONES
    // ============================================================

    function _mostrarRecomendaciones(recoms) {
        var panel = document.getElementById('relatedVideosPanel');
        var grid  = document.getElementById('relatedVideosGrid');
        if (!panel || !grid) return;

        _s._recoms         = recoms;
        _s._recomsFiltered = _aplicarFiltrosYOrden(recoms || []);

        if (!_s._recomsFiltered || _s._recomsFiltered.length === 0) {
            panel.style.display = 'none';
            _s._recomsVisible = 0;
            return;
        }

        var videosPorId = _crearMapaVideosPorId(VP.estado.videos || []);
        _renderGrid(_s._recomsFiltered, true, videosPorId);
        panel.style.display = '';

        // Forzar carga de miniaturas
        if (VP.miniaturas && typeof VP.miniaturas.generar === 'function') {
            for (var ri = 0; ri < recoms.length; ri++) {
                var video = videosPorId.get(String(recoms[ri].videoId));
                if (video && !video.thumbnail) {
                    VP.miniaturas.generar(video).catch(function () {});
                }
            }
        }
    }

    function _crearMapaVideosPorId(videos) {
        var mapa = new Map();
        for (var i = 0; i < videos.length; i++) {
            var video = videos[i];
            if (!video || video.id == null) continue;
            var id = String(video.id);
            if (!mapa.has(id)) mapa.set(id, video);
        }
        return mapa;
    }

    function _renderGrid(recoms, reset, videosPorId) {
        var grid = document.getElementById('relatedVideosGrid');
        if (!grid) return;
        videosPorId = videosPorId || _crearMapaVideosPorId(VP.estado.videos || []);

        if (reset) {
            grid.innerHTML = '';
        }

        _s._recomsVisible = recoms.length;

        var frag = document.createDocumentFragment();
        for (var i = 0; i < recoms.length; i++) {
            var item = _crearItemRecomendacion(recoms[i], i, videosPorId);
            if (item) frag.appendChild(item);
        }
        grid.appendChild(frag);

        grid.classList.toggle('related-grid-compact', _s._compactView);
        grid.classList.toggle('related-grid-detailed', _s._detailedView);
    }

    // ============================================================
    // SECCIÓN 23 — UI: CREAR ITEM DE RECOMENDACIÓN
    // ============================================================

    function _crearItemRecomendacion(rec, idx, videosPorId) {
        var el = document.createElement('div');
        el.className = 'related-video-item';
        el.dataset.vidId = String(rec.videoId);
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', 'Reproducir: ' + rec.name);
        el.style.animationDelay = (idx * 35) + 'ms';

        var duracion = rec.duration ? _formatDuration(rec.duration) : '';
        var scorePct = Math.round(rec.score * 100);

        // Resolver miniatura desde el objeto de vídeo si falta
        var thumbUrl = rec.thumbnail;
        if (!thumbUrl) {
            var video = videosPorId && videosPorId.get(String(rec.videoId));
            thumbUrl = video && video.thumbnail || null;
        }

        var thumbHtml = thumbUrl
            ? '<div class="thumbnail-image" style="background-image:url(' + _escHTML(thumbUrl) + ');background-size:cover;background-position:center;height:100%;transition:transform .22s ease;"></div>'
            : '<div class="thumbnail-image thumbnail-placeholder">' +
                '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">' +
                    '<rect x="2" y="5" width="20" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.75"/>' +
                    '<polygon points="9.5,9 9.5,15 16,12" fill="currentColor" opacity="0.4"/>' +
                '</svg>' +
              '</div>';

        // Indicadores de fuente de similitud
        var badges = '';
        if (rec.hasEmbeddings) {
            badges += '<span class="related-badge related-badge-sem" title="Similitud semántica por embeddings">🧠</span>';
        }
        if (!rec.hasTags && !rec.hasEmbeddings) {
            badges += '<span class="related-badge related-badge-fb" title="Recomendado por nombre/duración (sin etiquetas ni embeddings)">⚡</span>';
        }
        if (rec.collabScore > 0) {
            badges += '<span class="related-badge related-badge-col" title="Popular entre los espectadores de este vídeo">🔥</span>';
        }

        // Chips de etiquetas (primeras 3)
        var tagsHtml = '';
        if (rec.tags && rec.tags.length > 0) {
            var shown = rec.tags.slice(0, 3);
            for (var ti = 0; ti < shown.length; ti++) {
                tagsHtml += '<span class="related-tag-chip">' + _escHTML(shown[ti]) + '</span>';
            }
            if (rec.tags.length > 3) {
                tagsHtml += '<span class="related-tag-chip related-tag-more">+' + (rec.tags.length - 3) + '</span>';
            }
        }

        // Barra de puntuación con desglose semántico
        var semanticPct = Math.round((rec.semanticScore || 0) * 100);
        var scoreBarHtml =
            '<div class="related-score" title="Similitud total: ' + scorePct + '%">' +
                '<div class="related-score-bars">' +
                    '<div class="related-score-bar-total" style="width:' + scorePct + '%"></div>' +
                    (semanticPct > 0
                        ? '<div class="related-score-bar-sem" style="width:' + semanticPct + '%" title="Semántica: ' + semanticPct + '%"></div>'
                        : '') +
                '</div>' +
                '<span class="related-score-text">' + scorePct + '%</span>' +
            '</div>';

        el.innerHTML =
            '<div class="related-thumb-wrap">' +
                thumbHtml +
                (duracion
                    ? '<span class="related-duration" aria-label="Duración: ' + duracion + '">' + duracion + '</span>'
                    : '') +
            '</div>' +
            '<div class="related-info">' +
                '<div class="related-name-row">' +
                    '<div class="related-name" title="' + _escHTML(rec.name) + '">' +
                        badges + _escHTML(rec.name) +
                    '</div>' +
                    '<button class="related-why-btn" data-vid-id="' + _escHTML(String(rec.videoId)) + '" title="¿Por qué se recomienda?" type="button" aria-label="Ver razones de recomendación">?</button>' +
                '</div>' +
                (tagsHtml ? '<div class="related-tags-row">' + tagsHtml + '</div>' : '') +
                scoreBarHtml +
            '</div>';

        // Click en el item → reproducir
        el.addEventListener('click', function (e) {
            if (e.target && e.target.classList && e.target.classList.contains('related-why-btn')) return;
            _reproducirRecomendacion(rec.videoId);
        });
        el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                _reproducirRecomendacion(rec.videoId);
            }
        });

        // Botón "¿Por qué?"
        var whyBtn = el.querySelector('.related-why-btn');
        if (whyBtn) {
            whyBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                _mostrarWhyTooltip(rec, whyBtn);
            });
        }

        return el;
    }

    // ============================================================
    // SECCIÓN 24 — UI: TOOLTIP "¿POR QUÉ?"
    // ============================================================

    function _mostrarWhyTooltip(rec, anchorBtn) {
        var tooltip = document.getElementById('relatedWhyTooltip');
        if (!tooltip) return;

        var scorePct    = Math.round(rec.score         * 100);
        var semPct      = Math.round((rec.semanticScore  || 0) * 100);
        var tagPct      = Math.round((rec.tagScore       || 0) * 100);
        var namePct     = Math.round((rec.nameScore      || 0) * 100);
        var durPct      = Math.round((rec.durScore       || 0) * 100);
        var collabPct   = Math.round((rec.collabScore    || 0) * 100);

        function row(label, pct, color) {
            if (pct === 0) return '';
            return '<div class="why-row">' +
                '<span class="why-label">' + label + '</span>' +
                '<div class="why-bar-wrap">' +
                    '<div class="why-bar" style="width:' + pct + '%;background:' + color + '"></div>' +
                '</div>' +
                '<span class="why-pct">' + pct + '%</span>' +
            '</div>';
        }

        tooltip.innerHTML =
            '<div class="why-header">¿Por qué este vídeo?</div>' +
            '<div class="why-total">Puntuación total: <strong>' + scorePct + '%</strong></div>' +
            row('Semántica',  semPct,   '#7c6af7') +
            row('Etiquetas',  tagPct,   '#4a9eff') +
            row('Nombre',     namePct,  '#3fc77f') +
            row('Duración',   durPct,   '#f7a94a') +
            row('Popular',    collabPct,'#f74a4a') +
            '<div class="why-flags">' +
                (rec.hasEmbeddings ? '<span class="why-flag">🧠 Embeddings</span>' : '') +
                (rec.hasTags       ? '<span class="why-flag">🏷 Etiquetas IA</span>' : '') +
                (!rec.hasTags && !rec.hasEmbeddings ? '<span class="why-flag">⚡ Solo texto</span>' : '') +
            '</div>';

        tooltip.style.display = '';

        // Posicionar cerca del botón
        var rect = anchorBtn.getBoundingClientRect();
        var panelRect = document.getElementById('relatedVideosPanel').getBoundingClientRect();
        tooltip.style.top  = (rect.bottom - panelRect.top + 6) + 'px';
        tooltip.style.left = Math.max(0, rect.left - panelRect.left - 80) + 'px';
    }

    // ============================================================
    // SECCIÓN 25 — UI: BARRA DE PROGRESO Y ESTADO DE EMBEDDINGS
    // ============================================================

    function _updateEmbedProgressUI() {
        var prog     = document.getElementById('relatedEmbedProgress');
        var bar      = document.getElementById('relatedEmbedProgressBar');
        var text     = document.getElementById('relatedEmbedProgressText');
        var status   = document.getElementById('relatedEmbedStatus');

        if (!prog || !bar || !text) return;

        var total = _s._embedTotal;
        var done  = _s._embedDone + _s._embedErrors;

        if (total === 0 || done >= total) {
            prog.style.display = 'none';
            if (status) {
                status.textContent = (_s._ollamaAvailable && _s._embeddingModelAvailable !== false)
                    ? '🧠 ' + _embedLRU.size() + ' EMB'
                    : (_s._ollamaAvailable ? '⚠ Modelo no disponible' : '💤 Sin embeddings');
                status.title = (_s._ollamaAvailable && _s._embeddingModelAvailable !== false)
                    ? 'Embeddings disponibles: ' + _embedLRU.size()
                    : (_s._ollamaAvailable
                        ? 'Ollama responde, pero no está instalado el modelo ' + CFG.EMBEDDING_MODEL + '.'
                        : 'Ollama no disponible. Recomendaciones basadas en etiquetas y nombre.');
            }
            return;
        }

        var pct = Math.round((done / total) * 100);
        prog.style.display = '';
        bar.style.width    = pct + '%';
        text.textContent   = 'Embeddings: ' + done + '/' + total + ' (' + pct + '%)';

        if (status) {
            status.textContent = '⏳ EMB ' + pct + '%';
            status.title       = 'Calculando embeddings semánticos en segundo plano…';
        }
    }

    function _updateEmbedStatusUI() {
        var status = document.getElementById('relatedEmbedStatus');
        if (!status) return;
        var pending = Object.keys(_s._pendingEmbeds).length;
        if (pending > 0) {
            status.textContent = '⏳ EMB ' + pending;
            status.title = 'Generando embeddings semánticos bajo demanda…';
            return;
        }
        if (_s._ollamaAvailable && _s._embeddingModelAvailable !== false) {
            status.textContent = '🧠 ' + _embedLRU.size() + ' EMB';
            status.title       = 'Embeddings semánticos activos. Modelo: ' + CFG.EMBEDDING_MODEL;
        } else if (_s._ollamaAvailable) {
            status.textContent = '⚠ Sin modelo EMB';
            status.title       = 'Ollama responde, pero falta instalar ' + CFG.EMBEDDING_MODEL;
        } else {
            status.textContent = '💤 Sin EMB';
            status.title       = 'Ollama no disponible en ' + CFG.OLLAMA_URL;
        }
    }

    function _updateStatsUI() {
        function setVal(id, val) {
            var el = document.getElementById(id);
            if (el) el.textContent = String(val);
        }
        setVal('statCacheRec',  _cacheLRU.size());
        setVal('statCacheEmb',  _embedLRU.size());
        setVal('statEmbDone',   _s._embedDone);
        setVal('statEmbErr',    _s._embedErrors);
        setVal('statOllama',    _s._ollamaAvailable === null ? '?' : (_s._ollamaAvailable ? (_s._embeddingModelAvailable === false ? '✓ / modelo ✗' : '✓') : '✗'));
        setVal('statEmbModel',  CFG.EMBEDDING_MODEL);
    }

    // ============================================================
    // SECCIÓN 26 — REPRODUCCIÓN
    // ============================================================

    function _reproducirRecomendacion(vidId) {
        // Registrar clic colaborativo
        if (_s._currentVidId) _clicks.record(_s._currentVidId, vidId);

        var playlist = VP.estado.playlist || [];
        for (var i = 0; i < playlist.length; i++) {
            if (String(playlist[i].id) === String(vidId)) {
                bus.emit('reproducirVideo', i);
                return;
            }
        }
        var videos = VP.estado.videos || [];
        for (var j = 0; j < videos.length; j++) {
            if (String(videos[j].id) === String(vidId)) {
                var v = videos[j];
                if (VP.reproductor && typeof VP.reproductor.reproducirPorNombre === 'function') {
                    VP.reproductor.reproducirPorNombre(v.name);
                } else {
                    log.warn('reproducirRecomendacion: reproductor no disponible para:', vidId);
                }
                return;
            }
        }
        log.warn('reproducirRecomendacion: video ID no encontrado:', vidId);
    }

    // ============================================================
    // SECCIÓN 27 — HELPERS DE FORMATO
    // ============================================================

    function _formatDuration(seconds) {
        if (!seconds || seconds <= 0) return '';
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = Math.floor(seconds % 60);
        if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function _escHTML(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // ============================================================
    // SECCIÓN 28 — EVENTOS DE BUS
    // ============================================================

    function _onVideoCambiado() {
        var ci    = VP.estado.currentVideoIndex;
        var pl    = VP.estado.playlist || [];
        var video = (typeof ci === 'number' && ci >= 0 && pl[ci]) ? pl[ci] : null;

        if (!video) {
            var panel = document.getElementById('relatedVideosPanel');
            if (panel) panel.style.display = 'none';
            _s._currentVidId = null;
            return;
        }

        var vidId = String(video.id);
        if (vidId === _s._currentVidId) return;
        _s._currentVidId = vidId;

        // Stale-guard: incrementar generación para descartar recomputes obsoletos
        var gen = _s._guard.nextGeneration();

        clearTimeout(_s._recomputeTimer);
        var cached = _getFreshCachedRecommendations(vidId);
        if (cached) {
            _s._recoms = cached;
            _s._recomsFiltered = _aplicarFiltrosYOrden(cached);
            _mostrarRecomendaciones(_s._recomsFiltered);
            // Mostrar la caché sin demora, pero completar embeddings faltantes
            // y refrescar el ranking en segundo plano para este video.
            _s._recomputeTimer = _s._guard.setTimeout(function () {
                _s._guard.track(_computeForVideoAsync(vidId)).then(function (recoms) {
                    if (_s._guard.isStale(gen) || _s._currentVidId !== vidId) return;
                    _s._recoms = recoms;
                    _s._recomsFiltered = _aplicarFiltrosYOrden(recoms);
                    _mostrarRecomendaciones(_s._recomsFiltered);
                }).catch(function (e) { log.warn('Error actualizando recomendaciones en caché:', e.message || e); });
            }, CFG.RECOMPUTE_DELAY_MS);
            return;
        }

        _mostrarSkeleton();
        _s._recomputeTimer = _s._guard.setTimeout(function () {
            // Cargar embeddings del vídeo actual y candidatos ante de recomendar
            _s._guard.track(_computeForVideoAsync(vidId)).then(function (recoms) {
                if (_s._guard.isStale(gen)) return;

                _s._recoms         = recoms;
                _s._recomsFiltered = _aplicarFiltrosYOrden(recoms);
                _mostrarRecomendaciones(_s._recomsFiltered);
            }).catch(function (e) { log.warn('Error en cómputo asíncrono:', e.message || e); });
        }, CFG.RECOMPUTE_DELAY_MS);
    }

    function _onVideosCargados() {
        if (_s._destroyed) return;
        log.debug('Videos cargados — recomendaciones bajo demanda.');

        // Reset guard en caso de que _checkOllamaAvailability (del timeout de _init)
        // ya se hubiese ejecutado antes de que los videos estuvieran listos.
        _s._embedEnqueued = false;

        function _arrancarEmbeddings() {
            if (!_s._ollamaChecked) {
                _checkOllamaAvailability();
            } else if (_s._ollamaAvailable === true && _s._embeddingModelAvailable !== false) {
                log.debug('Embeddings precargados desde caché; los faltantes se generan bajo demanda.');
            } else {
                // Reintentar: la verificación previa pudo fallar transitoriamente
                // durante un hard refresh. Ahora que los vídeos y los embeddings
                // desde IDB están listos, volvemos a comprobar Ollama.
                _s._ollamaChecked   = false;
                _s._ollamaChecking  = false;
                _checkOllamaAvailability();
            }
        }

        _preloadEmbeddingsIDB().then(_arrancarEmbeddings).catch(_arrancarEmbeddings);
    }

    function _onEtiquetasActualizadas(data) {
        if (_s._destroyed) return;
        // Las etiquetas también afectan a otros vídeos que lo recomiendan.
        if (!data || !data.key) return;
        var videos = VP.estado.videos || [];
        for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            var normalizedName = (v.name || '').toLowerCase().trim();
            var normalizedKey = (data.key || '').toLowerCase().trim();
            if (normalizedName === normalizedKey) {
                _invalidarVideo(String(v.id));
                _invalidarEmbeddingVideo(v);
                _clearCache();
                var activeId = _s._currentVidId;
                if (activeId) _mostrarSkeleton();
                clearTimeout(_s._recomputeTimer);
                _s._recomputeTimer = _s._guard.setTimeout(function () {
                    _getEmbedding(v).then(function () {
                        if (!activeId || activeId !== _s._currentVidId) return;
                        var recoms = _computeForVideoSync(activeId);
                        _s._recoms         = recoms;
                        _s._recomsFiltered = _aplicarFiltrosYOrden(recoms);
                        _mostrarRecomendaciones(_s._recomsFiltered);
                    }).catch(function (e) { log.warn('Error en embedding:', e.message || e); });
                }, CFG.RECOMPUTE_DELAY_MS);
                break;
            }
        }
    }

    function _onSubtitulosCargados() {
        if (_s._destroyed) return;
        // Cuando se cargan subtítulos del vídeo actual, invalida su embedding
        // para que se recalcule con el contexto de la transcripción
        if (!_s._currentVidId) return;
        var video = _findVideoById(_s._currentVidId);
        if (!video) return;
        _invalidarEmbeddingVideo(video);
        _clearCache();
        _mostrarSkeleton();
        log.debug('Subtítulos cargados → invalidando embedding del vídeo actual.');
        _getEmbedding(video).then(function () {
            log.debug('Embedding del vídeo actual recalculado con subtítulos.');
            if (!_s._currentVidId || String(video.id) !== _s._currentVidId) return;
            var recoms = _computeForVideoSync(_s._currentVidId);
            _s._recoms = recoms;
            _s._recomsFiltered = _aplicarFiltrosYOrden(recoms);
            _mostrarRecomendaciones(_s._recomsFiltered);
        }).catch(function (e) { log.warn('Error recalculando embedding:', e.message || e); });
    }

    function _onCacheVaciada() {
        _clearEmbeddingCache();
        var panel = document.getElementById('relatedVideosPanel');
        if (panel) panel.style.display = 'none';
        _s._recoms         = [];
        _s._recomsFiltered = [];
        _s._recomsVisible  = 0;
        _s._currentVidId   = null;
    }

    function _onReset() {
        _s._destroyed = true;
        // Remover todos los listeners del bus registrados por este módulo
        bus.offModule(_s._moduleId);
        // Abortar peticiones fetch en curso via guard
        _s._guard.abortAll();
        // Cancelar promesas pendientes
        var pendingKeys = Object.keys(_s._pendingEmbeds);
        for (var pi = 0; pi < pendingKeys.length; pi++) {
            delete _s._pendingEmbeds[pendingKeys[pi]];
        }
        // Limpiar timers trackeados
        _s._guard.clearAllTimers();

        _clearCache();
        var panel = document.getElementById('relatedVideosPanel');
        if (panel) panel.style.display = 'none';
        _s._currentVidId   = null;
        _s._recoms         = [];
        _s._recomsFiltered = [];
        _s._recomsVisible  = 0;
        _limpiarColaBg();
        _s._bgRunning          = false;
        _s._embedQueue.length  = 0;
        _s._embedRunning       = false;
        _s._embedEnqueued      = false;
        _s._embedQueueDedup    = Object.create(null);
    }

    function _registerEvents() {
        var evts = [
            ['videoCambiado',          _onVideoCambiado],
            ['videosCargados',         _onVideosCargados],
            ['cacheVaciada',           _onCacheVaciada],
            ['reset',                  _onReset],
            ['etiquetasIA:actualizadas', _onEtiquetasActualizadas],
            ['subtitulosCargados',     _onSubtitulosCargados],
        ];
        for (var i = 0; i < evts.length; i++) {
            bus.onModule(_s._moduleId, evts[i][0], evts[i][1]);
        }
    }

    // ============================================================
    // SECCIÓN 29 — CSS INYECTADO
    // ============================================================

    function _injectCSS() {
        if (_s._cssInjected) return;
        _s._cssInjected = true;

        var style = document.createElement('style');
        style.id  = 'vp-recomendaciones-ia-styles';
        style.textContent = [
            // ---- Panel principal ----
            '.related-videos-panel{',
                'margin-top:16px;padding:12px 16px;',
                'background:var(--bg-2);',
                'border-radius:10px;',
                'border:1px solid var(--bg-5);',
                'position:relative;',
            '}',

            // ---- Cabecera ----
            '.related-videos-header{',
                'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;',
            '}',
            '.related-videos-title{',
                'font-size:14px;font-weight:600;',
                'color:var(--text-secondary,#aaa);',
                'display:flex;align-items:center;gap:6px;margin:0;',
            '}',
            '.related-header-actions{',
                'display:flex;align-items:center;gap:6px;',
            '}',
            '.related-action-btn{',
                'background:var(--bg-3);',
                'border:1px solid var(--bg-5);',
                'border-radius:5px;cursor:pointer;',
                'color:var(--text-secondary,#aaa);',
                'padding:3px 7px;font-size:12px;',
                'transition:background .15s,color .15s;',
                'display:flex;align-items:center;gap:3px;',
            '}',
            '.related-action-btn:hover{',
                'background:var(--bg-4);color:var(--text-primary,#e0e0e0);',
            '}',
            '.related-embed-status{',
                'font-size:10px;color:var(--text-secondary,#aaa);',
                'background:var(--bg-3);',
                'border:1px solid var(--bg-5);',
                'border-radius:4px;padding:2px 7px;',
                'cursor:default;white-space:nowrap;',
            '}',

            // ---- Barra de progreso embeddings ----
            '.related-embed-progress{',
                'position:relative;height:18px;',
                'background:var(--bg-5);',
                'border-radius:4px;overflow:hidden;',
                'margin-bottom:8px;',
            '}',
            '.related-embed-progress-bar{',
                'height:100%;',
                'background:linear-gradient(90deg,#7c6af7,#4a9eff);',
                'transition:width .4s ease;',
                'border-radius:4px;',
            '}',
            '.related-embed-progress-text{',
                'position:absolute;top:50%;left:8px;',
                'transform:translateY(-50%);',
                'font-size:10px;color:#fff;',
                'white-space:nowrap;pointer-events:none;',
            '}',

            // ---- Controles de filtro/ordenamiento ----
            '.related-controls{',
                'display:flex;align-items:center;gap:8px;',
                'margin-bottom:10px;flex-wrap:wrap;',
            '}',
            '.related-filter-wrap{flex:0 1 220px;min-width:120px;}',
            '.related-sort-wrap{margin-left:auto;}',
            '.related-filter-input{',
                'width:100%;background:var(--bg-3);',
                'border:1px solid var(--bg-5);',
                'border-radius:5px;color:var(--text-primary,#e0e0e0);',
                'font-size:11px;padding:4px 8px;outline:none;',
                'transition:border-color .15s;box-sizing:border-box;',
            '}',
            '.related-filter-input:focus{border-color:var(--accent-color,#4a9eff);}',
            '.related-sort-wrap,.related-dur-filter{display:flex;align-items:center;gap:4px;}',
            '.related-sort-label,.related-dur-label{',
                'font-size:10px;color:var(--text-secondary,#aaa);white-space:nowrap;',
            '}',
            '.related-sort-select{',
                'background:var(--bg-2);',
                'border:1px solid var(--bg-5);',
                'border-radius:5px;color:var(--text-primary,#e0e0e0);',
                'font-size:11px;padding:3px 18px 3px 6px;cursor:pointer;',
                'appearance:none;-webkit-appearance:none;',
                'background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%23888\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E");',
                'background-repeat:no-repeat;background-position:right 6px center;',
            '}',
            '.related-sort-select option{',
                'background:var(--bg-2);color:var(--text-primary,#e0e0e0);',
            '}',

            // ---- Panel de estadísticas ----
            '.related-stats-panel{',
                'background:var(--bg-3);border-radius:7px;',
                'padding:10px 12px;margin-bottom:10px;',
                'border:1px solid var(--bg-5);',
            '}',
            '.related-stats-grid{',
                'display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px;',
            '}',
            '.related-stat-item{display:flex;flex-direction:column;gap:2px;}',
            '.related-stat-label{font-size:9px;color:var(--text-secondary,#aaa);}',
            '.related-stat-val{font-size:12px;font-weight:600;color:var(--text-primary,#e0e0e0);}',
            '.related-stats-actions{display:flex;gap:6px;flex-wrap:wrap;}',
            '.related-stats-action-btn{',
                'background:var(--bg-3);',
                'border:1px solid var(--bg-5);',
                'border-radius:5px;color:var(--text-secondary,#aaa);',
                'font-size:10px;padding:3px 8px;cursor:pointer;',
                'transition:background .15s;',
            '}',
            '.related-stats-action-btn:hover{background:var(--bg-4);}',

            // ---- Rejilla ----
            '.related-videos-grid{',
                'display:grid;',
                'grid-template-columns:repeat(auto-fill,minmax(175px,1fr));',
                'gap:8px;',
            '}',
            '.related-videos-grid.related-grid-compact{',
                'grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:5px;',
            '}',
            '.related-videos-grid.related-grid-detailed{',
                'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;',
                'overflow:visible;',
            '}',

            // ---- Item ----
            '.related-video-item{',
                'display:flex;flex-direction:column;cursor:pointer;',
                'border-radius:8px;overflow:hidden;',
                'background:var(--bg-2);',
                'border:1px solid var(--bg-5);',
                'transition:background .15s,transform .15s,box-shadow .15s;',
                'animation:vpRecFadeIn .25s ease both;',
            '}',
            '.related-video-item:hover{',
                'background:var(--bg-3);',
                'transform:translateY(-2px);',
                'box-shadow:0 5px 16px rgba(0,0,0,0.3);',
            '}',
            '.related-video-item:focus-visible{',
                'outline:2px solid var(--accent-color,#4a9eff);outline-offset:2px;',
            '}',
            '.related-grid-detailed .related-video-item{',
                'flex-direction:row;align-items:stretch;width:100%;min-width:0;max-width:none;min-height:48px;',
            '}',

            // ---- Thumbnail ----
            '.related-thumb-wrap{',
                'position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;',
                'background:var(--bg-0);',
            '}',
            '.related-grid-detailed .related-thumb-wrap{',
                'flex:0 0 72px;width:72px;aspect-ratio:16/9;align-self:center;',
            '}',
            '.related-thumb-wrap .thumbnail-image{height:100%;transition:transform .22s ease;}',
            '.related-video-item:hover .thumbnail-image{transform:scale(1.05);}',
            '.related-duration{',
                'position:absolute;bottom:4px;right:4px;',
                'background:var(--bg-0);color:#fff;',
                'padding:1px 6px;border-radius:3px;',
                'font-size:11px;font-weight:500;pointer-events:none;',
                'letter-spacing:.3px;',
            '}',

            // ---- Info ----
            '.related-info{padding:7px 8px;display:flex;flex-direction:column;gap:4px;}',
            '.related-grid-detailed .related-info{flex:1;justify-content:center;min-width:0;padding:4px 7px;}',
            '.related-name-row{display:flex;align-items:flex-start;gap:4px;}',
            '.related-name{',
                'font-size:11.5px;line-height:1.35;color:var(--text-primary,#e0e0e0);',
                'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
                'flex:1;display:flex;align-items:center;gap:3px;',
            '}',
            '.related-grid-compact .related-name{font-size:10px;}',
            '.related-grid-detailed .related-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
            '.related-grid-detailed .related-score{display:none;}',
            '.related-grid-detailed .related-tags-row{display:none;}',
            '@media (max-width:900px){.related-videos-grid.related-grid-detailed{grid-template-columns:repeat(2,minmax(0,1fr));}}',
            '@media (max-width:560px){.related-videos-grid.related-grid-detailed{grid-template-columns:minmax(0,1fr);}}',

            // ---- Badges ----
            '.related-badge{font-size:11px;flex-shrink:0;line-height:1;}',
            '.related-badge-sem{}',
            '.related-badge-fb{}',
            '.related-badge-col{}',

            // ---- Botón "¿Por qué?" ----
            '.related-why-btn{',
                'flex-shrink:0;width:16px;height:16px;',
                'background:var(--bg-3);',
                'border:1px solid var(--bg-5);',
                'border-radius:50%;color:var(--text-secondary,#aaa);',
                'font-size:9px;font-weight:700;cursor:pointer;',
                'display:flex;align-items:center;justify-content:center;',
                'transition:background .15s;padding:0;line-height:1;',
            '}',
            '.related-why-btn:hover{background:var(--bg-4);}',

            // ---- Tags chips ----
            '.related-tags-row{display:flex;flex-wrap:wrap;gap:3px;}',
            '.related-tag-chip{',
                'font-size:9px;padding:1px 5px;border-radius:3px;',
                'background:rgba(124,106,247,0.2);color:#b0a0ff;',
                'border:1px solid rgba(124,106,247,0.3);',
                'white-space:nowrap;max-width:70px;',
                'overflow:hidden;text-overflow:ellipsis;',
            '}',
            '.related-tag-more{background:var(--bg-3);color:var(--text-secondary,#aaa);}',
            '.related-grid-compact .related-tags-row{display:none;}',

            // ---- Barras de puntuación ----
            '.related-score{',
                'position:relative;height:14px;',
                'display:flex;align-items:center;gap:5px;',
            '}',
            '.related-score-bars{',
                'position:relative;flex:1;height:100%;',
                'background:var(--bg-3);border-radius:2px;overflow:hidden;',
            '}',
            '.related-score-bar-total{',
                'position:absolute;left:0;top:0;height:100%;',
                'background:var(--accent-color,#4a9eff);opacity:.2;',
                'border-radius:2px;transition:width .35s ease;',
            '}',
            '.related-score-bar-sem{',
                'position:absolute;left:0;top:0;height:100%;',
                'background:#7c6af7;opacity:.35;',
                'border-radius:2px;transition:width .35s ease;',
            '}',
            '.related-video-item:hover .related-score-bar-total{opacity:.38;}',
            '.related-score-text{',
                'font-size:10px;color:var(--text-secondary,#aaa);',
                'font-weight:500;white-space:nowrap;flex-shrink:0;',
            '}',

            // ---- Footer ----
            '.related-videos-footer{margin-top:10px;display:flex;justify-content:center;}',
            '.related-ver-mas-btn{',
                'background:var(--bg-3);color:var(--text-secondary,#aaa);',
                'border:1px solid var(--bg-5);border-radius:6px;',
                'padding:5px 18px;font-size:12px;cursor:pointer;',
                'transition:background .15s,color .15s;',
            '}',
            '.related-ver-mas-btn:hover{',
                'background:var(--bg-4);color:var(--text-primary,#e0e0e0);',
            '}',

            // ---- Skeleton ----
            '.related-skeleton{pointer-events:none;cursor:default;}',
            '.related-sk-block,.related-sk-line{',
                'background:linear-gradient(90deg,rgba(255,255,255,0.05) 25%,',
                'rgba(255,255,255,0.11) 50%,rgba(255,255,255,0.05) 75%);',
                'background-size:200% 100%;animation:vpRecSkeleton 1.4s infinite;',
                'border-radius:4px;',
            '}',
            '.related-sk-block{width:100%;aspect-ratio:16/9;}',
            '.related-sk-title{height:10px;width:85%;margin-bottom:4px;}',
            '.related-sk-sub{height:8px;width:55%;margin-bottom:3px;}',
            '.related-sk-tags{height:7px;width:40%;}',
            '.related-sort-select{',
                'background:var(--bg-2);',
                'border:1px solid var(--bg-5);',
                'border-radius:5px;color:var(--text-primary,#e0e0e0);',
                'font-size:11px;padding:3px 18px 3px 6px;cursor:pointer;',
                'appearance:none;-webkit-appearance:none;',
                'background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%23888\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E");',
                'background-repeat:no-repeat;background-position:right 6px center;',
            '}',
            '.related-sort-select option{',
                'background:var(--bg-2);color:var(--text-primary,#e0e0e0);',
            '}',

            // ---- Tooltip "¿Por qué?" ----
            '.related-why-tooltip{',
                'position:absolute;z-index:100;',
                'background:var(--bg-2);',
                'border:1px solid rgba(124,106,247,0.4);',
                'border-radius:8px;padding:12px 14px;',
                'min-width:200px;max-width:260px;',
                'box-shadow:0 8px 32px rgba(0,0,0,0.5);',
                'font-size:11px;',
            '}',
            '.why-header{font-weight:700;color:#b0a0ff;margin-bottom:6px;font-size:12px;}',
            '.why-total{color:var(--text-secondary,#aaa);margin-bottom:8px;font-size:11px;}',
            '.why-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;}',
            '.why-label{font-size:10px;color:var(--text-secondary,#aaa);width:65px;flex-shrink:0;}',
            '.why-bar-wrap{flex:1;height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden;}',
            '.why-bar{height:100%;border-radius:3px;transition:width .3s;}',
            '.why-pct{font-size:10px;color:var(--text-secondary,#aaa);width:28px;text-align:right;}',
            '.why-flags{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;}',
            '.why-flag{',
                'font-size:9px;padding:2px 6px;border-radius:3px;',
                'background:var(--bg-3);color:var(--text-secondary,#aaa);',
            '}',

            // ---- Animaciones ----
            '@keyframes vpRecFadeIn{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}',
            '@keyframes vpRecSkeleton{0%{background-position:200% 0}100%{background-position:-200% 0}}',
        ].join('');

        document.head.appendChild(style);
    }

    // ============================================================
    // SECCIÓN 30 — API PÚBLICA
    // ============================================================

    VP.recomendacionesIA = {

        /** Obtiene recomendaciones para un vídeo (sincrónico, usa caché). */
        getRecomendaciones: function (vidId, maxResults) {
            return _getRecomendaciones(vidId, maxResults);
        },

        /** Cómputo sincrónico inmediato (usa embeddings ya en LRU). */
        computeForVideo: function (vidId, opts) {
            return _computeForVideoSync(vidId, opts);
        },

        /** Cómputo asíncrono: espera embeddings de Ollama si necesario. */
        computeForVideoAsync: function (vidId, opts) {
            return _computeForVideoAsync(vidId, opts);
        },

        /** Pre-carga caché de recomendaciones desde LS/IDB. */
        preloadAll: _preloadAll,

        /** Recomputa todas las recomendaciones en segundo plano. */
        recomputeAll: function (force) { _recomputeAll(!!force); },

        /** Invalida la caché de un vídeo concreto. */
        invalidarVideo: function (vidId) { _invalidarVideo(vidId); },

        /** Limpia toda la caché de recomendaciones. */
        clearCache: _clearCache,

        /** Limpia toda la caché de embeddings. */
        clearEmbeddingCache: _clearEmbeddingCache,

        /** Muestra el panel con un array de recomendaciones. */
        mostrarPanel: function (recoms) { _mostrarRecomendaciones(recoms); },

        /** Oculta el panel. */
        ocultarPanel: function () {
            var panel = document.getElementById('relatedVideosPanel');
            if (panel) panel.style.display = 'none';
        },

        /** Obtiene el embedding de un vídeo (async). */
        getEmbedding: function (video) {
            return _getEmbedding(video).then(function (vec) {
                return vec && Array.prototype.slice.call(vec);
            });
        },

        /** Calcula similitud coseno entre dos vectores. */
        cosineSimilarity: function (vecA, vecB) { return _cosineSimilarity(vecA, vecB); },

        /** Fuerza verificación de disponibilidad de Ollama y encola embeddings. */
        checkOllama: function () {
            _s._ollamaCheckEpoch++;
            _s._ollamaChecked = false;
            _s._ollamaChecking = false;
            if (_s._ollamaCheckTimer) clearTimeout(_s._ollamaCheckTimer);
            _s._ollamaCheckTimer = null;
            _checkOllamaAvailability();
        },

        /** Encola cómputo de embeddings para todos los vídeos sin embedding. */
        enqueueAllEmbeddings: function () { _enqueueAllEmbeddings(); },

        /** Registra un clic colaborativo (desde → hacia). */
        trackClick: function (fromId, toId) { _clicks.record(fromId, toId); },

        /** Devuelve los vídeos más clicados desde un vídeo dado. */
        getTopClicked: function (fromId, n) { return _clicks.getTopFrom(fromId, n); },

        /** Aplica decaimiento a los clics colaborativos. */
        decayClicks: function () { _clicks.decay(); },

        /** Limpia todos los clics colaborativos. */
        clearClicks: function () { _clicks.clear(); },

        /** Modifica la configuración en caliente. */
        setConfig: function (overrides) {
            if (!overrides || typeof overrides !== 'object') return;
            var ollamaUrl;
            var embeddingModel;
            var numericLimits = {
                EMBED_TIMEOUT_MS: [1000, 300000],
                EMBED_MAX_RETRIES: [0, 5],
                EMBED_RETRY_BASE_MS: [100, 30000],
                EMBED_MAX_TEXT_CHARS: [64, 20000],
                MAX_EMBED_CONCURRENCY: [1, 8],
                PRELOAD_TIMEOUT_MS: [1000, 120000],
                EMBED_BATCH_DELAY_MS: [0, 10000],
            };
            for (var k in overrides) {
                if (!Object.prototype.hasOwnProperty.call(overrides, k) || !Object.prototype.hasOwnProperty.call(CFG, k)) continue;
                if (k === 'OLLAMA_URL') { ollamaUrl = overrides[k]; continue; }
                if (k === 'EMBEDDING_MODEL') { embeddingModel = overrides[k]; continue; }
                if (numericLimits[k]) {
                    var numericValue = Number(overrides[k]);
                    if (!isFinite(numericValue) || numericValue < numericLimits[k][0] || numericValue > numericLimits[k][1]) continue;
                    CFG[k] = Math.floor(numericValue);
                } else {
                    CFG[k] = overrides[k];
                }
            }
            log.info('setConfig aplicado:', overrides);
            var applySensitiveSettings = Promise.resolve(true);
            if (typeof ollamaUrl !== 'undefined') {
                applySensitiveSettings = applySensitiveSettings.then(function () {
                    return VP.recomendacionesIA.setOllamaUrl(ollamaUrl);
                });
            }
            if (typeof embeddingModel !== 'undefined') {
                applySensitiveSettings = applySensitiveSettings.then(function () {
                    return VP.recomendacionesIA.setEmbeddingModel(embeddingModel);
                });
            }
            return applySensitiveSettings;
        },

        /** Cambia la URL de Ollama en caliente. */
        setOllamaUrl: function (url) {
            var normalized;
            try {
                normalized = VP.ollama && typeof VP.ollama.normalizeBase === 'function'
                    ? VP.ollama.normalizeBase(url)
                    : String(url || '').trim().replace(/\/+$/, '');
                if (!normalized) return false;
                if (!VP.ollama || typeof VP.ollama.normalizeBase !== 'function') {
                    var fallbackUrl = new URL(normalized);
                    if (fallbackUrl.protocol !== 'http:' && fallbackUrl.protocol !== 'https:') return false;
                    normalized = fallbackUrl.href.replace(/\/+$/, '');
                }
            } catch (e) {
                log.warn('URL de Ollama inválida:', e.message || e);
                return false;
            }
            if (normalized === CFG.OLLAMA_URL) {
                _s._ollamaChecked = false;
                _s._ollamaChecking = false;
                _s._ollamaCheckEpoch++;
                if (_s._ollamaCheckTimer) clearTimeout(_s._ollamaCheckTimer);
                _s._ollamaCheckTimer = null;
                _checkOllamaAvailability();
                return true;
            }
            CFG.OLLAMA_URL = normalized;
            _s._ollamaAvailable = null;
            _s._embeddingModelAvailable = null;
            _s._ollamaChecked = false;
            _s._ollamaChecking = false;
            _s._ollamaCheckEpoch++;
            if (_s._ollamaCheckTimer) clearTimeout(_s._ollamaCheckTimer);
            _s._ollamaCheckTimer = null;
            return _clearEmbeddingCache().then(function () {
                _checkOllamaAvailability();
                return true;
            });
        },

        /** Cambia el modelo de embeddings en caliente. */
        setEmbeddingModel: function (model) {
            if (typeof model !== 'string' || !model.trim()) return Promise.resolve(false);
            model = model.trim();
            if (model === CFG.EMBEDDING_MODEL) return Promise.resolve(true);
            CFG.EMBEDDING_MODEL = model;
            _s._embeddingModelAvailable = null;
            _s._ollamaChecked = false;
            _s._ollamaChecking = false;
            _s._ollamaCheckEpoch++;
            if (_s._ollamaCheckTimer) clearTimeout(_s._ollamaCheckTimer);
            _s._ollamaCheckTimer = null;
            log.info('Modelo de embeddings cambiado a:', model);
            return _clearEmbeddingCache().then(function () {
                _checkOllamaAvailability();
                _updateStatsUI();
                return true;
            });
        },

        /** Registra un callback para cuando el módulo está listo. */
        onReady: function (cb) {
            if (typeof cb !== 'function') return;
            if (_s._ready) { cb(); return; }
            _s._readyCallbacks.push(cb);
        },

        /** Devuelve estadísticas del módulo. */
        getStats: function () {
            return {
                version          : '3.0.0',
                cacheSize        : _cacheLRU.size(),
                indexSize        : _index.getAll().length,
                embedCacheSize   : _embedLRU.size(),
                embedIndexSize   : _embedIndex.getAll().length,
                embedDone        : _s._embedDone,
                embedErrors      : _s._embedErrors,
                embedTotal       : _s._embedTotal,
                embedRunning     : _s._embedRunning,
                ollamaAvailable  : _s._ollamaAvailable,
                uiCreated        : _s._uiCreated,
                currentVid       : _s._currentVidId,
                recomsTotal      : _s._recoms ? _s._recoms.length : 0,
                recomsVisible    : _s._recomsVisible,
                preloaded        : !!_s._preloaded,
                bgQueueSize      : _cantidadBgPendiente(),
                bgRunning        : _s._bgRunning,
                cacheTTL_h       : CFG.CACHE_TTL_MS / 3600000,
                embedCacheTTL_d  : CFG.EMBED_CACHE_TTL_MS / 86400000,
                mmrLambda        : CFG.MMR_LAMBDA,
                ollamaUrl        : CFG.OLLAMA_URL,
                embeddingModel   : CFG.EMBEDDING_MODEL,
                configWeights: {
                    TAG        : CFG.TAG_WEIGHT,
                    SEMANTIC   : CFG.SEMANTIC_WEIGHT,
                    NAME       : CFG.NAME_WEIGHT,
                    DUR        : CFG.DURATION_WEIGHT,
                    COLLAB     : CFG.COLLAB_WEIGHT,
                    FALLBACK_NAME : CFG.FALLBACK_NAME_WEIGHT,
                    FALLBACK_DUR  : CFG.FALLBACK_DURATION_WEIGHT,
                },
            };
        },

        obtenerMetricas : function () { return this.getStats(); },
        getCachedSize   : function () { return _cacheLRU.size(); },
        getIndexSize    : function () { return _index.getAll().length; },
        getEmbedCacheSize: function () { return _embedLRU.size(); },

        /** Destruye el módulo limpiando todos los recursos. */
        destroy: function () {
            _s._destroyed = true;
            _cancelPreloadWork();

            // Abortar todas las peticiones fetch en curso via guard
            _s._guard.abortAll();

            // Cancelar promesas de embedding en vuelo (no se resuelven)
            var pendingKeys = Object.keys(_s._pendingEmbeds);
            for (var pi = 0; pi < pendingKeys.length; pi++) {
                delete _s._pendingEmbeds[pendingKeys[pi]];
            }

            // Remover todos los listeners del bus registrados por este módulo
            bus.offModule(_s._moduleId);

            // Limpiar todos los timers vía guard
            _s._guard.clearAllTimers();

            _limpiarColaBg();
            _s._bgRunning          = false;
            _s._embedQueue.length  = 0;
            _s._embedRunning       = false;
            _s._embedQueueDedup    = Object.create(null);

            _clearEmbeddingCache();

            var panel = document.getElementById('relatedVideosPanel');
            if (panel && panel.parentNode) panel.parentNode.removeChild(panel);

            var styleEl = document.getElementById('vp-recomendaciones-ia-styles');
            if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);

            _s._uiCreated        = false;
            _s._recoms           = [];
            _s._recomsFiltered   = [];
            _s._recomsVisible    = 0;
            _s._currentVidId     = null;
            _s._cssInjected      = false;
            _s._initialized      = false;
            _s._ready            = false;
            _s._ollamaAvailable  = null;

            window.__VP_RECOMENDACIONES_IA_LOADED__ = false;

            // Destruir guard permanentemente
            _s._guard.destroy();

            log.info('Módulo v3.0.0 destruido.');
        },
    };

    window.VP_RecomendacionesIA = VP.recomendacionesIA;

    // ============================================================
    // SECCIÓN 31 — INICIALIZACIÓN
    // ============================================================

    function _init() {
        if (_s._initialized) return;
        _s._initialized = true;

        _injectCSS();
        _crearUI();
        _registerEvents();
        _preloadAll();

        // Verificar Ollama con pequeño retraso para no bloquear arranque
        _s._ollamaCheckTimer = _s._guard.setTimeout(_checkOllamaAvailability, 1500);

        _s._ready = true;
        for (var i = 0; i < _s._readyCallbacks.length; i++) {
            try { _s._readyCallbacks[i](); } catch (e) { log.warn('onReady callback error', e); }
        }
        _s._readyCallbacks.length = 0;

        if (VP.estado && VP.estado.videos && VP.estado.videos.length > 0) {
            _onVideosCargados();
        }

        log.info(
            'v3.0.0 iniciado | cache:', _cacheLRU.size(),
            '| embedCache:', _embedLRU.size(),
            '| index:', _index.getAll().length,
            '| Ollama:', CFG.OLLAMA_URL,
            '| EMB model:', CFG.EMBEDDING_MODEL
        );
    }

    function _waitForVP() {
        var done = false, att = 0;
        function tryInit() {
            if (done) return;
            done = true;
            document.removeEventListener('vpReady', tryInit);
            _init();
        }
        function poll() {
            if (done) return;
            if (++att > 200) { tryInit(); return; }
            if (VP.log && VP.bus && VP.dom && VP.util) { tryInit(); return; }
            setTimeout(poll, 25);
        }
        document.addEventListener('vpReady', tryInit);
        poll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _waitForVP);
    } else {
        _waitForVP();
    }

    log.info('vp-recomendaciones-ia.js v3.0.0 cargado');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-recomendaciones-ia.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
