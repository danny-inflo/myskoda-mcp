import { setControlPermission, type ControlScope } from "../../../lib/vehicle-service";
import { VehicleError } from "../../../lib/skoda-core.mjs";
import { PRIVATE_HEADERS, boundedJson, errorResponse, requireSameOrigin, userFromRequest } from "../../../lib/http";
export const dynamic = "force-dynamic";
// Settings only; this route never dispatches a vehicle operation.
export async function POST(request: Request) {
  try {
    const userId = userFromRequest(request);
    requireSameOrigin(request);
    const body = await boundedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new VehicleError("INVALID_PERMISSION_INPUT", "Neplatné nastavení.");
    const { scope, ...input } = body;
    return Response.json(await setControlPermission(userId, scope as ControlScope, input), { headers: PRIVATE_HEADERS });
  } catch (error) { return errorResponse(error); }
}
