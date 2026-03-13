/**
 * refresh.mjs — Función scheduled de Netlify (cada 12 horas)
 *
 * Busca titulares apocalípticos vía RSS, genera haikus con Groq/Llama,
 * y almacena los pares {titular, versos} en Netlify Blobs.
 * El cliente consume este caché vía cache.mjs sin tocar la API de Groq.
 *
 * Se ejecuta automáticamente con cron "0 12 * * *" (cada 12h).
 * También se puede invocar manualmente via POST /.netlify/functions/refresh
 */

import { getStore } from "@netlify/blobs";

// ── RSS ──

const RSS2JSON = "https://api.rss2json.com/v1/api.json?rss_url=";

const FEEDS = [
  "https://feeds.bbci.co.uk/mundo/rss.xml",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/internacional/portada",
  "https://rss.dw.com/xml/rss-sp-all"
];

const PALABRAS_NEGATIVAS = [
  "guerra", "muerte", "muertos", "crisis", "catástrofe", "desastre",
  "terremoto", "inundación", "incendio", "explosión", "ataque",
  "bombardeo", "víctimas", "tragedia", "conflicto", "destrucción",
  "pandemia", "emergencia", "colapso", "hambre", "sequía",
  "huracán", "tornado", "tsunami", "erupción", "accidente",
  "violencia", "masacre", "genocidio", "refugiados", "éxodo",
  "caos", "alarma", "pánico", "amenaza", "peligro",
  "contaminación", "extinción", "apocalipsis", "devastación",
  "derrumbe", "naufragio", "disparo", "asesinato", "invasión",
  "bomba", "misil", "nuclear", "radiación", "tóxico",
  "pobreza", "desempleo", "inflación", "recesión", "quiebra",
  "muere", "mata", "hiere", "sufre", "destruye", "arrasa",
  "derrota", "fracasa", "cae", "pierde", "arde", "explota"
];

// ── Groq ──

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const LLM_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `Eres Matsuo Bashō reencarnado, escribiendo en español. Tu arte: recibir un titular de noticias —violento, apocalíptico, desolador— y destilarlo en un haiku que revele lo sagrado escondido en la catástrofe.

POÉTICA:
- El haiku no consuela ni moraliza. Observa. Encuentra el instante de belleza dentro del horror, como una flor en un campo de batalla.
- Prefiere lo concreto a lo abstracto: una imagen precisa vale más que un sentimiento nombrado. No digas "esperanza", muestra el brote verde entre las cenizas.
- Usa la naturaleza como espejo: estaciones, agua, luz, animales, viento. El mundo natural comenta la tragedia humana sin juzgarla.
- Busca el "kireji" (corte): que entre el segundo y tercer verso haya un giro, un salto, una sorpresa silenciosa.
- Cada palabra debe pesar. Elimina todo lo que sobre.

MÉTRICA ESTRICTA:
- Exactamente 3 versos: 5 sílabas / 7 sílabas / 5 sílabas (conteo silábico español).
- Cuenta con cuidado los diptongos (cie-lo = 2 sílabas) y los hiatos (rí-o = 2 sílabas).

RESTRICCIONES:
- Intenta reutilizar palabras o fragmentos del titular cuando sea posible, transformando su carga negativa en otra cosa. Pero la calidad poética es más importante que la reutilización.
- Usa SOLO palabras que existan en el diccionario de la RAE. No inventes palabras. No uses neologismos. Cada palabra debe ser una palabra real del español.

FORMATO:
- Responde SOLO con los 3 versos, uno por línea.
- Sin puntuación al final de los versos. Sin comillas. Sin título. Sin explicación.
- Todo en minúsculas.`;

// ── Cantidad de items a generar por refresco ──

// Cantidad de haikus a generar en cada refresco: 12 titulares apocalípticos
// Cantidad elegida para balancear: suficientes para variedad sin exceder cuota gratuita de Groq
// (límite típico: 25 req/min en tier gratuito, esta función tarda ~15-20 segundos)
const ITEMS_POR_REFRESH = 12;

