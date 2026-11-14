"use client";
import { useState, type FormEvent } from "react";
import {useI18n} from "./language-provider";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { spinAttributes } from "./private-input-attributes";
import { ConnectionSkeleton } from "./connection-skeleton";

export function HeatingSpinSettings({ configured, busy, onSave }: { configured: boolean; busy: boolean; onSave: (spin: string | null) => Promise<void> }) {
  const {t} = useI18n();
  const [spin, setSpin] = useState("");
  async function submit(event: FormEvent<HTMLElement>) { event.preventDefault(); try { await onSave(spin); } finally { setSpin(""); } }
  if (busy) return <ConnectionSkeleton shape="settings" />;
  return <VStack as="form" gap={3} onSubmit={submit} aria-label={t("heatingPin")}>
    <Text type="supporting">{configured ? t("pinStored") : t("pinMissing")} {t("pinPurpose")}</Text>
    <TextInput label={configured ? t("newPin") : t("pin")} ref={spinAttributes} type="password" value={spin} onChange={setSpin} autoComplete="new-password" isDisabled={busy} size="lg" />
    <HStack gap={2} wrap="wrap"><Button label={t("save")} type="submit" isDisabled={busy || !spin} />{configured && <Button label={t("delete")} variant="ghost" isDisabled={busy} onClick={async () => { setSpin(""); await onSave(null); }} />}</HStack>
    <Text type="supporting">{t("pinSaveHelp")}</Text>
  </VStack>;
}
