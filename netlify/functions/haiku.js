/**
 * netlify/functions/haiku.js — Serverless proxy para la API de xAI (Grok)
 *
 * Netlify Function que recibe el POST del browser, agrega la API key
 * (guardada como variable de entorno en Netlify), y reenvía a xAI.
 *
 * La API key se configura en Netlify:
 *   Site settings → Environment variables → Add → XAI_API_KEY
 */

const XAI_API_URL = "https://api.x.ai/v1/chat/completions";

export default async (request) => {
  // CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Solo POST" }), { status: 405, headers });
  }

  const apiKey = Netlify.env.get("XAI_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "XAI_API_KEY no configurada" }),
      { status: 500, headers }
    );
  }

  try {
    const body = await request.text();

    const resp = await fetch(XAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: body
    });

    const respBody = await resp.text();
    return new Response(respBody, { status: resp.status, headers });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 502, headers }
    );
  }
};
