'use strict';

// ============================================================
// VP-OPENSUBTITLES.JS  —  v1.4.1
// Búsqueda y descarga de subtítulos en OpenSubtitles.com
// para videos que NO tienen subtítulos asociados.
//
// Se abre desde el botón de Subtítulos cuando el video actual
// no trae subtítulo. Permite buscar por nombre, elegir idioma,
// ver resultados (release, idioma, descargas, puntuación),
// descargar, convertir y aplicar sin recargar el video.
//
// PERSISTENCIA:
//   · El VTT final se guarda en IndexedDB vía vp-subtitulos (igual
//     que un subtítulo cargado manualmente).
//   · Un índice ligero en localStorage mapea video → subtítulo
//     descargado, para avisar "Ya tienes ..." la próxima vez.
//     (Desde v1.2.0 el índice lleva versión de esquema y migra
//     automáticamente el formato antiguo.)
//   · El contador de descargas del día se guarda por fecha (UTC).
//
// CORS / file://:
//   La API de OpenSubtitles responde `Access-Control-Allow-Origin: *`,
//   por lo que fetch() funciona directamente desde file:// (origen null).
//   Kong bloquea User-Agent no-navegador, así que se envía
//   `X-User-Agent` (alternativa documentada por la propia API).
//
// CAMBIOS v1.4.1 (revisión externa + guardar en disco + ventana móvil):
//   · SEGURIDAD: CFG.API_KEY se queda en ''. La key vive solo en el
//     almacenamiento local, desde el campo del modal. Se exporta
//     `config()` (copia sin API_KEY) en vez del CFG crudo.
//   · _borrarSesion ya borraba de verdad: usaba localStorage.removeItem
//     mientras _guardarSesion escribía con util.storageSet, que delega
//     en VP.db (IndexedDB). El token se quedaba vivo: cerrar sesión no
//     cerraba la sesión. Nuevo helper _lsDel(), coherente con lectura y
//     escritura, usado para token y para la caché de TMDB.
//   · La cuota va firmada por dueño ('anon' o el usuario). Antes, una
//     cuota anónima agotada seguía bloqueando la descarga tras iniciar
//     sesión, cuando el margen es mayor. Al login y al logout se
//     reinicia el registro.
//   · Los textos de cuota ya no afirman "5/día" con una sesión activa,
//     y `estadoCuota().limite` devuelve null cuando la hay.
//   · El botón de login ya no se queda bloqueado: _cancelarPendientes
//     y _abrir lo reactivan, y _login captura el aborto del hueco de
//     ritmo (que estaba fuera del try y dejaba una promesa rechazada).
//   · _claveVideo ya NO usa `vObj.id` como clave principal: los ids se
//     generan con util.generarId() (timestamp+contador+random) y cambian
//     en cada recarga, así que el índice se llenaba de basura. Ahora la
//     clave es nombre+tamaño+fecha, con migración desde las tres claves
//     antiguas.
//   · El título original resuelto ya no es un global: viaja pegado al
//     array de resultados, así sobrevive a la caché y no se contamina
//     entre búsquedas.
//   · /features filtra por tipo (película/serie) y por año; TMDB elige
//     el resultado cuya fecha coincide en vez de tomar el primero.
//   · La key de TMDB se guarda también al pulsar Buscar, no solo con
//     el evento 'change'.
//   · Aviso cuando los resultados no encajan y no hay forma de resolver
//     el título.
//   · NUEVO: el subtítulo se guarda como .vtt junto al video, con su
//     mismo nombre (File System Access API; se omite donde no existe).
//   · NUEVO: la ventana se registra en vp-flotante-ia, así que se
//     arrastra y recuerda su posición como las demás.
//   · El enlace de descarga debe ser https (sin restringir dominio:
//     las descargas reales salen de otros CDN).
//   · El id del archivo y el de la sugerencia de título ya no se pisan:
//     #osArchivoInfo y #osSugerenciaTitulo son contenedores separados.
//
// CAMBIOS v1.4.0 (títulos localizados + corrección de la premisa de login):
//   · CORRECCIÓN IMPORTANTE: se verificó contra la API real que
//     `POST /download` devuelve 200 SIN token (quota anónima por IP).
//     El 401 sin token es de `/infos/user`, no de `/download`. Por eso
//     la descarga YA NO se bloquea por falta de sesión: el login queda
//     como mejora (más cuota, 20–1000/día según rango) y no como
//     requisito. Ver CAMBIOS v1.3.0 más abajo para el detalle.
//   · `_buscar` tiene un paso nuevo: si el texto no da resultados, se
//     consulta /features (OpenSubtitles) y, si este devuelve un
//     tmdb_id, se reintenta /subtitles con `tmdb_id` y SIN query.
//   · `_resolverTMDB` (respaldo con TMDB) para cuando /features no
//     resuelve: busca en TMDB con `language=es-MX` y devuelve el
//     título original, que es el que indexa OpenSubtitles.
//   · Caché de resolución (consulta+año → tmdb_id) en localStorage,
//     con poda como el índice de subtítulos.
//   · Sugerencia "¿Quisiste decir «X»?" cuando TMDB/features
//     devuelven un título distinto del escrito, con botón que rellena
//     el input y relanza la búsqueda.
//   · Key de TMDB configurable en el modal (vpOpenSub__tmdbKey).
//   · La búsqueda NUNCA falla por culpa de TMDB: cualquier error suyo
//     se ignora en silencio y se sigue con el comportamiento anterior.
//   · `diagnostico()` añade `tmdbKey` y `ultimoOriginal` (booleanos/
//     texto, nunca claves).
//
// CAMBIOS v1.3.0 (login de OpenSubtitles):
//   · `_login(usuario, clave)` → POST /login {username, password}.
//     Un solo intento, respetando el límite oficial de 1 req/s del
//     endpoint (INTERVALO_LOGIN_MS = 1100 ms).
//   · Sesión { token, exp, usuario, baseUrl } en localStorage bajo
//     `vpOpenSub__token`. La CONTRASEÑA nunca se guarda: solo vive en
//     el input y se vacía justo después del envío (éxito o error).
//   · Se usa el `exp` del propio JWT si se puede leer (base64url
//     dentro de try/catch); si no, se cae a TOKEN_VIDA_MS.
//     La vigencia real documentada es de 24 h; se usan 23 h de margen.
//   · `base_url` devuelto por /login solo se acepta si es https y el
//     host es opensubtitles.com o un subdominio suyo.
//   · `_fetchJSON` admite `auth: true` → añade `Authorization: Bearer`
//     solo si hay sesión vigente. El token NUNCA sale hacia otro
//     dominio: `_bajarEnlace` y TMDB siguen sin cabeceras de auth.
//   · `/download` manda el token si hay sesión, pero NO es obligatorio:
//     ver la corrección de la premisa en v1.4.0.
//   · 401 o {"message":"invalid token"} → se borra la sesión y se avisa,
//     sin reintento automático (el POST /download nunca se reintenta).
//   · API pública: iniciarSesion(), cerrarSesion(), tieneSesion().
//     `cerrarSesion()` es solo local: la documentación no exige /logout
//     y el token caduca solo en 24 h.
//   · UI: bloque de login reutilizando el estilo de la API key.
//
// CAMBIOS v1.2.1 (correcciones verificadas contra la API real):
//   · Un 429 de ritmo ya NO bloquea las descargas hasta el día siguiente:
//     solo un 406 con mensaje de cuota cuenta como límite (el 429 dice
//     "Throttle limit reached" y contenía "limit").
//   · Se guarda y respeta el `reset_time_utc` que devuelve la API en el 406,
//     en lugar de asumir reinicio a medianoche UTC.
//   · 401 en /download se distingue y se avisa de que hace falta login.
//   · El File que se aplica es SIEMPRE .vtt (vp-subtitulos elige
//     conversor por extensión y reconvertía un VTT como SRT).
//   · _validarVtt acepta solo punto decimal (en VTT la coma hace que el
//     navegador ignore el cue entero).
//   · _decodificar acepta el idioma y elige el charset de reserva del
//     alfabeto (windows-1251/1253/1255/1256/1250/1254, shift_jis, euc-kr,
//     gbk, big5) en vez de caer siempre a windows-1252 (mojibake en ru/el/
//     he/ar/pl/tr/ja/ko/zh). El idioma se propaga desde _descargar.
//   · _claveVideo usa el id (o nombre+tamaño) en lugar de `name || id`,
//     así dos archivos homónimos en carpetas distintas no comparten
//     subtítulo. El índice guardado con la clave antigua se migra al leer.
//   · abrir() con el modal ya abierto ya no captura como "foco a
//     restaurar" un elemento del propio modal.
//   · Un moviehash que falla solo por timeout ya no se cachea como null
//     (se reintenta en la siguiente búsqueda).
//   · El prellenado del input nunca manda el nombre con extensión.
//   · destruir() retira el listener de Escape de respaldo y resetea
//     eventosIA / escFallback: si no, recargar el script dejaba el
//     Escape sin registrar para siempre.
//   · _lsSet respeta el retorno de util.storageSet (devuelve booleano,
//     no relanza): sin esto el reintento por almacenamiento lleno nunca
//     se disparaba.
//   · Idioma 'sp' eliminado: no existe en /infos/languages de la API v1.
//   · Si el hash no produce ninguna coincidencia, se hace una segunda
//     consulta SOLO por moviehash y se une con la anterior sin duplicar
//     por fileId (con query+moviehash, un nombre mal escrito excluía
//     justo la coincidencia exacta).
//
// CAMBIOS v1.2.0 (robustez + alcance):
//   · Búsqueda por hash OpenSubtitles (moviehash) del archivo de
//     video cuando está disponible: los resultados que coinciden
//     exactamente con tu archivo se marcan y se ordenan primero.
//   · Paginación: si la API devuelve varias páginas, se piden hasta
//     MAX_PAGINAS para llenar la lista de resultados.
//   · Limitador de ritmo del lado cliente (la API tolera pocas
//     peticiones por segundo): nunca se dispara una petición antes
//     de INTERVALO_MIN_PETICION_MS desde la anterior.
//   · Anti-rebote en Buscar: doble clic / doble Enter en <400 ms
//     ya no lanza dos búsquedas.
//   · Detección de sin-conexión (navigator.onLine + eventos
//     online/offline) con mensaje claro antes de gastar peticiones.
//   · Bloqueo local de descarga cuando la API ya informó 0 restantes
//     hoy (evita quemar una petición que fallará con 406).
//   · El enlace firmado que devuelva HTML (portal cautivo, error del
//     CDN) se detecta y se rechaza con mensaje claro.
//   · Reparación de SRT defectuosos antes de convertir: timestamps
//     sin ceros ("0:1:2,5"), flechas "->", etiquetas {\an8}.
//   · Validación estructural del VTT final (número de cues, formato
//     de tiempos, tope de cues para archivos corruptos gigantes).
//   · Badges en resultados: coincidencia por hash, subida verificada,
//     traducción automática/IA (y se penalizan en el orden), FPS.
//   · localStorage lleno (QuotaExceededError): se poda el índice a
//     la mitad y se reintenta el guardado una vez.
//   · Trampa de foco (Tab) dentro del modal y cierre con Escape de
//     respaldo si vp-eventos no está disponible.
//   · Jitter aleatorio en el back-off para no sincronizar reintentos.
//   · API pública nueva: buscarManual(), redescargarGuardado(),
//     limpiarCache(), diagnostico(), destruir(), VERSION.
//
// CAMBIOS v1.1.0 (robustez):
//   · Cancelación por "generación": cerrar/reabrir la ventana ya no
//     deja peticiones viejas pintando resultados en la ventana nueva.
//   · Un AbortController por petición (antes uno compartido).
//   · Timeout también sobre la lectura del cuerpo de la respuesta.
//   · Reintentos con back-off para GET ante red, 429 y 5xx
//     (el POST /download nunca se reintenta: gasta cuota).
//   · Temporada/episodio/año ya NO se perdían-al-limpiar: se
//     guardan al abrir y se envían a la API.
//   · Limpieza de nombre: ya no destruye "Spider-Man", "Se7en",
//     "Blade Runner 2049", "2001: A Space Odyssey", etc.
//   · Resultados renderizados con textContent (sin XSS por innerHTML).
//   · Un fallo de descarga ya no borra la lista de resultados.
//   · El índice se registra solo si el subtítulo se aplicó bien;
//     si falla adjuntar, se restaura el estado previo del video.
//   · No se aplica el subtítulo si el usuario cambió de video
//     mientras se descargaba.
//   · Cuota diaria persistente y detección del 406 de la API.
//   · Decodificación UTF-16/UTF-8/Windows-1252, límite de tamaño y
//     conversor SRT→VTT de respaldo.
//   · Eventos: sin duplicar registrarModalIA, sin cierre al arrastrar
//     un texto fuera del modal, foco restaurado al cerrar.
//
// Dependencias: vp-base.js · vp-utilidades.js · vp-dom.js ·
//               vp-db.js · vp-subtitulos.js
// ============================================================

