'use strict';
// =============================================================================
// VP-RAG-TERMINOS.JS — búsqueda puntual de nombres propios y términos.
// Recupera menciones explícitas sin embeddings y devuelve offsets para resaltar
// solo el nombre o término dentro de cada subtítulo.
// Requiere: vp-rag-core.js (VP.rag.subtitleIndex)
// =============================================================================

(function (window) {
    'use strict';

    if (window.__VP_RAG_TERMINOS_LOADED__) return;
    window.__VP_RAG_TERMINOS_LOADED__ = true;

    var VP = window.VP;
    if (!VP || !VP.rag) throw new Error('[VP] vp-rag-terminos.js: vp-rag-core.js debe cargarse primero.');

    VP.rag.termSearch = (function () {

        var QUERY_STOPWORDS = /^(?:a|about|al|algo|alguien|algunas?|algunos?|an|and|any|are|as|at|aparece|busca|buscar|cada|cuando|cu[aá]ndo|cual|cu[aá]l|como|c[oó]mo|con|cuenta|cu[eé]ntame|de|del|describe|d[eé]jame|dime|do|does|d[oó]nde|el|ella|ellas|ello|ellos|en|es|esa|esas|ese|eso|esos|esta|estas|este|esto|estos|explain|explica|for|fue|ha|habla|hablan|hay|is|it|la|las|le|les|lo|los|me|meaning|menciona|mencionan|mi|mis|muy|no|nos|of|or|o|para|por|qu[eé]|que|quien|qui[eé]n|quienes|qui[eé]nes|resume|resumen|resumir|se|show|sobre|su|sus|summarize|te|tell|the|tiene|to|un|una|unas|unos|was|were|when|where|what|which|who|whose|why|with|y|yo)$/i;

        var TRAILING_CONTEXT = /\s+(?:en\s+(?:(?:el|este|ese|la|este mismo|this|the)\s+)?(?:video|v[ií]deo|audio|transcripci[oó]n|transcript|episodio|documental)|in\s+(?:(?:the|this)\s+)?(?:video|audio|transcript|episode)|during\s+(?:this\s+)?(?:video|audio|episode)|durante\s+(?:el\s+)?(?:video|v[ií]deo|audio|episodio)|de\s+este\s+video|aqu[ií])\s*$/i;

        function _cleanCandidate(value, preserveLeadingWords) {
            var term = String(value || '').trim();
            term = term.replace(/^[\s"“”'‘’«»;:!?¿¡]+|[\s"“”'‘’«».,;:!?¿¡]+$/g, '');
            if (!preserveLeadingWords) {
                term = term.replace(/^(?:(?:a|al|el|la|los|las|un|una|unos|unas|the|a|an)\s+)+/i, '');
                term = term.replace(/^(?:(?:t[eé]rmino|palabra|nombre(?:\s+propio)?|term|word|name|proper\s+name)\s+)/i, '');
            }
            var previous;
            do {
                previous = term;
                term = term.replace(TRAILING_CONTEXT, '').trim();
            } while (term !== previous);
            return term.replace(/[\s"“”'‘’«».,;:!?¿¡]+$/g, '').trim();
        }

        function _splitTerms(candidate, preserveLeadingWords) {
            return String(candidate || '').split(/\s+(?:y|o|and|or)\s+|[,;]+/i)
                .map(function (part) { return _cleanCandidate(part, preserveLeadingWords); })
                .filter(function (part) { return part.length >= 2; });
        }

        /** Extrae objetivos solo cuando la consulta indica búsqueda de menciones. */
        function extractTerms(query) {
            var source = String(query || '').trim();
            if (!source) return [];

            var terms = [];
            var quoted = /["“]([^"”]+)["”]|'([^']+)'|‘([^’]+)’/g;
            var quoteMatch;
            while ((quoteMatch = quoted.exec(source)) !== null) {
                var quotedTerm = _cleanCandidate(quoteMatch[1] || quoteMatch[2] || quoteMatch[3], true);
                if (quotedTerm) terms.push(quotedTerm);
            }

            // Las comillas expresan una búsqueda puntual incluso dentro de una pregunta.
            if (!terms.length) {
                var patterns = [
                    /\b(?:find|search(?:\s+for)?|look\s+for|locate)\s+(?:(?:the|a|an)\s+)?(?:(?:term|word|name|proper\s+name)\s+)?(?:of\s+)?(.+)$/i,
                    /\b(?:term|word|name|proper\s+name|mentions?|reference|references)\s+(?:of|to)?\s*(.+)$/i,
                    /\b(?:mentions?|mentioned|nombra(?:n)?|nombran|mencionad[oa]s?|aparece(?:n)?|apareci[oó]|occurred?|said|says|quotes?|talks\s+about|refers\s+to)\s+(?:(?:the\s+)?(?:term|word|name)\s+)?(.+)$/i,
                    /\b(?:where|when)\s+(?:is|was|does|do)?\s*(.+?)\s+(?:mentioned|appears?|said|quoted)\b/i,
                    /\b(?:busca(?:r)?|encuentra|encontrar|localiza(?:r)?)\s+(?:(?:el|la|los|las)\s+)?(?:(?:t[eé]rmino|palabra|nombre(?:\s+propio)?)\s+)?(?:de\s+)?(.+)$/i,
                    /\b(?:t[eé]rmino|palabra|nombre(?:\s+propio)?|menci[oó]n(?:es)?|referencia)\s+(?:de|a)?\s*(.+)$/i,
                    /\b(?:menciona(?:n)?|mencion[oó]|mencionaron|mencionad[oa]s?|nombra(?:n)?|nombr[oó]|nombraron|nombrad[oa]s?|aparece(?:n)?|apareci[oó]|dice(?:n)?|dij[oó]|dijeron|cita(?:n)?|cit[oó]|citaron|habla\s+de|hablan\s+de|habl[oó]\s+de|hablaron\s+de|se\s+refiere\s+a)\s+(?:(?:a|el\s+t[eé]rmino|la\s+palabra|el\s+nombre\s+de)\s+)?(.+)$/i,
                    /\b(?:busca|encuentra|localiza|d[oó]nde\s+(?:se\s+)?(?:menciona|dice|aparece)|cu[aá]ndo\s+(?:se\s+)?(?:menciona|dice|aparece)|en\s+qu[eé]\s+parte\s+(?:se\s+)?(?:menciona|dice|aparece))\s+(?:(?:a|el\s+t[eé]rmino|la\s+palabra)\s+)?(.+)$/i,
                ];

                for (var pi = 0; pi < patterns.length; pi++) {
                    var match = source.match(patterns[pi]);
                    if (match && match[1]) {
                        terms = _splitTerms(match[1], false);
                        if (terms.length) break;
                    }
                }
            }

            // Un nombre o término escrito sin pregunta también funciona como objetivo.
            if (!terms.length && !/[?¿]/.test(source)) {
                var simple = _cleanCandidate(source, true);
                var words = simple.split(/\s+/).filter(Boolean);
                if (words.length >= 1 && words.length <= 4 && !words.some(function (word) {
                    return QUERY_STOPWORDS.test(word);
                })) {
                    terms = [simple];
                }
            }

            var seen = Object.create(null);
            return terms.filter(function (term) {
                var key = _normalize(term);
                if ((!key && term.length < 2) || (key.length < 2 && term.length < 2)) return false;
                key = key || term.toLowerCase();
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });
        }

        function _fold(text) {
            return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        }

        function _normalize(text) {
            return _fold(text).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        }

        function _isWordChar(ch) {
            return !!ch && /[A-Za-z0-9_áéíóúüñÁÉÍÓÚÜÑ]/.test(ch);
        }

        function _pushRawMatches(text, term, matches) {
            var haystack = text.toLowerCase();
            var needle = term.toLowerCase();
            if (!needle) return;
            var from = 0;
            while (from <= haystack.length - needle.length) {
                var idx = haystack.indexOf(needle, from);
                if (idx < 0) break;
                var before = idx > 0 ? text.charAt(idx - 1) : '';
                var afterIdx = idx + term.length;
                var after = afterIdx < text.length ? text.charAt(afterIdx) : '';
                var startsWord = _isWordChar(term.charAt(0));
                var endsWord = _isWordChar(term.charAt(term.length - 1));
                if ((!startsWord || !_isWordChar(before)) && (!endsWord || !_isWordChar(after))) {
                    matches.push({ start: idx, end: afterIdx, matchType: 'exact' });
                }
                from = idx + Math.max(needle.length, 1);
            }
        }

        function _normalizeWithOffsets(text) {
            var output = '';
            var starts = [];
            var ends = [];

            for (var i = 0; i < text.length; i++) {
                var raw = text.charAt(i);
                var folded = _fold(raw);
                for (var fi = 0; fi < folded.length; fi++) {
                    var ch = folded.charAt(fi);
                    if (/[a-z0-9_]/.test(ch)) {
                        output += ch;
                        starts.push(i);
                        ends.push(i + 1);
                    } else if (output && output.charAt(output.length - 1) !== ' ') {
                        output += ' ';
                        starts.push(i);
                        ends.push(i + 1);
                    }
                }
            }

            if (output.charAt(output.length - 1) === ' ') {
                output = output.slice(0, -1);
                starts.pop();
                ends.pop();
            }
            return { text: output, starts: starts, ends: ends };
        }

        function _pushNormalizedMatches(text, term, matches) {
            var needle = _normalize(term);
            if (needle.length < 2) return;
            var mapped = _normalizeWithOffsets(text);
            var from = 0;
            while (from <= mapped.text.length - needle.length) {
                var idx = mapped.text.indexOf(needle, from);
                if (idx < 0) break;
                var before = idx > 0 ? mapped.text.charAt(idx - 1) : '';
                var afterIdx = idx + needle.length;
                var after = afterIdx < mapped.text.length ? mapped.text.charAt(afterIdx) : '';
                if ((!/[a-z0-9_]/.test(needle.charAt(0)) || !/[a-z0-9_]/.test(before)) &&
                    (!/[a-z0-9_]/.test(needle.charAt(needle.length - 1)) || !/[a-z0-9_]/.test(after))) {
                    matches.push({
                        start: mapped.starts[idx],
                        end: mapped.ends[afterIdx - 1],
                        matchType: 'normalized',
                    });
                }
                from = idx + Math.max(needle.length, 1);
            }
        }

        /**
         * Busca las menciones exactas de términos en subtítulos individuales.
         * @param {Object} opts { query, terms?, subtitleIndex, maxResults? }
         * @returns {Array} [{ score, cue, matches:[{term,start,end,matchType}] }]
         */
        function search(opts) {
            opts = opts || {};
            var index = opts.subtitleIndex;
            var terms = Array.isArray(opts.terms) ? opts.terms.slice() : extractTerms(opts.query);
            if (!Array.isArray(index) || !index.length || !terms.length) return [];

            var byCue = Object.create(null);
            for (var ti = 0; ti < terms.length; ti++) {
                var term = String(terms[ti] || '').trim();
                if (!term || (_normalize(term).length < 2 && term.length < 2)) continue;

                for (var ci = 0; ci < index.length; ci++) {
                    var cue = index[ci];
                    if (!cue || typeof cue.text !== 'string' || (typeof cue.id === 'number' && cue.id < 0)) continue;

                    var found = [];
                    _pushRawMatches(cue.text, term, found);
                    _pushNormalizedMatches(cue.text, term, found);
                    if (!found.length) continue;

                    var key = String(cue.id);
                    if (!byCue[key]) byCue[key] = { score: 0, cue: cue, matches: [] };
                    var result = byCue[key];
                    for (var fi = 0; fi < found.length; fi++) {
                        var candidate = found[fi];
                        var duplicate = false;
                        for (var mi = 0; mi < result.matches.length; mi++) {
                            if (result.matches[mi].start === candidate.start && result.matches[mi].end === candidate.end) {
                                duplicate = true;
                                if (candidate.matchType === 'exact') result.matches[mi].matchType = 'exact';
                                break;
                            }
                        }
                        if (!duplicate) {
                            candidate.term = term;
                            result.matches.push(candidate);
                            if (candidate.matchType === 'exact') result.score = 1;
                            else if (result.score < 0.98) result.score = 0.98;
                        }
                    }
                }
            }

            var results = Object.keys(byCue).map(function (key) { return byCue[key]; });
            results.forEach(function (result) {
                result.matches.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
                result.matchType = result.matches[0] ? result.matches[0].matchType : 'exact';
            });
            results.sort(function (a, b) {
                if (b.score !== a.score) return b.score - a.score;
                return (a.cue.start || 0) - (b.cue.start || 0);
            });

            var maxResults = Number(opts.maxResults) || 8;
            return results.slice(0, Math.max(1, Math.min(maxResults, 30)));
        }

        return {
            extractTerms: extractTerms,
            isTermQuery: function (query) { return extractTerms(query).length > 0; },
            search: search,
            normalize: _normalize,
        };

    })();

    var log = VP.log || console;
    if (log.info) log.info('vp-rag-terminos.js v1.0.0 cargado. Módulo: termSearch.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-rag-terminos.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window);
