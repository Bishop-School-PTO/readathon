// Helpers shared by the Worker's routes (checkout.js, donation.js).

export const CODE_RE = /^[A-Z0-9]{4,12}$/; // student donation codes, same check as donation.get

/** CORS headers when the request comes from an allowed origin, otherwise null. */
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !list(env.ALLOWED_ORIGINS).includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function list(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
