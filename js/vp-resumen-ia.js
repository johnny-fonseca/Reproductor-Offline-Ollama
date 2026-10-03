/* =====================================================================
   vp-resumen-ia.js — Generación de resúmenes con IA (Ollama)
   Ventana flotante · streaming · markdown ligero · blindado
   ===================================================================== */
(function (window, document) {
    'use strict';

    if (window.__VP_RESUMEN_IA_LOADED__) return;
    window.__VP_RESUMEN_IA_LOADED__ = true;

    var VP = window.VP;

    /* ──────────────────────────────────────────────────────────────
       LOGGING SEGURO — nunca explota si VP.log no existe o le falta
       un método concreto.
       ────────────────────────────────────────────────────────────── */
    var _log = (function () {
        var base = (VP && VP.log) || console;
        if (VP && VP.log && typeof VP.log.setContext === 'function') {
            VP.log.setContext('SummaryIA');
        }
        // FIX: garantizamos que warn/error/info existen aunque base sea console
        return {
            warn:  function () { (typeof base.warn  === 'function' ? base.warn  : base.log).apply(base, arguments); },
            error: function () { (typeof base.error === 'function' ? base.error : base.log).apply(base, arguments); },
            info:  function () { (typeof base.info  === 'function' ? base.info  : base.log).apply(base, arguments); }
        };
    }());

    /* ──────────────────────────────────────────────────────────────
       HELPER: llama a un método anidado de VP de forma segura
       Ejemplo: _vpCall('dom.inertMainContent', true)
       ────────────────────────────────────────────────────────────── */
    function _vpCall(path, args) {
        try {
            var parts = path.split('.');
            var obj   = window.VP;
            for (var i = 0; i < parts.length - 1; i++) {
                if (!obj || typeof obj !== 'object') return;
                obj = obj[parts[i]];
            }
            var method = parts[parts.length - 1];
            if (obj && typeof obj[method] === 'function') {
                obj[method].apply(obj, args || []);
            }
        } catch (_) {}
    }

    /* ──────────────────────────────────────────────────────────────
       REFERENCIAS DOM  (lazy — se resuelven una sola vez)
       ────────────────────────────────────────────────────────────── */
    var _dom = null;

    function dom() {
        if (_dom) return _dom;
        _dom = {
            modal:          q('#summaryModal'),
            closeBtn:       q('#summaryModalClose'),
            openBtn:        q('#summaryBtn'),

            modelSelect:    q('#ollamaModel'),
            refreshBtn:     q('#refreshModelsBtn'),
            urlInput:       q('#ollamaUrl'),
            languageSelect: q('#summaryLanguage'),
            styleSelect:    q('#summaryStyle'),
            customPrompt:   q('#summaryCustomPrompt'),
            subtitleInfo:   q('#summarySubtitleInfo'),
            subtitleStatus: q('#summarySubtitleStatus'),
            modelBadge:     q('#summaryModelBadge'),

            configSection:  q('#summaryConfig'),
            loadingSection: q('#summaryLoading'),
            loadingMsg:     q('#summaryLoadingMsg'),
            streamPreview:  q('#summaryStreamPreview'),
            resultSection:  q('#summaryResult'),
            output:         q('#summaryOutput'),
            meta:           q('#summaryMeta'),

            generateBtn:    q('#generateSummaryBtn'),
            cancelBtn:      q('#cancelSummaryBtn'),
            copyBtn:        q('#copySummaryBtn'),
            exportBtn:      q('#exportSummaryBtn'),
            newBtn:         q('#newSummaryBtn'),

            video:          q('#videoPlayer')
        };
        return _dom;
    }

    /** querySelector blindado */
    function q(sel) {
        try { return document.querySelector(sel); }
        catch (_) { return null; }
    }

    /* ──────────────────────────────────────────────────────────────
       ESTADO
       ────────────────────────────────────────────────────────────── */
    var state = {
        abortController: null,
        isGenerating:    false,
        rawResponse:     '',
        renderedHTML:    '',
        startTime:       0,
        tokenCount:      null,
        modelUsed:       '',
        styleUsed:       '',
        videoDuration:   0,
        returnFocusElement: null,

        _initialized:     false,
        _listeners:       [],
        _busListeners:    [],
        _subtitleWatcher: null,
        _mochiThinkingTimer: null,
        _mochiBulbTimer: null,
    };

    /* ──────────────────────────────────────────────────────────────
       CONSTANTES
       ────────────────────────────────────────────────────────────── */
    var STORAGE_PREFIX  = 'summaryIA_';
    var PREF_URL        = 'vp_ollama_url';
    var PREF_MODEL      = STORAGE_PREFIX + 'model';
    var PREF_LANGUAGE   = 'vp_ia_language';
    var PREF_STYLE      = STORAGE_PREFIX + 'style';
    var PREF_PROMPT     = STORAGE_PREFIX + 'prompt';
    var DEFAULT_URL     = 'http://localhost:11434';

    /* ──────────────────────────────────────────────────────────────
       ESTILOS DE RESUMEN
       ────────────────────────────────────────────────────────────── */
    var STYLE_PROMPTS = {
        conciso:
            'Genera un resumen conciso con 3 a 5 puntos clave.\n' +
            'Usa viñetas (•) para cada punto. Sé directo y breve.',

        detallado:
            'Genera un resumen detallado y exhaustivo.\n' +
            'Incluye todos los temas tratados, argumentos principales, ' +
            'datos mencionados y conclusiones.\n' +
            'Organiza el contenido con secciones claras.',

        bullet:
            'Genera una lista con viñetas (•) de todos los puntos importantes.\n' +
            'Cada viñeta debe ser una idea completa pero concisa.\n' +
            'Agrupa las viñetas por tema si es posible.',

        parrafo:
            'Genera un resumen narrativo en forma de párrafos.\n' +
            'Escribe de forma fluida y natural, como un artículo periodístico.\n' +
            'Incluye introducción, desarrollo y conclusión.',

        actas:
            'Genera un acta/minuta del contenido con el siguiente formato:\n' +
            '- TEMA PRINCIPAL\n' +
            '- PUNTOS TRATADOS (lista numerada)\n' +
            '- ACUERDOS/CONCLUSIONES\n' +
            '- DATOS RELEVANTES MENCIONADOS\n' +
            'Sé formal y preciso.'
    };

    var STYLE_NAMES = {
        conciso:   'Conciso',
        detallado: 'Detallado',
        bullet:    'Viñetas',
        parrafo:   'Párrafo',
        actas:     'Actas'
    };

    /* ═══════════════════════════════════════════════════════════════
       INIT
       ═══════════════════════════════════════════════════════════════ */
    function init() {
        if (state._initialized) return;
        state._initialized = true;

        var d = dom();
        if (!d.modal || !d.openBtn) {
            _log.warn('Elementos DOM faltantes, módulo desactivado.');
            return;
        }
        restoreSavedConfig();
        bindEvents();
        registerBusEvents();
        safeRun(updateSubtitleStatus);
    }

    /* ═══════════════════════════════════════════════════════════════
       EVENTOS
       ═══════════════════════════════════════════════════════════════ */
    function bindEvents() {
        var d = dom();

        _addTracked(d.openBtn,  'click', toggleModal);
        _addTracked(d.closeBtn, 'click', closeModal);

        _addTracked(d.modal, 'keydown', function (e) {
            if (e.key === 'Escape') closeModal();
        });

        _addTracked(d.refreshBtn,     'click',  function () { fetchModels(true); });
        _addTracked(d.urlInput,       'change', function () { _saveUrl(); });
        _addTracked(d.languageSelect, 'change', function () { _saveLang(); });
        _addTracked(d.styleSelect,    'change', function () { _saveStyle(); });
        _addTracked(d.customPrompt,   'change', function () { _savePrompt(); });
        _addTracked(d.modelSelect,    'change', function () { _saveModel(); });

        _addTracked(d.generateBtn, 'click', generateSummary);
        _addTracked(d.cancelBtn,   'click', cancelGeneration);

        _addTracked(d.copyBtn,   'click', copySummary);
        _addTracked(d.exportBtn, 'click', exportSummary);
        _addTracked(d.newBtn,    'click', resetToConfig);

        if (d.video) {
            _addTracked(d.video, 'loadedmetadata', onVideoMeta);
            _addTracked(d.video, 'durationchange', onVideoDuration);
        }

        // FIX: el clic en el fondo también pide confirmación si se está generando
        _addTracked(d.modal, 'click', function (e) {
            if (e.target === d.modal) closeModal();
        });

        _addTracked(window, 'vpSubtitleCuesReady', onSubtitleCuesReady);
    }

    function onSubtitleCuesReady() {
        safeRun(updateSubtitleStatus);
    }

    function onVideoMeta()     { safeRun(updateSubtitleStatus); refreshDuration(); }
    function onVideoDuration() { refreshDuration(); }

    function refreshDuration() {
        var d = dom();
        state.videoDuration = (d.video && isFinite(d.video.duration))
            ? d.video.duration : 0;
    }

    /** addEventListener tracked (removible via _destroy) */
    function _addTracked(el, evt, fn) {
        if (!el || typeof el.addEventListener !== 'function') return;
        el.addEventListener(evt, fn);
        state._listeners.push({ target: el, event: evt, handler: fn });
    }

    function _removeTracked() {
        for (var i = 0; i < state._listeners.length; i++) {
            try {
                state._listeners[i].target.removeEventListener(
                    state._listeners[i].event,
                    state._listeners[i].handler
                );
            } catch (_) {}
        }
        state._listeners.length = 0;
    }

    /** Ejecutar con try-catch, loguea el nombre de la función si falla */
    function safeRun(fn) {
        try { fn(); } catch (e) { _log.error((fn && fn.name) || 'safeRun', e); }
    }

    /* ═══════════════════════════════════════════════════════════════
       MODAL
       ═══════════════════════════════════════════════════════════════ */
    function toggleModal() {
        var d = dom();
        if (!d.modal) return;
        d.modal.classList.contains('active') ? closeModal() : openModal();
    }

    function openModal() {
        var d = dom();
        if (!d.modal) return;
        if (!d.modal.classList.contains('active')) {
            var active = document.activeElement;
            state.returnFocusElement = active && active !== document.body && !d.modal.contains(active)
                ? active
                : d.openBtn;
        }
        d.modal.classList.add('active');
        d.modal.removeAttribute('aria-hidden');
        d.modal.setAttribute('aria-modal', 'true');
        d.modal.focus();
        // FIX: guard nulo antes de llamar VP.dom.*
        _vpCall('dom.inertMainContent', [true]);
        safeRun(updateSubtitleStatus);
        fetchModels(false);
        refreshDuration();
    }

    function closeModal() {
        var d = dom();
        if (!d.modal) return;
        if (state.isGenerating) {
            if (!confirm('Se está generando un resumen. ¿Cancelar y cerrar?')) return;
            cancelGeneration();
        }

        // Quita inert y devuelve el foco antes de ocultar el modal para no
        // dejar a un descendiente enfocado bajo aria-hidden.
        _vpCall('dom.inertMainContent', [false]);
        var returnTarget = state.returnFocusElement;
        if (!returnTarget || typeof returnTarget.focus !== 'function' ||
                (typeof returnTarget.isConnected === 'boolean' && !returnTarget.isConnected) ||
                d.modal.contains(returnTarget)) {
            returnTarget = d.openBtn;
        }
        try {
            if (returnTarget && typeof returnTarget.focus === 'function') returnTarget.focus();
        } catch (_) {}
        if (d.modal.contains(document.activeElement) && document.activeElement &&
                typeof document.activeElement.blur === 'function') {
            try { document.activeElement.blur(); } catch (_) {}
        }

        d.modal.classList.remove('active');
        d.modal.setAttribute('aria-hidden', 'true');
        // FIX: limpiar aria-modal al cerrar (antes se dejaba puesto)
        d.modal.removeAttribute('aria-modal');
        state.returnFocusElement = null;
    }

    /* ═══════════════════════════════════════════════════════════════
       CONFIGURACIÓN PERSISTENTE
       ═══════════════════════════════════════════════════════════════ */
    function getOllamaUrl() {
        var d   = dom();
        // FIX: trim() para eliminar espacios accidentales al inicio/fin
        var raw = (d.urlInput && d.urlInput.value)
            ? d.urlInput.value.trim()
            : DEFAULT_URL;
        return raw.replace(/\/+$/, '') || DEFAULT_URL;
    }

    // FIX: parámetro renombrado de "val" a "value" para no ocultar la función val()
    function _savePref(key, value) {
        try {
            if (VP && VP.util && typeof VP.util.storageSet === 'function') {
                VP.util.storageSet(key, value);
            }
        } catch (_) {}
    }

    function _loadPref(key, def) {
        try {
            if (VP && VP.util && typeof VP.util.storageGet === 'function') {
                return VP.util.storageGet(key, def);
            }
            return def || '';
        } catch (_) { return def || ''; }
    }

    function _saveUrl()   { _savePref(PREF_URL, getOllamaUrl()); }
    function _loadUrl()   { return _loadPref(PREF_URL, DEFAULT_URL); }
    function _saveModel() { _savePref(PREF_MODEL, val(dom().modelSelect)); }
    function _loadModel() { return _loadPref(PREF_MODEL, ''); }
    function _saveLang()  { _savePref(PREF_LANGUAGE, val(dom().languageSelect)); }
    function _loadLang()  { return _loadPref(PREF_LANGUAGE, 'español'); }
    function _saveStyle() { _savePref(PREF_STYLE, val(dom().styleSelect)); }
    function _loadStyle() { return _loadPref(PREF_STYLE, 'conciso'); }
    function _savePrompt(){ _savePref(PREF_PROMPT, val(dom().customPrompt)); }
    function _loadPrompt(){ return _loadPref(PREF_PROMPT, ''); }

    function restoreSavedConfig() {
        var d = dom();
        var url = _loadUrl();
        if (url && d.urlInput) d.urlInput.value = url;
        var lang = _loadLang();
        if (lang && d.languageSelect) d.languageSelect.value = lang;
        var style = _loadStyle();
        if (style && d.styleSelect) d.styleSelect.value = style;
        var prompt = _loadPrompt();
        if (prompt && d.customPrompt) d.customPrompt.value = prompt;
    }

    /* ═══════════════════════════════════════════════════════════════
       MODELOS
       ═══════════════════════════════════════════════════════════════ */
    async function fetchModels(showFeedback) {
        var d   = dom();
        var sel = d.modelSelect;
        if (!sel) return;

        // FIX: guard nulo para VP.ollama
        if (!VP || !VP.ollama || typeof VP.ollama.fetchModels !== 'function') {
            _log.warn('VP.ollama.fetchModels no disponible');
            sel.innerHTML = '<option value="">Ollama no disponible</option>';
            return;
        }

        try {
            sel.innerHTML = '<option value="">Cargando...</option>';
            sel.disabled  = true;

            var models = await VP.ollama.fetchModels(getOllamaUrl(), { timeout: 8000 });

            if (!models || models.length === 0) {
                sel.innerHTML = '<option value="">Sin modelos</option>';
                sel.disabled  = false;
                if (showFeedback) _notif('No se encontraron modelos en Ollama', 'advertencia');
                return;
            }

            sel.innerHTML = models.map(function (m) {
                return '<option value="' + escAttr(m) + '">' + esc(m) + '</option>';
            }).join('');

            var saved = _loadModel();
            if (saved && models.indexOf(saved) !== -1) sel.value = saved;

            sel.disabled = false;
            if (showFeedback) _notif(models.length + ' modelo(s) encontrado(s)', 'exito');

        } catch (err) {
            _log.warn('Modelos:', (err && err.message) || err);
            sel.innerHTML = '<option value="">Error de conexión</option>';
            sel.disabled  = false;
            if (showFeedback) _notif('No se pudo conectar con Ollama', 'error');
        }
    }

    /* ═══════════════════════════════════════════════════════════════
       SUBTÍTULOS
       ═══════════════════════════════════════════════════════════════ */
    function getSubtitleText() {
        try {
            // 1. vpSubtitleCues (establecido por vp-subtitulos.js al activar subtítulos)
            var globalCues = window.vpSubtitleCues;
            if (Array.isArray(globalCues) && globalCues.length) {
                var lines = [];
                for (var k = 0; k < globalCues.length; k++) {
                    var c   = globalCues[k];
                    var txt = ((c.texto || c.text || '') + '').trim();
                    if (txt) lines.push('[' + fmtTime(c.inicio || c.startTime || 0) + '] ' + txt);
                }
                if (lines.length) return lines.join('\n');
            }

            // 2. textTracks del video
            var d = dom();
            if (d.video && d.video.textTracks) {
                for (var i = 0; i < d.video.textTracks.length; i++) {
                    var track = d.video.textTracks[i];
                    if (!track.cues || !track.cues.length) continue;
                    var lines2 = [];
                    for (var j = 0; j < track.cues.length; j++) {
                        var cue  = track.cues[j];
                        var txt2 = ((cue.text || '') + '').trim();
                        if (txt2) lines2.push('[' + fmtTime(cue.startTime || 0) + '] ' + txt2);
                    }
                    if (lines2.length) return lines2.join('\n');
                }
            }
        } catch (e) {
            _log.warn('Error leyendo subtítulos:', e);
        }
        return '';
    }

    function updateSubtitleStatus() {
        var d    = dom();
        var text = getSubtitleText();
        var has  = text.length > 0;
        var n    = has ? text.split('\n').length : 0;
        var kb   = has ? fmtBytes(text.length)   : '';

        if (d.subtitleStatus) {
            d.subtitleStatus.textContent = has
                ? '✓ ' + n + ' líneas (' + kb + ') de subtítulos disponibles'
                : 'Sin subtítulos disponibles. Asegúrate de que el video tenga pistas de subtítulos incrustadas o archivos .vtt asociados.';
        }
        if (d.subtitleInfo) {
            d.subtitleInfo.classList.toggle('has-subs', has);
        }

        if (!has) {
            startSubtitleWatcher();
        } else {
            // FIX: cancelar watcher si los subtítulos ya aparecieron
            _clearSubtitleWatcher();
        }
    }

    function _clearSubtitleWatcher() {
        if (state._subtitleWatcher !== null) {
            clearTimeout(state._subtitleWatcher);
            state._subtitleWatcher = null;
        }
    }

    function _mochiSummaryStart(complexity) {
        var mochi = VP && VP.mochiMascota;
        if (!mochi || !(VP.ajustes && VP.ajustes.activarMochiIA)) return;
        if (state._mochiThinkingTimer) clearTimeout(state._mochiThinkingTimer);
        if (state._mochiBulbTimer) clearTimeout(state._mochiBulbTimer);
        state._mochiBulbTimer = null;
        mochi.setOllamaStatus('waiting');
        mochi.setState('pensando');
        var delay = 1500 + Math.min(1000, Math.max(0, Number(complexity) || 0));
        state._mochiThinkingTimer = setTimeout(function () {
            state._mochiThinkingTimer = null;
            if (!state.isGenerating || !VP.mochiMascota) return;
            VP.mochiMascota.setOllamaStatus('respuesta');
        }, delay);
    }

    function _mochiSummaryFinish(success) {
        var mochi = VP && VP.mochiMascota;
        if (state._mochiThinkingTimer) clearTimeout(state._mochiThinkingTimer);
        state._mochiThinkingTimer = null;
        if (!mochi || !(VP.ajustes && VP.ajustes.activarMochiIA)) return;
        if (state._mochiBulbTimer) clearTimeout(state._mochiBulbTimer);
        if (success) {
            mochi.setOllamaStatus('respuesta');
            if (typeof mochi.celebrar === 'function') mochi.celebrar(2700);
            else mochi.setState('celebrando', true, { duracion: 2700 });
            state._mochiBulbTimer = setTimeout(function () {
                state._mochiBulbTimer = null;
                if (VP.mochiMascota) VP.mochiMascota.setOllamaStatus('idle');
            }, 2800);
        } else {
            mochi.setOllamaStatus('idle');
            mochi.setState('idle');
        }
    }

    function startSubtitleWatcher() {
        // FIX: evitar duplicados sin necesitar la guard de estado anterior
        if (state._subtitleWatcher !== null) return;
        var d = dom();
        if (!d.video || !d.video.src) return;

        var retries    = 0;
        var maxRetries = 5;

        function poll() {
            retries++;
            var text = getSubtitleText();
            if (text.length > 0) {
                // FIX: limpiar referencia antes de llamar updateSubtitleStatus
                // para que ésta no llame a startSubtitleWatcher de nuevo
                state._subtitleWatcher = null;
                safeRun(updateSubtitleStatus);
                return;
            }
            if (retries < maxRetries) {
                state._subtitleWatcher = setTimeout(poll, 2000);
            } else {
                state._subtitleWatcher = null;
            }
        }

        state._subtitleWatcher = setTimeout(poll, 2000);
    }

    /* ═══════════════════════════════════════════════════════════════
       GENERACIÓN PRINCIPAL
       ═══════════════════════════════════════════════════════════════ */
    async function generateSummary() {
        // FIX: guard contra doble clic / llamadas concurrentes
        if (state.isGenerating) {
            _notif('Ya se está generando un resumen', 'advertencia');
            return;
        }

        // FIX: guard nulo para VP.ollama
        if (!VP || !VP.ollama || typeof VP.ollama.chat !== 'function') {
            _notif('VP.ollama no disponible', 'error');
            return;
        }

        var d = dom();

        // ── Validaciones ──
        var model = val(d.modelSelect);
        if (!model) {
            _notif('Selecciona un modelo de IA', 'advertencia');
            return;
        }

        var subtitleText = getSubtitleText();
        var duration     = state.videoDuration ||
                           (d.video && isFinite(d.video.duration) ? d.video.duration : 0);

        if (!subtitleText && !duration) {
            _notif('Carga un video con subtítulos para generar un resumen', 'advertencia');
            return;
        }

        var language     = val(d.languageSelect) || 'español';
        var style        = val(d.styleSelect)    || 'conciso';
        var customPrompt = (val(d.customPrompt)  || '').trim();

        // ── Validación del payload ANTES de cambiar la UI ──
        // FIX: movido antes de showSection('result') para no mostrar sección vacía en error
        var promptOptions = {
            subtitleText: subtitleText,
            duration:     duration,
            language:     language,
            style:        style,
            customPrompt: customPrompt
        };
        var prompt = buildPrompt(promptOptions);

        var body = {
            model:    model,
            messages: [
                { role: 'system', content: getSystemPrompt(language, style) },
                { role: 'user',   content: prompt }
            ],
            stream:  true,
            options: { temperature: 0.4, top_p: 0.92, num_predict: 4096 }
        };

        var payload    = JSON.stringify(body);
        var maxPayload = (VP && VP.config && VP.config.maxPayloadOllamaChars) || 180000;
        if (payload.length > maxPayload) {
            _notif('El contenido es demasiado extenso para enviarlo a Ollama', 'error');
            return;
        }

        // ── UI: loading ──
        showSection('loading');
        setText(d.loadingMsg,    'Conectando con Ollama...');
        setText(d.streamPreview, '');
        setDisplay(d.cancelBtn,  '');
        if (d.output) d.output.classList.remove('generating');

        // ── Estado ──
        state.isGenerating    = true;
        state.rawResponse     = '';
        state.renderedHTML    = '';
        state.startTime       = Date.now();
        state.tokenCount      = null;
        state.modelUsed       = model;
        state.styleUsed       = style;
        state.abortController = new AbortController();
        var complexity = Math.min(1000, Math.round((subtitleText.length / 50000) * 1000) +
            (style === 'detallado' ? 200 : 0) + Math.min(150, Math.round(customPrompt.length / 8)));
        _mochiSummaryStart(complexity);

        _savePref(PREF_MODEL,    model);
        _savePref(PREF_URL,      getOllamaUrl());
        _savePref(PREF_LANGUAGE, language);
        _savePref(PREF_STYLE,    style);
        _savePref(PREF_PROMPT,   customPrompt);

        try {
            showSection('result');
            if (d.output) {
                d.output.innerHTML = '';
                d.output.classList.add('generating');
            }
            if (d.meta) d.meta.innerHTML = '';

            var lastRender = 0;
            var streamChunkCount = 0;
            var contextRetries = 0;
            var maxSubtitleChars = 50000;
            var responseText;
            while (true) {
                try {
                    responseText = await VP.ollama.chat(getOllamaUrl(), body, {
                        signal: state.abortController.signal,
                        timeout: 300000,
                        onToken: function (token, fullText) {
                            state.rawResponse = fullText;
                            streamChunkCount++;
                            var now = Date.now();
                            if (streamChunkCount % 3 === 0 || (now - lastRender) > 120) {
                                renderStreamingOutput();
                                lastRender = now;
                            }
                        },
                        onDone: function (_fullText, stats) {
                            state.tokenCount = stats && Number.isFinite(stats.tokens) ? stats.tokens : null;
                        }
                    }, { timeout: 120000 });
                    break;
                } catch (requestError) {
                    if (!isContextLengthError(requestError) || !subtitleText ||
                            contextRetries >= 3 || state.rawResponse.length > 0) {
                        throw requestError;
                    }

                    contextRetries++;
                    maxSubtitleChars = Math.floor(maxSubtitleChars / 2);
                    promptOptions.maxSubtitleChars = maxSubtitleChars;
                    body.messages[1].content = buildPrompt(promptOptions);
                    body.options.num_predict = Math.max(512, Math.floor(body.options.num_predict / 2));
                    state.rawResponse = '';
                    state.tokenCount = null;
                    streamChunkCount = 0;
                    if (d.output) {
                        d.output.textContent = 'El modelo necesita menos contexto. Reintentando con una selección más breve de subtítulos…';
                    }
                }
            }

            state.rawResponse = typeof responseText === 'string' ? responseText : '';
            if (!state.rawResponse.trim()) {
                var emptyResponse = new Error('Ollama terminó la solicitud sin generar texto.');
                emptyResponse.code = 'EMPTY_RESPONSE';
                throw emptyResponse;
            }

            // ── Render final ──
            if (d.output) d.output.classList.remove('generating');
            renderFinalOutput();
            showMeta(false);
            _mochiSummaryFinish(true);
            _notif('Resumen generado correctamente', 'exito');

        } catch (err) {
            _mochiSummaryFinish(false);
            handleError(err);
        } finally {
            state.isGenerating    = false;
            state.abortController = null;
            setDisplay(d.cancelBtn, 'none');
            if (d.output) d.output.classList.remove('generating');
        }
    }

    function handleError(err) {
        var d = dom();
        if (d.output) d.output.classList.remove('generating');

        var isAbort = err && err.name === 'AbortError';
        var hasData = state.rawResponse.length > 20;

        if (isAbort) {
            _notif('Generación cancelada', 'info');
        } else {
            _log.error('Error en generateSummary:', err);
            // FIX: mensaje más descriptivo extrayendo causa raíz si existe
            var msg = (err && (err.message || err.cause || String(err))) || 'error desconocido';
            if (err && (err.status === 400 || err.code === 'BAD_REQUEST')) {
                msg = isContextLengthError(err)
                    ? 'El modelo rechazó el tamaño del contexto. Se intentó reducir los subtítulos automáticamente. ' + msg
                    : 'Ollama rechazó la solicitud (HTTP 400): ' + msg;
            }
            _notif('Error: ' + msg, 'error');
        }

        if (hasData) {
            renderFinalOutput();
            showMeta(true);
        } else {
            resetToConfig();
        }
    }

    function cancelGeneration() {
        if (state.abortController) {
            try { state.abortController.abort(); } catch (_) {}
        }
        // Nota: state.isGenerating se limpia en el finally de generateSummary
    }

    function isContextLengthError(err) {
        if (err && (err.name === 'AbortError' || err.code === 'ABORTED' ||
                (VP && VP.ollama && typeof VP.ollama.isAbortError === 'function' && VP.ollama.isAbortError(err)))) {
            return false;
        }
        var message = err && (err.message || err.error || String(err));
        return /num_ctx|too many tokens|prompt.{0,20}(too long|too large)|(?:context|input length|tokens?).{0,40}(?:length|limit|window|exceed|too large|too long|maximum)|(?:input|prompt).{0,40}(?:exceed|too many|maximum|limit)/i
            .test(String(message || ''));
    }

    /* ═══════════════════════════════════════════════════════════════
       PROMPTS
       ═══════════════════════════════════════════════════════════════ */
    function getSystemPrompt(language, style) {
        return [
            'Eres un asistente experto en análisis y resumen de contenido audiovisual.',
            'Tu tarea es generar resúmenes claros, precisos y bien estructurados.',
            '',
            'REGLAS:',
            '1. Responde SIEMPRE en ' + language,
            '2. Sé fiel al contenido original, no inventes información',
            '3. Usa un tono profesional pero accesible',
            '4. Estructura tu respuesta de forma clara y legible',
            '5. Si el contenido es técnico, mantén la terminología adecuada',
            '6. No incluyas disclaimers ni meta-comentarios sobre tu proceso'
        ].join('\n');
    }

    function buildPrompt(opts) {
        var durStr     = opts.duration ? fmtTime(opts.duration) : 'desconocida';
        var styleInstr = STYLE_PROMPTS[opts.style] || STYLE_PROMPTS.conciso;
        var subs       = opts.subtitleText;
        var extra      = opts.customPrompt;
        var prompt     = '';

        if (subs && subs.length > 10) {
            var processed = subs;
            var maxChars  = Number(opts.maxSubtitleChars);
            if (!isFinite(maxChars) || maxChars < 1000) maxChars = 50000;

            if (processed.length > maxChars) {
                processed = truncateSmart(processed, maxChars);
            }

            prompt = 'Analiza el siguiente contenido de un video (duración: ' + durStr +
                     ') y genera un resumen.\n\n' +
                     'ESTILO SOLICITADO:\n' + styleInstr + '\n\n' +
                     'TRANSCRIPCIÓN/SUBTÍTULOS:\n' + processed;
        } else {
            // FIX: escapar el nombre del video para evitar inyección en el prompt
            var videoName = escPrompt(getVideoName());
            prompt = 'Se ha cargado un video "' + videoName + '" (duración: ' + durStr +
                     ') pero no tiene subtítulos disponibles.\n\n' +
                     'ESTILO SOLICITADO:\n' + styleInstr + '\n\n' +
                     'Como no hay subtítulos, genera una plantilla de resumen que el ' +
                     'usuario pueda completar.\n' +
                     'Incluye secciones típicas como: Tema principal, Puntos clave, Conclusiones.\n' +
                     'Usa el título del video ("' + videoName + '") para inferir el posible tema.\n' +
                     'Indica que el resumen sería más preciso con subtítulos.';
        }

        if (extra) {
            prompt += '\n\nINSTRUCCIÓN ADICIONAL DEL USUARIO:\n' + escPrompt(extra);
        }

        return prompt;
    }

    /**
     * Elimina secuencias que podrían interferir con la estructura del prompt
     * (comillas triples, "INSTRUCCIÓN:", etc.).
     * No es un escape de seguridad duro — Ollama corre localmente —
     * pero evita confundir el modelo.
     */
    function escPrompt(str) {
        if (!str) return '';
        return str
            .replace(/"""/g, "'''")                      // comillas triples
            .replace(/^(INSTRUCCIÓN|REGLAS|ESTILO|TRANSCRIPCIÓN)\s*:/gim, '[$1]:');
    }

    /**
     * Truncamiento inteligente: conserva inicio + medio + final
     * para que el modelo tenga contexto de todo el arco del contenido.
     */
    function truncateSmart(text, maxChars) {
        if (!text || text.length <= maxChars) return text;

        var third    = Math.floor(maxChars / 3);
        var midPoint = Math.floor(text.length / 2);
        var halfMid  = Math.floor(third / 2);
        var start    = text.substring(0, third);
        var middle   = text.substring(midPoint - halfMid, midPoint + halfMid);
        var end      = text.substring(text.length - third);

        return start + '\n[...]\n' + middle + '\n[...]\n' + end;
    }

    /* ═══════════════════════════════════════════════════════════════
       RENDERIZADO
       ═══════════════════════════════════════════════════════════════ */
    function renderStreamingOutput() {
        var d = dom();
        if (!d.output) return;

        try {
            d.output.innerHTML = renderMarkdown(state.rawResponse);
            d.output.scrollTop = d.output.scrollHeight;
        } catch (e) {
            // Fallback: texto plano si el render falla
            d.output.textContent = state.rawResponse;
        }
    }

    function renderFinalOutput() {
        var d = dom();
        if (!d.output) return;

        try {
            state.renderedHTML = renderMarkdown(state.rawResponse);
            d.output.innerHTML = state.renderedHTML;
            d.output.scrollTop = 0;
        } catch (e) {
            d.output.textContent = state.rawResponse;
        }
    }

    /**
     * Renderizado de markdown ligero.
     * Solo soporta los elementos más comunes, sin librerías externas.
     * Escapa HTML primero para evitar XSS.
     */
    function renderMarkdown(text) {
        if (!text) return '';

        // 1. Escapar HTML — todas las sustituciones posteriores operan sobre texto ya escapado
        var html = esc(text);

        // 2. Headers: ## Título (hasta H4)
        html = html.replace(/^#{1,4}\s+(.+)$/gm, function (_, title) {
            return '<span class="summary-heading">' + title + '</span>';
        });

        // 3. Bold: **texto** — soporta contenido multilínea hasta 200 chars
        html = html.replace(/\*\*([^*]{1,200}?)\*\*/g, '<strong>$1</strong>');

        // 4. Italic: _texto_ o *texto* — evita colisión con bold
        // FIX: regex más seguro que no captura asteriscos adyacentes ni texto vacío
        html = html.replace(/(?<!\*)\*([^*\n]{1,200}?)\*(?!\*)/g, '<em>$1</em>');
        html = html.replace(/_([^_\n]{1,200}?)_/g, '<em>$1</em>');

        // 5. Bullets: - texto, • texto, etc.
        html = html.replace(/^[\s]*[-•●▪▸►]\s+(.+)$/gm, function (_, content) {
            return '<span class="summary-bullet">• ' + content + '</span>';
        });

        // 6. Listas numeradas: 1. texto, 1) texto
        html = html.replace(/^[\s]*(\d+)[.)]\s+(.+)$/gm, function (_, num, content) {
            return '<span class="summary-bullet">' + num + '. ' + content + '</span>';
        });

        // 7. Líneas horizontales
        html = html.replace(/^[-─═]{3,}$/gm,
            '<hr style="border:none;border-top:1px solid var(--yt-border);margin:12px 0;">');

        // 8. Código inline: `código`
        html = html.replace(/`([^`\n]+)`/g, function (_, code) {
            return '<code style="background:var(--yt-surface-hover);padding:1px 5px;' +
                   'border-radius:3px;font-size:0.85em;">' + code + '</code>';
        });

        // 9. Doble salto → separación real
        html = html.replace(/\n\n+/g, '\n\n');

        // 10. Saltos de línea simples
        html = html.replace(/\n/g, '<br>');

        // 11. Limpiar <br> excesivos
        html = html.replace(/(<br\s*\/?>){3,}/gi, '<br><br>');

        return html;
    }

    /* ═══════════════════════════════════════════════════════════════
       UI — SECCIONES Y METADATA
       ═══════════════════════════════════════════════════════════════ */
    function showSection(section) {
        var d = dom();
        setDisplay(d.configSection,  section === 'config'  ? '' : 'none');
        setDisplay(d.loadingSection, section === 'loading' ? '' : 'none');
        setDisplay(d.resultSection,  section === 'result'  ? '' : 'none');
    }

    function showMeta(isPartial) {
        var d = dom();
        if (!d.meta) return;

        var elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
        var words   = countWords(state.rawResponse);
        var sName   = STYLE_NAMES[state.styleUsed] || state.styleUsed || 'Resumen';

        var parts = [
            '<span><span class="summary-meta-icon" aria-hidden="true">⏱</span><span>' + elapsed + 's</span></span>',
            '<span><span class="summary-meta-icon" aria-hidden="true">🔤</span><span>' + (state.tokenCount === null ? 'no disponible' : state.tokenCount) + ' tokens generados</span></span>',
            '<span><span class="summary-meta-icon" aria-hidden="true">📝</span><span>' + words + ' palabras</span></span>',
            '<span><span class="summary-meta-icon" aria-hidden="true">🤖</span><span>' + esc(state.modelUsed) + '</span></span>',
            '<span><span class="summary-meta-icon" aria-hidden="true">📋</span><span>' + esc(sName) + '</span></span>'
        ];

        if (isPartial) {
            parts.push('<span class="meta-partial"><span class="summary-meta-icon" aria-hidden="true">⚠</span><span>Resultado parcial</span></span>');
        }

        d.meta.innerHTML = parts.join('');
    }

    function resetToConfig() {
        var d = dom();
        showSection('config');
        state.rawResponse  = '';
        state.renderedHTML = '';
        state.tokenCount   = null;
        if (d.output) {
            d.output.innerHTML = '';
            d.output.classList.remove('generating');
        }
        if (d.meta)          d.meta.innerHTML           = '';
        if (d.streamPreview) d.streamPreview.textContent = '';
    }

    /* ═══════════════════════════════════════════════════════════════
       ACCIONES DE RESULTADO
       ═══════════════════════════════════════════════════════════════ */
    function copySummary() {
        var text = state.rawResponse || '';
        if (!text) { _notif('Nada que copiar', 'advertencia'); return; }

        copyToClipboard(text)
            .then(function ()  { _notif('Resumen copiado al portapapeles', 'exito'); })
            .catch(function () { _notif('Error al copiar', 'error'); });
    }

    function exportSummary() {
        var text = state.rawResponse || '';
        if (!text) { _notif('Nada que exportar', 'advertencia'); return; }

        var videoName = getVideoName();
        var sName     = STYLE_NAMES[state.styleUsed] || 'resumen';
        var elapsed   = ((Date.now() - state.startTime) / 1000).toFixed(1);
        var words     = countWords(text);

        var sep     = repeat('═', 50);
        var content = [
            'RESUMEN — ' + videoName,
            'Modelo: '             + state.modelUsed,
            'Estilo: '             + sName,
            'Duración del video: ' + fmtTime(state.videoDuration),
            'Fecha: '              + safeDate(),
            sep,
            '',
            text,
            '',
            sep,
            'Tokens generados: ' + (state.tokenCount === null ? 'no disponible' : state.tokenCount),
            'Palabras: ' + words,
            'Tiempo: '   + elapsed + 's'
        ].join('\n');

        var filename = 'resumen_' + sanitize(videoName) + '_' + sanitize(sName) + '.txt';
        downloadText(content, filename);
        _notif('Resumen exportado como .txt', 'exito');
    }

    /* ═══════════════════════════════════════════════════════════════
       UTILIDADES
       ═══════════════════════════════════════════════════════════════ */

    /** Formato mm:ss o h:mm:ss */
    function fmtTime(seconds) {
        if (!seconds || !isFinite(seconds) || seconds < 0) return '0:00';
        var s   = Math.floor(seconds);
        var h   = Math.floor(s / 3600);
        var m   = Math.floor((s % 3600) / 60);
        var sec = s % 60;
        if (h > 0) return h + ':' + pad(m) + ':' + pad(sec);
        return m + ':' + pad(sec);
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function fmtBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    function countWords(text) {
        if (!text) return 0;
        // FIX: trim evita contar tokens vacíos al inicio/fin
        var trimmed = text.trim();
        if (!trimmed) return 0;
        return trimmed.split(/\s+/).length;
    }

    /** Escapar HTML — previene XSS */
    function esc(str) {
        if (!str) return '';
        var d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    function escAttr(str) {
        return esc(str).replace(/"/g, '&quot;');
    }

    /** Leer .value de un elemento que podría ser null */
    function val(el) {
        return (el && el.value !== undefined) ? el.value : '';
    }

    /** Setear textContent de forma segura */
    function setText(el, text) {
        if (el) el.textContent = text || '';
    }

    /** Setear display de forma segura */
    function setDisplay(el, value) {
        if (el) el.style.display = value;
    }

    function sanitize(name) {
        return (name || 'video')
            .replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ_\-\s]/g, '')
            .replace(/\s+/g, '_')
            .substring(0, 50)
            .toLowerCase();
    }

    // FIX: usar String.prototype.repeat nativo con fallback para IE
    function repeat(ch, n) {
        if (n <= 0) return '';
        if (typeof ch.repeat === 'function') return ch.repeat(n);
        var s = '';
        for (var i = 0; i < n; i++) s += ch;
        return s;
    }

    function safeDate() {
        try { return new Date().toLocaleString(); }
        catch (_) { return new Date().toISOString(); }
    }

    function getVideoName() {
        try {
            if (window.VP && VP.currentVideo && VP.currentVideo.name) {
                return VP.currentVideo.name.replace(/\.[^.]+$/, '');
            }
            var d = dom();
            if (d.video && d.video.src) {
                var url  = new URL(d.video.src);
                var path = url.pathname.split('/').pop();
                var name = decodeURIComponent(path || '').replace(/\.[^.]+$/, '');
                return name || 'video';
            }
        } catch (_) {}
        return 'video';
    }

    /** Copiar al portapapeles — API moderna con fallback */
    function copyToClipboard(text) {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text).catch(function () {
                return clipboardFallback(text);
            });
        }
        return clipboardFallback(text);
    }

    function clipboardFallback(text) {
        return new Promise(function (resolve, reject) {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0;left:-9999px;top:-9999px;';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try {
                var ok = document.execCommand('copy');
                ok ? resolve() : reject(new Error('execCommand copy devolvió false'));
            } catch (e) {
                reject(e);
            } finally {
                try { document.body.removeChild(ta); } catch (_) {}
            }
        });
    }

    /** Descargar texto como archivo */
    function downloadText(content, filename) {
        try {
            var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');
            a.href     = url;
            a.download = filename || 'resumen.txt';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
                try { document.body.removeChild(a); } catch (_) {}
                try { URL.revokeObjectURL(url); } catch (_) {}
            }, 500);
        } catch (e) {
            _log.error('Error exportando:', e);
            _notif('Error al exportar archivo', 'error');
        }
    }

    // FIX: guard nulo para VP antes de intentar acceder VP.ui
    function _notif(msg, tipo) {
        try {
            if (window.VP && VP.ui && typeof VP.ui.mostrarNotificacion === 'function') {
                VP.ui.mostrarNotificacion(msg, tipo || 'info');
            }
        } catch (_) {}
    }

    /* ═══════════════════════════════════════════════════════════════
       BUS (VP)
       ═══════════════════════════════════════════════════════════════ */
    function registerBusEvents() {
        if (!window.VP || !VP.bus || typeof VP.bus.on !== 'function') return;
        var busEvts = [
            ['videoCambiado', function () {
                safeRun(updateSubtitleStatus);
                refreshDuration();
                resetToConfig();
            }],
            ['subtitulosCargados', function () {
                safeRun(updateSubtitleStatus);
            }],
            ['reset', function () {
                if (state.isGenerating) cancelGeneration();
                state.rawResponse = '';
                state.renderedHTML = '';
                state.tokenCount = 0;
                resetToConfig();
            }],
            ['cacheVaciada', function () {
                resetToConfig();
            }],
        ];
        for (var i = 0; i < busEvts.length; i++) {
            VP.bus.on(busEvts[i][0], busEvts[i][1]);
            state._busListeners.push({ event: busEvts[i][0], handler: busEvts[i][1] });
        }
    }

    /* ═══════════════════════════════════════════════════════════════
       DESTRUIR
       ═══════════════════════════════════════════════════════════════ */
    function destroy() {
        if (state.isGenerating) cancelGeneration();
        _removeTracked();
        _clearSubtitleWatcher();
        if (window.VP && VP.bus && typeof VP.bus.off === 'function') {
            for (var i = 0; i < state._busListeners.length; i++) {
                try {
                    VP.bus.off(state._busListeners[i].event, state._busListeners[i].handler);
                } catch (_) {}
            }
        }
        state._busListeners.length = 0;
        state._initialized = false;
        // Permitir reinicialización limpia
        window.__VP_RESUMEN_IA_LOADED__ = false;
    }

    /* ═══════════════════════════════════════════════════════════════
       API PÚBLICA
       ═══════════════════════════════════════════════════════════════ */
    window.VP_SummaryIA = {
        open:     openModal,
        close:    closeModal,
        generate: generateSummary,
        cancel:   cancelGeneration,
        reset:    resetToConfig,
        destroy:  destroy,
    };
    if (window.VP) VP.resumenIA = window.VP_SummaryIA;

    /* ═══════════════════════════════════════════════════════════════
       ARRANQUE
       ═══════════════════════════════════════════════════════════════ */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 0);
    }

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-resumen-ia.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
