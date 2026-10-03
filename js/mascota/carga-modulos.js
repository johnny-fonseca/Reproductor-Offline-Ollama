/* El orden de esta lista es el orden de ejecución. No reordenar. */
(function () {
    var scripts = [
        'js/mascota/hembra/nucleo.js',
        'js/mascota/hembra/contrato-humor.js',
        'js/mascota/hembra/saludos.js',
        'js/mascota/hembra/despedidas.js',
        'js/mascota/hembra/frases.js',
        'js/mascota/hembra/estados.js',
        'js/mascota/hembra/apariencia.js',
        'js/mascota/hembra/perfil.js',
        'js/mascota/hembra/validar-integracion.js',
        'js/mascota/macho/nucleo.js',
        'js/mascota/macho/contrato-humor.js',
        'js/mascota/macho/saludos.js',
        'js/mascota/macho/despedidas.js',
        'js/mascota/macho/frases.js',
        'js/mascota/macho/estados.js',
        'js/mascota/macho/apariencia.js',
        'js/mascota/macho/perfil.js',
        'js/mascota/macho/voz-macho.js',
        'js/mascota/hembra/voz-hembra.js',
        'js/mascota/voz/voz-comun.js',
        'js/mascota/macho/validar-integracion.js',
        'js/mascota/motor/configuracion.js',
        'js/mascota/motor/utilidades.js',
        'js/mascota/motor/subtitulos.js',
        'js/mascota/motor/ollama.js',
        'js/mascota/motor/planificador.js',
        'js/mascota/interfaz/estilos.js',
        'js/mascota/interfaz/dom.js',
        'js/mascota/orquestador.js'
    ];
    for (var i = 0; i < scripts.length; i++) {
        var s = document.createElement('script');
        s.src = scripts[i];
        s.async = false;
        document.head.appendChild(s);
    }
})();
