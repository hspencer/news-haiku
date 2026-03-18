/**
 * trigger-refresh.mjs — Invoca el refresh manualmente via HTTP
 *
 * GET o POST a /.netlify/functions/trigger-refresh
 * Ejecuta la misma lógica que refresh.mjs (scheduled)
 * pero como función HTTP normal, invocable desde el navegador.
 */

import { getStore } from "@netlify/blobs";

const RSS2JSON = "https://api.rss2json.com/v1/api.json?rss_url=";

const FEEDS = [
  "https://feeds.bbci.co.uk/mundo/rss.xml",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/internacional/portada",
  "https://rss.dw.com/xml/rss-sp-all",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/ciencia/portada",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/cultura/portada",
  "https://feeds.bbci.co.uk/mundo/temas/ciencia/rss.xml"
];

const PALABRAS_POETICAS = [
  "mar", "océano", "archipiélago", "isla", "puerto", "barco", "naufragio",
  "estrecho", "cabo", "navegación", "marejada", "oleaje", "deriva",
  "río", "selva", "cordillera", "volcán", "glaciar", "desierto",
  "pampa", "montaña", "bosque", "estepa", "altiplano", "cuenca",
  "amazonas", "valle", "patagonia", "quebrada", "caribe",
  "frontera", "transumante", "éxodo", "refugiados", "exilio",
  "expedición", "ruta", "travesía", "caravana", "peregrinación",
  "descubren", "hallazgo", "desconocido", "misterio", "enigma", "aventura",
  "secreto", "revela", "inédito", "nóvel", "inesperado",
  "estrella", "constelación", "satélite", "telescopio", "elíptica",
  "órbita", "eclipse", "cometa", "galaxia", "luna", "cuásar", "nave",
  "cuerpo", "sangre", "hueso", "nosotros", "lengua", "palabra",
  "pueblo", "escuela", "voz", "habla", "gesto", "gira",
  "tierra", "piedra", "agua", "fuego", "hierro", "sal", "suelo", "arenas",
  "riquezas", "metales", "hojarazca", "barro", "ceniza",
  "especie", "lengua", "árbol", "brotación", "ballena", "cuerpo",
  "selva", "pelágico", "raíz", "floración", "bandada",
  "cuchitril", "templo", "dibujo", "letra", "cifra",
  "manuscrito", "excavación", "croquis", "interior",
  "épica", "muerte", "abertura", "hambre", "desnudo",
  "telúrico", "inundación", "incendio", "acontecer", "perpetuo"
];

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const LLM_MODEL = "llama-3.3-70b-versatile";
const ITEMS_POR_REFRESH = 6;
const MAX_POOL = 24;

// Importar el mismo prompt desde refresh.mjs no es posible en Netlify Functions,
// así que lo duplicamos aquí
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

function puntuarTitular(titular) {
  const t = titular.toLowerCase();
  let puntaje = 0;
  for (const palabra of PALABRAS_POETICAS) {
    if (t.includes(palabra)) puntaje++;
  }
  puntaje += Math.min(t.split(" ").length / 10, 1);
  return puntaje;
}

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
  for (const titulares of resultados) todos = todos.concat(titulares);
  return todos;
}

function seleccionarMejores(titulares, n) {
  const puntuados = titulares.map(t => ({ texto: t, puntaje: puntuarTitular(t) }));
  puntuados.sort((a, b) => b.puntaje - a.puntaje);
  const seleccionados = [];
  const vistos = new Set();
  for (const item of puntuados) {
    if (seleccionados.length >= n) break;
    const clave = item.texto.toLowerCase().substring(0, 40);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    seleccionados.push(item.texto);
  }
  return seleccionados;
}

function validarHaiku(versos) {
  for (const verso of versos) {
    if (verso.trim().length < 2) return false;
    if (/[0-9@#$%^&*=+{}[\]|\\<>]/.test(verso)) return false;
    if (/^(aquí|este|nota|verso|haiku|línea|sílaba)/i.test(verso.trim())) return false;
  }
  return true;
}

async function generarHaiku(titular, apiKey) {
  try {
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
        temperature: 0.9
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const texto = data.choices[0].message.content.trim();
    const textoLimpio = texto.replace(/\*\*/g, "").replace(/\*/g, "");
    const lineas = textoLimpio.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lineas.length >= 3) {
      const versos = [lineas[0], lineas[1], lineas[2]];
      if (validarHaiku(versos)) return versos;
    }
    return null;
  } catch (e) {
    return null;
  }
}

export default async (req) => {
  const apiKey = Netlify.env.get("GROQ_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key no configurada" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  const titulares = await obtenerTitulares();
  if (titulares.length === 0) {
    return new Response(JSON.stringify({ error: "Sin titulares" }), {
      status: 502, headers: { "Content-Type": "application/json" }
    });
  }

  const mejores = seleccionarMejores(titulares, ITEMS_POR_REFRESH);
  const items = [];

  for (const titular of mejores) {
    const versos = await generarHaiku(titular, apiKey);
    if (versos) items.push({ titular, versos });
    await new Promise(r => setTimeout(r, 800));
  }

  // Pool rotativo: agregar nuevos al inicio, mantener máximo MAX_POOL
  const store = getStore("haiku-cache");
  let poolAnterior = [];
  try {
    const raw = await store.get("current");
    if (raw) {
      const anterior = JSON.parse(raw);
      poolAnterior = anterior.items || [];
    }
  } catch (e) {}

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

  return new Response(JSON.stringify({
    ok: true,
    nuevos: items.length,
    enPool: pool.length,
    refreshedAt: cacheData.refreshedAtISO
  }), {
    headers: { "Content-Type": "application/json" }
  });
};
