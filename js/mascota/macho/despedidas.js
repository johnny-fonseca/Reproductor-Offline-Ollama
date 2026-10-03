(function (window) {
    'use strict';

    var VP = window.VP;

    var DESPEDIDAS = [
        '¡Nos vemos pronto, amigui! ♡', '¡Hasta luego! Me voy a descansar un ratito~',
        '¡Adiós! Gracias por ver conmigo ✨', '¡Miau, me voy contento! ¡Hasta pronto!',
        '¡Hasta la próxima! Gracias por compartir este rato.', 'Me quedo por aquí para cuando vuelvas.',
        '¡Nos vemos pronto! Cuídate mucho, amigui.', 'Fue genial acompañarte. ¡Hasta luego!',
        'Hora de descansar un poco. ¡Vuelve pronto!', '¡Adiós por ahora! La próxima aventura nos espera.',
        'Gracias por invitarme a ver contigo. ♡', '¡Hasta prontito! Aquí guardaré mi lugar.',
        'Me despido por un rato. ¡Que estés muy bien!', '¡Chau, chau! Nos vemos en el siguiente video.',
        'Qué buen rato compartimos. ¡Hasta la próxima!', '¡Cuídate! Yo estaré listo para volver.',
        'Fue un gusto estar aquí contigo.', '¡Hasta luego! Dejo todo listo para la próxima.',
        'Me voy contento. ¡Nos vemos pronto!', '¡Gracias por la compañía, amigui!',
        'Pausa para mí. ¡Hasta dentro de poquito!', '¡Adiós! Que tengas un día excelente.',
        'Nos vemos cuando empiece otra historia.', '¡Hasta la próxima función!',
        'Me guardo este momento con cariño. ♡', '¡Chau! Vuelve cuando quieras.',
        'Ha sido un placer compartir la pantalla.', '¡Nos vemos pronto! Que descanses.',
        'Hasta después; yo cuido el rinconcito.', '¡Gracias por este ratito!',
        'Me retiro por ahora. ¡Sigue disfrutando!', '¡Hasta pronto! Ya estoy esperando la siguiente.',
        'Que te vaya muy bien. ¡Nos vemos!', '¡Adiós, amigui! Me encantó acompañarte.',
        'Cierro la función por hoy. ¡Hasta luego!', '¡Nos vemos en la próxima aventura!',
        'Fue un rato muy agradable. Cuídate mucho.', '¡Hasta la próxima! Aquí estaré listo.',
        '¡Nos despedimos por ahora! Que tengas un día bonito.', 'Gracias por dejarme acompañarte un rato.',
        '¡Hasta la próxima sesión! Ya tengo ganas de volver.', 'Me voy con una sonrisa. ¡Cuídate mucho!',
        '¡Que descanses! Nos vemos cuando quieras.', 'Cierro mis ojitos un momento. ¡Hasta pronto!',
        'Gracias por compartir esta aventura conmigo.', '¡Nos vemos en la siguiente historia!',
        'Me quedo esperando nuestro próximo encuentro.', '¡Adiós por ahora! Que todo te salga genial.',
        'Ha sido muy lindo pasar este rato contigo.', '¡Hasta prontito! No tardes mucho en volver.',
        'Me voy a recargar las pilas. ¡Cuídate!', '¡Nos vemos luego! Guarda una historia para mí.',
        'Gracias por hacerme parte de tu momento.', '¡Hasta luego! Que tengas una tarde tranquila.',
        'Me despido feliz por esta compañía.', '¡Vuelve cuando quieras, aquí tendrás un amigo!',
        'La función terminó, pero nos queda otra pendiente.', '¡Que tengas una noche estupenda! Hasta pronto.',
        'Me retiro a descansar. ¡Nos vemos muy pronto!', '¡Chau por ahora! Cuídate un montón.',
        'Fue genial compartir este momento contigo.', '¡Nos encontramos en la próxima aventura!',
        'Hasta aquí por hoy. Gracias por estar conmigo.', '¡Adiós! Que el resto de tu día vaya muy bien.',
        'Me guardo un lugar para la próxima vez.', '¡Hasta luego, compañero de pantalla!',
        'Gracias por este momento tan agradable.', 'Me voy tranquilo; nos vemos pronto.',
        '¡Cuídate mucho y vuelve cuando te apetezca!', 'Hasta la próxima, que tengas lindos momentos.',
        '¡Miau! Te mando un saludo hasta que regreses.', 'Ya estoy deseando que llegue la próxima función.',
        'Me despido por ahora; la pantalla queda en buenas manos.', '¡Nos vemos! Que encuentres algo lindo que disfrutar.',
        'Gracias por elegirme como compañía.', '¡Hasta pronto! Me quedo cuidando nuestro rinconcito.',
        'Fue un placer estar contigo. Que descanses.', '¡Nos vemos en otro ratito de pantalla!',
        'Adiós por ahora, pero no por mucho tiempo.', 'Me voy contento con este rato compartido.',
        '¡Que tengas un día lleno de cosas buenas!', 'Gracias por compartir tu tiempo conmigo.',
        '¡Hasta la vista! Aquí estaré para la próxima.', 'Te deseo un descanso reparador. ¡Hasta pronto!',
        '¡Nos despedimos con un miau y hasta la próxima!'
    ];
    VP._mochiMacho.DESPEDIDAS = DESPEDIDAS;
})(window);
