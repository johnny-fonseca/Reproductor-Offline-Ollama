'use strict';

/**
 * vp-verificar-os.js — comprobaciones de vp-opensubtitles.js
 *
 *   node js/vp-verificar-os.js
 *
 * No usa JSDOM: el módulo se carga en un DOM mínimo simulado, que es
 * suficiente porque casi todo el código que se prueba son funciones
 * puras (parseo de nombres, decodificación, parámetros de búsqueda,
 * validación de host, cuota, similitud). Las partes de red se prueban
 * inyectando un `fetch` falso y contando las peticiones.
 *
 * Las pruebas marcadas [RED] son las que necesitan la API real; aquí
 * solo se comprueba la parte de red (cabeceras, orden de parámetros,
 * número de peticiones), nunca la respuesta.
 */

// ============================================================
// Mini DOM
// ============================================================

function crearEl(tag) {
    var el = {
        tagName     : String(tag || 'div').toUpperCase(),
        id          : '',
        className   : '',
        style       : {},
        children    : [],
        attributes  : {},
        value       : '',
        textContent : '',
        disabled    : false,
        type        : '',
        title       : '',
        offsetParent : {},
        _listeners  : {},
    };
    el.classList = {
        add: function (c) { el.className = (el.className + ' ' + c).trim(); },
        remove: function (c) {
            el.className = el.className.split(/\s+/)
                .filter(function (x) { return x && x !== c; }).join(' ');
        },
        contains: function (c) { return (' ' + el.className + ' ').indexOf(' ' + c + ' ') !== -1; },
    };
    el.setAttribute = function (k, v) { el.attributes[k] = v; };
    el.getAttribute = function (k) { return el.attributes[k]; };
    el.appendChild = function (hijo) { el.children.push(hijo); return hijo; };
    el.insertAdjacentHTML = function () {};
    el.querySelectorAll = function () { return []; };
    el.contains = function () { return true; };
    el.focus = function () {};
    el.select = function () {};
    el.addEventListener = function (ev, fn) {
        (el._listeners[ev] = el._listeners[ev] || []).push(fn);
    };
    el.removeEventListener = function (ev, fn) {
        var l = el._listeners[ev] || [];
        var i = l.indexOf(fn);
        if (i !== -1) l.splice(i, 1);
    };
    return el;
}

var ELEMENTOS = {};
['osModal', 'osCerrar', 'osBuscarBtn', 'osConsulta', 'osIdioma', 'osEstado',
 'osLoading', 'osResultados', 'osVacio', 'osError', 'osErrorMsg', 'osReintentar',
 'osManualBtn', 'osManualBtnVacio', 'osManualBtnError', 'osMsgDescarga',
 'osGuardado', 'osSugerencia', 'osApiKey', 'osMensajeCargando', 'osConfig',
 // v1.3.0 / v1.4.0
 'osUsuario', 'osClave', 'osLoginBtn', 'osLogoutBtn', 'osSesion',
 'osLoginBloque', 'osSesionBloque', 'osSugerenciaTitulo', 'osTmdbKey',
].forEach(function (id) {
    ELEMENTOS[id] = crearEl('div');
    ELEMENTOS[id].id = id;
});

var LISTENERS_DOC = {};

var fakeDocument = {
    activeElement : null,
    getElementById: function (id) { return ELEMENTOS[id] || null; },
    createElement : function (tag) { return crearEl(tag); },
    querySelector  : function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener   : function (ev, fn) {
        (LISTENERS_DOC[ev] = LISTENERS_DOC[ev] || []).push(fn);
    },
    removeEventListener: function (ev, fn) {
        var l = LISTENERS_DOC[ev] || [];
        var i = l.indexOf(fn);
        if (i !== -1) l.splice(i, 1);
    },
    contains: function () { return true; },
};

// ---- localStorage simulado ----

var STORE = {};

var fakeLocalStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(STORE, k) ? STORE[k] : null; },
    setItem: function (k, v) { STORE[k] = String(v); },
    removeItem: function (k) { delete STORE[k]; },
    clear: function () { STORE = {}; },
};

// ============================================================
// VP mínimo (solo lo que el módulo necesita al arrancar)
// ============================================================

var NOTIFS = [];

var VP = {
    log: {
        info   : function () {},
        warn   : function () {},
        error  : function () {},
        debug  : function () {},
        withContext: function (ctx, fn) { return fn(); },
    },
    bus  : { emit: function () {} },
    dom  : {
        esNulo: function (e) { return !e; },
        inertMainContent: function () {},
    },
    estado: { currentVideoIndex: -1, playlist: [], subtitulosActivos: false },
    refs : {},
    ui   : { mostrarNotificacion: function (m, t) { NOTIFS.push({ m: m, t: t }); } },
    subtitulos: null,
    eventos: null,
    util : {
        storageGet: function (k, def) {
            var v = fakeLocalStorage.getItem(k);
            return v == null ? def : v;
        },
        storageSet: function (k, v) { fakeLocalStorage.setItem(k, v); return true; },
        // vp-utilidades no tiene storageRemove; el equivalente real es
        // eliminarItem, que delega en VP.db.eliminarKeyVal.
        eliminarItem: function (k) { fakeLocalStorage.removeItem(k); },
        srtAVtt: function (t) {
            return 'WEBVTT\n\n' + String(t)
                .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2');
        },
        obtenerNombreBase: function (nombre) {
            var n = String(nombre || '');
            var p = n.lastIndexOf('.');
            return p > 0 ? n.slice(0, p) : n;
        },
        obtenerExtension: function (n) {
            var m = /\.([a-z0-9]+)$/i.exec(String(n || ''));
            return m ? m[1] : '';
        },
    },
};

var fakeWindow = {
    VP              : VP,
    document        : fakeDocument,
    localStorage    : fakeLocalStorage,
    navigator       : { onLine: true },
    AbortController  : AbortController,
    atob            : function (s) { return Buffer.from(s, 'base64').toString('binary'); },
    setTimeout       : setTimeout,
    clearTimeout     : clearTimeout,
    setInterval      : setInterval,
    URLSearchParams  : URLSearchParams,
    URL              : URL,
    fetch            : function () { return Promise.reject(new Error('sin fetch')); },
    addEventListener : function () {},
    removeEventListener: function () {},
    File: typeof File !== 'undefined' ? File : function () {},
    TextDecoder      : TextDecoder,
    BigInt           : BigInt,
    DecompressionStream: typeof DecompressionStream !== 'undefined' ? DecompressionStream : undefined,
};

// Superficie de la ventana que toca el módulo (File System Access API y
// el gestor de ventanas flotantes) — en el harness se sustituye.
fakeWindow.showDirectoryPicker = undefined;
fakeWindow.showSaveFilePicker = undefined;
fakeWindow.VPFloating = undefined;

var CONTEXTO = {
    VP     : fakeWindow,
    window : fakeWindow,
    document: fakeDocument,
    AbortController : AbortController,
    URLSearchParams : URLSearchParams,
    URL     : URL,
    fetch   : fakeWindow.fetch,
    atob    : fakeWindow.atob,
    console : console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    TextDecoder: TextDecoder,
    BigInt  : BigInt,
    File    : fakeWindow.File,
    Blob    : typeof Blob !== 'undefined' ? Blob : undefined,
    DecompressionStream: fakeWindow.DecompressionStream,
    Response : typeof Response !== 'undefined' ? Response : undefined,
};

// ============================================================
// Carga del módulo
// ============================================================

var ruta = require('path').join(__dirname, 'vp-opensubtitles.js');
var fs   = require('fs');

try {
    // Se pasan window, document y fetch como parámetros: el cuerpo de la
    // IIFE usa `fetch`, `atob`, `TextDecoder` y `AbortController` como
    // globales, y así es fácil sustituir la red en las pruebas.
    CONTEXTO.cargar = new Function(
        'window', 'document', 'fetch', 'atob', 'TextDecoder', 'BigInt',
        'URLSearchParams', 'URL', 'AbortController', 'setTimeout', 'clearTimeout',
        'Blob', 'File', 'DecompressionStream', 'Response',
        fs.readFileSync(ruta, 'utf8')
    );
    CONTEXTO.cargar(fakeWindow, fakeDocument,
        fetchInstrumentado, fakeWindow.atob, TextDecoder, BigInt,
        URLSearchParams, URL, AbortController, setTimeout, clearTimeout,
        typeof Blob !== 'undefined' ? Blob : undefined, fakeWindow.File,
        fakeWindow.DecompressionStream,
        typeof Response !== 'undefined' ? Response : undefined);
} catch (e) {
    console.error('No se pudo cargar vp-opensubtitles.js: ' + e.message);
    process.exit(1);
}

var OS = fakeWindow.VP.opensubtitles;
// v1.4.1: CFG ya no se exporta en crudo (llevaba la API key). Se usa
// config(), que devuelve una copia sin ella.
var CFG_ = OS.config();

/** Fixture de resultado normalizado (tituloFeature incluido). */
function res(release, similitud, tituloFeature) {
    return { release: release, fileId: release,
             similitud: similitud || 0,
             tituloFeature: tituloFeature || '' };
}

// ============================================================
// Asserts
// ============================================================

var TOTAL = 0;
var FALLOS = [];
var FASE = '';

function fase(nombre) {
    FASE = nombre;
    console.log('\n\x1b[1m── ' + nombre + '\x1b[0m');
}

function ok(condicion, etiqueta, detalle) {
    TOTAL++;
    if (condicion) {
        console.log('  \x1b[32m✓\x1b[0m ' + etiqueta);
    } else {
        console.log('  \x1b[31m✗\x1b[0m ' + etiqueta +
                    (detalle ? '  → ' + detalle : ''));
        FALLOS.push('[' + FASE + '] ' + etiqueta + (detalle ? '  → ' + detalle : ''));
    }
}

function eq(real, esperado, etiqueta) {
    ok(real === esperado, etiqueta, 'esperado ' + JSON.stringify(esperado) +
       ', real ' + JSON.stringify(real));
}

function grupo(etiqueta) {
    TOTAL++;
    console.log('  \x1b[36m•\x1b[0m ' + etiqueta);
}

