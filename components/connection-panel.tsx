"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {useI18n} from "./language-provider";
import { VStack } from "@astryxdesign/core/Layout";
import { Text, Heading } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Banner } from "@astryxdesign/core/Banner";
import { Icon } from "@astryxdesign/core/Icon";
import {errorMessageKey} from "../lib/i18n/catalog.mjs";
import { CONTROL_CHOICES, choicesFromControls, modeFromChoices } from "../lib/control-profile.mjs";
import { ConnectionFrame } from "./connection-frame";
import { ConnectionManagement } from "./connection-management";
import { VehicleConnectionForm } from "./vehicle-connection-form";
import { ConnectionSkeleton } from "./connection-skeleton";
import { PermissionProfileForm } from "./permission-profile-form";
import { ControlConsentDialog } from "./control-consent-dialog";
import { initialConnectionView } from "./connection-view.mjs";
import type { ConnectionStatus, ControlChoices, ControlMode } from "./connection-types";

type View = "loading" | "error" | "setup-auto" | "setup-permissions" | "complete" | "manage" | "permissions" | "renew" | "replace";
type PermissionSave = { mode: ControlMode; permissions: ControlChoices; connectionRevision: string; heatingSpinConfigured: boolean };
class ConnectionUiError extends Error {
  constructor(message: string, public retryAfter: number | null = null) { super(message); }
}
async function parseStatus(response: Response): Promise<ConnectionStatus> {
  const body = await response.json() as Partial<ConnectionStatus> & { error?: { message?: string; code?: string; retryAfterSeconds?: number } };
  if (!response.ok) throw new ConnectionUiError(errorMessageKey(body.error?.code, response.status), body.error?.retryAfterSeconds ?? null);
  if (typeof body.connected !== "boolean" || (body.connected && typeof body.setupCompleted !== "boolean")) throw new ConnectionUiError("Připojení nelze načíst. Zkuste to znovu.");
  return body as ConnectionStatus;
}
const emptyChoices = () => choicesFromControls(null) as ControlChoices;
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Authentication is a separate server-rendered screen. This controller only
// fetches local metadata; provider requests happen after submitting a key form.
export function ConnectionPanel({ accountId, signOutUrl }: { accountId: string; signOutUrl: string }) {
  const {t} = useI18n();
  const [view, setView] = useState<View>("loading");
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retryUntil, setRetryUntil] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [mode, setMode] = useState<ControlMode>("readOnly");
  const [permissions, setPermissions] = useState<ControlChoices>(emptyChoices);
  const [pendingPermissionSave, setPendingPermissionSave] = useState<PermissionSave | null>(null);
  const permissionSaveInFlight = useRef(false);

  function choosePermissions(value: ConnectionStatus) {
    const selected = choicesFromControls(value.controls) as ControlChoices;
    setPermissions(selected); setMode(modeFromChoices(selected)); setPendingPermissionSave(null);
  }
  function applyStatus(value: ConnectionStatus) {
    setStatus(value); choosePermissions(value); setView(initialConnectionView(value));
  }
  function reportError(error: unknown) {
    setError(error instanceof Error ? error.message : "Požadavek se nepodařil.");
    if (error instanceof ConnectionUiError && error.retryAfter && error.retryAfter > 0) setRetryUntil(Date.now() + error.retryAfter * 1000);
  }
  function navigate(next: View) {
    if (busy) return;
    if (next === "permissions" && status) choosePermissions(status);
    setView(next); setError(""); setNotice(""); setPendingPermissionSave(null);
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/connection", { signal: controller.signal, cache: "no-store" }).then(parseStatus).then(value => {
      if (controller.signal.aborted) return;
      const selected = choicesFromControls(value.controls) as ControlChoices;
      setStatus(value); setPermissions(selected); setMode(modeFromChoices(selected)); setView(initialConnectionView(value));
    }).catch(error => { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : "Připojení nelze načíst."); setView("error"); } });
    return () => controller.abort();
  }, [accountId]);
  useEffect(() => {
    if (!retryUntil) { setRetrySeconds(0); return; }
    const update = () => { const remaining = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000)); setRetrySeconds(remaining); if (!remaining) setRetryUntil(0); };
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [retryUntil]); // Local countdown only; no automatic network retries.

  async function refreshConnection() {
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); setView("loading");
    try { applyStatus(await parseStatus(await fetch("/api/connection", { cache: "no-store" }))); }
    catch (error) { reportError(error); setView("error"); } finally { setBusy(false); }
  }
  async function connect(value: { vin?: string; apiKey: string }) {
    if (busy || retrySeconds > 0) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const renewal = view === "renew";
      const result = await parseStatus(await fetch(renewal ? "/api/connection-key" : "/api/connection", json(renewal ? { apiKey: value.apiKey, connectionRevision: status?.connectionRevision } : value)));
      applyStatus(result);
      if (renewal) setNotice("Nový klíč je uložený. Ovládání je vypnuté a uložený S-PIN byl smazán. Oprávnění můžete znovu nastavit.");
    } catch (error) { reportError(error); } finally { setBusy(false); }
  }
  async function savePermissions(event: FormEvent<HTMLElement>) {
    event.preventDefault();
    if (busy || permissionSaveInFlight.current || !status?.connectionRevision) return;
    const enabled = mode === "all" || (mode === "custom" && Object.values(permissions).some(Boolean));
    if (enabled && status.keyExpired) return;
    // Freeze exactly what the user is about to approve, including its connection.
    const selection = { mode, permissions: { ...permissions }, connectionRevision: status.connectionRevision, heatingSpinConfigured: status.controls?.auxiliaryHeatingSpinConfigured === true };
    if (enabled) setPendingPermissionSave(selection);
    else await persistPermissions(selection, false);
  }
  async function persistPermissions(selection: PermissionSave, confirmed: boolean, spin?: string) {
    const enabled = selection.mode === "all" || (selection.mode === "custom" && Object.values(selection.permissions).some(Boolean));
    if (busy || permissionSaveInFlight.current || (enabled && !confirmed)) return;
    if (status?.connectionRevision !== selection.connectionRevision || (enabled && status.keyExpired)) {
      setPendingPermissionSave(null); reportError(new ConnectionUiError("Připojení se změnilo. Obnovte stránku nastavení.")); return;
    }
    permissionSaveInFlight.current = true;
    setPendingPermissionSave(null);
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await parseStatus(await fetch("/api/control-profile", json({ mode: selection.mode, connectionRevision: selection.connectionRevision, ...(selection.mode === "custom" ? { permissions: selection.permissions } : {}), ...(enabled ? { acknowledgement: "ALLOW_SELECTED_VEHICLE_CONTROLS" } : {}), ...(spin === undefined ? {} : { spin }) })));
      setStatus(result); choosePermissions(result); setView(view === "setup-permissions" ? "complete" : "manage");
      setNotice("Oprávnění jsou uložená. Žádný příkaz na vozidlo jsme neodeslali.");
    } catch (error) { reportError(error); } finally { permissionSaveInFlight.current = false; setBusy(false); }
  }
  async function disconnect() {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      applyStatus(await parseStatus(await fetch("/api/connection", { method: "DELETE", headers: { "Content-Type": "application/json" } })));
      setNotice("Připojení a uložená data vozidla byla smazána.");
    } catch (error) { reportError(error); } finally { setBusy(false); }
  }
  async function saveSpin(spin: string | null) {
    if (busy || !status?.connectionRevision) return;
    setBusy(true); setError(""); setNotice("");
    try {
      setStatus(await parseStatus(await fetch("/api/heating-spin", json({ spin, connectionRevision: status.connectionRevision }))));
      setNotice(spin === null ? "S-PIN byl smazán." : "S-PIN byl uložen zašifrovaný. Žádný příkaz na vozidlo jsme neodeslali.");
    } catch (error) { reportError(error); } finally { setBusy(false); }
  }
  return <ConnectionFrame signOutUrl={signOutUrl}>
    {error && <VStack gap={2} role="alert"><Banner status="error" title={t("requestFailed")} description={t(error)} />{retrySeconds > 0 && <Text type="supporting" hasTabularNumbers>{t("retryCountdown", {seconds:retrySeconds})}</Text>}</VStack>}
    {notice && <VStack role="status"><Banner status="success" title={t(notice)} /></VStack>}
    {view === "loading" && <ConnectionSkeleton />}
    {view === "error" && <VStack gap={3}><Heading level={2}>{t("connectionFailed")}</Heading><Text color="secondary">{t("retryHelp")}</Text><Button label={t("retry")} onClick={refreshConnection} isDisabled={busy} /></VStack>}
    {(view === "setup-auto" || view === "replace" || view === "renew") && <VehicleConnectionForm key={view} renewal={view === "renew"} replacing={view === "replace"} maskedVin={status?.vin} busy={busy} retrySeconds={retrySeconds} onSave={connect} onCancel={status?.connected ? () => navigate(initialConnectionView(status)) : undefined} />}
    {(view === "setup-permissions" || view === "permissions") && <VStack gap={4}>
      {!busy && <VStack gap={1} hAlign="center"><Heading level={2}>{view === "permissions" ? t("editPermissions") : t("firstPermissions")}</Heading><Text color="secondary" justify="center">{t("permissionsIntro")}</Text></VStack>}
      <PermissionProfileForm mode={mode} permissions={permissions} busy={busy} keyExpired={!!status?.keyExpired} submitLabel={view === "permissions" ? t("save") : t("finish")} onModeChange={next => { setMode(next); setPendingPermissionSave(null); if (next !== "custom") setPermissions(Object.fromEntries(CONTROL_CHOICES.map(({ scope }) => [scope, next === "all"])) as ControlChoices); }} onPermissionsChange={value => { setPermissions(value); setPendingPermissionSave(null); }} onSubmit={savePermissions} />
      {!busy && (view === "permissions" ? <Button label={t("back")} variant="ghost" onClick={() => navigate("manage")} /> : <Button label={status?.keyExpired ? t("renew") : t("change")} variant="ghost" onClick={() => navigate(status?.keyExpired ? "renew" : "replace")} />)}
    </VStack>}
    {view === "complete" && <VStack gap={4}>
      <VStack gap={2} hAlign="center"><Icon icon="check" size="lg" /><Heading level={2}>{t("ready")}</Heading><Text color="secondary" justify="center">{t("readyHelp")}</Text></VStack>
      <Card variant="muted" padding={4}><Text>{t("example")}</Text></Card>
      <Button label={t("manage")} variant="primary" size="lg" onClick={() => navigate("manage")} />
    </VStack>}
    {view === "manage" && status?.connected && <ConnectionManagement status={status} busy={busy} onRenew={() => navigate("renew")} onReplace={() => navigate("replace")} onPermissions={() => navigate("permissions")} onDisconnect={disconnect} onSaveSpin={saveSpin} />}
    <ControlConsentDialog isOpen={pendingPermissionSave !== null} functions={pendingPermissionSave ? CONTROL_CHOICES.filter(({ scope }) => pendingPermissionSave.mode === "all" || pendingPermissionSave.permissions[scope as keyof ControlChoices]).map(({ title }) => title) : []} requiresHeating={pendingPermissionSave?.mode === "all" || pendingPermissionSave?.permissions.auxiliaryHeating === true} heatingSpinConfigured={pendingPermissionSave?.heatingSpinConfigured === true} onBack={() => setPendingPermissionSave(null)} onConfirm={spin => { if (pendingPermissionSave) void persistPermissions(pendingPermissionSave, true, spin); }} />
  </ConnectionFrame>;
}
