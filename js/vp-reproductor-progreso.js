'use strict';

(function (window, document) {

    // ============================================================
    // GUARDIA DE DEPENDENCIAS
    // ============================================================

    var VP = window.VP;
    if (!VP) {
        throw new Error(
            '[VP] vp-reproductor-progreso.js: vp-base.js debe cargarse primero.'
        );
    }

    var util  = VP.util;
    var dom   = VP.dom;
    var log   = VP.log;

    var _int         = VP.reproductor._internal;
    var _estado      = _int._estado;
    var _safe        = _int._safe;
    var _video       = _int._video;
    var _videoActual = _int._videoActual;
    var _css         = _int._css;
    var _style       = _int._style;
    var _pct         = _int._pct;
    var _segmentosCapitulos = [];
    var _contenedorCapitulos = null;

    // ============================================================
    // HELPERS INTERNOS COMPARTIDOS
    // ============================================================

    /**
     * Devuelve true si el video existe, tiene src y duración finita > 0.
     * @param {HTMLVideoElement} v
     * @returns {boolean}
     */
    function _isVideoReady(v) {
        return !!(v && v.src && isFinite(v.duration) && v.duration > 0);
    }

    /**
     * Convierte una posición clientX en un ratio [0, 1] relativo al
     * progressContainer, o null si los argumentos son inválidos.
     * @param {HTMLElement} pc
     * @param {number} clientX
     * @returns {number|null}
     */
    function _clientXToRatio(pc, clientX) {
        if (!pc || typeof pc.getBoundingClientRect !== 'function') return null;
        if (typeof clientX !== 'number' || isNaN(clientX))        return null;

        var r   = (dom && typeof dom.rectSeguro === 'function')
            ? dom.rectSeguro(pc)
            : pc.getBoundingClientRect();
        var w   = r.width || 1;
        var raw = (clientX - r.left) / w;
        if (isNaN(raw)) return null;

        return (util && typeof util.clampNum === 'function')
            ? util.clampNum(raw, 0, 1)
            : Math.max(0, Math.min(1, raw));
    }

    /**
     * Mueve el video al ratio dado (si el video está listo).
     * @param {HTMLVideoElement} v
     * @param {number} ratio  — valor en [0, 1]
     */
    function _seekToRatio(v, ratio) {
        if (!_isVideoReady(v) || typeof ratio !== 'number' || isNaN(ratio)) return;
        var destino = ratio * v.duration;
        if (!isFinite(destino)) return;
        v.currentTime = Math.max(0, Math.min(v.duration, destino));
    }

    /**
     * Extrae clientX desde un evento de ratón o de toque.
     * Devuelve NaN si no se puede determinar.
     * @param {Event} e
     * @returns {number}
     */
    function _clientXFromEvent(e) {
        if (!e) return NaN;
        if (typeof e.clientX === 'number') return e.clientX;
        var t = e.touches && e.touches[0];
        return (t && typeof t.clientX === 'number') ? t.clientX : NaN;
    }

    /**
     * Envuelve una función con rafThrottle si está disponible.
     * @param {Function} fn
     * @returns {Function}
     */
    function _throttle(fn) {
        return (util && typeof util.rafThrottle === 'function')
            ? util.rafThrottle(fn)
            : fn;
    }

    function _chapterSignature(caps, duration) {
        if (!Array.isArray(caps) || !isFinite(duration) || duration <= 0) {
            return 'none';
        }

        var items = [];
        for (var i = 0; i < caps.length; i++) {
            var cap = caps[i];
            if (!cap || typeof cap.tiempo !== 'number' || !isFinite(cap.tiempo)) continue;
            items.push([
                Number(cap.tiempo.toFixed(3)),
                String(cap.titulo || '').slice(0, 80)
            ]);
        }
        items.sort(function (a, b) { return a[0] - b[0]; });
        return duration.toFixed(3) + '|' + items.map(function (it) {
            return it[0] + ':' + it[1];
        }).join(';');
    }

    // ============================================================
    // INICIALIZAR BARRA DE PROGRESO — SCRUBBING
    // ============================================================

    VP.reproductor.inicializarBarraProgreso = function () {
        var pc = VP.refs ? VP.refs.progressContainer : null;

        if (dom && dom.esNulo(pc)) {
            if (log && log.error) log.error('inicializarBarraProgreso: progressContainer no encontrado.');
            return;
        }

        // Evitar doble inicialización
        if (pc._vpProgressInitialized) {
            if (log && log.warn) log.warn('inicializarBarraProgreso: ya inicializado, omitiendo.');
            return;
        }
        pc._vpProgressInitialized = true;

        // ---- Handlers principales ----

        function _onSeek(e) {
            var cx = _clientXFromEvent(e);
            if (isNaN(cx)) return;
            _safe(function () {
                var v     = _video();
                var ratio = _clientXToRatio(pc, cx);
                if (ratio !== null) _seekToRatio(v, ratio);
            }, '_onSeek');
        }

        function _onPreview(clientX) {
            _safe(function () {
                var v = _video();
                if (!_isVideoReady(v)) return;
                var ratio = _clientXToRatio(pc, clientX);
                if (ratio === null) return;
                if (VP.miniaturas && typeof VP.miniaturas.mostrarPreviewProgreso === 'function') {
                    VP.miniaturas.mostrarPreviewProgreso(ratio);
                }
            }, '_onPreview');
        }

        function _ocultarPreview(ctx) {
            _safe(function () {
                if (VP.miniaturas && typeof VP.miniaturas.ocultarPreviewProgreso === 'function') {
                    VP.miniaturas.ocultarPreviewProgreso();
                }
            }, ctx || 'ocultarPreview');
        }

        var _onPreviewThrottled = _throttle(_onPreview);

        // ---- Mouse ----

        pc.addEventListener('mousedown', function (e) {
            if (e && typeof e.button === 'number' && e.button !== 0) return;
            if (VP.runtime && VP.runtime.isScrubbing) return;
            // Si se suelta el ratón fuera de la barra, el click sintetizado
            // puede acabar en el contenedor del reproductor y pausar el video.
            pc._vpSuppressPlayerClickUntil = Date.now() + 500;
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            if (VP.runtime) VP.runtime.isScrubbing = true;
            if (pc.classList) pc.classList.add('is-scrubbing');

            _onSeek(e);

            var mvThrottled = _throttle(function (ev) { _onSeek(ev); });

            function onMouseUp() {
                if (VP.runtime) VP.runtime.isScrubbing = false;
                if (pc.classList) pc.classList.remove('is-scrubbing');
                document.removeEventListener('mousemove', mvThrottled);
                document.removeEventListener('mouseup',   onMouseUp);
                window.removeEventListener('blur', onMouseUp);
                _ocultarPreview('scrub:mouseup');
            }

            document.addEventListener('mousemove', mvThrottled);
            document.addEventListener('mouseup',   onMouseUp);
            window.addEventListener('blur', onMouseUp);
        });

        pc.addEventListener('mousemove', function (e) {
            var cx = _clientXFromEvent(e);
            if (!isNaN(cx)) _onPreviewThrottled(cx);
        });

        pc.addEventListener('mouseleave', function () {
            _ocultarPreview('progress:mouseleave');
        });

        // ---- Touch ----

        pc.addEventListener('touchstart', function (e) {
            pc._vpSuppressPlayerClickUntil = Date.now() + 700;
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            if (pc.classList) pc.classList.add('is-scrubbing');
            _onSeek(e);
        }, { passive: false });

        var touchMoveThrottled = _throttle(function (e) {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            var cx = _clientXFromEvent(e);
            if (isNaN(cx)) return;
            _safe(function () {
                var v     = _video();
                var ratio = _clientXToRatio(pc, cx);
                if (ratio !== null) {
                    _seekToRatio(v, ratio);
                    _onPreview(cx);
                }
            }, 'touchmove:seek');
        });

        pc.addEventListener('touchmove', touchMoveThrottled, { passive: false });

        function _onTouchEnd() {
            if (pc.classList) pc.classList.remove('is-scrubbing');
            _ocultarPreview('progress:touchend');
        }
        pc.addEventListener('touchend', _onTouchEnd);
        pc.addEventListener('touchcancel', _onTouchEnd);

        // ---- Accesibilidad (teclado) ----

        if (typeof pc.setAttribute === 'function') {
            pc.setAttribute('tabindex',   '0');
            pc.setAttribute('role',       'slider');
            pc.setAttribute('aria-label', 'Barra de progreso');
            pc.setAttribute('aria-valuemin', '0');
            pc.setAttribute('aria-valuemax', '100');
            pc.setAttribute('aria-valuenow', '0');
        }

        pc.addEventListener('keydown', function (e) {
            if (!e) return;
            var v = _video();
            if (!v || !v.src) return;

            var paso = e.shiftKey ? 30 : 5;
            var key  = e.key;

            if (key === 'ArrowLeft' || key === 'ArrowDown') {
                _safe(function () {
                    var ct = isFinite(v.currentTime) ? v.currentTime : 0;
                    v.currentTime = Math.max(0, ct - paso);
                }, 'progressKey:backward');
                if (typeof e.preventDefault === 'function') e.preventDefault();

            } else if (key === 'ArrowRight' || key === 'ArrowUp') {
                _safe(function () {
                    var ct  = isFinite(v.currentTime) ? v.currentTime  : 0;
                    var dur = isFinite(v.duration)    ? v.duration      : 0;
                    v.currentTime = Math.min(dur, ct + paso);
                }, 'progressKey:forward');
                if (typeof e.preventDefault === 'function') e.preventDefault();

            } else if (key === 'Home') {
                _safe(function () { v.currentTime = 0; }, 'progressKey:home');
                if (typeof e.preventDefault === 'function') e.preventDefault();

            } else if (key === 'End') {
                _safe(function () {
                    if (isFinite(v.duration)) v.currentTime = v.duration;
                }, 'progressKey:end');
                if (typeof e.preventDefault === 'function') e.preventDefault();
            }
        });

        if (log && log.debug) log.debug('Barra de progreso inicializada.');
    };

    // ============================================================
    // MARCADORES DE CAPÍTULOS EN LA BARRA
    // ============================================================

    VP.reproductor.actualizarMarcadoresCapitulos = function () {
        _safe(function () {
            var pc = VP.refs ? VP.refs.progressContainer : null;
            if (dom && dom.esNulo(pc) || !pc) return;

            var caps = (VP.estado && Array.isArray(VP.estado.capitulos)) ? VP.estado.capitulos : [];
            var v    = _video();
            var d    = v ? v.duration : NaN;
            var sig  = _chapterSignature(caps, d);

            if (pc._vpChapterSignature === sig) {
                if (typeof VP.reproductor._actualizarFillsSegmentos === 'function') {
                    VP.reproductor._actualizarFillsSegmentos();
                }
                return;
            }
            pc._vpChapterSignature = sig;

            _contenedorCapitulos = pc;
            _segmentosCapitulos = [];

            // Limpiar segmentos y marcadores anteriores
            var selectores = ['.chapter-segment', '.chapter-marker'];
            for (var si = 0; si < selectores.length; si++) {
                var viejos = dom && dom.$$ ? dom.$$(selectores[si], pc) : pc.querySelectorAll(selectores[si]);
                if (!viejos) continue;
                for (var r = 0; r < viejos.length; r++) {
                    var el = viejos[r];
                    if (util && typeof util.eliminarElemento === 'function') {
                        util.eliminarElemento(el);
                    } else if (el && el.parentNode) {
                        el.parentNode.removeChild(el);
                    }
                }
            }

            if (!caps.length || !isFinite(d) || d <= 0) {
                if (pc.classList) pc.classList.remove('has-chapters');
                return;
            }

            pc.classList.add('has-chapters');

            // Normalizar los tiempos antes de dibujar: evita segmentos fuera de
            // rango, duplicados y capítulos que llegan en un orden distinto.
            var capsOrdenados = [];
            for (var i = 0; i < caps.length; i++) {
                var cap = caps[i];
                if (!cap || typeof cap.tiempo !== 'number' || !isFinite(cap.tiempo)) continue;
                if (cap.tiempo < 0 || cap.tiempo >= d) continue;
                capsOrdenados.push(cap);
            }
            capsOrdenados.sort(function (a, b) { return a.tiempo - b.tiempo; });

            var capsUnicos = [];
            for (var u = 0; u < capsOrdenados.length; u++) {
                if (capsUnicos.length && capsUnicos[capsUnicos.length - 1].tiempo === capsOrdenados[u].tiempo) continue;
                capsUnicos.push(capsOrdenados[u]);
            }

            // Si el primer capítulo empieza después de 0, conservar visible y
            // utilizable ese tramo inicial de la línea de tiempo.
            var segmentos = [];
            if (capsUnicos.length && capsUnicos[0].tiempo > 0) {
                segmentos.push({ startTime: 0, endTime: capsUnicos[0].tiempo, cap: null });
            }
            for (var c = 0; c < capsUnicos.length; c++) {
                segmentos.push({
                    startTime: capsUnicos[c].tiempo,
                    endTime:   c + 1 < capsUnicos.length ? capsUnicos[c + 1].tiempo : d,
                    cap:       capsUnicos[c],
                });
            }

            if (!segmentos.length) {
                pc.classList.remove('has-chapters');
                return;
            }

            var frag = document.createDocumentFragment();

            for (var s = 0; s < segmentos.length; s++) {
                (function (seg, idx, total) {
                    var leftPct  = (seg.startTime / d) * 100;
                    var endPct   = (seg.endTime   / d) * 100;

                    if (!isFinite(leftPct) || !isFinite(endPct) || seg.endTime <= seg.startTime) return;

                    var widthPct = endPct - leftPct;

                    // Etiqueta de tiempo para el tooltip
                    var timeStr = (util && typeof util.formatearTiempo === 'function')
                        ? util.formatearTiempo(seg.startTime)
                        : (Math.round(seg.startTime) + 's');

                    var titulo = seg.cap
                        ? ((seg.cap.titulo || 'Capítulo') + ' (' + timeStr + ')')
                        : ('Inicio (' + timeStr + ')');

                    // Contenedor del segmento
                    var segEl = document.createElement('div');
                    segEl.className = 'chapter-segment' +
                        (idx === 0 ? ' is-first' : '') +
                        (idx === total - 1 ? ' is-last' : '');
                    segEl.style.left  = _pct(leftPct);
                    segEl.style.width = _pct(widthPct);
                    segEl.setAttribute('data-start-time', String(seg.startTime));
                    segEl.setAttribute('data-end-time', String(seg.endTime));
                    segEl.title = titulo;

                    // Capas internas: pista, buffer, relleno
                    var layers = [
                        'chapter-segment-track',
                        'chapter-segment-buffered',
                        'chapter-segment-fill',
                    ];
                    var bufferEl = null;
                    var fillEl = null;
                    for (var l = 0; l < layers.length; l++) {
                        var layer = document.createElement('div');
                        layer.className = layers[l];
                        segEl.appendChild(layer);
                        if (layers[l] === 'chapter-segment-buffered') bufferEl = layer;
                        if (layers[l] === 'chapter-segment-fill') fillEl = layer;
                    }
                    _segmentosCapitulos.push({
                        inicio: seg.startTime,
                        fin: seg.endTime,
                        relleno: fillEl,
                        buffer: bufferEl,
                    });

                    frag.appendChild(segEl);
                })(segmentos[s], s, segmentos.length);
            }

            pc.appendChild(frag);

            if (typeof VP.reproductor._actualizarFillsSegmentos === 'function') {
                VP.reproductor._actualizarFillsSegmentos();
            }

        }, 'actualizarMarcadoresCapitulos');
    };

    // ============================================================
    // ACTUALIZAR FILLS DE SEGMENTOS (progreso + buffer)
    // ============================================================

    VP.reproductor._actualizarFillsSegmentos = function (bufferEndCompartido) {
        _safe(function () {
            var pc = VP.refs ? VP.refs.progressContainer : null;
            if (!pc || !pc.classList || !pc.classList.contains('has-chapters')) return;
            if (pc !== _contenedorCapitulos || !_segmentosCapitulos.length) return;

            var v = _video();
            if (!_isVideoReady(v)) return;

            var ct = v.currentTime;
            var d  = v.duration;
            if (!isFinite(ct) || !isFinite(d)) return;

            // Tiempo hasta donde el buffer llega
            var bufEndTime = 0;
            if (typeof bufferEndCompartido === 'number' && isFinite(bufferEndCompartido)) {
                bufEndTime = bufferEndCompartido;
            } else {
                _safe(function () {
                    var buf = v.buffered;
                    if (buf && buf.length > 0) {
                        var last = buf.end(buf.length - 1);
                        if (isFinite(last)) bufEndTime = last;
                    }
                }, '_actualizarFillsSegmentos:buffer');
            }

            for (var i = 0; i < _segmentosCapitulos.length; i++) {
                var segmento = _segmentosCapitulos[i];
                var segDur = segmento.fin - segmento.inicio;
                if (segDur <= 0 || !isFinite(segDur)) continue;

                if (segmento.relleno) {
                    var fillPct = ct <= segmento.inicio ? 0
                        : (ct >= segmento.fin ? 100
                            : ((ct - segmento.inicio) / segDur) * 100);
                    if (isFinite(fillPct)) {
                        var fillWidth = _pct(fillPct);
                        if (segmento.relleno.style.width !== fillWidth) {
                            segmento.relleno.style.width = fillWidth;
                        }
                    }
                }

                if (segmento.buffer) {
                    var bufferPct = bufEndTime <= segmento.inicio ? 0
                        : (bufEndTime >= segmento.fin ? 100
                            : ((bufEndTime - segmento.inicio) / segDur) * 100);
                    if (isFinite(bufferPct)) {
                        var bufferWidth = _pct(bufferPct);
                        if (segmento.buffer.style.width !== bufferWidth) {
                            segmento.buffer.style.width = bufferWidth;
                        }
                    }
                }
            }

            // Mantener aria-valuenow actualizado en el contenedor
            _safe(function () {
                var progressPct = (d > 0) ? Math.round((ct / d) * 100) : 0;
                progressPct = Math.max(0, Math.min(100, progressPct));
                if (typeof pc.setAttribute === 'function') {
                    var progressValue = String(progressPct);
                    if (pc.getAttribute('aria-valuenow') !== progressValue) {
                        pc.setAttribute('aria-valuenow', progressValue);
                    }
                }
            }, '_actualizarFillsSegmentos:aria');

        }, '_actualizarFillsSegmentos');
    };

    if (log && log.info) log.info('vp-reproductor-progreso.js cargado.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-reproductor-progreso.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
