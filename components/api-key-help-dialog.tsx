"use client";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import {useI18n} from "./language-provider";
import { Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Text, Heading } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { Divider } from "@astryxdesign/core/Divider";

// Mirrors the key-management instructions in the official Public API docs.
// The official QR is served locally; opening help sends no data to a third party.
export function ApiKeyHelpContent() {
  const {t} = useI18n();
  return <VStack gap={4}>
    <Text>{t("keyHelpIntro")}</Text>
    <VStack gap={2}>
      <Heading level={3}>{t("mobileHelp")}</Heading>
      <Button label={t("manage")} href="https://go.skoda.eu/api-keys" target="_blank" rel="noreferrer" variant="primary" size="lg" width="100%" />
    </VStack>
    <VStack gap={3}>
      <Heading level={3}>{t("desktopHelp")}</Heading>
      <Text>{t("qrHelp")}</Text>
      <VStack hAlign="center"><img src="/api-keys-qr.svg" width={180} height={180} alt={t("qrAlt")} /></VStack>
    </VStack>
    <Text>{t("noApp")} <Link href="https://go.skoda.eu/myskoda" target="_blank" rel="noreferrer">{t("download")}</Link></Text>
    <Divider />
    <Link href="https://public.api.connect.skoda-auto.cz/docs" target="_blank" rel="noreferrer" type="supporting">{t("docs")}</Link>
  </VStack>;
}

export function ApiKeyHelpDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (isOpen: boolean) => void }) {
  const {t} = useI18n();
  return <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="info" width={480} padding={6}>
    <Layout
      header={<DialogHeader title={t("keyHelpTitle")} onOpenChange={onOpenChange} />}
      content={<LayoutContent role="region" label={t("keyHelpRegion")}><ApiKeyHelpContent /></LayoutContent>}
      footer={<LayoutFooter hasDivider><Button label={t("close")} onClick={() => onOpenChange(false)} width="100%" /></LayoutFooter>}
    />
  </Dialog>;
}
