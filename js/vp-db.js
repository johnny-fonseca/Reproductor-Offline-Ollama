'use strict';

// ============================================================
// VP-DB.JS — v4.2.0
// Persistencia: IndexedDB.
// Compatible con VP.LRUCache de vp-base.js v3.1.0
// Optimizado para 500+ videos.
// ============================================================

(function (window, document) {

    // ── Guardia de dependencia ────────────────────────────────
    if (!window.VP) {
        throw new Error('[VP] vp-db.js: vp-base.js debe cargarse primero.');
    }

    var VP  = window.VP;
    var log = VP.log;
    var cfg = VP.config;
    log.setContext('DB');

    // ── Guardia de LRUCache ──────────────────────────────────
    if (typeof VP.LRUCache !== 'function') {
        log.error('vp-db.js: VP.LRUCache no disponible. ' +
                  'Verifica que vp-base.js v3.1.0+ esté cargado primero.');
        // Fallback mínimo para no crashear el resto de módulos
        VP.LRUCache = function (cap) {
            this._cap  = cap || 300;
            this._data = Object.create(null);
            this._keys = [];
            this.size  = 0;
        };
        VP.LRUCache.prototype = {
            get:    function (k) { return this._data[k]; },
            set:    function (k, v) {
                if (!(k in this._data) && this._keys.length >= this._cap) {
                    var old = this._keys.shift();
                    delete this._data[old];
                }
                this._data[k] = v;
                var i = this._keys.indexOf(k);
                if (i > -1) this._keys.splice(i, 1);
                this._keys.push(k);
                this.size = this._keys.length;
                return this;
            },
            has:    function (k) { return k in this._data; },
            delete: function (k) {
                if (!(k in this._data)) return false;
                delete this._data[k];
                var i = this._keys.indexOf(k);
                if (i > -1) this._keys.splice(i, 1);
                this.size = this._keys.length;
                return true;
            },
            clear:  function () {
                this._data = Object.create(null);
                this._keys = [];
                this.size  = 0;
            },
            forEach: function (fn, ctx) {
                for (var i = 0; i < this._keys.length; i++) {
                    fn.call(ctx || this,
                            this._data[this._keys[i]], this._keys[i]);
                }
            },
            stats: function () {
                return {
                    size:      this.size,
                    capacidad: this._cap,
                    modo:      'fallback',
                    uso:       ((this.size / this._cap) * 100).toFixed(1) + '%',
                };
            },
        };
    }

    // ============================================================
    // §1  CIRCUIT BREAKER — Implementación propia (no depende de
    //     ningún módulo externo)
    // ============================================================

    /**
     * CircuitBreaker simple de tres estados:
     *   CERRADO  → operación normal
     *   ABIERTO  → rechaza llamadas durante tiempoEspera ms
     *   SEMI     → permite una llamada de prueba
     */
    function CircuitBreaker(opciones) {
        opciones            = opciones || {};
        this._umbralFallas  = opciones.umbralFallas || 5;
        this._tiempoEspera  = opciones.tiempoEspera || 30000;
        this._umbralExito   = opciones.umbralExito  || 2;

        this._contFallas    = 0;
        this._contExitos    = 0;
        this._estado        = 'CERRADO';   // 'CERRADO' | 'ABIERTO' | 'SEMI'
        this._abiertoDesdE  = 0;
    }

    CircuitBreaker.prototype = {
        constructor: CircuitBreaker,

        estaAbierto: function () {
            if (this._estado === 'ABIERTO') {
                // Comprobar si ya pasó el tiempo de espera
                if (Date.now() - this._abiertoDesdE >= this._tiempoEspera) {
                    this._estado     = 'SEMI';
                    this._contExitos = 0;
                    return false;   // Permitir llamada de prueba
                }
                return true;        // Sigue rechazando
            }
            return false;
        },

        registrarFalla: function () {
            this._contFallas++;
            if (this._estado === 'SEMI') {
                // Falló la prueba → volver a abrir
                this._estado       = 'ABIERTO';
                this._abiertoDesdE = Date.now();
            } else if (this._estado === 'CERRADO' &&
                       this._contFallas >= this._umbralFallas) {
                this._estado       = 'ABIERTO';
                this._abiertoDesdE = Date.now();
                log.warn('CircuitBreaker ABIERTO tras', this._contFallas, 'fallas');
            }
        },

        registrarExito: function () {
            this._contFallas = 0;
            if (this._estado === 'SEMI') {
                this._contExitos++;
                if (this._contExitos >= this._umbralExito) {
                    this._estado = 'CERRADO';
                    log.info('CircuitBreaker CERRADO (recuperado)');
                }
            }
        },

        resetear: function () {
            this._contFallas = 0;
            this._contExitos = 0;
            this._estado     = 'CERRADO';
        },

        get estado()     { return this._estado; },
        get contFallas() { return this._contFallas; },
    };

    // ============================================================
    // §2  ESTADO INTERNO DEL MÓDULO
    // ============================================================

    var NOMBRE_DB  = cfg.nombreDB  || 'VideoPlayerDB';
    var VERSION_DB = cfg.versionDB || 7;

    // Nombres de stores válidos
    var STORES_VALIDOS = [
        'thumbnails',
        'thumbnailArrays',
        'dirHandle',
        'metadata',
        'videoProgress',
        'preferences',
        'keyval',
    ];

    // ── Conexión ─────────────────────────────────────────────
    var _db            = null;
    var _inicializando = false;
    var _colaInit      = [];
    var _colaEscrituraPendiente = [];

    // ── Cachés LRU en memoria ────────────────────────────────
    // Capacidades ajustadas para 500+ videos
    var _cacheProgreso  = new VP.LRUCache(800);
    var _cacheMetadatos = new VP.LRUCache(600);
    var _cacheMiniatura = new VP.LRUCache(300, function (clave, valor) {
        // Al evictar una miniatura de la LRU, revocar su Blob URL si aplica
        if (valor && typeof valor === 'string' &&
            valor.indexOf('blob:') === 0) {
            VP.revocarSeguro(valor);
        }
    });
    var _colasGuardarMetadatos = Object.create(null);


    // ── Circuit breaker ──────────────────────────────────────
    var _cb = new CircuitBreaker({
        umbralFallas: 5,
        tiempoEspera: 30000,
        umbralExito:  2,
    });

    // ── Estadísticas internas ────────────────────────────────
    var _stats = {
        lecturas:      0,
        escrituras:    0,
        bulkWrites:    0,
        errores:       0,
        evicciones:    0,
        reintentos:    0,
        cacheHits:     0,
        cacheMisses:   0,
        txAbiertas:    0,
        txCerradas:    0,
    };

    // ── Timer de debounce para guardarProgreso ───────────────
    var _timerGuardarProgreso = null;

    // ============================================================
    // §3  HELPERS INTERNOS
    // ============================================================

    function estaLista() {
        return _db !== null &&
               VP.runtime.idb.listo &&
               !VP.runtime.idb.fallido &&
               !_cb.estaAbierto();
    }

    function obtenerIDB() {
        return window.indexedDB      ||
               window.mozIndexedDB  ||
               window.webkitIndexedDB ||
               window.msIndexedDB   ||
               null;
    }

    function storeValido(nombre) {
        return STORES_VALIDOS.indexOf(String(nombre)) !== -1;
    }

    function ahora() {
        return Date.now();
    }

    /** Backoff exponencial con jitter ±20%. */
    function calcularBackoff(intento, base) {
        base    = base || cfg.demoraReintentoIDB || 500;
        var exp = Math.min(Math.pow(2, intento) * base, 30000);
        return Math.floor(exp * (0.8 + Math.random() * 0.4));
    }

    function resolverColaInit(exito) {
        var cola = _colaInit.splice(0);
        for (var i = 0; i < cola.length; i++) {
            try { cola[i](exito); } catch (_) {}
        }
    }

    /** Convierte NodeList/DOMStringList a Array. */
    function aArray(lista) {
        if (Array.isArray(lista)) return lista;
        if (typeof Array.from === 'function') return Array.from(lista);
        var arr = [];
        for (var i = 0; i < lista.length; i++) arr.push(lista[i]);
        return arr;
    }

    /** Cache síncrona en memoria para keyval (reemplaza localStorage). */
    var _cacheKeyVal = Object.create(null);
    var _keyValListo = false;

    function _keyValGuardar(clave, valor) {
        _cacheKeyVal[clave] = valor;
        if (_keyValListo) {
            VP.db.guardar('keyval', clave, { valor: valor }).catch(function () {});
        }
    }

    function _keyValObtener(clave) {
        if (clave in _cacheKeyVal) return _cacheKeyVal[clave];
        return null;
    }

    function _keyValEliminar(clave) {
        delete _cacheKeyVal[clave];
        if (_keyValListo) {
            VP.db.eliminar('keyval', clave).catch(function () {});
        }
    }

    // Alias para compatibilidad con código interno existente
    function lsGet(clave) {
        return _keyValObtener(clave);
    }

    function lsSet(clave, valor) {
        _keyValGuardar(clave, valor);
    }

    function _normalizarEntradaProgreso(entrada) {
        if (!entrada || typeof entrada !== 'object') return null;
        var fileName = entrada.fileName || entrada.id || entrada.name || '';
        fileName = typeof fileName === 'string' ? fileName.trim() : String(fileName || '');
        if (!fileName) return null;

        var duracion = Number(entrada.duration || entrada.duracion || 0);
        if (!isFinite(duracion) || duracion < 0) duracion = 0;

        var currentTime = Number(entrada.currentTime || entrada.tiempo || 0);
        if (!isFinite(currentTime) || currentTime < 0) currentTime = 0;
        if (duracion > 0 && currentTime > duracion) currentTime = duracion;

        var limpio = {};
        var claves = Object.keys(entrada);
        for (var i = 0; i < claves.length; i++) {
            limpio[claves[i]] = entrada[claves[i]];
        }
        limpio.fileName = fileName;
        limpio.id = fileName;
        limpio.currentTime = currentTime;
        limpio.duration = duracion;
        limpio.completado = !!entrada.completado ||
            (duracion > 0 && (currentTime / duracion) > 0.93);
        limpio._ts = Number(entrada._ts) || ahora();
        return limpio;
    }

    function _normalizarListaProgreso(lista) {
        if (!Array.isArray(lista)) return [];
        var vistos = Object.create(null);
        var normalizados = [];
        for (var i = 0; i < lista.length; i++) {
            var item = _normalizarEntradaProgreso(lista[i]);
            if (!item) continue;
            if (vistos[item.fileName] !== undefined) {
                normalizados[vistos[item.fileName]] = item;
            } else {
                vistos[item.fileName] = normalizados.length;
                normalizados.push(item);
            }
        }
        return normalizados;
    }

    // ============================================================
    // §4  INICIALIZACIÓN CON DETECCIÓN DE VERSIONERROR
    // ============================================================

    VP.db.inicializar = function () {
        log.info('Inicializando conexión con IndexedDB…');
        if (estaLista()) {
            log.info('Ya inicializada.');
            return Promise.resolve(true);
        }
        if (VP.runtime.idb.fallido) {
            log.warn('IDB marcada como fallida, usando caché en memoria.');
            return Promise.resolve(false);
        }

        if (_inicializando) {
            log.debug('Inicialización en curso, encolando…');
            return new Promise(function (resolve) {
                _colaInit.push(resolve);
            });
        }

        _inicializando = true;
        var t0 = ahora();

        return new Promise(function (resolve) {

            var idb = obtenerIDB();

            if (!VP.features.indexedDB || !idb) {
                log.warn('VP.db: IndexedDB no disponible → usando caché en memoria.');
                VP.runtime.idb.fallido = true;
                _inicializando         = false;
                resolverColaInit(false);
                return resolve(false);
            }

            // Detectar versión actual antes de abrir con versión fija
            _detectarVersion(idb, function (versionActual) {
                var versionObjetivo = VERSION_DB;

                if (versionActual > VERSION_DB) {
                    log.warn(
                        'IDB: BD existente v' + versionActual +
                        ' > código v' + VERSION_DB +
                        '. Adaptando.'
                    );
                    versionObjetivo = versionActual;
                }

                _abrirConVersion(idb, versionObjetivo, t0, resolve);
            });
        });
    };

    function _detectarVersion(idb, callback) {
        try {
            var req = idb.open(NOMBRE_DB);

            req.onsuccess = function (e) {
                var ver = e.target.result.version;
                e.target.result.close();
                callback(ver);
            };

            req.onerror = function () {
                callback(0);
            };

            // BD nueva → onupgradeneeded con oldVersion = 0
            req.onupgradeneeded = function (e) {
                e.target.transaction.abort();
                callback(0);
            };
        } catch (e) {
            log.warn('_detectarVersion excepción:', e.message || e);
            callback(0);
        }
    }

    function _abrirConVersion(idb, version, t0, resolve) {
        var req;
        try {
            req = idb.open(NOMBRE_DB, version);
        } catch (e) {
            log.error('IDB open() lanzó excepción:', e.message || e);
            VP.runtime.idb.fallido = true;
            _inicializando         = false;
            resolverColaInit(false);
            return resolve(false);
        }

        req.onupgradeneeded = function (e) {
            try {
                _migrarEsquema(
                    e.target.result,
                    e.oldVersion || 0,
                    e.newVersion || version
                );
            } catch (err) {
                log.error('IDB migración falló:', err.message || err);
            }
        };

        req.onsuccess = function (e) {
            _db = e.target.result;

            _db.onversionchange = _onVersionChange;
            _db.onerror         = _onDBError;
            _db.onclose         = _onDBClose;

            VP.runtime.db          = _db;
            VP.runtime.idb.listo   = true;
            VP.runtime.idb.fallido = false;
            VP.runtime.idb.version = _db.version;
            VP.metricas.dbInitMs   = ahora() - t0;

            log.info(
                'VP.db: IDB lista · v' + _db.version +
                ' · ' + VP.metricas.dbInitMs + 'ms'
            );

            _cb.resetear();
            _inicializando = false;
            _precargarKeyVal().then(function () {
                _keyValListo = true;
                _vaciarColaPendiente();
                resolverColaInit(true);
                resolve(true);
            }).catch(function () {
                _keyValListo = true;
                _vaciarColaPendiente();
                resolverColaInit(true);
                resolve(true);
            });
        };

        req.onerror = function (e) {
            var err = e.target ? e.target.error : null;
            log.error('IDB onerror:',
                      err ? (err.name + ' – ' + err.message) : 'desconocido');

            if (err && err.name === 'VersionError') {
                log.warn('IDB VersionError → abriendo sin versión fija…');
                _abrirSinVersion(idb, t0, resolve);
                return;
            }

            VP.runtime.idb.fallido = true;
            _db                    = null;
            _cb.registrarFalla();
            _inicializando         = false;
            resolverColaInit(false);
            resolve(false);
        };

        req.onblocked = function () {
            log.warn('IDB bloqueada por otra pestaña.');
            if (VP.ui && VP.ui.mostrarNotificacion) {
                VP.ui.mostrarNotificacion(
                    'Cierra otras pestañas del reproductor.',
                    'advertencia'
                );
            }
        };
    }

    function _abrirSinVersion(idb, t0, resolve) {
        try {
            var req = idb.open(NOMBRE_DB);

            req.onupgradeneeded = function (e) {
                try {
                    _migrarEsquema(
                        e.target.result,
                        e.oldVersion || 0,
                        e.newVersion || 0
                    );
                } catch (err) {
                    log.error('_abrirSinVersion migración:', err.message || err);
                }
            };

            req.onsuccess = function (e) {
                _db = e.target.result;
                _db.onversionchange = _onVersionChange;
                _db.onerror         = _onDBError;
                _db.onclose         = _onDBClose;

                VP.runtime.db          = _db;
                VP.runtime.idb.listo   = true;
                VP.runtime.idb.fallido = false;
                VP.runtime.idb.version = _db.version;
                VP.metricas.dbInitMs   = ahora() - t0;

                log.info('IDB lista (sin versión fija) · v' + _db.version);
                _cb.resetear();
                _inicializando = false;
                _precargarKeyVal().then(function () {
                    _keyValListo = true;
                    _vaciarColaPendiente();
                    resolverColaInit(true);
                    resolve(true);
                }).catch(function () {
                    _keyValListo = true;
                    _vaciarColaPendiente();
                    resolverColaInit(true);
                    resolve(true);
                });
            };

            req.onerror = function (e) {
                log.error('_abrirSinVersion falló:', e.target && e.target.error);
                VP.runtime.idb.fallido = true;
                _inicializando         = false;
                resolverColaInit(false);
                resolve(false);
            };

        } catch (e) {
            log.error('_abrirSinVersion excepción:', e.message || e);
            VP.runtime.idb.fallido = true;
            _inicializando         = false;
            resolverColaInit(false);
            resolve(false);
        }
    }

    // ── Migración incremental del esquema ────────────────────

    function _migrarEsquema(db, oldVer, newVer) {
        var actuales = aArray(db.objectStoreNames);

        function crearSiNoExiste(nombre) {
            if (actuales.indexOf(nombre) === -1) {
                db.createObjectStore(nombre, { keyPath: 'id' });
                log.debug('IDB store creado:', nombre);
            }
        }

        if (oldVer < 1) crearSiNoExiste('thumbnails');
        if (oldVer < 2) crearSiNoExiste('dirHandle');
        if (oldVer < 3) {
            crearSiNoExiste('metadata');
            crearSiNoExiste('videoProgress');
        }
        if (oldVer < 4) crearSiNoExiste('preferences');
        if (oldVer < 5) crearSiNoExiste('thumbnailArrays');
        if (oldVer < 7) crearSiNoExiste('keyval');

        log.info('IDB esquema: v' + oldVer + ' → v' + newVer);
    }

    // ── Eventos de conexión ───────────────────────────────────

    function _onVersionChange() {
        log.warn('IDB: versión cambió externamente. Cerrando.');
        if (_db) { try { _db.close(); } catch (_) {} }
        _db                    = null;
        VP.runtime.db          = null;
        VP.runtime.idb.listo   = false;
        VP.runtime.idb.fallido = true;
        VP.bus.emit('idbVersionCambio');
    }

    function _onDBError(ev) {
        var err = ev.target ? ev.target.error : null;
        log.error('IDB error global:', err ? err.name : 'desconocido');
        _stats.errores++;
        VP.metricas.erroresIDB++;
        _cb.registrarFalla();
    }

    function _onDBClose() {
        log.warn('IDB: conexión cerrada inesperadamente.');
        _db                  = null;
        VP.runtime.db        = null;
        VP.runtime.idb.listo = false;
        VP.bus.emit('idbCerrada');
    }

    // ============================================================
    // §5  COLA DE ESCRITURAS PENDIENTES
    // ============================================================

    function _vaciarColaPendiente() {
        if (!_colaEscrituraPendiente.length) return;
        var cola = _colaEscrituraPendiente.splice(0);
        log.debug('Vaciando cola pendiente:', cola.length, 'escrituras');

        for (var i = 0; i < cola.length; i++) {
            (function (item) {
                VP.db.guardar(item.store, item.id, item.datos)
                    .then(item.resolve)
                    .catch(function () { item.resolve(false); });
            })(cola[i]);
        }
    }

    // ============================================================
    // §6  REINTENTOS EXPONENCIALES
    // ============================================================

    VP.db.conReintentos = function (fn, maxReintentos, demoraBase) {
        maxReintentos = maxReintentos || cfg.reintentoIDB        || 3;
        demoraBase    = demoraBase    || cfg.demoraReintentoIDB  || 500;

        return new Promise(function (resolve) {
            function intentar(n) {
                var resultado;
                try {
                    resultado = fn();
                } catch (e) {
                    resultado = Promise.reject(e);
                }

                Promise.resolve(resultado).then(function (val) {
                    _cb.registrarExito();
                    resolve(val);
                }).catch(function (err) {
                    _stats.reintentos++;
                    _cb.registrarFalla();

                    if (n < maxReintentos) {
                        var espera = calcularBackoff(n, demoraBase);
                        log.debug(
                            'IDB reintento', (n + 1) + '/' + maxReintentos,
                            'en', espera + 'ms'
                        );
                        setTimeout(function () { intentar(n + 1); }, espera);
                    } else {
                        log.error('IDB reintentos agotados:',
                                  err ? (err.message || err) : 'error desconocido');
                        resolve(null);
                    }
                });
            }
            intentar(0);
        });
    };

    // ============================================================
    // §7  OPERACIONES CRUD BASE
    // ============================================================

    VP.db.obtener = function (store, id) {
        return new Promise(function (resolve) {
            if (!estaLista() || !storeValido(store)) return resolve(null);

            try {
                var tx  = _db.transaction(String(store), 'readonly');
                var req = tx.objectStore(String(store)).get(id);

                req.onsuccess = function () {
                    _stats.lecturas++;
                    VP.metricas.lecturasIDB++;
                    resolve(req.result !== undefined ? req.result : null);
                };
                req.onerror = function (e) {
                    _stats.errores++;
                    VP.metricas.erroresIDB++;
                    log.warn('IDB.obtener error:', store, e.target && e.target.error);
                    resolve(null);
                };
            } catch (e) {
                _stats.errores++;
                VP.metricas.erroresIDB++;
                log.warn('IDB.obtener excepción:', store, e.message || e);
                resolve(null);
            }
        });
    };

    VP.db.guardar = function (store, id, datos) {
        return new Promise(function (resolve, reject) {
            if (!storeValido(store)) {
                log.warn('IDB.guardar: store inválido:', store);
                return resolve(false);
            }

            // Encolar si IDB no está lista aún
            if (!estaLista()) {
                _colaEscrituraPendiente.push({
                    store: store, id: id, datos: datos, resolve: resolve,
                });
                return;
            }

            // Construir registro con keyPath 'id'
            var registro = { id: id, _ts: ahora() };
            if (datos && typeof datos === 'object') {
                var claves = Object.keys(datos);
                for (var i = 0; i < claves.length; i++) {
                    if (claves[i] !== 'id') {
                        registro[claves[i]] = datos[claves[i]];
                    }
                }
            }

            try {
                var tx  = _db.transaction(String(store), 'readwrite');
                var req = tx.objectStore(String(store)).put(registro);

                req.onerror = function (e) {
                    log.warn('IDB.guardar req.error:', e.target && e.target.error);
                };

                tx.oncomplete = function () {
                    _stats.escrituras++;
                    VP.metricas.escriturasIDB++;
                    _cb.registrarExito();
                    resolve(true);
                };

                tx.onerror = function (e) {
                    _stats.errores++;
                    VP.metricas.erroresIDB++;
                    _cb.registrarFalla();
                    var err = e.target ? e.target.error : new Error('tx error');
                    _manejarErrorTx(err, store);
                    reject(err);
                };

                tx.onabort = function () { resolve(false); };

            } catch (e) {
                _stats.errores++;
                VP.metricas.erroresIDB++;
                log.error('IDB.guardar excepción:', store, e.message || e);
                reject(e);
            }
        });
    };

    VP.db.eliminar = function (store, id) {
        return new Promise(function (resolve) {
            if (!estaLista() || !storeValido(store)) return resolve(false);
            try {
                var tx = _db.transaction(String(store), 'readwrite');
                tx.objectStore(String(store)).delete(id);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror    = function () { resolve(false); };
                tx.onabort    = function () { resolve(false); };
            } catch (e) {
                log.warn('IDB.eliminar excepción:', store, e.message || e);
                resolve(false);
            }
        });
    };

    VP.db.limpiarStore = function (store) {
        return new Promise(function (resolve) {
            if (!estaLista() || !storeValido(store)) return resolve(false);
            try {
                var tx = _db.transaction(String(store), 'readwrite');
                tx.objectStore(String(store)).clear();
                tx.oncomplete = function () { resolve(true); };
                tx.onerror    = function () { resolve(false); };
                tx.onabort    = function () { resolve(false); };
            } catch (e) {
                log.warn('IDB.limpiarStore excepción:', store, e.message || e);
                resolve(false);
            }
        });
    };

    VP.db.obtenerTodos = function (store) {
        return new Promise(function (resolve) {
            if (!estaLista() || !storeValido(store)) return resolve([]);
            try {
                var tx  = _db.transaction(String(store), 'readonly');
                var req = tx.objectStore(String(store)).getAll();
                req.onsuccess = function () {
                    _stats.lecturas++;
                    VP.metricas.lecturasIDB++;
                    resolve(Array.isArray(req.result) ? req.result : []);
                };
                req.onerror = function () { resolve([]); };
            } catch (e) {
                log.warn('IDB.obtenerTodos excepción:', store, e.message || e);
                resolve([]);
            }
        });
    };

    VP.db.obtenerTodosOrdenados = function (store) {
        return VP.db.obtenerTodos(store).then(function (registros) {
            return registros.sort(function (a, b) {
                return (a._ts || 0) - (b._ts || 0);
            });
        });
    };

    VP.db.contar = function (store) {
        return new Promise(function (resolve) {
            if (!estaLista() || !storeValido(store)) return resolve(0);
            try {
                var tx  = _db.transaction(String(store), 'readonly');
                var req = tx.objectStore(String(store)).count();
                req.onsuccess = function () { resolve(req.result || 0); };
                req.onerror   = function () { resolve(0); };
            } catch (e) { resolve(0); }
        });
    };

    function _manejarErrorTx(err, store) {
        if (!err) return;
        if (err.name === 'QuotaExceededError') {
            log.error('IDB cuota excedida en:', store);
            if (VP.ui && VP.ui.mostrarNotificacion) {
                VP.ui.mostrarNotificacion(
                    'Almacenamiento lleno. Limpia la caché.', 'error'
                );
            }
            setTimeout(function () {
                VP.db.eviccionarLote(store || 'thumbnails').catch(function () {});
            }, 100);
        } else if (err.name === 'UnknownError') {
            log.error('IDB UnknownError (disco lleno o BD corrupta)');
        }
    }

    // ============================================================
    // §8  ESCRITURA EN LOTE — 1 transacción para N registros
    //     Crítico para rendimiento con 500+ videos
    // ============================================================

    VP.db.guardarLote = function (store, registros) {
        return new Promise(function (resolve) {
            if (!estaLista() || !storeValido(store)) return resolve(0);
            if (!registros || !registros.length)     return resolve(0);

            try {
                var tx       = _db.transaction(String(store), 'readwrite');
                var st       = tx.objectStore(String(store));
                var ts       = ahora();
                var escritos = 0;

                for (var i = 0; i < registros.length; i++) {
                    var reg = registros[i];
                    if (!reg || !reg.id) continue;

                    var entrada = { _ts: ts };
                    var claves  = Object.keys(reg);
                    for (var j = 0; j < claves.length; j++) {
                        entrada[claves[j]] = reg[claves[j]];
                    }

                    try {
                        st.put(entrada);
                        escritos++;
                    } catch (e2) {
                        log.warn('guardarLote item', i, 'falló:', e2.message || e2);
                    }
                }

                tx.oncomplete = function () {
                    _stats.bulkWrites++;
                    _stats.escrituras += escritos;
                    VP.metricas.escriturasIDB += escritos;
                    _cb.registrarExito();
                    log.debug('guardarLote:', escritos, '/', registros.length,
                              'en', store);
                    resolve(escritos);
                };

                tx.onerror = function (e) {
                    _stats.errores++;
                    VP.metricas.erroresIDB++;
                    _cb.registrarFalla();
                    var err = e.target ? e.target.error : null;
                    _manejarErrorTx(err, store);
                    resolve(0);
                };

                tx.onabort = function () { resolve(0); };

            } catch (e) {
                _stats.errores++;
                VP.metricas.erroresIDB++;
                log.error('guardarLote excepción:', store, e.message || e);
                resolve(0);
            }
        });
    };

    VP.db.eliminarLote = function (store, ids) {
        return new Promise(function (resolve) {
            if (!estaLista() || !storeValido(store)) return resolve(0);
            if (!ids || !ids.length)                  return resolve(0);

            try {
                var tx         = _db.transaction(String(store), 'readwrite');
                var st         = tx.objectStore(String(store));
                var eliminados = 0;

                for (var i = 0; i < ids.length; i++) {
                    try { st.delete(ids[i]); eliminados++; } catch (e2) {
                        log.warn('eliminarLote id', ids[i], ':', e2.message || e2);
                    }
                }

                tx.oncomplete = function () { resolve(eliminados); };
                tx.onerror    = function () { resolve(0); };
                tx.onabort    = function () { resolve(0); };
            } catch (e) {
                log.warn('eliminarLote excepción:', store, e.message || e);
                resolve(0);
            }
        });
    };

    // ============================================================
    // §9  EVICCIÓN
    // ============================================================

    VP.db.eviccionarLote = function (store) {
        return VP.db.obtenerTodosOrdenados(store).then(function (ordenados) {
            if (!ordenados.length) return 0;

            var cantidad = Math.max(
                1,
                Math.floor(ordenados.length * (cfg.ratioEviccion || 0.25))
            );

            var ids = [];
            for (var i = 0; i < cantidad && i < ordenados.length; i++) {
                ids.push(ordenados[i].id);
            }

            _stats.evicciones += ids.length;
            log.debug('IDB evicción:', ids.length, 'entradas de', store);
            return VP.db.eliminarLote(store, ids);
        });
    };

    VP.db.limpiarHuerfanas = function () {
        if (!estaLista()) return Promise.resolve(0);
        var videosActuales = VP.estado && VP.estado.videos;
        if (!Array.isArray(videosActuales)) return Promise.resolve(0);

        // Los almacenes pueden usar el nombre o el ID del video como clave.
        // Incluir ambos evita borrar metadatos válidos guardados por ID.
        var clavesVideoValidas;
        var clavesUsanSet = typeof Set !== 'undefined';
        if (clavesUsanSet) {
            clavesVideoValidas = new Set();
            for (var i = 0; i < videosActuales.length; i++) {
                var v = videosActuales[i];
                var nom = v && (v.nombre || v.name);
                if (nom) clavesVideoValidas.add(nom);
                if (v && v.id != null) clavesVideoValidas.add(String(v.id));
            }
        } else {
            clavesVideoValidas = Object.create(null);
            for (var k = 0; k < videosActuales.length; k++) {
                var vk = videosActuales[k];
                var nom = vk && (vk.nombre || vk.name);
                if (nom) clavesVideoValidas[nom] = true;
                if (vk && vk.id != null) clavesVideoValidas[String(vk.id)] = true;
            }
        }

        var storesList = ['thumbnails', 'thumbnailArrays', 'metadata', 'videoProgress'];
        var totalEliminados = 0;

        function tieneClaveVideo(clave) {
            var normalizada = String(clave);
            return clavesUsanSet
                ? clavesVideoValidas.has(normalizada)
                : normalizada in clavesVideoValidas;
        }

        return storesList.reduce(function (cadena, store) {
            return cadena.then(function () {
                return VP.db.obtenerTodos(store).then(function (registros) {
                    var ids = [];
                    for (var j = 0; j < registros.length; j++) {
                        var r = registros[j];
                        if (r && r.id != null && !tieneClaveVideo(r.id)) ids.push(r.id);
                    }
                    if (!ids.length) return 0;
                    totalEliminados += ids.length;
                    return VP.db.eliminarLote(store, ids);
                });
            });
        }, Promise.resolve()).then(function () {
            if (totalEliminados > 0) {
                log.info('IDB: eliminadas', totalEliminados, 'entradas huérfanas');
            }
            return totalEliminados;
        });
    };

    // ============================================================
    // §10  MINIATURAS
    // ============================================================

    VP.db.obtenerMiniatura = function (id) {
        if (!id) return Promise.resolve(null);

        // Hit LRU en memoria
        var cached = _cacheMiniatura.get(id);
        if (cached !== undefined) {
            _stats.cacheHits++;
            log.debug('Miniatura en caché LRU:', id);
            return Promise.resolve(cached);
        }
        _stats.cacheMisses++;
        log.debug('Miniatura no en caché, consultando IDB:', id);

        // Si IDB no está lista, esperar a que inicialice antes de consultar
        if (!VP.runtime.idb.listo && !VP.runtime.idb.fallido) {
            log.debug('IDB no lista, esperando inicialización para miniatura:', id);
            return VP.db.inicializar().then(function () {
                return VP.db.obtenerMiniatura(id);
            });
        }

        return VP.db.conReintentos(function () {
            return VP.db.obtener('thumbnails', id).then(function (r) {
                var data = r ? (r.data || null) : null;
                if (data) {
                    _cacheMiniatura.set(id, data);
                    log.debug('Miniatura cargada desde IDB:', id);
                } else {
                    log.debug('Miniatura no encontrada en IDB:', id);
                }
                return data;
            });
        });
    };

    VP.db.guardarMiniatura = function (id, dataURL) {
        if (!id || !dataURL) {
            log.warn('guardarMiniatura: id o dataURL inválidos.');
            return Promise.resolve(false);
        }
        _cacheMiniatura.set(id, dataURL);
        log.debug('Guardando miniatura en IDB:', id);
        return VP.db.conReintentos(function () {
            return VP.db.guardar('thumbnails', id, { data: dataURL });
        });
    };

    VP.db.guardarMiniaturaLote = function (items) {
        if (!items || !items.length) return Promise.resolve(0);

        // Actualizar LRU en memoria
        for (var i = 0; i < items.length; i++) {
            if (items[i] && items[i].id && items[i].data) {
                _cacheMiniatura.set(items[i].id, items[i].data);
            }
        }

        var registros = [];
        for (var j = 0; j < items.length; j++) {
            if (items[j] && items[j].id) {
                registros.push({ id: items[j].id, data: items[j].data });
            }
        }

        return VP.db.guardarLote('thumbnails', registros);
    };

    VP.db.eliminarMiniatura = function (id) {
        if (!id) return Promise.resolve(false);
        _cacheMiniatura.delete(id);
        return VP.db.eliminar('thumbnails', id);
    };

    // ============================================================
    // §10b  ARRAYS DE MINIATURAS (preview scrub)
    // ============================================================

    VP.db.obtenerArrayMiniaturas = function (id) {
        if (!id) return Promise.resolve(null);

        log.debug('Cargando array de miniaturas desde IDB:', id);

        if (!VP.runtime.idb.listo && !VP.runtime.idb.fallido) {
            log.debug('IDB no lista, esperando para array de miniaturas:', id);
            return VP.db.inicializar().then(function () {
                return VP.db.obtenerArrayMiniaturas(id);
            });
        }

        return VP.db.conReintentos(function () {
            return VP.db.obtener('thumbnailArrays', id).then(function (r) {
                var data = r ? (r.data || null) : null;
                if (data) {
                    log.debug('Array de miniaturas cargado:', id);
                } else {
                    log.debug('Array de miniaturas no encontrado:', id);
                }
                return data;
            });
        });
    };

    VP.db.guardarArrayMiniaturas = function (id, array) {
        if (!id || !array) return Promise.resolve(false);
        return VP.db.conReintentos(function () {
            return VP.db.guardar('thumbnailArrays', id, { data: array });
        });
    };

    VP.db.eliminarArrayMiniaturas = function (id) {
        if (!id) return Promise.resolve(false);
        return VP.db.eliminar('thumbnailArrays', id);
    };

    // ============================================================
    // §11  HANDLE DE DIRECTORIO
    // ============================================================

    VP.db.guardarDirectorio = function (handle) {
        if (!estaLista() || !handle) {
            log.warn('guardarDirectorio: IDB no disponible o handle nulo.');
            return Promise.resolve(false);
        }

        var promesaPermiso;
        if (typeof handle.queryPermission === 'function') {
            promesaPermiso = handle.queryPermission({ mode: 'readwrite' })
                .catch(function () { return handle.queryPermission({ mode: 'read' }); });
        } else {
            promesaPermiso = Promise.resolve('granted');
        }

        return promesaPermiso.then(function (permiso) {
            if (permiso !== 'granted' && permiso !== 'prompt') {
                log.debug('guardarDirectorio: sin permiso suficiente');
                return false;
            }
            return new Promise(function (resolve) {
                try {
                    var tx = _db.transaction('dirHandle', 'readwrite');
                    tx.objectStore('dirHandle').put({
                        id: 'lastDir', handle: handle, _ts: ahora(),
                    });
                    tx.oncomplete = function () { resolve(true); };
                    tx.onerror    = function () { resolve(false); };
                    tx.onabort    = function () { resolve(false); };
                } catch (e) {
                    log.warn('guardarDirectorio excepción:', e.message || e);
                    resolve(false);
                }
            });
        }).catch(function (e) {
            log.warn('guardarDirectorio falló:', e.message || e);
            return false;
        });
    };

    VP.db.obtenerDirectorio = function () {
        log.debug('Recuperando directorio guardado…');
        if (!estaLista()) {
            log.warn('obtenerDirectorio: IDB no disponible.');
            return Promise.resolve(null);
        }

        return new Promise(function (resolve) {
            try {
                var tx  = _db.transaction('dirHandle', 'readonly');
                var req = tx.objectStore('dirHandle').get('lastDir');

                req.onsuccess = function () {
                    var r = req.result;
                    if (!r || !r.handle) {
                        log.debug('obtenerDirectorio: no hay handle guardado.');
                        return resolve(null);
                    }

                    var handle        = r.handle;
                    var promesaPerm;

                    // Usar queryPermission en lugar de requestPermission al cargar,
                    // ya que requestPermission requiere un gesto del usuario en Chrome/Brave.
                    if (typeof handle.queryPermission === 'function') {
                        promesaPerm = handle.queryPermission({ mode: 'readwrite' })
                            .catch(function () { return handle.queryPermission({ mode: 'read' }); });
                    } else {
                        promesaPerm = Promise.resolve('granted');
                    }

                    promesaPerm.then(function (permiso) {
                        // Conservar el handle aunque el permiso esté denegado. La
                        // siguiente selección puede usarlo como `startIn`, y el
                        // usuario puede volver a elegir esa carpeta desde el picker.
                        // Eliminarlo aquí hacía perder esa referencia antes de que
                        // el flujo de carga pudiera recuperarla.
                        resolve(handle);
                    }).catch(function () { resolve(handle); });
                };

                req.onerror = function () { resolve(null); };
            } catch (e) {
                log.warn('obtenerDirectorio excepción:', e.message || e);
                resolve(null);
            }
        });
    };

    VP.db.eliminarDirectorio = function () {
        return VP.db.eliminar('dirHandle', 'lastDir').catch(function () {
            return false;
        });
    };

    VP.db.guardarUbicacionArchivos = function (handle) {
        if (!estaLista() || !handle) {
            return Promise.resolve(false);
        }
        return new Promise(function (resolve) {
            try {
                var tx = _db.transaction('dirHandle', 'readwrite');
                tx.objectStore('dirHandle').put({
                    id: 'lastFileDir', handle: handle, _ts: ahora(),
                });
                tx.oncomplete = function () { resolve(true); };
                tx.onerror    = function () { resolve(false); };
                tx.onabort    = function () { resolve(false); };
            } catch (e) {
                log.warn('guardarUbicacionArchivos excepción:', e.message || e);
                resolve(false);
            }
        });
    };

    VP.db.obtenerUbicacionArchivos = function () {
        if (!estaLista()) {
            return Promise.resolve(null);
        }
        return new Promise(function (resolve) {
            try {
                var tx  = _db.transaction('dirHandle', 'readonly');
                var req = tx.objectStore('dirHandle').get('lastFileDir');
                req.onsuccess = function () {
                    var r = req.result;
                    if (!r || !r.handle) return resolve(null);
                    resolve(r.handle);
                };
                req.onerror = function () { resolve(null); };
            } catch (e) {
                resolve(null);
            }
        });
    };

    // ============================================================
    // §12  METADATOS
    // ============================================================

    VP.db.obtenerMetadatos = function (id) {
        if (!id) return Promise.resolve(null);

        var cached = _cacheMetadatos.get(id);
        if (cached !== undefined) {
            _stats.cacheHits++;
            log.debug('Metadatos en caché LRU:', id);
            return Promise.resolve(cached);
        }
        _stats.cacheMisses++;
        log.debug('Cargando metadatos desde IDB:', id);

        return VP.db.conReintentos(function () {
            return VP.db.obtener('metadata', id).then(function (r) {
                if (r) {
                    _cacheMetadatos.set(id, r);
                    log.debug('Metadatos cargados desde IDB:', id);
                }
                return r || null;
            });
        });
    };

    VP.db.guardarMetadatos = function (id, meta) {
        if (!id) {
            log.warn('guardarMetadatos: sin id.');
            return Promise.resolve(false);
        }
        log.debug('Guardando metadatos:', id);

        var claveCola = String(id);
        var anterior = _colasGuardarMetadatos[claveCola] || Promise.resolve();
        var escritura = anterior.catch(function () {}).then(function () {
            return VP.db.obtenerMetadatos(id).then(function (existente) {
                var fusionado = { id: id };

                // Fusionar existente + nuevo, en orden serial por video.
                var fuentes = [existente, meta];
                for (var f = 0; f < fuentes.length; f++) {
                    var src = fuentes[f];
                    if (!src || typeof src !== 'object') continue;
                    var claves = Object.keys(src);
                    for (var i = 0; i < claves.length; i++) {
                        fusionado[claves[i]] = src[claves[i]];
                    }
                }
                fusionado.id = id;

                _cacheMetadatos.set(id, fusionado);

                return VP.db.conReintentos(function () {
                    return VP.db.guardar('metadata', id, fusionado);
                });
            });
        });

        var cola = escritura.then(function () {
            if (_colasGuardarMetadatos[claveCola] === cola) delete _colasGuardarMetadatos[claveCola];
        }, function () {
            if (_colasGuardarMetadatos[claveCola] === cola) delete _colasGuardarMetadatos[claveCola];
        });
        _colasGuardarMetadatos[claveCola] = cola;
        return escritura;
    };

    VP.db.guardarMetadatosLote = function (items) {
        if (!items || !items.length) return Promise.resolve(0);
        var registros = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item || !item.id) continue;
            _cacheMetadatos.set(item.id, item);
            registros.push(item);
        }
        return VP.db.guardarLote('metadata', registros);
    };

    // ============================================================
    // §13  PROGRESO DE REPRODUCCIÓN
    // ============================================================

    /**
     * Carga todo el progreso desde IDB → memoria.
     * Alias compatible con el nombre que usa vp-init.js.
     */
    VP.db.cargarProgreso = function () {
        log.info('Cargando progreso de reproducción…');
        if (!estaLista()) {
            log.info('IDB no disponible, usando caché en memoria.');
            return Promise.resolve();
        }

        return VP.db.obtenerTodos('videoProgress').then(function (todos) {
            if (!todos || !todos.length) {
                return Promise.resolve();
            }

            var normalizados = _normalizarListaProgreso(todos);
            _cacheProgreso.clear();
            for (var i = 0; i < normalizados.length; i++) {
                _cacheProgreso.set(normalizados[i].fileName, normalizados[i]);
            }

            VP.estado.videoProgress = normalizados;
            VP.reconstruirMapaProgreso();
            log.debug('VP.db: progreso cargado:', normalizados.length, 'entradas (IDB)');

        }).catch(function (e) {
            log.error('cargarProgreso IDB falló:', e ? (e.message || e) : '');
        });
    };

    /**
     * Persiste todo el progreso en IDB (con debounce).
     */
    VP.db.guardarProgreso = function () {
        clearTimeout(_timerGuardarProgreso);
        _timerGuardarProgreso = setTimeout(
            _flushProgreso,
            cfg.guardarProgresoMs || 2000
        );
        log.debug('guardarProgreso programado en', (cfg.guardarProgresoMs || 2000) + 'ms');
    };

    function _flushProgreso() {
        var progreso = VP.estado.videoProgress;
        if (!progreso.length) {
            log.debug('_flushProgreso: sin progreso pendiente.');
            return;
        }
        log.debug('_flushProgreso: guardando', progreso.length, 'entradas…');

        if (estaLista()) {
            var registros = [];
            for (var i = 0; i < progreso.length; i++) {
                var p = progreso[i];
                if (!p || !p.fileName) continue;
                var reg    = { id: p.fileName, _ts: ahora() };
                var claves = Object.keys(p);
                for (var j = 0; j < claves.length; j++) {
                    if (claves[j] !== 'id') reg[claves[j]] = p[claves[j]];
                }
                registros.push(reg);
            }

            if (registros.length) {
                VP.db.guardarLote('videoProgress', registros).catch(function (e) {
                    log.warn('guardarProgreso bulk falló:', e);
                });
            }
        }
    }

    /**
     * Guarda el progreso de UN video específico (sin debounce).
     */
    VP.db.guardarProgresoUno = function (fileName) {
        if (!fileName) {
            log.warn('guardarProgresoUno: sin fileName.');
            return Promise.resolve(false);
        }

        var idx = VP.db.indiceDe(fileName);
        if (idx < 0) {
            log.debug('guardarProgresoUno: no encontrado en índice:', fileName);
            return Promise.resolve(false);
        }

        var p = VP.estado.videoProgress[idx];
        if (!p) {
            log.debug('guardarProgresoUno: sin datos de progreso:', fileName);
            return Promise.resolve(false);
        }

        _cacheProgreso.set(fileName, p);
        log.debug('Guardando progreso individual:', fileName);

        if (!estaLista()) {
            log.debug('IDB no disponible, no se puede guardar progreso individual.');
            return Promise.resolve(false);
        }

        return VP.db.guardar('videoProgress', fileName, p).catch(function () {
            return false;
        });
    };

    // ── Acceso al progreso en memoria ────────────────────────

    VP.db.indiceDe = function (fileName) {
        if (!fileName) return -1;

        // 1. Mapa O(1)
        var mapa = VP.cache.mapaProgreso;
        var idx  = mapa[fileName];

        if (idx !== undefined &&
            idx >= 0 &&
            idx < VP.estado.videoProgress.length) {
            var entry = VP.estado.videoProgress[idx];
            if (entry && entry.fileName === fileName) return idx;
        }

        // 2. Búsqueda lineal (reconstruye mapa si lo encuentra)
        var arr = VP.estado.videoProgress;
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] && arr[i].fileName === fileName) {
                mapa[fileName] = i;
                return i;
            }
        }

        return -1;
    };

    VP.db.obtenerProgresoPor = function (fileName) {
        if (!fileName) return null;

        var cached = _cacheProgreso.get(fileName);
        if (cached !== undefined) return cached;

        var i = VP.db.indiceDe(fileName);
        if (i >= 0) {
            var p = VP.estado.videoProgress[i];
            if (p) _cacheProgreso.set(fileName, p);
            return p || null;
        }
        return null;
    };

    VP.db.actualizarProgreso = function (fileName, currentTime,
                                          duracion, extra) {
        if (!fileName) {
            log.warn('actualizarProgreso: sin fileName.');
            return;
        }
        log.debug('actualizando progreso:', fileName, '→', currentTime?.toFixed?.(1) || currentTime, 's');
        duracion = Number(duracion || 0);
        currentTime = Number(currentTime || 0);
        if (!isFinite(duracion) || duracion < 0) duracion = 0;
        if (!isFinite(currentTime) || currentTime < 0) currentTime = 0;
        if (duracion > 0 && currentTime > duracion) currentTime = duracion;
        extra    = extra    || {};

        var obj = {
            fileName:    fileName,
            id:          fileName,
            currentTime: currentTime || 0,
            duration:    duracion,
            completado:  duracion > 0 && (currentTime / duracion) > 0.93,
            _ts:         ahora(),
        };

        var claves = Object.keys(extra);
        for (var j = 0; j < claves.length; j++) {
            obj[claves[j]] = extra[claves[j]];
        }

        var i = VP.db.indiceDe(fileName);
        if (i >= 0) {
            VP.estado.videoProgress[i] = obj;
        } else {
            VP.estado.videoProgress.push(obj);
            VP.cache.mapaProgreso[fileName] =
                VP.estado.videoProgress.length - 1;
        }

        _cacheProgreso.set(fileName, obj);
    };

    // ============================================================
    // §14  PREFERENCIAS
    // ============================================================

    VP.db.guardarPreferencia = function (clave, valor) {
        return VP.db.guardar('preferences', clave, { valor: valor });
    };

    VP.db.obtenerPreferencia = function (clave, porDefecto) {
        return VP.db.obtener('preferences', clave).then(function (r) {
            if (r && typeof r.valor !== 'undefined') return r.valor;
            return (porDefecto !== undefined) ? porDefecto : null;
        });
    };

    VP.db.guardarPreferenciasLote = function (obj) {
        if (!obj || typeof obj !== 'object') return Promise.resolve(0);
        var claves    = Object.keys(obj);
        var registros = [];
        for (var i = 0; i < claves.length; i++) {
            registros.push({ id: claves[i], valor: obj[claves[i]] });
        }
        return VP.db.guardarLote('preferences', registros);
    };

    // ============================================================
    // §14b  KEYVAL STORE (reemplazo completo de localStorage)
    // ============================================================

    /**
     * Precarga todos los datos del store keyval en _cacheKeyVal.
     */
    function _precargarKeyVal() {
        return VP.db.obtenerTodos('keyval').then(function (registros) {
            if (Array.isArray(registros)) {
                for (var i = 0; i < registros.length; i++) {
                    var r = registros[i];
                    if (r && r.id) {
                        _cacheKeyVal[r.id] = r.valor;
                    }
                }
            }
            log.debug('keyval: precargadas', Object.keys(_cacheKeyVal).length, 'entradas');
        }).catch(function () {
            log.warn('keyval: precarga falló, usando caché vacía');
        });
    }

    /**
     * Guarda un valor en keyval (caché + IDB). Async fire-and-forget.
     */
    VP.db.guardarKeyVal = function (clave, valor) {
        _cacheKeyVal[clave] = valor;
        if (_keyValListo) {
            return VP.db.guardar('keyval', clave, { valor: valor });
        }
        return Promise.resolve(true);
    };

    /**
     * Obtiene un valor del keyval (solo caché en memoria, síncrono).
     */
    VP.db.obtenerKeyVal = function (clave) {
        if (clave in _cacheKeyVal) return _cacheKeyVal[clave];
        return null;
    };

    /**
     * Elimina un valor del keyval (caché + IDB). Async fire-and-forget.
     */
    VP.db.eliminarKeyVal = function (clave) {
        delete _cacheKeyVal[clave];
        if (_keyValListo) {
            return VP.db.eliminar('keyval', clave);
        }
        return Promise.resolve(true);
    };

    /**
     * Retorna todas las claves del keyval.
     */
    VP.db.clavesKeyVal = function () {
        return Object.keys(_cacheKeyVal);
    };

    /**
     * Limpia todo el keyval store (caché + IDB).
     */
    VP.db.limpiarKeyVal = function () {
        _cacheKeyVal = Object.create(null);
        if (_keyValListo) {
            return VP.db.limpiarStore('keyval');
        }
        return Promise.resolve(true);
    };

    // ============================================================
    // §15  LIMPIEZA DE CACHÉ
    // ============================================================

    VP.db.limpiarCacheAntigua = function (max) {
        max = max || cfg.maxEntradasCache || 500;
        if (!estaLista()) return Promise.resolve();

        var stores = ['thumbnails', 'thumbnailArrays', 'metadata', 'videoProgress'];

        return Promise.all(stores.map(function (store) {
            return VP.db.obtenerTodosOrdenados(store).then(function (ordenados) {
                var exceso = ordenados.length - max;
                if (exceso <= 0) return 0;

                var ids = [];
                for (var i = 0; i < exceso; i++) ids.push(ordenados[i].id);

                _stats.evicciones += ids.length;
                return VP.db.eliminarLote(store, ids);
            }).catch(function (e) {
                log.warn('limpiarCacheAntigua error en', store, ':', e);
                return 0;
            });
        }));
    };

    VP.db.limpiarCacheCompleta = function () {
        if (VP.ajustes.confirmarLimpiarCache) {
            var ok = false;
            try {
                ok = window.confirm(
                    '¿Limpiar la caché de la carpeta actual?\n' +
                    '(se eliminarán miniaturas, metadatos y datos de IA; se conservarán tus ajustes, el progreso y la carpeta seleccionada)'
                );
            } catch (_) { ok = true; }
            if (!ok) return Promise.resolve(false);
        }

        // Identificadores de los videos de la carpeta actual
        var nombresActuales = [];
        var idsActuales     = [];
        var todosVideos     = (VP.estado && VP.estado.videos) || [];
        for (var vi = 0; vi < todosVideos.length; vi++) {
            var v = todosVideos[vi];
            if (!v) continue;
            if (v.name) nombresActuales.push(v.name);
            if (v.id)   idsActuales.push(v.id);
        }

        var promesas = [];

        // ---- Stores con clave = video name ----
        promesas.push(VP.db.eliminarLote('thumbnails',       nombresActuales));
        promesas.push(VP.db.eliminarLote('thumbnailArrays',  nombresActuales));

        // ---- Metadata: clave mixta (name e id) ----
        var clavesMeta  = [];
        var metaSet     = {};
        function _addClaveMeta(k) { if (k && !metaSet[k]) { metaSet[k] = true; clavesMeta.push(k); } }
        for (var mi = 0; mi < nombresActuales.length; mi++) _addClaveMeta(nombresActuales[mi]);
        for (var mj = 0; mj < idsActuales.length;     mj++) _addClaveMeta(idsActuales[mj]);
        promesas.push(VP.db.eliminarLote('metadata', clavesMeta));

        return Promise.all(promesas).then(function (resultados) {
            var todoOk = resultados.every(function(r) { return r !== false; });

            // Limpiar cachés LRU en memoria
            _cacheMiniatura.clear();
            _cacheMetadatos.clear();

            // Limpiar keyval: solo claves de IA que coincidan con videos actuales
            var clavesKV = Object.keys(_cacheKeyVal);
            var prefijosIA = ['vpRecIA_','vpRecIA_emb_','vpTagsIA_','vpChapIA_','vpChatIA_','vpTransIA_','vpVisionIA_','vpCommentIA_','vp_ai_','summaryIA_'];
            var nombresActualesSet = new Set(nombresActuales);
            for (var ci = 0; ci < clavesKV.length; ci++) {
                var ck = clavesKV[ci];
                for (var pi = 0; pi < prefijosIA.length; pi++) {
                    if (ck.indexOf(prefijosIA[pi]) === 0) {
                        // Solo limpiar si coincide con un video actual
                        if (nombresActualesSet.has(ck.slice(prefijosIA[pi].length))) _keyValEliminar(ck);
                        break;
                    }
                }
            }

            // Limpiar referencias en objetos de video
            for (var i = 0; i < todosVideos.length; i++) {
                if (!todosVideos[i]) continue;
                todosVideos[i].thumbnail      = null;
                todosVideos[i].thumbnailArray = null;
                todosVideos[i]._tagsIA        = null;
                todosVideos[i]._thumbQueued   = false;
                todosVideos[i]._durQueued     = false;
            }

            if (VP.cache && VP.cache.lruThumbs) VP.cache.lruThumbs.clear();

            VP.bus.emit('cacheVaciada');

            if (VP.ui && VP.ui.mostrarNotificacion) {
                VP.ui.mostrarNotificacion(
                    todoOk ? 'Caché eliminada correctamente' : 'Caché parcialmente eliminada',
                    todoOk ? 'exito' : 'advertencia'
                );
            }

            log.info('Caché limpiada. Stores OK:', todoOk);
            // Al reiniciar, la carpeta conservada vuelve a cargarse y el flujo
            // normal de videosCargados genera de nuevo miniaturas y duraciones.
            if (todoOk) {
                try { window.sessionStorage.setItem('vpReloadAfterCacheClear', '1'); } catch (_) {}
                window.setTimeout(function () { window.location.reload(); }, 350);
            }
            return todoOk;

        }).catch(function (e) {
            log.error('limpiarCacheCompleta falló:', e ? (e.message || e) : '');
            if (VP.ui && VP.ui.mostrarNotificacion) {
                VP.ui.mostrarNotificacion('Error al limpiar caché', 'error');
            }
            return false;
        });
    };

    // ============================================================
    // §16  MONITOR DE ALMACENAMIENTO
    // ============================================================

    VP.db.iniciarMonitorAlmacenamiento = function () {
        if (!VP.features.storageEstimate) return;

        function verificar() {
            navigator.storage.estimate().then(function (est) {
                if (!est || !est.quota) return;
                var pct = (est.usage || 0) / est.quota;

                if (pct > 0.95) {
                    log.warn('Almacenamiento crítico:', Math.round(pct * 100) + '%');
                    VP.db.eviccionarLote('thumbnails').catch(function () {});
                    VP.db.eviccionarLote('metadata').catch(function () {});
                    if (VP.ui && VP.ui.mostrarNotificacion) {
                        VP.ui.mostrarNotificacion(
                            'Almacenamiento casi lleno (' +
                            Math.round(pct * 100) + '%). Limpiando…',
                            'error'
                        );
                    }
                    VP.bus.emit('almacenamientoCritico', { pct: pct });
                } else if (pct > 0.85) {
                    log.warn('Almacenamiento alto:', Math.round(pct * 100) + '%');
                    VP.bus.emit('almacenamientoAlto', { pct: pct });
                }
            }).catch(function () {});
        }

        setTimeout(verificar, 5000);
        setInterval(verificar, 300000);
    };

    // ============================================================
    // §17  DIAGNÓSTICO
    // ============================================================

    VP.db.diagnostico = function () {
        if (!estaLista()) {
            return Promise.resolve({
                estado:         'NO_DISPONIBLE',
                fallido:        VP.runtime.idb.fallido,
                circuitBreaker: _cb.estado,
            });
        }

        return Promise.all(STORES_VALIDOS.map(function (s) {
            return VP.db.contar(s).then(function (n) {
                return { store: s, count: n };
            });
        })).then(function (conteos) {
            var resultado = {
                estado:         'OK',
                version:        _db ? _db.version : 0,
                circuitBreaker: _cb.estado,
                contFallas:     _cb.contFallas,
                stats:          {},
                stores:         {},
                cacheLRU: {
                    progreso:   _cacheProgreso.size,
                    metadatos:  _cacheMetadatos.size,
                    miniaturas: _cacheMiniatura.size,
                },
                colaPendiente:  _colaEscrituraPendiente.length,
            };

            // Copiar stats
            var sk = Object.keys(_stats);
            for (var i = 0; i < sk.length; i++) {
                resultado.stats[sk[i]] = _stats[sk[i]];
            }

            for (var j = 0; j < conteos.length; j++) {
                resultado.stores[conteos[j].store] = conteos[j].count;
            }

            return resultado;
        });
    };

    // ============================================================
    // §18  EXPORTAR / IMPORTAR
    // ============================================================

    VP.db.exportarDatos = function () {
        var datos = {
            version:     VP.version,
            dbVersion:   _db ? _db.version : 0,
            exportadoEn: new Date().toISOString(),
            ajustes:     {},
            progreso:    VP.estado.videoProgress.slice(),
            historial:   VP.estado.historialReproduccion.slice(),
        };

        var claves = VP.ajustes._claves || [];
        for (var i = 0; i < claves.length; i++) {
            datos.ajustes[claves[i]] = VP.ajustes[claves[i]];
        }

        return datos;
    };

    VP.db.importarDatos = function (datos) {
        log.info('Importando datos de respaldo…');
        if (!datos || typeof datos !== 'object') {
            log.error('importarDatos: datos inválidos');
            return false;
        }
        log.debug('Datos recibidos:',
                  'progreso=' + (Array.isArray(datos.progreso) ? datos.progreso.length : 0),
                  'historial=' + (Array.isArray(datos.historial) ? datos.historial.length : 0));

        var ok = true;

        if (datos.ajustes && typeof datos.ajustes === 'object') {
            var claves = VP.ajustes._claves || [];
            for (var i = 0; i < claves.length; i++) {
                var k = claves[i];
                if (k in datos.ajustes) {
                    try { VP.ajustes[k] = datos.ajustes[k]; }
                    catch (e) {
                        log.warn('importarDatos: ajuste', k, ':', e);
                        ok = false;
                    }
                }
            }
        }

        if (Array.isArray(datos.progreso)) {
            var progresoImportado = _normalizarListaProgreso(datos.progreso);
            VP.estado.videoProgress = progresoImportado;
            VP.reconstruirMapaProgreso();
            _cacheProgreso.clear();
            for (var j = 0; j < progresoImportado.length; j++) {
                var p = progresoImportado[j];
                _cacheProgreso.set(p.fileName, p);
            }
            VP.db.guardarProgreso();
        }

        if (Array.isArray(datos.historial)) {
            VP.estado.historialReproduccion =
                datos.historial.slice(-cfg.maxHistorial);
        }

        log.info('importarDatos completado. OK:', ok);
        return ok;
    };

    // ============================================================
    // §19  REINICIALIZACIÓN
    // ============================================================

    VP.db.reinicializar = function () {
        log.info('IDB: reinicializando…');
        if (_db) { try { _db.close(); } catch (_) {} }
        _db                    = null;
        VP.runtime.db          = null;
        VP.runtime.idb.listo   = false;
        VP.runtime.idb.fallido = false;
        _inicializando         = false;
        _cb.resetear();
        return VP.db.inicializar();
    };

    // ============================================================
    // §20  EVENTOS DEL BUS
    // ============================================================

    VP.bus.on('cacheVaciada', function () {
        _cacheMiniatura.clear();
        _cacheMetadatos.clear();
        _cacheProgreso.clear();
    });

    VP.bus.on('videoEliminado', function (video) {
        var key = video.nombre || video.name || video.id;
        if (!key) return;
        _cacheMiniatura.delete(key);
        _cacheMetadatos.delete(key);
        _cacheProgreso.delete(key);
        VP.db.eliminarArrayMiniaturas(key).catch(function () {});
    });

    VP.bus.on('idbCerrada', function () {
        log.warn('IDB cerrada, reconectando en 3s…');
        setTimeout(function () {
            VP.db.reinicializar().then(function (ok) {
                if (ok) log.info('IDB reconectada');
                else    log.error('IDB no pudo reconectarse');
            });
        }, 3000);
    });

    // ============================================================
    // §21  LIMPIEZA AL CERRAR
    // ============================================================

    window.addEventListener('beforeunload', function () {
        // Flush inmediato del progreso pendiente
        try {
            clearTimeout(_timerGuardarProgreso);
            _flushProgreso();
        } catch (_) {}
    });

    // ============================================================
    // §22  VERIFICACIÓN DEL MÓDULO
    // ============================================================

    (function verificarModulo() {
        var requeridos = [
            'inicializar',       'obtener',              'guardar',
            'eliminar',          'limpiarStore',         'obtenerTodos',
            'guardarLote',       'eliminarLote',         'obtenerMiniatura',
            'guardarMiniatura',  'guardarMiniaturaLote', 'obtenerArrayMiniaturas',
            'guardarArrayMiniaturas', 'eliminarArrayMiniaturas', 'guardarDirectorio',
            'obtenerDirectorio', 'obtenerMetadatos',     'guardarMetadatos',
            'cargarProgreso',    'guardarProgreso',
            'guardarProgresoUno','obtenerProgresoPor',   'actualizarProgreso',
            'limpiarCacheAntigua','limpiarCacheCompleta','exportarDatos',
            'importarDatos',     'diagnostico',          'reinicializar',
            'limpiarHuerfanas',  'eviccionarLote',       'conReintentos',
            'guardarKeyVal',     'obtenerKeyVal',        'eliminarKeyVal',
            'clavesKeyVal',      'limpiarKeyVal',
        ];

        var faltantes = [];
        for (var i = 0; i < requeridos.length; i++) {
            if (typeof VP.db[requeridos[i]] !== 'function') {
                faltantes.push(requeridos[i]);
            }
        }

        if (faltantes.length) {
            log.error('vp-db.js: funciones faltantes →', faltantes.join(', '));
        }
    })();

    // ============================================================
    // §23  DIAGNÓSTICO EN CONSOLA
    // ============================================================

    window.__vpDB = function () {
        VP.db.diagnostico().then(function (d) {
            console.table(d.stores || {});
            console.log('[VP/DB]', d);
        });
    };

    log.info('vp-db.js cargado correctamente.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-db.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
