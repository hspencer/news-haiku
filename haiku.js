/**
 * haiku.js — Compositor de haiku a partir de titulares
 *
 * Dos motores disponibles:
 * 1. IA (Groq/Llama): Envía el titular a la API y recibe un haiku creativo
 * 2. Algorítmico (fallback): Recompone palabras del titular por conteo silábico
 *
 * El motor de IA se intenta primero; si falla, se usa el algorítmico.
 * Se usa en sketch.js para generar el haiku mostrado en el canvas.
 */

const Haiku = (function () {

  // ── Configuración de la API (Groq — Llama 3.3 70B) ──
  const LLM_MODEL = "llama-3.3-70b-versatile";

  // URLs de proxy en orden de prioridad (cadena de fallback):
  // 1. Netlify Function (producción — detecta automáticamente el dominio)
  // 2. Proxy local Node.js (desarrollo)
  // El código intenta cada URL en orden; si la primera falla, sigue con la siguiente.
  // Esto permite que el motor funcione tanto en producción como en desarrollo local.
  const PROXY_URLS = [
    "/.netlify/functions/haiku",
    "http://localhost:3001/haiku"
  ];

  // Prompt del sistema que instruye al LLM (Llama) a comportarse como Bashō.
  // Define la poética, la métrica exacta (5-7-5), restricciones de diccionario,
  // y el formato esperado (3 versos sin puntuación ni explicación).
  // Se envía con cada solicitud a la API de Groq para mantener la coherencia artística.
  const SYSTEM_PROMPT = `Eres una voz poética americana. Tu arte: recibir un titular de noticias y cruzarlo —travesía— hasta desvelar lo que en él se regala sin ser visto. No consolar. No moralizar. Desvelar.

POÉTICA:
- Cada titular guarda un don escondido: encuéntralo. No busques belleza "dentro del horror" —eso es un cliché. Busca lo que irrumpe: lo desconocido que aparece cuando las palabras se abren.
- Prefiere lo concreto y lo americano: un guijarro en nieve, el toro negro contra el pasto, flamencos sobre azogue, la barcaza entre espumas, el petróleo que emigra, ríos que desaparecen en sus médanos. Nada de "arenas", "sombras" ni "vientos" genéricos.
- No uses la naturaleza como espejo de lo humano. Que la naturaleza sea ella misma: autónoma, indiferente, presente.
- Busca el corte: que entre el segundo y tercer verso haya un salto, una abertura, algo que no se esperaba. Como dice Amereida: "la señal verdadera miente como el día / para salvar de otros usos / la noche regalada".
- Cada palabra debe pesar. Elimina todo lo que sobre. La carencia es riqueza.
- VOCABULARIO PROHIBIDO: no uses estas palabras gastadas: arena, viento, sombra, ceniza, brote, esperanza, horizonte, aurora, amanecer, ocaso, alba, crepúsculo, destello, suspiro, murmullo, eco, alma, latido. Busca palabras más precisas, más concretas, más inesperadas.

MÉTRICA LIBRE PERO BREVE:
- Verso libre. No hay patrón silábico fijo.
- Pero cada verso debe tener MÁXIMO 5 palabras. La brevedad es sagrada.
- Tres versos cortos, densos, con aire entre ellos.

RESTRICCIONES:
- Transforma palabras del titular cuando puedas, pero la calidad poética manda.
- Usa SOLO palabras reales del español (diccionario RAE). No inventes.

FORMATO:
- SOLO los 3 versos, uno por línea.
- Sin puntuación final. Sin comillas. Sin título. Sin explicación.
- Todo en minúsculas.`;

  // ── Motor de IA (Groq) ──

  /**
   * hacerFetch — intenta conectar al LLM probando los proxies en orden:
   * primero Netlify Function (producción), luego proxy local (dev).
   * Ninguno requiere Authorization en el header porque ambos lo agregan.
   *
   * TIMEOUT Y FALLBACK:
   * - Cada intento tiene un timeout de 15 segundos (AbortController).
   * - Si el timeout se cumple, se lanza una excepción que es capturada y se pasa al siguiente proxy.
   * - Si todos los proxies fallan, devuelve null y el motor algorítmico toma control.
   *
   * @param {string} titular - el titular apocalíptico
   * @returns {Promise<Object|null>} respuesta JSON del LLM o null si falla
   */
  async function hacerFetch(titular) {
    const payload = JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: titular }
      ],
      model: LLM_MODEL,
      stream: false,
      temperature: 0.9
    });

    for (let i = 0; i < PROXY_URLS.length; i++) {
      try {
        const controller = new AbortController();
        // Timeout de 15 segundos por intento: si se vence, abort() cancela el fetch
        const timeout = setTimeout(() => controller.abort(), 15000);

        const resp = await fetch(PROXY_URLS[i], {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (resp.ok) {
          console.log("LLM conectó via proxy #" + i + ": " + PROXY_URLS[i]);
          return await resp.json();
        }
        console.log("Proxy #" + i + " respondió " + resp.status);
      } catch (e) {
        console.log("Proxy #" + i + " no disponible: " + e.message);
      }
    }
    console.log("Ningún proxy disponible — usando motor algorítmico");
    return null;
  }

  /**
   * validarHaiku — validación estructural ligera.
   * Solo rechaza respuestas claramente mal formadas.
   * Cada regex busca un tipo de fallo distinto:
   * 1. Verso muy corto (< 2 caracteres) — indica línea vacía o malformada
   * 2. Números y símbolos (/[0-9@#...]/) — el LLM a veces incrustra números por error
   * 3. Frases de meta-explicación (/^aquí|este|nota|verso|/) — el LLM explica en vez de poetizar
   */
  function validarHaiku(versos) {
    for (let verso of versos) {
      // Rechazar líneas muy cortas o vacías (menos de 2 caracteres no forma un verso poético)
      if (verso.trim().length < 2) {
        console.log("Verso demasiado corto:", verso);
        return false;
      }
      // Rechazar si contiene números o caracteres no poéticos (evita errores del LLM tipo "verso 1")
      if (/[0-9@#$%^&*=+{}[\]|\\<>]/.test(verso)) {
        console.log("Verso con caracteres no poéticos:", verso);
        return false;
      }
      // Rechazar si parece explicación (el LLM a veces responde "aquí va el haiku" en vez del haiku)
      if (/^(aquí|este|nota|verso|haiku|línea|sílaba)/i.test(verso.trim())) {
        console.log("Verso parece explicación, no poesía:", verso);
        return false;
      }
    }
    return true;
  }

  async function componerConLLM(titular) {
    try {
      const data = await hacerFetch(titular);
      if (!data) return null;

      const texto = data.choices[0].message.content.trim();
      // Limpiar posible markdown (**negrita**, etc.): el LLM a veces envuelve poesía en asteriscos.
      // Removemos todos los asteriscos para asegurar que cada verso es puro texto poético.
      const textoLimpio = texto.replace(/\*\*/g, "").replace(/\*/g, "");
      const lineas = textoLimpio.split("\n").map(l => l.trim()).filter(l => l.length > 0);

      if (lineas.length >= 3) {
        let versos = [lineas[0], lineas[1], lineas[2]];
        console.log("Haiku de LLM:", versos.join(" / "));

        if (validarHaiku(versos)) {
          return {
            versos: versos,
            metrica: versos.map(v => Silabas.contarSilabasFrase(v)),
            titular: titular,
            motor: "groq"
          };
        }
      }

      console.log("LLM formato inesperado:", texto);
      return null;

    } catch (e) {
      console.log("componerConLLM error:", e.message);
      return null;
    }
  }

  // ── Motor algorítmico (fallback) ──

  // PUENTE: Diccionario de palabras "puente" (de relleno) agrupadas por conteo silábico.
  // Cuando el algoritmo no puede armar un verso solo con palabras del titular,
  // busca palabras poéticas de PUENTE para completar la métrica.
  // Las palabras están agrupadas por número de sílabas (1, 2, 3, 4) para acceso rápido.
  // Cada palabra es poética (no vacía de sentido) para mantener la calidad artística.
  const PUENTE = {
    1: ["luz", "sol", "mar", "sal", "voz", "cruz", "sur", "don", "red", "cal"],
    2: ["piedra", "nieve", "fuego", "río", "noche", "hueso", "hierro",
        "barro", "ola", "rama", "costa", "fondo", "cobre", "tumba",
        "raíz", "piel", "musgo", "pulpa", "greda", "liquen"],
    3: ["espuma", "corteza", "guijarro", "granito", "cardumen",
        "estero", "barranco", "relámpago", "petróleo", "resina",
        "esquirla", "herrumbre", "estanque", "páramo", "basalto"],
    4: ["constelación", "cordillera", "desembocadura", "enredadera",
        "pedregal", "terremoto", "ventisquero", "acantilado"]
  };

  const DESCARTABLES = new Set([
    "el", "la", "los", "las", "un", "una", "unos", "unas",
    "de", "del", "al", "a", "en", "por", "para", "con",
    "y", "o", "e", "u", "que", "se", "su", "sus",
    "es", "son", "ha", "han", "fue", "más", "muy",
    "este", "esta", "esto", "ese", "esa", "eso",
    "como", "pero", "sino", "ni", "ya", "no",
    "según", "tras", "ante", "sobre", "entre"
  ]);

  const POETICAS = new Set([
    "muerte", "vida", "guerra", "fuego", "agua", "tierra",
    "lluvia", "sol", "luna", "noche", "sangre", "luz",
    "piedra", "hierro", "sal", "hueso", "piel", "cuerpo",
    "río", "monte", "bosque", "selva", "isla", "costa",
    "hambre", "sed", "frío", "temblor", "humo", "llama",
    "fósil", "raíz", "semilla", "fruto", "tumba", "ruina",
    "glaciar", "volcán", "desierto", "pampa", "océano",
    "especie", "lengua", "pueblo", "frontera", "exilio"
  ]);

  /**
   * limpiarPalabra — normaliza una palabra quitando puntuación
   */
  function limpiarPalabra(p) {
    return p.replace(/[.,;:!?¿¡"'()\[\]{}—–\-]/g, "").trim().toLowerCase();
  }

  /**
   * puntuacionPoetica — asigna un puntaje a cada palabra
   * Las palabras poéticas valen más, las descartables valen menos.
   */
  function puntuacionPoetica(palabra) {
    let p = limpiarPalabra(palabra);
    if (DESCARTABLES.has(p)) return 0;
    if (POETICAS.has(p)) return 10;
    return Math.min(p.length, 6);
  }

  /**
   * intentarVerso — intenta construir un verso de N sílabas usando backtracking.
   *
   * ALGORITMO DE BACKTRACKING:
   * - Busca recursivamente combinaciones de palabras que sumen exactamente silabasObjetivo.
   * - Favorece soluciones más cortas (menos palabras) para verso más poético y conciso.
   * - MAX_ITER (5000) evita freezes en titulares muy largos (seguridad).
   * - Poda: si las sílabas restantes no alcanzan al objetivo, no explora esa rama.
   *
   * @param {Array} palabrasDisponibles
   * @param {number} silabasObjetivo
   * @param {Set} usadas - índices ya usados
   * @returns {Array|null} índices de palabras seleccionadas, o null
   */
  function intentarVerso(palabrasDisponibles, silabasObjetivo, usadas) {
    let mejor = null;
    let iteraciones = 0;
    const MAX_ITER = 5000; // límite de iteraciones: detiene búsqueda si se excede (evita freezes)

    function buscar(idx, silActual, seleccion) {
      iteraciones++;
      if (iteraciones > MAX_ITER) return; // si supera MAX_ITER, abandona esta rama

      if (silActual === silabasObjetivo) {
        // Encontró una solución: preferir la más corta (menos palabras = verso más poético)
        if (!mejor || seleccion.length < mejor.length) {
          mejor = [...seleccion];
        }
        return;
      }
      if (silActual > silabasObjetivo) return; // ya pasó el objetivo, no hay solución
      if (idx >= palabrasDisponibles.length) return; // sin más palabras disponibles

      // Poda: verificar si el total de sílabas restantes es suficiente para alcanzar el objetivo
      let restante = 0;
      for (let k = idx; k < palabrasDisponibles.length; k++) {
        if (!usadas.has(k)) restante += palabrasDisponibles[k].silabas;
      }
      if (silActual + restante < silabasObjetivo) return; // imposible alcanzar desde aquí

      for (let i = idx; i < palabrasDisponibles.length; i++) {
        if (iteraciones > MAX_ITER) return;
        if (usadas.has(i)) continue;
        let p = palabrasDisponibles[i];
        if (silActual + p.silabas <= silabasObjetivo) {
          seleccion.push(i);
          buscar(i + 1, silActual + p.silabas, seleccion);
          seleccion.pop();
        }
      }
    }

    buscar(0, 0, []);
    return mejor;
  }

  /**
   * componerAlgoritmico — genera un haiku (5-7-5) algorítmicamente.
   *
   * ESTRATEGIA COMPLETA:
   * 1. Extrae palabras del titular, limpia puntuación.
   * 2. Asigna puntaje poético a cada palabra (POETICAS > resto > DESCARTABLES).
   * 3. Ordena palabras por puntaje (mayor primero).
   * 4. Para cada verso (5, 7, 5 sílabas):
   *    a. Intenta armar verso con palabras del titular (intentarVerso).
   *    b. Si falla, busca completar con palabras del PUENTE.
   *    c. Si aún así falla, construye verso únicamente con PUENTE.
   * 5. Devuelve objeto con versos, métricas, titular y motor usado.
   */
  function componerAlgoritmico(titular) {
    if (!titular || titular.trim().length === 0) {
      return { versos: ["silencio alba", "el mundo espera en calma", "nace nueva luz"], metrica: [5, 7, 5], titular: "", motor: "fallback" };
    }

    let palabrasRaw = titular.split(/\s+/).map(p => limpiarPalabra(p)).filter(p => p.length > 0);
    let metrica = [5, 7, 5];

    let palabras = palabrasRaw.map((p, i) => ({
      texto: p,
      silabas: Silabas.contarSilabas(p),
      puntaje: puntuacionPoetica(p),
      indiceOriginal: i
    }));

    let ordenadas = [...palabras].sort((a, b) => b.puntaje - a.puntaje);

    let versos = [];
    let usadas = new Set();

    for (let m of metrica) {
      let indices = intentarVerso(ordenadas, m, usadas);

      if (indices) {
        for (let idx of indices) usadas.add(idx);
        let palabrasVerso = indices.map(i => ordenadas[i]);
        palabrasVerso.sort((a, b) => a.indiceOriginal - b.indiceOriginal);
        versos.push(palabrasVerso.map(p => p.texto).join(" "));
      } else {
        versos.push(completarConPuente(ordenadas, m, usadas));
      }
    }

    return {
      versos: versos,
      metrica: versos.map(v => Silabas.contarSilabasFrase(v)),
      titular: titular,
      motor: "algoritmico"
    };
  }

  /**
   * completarConPuente — intenta armar un verso de N sílabas mezclando
   * una palabra del titular (si existe) con palabras puente (PUENTE).
   * Si no encuentra palabra del titular, delega a buscarPuente o versoDePuentes.
   * Marca palabras como usadas para no reutilizarlas en otros versos.
   */
  function completarConPuente(palabras, silabasObj, usadas) {
    for (let i = 0; i < palabras.length; i++) {
      if (usadas.has(i)) continue;
      let p = palabras[i];
      if (p.silabas <= silabasObj && p.puntaje > 0) {
        let faltan = silabasObj - p.silabas;
        usadas.add(i);
        if (faltan === 0) return p.texto;
        let puente = buscarPuente(faltan);
        if (puente) {
          return Math.random() > 0.5 ? puente + " " + p.texto : p.texto + " " + puente;
        }
        usadas.delete(i);
      }
    }
    return buscarPuente(silabasObj) || versoDePuentes(silabasObj);
  }

  /**
   * buscarPuente — busca una o dos palabras puente que sumen exactamente N sílabas.
   * Primero intenta una palabra simple de PUENTE[n];
   * si N > 4, intenta descomponer en dos palabras puente (a + b = n).
   * Devuelve null si no encuentra combinación válida.
   */
  function buscarPuente(n) {
    if (n <= 0) return "";
    if (n <= 4 && PUENTE[n]) {
      let opciones = PUENTE[n];
      return opciones[Math.floor(Math.random() * opciones.length)];
    }
    for (let a = 1; a <= Math.min(n - 1, 4); a++) {
      let b = n - a;
      if (b >= 1 && b <= 4 && PUENTE[a] && PUENTE[b]) {
        let pa = PUENTE[a][Math.floor(Math.random() * PUENTE[a].length)];
        let pb = PUENTE[b][Math.floor(Math.random() * PUENTE[b].length)];
        return pa + " " + pb;
      }
    }
    return null;
  }

  /**
   * versoDePuentes — construye un verso completo usando solo palabras puente,
   * acumulando palabras hasta alcanzar exactamente N sílabas.
   * Se usa cuando no hay palabras del titular disponibles.
   */
  function versoDePuentes(n) {
    let verso = [];
    let restante = n;
    while (restante > 0) {
      let sil = Math.min(restante, 4);
      while (sil > 0 && (!PUENTE[sil] || PUENTE[sil].length === 0)) sil--;
      if (sil === 0) break;
      let opciones = PUENTE[sil];
      verso.push(opciones[Math.floor(Math.random() * opciones.length)]);
      restante -= sil;
    }
    return verso.join(" ");
  }

  // ── API pública ──

  /**
   * componerHaiku — FUNCIÓN PRINCIPAL que genera un haiku. LLAMADA DESDE sketch.js.
   *
   * FLUJO:
   * 1. Intenta componerConLLM (motor de IA via Groq/Llama).
   * 2. Si LLM responde un haiku válido, lo devuelve (motor: "groq").
   * 3. Si LLM falla, timeout, o responde inválido, usa componerAlgoritmico (fallback).
   * 4. Siempre devuelve un haiku, aunque sea algorítmico.
   *
   * Es async porque puede hacer llamadas a la API de Groq.
   *
   * @param {string} titular
   * @returns {Promise<Object>} {versos: [s,s,s], metrica: [n,n,n], titular, motor}
   */
  async function componerHaiku(titular) {
    // Intentar con LLM primero (Groq/Llama)
    let resultado = await componerConLLM(titular);
    if (resultado) {
      console.log("Haiku generado con LLM:", resultado.versos);
      return resultado;
    }

    // Fallback algorítmico
    console.log("Usando motor algorítmico");
    return componerAlgoritmico(titular);
  }

  return {
    componerHaiku,
    componerAlgoritmico,
    limpiarPalabra,
    DESCARTABLES
  };

})();
