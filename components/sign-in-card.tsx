"use client";
import { VStack } from "@astryxdesign/core/Layout";
import {useI18n} from "./language-provider";
import { Text, Heading } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { ConnectionFrame } from "./connection-frame";

export function SignInCard({ signInUrl, authProvider = "OpenAI" }: { signInUrl: string; authProvider?: "OpenAI" | "GitHub" }) {
  const {t} = useI18n();
  return <ConnectionFrame>
    <VStack gap={1} hAlign="center"><Heading level={2}>{t("signInTitle")}</Heading><Text color="secondary" justify="center">{t("signInIntro")}</Text></VStack>
    <Button label={t("signIn")} href={signInUrl} target="_top" variant="primary" size="lg" width="100%" />
    <Divider />
    <Text type="supporting">{t("signInHelp", {provider:authProvider})}</Text>
  </ConnectionFrame>;
}
