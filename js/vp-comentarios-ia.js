'use strict';

// ============================================================
// VP-COMENTARIOS-IA.JS  —  v2.4.0
// Compatible con vp-flotante-ia.js
// ============================================================

(function (window, document) {
    if (window.__VP_COMENTARIOS_IA_LOADED__) return;
    window.__VP_COMENTARIOS_IA_LOADED__ = true;

    var VP = window.VP;
    if (!VP) { console.error('[VP] vp-comentarios-ia.js: VP no existe.'); throw new Error('[VP] requiere vp-base.js'); }

    var util = VP.util, dom = VP.dom, log = VP.log, bus = VP.bus;
    if (!util || !dom || !log || !bus) { throw new Error('[VP] vp-comentarios-ia.js: dependencias faltantes'); }
    log.setContext('ComentariosIA');

    log.info('Dependencias OK. v2.4.0');

    // ============================================================
    // CONSTANTES
    // ============================================================

    var VERSION = '2.4.0';

    var CFG = Object.freeze({
        DEFAULT_URL            : 'http://localhost:11434',
        CHAT_ENDPOINT          : '/api/chat',
        MODELS_ENDPOINT        : '/api/tags',
        FETCH_TIMEOUT          : 15000,

        BLOCK_SIZE             : 10,
        MAX_RETRIES            : 3,
        RETRY_DELAY            : 2000,

        STORAGE_PREFIX         : 'vpCommentIA_',
        PREF_MODEL             : 'commentIA_model',
        PREF_URL               : 'vp_ollama_url',
        PREF_STYLE             : 'commentIA_style',
        PREF_LANG              : 'vp_ia_language',
        PREF_VISIBLE           : 'commentIA_visible',
        PREF_PROMPT            : 'commentIA_prompt',

        DISPLAY_DURATION       : 6,
        OVERLAY_ID             : 'commentaryIAOverlay',
        OVERLAY_STYLE_ID       : 'commentaryIAOverlayStyles',

        // ── ID del modal — debe coincidir con WINDOW_IDS en vp-flotante-ia.js
        // vp-flotante-ia.js usa: { id: 'commentsIAModal', key: 'comments' }
        MODAL_ID               : 'commentsIAModal',

        LLM_TEMPERATURE        : 0.25,
        LLM_NUM_PREDICT        : 1200,
        INTER_BLOCK_DELAY      : 300,
        DEBUG_RAW_LIMIT        : 300,

        TIMEUPDATE_THROTTLE_MS : 250,
        TIME_EPSILON           : 0.15,
    });

    // ── Mapeo de idiomas ────────────────────────────────────────
    var LANG_MAP = {
        'español'    : 'Spanish',
        'english'    : 'English',
        'ingles'     : 'English',
        'frances'    : 'French',
        'aleman'     : 'German',
        'italiano'   : 'Italian',
        'portugues'  : 'Portuguese',
        'japones'    : 'Japanese',
        'chino'      : 'Chinese',
        'coreano'    : 'Korean',
        'ruso'       : 'Russian',
        'arabe'      : 'Arabic',
    };

    // ── ESTILOS — congelados en profundidad ────────────────────
    var ESTILOS = (function () {
        var raw = {
            curiosidades : { icon: '🧠', label: 'Curiosities',   prompt: 'Generate curious facts and "did you know" trivia directly related to the subtitle content.' },
            historia     : { icon: '📜', label: 'History',        prompt: 'Provide historical context, relevant dates and background for what is mentioned.' },
            educativo    : { icon: '🎓', label: 'Educational',    prompt: 'Explain concepts, define technical terms and expand information educationally.' },
            humor        : { icon: '😄', label: 'Humor',          prompt: 'Add light-hearted observations, funny analogies and witty remarks.' },
            critica      : { icon: '🎬', label: 'Film Critique',  prompt: 'Comment as a film critic on narrative techniques, cinematography, acting and direction.' },
            tecnico      : { icon: '⚙️', label: 'Technical',      prompt: 'Analyze technical aspects: methodologies, tools, implementations, specifications.' },
            trivia       : { icon: '🎯', label: 'Trivia',         prompt: 'Generate trivia questions and "Did you know?" facts about each topic mentioned.' },
            cultural     : { icon: '🌍', label: 'Cultural',       prompt: 'Identify and explain cultural, artistic, literary and social references.' },
            custom       : { icon: '✏️', label: 'Custom',         prompt: '' },
        };
        var frozen = {};
        for (var k in raw) {
            if (raw.hasOwnProperty(k)) frozen[k] = Object.freeze(raw[k]);
        }
        return Object.freeze(frozen);
    })();

    // ============================================================
    // ESTADO
    // ============================================================

    var _s = {
        isProcessing      : false,
        isActive          : false,
        isVisible         : true,
        abortController   : null,
        commentaryCues    : [],
        currentVideoKey   : '',
        currentCueIndex   : -1,
        overlayEl         : null,
        _currentGenToken  : 0,       // ← token para invalidar callbacks obsoletos

        _videoEl           : null,
        _timeupdateHandler : null,
        _lastKnownTime     : -1,
        _lastThrottleTs    : 0,

        trackBlobUrl      : null,

        stats : {
            totalBlocks    : 0,
            processedBlocks: 0,
            failedBlocks   : 0,
            totalCues      : 0,
            generatedCues  : 0,
            parseErrors    : 0,
            langMismatches : 0,
            startTime      : 0,
            endTime        : 0,
        },

        _docListeners  : [],
        _busListeners  : [],
        _initialized   : false,
    };

    // ============================================================
    // UTILIDADES BÁSICAS
    // ============================================================

    function _el(id) { return document.getElementById(id); }

    function _setDisplay(id, val) { var e = _el(id); if (e) e.style.display = val; }

    function _addTracked(target, event, handler, store) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(event, handler);
        (store || _s._docListeners).push({ target: target, event: event, handler: handler });
    }

    function _removeTracked(store) {
        var n = 0;
        for (var i = 0; i < store.length; i++) {
            try {
                store[i].target.removeEventListener(store[i].event, store[i].handler);
                n++;
            } catch (e) {}
        }
        store.length = 0;
        log.info('Listeners removidos:', n);
    }

    function _notif(msg, tipo) {
        try {
            if (VP.ui && typeof VP.ui.mostrarNotificacion === 'function') {
                VP.ui.mostrarNotificacion(msg, tipo || 'info');
            }
        } catch (e) {
            log.warn('_notif error:', e.message, '| msg:', msg);
        }
    }

    function _fmtTime(s) {
        s = Number(s);
        if (!isFinite(s) || s < 0) return '0:00';
        var h  = Math.floor(s / 3600);
        var m  = Math.floor((s % 3600) / 60);
        var sc = Math.floor(s % 60);
        var p  = function (n) { return n < 10 ? '0' + n : String(n); };
        return h > 0 ? h + ':' + p(m) + ':' + p(sc) : m + ':' + p(sc);
    }

    function _tsVtt(s) {
        if (!isFinite(s) || s < 0) s = 0;
        var h  = Math.floor(s / 3600);
        var m  = Math.floor((s % 3600) / 60);
        var sc = Math.floor(s % 60);
        var ms = Math.round((s % 1) * 1000);
        var p2 = function (n) { return n < 10 ? '0' + n : String(n); };
        var p3 = function (n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : String(n)); };
        return p2(h) + ':' + p2(m) + ':' + p2(sc) + '.' + p3(ms);
    }

    // ── SRT — coma en lugar de punto (función dedicada) ────────
    function _tsSrt(s) {
        if (!isFinite(s) || s < 0) s = 0;
        var h  = Math.floor(s / 3600);
        var m  = Math.floor((s % 3600) / 60);
        var sc = Math.floor(s % 60);
        var ms = Math.round((s % 1) * 1000);
        var p2 = function (n) { return n < 10 ? '0' + n : String(n); };
        var p3 = function (n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : String(n)); };
        return p2(h) + ':' + p2(m) + ':' + p2(sc) + ',' + p3(ms);
    }

    function _normalizeUrl(raw) {
        var u = (typeof raw === 'string' ? raw : '').trim();
        if (!u) return CFG.DEFAULT_URL;
        if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
        return u.replace(/\/+$/, '');
    }

    function _isValidUrl(s) {
        if (!s) return false;
        try { new URL(s.trim()); return true; } catch (_) { return false; }
    }

    function _isFileProtocol() { return window.location.protocol === 'file:'; }

    function _videoKey() {
        var ci = VP.estado && VP.estado.currentVideoIndex;
        var pl = VP.estado && VP.estado.playlist;
        if (typeof ci === 'number' && ci >= 0 && pl && pl[ci]) {
            return pl[ci].name || String(pl[ci].id || '');
        }
        return '';
    }

