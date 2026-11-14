import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { transformSync } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Theme } from "@astryxdesign/core/theme";
import { vehicleConnectTheme } from "../app/astryx/vehicle-connect.js";
import { controlProfileInput, choicesFromControls, modeFromChoices } from "../lib/control-profile.mjs";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("./") && context.parentURL?.includes("/components/") && !/\.[a-z]+$/.test(specifier)) {
    for (const extension of [".tsx", ".ts"]) if (existsSync(new URL(specifier + extension, context.parentURL))) return next(specifier + extension, context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (/\/components\/.*\.tsx$/.test(url)) return { format: "module", shortCircuit: true, source: transformSync(readFileSync(new URL(url), "utf8"), { loader: "tsx", format: "esm", jsx: "automatic" }).code };
  return next(url, context);
} });
const { PermissionProfileForm } = await import("../components/permission-profile-form.tsx");
const { ControlConsentDialog } = await import("../components/control-consent-dialog.tsx");
const { ConnectionPanel } = await import("../components/connection-panel.tsx");
const { SignInCard } = await import("../components/sign-in-card.tsx");
const { ConnectionManagement } = await import("../components/connection-management.tsx");
const { VehicleConnectionForm } = await import("../components/vehicle-connection-form.tsx");
const { ApiKeyHelpContent } = await import("../components/api-key-help-dialog.tsx");
const { initialConnectionView } = await import("../components/connection-view.mjs");
const { HeatingSpinSettings } = await import("../components/heating-spin-settings.tsx");
const render = component => renderToStaticMarkup(createElement(Theme, { theme: vehicleConnectTheme, mode: "light" }, component));
const props = { mode: "readOnly", permissions: choicesFromControls(null), busy: false, keyExpired: false, onModeChange() {}, onPermissionsChange() {}, onSubmit() {} };
const permission = overrides => render(createElement(PermissionProfileForm, { ...props, ...overrides }));

test("Astryx onboarding first step uses OpenAI sign-in without collecting credentials and displays its independent mark", () => {
  const html = render(createElement(SignInCard, { signInUrl: "/signin-with-chatgpt?return_to=%2F", signOutUrl: "/signout-with-chatgpt" }));
  assert(!html.includes("astryx-stepper")); assert.match(html, /astryx-card/);
  assert.match(html, /Přihlásit/); assert.match(html, /target="_top"/);
  assert(!html.includes("<input")); assert(!html.includes("skoda-logo")); assert.match(html, /vehicle-connect-mark\.png/);
  assert(!html.includes("Tvoje auto. Tvůj ChatGPT."));
});
test("read-only profile defaults to a single selected radio and no control acknowledgement", () => {
  const html = permission();
  assert.equal((html.match(/type="radio"/g) ?? []).length, 3);
  assert.equal((html.match(/checked=""/g) ?? []).length, 1);
  assert(!html.includes('type="checkbox"')); assert.match(html, /Jen čtení/); assert.match(html, /Vše/); assert.match(html, /Vlastní/);
  assert(!html.match(/<button[^>]*(?:disabled|aria-disabled="true")/));
});
test("all and custom modes keep scope selection without an inline consent checkbox; expired grants stay blocked", () => {
  const all = permission({ mode: "all" }); assert(!all.includes('type="checkbox"')); assert(!all.match(/<button[^>]*(?:disabled|aria-disabled="true")/));
  const expired = permission({ mode: "all", keyExpired: true }); assert.match(expired, /Nejprve obnovte API klíč/); assert.match(expired, /<button[^>]*(?:disabled|aria-disabled="true")/);
  const revoke = permission({ keyExpired: true }); assert(!revoke.match(/<button[^>]*(?:disabled|aria-disabled="true")/));
  const custom = permission({ mode: "custom", permissions: { ventilation: true, charging: false, airConditioning: false, auxiliaryHeating: false } });
  assert.equal((custom.match(/type="checkbox"/g) ?? []).length, 4);
  for (const label of ["Ventilace", "Nabíjení", "Klimatizace", "Přídavné topení"]) assert(custom.includes(label));
});
test("saved mode is derived exactly from all four existing flags", () => {
  assert.equal(modeFromChoices(choicesFromControls(null)), "readOnly");
  assert.equal(modeFromChoices(choicesFromControls({ ventilationEnabled: true })), "custom");
  assert.equal(modeFromChoices(choicesFromControls({ ventilationEnabled: true, chargingEnabled: true, airConditioningEnabled: true, auxiliaryHeatingEnabled: true })), "all");
  assert.equal(controlProfileInput({ mode: "readOnly", connectionRevision: "fixture" }).enabled, false);
});
test("Astryx S-PIN form never reveals saved values and begins empty", () => {
  const html = render(createElement(HeatingSpinSettings, { configured: true, busy: false, onSave() {} }));
  assert.match(html, /type="password"/); assert.match(html, /value=""/); assert.match(html, /autoComplete="new-password"/);
  assert.match(html, /Jeho hodnotu nikdy nezobrazujeme/); assert.match(html, /Smazat/);
  assert(!html.includes("Spustit")); assert(!html.includes("Zastavit"));
});

