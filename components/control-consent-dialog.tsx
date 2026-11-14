"use client";
import { useEffect, useId, useState, type FormEvent } from "react";
import {useI18n} from "./language-provider";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter, HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { List, ListItem } from "@astryxdesign/core/List";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Banner } from "@astryxdesign/core/Banner";
import { spinAttributes } from "./private-input-attributes";

export function ControlConsentDialog({ isOpen, functions, requiresHeating = false, heatingSpinConfigured = false, onBack, onConfirm }: {
  isOpen: boolean; functions: string[]; requiresHeating?: boolean; heatingSpinConfigured?: boolean;
  onBack: () => void; onConfirm: (spin?: string) => void;
}) {
  const {t} = useI18n();
  const formId = useId();
  const [spin, setSpin] = useState("");
  const [replaceSpin, setReplaceSpin] = useState(false);
  const enterSpin = requiresHeating && (!heatingSpinConfigured || replaceSpin);
  const validSpin = !enterSpin || /^[\x21-\x7E]{1,128}$/.test(spin);
  useEffect(() => { if (!isOpen) { setSpin(""); setReplaceSpin(false); } }, [isOpen]);
  function back() { setSpin(""); setReplaceSpin(false); onBack(); }
  function confirm(event: FormEvent<HTMLElement>) {
    event.preventDefault();
    if (!isOpen || !validSpin) return;
    const value = enterSpin ? spin : undefined;
    setSpin(""); setReplaceSpin(false);
    onConfirm(value);
  }
  return <Dialog isOpen={isOpen} onOpenChange={open => { if (!open) back(); }} purpose="form" width={480} padding={6}>
    <Layout
      header={<DialogHeader title={t("consentTitle")} onOpenChange={open => { if (!open) back(); }} />}
      content={<LayoutContent role="region" label={t("allowedFeatures")}><VStack as="form" id={formId} onSubmit={confirm} gap={4}>
        <Banner status="warning" title={t("warning")} description={t("controlWarning")} />
        <Text>{t("consentText")}</Text>
        <List listStyle="disc" edge="flush" density="compact">
          {functions.map(name => <ListItem key={name} label={<Text textWrap="wrap">{t(name)}</Text>} />)}
        </List>
        {requiresHeating && <VStack gap={2}>
          {heatingSpinConfigured && !replaceSpin ? <>
            <Text type="supporting">{t("pinStoredConsent")}</Text>
            <Button label={t("change")} variant="ghost" size="sm" onClick={() => setReplaceSpin(true)} />
          </> : <>
            <TextInput ref={spinAttributes} label={heatingSpinConfigured ? t("newPin") : t("pin")} type="password" value={spin} onChange={setSpin} autoComplete="new-password" isRequired size="lg" description={t("pinHelp")} status={spin && !validSpin ? { type: "error", message: t("pinInvalid") } : undefined} />
            {heatingSpinConfigured && <Button label={t("back")} variant="ghost" size="sm" onClick={() => { setSpin(""); setReplaceSpin(false); }} />}
          </>}
        </VStack>}
      </VStack></LayoutContent>}
      footer={<LayoutFooter hasDivider><HStack gap={2} hAlign="end" wrap="wrap">
        <Button label={t("back")} variant="ghost" onClick={back} />
        <Button label={t("confirm")} type="submit" form={formId} variant="secondary" isDisabled={!validSpin} />
      </HStack></LayoutFooter>}
    />
  </Dialog>;
}
