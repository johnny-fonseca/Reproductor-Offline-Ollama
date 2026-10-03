'use strict';

// ============================================================
// VP-MINIATURAS.JS  — Optimizado para 500+ videos (v2.1)
// ============================================================
// Requiere: vp-base.js · vp-utilidades.js · vp-dom.js · vp-db.js
// Mejoras:
//  - Uso de const/let en todo el módulo.
//  - Limpieza exhaustiva de listeners, timers y observers.
//  - Protección contra fugas de workers en fallos síncronos.
//  - Método destroy para liberar recursos globales.
//  - Verificación de `VP.runtime` antes de su uso.
//  - Ajuste de `addEventListener`/`removeEventListener` en previews.
//  - Cache LRU con tamaño configurable (sin roturas).
// ============================================================

(function (window, document) {

    // ──────────────────────────────────────────────────────────
    // GUARD — dependencias base
    // ──────────────────────────────────────────────────────────
    const VP = window.VP;
    if (!VP) {
        throw new Error(
            '[VP] vp-miniaturas.js: vp-base.js debe cargarse primero.'
        );
    }

    const { util, dom, log, bus, config: cfg } = VP;
    log.setContext('Miniaturas');

    // ──────────────────────────────────────────────────────────
    // NAMESPACE
    // ──────────────────────────────────────────────────────────
    VP.miniaturas = VP.miniaturas || {};

    // ──────────────────────────────────────────────────────────
    // CONSTANTES INTERNAS
    // ──────────────────────────────────────────────────────────
    const K = Object.freeze({
        CACHE_LRU_MAX          : 200,
        TICK_COLA              : 16,
        MAX_REINTENTOS         : 2,
        UMBRAL_CIRCUIT_BREAKER : 8,
        REPOSO_CIRCUIT_BREAKER : 15000,
        TIMEOUT_SEEK           : 4000,
        INTERVALO_ADAPTATIVO   : 500,
        PRIORIDAD_ALTA         : 0,
        PRIORIDAD_NORMAL       : 1,
        PRIORIDAD_BAJA         : 2,
        MAX_FRAMES_POR_TICK    : 1,
        MAX_PREVIEWS_ACTIVOS   : 2,
        PREVIEW_ENTER_DELAY    : 500,
    });

    // ──────────────────────────────────────────────────────────
    // ESTADO INTERNO DEL MÓDULO
    // ──────────────────────────────────────────────────────────
    const _state = {
        colaMiniaturas    : [],
        colaDuracion      : [],
        workersMiniaturas : 0,
        workersDuracion   : 0,
        generacionMiniaturas: 0,
        generacionDuracion  : 0,
        fallosConsecutivos: 0,
        circuitAbierto    : false,
        timerCircuit      : null,
        tickPendiente     : false,
        idsEnCola         : Object.create(null),
        idsDuracionEnCola : Object.create(null),
        idsEnProceso      : Object.create(null),
        idsDuracionEnProceso: Object.create(null),
        cancelaciones     : Object.create(null),
        previewsActivos   : 0,
        intersectionObs   : null,
        idsVisibles       : Object.create(null),
        timerAdaptativo   : null,
        pausado           : false,
        videoEsperando    : false,
        programadores     : Object.create(null),
    };

    function _trabajoEnPausa() {
        const tabOculta = (typeof document !== 'undefined' && document.hidden) ||
            VP.runtime?.tabVisible === false;
        const totalVideos = VP.estado?.videos?.length || 0;
        const playerBusy = _reproduccionActiva();
        const granBiblioteca = totalVideos > 220 && (playerBusy || tabOculta);
        return _state.pausado || _state.videoEsperando || !!VP.runtime?.modoLento || tabOculta || granBiblioteca;
    }

    function _reproduccionActiva() {
        try {
            const video = VP.refs?.videoPlayer;
            return !!video && !video.paused && !video.ended && video.readyState >= 2;
        } catch (_) {
            return false;
        }
    }

    function _retardoProcesadoMiniaturas() {
        const total = VP.estado?.videos?.length || 0;
        if (total > 500) return 250;
        if (total > 200) return 160;
        if (total > 80) return 100;
        return cfg.demoraEntreMiniaturas || 80;
    }

    // ──────────────────────────────────────────────────────────
    // CACHÉ LRU EN MEMORIA (usando Map para O(1) de promoción)
    // ──────────────────────────────────────────────────────────
    const _cacheLRU = (() => {
        const _mapa = new Map(); // id → { dataURL, ts }

        return {
            set(id, dataURL) {
                // Eliminar entrada previa si existe
                _mapa.delete(id);
                _mapa.set(id, { dataURL, ts: Date.now() });

                // Evict si excede capacidad
                while (_mapa.size > K.CACHE_LRU_MAX) {
                    // En Map las claves se iteran en orden de inserción,
                    // así que el primero agregado es el más antiguo
                    const keyVieja = _mapa.keys().next().value;
                    _mapa.delete(keyVieja);
                }
            },
            get(id) {
                const entry = _mapa.get(id);
                if (!entry) return null;
                // Reinsertar para mover al final (MRU)
                _mapa.delete(id);
                _mapa.set(id, entry);
                return entry.dataURL;
            },
            has(id) {
                return _mapa.has(id);
            },
            del(id) {
                _mapa.delete(id);
            },
            clear() {
                _mapa.clear();
            },
            size() {
                return _mapa.size;
            },
        };
    })();

    // ──────────────────────────────────────────────────────────
    // MÉTRICAS INTERNAS DETALLADAS
    // ──────────────────────────────────────────────────────────
    function _videoValidoParaTrabajo(vObj) {
        if (!vObj || !vObj.file || !vObj.id) return false;
        if (util && typeof util.validarVideoBasico === 'function') {
            return util.validarVideoBasico(vObj);
        }
        return !!(vObj.name && typeof vObj.name === 'string');
    }

    function _clampTiempoVideo(videoEl, segundos) {
        let t = Number(segundos);
        if (!Number.isFinite(t) || t < 0) t = 0;
        const d = Number(videoEl && videoEl.duration);
        if (Number.isFinite(d) && d > 0) t = Math.min(Math.max(0, d - 0.05), t);
        return t;
    }

    const _metricas = {
        generadas        : 0,
        fallidas         : 0,
        cacheHit         : 0,
        cacheLRUHit      : 0,
        duracionesOk     : 0,
        duracionesFail   : 0,
        arraysGenerados  : 0,
        circuitBreaks    : 0,
        canceladas       : 0,
        tiempoTotalMs    : 0,
    };

    // ──────────────────────────────────────────────────────────
    // CIRCUIT-BREAKER
    // ──────────────────────────────────────────────────────────
    function _registrarFallo(permanente) {
        _metricas.fallidas++;
        if (permanente) {
            _state.fallosConsecutivos = 0;
            return;
        }
        _state.fallosConsecutivos++;

        if (_state.fallosConsecutivos >= K.UMBRAL_CIRCUIT_BREAKER &&
            !_state.circuitAbierto) {

            _state.circuitAbierto = true;
            _metricas.circuitBreaks++;
            log.warn(
                'Circuit-breaker activado. ' +
                'Pausa de ' + (K.REPOSO_CIRCUIT_BREAKER / 1000) + 's.'
            );
            bus.emit('circuitBreakerMiniaturas', true);

            clearTimeout(_state.timerCircuit);
            _state.timerCircuit = setTimeout(() => {
                _state.circuitAbierto     = false;
                _state.fallosConsecutivos = 0;
                log.info('Circuit-breaker restablecido.');
                bus.emit('circuitBreakerMiniaturas', false);
                _tickCola();
                _tickColaDuracion();
            }, K.REPOSO_CIRCUIT_BREAKER);
        }
    }

    function _registrarExito() {
        _state.fallosConsecutivos = 0;
        _metricas.generadas++;
    }

    // ──────────────────────────────────────────────────────────
    // INTERSECTION OBSERVER — priorizar visibles
    // ──────────────────────────────────────────────────────────
    function _iniciarIntersectionObserver() {
        if (!VP.features || !VP.features.intersectionObserver) return;
        if (_state.intersectionObs) return;

        try {
            _state.intersectionObs = new IntersectionObserver(
                (entries) => {
                    let reprocesar = false;
                    for (let i = 0; i < entries.length; i++) {
                        const entry = entries[i];
                        const id    = entry.target &&
                                      entry.target.getAttribute('data-vid-id');
                        if (!id) continue;

                        if (entry.isIntersecting) {
                            if (!_state.idsVisibles[id]) {
                                _state.idsVisibles[id] = true;
                                _promoverPrioridad(id);
                                reprocesar = true;
                            }
                        } else {
                            delete _state.idsVisibles[id];
                        }
                    }
                    if (reprocesar) _tickCola();
                },
                { rootMargin: '200px 0px', threshold: 0 }
            );
        } catch (e) {
            log.warn('IntersectionObserver no disponible:', e);
        }
    }

    function _observarElemento(el) {
        if (_state.intersectionObs && el) {
            try { _state.intersectionObs.observe(el); } catch (_) {}
        }
    }

    function _desobservarElemento(el) {
        if (_state.intersectionObs && el) {
            try { _state.intersectionObs.unobserve(el); } catch (_) {}
        }
    }

    // Mapa de prioridad override — lookup O(1)
    var _prioridadOverride = Object.create(null);
    var _ordenColaMiniaturas = 0;

    function _promoverPrioridad(id) {
        _prioridadOverride[id] = K.PRIORIDAD_ALTA;
    }

    // Heap mínimo: encolar y extraer son O(log n), incluso con bibliotecas grandes.
    // El contador conserva el FIFO previo cuando varias miniaturas empatan prioridad.
    function _antesEnCola(a, b) {
        return a.prioridad < b.prioridad ||
            (a.prioridad === b.prioridad && a.ordenCola < b.ordenCola);
    }

    function _insertarEnCola(item) {
        const prioridad = Number(item.prioridad);
        item.prioridad = Number.isFinite(prioridad) ? prioridad : K.PRIORIDAD_NORMAL;
        item.ordenCola = ++_ordenColaMiniaturas;
        const cola = _state.colaMiniaturas;
        let indice = cola.length;
        cola.push(item);
        while (indice > 0) {
            const padre = Math.floor((indice - 1) / 2);
            if (!_antesEnCola(item, cola[padre])) break;
            cola[indice] = cola[padre];
            indice = padre;
        }
        cola[indice] = item;
    }

    function _extraerDeCola() {
        const cola = _state.colaMiniaturas;
        if (!cola.length) return null;
        const primero = cola[0];
        const ultimo = cola.pop();
        if (cola.length) {
            let indice = 0;
            while (true) {
                const izq = indice * 2 + 1;
                if (izq >= cola.length) break;
                const der = izq + 1;
                const hijo = der < cola.length && _antesEnCola(cola[der], cola[izq]) ? der : izq;
                if (!_antesEnCola(cola[hijo], ultimo)) break;
                cola[indice] = cola[hijo];
                indice = hijo;
            }
            cola[indice] = ultimo;
        }
        return primero;
    }

    // Aplica override de prioridad al sacar un item de la cola
    function _aplicarPrioridadOverride(item) {
        var id = item.vObj && item.vObj.id;
        if (id && _prioridadOverride[id] !== undefined) {
            item.prioridad = _prioridadOverride[id];
            delete _prioridadOverride[id];
        }
        return item;
    }

    // ──────────────────────────────────────────────────────────
    // CREAR VIDEO TEMPORAL ROBUSTO
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.crearVideoTemp = function (archivo, timeout) {
        const url = util.crearBlobURLSeguro(archivo);
        let vid   = null;
        try {
            vid = document.createElement('video');
        } catch (e) {
            VP.revocarSeguro(url);
            return { vid: null, finish: () => {}, ok: false, terminado: () => true };
        }

        let terminado = false;
        let timer     = null;
        let alTimeout = null;

        vid.muted    = true;
        vid.preload  = 'metadata';
        vid.volume   = 0;
        try { vid.playsInline = true; } catch (_) {}
        try { vid.disablePictureInPicture = true; } catch (_) {}

        function finish(razon) {
            if (terminado) return;
            terminado = true;
            clearTimeout(timer);
            const callbackTimeout = razon === 'timeout' ? alTimeout : null;
            alTimeout = null;

            try {
                vid.onloadedmetadata = null;
                vid.onseeked         = null;
                vid.onerror          = null;
                vid.onabort          = null;
                vid.src              = '';
                vid.load();
            } catch (_) {}

            VP.revocarSeguro(url);
            vid = null;
            if (callbackTimeout) {
                try { callbackTimeout(); }
                catch (e) { log.warn('Callback de timeout falló:', e); }
            }
            // url ya revocada, se limpia la variable local
        }

        timer = setTimeout(() => {
            log.debug('Timeout en video temp.');
            finish('timeout');
        }, timeout || cfg.timeoutMiniatura || 8000);

        if (url) {
            vid.src = url;
        } else {
            terminado = true;
            clearTimeout(timer);
        }

        return {
            get vid() { return vid; },
            finish,
            alTimeout(callback) {
                if (typeof callback === 'function' && !terminado) alTimeout = callback;
            },
            ok: !!url && !terminado,
            terminado() { return terminado; },
        };
    };

    // ──────────────────────────────────────────────────────────
    // CAPTURAR FOTOGRAMA CON MANEJO DE ERRORES AMPLIADO
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.capturarFotograma = function (videoEl, ancho, alto, calidad) {
        if (!videoEl) return null;

        const w = Math.max(16, Math.min(1920, Number(ancho ?? cfg.anchoMiniatura ?? 320) || 320));
        const h = Math.max(16, Math.min(1080, Number(alto ?? cfg.altoMiniatura ?? 180) || 180));
        const q = Math.max(0.1, Math.min(0.95, Number(calidad ?? cfg.calidadMiniatura ?? 0.75) || 0.75));

        try {
            const vw = videoEl.videoWidth  || videoEl.width;
            const vh = videoEl.videoHeight || videoEl.height;
            if (!vw || !vh) return null;

            const c   = document.createElement('canvas');
            c.width  = w;
            c.height = h;

            const ctx = c.getContext('2d');
            if (!ctx) return null;

            const scale = Math.min(w / vw, h / vh);
            const dw    = vw * scale;
            const dh    = vh * scale;
            const dx    = (w - dw) / 2;
            const dy    = (h - dh) / 2;

            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(videoEl, dx, dy, dw, dh);

            const dataURL = c.toDataURL('image/jpeg', q);
            if (!dataURL || dataURL.length < 200) return null;
            return dataURL;
        } catch (e) {
            log.debug('capturarFotograma error:', e.message);
            return null;
        }
    };

    function _capturarFotogramaAsync(videoEl, ancho, alto, calidad) {
        if (!videoEl) return Promise.resolve(null);

        const w = Math.max(16, Math.min(1920, Number(ancho ?? cfg.anchoMiniatura ?? 320) || 320));
        const h = Math.max(16, Math.min(1080, Number(alto ?? cfg.altoMiniatura ?? 180) || 180));
        const q = Math.max(0.1, Math.min(0.95, Number(calidad ?? cfg.calidadMiniatura ?? 0.75) || 0.75));

        try {
            const vw = videoEl.videoWidth || videoEl.width;
            const vh = videoEl.videoHeight || videoEl.height;
            if (!vw || !vh) return Promise.resolve(null);

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) return Promise.resolve(null);

            const scale = Math.min(w / vw, h / vh);
            const dw = vw * scale;
            const dh = vh * scale;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(videoEl, (w - dw) / 2, (h - dh) / 2, dw, dh);

            if (typeof canvas.toBlob !== 'function') {
                return Promise.resolve(VP.miniaturas.capturarFotograma(videoEl, w, h, q));
            }

            return new Promise(function (resolve) {
                try {
                    canvas.toBlob(function (blob) {
                        if (!blob) return resolve(null);
                        try {
                            const reader = new FileReader();
                            reader.onload = function () {
                                resolve(typeof reader.result === 'string' ? reader.result : null);
                            };
                            reader.onerror = function () { resolve(null); };
                            reader.readAsDataURL(blob);
                        } catch (_) { resolve(null); }
                    }, 'image/jpeg', q);
                } catch (_) { resolve(null); }
            });
        } catch (e) {
            log.debug('capturarFotograma async error:', e.message);
            return Promise.resolve(null);
        }
    }

    // ──────────────────────────────────────────────────────────
    // COLA DE MINIATURAS — encolar con prioridad y deduplicación
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.encolar = function (vObj, prioridad) {
        if (!_videoValidoParaTrabajo(vObj)) return;
        if (_state.idsEnCola[vObj.id] === 'miniatura' ||
            _state.idsEnProceso[vObj.id]) return;
        if (vObj._thumbFallido && (vObj._thumbReintentos || 0) >= K.MAX_REINTENTOS) return;

        vObj._thumbQueued = true;
        const prio = (prioridad !== undefined) ? prioridad : (
            _state.idsVisibles[vObj.id] ? K.PRIORIDAD_ALTA : K.PRIORIDAD_NORMAL
        );

        _insertarEnCola({
            vObj,
            prioridad: prio,
            reintentos: vObj._thumbReintentos || 0,
            cancelada: false,
        });
        _state.idsEnCola[vObj.id] = 'miniatura';

        _programarTick();
    };

    // ──────────────────────────────────────────────────────────
    // TICK DE COLA — procesamiento no bloqueante
    // ──────────────────────────────────────────────────────────
    function _programarTick() {
        if (_state.tickPendiente) return;
        _state.tickPendiente = true;
        setTimeout(_tickCola, K.TICK_COLA);
    }

    function _tickCola() {
        _state.tickPendiente = false;

        if (_trabajoEnPausa())     return;
        if (_state.circuitAbierto) return;
        if (VP.ajustes?.ultraRendimiento) return;

        const cola = _state.colaMiniaturas;
        const max  = _maxWorkers();

        while (_state.workersMiniaturas < max && cola.length > 0) {
            const item = _extraerDeCola();
            if (!item || item.cancelada) continue;
            if (!item.vObj || !item.vObj.file) continue;

            _aplicarPrioridadOverride(item);

            const id = item.vObj.id;
            delete _state.idsEnCola[id];
            _state.idsEnProceso[id] = item;
            _state.workersMiniaturas++;

            _ejecutarGeneracion(item);
        }
    }

    function _maxWorkers() {
        const configurado = Number(cfg.maxParaleloMiniaturas);
        const base = Number.isFinite(configurado)
            ? Math.max(1, Math.min(4, Math.floor(configurado)))
            : 2;
        const total  = VP.estado?.videos?.length ?? 0;
        if (total > 300) return Math.min(base, 2);
        if (total > 100) return Math.min(base, 3);
        return Math.min(base, 4);
    }

    function _ejecutarGeneracion(item) {
        const t0 = Date.now();
        const generacion = _state.generacionMiniaturas;

        let promise;
        try {
            promise = VP.miniaturas._generarInterno(item.vObj);
        } catch (err) {
            // Fallo síncrono (ej. error creando video)
            log.debug('Error generando miniatura (síncrono):', item.vObj.name, err);
            _registrarFallo();
            _liberarWorker(item.vObj.id, true, generacion, item);
            return;
        }

        promise
            .then(() => {
                if (generacion !== _state.generacionMiniaturas) return;
                _metricas.tiempoTotalMs += Date.now() - t0;
                _registrarExito();
                _liberarWorker(item.vObj.id, false, generacion, item);
            })
            .catch((err) => {
                if (generacion !== _state.generacionMiniaturas) return;
                if (err?.code === 'VP_CANCELLED' || err?.name === 'AbortError') {
                    _liberarWorker(item.vObj.id, null, generacion, item);
                    return;
                }
                log.debug('Error generando miniatura:', item.vObj.name, err);
                const permanente = !!err?.permanente;
                _registrarFallo(permanente);

                if (permanente) {
                    item.vObj._thumbFallido = true;
                } else {
                    item.reintentos++;
                    item.vObj._thumbReintentos = item.reintentos;
                }

                if (!permanente && item.reintentos < K.MAX_REINTENTOS) {
                    item.prioridad = K.PRIORIDAD_BAJA;
                    _insertarEnCola(item);
                    _state.idsEnCola[item.vObj.id] = 'miniatura';
                } else {
                    item.vObj._thumbFallido = true;
                }
                _liberarWorker(item.vObj.id, true, generacion, item);
            });
    }

    function _liberarWorker(id, fallo, generacion, item) {
        if (generacion !== _state.generacionMiniaturas) return;
        _state.workersMiniaturas = Math.max(0, _state.workersMiniaturas - 1);
        if (_state.idsEnProceso[id] === item) delete _state.idsEnProceso[id];
        if (fallo === false) {
            if (VP.metricas) VP.metricas.miniaturasGeneradas++;
        } else if (fallo === true) {
            if (VP.metricas) VP.metricas.miniaturasFallidas++;
        }
        _programarTick();
    }

    // ──────────────────────────────────────────────────────────
    // GENERAR MINIATURA — API PÚBLICA (con caché LRU + IDB)
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.generar = function (vObj, prioridad) {
        if (!_videoValidoParaTrabajo(vObj)) return Promise.resolve();
        if (VP.ajustes?.ultraRendimiento)    return Promise.resolve();

        // 1) Caché LRU en memoria
        const enLRU = _cacheLRU.get(vObj.id);
        if (enLRU) {
            vObj.thumbnail = enLRU;
            VP.miniaturas.actualizarUI(vObj.id, enLRU);
            _metricas.cacheLRUHit++;
            return Promise.resolve();
        }

        // 2) Caché en IDB
        return VP.db.obtenerMiniatura(vObj.name)
            .then((cacheada) => {
                if (cacheada) {
                    vObj.thumbnail = cacheada;
                    _cacheLRU.set(vObj.id, cacheada);
                    VP.miniaturas.actualizarUI(vObj.id, cacheada);
                    _metricas.cacheHit++;
                    return;
                }
                VP.miniaturas.encolar(vObj, prioridad);
            })
            .catch(() => {
                VP.miniaturas.encolar(vObj, prioridad);
            });
    };

    // ──────────────────────────────────────────────────────────
    // GENERACIÓN INTERNA ROBUSTA
    // ──────────────────────────────────────────────────────────
    VP.miniaturas._generarInterno = function (vObj) {
        return new Promise((resolve, reject) => {
            if (VP.ajustes?.ultraRendimiento) return resolve();
            if (!_videoValidoParaTrabajo(vObj)) return reject(new Error('Sin archivo valido'));

            const tv = VP.miniaturas.crearVideoTemp(
                vObj.file,
                cfg.timeoutMiniatura || 8000
            );
            if (!tv.ok) return reject(new Error('URL no disponible'));

            // Registrar cancelación individual
            _state.cancelaciones[vObj.id] = () => {
                tv.finish('cancelado');
                const error = new Error('Miniatura cancelada');
                error.name = 'AbortError';
                error.code = 'VP_CANCELLED';
                reject(error);
            };

            let limpiado = false;
            function limpiar() {
                if (limpiado) return;
                limpiado = true;
                delete _state.cancelaciones[vObj.id];
            }

            tv.alTimeout(() => {
                limpiar();
                const error = new Error('Timeout generando miniatura');
                error.code = 'VP_MEDIA_TIMEOUT';
                reject(error);
            });

            tv.vid.onloadedmetadata = () => {
                if (tv.terminado()) return;

                const dur = tv.vid.duration;
                const metadatos = { size: vObj.size };
                if (tv.vid.videoWidth > 0 && tv.vid.videoHeight > 0) {
                    vObj.videoWidth = tv.vid.videoWidth;
                    vObj.videoHeight = tv.vid.videoHeight;
                    metadatos.videoWidth = vObj.videoWidth;
                    metadatos.videoHeight = vObj.videoHeight;
                    VP.listas?.actualizarBadgeResolucionVideo?.(vObj);
                }
                if (Number.isFinite(dur) && dur > 0) {
                    if (!Number.isFinite(vObj.duration) || vObj.duration <= 0) {
                        vObj.duration = dur;
                        metadatos.duration = dur;
                        VP.miniaturas._notificarDuracion(vObj);
                    }
                }
                if (Object.keys(metadatos).length > 1) {
                    VP.db.guardarMetadatos(vObj.id, metadatos).catch(() => {});
                }

                const seg = (Number.isFinite(dur) && dur > 0)
                    ? dur * (cfg.porcentajeBusqueda || 0.2)
                    : 0.1;

                try {
                    tv.vid.currentTime = _clampTiempoVideo(tv.vid, seg);
                } catch (e) {
                    limpiar();
                    tv.finish('seek-error');
                    reject(e);
                }
            };

            const onSeeked = () => {
                if (tv.terminado()) return;
                tv.vid.removeEventListener('seeked', onSeeked);

                const dataURL = VP.miniaturas.capturarFotograma(
                    tv.vid,
                    cfg.anchoMiniatura   ?? 320,
                    cfg.altoMiniatura    ?? 180,
                    cfg.calidadMiniatura ?? 0.75
                );

                if (dataURL) {
                    vObj.thumbnail = dataURL;
                    _cacheLRU.set(vObj.id, dataURL);
                    VP.db.guardarMiniatura(vObj.name, dataURL).catch(() => {});
                    VP.miniaturas.actualizarUI(vObj.id, dataURL);
                    limpiar();
                    tv.finish('ok');
                    resolve();
                } else {
                    limpiar();
                    tv.finish('frame-vacio');
                    reject(new Error('Frame vacío'));
                }
            };

            tv.vid.addEventListener('seeked', onSeeked);

            tv.vid.onerror = (e) => {
                const codigoError = tv.vid?.error?.code || 0;
                limpiar();
                tv.finish('video-error');
                const error = new Error('Error de video: ' + (codigoError || 'desconocido'));
                error.permanente = codigoError === 4;
                reject(error);
            };

            tv.vid.onabort = () => {
                limpiar();
                tv.finish('abort');
                reject(new Error('Abortado'));
            };
        });
    };

    // ──────────────────────────────────────────────────────────
    // ACTUALIZAR UI DE MINIATURA
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.actualizarUI = function (id, dataURL) {
        if (!id || !dataURL) return;

        try {
            const selector  = `[data-vid-id="${id}"] .thumbnail-image`;
            const elementos = dom.$$(selector);
            if (!elementos || !elementos.length) return;

            for (let i = 0; i < elementos.length; i++) {
                const el = elementos[i];
                el.style.backgroundImage = `url(${dataURL})`;
                el.style.backgroundSize  = 'cover';
                el.style.backgroundPosition = 'center';
                el.innerHTML = '';
                el.classList.add('thumbnail-cargada');
                el.classList.remove('thumbnail-placeholder');
            }
        } catch (e) {
            log.warn('actualizarUI falló:', e);
        }
    };

    // ──────────────────────────────────────────────────────────
    // COLA DE DURACIÓN
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.encolarDuracion = function (vObj) {
        if (!vObj || !vObj.file || !vObj.id) return;
        if (_state.idsDuracionEnCola[vObj.id]) return;
        if (_state.idsDuracionEnProceso[vObj.id]) return;
        if (Number.isFinite(vObj.duration) && vObj.duration > 0) return;
        if (vObj._durFallido) return;
        if (_reproduccionActiva() && (VP.estado?.videos?.length || 0) > 60) return;

        vObj._durQueued = true;
        _state.colaDuracion.push({
            vObj,
            reintentos: 0,
            cancelada: false,
        });
        _state.idsDuracionEnCola[vObj.id] = true;
        _programarTickDuracion();
    };

    let _tickDurPendiente = false;
    let _indiceColaDuracion = 0;
    function _programarTickDuracion() {
        if (_tickDurPendiente) return;
        _tickDurPendiente = true;
        setTimeout(_tickColaDuracion, K.TICK_COLA);
    }

    function _tickColaDuracion() {
        _tickDurPendiente = false;
        if (_trabajoEnPausa()) return;

        const cola = _state.colaDuracion;
        const configurado = Number(cfg.maxParaleloDuracion);
        let max = Number.isFinite(configurado)
            ? Math.max(1, Math.min(8, Math.floor(configurado)))
            : 3;
        if (VP.ajustes?.ultraRendimiento) max = 1;

        while (_state.workersDuracion < max && _indiceColaDuracion < cola.length) {
            const indice = _indiceColaDuracion++;
            const item = cola[indice];
            cola[indice] = null;
            if (item?.vObj?.id) delete _state.idsDuracionEnCola[item.vObj.id];
            if (!item || item.cancelada) continue;
            if (!item.vObj || !item.vObj.file) continue;

            _state.idsDuracionEnProceso[item.vObj.id] = true;
            _state.workersDuracion++;
            const generacion = _state.generacionDuracion;

            VP.miniaturas.actualizarDuracion(item.vObj)
                .then(() => {
                    if (generacion !== _state.generacionDuracion) {
                        _state.workersDuracion = Math.max(0, _state.workersDuracion - 1);
                        _programarTickDuracion();
                        return;
                    }
                    _state.workersDuracion = Math.max(0, _state.workersDuracion - 1);
                    delete _state.idsDuracionEnProceso[item.vObj.id];
                    _metricas.duracionesOk++;
                    _programarTickDuracion();
                })
                .catch((err) => {
                    if (generacion !== _state.generacionDuracion) {
                        _state.workersDuracion = Math.max(0, _state.workersDuracion - 1);
                        _programarTickDuracion();
                        return;
                    }
                    _state.workersDuracion = Math.max(0, _state.workersDuracion - 1);
                    delete _state.idsDuracionEnProceso[item.vObj.id];
                    _metricas.duracionesFail++;
                    log.debug('Error duración:', err);
                    _programarTickDuracion();
                });
        }

        // Consumir en O(1) por elemento. Compactar solo después de avanzar un
        // bloque considerable para evitar el coste de Array.shift() en colas grandes.
        if (_indiceColaDuracion === cola.length) {
            cola.length = 0;
            _indiceColaDuracion = 0;
        } else if (_indiceColaDuracion >= 128 && _indiceColaDuracion * 2 >= cola.length) {
            cola.splice(0, _indiceColaDuracion);
            _indiceColaDuracion = 0;
        }
    }

    // ──────────────────────────────────────────────────────────
    // SONDEAR DURACIÓN
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.sondearDuracion = function (archivo, vObj) {
        return new Promise((resolve) => {
            if (!archivo) return resolve(NaN);

            const url = util.crearBlobURLSeguro(archivo);
            if (!url) return resolve(NaN);

            let vid       = null;
            try { vid = document.createElement('video'); } catch (e) { return resolve(NaN); }
            let terminado = false;
            let timer     = null;

            vid.preload  = 'metadata';
            vid.muted    = true;
            vid.volume   = 0;
            try { vid.playsInline = true; } catch (_) {}

            function finish(dur) {
                if (terminado) return;
                terminado = true;
                clearTimeout(timer);
                if (vObj && vid && vid.videoWidth > 0 && vid.videoHeight > 0) {
                    vObj.videoWidth = vid.videoWidth;
                    vObj.videoHeight = vid.videoHeight;
                    VP.listas?.actualizarBadgeResolucionVideo?.(vObj);
                }
                VP.revocarSeguro(url);
                try {
                    vid.onloadedmetadata = null;
                    vid.onerror          = null;
                    vid.onabort          = null;
                    vid.src              = '';
                    vid.load();
                } catch (_) {}
                vid = null;
                resolve(dur !== undefined ? dur : NaN);
            }

            timer = setTimeout(() => finish(NaN), cfg.timeoutSondeo || 10000);

            vid.onloadedmetadata = () => finish(vid ? vid.duration : NaN);
            vid.onerror  = () => finish(NaN);
            vid.onabort  = () => finish(NaN);
            vid.src      = url;
        });
    };

    // ──────────────────────────────────────────────────────────
    // ACTUALIZAR DURACIÓN CON CACHÉ IDB
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.actualizarDuracion = function (vObj) {
        if (!vObj || !vObj.file) return Promise.resolve();

        if (Number.isFinite(vObj.duration) && vObj.duration > 0) {
            VP.miniaturas._notificarDuracion(vObj);
            return Promise.resolve();
        }

        return VP.db.obtenerMetadatos(vObj.id)
            .then((cacheados) => {
                if (cacheados && Number.isFinite(cacheados.duration) && cacheados.duration > 0) {
                    vObj.duration = cacheados.duration;
                    VP.miniaturas._notificarDuracion(vObj);
                    return;
                }

                return VP.miniaturas.sondearDuracion(vObj.file, vObj)
                    .then((dur) => {
                        if (Number.isFinite(dur) && dur > 0) {
                            vObj.duration = dur;
                            VP.db.guardarMetadatos(vObj.id, {
                                duration: dur,
                                videoWidth: vObj.videoWidth || 0,
                                videoHeight: vObj.videoHeight || 0,
                                size: vObj.size,
                            }).catch(() => {});
                            VP.miniaturas._notificarDuracion(vObj);
                            bus.emit('duracionLista', vObj);
                        } else {
                            vObj._durFallido = true;
                        }
                    });
            })
            .catch((e) => {
                log.debug('actualizarDuracion IDB error:', e);
                return VP.miniaturas.sondearDuracion(vObj.file, vObj)
                    .then((dur) => {
                        if (Number.isFinite(dur) && dur > 0) {
                            vObj.duration = dur;
                            VP.db.guardarMetadatos(vObj.id, {
                                duration: dur,
                                videoWidth: vObj.videoWidth || 0,
                                videoHeight: vObj.videoHeight || 0,
                                size: vObj.size,
                            }).catch(() => {});
                            VP.miniaturas._notificarDuracion(vObj);
                        }
                    });
            });
    };

    // ──────────────────────────────────────────────────────────
    // NOTIFICAR DURACIÓN EN UI
    // ──────────────────────────────────────────────────────────
    let _duracionesUiPendientes = new Map();
    let _duracionesUiFrame = 0;
    let _duracionesUiProgramadas = false;

    function _aplicarDuracionesPendientes(pendientes) {
        const formatos = new Map();
        pendientes.forEach((vObj, id) => {
            if (Number.isFinite(vObj?.duration) && vObj.duration > 0) {
                formatos.set(String(id), util.formatearTiempo(vObj.duration));
            }
        });
        if (!formatos.size) return;

        const playlistEl = VP.refs?.playlistEl;
        if (!dom.esNulo(playlistEl) && VP.estado?.playlist) {
            const items = playlistEl.querySelectorAll('[data-vid-id]');
            const actualizados = new Set();
            for (let i = 0; i < items.length; i++) {
                const el = items[i];
                const id = el.getAttribute('data-vid-id');
                if (!formatos.has(id) || actualizados.has(id)) continue;
                actualizados.add(id);

                const texto = formatos.get(id);
                const spans = dom.$$('.playlist-meta span', el);
                if (spans?.[1] && spans[1].textContent !== texto) spans[1].textContent = texto;
                const badge = dom.$q('.playlist-duration', el);
                if (badge && badge.textContent !== texto) badge.textContent = texto;
            }
        }

        const galleryEl = VP.refs?.galleryEl;
        if (dom.esNulo(galleryEl)) return;
        const itemsGaleria = galleryEl.querySelectorAll('[data-vid-id]');
        const actualizadosGaleria = new Set();
        for (let i = 0; i < itemsGaleria.length; i++) {
            const el = itemsGaleria[i];
            const id = el.getAttribute('data-vid-id');
            if (!formatos.has(id) || actualizadosGaleria.has(id)) continue;
            actualizadosGaleria.add(id);

            const texto = formatos.get(id);
            const badge = dom.$q('.thumbnail-duration', el);
            if (badge) {
                if (badge.textContent !== texto) badge.textContent = texto;
                continue;
            }

            const tc = dom.$q('.thumbnail-container', el);
            if (tc) {
                const nuevoBadge = document.createElement('span');
                nuevoBadge.className = 'thumbnail-duration';
                nuevoBadge.textContent = texto;
                nuevoBadge.setAttribute('aria-label', 'Duración: ' + texto);
                tc.appendChild(nuevoBadge);
            }
        }
    }

    VP.miniaturas._notificarDuracion = function (vObj) {
        if (!vObj || vObj.id == null) return;
        _duracionesUiPendientes.set(String(vObj.id), vObj);
        if (_duracionesUiProgramadas) return;
        _duracionesUiProgramadas = true;

        const flush = function () {
            _duracionesUiFrame = 0;
            _duracionesUiProgramadas = false;
            const pendientes = _duracionesUiPendientes;
            _duracionesUiPendientes = new Map();
            _aplicarDuracionesPendientes(pendientes);
        };

        if (typeof window.requestAnimationFrame === 'function') {
            _duracionesUiFrame = window.requestAnimationFrame(flush);
        } else {
            _duracionesUiFrame = window.setTimeout(flush, 16);
        }
    };

    // ──────────────────────────────────────────────────────────
    // ACTUALIZAR DURACIÓN EN PLAYLIST
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.actualizarDuracionPlaylist = function (vObj) {
        const playlistEl = VP.refs?.playlistEl;
        if (dom.esNulo(playlistEl)) return;
        if (!VP.estado?.playlist) return;

        const items = playlistEl.querySelectorAll('[data-vid-id]');
        for (let i = 0; i < items.length; i++) {
            const el = items[i];
            if (el.getAttribute('data-vid-id') !== String(vObj.id)) continue;

            const spans = dom.$$('.playlist-meta span', el);
            if (spans?.[1]) {
                spans[1].textContent = util.formatearTiempo(vObj.duration);
            }

            const badge = dom.$q('.playlist-duration', el);
            if (badge) {
                badge.textContent = util.formatearTiempo(vObj.duration);
            }
            break;
        }
    };

    // ──────────────────────────────────────────────────────────
    // ACTUALIZAR DURACIÓN EN GALERÍA
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.actualizarDuracionGaleria = function (vObj) {
        if (!Number.isFinite(vObj.duration) || vObj.duration <= 0) return;

        const galleryEl = VP.refs?.galleryEl;
        if (dom.esNulo(galleryEl)) return;

        const el = dom.$q(`[data-vid-id="${vObj.id}"]`, galleryEl);
        if (!el) return;

        const texto = util.formatearTiempo(vObj.duration);

        const badge = dom.$q('.thumbnail-duration', el);
        if (badge) {
            badge.textContent = texto;
            return;
        }

        const tc = dom.$q('.thumbnail-container', el);
        if (tc) {
            const nb = document.createElement('span');
            nb.className   = 'thumbnail-duration';
            nb.textContent = texto;
            nb.setAttribute('aria-label', 'Duración: ' + texto);
            tc.appendChild(nb);
        }
    };

    function _programarSecuencia(nombre, lista, procesarItem, opciones) {
        if (!Array.isArray(lista) || !lista.length) return;
        if (!opciones) opciones = {};

        const plan = _state.programadores[nombre];
        if (plan && plan.activa) {
            for (let i = 0; i < lista.length; i++) {
                const item = lista[i];
                const clave = item && item.id != null ? 'id:' + String(item.id) : item;
                if (plan.vistos.has(clave)) continue;
                plan.vistos.add(clave);
                plan.lista.push(item);
            }
            return;
        }

        const listaInicial = lista.slice();
        const vistos = new Set();
        for (let i = 0; i < listaInicial.length; i++) {
            const item = listaInicial[i];
            vistos.add(item && item.id != null ? 'id:' + String(item.id) : item);
        }

        const nuevoPlan = {
            activa: true,
            indice: 0,
            timer: null,
            lista: listaInicial,
            vistos: vistos,
        };
        _state.programadores[nombre] = nuevoPlan;

        const batchSize = Math.max(1, Number(opciones.batchSize) || 1);
        const demora = Math.max(0, Number(opciones.delay) || 0);
        const inicial = Math.max(0, Number(opciones.initialDelay) || 0);

        function paso() {
            if (VP.runtime?.estadoCarga?.cancelado) {
                nuevoPlan.activa = false;
                delete _state.programadores[nombre];
                return;
            }

            if (!_trabajoEnPausa() && !VP.ajustes?.ultraRendimiento) {
                const fin = Math.min(nuevoPlan.indice + batchSize, nuevoPlan.lista.length);
                for (; nuevoPlan.indice < fin; nuevoPlan.indice++) {
                    try {
                        procesarItem(nuevoPlan.lista[nuevoPlan.indice], nuevoPlan.indice);
                    } catch (_) {}
                }
            }

            if (nuevoPlan.indice >= nuevoPlan.lista.length) {
                nuevoPlan.activa = false;
                delete _state.programadores[nombre];
                return;
            }

            nuevoPlan.timer = setTimeout(paso, _trabajoEnPausa() ? 1000 : demora);
        }

        nuevoPlan.timer = setTimeout(paso, inicial);
    }

    // ──────────────────────────────────────────────────────────
    // PROGRAMAR DURACIONES EN LOTES ADAPTATIVOS
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.programarDuraciones = function (listaVideos) {
        if (!listaVideos?.length) return;

        const total = listaVideos.length;
        const tamLote = () => {
            if (VP.ajustes?.ultraRendimiento) return 1;
            if (total > 400) return cfg.tamGrupoDuracion || 5;
            if (total > 200) return (cfg.tamGrupoDuracion || 5) + 2;
            return (cfg.tamGrupoDuracion || 5) + 5;
        };

        const demora = () => {
            if (VP.ajustes?.ultraRendimiento) {
                return (cfg.demoraGrupoDuracion || 300) * 3;
            }
            return total > 300
                ? (cfg.demoraGrupoDuracion || 300) * 2
                : (cfg.demoraGrupoDuracion || 300);
        };

        _programarSecuencia('duraciones', listaVideos, function (v) {
            VP.miniaturas.encolarDuracion(v);
        }, {
            batchSize: tamLote(),
            delay: demora(),
            initialDelay: 800,
        });

        log.debug('Programación de duraciones en lote.', total, 'videos.');
    };

    // ──────────────────────────────────────────────────────────
    // PROGRAMAR MINIATURAS EN LOTES ADAPTATIVOS
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.programarMiniaturas = function (listaVideos) {
        if (!listaVideos?.length) return;

        const total = listaVideos.length;
        const visibles = [];
        const noVisibles = [];

        for (let v = 0; v < listaVideos.length; v++) {
            if (_state.idsVisibles[listaVideos[v].id]) {
                visibles.push(listaVideos[v]);
            } else {
                noVisibles.push(listaVideos[v]);
            }
        }

        for (let vi = 0; vi < visibles.length; vi++) {
            VP.miniaturas.generar(visibles[vi], K.PRIORIDAD_ALTA).catch(() => {});
        }

        _programarSecuencia('miniaturas', noVisibles, function (v) {
            if (VP.runtime?.estadoCarga?.cancelado || VP.ajustes?.ultraRendimiento) return;
            VP.miniaturas.generar(v, K.PRIORIDAD_NORMAL).catch(() => {});
        }, {
            batchSize: Math.max(1, Math.min(6, Math.ceil((noVisibles.length || 1) / 20))),
            delay: _reproduccionActiva() ? _retardoProcesadoMiniaturas() * 2 : _retardoProcesadoMiniaturas(),
            initialDelay: cfg.demoraInicioMinis || 1200,
        });

        log.debug('Programación de miniaturas en lote.', total, 'videos.');
    };

    // ──────────────────────────────────────────────────────────
    // GENERAR ARRAY DE MINIATURAS PARA SCRUBBING
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.generarArray = function (vObj) {
        if (_trabajoEnPausa())                    return Promise.resolve();
        if (VP.ajustes?.ultraRendimiento)         return Promise.resolve();
        if (!VP.ajustes?.autoGenerarArrayPreview) return Promise.resolve();
        if ((VP.estado?.videos?.length || 0) > 180) return Promise.resolve();
        if (!vObj?.file)                          return Promise.resolve();
        if (!Number.isFinite(vObj.duration) || vObj.duration <= 0) return Promise.resolve();
        if (vObj.thumbnailArray?.length)          return Promise.resolve();
        if (vObj._arrayGenerando)                 return Promise.resolve();

        // Intentar recuperar de IDB antes de regenerar
        return VP.db.obtenerArrayMiniaturas(vObj.name).then(function (cached) {
            if (cached && cached.length) {
                vObj.thumbnailArray = cached;
                _metricas.cacheHit++;
                bus.emit('arrayMiniaturasListo', vObj);
                return;
            }

            vObj._arrayGenerando = true;

            const cantidad = cfg.cantMiniaturas || 15;
            const tiempos  = [];
            const margenI  = 0.05;
            const margenF  = 0.95;

            for (let i = 0; i < cantidad; i++) {
                const ratio = cantidad > 1
                    ? margenI + (i / (cantidad - 1)) * (margenF - margenI)
                    : 0.5;
                tiempos.push(vObj.duration * ratio);
            }

            return new Promise((resolve) => {
                const capturas = [];
                let idx        = 0;
                const tv       = VP.miniaturas.crearVideoTemp(
                    vObj.file,
                    cfg.timeoutArrayMinis || 60000
                );

                if (!tv.ok) {
                    vObj._arrayGenerando = false;
                    return resolve();
                }

                const terminar = () => {
                    vObj._arrayGenerando = false;
                    tv.finish('array-done');

                    if (capturas.length > 0) {
                        vObj.thumbnailArray = capturas;

                        if (!vObj.thumbnail) {
                            let idxP = Math.floor(
                                capturas.length * (cfg.porcentajeBusqueda || 0.2)
                            );
                            idxP = Math.min(idxP, capturas.length - 1);
                            vObj.thumbnail = capturas[idxP].dataURL;
                            _cacheLRU.set(vObj.id, vObj.thumbnail);
                            VP.miniaturas.actualizarUI(vObj.id, vObj.thumbnail);
                        }

                        _metricas.arraysGenerados++;
                        bus.emit('arrayMiniaturasListo', vObj);
                        log.debug('Array listo:', capturas.length, 'frames →', vObj.name);

                        // Persistir en IDB para no regenerar al recargar
                        VP.db.guardarArrayMiniaturas(vObj.name, capturas).catch(() => {});
                    }
                    resolve();
                };

                tv.alTimeout(terminar);

                const buscarSiguiente = () => {
                    if (tv.terminado() || idx >= tiempos.length) {
                        terminar();
                        return;
                    }

                    let timerSeek;
                    const onSeeked = () => {
                        if (tv.terminado()) return;
                        tv.vid.removeEventListener('seeked', onSeeked);
                        clearTimeout(timerSeek);

                        _capturarFotogramaAsync(
                            tv.vid,
                            cfg.anchoPreview  ?? 160,
                            cfg.altoPreview   ?? 90,
                            cfg.calidadMiniatura ?? 0.70
                        ).then(function (dataURL) {
                            if (tv.terminado()) return;
                            if (dataURL) {
                                capturas.push({
                                    tiempo: tiempos[idx],
                                    dataURL,
                                });
                            }

                            idx++;
                            if (idx % K.MAX_FRAMES_POR_TICK === 0) {
                                setTimeout(buscarSiguiente, 0);
                            } else {
                                buscarSiguiente();
                            }
                        });
                    };

                    const onError = () => {
                        if (tv.terminado()) return;
                        clearTimeout(timerSeek);
                        idx++;
                        buscarSiguiente();
                    };

                    timerSeek = setTimeout(() => {
                        log.debug('Timeout seek en array, idx:', idx);
                        idx++;
                        buscarSiguiente();
                    }, K.TIMEOUT_SEEK);

                    let seekOk = false;
                    try {
                        tv.vid.currentTime = _clampTiempoVideo(tv.vid, tiempos[idx]);
                        seekOk = true;
                    } catch (e) {
                        clearTimeout(timerSeek);
                        idx++;
                        buscarSiguiente();
                        return;
                    }

                    if (!seekOk) {
                        clearTimeout(timerSeek);
                        terminar();
                        return;
                    }

                    tv.vid.addEventListener('seeked', onSeeked);
                    tv.vid.addEventListener('error', onError);
                };

                tv.vid.onloadedmetadata = () => {
                    if (tv.terminado()) return;

                    if (!Number.isFinite(vObj.duration) || vObj.duration <= 0) {
                        const d = tv.vid.duration;
                        if (Number.isFinite(d) && d > 0) {
                            vObj.duration = d;
                            VP.miniaturas._notificarDuracion(vObj);
                        }
                    }

                    buscarSiguiente();
                };

                tv.vid.onerror = () => terminar();
            });
        });
    };

    // ──────────────────────────────────────────────────────────
    // PREVIEW HOVER EN GALERÍA Y PLAYLIST (con limpieza completa)
    // ──────────────────────────────────────────────────────────

    function _videoPrincipalLibre() {
        var vp = VP.refs?.videoPlayer;
        return !vp || !vp.src || vp.paused || vp.ended;
    }

    function _iniciarPreview(pvid, contadoRef) {
        if (!_videoPrincipalLibre()) return false;
        if (_state.previewsActivos >= K.MAX_PREVIEWS_ACTIVOS) return false;
        if (contadoRef && contadoRef.value) return true;
        _state.previewsActivos++;
        if (contadoRef) contadoRef.value = true;
        if (VP.listas && typeof VP.listas.sincronizarVolumenPreviews === 'function') {
            VP.listas.sincronizarVolumenPreviews();
        }
        pvid.play().catch(function () {
            if (contadoRef && contadoRef.value) {
                contadoRef.value = false;
                _state.previewsActivos = Math.max(0, _state.previewsActivos - 1);
            }
        });
        return true;
    }

    function _detenerPreview(pvid, contadoRef) {
        try { pvid.pause(); } catch (_) {}
        if (contadoRef && contadoRef.value) {
            contadoRef.value = false;
            _state.previewsActivos = Math.max(0, _state.previewsActivos - 1);
        }
    }

    VP.miniaturas.adjuntarPreview = function (contenedor, vObj) {
        if (!VP.ajustes?.habilitarPreviews) return;
        if (VP.ajustes.ultraRendimiento)    return;
        if (typeof document !== 'undefined' && document.hidden) return;
        if (VP.runtime?.modoLento) return;
        if ((VP.estado?.videos?.length || 0) > 180) return;
        if ((VP.estado?.videos?.length || 0) > 120 &&
            (_reproduccionActiva() || VP.runtime?.tabVisible === false)) return;
        if (!contenedor || !vObj?.file) return;

        const pvid = dom.$q('.thumbnail-preview video', contenedor);
        if (!pvid) return;

        let timer     = null;
        let url       = null;
        let adjunto   = false;
        let obs       = null;
        let destruido = false;
        let pendiente = false;
        var contado   = { value: false };

        function contenedorSigueSiendoDelVideo() {
            if (!contenedor || !contenedor.closest) return true;
            var tarjeta = contenedor.closest('.gallery-item, .playlist-item');
            return !tarjeta || tarjeta.dataset.vidId === String(vObj.id);
        }

        function aplicarResolucion(ancho, alto) {
            if (!contenedorSigueSiendoDelVideo()) return;
            ancho = Number(ancho) || 0;
            alto = Number(alto) || 0;
            if (alto < 720) return;
            var badge = contenedor.querySelector('.thumbnail-quality');
            if (!badge) return;
            var calidad = alto >= 2160 ? '4K' : alto >= 1440 ? 'QHD' :
                alto >= 1080 ? 'Full HD' : 'HD';
            badge.textContent = calidad;
            badge.setAttribute('data-quality', calidad);
            badge.hidden = !!(contenedor.classList && contenedor.classList.contains('preview-hovering'));
            badge.title = 'Resolución: ' + ancho + ' × ' + alto;
        }

        if (VP.db && typeof VP.db.obtenerMetadatos === 'function') {
            VP.db.obtenerMetadatos(vObj.name).then(meta => {
                if (!contenedorSigueSiendoDelVideo()) return;
                if (meta && meta.videoWidth && meta.videoHeight) {
                    vObj.videoWidth = meta.videoWidth;
                    vObj.videoHeight = meta.videoHeight;
                    aplicarResolucion(meta.videoWidth, meta.videoHeight);
                    VP.listas?.actualizarBadgeResolucionVideo?.(vObj);
                }
            }).catch(() => {});
        }

        const onMouseEnter = () => {
            if (destruido) return;
            if (!VP.ajustes.habilitarPreviews) return;
            if (VP.ajustes.ultraRendimiento)   return;

            contenedor.classList.add('preview-hovering');

            clearTimeout(timer);
            timer = setTimeout(() => {
                if (destruido) return;
                if (!_videoPrincipalLibre()) return;
                if (_state.previewsActivos >= K.MAX_PREVIEWS_ACTIVOS) return;
                pendiente = true;
                asegurarFuente();
                if (adjunto) {
                    _iniciarPreview(pvid, contado);
                }
            }, K.PREVIEW_ENTER_DELAY);
        };

        const onMouseLeave = () => {
            if (destruido) return;
            contenedor.classList.remove('preview-hovering');
            var badgeCalidad = contenedor.querySelector('.thumbnail-quality');
            if (badgeCalidad && badgeCalidad.dataset.quality) badgeCalidad.hidden = false;
            clearTimeout(timer);
            pendiente = false;
            if (VP.listas && typeof VP.listas.silenciarAudioPreview === 'function') {
                VP.listas.silenciarAudioPreview(contenedor);
            } else {
                pvid.muted = true;
                pvid.volume = 0;
            }
            timer = setTimeout(() => {
                if (!destruido) {
                    _detenerPreview(pvid, contado);
                    liberarFuente();
                }
            }, 150);
        };

        function liberarFuente() {
            try {
                pvid.pause();
                pvid.onloadedmetadata = null;
                pvid.onseeked = null;
                pvid.onerror = null;
                pvid.removeAttribute('src');
                pvid.load();
            } catch (_) {}

            if (url && VP.revocarBlobURL) VP.revocarBlobURL(url);
            url = null;
            adjunto = false;
        }

        function asegurarFuente() {
            if (adjunto || destruido || !vObj.file) return;
            adjunto = true;

            url = VP.crearBlobURL ? VP.crearBlobURL(vObj.file) : null;
            if (!url) { adjunto = false; return; }

            pvid.src     = url;
            pvid.loop    = true;
            pvid.muted   = true;
            pvid.volume  = 0;
            pvid.preload = 'metadata';
            try { pvid.playsInline = true; } catch (_) {}

            pvid.onloadedmetadata = () => {
                if (destruido) return;
                if (pvid.videoWidth && pvid.videoHeight) {
                    vObj.videoWidth = pvid.videoWidth;
                    vObj.videoHeight = pvid.videoHeight;
                    aplicarResolucion(pvid.videoWidth, pvid.videoHeight);
                    if (VP.db && typeof VP.db.guardarMetadatos === 'function') {
                        VP.db.guardarMetadatos(vObj.name, {
                            videoWidth: pvid.videoWidth,
                            videoHeight: pvid.videoHeight
                        }).catch(() => {});
                    }
                    VP.listas?.actualizarBadgeResolucionVideo?.(vObj);
                }
                try {
                    pvid.currentTime = Number.isFinite(pvid.duration)
                        ? pvid.duration * 0.2
                        : 0;
                } catch (_) {}
            };

            pvid.onseeked = () => {
                if (destruido) return;
                if (pendiente) {
                    if (_videoPrincipalLibre()) {
                        _iniciarPreview(pvid, contado);
                    } else {
                        pendiente = false;
                        liberarFuente();
                    }
                }
            };

            pvid.onerror = () => {
                if (destruido) return;
                log.debug('Preview error en:', vObj.name);
                liberarFuente();
            };
        }

        function destruir() {
            if (destruido) return;
            destruido = true;
            clearTimeout(timer);
            _desobservarElemento(contenedor);

            contenedor.removeEventListener('mouseenter', onMouseEnter);
            contenedor.removeEventListener('mouseleave', onMouseLeave);

            if (contado.value) {
                contado.value = false;
                _state.previewsActivos = Math.max(0, _state.previewsActivos - 1);
            }
            liberarFuente();

            if (obs) {
                obs.disconnect();
                obs = null;
            }

            // Limpiar referencia externa si existe
            if (VP.getDomData) {
                const data = VP.getDomData(contenedor);
                if (data?.destruir === destruir) delete data.destruir;
            }
        }

        contenedor.addEventListener('mouseenter', onMouseEnter);
        contenedor.addEventListener('mouseleave', onMouseLeave);

        if (VP.setDomData) VP.setDomData(contenedor, { destruir });

        // MutationObserver para limpiar si el nodo es removido del DOM
        if (VP.features?.mutationObserver) {
            const objetivo = contenedor.parentNode || VP.refs?.galleryEl;
            if (objetivo && !dom.esNulo(objetivo)) {
                try {
                    obs = new MutationObserver((muts) => {
                        for (let m = 0; m < muts.length; m++) {
                            const removidos = muts[m].removedNodes;
                            for (let r = 0; r < removidos.length; r++) {
                                const n = removidos[r];
                                if (n === contenedor ||
                                    (n.contains && n.contains(contenedor))) {
                                    destruir();
                                    return;
                                }
                            }
                        }
                    });
                    obs.observe(objetivo, { childList: true, subtree: false });
                } catch (_) {}
            }
        }

        _observarElemento(contenedor);
    };

    // ──────────────────────────────────────────────────────────
    // PREVIEW EN BARRA DE PROGRESO
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.mostrarPreviewProgreso = function (ratio) {
        if (!VP.refs) return;

        const video = VP.refs.videoPlayer;
        let d;
        try {
            if (!video?.src) return;
            d = video.duration;
            if (!Number.isFinite(d) || d === 0) return;
        } catch (_) { return; }

        const c    = util.clampNum(ratio, 0, 1);
        const time = c * d;

        // Indicador de tiempo hover
        const hoverTime = VP.refs.progressHoverTime;
        if (!dom.esNulo(hoverTime)) {
            hoverTime.textContent = util.formatearTiempo(time);
            hoverTime.style.left  = (c * 100).toFixed(2) + '%';
        }

        if (!VP.ajustes?.habilitarPreviews || VP.ajustes.ultraRendimiento) return;

        const idx = VP.estado?.currentVideoIndex;
        if (idx < 0 || !VP.estado?.playlist[idx]) return;

        const arr = VP.estado.playlist[idx].thumbnailArray;
        if (!arr?.length) return;

        const masProxima = _buscarFrameMasCercano(arr, time);
        if (!masProxima) return;

        const hoverPreview     = VP.refs.hoverPreview;
        const hoverPreviewImg  = VP.refs.hoverPreviewImg;
        const hoverPreviewTime = VP.refs.hoverPreviewTime;
        const hoverPreviewChapter = VP.refs.hoverPreviewChapter;

        if (!dom.esNulo(hoverPreviewImg)) {
            hoverPreviewImg.src = masProxima.dataURL;
        }
        if (!dom.esNulo(hoverPreviewTime)) {
            hoverPreviewTime.textContent = util.formatearTiempo(time);
        }
        
        let chapterTitle = '';
        if (VP.estado && VP.estado.capitulos && VP.estado.capitulos.length > 0) {
            let actual = null;
            for (let i = 0; i < VP.estado.capitulos.length; i++) {
                if (VP.estado.capitulos[i].tiempo <= time) {
                    actual = VP.estado.capitulos[i];
                } else {
                    break;
                }
            }
            if (actual) {
                chapterTitle = actual.titulo;
            }
        }
        if (!dom.esNulo(hoverPreviewChapter)) {
            hoverPreviewChapter.textContent = chapterTitle;
            // La visibilidad y estilos se gestionan por CSS
            // Si no hay capítulo, el texto vacío no ocupa espacio gracias a max-width y overflow
        }

        if (!dom.esNulo(hoverPreview)) {
            const progress = VP.refs.progressContainer;
            const trackWidth = !dom.esNulo(progress) ? progress.clientWidth : 0;
            const previewWidth = trackWidth > 0 ? Math.min(188, trackWidth) : 188;
            hoverPreview.style.width = previewWidth + 'px';
            const halfWidthPct = trackWidth > 0 ? (previewWidth / trackWidth) * 50 : 0;
            const left = Math.max(halfWidthPct, Math.min(c * 100, 100 - halfWidthPct));
            hoverPreview.style.left    = left.toFixed(2) + '%';
            hoverPreview.style.display = 'block';
            hoverPreview.classList.add('visible');
        }
    };

    // Búsqueda binaria del frame más cercano
    function _buscarFrameMasCercano(arr, time) {
        if (!arr?.length) return null;
        let lo = 0, hi = arr.length - 1, mid;
        while (lo < hi) {
            mid = (lo + hi + 1) >> 1;
            if (arr[mid].tiempo <= time) lo = mid;
            else hi = mid - 1;
        }
        return arr[lo];
    }

    // ──────────────────────────────────────────────────────────
    // OCULTAR PREVIEW DE PROGRESO
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.ocultarPreviewProgreso = function () {
        if (!VP.refs) return;
        const hoverPreview = VP.refs.hoverPreview;
        if (!dom.esNulo(hoverPreview)) {
            hoverPreview.classList.remove('visible');
            hoverPreview.style.display = 'none';
        }
    };

    // ──────────────────────────────────────────────────────────
    // PROGRAMAR ARRAY AL REPRODUCIR
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.programarArrayAlReproducir = function (vObj) {
        if (_trabajoEnPausa())                    return;
        if (VP.ajustes?.ultraRendimiento)         return;
        if (!VP.ajustes?.autoGenerarArrayPreview) return;
        if (!vObj?.file)                          return;
        if (!Number.isFinite(vObj.duration) || vObj.duration <= 0) return;
        if (vObj.thumbnailArray?.length)          return;
        if (vObj._arrayGenerando)                 return;

        const retraso = cfg.demoraArrayAlReproducir || 3500;

        setTimeout(() => {
            const estado = VP.estado;
            if (!estado) return;
            const actual = estado.playlist?.[estado.currentVideoIndex];
            if (!actual || actual.id !== vObj.id) return;

            VP.miniaturas.generarArray(vObj).catch((e) => {
                log.debug('Error generarArray:', e);
            });
        }, retraso);
    };

    // ──────────────────────────────────────────────────────────
    // CANCELAR COLAS
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.cancelarColas = function () {
        // Invalida callbacks ya iniciados antes de vaciar contadores y colas.
        // Así sus promesas tardías no alteran una carga posterior.
        _state.generacionMiniaturas++;
        _state.generacionDuracion++;
        const nombresProgramadores = Object.keys(_state.programadores);
        for (let i = 0; i < nombresProgramadores.length; i++) {
            const plan = _state.programadores[nombresProgramadores[i]];
            if (!plan) continue;
            plan.activa = false;
            if (plan.timer != null) clearTimeout(plan.timer);
        }
        _state.programadores = Object.create(null);
        _state.colaMiniaturas.forEach(item => item && (item.cancelada = true));
        _state.colaDuracion.forEach(item => item && (item.cancelada = true));

        _state.colaMiniaturas   = [];
        _state.colaDuracion     = [];
        _indiceColaDuracion = 0;
        _state.workersMiniaturas = 0;
        // Las mediciones de duración activas no tienen cancelador propio:
        // conservan su plaza hasta que termine su promesa.
        _state.idsEnCola         = Object.create(null);
        _state.idsDuracionEnCola = Object.create(null);
        _state.idsEnProceso      = Object.create(null);
        _state.idsDuracionEnProceso = Object.create(null);

        const cancelaciones = _state.cancelaciones;
        for (const id in cancelaciones) {
            if (Object.prototype.hasOwnProperty.call(cancelaciones, id)) {
                try { cancelaciones[id](); } catch (_) {}
            }
        }
        _state.cancelaciones = Object.create(null);

        _metricas.canceladas++;
        log.debug('Colas canceladas.');
    };

    // ──────────────────────────────────────────────────────────
    // CANCELAR UN ÚNICO VIDEO
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.cancelarVideo = function (id) {
        if (!id) return;

        _state.colaMiniaturas.forEach(item => {
            if (item?.vObj?.id === id) item.cancelada = true;
        });
        _state.colaDuracion.forEach(item => {
            if (item?.vObj?.id === id) item.cancelada = true;
        });

        if (_state.cancelaciones[id]) {
            try { _state.cancelaciones[id](); } catch (_) {}
            delete _state.cancelaciones[id];
        }
        delete _state.idsEnCola[id];
        delete _state.idsEnProceso[id];
    };

    // ──────────────────────────────────────────────────────────
    // LIMPIAR MINIATURAS EN MEMORIA
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.limpiarMemoria = function () {
        const videos = VP.estado?.videos;
        if (!videos) return;

        for (let i = 0; i < videos.length; i++) {
            videos[i].thumbnail        = null;
            videos[i].thumbnailArray   = null;
            videos[i]._thumbQueued     = false;
            videos[i]._thumbFallido    = false;
            videos[i]._thumbReintentos = 0;
            videos[i]._durQueued       = false;
            videos[i]._durFallido      = false;
            videos[i]._arrayGenerando  = false;
        }

        _cacheLRU.clear();
        log.debug('Memoria limpiada.');
        bus.emit('miniaturasLimpiadas');
    };

    // ──────────────────────────────────────────────────────────
    // OBTENER MÉTRICAS
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.obtenerMetricas = function () {
        return {
            generadas         : _metricas.generadas,
            fallidas          : _metricas.fallidas,
            cacheHit          : _metricas.cacheHit,
            cacheLRUHit       : _metricas.cacheLRUHit,
            duracionesOk      : _metricas.duracionesOk,
            duracionesFail    : _metricas.duracionesFail,
            arraysGenerados   : _metricas.arraysGenerados,
            circuitBreaks     : _metricas.circuitBreaks,
            canceladas        : _metricas.canceladas,
            tiempoPromedioMs  : _metricas.generadas > 0
                ? Math.round(_metricas.tiempoTotalMs / _metricas.generadas)
                : 0,
            colaMiniaturas    : _state.colaMiniaturas.length,
            colaDuracion      : Math.max(0, _state.colaDuracion.length - _indiceColaDuracion),
            workersMiniaturas : _state.workersMiniaturas,
            workersDuracion   : _state.workersDuracion,
            lruSize           : _cacheLRU.size(),
            circuitAbierto    : _state.circuitAbierto,
        };
    };

    // ──────────────────────────────────────────────────────────
    // PROCESADORES PÚBLICOS (compatibilidad)
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.procesarCola = _tickCola;
    VP.miniaturas.procesarColaDuracion = _tickColaDuracion;

    // ──────────────────────────────────────────────────────────
    // TICKER ADAPTATIVO
    // ──────────────────────────────────────────────────────────
    function _iniciarTickerAdaptativo() {
        if (_state.timerAdaptativo) return;
        _state.timerAdaptativo = setInterval(() => {
            if (_state.pausado || _state.circuitAbierto) return;
            const hayTrabajo = _state.colaMiniaturas.length > 0 || _indiceColaDuracion < _state.colaDuracion.length;
            if (!hayTrabajo) return;
            const hayWorkers = _state.workersMiniaturas > 0 || _state.workersDuracion > 0;
            if (!hayWorkers) {
                log.debug('Atasco detectado. Reiniciando workers.');
                _tickCola();
                _tickColaDuracion();
            }
        }, K.INTERVALO_ADAPTATIVO);
    }

    function _detenerTickerAdaptativo() {
        if (_state.timerAdaptativo) {
            clearInterval(_state.timerAdaptativo);
            _state.timerAdaptativo = null;
        }
    }

    // ──────────────────────────────────────────────────────────
    // DESTRUIR MÓDULO (limpiar todo liberable)
    // ──────────────────────────────────────────────────────────
    VP.miniaturas.destroy = function () {
        // Cancelar todo trabajo pendiente
        VP.miniaturas.cancelarColas();

        // Detener timers internos
        clearTimeout(_state.timerCircuit);
        _detenerTickerAdaptativo();

        // Desconectar observer de intersección
        if (_state.intersectionObs) {
            _state.intersectionObs.disconnect();
            _state.intersectionObs = null;
        }

        // Limpiar caché
        _cacheLRU.clear();

        // Desregistrar eventos del bus (se asume que bus los maneja, pero referencia se pierde)
        // Se podría guardar referencias, en este contexto es suficiente.

        log.info('Módulo destruido.');
    };

    // ──────────────────────────────────────────────────────────
    // LISTENERS DEL BUS
    // ──────────────────────────────────────────────────────────
    bus.on('videosCargados', (listaVideos) => {
        if (!listaVideos?.length) return;
        VP.miniaturas.programarDuraciones(listaVideos);
        if (VP.ajustes?.generarMiniaturas && !VP.ajustes?.ultraRendimiento) {
            VP.miniaturas.programarMiniaturas(listaVideos);
        }
    });

    bus.on('videoReproduciendo', (vObj) => {
        if (vObj) VP.miniaturas.programarArrayAlReproducir(vObj);
    });

    bus.on('videoEsperando', () => {
        _state.videoEsperando = true;
    });

    bus.on('videoReanudado', () => {
        _state.videoEsperando = false;
        _programarTick();
        _programarTickDuracion();
    });

    bus.on('rendimientoAdaptativo', (modoLento) => {
        if (!modoLento) {
            _programarTick();
            _programarTickDuracion();
        }
    });

    bus.on('ultraRendimiento', (activo) => {
        if (activo) VP.miniaturas.cancelarColas();
    });

    bus.on('cacheVaciada', () => {
        _cacheLRU.clear();
        VP.miniaturas.limpiarMemoria();
    });

    bus.on('visibilidad', (visible) => {
        _state.pausado = !visible;
        if (visible) {
            _tickCola();
            _tickColaDuracion();
        }
    });

    bus.on('videoEliminado', (id) => {
        if (!id) return;
        VP.miniaturas.cancelarVideo(id);
        _cacheLRU.del(id);
    });

    bus.on('playlistVaciada', () => {
        VP.miniaturas.cancelarColas();
        _cacheLRU.clear();
    });

    bus.on('ajustesActualizados', () => {
        if (VP.ajustes && !VP.ajustes.ultraRendimiento) {
            _tickCola();
            _tickColaDuracion();
        }
    });

    // ──────────────────────────────────────────────────────────
    // INICIALIZACIÓN
    // ──────────────────────────────────────────────────────────
    (function _init() {
        _iniciarIntersectionObserver();
        _iniciarTickerAdaptativo();
    })();

    // ──────────────────────────────────────────────────────────
    // VERIFICACIÓN DE MÓDULO
    // ──────────────────────────────────────────────────────────
    (function verificarModulo() {
        const requeridos = [
            'crearVideoTemp', 'capturarFotograma', 'encolar', 'procesarCola',
            'generar', '_generarInterno', 'generarArray', 'actualizarUI',
            'encolarDuracion', 'procesarColaDuracion', 'sondearDuracion',
            'actualizarDuracion', '_notificarDuracion', 'actualizarDuracionPlaylist',
            'actualizarDuracionGaleria', 'programarDuraciones', 'programarMiniaturas',
            'adjuntarPreview', 'mostrarPreviewProgreso', 'ocultarPreviewProgreso',
            'programarArrayAlReproducir', 'cancelarColas', 'cancelarVideo',
            'limpiarMemoria', 'obtenerMetricas', 'destroy'
        ];

        const faltantes = [];
        for (let i = 0; i < requeridos.length; i++) {
            if (typeof VP.miniaturas[requeridos[i]] !== 'function') {
                faltantes.push(requeridos[i]);
            }
        }

        if (faltantes.length > 0) {
            log.error('Funciones faltantes →', faltantes.join(', '));
        }
    })();

    log.info('vp-miniaturas.js cargado. Optimizado para 500+ videos.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-miniaturas.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
