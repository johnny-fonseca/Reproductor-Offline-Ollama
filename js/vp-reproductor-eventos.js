'use strict';

(function (window, document) {

    var VP = window.VP;
    if (!VP) {
        throw new Error(
            '[VP] vp-reproductor-eventos.js: vp-base.js debe cargarse primero.'
        );
    }

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;

    var _int    = VP.reproductor._internal;
    var CONST   = _int.CONST;
    var _safe   = _int._safe;
    var _video  = _int._video;
    var _videoActivo = _int._videoActivo;
    var _videoActual = _int._videoActual;
    var _notif  = _int._notif;
    var _css    = _int._css;
    var _style  = _int._style;
    var _pct    = _int._pct;
    var _esFullscreen = _int._esFullscreen;
    var _progresoPlaylistCache = { lista: null, item: null, barra: null };
    var _timeupdateStyleCache = {
        progressWidth: null,
        scrubberLeft: null,
        bufferedWidth: null,
    };

    function _actualizarProgresoPlaylist(pct) {
        var lista = VP.refs && VP.refs.playlistEl;
        if (!lista) {
            _progresoPlaylistCache = { lista: null, item: null, barra: null };
            return;
        }

        var cache = _progresoPlaylistCache;
        if (cache.lista !== lista || !cache.item || !lista.contains(cache.item) ||
                !cache.item.classList.contains('active') || !cache.barra ||
                !lista.contains(cache.barra)) {
            var item = lista.querySelector('.playlist-item.active');
            _progresoPlaylistCache = {
                lista: lista,
                item: item,
                barra: item ? item.querySelector('.playlist-progress-bar') : null,
            };
            cache = _progresoPlaylistCache;
        }

        if (!cache.barra) return;
        var width = _pct(pct);
        if (cache.barra.style.width !== width) cache.barra.style.width = width;

        var contenedor = cache.barra.parentNode;
        if (contenedor) {
            var valor = pct.toFixed(1);
            if (contenedor.getAttribute('aria-valuenow') !== valor) {
                contenedor.setAttribute('aria-valuenow', valor);
            }
        }
    }

    function _registrarEventoMedia(video, evento) {
        if (typeof VP_DEBUG === 'undefined' || !VP_DEBUG.VP || VP_DEBUG.VP.Media !== true || !log || !log.debug) return;
        var detalle = {
            tiempo: isFinite(video.currentTime) ? Math.round(video.currentTime * 10) / 10 : null,
            duracion: isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : null,
            pausado: !!video.paused,
            readyState: video.readyState,
            networkState: video.networkState,
            playbackRate: video.playbackRate,
            errorCode: video.error ? video.error.code : null
        };
        var escribir = function () { log.debug('Evento media:', evento, detalle); };
        if (typeof log.withContext === 'function') log.withContext('Media', escribir);
        else escribir();
    }

    // ============================================================
    // INICIALIZAR EVENTOS DEL ELEMENTO <VIDEO>
    // ============================================================

    VP.reproductor.inicializarEventosVideo = function () {
        var video = _video();
        if (!video) {
            if (log && log.error) log.error('inicializarEventosVideo: elemento <video> no encontrado.');
            return;
        }

        var refs = VP.refs || {};

        var _onTimeUpdateFn = function () {
            _safe(function () {
                var d = video.duration;
                var c = video.currentTime;

                if (!isFinite(d) || d <= 0 || isNaN(c)) return;

                var pct = c / d * 100;
                if (isNaN(pct)) pct = 0;

                var pctStr = _pct(pct);
                if (refs.progressContainer && typeof refs.progressContainer.setAttribute === 'function') {
                    var ariaPct = String(Math.max(0, Math.min(100, Math.round(pct))));
                    if (refs.progressContainer.getAttribute('aria-valuenow') !== ariaPct) {
                        refs.progressContainer.setAttribute('aria-valuenow', ariaPct);
                    }
                }
                var bufferedPct = 0;
                var bufferedStr = _pct(0);
                var bufferedEndTime = 0;

                if (refs.progressBar && refs.progressBar.style && refs.progressBar.style.width !== pctStr) {
                    refs.progressBar.style.width = pctStr;
                }
                if (refs.progressScrubber && refs.progressScrubber.style && refs.progressScrubber.style.left !== pctStr) {
                    refs.progressScrubber.style.left = pctStr;
                }

                if (typeof VP.reproductor.refrescarDisplayTiempo === 'function') VP.reproductor.refrescarDisplayTiempo();

                _safe(function () {
                    var rangosBuffer = video.buffered;
                    if (rangosBuffer && rangosBuffer.length > 0) {
                        var bufEnd = rangosBuffer.end(rangosBuffer.length - 1);
                        if (isFinite(bufEnd)) bufferedEndTime = bufEnd;
                        if (isFinite(bufEnd) && d > 0) {
                            bufferedPct = bufEnd / d * 100;
                            bufferedStr = _pct(bufferedPct);
                        }
                    }
                }, 'timeupdate:buffer');

                if (refs.progressBuffered && refs.progressBuffered.style &&
                    (!dom || !dom.esNulo(refs.progressBuffered)) &&
                    refs.progressBuffered.style.width !== bufferedStr) {
                    refs.progressBuffered.style.width = bufferedStr;
                    _timeupdateStyleCache.bufferedWidth = bufferedStr;
                }

                if (typeof VP.reproductor._actualizarFillsSegmentos === 'function') VP.reproductor._actualizarFillsSegmentos(bufferedEndTime);

                if (typeof VP.reproductor.verificarABRepeat === 'function') VP.reproductor.verificarABRepeat();

                if (typeof VP.reproductor.actualizarPosicionMediaSession === 'function') VP.reproductor.actualizarPosicionMediaSession();

                _safe(function () {
                    _actualizarProgresoPlaylist(pct);
                }, 'timeupdate:active-playlist-bar');

            }, 'timeupdate');
        };

        var ultimoTimeUpdate = 0;
        var timeUpdateTimer = null;
        var intervaloTimeUpdate = CONST.THROTTLE_TIMEUPDATE_MS || 250;
        var _onTimeUpdate = function () {
            var ahora = util && typeof util.ahora === 'function' ? util.ahora() : Date.now();
            var restante = intervaloTimeUpdate - (ahora - ultimoTimeUpdate);
            if (restante <= 0) {
                ultimoTimeUpdate = ahora;
                _onTimeUpdateFn();
            } else if (timeUpdateTimer === null) {
                timeUpdateTimer = setTimeout(function () {
                    timeUpdateTimer = null;
                    ultimoTimeUpdate = util && typeof util.ahora === 'function' ? util.ahora() : Date.now();
                    _onTimeUpdateFn();
                }, restante);
            }
        };

        video.addEventListener('timeupdate', _onTimeUpdate);

        video.addEventListener('play', function () {
            _registrarEventoMedia(video, 'play');
            if (typeof VP.reproductor.establecerEstadoPlay === 'function') VP.reproductor.establecerEstadoPlay(true);
            if (typeof VP.reproductor._actualizarTituloDoc === 'function') VP.reproductor._actualizarTituloDoc('\u25b6');
        });

        video.addEventListener('pause', function () {
            _registrarEventoMedia(video, 'pause');
            if (typeof VP.reproductor.establecerEstadoPlay === 'function') VP.reproductor.establecerEstadoPlay(false);
            if (typeof VP.reproductor.guardarProgresoInmediato === 'function') VP.reproductor.guardarProgresoInmediato();
            if (typeof VP.reproductor._actualizarTituloDoc === 'function') VP.reproductor._actualizarTituloDoc('\u23f8');
        });

        video.addEventListener('waiting', function () {
            _registrarEventoMedia(video, 'waiting');
            if (bus && typeof bus.emit === 'function') bus.emit('videoEsperando');
            _css(refs.loadingOverlay, 'add', 'active');
        });

        video.addEventListener('playing', function () {
            _registrarEventoMedia(video, 'playing');
            if (bus && typeof bus.emit === 'function') bus.emit('videoReanudado');
            _css(refs.loadingOverlay, 'remove', 'active');
        });

        video.addEventListener('canplay', function () {
            if (bus && typeof bus.emit === 'function') bus.emit('videoReanudado');
            _css(refs.loadingOverlay, 'remove', 'active');
        });

        video.addEventListener('canplaythrough', function () {
            _css(refs.loadingOverlay, 'remove', 'active');
        });

        video.addEventListener('volumechange', function () {
            if (typeof VP.reproductor.actualizarUIVolumen === 'function') VP.reproductor.actualizarUIVolumen();
        });

        video.addEventListener('ratechange', function () {
            _registrarEventoMedia(video, 'ratechange');
            _safe(function () {
                if (VP.estado) VP.estado.velocidadActual = (typeof video.playbackRate === 'number' && !isNaN(video.playbackRate)) ? video.playbackRate : 1;
            }, 'ratechange');
            if (typeof VP.reproductor.actualizarUIVelocidad === 'function') VP.reproductor.actualizarUIVelocidad(VP.estado ? VP.estado.velocidadActual : 1);
        });

        video.addEventListener('ended', function () {
            _registrarEventoMedia(video, 'ended');
            if (typeof VP.reproductor.guardarProgresoInmediato === 'function') VP.reproductor.guardarProgresoInmediato();
            if (typeof VP.reproductor.establecerEstadoPlay === 'function') VP.reproductor.establecerEstadoPlay(false);
            if (typeof VP.reproductor._actualizarTituloDoc === 'function') VP.reproductor._actualizarTituloDoc('\u23f9');

            if (VP.ajustes && VP.ajustes.repetir) {
                _safe(function () {
                    video.currentTime = 0;
                    var p = typeof video.play === 'function' ? video.play() : null;
                    if (p && typeof p.catch === 'function') {
                        p.catch(function () {});
                    }
                }, 'ended:repeat');
                return;
            }

            if (VP.ajustes && VP.ajustes.habilitarSiguiente) {
                if (typeof VP.reproductor.mostrarUpNext === 'function') VP.reproductor.mostrarUpNext();
            } else {
                if (typeof VP.reproductor.siguiente === 'function') VP.reproductor.siguiente();
            }
        });

        var CODIGOS_ERROR = {
            1: 'Carga abortada por el usuario',
            2: 'Error de red al cargar',
            3: 'Error al decodificar',
            4: 'Formato de video no soportado',
        };

        video.addEventListener('error', function () {
            _registrarEventoMedia(video, 'error');
            var codigo  = (video.error && video.error.code)    || 0;
            var mensaje = CODIGOS_ERROR[codigo] || 'Error desconocido';

            if (log && log.error) log.error('Video error — código:', codigo, '|', mensaje,
                      '| src:', video.src ? '(hay src)' : '(sin src)');

            _css(refs.loadingOverlay, 'remove', 'active');
            _notif('Error: ' + mensaje, 'error');

            if (VP.metricas) VP.metricas.errores = (typeof VP.metricas.errores === 'number' && !isNaN(VP.metricas.errores) ? VP.metricas.errores : 0) + 1;

            if (VP.estado && Array.isArray(VP.estado.playlist) && VP.estado.playlist.length > 1) {
                setTimeout(function () {
                    _notif('Saltando al siguiente video...', 'advertencia');
                    if (typeof VP.reproductor.siguiente === 'function') VP.reproductor.siguiente();
                }, 2000);
            }
        });

        video.addEventListener('seeked', function () {
            _registrarEventoMedia(video, 'seeked');
            _css(refs.loadingOverlay, 'remove', 'active');
            if (typeof VP.reproductor.refrescarDisplayTiempo === 'function') VP.reproductor.refrescarDisplayTiempo();
        });

        video.addEventListener('seeking', function () {
            _registrarEventoMedia(video, 'seeking');
            _css(refs.loadingOverlay, 'add', 'active');
        });

        video.addEventListener('durationchange', function () {
            if (typeof VP.reproductor.refrescarDisplayTiempo === 'function') VP.reproductor.refrescarDisplayTiempo();
            if (typeof VP.reproductor.actualizarMarcadoresCapitulos === 'function') VP.reproductor.actualizarMarcadoresCapitulos();
            _safe(function () {
                if (typeof VP.reproductor.actualizarPosicionMediaSession === 'function') VP.reproductor.actualizarPosicionMediaSession();
            }, 'durationchange:ms');

            var vo = _videoActual();
            if (vo && isFinite(video.duration) && video.duration > 0 && !isNaN(video.duration)) {
                vo.duration = video.duration;
            }
        });

        video.addEventListener('loadedmetadata', function () {
            _registrarEventoMedia(video, 'loadedmetadata');
            var vo = _videoActual();
            if (vo && (!vo.duration || !isFinite(vo.duration) || isNaN(vo.duration))) {
                _safe(function () { vo.duration = (typeof video.duration === 'number' && !isNaN(video.duration)) ? video.duration : 0; },
                      'loadedmetadata:dur');
            }
        });

        if (log && log.debug) log.debug('Eventos del elemento <video> inicializados.');
    };

    // ============================================================
    // OCULTACI\u00D3N DE CONTROLES IDLE
    // ============================================================

    VP.reproductor.inicializarIdleControls = function () {
        var wrap = VP.refs ? VP.refs.videoPlayerWrap : null;
        if (dom && dom.esNulo(wrap)) return;

        _inicializarGaleriaFullscreen(wrap);

        var _timerIdle = null;

        function _mostrar() {
            if (_timerIdle) clearTimeout(_timerIdle);
            _css(wrap, 'add', 'user-active');
            _timerIdle = setTimeout(function () {
                var speedMenu = VP.refs ? VP.refs.speedMenu : null;
                var statsPanel = VP.refs ? VP.refs.statsPanel : null;
                var moreShelf = document.getElementById('fullscreenVideoShelf');
                var volumenArrastrado = wrap.querySelector && wrap.querySelector('.volume-control.is-dragging');
                var speedOpen = dom && !dom.esNulo(speedMenu) && speedMenu.classList && speedMenu.classList.contains('open');
                var statsOpen = dom && !dom.esNulo(statsPanel) && statsPanel.classList && statsPanel.classList.contains('visible');
                var moreOpen = moreShelf && moreShelf.classList.contains('open');

                if (volumenArrastrado) {
                    _mostrar();
                } else if (!speedOpen && !statsOpen && !moreOpen) {
                    _css(wrap, 'remove', 'user-active');
                }
            }, CONST.OCULTAR_IDLE_MS || 3000);
        }

        var mvm = (util && typeof util.rafThrottle === 'function') ? util.rafThrottle(_mostrar) : _mostrar;
        var eventoMovimiento = window.PointerEvent ? 'pointermove' : 'mousemove';
        var eventoEntrada = window.PointerEvent ? 'pointerenter' : 'mouseenter';
        wrap.addEventListener(eventoMovimiento, mvm);
        wrap.addEventListener(eventoEntrada, _mostrar);
        wrap.addEventListener('touchstart', _mostrar, { passive: true });

        wrap.addEventListener('mouseleave', function () {
            if (_timerIdle) clearTimeout(_timerIdle);
            _css(wrap, 'remove', 'user-active');
        });

        wrap.addEventListener('click', function (e) {
            var progress = VP.refs ? VP.refs.progressContainer : null;
            if (progress && Date.now() < (progress._vpSuppressPlayerClickUntil || 0)) return;
            var target = e ? e.target : null;
            var videoPlayer = VP.refs ? VP.refs.videoPlayer : null;
            if (target === wrap || target === videoPlayer) {
                if (typeof VP.reproductor.togglePlayPause === 'function') VP.reproductor.togglePlayPause();
            }
        });

        wrap.addEventListener('dblclick', function (e) {
            var target = e ? e.target : null;
            var videoPlayer = VP.refs ? VP.refs.videoPlayer : null;
            if (target === wrap || target === videoPlayer) {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                if (typeof VP.reproductor.toggleFullscreen === 'function') VP.reproductor.toggleFullscreen();
            }
        });

        wrap.addEventListener('wheel', function (e) {
            if (!_esFullscreen()) return;
            if (typeof e.preventDefault === 'function') e.preventDefault();
            _safe(function () {
                var v = _video();
                if (!v || typeof VP.reproductor.setVolumen !== 'function') return;
                var valVol = typeof v.volume === 'number' && !isNaN(v.volume) ? v.volume : 1;
                var pasoVol = typeof CONST.PASO_VOLUMEN === 'number' && !isNaN(CONST.PASO_VOLUMEN) ? CONST.PASO_VOLUMEN : 0.05;
                VP.reproductor.setVolumen(e.deltaY > 0 ? valVol - pasoVol : valVol + pasoVol);
            }, 'wheel:volumen');
        }, { passive: false });

        if (log && log.debug) log.debug('Controles idle inicializados.');
    }

    function _inicializarGaleriaFullscreen(wrap) {
        if (!wrap || wrap._vpFullscreenShelfBound) return;

        var video = _video();
        var boton = document.getElementById('fullscreenMoreBtn');
        var shelf = document.getElementById('fullscreenVideoShelf');
        var cerrar = document.getElementById('fullscreenShelfClose');
        var track = document.getElementById('fullscreenVideoTrack');
        if (!video || !boton || !shelf || !cerrar || !track) return;

        wrap._vpFullscreenShelfBound = true;
        var videosSugeridos = [];
        var siguienteVideo = 0;
        var TAM_LOTE = 12;

        function _obtenerVideosSugeridos() {
            var videos = Array.isArray(VP.estado && VP.estado.videos)
                ? VP.estado.videos : [];
            var actual = _videoActual();
            var idActual = actual && actual.id != null ? String(actual.id) : null;
            var indiceActual = -1;
            var validos = [];

            for (var i = 0; i < videos.length; i++) {
                var v = videos[i];
                if (!v || v.id == null || typeof v.name !== 'string' || !v.name.trim()) continue;
                if (idActual !== null && String(v.id) === idActual) indiceActual = validos.length;
                validos.push(v);
            }
            if (indiceActual < 0) return validos;

            var ordenados = [];
            for (var j = 1; j < validos.length; j++) {
                ordenados.push(validos[(indiceActual + j) % validos.length]);
            }
            return ordenados;
        }

        function _hayVideosSugeridos() {
            var videos = Array.isArray(VP.estado && VP.estado.videos)
                ? VP.estado.videos : [];
            var actual = _videoActual();
            var idActual = actual && actual.id != null ? String(actual.id) : null;
            for (var i = 0; i < videos.length; i++) {
                var v = videos[i];
                if (!v || v.id == null || typeof v.name !== 'string' || !v.name.trim()) continue;
                if (idActual === null || String(v.id) !== idActual) return true;
            }
            return false;
        }

        function _cerrarShelf(devolverFoco) {
            shelf.classList.remove('open');
            shelf.setAttribute('aria-hidden', 'true');
            if ('inert' in shelf) shelf.inert = true;
            boton.setAttribute('aria-expanded', 'false');
            boton.classList.remove('expanded');
            if (devolverFoco && boton.focus) boton.focus();
        }

        function _reproducirSeleccionado(id) {
            var seleccionado = null;
            for (var i = 0; i < videosSugeridos.length; i++) {
                if (String(videosSugeridos[i].id) === id) {
                    seleccionado = videosSugeridos[i];
                    break;
                }
            }
            if (!seleccionado) return;
            _cerrarShelf(false);

            var playlist = VP.estado && Array.isArray(VP.estado.playlist)
                ? VP.estado.playlist : [];
            var indice = -1;
            for (var p = 0; p < playlist.length; p++) {
                if (playlist[p] && String(playlist[p].id) === id) {
                    indice = p;
                    break;
                }
            }
            if (indice < 0 && VP.listas &&
                typeof VP.listas.agregarAPlaylist === 'function') {
                VP.listas.agregarAPlaylist(seleccionado);
                playlist = VP.estado && Array.isArray(VP.estado.playlist)
                    ? VP.estado.playlist : [];
                indice = playlist.length - 1;
            }
            if (indice >= 0 && VP.bus && typeof VP.bus.emit === 'function') {
                VP.bus.emit('reproducirVideo', indice);
            }
        }

        function _agregarLote() {
            var fin = Math.min(siguienteVideo + TAM_LOTE, videosSugeridos.length);
            if (siguienteVideo >= fin) return;
            var fragment = document.createDocumentFragment();

            for (var i = siguienteVideo; i < fin; i++) {
                var v = videosSugeridos[i];
                var tarjeta = document.createElement('button');
                tarjeta.type = 'button';
                tarjeta.className = 'fullscreen-video-card';
                tarjeta.setAttribute('aria-label', 'Reproducir: ' + v.name);
                tarjeta.dataset.vidId = String(v.id);

                var miniatura = document.createElement('span');
                miniatura.className = 'fullscreen-video-thumb';
                miniatura.setAttribute('aria-hidden', 'true');
                if (v.thumbnail) {
                    var imagen = document.createElement('img');
                    imagen.alt = '';
                    imagen.loading = 'lazy';
                    imagen.decoding = 'async';
                    imagen.src = v.thumbnail;
                    imagen.addEventListener('error', function () {
                        this.style.display = 'none';
                    });
                    miniatura.appendChild(imagen);
                }
                if (v.duration && VP.util && typeof VP.util.formatearTiempo === 'function') {
                    var duracion = document.createElement('span');
                    duracion.className = 'fullscreen-video-duration';
                    duracion.textContent = VP.util.formatearTiempo(v.duration);
                    miniatura.appendChild(duracion);
                }
                var titulo = document.createElement('span');
                titulo.className = 'fullscreen-video-title';
                titulo.textContent = v.name;
                tarjeta.appendChild(miniatura);
                tarjeta.appendChild(titulo);
                tarjeta.addEventListener('click', function () {
                    _reproducirSeleccionado(this.dataset.vidId);
                });
                fragment.appendChild(tarjeta);
            }
            track.appendChild(fragment);
            siguienteVideo = fin;
        }

        function _reiniciarTarjetas() {
            videosSugeridos = _obtenerVideosSugeridos();
            siguienteVideo = 0;
            track.textContent = '';
            _agregarLote();
        }

        function _actualizarVisibilidad() {
            var visible = _esFullscreen() && _videoActivo() &&
                          _hayVideosSugeridos();
            wrap.classList.toggle('fullscreen-playing-with-more', visible);
            wrap.classList.toggle('fullscreen-video-paused', !!video.paused);
            if (!visible) {
                _cerrarShelf(false);
            }
        }

        function _refrescarShelf() {
            if (shelf.classList.contains('open')) _reiniciarTarjetas();
            _actualizarVisibilidad();
        }

        function _alternarShelf() {
            if (shelf.classList.contains('open')) {
                _cerrarShelf(false);
                return;
            }
            _reiniciarTarjetas();
            shelf.classList.add('open');
            shelf.setAttribute('aria-hidden', 'false');
            if ('inert' in shelf) shelf.inert = false;
            boton.setAttribute('aria-expanded', 'true');
            boton.classList.add('expanded');
            wrap.classList.add('user-active');
        }

        boton.addEventListener('click', _alternarShelf);
        cerrar.addEventListener('click', function () { _cerrarShelf(true); });
        track.addEventListener('scroll', function () {
            if (track.scrollLeft + track.clientWidth >= track.scrollWidth - 320) {
                _agregarLote();
            }
        }, { passive: true });
        track.addEventListener('wheel', function (e) {
            e.preventDefault();
            e.stopPropagation();
            track.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY)
                ? e.deltaX : e.deltaY;
        }, { passive: false });

        video.addEventListener('play', _actualizarVisibilidad);
        video.addEventListener('pause', _actualizarVisibilidad);
        video.addEventListener('ended', _actualizarVisibilidad);
        video.addEventListener('loadedmetadata', _refrescarShelf);
        ['fullscreenchange', 'webkitfullscreenchange',
         'mozfullscreenchange', 'MSFullscreenChange'].forEach(function (evento) {
            document.addEventListener(evento, _actualizarVisibilidad);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape' || !shelf.classList.contains('open')) return;
            e.preventDefault();
            e.stopPropagation();
            _cerrarShelf(true);
        });
        if (VP.bus && typeof VP.bus.on === 'function') {
            VP.bus.on('galeriaRenderizada', _refrescarShelf);
        }
        _actualizarVisibilidad();
    }

    if (log && log.info) log.info('vp-reproductor-eventos.js cargado.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-reproductor-eventos.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
