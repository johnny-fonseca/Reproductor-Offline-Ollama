'use strict';

// ============================================================
// VP-AJUSTES.JS  v2.1
// Configuración del usuario: carga, guardado, aplicación
// de ajustes, temas, color de acento, ultra rendimiento
// y modal de configuración.
//
// OPTIMIZACIONES PARA 500+ VIDEOS:
// - Guardado con debounce para evitar escrituras excesivas
// - Validación robusta de todos los campos de entrada
// - Gestión de memoria: limpieza de listeners y timers
// - Migración de versiones con fallback seguro
// - Procesamiento por lotes del layout para evitar reflows
// - ResizeObserver con desconexión controlada
// - Manejo de errores granular con recuperación
// - Cache de referencias DOM para evitar consultas repetidas
// - Protección contra condiciones de carrera
// - Throttling en operaciones costosas
//
// CHANGELOG v2.1:
// - Limpieza de listeners del bus en destroy()
// - Evita doble emisión de 'ajustesGuardados'
// - Protección de accesos a VP.estado
// - Batch de aplicaciones UI para evitar múltiples RAF
// - Validación mejorada de QuotaExceededError
// - Polyfill seguro de closest()
// - Guardia adicional sobre VP.cache
// ============================================================

(function (window, document) {

    // ============================================================
    // GUARDIA DE DEPENDENCIAS
    // ============================================================

    var VP = window.VP;

    if (!VP) {
        throw new Error('[VP] vp-ajustes.js: vp-base.js debe cargarse primero.');
    }

    // Verificar dependencias críticas antes de continuar
    var _dependencias = ['util', 'dom', 'log', 'config', 'bus', 'ajustes', 'cache', 'runtime'];
    for (var _di = 0; _di < _dependencias.length; _di++) {
        if (!VP[_dependencias[_di]]) {
            throw new Error(
                '[VP] vp-ajustes.js: dependencia faltante → VP.' + _dependencias[_di]
            );
        }
    }

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var cfg  = VP.config;
    var bus  = VP.bus;
    log.setContext('Ajustes');

    // ============================================================
    // CONSTANTES INTERNAS
    // ============================================================

    /** Versión del esquema de ajustes para migraciones futuras */
    var AJUSTES_VERSION       = 2;

    /** Tiempo de debounce para guardado (ms) — evita escrituras en ráfaga */
    var DEBOUNCE_GUARDAR_MS   = 400;

    /** Tiempo de debounce para resize (ms) */
    var DEBOUNCE_RESIZE_MS    = 120;

    /** Máximo de minutos para el temporizador de sueño */
    var MAX_TIMER_MINUTOS     = 600;

    /** Timeout para long-press en botones de tema (ms) */
    var LONG_PRESS_TIEMPO_MS  = 600;

    /** Máximo de intentos de migración antes de descartar datos corruptos */
    var MAX_INTENTOS_MIGRACION = 3;

    // ============================================================
    // ESTADO INTERNO DEL MÓDULO
    // ============================================================

    /**
     * Estado privado del módulo:
     * - Evita fugas de memoria al centralizar timers y observers
     * - Permite destrucción limpia del módulo si fuera necesario
     */
    var _estado = {
        // Timer de debounce para guardado
        timerGuardar:       null,

        // ResizeObserver del encabezado
        resizeObsEncabezado: null,

        // Mapa de listener-cleanups para botones de tema
        cleanupsTemas:      {},

        // Flag: el módulo fue destruido
        destruido:          false,

        // Flag: guardado en progreso (protección contra condición de carrera)
        guardandoEnProgreso: false,

        // Caché de referencias DOM usadas frecuentemente
        _refsCache:         null,

        // Contador de errores de guardado (para backoff)
        erroresGuardado:    0,

        // Flag: inicialización completada
        inicializado:       false,

        // Flag: hay una actualización de UI pendiente en RAF (evita múltiples)
        uiUpdatePending:    false
    };

    // ============================================================
    // UTILIDADES PRIVADAS
    // ============================================================

    /**
     * Guarda el item con manejo de cuota excedida.
     * Si el storage está lleno, intenta liberar espacio de keys antiguas.
     *
     * @param {string} clave
     * @param {*}      valor
     * @returns {boolean} true si se guardó correctamente
     */
    function _guardarSeguro(clave, valor) {
        try {
            util.guardarItem(clave, valor);
            _estado.erroresGuardado = 0;
            return true;
        } catch (e) {
            _estado.erroresGuardado++;

            // QuotaExceededError — detectar con regex para cubrir variaciones entre navegadores
            if (/quota_?(exceeded|reached)/i.test(e.name) || e.code === 22) {
log.warn('_guardarSeguro: cuota de almacenamiento excedida. ' +
                          'Intentando liberar espacio...');

                try {
                    // Eliminar claves de caché temporales si existen
                    var clavesLimpiar = [
                        'vp_temp_cache',
                        'vp_thumb_cache_old',
                        'videoPlayerCache'
                    ];
                    for (var ci = 0; ci < clavesLimpiar.length; ci++) {
                        util.eliminarItem(clavesLimpiar[ci]);
                    }

                    // Reintentar una vez
                    util.guardarItem(clave, valor);
                    log.info('_guardarSeguro: guardado exitoso tras liberar espacio.');
                    _estado.erroresGuardado = 0;
                    return true;

                } catch (e2) {
                    log.error('_guardarSeguro: no se pudo liberar espacio suficiente.', e2);
                    bus.emit('errorAlmacenamiento', {
                        tipo:   'cuotaExcedida',
                        clave:  clave,
                        error:  e2
                    });
                    return false;
                }

            } else {
                log.error('_guardarSeguro: error inesperado al guardar "' + clave + '":', e);
                return false;
            }
        }
    }

    /**
     * Valida y sanitiza un valor booleano con fallback.
     *
     * @param {*}       valor
     * @param {boolean} fallback
     * @returns {boolean}
     */
    function _parseBool(valor, fallback) {
        if (valor === null || valor === undefined) return !!fallback;
        return !!valor;
    }

    /**
     * Valida que un número esté dentro de un rango, con fallback.
     *
     * @param {*}      val
     * @param {number} min
     * @param {number} max
     * @param {number} fallback
     * @returns {number}
     */
    function _parseRangoNum(val, min, max, fallback) {
        var n = parseFloat(val);
        if (isNaN(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    /**
     * Valida que un entero esté dentro de un rango, con fallback.
     *
     * @param {*}      val
     * @param {number} min
     * @param {number} max
     * @param {number} fallback
     * @returns {number}
     */
    function _parseRangoInt(val, min, max, fallback) {
        var n = parseInt(val, 10);
        if (isNaN(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    /**
     * Aplica checked a un elemento checkbox de forma segura.
     *
     * @param {Element|null} el
     * @param {boolean}      valor
     */
    function _setChecked(el, valor) {
        if (dom.esNulo(el)) return;

        if (el.tagName !== 'INPUT' || el.type !== 'checkbox') {
            log.warn('_setChecked: el elemento no es un checkbox:', el);
            return;
        }

        el.checked = !!valor;
    }

    /**
     * Aplica un atributo a un elemento de forma segura.
     *
     * @param {Element|null} el
     * @param {string}       attr
     * @param {string}       valor
     */
    function _setAttr(el, attr, valor) {
        if (!dom.esNulo(el)) el.setAttribute(attr, valor);
    }

    /**
     * Aplica una clase condicional de forma segura.
     *
     * @param {Element|null} el
     * @param {string}       clase
     * @param {boolean}      activa
     */
    function _toggleClass(el, clase, activa) {
        if (!dom.esNulo(el)) el.classList.toggle(clase, !!activa);
    }

    /**
     * Aplica un estilo CSS de forma segura.
     *
     * @param {Element|null} el
     * @param {string}       propiedad
     * @param {string}       valor
     */
    function _setStyle(el, propiedad, valor) {
        if (!dom.esNulo(el)) el.style[propiedad] = valor;
    }

    /**
     * Devuelve true si un color hexadecimal es válido.
     *
     * @param {string} color
     * @returns {boolean}
     */
    function _esColorValido(color) {
        if (!color || typeof color !== 'string') return false;
        return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color.trim());
    }

    /**
     * Valida que un nombre de tema esté en la lista permitida.
     *
     * @param {string} tema
     * @returns {string} tema validado o 'default'
     */
    function _validarTema(tema) {
        var temasPermitidos = [
            'default', 'dark', 'light', 'amoled',
            'ocean', 'forest', 'sunset', 'custom'
        ];
        if (!tema || typeof tema !== 'string') return 'default';
        tema = tema.trim().toLowerCase();
        return temasPermitidos.indexOf(tema) !== -1 ? tema : 'default';
    }

    /**
     * Normaliza y valida el valor del temporizador de sueño.
     *
     * @param {*} val
     * @returns {number} entero entre 0 y MAX_TIMER_MINUTOS
     */
    function _validarTemporizador(val) {
        return _parseRangoInt(val, 0, MAX_TIMER_MINUTOS, 0);
    }

    /**
     * Polyfill seguro de closest().
     * Devuelve el ancestro más cercano que coincida con el selector, o el padre.
     *
     * @param {Element} el
     * @param {string}  selector
     * @returns {Element|null}
     */
    function _closestSafe(el, selector) {
        if (el.closest) return el.closest(selector);
        var parent = el.parentNode;
        while (parent && parent !== document) {
            if (parent.matches && parent.matches(selector)) return parent;
            parent = parent.parentNode;
        }
        return el.parentNode;
    }

    // ============================================================
    // MIGRACIÓN DE AJUSTES
    // ============================================================

    /**
     * Migra ajustes de versiones anteriores al esquema actual.
     *
     * @param {Object} datos   - Datos crudos del storage
     * @param {number} version - Versión detectada en los datos
     * @returns {Object} datos migrados
     */
    function _migrarAjustes(datos, version) {
        var migraciones = 0;

        try {
            if (version < 2) {
                if ('autoResume' in datos && !('autoReanudar' in datos)) {
                    datos.autoReanudar = datos.autoResume;
                    delete datos.autoResume;
                    migraciones++;
                }
                if ('generateThumbs' in datos && !('generarMiniaturas' in datos)) {
                    datos.generarMiniaturas = datos.generateThumbs;
                    delete datos.generateThumbs;
                    migraciones++;
                }
                if ('enablePreviews' in datos && !('habilitarPreviews' in datos)) {
                    datos.habilitarPreviews = datos.enablePreviews;
                    delete datos.enablePreviews;
                    migraciones++;
                }
                datos._version = 2;
                log.info('Ajustes migrados de v1 → v2. Cambios:', migraciones);
            }

        } catch (e) {
            log.error('_migrarAjustes: error durante la migración:', e);
        }

        return datos;
    }

    // ============================================================
    // SCHEMA DE VALIDACIÓN DE AJUSTES
    // ============================================================

    var _SCHEMA_AJUSTES = {
        autoReanudar:           { tipo: 'bool', fallback: true  },
        generarMiniaturas:      { tipo: 'bool', fallback: true  },
        habilitarPreviews:      { tipo: 'bool', fallback: true  },
        habilitarAtajos:        { tipo: 'bool', fallback: true  },
        ultraRendimiento:       { tipo: 'bool', fallback: false },
        fijarReproductor:       { tipo: 'bool', fallback: false },
        fijarEncabezado:        { tipo: 'bool', fallback: false },
        activarMochiIA:         { tipo: 'bool', fallback: false },
        vozMochiActivada:       { tipo: 'bool', fallback: false },
        ttsVolume:              { tipo: 'num', min: 0, max: 1, fallback: 1 },
        ttsLastVolume:          { tipo: 'num', min: 0.01, max: 1, fallback: 1 },
        scrollPlaylistIndep:    { tipo: 'bool', fallback: true  },
        scrollGaleriaIndep:     { tipo: 'bool', fallback: false },
        repetir:                { tipo: 'bool', fallback: false },
        aleatorio:              { tipo: 'bool', fallback: false },
        hdr:                    { tipo: 'bool', fallback: false },
        autoGenerarArrayPreview:{ tipo: 'bool', fallback: true  },
        silenciadoGlobal:       { tipo: 'bool', fallback: false },

        volumenGlobal:          { tipo: 'num',  min: 0,    max: 1,   fallback: 0.8  },
        velocidadGlobal:        { tipo: 'num',  min: 0.25, max: 4.0, fallback: 1.0  },
        pasoSeek:               { tipo: 'int',  min: 1,    max: 60,  fallback: 10   },
        pasoVolumen:            { tipo: 'num',  min: 0.01, max: 0.5, fallback: 0.1  },
        demoraSiguiente:        { tipo: 'int',  min: 1,    max: 30,  fallback: 5    },
        maxHistorialReciente:   { tipo: 'int',  min: 10,   max: 500, fallback: 50   },
        temporizadorSueno:      { tipo: 'int',  min: 0, max: MAX_TIMER_MINUTOS, fallback: 0 },

        colorAcento:            {
            tipo:     'str',
            fallback: '#ff0000',
            validar:  _esColorValido
        },
        nivelLog:               {
            tipo:     'str',
            fallback: 'INFO',
            validar:  function (v) {
                return ['DEBUG', 'INFO', 'WARN', 'ERROR', 'NONE'].indexOf(v) !== -1;
            }
        }
    };

    function _validarPorSchema(clave, valor) {
        var def = _SCHEMA_AJUSTES[clave];
        if (!def) return valor;

        var fallback = def.fallback;

        switch (def.tipo) {
            case 'bool':
                return _parseBool(valor, fallback);
            case 'num':
                return _parseRangoNum(valor, def.min, def.max, fallback);
            case 'int':
                return _parseRangoInt(valor, def.min, def.max, fallback);
            case 'str':
                if (typeof valor !== 'string' || !valor.trim()) return fallback;
                var valStr = valor.trim();
                if (def.validar && !def.validar(valStr)) {
                    log.warn('_validarPorSchema: valor inválido para "' + clave + '":', valor);
                    return fallback;
                }
                return valStr;
            case 'any':
                return valor !== undefined ? valor : fallback;
            default:
                return valor !== undefined ? valor : fallback;
        }
    }

    // ============================================================
    // CARGAR AJUSTES DESDE ALMACENAMIENTO
    // ============================================================

    VP.ajustes.cargar = function () {
        log.debug('Cargando ajustes...');

        var guardados = null;
        var intentosMigracion = 0;

        try {
            guardados = util.obtenerItem(cfg.claveAjustes);
        } catch (e) {
            log.error('cargar: error leyendo almacenamiento:', e);
        }

        if (!guardados) {
            var clavesAntiguas = ['videoPlayerSettings', 'vp_settings_v1', 'vpSettings'];
            for (var ci = 0; ci < clavesAntiguas.length; ci++) {
                if (intentosMigracion >= MAX_INTENTOS_MIGRACION) break;
                try {
                    var antiguos = util.obtenerItem(clavesAntiguas[ci]);
                    if (antiguos && typeof antiguos === 'object') {
                        guardados = antiguos;
                        _guardarSeguro(cfg.claveAjustes, antiguos);
                        util.eliminarItem(clavesAntiguas[ci]);
                        log.info('Ajustes migrados desde clave antigua:', clavesAntiguas[ci]);
                        break;
                    }
                } catch (e) {
                    log.warn('cargar: error migrando desde "' + clavesAntiguas[ci] + '":', e);
                }
                intentosMigracion++;
            }
        }

        if (!guardados || typeof guardados !== 'object' || Array.isArray(guardados)) {
            log.info('cargar: no se encontraron ajustes válidos. Usando defaults.');
            guardados = {};
        }

        var versionGuardada = _parseRangoInt(guardados._version, 1, 99, 1);
        if (versionGuardada < AJUSTES_VERSION) {
            guardados = _migrarAjustes(guardados, versionGuardada);
        }

        var claves = VP.ajustes._claves;
        var clavesCargadas = 0;

        for (var i = 0; i < claves.length; i++) {
            var k = claves[i];
            if (k in guardados) {
                var valorValidado = _validarPorSchema(k, guardados[k]);
                VP.ajustes[k] = valorValidado;
                clavesCargadas++;
            }
        }

        _restaurarSnapshotUltra(guardados);

        var nivelLog = _validarPorSchema('nivelLog', VP.ajustes.nivelLog);
        try {
            log.setNivel(nivelLog || 'INFO');
        } catch (e) {
            log.warn('cargar: error al aplicar nivel de log:', e);
        }

        _sincronizarCfgDesdeAjustes();

        VP.ajustes._version = AJUSTES_VERSION;

        log.info('Ajustes cargados correctamente. Versión:', AJUSTES_VERSION);
        bus.emit('ajustesCargados', VP.ajustes);
    };

    function _restaurarSnapshotUltra(guardados) {
        if (!VP.cache || !VP.cache.snapshotUltraPerf) {
            log.warn('_restaurarSnapshotUltra: VP.cache o snapshotUltraPerf no existen.');
            return;
        }

        var snap = VP.cache.snapshotUltraPerf;
        var snapGuardado = guardados._ultraSnapshot;

        if (snapGuardado && typeof snapGuardado === 'object' &&
            !Array.isArray(snapGuardado)) {

            snap.generarMiniaturas = _parseBool(snapGuardado.generarMiniaturas, true);
            snap.habilitarPreviews = _parseBool(snapGuardado.habilitarPreviews, true);
            snap.autoGenerarArrayPreview = _parseBool(snapGuardado.autoGenerarArrayPreview, true);
            log.debug('_restaurarSnapshotUltra: snapshot restaurado desde storage.');

        } else if (VP.ajustes.ultraRendimiento) {
            snap.generarMiniaturas       = true;
            snap.habilitarPreviews       = true;
            snap.autoGenerarArrayPreview = true;
            log.warn('_restaurarSnapshotUltra: Ultra Rendimiento activo sin snapshot → defaults seguros aplicados.');

        } else {
            snap.generarMiniaturas       = !!VP.ajustes.generarMiniaturas;
            snap.habilitarPreviews       = !!VP.ajustes.habilitarPreviews;
            snap.autoGenerarArrayPreview = !!VP.ajustes.autoGenerarArrayPreview;
            log.debug('_restaurarSnapshotUltra: snapshot sincronizado con ajustes actuales.');
        }
    }

    function _sincronizarCfgDesdeAjustes() {
        try {
            cfg.pasoSeek = _parseRangoInt(VP.ajustes.pasoSeek, 1, 60, 10);
            cfg.pasoVolumen = _parseRangoNum(VP.ajustes.pasoVolumen, 0.01, 0.5, 0.1);
            cfg.demoraSigVideo = _parseRangoInt(VP.ajustes.demoraSiguiente, 1, 30, 5);
            cfg.maxHistorial = _parseRangoInt(VP.ajustes.maxHistorialReciente, 10, 500, 50);
        } catch (e) {
            log.error('_sincronizarCfgDesdeAjustes:', e);
        }
    }

    // ============================================================
    // GUARDAR AJUSTES EN ALMACENAMIENTO
    // ============================================================

    VP.ajustes._guardarInmediato = function () {
        if (_estado.destruido) {
            log.warn('_guardarInmediato: módulo destruido, ignorando guardado.');
            return false;
        }

        if (_estado.guardandoEnProgreso) {
            log.debug('_guardarInmediato: guardado en progreso, posponiendo.');
            return false;
        }

        _estado.guardandoEnProgreso = true;

        try {
            var aGuardar    = {};
            var claves      = VP.ajustes._claves;
            var clavesFail  = [];

            for (var i = 0; i < claves.length; i++) {
                var k = claves[i];
                aGuardar[k] = _validarPorSchema(k, VP.ajustes[k]);
            }

            aGuardar._version = AJUSTES_VERSION;
            aGuardar._guardadoEn = Date.now();

            var snap = VP.cache && VP.cache.snapshotUltraPerf;
            if (snap) {
                aGuardar._ultraSnapshot = {
                    generarMiniaturas:       !!snap.generarMiniaturas,
                    habilitarPreviews:       !!snap.habilitarPreviews,
                    autoGenerarArrayPreview: !!snap.autoGenerarArrayPreview
                };
            }

            var ok = _guardarSeguro(cfg.claveAjustes, aGuardar);

            if (ok) {
                bus.emit('ajustesGuardados', VP.ajustes);
                log.debug('Ajustes guardados en almacenamiento.', aGuardar._guardadoEn);
            } else {
                log.error('_guardarInmediato: falló el guardado en almacenamiento.');
                bus.emit('errorGuardandoAjustes', { clavesFail: clavesFail });
            }

            return ok;

        } catch (e) {
            log.error('_guardarInmediato:', e);
            return false;
        } finally {
            _estado.guardandoEnProgreso = false;
        }
    };

    VP.ajustes.guardar = function (inmediato) {
        if (inmediato) {
            clearTimeout(_estado.timerGuardar);
            _estado.timerGuardar = null;
            VP.ajustes._guardarInmediato();
            return;
        }

        clearTimeout(_estado.timerGuardar);
        _estado.timerGuardar = setTimeout(function () {
            _estado.timerGuardar = null;
            VP.ajustes._guardarInmediato();
        }, DEBOUNCE_GUARDAR_MS);
    };

    // ============================================================
    // APLICAR AJUSTES A LA INTERFAZ
    // ============================================================

    VP.ajustes.aplicarAlUI = function () {
        if (_estado.uiUpdatePending) return; // Ya hay una actualización en cola
        _estado.uiUpdatePending = true;

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
                _estado.uiUpdatePending = false;
                _aplicarAlUISync();
            });
        } else {
            _estado.uiUpdatePending = false;
            _aplicarAlUISync();
        }
    };

    function _aplicarAlUISync() {
        var refs = VP.refs;
        if (!refs) {
            log.warn('aplicarAlUI: VP.refs no disponible.');
            return;
        }

        try {
            _setChecked(refs.autoResumeChk,          VP.ajustes.autoReanudar);
            _setChecked(refs.genThumbChk,            VP.ajustes.generarMiniaturas);
            _setChecked(refs.enablePreviewChk,       VP.ajustes.habilitarPreviews);
            _setChecked(refs.enableShortChk,         VP.ajustes.habilitarAtajos);
            _setChecked(refs.ultraPerfChk,           VP.ajustes.ultraRendimiento);
            _setChecked(refs.pinPlayerChk,           VP.ajustes.fijarReproductor);
            _setChecked(refs.pinHeaderChk,           VP.ajustes.fijarEncabezado);
            _setChecked(refs.enableMochiAiChk,       VP.ajustes.activarMochiIA);
            _setChecked(refs.mochiVoiceEnabledChk,   VP.ajustes.vozMochiActivada);
            _setChecked(refs.playlistScrollIndepChk, VP.ajustes.scrollPlaylistIndep);
            _setChecked(refs.galleryScrollIndepChk,  VP.ajustes.scrollGaleriaIndep);

            _setStyle(refs.loopBtn,    'color', VP.ajustes.repetir   ? 'var(--yt-red)' : '');
            _setStyle(refs.shuffleBtn, 'color', VP.ajustes.aleatorio ? 'var(--yt-red)' : '');

            _aplicarVolumenUI();
            _aplicarVelocidadUI();

            if (!dom.esNulo(refs.sleepTimerInput)) {
                refs.sleepTimerInput.value = VP.ajustes.temporizadorSueno || 0;
            }

            _aplicarHDRUI(!!VP.ajustes.hdr);

            VP.ajustes.aplicarScroll();
            VP.ajustes.fijarReproductorUI();
            VP.ajustes.fijarEncabezadoUI();
            VP.ajustes._aplicarUIUltraRendimiento(VP.ajustes.ultraRendimiento);

        } catch (e) {
            log.error('_aplicarAlUISync:', e);
        }

        bus.emit('ajustesAplicados');
    }

    function _aplicarVolumenUI() {
        var refs = VP.refs;
        if (VP.ajustes.volumenGlobal === undefined || VP.ajustes.volumenGlobal === null) return;

        var video = refs && refs.videoPlayer;
        if (video && !dom.esNulo(video)) {
            try {
                var vol = _parseRangoNum(VP.ajustes.volumenGlobal, 0, 1, 0.8);
                video.volume = vol;
                video.muted  = !!VP.ajustes.silenciadoGlobal;
            } catch (e) {
                log.warn('_aplicarVolumenUI: error aplicando volumen:', e);
            }
        }

        VP.ajustes._actualizarUIVolumen();
    }

    function _aplicarVelocidadUI() {
        var refs  = VP.refs;
        var vel   = _parseRangoNum(VP.ajustes.velocidadGlobal, 0.25, 4.0, 1.0);
        if (!vel) return;

        if (VP.estado) VP.estado.velocidadActual = vel;

        var video = refs && refs.videoPlayer;
        if (video && !dom.esNulo(video)) {
            try {
                video.playbackRate = vel;
            } catch (e) {
                log.warn('_aplicarVelocidadUI: error aplicando velocidad:', e);
            }
        }

        VP.ajustes._actualizarUIVelocidad(vel);
    }

    function _aplicarHDRUI(activo) {
        var refs = VP.refs;
        if (VP.estado) VP.estado.hdrActivo = activo;
        _toggleClass(refs.videoPlayer, 'hdr-mode', activo);
        _toggleClass(refs.hdrBtn,      'active-btn', activo);
        _setAttr(refs.hdrBtn, 'data-tooltip', activo ? 'Desactivar HDR' : 'Modo HDR');
    }

    // ============================================================
    // HELPERS DE EVENTOS (delegados a través del bus)
    // ============================================================

    VP.ajustes._actualizarUIVolumen = function () {
        bus.emit('actualizarUIVolumen');
    };

    VP.ajustes._actualizarUIVelocidad = function (vel) {
        bus.emit('actualizarUIVelocidad', vel);
    };

    // ============================================================
    // ULTRA RENDIMIENTO
    // ============================================================

    VP.ajustes.activarUltraRendimiento = function () {
        var snap = VP.cache && VP.cache.snapshotUltraPerf;
        if (!snap) {
            log.error('activarUltraRendimiento: snapshotUltraPerf no existe.');
            return;
        }

        var yaEnUltra = !VP.ajustes.generarMiniaturas &&
                        !VP.ajustes.habilitarPreviews &&
                        !VP.ajustes.autoGenerarArrayPreview;

        if (!yaEnUltra) {
            snap.generarMiniaturas       = !!VP.ajustes.generarMiniaturas;
            snap.habilitarPreviews       = !!VP.ajustes.habilitarPreviews;
            snap.autoGenerarArrayPreview = !!VP.ajustes.autoGenerarArrayPreview;
        }

        VP.ajustes.generarMiniaturas       = false;
        VP.ajustes.habilitarPreviews       = false;
        VP.ajustes.autoGenerarArrayPreview = false;

        _vaciarColasDeProcesamiento();

        _setChecked(VP.refs.genThumbChk,      false);
        _setChecked(VP.refs.enablePreviewChk, false);

        VP.ajustes._aplicarUIUltraRendimiento(true);

        log.info('Ultra Rendimiento activado. Snapshot guardado:', JSON.stringify(snap));
        bus.emit('ultraRendimiento', true);
    };

    VP.ajustes.desactivarUltraRendimiento = function () {
        var snap = VP.cache && VP.cache.snapshotUltraPerf;
        if (!snap) {
            log.error('desactivarUltraRendimiento: snapshotUltraPerf no existe.');
            return;
        }

        VP.ajustes.generarMiniaturas = _parseBool(snap.generarMiniaturas, true);
        VP.ajustes.habilitarPreviews = _parseBool(snap.habilitarPreviews, true);
        VP.ajustes.autoGenerarArrayPreview = _parseBool(snap.autoGenerarArrayPreview, true);

        _setChecked(VP.refs.genThumbChk,      VP.ajustes.generarMiniaturas);
        _setChecked(VP.refs.enablePreviewChk, VP.ajustes.habilitarPreviews);

        VP.ajustes._aplicarUIUltraRendimiento(false);

        log.info('Ultra Rendimiento desactivado. Restaurado:', JSON.stringify(snap));
        bus.emit('ultraRendimiento', false);
    };

    VP.ajustes.toggleUltraRendimiento = function (activo) {
        if (!!activo) {
            VP.ajustes.activarUltraRendimiento();
        } else {
            VP.ajustes.desactivarUltraRendimiento();
        }
    };

    function _vaciarColasDeProcesamiento() {
        var runtime = VP.runtime;
        if (!runtime) {
            log.warn('_vaciarColasDeProcesaminto: VP.runtime no disponible.');
            return;
        }

        var cantMiniaturas = Array.isArray(runtime.colaMiniaturas) ? runtime.colaMiniaturas.length : 0;
        var cantDuracion = Array.isArray(runtime.colaDuracion) ? runtime.colaDuracion.length : 0;

        runtime.colaMiniaturas    = [];
        runtime.miniaturasActivas = 0;
        runtime.colaDuracion      = [];

        if (cantMiniaturas > 0 || cantDuracion > 0) {
            log.info('_vaciarColasDeProcesamiento: vaciadas ' + cantMiniaturas + ' miniaturas y ' + cantDuracion + ' duraciones pendientes.');
        }

        bus.emit('colasVaciadas', { miniaturas: cantMiniaturas, duracion: cantDuracion });
    }

    VP.ajustes._aplicarUIUltraRendimiento = function (activo) {
        var afectados = [VP.refs.genThumbChk, VP.refs.enablePreviewChk];
        var tooltip = activo ? 'Desactiva Ultra Rendimiento para cambiar este ajuste' : '';

        for (var i = 0; i < afectados.length; i++) {
            var el = afectados[i];
            if (dom.esNulo(el)) continue;

            el.disabled = !!activo;
            el.title    = tooltip;

            try {
                var parent = _closestSafe(el, 'label');
                if (parent && parent.style !== undefined) {
                    parent.style.opacity = activo ? '0.45' : '';
                    parent.style.cursor  = activo ? 'not-allowed' : '';
                }
            } catch (e) {
                // Fallback silencioso
            }
        }
    };

    // ============================================================
    // RENDIMIENTO ADAPTATIVO
    // ============================================================

    VP.ajustes.verificarRendimientoAdaptativo = function () {
        if (typeof VP.verificarRendimientoAdaptativo !== 'function') {
            log.warn('verificarRendimientoAdaptativo: función no disponible en VP.');
            return;
        }
        VP.verificarRendimientoAdaptativo();
    };

    // ============================================================
    // LEER AJUSTES DESDE LA INTERFAZ
    // ============================================================

    VP.ajustes.leerDesdeUI = function () {
        var refs = VP.refs;
        var raw  = {};

        function _leerChk(el, claveFallback) {
            if (dom.esNulo(el)) return !!VP.ajustes[claveFallback];
            if (el.disabled)    return !!VP.ajustes[claveFallback];
            return !!el.checked;
        }

        raw.autoReanudar        = _leerChk(refs.autoResumeChk,          'autoReanudar');
        raw.generarMiniaturas   = _leerChk(refs.genThumbChk,            'generarMiniaturas');
        raw.habilitarPreviews   = _leerChk(refs.enablePreviewChk,       'habilitarPreviews');
        raw.habilitarAtajos     = _leerChk(refs.enableShortChk,         'habilitarAtajos');
        raw.ultraRendimiento    = _leerChk(refs.ultraPerfChk,           'ultraRendimiento');
        raw.fijarReproductor    = _leerChk(refs.pinPlayerChk,           'fijarReproductor');
        raw.fijarEncabezado     = _leerChk(refs.pinHeaderChk,           'fijarEncabezado');
        raw.activarMochiIA      = _leerChk(refs.enableMochiAiChk,       'activarMochiIA');
        raw.vozMochiActivada    = _leerChk(refs.mochiVoiceEnabledChk,   'vozMochiActivada');
        raw.scrollPlaylistIndep = _leerChk(refs.playlistScrollIndepChk, 'scrollPlaylistIndep');
        raw.scrollGaleriaIndep  = _leerChk(refs.galleryScrollIndepChk,  'scrollGaleriaIndep');

        var valTimer = dom.esNulo(refs.sleepTimerInput)
            ? VP.ajustes.temporizadorSueno
            : refs.sleepTimerInput.value;
        raw.temporizadorSueno = _validarTemporizador(valTimer);

        if (!dom.esNulo(refs.sleepTimerInput)) {
            refs.sleepTimerInput.value = raw.temporizadorSueno;
        }

        return raw;
    };

    // ============================================================
    // GUARDAR DESDE EL MODAL
    // ============================================================

    VP.ajustes.guardarDesdeModal = function () {
        try {
            var raw = VP.ajustes.leerDesdeUI();
            if (!raw || typeof raw !== 'object') {
                throw new Error('leerDesdeUI retornó un valor inválido.');
            }

            var ultraAntes   = !!VP.ajustes.ultraRendimiento;
            var ultraDespues = !!raw.ultraRendimiento;
            var ultraCambio  = (ultraAntes !== ultraDespues);

            if (!ultraAntes && !ultraDespues) {
                VP.ajustes.generarMiniaturas = raw.generarMiniaturas;
                VP.ajustes.habilitarPreviews = raw.habilitarPreviews;
            } else if (!ultraAntes && ultraDespues) {
                var snap = VP.cache && VP.cache.snapshotUltraPerf;
                if (snap) {
                    snap.generarMiniaturas       = raw.generarMiniaturas;
                    snap.habilitarPreviews       = raw.habilitarPreviews;
                    snap.autoGenerarArrayPreview = !!VP.ajustes.autoGenerarArrayPreview;
                }
            }

            VP.ajustes.autoReanudar        = raw.autoReanudar;
            VP.ajustes.habilitarAtajos     = raw.habilitarAtajos;
            VP.ajustes.fijarReproductor    = raw.fijarReproductor;
            VP.ajustes.fijarEncabezado     = raw.fijarEncabezado;
            VP.ajustes.activarMochiIA      = raw.activarMochiIA;
            VP.ajustes.vozMochiActivada    = raw.vozMochiActivada;
            VP.ajustes.scrollPlaylistIndep = raw.scrollPlaylistIndep;
            VP.ajustes.scrollGaleriaIndep  = raw.scrollGaleriaIndep;
            VP.ajustes.temporizadorSueno   = raw.temporizadorSueno;
            VP.ajustes.ultraRendimiento    = ultraDespues;

            if (ultraCambio) {
                VP.ajustes.toggleUltraRendimiento(ultraDespues);
            }

            _sincronizarCfgDesdeAjustes();
            VP.ajustes.guardar(true); // Emite 'ajustesGuardados' internamente

            try { dom.cerrarModal(); } catch (e) { log.warn('guardarDesdeModal: error cerrando modal:', e); }

            VP.ajustes.fijarReproductorUI();
            VP.ajustes.fijarEncabezadoUI();
            VP.ajustes.aplicarScroll();
            VP.ajustes.aplicarTemporizadorSueno(raw.temporizadorSueno);
            VP.ajustes.aplicarAlUI();

            _notificar('Configuración guardada', 'exito');
            log.info('guardarDesdeModal: ajustes guardados correctamente.', { ultra: ultraDespues, ultraCambio: ultraCambio });

        } catch (e) {
            log.error('guardarDesdeModal:', e);
            _notificar('Error al guardar configuración', 'error');
        }
    };

    // ============================================================
    // EXPORTAR CONFIGURACIÓN
    // ============================================================

    VP.ajustes.exportar = function () {
        if (!VP.db || typeof VP.db.exportarDatos !== 'function') {
            log.error('exportar: VP.db.exportarDatos no disponible.');
            _notificar('Error al exportar: base de datos no disponible', 'error');
            return;
        }

        try {
            var datos = VP.db.exportarDatos();
            if (!datos || typeof datos !== 'object') {
                throw new Error('VP.db.exportarDatos retornó un valor inválido.');
            }

            datos._exportMetadata = {
                version:      AJUSTES_VERSION,
                exportadoEn:  new Date().toISOString(),
                totalVideos:  (VP.estado && VP.estado.totalVideos) ? VP.estado.totalVideos : 0,
                userAgent:    navigator.userAgent
            };

            var json = JSON.stringify(datos, null, 2);
            var blob = new Blob([json], { type: 'application/json' });
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');
            a.href     = url;
            a.download = 'videoplayer_config_v' + AJUSTES_VERSION + '_' + Date.now() + '.json';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();

            setTimeout(function () {
                try { util.eliminarElemento(a); } catch (_) {}
                try { if (typeof VP.revocarSeguro === 'function') VP.revocarSeguro(url); else URL.revokeObjectURL(url); } catch (_) {}
            }, 3000);

            _notificar('Configuración exportada correctamente', 'exito');
            log.info('Configuración exportada. Tamaño JSON:', json.length, 'bytes.');

        } catch (e) {
            log.error('exportar:', e);
            _notificar('Error al exportar configuración: ' + e.message, 'error');
        }
    };

    // ============================================================
    // IMPORTAR CONFIGURACIÓN
    // ============================================================

    VP.ajustes.importar = function (archivo) {
        if (!VP.features || !VP.features.fileReader) {
            _notificar('FileReader no disponible en este navegador', 'error');
            log.error('importar: FileReader no soportado.');
            return;
        }

        if (!archivo || !(archivo instanceof File)) {
            _notificar('No se seleccionó un archivo válido', 'error');
            log.warn('importar: archivo inválido:', archivo);
            return;
        }

        if (archivo.type && archivo.type !== 'application/json') {
            var ext = archivo.name ? archivo.name.split('.').pop().toLowerCase() : '';
            if (ext !== 'json') {
                _notificar('El archivo debe ser un JSON (.json)', 'error');
                log.warn('importar: tipo de archivo inválido:', archivo.type, archivo.name);
                return;
            }
        }

        var MAX_TAMANO_BYTES = 10 * 1024 * 1024;
        if (archivo.size > MAX_TAMANO_BYTES) {
            _notificar('El archivo es demasiado grande (máximo 10 MB)', 'error');
            log.warn('importar: archivo demasiado grande:', archivo.size, 'bytes.');
            return;
        }

        if (!VP.db || typeof VP.db.importarDatos !== 'function') {
            _notificar('Error interno: base de datos no disponible', 'error');
            log.error('importar: VP.db.importarDatos no disponible.');
            return;
        }

        var reader = new FileReader();

        reader.onload = function (ev) {
            if (_estado.destruido) return;
            try {
                if (!ev || !ev.target || ev.target.result === undefined) {
                    throw new Error('FileReader: resultado vacío.');
                }

                var datos = util.parsearJSONSeguro
                    ? util.parsearJSONSeguro(ev.target.result, null)
                    : JSON.parse(ev.target.result);
                if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
                    throw new Error('El archivo no contiene un objeto JSON válido.');
                }

                var versionArchivo = datos._version || (datos._exportMetadata && datos._exportMetadata.version) || 1;
                if (versionArchivo > AJUSTES_VERSION) {
                    log.warn('importar: el archivo es de una versión más nueva (' + versionArchivo + ' > ' + AJUSTES_VERSION + ').');
                    _notificar('Advertencia: archivo de versión superior. Algunos ajustes pueden ignorarse.', 'advertencia');
                }

                var ok = VP.db.importarDatos(datos);
                if (!ok) throw new Error('VP.db.importarDatos retornó false.');

                VP.ajustes.guardar(true);
                if (VP.db.guardarProgreso) {
                    try { VP.db.guardarProgreso(); } catch (e) { log.warn('importar: error en guardarProgreso:', e); }
                }

                VP.ajustes.aplicarAlUI();
                if (VP.ajustes.colorAcento) VP.ajustes.aplicarColorAcento(VP.ajustes.colorAcento);

                if (VP.ajustes.ultraRendimiento) {
                    VP.ajustes.activarUltraRendimiento();
                } else {
                    VP.ajustes.desactivarUltraRendimiento();
                }

                _notificar('Configuración importada correctamente', 'exito');
                log.info('Configuración importada desde:', archivo.name, '(' + archivo.size + 'bytes)');
                bus.emit('configuracionImportada', datos);

            } catch (e) {
                log.error('importar (parse/apply):', e);
                _notificar('Error importando: ' + (e.message || 'archivo JSON inválido'), 'error');
            }
        };

        reader.onerror = function (ev) {
            log.error('importar (FileReader.onerror):', ev);
            _notificar('Error al leer el archivo', 'error');
        };

        reader.onabort = function () {
            log.warn('importar: lectura abortada por el usuario.');
        };

        try {
            reader.readAsText(archivo, 'utf-8');
        } catch (e) {
            log.error('importar: error iniciando readAsText:', e);
            _notificar('Error al iniciar la lectura del archivo', 'error');
        }
    };

    // ============================================================
    // TEMAS
    // ============================================================

    VP.ajustes.aplicarTema = function (tema) {
        tema = _validarTema(tema);
        document.body.setAttribute('data-theme', tema);

        var puntos = dom.$$('.theme-dot');
        for (var i = 0; i < puntos.length; i++) {
            var dotVal = puntos[i].dataset && puntos[i].dataset.themeVal;
            puntos[i].classList.toggle('active', dotVal === tema);
        }

        try { util.guardarItem(cfg.claveTema, tema); } catch (e) { log.warn('aplicarTema: error guardando tema:', e); }
        bus.emit('temaAplicado', tema);
        log.debug('Tema aplicado:', tema);
    };

    // ============================================================
    // COLOR DE ACENTO
    // ============================================================

    VP.ajustes.aplicarColorAcento = function (color) {
        if (!_esColorValido(color)) {
            log.warn('aplicarColorAcento: color inválido:', color);
            return;
        }

        color = color.trim();

        try {
            document.documentElement.style.setProperty('--yt-red', color);
            var colorHover = (typeof util.ajustarColor === 'function') ? util.ajustarColor(color, -20) : color;
            document.documentElement.style.setProperty('--yt-red-hover', colorHover);
        } catch (e) {
            log.error('aplicarColorAcento: error aplicando CSS custom properties:', e);
            return;
        }

        if (!dom.esNulo(VP.refs.accentColorPicker)) {
            VP.refs.accentColorPicker.value = color;
        }
        if (!dom.esNulo(VP.refs.centerPlayBtn)) {
            VP.refs.centerPlayBtn.style.boxShadow   = '0 0 28px ' + color + '66';
            VP.refs.centerPlayBtn.style.borderColor = color;
        }

        bus.emit('colorAcentoAplicado', color);
    };

    // ============================================================
    // SCROLL INDEPENDIENTE
    // ============================================================

    VP.ajustes.aplicarScroll = function () {
        var refs = VP.refs;
        if (!refs) return;

        _aplicarScrollSeccion(refs.playlistEl, refs.playlistSection, VP.ajustes.scrollPlaylistIndep, '');
        _aplicarScrollSeccion(refs.galleryEl, refs.gallerySectionWrap, VP.ajustes.scrollGaleriaIndep, '300px');

        if (!dom.esNulo(refs.gallerySectionWrap)) {
            refs.gallerySectionWrap.classList.toggle('gallery-constrained', !VP.ajustes.scrollPlaylistIndep);
        }
    };

    function _aplicarScrollSeccion(contenedor, seccion, activo, maxHeight) {
        if (!dom.esNulo(contenedor)) {
            contenedor.style.overflowY  = activo ? 'auto' : 'visible';
            contenedor.style.maxHeight  = activo ? maxHeight : 'none';
        }
        if (!dom.esNulo(seccion)) {
            seccion.style.overflow = activo ? 'hidden' : 'visible';
        }
    }

    // ============================================================
    // FIJAR REPRODUCTOR
    // ============================================================

    VP.ajustes.fijarReproductorUI = function () {
        document.body.classList.toggle('player-pinned', !!VP.ajustes.fijarReproductor);
    };

    // ============================================================
    // FIJAR ENCABEZADO
    // ============================================================

    VP.ajustes.fijarEncabezadoUI = function () {
        try {
            document.documentElement.style.removeProperty('--header-height');
        } catch (e) {
            log.warn('fijarEncabezadoUI: error reseteando --header-height:', e);
        }
        document.body.classList.toggle('header-pinned', !!VP.ajustes.fijarEncabezado);
    };

    VP.ajustes.actualizarAlturaEncabezado = function () {
        var h = dom.$q('header');
        if (!h) return;

        var altura = 0;
        try {
            var rect = h.getBoundingClientRect();
            altura = rect.height || h.offsetHeight;
        } catch (e) {
            altura = h.offsetHeight || 0;
        }

        var valor = Math.round(altura) + 'px';
        var actual = document.documentElement.style.getPropertyValue('--header-height');
        if (actual === valor) return;

        try {
            document.documentElement.style.setProperty('--header-height', valor);
        } catch (e) {
            log.warn('actualizarAlturaEncabezado: error aplicando CSS:', e);
        }
    };

    // ============================================================
    // TEMPORIZADOR DE SUEÑO
    // ============================================================

    VP.ajustes.aplicarTemporizadorSueno = function (minutos) {
        minutos = _validarTemporizador(minutos);
        if (VP.runtime.sleepTimerInterval) {
            clearInterval(VP.runtime.sleepTimerInterval);
            VP.runtime.sleepTimerInterval = null;
        }
        if (minutos > 0) VP.ajustes.iniciarTemporizadorSueno(minutos);
    };

    VP.ajustes.iniciarTemporizadorSueno = function (minutos) {
        minutos = _validarTemporizador(minutos);
        if (minutos <= 0) {
            log.warn('iniciarTemporizadorSueno: minutos <= 0, ignorando.');
            return;
        }

        if (VP.runtime.sleepTimerInterval) {
            clearInterval(VP.runtime.sleepTimerInterval);
            VP.runtime.sleepTimerInterval = null;
        }

        var restante = Math.floor(minutos * 60);

        VP.runtime.sleepTimerInterval = setInterval(function () {
            if (_estado.destruido) {
                clearInterval(VP.runtime.sleepTimerInterval);
                VP.runtime.sleepTimerInterval = null;
                return;
            }

            restante--;
            if (restante % 30 === 0 && restante > 0) {
                bus.emit('temporizadorSuenoProgreso', { restanteSegs: restante, restanteMins: Math.ceil(restante / 60) });
            }

            if (restante <= 0) {
                clearInterval(VP.runtime.sleepTimerInterval);
                VP.runtime.sleepTimerInterval = null;

                try {
                    if (VP.refs.videoPlayer && !dom.esNulo(VP.refs.videoPlayer)) VP.refs.videoPlayer.pause();
                } catch (e) { log.warn('iniciarTemporizadorSueno: error pausando video:', e); }

                if (!dom.esNulo(VP.refs.sleepTimerInput)) VP.refs.sleepTimerInput.value = 0;

                VP.ajustes.temporizadorSueno = 0;
                VP.ajustes.guardar(true);
                _notificar('Temporizador: reproducción detenida', 'advertencia');
                bus.emit('temporizadorSuenoFin');
                log.info('Temporizador de sueño: reproducción detenida.');
            }
        }, 1000);

        log.info('Temporizador de sueño iniciado:', minutos, 'minutos (', restante, 'segundos).');
        bus.emit('temporizadorSuenoIniciado', { minutos: minutos });
    };

    // ============================================================
    // HDR
    // ============================================================

    VP.ajustes.toggleHDR = function () {
        if (!VP.estado) return;
        VP.estado.hdrActivo = !VP.estado.hdrActivo;
        VP.ajustes.hdr      = VP.estado.hdrActivo;
        _aplicarHDRUI(VP.estado.hdrActivo);
        VP.ajustes.guardar();
        _notificar(VP.estado.hdrActivo ? 'HDR activado' : 'HDR desactivado', 'info');
        bus.emit('hdrCambiado', VP.estado.hdrActivo);
    };

    // ============================================================
    // INICIALIZAR LISTENERS DE TEMAS
    // ============================================================

    VP.ajustes.inicializarTemas = function () {
        _limpiarListenersTemas();

        var puntos = dom.$$('.theme-dot');
        for (var i = 0; i < puntos.length; i++) {
            (function (btn, idx) {
                var timerLP  = null;
                var esLPress = false;

                function iniciarLP(e) {
                    esLPress = false;
                    timerLP  = setTimeout(function () {
                        esLPress = true;
                        if (!dom.esNulo(VP.refs.accentColorPicker)) VP.refs.accentColorPicker.click();
                    }, LONG_PRESS_TIEMPO_MS);
                }

                function cancelarLP() {
                    if (timerLP) { clearTimeout(timerLP); timerLP = null; }
                }

                function alClick(e) {
                    if (esLPress) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        esLPress = false;
                    } else {
                        var temaVal = btn.dataset && btn.dataset.themeVal;
                        if (temaVal) VP.ajustes.aplicarTema(temaVal);
                    }
                }

                btn.addEventListener('mousedown',   iniciarLP);
                btn.addEventListener('mouseup',     cancelarLP);
                btn.addEventListener('mouseleave',  cancelarLP);
                btn.addEventListener('touchstart',  iniciarLP,   { passive: true });
                btn.addEventListener('touchend',    cancelarLP);
                btn.addEventListener('touchcancel', cancelarLP);
                btn.addEventListener('click',       alClick);

                _estado.cleanupsTemas[idx] = function () {
                    cancelarLP();
                    btn.removeEventListener('mousedown',   iniciarLP);
                    btn.removeEventListener('mouseup',     cancelarLP);
                    btn.removeEventListener('mouseleave',  cancelarLP);
                    btn.removeEventListener('touchstart',  iniciarLP);
                    btn.removeEventListener('touchend',    cancelarLP);
                    btn.removeEventListener('touchcancel', cancelarLP);
                    btn.removeEventListener('click',       alClick);
                };
            })(puntos[i], i);
        }
        log.debug('Listeners de temas inicializados. Botones:', puntos.length);
    };

    function _limpiarListenersTemas() {
        for (var idx in _estado.cleanupsTemas) {
            if (_estado.cleanupsTemas.hasOwnProperty(idx)) {
                try { _estado.cleanupsTemas[idx](); } catch (e) { log.warn('_limpiarListenersTemas: error en cleanup idx=' + idx, e); }
            }
        }
        _estado.cleanupsTemas = {};
    }

    // ============================================================
    // INICIALIZAR LISTENERS DEL MODAL
    // ============================================================

    VP.ajustes.inicializarModal = function () {
        if (_estado.inicializado) {
            log.warn('inicializarModal: ya inicializado. Omitiendo.');
            return;
        }

        var refs = VP.refs;
        if (!refs) {
            log.error('inicializarModal: VP.refs no disponible.');
            return;
        }

        _addListener(refs.settingsBtn, 'click', function () {
            try { dom.abrirModal(refs.settingsBtn); } catch (e) { log.error('settingsBtn click:', e); }
        });
        _addListener(refs.modalClose, 'click', function () {
            try { dom.cerrarModal(); } catch (e) { log.error('modalClose click:', e); }
        });
        _addListener(refs.settingsModal, 'click', function (e) {
            if (e.target === refs.settingsModal) try { dom.cerrarModal(); } catch (_) {}
        });
        _addListener(refs.settingsModal, 'cancel', function (e) {
            e.preventDefault(); try { dom.cerrarModal(); } catch (_) {}
        });
        _addListener(refs.saveSettingsBtn, 'click', function () {
            VP.ajustes.guardarDesdeModal();
        });
        _addListener(refs.clearCacheBtn, 'click', function () {
            if (!VP.db || typeof VP.db.limpiarCacheCompleta !== 'function') {
                log.warn('clearCacheBtn: VP.db.limpiarCacheCompleta no disponible.');
                return;
            }
            try { VP.db.limpiarCacheCompleta(); } catch (e) { log.error('clearCacheBtn click:', e); _notificar('Error al limpiar la caché', 'error'); }
        });
        _addListener(refs.sleepTimerInput, 'change', function () {
            var m = _validarTemporizador(refs.sleepTimerInput.value);
            refs.sleepTimerInput.value   = m;
            VP.ajustes.temporizadorSueno = m;
            VP.ajustes.guardar();
            VP.ajustes.aplicarTemporizadorSueno(m);
            _notificar(m > 0 ? 'Temporizador: ' + m + ' min' : 'Temporizador desactivado', 'info');
        });
        _addListener(refs.ultraPerfChk, 'change', function () {
            var activo = !!refs.ultraPerfChk.checked;
            VP.ajustes.ultraRendimiento = activo;
            VP.ajustes.toggleUltraRendimiento(activo);
            VP.ajustes.guardar();
            _notificar(activo ? 'Ultra Rendimiento activado' : 'Ultra Rendimiento desactivado', activo ? 'advertencia' : 'info');
        });

        var _timerAcento = null;
        _addListener(refs.accentColorPicker, 'input', function () {
            var color = refs.accentColorPicker.value;
            VP.ajustes.aplicarColorAcento(color);
            clearTimeout(_timerAcento);
            _timerAcento = setTimeout(function () {
                if (_esColorValido(color)) {
                    VP.ajustes.colorAcento = color;
                    VP.ajustes.guardar();
                }
            }, 300);
        });
        bus.once('_destruirModuloAjustes', function () { clearTimeout(_timerAcento); });

        _addListener(refs.hdrBtn, 'click', function () { VP.ajustes.toggleHDR(); });
        _addListener(refs.exportConfigBtn, 'click', function () { VP.ajustes.exportar(); });
        _addListener(refs.importConfigBtn, 'click', function () {
            if (!dom.esNulo(refs.importConfigInput)) refs.importConfigInput.click();
        });
        _addListener(refs.importConfigInput, 'change', function (e) {
            var archivo = e.target && e.target.files ? e.target.files[0] : null;
            if (archivo) VP.ajustes.importar(archivo);
            try { refs.importConfigInput.value = ''; } catch (_) {}
        });

        _estado.inicializado = true;
        log.debug('Listeners del modal de ajustes inicializados.');
    };

    function _addListener(el, evento, handler, opciones) {
        if (dom.esNulo(el)) return;
        try { el.addEventListener(evento, handler, opciones || false); } catch (e) { log.warn('_addListener: error añadiendo listener "' + evento + '":', e); }
    }

    // ============================================================
    // INICIALIZAR LISTENERS DE RESIZE PARA ENCABEZADO
    // ============================================================

    VP.ajustes.inicializarResizeEncabezado = function () {
        var handlerResize = util.debounce(function () {
            if (VP.ajustes.fijarEncabezado) VP.ajustes.actualizarAlturaEncabezado();
        }, DEBOUNCE_RESIZE_MS);

        window.addEventListener('resize', handlerResize);
        VP.ajustes._handlerResize = handlerResize;

        if (VP.features && VP.features.resizeObserver) {
            var elEncabezado = dom.$q('header');
            if (elEncabezado) {
                try {
                    _estado.resizeObsEncabezado = new ResizeObserver(
                        util.debounce(function () {
                            if (_estado.destruido) return;
                            if (!VP.ajustes.fijarEncabezado) return;
                            VP.ajustes.actualizarAlturaEncabezado();
                        }, DEBOUNCE_RESIZE_MS)
                    );
                    _estado.resizeObsEncabezado.observe(elEncabezado);
                    log.debug('ResizeObserver del encabezado inicializado.');
                } catch (e) {
                    log.warn('inicializarResizeEncabezado: error creando ResizeObserver:', e);
                }
            }
        }
        log.debug('Listener de resize de encabezado inicializado.');
    };

    // ============================================================
    // APLICAR TODOS LOS AJUSTES DE LAYOUT
    // ============================================================

    VP.ajustes.aplicarLayout = function () {
        try {
            VP.ajustes.aplicarScroll();
            VP.ajustes.fijarReproductorUI();
            VP.ajustes.fijarEncabezadoUI();
            if (VP.ajustes.colorAcento) VP.ajustes.aplicarColorAcento(VP.ajustes.colorAcento);
        } catch (e) { log.error('aplicarLayout:', e); }
    };

    // ============================================================
    // DESTRUIR MÓDULO (limpieza de memoria)
    // ============================================================

    VP.ajustes.destruir = function () {
        _estado.destruido = true;

        if (_estado.timerGuardar) {
            clearTimeout(_estado.timerGuardar);
            _estado.timerGuardar = null;
            VP.ajustes._guardarInmediato();
        }

        if (VP.runtime && VP.runtime.sleepTimerInterval) {
            clearInterval(VP.runtime.sleepTimerInterval);
            VP.runtime.sleepTimerInterval = null;
        }

        if (_estado.resizeObsEncabezado) {
            try { _estado.resizeObsEncabezado.disconnect(); } catch (e) {}
            _estado.resizeObsEncabezado = null;
        }

        if (VP.ajustes._handlerResize) {
            window.removeEventListener('resize', VP.ajustes._handlerResize);
            VP.ajustes._handlerResize = null;
        }

        _limpiarListenersTemas();

        // Limpiar listeners del bus (nuevo en v2.1)
        bus.off('cacheVaciada',          _busCallbacks.cacheVaciada);
        bus.off('solicitarTema',         _busCallbacks.solicitarTema);
        bus.off('solicitarAplicarAjustes', _busCallbacks.solicitarAplicarAjustes);
        bus.off('totalVideosActualizado', _busCallbacks.totalVideosActualizado);

        bus.emit('_destruirModuloAjustes');
        log.info('vp-ajustes.js: módulo destruido y recursos liberados.');
    };

    // ============================================================
    // HELPER DE NOTIFICACIONES
    // ============================================================

    function _notificar(mensaje, tipo) {
        try {
            if (VP.ui && typeof VP.ui.mostrarNotificacion === 'function') {
                VP.ui.mostrarNotificacion(mensaje, tipo || 'info');
            } else {
                log.debug('[Notificación]', tipo, '→', mensaje);
            }
        } catch (e) { log.warn('_notificar: error mostrando notificación:', e); }
    }

    // ============================================================
    // VERIFICACIÓN DE MÓDULO
    // ============================================================

    (function _verificarModulo() {
        var requeridos = [
            'cargar', '_guardarInmediato', 'guardar', 'aplicarAlUI', 'leerDesdeUI',
            'guardarDesdeModal', 'exportar', 'importar', 'aplicarTema',
            'aplicarColorAcento', 'aplicarScroll', 'fijarReproductorUI',
            'fijarEncabezadoUI', 'actualizarAlturaEncabezado',
            'aplicarTemporizadorSueno', 'iniciarTemporizadorSueno',
            'toggleHDR', 'activarUltraRendimiento', 'desactivarUltraRendimiento',
            'toggleUltraRendimiento', '_aplicarUIUltraRendimiento',
            'verificarRendimientoAdaptativo', 'inicializarTemas',
            'inicializarModal', 'inicializarResizeEncabezado',
            'aplicarLayout', 'destruir'
        ];

        var faltantes = [];
        for (var i = 0; i < requeridos.length; i++) {
            if (typeof VP.ajustes[requeridos[i]] !== 'function') faltantes.push(requeridos[i]);
        }
        if (faltantes.length > 0) {
            log.error('vp-ajustes.js: funciones requeridas faltantes →', faltantes.join(', '));
        } else {
            log.debug('vp-ajustes.js: verificación de módulo OK. (' + requeridos.length + ' funciones)');
        }
    })();

    // ============================================================
    // LISTENERS DEL BUS (referencias guardadas para limpieza)
    // ============================================================

    var _busCallbacks = {
        cacheVaciada: function () {
            bus.emit('renderGaleria');
            bus.emit('renderPlaylist');
        },
        solicitarTema: function (tema) {
            VP.ajustes.aplicarTema(tema);
        },
        solicitarAplicarAjustes: function () {
            VP.ajustes.aplicarAlUI();
            VP.ajustes.aplicarLayout();
        },
        totalVideosActualizado: function (total) {
            if (total > 500 && !VP.ajustes.ultraRendimiento) {
                log.info('totalVideosActualizado: ' + total + ' videos detectados. Considera activar Ultra Rendimiento.');
                bus.emit('sugerirUltraRendimiento', { total: total });
            }
        }
    };

    bus.on('cacheVaciada',          _busCallbacks.cacheVaciada);
    bus.on('solicitarTema',         _busCallbacks.solicitarTema);
    bus.on('solicitarAplicarAjustes', _busCallbacks.solicitarAplicarAjustes);
    bus.on('totalVideosActualizado', _busCallbacks.totalVideosActualizado);

    // ============================================================
    // LOG DE CARGA
    // ============================================================

    log.info('vp-ajustes.js v2.1 cargado correctamente.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-ajustes.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
