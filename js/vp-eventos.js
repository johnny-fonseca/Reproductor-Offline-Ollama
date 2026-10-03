'use strict';

// ============================================================
// VP-EVENTOS.JS — v2.0
// Listeners de teclado, notificaciones, accesibilidad,
// atajos de teclado, red y visibilidad de pestaña.
// Optimizado para bibliotecas de 500+ videos con:
//   - Throttling / debouncing agresivo
//   - Cola de notificaciones con prioridades
//   - Delegation de eventos (un solo listener por contenedor)
//   - Gestión de memoria y limpieza de listeners
//   - Manejo robusto de errores con circuit-breaker
//   - Pool de timers centralizado
//   - Batch de operaciones DOM
// ============================================================

(function (window, document, undefined) {

    // ============================================================
    // GUARD — dependencia obligatoria
    // ============================================================

    var VP = window.VP;
    if (!VP) {
        throw new Error(
            '[VP] vp-eventos.js: vp-base.js debe cargarse primero.'
        );
    }

    // ---- Alias de módulos ----
    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;
    var cfg  = VP.config;
    log.setContext('Eventos');

    // ---- Validar módulos críticos ----
    (function validarDependencias() {
        var criticos = [
            ['util',   util],
            ['dom',    dom],
            ['log',    log],
            ['bus',    bus],
            ['config', cfg],
        ];
        for (var i = 0; i < criticos.length; i++) {
            if (!criticos[i][1]) {
                throw new Error(
                    '[VP] vp-eventos.js: VP.' + criticos[i][0] +
                    ' no está disponible.'
                );
            }
        }
    })();

    // ============================================================
    // NAMESPACES
    // ============================================================

    VP.eventos = VP.eventos || {};
    VP.ui      = VP.ui      || {};

    // ============================================================
    // POOL CENTRALIZADO DE TIMERS
    // Evita fugas de memoria y facilita limpieza global.
    // ============================================================

    var TimerPool = (function () {
        var _timers    = Object.create(null); // { id: timerHandle }
        var _intervals = Object.create(null);
        var _nextId    = 1;

        return {
            /**
             * Registra un setTimeout gestionado.
             * @param  {Function} fn
             * @param  {number}   delay
             * @param  {string}   [name]  clave semántica (opcional)
             * @return {string}   id único
             */
            timeout: function (fn, delay, name) {
                var id   = name || ('t_' + (_nextId++));
                delay = Math.max(0, Math.min(2147483647, Number(delay) || 0));
                this.clearId(id);                           // cancelar previo
                _timers[id] = setTimeout(function () {
                    delete _timers[id];
                    try { fn(); } catch (e) {
                        log.error('[TimerPool] timeout "' + id + '":', e);
                    }
                }, delay);
                return id;
            },

            /**
             * Registra un setInterval gestionado.
             */
            interval: function (fn, delay, name) {
                var id = name || ('i_' + (_nextId++));
                delay = Math.max(16, Math.min(2147483647, Number(delay) || 1000));
                this.clearIntervalId(id);
                _intervals[id] = setInterval(function () {
                    try { fn(); } catch (e) {
                        log.error('[TimerPool] interval "' + id + '":', e);
                    }
                }, delay);
                return id;
            },

            /** Cancela un timeout por id */
            clearId: function (id) {
                if (_timers[id] != null) {
                    clearTimeout(_timers[id]);
                    delete _timers[id];
                }
            },

            /** Cancela un interval por id */
            clearIntervalId: function (id) {
                if (_intervals[id] != null) {
                    clearInterval(_intervals[id]);
                    delete _intervals[id];
                }
            },

            /** Cancela absolutamente todo */
            clearAll: function () {
                var id;
                for (id in _timers)    { clearTimeout(_timers[id]);    }
                for (id in _intervals) { clearInterval(_intervals[id]); }
                _timers    = Object.create(null);
                _intervals = Object.create(null);
            },

            /** Estado de diagnóstico */
            diagnostico: function () {
                return {
                    timeouts:  Object.keys(_timers).length,
                    intervals: Object.keys(_intervals).length,
                };
            },
        };
    })();

    VP.timerPool = TimerPool; // exponer para otros módulos

    // ============================================================
    // CIRCUIT BREAKER
    // Desactiva automáticamente operaciones que fallan repetidamente.
    // ============================================================

    var CircuitBreaker = (function () {
        var _fallos    = Object.create(null);
        var _abiertos  = Object.create(null);
        var MAX_FALLOS = 5;
        var RESET_MS   = 30000;

        return {
            /**
             * Ejecuta fn protegido por circuit breaker.
             * @param  {string}   clave
             * @param  {Function} fn
             * @param  {Function} [fallback]
             */
            ejecutar: function (clave, fn, fallback) {
                if (_abiertos[clave]) {
                    if (fallback) {
                        try { fallback(); } catch (_) {}
                    }
                    return;
                }
                try {
                    fn();
                    // éxito: resetear contador
                    _fallos[clave] = 0;
                } catch (e) {
                    _fallos[clave] = (_fallos[clave] || 0) + 1;
                    log.warn(
                        '[CB] "' + clave + '" fallo #' + _fallos[clave], e
                    );
                    if (_fallos[clave] >= MAX_FALLOS) {
                        _abiertos[clave] = true;
                        log.error(
                            '[CB] "' + clave +
                            '" DESACTIVADO por demasiados fallos.'
                        );
                        // Auto-reset tras RESET_MS
                        setTimeout(function () {
                            delete _abiertos[clave];
                            _fallos[clave] = 0;
                            log.info('[CB] "' + clave + '" restablecido.');
                        }, RESET_MS);
                    }
                    if (fallback) {
                        try { fallback(); } catch (_) {}
                    }
                }
            },

            /** Estado de todos los circuitos */
            estado: function () {
                return {
                    fallos:   JSON.parse(JSON.stringify(_fallos)),
                    abiertos: Object.keys(_abiertos),
                };
            },
        };
    })();

    // ============================================================
    // COLA DE NOTIFICACIONES CON PRIORIDADES
    // Soporta 500+ videos sin saturar la UI.
    // Prioridades: error(3) > advertencia(2) > exito(1) > info(0)
    // ============================================================

    var ColaNotificaciones = (function () {
        var _cola        = [];
        var _procesando  = false;
        var _PRIORIDADES = { error: 3, advertencia: 3, warning: 2,
                             exito: 1, success: 1, info: 0 };
        var _DURACIONES  = { error: 5000, advertencia: 4000, warning: 4000,
                             exito: 3000, success: 3000, info: 3500 };
        var _MAX_COLA    = 8; // máximo acumulado

        function _prioridad(tipo) {
            return _PRIORIDADES[tipo] !== undefined
                ? _PRIORIDADES[tipo] : 0;
        }

        function _duracion(tipo) {
            return _DURACIONES[tipo] !== undefined
                ? _DURACIONES[tipo] : 3500;
        }

        function _ordenar() {
            _cola.sort(function (a, b) {
                // Mayor prioridad primero; misma prioridad → FIFO (ts)
                if (b.prioridad !== a.prioridad) {
                    return b.prioridad - a.prioridad;
                }
                return a.ts - b.ts;
            });
        }

        function _mostrarSiguiente() {
            if (_cola.length === 0) {
                _procesando = false;
                return;
            }
            _procesando = true;
            var item = _cola.shift();
            _renderizar(item);
        }

        function _renderizar(item) {
            var notif   = VP.refs.notification;
            var icono   = VP.refs.notifIcon;
            var mensaje = VP.refs.notifMsg;

            if (dom.esNulo(notif)) {
                _procesando = false;
                return;
            }

            try {
                // Aplicar clase
                notif.className = 'notification ' + item.tipo;

                if (!dom.esNulo(icono)) {
                    var mapa = util.iconosNotif || {};
                    var aliases = { success: 'exito', warning: 'advertencia' };
                    var clave = aliases[item.tipo] || item.tipo;
                    icono.innerHTML = mapa[clave] || mapa.info || 'ℹ';
                }

                if (!dom.esNulo(mensaje)) {
                    mensaje.textContent = item.msg;
                }

                notif.classList.remove('show');
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        notif.classList.add('show');
                    });
                });

                // ARIA para errores y advertencias
                if (item.prioridad >= 2) {
                    dom.ariaLive.anunciar(item.msg);
                }

                TimerPool.timeout(function () {
                    notif.classList.remove('show');
                    // Pequeña pausa entre notificaciones
                    TimerPool.timeout(_mostrarSiguiente, 300, 'notifGap');
                }, _duracion(item.tipo), 'notifActiva');

            } catch (e) {
                try { log.warn('_renderizar falló:', e); } catch (_) {}
                _procesando = false;
            }
        }

        return {
            /**
             * Encola una notificación.
             * @param {string} msg
             * @param {string} tipo
             */
            encolar: function (msg, tipo) {
                tipo = tipo || 'info';
                var p = _prioridad(tipo);

                // Deduplicar: no encolar mismo mensaje+tipo si ya está
                for (var i = 0; i < _cola.length; i++) {
                    if (_cola[i].msg === msg && _cola[i].tipo === tipo) {
                        return;
                    }
                }

                // Si la cola está llena, descartar info de baja prioridad
                if (_cola.length >= _MAX_COLA) {
                    // Eliminar el de menor prioridad al final
                    _ordenar();
                    if (p > _prioridad(_cola[_cola.length - 1].tipo)) {
                        _cola.pop();
                    } else {
                        return; // descartar el nuevo
                    }
                }

                _cola.push({ msg: msg, tipo: tipo,
                             prioridad: p, ts: Date.now() });
                _ordenar();

                if (!_procesando) {
                    _mostrarSiguiente();
                }
            },

            /** Vaciar cola y ocultar notificación actual */
            vaciar: function () {
                _cola       = [];
                _procesando = false;
                TimerPool.clearId('notifActiva');
                TimerPool.clearId('notifGap');
                var notif = VP.refs.notification;
                if (notif && !dom.esNulo(notif)) {
                    notif.classList.remove('show');
                }
            },

            /** Diagnóstico */
            estado: function () {
                return { cola: _cola.length, procesando: _procesando };
            },
        };
    })();

    // ============================================================
    // NOTIFICACIONES — API PÚBLICA
    // ============================================================

    VP.ui.mostrarNotificacion = function (msg, tipo) {
        tipo = tipo || 'info';

        // Sanitizar
        var msgSeg = _sanitizarMensaje(msg);
        if (!msgSeg) return;

        ColaNotificaciones.encolar(msgSeg, tipo);
    };

    VP.ui.ocultarNotificacion = function () {
        try {
            ColaNotificaciones.vaciar();
        } catch (_) {}
    };

    // Marcar sistema de notificaciones como listo
    VP.runtime.notifListo = true;

    // ============================================================
    // SANITIZADOR DE MENSAJES (helper privado)
    // ============================================================

    function _sanitizarMensaje(msg) {
        if (msg === null || msg === undefined) return '';

        var resultado;
        if (typeof msg === 'string') {
            resultado = msg;
        } else if (msg instanceof Error) {
            resultado = msg.message || 'Error desconocido';
        } else {
            try   { resultado = String(msg); }
            catch (_) { resultado = '[objeto no representable]'; }
        }

        // Truncar mensajes muy largos
        if (resultado.length > 200) {
            resultado = resultado.substring(0, 197) + '…';
        }

        // Eliminar caracteres de control (excepto espacio)
        resultado = resultado.replace(/[\x00-\x1F\x7F]/g, ' ').trim();

        return resultado;
    }

    // ============================================================
    // API GLOBAL — window.vpShowNotification
    // Throttle por tipo: errores nunca se descartan.
    // ============================================================

    var _throttleNotifExt = (function () {
        var _ultimas   = Object.create(null);
        var _GAPS      = { info: 500, exito: 500, success: 500,
                           warning: 300, advertencia: 300, error: 0 };
        return function (tipo) {
            var gap  = _GAPS[tipo] !== undefined ? _GAPS[tipo] : 400;
            var ahora = Date.now();
            if (ahora - (_ultimas[tipo] || 0) < gap) return false;
            _ultimas[tipo] = ahora;
            return true;
        };
    })();

    var _TIPOS_VALIDOS = {
        info: true, success: true, exito: true,
        warning: true, advertencia: true, error: true,
    };

    window.vpShowNotification = function (msg, tipo) {
        try {
            var tipoSeg = (tipo && _TIPOS_VALIDOS[tipo]) ? tipo : 'info';
            var msgSeg  = _sanitizarMensaje(msg);

            if (!msgSeg) return;

            if (!VP.runtime.notifListo) {
                log.info('(ext) (' + tipoSeg + ') ' + msgSeg);
                return;
            }

            if (!_throttleNotifExt(tipoSeg)) return;

            VP.ui.mostrarNotificacion(msgSeg, tipoSeg);

        } catch (e) {
            try { log.error('vpShowNotification error:', e); }
            catch (_) {}
        }
    };

    window.vpHideNotification = function () {
        try { VP.ui.ocultarNotificacion(); } catch (_) {}
    };

    // ============================================================
    // REGISTRO CENTRALIZADO DE LISTENERS
    // Permite limpiar todos los listeners al destruir el módulo.
    // ============================================================

    var _listenersRegistrados = [];

    function _addListener(target, tipo, fn, opciones) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(tipo, fn, opciones || false);
        _listenersRegistrados.push({
            target: target, tipo: tipo, fn: fn,
            opciones: opciones || false,
        });
    }

    function _removeAllListeners() {
        for (var i = 0; i < _listenersRegistrados.length; i++) {
            var l = _listenersRegistrados[i];
            try {
                l.target.removeEventListener(l.tipo, l.fn, l.opciones);
            } catch (_) {}
        }
        _listenersRegistrados = [];
    }

    VP.eventos.destruir = function () {
        _removeAllListeners();
        TimerPool.clearAll();
        ColaNotificaciones.vaciar();
        log.info('VP.eventos destruido y limpiado.');
    };

    // ============================================================
    // DELEGACIÓN DE EVENTOS — un solo listener por contenedor
    // Para 500+ ítems evitamos múltiples listeners individuales.
    // ============================================================

    /**
     * Registra un listener delegado en `contenedor`.
     * Solo activa `fn` si el evento se originó en un
     * elemento que coincide con `selector`.
     *
     * @param {Element}  contenedor
     * @param {string}   tipoEvento
     * @param {string}   selector    CSS selector del hijo
     * @param {Function} fn          recibe (e, elementoCoincidente)
     */
    function _delegar(contenedor, tipoEvento, selector, fn) {
        if (!contenedor) return;

        function handler(e) {
            var el = e.target;
            // Subir el árbol hasta el contenedor buscando coincidencia
            while (el && el !== contenedor) {
                if (el.matches && el.matches(selector)) {
                    try { fn(e, el); } catch (err) {
                        log.error('[delegado] ' + selector, err);
                    }
                    return;
                }
                el = el.parentElement;
            }
        }

        _addListener(contenedor, tipoEvento, handler);
    }

    VP.eventos.delegar = _delegar; // exponer para otros módulos

    // ============================================================
    // MAPA DE ATAJOS DE TECLADO
    // ============================================================

    // Cada handler recibe el KeyboardEvent.
    // Se usa `e.code` (layout-independent) con fallback a `e.key`.
    var _MAPA_TECLAS = Object.create(null);

    // ---- Reproducción ----
    _MAPA_TECLAS['Space'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('togglePlayPause', function () {
            VP.reproductor.togglePlayPause();
        });
    };
    _MAPA_TECLAS['KeyK'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('togglePlayPause', function () {
            VP.reproductor.togglePlayPause();
        });
    };

    // ---- Pantalla ----
    _MAPA_TECLAS['KeyF'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('toggleFullscreen', function () {
            VP.reproductor.toggleFullscreen();
        });
    };
    _MAPA_TECLAS['KeyT'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('toggleTeatro', function () {
            VP.reproductor.toggleTeatro();
        });
    };
    _MAPA_TECLAS['KeyI'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('togglePiP', function () {
            VP.reproductor.togglePiP();
        });
    };

    // ---- Seek ----
    _MAPA_TECLAS['ArrowLeft'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('seekLeft', function () {
            var v = VP.refs.videoPlayer;
            if (v && v.src && isFinite(v.duration)) {
                var ct = Number(v.currentTime) || 0;
                var paso = Number(cfg.pasoSeek) || 5;
                v.currentTime = Math.max(0, ct - paso);
            }
        });
    };
    _MAPA_TECLAS['ArrowRight'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('seekRight', function () {
            var v = VP.refs.videoPlayer;
            if (v && v.src && isFinite(v.duration)) {
                var ct = Number(v.currentTime) || 0;
                var paso = Number(cfg.pasoSeek) || 5;
                v.currentTime = Math.min(v.duration, ct + paso);
            }
        });
    };
    _MAPA_TECLAS['Home'] = function (e) {
        e.preventDefault();
        try {
            var v = VP.refs.videoPlayer;
            if (v && v.src) v.currentTime = 0;
        } catch (_) {}
    };
    _MAPA_TECLAS['End'] = function (e) {
        e.preventDefault();
        try {
            var v = VP.refs.videoPlayer;
            if (v && v.src && isFinite(v.duration)) {
                v.currentTime = Math.max(0, v.duration - 0.1);
            }
        } catch (_) {}
    };

    // ---- Volumen ----
    _MAPA_TECLAS['ArrowUp'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('volUp', function () {
            var v = VP.refs.videoPlayer;
            if (v) VP.reproductor.setVolumen(v.volume + cfg.pasoVolumen);
        });
    };
    _MAPA_TECLAS['ArrowDown'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('volDown', function () {
            var v = VP.refs.videoPlayer;
            if (v) VP.reproductor.setVolumen(v.volume - cfg.pasoVolumen);
        });
    };
    _MAPA_TECLAS['KeyM'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('mute', function () {
            var v = VP.refs.videoPlayer;
            if (v) { v.muted = !v.muted; VP.reproductor.actualizarUIVolumen(); }
        });
    };

    // ---- Velocidad ----
    _MAPA_TECLAS['BracketLeft'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('velDown', function () {
            var nueva = util.clampNum(
                VP.estado.velocidadActual - 0.25, 0.25, 4
            );
            VP.reproductor.setVelocidad(nueva);
        });
    };
    _MAPA_TECLAS['BracketRight'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('velUp', function () {
            var nueva = util.clampNum(
                VP.estado.velocidadActual + 0.25, 0.25, 4
            );
            VP.reproductor.setVelocidad(nueva);
        });
    };
    _MAPA_TECLAS['Backslash'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('velReset', function () {
            VP.reproductor.setVelocidad(1);
        });
    };

    // ---- Navegación ----
    _MAPA_TECLAS['KeyN'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('siguiente', function () {
            VP.reproductor.siguiente();
        });
    };
    _MAPA_TECLAS['KeyP'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('anterior', function () {
            VP.reproductor.anterior();
        });
    };

    // ---- Subtítulos ----
    _MAPA_TECLAS['KeyC'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('subtitulosToggle', function () {
            VP.subtitulos.toggle();
        });
    };

    // ---- Loop ----
    _MAPA_TECLAS['KeyL'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('loopToggle', function () {
            VP.ajustes.repetir = !VP.ajustes.repetir;
            var lb = VP.refs.loopBtn;
            if (!dom.esNulo(lb)) {
                lb.style.color = VP.ajustes.repetir ? 'var(--yt-red)' : '';
            }
            VP.ajustes.guardar();
            VP.ui.mostrarNotificacion(
                VP.ajustes.repetir ? 'Loop ON' : 'Loop OFF', 'info'
            );
        });
    };

    // ---- Aleatorio ----
    _MAPA_TECLAS['KeyS'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('aleatorioToggle', function () {
            if (VP.reproductor && VP.reproductor.toggleAleatorio) {
                VP.reproductor.toggleAleatorio();
            }
        });
    };

    // ---- Panel de atajos ----
    _MAPA_TECLAS['KeyH'] = function (e) {
        e.preventDefault();
        VP.eventos.togglePanelAtajos();
    };

    // ---- Eliminar de playlist el video actual ----
    _MAPA_TECLAS['Delete'] = function (e) {
        e.preventDefault();
        var ci = VP.estado.currentVideoIndex;
        if (ci >= 0 && Array.isArray(VP.estado.playlist) && ci < VP.estado.playlist.length) {
            VP.listas.eliminarDePlaylist(ci);
        }
    };

    // ---- Panel de estadísticas ----
    _MAPA_TECLAS['KeyD'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('statsPanel', function () {
            var sp = VP.refs.statsPanel;
            if (!dom.esNulo(sp)) {
                sp.classList.toggle('visible');
                if (sp.classList.contains('visible') &&
                    !VP.ajustes.ultraRendimiento) {
                    VP.reproductor.actualizarEstadisticas();
                }
            }
        });
    };

    // ---- Teclas numéricas 0-9 → seek a % ----
    (function registrarDigitos() {
        var digitos = [
            'Digit0','Digit1','Digit2','Digit3','Digit4',
            'Digit5','Digit6','Digit7','Digit8','Digit9',
        ];
        digitos.forEach(function (code, idx) {
            _MAPA_TECLAS[code] = (function (pct) {
                return function (e) {
                    e.preventDefault();
                    CircuitBreaker.ejecutar('seekDigit' + pct, function () {
                        var v = VP.refs.videoPlayer;
                        if (v && v.src && isFinite(v.duration)) {
                            v.currentTime = Math.max(0, Math.min(v.duration, v.duration * pct));
                        }
                    });
                };
            })(idx / 10);
        });
    })();

    // ---- Fotograma anterior/siguiente ----
    _MAPA_TECLAS['Comma'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('frameBack', function () {
            var v = VP.refs.videoPlayer;
            if (v && v.src) {
                v.currentTime = Math.max(0, (Number(v.currentTime) || 0) - 1 / 30);
            }
        });
    };
    _MAPA_TECLAS['Period'] = function (e) {
        e.preventDefault();
        CircuitBreaker.ejecutar('frameForward', function () {
            var v = VP.refs.videoPlayer;
            if (v && v.src && isFinite(v.duration)) {
                v.currentTime = Math.min(v.duration, (Number(v.currentTime) || 0) + 1 / 30);
            }
        });
    };

    // ============================================================
    // LISTENER UNIFICADO DE TECLADO
    // Un solo listener en document — sin duplicados.
    // ============================================================

    var _tecladoInicializado = false;

    VP.eventos.inicializarTeclado = function () {
        if (_tecladoInicializado) {
            log.warn('inicializarTeclado: ya inicializado, ignorando.');
            return;
        }
        _tecladoInicializado = true;

        _addListener(document, 'keydown', function (e) {

            // ---- 1. Escape — cerrar paneles en orden ----
            if (e.key === 'Escape') {
                _manejarEscape(e);
                return;
            }

            // ---- 2. Atajos globalmente desactivados ----
            if (!VP.ajustes.habilitarAtajos) return;

            // ---- 3. Foco en campo editable ----
            var activo = document.activeElement;
            if (activo) {
                var tag = activo.tagName;
                if (tag === 'INPUT'    ||
                    tag === 'SELECT'   ||
                    tag === 'TEXTAREA' ||
                    activo.isContentEditable) return;
            }

            // ---- 4. Modal abierto ----
            if (dom.modalEstaAbierto()) return;

            // ---- 5. Ctrl / Meta / Alt → no interceptar combos del SO ----
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            // ---- 6. Ejecutar handler ----
            var handler = _MAPA_TECLAS[e.code] || _MAPA_TECLAS[e.key];
            if (typeof handler === 'function') {
                handler(e);
            }
        });

        log.debug('Listener de teclado inicializado.');
    };

    /** Registro central de modales IA para cerrar con Escape */
    var _modalesIA = [];

    VP.eventos.registrarModalIA = function (modalId, closeFn) {
        _modalesIA.push({ id: modalId, close: closeFn });
    };

    /** Maneja la tecla Escape cerrando paneles en cascada */
    function _manejarEscape(e) {
        // IA modals
        for (var i = 0; i < _modalesIA.length; i++) {
            var m = _modalesIA[i];
            var el = document.getElementById(m.id);
            if (el && el.classList.contains('active')) {
                e.preventDefault();
                if (typeof m.close === 'function') m.close();
                return;
            }
        }
        // Modal
        if (dom.modalEstaAbierto()) {
            e.preventDefault();
            dom.cerrarModal();
            return;
        }
        // Panel de atajos
        var sp = VP.refs.shortcutsPanel;
        if (!dom.esNulo(sp) && sp.classList.contains('show')) {
            e.preventDefault();
            sp.classList.remove('show');
            return;
        }
        // Panel de estadísticas
        var stats = VP.refs.statsPanel;
        if (!dom.esNulo(stats) && stats.classList.contains('visible')) {
            e.preventDefault();
            stats.classList.remove('visible');
            return;
        }
        // Menú de velocidad
        var sm = VP.refs.speedMenu;
        if (!dom.esNulo(sm) && sm.classList.contains('open')) {
            e.preventDefault();
            sm.classList.remove('open');
            return;
        }
        // Cancelar up-next
        CircuitBreaker.ejecutar('cancelarUpNext', function () {
            VP.reproductor.cancelarUpNext();
        });
    }

    // ============================================================
    // PANEL DE ATAJOS DE TECLADO
    // ============================================================

    VP.eventos.togglePanelAtajos = function () {
        var panel = VP.refs.shortcutsPanel;
        if (dom.esNulo(panel)) return;

        panel.classList.toggle('show');

        if (panel.classList.contains('show')) {
            TimerPool.timeout(function () {
                if (!dom.esNulo(panel)) {
                    panel.classList.remove('show');
                }
            }, 10000, 'shortcutsAutoClose');
        } else {
            TimerPool.clearId('shortcutsAutoClose');
        }
    };

    VP.eventos.inicializarBotonAtajos = function () {
        var btn = VP.refs.shortcutsClose;
        if (dom.esNulo(btn)) {
            log.debug('shortcutsClose: referencia no encontrada, omitiendo.');
            return;
        }

        _addListener(btn, 'click', function () {
            var panel = VP.refs.shortcutsPanel;
            if (!dom.esNulo(panel)) {
                panel.classList.remove('show');
                TimerPool.clearId('shortcutsAutoClose');
            }
        });

        log.debug('Botón de cierre de atajos inicializado.');
    };

    // ============================================================
    // BOTÓN DE CIERRE DE NOTIFICACIÓN
    // ============================================================

    VP.eventos.inicializarBotonNotif = function () {
        var btn = VP.refs.notifClose;
        if (dom.esNulo(btn)) {
            log.debug('notifClose: referencia no encontrada, omitiendo.');
            return;
        }

        _addListener(btn, 'click', function () {
            VP.ui.ocultarNotificacion();
        });

        log.debug('Botón de cierre de notificación inicializado.');
    };

    // ============================================================
    // RED — ONLINE / OFFLINE
    // Con reconexión exponencial para cargas pendientes.
    // ============================================================

    VP.eventos.inicializarRed = function () {
        if (!('onLine' in navigator)) {
            log.debug('API de red no disponible.');
            return;
        }

        var _reintentos    = 0;
        var _maxReintentos = 6;
        var _delayBase     = 1000; // ms

        _addListener(window, 'online', function () {
            _reintentos = 0;
            VP.ui.mostrarNotificacion('Conexión restaurada', 'exito');
            log.info('Red: conexión restaurada.');
            bus.emit('redConectada');

            // Reanudar colas diferidas
            TimerPool.timeout(function () {
                CircuitBreaker.ejecutar('procesarCola', function () {
                    VP.miniaturas.procesarCola();
                    VP.miniaturas.procesarColaDuracion();
                });
            }, 500, 'reanudarCola');
        });

        _addListener(window, 'offline', function () {
            VP.ui.mostrarNotificacion(
                'Sin conexión — reproducción local no afectada', 'info'
            );
            log.info('Red: sin conexión. Reintentos: ' + _reintentos);
            bus.emit('redDesconectada');

            // Backoff exponencial para verificar reconexión
            _intentarReconexion();
        });

        function _intentarReconexion() {
            if (navigator.onLine || _reintentos >= _maxReintentos) return;
            var delay = _delayBase * Math.pow(2, _reintentos);
            _reintentos++;
            TimerPool.timeout(function () {
                if (!navigator.onLine) {
                    log.debug(
                        'Red: sin conexión, reintento ' + _reintentos
                    );
                    _intentarReconexion();
                }
            }, delay, 'reconexion_' + _reintentos);
        }

        log.debug('Listeners de red inicializados.');
    };

    // ============================================================
    // VISIBILIDAD DE PESTAÑA
    // Pausa colas pesadas al ocultar para ahorrar CPU.
    // ============================================================

    VP.eventos.inicializarVisibilidad = function () {
        if (!VP.features.pageVisibility) {
            log.debug('Page Visibility API no disponible.');
            return;
        }

        // Detectar prefijo
        var _evento = 'visibilitychange';
        var _prop   = 'hidden';
        if (typeof document.webkitHidden !== 'undefined') {
            _evento = 'webkitvisibilitychange';
            _prop   = 'webkitHidden';
        } else if (typeof document.msHidden !== 'undefined') {
            _evento = 'msvisibilitychange';
            _prop   = 'msHidden';
        }

        _addListener(document, _evento, function () {
            var oculto  = !!document[_prop];
            var visible = !oculto;

            VP.runtime.tabVisible         = visible;

            if (oculto) {
                // Guardar progreso
                CircuitBreaker.ejecutar(
                    'guardarProgresoVisibilidad',
                    function () { VP.reproductor.guardarProgresoCurrent(); }
                );

                // Pausar procesos pesados
                TimerPool.clearIntervalId('statsInterval');

            } else {
                // Reanudar colas diferidas con pequeño delay
                TimerPool.timeout(function () {
                    CircuitBreaker.ejecutar('reanudarColas', function () {
                        VP.miniaturas.procesarCola();
                        VP.miniaturas.procesarColaDuracion();
                    });
                }, 250, 'reanudarColasVisibilidad');
            }

            bus.emit('visibilidad', visible);
            log.debug('Visibilidad pestaña:', visible);
        });

        log.debug('Listener de visibilidad inicializado (' + _evento + ').');
    };

    // ============================================================
    // ANTES DE CERRAR LA PESTAÑA
    // ============================================================

    VP.eventos.inicializarBeforeUnload = function () {
        _addListener(window, 'beforeunload', function () {

            // 1. Guardar progreso
            CircuitBreaker.ejecutar('guardarProgresoUnload', function () {
                VP.reproductor.guardarProgresoCurrent();
            });

            // 2. Cancelar procesos activos
            try { VP.carga.cancelar();             } catch (_) {}
            try { VP.reproductor.cancelarUpNext();  } catch (_) {}
            try { VP.reproductor.detenerWatchdog(); } catch (_) {}

            // 3. Revocar Blob URLs
            try { VP.revocarTodosBlobURLs();        } catch (_) {}

            // 4. Limpiar TODO desde el pool
            TimerPool.clearAll();

            // 5. Limpiar listeners propios
            _removeAllListeners();

            log.debug('beforeunload: limpieza completada.');
        });

        log.debug('Listener beforeunload inicializado.');
    };

    // ============================================================
    // RESIZE — ENCABEZADO, MÓVIL Y GALERÍA ADAPTATIVA
    // Debounce agresivo para listas de 500+ ítems.
    // ============================================================

    VP.eventos.inicializarResize = function () {

        // Debounce de 150 ms — suficientemente rápido para UX
        var _onResize = util.debounce(function () {
            CircuitBreaker.ejecutar('resize', function () {
                if (VP.ajustes.fijarEncabezado) {
                    VP.ajustes.actualizarAlturaEncabezado();
                }
                VP.listas.aplicarControlesMobiles();

                // Re-renderizar galería si el número de columnas cambió
                _ajustarColumnasGaleria();
            });
        }, 150);

        _addListener(window, 'resize', _onResize);

        // ResizeObserver para el encabezado (más preciso que resize)
        if (VP.features.resizeObserver) {
            var elHeader = dom.$q('header');
            if (elHeader) {
                var _roHeader = new ResizeObserver(util.debounce(function () {
                    if (VP.ajustes.fijarEncabezado) {
                        CircuitBreaker.ejecutar(
                            'resizeObserverHeader',
                            function () {
                                VP.ajustes.actualizarAlturaEncabezado();
                            }
                        );
                    }
                }, 100));
                _roHeader.observe(elHeader);

                // Guardar referencia para destruir
                VP.runtime.roHeader = _roHeader;
            }
        }

        log.debug('Listener de resize inicializado.');
    };

    /**
     * Detecta si el número de columnas de la galería cambió
     * y dispara un re-render diferido para no bloquear el hilo.
     */
    function _ajustarColumnasGaleria() {
        var galeria = VP.refs.gallery;
        if (!galeria) return;

        var cols = _calcularColumnas();
        if (cols !== VP.runtime.columnasGaleria) {
            VP.runtime.columnasGaleria = cols;
            TimerPool.timeout(function () {
                bus.emit('renderGaleria', { motivo: 'resize' });
            }, 200, 'renderGaleriaResize');
        }
    }

    function _calcularColumnas() {
        var w = window.innerWidth || document.documentElement.clientWidth;
        if (w >= 1400) return 6;
        if (w >= 1100) return 5;
        if (w >= 800)  return 4;
        if (w >= 560)  return 3;
        if (w >= 380)  return 2;
        return 1;
    }

    // ============================================================
    // ACCESIBILIDAD — ARIA LIVE
    // ============================================================

    VP.eventos.inicializarAccesibilidad = function () {
        CircuitBreaker.ejecutar('ariaLiveInit', function () {
            dom.ariaLive.inicializar();
        });

        // Anunciar cambios de video — throttled para ráfagas rápidas
        var _anunciarVideo = util.throttle(function () {
            var ci = VP.estado.currentVideoIndex;
            if (ci >= 0 && VP.estado.playlist && VP.estado.playlist[ci]) {
                dom.ariaLive.anunciar(
                    'Reproduciendo: ' + VP.estado.playlist[ci].name
                );
            }
        }, 1000);

        bus.on('videoCambiado', _anunciarVideo);

        bus.on('reset', function () {
            dom.ariaLive.anunciar('Reproductor reiniciado');
        });

        log.debug('Accesibilidad ARIA inicializada.');
    };

    // ============================================================
    // TÍTULO DEL DOCUMENTO
    // ============================================================

    VP.eventos.inicializarTituloDoc = function () {
        var _tituloOriginal = document.title || 'Video Player';
        var _maxLong        = 60; // truncar títulos muy largos

        bus.on('videoCambiado', function () {
            var ci = VP.estado.currentVideoIndex;
            if (ci >= 0 && VP.estado.playlist && VP.estado.playlist[ci]) {
                var nombre = VP.estado.playlist[ci].name || 'Sin título';
                if (nombre.length > _maxLong) {
                    nombre = nombre.substring(0, _maxLong - 1) + '…';
                }
                document.title = '▶ ' + nombre + ' — Video Player';
            }
        });

        bus.on('reset', function () {
            document.title = _tituloOriginal;
        });

        log.debug('Actualizador de título inicializado.');
    };

    // ============================================================
    // INICIALIZAR AJUSTES — MODAL
    // ============================================================

    VP.eventos.inicializarModal = function () {
        CircuitBreaker.ejecutar('inicializarModal', function () {
            VP.ajustes.inicializarModal();
            VP.ajustes.inicializarTemas();
            VP.ajustes.inicializarResizeEncabezado();
        });
        log.debug('Listeners del modal de ajustes inicializados.');
    };

    // ============================================================
    // INICIALIZAR LISTAS
    // ============================================================

    VP.eventos.inicializarListas = function () {
        CircuitBreaker.ejecutar('inicializarListas', function () {
            VP.listas.inicializar();
        });
        log.debug('Listeners de listas inicializados.');
    };

    // ============================================================
    // INICIALIZAR CARGA — BOTONES Y DRAG&DROP
    // ============================================================

    VP.eventos.inicializarCarga = function () {
        CircuitBreaker.ejecutar('inicializarCarga', function () {
            VP.carga.inicializar();
        });
        log.debug('Listeners de carga inicializados.');
    };

    // ============================================================
    // INICIALIZAR REPRODUCTOR
    // ============================================================

    VP.eventos.inicializarReproductor = function () {
        CircuitBreaker.ejecutar('inicializarReproductor', function () {
            VP.reproductor.inicializar();
        });
        log.debug('Listeners del reproductor inicializados.');
    };

    // ============================================================
    // SISTEMA DE NOTIFICACIONES — BUS
    // ============================================================

    VP.eventos.inicializarNotificaciones = function () {
        bus.on('notificar', function (msg, tipo) {
            VP.ui.mostrarNotificacion(msg, tipo);
        });
        log.debug('Sistema de notificaciones (bus) inicializado.');
    };

    // ============================================================
    // INICIALIZAR TODO — ORDEN GARANTIZADO
    // ============================================================

    var _inicializadoGlobal = false;

    VP.eventos.inicializar = function () {
        if (_inicializadoGlobal) {
            log.warn('VP.eventos.inicializar: ya inicializado, ignorando.');
            return;
        }
        _inicializadoGlobal = true;

        var pasos = [
            ['Accesibilidad',    VP.eventos.inicializarAccesibilidad],
            ['Notificaciones',   VP.eventos.inicializarNotificaciones],
            ['BotónNotif',       VP.eventos.inicializarBotonNotif],
            ['BotónAtajos',      VP.eventos.inicializarBotonAtajos],
            ['Teclado',          VP.eventos.inicializarTeclado],
            ['Red',              VP.eventos.inicializarRed],
            ['Visibilidad',      VP.eventos.inicializarVisibilidad],
            ['BeforeUnload',     VP.eventos.inicializarBeforeUnload],
            ['Resize',           VP.eventos.inicializarResize],
            ['TítuloDoc',        VP.eventos.inicializarTituloDoc],
            ['Modal',            VP.eventos.inicializarModal],
            ['Listas',           VP.eventos.inicializarListas],
            ['Carga',            VP.eventos.inicializarCarga],
            ['Reproductor',      VP.eventos.inicializarReproductor],
        ];

        for (var i = 0; i < pasos.length; i++) {
            var nombre = pasos[i][0];
            var fn     = pasos[i][1];
            try {
                fn();
            } catch (e) {
                log.error(
                    '[VP.eventos.inicializar] Fallo en paso "' +
                    nombre + '":', e
                );
                // Continuar con los demás pasos
            }
        }

        // Calcular columnas iniciales
        VP.runtime.columnasGaleria = _calcularColumnas();

        log.info(
            'VP.eventos inicializado (' + pasos.length + ' pasos). ' +
            'Timers: ' + JSON.stringify(TimerPool.diagnostico())
        );
    };

    // ============================================================
    // LISTENERS DEL BUS — EVENTOS GLOBALES
    // ============================================================

    // Error del reproductor
    bus.on('errorReproductor', function (msg) {
        VP.ui.mostrarNotificacion(
            _sanitizarMensaje(msg) || 'Error en el reproductor', 'error'
        );
    });

    // Ultra Rendimiento
    bus.on('ultraRendimiento', function (activo) {
        VP.ui.mostrarNotificacion(
            activo
                ? 'Ultra Rendimiento activado'
                : 'Ultra Rendimiento desactivado',
            activo ? 'advertencia' : 'info'
        );
        // Detener/reanudar estadísticas
        if (activo) {
            TimerPool.clearIntervalId('statsInterval');
        }
    });

    // Temporizador de sueño
    bus.on('temporizadorSuenoFin', function () {
        VP.ui.mostrarNotificacion(
            'Temporizador: reproducción detenida', 'advertencia'
        );
    });

    // Caché vaciada — batch de renders
    bus.on('cacheVaciada', function () {
        TimerPool.timeout(function () {
            bus.emit('renderGaleria',  { motivo: 'cacheVaciada' });
            bus.emit('renderPlaylist', { motivo: 'cacheVaciada' });
        }, 50, 'renderTrasCacheVaciada');
    });

    // Playlist cargada — anunciar cantidad
    bus.on('playlistCargada', function (lista) {
        if (!lista || !lista.length) return;
        var n = lista.length;
        VP.ui.mostrarNotificacion(
            n + ' video' + (n !== 1 ? 's' : '') + ' cargado' +
            (n !== 1 ? 's' : ''),
            'exito'
        );
    });

    // Rendimiento crítico — liberar colas
    bus.on('rendimientoCritico', function () {
        ColaNotificaciones.vaciar();
        log.warn('Rendimiento crítico: cola de notificaciones vaciada.');
    });

    // ============================================================
    // VERIFICACIÓN DE MÓDULO — AUTO-TEST
    // ============================================================

    (function verificarModulo() {
        var requeridosEventos = [
            'inicializar',
            'inicializarTeclado',
            'inicializarBotonAtajos',
            'inicializarBotonNotif',
            'inicializarRed',
            'inicializarVisibilidad',
            'inicializarBeforeUnload',
            'inicializarResize',
            'inicializarAccesibilidad',
            'inicializarTituloDoc',
            'inicializarModal',
            'inicializarListas',
            'inicializarCarga',
            'inicializarReproductor',
            'inicializarNotificaciones',
            'togglePanelAtajos',
            'destruir',
            'delegar',
        ];

        var requeridosUI = [
            'mostrarNotificacion',
            'ocultarNotificacion',
        ];

        var fallos = 0;

        requeridosEventos.forEach(function (nombre) {
            if (typeof VP.eventos[nombre] !== 'function') {
                log.error(
                    'vp-eventos.js: función requerida faltante → VP.eventos.' +
                    nombre
                );
                fallos++;
            }
        });

        requeridosUI.forEach(function (nombre) {
            if (typeof VP.ui[nombre] !== 'function') {
                log.error(
                    'vp-eventos.js: función de UI faltante → VP.ui.' + nombre
                );
                fallos++;
            }
        });

        // Verificar que _MAPA_TECLAS tiene las teclas esenciales
        var teclasEsenciales = ['Space', 'KeyF', 'KeyN', 'KeyP', 'ArrowLeft',
                                'ArrowRight', 'KeyM', 'Digit0', 'Digit5'];
        teclasEsenciales.forEach(function (code) {
            if (typeof _MAPA_TECLAS[code] !== 'function') {
                log.error(
                    'vp-eventos.js: atajo de teclado faltante → ' + code
                );
                fallos++;
            }
        });

        if (fallos === 0) {
            log.debug('Verificación de módulo: OK (0 fallos).');
        } else {
            log.error(
                'Verificación de módulo: ' + fallos + ' fallo(s) detectados.'
            );
        }
    })();

    // ============================================================
    // DIAGNÓSTICO — accesible desde consola
    // ============================================================

    VP.eventos.diagnostico = function () {
        return {
            inicializado:      _inicializadoGlobal,
            teclado:           _tecladoInicializado,
            listeners:         _listenersRegistrados.length,
            timers:            TimerPool.diagnostico(),
            circuitBreaker:    CircuitBreaker.estado(),
            colaNotif:         ColaNotificaciones.estado(),
            columnasGaleria:   VP.runtime.columnasGaleria,
            mapaAtajosTeclas:  Object.keys(_MAPA_TECLAS).length,
        };
    };

    // ============================================================
    // LOG DE CARGA
    // ============================================================

    log.info('vp-eventos.js v2.0 cargado correctamente.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-eventos.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