function _getCues() {
    // Primero intentar obtener de window.vpSubtitleCues (establecido por vp-subtitulos.js)
    var cues = window.vpSubtitleCues;
    if (Array.isArray(cues) && cues.length > 0) {
        return cues;
    } else {
        // Si no hay cues globales, verificar directamente en el reproductor
        try {
            var video = VP.refs && VP.refs.videoPlayer;
            if (video && !dom.esNulo(video)) {
                var tracks = video.textTracks;
                if (tracks && tracks.length > 0) {
                    for (var i = 0; i < tracks.length; i++) {
                        var track = tracks[i];
                        // Solo considerar pistas de subtítulos que estén cargadas
                         if (track.kind === 'subtitles' && track.cues && track.cues.length > 0) {
                             // Devolver todas las cues disponibles
                             return track.cues;
                        }
                    }
                }
            }
        } catch (_) {}
        return [];
    }
}

    function _getStyle() {
        var e = _el('commentaryIAStyle');
        return (e && e.value) ? e.value : 'curiosidades';
    }

    function _getStyleIcon() {
        return (ESTILOS[_getStyle()] || ESTILOS.curiosidades).icon;
    }

    function _resolveLang(rawLang) {
        var lower = (rawLang || 'español').toLowerCase().trim()
            .replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i')
            .replace(/ó/g,'o').replace(/ú/g,'u').replace(/ñ/g,'n');

        for (var key in LANG_MAP) {
            if (LANG_MAP.hasOwnProperty(key) && lower.indexOf(key) !== -1) {
                return { en: LANG_MAP[key], raw: rawLang };
            }
        }
        return { en: rawLang, raw: rawLang };
    }

    function _resetStats() {
        _s.stats = {
            totalBlocks: 0, processedBlocks: 0, failedBlocks: 0,
            totalCues: 0, generatedCues: 0, parseErrors: 0,
            langMismatches: 0, startTime: Date.now(), endTime: 0,
        };
    }

    // ── Vaciado seguro de contenedor ───────────────────────────
    function _clearList(container) {
        if (!container) return;
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }
    }

    // ── Escapar caracteres especiales de RegExp ────────────────
    function _escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ============================================================
    // TIMEUPDATE OPTIMIZADO
    // ============================================================

    function _unbindTimeUpdate() {
        if (_s._videoEl && _s._timeupdateHandler) {
            try {
                _s._videoEl.removeEventListener('timeupdate', _s._timeupdateHandler);
            } catch (e) {
                log.warn('Error desenlazando timeupdate:', e.message);
            }
            log.info('timeupdate desenlazado');
        }
        _s._videoEl = null;
        _s._timeupdateHandler = null;
        _s._lastKnownTime = -1;
        _s._lastThrottleTs = 0;
    }

    function _bindTimeUpdate() {
        // No mantener un listener de reproducción cuando no hay nada que mostrar.
        // Se vuelve a enlazar al activar comentarios para el video actual.
        if (!_s.isActive || !_s.commentaryCues.length) {
            _unbindTimeUpdate();
            return;
        }
        var video = VP.refs && VP.refs.videoPlayer;
        if (!video || dom.esNulo(video)) {
            log.warn('_bindTimeUpdate: no hay videoPlayer');
            return;
        }
        if (_s._videoEl === video && _s._timeupdateHandler) {
            log.debug('timeupdate ya enlazado al mismo video');
            return;
        }

        _unbindTimeUpdate();
        log.info('Registrando timeupdate. Throttle:', CFG.TIMEUPDATE_THROTTLE_MS + 'ms');

        var handler = function () {
            if (!_s.isActive || !_s.commentaryCues.length) return;

            var now = Date.now();
            if (now - _s._lastThrottleTs < CFG.TIMEUPDATE_THROTTLE_MS) return;
            _s._lastThrottleTs = now;

            var ct = video.currentTime;
            if (Math.abs(ct - _s._lastKnownTime) < CFG.TIME_EPSILON) return;
            _s._lastKnownTime = ct;

            var found = _findActiveCue(_s.commentaryCues, ct);
            if (found === _s.currentCueIndex) return;
            _s.currentCueIndex = found;

            if (found >= 0) {
                var cue = _s.commentaryCues[found];
                _showOverlayText(cue.comment, cue.icon);
                _highlightEntry(found);
                log.debug('Cue', found, '|',
                    _fmtTime(cue.start), '->', _fmtTime(cue.end));
            } else {
                _hideOverlay();
                _clearHighlight();
            }
        };

        video.addEventListener('timeupdate', handler);
        _s._videoEl = video;
        _s._timeupdateHandler = handler;
        _s._lastKnownTime = -1;
        _s._lastThrottleTs = 0;
        log.info('timeupdate OK');
    }

    // ── Búsqueda binaria con borde >= corregido ────────────────
    function _findActiveCue(cues, ct) {
        var lo = 0, hi = cues.length - 1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if      (ct <  cues[mid].start) hi = mid - 1;
            else if (ct >= cues[mid].end)   lo = mid + 1;
            else                            return mid;
        }
        return -1;
    }

    // ── Validar y corregir cues solapados ─────────────────────
    function _validateCues(cues) {
        for (var i = 1; i < cues.length; i++) {
            if (cues[i].start < cues[i - 1].end) {
                log.warn('Cues solapados en índice', i,
                    _fmtTime(cues[i - 1].start), '->', _fmtTime(cues[i].start));
                cues[i - 1].end = cues[i].start;
            }
        }
        return cues;
    }

    // ── Cache de entries ───────────────────────────────────────
    var _cachedEntries   = null;
    var _lastHighlighted = -1;

    function _highlightEntry(index) {
        var list = _el('commentaryIAList');
        if (!list) return;

        if (!_cachedEntries) {
            _cachedEntries = Array.prototype.slice.call(
                list.querySelectorAll('.commentary-ia-entry')
            );
        }

        if (_lastHighlighted >= 0 && _cachedEntries[_lastHighlighted]) {
            _cachedEntries[_lastHighlighted].style.outline = '';
        }
        if (index >= 0 && _cachedEntries[index]) {
            _cachedEntries[index].style.outline = '2px solid var(--yt-red, #ff0033)';
            try {
                _cachedEntries[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } catch (_) {}
        }
        _lastHighlighted = index;
    }

    function _clearHighlight() {
        if (_lastHighlighted >= 0 && _cachedEntries && _cachedEntries[_lastHighlighted]) {
            _cachedEntries[_lastHighlighted].style.outline = '';
        }
        _lastHighlighted = -1;
    }

    // ============================================================
    // OVERLAY DOM
    // ============================================================

    function _injectOverlayStyles() {
        if (document.getElementById(CFG.OVERLAY_STYLE_ID)) return;
        var css = [
            '#' + CFG.OVERLAY_ID + '{position:absolute;bottom:72px;left:50%;transform:translateX(-50%);',
            'z-index:2147483640;max-width:88%;width:max-content;text-align:center;pointer-events:none;',
            'transition:opacity .3s ease,visibility .3s ease;opacity:1;visibility:visible;}',
            '#' + CFG.OVERLAY_ID + '.cia-hidden{opacity:0!important;visibility:hidden!important;}',
            '.cia-sub-text{display:inline-block;max-width:100%;background:rgba(0,0,0,.82);color:#ffff00;',
            'font-size:clamp(11px,1.8vw,16px);font-family:Arial,Helvetica,sans-serif;font-weight:700;',
            'padding:5px 14px 6px 12px;border-radius:3px;line-height:1.5;word-break:break-word;',
            'text-shadow:1px 1px 2px rgba(0,0,0,.9);box-shadow:0 2px 6px rgba(0,0,0,.5);border-left:3px solid #ffff00;}',
            '.cia-icon{margin-right:5px;}',
        ].join('\n');
        var st = document.createElement('style');
        st.id = CFG.OVERLAY_STYLE_ID;
        st.textContent = css;
        document.head.appendChild(st);
        log.info('Estilos overlay inyectados');
    }

    function _getVideoWrap() {
        var wrap = VP.refs && VP.refs.videoPlayerWrap;
        if (wrap && !dom.esNulo(wrap)) return wrap;
        var video = VP.refs && VP.refs.videoPlayer;
        if (video && !dom.esNulo(video) && video.parentNode) return video.parentNode;
        var sels = ['.video-player-wrap', '.player-wrap', '#videoPlayerWrap', '#player'];
        for (var i = 0; i < sels.length; i++) {
            var f = document.querySelector(sels[i]);
            if (f) return f;
        }
        return document.body;
    }

    function _ensureOverlay() {
        var ex = document.getElementById(CFG.OVERLAY_ID);
        if (ex) { _s.overlayEl = ex; return ex; }
        _injectOverlayStyles();
        var wrap = _getVideoWrap();
        if (window.getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
        var ov = document.createElement('div');
        ov.id = CFG.OVERLAY_ID;
        ov.setAttribute('role', 'status');
        ov.setAttribute('aria-live', 'polite');
        ov.className = 'cia-hidden';
        var sp = document.createElement('span');
        sp.className = 'cia-sub-text';
        ov.appendChild(sp);
        wrap.appendChild(ov);
        _s.overlayEl = ov;
        log.info('Overlay creado en:',
            wrap.id || wrap.className || wrap.tagName);
        return ov;
    }

    var _overlaySpan = null;

    function _showOverlayText(text, icon) {
        if (!text) { _hideOverlay(); return; }
        if (!_s.isVisible) return;
        var ov = _ensureOverlay();
        if (!ov) return;
        if (!_overlaySpan || !ov.contains(_overlaySpan)) {
            _overlaySpan = ov.querySelector('.cia-sub-text');
        }
        if (_overlaySpan) {
            while (_overlaySpan.firstChild) _overlaySpan.removeChild(_overlaySpan.firstChild);
            var ic = document.createElement('span');
            ic.className = 'cia-icon';
            ic.textContent = icon || '🧠';
            _overlaySpan.appendChild(ic);
            _overlaySpan.appendChild(document.createTextNode(text));
        }
        ov.classList.remove('cia-hidden');
    }

    function _hideOverlay() {
        if (_s.overlayEl) _s.overlayEl.classList.add('cia-hidden');
    }

    // ============================================================
    // PARSER JSON — 4 ESTRATEGIAS EN CASCADA
    // ============================================================

    function _fixUnescapedControlChars(str) {
        var out = '', inStr = false, escaped = false, fixes = 0;
        for (var i = 0; i < str.length; i++) {
            var ch = str[i];
            if (escaped) { out += ch; escaped = false; continue; }
            if (ch === '\\') { escaped = true; out += ch; continue; }
            if (ch === '"') { inStr = !inStr; out += ch; continue; }
            if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) {
                out += ' '; fixes++; continue;
            }
            out += ch;
        }
        if (fixes > 0) log.info('[Parser] Chars de control corregidos:', fixes);
        return out;
    }

    function _extractStr(obj) {
        if (!obj) return '';
        if (typeof obj === 'string') return obj.trim();
        var v = obj.comment || obj.c || obj.text || obj.t || obj.response || obj.comentario || '';
        return (typeof v === 'string' ? v : String(v)).trim();
    }

    function _isEmptyComment(c) {
        if (!c) return true;
        var s = c.trim();
        return s === '' || s === '-' || s === '--' || s === '—' ||
               s === 'N/A' || s === 'n/a' || s === 'null' || s.length < 3;
    }

    function _cleanComment(c) {
        return c
            .replace(/^<think>[\s\S]*?<\/think>\s*/i, '')
            .replace(/^["'`\s]+|["'`\s]+$/g, '')
            .replace(/\\n/g, ' ').replace(/\\t/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .replace(/^\d+\.\s*/, '')
            .trim();
    }

    function _findInParsed(parsed, idx) {
        for (var j = 0; j < parsed.length; j++) {
            if (parsed[j] && Number(parsed[j].idx) === idx) return _extractStr(parsed[j]);
        }
        if (parsed[idx]) return _extractStr(parsed[idx]);
        return null;
    }

    function _preprocess(raw) {
        var s = raw;
        s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        s = s.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        s = s.replace(/^[^[{]*([\[{])/m, '$1');
        log.info('[Parser] Tras preprocess, primeros 200 chars:', s.slice(0, 200));
        return s;
    }

    function _strategy1(raw) {
        var s = _preprocess(raw);
        var si = s.indexOf('['), ei = s.lastIndexOf(']');
        if (si === -1 || ei === -1 || ei < si) throw new Error('No [ ] encontrado');
        s = s.slice(si, ei + 1);
        s = s.replace(/\u201C|\u201D|\u201E|\u201F|\u2033|\u2036/g, '"')
             .replace(/\u2018|\u2019|\u201A|\u201B|\u2032|\u2035/g, "'");
        s = _fixUnescapedControlChars(s);
        s = s.replace(/,(\s*[}\]])/g, '$1');
        s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
        if (s.indexOf('"') === -1 && s.indexOf("'") !== -1) s = s.replace(/'/g, '"');
        var parsed = JSON.parse(s);
        if (!Array.isArray(parsed)) throw new Error('No es array');
        log.info('[Parser] S1 OK. Items:', parsed.length);
        return parsed;
    }

    function _strategy2(raw) {
        var s = _preprocess(raw);
        var fields = ['comment', 'c', 'text', 't', 'response', 'comentario'];
        var best = [];
        for (var fi = 0; fi < fields.length; fi++) {
            // ← _escapeRegex aplicado al field
            var rx = new RegExp(
                '\\{[^{}]*"idx"\\s*:\\s*(\\d+)[^{}]*"' + _escapeRegex(fields[fi]) +
                '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"[^{}]*\\}', 'g'
            );
            var found = [], m;
            rx.lastIndex = 0;
            while ((m = rx.exec(s)) !== null) {
                found.push({ idx: parseInt(m[1], 10), comment: m[2] });
            }
            if (found.length > best.length) best = found;
        }

        var noIdx = [], rx2 = /"comment"\s*:\s*"((?:[^"\\]|\\.)*)"/g, m2;
        rx2.lastIndex = 0;
        while ((m2 = rx2.exec(s)) !== null) {
            noIdx.push({ idx: noIdx.length, comment: m2[1] });
        }
        if (noIdx.length > best.length) best = noIdx;

        if (!best.length) {
            var soloRx = /"comment"\s*:\s*"((?:[^"\\]|\\.)*)"/ ;
            var soloM  = soloRx.exec(s);
            if (soloM) best = [{ idx: 0, comment: soloM[1] }];
        }

        if (!best.length) throw new Error('S2: ningun objeto encontrado');
        log.info('[Parser] S2 OK. Items:', best.length);
        return best;
    }

    function _strategy3(raw) {
        var s = _preprocess(raw);
        var chunks = [], depth = 0, start = -1, inStr = false, escaped = false;
        for (var i = 0; i < s.length; i++) {
            var ch = s[i];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') { if (depth === 0) start = i; depth++; }
            else if (ch === '}') {
                depth--;
                if (depth === 0 && start !== -1) { chunks.push(s.slice(start, i + 1)); start = -1; }
            }
        }
        var results = [];
        for (var j = 0; j < chunks.length; j++) {
            try {
                var c = chunks[j]
                    .replace(/\u201C|\u201D/g, '"')
                    .replace(/,(\s*[}])/g, '$1')
                    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
                c = _fixUnescapedControlChars(c);
                var obj = JSON.parse(c);
                if (obj && typeof obj === 'object') {
                    if (typeof obj.idx === 'undefined') obj.idx = results.length;
                    results.push(obj);
                }
            } catch (_) {}
        }
        if (!results.length) throw new Error('S3: sin chunks parseables');
        log.info('[Parser] S3 OK. Items:', results.length);
        return results;
    }

    function _strategy4(raw, expectedCount) {
        var s = _preprocess(raw);
        var clean = s
            .replace(/^\s*\d+[\.\)]\s*/gm, '')
            .replace(/^\s*[-*•]\s*/gm, '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\{[^}]*\}/g, '');
        var lines = clean.split('\n')
            .map(function (l) { return l.trim(); })
            .filter(function (l) { return l.length > 8 && l.length < 500 && l.indexOf('{') === -1; });
        var results = [];
        for (var i = 0; i < Math.min(lines.length, expectedCount); i++) {
            results.push({ idx: i, comment: lines[i] });
        }
        if (!results.length) throw new Error('S4: sin lineas utiles');
        log.info('[Parser] S4 OK. Items:', results.length);
        return results;
    }

    function _parseRawResponse(raw, block) {
        log.info('[Parser] Raw len:', raw.length,
            '| Preview:', raw.slice(0, CFG.DEBUG_RAW_LIMIT));

        var parsed = null, strategy = 0, errors = [];

        try { parsed = _strategy1(raw); strategy = 1; }
        catch (e) { log.warn('[Parser] S1:', e.message); errors.push('S1:' + e.message); }

        if (!parsed) {
            try { parsed = _strategy2(raw); strategy = 2; }
            catch (e) { log.warn('[Parser] S2:', e.message); errors.push('S2:' + e.message); }
        }
        if (!parsed) {
            try { parsed = _strategy3(raw); strategy = 3; }
            catch (e) { log.warn('[Parser] S3:', e.message); errors.push('S3:' + e.message); }
        }
        if (!parsed) {
            try { parsed = _strategy4(raw, block.length); strategy = 4; }
            catch (e) {
                _s.stats.parseErrors++;
                throw new Error('Todas las estrategias fallaron: ' + errors.join(' | '));
            }
        }

        log.info('[Parser] Exito S' + strategy + '. Items:', parsed.length);

        var icon = _getStyleIcon(), results = [], skipped = 0;
        for (var i = 0; i < block.length; i++) {
            var comment = _findInParsed(parsed, i);
            if (!comment || _isEmptyComment(comment)) { skipped++; continue; }
            comment = _cleanComment(comment);
            if (_isEmptyComment(comment)) { skipped++; continue; }
            results.push({
                start   : block[i].inicio || 0,
                end     : (block[i].fin || block[i].inicio || 0) + CFG.DISPLAY_DURATION,
                original: block[i].texto  || '',
                comment : comment,
                icon    : icon,
            });
        }
        log.info('[Parser] Cues:', results.length, '| Omitidos:', skipped);
        return results;
    }

    // ============================================================
    // PROMPT
    // ============================================================

    function _buildPrompt(block, style, langRaw, customPrompt) {
        var estilo   = ESTILOS[style] || ESTILOS.curiosidades;
        var instr    = (style === 'custom' && customPrompt) ? customPrompt : estilo.prompt;
        var langInfo = _resolveLang(langRaw);
        var langEn   = langInfo.en;

        var subs = [];
        for (var i = 0; i < block.length; i++) {
            subs.push({
                idx  : i,
                start: _fmtTime(block[i].inicio || 0),
                end  : _fmtTime(block[i].fin    || 0),
                text : (block[i].texto || '').trim().replace(/"/g, "'").replace(/\\/g, '/'),
            });
        }

        var lines = [
            '# SYSTEM',
            'You are a video commentary expert. You ALWAYS write in ' + langEn + '.',
            'CRITICAL: Every single comment MUST be written in ' + langEn + '. No exceptions.',
            '',
            '# TASK',
            'Commentary style: ' + instr,
            '',
            'Analyze the subtitles below and generate ONE brief comment per subtitle.',
            'Each comment must be 1-2 sentences MAX, written in ' + langEn + '.',
            '',
            '# OUTPUT FORMAT',
            'Return ONLY a valid JSON array. No explanation. No markdown. No code blocks.',
            '[{"idx":0,"comment":"Your comment in ' + langEn + '."},{"idx":1,"comment":"..."}]',
            '',
            '# RULES',
            '1. Output ONLY the JSON array — nothing before or after it.',
            '2. Exactly ' + block.length + ' elements (one per subtitle).',
            '3. NO newlines inside comment string values.',
            '4. Use ONLY straight double quotes (").',
            '5. No trailing commas.',
            '6. If nothing to say, write "-".',
            '7. LANGUAGE: all comments MUST be in ' + langEn + '. Do NOT use any other language.',
            '',
            '# INPUT SUBTITLES',
            JSON.stringify(subs),
            '',
            '# REMINDER: Write ALL comments in ' + langEn + '. Return ONLY the JSON array.',
        ];

        var prompt = lines.join('\n');
        log.info('Prompt:', block.length, 'subtitles |',
            langEn, '|', style, '|', prompt.length, 'chars');
        return prompt;
    }

    // ============================================================
    // OLLAMA — sin recursión acumulada
    // ============================================================

    function _callOllama(baseUrl, model, prompt, signal) {
        var maxAttempts = CFG.MAX_RETRIES + 1;
        var maxPayload = (VP.config && VP.config.maxPayloadOllamaChars) || 180000;

        function attempt(n) {
            var t0 = Date.now();
            log.info('[Ollama] Intento', (n + 1) + '/' + maxAttempts,
                '| Modelo:', model);
            var payload = JSON.stringify({
                model   : model,
                messages: [{ role: 'user', content: prompt }],
                stream  : false,
                options : {
                    temperature   : CFG.LLM_TEMPERATURE,
                    num_predict   : CFG.LLM_NUM_PREDICT,
                    top_p         : 0.85,
                    repeat_penalty: 1.1,
                },
            });
            if (payload.length > maxPayload) {
                return Promise.reject(new VP.ollama.OllamaError('Prompt demasiado grande para Ollama', 0, 'PAYLOAD_TOO_LARGE'));
            }

            return VP.ollama.fetchJSON(baseUrl + CFG.CHAT_ENDPOINT, {
                method : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body   : payload,
                signal: signal,
            }, Math.max(120000, CFG.FETCH_TIMEOUT))
            .then(function (d) {
                log.info('[Ollama] Respuesta recibida',
                    '|', (Date.now() - t0) + 'ms');
                if (!d || !d.message || !d.message.content) {
                    throw new Error('Respuesta vacia');
                }
                var content = d.message.content;
                log.info('[Ollama] OK. Len:', content.length,
                    '| Tokens:', (d.eval_count || '?'),
                    '| Dur:', (((d.total_duration || 0) / 1e9).toFixed(1)) + 's');
                return content;
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') throw err;
                if (VP.ollama && typeof VP.ollama.isRetryableError === 'function' && !VP.ollama.isRetryableError(err)) {
                    throw err;
                }
                log.warn('[Ollama] Error intento', (n + 1) + ':', err && err.message ? err.message : String(err));
                if (n >= maxAttempts - 1) throw err;
                var delay = CFG.RETRY_DELAY * (n + 1);
                log.info('[Ollama] Reintentando en', delay + 'ms');
                return new Promise(function (resolve) {
                    setTimeout(resolve, delay);
                }).then(function () { return attempt(n + 1); });
            });
        }

        return attempt(0);
    }

    // ============================================================
    // GENERACIÓN
    // ============================================================

    function _startGeneration() {
        log.info('=== INICIO GENERACION ===');
        if (_s.isProcessing) { _notif('Ya hay una generacion en curso', 'advertencia'); return; }

        var modelEl = _el('commentaryIAModel');
        var model   = modelEl ? modelEl.value.trim() : '';
        if (!model) { _notif('Selecciona un modelo de Ollama', 'error'); return; }

        var urlEl   = _el('commentaryIAUrl');
        var baseUrl = _normalizeUrl(urlEl ? urlEl.value : '');
        if (!_isValidUrl(baseUrl)) { _notif('URL de Ollama invalida', 'error'); return; }

        var cues = _getCues();
        if (!cues.length) { _notif('Sin subtitulos disponibles', 'advertencia'); return; }

        var style   = _getStyle();
        var langEl  = _el('commentaryIALang');
        var langRaw = (langEl && langEl.value) ? langEl.value : 'español';
        var custEl  = _el('commentaryIACustomPrompt');
        var custom  = custEl ? custEl.value.trim() : '';
        var key     = _videoKey();

        var langInfo = _resolveLang(langRaw);
        log.info('Parametros: modelo=' + model + ' | url=' + baseUrl +
            ' | estilo=' + style + ' | lang=' + langRaw + ' -> ' + langInfo.en +
            ' | cues=' + cues.length);

        try {
            util.storageSet(CFG.PREF_MODEL, model);
            util.storageSet(CFG.PREF_URL,   baseUrl);
            util.storageSet(CFG.PREF_STYLE,  style);
            util.storageSet(CFG.PREF_LANG,   langRaw);
            util.storageSet(CFG.PREF_PROMPT, custom);
        } catch (_) {}

        _load(key).then(function (cached) {
            if (cached && cached.length > 0) {
                var usar = window.confirm(
                    'Hay ' + cached.length + ' comentarios guardados.\n' +
                    'Cargarlos? (Cancelar = generar nuevos con IA)'
                );
                if (usar) {
                    _s.commentaryCues = cached;
                    _activateCommentary();
                    _renderList();
                    _notif(cached.length + ' comentarios restaurados', 'exito');
                    return;
                }
            }
            _executeGeneration(cues, baseUrl, model, style, langRaw, custom, key);
        }).catch(function () {
            _executeGeneration(cues, baseUrl, model, style, langRaw, custom, key);
        });
    }

    function _executeGeneration(cues, baseUrl, model, style, langRaw, custom, key) {
        // ── Token para invalidar callbacks de generaciones anteriores
        var genToken = ++_s._currentGenToken;

        _s.isProcessing = true;
        _s.abortController = new AbortController();
        if (VP.mochiMascota && typeof VP.mochiMascota.pensarComentarios === 'function') VP.mochiMascota.pensarComentarios();
        _s.commentaryCues = [];
        _unbindTimeUpdate();
        _cachedEntries = null;
        _lastHighlighted = -1;
        _resetStats();

        var blocks = util.trocearArray(cues, CFG.BLOCK_SIZE);
        var total  = blocks.length, done = 0, allCues = [];
        _s.stats.totalBlocks = total;
        _s.stats.totalCues   = cues.length;

        log.info('Ejecucion: bloques=' + total + ' | cues=' + cues.length);

        _setDisplay('commentaryIAStartBtn', 'none');
        _setDisplay('commentaryIAStopBtn',  '');
        _setDisplay('commentaryIAProgress', '');
        _setDisplay('commentaryIAApplyBtn', 'none');

        var emptyEl = _el('commentaryIAEmpty');
        if (emptyEl) emptyEl.style.display = 'none';

        var listEl = _el('commentaryIAList');
        if (listEl) _clearList(listEl);        // ← vaciado seguro

        _updateProgress(0, total, 0);

        function processBlock() {
            // Verificar que esta generación sigue siendo válida
            if (_s._currentGenToken !== genToken) {
                log.info('processBlock: token obsoleto, abortando');
                return;
            }
            if (!_s.isProcessing) return;
            if (_s.abortController && _s.abortController.signal.aborted) return;
            if (done >= total) { _onComplete(allCues, key, genToken); return; }

            var bi    = done;
            var block = blocks[bi];
            log.info('Bloque', (bi + 1) + '/' + total,
                '| en bloque:', block.length, '| acumulados:', allCues.length);

            var prompt = _buildPrompt(block, style, langRaw, custom);

            _callOllama(baseUrl, model, prompt, _s.abortController.signal)
                .then(function (raw) {
                    // ← Verificar token antes de procesar resultado
                    if (_s._currentGenToken !== genToken) {
                        log.info('Bloque obsoleto ignorado:', (bi + 1));
                        return;
                    }
                    var newCues;
                    try {
                        newCues = _parseRawResponse(raw, block);
                    } catch (e) {
                        log.error('Parse error bloque', (bi + 1) + ':', e.message);
                        newCues = [];
                        _s.stats.parseErrors++;
                    }

                    for (var i = 0; i < newCues.length; i++) {
                        allCues.push(newCues[i]);
                        _appendEntryToList(newCues[i]);
                    }
                    _s.stats.processedBlocks++;
                    _s.stats.generatedCues = allCues.length;
                    done++;
                    _updateProgress(done, total, allCues.length);
                    setTimeout(processBlock, CFG.INTER_BLOCK_DELAY);
                })
                .catch(function (err) {
                    if (_s._currentGenToken !== genToken) return; // ← token check
                    if (err && err.name === 'AbortError') {
                        _notif('Generacion cancelada', 'info');
                        _stopGeneration();
                        return;
                    }
                    log.error('Error bloque', (bi + 1) + ':', err.message || err);
                    _s.stats.failedBlocks++;
                    done++;
                    _updateProgress(done, total, allCues.length);
                    _notif('Error en bloque ' + (bi + 1) + ', continuando...', 'advertencia');
                    setTimeout(processBlock, CFG.RETRY_DELAY);
                });
        }

        processBlock();
    }

    function _onComplete(allCues, key, genToken) {
        // Verificar que seguimos siendo la generación activa
        if (_s._currentGenToken !== genToken) {
            log.info('_onComplete: token obsoleto, ignorado');
            return;
        }

        _s.stats.endTime = Date.now();
        _s.isProcessing  = false;
        _s.abortController = null;

        allCues.sort(function (a, b) { return a.start - b.start; });
        _validateCues(allCues);   // ← corregir solapamientos
        _s.commentaryCues = allCues;
        if (allCues.length > 0 && VP.mochiMascota && typeof VP.mochiMascota.sorprenderComentarios === 'function') VP.mochiMascota.sorprenderComentarios();

        if (allCues.length > 0) _save(key, allCues);

        _setDisplay('commentaryIAStartBtn', '');
        _setDisplay('commentaryIAStopBtn',  'none');
        _setDisplay('commentaryIAProgress', 'none');
        _setDisplay('commentaryIAApplyBtn', '');

        var elapsed = ((_s.stats.endTime - _s.stats.startTime) / 1000).toFixed(1);
        log.info('=== COMPLETADO ===');
        log.info('Cues:', allCues.length + '/' + _s.stats.totalCues,
            '| Bloques OK:', _s.stats.processedBlocks + '/' + _s.stats.totalBlocks,
            '| Fallidos:', _s.stats.failedBlocks,
            '| Parse err:', _s.stats.parseErrors,
            '| Tiempo:', elapsed + 's');

        log.info(allCues.length, 'comentarios en', elapsed + 's');
        _notif(
            allCues.length + ' comentarios en ' + elapsed + 's' +
            (_s.stats.failedBlocks > 0 ? ' (' + _s.stats.failedBlocks + ' fallidos)' : ''),
            allCues.length > 0 ? 'exito' : 'advertencia'
        );
        _activateCommentary();
    }

    function _stopGeneration() {
        log.info('Deteniendo generacion');
        if (_s.abortController) try { _s.abortController.abort(); } catch (_) {}
        _s.isProcessing    = false;
        _s.abortController = null;
        _setDisplay('commentaryIAStartBtn', '');
        _setDisplay('commentaryIAStopBtn',  'none');
        _setDisplay('commentaryIAProgress', 'none');
        _notif('Generacion detenida', 'info');
    }

    // ============================================================
    // PERSISTENCIA
    // ============================================================

    function _toCompact(cues) {
        return cues.map(function (c) {
            return {
                i : Math.round(c.start   * 100) / 100,
                f : Math.round(c.end     * 100) / 100,
                o : c.original || '',
                c : c.comment  || '',
                ic: c.icon     || '',
            };
        });
    }

    function _fromCompact(arr) {
        return arr.map(function (c) {
            return { start: c.i || 0, end: c.f || 0, original: c.o || '', comment: c.c || '', icon: c.ic || '🧠' };
        });
    }

    function _save(key, cues) {
        if (!key || !cues || !cues.length) return;
        var compact = _toCompact(cues);

        // Caché rápida en almacenamiento
        try {
            util.storageSet(CFG.STORAGE_PREFIX + key, compact);
            log.info('Caché OK:', compact.length, 'cues');
        } catch (e) {
            log.warn('Escritura en caché falló:', e.message);
        }

        // IDB como persistencia principal
        try {
            if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
                VP.db.guardarMetadatos(key, {
                    commentaryIA   : compact,
                    commentaryIATs : Date.now(),
                    commentaryIAVer: VERSION,
                })
                .then(function () { log.info('IDB OK:', compact.length, 'cues'); })
                .catch(function (e) { log.error('IDB write failed:', e); });
            }
        } catch (e) {
            log.warn('IDB acceso:', e.message);
        }
    }

    function _load(key) {
        if (!key) return Promise.resolve([]);
        log.info('_load:', key.slice(0, 50) + (key.length > 50 ? '...' : ''));

        try {
            var ls = util.storageGet(CFG.STORAGE_PREFIX + key, null);
            if (ls && Array.isArray(ls) && ls.length > 0) {
                log.info('Caché rápida:', ls.length, 'cues');
                return Promise.resolve(_fromCompact(ls));
            }
        } catch (e) {
            log.warn('Lectura de caché falló:', e.message);
        }

        if (VP.db && typeof VP.db.obtenerMetadatos === 'function') {
            return VP.db.obtenerMetadatos(key).then(function (meta) {
                if (meta && Array.isArray(meta.commentaryIA) && meta.commentaryIA.length > 0) {
                    var exp = _fromCompact(meta.commentaryIA);
                    log.info('IDB:', exp.length, 'cues');
                    try { util.storageSet(CFG.STORAGE_PREFIX + key, meta.commentaryIA); } catch (_) {}
                    return exp;
                }
                return [];
            }).catch(function (e) {
                log.warn('IDB read:', e);
                return [];
            });
        }

        return Promise.resolve([]);
    }

    function _deleteCache(key) {
        if (!key) return;
        try {
            util.eliminarItem(CFG.STORAGE_PREFIX + key);
            log.info('Cache eliminado:', key.slice(0, 40));
        } catch (e) {
            log.warn('Delete cache:', e.message);
        }
        try {
            if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
                VP.db.guardarMetadatos(key, { commentaryIA: [], commentaryIATs: null }).catch(function () {});
            }
        } catch (_) {}
    }

    // ============================================================
    // ACTIVAR / DESACTIVAR
    // ============================================================

    function _activateCommentary() {
        if (!_s.commentaryCues.length) {
            _deactivateCommentary();
            _notif('No hay comentarios asignados para este video', 'info');
            return;
        }
        log.info('Activando. Cues:', _s.commentaryCues.length);
        _s.isActive = true;
        _s.currentCueIndex = -1;
        _s._lastKnownTime  = -1;
        _ensureOverlay();
        _bindTimeUpdate();
        var btn = _el('commentaryIABtn');
        if (btn) btn.classList.add('active-btn');
        _setDisplay('commentaryIAToggleBtn', '');
        var toggleBtn = _el('commentaryIAToggleBtn');
        if (toggleBtn) toggleBtn.textContent = _s.isVisible ? '👁 Visible' : '👁 Oculto';
        _setDisplay('commentaryIAApplyBtn',  '');
        _notif('Comentarios IA activos (' + _s.commentaryCues.length + ') — ' + (_s.isVisible ? 'Visible' : 'Oculto'), 'info');
        bus.emit('comentariosIA:activados', { count: _s.commentaryCues.length });
    }

    function _deactivateCommentary() {
        log.info('Desactivando');
        _s.isActive = false;
        _s.currentCueIndex = -1;
        _unbindTimeUpdate();
        _hideOverlay();
        _clearHighlight();
        var btn = _el('commentaryIABtn');
        if (btn) btn.classList.remove('active-btn');
        bus.emit('comentariosIA:desactivados');
    }

    function _toggleVisibility() {
        _s.isVisible = !_s.isVisible;
        log.info('Visibilidad:', _s.isVisible ? 'VISIBLE' : 'OCULTO');
        if (_s.isVisible) {
            _s.currentCueIndex = -1;
            _s._lastKnownTime  = -1;
        } else {
            _hideOverlay();
        }
        var btn = _el('commentaryIAToggleBtn');
        if (btn) btn.textContent = _s.isVisible ? '👁 Visible' : '👁 Oculto';
        try { util.storageSet(CFG.PREF_VISIBLE, _s.isVisible); } catch (_) {}
    }

    // ============================================================
    // APLICAR COMO TRACK
    // ============================================================

    function _applyAsTrack() {
        if (!_s.commentaryCues.length) { _notif('Sin comentarios para aplicar', 'advertencia'); return; }
        if (_isFileProtocol()) {
            _notif('En modo local se usa el overlay integrado', 'info');
            if (!_s.isActive) _activateCommentary();
            return;
        }

        var video = VP.refs && VP.refs.videoPlayer;
        if (!video || dom.esNulo(video)) { _notif('No se encontro el video', 'error'); return; }

        var vtt = _buildVTT(_s.commentaryCues);
        if (_s.trackBlobUrl) {
            try { URL.revokeObjectURL(_s.trackBlobUrl); } catch (_) {}
            _s.trackBlobUrl = null;
        }
        _removePrevTracks(video);

        var blob    = new Blob([vtt], { type: 'text/vtt;charset=utf-8' });
        var url     = URL.createObjectURL(blob);
        _s.trackBlobUrl = url;

        var trackEl = document.createElement('track');
        trackEl.kind    = 'subtitles';
        trackEl.srclang = 'ia';
        trackEl.label   = 'Comentarios IA';
        trackEl.setAttribute('data-commentary-ia', 'true');

        // ── Activar track de forma robusta ─────────────────────
        function activate() {
            try { if (trackEl.track) trackEl.track.mode = 'showing'; } catch (_) {}
        }

        trackEl.addEventListener('load', function onLoad() {
            trackEl.removeEventListener('load', onLoad);
            activate();
        });
        trackEl.addEventListener('error', function onErr() {
            trackEl.removeEventListener('error', onErr);
            log.warn('Track load error');
        });

        video.appendChild(trackEl);
        trackEl.src = url;

        // Fallback RAF en lugar de setTimeout arbitrario
        var rafCount = 0;
        function rafActivate() {
            activate();
            if (++rafCount < 3) requestAnimationFrame(rafActivate);
        }
        requestAnimationFrame(rafActivate);

        _notif('Comentarios aplicados como pista', 'exito');
    }

    function _removePrevTracks(video) {
        var prev = video.querySelectorAll('track[data-commentary-ia], track[data-commentary]');
        for (var i = 0; i < prev.length; i++) {
            var src = prev[i].src;
            try { video.removeChild(prev[i]); } catch (_) {}
            if (src && src.indexOf('blob:') === 0) try { URL.revokeObjectURL(src); } catch (_) {}
        }
    }

    function _buildVTT(cues) {
        var lines = ['WEBVTT', ''];
        for (var i = 0; i < cues.length; i++) {
            var c = cues[i];
            lines.push(
                String(i + 1),
                _tsVtt(c.start) + ' --> ' + _tsVtt(c.end) + ' line:85% align:center',
                (c.icon || '🧠') + ' ' + (c.comment || ''),
                ''
            );
        }
        return lines.join('\n');
    }

    // ============================================================
    // EXPORTAR SRT
    // ============================================================

    function _exportSrt() {
        if (!_s.commentaryCues.length) { _notif('Sin comentarios para exportar', 'advertencia'); return; }
        var parts = [];
        for (var i = 0; i < _s.commentaryCues.length; i++) {
            var c = _s.commentaryCues[i];
            // ← _tsSrt dedicada — no usar replace('.', ',')
            parts.push(
                (i + 1) + '\n' +
                _tsSrt(c.start) + ' --> ' + _tsSrt(c.end) + '\n' +
                (c.icon || '🧠') + ' ' + (c.comment || '') + '\n'
            );
        }
        var title = '';
        try {
            var ci = VP.estado && VP.estado.currentVideoIndex;
            var pl = VP.estado && VP.estado.playlist;
            if (typeof ci === 'number' && pl && pl[ci]) title = pl[ci].name || '';
        } catch (_) {}
        var safeName = util.sanitizarNombreArchivo(util.obtenerNombreBase(title || 'video'));
        var filename = 'comentarios_' + safeName + '.srt';
        var blob     = new Blob([parts.join('\n')], { type: 'text/plain;charset=utf-8' });
        var url      = URL.createObjectURL(blob);
        var a        = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            try { document.body.removeChild(a); } catch (_) {}
            try { URL.revokeObjectURL(url); } catch (_) {}
        }, 1500);
        _notif('Exportado: ' + filename, 'exito');
    }

    // ============================================================
    // LIMPIAR
    // ============================================================

    function _clearAll() {
        log.info('Limpiando todo');
        _deactivateCommentary();
        _s.commentaryCues = [];
        _cachedEntries    = null;
        _lastHighlighted  = -1;
        _renderList();
        if (_s.trackBlobUrl) {
            try { URL.revokeObjectURL(_s.trackBlobUrl); } catch (_) {}
            _s.trackBlobUrl = null;
        }
        var video = VP.refs && VP.refs.videoPlayer;
        if (video && !dom.esNulo(video)) _removePrevTracks(video);
        var key = _videoKey();
        if (key) _deleteCache(key);
        _setDisplay('commentaryIAApplyBtn',  'none');
        _setDisplay('commentaryIAToggleBtn', 'none');
    }

    // ============================================================
    // UI
    // ============================================================

    function _updateProgress(done, total, count) {
        var pct   = total > 0 ? Math.round((done / total) * 100) : 0;
        var pctEl = _el('commentaryIAProgressPct');   if (pctEl) pctEl.textContent = pct + '%';
        var bar   = _el('commentaryIAProgressBar');   if (bar)   bar.style.width   = pct + '%';
        var lbl   = _el('commentaryIAProgressLabel'); if (lbl)   lbl.textContent   = done >= total ? 'Completo' : 'Bloque ' + (done + 1) + ' de ' + total;
        var det   = _el('commentaryIAProgressDetail');if (det)   det.textContent   = count + ' comentarios generados';
    }

    function _buildEntryEl(cue) {
        var entry = document.createElement('div');
        entry.className = 'commentary-ia-entry';

        var timeDiv = document.createElement('div');
        timeDiv.className = 'commentary-ia-entry-time';
        timeDiv.title = 'Saltar a ' + _fmtTime(cue.start);
        timeDiv.innerHTML =
            '<span class="ts">' + _fmtTime(cue.start) + '</span>' +
            ' <span class="ts-sep">&rarr;</span> ' +
            '<span class="ts">' + _fmtTime(cue.end) + '</span>';

        // ← Sin IIFE — cue.start ya está capturado en el parámetro
        timeDiv.addEventListener('click', function () {
            var v = VP.refs && VP.refs.videoPlayer;
            if (v && !dom.esNulo(v)) {
                v.currentTime = cue.start;
                try { v.play(); } catch (_) {}
            }
        });
        entry.appendChild(timeDiv);

        if (cue.original) {
            var orig = document.createElement('div');
            orig.className = 'commentary-ia-entry-original';
            orig.textContent = cue.original;
            entry.appendChild(orig);
        }

        var cd = document.createElement('div');
        cd.className = 'commentary-ia-entry-comment';
        var ic = document.createElement('span');
        ic.className  = 'commentary-icon';
        ic.textContent = cue.icon || '🧠';
        cd.appendChild(ic);
        cd.appendChild(document.createTextNode(cue.comment));
        entry.appendChild(cd);

        return entry;
    }

    function _appendEntryToList(cue) {
        var list = _el('commentaryIAList');
        if (!list) return;
        _cachedEntries = null;
        list.appendChild(_buildEntryEl(cue));
        list.scrollTop = list.scrollHeight;
    }

    function _renderList() {
        var list    = _el('commentaryIAList');
        var emptyEl = _el('commentaryIAEmpty');
        if (!list) return;

        _cachedEntries   = null;
        _lastHighlighted = -1;
        _clearList(list);   // ← vaciado seguro

        if (!_s.commentaryCues.length) {
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        var frag = document.createDocumentFragment();
        for (var j = 0; j < _s.commentaryCues.length; j++) {
            frag.appendChild(_buildEntryEl(_s.commentaryCues[j]));
        }
        list.appendChild(frag);
        log.info('_renderList:', _s.commentaryCues.length, 'entradas');
    }

    function _updateSubStatus() {
        var el   = _el('commentaryIASubStatus');
        if (!el) return;
        var cues = _getCues();
        if (cues.length) {
            el.textContent  = cues.length + ' subtitulos disponibles';
            el.style.color  = 'var(--yt-green,#4caf50)';
        } else {
            el.textContent  = 'Sin subtitulos (necesarios para comentar)';
            el.style.color  = 'var(--yt-text-secondary,#aaa)';
        }
    }

    // ============================================================
    // MODELOS
    // ============================================================

    function _populateModels(rawUrl) {
        var sel  = _el('commentaryIAModel');
        if (!sel) return;
        var base = _normalizeUrl(rawUrl);
        if (!_isValidUrl(base)) {
            sel.innerHTML = '<option value="">URL invalida</option>';
            return;
        }
        sel.innerHTML = '<option value="">Cargando...</option>';
        sel.disabled  = true;

        VP.ollama.fetchModels(base, { timeout: CFG.FETCH_TIMEOUT })
            .then(function (models) {
                log.info('Modelos disponibles:', models);
                if (!models.length) {
                    sel.innerHTML = '<option value="">Sin modelos</option>';
                    sel.disabled  = false;
                    return;
                }
                var frag = document.createDocumentFragment();
                for (var j = 0; j < models.length; j++) {
                    var o = document.createElement('option');
                    o.value = models[j]; o.textContent = models[j];
                    frag.appendChild(o);
                }
                sel.innerHTML = '';
                sel.appendChild(frag);
                sel.disabled = false;
                var saved = util.storageGet(CFG.PREF_MODEL, '');
                if (saved && models.indexOf(saved) >= 0) {
                    sel.value = saved;
                    log.info('Modelo restaurado:', saved);
                }
                _updateBadge();
            })
            .catch(function (e) {
                if (e && e.name !== 'AbortError') {
                    log.error('Error cargando modelos:', e.message);
                }
                sel.innerHTML = '<option value="">Sin conexion con Ollama</option>';
                sel.disabled  = false;
            });
    }

    function _updateBadge() {
        var b = _el('commentaryIAModelBadge');
        if (!b) return;
        var m    = _el('commentaryIAModel');
        var name = (m && m.value) ? m.value : '';
        var svg  = b.querySelector('svg');
        b.innerHTML = svg ? svg.outerHTML : '';
        b.appendChild(document.createTextNode(name ? name.split(':')[0] : 'Ollama'));
    }

    // ============================================================
    // MODAL — compatible con vp-flotante-ia.js
    // ============================================================
    // vp-flotante-ia observa cambios de clase 'active' en el overlay.
    // _openModal añade 'active', _closeModal la quita.
    // El sistema de posicionamiento lo gestiona vp-flotante-ia.js.
    // ============================================================

    function _openModal() {
        log.info('Abriendo modal');
        var modal = _el(CFG.MODAL_ID);
        if (!modal) {
            log.warn('Modal no encontrado:', CFG.MODAL_ID);
            return;
        }

        // ← Usar classList.add('active') — vp-flotante-ia observa esto
        modal.classList.add('active');
        modal.removeAttribute('aria-hidden');
        modal.setAttribute('aria-modal', 'true');
        modal.focus();
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(true);

        // Restaurar preferencias
        var urlEl   = _el('commentaryIAUrl');
        var savedUrl = util.storageGet(CFG.PREF_URL, '');
        if (savedUrl && urlEl) urlEl.value = savedUrl;

        var styleEl   = _el('commentaryIAStyle');
        var savedStyle = util.storageGet(CFG.PREF_STYLE, '');
        if (savedStyle && styleEl) styleEl.value = savedStyle;

        var langEl   = _el('commentaryIALang');
        var savedLang = util.storageGet(CFG.PREF_LANG, '');
        if (savedLang && langEl) langEl.value = savedLang;

        var custEl   = _el('commentaryIACustomPrompt');
        var savedPrompt = util.storageGet(CFG.PREF_PROMPT, '');
        if (savedPrompt && custEl) custEl.value = savedPrompt;

        _populateModels(urlEl ? urlEl.value : '');
        _updateSubStatus();

        var key = _videoKey();
        if (key && !_s.commentaryCues.length) {
            _load(key).then(function (cached) {
                if (cached && cached.length > 0) {
                    _s.commentaryCues = cached;
                    _renderList();
                    _setDisplay('commentaryIAApplyBtn',  '');
                    _setDisplay('commentaryIAToggleBtn', '');
                } else {
                    _renderList();
                }
            }).catch(function (e) { log.warn('Error cargando comentarios:', e.message || e); });
        } else {
            _renderList();
        }
    }

    function _closeModal() {
        var modal = _el(CFG.MODAL_ID);
        if (!modal) return;
        // ← Usar classList.remove('active') — vp-flotante-ia lo detecta en onClose
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(false);
    }

    // ============================================================
    // CAMBIO DE VIDEO
    // ============================================================

    function _onVideoChanged() {
        var newKey = _videoKey();
        if (newKey === _s.currentVideoKey && _s.currentVideoKey !== '') return;
        log.info('Video cambiado: "' +
            (_s.currentVideoKey || 'ninguno') + '" -> "' + (newKey || 'ninguno') + '"');
        _s.currentVideoKey = newKey;
        _deactivateCommentary();
        _unbindTimeUpdate();
        _s.commentaryCues  = [];
        _s.currentCueIndex = -1;
        _cachedEntries     = null;
        _lastHighlighted   = -1;

        if (newKey) {
            _load(newKey).then(function (cached) {
                if (cached && cached.length > 0) {
                    _s.commentaryCues = cached;
                    _activateCommentary();
                    log.info('Restaurados', cached.length,
                        'para', newKey.slice(0, 40));
                }
            }).catch(function (e) { log.warn('Error cargando comentarios:', e.message || e); });
        }
    }

    // ============================================================
    // DIAGNÓSTICO
    // ============================================================

    function _logDiagnostics() {
        console.group('=== DIAGNOSTICO v' + VERSION + ' ===');
        log.info('isActive        :', _s.isActive);
        log.info('isProcessing    :', _s.isProcessing);
        log.info('isVisible       :', _s.isVisible);
        log.info('videoEnlazado   :', !!_s._videoEl);
        log.info('handlerActivo   :', !!_s._timeupdateHandler);
        log.info('throttle        :', CFG.TIMEUPDATE_THROTTLE_MS + 'ms');
        log.info('modalId         :', CFG.MODAL_ID);
        log.info('currentVideoKey :', (_s.currentVideoKey || 'ninguno').slice(0, 50));
        log.info('currentCueIndex :', _s.currentCueIndex);
        log.info('commentaryCues  :', _s.commentaryCues.length);
        log.info('vpSubtitleCues  :', _getCues().length);
        log.info('overlayEnDOM    :', !!document.getElementById(CFG.OVERLAY_ID));
        log.info('genToken        :', _s._currentGenToken);
        log.info('protocolo       :', window.location.protocol);

        var video = _s._videoEl || (VP.refs && VP.refs.videoPlayer);
        if (video) {
            log.info('video.currentTime:', video.currentTime.toFixed(3));
            log.info('video.paused     :', video.paused);
        }
        if (_s.stats.startTime) {
            var elapsed = _s.stats.endTime
                ? ((_s.stats.endTime - _s.stats.startTime) / 1000).toFixed(1) + 's'
                : 'en curso';
            log.info('stats.tiempo    :', elapsed);
            log.info('stats.cues      :', _s.stats.generatedCues + '/' + _s.stats.totalCues);
            log.info('stats.bloques   :', _s.stats.processedBlocks + '/' + _s.stats.totalBlocks);
            log.info('stats.fallidos  :', _s.stats.failedBlocks);
            log.info('stats.parseErr  :', _s.stats.parseErrors);
        }
        console.groupEnd();
    }

    // ============================================================
    // EVENTOS
    // ============================================================

    function _registerEvents() {
        log.info('Registrando eventos...');

        _bind('commentaryIABtn',        _openModal,        'openModal');
        _bind('commentaryIAModalClose', _closeModal,       'closeModal');
        _bind('commentaryIAStartBtn',   _startGeneration,  'startGeneration');
        _bind('commentaryIAStopBtn',    _stopGeneration,   'stopGeneration');
        _bind('commentaryIAToggleBtn',  _toggleVisibility, 'toggleVisibility');
        _bind('commentaryIAExportBtn',  _exportSrt,        'exportSrt');
        _bind('commentaryIAApplyBtn',   _applyAsTrack,     'applyAsTrack');

        _bind('commentaryIAClearBtn', function () {
            if (!_s.commentaryCues.length) { _notif('No hay comentarios', 'info'); return; }
            try { if (!window.confirm('Eliminar todos los comentarios?')) return; } catch (_) {}
            _clearAll();
            _notif('Comentarios eliminados', 'info');
        }, 'clearAll');

        _bind('commentaryIARefreshBtn', function () {
            var u = _el('commentaryIAUrl');
            _populateModels(u ? u.value : '');
        }, 'refreshModels');

        // ── Estilo custom ──────────────────────────────────────
        var styleEl = _el('commentaryIAStyle');
        if (styleEl) {
            _addTracked(styleEl, 'change', function () {
                var cr = _el('commentaryIACustomRow');
                if (cr) cr.style.display = styleEl.value === 'custom' ? '' : 'none';
            }, _s._docListeners);
        }

        // ── Cerrar al hacer clic en el overlay (fuera del content)
        // NOTA: vp-flotante-ia.js gestiona el posicionamiento pero NO el cierre.
        // El cierre lo manejamos aquí detectando clic en el overlay mismo.
        var modal = _el(CFG.MODAL_ID);
        if (modal) {
            _addTracked(modal, 'click', function (e) {
                // Solo cerrar si el clic es directamente en el overlay,
                // no en el .modal-content hijo
                if (e.target === modal) _closeModal();
            }, _s._docListeners);
        }

        // ── Escape (centralizado en vp-eventos.js) ────────────
        if (typeof VP.eventos.registrarModalIA === 'function') {
            VP.eventos.registrarModalIA(CFG.MODAL_ID, _closeModal);
        }

        // ── URL input con debounce ─────────────────────────────
        var urlInput = _el('commentaryIAUrl');
        if (urlInput) {
            var deb = util.debounce(function () {
                var v = _normalizeUrl(urlInput.value);
                if (_isValidUrl(v)) _populateModels(v);
            }, 900);
            _addTracked(urlInput, 'input', deb, _s._docListeners);
        }

        // ── Cambio de modelo ───────────────────────────────────
        var modelSel = _el('commentaryIAModel');
        if (modelSel) {
            _addTracked(modelSel, 'change', function () {
                try { util.storageSet(CFG.PREF_MODEL, modelSel.value); } catch (_) {}
                _updateBadge();
            }, _s._docListeners);
        }

        // ── Custom prompt ──────────────────────────────────────
        var custEl = _el('commentaryIACustomPrompt');
        if (custEl) {
            _addTracked(custEl, 'change', function () {
                try { util.storageSet(CFG.PREF_PROMPT, custEl.value); } catch (_) {}
            }, _s._docListeners);
        }

        // ── Bus events ─────────────────────────────────────────
        if (bus) {
            function _onCacheVaciada() {
                _deactivateCommentary();
                _s.commentaryCues = [];
                _cachedEntries    = null;
                _lastHighlighted  = -1;
                _renderList();
                if (_s.trackBlobUrl) {
                    try { URL.revokeObjectURL(_s.trackBlobUrl); } catch (_) {}
                    _s.trackBlobUrl = null;
                }
                var video = VP.refs && VP.refs.videoPlayer;
                if (video && !dom.esNulo(video)) _removePrevTracks(video);
                _setDisplay('commentaryIAApplyBtn',  'none');
                _setDisplay('commentaryIAToggleBtn', 'none');
            }

            var busEvts = [
                ['cacheVaciada',      _onCacheVaciada],
                ['videoCambiado',      _onVideoChanged],
                ['videoReproduciendo', function () { _onVideoChanged(); _updateSubStatus(); }],
                ['subtitulosCargados', _updateSubStatus],
                ['videoDetenido',      _deactivateCommentary],
                ['reset',              function () { _stopGeneration(); _clearAll(); _s.currentVideoKey = ''; }],
            ];
            for (var i = 0; i < busEvts.length; i++) {
                bus.on(busEvts[i][0], busEvts[i][1]);
                _s._busListeners.push({ event: busEvts[i][0], handler: busEvts[i][1] });
            }
            log.info('Bus listeners:', busEvts.length);
        }

        log.info('Eventos registrados OK');
    }

    function _bind(id, fn, desc) {
        var el = _el(id);
        if (el) {
            _addTracked(el, 'click', fn, _s._docListeners);
            log.debug('Bind:', id, '->', desc || 'fn');
        } else {
            log.warn('Elemento no encontrado:', id);
        }
    }

    // ============================================================
    // DESTRUIR
    // ============================================================

    function _destroy() {
        log.info('Destruyendo...');
        _stopGeneration();
        _deactivateCommentary();
        _unbindTimeUpdate();
        _removeTracked(_s._docListeners);

        if (bus) {
            for (var i = 0; i < _s._busListeners.length; i++) {
                try { bus.off(_s._busListeners[i].event, _s._busListeners[i].handler); } catch (_) {}
            }
        }
        _s._busListeners.length = 0;
        _s._initialized = false;

        if (_s.trackBlobUrl) {
            try { URL.revokeObjectURL(_s.trackBlobUrl); } catch (_) {}
            _s.trackBlobUrl = null;
        }
        if (_s.overlayEl && _s.overlayEl.parentNode) {
            try { _s.overlayEl.parentNode.removeChild(_s.overlayEl); } catch (_) {}
        }
        _s.overlayEl = null;
        _overlaySpan = null;
        _cachedEntries = null;

        var styleEl = document.getElementById(CFG.OVERLAY_STYLE_ID);
        if (styleEl && styleEl.parentNode) {
            try { styleEl.parentNode.removeChild(styleEl); } catch (_) {}
        }
        log.info('Destruido OK');
    }

    // ============================================================
    // API PÚBLICA — _state solo como getter de copia
    // ============================================================

    VP.comentariosIA = {
        open             : _openModal,
        close            : _closeModal,
        start            : _startGeneration,
        stop             : _stopGeneration,
        activate         : _activateCommentary,
        deactivate       : _deactivateCommentary,
        toggleVisibility : _toggleVisibility,
        applyAsTrack     : _applyAsTrack,
        exportSrt        : _exportSrt,
        clear            : _clearAll,
        getCues          : function () { return _s.commentaryCues.slice(); },
        getStats         : function () { return Object.assign({}, _s.stats); },
        // ← getState devuelve copia — no expone referencia mutable
        getState         : function () { return Object.assign({}, _s); },
        isActive         : function () { return _s.isActive; },
        isProcessing     : function () { return _s.isProcessing; },
        diagnostics      : _logDiagnostics,
        destroy          : _destroy,
        // Mantener _cfg como referencia (ya está frozen)
        _cfg             : CFG,
    };

    window.VP_ComentariosIA = VP.comentariosIA;
    log.info('API expuesta. Debug: VP.comentariosIA.diagnostics()');

    // ============================================================
    // INIT
    // ============================================================

    function _init() {
        if (_s._initialized) { log.warn('Ya inicializado'); return; }
        _s._initialized = true;
        log.info('=== INIT v' + VERSION + ' ===');
        log.info('Protocolo:', window.location.protocol,
            '| file://', _isFileProtocol());
        log.info('Modal ID:', CFG.MODAL_ID,
            '| En DOM:', !!document.getElementById(CFG.MODAL_ID));

        _s.isVisible = util.storageGet(CFG.PREF_VISIBLE, true) !== false;

        _registerEvents();

        // Registrar en vp-flotante-ia.js si ya está disponible
        if (window.VPFloating && typeof window.VPFloating.register === 'function') {
            var registered = window.VPFloating.register(CFG.MODAL_ID, 'comments');
            log.info('VPFloating.register:', registered ? 'OK' : 'ya registrado o fallo');
        } else {
            log.info('VPFloating no disponible aún — observeNewWindows lo registrará');
        }

        _s.currentVideoKey = _videoKey();
        log.info('Video key inicial:', _s.currentVideoKey || 'ninguno');

        if (_s.currentVideoKey) {
            _load(_s.currentVideoKey).then(function (cached) {
                if (cached && cached.length > 0) {
                    _s.commentaryCues = cached;
                    _activateCommentary();
                }
            }).catch(function (e) { log.warn('Error cargando comentarios:', e.message || e); });
        }

        log.info('v' + VERSION + ' iniciado');
    }

    function _waitForVP() {
        var initialized = false;

        function tryInit(source) {
            if (initialized) return;
            initialized = true;
            log.info('Init disparado por:', source);
            _init();
        }

        document.addEventListener('vpReady', function () {
            tryInit('vpReady event');
        });

        var att = 0;
        function poll() {
            if (initialized) return;
            if (++att > 200) {
                log.warn('Timeout esperando VP');
                tryInit('timeout fallback');
                return;
            }
            if (VP.log && VP.bus && VP.dom && VP.util) {
                tryInit('poll att=' + att);
                return;
            }
            setTimeout(poll, 25);
        }
        poll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _waitForVP);
    } else {
        _waitForVP();
    }

    log.info('vp-comentarios-ia.js v' + VERSION + ' cargado');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-comentarios-ia.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