// ── Funciones auxiliares ──

/**
 * puntuarTitular — puntaje "apocalíptico" basado en palabras negativas
 */
function puntuarTitular(titular) {
  const t = titular.toLowerCase();
  let puntaje = 0;
  for (const palabra of PALABRAS_NEGATIVAS) {
    if (t.includes(palabra)) puntaje++;
  }
  puntaje += Math.min(t.split(" ").length / 10, 1);
  return puntaje;
}

/**
 * obtenerTitulares — busca titulares de todos los feeds RSS
 */
async function obtenerTitulares() {
  let todos = [];

  const promesas = FEEDS.map(async (feed) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const url = RSS2JSON + encodeURIComponent(feed);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await resp.json();
      if (data.status === "ok" && data.items) {
        return data.items.map(item => item.title);
      }
    } catch (e) {
      console.log("Feed falló:", feed, e.message);
    }
    return [];
  });

  const resultados = await Promise.all(promesas);
  for (const titulares of resultados) {
    todos = todos.concat(titulares);
  }

  return todos;
}

/**
 * seleccionarMejores — puntúa y selecciona los N titulares más apocalípticos
 */
function seleccionarMejores(titulares, n) {
  const puntuados = titulares.map(t => ({
    texto: t,
    puntaje: puntuarTitular(t)
  }));
  puntuados.sort((a, b) => b.puntaje - a.puntaje);

  // Tomar los mejores, evitando duplicados muy similares
  const seleccionados = [];
  const vistos = new Set();

  for (const item of puntuados) {
    if (seleccionados.length >= n) break;
    // Evitar titulares casi idénticos (primeras 40 chars)
    const clave = item.texto.toLowerCase().substring(0, 40);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    seleccionados.push(item.texto);
  }

  return seleccionados;
}

/**
 * validarHaiku — validación estructural ligera
 */
function validarHaiku(versos) {
  for (const verso of versos) {
    if (verso.trim().length < 2) return false;
    if (/[0-9@#$%^&*=+{}[\]|\\<>]/.test(verso)) return false;
    if (/^(aquí|este|nota|verso|haiku|línea|sílaba)/i.test(verso.trim())) return false;
  }
  return true;
}

/**
 * generarHaiku — llama a Groq para generar un haiku a partir de un titular
 * 
 * Recibe: titular de noticia (string)
 * Devuelve: array de 3 versos [verso1, verso2, verso3] o null si falla
 * 
 * Usado por: refresh.mjs en el handler principal (secuencialmente, con delay entre llamadas)
 */
async function generarHaiku(titular, apiKey) {
  try {
    // Enviar solicitud a Groq/Llama con el SYSTEM_PROMPT que define el estilo poético
    const resp = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: titular }
        ],
        model: LLM_MODEL,
        stream: false,
        temperature: 0.9  // Temperatura alta para más creatividad poética
      })
    });

    if (!resp.ok) {
      console.log("Groq respondió", resp.status, "para:", titular.substring(0, 50));
      return null;
    }

    const data = await resp.json();
    const texto = data.choices[0].message.content.trim();
    // Limpiar asteriscos (markdown bold) que Groq a veces agrega
    const textoLimpio = texto.replace(/\*\*/g, "").replace(/\*/g, "");
    const lineas = textoLimpio.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    // Extraer los 3 primeros versos (ignora explicaciones que Groq pueda agregar después)
    if (lineas.length >= 3) {
      const versos = [lineas[0], lineas[1], lineas[2]];
      if (validarHaiku(versos)) {
        return versos;
      }
    }

    console.log("Formato inesperado para:", titular.substring(0, 50));
    return null;

  } catch (e) {
    console.log("Error generando haiku:", e.message);
    return null;
  }
}

// ── Handler principal ──

