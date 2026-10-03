    /* Apariencia y animaciones definidas en cada archivo de perfil. */
    (function (window, document) {
        'use strict';
        var VP = window.VP;
        if (!VP) return;
        var ESTILOS_ID = 'vp-mochi-estilos';
        var llamadasInyectar = 0;
        function inyectar() {
            try {
                llamadasInyectar++;
                var style = document.getElementById(ESTILOS_ID);
                if (!style) style = document.createElement('style');
                var perfil = VP.mochiPerfilActual ? VP.mochiPerfilActual() : {};
                var estilosUI =
                    '\n.vp-mochi__bubble{border-color:var(--mood-border,rgba(255,255,255,.22));transition:opacity .26s ease,transform .36s cubic-bezier(.34,1.56,.64,1),border-color .25s ease;}' +
                    '\n.vp-mochi__bubble[data-mood="gracioso"]{--mood-border:#F5B301;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="sarcastico"]{--mood-border:#9B59D0;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="epico"]{--mood-border:#FF8A1F;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="tenso"]{--mood-border:#D64545;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="sorprendido"]{--mood-border:#29B6F6;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="asustado"]{--mood-border:#8BC34A;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="emotivo"]{--mood-border:#F06292;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="triste"]{--mood-border:#5C6BC0;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="aburrido"]{--mood-border:#7C93A8;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="furioso"]{--mood-border:#B71C1C;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="romantico"]{--mood-border:#E91E8C;border-color:var(--mood-border);}' +
                    '\n.vp-mochi__bubble[data-mood="confundido"]{--mood-border:#26A69A;border-color:var(--mood-border);}' +
                    '\n.vp-mochi--bottom-left,.vp-mochi--bottom-right{transition:inset-block-end .25s ease;}' +
                    '.vp-mochi--bottom-left.vp-mochi--controls-hidden,.vp-mochi--bottom-right.vp-mochi--controls-hidden{inset-block-end:20px!important;}\n' +
                    '.vp-mochi--bottom-left .vp-mochi__wrap,.vp-mochi--bottom-right .vp-mochi__wrap{transform-origin:bottom center;}\n' +
                    '.vp-mochi--bottom-left.vp-mochi--controls-hidden .vp-mochi__wrap,.vp-mochi--bottom-right.vp-mochi--controls-hidden .vp-mochi__wrap{animation:vp-mochi-caida-rebote .48s both;}\n' +
                    '@keyframes vp-mochi-caida-rebote{0%{transform:translateY(-16px);animation-timing-function:cubic-bezier(.55,0,1,.45);}45%{transform:translateY(0) scaleY(.84);animation-timing-function:cubic-bezier(0,0,.45,1);}70%{transform:translateY(-6px) scaleY(1.06);animation-timing-function:cubic-bezier(.55,0,1,.45);}100%{transform:translateY(0) scaleY(1);}}\n' +
                    '@media (prefers-reduced-motion:reduce){.vp-mochi--bottom-left.vp-mochi--controls-hidden .vp-mochi__wrap,.vp-mochi--bottom-right.vp-mochi--controls-hidden .vp-mochi__wrap{animation:none;}}' +
                    '\n.vp-mochi__ollama-indicator{position:absolute;z-index:5;top:-17px;left:50%;font:18px/1 sans-serif;pointer-events:none;opacity:0;transform:translate(-50%,4px) scale(.7);filter:drop-shadow(0 1px 2px rgba(0,0,0,.25));}' +
                    '\n.vp-mochi__phase-indicator{position:absolute;z-index:4;right:-7px;top:-9px;width:21px;height:21px;display:grid;place-items:center;border-radius:50%;background:rgba(28,35,54,.84);color:#dce8ff;box-shadow:0 1px 4px #0005;pointer-events:none;opacity:0;transform:translateY(2px) scale(.8);transition:opacity .16s ease,transform .16s ease;}' +
                    '\n.vp-mochi__phase-indicator svg{width:15px;height:15px;overflow:visible;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}' +
                    '\n.vp-mochi[data-tech-state="CONTEXT_READY"] .vp-mochi__phase-indicator,.vp-mochi[data-tech-state="REQUESTING_OLLAMA"] .vp-mochi__phase-indicator,.vp-mochi[data-tech-state="PROCESSING_RESPONSE"] .vp-mochi__phase-indicator,.vp-mochi[data-tech-state="WAITING_TIMING"] .vp-mochi__phase-indicator,.vp-mochi[data-tech-state="COOLDOWN"] .vp-mochi__phase-indicator,.vp-mochi[data-tech-state="ERROR"] .vp-mochi__phase-indicator{opacity:1;transform:translateY(0) scale(1);}' +
                    '\n.vp-mochi[data-tech-state="CONTEXT_READY"] .vp-mochi__phase-indicator{color:#b9f2d0;}' +
                    '\n.vp-mochi[data-tech-state="CONTEXT_READY"] .vp-mochi__phase-indicator svg{animation:vp-mochi-phase-check .55s ease both;}' +
                    '\n.vp-mochi[data-tech-state="REQUESTING_OLLAMA"] .vp-mochi__phase-indicator{color:#b9dcff;}' +
                    '\n.vp-mochi[data-tech-state="REQUESTING_OLLAMA"] .vp-mochi__phase-indicator svg{animation:vp-mochi-phase-send .65s ease-in-out infinite alternate;}' +
                    '\n.vp-mochi[data-tech-state="PROCESSING_RESPONSE"] .vp-mochi__phase-indicator{color:#ffe39a;}' +
                    '\n.vp-mochi[data-tech-state="PROCESSING_RESPONSE"] .vp-mochi__phase-indicator svg{animation:vp-mochi-phase-scan .9s ease-in-out infinite;}' +
                    '\n.vp-mochi[data-tech-state="WAITING_TIMING"] .vp-mochi__phase-indicator{color:#d7c5ff;}' +
                    '\n.vp-mochi[data-tech-state="WAITING_TIMING"] .vp-mochi__phase-indicator svg{animation:vp-mochi-phase-tick 1.5s ease-in-out infinite;}' +
                    '\n.vp-mochi[data-tech-state="COOLDOWN"] .vp-mochi__phase-indicator{color:#d7c5ff;}' +
                    '\n.vp-mochi[data-tech-state="COOLDOWN"] .vp-mochi__phase-indicator svg{animation:vp-mochi-phase-sleep 2.6s ease-in-out infinite;}' +
                    '\n.vp-mochi[data-tech-state="ERROR"] .vp-mochi__phase-indicator{color:#ffaaa7;background:rgba(75,24,32,.9);}' +
                    '\n.vp-mochi[data-tech-state="ERROR"] .vp-mochi__phase-indicator svg{animation:vp-mochi-phase-error .45s ease-in-out 2;}' +
                    '\n@keyframes vp-mochi-phase-check{0%{transform:scale(.72);opacity:.55}70%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}' +
                    '\n@keyframes vp-mochi-phase-send{from{transform:translate(-1px,1px) rotate(-8deg)}to{transform:translate(1px,-1px) rotate(7deg)}}' +
                    '\n@keyframes vp-mochi-phase-scan{0%,100%{transform:translateX(-1px);opacity:.75}50%{transform:translateX(1px);opacity:1}}' +
                    '\n@keyframes vp-mochi-phase-tick{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(10deg)}}' +
                    '\n@keyframes vp-mochi-phase-sleep{0%,100%{transform:translateY(1px) scale(.94);opacity:.72}50%{transform:translateY(-1px) scale(1.04);opacity:1}}' +
                    '\n@keyframes vp-mochi-phase-error{0%,100%{transform:translateX(0)}35%{transform:translateX(-1px)}70%{transform:translateX(1px)}}' +
                    '\n.vp-mochi__ollama-hourglass{display:none;}' +
                    '\n.vp-mochi[data-ollama-status="waiting"] .vp-mochi__ollama-indicator{display:block!important;opacity:1!important;transform:translate(-50%,0) scale(1)!important;animation:vp-mochi-indicador-espera .9s ease-in-out infinite!important;}' +
                    '\n.vp-mochi[data-ollama-status="waiting"] .vp-mochi__ollama-hourglass{display:inline-block!important;opacity:1!important;animation:vp-mochi-reloj-espera 1.1s ease-in-out infinite!important;}' +
                    '\n.vp-mochi[data-ollama-status="respuesta"] .vp-mochi__ollama-indicator{animation:vp-mochi-indicador-respuesta 1.25s ease-in-out infinite;}' +
                    '\n.vp-mochi__ollama-bulb{display:none;}' +
                    '\n.vp-mochi[data-ollama-status="respuesta"] .vp-mochi__ollama-bulb{display:inline-block;filter:drop-shadow(0 0 5px #ffe45e);animation:vp-mochi-foco-activo .9s ease-in-out infinite;}' +
                    '\n.vp-mochi__ollama-question{display:none;}' +
                    '\n.vp-mochi[data-ollama-status="invalida"] .vp-mochi__ollama-indicator{animation:vp-mochi-indicador-breve 2.8s ease-in-out both;}' +
                    '\n.vp-mochi[data-ollama-status="invalida"] .vp-mochi__ollama-question{display:inline-block;color:#ffd166;font-weight:900;text-shadow:0 1px 4px rgba(0,0,0,.55);animation:vp-mochi-foco-breve 2.8s ease both;}' +
                    '\n@keyframes vp-mochi-indicador-breve{0%{opacity:0;transform:translate(-50%,5px) scale(.65)}12%{opacity:1;transform:translate(-50%,0) scale(1.08)}20%,78%{opacity:1;transform:translate(-50%,0) scale(1)}100%{opacity:0;transform:translate(-50%,-4px) scale(.8)}}' +
                    '\n@keyframes vp-mochi-indicador-respuesta{0%,100%{opacity:1;transform:translate(-50%,0) scale(.94)}50%{opacity:1;transform:translate(-50%,-2px) scale(1.08)}}' +
                    '\n@keyframes vp-mochi-indicador-espera{0%,100%{filter:drop-shadow(0 1px 2px rgba(0,0,0,.25))}50%{filter:drop-shadow(0 0 5px rgba(255,220,100,.8))}}' +
                    '\n@keyframes vp-mochi-reloj-espera{0%,100%{transform:rotate(-9deg) translateY(0)}50%{transform:rotate(9deg) translateY(-1px)}}' +
                    '\n@keyframes vp-mochi-reloj{0%{transform:rotate(-16deg) translateY(2px);opacity:0}18%{transform:rotate(12deg) translateY(-1px);opacity:1}35%,80%{transform:rotate(0) translateY(0);opacity:1}100%{transform:rotate(12deg) translateY(-2px);opacity:0}}' +
                    '\n@keyframes vp-mochi-foco-breve{0%{transform:scale(.2) rotate(-25deg);opacity:0}12%{transform:scale(1.35) rotate(8deg);opacity:1}22%,78%{transform:scale(1) rotate(0);opacity:1}100%{transform:scale(.75) rotate(12deg);opacity:0}}' +
                    '\n@keyframes vp-mochi-foco-activo{0%,100%{transform:scale(.9) rotate(-5deg)}50%{transform:scale(1.16) rotate(5deg)}}' +
                    '\n.vp-mochi__phase-indicator{display:none!important;}' +
                    '\n.vp-mochi__sweat{display:none;position:absolute;z-index:3;top:-8px;left:68%;width:10px;height:15px;pointer-events:none;opacity:0;background:linear-gradient(145deg,rgba(227,250,255,.98),rgba(91,190,235,.74));border:1px solid rgba(255,255,255,.72);box-shadow:0 0 4px rgba(120,220,255,.55);clip-path:polygon(50% 0,88% 36%,100% 61%,93% 82%,75% 96%,50% 100%,25% 96%,7% 82%,0 61%,12% 36%);}' +
                    '\n.vp-mochi[data-tech-detail="ollama-unavailable"] .vp-mochi__sweat{display:block;animation:vp-mochi-sweat 2.35s ease-in-out both;}' +
                    '\n@keyframes vp-mochi-sweat{0%{opacity:0;transform:scale(.25,.35)}7%{opacity:.94;transform:scale(1,1)}22%{opacity:.94;transform:scale(.78,1.5)}38%{opacity:.88;transform:scale(1,1)}53%{opacity:.94;transform:scale(.78,1.5)}69%{opacity:.88;transform:scale(1,1)}82%{opacity:.92;transform:scale(.78,1.5)}91%{opacity:.86;transform:scale(1,1)}100%{opacity:0;transform:scale(.8,.9)}}' +
                    '\n@media (prefers-reduced-motion:no-preference){.vp-mochi[data-tech-pose] .vp-mochi__body,.vp-mochi[data-tech-pose] .vp-mochi__ear,.vp-mochi[data-tech-pose] .vp-mochi__eye,.vp-mochi[data-tech-pose] .vp-mochi__tail,.vp-mochi[data-tech-pose] .vp-mochi__profile-accessory{transition:transform .2s ease,filter .2s ease;}}' +
                    '\n@media (prefers-reduced-motion:reduce){.vp-mochi__phase-indicator{animation:none!important;transition:none!important;}}';
                style.id = ESTILOS_ID;
                var contenido = (perfil.estilosBase || '') + (perfil.estilos || '') +
                    (Array.isArray(perfil.animaciones) ? perfil.animaciones.join('\n') : (perfil.animaciones || '')) +
                    (perfil.estilosEstados || '') +
                    estilosUI;
                if (style.textContent !== contenido) style.textContent = contenido;
                if (!style.parentNode) (document.head || document.documentElement).appendChild(style);
                if ((VP_DEBUG.general || VP_DEBUG.Mochi.general || VP_DEBUG.Mochi.estilos) && window.console && typeof window.console.info === 'function') {
                    window.console.info('[Mochi estilos runtime]', {
                        llamada: llamadasInyectar,
                        hojasConId: document.querySelectorAll('#' + ESTILOS_ID).length,
                        reglas: style.sheet && style.sheet.cssRules ? style.sheet.cssRules.length : null
                    });
                }
            } catch (e) {
                var err = (VP._mochiUtil && VP._mochiUtil.error) || function () {};
                err('No se pudieron inyectar los estilos del perfil:', e);
            }
        }
        VP._mochiEstilos = { inyectar: inyectar };
    })(window, document);
