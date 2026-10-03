'use strict';
// =============================================================================
// VP-RAG-LITERAL.JS  —  v1.0.0
// Módulo de búsqueda literal: exact match, fuzzy, multi-stage retrieval.
// Separado del pipeline semántico para evitar contaminación con embeddings.
//
// FASE 10: Hybrid fallback inteligente con pipeline:
//   1. Exact search  → 2. Fuzzy search  → 3. BM25  → 4. Semantic  → 5. LLM
//
// Requiere: vp-rag-core.js (VP.rag.subtitleIndex, VP.rag.utils)
// =============================================================================

(function (window, document) {
    'use strict';

    if (window.__VP_RAG_LITERAL_LOADED__) return;
    window.__VP_RAG_LITERAL_LOADED__ = true;

    var VP = window.VP;
    if (!VP || !VP.rag) throw new Error('[VP] vp-rag-literal.js: vp-rag-core.js debe cargarse primero.');

    var log = VP.log || console;

    // =========================================================================
    // MÓDULO: LITERAL SEARCH
    // =========================================================================

    VP.rag.literalSearch = (function () {

        // ── Phrase Cache ────────────────────────────────────────────────
        var phraseCache = {};
        var PHRASE_CACHE_MAX = 200;
        var phraseCacheKeys = [];

        function cacheGet(query) { return phraseCache[query] || null; }

        function cacheSet(query, results) {
            if (!phraseCache[query]) {
                phraseCacheKeys.push(query);
                if (phraseCacheKeys.length > PHRASE_CACHE_MAX) {
                    delete phraseCache[phraseCacheKeys.shift()];
                }
            }
            phraseCache[query] = results;
        }

        function cacheClear() {
            phraseCache          = {};
            phraseCacheKeys      = [];
            trigramIndexCache    = null;
            trigramIndexCacheKey = null;
            trigramIndexCacheLen = 0;
        }

        // ── Normalización avanzada ─────────────────────────────────────
        var CONTRACTIONS_EN = {
            "don't": "do not", "doesn't": "does not", "didn't": "did not",
            "won't": "will not", "wouldn't": "would not",
            "can't": "cannot", "couldn't": "could not",
            "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
            "haven't": "have not", "hasn't": "has not", "hadn't": "had not",
            "shouldn't": "should not", "mustn't": "must not", "needn't": "need not",
            "it's": "it is", "that's": "that is", "there's": "there is", "here's": "here is",
            "what's": "what is", "who's": "who is", "where's": "where is", "how's": "how is",
            "he's": "he is", "she's": "she is", "we're": "we are", "they're": "they are",
            "you're": "you are", "i'm": "i am", "i've": "i have", "you've": "you have",
            "we've": "we have", "they've": "they have", "i'll": "i will", "you'll": "you will",
            "he'll": "he will", "she'll": "she will", "we'll": "we will", "they'll": "they will",
            "i'd": "i would", "you'd": "you would", "he'd": "he would", "she'd": "she would",
            "we'd": "we would", "they'd": "they would", "let's": "let us",
            "ain't": "is not", "ma'am": "madam",
        };

        // Nota: "del" y "al" se conservan sin expandir para no romper
        // búsquedas literales donde el usuario escribe esas palabras exactas.
        var CONTRACTIONS_ES = {};  // sin expansiones en español por ahora

        function normalize(text) {
            var s = String(text || '');
            s = s.replace(/-\s*\n\s*/g, '');
            s = s.replace(/\n\s*/g, ' ');
            s = s.replace(/\u2018|\u2019|\u201A|\u201B|\u2032/g, "'");
            s = s.replace(/\u201C|\u201D|\u201E|\u201F|\u2033/g, '"');
            s = s.replace(/\u2013|\u2014/g, '-');
            s = s.replace(/\u00AD/g, '');
            s = s.replace(/\u00A0/g, ' ');
            s = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            s = s.replace(/\b[a-z]+'[a-z]{1,3}\b/g, function (m) { return CONTRACTIONS_EN[m] || m; });
            s = s.replace(/\b[a-z]+\b/g, function (m) { return CONTRACTIONS_ES[m] || m; });
            s = s.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
            return s;
        }

        function normalizeQuery(text) { return normalize(text); }

        // ── Levenshtein ──────────────────────────────────────────────────
        function _levenshtein(a, b) {
            var la = a.length, lb = b.length;
            if (la === 0) return lb;
            if (lb === 0) return la;
            // Early-exit: si la diferencia de longitud supera 8, nunca alcanzará
            // el umbral de similitud de 0.75 para strings de esta longitud.
            // Devolvemos la diferencia real como cota inferior de la distancia.
            if (Math.abs(la - lb) > Math.max(la, lb) * 0.30) {
                return Math.abs(la - lb);
            }
            var prevRow = [];
            for (var j = 0; j <= lb; j++) prevRow[j] = j;
            for (var i = 1; i <= la; i++) {
                var curRow = [i];
                for (var jj = 1; jj <= lb; jj++) {
                    var cost = (a[i - 1] === b[jj - 1]) ? 0 : 1;
                    curRow[jj] = Math.min(prevRow[jj] + 1, curRow[jj - 1] + 1, prevRow[jj - 1] + cost);
                }
                prevRow = curRow;
            }
            return prevRow[lb];
        }

        // ── Raw exact match (original text, no normalization) ────────
        function _searchRawExact(rawQuery, index) {
            if (!rawQuery) return [];
            var results = [];
            for (var i = 0; i < index.length; i++) {
                var line = index[i];
                if (line.text.indexOf(rawQuery) !== -1) {
                    results.push({
                        score    : 1.0,
                        cue      : line,
                        matchType: 'exact',
                    });
                }
            }
            // Si raw exact no encuentra nada, reintentar case-insensitive exact
            if (!results.length) {
                var lowerQuery = rawQuery.toLowerCase();
                for (var j = 0; j < index.length; j++) {
                    var line2 = index[j];
                    if (line2.text.toLowerCase().indexOf(lowerQuery) !== -1) {
                        results.push({
                            score    : 0.95,
                            cue      : line2,
                            matchType: 'normalized',
                        });
                    }
                }
            }
            return results;
        }

        // ── Exact match search (normalized contains) ─────────────────────
        function _searchExactNorm(q, index) {
            var results = [];
            for (var i = 0; i < index.length; i++) {
                var line = index[i];
                if (line.normalized.indexOf(q) !== -1) {
                    results.push({
                        score    : 0.95,
                        cue      : line,
                        matchType: 'normalized',
                    });
                }
            }
            return results;
        }

        // ── Fuzzy Levenshtein search ────────────────────────────────────
        function _searchFuzzy(q, index) {
            var results = [];
            for (var j = 0; j < index.length; j++) {
                var line2 = index[j];
                var dist  = _levenshtein(line2.normalized, q);
                var maxLen = Math.max(line2.normalized.length, q.length);
                if (maxLen === 0) continue;
                // Escalar score de fuzzy a [0.75, 0.85] según similitud
                var sim = 1 - dist / maxLen;
                if (sim >= 0.75) {
                    results.push({
                        score    : 0.65 + sim * 0.2, // escala 0.75→0.80, 1.0→0.85
                        cue      : line2,
                        matchType: 'fuzzy',
                    });
                }
            }
            return results;
        }

        // ── Token overlap search ────────────────────────────────────────
        function _searchToken(q, index) {
            var results = [];
            var queryTokens = q.split(/\s+/);
            for (var k = 0; k < index.length; k++) {
                var line3 = index[k];
                var matchCount = 0;
                var lineTokens = line3.normalized.split(/\s+/);
                for (var qt = 0; qt < queryTokens.length; qt++) {
                    for (var lt = 0; lt < lineTokens.length; lt++) {
                        if (queryTokens[qt] === lineTokens[lt]) {
                            matchCount++;
                            break;
                        }
                    }
                }
                if (matchCount > 0) {
                    var ratio = matchCount / queryTokens.length;
                    results.push({
                        score    : 0.50 + ratio * 0.20, // escala 0→0.50, 1.0→0.70
                        cue      : line3,
                        matchType: 'token',
                    });
                }
            }
            return results;
        }

        // ── Trigram index (FASE 15 — fuzzy ultra rápido) ─────────────────
        function _extractTrigrams(text) {
            var trigrams = {};
            var padded = '\x00\x00' + text + '\x00\x00';
            for (var i = 0; i < padded.length - 2; i++) {
                var tri = padded.substring(i, i + 3);
                trigrams[tri] = (trigrams[tri] || 0) + 1;
            }
            return trigrams;
        }

        function _buildTrigramIndex(index) {
            var triIdx = {};
            for (var i = 0; i < index.length; i++) {
                var line = index[i];
                var trigrams = _extractTrigrams(line.normalized);
                for (var tri in trigrams) {
                    if (Object.prototype.hasOwnProperty.call(trigrams, tri)) {
                        if (!triIdx[tri]) triIdx[tri] = [];
                        triIdx[tri].push(i);
                    }
                }
            }
            return triIdx;
        }

        function _searchTrigram(q, triIdx, index, maxResults) {
            var queryTrigrams = _extractTrigrams(q);
            var scores = {};
            for (var tri in queryTrigrams) {
                if (Object.prototype.hasOwnProperty.call(queryTrigrams, tri)) {
                    var matching = triIdx[tri];
                    if (!matching) continue;
                    for (var mi = 0; mi < matching.length; mi++) {
                        var lid = matching[mi];
                        scores[lid] = (scores[lid] || 0) + 1;
                    }
                }
            }

            var qTriCount = 0;
            for (var qt in queryTrigrams) {
                if (Object.prototype.hasOwnProperty.call(queryTrigrams, qt)) qTriCount++;
            }

            var results = [];
            for (var sid in scores) {
                if (Object.prototype.hasOwnProperty.call(scores, sid)) {
                    var lineIdx = parseInt(sid, 10);
                    var line = index[lineIdx];
                    var lineTrigrams = _extractTrigrams(line.normalized);
                    var lineTriCount = 0;
                    for (var lt in lineTrigrams) {
                        if (Object.prototype.hasOwnProperty.call(lineTrigrams, lt)) lineTriCount++;
                    }
                    var union = qTriCount + lineTriCount - scores[sid];
                    var jaccard = union > 0 ? scores[sid] / union : 0;
                    if (jaccard >= 0.40) {
                        results.push({
                            score    : 0.60 + jaccard * 0.25,
                            cue      : line,
                            matchType: 'trigram',
                        });
                    }
                }
            }
            return results;
        }

        // ── Trigram index cache (FASE 15) ──────────────────────────────
        var trigramIndexCache    = null;
        var trigramIndexCacheKey = null;
        var trigramIndexCacheLen = 0;

        function _getTrigramIndex(index) {
            // Invalida si la referencia o el tamaño del índice cambiaron
            if (trigramIndexCacheKey === index && trigramIndexCacheLen === index.length) {
                return trigramIndexCache;
            }
            trigramIndexCache    = _buildTrigramIndex(index);
            trigramIndexCacheKey = index;
            trigramIndexCacheLen = index.length;
            return trigramIndexCache;
        }

        // ── API principal ────────────────────────────────────────────────

        /**
         * Búsqueda literal multi-nivel.
         *
         * @param {Object} opts
         * @param {string} opts.query          - texto a buscar
         * @param {Array}  opts.subtitleIndex  - índice generado por VP.rag.subtitleIndex.build()
         * @param {boolean} [opts.fuzzy=true]  - permitir fuzzy si exact no encuentra
         * @param {boolean} [opts.trigram=false] - usar trigram index para fuzzy rápido
         * @param {number}  [opts.maxResults=5]
         * @returns {Array} [{ score, matchType, cue }]
         */
        function search(opts) {
            opts = opts || {};
            var query    = opts.query;
            var index    = opts.subtitleIndex;
            var fuzzy    = opts.fuzzy !== false;
            var useTri   = opts.trigram === true;
            var maxRes   = opts.maxResults || 5;

            if (!query || !index || !index.length) return [];

            var q = normalizeQuery(query);
            if (!q) return [];

            // Cache check (usar query original como key)
            var cacheKey = query.toLowerCase().trim();
            var cached = cacheGet(cacheKey);
            if (cached) return cached.slice(0, maxRes);

            var results;

            // FASE 13: Ranking inteligente
            // 1. Raw exact (original text contains)
            results = _searchRawExact(query, index);
            if (results.length) { cacheSet(cacheKey, results); return results.slice(0, maxRes); }

            // 2. Normalized exact
            results = _searchExactNorm(q, index);
            if (results.length) { cacheSet(cacheKey, results); return results.slice(0, maxRes); }

            if (!fuzzy) return [];

            // 3a. Trigram fuzzy (rápido, opcional)
            if (useTri && q.length >= 3) {
                var triIdx = _getTrigramIndex(index);
                results = _searchTrigram(q, triIdx, index, maxRes * 2);
                if (results.length) {
                    results.sort(function (a, b) { return b.score - a.score; });
                    cacheSet(cacheKey, results);
                    return results.slice(0, maxRes);
                }
            }

            // 3b. Fuzzy Levenshtein
            results = _searchFuzzy(q, index);
            if (results.length) {
                results.sort(function (a, b) { return b.score - a.score; });
                cacheSet(cacheKey, results);
                return results.slice(0, maxRes);
            }

            // 4. Token overlap
            results = _searchToken(q, index);
            if (results.length) {
                results.sort(function (a, b) { return b.score - a.score; });
                cacheSet(cacheKey, results);
                return results.slice(0, maxRes);
            }

            return [];
        }

        return {
            search      : search,
            normalize   : normalize,
            cacheClear  : cacheClear,
            buildTrigramIndex: _buildTrigramIndex,
        };

    })();

    if (log.info) log.info('vp-rag-literal.js v1.0.1 cargado. Módulo: literalSearch.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-rag-literal.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
