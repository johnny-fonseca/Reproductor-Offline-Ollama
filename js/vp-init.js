'use strict';

// ============================================================
// VP-INIT.JS  —  v2.0  (optimizado para 500+ vídeos)
// Punto de entrada principal del reproductor.
// Coordina la inicialización de todos los módulos en el
// orden correcto y expone las herramientas de diagnóstico.
// Debe cargarse ÚLTIMO, después de todos los demás módulos.
// ============================================================

(function (window, document) {

    // ============================================================
    // 0. GUARDIA DE CARGA MÚLTIPLE
    //    Evita que el IIFE se ejecute dos veces si el script
    //    se incluyó accidentalmente más de una vez.
    // ============================================================
    if (window.__VP_INIT_LOADED__) {
        VP.log.warn('vp-init.js ya fue cargado. Ignorando ejecución duplicada.');
        return;
    }
    window.__VP_INIT_LOADED__ = true;

    // ============================================================
    // 1. VALIDACIÓN TEMPRANA DE VP BASE
    // ============================================================
    var VP = window.VP;
    if (!VP || typeof VP !== 'object') {
        throw new Error(
            '[VP] vp-init.js: window.VP no existe. ' +
            'Asegúrate de que vp-base.js se cargue primero.'
        );
    }

    // Aliases locales — acceso O(1) evita búsqueda de propiedad repetida
    // en bucles críticos sobre 500+ vídeos.
    var util   = VP.util;
    var dom    = VP.dom;
    var log    = VP.log;
    var bus    = VP.bus;
    var cfg    = VP.config;
    var rt     = VP.runtime;   // alias corto para runtime
    var estado = VP.estado;    // alias corto para estado
    log.setContext('Init');

    // ============================================================
    // 2. CONSTANTES INTERNAS
    // ============================================================
    var SHORTCUTS_SHOW_DELAY_MS  = 1200;
    var SHORTCUTS_HIDE_DELAY_MS  = 6000;
    var MEMORY_LOG_DELAY_MS      = 3000;
    var INIT_TIMEOUT_MS          = 15000;  // Abortar init si tarda > 15 s
    var BATCH_RENDER_SIZE        = 50;     // Vídeos por lote en renderizado
    var IDLE_CLEANUP_DELAY_MS    = 2000;   // Delay para limpieza en idle
    var MAX_DIAG_LOG_LINES       = 50;     // Líneas en diagnóstico (era 20)
    var WATCHDOG_GRACE_MS        = 500;    // Tiempo antes de watchdog

    // ============================================================
    // 3. ESTADO INTERNO DE INIT
    //    Centraliza flags de la secuencia de arranque para
    //    facilitar diagnóstico y recuperación.
    // ============================================================
    var initState = {
        fase:              'idle',     // idle | starting | db | ready | error
        t0:                0,
        timeoutHandle:     null,
        pasosCompletados:  [],
        erroresParciales:  [],
        reintentosDB:      0,
        maxReintentosDB:   2,
        batchRenderPending: false,
    };

    // ============================================================
    // 4. HERRAMIENTAS DE DIAGNÓSTICO (expuestas en window)
    //    Optimizadas para no bloquear el hilo principal.
    // ============================================================

    /**
     * Diagnóstico completo del estado del reproductor.
     * Seguro de llamar en cualquier momento, incluso antes de init.
     */
    window.__vpDiag = function () {
        try {
            return {
                version:            VP.version,
                inicializado:       rt.inicializado,
                initFase:           initState.fase,
                initMs:             initState.t0
                    ? Math.round(util.ahora() - initState.t0)
                    : null,
                pasosCompletados:   initState.pasosCompletados.slice(),
                erroresParciales:   initState.erroresParciales.slice(),
                erroresRuntime:     VP.metricas.errores,
                videos:             estado.videos.length,
                playlist:           estado.playlist.length,
                indiceActual:       estado.currentVideoIndex,
                progreso:           estado.videoProgress
                    ? estado.videoProgress.length : 0,
                playGeneration:     rt.playGeneration,
                poolBlobs:          VP.cache.poolBlobURLs
                    ? VP.cache.poolBlobURLs.length : 0,
                colaMiniaturas:     rt.colaMiniaturas
                    ? rt.colaMiniaturas.length : 0,
                colaDuracion:       rt.colaDuracion
                    ? rt.colaDuracion.length : 0,
                estadoCarga:        rt.estadoCarga,
                guards:             rt.guards,
                idb: {
                    listo:          rt.idb.listo,
                    fallido:        rt.idb.fallido,
                    reintentosInit: initState.reintentosDB,
                },
                ajustes:            VP.ajustes,
                ultraActivo:        VP.ajustes ? VP.ajustes.ultraRendimiento : false,
                metricas:           VP.metricas,
                salud:              typeof VP.obtenerSalud === 'function'
                    ? VP.obtenerSalud()
                    : null,
                modulos:            VP.modulos || {},
                bootstrap:          window.__vpBootstrapReport || null,
                dialogo:            rt.dialogoNativo
                    ? 'nativo <dialog>'
                    : 'div + clase CSS',
                eventosActivos:     bus ? bus.listarEventos() : [],
                batchRenderSize:    BATCH_RENDER_SIZE,
                logReciente:        log
                    ? log.volcar().slice(-MAX_DIAG_LOG_LINES)
                    : [],
            };
        } catch (e) {
            return { error: '[__vpDiag] Falló: ' + e.message };
        }
    };

    /**
     * Diagnóstico de memoria detallado.
     * Para 500+ vídeos incluye conteos por estado de miniatura.
     */
    window.__vpMemoria = function () {
        var info = {
            blobURLs:             0,
            videosEnMemoria:      0,
            playlist:             0,
            miniaturasEnMem:      0,
            arraysMinis:          0,
            videosSinMiniatura:   0,
            videosConProgreso:    0,
        };

        try {
            info.blobURLs        = VP.cache.poolBlobURLs
                ? VP.cache.poolBlobURLs.length : 0;
            info.videosEnMemoria = estado.videos.length;
            info.playlist        = estado.playlist.length;

            // Un solo bucle sobre todos los vídeos — O(n)
            var vids = estado.videos;
            var len  = vids.length;
            for (var i = 0; i < len; i++) {
                var v = vids[i];
                if (!v) continue;
                if (v.thumbnail)      info.miniaturasEnMem++;
                if (v.thumbnailArray) info.arraysMinis++;
                if (!v.thumbnail && !v.thumbnailArray)
                    info.videosSinMiniatura++;
            }

            // Progreso guardado
            if (estado.videoProgress) {
                info.videosConProgreso = estado.videoProgress.length;
            }

            // API de memoria de Chrome (no estándar)
            if (VP.features.performanceMemory &&
                performance.memory) {
                info.heapUsado =
                    (performance.memory.usedJSHeapSize / 1048576)
                        .toFixed(2) + ' MB';
                info.heapTotal =
                    (performance.memory.totalJSHeapSize / 1048576)
                        .toFixed(2) + ' MB';
                info.heapLimite =
                    (performance.memory.jsHeapSizeLimit / 1048576)
                        .toFixed(2) + ' MB';
            }
        } catch (e) {
            info.error = '[__vpMemoria] Falló: ' + e.message;
        }

        return info;
    };

    /** Historial de reproducción completo (copia defensiva). */
    window.__vpHistorial = function () {
        try {
            return Array.isArray(estado.historialReproduccion)
                ? estado.historialReproduccion.slice()
                : [];
        } catch (e) {
            return [];
        }
    };

    /**
     * Volcado de log filtrable por nivel y/o texto.
     * @param {string} [nivel]  'INFO'|'WARN'|'ERROR'|'DEBUG'
     * @param {string} [texto]  Subcadena a buscar (case-insensitive)
     */
    window.__vpLog = function (nivel, texto) {
        try {
            var buffer = log ? log.volcar() : [];
            if (nivel) {
                var nivelUp = nivel.toUpperCase();
                buffer = buffer.filter(function (e) {
                    return e.nivel === nivelUp;
                });
            }
            if (texto) {
                var textoLow = texto.toLowerCase();
                buffer = buffer.filter(function (e) {
                    return e.mensaje &&
                        e.mensaje.toLowerCase().indexOf(textoLow) !== -1;
                });
            }
            return buffer;
        } catch (e) {
            return [];
        }
    };

    /**
     * Fuerza limpieza de recursos (blobs, miniaturas huérfanas, etc.)
     * Diseñado para correr en segundo plano vía requestIdleCallback.
     */
    window.__vpForceCleanup = function () {
        try {
            if (VP.carga && typeof VP.carga.limpiezaForzada === 'function') {
                VP.carga.limpiezaForzada();
                log.info('[__vpForceCleanup] Limpieza ejecutada manualmente.');
            } else {
                log.warn('VP.carga.limpiezaForzada no disponible.');
            }
        } catch (e) {
            log.error('Error en __vpForceCleanup:', e);
        }
    };

    /**
     * Estadísticas de rendimiento del renderizado de listas.
     * Útil para detectar cuellos de botella con 500+ vídeos.
     */
    window.__vpRenderStats = function () {
        try {
            return {
                totalVideos:     estado.videos.length,
                batchSize:       BATCH_RENDER_SIZE,
                batchesNeeded:   Math.ceil(
                    estado.videos.length / BATCH_RENDER_SIZE
                ),
                metricas:        VP.metricas,
                initFase:        initState.fase,
                pasosMs: {
                    dbInit:  VP.metricas.dbInitMs  || null,
                    total:   VP.metricas.initTotalMs || null,
                },
            };
        } catch (e) {
            return { error: e.message };
        }
    };

    /** Fuerza re-renderizado de galería y playlist (útil tras cambios masivos). */
    window.__vpForceRender = function () {
        try {
            if (!rt.inicializado) {
                log.warn('No inicializado aún. Espera a que termine init.');
                return false;
            }
            _renderizarListasEnLotes(function () {
                log.info('Re-renderizado completo.');
            });
            return true;
        } catch (e) {
            log.error('Error en __vpForceRender:', e);
            return false;
        }
    };

    /**
     * Benchmark de rendimiento con N videos falsos.
     * Genera datos sintéticos, los inyecta y mide el render.
     * @param {number} [cantidad=500]  Número de videos a generar
     * @param {boolean} [silencioso=false]  Omitir logs detallados
     * @returns {{ok:boolean, datos:object}|{ok:boolean, error:string}}
     *
     * Uso: __vpBenchmark()         → 500 videos
     *      __vpBenchmark(1000)     → 1000 videos
     *      __vpBenchmark(500, true) → sin logs
     */
    window.__vpBenchmark = function (cantidad, silencioso) {
        if (typeof VP.listas === 'undefined' || !rt.inicializado) {
            return { ok: false, error: 'Reproductor no inicializado todavia.' };
        }

        cantidad = (typeof cantidad === 'number' && cantidad > 0)
            ? Math.floor(cantidad) : 500;
        var logOk = silencioso ? function () {} : log.info;

        // 1. Generar datos falsos
        logOk('[BENCH] Generando ' + cantidad + ' videos falsos...');
        var tGen = util.ahora();
        var videos = [];
        var t0 = Date.now();
        for (var i = 0; i < cantidad; i++) {
            videos.push({
                id:              'bench_' + i + '_' + t0,
                name:            'Video de prueba #' + (i + 1) + '.mp4',
                file:            null,
                size:            1024 * 1024 * (1 + (i % 100)),
                duration:        60 + (i % 300),
                thumbnail:       null,
                thumbnailArray:  null,
                subtitleFile:    null,
                subtitleName:    null,
                cargadoEn:       t0 + i,
                errores:         0,
            });
        }
        var elapsedGen = util.ahora() - tGen;
        logOk('[BENCH] Generacion: ' + Math.round(elapsedGen) + 'ms');

        // 2. Inyectar en estado
        VP.estado.videos   = videos;
        VP.estado.playlist = videos.slice();
        VP.estado.currentVideoIndex = 0;

        // 3. Forzar render con metricas
        var tRender    = util.ahora();
        var nodosAntes = document.querySelectorAll('*').length;

        try {
            VP.listas.renderizarGaleria();
            VP.listas.renderizarPlaylist();
        } catch (e) {
            return { ok: false, error: 'Render fallo: ' + e.message };
        }

        var elapsedRender = util.ahora() - tRender;
        var nodosDespues  = document.querySelectorAll('*').length;
        var metricas      = VP.listas.obtenerMetricas
            ? VP.listas.obtenerMetricas() : {};

        var resultado = {
            ok:              true,
            cantidad:        cantidad,
            generacionMs:    Math.round(elapsedGen),
            renderMs:        Math.round(elapsedRender),
            nodosDOMAntes:   nodosAntes,
            nodosDOMDespues: nodosDespues,
            nodosCreados:    nodosDespues - nodosAntes,
            metricas:        metricas,
        };

        logOk('[BENCH] Render: ' + resultado.renderMs + 'ms' +
            ' | Nodos DOM: ' + resultado.nodosCreados +
            ' | Pool hits: ' + (metricas.reciclajes || 0));

        return resultado;
    };

    // Versión como propiedad simple de solo lectura
    try {
        Object.defineProperty(window, '__vpVersion', {
            get: function () { return VP.version; },
            configurable: true,
        });
    } catch (e) {
        window.__vpVersion = VP.version;
    }

    // ============================================================
    // 5. VERIFICACIÓN DE DEPENDENCIAS
    //    Detecta módulos faltantes con mensajes de diagnóstico
    //    claros para facilitar el debugging.
    // ============================================================

    /** @type {Array<{nombre:string, obj:*, critico:boolean}>} */
    var MODULOS_REQUERIDOS = [
        { nombre: 'VP.util',        obj: function () { return VP.util; },        critico: true,
            metodos: ['ahora', 'programarIdle', 'obtenerItem', 'storageSet'] },
        { nombre: 'VP.dom',         obj: function () { return VP.dom; },         critico: true,
            metodos: ['cachearRefs', 'esNulo'] },
        { nombre: 'VP.bus',         obj: function () { return VP.bus; },         critico: true,
            metodos: ['on', 'emit', 'off'] },
        { nombre: 'VP.log',         obj: function () { return VP.log; },         critico: true,
            metodos: ['info', 'warn', 'error', 'volcar'] },
        { nombre: 'VP.db',          obj: function () { return VP.db; },          critico: true,
            metodos: ['inicializar', 'cargarProgreso'] },
        { nombre: 'VP.ajustes',     obj: function () { return VP.ajustes; },     critico: true,
            metodos: ['cargar', 'aplicarAlUI', 'aplicarTema'] },
        { nombre: 'VP.listas',      obj: function () { return VP.listas; },      critico: true,
            metodos: ['renderizarGaleria', 'renderizarPlaylist'] },
        { nombre: 'VP.carga',       obj: function () { return VP.carga; },       critico: true  },
        { nombre: 'VP.reproductor', obj: function () { return VP.reproductor; }, critico: true,
            metodos: ['actualizarUIVolumen'] },
        { nombre: 'VP.eventos',     obj: function () { return VP.eventos; },     critico: true,
            metodos: ['inicializar'] },
        { nombre: 'VP.subtitulos',  obj: function () { return VP.subtitulos; },  critico: false },
        { nombre: 'VP.miniaturas',  obj: function () { return VP.miniaturas; },  critico: false },
        { nombre: 'VP.cache',       obj: function () { return VP.cache; },       critico: false },
        { nombre: 'VP.metricas',    obj: function () { return VP.metricas; },    critico: false },
    ];

    /**
     * Verifica que todos los módulos necesarios estén cargados.
     * @returns {{ok:boolean, faltanCriticos:string[], faltanOpcionales:string[]}}
     */
    function verificarDependencias() {
        var faltanCriticos   = [];
        var faltanOpcionales = [];
        var incompletos      = [];

        for (var i = 0; i < MODULOS_REQUERIDOS.length; i++) {
            var m   = MODULOS_REQUERIDOS[i];
            var obj;
            try {
                obj = m.obj();
            } catch (e) {
                obj = null;
            }

            if (!obj || typeof obj !== 'object') {
                if (m.critico) {
                    faltanCriticos.push(m.nombre);
                } else {
                    faltanOpcionales.push(m.nombre);
                }
                continue;
            }

            if (Array.isArray(m.metodos)) {
                var faltanMetodos = [];
                for (var mi = 0; mi < m.metodos.length; mi++) {
                    if (typeof obj[m.metodos[mi]] !== 'function') {
                        faltanMetodos.push(m.metodos[mi]);
                    }
                }
                if (faltanMetodos.length > 0) {
                    incompletos.push(m.nombre + '.' + faltanMetodos.join('|'));
                    if (m.critico) faltanCriticos.push(m.nombre + ' incompleto');
                }
            }
        }

        if (faltanOpcionales.length > 0) {
            log.warn(
                'Módulos opcionales no cargados: ' +
                faltanOpcionales.join(', ') +
                '. Algunas funciones no estarán disponibles.'
            );
        }

        return {
            ok:               faltanCriticos.length === 0,
            faltanCriticos:   faltanCriticos,
            faltanOpcionales: faltanOpcionales,
            incompletos:      incompletos,
        };
    }

    // ============================================================
    // 6. SISTEMA DE NOTIFICACIONES MÍNIMO (fallback)
    //    Si vp-eventos.js no definió VP.ui, creamos un stub
    //    para poder mostrar errores durante la secuencia de init.
    // ============================================================

    function garantizarUI() {
        VP.ui = VP.ui || {};

        if (typeof VP.ui.mostrarNotificacion !== 'function') {
            VP.ui.mostrarNotificacion = function (msg, tipo) {
                var prefijo = '[VP notif][' + (tipo || 'info').toUpperCase() + '] ';
                if (tipo === 'error') {
                    console.error(prefijo + msg);
                } else if (tipo === 'warn' || tipo === 'warning') {
                    console.warn(prefijo + msg);
                } else {
                    console.log(prefijo + msg);
                }
            };
        }

        if (typeof VP.ui.ocultarNotificacion !== 'function') {
            VP.ui.ocultarNotificacion = function () {};
        }

        if (typeof VP.ui.actualizarProgresoCarga !== 'function') {
            // Para 500+ vídeos, este callback muestra el progreso de carga masiva
            VP.ui.actualizarProgresoCarga = function (actual, total) {
                if (total > 0 && actual % 50 === 0) {
                    console.log(
                        '[VP] Cargando vídeos: ' + actual + '/' + total +
                        ' (' + Math.round((actual / total) * 100) + '%)'
                    );
                }
            };
        }

        rt.notifListo = true;
    }

    // ============================================================
    // 7. RENDERIZADO EN LOTES
    //    Para 500+ vídeos, renderizar todo en un ciclo bloquea
    //    el hilo principal. Dividimos en lotes usando
    //    requestAnimationFrame / setTimeout como fallback.
    // ============================================================

    /**
     * Renderiza galería y playlist de forma no bloqueante.
     * Usa lotes de BATCH_RENDER_SIZE vídeos por frame.
     * @param {Function} [callback]  Se llama cuando termina todo.
     */
    function _renderizarListasEnLotes(callback) {
        if (initState.batchRenderPending) {
            // Ya hay un render en curso — encolar el callback
            if (typeof callback === 'function') {
                bus.once('batchRenderComplete', callback);
            }
            return;
        }

        initState.batchRenderPending = true;
        var t0render = util.ahora();

        // Si hay pocos vídeos, render síncrono directo
        if (estado.videos.length <= BATCH_RENDER_SIZE) {
            try {
                VP.listas.renderizarGaleria();
                VP.listas.renderizarPlaylist();
            } catch (e) {
                log.error('renderizado síncrono falló:', e);
            }
            initState.batchRenderPending = false;
            VP.metricas.renderMs = Math.round(util.ahora() - t0render);
            bus.emit('batchRenderComplete');
            if (typeof callback === 'function') callback();
            return;
        }

        // Para 500+ vídeos: renderizado asíncrono por lotes
        log.info(
            'Renderizando ' + estado.videos.length +
            ' vídeos en lotes de ' + BATCH_RENDER_SIZE + '…'
        );

        var total    = estado.videos.length;
        var loteActual = 0;

        function procesarLote() {
            var inicio = loteActual * BATCH_RENDER_SIZE;
            var fin    = Math.min(inicio + BATCH_RENDER_SIZE, total);

            try {
                // Los módulos listas deben soportar renderizado parcial.
                // Si el módulo soporta rango, lo usamos.
                if (typeof VP.listas.renderizarGaleriaRango === 'function') {
                    VP.listas.renderizarGaleriaRango(inicio, fin);
                } else if (loteActual === 0) {
                    // Fallback: render completo en primer lote
                    VP.listas.renderizarGaleria();
                    VP.listas.renderizarPlaylist();
                    // Marcar como hecho y salir
                    initState.batchRenderPending = false;
                    VP.metricas.renderMs = Math.round(util.ahora() - t0render);
                    bus.emit('batchRenderComplete');
                    if (typeof callback === 'function') callback();
                    return;
                }

                // Actualizar UI de progreso
                if (VP.ui && typeof VP.ui.actualizarProgresoCarga === 'function') {
                    VP.ui.actualizarProgresoCarga(fin, total);
                }
            } catch (e) {
                log.error(
                    'Error en lote ' + loteActual + ' (' +
                    inicio + '-' + fin + '):', e
                );
                initState.erroresParciales.push({
                    fase:  'renderLote_' + loteActual,
                    error: e.message,
                    ts:    util.ahora(),
                });
            }

            loteActual++;

            if (fin < total) {
                // Siguiente lote en el próximo frame libre
                if (window.requestAnimationFrame) {
                    requestAnimationFrame(procesarLote);
                } else {
                    setTimeout(procesarLote, 0);
                }
            } else {
                // Todos los lotes completados
                initState.batchRenderPending = false;
                VP.metricas.renderMs = Math.round(util.ahora() - t0render);

                log.info(
                    'Renderizado completo: ' + total +
                    ' vídeos en ' + VP.metricas.renderMs + ' ms'
                );

                // Renderizar playlist completa al final
                try {
                    VP.listas.renderizarPlaylist();
                } catch (e) {
                    log.warn('renderizarPlaylist falló:', e);
                }

                bus.emit('batchRenderComplete');
                if (typeof callback === 'function') callback();
            }
        }

        // Arrancar primer lote en el siguiente frame
        // para no bloquear el pintado inicial de la página
        if (window.requestAnimationFrame) {
            requestAnimationFrame(procesarLote);
        } else {
            setTimeout(procesarLote, 0);
        }
    }

    // ============================================================
    // 8. RECUPERACIÓN MÍNIMA TRAS ERROR CRÍTICO
    // ============================================================

    /**
     * Intenta dejar el reproductor en un estado mínimo usable
     * cuando la secuencia de init falla parcialmente.
     */
    function recuperacionMinima() {
        log.warn('Ejecutando recuperación mínima tras error de init…');
        initState.fase = 'error';

        try {
            // Re-cachear refs si se perdieron
            if (!VP.refs.videoPlayer || VP.refs.videoPlayer.__isNullElement) {
                dom.cachearRefs();
            }
        } catch (e) {
            log.error('cachearRefs en recuperación falló:', e);
        }

        try {
            // Al menos intentar mostrar la galería
            if (VP.listas) {
                VP.listas.renderizarGaleria();
                VP.listas.renderizarPlaylist();
            }
        } catch (e) {
            log.error('renderizado en recuperación falló:', e);
        }

        try {
            // Marcar como inicializado parcialmente
            rt.inicializado   = true;
            rt.inicializadoParcial = true;
        } catch (e) {
            log.error('No se pudo marcar inicializado:', e);
        }

        log.warn(
            'Recuperación mínima completada. ' +
            'Algunas funciones pueden no estar disponibles. ' +
            'Llama __vpDiag() para más información.'
        );

        // Avisar a otros módulos
        try { bus.emit('initializedPartial'); } catch (e) { /* ignore */ }
    }

    // ============================================================
    // 9. PASOS DE INICIALIZACIÓN (funciones independientes)
    //    Separar cada paso en su propia función mejora:
    //    - Trazabilidad de errores
    //    - Posibilidad de re-ejecutar pasos individuales
    //    - Legibilidad del flujo principal
    // ============================================================

    function _marcarPaso(nombre) {
        initState.pasosCompletados.push({
            paso: nombre,
            ms:   Math.round(util.ahora() - initState.t0),
        });
        log.debug('Init paso OK: ' + nombre);
    }

    function _registrarErrorParcial(paso, error) {
        initState.erroresParciales.push({
            fase:  paso,
            error: error ? error.message || String(error) : 'desconocido',
            ts:    util.ahora(),
        });
        log.warn('Error parcial en paso "' + paso + '":', error);
    }

    // --- Paso: cachear refs DOM ---
    function _pasoCachearRefs() {
        dom.cachearRefs();
        _marcarPaso('cachearRefs');
    }

    // --- Paso: verificar elemento principal ---
    function _pasoVerificarVideoPlayer() {
        if (dom.esNulo(VP.refs.videoPlayer)) {
            throw new Error(
                '#videoPlayer no encontrado en el DOM. ' +
                'Verifica tu HTML antes de continuar.'
            );
        }
        _marcarPaso('verificarVideoPlayer');
    }

    function _pasoDiagnosticoArranque() {
        var reporte = {
            duplicadosScript: [],
            idsCriticosFaltantes: [],
            scriptsJS: 0,
            timestamp: Date.now()
        };

        try {
            var vistos = Object.create(null);
            var scripts = document.querySelectorAll('script[src]');
            reporte.scriptsJS = scripts.length;
            for (var i = 0; i < scripts.length; i++) {
                var src = scripts[i].getAttribute('src') || '';
                if (src.indexOf('js/') === -1) continue;
                if (vistos[src]) reporte.duplicadosScript.push(src);
                vistos[src] = true;
            }
        } catch (e) {
            _registrarErrorParcial('diagnosticoScripts', e);
        }

        var idsCriticos = ['videoPlayer', 'gallery', 'playlistEl', 'fileInput'];
        for (var j = 0; j < idsCriticos.length; j++) {
            if (!document.getElementById(idsCriticos[j])) {
                reporte.idsCriticosFaltantes.push(idsCriticos[j]);
            }
        }

        window.__vpBootstrapReport = reporte;
        if (reporte.duplicadosScript.length || reporte.idsCriticosFaltantes.length) {
            log.warn('Diagnostico de arranque con advertencias:', reporte);
        }
        _marcarPaso('diagnosticoArranque');
    }

    // --- Paso: detectar capacidades del navegador ---
    function _pasoDetectarCapacidades() {
        try {
            dom.detectarTipoDialogo();
            _marcarPaso('detectarDialogo');
        } catch (e) {
            _registrarErrorParcial('detectarDialogo', e);
        }

        try {
            dom.ariaLive.inicializar();
            _marcarPaso('ariaLive');
        } catch (e) {
            _registrarErrorParcial('ariaLive', e);
        }
    }

    // --- Paso: ocultar controles no soportados ---
    function _pasoOcultarControlesNoSoportados() {
        try {
            if (!VP.features.fullscreen &&
                !dom.esNulo(VP.refs.fullscreenBtn)) {
                VP.refs.fullscreenBtn.style.display = 'none';
            }
        } catch (e) {
            _registrarErrorParcial('ocultarFullscreenBtn', e);
        }

        try {
            if (!VP.features.pictureInPicture &&
                !dom.esNulo(VP.refs.pipBtn)) {
                VP.refs.pipBtn.style.display = 'none';
            }
        } catch (e) {
            _registrarErrorParcial('ocultarPipBtn', e);
        }

        _marcarPaso('ocultarControlesNoSoportados');
    }

    // --- Paso: inicializar eventos ---
    function _pasoInicializarEventos() {
        VP.eventos.inicializar();
        _marcarPaso('inicializarEventos');
    }

    // --- Paso: aplicar estado inicial de UI ---
    function _pasoAplicarUI() {
        var errores = [];

        var pasos = [
            ['ajustes.aplicarAlUI',          function () { VP.ajustes.aplicarAlUI(); }],
            ['reproductor.actualizarVolumen', function () { VP.reproductor.actualizarUIVolumen(); }],
            ['reproductor.iconoFullscreen',   function () { VP.reproductor.actualizarIconoFullscreen(); }],
            ['listas.controlesMoviles',       function () { VP.listas.aplicarControlesMobiles(); }],
            ['ajustes.aplicarLayout',         function () { VP.ajustes.aplicarLayout(); }],
        ];

        for (var i = 0; i < pasos.length; i++) {
            try {
                pasos[i][1]();
            } catch (e) {
                errores.push(pasos[i][0]);
                _registrarErrorParcial('aplicarUI.' + pasos[i][0], e);
            }
        }

        if (errores.length > 0) {
            log.warn('UI aplicada con errores parciales en: ' + errores.join(', '));
        }

        _marcarPaso('aplicarUI');
    }

    // --- Paso: tema y acento ---
    function _pasoAplicarTema() {
        try {
            var temaGuardado =
                util.obtenerItem(cfg.claveTema) || 'default';
            VP.ajustes.aplicarTema(temaGuardado);
        } catch (e) {
            _registrarErrorParcial('aplicarTema', e);
        }

        try {
            VP.ajustes.aplicarColorAcento(VP.ajustes.colorAcento);
        } catch (e) {
            _registrarErrorParcial('aplicarColorAcento', e);
        }

        _marcarPaso('aplicarTema');
    }

    // --- Paso: ultra rendimiento ---
    function _pasoUltraRendimiento() {
        try {
            if (VP.ajustes.ultraRendimiento) {
                VP.ajustes.activarUltraRendimiento();
                _marcarPaso('ultraRendimiento');
            }
        } catch (e) {
            _registrarErrorParcial('ultraRendimiento', e);
        }
    }

    // --- Paso: temporizador de sueño ---
    function _pasoTemporizadorSueno() {
        try {
            if (VP.ajustes.temporizadorSueno > 0) {
                VP.ajustes.iniciarTemporizadorSueno(
                    VP.ajustes.temporizadorSueno
                );
                _marcarPaso('temporizadorSueno');
            }
        } catch (e) {
            _registrarErrorParcial('temporizadorSueno', e);
        }
    }

    // --- Paso: altura dinámica de playlist ---
    function _pasoAlturaPlaylist() {
        try {
            VP.listas.inicializarAlturaPlaylist();
            _marcarPaso('alturaPlaylist');
        } catch (e) {
            _registrarErrorParcial('alturaPlaylist', e);
        }
    }

    // --- Paso: panel de atajos (no bloqueante) ---
    function _pasoPanelAtajos() {
        if (!VP.ajustes.habilitarAtajos) return;

        setTimeout(function () {
            try {
                var panel = VP.refs.shortcutsPanel;
                if (!dom.esNulo(panel)) {
                    panel.classList.add('show');
                    rt.shortcutsTimeout = setTimeout(
                        function () {
                            try {
                                panel.classList.remove('show');
                            } catch (e) { /* ignore */ }
                        },
                        SHORTCUTS_HIDE_DELAY_MS
                    );
                }
            } catch (e) {
                _registrarErrorParcial('panelAtajos', e);
            }
        }, SHORTCUTS_SHOW_DELAY_MS);

        _marcarPaso('panelAtajos');
    }

    // --- Paso: servicios de fondo (no bloquean init) ---
    function _pasoServiciosFondo() {
        // Monitor de almacenamiento
        util.programarIdle(function () {
            try {
                VP.db.iniciarMonitorAlmacenamiento();
                _marcarPaso('monitorAlmacenamiento');
            } catch (e) {
                _registrarErrorParcial('monitorAlmacenamiento', e);
            }
        });

        // Watchdog del reproductor
        setTimeout(function () {
            try {
                VP.reproductor.iniciarWatchdog();
                _marcarPaso('watchdog');
            } catch (e) {
                _registrarErrorParcial('watchdog', e);
            }
        }, WATCHDOG_GRACE_MS);
    }

    // --- Paso: limpieza de caché en idle ---
    function _pasoLimpiezaCache() {
        util.programarIdle(function () {
            try {
            VP.db.limpiarCacheAntigua(cfg.maxEntradasCache)
                    .catch(function (e) {
                        log.warn('limpiarCacheAntigua falló:', e);
                    });
            } catch (e) {
                log.warn('limpiarCacheAntigua (programar) falló:', e);
            }
        }, IDLE_CLEANUP_DELAY_MS);
    }

    // ============================================================
    // 10. REINTENTO DE BASE DE DATOS
    //     Si IDB falla, reintentamos hasta maxReintentosDB veces
    //     antes de caer al modo localStorage.
    // ============================================================

    /**
     * Inicializa la base de datos con reintentos automáticos.
     * @returns {Promise}
     */
    function _inicializarDBConReintento() {
        return new Promise(function (resolve, reject) {
            function intentar() {
                VP.db.inicializar()
                    .then(resolve)
                    .catch(function (e) {
                        initState.reintentosDB++;
                        log.warn(
                            'VP.db.inicializar falló (intento ' +
                            initState.reintentosDB + '/' +
                            initState.maxReintentosDB + '):', e
                        );

                        if (initState.reintentosDB < initState.maxReintentosDB) {
                            // Backoff exponencial: 500ms, 1000ms…
                            var delay = 500 * Math.pow(2, initState.reintentosDB - 1);
                            log.info('Reintentando IDB en ' + delay + ' ms…');
                            setTimeout(intentar, delay);
                        } else {
                            // Máximo de reintentos alcanzado
                            log.warn(
                                'IDB no disponible tras ' +
                                initState.reintentosDB +
                                 ' intentos. Se usará caché en memoria como fallback.'
                            );
                            // No rechazamos — dejamos que el flujo continúe
                            // en modo degradado (VP.db debería tener su propio fallback)
                            resolve();
                        }
                    });
            }

            intentar();
        });
    }

    // ============================================================
    // 11. LOG DE ÉXITO CON INFORMACIÓN COMPLETA
    // ============================================================

    function _logExitoInit() {
        var totalMs = VP.metricas.initTotalMs || 0;
        var renderMs = VP.metricas.renderMs || 0;
        var dbMs    = VP.metricas.dbInitMs  || 0;

        // Calcular rating de rendimiento
        var rating;
        if (totalMs < 500)        rating = '🚀 Excelente';
        else if (totalMs < 1500)  rating = '✓ Bueno';
        else if (totalMs < 3000)  rating = '⚠ Aceptable';
        else                       rating = '🐌 Lento';

        log.info(
            '✓ Listo · v' + VP.version +
            ' · ' + estado.videos.length + ' vídeos' +
            ' · IDB: '      + (rt.idb.listo ? '✓' : '✗ memoria') +
            ' · Dialog: '   + (rt.dialogoNativo ? '<dialog>' : 'div') +
            ' · DB: '       + dbMs + 'ms' +
            ' · Render: '   + renderMs + 'ms' +
            ' · Total: '    + totalMs + 'ms' +
            ' · ' + rating
        );

        // Features en grupo colapsado
        if (VP.features) {
            log.info('Features detectadas');
            var fks = Object.keys(VP.features);
            for (var fi = 0; fi < fks.length; fi++) {
                log.info(
                    '  ' + (VP.features[fks[fi]] ? '✓' : '✗') +
                    ' ' + fks[fi]
                );
            }
            console.groupEnd();
        }

        // Advertencia si hay errores parciales
        if (initState.erroresParciales.length > 0) {
            log.warn(
                'Init completado con ' +
                initState.erroresParciales.length +
                ' errores no críticos. Llama __vpDiag() para detalles.'
            );
        }

        // Advertencia de rendimiento para muchos vídeos
        if (estado.videos.length > 200 && totalMs > 3000) {
            log.warn(
                'La inicialización tomó ' + totalMs + 'ms con ' +
                estado.videos.length + ' vídeos. ' +
                'Considera activar ultraRendimiento o reducir la carga inicial.'
            );
        }
    }

    // ============================================================
    // 12. TIMEOUT DE SEGURIDAD
    //     Si init tarda demasiado, lanzamos recuperación mínima.
    // ============================================================

    function _instalarTimeoutInit() {
        initState.timeoutHandle = setTimeout(function () {
            if (!rt.inicializado) {
                log.error(
                    'TIMEOUT: La inicialización superó ' +
                    INIT_TIMEOUT_MS + ' ms. ' +
                    'Ejecutando recuperación mínima.'
                );
                recuperacionMinima();
            }
        }, INIT_TIMEOUT_MS);
    }

    function _cancelarTimeoutInit() {
        if (initState.timeoutHandle !== null) {
            clearTimeout(initState.timeoutHandle);
            initState.timeoutHandle = null;
        }
    }

    // ============================================================
    // 13. INICIALIZACIÓN PRINCIPAL
    // ============================================================

    function init() {
        // Evitar doble ejecución de init
        if (initState.fase !== 'idle') {
            log.warn('init() llamado cuando fase = ' + initState.fase + '. Ignorando.');
            return;
        }

        initState.fase = 'starting';
        initState.t0   = util.ahora();

        log.info('Iniciando VP v' + VP.version + '…');

        // ---- Timeout de seguridad ----
        _instalarTimeoutInit();

        // ---- PASO 1: Verificar dependencias ----
        var depCheck = verificarDependencias();
        if (!depCheck.ok) {
            _cancelarTimeoutInit();
            log.error(
                'Módulos críticos no cargados: ' +
                depCheck.faltanCriticos.join(', ') + '\n' +
                (depCheck.incompletos && depCheck.incompletos.length
                    ? 'Módulos incompletos: ' + depCheck.incompletos.join(', ') + '\n'
                    : '') +
                'Verifica el orden de los <script> en tu HTML.'
            );
            initState.fase = 'error';
            return;
        }
        _marcarPaso('verificarDependencias');

        // ---- PASO 2: UI mínima (notificaciones) ----
        garantizarUI();
        _marcarPaso('garantizarUI');

        // ---- PASO 3: Cachear referencias DOM ----
        // CRÍTICO: debe ser lo primero sobre el DOM
        try {
            _pasoCachearRefs();
        } catch (e) {
            _cancelarTimeoutInit();
            log.error('cachearRefs falló:', e);
            initState.fase = 'error';
            return;
        }

        // ---- PASO 4: Verificar #videoPlayer ----
        try {
            _pasoVerificarVideoPlayer();
        } catch (e) {
            _cancelarTimeoutInit();
            log.error(e.message);
            initState.fase = 'error';
            return;
        }

        // ---- PASO 4b: Diagnostico defensivo del arranque ----
        _pasoDiagnosticoArranque();

        // ---- PASO 5: Capacidades del navegador ----
        _pasoDetectarCapacidades();

        // ---- PASO 6: Inicializar base de datos ----
        initState.fase = 'db';

        _inicializarDBConReintento()
            .then(function () {
                VP.metricas.dbInitMs = Math.round(util.ahora() - initState.t0);
                _marcarPaso('inicializarDB');

                // ---- PASO 7: Cargar ajustes ----
                try {
                    VP.ajustes.cargar();
                    _marcarPaso('cargarAjustes');
                } catch (e) {
                    _registrarErrorParcial('cargarAjustes', e);
                }

                // ---- PASO 8: Cargar progreso ----
                var promesaProgreso;
                try {
                    promesaProgreso = VP.db.cargarProgreso();
                    if (!promesaProgreso || typeof promesaProgreso.then !== 'function') {
                        promesaProgreso = Promise.resolve();
                    }
                } catch (e) {
                    _registrarErrorParcial('cargarProgreso', e);
                    promesaProgreso = Promise.resolve();
                }

                return promesaProgreso;
            })
            .then(function () {
                _marcarPaso('cargarProgreso');
                initState.fase = 'ready';

                // ---- PASO 9: Limpieza de caché (idle) ----
                _pasoLimpiezaCache();

                // ---- PASO 10: Tema y acento ----
                _pasoAplicarTema();

                // ---- PASO 11: Ocultar controles no soportados ----
                _pasoOcultarControlesNoSoportados();

                // ---- PASO 12: Inicializar eventos ----
                try {
                    _pasoInicializarEventos();
                } catch (e) {
                    // Sin eventos el reproductor no funciona correctamente
                    _registrarErrorParcial('inicializarEventos', e);
                    log.error('Error grave: eventos no inicializados:', e);
                }

                // ---- PASO 13: Aplicar estado de UI ----
                // DESPUÉS de eventos para que los listeners estén listos
                _pasoAplicarUI();

                // ---- PASO 14: Ultra Rendimiento ----
                _pasoUltraRendimiento();

                // ---- PASO 15: Temporizador de sueño ----
                _pasoTemporizadorSueno();

                // ---- PASO 16: Renderizar listas (en lotes para 500+) ----
                _renderizarListasEnLotes(function () {
                    _marcarPaso('renderizarListas');

                    // Estos pasos requieren que las listas estén renderizadas
                    // ---- PASO 17: Altura dinámica de playlist ----
                    _pasoAlturaPlaylist();

                    // ---- PASO 18: Panel de atajos ----
                    _pasoPanelAtajos();
                });

                // ---- PASO 19: Servicios de fondo ----
                _pasoServiciosFondo();

                // ---- PASO 20: Métricas finales ----
                VP.metricas.initTotalMs = Math.round(util.ahora() - initState.t0);
                rt.inicializado = true;

                // ---- PASO 21: Cancelar timeout de seguridad ----
                _cancelarTimeoutInit();

                // ---- PASO 22: Emitir evento ----
                bus.emit('initialized');

                // ---- PASO 23: Log de éxito ----
                _logExitoInit();

            })
            .catch(function (e) {
                _cancelarTimeoutInit();
                log.error('init falló en fase "' + initState.fase + '":', e);

                if (VP.ui && typeof VP.ui.mostrarNotificacion === 'function') {
                    VP.ui.mostrarNotificacion(
                        'Error de inicialización: ' + (e.message || e),
                        'error'
                    );
                }

                recuperacionMinima();
            });
    }

    // ============================================================
    // 14. HOOKS POST-INICIALIZACIÓN
    // ============================================================

    bus.on('initialized', function _onInitialized() {
        // Tras limpiar caché, volver a leer la carpeta guardada para que se
        // reconstruyan miniaturas, duraciones y metadatos desde los videos.
        var recargarCarpeta = false;
        try {
            recargarCarpeta = window.sessionStorage.getItem('vpReloadAfterCacheClear') === '1';
            if (recargarCarpeta) window.sessionStorage.removeItem('vpReloadAfterCacheClear');
        } catch (_) {}
        if (recargarCarpeta && VP.db && VP.carga && typeof VP.carga.refrescarDirectorio === 'function') {
            VP.db.obtenerDirectorio().then(function (handle) {
                if (!handle) return;
                VP.runtime = VP.runtime || {};
                VP.runtime.dirHandle = handle;
                return VP.carga.refrescarDirectorio();
            }).catch(function (error) {
                log.warn('No se pudo reconstruir la caché tras limpiarla:', error);
                if (VP.ui && VP.ui.mostrarNotificacion) {
                    VP.ui.mostrarNotificacion('Selecciona de nuevo la carpeta para regenerar miniaturas', 'info');
                }
            });
        }

        // MediaSession API
        try {
            if (VP.reproductor &&
                typeof VP.reproductor.actualizarMediaSession === 'function') {
                VP.reproductor.actualizarMediaSession();
            }
        } catch (e) {
            log.warn('actualizarMediaSession falló post-init:', e);
        }

        // Log de memoria en idle (no bloqueante)
        util.programarIdle(function () {
            try {
                if (window.__vpMemoria) {
                    log.debug(
                        'Memoria inicial: ' +
                        JSON.stringify(window.__vpMemoria())
                    );
                }
            } catch (e) { /* ignore */ }
        }, MEMORY_LOG_DELAY_MS);

        // Para 500+ vídeos: iniciar pre-carga diferida de miniaturas
        util.programarIdle(function () {
            try {
                if (VP.miniaturas &&
                    typeof VP.miniaturas.iniciarPreCargaDiferida === 'function' &&
                    estado.videos.length > 0) {
                    VP.miniaturas.iniciarPreCargaDiferida();
                    log.info('Pre-carga diferida de miniaturas iniciada.');
                }
            } catch (e) {
                log.warn('Pre-carga de miniaturas falló:', e);
            }
        }, 4000);
    });

    // Reaccionar a errores de módulos después de init
    bus.on('moduleError', function (datos) {
        if (!datos) return;
        log.error(
            'Error en módulo "' + (datos.modulo || 'desconocido') + '": ' +
            (datos.mensaje || '')
        );
        VP.metricas.errores = (VP.metricas.errores || 0) + 1;

        // Si superamos un umbral, advertir al usuario
        if (VP.metricas.errores >= 10) {
            log.warn(
                'Se han acumulado ' + VP.metricas.errores +
                ' errores. El reproductor puede estar inestable.'
            );
        }
    });

    // Limpiar listeners de init al destruir (por si se hace hot-reload)
    bus.on('destroy', function () {
        _cancelarTimeoutInit();
        if (rt.shortcutsTimeout) {
            clearTimeout(rt.shortcutsTimeout);
        }
        log.info('VP destruido. Limpieza de init completada.');
    });

    // ============================================================
    // 15. ARRANQUE
    // ============================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        // DOM ya disponible (script cargado con defer o al final del body)
        init();
    }

    if (typeof VP.registrarModulo === 'function') {
        VP.registrarModulo('init', {
            version: '2.1',
            critico: true,
            timeoutMs: INIT_TIMEOUT_MS
        });
    }

    log.info('vp-init.js cargado · v' + VP.version);

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-init.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