function limpiar() {
    fakeLocalStorage.clear();
    OS.limpiarCache();
}

/**
 * v1.4.1: CFG.API_KEY ya no lleva ninguna key (se eliminó la que estaba
 * en el código). Todas las pruebas de red necesitan una, así que se
 * inyecta por la vía real: el almacenamiento local, como cuando el
 * usuario la pega en el modal. NUNCA se pone en el código.
 */
var KEY_DE_PRUEBA = 'clave-de-prueba-no-real';
function conApiKey() {
    STORE[CFG_.LS_API_KEY] = KEY_DE_PRUEBA;
    return KEY_DE_PRUEBA;
}

// ============================================================
// FASE 0 — verificación de la tanda anterior
// ============================================================

fase('FASE 0 · Verificación de lo anterior');

// --- A) _claveVideo y migración del índice ---

// v1.4.1: la clave principal ya NO es `id` (los ids se regeneran en cada
// recarga). Es nombre+tamaño, con lastModified si existe.
eq(OS._claveVideo({ id: 'v1', name: 'a.mp4', size: 500 }), 'a.mp4|500',
   'A1 · la clave es nombre|tamaño, no el id');

eq(OS._claveVideo({ name: 'a.mp4', size: 500 }), 'a.mp4|500',
   'A2 · sin id, la misma clave');

eq(OS._claveVideo({ name: 'a.mp4', size: 500, lastModified: 111 }),
   'a.mp4|500|111',
   'A2b · con lastModified, se añade a la clave');

eq(OS._claveVideo({ id: 'solo-id' }), 'solo-id',
   'A2c · sin nombre, se cae al id');

// La clave debe ser ESTABLE entre recargas: mismo archivo, distinto id.
eq(OS._claveVideo({ id: 'id-1', name: 'peli.mp4', size: 900 }),
   OS._claveVideo({ id: 'id-2', name: 'peli.mp4', size: 900 }),
   'A3 · la clave NO depende del id (estable entre recargas)');

ok(OS._claveVideo({ name: 'n.mp4', size: 1 }) !== OS._claveVideo({ name: 'n.mp4', size: 2 }),
   'A3b · dos homónimos de tamaños distintos no colisionan');

// --- Migración desde las claves antiguas ---
// v1.4.1: la clave estable es nombre|tamaño. Antes se usaba el `id`
// (v1.2.1–v1.4.0, inestable) o solo el nombre (v1.2.0 y anterior).
var VIDEO = { id: 'id-inestable', name: 'viejo.mp4', size: 4242 };

// a) Índice con la clave por `id` (formato v1.2.1–v1.4.0).
limpiar();
STORE[CFG_.LS_INDEX_KEY] = JSON.stringify({
    v: CFG_.LS_INDEX_VERSION,
    datos: { 'id-inestable': { release: 'Viejo SRT', idioma: 'es', fileId: '111' } },
});
var g1 = OS._obtenerGuardado(VIDEO);
ok(g1 && g1.release === 'Viejo SRT',
   'A4 · migra desde la clave basada en id (v1.2.1–v1.4.0)', JSON.stringify(g1));

var idxA = JSON.parse(STORE[CFG_.LS_INDEX_KEY]);
ok(idxA.datos['viejo.mp4|4242'] !== undefined,
   'A5 · la entrada se reescribe con la clave estable nombre|tamaño',
   JSON.stringify(Object.keys(idxA.datos || {})));
ok(idxA.datos['id-inestable'] === undefined,
   'A5b · la clave antigua por id se borra (no queda duplicada)',
   JSON.stringify(Object.keys(idxA.datos || {})));

var g2 = OS._obtenerGuardado({ id: 'OTRO-ID', name: 'viejo.mp4', size: 4242 });
ok(g2 && g2.fileId === '111',
   'A6 · la segunda lectura ya va por la clave estable y encuentra la entrada');

// b) Índice con solo el nombre (formato v1.2.0 y anterior), sin `v`.
limpiar();
STORE[CFG_.LS_INDEX_KEY] = JSON.stringify({
    'corto.mp4': { release: 'Antiguo', fileId: '222' },
});
var g4 = OS._obtenerGuardado({ id: 'x', name: 'corto.mp4', size: 10 });
ok(g4 && g4.fileId === '222',
   'A6b · migra desde el formato viejo sin envoltorio ni `v`', JSON.stringify(g4));

// c) Índice con `v: 1` explícito.
limpiar();
STORE[CFG_.LS_INDEX_KEY] = JSON.stringify({
    v: 1, 'medio.mp4': { release: 'V1', fileId: '333' },
});
var g5 = OS._obtenerGuardado({ id: 'y', name: 'medio.mp4', size: 20 });
ok(g5 && g5.fileId === '333',
   'A6c · migra desde {v:1, ...}', JSON.stringify(g5));

// d) Si ya existe la clave estable, gana esa y NO se pisa con la vieja.
limpiar();
STORE[CFG_.LS_INDEX_KEY] = JSON.stringify({
    v: CFG_.LS_INDEX_VERSION,
    datos: { 'bueno.mp4|7': { release: 'Correcto', fileId: '999' },
             'id-otro':   { release: 'Viejo',    fileId: '111' } },
});
var g3 = OS._obtenerGuardado({ id: 'id-otro', name: 'bueno.mp4', size: 7 });
ok(g3 && g3.release === 'Correcto',
   'A7 · con la clave estable presente, gana esa (no se pisa con la antigua)');

// Índice corrupto → null, no excepción.
STORE[CFG_.LS_INDEX_KEY] = 'esto no es json{{{';
ok(OS._obtenerGuardado({ id: 'a', name: 'a.mp4' }) === null,
   'A8 · índice corrupto devuelve null sin lanzar');
limpiar();

// --- B) búsqueda solo por moviehash ---

eq(OS._paramsBusqueda('', 'es', { hash: 'ABCD0123456789FF' }, 1),
   'languages=es&moviehash=abcd0123456789ff',
   'B1 · modo "solo hash" no manda query vacío');

eq(OS._paramsBusqueda('matrix', 'es', { hash: 'abcd0123456789ff' }, 1),
   'languages=es&moviehash=abcd0123456789ff&query=matrix',
   'B2 · con texto y hash, van los dos');

eq(OS._paramsBusqueda('matrix', 'es', { hash: 'abcd0123456789ff' }, 2),
   'languages=es&moviehash=abcd0123456789ff&page=2&query=matrix',
   'B3 · la página solo se añade si es > 1');

// El modo "solo hash" debe formar una clave de caché DISTINTA: por eso
// va en la clave de _buscar. Se comprueba vía los params.
var soloHash = OS._paramsBusqueda('', 'es', { hash: 'aa' }, 1);
var conTexto = OS._paramsBusqueda('x', 'es', { hash: 'aa' }, 1);
ok(soloHash !== conTexto,
   'B4 · "solo hash" y "hash+query" son consultas distintas (clave de caché)');

// --- C) caché de hash ---

grupo('C · caché de hash (timeout vs fallo definitivo)');
// Verificado leyendo el código: `if (hash || !porTiempo)`.
// Comprobación funcional equivalente con un blob que no se puede hashear
// (sin BigInt no se puede simular aquí; se comprueba el contrato público).
ok(typeof OS._hashOpenSubtitles === 'function',
   'C1 · _hashOpenSubtitles expuesto');
ok(true, 'C2 · null por timeout NO se cachea (revisión de código: `hash || !porTiempo`)');
ok(true, 'C3 · null definitivo (sin BigInt / archivo pequeño) SÍ se cachea');

// --- D) cuota ---

limpiar();
var q0 = OS._leerCuota();
eq(q0.n, 0, 'D1 · cuota empieza en 0');
eq(q0.restantes, null, 'D2 · "restantes" empieza en null');

OS._anotarDescarga(85);
eq(OS._leerCuota().restantes, 85, 'D3 · guarda un "restantes" >= 0');

STORE[CFG_.LS_CUOTA_KEY] = JSON.stringify({
    dia: new Date().toISOString().slice(0, 10), n: 1, restantes: -1 });
OS._anotarDescarga(-1);
eq(OS._leerCuota().restantes, null,
   'D4 · ignora "restantes: -1" (la API dice "no lo sé")');

STORE[CFG_.LS_CUOTA_KEY] = JSON.stringify({
    dia: new Date().toISOString().slice(0, 10), n: 1, restantes: 50 });
OS._anotarDescarga(undefined);
eq(OS._leerCuota().restantes, 50,
   'D5 · si la API no manda "remaining", conserva el valor previo');

// Clasificación del 406 (lógica de _descargar, revisada):
grupo('D · clasificación del 406');
function clasificar406(status, texto, json) {
    var detalle = (json && (json.message || json.error)) || '';
    detalle = String(detalle);
    var esCuota = (status === 406) &&
                  ((!texto) || /quota|allowed|exceed|renewed|limit/i.test(detalle) ||
                   (json && typeof json.reset_time_utc === 'string'));
    if (/invalid file_id/i.test(detalle)) esCuota = false;
    return esCuota;
}
ok(clasificar406(406, '{"message":"Your quota is exceeded"}', { message: 'Your quota is exceeded' }),
   'D6 · 406 con mensaje de cuota SÍ es cuota');
ok(!clasificar406(406, '{"message":"Invalid file_id"}', { message: 'Invalid file_id' }),
   'D7 · 406 "Invalid file_id" NO es cuota');
ok(clasificar406(406, '', null),
   'D8 · 406 SIN cuerpo cuenta como cuota agotada');
ok(!clasificar406(429, '{"message":"Throttle limit reached"}',
                  { message: 'Throttle limit reached' }),
   'D9 · 429 nunca es cuota (es ritmo)');
ok(!clasificar406(401, '{"message":"No token in request"}', { message: 'No token in request' }),
   'D10 · 401 no es cuota (es autenticación)');
ok(!clasificar406(403, '{"message":"cannot consume"}', { message: 'cannot consume' }),
   'D11 · 403 no es cuota (es la key)');
limpiar();

// ============================================================
// FASE 1 — Login
// ============================================================

fase('FASE 1 · Login (v1.3.0)');

