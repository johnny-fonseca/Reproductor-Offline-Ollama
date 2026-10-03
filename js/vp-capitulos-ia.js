'use strict';

// ============================================================
// VP-CAPITULOS-IA.JS  —  v5.0.0
// Generación, persistencia y restauración de capítulos con IA
// (Ollama). Integración completa con el ecosistema VP.
//
// v5.0.0 — Chunking temporal inteligente:
//   · Procesamiento del SRT completo (sin truncar) en segmentos de 3min
//   · Prompts focalizados por chunk → detecta CADA juego/ítem
//   · /no_think para Qwen3 (evita tokens de razonamiento redundantes)
//   · Detección automática de videos tipo lista ("20 RPGs", "Top N")
//   · Fusión + deduplicación semántica de resultados entre chunks
//   · Fallback clásico si chunking no produce resultados
//   · Consolidación IA opcional para ajustar a N capítulos exactos
// ============================================================

(function (window, document) {
    if (window.__VP_CAPITULOS_IA_LOADED__) return;
    window.__VP_CAPITULOS_IA_LOADED__ = true;

    // ============================================================
    // 0. VERIFICACIÓN DE DEPENDENCIAS
    // ============================================================

    var VP = window.VP;

    if (!VP) {
        throw new Error('[VP] vp-capitulos-ia.js: vp-base.js debe cargarse primero.');
    }

    var _deps = {
        util: VP.util,
        dom:  VP.dom,
        log:  VP.log,
        bus:  VP.bus,
        db:   VP.db,
    };

    var _depKeys = Object.keys(_deps);
    for (var _di = 0; _di < _depKeys.length; _di++) {
        if (!_deps[_depKeys[_di]]) {
            throw new Error('[VP] vp-capitulos-ia.js: dependencia faltante → VP.' + _depKeys[_di]);
        }
    }

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;
    log.setContext('CapitulosIA');

    // ============================================================
    // 0.1. FUNCIONES AUXILIARES SEGURAS (reemplazan util.xxx ausentes)
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

    function _sanitizarNombreArchivo(nombre) {
        if (!nombre || typeof nombre !== 'string') return 'video';
        return nombre.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 100);
    }

    // Wrapper seguro para cualquier util.xxx (devuelve valor por defecto si no existe)
    function _safeUtil(method, defecto) {
        return function () {
            try {
                if (util && typeof util[method] === 'function') {
                    return util[method].apply(util, arguments);
                }
            } catch (_) {}
            return defecto;
        };
    }

    // Fallback para util.escaparHTML (usado en render)
    var _safeEscaparHTML = _safeUtil('escaparHTML', function (s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); });

    // ============================================================
    // 1. NAMESPACE
    // ============================================================

    VP.capitulosIA = VP.capitulosIA || {};

    // ============================================================
    // 2. CONSTANTES AMPLIADAS
    // ============================================================

var CFG = Object.freeze({
         DEFAULT_URL          : 'http://localhost:11434',
         FETCH_TIMEOUT_MS     : 60000,  // Aumentado para modelos grandes
         STREAM_READ_MAX      : 30000,  // Aumentado para respuestas largas
         CONNECT_TIMEOUT_MS   : 15000,
         RETRY_BASE_MS        : 1000,
         MAX_RETRIES          : 2,

         MIN_CHAPTERS         : 2,
         MAX_CHAPTERS         : 40,    // Aumentado para listas largas (20 RPGs, etc.)
         AUTO_COUNT           : 0,

         URL_DEBOUNCE_MS      : 600,
         STREAM_PREVIEW_CHARS : 600,
         MODAL_FOCUS_DELAY_MS : 100,

         STORAGE_PREFIX       : 'vpChapIA_',
         CACHE_LRU_MAX        : 250,

         CB_UMBRAL_FALLAS     : 4,
         CB_REPOSO_BASE_MS    : 15000,
         CB_MAX_REPOSO_MS     : 120000,

         EDGE_LEFT_PCT        : 6,
         EDGE_RIGHT_PCT       : 94,

         // Chunking inteligente: procesa el SRT completo en segmentos temporales
         SUBTITLE_MAX_CHARS   : 60000, // Sin truncar: el chunking lo maneja
         CHUNK_DURATION_S     : 180,   // 3 minutos por chunk
         CHUNK_OVERLAP_S      : 20,    // 20s de solapamiento entre chunks
         CHUNK_MAX_CHARS      : 3500,  // Máx chars por chunk al LLM
         CHUNK_MERGE_GAP_S    : 25,    // Capítulos a menos de 25s → fusionar

         MAX_JSON_REPAIRS     : 7,
         MAX_RECENT_ITEMS     : 10,

         PREF_MODEL           : 'chaptersIA_model',
         PREF_URL             : 'vp_ollama_url',
         PREF_LANGUAGE        : 'vp_ia_language',
         PREF_DEFAULT_LANG    : 'es',
         PREF_COUNT           : 'chaptersIA_count',
         PREF_PROMPT          : 'chaptersIA_prompt',

         // Parámetros Ollama para modelos locales (Qwen, LLaMA, etc.)
         QWEN_TEMPERATURE     : 0.15,  // Muy bajo: respuestas estructuradas y precisas
         QWEN_TOP_P           : 0.80,
         QWEN_NUM_PREDICT     : 1024,  // Por chunk es suficiente
         DEFAULT_TEMPERATURE  : 0.25,
         DEFAULT_TOP_P        : 0.90,
         DEFAULT_NUM_PREDICT  : 2048,
     });

    // ============================================================
    // 3. ESTADO INTERNO
    // ============================================================

    var _state = {
        abortController       : null,
        isGenerating          : false,
        currentGenVideoId     : null,
        generatedChapters     : [],
        appliedChapters       : [],
        lastRawText           : '',
        currentVideoId        : '',
        urlDebounceTimer      : null,
        cbFallos              : 0,
        cbAbierto             : false,
        cbTimer               : null,
        _docListeners         : [],
        _videoListeners       : [],
        _busListeners         : [],
        _stylesInjected       : false,
        _markersLayerId       : 'vpChaptersIAMarkersLayer',
        _initialized          : false,
        _generationQueue      : [],
        _modelCache           : {},
        _recentGenerations    : [],
        _uiFramePending       : false,
        _activeTooltip        : null,
        _unloadHandler        : null,
    };

    // ============================================================
    // 4. CACHÉ LRU (Map)
    // ============================================================

    var _cacheLRU = (function () {
        var capacity = CFG.CACHE_LRU_MAX;
        var map = new Map();

        function touch(key) {
            var entry = map.get(key);
            if (entry) {
                map.delete(key);
                map.set(key, entry);
            }
            return entry;
        }

        function evict() {
            while (map.size > capacity) {
                var oldest = map.keys().next().value;
                map.delete(oldest);
            }
        }

        return {
            get: function (id) {
                var entry = touch(id);
                return entry || null;
            },
            set: function (id, data) {
                if (!id) return;
                map.set(id, {
                    chapters: data.chapters || [],
                    rawText: data.rawText || '',
                    model: data.model || '',
                    ts: Date.now(),
                });
                evict();
            },
            has: function (id) { return map.has(id); },
            del: function (id) { map.delete(id); },
            clear: function () { map.clear(); },
            size: function () { return map.size; },
        };
    })();

    // ============================================================
    // 5. CIRCUIT BREAKER CON BACKOFF
    // ============================================================

    function _cbRegistrarFallo() {
        _state.cbFallos++;
        if (_state.cbFallos >= CFG.CB_UMBRAL_FALLAS && !_state.cbAbierto) {
            _state.cbAbierto = true;
            var backoff = Math.min(
                CFG.CB_REPOSO_BASE_MS * Math.pow(2, _state.cbFallos - CFG.CB_UMBRAL_FALLAS),
                CFG.CB_MAX_REPOSO_MS
            );
            log.warn('Circuit-breaker ABIERTO por ' + backoff + 'ms tras ' + _state.cbFallos + ' fallos.');
            bus.emit('capitulosIA:circuitBreaker', true);

            clearTimeout(_state.cbTimer);
            _state.cbTimer = setTimeout(function () {
                _state.cbAbierto = false;
                _state.cbFallos = 0;
                log.info('Circuit-breaker restablecido.');
                bus.emit('capitulosIA:circuitBreaker', false);
            }, backoff);
        }
    }

    function _cbRegistrarExito() {
        _state.cbFallos = 0;
        if (_state.cbAbierto) {
            _state.cbAbierto = false;
            clearTimeout(_state.cbTimer);
            log.info('Circuit-breaker cerrado por éxito.');
            bus.emit('capitulosIA:circuitBreaker', false);
        }
    }

    // ============================================================
    // 6. GESTIÓN DE LISTENERS (ANTI MEMORY-LEAK)
    // ============================================================

    function _addTracked(target, event, handler, store) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(event, handler);
        (store || _state._docListeners).push({
            target: target,
            event: event,
            handler: handler,
        });
    }

    function _removeTracked(store) {
        for (var i = 0; i < store.length; i++) {
            try {
                store[i].target.removeEventListener(store[i].event, store[i].handler);
            } catch (_) {}
        }
        store.length = 0;
    }

    // ============================================================
    // 7. IDENTIFICACIÓN DE VIDEO
    // ============================================================

    function _getVideoId() {
        var ci = VP.estado && VP.estado.currentVideoIndex;
        var pl = VP.estado && VP.estado.playlist;
        if (typeof ci === 'number' && ci >= 0 && pl && pl[ci]) {
            var v = pl[ci];
            if (v.name) return v.name;
            if (v.id) return String(v.id);
        }

        var cv = window.vpCurrentVideo;
        if (cv) {
            if (cv.name) return cv.name;
            if (cv.id) return String(cv.id);
        }

        var video = VP.refs && VP.refs.videoPlayer;
        if (video && !dom.esNulo(video)) {
            var src = (video.currentSrc || video.src || '').trim();
            if (src) return 'src_' + _hashCode(src).toString(36);
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
        if (video && !dom.esNulo(video) && isFinite(video.duration) && video.duration > 0) {
            return video.duration;
        }
        var vObj = _getVideoObj();
        if (vObj && isFinite(vObj.duration) && vObj.duration > 0) {
            return vObj.duration;
        }
        return 0;
    }

    // ============================================================
    // 8. PERSISTENCIA
    // ============================================================

    function _persistirCapitulos(videoId, chapters, rawText, model) {
        if (!videoId || !Array.isArray(chapters)) return;

        var datos = {
            chapters: chapters,
            rawText: rawText || '',
            model: model || '',
            ts: Date.now(),
            version: 4,
        };

        _cacheLRU.set(videoId, datos);

        // IDB (no bloqueante)
        try {
            if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
                VP.db.guardarMetadatos(videoId, {
                    chaptersIA: chapters,
                    chaptersIARaw: rawText || '',
                    chaptersIAModel: model || '',
                    chaptersIATs: datos.ts,
                }).catch(function (e) {
                    log.warn('IDB guardar falló:', e);
                });
            }
        } catch (e) {
            log.warn('IDB excepción:', e);
        }

        // Caché (compacto)
        try {
            var lsKey = CFG.STORAGE_PREFIX + videoId;
            var compacto = chapters.map(function (ch) {
                return { t: ch.time, s: Math.round(ch.seconds), T: _truncar(ch.title, 80) };
            });
            util.storageSet(lsKey, {
                c: compacto,
                m: model || '',
                ts: datos.ts,
            });
        } catch (e) {
            log.debug('LS guardar falló:', e);
        }

        _addToRecent(videoId, chapters.length, model);

        log.info('Persistidos → ' + videoId + ' | ' + chapters.length + ' caps');
    }

    function _cargarCapitulos(videoId) {
        if (!videoId) return Promise.resolve(null);

        var cached = _cacheLRU.get(videoId);
        if (cached && cached.chapters && cached.chapters.length > 0) {
            return Promise.resolve({ chapters: cached.chapters, model: cached.model || '', source: 'memory' });
        }

        var promesaIDB = Promise.resolve(null);
        if (VP.db && typeof VP.db.obtenerMetadatos === 'function') {
            promesaIDB = VP.db.obtenerMetadatos(videoId)
                .then(function (meta) {
                    if (meta && Array.isArray(meta.chaptersIA) && meta.chaptersIA.length > 0) {
                        _cacheLRU.set(videoId, {
                            chapters: meta.chaptersIA,
                            rawText: meta.chaptersIARaw || '',
                            model: meta.chaptersIAModel || '',
                        });
                        return { chapters: meta.chaptersIA, model: meta.chaptersIAModel || '', source: 'idb' };
                    }
                    return null;
                })
                .catch(function (e) {
                    log.debug('IDB leer error:', e);
                    return null;
                });
        }

        return promesaIDB.then(function (resultado) {
            if (resultado) return resultado;
            try {
                var lsKey = CFG.STORAGE_PREFIX + videoId;
                var stored = util.storageGet(lsKey, null);
                if (stored && stored.c && Array.isArray(stored.c) && stored.c.length > 0) {
                    var chapters = stored.c.map(function (ch) {
                        return { time: ch.t || '00:00', seconds: ch.s || 0, title: ch.T || '' };
                    });
                    _cacheLRU.set(videoId, { chapters: chapters, model: stored.m || '' });
                    return { chapters: chapters, model: stored.m || '', source: 'cache' };
                }
            } catch (_) {}
            return null;
        });
    }

    function _eliminarCapitulos(videoId) {
        if (!videoId) return;
        _cacheLRU.del(videoId);
        try { util.eliminarItem(CFG.STORAGE_PREFIX + videoId); } catch (_) {}
        try {
            if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
                VP.db.guardarMetadatos(videoId, {
                    chaptersIA: null, chaptersIARaw: null, chaptersIAModel: null, chaptersIATs: null
                }).catch(function () {});
            }
        } catch (_) {}
        log.debug('Borrados → ' + videoId);
    }

    function _addToRecent(videoId, count, model) {
        _state._recentGenerations.unshift({
            videoId: videoId,
            count: count,
            model: model,
            ts: Date.now(),
        });
        if (_state._recentGenerations.length > CFG.MAX_RECENT_ITEMS) {
            _state._recentGenerations.length = CFG.MAX_RECENT_ITEMS;
        }
    }

    // ============================================================
    // 9. HELPERS DE TIEMPO
    // ============================================================

    function _pad2(n) { return n < 10 ? '0' + n : String(n); }

    function _secondsToTimestamp(s) {
        s = Number(s);
        if (!isFinite(s) || s < 0) return '00:00';
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = Math.floor(s % 60);
        return h > 0 ? _pad2(h) + ':' + _pad2(m) + ':' + _pad2(sec) : _pad2(m) + ':' + _pad2(sec);
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

// ============================================================
// 9.5. LIMPIEZA DE SUBTÍTULOS
// ============================================================

function cleanSubtitleText(text) {
    if (!text || typeof text !== 'string') return '';
    
    // Split into lines
    var lines = text.split('\n');
    var cleanedLines = [];
    var prevText = null;
    
    // Define patterns to remove
    var fillerWords = /\b(eh|emm|ah|mmm|este|ok|bueno)\b/gi;
    var noisePatterns = /\[(música|aplausos|risas|silencio)\]|\((music|laughs)\)/gi;
    
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue; // Skip empty lines
        
        // Extract timestamp and content
        var timestampMatch = line.match(/^(\[[\d:]+\])\s+(.*)$/);
        if (!timestampMatch) {
            // If line doesn't match expected format, skip or keep as is?
            // For safety, let's keep it but clean the content
            var content = line;
            var timestamp = '';
        } else {
            var timestamp = timestampMatch[1];
            var content = timestampMatch[2];
        }
        
        // Clean content
        // Remove fillers
        content = content.replace(fillerWords, '');
        // Remove narrative noise
        content = content.replace(noisePatterns, '');
        // Compact spaces
        content = content.replace(/\s+/g, ' ');
        // Trim
        content = content.trim();
        
        // Skip if content becomes empty after cleaning
        if (!content) continue;
        
        // Check for excessive repetitions (same word repeated 3+ times)
        // This is a simple check - could be improved
        var words = content.split(' ');
        var hasExcessiveRep = false;
        for (var j = 0; j < words.length - 2; j++) {
            if (words[j] && words[j] === words[j+1] && words[j] === words[j+2]) {
                hasExcessiveRep = true;
                break;
            }
        }
        if (hasExcessiveRep) continue;
        
        // Reconstruct line
        var cleanedLine = timestamp ? (timestamp + ' ' + content) : content;
        
        // Skip consecutive duplicates
        if (cleanedLine === prevText) continue;
        
        cleanedLines.push(cleanedLine);
        prevText = cleanedLine;
    }
    
    return cleanedLines.join('\n');
}

