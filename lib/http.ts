import { VehicleError, safeError } from "./skoda-core.mjs";
export const PRIVATE_HEADERS = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
export function userFromRequest(request: Request) {
  // Sites sets these headers at its authentication boundary.
  const userId = request.headers.get("oai-authenticated-user-id");
  if (!userId) throw new VehicleError("SIGN_IN_REQUIRED", "Přihlas se účtem této integrace.", 401);
  return userId;
}
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new VehicleError("INVALID_ORIGIN", "Požadavek musí přijít ze stránky nastavení.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new VehicleError("INVALID_CONTENT_TYPE", "Požadavek musí obsahovat JSON.", 415);
}
export async function boundedJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new VehicleError("INVALID_JSON", "Chybí tělo požadavku.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) { await reader.cancel(); throw new VehicleError("PAYLOAD_TOO_LARGE", "Požadavek je příliš velký.", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof VehicleError) throw error;
    throw new VehicleError("INVALID_JSON", "Neplatný JSON.");
  }
}
export function errorResponse(error: unknown) {
  const safe = safeError(error);
  return Response.json({ error: safe }, { status: error instanceof VehicleError ? error.status : 503, headers: { ...PRIVATE_HEADERS, ...(safe.retryAfterSeconds ? { "Retry-After": String(safe.retryAfterSeconds) } : {}) } });
}
