import { setControlProfile } from "../../../lib/vehicle-service";
import { PRIVATE_HEADERS, boundedJson, errorResponse, requireSameOrigin, userFromRequest } from "../../../lib/http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const userId = userFromRequest(request);
    requireSameOrigin(request);
    return Response.json(await setControlProfile(userId, await boundedJson(request)), { headers: PRIVATE_HEADERS });
  } catch (error) { return errorResponse(error); }
}
