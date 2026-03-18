/**
 * refresh.mjs — Función scheduled de Netlify (cada 6 horas)
 *
 * Busca titulares con interés poético vía RSS (noticias, ciencia, cultura),
 * genera haikus con Groq/Llama usando una voz amereidiana,
 * y almacena los pares {titular, versos} en Netlify Blobs.
 * El cliente consume este caché vía cache.mjs sin tocar la API de Groq.
 *
 * Se ejecuta automáticamente con cron cada 6h.
 * También se puede invocar manualmente via POST /.netlify/functions/refresh
 */

import { getStore } from "@netlify/blobs";

// ── RSS ──

const RSS2JSON = "https://api.rss2json.com/v1/api.json?rss_url=";

const FEEDS = [
  "https://feeds.bbci.co.uk/mundo/rss.xml",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/internacional/portada",
  "https://rss.dw.com/xml/rss-sp-all",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/ciencia/portada",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/cultura/portada",
  "https://feeds.bbci.co.uk/mundo/temas/ciencia/rss.xml"
];

// Palabras que indican titulares con sustancia poética.
// Organizadas desde las preocupaciones de Amereida: mar y travesía,
// territorio americano, lo desconocido que irrumpe, cielo y orientación,
// cuerpo y lengua, materia concreta, lo vivo, origen y herencia.
const PALABRAS_POETICAS = [
  // mar y travesía — el mar interior, la navegación, el paso
  "mar", "océano", "archipiélago", "isla", "puerto", "barco", "naufragio",
  "estrecho", "cabo", "navegación", "marejada", "oleaje", "deriva",
  // territorio americano — el continente como regalo
  "río", "selva", "cordillera", "volcán", "glaciar", "desierto",
  "pampa", "montaña", "bosque", "estepa", "altiplano", "cuenca",
  "amazonas", "valle", "patagonia", "quebrada", "caribe",
  // travesía y movimiento — cruzar, no conquistar
  "frontera", "transumante", "éxodo", "refugiados", "exilio",
  "expedición", "ruta", "travesía", "caravana", "peregrinación",
  // lo desconocido que irrumpe — hallazgo, no descubrimiento
  "descubren", "hallazgo", "desconocido", "misterio", "enigma", "aventura",
  "secreto", "revela", "inédito", "nóvel", "inesperado",
  // cielo y estrellas — la cruz del sur, orientarse
  "estrella", "constelación", "satélite", "telescopio", "elíptica",
  "órbita", "eclipse", "cometa", "galaxia", "luna", "cuásar", "nave",
  // cuerpo y lengua — lo humano concreto
  "cuerpo", "sangre", "hueso", "nosotros", "lengua", "palabra",
  "pueblo", "escuela", "voz", "habla", "gesto", "gira",
  // tierra y materia — lo concreto pesa
  "tierra", "piedra", "agua", "fuego", "hierro", "sal", "suelo", "arenas",
  "riquezas", "metales", "hojarazca", "barro", "ceniza",
  // lo vivo — la naturaleza es ella misma
  "especie", "lengua", "árbol", "brotación", "ballena", "cuerpo",
  "selva", "pelágico", "raíz", "floración", "bandada",
  // origen y herencia — ruinas, lo que permanece
  "cuchitril", "templo", "dibujo", "letra", "cifra",
  "manuscrito", "excavación", "croquis", "interior",
  // la herida y el don — conflicto que desvela
  "épica", "muerte", "abertura", "hambre", "desnudo",
  "telúrico", "inundación", "incendio", "acontecer", "perpetuo"
];

// ── Groq ──

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const LLM_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `Eres una voz poética americana, heredera de Amereida. Tu arte: recibir un titular de noticias y cruzarlo —travesía— hasta desvelar lo que en él se regala sin ser visto. No consolar. No moralizar. No embellecer. Abrir.

POÉTICA AMEREIDIANA:
- Cada titular guarda un don escondido: encuéntralo. No "belleza dentro del horror" —eso es cliché. Busca lo que irrumpe: lo desconocido que aparece cuando las palabras se abren.
- Prefiere lo concreto y americano: guijarro en nieve, toro negro contra pasto, flamencos sobre azogue, barcaza entre espumas, ríos que desaparecen en sus médanos, cobre partido, huemul entre quilas.
- La naturaleza es ella misma: autónoma, indiferente, presente. No es espejo de lo humano.
- Busca el corte entre versos: una abertura, algo inesperado. Que un verso abra lo que el anterior no prometía.
- Cada palabra debe pesar. La carencia es riqueza. Lo que no se dice sostiene lo dicho.

VOCABULARIO PROHIBIDO: arena, viento, sombra, ceniza, esperanza, horizonte, aurora, amanecer, ocaso, alba, crepúsculo, destello, suspiro, murmullo, eco, alma, latido, brote, silencio, oscuridad, luz (como metáfora), camino, sendero, huella.

FORMA — VERSO AMEREIDIANO:
- Entre 3 y 5 versos cortos. No siempre el mismo número.
- Cada verso: MÁXIMO 4 palabras. Muchos versos tendrán solo 2 o 3.
- Verso libre. Sin rima. Sin patrón fijo.
- Busca que la extensión total no supere 20 palabras.

RESTRICCIÓN DE LETRAS:
- Intenta que las letras del verso provengan del titular. Reutiliza las letras disponibles.
- Puedes agregar muy pocas letras nuevas (máximo 3 que no estén en el titular).
- Esto no es un anagrama: puedes reordenar y elegir, pero con economía.

FORMATO:
- SOLO los versos, uno por línea.
- Sin puntuación final. Sin comillas. Sin título. Sin explicación.
- Todo en minúsculas.`;