test("authenticated first render is neutral, never a login or setup flash", () => {
  const html = render(createElement(ConnectionPanel, { accountId: "synthetic-user", signOutUrl: "/signout-with-chatgpt" }));
  assert.match(html, /astryx-skeleton/); assert.match(html, /aria-busy="true"/); assert(!html.includes("Načítám připojení"));
  assert(!html.includes("astryx-stepper")); assert(!html.includes("<input"));
  assert(!html.includes("Přihlásit")); assert(!html.includes("Připoj své auto"));
});
test("persisted completion distinguishes returning read-only users and interrupted setup", () => {
  assert.equal(initialConnectionView(null), "loading");
  assert.equal(initialConnectionView({ connected: false }), "setup-auto");
  assert.equal(initialConnectionView({ connected: true, setupCompleted: false }), "setup-permissions");
  assert.equal(initialConnectionView({ connected: true, setupCompleted: true, controls: choicesFromControls(null) }), "manage");
  assert.equal(initialConnectionView({ connected: true, setupCompleted: true, keyExpired: true }), "manage");
});
const managementProps = { status: { connected: true, setupCompleted: true, vin: "•••••••••••999999", controls: { ventilationEnabled: true } }, busy: false, onRenew() {}, onReplace() {}, onPermissions() {}, onDisconnect() {}, async onSaveSpin() {} };
test("connection management has no wizard or editable credentials and shows all saved groups", () => {
  const html = render(createElement(ConnectionManagement, managementProps));
  assert.match(html, /Správa připojení/); assert.match(html, /Rozsah přístupu: Vlastní/);
  assert(!html.includes("astryx-stepper")); assert(!html.includes("<input")); assert(!html.includes("<form"));
  assert(!html.includes("Můžeš se začít ptát")); assert(!html.includes("Připojení je připravené"));
  for (const label of ["Obnovit", "Změnit", "Upravit", "Ventilace", "Nabíjení", "Klimatizace", "Přídavné topení", "Povoleno", "Vypnuto"]) assert(html.includes(label));
  const expired = render(createElement(ConnectionManagement, { ...managementProps, status: { ...managementProps.status, keyExpired: true } }));
  assert.match(expired, /API klíč expiroval/); assert.match(expired, /Správa připojení/); assert(!expired.includes("<input"));
});
test("renewal asks only for a new blank key; replacement asks for VIN and a key", () => {
  const props = { busy: false, retrySeconds: 0, async onSave() {}, onCancel() {} };
  const renew = render(createElement(VehicleConnectionForm, { ...props, renewal: true, maskedVin: "•••••••••••999999" }));
  assert.equal((renew.match(/<input/g) ?? []).length, 1); assert.match(renew, /Nový API klíč/); assert.match(renew, /type="password"/); assert.match(renew, /value=""/);
  assert(!renew.includes("vehicle-vin")); assert(!renew.includes("astryx-stepper")); assert.match(renew, /Pokud ověření selže, zachováme původní klíč/);
  const replace = render(createElement(VehicleConnectionForm, { ...props, replacing: true }));
  assert.equal((replace.match(/<input/g) ?? []).length, 2); assert.match(replace, /VIN vozidla/); assert.match(replace, /Zpět/);
});
test("standalone permission editor has its own submit label and no stepper", () => {
  const edit = permission({ submitLabel: "Uložit oprávnění" }); assert.match(edit, /Uložit oprávnění/); assert(!edit.includes("Uložit a dokončit")); assert(!edit.includes("astryx-stepper"));
});