(function (window, document) {

    if (window.__VP_OPENSUBTITLES_LOADED__) return;

    var VP = window.VP;
    if (!VP) throw new Error('[VP] vp-opensubtitles.js requiere vp-base.js');

    var util = VP.util;
    var dom  = VP.dom;
    var log  = VP.log;
    var bus  = VP.bus;

    if (!util || !dom || !log || !bus) {
        throw new Error('[VP] vp-opensubtitles.js: dependencias faltantes');
    }

    // El flag va DESPUÉS de validar dependencias: si faltaban, un
    // segundo intento de carga (ya con VP listo) no queda bloqueado.
    window.__VP_OPENSUBTITLES_LOADED__ = true;

    var VERSION = '1.4.1';

    // ---- Contexto de log propio ----
    // VP.log._context es GLOBAL y otros módulos lo sobrescriben, así
    // que cada llamada se envuelve en withContext() (si existe).
    var LOG_CTX = 'OpenSubtitles';

    function _log(nivel, args) {
        try {
            var fn = (typeof log[nivel] === 'function') ? log[nivel] : log.info;
            if (typeof fn !== 'function') return;
            if (typeof log.withContext === 'function') {
                return log.withContext(LOG_CTX, function () {
                    return fn.apply(log, args);
                });
            }
            return fn.apply(log, args);
        } catch (_) { /* el log nunca debe romper el flujo */ }
    }

    var warn  = function () { _log('warn',  arguments); };
    var info  = function () { _log('info',  arguments); };
    var debug = function () { _log('debug', arguments); };

    VP.opensubtitles = VP.opensubtitles || {};

    // ============================================================
    // 1. CONFIGURACIÓN
    // ============================================================

    var CFG = Object.freeze({

        BASE_URL   : 'https://api.opensubtitles.com/api/v1',

        // ------------------------------------------------------------
        // API KEY — NO VA AQUÍ
        // ------------------------------------------------------------
        // La key se guarda SOLO en localStorage (vpOpenSub__apiKey), desde
        // el campo del modal. No se deja ninguna constante con una key
        // real en el código: subirse el repositorio con una clave dentro
        // la deja expuesta para siempre, y se puede revocar pero no
        // borrar del historial. Consíguela en
        // https://www.opensubtitles.com/consumers :
        //   1. Inicia sesión en opensubtitles.com
        //   2. Entra a "API consumers" (en tu perfil)
        //   3. Crea un consumer nuevo → te da un "API Key"
        //   4. Pégala en la ventana de búsqueda
        //      (apartado "API key y sesión").
        // ------------------------------------------------------------
        API_KEY    : '',

        USER_AGENT : 'ReproductorWeb v0.5',

        // Red
        TIMEOUT_BUSQUEDA_MS   : 15000,
        TIMEOUT_DESCARGA_MS   : 30000,
        MAX_RESULTADOS        : 50,
        MAX_PAGINAS           : 3,                 // páginas de /subtitles por búsqueda
        MAX_BYTES_SUBTITULO   : 5 * 1024 * 1024,   // un .srt real pesa < 500 KB
        MAX_BYTES_DESCOMPRIMIDO : 20 * 1024 * 1024,
        MAX_ESPERA_RETRY_MS   : 8000,

        // Ritmo mínimo entre peticiones HTTP a la API (lado cliente).
        // La documentación pide no superar ~5 req/s; con 300 ms de
        // separación nunca nos acercamos.
        INTERVALO_MIN_PETICION_MS : 300,

        // Anti-rebote del botón Buscar / Enter
        DEBOUNCE_BUSQUEDA_MS  : 400,

        // Caché de búsquedas en memoria (evita 429 al repetir la misma)
        CACHE_BUSQUEDA_MS     : 5 * 60 * 1000,
        CACHE_BUSQUEDA_MAX    : 20,

        // Idioma por defecto (el selector permite cambiarlo)
        IDIOMA_PREDETERMINADO : 'es',

        // La API permite 5 descargas/día sin autenticar.
        MAX_DESCARGAS_DIA     : 5,

        // Reintentos con back-off (solo GET)
        MAX_REINTENTOS        : 2,
        BACKOFF_BASE_MS       : 800,
        BACKOFF_JITTER_MS     : 250,

        // Validación del subtítulo final
        MAX_CUES              : 20000,   // nada legítimo supera esto

        // Hash OpenSubtitles (moviehash)
        HASH_CHUNK            : 65536,   // 64 KB al inicio y 64 KB al final
        HASH_TIMEOUT_MS       : 4000,    // si el disco tarda, se busca sin hash

        // Persistencia
        LS_INDEX_KEY          : 'vpOpenSub__index',
        LS_INDEX_VERSION      : 2,
        LS_MAX_ENTRADAS       : 200,
        LS_PREF_IDIOMA        : 'vpOpenSub__idioma',
        LS_API_KEY            : 'vpOpenSub__apiKey',
        LS_CUOTA_KEY          : 'vpOpenSub__cuota',

        // ------------------------------------------------------------
        // SESIÓN (v1.3.0)
        // ------------------------------------------------------------
        LS_TOKEN_KEY          : 'vpOpenSub__token',

        // La documentación oficial dice que el JWT "/login" dura 24 h.
        // Usamos 23 h de margen: así el token se considera caducado
        // antes de que la API empiece a rechazarlo, y no dependemos de
        // un 401 para enterarnos.
        TOKEN_VIDA_MS         : 23 * 60 * 60 * 1000,

        // /login tiene un límite específico y más estricto que el
        // general: "1 request per 1 second, 10 per minute, 30 per hour"
        // (documentado literalmente en la descripción del endpoint).
        // 1100 ms deja margen sobre el segundo completo.
        INTERVALO_LOGIN_MS    : 1100,
        TIMEOUT_LOGIN_MS      : 15000,

        // ------------------------------------------------------------
        // TÍTULOS LOCALIZADOS (v1.4.0)
        // ------------------------------------------------------------
        // AVISO DE SEGURIDAD: el token de OpenSubtitles guardado en
        // localStorage es legible por CUALQUIER script que se ejecute
        // en la página. Es un riesgo XSS asumido a propósito para este
        // uso: el token solo da cuota de descarga de subtítulos de la
        // cuenta del usuario, no acceso a datos personales.
        TMDB_URL              : 'https://api.themoviedb.org/3',
        LS_TMDB_KEY           : 'vpOpenSub__tmdbKey',
        LS_TMDB_CACHE_KEY     : 'vpOpenSub__tmdbCache',
        LS_TMDB_CACHE_MAX     : 120,
        TMDB_TIMEOUT_MS       : 8000,
        // El índice de OpenSubtitles está en inglés y su búsqueda por
        // texto es difusa (OR por palabras). Con un título traducido
        // devuelve cientos de resultados de películas que solo comparten
        // palabras sueltas, así que para detectar "esto NO es la
        // película" hace falta que coincidan casi todos los términos
        // significativos. Con 0.75 basta un título correcto; con 0.34,
        // "Jefa por Accidente" pasaba por ser la película buscada.
        MIN_SIMILITUD_FALLIDA : 0.75,

        // v1.4.1: guardar el .vtt junto al video. El navegador solo
        // puede escribir en disco con la File System Access API (Chrome/
        // Edge/Opera); en Firefox y en file:// no existe y el guardado
        // se omite sin molestar.
        LS_GUARDAR_DISCO_KEY   : 'vpOpenSub__guardarEnDisco',
        GUARDAR_EN_DISCO       : true,
    });

    // ============================================================
    // 2. ESTADO
    // ============================================================

    // ---- Estado ----
    var _escFallbackFn = null;   // listener de Escape de respaldo (para destruir)

    var _s = {
        abierto        : false,
        resultados     : [],
        consultaActual : '',
        cargando       : false,
        descargando    : false,

        // "Generación": se incrementa al abrir/cerrar. Toda operación
        // asíncrona captura la generación con la que nació y, si al
        // volver ya no coincide, se descarta en silencio.
        gen            : 0,
        controllers    : [],

        intentos       : 0,
        metaPrefill    : null,   // temporada/episodio/año del archivo
        textoPrefill   : '',     // texto con el que se rellenó el input
        tokensVideo    : [],     // para ordenar por parecido
        foco           : null,   // elemento enfocado antes de abrir
        eventosIA      : false,  // registrarModalIA ya hecho
        escFallback    : false,  // listener Escape de respaldo ya puesto
        cacheBusqueda  : {},
        hashCache      : {},     // claveVideo → moviehash (o null si falló)
        ultimaPeticion : 0,      // ts de la última petición HTTP real
        ultimaBusqueda : 0,      // ts del último clic en Buscar (debounce)
        ultimoLogin    : 0,      // ts del último POST /login (límite 1/s)
        loginEnCurso   : false,  // evita dobles envíos del botón
        _docListeners  : [],

        // v1.4.1: el título original resuelto ya NO se guarda aquí;
        // viaja pegado al array de resultados (`_conOriginal`).
    };

    // ============================================================
    // 3. HELPERS
    // ============================================================

    function _el(id) {
        return document.getElementById(id);
    }

    function _on(el, ev, fn) {
        if (!el) return;
        el.addEventListener(ev, fn);
        _s._docListeners.push({ el: el, ev: ev, fn: fn });
    }

    function _limpiarListeners() {
        _s._docListeners.forEach(function (l) {
            try { l.el.removeEventListener(l.ev, l.fn); } catch (_) {}
        });
        _s._docListeners = [];
    }

    function _setVisible(id, visible) {
        var el = _el(id);
        if (!el) return;
        el.style.display = visible ? '' : 'none';
    }

    function _crear(tag, clase, texto) {
        var e = document.createElement(tag);
        if (clase) e.className = clase;
        if (texto != null) e.textContent = texto;
        return e;
    }

    function _notif(mensaje, tipo) {
        if (VP.ui && typeof VP.ui.mostrarNotificacion === 'function') {
            try { VP.ui.mostrarNotificacion(mensaje, tipo); }
            catch (e) { warn('notif:', e); }
        }
    }

    function _pad2(n) {
        n = String(n);
        return n.length >= 2 ? n : ('0' + n);
    }

    /** toLocaleString sin confiar en que Intl exista/funcione. */
    function _formatearNumero(n) {
        try { return Number(n).toLocaleString('es'); }
        catch (_) { return String(n); }
    }

    /** navigator.onLine solo es fiable cuando dice false. */
    function _sinConexion() {
        try { return navigator.onLine === false; }
        catch (_) { return false; }
    }

    /**
     * Crea un Error con propiedades extra (abortado, timeout, limite,
     * codigo…) sin repetir el patrón en cada sitio.
     */
    function _err(mensaje, props) {
        var e = new Error(mensaje);
        if (props) {
            for (var k in props) {
                if (Object.prototype.hasOwnProperty.call(props, k)) e[k] = props[k];
            }
        }
        return e;
    }

    // ---- localStorage tolerante a fallos ----

    function _lsGet(clave, def) {
        try {
            if (typeof util.storageGet === 'function') {
                var v = util.storageGet(clave, def);
                return v == null ? def : v;
            }
            var raw = window.localStorage.getItem(clave);
            return raw == null ? def : raw;
        } catch (_) {
            return def;
        }
    }

    /**
     * Importante: util.storageSet NO relanza la excepción; devuelve true/false.
     * Por eso hay que respetar su valor de retorno: si lo ignoramos, el
     * reintento de _guardarIndice (localStorage/IDB lleno) nunca se dispara.
     */
    function _lsSet(clave, valor) {
        try {
            if (typeof util.storageSet === 'function') {
                return util.storageSet(clave, valor) !== false;
            }
            window.localStorage.setItem(clave, valor);
            return true;
        } catch (e) {
            warn('No se pudo guardar "' + clave + '":', e);
            return false;
        }
    }

    /**
     * BORRADO coherente con la lectura/escritura (v1.4.1).
     *
     * Importante: `_lsGet`/`_lsSet` NO usan localStorage cuando existe
     * `util.storageGet`/`storageSet`, y esos delegan en
     * `VP.db.guardarKeyVal` (IndexedDB, store "keyval"). Borrar con
     * `window.localStorage.removeItem` NO borraba nada: el valor se
     * quedaba en la caché en memoria de vp-db y en su IndexedDB, así
     * que "cerrar sesión" no cerraba la sesión de verdad.
     *
     * `util` no expone `storageRemove` (solo `eliminarItem`), que es el
     * equivalente: usa el mismo `VP.db.eliminarKeyVal`. Por eso se
     * prefiere esa vía y se cae a localStorage solo si no existe.
     */
    function _lsDel(clave) {
        if (!clave) return false;
        try {
            if (typeof util.eliminarItem === 'function') {
                util.eliminarItem(clave);
                return true;
            }
            if (typeof util.storageRemove === 'function') {
                util.storageRemove(clave);
                return true;
            }
            window.localStorage.removeItem(clave);
            return true;
        } catch (e) {
            warn('No se pudo borrar "' + clave + '":', e);
            return false;
        }
    }

    /** Lee un objeto JSON guardado; siempre devuelve objeto plano o null. */
    function _leerJSON(clave) {
        var raw = _lsGet(clave, null);
        if (raw == null || raw === '') return null;
        if (typeof raw === 'object') return Array.isArray(raw) ? null : raw;
        try {
            var v = JSON.parse(raw);
            return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
        } catch (_) {
            return null;
        }
    }

    // ============================================================
    // 4. API KEY
    // ============================================================

    /**
     * Quita espacios, saltos de línea y cualquier carácter no ASCII:
     * un pegado con "\n" o espacio final hace que fetch lance
     * TypeError ("invalid header value") o que la API responda 403.
     */
    function _limpiarClave(c) {
        return String(c == null ? '' : c).replace(/[^\x21-\x7E]/g, '');
    }

    function _apiKey() {
        var c = _limpiarClave(CFG.API_KEY);
        if (c) return c;
        return _limpiarClave(_lsGet(CFG.LS_API_KEY, ''));
    }

    // ============================================================
    // 4b. SESIÓN DE OPENSUBTITLES (v1.3.0)
    // ============================================================

    /**
     * La CONTRASEÑA no existe en ninguna variable del módulo: solo
     * vive en el value del <input> mientras el usuario escribe y se
     * borra del DOM justo después de enviarse (éxito o error).
     * Este objeto solo guarda token + expiración + usuario.
     */

    /**
     * Valida el `base_url` que devuelve /login.
     * Solo se acepta si es https y el host es exactamente
     * opensubtitles.com o un subdominio suyo (vip-api.opensubtitles.com).
     * Cualquier otra cosa se ignora y se usa BASE_URL: enviar el token
     * a un host elegido por el servidor sería una vía de exfiltración.
     */
    function _validarBaseUrl(bruto) {
        if (!bruto || typeof bruto !== 'string') return null;
        var s = bruto.trim();
        // El endpoint devuelve a veces el host pelado ("api.opensubtitles.com").
        if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
        var u;
        try { u = new URL(s); } catch (_) { return null; }
        if (u.protocol !== 'https:') return null;
        var host = u.hostname.toLowerCase();
        var ok = (host === 'opensubtitles.com') ||
                 (host.slice(-18) === '.opensubtitles.com');
        return ok ? u.origin + '/api/v1' : null;
    }

    /**
     * Lee el `exp` (epoch en segundos) del payload del JWT, que va en
     * base64url. Nunca lanza: si el token no es un JWT legible se
     * devuelve null y se usa TOKEN_VIDA_MS.
     */
    function _expDeToken(token) {
        try {
            var partes = String(token).split('.');
            if (partes.length < 2) return null;
            var b64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            var json = decodeURIComponent(escape(
                atob(b64)                      // base64 → binario
            ));
            var payload = JSON.parse(json);
            var exp = Number(payload.exp);
            return isFinite(exp) && exp > 0 ? exp * 1000 : null;
        } catch (_) {
            return null;   // no es un JWT legible: se usa la vida por defecto
        }
    }

    /** Sesión vigente, o null (si no hay o ya caducó). */
    function _leerSesion() {
        var s = _leerJSON(CFG.LS_TOKEN_KEY);
        if (!s || typeof s.token !== 'string' || !s.token) return null;

        // Sin `exp` guardado (versión vieja / corrupta) se caduca.
        if (typeof s.exp !== 'number' || !isFinite(s.exp)) {
            _borrarSesion();
            return null;
        }
        if (Date.now() >= s.exp) {
            // Caducada: se limpia para no dejar un token muerto.
            _borrarSesion();
            return null;
        }
        return s;
    }

    function _guardarSesion(sesion) {
        return _lsSet(CFG.LS_TOKEN_KEY, JSON.stringify(sesion));
    }

    function _borrarSesion() {
        // Por _lsDel, no por localStorage directo: el token se guarda en
        // el keyval de vp-db (IndexedDB), no en localStorage.
        _lsDel(CFG.LS_TOKEN_KEY);
    }

    /** ¿Hay sesión vigente ahora mismo? */
    function _tieneSesion() {
        return !!_leerSesion();
    }

    /**
     * Host contra el que van las peticiones AUTENTICADAS. Por defecto
     * BASE_URL; cambia al `base_url` validado del /login (típicamente
     * vip-api para cuentas VIP).
     */
    function _baseUrl() {
        var s = _leerSesion();
        return (s && s.baseUrl) ? s.baseUrl : CFG.BASE_URL;
    }

    /**
     * POST /login. UN SOLO intento y sin reintentos: el endpoint está
     * limitado a 1 req/s, 10/min y 30/h precisamente porque hay
     * clientes que reintentan en bucle con credenciales malas.
     *
     * @returns {Promise<boolean>} true si se inició sesión.
     */
    async function _login(usuario, clave, gen) {
        usuario = String(usuario || '').trim();
        clave   = String(clave || '');

        if (!usuario || !clave) {
            _notif('Escribe tu usuario y tu contraseña de OpenSubtitles.', 'advertencia');
            return false;
        }
        if (!_apiKey()) {
            _notif('Falta la API key de OpenSubtitles.', 'advertencia');
            return false;
        }

        // Límite propio de /login, además del ritmo general.
        // Este await está FUERA del try de la petición: si el usuario
        // cierra el modal aquí, _dormir rechaza con {abortado:true} y
        // sin capturarla la promesa de _loginDesdeUI quedaba
        // rechazada (error "unhandled rejection") y el botón se
        // quedaba en "Entrando…" para siempre.
        var hueco = _s.ultimoLogin + CFG.INTERVALO_LOGIN_MS - Date.now();
        if (hueco > 0) {
            try {
                await _dormir(hueco, gen);
            } catch (e) {
                if (e && e.abortado) return false;   // cancelado: sin error
                throw e;
            }
        }
        if (_cancelada(gen)) return false;

        var resp;
        try {
            resp = await _fetchJSON(CFG.BASE_URL + '/login', {
                method : 'POST',
                body   : { username: usuario, password: clave },
                timeout: CFG.TIMEOUT_LOGIN_MS,
                gen    : gen,
            });
        } catch (e) {
            if (_cancelada(gen)) return false;
            // Ni usuario ni contraseña en el mensaje: _fetchJSON ya
            // devuelve texto amigable y nunca incluye el body enviado.
            _notif(e && e.message ? e.message
                                  : 'No se pudo iniciar sesión.', 'error');
            return false;
        } finally {
            _s.ultimoLogin = Date.now();
        }

        if (_cancelada(gen)) return false;

        if (!resp.ok) {
            _notif(_errorLogin(resp.status, resp.json), 'error');
            return false;
        }

        var datos = resp.json || {};
        if (typeof datos.token !== 'string' || !datos.token) {
            _notif('OpenSubtitles no devolvió un token válido.', 'error');
            return false;
        }

        // El `exp` real del JWT manda sobre la constante de 24 h.
        var exp = _expDeToken(datos.token) || (Date.now() + CFG.TOKEN_VIDA_MS);
        var usuarioReal = '';
        try {
            usuarioReal = (datos.user && (datos.user.username || datos.user.name)) || usuario;
        } catch (_) { usuarioReal = usuario; }

        _guardarSesion({
            token   : datos.token,
            exp     : exp,
            usuario : usuarioReal,
            baseUrl : _validarBaseUrl(datos.base_url),
        });

        debug('Sesión iniciada');
        _reflejarSesion();
        _estado('Sesión iniciada como ' + usuarioReal);

        // v1.4.1: la cuota de la sesión anterior ya no aplica. Sin
        // esto, una cuota anónima agotada seguiría bloqueando la
        // descarga aunque ahora haya sesión con más margen.
        _reiniciarCuota(usuarioReal);
        return true;
    }

    /** Mensajes de /login. Nunca incluyen usuario ni contraseña. */
    function _errorLogin(status, json) {
        if (status === 401) return 'Usuario o contraseña incorrectos.';
        if (status === 403) {
            return 'OpenSubtitles rechazó la API key. Comprueba la clave ' +
                   'en "API key de OpenSubtitles".';
        }
        if (status === 429) {
            return 'Demasiados intentos de inicio de sesión. Espera un ' +
                   'minuto antes de reintentar.';
        }
        if (status >= 500) {
            return 'OpenSubtitles tiene problemas ahora mismo (' + status +
                   '). Reintenta en un momento.';
        }
        // Cualquier otro status: mensaje genérico. No se refleja el
        // texto del servidor porque podría traer datos de la cuenta.
        return 'No se pudo iniciar sesión (' + status + ').';
    }

    // ============================================================
    // 5. RED
    // ============================================================

    function _cancelada(gen) {
        return gen !== undefined && gen !== _s.gen;
    }

    function _errAbortado() {
        return _err('abortado', { abortado: true });
    }

    function _dormir(ms, gen) {
        return new Promise(function (resolve, reject) {
            setTimeout(function () {
                if (_cancelada(gen)) reject(_errAbortado());
                else resolve();
            }, Math.max(0, ms | 0));
        });
    }

    /**
     * Garantiza un hueco mínimo entre peticiones HTTP reales. Evita
     * ráfagas (paginación, reintentos, doble clic) que acaban en 429.
     */
    async function _respetarRitmo(gen) {
        var hueco = _s.ultimaPeticion + CFG.INTERVALO_MIN_PETICION_MS - Date.now();
        if (hueco > 0) await _dormir(hueco, gen);
        _s.ultimaPeticion = Date.now();
    }

    /**
     * Ejecuta fn(signal) con su propio AbortController y un timeout
     * que cubre TODA la operación (incluida la lectura del cuerpo).
     *  · cancelación del usuario  → Error{abortado:true}
     *  · timeout                  → Error{timeout:true, message: msgTimeout}
     */
    async function _conControl(gen, timeoutMs, msgTimeout, fn) {
        if (_cancelada(gen)) throw _errAbortado();

        var controller = new AbortController();
        var vencido = false;
        var timer = setTimeout(function () {
            vencido = true;
            controller.abort();
        }, timeoutMs);

        _s.controllers.push(controller);

        try {
            return await fn(controller.signal);
        } catch (e) {
            if (_cancelada(gen)) throw _errAbortado();
            if (vencido) throw _err(msgTimeout, { timeout: true });
            throw e;
        } finally {
            clearTimeout(timer);
            var i = _s.controllers.indexOf(controller);
            if (i !== -1) _s.controllers.splice(i, 1);
        }
    }

    function _esperaReintento(retryAfter, intento) {
        var seg = parseInt(retryAfter, 10);
        var ms = (isFinite(seg) && seg > 0)
            ? seg * 1000
            : CFG.BACKOFF_BASE_MS * Math.pow(2, intento);
        // Jitter: si dos pestañas reintentan a la vez, que no choquen.
        ms += Math.floor(Math.random() * CFG.BACKOFF_JITTER_MS);
        return Math.min(ms, CFG.MAX_ESPERA_RETRY_MS);
    }

    /**
     * fetch JSON con timeout, X-User-Agent, limitador de ritmo y
     * reintentos. Reintenta SOLO peticiones GET (el POST /download
     * consume cuota).
     *
     * @param {string} url
     * @param {{method?:string, body?:Object, timeout?:number, gen?:number,
     *          auth?:boolean}} opciones
     * @returns {Promise<{ok:boolean,status:number,json:Object,text:string}>}
     */
    async function _fetchJSON(url, opciones) {
        opciones = opciones || {};

        var gen      = opciones.gen;
        var metodo   = String(opciones.method || 'GET').toUpperCase();
        var maxInt   = (metodo === 'GET') ? CFG.MAX_REINTENTOS + 1 : 1;
        var timeout  = opciones.timeout || CFG.TIMEOUT_BUSQUEDA_MS;
        var ultimoError = null;

        // El token SOLO puede ir a un host de OpenSubtitles. Esta
        // comprobación es la red de seguridad: aunque alguien pase
        // auth:true con una URL rara, el Bearer no sale del dominio.
        var enviarToken = false;
        if (opciones.auth) {
            try {
                var host = new URL(url, CFG.BASE_URL).hostname.toLowerCase();
                enviarToken = (host === 'opensubtitles.com') ||
                              (host.slice(-18) === '.opensubtitles.com');
                if (!enviarToken) {
                    warn('Se ignoró auth:true fuera del dominio de OpenSubtitles');
                }
            } catch (_) { enviarToken = false; }
        }

        var peticion = async function (signal) {
            var headers = {
                'Accept'      : 'application/json',
                // Kong bloquea User-Agent no-navegador y fetch no deja
                // sobreescribirlo; la API acepta X-User-Agent.
                'X-User-Agent': CFG.USER_AGENT,
            };
            var clave = _apiKey();
            if (clave) headers['Api-Key'] = clave;
            if (opciones.body) headers['Content-Type'] = 'application/json';

            // Sesión de usuario (opcional). La búsqueda NO la manda:
            // /subtitles solo requiere Api-Key (security en el OpenAPI).
            if (enviarToken) {
                var s = _leerSesion();
                if (s) headers['Authorization'] = 'Bearer ' + s.token;
            }

            var resp = await fetch(url, {
                method  : metodo,
                headers : headers,
                body    : opciones.body ? JSON.stringify(opciones.body) : undefined,
                signal  : signal,
            });

            var texto = await resp.text();
            var json = null;
            try { json = texto ? JSON.parse(texto) : null; } catch (_) {}

            var ra = null;
            try { ra = resp.headers.get('Retry-After'); } catch (_) {}

            return { ok: resp.ok, status: resp.status, json: json,
                     text: texto, retryAfter: ra };
        };

        for (var intento = 0; intento < maxInt; intento++) {
            var esUltimo = (intento === maxInt - 1);
            var espera = 0;

            try {
                await _respetarRitmo(gen);

                var r = await _conControl(
                    gen, timeout,
                    'OpenSubtitles tardó demasiado en responder. Reintenta.',
                    peticion
                );

                var transitorio = (r.status === 429 || r.status >= 500);
                if (!r.ok && transitorio && !esUltimo) {
                    espera = _esperaReintento(r.retryAfter, intento);
                    debug('HTTP ' + r.status + ', reintento en ' + espera + ' ms');
                } else {
                    return r;
                }

            } catch (e) {
                if (e && e.abortado) throw e;
                ultimoError = e;
                if (esUltimo) break;
                espera = _esperaReintento(null, intento);
            }

            await _dormir(espera, gen);
        }

        if (ultimoError && ultimoError.timeout) throw ultimoError;
        warn('Fallo de red:', ultimoError);
        throw new Error(_errorAmigable(0));
    }

    /**
     * Traduce errores de la API a mensajes en español.
     */
    function _errorAmigable(status, json) {
        var msg = (json && (json.message || json.error)) || '';
        if (typeof msg !== 'string') msg = '';

        if (status === 403) {
            if (/cannot consume/i.test(msg) || !msg) {
                if (!_apiKey()) {
                    return 'Falta la API key. Abre "API key de OpenSubtitles" ' +
                           'en esta ventana y pega la tuya.';
                }
                return 'OpenSubtitles rechazó tu API key (403). Comprueba que ' +
                       'la copiaste entera y sin espacios. Si acabas de ' +
                       'crear el consumer, puede tardar unos minutos en ' +
                       'activarse.';
            }
            if (/user-agent/i.test(msg)) {
                return 'OpenSubtitles rechazó el User-Agent. Debe tener forma ' +
                       '"NombreApp v1.0".';
            }
            return 'OpenSubtitles rechazó la petición: ' + msg;
        }
        if (status === 401) {
            return 'Credenciales no válidas (401). Revisa la API key.';
        }
        if (status === 406) {
            return 'Se alcanzó el límite de descargas de OpenSubtitles. ' +
                   'Prueba más tarde o descarga el subtítulo manualmente.';
        }
        if (status === 407 || /proxy|ip.*auth/i.test(msg)) {
            return 'Se requiere autenticar la cuenta para este uso de la API.';
        }
        if (status === 429) {
            return 'Demasiadas peticiones a OpenSubtitles. Espera un momento y reintenta.';
        }
        if (status === 404) {
            return 'El recurso no existe en OpenSubtitles (404).';
        }
        if (status === 410) {
            return 'El enlace de descarga caducó (410). Vuelve a buscar y reintenta.';
        }
        if (status === 422) {
            return 'OpenSubtitles no entendió la búsqueda (422). Prueba con otro título.';
        }
        if (status >= 500) {
            return 'OpenSubtitles está teniendo problemas ahora mismo (' + status + '). Reintenta en un momento.';
        }
        if (status === 0) {
            return _sinConexion()
                ? 'Estás sin conexión a internet. Conéctate y reintenta.'
                : 'Sin conexión con OpenSubtitles. Revisa tu red y reintenta.';
        }
        return msg || 'Error inesperado (' + status + ')';
    }

    // ============================================================
    // 6. NORMALIZACIÓN DEL NOMBRE DEL VIDEO → CONSULTA
    // ============================================================

    // (^|[^A-Za-z0-9]) en lugar de \b: los separadores de release
    // ("_", ".", "-") son caracteres de palabra para \b.
    var _SEP = '(^|[^A-Za-z0-9])';

    var _CALIDAD = new RegExp(
        _SEP + '(2160p|1080p|1080i|720p|576p|540p|480p|360p|240p|4k|uhd' +
        '|hdr10plus|hdr10\\+?|hdr|sdr|dv|dolby[\\s._-]?vision|atmos)(?![A-Za-z0-9])',
        'gi'
    );
    var _CODEC = new RegExp(
        _SEP + '(x264|x265|h\\.?26[45]|hevc|avc|av1|vp9|mpeg-?2|divx|xvid' +
        '|10\\s?bit|8\\s?bit)(?![A-Za-z0-9])',
        'gi'
    );
    var _AUDIO = new RegExp(
        _SEP + '(aac(?:2\\.0|5\\.1)?|ac3|eac3|dts[\\s._-]?hd|dts|truehd|flac|mp3' +
        '|ddp?\\+?5\\.1|ddp?\\+?2\\.0|5\\.1|7\\.1|2\\.0)(?![A-Za-z0-9])',
        'gi'
    );
    // Palabras demasiado comunes en títulos reales ("copy", "limited",
    // "internal") se dejaron fuera a propósito.
    var _TAGS = new RegExp(
        _SEP + '(repack|proper|extended|unrated|uncut|remastered|multi' +
        '|dual[\\s._-]?audio|sub(?:s|bed)?|dubbed|retail|dvdrip|bdrip|webrip' +
        '|web[\\s._-]?dl|web\\s?rip|bluray|blu[\\s._-]?ray|hdrip|hdtv' +
        '|dvdscr|camrip|telecine|hdts|korsub|eztv|ettv|yts|yify|rarbg|psa' +
        '|tigole|amzn|atvp|dsnp|hmax|ntv|amg|acb|bfi|criterion|remux' +
        '|sample|spanish|latino|espanol|castellano)(?![A-Za-z0-9])',
        'gi'
    );

    // Marcadores de episodio (cada uno con (^|sep) como grupo 1)
    var _SRC_SXE = _SEP + 'S(\\d{1,3})[\\s._-]*E(\\d{1,3})(?:[\\s._-]*E\\d{1,3})*(?![0-9])';
    var _SRC_NXM = _SEP + '(\\d{1,2})x(\\d{2,3})(?![A-Za-z0-9])';
    var _SRC_EP  = _SEP + '(?:E|(?:Ep|Episode|Episodio|Cap|Capitulo)[\\s._-]?)(\\d{1,3})(?![A-Za-z0-9])';

    var _EXT_VIDEO = /\.(mp4|m4v|mkv|avi|mov|wmv|flv|webm|mpe?g|ts|m2ts|mts|3gp|ogv|divx|vob|rmvb)$/i;

    function _re(src, flags) {
        return new RegExp(src, flags || '');
    }

    /** ¿El texto contiene alguna de estas expresiones? (sin estado 'g') */
    function _contiene(texto, regexps) {
        return regexps.some(function (re) {
            return new RegExp(re.source, 'i').test(texto);
        });
    }

    /** Sustituye conservando el separador capturado (evita pegar palabras). */
    function _quitar(base, re) {
        return base.replace(re, '$1 ');
    }

    /**
     * Busca el año de estreno. Solo cuenta si:
     *   · tiene texto delante (así "2012" o "1917" como título se respetan)
     *   · es plausible (1900 … año actual + 1; descarta "Blade Runner 2049")
     * Si hay varios, toma el último ("2012.2009.1080p" → año 2009).
     */
    function _extraerAnio(base) {
        var re = new RegExp('(^|[^0-9])((?:19|20)\\d{2})(?![0-9])', 'g');
        var tope = new Date().getFullYear() + 1;
        var m, elegido = null;

        while ((m = re.exec(base)) !== null) {
            var anio = parseInt(m[2], 10);
            if (anio > tope) continue;
            var inicio = m.index + m[1].length;
            var antes = base.slice(0, inicio).replace(/[^A-Za-z0-9]+/g, '');
            if (antes.length > 0) {
                elegido = { anio: anio, inicio: inicio, fin: inicio + 4 };
            }
        }

        if (!elegido) return { base: base, anio: null };

        // Quitar también los paréntesis/corchetes que lo rodean
        var izq = base.slice(0, elegido.inicio).replace(/[\[(]\s*$/, '');
        var der = base.slice(elegido.fin).replace(/^\s*[\])]/, '');
        return { base: izq + ' ' + der, anio: elegido.anio };
    }

    /**
     * Limpia el nombre del archivo para la búsqueda: quita extensión,
     * calidad, códecs, audio y tags de release, y extrae
     * temporada / episodio / año.
     *
     * @param {string} nombre
     * @returns {{consulta:string, temporada:number|null,
     *            episodio:number|null, anio:number|null}}
     */
    function _prepararConsulta(nombre) {
        var base = String(nombre || '').replace(_EXT_VIDEO, '');

        // ---- Temporada / episodio (antes de limpiar nada) ----
        var temporada = null;
        var episodio  = null;
        var m;

        if ((m = base.match(_re(_SRC_SXE, 'i')))) {
            temporada = parseInt(m[2], 10);
            episodio  = parseInt(m[3], 10);
            base = base.replace(_re(_SRC_SXE, 'gi'), '$1 ');
        } else if ((m = base.match(_re(_SRC_NXM, 'i')))) {
            temporada = parseInt(m[2], 10);
            episodio  = parseInt(m[3], 10);
            base = base.replace(_re(_SRC_NXM, 'gi'), '$1 ');
        } else if ((m = base.match(_re(_SRC_EP, 'i')))) {
            episodio = parseInt(m[2], 10);
            base = base.replace(_re(_SRC_EP, 'gi'), '$1 ');
        }

        // ---- Año ----
        var r = _extraerAnio(base);
        base = r.base;
        var anio = r.anio;

        // ---- Corchetes, llaves y hashtags de release ----
        base = base.replace(/\[[^\]]*\]/g, ' ');
        base = base.replace(/\{[^}]*\}/g, ' ');
        base = base.replace(/#[^\s#]*/g, ' ');

        // ---- Grupo de release final: "...x264-GROUP" ----
        // Solo si el nombre tiene pinta de release (calidad/códec/tag).
        // Sin esa comprobación, "Spider-Man" se quedaba en "Spider".
        if (_contiene(base, [_CALIDAD, _CODEC, _AUDIO, _TAGS])) {
            base = base.replace(/-([A-Za-z0-9]{2,})\s*$/, ' ');
        }

        // ---- Calidad, códecs, audio y tags ----
        base = _quitar(base, _CALIDAD);
        base = _quitar(base, _CODEC);
        base = _quitar(base, _AUDIO);
        base = _quitar(base, _TAGS);

        // ---- Separadores y restos ----
        base = base.replace(/[()[\]{}]/g, ' ');
        base = base.replace(/[._]+/g, ' ');
        base = base.replace(/-+/g, ' ');
        base = base.replace(/\s+/g, ' ').trim();

        return {
            consulta  : base,
            temporada : temporada,
            episodio  : episodio,
            anio      : anio,
        };
    }

    /** Tokens alfanuméricos sin acentos, para comparar nombres. */
    function _tokens(texto) {
        var t = String(texto || '').toLowerCase();
        try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
        return t.split(/[^a-z0-9]+/).filter(function (x) { return x.length > 1; });
    }

    /** Qué fracción de los tokens del video aparece en el release (0..1). */
    function _similitud(release, tokensVideo) {
        if (!tokensVideo || !tokensVideo.length) return 0;
        var set = {};
        _tokens(release).forEach(function (t) { set[t] = true; });
        var aciertos = 0;
        tokensVideo.forEach(function (t) { if (set[t]) aciertos++; });
        return aciertos / tokensVideo.length;
    }

    // ============================================================
    // 7. HASH OPENSUBTITLES (moviehash)
    // ============================================================

    /**
     * Hash clásico de OpenSubtitles: tamaño del archivo + suma de los
     * primeros y últimos 64 KB leídos como uint64 little-endian, todo
     * módulo 2^64, en hexadecimal de 16 dígitos.
     *
     * Devuelve null si no se puede calcular (archivo pequeño, sin
     * BigInt, sin Blob real). Nunca lanza: el hash es un extra.
     *
     * @param {Blob} blob
     * @returns {Promise<string|null>}
     */
    async function _hashOpenSubtitles(blob) {
        try {
            if (typeof BigInt === 'undefined') return null;
            if (!blob || typeof blob.slice !== 'function') return null;
            if (typeof blob.size !== 'number') return null;
            if (blob.size < CFG.HASH_CHUNK * 2) return null;

            var MASCARA = (BigInt(1) << BigInt(64)) - BigInt(1);
            var hash = BigInt(blob.size);

            async function sumarTrozo(desde) {
                var trozo = blob.slice(desde, desde + CFG.HASH_CHUNK);
                var buf = await trozo.arrayBuffer();
                var dv = new DataView(buf);
                var palabras = Math.floor(buf.byteLength / 8);
                for (var i = 0; i < palabras; i++) {
                    hash = (hash + dv.getBigUint64(i * 8, true)) & MASCARA;
                }
            }

            await sumarTrozo(0);
            await sumarTrozo(blob.size - CFG.HASH_CHUNK);

            var hex = hash.toString(16);
            while (hex.length < 16) hex = '0' + hex;
            return hex;

        } catch (e) {
            debug('No se pudo calcular el moviehash:', e);
            return null;
        }
    }

    /**
     * Hash del video actual con caché y timeout: si el disco (o un
     * File caducado de otra sesión) tarda, se busca sin hash.
     * @returns {Promise<string|null>}
     */
    async function _hashDelVideo(vObj) {
        if (!vObj) return null;

        var blob = vObj.file || vObj.archivo || vObj.blob || null;
        if (!blob || typeof blob.size !== 'number') return null;

        var clave = (_claveVideo(vObj) || '¿?') + '|' + blob.size;
        if (clave in _s.hashCache) return _s.hashCache[clave];

        var porTiempo = true;
        var conTope = new Promise(function (resolve) {
            var listo = false;
            var timer = setTimeout(function () {
                if (!listo) { listo = true; porTiempo = false; resolve(null); }
            }, CFG.HASH_TIMEOUT_MS);

            _hashOpenSubtitles(blob).then(function (h) {
                if (!listo) { listo = true; porTiempo = false; clearTimeout(timer); resolve(h); }
            }, function () {
                if (!listo) { listo = true; porTiempo = false; clearTimeout(timer); resolve(null); }
            });
        });

        var hash = await conTope;

        // Un null por TIMEOUT no es un resultado: no se cachea, así la
        // próxima búsqueda lo reintenta (un disco lento no es un fallo
        // permanente). Un null real (sin BigInt, archivo pequeño…) sí se
        // cachea para no repetir el cálculo inútil.
        if (hash || !porTiempo) {
            _s.hashCache[clave] = hash;
        } else {
            debug('moviehash: cálculo por timeout, no se cachea');
        }

        if (hash) debug('moviehash: ' + hash);
        return hash;
    }

    // ============================================================
    // 8. BÚSQUEDA
    // ============================================================

    // Códigos de https://api.opensubtitles.com/api/v1/infos/languages
    // Comprobados contra la respuesta real de la API (v1.2.1):
    // 'sp' NO existe (es de la API v2) y se eliminó.
    var _IDIOMAS = [
        { code: 'es',     label: 'Español' },
        { code: 'en',     label: 'Inglés' },
        { code: 'fr',     label: 'Francés' },
        { code: 'de',     label: 'Alemán' },
        { code: 'it',     label: 'Italiano' },
        { code: 'pt-br',  label: 'Portugués (BR)' },
        { code: 'pt-pt',  label: 'Portugués (PT)' },
        { code: 'ru',     label: 'Ruso' },
        { code: 'ja',     label: 'Japonés' },
        { code: 'ko',     label: 'Coreano' },
        { code: 'zh-cn',  label: 'Chino (simplificado)' },
        { code: 'zh-tw',  label: 'Chino (tradicional)' },
        { code: 'ar',     label: 'Árabe' },
        { code: 'nl',     label: 'Neerlandés' },
        { code: 'pl',     label: 'Polaco' },
        { code: 'tr',     label: 'Turco' },
        { code: 'ca',     label: 'Catalán' },
        { code: 'el',     label: 'Griego' },
        { code: 'he',     label: 'Hebreo' },
        { code: 'hi',     label: 'Hindi' },
        { code: 'id',     label: 'Indonesio' },
        { code: 'th',     label: 'Tailandés' },
        { code: 'sv',     label: 'Sueco' },
        { code: 'da',     label: 'Danés' },
        { code: 'fi',     label: 'Finés' },
        { code: 'no',     label: 'Noruego' },
        { code: 'cs',     label: 'Checo' },
        { code: 'ro',     label: 'Rumano' },
        { code: 'hu',     label: 'Húngaro' },
        { code: 'uk',     label: 'Ucraniano' },
        { code: 'vi',     label: 'Vietnamita' },
    ];

    function _nombreIdioma(code) {
        var c = String(code || '').toLowerCase();
        var encontrado = _IDIOMAS.filter(function (i) {
            return i.code === c;
        })[0];
        return encontrado ? encontrado.label : code;
    }

    /**
     * ¿El idioma del resultado coincide con el pedido?
     * `pedido` puede traer varios códigos separados por coma.
     * Acepta variante regional: pedido 'pt' ↔ resultado 'pt-br'.
     */
    function _coincideIdioma(idiomaResultado, idiomaPedido) {
        if (!idiomaPedido) return true;
        var pedido = String(idiomaPedido)
            .split(',')
            .map(function (c) { return c.trim().toLowerCase(); })
            .filter(Boolean);
        if (!pedido.length) return true;
        var got = String(idiomaResultado || '').trim().toLowerCase();
        return pedido.some(function (p) {
            return got === p || got.indexOf(p + '-') === 0;
        });
    }

    function _normalizarResultado(item, tokensVideo) {
        if (!item || !item.attributes) return null;

        var a = item.attributes;
        var archivo = (a.files && a.files[0]) || null;
        if (!archivo || !archivo.file_id) return null;

        var release = a.release || archivo.file_name || 'Sin nombre';

        return {
            id             : String(item.id),
            fileId         : String(archivo.file_id),
            release        : String(release),
            idioma         : a.language || '',
            idiomaNombre   : _nombreIdioma(a.language || ''),
            descargas      : Number(a.download_count || 0) || 0,
            puntuacion     : Number(a.ratings != null ? a.ratings : a.rating) || 0,
            hearingImpaired: !!a.hearing_impaired,
            subidoPor      : (a.uploader && a.uploader.name) || '',
            similitud      : _similitud(release, tokensVideo),
            // v1.4.0: la API agrupa por "feature" y da el TÍTULO
            // CANÓNICO que ella indexa. Es mucho más fiable que el
            // release para decidir si un resultado es la película
            // buscada: con "sexy por accidente" llegan resultados
            // cuyo release dice "Socios por accidente 2" pero cuyo
            // feature se titula "Partners By Accident 2".
            tituloFeature  : String((a.feature_details && a.feature_details.title) || ''),
            anioFeature    : Number(a.feature_details && a.feature_details.year) || 0,
            // v1.2.0: señales extra de la API
            hashMatch      : !!a.moviehash_match,
            verificado     : !!a.from_trusted,
            traduccionIA   : !!a.ai_translated,
            traduccionAuto : !!a.machine_translated,
            soloPartes     : !!a.foreign_parts_only,
            fps            : Number(a.fps) || 0,
        };
    }

    /** Penalización por traducción no humana (para el orden). */
    function _penalizacionTraduccion(r) {
        if (r.traduccionAuto) return 2;
        if (r.traduccionIA)   return 1;
        return 0;
    }

    /**
     * Orden: coincidencia por hash primero, luego traducción humana,
     * luego parecido con el nombre del video (por tramos, para que no
     * domine el ruido), luego puntuación y luego descargas.
     *
     * v1.4.0: antes de todo eso, los resultados cuyo TÍTULO CANÓNICO
     * (feature_details.title) encaja con lo que se buscó. Sin esto,
     * una búsqueda por título traducido devolvía 50 subtítulos de
     * películas distintas arriba y el correcto enterrado.
     */
    function _ordenarPorRelevancia(a, b) {
        if (a.hashMatch !== b.hashMatch) return a.hashMatch ? -1 : 1;

        // Coincidencia de título canónico: la señal más fuerte después
        // del hash. `tituloCoincide` lo calcula _resultadosParecen.
        if (!!a.tituloCoincide !== !!b.tituloCoincide) {
            return a.tituloCoincide ? -1 : 1;
        }

        var pa = _penalizacionTraduccion(a);
        var pb = _penalizacionTraduccion(b);
        if (pa !== pb) return pa - pb;

        var sa = Math.round(a.similitud * 5);
        var sb = Math.round(b.similitud * 5);
        if (sb !== sa) return sb - sa;
        if (b.puntuacion !== a.puntuacion) return b.puntuacion - a.puntuacion;
        return b.descargas - a.descargas;
    }

    /** Construye la query-string de /subtitles para una página dada. */
    function _paramsBusqueda(consulta, idioma, meta, pagina) {
        // La API pide parámetros en minúscula y ordenados alfabéticamente
        // (si no, responde con redirecciones/menos caché).
        var pares = [
            ['languages', idioma],
        ];
        // Sin texto no se manda `query` vacío (petición solo por hash).
        if (consulta) pares.push(['query', String(consulta).toLowerCase()]);
        if (meta.temporada) pares.push(['season_number', String(meta.temporada)]);
        if (meta.episodio)  pares.push(['episode_number', String(meta.episodio)]);
        // El año solo para películas: en series filtraría mal.
        if (meta.anio && !meta.temporada && !meta.episodio) {
            pares.push(['year', String(meta.anio)]);
        }
        if (meta.hash) pares.push(['moviehash', String(meta.hash).toLowerCase()]);

        // Búsqueda por id canónico (v1.4.0): es la vía que funciona
        // cuando el título local no está en el índice inglés.
        // Para series se usa parent_tmdb_id + temporada/episodio.
        if (meta.tmdbId) {
            if (meta.temporada || meta.episodio) {
                pares.push(['parent_tmdb_id', String(meta.tmdbId)]);
            } else {
                pares.push(['tmdb_id', String(meta.tmdbId)]);
            }
        }

        if (pagina && pagina > 1) pares.push(['page', String(pagina)]);

        pares.sort(function (x, y) { return x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : 0); });

        var params = new URLSearchParams();
        pares.forEach(function (p) { params.set(p[0], p[1]); });
        return params.toString();
    }

    /**
     * Consulta /subtitles con paginación: sigue pidiendo páginas hasta
     * MAX_PAGINAS o hasta reunir material de sobra para MAX_RESULTADOS.
     */
    async function _consultarAPI(consulta, idioma, meta, gen) {
        var crudos = [];
        var totalPaginas = 1;

        for (var pagina = 1; pagina <= totalPaginas; pagina++) {
            if (_cancelada(gen)) throw _errAbortado();

            var resp = await _fetchJSON(
                CFG.BASE_URL + '/subtitles?' + _paramsBusqueda(consulta, idioma, meta, pagina),
                { timeout: CFG.TIMEOUT_BUSQUEDA_MS, gen: gen }
            );

            if (!resp.ok) {
                // Si la primera página falla es un error real; si falla una
                // página posterior, nos quedamos con lo ya acumulado.
                if (pagina === 1) {
                    throw new Error(_errorAmigable(resp.status, resp.json));
                }
                warn('Página ' + pagina + ' falló (' + resp.status + '); se usa lo acumulado');
                break;
            }

            var datos = (resp.json && Array.isArray(resp.json.data)) ? resp.json.data : [];
            crudos = crudos.concat(datos);

            if (pagina === 1) {
                var tp = Number(resp.json && resp.json.total_pages) || 1;
                totalPaginas = Math.min(tp, CFG.MAX_PAGINAS);
            }

            // Con el doble del máximo ya hay de sobra tras filtrar.
            if (crudos.length >= CFG.MAX_RESULTADOS * 2) break;
            if (!datos.length) break;   // página vacía: no insistir
        }

        var vistos = {};
        var tokens = _s.tokensVideo;

        return crudos
            .map(function (it) { return _normalizarResultado(it, tokens); })
            .filter(Boolean)
            // Red de seguridad: solo el idioma pedido
            .filter(function (r) { return _coincideIdioma(r.idioma, idioma); })
            // Sin duplicados por archivo
            .filter(function (r) {
                if (vistos[r.fileId]) return false;
                vistos[r.fileId] = true;
                return true;
            })
            .sort(_ordenarPorRelevancia)
            .slice(0, CFG.MAX_RESULTADOS);
    }

    /**
     * Busca con caché en memoria. Estrategia:
     *  1. búsqueda normal (texto + hash si lo hay);
     *  2. si el texto falla, se reintenta sin el año;
     *  3. si con hash no aparece NINGÚN resultado que coincida por hash, se
     *     hace una petición SOLO por moviehash. Con `query` + `moviehash`
     *     juntos, un nombre mal escrito puede excluir justo la coincidencia
     *     exacta. Los resultados se unen sin duplicar por fileId.
     */
    async function _buscar(consulta, idioma, meta, gen) {
        if (!_apiKey()) {
            throw new Error(
                'Falta la API key. Abre "API key de OpenSubtitles" en esta ' +
                'ventana y pega la tuya.'
            );
        }

        meta = meta || {};
        var clave = [consulta.toLowerCase(), idioma, meta.temporada || '',
                     meta.episodio || '', meta.anio || '', meta.hash || '',
                     meta.tmdbId || ''].join('|');

        var c = _s.cacheBusqueda[clave];
        if (c && (Date.now() - c.ts) < CFG.CACHE_BUSQUEDA_MS) {
            // La copia lleva el original resuelto (propiedad no
            // enumerable: no aparece al recorrer con forEach ni al
            // serializar, así que el contrato de "array de resultados"
            // no cambia).
            var copia = c.datos.slice();
            _conOriginal(copia, c.original);
            return copia;
        }

        var resultados = await _consultarAPI(consulta, idioma, meta, gen);

        if (!resultados.length && meta.anio) {
            resultados = await _consultarAPI(consulta, idioma, {
                temporada: meta.temporada,
                episodio : meta.episodio,
                anio     : null,
                hash     : meta.hash,
            }, gen);
        }

        // El hash es la señal más fuerte: si no hay ninguno que coincida,
        // se pregunta solo por moviehash (sin query, sin año).
        var hayHashMatch = resultados.some(function (r) { return r.hashMatch; });
        if (meta.hash && !hayHashMatch && !_cancelada(gen)) {
            debug('Sin coincidencia por hash: se consulta solo por moviehash');
            try {
                var soloHash = await _consultarAPI('', idioma, {
                    temporada: null,
                    episodio : null,
                    anio     : null,
                    hash     : meta.hash,
                }, gen);
                resultados = _fusionarPorFileId(resultados, soloHash);
                hayHashMatch = resultados.some(function (r) { return r.hashMatch; });
            } catch (e) {
                if (_cancelada(gen)) throw e;
                warn('La búsqueda por moviehash falló; se usan los resultados previos:', e);
            }
        }

        // ---- v1.4.0: títulos localizados ----------------------------
        // No basta con "0 resultados": con un título traducido la API
        // devuelve cientos de resultados que NO son la película
        // ("Sexy por accidente" → 1849, todos de otras películas). El
        // disparador correcto es: ninguno se parece a lo pedido.
        //
        // v1.4.1: `original` es LOCAL a esta búsqueda. Antes vivía en
        // `_s.ultimoOriginal`, un global que se contaminaba entre
        // búsquedas (una búsqueda distinta heredaba el título anterior y
        // el aviso "encontrado como «X»" mentía) y además se perdía al
        // leer de la caché.
        var original = null;
        var resueltoOK = false;

        if (!hayHashMatch && !_cancelada(gen) &&
            !_resultadosParecen(consulta, resultados)) {

            debug('Los resultados no encajan con "' + consulta + '": se busca por tmdb_id');

            var esSerie = !!(meta.temporada || meta.episodio);
            var resuelto = await _resolverId(consulta, meta.anio, esSerie, gen);

            if (resuelto && resuelto.tmdbId) {
                original = resuelto.original || null;
                resueltoOK = true;

                try {
                    var porId = await _consultarAPI('', idioma, {
                        temporada  : meta.temporada,
                        episodio   : meta.episodio,
                        anio       : null,
                        hash       : null,
                        tmdbId     : resuelto.tmdbId,
                    }, gen);
                    if (porId.length) {
                        resultados = _fusionarPorFileId(resultados, porId);
                    }
                } catch (e) {
                    if (_cancelada(gen)) throw e;
                    warn('La búsqueda por tmdb_id falló:', e);
                }
            }
        }

        // Marcar y ordenar al final: los resultados cuya película
        // coincide con lo pedido suben al principio. Es lo que hace
        // utilizable la lista cuando el título está traducido, porque
        // si no el ruido (que tiene más descargas) se cuela arriba.
        if (resultados.length && !_cancelada(gen)) {
            _marcarTituloCoincide(resultados, original || consulta);
            resultados.sort(_ordenarPorRelevancia);
        }

        if (resultados.length && !_cancelada(gen)) {
            if (Object.keys(_s.cacheBusqueda).length >= CFG.CACHE_BUSQUEDA_MAX) {
                _s.cacheBusqueda = {};
            }
            _s.cacheBusqueda[clave] = {
                ts: Date.now(),
                datos: resultados.slice(),
                original: original,
                resuelto: resueltoOK,
            };
            _conOriginal(resultados, original);
        }

        return resultados;
    }

    /**
     * Palabras que no distinguen una película de otra. Sin filtrarlas,
     * "Jefa por Accidente" puntúa 0.67 contra "sexy por accidente"
     * solo por compartir "por" y "accidente".
     */
    var _VACIAS = {};
    ('de la el los las un una unos unas y o u en a al del por con sin que lo ' +
     'the of and a an in on at to for from is it its as by with').split(' ')
        .forEach(function (p) { _VACIAS[p] = true; });

    /** Tokens significativos (sin palabras vacías ni de 1 letra). */
    function _tokensUtiles(texto) {
        return _tokens(texto).filter(function (t) { return !_VACIAS[t]; });
    }

    /**
     * ¿Algún resultado se parece de verdad a lo que se pidió?
     *
     * La búsqueda por texto de OpenSubtitles es difusa: parte por
     * palabras y hace un OR, así que "sexy por accidente" devuelve
     * 1849 resultados de películas que solo comparten palabras sueltas
     * ("Socios por accidente 2", "The Accidental Husband"…). Por eso
     * no basta con mirar si la lista está vacía.
     *
     * Se compara contra dos cosas, en este orden:
     *   1. `tituloFeature`: el título canónico que la propia API
     *      indexa. Si eso encaja, es la película.
     *   2. el release, por si la API no manda feature_details.
     *
     * El umbral es alto (0.75) y se ignoran las palabras vacías: para
     * estar seguro de que es la película correcta hace falta que
     * coincidan casi todos los términos, no solo uno.
     *
     * @param {string} consulta
     * @param {Array}  resultados
     * @returns {boolean}
     */
    function _resultadosParecen(consulta, resultados) {
        if (!resultados.length) return false;

        var objetivo = _tokensUtiles(consulta);
        // v1.4.1: sin términos CON SIGNIFICADO no se puede juzgar nada.
        // Antes devolvía `true`, y eso rompía con títulos cortos o de
        // una palabra: "It", "Up", "Her" están en la lista de vacías, y
        // buscando "It" se daba por buena CUALQUIER lista de resultados
        // (incluidas 50 películas distintas), sin intentar el id canónico.
        if (!objetivo.length) {
            // Sin criterio: solo damos por buena la lista si algún
            // resultado coincide con la consulta completa.
            var completa = _tokens(consulta);
            if (!completa.length) return true;      // ni texto: no hay juicio
            var setC = {};
            resultados.forEach(function (r) {
                _tokens(r.tituloFeature || r.release).forEach(function (t) {
                    setC[t] = true;
                });
            });
            var n = 0;
            completa.forEach(function (t) { if (setC[t]) n++; });
            return (n / completa.length) >= CFG.MIN_SIMILITUD_FALLIDA;
        }

        function coincide(texto) {
            if (!texto) return false;
            var set = {};
            _tokensUtiles(texto).forEach(function (t) { set[t] = true; });
            var aciertos = 0;
            objetivo.forEach(function (t) { if (set[t]) aciertos++; });
            return (aciertos / objetivo.length) >= CFG.MIN_SIMILITUD_FALLIDA;
        }

        return resultados.some(function (r) {
            // 1) El título canónico de la API: la señal más fiable.
            if (r.tituloFeature) {
                // Si el canónico NO encaja, el resultado es de otra
                // película aunque el release se parezca.
                return coincide(r.tituloFeature);
            }
            // 2) Sin feature_details: se cae al release.
            return coincide(r.release);
        });
    }

    /**
     * Marca qué resultados son realmente la película buscada, según su
     * título canónico. Se usa para subir los correctos al principio de
     * la lista: con un título traducido la API devuelve muchos
     * resultados de otras películas que, por descargas y puntuación,
     * acabarían arriba.
     *
     * @param {Array} resultados
     * @param {string} consulta
     */
    function _marcarTituloCoincide(resultados, consulta) {
        var objetivo = _tokensUtiles(consulta);
        if (!objetivo.length) return;

        resultados.forEach(function (r) {
            var texto = r.tituloFeature || r.release;
            if (!texto) return;
            var set = {};
            _tokensUtiles(texto).forEach(function (t) { set[t] = true; });
            var aciertos = 0;
            objetivo.forEach(function (t) { if (set[t]) aciertos++; });
            r.tituloCoincide = (aciertos / objetivo.length) >= CFG.MIN_SIMILITUD_FALLIDA;
        });
    }

    /**
     * Adjunta el título original resuelto al array de resultados como
     * propiedad NO enumerable. Así:
     *   · el contrato de `buscarManual` no cambia (sigue siendo un
     *     array plano que se puede recorrer y filtrar igual);
     *   · `JSON.stringify(resultados)` no lo vuelca por error;
     *   · no aparece en un `for...of` ni en `.map`.
     */
    function _conOriginal(resultados, original) {
        if (!resultados || !original) return resultados;
        try {
            Object.defineProperty(resultados, 'original', {
                value: original, enumerable: false, writable: true,
                configurable: true,
            });
        } catch (_) { /* si defineProperty falla, se sigue igual */ }
        return resultados;
    }

    /** Une dos listas de resultados sin repetir fileId, reordenando. */
    function _fusionarPorFileId(a, b) {
        var vistos = {};
        var todos = (a || []).concat(b || []).filter(function (r) {
            if (!r || vistos[r.fileId]) return false;
            vistos[r.fileId] = true;
            return true;
        });
        return todos.sort(_ordenarPorRelevancia).slice(0, CFG.MAX_RESULTADOS);
    }

    // ============================================================
    // 8b. TÍTULOS LOCALIZADOS (v1.4.0)
    // ============================================================

    /**
     * El índice de OpenSubtitles está indexado por el TÍTULO ORIGINAL en
     * inglés. Buscar "Sexy por accidente" devuelve 1849 resultados que
     * no tienen nada que ver (Hero, Split, Wicked…), porque la API hace
     * una búsqueda difusa OR por palabras. Por eso el paso extra:
     * traducir el título a su id canónico y buscar por `tmdb_id`.
     */

    function _tmdbKey() {
        return _limpiarClave(_lsGet(CFG.LS_TMDB_KEY, ''));
    }

    // ---- Caché de resolución en localStorage ----

    function _leerCacheTMDB() {
        var raw = _leerJSON(CFG.LS_TMDB_CACHE_KEY);
        return (raw && typeof raw === 'object') ? raw : {};
    }

    function _cacheTMDB(clave, valor) {
        var cache = _leerCacheTMDB();
        cache[clave] = valor;

        var claves = Object.keys(cache);
        if (claves.length > CFG.LS_TMDB_CACHE_MAX) {
            claves.sort(function (a, b) {
                return (Number(cache[a] && cache[a].ts) || 0) -
                       (Number(cache[b] && cache[b].ts) || 0);
            });
            claves.slice(0, claves.length - CFG.LS_TMDB_CACHE_MAX)
                  .forEach(function (k) { delete cache[k]; });
        }
        _lsSet(CFG.LS_TMDB_CACHE_KEY, JSON.stringify(cache));
    }

    /**
     * Busca en TMDB para quedarse con el título ORIGINAL (lo que
     * OpenSubtitles indexa) y su tmdb_id.
     *
     * IMPORTANTE: usa `fetch` directo y NO `_fetchJSON`, porque
     * `_fetchJSON` añadiría la Api-Key y el token de OpenSubtitles.
     * Un token de OpenSubtitles no sale nunca hacia TMDB.
     *
     * @returns {Promise<{tmdbId:number, original:string, titulo:string}|null>}
     *          null si no hay key, no hay resultados o algo falla.
     */
    async function _resolverTMDB(consulta, anio, esSerie, gen) {
        var key = _tmdbKey();
        if (!key) return null;            // sin key: el paso se omite
        var q = String(consulta || '').trim();
        if (!q) return null;

        var ck = q.toLowerCase() + '|' + (anio || '') + '|' + (esSerie ? 'tv' : 'mv');
        var cacheado = _leerCacheTMDB()[ck];
        if (cacheado && cacheado.tmdbId) return cacheado;

        var url = CFG.TMDB_URL + '/' + (esSerie ? 'search/tv' : 'search/movie') +
                  '?api_key=' + encodeURIComponent(key) +
                  '&language=' + encodeURIComponent('es-MX') +
                  '&query=' + encodeURIComponent(q);
        // El año solo tiene sentido en películas.
        if (anio && !esSerie) url += '&year=' + encodeURIComponent(anio);

        try {
            var r = await _conControl(gen, CFG.TMDB_TIMEOUT_MS,
                'TMDB tardó demasiado.', async function (signal) {
                    var resp = await fetch(url, {
                        headers: { 'Accept': 'application/json' },
                        signal : signal,
                    });
                    var texto = await resp.text();
                    var json = null;
                    try { json = texto ? JSON.parse(texto) : null; } catch (_) {}
                    return { ok: resp.ok, json: json };
                });

            if (!r.ok || !r.json || !Array.isArray(r.json.results)) return null;

            // v1.4.1: cogerse results[0] a ciegas elegía remakes y
            // sequels ("Halloween 1978" vs "Halloween 2007"). Con año
            // se prefiere el whose release_date coincide.
            var lista = r.json.results;
            if (!lista.length) return null;

            var peli = lista[0];
            var conAno = Number(anio) || 0;
            if (conAno) {
                // `anioStr` se declara ANTES de las ramas: con `var`
                // dentro del primer `if` quedaba `undefined` en la
                // rama de series y el filtro de año nunca aplicaba.
                var anioStr = String(conAno);
                var campo = esSerie ? 'first_air_date' : 'release_date';
                var delAno = lista.filter(function (x) {
                    return String(x[campo] || '').indexOf(anioStr) === 0;
                });
                if (delAno.length) peli = delAno[0];
            }

            var original = String(peli.original_title || peli.original_name || '').trim();
            var titulo   = String(peli.title || peli.name || '').trim();
            if (!original && !titulo) return null;

            var salida = { tmdbId: peli.id, original: original, titulo: titulo };
            // `ts` es lo que usa la poda para descartar las más viejas:
            // sin él, todas valen 0 y se podrían borrar al azar.
            _cacheTMDB(ck, { tmdbId: salida.tmdbId, original: original,
                             titulo: titulo, ts: Date.now() });
            return salida;

        } catch (e) {
            // Un fallo de TMDB NUNCA rompe la búsqueda.
            if (_cancelada(gen)) throw e;
            debug('TMDB no resolvió la consulta:', e);
            return null;
        }
    }

    /**
     * Paso intermedio que usa la PROPIA base de OpenSubtitles:
     * /features?query=… devuelve las "features" (películas) que conoce
     * con su tmdb_id. Se verificó que NO entiende títulos localizados
     * ("sexy por accidente" → 0 resultados; "i feel pretty" → 4), pero
     * cuando el usuario escribe el título en inglés funciona y es más
     * rápido y sin claves de terceros.
     *
     * @returns {Promise<{tmdbId:number, original:string}|null>}
     */
    async function _resolverFeature(consulta, gen, esSerie, anio) {
        var q = String(consulta || '').trim();
        if (q.length < 3) return null;    // la API pide minLength 3

        try {
            var resp = await _fetchJSON(
                CFG.BASE_URL + '/features?query=' + encodeURIComponent(q.toLowerCase()),
                { timeout: CFG.TIMEOUT_BUSQUEDA_MS, gen: gen }
            );
            if (!resp.ok || !resp.json || !Array.isArray(resp.json.data)) return null;

            // v1.4.1: se filtra por tipo. /features devuelve películas Y
            // series mezcladas, así que buscar "the office" podía dar
            // una película homónima con tmdb_id, y buscar luego por ese
            // id llevaba a la película equivocada.
            var wanted = esSerie ? 'tv' : 'movie';
            var candidatos = resp.json.data
                .map(function (it) { return it.attributes || {}; })
                .filter(function (a) {
                    if (!a.tmdb_id) return false;
                    if (!a.feature_type) return true;   // la API no siempre lo manda
                    var t = String(a.feature_type).toLowerCase();
                    return t.indexOf(wanted) === 0;     // 'movie' | 'tv show'
                });

            if (!candidatos.length) return null;

            // Con año, se prefiere la feature de ese año (remakes:
            // "Halloween" existe en 1978 y en 2007).
            var conAno = Number(anio) || 0;
            if (conAno) {
                var delAno = candidatos.filter(function (a) {
                    return Number(a.year) === conAno;
                });
                if (delAno.length) candidatos = delAno;
            }

            var elegido = candidatos[0];
            return { tmdbId: elegido.tmdb_id, original: String(elegido.title || '') };
        } catch (e) {
            if (_cancelada(gen)) throw e;
            debug('/features no resolvió:', e);
            return null;
        }
    }

    /**
     * Traduce un título localizado a un id de TMDB: primero con
     * /features de OpenSubtitles y, si no sabe, con TMDB.
     */
    async function _resolverId(consulta, anio, esSerie, gen) {
        var f = await _resolverFeature(consulta, gen, esSerie, anio);
        if (f && f.tmdbId) return f;
        if (_cancelada(gen)) return null;
        return await _resolverTMDB(consulta, anio, esSerie, gen);
    }

    // ============================================================
    // 9. DESCARGA
    // ============================================================

    // ---- Cuota diaria (persistente, por fecha UTC) ----

    function _hoy() {
        return new Date().toISOString().slice(0, 10);
    }

    function _leerCuota() {
        var base = { dia: _hoy(), n: 0, restantes: null, hasta: null, quien: 'anon' };
        var q = _leerJSON(CFG.LS_CUOTA_KEY);
        if (!q || q.dia !== _hoy()) return base;

        base.n = Number(q.n) || 0;
        // `restantes` solo es válido si es un número >= 0. La API usa
        // -1 para decir "no lo sé", y un valor corrupto no debe pasar.
        if (typeof q.restantes === 'number' && isFinite(q.restantes) &&
            q.restantes >= 0) {
            base.restantes = q.restantes;
        }
        if (typeof q.hasta === 'number' && isFinite(q.hasta)) {
            base.hasta = q.hasta;
        }
        base.quien = q.quien || 'anon';
        return base;
    }

    /**
     * Dueño del registro de cuota: 'anon' o el usuario con sesión.
     * Sirve para que el bloqueo por cuota agotada de una cuenta no se
     * aplique a otra (y viceversa): la cuota anónimo es 5/día y la de
     * un usuario va de 20 a 1000 según su rango.
     */
    function _quienActual() {
        var s = _leerSesion();
        return (s && s.usuario) ? String(s.usuario) : 'anon';
    }

    /**
     * ¿El registro de cuota guardado sigue siendo válido para quien está
     * conectado ahora? Si el registro es de otra cuenta (o anon y ahora
     * hay sesión, o al revés), no se aplica: se empieza a contar de cero.
     */
    function _cuotaEsMia() {
        var q = _leerCuota();
        return q.quien === _quienActual();
    }

    /** Borra el registro de cuota (login/logout: cambia el margen). */
    function _reiniciarCuota(quien) {
        _lsSet(CFG.LS_CUOTA_KEY, JSON.stringify({
            dia: _hoy(), n: 0, restantes: null, hasta: null,
            quien: quien || _quienActual(),
        }));
    }

    function _anotarDescarga(restantes) {
        // Si el registro es de otra cuenta, se empieza de cero en vez de
        // sumarle descargas ajenas.
        var q = _leerCuota();
        q.quien = _quienActual();
        q.n++;
        // La API usa `remaining: -1` para decir "no lo sé" (cuota de
        // usuario autenticado, p. ej.). Guardar ese -1 haría que
        // _cuotaAgotada() creyera que quedan 0... no: -1 !== 0, pero
        // ensuciaría el dato. Solo se guarda un >= 0 real.
        if (typeof restantes === 'number' && isFinite(restantes) &&
            restantes >= 0) {
            q.restantes = restantes;
        }
        _lsSet(CFG.LS_CUOTA_KEY, JSON.stringify(q));
        return q;
    }

    /**
     * ¿Sabemos ya que no quedan descargas? Solo bloquea cuando la PROPIA API
     * informó cuota agotada (remaining 0 / exceeded). El 406 trae
     * `reset_time_utc`: si viene, se respeta ese instante en lugar de
     * asumir el reinicio a medianoche UTC.
     */
    function _cuotaAgotada() {
        // El bloqueo solo vale si el registro pertenece a quien está
        // conectado ahora: una cuota agotada en anonymous no puede
        // impedir descargar con la sesión iniciada (y al revés).
        if (!_cuotaEsMia()) return false;

        var q = _leerCuota();
        if (q.restantes !== 0) return false;
        if (q.hasta && Date.now() < q.hasta) return true;
        // Sin fecha fiable: la cuota se renueva a medianoche UTC.
        return !q.hasta;
    }

    /**
     * Pide el enlace de descarga y descarga el archivo.
     * @param {string} fileId
     * @param {string} subFormat
     * @param {number} gen
     * @param {string} [idioma]  Código de idioma del subtítulo (para decodificar)
     * @returns {Promise<{texto:string, nombre:string}>}
     */
    async function _descargar(fileId, subFormat, gen, idioma) {
        if (_cuotaAgotada()) {
            var q = _leerCuota();
            var cuando = q.hasta
                ? new Date(q.hasta).toUTCString()
                : 'a medianoche UTC';
            throw _err(
                'OpenSubtitles no tiene más descargas disponibles hasta ' +
                cuando + '. También puedes descargar el subtítulo manualmente.',
                { limite: true }
            );
        }

        var idNum = Number(fileId);

        // El Bearer se manda SI HAY sesión, pero no es obligatorio: se
        // comprobó contra la API real que /download responde 200 sin
        // token (quota anónima de 5/día por IP). La sesión solo sube
        // ese límite (20–1000 según rango de usuario). Por eso la
        // ausencia de sesión NO bloquea la descarga ni gasta la
        // petición: sería una pérdida para el usuario.
        var resp = await _fetchJSON(_baseUrl() + '/download', {
            method : 'POST',
            body   : { file_id: isFinite(idNum) ? idNum : fileId,
                       sub_format: subFormat || 'srt' },
            timeout: CFG.TIMEOUT_DESCARGA_MS,
            gen    : gen,
            auth   : true,
        });

        if (!resp.ok) {
            var detalle = (resp.json && (resp.json.message || resp.json.error)) || '';
            detalle = String(detalle);

            // SOLO el 406 con "quota" es cuota agotada. Un 429 es ritmo
            // ("Throttle limit reached") y NO debe bloquear el día entero.
            // Un 406 por "Invalid file_id" tampoco es cuota.
            // Un 406 SIN cuerpo no se puede clasificar por el mensaje:
            // se trata como cuota, que es lo que devuelve el gateway
            // cuando corta por límite.
            var esCuota = (resp.status === 406) &&
                          ((!resp.text) ||
                           /quota|allowed|exceed|renewed|limit/i.test(detalle) ||
                           (resp.json && typeof resp.json.reset_time_utc === 'string'));
            // "Invalid file_id" nunca es cuota, tenga o no cuerpo.
            if (/invalid file_id/i.test(detalle)) esCuota = false;

            if (esCuota) {
                // Guardamos el instante real de reinicio que da la API.
                var hasta = NaN;
                if (resp.json && resp.json.reset_time_utc) {
                    var t = Date.parse(resp.json.reset_time_utc);
                    if (isFinite(t)) hasta = t;
                }
                _lsSet(CFG.LS_CUOTA_KEY, JSON.stringify({
                    dia: _hoy(), n: CFG.MAX_DESCARGAS_DIA, restantes: 0,
                    hasta: isFinite(hasta) ? hasta : null,
                    quien: _quienActual(),
                }));
            }

            // Sesión caducada o rechazada: se limpia para que la UI
            // vuelva al estado "sin sesión". Sin reintento automático.
            if (resp.status === 401 || /invalid token/i.test(detalle)) {
                if (_tieneSesion()) _borrarSesion();
                _reflejarSesion();
                throw _err(
                    'Tu sesión de OpenSubtitles caducó. Vuelve a iniciar ' +
                    'sesión y pulsa el resultado otra vez.', { requiereLogin: true }
                );
            }

            throw _err(
                esCuota
                    ? _errorAmigable(406, resp.json)
                    : _errorAmigable(resp.status, resp.json),
                { limite: esCuota }
            );
        }

        var enlace = resp.json && resp.json.link;
        if (!enlace) {
            throw new Error('OpenSubtitles no devolvió un enlace de descarga válido.');
        }

        // v1.4.1: el enlace DEBE ser https. No se restringe el dominio a
        // propósito: las descargas reales salen de dl.opensubtitles.org
        // y de otros CDN, así que filtrar por host rompería el
        // descarga. Lo que no se permite es que baje en claro.
        if (!/^https:\/\//i.test(String(enlace))) {
            throw new Error(
                'OpenSubtitles devolvió un enlace de descarga no seguro ' +
                '(no es https). Se ha cancelado por seguridad.'
            );
        }

        // La descarga ya contó contra la cuota aunque falle lo siguiente
        _anotarDescarga(resp.json && resp.json.remaining);

        return await _bajarEnlace(
            enlace, resp.json.file_name || 'subtitulo.srt', gen, idioma
        );
    }

    /**
     * Descarga desde el enlace firmado. Maneja gzip, límite de tamaño,
     * detección de respuestas HTML (portal cautivo / error del CDN) y
     * distingue claramente: red/CORS · HTTP · timeout · cancelación.
     */
    async function _bajarEnlace(url, nombre, gen, idioma) {
        return await _conControl(
            gen, CFG.TIMEOUT_DESCARGA_MS,
            'La descarga tardó demasiado y se canceló. Reintenta.',
            async function (signal) {

                var resp;
                try {
                    resp = await fetch(url, { signal: signal });
                } catch (e) {
                    if (e && e.name === 'AbortError') throw e;
                    throw new Error(
                        'No se pudo acceder al archivo de OpenSubtitles (posible ' +
                        'bloqueo de red o CORS). Puedes usar "Cargar desde mi ' +
                        'equipo" como alternativa.'
                    );
                }

                if (!resp.ok) {
                    throw new Error('No se pudo descargar el archivo (' + resp.status + ').');
                }

                // Un portal cautivo (wifi de hotel) o un error del CDN
                // pueden responder 200 con una página web.
                var ct = '';
                try { ct = resp.headers.get('Content-Type') || ''; } catch (_) {}
                if (/text\/html/i.test(ct)) {
                    throw new Error(
                        'El servidor devolvió una página web en lugar del ' +
                        'subtítulo (¿red con portal de acceso?). Reintenta.'
                    );
                }

                var declarado = Number(resp.headers.get('Content-Length')) || 0;
                if (declarado > CFG.MAX_BYTES_SUBTITULO) {
                    throw new Error('El archivo es demasiado grande para ser un subtítulo.');
                }

                var buffer = await resp.arrayBuffer();
                if (buffer.byteLength > CFG.MAX_BYTES_SUBTITULO) {
                    throw new Error('El archivo es demasiado grande para ser un subtítulo.');
                }
                if (!buffer.byteLength) {
                    throw new Error('El archivo descargado está vacío. Prueba con otro resultado.');
                }

                var bytes = new Uint8Array(buffer);

                // gzip (magic number 1f 8b)
                if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
                    bytes = await _descomprimirGzip(bytes);
                    if (bytes.length > CFG.MAX_BYTES_DESCOMPRIMIDO) {
                        throw new Error('El archivo descomprimido es demasiado grande.');
                    }
                }

                var texto = _decodificar(bytes, idioma);

                // Mismo caso que arriba pero sin Content-Type delator
                if (/^\s*<(!doctype|html|head|body)\b/i.test(texto)) {
                    throw new Error(
                        'El servidor devolvió una página web en lugar del ' +
                        'subtítulo. Reintenta o prueba con otro resultado.'
                    );
                }

                return {
                    texto  : texto,
                    nombre : String(nombre).replace(/\.gz$/i, ''),
                };
            }
        );
    }

    async function _descomprimirGzip(bytes) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error(
                'Este navegador no puede descomprimir el archivo. ' +
                'Actualiza el navegador o descarga el subtítulo manualmente.'
            );
        }
        try {
            var ds = new DecompressionStream('gzip');
            var stream = new Blob([bytes]).stream().pipeThrough(ds);
            var buffer = await new Response(stream).arrayBuffer();
            return new Uint8Array(buffer);
        } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            throw new Error('El archivo comprimido está dañado. Prueba con otro resultado.');
        }
    }

    /**
     * Charset de reserva por idioma. OpenSubtitles sirve casi siempre UTF-8,
     * pero si el archivo NO es UTF-8 válido, caer siempre a windows-1252
     * produce texto roto en alfabeto no latino (cirílico, hebreo, árabe,
     * CJK…). Estos son los charsets habituales de cada familia.
     */
    var _CHARSET_IDIOMA = {
        'ru'    : 'windows-1251',
        'uk'    : 'windows-1251',
        'be'    : 'windows-1251',
        'bg'    : 'windows-1251',
        'mk'    : 'windows-1251',
        'sr'    : 'windows-1251',
        'el'    : 'windows-1253',
        'he'    : 'windows-1255',
        'ar'    : 'windows-1256',
        'fa'    : 'windows-1256',
        'ur'    : 'windows-1256',
        'pl'    : 'windows-1250',
        'cs'    : 'windows-1250',
        'hu'    : 'windows-1250',
        'ro'    : 'windows-1250',
        'sk'    : 'windows-1250',
        'sl'    : 'windows-1250',
        'hr'    : 'windows-1250',
        'tr'    : 'windows-1254',
        'ja'    : 'shift_jis',
        'ko'    : 'euc-kr',
        'zh-cn' : 'gbk',
        'zh-tw' : 'big5',
    };

    function _charsetDeIdioma(idioma) {
        var c = String(idioma || '').trim().toLowerCase();
        if (!c) return 'windows-1252';
        if (_CHARSET_IDIOMA[c]) return _CHARSET_IDIOMA[c];
        // 'pt' / 'es' con variante regional ('pt-br' ya está en la tabla)
        var base = c.split('-')[0];
        return _CHARSET_IDIOMA[base] || 'windows-1252';
    }

    /**
     * Bytes → texto respetando la codificación:
     * UTF-16 (por BOM) → UTF-8 (por BOM) → UTF-8 estricto → charset del
     * idioma (windows-1252 por defecto).
     *
     * @param {Uint8Array} bytes
     * @param {string} [idioma]  Código de idioma del subtítulo (opcional)
     */
    function _decodificar(bytes, idioma) {
        if (bytes.length >= 2) {
            try {
                if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
                    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
                }
                if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
                    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
                }
            } catch (_) {}
        }

        // BOM UTF-8 (EF BB BF): decodificar sin él
        if (bytes.length >= 3 &&
            bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
            try {
                return new TextDecoder('utf-8').decode(bytes.subarray(3));
            } catch (_) {}
        }

        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (_) {
            // No era UTF-8 válido → charset del idioma
        }

        var charset = _charsetDeIdioma(idioma);
        try {
            var texto = new TextDecoder(charset).decode(bytes);
            debug('Subtítulo decodificado como ' + charset);
            return texto;
        } catch (_) {}

        // El navegador no conoce ese charset: se intenta el de facto.
        try {
            return new TextDecoder('windows-1252').decode(bytes);
        } catch (_) {}

        return new TextDecoder('utf-8').decode(bytes);
    }

    // ============================================================
    // 10. REPARACIÓN, CONVERSIÓN Y VALIDACIÓN (→ VTT)
    // ============================================================

    /**
     * Repara defectos frecuentes de SRT "de la calle" ANTES de pasar
     * por el conversor:
     *   · timestamps sin ceros: "0:1:2,5"   → "00:01:02,500"
     *   · milisegundos con punto             → coma (formato SRT)
     *   · flechas rotas "->" / "- ->"        → "-->"
     *   · etiquetas ASS incrustadas {\an8}   → fuera
     *   · <font ...> (el render de cues no lo soporta bien) → fuera,
     *     conservando <i>, <b> y <u> que sí son válidos en VTT.
     */
    function _repararSrt(texto) {
        var t = String(texto == null ? '' : texto);

        t = t.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

        // Normalizar timestamps h:m:s(,|.)ms con relleno de ceros.
        t = t.replace(
            /(^|[^0-9])(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})(?=[^0-9]|$)/gm,
            function (_, pre, h, mi, se, ms) {
                return pre + _pad2(h) + ':' + _pad2(mi) + ':' + _pad2(se) +
                       ',' + (ms + '000').slice(0, 3);
            }
        );

        // Flechas defectuosas SOLO en líneas de tiempos (no tocar diálogo)
        t = t.replace(
            /^(\s*\d{2}:\d{2}:\d{2},\d{3})\s*-+\s*>\s*(\d{2}:\d{2}:\d{2},\d{3})/gm,
            '$1 --> $2'
        );

        // Restos de ASS y <font>
        t = t.replace(/\{\\[^}]*\}/g, '');
        t = t.replace(/<\/?font[^>]*>/gi, '');

        return t;
    }

    /** Conversor SRT→VTT de respaldo (si util.srtAVtt no existe). */
    function _srtAVttLocal(texto) {
        var cuerpo = String(texto)
            .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
            .replace(/\{\\[^}]*\}/g, '');          // {\an8} y similares
        return 'WEBVTT\n\n' + cuerpo.trim() + '\n';
    }

    /**
     * Validación estructural del VTT final.
     * @returns {{ok:boolean, cues:number, motivo:string}}
     */
    function _validarVtt(texto) {
        var t = String(texto == null ? '' : texto);

        if (!/^\uFEFF?\s*WEBVTT/.test(t)) {
            return { ok: false, cues: 0, motivo: 'No empieza por WEBVTT' };
        }

        // En VTT el separador decimal SOLO puede ser el punto: una coma
        // haría que el navegador ignorase el cue entero.
        var re = /(?:\d{1,2}:)?\d{1,2}:\d{2}\.\d{1,3}[ \t]*-->[ \t]*(?:\d{1,2}:)?\d{1,2}:\d{2}\.\d{1,3}/g;
        var cues = 0;
        while (re.exec(t) !== null) {
            cues++;
            if (cues > CFG.MAX_CUES) {
                return { ok: false, cues: cues, motivo: 'Demasiados cues (archivo corrupto)' };
            }
        }

        if (!cues) {
            return { ok: false, cues: 0, motivo: 'No contiene ningún cue con tiempos' };
        }

        return { ok: true, cues: cues, motivo: '' };
    }

    /**
     * Convierte el texto descargado a VTT usando los conversores del
     * reproductor. Detecta el formato por contenido y, si no, por extensión.
     */
    function _aVtt(texto, nombreArchivo) {
        texto = String(texto == null ? '' : texto)
            .replace(/^\uFEFF/, '')
            .replace(/\r\n?/g, '\n');

        var ext = '';
        try {
            ext = util.obtenerExtension ? util.obtenerExtension(nombreArchivo || '') : '';
        } catch (_) {}
        ext = String(ext || '').replace(/^\./, '').toLowerCase();
        if (!ext) {
            var mExt = /\.([a-z0-9]{2,4})$/i.exec(String(nombreArchivo || ''));
            ext = mExt ? mExt[1].toLowerCase() : '';
        }

        var esVtt = /^\s*WEBVTT/i.test(texto);
        var esAss = /^\s*\[Script Info\]/im.test(texto) || ext === 'ass' || ext === 'ssa';

        if (esVtt || (ext === 'vtt' && !esAss)) {
            return esVtt ? texto : 'WEBVTT\n\n' + texto;
        }
        if (esAss) {
            if (typeof util.assAVtt !== 'function') {
                throw new Error('Este reproductor no puede convertir subtítulos ASS/SSA.');
            }
            return util.assAVtt(texto);
        }

        var reparado = _repararSrt(texto);
        return (typeof util.srtAVtt === 'function')
            ? util.srtAVtt(reparado)
            : _srtAVttLocal(reparado);
    }

    // ============================================================
    // 11. PERSISTENCIA (índice localStorage)
    // ============================================================

    /**
     * El índice se guarda como { v: 2, datos: { clave → entrada } }.
     * El formato v1 era el mapa plano directamente; se migra al leer.
     * Se acepta también { v: 1, … } por si alguien guardó así.
     */
    function _leerIndice() {
        var raw = _leerJSON(CFG.LS_INDEX_KEY);
        if (!raw) return {};

        if (raw.v === CFG.LS_INDEX_VERSION &&
            raw.datos && typeof raw.datos === 'object' && !Array.isArray(raw.datos)) {
            return raw.datos;
        }

        // Formato antiguo: el mapa plano, sin envoltorio (v ausente) o
        // con v:1. En ambos casos las claves son directamente las
        // entradas, así que se migran tal cual al formato nuevo.
        var tieneDatos = (raw.datos && typeof raw.datos === 'object' &&
                          !Array.isArray(raw.datos));
        if (tieneDatos) {
            // { v: 1, datos: {...} } → se acepta el mapa de dentro.
            return raw.datos;
        }
        if (raw.v == null || raw.v === 1) {
            // Mapa plano: descartar las claves de control si las hay.
            var limpio = {};
            Object.keys(raw).forEach(function (k) {
                if (k === 'v' || k === 'version' || k === 'datos') return;
                limpio[k] = raw[k];
            });
            return limpio;
        }
        return {};                       // versión futura desconocida
    }

    /** Quita las entradas más antiguas hasta dejar como mucho `max`. */
    function _podarIndice(indice, max) {
        var claves = Object.keys(indice);
        if (claves.length <= max) return;
        claves.sort(function (a, b) {
            return ((indice[a] && indice[a].ts) || 0) -
                   ((indice[b] && indice[b].ts) || 0);
        });
        claves.slice(0, claves.length - max)
              .forEach(function (k) { delete indice[k]; });
    }

    function _guardarIndice(indice) {
        try {
            _podarIndice(indice, CFG.LS_MAX_ENTRADAS);
            var payload = JSON.stringify({ v: CFG.LS_INDEX_VERSION, datos: indice });

            if (!_lsSet(CFG.LS_INDEX_KEY, payload)) {
                // localStorage lleno: podar a la mitad y reintentar UNA vez
                _podarIndice(indice, Math.floor(CFG.LS_MAX_ENTRADAS / 2));
                _lsSet(CFG.LS_INDEX_KEY,
                       JSON.stringify({ v: CFG.LS_INDEX_VERSION, datos: indice }));
            }
        } catch (e) {
            warn('No se pudo guardar el índice de subtítulos:', e);
        }
    }

    /**
     * Clave del índice para un video.
     *
     * v1.4.1 — CORRECCIÓN IMPORTANTE: antes se prefería `vObj.id`, pero
     * ese id NO es estable. En `vp-carga.js` los videos se construyen
     * con `util.generarId()`, que es timestamp + contador + random
     * (`mfk3x-1-0-a7c2`). Al recargar la página se vuelve a generar
     * TODOS los ids, así que la clave cambiaba y el índice guardaba una
     * entrada nueva por cada descarga, acumulando basura y perdiendo el
     * aviso "Ya tienes ...".
     *
     * La clave estable es `nombre + tamaño`: sobrevive a las recargas
     * y distingue dos archivos homónimos de carpetas distintas (el
     * nombre solo no bastaba). `lastModified` se añade cuando existe
     * para no confundir dos versiones del mismo nombre y tamaño.
     *
     * El `id` se conserva como último recurso para videos sin nombre
     * (sintéticos o casos raros).
     */
    function _claveVideo(vObj) {
        if (!vObj) return null;

        var nombre = String(vObj.name || '');
        if (nombre) {
            var size = (vObj.file && typeof vObj.file.size === 'number')
                     ? vObj.file.size
                     : (typeof vObj.size === 'number' ? vObj.size : null);
            var mod = (typeof vObj.lastModified === 'number' && vObj.lastModified)
                    ? vObj.lastModified
                    : ((vObj.file && typeof vObj.file.lastModified === 'number' &&
                        vObj.file.lastModified) ? vObj.file.lastModified : null);

            if (size != null && mod != null) return nombre + '|' + size + '|' + mod;
            if (size != null) return nombre + '|' + size;
            return nombre;
        }

        // Sin nombre solo queda el id: inestable, pero mejor que nada.
        if (vObj.id != null && vObj.id !== '') return String(vObj.id);
        return null;
    }

    /**
     * Claves con las que se guardaba el índice antes de v1.4.1, en orden
     * de preferencia al leer. Se prueban todas y se migra a la primera
     * que exista:
     *   · v1.2.0 y anteriores: `name` (o `id` si no había nombre)
     *   · v1.2.1–v1.4.0:      `id`, o `name|size`
     */
    function _clavesViejas(vObj) {
        var claves = [];
        if (!vObj) return claves;

        var id = (vObj.id != null && vObj.id !== '') ? String(vObj.id) : null;
        var nombre = String(vObj.name || '');
        var size = (vObj.file && typeof vObj.file.size === 'number')
                 ? vObj.file.size
                 : (typeof vObj.size === 'number' ? vObj.size : null);

        if (id) claves.push(id);                                   // v1.2.1–v1.4.0
        if (nombre && size != null) claves.push(nombre + '|' + size);   // v1.2.1–v1.4.0
        if (nombre) claves.push(nombre);                           // v1.2.0 y anterior
        if (id && !nombre) claves.push(id);

        return claves.filter(function (c, i) {
            return claves.indexOf(c) === i;    // sin repetir
        });
    }

    function _obtenerGuardado(vObj) {
        var clave = _claveVideo(vObj);
        if (!clave) return null;
        var indice = _leerIndice();
        var g = indice[clave];

        // Migración: la entrada existe con una clave antigua.
        if (!g) {
            var viejas = _clavesViejas(vObj).filter(function (c) { return c !== clave; });
            for (var i = 0; i < viejas.length && !g; i++) {
                if (indice[viejas[i]]) g = indice[viejas[i]];
            }
            if (g) {
                // Se reinscribe ya con la clave estable. Las viejas se
                // borran: si no, la entrada seguiría duplicada con la
                // clave anterior y volvería a migrarse en cada sesión.
                indice[clave] = g;
                viejas.forEach(function (c) { delete indice[c]; });
                _guardarIndice(indice);
                info('Índice de subtítulos migrado a la clave estable');
            }
        }

        return (g && typeof g === 'object') ? g : null;
    }

    function _registrarGuardado(vObj, datos) {
        var clave = _claveVideo(vObj);
        if (!clave) return;
        var indice = _leerIndice();
        indice[clave] = {
            release    : datos.release,
            idioma     : datos.idioma,
            fileId     : datos.fileId,
            subFormat  : datos.subFormat,
            nombre     : datos.nombre,
            ts         : Date.now(),
        };
        _guardarIndice(indice);
    }

    function _borrarGuardado(vObj) {
        var clave = _claveVideo(vObj);
        if (!clave) return;
        var indice = _leerIndice();
        delete indice[clave];
        // También las claves antiguas, para no dejar restos que la
        // migración volvería a reclamar.
        _clavesViejas(vObj).forEach(function (c) { delete indice[c]; });
        _guardarIndice(indice);
    }

    // ============================================================
    // 12b. GUARDAR EN LA CARPETA DEL VIDEO (v1.4.1)
    // ============================================================

    /**
     * Escribe el subtítulo junto al video, con el nombre del video y
     * extensión .vtt, para que el reproductor (u otro) lo encuentre
     * como subtítulo hermano.
     *
     * Requiere la File System Access API: sin un handle del directorio
     * el navegador NO puede escribir en disco y no hay forma de saltarse
     * esa restricción. Si no está disponible, se recurre a
     * `showSaveFilePicker`, que deja elegir dónde guardarlo.
     *
     * @returns {Promise<boolean>} true si se escribió en disco.
     */
    async function _guardarEnDisco(vObj, textoVtt, nombreSugerido) {
        if (typeof window.showSaveFilePicker !== 'function' &&
            typeof window.showDirectoryPicker !== 'function') {
            return false;
        }

        var dir = await _directorioDelVideo(vObj);
        var nombre = _nombreParaDisco(vObj, nombreSugerido);

        try {
            // 1) Carpeta conocida: escritura directa, sin preguntar.
            if (dir && typeof dir.getFileHandle === 'function') {
                if (await _permisoDisco(dir, 'readwrite')) {
                    var handle = await dir.getFileHandle(nombre, { create: true });
                    var writable = await handle.createWritable();
                    await writable.write(textoVtt);
                    await writable.close();
                    debug('Subtítulo guardado en la carpeta del video');
                    return true;
                }
                // Sin permiso de escritura: se pide la carpeta.
                var elegido = await window.showDirectoryPicker({
                    id: 'vp-subtitulos', mode: 'readwrite', startIn: dir,
                });
                var h2 = await elegido.getFileHandle(nombre, { create: true });
                var w2 = await h2.createWritable();
                await w2.write(textoVtt);
                await w2.close();
                return true;
            }

            // 2) Sin carpeta conocida: que el usuario elija el archivo.
            if (typeof window.showSaveFilePicker === 'function') {
                var fh = await window.showSaveFilePicker({
                    suggestedName: nombre,
                    types: [{
                        description: 'Subtítulo WebVTT',
                        accept: { 'text/vtt': ['.vtt'] },
                    }],
                });
                var w = await fh.createWritable();
                await w.write(textoVtt);
                await w.close();
                return true;
            }

            return false;
        } catch (e) {
            // AbortError = el usuario canceló: no es un error.
            if (e && e.name === 'AbortError') return false;
            debug('No se pudo guardar el subtítulo en disco:', e);
            return false;
        }
    }

    /**
     * Carpeta del video actual, en este orden:
     *   1. VP.runtime.dirHandle (la carpeta que el usuario ya abrió);
     *   2. la guardada por vp-db.
     *
     * `VP.db.obtenerDirectorio()` devuelve una PROMESA, no un handle:
     * por eso esta función es async y se espera con `await`. Devolverla
     * sin resolver haría que `dir.getFileHandle` no existiera y el
     * guardado en disco fallaría siempre en silencio.
     *
     * @returns {Promise<FileSystemDirectoryHandle|null>}
     */
    async function _directorioDelVideo(vObj) {
        try {
            if (VP.runtime && VP.runtime.dirHandle) return VP.runtime.dirHandle;
        } catch (_) {}
        try {
            if (VP.db && typeof VP.db.obtenerDirectorio === 'function') {
                var d = await VP.db.obtenerDirectorio();
                if (d) {
                    VP.runtime = VP.runtime || {};
                    VP.runtime.dirHandle = d;
                    return d;
                }
            }
        } catch (_) {}
        return null;
    }

    /** Pide permiso de escritura si el handle lo requiere. */
    async function _permisoDisco(handle, modo) {
        try {
            if (typeof handle.queryPermission !== 'function') return true;
            var p = await handle.queryPermission({ mode: modo });
            if (p === 'granted') return true;
            if (typeof handle.requestPermission !== 'function') return false;
            p = await handle.requestPermission({ mode: modo });
            return p === 'granted';
        } catch (_) {
            return false;
        }
    }

    /** Nombre final en disco: el del video con .vtt. */
    function _nombreParaDisco(vObj, nombreSugerido) {
        var base = '';
        try {
            if (VP.util && typeof VP.util.obtenerNombreBase === 'function') {
                base = VP.util.obtenerNombreBase(String(vObj && vObj.name || ''));
            }
        } catch (_) {}
        if (!base && nombreSugerido) {
            base = String(nombreSugerido).replace(/\.[^.]+$/, '');
        }
        if (!base) base = 'subtitulo';
        base = base.replace(/\.vtt$/i, '');        // evitar .vtt.vtt
        base = base.replace(/[\\/:*?"<>|]/g, '_');  // inválidos en Windows
        return base + '.vtt';
    }

    /**
     * Decide si intentar guardar en disco y lo hace.
     *
     * Solo guarda si:
     *   · la opción está activa (por defecto sí, y se puede apagar);
     *   · el navegador tiene la File System Access API. En Firefox o
     *     bajo file:// no la hay y ni se molesta al usuario.
     *
     * Nunca interrumpe la descarga: si el usuario cancela el diálogo o
     * falla la escritura, el subtítulo sigue aplicado.
     */
    async function _quizasGuardarEnDisco(vObj, textoVtt, nombre) {
        if (!_guardarEnDiscoActivo()) return false;

        var soportaFsa = (typeof window.showDirectoryPicker === 'function' ||
                          typeof window.showSaveFilePicker === 'function');
        if (!soportaFsa) {
            debug('Este navegador no permite escribir en disco; se omite');
            return false;
        }

        var ok = await _guardarEnDisco(vObj, textoVtt, nombre);
        if (ok) {
            _notif('Subtítulo guardado en la carpeta del video.', 'exito');
        }
        return ok;
    }

    function _guardarEnDiscoActivo() {
        if (CFG.GUARDAR_EN_DISCO === false) return false;
        var v = _lsGet(CFG.LS_GUARDAR_DISCO_KEY, null);
        if (v == null || v === '') return true;   // por defecto, activo
        return v !== 'false';
    }

    // ============================================================
    // 12. APLICAR AL VIDEO (integración con vp-subtitulos)
    // ============================================================

    /**
     * Aplica el VTT al video actual sin recargarlo ni perder la posición,
     * reutilizando el pipeline de vp-subtitulos (cues, caché, IndexedDB,
     * <track>, window.vpSubtitleCues para Mochi).
     * Si adjuntar falla, restaura el estado previo del video.
     */
    async function _aplicar(vObj, textoVtt, nombre) {
        var subs = VP.subtitulos;
        if (!subs || typeof subs.adjuntar !== 'function') {
            throw new Error('El módulo de subtítulos no está disponible.');
        }

        var previo = {
            archivo : vObj.subtitleFile,
            nombre  : vObj.subtitleName,
            activos : VP.estado ? VP.estado.subtitulosActivos : undefined,
        };

        // vp-subtitulos.adjuntar decide el formato POR EXTENSIÓN
        // (_convertirAVtt): un nombre ".srt" con contenido VTT lo haría pasar
        // otra vez por srtAVtt y lo estropearía. El File SIEMPRE es .vtt.
        var base = (nombre || 'subtitulo').replace(/\.[^.]+$/, '');
        vObj.subtitleFile = new File([textoVtt], base + '.vtt', {
            type : 'text/vtt',
        });
        vObj.subtitleName = base || 'OpenSubtitles';

        // Invalidar la caché ANTES de adjuntar: si había un subtítulo
        // cacheado, adjuntar reutilizaría el viejo.
        if (typeof subs.invalidarCache === 'function') {
            subs.invalidarCache(vObj.id);
        }

        if (VP.estado) VP.estado.subtitulosActivos = true;

        try {
            await subs.adjuntar(vObj, true);
        } catch (e) {
            vObj.subtitleFile = previo.archivo;
            vObj.subtitleName = previo.nombre;
            if (VP.estado) VP.estado.subtitulosActivos = previo.activos;
            throw e;
        }

        // El <track> pasa a 'showing' en su listener 'load'; si aún no
        // cargó, queda 'disabled'. Forzarlo garantiza que se vea.
        _forzarPistaVisible();

        if (typeof bus.emit === 'function') {
            bus.emit('subtitulosToggle', true);
        }
        _notif('Subtítulo aplicado', 'exito');
    }

    /**
     * Pone en 'showing' la pista recién añadida. Reintenta porque
     * `track.mode` solo es asignable cuando la pista ha cargado.
     */
    function _forzarPistaVisible(intentos) {
        var video = VP.refs && VP.refs.videoPlayer;
        if (!video) return;
        if (typeof dom.esNulo === 'function' && dom.esNulo(video)) return;

        intentos = intentos || 12;

        function intentar(n) {
            var pistas = video.querySelectorAll('track[kind="subtitles"]');
            if (!pistas.length) {
                if (n > 0) setTimeout(function () { intentar(n - 1); }, 120);
                return;
            }
            var pista = pistas[pistas.length - 1];
            try {
                if (pista.track) {
                    pista.track.mode = 'showing';
                    if (pista.track.mode !== 'showing' && n > 0) {
                        setTimeout(function () { intentar(n - 1); }, 120);
                    }
                }
            } catch (e) {
                debug('No se pudo activar la pista:', e);
            }
        }

        intentar(intentos);
    }

    // ============================================================
    // 13. RENDER DE LA INTERFAZ
    // ============================================================

    function _videoActual() {
        var idx = VP.estado && VP.estado.currentVideoIndex;
        var lista = (VP.estado && VP.estado.playlist) || [];
        return (typeof idx === 'number' && idx >= 0) ? (lista[idx] || null) : null;
    }

    function _poblarIdiomas(selectEl) {
        if (!selectEl) return;
        selectEl.innerHTML = '';
        _IDIOMAS.forEach(function (idioma) {
            var opt = document.createElement('option');
            opt.value = idioma.code;
            opt.textContent = idioma.label;
            selectEl.appendChild(opt);
        });

        var pref = String(_lsGet(CFG.LS_PREF_IDIOMA, '') || CFG.IDIOMA_PREDETERMINADO);
        var existe = _IDIOMAS.some(function (i) { return i.code === pref; });
        if (!existe) {
            var extra = document.createElement('option');
            extra.value = pref;
            extra.textContent = pref.toUpperCase();
            selectEl.appendChild(extra);
        }
        selectEl.value = pref;
    }

    function _estado(msg) {
        var estadoEl = _el('osEstado');
        if (estadoEl) estadoEl.textContent = msg;
    }

    // ============================================================
    // 13b. SESIÓN EN LA INTERFAZ (v1.3.0)
    // ============================================================

    /**
     * Refleja el estado REAL de la sesión en la UI. La contraseña
     * SIEMPRE aparece vacía: no se rellena desde ninguna parte.
     */
    function _reflejarSesion() {
        var sesion = _leerSesion();

        _setVisible('osLoginBloque', !sesion);
        _setVisible('osSesionBloque', !!sesion);

        var claveEl = _el('osClave');
        if (claveEl) claveEl.value = '';

        var sesionEl = _el('osSesion');
        if (sesionEl) {
            sesionEl.textContent = sesion
                ? ('Sesión: ' + (sesion.usuario || 'usuario'))
                : '';
        }
        return sesion;
    }

    /** Pone el foco en el campo de usuario para que escriba directo. */
    function _enfocarLogin() {
        _setVisible('osLoginBloque', true);
        _setVisible('osSesionBloque', false);
        var u = _el('osUsuario');
        if (u) { try { u.focus(); u.select(); } catch (_) {} }
    }

    /** Habilita/deshabilita el botón de login durante el envío. */
    function _loginEnCurso(activo) {
        _s.loginEnCurso = !!activo;
        var b = _el('osLoginBtn');
        if (b) {
            b.disabled = !!activo;
            b.textContent = activo ? 'Entrando…' : 'Iniciar sesión';
        }
    }

    /** Flujo del botón "Iniciar sesión" (y del Enter en la contraseña). */
    async function _loginDesdeUI() {
        if (_s.loginEnCurso) return;

        var uEl = _el('osUsuario');
        var cEl = _el('osClave');
        var usuario = uEl ? uEl.value : '';
        var clave   = cEl ? cEl.value : '';

        if (!String(usuario).trim() || !clave) {
            _notif('Escribe tu usuario y tu contraseña de OpenSubtitles.', 'advertencia');
            return;
        }

        var gen = _s.gen;
        _loginEnCurso(true);
        try {
            await _login(usuario, clave, gen);
        } catch (e) {
            // _login ya gestiona sus errores; esto es solo la red de
            // seguridad para que el onclick nunca reciba una promesa
            // rechazada (que el navegador reporta como unhandled
            // rejection y deja el botón bloqueado).
            debug('El login terminó con error:', e);
        } finally {
            // La contraseña se vacía SIEMPRE, haya éxito o error: no
            // se queda en el DOM ni un segundo más de lo necesario.
            if (cEl) cEl.value = '';
            // Con _cancelarPendientes (al cerrar) ya se reactivó; si la
            // generación sigue siendo la nuestra, también aquí.
            if (!_cancelada(gen)) _loginEnCurso(false);
        }
    }

    function _logout() {
        // Solo local: la documentación no exige /logout y el token
        // caduca solo en 24 h. Llamarlo al servidor añadiría una
        // petición sin beneficio real.
        _borrarSesion();
        // Al cerrar sesión vuelve el límite anónimo: el contador de la
        // cuenta no debe seguir contando (ni bloquear) para 'anon'.
        _reiniciarCuota('anon');
        _reflejarSesion();
        _estado('Sesión cerrada');
        _notif('Sesión de OpenSubtitles cerrada.', 'info');
    }

    // ============================================================
    // 13c. SUGERENCIA DE TÍTULO ORIGINAL (v1.4.0)
    // ============================================================

    /**
     * Muestra "¿Quisiste decir «X»?" con un botón que rellena el input
     * y busca. Todo con textContent/_crear: el título viene de una
     * API de terceros y no se pinta con innerHTML.
     */
    /**
     * El array de resultados de la última búsqueda, para consultar su
     * `original` (propiedad no enumerable) desde diagnostico().
     */
    function resultadosActual() {
        return (_s.resultados && _s.resultados.length) ? _s.resultados : null;
    }

    /**
     * v1.4.1 (10e): cuando los resultados NO encajan con lo pedido y
     * además no hay forma de resolver el título original, se dice. Sin
     * esto el usuario ve 50 subtítulos de otras películas y no entiende por
     * qué.
     */
    function _avisarSinAcierto(original) {
        var caja = _el('osAvisoTmdb');
        if (!caja) return;

        // Solo avisa si NO se resolvió el título original: si se
        // resolvió, la sugerencia "¿Quisiste decir «X»?" ya explica la
        // situación y avisar además sería redundante.
        if (original) { _setVisible('osAvisoTmdb', false); return; }

        caja.textContent = 'Los resultados no parecen ser esta película. ' +
            'Escribe el título original o configura la API key de TMDB.';
        _setVisible('osAvisoTmdb', true);
    }

    function _mostrarSugerencia(original) {
        var cont = _el('osSugerenciaTitulo');
        if (!cont) return;

        cont.innerHTML = '';
        _s.sugerenciaOriginal = original || null;

        if (!original) {
            _setVisible('osSugerenciaTitulo', false);
            return;
        }

        cont.appendChild(_crear('span', null, '¿Quisiste decir «'));
        cont.appendChild(_crear('strong', null, original));
        cont.appendChild(_crear('span', null, '»?'));

        var btn = _crear('button', 'btn-secondary os-sugerencia__btn',
                         'Buscar con ese título');
        btn.type = 'button';
        // addEventListener directo, no _on: este botón se recrea en cada
        // búsqueda y el nodo viejo se descarta con sus listeners. Con
        // _on se acumulaban en _docListeners hasta que se llamara a
        // destruir(), que puede no venir nunca.
        btn.addEventListener('click', function () {
            var inputEl = _el('osConsulta');
            if (inputEl) inputEl.value = original;
            _s.textoPrefill = original;   // se trata como texto editado
            _setVisible('osSugerenciaTitulo', false);
            // El debounce frenaría la búsqueda si el usuario acababa
            // de escribir: se reinicia para que este clic actúe.
            _s.ultimaBusqueda = 0;
            _buscarAhora();
        });
        cont.appendChild(btn);

        _setVisible('osSugerenciaTitulo', true);
    }

    function _mensajeCarga(msg) {
        var el = _el('osMensajeCargando');
        if (el && msg) el.textContent = msg;
    }

    function _mostrarCargando(mostrar) {
        _setVisible('osLoading', mostrar);
    }

    /** Bloquea buscar y los resultados mientras hay una operación en curso. */
    function _bloquearUI(bloquear) {
        var btn = _el('osBuscarBtn');
        if (btn) btn.disabled = !!bloquear;

        var filas = document.querySelectorAll('#osResultados .os-resultado');
        for (var i = 0; i < filas.length; i++) filas[i].disabled = !!bloquear;
    }

    function _mostrarResultados() {
        _mostrarCargando(false);
        _setVisible('osResultados', true);
        _setVisible('osVacio', false);
        _setVisible('osError', false);
    }

    function _mostrarSinResultados() {
        _mostrarCargando(false);
        _setVisible('osResultados', false);
        _setVisible('osVacio', true);
        _setVisible('osError', false);
    }

    /**
     * @param {string}  mensaje
     * @param {boolean} mantenerResultados  true tras un fallo de descarga:
     *        el usuario conserva la lista y puede probar otro resultado.
     */
    function _mostrarError(mensaje, mantenerResultados) {
        _mostrarCargando(false);
        _setVisible('osResultados', !!mantenerResultados && _s.resultados.length > 0);
        _setVisible('osVacio', false);
        _setVisible('osError', true);

        var msgEl = _el('osErrorMsg');
        if (msgEl) msgEl.textContent = mensaje;
    }

    var _ICONO_DESCARGA =
        '<svg class="icon os-resultado__icon" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M12 4v12m0 0 4-4m-4 4-4-4M4 20h16" ' +
              'fill="none" stroke="currentColor" stroke-width="2" ' +
              'stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';

    /** Badges del resultado (todos con textContent: datos de terceros). */
    function _badges(r, contenedor) {
        if (r.hashMatch) {
            var b = _crear('span', 'os-badge os-badge--hash', 'Tu archivo');
            b.title = 'Coincide exactamente con tu archivo de video (hash)';
            contenedor.appendChild(b);
        }
        if (r.hearingImpaired) {
            contenedor.appendChild(_crear('span', 'os-badge os-badge--sdh', 'SDH'));
        }
        if (r.verificado) {
            var v = _crear('span', 'os-badge os-badge--trusted', 'Verificado');
            v.title = 'Subido por un usuario de confianza';
            contenedor.appendChild(v);
        }
        if (r.traduccionAuto) {
            var a = _crear('span', 'os-badge os-badge--mt', 'Auto');
            a.title = 'Traducción automática (puede tener errores)';
            contenedor.appendChild(a);
        } else if (r.traduccionIA) {
            var ia = _crear('span', 'os-badge os-badge--ia', 'IA');
            ia.title = 'Traducción generada por IA';
            contenedor.appendChild(ia);
        }
        if (r.soloPartes) {
            var fp = _crear('span', 'os-badge os-badge--parcial', 'Parcial');
            fp.title = 'Solo subtitula las partes en idioma extranjero';
            contenedor.appendChild(fp);
        }
    }

    /** Render con textContent: los nombres vienen de un tercero. */
    function _renderResultados(resultados) {
        var cont = _el('osResultados');
        if (!cont) return;

        cont.innerHTML = '';

        if (!resultados.length) {
            _mostrarSinResultados();
            return;
        }

        resultados.forEach(function (r) {
            // <button> ya es focusable y activable con Enter/Espacio:
            // no hace falta role/tabindex ni un keydown propio (que además
            // disparaba la acción dos veces).
            var fila = _crear('button', 'os-resultado');
            fila.type = 'button';

            var infoEl = _crear('div', 'os-resultado__info');

            var rel = _crear('div', 'os-resultado__release', r.release);
            _badges(r, rel);
            infoEl.appendChild(rel);

            var meta = _crear('div', 'os-resultado__meta');
            meta.appendChild(_crear('span', null, r.idiomaNombre || r.idioma));
            meta.appendChild(_crear('span', null, '·'));
            meta.appendChild(_crear('span', null,
                _formatearNumero(r.descargas) + ' descargas'));
            meta.appendChild(_crear('span', null, '·'));
            meta.appendChild(_crear('span', null,
                r.puntuacion > 0 ? r.puntuacion.toFixed(1) : '—'));
            if (r.fps > 0) {
                meta.appendChild(_crear('span', null, '·'));
                meta.appendChild(_crear('span', null, r.fps + ' fps'));
            }
            infoEl.appendChild(meta);

            fila.appendChild(infoEl);
            fila.insertAdjacentHTML('beforeend', _ICONO_DESCARGA);   // constante propia

            fila.addEventListener('click', function () { _elegirResultado(r); });

            cont.appendChild(fila);
        });

        _mostrarResultados();
    }

    // ============================================================
    // 14. ACCIONES
    // ============================================================

    /** Cancela todo lo pendiente e invalida las operaciones en vuelo. */
    function _cancelarPendientes() {
        _s.gen++;
        var cs = _s.controllers.slice();
        _s.controllers.length = 0;
        cs.forEach(function (c) { try { c.abort(); } catch (_) {} });
        _s.cargando = false;
        _s.descargando = false;

        // El login en vuelo se cancela con el resto. Sin esto, cerrar y
        // reabrir el modal durante un login dejaba el botón en
        // "Entrando…" y deshabilitado para siempre: el único sitio donde
        // se reactivaba era destruir() (recargar el script).
        _s.loginEnCurso = false;
        var btn = _el('osLoginBtn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Iniciar sesión';
        }
    }

    /**
     * Qué se manda a la API:
     *  · texto sin tocar (el prellenado) → usa lo extraído del archivo
     *    (temporada/episodio/año), que el input ya no contiene;
     *  · texto editado por el usuario    → se interpreta lo que escribió.
     */
    function _resolverConsulta(texto) {
        if (_s.metaPrefill && texto === _s.textoPrefill) {
            return { consulta: texto, meta: _s.metaPrefill };
        }
        var p = _prepararConsulta(texto);
        return { consulta: p.consulta || texto, meta: p };
    }

    /** Guarda la API key escrita en el input (si hay algo). */
    function _sincronizarApiKey() {
        var keyEl = _el('osApiKey');
        if (!keyEl) return;
        var v = _limpiarClave(keyEl.value);
        if (v && v !== _limpiarClave(_lsGet(CFG.LS_API_KEY, ''))) {
            VP.opensubtitles.guardarApiKey(v);
        }
    }

    /**
     * v1.4.1: la key de TMDB solo se guardaba con el evento `change`,
     * que no se dispara si el usuario pega la key y pulsa Buscar sin
     * salir del campo. Esa búsqueda se hacía entonces SIN key y fallaba
     * sin explicación. Se sincroniza aquí, junto a la de OpenSubtitles.
     */
    function _sincronizarTmdbKey() {
        var el = _el('osTmdbKey');
        if (!el) return;
        var v = _limpiarClave(el.value);
        var guardada = _limpiarClave(_lsGet(CFG.LS_TMDB_KEY, ''));
        if (v === guardada) return;

        _lsSet(CFG.LS_TMDB_KEY, v);
        el.value = v;
        // Cambió la key → la caché de resolución puede venir de otra
        // cuenta/proyecto, así que se descarta.
        _lsDel(CFG.LS_TMDB_CACHE_KEY);
    }

    async function _buscarAhora() {
        if (_s.cargando || _s.descargando) return;

        // Anti-rebote: doble clic / Enter repetido en milisegundos
        var ahora = Date.now();
        if (ahora - _s.ultimaBusqueda < CFG.DEBOUNCE_BUSQUEDA_MS) return;
        _s.ultimaBusqueda = ahora;

        var inputEl  = _el('osConsulta');
        var selectEl = _el('osIdioma');
        var vObj     = _videoActual();

        if (!vObj) {
            _mostrarError('No hay ningún video seleccionado.');
            return;
        }

        if (_sinConexion()) {
            _mostrarError('Estás sin conexión a internet. Conéctate y reintenta.');
            return;
        }

        var texto = String((inputEl && inputEl.value) || '').trim();
        if (!texto) {
            _mostrarError('Escribe un título para buscar.');
            return;
        }

        // Si pegó la key y pulsó Buscar sin salir del campo, el 'change'
        // aún no se disparó: se guarda aquí.
        _sincronizarApiKey();
        _sincronizarTmdbKey();

        var q      = _resolverConsulta(texto);
        var idioma = (selectEl && selectEl.value) || CFG.IDIOMA_PREDETERMINADO;
        var gen    = _s.gen;

        _s.cargando = true;
        _bloquearUI(true);
        _mensajeCarga('Buscando…');
        _mostrarCargando(true);
        _estado('');
        _setVisible('osSugerenciaTitulo', false);

        try {
            // El hash del archivo (si se puede calcular) mejora el orden:
            // los resultados sincronizados con TU release van primero.
            var meta = {
                temporada: q.meta.temporada,
                episodio : q.meta.episodio,
                anio     : q.meta.anio,
                hash     : await _hashDelVideo(vObj),
            };
            if (_cancelada(gen)) return;

            var resultados = await _buscar(q.consulta, idioma, meta, gen);
            if (_cancelada(gen)) return;

            _s.resultados = resultados;
            _s.consultaActual = texto;
            _s.intentos = 0;

            // El título original viene pegado al array, no de un global.
            var original = resultados.original || null;

            if (!resultados.length) {
                _estado('Sin resultados');
                _mostrarSinResultados();
                // Aunque no haya nada que mostrar, si resolvió un título
                // original distinto, se ofrece como sugerencia.
                _mostrarSugerencia(original);
                _avisarSinAcierto(original);
            } else {
                var conHash = resultados.filter(function (r) { return r.hashMatch; }).length;
                var resumen = resultados.length + ' resultado' +
                              (resultados.length === 1 ? '' : 's') +
                              (conHash ? ' · ' + conHash + ' coinciden con tu archivo' : '');
                // Los resultados llegaron por el título original: decirlo
                // evita que el usuario piense que el film buscado es otro.
                if (original && !conHash) {
                    resumen += ' · encontrado como «' + original + '»';
                }
                _estado(resumen);
                _renderResultados(resultados);
                _mostrarSugerencia(null);
                _avisarSinAcierto(original);
            }

        } catch (e) {
            // Cerrar la ventana no es un fallo: no ensuciar el log.
            if (_cancelada(gen) || (e && e.abortado)) {
                info('Búsqueda cancelada');
                return;
            }

            warn('Búsqueda falló:', e);

            _s.intentos++;
            _estado('Intento ' + _s.intentos + ' fallido · revisa la conexión o la API key');
            _s.resultados = [];
            _mostrarError(e && e.message ? e.message : 'Error al buscar.');

        } finally {
            // Solo si sigue siendo "mi" operación: si se cerró/reabrió,
            // _cancelarPendientes ya reseteó y puede haber una nueva.
            if (!_cancelada(gen)) {
                _s.cargando = false;
                _bloquearUI(false);
            }
        }
    }

    async function _elegirResultado(r) {
        if (_s.descargando || _s.cargando) return;

        var vObj = _videoActual();
        if (!vObj) {
            _mostrarError('No hay ningún video seleccionado.', true);
            return;
        }

        if (_sinConexion()) {
            _mostrarError('Estás sin conexión a internet. Conéctate y reintenta.', true);
            return;
        }

        // Aviso (sin bloquear) si nuestro contador local sugiere que la
        // cuota puede estar agotada pero la API aún no lo confirmó.
        // SOLO sin sesión: con cuenta el límite es 20–1000/día según el
        // rango, así que 5 descargas no dicen nada.
        var q = _leerCuota();
        var haySesion = _tieneSesion();
        if (!haySesion && _cuotaEsMia() &&
            q.restantes == null && q.n >= CFG.MAX_DESCARGAS_DIA) {
            _notif(
                'Llevas ' + q.n + ' descargas hoy; puede que OpenSubtitles ' +
                'rechace esta. Iniciar sesión sube el límite.', 'info'
            );
        }

        var gen = _s.gen;
        _s.descargando = true;
        _bloquearUI(true);

        _mensajeCarga('Descargando…');
        _mostrarCargando(true);
        _estado('');
        _setVisible('osError', false);
        _setVisible('osMsgDescarga', true);

        try {
            // 1. Descargar (el idioma se propaga para decodificar bien)
            var descargado = await _descargar(r.fileId, 'srt', gen, r.idioma);
            if (_cancelada(gen)) return;

            // 2. Convertir a VTT y validar estructura
            var textoVtt = _aVtt(descargado.texto, descargado.nombre);
            var v = _validarVtt(textoVtt);
            if (!v.ok) {
                debug('VTT inválido: ' + v.motivo);
                throw new Error(
                    'El archivo descargado no parece un subtítulo válido (' +
                    v.motivo.toLowerCase() + '). Prueba con otro resultado.'
                );
            }
            debug('VTT válido con ' + v.cues + ' cues');

            // 3. Si el usuario cambió de video durante la descarga, aplicarlo
            //    pondría el subtítulo en el video equivocado.
            if (_videoActual() !== vObj) {
                throw new Error(
                    'Cambiaste de video mientras se descargaba: el subtítulo ' +
                    'no se aplicó. Vuelve a abrir la búsqueda en ese video.'
                );
            }

            // 4. Aplicar al video (si falla, se restaura el estado previo)
            await _aplicar(vObj, textoVtt, descargado.nombre);

            // 4b. Guardar el .vtt junto al video, con su nombre original.
            //     Es un extra: si falla, el subtítulo ya está aplicado y
            //     no se pierde nada.
            await _quizasGuardarEnDisco(vObj, textoVtt, descargado.nombre);

            // 5. Registrar SOLO tras aplicar con éxito
            _registrarGuardado(vObj, {
                release   : r.release,
                idioma    : r.idioma,
                fileId    : r.fileId,
                subFormat : 'srt',
                nombre    : descargado.nombre,
            });

            if (!_cancelada(gen)) _cerrar();

        } catch (e) {
            if (_cancelada(gen) || (e && e.abortado)) return;

            warn('Descarga falló:', e);
            _estado('Error');
            _mostrarError(e && e.message ? e.message : 'Error al descargar.', true);

            if (e && e.requiereLogin) {
                // Sesión caducada: la lista de resultados se conserva
                // y se enfoca el login para que escriba y vuelva a pulsar.
                _enfocarLogin();
                _notif(e.message, 'advertencia');
            } else if (e && e.limite) {
                // El texto cambia según haya sesión: decir "5/día" con
                // una cuenta iniciada sería falso y confuso.
                _notif(
                    haySesion
                        ? 'Has alcanzado el límite de descargas de tu ' +
                          'cuenta de OpenSubtitles. Prueba más tarde.'
                        : 'Has alcanzado el límite de descargas de ' +
                          'OpenSubtitles (5/día sin sesión). Iniciar ' +
                          'sesión sube ese límite.',
                    'advertencia'
                );
            }
        } finally {
            if (!_cancelada(gen)) {
                _s.descargando = false;
                _setVisible('osMsgDescarga', false);
                _bloquearUI(false);
            }
        }
    }

    // ============================================================
    // 15. ABRIR / CERRAR
    // ============================================================

    function _abrir() {
        var modal = _el('osModal');
        if (!modal) {
            warn('No se encontró #osModal en el DOM');
            _notif('No se pudo abrir la búsqueda de subtítulos.', 'advertencia');
            return;
        }

        // Si ya había algo en curso (doble clic, reapertura), se invalida.
        _cancelarPendientes();

        // Solo se recuerda el foco si veníamos de FUERA: si abrir() se
        // llama con el modal ya abierto, document.activeElement es un
        // elemento del propio modal y al cerrar el foco se perdería.
        if (!_s.abierto) _s.foco = document.activeElement;

        var vObj = _videoActual();
        var inputEl = _el('osConsulta');

        // Estado inicial limpio (no arrastrar datos del video anterior)
        _s.resultados = [];
        _s.consultaActual = '';
        _s.intentos = 0;
        _s.metaPrefill = null;
        _s.textoPrefill = '';
        _s.tokensVideo = [];
        _s.ultimaBusqueda = 0;

        var listaEl = _el('osResultados');
        if (listaEl) listaEl.innerHTML = '';
        _setVisible('osGuardado', false);
        _setVisible('osArchivoInfo', false);
        _setVisible('osSugerenciaTitulo', false);
        _setVisible('osAvisoTmdb', false);
        _setVisible('osMsgDescarga', false);

        // Prellenar con el nombre del video limpiado
        if (vObj) {
            // Si la limpieza no deja nada usable, se usa el nombre SIN
            // extensión: mandarlo con ".mp4" a la API reduce las coincidencias.
            var nombre = String(vObj.name || '');
            var prep = _prepararConsulta(nombre);
            var textoInicial = prep.consulta ||
                               String(nombre).replace(_EXT_VIDEO, '').trim();

            _s.metaPrefill = prep;
            _s.textoPrefill = textoInicial;
            _s.tokensVideo = _tokens(nombre.replace(_EXT_VIDEO, ''));

            if (inputEl) inputEl.value = textoInicial;

            var metaEl = _el('osArchivoInfo');
            if (metaEl) {
                var t = 'Archivo: ' + nombre;
                if (prep.temporada && prep.episodio) {
                    t += ' · Serie: T' + prep.temporada + 'E' + prep.episodio;
                } else if (prep.anio) {
                    t += ' · Año: ' + prep.anio;
                }
                metaEl.textContent = t;
                metaEl.style.display = '';
            }
        } else if (inputEl) {
            inputEl.value = '';
        }

        _poblarIdiomas(_el('osIdioma'));

        // El botón de login nunca debe abrirse bloqueado.
        _loginEnCurso(false);

        // Mostrar la API key guardada
        var keyEl = _el('osApiKey');
        if (keyEl) keyEl.value = _limpiarClave(_lsGet(CFG.LS_API_KEY, ''));

        // Mostrar la key de TMDB guardada
        var tmdbEl = _el('osTmdbKey');
        if (tmdbEl) tmdbEl.value = _tmdbKey();

        // Reflejar la opción de guardar en disco
        var discoEl = _el('osGuardarDisco');
        if (discoEl) discoEl.checked = _guardarEnDiscoActivo();

        // Estado real de la sesión (la contraseña SIEMPRE vacía)
        var sesion = _reflejarSesion();

        // El usuario se rellena para no tener que escribirlo de más.
        var userEl = _el('osUsuario');
        if (userEl) {
            userEl.value = (sesion && sesion.usuario) ? sesion.usuario : '';
        }

        // Sugerencia y avisos de título: fuera al abrir.
        var sugEl = _el('osSugerenciaTitulo');
        if (sugEl) sugEl.innerHTML = '';
        _s.sugerenciaOriginal = null;
        _setVisible('osAvisoTmdb', false);

        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
        _s.abierto = true;

        if (typeof dom.inertMainContent === 'function') {
            dom.inertMainContent(true);
        }

        _estado(_sinConexion() ? 'Sin conexión a internet' : 'Listo para buscar');
        _setVisible('osResultados', false);
        _setVisible('osVacio', false);
        _setVisible('osError', false);
        _mostrarCargando(false);
        _bloquearUI(false);

        // ¿Ya hay uno guardado para este video?
        if (vObj) {
            var guardado = _obtenerGuardado(vObj);
            if (guardado) {
                var infoEl = _el('osGuardado');
                if (infoEl) {
                    infoEl.textContent =
                        'Ya tienes "' + (guardado.release || guardado.nombre || 'subtítulo') +
                        '"' + (guardado.idioma ? ' (' + guardado.idioma + ')' : '');
                    infoEl.style.display = '';
                }
            }
        }

        if (inputEl) {
            try { inputEl.focus(); inputEl.select(); } catch (_) {}
        }
    }

    function _cerrar() {
        var modal = _el('osModal');
        if (!modal) return;

        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        _s.abierto = false;

        if (typeof dom.inertMainContent === 'function') {
            dom.inertMainContent(false);
        }

        // Cancelar todo lo que esté en vuelo
        _cancelarPendientes();
        _setVisible('osMsgDescarga', false);
        _mostrarCargando(false);
        _bloquearUI(false);

        // Devolver el foco a donde estaba
        var foco = _s.foco;
        _s.foco = null;
        if (foco && typeof foco.focus === 'function' && document.contains(foco)) {
            try { foco.focus(); } catch (_) {}
        }
    }

    // ============================================================
    // 16. CARGA MANUAL (fallback siempre disponible)
    // ============================================================

    function _cargarManual() {
        var vObj = _videoActual();
        if (!vObj) {
            _notif('No hay ningún video seleccionado', 'advertencia');
            return;
        }

        // vp-subtitulos no expone un <input type=file> propio: su vía de
        // carga manual es el selector de directorio / carpeta.
        if (VP.subtitulos && typeof VP.subtitulos.buscarEnDirectorio === 'function') {
            _cerrar();
            VP.subtitulos.buscarEnDirectorio(vObj);
            return;
        }

        _notif(
            'Cierra esta ventana y usa el botón Subtítulos para cargar ' +
            'un archivo manualmente.',
            'info'
        );
    }

    // ============================================================
    // 17. EVENTOS
    // ============================================================

    /** Elementos enfocables dentro del modal (para la trampa de Tab). */
    function _enfocables(modal) {
        var sel = 'button:not([disabled]), input:not([disabled]), ' +
                  'select:not([disabled]), textarea:not([disabled]), ' +
                  '[href], [tabindex]:not([tabindex="-1"])';
        var lista = modal.querySelectorAll(sel);
        var visibles = [];
        for (var i = 0; i < lista.length; i++) {
            var el = lista[i];
            if (el.offsetParent !== null || el === document.activeElement) {
                visibles.push(el);
            }
        }
        return visibles;
    }

    /**
     * v1.4.1: registra la ventana en el gestor de ventanas flotantes
     * (vp-flotante-ia.js), que ya aporta arrastre con ratón y táctil,
     * imán en los bordes y persistencia de la posición.
     *
     * `VPFloating.register` es idempotente (ignora ids ya registrados),
     * así que se puede llamar en cada _bindEventos sin miedo. Si el
     * módulo no está disponible (carga parcial), la ventana sigue
     * funcionando: simplemente no será arrastrable.
     */
    function _registrarFlotante() {
        try {
            if (window.VPFloating && typeof window.VPFloating.register === 'function') {
                window.VPFloating.register('osModal', 'opensubtitles');
            }
        } catch (e) {
            debug('No se pudo registrar la ventana flotante:', e);
        }
    }

    function _bindEventos() {
        _limpiarListeners();
        _registrarFlotante();

        _on(_el('osCerrar'), 'click', _cerrar);
        _on(_el('osBuscarBtn'), 'click', _buscarAhora);
        _on(_el('osReintentar'), 'click', _buscarAhora);
        _on(_el('osManualBtn'), 'click', _cargarManual);
        _on(_el('osManualBtnVacio'), 'click', _cargarManual);
        _on(_el('osManualBtnError'), 'click', _cargarManual);

        // Enter en el campo de búsqueda
        _on(_el('osConsulta'), 'keydown', function (e) {
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();
                _buscarAhora();
            }
        });

        // API key: se guarda al salir del campo o con Enter
        var keyEl = _el('osApiKey');
        var guardarClave = function () {
            var valor = _limpiarClave(keyEl.value);
            keyEl.value = valor;                     // muestra la versión limpia
            VP.opensubtitles.guardarApiKey(valor);
            _estado(valor
                ? 'API key guardada'
                : 'Sin API key: la búsqueda fallará');
        };
        _on(keyEl, 'change', guardarClave);
        _on(keyEl, 'keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                guardarClave();
                var c = _el('osConsulta');
                if (c) c.focus();
            }
        });

        // Preferencia de idioma
        var selectEl = _el('osIdioma');
        _on(selectEl, 'change', function () {
            _lsSet(CFG.LS_PREF_IDIOMA, selectEl.value);
        });

        // ---- Sesión (v1.3.0) ----
        _on(_el('osLoginBtn'), 'click', _loginDesdeUI);
        _on(_el('osLogoutBtn'), 'click', _logout);

        // Enter en la contraseña inicia sesión.
        var claveEl = _el('osClave');
        _on(claveEl, 'keydown', function (e) {
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();     // sin esto, submits implícitos
                _loginDesdeUI();
            }
        });

        // ---- Guardar en la carpeta del video (v1.4.1) ----
        _on(_el('osGuardarDisco'), 'change', function () {
            var v = _el('osGuardarDisco');
            _lsSet(CFG.LS_GUARDAR_DISCO_KEY, v && v.checked ? 'true' : 'false');
            _estado((v && v.checked)
                ? 'Se guardará el subtítulo junto al video'
                : 'No se guardará el subtítulo en disco');
        });

        // ---- Key de TMDB (v1.4.0) ----
        var tmdbEl = _el('osTmdbKey');
        var guardarTmdb = function () {
            var valor = _limpiarClave(tmdbEl.value);
            tmdbEl.value = valor;
            _lsSet(CFG.LS_TMDB_KEY, valor);
            // La caché de resolución depende del título, no de la key,
            // pero se limpia por si se cambió de cuenta/proyecto.
            _lsDel(CFG.LS_TMDB_CACHE_KEY);
            _estado(valor
                ? 'API key de TMDB guardada'
                : 'Sin key de TMDB: los títulos traducidos pueden fallar');
        };
        _on(tmdbEl, 'change', guardarTmdb);
        _on(tmdbEl, 'keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                guardarTmdb();
                var c = _el('osConsulta');
                if (c) c.focus();
            }
        });

        // Clic en el fondo: solo si el clic EMPEZÓ en el fondo. Así, al
        // seleccionar texto y soltar fuera del cuadro, no se cierra.
        var modal = _el('osModal');
        var pulsadoEnFondo = false;
        _on(modal, 'mousedown', function (e) {
            pulsadoEnFondo = (e.target === modal);
        });
        _on(modal, 'click', function (e) {
            if (e.target === modal && pulsadoEnFondo) _cerrar();
            pulsadoEnFondo = false;
        });

        // Trampa de foco: Tab/Shift+Tab ciclan dentro del modal.
        _on(modal, 'keydown', function (e) {
            if (e.key !== 'Tab' || !_s.abierto) return;
            var focos = _enfocables(modal);
            if (!focos.length) return;
            var primero = focos[0];
            var ultimo  = focos[focos.length - 1];
            if (e.shiftKey && document.activeElement === primero) {
                e.preventDefault();
                ultimo.focus();
            } else if (!e.shiftKey && document.activeElement === ultimo) {
                e.preventDefault();
                primero.focus();
            }
        });

        // Avisar en vivo si se cae / vuelve la conexión con el modal abierto
        _on(window, 'offline', function () {
            if (_s.abierto) _estado('Sin conexión a internet');
        });
        _on(window, 'online', function () {
            if (_s.abierto && !_s.cargando && !_s.descargando) {
                _estado('Conexión recuperada · listo para buscar');
            }
        });

        // Escape (centralizado en vp-eventos.js). Se registra UNA vez:
        // abrir() llama a _bindEventos() cada vez y duplicaba el registro.
        if (!_s.eventosIA &&
            VP.eventos && typeof VP.eventos.registrarModalIA === 'function') {
            VP.eventos.registrarModalIA('osModal', _cerrar);
            _s.eventosIA = true;
        }

        // Respaldo: si vp-eventos no está, Escape cierra igualmente.
        // Se registra con _on para que _limpiarListeners lo pueda quitar,
        // y se guarda la referencia para destroyer() (que debe poder
        // retirar el listener aunque el modal nunca llegara a abrirse).
        if (!_s.eventosIA && !_s.escFallback) {
            _escFallbackFn = function (e) {
                if (_s.abierto && (e.key === 'Escape' || e.keyCode === 27)) {
                    e.preventDefault();
                    _cerrar();
                }
            };
            document.addEventListener('keydown', _escFallbackFn);
            _s.escFallback = true;
        }
    }

    // ============================================================
    // 18. API PÚBLICA
    // ============================================================

    /** Versión del módulo */
    VP.opensubtitles.VERSION = VERSION;

    /** Abre la ventana de búsqueda (usado por el botón Subtítulos) */
    VP.opensubtitles.abrir = function () {
        _bindEventos();
        _abrir();
    };

    /** Cierra la ventana */
    VP.opensubtitles.cerrar = _cerrar;

    /** Abre si el video no tiene subtítulos */
    VP.opensubtitles.abrirSiNoHay = function (vObj) {
        if (vObj && vObj.subtitleFile) return false;
        VP.opensubtitles.abrir();
        return true;
    };

    /** Guarda la API key (sin espacios ni saltos de línea) */
    VP.opensubtitles.guardarApiKey = function (clave) {
        _lsSet(CFG.LS_API_KEY, _limpiarClave(clave));
    };

    /** Devuelve true si hay API key configurada */
    VP.opensubtitles.tieneApiKey = function () {
        return !!_apiKey();
    };

    // ---- Sesión (v1.3.0) ----

    /**
     * Inicia sesión en OpenSubtitles.
     * NO guarda la contraseña en ningún sitio: se envía y se descarta.
     *
     * @param {string} usuario
     * @param {string} clave
     * @returns {Promise<boolean>} true si se inició sesión.
     */
    VP.opensubtitles.iniciarSesion = async function (usuario, clave) {
        var ok = await _login(usuario, clave, _s.gen);
        _reflejarSesion();
        return !!ok;
    };

    /**
     * Cierra la sesión. Solo borra el token local: la documentación no
     * exige llamar a /logout y el token caduca solo en 24 h.
     */
    VP.opensubtitles.cerrarSesion = function () {
        _logout();
    };

    /** ¿Hay sesión vigente? */
    VP.opensubtitles.tieneSesion = function () {
        return _tieneSesion();
    };

    /** Milisegundos que le quedan a la sesión (null si no hay) */
    VP.opensubtitles.sesionExpiraEn = function () {
        var s = _leerSesion();
        return s ? Math.max(0, s.exp - Date.now()) : null;
    };

    // ---- Títulos localizados (v1.4.0) ----

    /** Guarda la API key de TMDB (para resolver títulos traducidos) */
    VP.opensubtitles.guardarTmdbKey = function (clave) {
        _lsSet(CFG.LS_TMDB_KEY, _limpiarClave(clave));
    };

    /** true si hay key de TMDB configurada */
    VP.opensubtitles.tieneTmdbKey = function () {
        return !!_tmdbKey();
    };

    // ---- Guardado en disco (v1.4.1) ----

    /** ¿Se guardará el .vtt junto al video? */
    VP.opensubtitles.guardaEnDisco = function () {
        return _guardarEnDiscoActivo();
    };

    /** Activa o desactiva el guardado automático en disco. */
    VP.opensubtitles.establecerGuardarEnDisco = function (activo) {
        _lsSet(CFG.LS_GUARDAR_DISCO_KEY, activo ? 'true' : 'false');
        var el = _el('osGuardarDisco');
        if (el) el.checked = !!activo;
    };

    /** ¿Este navegador puede escribir en disco? */
    VP.opensubtitles.puedeGuardarEnDisco = function () {
        return typeof window.showDirectoryPicker === 'function' ||
               typeof window.showSaveFilePicker === 'function';
    };

    /** Nombre que tendría el archivo al guardarlo junto al video. */
    VP.opensubtitles.nombreEnDisco = function (vObj) {
        return _nombreParaDisco(vObj || _videoActual(), '');
    };

    /** Olvida el subtítulo registrado para un video (solo el índice) */
    VP.opensubtitles.olvidar = function (vObj) {
        _borrarGuardado(vObj || _videoActual());
    };

    /** Descargas hechas hoy (UTC) y, si la API lo informó, las restantes */
    VP.opensubtitles.estadoCuota = function () {
        var q = _leerCuota();
        // Con sesión el límite real depende del rango del usuario (20 a
        // 1000) y no lo sabemos sin /infos/user: null es más honesto que
        // afirmar 5.
        return {
            hoy      : q.n,
            restantes: q.restantes,
            limite   : _tieneSesion() ? null : CFG.MAX_DESCARGAS_DIA,
            sesion   : _tieneSesion(),
            quien    : q.quien,
        };
    };

    /**
     * Búsqueda programática (sin interfaz). Útil para integraciones:
     * devuelve la lista de resultados normalizados.
     *
     * @param {string} consulta  Título o nombre de archivo.
     * @param {string} [idioma]  Código de idioma ('es', 'en', 'pt-br'…).
     * @returns {Promise<Array>}
     */
    VP.opensubtitles.buscarManual = function (consulta, idioma) {
        var p = _prepararConsulta(String(consulta || ''));
        return _buscar(
            p.consulta || String(consulta || ''),
            idioma || CFG.IDIOMA_PREDETERMINADO,
            p,
            _s.gen
        );
    };

    /**
     * Re-descarga y aplica el subtítulo registrado en el índice para
     * un video (p. ej. si el IndexedDB se vació). Consume cuota.
     *
     * @param {Object} [vObj]  Video; por defecto, el actual.
     * @returns {Promise<boolean>}  true si se aplicó.
     */
    VP.opensubtitles.redescargarGuardado = async function (vObj) {
        vObj = vObj || _videoActual();
        if (!vObj) return false;

        var g = _obtenerGuardado(vObj);
        if (!g || !g.fileId) return false;

        var gen = _s.gen;
        try {
            var d = await _descargar(g.fileId, g.subFormat || 'srt', gen, g.idioma);
            var vtt = _aVtt(d.texto, d.nombre);
            var v = _validarVtt(vtt);
            if (!v.ok) throw new Error('Subtítulo inválido: ' + v.motivo);
            if (_videoActual() !== vObj) return false;
            await _aplicar(vObj, vtt, d.nombre);
            return true;
        } catch (e) {
            if (e && e.abortado) return false;
            warn('redescargarGuardado falló:', e);
            _notif(e && e.message ? e.message : 'No se pudo recuperar el subtítulo.',
                   'advertencia');
            // Si lo que falla es la sesión, el login queda a la vista.
            if (e && e.requiereLogin) _enfocarLogin();
            return false;
        }
    };

    /** Vacía las cachés en memoria (búsquedas y hashes de archivos) */
    VP.opensubtitles.limpiarCache = function () {
        _s.cacheBusqueda = {};
        _s.hashCache = {};
    };

    /** Foto del estado interno, para depurar sin abrir el inspector */
    VP.opensubtitles.diagnostico = function () {
        var q = _leerCuota();
        var s = _leerSesion();
        return {
            version          : VERSION,
            abierto          : _s.abierto,
            generacion       : _s.gen,
            cargando         : _s.cargando,
            descargando      : _s.descargando,
            // Solo booleanos: ni la key ni el token salen de aquí.
            apiKey           : !!_apiKey(),
            tmdbKey          : !!_tmdbKey(),
            sesion           : !!s,
            sesionExpiraEn   : s ? Math.max(0, s.exp - Date.now()) : null,
            ultimoOriginal   : (resultadosActual() || {}).original || null,
            online           : !_sinConexion(),
            cuotaHoy         : q.n,
            cuotaRestantes   : q.restantes,
            busquedasEnCache : Object.keys(_s.cacheBusqueda).length,
            hashesEnCache    : Object.keys(_s.hashCache).length,
            entradasIndice   : Object.keys(_leerIndice()).length,
            cacheTMDB        : Object.keys(_leerCacheTMDB()).length,
            peticionesVivas  : _s.controllers.length,
        };
    };

    /**
     * Desmonta el módulo: cancela peticiones, quita listeners, cierra
     * el modal y permite volver a cargar el script (tests, hot-reload).
     */
    VP.opensubtitles.destruir = function () {
        try { _cerrar(); } catch (_) {}
        _cancelarPendientes();
        _limpiarListeners();

        // El listener de Escape de respaldo se puso con
        // document.addEventListener: hay que retirarlo a mano.
        if (_escFallbackFn) {
            try { document.removeEventListener('keydown', _escFallbackFn); }
            catch (_) {}
            _escFallbackFn = null;
        }
        // Sin esto, tras destruir y recargar el script, abrir() daría por
        // hecho que el registro de Escape y el de vp-eventos ya existen
        // (y no se volverían a poner nunca).
        _s.eventosIA = false;
        _s.escFallback = false;
        _s.foco = null;
        _s.abierto = false;

        // Estado de login en memoria: el token es de la sesión del
        // navegador y no se toca (el usuario puede seguir logged in),
        // pero sí se olvida el "último login" para no arrastrar el
        // limitador de ritmo a una recarga del script.
        _s.loginEnCurso = false;
        _s.ultimoLogin = 0;
        _s.sugerenciaOriginal = null;

        _s.cacheBusqueda = {};
        _s.hashCache = {};
        window.__VP_OPENSUBTITLES_LOADED__ = false;
        info('OpenSubtitles desmontado');
    };

    /** Expuesto para pruebas */
    VP.opensubtitles._prepararConsulta  = _prepararConsulta;
    VP.opensubtitles._decodificar       = _decodificar;
    VP.opensubtitles._obtenerGuardado   = _obtenerGuardado;
    VP.opensubtitles._aVtt              = _aVtt;
    VP.opensubtitles._coincideIdioma    = _coincideIdioma;
    VP.opensubtitles._similitud         = _similitud;
    VP.opensubtitles._repararSrt        = _repararSrt;
    VP.opensubtitles._validarVtt        = _validarVtt;
    VP.opensubtitles._hashOpenSubtitles = _hashOpenSubtitles;
    VP.opensubtitles._errorAmigable     = _errorAmigable;
    VP.opensubtitles._claveVideo        = _claveVideo;
    VP.opensubtitles._charsetDeIdioma   = _charsetDeIdioma;

    // ---- v1.3.0 / v1.4.0 (expuestos para vp-verificar-os.js) ----
    VP.opensubtitles._validarBaseUrl      = _validarBaseUrl;
    VP.opensubtitles._expDeToken         = _expDeToken;
    VP.opensubtitles._leerSesion         = _leerSesion;
    VP.opensubtitles._guardarSesion      = _guardarSesion;
    VP.opensubtitles._borrarSesion       = _borrarSesion;
    VP.opensubtitles._baseUrl            = _baseUrl;
    VP.opensubtitles._errorLogin         = _errorLogin;
    VP.opensubtitles._paramsBusqueda     = _paramsBusqueda;
    VP.opensubtitles._resultadosParecen  = _resultadosParecen;
    VP.opensubtitles._leerCacheTMDB      = _leerCacheTMDB;
    VP.opensubtitles._leerCuota          = _leerCuota;
    VP.opensubtitles._anotarDescarga     = _anotarDescarga;
    VP.opensubtitles._fusionarPorFileId  = _fusionarPorFileId;
    VP.opensubtitles._descargar          = _descargar;
    VP.opensubtitles._resolverTMDB       = _resolverTMDB;
    VP.opensubtitles._resolverFeature    = _resolverFeature;
    VP.opensubtitles._resolverId         = _resolverId;
    VP.opensubtitles._tmdbKey            = _tmdbKey;
    VP.opensubtitles._lsDel              = _lsDel;
    VP.opensubtitles._quienActual        = _quienActual;
    VP.opensubtitles._cuotaEsMia         = _cuotaEsMia;
    VP.opensubtitles._reiniciarCuota     = _reiniciarCuota;
    VP.opensubtitles._cuotaAgotada       = _cuotaAgotada;
    VP.opensubtitles._nombreParaDisco    = _nombreParaDisco;
    VP.opensubtitles._guardarEnDisco     = _guardarEnDisco;
    VP.opensubtitles._conOriginal        = _conOriginal;
    VP.opensubtitles._clavesViejas       = _clavesViejas;
    VP.opensubtitles._marcarTituloCoincide = _marcarTituloCoincide;
    VP.opensubtitles._sincronizarTmdbKey = _sincronizarTmdbKey;
    VP.opensubtitles._loginEnCurso       = _loginEnCurso;

    /**
     * Copia de CFG SIN API_KEY. Se exporta en vez del CFG real para que
     * vp-verificar-os.js pueda comprobar la configuración sin que la key
     * quede accesible desde fuera (y sin que se cuele en un log).
     * @returns {Object}
     */
    VP.opensubtitles.config = function () {
        var copia = {};
        Object.keys(CFG).forEach(function (k) { copia[k] = CFG[k]; });
        delete copia.API_KEY;
        return copia;
    };

    info('OpenSubtitles listo (v' + VERSION + ')');

})(window, document);
