'use strict';

// ============================================================
// VP-VISION-IA.JS  —  v1.0.0
// Análisis visual de fotogramas con modelos de visión de Ollama.
//
// Captura el fotograma actual del video, lo envía como imagen
// base64 a un modelo con capacidad de visión (llava, moondream,
// bakllava, etc.) y muestra la respuesta en streaming.
//
// Persistencia: historial de análisis por video en IDB/LS.
// Dependencias: vp-base.js · vp-utilidades.js · vp-dom.js · vp-db.js
// ============================================================

(function (window, document) {
    if (window.__VP_VISION_IA_LOADED__) return;
    window.__VP_VISION_IA_LOADED__ = true;

    var VP = window.VP;
    if (!VP) throw new Error('[VP] vp-vision-ia.js: vp-base.js falta.');

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;
    log.setContext('VisionIA');

    if (!util || !dom || !log || !bus) {
        throw new Error('[VP] vp-vision-ia.js: dependencias faltantes.');
    }

    VP.visionIA = VP.visionIA || {};

    // ============================================================
    // CONSTANTES
    // ============================================================

    var CFG = Object.freeze({
        DEFAULT_URL     : 'http://localhost:11434',
        CHAT_ENDPOINT   : '/api/chat',
        MODELS_ENDPOINT : '/api/tags',
        FETCH_TIMEOUT   : 12000,
        STREAM_MAX      : 8000,
        CAPTURE_WIDTH   : 1280,
        CAPTURE_HEIGHT  : 720,
        CAPTURE_QUALITY : 0.85,
        MAX_HISTORY     : 30,
        STORAGE_PREFIX  : 'vpVisionIA_',
        PREF_MODEL      : 'visionIA_model',
        PREF_URL        : 'vp_ollama_url',
    });

    // ============================================================
    // ESTADO
    // ============================================================

    var _s = {
        abortController : null,
        isAnalyzing     : false,
        capturedB64     : null,
        capturedTime    : 0,
        capturedDataUrl : null,
        history         : [],
        currentVideoId  : '',
        streamingEl     : null,
        streamingText   : '',
        _docListeners   : [],
        _busListeners   : [],
        _initialized    : false,
    };

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
            try { store[i].target.removeEventListener(store[i].event, store[i].handler); }
            catch (_) {}
        }
        store.length = 0;
    }

    function _notif(m, t) {
        try { if (VP.ui && VP.ui.mostrarNotificacion) VP.ui.mostrarNotificacion(m, t || 'info'); }
        catch (_) {}
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
        return '';
    }

    function _getVideoTitle() {
        var ci = VP.estado && VP.estado.currentVideoIndex;
        var pl = VP.estado && VP.estado.playlist;
        if (typeof ci === 'number' && ci >= 0 && pl && pl[ci]) return pl[ci].name || 'video';
        return 'video';
    }

    function _escHTML(s) { return util.escaparHTML(s); }

    // ============================================================
    // CAPTURA DE FOTOGRAMA
    // ============================================================

    function _captureFrame() {
        var video = VP.refs && VP.refs.videoPlayer;
        if (!video || dom.esNulo(video)) {
            _notif('No hay video activo', 'advertencia'); return false;
        }
        if (!video.videoWidth || video.videoWidth === 0) {
            _notif('Video no listo para captura', 'advertencia'); return false;
        }

        try {
            var vw = video.videoWidth;
            var vh = video.videoHeight;

            var scale = Math.min(CFG.CAPTURE_WIDTH / vw, CFG.CAPTURE_HEIGHT / vh, 1);
            var cw = Math.round(vw * scale);
            var ch = Math.round(vh * scale);

            var canvas = _el('visionIACanvas');
            if (!canvas) return false;

            canvas.width  = cw;
            canvas.height = ch;
            var ctx = canvas.getContext('2d');
            if (!ctx) return false;

            ctx.drawImage(video, 0, 0, cw, ch);

            var dataUrl = canvas.toDataURL('image/jpeg', CFG.CAPTURE_QUALITY);

            if (!dataUrl || dataUrl.length < 200) {
                _notif('Fotograma vacío', 'advertencia'); return false;
            }

            // Extraer base64 sin prefijo
            var b64 = dataUrl.split(',')[1] || '';
            if (!b64) return false;

            _s.capturedB64     = b64;
            _s.capturedDataUrl = dataUrl;
            _s.capturedTime    = video.currentTime || 0;

            // Actualizar UI
            var overlay = _el('visionIAFrameOverlay');
            if (overlay) overlay.classList.add('hidden');

            var timeEl = _el('visionIAFrameTime');
            if (timeEl) {
                timeEl.textContent = _fmtTime(_s.capturedTime);
                timeEl.classList.add('visible');
            }

            _notif('📸 Fotograma capturado en ' + _fmtTime(_s.capturedTime), 'exito');
            if (VP.mochiMascota && typeof VP.mochiMascota.celebrarCaptura === 'function') VP.mochiMascota.celebrarCaptura();
            log.debug('Fotograma capturado:', cw + 'x' + ch, '|', Math.round(b64.length / 1024) + 'KB base64');

            return true;
        } catch (e) {
            log.error('Error capturando:', e);
            _notif('Error al capturar fotograma', 'error');
            return false;
        }
    }

    // ============================================================
    // MODELOS
    // ============================================================

    function _populateModels(rawUrl) {
        var sel = _el('visionIAModel');
        if (!sel) return;
        var base = _normalizeUrl(rawUrl);
        if (!_isValidUrl(base)) { sel.innerHTML = '<option value="">URL inválida</option>'; return; }

        sel.innerHTML = '<option value="">Cargando…</option>';
        sel.disabled = true;

        VP.ollama.fetchModels(base, { timeout: CFG.FETCH_TIMEOUT })
            .then(function (models) {

                if (!models.length) { sel.innerHTML = '<option value="">Sin modelos</option>'; sel.disabled = false; return; }

                var frag = document.createDocumentFragment();
                // Priorizar modelos de visión conocidos
                var visionFirst = [];
                var others = [];
                var visionNames = ['llava', 'moondream', 'bakllava', 'llava-llama3', 'minicpm-v', 'cogvlm'];

                for (var j = 0; j < models.length; j++) {
                    var lower = models[j].toLowerCase();
                    var isVision = false;
                    for (var v = 0; v < visionNames.length; v++) {
                        if (lower.indexOf(visionNames[v]) !== -1) { isVision = true; break; }
                    }
                    if (isVision) visionFirst.push(models[j]);
                    else others.push(models[j]);
                }

                var sorted = visionFirst.concat(others);

                for (var k = 0; k < sorted.length; k++) {
                    var o = document.createElement('option');
                    o.value = sorted[k];
                    o.textContent = sorted[k];
                    if (visionFirst.indexOf(sorted[k]) !== -1) {
                        o.textContent = '👁 ' + sorted[k];
                    }
                    frag.appendChild(o);
                }

                sel.innerHTML = ''; sel.appendChild(frag); sel.disabled = false;

                var saved = util.storageGet(CFG.PREF_MODEL, '');
                if (saved && sorted.indexOf(saved) >= 0) sel.value = saved;
                else if (visionFirst.length > 0) sel.value = visionFirst[0];

                _updateBadge();
            })
            .catch(function (e) {
                sel.innerHTML = '<option value="">Sin conexión</option>';
                sel.disabled = false;
            });
    }

    function _updateBadge() {
        var b = _el('visionIAModelBadge');
        if (!b) return;
        var m = _el('visionIAModel');
        var name = m ? m.value : '';
        var display = name ? name.split(':')[0] : 'Ollama';
        var svg = b.querySelector('svg');
        var svgH = svg ? svg.outerHTML : '';
        b.innerHTML = svgH;
        b.appendChild(document.createTextNode(display));
    }

    // ============================================================
    // ENVIAR ANÁLISIS
    // ============================================================

    function _sendAnalysis(prompt) {
        if (_s.isAnalyzing) {
            _notif('Análisis en curso…', 'advertencia'); return;
        }

        if (!_s.capturedB64) {
            // Intentar captura automática
            if (!_captureFrame()) return;
        }

        var modelEl = _el('visionIAModel');
        var model = modelEl ? modelEl.value.trim() : '';
        if (!model) {
            _notif('Selecciona un modelo de visión', 'advertencia');
            var config = _el('visionIAConfig');
            if (config && !config.open) config.open = true;
            return;
        }

        var urlEl = _el('visionIAUrl');
        var baseUrl = _normalizeUrl(urlEl ? urlEl.value : '');
        if (!_isValidUrl(baseUrl)) { _notif('URL inválida', 'error'); return; }

        prompt = (prompt || '').trim();
        if (!prompt) prompt = 'Describe detalladamente lo que ves en esta imagen.';

        // Guardar preferencias
        try {
            util.storageSet(CFG.PREF_MODEL, model);
            util.storageSet(CFG.PREF_URL, baseUrl);
        } catch (_) {}

        _s.isAnalyzing = true;
        _s.abortController = new AbortController();

        _setDisplay('visionIATyping', 'flex');
        var sendBtn = _el('visionIASendBtn');
        if (sendBtn) sendBtn.disabled = true;

        // Crear entrada en historial
        var entry = _createEntryEl(prompt, _s.capturedDataUrl, _s.capturedTime);
        var historyEl = _el('visionIAHistory');
        if (historyEl) historyEl.appendChild(entry.container);

        _s.streamingEl   = entry.bodyEl;
        _s.streamingText = '';

        log.info('Analizando con', model, '| prompt:', prompt.slice(0, 50));

        var messages = [
            {
                role: 'user',
                content: prompt,
                images: [_s.capturedB64],
            }
        ];

        _streamVision(baseUrl, model, messages, _s.abortController.signal)
            .then(function () {
                _finalizeEntry(entry, prompt);
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') {
                    _s.streamingText += '\n\n*(cancelado)*';
                    _notif('Análisis cancelado', 'info');
                } else {
                    _s.streamingText += '\n\n**Error:** ' + (err.message || err);
                    _notif('Error: ' + (err.message || err), 'error');
                    log.error('Error:', err);
                }
                _finalizeEntry(entry, prompt);
            })
            .then(function () {
                _s.isAnalyzing = false;
                _s.abortController = null;
                _setDisplay('visionIATyping', 'none');
                if (sendBtn) sendBtn.disabled = false;
                var input = _el('visionIAInput');
                if (input) { input.value = ''; input.focus(); }
            }, function () {
                _s.isAnalyzing = false;
                _s.abortController = null;
                _setDisplay('visionIATyping', 'none');
                if (sendBtn) sendBtn.disabled = false;
            });
    }

    function _createEntryEl(prompt, dataUrl, time) {
        var container = document.createElement('div');
        container.className = 'vision-ia-entry';

        var header = document.createElement('div');
        header.className = 'vision-ia-entry-header';

        if (dataUrl) {
            var thumb = document.createElement('img');
            thumb.className = 'vision-ia-entry-thumb';
            thumb.src = dataUrl;
            thumb.alt = 'Fotograma en ' + _fmtTime(time);
            header.appendChild(thumb);
        }

        var meta = document.createElement('div');
        meta.className = 'vision-ia-entry-meta';

        var timeSpan = document.createElement('span');
        timeSpan.className = 'vision-ia-entry-time';
        timeSpan.textContent = '⏱ ' + _fmtTime(time);
        // Click para saltar
        timeSpan.style.cursor = 'pointer';
        timeSpan.addEventListener('click', function () {
            var v = VP.refs && VP.refs.videoPlayer;
            if (v && !dom.esNulo(v)) { v.currentTime = time; try { v.play(); } catch (_) {} }
        });

        var promptSpan = document.createElement('div');
        promptSpan.className = 'vision-ia-entry-prompt';
        promptSpan.textContent = prompt;

        meta.appendChild(timeSpan);
        meta.appendChild(promptSpan);
        header.appendChild(meta);
        container.appendChild(header);

        var body = document.createElement('div');
        body.className = 'vision-ia-entry-body streaming';
        container.appendChild(body);

        _scrollHistoryBottom();

        return { container: container, bodyEl: body };
    }

    function _finalizeEntry(entry, prompt) {
        if (entry.bodyEl) {
            entry.bodyEl.classList.remove('streaming');
            entry.bodyEl.innerHTML = _renderMarkdown(_s.streamingText);
        }

        _s.history.push({
            prompt   : prompt,
            response : _s.streamingText,
            time     : _s.capturedTime,
            ts       : Date.now(),
        });

        if (_s.history.length > CFG.MAX_HISTORY) {
            _s.history = _s.history.slice(-CFG.MAX_HISTORY);
        }

        _saveHistory();
        _scrollHistoryBottom();
        _s.streamingEl = null;
        _s.streamingText = '';
    }

    // ============================================================
    // STREAMING OLLAMA VISION
    // ============================================================

    function _streamVision(baseUrl, model, messages, signal) {
        var payload = JSON.stringify({
            model: model,
            messages: messages,
            stream: true,
            options: { temperature: 0.4, num_predict: 2048 },
        });
        var maxPayload = (VP.config && VP.config.maxPayloadOllamaChars) || 180000;
        if (payload.length > maxPayload) {
            return Promise.reject(new Error('Prompt demasiado grande para Ollama'));
        }
        return VP.ollama.fetchWithTimeout(baseUrl + CFG.CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            signal: signal,
        }, Math.max(60000, CFG.FETCH_TIMEOUT))
        .then(function (res) {
            if (!res.ok) {
                return res.text().catch(function () { return ''; }).then(function (b) {
                    throw new Error('HTTP ' + res.status + (b ? ': ' + b.slice(0, 200) : ''));
                });
            }

            if (!res.body || typeof res.body.getReader !== 'function') {
                return res.json().then(function (d) {
                    if (d && d.error) throw new Error('Ollama: ' + String(d.error));
                    if (d && d.message && d.message.content) {
                        _s.streamingText = String(d.message.content);
                        _updateStreamingEl();
                    }
                });
            }

            var throttledUpdate = util.throttle(function () {
                _updateStreamingEl();
            }, 80);

            return VP.ollama.readStream(res.body, {
                signal: signal,
                maxTokens: CFG.STREAM_MAX,
                timeout: 300000,
                onToken: function (token, fullText) {
                    _s.streamingText = fullText;
                    throttledUpdate();
                },
                onDone: function (fullText) {
                    _s.streamingText = fullText;
                    _updateStreamingEl();
                }
            });
        });
    }

    function _updateStreamingEl() {
        if (_s.streamingEl) {
            _s.streamingEl.innerHTML = _renderMarkdown(_s.streamingText);
            _scrollHistoryBottom();
        }
    }

    function _scrollHistoryBottom() {
        var h = _el('visionIAHistory');
        if (h) requestAnimationFrame(function () { h.scrollTop = h.scrollHeight; });
    }

    // ============================================================
    // MARKDOWN LIGERO
    // ============================================================

    function _renderMarkdown(text) {
        if (!text) return '';
        var html = _escHTML(text);
        html = html.replace(/^#{1,4}\s+(.+)$/gm, '<span class="summary-heading">$1</span>');
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(?!\*)(.+?)\*(?!\*)/g, '<em>$1</em>');
        html = html.replace(/^[\s]*[-•]\s+(.+)$/gm, '<span class="summary-bullet">• $1</span>');
        html = html.replace(/^[\s]*(\d+)[.)]\s+(.+)$/gm, '<span class="summary-bullet">$1. $2</span>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\n\n+/g, '\n\n');
        html = html.replace(/\n/g, '<br>');
        html = html.replace(/(<br>){3,}/g, '<br><br>');
        return html;
    }

    // ============================================================
    // PERSISTENCIA
    // ============================================================

    function _saveHistory() {
        var videoId = _getVideoId();
        if (!videoId) return;

        var compact = _s.history.map(function (h) {
            return { p: h.prompt, r: h.response, t: h.time, ts: h.ts };
        });

        try { util.storageSet(CFG.STORAGE_PREFIX + videoId, compact); } catch (_) {}

        try {
            if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
                VP.db.guardarMetadatos(videoId, {
                    visionIA: compact,
                    visionIATs: Date.now(),
                }).catch(function () {});
            }
        } catch (_) {}
    }

    function _loadHistory() {
        if (!_s) return Promise.resolve();
        if (window.VP && VP.refs && VP.refs.videoPlayer) {
            _s.currentVideoId = _getVideoId();
        }
        if (!_s.currentVideoId) return Promise.resolve();

        var videoId = _s.currentVideoId;

        var stored = util.storageGet(CFG.STORAGE_PREFIX + videoId, null);
        if (stored && Array.isArray(stored) && stored.length) {
            _s.history = stored.map(function (h) {
                return { prompt: h.p, response: h.r, time: h.t, ts: h.ts };
            });
            return Promise.resolve();
        }

        if (VP.db && typeof VP.db.obtenerMetadatos === 'function') {
            return VP.db.obtenerMetadatos(videoId).then(function (meta) {
                if (meta && Array.isArray(meta.visionIA) && meta.visionIA.length) {
                    _s.history = meta.visionIA.map(function (h) {
                        return { prompt: h.p, response: h.r, time: h.t, ts: h.ts };
                    });
                }
            }).catch(function () {});
        }
        return Promise.resolve();
    }

    function _renderHistory() {
        var container = _el('visionIAHistory');
        if (!container) return;
        container.innerHTML = '';

        for (var i = 0; i < _s.history.length; i++) {
            var h = _s.history[i];
            var entry = _createEntryEl(h.prompt, null, h.time);
            entry.bodyEl.classList.remove('streaming');
            entry.bodyEl.innerHTML = _renderMarkdown(h.response);
            container.appendChild(entry.container);
        }

        _scrollHistoryBottom();
    }

    function _clearHistory() {
        var videoId = _getVideoId();
        _s.history = [];
        try { util.eliminarItem(CFG.STORAGE_PREFIX + videoId); } catch (_) {}
        var container = _el('visionIAHistory');
        if (container) container.innerHTML = '';
    }

    // ============================================================
    // EXPORTAR
    // ============================================================

    function _exportHistory() {
        if (!_s.history.length) { _notif('Nada que exportar', 'advertencia'); return; }

        var title = _getVideoTitle();
        var lines = [
            'ANÁLISIS VISUAL — ' + title,
            'Fecha: ' + new Date().toLocaleString(),
            'Entradas: ' + _s.history.length,
            '═'.repeat(50),
        ];

        for (var i = 0; i < _s.history.length; i++) {
            var h = _s.history[i];
            lines.push('');
            lines.push('─ En ' + _fmtTime(h.time) + ' ─');
            lines.push('Pregunta: ' + h.prompt);
            lines.push('Respuesta:');
            lines.push(h.response);
        }

        var safeName = util.sanitizarNombreArchivo(util.obtenerNombreBase(title));
        var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'vision_' + safeName + '.txt';
        a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(function () {
            try { document.body.removeChild(a); } catch (_) {}
            try { URL.revokeObjectURL(url); } catch (_) {}
        }, 1500);

        _notif('Análisis exportado', 'exito');
    }

    // ============================================================
    // MODAL
    // ============================================================

    function _poseAndCapture() {
        if (VP.mochiMascota && typeof VP.mochiMascota.posarFotograma === 'function') VP.mochiMascota.posarFotograma();
        setTimeout(_captureFrame, 1000);
    }

    function _openModal() {
        var modal = _el('visionIAModal');
        if (!modal) return;
        modal.classList.add('active');
        modal.removeAttribute('aria-hidden');
        modal.setAttribute('aria-modal', 'true');
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(true);

        var savedUrl = util.storageGet(CFG.PREF_URL, '');
        var urlEl = _el('visionIAUrl');
        if (savedUrl && urlEl) urlEl.value = savedUrl;

        _populateModels(urlEl ? urlEl.value : '');

        _s.currentVideoId = _getVideoId();
        _loadHistory().then(_renderHistory).catch(function (e) { log.warn('Error cargando historial:', e.message || e); });

        // Auto-captura si hay video
        var video = VP.refs && VP.refs.videoPlayer;
        if (video && !dom.esNulo(video) && video.src && video.videoWidth > 0) {
            _poseAndCapture();
        }

        setTimeout(function () {
            var input = _el('visionIAInput');
            if (input) input.focus();
        }, 150);
    }

    function _closeModal() {
        var modal = _el('visionIAModal');
        if (!modal) return;
        if (_s.isAnalyzing) {
            try { if (!window.confirm('Análisis en curso. ¿Cerrar?')) return; } catch (_) {}
            if (_s.abortController) try { _s.abortController.abort(); } catch (_) {}
        }
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        if (typeof VP.dom.inertMainContent === 'function') VP.dom.inertMainContent(false);
    }

    // ============================================================
    // EVENTOS
    // ============================================================

    function _registerEvents() {
        _bind('visionIABtn', _openModal);
        _bind('visionIAModalClose', _closeModal);
        _bind('visionIACaptureBtn', _poseAndCapture);
        _bind('visionIASendBtn', function () {
            var input = _el('visionIAInput');
            _sendAnalysis(input ? input.value : '');
        });
        _bind('visionIAClearBtn', function () {
            if (!_s.history.length) return;
            try { if (!window.confirm('¿Limpiar todo el historial?')) return; } catch (_) {}
            _clearHistory();
            _notif('Historial limpiado', 'info');
        });
        _bind('visionIAExportBtn', _exportHistory);

        _bind('visionIARefreshBtn', function () {
            var u = _el('visionIAUrl');
            _populateModels(u ? u.value : '');
        });

        // Input: Enter para enviar
        var input = _el('visionIAInput');
        if (input) {
            _addTracked(input, 'keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    _sendAnalysis(input.value);
                }
            }, _s._docListeners);

            _addTracked(input, 'input', function () {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 120) + 'px';
            }, _s._docListeners);
        }

        // Sugerencias
        var suggestions = _el('visionIASuggestions');
        if (suggestions) {
            _addTracked(suggestions, 'click', function (e) {
                var btn = e.target.closest ? e.target.closest('.vision-ia-suggest-btn') : null;
                if (!btn) {
                    var target = e.target;
                    while (target && target !== suggestions) {
                        if (target.classList && target.classList.contains('vision-ia-suggest-btn')) {
                            btn = target; break;
                        }
                        target = target.parentNode;
                    }
                }
                if (!btn || !btn.dataset.prompt) return;
                _sendAnalysis(btn.dataset.prompt);
            }, _s._docListeners);
        }

        // Modal click overlay
        var modal = _el('visionIAModal');
        if (modal) {
            _addTracked(modal, 'click', function (e) {
                if (e.target === modal) _closeModal();
            }, _s._docListeners);
        }

        // Escape (centralizado en vp-eventos.js)
        if (typeof VP.eventos.registrarModalIA === 'function') {
            VP.eventos.registrarModalIA('visionIAModal', _closeModal);
        }

        // URL debounce
        var urlInput = _el('visionIAUrl');
        if (urlInput) {
            var deb = util.debounce(function () {
                var v = _normalizeUrl(urlInput.value);
                if (_isValidUrl(v)) _populateModels(v);
            }, 900);
            _addTracked(urlInput, 'input', deb, _s._docListeners);
        }

        // Model change
        var modelSel = _el('visionIAModel');
        if (modelSel) {
            _addTracked(modelSel, 'change', function () {
                try { util.storageSet(CFG.PREF_MODEL, modelSel.value); } catch (_) {}
                _updateBadge();
            }, _s._docListeners);
        }

        // Bus
        if (bus) {
            var busEvts = [
                ['videoCambiado', function () {
                    _s.currentVideoId = _getVideoId();
                    _s.capturedB64 = null;
                    _s.capturedDataUrl = null;
                    var overlay = _el('visionIAFrameOverlay');
                    if (overlay) overlay.classList.remove('hidden');
                    var timeEl = _el('visionIAFrameTime');
                    if (timeEl) timeEl.classList.remove('visible');
                }],
                ['cacheVaciada', function () {
                    _s.history = [];
                    var container = _el('visionIAHistory');
                    if (container) container.innerHTML = '';
                }],
                ['reset', function () {
                    if (_s.abortController) try { _s.abortController.abort(); } catch (_) {}
                    _s.isAnalyzing = false;
                    _s.history = [];
                    _s.capturedB64 = null;
                }],
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
        if (_s.abortController) try { _s.abortController.abort(); } catch (_) {}
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

    VP.visionIA = {
        open: _openModal,
        close: _closeModal,
        capture: _captureFrame,
        analyze: _sendAnalysis,
        getHistory: function () { return _s.history.slice(); },
        clear: _clearHistory,
        exportar: _exportHistory,
        destroy: _destroy,
        obtenerMetricas: function () {
            return {
                isAnalyzing: _s.isAnalyzing,
                historyCount: _s.history.length,
                hasCaptured: !!_s.capturedB64,
                capturedTime: _s.capturedTime,
            };
        },
    };

    window.VP_VisionIA = VP.visionIA;

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

    log.info('vp-vision-ia.js v1.0.0 cargado.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-vision-ia.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