/**
 * Handler de refresh.mjs
 * 
 * Propósito: Tarea scheduled que se ejecuta cada 3 horas automáticamente
 * (también puede invocarse manualmente vía POST a /.netlify/functions/refresh)
 * 
 * Flujo general:
 *   1. Obtener titulares de todos los feeds RSS
 *   2. Seleccionar los N titulares más apocalípticos (basado en palabras clave)
 *   3. Para cada titular: generar un haiku llamando a Groq (secuencial, con pausa)
 *   4. Almacenar todos los pares {titular, versos} en Netlify Blobs
 */
export default async (req) => {
  const apiKey = Netlify.env.get("GROQ_API_KEY");
  if (!apiKey) {
    console.log("GROQ_API_KEY no configurada");
    return new Response(JSON.stringify({ error: "API key no configurada" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  console.log("Iniciando refresco de caché...");

  // PASO 1: Obtener titulares de todos los feeds RSS
  // Realiza 3 solicitudes en paralelo (una por feed), con timeout de 10 segundos cada una
  // Devuelve un array con todos los titulares encontrados
  const titulares = await obtenerTitulares();
  if (titulares.length === 0) {
    console.log("No se obtuvieron titulares de ningún feed");
    return new Response(JSON.stringify({ error: "Sin titulares" }), {
      status: 502,
      headers: { "Content-Type": "application/json" }
    });
  }

  console.log(`Obtenidos ${titulares.length} titulares de RSS`);

  // PASO 2: Seleccionar los titulares más apocalípticos
  // Puntúa cada titular según la presencia de palabras negativas (PALABRAS_NEGATIVAS)
  // Toma los N=ITEMS_POR_REFRESH más altos, evitando duplicados muy similares
  const mejores = seleccionarMejores(titulares, ITEMS_POR_REFRESH);
  console.log(`Seleccionados ${mejores.length} titulares para generar haikus`);

  // PASO 3: Generar haiku para cada titular (SECUENCIAL, no paralelo)
  // Esto es importante: se hace uno por uno para respetar el límite de rate limiting de Groq
  // (típicamente 25 req/min en tier gratuito)
  const items = [];

  for (const titular of mejores) {
    const versos = await generarHaiku(titular, apiKey);
    if (versos) {
      items.push({ titular, versos });
      console.log(`OK: "${titular.substring(0, 40)}..." → ${versos.join(" / ")}`);
    } else {
      console.log(`SKIP: "${titular.substring(0, 40)}..."`);
    }

    // PAUSA DE 800ms ENTRE LLAMADAS A GROQ
    // Respeta el rate limiting: 800ms * 12 items ≈ 10 segundos de generación
    // Deja margen para que refresh.mjs no exceda cuota gratuita
    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`Generados ${items.length} haikus exitosamente`);

  // PASO 4: Guardar en Netlify Blobs (almacenamiento persistente de Netlify)
  // getStore("haiku-cache") obtiene el namespace de caché específico de esta aplicación
  // setJSON("current", ...) guarda el objeto JSON bajo la clave "current"
  // Otros endpoints (cache.mjs) leen de esta misma clave
  const store = getStore("haiku-cache");
  const cacheData = {
    items,
    refreshedAt: Date.now(),
    refreshedAtISO: new Date().toISOString(),
    totalTitulares: titulares.length,
    totalGenerados: items.length
  };

  await store.setJSON("current", cacheData);
  console.log("Caché guardado en Netlify Blobs");

  return new Response(JSON.stringify({
    ok: true,
    generados: items.length,
    refreshedAt: cacheData.refreshedAtISO
  }), {
    headers: { "Content-Type": "application/json" }
  });
};

// Configuración de ejecución scheduled para Netlify Functions
// schedule: expresión cron estándar de 5 campos: "minuto hora día_mes mes día_semana"
// "0 */6 * * *" = A la hora exacta (minuto 0), cada 6 horas, todos los días
//   → Ejecuta a: 00:00, 06:00, 12:00, 18:00 UTC
// Esto genera 4 refrescos/día, cada uno tarda ~10-20 segundos
// Se puede invocar manualmente vía POST /.netlify/functions/refresh (no necesita cron)
export const config = {
  schedule: "0 */6 * * *"
};