// ============================================================
// 9.6. AGRUPACIÓN SEMÁNTICA DE SUBTÍTULOS
// ============================================================

function _buildSemanticTranscript(subtitleText, maxGroupDurationSeconds = 30) {
    if (!subtitleText || typeof subtitleText !== 'string') return '';
    
    var lines = subtitleText.split('\n');
    var groupedLines = [];
    var currentGroup = {
        startTime: null,
        endTime: null,
        texts: []
    };
    
    // Process each line
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        
        // Extract timestamp and content
        var timestampMatch = line.match(/^\[([\d:]+)\]\s*(.*)$/);
        if (!timestampMatch) {
            // If line doesn't match expected format, add as is to current group
            if (currentGroup.texts.length > 0) {
                currentGroup.texts.push(line);
            }
            continue;
        }
        
        var timestampStr = timestampMatch[1];
        var content = timestampMatch[2].trim();
        
        if (!content) continue;
        
        var currentSeconds = _timestampToSeconds(timestampStr);
        
        // If this is the first line or if the gap is too large, start a new group
        if (currentGroup.startTime === null || 
            (currentSeconds - currentGroup.endTime) > maxGroupDurationSeconds) {
            
            // Save previous group if it exists
            if (currentGroup.texts.length > 0) {
                var groupText = currentGroup.texts.join(' ');
                var startTimestamp = _secondsToTimestamp(currentGroup.startTime);
                var endTimestamp = _secondsToTimestamp(currentGroup.endTime);
                groupedLines.push('[' + startTimestamp + ' - ' + endTimestamp + '] ' + groupText);
            }
            
            // Start new group
            currentGroup = {
                startTime: currentSeconds,
                endTime: currentSeconds,
                texts: [content]
            };
        } else {
            // Add to current group
            currentGroup.endTime = currentSeconds;
            currentGroup.texts.push(content);
        }
    }
    
    // Don't forget the last group
    if (currentGroup.texts.length > 0) {
        var groupText = currentGroup.texts.join(' ');
        var startTimestamp = _secondsToTimestamp(currentGroup.startTime);
        var endTimestamp = _secondsToTimestamp(currentGroup.endTime);
        groupedLines.push('[' + startTimestamp + ' - ' + endTimestamp + '] ' + groupText);
    }
    
    return groupedLines.join('\n');
}

// ============================================================
// 9.7. DETECCIÓN DE CAMBIOS DE TEMA
// ============================================================

function _detectTopicChanges(processedText, minWordsPerTopic = 20) {
    if (!processedText || typeof processedText !== 'string') return [];
    
    var lines = processedText.split('\n');
    var topicChanges = [];
    
    // Simple topic detection based on keyword frequency and shifts
    // This is a simplified implementation - could be enhanced with NLP techniques
    
    // Common stop words to ignore
    var stopWords = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'pero', 'porque', 'que', 'como', 'cuando', 'donde', 'quien', 'cual', 'es', 'son', 'estar', 'tener', 'hacer', 'poder', 'decir', 'ir', 'ver', 'dar', 'saber', 'querer', 'llegar', 'pasar', 'deber', 'poner', 'parecer', 'quedar', 'creer', 'hablar', 'llevar', 'dejar', 'seguir', 'encontrar', 'llamar', 'venir', 'pensar', 'salir', 'volver', 'tomar', 'conocer', 'vivir', 'sentir', 'tratar', 'mirar', 'contar', 'empezar', 'esperar', 'buscar', 'existir', 'entrar', 'tocar', 'subir', 'bajar', 'girar', 'abrir', 'volver', 'poner', 'parecer', 'quedar', 'creer', 'hablar', 'llevar', 'dejar', 'seguir', 'encontrar', 'llamar', 'venir', 'pensar', 'salir', 'volver', 'tomar', 'conocer', 'vivir', 'sentir', 'tratar', 'mirar', 'contar', 'empezar', 'esperar', 'buscar', 'existir', 'entrar', 'tocar', 'subir', 'bajar', 'girar', 'abrir']);
    
    // Process each line to extract meaningful words
    var lineTopics = [];
    
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        
        // Extract timestamp and content
        var timestampMatch = line.match(/^\[([\d:]+(?:\s*-\s*[\d:]+)?)\]\s*(.*)$/);
        var timestamp = timestampMatch ? timestampMatch[1] : '';
        var content = timestampMatch ? timestampMatch[2] : line;
        
        if (!content) continue;
        
        // Extract words (simple approach)
        var words = content.toLowerCase().match(/\b[a-záéíóúñü]+\b/g) || [];
        
        // Filter out stop words and short words
        var meaningfulWords = words.filter(function(word) {
            return word.length > 2 && !stopWords.has(word);
        });
        
        // Store timestamp and meaningful words for this line
        if (meaningfulWords.length > 0) {
            lineTopics.push({
                timestamp: timestamp,
                words: meaningfulWords,
                lineIndex: i
            });
        }
    }
    
    // Detect topic changes by comparing word frequency between consecutive lines
    for (var i = 1; i < lineTopics.length; i++) {
        var prevWords = lineTopics[i-1].words;
        var currWords = lineTopics[i].words;
        
        // Calculate simple similarity (Jaccard index)
        var prevSet = new Set(prevWords);
        var currSet = new Set(currWords);
        
        var intersection = 0;
        var union = new Set([...prevWords, ...currWords]).size;
        
        prevWords.forEach(function(word) {
            if (currSet.has(word)) intersection++;
        });
        
        var similarity = union > 0 ? intersection / union : 0;
        
        // If similarity is low, consider it a topic change
        if (similarity < 0.3) { // Threshold can be adjusted
            topicChanges.push({
                timestamp: lineTopics[i].timestamp,
                lineIndex: lineTopics[i].lineIndex,
                similarity: similarity
            });
        }
    }
    
    // Also detect topic changes based on time gaps (pauses)
    for (var i = 1; i < lines.length; i++) {
        var prevLine = lines[i-1].trim();
        var currLine = lines[i].trim();
        
        if (!prevLine || !currLine) continue;
        
        var prevTimestampMatch = prevLine.match(/^\[([\d:]+)\]/);
        var currTimestampMatch = currLine.match(/^\[([\d:]+)\]/);
        
        if (prevTimestampMatch && currTimestampMatch) {
            var prevSeconds = _timestampToSeconds(prevTimestampMatch[1]);
            var currSeconds = _timestampToSeconds(currTimestampMatch[1]);
            
            // If there's a significant gap (more than 10 seconds), consider it a topic change
            if (currSeconds - prevSeconds > 10) {
                topicChanges.push({
                    timestamp: currTimestampMatch[1],
                    lineIndex: i,
                    timeGap: currSeconds - prevSeconds
                });
            }
        }
    }
    
    // Sort by line index and remove duplicates
    topicChanges.sort(function(a, b) {
        return (a.lineIndex || 0) - (b.lineIndex || 0);
    });
    
    var uniqueChanges = [];
    var lastIndex = -1;
    
    for (var i = 0; i < topicChanges.length; i++) {
        if (topicChanges[i].lineIndex !== lastIndex) {
            uniqueChanges.push(topicChanges[i]);
            lastIndex = topicChanges[i].lineIndex;
        }
    }
    
    return uniqueChanges;
}

// ============================================================
// 9.8. CÁLCULO ÓPTIMO DE CANTIDAD DE CAPÍTULOS
// ============================================================

function _calculateOptimalChapterCount(videoDuration, videoTitle, subtitleText) {
    if (!videoDuration || videoDuration <= 0) return CFG.AUTO_COUNT;
    
    // Primero: detectar si es un video tipo lista ("20 RPGs", "Top 10", etc.)
    var listInfo = _detectListContent(videoTitle, subtitleText);
    if (listInfo.isList && listInfo.expectedCount >= 3) {
        // Para listas, el número óptimo ES el número de elementos de la lista
        var capped = Math.min(listInfo.expectedCount, CFG.MAX_CHAPTERS);
        log.info('Video tipo lista detectado: ' + listInfo.expectedCount + ' elementos → ' + capped + ' capítulos');
        return capped;
    }
    
    var durationMinutes = videoDuration / 60;
    
    // Para videos largos: más capítulos (1 cada 1-2 min, mínimo por contenido)
    var byDuration;
    if (durationMinutes <= 5)       byDuration = Math.round(durationMinutes);        // ~1/min
    else if (durationMinutes <= 15) byDuration = Math.round(durationMinutes / 1.5);  // ~0.67/min
    else if (durationMinutes <= 30) byDuration = Math.round(durationMinutes / 2);    // ~0.5/min
    else                            byDuration = Math.round(durationMinutes / 3);    // ~0.33/min
    
    return Math.max(CFG.MIN_CHAPTERS, Math.min(CFG.MAX_CHAPTERS, byDuration));
}

// ============================================================
// 9.10. DETECCIÓN DE MODELO QWEN
// ============================================================

function _isQwenModel(model) {
    if (!model || typeof model !== 'string') return false;
    var m = model.toLowerCase();
    return m.indexOf('qwen') !== -1;
}

// ============================================================
// 9.11. DETECCIÓN DE CONTENIDO TIPO LISTA
// Detecta videos como "20 RPGs olvidados", "Top 10 juegos", etc.
// ============================================================

function _detectListContent(videoTitle, subtitleText) {
    var result = { isList: false, expectedCount: 0 };
    
    var title = (videoTitle || '').toLowerCase();
    var sub   = (subtitleText || '').toLowerCase().slice(0, 3000);
    
    // Patrones: "20 rpgs", "top 15", "10 juegos", "los mejores 25", etc.
    var listPatterns = [
        /\b(\d{1,3})\s+(?:rpgs?|jrpgs?|juegos?|games?|títulos?|opciones?|razones?|cosas?|tips?|trucos?)\b/i,
        /\btop\s+(\d{1,3})\b/i,
        /\blos?\s+(\d{1,3})\s+(?:mejores?|peores?|grandes?)\b/i,
        /\b(\d{1,3})\s+(?:mejores?|increíbles?|imprescindibles?|olvidados?)\b/i,
    ];
    
    var combined = title + ' ' + sub;
    for (var p = 0; p < listPatterns.length; p++) {
        var m = combined.match(listPatterns[p]);
        if (m && m[1]) {
            var n = parseInt(m[1], 10);
            if (n >= 3 && n <= 100) {
                result.isList = true;
                result.expectedCount = n;
                break;
            }
        }
    }
    
    return result;
}

// ============================================================
// 9.12. PARSEO COMPLETO DE CUES (sin truncar)
// Devuelve array de {seconds, text} para TODOS los subtítulos
// ============================================================

