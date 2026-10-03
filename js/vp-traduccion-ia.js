'use strict';

// ============================================================
// VP-TRADUCCION-IA.JS  —  v1.0.0
// Traducción de subtítulos con IA (Ollama) por lotes.
//
// Flujo:
//   1. Lee los cues del video actual (vpSubtitleCues)
//   2. Los divide en lotes de ~30 cues
//   3. Envía cada lote a Ollama para traducción
//   4. Ensambla los cues traducidos
//   5. Aplica como nueva pista <track> al video
//   6. Persiste la traducción para no repetirla
//
// Persistencia: LRU memoria → IDB
// Dependencias: vp-base.js · vp-utilidades.js · vp-dom.js ·
//               vp-db.js · vp-subtitulos.js
// ============================================================

(function (window, document) {
    if (window.__VP_TRADUCCION_IA_LOADED__) return;
    window.__VP_TRADUCCION_IA_LOADED__ = true;

    var VP = window.VP;
    if (!VP) throw new Error('[VP] vp-traduccion-ia.js: vp-base.js falta.');

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;
    log.setContext('TraduccionIA');

    if (!util || !dom || !log || !bus) {
        throw new Error('[VP] vp-traduccion-ia.js: dependencias faltantes.');
    }

    VP.traduccionIA = VP.traduccionIA || {};

    // ============================================================
    // CONSTANTES
    // ============================================================

    var CFG = Object.freeze({
        DEFAULT_URL       : 'http://localhost:11434',
        CHAT_ENDPOINT     : '/api/chat',
        MODELS_ENDPOINT   : '/api/tags',
        FETCH_TIMEOUT_MS  : 12000,
        BATCH_SIZE        : 30,
        MAX_RETRIES       : 2,
        RETRY_DELAY_MS    : 1500,
        STORAGE_PREFIX    : 'vpTransIA_',
        CACHE_MAX         : 80,
        PREF_MODEL        : 'translateIA_model',
        PREF_URL          : 'vp_ollama_url',
        PREF_FROM         : 'translateIA_from',
        PREF_TO           : 'translateIA_to',
    });

    // ============================================================
    // ESTADO
    // ============================================================

    var _s = {
        abortController  : null,
        isTranslating    : false,
        translatedCues   : [],
        originalCues     : [],
        currentVideoId   : '',
        fromLang         : 'auto',
        toLang           : 'español',
        _docListeners    : [],
        _busListeners    : [],
        _initialized     : false,
    };

    // ============================================================
    // CACHÉ LRU
    // ============================================================

    var _cache = (function () {
        var _m = Object.create(null);
        var _o = [];
        return {
            get: function (k) {
                if (!_m[k]) return null;
                var i = _o.indexOf(k); if (i > -1) _o.splice(i, 1);
                _o.push(k); return _m[k];
            },
            set: function (k, v) {
                if (_m[k]) { var i = _o.indexOf(k); if (i > -1) _o.splice(i, 1); }
                while (_o.length >= CFG.CACHE_MAX) { var old = _o.shift(); delete _m[old]; }
                _m[k] = v; _o.push(k);
            },
            del: function (k) { delete _m[k]; var i = _o.indexOf(k); if (i > -1) _o.splice(i, 1); },
            clear: function () { _m = Object.create(null); _o = []; },
        };
    })();

    // ============================================================
    // HELPERS
    // ============================================================

    function _el(id) { return document.getElementById(id); }

    function _setDisplay(id, v) { var e = _el(id); if (e) e.style.display = v; }

    function _addTracked(t, ev, fn, store) {
        if (!t || typeof t.addEventListener !== 'function') return;
        t.addEventListener(ev, fn);
        (store || _s._docListeners).push({ target: t, event: ev, handler: fn });
    }

    function _removeTracked(store) {
        for (var i = 0; i < store.length; i++) {
            try { store[i].target.removeEventListener(store[i].event, store[i].handler); } catch (_) {}
        }
        store.length = 0;
    }

    function _notif(m, t) {
        try { if (VP.ui && VP.ui.mostrarNotificacion) VP.ui.mostrarNotificacion(m, t || 'info'); } catch (_) {}
    }

    function _fmtTime(s) {
        s = Number(s); if (!isFinite(s) || s < 0) return '0:00';
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60);
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return h > 0 ? h + ':' + p(m) + ':' + p(sc) : m + ':' + p(sc);
    }

    function _normalizeUrl(r) {
        var u = (typeof r === 'string' ? r : '').trim();
        if (!u) return CFG.DEFAULT_URL;
        if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
        return u.replace(/\/+$/, '');
    }

    function _isValidUrl(s) {
        if (!s) return false;
        try { new URL(s.trim()); return true; } catch (_) { return false; }
    }

    function _getVideoId() {
        var ci = VP.estado && VP.estado.currentVideoIndex;
        var pl = VP.estado && VP.estado.playlist;
        if (typeof ci === 'number' && ci >= 0 && pl && pl[ci]) {
            return String(pl[ci].name || pl[ci].id || '');
        }
        var cv = window.vpCurrentVideo;
        return cv ? String(cv.name || cv.id || '') : '';
    }

    function _getVideoTitle() {
        var ci = VP.estado && VP.estado.currentVideoIndex;
        var pl = VP.estado && VP.estado.playlist;
        if (typeof ci === 'number' && ci >= 0 && pl && pl[ci]) return pl[ci].name || 'video';
        return 'video';
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

    function _escHTML(s) { return util.escaparHTML(s); }

    // ============================================================
    // PERSISTENCIA
    // ============================================================

    function _cacheKey(videoId, toLang) {
        return videoId + '_' + toLang.toLowerCase().replace(/\s+/g, '_');
    }

    function _saveTranslation(videoId, toLang, translatedCues) {
        var key = _cacheKey(videoId, toLang);
        var data = { cues: translatedCues, lang: toLang, ts: Date.now() };

        _cache.set(key, data);

        try {
            var compact = translatedCues.map(function (c) {
                return { i: Math.round(c.inicio * 100) / 100, f: Math.round(c.fin * 100) / 100, t: c.texto };
            });
            util.storageSet(CFG.STORAGE_PREFIX + key, { c: compact, l: toLang, ts: Date.now() });
        } catch (_) {}

        try {
            if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
                VP.db.guardarMetadatos(videoId, {
                    ['transIA_' + toLang]: translatedCues,
                    ['transIA_' + toLang + '_ts']: Date.now(),
                }).catch(function () {});
            }
        } catch (_) {}
    }

    function _loadTranslation(videoId, toLang) {
        var key = _cacheKey(videoId, toLang);

        var cached = _cache.get(key);
        if (cached && cached.cues && cached.cues.length) {
            return Promise.resolve(cached.cues);
        }

        var ls = util.storageGet(CFG.STORAGE_PREFIX + key, null);
        if (ls && ls.c && ls.c.length) {
            var cues = ls.c.map(function (c) {
                return { inicio: c.i, fin: c.f, texto: c.t, raw: c.t };
            });
            _cache.set(key, { cues: cues, lang: toLang, ts: ls.ts });
            return Promise.resolve(cues);
        }

        if (VP.db && typeof VP.db.obtenerMetadatos === 'function') {
            return VP.db.obtenerMetadatos(videoId).then(function (meta) {
                var field = 'transIA_' + toLang;
                if (meta && Array.isArray(meta[field]) && meta[field].length) {
                    _cache.set(key, { cues: meta[field], lang: toLang });
                    return meta[field];
                }
                return null;
            }).catch(function () { return null; });
        }

        return Promise.resolve(null);
    }

    // ============================================================
    // MODELOS
    // ============================================================

    function _populateModels(rawUrl) {
        var sel = _el('translateIAModel');
        if (!sel) return;
        var base = _normalizeUrl(rawUrl);
        if (!_isValidUrl(base)) { sel.innerHTML = '<option value="">URL inválida</option>'; return; }

        sel.innerHTML = '<option value="">Cargando…</option>';
        sel.disabled = true;

        VP.ollama.fetchModels(base, { timeout: CFG.FETCH_TIMEOUT_MS })
            .then(function (models) {
                if (!models.length) { sel.innerHTML = '<option value="">Sin modelos</option>'; sel.disabled = false; return; }

                var frag = document.createDocumentFragment();
                for (var j = 0; j < models.length; j++) {
                    var o = document.createElement('option');
                    o.value = models[j]; o.textContent = models[j]; frag.appendChild(o);
                }
                sel.innerHTML = ''; sel.appendChild(frag); sel.disabled = false;

                var saved = util.storageGet(CFG.PREF_MODEL, '');
                if (saved && models.indexOf(saved) >= 0) sel.value = saved;
                _updateBadge();
            })
            .catch(function (e) {
                sel.innerHTML = '<option value="">Sin conexión</option>';
                sel.disabled = false;
            });
    }

    function _updateBadge() {
        var b = _el('translateIAModelBadge');
        if (!b) return;
        var m = _el('translateIAModel');
        var name = m ? m.value : '';
        var display = name ? name.split(':')[0] : 'Ollama';
        var svg = b.querySelector('svg');
        var svgH = svg ? svg.outerHTML : '';
        b.innerHTML = svgH;
        b.appendChild(document.createTextNode(display));
    }

    // ============================================================
    // UI
    // ============================================================

    function _updateSubStatus() {
        var el = _el('translateIASubStatus');
        if (!el) return;
        var cues = _getCues();
        if (cues.length > 0) {
            el.textContent = '✓ ' + cues.length + ' subtítulos disponibles';
            el.style.color = 'var(--yt-green, #4caf50)';
        } else {
            el.textContent = 'Sin subtítulos — carga subtítulos primero';
            el.style.color = 'var(--yt-text-secondary, #aaa)';
        }
    }

    function _showSection(sec) {
        _setDisplay('translateIAConfig', sec === 'config' ? '' : 'none');
        _setDisplay('translateIAProgress', sec === 'progress' ? '' : 'none');
        _setDisplay('translateIAResult', sec === 'result' ? '' : 'none');
        _setDisplay('translateIAStartBtn', sec === 'config' ? 'inline-flex' : 'none');
        _setDisplay('translateIACancelBtn', sec === 'progress' ? 'inline-flex' : 'none');
    }

    function _resetToConfig() {
        if (_s.isTranslating) _cancel();
        _s.translatedCues = [];
        _showSection('config');
        var pb = _el('translateIAPreviewBody');
        if (pb) pb.innerHTML = '';
        var rb = _el('translateIAResultBody');
        if (rb) rb.innerHTML = '';
        var meta = _el('translateIAMeta');
        if (meta) meta.textContent = '';
    }

    function _updateProgress(done, total, cuesDone) {
        var pct = total > 0 ? Math.round((done / total) * 100) : 0;
        var pctEl = _el('translateIAProgressPct');
        if (pctEl) pctEl.textContent = pct + '%';
        var bar = _el('translateIAProgressBar');
        if (bar) { bar.style.width = pct + '%'; bar.setAttribute('aria-valuenow', pct); }
        var detail = _el('translateIAProgressDetail');
        if (detail) detail.textContent = 'Cue ' + done + ' / ' + total;
        var label = _el('translateIAProgressLabel');
        if (label) label.textContent = done >= total ? '✓ Traducción completa' : 'Traduciendo cue ' + (done + 1) + '…';
    }

    function _addPreviewRow(cue, translated, tbody) {
        if (!tbody) return;
        var tr = document.createElement('tr');
        if (!translated) tr.className = 'pending';
        else tr.className = 'just-translated';

        var tdTime = document.createElement('td');
        tdTime.textContent = _fmtTime(cue.inicio);
        tdTime.addEventListener('click', function () {
            var v = VP.refs && VP.refs.videoPlayer;
            if (v && !dom.esNulo(v)) { v.currentTime = cue.inicio; try { v.play(); } catch (_) {} }
        });

        var tdOrig = document.createElement('td');
        tdOrig.textContent = cue.texto || '';

        var tdTrans = document.createElement('td');
        tdTrans.textContent = translated || '…';

        tr.appendChild(tdTime);
        tr.appendChild(tdOrig);
        tr.appendChild(tdTrans);
        tbody.appendChild(tr);
    }

    function _renderResultTable(origCues, translatedCues) {
        var tbody = _el('translateIAResultBody');
        if (!tbody) return;
        tbody.innerHTML = '';

        for (var i = 0; i < origCues.length; i++) {
            var trans = translatedCues[i] ? translatedCues[i].texto : '';
            _addPreviewRow(origCues[i], trans, tbody);
        }
    }

    // ============================================================
    // PROMPT
    // ============================================================

    function _buildPrompt(cues, fromLang, toLang) {
        var fromStr = fromLang === 'auto'
            ? 'Detecta el idioma automáticamente'
            : 'El idioma original es: ' + fromLang;

        var lines = [
            'Eres un traductor profesional de subtítulos.',
            fromStr + '.',
            'Traduce TODOS los subtítulos al idioma: ' + toLang + '.',
            '',
            'REGLAS ESTRICTAS:',
            '1. Responde SOLO con un array JSON.',
            '2. Cada elemento debe tener exactamente un campo "t" con el texto traducido.',
            '3. Mantén EXACTAMENTE el mismo número de elementos que la entrada.',
            '4. NO agregues explicaciones ni texto fuera del JSON.',
            '5. Mantén el significado y tono del original.',
            '6. Si hay nombres propios, déjalos sin traducir.',
            '7. Si hay onomatopeyas o efectos de sonido, adapta al idioma destino.',
            '',
            'FORMATO — Entrada: array de textos. Salida: array de objetos {"t":"..."}',
            'Ejemplo entrada: ["Hello world","How are you?"]',
            'Ejemplo salida:  [{"t":"Hola mundo"},{"t":"¿Cómo estás?"}]',
            '',
            'SUBTÍTULOS A TRADUCIR:',
        ];

        var texts = [];
        for (var i = 0; i < cues.length; i++) {
            texts.push(cues[i].texto || cues[i].raw || '');
        }
        lines.push(JSON.stringify(texts));

        return lines.join('\n');
    }

    // ============================================================
    // PROMPT INDIVIDUAL (una sola línea / cue)
    // ============================================================

    function _buildPromptSingle(cue, fromLang, toLang) {
        var fromStr = fromLang === 'auto'
            ? 'Detecta el idioma automáticamente'
            : 'El idioma original es: ' + fromLang;

        return [
            'Eres un traductor profesional de subtítulos.',
            fromStr + '.',
            'Traduce al idioma: ' + toLang + '.',
            'REGLAS: Responde SOLO con el texto traducido, sin explicaciones, sin comillas, sin markdown.',
            'Si hay nombres propios, déjalos sin traducir.',
            'Si hay onomatopeyas o efectos de sonido, adapta al idioma destino.',
            'TEXTO A TRADUCIR:',
            cue.texto || cue.raw || '',
        ].join('\n');
    }

    function _parseSingle(rawText) {
        return (rawText || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/^["'\s]+|["'\s]+$/g, '')
            .trim();
    }

    // ============================================================
    // LLAMAR OLLAMA (sin streaming, respuesta completa)
    // ============================================================

    function _callOllama(baseUrl, model, prompt, signal) {
        var payload = JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            options: { temperature: 0.2, num_predict: 4096 },
        });
        var maxPayload = (VP.config && VP.config.maxPayloadOllamaChars) || 180000;
        if (payload.length > maxPayload) {
            return Promise.reject(new VP.ollama.OllamaError('Prompt demasiado grande para Ollama', 0, 'PAYLOAD_TOO_LARGE'));
        }
        return VP.ollama.fetchJSON(baseUrl + CFG.CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            signal: signal,
        }, 120000)
        .then(function (data) {
            if (data && data.message && data.message.content) {
                return data.message.content;
            }
            throw new Error('Respuesta vacía de Ollama');
        });
    }

    // ============================================================
    // PARSEAR RESPUESTA DE TRADUCCIÓN
    // ============================================================

    function _parseTranslation(rawText, expectedCount) {
        var text = rawText
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/gi, '')
            .trim();

        var start = text.indexOf('[');
        var end = text.lastIndexOf(']');
        if (start === -1 || end === -1) throw new Error('No se encontró array JSON');

        var jsonStr = text.slice(start, end + 1);
        var parsed;

        try {
            parsed = JSON.parse(jsonStr);
        } catch (e) {
            try { parsed = JSON.parse(jsonStr.replace(/'/g, '"').replace(/,(\s*[\]}])/g, '$1')); }
            catch (_) { throw new Error('JSON inválido: ' + e.message); }
        }

        if (!Array.isArray(parsed)) throw new Error('No es un array');

        var result = [];
        for (var i = 0; i < parsed.length; i++) {
            var item = parsed[i];
            var texto = '';
            if (typeof item === 'string') texto = item;
            else if (item && typeof item === 'object') texto = item.t || item.text || item.translation || '';
            result.push(texto);
        }

        if (result.length < expectedCount) {
            for (var j = result.length; j < expectedCount; j++) result.push('');
        }

        return result;
    }

    // ============================================================
    // FLUJO PRINCIPAL
    // ============================================================

    function _startTranslation() {
        if (_s.isTranslating) { _notif('Traducción en curso', 'advertencia'); return; }

        var modelEl = _el('translateIAModel');
        var model = modelEl ? modelEl.value.trim() : '';
        if (!model) { _notif('Selecciona un modelo', 'error'); return; }

        var urlEl = _el('translateIAUrl');
        var baseUrl = _normalizeUrl(urlEl ? urlEl.value : '');
        if (!_isValidUrl(baseUrl)) { _notif('URL inválida', 'error'); return; }

        var fromEl = _el('translateIAFrom');
        var toEl = _el('translateIATo');
        var fromLang = fromEl ? fromEl.value : 'auto';
        var toLang = toEl ? toEl.value : 'español';

        if (fromLang === toLang && fromLang !== 'auto') {
            _notif('Los idiomas de origen y destino son iguales', 'advertencia');
            return;
        }

        var cues = _getCues();
        if (!cues.length) { _notif('No hay subtítulos para traducir', 'advertencia'); return; }

        var videoId = _getVideoId();

        // Guardar preferencias
        try {
            util.storageSet(CFG.PREF_MODEL, model);
            util.storageSet(CFG.PREF_URL, baseUrl);
            util.storageSet(CFG.PREF_FROM, fromLang);
            util.storageSet(CFG.PREF_TO, toLang);
        } catch (_) {}

        // Verificar caché
        _loadTranslation(videoId, toLang).then(function (cached) {
            if (cached && cached.length >= cues.length) {
                _s.translatedCues = cached;
                _s.originalCues = cues.slice();
                _showResult(cues, cached, model, 0, '(desde caché)');
                _notif('Traducción restaurada desde caché', 'exito');
                return;
            }
            _executeTranslation(cues, baseUrl, model, fromLang, toLang, videoId);
        }).catch(function () {
            _executeTranslation(cues, baseUrl, model, fromLang, toLang, videoId);
        });
    }

    function _executeTranslation(cues, baseUrl, model, fromLang, toLang, videoId) {
        _s.isTranslating = true;
        if (VP.ajustes && VP.ajustes.activarMochiIA && VP.mochiMascota &&
                typeof VP.mochiMascota.entenderTraduccion === 'function') {
            VP.mochiMascota.entenderTraduccion();
        }
        _s.abortController = new AbortController();
        _s.originalCues = cues.slice();
        _s.translatedCues = [];
        _s.fromLang = fromLang;
        _s.toLang = toLang;

        _showSection('progress');

        var total = cues.length;
        var current = 0;
        var allTranslated = [];
        var startTime = Date.now();
        var previewBody = _el('translateIAPreviewBody');

        if (previewBody) previewBody.innerHTML = '';
        _updateProgress(0, total, 0);

        // Prepoblar tabla con todos los cues
        for (var p = 0; p < cues.length; p++) {
            _addPreviewRow(cues[p], null, previewBody);
        }

        function processCue() {
            if (_s.abortController && _s.abortController.signal.aborted) return;
            if (current >= total) {
                _onTranslationComplete(cues, allTranslated, model, startTime, videoId, toLang);
                return;
            }

            var cue = cues[current];
            var prompt = _buildPromptSingle(cue, fromLang, toLang);

            _callOllamaWithRetry(baseUrl, model, prompt, _s.abortController.signal, 0)
                .then(function (rawText) {
                    var translated = _parseSingle(rawText);
                    allTranslated.push(translated);

                    // Actualizar fila en preview
                    if (previewBody) {
                        var row = previewBody.children[current];
                        if (row) {
                            row.className = 'just-translated';
                            var tdTrans = row.children[2];
                            if (tdTrans) tdTrans.textContent = translated || '(vacío)';
                        }
                    }

                    current++;
                    _updateProgress(current, total, allTranslated.length);

                    // Scroll al último traducido
                    var scroll = _el('translateIAPreviewScroll');
                    if (scroll) {
                        var targetRow = previewBody && previewBody.children[allTranslated.length - 1];
                        if (targetRow) targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }

                    // Siguiente cue (pequeña pausa para no saturar)
                    setTimeout(processCue, 100);
                })
                .catch(function (err) {
                    if (err && err.name === 'AbortError') {
                        _notif('Traducción cancelada', 'info');
                    } else {
                        log.error('Error en cue ' + current + ':', err);
                        _notif('Error en cue ' + (current + 1) + ': ' + (err.message || err), 'error');

                        // Usar original para no perder sincronía
                        allTranslated.push(cue.texto || '');
                        current++;
                        _updateProgress(current, total, allTranslated.length);
                        setTimeout(processCue, 500);
                    }
                });
        }

        processCue();
    }

    function _callOllamaWithRetry(baseUrl, model, prompt, signal, attempt) {
        return _callOllama(baseUrl, model, prompt, signal)
            .catch(function (err) {
                if (err && err.name === 'AbortError') throw err;
                if (VP.ollama && typeof VP.ollama.isRetryableError === 'function' && !VP.ollama.isRetryableError(err)) {
                    throw err;
                }
                if (attempt < CFG.MAX_RETRIES) {
                    log.warn('Reintento ' + (attempt + 1) + '/' + CFG.MAX_RETRIES);
                    return new Promise(function (resolve) {
                        setTimeout(function () {
                            resolve(_callOllamaWithRetry(baseUrl, model, prompt, signal, attempt + 1));
                        }, CFG.RETRY_DELAY_MS * (attempt + 1));
                    });
                }
                throw err;
            });
    }

    function _onTranslationComplete(origCues, translations, model, startTime, videoId, toLang) {
        _s.isTranslating = false;
        _s.abortController = null;

        var translatedCues = [];
        for (var i = 0; i < origCues.length; i++) {
            translatedCues.push({
                inicio: origCues[i].inicio,
                fin: origCues[i].fin,
                texto: translations[i] || origCues[i].texto || '',
                raw: translations[i] || origCues[i].raw || '',
                indice: i,
            });
        }

        _s.translatedCues = translatedCues;
        _saveTranslation(videoId, toLang, translatedCues);

        var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        _showResult(origCues, translatedCues, model, elapsed);

        if (VP.ajustes && VP.ajustes.activarMochiIA && VP.mochiMascota &&
                typeof VP.mochiMascota.sorpresaTraduccion === 'function') {
            VP.mochiMascota.sorpresaTraduccion();
        }

        _notif(origCues.length + ' subtítulos traducidos en ' + elapsed + 's', 'exito');
        bus.emit('traduccionIA:completa', { videoId: videoId, lang: toLang, count: translatedCues.length });
        log.info('Completa →', translatedCues.length, 'cues |', elapsed + 's');
    }

    function _showResult(origCues, translatedCues, model, elapsed, extra) {
        _showSection('result');
        _renderResultTable(origCues, translatedCues);

        var meta = _el('translateIAMeta');
        if (meta) {
            meta.textContent = 'Modelo: ' + model +
                ' · ' + translatedCues.length + ' subtítulos' +
                ' · ' + (elapsed || '?') + 's' +
                (extra ? ' ' + extra : '');
        }
    }

    // ============================================================
    // APLICAR AL VIDEO
    // ============================================================

    function _applyToVideo() {
        if (!_s.translatedCues.length) { _notif('No hay traducción', 'error'); return; }

        var vttText = _cuesAVtt(_s.translatedCues);
        var video = VP.refs && VP.refs.videoPlayer;
        if (!video || dom.esNulo(video)) { _notif('No hay video activo', 'error'); return; }

        // Eliminar pistas traducidas previas
        var existentes = video.querySelectorAll('track[data-translated]');
        for (var i = 0; i < existentes.length; i++) {
            try {
                var src = existentes[i].src;
                existentes[i].parentNode.removeChild(existentes[i]);
                if (src && src.indexOf('blob:') === 0) {
                    try { URL.revokeObjectURL(src); } catch (_) {}
                }
            } catch (_) {}
        }

        try {
            var blob = new Blob([vttText], { type: 'text/vtt' });
            var url = URL.createObjectURL(blob);

            var track = document.createElement('track');
            track.kind = 'subtitles';
            track.srclang = _s.toLang.slice(0, 2).toLowerCase();
            track.label = 'Traducido (' + _s.toLang + ')';
            track.src = url;
            track.setAttribute('data-translated', 'true');
            track.default = true;

            track.addEventListener('load', function () {
                // Desactivar pista original
                for (var t = 0; t < video.textTracks.length; t++) {
                    if (video.textTracks[t] !== track.track) {
                        video.textTracks[t].mode = 'hidden';
                    }
                }
                track.track.mode = 'showing';
                VP.estado.subtitulosActivos = true;
            });

            video.appendChild(track);
            _notif('Subtítulos traducidos aplicados ✓', 'exito');
            _closeModal();

        } catch (e) {
            log.error('Error aplicando:', e);
            _notif('Error al aplicar subtítulos', 'error');
        }
    }

    // ============================================================
    // EXPORTAR
    // ============================================================

    function _cuesAVtt(cues) {
        var parts = ['WEBVTT\n'];
        for (var i = 0; i < cues.length; i++) {
            var c = cues[i];
            parts.push('\n' + _tsVtt(c.inicio) + ' --> ' + _tsVtt(c.fin) + '\n' + (c.texto || '') + '\n');
        }
        return parts.join('');
    }

    function _cuesASrt(cues) {
        var parts = [];
        for (var i = 0; i < cues.length; i++) {
            var c = cues[i];
            parts.push((i + 1) + '\n' + _tsSrt(c.inicio) + ' --> ' + _tsSrt(c.fin) + '\n' + (c.texto || '') + '\n\n');
        }
        return parts.join('');
    }

    function _tsVtt(s) {
        if (!isFinite(s) || s < 0) s = 0;
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
        var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
        var p3 = function (n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; };
        return p2(h) + ':' + p2(m) + ':' + p2(sc) + '.' + p3(ms);
    }

    function _tsSrt(s) { return _tsVtt(s).replace('.', ','); }

    function _exportAs(format) {
        if (!_s.translatedCues.length) { _notif('No hay traducción', 'error'); return; }

        var content = format === 'srt' ? _cuesASrt(_s.translatedCues) : _cuesAVtt(_s.translatedCues);
        var title = util.sanitizarNombreArchivo(util.obtenerNombreBase(_getVideoTitle()));

        var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = title + '_' + _s.toLang + '.' + format;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            try { document.body.removeChild(a); } catch (_) {}
            try { URL.revokeObjectURL(url); } catch (_) {}
        }, 1500);

        _notif('Exportado como .' + format, 'exito');
    }

    // ============================================================
    // CANCELAR
    // ============================================================

    function _cancel() {
        if (_s.abortController) { try { _s.abortController.abort(); } catch (_) {} }
        _s.isTranslating = false;
        _s.abortController = null;
        _showSection('config');
    }

    // ============================================================
    // MODAL
    // ============================================================

    function _openModal() {
        var modal = _el('translateIAModal');
        if (!modal) return;
        modal.classList.add('active');
        modal.removeAttribute('aria-hidden');
        modal.setAttribute('aria-modal', 'true');
        modal.focus();
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(true);

        var savedUrl = util.storageGet(CFG.PREF_URL, '');
        var urlEl = _el('translateIAUrl');
        if (savedUrl && urlEl) urlEl.value = savedUrl;

        var savedFrom = util.storageGet(CFG.PREF_FROM, 'auto');
        var fromEl = _el('translateIAFrom');
        if (fromEl) fromEl.value = savedFrom;

        var savedTo = util.storageGet(CFG.PREF_TO, 'español');
        var toEl = _el('translateIATo');
        if (toEl) toEl.value = savedTo;

        _populateModels(urlEl ? urlEl.value : '');
        _updateSubStatus();
        _showSection('config');
    }

    function _closeModal() {
        var modal = _el('translateIAModal');
        if (!modal) return;
        if (_s.isTranslating) {
            try { if (!window.confirm('Traducción en curso. ¿Cerrar y cancelar?')) return; } catch (_) {}
            _cancel();
        }
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(false);
    }

    // ============================================================
    // EVENTOS
    // ============================================================

    function _registerEvents() {
        _bind('translateIABtn', _openModal);
        _bind('translateIAModalClose', _closeModal);
        _bind('translateIAStartBtn', _startTranslation);
        _bind('translateIACancelBtn', _cancel);
        _bind('translateIAApplyBtn', _applyToVideo);
        _bind('translateIAExportVttBtn', function () { _exportAs('vtt'); });
        _bind('translateIAExportSrtBtn', function () { _exportAs('srt'); });
        _bind('translateIANewBtn', _resetToConfig);

        _bind('translateIARefreshModelsBtn', function () {
            var u = _el('translateIAUrl');
            _populateModels(u ? u.value : '');
        });

        _bind('translateIASwapBtn', function () {
            var from = _el('translateIAFrom');
            var to = _el('translateIATo');
            if (!from || !to) return;
            if (from.value === 'auto') { _notif('No se puede intercambiar con "auto"', 'info'); return; }
            var tmp = from.value;
            from.value = to.value;
            to.value = tmp;
        });

        var modal = _el('translateIAModal');
        if (modal) {
            _addTracked(modal, 'click', function (e) {
                if (e.target === modal) _closeModal();
            }, _s._docListeners);
        }

        if (typeof VP.eventos.registrarModalIA === 'function') {
            VP.eventos.registrarModalIA('translateIAModal', _closeModal);
        }

        var urlInput = _el('translateIAUrl');
        if (urlInput) {
            var deb = util.debounce(function () {
                var v = _normalizeUrl(urlInput.value);
                if (_isValidUrl(v)) _populateModels(v);
            }, 900);
            _addTracked(urlInput, 'input', deb, _s._docListeners);
        }

        var modelSel = _el('translateIAModel');
        if (modelSel) {
            _addTracked(modelSel, 'change', function () {
                try { util.storageSet(CFG.PREF_MODEL, modelSel.value); } catch (_) {}
                _updateBadge();
            }, _s._docListeners);
        }

        if (bus) {
            var busEvts = [
                ['videoCambiado', function () { _updateSubStatus(); }],
                ['subtitulosCargados', function () { _updateSubStatus(); }],
                ['cacheVaciada', function () { _cache.clear(); }],
                ['reset', function () { _cancel(); _cache.clear(); _s.translatedCues = []; }],
            ];
            for (var i = 0; i < busEvts.length; i++) {
                bus.on(busEvts[i][0], busEvts[i][1]);
                _s._busListeners.push({ event: busEvts[i][0], handler: busEvts[i][1] });
            }
        }
    }

    function _bind(id, fn) {
        var el = _el(id);
        if (el) _addTracked(el, 'click', fn, _s._docListeners);
    }

    // ============================================================
    // DESTRUIR
    // ============================================================

    function _destroy() {
        _cancel();
        _removeTracked(_s._docListeners);
        if (bus) {
            for (var i = 0; i < _s._busListeners.length; i++) {
                try { bus.off(_s._busListeners[i].event, _s._busListeners[i].handler); } catch (_) {}
            }
        }
        _s._busListeners.length = 0;
        _s._initialized = false;
    }

    // ============================================================
    // API PÚBLICA
    // ============================================================

    VP.traduccionIA = {
        open: _openModal,
        close: _closeModal,
        translate: _startTranslation,
        cancel: _cancel,
        apply: _applyToVideo,
        getTranslated: function () { return _s.translatedCues.slice(); },
        destroy: _destroy,
        obtenerMetricas: function () {
            return {
                isTranslating: _s.isTranslating,
                translatedCount: _s.translatedCues.length,
                currentVideoId: _s.currentVideoId,
                cacheSize: _cache.size ? _cache.size() : 0,
            };
        },
    };

    window.VP_TraduccionIA = VP.traduccionIA;

    // ============================================================
    // INIT
    // ============================================================

    function _init() {
        if (_s._initialized) return;
        _s._initialized = true;
        _registerEvents();
        log.info('Módulo iniciado v1.0.0');
    }

    function _waitForVP() {
        var done = false, att = 0;
        function tryInit() { if (done) return; done = true; _init(); }
        function poll() {
            if (done) return;
            if (++att > 200) { tryInit(); return; }
            if (VP.log && VP.bus && VP.dom && VP.util) { tryInit(); return; }
            setTimeout(poll, 25);
        }
        document.addEventListener('vpReady', tryInit);
        poll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _waitForVP);
    else _waitForVP();

    log.info('vp-traduccion-ia.js v1.0.0 cargado.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-traduccion-ia.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