test("initial vehicle form keeps credentials private and opens help through a non-submit button", () => {
  const html = render(createElement(VehicleConnectionForm, { busy: false, retrySeconds: 0, async onSave() {} }));
  assert.match(html, /Připojte své vozidlo k ChatGPT\./);
  assert(!html.includes("Zadej VIN a vlastní API klíč"));
  assert(!html.includes("Ovládání zůstane vypnuté. Rozsah přístupu"));
  assert(!html.includes("Získat klíč v MyŠkoda"));
  assert(!html.includes("Zobrazit klíč")); assert(!html.includes("Skrýt klíč"));
  assert.match(html, /<button[^>]*type="button"[^>]*>[\s\S]*?Nápověda/);
  assert.match(html, /type="password"/); assert.match(html, /value=""/);
  assert(!html.slice(0, html.indexOf("</form>")).includes("go.skoda.eu/api-keys")); // Outbound links belong to help, not the credential form.
});
test("API key help includes official management/download/docs links and a local accessible QR", () => {
  const html = render(createElement(ApiKeyHelpContent));
  for (const url of ["https://go.skoda.eu/api-keys", "https://go.skoda.eu/myskoda", "https://public.api.connect.skoda-auto.cz/docs"]) assert(html.includes(`href="${url}"`));
  assert.match(html, /Spravovat/); assert.match(html, /Používáte telefon/); assert.match(html, /na počítači/);
  assert.match(html, /src="\/api-keys-qr\.svg"/); assert.match(html, /alt="QR kód pro správu API klíčů v aplikaci MyŠkoda"/);
  assert(!html.includes("<iframe")); assert(!html.includes("<form")); assert(!html.includes("<input"));
});


test("pending reads, verification and settings show only accessible skeletons, preventing repeated actions", () => {
  const pending = [
    permission({ busy: true, mode: "all" }),
    render(createElement(VehicleConnectionForm, { busy: true, retrySeconds: 0, async onSave() {} })),
    render(createElement(ConnectionManagement, { ...managementProps, busy: true })),
    render(createElement(HeatingSpinSettings, { configured: true, busy: true, async onSave() {} })),
  ];
  for (const html of pending) {
    assert.match(html, /astryx-skeleton/); assert.match(html, /role="status"/); assert.match(html, /aria-busy="true"/);
    assert(!html.includes("<input")); assert(!html.includes("<button")); assert(!html.includes("astryx-spinner"));
    assert(!/Načítám|Ukládám|Ověřuji/.test(html));
  }
});
test("permission form delegates explicit consent to the modal without restoring removed paragraphs", () => {
  const html = permission({ mode: "all" });
  assert(!html.includes("Výslovně povoluji vybrané skupiny ovládání"));
  assert(!html.includes("Dostupnost funkcí určuje")); assert(!html.includes("Tento výběr oprávnění u poskytovatele"));
  assert(!html.includes("V klientu ponech režim")); assert(!html.includes("Uložení tohoto nastavení"));
});


