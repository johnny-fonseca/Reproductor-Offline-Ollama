'use strict';
// =============================================================================
// VP-RAG-PASOS.JS — encuentra y ordena pasos descritos en los subtítulos.
// Recupera cues con marcadores de secuencia o acciones, vinculados al tema
// consultado y cercanos a una mención de ese tema.
// =============================================================================

(function (window) {
    'use strict';

    if (window.__VP_RAG_PASOS_LOADED__) return;
    window.__VP_RAG_PASOS_LOADED__ = true;

    var VP = window.VP;
    if (!VP || !VP.rag) throw new Error('[VP] vp-rag-pasos.js: vp-rag-core.js debe cargarse primero.');

    VP.rag.stepSearch = (function () {

        var QUERY_PATTERNS = [
            /\b(?:pasos?|paso\s+a\s+paso)\s+(?:para|de|sobre)\s+(.+)$/i,
            /\b(?:instrucciones?|procedimiento|proceso)\s+(?:para|de)\s+(.+)$/i,
            /\b(?:c[oó]mo)\s+(?:se\s+)?(?:hace|hacer|realiza|realizar|configura|configuro|configurar|instala|instalo|instalar|conecta|conecto|conectar|prepara|preparo|preparar|crea|creo|crear|usa|uso|usar|utiliza|utilizo|utilizar|monta|monto|montar|arma|armo|armar|ensambla|ensamblo|ensamblar|construye|construyo|construir|repara|reparo|reparar|limpia|limpio|limpiar|actualiza|actualizo|actualizar|activa|activo|activar|desactiva|desactivo|desactivar|abre|abro|abrir|cierra|cierro|cerrar|cambia|cambio|cambiar|graba|grabo|grabar|edita|edito|editar|exporta|exporto|exportar|importa|importo|importar)\s+(.+)$/i,
            /\b(?:c[oó]mo)\s+(?:(?:puedo|debo|hago|hace|se\s+puede)\s+)(.+)$/i,
            /\b(?:how\s+to|steps?\s+(?:for|to)|instructions?\s+(?:for|to)|procedure\s+for)\s+(.+)$/i,
            /\bhow\s+(?:do\s+i|can\s+i|do\s+you|can\s+you)\s+(.+)$/i,
        ];

        var TASK_STOPWORDS = Object.create(null);
        ('a al algo con de del el ella en es esta este la las lo los para por que se su un una y ' +
            'how do i can you steps step for to instructions process procedure the this what').split(/\s+/).forEach(function (word) {
            TASK_STOPWORDS[word] = true;
        });

        var STEP_MARKERS = [
            { re: /\b(?:primer\s+paso|paso\s+(?:1|uno)|en\s+primer\s+lugar|primero|primera(?:mente)?|first\s+step|step\s+1|first(?:ly)?|to\s+begin|to\s+start)\b/i, order: 1 },
            { re: /\b(?:segundo\s+paso|paso\s+(?:2|dos)|en\s+segundo\s+lugar|segundo|second\s+step|step\s+2|second(?:ly)?)\b/i, order: 2 },
            { re: /\b(?:tercer\s+paso|paso\s+(?:3|tres)|en\s+tercer\s+lugar|tercero|third\s+step|step\s+3|third(?:ly)?)\b/i, order: 3 },
            { re: /\b(?:cuarto\s+paso|paso\s+(?:4|cuatro)|cuarto|fourth\s+step|step\s+4|fourth(?:ly)?)\b/i, order: 4 },
            { re: /\b(?:quinto\s+paso|paso\s+(?:5|cinco)|quinto|fifth\s+step|step\s+5|fifth(?:ly)?)\b/i, order: 5 },
            { re: /\b(?:finalmente|por\s+[uú]ltimo|para\s+terminar|al\s+final|finally|lastly|as\s+a\s+final\s+step)\b/i, order: 999 },
            { re: /\b(?:despu[eé]s|luego|a\s+continuaci[oó]n|entonces|seguidamente|next|then|after\s+that)\b/i, order: 0 },
        ];

        var ACTION_RE = /\b(?:abre|abrir|pulsa|presiona|selecciona|elige|haz\s+clic|ve\s+a|conecta|configura|descarga|instala|reinicia|a[nñ]ade|agrega|escribe|guarda|coloca|retira|quita|mezcla|corta|calienta|ajusta|activa|desactiva|crea|usa|utiliza|monta|arma|ensambla|prepara|open|click|select|choose|go\s+to|connect|set\s+up|download|install|restart|add|type|save|remove|mix|cut|heat|adjust|enable|disable|create|use|mount|assemble|prepare)\b/i;
        var MAX_ANCHOR_DISTANCE_S = 150;

        function _cleanTask(value) {
            var task = String(value || '').trim();
            task = task.replace(/^[\s"“”'‘’«»`.,;:!?¿¡]+|[\s"“”'‘’«»`.,;:!?¿¡]+$/g, '');
            task = task.replace(/^(?:(?:el|la|los|las|un|una|the|a|an)\s+)+/i, '');
            task = task.replace(/\s+(?:paso\s+a\s+paso|seg[uú]n\s+(?:(?:el|este)\s+)?video|en\s+(?:(?:el|este|the|this)\s+)?video|in\s+(?:(?:the|this)\s+)?video)\s*$/i, '');
            return task.replace(/[\s"“”'‘’«»`.,;:!?¿¡]+$/g, '').trim();
        }

        function extractTask(query) {
            var source = String(query || '').trim();
            if (!source) return '';
            for (var i = 0; i < QUERY_PATTERNS.length; i++) {
                var match = source.match(QUERY_PATTERNS[i]);
                if (match && match[1]) {
                    var task = _cleanTask(match[1]);
                    if (task.length >= 2) return task;
                }
            }
            return '';
        }

        function _fold(text) {
            return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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

        function _taskWords(task) {
            var normalized = _fold(task).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
            var words = normalized.split(/\s+/);
            var unique = Object.create(null);
            return words.filter(function (word) {
                if (word.length < 3 || TASK_STOPWORDS[word] || unique[word]) return false;
                unique[word] = true;
                return true;
            });
        }

        function _sameWord(a, b) {
            if (a === b) return true;
            if (Math.min(a.length, b.length) >= 5 && (a.indexOf(b) === 0 || b.indexOf(a) === 0)) return true;
            return false;
        }

        function _taskScore(text, words) {
            if (!words.length) return 0;
            var tokens = _fold(text).replace(/[^\w\s]/g, ' ').split(/\s+/);
            var count = 0;
            for (var wi = 0; wi < words.length; wi++) {
                for (var ti = 0; ti < tokens.length; ti++) {
                    if (_sameWord(words[wi], tokens[ti])) { count++; break; }
                }
            }
            return count / words.length;
        }

        function _findWordRanges(text, words) {
            var mapped = _normalizeWithOffsets(text);
            var ranges = [];
            for (var wi = 0; wi < words.length; wi++) {
                var needle = words[wi];
                var from = 0;
                while (from <= mapped.text.length - needle.length) {
                    var idx = mapped.text.indexOf(needle, from);
                    if (idx < 0) break;
                    var before = idx > 0 ? mapped.text.charAt(idx - 1) : '';
                    var afterAt = idx + needle.length;
                    var after = afterAt < mapped.text.length ? mapped.text.charAt(afterAt) : '';
                    if (!/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after)) {
                        ranges.push({ start: mapped.starts[idx], end: mapped.ends[afterAt - 1] });
                    }
                    from = idx + needle.length;
                }
            }
            return ranges;
        }

        function _findMarker(text) {
            var listNumber = text.match(/^\s*(\d+)[.)]\s*/);
            if (listNumber) return { start: listNumber.index, end: listNumber.index + listNumber[0].length, order: Number(listNumber[1]), explicit: true };
            var numbered = text.match(/\b(?:paso|step)\s*(\d+)\b/i);
            if (numbered) return { start: numbered.index, end: numbered.index + numbered[0].length, order: Number(numbered[1]), explicit: true };
            for (var i = 0; i < STEP_MARKERS.length; i++) {
                var match = STEP_MARKERS[i].re.exec(text);
                if (match) return { start: match.index, end: match.index + match[0].length, order: STEP_MARKERS[i].order, explicit: true };
            }
            if (ACTION_RE.test(text)) return { start: -1, end: -1, order: 0, explicit: false };
            return null;
        }

        function _time(cue) {
            var time = Number(cue && cue.inicio);
            return isFinite(time) && time >= 0 ? time : 0;
        }

        function _buildStep(cues, index, marker, words) {
            var first = cues[index];
            var parts = [String(first.texto || '').trim()];
            var lastTime = Number(first.fin) || _time(first);
            var initialText = parts[0];
            var hasAction = ACTION_RE.test(initialText);

            for (var i = index + 1; i < cues.length && parts.length < 3; i++) {
                var next = cues[i];
                if (!next || typeof next.texto !== 'string') break;
                var nextTime = _time(next);
                if (nextTime - lastTime > 3.5) break;
                var nextText = next.texto.trim();
                if (!nextText) continue;
                var nextMarker = _findMarker(nextText);
                if (nextMarker && nextMarker.explicit) break;
                var lastText = parts[parts.length - 1];
                var isContinuation = !/[.!?]$/.test(lastText) || (marker.explicit && !hasAction && initialText.length < 48);
                if (ACTION_RE.test(nextText)) {
                    if (!marker.explicit || hasAction || parts.length > 1) break;
                    isContinuation = true;
                }
                if (!isContinuation) break;
                parts.push(nextText);
                lastTime = Number(next.fin) || nextTime;
                if (ACTION_RE.test(nextText)) hasAction = true;
                if (/[.!?]$/.test(nextText)) break;
            }

            var text = parts.join(' ');
            var matches = _findWordRanges(text, words);
            if (marker.start >= 0 && marker.end > marker.start) matches.push({ start: marker.start, end: marker.end });
            return {
                start: _time(first),
                end: lastTime,
                text: text,
                order: marker.order,
                score: 0,
                matches: matches,
            };
        }

        function search(opts) {
            opts = opts || {};
            var cues = opts.cues;
            var task = typeof opts.task === 'string' ? _cleanTask(opts.task) : extractTask(opts.query);
            if (!task || !Array.isArray(cues) || !cues.length) return [];

            var words = _taskWords(task);
            if (!words.length) return [];

            var anchors = [];
            for (var ai = 0; ai < cues.length; ai++) {
                var anchorScore = _taskScore(cues[ai] && cues[ai].texto, words);
                if (anchorScore > 0) anchors.push({ time: _time(cues[ai]), score: anchorScore });
            }
            if (!anchors.length) return [];

            var steps = [];
            var seenText = Object.create(null);
            for (var ci = 0; ci < cues.length; ci++) {
                var cue = cues[ci];
                if (!cue || typeof cue.texto !== 'string') continue;
                var marker = _findMarker(cue.texto);
                if (!marker) continue;

                var cueTime = _time(cue);
                var nearestDistance = Infinity;
                var nearbyScore = 0;
                for (var hi = 0; hi < anchors.length; hi++) {
                    var distance = Math.abs(cueTime - anchors[hi].time);
                    if (distance < nearestDistance) {
                        nearestDistance = distance;
                        nearbyScore = anchors[hi].score;
                    }
                }
                var ownScore = _taskScore(cue.texto, words);
                if (nearestDistance > MAX_ANCHOR_DISTANCE_S && ownScore < 0.5) continue;

                var step = _buildStep(cues, ci, marker, words);
                if (!step.text) continue;
                step.score = ownScore * 0.55 + nearbyScore * 0.25 + (marker.explicit ? 0.20 : 0) - Math.min(nearestDistance, MAX_ANCHOR_DISTANCE_S) / 3000;
                var key = _fold(step.text).replace(/\s+/g, ' ').trim();
                if (!key || seenText[key]) continue;
                seenText[key] = true;
                steps.push(step);
            }

            steps.sort(function (a, b) {
                return a.start - b.start;
            });
            var maxResults = Number(opts.maxResults) || 8;
            return steps.slice(0, Math.max(1, Math.min(maxResults, 12)));
        }

        return {
            extractTask: extractTask,
            isProcedureQuery: function (query) { return extractTask(query).length > 0; },
            search: search,
        };

    })();

    var log = VP.log || console;
    if (log.info) log.info('vp-rag-pasos.js v1.0.0 cargado. Módulo: stepSearch.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-rag-pasos.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window);
