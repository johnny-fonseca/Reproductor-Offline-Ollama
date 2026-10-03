/* Voz de Mochi (hembra) — motor sanoTTS 100% offline.
 *
 * El perfil femenino no tiene motor propio: reutiliza el núcleo compartido de
 * voz-sano.js (definido en voz-macho.js), de modo que ambos perfiles usan el
 * mismo WASM. La diferencia es la voz: sanoTTS usa "chande" para hembra y
 * "vueltiao" para macho, ambas es-419.
 */
(function (window) {
    'use strict';

    var VP = window.VP = window.VP || {};
    VP._mochiHembra = VP._mochiHembra || {};

    var nucleo = VP._mochiSano;
    if (!nucleo) {
        // voz-macho.js debe cargarse primero (ver js/mascota/carga-modulos.js).
        if (window.console) window.console.warn('[Mochi] Falta el núcleo de voz sanoTTS; el perfil femenino queda sin voz.');
        VP._mochiHembra.voz = null;
        VP.mochiVozHembra = null;
        return;
    }

    function perteneceAlPerfil() {
        return !!(VP.mochiConfig && VP.mochiConfig.genero === 'hembra');
    }

    var api = nucleo.perfil('hembra', { soloEnPerfil: perteneceAlPerfil });

    VP._mochiHembra.voz = api;
    VP.mochiVozHembra = api;
})(window);
