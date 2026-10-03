'use strict';
// ============================================================
// VP-CARGA.JS  v4.0
// Carga de archivos, procesamiento por lotes, drag & drop.
//
// Mejoras v4.0:
//   - Fingerprinting robusto por nombre+tamaño+lastModified (dedup real)
//   - refrescarDirectorio(): re-escanea sin pedir nuevo handle
//   - Verificación y recuperación de permisos del directorio
//   - Semáforo de concurrencia en _procesarUnaEntrada
//   - estadisticas(): métricas completas expuestas públicamente
//   - Detección de presión de memoria (navigator.deviceMemory)
//   - Mejor categorización de errores (transitorio vs permanente)
//   - importarDesdeJSON(): carga lista de videos desde JSON externo
//   - Cleanup más agresivo en limpiezaForzada (URL revoke + GC hint)
// ============================================================

(function (window, document) {
    // ----------------------------------------------------------
    // GUARDIA DE MÓDULO Y DEPENDENCIAS
    // ----------------------------------------------------------
    const VP = window.VP;
    if (!VP) throw new Error('[VP] vp-base.js debe cargarse antes.');

    const deps = ['util', 'dom', 'log', 'bus', 'config'];
    for (const d of deps) {
        if (!VP[d]) throw new Error(`[VP] vp-carga.js: falta dependencia VP.${d}`);
    }

    const { util, dom, log, bus, cfg } = VP;
    log.setContext('Carga');

    // ----------------------------------------------------------
    // CONSTANTES
    // ----------------------------------------------------------
    function limitarEnteroConfig(valor, predeterminado, minimo, maximo) {
        if (valor == null || (typeof valor === 'string' && !valor.trim())) {
            return predeterminado;
        }
        const numero = Number(valor);
        if (!Number.isFinite(numero)) return predeterminado;
        return Math.min(maximo, Math.max(minimo, Math.floor(numero)));
    }

    const MAX_VIDEOS          = cfg?.maxVideos          ?? 2000;
    // Evita bucles infinitos con lotes = 0 y ráfagas de tareas demasiado grandes.
    const TAM_LOTE            = limitarEnteroConfig(cfg?.tamLoteArchivos, 20, 1, 200);
    const DELAY_LOTE_MS       = limitarEnteroConfig(cfg?.demoraLoteArchivos, 16, 0, 1000);
    const MAX_ERRORES_CONSEC  = 10;
    const MAX_REINTENTOS      = 3;
    const BACKOFF_BASE_MS     = 100;
    const BACKOFF_MAX_MS      = 5000;
    // Un semáforo con límite 0 nunca libera trabajo; un máximo acotado protege
    // memoria y handles al importar carpetas grandes.
    const CONCURRENCIA_PROC   = limitarEnteroConfig(cfg?.concurrenciaCarga, 6, 1, 16);
    const UMBRAL_MEMORIA_MB   = 512;                             // ← NUEVO: umbral para modo ahorro

    // Errores que no deben reintentarse nunca
    const ERRORES_PERMANENTES = new Set([
        'NotAllowedError', 'SecurityError', 'InvalidStateError',
        'DataError', 'QuotaExceededError'
    ]);

    // ----------------------------------------------------------
    // NAMESPACE Y ESTADO INTERNO
    // ----------------------------------------------------------
    VP.carga = VP.carga || {};

    const estado = {
        loteActual: 0,
        totalEntradas: 0,
        procesadasAcum: 0,
        acumuladorNuevos: [],
        erroresConsecutivos: 0,
        circuitAbierto: false,
        // ← NUEVO: fingerprints en lugar de solo nombres (name|size|lastModified)
        fingerprintsExistentes: new Set(),
        nombresExistentes: new Set(),
        nombresEnProceso: new Set(),
        fingerprintsEnProceso: new Set(),
        abortController: null,
        colaReintentos: [],
        intentosReintentos: Object.create(null),
        metricasSesion: {
            totalProcesadas: 0,
            totalRechazadas: 0,
            totalErróneas: 0,
            totalDuplicadas: 0,    // ← NUEVO
            tiempoInicioMs: 0
        },
        handleActivo: null,
        idleHandle: null,
        modoAhorroMemoria: false   // ← NUEVO
    };

    const cacheCanPlay = Object.create(null);
    // Handles efímeros de archivos elegidos con showOpenFilePicker. Se guardan
    // en WeakMaps para no serializarlos como metadata del video en IndexedDB.
    const handlesPorArchivoSeleccionado = new WeakMap();
    const handlesPorVideoSeleccionado = new WeakMap();

    // ----------------------------------------------------------
    // SEMÁFORO DE CONCURRENCIA (para procesamiento paralelo de archivos)
    // ----------------------------------------------------------
    function _crearSemaforo(limite) {
        let activos = 0;
        const cola  = [];
        return {
            adquirir: () => new Promise(resolve => {
                if (activos < limite) { activos++; resolve(); }
                else cola.push(resolve);
            }),
            liberar: () => {
                activos = Math.max(0, activos - 1);
                if (cola.length) { activos++; cola.shift()(); }
            }
        };
    }

    // Semáforo compartido de sesión (se recrea en cada carga)
    let _semaforo = _crearSemaforo(CONCURRENCIA_PROC);

    // ----------------------------------------------------------
    // FINGERPRINT DE ARCHIVO
    // ----------------------------------------------------------
    function _fingerprint(nombre, tamano, lastModified) {
        return `${nombre}|${tamano}|${lastModified || 0}`;
    }

    function _fingerprintDeArchivo(archivo) {
        return _fingerprint(archivo.name, archivo.size, archivo.lastModified);
    }

    function _fingerprintDeVideo(v) {
        if (!v) return null;
        return _fingerprint(v.name, v.size, v.file?.lastModified || v.lastModified || 0);
    }
    VP.carga.obtenerFingerprintVideo = _fingerprintDeVideo;

    function _nombreDesdeFingerprint(fp) {
        if (typeof fp !== 'string' || !fp) return '';
        const idx = fp.indexOf('|');
        return idx === -1 ? fp : fp.slice(0, idx);
    }

    function _agregarFingerprintExistente(fp) {
        if (typeof fp !== 'string' || !fp) return;
        estado.fingerprintsExistentes.add(fp);
        const nombre = _nombreDesdeFingerprint(fp);
        if (nombre) estado.nombresExistentes.add(nombre);
    }

    function _deduplicarArchivosMasiva(archivos) {
        if (!Array.isArray(archivos) || !archivos.length) return [];
        const vistosFp = new Set();
        const vistosNombre = new Set();
        const salida = [];

        for (let i = 0; i < archivos.length; i++) {
            const entrada = archivos[i];
            const esEntradaDirectorio = Array.isArray(entrada);
            const archivo = esEntradaDirectorio ? entrada[1] : entrada;
            const nombre = esEntradaDirectorio ? entrada[0] : archivo?.name;
            if (!archivo || !nombre || !util.esArchivoVideo(nombre)) continue;
            const claveNombre = esEntradaDirectorio
                ? _normalizarRutaRelativa(nombre)
                : String(nombre);
            const fp = esEntradaDirectorio
                ? `ruta:${claveNombre}`
                : _fingerprintDeArchivo(archivo);
            if (vistosFp.has(fp) || vistosNombre.has(claveNombre)) {
                estado.metricasSesion.totalDuplicadas++;
                estado.metricasSesion.totalRechazadas++;
                continue;
            }
            vistosFp.add(fp);
            vistosNombre.add(claveNombre);
            salida.push(entrada);
        }

        return salida;
    }

    function _validarArchivoVideoCarga(archivo) {
        if (!archivo || !archivo.name) return { ok: false, razon: 'sin_nombre' };
        if (archivo.size === 0) return { ok: false, razon: 'vacio' };
        if (!util.esArchivoVideo(archivo.name)) return { ok: false, razon: 'extension' };
        if (!VP.carga.soportaTipoVideo(archivo)) return { ok: false, razon: 'mime' };
        if (yaExiste(archivo)) return { ok: false, razon: 'duplicado' };
        return { ok: true };
    }

    // ----------------------------------------------------------
    // DETECCIÓN DE PRESIÓN DE MEMORIA
    // ----------------------------------------------------------
    function _detectarModoAhorroMemoria() {
        const mem = navigator.deviceMemory; // GB, solo Chromium
        if (typeof mem === 'number' && mem * 1024 < UMBRAL_MEMORIA_MB) {
            estado.modoAhorroMemoria = true;
            log.warn(`Memoria limitada detectada (${mem} GB). Activando modo ahorro.`);
        }
    }

    // ----------------------------------------------------------
    // UTILIDADES INTERNAS
    // ----------------------------------------------------------
    function programar(fn, delay = DELAY_LOTE_MS, timeout = 2000) {
        if (typeof requestIdleCallback === 'function') {
            estado.idleHandle = requestIdleCallback(
                (deadline) => {
                    if (deadline.timeRemaining() > 1 || deadline.didTimeout) fn();
                    else estado.idleHandle = requestIdleCallback(fn, { timeout });
                },
                { timeout }
            );
        } else {
            setTimeout(fn, Math.max(delay, 16));
        }
    }

    function cancelarProgramacion() {
        if (estado.idleHandle !== null && typeof cancelIdleCallback === 'function') {
            cancelIdleCallback(estado.idleHandle);
            estado.idleHandle = null;
        }
    }

    function calcBackoff(intento) {
        const base   = BACKOFF_BASE_MS * Math.pow(2, intento);
        const jitter = Math.random() * 100;
        return Math.min(base + jitter, BACKOFF_MAX_MS);
    }

    function construirObjVideo(archivo, sub = null) {
        const video = {
            id:            util.generarId(),
            name:          archivo.name,
            relativePath:  archivo.webkitRelativePath || null,
            file:          archivo,
            size:          archivo.size,
            lastModified:  archivo.lastModified,
            duration:      null,
            thumbnail:     null,
            thumbnailArray: null,
            subtitleFile:  sub?.file  ?? null,
            subtitleName:  sub?.name  ?? null,
            cargadoEn:     Date.now(),
            errores:       0
        };
        const handle = handlesPorArchivoSeleccionado.get(archivo);
        if (handle) handlesPorVideoSeleccionado.set(video, handle);
        return video;
    }

    VP.carga.obtenerHandleArchivoSeleccionado = function (video) {
        return video ? handlesPorVideoSeleccionado.get(video) || null : null;
    };

    function crearIndiceSubtitulosEntrada(archivos) {
        try {
            return VP.subtitulos?.crearIndiceArchivos?.(archivos) ?? null;
        } catch (e) {
            log.warn('No se pudo indexar los subtítulos de la carpeta:', e);
            return null;
        }
    }

    function _normalizarRutaRelativa(ruta) {
        if (typeof ruta !== 'string' || !ruta) return '';
        try { ruta = ruta.normalize('NFC'); } catch (_) {}
        return ruta.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
    }

    function _videosEnMemoria() {
        const unicos = new Set();
        (VP.estado?.videos || []).forEach(v => { if (v) unicos.add(v); });
        (VP.estado?.playlist || []).forEach(v => { if (v) unicos.add(v); });
        return Array.from(unicos);
    }

    function _firmaArchivoExistente(nombre, tamano, lastModified) {
        return JSON.stringify([
            String(nombre || '').toLowerCase(),
            Number(tamano) || 0,
            Number(lastModified) || 0
        ]);
    }

    function _agregarAIndiceVideos(indice, clave, video) {
        if (!clave) return;
        let videos = indice.get(clave);
        if (!videos) indice.set(clave, videos = []);
        videos.push(video);
    }

    function _crearIndiceVideosExistentes() {
        const indice = {
            porRuta: new Map(),
            porFirma: new Map(),
            porFirmaSinRuta: new Map()
        };
        for (const video of _videosEnMemoria()) {
            const ruta = _normalizarRutaRelativa(video.relativePath || '');
            const firma = _firmaArchivoExistente(
                video.name,
                video.size,
                video.lastModified || video.file?.lastModified
            );
            _agregarAIndiceVideos(indice.porFirma, firma, video);
            _agregarAIndiceVideos(ruta ? indice.porRuta : indice.porFirmaSinRuta, ruta || firma, video);
        }
        return indice;
    }

    function _videoExistenteParaArchivo(archivo, indice) {
        if (!archivo?.name) return null;
        indice = indice || _crearIndiceVideosExistentes();
        const ruta = _normalizarRutaRelativa(archivo.webkitRelativePath || '');
        const nombre = String(archivo.name).toLowerCase();
        const tamano = Number(archivo.size) || 0;
        const modificado = Number(archivo.lastModified) || 0;
        const firma = _firmaArchivoExistente(nombre, tamano, modificado);
        const candidatos = new Set();
        const agregar = lista => {
            if (lista) for (const video of lista) candidatos.add(video);
        };
        if (ruta) {
            agregar(indice.porRuta.get(ruta));
            agregar(indice.porFirmaSinRuta.get(firma));
        } else {
            agregar(indice.porFirma.get(firma));
        }
        return candidatos.size === 1 ? candidatos.values().next().value : null;
    }

    function _asociarSubtituloExistente(video, subtitulo) {
        if (!video || !subtitulo?.file) return false;
        video.subtitleFile = subtitulo.file;
        video.subtitleName = subtitulo.name || subtitulo.file.name || null;
        bus.emit('videoActualizado', video);
        const actual = VP.estado?.playlist?.[VP.estado?.currentVideoIndex];
        if (actual?.id === video.id) {
            Promise.resolve(VP.subtitulos?.adjuntar?.(video, true)).catch(e =>
                log.warn('No se pudo adjuntar el subtítulo asociado:', e)
            );
        }
        return true;
    }

    function _crearIndiceNombresVideoEnMemoria() {
        const indice = new Map();
        for (const video of _videosEnMemoria()) {
            const nombre = String(video.name || '').toLowerCase();
            if (!nombre) continue;
            // null marca nombres ambiguos, que no se deben asociar por nombre.
            indice.set(nombre, indice.has(nombre) ? null : video);
        }
        return indice;
    }

    function _asociarSubtituloExistenteDesdeDirectorio(nombre, handle, indiceNombres) {
        if (!nombre || !handle || !VP.subtitulos?.buscarEnDirectorio) return Promise.resolve(false);
        const objetivo = String(nombre).toLowerCase();
        const video = (indiceNombres || _crearIndiceNombresVideoEnMemoria()).get(objetivo);
        if (!video || video.subtitleFile) return Promise.resolve(false);
        return VP.subtitulos.buscarEnDirectorio(util.obtenerNombreBase(nombre), handle)
            .then(subtitulo => _asociarSubtituloExistente(video, subtitulo))
            .catch(e => {
                log.debug('No se pudo recuperar subtítulo para video ya cargado:', nombre, e);
                return false;
            });
    }

    function registrarError(transitorio = true) {
        estado.erroresConsecutivos++;
        estado.metricasSesion.totalErróneas++;
        if (!transitorio) return; // errores permanentes no disparan circuit-breaker
        if (estado.erroresConsecutivos >= MAX_ERRORES_CONSEC) {
            estado.circuitAbierto = true;
            log.error('Circuit-breaker abierto tras', estado.erroresConsecutivos, 'errores transitorios.');
            bus.emit('cargaCircuitAbierto');
        }
    }

    function registrarExito() {
        estado.erroresConsecutivos = 0;
        if (estado.circuitAbierto) {
            estado.circuitAbierto = false;
            log.info('Circuit-breaker cerrado.');
        }
    }

    function _cargarExcluidos() {
        const clave = cfg?.claveVideosExcluidos || 'vp_excluded_videos_v1';
        try {
            const lista = VP.db.obtenerKeyVal(clave);
            if (Array.isArray(lista)) {
                for (const fp of lista) {
                    _agregarFingerprintExistente(fp);
                }
            }
        } catch (_) {}
    }

    function inicializarSetsDedup() {
        const videos = VP.estado?.videos ?? [];
        estado.fingerprintsExistentes = new Set();
        estado.nombresExistentes = new Set();
        estado.nombresEnProceso = new Set();
        estado.fingerprintsEnProceso  = new Set();
        for (const v of videos) {
            const fp = _fingerprintDeVideo(v);
            _agregarFingerprintExistente(fp);
        }
        _cargarExcluidos();
    }

    // Compatibilidad: buscar por fingerprint; fallback por nombre si el video no tiene size/lastModified
    function yaExiste(archivo) {
        const fp = _fingerprintDeArchivo(archivo);
        if (estado.fingerprintsExistentes.has(fp) || estado.fingerprintsEnProceso.has(fp)) return true;
        const nombre = archivo && archivo.name ? String(archivo.name) : '';
        return !!nombre && (estado.nombresExistentes.has(nombre) || estado.nombresEnProceso.has(nombre));
    }

    function marcarEnProceso(archivo) {
        const fp = _fingerprintDeArchivo(archivo);
        estado.fingerprintsEnProceso.add(fp);
        if (archivo?.name) estado.nombresEnProceso.add(String(archivo.name));
    }

    function desmarcarEnProceso(archivo) {
        const fp = _fingerprintDeArchivo(archivo);
        estado.fingerprintsEnProceso.delete(fp);
        if (archivo?.name) estado.nombresEnProceso.delete(String(archivo.name));
    }

    function resetEstado() {
        estado.loteActual = 0;
        estado.totalEntradas = 0;
        estado.procesadasAcum = 0;
        estado.acumuladorNuevos = [];
        estado.erroresConsecutivos = 0;
        estado.circuitAbierto = false;
        estado.colaReintentos = [];
        estado.intentosReintentos = Object.create(null);
        estado.handleActivo = null;
        estado.nombresEnProceso.clear();
        estado.fingerprintsEnProceso.clear();
        _semaforo = _crearSemaforo(CONCURRENCIA_PROC); // reset del semáforo
    }

    const allSettled = typeof Promise.allSettled === 'function'
        ? Promise.allSettled.bind(Promise)
        : (ps) => Promise.all(ps.map(p =>
            Promise.resolve(p)
                .then(v  => ({ status: 'fulfilled', value: v }))
                .catch(e => ({ status: 'rejected',  reason: e }))
          ));

    // ----------------------------------------------------------
    // VERIFICACIÓN Y RECUPERACIÓN DE PERMISOS
    // ----------------------------------------------------------
    async function _verificarPermiso(handle) {
        if (!handle || typeof handle.queryPermission !== 'function') return true;
        try {
            let estado = await handle.queryPermission({ mode: 'read' });
            if (estado === 'granted') return true;
            if (estado === 'prompt') {
                if (typeof handle.requestPermission === 'function') {
                    estado = await handle.requestPermission({ mode: 'read' });
                    return estado === 'granted';
                }
                return true;
            }
            return false; // 'denied'
        } catch (e) {
            log.warn('_verificarPermiso error:', e.message || e);
            return true; // asumir OK si no se puede verificar
        }
    }

    // ----------------------------------------------------------
    // CANCELAR CARGA
    // ----------------------------------------------------------
    VP.carga.cancelar = function (silencioso = false) {
        const ec = VP.runtime?.estadoCarga;
        if (ec) { ec.cancelado = true; ec.activo = false; }
        if (estado.abortController) { try { estado.abortController.abort(); } catch (_) {} estado.abortController = null; }
        cancelarProgramacion();
        estado.colaReintentos = [];
        estado.intentosReintentos = Object.create(null);
        estado.fingerprintsEnProceso.clear();
        if (VP.miniaturas?.cancelarColas) VP.miniaturas.cancelarColas();
        if (VP.baraCarga?.ocultar)        VP.baraCarga.ocultar();
        if (!silencioso) VP.ui?.mostrarNotificacion?.('Carga cancelada', 'info');
        VP.liberarGuard?.('cargarDir');
        resetEstado();
        log.info('Carga cancelada.');
        bus.emit('cargaCancelada');
    };

    // ----------------------------------------------------------
    // SOPORTE DE TIPO DE VIDEO
    // ----------------------------------------------------------
    VP.carga.soportaTipoVideo = function (archivo) {
        if (!archivo?.name) return true;
        const ext = util.obtenerExtension(archivo.name).replace(/^\./, '').toLowerCase();
        if (!ext) return true;
        if (typeof cacheCanPlay[ext] !== 'undefined') return cacheCanPlay[ext];
        const mime = cfg?.mapasMime?.[ext];
        if (!mime) { cacheCanPlay[ext] = true; return true; }
        const player = VP.refs?.videoPlayer;
        let result = true;
        if (player?.canPlayType) {
            try { result = player.canPlayType(mime) !== ''; } catch (e) { log.warn('canPlayType error:', mime, e); }
        }
        cacheCanPlay[ext] = result;
        return result;
    };

    // ----------------------------------------------------------
    // ITERAR DIRECTORIO
    // ----------------------------------------------------------
    VP.carga.iterarDirectorio = async function (handle, signal) {
        if (!handle) return [];
        const items = [];
        let abortado = false;
        if (signal) signal.addEventListener('abort', () => { abortado = true; }, { once: true });

        try {
            if (Symbol.asyncIterator in Object(handle)) {
                let totalLeidas = 0;
                const limiteSeguridad = MAX_VIDEOS * 5;
                for await (const entry of handle.values()) {
                    if (abortado || signal?.aborted) break;
                    _procesarEntradaIterador(entry, items);
                    totalLeidas++;
                    if (items.length >= MAX_VIDEOS || totalLeidas >= limiteSeguridad) break;
                    if (totalLeidas % 100 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }
                return items;
            }
        } catch (e) { log.warn('Error usando async iterator:', e); }

        let iter;
        try {
            if (typeof handle.values   === 'function') iter = handle.values();
            else if (typeof handle.entries === 'function') iter = handle.entries();
            else return [];
        } catch (e) { log.error('No se pudo iniciar iteración:', e); return []; }

        if (!iter || typeof iter.next !== 'function') return [];

        let totalLeidas    = 0;
        const LIMITE_SEG   = MAX_VIDEOS * 5;

        return new Promise(resolve => {
            function leer() {
                if (abortado || signal?.aborted || totalLeidas > LIMITE_SEG) return resolve(items);
                totalLeidas++;
                let r;
                try { r = iter.next(); } catch (_) { return resolve(items); }
                if (r && typeof r.then === 'function') {
                    r.then(v => {
                        if (!v || v.done) return resolve(items);
                        _procesarEntradaIterador(v.value, items);
                        if (items.length >= MAX_VIDEOS) return resolve(items);
                        queueMicrotask(leer);
                    }).catch(() => resolve(items));
                } else {
                    if (!r || r.done) return resolve(items);
                    _procesarEntradaIterador(r.value, items);
                    if (items.length >= MAX_VIDEOS) return resolve(items);
                    if (totalLeidas % 100 === 0) setTimeout(leer, 0);
                    else leer();
                }
            }
            leer();
        });
    };

    function _procesarEntradaIterador(valor, items) {
        if (!valor) return;
        let nombre, entry;
        if (Array.isArray(valor))          { [nombre, entry] = valor; }
        else if (typeof valor === 'object') { nombre = valor.name; entry = valor; }
        else return;
        if (!nombre || typeof nombre !== 'string') return;
        if (entry?.kind !== 'file') return;
        if (!util.esArchivoVideo(nombre))  return;
        items.push([nombre, entry]);
    }

    async function _obtenerHandleDirectorio() {
        if (VP.runtime?.dirHandle) return VP.runtime.dirHandle;
        try {
            const handle = await VP.db?.obtenerDirectorio?.().catch(() => null);
            if (handle) {
                VP.runtime = VP.runtime || {};
                VP.runtime.dirHandle = handle;
                return handle;
            }
        } catch (_) {}
        return null;
    }

    async function _obtenerHandleArchivo() {
        if (VP.runtime?.lastFileHandle) return VP.runtime.lastFileHandle;
        try {
            const handle = await VP.db?.obtenerUbicacionArchivos?.().catch(() => null);
            if (handle) {
                VP.runtime = VP.runtime || {};
                VP.runtime.lastFileHandle = handle;
                return handle;
            }
        } catch (_) {}
        return null;
    }

    // ----------------------------------------------------------
    // SELECCIÓN DE DIRECTORIO
    // ----------------------------------------------------------
    async function seleccionarNuevoDirectorio() {
        if (typeof showDirectoryPicker !== 'function') return null;
        try {
            const startHandle = await _obtenerHandleDirectorio();
            const opts = { mode: 'read' };
            if (startHandle) opts.startIn = startHandle;
            try {
                return await showDirectoryPicker(opts);
            } catch (errStart) {
                if (errStart?.name === 'AbortError') return 'ABORTED';
                delete opts.startIn;
                return await showDirectoryPicker(opts);
            }
        } catch (e) {
            if (e?.name === 'AbortError') return 'ABORTED';
            log.warn('showDirectoryPicker error:', e.message || e);
            return null;
        }
    }

    // Fallback para navegadores que no ofrecen File System Access API.
    // Chromium (incluido Brave) permite elegir una carpeta con webkitdirectory.
    function abrirSelectorCargaFallback() {
        const carpeta = VP.refs?.folderInput;
        const admiteCarpetas = carpeta && ('webkitdirectory' in carpeta);
        const input = admiteCarpetas ? carpeta : VP.refs?.fileInput;
        if (!input || dom.esNulo(input) || typeof input.click !== 'function') {
            log.error('No hay un selector de archivos disponible.');
            VP.ui?.mostrarNotificacion?.('No se encontró un selector de archivos disponible', 'error');
            return false;
        }
        try {
            // Limpiar antes de abrir permite volver a elegir la misma carpeta.
            input.value = '';
            input.click();
            return true;
        } catch (e) {
            log.error('No se pudo abrir el selector de carga:', e);
            VP.ui?.mostrarNotificacion?.('No se pudo abrir el selector de archivos', 'error');
            return false;
        }
    }

    // ----------------------------------------------------------
    // CARGA PRINCIPAL DESDE DIRECTORIO
    // ----------------------------------------------------------
    VP.carga.cargarDesdeDirectorio = async function () {
        log.info('Iniciando carga desde directorio…');
        if (!VP.guardarGuard?.('cargarDir')) {
            log.warn('Carga ya en progreso, ignorando.');
            VP.ui?.mostrarNotificacion?.('Carga en progreso…', 'advertencia');
            return;
        }

        // Notificación informativa para explicar por qué el explorador de Windows no muestra archivos en modo carpeta
        VP.ui?.mostrarNotificacion?.('📁 Modo Carpeta: En Windows la lista previa oculta los archivos porque estás eligiendo una carpeta. Selecciona la carpeta deseada y pulsa "Seleccionar carpeta".', 'info', 5000);

        if (!VP.features?.fileSystemAccess) {
            VP.liberarGuard('cargarDir');
            abrirSelectorCargaFallback();
            return;
        }

        _detectarModoAhorroMemoria();
        estado.circuitAbierto    = false;
        estado.erroresConsecutivos = 0;
        _semaforo = _crearSemaforo(CONCURRENCIA_PROC);

        try { estado.abortController = new AbortController(); } catch (_) { estado.abortController = null; }
        const signal = estado.abortController?.signal ?? null;

        try {
            let handle = await VP.db.obtenerDirectorio().catch(() => null);
            if (handle?.name) {
                const tienePermiso = await _verificarPermiso(handle);
                if (!tienePermiso) {
                    log.warn('Permiso denegado para el directorio guardado. Solicitando nuevo.');
                    handle = null;
                } else {
                    const usar = window.confirm(`¿Usar el directorio guardado "${handle.name}"?`);
                    if (!usar) {
                        await VP.db.eliminarDirectorio().catch(() => {});
                        handle = null;
                    }
                }
            }
            if (!handle) handle = await seleccionarNuevoDirectorio();
            if (handle === 'ABORTED') {
                VP.liberarGuard('cargarDir');
                return;
            }
            if (!handle || signal?.aborted) {
                VP.liberarGuard('cargarDir');
                if (!signal?.aborted) {
                    abrirSelectorCargaFallback();
                }
                return;
            }

            VP.runtime = VP.runtime || {};
            VP.runtime.dirHandle = handle;
            estado.handleActivo  = handle;
            VP.subtitulos?.invalidarIndiceDirectorio?.(handle);

            const ec = VP.runtime.estadoCarga = Object.assign(
                VP.runtime.estadoCarga || {},
                { activo: true, cancelado: false, total: 0, procesados: 0, inicio: Date.now() }
            );
            estado.metricasSesion.tiempoInicioMs = Date.now();
            Object.keys(estado.metricasSesion).forEach(k => { if (typeof estado.metricasSesion[k] === 'number' && k !== 'tiempoInicioMs') estado.metricasSesion[k] = 0; });
            inicializarSetsDedup();

            VP.baraCarga?.mostrar?.();
            VP.baraCarga?.actualizar?.(0, 0, 'Leyendo directorio…');
            VP.db.guardarDirectorio(handle).catch(e => log.warn('No se guardó handle:', e));

            const entradas = await VP.carga.iterarDirectorio(handle, signal);
            if (ec.cancelado || signal?.aborted) { VP.liberarGuard('cargarDir'); return; }

            ec.total = estado.totalEntradas = entradas.length;
            VP.baraCarga?.actualizar?.(0, ec.total, `${ec.total} archivos encontrados`);
            log.info('Directorio leído:', entradas.length, 'videos.');

            if (!entradas.length) {
                VP.baraCarga?.completar?.('Directorio vacío');
                VP.liberarGuard('cargarDir');
                VP.ui?.mostrarNotificacion?.('No se encontraron videos en el directorio', 'advertencia');
                return;
            }
            await VP.carga._procesarEnLotes(entradas, handle, signal);
        } catch (e) {
            VP.liberarGuard('cargarDir');
            resetEstado();
            if (e?.name === 'AbortError') return;
            log.error('cargarDesdeDirectorio:', e);
            VP.ui?.mostrarNotificacion?.('Error al acceder al directorio. Intente de nuevo.', 'error');
            VP.baraCarga?.ocultar?.();
            abrirSelectorCargaFallback();
        }
    };

    // ----------------------------------------------------------
    // RE-ESCANEO SIN NUEVO HANDLE (NUEVO)
    // ----------------------------------------------------------
    /**
     * Refresca el directorio activo, añadiendo videos nuevos que no estaban antes.
     * No pide al usuario confirmar ni seleccionar nada.
     */
    VP.carga.refrescarDirectorio = async function () {
        const handle = VP.runtime?.dirHandle;
        if (!handle) {
            VP.ui?.mostrarNotificacion?.('No hay directorio activo. Carga primero.', 'advertencia');
            return;
        }
        if (!VP.guardarGuard?.('cargarDir')) {
            VP.ui?.mostrarNotificacion?.('Operación en progreso…', 'advertencia');
            return;
        }
        log.info('Refrescando directorio activo:', handle.name);

        const tienePermiso = await _verificarPermiso(handle);
        if (!tienePermiso) {
            VP.liberarGuard('cargarDir');
            VP.ui?.mostrarNotificacion?.('Permiso denegado para el directorio.', 'error');
            return;
        }

        _semaforo = _crearSemaforo(CONCURRENCIA_PROC);
        try { estado.abortController = new AbortController(); } catch (_) { estado.abortController = null; }
        const signal = estado.abortController?.signal ?? null;

        try {
            estado.metricasSesion.tiempoInicioMs = Date.now();
            inicializarSetsDedup();
            VP.subtitulos?.invalidarIndiceDirectorio?.(handle);
            VP.baraCarga?.mostrar?.();
            VP.baraCarga?.actualizar?.(0, 0, 'Refrescando directorio…');

            const ec = VP.runtime.estadoCarga = Object.assign(
                VP.runtime.estadoCarga || {},
                { activo: true, cancelado: false, total: 0, procesados: 0, inicio: Date.now() }
            );

            const entradas = await VP.carga.iterarDirectorio(handle, signal);
            ec.total = estado.totalEntradas = entradas.length;
            if (!entradas.length) {
                VP.baraCarga?.completar?.('Sin cambios');
                VP.liberarGuard('cargarDir');
                return;
            }
            await VP.carga._procesarEnLotes(entradas, handle, signal);
        } catch (e) {
            log.error('refrescarDirectorio:', e);
            VP.liberarGuard('cargarDir');
            resetEstado();
            VP.baraCarga?.ocultar?.();
        }
    };

    // ----------------------------------------------------------
    // PROCESAMIENTO POR LOTES
    // ----------------------------------------------------------
    VP.carga._procesarEnLotes = async function (entradas, handle, signal) {
        if (!Array.isArray(entradas)) {
            log.error('_procesarEnLotes: entradas no es Array.');
            VP.liberarGuard('cargarDir');
            return;
        }
        const ec    = VP.runtime?.estadoCarga;
        const entradasUnicas = _deduplicarArchivosMasiva(entradas);
        const totalVideosActivos = VP.estado?.videos?.length || 0;
        const tamLoteActivo = (
            VP.runtime?.modoLento ||
            estado.modoAhorroMemoria ||
            (typeof document !== 'undefined' && document.hidden) ||
            totalVideosActivos > 120
        ) ? Math.min(TAM_LOTE, 8) : TAM_LOTE;
        estado.loteActual      = 0;
        estado.procesadasAcum  = 0;
        estado.acumuladorNuevos = [];
        const total  = entradasUnicas.length;
        const lotes  = Math.ceil(total / tamLoteActivo);
        const actualizacionesSubtitulos = [];
        let indiceNombresParaSubtitulos = null;
        log.info('Procesando', total, 'videos únicos en', lotes, 'lotes de', tamLoteActivo);

        for (let loteIdx = 0; loteIdx < lotes; loteIdx++) {
            if (ec?.cancelado || signal?.aborted) { _finalizarConCancelacion(); return; }
            if (estado.circuitAbierto) { _finalizarConError('Demasiados errores consecutivos. Carga abortada.'); return; }

            const inicio      = loteIdx * tamLoteActivo;
            const fin         = Math.min(inicio + tamLoteActivo, total);
            const loteFiltrado = [];
            const vistosFpLote = new Set();
            const vistosNombreLote = new Set();

            for (const entrada of entradasUnicas.slice(inicio, fin)) {
                const nombre = Array.isArray(entrada) ? entrada[0] : entrada.name;
                const fp = Array.isArray(entrada)
                    ? _fingerprint(nombre, entrada[1]?.size || 0, entrada[1]?.lastModified || 0)
                    : _fingerprintDeArchivo(entrada);
                const nombreDuplicado = !!nombre && (
                    estado.nombresExistentes.has(nombre) ||
                    estado.nombresEnProceso.has(nombre) ||
                    vistosNombreLote.has(nombre)
                );
                const fingerprintDuplicado = !!fp && (
                    estado.fingerprintsExistentes.has(fp) ||
                    estado.fingerprintsEnProceso.has(fp) ||
                    vistosFpLote.has(fp)
                );

                if (!nombreDuplicado && !fingerprintDuplicado) {
                    loteFiltrado.push(entrada);
                    vistosFpLote.add(fp);
                    vistosNombreLote.add(nombre);
                } else {
                    estado.metricasSesion.totalDuplicadas++;
                    estado.metricasSesion.totalRechazadas++;
                    const nombreSub = Array.isArray(entrada) ? entrada[0] : entrada?.name;
                    if (!indiceNombresParaSubtitulos) {
                        indiceNombresParaSubtitulos = _crearIndiceNombresVideoEnMemoria();
                    }
                    const actualizarSub = _asociarSubtituloExistenteDesdeDirectorio(
                        nombreSub, handle, indiceNombresParaSubtitulos
                    );
                    if (actualizarSub) actualizacionesSubtitulos.push(actualizarSub);
                }
            }

            if (!loteFiltrado.length) {
                estado.procesadasAcum = fin;
                if (ec) ec.procesados = estado.procesadasAcum;
                _actualizarBarraProgreso(estado.procesadasAcum, total, estado.acumuladorNuevos.length);
                continue;
            }

            log.debug('Lote', `${loteIdx + 1}/${lotes}`, '— procesando', loteFiltrado.length, 'entradas');
            const promesas = loteFiltrado.map(entrada => _procesarUnaEntradaConSemaforo(entrada, handle));
            const resultados = await allSettled(promesas);

            for (const res of resultados) {
                const val = res.status === 'fulfilled' ? res.value : null;
                if (val?.name) {
                    estado.acumuladorNuevos.push(val);
                    _agregarFingerprintExistente(_fingerprintDeVideo(val));
                    registrarExito();
                    estado.metricasSesion.totalProcesadas++;
                } else {
                    // Solo contar como error si no fue descartado por duplicado silencioso
                    if (res.status === 'rejected') registrarError(true);
                }
            }

            estado.procesadasAcum = fin;
            if (ec) ec.procesados = estado.procesadasAcum;
            _actualizarBarraProgreso(estado.procesadasAcum, total, estado.acumuladorNuevos.length);
            if (estado.acumuladorNuevos.length > 0 && estado.acumuladorNuevos.length % 50 === 0) {
                bus.emit('videosParcialesCargados', { cantidad: estado.acumuladorNuevos.length, total });
            }
            await new Promise(resolve => programar(resolve, DELAY_LOTE_MS));
        }

        if (actualizacionesSubtitulos.length) {
            const resultadosSubtitulos = await allSettled(actualizacionesSubtitulos);
            const cantidadActualizada = resultadosSubtitulos.filter(res => res.status === 'fulfilled' && res.value).length;
            if (cantidadActualizada) log.info('Subtítulos asociados a', cantidadActualizada, 'video(s) que ya estaban cargados.');
        }

        log.info('Todos los lotes procesados —', estado.acumuladorNuevos.length, 'videos acumulados.');
        await _procesarReintentosAsync();
        VP.carga._finalizarCarga(estado.acumuladorNuevos);
        VP.liberarGuard('cargarDir');
    };

    async function _procesarUnaEntradaConSemaforo(entrada, handle) {
        await _semaforo.adquirir();
        try { return await _procesarUnaEntrada(entrada, handle); }
        finally { _semaforo.liberar(); }
    }

    async function _procesarUnaEntrada(entrada, handle) {
        const nombre = Array.isArray(entrada) ? entrada[0] : entrada.name;
        const entry  = Array.isArray(entrada) ? entrada[1] : entrada;
        if (!nombre || !entry || typeof entry.getFile !== 'function') return null;
        try {
            const archivo = await entry.getFile();
            if (!archivo) return null;
            const validacion = _validarArchivoVideoCarga(archivo);
            if (!validacion.ok && validacion.razon !== 'duplicado') {
                estado.metricasSesion.totalRechazadas++;
                return null;
            }

            // ← NUEVO: comprobación exacta con fingerprint
            if (!validacion.ok && validacion.razon === 'duplicado') {
                estado.metricasSesion.totalDuplicadas++;
                estado.metricasSesion.totalRechazadas++;
                return null;
            }
            marcarEnProceso(archivo);

            let sub = null;
            if (VP.subtitulos?.buscarEnDirectorio && handle) {
                sub = await VP.subtitulos.buscarEnDirectorio(util.obtenerNombreBase(archivo.name), handle).catch(() => null);
            }
            const videoObj = construirObjVideo(archivo, sub);
            desmarcarEnProceso(archivo);
            return videoObj;
        } catch (e) {
            const permanente = e?.name && ERRORES_PERMANENTES.has(e.name);
            if (!permanente && _debeReintentar(e, nombre)) _encolarReintento([nombre, entry], handle);
            else registrarError(!permanente);
            return null;
        }
    }

    function _debeReintentar(error, nombre) {
        if (!error) return false;
        const intentos = estado.intentosReintentos[nombre] || 0;
        if (intentos >= MAX_REINTENTOS) return false;
        if (error.name && ERRORES_PERMANENTES.has(error.name)) return false;
        return true;
    }

    function _encolarReintento(entrada, handle) {
        const nombre = Array.isArray(entrada) ? entrada[0] : entrada.name;
        if (!nombre) return;
        estado.intentosReintentos[nombre] = (estado.intentosReintentos[nombre] || 0) + 1;
        estado.colaReintentos.push({ entrada, handle });
    }

    async function _procesarReintentosAsync() {
        const total = estado.colaReintentos.length;
        if (!total) return;
        log.info('Procesando', total, 'reintentos…');
        while (estado.colaReintentos.length) {
            const cola = estado.colaReintentos.splice(0);
            const promesas = cola.map(item => {
                const nombre  = Array.isArray(item.entrada) ? item.entrada[0] : item.entrada.name;
                const intento = (estado.intentosReintentos[nombre] || 1) - 1;
                return new Promise(resolve =>
                    setTimeout(() =>
                        _procesarUnaEntradaConSemaforo(item.entrada, item.handle)
                            .then(resolve).catch(() => resolve(null)),
                        calcBackoff(intento)
                    )
                );
            });
            const resultados = await allSettled(promesas);
            for (const res of resultados) {
                const val = res.status === 'fulfilled' ? res.value : null;
                if (val?.name) {
                    estado.acumuladorNuevos.push(val);
                    _agregarFingerprintExistente(_fingerprintDeVideo(val));
                    estado.metricasSesion.totalProcesadas++;
                }
            }
        }
        log.info('Reintentos completados.');
    }

    function _actualizarBarraProgreso(procesadas, total, nuevos) {
        if (!VP.baraCarga?.actualizar) return;
        const pct   = total ? Math.round((procesadas / total) * 100) : 0;
        const rest  = _calcularTiempoRestante(procesadas, total);
        VP.baraCarga.actualizar(procesadas, total, `${pct}% — ${procesadas}/${total} (${nuevos} nuevos)${rest}`);
    }

    function _calcularTiempoRestante(procesadas, total) {
        const ec = VP.runtime?.estadoCarga;
        if (!ec?.inicio || procesadas === 0) return '';
        const ms    = Date.now() - ec.inicio;
        if (ms <= 0) return '';
        const msRest = Math.round((ms / procesadas) * (total - procesadas));
        return ` · ~${_formatearTiempo(msRest)} restantes`;
    }

    function _formatearTiempo(ms) {
        if (ms < 0) return '0s';
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s`;
        return `${Math.floor(s / 60)}m ${s % 60}s`;
    }

    // ----------------------------------------------------------
    // FINALIZAR CARGA
    // ----------------------------------------------------------
    VP.carga._finalizarCarga = function (nuevosVideos) {
        const ec = VP.runtime?.estadoCarga;
        if (ec) ec.activo = false;

        if (!Array.isArray(nuevosVideos) || !nuevosVideos.length) {
            VP.ui?.mostrarNotificacion?.('No se encontraron videos nuevos', 'advertencia');
            VP.baraCarga?.completar?.('Sin videos nuevos');
            _reportarMetricas();
            return;
        }

        // Filtrar por si ya están en el mapa (doble verificación)
        const porAnadir = nuevosVideos.filter(v => v?.name && v?.file && !_yaEnMapa(v));
        if (!porAnadir.length) {
            VP.ui?.mostrarNotificacion?.('Todos los videos ya están en la lista', 'info');
            VP.baraCarga?.completar?.('Sin cambios');
            _reportarMetricas();
            return;
        }

        _agregarVideosAlEstado(porAnadir);
        VP.reconstruirTodosMapas?.();
        _renderizarVistas();

        const elapsed = estado.metricasSesion.tiempoInicioMs
            ? ((Date.now() - estado.metricasSesion.tiempoInicioMs) / 1000).toFixed(1)
            : '?';
        VP.baraCarga?.completar?.(`${porAnadir.length} videos cargados en ${elapsed}s`);
        VP.ui?.mostrarNotificacion?.(`${porAnadir.length} video(s) listos`, 'exito');
        VP.metricas.videosCargados = (VP.metricas.videosCargados || 0) + porAnadir.length;
        log.info('Carga completada:', porAnadir.length, 'nuevos en', elapsed + 's.');

        bus.emit('videosCargados', porAnadir);
        bus.emit('playlistCambiada');
        _reportarMetricas();
        resetEstado();
    };

    function _yaEnMapa(v) {
        return !!(VP.cache?.mapaVideoPorNombre?.[v.name]);
    }

    function _agregarVideosAlEstado(videos) {
        if (!VP.estado) return;
        VP.estado.videos   = (VP.estado.videos   || []).concat(videos);
        VP.estado.playlist = (VP.estado.playlist || []).concat(videos);
    }

    function _renderizarVistas() {
        if (!VP.listas) return;
        requestAnimationFrame(() => {
            VP.listas.renderizarGaleria?.();
            // Separar los inicios evita que limpiar e iniciar ambos renderizados
            // ocurra dentro del mismo frame tras una carga grande.
            requestAnimationFrame(() => VP.listas?.renderizarPlaylist?.());
        });
    }

    function _finalizarConCancelacion() {
        log.info('Procesamiento cancelado.');
        VP.baraCarga?.ocultar?.();
        VP.liberarGuard('cargarDir');
        resetEstado();
    }

    function _finalizarConError(mensaje) {
        log.error(mensaje);
        VP.baraCarga?.ocultar?.();
        VP.liberarGuard('cargarDir');
        resetEstado();
        VP.ui?.mostrarNotificacion?.(mensaje || 'Error en la carga', 'error');
    }

    function _reportarMetricas() {
        const m       = estado.metricasSesion;
        const elapsed = m.tiempoInicioMs ? ((Date.now() - m.tiempoInicioMs) / 1000).toFixed(2) : '0';
        log.debug('Métricas → procesadas:', m.totalProcesadas, 'rechazadas:', m.totalRechazadas,
            'duplicadas:', m.totalDuplicadas, 'erróneas:', m.totalErróneas, 'tiempo:', elapsed + 's');
        bus.emit('cargaMetricas', {
            procesadas:  m.totalProcesadas,
            rechazadas:  m.totalRechazadas,
            duplicadas:  m.totalDuplicadas,
            erroneas:    m.totalErróneas,
            tiempoMs:    m.tiempoInicioMs ? (Date.now() - m.tiempoInicioMs) : 0
        });
    }

    // ----------------------------------------------------------
    // ESTADÍSTICAS PÚBLICAS (NUEVO)
    // ----------------------------------------------------------
    VP.carga.estadisticas = function () {
        const ec = VP.runtime?.estadoCarga;
        return {
            activo:          ec?.activo    ?? false,
            cancelado:       ec?.cancelado ?? false,
            total:           ec?.total     ?? 0,
            procesados:      ec?.procesados ?? 0,
            porcentaje:      ec?.total ? Math.round((ec.procesados / ec.total) * 100) : 0,
            metricasSesion:  { ...estado.metricasSesion },
            modoAhorroMem:   estado.modoAhorroMemoria,
            circuitAbierto:  estado.circuitAbierto,
            reintentosPend:  estado.colaReintentos.length,
            directorioActivo: VP.runtime?.dirHandle?.name ?? null
        };
    };

    // ----------------------------------------------------------
    // PROCESAR ARCHIVOS INPUT (file input / drop)
    // ----------------------------------------------------------
    VP.carga.procesarArchivosInput = function (archivos) {
        if (!archivos?.length) { log.warn('procesarArchivosInput: sin archivos.'); return; }
        const archivosEntrada = Array.isArray(archivos) ? archivos : Array.from(archivos);
        const indiceSubtitulos = crearIndiceSubtitulosEntrada(archivosEntrada);
        const arr = _deduplicarArchivosMasiva(archivosEntrada);
        if (!arr.length) return;
        const indiceVideosExistentes = _crearIndiceVideosExistentes();
        if (!estado.fingerprintsExistentes.size) inicializarSetsDedup();
        estado.metricasSesion.tiempoInicioMs = Date.now();

        const vistosFp = new Set();
        const vistosNombre = new Set();
        const nuevos = [];
        for (const f of arr) {
            if (!f?.name || !util.esArchivoVideo(f.name)) continue;
            const fp = _fingerprintDeArchivo(f);
            const nombre = String(f.name);
            if (vistosFp.has(fp) || vistosNombre.has(nombre)) continue;
            vistosFp.add(fp);
            vistosNombre.add(nombre);

            let subtitulo = null;
            try { subtitulo = indiceSubtitulos?.buscarParaVideo?.(f) ?? null; }
            catch (e) { log.warn('No se pudo asociar subtítulo a', f.name, e); }
            const validacion = _validarArchivoVideoCarga(f);
            if (!validacion.ok) {
                if (validacion.razon === 'duplicado') {
                    estado.metricasSesion.totalDuplicadas++;
                    const existente = _videoExistenteParaArchivo(f, indiceVideosExistentes);
                    const handle = handlesPorArchivoSeleccionado.get(f);
                    if (existente && handle) handlesPorVideoSeleccionado.set(existente, handle);
                    _asociarSubtituloExistente(existente, subtitulo);
                }
                estado.metricasSesion.totalRechazadas++;
                continue;
            }
            marcarEnProceso(f);
            const v = construirObjVideo(f, subtitulo);
            nuevos.push(v);
            _agregarFingerprintExistente(_fingerprintDeVideo(v));
            estado.metricasSesion.totalProcesadas++;
        }
        log.info('Input procesado:', nuevos.length, 'nuevos de', arr.length, 'archivos únicos.');
        VP.carga._finalizarCarga(nuevos);
    };

    // ----------------------------------------------------------
    // IMPORTAR DESDE JSON (NUEVO)
    // ----------------------------------------------------------
    /**
     * Importa metadata de videos desde un JSON externo (sin archivos reales).
     * Útil para listas pre-generadas o integración con herramientas externas.
     * Formato esperado: [{ name, size, lastModified, ... }, ...]
     */
    VP.carga.importarDesdeJSON = function (jsonData) {
        let lista;
        try {
            lista = typeof jsonData === 'string'
                ? (util.parsearJSONSeguro ? util.parsearJSONSeguro(jsonData, null) : JSON.parse(jsonData))
                : jsonData;
        } catch (e) {
            log.error('importarDesdeJSON: JSON inválido.', e);
            VP.ui?.mostrarNotificacion?.('JSON inválido para importar', 'error');
            return Promise.resolve(0);
        }
        if (!Array.isArray(lista) || !lista.length) {
            log.warn('importarDesdeJSON: lista vacía.');
            return Promise.resolve(0);
        }
        if (!estado.fingerprintsExistentes.size) inicializarSetsDedup();
        const nuevos = [];
        for (const item of lista) {
            if (!item?.name || !util.esArchivoVideo(item.name)) continue;
            const fp = _fingerprint(item.name, item.size || 0, item.lastModified || 0);
            if (estado.fingerprintsExistentes.has(fp)) continue;
            // Objeto de video sintético (sin archivo real)
            const v = {
                id:           util.generarId(),
                name:         item.name,
                file:         null,
                size:         item.size || 0,
                lastModified: item.lastModified || 0,
                duration:     item.duration ?? null,
                thumbnail:    item.thumbnail ?? null,
                thumbnailArray: null,
                subtitleFile: null,
                subtitleName: item.subtitleName ?? null,
                cargadoEn:   Date.now(),
                errores:      0,
                importado:    true   // flag para distinguirlos
            };
            nuevos.push(v);
            _agregarFingerprintExistente(fp);
        }
        if (!nuevos.length) {
            VP.ui?.mostrarNotificacion?.('No se encontraron videos nuevos en el JSON', 'advertencia');
            return Promise.resolve(0);
        }
        _agregarVideosAlEstado(nuevos);
        VP.reconstruirTodosMapas?.();
        _renderizarVistas();
        VP.ui?.mostrarNotificacion?.(`${nuevos.length} video(s) importados desde JSON`, 'exito');
        bus.emit('videosCargados', nuevos);
        bus.emit('playlistCambiada');
        log.info('Importados desde JSON:', nuevos.length);
        return Promise.resolve(nuevos.length);
    };

    // ----------------------------------------------------------
    // LIMPIEZA FORZADA
    // ----------------------------------------------------------
    VP.carga.limpiezaForzada = async function () {
        log.info('Iniciando limpieza forzada…');
        VP.carga.cancelar(true);

        // Revocar TODOS los blob URLs registrados
        if (VP.revocarTodosBlobURLs) {
            VP.revocarTodosBlobURLs();
        } else {
            // Fallback: revocar URLs de los videos en estado
            const videos = VP.estado?.videos || [];
            for (const v of videos) {
                if (v._blobUrl) { try { URL.revokeObjectURL(v._blobUrl); } catch (_) {} v._blobUrl = null; }
            }
        }

        _restaurarVideoActivo();

        // Hint al GC: liberar referencias a File objects de videos no activos
        if (estado.modoAhorroMemoria) {
            const ci = VP.estado?.currentVideoIndex;
            (VP.estado?.videos || []).forEach((v, i) => {
                if (i !== ci && v.file) { v.file = null; } // liberamos referencia
            });
            log.debug('Modo ahorro: referencias File liberadas.');
        }

        try {
        await VP.db?.limpiarCacheAntigua?.(cfg?.maxEntradasCache ?? 200);
            log.info('Limpieza forzada completada.');
            VP.ui?.mostrarNotificacion?.('Limpieza de memoria completada', 'exito');
            bus.emit('limpiezaForzadaCompletada');
        } catch (e) {
            log.error('limpiezaForzada:', e);
            VP.ui?.mostrarNotificacion?.('Error en limpieza de memoria', 'error');
        }
    };

    function _restaurarVideoActivo() {
        const playlist = VP.estado?.playlist;
        const ci       = VP.estado?.currentVideoIndex;
        if (!playlist || ci == null || !playlist[ci]?.file) return;
        const v   = playlist[ci];
        const url = VP.crearBlobURL?.(v.file);
        if (!url) return;
        VP.runtime.urlActual = url;
        const player = VP.refs?.videoPlayer;
        if (!player) return;
        const tiempo  = player.currentTime || 0;
        const pausado = player.paused;
        player.src = url;
        player.load();
        player.addEventListener('loadedmetadata', () => {
            player.currentTime = tiempo;
            if (!pausado) player.play().catch(() => {});
        }, { once: true });
    }

    // ----------------------------------------------------------
    // INICIALIZACIÓN DE UI
    // ----------------------------------------------------------
    VP.carga.inicializarFileInput = function () {
        const fi = VP.refs?.fileInput;
        const carpeta = VP.refs?.folderInput;
        [fi, carpeta].forEach(input => {
            if (!input || dom.esNulo(input) || input.__vpCargaInit) return;
            input.__vpCargaInit = true;
            input.addEventListener('change', (e) => {
                const archivos = e.target?.files;
                if (archivos?.length) VP.carga.procesarArchivosInput(archivos);
                try { input.value = ''; } catch (_) {}
            });
        });
        log.debug('Selectores de archivos y carpeta inicializados.');
    };

    // ----------------------------------------------------------
    // CARGA DE ARCHIVOS DE VÍDEO DIRECTOS (NUEVO)
    // ----------------------------------------------------------
    VP.carga.cargarArchivos = async function () {
        log.info('Iniciando selección de archivos de vídeo…');
        if (!VP.guardarGuard?.('cargarArchivos')) {
            return;
        }

        if (typeof showOpenFilePicker === 'function') {
            try {
                const startHandle = await _obtenerHandleArchivo();
                const opts = {
                    multiple: true,
                    types: [{
                        description: 'Videos y subtítulos',
                        accept: {
                            'video/*': [
                                '.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv',
                                '.m4v', '.3gp', '.flv', '.wmv', '.ts', '.m2ts',
                                '.mts', '.vob', '.divx', '.xvid', '.rmvb', '.rm'
                            ],
                            'text/plain': ['.srt', '.ass', '.ssa'],
                            'text/vtt': ['.vtt']
                        }
                    }]
                };
                if (startHandle) opts.startIn = startHandle;

                let handles;
                try {
                    handles = await showOpenFilePicker(opts);
                } catch (errPicker) {
                    if (errPicker?.name === 'AbortError') {
                        VP.liberarGuard('cargarArchivos');
                        return;
                    }
                    delete opts.startIn;
                    handles = await showOpenFilePicker(opts);
                }

                if (!handles || !handles.length) {
                    VP.liberarGuard('cargarArchivos');
                    return;
                }

                // Guardar la ubicación de archivos en una clave independientemente de las carpetas
                const primerHandle = handles[0];
                if (primerHandle) {
                    VP.runtime = VP.runtime || {};
                    VP.runtime.lastFileHandle = primerHandle;
                    VP.db?.guardarUbicacionArchivos?.(primerHandle).catch(() => {});
                }

                const archivos = [];
                const handlesPorArchivo = new Map();
                for (const h of handles) {
                    try {
                        const file = await h.getFile();
                        if (file) {
                            archivos.push(file);
                            handlesPorArchivo.set(file, h);
                            handlesPorArchivoSeleccionado.set(file, h);
                        }
                    } catch (_) {}
                }

                // Primero se asocian los .srt incluidos en la selección. Para
                // videos seleccionados solos, Brave/Chrome no exponen el padre
                // del archivo: solo se busca al lado si ya existe un handle de
                // carpeta autorizado que contiene exactamente ese archivo.
                const indiceElegidos = crearIndiceSubtitulosEntrada(archivos);
                const videosSinSubtitulo = archivos
                    .filter(archivo => util.esArchivoVideo(archivo.name))
                    .map(archivo => ({
                        archivo,
                        handle: handlesPorArchivo.get(archivo),
                        yaTieneSubtitulo: !!indiceElegidos?.buscarParaVideo?.(archivo)
                    }))
                    .filter(item => !item.yaTieneSubtitulo && item.handle);

                if (videosSinSubtitulo.length && VP.subtitulos?.buscarEnDirectorio) {
                    let carpeta = await _obtenerHandleDirectorio();
                    if (carpeta && typeof carpeta.queryPermission === 'function') {
                        try {
                            let permiso = await carpeta.queryPermission({ mode: 'read' });
                            // requestPermission necesita activación del usuario.
                            // No abrir un diálogo sorpresa tras el selector si
                            // el navegador ya consumió esa activación.
                            if (permiso === 'prompt' &&
                                navigator.userActivation?.isActive &&
                                typeof carpeta.requestPermission === 'function') {
                                permiso = await carpeta.requestPermission({ mode: 'read' });
                            }
                            if (permiso !== 'granted') carpeta = null;
                        } catch (_) { carpeta = null; }
                    }
                    if (carpeta) {
                        VP.subtitulos?.invalidarIndiceDirectorio?.(carpeta);
                        for (const item of videosSinSubtitulo) {
                            const subtitulo = await VP.subtitulos.buscarHermanoDeArchivo?.(
                                item.handle,
                                carpeta,
                                util.obtenerNombreBase(item.archivo.name)
                            ).catch(() => null);
                            if (subtitulo?.file) {
                                archivos.push(subtitulo.file);
                            }
                        }
                    }
                }

                VP.liberarGuard('cargarArchivos');
                if (archivos.length) {
                    VP.carga.procesarArchivosInput(archivos);
                }
                return;
            } catch (e) {
                VP.liberarGuard('cargarArchivos');
                if (e?.name === 'AbortError') return;
                log.warn('showOpenFilePicker error:', e.message || e);
            }
        }

        VP.liberarGuard('cargarArchivos');
        const input = VP.refs?.fileInput;
        if (input && !dom.esNulo(input) && typeof input.click === 'function') {
            try { input.value = ''; input.click(); } catch (_) {}
        }
    };

    VP.carga.inicializarBotonAnadir = function () {
        const btnFolder = VP.refs?.addVideosBtn;
        if (btnFolder && !dom.esNulo(btnFolder) && !btnFolder.__vpCargaInit) {
            btnFolder.__vpCargaInit = true;
            const handlerF = util.throttle
                ? util.throttle(VP.carga.cargarDesdeDirectorio, 600)
                : VP.carga.cargarDesdeDirectorio;
            btnFolder.addEventListener('click', handlerF);
        }

        const btnFiles = VP.refs?.addFilesBtn;
        if (btnFiles && !dom.esNulo(btnFiles) && !btnFiles.__vpCargaInit) {
            btnFiles.__vpCargaInit = true;
            const handlerA = util.throttle
                ? util.throttle(VP.carga.cargarArchivos, 600)
                : VP.carga.cargarArchivos;
            btnFiles.addEventListener('click', handlerA);
        }
        log.debug('Botones añadir carpeta y archivos inicializados.');
    };

    VP.carga.inicializarDragDrop = function () {
        const zona = VP.refs?.videoPlayerWrap;
        if (!zona || dom.esNulo(zona) || zona.__vpDragInit) return;
        zona.__vpDragInit = true;
        let contador    = 0;
        let ocultarTimer = null;
        const overlay   = dom.crearOverlayDrop?.(zona) ?? null;

        function mostrar() {
            if (!overlay) return;
            clearTimeout(ocultarTimer);
            overlay.style.display = 'flex';
            requestAnimationFrame(() => { overlay.style.opacity = '1'; });
        }
        function ocultar() {
            if (!overlay) return;
            overlay.style.opacity = '0';
            ocultarTimer = setTimeout(() => { overlay.style.display = 'none'; }, 200);
        }

        zona.addEventListener('dragenter', e => { e.preventDefault(); e.stopPropagation(); if (++contador === 1) mostrar(); });
        zona.addEventListener('dragleave', e => { e.preventDefault(); e.stopPropagation(); contador = Math.max(0, contador - 1); if (!contador) ocultar(); });
        zona.addEventListener('dragover',  e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
        zona.addEventListener('drop', e => {
            e.preventDefault(); e.stopPropagation(); contador = 0; ocultar();
            const dt = e.dataTransfer;
            if (!dt) return;
            if (dt.items?.length && typeof dt.items[0].webkitGetAsEntry === 'function') {
                _procesarItemsDrop(dt.items);
            } else if (dt.files?.length) {
                VP.carga.procesarArchivosInput(dt.files);
            }
        });
        log.debug('Drag & Drop inicializado.');
    };

    function _procesarItemsDrop(items) {
        const arr       = Array.from(items);
        const archivos  = [];
        let pendientes  = arr.length;
        if (!pendientes) return;

        function finalizarSi() {
            if (--pendientes === 0) _finalizarDrop(archivos);
        }

        for (const item of arr) {
            if (item.kind !== 'file') { finalizarSi(); continue; }
            const entry = item.webkitGetAsEntry?.();
            if (entry?.isDirectory) {
                _leerCarpetaDrop(entry, files => {
                    archivos.push(...files.filter(f => util.esArchivoVideo(f.name)));
                    finalizarSi();
                });
            } else {
                const archivo = item.getAsFile?.();
                if (archivo && util.esArchivoVideo(archivo.name)) archivos.push(archivo);
                finalizarSi();
            }
        }
    }

    function _finalizarDrop(archivos) {
        log.info('Drop finalizado —', archivos.length, 'video(s) encontrados.');
        if (archivos.length) {
            VP.carga.procesarArchivosInput(archivos);
            VP.ui?.mostrarNotificacion?.(`${archivos.length} video(s) cargados`, 'exito');
        } else {
            VP.ui?.mostrarNotificacion?.('Ningún video válido en los archivos soltados', 'advertencia');
        }
    }

    function _leerCarpetaDrop(dirEntry, callback) {
        if (!dirEntry?.createReader) return callback([]);
        const reader = dirEntry.createReader();
        const result = [];
        function leerLote() {
            reader.readEntries(entries => {
                if (!entries?.length) return callback(result);
                let pendientes = entries.length;
                for (const entry of entries) {
                    if (!entry.isFile) { if (!--pendientes) result.length < MAX_VIDEOS ? leerLote() : callback(result); continue; }
                    entry.file(
                        archivo => {
                            if (archivo && util.esArchivoVideo(archivo.name)) result.push(archivo);
                            if (!--pendientes) result.length < MAX_VIDEOS ? leerLote() : callback(result);
                        },
                        () => { if (!--pendientes) result.length < MAX_VIDEOS ? leerLote() : callback(result); }
                    );
                }
            }, () => callback(result));
        }
        leerLote();
    }

    // ----------------------------------------------------------
    // API DE CONSOLA (depuración)
    // ----------------------------------------------------------
    window.__vpForceCleanup  = () => VP.carga.limpiezaForzada();
    window.__vpCargaEstado   = () => { console.group('Estado Carga'); console.log('Runtime:', VP.runtime?.estadoCarga); console.log('Interno:', estado); console.groupEnd(); return VP.carga.estadisticas(); };
    window.__vpCargaCancelar = () => VP.carga.cancelar();
    window.__vpRefrescar     = () => VP.carga.refrescarDirectorio();

    // ----------------------------------------------------------
    // INICIALIZACIÓN DEL MÓDULO
    // ----------------------------------------------------------
    VP.carga.inicializar = function () {
        if (!VP.runtime?.estadoCarga) {
            VP.runtime.estadoCarga = { activo: false, cancelado: false, total: 0, procesados: 0, inicio: 0 };
        }
        Object.keys(cacheCanPlay).forEach(k => delete cacheCanPlay[k]);
        _semaforo = _crearSemaforo(CONCURRENCIA_PROC);
        _detectarModoAhorroMemoria();
        VP.carga.inicializarBotonAnadir();
        VP.carga.inicializarFileInput();
        VP.carga.inicializarDragDrop();
        inicializarSetsDedup();
        log.info('Módulo carga inicializado correctamente (v4.0).');
        bus.emit('cargaInicializada');
    };

    // EVENTOS DEL BUS
    bus.on('cancelarCarga', () => VP.carga.cancelar());
    bus.on('reset', () => {
        VP.liberarGuard?.('cargarDir');
        if (VP.runtime?.estadoCarga) { VP.runtime.estadoCarga.activo = false; VP.runtime.estadoCarga.cancelado = false; }
        resetEstado();
        Object.keys(cacheCanPlay).forEach(k => delete cacheCanPlay[k]);
    });
    bus.on('videosParcialesCargados', () => { programar(() => VP.listas?.renderizarPlaylist?.(), 50); });
    bus.on('reproductorCambiado',     () => { Object.keys(cacheCanPlay).forEach(k => delete cacheCanPlay[k]); });

    // VERIFICACIÓN DE INTEGRIDAD
    (function verificar() {
        const requeridos = [
            'cancelar', 'soportaTipoVideo', 'iterarDirectorio',
            'cargarDesdeDirectorio', 'refrescarDirectorio',
            '_procesarEnLotes', '_finalizarCarga',
            'procesarArchivosInput', 'importarDesdeJSON',
            'inicializarFileInput', 'inicializarBotonAnadir',
            'inicializarDragDrop', 'limpiezaForzada',
            'estadisticas', 'inicializar'
        ];
        const faltantes = requeridos.filter(fn => typeof VP.carga[fn] !== 'function');
        if (faltantes.length) log.error('Faltan funciones:', faltantes.join(', '));
        else log.debug(`Verificación OK (${requeridos.length} funciones).`);
    })();

    log.info('vp-carga.js v4.0 cargado.');
    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-carga.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
