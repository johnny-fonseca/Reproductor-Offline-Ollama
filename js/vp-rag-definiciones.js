'use strict';
// =============================================================================
// VP-RAG-DEFINICIONES.JS — recupera explicaciones y definiciones del video.
// Busca el término consultado junto a expresiones definitorias y devuelve
// fragmentos con offsets para resaltar el término y la explicación.
// Requiere: vp-rag-core.js (VP.rag.subtitleIndex)
// =============================================================================

(function (window) {
    'use strict';

    if (window.__VP_RAG_DEFINICIONES_LOADED__) return;
    window.__VP_RAG_DEFINICIONES_LOADED__ = true;

    var VP = window.VP;
    if (!VP || !VP.rag) throw new Error('[VP] vp-rag-definiciones.js: vp-rag-core.js debe cargarse primero.');

    VP.rag.definitionSearch = (function () {

        var QUERY_PATTERNS = [
            /\b(?:qu[eé])\s+(?:significa|quiere\s+decir|es|representa)\s+(.+)$/i,
            /\b(?:en\s+qu[eé]\s+consiste)\s+(.+)$/i,
            /\b(?:a\s+qu[eé]\s+se\s+refiere)\s+(.+)$/i,
            /\b(?:dame\s+la\s+definici[oó]n\s+de|definici[oó]n\s+(?:de|del?)|define|definir|explica|explicas|explicar|expl[ií]came|explique|describe|describes)\s+(.+)$/i,
            /\bwhat\s+does\s+(.+?)\s+mean(?:\s+.+)?\s*[?.!]*$/i,
            /\bwhat\s+is\s+meant\s+by\s+(.+?)(?:\s+.+)?\s*[?.!]*$/i,
            /\bwhat\s+is\s+(.+?)\s*[?.!]*$/i,
            /\b(?:define|explain|meaning\s+of)\s+(.+)$/i,
        ];

        // Las expresiones más específicas van primero para distinguirlas del "es" genérico.
        var DEFINITION_PATTERNS = [
            /\b(?:se\s+define\s+como|se\s+defini[oó]\s+como|se\s+entiende\s+(?:por|como)|se\s+refiere\s+a|consiste\s+en|quiere\s+decir|quieren\s+decir|se\s+llama|se\s+conoce\s+como|se\s+denomina|se\s+traduce\s+en|por\s+definici[oó]n|is\s+defined\s+as|is\s+known\s+as|is\s+called|refers\s+to|consists?\s+of|means)\b/gi,
            /\b(?:es|son|era|fue|representa|representan|is|are|was|were)\b/gi,
        ];

        var MAX_DISTANCE_CHARS = 190;

        function _cleanTopic(value) {
            var topic = String(value || '').trim();
            topic = topic.replace(/^[\s"“”'‘’«»`.,;:!?¿¡]+|[\s"“”'‘’«»`.,;:!?¿¡]+$/g, '');
            topic = topic.replace(/^(?:(?:el|la|los|las|un|una|unos|unas|the|a|an)\s+)+/i, '');
            topic = topic.replace(/^(?:(?:t[eé]rmino|concepto|palabra|term|concept|word)\s+)/i, '');
            topic = topic.replace(/^(?:qu[eé]\s+(?:es|significa)\s+)/i, '');
            topic = topic.replace(/\s+(?:seg[uú]n\s+(?:(?:el|este)\s+)?video|en\s+(?:(?:el|este)\s+)?video|according\s+to\s+(?:(?:the|this)\s+)?video|in\s+(?:(?:the|this)\s+)?video)\s*$/i, '');
            topic = topic.replace(/\s+(?:y|and)\s+(?:c[oó]mo|how|por\s+qu[eé]|why|cu[aá]ndo|when|d[oó]nde|where)\b.*$/i, '');
            return topic.replace(/[\s"“”'‘’«»`.,;:!?¿¡]+$/g, '').trim();
        }

        function extractTopic(query) {
            var source = String(query || '').trim();
            if (!source) return '';

            for (var i = 0; i < QUERY_PATTERNS.length; i++) {
                var match = source.match(QUERY_PATTERNS[i]);
                if (match && match[1]) {
                    var topic = _cleanTopic(match[1]);
                    if (topic.length >= 2) return topic;
                }
            }
            return '';
        }

        function _fold(text) {
            return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        }

        function _normalize(text) {
            return _fold(text).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        }

        function _normalizeWithOffsets(text) {
            var output = '';
            var starts = [];
            var ends = [];

            for (var i = 0; i < text.length; i++) {
                var folded = _fold(text.charAt(i));
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

        function _findTopicRanges(text, topic) {
            var needle = _normalize(topic);
            if (needle.length < 2) return [];

            var mapped = _normalizeWithOffsets(text);
            var ranges = [];
            var from = 0;
            while (from <= mapped.text.length - needle.length) {
                var idx = mapped.text.indexOf(needle, from);
                if (idx < 0) break;
                var before = idx > 0 ? mapped.text.charAt(idx - 1) : '';
                var afterIdx = idx + needle.length;
                var after = afterIdx < mapped.text.length ? mapped.text.charAt(afterIdx) : '';
                if ((!/[a-z0-9_]/.test(needle.charAt(0)) || !/[a-z0-9_]/.test(before)) &&
                    (!/[a-z0-9_]/.test(needle.charAt(needle.length - 1)) || !/[a-z0-9_]/.test(after))) {
                    ranges.push({ start: mapped.starts[idx], end: mapped.ends[afterIdx - 1] });
                }
                from = idx + Math.max(needle.length, 1);
            }
            return ranges;
        }

        function _findDefinitionCues(text) {
            var found = [];
            for (var pi = 0; pi < DEFINITION_PATTERNS.length; pi++) {
                var pattern = DEFINITION_PATTERNS[pi];
                pattern.lastIndex = 0;
                var match;
                while ((match = pattern.exec(text)) !== null) {
                    found.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
                    if (!match[0].length) pattern.lastIndex++;
                }
            }
            return found;
        }

        function _definitionRange(text, cue) {
            var end = Math.min(text.length, cue.start + 125);
            var sentenceEnd = /[.!?](?:\s|$)/g;
            sentenceEnd.lastIndex = cue.end;
            var punctuation = sentenceEnd.exec(text);
            if (punctuation && punctuation.index < end) end = punctuation.index + 1;
            while (end > cue.end && /\s/.test(text.charAt(end - 1))) end--;
            return { start: cue.start, end: Math.max(cue.end, end) };
        }

        function _resultForCue(cue, topic, topicRanges) {
            var definitions = _findDefinitionCues(cue.text);
            if (!definitions.length) return null;

            var best = null;
            for (var ti = 0; ti < topicRanges.length; ti++) {
                for (var di = 0; di < definitions.length; di++) {
                    var topicRange = topicRanges[ti];
                    var definitionCue = definitions[di];
                    var distance = topicRange.end <= definitionCue.start
                        ? definitionCue.start - topicRange.end
                        : (definitionCue.end <= topicRange.start ? topicRange.start - definitionCue.end : 0);
                    if (distance > MAX_DISTANCE_CHARS) continue;

                    var direct = typeof cue.id === 'number' && cue.id >= 0;
                    var score = 0.86 + Math.max(0, 0.09 - distance / 2200) + (direct ? 0.03 : 0);
                    if (score > 0.99) score = 0.99;
                    if (!best || score > best.score) {
                        var defRange = _definitionRange(cue.text, definitionCue);
                        best = {
                            score: score,
                            cue: cue,
                            topic: topic,
                            definitionText: cue.text.substring(defRange.start, defRange.end),
                            matches: [
                                { start: topicRange.start, end: topicRange.end, matchType: 'topic' },
                                { start: defRange.start, end: defRange.end, matchType: 'definition' },
                            ],
                        };
                    }
                }
            }
            return best;
        }

        function search(opts) {
            opts = opts || {};
            var topic = typeof opts.topic === 'string' ? _cleanTopic(opts.topic) : extractTopic(opts.query);
            var index = opts.subtitleIndex;
            if (!topic || !Array.isArray(index) || !index.length) return [];

            var results = [];
            for (var i = 0; i < index.length; i++) {
                var cue = index[i];
                if (!cue || typeof cue.text !== 'string') continue;
                var topicRanges = _findTopicRanges(cue.text, topic);
                if (!topicRanges.length) continue;
                var result = _resultForCue(cue, topic, topicRanges);
                if (result) results.push(result);
            }

            // Prioriza subtítulos individuales y luego las ventanas que unen
            // una mención del término con su explicación en cues vecinos.
            results.sort(function (a, b) {
                if (b.score !== a.score) return b.score - a.score;
                var aDuration = (a.cue.end || 0) - (a.cue.start || 0);
                var bDuration = (b.cue.end || 0) - (b.cue.start || 0);
                if (aDuration !== bDuration) return aDuration - bDuration;
                return (a.cue.start || 0) - (b.cue.start || 0);
            });

            var unique = [];
            for (var ri = 0; ri < results.length; ri++) {
                var candidate = results[ri];
                var key = _normalize(candidate.definitionText);
                if (!key) continue;
                var duplicate = false;
                for (var ui = 0; ui < unique.length; ui++) {
                    var previous = unique[ui];
                    var previousKey = _normalize(previous.definitionText);
                    var overlaps = (candidate.cue.start || 0) <= (previous.cue.end || 0) &&
                        (previous.cue.start || 0) <= (candidate.cue.end || 0);
                    if (overlaps && (key === previousKey || key.indexOf(previousKey) >= 0 || previousKey.indexOf(key) >= 0)) {
                        duplicate = true;
                        break;
                    }
                }
                if (duplicate) continue;
                unique.push(candidate);
            }

            var maxResults = Number(opts.maxResults) || 4;
            return unique.slice(0, Math.max(1, Math.min(maxResults, 12)));
        }

        return {
            extractTopic: extractTopic,
            isDefinitionQuery: function (query) { return extractTopic(query).length > 0; },
            search: search,
            normalize: _normalize,
        };

    })();

    var log = VP.log || console;
    if (log.info) log.info('vp-rag-definiciones.js v1.0.0 cargado. Módulo: definitionSearch.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-rag-definiciones.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window);