test("consent dialog names only the selected controls and provides explicit confirm and back actions", () => {
  const html = render(createElement(ControlConsentDialog, { isOpen: true, functions: ["Ventilace", "Klimatizace"], onBack() {}, onConfirm() {} }));
  assert.match(html, /Potvrzení ovládání/); assert.match(html, /Souhlasím, aby ChatGPT na můj výslovný požadavek/);
  assert.match(html, /Ventilace/); assert.match(html, /Klimatizace/);
  assert(!html.includes("Nabíjení")); assert(!html.includes("Přídavné topení"));
  assert.match(html, /Zpět/); assert.match(html, /Potvrdit/);
  assert(!html.includes("<input")); assert.match(html, /Důležité upozornění/);
});


test("heating consent requires a blank masked PIN unless the connection already has one", () => {
  const base = { isOpen: true, functions: ["Přídavné topení"], requiresHeating: true, onBack() {}, onConfirm() {} };
  const fresh = render(createElement(ControlConsentDialog, base));
  assert.match(fresh, /S-PIN z MyŠkoda/); assert.match(fresh, /type="password"/); assert.match(fresh, /value=""/);
  assert.match(fresh, /(?:aria-required="true"|required="")/); assert.match(fresh, /<button[^>]*(?:disabled|aria-disabled="true")/);
  const stored = render(createElement(ControlConsentDialog, { ...base, heatingSpinConfigured: true }));
  assert(!stored.includes("<input")); assert.match(stored, /S-PIN pro toto připojení již máte uložený/); assert.match(stored, /Změnit/);
  assert(!stored.match(/<button[^>]*(?:disabled|aria-disabled="true")/));
  const ventilation = render(createElement(ControlConsentDialog, { ...base, functions: ["Ventilace"], requiresHeating: false }));
  assert(!ventilation.includes("S-PIN")); assert(!ventilation.includes("<input"));
});

const {LanguageProvider}=await import('../components/language-provider.tsx');
const {LANGUAGES}=await import('../lib/i18n/locale.mjs');
const {messages}=await import('../lib/i18n/catalog.mjs');
const escapeHtml=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll("'",'&#x27;').replaceAll('<','&lt;').replaceAll('>','&gt;');
test('all 18 languages render login, forms, permissions, consent, help and settings without Czech fallback',()=>{
 for(const {code} of LANGUAGES){
  const localized=element=>render(createElement(LanguageProvider,{initialLocale:code,initialPreference:code},element));
  const dictionary=messages[code];
  const login=localized(createElement(SignInCard,{signInUrl:'#'}));assert(login.includes(escapeHtml(dictionary.signInTitle)),code);assert(login.includes('vehicle-connect-mark.png'));assert(login.includes('Language'));
  const form=localized(createElement(VehicleConnectionForm,{busy:false,retrySeconds:0,async onSave(){}}));assert(form.includes(escapeHtml(dictionary.connectTitle)),code);assert(form.includes(escapeHtml(dictionary.vinHelp)),code);assert(form.includes(escapeHtml(dictionary.required)),code);
  const permission=localized(createElement(PermissionProfileForm,{...props,mode:'custom',permissions:{ventilation:true,charging:true,airConditioning:false,auxiliaryHeating:false}}));assert(permission.includes(escapeHtml(dictionary.ventilationHelp)),code);assert(permission.includes(escapeHtml(dictionary.charging)),code);
  const consent=localized(createElement(ControlConsentDialog,{isOpen:true,functions:['Ventilace'],onBack(){},onConfirm(){}}));assert(consent.includes(escapeHtml(dictionary.controlWarning)),code);assert(consent.includes(escapeHtml(dictionary.ventilation)),code);assert(consent.includes(escapeHtml(dictionary.close)),code);
  const help=localized(createElement(ApiKeyHelpContent));assert(help.includes(escapeHtml(dictionary.qrHelp)),code);
  const spin=localized(createElement(HeatingSpinSettings,{configured:true,busy:false,async onSave(){}}));assert(spin.includes(escapeHtml(dictionary.pinStored)),code);
 }
});
