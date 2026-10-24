/** Shared fetch helpers for the SPA. */

/** Parse a JSON response; non-2xx responses throw an Error carrying the status. */
export async function readJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw httpError(502, 'El servidor devolvió una respuesta inesperada.');
  }
  if (!response.ok) throw httpError(response.status, body?.error || 'La petición falló.');
  return body;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
