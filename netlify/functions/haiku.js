/**
 * netlify/functions/haiku.js — Serverless proxy para la API de Groq
 *
 * Netlify Function que recibe el POST del browser, agrega la API key
 * (guardada como variable de entorno en Netlify), y reenvía a Groq.
 *
 * La API key se configura en Netlify:
 *   Site settings → Environment variables → Add → GROQ_API_KEY
 *
 * Key gratuita en: https://console.groq.com/keys
 */

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Handler principal de la función serverless
 * 
 * Propósito: Actúa como proxy real-time que:
 *   1. Recibe POST desde el cliente (sketch.js) con un titular de noticia
 *   2. Agrega el API key de Groq (guardada en variables de entorno de Netlify)
 *   3. Reenvía la solicitud a la API de Groq/Llama para generar un haiku
 *   4. Devuelve la respuesta al cliente
 * 
 * Se usa como fallback cuando el caché (cache.mjs) está vacío o cuando
 * el cliente solicita una generación on-demand.
 * 
 * Flujo:
 *   POST /api/haiku
 *     → Validar método HTTP y headers CORS
 *     → Obtener API key de Netlify.env
 *     → Transformar body: reenviar tal cual a Groq
 *     → Retornar respuesta de Groq al cliente
 */
export default async (request) => {
  // Configuración de headers CORS: permite solicitudes desde cualquier origen
  // OPTIONS es el "preflight" que el navegador envía antes de POST
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  // Manejo del preflight CORS: el navegador necesita confirmar que el servidor
  // acepta solicitudes cross-origin antes de enviar el POST real
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Solo POST" }), { status: 405, headers });
  }

  // Recuperar la API key desde las variables de entorno de Netlify
  const apiKey = Netlify.env.get("GROQ_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GROQ_API_KEY no configurada" }),
      { status: 500, headers }
    );
  }

  try {
    // Leer el body del request: contiene el titular de noticia en formato JSON
    const body = await request.text();

    // Reenviar a la API de Groq agregando el Authorization header con la API key
    const resp = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: body
    });

    // Pasar la respuesta de Groq tal cual al cliente
    const respBody = await resp.text();
    return new Response(respBody, { status: resp.status, headers });

  } catch (err) {
    // Si hay error (timeout, red, etc.), devolver error 502 (Bad Gateway)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 502, headers }
    );
  }
};
