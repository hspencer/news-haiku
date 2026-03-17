/**
 * cache.mjs — Endpoint GET que sirve el caché de haikus al cliente
 *
 * Lee los items almacenados en Netlify Blobs por refresh.mjs
 * y los devuelve como JSON. El cliente (sketch.js) los consume
 * para rotar entre titulares+haikus sin llamar a Groq en cada ciclo.
 *
 * Respuesta: { items: [{titular, versos}, ...], refreshedAt, ... }
 * Si el caché está vacío o hay error, devuelve { items: [] }.
 */

import { getStore } from "@netlify/blobs";

/**
 * Handler principal de cache.mjs
 * 
 * Propósito: Endpoint GET que sirve los haikus precalculados (caché)
 * El cliente (sketch.js) consulta esta función cada X segundos para obtener
 * titulares+haikus sin llamar a Groq, reduciendo latencia y uso de cuota
 * 
 * Respuesta: JSON con estructura {items: [...], refreshedAt, ...}
 * Usado por: Cliente en sketch.js (GET /.netlify/functions/cache)
 */
export default async (req) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    // CACHE-CONTROL: estrategia de caché multinivel
    // "public": puede cachearse en intermediarios (Netlify CDN, navegadores)
    // "s-maxage=1800": CDN mantiene copia por 30 minutos (1800 segundos)
    //   → Aunque refresh.mjs actualiza cada 3h, esto reduce requests innecesarias
    // "max-age=300": navegador mantiene copia por 5 minutos (300 segundos)
    //   → Da tiempo a que el usuario vea haikus sin hacer refetch constante
    "Cache-Control": "public, s-maxage=1800, max-age=300"
  };

  // Manejo del preflight CORS: necesario para solicitudes cross-origin desde el navegador
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    // Leer del almacenamiento Netlify Blobs (la misma key "current" que escribe refresh.mjs)
    const store = getStore("haiku-cache");
    const raw = await store.get("current");
    const data = raw ? JSON.parse(raw) : null;

    // FALLBACK A CACHÉ VACÍO (degradación elegante)
    // Si el caché no existe aún (primera vez) o está vacío, retornar array vacío
    // El cliente detectará items.length === 0 y activará fallback a haiku.js (proxy real-time)
    if (!data || !data.items || data.items.length === 0) {
      return new Response(JSON.stringify({ items: [], refreshedAt: null }), { headers });
    }

    // Éxito: devolver el caché completo con metadata
    return new Response(JSON.stringify(data), { headers });

  } catch (e) {
    // ERROR HANDLING: devolver 200 + array vacío (NO 500)
    // Razón: queremos que el cliente maneje esto como fallback, no como error fatal
    // El cliente esperará status 200 y chequeará items.length === 0
    // Si devolviéramos 500, el cliente interpretaría como error de servidor
    console.log("Error leyendo caché:", e.message);
    return new Response(JSON.stringify({ items: [], error: e.message }), {
      status: 200, // Siempre 200 para permitir fallback graceful en el cliente
      headers
    });
  }
};