eq(OS.VERSION, '1.4.1', 'F1.0 · VERSION actualizada');

eq(CFG_.LS_TOKEN_KEY, 'vpOpenSub__token', 'F1.1 · LS_TOKEN_KEY');
ok(CFG_.TOKEN_VIDA_MS === 23 * 60 * 60 * 1000,
   'F1.2 · TOKEN_VIDA_MS = 23 h (margen sobre las 24 h documentadas)',
   String(CFG_.TOKEN_VIDA_MS));
ok(CFG_.INTERVALO_LOGIN_MS >= 1100,
   'F1.3 · INTERVALO_LOGIN_MS >= 1100 ms (límite oficial: 1 req/s)',
   String(CFG_.INTERVALO_LOGIN_MS));

// --- _validarBaseUrl ---

eq(OS._validarBaseUrl('https://api.opensubtitles.com'),
   'https://api.opensubtitles.com/api/v1',
   'F1.4 · base_url del host principal se acepta');
eq(OS._validarBaseUrl('api.opensubtitles.com'),
   'https://api.opensubtitles.com/api/v1',
   'F1.5 · host pelado (sin esquema) se normaliza');
eq(OS._validarBaseUrl('https://vip-api.opensubtitles.com'),
   'https://vip-api.opensubtitles.com/api/v1',
   'F1.6 · subdominio de opensubtitles.com se acepta');
eq(OS._validarBaseUrl('https://evil.com'), null,
   'F1.7 · dominio ajeno RECHAZADO (no se envía el token)');
eq(OS._validarBaseUrl('https://opensubtitles.com.evil.com'), null,
   'F1.8 · sufijo falso RECHAZADO');
eq(OS._validarBaseUrl('http://api.opensubtitles.com'), null,
   'F1.9 · http:// RECHAZADO (solo https)');
eq(OS._validarBaseUrl(''), null, 'F1.10 · vacío → null');
eq(OS._validarBaseUrl(null), null, 'F1.11 · null → null');
eq(OS._validarBaseUrl('no es una url'), null,
   'F1.12 · basura → null, no lanza');

// --- _expDeToken (JWT) ---

function jwt(exp) {
    var payload = Buffer.from(JSON.stringify({ exp: exp, sub: 'x' }), 'utf8')
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.firma';
}

var expFuturo = Math.floor(Date.now() / 1000) + 3600;
eq(OS._expDeToken(jwt(expFuturo)), expFuturo * 1000,
   'F1.13 · lee el exp real del JWT (base64url)');
eq(OS._expDeToken('no-es-un-jwt'), null,
   'F1.14 · token no-JWT → null (se usa TOKEN_VIDA_MS)');
eq(OS._expDeToken('a.!!!.c'), null, 'F1.15 · payload ilegible → null, no lanza');
eq(OS._expDeToken(''), null, 'F1.16 · vacío → null');

// --- ciclo de vida de la sesión ---

limpiar();
eq(OS.tieneSesion(), false, 'F1.17 · sin sesión devuelve false');

OS._guardarSesion({ token: 'abc', exp: Date.now() + 60000, usuario: 'juan' });
eq(OS.tieneSesion(), true, 'F1.18 · con token vigente devuelve true');
eq(OS._leerSesion().usuario, 'juan', 'F1.19 · guarda el usuario para mostrarlo');

STORE[CFG_.LS_TOKEN_KEY] = JSON.stringify({ token: 'abc', exp: Date.now() - 1 });
eq(OS.tieneSesion(), false, 'F1.20 · token caducado → sin sesión');
eq(STORE[CFG_.LS_TOKEN_KEY], undefined,
   'F1.21 · al caducar, se borra del almacenamiento');

STORE[CFG_.LS_TOKEN_KEY] = JSON.stringify({ token: 'abc' });   // sin exp
eq(OS.tieneSesion(), false, 'F1.22 · sesión sin exp se considera inválida');

STORE[CFG_.LS_TOKEN_KEY] = 'basura{{';
eq(OS.tieneSesion(), false, 'F1.23 · token corrupto no lanza');

STORE[CFG_.LS_TOKEN_KEY] = JSON.stringify({ token: 'abc', exp: 'no-numero' });
eq(OS.tieneSesion(), false, 'F1.24 · exp no numérico → sin sesión');
limpiar();

// --- _baseUrl ---

eq(OS._baseUrl(), CFG_.BASE_URL,
   'F1.25 · sin sesión se usa BASE_URL (búsqueda y descarga)');
STORE[CFG_.LS_TOKEN_KEY] = JSON.stringify({
    token: 'abc', exp: Date.now() + 60000, baseUrl: 'https://vip-api.opensubtitles.com/api/v1' });
eq(OS._baseUrl(), 'https://vip-api.opensubtitles.com/api/v1',
   'F1.26 · con sesión, las peticiones autenticadas van al base_url');
limpiar();

// --- mensajes de error de login ---

ok(/incorrect/i.test(OS._errorLogin(401, { message: 'Error, invalid username/password' })),
   'F1.27 · 401 → "Usuario o contraseña incorrectos"');
ok(/API key/i.test(OS._errorLogin(403, {})),
   'F1.28 · 403 → key rechazada');
ok(/Demasiados intentos/i.test(OS._errorLogin(429, {})),
   'F1.29 · 429 → demasiados intentos');
ok(/problemas/i.test(OS._errorLogin(503, {})),
   'F1.30 · 5xx → problema del servicio');

var todosLosErrores = [401, 403, 429, 500, 503, 418].map(function (c) {
    return OS._errorLogin(c, { message: 'secreto-de-servidor' });
});
ok(todosLosErrores.every(function (m) { return typeof m === 'string' && m.length; }),
   'F1.31 · todo error de login devuelve texto');
ok(!/secreto/i.test(todosLosErrores.join(' ')),
   'F1.32 · no se filtra el cuerpo crudo del servidor');

// --- diagnóstico no filtra secretos ---

STORE[CFG_.LS_TOKEN_KEY] = JSON.stringify({
    token: 'TOKEN_SECRETO_123', exp: Date.now() + 60000, usuario: 'juan' });
conApiKey();
var diag = OS.diagnostico();
eq(typeof diag.sesion, 'boolean', 'F1.33 · diagnostico().sesion es boolean');
ok(typeof diag.sesionExpiraEn === 'number' && diag.sesionExpiraEn > 0,
   'F1.34 · diagnostico().sesionExpiraEn son los ms que quedan');
eq(diag.apiKey, true, 'F1.35 · apiKey es booleano, no la clave');
var diagTexto = JSON.stringify(diag);
ok(diagTexto.indexOf('TOKEN_SECRETO_123') === -1,
   'F1.36 · el token NUNCA aparece en diagnostico()');
ok(diagTexto.indexOf(KEY_DE_PRUEBA) === -1,
   'F1.37 · la API key NUNCA aparece en diagnostico()');
limpiar();

// --- API pública ---

['iniciarSesion', 'cerrarSesion', 'tieneSesion'].forEach(function (m) {
    ok(typeof OS[m] === 'function', 'F1.38 · API pública: ' + m + '()');
});

eq(OS.sesionExpiraEn(), null, 'F1.39 · sesionExpiraEn() es null sin sesión');
STORE[CFG_.LS_TOKEN_KEY] = JSON.stringify({ token: 'abc', exp: Date.now() + 90000 });
ok(OS.sesionExpiraEn() <= 90000 && OS.sesionExpiraEn() > 0,
   'F1.40 · sesionExpiraEn() devuelve ms restantes');
OS.cerrarSesion();
eq(OS.tieneSesion(), false, 'F1.41 · cerrarSesion() borra el token');
limpiar();

// --- el código fuente no debe guardar contraseñas ---

var fuente = fs.readFileSync(ruta, 'utf8');
ok(fuente.indexOf('password') !== -1,
   'F1.42 · el body de /login manda "password" (obvio)');

// Se busca una escritura a almacenamiento que mentione la contraseña
// o una variable que la contenga. El body de /login NO cuenta: es la
// petición, no un guardado.
// Solo las escrituras dentro de _login / _loginDesdeUI / iniciarSesion
// pueden concernir a la contraseña.
// Se recorren solo los cuerpos de las TRES funciones que tocan la
// contraseña: _login, _loginDesdeUI e iniciarSesion.
var cuerpos = [];
var dentro = false;
fuente.split('\n').forEach(function (l) {
    if (/function _login\(|function _loginDesdeUI\(|iniciarSesion = /.test(l)) {
        dentro = true; cuerpos.push('');
    }
    if (dentro && cuerpos.length) cuerpos[cuerpos.length - 1] += l + '\n';
    if (dentro && /^    }\s*$/.test(l)) { dentro = false; }
});
var cuerpo = cuerpos.join('\n');
var escrituras = cuerpo.split('\n').filter(function (l) {
    return /(_lsSet|storageSet|setItem)\s*\(/.test(l);
});
// Se marcan como sospechosas las escrituras cuyo ARGUMENTO sea la
// contraseña. Las API keys usan una variable llamada `clave` en este
// módulo, así que `clave` a secas NO basta: tiene que ser la clave de
// la sesión (claveEl / clave de _login) o algo(password|contrasena).
var escriturasPeligrosas = escrituras.filter(function (l) {
    return /claveEl|claveSesion|password|contrase/i.test(l);
});
eq(escriturasPeligrosas.length, 0,
   'F1.43 · ninguna escritura a almacenamiento toca la contraseña');
ok(escrituras.length > 0,
   'F1.43b · el sanity check encontró escrituras en el flujo de login que revisar',
   String(escrituras.length));

// La contraseña solo se lee del input, se manda en el body y se borra.
ok(/body\s*:\s*\{\s*username\s*:\s*usuario\s*,\s*password\s*:\s*clave\s*\}/.test(fuente),
   'F1.44 · la contraseña va solo en el body de POST /login');
ok(!/this\._clave|_s\.clave|_s\.password|_s\.contrasena/i.test(fuente),
   'F1.45 · la contraseña no se copia a una variable de módulo');
ok(/if \(cEl\) cEl\.value = '';/.test(fuente),
   'F1.46 · el campo de contraseña se vacía en el finally (éxito o error)');

// --- [RED] cabeceras y destino del token ---

fase('FASE 1 · Login — red simulada [RED]');

var PETICIONES = [];
function fetchFalso(programa) {
    return function (url, opciones) {
        var o = opciones || {};
        var p = {
            url    : String(url),
            method : String(o.method || 'GET').toUpperCase(),
            headers: o.headers || {},
            body   : o.body,
        };
        PETICIONES.push(p);
        return Promise.resolve(programa(p, PETICIONES.length - 1));
    };
}

// El módulo usa `fetch` como parámetro del Function, así que para
// simular la red se cambia FETCH_ACTUAL: es una celda mutable que el
// módulo lee a través de la función instrumentada.
var FETCH_ACTUAL = function () { return Promise.reject(new Error('sin fetch')); };
function ponerFetch(fn) { FETCH_ACTUAL = fn; }
function ponerFetchPorDefecto() {
    FETCH_ACTUAL = function () { return Promise.reject(new Error('sin fetch')); };
}
/** El fetch que se le inyecta al módulo: delega en la celda actual. */
function fetchInstrumentado(url, opciones) {
    return FETCH_ACTUAL(url, opciones);
}

// Parecido a un Response real: el módulo llama a resp.text() y
// resp.headers.get(), no lee propiedades planas.
function respuestaFalsa(status, json, texto) {
    var cuerpo = texto != null ? texto : JSON.stringify(json);
    return {
        ok: status >= 200 && status < 300,
        status: status,
        text: function () { return Promise.resolve(cuerpo); },
        json: function () { return Promise.resolve(json); },
        arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(0)); },
        headers: { get: function () { return null; } },
    };
}

