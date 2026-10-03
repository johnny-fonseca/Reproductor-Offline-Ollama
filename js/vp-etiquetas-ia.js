'use strict';

// ============================================================
// VP-ETIQUETAS-IA.JS  —  v2.2.0  (Motor Semántico)
// Etiquetado automático semántico con IA (Ollama).
//
// Basado en transcripción del video como fuente principal.
// Las etiquetas son cortas (1-3 palabras), específicas y
// semánticamente útiles: tecnologías, frameworks, herramientas,
// APIs, conceptos, plataformas, lenguajes, temas principales.
//
// PERSISTENCIA ROBUSTA:
//   Clave = nombre del archivo (estable).
//   Caché: LRU memoria + IndexedDB.
//   MutationObserver en galería para aplicar etiquetas
//   a items nuevos automáticamente.
//
// Dependencias: vp-base.js · vp-utilidades.js · vp-dom.js ·
//               vp-db.js · vp-ollama-client.js · vp-subtitulos.js
// ============================================================

(function (window, document) {
    if (window.__VP_ETIQUETAS_IA_LOADED__) return;
    window.__VP_ETIQUETAS_IA_LOADED__ = true;

    var VP = window.VP;
    if (!VP) throw new Error('[VP] vp-etiquetas-ia.js requiere vp-base.js');

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;
    log.setContext('EtiquetasIA');

    if (!util || !dom || !log || !bus) {
        throw new Error('[VP] vp-etiquetas-ia.js: dependencias faltantes');
    }

    VP.etiquetasIA = VP.etiquetasIA || {};

    // ============================================================
    // 1. CONSTANTES
    // ============================================================

    var CFG = Object.freeze({
        DEFAULT_URL      : 'http://localhost:11434',
        FETCH_TIMEOUT    : 12000,

        MAX_TAGS         : 8,
        GALLERY_MAX_TAGS : 4,

        STORAGE_PREFIX   : 'vpTagsIA_',
        LS_INDEX_KEY     : 'vpTagsIA__index',
        CACHE_MAX        : 500,

        PREF_MODEL       : 'tagsIA_model',
        PREF_URL         : 'vp_ollama_url',
        PREF_LAST_BATCH  : 'tagsIA_lastBatch',

        SUBTITLE_MAX     : 50000,
        TAG_MAX_LENGTH   : 40,
        TAG_MIN_LENGTH   : 1,

        GALLERY_CLS      : 'tags-ia-gallery-overlay',
        GALLERY_CHIP_CLS : 'tags-ia-gallery-chip',

        OBSERVER_DEBOUNCE: 200,
        RETRY_INTERVAL   : 1000,
        MAX_RETRIES      : 10,
        PRELOAD_DELAY    : 500,
        IDB_RETRY_DELAY  : 5,
        BATCH_ITEM_DELAY : 100,

        // Validación y sanitización
        TAG_REGEX        : /^[a-zA-Z0-9\s\-_.áéíóúñàèìòùäëïöüçÁÉÍÓÚÑÀÈÌÒÙÄËÏÖÜÇ]+$/,
        FORBIDDEN_TAGS   : ['video', 'archivo', 'contenido'],

        // Versionado
        VERSION          : '2.3.0',
        STORAGE_VERSION  : 'v1',

        // Límites y timeouts
        REQUEST_TIMEOUT  : 120000,
        MAX_CONCURRENT   : 3,
        STATS_UPDATE_RATE: 1000,
    });

    // ============================================================
    // 2. ESTADO
    // ============================================================

    var _s = {
        tags            : [],
        isGenerating    : false,
        abortController : null,
        currentVideoKey : '',

        _docListeners   : [],
        _busListeners   : [],
        _initialized    : false,

        _galleryObserver : null,
        _galleryApplyTimer: null,
        _galleryItemTimer : null,
        _pendingGalleryItems: new Set(),
        _observerTimer   : null,
        _retryTimer      : null,
        _retryCount      : 0,
        _preloaded       : false,
        _cssInjected     : false,
        _timers          : [],

        // Estadísticas
        _stats           : {
            totalGenerated  : 0,
            totalFailed     : 0,
            lastGeneration  : null,
            generationTimes : [],
        },

        // Control de concurrencia en batch
        _batchQueue      : [],
        _batchRunning    : 0,
        _batchAborted    : false,

        // Historial de errores
        _errorLog        : [],
        _maxErrors       : 50,
    };

    // ============================================================
    // 3. CACHÉ LRU EN MEMORIA
    // ============================================================

    var _cache = (function () {
        var _m = Object.create(null);
        var _o = [];

        return {
            get: function (k) {
                if (!k || !_m[k]) return null;
                var i = _o.indexOf(k);
                if (i > -1) _o.splice(i, 1);
                _o.push(k);
                return _m[k];
            },
            set: function (k, v) {
                if (!k) return;
                if (_m[k]) {
                    var i = _o.indexOf(k);
                    if (i > -1) _o.splice(i, 1);
                }
                while (_o.length >= CFG.CACHE_MAX) {
                    var old = _o.shift();
                    delete _m[old];
                }
                _m[k] = v;
                _o.push(k);
            },
            del: function (k) {
                if (!k) return;
                delete _m[k];
                var i = _o.indexOf(k);
                if (i > -1) _o.splice(i, 1);
            },
            has: function (k) {
                return !!_m[k];
            },
            clear: function () {
                _m = Object.create(null);
                _o = [];
            },
            all: function () { return _m; },
            keys: function () { return _o.slice(); },
            size: function () { return _o.length; },
        };
    })();

    // ============================================================
    // 4. ÍNDICE GLOBAL DE NOMBRES CON ETIQUETAS
    // ============================================================

    var _index = {

        _data: null,

        _load: function () {
            if (this._data) return this._data;
            try {
                var raw = VP.db.obtenerKeyVal(CFG.LS_INDEX_KEY);
                this._data = raw || {};
            } catch (_) {
                this._data = {};
            }
            return this._data;
        },

        add: function (name) {
            var d = this._load();
            d[name] = Date.now();
            try { VP.db.guardarKeyVal(CFG.LS_INDEX_KEY, d); }
            catch (_) {}
        },

        remove: function (name) {
            var d = this._load();
            delete d[name];
            try { VP.db.guardarKeyVal(CFG.LS_INDEX_KEY, d); }
            catch (_) {}
        },

        getAll: function () {
            return Object.keys(this._load());
        },

        has: function (name) {
            return !!this._load()[name];
        },
    };

    // ============================================================
    // 5. CLAVE ESTABLE — SIEMPRE usa nombre del archivo
    // ============================================================

    function _stableKey(v) {
        if (!v) return '';
        if (typeof v === 'string') return v;
        return (v.name && typeof v.name === 'string') ? v.name : String(v.id || '');
    }

    function _currentKey() {
        var ci = VP.estado && VP.estado.currentVideoIndex;
        var pl = VP.estado && VP.estado.playlist;
        if (typeof ci === 'number' && ci >= 0 && pl && pl[ci]) {
            return _stableKey(pl[ci]);
        }
        return '';
    }

    function _getVideoObj() {
        var ci = VP.estado && VP.estado.currentVideoIndex;
        var pl = VP.estado && VP.estado.playlist;
        return (typeof ci === 'number' && ci >= 0 && pl && pl[ci]) ? pl[ci] : null;
    }

    // ============================================================
    // 6. HELPERS
    // ============================================================

    function _el(id) {
        if (!id || typeof id !== 'string') return null;
        try { return document.getElementById(id); } catch (_) { return null; }
    }

    function _setDisplay(id, v) {
        var e = _el(id);
        if (e) {
            try { e.style.display = v; } catch (_) {}
        }
    }

    function _addTracked(t, ev, fn, store) {
        if (!t || typeof t.addEventListener !== 'function') return;
        try {
            t.addEventListener(ev, fn);
            (store || _s._docListeners).push({ target: t, event: ev, handler: fn });
        } catch (err) {
            log.warn('Error agregando evento:', err.message || err);
        }
    }

    function _removeTracked(store) {
        if (!Array.isArray(store)) return;
        for (var i = 0; i < store.length; i++) {
            try {
                if (store[i] && store[i].target && store[i].event && store[i].handler) {
                    store[i].target.removeEventListener(store[i].event, store[i].handler);
                }
            } catch (err) {
                log.debug('Error removiendo evento:', err.message || err);
            }
        }
        store.length = 0;
    }

    function _notif(m, t) {
        if (typeof m !== 'string' || !m) return;
        try {
            if (VP.ui && typeof VP.ui.mostrarNotificacion === 'function') {
                VP.ui.mostrarNotificacion(m, t || 'info');
            }
        } catch (err) {
            log.debug('Error notif:', err.message || err);
        }
    }

    function _normalizeUrl(r) {
        var u = (typeof r === 'string' ? r : '').trim();
        if (!u) return CFG.DEFAULT_URL;
        if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
        return u.replace(/\/+$/, '');
    }

    function _isValidUrl(s) {
        if (!s || typeof s !== 'string') return false;
        try { new URL(s.trim()); return true; } catch (_) { return false; }
    }

    function _getVideoTitle() {
        var v = _getVideoObj();
        if (!v) return 'Video sin nombre';
        return (v.name && typeof v.name === 'string') ? v.name.trim() : 'Video';
    }

    function _escHTML(s) {
        if (typeof s !== 'string') return '';
        return util.escaparHTML ? util.escaparHTML(s) : s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ============================================================
    // 6.5. VALIDACIÓN Y SANITIZACIÓN DE ETIQUETAS
    // ============================================================

    function _isValidTag(tag) {
        if (!tag || typeof tag.value !== 'string') return false;
        var val = tag.value.trim();
        if (val.length < CFG.TAG_MIN_LENGTH || val.length > CFG.TAG_MAX_LENGTH) return false;
        if (!CFG.TAG_REGEX.test(val)) return false;
        for (var i = 0; i < CFG.FORBIDDEN_TAGS.length; i++) {
            if (val.toLowerCase().indexOf(CFG.FORBIDDEN_TAGS[i]) === 0) return false;
        }
        return true;
    }

    function _sanitizeTag(val) {
        if (!val || typeof val !== 'string') return '';
        var cleaned = val.trim()
            .slice(0, CFG.TAG_MAX_LENGTH)
            .replace(/[\n\r\t]/g, ' ')
            .replace(/\s+/g, ' ');
        if (!CFG.TAG_REGEX.test(cleaned)) {
            cleaned = cleaned.replace(/[^\w\s\-áéíóúñàèìòùäëïöüç]/gi, '').trim();
        }
        return cleaned;
    }

    function _filterValidTags(tags) {
        if (!Array.isArray(tags)) return [];
        var result = [];
        for (var i = 0; i < tags.length; i++) {
            if (tags[i] && _isValidTag(tags[i])) {
                result.push(tags[i]);
            }
        }
        return result;
    }

    // ============================================================
    // 6.6. LOGGING DE ERRORES
    // ============================================================

    function _logError(msg, err, ctx) {
        var entry = {
            ts: Date.now(),
            msg: msg,
            error: err ? (err.message || String(err)) : '',
            context: ctx || {},
        };
        _s._errorLog.push(entry);
        if (_s._errorLog.length > _s._maxErrors) {
            _s._errorLog.shift();
        }
        log.error(msg, err);
    }

    function _getErrorLog() {
        return _s._errorLog.slice();
    }

    // ============================================================
    // 6.8. FUNCIONES UTILITARIAS ADICIONALES
    // ============================================================

    function _delay(ms) {
        return new Promise(function (resolve) {
            var timer = setTimeout(resolve, ms);
            _s._timers.push(timer);
        });
    }

    function _retryOperation(fn, maxAttempts, delayMs) {
        maxAttempts = maxAttempts || 3;
        delayMs = delayMs || 1000;
        var attempt = 0;

        function attempt_op() {
            attempt++;
            return Promise.resolve()
                .then(fn)
                .catch(function (err) {
                    if (attempt >= maxAttempts) throw err;
                    return _delay(delayMs).then(attempt_op);
                });
        }

        return attempt_op();
    }

    function _safeJsonParse(str, fallback) {
        try {
            return util.parsearJSONSeguro ? util.parsearJSONSeguro(str, fallback) : JSON.parse(str);
        } catch (err) {
            _logError('safeJsonParse: error parsing', err, { length: str.length });
            return fallback !== undefined ? fallback : null;
        }
    }

    function _safeJsonStringify(obj) {
        try {
            return JSON.stringify(obj);
        } catch (err) {
            _logError('safeJsonStringify: error stringify', err);
            return '';
        }
    }

    function _isOnline() {
        return typeof navigator !== 'undefined' && navigator.onLine;
    }

    function _truncateString(str, maxLen) {
        if (!str || typeof str !== 'string') return '';
        if (str.length <= maxLen) return str;
        return str.slice(0, maxLen - 3) + '…';
    }

    function _arrayUnique(arr) {
        if (!Array.isArray(arr)) return [];
        var seen = {};
        var result = [];
        for (var i = 0; i < arr.length; i++) {
            var val = arr[i];
            if (val && !seen[val]) {
                seen[val] = true;
                result.push(val);
            }
        }
        return result;
    }

    function _arrayDifference(a, b) {
        if (!Array.isArray(a)) return [];
        if (!Array.isArray(b)) return a.slice();
        var bSet = {};
        for (var j = 0; j < b.length; j++) {
            bSet[b[j]] = true;
        }
        var result = [];
        for (var i = 0; i < a.length; i++) {
            if (!bSet[a[i]]) result.push(a[i]);
        }
        return result;
    }

    function _recordGeneration(durationMs, success, count) {
        _s._stats.generationTimes.push(durationMs);
        if (_s._stats.generationTimes.length > 100) {
            _s._stats.generationTimes.shift();
        }
        if (success) {
            _s._stats.totalGenerated += (count || 0);
        } else {
            _s._stats.totalFailed++;
        }
        _s._stats.lastGeneration = {
            ts: Date.now(),
            success: success,
            count: count || 0,
            duration: durationMs,
        };
    }

    function _getStats() {
        var times = _s._stats.generationTimes;
        var avg = times.length > 0 ? (times.reduce(function(a,b){return a+b;}, 0) / times.length) : 0;
        return {
            totalGenerated: _s._stats.totalGenerated,
            totalFailed: _s._stats.totalFailed,
            avgTime: avg.toFixed(0),
            lastGeneration: _s._stats.lastGeneration,
        };
    }

    // ============================================================
    // 7. SUBTÍTULOS COMO CONTEXTO
    // ============================================================

    function _getSubtitleContext() {
        var text = '';
        try {
            var cues = window.vpSubtitleCues;
            if (Array.isArray(cues) && cues.length > 0) {
                var lines = [];
                for (var i = 0; i < cues.length; i++) {
                    if (cues[i] && cues[i].texto) lines.push(cues[i].texto);
                }
                text = lines.join(' ');
            } else {
                var video = VP.refs && VP.refs.videoPlayer;
                if (video && !dom.esNulo(video)) {
                    var tracks = video.textTracks;
                    if (tracks && tracks.length > 0) {
                        for (var i = 0; i < tracks.length; i++) {
                            var track = tracks[i];
                            if (track.kind === 'subtitles' && track.cues && track.cues.length > 0) {
                                var activeLines = [];
                                for (var j = 0; j < track.cues.length; j++) {
                                    var cue = track.cues[j];
                                    if (cue && cue.text) activeLines.push(cue.text);
                                }
                                if (activeLines.length > 0) {
                                    text = activeLines.join(' ');
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        } catch (_) {}
        if (text.length > CFG.SUBTITLE_MAX) {
            text = _truncateSmart(text, CFG.SUBTITLE_MAX);
        }
        return text;
    }

    /**
     * Obtiene los subtítulos de un vídeo mediante VP.subtitulos si está disponible.
     * Devuelve una promesa con el texto o cadena vacía.
     */
    function _obtenerSubtitulosVideo(video) {
        if (!video || !VP.subtitulos) return Promise.resolve('');
        return VP.subtitulos.obtenerSubtitulos(video)
            .then(function (texto) {
                if (typeof texto !== 'string' || !texto.trim()) return '';
                if (texto.length > CFG.SUBTITLE_MAX) {
                    texto = _truncateSmart(texto, CFG.SUBTITLE_MAX);
                }
                return texto;
            })
            .catch(function () {
                return '';
            });
    }

    function _truncateSmart(text, maxChars) {
        if (!text || text.length <= maxChars) return text;
        var third    = Math.floor(maxChars / 3);
        var start    = text.substring(0, third);
        var midPoint = Math.floor(text.length / 2);
        var halfMid  = Math.floor(third / 2);
        var middle   = text.substring(midPoint - halfMid, midPoint + halfMid);
        var end      = text.substring(text.length - third);
        return start + '\n[...]\n' + middle + '\n[...]\n' + end;
    }

    // ============================================================
    // 8. PERSISTENCIA — GUARDAR
    // ============================================================

    function _saveTags(key, tags) {
        if (!key || typeof key !== 'string') {
            _logError('saveTags: clave inválida', null, { key: key });
            return;
        }

        var filteredTags = _filterValidTags(tags);
        if (!Array.isArray(filteredTags)) filteredTags = [];

        try {
            // 1. Caché LRU
            _cache.set(key, filteredTags);
        } catch (err) {
            _logError('saveTags: error en caché LRU', err, { key: key });
        }

        try {
            // 2. localStorage (triple intento)
            util.storageSet(CFG.STORAGE_PREFIX + key, filteredTags);
            if (filteredTags && filteredTags.length > 0) {
                _index.add(key);
            } else {
                _index.remove(key);
            }
        } catch (err) {
            _logError('saveTags: error en almacenamiento', err, { key: key });
        }

        try {
            // 3. IDB (con reintentos)
            if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
                VP.db.guardarMetadatos(key, {
                    tagsIA       : filteredTags,
                    tagsIATs     : Date.now(),
                    tagsIAVersion: CFG.STORAGE_VERSION,
                }).catch(function (err) {
                    _logError('saveTags: error en IDB guardar', err, { key: key });
                });
            }
        } catch (err) {
            _logError('saveTags: error preparando IDB', err, { key: key });
        }

        try {
            // 4. Asignar al objeto de video en memoria
            _assignToVideoObjects(key, filteredTags);
        } catch (err) {
            _logError('saveTags: error asignando a objetos video', err, { key: key });
        }

        try {
            // 5. Actualizar galería
            _applyTagsToGalleryItem(key);
        } catch (err) {
            _logError('saveTags: error aplicando a galería', err, { key: key });
        }

        try {
            // 6. Emitir evento
            if (bus) bus.emit('etiquetasIA:actualizadas', { key: key, tags: filteredTags });
        } catch (err) {
            _logError('saveTags: error emitiendo evento', err, { key: key });
        }

        log.debug('Etiquetas guardadas para:', key, '(' + filteredTags.length + ')');
    }

    function _assignToVideoObjects(name, tags) {
        if (!name || typeof name !== 'string') return;

        var videos = VP.estado && VP.estado.videos;
        var playlist = VP.estado && VP.estado.playlist;
        var arrs = [videos, playlist];

        for (var a = 0; a < arrs.length; a++) {
            if (!Array.isArray(arrs[a])) continue;
            for (var i = 0; i < arrs[a].length; i++) {
                try {
                    if (arrs[a][i] && arrs[a][i].name === name) {
                        arrs[a][i]._tagsIA = tags;
                        log.debug('Tags asignados a video objeto:', name);
                    }
                } catch (err) {
                    _logError('assignToVideoObjects: error en item', err, { index: i, name: name });
                }
            }
        }
    }

    // ============================================================
    // 9. PERSISTENCIA — CARGAR UNO
    // ============================================================

    function _loadTags(key) {
        if (!key || typeof key !== 'string') return Promise.resolve([]);

        try {
            // 1. LRU (más rápido)
            var c = _cache.get(key);
            if (c && Array.isArray(c) && c.length) {
                log.debug('Tags cargados desde LRU:', key);
                return Promise.resolve(c);
            }

            // 2. LS (rápido)
            var ls = util.storageGet(CFG.STORAGE_PREFIX + key, null);
            if (ls && Array.isArray(ls) && ls.length) {
                var filtered = _filterValidTags(ls);
                _cache.set(key, filtered);
                log.debug('Tags cargados desde LS:', key);
                return Promise.resolve(filtered);
            }
        } catch (err) {
            _logError('loadTags: error LS/caché', err, { key: key });
        }

        // 3. IDB (más lento pero completo)
        if (VP.db && typeof VP.db.obtenerMetadatos === 'function') {
            return VP.db.obtenerMetadatos(key).then(function (meta) {
                if (meta && Array.isArray(meta.tagsIA) && meta.tagsIA.length) {
                    var filtered = _filterValidTags(meta.tagsIA);
                    _cache.set(key, filtered);
                    try {
                        util.storageSet(CFG.STORAGE_PREFIX + key, filtered);
                        _index.add(key);
                    } catch (err) {
                        _logError('loadTags: error respaldando a LS', err, { key: key });
                    }
                    log.debug('Tags cargados desde IDB:', key);
                    return filtered;
                }
                return [];
            }).catch(function (err) {
                _logError('loadTags: error IDB', err, { key: key });
                return [];
            });
        }

        return Promise.resolve([]);
    }

    // ============================================================
    // 10. PERSISTENCIA — PRECARGAR TODOS
    // ============================================================

    function _preloadAll() {
        var nombres = _index.getAll();
        var cargados = 0;

        for (var i = 0; i < nombres.length; i++) {
            var key = nombres[i];
            if (_cache.has(key)) { cargados++; continue; }

            try {
                var ls = util.storageGet(CFG.STORAGE_PREFIX + key, null);
                if (ls && Array.isArray(ls) && ls.length) {
                    _cache.set(key, ls);
                    cargados++;
                }
            } catch (_) {}
        }

        log.info(
            'Precarga: ' + cargados + '/' +
            nombres.length + ' desde caché'
        );

        var videos = VP.estado && VP.estado.videos;
        if (Array.isArray(videos)) {
            for (var v = 0; v < videos.length; v++) {
                var vid = videos[v];
                if (!vid || !vid.name) continue;
                if (!vid._tagsIA) {
                    var cached = _cache.get(vid.name);
                    if (cached) vid._tagsIA = cached;
                }
            }
        }

        _s._preloaded = true;
        _applyAllToGallery();
        _preloadFromIDB();
    }

    function _preloadFromIDB() {
        var videos = VP.estado && VP.estado.videos;
        if (!Array.isArray(videos) || !videos.length) return;
        if (!VP.db || typeof VP.db.obtenerMetadatos !== 'function') return;

        var pending = [];
        for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            if (!v || !v.name) continue;
            if (_cache.has(v.name)) continue;
            pending.push(v);
        }

        if (!pending.length) return;

        log.debug('IDB: ' + pending.length + ' videos pendientes');

        var idx = 0;
        var encontrados = 0;

        function next() {
            if (idx >= pending.length) {
                if (encontrados > 0) {
                    log.info('IDB: ' + encontrados + ' tags cargados');
                    _applyAllToGallery();
                }
                return;
            }

            var v = pending[idx++];

            VP.db.obtenerMetadatos(v.name)
                .then(function (meta) {
                    if (meta && Array.isArray(meta.tagsIA) && meta.tagsIA.length) {
                        _cache.set(v.name, meta.tagsIA);
                        v._tagsIA = meta.tagsIA;
                        encontrados++;
                        try {
                            util.storageSet(CFG.STORAGE_PREFIX + v.name, meta.tagsIA);
                            _index.add(v.name);
                        } catch (_) {}
                    }
                })
                .catch(function () {})
                .then(function () { setTimeout(next, 5); });
        }

        setTimeout(next, 300);
    }

    // ============================================================
    // 11. GALERÍA — OBTENER NOMBRE DESDE ITEM
    // ============================================================

    function _nameFromGalleryItem(itemEl) {
        if (!itemEl) return '';

        var vidId = itemEl.dataset && itemEl.dataset.vidId;
        if (vidId) {
            var videos = VP.estado && VP.estado.videos;
            if (Array.isArray(videos)) {
                for (var i = 0; i < videos.length; i++) {
                    if (videos[i] && String(videos[i].id) === vidId) {
                        return videos[i].name || '';
                    }
                }
            }
        }

        var titleEl = itemEl.querySelector('.gallery-title');
        if (titleEl) {
            var text = (titleEl.textContent || '').trim();
            if (text) return text;
        }

        if (itemEl.title) return itemEl.title.trim();

        var label = itemEl.getAttribute('aria-label');
        if (label) {
            var match = label.replace(/^Reproducir\s+/i, '').trim();
            if (match) return match;
        }

        return '';
    }

    // ============================================================
    // 12. GALERÍA — APLICAR ETIQUETAS A UN ITEM
    // ============================================================

    function _applyTagsToGalleryItem(videoName) {
        if (!videoName) return;

        var galleryEl = VP.refs && VP.refs.galleryEl;
        if (!galleryEl || dom.esNulo(galleryEl)) return;

        var nameSelector = window.CSS && typeof window.CSS.escape === 'function'
            ? window.CSS.escape(String(videoName))
            : String(videoName).replace(/[\x00-\x1f\x7f"\\]/g, function (char) {
                return '\\' + char.charCodeAt(0).toString(16) + ' ';
            });
        var items = galleryEl.querySelectorAll('.gallery-item[title="' + nameSelector + '"]');
        if (!items.length) items = galleryEl.querySelectorAll('.gallery-item');
        for (var i = 0; i < items.length; i++) {
            var name = _nameFromGalleryItem(items[i]);
            if (name === videoName) {
                var tags = _cache.get(name);
                _renderChipsOnElement(items[i], tags);
            }
        }
    }

    // ============================================================
    // 13. GALERÍA — APLICAR ETIQUETAS A TODOS LOS ITEMS
    // ============================================================

    function _applyAllToGallery() {
        var galleryEl = VP.refs && VP.refs.galleryEl;
        if (!galleryEl || dom.esNulo(galleryEl)) return;

        var items = galleryEl.querySelectorAll('.gallery-item');
        if (!items.length) return;

        var aplicados = 0;

        for (var i = 0; i < items.length; i++) {
            var name = _nameFromGalleryItem(items[i]);
            if (!name) continue;

            var tags = _cache.get(name);
            if (!tags) {
                try {
                    var ls = util.storageGet(CFG.STORAGE_PREFIX + name, null);
                    if (ls && Array.isArray(ls) && ls.length) {
                        tags = ls;
                        _cache.set(name, ls);
                    }
                } catch (_) {}
            }

            if (tags && tags.length) {
                _renderChipsOnElement(items[i], tags);
                aplicados++;
            }
        }

        if (aplicados > 0) {
            log.debug('Galería: ' + aplicados + '/' + items.length + ' con tags');
        }
    }

    function _scheduleApplyAllToGallery(delay) {
        clearTimeout(_s._galleryApplyTimer);
        _s._galleryApplyTimer = setTimeout(function () {
            _s._galleryApplyTimer = null;
            _applyAllToGallery();
        }, Math.max(0, Number(delay) || 0));
    }

    function _queueGalleryItem(itemEl) {
        if (!itemEl) return;
        _s._pendingGalleryItems.add(itemEl);
        if (_s._galleryItemTimer) return;

        function processBatch() {
            _s._galleryItemTimer = null;
            var procesados = 0;
            while (_s._pendingGalleryItems.size && procesados < 40) {
                var item = _s._pendingGalleryItems.values().next().value;
                _s._pendingGalleryItems.delete(item);
                _applyTagsToNewItem(item);
                procesados++;
            }
            if (_s._pendingGalleryItems.size) {
                _s._galleryItemTimer = setTimeout(processBatch, 0);
            }
        }

        _s._galleryItemTimer = setTimeout(processBatch, 0);
    }

    function _applyAllWithRetry() {
        _s._retryCount = 0;
        clearTimeout(_s._retryTimer);
        _tryApply();
    }

    function _tryApply() {
        var galleryEl = VP.refs && VP.refs.galleryEl;
        var hasItems  = galleryEl && !dom.esNulo(galleryEl) &&
                        galleryEl.querySelectorAll('.gallery-item').length > 0;

        if (hasItems) {
            _applyAllToGallery();
            return;
        }

        _s._retryCount++;
        if (_s._retryCount <= CFG.MAX_RETRIES) {
            _s._retryTimer = setTimeout(_tryApply, CFG.RETRY_INTERVAL);
        }
    }

    // ============================================================
    // 14. GALERÍA — RENDERIZAR CHIPS SOBRE UN ELEMENTO
    // ============================================================

    function _renderChipsOnElement(element, tags) {
        if (!element || !tags || !Array.isArray(tags) || tags.length === 0) {
            try {
                var existing = element.querySelector('.' + CFG.GALLERY_CLS);
                if (existing && existing.parentNode) {
                    existing.parentNode.removeChild(existing);
                }
            } catch (err) {
                _logError('renderChips: error removiendo overlay', err);
            }
            return;
        }

        try {
            var overlay = element.querySelector('.' + CFG.GALLERY_CLS);
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = CFG.GALLERY_CLS;

                var tc = element.querySelector('.thumbnail-container');
                if (tc) {
                    tc.style.position = 'relative';
                    tc.appendChild(overlay);
                } else {
                    element.style.position = 'relative';
                    element.insertBefore(overlay, element.firstChild);
                }
            }

            var signature = JSON.stringify(tags.map(function (tag) {
                return tag && tag.value ? String(tag.value) : '';
            }));
            if (overlay.getAttribute('data-vp-tags-signature') === signature) return;

            overlay.innerHTML = '';

            var max  = Math.min(tags.length, CFG.GALLERY_MAX_TAGS);
            var frag = document.createDocumentFragment();

            for (var i = 0; i < max; i++) {
                var tag  = tags[i];
                if (!tag || !tag.value) continue;

                var chip = document.createElement('span');
                chip.className = CFG.GALLERY_CHIP_CLS;
                chip.textContent = _sanitizeTag(tag.value);
                chip.title = tag.value;
                frag.appendChild(chip);
            }

            if (tags.length > max) {
                var more = document.createElement('span');
                more.className   = CFG.GALLERY_CHIP_CLS + ' more';
                more.textContent = '+' + (tags.length - max);
                more.title       = tags.length + ' etiquetas totales';
                frag.appendChild(more);
            }

            overlay.appendChild(frag);
            overlay.setAttribute('data-vp-tags-signature', signature);
        } catch (err) {
            _logError('renderChips: error renderizando', err, { tagCount: tags.length });
        }
    }

    // ============================================================
    // 15. MUTATION OBSERVER — DETECTAR ITEMS NUEVOS EN GALERÍA
    // ============================================================

    function _startGalleryObserver() {
        if (_s._galleryObserver) return;

        var galleryEl = VP.refs && VP.refs.galleryEl;
        if (!galleryEl || dom.esNulo(galleryEl)) return;

        if (typeof MutationObserver === 'undefined') {
            log.warn('MutationObserver no disponible');
            return;
        }

        _s._galleryObserver = new MutationObserver(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                var added = mutations[m].addedNodes;
                if (!added || !added.length) continue;

                for (var n = 0; n < added.length; n++) {
                    var node = added[n];
                    if (!node || node.nodeType !== 1) continue;

                    if (node.classList && node.classList.contains('gallery-item')) {
                        _queueGalleryItem(node);
                    }

                    if (node.querySelectorAll) {
                        var inner = node.querySelectorAll('.gallery-item');
                        for (var j = 0; j < inner.length; j++) {
                            _queueGalleryItem(inner[j]);
                        }
                    }
                }
            }
        });

        _s._galleryObserver.observe(galleryEl, {
            childList: true,
            subtree:   true,
        });

        log.debug('MutationObserver en galería activado');
    }

    function _applyTagsToNewItem(itemEl) {
        if (!itemEl) return;

        var galleryEl = VP.refs && VP.refs.galleryEl;
        if (!galleryEl || !galleryEl.contains(itemEl)) return;
        var name = _nameFromGalleryItem(itemEl);
        if (!name) return;

        var tags = _cache.get(name);

        if (!tags) {
            try {
                var ls = util.storageGet(CFG.STORAGE_PREFIX + name, null);
                if (ls && Array.isArray(ls) && ls.length) {
                    tags = ls;
                    _cache.set(name, ls);
                }
            } catch (_) {}
        }

        if (tags && tags.length) {
            _renderChipsOnElement(itemEl, tags);
        }
    }

    function _stopGalleryObserver() {
        if (_s._galleryObserver) {
            try { _s._galleryObserver.disconnect(); } catch (_) {}
            _s._galleryObserver = null;
        }
    }

    // ============================================================
    // 16. PROMPT PARA OLLAMA — Etiquetas Semánticas
    // ============================================================

    function _buildPrompt(title, subtitles) {
        var hasSubs = subtitles && subtitles.length > 0;

        var intro = hasSubs
            ? 'Genera etiquetas semánticas para este video a partir de su transcripción.'
            : 'Genera etiquetas semánticas para este video a partir de su título.';

        var lines = [
            intro,
            '',
            'TÍTULO: ' + title,
        ];

        if (hasSubs) {
            lines.push('');
            lines.push('TRANSCRIPCIÓN:');
            lines.push(subtitles);
        }

        lines.push('');
        lines.push('REGLAS:');
        lines.push('- 3 a 8 etiquetas cortas (1-3 palabras cada una)');
        lines.push('- Específicas y técnicas: tecnologías, frameworks, herramientas, APIs, plataformas, lenguajes, conceptos, temas principales');
        lines.push('- Priorizar términos concretos sobre descripciones genéricas');
        lines.push('- Inferir tecnologías implícitas cuando el contexto lo indique');
        lines.push('- NO incluir etiquetas genéricas como "tutorial", "video", "educativo" a menos que sean el foco distintivo');
        lines.push('');
        lines.push('');
        lines.push('FORMATO DE RESPUESTA (obligatorio):');
        lines.push('Devuelve ÚNICAMENTE un array JSON de strings.');
        lines.push('NADA más antes o después. Sin markdown, sin explicaciones, sin objetos.');
        lines.push('');
        lines.push('Ejemplo correcto: ["React", "TypeScript", "API REST", "Node.js", "PostgreSQL", "Autenticación JWT"]');
        lines.push('');
        lines.push('Ejemplo INCORRECTO (no hagas esto): {"tags": ["React", "TypeScript"]}');
        lines.push('Ejemplo INCORRECTO (no hagas esto): ```json [...] ```');

        return lines.join('\n');
    }

    // ============================================================
    // 17. PARSEO DE RESPUESTA
    // ============================================================

    function _parseTags(raw) {
        if (!raw || typeof raw !== 'string') {
            throw new Error('Respuesta vacía o inválida');
        }

        // Log para depuración
        log.debug('Respuesta cruda del modelo:', raw.slice(0, 500));

        var text = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

        // ── Intento 1: Array JSON directo ──
        var tags = _tryParseArray(text);
        if (tags.length > 0) return tags;

        // ── Intento 2: Objeto con propiedad "tags" o "etiquetas" ──
        tags = _tryParseObjectWithArray(text);
        if (tags.length > 0) return tags;

        // ── Intento 3: Objeto con categorías (formato legacy) ──
        tags = _tryParseLegacyObject(text);
        if (tags.length > 0) return tags;

        // ── Intento 4: Lista con viñetas o líneas ──
        tags = _tryParseList(text);
        if (tags.length > 0) return tags;

        throw new Error('No se encontró array JSON en la respuesta');
    }

    function _tryParseArray(text) {
        var s = text.indexOf('[');
        var e = text.lastIndexOf(']');
        if (s === -1 || e === -1 || e <= s) return [];

        var json = text.slice(s, e + 1);
        var arr;

        try { arr = JSON.parse(json); }
        catch (err) {
            try { arr = JSON.parse(json.replace(/'/g, '"')); }
            catch (_) { return []; }
        }

        if (!Array.isArray(arr)) return [];

        var result = [];
        for (var i = 0; i < arr.length; i++) {
            if (typeof arr[i] === 'string') {
                var val = arr[i].trim().slice(0, 40);
                if (val) result.push({ category: 'tag', value: val });
            }
        }
        return result;
    }

    function _tryParseObjectWithArray(text) {
        var s = text.indexOf('{');
        var e = text.lastIndexOf('}');
        if (s === -1 || e === -1 || e <= s) return [];

        var json = text.slice(s, e + 1);
        var obj;

        try { obj = JSON.parse(json); }
        catch (_) { return []; }

        if (!obj || typeof obj !== 'object') return [];

        // Buscar cualquier propiedad que sea un array de strings
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
            var val = obj[keys[i]];
            if (Array.isArray(val)) {
                var result = [];
                for (var j = 0; j < val.length; j++) {
                    if (typeof val[j] === 'string') {
                        var v = val[j].trim().slice(0, 40);
                        if (v) result.push({ category: 'tag', value: v });
                    }
                }
                if (result.length > 0) return result;
            }
        }

        return [];
    }

    function _tryParseLegacyObject(text) {
        var s = text.indexOf('{');
        var e = text.lastIndexOf('}');
        if (s === -1 || e === -1 || e <= s) return [];

        var json = text.slice(s, e + 1);
        var obj;

        try { obj = JSON.parse(json); }
        catch (err) {
            try { obj = JSON.parse(json.replace(/'/g, '"').replace(/,(\s*})/g, '$1')); }
            catch (_) { return []; }
        }

        if (!obj || typeof obj !== 'object') return [];

        var result = [];
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
            var val = obj[keys[i]];
            if (typeof val === 'string') {
                var v = val.trim().slice(0, 40);
                if (v) result.push({ category: 'tag', value: v });
            }
        }
        return result;
    }

    function _tryParseList(text) {
        var lines = text.split('\n');
        var result = [];

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            // Eliminar viñetas: -, *, +, números.
            line = line.replace(/^[\s]*[-*+\d.]+\s+/, '').trim();

            // Eliminar comillas circundantes
            line = line.replace(/^["'\u00AB]+|["'\u00BB]+$/g, '').trim();

            if (line && line.length > 1 && line.length <= 40) {
                result.push({ category: 'tag', value: line });
            }
        }

        return result;
    }

    // ============================================================
    // 18. GENERAR ETIQUETAS CON IA
    // ============================================================

    function _generate() {
        if (_s.isGenerating) {
            _notif('Generación en curso…', 'advertencia');
            log.warn('generate: ya hay generación en curso');
            return;
        }

        var modelEl = _el('tagsIAModel');
        var model   = modelEl ? modelEl.value.trim() : '';
        if (!model) {
            _notif('Selecciona un modelo', 'error');
            log.warn('generate: modelo no seleccionado');
            return;
        }

        var urlEl   = _el('tagsIAUrl');
        var baseUrl = _normalizeUrl(urlEl ? urlEl.value : '');
        if (!_isValidUrl(baseUrl)) {
            _notif('URL de Ollama inválida', 'error');
            log.warn('generate: URL inválida', baseUrl);
            return;
        }

        var title = _getVideoTitle();
        var subs  = _getSubtitleContext();
        var key   = _currentKey();

        if (!title && !subs) {
            _notif('Sin video cargado', 'advertencia');
            log.warn('generate: sin video/subtítulos');
            return;
        }

        try {
            util.storageSet(CFG.PREF_MODEL, model);
            util.storageSet(CFG.PREF_URL, baseUrl);
        } catch (err) {
            _logError('generate: error guardando preferencias', err);
        }

        _s.isGenerating    = true;
        _s.abortController = new AbortController();
        _setDisplay('tagsIAGenerating', 'flex');

        var btn = _el('tagsIAGenerateBtn');
        if (btn) btn.disabled = true;

        var t0 = Date.now();

        log.info('Generando etiquetas para:', title);

        VP.ollama.chat(baseUrl, {
            model: model,
            messages: [
                { role: 'user', content: _buildPrompt(title, subs) }
            ],
            stream: false,
            options: { temperature: 0.3, num_predict: 1024 },
        }, {
            signal: _s.abortController.signal,
        }, {
            timeout: CFG.REQUEST_TIMEOUT,
            retries: 2,
            queued: true,
        })
        .then(function (content) {
            if (!content) {
                var err = new Error('Respuesta vacía del modelo');
                _logError('generate: respuesta vacía', err);
                throw err;
            }

            var newTags;
            try {
                newTags = _parseTags(content);
            } catch (parseErr) {
                log.warn('Parse falló. Respuesta (primeros 300 chars):', content.slice(0, 300));
                _logError('generate: parse tags falló', parseErr, { responseLen: content.length });
                throw parseErr;
            }

            if (!newTags || !Array.isArray(newTags) || !newTags.length) {
                var err2 = new Error('Sin etiquetas válidas en respuesta');
                _logError('generate: sin tags válidos', err2);
                throw err2;
            }

            _s.tags = newTags.slice(0, CFG.MAX_TAGS);
            _saveTags(key, _s.tags);
            _renderModalTags();

            var ms = ((Date.now() - t0) / 1000).toFixed(1);
            var msg = _s.tags.length + ' etiquetas en ' + ms + 's';
            _notif(msg, 'exito');
            _recordGeneration(Date.now() - t0, true, _s.tags.length);
            log.info('Etiquetas generadas:', _s.tags.length, '|', ms + 's');
        })
        .catch(function (err) {
            if (err && err.name === 'AbortError') {
                _notif('Cancelado', 'info');
                log.info('generate: cancelado por usuario');
            } else {
                var msg = err && err.message ? err.message : String(err);
                _notif('Error: ' + msg.slice(0, 60), 'error');
                _recordGeneration(Date.now() - t0, false, 0);
                _logError('generate: error en generación', err);
            }
        })
        .then(function () {
            _s.isGenerating = false;
            _s.abortController = null;
            _setDisplay('tagsIAGenerating', 'none');
            if (btn) btn.disabled = false;
        }, function () {
            _s.isGenerating = false;
            _s.abortController = null;
            _setDisplay('tagsIAGenerating', 'none');
            if (btn) btn.disabled = false;
        });
    }

    // ============================================================
    // 19. ETIQUETAR TODOS LOS VIDEOS (BATCH) — MEJORADO
    // ============================================================

    function _generateBatch(usarSubtitulos) {
        if (_s.isGenerating) {
            _notif('Ya hay un proceso en curso', 'advertencia');
            log.warn('generateBatch: ya en curso');
            return;
        }

        var modelEl = _el('tagsIAModel');
        var model   = modelEl ? modelEl.value.trim() : '';
        if (!model) {
            _notif('Selecciona un modelo', 'error');
            return;
        }

        var urlEl   = _el('tagsIAUrl');
        var baseUrl = _normalizeUrl(urlEl ? urlEl.value : '');
        if (!_isValidUrl(baseUrl)) {
            _notif('URL de Ollama inválida', 'error');
            return;
        }

        var videos = VP.estado && VP.estado.videos;
        if (!Array.isArray(videos) || videos.length === 0) {
            _notif('Sin videos en la lista', 'advertencia');
            return;
        }

        var pendientes = [];
        for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            if (!v || !v.name) continue;
            var key = _stableKey(v);
            if (!_index.has(key)) {
                pendientes.push(v);
            }
        }

        if (pendientes.length === 0) {
            _notif('Todos los videos ya tienen etiquetas', 'info');
            log.info('generateBatch: todos etiquetados ya');
            return;
        }

        try {
            util.storageSet(CFG.PREF_MODEL, model);
            util.storageSet(CFG.PREF_URL, baseUrl);
            util.storageSet(CFG.PREF_LAST_BATCH, {
                ts: Date.now(),
                model: model,
                url: baseUrl,
                withSubs: usarSubtitulos,
            });
        } catch (err) {
            _logError('generateBatch: error guardando prefs', err);
        }

        _s.isGenerating    = true;
        _s.abortController = new AbortController();
        _s._batchAborted   = false;
        _setDisplay('tagsIAGenerating', 'flex');

        var btnGen = _el('tagsIAGenerateBtn');
        if (btnGen) btnGen.disabled = true;
        var btnTagsIAAll = _el('tagsIAGenerateAllBtn');
        if (btnTagsIAAll) btnTagsIAAll.disabled = true;
        var btnTagsIAAllWithSubs = _el('tagsIAGenerateAllWithSubsBtn');
        if (btnTagsIAAllWithSubs) btnTagsIAAllWithSubs.disabled = true;

        var total   = pendientes.length;
        var actual  = 0;
        var exitos  = 0;
        var fallos  = 0;
        var tInicio = Date.now();
        var signal  = _s.abortController.signal;

        var statusText = _el('tagsIAStatusText');

        function _updateStatus() {
            if (statusText) {
                var pct = Math.round((actual / total) * 100);
                statusText.textContent = 'Etiquetando ' + actual + '/' + total + ' (' + pct + '%)…';
            }
        }

        function _procesarSiguiente() {
            if (signal.aborted || _s._batchAborted) {
                _finalizar();
                var cancelled = exitos + fallos;
                _notif('Cancelado (' + exitos + ' etiquetados, ' + fallos + ' errores)', 'info');
                log.info('Batch cancelado:', cancelled + '/' + total);
                return;
            }

            if (actual >= total) {
                var tiempo = ((Date.now() - tInicio) / 1000).toFixed(1);
                _finalizar();
                var msg = exitos + '/' + total + ' videos etiquetados en ' + tiempo + 's';
                if (fallos > 0) msg += ' (' + fallos + ' errores)';
                _notif(msg, 'exito');
                _recordGeneration(Date.now() - tInicio, true, exitos);
                log.info('Batch completado:', exitos + '/' + total, '|', tiempo + 's');
                return;
            }

            var video = pendientes[actual];
            var key   = _stableKey(video);
            var title = video.name || 'Video';

            _updateStatus();
            log.debug('Batch procesando:', (actual + 1) + '/' + total, '-', title.slice(0, 40));

            // Determinar si usar subtítulos
            var usarSubs = usarSubtitulos && VP.subtitulos && typeof VP.subtitulos.obtenerSubtitulos === 'function';

            var obtenerSubtitulos = usarSubs
                ? _obtenerSubtitulosVideo(video).catch(function () { return ''; })
                : Promise.resolve('');

            obtenerSubtitulos
                .then(function (subs) {
                    if (signal.aborted || _s._batchAborted) return Promise.reject({ name: 'AbortError' });

                    var promptContent = _buildPrompt(title, subs);
                    return VP.ollama.chat(baseUrl, {
                        model: model,
                        messages: [{ role: 'user', content: promptContent }],
                        stream: false,
                        options: { temperature: 0.3, num_predict: 1024 },
                    }, { signal: signal }, {
                        timeout: CFG.REQUEST_TIMEOUT,
                        retries: 1,
                        queued: true,
                    });
                })
                .then(function (content) {
                    if (signal.aborted || _s._batchAborted) return;

                    if (!content) throw new Error('Respuesta vacía');

                    var newTags;
                    try {
                        newTags = _parseTags(content);
                    } catch (parseErr) {
                        log.warn('Batch parse falló:', key);
                        _logError('Batch: parse falló', parseErr, { video: key });
                        fallos++;
                        return;
                    }

                    if (newTags && newTags.length) {
                        _saveTags(key, newTags.slice(0, CFG.MAX_TAGS));
                        exitos++;
                        log.debug('Batch exitoso:', key, '(' + newTags.length + ' tags)');
                    } else {
                        fallos++;
                        log.warn('Batch sin tags válidos:', key);
                    }
                })
                .catch(function (err) {
                    if (err && err.name === 'AbortError') return;
                    fallos++;
                    var msg = err && err.message ? err.message : String(err);
                    log.warn('Batch error:', key, '-', msg.slice(0, 60));
                    _logError('Batch generación falló', err, { video: key });
                })
                .then(function () {
                    actual++;
                    setTimeout(_procesarSiguiente, CFG.BATCH_ITEM_DELAY);
                });
        }

        function _finalizar() {
            _s.isGenerating = false;
            _s.abortController = null;
            _s._batchAborted = false;
            _setDisplay('tagsIAGenerating', 'none');
            if (statusText) statusText.textContent = 'Analizando contenido…';
            if (btnGen) btnGen.disabled = false;
            if (btnTagsIAAll) btnTagsIAAll.disabled = false;
            if (btnTagsIAAllWithSubs) btnTagsIAAllWithSubs.disabled = false;

            var curKey = _currentKey();
            if (curKey) {
                _loadTags(curKey).then(function (t) {
                    _s.tags = t || [];
                    _renderModalTags();
                });
            }
        }

        _procesarSiguiente();
    }

    // ============================================================
    // 20. AÑADIR / QUITAR / LIMPIAR
    // ============================================================

    function _addTag(cat, val) {
        if (!val || !val.trim()) return;
        val = val.trim().slice(0, 40);
        for (var i = 0; i < _s.tags.length; i++) {
            if (_s.tags[i].value.toLowerCase() === val.toLowerCase()) {
                _notif('Ya existe', 'info'); return;
            }
        }
        if (_s.tags.length >= CFG.MAX_TAGS) { _notif('Máximo ' + CFG.MAX_TAGS, 'advertencia'); return; }
        _s.tags.push({ category: 'tag', value: val });
        _saveTags(_currentKey(), _s.tags);
        _renderModalTags();
        _notif('Añadida: ' + val, 'exito');
    }

    function _removeTag(idx) {
        if (idx < 0 || idx >= _s.tags.length) return;
        var r = _s.tags.splice(idx, 1)[0];
        _saveTags(_currentKey(), _s.tags);
        _renderModalTags();
        _notif('Eliminada: ' + r.value, 'info');
    }

    function _clearTags() {
        _s.tags = [];
        _saveTags(_currentKey(), []);
        _renderModalTags();
    }

    // ============================================================
    // 21. RENDERIZAR EN EL MODAL — MEJORADO
    // ============================================================

    function _renderModalTags() {
        var container = _el('tagsIAChips');
        var emptyEl   = _el('tagsIAEmpty');
        var countEl   = _el('tagsIACount');

        if (!container) {
            log.warn('renderModalTags: contenedor no encontrado');
            return;
        }

        try {
            container.innerHTML = '';
            if (countEl) countEl.textContent = _s.tags.length + ' / ' + CFG.MAX_TAGS;

            if (!_s.tags || !_s.tags.length) {
                if (emptyEl) {
                    emptyEl.style.display = '';
                    container.appendChild(emptyEl);
                }
                log.debug('renderModalTags: sin etiquetas');
                return;
            }

            if (emptyEl) emptyEl.style.display = 'none';

            var frag = document.createDocumentFragment();
            for (var i = 0; i < _s.tags.length; i++) {
                (function (tag, idx) {
                    try {
                        var chip = document.createElement('div');
                        chip.className = 'tags-ia-chip';

                        var ic = document.createElement('span');
                        ic.className = 'tags-ia-chip-icon';
                        ic.textContent = '🏷';
                        ic.setAttribute('aria-hidden', 'true');

                        var tx = document.createElement('span');
                        tx.className = 'tags-ia-chip-text';
                        tx.textContent = _sanitizeTag(tag.value);
                        tx.title = tag.value;

                        var rm = document.createElement('button');
                        rm.className = 'tags-ia-chip-remove';
                        rm.textContent = '✕';
                        rm.setAttribute('title', 'Eliminar etiqueta');
                        rm.setAttribute('aria-label', 'Eliminar: ' + tag.value);
                        rm.type = 'button';
                        rm.addEventListener('click', function (e) {
                            e.stopPropagation();
                            _removeTag(idx);
                        });

                        chip.appendChild(ic);
                        chip.appendChild(tx);
                        chip.appendChild(rm);
                        frag.appendChild(chip);
                    } catch (err) {
                        _logError('renderModalTags: error renderizando chip', err, { idx: idx });
                    }
                })(_s.tags[i], i);
            }

            container.appendChild(frag);
            log.debug('renderModalTags: renderizados', _s.tags.length, 'chips');
        } catch (err) {
            _logError('renderModalTags: error general', err);
        }
    }

    function _updateVideoInfo() {
        var t = _el('tagsIAVideoTitle');
        var m = _el('tagsIAVideoMeta');

        if (t) {
            try {
                t.textContent = _getVideoTitle();
            } catch (err) {
                _logError('updateVideoInfo: error título', err);
                t.textContent = 'Video';
            }
        }

        if (m) {
            try {
                var parts = [];
                var subContext = _getSubtitleContext();
                if (subContext && subContext.length > 0) {
                    parts.push('Con transcripción (' + subContext.length + ' chars)');
                } else {
                    parts.push('Sin transcripción');
                }
                m.textContent = parts.join(' · ');
            } catch (err) {
                _logError('updateVideoInfo: error meta', err);
                m.textContent = 'Sin información';
            }
        }
    }

    // ============================================================
    // 22. ESTADÍSTICAS GLOBALES — MEJORADO
    // ============================================================

    function _renderStats() {
        var c = _el('tagsIATopTags');
        if (!c) {
            log.warn('renderStats: contenedor no encontrado');
            return;
        }

        try {
            c.innerHTML = '';

            var counts = {};
            var keys = _cache.keys();

            if (!Array.isArray(keys) || keys.length === 0) {
                c.innerHTML = '<span style="font-size:.74rem;color:#999">Sin datos en caché</span>';
                return;
            }

            for (var k = 0; k < keys.length; k++) {
                try {
                    var tags = _cache.get(keys[k]);
                    if (!Array.isArray(tags)) continue;

                    for (var t = 0; t < tags.length; t++) {
                        if (!tags[t] || !tags[t].value) continue;
                        var l = String(tags[t].value).toLowerCase().trim();
                        if (l.length > 0) {
                            counts[l] = (counts[l] || 0) + 1;
                        }
                    }
                } catch (err) {
                    _logError('renderStats: error procesando tag', err, { key: keys[k] });
                }
            }

            var sorted = Object.keys(counts)
                .map(function (k) { return { l: k, c: counts[k] }; })
                .sort(function (a, b) { return b.c - a.c; })
                .slice(0, 20);

            if (!sorted.length) {
                c.innerHTML = '<span style="font-size:.74rem;color:#999">Sin etiquetas</span>';
                return;
            }

            var frag = document.createDocumentFragment();
            for (var i = 0; i < sorted.length; i++) {
                try {
                    var el = document.createElement('span');
                    el.className = 'tags-ia-top-tag';
                    el.innerHTML = _escHTML(sorted[i].l) + 
                        ' <span class="tags-ia-top-tag-count" title="Apariciones">' + sorted[i].c + '</span>';
                    frag.appendChild(el);
                } catch (err) {
                    _logError('renderStats: error renderizando tag', err, { tag: sorted[i].l });
                }
            }

            c.appendChild(frag);
            log.debug('Estadísticas: ' + sorted.length + ' tags únicos');
        } catch (err) {
            _logError('renderStats: error general', err);
            c.innerHTML = '<span style="font-size:.74rem;color:#f00">Error cargando estadísticas</span>';
        }
    }

    // ============================================================
    // 23. EXPORTAR — MEJORADO
    // ============================================================

    function _export() {
        if (!_s.tags || !Array.isArray(_s.tags) || _s.tags.length === 0) {
            _notif('Sin etiquetas para exportar', 'advertencia');
            return;
        }

        try {
            var title = _getVideoTitle();
            var now = new Date();
            var dateStr = now.toLocaleString();

            var lines = [
                '========================================',
                'ETIQUETAS SEMÁNTICAS — ' + title,
                '========================================',
                'Fecha: ' + dateStr,
                'Total: ' + _s.tags.length + ' etiquetas',
                '',
                'ETIQUETAS:',
                '----------------------------------------',
            ];

            for (var i = 0; i < _s.tags.length; i++) {
                if (_s.tags[i] && _s.tags[i].value) {
                    lines.push((i + 1) + '. ' + _sanitizeTag(_s.tags[i].value));
                }
            }

            lines.push('');
            lines.push('========================================');
            lines.push('Generado por: VP Etiquetas IA v' + CFG.VERSION);
            lines.push('========================================');

            var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');

            a.href = url;
            a.download = 'etiquetas_' + (util.sanitizarNombreArchivo ? 
                util.sanitizarNombreArchivo(util.obtenerNombreBase ? 
                    util.obtenerNombreBase(title) : 
                    title) : 
                title.slice(0, 30).replace(/[^a-z0-9]/gi, '_')) + '_' + Date.now() + '.txt';

            a.style.display = 'none';
            document.body.appendChild(a);

            try {
                a.click();
                _notif('Exportado: ' + a.download, 'exito');
                log.info('Exportado archivo:', a.download);
            } catch (err) {
                _logError('export: error en click', err);
                _notif('Error al descargar', 'error');
            }

            setTimeout(function () {
                try { 
                    if (document.body.contains(a)) document.body.removeChild(a); 
                } catch (_) {}
                try { URL.revokeObjectURL(url); } catch (_) {}
            }, 1500);
        } catch (err) {
            _logError('export: error general', err);
            _notif('Error exportando', 'error');
        }
    }

    // ============================================================
    // 24. MODELOS
    // ============================================================

    function _populateModels(rawUrl) {
        var sel = _el('tagsIAModel');
        if (!sel) return;
        var base = _normalizeUrl(rawUrl);
        if (!_isValidUrl(base)) { sel.innerHTML = '<option value="">URL inválida</option>'; return; }
        sel.innerHTML = '<option value="">Cargando…</option>'; sel.disabled = true;

        // Pequeño delay para evitar que el error se reporte inmediatamente
        setTimeout(function () {
            VP.ollama.fetchModels(base, { timeout: CFG.FETCH_TIMEOUT })
                .then(function (models) {
                    if (!models.length) { sel.innerHTML = '<option value="">Sin modelos</option>'; sel.disabled = false; return; }
                    var frag = document.createDocumentFragment();
                    for (var j = 0; j < models.length; j++) { var o = document.createElement('option'); o.value = models[j]; o.textContent = models[j]; frag.appendChild(o); }
                    sel.innerHTML = ''; sel.appendChild(frag); sel.disabled = false;
                    var saved = util.storageGet(CFG.PREF_MODEL, '');
                    if (saved && models.indexOf(saved) >= 0) sel.value = saved;
                    _updateBadge();
                })
                .catch(function (err) { 
                    sel.innerHTML = '<option value="">Sin conexión</option>'; 
                    sel.disabled = false;
                    // Error manejado silenciosamente
                });
        }, 100);
    }

    function _updateBadge() {
        var b = _el('tagsIAModelBadge'); if (!b) return;
        var m = _el('tagsIAModel');
        var name = m ? m.value : ''; var display = name ? name.split(':')[0] : 'Ollama';
        var svg = b.querySelector('svg'); b.innerHTML = svg ? svg.outerHTML : '';
        b.appendChild(document.createTextNode(display));
    }

    // ============================================================
    // 25. CAMBIO DE VIDEO
    // ============================================================

    function _onVideoChanged() {
        var key = _currentKey();
        if (key === _s.currentVideoKey) return;
        _s.currentVideoKey = key;
        _s.tags = [];

        _loadTags(key).then(function (tags) {
            _s.tags = tags || [];
            _renderModalTags();
            _updateVideoInfo();
        }).catch(function (e) { log.warn('Error cargando tags:', e.message || e); });
    }

    // ============================================================
    // 26. MODAL
    // ============================================================

    function _open() {
        var modal = _el('tagsIAModal'); if (!modal) return;
        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(true);
        var savedUrl = util.storageGet(CFG.PREF_URL, '');
        var urlEl = _el('tagsIAUrl');
        if (savedUrl && urlEl) urlEl.value = savedUrl;
        _populateModels(urlEl ? urlEl.value : '');
        _onVideoChanged();
        _renderStats();
    }

    function _close() {
        var modal = _el('tagsIAModal'); if (!modal) return;
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(false);
    }

    // ============================================================
    // 27. INYECTAR CSS
    // ============================================================

    function _injectCSS() {
        if (_s._cssInjected) return;
        if (document.getElementById('vpTagsGalleryCSS')) { _s._cssInjected = true; return; }

        var css = [
            '.' + CFG.GALLERY_CLS + '{',
            '  position:absolute;bottom:7px;left:4px;',
            '  display:flex;flex-direction:column;gap:2px;z-index:5;pointer-events:none;',
            '}',
            '.' + CFG.GALLERY_CHIP_CLS + '{',
            '  display:inline-block;padding:1px 6px;border-radius:4px;',
            '  font-size:.62rem;font-weight:600;white-space:nowrap;',
            '  max-width:80px;overflow:hidden;text-overflow:ellipsis;',
            '  text-shadow:0 1px 2px rgba(0,0,0,.8);',
            '  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);',
            '  background:rgba(42,42,62,.85);color:#c4a0ff',
            '}',
            '.' + CFG.GALLERY_CHIP_CLS + '.more{background:rgba(0,0,0,.65);color:#fff;font-style:italic}',
            '.thumbnail-container{position:relative}',
        ];

        var style = document.createElement('style');
        style.id = 'vpTagsGalleryCSS';
        style.textContent = css.join('\n');
        document.head.appendChild(style);
        _s._cssInjected = true;
    }

    // ============================================================
    // 28. REGISTRO DE EVENTOS — MEJORADO
    // ============================================================

    function _registerEvents() {
        try {
            _bind('tagsIABtn', _open);
            _bind('tagsIAModalClose', _close);
            _bind('tagsIAGenerateBtn', _generate);
            _bind('tagsIAGenerateAllBtn', function() {
                log.debug('Batch sin subtítulos iniciado');
                _generateBatch(false);
            });
            _bind('tagsIAGenerateAllWithSubsBtn', function() {
                log.debug('Batch con subtítulos iniciado');
                _generateBatch(true);
            });

            _bind('tagsIACancelBtn', function () {
                if (_s.abortController && typeof _s.abortController.abort === 'function') {
                    try {
                        _s.abortController.abort();
                        _s._batchAborted = true;
                        _notif('Cancelando…', 'info');
                        log.info('Cancelación iniciada');
                    } catch (err) {
                        _logError('registerEvents: error cancelando', err);
                    }
                }
            });

            _bind('tagsIAClearBtn', function () {
                if (!_s.tags || !_s.tags.length) {
                    _notif('Sin etiquetas para eliminar', 'info');
                    return;
                }
                try {
                    var confirmed = window.confirm('¿Eliminar todas las etiquetas del video actual?');
                    if (confirmed) {
                        _clearTags();
                        _notif('Etiquetas eliminadas', 'info');
                        log.info('Etiquetas eliminadas manualmente');
                    }
                } catch (err) {
                    _logError('registerEvents: error clear', err);
                }
            });

            _bind('tagsIAExportBtn', function () {
                log.debug('Exportación iniciada');
                _export();
            });

            _bind('tagsIARefreshBtn', function () {
                var urlEl = _el('tagsIAUrl');
                var url = urlEl ? urlEl.value : '';
                log.debug('Refresh de modelos desde:', url);
                _populateModels(url);
            });

            _bind('tagsIAAddBtn', function () {
                var inp = _el('tagsIAManualInput');
                if (inp && inp.value) {
                    _addTag('tag', inp.value);
                    inp.value = '';
                    inp.focus();
                }
            });

            // Enter en input manual
            var inp = _el('tagsIAManualInput');
            if (inp) {
                _addTracked(inp, 'keydown', function (e) {
                    if (e.key === 'Enter' || e.keyCode === 13) {
                        e.preventDefault();
                        _addTag('tag', inp.value);
                        inp.value = '';
                    }
                }, _s._docListeners);
            }

            // Click en fondo del modal
            var modal = _el('tagsIAModal');
            if (modal) {
                _addTracked(modal, 'click', function (e) {
                    if (e.target === modal) {
                        _close();
                    }
                }, _s._docListeners);
            }

            // ESC para cerrar modal (centralizado en vp-eventos.js)
            if (typeof VP.eventos.registrarModalIA === 'function') {
                VP.eventos.registrarModalIA('tagsIAModal', _close);
            }

            // Input URL con debounce
            var urlInput = _el('tagsIAUrl');
            if (urlInput) {
                var deb = util.debounce ? util.debounce(function () {
                    var v = _normalizeUrl(urlInput.value);
                    if (_isValidUrl(v)) {
                        log.debug('URL validada, recargando modelos');
                        _populateModels(v);
                    }
                }, 900) : null;

                if (deb) {
                    _addTracked(urlInput, 'input', deb, _s._docListeners);
                }
            }

            // Cambio de modelo
            var modelSel = _el('tagsIAModel');
            if (modelSel) {
                _addTracked(modelSel, 'change', function () {
                    try {
                        util.storageSet(CFG.PREF_MODEL, modelSel.value);
                        _updateBadge();
                        log.debug('Modelo guardado:', modelSel.value);
                    } catch (err) {
                        _logError('registerEvents: error guardando modelo', err);
                    }
                }, _s._docListeners);
            }

            log.info('Eventos registrados exitosamente');
        } catch (err) {
            _logError('registerEvents: error general', err);
        }

        // Bus Events
        _registerBusEvents();
    }

    function _registerBusEvents() {
        if (!bus) return;

        try {
            function _onGaleriaRenderizada() {
                _scheduleApplyAllToGallery(150);
            }

            function _onBatchRenderComplete() {
                _scheduleApplyAllToGallery(200);
            }

            function _onVideosCargados() {
                _s._timers.push(setTimeout(function () {
                    log.debug('Videos cargados, precargando etiquetas');
                    _preloadAll();
                }, 400));
            }

            function _onVideosParcialesCargados() {
                _scheduleApplyAllToGallery(300);
            }

            function _onPlaylistCambiada() {
                _scheduleApplyAllToGallery(500);
            }

            function _onCacheVaciada() {
                log.info('Cache vaciado, limpiando etiquetas IA');
                _cache.clear();
                _s.tags = [];

                try { VP.db.eliminarKeyVal(CFG.LS_INDEX_KEY); } catch (_) {}
                _index._data = {};

                try {
                    var kvKeys = VP.db.clavesKeyVal();
                    for (var lk = 0; lk < kvKeys.length; lk++) {
                        if (kvKeys[lk] === CFG.LS_INDEX_KEY) continue;
                        if (kvKeys[lk].indexOf(CFG.STORAGE_PREFIX) !== -1) {
                            VP.db.eliminarKeyVal(kvKeys[lk]);
                        }
                    }
                } catch (err) {
                    _logError('_onCacheVaciada: error keyval', err);
                }

                try {
                    var overlays = document.querySelectorAll('.' + CFG.GALLERY_CLS);
                    for (var o = 0; o < overlays.length; o++) {
                        var p = overlays[o].parentNode;
                        if (p) p.removeChild(overlays[o]);
                    }
                } catch (err) {
                    _logError('_onCacheVaciada: error DOM', err);
                }

                var arrs = [VP.estado && VP.estado.videos, VP.estado && VP.estado.playlist];
                for (var a = 0; a < arrs.length; a++) {
                    if (!Array.isArray(arrs[a])) continue;
                    for (var v = 0; v < arrs[a].length; v++) {
                        if (arrs[a][v]) arrs[a][v]._tagsIA = null;
                    }
                }

                _renderModalTags();
            }

            function _onReset() {
                log.info('Reset del sistema');
                _cache.clear();
                _s.tags = [];
                _s.currentVideoKey = '';
                _renderModalTags();
            }

            function _onInitialized() {
                _s._timers.push(setTimeout(function () {
                    log.debug('Sistema inicializado, precargando');
                    _preloadAll();
                    _startGalleryObserver();
                }, CFG.PRELOAD_DELAY));
            }

            var evts = [
                ['videoCambiado', _onVideoChanged],
                ['videoReproduciendo', _onVideoChanged],
                ['galeriaRenderizada', _onGaleriaRenderizada],
                ['batchRenderComplete', _onBatchRenderComplete],
                ['videosCargados', _onVideosCargados],
                ['videosParcialesCargados', _onVideosParcialesCargados],
                ['playlistCambiada', _onPlaylistCambiada],
                ['cacheVaciada', _onCacheVaciada],
                ['reset', _onReset],
                ['initialized', _onInitialized],
                ['subtitulosCargados', _updateVideoInfo],
            ];

            for (var i = 0; i < evts.length; i++) {
                try {
                    bus.on(evts[i][0], evts[i][1]);
                    _s._busListeners.push({ event: evts[i][0], handler: evts[i][1] });
                } catch (err) {
                    _logError('registerBusEvents: error registrando ' + evts[i][0], err);
                }
            }

            log.debug('Bus events registrados:', evts.length);
        } catch (err) {
            _logError('registerBusEvents: error general', err);
        }
    }

    function _bind(id, fn) {
        var el = _el(id);
        if (el) _addTracked(el, 'click', fn, _s._docListeners);
    }

    // ============================================================
    // 29. DESTRUIR — MEJORADO
    // ============================================================

    function _destroy() {
        log.info('Destruyendo módulo etiquetas IA');

        try {
            if (_s.abortController && typeof _s.abortController.abort === 'function') {
                _s.abortController.abort();
            }
        } catch (err) {
            _logError('destroy: error abortando controller', err);
        }

        try { clearTimeout(_s._retryTimer); } catch (_) {}
        try { clearTimeout(_s._observerTimer); } catch (_) {}
        try { clearTimeout(_s._galleryApplyTimer); } catch (_) {}
        try { clearTimeout(_s._galleryItemTimer); } catch (_) {}
        _s._galleryApplyTimer = null;
        _s._galleryItemTimer = null;
        _s._pendingGalleryItems.clear();

        for (var t = 0; t < _s._timers.length; t++) {
            try { clearTimeout(_s._timers[t]); } catch (_) {}
        }
        _s._timers.length = 0;

        try { _stopGalleryObserver(); } catch (err) {
            _logError('destroy: error deteniendo observer', err);
        }

        try { _removeTracked(_s._docListeners); } catch (err) {
            _logError('destroy: error removiendo listeners DOM', err);
        }

        if (bus) {
            for (var i = 0; i < _s._busListeners.length; i++) {
                try {
                    if (_s._busListeners[i] && _s._busListeners[i].event && _s._busListeners[i].handler) {
                        bus.off(_s._busListeners[i].event, _s._busListeners[i].handler);
                    }
                } catch (err) {
                    _logError('destroy: error removiendo bus listener', err, {
                        event: _s._busListeners[i].event
                    });
                }
            }
        }
        _s._busListeners.length = 0;

        _s._initialized = false;

        try {
            var css = document.getElementById('vpTagsGalleryCSS');
            if (css && css.parentNode) {
                css.parentNode.removeChild(css);
            }
        } catch (err) {
            _logError('destroy: error removiendo CSS', err);
        }

        _s._cssInjected = false;
        _cache.clear();
        _s.tags = [];
        _s.currentVideoKey = '';
        _s._errorLog.length = 0;

        log.info('Módulo etiquetas IA destruido completamente');
    }

    // ============================================================
    // 30. API PÚBLICA — MEJORADA
    // ============================================================

    VP.etiquetasIA = {
        open            : _open,
        close           : _close,
        generate        : _generate,
        generateAll     : function() { _generateBatch(false); },
        generateAllWithSubtitles: function() { _generateBatch(true); },
        addTag          : _addTag,
        removeTag       : _removeTag,
        clearTags       : _clearTags,
        getTags         : function () { return _s.tags.slice(); },
        getTagsForVideo : function (name) {
            if (!name) return [];
            var c = _cache.get(name);
            return c ? c.slice() : [];
        },
        renderInGallery : _applyAllToGallery,
        preloadAll      : _preloadAll,
        exportar        : _export,
        destroy         : _destroy,
        obtenerMetricas : function () {
            return {
                tags: _s.tags.length,
                generating: _s.isGenerating,
                key: _s.currentVideoKey,
                cache: _cache.size(),
                preloaded: _s._preloaded,
                indexSize: _index.getAll().length,
                observerActive: !!_s._galleryObserver,
                stats: _getStats(),
                version: CFG.VERSION,
            };
        },
        getErrorLog: function() {
            return _getErrorLog();
        },
        clearErrorLog: function() {
            _s._errorLog.length = 0;
        },
        getCacheSize: function() {
            return _cache.size();
        },
        getCacheKeys: function() {
            return _cache.keys();
        },
        getCacheAll: function() {
            return _cache.all();
        },
        validateTags: function(tags) {
            if (!Array.isArray(tags)) return [];
            return _filterValidTags(tags);
        },
        sanitizeTag: function(val) {
            return _sanitizeTag(val);
        },
        abortGeneration: function() {
            if (_s.abortController && typeof _s.abortController.abort === 'function') {
                _s.abortController.abort();
                _s._batchAborted = true;
                return true;
            }
            return false;
        },
        getLoadedVideos: function() {
            return _index.getAll();
        },
        hasTagsFor: function(videoName) {
            if (!videoName) return false;
            return _cache.has(videoName) || _index.has(videoName);
        },
        reloadTagsForVideo: function(videoName) {
            if (!videoName) return Promise.resolve([]);
            _cache.del(videoName);
            return _loadTags(videoName);
        },
        version: CFG.VERSION,
    };

    window.VP_EtiquetasIA = VP.etiquetasIA;

    // ============================================================
    // 31. INICIALIZACIÓN — MEJORADA
    // ============================================================

    function _init() {
        if (_s._initialized) {
            log.warn('Ya inicializado, omitiendo');
            return;
        }

        log.info('Iniciando vp-etiquetas-ia v' + CFG.VERSION);
        _s._initialized = true;

        try {
            _injectCSS();
        } catch (err) {
            _logError('_init: error inyectando CSS', err);
        }

        try {
            _registerEvents();
        } catch (err) {
            _logError('_init: error registrando eventos', err);
        }

        _s.currentVideoKey = _currentKey();

        if (_s.currentVideoKey) {
            _loadTags(_s.currentVideoKey)
                .then(function (t) {
                    _s.tags = t || [];
                    _renderModalTags();
                    log.debug('Tags cargados al iniciar para:', _s.currentVideoKey);
                })
                .catch(function (err) {
                    _logError('_init: error cargando tags', err);
                });
        }

        try {
            _preloadAll();
        } catch (err) {
            _logError('_init: error preload', err);
        }

        // Intentar iniciar observer galería
        var obsAttempt = 0;
        function tryObserver() {
            var g = VP.refs && VP.refs.galleryEl;
            if (g && !dom.esNulo(g)) {
                try {
                    _startGalleryObserver();
                    _applyAllToGallery();
                    log.info('Gallery observer iniciado exitosamente');
                } catch (err) {
                    _logError('_init: error iniciando observer', err);
                }
                return;
            }

            if (++obsAttempt < 20) {
                setTimeout(tryObserver, 500);
            } else {
                log.warn('No se pudo iniciar gallery observer después de 20 intentos');
            }
        }

        setTimeout(tryObserver, 300);

        log.info('✓ vp-etiquetas-ia v' + CFG.VERSION +
            ' | index: ' + _index.getAll().length +
            ' | cache: ' + _cache.size());
    }

    function _waitForVP() {
        var done = false;
        var att = 0;

        function tryInit() {
            if (done) return;
            done = true;
            try {
                _init();
            } catch (err) {
                _logError('_waitForVP: error en init', err);
            }
        }

        function poll() {
            if (done) return;

            if (++att > 200) {
                log.warn('Timeout esperando VP, inicializando igual');
                tryInit();
                return;
            }

            if (VP.log && VP.bus && VP.dom && VP.util && VP.ollama) {
                tryInit();
                return;
            }

            setTimeout(poll, 25);
        }

        try {
            document.addEventListener('vpReady', tryInit);
        } catch (err) {
            log.warn('No se pudo agregar listener vpReady', err);
        }

        poll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _waitForVP);
    } else {
        _waitForVP();
    }

    log.info('✓ vp-etiquetas-ia.js v' + CFG.VERSION + ' cargado y registrado');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-etiquetas-ia.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
