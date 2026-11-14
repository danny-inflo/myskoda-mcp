"use client";
import { useState } from "react";
import {useI18n} from "./language-provider";
import { Layout, LayoutContent, LayoutFooter, VStack, HStack } from "@astryxdesign/core/Layout";
import { Text, Heading } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Divider } from "@astryxdesign/core/Divider";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { CONTROL_CHOICES, choicesFromControls, modeFromChoices } from "../lib/control-profile.mjs";
import { HeatingSpinSettings } from "./heating-spin-settings";
import type { ConnectionStatus } from "./connection-types";
import { ConnectionSkeleton } from "./connection-skeleton";

const modeLabels = { readOnly: "Jen čtení", all: "Vše", custom: "Vlastní" };
export function ConnectionManagement({ status, busy, onRenew, onReplace, onPermissions, onDisconnect, onSaveSpin }: {
  status: ConnectionStatus; busy: boolean; onRenew: () => void; onReplace: () => void; onPermissions: () => void;
  onDisconnect: () => void; onSaveSpin: (spin: string | null) => Promise<void>;
}) {
  const {t,date:formatDate} = useI18n();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const choices = choicesFromControls(status.controls);
  if (busy) return <ConnectionSkeleton />;
  return <VStack gap={4}>
    <VStack gap={1} hAlign="center"><Heading level={2}>{t("manageTitle")}</Heading><Text color="secondary" justify="center">{t("connectedHelp")}</Text></VStack>
    {status.keyExpired && <Banner status="warning" title={t("keyExpired")} description={t("keyExpiredHelp")} />}
    <VStack gap={3}>
      <Heading level={3}>{t("connectedVehicle")}</Heading>
      <Text type="code">{status.vin}</Text>
      <Text type="supporting">{status.keyExpiresAt ? t("validUntil", {date:formatDate(status.keyExpiresAt)}) : t("expiryUnknown")}</Text>
      <HStack gap={2} wrap="wrap"><Button label={t("renew")} onClick={onRenew} isDisabled={busy} /><Button label={t("change")} variant="ghost" onClick={onReplace} isDisabled={busy} /></HStack>
    </VStack>
    <Divider />
    <VStack gap={3}>
      <Heading level={3}>{t("permissions")}</Heading>
      <Text>{t("accessSummary", {mode:t(modeLabels[modeFromChoices(choices)])})}</Text>
      <MetadataList label={{ position: "start" }}>
        {CONTROL_CHOICES.map(({ scope, title }) => <MetadataListItem key={scope} label={t(title)}><Text>{choices[scope] ? t("allowed") : t("disabled")}</Text></MetadataListItem>)}
      </MetadataList>
      <Text type="supporting">{t("accessHelp")}</Text>
      <Button label={t("edit")} onClick={onPermissions} isDisabled={busy} />
    </VStack>
    <Divider />
    {(status.controls?.auxiliaryHeatingEnabled || status.controls?.auxiliaryHeatingSpinConfigured) && <Collapsible trigger={t("heatingPin")} defaultIsOpen={false}><HeatingSpinSettings key={status.connectionRevision} configured={status.controls?.auxiliaryHeatingSpinConfigured === true} busy={busy} onSave={onSaveSpin} /></Collapsible>}
    <Button label={t("disconnect")} variant="ghost" isDisabled={busy} onClick={() => setConfirmDisconnect(true)} />
    <Dialog isOpen={confirmDisconnect} onOpenChange={setConfirmDisconnect} purpose="form" width={480} padding={6}>
      <Layout
        header={<DialogHeader title={t("disconnectTitle")} onOpenChange={setConfirmDisconnect} />}
        content={<LayoutContent><Text color="secondary">{t("disconnectHelp")}</Text></LayoutContent>}
        footer={<LayoutFooter><HStack gap={2} hAlign="end" wrap="wrap"><Button label={t("cancel")} variant="ghost" onClick={() => setConfirmDisconnect(false)} isDisabled={busy} /><Button label={t("disconnect")} variant="destructive" onClick={onDisconnect} isDisabled={busy} /></HStack></LayoutFooter>}
      />
    </Dialog>
  </VStack>;
}
