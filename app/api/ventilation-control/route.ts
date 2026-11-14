import { setVentilationPermission } from "../../../lib/vehicle-service";
import { PRIVATE_HEADERS, boundedJson, errorResponse, requireSameOrigin, userFromRequest } from "../../../lib/http";

export const dynamic = "force-dynamic";

// This route changes permission only. It can never send a command to a vehicle.
export async function POST(request: Request) {
  try {
    const userId = userFromRequest(request);
    requireSameOrigin(request);
    return Response.json(await setVentilationPermission(userId, await boundedJson(request)), { headers: PRIVATE_HEADERS });
  } catch (error) { return errorResponse(error); }
}