/**
 * agregarBlancos — inserta espacios extra entre algunas palabras
 * para crear la respiración tipográfica amereidiana.
 * No todos los versos llevan blancos; ~40% de las separaciones se amplían.
 */
function agregarBlancos(verso) {
  const palabras = verso.split(/\s+/);
  if (palabras.length <= 1) return verso;
  return palabras.map((p, i) => {
    if (i === palabras.length - 1) return p;
    const blanco = Math.random() < 0.4
      ? " ".repeat(3 + Math.floor(Math.random() * 3))  // 3-5 espacios
      : " ";
    return p + blanco;
  }).join("");
}

// ── Cantidad de items a generar por refresco ──

// Generar 6 haikus por refresco (~6s, cabe en el timeout de 10s de Netlify)
// Se acumulan en un pool rotativo de 24, descartando los más antiguos
const ITEMS_POR_REFRESH = 6;
const MAX_POOL = 24;

// ── Funciones auxiliares ──

/**
 * puntuarTitular — puntaje de "interés poético" basado en palabras con sustancia
 */
function puntuarTitular(titular) {
  const t = titular.toLowerCase();
  let puntaje = 0;
  for (const palabra of PALABRAS_POETICAS) {
    if (t.includes(palabra)) puntaje++;
  }
  // Bonus por largo (titulares más largos suelen tener más contenido concreto)
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
 * seleccionarMejores — puntúa y selecciona los N titulares con mayor interés poético
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
  if (versos.length < 3 || versos.length > 5) return false;
  for (const verso of versos) {
    if (verso.trim().length < 2) return false;
    if (/[0-9@#$%^&*=+{}[\]|\\<>]/.test(verso)) return false;
    if (/^(aquí|este|nota|verso|haiku|línea|sílaba)/i.test(verso.trim())) return false;
    // Máximo 4 palabras por verso
    if (verso.trim().split(/\s+/).length > 6) return false;
  }
  return true;
}

/**
 * contarComodines — cuenta cuántas letras del verso NO están disponibles
 * en el titular. Simula el matching letra-a-letra de sketch.js.
 */
function contarComodines(titular, versos) {
  const disponibles = titular.toLowerCase().replace(/\s/g, "").split("");
  const usadas = new Array(disponibles.length).fill(false);
  let comodines = 0;

  for (const verso of versos) {
    for (const ch of verso) {
      if (ch === " ") continue;
      let encontrada = false;
      for (let i = 0; i < disponibles.length; i++) {
        if (!usadas[i] && disponibles[i] === ch.toLowerCase()) {
          usadas[i] = true;
          encontrada = true;
          break;
        }
      }
      if (!encontrada) comodines++;
    }
  }
  return comodines;
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

    // Extraer entre 3 y 5 versos (ignora explicaciones que Groq pueda agregar después)
    if (lineas.length >= 3) {
      const versos = lineas.slice(0, Math.min(lineas.length, 5));
      if (validarHaiku(versos)) {
        const comodines = contarComodines(titular, versos);
        if (comodines > 3) {
          console.log(`Demasiados comodines (${comodines}) para: ${titular.substring(0, 50)}`);
          return null;
        }
        // Agregar blancos amereidianos (espacios tipográficos)
        return versos.map(agregarBlancos);
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

  // PASO 2: Seleccionar los titulares con mayor interés poético
  // Puntúa cada titular según la presencia de palabras con sustancia (PALABRAS_POETICAS)
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

  console.log(`Generados ${items.length} haikus nuevos`);

  // PASO 4: Leer caché existente y acumular (pool rotativo de MAX_POOL)
  const store = getStore("haiku-cache");
  let poolAnterior = [];
  try {
    const raw = await store.get("current");
    if (raw) {
      const anterior = JSON.parse(raw);
      poolAnterior = anterior.items || [];
    }
  } catch (e) {
    console.log("Sin caché previo, iniciando pool nuevo");
  }

  // Agregar los nuevos al inicio, mantener máximo MAX_POOL
  const pool = [...items, ...poolAnterior].slice(0, MAX_POOL);

  const cacheData = {
    items: pool,
    refreshedAt: Date.now(),
    refreshedAtISO: new Date().toISOString(),
    totalTitulares: titulares.length,
    totalGenerados: items.length,
    totalEnPool: pool.length
  };

  await store.set("current", JSON.stringify(cacheData));
  console.log(`Pool: ${items.length} nuevos + ${poolAnterior.length} previos = ${pool.length} total`);

  return new Response(JSON.stringify({
    ok: true,
    nuevos: items.length,
    enPool: pool.length,
    refreshedAt: cacheData.refreshedAtISO
  }), {
    headers: { "Content-Type": "application/json" }
  });
};

// Cada 6 horas: 00:00, 06:00, 12:00, 18:00 UTC
export const config = {
  schedule: "0 */6 * * *"
};
