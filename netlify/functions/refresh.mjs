/**
 * refresh.mjs — Función scheduled de Netlify (cada 6 horas)
 *
 * Busca titulares internacionales de crisis y conflicto vía RSS,
 * genera versos amereidianos con Groq/Llama (poemas independientes
 * de la noticia, que usan las letras del titular como materia prima),
 * y almacena los pares {titular, versos} en Netlify Blobs.
 *
 * Se ejecuta con cron cada 6h.
 * También se puede invocar manualmente via GET /.netlify/functions/trigger-refresh
 */

import { getStore } from "@netlify/blobs";

// ── RSS ──

const RSS2JSON = "https://api.rss2json.com/v1/api.json?rss_url=";

const FEEDS = [
  "https://feeds.bbci.co.uk/mundo/rss.xml",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/internacional/portada",
  "https://rss.dw.com/xml/rss-sp-all",
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/america/portada"
];

// Palabras para filtrar titulares de crisis, conflicto y geopolítica.
// El titular es solo materia prima tipográfica — las letras del poema.
const PALABRAS_FILTRO = [
  // conflicto y guerra
  "guerra", "ataque", "bombardeo", "misil", "nuclear", "militar",
  "combate", "ofensiva", "defensa", "armas", "tropas", "ejército",
  "conflicto", "tensión", "amenaza", "represalia", "escalada",
  // geopolítica EEUU-Irán y Medio Oriente
  "irán", "iran", "eeuu", "trump", "teherán", "tehran", "ormuz",
  "golfo", "pérsico", "sanciones", "embargo", "petróleo", "crudo",
  "estrecho", "hormuz", "oriente", "medio", "siria", "irak", "yemen",
  "hezbolá", "hezbollah", "hamás", "hamas", "gaza", "israel",
  // crisis y emergencia
  "crisis", "emergencia", "refugiados", "éxodo", "desplazados",
  "muerte", "muertos", "víctimas", "civil", "civiles", "humanitaria",
  // energía y recursos
  "energía", "gas", "oleoducto", "opep", "barril", "precio",
  "suministro", "bloqueo", "ruta", "marítima", "buque", "tanquero",
  // diplomacia y poder
  "negociación", "acuerdo", "tratado", "otan", "onu", "consejo",
  "seguridad", "alianza", "coalición", "veto", "diplomacia"
];

// ── Groq ──

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const LLM_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `Eres un poeta amereidiano. Amereida es el poema épico de América que no se funda en la conquista sino en el regalo, la travesía y la abertura al continente desconocido.

TU TAREA:
Recibes un titular de noticias. NO escribas sobre la noticia. El titular es solo una reserva de letras.
Tu poema es completamente independiente: trata sobre el territorio americano, el mar, los materiales, los animales, la travesía, el oficio, el cuerpo. Nunca sobre política, guerra ni actualidad.

REGLA FUNDAMENTAL:
NO copies palabras del titular. Si el titular dice "Trump", "guerra", "Irán", "ataque", "misil", "OTAN", "crisis", "militar", "petróleo", "bloqueo", "sanciones" — NINGUNA de esas palabras puede aparecer en tu poema. El poema debe ser de otro mundo.

POÉTICA:
- Solo lo concreto. Nombra cosas que se pueden tocar, ver, oler: cobre, greda, quilas, huemul, azogue, barcaza, espuma, laja, totora, loica, congrio, caleta, estero, liquen, basalto, glaciar, guanaco.
- La naturaleza no es metáfora. Un río es un río, no la tristeza que fluye.
- El corte entre versos abre algo inesperado. Que el tercer verso lleve a donde nadie esperaba.
- Cada palabra justifica su peso. Si se puede quitar sin perder, quítala.

VOCABULARIO PROHIBIDO (nunca usar):
arena, viento, sombra, ceniza, esperanza, horizonte, aurora, amanecer, ocaso, alba, crepúsculo, destello, suspiro, murmullo, eco, alma, latido, brote, silencio, oscuridad, camino, sendero, huella, tiempo, eterno, infinito, destino, sueño, abismo, luz, noche, día, mar (solo como "mar", sí puedes usar "marejada", "marea"), paz, guerra, dolor, fuego, sangre.

EJEMPLOS del tono que busco (NO copiar, solo para entender el registro):
- "la greda se parte en el horno / tres pájaros cruzan el estero / la sal entra por la herida"
- "cobre sin pulir sobre la mesa / un congrio abierto en la caleta / los cerros guardan cuarzo"
- "totoras en el borde del lago / el guanaco mira sin moverse / liquen sobre basalto negro"

FORMA:
- Exactamente 3 versos.
- Cada verso: entre 4 y 7 palabras, con sentido sintáctico (frase nominal, sujeto-verbo, etc.).
- Total: entre 14 y 20 palabras.
- Sin rima. Sin métrica fija.

FORMATO:
- SOLO 3 versos, uno por línea.
- Sin puntuación. Sin comillas. Sin título. Sin explicación.
- Todo en minúsculas.`;

/**
 * limpiarVerso — normaliza espacios y elimina puntuación residual
 */
function limpiarVerso(verso) {
  return verso.trim()
    .replace(/[.,;:!?¡¿"""''—–\-]/g, "")  // quitar puntuación
    .replace(/\s+/g, " ")                    // normalizar espacios
    .toLowerCase();
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
  for (const palabra of PALABRAS_FILTRO) {
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
 * validarVerso — validación estructural: 3 versos, 2-8 palabras c/u
 */
function validarVerso(versos) {
  if (versos.length !== 3) return false;
  for (const verso of versos) {
    const limpio = verso.trim();
    if (limpio.length < 4) return false;
    if (/[0-9@#$%^&*=+{}[\]|\\<>]/.test(limpio)) return false;
    if (/^(aquí|este|nota|verso|haiku|línea|sílaba|poema)/i.test(limpio)) return false;
    const palabras = limpio.split(/\s+/).length;
    if (palabras < 2 || palabras > 8) return false;
  }
  const totalPalabras = versos.reduce((s, v) => s + v.trim().split(/\s+/).length, 0);
  if (totalPalabras < 8 || totalPalabras > 22) return false;
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

    // Extraer exactamente 3 versos (ignora explicaciones que Groq pueda agregar después)
    if (lineas.length >= 3) {
      const versos = lineas.slice(0, 3);
      if (validarVerso(versos)) {
        const comodines = contarComodines(titular, versos);
        if (comodines > 12) {
          console.log(`Demasiados comodines (${comodines}) para: ${titular.substring(0, 50)}`);
          return null;
        }
        return versos.map(limpiarVerso);
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