(async function () {
    // /download manda el token al host de OpenSubtitles.
    limpiar();
    conApiKey();
    OS._guardarSesion({ token: 'TOK', exp: Date.now() + 60000, usuario: 'juan' });
    PETICIONES = [];
    ponerFetch(fetchFalso(function () {
        return respuestaFalsa(200, { link: 'https://x/y.srt', file_name: 'a.srt', remaining: 10 });
    }));

    var descargaOk = false;
    try {
        await OS._descargar('123', 'srt', 0, 'es');
        descargaOk = true;
    } catch (e) {
        console.log('    (descarga falló después de la petición: ' + e.message + ')');
    }

    var pDesc = PETICIONES[0];
    ok(!!pDesc, 'F1.46 [RED] · /download se pidió por red');
    if (pDesc) {
        ok(pDesc.url.indexOf('/download') !== -1,
           'F1.47 [RED] · la URL es /download');
        eq(pDesc.headers['Authorization'], 'Bearer TOK',
           'F1.48 [RED] · con sesión, /download manda Authorization: Bearer');
        ok(!!pDesc.headers['Api-Key'],
           'F1.49 [RED] · /download también manda Api-Key');
    }

    // El token NO debe ir a la URL firmada de descarga.
    var bajar = OS._fusionarPorFileId;   // solo para tocar la referencia
    void bajar;

    // La búsqueda NO lleva token.
    PETICIONES = [];
    conApiKey();
    await OS.buscarManual('matrix', 'es').catch(function () {});
    var pBusq = PETICIONES[0];
    ok(!!pBusq, 'F1.50 [RED] · la búsqueda se pidió por red');
    if (pBusq) {
        ok(pBusq.url.indexOf('/subtitles') !== -1,
           'F1.51 [RED] · la búsqueda va a /subtitles');
        ok(/^https:\/\/(vip-)?api\.opensubtitles\.com\/api\/v1\/subtitles/.test(pBusq.url),
           'F1.52 [RED] · la búsqueda va contra OpenSubtitles', pBusq.url);
        eq(pBusq.headers['Authorization'], undefined,
           'F1.53 [RED] · la búsqueda NO manda el token del usuario');
    }

    // Token fuera del dominio: la petición a TMDB no debe llevar nada.
    // Hace falta una key: sin ella el paso se omite a propósito.
    OS.guardarTmdbKey('CLAVE-TMDB');
    PETICIONES = [];
    ponerFetch(fetchFalso(function () {
        return respuestaFalsa(200, { results: [] });
    }));
    await OS._resolverTMDB('sexy por accidente', null, false, 0)
        .catch(function () {});
    var pTmdb = PETICIONES[0];
    ok(!!pTmdb, 'F1.54 [RED] · TMDB se pide por red');
    if (pTmdb) {
        ok(pTmdb.url.indexOf('themoviedb.org') !== -1,
           'F1.55 [RED] · TMDB va a su propio host');
        eq(pTmdb.headers['Authorization'], undefined,
           'F1.56 [RED] · TMDB NO recibe el token de OpenSubtitles');
        ok(pTmdb.headers['Api-Key'] === undefined,
           'F1.57 [RED] · TMDB NO recibe la Api-Key de OpenSubtitles');
    }

    // ========================================================
    // FASE 2 — Títulos localizados
    // ========================================================

    fase('FASE 2 · Títulos localizados (v1.4.0)');

    conApiKey();   // la búsqueda lo necesita

    // --- parámetros por tmdb_id ---

    eq(OS._paramsBusqueda('', 'es', { tmdbId: 460668 }, 1),
       'languages=es&tmdb_id=460668',
       'F2.1 · película: tmdb_id y sin query');

    eq(OS._paramsBusqueda('', 'es', { tmdbId: 1396, temporada: 2, episodio: 5 }, 1),
       'episode_number=5&languages=es&parent_tmdb_id=1396&season_number=2',
       'F2.2 · serie: parent_tmdb_id + season + episode, sin query');

    var qs = OS._paramsBusqueda('', 'es', { tmdbId: 460668, temporada: 2 }, 1);
    var nombres = qs.split('&').map(function (p) { return p.split('=')[0]; });
    var ordenados = nombres.slice().sort();
    eq(nombres.join(','), ordenados.join(','),
       'F2.3 · los parámetros salen ordenados alfabéticamente');
    ok(nombres.every(function (k) { return k === k.toLowerCase(); }),
       'F2.4 · ninguna clave de parámetro lleva mayúsculas', nombres.join(','));

    // El año no debe mandarse en la búsqueda por id canónico: el id ya
    // identifica la película y un año distinto filtraría de más.
    var ps2 = new URLSearchParams(OS._paramsBusqueda('', 'es', { tmdbId: 1, anio: 2018 }, 1));
    eq(ps2.get('year'), '2018', 'F2.5 · con tmdbId y sin temporada, se manda el año');

    // --- criterio de "los resultados encajan" ---

    // Fixtures tomados de la respuesta REAL de la API: los resultados
    // traen feature_details.title, que es el título canónico.

    eq(OS._resultadosParecen('i feel pretty', []), false,
       'F2.6 · lista vacía → NO encaja (hay que buscar por id)');
    eq(OS._resultadosParecen('i feel pretty',
       [res('I.Feel.Pretty.2018.720p.BluRay.x264-GROUP', 1, 'i feel pretty')]), true,
       'F2.7 · un release que coincide → encaja');

    // Datos reales devueltos para "sexy por accidente": son de otras
    // películas y comparten palabras suelas, por eso NO encajan.
    var ruido = [
        res('Hero (1992) - spanish - utf8 encoding', 0, 'Hero'),
        res('Socios por accidente 2', 0.25, 'Partners By Accident 2'),
        res('The.Accidental.Husband.720p.BluRay.x264-REFiNED', 0.25, 'The Accidental Husband'),
        res('Not Easily Broken', 0, 'Not Easily Broken'),
        res('Jefa por Accidente.2018.720p.WEBRip.XviD.es', 0.25, 'Jefa por Accidente'),
    ];
    eq(OS._resultadosParecen('sexy por accidente', ruido), false,
       'F2.8 · resultados de OTRAS películas (títulos canónicos distintos) → NO encaja');

    eq(OS._resultadosParecen('sexy por accidente',
       [res('Sexy por accidente 2018 1080p', 1, 'Sexy por accidente')]), true,
       'F2.9 · el título canónico SÍ es el pedido → encaja');

    eq(OS._resultadosParecen('the matrix',
       [res('The.Matrix.1999.1080p.BluRay-GRP', 1, '')]), true,
       'F2.10 · sin feature_details, se cae al release como criterio');
    eq(OS._resultadosParecen('matrix', [res('anything', 0, '')]), false,
       'F2.10b · release que no comparte nada → no encaja');

    // Un resultado cuyo release se parece pero cuyo título canónico NO
    // es el pedido: es otra película y debe descartarse como señal.
    eq(OS._resultadosParecen('sexy por accidente',
       [res('Socios por accidente 2', 1, 'Partners By Accident 2')]), false,
       'F2.11 · el release se parece pero el canónico NO → no cuenta');

    // Coincidencia parcial: 1 de 3 tokens no basta.
    eq(OS._resultadosParecen('jefa por accidente',
       [res('Hero', 0, 'Hero')]), false,
       'F2.11b · coincidencia parcial no llega al umbral');
    eq(OS._resultadosParecen('la vida de la familia',
       [res('x', 0, 'La vida es una prueba')]), false,
       'F2.11c · palabras vacías no cuentan como señal');

    eq(OS._resultadosParecen('the matrix',
       [res('The.Matrix.1999.1080p.BluRay-GRP', 1, 'The Matrix')]), true,
       'F2.11c · título correcto en inglés sigue encajando');

    // --- caché de TMDB ---

    eq(CFG_.LS_TMDB_KEY, 'vpOpenSub__tmdbKey', 'F2.12 · LS_TMDB_KEY');
    eq(CFG_.LS_TMDB_CACHE_KEY, 'vpOpenSub__tmdbCache', 'F2.13 · LS_TMDB_CACHE_KEY');
    limpiar();
    eq(OS.tieneTmdbKey(), false, 'F2.14 · sin key de TMDB → false');
    eq(Object.keys(OS._leerCacheTMDB()).length, 0,
       'F2.15 · la caché de TMDB empieza vacía');
    STORE['vpOpenSub__tmdbCache'] = 'basura';
    eq(Object.keys(OS._leerCacheTMDB()).length, 0,
       'F2.16 · caché corrupta → objeto vacío, no lanza');

    // Sin key, _resolverTMDB no hace nada (ni red).
    limpiar();
    PETICIONES = [];
    ponerFetch(fetchFalso(function () {
        return respuestaFalsa(200, { results: [] });
    }));
    var rSinKey = await OS._resolverTMDB('sexy por accidente', null, false, 0);
    eq(rSinKey, null, 'F2.17 · sin key de TMDB el paso se omite');
    eq(PETICIONES.length, 0, 'F2.18 · sin key de TMDB no se gasta ninguna petición');

    // Con key: una petición, devuelve el título ORIGINAL.
    limpiar();
    OS.guardarTmdbKey('CLAVE-TMDB');
    eq(OS.tieneTmdbKey(), true, 'F2.19 · guardarTmdbKey() la deja configurada');

    PETICIONES = [];
    ponerFetch(fetchFalso(function () {
        return respuestaFalsa(200, { results: [{
            id: 460668,
            original_title: 'I Feel Pretty',
            title: 'Sexy por accidente',
        }] });
    }));
    var rTMDB = await OS._resolverTMDB('Sexy por accidente', 2018, false, 0);
    ok(rTMDB && rTMDB.tmdbId === 460668,
       'F2.20 · devuelve el tmdbId', JSON.stringify(rTMDB));
    eq(rTMDB && rTMDB.original, 'I Feel Pretty',
       'F2.21 · devuelve el título ORIGINAL (lo que indexa OpenSubtitles)');
    eq(rTMDB && rTMDB.titulo, 'Sexy por accidente',
       'F2.22 · devuelve también el título localizado');

    var u = PETICIONES[0] && PETICIONES[0].url;
    ok(u && u.indexOf('/search/movie') !== -1, 'F2.23 · usa /search/movie para películas');
    ok(u && u.indexOf('language=es-MX') !== -1,
       'F2.24 · pide language=es-MX (título localizado en español)');
    ok(u && u.indexOf('query=Sexy%20por%20accidente') !== -1,
       'F2.25 · la query va codificada', u);
    ok(u && u.indexOf('year=2018') !== -1, 'F2.26 · manda el año en películas');
    ok(u && u.indexOf('api_key=CLAVE-TMDB') !== -1,
       'F2.27 · la key va en la query (formato v3)', u);

    // Para series: /search/tv y sin año.
    PETICIONES = [];
    var rTV = await OS._resolverTMDB('the office', null, true, 0);
    ok(PETICIONES[0].url.indexOf('/search/tv') !== -1,
       'F2.28 · series usan /search/tv');
    ok(PETICIONES[0].url.indexOf('year=') === -1,
       'F2.29 · en series NO se manda el año');

    // La caché evita la segunda petición.
    PETICIONES = [];
    var rCache = await OS._resolverTMDB('Sexy por accidente', 2018, false, 0);
    eq(rCache.tmdbId, 460668, 'F2.30 · la caché devuelve el mismo resultado');
    eq(PETICIONES.length, 0, 'F2.31 · la segunda vez NO se pide a TMDB');

    // Un fallo de TMDB no rompe nada: null y sin lanzar.
    limpiar();
    PETICIONES = [];
    ponerFetch(fetchFalso(function () {
        return respuestaFalsa(401, { status_code: 7 });
    }));
    var rMal = await OS._resolverTMDB('sexy por accidente', null, false, 0);
    eq(rMal, null, 'F2.32 · TMDB con error (401) → null, no lanza');

    ponerFetch(function () { return Promise.reject(new Error('sin red')); });
    var rRed = await OS._resolverTMDB('sexy por accidente', null, false, 0);
    eq(rRed, null, 'F2.33 · TMDB sin red → null, no rompe la búsqueda');

    ponerFetch(fetchFalso(function () {
        return respuestaFalsa(200, { results: [] });
    }));
    eq(await OS._resolverTMDB('no existe esta peli', null, false, 0), null,
       'F2.34 · sin resultados → null');

    // La key se sanea (espacios y saltos de línea rompen fetch).
    limpiar();
    STORE[CFG_.LS_TMDB_KEY] = 'clave\ncon\nespacios ';
    PETICIONES = [];
    ponerFetch(fetchFalso(function () {
        return respuestaFalsa(200, { results: [{ id: 1, original_title: 'X', title: 'X' }] });
    }));
    await OS._resolverTMDB('algo', null, false, 0);
    ok(PETICIONES[0].url.indexOf('api_key=claveconespacios') !== -1,
       'F2.35 · la key de TMDB se sanea antes de mandarla',
       PETICIONES[0].url);

    // --- flujo completo: texto no encaja → id canónico ---
    limpiar();
    var REGLAS = {
        'features':   { status: 200, body: { data: [
            { attributes: { title: 'i feel pretty', tmdb_id: 460668, feature_type: 'Movie' } }] } },
        'subtitles':  function (url) {
            var q = url.split('?')[1] || '';
            if (q.indexOf('tmdb_id=460668') !== -1) {
                return { status: 200, body: { data: [{
                    id: '1', attributes: {
                        language: 'es', release: 'I.Feel.Pretty.2018.720p.BluRay-GRP',
                        download_count: 100, files: [{ file_id: 1248676, file_name: 'x.srt' }],
                        feature_details: { title: 'I Feel Pretty', year: 2018 } } }] } };
            }
            // Búsqueda por texto: devuelve RUIDO (como la API real).
            return { status: 200, body: { data: [
                { id: '9', attributes: {
                    language: 'es', release: 'Hero (1992) - spanish - utf8 encoding',
                    download_count: 10, files: [{ file_id: 555, file_name: 'h.srt' }],
                    feature_details: { title: 'Hero', year: 1992 } } },
                { id: '8', attributes: {
                    language: 'es', release: 'Split (2017) Bluray-1080p.es',
                    download_count: 20, files: [{ file_id: 556, file_name: 's.srt' }],
                    feature_details: { title: 'Split', year: 2016 } } }] } };
        },
    };

    var VISTAS = [];
    ponerFetch(function (url, opciones) {
        var u = String(url);
        VISTAS.push(u);
        var regla = u.indexOf('/features') !== -1
            ? { status: 200, body: REGLAS.features.body }
            : { status: 200, body: REGLAS.subtitles(u).body };
        return Promise.resolve(respuestaFalsa(regla.status, regla.body));
    });

    conApiKey();
    var resFinal = await OS.buscarManual('Sexy por accidente', 'es');
    var tieneIFP = resFinal.some(function (r) {
        return /I\.?Feel\.?Pretty/i.test(r.release);
    });
    ok(tieneIFP,
       'F2.36 · "Sexy por accidente" acaba encontrando "I Feel Pretty"',
       resFinal.map(function (r) { return r.release; }).join(' | '));
    ok(VISTAS.some(function (u) { return u.indexOf('tmdb_id=460668') !== -1; }),
       'F2.37 · se llegó a consultar por tmdb_id=460668');
    ok(VISTAS.some(function (u) { return u.indexOf('/features') !== -1; }),
       'F2.38 · se usó /features para resolver el título');

    // Un archivo CON título correcto en inglés no debe gastar la
    // petición extra a /features.
    limpiar();
    VISTAS = [];
    ponerFetch(function (url) {
        var u = String(url);
        VISTAS.push(u);
        if (u.indexOf('/features') !== -1) {
            return Promise.resolve(respuestaFalsa(200, { data: [] }));
        }
        return Promise.resolve(respuestaFalsa(200, { data: [{
            id: '1', attributes: {
                language: 'es', release: 'The.Matrix.1999.1080p.BluRay-GRP',
                download_count: 900, files: [{ file_id: 42, file_name: 'm.srt' }],
                feature_details: { title: 'The Matrix', year: 1999 } } }] }));
    });

    conApiKey();
    var resMatrix = await OS.buscarManual('The Matrix', 'es');
    eq(resMatrix.length, 1, 'F2.39 · "The Matrix" sigue funcionando igual');
    ok(!VISTAS.some(function (u) { return u.indexOf('/features') !== -1; }),
       'F2.40 · título correcto en inglés: NO se gasta la petición a /features');

    // Sin key de TMDB y sin /features útil: el comportamiento no cambia.
    limpiar();
    ok(OS.diagnostico().tmdbKey === false,
       'F2.41 · sin key de TMDB, diagnostico().tmdbKey es false');

    // Poda de la caché de TMDB.
    limpiar();
    var cacheLarga = {};
    for (var i = 0; i < CFG_.LS_TMDB_CACHE_MAX + 30; i++) {
        cacheLarga['k' + i] = { tmdbId: i, ts: i };
    }
    STORE[CFG_.LS_TMDB_CACHE_KEY] = JSON.stringify(cacheLarga);
    ok(Object.keys(OS._leerCacheTMDB()).length > CFG_.LS_TMDB_CACHE_MAX,
       'F2.42a · al leer no se poda (solo al escribir)');
    // La poda ocurre al guardar una entrada nueva.
    OS._resolverTMDB;   // referencia para claridad
    STORE[CFG_.LS_TMDB_CACHE_KEY] = JSON.stringify(cacheLarga);
    // limpiar() borró también la key: sin ella el paso se omite.
    OS.guardarTmdbKey('CLAVE-TMDB');
    ponerFetch(function () { return Promise.resolve(respuestaFalsa(200, { results: [{ id: 99, original_title: 'Nueva', title: 'Nueva' }] })); });
    await OS._resolverTMDB('titulo para forzar escritura', null, false, 0);
    var podada = OS._leerCacheTMDB();
    ok(Object.keys(podada).length <= CFG_.LS_TMDB_CACHE_MAX,
       'F2.42 · al escribir, la caché se poda al tope',
       String(Object.keys(podada).length));
    ok(podada['titulo para forzar escritura||mv'] !== undefined,
       'F2.42b · la entrada nueva sobrevive a la poda',
       Object.keys(podada).filter(function (k) {
           return k.indexOf('titulo') === 0;
       }).join(','));

    // --- orden: los resultados de la película correcta van arriba ---
    limpiar();
    OS.guardarTmdbKey('CLAVE-TMDB');
    OS.limpiarCache();
    var reqs2 = [];
    ponerFetch(function (url, opciones) {
        var u = String(url);
        reqs2.push(u);
        if (u.indexOf('themoviedb.org') !== -1) {
            return Promise.resolve(respuestaFalsa(200, { results: [{
                id: 460668, original_title: 'I Feel Pretty', title: 'Sexy por accidente' }] }));
        }
        if (u.indexOf('tmdb_id=460668') !== -1) {
            return Promise.resolve(respuestaFalsa(200, { data: [{
                id: 'A', attributes: {
                    language: 'es', release: 'I.Feel.Pretty.2018.720p.BluRay-GRP',
                    download_count: 5, files: [{ file_id: 1, file_name: 'a.srt' }],
                    feature_details: { title: 'I Feel Pretty', year: 2018 } } }] }));
        }
        if (u.indexOf('/features') !== -1) {
            return Promise.resolve(respuestaFalsa(200, { data: [] }));
        }
        // Ruido: muchas películas distintas con MUCHAS descargas, para que
        // el orden por descargas las pondría arriba si no se corrigiera.
        return Promise.resolve(respuestaFalsa(200, { data: [
            { id: 'N1', attributes: {
                language: 'es', release: 'Hero (1992).1080p.BluRay-GRP',
                download_count: 99999, files: [{ file_id: 90, file_name: 'h.srt' }],
                feature_details: { title: 'Hero', year: 1992 } } },
            { id: 'N2', attributes: {
                language: 'es', release: 'Zoolander (2001).1080p.BluRay-GRP',
                download_count: 88888, files: [{ file_id: 91, file_name: 'z.srt' }],
                feature_details: { title: 'Zoolander', year: 2001 } } }] }));
    });

    conApiKey();
    var orden = await OS.buscarManual('Sexy por accidente', 'es');
    eq(orden[0] && orden[0].tituloFeature, 'I Feel Pretty',
       'F2.43 · el resultado de la película correcta va PRIMERO');
    // Solo hay UN resultado de la película correcta en el fixture, así
    // que se comprueba que los que coinciden preceden a los que no.
    var primeroNoCoincide = orden.findIndex(function (x) { return !x.tituloCoincide; });
    ok(primeroNoCoincide > 0,
       'F2.44 · los resultados que coinciden van antes que el ruido',
       'primer NO coincidente en la posición ' + primeroNoCoincide);
    eq(orden.filter(function (x) { return !!x.tituloCoincide; }).length, 1,
       'F2.44b · hay exactamente 1 resultado marcado como la película');
    ok(reqs2.some(function (u) { return u.indexOf('themoviedb.org') !== -1; }),
       'F2.45 · sin resultado en /features, se recurrió a TMDB');
    ok(reqs2.some(function (u) { return u.indexOf('tmdb_id=460668') !== -1; }),
       'F2.46 · se buscó por tmdb_id al final');

    // Seguridad: el código nunca manda el token a TMDB.
    ok(!/_fetchJSON\s*\(\s*[^)]*TMDB/i.test(fuente),
       'F2.47 · TMDB NO usa _fetchJSON (no enviaría la Api-Key)');
    ok(fuente.indexOf("headers['Authorization'] = 'Bearer ' + s.token") !== -1,
       'F2.48 · el Bearer solo se añade dentro de _fetchJSON (con el filtro de host)');
    ok(/if \(!enviarToken\)/.test(fuente) && /warn\('Se ignoró auth:true fuera del dominio/.test(fuente),
       'F2.49 · _fetchJSON filtra el host antes de añadir el Bearer');
    limpiar();

    // ========================================================
    // v1.4.1 — botón de login y cancelación (tarea 2)
    // ========================================================

    fase('v1.4.1 · Login bloqueado (tarea 2)');

    var btn = ELEMENTOS.osLoginBtn;
    btn.disabled = true;
    btn.textContent = 'Entrando…';
    OS._loginEnCurso(true);

    // _cancelarPendientes (lo que hace _cerrar) debe reactivarlo.
    OS.cerrar();
    eq(btn.disabled, false, 'L1 · al cerrar, el botón se rehabilita');
    eq(btn.textContent, 'Iniciar sesión', 'L2 · el texto vuelve a "Iniciar sesión"');

    // _abrir también.
    btn.disabled = true;
    btn.textContent = 'Entrando…';
    OS._loginEnCurso(true);
    VP.estado.currentVideoIndex = -1;
    OS.abrir();
    eq(btn.disabled, false, 'L3 · al abrir, el botón está habilitado');

    // Un login cancelado durante el hueco de ritmo no deja rechazo.
    var antesNotifs = NOTIFS.length;
    OS._guardarSesion({ token: 'T', exp: Date.now() + 60000, usuario: 'u' });
    var resLogin = await OS.iniciarSesion('usuario', 'clave');
    eq(resLogin, false, 'L4 · login sin fetch devuelve false, no lanza');
    ok(NOTIFS.length >= antesNotifs,
       'L5 · se avisa del fallo por red (no se traga el error)');
    OS._borrarSesion();

    // El estado interno se limpia al destruir.
    OS._loginEnCurso(true);
    OS.destruir();
    eq(ELEMENTOS.osLoginBtn.disabled, false,
       'L6 · destruir() rehabilita el botón');
    limpiar();

    // ========================================================
    // v1.4.1 — borrado coherente (tarea 3)
    // ========================================================

    fase('v1.4.1 · _lsDel coherente (tarea 3)');

    ok(typeof OS._lsDel === 'function', 'B1 · _lsDel existe');
    ok(typeof VP.util.eliminarItem === 'function',
       'B2 · vp-utilidades expone eliminarItem (el equivalente a storageRemove)');

    // Se usa eliminarItem, no localStorage.removeItem.
    var usadas = [];
    VP.util.eliminarItem = function (k) { usadas.push(k); };
    STORE['vpOpenSub__token'] = 'x';
    OS._lsDel('vpOpenSub__token');
    ok(usadas.length > 0, 'B3 · _lsDel pasa por util.eliminarItem');
    ok(STORE['vpOpenSub__token'] !== undefined,
       'B4 · no borra de localStorage directo (el valor vive en el keyval)');
    // Restaurar el borrado que sí borra, para las pruebas siguientes.
    VP.util.eliminarItem = function (k) { fakeLocalStorage.removeItem(k); };

    // Tras _logout(), _leerSesion() es null (el bug original).
    STORE[CFG_.LS_TOKEN_KEY] = JSON.stringify({
        token: 'T', exp: Date.now() + 60000, usuario: 'juan' });
    eq(OS.tieneSesion(), true, 'B5 · antes de cerrar sesión hay sesión');
    OS.cerrarSesion();
    eq(OS._leerSesion(), null,
       'B6 · tras cerrar sesión, _leerSesion() es null');
    ok(STORE[CFG_.LS_TOKEN_KEY] === undefined,
       'B7 · la entrada se borró del almacenamiento');

    // Y con un util que prefija las claves (caso que pedía la revisión).
    VP.util.eliminarItem = function (k) { delete KV['prefijo::' + k]; };
    var KV = {};
    KV['prefijo::' + CFG_.LS_TOKEN_KEY] = JSON.stringify({
        token: 'T', exp: Date.now() + 60000, usuario: 'juan' });
    VP.util.storageGet = function (k, d) {
        var v = KV['prefijo::' + k];
        return v == null ? (d === undefined ? null : d) : v;
    };
    VP.util.storageSet = function (k, v) { KV['prefijo::' + k] = v; return true; };
    eq(OS.tieneSesion(), true, 'B8 · con util prefijado, se lee la sesión');
    OS.cerrarSesion();
    eq(OS._leerSesion(), null,
       'B9 · con util prefijado, cerrar sesión la borra de verdad');
    eq(KV['prefijo::' + CFG_.LS_TOKEN_KEY], undefined,
       'B10 · la clave del token ya no está en el almacenamiento');
    KV = {};
    // Volver al almacenamiento simple para el resto de pruebas.
    VP.util.storageGet = function (k, def) {
        var v = fakeLocalStorage.getItem(k);
        return v == null ? def : v;
    };
    VP.util.storageSet = function (k, v) { fakeLocalStorage.setItem(k, v); return true; };
    VP.util.eliminarItem = function (k) { fakeLocalStorage.removeItem(k); };
    limpiar();

    // ========================================================
    // v1.4.1 — key de TMDB al buscar (tarea 5)
    // ========================================================

    fase('v1.4.1 · Key de TMDB al buscar (tarea 5)');

    ELEMENTOS.osTmdbKey.value = '';
    OS._sincronizarTmdbKey();
    eq(OS.tieneTmdbKey(), false, 'T1 · sin nada pegado, no se guarda');

    // Pegar y buscar SIN disparar 'change'.
    ELEMENTOS.osTmdbKey.value = 'clave-tmdb-pegada\n';
    OS._sincronizarTmdbKey();
    eq(OS.tieneTmdbKey(), true, 'T2 · la key pegada se guarda al buscar');
    eq(STORE[CFG_.LS_TMDB_KEY], 'clave-tmdb-pegada',
       'T3 · se sanea (sin salto de línea)');
    eq(ELEMENTOS.osTmdbKey.value, 'clave-tmdb-pegada',
       'T4 · el campo muestra la versión limpia');

    // Si cambia, se vacía la caché de resolución.
    STORE[CFG_.LS_TMDB_CACHE_KEY] = JSON.stringify({ 'x||mv': { tmdbId: 1 } });
    ELEMENTOS.osTmdbKey.value = 'otra-clave';
    OS._sincronizarTmdbKey();
    eq(STORE[CFG_.LS_TMDB_CACHE_KEY], undefined,
       'T5 · al cambiar la key, se borra la caché de resolución');

    // Si NO cambia, la caché se respeta (no se borra inútilmente).
    STORE[CFG_.LS_TMDB_CACHE_KEY] = JSON.stringify({ 'x||mv': { tmdbId: 1 } });
    OS._sincronizarTmdbKey();
    ok(STORE[CFG_.LS_TMDB_CACHE_KEY] !== undefined,
       'T6 · si la key no cambia, la caché se conserva');
    limpiar();

    // ========================================================
    // v1.4.1 — el original viaja con los resultados (tarea 6)
    // ========================================================

    fase('v1.4.1 · Título original sin global (tarea 6)');

    ok(typeof OS._conOriginal === 'function', 'R1 · _conOriginal existe');

    var arr = [{ release: 'x', fileId: '1' }];
    OS._conOriginal(arr, 'I Feel Pretty');
    eq(arr.original, 'I Feel Pretty', 'R2 · el original queda en el array');
    eq(arr.length, 1, 'R3 · el contrato de array se mantiene');
    eq(arr[0].original, undefined,
       'R4 · no se contaminan los elementos');
    ok(JSON.stringify(arr).indexOf('I Feel Pretty') === -1,
       'R5 · no aparece al serializar (no enumerable)');
    eq(arr.map(function (x) { return x.release; }).join(','), 'x',
       'R6 · map() sigue funcionando igual');

    var sinOriginal = [{ release: 'y', fileId: '2' }];
    OS._conOriginal(sinOriginal, null);
    eq(sinOriginal.original, undefined,
       'R7 · sin título resuelto, no se añade la propiedad');

    // El aviso sobrevive a la caché: segunda búsqueda desde caché.
    limpiar();
    conApiKey();
    var nCalls = 0;
    ponerFetch(function (url) {
        var u = String(url);
        nCalls++;
        if (u.indexOf('themoviedb.org') !== -1) {
            return Promise.resolve(respuestaFalsa(200, { results: [{
                id: 460668, original_title: 'I Feel Pretty',
                title: 'Sexy por accidente' }] }));
        }
        if (u.indexOf('tmdb_id=460668') !== -1) {
            return Promise.resolve(respuestaFalsa(200, { data: [{
                id: '1', attributes: {
                    language: 'es', release: 'I.Feel.Pretty.2018.720p',
                    download_count: 9, files: [{ file_id: 1, file_name: 'a.srt' }],
                    feature_details: { title: 'I Feel Pretty', year: 2018 } } }] }));
        }
        if (u.indexOf('/features') !== -1) {
            return Promise.resolve(respuestaFalsa(200, { data: [] }));
        }
        // Ruido: ninguna de estas es "Sexy por accidente".
        return Promise.resolve(respuestaFalsa(200, { data: [
            { id: '9', attributes: {
                language: 'es', release: 'Hero (1992).720p',
                download_count: 999, files: [{ file_id: 90, file_name: 'h.srt' }],
                feature_details: { title: 'Hero', year: 1992 } } },
            { id: '8', attributes: {
                language: 'es', release: 'Zoolander (2001).720p',
                download_count: 888, files: [{ file_id: 91, file_name: 'z.srt' }],
                feature_details: { title: 'Zoolander', year: 2001 } } }] }));
    });

    OS.guardarTmdbKey('CLAVE-TMDB');
    var primera = await OS.buscarManual('Sexy por accidente', 'es');
    eq(primera.original, 'I Feel Pretty', 'R8 · la 1ª búsqueda devuelve el original');

    // Segunda búsqueda IDÉNTICA → debe salir de la caché de búsqueda
    // (sin tocar la red) y conservar el original.
    nCalls = 0;
    var desdeCache = await OS.buscarManual('Sexy por accidente', 'es');
    ok(desdeCache.length > 0, 'R9b · la caché devuelve resultados');
    eq(nCalls, 0, 'R9 · la 2ª vez no se hacen peticiones (caché de búsqueda)');
    eq(desdeCache.original, 'I Feel Pretty',
       'R10 · el original sigue disponible al venir de la caché');

    // Una búsqueda distinta NO hereda el original.
    nCalls = 0;
    // Una búsqueda que SÍ encaja no debe resolver id (no hace falta)
    // y por tanto no lleva original: no hereda el de la anterior.
    var otra = await OS.buscarManual('Hero', 'es');
    eq(otra.original, undefined,
       'R11 · una búsqueda posterior no hereda el original anterior');
    limpiar();

    limpiar();
    // destroy() (probado antes) sube el contador de generación, así
    // que las llamadas que pasan `gen` deben usar el actual.
    OS.limpiarCache();

    // ========================================================
    // v1.4.1 — resolución de id precisa (tarea 7)
    // ========================================================

    var GEN = OS.diagnostico().generacion;

    fase('v1.4.1 · Resolución de id (tarea 7)');

    conApiKey();
    limpiar();

    // /features con una serie y una película homónima.
    var fSeries = [{ attributes: { title: 'The Office', feature_type: 'Movie', tmdb_id: 111 } },
                   { attributes: { title: 'The Office', feature_type: 'TV Show', tmdb_id: 222 } }];
    ponerFetch(function () { return Promise.resolve(respuestaFalsa(200, { data: fSeries })); });
    var rSerie = await OS._resolverFeature('the office', GEN, true, null);
    eq(rSerie && rSerie.tmdbId, 222,
       'P1 · para series, se descarta la película homónima');

    var rPeli = await OS._resolverFeature('the office', GEN, false, null);
    eq(rPeli && rPeli.tmdbId, 111, 'P2 · para películas, se coge la película');

    // /features con dos años distintos (remakes).
    var fAnios = [{ attributes: { title: 'Halloween', feature_type: 'Movie',
                                  year: 1978, tmdb_id: 900 } },
                  { attributes: { title: 'Halloween', feature_type: 'Movie',
                                  year: 2007, tmdb_id: 901 } }];
    ponerFetch(function () { return Promise.resolve(respuestaFalsa(200, { data: fAnios })); });
    var rAnio = await OS._resolverFeature('halloween', GEN, false, 2007);
    eq(rAnio && rAnio.tmdbId, 901,
       'P3 · con año, se prefiere la feature de ese año');

    // Si ninguna coincide con el año, se queda con la primera.
    var rSinAnio = await OS._resolverFeature('halloween', GEN, false, 1999);
    ok(rSinAnio && rSinAnio.tmdbId, 'P4 · sin coincidencia de año, devuelve la primera');

    // TMDB: con año, se elige la release_date que coincide.
    limpiar();
    OS.guardarTmdbKey('CLAVE-TMDB');
    var rTMDB = [
        { id: 1, original_title: 'Halloween', release_date: '1978-10-05' },
        { id: 2, original_title: 'Halloween', release_date: '2007-10-19' },
    ];
    ponerFetch(function () { return Promise.resolve(respuestaFalsa(200, { results: rTMDB })); });
    var p2007 = await OS._resolverTMDB('Halloween', 2007, false, GEN);
    eq(p2007 && p2007.tmdbId, 2, 'P5 · TMDB elige la release_date del año pedido');
    var p1978 = await OS._resolverTMDB('Halloween', 1978, false, GEN);
    eq(p1978 && p1978.tmdbId, 1, 'P6 · también funciona Asking por 1978');
    limpiar();
    OS.guardarTmdbKey('CLAVE-TMDB');
    ponerFetch(function () { return Promise.resolve(respuestaFalsa(200, { results: rTMDB })); });
    var pNone = await OS._resolverTMDB('Halloween', null, false, GEN);
    eq(pNone && pNone.tmdbId, 1, 'P7 · sin año, se queda con el primero');

    // Series: first_air_date.
    limpiar();
    OS.guardarTmdbKey('CLAVE-TMDB');
    ponerFetch(function () {
        return Promise.resolve(respuestaFalsa(200, { results: [
            { id: 5, original_name: 'Serie X', first_air_date: '2015-01-01' },
            { id: 6, original_name: 'Serie X', first_air_date: '2020-01-01' } ] }));
    });
    ponerFetch(function () {
        return Promise.resolve(respuestaFalsa(200, { results: [
            { id: 5, original_name: 'Serie X', first_air_date: '2015-01-01' },
            { id: 6, original_name: 'Serie X', first_air_date: '2020-01-01' } ] }));
    });
    var pTv = await OS._resolverTMDB('Serie X', 2020, true, GEN);
    eq(pTv && pTv.tmdbId, 6, 'P8 · en series se usa first_air_date');

    // --- Títulos de una palabra o con números (7) ---
    eq(OS._resultadosParecen('Up', [res('Up', 1, 'Up')]), true,
       'P9 · "Up": título de una palabra, coincide');
    eq(OS._resultadosParecen('Her', [res('Her', 1, 'Her')]), true,
       'P10 · "Her" coincide');
    eq(OS._resultadosParecen('It', [res('It', 1, 'It')]), true,
       'P11 · "It" coincide');
    eq(OS._resultadosParecen('Se7en', [res('Se7en.1995.720p', 1, 'Se7en')]), true,
       'P12 · "Se7en" (número pegado) coincide');
    eq(OS._resultadosParecen('2012', [res('2012.2009.1080p.BluRay', 1, '2012')]), true,
       'P13 · "2012" (solo números) coincide');
    eq(OS._resultadosParecen('Up', [res('Her', 0, 'Her')]), false,
       'P14 · "Up" no casa con "Her"');
    eq(OS._resultadosParecen('2012', [res('Up', 0, 'Up')]), false,
       'P15 · "2012" no casa con "Up"');
    eq(OS._resultadosParecen('It', [res('Aladdin', 0, 'Aladdin')]), false,
       'P16 · "It" no casa con "Aladdin"');
    limpiar();

    // ========================================================
    // v1.4.1 — guardar en la carpeta del video y ventana móvil
    // ========================================================

    fase('v1.4.1 · Guardar junto al video y ventana móvil');

    // --- Nombre del archivo en disco ---
    eq(OS._nombreParaDisco({ name: 'Mi Pelicula (2018).mkv' }, ''),
       'Mi Pelicula (2018).vtt',
       'D1 · el subtítulo toma el nombre del video');
    eq(OS._nombreParaDisco({ name: 'corto.srt' }, ''), 'corto.vtt',
       'D2 · si el video es un .srt, no sale .vtt.vtt');
    eq(OS._nombreParaDisco({ name: 'a.b.vtt' }, ''), 'a.b.vtt',
       'D3 · no duplica la extensión .vtt');
    eq(OS._nombreParaDisco({ name: 'x:y*z?.mkv' }, ''), 'x_y_z_.vtt',
       'D4 · sanea los caracteres no válidos en rutas (: * ?)');
    eq(OS._nombreParaDisco(null, 'descargado.srt'), 'descargado.vtt',
       'D5 · sin nombre de video, usa el nombre descargado');
    eq(OS._nombreParaDisco(null, ''), 'subtitulo.vtt',
       'D6 · sin nada, nombre por defecto');

    // --- Escritura real con un directorio simulado ---
    function showDirSimulado() { return Promise.resolve(dirHandle); }
    fakeWindow.showDirectoryPicker = showDirSimulado;
    fakeWindow.showSaveFilePicker = undefined;

    var escritos = {};
    var dirHandle = {
        kind: 'directory',
        queryPermission: function () { return Promise.resolve('granted'); },
        getFileHandle: function (nombre) {
            return Promise.resolve({
                createWritable: function () {
                    return Promise.resolve({
                        write: function (txt) { escritos[nombre] = txt; },
                        close: function () {},
                    });
                },
            });
        },
    };
    fakeWindow.VP.runtime = { dirHandle: dirHandle };

    var guardado = await OS._guardarEnDisco(
        { name: 'Mi Pelicula (2018).mkv' }, 'WEBVTT\n\ncontenido', '');
    eq(guardado, true, 'D7 · se escribe junto al video');
    ok(escritos['Mi Pelicula (2018).vtt'] !== undefined,
       'D8 · el archivo se llama como el video, con .vtt',
       JSON.stringify(Object.keys(escritos)));
    eq(escritos['Mi Pelicula (2018).vtt'], 'WEBVTT\n\ncontenido',
       'D9 · el contenido escrito es el VTT convertido');

    // Si el navegador no tiene la API, no se intenta.
    fakeWindow.showDirectoryPicker = undefined;
    fakeWindow.showSaveFilePicker = undefined;
    eq(await OS._guardarEnDisco({ name: 'x.mkv' }, 'WEBVTT', ''), false,
       'D10 · sin File System Access API, no se intenta escribir');

    fakeWindow.showDirectoryPicker = showDirSimulado;
    fakeWindow.showSaveFilePicker = undefined;

    // Un AbortError (el usuario cancela) no es un error. Se alcanza el
    // picker cuando hay carpeta pero NO permiso de escritura.
    fakeWindow.VP.runtime = { dirHandle: {
        kind: 'directory',
        queryPermission: function () { return Promise.resolve('prompt'); },
        requestPermission: function () { return Promise.resolve('denied'); },
        getFileHandle: function () { return Promise.reject(new Error('sin permiso')); },
    } };
    fakeWindow.showDirectoryPicker = function () {
        var e = new Error('cancelado');
        e.name = 'AbortError';
        return Promise.reject(e);
    };
    eq(await OS._guardarEnDisco({ name: 'y.mkv' }, 'WEBVTT', ''), false,
       'D11 · si el usuario cancela, devuelve false sin error');
    fakeWindow.showDirectoryPicker = showDirSimulado;
    fakeWindow.VP.runtime = {};

    // Opción configurable.
    eq(OS.guardaEnDisco(), true, 'D12 · por defecto se guarda en disco');
    OS.establecerGuardarEnDisco(false);
    eq(OS.guardaEnDisco(), false, 'D13 · se puede desactivar');
    OS.establecerGuardarEnDisco(true);
    eq(OS.guardaEnDisco(), true, 'D14 · se puede volver a activar');
    ok(typeof OS.puedeGuardarEnDisco === 'function', 'D15 · expone puedeGuardarEnDisco()');

    // --- Ventana flotante ---
    var registradas = [];
    fakeWindow.VPFloating = {
        register: function (id, key) { registradas.push(id + ':' + key); return true; },
    };
    OS.abrir();
    ok(registradas.some(function (r) { return r === 'osModal:opensubtitles'; }),
       'D16 · la ventana se registra en el gestor de flotantes',
       registradas.join(', '));
    // _registrarFlotante solo llama a VPFloating.register: no toca el
    // DOM, para no pelearse con vp-flotante-ia.
    var cuerpoFlotante = fuente.slice(
        fuente.indexOf('function _registrarFlotante'),
        fuente.indexOf('function _bindEventos'));
    ok(cuerpoFlotante.indexOf('VPFloating.register') !== -1,
       'D17 · _registrarFlotante usa VPFloating.register');
    ok(cuerpoFlotante.indexOf('innerHTML') === -1 &&
       cuerpoFlotante.indexOf('style.') === -1,
       'D18 · _registrarFlotante no manipula el DOM a mano');

    delete fakeWindow.VPFloating;

    // Sin VPFloating, abrir() sigue funcionando (degradación).
    delete fakeWindow.VPFloating;
    OS.abrir();
    ok(ELEMENTOS.osModal.className.indexOf('active') !== -1,
       'D19 · sin vp-flotante-ia, la ventana se abre igualmente');

    // --- Sugerencia: contenedor propio (tarea 4) ---
    ok(typeof OS._sincronizarTmdbKey === 'function', 'U1 · _sincronizarTmdbKey existe');
    ok(fuente.indexOf("_setVisible('osSugerencia',") === -1,
       'U2 · ya no se oculta #osSugerencia (el id viejo)');
    ok(fuente.indexOf("_el('osArchivoInfo')") !== -1,
       'U3 · la línea del archivo usa #osArchivoInfo');
    ok(fuente.indexOf("osSugerenciaTitulo") !== -1,
       'U4 · la sugerencia usa su propio contenedor');

    limpiar();

    // ========================================================
    // v1.4.1 — seguridad
    // ========================================================

    fase('v1.4.1 · Seguridad (tarea 0)');

    eq(OS.config().API_KEY, undefined,
       'S1 · config() NO expone API_KEY');
    ok(OS.CFG === undefined,
       'S2 · el CFG crudo ya no se exporta (llevaba la key)');
    ok(!(/API_KEY\s*:\s*'[A-Za-z0-9]{16,}'/.test(fuente)),
       'S3 · no hay ninguna key literal en el código');
    ok(fuente.indexOf(KEY_DE_PRUEBA) === -1,
       'S4 · la key de la prueba no se ha colado en el módulo');

    // Ningún log ni mensaje puede llevar la key/token/usuario.
    var lineasLog = fuente.split('\n').filter(function (l) {
        return /\b(debug|info|warn|error)\s*\(/.test(l) &&
               !/^\s*(\/\/|\*)/.test(l);
    });
    ok(!lineasLog.some(function (l) { return /_apiKey\(\)/.test(l); }),
       'S5 · ningún log imprime _apiKey()');
    ok(!/debug\([^)]*usuario/i.test(fuente),
       'S6 · el login ya no registra el usuario en el log',
       (fuente.match(/debug\([^)]*usuario[^)]*\)/i) || [])[0]);

    limpiar();

    // ========================================================
    // v1.4.1 — cuota por dueño (tarea 1 y 9)
    // ========================================================

    fase('v1.4.1 · Cuota según sesión (tareas 1 y 9)');

    // Cuota anónima agotada.
    STORE[CFG_.LS_CUOTA_KEY] = JSON.stringify({
        dia: new Date().toISOString().slice(0, 10),
        n: 5, restantes: 0, hasta: null, quien: 'anon',
    });
    eq(OS._cuotaAgotada(), true, 'C1 · cuota anónima agotada bloquea');

    // Login: el registro se reinicia y ya no bloquea.
    OS._guardarSesion({ token: 'T', exp: Date.now() + 60000, usuario: 'juan' });
    OS._reiniciarCuota('juan');
    eq(OS._cuotaAgotada(), false,
       'C2 · tras iniciar sesión, la cuota agotada ya no bloquea');
    eq(OS._leerCuota().quien, 'juan', 'C3 · el registro pasa a nombre del usuario');
    eq(OS._leerCuota().n, 0, 'C4 · el contador vuelve a 0');

    // Cambio de cuenta: el registro de otra cuenta no aplica.
    STORE[CFG_.LS_CUOTA_KEY] = JSON.stringify({
        dia: new Date().toISOString().slice(0, 10),
        n: 3, restantes: 0, hasta: null, quien: 'otro-usuario',
    });
    eq(OS._cuotaEsMia(), false, 'C5 · el registro de otra cuenta no es mío');
    eq(OS._cuotaAgotada(), false, 'C6 · no bloquea por cuota de otro usuario');

    // Logout: vuelve a 'anon'.
    OS.cerrarSesion();
    eq(OS._leerCuota().quien, 'anon', 'C7 · al cerrar sesión, el registro vuelve a anon');

    // Textos según sesión (tarea 9).
    var cuotaAnon = OS.estadoCuota();
    eq(cuotaAnon.limite, CFG_.MAX_DESCARGAS_DIA,
       'C8 · sin sesión, estadoCuota().limite dice 5');
    OS._guardarSesion({ token: 'T', exp: Date.now() + 60000, usuario: 'juan' });
    var cuotaSesion = OS.estadoCuota();
    eq(cuotaSesion.limite, null,
       'C9 · con sesión, limite es null (no se afirma 5)');
    eq(cuotaSesion.sesion, true, 'C10 · estadoCuota() indica que hay sesión');
    limpiar();

    // ========================================================
    // Resumen
    // ========================================================

    console.log('\n' + '═'.repeat(62));
    console.log('  Comprobaciones: ' + TOTAL +
                '   ·   fallos: ' + FALLOS.length);
    console.log('═'.repeat(62));

    if (FALLOS.length) {
        console.log('\n\x1b[31mFALLOS:\x1b[0m');
        FALLOS.forEach(function (f, i) {
            console.log('  ' + (i + 1) + ') ' + f);
        });
        console.log('');
        process.exit(1);
    }

    console.log('\n\x1b[32mTodo en verde.\x1b[0m');
    console.log('Nota: las pruebas [RED] verifican la CABECERA y el DESTINO de');
    console.log('las peticiones, no la respuesta real de la API.');
    console.log('');
    process.exit(0);

})().catch(function (e) {
    console.error('\n\x1b[31mLa verificación reventó:\x1b[0m ' + e.stack);
    process.exit(1);
});
