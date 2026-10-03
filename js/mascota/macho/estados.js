(function (window) {
    'use strict';

    var VP = window.VP;

    var ESTADOS = [
        'idle', 'leyendo', 'pensando', 'hablando', 'saludando',
        'somnoliento', 'durmiendo', 'despidiendo', 'curioso',
        'enamorado', 'poke', 'estirando', 'celebrando'
    ];
    VP._mochiMacho.ESTADOS = ESTADOS;
})(window);
