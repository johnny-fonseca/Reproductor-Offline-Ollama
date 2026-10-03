(function (window) {
    'use strict';

    var VP = window.VP;

    var ESTADOS = [
        'idle', 'leyendo', 'pensando', 'hablando', 'saludando',
        'somnolienta', 'dormida', 'despidiendo', 'curiosa',
        'enamorada', 'poke', 'estirando', 'celebrando'
    ];
    VP._mochiHembra.ESTADOS = ESTADOS;
})(window);

