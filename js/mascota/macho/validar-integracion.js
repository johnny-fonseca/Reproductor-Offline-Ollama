(function (window) {
    'use strict';

    var VP = window.VP;
    if (!VP || !VP._mochiMacho) throw new Error('No cargó js/mascota/macho/nucleo.js.');
    if (typeof VP._mochiMacho.crearContratoHumor !== 'function') throw new Error('No cargó js/mascota/macho/contrato-humor.js.');
    if (!VP._mochiMacho.SALUDOS) throw new Error('No cargó js/mascota/macho/saludos.js.');
    if (!VP._mochiMacho.DESPEDIDAS) throw new Error('No cargó js/mascota/macho/despedidas.js.');
    if (!VP._mochiMacho.FRASES) throw new Error('No cargó js/mascota/macho/frases.js.');
    if (!VP._mochiMacho.ESTADOS) throw new Error('No cargó js/mascota/macho/estados.js.');
    if (typeof VP._mochiMacho.ESTILOS_BASE !== 'string') throw new Error('No cargó la sección de estilos base de js/mascota/macho/apariencia.js.');
    if (typeof VP._mochiMacho.ESTILOS_MACHO !== 'string') throw new Error('No cargó la sección visual macho de js/mascota/macho/apariencia.js.');
    if (typeof VP._mochiMacho.ANIMACIONES_MACHO !== 'string') throw new Error('No cargó la sección de animaciones de js/mascota/macho/apariencia.js.');
    if (typeof VP._mochiMacho.ESTILOS_ESTADOS !== 'string') throw new Error('No cargaron los movimientos de estados de js/mascota/macho/apariencia.js.');
    if (!VP.mochiPerfiles || !VP.mochiPerfiles.macho) throw new Error('No cargó js/mascota/macho/perfil.js.');
    if (!('id' in VP.mochiPerfiles.macho) || !('version' in VP.mochiPerfiles.macho) || !('nombre' in VP.mochiPerfiles.macho) || !('ariaLabel' in VP.mochiPerfiles.macho) || !('accesorio' in VP.mochiPerfiles.macho) || !('humor' in VP.mochiPerfiles.macho) || !('promptSistema' in VP.mochiPerfiles.macho) || !('promptFormato' in VP.mochiPerfiles.macho) || !('tono' in VP.mochiPerfiles.macho) || !('saludos' in VP.mochiPerfiles.macho) || !('despedidas' in VP.mochiPerfiles.macho) || !('estados' in VP.mochiPerfiles.macho) || !('frases' in VP.mochiPerfiles.macho) || !('estilosBase' in VP.mochiPerfiles.macho) || !('estilos' in VP.mochiPerfiles.macho) || !('estilosEstados' in VP.mochiPerfiles.macho) || !('animaciones' in VP.mochiPerfiles.macho) || !('parametros' in VP.mochiPerfiles.macho) || !('seleccionarFrase' in VP.mochiPerfiles.macho) || !('validarRespuesta' in VP.mochiPerfiles.macho)) throw new Error('El perfil macho está incompleto; verifica js/mascota/macho/perfil.js.');
})(window);