function _parseSrtCues(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];
    
    var lines = rawText.split('\n');
    var cues = [];
    
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        
        // Formato: [MM:SS] texto  o  [HH:MM:SS] texto
        var m = line.match(/^\[([\d]{1,2}:[\d]{2}(?::[\d]{2})?)\]\s+(.+)$/);
        if (!m) continue;
        
        var seconds = _timestampToSeconds(m[1]);
        var text = m[2].trim();
        if (!text) continue;
        
        // Saltar cues duplicados consecutivos (mismo texto)
        if (cues.length > 0 && cues[cues.length - 1].text === text) continue;
        
        cues.push({ seconds: seconds, text: text });
    }
    
    return cues;
}

// ============================================================
// 9.13. SPLIT EN CHUNKS TEMPORALES CON SOLAPAMIENTO
// ============================================================

function _splitCuesIntoChunks(cues, chunkDurationS, overlapS) {
    chunkDurationS = chunkDurationS || CFG.CHUNK_DURATION_S;
    overlapS       = overlapS       || CFG.CHUNK_OVERLAP_S;
    
    if (!cues || cues.length === 0) return [];
    
    var totalDuration = cues[cues.length - 1].seconds;
    var chunks = [];
    var chunkStart = 0;
    
    while (chunkStart <= totalDuration) {
        var chunkEnd = chunkStart + chunkDurationS;
        
        // Recolectar cues dentro de [chunkStart - overlapS, chunkEnd]
        var cuesInChunk = [];
        for (var i = 0; i < cues.length; i++) {
            var s = cues[i].seconds;
            if (s >= Math.max(0, chunkStart - overlapS) && s < chunkEnd) {
                cuesInChunk.push(cues[i]);
            }
        }
        
        if (cuesInChunk.length > 0) {
            // Construir texto del chunk, limitado a CHUNK_MAX_CHARS
            var lines = [];
            var totalChars = 0;
            for (var j = 0; j < cuesInChunk.length; j++) {
                var line = '[' + _secondsToTimestamp(cuesInChunk[j].seconds) + '] ' + cuesInChunk[j].text;
                if (totalChars + line.length > CFG.CHUNK_MAX_CHARS) break;
                lines.push(line);
                totalChars += line.length + 1;
            }
            
            if (lines.length > 0) {
                chunks.push({
                    index:     chunks.length,
                    startS:    chunkStart,
                    endS:      Math.min(chunkEnd, totalDuration),
                    startTime: _secondsToTimestamp(chunkStart),
                    endTime:   _secondsToTimestamp(Math.min(chunkEnd, totalDuration)),
                    text:      lines.join('\n'),
                });
            }
        }
        
        // Avanzar al siguiente chunk
        chunkStart += chunkDurationS;
        
        // Si ya estamos más allá del final, terminar
        if (chunkStart > totalDuration + chunkDurationS) break;
    }
    
    return chunks;
}

// ============================================================
// 9.14. PROMPT FOCALIZADO POR CHUNK
// ============================================================

function _buildChunkPrompt(opts) {
    var chunk         = opts.chunk;
    var totalChunks   = opts.totalChunks;
    var videoTitle    = opts.videoTitle    || '';
    var videoDuration = opts.videoDuration || '';
    var language      = opts.language      || 'es';
    var isQwen        = opts.isQwen        || false;
    var isList        = opts.isList        || false;
    var listCount     = opts.listCount     || 0;
    
    var noThink = isQwen ? '/no_think\n' : '';
    
    var listHint = '';
    if (isList && listCount > 0) {
        listHint = 'CONTEXTO IMPORTANTE: Este video es una lista de ' + listCount + ' elementos distintos (juegos, ítems, etc.). ' +
                   'Cada elemento es un capítulo separado. NO los agrupes.\n\n';
    }
    
    var lines = [
        noThink,
        'Analiza este segmento de subtítulos y extrae los capítulos que COMIENZAN en él.',
        '',
        listHint,
        'VIDEO: "' + videoTitle + '" | Duración total: ' + videoDuration,
        'SEGMENTO ' + (chunk.index + 1) + '/' + totalChunks + ': ' + chunk.startTime + ' → ' + chunk.endTime,
        '',
        'SUBTÍTULOS DE ESTE SEGMENTO:',
        chunk.text,
        '',
        'INSTRUCCIONES:',
        '1. Identifica CADA tema, juego, sección o punto NUEVO que empieza en este segmento (' + chunk.startTime + ' a ' + chunk.endTime + ').',
        '2. Usa el timestamp EXACTO del primer subtítulo donde aparece ese tema.',
        '3. El título debe ser conciso, descriptivo y en ' + language + ' (máx 60 caracteres).',
        '4. Si el segmento es continuación de algo que ya empezó antes, NO lo incluyas (solo lo nuevo).',
        '5. Si no empieza nada nuevo en este segmento, devuelve: []',
        '',
        'FORMATO DE SALIDA (JSON puro, sin explicaciones, sin markdown):',
        '[{"time":"MM:SS","title":"Título descriptivo"}]',
    ];
    
    return lines.filter(function(l) { return l !== undefined && l !== null; }).join('\n');
}

// ============================================================
// 9.15. FUSIÓN Y DEDUPLICACIÓN DE CAPÍTULOS DE MÚLTIPLES CHUNKS
// ============================================================

function _mergeAllChapters(allResults) {
    // Aplanar todos los resultados en un solo array
    var all = [];
    for (var i = 0; i < allResults.length; i++) {
        var result = allResults[i];
        if (Array.isArray(result)) {
            for (var j = 0; j < result.length; j++) {
                all.push(result[j]);
            }
        }
    }
    
    if (all.length === 0) return [];
    
    // Ordenar por segundos
    all.sort(function(a, b) { return a.seconds - b.seconds; });
    
    // Deduplicar: si dos capítulos están a menos de CHUNK_MERGE_GAP_S segundos, conservar el primero
    var merged = [];
    for (var k = 0; k < all.length; k++) {
        var ch = all[k];
        
        if (merged.length === 0) {
            merged.push(ch);
            continue;
        }
        
        var prev = merged[merged.length - 1];
        var gap  = ch.seconds - prev.seconds;
        
        if (gap < CFG.CHUNK_MERGE_GAP_S) {
            // Demasiado cerca: conservar el que tiene título más informativo (más largo)
            if (ch.title.length > prev.title.length) {
                merged[merged.length - 1] = ch;
            }
            // Si no, mantener el previo
        } else {
            merged.push(ch);
        }
    }
    
    return merged;
}

// ============================================================
// 9.16. PROCESAMIENTO DE VIDEOS LARGOS (PARA _getSubtitleText)
// Ya no trunca: simplemente limpia y devuelve el texto completo.
// El chunking real lo hace _generateChunked.
// ============================================================

function _processLongVideoSubtitles(rawSubtitles, videoDuration) {
    if (!rawSubtitles) return '';
    // Limpieza ligera para el contexto: sin truncar
    // El procesamiento por chunks se hace en _generateChunked
    return rawSubtitles;
}

// ============================================================
// 9.11. SISTEMA DE SCORING DE CAPÍTULOS
// ============================================================

function _scoreChapters(chapters, videoDuration) {
    if (!Array.isArray(chapters) || chapters.length === 0) {
        return 0;
    }
    
    var score = 0;
    var maxScore = 100;
    
    // 1. Cobertura temporal (0-25 puntos)
    // Cuánto del video está cubierto por los capítulos
    if (videoDuration > 0 && chapters.length > 0) {
        var lastChapterTime = chapters[chapters.length - 1].seconds;
        var coverage = Math.min(1.0, lastChapterTime / videoDuration);
        score += coverage * 25;
    }
    
    // 2. Separación adecuada entre capítulos (0-20 puntos)
    // Verificar que los capítulos no estén demasiado juntos ni demasiado separados
    if (chapters.length > 1) {
        var gaps = [];
        for (var i = 1; i < chapters.length; i++) {
            gaps.push(chapters[i].seconds - chapters[i-1].seconds);
        }
        
        var avgGap = gaps.reduce(function(a, b) { return a + b; }, 0) / gaps.length;
        var minGap = Math.min.apply(null, gaps);
        
        // Ideal gap: between 30 seconds and 3 minutes
        var gapScore = 0;
        if (avgGap >= 30 && avgGap <= 180) {
            gapScore = 10; // Good average gap
        } else if (avgGap > 180) {
            gapScore = Math.max(0, 10 - (avgGap - 180) / 60); // Penalize too large gaps
        } else {
            gapScore = Math.max(0, 10 - (30 - avgGap)); // Penalize too small gaps
        }
        
        // Bonus for minimum gap not being too small
        if (minGap >= 10) {
            gapScore += 10;
        } else if (minGap > 0) {
            gapScore += (minGap / 10) * 10; // Partial credit
        }
        
        score += Math.min(20, gapScore);
    }
    
    // 3. Calidad de títulos (0-20 puntos)
    var titleScore = 0;
    for (var i = 0; i < chapters.length; i++) {
        var title = chapters[i].title.trim();
        
        // Penalize garbage titles
        var garbagePatterns = [
            /^continuaci[oó]n$/i,
            /^seguimos$/i,
            /^m[áa]s información$/i,
            /^parte\s+\d+$/i,
            /^capítulo\s+\d+$/i,
            /^[\s\-_:.]*$/i,
            /^(ok|bueno|eh|emm|ah|mmm|este)+$/i
        ];
        
        var isGarbage = garbagePatterns.some(function(pattern) {
            return pattern.test(title);
        });
        
        if (isGarbage) {
            titleScore += 0; // No points for garbage
        } else {
            // Points for length (not too short, not too long)
            var lengthScore = 0;
            if (title.length >= 10 && title.length <= 60) {
                lengthScore = 5;
            } else if (title.length > 0) {
                lengthScore = Math.max(0, 5 - Math.abs(35 - title.length) / 10);
            }
            
            // Points for not being generic
            var genericPenalty = 0;
            var genericWords = ['introducción', 'conclusión', 'resumen', 'fin', 'inicio'];
            var lowerTitle = title.toLowerCase();
            for (var j = 0; j < genericWords.length; j++) {
                if (lowerTitle.indexOf(genericWords[j]) !== -1) {
                    genericPenalty += 1;
                }
            }
            var specificityScore = Math.max(0, 5 - genericPenalty);
            
            titleScore += lengthScore + specificityScore;
        }
    }
    // Normalize title score to 20 points max
    titleScore = Math.min(20, (titleScore / chapters.length) * 2);
    score += titleScore;
    
    // 4. Distribución narrativa (0-20 puntos)
    // Verificar que los capítulos sigan una progresión lógica
    if (chapters.length >= 3) {
        // Simple check: chapters should be roughly evenly distributed
        var expectedInterval = videoDuration / (chapters.length - 1);
        var timingScore = 0;
        
        for (var i = 0; i < chapters.length; i++) {
            var expectedTime = i * expectedInterval;
            var actualTime = chapters[i].seconds;
            var deviation = Math.abs(actualTime - expectedTime);
            var deviationScore = Math.max(0, 1 - deviation / expectedInterval);
            timingScore += deviationScore;
        }
        
        timingScore = (timingScore / chapters.length) * 20;
        score += Math.min(20, timingScore);
    }
    
    // 5. Redundancia (0-15 puntos)
    // Verificar que no haya capítulos demasiado similares
    if (chapters.length > 1) {
        var redundancyScore = 15; // Start with full points
        
        // Simple check: look for similar titles
        for (var i = 0; i < chapters.length; i++) {
            for (var j = i + 1; j < chapters.length; j++) {
                var title1 = chapters[i].title.toLowerCase();
                var title2 = chapters[j].title.toLowerCase();
                
                // Simple similarity check based on common words
                var words1 = title1.match(/\b\w{3,}\b/g) || [];
                var words2 = title2.match(/\b\w{3,}\b/g) || [];
                
                var commonWords = 0;
                for (var k = 0; k < words1.length; k++) {
                    if (words2.indexOf(words1[k]) !== -1) {
                        commonWords++;
                    }
                }
                
                var totalWords = words1.length + words2.length;
                if (totalWords > 0) {
                    var similarity = commonWords * 2 / totalWords;
                    if (similarity > 0.5) { // Very similar titles
                        redundancyScore -= 2;
                    }
                }
            }
        }
        
        redundancyScore = Math.max(0, redundancyScore);
        score += redundancyScore;
    }
    
    // Ensure score is within bounds
    return Math.max(0, Math.min(maxScore, score));
}

// ============================================================
// 10. NORMALIZAR CAPÍTULOS
// ============================================================
// 9.9. GENERACIÓN DE RESUMEN NARRATIVO (PRIMER PASO)
// ============================================================

function _generateNarrativeSummary(baseUrl, model, videoContext, signal) {
    var summaryPrompt = [
        'Eres un asistente experto en análisis de contenido multimedia y síntesis de información.',
        'Tu tarea es crear un resumen narrativo conciso pero completo del contenido proporcionado.',
        'El resumen debe capturar los temas principales, el flujo narrativo y los puntos clave.',
        'Evita detalles excesivos pero mantiene la coherencia y el contexto general.',
        '',
        'FORMATO DE RESPUESTA:',
        'Un párrafo de resumen en español (o el idioma del contenido).',
        '',
        'CONTENIDO PARA RESUMIR:',
        videoContext,
        '',
        'Responde ÚNICAMENTE con el resumen. NO agregues explicaciones ni texto adicional.'
    ].join('\n');

    return _callOllamaStream(baseUrl, model, summaryPrompt, null, signal);
}

// ============================================================
// 10. NORMALIZAR CAPÍTULOS
// ============================================================

