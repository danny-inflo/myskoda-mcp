"use client";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import {useI18n} from "./language-provider";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Divider } from "@astryxdesign/core/Divider";

type Shape = "connection" | "vehicle" | "permissions" | "settings";
const labels: Record<Shape, string> = {
  connection: "Připojení se připravuje",
  vehicle: "Probíhá ověřování připojení",
  permissions: "Probíhá ukládání oprávnění",
  settings: "Probíhá ukládání nastavení připojení",
};

// Only placeholders are visible; the status remains available to screen readers.
export function ConnectionSkeleton({ shape = "connection" }: { shape?: Shape }) {
  const {t} = useI18n();
  return <VStack role="status" aria-label={t(labels[shape])} aria-busy="true" gap={4}>
    <VStack gap={4} aria-hidden="true">
      <VStack gap={2} hAlign="center">
        <Skeleton width="60%" height="1.5em" />
        <Skeleton width="90%" height="1em" index={1} />
        <Skeleton width="70%" height="1em" index={2} />
      </VStack>
      {shape === "connection" && <>
        <VStack gap={3}><Skeleton width="45%" height="1.25em" index={3} /><Skeleton width="65%" height="1em" index={4} /><HStack gap={2}><Skeleton width="40%" height="2.5rem" index={5} /><Skeleton width="40%" height="2.5rem" index={6} /></HStack></VStack>
        <Divider />
      </>}
      {Array.from({ length: shape === "vehicle" || shape === "settings" ? 2 : 4 }, (_, index) => <VStack gap={2} key={index}>
        <Skeleton width={shape === "permissions" ? "50%" : "35%"} height="1em" index={index * 2 + 7} />
        <Skeleton height={shape === "vehicle" || shape === "settings" ? "2.75rem" : "1.25em"} index={index * 2 + 8} />
      </VStack>)}
      <Skeleton height="2.75rem" index={16} />
    </VStack>
  </VStack>;
}
