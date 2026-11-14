import { VehicleError } from "./skoda-core.mjs";

export const CONTROL_CHOICES = [
  { scope: "ventilation", flag: "ventilationEnabled", title: "Ventilace", description: "Spuštění a zastavení aktivní ventilace." },
  { scope: "charging", flag: "chargingEnabled", title: "Nabíjení", description: "Spuštění, zastavení, limit, režim a úpravy nabíjecích profilů." },
  { scope: "airConditioning", flag: "airConditioningEnabled", title: "Klimatizace", description: "Spuštění, zastavení a nastavení požadované teploty." },
  { scope: "auxiliaryHeating", flag: "auxiliaryHeatingEnabled", title: "Přídavné topení", description: "Spuštění a zastavení topení. Spuštění navíc vyžaduje S-PIN." },
];
export function choicesFromControls(controls) {
  return Object.fromEntries(CONTROL_CHOICES.map(({ scope, flag }) => [scope, controls?.[flag] === true]));
}
export function modeFromChoices(choices) {
  const selected = CONTROL_CHOICES.filter(({ scope }) => choices?.[scope] === true).length;
  return selected === 0 ? "readOnly" : selected === CONTROL_CHOICES.length ? "all" : "custom";
}
export function controlProfileInput(input) {
  const invalid = () => new VehicleError("INVALID_PERMISSION_INPUT", "Zvolte režim a výslovně potvrďte vybraná oprávnění.");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["mode", "permissions", "connectionRevision", "acknowledgement", "spin"].includes(key)) || !["readOnly", "all", "custom"].includes(input.mode) || typeof input.connectionRevision !== "string" || !input.connectionRevision) throw invalid();
  /** @type {Record<string, boolean>} */
  const permissions = {};
  if (input.mode === "custom") {
    if (!input.permissions || typeof input.permissions !== "object" || Array.isArray(input.permissions) || Object.keys(input.permissions).length !== CONTROL_CHOICES.length || CONTROL_CHOICES.some(({ scope }) => !Object.hasOwn(input.permissions, scope) || typeof input.permissions[scope] !== "boolean")) throw invalid();
    for (const { scope } of CONTROL_CHOICES) permissions[scope] = input.permissions[scope];
  } else {
    if (Object.hasOwn(input, "permissions")) throw invalid();
    for (const { scope } of CONTROL_CHOICES) permissions[scope] = input.mode === "all";
  }
  const enabled = Object.values(permissions).some(Boolean);
  if ((enabled || Object.hasOwn(input, "acknowledgement")) && input.acknowledgement !== "ALLOW_SELECTED_VEHICLE_CONTROLS") throw invalid();
  const hasSpin = Object.hasOwn(input, "spin");
  if (hasSpin && (!permissions.auxiliaryHeating || typeof input.spin !== "string" || !/^[\x21-\x7E]{1,128}$/.test(input.spin))) throw new VehicleError("INVALID_SPIN_INPUT", "Zadejte platný S-PIN pro vybrané přídavné topení.");
  return { mode: input.mode, permissions, connectionRevision: input.connectionRevision, enabled, spin: hasSpin ? input.spin : undefined };
}
