/* Enruta la API pública de voz al perfil activo de Mochi (macho / hembra).
 * Compatible con la versión anterior: misma API, mismo comportamiento base.
 * Añadidos: validación de entradas, manejo de errores, volumen persistente
 * entre géneros, eventos de cambio de género y utilidades de diagnóstico. */
(function (window) {
    'use strict';

    var VP = window.VP = window.VP || {};

    var GENEROS = ['macho', 'hembra'];
    var DEBUG = !!(VP.mochiConfig && VP.mochiConfig.debug);

    /* ---------- Utilidades internas ---------- */

    function log(nivel, mensaje, err) {
        if (!window.console) return;
        if (nivel === 'debug' && !DEBUG) return;
        var fn = window.console[nivel] || window.console.log;
        try {
            if (err !== undefined) fn.call(window.console, '[mochiVoz] ' + mensaje, err);
            else fn.call(window.console, '[mochiVoz] ' + mensaje);
        } catch (e) { /* la consola nunca debe romper la voz */ }
    }

    function normalizarGenero(g) {
        return g === 'macho' ? 'macho' : 'hembra';
    }

    function esGeneroValido(g) {
        return GENEROS.indexOf(g) !== -1;
    }

    function esFuncion(f) {
        return typeof f === 'function';
    }

    /* Ejecuta fn sin dejar escapar excepciones; devuelve `defecto` si falla. */
    function seguro(fn, defecto, etiqueta) {
        try {
            return fn();
        } catch (err) {
            log('warn', 'Error en ' + (etiqueta || 'operación'), err);
            return defecto;
        }
    }

    /* Convierte cualquier resultado (valor, promesa o excepción) en una promesa
       que nunca se rechaza y resuelve con `defecto` si algo falla. */
    function promesaSegura(fn, defecto, etiqueta) {
        try {
            return Promise.resolve(fn()).catch(function (err) {
                log('warn', 'Promesa rechazada en ' + (etiqueta || 'operación'), err);
                return defecto;
            });
        } catch (err) {
            log('warn', 'Error en ' + (etiqueta || 'operación'), err);
            return Promise.resolve(defecto);
        }
    }

    function limitarVolumen(valor) {
        var n = Number(valor);
        if (!isFinite(n)) return null;
        return Math.min(1, Math.max(0, n));
    }

    function emitir(nombre, detalle) {
        seguro(function () {
            if (typeof window.CustomEvent === 'function' && window.dispatchEvent) {
                window.dispatchEvent(new window.CustomEvent(nombre, { detail: detalle }));
            }
        }, undefined, 'emitir ' + nombre);
    }

    /* ---------- Estado ---------- */

    var genero = normalizarGenero(VP.mochiConfig && VP.mochiConfig.genero);
    var volumenPreferido = null;   // null = no se ha fijado; se respeta el de cada voz
    var oyentes = [];              // callbacks de onGeneroCambio

    /* ---------- Resolución de la voz activa ---------- */

    function obtener(g) {
        return g === 'macho'
            ? (VP.mochiVozMacho || (VP._mochiMacho && VP._mochiMacho.voz))
            : (VP.mochiVozHembra || (VP._mochiHembra && VP._mochiHembra.voz));
    }

    /* Aplica el volumen elegido por el usuario a una voz concreta. */
    function aplicarVolumen(voz) {
        if (volumenPreferido === null || !voz || !esFuncion(voz.setVolume)) return;
        seguro(function () { voz.setVolume(volumenPreferido); }, undefined, 'aplicarVolumen');
    }

    /* ---------- Cambio de género ---------- */

    function setGenero(nuevo) {
        nuevo = normalizarGenero(nuevo);
        if (genero === nuevo) return genero;

        var anteriorGenero = genero;
        var anterior = obtener(anteriorGenero);

        if (anterior) {
            if (esFuncion(anterior.detener)) seguro(function () { anterior.detener(); }, undefined, 'detener (cambio de género)');
            if (esFuncion(anterior.liberar)) seguro(function () { anterior.liberar(); }, undefined, 'liberar (cambio de género)');
        }

        genero = nuevo;
        aplicarVolumen(obtener(genero));
        log('debug', 'Género: ' + anteriorGenero + ' -> ' + genero);

        var info = { anterior: anteriorGenero, actual: genero };
        oyentes.slice().forEach(function (cb) {
            seguro(function () { cb(info); }, undefined, 'oyente de género');
        });
        emitir('mochivoz:genero', info);

        return genero;
    }

    /* ---------- API pública ---------- */

    var api = {
        hablar: function (texto, opciones) {
            opciones = opciones || {};

            if (texto === null || texto === undefined) return Promise.resolve(false);
            if (typeof texto !== 'string') texto = String(texto);
            if (!texto.trim()) return Promise.resolve(false);

            var destino = esGeneroValido(opciones.genero) ? opciones.genero : genero;
            if (destino !== genero) setGenero(destino);

            var voz = obtener(destino);
            if (!voz || !esFuncion(voz.hablar)) {
                log('debug', 'No hay voz disponible para "' + destino + '"');
                return Promise.resolve(false);
            }

            aplicarVolumen(voz);
            return promesaSegura(function () { return voz.hablar(texto, opciones); }, false, 'hablar');
        },

        detener: function () {
            var voz = obtener(genero);
            if (voz && esFuncion(voz.detener)) seguro(function () { voz.detener(); }, undefined, 'detener');
        },

        activar: function (valor) {
            var voz = obtener(genero);
            if (!voz || !esFuncion(voz.activar)) return Promise.resolve();
            return promesaSegura(function () { return voz.activar(valor); }, undefined, 'activar');
        },

        setVolume: function (valor) {
            var v = limitarVolumen(valor);
            if (v === null) return api.getVolume();           // valor inválido: no cambia nada
            volumenPreferido = v;
            var voz = obtener(genero);
            return voz && esFuncion(voz.setVolume)
                ? seguro(function () { return voz.setVolume(v); }, v, 'setVolume')
                : v;
        },

        getVolume: function () {
            var voz = obtener(genero);
            if (voz && esFuncion(voz.getVolume)) {
                return seguro(function () { return voz.getVolume(); }, 1, 'getVolume');
            }
            return volumenPreferido !== null ? volumenPreferido : 1;
        },

        estaListo: function () {
            var voz = obtener(genero);
            return !!(voz && esFuncion(voz.estaListo) && seguro(function () { return voz.estaListo(); }, false, 'estaListo'));
        },

        estaHablando: function () {
            var voz = obtener(genero);
            return !!(voz && esFuncion(voz.estaHablando) && seguro(function () { return voz.estaHablando(); }, false, 'estaHablando'));
        },

        setGenero: setGenero,

        getGenero: function () { return genero; },

        /* ---------- Extras (opcionales, no afectan al código existente) ---------- */

        /* Alterna entre macho y hembra y devuelve el género resultante. */
        alternarGenero: function () {
            return setGenero(genero === 'macho' ? 'hembra' : 'macho');
        },

        /* ¿Existe la voz de ese género (o del activo) cargada en VP? */
        estaDisponible: function (g) {
            return !!obtener(esGeneroValido(g) ? g : genero);
        },

        /* Suscribe un callback a los cambios de género. Devuelve función para cancelar. */
        onGeneroCambio: function (cb) {
            if (!esFuncion(cb)) return function () {};
            oyentes.push(cb);
            return function () {
                var i = oyentes.indexOf(cb);
                if (i !== -1) oyentes.splice(i, 1);
            };
        },

        /* Resumen del estado actual, útil para depurar desde la consola. */
        diagnostico: function () {
            return {
                genero: genero,
                volumenPreferido: volumenPreferido,
                disponible: { macho: !!obtener('macho'), hembra: !!obtener('hembra') },
                listo: api.estaListo(),
                hablando: api.estaHablando()
            };
        }
    };

    VP.mochiVoz = api;
})(window);