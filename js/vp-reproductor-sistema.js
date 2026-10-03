'use strict';

(function (window, document) {

    var VP = window.VP;
    if (!VP) {
        throw new Error(
            '[VP] vp-reproductor-sistema.js: vp-base.js debe cargarse primero.'
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
    var MemoryMonitor = _int.MemoryMonitor;
    var _safe   = _int._safe;
    var _runIdle = _int._runIdle;
    var _video  = _int._video;
    var _videoActual = _int._videoActual;
    var _notif  = _int._notif;
    var _css    = _int._css;
    var _style  = _int._style;
    var _pct    = _int._pct;
    var _safeStr = _int._safeStr;
    var _esFullscreen = _int._esFullscreen;

    // ============================================================
    // ESTADÍSTICAS
    // ============================================================

    VP.reproductor.actualizarEstadisticas = function () {
        _safe(function () {
            var panel = VP.refs ? VP.refs.statsPanel : null;
            if (dom && dom.esNulo(panel)) return;

            var v = _video();

            if (!v || !v.src) {
                panel.innerHTML = '<div class="stats-row">Sin video activo</div>';
                return;
            }

            _safe(function () { if (typeof VP.actualizarPicoMemoria === 'function') VP.actualizarPicoMemoria(); }, 'stats:mem');

            var res = '?';
            var fps = '';
            _safe(function () {
                if (v.videoWidth && !isNaN(v.videoWidth)) {
                    res = v.videoWidth + '×' + v.videoHeight;
                }
                var q = typeof v.getVideoPlaybackQuality === 'function'
                    ? v.getVideoPlaybackQuality() : null;
                if (q && typeof q.totalVideoFrames === 'number' && !isNaN(q.totalVideoFrames)) {
                    fps = ' · ' + q.droppedVideoFrames +
                          '/' + q.totalVideoFrames + 'f';
                }
            }, 'stats:res');

            var buf = '0:00';
            _safe(function () {
                if (v.buffered && v.buffered.length > 0 && util && typeof util.formatearTiempo === 'function') {
                    buf = util.formatearTiempo(
                        v.buffered.end(v.buffered.length - 1)
                    );
                }
            }, 'stats:buf');

            var cap = typeof VP.reproductor.capituloActual === 'function' ? VP.reproductor.capituloActual() : null;
            var capStr = (cap && cap.titulo) ? cap.titulo : '—';

            var picoMem = (VP.metricas && typeof VP.metricas.picoMemoriaMB === 'number' && !isNaN(VP.metricas.picoMemoriaMB)) ? Math.round(VP.metricas.picoMemoriaMB) : 0;
            var valVol = v.muted ? 0 : v.volume;
            if (isNaN(valVol)) valVol = 0;
            var curVel = (VP.estado && typeof VP.estado.velocidadActual === 'number' && !isNaN(VP.estado.velocidadActual)) ? VP.estado.velocidadActual : 1;

            var cTime = (util && typeof util.formatearTiempo === 'function' && !isNaN(v.currentTime)) ? util.formatearTiempo(v.currentTime) : '0:00';
            var dTime = (util && typeof util.formatearTiempo === 'function' && !isNaN(v.duration) && isFinite(v.duration)) ? util.formatearTiempo(v.duration) : '0:00';

            var plLen = (VP.estado && Array.isArray(VP.estado.playlist)) ? VP.estado.playlist.length : 0;
            var lIDB = (VP.metricas && typeof VP.metricas.lecturasIDB === 'number' && !isNaN(VP.metricas.lecturasIDB)) ? VP.metricas.lecturasIDB : 0;
            var wIDB = (VP.metricas && typeof VP.metricas.escriturasIDB === 'number' && !isNaN(VP.metricas.escriturasIDB)) ? VP.metricas.escriturasIDB : 0;
            var eIDB = (VP.metricas && typeof VP.metricas.erroresIDB === 'number' && !isNaN(VP.metricas.erroresIDB)) ? VP.metricas.erroresIDB : 0;

            var filas = [
                ['Res',      res + fps],
                ['Tiempo',   cTime + ' / ' + dTime],
                ['Buffer',   buf],
                ['Capítulo', capStr],
                ['Vel',      curVel + 'x'],
                ['Vol',      Math.round(valVol * 100) + '%'],
                ['Blobs',    BlobLRU.size()],
                ['Mem',      picoMem + 'MB'],
                ['IDB',      'R' + lIDB + '/W' + wIDB + '/E' + eIDB],
                ['Playlist', plLen + ' videos'],
            ];

            panel.innerHTML = filas.map(function (f) {
                var k = util && typeof util.escaparHTML === 'function'
                    ? util.escaparHTML(f[0] || '')
                    : String(f[0] || '');
                var vTxt = util && typeof util.escaparHTML === 'function'
                    ? util.escaparHTML(f[1] || '')
                    : String(f[1] || '');
                return '<div class="stats-row">' +
                       '<span class="stats-key">'   + k + '</span>' +
                       '<span class="stats-val">'   + vTxt + '</span>' +
                       '</div>';
            }).join('');

        }, 'actualizarEstadisticas');
    };

    // ============================================================
    // MEDIA SESSION API
    // ============================================================

    VP.reproductor.actualizarMediaSession = function () {
        if (!VP.features || !VP.features.mediaSession || !navigator || !navigator.mediaSession) return;

        _safe(function () {
            var ci = VP.estado ? VP.estado.currentVideoIndex : -1;
            var pl = VP.estado ? VP.estado.playlist : null;
            var vo = (ci >= 0 && Array.isArray(pl)) ? pl[ci] : null;
            if (!vo) {
                if (navigator.mediaSession && navigator.mediaSession.metadata !== undefined) {
                    navigator.mediaSession.metadata = null;
                }
                return;
            }

            var artwork = (vo.thumbnail && typeof vo.thumbnail === 'string')
                ? [{ src: vo.thumbnail, sizes: '240x135', type: 'image/jpeg' }]
                : [];

            if (typeof MediaMetadata === 'function') {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title:   _safeStr(vo.name) || 'Video',
                    artist:  'Video Player',
                    album:   (VP.runtime && VP.runtime.dirHandle && VP.runtime.dirHandle.name) || '',
                    artwork: artwork,
                });
            }

            var acciones = {
                play:          function () { VP.reproductor.togglePlayPause(); },
                pause:         function () { VP.reproductor.togglePlayPause(); },
                previoustrack: function () { VP.reproductor.anterior(); },
                nexttrack:     function () { VP.reproductor.siguiente(); },
                seekbackward:  function (d) {
                    var v2 = _video();
                    if (!v2) return;
                    var offset = (d && typeof d.seekOffset === 'number' && !isNaN(d.seekOffset)) ? d.seekOffset : CONST.PASO_SEEK_S;
                    _safe(function () {
                        v2.currentTime = Math.max(0, v2.currentTime - offset);
                    }, 'mediaSession:seekback');
                },
                seekforward: function (d) {
                    var v2 = _video();
                    if (!v2) return;
                    var offset = (d && typeof d.seekOffset === 'number' && !isNaN(d.seekOffset)) ? d.seekOffset : CONST.PASO_SEEK_S;
                    _safe(function () {
                        var dur = typeof v2.duration === 'number' && !isNaN(v2.duration) ? v2.duration : 0;
                        v2.currentTime = Math.min(dur, v2.currentTime + offset);
                    }, 'mediaSession:seekfwd');
                },
                seekto: function (d) {
                    if (d && typeof d.seekTime === 'number' && !isNaN(d.seekTime)) {
                        _safe(function () {
                            var v2 = _video();
                            if (v2) v2.currentTime = Math.max(0, d.seekTime);
                        }, 'mediaSession:seekto');
                    }
                },
                stop: function () { VP.reproductor.detener(); },
            };

            if (typeof navigator.mediaSession.setActionHandler === 'function') {
                Object.keys(acciones).forEach(function (clave) {
                    _safe(function () {
                        navigator.mediaSession.setActionHandler(clave, acciones[clave]);
                    }, 'mediaSession:handler:' + clave);
                });
            }

            _estado.mediaSessionOK = true;

        }, 'actualizarMediaSession');
    };

    VP.reproductor.actualizarPosicionMediaSession = (util && typeof util.throttle === 'function') ? util.throttle(
        function () {
            if (!VP.features || !VP.features.mediaSession || !_estado.mediaSessionOK || !navigator || !navigator.mediaSession || typeof navigator.mediaSession.setPositionState !== 'function') return;

            _safe(function () {
                var v = _video();
                if (!v || !v.src) return;
                var d = v.duration;
                var c = v.currentTime;
                if (!isFinite(d) || d <= 0 || isNaN(c)) return;
                var pr = typeof v.playbackRate === 'number' && !isNaN(v.playbackRate) ? v.playbackRate : 1;

                navigator.mediaSession.setPositionState({
                    duration:     d,
                    playbackRate: pr,
                    position:     Math.max(0, Math.min(c, d)),
                });
            }, 'actualizarPosicionMediaSession');
        },
        1000
    ) : function() {};

    // ============================================================
    // WATCHDOG DE SALUD DEL REPRODUCTOR
    // ============================================================

    VP.reproductor.iniciarWatchdog = function () {
        if (VP.runtime && VP.runtime.watchdogInterval) {
            if (log && log.debug) log.debug('Watchdog ya activo.');
            return;
        }

        var _ultimoCurrentTime = -1;
        var _contadorAtasco    = 0;
        var MAX_ATASCO         = 3;
        var _blobsSobreLimite  = false;
        var _playlistGrande    = false;

        if (VP.runtime) {
            VP.runtime.watchdogInterval = setInterval(function () {
                _safe(function () {

                    _safe(function () {
                        if (typeof VP.verificarRendimientoAdaptativo === 'function') VP.verificarRendimientoAdaptativo();
                    }, 'watchdog:rendimiento');

                    var numBlobs = BlobLRU.size();
                    if (numBlobs > CONST.MAX_BLOBS_ACTIVOS) {
                        if (!_blobsSobreLimite && log && log.warn) log.warn('Watchdog: blobs activos:', numBlobs);
                        _blobsSobreLimite = true;
                    } else {
                        _blobsSobreLimite = false;
                    }

                    var ci    = VP.estado ? VP.estado.currentVideoIndex : -1;
                    var v     = _video();
                    var lo    = VP.refs ? VP.refs.loadingOverlay : null;

                    if (ci >= 0 && v && v.src && !v.paused && !v.ended) {
                        if (v.readyState < 2) {
                            _contadorAtasco++;
                            if (_contadorAtasco === MAX_ATASCO) {
                                if (log && log.warn) log.warn(
                                    'Watchdog: video posiblemente atascado',
                                    '| readyState:', v.readyState,
                                    '| iter:', _contadorAtasco
                                );
                                if (dom && !dom.esNulo(lo) && lo.classList && typeof lo.classList.contains === 'function' && !lo.classList.contains('active')) {
                                    lo.classList.add('active');
                                }
                            }
                        } else {
                            if (_contadorAtasco > 0) {
                                _contadorAtasco = 0;
                                if (dom && !dom.esNulo(lo) && lo.classList && typeof lo.classList.remove === 'function') {
                                    lo.classList.remove('active');
                                }
                            }
                        }

                        var ct = v.currentTime;
                        if (v.readyState >= 3 &&
                            ct === _ultimoCurrentTime &&
                            _ultimoCurrentTime > 0) {
                            if (log && log.warn) log.warn(
                                'Watchdog: currentTime congelado en',
                                (util && typeof util.formatearTiempo === 'function') ? util.formatearTiempo(ct) : Math.round(ct) + 's'
                            );
                        }
                        if (!isNaN(ct)) _ultimoCurrentTime = ct;

                    } else {
                        _contadorAtasco    = 0;
                        _ultimoCurrentTime = -1;
                    }

                    _safe(function () {
                        if (typeof VP.actualizarPicoMemoria === 'function') VP.actualizarPicoMemoria();
                    }, 'watchdog:mem');

                    var pl = VP.estado ? VP.estado.playlist : null;
                    if (Array.isArray(pl) && pl.length > 5000) {
                        if (!_playlistGrande && log && log.warn) log.warn(
                            'Watchdog: playlist muy grande →',
                            pl.length, 'videos'
                        );
                        _playlistGrande = true;
                    } else {
                        _playlistGrande = false;
                    }

                }, 'watchdog:loop');

            }, CONST.WATCHDOG_INTERVAL_MS);
        }

        if (log && log.debug) log.debug('Watchdog iniciado (intervalo: ' + CONST.WATCHDOG_INTERVAL_MS + 'ms).');
    };

    VP.reproductor.detenerWatchdog = function () {
        if (VP.runtime && VP.runtime.watchdogInterval) {
            clearInterval(VP.runtime.watchdogInterval);
            VP.runtime.watchdogInterval = null;
        }
        if (log && log.debug) log.debug('Watchdog detenido.');
    };

    // ============================================================
    // RESET COMPLETO DEL REPRODUCTOR
    // ============================================================

    VP.reproductor.reset = function () {
        if (log && log.info) log.info('Reproductor: iniciando reset...');

        _safe(function () { if (VP.carga && typeof VP.carga.cancelar === 'function') VP.carga.cancelar(); }, 'reset:cancelarCarga');
        if (typeof VP.reproductor.limpiarVideo === 'function') VP.reproductor.limpiarVideo();
        if (typeof VP.reproductor.cancelarUpNext === 'function') VP.reproductor.cancelarUpNext();
        BatchQueue.cancelarTodo();

        _safe(function () {
            BlobLRU.clear();
            if (typeof VP.revocarTodosBlobURLs === 'function') VP.revocarTodosBlobURLs();
        }, 'reset:blobs');

        if (VP.estado) VP.estado.currentVideoIndex = -1;
        GeneracionToken.siguiente();

        _safe(function () {
            var refs = VP.refs || {};
            _style(refs.progressBar,      'width',   '0%');
            _style(refs.progressBuffered, 'width',   '0%');
            _style(refs.progressScrubber, 'left',    '0%');

            var pc = refs.progressContainer;
            if (dom && !dom.esNulo(pc) && pc.classList && typeof pc.classList.remove === 'function') {
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
            if (VP.estado) VP.estado.abRepeat = { a: null, b: null, activo: false };
            _style(refs.abRepeatBtn, 'color', '');

            _css(refs.statsPanel,  'remove', 'visible');
            _css(refs.speedMenu,   'remove', 'open');
        }, 'reset:ui');

        if (typeof VP.reproductor.establecerEstadoPlay === 'function') VP.reproductor.establecerEstadoPlay(false);
        _safe(function () { if (VP.listas && typeof VP.listas.resaltarItemActivo === 'function') VP.listas.resaltarItemActivo(); }, 'reset:lista');

        if (typeof VP.liberarGuard === 'function') {
            VP.liberarGuard('reproducirVideo');
            VP.liberarGuard('cargarDir');
        }

        if (VP.estado) VP.estado.capitulos = [];
        if (typeof VP.reproductor.actualizarMarcadoresCapitulos === 'function') VP.reproductor.actualizarMarcadoresCapitulos();

        if (VP.runtime) {
            VP.runtime.isScrubbing = false;
            if (VP.runtime.sleepTimerInterval) clearInterval(VP.runtime.sleepTimerInterval);
            VP.runtime.sleepTimerInterval = null;
        }
        _safe(function () {
            if (VP.miniaturas && typeof VP.miniaturas.ocultarPreviewProgreso === 'function') VP.miniaturas.ocultarPreviewProgreso();
        }, 'reset:preview');

        if (_estado.statsTimer) clearInterval(_estado.statsTimer);
        _estado.statsTimer = null;

        _safe(function () {
            if (dom && typeof dom.modalEstaAbierto === 'function' && dom.modalEstaAbierto()) {
                if (typeof dom.cerrarModal === 'function') dom.cerrarModal();
            }
        }, 'reset:modal');

        _estado.mediaSessionOK    = false;
        _estado.ultimoTimeUpdate  = 0;

        _safe(function () {
            if (VP.features && VP.features.mediaSession && navigator && navigator.mediaSession) {
                if (navigator.mediaSession.metadata !== undefined) navigator.mediaSession.metadata = null;
            }
        }, 'reset:mediaSession');

        if (typeof VP.reproductor._actualizarTituloDoc === 'function') VP.reproductor._actualizarTituloDoc('');
        _notif('Reproductor reiniciado', 'info');

        if (bus && typeof bus.emit === 'function') bus.emit('reset');
        if (log && log.info) log.info('Reproductor: reset completado.');
    };

    window.resetPlayer = VP.reproductor.reset;

    // ============================================================
    // INICIALIZAR SOPORTE DE PRESIÓN DE MEMORIA
    // ============================================================

    VP.reproductor.inicializarMonitorMemoria = function () {
        if (MemoryMonitor && typeof MemoryMonitor.iniciar === 'function') {
            MemoryMonitor.iniciar(function (usadoMB) {
                if (log && log.warn) log.warn('Presión de memoria detectada:', Math.round(usadoMB) + 'MB');

                if (BlobLRU && typeof BlobLRU.setLimite === 'function') {
                    BlobLRU.setLimite(10);
                    setTimeout(function () {
                        if (BlobLRU && typeof BlobLRU.setLimite === 'function') BlobLRU.setLimite(CONST.BLOB_POOL_MAX || 50);
                    }, 60000);
                }

                if (BatchQueue && typeof BatchQueue.cancelar === 'function') BatchQueue.cancelar('thumbnails');

                _notif('Memoria alta — liberando recursos', 'advertencia');

            }, 400);
        }
    };
    // ============================================================
    // VIRTUALIZACIÓN DE PLAYLIST
    // ============================================================

    VP.reproductor.virtualizarPlaylist = function (contenedor, itemHeight) {
        if (dom && dom.esNulo(contenedor)) return;

        itemHeight = (typeof itemHeight === 'number' && !isNaN(itemHeight) && itemHeight > 0) ? itemHeight : 60;

        var pl        = VP.estado ? VP.estado.playlist : null;
        if (!Array.isArray(pl)) return;
        var total     = pl.length;
        var alturaTotal = total * itemHeight;
        if (isNaN(alturaTotal)) alturaTotal = 0;

        var spacer = document.createElement('div');
        spacer.style.height = alturaTotal + 'px';
        spacer.style.pointerEvents = 'none';
        if (contenedor.appendChild) contenedor.appendChild(spacer);

        var _nodosRenderizados = {};
        var _renderizando = false;

        function _renderizar() {
            if (_renderizando) return;
            _renderizando = true;

            var rAF = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function(cb){ setTimeout(cb, 16); };

            rAF(function () {
                var scrollTop  = typeof contenedor.scrollTop === 'number' && !isNaN(contenedor.scrollTop) ? contenedor.scrollTop : 0;
                var visHeight  = typeof contenedor.clientHeight === 'number' && !isNaN(contenedor.clientHeight) ? contenedor.clientHeight : 0;

                var primerVis  = Math.max(0,
                    Math.floor(scrollTop / itemHeight) - 5);
                var ultimoVis  = Math.min(total - 1,
                    Math.ceil((scrollTop + visHeight) / itemHeight) + 5);

                var claves = Object.keys(_nodosRenderizados);
                for (var k = 0; k < claves.length; k++) {
                    var ki = parseInt(claves[k]);
                    if (isNaN(ki)) continue;
                    if (ki < primerVis || ki > ultimoVis) {
                        _safe(function () {
                            if (contenedor.removeChild && _nodosRenderizados[ki]) {
                                contenedor.removeChild(_nodosRenderizados[ki]);
                            }
                        }, 'virtual:remove');
                        delete _nodosRenderizados[ki];
                    }
                }

                for (var i = primerVis; i <= ultimoVis; i++) {
                    if (_nodosRenderizados[i]) continue;

                    var item = null;
                    if (VP.listas && typeof VP.listas.crearItemPlaylist === 'function') {
                        item = VP.listas.crearItemPlaylist(pl[i], i);
                    }
                    if (!item || !item.style) continue;

                    item.style.position = 'absolute';
                    item.style.top      = (i * itemHeight) + 'px';
                    item.style.width    = '100%';

                    _nodosRenderizados[i] = item;
                    if (contenedor.appendChild) contenedor.appendChild(item);
                }

                _renderizando = false;
            });
        }

        if (contenedor.style) {
            contenedor.style.position = 'relative';
            contenedor.style.overflow = 'auto';
        }

        var scrollHandler = (util && typeof util.rafThrottle === 'function') ? util.rafThrottle(_renderizar) : _renderizar;
        contenedor.addEventListener('scroll', scrollHandler);

        _renderizar();

        if (log && log.debug) log.debug('Virtualización de playlist activada →', total, 'videos, itemHeight:', itemHeight + 'px');
    };

    // ============================================================
    // SCREEN WAKE LOCK API (Chrome & Brave compatibility)
    // ============================================================

    VP.reproductor.solicitarWakeLock = function () {
        if (!VP.features || !VP.features.wakeLock || !navigator.wakeLock) return;
        if (VP.runtime && VP.runtime.wakeLockObj) return;
        try {
            var p = navigator.wakeLock.request('screen');
            if (p && typeof p.then === 'function') {
                p.then(function (wl) {
                    if (VP.runtime) VP.runtime.wakeLockObj = wl;
                    wl.addEventListener('release', function () {
                        if (VP.runtime) VP.runtime.wakeLockObj = null;
                    });
                }).catch(function (err) {
                    if (log && log.debug) log.debug('WakeLock no concedido:', err.message || err);
                });
            }
        } catch (e) {
            if (log && log.debug) log.debug('WakeLock excepción:', e.message || e);
        }
    };

    VP.reproductor.liberarWakeLock = function () {
        if (VP.runtime && VP.runtime.wakeLockObj) {
            try {
                if (typeof VP.runtime.wakeLockObj.release === 'function') {
                    VP.runtime.wakeLockObj.release().catch(function () {});
                }
            } catch (_) {}
            VP.runtime.wakeLockObj = null;
        }
    };

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            var v = _video();
            if (v && !v.paused && !v.ended && typeof VP.reproductor.solicitarWakeLock === 'function') {
                VP.reproductor.solicitarWakeLock();
            }
        }
    });

    if (log && log.info) log.info('vp-reproductor-sistema.js cargado.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-reproductor-sistema.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