function _normalizar(chapters) {
    if (!Array.isArray(chapters) || !chapters.length) return [];

    var out = [];
    for (var i = 0; i < chapters.length; i++) {
        var ch = chapters[i];
        if (!ch || typeof ch !== 'object') continue;

        var seconds = (typeof ch.seconds === 'number' && isFinite(ch.seconds))
            ? Math.max(0, ch.seconds)
            : _timestampToSeconds(ch.time || '00:00');

        var time = (typeof ch.time === 'string' && ch.time.trim())
            ? ch.time.trim()
            : _secondsToTimestamp(seconds);

        var title = (typeof ch.title === 'string' && ch.title.trim())
            ? ch.title.trim()
            : 'Capítulo ' + (i+1);

        // Truncate title to reasonable length
        title = _truncar(title, 120);

        out.push({ time: time, title: title, seconds: seconds });
    }

    // Sort by timestamp
    out.sort(function (a, b) { return a.seconds - b.seconds; });

    // Remove duplicates and invalid chapters
    var deduped = [];
    var lastSec = -1;
    
    for (var j = 0; j < out.length; j++) {
        var ch = out[j];
        
        // Skip if timestamp is invalid or duplicate
        if (!isFinite(ch.seconds) || ch.seconds < 0 || ch.seconds === lastSec) {
            continue;
        }
        
        // Skip chapters with garbage titles
        var garbageTitlePatterns = [
            /^continuaci[oó]n$/i,
            /^seguimos$/i,
            /^m[áa]s información$/i,
            /^parte\s+\d+$/i,
            /^capítulo\s+\d+$/i,
            /^[\s\-_:.]*$/i, // Only punctuation/spaces
            /^(ok|bueno|eh|emm|ah|mmm|este)+$/i // Fillers only
        ];
        
        var isGarbage = garbageTitlePatterns.some(function(pattern) {
            return pattern.test(ch.title.trim());
        });
        
        if (isGarbage) {
            continue;
        }
        
        // Skip chapters that are too short (less than 5 seconds) except possibly the first one
        if (j > 0 && ch.seconds - lastSec < 5) {
            continue;
        }
        
        deduped.push(ch);
        lastSec = ch.seconds;
    }
    
    // Ensure first chapter starts at 0
    if (deduped.length > 0 && deduped[0].seconds > 0) {
        // If first chapter doesn't start at 0, insert one that does
        deduped.unshift({
            time: '00:00',
            title: 'Introducción',
            seconds: 0
        });
    } else if (deduped.length === 0) {
        // If no chapters, create a default one
        deduped.push({
            time: '00:00',
            title: 'Contenido principal',
            seconds: 0
        });
    }
    
    return deduped;
}

    // ============================================================
    // 11. VALIDACIÓN DE URL
    // ============================================================

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

    // ============================================================
    // 12. PREFERENCIAS
    // ============================================================

    function _guardarPreferencia(clave, valor) {
        try { util.storageSet(clave, valor); } catch (_) {}
    }

    function _leerPreferencia(clave, defecto) {
        return util.storageGet(clave, defecto);
    }

    // ============================================================
    // 13. OLLAMA — CARGA DE MODELOS
    // ============================================================

function _fetchModels(baseUrl) {
    if (_state._modelCache[baseUrl]) {
        return Promise.resolve(_state._modelCache[baseUrl]);
    }
    return VP.ollama.fetchModels(baseUrl, { timeout: CFG.CONNECT_TIMEOUT_MS })
        .then(function (names) {
            _state._modelCache[baseUrl] = names;
            return names;
        });
}

// ============================================================
// 14.1. SISTEMA DE FALLBACK MULTI-MODELO
// ============================================================

function _getFallbackModels() {
    // Ordered list of fallback models to try
    return ['llama3', 'mistral', 'qwen', 'gemma'];
}

function _callOllamaWithFallback(baseUrl, preferredModel, prompt, onChunk, signal) {
    var fallbackModels = _getFallbackModels();
    var modelsToTry = [preferredModel].concat(fallbackModels.filter(function(m) { return m !== preferredModel; }));
    
    var tryModel = function(index) {
        if (index >= modelsToTry.length) {
            return Promise.reject(new Error('Todos los modelos fallaron'));
        }
        
        var model = modelsToTry[index];
        log.info('Intentando con modelo: ' + model);
        
        return _callOllamaStream(baseUrl, model, prompt, onChunk, signal)
            .catch(function(error) {
                log.warn('Modelo ' + model + ' falló: ' + (error && error.message ? error.message : String(error)));
                if ((error && error.name === 'AbortError') || (error && error.hasPartialOutput)) {
                    throw error;
                }
                if (error && error.code !== 'MODEL_NOT_FOUND' && VP.ollama &&
                    typeof VP.ollama.isRetryableError === 'function' && !VP.ollama.isRetryableError(error)) {
                    throw error;
                }
                // Try next model
                return tryModel(index + 1);
            });
    };
    
    return tryModel(0);
}

// ============================================================
// 15. NORMALIZAR CAPÍTULOS
// ============================================================

    function _populateModels(rawUrl) {
        var select = _el('chaptersIAModel');
        if (!select) return;

        var baseUrl = _normalizeUrl(rawUrl);
        if (!_isValidUrl(baseUrl)) {
            select.innerHTML = '<option value="">URL inválida</option>';
            select.disabled = true;
            _updateModelBadge();
            return;
        }

        select.innerHTML = '<option value="">Cargando modelos…</option>';
        select.disabled = true;

        _fetchModels(baseUrl)
            .then(function (models) {
                if (!models.length) {
                    select.innerHTML = '<option value="">Sin modelos disponibles</option>';
                    select.disabled = false;
                    _updateModelBadge();
                    return;
                }

                var frag = document.createDocumentFragment();
                for (var i = 0; i < models.length; i++) {
                    var opt = document.createElement('option');
                    opt.value = models[i];
                    opt.textContent = models[i];
                    frag.appendChild(opt);
                }
                select.innerHTML = '';
                select.appendChild(frag);
                select.disabled = false;

                var saved = _leerPreferencia(CFG.PREF_MODEL, '');
                if (saved && models.indexOf(saved) >= 0) select.value = saved;
                _updateModelBadge();
            })
            .catch(function (err) {
                select.innerHTML = '<option value="">Error de conexión</option>';
                select.disabled = false;
                log.warn('fetchModels:', err.message || err);
                _updateModelBadge();
            });
    }

    // ============================================================
    // 14. CONTEXTO DEL VIDEO (SUBTÍTULOS Y METADATOS)
    // ============================================================

function _getSubtitleText() {
    var text = '';
    try {
        // Primero intentar obtener de window.vpSubtitleCues (establecido por vp-subtitulos.js)
        var cues = window.vpSubtitleCues;
        if (Array.isArray(cues) && cues.length > 0) {
            var lines = [];
            for (var i = 0; i < cues.length; i++) {
                var c = cues[i];
                if (c && c.texto) {
                    lines.push('[' + _secondsToTimestamp(c.inicio || 0) + '] ' + c.texto);
                }
            }
            text = lines.join('\n');
        } else {
            // Si no hay cues globales, verificar directamente en el reproductor
            var video = VP.refs && VP.refs.videoPlayer;
            if (video && !dom.esNulo(video)) {
                var tracks = video.textTracks;
                if (tracks && tracks.length > 0) {
                    for (var i = 0; i < tracks.length; i++) {
                        var track = tracks[i];
                        // Solo considerar pistas de subtítulos que estén cargadas
                        if (track.kind === 'subtitles' && track.cues && track.cues.length > 0) {
                            // Intentar obtener texto de todas las cues
                            var activeLines = [];
                            for (var j = 0; j < track.cues.length; j++) {
                                var cue = track.cues[j];
                                if (cue && cue.text) activeLines.push('[' + _secondsToTimestamp(cue.startTime || 0) + '] ' + cue.text);
                            }
                            if (activeLines.length > 0) {
                                text = activeLines.join('\n');
                                break;
                            }
                        }
                    }
                }
            }
        }
    } catch (_) {}

    // NO truncar — el chunking en _generateChunked maneja el contexto
    // _processLongVideoSubtitles simplemente limpia sin truncar
    var duration = _getVideoDuration();
    if (text && duration > 0) {
        text = _processLongVideoSubtitles(text, duration);
    }

    return text;
}

function _buildVideoContext() {
    var duration = _getVideoDuration();
    var durStr = duration > 0 ? _secondsToTimestamp(duration) : 'desconocida';
    var vObj = _getVideoObj();
    var title = vObj ? (vObj.name || 'Sin título') : 'Sin título';
    var rawSubtitles = _getSubtitleText();

    var lines = [
        'Título: ' + title,
        'Duración: ' + durStr,
        'Formato: ' + (duration > 3600 ? 'largo' : 'corto'),
        '',
    ];

    // Process subtitles with intelligent cleaning and semantic grouping
    if (rawSubtitles) {
        // Clean the subtitle text
        var cleanedSubtitles = cleanSubtitleText(rawSubtitles);
        
        // Build semantic transcript (group related subtitles)
        var semanticTranscript = _buildSemanticTranscript(cleanedSubtitles, 30); // 30-second groups
        
        // Detect topic changes for additional context
        var topicChanges = _detectTopicChanges(semanticTranscript);
        
        lines.push('Transcripción / Subtítulos (procesados sémanticamente):');
        lines.push(semanticTranscript);
        
        if (topicChanges.length > 0) {
            lines.push('');
            lines.push('Cambios de tema detectados en:');
            for (var i = 0; i < Math.min(topicChanges.length, 5); i++) { // Limit to first 5
                var change = topicChanges[i];
                var timeInfo = change.timestamp || 'unknown';
                lines.push('- ' + timeInfo + 
                    (change.similarity !== undefined ? 
                     ' (similitud: ' + change.similarity.toFixed(2) + ')' : 
                     (change.timeGap !== undefined ? 
                      ' (gap: ' + change.timeGap + 's)' : '')));
            }
            if (topicChanges.length > 5) {
                lines.push('  ... y ' + (topicChanges.length - 5) + ' cambios más');
            }
        }
    } else {
        lines.push('(Sin transcripción. Estima los capítulos basándote en la duración y el título.)');
    }

    return lines.join('\n');
}

    // ============================================================
    // 15. PROMPT
    // ============================================================

