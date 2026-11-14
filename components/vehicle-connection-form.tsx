"use client";
import { useState, type FormEvent } from "react";
import {useI18n} from "./language-provider";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Text, Heading } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { ApiKeyHelpDialog } from "./api-key-help-dialog";
import { ConnectionSkeleton } from "./connection-skeleton";
import { apiKeyAttributes, vinAttributes } from "./private-input-attributes";

export function VehicleConnectionForm({ renewal = false, replacing = false, maskedVin, busy, retrySeconds, onSave, onCancel }: {
  renewal?: boolean; replacing?: boolean; maskedVin?: string; busy: boolean; retrySeconds: number;
  onSave: (value: { vin?: string; apiKey: string }) => Promise<void>; onCancel?: () => void;
}) {
  const {t} = useI18n();
  const [vin, setVin] = useState("");
  const [key, setKey] = useState("");
  const [showKeyHelp, setShowKeyHelp] = useState(false);
  const validVin = /^[A-HJ-NPR-Z0-9]{17}$/.test(vin.trim().toUpperCase());
  async function submit(event: FormEvent<HTMLElement>) {
    event.preventDefault();
    if (busy || retrySeconds > 0 || !key || (!renewal && !validVin)) return;
    try { await onSave({ ...(renewal ? {} : { vin: vin.trim().toUpperCase() }), apiKey: key }); }
    finally { setKey(""); }
  }
  if (busy) return <ConnectionSkeleton shape="vehicle" />;
  return <VStack gap={4}>
    <VStack gap={1} hAlign="center">
      <Heading level={2}>{renewal ? t("renewKeyTitle") : replacing ? t("replaceTitle") : t("connectTitle")}</Heading>
      <Text color="secondary" justify="center">{renewal ? t("renewIntro") : t("connectIntro")}</Text>
      {renewal && <Text type="code">{maskedVin}</Text>}
    </VStack>
    <VStack as="form" gap={4} onSubmit={submit} aria-label={renewal ? t("renewForm") : t("verifyForm")}>
      {!renewal && <TextInput ref={vinAttributes} label={t("vin")} description={t("vinHelp")} htmlName="vehicle-vin" value={vin} onChange={value => setVin(value.toUpperCase())} isRequired isDisabled={busy} size="lg" autoComplete="off" status={vin.length >= 17 && !validVin ? { type: "error", message: t("vinInvalid") } : undefined} />}
      <VStack gap={1}>
        <TextInput ref={apiKeyAttributes} label={renewal ? t("newApiKey") : t("apiKey")} htmlName="vehicle-api-key" type="password" value={key} onChange={setKey} autoComplete="new-password" isRequired isDisabled={busy} size="lg" />
        <HStack hAlign="end" gap={2}><Button label={t("help")} type="button" variant="ghost" size="sm" onClick={() => setShowKeyHelp(true)} isDisabled={busy} /></HStack>
      </VStack>
      <Text type="supporting">{t("keySecurity")}</Text>
      {(renewal || replacing) && <Text type="supporting">{renewal ? t("renewWarning") : t("replaceWarning")}</Text>}
      <Button label={renewal ? t("renew") : replacing ? t("change") : t("connect")} type="submit" variant="primary" size="lg" width="100%" isDisabled={(!renewal && !validVin) || !key || retrySeconds > 0} />
      {onCancel && <Button label={t("back")} variant="ghost" isDisabled={busy} onClick={onCancel} />}
    </VStack>
    <ApiKeyHelpDialog isOpen={showKeyHelp} onOpenChange={setShowKeyHelp} />
  </VStack>;
}
