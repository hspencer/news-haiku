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

const SYSTEM_PROMPT = `Eres una voz poética americana. Tu arte: recibir un titular de noticias y cruzarlo —travesía— hasta desvelar lo que en él se regala sin ser visto. No consolar. No moralizar. Desvelar.

POÉTICA:
- Cada titular guarda un don escondido: encuéntralo. No busques belleza "dentro del horror" —eso es un cliché. Busca lo que irrumpe: lo desconocido que aparece cuando las palabras se abren.
- Prefiere lo concreto y lo americano: un guijarro en nieve, el toro negro contra el pasto, flamencos sobre azogue, la barcaza entre espumas, el petróleo que emigra, ríos que desaparecen en sus médanos. Nada de "arenas", "sombras" ni "vientos" genéricos.
- No uses la naturaleza como espejo de lo humano. Que la naturaleza sea ella misma: autónoma, indiferente, presente.
- Busca el corte: que entre el segundo y tercer verso haya un salto, una abertura, algo que no se esperaba. Como dice Amereida: "la señal verdadera miente como el día / para salvar de otros usos / la noche regalada".
- Cada palabra debe pesar. Elimina todo lo que sobre. La carencia es riqueza.
- VOCABULARIO PROHIBIDO: no uses estas palabras gastadas: arena, viento, sombra, ceniza, brote, esperanza, horizonte, aurora, amanecer, ocaso, alba, crepúsculo, destello, suspiro, murmullo, eco, alma, latido. Busca palabras más precisas, más concretas, más inesperadas.

MÉTRICA LIBRE:
- Verso libre, con blancos intermedios que se leen como silencios
- Cuenta con cuidado los diptongos (cie-lo = 2 sílabas) y los hiatos (rí-o = 2 sílabas) para que los versos sean musicales.

RESTRICCIONES:
- Transforma palabras del titular cuando puedas, pero la calidad poética manda.
- Usa SOLO palabras reales del español (diccionario RAE). No inventes.

FORMATO:
- SOLO los 3 versos, uno por línea.
- Sin puntuación final. Sin comillas. Sin título. Sin explicación.
- Todo en minúsculas.`;

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

  await store.setJSON("current", cacheData);
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

// Configuración de ejecución scheduled para Netlify Functions
// schedule: expresión cron estándar de 5 campos: "minuto hora día_mes mes día_semana"
// "0 */6 * * *" = A la hora exacta (minuto 0), cada 6 horas, todos los días
//   → Ejecuta a: 00:00, 06:00, 12:00, 18:00 UTC
// Esto genera 4 refrescos/día, cada uno tarda ~10-20 segundos
// Se puede invocar manualmente vía POST /.netlify/functions/refresh (no necesita cron)
export const config = {
  schedule: "0 */6 * * *"
};
