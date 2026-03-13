/**
 * silabas.js — Contador de sílabas para español
 *
 * Implementa las reglas básicas de silabificación del español:
 * - Vocales fuertes (a, e, o) y débiles (i, u)
 * - Diptongos: débil+fuerte, fuerte+débil, débil+débil
 * - Hiatos: fuerte+fuerte, débil acentuada+fuerte
 * - Grupos consonánticos inseparables (bl, br, cl, cr, dr, fl, fr, gl, gr, pl, pr, tr)
 *
 * Se usa en haiku.js y sketch.js para verificar la métrica 5-7-5.
 */

const Silabas = (function () {

  // Clasificación de vocales según reglas de silabificación española:
  // FUERTES (a, e, o): generan núcleo silábico independiente
  // DEBILES (i, u): débiles sin acento, forman diptongos con fuertes o entre sí
  // DEBILES_ACENTUADAS (í, ú): rompen diptongos y forman hiatos forzados
  const VOCALES = "aeiouáéíóúüAEIOUÁÉÍÓÚÜ";
  const FUERTES = "aeoáéóAEOÁÉÓ";
  const DEBILES = "iuíúüIUÍÚÜ";
  const DEBILES_ACENTUADAS = "íúÍÚ";

  /**
   * esVocal — determina si un carácter es vocal
   * Se usa internamente para la lógica de silabificación.
   */
  function esVocal(c) {
    return VOCALES.includes(c);
  }

  /**
   * esFuerte — determina si un carácter es vocal fuerte (a, e, o)
   * Las vocales fuertes siempre forman núcleo silábico independiente.
   * Se usa en la lógica de diptongos/hiatos para detectar cambios de sílaba.
   */
  function esFuerte(c) {
    return FUERTES.includes(c);
  }

  /**
   * esDebil — determina si un carácter es vocal débil sin acento (i, u)
   * Las débiles se pueden agrupar con fuertes formando diptongos
   * o entre sí formando triptongos.
   */
  function esDebil(c) {
    return DEBILES.includes(c);
  }

  /**
   * esDebilAcentuada — detecta vocales débiles acentuadas (í, ú)
   * El acento fuerza un hiato, separando la sílaba de vocales adyacentes.
   * Ejemplo: río (ri-o, no rio), búho (bú-o, no buo)
   */
  function esDebilAcentuada(c) {
    return DEBILES_ACENTUADAS.includes(c);
  }

  /**
   * contarSilabas — cuenta las sílabas de una palabra en español
   * Recorre la palabra detectando núcleos vocálicos y aplicando
   * reglas de diptongo/hiato para determinar cuántas sílabas tiene.
   *
   * @param {string} palabra
   * @returns {number} número de sílabas
   */
  function contarSilabas(palabra) {
    if (!palabra || palabra.length === 0) return 0;

    // Limpiar: solo letras
    let w = palabra.toLowerCase().replace(/[^a-záéíóúüñ]/g, "");
    if (w.length === 0) return 0;

    let silabas = 0;
    let i = 0;

    while (i < w.length) {
      if (esVocal(w[i])) {
        silabas++;
        // Consumir grupo vocálico (diptongos y triptongos)
        let j = i + 1;
        while (j < w.length && esVocal(w[j])) {
          let prev = w[j - 1];
          let curr = w[j];

          // Hiato: dos fuertes consecutivas crean sílabas separadas
          // Ejemplo: caos = ca-os (dos sílabas)
          if (esFuerte(prev) && esFuerte(curr)) {
            break;
          }
          // Hiato: débil acentuada seguida de fuerte forma sílabas separadas
          // Ejemplo: río = rí-o (dos sílabas, la tilde rompe el diptongo)
          if (esDebilAcentuada(curr) && esFuerte(prev)) {
            break;
          }
          // Hiato: fuerte seguida de débil acentuada (la acentuada ya fue contada)
          // Ejemplo: búho = bú-ho (dos sílabas)
          if (esFuerte(curr) && esDebilAcentuada(prev)) {
            break;
          }
          // Diptongo: débil+fuerte, fuerte+débil, o débil+débil forman una sílaba
          // Ejemplos: cielo = cie-lo (diptongo ie), sueño = sue-ño (diptongo ue)
          j++;
        }
        i = j;
      } else {
        i++;
      }
    }

    return Math.max(silabas, 1);
  }

  /**
   * contarSilabasFrase — cuenta sílabas totales de una frase
   * Separa por espacios y suma las sílabas de cada palabra.
   * Se usa en haiku.js y sketch.js para validar que cada verso cumpla
   * la métrica 5-7-5 de la composición de haikus.
   *
   * @param {string} frase - Verso o línea completa de texto
   * @returns {number} Total de sílabas en la frase
   */
  function contarSilabasFrase(frase) {
    let palabras = frase.trim().split(/\s+/);
    let total = 0;
    for (let p of palabras) {
      total += contarSilabas(p);
    }
    return total;
  }

  return {
    contarSilabas,
    contarSilabasFrase
  };

})();
