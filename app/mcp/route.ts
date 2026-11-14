import { dispatchMcp } from "../../lib/mcp";
import { executeVehicleCommand, getConnectionStatus, readVehicle } from "../../lib/vehicle-service";
import { PRIVATE_HEADERS, boundedJson } from "../../lib/http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return new Response(null, { status: 415, headers: PRIVATE_HEADERS });
  let input;
  try { input = await boundedJson(request); }
  catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: PRIVATE_HEADERS }); }
  const result = await dispatchMcp(input, request.headers.get("oai-authenticated-user-id"), { status: getConnectionStatus, read: readVehicle, execute: executeVehicleCommand });
  return result === null ? new Response(null, { status: 202, headers: PRIVATE_HEADERS }) : Response.json(result, { headers: PRIVATE_HEADERS });
}
export async function GET() { return new Response(null, { status: 405, headers: { ...PRIVATE_HEADERS, Allow: "POST" } }); }
