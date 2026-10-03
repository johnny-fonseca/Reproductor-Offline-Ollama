(function (window) {
    'use strict';

    var VP = window.VP;

    /* =====================================================================
       1. CONTRATO DE HUMOR Y PARSER DE RESPUESTAS (IA)
       ===================================================================== */
    function crearContratoHumor() {
        var opciones = ['neutral', 'gracioso', 'sarcastico', 'epico', 'tenso', 'asustado', 'sorprendido', 'emotivo', 'triste', 'aburrido', 'furioso', 'romantico', 'confundido'];

        function normalizar(valor) {
            var humor = String(valor || '').trim().toLowerCase().replace(/\s+/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.,;:!?]+$/, '');
            return opciones.indexOf(humor) !== -1 ? humor : 'neutral';
        }

        return {
            opciones: opciones,
            normalizar: normalizar,

            instruccionSalida: '',

            instruccionReintento: '',

            extraerRespuesta: function (value) {
                var raw = String(value || '').trim();
                var json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

                if (json.charAt(0) === '{') {
                    try {
                        var parsed = JSON.parse(json);
                        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                            return { text: '', mood: 'neutral', invalidFormat: true };
                        }

                        var respuestaJson = typeof parsed.ollama_respuesta === 'string' ? parsed.ollama_respuesta :
                            (typeof parsed.texto_burbuja === 'string' ? parsed.texto_burbuja : parsed.text);

                        var humorJson = parsed.humor || parsed.humor_mochi || parsed.mood;

                        if (typeof respuestaJson !== 'string' || !respuestaJson.trim() ||
                            typeof humorJson !== 'string' || !humorJson.trim()) {
                            return { text: '', mood: 'neutral', invalidFormat: true };
                        }

                        return {
                            text: respuestaJson.trim(),
                            mood: normalizar(humorJson)
                        };
                    } catch (_) {
                        return { text: '', mood: 'neutral', invalidFormat: true };
                    }
                }

                // Fallback por expresiones regulares si no viene JSON puro
                var moodMatch = /(?:^|\n)\s*(?:\*\*)?humor(?:_mochi)?(?:\*\*)?\s*[:=]\s*["']?([\wáéíóúñ-]+)/i.exec(raw);
                var bubbleMatch = /(?:^|\n)\s*(?:\*\*)?(?:ollama_respuesta|texto_burbuja)(?:\*\*)?\s*[:=]\s*["']?([\s\S]*)/i.exec(raw);

                if (moodMatch && bubbleMatch) {
                    return {
                        text: bubbleMatch[1].replace(/["']\s*,?\s*$/, '').trim(),
                        mood: normalizar(moodMatch[1])
                    };
                }

                return { text: '', mood: 'neutral', invalidFormat: true };
            },

            aplicar: function (elemento, valor) {
                if (!elemento) return;
                var humor = normalizar(valor);
                var humorVisual = {
                    neutral: 'neutral',
                    gracioso: 'gracioso',
                    sarcastico: 'sarcastico',
                    epico: 'epico',
                    tenso: 'tenso',
                    asustado: 'asustado',
                    sorprendido: 'sorprendido',
                    emotivo: 'emotivo',
                    triste: 'triste',
                    aburrido: 'aburrido',
                    furioso: 'furioso',
                    romantico: 'romantico',
                    confundido: 'confundido'
                }[humor] || 'neutral';
                elemento.dataset.mood = humorVisual;
            }
        };
    }
    VP._mochiMacho.crearContratoHumor = crearContratoHumor;
})(window);
