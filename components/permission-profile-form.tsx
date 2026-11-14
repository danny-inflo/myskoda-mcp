"use client";
import type { FormEvent } from "react";
import {useI18n} from "./language-provider";
import { VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { CONTROL_CHOICES } from "../lib/control-profile.mjs";
import type { ControlChoices, ControlMode } from "./connection-types";
import { ConnectionSkeleton } from "./connection-skeleton";

export function PermissionProfileForm({ mode, permissions, busy, keyExpired, onModeChange, onPermissionsChange, onSubmit, submitLabel }: {
  mode: ControlMode; permissions: ControlChoices; busy: boolean; keyExpired: boolean;
  onModeChange: (mode: ControlMode) => void; onPermissionsChange: (permissions: ControlChoices) => void;
  onSubmit: (event: FormEvent<HTMLElement>) => void;
  submitLabel?: string;
}) {
  const {t} = useI18n();
  const selected = CONTROL_CHOICES.filter(({ scope }) => permissions[scope as keyof ControlChoices]);
  const enabled = mode === "all" || (mode === "custom" && selected.length > 0);
  if (busy) return <ConnectionSkeleton shape="permissions" />;
  return <VStack as="form" gap={4} onSubmit={onSubmit} aria-label={t("permissionForm")}>
    <RadioList label={t("access")} isLabelHidden value={mode} onChange={value => onModeChange(value as ControlMode)} isDisabled={busy}>
      <RadioListItem value="readOnly" label={t("readOnly")} description={t("readOnlyHelp")} />
      <RadioListItem value="all" label={t("all")} description={t("allHelp")} />
      <RadioListItem value="custom" label={t("custom")} description={t("customHelp")} />
    </RadioList>
    {mode === "custom" && <CheckboxList label={t("allowedGroups")} value={selected.map(({ scope }) => scope)} onChange={values => onPermissionsChange(Object.fromEntries(CONTROL_CHOICES.map(({ scope }) => [scope, values.includes(scope)])) as ControlChoices)} isDisabled={busy} hasDividers>
      {CONTROL_CHOICES.map(group => <CheckboxListItem key={group.scope} value={group.scope} label={t(group.title)} description={<Text type="supporting" textWrap="wrap">{t(group.description)}</Text>} />)}
    </CheckboxList>}
    {enabled && keyExpired && <Banner status="warning" title={t("renewFirst")} description={t("expiredPermissions")} />}
    <Button label={submitLabel ?? t("finish")} variant="primary" size="lg" type="submit" width="100%" isDisabled={enabled && keyExpired} />
  </VStack>;
}
