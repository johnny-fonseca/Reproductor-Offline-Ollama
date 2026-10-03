'use strict';

(function (window, document) {

    var VP = window.VP;
    if (!VP) {
        throw new Error(
            '[VP] vp-reproductor.js: vp-base.js debe cargarse primero.'
        );
    }

    var DEPENDENCIAS_REQUERIDAS = [
        'util', 'dom', 'log', 'bus', 'config',
        'estado', 'refs', 'runtime', 'ajustes',
        'features', 'cache', 'metricas', 'db',
        'subtitulos', 'miniaturas', 'listas'
    ];

    for (var _di = 0; _di < DEPENDENCIAS_REQUERIDAS.length; _di++) {
        if (!VP[DEPENDENCIAS_REQUERIDAS[_di]]) {
            throw new Error(
                '[VP] vp-reproductor.js: dependencia faltante \u2192 ' +
                DEPENDENCIAS_REQUERIDAS[_di]
            );
        }
    }

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;
    var cfg  = VP.config;
    if (log && typeof log.setContext === 'function') log.setContext('Player');

    // ============================================================
    // CONSTANTES INTERNAS
    // ============================================================

    var CONST = Object.freeze({
        TIMEOUT_CARGA_MS:        cfg.timeoutCarga     || 15000,
        PASO_SEEK_S:             cfg.pasoSeek         || 10,
        PASO_VOLUMEN:            cfg.pasoVolumen      || 0.05,
        DEMORA_SIG_VIDEO_S:      cfg.demoraSigVideo   || 5,
        MOSTRAR_CONTROLS_MS:     cfg.mostrarControlsMs|| 2500,
        OCULTAR_IDLE_MS:         cfg.ocultarIdleMs    || 3000,

        RAF_THROTTLE_MS:         16,
        THROTTLE_TIMEUPDATE_MS:  250,
        // La escritura periódica de progreso llega a IndexedDB; limitarla a
        // una vez cada 3 s evita escrituras continuas durante la reproducción.
        // Pausa y cambio de video siguen usando guardarProgresoInmediato().
        THROTTLE_PROGRESO_MS:    cfg.guardarPosicionMs || 3000,
        AUTO_SAVE_INTERVAL_MS:   30000,
        WATCHDOG_INTERVAL_MS:    cfg.intervaloRendimiento || 10000,
        STATS_UPDATE_INTERVAL_MS:1000,

        BATCH_SIZE_THUMBS:       10,
        BATCH_DELAY_MS:          50,
        MAX_BLOBS_ACTIVOS:       30,
        BLOB_POOL_MAX:           50,
        MAX_HISTORIAL:           200,

        DOBLE_TOQUE_MS:          350,
        LONG_PRESS_MS:           400,
        VEL_BOOST:               2,
    });

    // ============================================================
    // LRU CACHE PARA BLOB URLs
    // ============================================================

    var BlobLRU = (function () {
        var _map    = new Map();
        var _limite = CONST.BLOB_POOL_MAX;

        function _revocar(url) {
            if (!url || typeof url !== 'string') return;
            try { URL.revokeObjectURL(url); } catch (_) {}
        }

        return {
            get: function (key) {
                if (!key || !_map.has(key)) return undefined;
                var url = _map.get(key);
                _map.delete(key);
                _map.set(key, url);
                return url;
            },

            set: function (key, url) {
                if (!key) return;
                if (_map.has(key)) {
                    _revocar(_map.get(key));
                    _map.delete(key);
                }
                while (_map.size >= _limite) {
                    var oldestKey = _map.keys().next().value;
                    _revocar(_map.get(oldestKey));
                    _map.delete(oldestKey);
                    if (log && log.debug) log.debug('BlobLRU: evictado \u2192', oldestKey);
                }
                _map.set(key, url);
            },

            delete: function (key) {
                if (!key || !_map.has(key)) return false;
                _revocar(_map.get(key));
                _map.delete(key);
                return true;
            },

            clear: function () {
                _map.forEach(function (url) { _revocar(url); });
                _map.clear();
            },

            size: function () { return _map.size; },

            setLimite: function (n) {
                _limite = Math.max(1, parseInt(n) || 1);
                while (_map.size > _limite) {
                    var k = _map.keys().next().value;
                    _revocar(_map.get(k));
                    _map.delete(k);
                }
            },
        };
    })();

    // ============================================================
    // POOL DE PROCESAMIENTO EN LOTES (BATCH QUEUE)
    // ============================================================

    var BatchQueue = (function () {
        var _colas   = {};
        var _activos = {};
        var _timeouts = {};

        function encolar(nombre, tarea, batchSize, delayMs) {
            if (!nombre || typeof tarea !== 'function') return;
            if (!_colas[nombre])   _colas[nombre]   = [];
            if (!_activos[nombre]) _activos[nombre] = false;

            _colas[nombre].push(tarea);
            _procesarSiInactivo(nombre, batchSize, delayMs);
        }

        function _procesarSiInactivo(nombre, batchSize, delayMs) {
            if (_activos[nombre]) return;
            _activos[nombre] = true;
            _procesarLote(nombre, batchSize || CONST.BATCH_SIZE_THUMBS,
                          delayMs  || CONST.BATCH_DELAY_MS);
        }

        function _cancelarTimer(nombre) {
            if (_timeouts[nombre]) {
                clearTimeout(_timeouts[nombre]);
                _timeouts[nombre] = null;
            }
        }

        function _procesarLote(nombre, batchSize, delayMs) {
            var cola = _colas[nombre];
            if (!cola || cola.length === 0) {
                _cancelarTimer(nombre);
                _activos[nombre] = false;
                return;
            }
            batchSize = Math.max(1, Math.min(200, Number(batchSize) || CONST.BATCH_SIZE_THUMBS));
            delayMs = Math.max(0, Math.min(5000, Number(delayMs) || CONST.BATCH_DELAY_MS));

            var lote = cola.splice(0, batchSize);

            var ejecutar = function () {
                if (!_colas[nombre]) {
                    _activos[nombre] = false;
                    return;
                }

                for (var i = 0; i < lote.length; i++) {
                    try { lote[i](); } catch (e) {
                        if (log && log.warn) log.warn('BatchQueue[' + nombre + ']: error en tarea:', e);
                    }
                }

                _cancelarTimer(nombre);
                if (_colas[nombre] && _colas[nombre].length > 0) {
                    _timeouts[nombre] = setTimeout(function () {
                        _procesarLote(nombre, batchSize, delayMs);
                    }, delayMs);
                } else {
                    _activos[nombre] = false;
                }
            };

            _cancelarTimer(nombre);
            if (typeof requestIdleCallback === 'function') {
                _timeouts[nombre] = requestIdleCallback(ejecutar, { timeout: 2000 });
            } else {
                _timeouts[nombre] = setTimeout(ejecutar, delayMs);
            }
        }

        function cancelar(nombre) {
            if (!nombre) return;
            if (_colas[nombre]) _colas[nombre] = [];
            _cancelarTimer(nombre);
            _activos[nombre] = false;
        }

        function cancelarTodo() {
            var claves = Object.keys(_colas);
            for (var i = 0; i < claves.length; i++) {
                cancelar(claves[i]);
            }
        }

        return { encolar: encolar, cancelar: cancelar, cancelarTodo: cancelarTodo };
    })();

    // ============================================================
    // TOKEN DE GENERACI\u00D3N (RACE CONDITION PROTECTION)
    // ============================================================

    var GeneracionToken = (function () {
        var _contador = 0;

        return {
            siguiente: function () {
                _contador++;
                VP.runtime.playGeneration = _contador;
                return _contador;
            },

            actual: function () { return _contador; },

            esValido: function (token) { return token === _contador; },
        };
    })();

    // ============================================================
    // DETECTOR DE PRESI\u00D3N DE MEMORIA
    // ============================================================

    var MemoryMonitor = (function () {
        var _callback    = null;
        var _intervalo   = null;
        var _umbralMB    = 500;
        var _ultimaAccion = 0;
        var _cooldownMs  = 30000;

        function _verificar() {
            try {
                var mem = performance && performance.memory;
                if (!mem) return;

                var usadoMB = mem.usedJSHeapSize / 1048576;
                if (isNaN(usadoMB)) return;

                VP.metricas.picoMemoriaMB = Math.max(
                    VP.metricas.picoMemoriaMB || 0, usadoMB
                );

                if (usadoMB > _umbralMB) {
                    var ahora = Date.now();
                    if (ahora - _ultimaAccion > _cooldownMs) {
                        _ultimaAccion = ahora;
                        if (log && log.warn) log.warn(
                            'MemoryMonitor: presi\u00f3n alta \u2192',
                            Math.round(usadoMB) + 'MB'
                        );
                        if (typeof _callback === 'function') _callback(usadoMB);
                    }
                }
            } catch (_) {}
        }

        return {
            iniciar: function (cb, umbralMB) {
                _callback  = cb;
                _umbralMB  = (typeof umbralMB === 'number' && umbralMB > 0) ? umbralMB : _umbralMB;
                if (_intervalo) clearInterval(_intervalo);
                _intervalo = setInterval(_verificar, 15000);

                if (navigator.deviceMemory && navigator.deviceMemory <= 2) {
                    _umbralMB = 200;
                    if (log && log.debug) log.debug('MemoryMonitor: umbral reducido a 200MB (deviceMemory \u2264 2GB)');
                }

                if (log && log.debug) log.debug('MemoryMonitor iniciado, umbral:', _umbralMB + 'MB');
            },

            detener: function () {
                if (_intervalo) clearInterval(_intervalo);
                _intervalo = null;
            },
        };
    })();

    // ============================================================
    // NAMESPACE PRINCIPAL
    // ============================================================

    VP.reproductor = VP.reproductor || {};

    var _estado = {
        listenersBound:    false,
        statsTimer:        null,
        ultimoTimeUpdate:  0,
        limpiezaPendiente: false,
        thumbsBatchActivo: false,
        mediaSessionOK:    false,
    };

    // ============================================================
    // HELPERS INTERNOS
    // ============================================================

    function _safe(fn, contexto) {
        if (typeof fn !== 'function') return undefined;
        try {
            return fn();
        } catch (e) {
            if (log && log.warn) log.warn('[safe:' + (contexto || '?') + ']', e.message || e);
            return undefined;
        }
    }

    function _runIdle(fn, timeout) {
        if (typeof fn !== 'function') return;
        if (typeof requestIdleCallback === 'function') {
            return requestIdleCallback(fn, { timeout: typeof timeout === 'number' ? timeout : 2000 });
        }
        return setTimeout(fn, 0);
    }

    function _esFullscreen() {
        return !!(
            document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement
        );
    }

    function _video() {
        var v = VP.refs.videoPlayer;
        return (dom && dom.esNulo(v)) ? null : v;
    }

    function _videoActivo() {
        var v = _video();
        return !!(v && v.src && v.src.trim() !== '');
    }

    function _videoActual() {
        var ci = VP.estado.currentVideoIndex;
        var pl = VP.estado.playlist;
        return (ci >= 0 && Array.isArray(pl) && pl[ci]) ? pl[ci] : null;
    }

    function _notif(msg, tipo) {
        if (!msg) return;
        _safe(function () {
            if (VP.ui && typeof VP.ui.mostrarNotificacion === 'function') {
                VP.ui.mostrarNotificacion(msg, tipo || 'info');
            }
        }, 'notif');
    }

    function _css(el, metodo, clase) {
        if (dom && !dom.esNulo(el) && el.classList && typeof el.classList[metodo] === 'function') {
            _safe(function () { el.classList[metodo](clase); }, 'css');
        }
    }

    function _style(el, prop, valor) {
        if (dom && !dom.esNulo(el) && el.style) {
            _safe(function () { el.style[prop] = valor; }, 'style');
        }
    }

    function _pct(valor) {
        if (isNaN(valor)) valor = 0;
        return util.clampNum(valor, 0, 100).toFixed(3) + '%';
    }

    function _safeStr(v) {
        return (v && typeof v === 'string') ? v : '';
    }

    function _safeNum(v) {
        return (typeof v === 'number' && !isNaN(v) && isFinite(v) && v >= 0) ? v : 0;
    }

    // ============================================================
    // EXPONER INTERNOS COMPARTIDOS
    // ============================================================

    VP.reproductor._internal = {
        CONST:           CONST,
        _estado:         _estado,
        BlobLRU:         BlobLRU,
        BatchQueue:      BatchQueue,
        GeneracionToken: GeneracionToken,
        MemoryMonitor:   MemoryMonitor,
        _safe:           _safe,
        _runIdle:        _runIdle,
        _esFullscreen:   _esFullscreen,
        _video:          _video,
        _videoActivo:    _videoActivo,
        _videoActual:    _videoActual,
        _notif:          _notif,
        _css:            _css,
        _style:          _style,
        _pct:            _pct,
        _safeStr:        _safeStr,
        _safeNum:        _safeNum,
        _descargarURL:   _descargarURL,
    };

    // ============================================================
    // TOGGLE ALEATORIO
    // ============================================================

    VP.reproductor.toggleAleatorio = function () {
        if (!VP.ajustes) return;
        VP.ajustes.aleatorio = !VP.ajustes.aleatorio;
        var sb = VP.refs.shuffleBtn;
        if (dom && !dom.esNulo(sb)) {
            _style(sb, 'color', VP.ajustes.aleatorio ? 'var(--yt-red)' : '');
        }
        _safe(function () { if (typeof VP.ajustes.guardar === 'function') VP.ajustes.guardar(); }, 'shuffle:save');
        _notif(VP.ajustes.aleatorio ? 'Aleatorio ON' : 'Aleatorio OFF', 'info');
        if (VP.mochiMascota && typeof VP.mochiMascota.reaccionControlReproduccion === 'function') VP.mochiMascota.reaccionControlReproduccion('aleatorio');
    };

    // ============================================================
    // T\u00cdTULO DEL DOCUMENTO
    // ============================================================

    VP.reproductor._actualizarTituloDoc = function (prefijo) {
        _safe(function () {
            var vo = _videoActual();
            if (vo) {
                var nombre = (vo.name && typeof vo.name === 'string') ? vo.name : 'Video';
                if (nombre.length > 60) nombre = nombre.slice(0, 57) + '\u2026';
                document.title = (prefijo && typeof prefijo === 'string')
                    ? prefijo + ' ' + nombre + ' \u2014 Video Player'
                    : nombre + ' \u2014 Video Player';
            } else {
                document.title = 'Video Player';
            }
        }, '_actualizarTituloDoc');
    };

    // ============================================================
    // MOSTRAR CONTROLES BREVEMENTE
    // ============================================================

    VP.reproductor.mostrarControlesBrevemente = function () {
        _safe(function () {
            var wrap = VP.refs ? VP.refs.videoPlayerWrap : null;
            if (dom && dom.esNulo(wrap)) return;

            _css(wrap, 'add', 'show-controls');
            if (VP.runtime && VP.runtime.controlsHideTimer) clearTimeout(VP.runtime.controlsHideTimer);

            if (VP.runtime) {
                VP.runtime.controlsHideTimer = setTimeout(function () {
                    _css(wrap, 'remove', 'show-controls');
                }, CONST.MOSTRAR_CONTROLS_MS);
            }
        }, 'mostrarControlesBrevemente');
    };

    // ============================================================
    // CAPTURA DE FOTOGRAMA
    // ============================================================

    VP.reproductor.capturarFotograma = function (poseLista) {
        var v = _video();

        if (!v || !v.src) {
            _notif('No hay video activo', 'advertencia');
            return;
        }
        if (!v.videoWidth || v.videoWidth <= 0 || isNaN(v.videoWidth)) {
            _notif('Video no listo para captura', 'advertencia');
            return;
        }

        if (!poseLista) {
            if (VP.mochiMascota && typeof VP.mochiMascota.posarFotograma === 'function') VP.mochiMascota.posarFotograma();
            setTimeout(function () { VP.reproductor.capturarFotograma(true); }, 1000);
            return;
        }

        _safe(function () {
            var cv    = document.createElement('canvas');
            cv.width  = v.videoWidth;
            cv.height = v.videoHeight;

            var ctx = cv.getContext('2d');
            if (!ctx) {
                _notif('Canvas 2D no disponible', 'error');
                return;
            }

            ctx.drawImage(v, 0, 0, cv.width, cv.height);
            if (VP.mochiMascota && typeof VP.mochiMascota.celebrarCaptura === 'function') VP.mochiMascota.celebrarCaptura();

            var base = 'captura';
            var vo   = _videoActual();
            if (vo && vo.name && typeof vo.name === 'string' && util && typeof util.obtenerNombreBase === 'function') {
                base = util.obtenerNombreBase(vo.name) || base;
            }

            var ts = _safe(function () {
                if (util && typeof util.formatearTiempo === 'function') {
                    return util.formatearTiempo(v.currentTime).replace(/:/g, '-');
                }
                return Math.round(v.currentTime) + 's';
            }, 'capturarFotograma:ts') || '0-00';

            var nombreArchivo = base + '_' + ts + '.png';

            if (typeof cv.toBlob === 'function') {
                cv.toBlob(function (blob) {
                    if (!blob) return;
                    var url = null;
                    try {
                        url = URL.createObjectURL(blob);
                        _descargarURL(url, nombreArchivo);
                        setTimeout(function () {
                            if (url) URL.revokeObjectURL(url);
                        }, 5000);
                    } catch (e) {
                        if (log && log.error) log.error('capturarFotograma toBlob error:', e);
                    }
                }, 'image/png');
            } else if (typeof cv.toDataURL === 'function') {
                _descargarURL(cv.toDataURL('image/png'), nombreArchivo);
            }

            _notif('\ud83d\udcf7 Fotograma capturado', 'exito');

        }, 'capturarFotograma');
    };

    function _descargarURL(url, nombre) {
        if (!url || !nombre) return;
        var a      = document.createElement('a');
        a.href     = url;
        a.download = nombre;
        if (document.body) document.body.appendChild(a);
        if (typeof a.click === 'function') a.click();
        setTimeout(function () {
            if (util && typeof util.eliminarElemento === 'function') util.eliminarElemento(a);
            else if (a.parentNode) a.parentNode.removeChild(a);
        }, 100);
    }

    // ============================================================
    // INICIALIZAR TODO EL REPRODUCTOR
    // ============================================================

    VP.reproductor.inicializar = function () {
        if (log && log.info) log.info('VP.reproductor.inicializar: comenzando...');

        if (typeof VP.reproductor.inicializarEventosVideo === 'function') VP.reproductor.inicializarEventosVideo();
        if (typeof VP.reproductor.inicializarBotones === 'function') VP.reproductor.inicializarBotones();
        if (typeof VP.reproductor.inicializarBarraProgreso === 'function') VP.reproductor.inicializarBarraProgreso();
        if (typeof VP.reproductor.inicializarIdleControls === 'function') VP.reproductor.inicializarIdleControls();
        if (typeof VP.reproductor.inicializarGestos === 'function') VP.reproductor.inicializarGestos();
        if (typeof VP.reproductor.inicializarLongPress === 'function') VP.reproductor.inicializarLongPress();
        if (typeof VP.reproductor.inicializarAutoSave === 'function') VP.reproductor.inicializarAutoSave();
        if (typeof VP.reproductor.inicializarMonitorMemoria === 'function') VP.reproductor.inicializarMonitorMemoria();

        _safe(function () {
            var v = _video();
            if (v) {
                var volGlobal = (VP.ajustes && typeof VP.ajustes.volumenGlobal === 'number' && !isNaN(VP.ajustes.volumenGlobal)) ? VP.ajustes.volumenGlobal : 1;
                v.volume = (util && typeof util.clampNum === 'function') ? util.clampNum(volGlobal, 0, 1) : Math.max(0, Math.min(1, volGlobal));
                v.muted  = VP.ajustes ? !!VP.ajustes.silenciadoGlobal : false;
            }
            if (typeof VP.reproductor.actualizarUIVolumen === 'function') VP.reproductor.actualizarUIVolumen();
        }, 'inicializar:volumen');

        _safe(function () {
            var vel = (VP.ajustes && typeof VP.ajustes.velocidadGlobal === 'number' && !isNaN(VP.ajustes.velocidadGlobal)) ? VP.ajustes.velocidadGlobal : 1;
            if (VP.estado) VP.estado.velocidadActual = vel;
            if (typeof VP.reproductor.actualizarUIVelocidad === 'function') VP.reproductor.actualizarUIVelocidad(vel);
        }, 'inicializar:velocidad');

        if (typeof VP.reproductor.actualizarIconoFullscreen === 'function') VP.reproductor.actualizarIconoFullscreen();

        if (log && log.info) log.info('VP.reproductor inicializado correctamente.');
    };

    // ============================================================
    // LISTENERS DEL BUS DE EVENTOS
    // ============================================================

    if (bus && typeof bus.on === 'function') {
        bus.on('reproducirVideo', function (indice, opciones) {
            if (typeof VP.reproductor.reproducir === 'function') VP.reproductor.reproducir(indice, opciones);
        });

        bus.on('detenerVideo', function () {
            if (typeof VP.reproductor.detener === 'function') VP.reproductor.detener();
        });

        bus.on('siguienteVideo', function () {
            if (typeof VP.reproductor.siguiente === 'function') VP.reproductor.siguiente();
        });

        bus.on('anteriorVideo', function () {
            if (typeof VP.reproductor.anterior === 'function') VP.reproductor.anterior();
        });

        bus.on('videoCambiado', function (v) {
            _safe(function () {
                if (typeof VP.reproductor.actualizarMediaSession === 'function') VP.reproductor.actualizarMediaSession();
                if (v && typeof VP.agregarAlHistorial === 'function') VP.agregarAlHistorial(v);
                if (typeof VP.reproductor.precargarSiguiente === 'function') VP.reproductor.precargarSiguiente();
            }, 'bus:videoCambiado');
        });

        bus.on('videoReproduciendo', function () {
            _safe(function () {
                if (typeof VP.reproductor.mostrarControlesBrevemente === 'function') VP.reproductor.mostrarControlesBrevemente();
            }, 'bus:videoReproduciendo');
        });

        bus.on('reset', function () {
            if (typeof VP.reproductor.detenerWatchdog === 'function') VP.reproductor.detenerWatchdog();
            if (BatchQueue && typeof BatchQueue.cancelarTodo === 'function') BatchQueue.cancelarTodo();
            if (BlobLRU && typeof BlobLRU.clear === 'function') BlobLRU.clear();
        });

        bus.on('initialized', function () {
            if (typeof VP.reproductor.iniciarWatchdog === 'function') VP.reproductor.iniciarWatchdog();
            _safe(function () {
                if (typeof VP.reproductor.actualizarMediaSession === 'function') VP.reproductor.actualizarMediaSession();
            }, 'bus:initialized');
        });
    }

    // Responder a cambios de visibilidad de pesta\u00f1a
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            if (typeof VP.reproductor.guardarProgresoInmediato === 'function') VP.reproductor.guardarProgresoInmediato();
        } else {
            _safe(function () {
                if (typeof VP.reproductor.refrescarDisplayTiempo === 'function') VP.reproductor.refrescarDisplayTiempo();
                if (typeof VP.reproductor.actualizarUIVolumen === 'function') VP.reproductor.actualizarUIVolumen();
                if (typeof VP.reproductor.actualizarMediaSession === 'function') VP.reproductor.actualizarMediaSession();
            }, 'visibilitychange:visible');
        }
    });

    window.addEventListener('beforeunload', function () {
        if (typeof VP.reproductor.guardarProgresoInmediato === 'function') VP.reproductor.guardarProgresoInmediato();
        _safe(function () { if (BlobLRU && typeof BlobLRU.clear === 'function') BlobLRU.clear(); }, 'beforeunload:blobs');
    });

    // ============================================================
    // LOG DE CARGA
    // ============================================================

    if (log && log.info) log.info(
        'vp-reproductor.js cargado | ' +
        'BlobLRU max:' + (CONST.BLOB_POOL_MAX || 50) + ' | ' +
        'AutoSave:' + ((CONST.AUTO_SAVE_INTERVAL_MS || 30000) / 1000) + 's | ' +
        'Watchdog:' + ((CONST.WATCHDOG_INTERVAL_MS || 10000) / 1000) + 's'
    );

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-reproductor.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
