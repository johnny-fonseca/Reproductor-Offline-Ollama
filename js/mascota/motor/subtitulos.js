/* ==========================================================================
   3. EXTRACCIÓN E ÍNDICE DE SUBTÍTULOS
   ========================================================================== */
(function (window, document) {
    'use strict';
    var VP = window.VP;
    if (!VP) return;
    var U = VP._mochiUtil || {};
    var warn = U.warn || function () {};
    var normalizeWhitespace = U.normalizeWhitespace || function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };

    var LIMITE_CUES = 20000;
    var indexCache = { source: null, version: -1, sourceLength: -1, cues: [], maxEndPrefix: [] };
    var bufferCache = { time: -1, seconds: 0, maxChars: 0, version: -1, text: '' };
    var decoderEl = null;

    // Lista ampliada de nombres de campo soportados: cubre formatos comunes
    // de WebVTT, TTML, SRT convertidos y arrays ad-hoc usados por otros
    // reproductores del ecosistema.
    var CAMPOS_INICIO = ['inicio', 'start_time', 'startTime', 'start', 'from', 'begin', 'begin_time'];
    var CAMPOS_FIN = ['fin', 'end_time', 'endTime', 'end', 'to', 'finish', 'stop_time'];
    var CAMPOS_TEXTO = ['texto', 'text', 'textContent', 'content', 'payload', 'body', 'line'];

    function cueSource() {
        var globalCues = window.vpSubtitleCues;
        if (Array.isArray(globalCues) && globalCues.length) return globalCues;
        var video = VP.refs && VP.refs.videoPlayer;
        var tracks = video && video.textTracks;
        if (!tracks) return [];
        var fallback = null;
        for (var i = 0; i < tracks.length; i++) {
            var track = tracks[i];
            if ((track.kind === 'subtitles' || track.kind === 'captions') && track.cues && track.cues.length) {
                if (track.mode === 'showing') return track.cues;
                if (!fallback) fallback = track.cues;
            }
        }
        return fallback || [];
    }

    function numberField(cue, names) {
        for (var i = 0; i < names.length; i++) {
            try {
                var value = cue && cue[names[i]];
                if (value !== '' && value != null && isFinite(Number(value))) return Number(value);
            } catch (_) {}
        }
        return null;
    }

    function extraerTexto(cue) {
        if (cue == null) return '';
        for (var i = 0; i < CAMPOS_TEXTO.length; i++) {
            var raw = cue[CAMPOS_TEXTO[i]];
            if (raw != null) {
                if (Array.isArray(raw)) raw = raw.join(' ');
                if (raw !== '') return raw;
            }
        }
        return '';
    }

    function decodeEntities(html) {
        try {
            if (!decoderEl) decoderEl = document.createElement('textarea');
            decoderEl.innerHTML = html;
            var value = decoderEl.value || decoderEl.textContent || '';
            decoderEl.innerHTML = '';
            return value;
        } catch (_) { return html; }
    }

    function cleanText(cue) {
        var raw = extraerTexto(cue);
        if (!raw) return '';
        var sinEtiquetas = String(raw).replace(/<[^>]*>/g, ' ');
        var decodificado = decodeEntities(sinEtiquetas);
        return decodificado
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
            .replace(/\s+/g, ' ').trim();
    }

    function construirIndice(source, version) {
        var normalized = [];
        var total = Math.min(source.length, LIMITE_CUES);
        if (source.length > LIMITE_CUES) warn('Se truncaron los subtítulos a ' + LIMITE_CUES + ' cues por seguridad.');
        for (var i = 0; i < total; i++) {
            try {
                var cue = source[i];
                var start = numberField(cue, CAMPOS_INICIO);
                var end = numberField(cue, CAMPOS_FIN);
                var text = cleanText(cue);
                if (start == null || end == null || end < start || !text) continue;
                normalized.push({ start: start, end: end, text: text });
            } catch (_) {}
        }
        normalized.sort(function (a, b) { return a.start - b.start; });
        normalized = normalized.filter(function (cue, index, cues) {
            if (index === 0) return true;
            var anterior = cues[index - 1];
            return cue.start !== anterior.start || cue.end !== anterior.end || cue.text !== anterior.text;
        });
        var maxEndPrefix = new Array(normalized.length);
        var runningMax = -Infinity;
        for (var j = 0; j < normalized.length; j++) {
            runningMax = normalized[j].end > runningMax ? normalized[j].end : runningMax;
            maxEndPrefix[j] = runningMax;
        }
        return { source: source, version: version, sourceLength: source.length, cues: normalized, maxEndPrefix: maxEndPrefix };
    }

    function indexedCues() {
        var source = cueSource();
        var version = Number(window.vpSubtitleVersion) || 0;
        // Además de "source" y "version" comprobamos la longitud: si los cues
        // vienen de un TextTrackCueList en vivo, la referencia no cambia al
        // agregarse subtítulos nuevos, así que sin este chequeo el índice
        // podría quedarse obsoleto mientras nadie actualice vpSubtitleVersion.
        if (source === indexCache.source && version === indexCache.version && source.length === indexCache.sourceLength) {
            return indexCache;
        }
        indexCache = construirIndice(source, version);
        bufferCache.version = -1;
        return indexCache;
    }

    function primerIndiceRelevante(maxEndPrefix, from) {
        var lo = 0, hi = maxEndPrefix.length;
        while (lo < hi) {
            var mid = (lo + hi) >>> 1;
            if (maxEndPrefix[mid] < from) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function contextAt(currentTime, bufferSeconds, maxChars) {
        var time = Number(currentTime);
        if (!isFinite(time) || time < 0) return '';
        var idx = indexedCues();
        var cues = idx.cues;
        if (!cues.length) return '';
        var from = Math.max(0, time - Math.max(1, Number(bufferSeconds) || 90));
        var first = primerIndiceRelevante(idx.maxEndPrefix, from);
        var lo = first, hi = cues.length;
        while (lo < hi) {
            var mid = (lo + hi) >>> 1;
            if (cues[mid].start <= time) lo = mid + 1;
            else hi = mid;
        }
        var limit = Math.max(500, Number(maxChars) || 5000);
        var selected = [];
        var used = 0;
        for (var i = lo - 1; i >= first; i--) {
            // "first" solo garantiza que NINGÚN cue anterior puede ser relevante;
            // dentro del rango aún puede haber cues ya finalizados (end < from)
            // si un cue inusualmente largo desplazó el índice de arranque hacia
            // atrás. Se descartan explícitamente para no colar texto viejo.
            if (cues[i].end < from) continue;
            var line = '[' + Math.floor(cues[i].start) + 's] ' + cues[i].text;
            if (used + line.length + 1 > limit) {
                if (selected.length) break;
                line = line.slice(0, Math.max(0, limit - 1)) + '…';
            }
            selected.unshift(line);
            used += line.length + 1;
        }
        return selected.join('\n');
    }

    function pausaDisponible(currentTime, minGapSeconds) {
        var time = Number(currentTime);
        if (!isFinite(time) || time < 0) return true;
        var idx = indexedCues();
        var cues = idx.cues;
        if (!cues.length) return true;
        // Búsqueda binaria (igual que en contextAt) en vez de recorrer todos
        // los cues de forma lineal: con hasta LIMITE_CUES (20000) entradas y
        // esta función llamándose repetidamente, el escaneo O(n) era costoso.
        var lo = 0, hi = cues.length;
        while (lo < hi) {
            var mid = (lo + hi) >>> 1;
            if (cues[mid].start <= time) lo = mid + 1;
            else hi = mid;
        }
        // maxEndPrefix[lo-1] es el mayor "end" entre los cues que ya
        // empezaron (start <= time); si supera "time" hay uno activo.
        if (lo > 0 && idx.maxEndPrefix[lo - 1] > time) return false;
        var siguienteInicio = lo < cues.length ? cues[lo].start : Infinity;
        return siguienteInicio === Infinity || siguienteInicio - time >= Math.max(0, Number(minGapSeconds) || 0);
    }

    function cuesFuturos(currentTime, minAheadSeconds, maxAheadSeconds, limit) {
        var time = Number(currentTime);
        if (!isFinite(time) || time < 0) return [];
        var cues = indexedCues().cues;
        var from = time + Math.max(0, Number(minAheadSeconds) || 0);
        var until = time + Math.max(Number(minAheadSeconds) || 0, Number(maxAheadSeconds) || 45);
        var lo = 0, hi = cues.length;
        while (lo < hi) {
            var mid = (lo + hi) >>> 1;
            if (cues[mid].start < from) lo = mid + 1;
            else hi = mid;
        }
        var result = [];
        var maxItems = Math.max(1, Math.min(20, Number(limit) || 8));
        for (var i = lo; i < cues.length && cues[i].start <= until && result.length < maxItems; i++) {
            result.push({ start: cues[i].start, end: cues[i].end, text: cues[i].text });
        }
        return result;
    }

    VP.mochiSubtitulos = {
        invalidar: function () { indexCache = { source: null, version: -1, sourceLength: -1, cues: [], maxEndPrefix: [] }; bufferCache.version = -1; },
        actualizarBuffer: function (currentTime, bufferSeconds, maxChars) {
            var text = contextAt(currentTime, bufferSeconds, maxChars);
            bufferCache = { time: Number(currentTime), seconds: Number(bufferSeconds), maxChars: Number(maxChars), version: Number(window.vpSubtitleVersion) || 0, text: text };
            return text;
        },
        obtenerContexto: function (currentTime, bufferSeconds, maxChars) {
            var version = Number(window.vpSubtitleVersion) || 0;
            if (Math.abs(Number(currentTime) - bufferCache.time) <= 2 && Number(bufferSeconds) === bufferCache.seconds &&
                Number(maxChars) === bufferCache.maxChars && version === bufferCache.version) return bufferCache.text;
            return contextAt(currentTime, bufferSeconds, maxChars);
        },
        obtenerContextoEn: function (currentTime, bufferSeconds, maxChars) {
            return contextAt(currentTime, bufferSeconds, maxChars);
        },
        pausaDisponible: pausaDisponible,
        obtenerCuesFuturos: cuesFuturos,
        // Nuevos helpers de diagnóstico:
        contarCues: function () { return indexedCues().cues.length; },
        primerCue: function () { var cues = indexedCues().cues; return cues.length ? cues[0] : null; },
        ultimoCue: function () { var cues = indexedCues().cues; return cues.length ? cues[cues.length - 1] : null; }
    };
})(window, document);