function _buildPrompt(opts) {
     var count = Number(opts.count) || CFG.AUTO_COUNT;
     var lang = String(opts.language || _leerPreferencia(CFG.PREF_DEFAULT_LANG, 'es'));
     var custom = String(opts.customPrompt || '').trim().slice(0, 600);
     var isAuto = (count === CFG.AUTO_COUNT);
     var context = _buildVideoContext();

     // Detección correcta de modelo Qwen (soporta qwen9b:latest, qwen3:8b, etc.)
     var modelEl = _el('chaptersIAModel');
     var selectedModel = modelEl ? modelEl.value : '';
     var isQwenModel = _isQwenModel(selectedModel);

     var countInstr = isAuto
         ? 'Decide TÚ el número óptimo de capítulos (mín ' + CFG.MIN_CHAPTERS + ', máx ' + CFG.MAX_CHAPTERS + ') según contenido y duración.'
         : 'Genera EXACTAMENTE ' + count + ' capítulos.';

     var lines = [
         'Eres un asistente experto en análisis de contenido multimedia y estructuración narrativa.',
         'Tu única tarea es dividir el video en capítulos SEMÁNTICAMENTE COHERENTES que representen cambios reales de tema o desarrollo narrativo.',
         'Idioma de los títulos: ' + lang + '.',
         countInstr,
         '',
         'FORMATO DE RESPUESTA OBLIGATORIO (sin bloques de código, sin texto adicional):',
         '[{"time":"HH:MM:SS o MM:SS","title":"Título conciso y descriptivo"}]',
         '',
         'REGLAS ESTRICTAS DE CALIDAD (DEBES SEGUIRLAS EXACTAMENTE):',
         '1. EL PRIMER CAPÍTULO DEBE TENER TIMESTAMP "00:00" (o "00:00:00").',
         '2. LOS CAPÍTULOS DEBEN ESTAR EN ORDEN CRONOLÓGICO ASCENDENTE ESTRICTO.',
         '3. CADA TÍTULO DEBE ESTAR EN ' + lang + ', MÁXIMO 60 CARACTERES, Y SER DESCRIPTIVO Y ATRACTIVO (ESTILO YOUTUBE PROFESIONAL).',
         '4. PROHIBIDO CREAR CAPÍTULOS IRRELEVANTES O BASURA (como "Continuación", "Seguimos", "Más información", etc.).',
         '5. PROHIBIDO DIVIDIR FRASES PEQUEÑAS O CREAR CAPÍTULOS DE MENOS DE 15 SEGUNDOS (EXCEPTO EL PRIMERO).',
         '6. CADA CAPÍTULO DEBE REPRESENTAR UN CAMBIO REAL DE TEMA, DESARROLLO NARRATIVO O PUNTO DE INFLEXIÓN.',
         '7. EVITAR TIMESTAMPS DEMASIADO JUNTOS (MÍNIMO 20 SEGUNDOS ENTRE CAPÍTULOS, EXCEPTO CASOS ESPECIALES).',
         '8. DETECTAR Y DESTACAR ESTRUCTURA NARRATIVA: INTRODUCCIÓN, DESARROLLO, CLÍMAX, CONCLUSIÓN (CUANDO APLIQUE).',
         '9. LOS TÍTULOS DEBEN SER CLAROS, CONCRETOS Y EVITAR AMBIGÜEDADES.',
         '10. SI TE PIDEN UN NÚMERO ESPECÍFICO DE CAPÍTULOS, DEBES GENERAR EXACTAMENTE ESE NÚMERO, NI MENOS NI MÁS.',
         isQwenModel ? '11. NOTA PARA QWEN3.5-9B: Enfócate en seguir estrictamente las instrucciones de cantidad y formato. Genera exactamente el número de capítulos solicitado.' : '',
         custom ? (isQwenModel ? '12' : '11') + '. INSTRUCCIÓN ADICIONAL: ' + custom : '',
     ];

     lines.push('');
     lines.push('INFORMACIÓN DEL VIDEO (CONTEXTO SEMÁNTICO PROCESADO):');
     lines.push(context);
     lines.push('');
     lines.push('RECUERDA: TU OBJETIVO ES CREAR UNA EXPERIENCIA DE NAVEGACIÓN QUE AYUDE AL USUARIO A ENCONTRAR INFORMACIÓN ESPECÍFICA RÁPIDAMENTE.');
     lines.push(isQwenModel ? 'Para Qwen3.5-9B: Proporciona solo el array JSON solicitado, sin texto adicional ni explicaciones.' : 'Responde ÚNICAMENTE con el array JSON válido. NO agregues explicaciones, comentarios ni texto adicional.');

     return lines.join('\n');
 }

    // ============================================================
    // 16. PARSEO DE RESPUESTA (JSON REPAIR)
    // ============================================================

    var _jsonRepairs = [
        function (s) { return s.replace(/,(\s*[}\]])/g, '$1'); },
        function (s) { return s.replace(/'/g, '"'); },
        function (s) { return s.replace(/'/g, '"').replace(/,(\s*[}\]])/g, '$1'); },
        function (s) { return s.replace(/[\u0000-\u001F\u007F]/g, function (c) {
            return (c === '\n' || c === '\r' || c === '\t') ? c : '';
        }); },
        function (s) { return s.replace(/\\"/g, '"').replace(/,(\s*[}\]])/g, '$1'); },
        function (s) { return s.replace(/\/\/[^\n]*/g, '').replace(/,(\s*[}\]])/g, '$1'); },
        function (s) { return s.replace(/`/g, '').replace(/\\'/g, "'").replace(/,(\s*[}\]])/g, '$1'); },
    ];

function _parseChapters(rawText) {
    if (!rawText || typeof rawText !== 'string') throw new Error('Respuesta vacía');

    var text = rawText
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/gi, '')
        .trim();

    var start = text.indexOf('[');
    var end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('No se encontró array JSON. Fragmento: "' + text.slice(0, 120) + '"');
    }

    var jsonStr = text.slice(start, end + 1);
    var parsed;

    try {
        parsed = JSON.parse(jsonStr);
    } catch (e1) {
        var ok = false;
        for (var ri = 0; ri < _jsonRepairs.length && !ok; ri++) {
            try {
                parsed = JSON.parse(_jsonRepairs[ri](jsonStr));
                ok = true;
                log.info('JSON reparado estrategia #' + (ri+1));
            } catch (_) {}
        }
        if (!ok) {
            throw new Error('JSON inválido tras ' + _jsonRepairs.length + ' intentos: ' + e1.message);
        }
    }

    if (!Array.isArray(parsed) || !parsed.length) throw new Error('Array vacío o no es array');

    var result = [];
    for (var i = 0; i < parsed.length; i++) {
        var item = parsed[i];
        if (item && typeof item === 'object' &&
            typeof item.time === 'string' && item.time.trim() &&
            typeof item.title === 'string' && item.title.trim()) {
            
            // Validate time format
            var timeStr = item.time.trim();
            if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(timeStr)) {
                continue; // Skip invalid time format
            }
            
            // Validate title is not garbage
            var titleStr = item.title.trim();
            var garbageTitlePatterns = [
                /^continuaci[oó]n$/i,
                /^seguimos$/i,
                /^m[áa]s información$/i,
                /^parte\s+\d+$/i,
                /^capítulo\s+\d+$/i,
                /^[\s\-_:.]*$/i, // Only punctuation/spaces
                /^(ok|bueno|eh|emm|ah|mmm|este)+$/i // Fillers only
            ];
            
            var isGarbage = garbageTitlePatterns.some(function(pattern) {
                return pattern.test(titleStr);
            });
            
            if (isGarbage) {
                continue;
            }
            
            result.push({
                time: timeStr,
                title: _truncar(titleStr, 120),
                seconds: _timestampToSeconds(timeStr),
            });
        }
    }
    if (!result.length) throw new Error('Ningún capítulo superó la validación');
    result.sort(function (a, b) { return a.seconds - b.seconds; });
    return result;
}

    // ============================================================
    // 17. OLLAMA — STREAMING CON REINTENTOS
    // ============================================================

function _callOllamaStream(baseUrl, model, prompt, onChunk, signal) {
         var doFetch = function (retriesLeft) {
             var isQwen = _isQwenModel(model);

             // Para Qwen3: añadir /no_think al inicio del prompt si no está ya
             // Esto evita el largo bloque <think>...</think> que consume tokens inútilmente
             var effectivePrompt = prompt;
             if (isQwen && prompt.indexOf('/no_think') === -1) {
                 effectivePrompt = '/no_think\n' + prompt;
             }
             var payload = JSON.stringify({
                 model: model,
                 prompt: effectivePrompt,
                 stream: true,
                 options: {
                     temperature : isQwen ? CFG.QWEN_TEMPERATURE    : CFG.DEFAULT_TEMPERATURE,
                     top_p       : isQwen ? CFG.QWEN_TOP_P          : CFG.DEFAULT_TOP_P,
                     num_predict : isQwen ? CFG.QWEN_NUM_PREDICT     : CFG.DEFAULT_NUM_PREDICT,
                     repeat_penalty: 1.1,
                     stop: ['\n\n\n', '```\n```'],
                 },
             });
             var maxPayload = (VP.config && VP.config.maxPayloadOllamaChars) || 180000;
             if (payload.length > maxPayload) {
                 return Promise.reject(new VP.ollama.OllamaError('Prompt demasiado grande para Ollama', 0, 'PAYLOAD_TOO_LARGE'));
             }
             
              return VP.ollama.fetchWithTimeout(baseUrl + '/api/generate', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: payload,
                 signal: signal,
              }, Math.max(60000, CFG.CONNECT_TIMEOUT_MS))
            .then(function (response) {
                if (!response.ok) {
                    return response.text().catch(function () { return ''; }).then(function (body) {
                         var message = 'HTTP ' + response.status + (body ? ': ' + body.slice(0, 200) : '');
                         var code = response.status === 400 ? 'BAD_REQUEST' :
                             (response.status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR');
                         if (response.status === 404 && /model|modelo/i.test(message)) code = 'MODEL_NOT_FOUND';
                         throw new VP.ollama.OllamaError(message, response.status, code);
                    });
                }

                if (!response.body || typeof response.body.getReader !== 'function') {
                    return response.text().then(function (raw) {
                        var lines = (raw || '').split('\n');
                        var fullText = '';
                        for (var i = 0; i < lines.length; i++) {
                            var line = lines[i].trim();
                            if (!line) continue;
                            try {
                                var json = JSON.parse(line);
                                     if (!json || typeof json !== 'object' || Array.isArray(json)) {
                                         throw new Error('Ollama devolvió una línea inválida');
                                     }
                                     if (json.error) throw new Error('Ollama: ' + String(json.error));
                                     if (json.response != null && String(json.response) !== '') {
                                         var responseToken = String(json.response);
                                         fullText += responseToken;
                                         if (onChunk) onChunk(responseToken, fullText);
                                }
                                 } catch (parseError) {
                                     if (parseError && parseError.message && parseError.message.indexOf('Ollama') === 0) throw parseError;
                                     throw new Error('Ollama devolvió una respuesta NDJSON inválida');
                                 }
                        }
                             if (!fullText) throw new Error('Ollama devolvió un stream sin contenido');
                             return fullText;
                    });
                }

                return VP.ollama.readStream(response.body, {
                    signal: signal,
                    maxTokens: CFG.STREAM_READ_MAX,
                    onToken: function (token, fullText) {
                        if (onChunk) onChunk(token, fullText);
                    }
                });
            })
            .catch(function (err) {
                 var retryable = !VP.ollama || typeof VP.ollama.isRetryableError !== 'function' || VP.ollama.isRetryableError(err);
                 if (retriesLeft > 0 && (!err || err.name !== 'AbortError') && !(err && err.hasPartialOutput) && retryable) {
                     log.warn('Reintentando tras error:', err && err.message ? err.message : String(err));
                    return doFetch(retriesLeft - 1);
                }
                throw err;
            });
        };
        return doFetch(CFG.MAX_RETRIES);
    }

    // ============================================================
    // 18. MARCADORES EN BARRA DE PROGRESO
    // ============================================================

    function _installStyles() {
        if (_state._stylesInjected) return;
        var id = 'vpChaptersIAStyles';
        if (document.getElementById(id)) {
            _state._stylesInjected = true;
            return;
        }

        var css = [
            '#' + _state._markersLayerId + ' { position:absolute; left:0; right:0; top:0; bottom:0; pointer-events:none; z-index:2; }',
            '#' + _state._markersLayerId + ' .vp-chap-marker { position:absolute; top:0; bottom:0; width:16px; transform:translateX(-8px); cursor:pointer; pointer-events:auto; z-index:3; }',
            '#' + _state._markersLayerId + ' .vp-chap-marker::before { content:""; position:absolute; left:50%; top:10%; height:80%; width:2.5px; transform:translateX(-50%); background:rgba(255,255,255,.85); box-shadow:0 0 0 1px rgba(0,0,0,.25); border-radius:999px; transition:background .15s, height .15s, width .15s; }',
            '#' + _state._markersLayerId + ' .vp-chap-marker:hover::before { background:#fff; top:2%; height:96%; width:3.5px; box-shadow:0 0 8px rgba(255,255,255,.6); }',
            '#' + _state._markersLayerId + ' .vp-chap-tooltip { position:absolute; bottom:calc(100% + 12px); left:50%; transform:translateX(-50%) scale(.9); padding:6px 12px; background:rgba(20,20,30,.96); color:#fff; font-size:12px; font-weight:500; white-space:nowrap; border-radius:6px; pointer-events:none; opacity:0; transition:opacity .2s, transform .2s; z-index:100; box-shadow:0 4px 12px rgba(0,0,0,.4); }',
            '#' + _state._markersLayerId + ' .vp-chap-tooltip::after { content:""; position:absolute; top:100%; left:50%; transform:translateX(-50%); border:5px solid transparent; border-top-color:rgba(20,20,30,.96); }',
            '#' + _state._markersLayerId + ' .vp-chap-tooltip .ts { color:#bbb; margin-right:6px; }',
            '#' + _state._markersLayerId + ' .vp-chap-marker:hover .vp-chap-tooltip { opacity:1; transform:translateX(-50%) scale(1); }',
            '#' + _state._markersLayerId + ' .vp-chap-marker.--edge-left .vp-chap-tooltip { left:0; transform:translateX(0) scale(.9); }',
            '#' + _state._markersLayerId + ' .vp-chap-marker.--edge-left:hover .vp-chap-tooltip { transform:translateX(0) scale(1); }',
            '#' + _state._markersLayerId + ' .vp-chap-marker.--edge-right .vp-chap-tooltip { left:auto; right:0; transform:translateX(0) scale(.9); }',
            '#' + _state._markersLayerId + ' .vp-chap-marker.--edge-right:hover .vp-chap-tooltip { transform:translateX(0) scale(1); }',
        ];

        var style = document.createElement('style');
        style.id = id;
        style.textContent = css.join('\n');
        document.head.appendChild(style);
        _state._stylesInjected = true;
    }

    function _ensureMarkersLayer() {
        var pc = VP.refs && VP.refs.progressContainer;
        if (!pc || dom.esNulo(pc)) return null;
        var layer = document.getElementById(_state._markersLayerId);
        if (!layer) {
            layer = document.createElement('div');
            layer.id = _state._markersLayerId;
            layer.setAttribute('aria-hidden', 'true');
            var scrubber = VP.refs.progressScrubber;
            if (scrubber && !dom.esNulo(scrubber) && scrubber.parentNode === pc) {
                pc.insertBefore(layer, scrubber);
            } else {
                pc.appendChild(layer);
            }
        }
        return layer;
    }

    function _clearMarkers() {
        var layer = document.getElementById(_state._markersLayerId);
        if (layer) layer.innerHTML = '';
    }

    function _renderMarkers() {
        _installStyles();
        var layer = _ensureMarkersLayer();
        var chapters = _state.appliedChapters;
        var duration = _getVideoDuration();
        if (!layer) return;
        while (layer.firstChild) layer.removeChild(layer.firstChild);
        if (!chapters || !chapters.length || !duration || duration <= 0) return;

        var frag = document.createDocumentFragment();
        for (var i = 0; i < chapters.length; i++) {
            var ch = chapters[i];
            if (!ch || !isFinite(ch.seconds) || ch.seconds < 0 || ch.seconds >= duration) continue;
            var pct = (ch.seconds / duration) * 100;

            var marker = document.createElement('span');
            marker.className = 'vp-chap-marker';
            marker.style.left = pct.toFixed(4) + '%';
            if (pct < CFG.EDGE_LEFT_PCT) marker.classList.add('--edge-left');
            else if (pct > CFG.EDGE_RIGHT_PCT) marker.classList.add('--edge-right');

            var tooltip = document.createElement('span');
            tooltip.className = 'vp-chap-tooltip';
            var tsSpan = document.createElement('span');
            tsSpan.className = 'ts';
            tsSpan.textContent = ch.time;
            tooltip.appendChild(tsSpan);
            tooltip.appendChild(document.createTextNode(ch.title));
            marker.appendChild(tooltip);

            frag.appendChild(marker);
        }
        layer.appendChild(frag);
    }

    // ============================================================
    // 19. APLICAR CAPÍTULOS
    // ============================================================

    function _applyChapters(chapters, model, opts) {
        opts = opts || {};
        var normalized = _normalizar(chapters);
        var videoId = _getVideoId();

        _state.appliedChapters = normalized.slice();
        if (VP.estado) {
            VP.estado.capitulos = normalized.map(function (ch) {
                return { tiempo: ch.seconds, titulo: ch.title };
            });
        }

        if (!opts.skipPersist && videoId) {
            _persistirCapitulos(videoId, normalized, _state.lastRawText || '', model || '');
        }

        _renderMarkers();
        if (VP.reproductor && typeof VP.reproductor.actualizarMarcadoresCapitulos === 'function') {
            try { VP.reproductor.actualizarMarcadoresCapitulos(); } catch (_) {}
        }

        var detail = { chapters: normalized };
        bus.emit('capitulosIA:aplicados', normalized);
        bus.emit('capitulosActualizados', normalized);
        try {
            document.dispatchEvent(new CustomEvent('chaptersUpdated', { detail: detail, bubbles: true }));
        } catch (_) {}
        log.info('Aplicados → ' + normalized.length + ' caps | videoId: ' + (videoId || '?'));
    }

    // ============================================================
    // 20. RESTAURAR
    // ============================================================

    function _restaurarCapitulos() {
        var videoId = _getVideoId();
        if (!videoId) {
            _clearMarkers();
            _state.appliedChapters = [];
            return;
        }
        _cargarCapitulos(videoId).then(function (resultado) {
            if (!resultado || !resultado.chapters || !resultado.chapters.length) {
                _clearMarkers();
                _state.appliedChapters = [];
                return;
            }
            _state.appliedChapters = _normalizar(resultado.chapters);
            _state.generatedChapters = _state.appliedChapters.slice();
            if (VP.estado) {
                VP.estado.capitulos = _state.appliedChapters.map(function (ch) {
                    return { tiempo: ch.seconds, titulo: ch.title };
                });
            }
            _renderMarkers();
            log.info('Restaurados → ' + videoId + ' | ' + _state.appliedChapters.length + ' caps | ' + resultado.source);
            bus.emit('capitulosIA:restaurados', { videoId: videoId, chapters: _state.appliedChapters, source: resultado.source });
        }).catch(function (e) {
            log.warn('Error restaurando:', e);
            _clearMarkers();
        });
    }

    // ============================================================
    // 21. DETECCIÓN DE CAMBIO DE VIDEO
    // ============================================================

    function _onVideoChanged() {
        var newId = _getVideoId();
        if (newId === _state.currentVideoId) return;
        log.debug('Video cambiado → ' + newId + ' (antes ' + _state.currentVideoId + ')');

        if (_state.isGenerating && _state.abortController) {
            try { _state.abortController.abort(); } catch (_) {}
        }

        _state.currentVideoId = newId;
        _state.generatedChapters = [];
        _state.lastRawText = '';
        _clearMarkers();
        _restaurarCapitulos();

        var modal = _el('chaptersIAModal');
        if (modal && modal.classList.contains('active')) {
            _resetToConfig();
            _updateSubtitleStatus();
        }
    }

    // ============================================================
    // 22.0. GENERACIÓN POR CHUNKS (MOTOR PRINCIPAL)
    // Procesa el SRT completo en segmentos temporales,
    // extrayendo capítulos de cada uno y fusionando los resultados.
    // ============================================================

    function _generateChunked(params) {
        var baseUrl       = params.baseUrl;
        var model         = params.model;
        var requestedCount= params.count    || CFG.AUTO_COUNT;
        var language      = params.language || 'es';
        var custom        = params.custom   || '';
        var signal        = params.signal;
        var onProgress    = params.onProgress || function () {};

        var vObj          = _getVideoObj();
        var videoTitle    = vObj ? (vObj.name || 'Sin título') : 'Sin título';
        var videoDuration = _getVideoDuration();
        var durStr        = videoDuration > 0 ? _secondsToTimestamp(videoDuration) : 'desconocida';
        var isQwen        = _isQwenModel(model);

        // 1. Obtener texto completo de subtítulos (sin truncar)
        var rawSubtitles  = _getSubtitleText();
        if (!rawSubtitles || !rawSubtitles.trim()) {
            return Promise.reject(new Error('No hay subtítulos disponibles para procesar'));
        }

        // 2. Detectar tipo de contenido
        var listInfo = _detectListContent(videoTitle, rawSubtitles);

        // 3. Si hay count explícito, usarlo; si no, calcular óptimo
        var targetCount = requestedCount;
        if (targetCount === CFG.AUTO_COUNT || targetCount === 0) {
            targetCount = _calculateOptimalChapterCount(videoDuration, videoTitle, rawSubtitles);
        }
        log.info('[Chunked] Objetivo: ' + targetCount + ' caps | Lista: ' + listInfo.isList +
                 (listInfo.isList ? ' (' + listInfo.expectedCount + ' items)' : '') +
                 ' | Qwen: ' + isQwen);

        // 4. Parsear todos los cues
        var allCues = _parseSrtCues(rawSubtitles);
        if (allCues.length === 0) {
            return Promise.reject(new Error('No se pudieron parsear los subtítulos'));
        }
        log.info('[Chunked] ' + allCues.length + ' cues parseados');

        // 5. Dividir en chunks temporales
        var chunks = _splitCuesIntoChunks(allCues, CFG.CHUNK_DURATION_S, CFG.CHUNK_OVERLAP_S);
        log.info('[Chunked] ' + chunks.length + ' chunks de ' + CFG.CHUNK_DURATION_S + 's cada uno');

        if (chunks.length === 0) {
            return Promise.reject(new Error('No se pudieron crear chunks del SRT'));
        }

        // 6. Procesar cada chunk secuencialmente (evita saturar Ollama)
        var allChapterResults = [];
        var processedChunks   = 0;

        function processNextChunk(idx) {
            if (signal && signal.aborted) {
                return Promise.reject(new Error('AbortError'));
            }
            if (idx >= chunks.length) {
                return Promise.resolve(allChapterResults);
            }

            var chunk = chunks[idx];
            onProgress('Analizando segmento ' + (idx + 1) + '/' + chunks.length +
                       ' (' + chunk.startTime + ' - ' + chunk.endTime + ')…');

            var chunkPrompt = _buildChunkPrompt({
                chunk:         chunk,
                totalChunks:   chunks.length,
                videoTitle:    videoTitle,
                videoDuration: durStr,
                language:      language,
                isQwen:        isQwen,
                isList:        listInfo.isList,
                listCount:     listInfo.expectedCount,
            });

            // Añadir instrucción custom al último chunk
            if (custom && idx === chunks.length - 1) {
                chunkPrompt += '\n\nINSTRUCCIÓN ADICIONAL: ' + custom;
            }

            return _callOllamaStream(baseUrl, model, chunkPrompt, null, signal)
                .then(function (rawText) {
                    processedChunks++;

                    if (!rawText || !rawText.trim()) {
                        log.warn('[Chunked] Chunk ' + (idx+1) + ' sin respuesta — saltando');
                        allChapterResults.push([]);
                        return processNextChunk(idx + 1);
                    }

                    // Intentar parsear el JSON del chunk
                    var parsed = [];
                    try {
                        parsed = _parseChapters(rawText);
                    } catch (e) {
                        log.warn('[Chunked] Chunk ' + (idx+1) + ' parse falló: ' + e.message + ' | texto: ' + rawText.slice(0, 120));
                        // No abortar: continuar con el siguiente chunk
                    }

                    // Filtrar capítulos que estén fuera del rango del chunk (con algo de tolerancia)
                    var filtered = parsed.filter(function (ch) {
                        var tolerance = CFG.CHUNK_OVERLAP_S;
                        return ch.seconds >= (chunk.startS - tolerance) &&
                               ch.seconds <= (chunk.endS   + tolerance);
                    });

                    log.info('[Chunked] Chunk ' + (idx+1) + ': ' + filtered.length + ' caps extraídos');
                    allChapterResults.push(filtered);

                    return processNextChunk(idx + 1);
                })
                .catch(function (err) {
                    if (err && (err.name === 'AbortError' || (err.message && err.message.indexOf('AbortError') !== -1))) {
                        throw err; // Re-lanzar cancelaciones
                    }
                    log.warn('[Chunked] Chunk ' + (idx+1) + ' error: ' + (err.message || err) + ' — continuando');
                    allChapterResults.push([]);
                    return processNextChunk(idx + 1);
                });
        }

        return processNextChunk(0)
            .then(function () {
                // 7. Fusionar y deduplicar resultados de todos los chunks
                var merged = _mergeAllChapters(allChapterResults);
                log.info('[Chunked] Tras fusión: ' + merged.length + ' caps únicos');

                if (merged.length === 0) {
                    // Fallback: intentar con prompt clásico sobre el inicio del SRT
                    log.warn('[Chunked] Sin resultados — ejecutando fallback clásico');
                    onProgress('Usando método alternativo…');
                    return _generateFallback(baseUrl, model, targetCount, language, custom, signal, rawSubtitles, videoTitle, durStr);
                }

                // 8. Normalizar (incluye asegurar 00:00 al principio)
                var normalized = _normalizar(merged);

                // 9. Si pedimos N específico y obtuvimos muchos más, hacer un pase de consolidación
                if (requestedCount > 0 && normalized.length > requestedCount * 1.5) {
                    onProgress('Consolidando ' + normalized.length + ' → ' + requestedCount + ' capítulos…');
                    return _consolidateChapters(baseUrl, model, normalized, requestedCount, language, signal)
                        .catch(function () { return normalized; }); // Si falla el consolidado, usar los que hay
                }

                return normalized;
            });
    }

    // ============================================================
    // 22.1. FALLBACK: prompt clásico cuando chunking no da resultados
    // ============================================================

    function _generateFallback(baseUrl, model, count, language, custom, signal, rawSubtitles, videoTitle, durStr) {
        var isQwen  = _isQwenModel(model);
        var noThink = isQwen ? '/no_think\n' : '';

        // Tomar los primeros CHUNK_MAX_CHARS * 4 del SRT (más contexto que antes)
        var snippedSrt = rawSubtitles.slice(0, CFG.CHUNK_MAX_CHARS * 4);

        var countInstr = (count === CFG.AUTO_COUNT || count === 0)
            ? 'Decide el número óptimo (mín ' + CFG.MIN_CHAPTERS + ', máx ' + CFG.MAX_CHAPTERS + ').'
            : 'Genera EXACTAMENTE ' + count + ' capítulos.';

        var prompt = [
            noThink,
            'Eres un experto en estructuración de contenido de video.',
            'VIDEO: "' + videoTitle + '" | Duración: ' + durStr,
            countInstr,
            'Idioma de títulos: ' + language + '.',
            (custom ? 'Instrucción adicional: ' + custom : ''),
            '',
            'SUBTÍTULOS (inicio del video):',
            snippedSrt,
            '',
            'Genera un array JSON de capítulos. Primer capítulo siempre en "00:00".',
            'Formato: [{"time":"MM:SS","title":"Título"}]',
            'Responde SOLO con el JSON, sin explicaciones.',
        ].filter(Boolean).join('\n');

        return _callOllamaStream(baseUrl, model, prompt, null, signal)
            .then(function (rawText) {
                if (!rawText || !rawText.trim()) throw new Error('Fallback: respuesta vacía');
                var parsed = _parseChapters(rawText);
                return _normalizar(parsed);
            });
    }

    // ============================================================
    // 22.2. CONSOLIDACIÓN: reducir N → M capítulos con IA
    // ============================================================

    function _consolidateChapters(baseUrl, model, chapters, targetCount, language, signal) {
        var isQwen  = _isQwenModel(model);
        var noThink = isQwen ? '/no_think\n' : '';

        var chaptersStr = JSON.stringify(chapters.map(function (ch) {
            return { time: ch.time, title: ch.title };
        }));

        var prompt = [
            noThink,
            'Tienes una lista de ' + chapters.length + ' capítulos de un video.',
            'Selecciona los ' + targetCount + ' más representativos e importantes.',
            'Mantén el primero en 00:00. Conserva los timestamps exactos.',
            'Idioma: ' + language + '.',
            '',
            'CAPÍTULOS ACTUALES:',
            chaptersStr,
            '',
            'Devuelve SOLO el array JSON con ' + targetCount + ' capítulos seleccionados.',
            'Formato: [{"time":"MM:SS","title":"Título"}]',
        ].join('\n');

        return _callOllamaStream(baseUrl, model, prompt, null, signal)
            .then(function (rawText) {
                var parsed = _parseChapters(rawText);
                return _normalizar(parsed);
            });
    }

    // ============================================================
    // 22. GENERAR (PRINCIPAL)
    // ============================================================

    function _generate() {
        if (_state.isGenerating) {
            _notif('Ya hay una generación en curso', 'advertencia');
            return;
        }
        if (_state.cbAbierto) {
            _notif('Conexión con Ollama temporalmente desactivada', 'advertencia');
            return;
        }

        var urlEl    = _el('chaptersIAUrl');
        var modelEl  = _el('chaptersIAModel');
        var countEl  = _el('chaptersIACount');
        var langEl   = _el('chaptersIALanguage');
        var promptEl = _el('chaptersIACustomPrompt');

        var rawUrl   = urlEl    ? urlEl.value.trim()    : '';
        var baseUrl  = _normalizeUrl(rawUrl);
        var model    = modelEl  ? modelEl.value.trim()  : '';
        var countRaw = countEl  ? countEl.value         : '0';
        var language = langEl   ? langEl.value.trim()   : _leerPreferencia(CFG.PREF_DEFAULT_LANG, 'es');
        var custom   = promptEl ? promptEl.value.trim() : '';
        var count    = parseInt(countRaw, 10);

        if (!_isValidUrl(baseUrl)) { _notif('URL de Ollama inválida', 'error'); return; }
        if (!model) { _notif('Selecciona un modelo de IA', 'error'); return; }
        if (isNaN(count) || count < 0 || (count > 0 && count < CFG.MIN_CHAPTERS) || count > CFG.MAX_CHAPTERS) {
            _notif('Elige "Automático" o un número entre ' + CFG.MIN_CHAPTERS + ' y ' + CFG.MAX_CHAPTERS, 'error');
            return;
        }
        var video = VP.refs && VP.refs.videoPlayer;
        if (!video || dom.esNulo(video) || (!video.src && !video.currentSrc)) {
            _notif('No hay ningún video cargado', 'advertencia');
            return;
        }

        _guardarPreferencia(CFG.PREF_MODEL, model);
        _guardarPreferencia(CFG.PREF_URL, baseUrl);
        _guardarPreferencia(CFG.PREF_LANGUAGE, language);
        _guardarPreferencia(CFG.PREF_COUNT, count);
        _guardarPreferencia(CFG.PREF_PROMPT, custom);

        var videoIdAtStart        = _getVideoId();
        _state.isGenerating       = true;
        _state.currentGenVideoId  = videoIdAtStart;
        _state.abortController    = new AbortController();
        _state.generatedChapters  = [];
        _state.lastRawText        = '';
        if (VP.ajustes && VP.ajustes.activarMochiIA && VP.mochiMascota &&
                typeof VP.mochiMascota.detectarCapitulos === 'function') {
            VP.mochiMascota.detectarCapitulos();
        }
        var signal                = _state.abortController.signal;

        _setLoadingState(true);

        var streamPreview = _el('chaptersIAStreamPreview');
        var loadingMsg    = _el('chaptersIALoadingMsg');
        var startTime     = Date.now();

        function setMsg(txt) {
            if (loadingMsg) loadingMsg.textContent = txt;
            log.info('[generate] ' + txt);
        }

        if (streamPreview) streamPreview.textContent = '';
        setMsg('Iniciando procesamiento por segmentos…');

        _generateChunked({
            baseUrl:   baseUrl,
            model:     model,
            count:     count,
            language:  language,
            custom:    custom,
            signal:    signal,
            onProgress: function (msg) {
                setMsg(msg);
                // También actualizar el preview con el progreso
                if (streamPreview) {
                    streamPreview.textContent = (streamPreview.textContent || '') + '\n' + msg;
                    streamPreview.scrollTop = streamPreview.scrollHeight;
                }
            },
        })
        .then(function (normalized) {
            if (_getVideoId() !== videoIdAtStart) {
                log.warn('Video cambió durante generación — descartando.');
                _notif('Video cambió. Repite el proceso.', 'advertencia');
                _setLoadingState(false);
                return;
            }
            if (!normalized || !normalized.length) throw new Error('No se pudieron extraer capítulos');

            _state.generatedChapters = normalized;
            _state.lastRawText       = JSON.stringify(normalized);
            _cbRegistrarExito();

            var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            _showResult(normalized, {
                model:   model,
                count:   normalized.length,
                elapsed: elapsed,
                auto:    (count === CFG.AUTO_COUNT),
            });

            _notif(normalized.length + ' capítulos generados en ' + elapsed + 's', 'exito');
            bus.emit('capitulosIA:generados', { videoId: videoIdAtStart, chapters: normalized, model: model });
            try { document.dispatchEvent(new CustomEvent('chapters:done')); } catch (_) {}
        })
        .catch(function (err) {
            if (err && (err.name === 'AbortError' || (err.message && err.message.indexOf('AbortError') !== -1))) {
                _notif('Generación cancelada', 'info');
                log.info('Cancelada.');
            } else {
                _cbRegistrarFallo();
                var msg = err && err.message ? err.message : String(err);
                log.error('Error en generación:', msg);
                _notif('Error: ' + msg, 'error');
                if (loadingMsg) loadingMsg.textContent = 'Error: ' + msg;
                try { document.dispatchEvent(new CustomEvent('chapters:error')); } catch (_) {}
            }
        })
        .then(function () {
            _state.isGenerating      = false;
            _state.abortController   = null;
            _state.currentGenVideoId = null;
            _setLoadingState(false);
        }, function () {
            _state.isGenerating      = false;
            _state.abortController   = null;
            _state.currentGenVideoId = null;
            _setLoadingState(false);
        });
    }

    function _cancel() {
        if (!_state.isGenerating) return;
        if (_state.abortController) {
            try { _state.abortController.abort(); } catch (_) {}
        }
        _state.isGenerating = false;
        _state.abortController = null;
        _setLoadingState(false);
        _notif('Generación cancelada', 'info');
    }

    // ============================================================
    // 23. UI (MODAL)
    // ============================================================

    function _el(id) { return document.getElementById(id); }

    function _setLoadingState(loading) {
        _setDisplay('chaptersIAConfig', loading ? 'none' : '');
        _setDisplay('chaptersIALoading', loading ? 'flex' : 'none');
        _setDisplay('chaptersIAResult', loading ? 'none' : (_state.generatedChapters.length ? 'block' : 'none'));
        _setDisplay('generateChaptersIABtn', loading ? 'none' : 'inline-flex');
        _setDisplay('cancelChaptersIABtn', loading ? 'inline-flex' : 'none');
    }

function _showResult(chapters, meta) {
    _setDisplay('chaptersIAConfig', 'none');
    _setDisplay('chaptersIALoading', 'none');
    _setDisplay('chaptersIAResult', 'block');
    _renderChaptersList(chapters);
    _renderMeta(meta);
    
    // Calculate and display chapter score if we have video duration
    var videoDuration = _getVideoDuration();
    if (videoDuration > 0) {
        var score = _scoreChapters(chapters, videoDuration);
        var scoreElement = _el('chaptersIAScore');
        if (scoreElement) {
            scoreElement.textContent = 'Puntuación: ' + Math.round(score) + '/100';
            scoreElement.style.display = 'block';
            
            // Color code the score
            if (score >= 80) {
                scoreElement.style.color = '#4caf50'; // Green
            } else if (score >= 60) {
                scoreElement.style.color = '#ff9800'; // Orange
            } else {
                scoreElement.style.color = '#f44336'; // Red
            }
        }
        
        // Auto-regenerate if score is too low and we haven't tried too many times
        if (score < 50 && !meta.regenerationAttempted) {
            log.info('Capítulos generados tienen baja puntuación (' + score + '), intentando regenerar...');
            
            // Mark that we've attempted regeneration to prevent infinite loops
            meta.regenerationAttempted = true;
            
            // Show notification
            _notif('Regenerando capítulos para mejorar calidad...', 'info');
            
            // Try to regenerate after a short delay
            setTimeout(function() {
                // Reset the loading state and trigger regeneration
                _setLoadingState(true);
                if (_el('chaptersIALoadingMsg')) {
                    _el('chaptersIALoadingMsg').textContent = 'Regenerando capítulos para mejorar calidad...';
                }
                
                // Trigger regeneration with the same parameters
                var urlEl    = _el('chaptersIAUrl');
                var modelEl  = _el('chaptersIAModel');
                var countEl  = _el('chaptersIACount');
                var langEl   = _el('chaptersIALanguage');
                var promptEl = _el('chaptersIACustomPrompt');
                
                var rawUrl   = urlEl    ? urlEl.value.trim()    : '';
                var baseUrl  = _normalizeUrl(rawUrl);
                var model    = modelEl  ? modelEl.value.trim()  : '';
                var countRaw = countEl  ? countEl.value         : '0';
                var language = langEl   ? langEl.value.trim()   : _leerPreferencia(CFG.PREF_DEFAULT_LANG, 'es');
                var custom   = promptEl ? promptEl.value.trim() : '';
                var count    = parseInt(countRaw, 10);
                
                // Call generate with the same parameters
                _generate(); // This will use current UI values
            }, 1000);
        }
    }
}

    function _resetToConfig() {
        if (_state.isGenerating) _cancel();
        _state.generatedChapters = [];
        _state.lastRawText = '';
        var output = _el('chaptersIAOutput');
        if (output) output.innerHTML = '';
        var meta = _el('chaptersIAMeta');
        if (meta) meta.textContent = '';
        var preview = _el('chaptersIAStreamPreview');
        if (preview) preview.textContent = '';
        _setDisplay('chaptersIAConfig', '');
        _setDisplay('chaptersIAResult', 'none');
        _setDisplay('chaptersIALoading', 'none');
        _setLoadingState(false);
    }

    function _renderChaptersList(chapters) {
        var output = _el('chaptersIAOutput');
        if (!output) return;
        if (!chapters || !chapters.length) {
            output.innerHTML = '<p class="empty-message">No hay capítulos que mostrar.</p>';
            return;
        }
        var frag = document.createDocumentFragment();
        for (var i = 0; i < chapters.length; i++) {
            var ch = chapters[i];
            var div = document.createElement('div');
            div.className = 'chapter-ai-item';
            div.setAttribute('tabindex', '0');
            div.setAttribute('role', 'button');
            div.setAttribute('aria-label', 'Capítulo ' + (i+1) + ': ' + ch.title + ' en ' + ch.time);
            div.innerHTML = '<span class="chapter-ai-num">' + (i+1) + '</span>' +
                            '<span class="chapter-ai-time">' + _safeEscaparHTML(ch.time) + '</span>' +
                            '<span class="chapter-ai-title">' + _safeEscaparHTML(ch.title) + '</span>' +
                            '<span class="chapter-ai-jump">▶ Ir</span>';

            (function (el, seconds, title) {
                function jump() {
                    var video = VP.refs && VP.refs.videoPlayer;
                    if (!video || dom.esNulo(video)) return;
                    video.currentTime = seconds;
                    if (video.paused) { try { video.play(); } catch (_) {} }
                    _notif('▶ ' + title, 'info');
                }
                el.addEventListener('click', jump);
                el.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); }
                });
            })(div, ch.seconds, ch.title);

            frag.appendChild(div);
        }
        output.innerHTML = '';
        output.appendChild(frag);
    }

    function _renderMeta(meta) {
        var el = _el('chaptersIAMeta');
        if (!el) return;
        var countLabel = meta.auto ? meta.count + ' (automático)' : String(meta.count);
        el.textContent = 'Modelo: ' + meta.model + ' · Capítulos: ' + countLabel + ' · Tiempo: ' + meta.elapsed + 's';
    }

    function _setDisplay(id, value) {
        var el = _el(id);
        if (el) el.style.display = value;
    }

    function _updateModelBadge() {
        var badge = _el('chaptersIAModelBadge');
        if (!badge) return;
        var modelEl = _el('chaptersIAModel');
        var model = modelEl ? modelEl.value : '';
        var display = model ? model.split(':')[0] : 'Ollama';
        var svg = badge.querySelector('svg') ? badge.querySelector('svg').outerHTML : '';
        badge.innerHTML = svg + display;
    }

    function _updateSubtitleStatus() {
        var el = _el('chaptersIASubtitleStatus');
        if (!el) return;
        var video = VP.refs && VP.refs.videoPlayer;
        if (!video || dom.esNulo(video) || (!video.src && !video.currentSrc)) {
            el.textContent = 'Sin video cargado';
            el.style.color = 'var(--yt-text-secondary, #aaa)';
            return;
        }
        var text = _getSubtitleText();
        if (text) {
            var lineCount = text.split('\n').length;
            el.textContent = '✓ Subtítulos disponibles · ' + lineCount + ' líneas';
            el.style.color = 'var(--yt-green, #4caf50)';
        } else {
            el.textContent = 'Sin subtítulos — estimación por duración y título';
            el.style.color = 'var(--yt-text-secondary, #aaa)';
        }
    }

    // ============================================================
    // 24. MODAL — ABRIR/CERRAR
    // ============================================================

    function _openModal() {
        var modal = _el('chaptersIAModal');
        if (!modal) return;
        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(true);

        var urlInput = _el('chaptersIAUrl');
        if (urlInput) {
            var savedUrl = _leerPreferencia(CFG.PREF_URL, '');
            if (savedUrl) urlInput.value = savedUrl;
        }
        var countInput = _el('chaptersIACount');
        if (countInput) {
            countInput.value = String(_leerPreferencia(CFG.PREF_COUNT, CFG.AUTO_COUNT));
        }
        var langSelect = _el('chaptersIALanguage');
        if (langSelect) {
            langSelect.value = _leerPreferencia(CFG.PREF_LANGUAGE, _leerPreferencia(CFG.PREF_DEFAULT_LANG, 'es'));
        }
        var promptEl = _el('chaptersIACustomPrompt');
        if (promptEl) {
            var savedPrompt = _leerPreferencia(CFG.PREF_PROMPT, '');
            if (savedPrompt) promptEl.value = savedPrompt;
        }
        _checkExistingChapters();
        _populateModels(urlInput ? urlInput.value : '');
        _updateSubtitleStatus();

        setTimeout(function () {
            var focusable = modal.querySelector('button:not([disabled]), select:not([disabled]), input, textarea');
            if (focusable) focusable.focus();
        }, CFG.MODAL_FOCUS_DELAY_MS);
    }

    function _closeModal() {
        var modal = _el('chaptersIAModal');
        if (!modal) return;
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(false);
        if (_state.isGenerating && _state.abortController) {
            try { _state.abortController.abort(); } catch (_) {}
        }
    }

    function _checkExistingChapters() {
        var videoId = _getVideoId();
        if (!videoId) return;
        _cargarCapitulos(videoId).then(function (resultado) {
            if (resultado && resultado.chapters && resultado.chapters.length) {
                _state.generatedChapters = _normalizar(resultado.chapters);
                _showResult(_state.generatedChapters, {
                    model: resultado.model || '(guardado)',
                    count: _state.generatedChapters.length,
                    elapsed: 'restaurado',
                    auto: false,
                });
            }
        }).catch(function () {});
    }

    // ============================================================
    // 25. EXPORTAR / COPIAR
    // ============================================================

    function _copyToClipboard() {
        var chapters = _state.generatedChapters;
        if (!chapters || !chapters.length) { _notif('No hay capítulos para copiar', 'error'); return; }
        var lines = [];
        for (var i = 0; i < chapters.length; i++) {
            lines.push(chapters[i].time + ' ' + chapters[i].title);
        }
        var text = lines.join('\n');
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(function () { _notif('Copiado al portapapeles', 'exito'); })
                .catch(function () { _copyFallback(text); });
        } else {
            _copyFallback(text);
        }
    }

    function _copyFallback(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (_) {}
        document.body.removeChild(ta);
        _notif(ok ? 'Copiado' : 'Error al copiar', ok ? 'exito' : 'error');
    }

    function _exportAsTxt() {
        var chapters = _state.generatedChapters;
        if (!chapters || !chapters.length) { _notif('No hay capítulos para exportar', 'error'); return; }
        var vObj = _getVideoObj();
        var videoTitle = vObj ? (vObj.name || 'video') : 'video';
        var lines = [
            'Capítulos: ' + videoTitle,
            'Generado: ' + new Date().toLocaleString(),
            'Total: ' + chapters.length + ' capítulos',
            '',
        ];
        for (var i = 0; i < chapters.length; i++) {
            var idx = (i+1 < 10 ? '0' + (i+1) : String(i+1));
            lines.push(idx + '. ' + chapters[i].time + '  ' + chapters[i].title);
        }
        var safeName = _sanitizarNombreArchivo(typeof util.obtenerNombreBase === 'function' ? util.obtenerNombreBase(videoTitle) : videoTitle);
        var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'capitulos_' + safeName + '.txt';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            try { document.body.removeChild(a); } catch (_) {}
            try { URL.revokeObjectURL(url); } catch (_) {}
        }, 1500);
        _notif('Exportado como .txt', 'exito');
    }

    // ============================================================
    // 26. NOTIFICACIONES
    // ============================================================

    function _notif(msg, tipo) {
        try {
            if (VP.ui && typeof VP.ui.mostrarNotificacion === 'function') {
                VP.ui.mostrarNotificacion(msg, tipo || 'info');
            }
        } catch (_) {}
    }

    // ============================================================
    // 27. REGISTRO DE EVENTOS (atajo Ctrl+Shift+G)
    // ============================================================

    function _registerEvents() {
        _bind('chaptersIABtn', _openModal);
        _bind('chaptersIAModalClose', _closeModal);
        _bind('generateChaptersIABtn', _generate);
        _bind('cancelChaptersIABtn', _cancel);
        _bind('newChaptersIABtn', _resetToConfig);
        _bind('copyChaptersIABtn', _copyToClipboard);
        _bind('exportChaptersIABtn', _exportAsTxt);
        _bind('applyChaptersIABtn', function () {
            if (_state.generatedChapters.length === 0) {
                _notif('No hay capítulos para aplicar', 'error');
                return;
            }
            var modelEl = _el('chaptersIAModel');
            var model = modelEl ? modelEl.value : '';
            _applyChapters(_state.generatedChapters, model);
            _notif(_state.generatedChapters.length + ' capítulos aplicados', 'exito');
            _closeModal();
        });

        _bind('chaptersIARefreshModelsBtn', function () {
            var u = _el('chaptersIAUrl');
            _populateModels(u ? u.value : '');
        });

        var modal = _el('chaptersIAModal');
        if (modal) {
            _addTracked(modal, 'click', function (e) {
                if (e.target === modal) _closeModal();
            }, _state._docListeners);
        }

        var urlInput = _el('chaptersIAUrl');
        if (urlInput) {
            _addTracked(urlInput, 'input', function () {
                clearTimeout(_state.urlDebounceTimer);
                _state.urlDebounceTimer = setTimeout(function () {
                    var val = _normalizeUrl(urlInput.value);
                    if (_isValidUrl(val)) _populateModels(val);
                }, CFG.URL_DEBOUNCE_MS);
            }, _state._docListeners);
        }

        var countEl = _el('chaptersIACount');
        if (countEl) {
            _addTracked(countEl, 'change', function () {
                _guardarPreferencia(CFG.PREF_COUNT, parseInt(countEl.value, 10) || CFG.AUTO_COUNT);
            }, _state._docListeners);
        }
        var langEl = _el('chaptersIALanguage');
        if (langEl) {
            _addTracked(langEl, 'change', function () {
                _guardarPreferencia(CFG.PREF_LANGUAGE, langEl.value);
            }, _state._docListeners);
        }
        var promptEl = _el('chaptersIACustomPrompt');
        if (promptEl) {
            _addTracked(promptEl, 'change', function () {
                _guardarPreferencia(CFG.PREF_PROMPT, promptEl.value);
            }, _state._docListeners);
        }
        var modelSelect = _el('chaptersIAModel');
        if (modelSelect) {
            _addTracked(modelSelect, 'change', function () {
                _guardarPreferencia(CFG.PREF_MODEL, modelSelect.value);
                _updateModelBadge();
            }, _state._docListeners);
        }

        // Escape (centralizado en vp-eventos.js)
        if (typeof VP.eventos.registrarModalIA === 'function') {
            VP.eventos.registrarModalIA('chaptersIAModal', _closeModal);
        }

        // Atajo Ctrl+Shift+G
        _addTracked(document, 'keydown', function (e) {
            if (e.ctrlKey && e.shiftKey && e.key === 'G') {
                e.preventDefault();
                _openModal();
            }
        }, _state._docListeners);

        // Eventos de video
        var videoEvents = ['videoLoaded', 'videoChanged', 'videoSeleccionado'];
        for (var i = 0; i < videoEvents.length; i++) {
            _addTracked(document, videoEvents[i], _onVideoChanged, _state._docListeners);
        }
        _addTracked(document, 'videoLoaded', _updateSubtitleStatus, _state._docListeners);
        _addTracked(document, 'subtitlesChanged', _updateSubtitleStatus, _state._docListeners);

        var video = VP.refs && VP.refs.videoPlayer;
        if (video && !dom.esNulo(video)) {
            _addTracked(video, 'emptied', function () { setTimeout(_onVideoChanged, 60); }, _state._videoListeners);
            _addTracked(video, 'loadstart', _onVideoChanged, _state._videoListeners);
            _addTracked(video, 'loadedmetadata', function () {
                var newId = _getVideoId();
                if (newId !== _state.currentVideoId) {
                    _onVideoChanged();
                } else {
                    _renderMarkers();
                }
            }, _state._videoListeners);
            _addTracked(video, 'durationchange', _renderMarkers, _state._videoListeners);
        }

        // VP bus
        if (bus) {
            var busEvents = [
                ['videoListo', _onVideoChanged],
                ['videoCambiado', _onVideoChanged],
                ['videoReproduciendo', function () { _onVideoChanged(); _updateSubtitleStatus(); }],
                ['videoDetenido', function () { _clearMarkers(); _state.appliedChapters = []; }],
                ['subtitulosCargados', _updateSubtitleStatus],
                ['cacheVaciada', function () { _cacheLRU.clear(); _clearMarkers(); }],
                ['reset', function () {
                    _cancel();
                    _cacheLRU.clear();
                    _clearMarkers();
                    _state.appliedChapters = [];
                    _state.generatedChapters = [];
                    _state.currentVideoId = '';
                }],
            ];
            for (var bi = 0; bi < busEvents.length; bi++) {
                bus.on(busEvents[bi][0], busEvents[bi][1]);
                _state._busListeners.push({ event: busEvents[bi][0], handler: busEvents[bi][1] });
            }
        }

        _state._unloadHandler = function () { _destroy(); };
        window.addEventListener('beforeunload', _state._unloadHandler);
    }

    function _bind(id, handler) {
        var el = _el(id);
        if (el) {
            _addTracked(el, 'click', handler, _state._docListeners);
        }
    }

    // ============================================================
    // 28. DESTRUIR
    // ============================================================

    function _destroy() {
        if (_state.isGenerating && _state.abortController) {
            try { _state.abortController.abort(); } catch (_) {}
        }
        clearTimeout(_state.urlDebounceTimer);
        clearTimeout(_state.cbTimer);
        _removeTracked(_state._docListeners);
        _removeTracked(_state._videoListeners);

        if (bus) {
            for (var i = 0; i < _state._busListeners.length; i++) {
                try { bus.off(_state._busListeners[i].event, _state._busListeners[i].handler); } catch (_) {}
            }
        }
        _state._busListeners.length = 0;

        _clearMarkers();

        var styleEl = document.getElementById('vpChaptersIAStyles');
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
        _state._stylesInjected = false;

        if (_state._unloadHandler) {
            window.removeEventListener('beforeunload', _state._unloadHandler);
        }

        _state.isGenerating = false;
        _state.abortController = null;
        _state.generatedChapters = [];
        _state.appliedChapters = [];
        _state._initialized = false;

        log.info('Módulo destruido.');
    }

    // ============================================================
    // 29. API PÚBLICA
    // ============================================================

    VP.capitulosIA = {
        open: _openModal,
        close: _closeModal,
        generate: _generate,
        cancel: _cancel,
        reset: _resetToConfig,

        apply: function () {
            if (_state.generatedChapters.length === 0) {
                _notif('No hay capítulos para aplicar', 'error');
                return;
            }
            var modelEl = _el('chaptersIAModel');
            _applyChapters(_state.generatedChapters, modelEl ? modelEl.value : '');
        },

        setChapters: function (chapters, model) {
            var normalized = _normalizar(chapters || []);
            _state.generatedChapters = normalized.slice();
            _applyChapters(normalized, model || '');
            return normalized.slice();
        },

        getChapters: function () {
            return _state.generatedChapters.slice();
        },

        getApplied: function () {
            return _state.appliedChapters.slice();
        },

        deleteChapters: function () {
            var videoId = _getVideoId();
            if (videoId) _eliminarCapitulos(videoId);
            _state.generatedChapters = [];
            _state.appliedChapters = [];
            _clearMarkers();
            if (VP.estado) VP.estado.capitulos = [];
            _notif('Capítulos eliminados', 'info');
        },

        getCurrentVideoId: _getVideoId,
        render: _renderMarkers,
        destroy: _destroy,

        obtenerMetricas: function () {
            return {
                cacheSize: _cacheLRU.size(),
                cacheMax: CFG.CACHE_LRU_MAX,
                cbFallos: _state.cbFallos,
                cbAbierto: _state.cbAbierto,
                isGenerating: _state.isGenerating,
                appliedCount: _state.appliedChapters.length,
                generatedCount: _state.generatedChapters.length,
                currentVideoId: _state.currentVideoId,
                recentGenerations: _state._recentGenerations.slice(),
            };
        },
    };

    window.VP_CapitulosIA = VP.capitulosIA;

    // ============================================================
    // 30. INICIALIZACIÓN
    // ============================================================

    function _init() {
        if (_state._initialized) {
            log.warn('Ya inicializado.');
            return;
        }
        _state._initialized = true;
        _registerEvents();
        _installStyles();
        _state.currentVideoId = _getVideoId();
        _restaurarCapitulos();

        var savedUrl = _leerPreferencia(CFG.PREF_URL, '');
        if (savedUrl) {
            var u = _el('chaptersIAUrl');
            if (u) u.value = savedUrl;
        }

        log.info('v5.0.0 iniciado | VideoId: ' + (_state.currentVideoId || '?') +
                 ' | LRU max: ' + CFG.CACHE_LRU_MAX + ' | CB umbral: ' + CFG.CB_UMBRAL_FALLAS +
                 ' | Chunk: ' + CFG.CHUNK_DURATION_S + 's');
    }

    function _waitForVP() {
        var initialized = false;
        var attempts = 0;
        var MAX_ATTEMPTS = 300;
        var POLL_MS = 20;

        function tryInit() {
            if (initialized) return;
            initialized = true;
            document.removeEventListener('vpReady', onReady);
            _init();
        }

        function onReady() { tryInit(); }

        function poll() {
            if (initialized) return;
            attempts++;
            if (VP.log && VP.bus && VP.db && VP.dom && VP.util) {
                tryInit();
                return;
            }
            if (attempts >= MAX_ATTEMPTS) {
                log.warn('VP no listo tras ' + (MAX_ATTEMPTS*POLL_MS) + 'ms — forzado.');
                tryInit();
                return;
            }
            setTimeout(poll, POLL_MS);
        }

        document.addEventListener('vpReady', onReady);
        poll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _waitForVP);
    } else {
        _waitForVP();
    }

    // ============================================================
    // 31. VERIFICACIÓN
    // ============================================================

    (function _verificar() {
        var requeridos = [
            'open', 'close', 'generate', 'cancel', 'apply',
            'setChapters', 'getChapters', 'getApplied',
            'deleteChapters', 'getCurrentVideoId', 'render',
            'destroy', 'reset', 'obtenerMetricas',
        ];
        var faltantes = [];
        for (var i = 0; i < requeridos.length; i++) {
            if (typeof VP.capitulosIA[requeridos[i]] !== 'function') {
                faltantes.push(requeridos[i]);
            }
        }
        if (faltantes.length) {
            log.error('Funciones faltantes → ' + faltantes.join(', '));
        } else {
            log.debug('Verificación OK (' + requeridos.length + ' funciones).');
        }
    })();

    log.info('vp-capitulos-ia.js v5.0.0 cargado.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-capitulos-ia.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
