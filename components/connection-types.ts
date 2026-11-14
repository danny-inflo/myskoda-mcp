export type ControlMode = "readOnly" | "all" | "custom";
export type ControlChoices = { ventilation: boolean; charging: boolean; airConditioning: boolean; auxiliaryHeating: boolean };
export type ConnectionStatus = {
  connected: boolean;
  setupCompleted?: boolean;
  connectionRevision?: string;
  vin?: string;
  keyExpiresAt?: string | null;
  keyExpired?: boolean | null;
  controls?: { ventilationEnabled: boolean; chargingEnabled?: boolean; airConditioningEnabled?: boolean; auxiliaryHeatingEnabled?: boolean; auxiliaryHeatingSpinConfigured?: boolean };
  api?: { lastReportedRemaining: number | null; limit: number | null; observedAt: string | null; resetAt: string | null; blockedUntil: string | null } | null;
};
