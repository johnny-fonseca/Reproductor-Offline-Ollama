'use strict';

// ============================================================
// VP-CHAT-IA.JS  —  v3.0.0 (integrado con RAG)
// Chat interactivo con IA sobre el contenido del video,
// ahora potenciado por el sistema RAG.
//
// Integración:
//   · VP.bus / VP.log / VP.util / VP.dom / VP.db
//   · VP.rag (core, literal, términos, definiciones, pasos y pipeline)
//   · Ollama (localhost) para generación
//
// Dependencias: vp-base.js · vp-utilidades.js · vp-dom.js ·
//               vp-db.js · vp-subtitulos.js ·
//               vp-rag-core.js · vp-rag-literal.js · vp-rag-terminos.js ·
//               vp-rag-definiciones.js · vp-rag-pasos.js · vp-rag-pipeline.js
// ============================================================

(function (window, document) {
    if (window.__VP_CHAT_IA_LOADED__) return;
    window.__VP_CHAT_IA_LOADED__ = true;

    // ============================================================
    // 0. VERIFICACIÓN DE DEPENDENCIAS
    // ============================================================

    var VP = window.VP;
    if (!VP) throw new Error('[VP] vp-chat-ia.js: vp-base.js debe cargarse primero.');
    if (!VP.rag) throw new Error('[VP] vp-chat-ia.js: vp-rag-core.js debe cargarse antes.');
    if (!VP.rag.intentDetector || !VP.rag.promptBuilder) throw new Error('[VP] vp-chat-ia.js: vp-rag-pipeline.js debe cargarse antes.');

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;
    log.setContext('ChatIA');

    if (!util || !dom || !log || !bus) {
        throw new Error('[VP] vp-chat-ia.js: dependencias faltantes.');
    }

    // ============================================================
    // 1. NAMESPACE
    // ============================================================

    VP.chatIA = VP.chatIA || {};

    // ============================================================
    // 2. CONSTANTES
    // ============================================================

    var CFG = Object.freeze({
        DEFAULT_URL          : 'http://localhost:11434',
        CHAT_ENDPOINT        : '/api/chat',
        MODELS_ENDPOINT      : '/api/tags',
        FETCH_TIMEOUT_MS     : 15000,
        STREAM_READ_MAX      : 8000,
        MAX_HISTORY_MESSAGES : 20,
        MAX_MESSAGE_LENGTH   : 2000,
        INPUT_DEBOUNCE_MS    : 100,

        // Persistencia
        STORAGE_PREFIX       : 'vpChatIA_',
        CACHE_MAX_CONVOS     : 50,

        // Preferencias
        PREF_MODEL           : 'chatIA_model',
        PREF_URL             : 'vp_ollama_url',

        // Gestión de tokens (estimación: 1 token ≈ 4 caracteres)
        TOKEN_CHARS          : 4,
        MAX_HISTORY_TOKENS   : 2000,
        MAX_CONTEXT_TOKENS   : 4000,

        // Retry con backoff exponencial
        RETRY_MAX            : 3,
        RETRY_BASE_DELAY_MS  : 800,
        RETRY_MAX_DELAY_MS   : 8000,

        // Rate limiting de envío
        SEND_COOLDOWN_MS     : 600,

        // Atajo de teclado para abrir el chat (Ctrl+Shift+A)
        KEYBOARD_SHORTCUT    : { key: 'a', ctrl: true, shift: true },

        // ID del diálogo inline para marcadores
        MARKER_DIALOG_ID     : 'chatIAMarkerDialog',

        // Número máximo de sugerencias a pedir a la IA
        MAX_SUGGESTIONS      : 4,

        // Chunking inteligente para subtítulos grandes (como vp-capitulos-ia.js)
        SUBTITLE_PROCESSED_MAX_CHARS : 100000,
        CHUNK_DURATION_S     : 180,   // 3 minutos por chunk
        CHUNK_OVERLAP_S      : 20,    // 20s de solapamiento entre chunks
        CHUNK_MAX_CHARS      : 3500,  // Máx chars por chunk al LLM

        // Preferencias de idioma
        PREF_LANGUAGE        : 'vp_ia_language',
        PREF_DEFAULT_LANG    : 'es',
    });

    var DEFAULT_SUGGESTIONS = Object.freeze([
        '¿De qué trata este video?',
        '¿Cuáles son los temas principales?',
        '¿En qué minuto se menciona...?',
        'Resume los primeros 10 minutos',
    ]);

    // ============================================================
    // 3. ESTADO INTERNO
    // ============================================================

    var _state = {
        // Chat
        conversation        : [],
        isStreaming         : false,
        abortController     : null,
        currentVideoId      : '',

        // UI
        streamingMsgEl      : null,
        streamingContent    : '',
        welcomeEl           : null,
        returnFocusEl       : null,

        // Rate limiting
        _lastSendTs         : 0,

        // Métricas de tiempo de respuesta
        _responseStartTs    : 0,

        // Búsqueda
        _searchQuery        : '',

        // Listeners
        _docListeners       : [],
        _videoListeners     : [],
        _busListeners       : [],

        // Init
        _initialized        : false,

        // Sugerencias generadas por IA (cache por videoId)
        _suggestionsCache   : Object.create(null),

        // Invalida lecturas de conversaciones que terminan después de limpiar
        // o de iniciar una lectura más reciente.
        _conversationLoadRevision : 0,
        _conversationRevision     : 0,
        _conversationStorageRevision : Object.create(null),
        _conversationWriteQueue   : Promise.resolve(),
        _openLoadTimer            : null,
        _streamRevision           : 0,
        _activeStreamRevision     : 0,

        // Caché de subtítulos procesados (evita reprocesar en cada llamada)
        _subtitleCache      : { videoId: '', processed: '', flat: '', originalLineCount: 0 },

        // Métricas
        metricas : {
            mensajesEnviados    : 0,
            mensajesRecibidos   : 0,
            marcadoresCreados   : 0,
            errores             : 0,
            tokensTotal         : 0,
            reintentos          : 0,
            tiempoTotalMs       : 0,
            tiempoPromedioMs    : 0,
        },

        // RAG Engine (interno)
        ragEngine : null,
    };

    // ============================================================
    // 4. HELPERS DE DOM
    // ============================================================

    function _el(id) { return document.getElementById(id); }

    function _setDisplay(id, value) {
        var el = _el(id); if (el) el.style.display = value;
    }

    function _addTracked(target, event, handler, store) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(event, handler);
        (store || _state._docListeners).push({ target: target, event: event, handler: handler });
    }

    function _removeTracked(store) {
        for (var i = 0; i < store.length; i++) {
            try { store[i].target.removeEventListener(store[i].event, store[i].handler); } catch (_) {}
        }
        store.length = 0;
    }

    function _notif(msg, tipo) {
        try {
            if (VP.ui && typeof VP.ui.mostrarNotificacion === 'function')
                VP.ui.mostrarNotificacion(msg, tipo || 'info');
        } catch (_) {}
    }

    function _closest(el, selector) {
        if (!el) return null;
        if (el.closest) return el.closest(selector);
        while (el && el !== document) {
            if (el.matches && el.matches(selector)) return el;
            el = el.parentNode;
        }
        return null;
    }

    // ============================================================
    // 4.5. FUNCIONES AUXILIARES DE SUBTÍTULOS (portadas de vp-capitulos-ia.js)
    // ============================================================

    function _truncar(str, max) {
        if (typeof str !== 'string') return '';
        return str.length > max ? str.slice(0, max) : str;
    }

    function _hashCode(str) {
        var hash = 0;
        if (!str || typeof str !== 'string') return 0;
        for (var i = 0; i < str.length; i++) {
            var char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return Math.abs(hash);
    }

    function _secondsToTimestamp(s) {
        s = Number(s);
        if (!isFinite(s) || s < 0) return '00:00';
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = Math.floor(s % 60);
        return h > 0 ? _pad2(h) + ':' + _pad2(m) + ':' + _pad2(sec) : _pad2(m) + ':' + _pad2(sec);
    }

    function _pad2(n) { return n < 10 ? '0' + n : String(n); }

    // FASE 14: Hierarchical Retrieval — Level 2 exact cue search within chunks
    function _searchExactCuesInChunks(query, chunks) {
        if (!query || !chunks || !chunks.length) return null;
        if (!VP.rag.literalSearch) return null;

        // Extraer texto entre comillas si existe
        var quoted = query.match(/["""]([^"""]+)["""]/);
        var searchStr = quoted ? quoted[1] : query;

        // FIX v3.1.1: usar la misma función normalize tanto para query como para cue
        // (antes se usaban literalSearch.normalize para query y subtitleIndex.normalize
        // para el cue, causando inconsistencias porque subtitleIndex no expande contracciones).
        var normFn = VP.rag.literalSearch.normalize;
        var q = normFn(searchStr);
        if (!q) return null;

        var matched = [];
        for (var ci = 0; ci < chunks.length; ci++) {
            var chunkCues = chunks[ci].cues;
            if (!chunkCues || !chunkCues.length) continue;
            for (var cj = 0; cj < chunkCues.length; cj++) {
                var cue = chunkCues[cj];
                var normTexto = normFn(cue.texto);
                if (normTexto.indexOf(q) !== -1) {
                    matched.push({
                        score: 0.95,
                        timestamp: cue.inicio || 0,
                        text: cue.texto,
                    });
                }
            }
        }
        if (!matched.length) return null;
        var lines = ['[Coincidencias exactas dentro de la región detectada]'];
        for (var mi = 0; mi < Math.min(matched.length, 10); mi++) {
            var m = matched[mi];
            lines.push('[' + _fmtTime(m.timestamp) + '] ' + m.text);
        }
        return lines.join('\n');
    }

    // FASE 9: detección automática de búsqueda exacta
    function _isExactSearchQuery(query) {
        if (!query || typeof query !== 'string') return false;
        var q = query.trim();
        if (q.length < 8) return false;

        // Tiene comillas (simples o dobles)
        if (/["'""]/.test(q)) return true;

        // Contiene "frase", "quote", "dice" explícitos
        if (/\b(?:frase|quote|cita|dice exactamente|dice textual)\b/i.test(q)) return true;

        // Contiene puntuación literal (punto seguido, dos puntos, punto y coma en medio)
        if (/[.,;:?¡¿!]\s/.test(q) && !/\b(?:qué|cuál|quién|dónde|cuándo|cómo|por qué)\b/i.test(q)) return true;

        // Más de 5 palabras consecutivas sin signos de interrogación (frase descriptiva)
        var words = q.split(/\s+/);
        if (words.length >= 5) {
            // Descartar si es claramente una pregunta
            var isQuestion = /^(?:qué|cuál|quiénes?|dónde|cuándo|cómo|por\s+qué|para\s+qué|hay|existe|puedes|podrías|me\s+puedes|sabrías)/i.test(q);
            if (!isQuestion) return true;
        }

        return false;
    }

    function _timestampToSeconds(ts) {
        if (!ts || typeof ts !== 'string') return 0;
        var parts = ts.trim().split(':');
        var nums = [];
        for (var i = 0; i < parts.length; i++) {
            var n = parseFloat(parts[i]);
            if (!isFinite(n) || n < 0) return 0;
            nums.push(n);
        }
        if (nums.length === 3) return nums[0]*3600 + nums[1]*60 + nums[2];
        if (nums.length === 2) return nums[0]*60 + nums[1];
        return nums[0] || 0;
    }

    function _cleanSubtitleText(text) {
        if (!text || typeof text !== 'string') return '';

        var lines = text.split('\n');
        var cleanedLines = [];
        var prevText = null;

        var fillerWords = /\b(eh|emm|ah|mmm|este|ok|bueno)\b/gi;
        var noisePatterns = /\[(música|aplausos|risas|silencio)\]|\((music|laughs)\)/gi;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            var timestampMatch = line.match(/^(\[[\d:]+\])\s+(.*)$/);
            var timestamp = timestampMatch ? timestampMatch[1] : '';
            var content = timestampMatch ? timestampMatch[2] : line;

            content = content.replace(fillerWords, '');
            content = content.replace(noisePatterns, '');
            content = content.replace(/\s+/g, ' ');
            content = content.trim();

            if (!content) continue;

            var words = content.split(' ');
            var hasExcessiveRep = false;
            for (var j = 0; j < words.length - 2; j++) {
                if (words[j] && words[j] === words[j+1] && words[j] === words[j+2]) {
                    hasExcessiveRep = true;
                    break;
                }
            }
            if (hasExcessiveRep) continue;

            var cleanedLine = timestamp ? (timestamp + ' ' + content) : content;
            if (cleanedLine === prevText) continue;

            cleanedLines.push(cleanedLine);
            prevText = cleanedLine;
        }

        return cleanedLines.join('\n');
    }

    function _buildSemanticTranscript(subtitleText, maxGroupDurationSeconds) {
        maxGroupDurationSeconds = maxGroupDurationSeconds || 30;
        if (!subtitleText || typeof subtitleText !== 'string') return '';

        var lines = subtitleText.split('\n');
        var groupedLines = [];
        var currentGroup = {
            startTime: null,
            endTime: null,
            texts: []
        };

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            var timestampMatch = line.match(/^\[([\d:]+)\]\s*(.*)$/);
            if (!timestampMatch) {
                if (currentGroup.texts.length > 0) {
                    currentGroup.texts.push(line);
                }
                continue;
            }

            var timestampStr = timestampMatch[1];
            var content = timestampMatch[2].trim();
            if (!content) continue;

            var currentSeconds = _timestampToSeconds(timestampStr);

            if (currentGroup.startTime === null ||
                (currentSeconds - currentGroup.endTime) > maxGroupDurationSeconds) {

                if (currentGroup.texts.length > 0) {
                    var groupText = currentGroup.texts.join(' ');
                    var startTimestamp = _secondsToTimestamp(currentGroup.startTime);
                    var endTimestamp = _secondsToTimestamp(currentGroup.endTime);
                    groupedLines.push('[' + startTimestamp + ' - ' + endTimestamp + '] ' + groupText);
                }

                currentGroup = {
                    startTime: currentSeconds,
                    endTime: currentSeconds,
                    texts: [content]
                };
            } else {
                currentGroup.endTime = currentSeconds;
                currentGroup.texts.push(content);
            }
        }

        if (currentGroup.texts.length > 0) {
            var groupText = currentGroup.texts.join(' ');
            var startTimestamp = _secondsToTimestamp(currentGroup.startTime);
            var endTimestamp = _secondsToTimestamp(currentGroup.endTime);
            groupedLines.push('[' + startTimestamp + ' - ' + endTimestamp + '] ' + groupText);
        }

        return groupedLines.join('\n');
    }

    function _splitLongGroups(text, maxChars) {
        if (!text || maxChars <= 0) return text;
        var lines = text.split('\n');
        var result = [];
        for (var si = 0; si < lines.length; si++) {
            var line = lines[si];
            if (line.length <= maxChars) {
                result.push(line);
                continue;
            }
            var rangeMatch = line.match(/^\[([\d:]+(?:\s*-\s*[\d:]+)?)\]\s*(.*)$/);
            if (!rangeMatch) { result.push(line); continue; }
            var prefix = '[' + rangeMatch[1] + '] ';
            var content = rangeMatch[2];
            var words = content.split(' ');
            var chunk = '';
            var parts = [];
            for (var wi = 0; wi < words.length; wi++) {
                if ((chunk + ' ' + words[wi]).trim().length > maxChars - prefix.length) {
                    if (chunk.trim()) parts.push(chunk.trim());
                    chunk = words[wi];
                } else {
                    chunk = (chunk + ' ' + words[wi]).trim();
                }
            }
            if (chunk.trim()) parts.push(chunk.trim());
            for (var pi = 0; pi < parts.length; pi++) {
                result.push(prefix + parts[pi]);
            }
        }
        return result.join('\n');
    }

    function _detectTopicChanges(processedText) {
        if (!processedText || typeof processedText !== 'string') return [];

        var lines = processedText.split('\n');
        var topicChanges = [];

        var stopWordsArr = 'el la los las un una unos unas y o pero porque que como cuando donde quien cual es son estar tener hacer poder decir ir ver dar saber querer llegar pasar deber poner parecer quedar creer hablar llevar dejar seguir encontrar llamar venir pensar salir volver tomar conocer vivir sentir tratar mirar contar empezar esperar buscar existir entrar tocar subir bajar girar abrir'.split(' ');
        var stopWords = new Set(stopWordsArr);

        var lineTopics = [];

        for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            if (!line) continue;

            var timestampMatch = line.match(/^\[([\d:]+(?:\s*-\s*[\d:]+)?)\]\s*(.*)$/);
            var content = timestampMatch ? timestampMatch[2].trim() : line;
            if (!content) continue;

            var words = content.toLowerCase().match(/\b[a-záéíóúñü]+\b/g) || [];
            var meaningfulWords = words.filter(function(word) {
                return word.length > 2 && !stopWords.has(word);
            });

            if (meaningfulWords.length > 0) {
                lineTopics.push({
                    timestamp: timestampMatch ? timestampMatch[1] : '',
                    words: meaningfulWords,
                    lineIndex: li
                });
            }
        }

        for (var lti = 1; lti < lineTopics.length; lti++) {
            var prevWords = lineTopics[lti - 1].words;
            var currWords = lineTopics[lti].words;

            var prevSet = new Set(prevWords);
            var currSet = new Set(currWords);

            var intersection = 0;
            var allWords = [];
            for (var wi = 0; wi < prevWords.length; wi++) allWords.push(prevWords[wi]);
            for (var wi = 0; wi < currWords.length; wi++) allWords.push(currWords[wi]);
            var unionSet = new Set(allWords);

            for (var wi = 0; wi < prevWords.length; wi++) {
                if (currSet.has(prevWords[wi])) intersection++;
            }

            var similarity = unionSet.size > 0 ? intersection / unionSet.size : 0;

            if (similarity < 0.3) {
                topicChanges.push({
                    timestamp: lineTopics[lti].timestamp,
                    lineIndex: lineTopics[lti].lineIndex,
                    similarity: similarity
                });
            }
        }

        for (var li2 = 1; li2 < lines.length; li2++) {
            var prevLine = lines[li2 - 1].trim();
            var currLine = lines[li2].trim();
            if (!prevLine || !currLine) continue;

            var prevTs = prevLine.match(/^\[([\d:]+)\]/);
            var currTs = currLine.match(/^\[([\d:]+)\]/);

            if (prevTs && currTs) {
                var prevSec = _timestampToSeconds(prevTs[1]);
                var currSec = _timestampToSeconds(currTs[1]);

                if (currSec - prevSec > 10) {
                    topicChanges.push({
                        timestamp: currTs[1],
                        lineIndex: li2,
                        timeGap: currSec - prevSec
                    });
                }
            }
        }

        topicChanges.sort(function(a, b) {
            return (a.lineIndex || 0) - (b.lineIndex || 0);
        });

        var uniqueChanges = [];
        var lastIndex = -1;
        for (var ui = 0; ui < topicChanges.length; ui++) {
            if (topicChanges[ui].lineIndex !== lastIndex) {
                uniqueChanges.push(topicChanges[ui]);
                lastIndex = topicChanges[ui].lineIndex;
            }
        }

        return uniqueChanges;
    }

    // ============================================================
    // 5. IDENTIFICACIÓN DE VIDEO
    // ============================================================

    function _getVideoId() {
        var ci = VP.estado && VP.estado.currentVideoIndex;
        var pl = VP.estado && VP.estado.playlist;
        if (typeof ci === 'number' && ci >= 0 && pl && pl[ci]) {
            var v = pl[ci];
            if (v.name) return v.name;
            if (v.id)   return String(v.id);
        }
        var cv = window.vpCurrentVideo;
        if (cv) {
            if (cv.name) return cv.name;
            if (cv.id)   return String(cv.id);
        }
        return '';
    }

    function _getVideoObj() {
        var ci = VP.estado && VP.estado.currentVideoIndex;
        var pl = VP.estado && VP.estado.playlist;
        return (typeof ci === 'number' && ci >= 0 && pl && pl[ci]) ? pl[ci] : null;
    }

    function _getVideoDuration() {
        var video = VP.refs && VP.refs.videoPlayer;
        if (video && !dom.esNulo(video) && isFinite(video.duration) && video.duration > 0)
            return video.duration;
        var vObj = _getVideoObj();
        return (vObj && isFinite(vObj.duration) && vObj.duration > 0) ? vObj.duration : 0;
    }

    function _getVideoTitle() {
        var vObj = _getVideoObj();
        return vObj ? (vObj.name || 'Video') : 'Video';
    }

    function _getCurrentTime() {
        var video = VP.refs && VP.refs.videoPlayer;
        if (video && !dom.esNulo(video) && isFinite(video.currentTime))
            return Math.max(0, video.currentTime);
        return undefined;
    }

    // ============================================================
    // 6. SUBTÍTULOS
    // ============================================================

    function _getSubtitleContext(maxTimeSeconds) {
        var currentId = _getVideoId();

        if (!maxTimeSeconds && currentId && _state._subtitleCache.videoId === currentId && _state._subtitleCache.processed) {
            return _state._subtitleCache.processed;
        }

        var result = _getFlatSubtitleText(maxTimeSeconds);
        if (!result) return '';

        var cleaned = result.text;
        var grouped = _buildSemanticTranscript(cleaned, 30);
        grouped = _splitLongGroups(grouped, 2500);
        if (grouped.length > CFG.SUBTITLE_PROCESSED_MAX_CHARS) {
            grouped = _truncateSmartTranscript(grouped, CFG.SUBTITLE_PROCESSED_MAX_CHARS);
        }

        if (!maxTimeSeconds && currentId && grouped) {
            _state._subtitleCache.videoId = currentId;
            _state._subtitleCache.processed = grouped;
            _state._subtitleCache.originalLineCount = result.originalLineCount;
        }

        return grouped;
    }

    function _getFlatSubtitleText(maxTimeSeconds) {
        var currentId = _getVideoId();

        if (!maxTimeSeconds && currentId && _state._subtitleCache.videoId === currentId && _state._subtitleCache.flat) {
            return { text: _state._subtitleCache.flat, originalLineCount: _state._subtitleCache.originalLineCount };
        }

        var text = '';
        var originalLineCount = 0;
        try {
            var cues = window.vpSubtitleCues;
            if (Array.isArray(cues) && cues.length > 0) {
                var lines = [];
                for (var ci = 0; ci < cues.length; ci++) {
                    var c = cues[ci];
                    if (c && c.texto) {
                        if (maxTimeSeconds === undefined || c.inicio <= maxTimeSeconds + 0.5) {
                            lines.push('[' + _secondsToTimestamp(c.inicio || 0) + '] ' + c.texto);
                        }
                    }
                }
                text = lines.join('\n');
                originalLineCount = lines.length;
            }
        } catch (_) {}

        if (!text) {
            try {
                var video  = VP.refs && VP.refs.videoPlayer;
                if (video && !dom.esNulo(video)) {
                    var tracks = video.textTracks;
                    if (tracks && tracks.length > 0) {
                        for (var ti = 0; ti < tracks.length; ti++) {
                            var track = tracks[ti];
                            if (track.kind === 'subtitles' && track.cues && track.cues.length > 0) {
                                var lines2 = [];
                                for (var j = 0; j < track.cues.length; j++) {
                                    var cue = track.cues[j];
                                    if (cue && cue.text) {
                                        if (maxTimeSeconds === undefined || cue.startTime <= maxTimeSeconds + 0.5) {
                                            lines2.push('[' + _secondsToTimestamp(cue.startTime || 0) + '] ' + cue.text);
                                        }
                                    }
                                }
                                if (lines2.length > 0) {
                                    text = lines2.join('\n');
                                    originalLineCount = lines2.length;
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (_) {}
        }

        if (!text) return null;

        var cleaned = _cleanSubtitleText(text);

        if (!maxTimeSeconds && currentId && cleaned) {
            _state._subtitleCache.videoId = currentId;
            _state._subtitleCache.flat = cleaned;
            _state._subtitleCache.originalLineCount = originalLineCount;
        }

        return { text: cleaned, originalLineCount: originalLineCount };
    }

    function _getSubtitleStats() {
        if (_state._subtitleCache.videoId === _getVideoId()) {
            var flatLen = (_state._subtitleCache.flat || '').length;
            return {
                originalLineCount: _state._subtitleCache.originalLineCount || 0,
                groupedLineCount: (_state._subtitleCache.processed || '').split('\n').length,
                chars: flatLen || (_state._subtitleCache.processed || '').length,
            };
        }
        return { originalLineCount: 0, groupedLineCount: 0, chars: 0 };
    }

    function _truncateSmartTranscript(text, maxChars) {
        if (!text || text.length <= maxChars) return text;
        var lines = text.split('\n');
        if (lines.length < 8) {
            // Texto corto: truncado simple por líneas
            var out = [];
            var rem = maxChars;
            for (var ti = 0; ti < lines.length; ti++) {
                var cost = lines[ti].length + (out.length > 0 ? 1 : 0);
                if (cost > rem) break;
                out.push(lines[ti]);
                rem -= cost;
            }
            return out.join('\n');
        }

        // Dividir en N secciones uniformes para cubrir todo el video
        // sin perder el tercio medio como hacia el split 60/40
        var sections = 4;
        var sepLen = 7; // '\n[...]\n'
        var avail = maxChars - sepLen * (sections - 1);
        if (avail <= 0) return lines.slice(0, 5).join('\n');
        var charsPerSec = Math.floor(avail / sections);

        var parts = [];
        for (var si = 0; si < sections; si++) {
            var startIdx = Math.floor(lines.length * si / sections);
            var endIdx = Math.floor(lines.length * (si + 1) / sections);
            if (startIdx >= endIdx) continue;
            var secLines = lines.slice(startIdx, endIdx);
            var budget = charsPerSec;
            var chosen = [];
            if (si === sections - 1) {
                for (var j = secLines.length - 1; j >= 0; j--) {
                    var cost = secLines[j].length + (chosen.length > 0 ? 1 : 0);
                    if (cost > budget) break;
                    chosen.unshift(secLines[j]);
                    budget -= cost;
                }
            } else {
                for (var j = 0; j < secLines.length; j++) {
                    var cost = secLines[j].length + (chosen.length > 0 ? 1 : 0);
                    if (cost > budget) break;
                    chosen.push(secLines[j]);
                    budget -= cost;
                }
            }
            if (chosen.length > 0) parts.push(chosen.join('\n'));
        }

        if (parts.length === 0) return lines.slice(0, 5).join('\n');
        return parts.join('\n[...]\n');
    }

    function _updateContextBadge() {
        var badge = _el('chatIAContextBadge');
        if (!badge) return;
        var subs = _getSubtitleContext();
        var dur  = _getVideoDuration();
        if (subs) {
            var stats = _getSubtitleStats();
            var label = '📝 ' + stats.originalLineCount + ' subtítulos';
            if (stats.chars > 50000) label += ' [' + Math.round(stats.chars/1000) + 'k]';
            badge.textContent = label;
            badge.classList.add('has-context');
        } else if (dur > 0) {
            badge.textContent = '⏱ Solo duración (' + _fmtTime(dur) + ')';
            badge.classList.remove('has-context');
        } else {
            badge.textContent = 'Sin contexto';
            badge.classList.remove('has-context');
        }
    }

    function _updateSubtitleStatus() {
        var el = _el('chatIASubtitleStatus');
        if (!el) return;
        var subs = _getSubtitleContext();
        if (subs) {
            var stats = _getSubtitleStats();
            var statusText = '✓ ' + stats.originalLineCount + ' subtítulos disponibles';
            if (stats.chars > 50000) statusText += ' (' + Math.round(stats.chars/1000) + 'k)';
            el.textContent = statusText;
            el.style.color = 'var(--yt-green, #4caf50)';
        } else {
            el.textContent = 'Sin subtítulos — respuestas limitadas';
            el.style.color = 'var(--yt-text-secondary, #aaa)';
        }
    }

    // ============================================================
    // 7. PERSISTENCIA DE CONVERSACIONES
    // ============================================================

    function _queueConversationPersistence(videoId, keyvalValue, meta, revision) {
        if (!videoId) return;
        var key = CFG.STORAGE_PREFIX + 'conv_' + videoId;

        var task = _state._conversationWriteQueue.catch(function () {}).then(function () {
            if (_state._conversationStorageRevision[videoId] !== revision) return false;

            var keyvalWrite = Promise.resolve();
            try {
                if (keyvalValue === null) {
                    if (VP.db && typeof VP.db.eliminarKeyVal === 'function') {
                        keyvalWrite = VP.db.eliminarKeyVal(key);
                    } else {
                        util.eliminarItem(key);
                    }
                } else if (VP.db && typeof VP.db.guardarKeyVal === 'function') {
                    keyvalWrite = VP.db.guardarKeyVal(key, keyvalValue);
                } else {
                    util.storageSet(key, keyvalValue);
                }
            } catch (err) {
                log.warn('Error guardando la caché de conversación:', err && err.message ? err.message : err);
            }

            return Promise.resolve(keyvalWrite).catch(function (err) {
                log.warn('Error guardando la caché de conversación:', err && err.message ? err.message : err);
            }).then(function () {
                if (!VP.db || typeof VP.db.guardarMetadatos !== 'function') return false;
                return VP.db.guardarMetadatos(videoId, meta);
            });
        });
        _state._conversationWriteQueue = task.catch(function (err) {
            log.warn('Error guardando conversación:', err && err.message ? err.message : err);
        });
    }

    function _saveConversation(videoId) {
        videoId = videoId || _getVideoId();
        if (!videoId || !_state.conversation.length) return;

        var toSave = _state.conversation.slice(-CFG.MAX_HISTORY_MESSAGES);

        var revision = _state._conversationStorageRevision[videoId];
        if (typeof revision !== 'number') {
            revision = 0;
            _state._conversationStorageRevision[videoId] = revision;
        }
        _queueConversationPersistence(videoId, {
            messages : toSave,
            videoId  : videoId,
            title    : _getVideoTitle(),
            ts       : Date.now(),
            version  : '3.0.0',
        }, {
            chatIA     : toSave,
            chatIATs   : Date.now(),
            chatIACleared : false,
        }, revision);
    }

    function _loadConversation() {
        var loadRevision = ++_state._conversationLoadRevision;
        var videoId = _getVideoId();
        if (!videoId) { _state.conversation = []; return Promise.resolve([]); }

        var key = CFG.STORAGE_PREFIX + 'conv_' + videoId;
        function isCurrentLoad() {
            return loadRevision === _state._conversationLoadRevision && videoId === _getVideoId();
        }
        function loadKeyvalConversation() {
            var stored = util.storageGet(key, null);
            if (stored && Array.isArray(stored.messages) && stored.messages.length) {
                _state.conversation = stored.messages;
                return stored.messages;
            }
            _state.conversation = [];
            return [];
        }

        if (VP.db && typeof VP.db.obtenerMetadatos === 'function') {
            return _state._conversationWriteQueue.catch(function () {}).then(function () {
                if (!isCurrentLoad()) return null;
                return VP.db.obtenerMetadatos(videoId);
            })
                .then(function (meta) {
                    if (!isCurrentLoad()) return [];
                    if (meta && Array.isArray(meta.chatIA) && meta.chatIA.length) {
                        _state.conversation = meta.chatIA;
                        return meta.chatIA;
                    }
                    if (meta && (meta.chatIACleared === true || meta.chatIA === null)) {
                        try { util.eliminarItem(key); } catch (_) {}
                        _state.conversation = [];
                        return [];
                    }
                    return loadKeyvalConversation();
                }).catch(function () {
                    if (!isCurrentLoad()) return [];
                    return loadKeyvalConversation();
                });
        }

        return Promise.resolve(loadKeyvalConversation());
    }

    function _clearConversation() {
        _state._conversationLoadRevision++;
        _state._conversationRevision++;
        var videoId = _getVideoId();
        var streamPending = _state.isStreaming && !!_state.abortController;
        if (streamPending) {
            try { _state.abortController.abort(); } catch (_) {}
        } else {
            _state.isStreaming = false;
            _state.abortController = null;
        }
        _discardStreamingMessage();
        _setDisplay('chatIATyping', 'none');
        var sendBtn = _el('chatIASendBtn');
        if (sendBtn && !streamPending) sendBtn.disabled = false;
        _state.conversation = [];
        _state._searchQuery = '';
        var searchInput = _el('chatIASearch');
        if (searchInput) searchInput.value = '';
        if (videoId) {
            try { util.eliminarItem(CFG.STORAGE_PREFIX + 'conv_' + videoId); } catch (_) {}
            var revision = (_state._conversationStorageRevision[videoId] || 0) + 1;
            _state._conversationStorageRevision[videoId] = revision;
            _queueConversationPersistence(videoId, null, {
                chatIA: null,
                chatIATs: Date.now(),
                chatIACleared: true,
            }, revision);
        }
    }

    function _discardStreamingMessage() {
        var streamingMsg = _state.streamingMsgEl;
        if (streamingMsg && streamingMsg.parentNode && streamingMsg.parentNode.parentNode) {
            streamingMsg.parentNode.parentNode.removeChild(streamingMsg.parentNode);
        }
        _state.streamingMsgEl = null;
        _state.streamingContent = '';
    }

    function _importConversation(messages) {
        if (!Array.isArray(messages) || !messages.length) { _notif('Datos de importación inválidos', 'error'); return false; }
        var valid = messages.filter(function (m) {
            return m && (m.role === 'user' || m.role === 'assistant') &&
                   typeof m.content === 'string' && m.content.length > 0;
        });
        if (!valid.length) { _notif('No se encontraron mensajes válidos', 'advertencia'); return false; }
        _state._conversationLoadRevision++;
        _state._conversationRevision++;
        _state.conversation = valid.map(function (m) {
            return { role: m.role, content: m.content, ts: m.ts || Date.now() };
        });
        _saveConversation();
        _renderAllMessages();
        _notif('Conversación importada (' + valid.length + ' mensajes)', 'exito');
        return true;
    }

    // ============================================================
    // 8. MODELOS OLLAMA
    // ============================================================

    function _populateModels(rawUrl) {
        var select = _el('chatIAModel');
        if (!select) return;

        var baseUrl = _normalizeUrl(rawUrl);
        if (!_isValidUrl(baseUrl)) {
            select.innerHTML = '<option value="">URL inválida</option>';
            return;
        }

        if (!VP.ollama || typeof VP.ollama.fetchModels !== 'function') {
            select.innerHTML = '<option value="">VP.ollama no disponible</option>';
            select.disabled  = false;
            log.warn('_populateModels: VP.ollama.fetchModels no está disponible.');
            return;
        }

        select.innerHTML = '<option value="">Cargando…</option>';
        select.disabled  = true;

        VP.ollama.fetchModels(baseUrl, { timeout: CFG.FETCH_TIMEOUT_MS })
            .then(function (models) {
                if (!models.length) {
                    select.innerHTML = '<option value="">Sin modelos</option>';
                    select.disabled  = false;
                    return;
                }

                var frag = document.createDocumentFragment();
                for (var j = 0; j < models.length; j++) {
                    var opt = document.createElement('option');
                    opt.value = models[j];
                    opt.textContent = models[j];
                    frag.appendChild(opt);
                }

                select.innerHTML = '';
                select.appendChild(frag);
                select.disabled = false;

                var saved = util.storageGet(CFG.PREF_MODEL, '');
                if (saved && models.indexOf(saved) >= 0) select.value = saved;

                for (var k = 0; k < models.length; k++) _probeToolSupport(baseUrl, models[k]);

                _updateModelBadge();
                _maybeGenerateSuggestions();
            })
            .catch(function (err) {
                select.innerHTML = '<option value="">Sin conexión</option>';
                select.disabled  = false;
                log.warn('fetchModels:', err.message || err);
            });
    }

    function _updateModelBadge() {
        var badge   = _el('chatIAModelBadge');
        if (!badge) return;
        var modelEl = _el('chatIAModel');
        var model   = modelEl ? modelEl.value : '';
        var display = model ? model.split(':')[0] : 'Ollama';
        var svgEl   = badge.querySelector('svg');
        var svgHTML  = svgEl ? svgEl.outerHTML : '';
        badge.innerHTML = svgHTML;
        badge.appendChild(document.createTextNode(display));
    }

    // ============================================================
    // 9. SUGERENCIAS GENERADAS POR IA
    // ============================================================

    function _normalizeSuggestions(value) {
        if (!Array.isArray(value)) return null;
        var preguntas = value.filter(function (item) {
            return typeof item === 'string' && item.trim().length > 10;
        }).map(function (item) { return item.trim(); }).slice(0, CFG.MAX_SUGGESTIONS);
        return preguntas.length ? preguntas : null;
    }

    function _suggestionStorageKey(videoId) {
        return videoId ? CFG.STORAGE_PREFIX + 'suggestions_' + videoId : '';
    }

    function _getSavedSuggestions(videoId) {
        var cached = _state._suggestionsCache[videoId];
        if (cached && cached.ts > Date.now() - 3600000) {
            var memoryQuestions = _normalizeSuggestions(cached.preguntas);
            if (memoryQuestions) return memoryQuestions;
        }

        var key = _suggestionStorageKey(videoId);
        if (!key) return null;
        try {
            var stored = util.storageGet(key, null);
            if (!stored || typeof stored.ts !== 'number' || stored.ts <= Date.now() - 3600000) return null;
            var savedQuestions = _normalizeSuggestions(stored.preguntas);
            if (!savedQuestions) return null;
            _state._suggestionsCache[videoId] = { preguntas: savedQuestions, ts: stored.ts };
            return savedQuestions;
        } catch (_) {
            return null;
        }
    }

    function _restoreSuggestions() {
        var preguntas = _getSavedSuggestions(_getVideoId());
        _renderSuggestions(preguntas || DEFAULT_SUGGESTIONS);
        return !!preguntas;
    }

    function _maybeGenerateSuggestions() {
        if (_restoreSuggestions()) return;

        // Restaurar las sugerencias de inicio inmediatamente. Si hay modelo y
        // subtítulos, la generación podrá reemplazarlas cuando termine.
        var model = (_el('chatIAModel') && _el('chatIAModel').value.trim()) || '';
        if (!model || !_getSubtitleContext()) return;

        _generarSugerenciasDesdeOllama(model);
    }

    function _generarSugerenciasDesdeOllama(model) {
        var requestVideoId = _getVideoId();
        var title = _getVideoTitle();
        var subs  = _getSubtitleContext();
        if (!subs) {
            _restoreSuggestions();
            return;
        }

        var extract = subs;
        if (subs.length > 5000) {
            var topics = _detectTopicChanges(subs);
            var topicTimestamps = [];
            for (var ti = 0; ti < Math.min(topics.length, 5); ti++) {
                topicTimestamps.push(topics[ti].timestamp);
            }
            var firstPart = subs.substring(0, 2500);
            var middleStart = Math.floor(subs.length * 0.4);
            var middlePart = subs.substring(middleStart, middleStart + 1500);
            var lastPart = subs.substring(subs.length - 1000);
            extract = firstPart + '\n...\n' + middlePart + '\n...\n' + lastPart;
            if (topicTimestamps.length > 0) {
                extract += '\n\nCambios de tema detectados en: ' + topicTimestamps.join(', ');
            }
        }

        var prompt = [
            'Eres un asistente que sugiere preguntas sobre un video.',
            'Dado el título y la transcripción procesada, propón ' + CFG.MAX_SUGGESTIONS + ' preguntas interesantes que un usuario podría hacer.',
            'Devuelve SOLO las preguntas, una por línea, sin numeración ni viñetas.',
            '',
            'Título: ' + title,
            '',
            'Transcripción procesada del video:',
            extract,
            '',
            'Preguntas:'
        ].join('\n');

        var baseUrl = _normalizeUrl(_el('chatIAUrl') ? _el('chatIAUrl').value : '');
        var payload = JSON.stringify({
            model    : model,
            messages : [{ role: 'user', content: prompt }],
            stream   : false,
            options  : { temperature: 0.7, top_p: 0.9, num_predict: 512, num_ctx: 2048 }
        });

        VP.ollama.fetchJSON(baseUrl + CFG.CHAT_ENDPOINT, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : payload,
        }, 60000)
        .then(function (data) {
            if (data.error) throw new Error('Ollama: ' + data.error);
            var raw = (data.message && data.message.content) || '';
            var preguntas = raw.split('\n')
                .map(function (s) { return s.replace(/^[\d.\-•\s]+/, '').trim(); })
                .filter(function (s) { return s.length > 10; })
                .slice(0, CFG.MAX_SUGGESTIONS);

            preguntas = _normalizeSuggestions(preguntas);
            if (!preguntas) {
                if (_getVideoId() === requestVideoId) _renderSuggestions(DEFAULT_SUGGESTIONS);
                return;
            }

            var timestamp = Date.now();
            _state._suggestionsCache[requestVideoId] = { preguntas: preguntas, ts: timestamp };
            var storageKey = _suggestionStorageKey(requestVideoId);
            if (storageKey) {
                try { util.storageSet(storageKey, { preguntas: preguntas, ts: timestamp }); } catch (_) {}
            }
            if (_getVideoId() === requestVideoId) _renderSuggestions(preguntas);
        })
        .catch(function (err) {
            log.warn('Error generando sugerencias:', err.message || err);
            if (_getVideoId() === requestVideoId) _restoreSuggestions();
        });
    }

    function _renderSuggestions(preguntas) {
        var container = _el('chatIASuggestions');
        if (!container && _state.welcomeEl) container = _state.welcomeEl.querySelector('#chatIASuggestions');
        if (!container) return;
        container.innerHTML = '';

        for (var i = 0; i < preguntas.length; i++) {
            var li = document.createElement('li');
            li.textContent = preguntas[i];
            li.dataset.suggestion = preguntas[i];
            li.setAttribute('role', 'button');
            li.setAttribute('tabindex', '0');
            // FIX v3.1.1: añadir soporte de teclado para accesibilidad
            li.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    var inputEl = _el('chatIAInput');
                    if (inputEl && e.currentTarget.dataset.suggestion) {
                        inputEl.value = e.currentTarget.dataset.suggestion;
                        _autoResizeInput(inputEl);
                        inputEl.focus();
                    }
                }
            });
            container.appendChild(li);
        }
    }

    // ============================================================
    // 10. RENDERIZAR MENSAJES
    // ============================================================

    function _renderAllMessages() {
        var container = _el('chatIAMessages');
        if (!container) return;
        var welcome = _state.welcomeEl || _el('chatIAWelcome');
        if (welcome) _state.welcomeEl = welcome;

        if (!_state.conversation.length) {
            container.innerHTML = '';
            if (welcome) container.appendChild(welcome);
            return;
        }

        container.innerHTML = '';
        var query = _state._searchQuery.toLowerCase();

        for (var i = 0; i < _state.conversation.length; i++) {
            var msg = _state.conversation[i];
            if (query && msg.content.toLowerCase().indexOf(query) < 0) continue;
            container.appendChild(_createMsgEl(msg));
        }
        _scrollToBottom();
    }

    function _createMsgEl(msg) {
        var div = document.createElement('div');
        div.className = 'chat-ia-msg chat-ia-msg--' + (msg.role || 'assistant');

        var content = document.createElement('div');
        content.className = 'chat-ia-msg-content';

        if (msg.role === 'user') {
            content.textContent = msg.content || '';
        } else {
            if (/\uE000[\s\S]*?\uE001/.test(msg.content || '')) {
                var isDefinition = (msg.content || '').indexOf('📘 **Así lo explica el video**') === 0;
                var isSteps = (msg.content || '').indexOf('🪜 **Pasos encontrados en el video**') === 0;
                content.classList.add(isDefinition ? 'chat-ia-definition-result' :
                    (isSteps ? 'chat-ia-steps-result' : 'chat-ia-term-result'));
            }
            content.innerHTML = _renderMarkdown(msg.content || '');
            _injectTimestampActions(content);
        }

        // FIX v3.1.1: content primero, meta después (era al revés antes)
        div.appendChild(content);

        if (msg.ts) {
            var meta = document.createElement('div');
            meta.className = 'chat-ia-msg-meta';
            meta.textContent = new Date(msg.ts).toLocaleTimeString('es', {
                hour: '2-digit', minute: '2-digit', hour12: true,
            });
            div.appendChild(meta);
        }

        return div;
    }

    function _appendUserMsg(text) {
        var container = _el('chatIAMessages');
        if (!container) return;

        var welcome = _state.welcomeEl || _el('chatIAWelcome');
        if (welcome) _state.welcomeEl = welcome;
        if (welcome && welcome.parentNode === container) container.removeChild(welcome);

        var msg = { role: 'user', content: text, ts: Date.now() };
        _state.conversation.push(msg);
        container.appendChild(_createMsgEl(msg));
        _scrollToBottom();
    }

    function _startAssistantMsg() {
        var container = _el('chatIAMessages');
        if (!container) return;

        var div = document.createElement('div');
        div.className = 'chat-ia-msg chat-ia-msg--assistant';

        var content = document.createElement('div');
        content.className = 'chat-ia-msg-content streaming';
        content.setAttribute('aria-live', 'polite');
        content.innerHTML = '';

        div.appendChild(content);
        container.appendChild(div);

        _state.streamingMsgEl   = content;
        _state.streamingContent = '';
        _state._responseStartTs = Date.now();
        _scrollToBottom();
    }

    var _updateStreamThrottled = null;
    var _streamRenderTimer = null;

    function _updateAssistantMsg(fullText) {
        _state.streamingContent = fullText;

        if (!_updateStreamThrottled) {
            var lastRender = 0;
            _updateStreamThrottled = function () {
                if (_streamRenderTimer) return;
                var elapsed = Date.now() - lastRender;
                var delay = Math.max(0, 80 - elapsed);
                _streamRenderTimer = setTimeout(function () {
                    _streamRenderTimer = null;
                    lastRender = Date.now();
                    if (!_state.streamingMsgEl) return;
                    _state.streamingMsgEl.innerHTML = _renderMarkdown(_state.streamingContent);
                    _scrollToBottom();
                }, delay);
            };
        }

        _updateStreamThrottled();
    }

    function _finalizeAssistantMsg() {
        if (_streamRenderTimer) {
            clearTimeout(_streamRenderTimer);
            _streamRenderTimer = null;
        }
        if (_state.streamingMsgEl) {
            _state.streamingMsgEl.classList.remove('streaming');
            _state.streamingMsgEl.innerHTML = _renderMarkdown(_state.streamingContent);
            _injectTimestampActions(_state.streamingMsgEl);
        }

        if (_state._responseStartTs) {
            var elapsed = Date.now() - _state._responseStartTs;
            _state.metricas.tiempoTotalMs += elapsed;
            // tiempoPromedioMs se recalcula en _sendMessage después de incrementar el contador
        }

        _state.conversation.push({
            role    : 'assistant',
            content : _state.streamingContent,
            ts      : Date.now(),
        });

        _state.streamingMsgEl   = null;
        _state.streamingContent = '';

        _saveConversation();
        _scrollToBottom();
    }

    function _scrollToBottom() {
        var container = _el('chatIAMessages');
        if (container) {
            requestAnimationFrame(function () {
                container.scrollTop = container.scrollHeight;
            });
        }
    }

    // ============================================================
    // 11. TIMESTAMPS Y MARCADORES
    // ============================================================

    function _injectTimestampActions(contentEl) {
        if (!contentEl) return;
        var duration = _getVideoDuration();
        var walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null, false);
        var nodesToProcess = [];
        while (walker.nextNode()) { nodesToProcess.push(walker.currentNode); }

        var tsRe = /\b(?:(?:[01]?\d|2[0-3]):[0-5]\d:[0-5]\d|[0-5]?\d:[0-5]\d)\b/g;

        for (var ni = 0; ni < nodesToProcess.length; ni++) {
            var node = nodesToProcess[ni];
            var text = node.nodeValue;
            if (!text) continue;

            tsRe.lastIndex = 0;
            var match;
            var lastIdx = 0;
            var frags = null;

            while ((match = tsRe.exec(text)) !== null) {
                var ts = match[0];
                var seconds = _parseTimestamp(ts);
                if (!isFinite(seconds) || seconds < 0) continue;
                if (duration > 0 && seconds > duration + 5) continue;

                if (!frags) frags = [];

                if (match.index > lastIdx) {
                    frags.push(document.createTextNode(text.substring(lastIdx, match.index)));
                }

                var span = document.createElement('span');
                span.className = 'chat-ia-timestamp';
                span.dataset.seconds = seconds;
                span.title = 'Ir a ' + ts;
                span.textContent = '\u23F1\u202F' + ts;
                span.addEventListener('click', _onTimestampClick);
                frags.push(span);

                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'chat-ia-marker-btn';
                btn.dataset.seconds = seconds;
                btn.dataset.time = ts;
                btn.title = 'Crear marcador en ' + ts;
                btn.textContent = '\uD83D\uDCCC';
                btn.addEventListener('click', _onMarkerClick);
                frags.push(btn);

                lastIdx = match.index + ts.length;
            }

            if (frags) {
                if (lastIdx < text.length) frags.push(document.createTextNode(text.substring(lastIdx)));
                var parent = node.parentNode;
                for (var fi = 0; fi < frags.length; fi++) parent.insertBefore(frags[fi], node);
                parent.removeChild(node);
            }
        }
    }

    function _onTimestampClick(e) {
        var seconds = parseFloat(e.currentTarget.dataset.seconds);
        if (!isFinite(seconds)) return;

        var video = VP.refs && VP.refs.videoPlayer;
        if (!video || dom.esNulo(video)) return;

        video.currentTime = seconds;
        if (video.paused) try { video.play(); } catch (_) {}
        _notif('▶ Saltando a ' + _fmtTime(seconds), 'info');
    }

    function _onMarkerClick(e) {
        var btn     = e.currentTarget;
        var seconds = parseFloat(btn.dataset.seconds);
        var timeStr = btn.dataset.time || _fmtTime(seconds);
        if (!isFinite(seconds)) return;

        var titulo = '';
        try {
            var msgContent = _closest(btn, '.chat-ia-msg-content');
            if (msgContent) {
                var fullText = msgContent.textContent || '';
                var tsIdx    = fullText.indexOf(timeStr);
                if (tsIdx >= 0) {
                    titulo = fullText.substring(
                        Math.max(0, tsIdx - 60),
                        Math.min(fullText.length, tsIdx + 80)
                    ).replace(/\s+/g, ' ').trim().slice(0, 60);
                }
            }
        } catch (_) {}

        _showMarkerDialog(seconds, timeStr, titulo, btn);
    }

    function _showMarkerDialog(seconds, timeStr, suggested, triggerBtn) {
        var prev = _el(CFG.MARKER_DIALOG_ID);
        if (prev) prev.parentNode.removeChild(prev);

        var dialog = document.createElement('div');
        dialog.id        = CFG.MARKER_DIALOG_ID;
        dialog.className = 'chat-ia-marker-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-label', 'Crear marcador en ' + timeStr);

        var label = document.createElement('label');
        label.textContent = '📌 Marcador en ' + timeStr;
        label.className   = 'chat-ia-marker-dialog__label';

        var inputEl = document.createElement('input');
        inputEl.type        = 'text';
        inputEl.value       = suggested;
        inputEl.maxLength   = 100;
        inputEl.placeholder = 'Nombre del marcador…';
        inputEl.className   = 'chat-ia-marker-dialog__input';

        var actions = document.createElement('div');
        actions.className = 'chat-ia-marker-dialog__actions';

        var confirmBtn = document.createElement('button');
        confirmBtn.type      = 'button';
        confirmBtn.textContent = 'Añadir';
        confirmBtn.className   = 'chat-ia-marker-dialog__confirm';

        var cancelBtn = document.createElement('button');
        cancelBtn.type      = 'button';
        cancelBtn.textContent = 'Cancelar';
        cancelBtn.className   = 'chat-ia-marker-dialog__cancel';

        actions.appendChild(confirmBtn);
        actions.appendChild(cancelBtn);
        dialog.appendChild(label);
        dialog.appendChild(inputEl);
        dialog.appendChild(actions);

        var parent = triggerBtn.parentNode;
        parent.insertBefore(dialog, triggerBtn.nextSibling);
        inputEl.focus();
        inputEl.select();

        function _confirm() {
            var nombre = inputEl.value.trim().slice(0, 100);
            if (!nombre) { inputEl.focus(); return; }
            _crearMarcador(seconds, nombre, timeStr);
            triggerBtn.textContent = '✅';
            triggerBtn.classList.add('added');
            triggerBtn.disabled = true;
            _state.metricas.marcadoresCreados++;
            _removeDialog();
        }

        function _removeDialog() {
            try { if (dialog.parentNode) dialog.parentNode.removeChild(dialog); } catch (_) {}
        }

        confirmBtn.addEventListener('click', _confirm);
        cancelBtn.addEventListener('click', _removeDialog);

        inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter')  { e.preventDefault(); _confirm(); }
            if (e.key === 'Escape') { e.preventDefault(); _removeDialog(); }
        });
    }

    function _crearMarcador(seconds, titulo, timeStr) {
        if (VP.estado) {
            if (!Array.isArray(VP.estado.capitulos)) VP.estado.capitulos = [];
            var existe = false;
            for (var k = 0; k < VP.estado.capitulos.length; k++) {
                if (Math.abs(VP.estado.capitulos[k].tiempo - seconds) < 1) { existe = true; break; }
            }
            if (!existe) {
                VP.estado.capitulos.push({ tiempo: seconds, titulo: titulo });
                VP.estado.capitulos.sort(function (a, b) { return a.tiempo - b.tiempo; });
            }
        }

        if (VP.reproductor && typeof VP.reproductor.actualizarMarcadoresCapitulos === 'function')
            try { VP.reproductor.actualizarMarcadoresCapitulos(); } catch (_) {}
        if (VP.reproductor && typeof VP.reproductor.guardarProgresoInmediato === 'function')
            try { VP.reproductor.guardarProgresoInmediato(); } catch (_) {}
        if (VP.capitulosIA && typeof VP.capitulosIA.render === 'function')
            try { VP.capitulosIA.render(); } catch (_) {}

        _notif('📌 Marcador: ' + titulo + ' en ' + timeStr, 'exito');
        bus.emit('chatIA:marcadorCreado', { seconds: seconds, titulo: titulo, time: timeStr });
        log.info('Marcador creado →', timeStr, titulo);
    }

    // ============================================================
    // 12. ENVIAR MENSAJE (PIPELINE RAG)
    // ============================================================

    function _sendMessage() {
        var input = _el('chatIAInput');
        if (!input) return;

        var text = input.value.trim();
        if (!text) return;

        text = VP.rag.security.sanitizeInput(text, CFG.MAX_MESSAGE_LENGTH);
        if (!text) return;

        if (_state.isStreaming) { _notif('Espera a que la IA termine de responder', 'advertencia'); return; }

        // Rate limiting: evitar envíos en ráfaga
        var now = Date.now();
        if (now - _state._lastSendTs < CFG.SEND_COOLDOWN_MS) {
            _notif('Espera un momento antes de enviar otro mensaje', 'advertencia');
            return;
        }

        var modelEl = _el('chatIAModel');
        var model   = modelEl ? modelEl.value.trim() : '';
        if (!model) { _notif('Selecciona un modelo de IA', 'advertencia'); var config = _el('chatIAConfig'); if (config && !config.open) config.open = true; return; }

        var video = VP.refs && VP.refs.videoPlayer;
        if (!video || dom.esNulo(video) || (!video.src && !video.currentSrc)) { _notif('Carga un video primero', 'advertencia'); return; }

        _state._lastSendTs = Date.now();
        input.value = '';
        _autoResizeInput(input);

        try { util.storageSet(CFG.PREF_MODEL, model); } catch (_) {}
        var urlEl = _el('chatIAUrl');
        if (urlEl) try { util.storageSet(CFG.PREF_URL, urlEl.value.trim()); } catch (_) {}

        var baseUrl     = _normalizeUrl(urlEl ? urlEl.value : '');
        var videoId     = _getVideoId();
        var duration    = _getVideoDuration();
        var currentTime = _getCurrentTime() || 0;
        var title       = _getVideoTitle();

        if (!videoId) { _notif('No se pudo identificar el video', 'error'); return; }

        if (!_state.ragEngine) _state.ragEngine = new RAGEngine();

        var userQuery = VP.rag.security ? VP.rag.security.sanitizeInput(text, CFG.MAX_MESSAGE_LENGTH) : text;

        _appendUserMsg(userQuery);
        _state._conversationLoadRevision++;
        _state.metricas.mensajesEnviados++;

        _setDisplay('chatIATyping', 'flex');
        var sendBtn = _el('chatIASendBtn');
        if (sendBtn) sendBtn.disabled = true;

        _state.isStreaming = true;
        _state.abortController = new AbortController();
        var signal = _state.abortController.signal;
        var conversationRevision = _state._conversationRevision;
        var streamRevision = ++_state._streamRevision;
        _state._activeStreamRevision = streamRevision;

        _startAssistantMsg();
        _setDisplay('chatIATyping', 'none');

        _state.ragEngine.query(userQuery, {
            videoId: videoId, duration: duration, currentTime: currentTime,
            title: title, model: model, baseUrl: baseUrl, signal: signal,
        })
        .then(function (response) {
            if (conversationRevision !== _state._conversationRevision) return;
            if (response && response.responseText && !response.fromCache) {
                _state.ragEngine.cache.store(response.queryEmbedding, userQuery, response.responseText, videoId);
            }
            _finalizeAssistantMsg();
            _state.metricas.mensajesRecibidos++;
            // Recalcular promedio DESPUÉS de incrementar el contador
            if (_state.metricas.mensajesRecibidos > 0) {
                _state.metricas.tiempoPromedioMs = Math.round(
                    _state.metricas.tiempoTotalMs / _state.metricas.mensajesRecibidos
                );
            }
        })
        .catch(function (err) {
            if (conversationRevision !== _state._conversationRevision) return;
            if (err && err.name === 'AbortError') {
                if (_state.streamingContent) {
                    _state.streamingContent += '\n\n*(cancelado)*';
                    _finalizeAssistantMsg();
                } else if (_state.streamingMsgEl) {
                    _state.streamingContent = '*(cancelado)*';
                    _finalizeAssistantMsg();
                }
                _notif('Respuesta cancelada', 'info');
            } else {
                _state.metricas.errores++;
                var msg = err && err.message ? err.message : String(err);
                log.error('Error final:', msg);
                if (_state.streamingMsgEl) {
                    _state.streamingContent += '\n\n**Error:** ' + msg;
                    _finalizeAssistantMsg();
                } else {
                    _state.conversation.push({ role: 'assistant', content: '**Error:** ' + msg, ts: Date.now() });
                    _renderAllMessages();
                }
            }
        })
        .then(function () {
            if (_state._activeStreamRevision === streamRevision) {
                _state.isStreaming = false;
                _state.abortController = null;
                _setDisplay('chatIATyping', 'none');
                if (sendBtn) sendBtn.disabled = false;
                var inputEl = _el('chatIAInput');
                if (inputEl) inputEl.focus();
            }
        });
    }

    // ============================================================
    // 13. RAG ENGINE INTERNO
    // ============================================================

    function RAGEngine() {
        this.memory    = new VP.rag.MemoryManager();
        this.cache     = new VP.rag.SemanticCache();
        this.bm25Index = null;
        this._indexing = {};
    }

    RAGEngine.prototype.ensureIndexed = function(videoId, cues) {
        var self = this;
        if (this._indexing[videoId]) return this._indexing[videoId];

        var modelName = VP.rag.CFG && VP.rag.CFG.EMBED_MODEL;
        var expectedDim = VP.rag.CFG && VP.rag.CFG.EMBED_DIM;
        var needsRetry = false;
        function validEmbedding(vec) {
            var typed = typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(vec);
            if ((!Array.isArray(vec) && !typed) || vec.length !== expectedDim) return false;
            for (var i = 0; i < vec.length; i++) {
                if (typeof vec[i] !== 'number' || !isFinite(vec[i])) return false;
            }
            return true;
        }

        function saveIndexedChunks(chunks) {
            var texts = chunks.map(function (chunk) { return chunk.text; });
            return VP.rag.embedder.embedBatch(texts).then(function (embeddings) {
                var changed = false;
                for (var i = 0; i < chunks.length; i++) {
                    if (validEmbedding(embeddings[i])) {
                        chunks[i].embedding = Array.prototype.slice.call(embeddings[i]);
                        chunks[i].embeddingModel = modelName;
                        changed = true;
                    } else {
                        chunks[i].embedding = null;
                        chunks[i].embeddingModel = null;
                        needsRetry = true;
                    }
                }
                if (!changed) return chunks;
                return VP.rag.vectorStore.saveChunks(chunks).then(function () { return chunks; });
            }).then(function (savedChunks) {
                self.bm25Index = VP.rag.BM25.create(savedChunks);
                return savedChunks;
            });
        }

        function repairCachedChunks(cached) {
            var missing = [];
            for (var i = 0; i < cached.length; i++) {
                if (cached[i].embeddingModel !== modelName || !validEmbedding(cached[i].embedding)) missing.push(i);
            }
            if (!missing.length) {
                self.bm25Index = VP.rag.BM25.create(cached);
                return Promise.resolve(cached);
            }

            var texts = missing.map(function (idx) { return cached[idx].text; });
            return VP.rag.embedder.embedBatch(texts).then(function (embeddings) {
                var changed = false;
                for (var j = 0; j < missing.length; j++) {
                    var chunk = cached[missing[j]];
                    if (!validEmbedding(embeddings[j])) continue;
                    chunk.embedding = Array.prototype.slice.call(embeddings[j]);
                    chunk.embeddingModel = modelName;
                    changed = true;
                }
                if (missing.length !== 0 && !changed) needsRetry = true;
                for (var k = 0; k < cached.length; k++) {
                    if (cached[k].embeddingModel !== modelName || !validEmbedding(cached[k].embedding)) {
                        needsRetry = true;
                        break;
                    }
                }
                var persist = changed ? VP.rag.vectorStore.saveChunks(cached) : Promise.resolve();
                return persist.then(function () {
                    self.bm25Index = VP.rag.BM25.create(cached);
                    return cached;
                });
            });
        }

        function buildFreshIndex() {
            var chunks = VP.rag.chunker.chunk(cues, videoId);
            if (!chunks.length) {
                needsRetry = true;
                return Promise.resolve([]);
            }
            return saveIndexedChunks(chunks);
        }

        var promise = VP.rag.vectorStore.isIndexed(videoId).then(function (indexed) {
            if (!indexed) return buildFreshIndex();
            return VP.rag.vectorStore.getChunksByVideo(videoId).then(function (cached) {
                return cached.length ? repairCachedChunks(cached) : buildFreshIndex();
            });
        }).catch(function(err) { needsRetry = true; log.warn('Error indexando video:', err); return []; });

        this._indexing[videoId] = promise;
        return promise.finally(function () {
            if (needsRetry && self._indexing[videoId] === promise) delete self._indexing[videoId];
        });
    };

    RAGEngine.prototype._splitCuesIntoChunks = function(cues, chunkDurationS) {
        var chunks = [];
        if (!cues || !cues.length) return chunks;
        chunkDurationS = Number(chunkDurationS);
        if (!isFinite(chunkDurationS) || chunkDurationS <= 0) chunkDurationS = 180;

        // Agrupar solo los intervalos que contienen cues. Recorrer cada
        // intervalo y volver a inspeccionar todos los cues era O(intervalos*cues)
        // y podía congelar la interfaz con transcripciones largas o timestamps
        // muy separados.
        var ordenados = [];
        for (var i = 0; i < cues.length; i++) {
            var cue = cues[i];
            var inicio = Number(cue && cue.inicio);
            if (!isFinite(inicio) || inicio < 0) continue;
            ordenados.push({ cue: cue, inicio: inicio, intervalo: Math.floor(inicio / chunkDurationS) });
        }
        ordenados.sort(function(a, b) { return a.inicio - b.inicio; });

        var intervaloActual = null;
        var textoActual = '';
        function guardarChunk() {
            if (intervaloActual === null || !textoActual.trim()) return;
            var startS = intervaloActual * chunkDurationS;
            var endS = startS + chunkDurationS;
            chunks.push({ startS: startS, endS: endS, startTime: _fmtTime(startS), endTime: _fmtTime(endS), text: textoActual });
        }

        for (var j = 0; j < ordenados.length; j++) {
            var item = ordenados[j];
            if (intervaloActual !== item.intervalo) {
                guardarChunk();
                intervaloActual = item.intervalo;
                textoActual = '';
            }
            textoActual += '[' + _fmtTime(item.inicio) + '] ' + (item.cue.texto || '') + '\n';
        }
        guardarChunk();
        return chunks;
    };

    RAGEngine.prototype._generateTotalSummaryChunked = function(cues, userQuery, options) {
        var self = this;
        var chunks = this._splitCuesIntoChunks(cues, 180);
        if (chunks.length === 0) return Promise.reject(new Error("No hay subtítulos para resumir."));

        var partials = [];
        var doChunk = function(idx) {
            if (idx >= chunks.length) {
                var combined = partials.map(function(p, i) { 
                    return "Parte " + (i+1) + " (" + chunks[i].startTime + " - " + chunks[i].endTime + "):\n" + p; 
                }).join("\n\n");
                
                var finalPrompt = "Basado en los siguientes resúmenes parciales del video, redacta un resumen total y coherente que cubra los puntos clave de principio a fin. Usa formato Markdown:\n\n" + combined;
                var messages = [
                    { role: 'system', content: 'Eres un experto en analizar y resumir contenido de video extenso.' },
                    { role: 'user', content: finalPrompt }
                ];
                
                _state.streamingContent = '*Generando resumen final...*';
                if (_state.streamingMsgEl) {
                    _state.streamingMsgEl.innerHTML = _renderMarkdown(_state.streamingContent);
                    _scrollToBottom();
                }
                return _streamChatWithRetry(options.baseUrl, options.model, messages, options.signal, function(responseObj) {
                    var content = (responseObj && responseObj.message && responseObj.message.content) || _state.streamingContent;
                    _state.streamingContent = content;
                    _updateAssistantMsg(content);
                    return content;
                }).then(function(finalText) {
                    self.memory.addTurn('user', userQuery);
                    self.memory.addTurn('assistant', finalText);
                    return { responseText: finalText, queryEmbedding: null, fromCache: false };
                });
            }

            if (options.signal && options.signal.aborted) {
                var abortErr = new Error('Abortado');
                abortErr.name = 'AbortError';
                return Promise.reject(abortErr);
            }

            _state.streamingContent = "*(Analizando bloque " + (idx + 1) + " de " + chunks.length + ")*...";
            if (_state.streamingMsgEl) {
                _state.streamingMsgEl.innerHTML = _renderMarkdown(_state.streamingContent);
                _scrollToBottom();
            }

            var chunkPrompt = "Resume los puntos más importantes de este segmento de video (" + chunks[idx].startTime + " a " + chunks[idx].endTime + "). Sé conciso y directo.\n\nTranscripción:\n" + chunks[idx].text;
            var payload = JSON.stringify({
                model: options.model,
                messages: [{ role: 'user', content: chunkPrompt }],
                stream: false,
                options: { num_predict: 300, temperature: 0.2, num_ctx: 2048 }
            });

            return VP.ollama.fetchJSON(options.baseUrl + '/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                signal: options.signal
            }, 120000)
            .then(function(data) {
                if (data.error) throw new Error('Ollama: ' + data.error);
                var content = (data.message && data.message.content) || '';
                if (content.trim()) partials.push(content.trim());
                return doChunk(idx + 1);
            })
            .catch(function(err) {
                log.warn('Error en chunk ' + (idx+1) + ': ' + (err.message || err));
                partials.push('(error al procesar este segmento)');
                return doChunk(idx + 1);
            });
        };

        return doChunk(0);
    };

    RAGEngine.prototype.query = function(userQuery, options) {
        var self = this;
        var videoId = options.videoId, duration = options.duration, currentTime = options.currentTime,
            title = options.title, model = options.model, baseUrl = options.baseUrl, signal = options.signal;
        var cues = window.vpSubtitleCues || [];

        return this.ensureIndexed(videoId, cues).then(function() {
            var intent = VP.rag.intentDetector.detect(userQuery);

            // FASE 9: detección automática de exact search
            if (intent.mode !== 'literal' && _isExactSearchQuery(userQuery)) {
                intent = {
                    id         : 'busquedaLiteral',
                    mode       : 'literal',
                    antiSpoiler: false,
                    instruccion: 'BÚSQUEDA LITERAL EXACTA',
                    promptHint : 'Buscar coincidencia exacta en subtítulos.',
                };
            }

            if (intent.mode !== 'literal' && VP.rag.definitionSearch &&
                VP.rag.definitionSearch.isDefinitionQuery(userQuery)) {
                intent = {
                    id         : 'busquedaDefinicion',
                    mode       : 'literal',
                    antiSpoiler: false,
                    instruccion: 'BÚSQUEDA DE DEFINICIONES Y EXPLICACIONES',
                    promptHint : 'Recuperar la explicación del concepto desde los subtítulos.',
                };
            }

            if (intent.mode !== 'literal' && VP.rag.termSearch && VP.rag.termSearch.isTermQuery(userQuery)) {
                intent = {
                    id         : 'busquedaTermino',
                    mode       : 'literal',
                    antiSpoiler: false,
                    instruccion: 'BÚSQUEDA DE NOMBRES O TÉRMINOS',
                    promptHint : 'Buscar menciones exactas en subtítulos.',
                };
            }

            if (intent.id === 'resumenTotal' && cues && cues.length > 0) {
                return self._generateTotalSummaryChunked(cues, userQuery, options);
            }

            // FASE 16 fix: skip rewriter & embeddings para queries literales
            var _queryPromise;
            if (intent.mode === 'literal') {
                _queryPromise = Promise.resolve({ query: userQuery, rewritten: false });
            } else {
                _queryPromise = VP.rag.queryRewriter.rewrite(userQuery, self.memory, currentTime, baseUrl, model);
            }

            return _queryPromise.then(function(rewritten) {
                var queryToUse = rewritten.query;
                var _embPromise = (intent.mode === 'literal')
                    ? Promise.resolve(null)
                    : VP.rag.embedder.embedQuery(queryToUse).catch(function(err) {
                        log.warn('Embedding de consulta no disponible; se usará búsqueda textual:', err && err.message ? err.message : err);
                        return null;
                    });

                return _embPromise.then(function(queryEmb) {
                    var isProcedureRequest = VP.rag.stepSearch && VP.rag.stepSearch.isProcedureQuery(userQuery);
                    var cached = (queryEmb && !isProcedureRequest) ? self.cache.check(queryEmb) : null;
                    if (cached) {
                        _state.streamingContent = cached.response;
                        _updateAssistantMsg(cached.response);
                        _finalizeAssistantMsg();
                        return { responseText: cached.response, fromCache: true, queryEmbedding: queryEmb };
                    }

                    function _afterRetrieval(ctxResult) {
                            return self.memory.maybeCompress(baseUrl, model).then(function() {
                                var systemPrompt = VP.rag.promptBuilder.buildSystem({
                                    title: title, duration: duration, currentTime: currentTime,
                                    antiSpoiler: intent.antiSpoiler, intent: intent, topics: self.memory.getTopTopics(5),
                                });
                                var historyMsgs = self.memory.buildHistoryMessages();

                                var contextText = ctxResult.text || '';
                                var fullSubsObj = _getFlatSubtitleText();
                                var fullSubs = fullSubsObj ? fullSubsObj.text : '';
                                if (fullSubs && fullSubs.length > contextText.length) {
                                    var MAX_TRANSCRIPT = 30000;

                                    var fullTopics = _detectTopicChanges(fullSubs);
                                    var fullTopicInfo = '';
                                    if (fullTopics.length > 0) {
                                        var topicLines = [];
                                        for (var tpi = 0; tpi < Math.min(fullTopics.length, 8); tpi++) {
                                            var tp = fullTopics[tpi];
                                            topicLines.push('  · ' + (tp.timestamp || '?') + (tp.timeGap ? ' (pausa ' + tp.timeGap + 's)' : ''));
                                        }
                                        fullTopicInfo = '\n\n--- CAMBIOS DE TEMA DETECTADOS (' + fullTopics.length + ') ---\n' + topicLines.join('\n');
                                    }

                                    var transcript = fullSubs;
                                    if (transcript.length > MAX_TRANSCRIPT) {
                                        transcript = _truncateSmartTranscript(transcript, MAX_TRANSCRIPT);
                                    }

                                    var durStr = duration > 0 ? _secondsToTimestamp(duration) : 'desconocida';
                                    contextText = '--- TRANSCRIPCIÓN COMPLETA DEL VIDEO (' + title + ', ' + durStr + ') ---\n' + transcript + fullTopicInfo + '\n\n--- FRAGMENTOS RELEVANTES (RAG) ---\n' + contextText;
                                }

                                var messages = VP.rag.promptBuilder.buildMessages({
                                    systemPrompt: systemPrompt, historyMessages: historyMsgs,
                                    userQuery: queryToUse, contextText: contextText,
                                });
                                var payload = VP.rag.promptBuilder.buildPayload(model, messages, { tools: VP.rag.tools.definitions });

                                return _streamChatWithRetry(baseUrl, model, messages, signal, function(fullResponse) {
                                    var toolCalls = VP.rag.tools.parseToolCalls(fullResponse.message);
                                    if (toolCalls) {
                                        return self._executeTools(toolCalls, baseUrl, model, queryToUse, systemPrompt, historyMsgs);
                                    }
                                    return fullResponse.message ? fullResponse.message.content : (fullResponse.text || '');
                                }).then(function(finalText) {
                                    self.memory.addTurn('user', userQuery);
                                    self.memory.addTurn('assistant', finalText);
                                    // FIX v3.1.1: fromCache: false explícito para que
                                    // el caller pueda guardarlo en la semantic cache.
                                    return { responseText: finalText, queryEmbedding: queryEmb, fromCache: false };
                                });
                            });
                        }

                        // FASE 10: Multi-stage retrieval cascade
                        //   1. Exact search → 2. Fuzzy search → 3. BM25 → 4. Semantic → 5. LLM fallback

                        // FASE 12: ventana de contexto alrededor de un cue
                        function _buildContextWindow(cueStart, cues, windowSecs) {
                            if (!cues || !cues.length) return { before: [], after: [] };
                            windowSecs = windowSecs || 10;
                            var before = [], after = [];
                            for (var ci = 0; ci < cues.length; ci++) {
                                var c = cues[ci];
                                if (!c || !c.texto) continue;
                                var t = c.inicio || 0;
                                if (t < cueStart - 0.5 && t >= cueStart - windowSecs) before.push(c);
                                if (t > cueStart + 0.5 && t <= cueStart + windowSecs) after.push(c);
                            }
                            return { before: before, after: after };
                        }

                        function _extractQuotedText(str) {
                            // Emparejar comillas dobles (ASCII o curvas) o simples
                            var m = str.match(/["""]([^"""]+)["""]/);
                            if (m) return m[1];
                            m = str.match(/[']([^']+)[']/);
                            if (m) return m[1];
                            return str;
                        }

                        function _markTermMatches(text, matches) {
                            var ordered = (matches || []).slice().sort(function(a, b) {
                                return a.start - b.start || b.end - a.end;
                            });
                            var parts = [];
                            var cursor = 0;
                            for (var mi = 0; mi < ordered.length; mi++) {
                                var match = ordered[mi];
                                if (!match || match.start < cursor || match.end <= match.start || match.end > text.length) continue;
                                parts.push(text.substring(cursor, match.start));
                                parts.push('\uE000' + text.substring(match.start, match.end) + '\uE001');
                                cursor = match.end;
                            }
                            parts.push(text.substring(cursor));
                            return parts.join('');
                        }

                        function _tryTermSearch() {
                            if (!VP.rag.termSearch || typeof VP.rag.termSearch.search !== 'function') return null;

                            var terms = VP.rag.termSearch.extractTerms(userQuery);
                            if (!terms.length) return null;

                            var subIndex = VP.rag.subtitleIndex.build(cues);
                            var termResults = VP.rag.termSearch.search({
                                terms: terms,
                                subtitleIndex: subIndex,
                                maxResults: 8,
                            });
                            if (!termResults.length) return null;

                            var termLines = ['🔎 **Coincidencias de nombres o términos**\n'];
                            for (var ti = 0; ti < termResults.length; ti++) {
                                var tr = termResults[ti];
                                termLines.push('[' + VP.rag.utils.fmtTime(tr.cue.start) + '] ' +
                                    _markTermMatches(tr.cue.text, tr.matches));
                            }

                            var finalText = termLines.join('\n\n');
                            _state.streamingContent = finalText;
                            _updateAssistantMsg(finalText);
                            var termMsgEl = _state.streamingMsgEl;
                            _finalizeAssistantMsg();
                            if (termMsgEl) termMsgEl.classList.add('chat-ia-term-result');
                            self.memory.addTurn('user', userQuery);
                            self.memory.addTurn('assistant', _stripTermHighlightMarkers(finalText));
                            return { responseText: finalText, fromCache: false, queryEmbedding: null };
                        }

                        function _tryLiteralSearch() {
                            var searchQuery = _extractQuotedText(queryToUse);
                            var subIndex = VP.rag.subtitleIndex.build(cues);
                            var litResults = VP.rag.literalSearch.search({
                                query: searchQuery,
                                subtitleIndex: subIndex,
                                fuzzy: true,
                                maxResults: 10,
                            });
                            if (litResults.length > 0) {
                                // Ordenar: individual cues primero; entre ventanas, la más corta (más precisa) primero
                                litResults.sort(function(a, b) {
                                    if (b.score !== a.score) return b.score - a.score;
                                    var aIsIndiv = a.cue.id >= 0 ? 1 : 0;
                                    var bIsIndiv = b.cue.id >= 0 ? 1 : 0;
                                    if (aIsIndiv !== bIsIndiv) return bIsIndiv - aIsIndiv;
                                    // Ambos son ventanas (o ambos individuales): texto más corto = más preciso
                                    return a.cue.text.length - b.cue.text.length;
                                });
                                // Deduplicar: individual cues se quedan; de las ventanas, solo la primera (más corta)
                                var hasShownWindow = false;
                                var deduped = [];
                                for (var ri = 0; ri < litResults.length; ri++) {
                                    var r = litResults[ri];
                                    if (r.cue.id >= 0) {
                                        deduped.push(r);
                                    } else if (!hasShownWindow) {
                                        // Verificar que ningún individual previo cubra este texto
                                        var covered = false;
                                        for (var di = 0; di < deduped.length; di++) {
                                            if (deduped[di].cue.id >= 0 && r.cue.text.indexOf(deduped[di].cue.text) !== -1) {
                                                covered = true;
                                                break;
                                            }
                                        }
                                        if (!covered) {
                                            deduped.push(r);
                                            hasShownWindow = true;
                                        }
                                    }
                                }
                                litResults = deduped;
                                var bestMatch = litResults[0];
                                // Respuesta directa sin LLM si es exact o fuzzy de alta confianza
                                if (bestMatch.score >= 0.85) {
                                    var matchLines = ['\uD83C\uDFAF **Coincidencia exacta encontrada**\n'];
                                    for (var li = 0; li < Math.min(litResults.length, 5); li++) {
                                        var lr = litResults[li];
                                        var windowCtx = _buildContextWindow(lr.cue.start, cues, 10);
                                        var ts = VP.rag.utils.fmtTime(lr.cue.start);

                                        // Cues anteriores
                                        for (var wi = 0; wi < windowCtx.before.length; wi++) {
                                            var bf = windowCtx.before[wi];
                                            matchLines.push('[' + VP.rag.utils.fmtTime(bf.inicio || 0) + '] ' + bf.texto.trim());
                                        }
                                        // Cue exacto resaltado
                                        matchLines.push('**\u2192 [' + ts + '] \u201C' + lr.cue.text + '\u201D**');
                                        // Cues posteriores
                                        for (var wj = 0; wj < windowCtx.after.length; wj++) {
                                            var af = windowCtx.after[wj];
                                            matchLines.push('[' + VP.rag.utils.fmtTime(af.inicio || 0) + '] ' + af.texto.trim());
                                        }
                                        matchLines.push(''); // separador entre resultados
                                    }
                                    var finalText = matchLines.join('\n').trim();
                                    _state.streamingContent = finalText;
                                    _updateAssistantMsg(finalText);
                                    var litMsgEl = _state.streamingMsgEl;
                                    _finalizeAssistantMsg();
                                    if (litMsgEl) {
                                        litMsgEl.classList.add('chat-ia-literal-result');
                                    }
                                    self.memory.addTurn('user', userQuery);
                                    self.memory.addTurn('assistant', finalText);
                                    return { responseText: finalText, fromCache: false, queryEmbedding: null };
                                }
                                // Resultados de baja confianza: usar como contexto + LLM
                                var litCtxText = '';
                                var litChunks = [];
                                for (var lj = 0; lj < litResults.length; lj++) {
                                    var lr2 = litResults[lj];
                                    var ts2 = VP.rag.utils.fmtTime(lr2.cue.start);
                                    litCtxText += (litCtxText ? '\n---\n' : '') + '[' + lr2.matchType.toUpperCase() + ' ' + lr2.score.toFixed(2) + ']' + ' [' + ts2 + '] ' + lr2.cue.text;
                                    litChunks.push({ start: lr2.cue.start, end: lr2.cue.end, text: lr2.cue.text });
                                }
                                var litCtx = { text: litCtxText, chunks: litChunks, tokens: VP.rag.utils.estTokens(litCtxText), chunkCount: litChunks.length };
                                return _afterRetrieval(litCtx);
                            }
                            return null; // sin resultados literales
                        }

                        function _tryDefinitionSearch() {
                            if (!VP.rag.definitionSearch || typeof VP.rag.definitionSearch.search !== 'function') return null;

                            var topic = VP.rag.definitionSearch.extractTopic(userQuery);
                            if (!topic) return null;

                            var subIndex = VP.rag.subtitleIndex.build(cues);
                            var definitionResults = VP.rag.definitionSearch.search({
                                topic: topic,
                                subtitleIndex: subIndex,
                                maxResults: 4,
                            });
                            if (!definitionResults.length) return null;

                            var definitionLines = ['📘 **Así lo explica el video**\n'];
                            for (var di = 0; di < definitionResults.length; di++) {
                                var dr = definitionResults[di];
                                definitionLines.push('[' + VP.rag.utils.fmtTime(dr.cue.start) + '] ' +
                                    _markTermMatches(dr.cue.text, dr.matches));
                            }

                            var finalText = definitionLines.join('\n\n');
                            _state.streamingContent = finalText;
                            _updateAssistantMsg(finalText);
                            var definitionMsgEl = _state.streamingMsgEl;
                            _finalizeAssistantMsg();
                            if (definitionMsgEl) definitionMsgEl.classList.add('chat-ia-definition-result');
                            self.memory.addTurn('user', userQuery);
                            self.memory.addTurn('assistant', _stripTermHighlightMarkers(finalText));
                            return { responseText: finalText, fromCache: false, queryEmbedding: null };
                        }

                        function _tryStepSearch() {
                            if (!VP.rag.stepSearch || typeof VP.rag.stepSearch.search !== 'function') return null;

                            var task = VP.rag.stepSearch.extractTask(userQuery);
                            if (!task) return null;

                            var stepResults = VP.rag.stepSearch.search({
                                task: task,
                                cues: cues,
                                maxResults: 8,
                            });
                            if (!stepResults.length) return null;

                            var stepLines = ['🪜 **Pasos encontrados en el video**\n'];
                            for (var si = 0; si < stepResults.length; si++) {
                                var sr = stepResults[si];
                                stepLines.push((si + 1) + '. [' + VP.rag.utils.fmtTime(sr.start) + '] ' +
                                    _markTermMatches(sr.text, sr.matches));
                            }

                            var finalText = stepLines.join('\n');
                            _state.streamingContent = finalText;
                            _updateAssistantMsg(finalText);
                            var stepMsgEl = _state.streamingMsgEl;
                            _finalizeAssistantMsg();
                            if (stepMsgEl) stepMsgEl.classList.add('chat-ia-steps-result');
                            self.memory.addTurn('user', userQuery);
                            self.memory.addTurn('assistant', _stripTermHighlightMarkers(finalText));
                            return { responseText: finalText, fromCache: false, queryEmbedding: null };
                        }

                        // FASE 16: Literal Engine + Semantic Engine trabajando juntos
                        // Prioriza pasos, definición, término, búsqueda literal y semántica.
                        var stepResult = _tryStepSearch();
                        if (stepResult) return stepResult;

                        var definitionResult = _tryDefinitionSearch();
                        if (definitionResult) return definitionResult;

                        var termResult = _tryTermSearch();
                        if (termResult) return termResult;

                        // La búsqueda literal va antes de BM25/semántica.
                        var litResult = _tryLiteralSearch();
                        if (litResult) return litResult;

                        // Stage 3+4: BM25 + Semantic (cuando literal no encontró nada)
                        var semPromise = queryEmb
                            ? VP.rag.vectorStore.semanticSearch(videoId, queryEmb, VP.rag.CFG.HYBRID_TOP_K_RETRIEVAL)
                            : Promise.resolve([]);
                        var bm25Promise = self.bm25Index ? Promise.resolve(self.bm25Index.search(queryToUse)) : Promise.resolve([]);

                        return Promise.all([semPromise, bm25Promise]).then(function(results) {
                            var semResults = results[0], bm25Results = results[1];
                            var hasResults = (semResults && semResults.length > 0) || (bm25Results && bm25Results.length > 0);

                            if (!hasResults) {
                                // Stage 5: LLM fallback sin contexto
                                var emptyCtx = { text: '', chunks: [], tokens: 0, chunkCount: 0 };
                                return _afterRetrieval(emptyCtx);
                            }

                            var hybrid = VP.rag.hybridSearch.search(semResults, bm25Results, {
                                mode: intent.mode, currentTime: currentTime, duration: duration,
                                antiSpoiler: intent.antiSpoiler, topK: VP.rag.CFG.HYBRID_TOP_K_RETRIEVAL,
                            });
                            var rrfResults = VP.rag.reranker.rrf(semResults, bm25Results);
                            var finalChunks = VP.rag.reranker.mmr(rrfResults, queryEmb, VP.rag.CFG.HYBRID_FINAL_K);

                            // FASE 14: Hierarchical Retrieval — Level 2 exact cue search dentro de chunks
                            var exactCueText = _searchExactCuesInChunks(queryToUse, finalChunks);

                            var ctxResult = VP.rag.contextBuilder.build(finalChunks, {
                                antiSpoiler: intent.antiSpoiler, currentTime: currentTime, maxTokens: VP.rag.CFG.CTX_MAX_TOKENS,
                            });
                            // Si encontramos cues exactos, anteponerlos al contexto
                            if (exactCueText) {
                                ctxResult.text = exactCueText + '\n\n' + VP.rag.CFG.CTX_SEPARATOR + '\n' + ctxResult.text;
                            }
                            return _afterRetrieval(ctxResult);
                        });
                    });
                });
        });
    };

    RAGEngine.prototype._executeTools = function(toolCalls, baseUrl, model, userQuery, systemPrompt, historyMsgs) {
        var self = this;
        var toolResults = [];
        // Normaliza IDs una sola vez para que coincidan entre el mensaje del
        // asistente y cada respuesta role=tool enviada de vuelta a Ollama.
        var callsForConversation = toolCalls.map(function(call) {
            return {
                id: call.id || ('call_' + Math.random().toString(36).slice(2)),
                name: call.name,
                arguments: call.arguments || {},
            };
        });
        var promises = callsForConversation.map(function(call) {
            return VP.rag.tools.execute(call, self).then(function(result) {
                toolResults.push({ tool_call_id: call.id, content: result });
                return result;
            });
        });
        return Promise.all(promises).then(function() {
            var messagesWithTools = [{ role: 'system', content: systemPrompt }]
                .concat(historyMsgs)
                .concat([{ role: 'user', content: userQuery }, {
                    role: 'assistant', content: '',
                    tool_calls: callsForConversation.map(function(call) {
                        return {
                            id: call.id,
                            type: 'function',
                            function: { name: call.name, arguments: call.arguments },
                        };
                    }),
                }]);
            toolResults.forEach(function(tr) { messagesWithTools.push({ role: 'tool', content: tr.content, tool_call_id: tr.tool_call_id }); });
            return _streamChatWithRetry(baseUrl, model, messagesWithTools, null).then(function(finalText) {
                self.memory.addTurn('user', userQuery);
                self.memory.addTurn('assistant', finalText);
                return finalText;
            });
        });
    };

    // ============================================================
    // 14. STREAMING OLLAMA CON RETRY
    // ============================================================

    var _noToolsModels = new Set();
    var _toolSupportCache = {};

    function _supportsTools(model) {
        if (model in _toolSupportCache) return _toolSupportCache[model];
        if (_noToolsModels.has(model)) return false;
        return true;
    }

    function _probeToolSupport(baseUrl, model) {
        if (model in _toolSupportCache) return;
        if (!VP.ollama || !VP.ollama.fetchModelInfo) return;
        VP.ollama.fetchModelInfo(baseUrl, model, { timeout: 5000 })
            .then(function(info) {
                var supported = info.capabilities && info.capabilities.indexOf('tools') >= 0;
                _toolSupportCache[model] = supported;
                if (!supported) _noToolsModels.add(model);
            })
            .catch(function() {
                _toolSupportCache[model] = false;
                _noToolsModels.add(model);
            });
    }

    function _streamChatWithRetry(baseUrl, model, messages, signal, postProcessFn) {
        var attempt = 0;
        var skipTools = !_supportsTools(model);
        function tryOnce() {
            return _streamChat(baseUrl, model, messages, signal, postProcessFn, skipTools).catch(function(err) {
                if (!err) throw err;
                if (err.name === 'AbortError') throw err;
                if (err.hasPartialOutput) throw err;
                if (!skipTools && err.message && err.message.indexOf('does not support tools') >= 0) {
                    skipTools = true;
                    _noToolsModels.add(model);
                    log.warn('Modelo no soporta tools, reintentando sin tools:', model);
                    _state.streamingContent = '';
                    if (_state.streamingMsgEl) _state.streamingMsgEl.innerHTML = '<span class="chat-ia-retry">↻ Reintentando sin tools…</span>';
                    return tryOnce();
                }
                var is5xx = err.message && /HTTP 5\d\d/.test(err.message);
                var isNet = err.name === 'TypeError' || err.name === 'NetworkError' || (err.message && err.message.indexOf('fetch') >= 0);
                if ((is5xx || isNet) && attempt < CFG.RETRY_MAX && (!signal || !signal.aborted)) {
                    attempt++;
                    _state.metricas.reintentos++;
                    var delay = Math.min(CFG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), CFG.RETRY_MAX_DELAY_MS);
                    log.warn('Reintento ' + attempt + '/' + CFG.RETRY_MAX + ' en ' + delay + 'ms –', err.message || err);
                    _state.streamingContent = '';
                    if (_state.streamingMsgEl) _state.streamingMsgEl.innerHTML = '<span class="chat-ia-retry">↻ Reintentando (' + attempt + '/' + CFG.RETRY_MAX + ')…</span>';
                    return new Promise(function(resolve, reject) {
                        setTimeout(function() {
                            if (signal && signal.aborted) { var ab = new Error('Abortado'); ab.name = 'AbortError'; return reject(ab); }
                            tryOnce().then(resolve).catch(reject);
                        }, delay);
                    });
                }
                throw err;
            });
        }
        return tryOnce();
    }

    function _streamChat(baseUrl, model, messages, signal, postProcessFn, skipTools) {
        var payloadObj = {
            model: model, messages: messages, stream: true,
            options: { temperature: 0.45, top_p: 0.92, num_predict: 2048, num_ctx: 16384 },
        };
        if (!skipTools && VP.rag && VP.rag.tools && Array.isArray(VP.rag.tools.definitions)) {
            payloadObj.tools = VP.rag.tools.definitions;
        }
        var payload = JSON.stringify(payloadObj);
        var maxPayload = (VP.config && VP.config.maxPayloadOllamaChars) || 180000;
        if (payload.length > maxPayload) return Promise.reject(new Error('Prompt demasiado grande para Ollama'));

        return VP.ollama.fetchWithTimeout(baseUrl + CFG.CHAT_ENDPOINT, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: signal,
        }, 120000)
        .then(function(response) {
            if (!response.ok) {
                return response.text().catch(function() { return ''; }).then(function(body) {
                    throw new Error('HTTP ' + response.status + (body ? ': ' + body.slice(0, 200) : ''));
                });
            }
            if (!response.body || typeof response.body.getReader !== 'function') {
                return response.text().then(function(raw) {
                    var lines = (raw || '').split('\n');
                    var fullContent = '';
                    var toolCalls = [];
                    var generatedTokenCount = null;
                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (!line) continue;
                        try {
                            var json = JSON.parse(line);
                            if (json.error) throw new Error('Ollama: ' + json.error);
                            if (typeof json.eval_count === 'number' && isFinite(json.eval_count)) {
                                generatedTokenCount = json.eval_count;
                            }
                            if (json.message && json.message.content) {
                                fullContent += json.message.content;
                                _state.streamingContent = fullContent;
                                _updateAssistantMsg(fullContent);
                            }
                            if (json.message && Array.isArray(json.message.tool_calls) && json.message.tool_calls.length) {
                                toolCalls = json.message.tool_calls;
                            }
                        } catch(e) { if (e.message && e.message.indexOf('Ollama') === 0) throw e; }
                    }
                    if (generatedTokenCount !== null) _state.metricas.tokensTotal += generatedTokenCount;
                    var resp = { message: { role: 'assistant', content: fullContent, tool_calls: toolCalls } };
                    if (postProcessFn) return Promise.resolve(postProcessFn(resp)).then(function(finalText) {
                        _state.streamingContent = finalText;
                        _updateAssistantMsg(finalText);
                        return finalText;
                    });
                    return fullContent;
                });
            }
            var finalMessage = { role: 'assistant', content: '', tool_calls: [] };
            return VP.ollama.readStream(response.body, {
                signal: signal, maxTokens: CFG.STREAM_READ_MAX, timeout: 300000,
                onToken: function(token, fullText) {
                    _state.streamingContent = fullText;
                    _updateAssistantMsg(fullText);
                },
                onDone: function(_fullText, stats, message) {
                    if (message) finalMessage = message;
                    if (stats && Number.isFinite(stats.tokens)) {
                        _state.metricas.tokensTotal += stats.tokens;
                    }
                }
            }).then(function(fullText) {
                // readStream conserva el mensaje completo como tercer argumento
                // de onDone para no cambiar el valor de retorno legacy (texto).
                if (!finalMessage.content && fullText) finalMessage.content = fullText;
                if (postProcessFn) return Promise.resolve(postProcessFn({ message: finalMessage, text: fullText })).then(function(finalText) {
                    _state.streamingContent = finalText;
                    _updateAssistantMsg(finalText);
                    return finalText;
                });
                return fullText;
            });
        });
    }

    // ============================================================
    // 15. MARKDOWN
    // ============================================================

    function _renderMarkdown(text) {
        if (!text) return '';
        // Normalizar CRLF a LF antes de cualquier procesamiento
        text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var codeBlocks = [];
        var withPlaceholders = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
            var idx = codeBlocks.length;
            codeBlocks.push({ lang: lang || '', code: code });
            return '\x00CODE' + idx + '\x00';
        });
        var termMarkers = [];
        withPlaceholders = withPlaceholders.replace(/\uE000([\s\S]*?)\uE001/g, function(_, matchedText) {
            var idx = termMarkers.length;
            termMarkers.push(matchedText);
            return '\x00TERM' + idx + '\x00';
        });
        var html = util.escaparHTML(withPlaceholders);
        html = html.replace(/\x00CODE(\d+)\x00/g, function(_, idx) {
            var block = codeBlocks[parseInt(idx, 10)];
            var langLabel = block.lang ? '<span class="chat-ia-code-lang">' + util.escaparHTML(block.lang) + '</span>' : '';
            return '<pre class="chat-ia-code-block">' + langLabel + '<code>' + util.escaparHTML(block.code).replace(/\n$/, '') + '</code></pre>';
        });
        html = html.replace(/`([^`\n]+)`/g, '<code class="chat-ia-inline-code">$1</code>');
        html = html.replace(/^#{1,4}\s+(.+)$/gm, function(_, t) { return '<span class="summary-heading">' + t + '</span>'; });
        html = html.replace(/^&gt;\s(.+)$/gm, function(_, q) { return '<blockquote class="chat-ia-blockquote">' + q + '</blockquote>'; });
        var strongMarkers = [];
        html = html.replace(/\*\*([^*]+?)\*\*/g, function(m, c) {
            var idx = strongMarkers.length;
            strongMarkers.push('<strong>' + c + '</strong>');
            return '\x00STRONG' + idx + '\x00';
        });
        html = html.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
        html = html.replace(/\x00STRONG(\d+)\x00/g, function(_, idx) {
            return strongMarkers[parseInt(idx, 10)] || '';
        });
        html = html.replace(/~~([^\n~]+?)~~/g, '<del>$1</del>');
        html = html.replace(/^[ \t]*[-•*]\s+(.+)$/gm, function(_, c) { return '<span class="summary-bullet">• ' + c + '</span>'; });
        html = html.replace(/^[ \t]*(\d+)[.)]\s+(.+)$/gm, function(_, n, c) { return '<span class="summary-bullet">' + n + '. ' + c + '</span>'; });
        html = html.replace(/\n{3,}/g, '\n\n');
        html = html.replace(/\n/g, '<br>');
        html = html.replace(/(<br>){3,}/g, '<br><br>');
        html = html.replace(/\x00TERM(\d+)\x00/g, function(_, idx) {
            var matchedText = termMarkers[parseInt(idx, 10)] || '';
            return '<mark class="chat-ia-term-highlight">' + util.escaparHTML(matchedText) + '</mark>';
        });
        return html;
    }

    function _stripTermHighlightMarkers(text) {
        return String(text || '').replace(/[\uE000\uE001]/g, '');
    }

    // ============================================================
    // 16. BÚSQUEDA EN CONVERSACIÓN
    // ============================================================

    function _buscarEnConversacion(query) {
        _state._searchQuery = (query || '').trim();
        _renderAllMessages();
        var badge = _el('chatIASearchBadge');
        if (badge) {
            if (_state._searchQuery) {
                var count = _state.conversation.filter(function(m) {
                    return m.content.toLowerCase().indexOf(_state._searchQuery.toLowerCase()) >= 0;
                }).length;
                badge.textContent = count + ' resultado(s)';
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
            }
        }
    }

    // ============================================================
    // 17. HELPERS
    // ============================================================

    function _fmtTime(s) {
        s = Number(s); if (!isFinite(s) || s < 0) return '0:00';
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
        var pad = function(n) { return n < 10 ? '0' + n : String(n); };
        return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
    }

    function _parseTimestamp(ts) {
        if (!ts || typeof ts !== 'string') return NaN;
        var parts = ts.trim().split(':');
        if (parts.length === 3) {
            var h = +parts[0], mi = +parts[1], sc = +parts[2];
            if (!isFinite(h) || !isFinite(mi) || !isFinite(sc)) return NaN;
            if (h > 23 || mi >= 60 || sc >= 60) return NaN;
            return h * 3600 + mi * 60 + sc;
        }
        if (parts.length === 2) {
            var m2 = +parts[0], s2 = +parts[1];
            if (!isFinite(m2) || !isFinite(s2)) return NaN;
            if (m2 >= 60 || s2 >= 60) return NaN;
            return m2 * 60 + s2;
        }
        return NaN;
    }

    function _isValidUrl(str) {
        if (!str || typeof str !== 'string') return false;
        if (!/^https?:\/\//i.test(str.trim())) return false;
        try { new URL(str.trim()); return true; } catch (_) { return false; }
    }

    function _normalizeUrl(raw) {
        var url = (typeof raw === 'string' ? raw : '').trim();
        if (!url) return CFG.DEFAULT_URL;
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
        return url.replace(/\/+$/, '');
    }

    function _autoResizeInput(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    // ============================================================
    // 18. MODAL ABRIR/CERRAR
    // ============================================================

    function _openModal(event) {
        var modal = _el('chatIAModal');
        if (!modal) return;
        var alreadyOpen = modal.classList.contains('active');

        var trigger = event && event.currentTarget;
        if (!trigger || trigger === document || modal.contains(trigger)) trigger = document.activeElement;
        if (!trigger || trigger === document.body || trigger === document.documentElement || modal.contains(trigger)) {
            trigger = _el('chatIABtn');
        }
        _state.returnFocusEl = trigger;

        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
        if (!alreadyOpen && VP.ajustes && VP.ajustes.activarMochiIA && VP.mochiMascota &&
                typeof VP.mochiMascota.iniciarConversacion === 'function') {
            VP.mochiMascota.iniciarConversacion();
        }
        try { modal.focus(); } catch (_) {}
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(true);

        var savedUrl = util.storageGet(CFG.PREF_URL, '');
        var urlInput = _el('chatIAUrl');
        if (savedUrl && urlInput) urlInput.value = savedUrl;

        _updateSubtitleStatus();
        _updateContextBadge();
        _restoreSuggestions();

        if (_state._openLoadTimer !== null) clearTimeout(_state._openLoadTimer);
        var openLoadRevision = ++_state._conversationLoadRevision;

        _state._openLoadTimer = setTimeout(function() {
            _state._openLoadTimer = null;
            _populateModels(urlInput ? urlInput.value : '');
            if (openLoadRevision === _state._conversationLoadRevision) {
                _loadConversation().then(function() {
                    _renderAllMessages();
                }).catch(function(e) { log.warn('Error cargando conversacion:', e.message || e); });
            }
            var input = _el('chatIAInput');
            if (input) input.focus();
        }, 50);
    }

    function _closeModal() {
        var modal = _el('chatIAModal');
        if (!modal) return;
        var wasOpen = modal.classList.contains('active');

        if (_state.isStreaming) {
            try { if (!window.confirm('La IA está respondiendo. ¿Cerrar de todos modos?')) return; } catch (_) {}
            if (_state.abortController) try { _state.abortController.abort(); } catch (_) {}
        }

        if (_state._openLoadTimer !== null) {
            clearTimeout(_state._openLoadTimer);
            _state._openLoadTimer = null;
            _state._conversationLoadRevision++;
        }

        // Quitar inert y sacar el foco del diálogo antes de ocultarlo a
        // tecnologías asistivas para evitar aria-hidden sobre un elemento enfocado.
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(false);
        var returnFocus = _state.returnFocusEl;
        if (!returnFocus || returnFocus === document.body || returnFocus === document.documentElement ||
            modal.contains(returnFocus) || !document.documentElement.contains(returnFocus) ||
            returnFocus.disabled || typeof returnFocus.focus !== 'function') {
            returnFocus = _el('chatIABtn');
        }
        if (returnFocus && !modal.contains(returnFocus) && typeof returnFocus.focus === 'function') {
            try { returnFocus.focus(); } catch (_) {}
        }
        var active = document.activeElement;
        if (active && modal.contains(active) && typeof active.blur === 'function') {
            try { active.blur(); } catch (_) {}
        }
        _state.returnFocusEl = null;

        if (wasOpen && VP.ajustes && VP.ajustes.activarMochiIA && VP.mochiMascota &&
                typeof VP.mochiMascota.cerrarConversacion === 'function') {
            VP.mochiMascota.cerrarConversacion();
        }
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');

        var markerDialog = _el(CFG.MARKER_DIALOG_ID);
        if (markerDialog && markerDialog.parentNode) markerDialog.parentNode.removeChild(markerDialog);
    }

    // ============================================================
    // 19. EXPORTACIÓN
    // ============================================================

    function _exportConversation(formato) {
        if (!_state.conversation.length) { _notif('No hay conversación para exportar', 'advertencia'); return; }
        if (typeof util.sanitizarNombreArchivo !== 'function' || typeof util.obtenerNombreBase !== 'function') {
            _notif('Funciones de exportación no disponibles', 'error'); return;
        }

        var title    = _getVideoTitle();
        var safeName = util.sanitizarNombreArchivo(util.obtenerNombreBase(title));
        var blob, filename;

        if (formato === 'json') {
            var exportMessages = _state.conversation.map(function(msg) {
                var copy = {};
                var keys = Object.keys(msg);
                for (var ki = 0; ki < keys.length; ki++) copy[keys[ki]] = msg[keys[ki]];
                if (typeof copy.content === 'string') copy.content = _stripTermHighlightMarkers(copy.content);
                return copy;
            });
            var exportData = {
                version: '3.0.1', videoTitle: title, videoId: _getVideoId(),
                exportedAt: new Date().toISOString(), mensajes: _state.conversation.length,
                metricas: _state.metricas, messages: exportMessages,
            };
            blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json;charset=utf-8' });
            filename = 'chat_' + safeName + '.json';
        } else {
            // FIX v3.1.1: '═'.repeat(50) no es ES5 compatible; usar Array join
            var separator = new Array(51).join('═');
            var lines = ['CONVERSACIÓN — ' + title, 'Fecha: ' + new Date().toLocaleString('es'), 'Mensajes: ' + _state.conversation.length, separator, ''];
            for (var i = 0; i < _state.conversation.length; i++) {
                var msg = _state.conversation[i], role = msg.role === 'user' ? '👤 Tú' : '🤖 IA';
                var ts = msg.ts ? ' [' + new Date(msg.ts).toLocaleTimeString('es', {
                    hour: '2-digit', minute: '2-digit', hour12: true,
                }) + ']' : '';
                lines.push(role + ts + ':'); lines.push(_stripTermHighlightMarkers(msg.content || '')); lines.push('');
            }
            blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
            filename = 'chat_' + safeName + '.txt';
        }

        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename; a.style.cssText = 'display:none';
        document.body.appendChild(a); a.click();
        setTimeout(function() {
            try { document.body.removeChild(a); } catch (_) {}
            try { URL.revokeObjectURL(url); } catch (_) {}
        }, 1500);
        _notif('Conversación exportada (' + (formato || 'txt').toUpperCase() + ')', 'exito');
    }

    // ============================================================
    // 20. CAMBIO DE VIDEO
    // ============================================================

    function _onVideoChanged() {
        var newId = _getVideoId();
        if (newId === _state.currentVideoId) return;

        log.debug('Video cambiado →', newId);

        if (_state.currentVideoId && _state.conversation.length) _saveConversation(_state.currentVideoId);
        _state._conversationLoadRevision++;
        _state._conversationRevision++;
        if (_state.isStreaming && _state.abortController) try { _state.abortController.abort(); } catch (_) {}
        _state.isStreaming = false;
        _state.abortController = null;
        _discardStreamingMessage();
        _state.currentVideoId = newId;
        _state.conversation = [];
        _state._searchQuery = '';

        if (_state.ragEngine) _state.ragEngine = new RAGEngine();

        var modal = _el('chatIAModal');
        if (modal && modal.classList.contains('active')) {
            _loadConversation().then(function() {
                _renderAllMessages();
                _updateSubtitleStatus();
                _updateContextBadge();
                _maybeGenerateSuggestions();
            }).catch(function(e) { log.warn('Error cargando conversacion:', e.message || e); });
        }
    }

    // ============================================================
    // 21. REGISTRO DE EVENTOS
    // ============================================================

    function _registerEvents() {
        _bind('chatIABtn',        _openModal);
        _bind('chatIAModalClose', _closeModal);
        _bind('chatIAClearBtn',   function() {
            var hadConversation = _state.conversation.length > 0;
            if (hadConversation) {
                try { if (!window.confirm('¿Limpiar toda la conversación?')) return; } catch (_) {}
            }
            // Limpiar también invalida una carga de la base de datos que aún
            // no haya terminado, incluso si el arreglo todavía parece vacío.
            _clearConversation();
            _renderAllMessages();
            _maybeGenerateSuggestions();
            if (hadConversation) _notif('Conversación limpiada', 'info');
        });
        _bind('chatIAExportBtn',     function() { _exportConversation('txt'); });
        _bind('chatIAExportJsonBtn', function() { _exportConversation('json'); });
        _bind('chatIASendBtn', _sendMessage);

        _bind('chatIARefreshSuggestionsBtn', function() {
            var model = (_el('chatIAModel') && _el('chatIAModel').value.trim()) || '';
            if (model) _generarSugerenciasDesdeOllama(model);
            else _notif('Selecciona un modelo primero', 'advertencia');
        });

        var input = _el('chatIAInput');
        if (input) {
            _addTracked(input, 'keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendMessage(); }
            }, _state._docListeners);
            _addTracked(input, 'input', function() { _autoResizeInput(input); }, _state._docListeners);
        }

        var searchInput = _el('chatIASearch');
        if (searchInput) {
            var _debSearch = util.debounce(function() { _buscarEnConversacion(searchInput.value); }, 300);
            _addTracked(searchInput, 'input', _debSearch, _state._docListeners);
        }

        var suggestions = _el('chatIASuggestions');
        if (suggestions) {
            _addTracked(suggestions, 'click', function(e) {
                var li = _closest(e.target, 'li');
                if (!li || !li.dataset.suggestion) return;
                var inputEl = _el('chatIAInput');
                if (inputEl) { inputEl.value = li.dataset.suggestion; _autoResizeInput(inputEl); inputEl.focus(); }
            }, _state._docListeners);
        }

        _bind('chatIARefreshModelsBtn', function() { var u = _el('chatIAUrl'); _populateModels(u ? u.value : ''); });

        var modal = _el('chatIAModal');
        if (modal) {
            _addTracked(modal, 'click', function(e) { if (e.target === modal) _closeModal(); }, _state._docListeners);
        }

        if (typeof VP.eventos.registrarModalIA === 'function') VP.eventos.registrarModalIA('chatIAModal', _closeModal);

        var modelSelect = _el('chatIAModel');
        if (modelSelect) {
            _addTracked(modelSelect, 'change', function() {
                try { util.storageSet(CFG.PREF_MODEL, modelSelect.value); } catch (_) {}
                _updateModelBadge();
            }, _state._docListeners);
        }

        var urlInput = _el('chatIAUrl');
        if (urlInput) {
            var _debUrl = util.debounce(function() {
                var val = _normalizeUrl(urlInput.value);
                if (_isValidUrl(val)) _populateModels(val);
            }, 900);
            _addTracked(urlInput, 'input', _debUrl, _state._docListeners);
        }

        _addTracked(document, 'keydown', function(e) {
            var sc = CFG.KEYBOARD_SHORTCUT;
            if (e.key.toLowerCase() === sc.key && !!e.ctrlKey === sc.ctrl && !!e.shiftKey === sc.shift) {
                e.preventDefault();
                var m = _el('chatIAModal');
                if (m && m.classList.contains('active')) _closeModal(); else _openModal();
            }
        }, _state._docListeners);

        if (bus) {
            var busEvents = [
                ['videoCambiado',      _onVideoChanged],
                ['videoReproduciendo', _onVideoChanged],
                ['videoListo',         function() { _onVideoChanged(); _updateContextBadge(); }],
                ['subtitulosCargados', function() {
                    _state._subtitleCache.videoId = '';
                    _updateSubtitleStatus(); _updateContextBadge(); _maybeGenerateSuggestions();
                }],
                ['videoDetenido',      function() { _state.currentVideoId = ''; }],
                ['cacheVaciada',       function() {
                    _state._conversationLoadRevision++;
                    _state._conversationRevision++;
                    _state.conversation = [];
                    _state._searchQuery = '';
                    _discardStreamingMessage();
                }],
                ['reset',              function() {
                    if (_state.isStreaming && _state.abortController) try { _state.abortController.abort(); } catch (_) {}
                    _state._conversationLoadRevision++;
                    _state._conversationRevision++;
                    _state.isStreaming = false; _state.abortController = null; _discardStreamingMessage();
                    _state.conversation = []; _state.currentVideoId = ''; _state._searchQuery = '';
                }],
            ];
            for (var i = 0; i < busEvents.length; i++) {
                bus.on(busEvents[i][0], busEvents[i][1]);
                _state._busListeners.push({ event: busEvents[i][0], handler: busEvents[i][1] });
            }
        }

        var video = VP.refs && VP.refs.videoPlayer;
        if (video && !dom.esNulo(video)) _addTracked(video, 'loadstart', _onVideoChanged, _state._videoListeners);
    }

    function _bind(id, handler) {
        var el = _el(id);
        if (el) _addTracked(el, 'click', handler, _state._docListeners);
    }

    // ============================================================
    // 22. DESTRUIR
    // ============================================================

    function _destroy() {
        if (_state.isStreaming && _state.abortController) try { _state.abortController.abort(); } catch (_) {}
        if (_state._openLoadTimer !== null) {
            clearTimeout(_state._openLoadTimer);
            _state._openLoadTimer = null;
        }
        _state._conversationLoadRevision++;
        _state._conversationRevision++;
        _removeTracked(_state._docListeners);
        _removeTracked(_state._videoListeners);
        if (bus) {
            for (var i = 0; i < _state._busListeners.length; i++) {
                try { bus.off(_state._busListeners[i].event, _state._busListeners[i].handler); } catch (_) {}
            }
        }
        _state._busListeners.length = 0;
        _state.isStreaming = false; _state.abortController = null; _discardStreamingMessage();
        _state.conversation = []; _state._initialized = false; _state._searchQuery = '';
        log.info('Módulo destruido.');
    }

    // ============================================================
    // 23. API PÚBLICA
    // ============================================================

    VP.chatIA = {
        open             : _openModal,
        close            : _closeModal,
        send             : _sendMessage,
        clear            : function() {
            _clearConversation();
            _renderAllMessages();
            _maybeGenerateSuggestions();
        },
        getConversation  : function() { return _state.conversation.slice(); },
        exportar         : function() { _exportConversation('txt'); },
        exportarJSON     : function() { _exportConversation('json'); },
        importar         : _importConversation,
        buscar           : _buscarEnConversacion,
        destroy          : _destroy,
        obtenerMetricas  : function() {
            return {
                mensajesEnviados : _state.metricas.mensajesEnviados,
                mensajesRecibidos: _state.metricas.mensajesRecibidos,
                marcadoresCreados: _state.metricas.marcadoresCreados,
                errores         : _state.metricas.errores,
                tokensTotal     : _state.metricas.tokensTotal,
                reintentos      : _state.metricas.reintentos,
                tiempoTotalMs   : _state.metricas.tiempoTotalMs,
                tiempoPromedioMs: _state.metricas.tiempoPromedioMs,
                conversationLen : _state.conversation.length,
                currentVideoId  : _state.currentVideoId,
                isStreaming     : _state.isStreaming,
            };
        },
    };

    window.VP_ChatIA = VP.chatIA;

    // ============================================================
    // 24. INICIALIZACIÓN
    // ============================================================

    function _init() {
        if (_state._initialized) return;
        _state._initialized = true;
        _state.welcomeEl = _el('chatIAWelcome');
        _registerEvents();
        _state.currentVideoId = _getVideoId();
        log.info('Módulo iniciado v3.0.0 (RAG) | VideoId:', _state.currentVideoId || '(ninguno)');
    }

    // ============================================================
    // 25. ESPERAR A VP
    // ============================================================

    function _waitForVP() {
        var initialized = false, attempts = 0;
        function tryInit() { if (initialized) return; initialized = true; _init(); }
        function poll() {
            if (initialized) return;
            attempts++;
            if (VP.log && VP.bus && VP.dom && VP.util && VP.rag) { tryInit(); return; }
            var delay = Math.min(25 * Math.pow(1.4, attempts - 1), 500);
            setTimeout(poll, delay);
        }
        document.addEventListener('vpReady', function() { tryInit(); });
        poll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _waitForVP);
    else _waitForVP();

    // ============================================================
    // 26. VERIFICACIÓN DE API PÚBLICA
    // ============================================================
    (function() {
        var reqs = ['open','close','send','clear','getConversation','exportar','exportarJSON','importar','buscar','destroy','obtenerMetricas'];
        var missing = [];
        for (var i = 0; i < reqs.length; i++) { if (typeof VP.chatIA[reqs[i]] !== 'function') missing.push(reqs[i]); }
        if (missing.length) log.error('Funciones faltantes →', missing.join(', '));
        else log.debug('Verificación OK (' + reqs.length + ' funciones).');
    })();

    log.info('vp-chat-ia.js v3.0.0 (RAG) cargado.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-chat-ia.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
