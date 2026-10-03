'use strict';

(function (window, document) {

    var VP = window.VP;
    if (!VP) {
        throw new Error(
            '[VP] vp-reproductor-reproduccion.js: vp-base.js debe cargarse primero.'
        );
    }

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;

    var _int    = VP.reproductor._internal;
    var CONST   = _int.CONST;
    var _estado = _int._estado;
    var BlobLRU = _int.BlobLRU;
    var BatchQueue = _int.BatchQueue;
    var GeneracionToken = _int.GeneracionToken;
    var _safe   = _int._safe;
    var _runIdle = _int._runIdle;
    var _video  = _int._video;
    var _videoActivo = _int._videoActivo;
    var _videoActual = _int._videoActual;
    var _notif  = _int._notif;
    var _css    = _int._css;
    var _style  = _int._style;
    var _pct    = _int._pct;
    var _safeStr = _int._safeStr;
    var _safeNum = _int._safeNum;

    // ============================================================
    // LIMPIAR VIDEO ACTIVO
    // ============================================================

    VP.reproductor.limpiarVideo = function () {
        if (_estado.limpiezaPendiente) {
            if (log && log.debug) log.debug('limpiarVideo: limpieza ya en curso, ignorando.');
            return;
        }
        _estado.limpiezaPendiente = true;
        try {
            _safe(function () {
                var v = _video();
                if (v && !v.paused && typeof v.pause === 'function') v.pause();
            }, 'limpiarVideo:pause');

            _safe(function () {
                if (VP.subtitulos && typeof VP.subtitulos.limpiarPistas === 'function') {
                    VP.subtitulos.limpiarPistas();
                }
            }, 'limpiarVideo:subtitulos');

            BatchQueue.cancelar('thumbnails');
            BatchQueue.cancelar('barrasProgreso');

            _safe(function () {
                var v = _video();
                if (v) {
                    v.removeAttribute('src');
                    if (typeof v.load === 'function') v.load();
                }
            }, 'limpiarVideo:src');

            _safe(function () {
                if (VP.runtime.urlActual) BlobLRU.delete(VP.runtime.urlActual);
            }, 'limpiarVideo:revocar');
            VP.runtime.urlActual = null;

            _safe(function () {
                window.vpCurrentVideo = null;
                window.vpSubtitleCues = [];
            }, 'limpiarVideo:globals');

            _safe(function () {
                window.dispatchEvent(new CustomEvent('vpVideoChanged', {
                    bubbles:    false,
                    cancelable: false,
                    detail: {
                        video:   null,
                        accion:  'limpiar',
                        videoId: null,
                        nombre:  null,
                    },
                }));
            }, 'limpiarVideo:event');

            _safe(function () {
                _css(VP.refs.loadingOverlay, 'remove', 'active');
                if (VP.refs.videoTitleOverlay) VP.refs.videoTitleOverlay.textContent = '';
                if (VP.miniaturas && typeof VP.miniaturas.ocultarPreviewProgreso === 'function') {
                    VP.miniaturas.ocultarPreviewProgreso();
                }
            }, 'limpiarVideo:ui');

            if (bus && typeof bus.emit === 'function') bus.emit('videoLimpiado');
            if (log && log.debug) log.debug('limpiarVideo: completado.');
        } finally {
            _estado.limpiezaPendiente = false;
        }
    };

    // ============================================================
    // REPRODUCIR VIDEO — NÚCLEO PRINCIPAL
    // ============================================================

    VP.reproductor.reproducir = function (indice, opciones) {
        opciones = (typeof opciones === 'object' && opciones !== null) ? opciones : {};

        var playlist = VP.estado.playlist;
        if (!Array.isArray(playlist) || playlist.length === 0) {
            if (log && log.warn) log.warn('reproducir: playlist vacía.');
            return;
        }

        if (isNaN(indice) || indice === null || indice === undefined) indice = 0;

        var idx = ((indice % playlist.length) + playlist.length) % playlist.length;

        if (idx < 0 || idx >= playlist.length) {
            if (log && log.warn) log.warn('reproducir: índice fuera de rango \u2192', indice);
            return;
        }

        if (!opciones.forzar && typeof VP.guardarGuard === 'function' && !VP.guardarGuard('reproducirVideo')) {
            if (log && log.debug) log.debug('reproducir: guard activo — ignorando.');
            return;
        }

        var miToken = GeneracionToken.siguiente();

        VP._mochiPendingVideoTransition = opciones.mochiTransition || 'nuevo-video';

        VP.reproductor.limpiarVideo();
        if ((opciones.mochiTransition === 'siguiente' || opciones.mochiTransition === 'anterior') &&
                VP.mochiMascota && typeof VP.mochiMascota.anticiparCambioVideo === 'function') {
            VP.mochiMascota.anticiparCambioVideo(opciones.mochiTransition);
        }
        if (typeof VP.reproductor.cancelarUpNext === 'function') VP.reproductor.cancelarUpNext();
        BatchQueue.cancelar('thumbnails');

        VP.estado.currentVideoIndex = idx;
        var v = playlist[idx];

        if (!v || !v.file || (util && typeof util.validarVideoBasico === 'function' && !util.validarVideoBasico(v))) {
            if (log && log.error) log.error('reproducir: objeto de video inválido en índice', idx);
            _notif('No se pudo cargar el video', 'error');
            if (typeof VP.liberarGuard === 'function') VP.liberarGuard('reproducirVideo');
            return;
        }

        if (log && log.info) log.info('reproducir: \u2192', '"' + v.name + '"', '| idx:', idx, '| token:', miToken);

        _prepararUICarga(v);

        var archivoACargar = _normalizarArchivoEdge(v);

        var url = null;
        try {
            url = URL.createObjectURL(archivoACargar);
            BlobLRU.set('video_' + idx, url);
        } catch (e) {
            if (log && log.error) log.error('reproducir: createObjectURL falló:', e);
            _notif('Error al cargar el video', 'error');
            _css(VP.refs.loadingOverlay, 'remove', 'active');
            if (typeof VP.liberarGuard === 'function') VP.liberarGuard('reproducirVideo');
            return;
        }

        VP.runtime.urlActual = url;

        _safe(function () {
            var v2 = _video();
            if (v2) {
                v2.src         = url;
                v2.playbackRate = (typeof VP.estado.velocidadActual === 'number' && !isNaN(VP.estado.velocidadActual)) ? VP.estado.velocidadActual : 1;
            }
        }, 'reproducir:src');

        VP.reproductor._exponerVideoActivo(v, idx);

        var prog = null;
        if (VP.db && typeof VP.db.obtenerProgresoPor === 'function') {
            prog = VP.db.obtenerProgresoPor(v.name);
        }

        _restaurarVolumen();

        VP.estado.capitulos = (prog && Array.isArray(prog.chapters))
            ? prog.chapters.slice()
            : [];
        if (typeof VP.reproductor.actualizarMarcadoresCapitulos === 'function') VP.reproductor.actualizarMarcadoresCapitulos();

        if (!v.duration || !isFinite(v.duration)) {
            _safe(function () {
                if (VP.miniaturas && typeof VP.miniaturas.encolarDuracion === 'function') {
                    VP.miniaturas.encolarDuracion(v);
                }
            }, 'reproducir:duracion');
        }

        _registrarLoadedMetadata(miToken, idx, v, prog, opciones);

        _safe(function () {
            if (VP.listas && typeof VP.listas.resaltarItemActivo === 'function') VP.listas.resaltarItemActivo();
        }, 'reproducir:resaltar');
        _safe(function () {
            if (VP.listas && typeof VP.listas.actualizarBarrasProgreso === 'function') VP.listas.actualizarBarrasProgreso();
        }, 'reproducir:barras');
        if (typeof VP.reproductor.mostrarControlesBrevemente === 'function') VP.reproductor.mostrarControlesBrevemente();

        VP.estado.abRepeat = { a: null, b: null, activo: false };
        _style(VP.refs.abRepeatBtn, 'color', '');
    };

    function _prepararUICarga(v) {
        _safe(function () {
            var refs = VP.refs || {};
            _css(refs.loadingOverlay,    'add',    'active');
            _style(refs.emptyState,       'display', 'none');
            if (dom && !dom.esNulo(refs.videoTitleOverlay)) {
                refs.videoTitleOverlay.textContent = v.name || '';
            }
        }, '_prepararUICarga');
    }

    function _normalizarArchivoEdge(v) {
        if (!navigator || !/Edg\//.test(navigator.userAgent)) return v.file;
        return _safe(function () {
            var ext = util && typeof util.obtenerExtension === 'function' ? util.obtenerExtension(v.name).slice(1) || 'mp4' : 'mp4';
            return new File(
                [v.file],
                'video_' + Date.now() + '.' + ext,
                { type: v.file.type || 'video/mp4' }
            );
        }, '_normalizarArchivoEdge') || v.file;
    }

    function _restaurarVolumen() {
        _safe(function () {
            var v = _video();
            if (!v) return;
            var volGlobal = VP.ajustes && typeof VP.ajustes.volumenGlobal === 'number' ? VP.ajustes.volumenGlobal : 1;
            if (isNaN(volGlobal)) volGlobal = 1;
            v.volume = (util && typeof util.clampNum === 'function') ? util.clampNum(volGlobal, 0, 1) : Math.max(0, Math.min(1, volGlobal));
            v.muted  = VP.ajustes ? !!VP.ajustes.silenciadoGlobal : false;
        }, '_restaurarVolumen');
        if (typeof VP.reproductor.actualizarUIVolumen === 'function') VP.reproductor.actualizarUIVolumen();
    }

    function _registrarLoadedMetadata(miToken, idx, videoObj, prog, opciones) {
        var video = _video();
        if (!video) return;

        var loadTimeout = null;
        var manejado    = false;

        function _limpiarListeners() {
            video.removeEventListener('loadedmetadata', onCargado);
            video.removeEventListener('error',          onError);
            if (loadTimeout) clearTimeout(loadTimeout);
        }

        function onCargado() {
            if (manejado) return;
            manejado = true;
            _limpiarListeners();

            if (!GeneracionToken.esValido(miToken) ||
                VP.estado.currentVideoIndex !== idx) {
                if (log && log.warn) log.warn(
                    'loadedmetadata obsoleto ignorado | token:',
                    miToken, '\u2260', GeneracionToken.actual()
                );
                if (typeof VP.liberarGuard === 'function') VP.liberarGuard('reproducirVideo');
                return;
            }

            _onVideoListo(idx, videoObj, prog, opciones);
        }

        function onError() {
            if (manejado) return;
            manejado = true;
            _limpiarListeners();

            if (!GeneracionToken.esValido(miToken)) return;

            var codigo = (video.error && video.error.code) || 0;
            if (log && log.error) log.error('loadedmetadata:error — código:', codigo);
            _css(VP.refs.loadingOverlay, 'remove', 'active');
            _notif('Error al cargar el video (código ' + codigo + ')', 'error');
            if (typeof VP.liberarGuard === 'function') VP.liberarGuard('reproducirVideo');
        }

        video.addEventListener('loadedmetadata', onCargado);
        video.addEventListener('error', onError);

        loadTimeout = setTimeout(function () {
            if (manejado) return;
            manejado = true;
            video.removeEventListener('loadedmetadata', onCargado);
            video.removeEventListener('error',          onError);

            if (!GeneracionToken.esValido(miToken)) return;

            if (log && log.warn) log.warn('reproducir: timeout al cargar \u2192', videoObj && videoObj.name);
            _css(VP.refs.loadingOverlay, 'remove', 'active');
            _notif('Timeout al cargar el video', 'advertencia');
            if (typeof VP.liberarGuard === 'function') VP.liberarGuard('reproducirVideo');
        }, CONST.TIMEOUT_CARGA_MS);
    }

    function _onVideoListo(idx, videoObj, prog, opciones) {
        _css(VP.refs.loadingOverlay, 'remove', 'active');

        var video = _video();
        if (!video) return;

        var tiempoInicial = opciones ? opciones.inicioEn : undefined;
        if (tiempoInicial === undefined || tiempoInicial === null || isNaN(tiempoInicial)) {
            if (opciones && !opciones.sinReanudar &&
                VP.ajustes && VP.ajustes.autoReanudar &&
                prog && typeof prog.currentTime === 'number' && prog.currentTime > 2 &&
                !prog.completado) {
                tiempoInicial = prog.currentTime;
            }
        }
        if (tiempoInicial !== undefined && tiempoInicial !== null && !isNaN(tiempoInicial)) {
            _safe(function () {
                var d = Number(video.duration);
                var t = Math.max(0, Number(tiempoInicial) || 0);
                video.currentTime = isFinite(d) && d > 0 ? Math.min(t, d) : t;
            },
                  '_onVideoListo:seek');
        }

        var promesa = _safe(function () { return video.play(); },
                            '_onVideoListo:play');

        if (promesa && typeof promesa.then === 'function') {
            promesa.then(function () {
                if (typeof VP.reproductor.establecerEstadoPlay === 'function') VP.reproductor.establecerEstadoPlay(true);
                if (typeof VP.reproductor.solicitarWakeLock === 'function') VP.reproductor.solicitarWakeLock();
            }).catch(function (err) {
                if (log && log.warn) log.warn('play() bloqueado por el navegador o abortado:', err);
                if (typeof VP.reproductor.establecerEstadoPlay === 'function') VP.reproductor.establecerEstadoPlay(false);
            });
        } else {
            if (typeof VP.reproductor.establecerEstadoPlay === 'function') VP.reproductor.establecerEstadoPlay(true);
            if (typeof VP.reproductor.solicitarWakeLock === 'function') VP.reproductor.solicitarWakeLock();
        }

        VP.metricas.videosReproducidos =
            (typeof VP.metricas.videosReproducidos === 'number' ? VP.metricas.videosReproducidos : 0) + 1;

        _safe(function () {
            if (typeof VP.agregarAlHistorial === 'function') VP.agregarAlHistorial(videoObj);
        }, '_onVideoListo:historial');

        if (typeof VP.liberarGuard === 'function') VP.liberarGuard('reproducirVideo');

        if (VP.ajustes && VP.ajustes.autoGenerarArrayPreview &&
            !VP.ajustes.ultraRendimiento &&
            videoObj && videoObj.duration > 0) {
            BatchQueue.encolar('thumbnails', function () {
                if (VP.miniaturas && typeof VP.miniaturas.generarArray === 'function') {
                    VP.miniaturas.generarArray(videoObj).catch(function () {});
                }
            }, 1, 200);
        }

        if (bus && typeof bus.emit === 'function') {
            bus.emit('videoReproduciendo', videoObj, idx);
            bus.emit('videoCambiado', videoObj, idx);
        }

        _safe(function () {
            if (typeof VP.reproductor.actualizarMediaSession === 'function') VP.reproductor.actualizarMediaSession();
        }, '_onVideoListo:mediaSession');

        if (typeof VP.reproductor._actualizarTituloDoc === 'function') VP.reproductor._actualizarTituloDoc('\u25b6');

        if (log && log.info) log.info('_onVideoListo: reproduciendo \u2192',
                 '"' + (videoObj ? videoObj.name : 'Unknown') + '"', '| idx:', idx);
    }

    // ============================================================
    // EXPONER VIDEO ACTIVO GLOBALMENTE
    // ============================================================

    VP.reproductor._exponerVideoActivo = function (v, indice) {
        if (!v) return;
        _safe(function () {
            var objVideo = {
                name:           _safeStr(v.name),
                src:            VP.runtime.urlActual || '',
                id:             _safeStr(v.id),
                size:           _safeNum(v.size),
                index:          _safeNum(indice),
                duration:       (v.duration && isFinite(v.duration) && v.duration > 0)
                                    ? v.duration : null,
                cargadoEn:      Date.now(),
                ext:            (v.name && util && typeof util.obtenerExtension === 'function')
                                    ? util.obtenerExtension(v.name).slice(1).toLowerCase()
                                    : '',
                tieneSubtitulo: !!(v.subtitleFile),
                fileSize:       v.file ? (v.file.size || 0) : 0,
            };

            window.vpCurrentVideo  = objVideo;
            window.vpSubtitleCues  = [];

            _safe(function () {
                window.dispatchEvent(new CustomEvent('vpVideoChanged', {
                    bubbles:    false,
                    cancelable: false,
                    detail: {
                        accion:         'reproducir',
                        video:          objVideo,
                        videoId:        objVideo.id,
                        nombre:         objVideo.name,
                        tieneSubtitulo: objVideo.tieneSubtitulo,
                        indice:         objVideo.index,
                    },
                }));
            }, '_exponerVideoActivo:event');

            if (log && log.debug) log.debug(
                'vpCurrentVideo \u2192',
                '"' + objVideo.name + '"',
                '| idx:', objVideo.index,
                '| sub:', objVideo.tieneSubtitulo
            );
        }, '_exponerVideoActivo');
    };

    // ============================================================
    // DETENER VIDEO
    // ============================================================

    VP.reproductor.detener = function () {
        if (typeof VP.reproductor.limpiarVideo === 'function') VP.reproductor.limpiarVideo();
        if (typeof VP.reproductor.cancelarUpNext === 'function') VP.reproductor.cancelarUpNext();
        BatchQueue.cancelarTodo();

        VP.estado.currentVideoIndex = -1;

        _safe(function () {
            var refs = VP.refs || {};
            _style(refs.progressBar,       'width',   '0%');
            _style(refs.progressBuffered,  'width',   '0%');
            _style(refs.progressScrubber,  'left',    '0%');
            var pc = refs.progressContainer;
            if (dom && !dom.esNulo(pc) && pc.classList) {
                pc.classList.remove('has-chapters');
                var segs = dom.$$ ? dom.$$('.chapter-segment', pc) : pc.querySelectorAll('.chapter-segment');
                if (segs) {
                    for (var si = 0; si < segs.length; si++) {
                        if (util && typeof util.eliminarElemento === 'function') util.eliminarElemento(segs[si]);
                        else if (segs[si].parentNode) segs[si].parentNode.removeChild(segs[si]);
                    }
                }
            }
            if (dom && !dom.esNulo(refs.timeDisplay)) {
                refs.timeDisplay.textContent = '0:00 / 0:00';
            }
            _style(refs.emptyState, 'display', 'flex');
            if (dom && !dom.esNulo(refs.videoTitleOverlay)) {
                refs.videoTitleOverlay.textContent = '';
            }
        }, 'detener:ui');

        if (typeof VP.reproductor.establecerEstadoPlay === 'function') VP.reproductor.establecerEstadoPlay(false);
        _safe(function () {
            if (VP.listas && typeof VP.listas.resaltarItemActivo === 'function') VP.listas.resaltarItemActivo();
        }, 'detener:lista');
        if (typeof VP.reproductor._actualizarTituloDoc === 'function') VP.reproductor._actualizarTituloDoc('');

        if (bus && typeof bus.emit === 'function') {
            bus.emit('videoDetenido');
            bus.emit('videoCambiado', null, -1);
        }
    };

    // ============================================================
    // SIGUIENTE / ANTERIOR
    // ============================================================

    VP.reproductor._calcularSiguienteIdx = function () {
        var pl = VP.estado.playlist;
        if (!Array.isArray(pl) || pl.length === 0) return -1;
        var actual = typeof VP.estado.currentVideoIndex === 'number' && !isNaN(VP.estado.currentVideoIndex) ? VP.estado.currentVideoIndex : -1;

        if (VP.ajustes && VP.ajustes.aleatorio) {
            if (pl.length === 1) return 0;
            if (actual < 0) return Math.floor(Math.random() * pl.length);
            var siguiente;
            var maxTries = 50;
            var tries = 0;
            do {
                siguiente = Math.floor(Math.random() * pl.length);
                tries++;
            }
            while (siguiente === actual && tries < maxTries);
            return siguiente;
        }

        var next = (actual + 1) % pl.length;
        if (next === 0 && (!VP.ajustes || !VP.ajustes.repetir)) return -1;
        return next;
    };

    VP.reproductor.siguiente = function () {
        var idx = VP.reproductor._calcularSiguienteIdx();
        if (idx < 0) {
            if (log && log.debug) log.debug('siguiente: no hay siguiente video.');
            return;
        }
        VP.reproductor.reproducir(idx, { mochiTransition: 'siguiente' });
    };

    VP.reproductor.anterior = function () {
        var pl = VP.estado.playlist;
        if (!Array.isArray(pl) || pl.length === 0) return;

        var v = _video();
        if (v) {
            var ct = _safe(function () { return v.currentTime; }, 'anterior:ct');
            if (typeof ct === 'number' && ct > 3) {
                _safe(function () { v.currentTime = 0; }, 'anterior:seek0');
                return;
            }
        }

        var actual = typeof VP.estado.currentVideoIndex === 'number' && !isNaN(VP.estado.currentVideoIndex) ? VP.estado.currentVideoIndex : 0;
        var prev = (actual - 1 + pl.length) % pl.length;
        VP.reproductor.reproducir(prev, { mochiTransition: 'anterior' });
    };

    // ============================================================
    // REPRODUCIR POR NOMBRE
    // ============================================================

    VP.reproductor.reproducirPorNombre = function (nombre) {
        if (!nombre || typeof nombre !== 'string') return false;
        var pl       = VP.estado.playlist;
        if (!Array.isArray(pl)) return false;
        var nombreLC = nombre.toLowerCase();

        for (var i = 0; i < pl.length; i++) {
            if (pl[i] && pl[i].name && typeof pl[i].name === 'string' && pl[i].name.toLowerCase() === nombreLC) {
                VP.reproductor.reproducir(i);
                return true;
            }
        }
        _notif('Video no encontrado: ' + nombre, 'advertencia');
        return false;
    };

    // ============================================================
    // PLAY / PAUSE
    // ============================================================

    VP.reproductor.togglePlayPause = function () {
        var v  = _video();
        var pl = VP.estado.playlist;

        if (!v) return;

        if (!v.src && Array.isArray(pl) && pl.length > 0) {
            VP.reproductor.reproducir(0);
            return;
        }
        if (!v.src) return;

        if (v.paused) {
            var p = _safe(function () { return v.play(); }, 'togglePlay:play');
            if (p && typeof p.then === 'function') {
                p.then(function () {
                    if (typeof VP.reproductor.establecerEstadoPlay === 'function') VP.reproductor.establecerEstadoPlay(true);
                    if (typeof VP.reproductor.solicitarWakeLock === 'function') VP.reproductor.solicitarWakeLock();
                }).catch(function () {
                    if (log && log.warn) log.warn('togglePlayPause: play() rechazado.');
                });
            }
        } else {
            _safe(function () { v.pause(); }, 'togglePlay:pause');
            if (typeof VP.reproductor.establecerEstadoPlay === 'function') VP.reproductor.establecerEstadoPlay(false);
            if (typeof VP.reproductor.liberarWakeLock === 'function') VP.reproductor.liberarWakeLock();
            if (typeof VP.reproductor.guardarProgresoCurrent === 'function') VP.reproductor.guardarProgresoCurrent();
        }
    };

    // ============================================================
    // A-B REPEAT
    // ============================================================

    VP.reproductor.toggleABRepeat = function () {
        var v = _video();
        if (!v || !v.src) return;

        var ahora = _safe(function () { return v.currentTime; }, 'toggleABRepeat');
        if (ahora === undefined || ahora === null || isNaN(ahora) || ahora < 0) return;

        var ab    = VP.estado ? VP.estado.abRepeat : null;
        if (!ab) {
            if (VP.estado) VP.estado.abRepeat = { a: null, b: null, activo: false };
            ab = VP.estado.abRepeat;
        }
        var abBtn = VP.refs ? VP.refs.abRepeatBtn : null;

        if (ab.a === null || isNaN(ab.a)) {
            ab.a = ahora;
            if (VP.mochiMascota && typeof VP.mochiMascota.reaccionControlReproduccion === 'function') VP.mochiMascota.reaccionControlReproduccion('ab');
            _style(abBtn, 'color', 'orange');
            _notif('A: ' + (util && typeof util.formatearTiempo === 'function' ? util.formatearTiempo(ahora) : Math.round(ahora) + 's'), 'info');

        } else if (ab.b === null || isNaN(ab.b)) {
            if (ahora <= ab.a) {
                _notif('El punto B debe ser mayor que A', 'advertencia');
                return;
            }
            ab.b      = ahora;
            ab.activo = true;
            if (VP.mochiMascota && typeof VP.mochiMascota.reaccionControlReproduccion === 'function') VP.mochiMascota.reaccionControlReproduccion('ab');
            _style(abBtn, 'color', 'var(--yt-red)');
            _notif(
                'B: ' + (util && typeof util.formatearTiempo === 'function' ? util.formatearTiempo(ahora) : Math.round(ahora) + 's') +
                ' — A-B activo (' +
                (util && typeof util.formatearTiempo === 'function' ? util.formatearTiempo(ab.b - ab.a) : Math.round(ab.b - ab.a) + 's') + ')',
                'exito'
            );

        } else {
            if (VP.estado) VP.estado.abRepeat = { a: null, b: null, activo: false };
            if (VP.mochiMascota && typeof VP.mochiMascota.reaccionControlReproduccion === 'function') VP.mochiMascota.reaccionControlReproduccion('ab');
            _style(abBtn, 'color', '');
            _notif('A-B cancelado', 'info');
        }
    };

    VP.reproductor.verificarABRepeat = function () {
        var ab = VP.estado ? VP.estado.abRepeat : null;
        if (!ab || !ab.activo || ab.a === null || ab.b === null || isNaN(ab.a) || isNaN(ab.b)) return;

        var v = _video();
        if (!v) return;

        _safe(function () {
            if (v.currentTime >= ab.b) {
                v.currentTime = ab.a;
            }
        }, 'verificarABRepeat');
    };

    // ============================================================
    // CAPÍTULOS
    // ============================================================

    VP.reproductor.agregarCapitulo = function () {
        var v = _video();
        if (!v || !v.src || !VP.estado || typeof VP.estado.currentVideoIndex !== 'number' || VP.estado.currentVideoIndex < 0) return;

        var ct = _safe(function () { return v.currentTime; }, 'agregarCapitulo:ct');
        if (ct === undefined || isNaN(ct) || ct < 0) return;

        var titulo;
        _safe(function () {
            var timeStr = util && typeof util.formatearTiempo === 'function' ? util.formatearTiempo(ct) : Math.round(ct) + 's';
            titulo = window.prompt(
                'Nombre del capítulo (en ' + timeStr + '):'
            );
        }, 'agregarCapitulo:prompt');

        if (!titulo || typeof titulo !== 'string' || !titulo.trim()) return;

        titulo = titulo.trim().slice(0, 100);
        if (!titulo) return;

        _safe(function () {
            if (!Array.isArray(VP.estado.capitulos)) VP.estado.capitulos = [];
            VP.estado.capitulos.push({ tiempo: ct, titulo: titulo });
            VP.estado.capitulos.sort(function (a, b) {
                var ta = typeof a.tiempo === 'number' && !isNaN(a.tiempo) ? a.tiempo : 0;
                var tb = typeof b.tiempo === 'number' && !isNaN(b.tiempo) ? b.tiempo : 0;
                return ta - tb;
            });
        }, 'agregarCapitulo:push');

        if (typeof VP.reproductor.actualizarMarcadoresCapitulos === 'function') VP.reproductor.actualizarMarcadoresCapitulos();
        if (typeof VP.reproductor.guardarProgresoCurrent === 'function') VP.reproductor.guardarProgresoCurrent();
        _notif('Capítulo: ' + titulo, 'exito');
    };

    VP.reproductor.capituloActual = function () {
        var v = _video();
        if (!v) return null;

        var ct   = _safe(function () { return v.currentTime; }, 'capituloActual');
        if (ct === undefined || ct === null || isNaN(ct)) ct = 0;
        var caps = (VP.estado && Array.isArray(VP.estado.capitulos)) ? VP.estado.capitulos : [];
        var actual = null;

        for (var i = 0; i < caps.length; i++) {
            if (caps[i] && typeof caps[i].tiempo === 'number' && !isNaN(caps[i].tiempo) && caps[i].tiempo <= ct) actual = caps[i];
            else break;
        }
        return actual;
    };

    // ============================================================
    // UP NEXT
    // ============================================================

    VP.reproductor.cancelarUpNext = function () {
        if (VP.runtime && VP.runtime.upNextTimer) {
            clearInterval(VP.runtime.upNextTimer);
            VP.runtime.upNextTimer = null;
        }
        _css(VP.refs ? VP.refs.upNextOverlay : null, 'remove', 'active');
    };

    VP.reproductor.mostrarUpNext = function () {
        var pl = VP.estado ? VP.estado.playlist : null;
        if (!Array.isArray(pl) || pl.length === 0) return;

        var ni = VP.reproductor._calcularSiguienteIdx();
        if (ni < 0) return;

        var nv = pl[ni];
        if (!nv) return;

        _safe(function () {
            var refs = VP.refs || {};
            _style(refs.upNextThumb, 'backgroundImage',
                   nv.thumbnail ? 'url(' + nv.thumbnail + ')' : '');
            if (dom && !dom.esNulo(refs.upNextTitle)) {
                refs.upNextTitle.textContent = nv.name || '';
            }
        }, 'mostrarUpNext:thumb');

        var cuenta = typeof CONST.DEMORA_SIG_VIDEO_S === 'number' && !isNaN(CONST.DEMORA_SIG_VIDEO_S) ? CONST.DEMORA_SIG_VIDEO_S : 5;

        _safe(function () {
            var refs = VP.refs || {};
            if (dom && !dom.esNulo(refs.upNextCountdown)) {
                refs.upNextCountdown.textContent = cuenta;
            }
            _css(refs.upNextOverlay, 'add', 'active');

            if (dom && !dom.esNulo(refs.cancelUpNextBtn)) {
                refs.cancelUpNextBtn.onclick = VP.reproductor.cancelarUpNext;
            }
        }, 'mostrarUpNext:ui');

        if (VP.runtime && VP.runtime.upNextTimer) clearInterval(VP.runtime.upNextTimer);

        if (VP.runtime) {
            VP.runtime.upNextTimer = setInterval(function () {
                cuenta--;
                _safe(function () {
                    var el = VP.refs ? VP.refs.upNextCountdown : null;
                    if (dom && !dom.esNulo(el)) el.textContent = cuenta;
                }, 'upNextTimer');

                if (cuenta <= 0) {
                    VP.reproductor.cancelarUpNext();
                    VP.reproductor.reproducir(ni);
                }
            }, 1000);
        }
    };

    // ============================================================
    // GUARDAR PROGRESO ACTUAL
    // ============================================================

    var _guardarProgresoThrottled = (util && typeof util.throttle === 'function') ? util.throttle(function () {
        _runIdle(function() { VP.reproductor._guardarProgresoImpl(); });
    }, CONST.THROTTLE_PROGRESO_MS) : function() { VP.reproductor._guardarProgresoImpl(); };

    VP.reproductor.guardarProgresoCurrent = function () {
        if (typeof _guardarProgresoThrottled === 'function') _guardarProgresoThrottled();
    };

    VP.reproductor.guardarProgresoInmediato = function () {
        VP.reproductor._guardarProgresoImpl();
    };

    VP.reproductor._guardarProgresoImpl = function () {
        _safe(function () {
            var ci = VP.estado ? VP.estado.currentVideoIndex : -1;
            var pl = VP.estado ? VP.estado.playlist : null;
            if (ci < 0 || !Array.isArray(pl) || !pl[ci]) return;

            var videoObj = pl[ci];
            var v        = _video();
            if (!v) return;

            var d = v.duration;
            var c = v.currentTime;

            if (!v.src || !isFinite(d) || d <= 0 || isNaN(c)) return;

            if (c < 1) return;

            if (VP.db && typeof VP.db.actualizarProgreso === 'function') {
                VP.db.actualizarProgreso(videoObj.name, c, d, {
                    speed:     (VP.estado && typeof VP.estado.velocidadActual === 'number' && !isNaN(VP.estado.velocidadActual)) ? VP.estado.velocidadActual : 1,
                    chapters:  (VP.estado && Array.isArray(VP.estado.capitulos)) ? VP.estado.capitulos.slice() : [],
                    completado: (d - c) / d < 0.05,
                });
            }

            if (bus && typeof bus.emit === 'function') {
                bus.emit('videoProgressActualizado');
            }

            _safe(function () {
                if (VP.db && typeof VP.db.guardarProgresoUno === 'function') {
                    VP.db.guardarProgresoUno(videoObj.name);
                } else if (VP.db && typeof VP.db.guardarProgreso === 'function') {
                    VP.db.guardarProgreso();
                }
            }, '_guardarProgresoImpl:idb');
            _safe(function () {
                if (VP.listas && typeof VP.listas.actualizarBarraProgresoVideo === 'function') {
                    VP.listas.actualizarBarraProgresoVideo(videoObj, c / d * 100);
                } else if (VP.listas && typeof VP.listas.actualizarBarrasProgreso === 'function') {
                    VP.listas.actualizarBarrasProgreso();
                }
            }, '_guardarProgresoImpl:barras');
        }, '_guardarProgresoImpl');
    };

    // ============================================================
    // PRECARGAR SIGUIENTE
    // ============================================================

    VP.reproductor.precargarSiguiente = function () {
        var ni = typeof VP.reproductor._calcularSiguienteIdx === 'function' ? VP.reproductor._calcularSiguienteIdx() : -1;
        if (ni < 0) return;

        var pl  = VP.estado ? VP.estado.playlist : null;
        if (!Array.isArray(pl) || ni >= pl.length) return;
        var nv  = pl[ni];
        if (!nv) return;

        if (nv.duration && isFinite(nv.duration) && !isNaN(nv.duration)) return;

        BatchQueue.encolar('thumbnails', function () {
            _safe(function () {
                if (VP.miniaturas && typeof VP.miniaturas.encolarDuracion === 'function') VP.miniaturas.encolarDuracion(nv);
            }, 'precargarSiguiente');
        }, 1, 500);
    };

    if (log && log.info) log.info('vp-reproductor-reproduccion.js cargado.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-reproductor-reproduccion.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
