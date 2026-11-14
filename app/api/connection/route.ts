import { connectVehicle, disconnectVehicle, getConnectionStatus } from "../../../lib/vehicle-service";
import { PRIVATE_HEADERS, boundedJson, errorResponse, requireSameOrigin, userFromRequest } from "../../../lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return Response.json(await getConnectionStatus(userFromRequest(request)), { headers: PRIVATE_HEADERS }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const userId = userFromRequest(request);
    requireSameOrigin(request);
    return Response.json(await connectVehicle(userId, await boundedJson(request)), { headers: PRIVATE_HEADERS });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    const userId = userFromRequest(request);
    requireSameOrigin(request);
    return Response.json(await disconnectVehicle(userId), { headers: PRIVATE_HEADERS });
  } catch (error) { return errorResponse(error); }
}
