"use client";
// Adapted from Meta Astryx's login-card template (MIT).
import type { ReactNode } from "react";
import {LanguageSwitcher} from "./language-switcher";
import {useI18n} from "./language-provider";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { Text, Heading } from "@astryxdesign/core/Text";
import { Card } from "@astryxdesign/core/Card";
import { Link } from "@astryxdesign/core/Link";

export function ConnectionFrame({ children, signOutUrl }: { children: ReactNode; signOutUrl?: string }) {
  const {t} = useI18n();
  return <Center role="main" axis="both" padding={6} minHeight="100dvh">
    <VStack gap={4} hAlign="center" width="100%" maxWidth={512}>
      <VStack gap={2} hAlign="center">
        <img src="/vehicle-connect-mark.png" width={96} height={96} alt="" aria-hidden="true" />
        <Heading level={1}>Vehicle Connect</Heading>
      </VStack>
      <Card padding={8} width="100%"><VStack gap={4} hAlign="stretch">{children}</VStack></Card>
      <VStack gap={2} hAlign="center">
        <Text type="supporting" justify="center">{t("disclaimer")}</Text>
        <LanguageSwitcher />
        {signOutUrl && <Link href={signOutUrl} target="_top" type="supporting">{t("signOut")}</Link>}
      </VStack>
    </VStack>
  </Center>;
}
