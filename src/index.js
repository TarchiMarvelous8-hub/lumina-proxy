// Cloudflare Worker — Lumina AI's Gemini proxy
//
// Same job as netlify/functions/chat.mjs: keeps the real Gemini API key on
// the server, never shipped to the browser. Moved here specifically because
// Cloudflare Workers only bill/limit *CPU time* (actual code execution) —
// not the time spent waiting on an external API. A slow, search-grounded
// Gemini request that mostly just sits there waiting doesn't get killed by
// a hard wall-clock timeout the way it could on Netlify's free tier.
//
// This runs on a different domain than lumina1ai.netlify.app, so unlike the
// old Netlify function, it needs to explicitly allow cross-origin requests
// from the site (see ALLOWED_ORIGIN below) — the browser would otherwise
// silently block the response.

const ALLOWED_ORIGIN = 'https://lumina1ai.netlify.app';

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Vary': 'Origin'
        }
      });
    }

    if (request.method !== 'POST') {
      return withCors(new Response('Method Not Allowed', { status: 405 }));
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return withCors(Response.json(
        { error: { message: 'Worker is missing GEMINI_API_KEY. Set it in Cloudflare -> Workers & Pages -> this Worker -> Settings -> Variables and Secrets, then redeploy.' } },
        { status: 500 }
      ));
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return withCors(Response.json({ error: { message: 'Invalid request body.' } }, { status: 400 }));
    }

    const model = body.model || 'gemini-3.1-flash-lite';

    let upstream;
    try {
      upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            system_instruction: body.system_instruction,
            contents: body.contents,
            tools: body.tools
          })
        }
      );
    } catch (err) {
      return withCors(Response.json({ error: { message: 'Could not reach Gemini from the server.' } }, { status: 502 }));
    }

    const data = await upstream.text();
    return withCors(new Response(data, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' }
    }));
  }
};
