// Routing depends only on authenticated, server-persisted metadata. Never infer
// completion from cookies, a visit counter, or whether any controls are enabled.
export function initialConnectionView(status) {
  if (!status) return "loading";
  if (!status.connected) return "setup-auto";
  return status.setupCompleted === true ? "manage" : "setup-permissions";
}
