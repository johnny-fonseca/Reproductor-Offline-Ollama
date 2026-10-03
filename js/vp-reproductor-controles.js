'use strict';

(function (window, document) {

    var VP = window.VP;
    if (!VP) {
        throw new Error(
            '[VP] vp-reproductor-controles.js: vp-base.js debe cargarse primero.'
        );
    }

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;

    var _int    = VP.reproductor._internal;
    var CONST   = _int.CONST;
    var _estado = _int._estado;
    var _safe   = _int._safe;
    var _video  = _int._video;
    var _videoActual = _int._videoActual;
    var _notif  = _int._notif;
    var _css    = _int._css;
    var _style  = _int._style;
    var _pct    = _int._pct;
    var _esFullscreen = _int._esFullscreen;
    var _runIdle = _int._runIdle;

    function _actualizarModoMochi() {
        if (!VP.mochiMascota || typeof VP.mochiMascota.cambiarModo !== 'function') return;
        var wrap = VP.refs && VP.refs.videoPlayerWrap;
        var modo = 'normal';
        if (document.pictureInPictureElement) modo = 'pip';
        else if (_esFullscreen()) modo = 'fullscreen';
        else if (wrap && wrap.classList && wrap.classList.contains('theatre-mode')) modo = 'cine';
        VP.mochiMascota.cambiarModo(modo);
    }

    // ============================================================
    // ESTADO DE PLAY/PAUSE EN UI
    // ============================================================

    VP.reproductor.establecerEstadoPlay = function (reproduciendo) {
        _safe(function () {
            var refs = VP.refs || {};
            _style(refs.iconPlay,  'display', reproduciendo ? 'none' : '');
            _style(refs.iconPause, 'display', reproduciendo ? '' : 'none');

            if (dom && !dom.esNulo(refs.playPauseBtn) && refs.playPauseBtn.setAttribute) {
                refs.playPauseBtn.setAttribute(
                    'data-tooltip',
                    reproduciendo ? 'Pausar' : 'Reproducir'
                );
            }

            var pauseOverlay = refs.centerPlayOverlay;
            if (pauseOverlay) {
                var centerIconPlay  = refs.centerIconPlay;
                var centerIconPause = refs.centerIconPause;
                if (centerIconPlay)  centerIconPlay.style.display  = reproduciendo ? '' : 'none';
                if (centerIconPause) centerIconPause.style.display = reproduciendo ? 'none' : '';

                pauseOverlay.classList.remove('animate');
                void pauseOverlay.offsetWidth;
                pauseOverlay.classList.add('animate');

                if (pauseOverlay._hideTimer) clearTimeout(pauseOverlay._hideTimer);
                pauseOverlay._hideTimer = setTimeout(function () {
                    pauseOverlay.classList.remove('animate');
                }, 900);
            }
        }, 'establecerEstadoPlay');

        if (bus && typeof bus.emit === 'function') bus.emit(reproduciendo ? 'videoPlay' : 'videoPausado');
    };

    // ============================================================
    // VOLUMEN
    // ============================================================

    VP.reproductor.setVolumen = function (val) {
        var parsedVal = parseFloat(val);
        if (isNaN(parsedVal)) parsedVal = 1;
        var vol = (util && typeof util.clampNum === 'function') ? util.clampNum(parsedVal, 0, 1) : Math.max(0, Math.min(1, parsedVal));

        _safe(function () {
            var v = _video();
            if (!v) return;
            v.volume = vol;
            v.muted  = (vol === 0);
        }, 'setVolumen');

        if (typeof VP.reproductor.actualizarUIVolumen === 'function') VP.reproductor.actualizarUIVolumen();
    };

    VP.reproductor.actualizarUIVolumen = function () {
        var vol = 1, muted = false;

        _safe(function () {
            var v = _video();
            if (v) {
                vol   = v.volume;
                muted = v.muted;
            }
        }, 'actualizarUIVolumen:get');

        vol   = (typeof vol === 'number' && !isNaN(vol) && isFinite(vol)) ? vol : 1;
        muted = (typeof muted === 'boolean') ? muted : false;

        var efectivo = muted ? 0 : vol;

        _safe(function () {
            var refs = VP.refs || {};
            _style(refs.volumeBar, 'width', _pct(efectivo * 100));

            var esAlto   = !muted && vol >= 0.5;
            var esBajo   = !muted && vol > 0 && vol < 0.5;
            var esMuteado = muted || vol === 0;

            _style(refs.iconVolUp,   'display', esAlto   ? '' : 'none');
            _style(refs.iconVolDown, 'display', esBajo   ? '' : 'none');
            _style(refs.iconMute,    'display', esMuteado ? '' : 'none');

            if (dom && !dom.esNulo(refs.volumeBtn) && refs.volumeBtn.setAttribute) {
                refs.volumeBtn.setAttribute(
                    'data-tooltip',
                    esMuteado ? 'Activar sonido' : 'Silenciar'
                );
            }
        }, 'actualizarUIVolumen:ui');

        if (VP.ajustes) {
            VP.ajustes.volumenGlobal    = vol;
            VP.ajustes.silenciadoGlobal = muted;
            _safe(function () { if (typeof VP.ajustes.guardar === 'function') VP.ajustes.guardar(); }, 'actualizarUIVolumen:save');
        }
    };

    VP.reproductor.setVolumenDesdePuntero = function (e) {
        if (!e) return;
        var slider = VP.refs ? VP.refs.volumeSlider : null;
        if (dom && dom.esNulo(slider)) return;

        _safe(function () {
            if (!slider || typeof slider.getBoundingClientRect !== 'function') return;
            var r   = (dom && typeof dom.rectSeguro === 'function')
                ? dom.rectSeguro(slider)
                : slider.getBoundingClientRect();
            var w   = r.width || 1;
            var x;

            if (e.clientX !== undefined && e.clientX !== null) {
                x = e.clientX;
            } else if (e.touches && e.touches[0] && e.touches[0].clientX !== undefined) {
                x = e.touches[0].clientX;
            } else {
                return;
            }

            VP.reproductor.setVolumen((x - r.left) / w);
        }, 'setVolumenDesdePuntero');
    };

    // ============================================================
    // VELOCIDAD
    // ============================================================

    var VELOCIDADES_VALIDAS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4];

    VP.reproductor.setVelocidad = function (vel) {
        vel = parseFloat(vel);
        if (isNaN(vel) || !isFinite(vel) || vel <= 0) vel = 1;

        var mas_cercana = VELOCIDADES_VALIDAS.reduce(function (prev, curr) {
            return Math.abs(curr - vel) < Math.abs(prev - vel) ? curr : prev;
        });
        vel = mas_cercana;

        if (VP.estado) VP.estado.velocidadActual = vel;
        _safe(function () {
            var v = _video();
            if (v) v.playbackRate = vel;
        }, 'setVelocidad');

        if (VP.ajustes) {
            VP.ajustes.velocidadGlobal = vel;
            _safe(function () { if (typeof VP.ajustes.guardar === 'function') VP.ajustes.guardar(); }, 'setVelocidad:save');
        }

        if (typeof VP.reproductor.actualizarUIVelocidad === 'function') VP.reproductor.actualizarUIVelocidad(vel);
        _notif('Velocidad: ' + (vel === 1 ? 'Normal' : vel + 'x'), 'info');
    };

    VP.reproductor.actualizarUIVelocidad = function (vel) {
        _safe(function () {
            var refs = VP.refs || {};
            if (dom && !dom.esNulo(refs.speedBtn)) {
                refs.speedBtn.textContent = vel === 1 ? 'Normal' : vel + 'x';
            }

            var opciones = dom && dom.$$ ? dom.$$('.speed-option') : document.querySelectorAll('.speed-option');
            if (opciones) {
                for (var i = 0; i < opciones.length; i++) {
                    if (opciones[i].classList && typeof opciones[i].classList.toggle === 'function') {
                        var optSpeed = util && typeof util.parsearDecimal === 'function' ? util.parsearDecimal(opciones[i].dataset.speed) : parseFloat(opciones[i].dataset.speed);
                        opciones[i].classList.toggle(
                            'active',
                            optSpeed === vel
                        );
                    }
                }
            }
        }, 'actualizarUIVelocidad');
    };

    // ============================================================
    // FULLSCREEN
    // ============================================================

    VP.reproductor.toggleFullscreen = function () {
        _safe(function () {
            var el = VP.refs ? VP.refs.videoPlayerWrap : null;
            if (dom && dom.esNulo(el)) return;

            if (!_esFullscreen()) {
                var req = el.requestFullscreen          ||
                          el.webkitRequestFullscreen    ||
                          el.mozRequestFullScreen       ||
                          el.msRequestFullscreen;
                if (typeof req === 'function') {
                    var p = req.call(el);
                    if (p && typeof p.catch === 'function') {
                        p.catch(function (err) {
                            if (log && log.warn) log.warn('requestFullscreen rechazado:', err);
                        });
                    }
                }
            } else {
                var exit = document.exitFullscreen         ||
                           document.webkitExitFullscreen   ||
                           document.mozCancelFullScreen    ||
                           document.msExitFullscreen;
                if (typeof exit === 'function') {
                    var p2 = exit.call(document);
                    if (p2 && typeof p2.catch === 'function') {
                        p2.catch(function (err) {
                            if (log && log.warn) log.warn('exitFullscreen rechazado:', err);
                        });
                    }
                }
            }
        }, 'toggleFullscreen');
    };

    VP.reproductor.actualizarIconoFullscreen = function () {
        _safe(function () {
            var esFS = _esFullscreen();
            var refs = VP.refs || {};
            _style(refs.iconExpand,   'display', esFS ? 'none' : '');
            _style(refs.iconCompress, 'display', esFS ? '' : 'none');

            if (dom && !dom.esNulo(refs.fullscreenBtn) && refs.fullscreenBtn.setAttribute) {
                refs.fullscreenBtn.setAttribute(
                    'data-tooltip',
                    esFS ? 'Salir de pantalla completa' : 'Pantalla completa'
                );
            }
        }, 'actualizarIconoFullscreen');
    };

    // ============================================================
    // MODO TEATRO
    // ============================================================

    VP.reproductor.toggleTeatro = function () {
        var wrap = VP.refs ? VP.refs.videoPlayerWrap : null;
        if (dom && dom.esNulo(wrap)) return;

        _safe(function () {
            if (wrap && wrap.classList && typeof wrap.classList.toggle === 'function') {
                wrap.classList.toggle('theatre-mode');
                var activo = wrap.classList.contains('theatre-mode');
                if (document.body && document.body.classList) document.body.classList.toggle('theatre-active', activo);
                _actualizarModoMochi();
                _notif('Modo teatro ' + (activo ? 'activado' : 'desactivado'), 'info');
                if (bus && typeof bus.emit === 'function') bus.emit('teatro', activo);
            }
        }, 'toggleTeatro');
    };

    // ============================================================
    // PICTURE IN PICTURE
    // ============================================================

    VP.reproductor.togglePiP = function () {
        if (!VP.features || !VP.features.pictureInPicture) {
            _notif('PiP no disponible en este navegador', 'error');
            return;
        }

        _safe(function () {
            var v = _video();
            if (!v) return;

            if (document.pictureInPictureElement) {
                if (typeof document.exitPictureInPicture === 'function') {
                    var p = document.exitPictureInPicture();
                    if (p && typeof p.catch === 'function') {
                        p.catch(function (e) {
                            if (log && log.warn) log.warn('exitPiP:', e);
                        });
                    }
                }
            } else {
                if (typeof v.requestPictureInPicture === 'function') {
                    if (VP.mochiMascota && typeof VP.mochiMascota.cambiarModo === 'function') VP.mochiMascota.cambiarModo('pip');
                    var p2 = v.requestPictureInPicture();
                    if (p2 && typeof p2.catch === 'function') {
                        p2.catch(function (e) {
                            if (log && log.warn) log.warn('requestPiP:', e);
                            _notif('PiP no disponible o rechazado', 'error');
                            _actualizarModoMochi();
                        });
                    }
                } else {
                    _notif('PiP no soportado por este elemento de video', 'error');
                }
            }
        }, 'togglePiP');
    };

    // ============================================================
    // DISPLAY DE TIEMPO
    // ============================================================

    VP.reproductor.refrescarDisplayTiempo = function () {
        _safe(function () {
            var v = _video();
            if (!v || !v.src) return;

            var d = v.duration;
            var c = v.currentTime;
            if (!isFinite(d) || d <= 0 || isNaN(c)) return;

            var td = VP.refs ? VP.refs.timeDisplay : null;
            if (dom && dom.esNulo(td)) return;

            if (util && typeof util.formatearTiempo === 'function') {
                td.textContent = (VP.estado && VP.estado.mostrarTiempoRestante)
                    ? '-' + util.formatearTiempo(Math.max(0, d - c)) + ' / ' +
                      util.formatearTiempo(d)
                    : util.formatearTiempo(c) + ' / ' +
                      util.formatearTiempo(d);
            }
        }, 'refrescarDisplayTiempo');
    };

    // ============================================================
    // GESTOS TÁCTILES — DOBLE TOQUE & SEEK
    // ============================================================

    VP.reproductor.inicializarGestos = function () {
        var wrap = VP.refs ? VP.refs.videoPlayerWrap : null;
        if (dom && dom.esNulo(wrap)) return;

        _safe(function () { if (dom && typeof dom.inyectarCSSGestos === 'function') dom.inyectarCSSGestos(); }, 'initGestos:css');

        var video = _video();

        if (dom && !dom.esNulo(video)) {
            video.addEventListener('dblclick', function (e) {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                if (typeof VP.reproductor.toggleFullscreen === 'function') VP.reproductor.toggleFullscreen();
            });
        }

        if (!VP.features || !VP.features.touch) {
            if (log && log.debug) log.debug('Gestos: modo no táctil, solo dblclick registrado.');
            return;
        }

        var ultimoToque    = 0;
        var DOBLE_MS       = CONST.DOBLE_TOQUE_MS || 350;
        var timerToque     = null;
        var _touchBlocked  = false;

        if (dom && !dom.esNulo(video)) {
            video.addEventListener('touchstart', function () {
                _touchBlocked = false;
            }, { passive: true });

            video.addEventListener('touchmove', function () {
                _touchBlocked = true;
            }, { passive: true });

            video.addEventListener('touchend', function (e) {
                if (_touchBlocked) return;

                var toque = (e && e.changedTouches) ? e.changedTouches[0] : null;
                if (!toque) return;

                var ahora = Date.now();
                var dt    = ahora - ultimoToque;

                if (dt < DOBLE_MS && dt > 50) {
                    if (e && typeof e.preventDefault === 'function') e.preventDefault();
                    if (timerToque) clearTimeout(timerToque);

                    var rect   = typeof video.getBoundingClientRect === 'function' ? video.getBoundingClientRect() : {left: 0, width: 0};
                    var relX   = toque.clientX - rect.left;
                    var w      = rect.width || 1;
                    var tercio = w / 3;

                    if (relX < tercio) {
                        _safe(function () {
                            var offset = typeof CONST.PASO_SEEK_S === 'number' && !isNaN(CONST.PASO_SEEK_S) ? CONST.PASO_SEEK_S : 10;
                            var ct = typeof video.currentTime === 'number' && !isNaN(video.currentTime) ? video.currentTime : 0;
                            video.currentTime = Math.max(0, ct - offset);
                        }, 'gesture:seek-back');
                        if (dom && typeof dom.mostrarFeedbackToque === 'function') {
                            dom.mostrarFeedbackToque('\u23ea -' + (CONST.PASO_SEEK_S || 10) + 's', 'izquierda', wrap);
                        }

                    } else if (relX > tercio * 2) {
                        _safe(function () {
                            var offset = typeof CONST.PASO_SEEK_S === 'number' && !isNaN(CONST.PASO_SEEK_S) ? CONST.PASO_SEEK_S : 10;
                            var ct = typeof video.currentTime === 'number' && !isNaN(video.currentTime) ? video.currentTime : 0;
                            var dur = typeof video.duration === 'number' && !isNaN(video.duration) ? video.duration : 0;
                            video.currentTime = Math.min(dur, ct + offset);
                        }, 'gesture:seek-fwd');
                        if (dom && typeof dom.mostrarFeedbackToque === 'function') {
                            dom.mostrarFeedbackToque('\u23e9 +' + (CONST.PASO_SEEK_S || 10) + 's', 'derecha', wrap);
                        }

                    } else {
                        if (typeof VP.reproductor.toggleFullscreen === 'function') VP.reproductor.toggleFullscreen();
                    }

                    ultimoToque = 0;

                } else {
                    ultimoToque = ahora;
                    timerToque = setTimeout(function () {
                        ultimoToque = 0;
                    }, DOBLE_MS + 50);
                }

            }, { passive: false });
        }

        if (log && log.debug) log.debug('Gestos táctiles inicializados.');
    };

    // ============================================================
    // LONG PRESS — VELOCIDAD ×N TEMPORAL
    // ============================================================

    VP.reproductor.inicializarLongPress = function () {
        var video = _video();
        var wrap  = VP.refs ? VP.refs.videoPlayerWrap : null;

        if (!video || dom && dom.esNulo(wrap)) return;

        var timerLP      = null;
        var esLongPress  = false;
        var velGuardada  = 1;
        var LONG_MS      = CONST.LONG_PRESS_MS || 400;
        var VEL          = CONST.VEL_BOOST || 2;

        var feedback = document.createElement('div');
        feedback.className    = 'vp-longpress-feedback';
        feedback.style.cssText = [
            'position:absolute',
            'top:12px',
            'left:50%',
            'transform:translateX(-50%)',
            'background:rgba(0,0,0,.78)',
            'color:#fff',
            'padding:6px 18px',
            'border-radius:20px',
            'font-size:14px',
            'font-weight:700',
            'pointer-events:none',
            'z-index:9999',
            'display:none',
            'transition:opacity .2s',
            'user-select:none',
            'white-space:nowrap',
        ].join(';');
        feedback.textContent = '\u23e9 \u00d7' + VEL;
        if (wrap && wrap.appendChild) wrap.appendChild(feedback);

        function _esControlUI(target) {
            var t = target;
            while (t && t !== wrap) {
                if ((VP.refs && t === VP.refs.videoControls) ||
                    (VP.refs && t === VP.refs.progressContainer)) return true;
                t = t.parentNode;
            }
            return false;
        }

        function iniciarLP(e) {
            var v2 = _video();
            if (!v2 || !v2.src || v2.paused) return;
            if (e && _esControlUI(e.target)) return;

            if (timerLP) clearTimeout(timerLP);
            esLongPress = false;

            timerLP = setTimeout(function () {
                esLongPress = true;
                velGuardada = (VP.estado && typeof VP.estado.velocidadActual === 'number' && !isNaN(VP.estado.velocidadActual)) ? VP.estado.velocidadActual : 1;
                _safe(function () { v2.playbackRate = VEL; }, 'longPress:boost');
                if (feedback.style) {
                    feedback.style.display = 'block';
                    feedback.style.opacity = '1';
                }
                if (log && log.debug) log.debug('LongPress: boost \u00d7' + VEL + ' activado.');
            }, LONG_MS);
        }

        function terminarLP() {
            if (timerLP) clearTimeout(timerLP);
            if (!esLongPress) return;
            esLongPress = false;

            _safe(function () {
                var v2 = _video();
                if (v2) v2.playbackRate = typeof velGuardada === 'number' && !isNaN(velGuardada) ? velGuardada : 1;
            }, 'longPress:restore');

            if (feedback.style) {
                feedback.style.opacity = '0';
                setTimeout(function () {
                    feedback.style.display = 'none';
                }, 220);
            }

            if (log && log.debug) log.debug('LongPress: velocidad restaurada a', velGuardada);
        }

        video.addEventListener('mousedown',  iniciarLP);
        video.addEventListener('mouseleave', terminarLP);
        document.addEventListener('mouseup', terminarLP);

        if (VP.features && VP.features.touch) {
            video.addEventListener('touchstart', function (e) {
                if (e && e.touches && e.touches.length === 1) iniciarLP(e.touches[0]);
            }, { passive: true });
            document.addEventListener('touchend',    terminarLP);
            document.addEventListener('touchcancel', terminarLP);
        }

        if (log && log.debug) log.debug('Long press de velocidad inicializado.');
    };

    // ============================================================
    // AUTO-SAVE PERIÓDICO DE PROGRESO
    // ============================================================

    VP.reproductor.inicializarAutoSave = function () {
        if (VP.runtime && VP.runtime.autoSaveInterval) {
            clearInterval(VP.runtime.autoSaveInterval);
        }

        if (VP.runtime) {
            VP.runtime.autoSaveInterval = setInterval(function () {
                _safe(function () {
                    var ci    = VP.estado ? VP.estado.currentVideoIndex : -1;
                    var video = _video();

                    if (ci >= 0 && video && video.src && !video.paused) {
                        _runIdle(function() { if (typeof VP.reproductor._guardarProgresoImpl === 'function') VP.reproductor._guardarProgresoImpl(); });
                    }
                }, 'autoSave');
            }, CONST.AUTO_SAVE_INTERVAL_MS || 30000);
        }

        if (log && log.debug) log.debug('Auto-save inicializado (cada ' + ((CONST.AUTO_SAVE_INTERVAL_MS || 30000) / 1000) + 's).');
    };

    // ============================================================
    // INICIALIZAR BOTONES DE CONTROL
    // ============================================================

    VP.reproductor.inicializarBotones = function () {
        if (_estado.listenersBound) {
            if (log && log.warn) log.warn('inicializarBotones: ya inicializado, ignorando.');
            return;
        }

        var refs = VP.refs || {};

        function _btn(ref, handler, throttleMs) {
            if (dom && dom.esNulo(ref) || typeof handler !== 'function') return;
            var fn = (throttleMs && util && typeof util.throttle === 'function')
                ? util.throttle(handler, throttleMs)
                : handler;
            ref.addEventListener('click', fn);
        }

        _btn(refs.playPauseBtn, VP.reproductor.togglePlayPause,  300);
        _btn(refs.centerPlayBtn, VP.reproductor.togglePlayPause, 300);

        _btn(refs.prevBtn, VP.reproductor.anterior,  300);
        _btn(refs.nextBtn, VP.reproductor.siguiente, 300);

        _btn(refs.snapshotBtn, VP.reproductor.capturarFotograma, 600);

        if (dom && !dom.esNulo(refs.volumeBtn)) {
            refs.volumeBtn.addEventListener('click', function () {
                _safe(function () {
                    var v = _video();
                    if (v) v.muted = !v.muted;
                }, 'volumeBtn:click');
                if (typeof VP.reproductor.actualizarUIVolumen === 'function') VP.reproductor.actualizarUIVolumen();
            });
        }

        _inicializarSliderVolumen(refs);

        _inicializarBtnFullscreen(refs);

        ['fullscreenchange', 'webkitfullscreenchange',
         'mozfullscreenchange', 'MSFullscreenChange'].forEach(function (ev) {
            document.addEventListener(ev, function() {
                if (typeof VP.reproductor.actualizarIconoFullscreen === 'function') VP.reproductor.actualizarIconoFullscreen();
                _actualizarModoMochi();
            });
        });

        _inicializarBtnPiP(refs);

        _safe(function () { if (VP.subtitulos && typeof VP.subtitulos.inicializar === 'function') VP.subtitulos.inicializar(); }, 'initBotones:sub');

        if (util && typeof util.throttle === 'function') {
            _btn(refs.loopBtn, util.throttle(function () {
                if (VP.ajustes) {
                    VP.ajustes.repetir = !VP.ajustes.repetir;
                    _style(refs.loopBtn, 'color', VP.ajustes.repetir ? 'var(--yt-red)' : '');
                    _safe(function () { if (typeof VP.ajustes.guardar === 'function') VP.ajustes.guardar(); }, 'loop:save');
                    _notif(VP.ajustes.repetir ? 'Loop ON' : 'Loop OFF', 'info');
                    if (VP.mochiMascota && typeof VP.mochiMascota.reaccionControlReproduccion === 'function') VP.mochiMascota.reaccionControlReproduccion('repetir');
                }
            }, 300), 0);
        }

        if (util && typeof util.throttle === 'function') {
            _btn(refs.shuffleBtn, util.throttle(function () {
                if (typeof VP.reproductor.toggleAleatorio === 'function') VP.reproductor.toggleAleatorio();
            }, 300), 0);
        }

        _btn(refs.abRepeatBtn, VP.reproductor.toggleABRepeat, 300);

        _btn(refs.chapterBtn, VP.reproductor.agregarCapitulo, 300);

        if (util && typeof util.throttle === 'function') {
            _btn(refs.statsBtn, util.throttle(function () {
                var panel = refs.statsPanel;
                if (dom && dom.esNulo(panel)) return;
                if (panel.classList && typeof panel.classList.toggle === 'function') panel.classList.toggle('visible');
                if (panel.classList && panel.classList.contains('visible') && VP.ajustes && !VP.ajustes.ultraRendimiento) {
                    if (typeof VP.reproductor.actualizarEstadisticas === 'function') VP.reproductor.actualizarEstadisticas();
                    if (_estado.statsTimer) clearInterval(_estado.statsTimer);
                    _estado.statsTimer = setInterval(function () {
                        if (dom && !dom.esNulo(panel) && panel.classList && panel.classList.contains('visible')) {
                            if (typeof VP.reproductor.actualizarEstadisticas === 'function') VP.reproductor.actualizarEstadisticas();
                        } else {
                            if (_estado.statsTimer) clearInterval(_estado.statsTimer);
                        }
                    }, CONST.STATS_UPDATE_INTERVAL_MS || 1000);
                } else {
                    if (_estado.statsTimer) clearInterval(_estado.statsTimer);
                }
            }, 300), 0);
        }

        if (dom && !dom.esNulo(refs.timeDisplay)) {
            refs.timeDisplay.addEventListener('click', function () {
                if (VP.estado) {
                    VP.estado.mostrarTiempoRestante = !VP.estado.mostrarTiempoRestante;
                }
                if (typeof VP.reproductor.refrescarDisplayTiempo === 'function') VP.reproductor.refrescarDisplayTiempo();
            });
        }

        _inicializarMenuVelocidad(refs);

        if (dom && !dom.esNulo(refs.cancelUpNextBtn)) {
            refs.cancelUpNextBtn.addEventListener(
                'click', function() { if (typeof VP.reproductor.cancelarUpNext === 'function') VP.reproductor.cancelarUpNext(); }
            );
        }

        _estado.listenersBound = true;
        if (log && log.debug) log.debug('Botones del reproductor inicializados.');
    };

    function _inicializarSliderVolumen(refs) {
        var slider = refs.volumeSlider;
        if (dom && dom.esNulo(slider)) return;
        var _volDragActivo = false;
        var control = slider.closest ? slider.closest('.volume-control') : null;
        var punteroActivo = null;

        function aplicarPuntero(evento) {
            if (typeof VP.reproductor.setVolumenDesdePuntero === 'function') {
                VP.reproductor.setVolumenDesdePuntero(evento);
            }
        }
        function mover(evento) {
            if (_volDragActivo && evento.pointerId === punteroActivo) aplicarPuntero(evento);
        }
        function terminar(evento) {
            if (!_volDragActivo || (evento && evento.pointerId !== punteroActivo)) return;
            _volDragActivo = false;
            punteroActivo = null;
            if (control) {
                control.classList.remove('is-dragging');
                control.classList.add('is-collapsed-after-drag');
            }
            document.removeEventListener('pointermove', mover);
            document.removeEventListener('pointerup', terminar);
            document.removeEventListener('pointercancel', terminar);
            if (document.activeElement === slider) slider.blur();
        }

        if (control) {
            function quitarColapsoTemporal() { control.classList.remove('is-collapsed-after-drag'); }
            control.addEventListener('pointerenter', quitarColapsoTemporal);
            control.addEventListener('pointerleave', quitarColapsoTemporal);
        }
        slider.addEventListener('pointerdown', function (evento) {
            if (_volDragActivo) return;
            _volDragActivo = true;
            punteroActivo = evento.pointerId;
            if (control) {
                control.classList.remove('is-collapsed-after-drag');
                control.classList.add('is-dragging');
            }
            aplicarPuntero(evento);
            document.addEventListener('pointermove', mover);
            document.addEventListener('pointerup', terminar);
            document.addEventListener('pointercancel', terminar);
        });
        slider.addEventListener('keydown', function (evento) {
            var video = _video();
            if (!video) return;
            var volumen = video.muted ? 0 : video.volume;
            var cambio = 0;
            if (evento.key === 'ArrowLeft' || evento.key === 'ArrowDown') cambio = -0.05;
            else if (evento.key === 'ArrowRight' || evento.key === 'ArrowUp') cambio = 0.05;
            else if (evento.key === 'Home') cambio = -1;
            else if (evento.key === 'End') cambio = 1;
            else return;
            evento.preventDefault();
            VP.reproductor.setVolumen(cambio === -1 ? 0 : cambio === 1 ? 1 : volumen + cambio);
            slider.setAttribute('aria-valuenow', String(Math.round((_video().muted ? 0 : _video().volume) * 100)));
        });
    }

    function _inicializarBtnFullscreen(refs) {
        var btn = refs.fullscreenBtn;
        if (dom && dom.esNulo(btn)) return;

        var fsPT = null;
        var fsLP = false;

        function _iniciarLPFS() {
            fsLP = false;
            if (fsPT) clearTimeout(fsPT);
            fsPT = setTimeout(function () {
                fsLP = true;
                if (typeof VP.reproductor.toggleTeatro === 'function') VP.reproductor.toggleTeatro();
            }, 500);
        }

        function _terminarLPFS(ejecutarFS) {
            if (fsPT) clearTimeout(fsPT);
            if (ejecutarFS && !fsLP && typeof VP.reproductor.toggleFullscreen === 'function') VP.reproductor.toggleFullscreen();
            fsLP = false;
        }

        btn.addEventListener('mousedown', _iniciarLPFS);
        btn.addEventListener('mouseup',   function () { _terminarLPFS(true);  });
        btn.addEventListener('mouseleave',function () { _terminarLPFS(false); });

        btn.addEventListener('touchstart', function (e) {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            _iniciarLPFS();
        }, { passive: false });

        btn.addEventListener('touchend', function (e) {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            _terminarLPFS(true);
        });

        btn.addEventListener('touchcancel', function () {
            _terminarLPFS(false);
        });
    }

    function _inicializarBtnPiP(refs) {
        if (dom && !dom.esNulo(refs.pipBtn)) {
            refs.pipBtn.addEventListener('click', function () {
                if (typeof VP.reproductor.togglePiP === 'function') VP.reproductor.togglePiP();
            });
        }

        var video = _video();
        if (dom && dom.esNulo(video)) return;

        video.addEventListener('enterpictureinpicture', function () {
            _actualizarModoMochi();
            if (dom && !dom.esNulo(refs.pipBtn) && refs.pipBtn.classList && typeof refs.pipBtn.classList.add === 'function') {
                refs.pipBtn.classList.add('active-btn');
                if (typeof refs.pipBtn.setAttribute === 'function') refs.pipBtn.setAttribute('data-tooltip', 'Salir de PiP');
            }
        });

        video.addEventListener('leavepictureinpicture', function () {
            _actualizarModoMochi();
            if (dom && !dom.esNulo(refs.pipBtn) && refs.pipBtn.classList && typeof refs.pipBtn.classList.remove === 'function') {
                refs.pipBtn.classList.remove('active-btn');
                if (typeof refs.pipBtn.setAttribute === 'function') refs.pipBtn.setAttribute('data-tooltip', 'PiP');
            }
        });
    }

    function _inicializarMenuVelocidad(refs) {
        var speedBtn  = refs.speedBtn;
        var speedMenu = refs.speedMenu;

        if (dom && !dom.esNulo(speedBtn)) {
            speedBtn.addEventListener('click', function (e) {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                if (dom && !dom.esNulo(speedMenu) && speedMenu.classList && typeof speedMenu.classList.toggle === 'function') {
                    speedMenu.classList.toggle('open');
                }
            });
        }

        document.addEventListener('click', function (e) {
            if (dom && dom.esNulo(speedMenu)) return;
            var eTarget = e ? e.target : null;
            if (dom && !dom.esNulo(speedBtn) && speedBtn.contains && !speedBtn.contains(eTarget) &&
                speedMenu && speedMenu.contains && !speedMenu.contains(eTarget)) {
                if (speedMenu.classList && typeof speedMenu.classList.remove === 'function') speedMenu.classList.remove('open');
            }
        });

        var opciones = dom && dom.$$ ? dom.$$('.speed-option') : document.querySelectorAll('.speed-option');
        if (opciones && util && typeof util.throttle === 'function') {
            for (var i = 0; i < opciones.length; i++) {
                opciones[i].addEventListener('click',
                    util.throttle(function () {
                        var valStr = this.dataset ? this.dataset.speed : this.getAttribute('data-speed');
                        var s = (util && typeof util.parsearDecimal === 'function') ? util.parsearDecimal(valStr, 1) : parseFloat(valStr) || 1;
                        if (typeof VP.reproductor.setVelocidad === 'function') VP.reproductor.setVelocidad(s);
                        if (dom && !dom.esNulo(speedMenu) && speedMenu.classList && typeof speedMenu.classList.remove === 'function') {
                            speedMenu.classList.remove('open');
                        }
                    }, 200)
                );
            }
        }
    }

    if (log && log.info) log.info('vp-reproductor-controles.js cargado.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-reproductor-controles.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
