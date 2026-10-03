(function (window) {
    'use strict';

    var VP = window.VP;
    if (!VP || !VP._mochiHembra) throw new Error('No cargó js/mascota/hembra/nucleo.js.');
    if (typeof VP._mochiHembra.crearContratoHumor !== 'function') throw new Error('No cargó js/mascota/hembra/contrato-humor.js.');
    if (!VP._mochiHembra.SALUDOS) throw new Error('No cargó js/mascota/hembra/saludos.js.');
    if (!VP._mochiHembra.DESPEDIDAS) throw new Error('No cargó js/mascota/hembra/despedidas.js.');
    if (!VP._mochiHembra.FRASES) throw new Error('No cargó js/mascota/hembra/frases.js.');
    if (!VP._mochiHembra.ESTADOS) throw new Error('No cargó js/mascota/hembra/estados.js.');
    if (typeof VP._mochiHembra.ESTILOS_BASE !== 'string') throw new Error('No cargó la sección de estilos base de js/mascota/hembra/apariencia.js.');
    if (typeof VP._mochiHembra.ESTILOS_HEMBRA !== 'string') throw new Error('No cargó la sección visual hembra de js/mascota/hembra/apariencia.js.');
    if (typeof VP._mochiHembra.ANIMACIONES_HEMBRA !== 'string') throw new Error('No cargó la sección de animaciones de js/mascota/hembra/apariencia.js.');
    if (typeof VP._mochiHembra.ESTILOS_ESTADOS !== 'string') throw new Error('No cargaron los movimientos de estados de js/mascota/hembra/apariencia.js.');
    if (!VP.mochiPerfiles || !VP.mochiPerfiles.hembra) throw new Error('No cargó js/mascota/hembra/perfil.js.');
    if (!('id' in VP.mochiPerfiles.hembra) || !('version' in VP.mochiPerfiles.hembra) || !('nombre' in VP.mochiPerfiles.hembra) || !('ariaLabel' in VP.mochiPerfiles.hembra) || !('accesorio' in VP.mochiPerfiles.hembra) || !('humor' in VP.mochiPerfiles.hembra) || !('promptSistema' in VP.mochiPerfiles.hembra) || !('promptFormato' in VP.mochiPerfiles.hembra) || !('tono' in VP.mochiPerfiles.hembra) || !('saludos' in VP.mochiPerfiles.hembra) || !('despedidas' in VP.mochiPerfiles.hembra) || !('estados' in VP.mochiPerfiles.hembra) || !('frases' in VP.mochiPerfiles.hembra) || !('estilosBase' in VP.mochiPerfiles.hembra) || !('estilos' in VP.mochiPerfiles.hembra) || !('estilosEstados' in VP.mochiPerfiles.hembra) || !('animaciones' in VP.mochiPerfiles.hembra) || !('parametros' in VP.mochiPerfiles.hembra) || !('seleccionarFrase' in VP.mochiPerfiles.hembra) || !('validarRespuesta' in VP.mochiPerfiles.hembra)) throw new Error('El perfil hembra está incompleto; verifica js/mascota/hembra/perfil.js.');
})(window);

