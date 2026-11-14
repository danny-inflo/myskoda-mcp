import { headers } from "next/headers";
import { env } from "cloudflare:workers";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { ConnectionFrame } from "../../components/connection-frame";
import type { Consent } from "../../lib/standalone-auth";

export const dynamic = "force-dynamic";

export default async function AuthorizePage() {
  if (env.DEPLOYMENT_TARGET !== "cloudflare") return <ConnectionFrame><Text>Use the authorization flow provided by your hosting platform.</Text></ConnectionFrame>;
  const value = (await headers()).get("x-vc-oauth-consent");
  if (!value) return <ConnectionFrame><Text>Start authorization from your MCP client.</Text></ConnectionFrame>;
  // The standalone Worker removes external x-vc-* headers, validates the OAuth
  // request and supplies this description. React escapes all client metadata.
  const { details, handle } = JSON.parse(decodeURIComponent(value)) as Consent;
  return <ConnectionFrame>
    <VStack gap={2}>
      <Heading level={2}>Connect {details.clientName}?</Heading>
      <Text>This client will be able to read your connected vehicle. Vehicle commands also require permissions enabled in settings and your explicit request for each action.</Text>
      <Text>Requested access: {details.scope.join(", ") || "No scopes requested"}</Text>
      <Text>Access returns to: {details.redirectHost}</Text>
      <Text>{details.clientDomain ? `Client domain: ${details.clientDomain}` : "This client's name is self-reported and has not been verified."}</Text>
      {details.redirectIsLoopback && <Text>Continue only if you started this connection from an application on your computer.</Text>}
      <Text>Only the configured owner can sign in to this instance. Continue with GitHub if prompted. This approval does not enable vehicle controls.</Text>
    </VStack>
    <form method="post" action="/authorize">
      <input type="hidden" name="handle" value={handle} />
      <HStack gap={2}>
        <Button type="submit" name="decision" value="approve" label="Allow connection" variant="primary" />
        <Button type="submit" name="decision" value="deny" label="Deny" variant="secondary" />
      </HStack>
    </form>
  </ConnectionFrame>;
}
