import type { Metadata } from "next";
import {headers} from "next/headers";
import {resolveLanguage} from "../lib/i18n/locale.mjs";
import {translate} from "../lib/i18n/catalog.mjs";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "./astryx/vehicle-connect.css";
import "./globals.css";
import { Providers } from "./providers";

export async function generateMetadata(): Promise<Metadata> {
 const request=await headers();
 const {locale}=resolveLanguage(request.get("cookie")??"",request.get("accept-language")??"");
 return {title:"Vehicle Connect · MyŠkoda",description:translate(locale,"metadataDescription"),robots:{index:false,follow:false}};
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const request = await headers();
  const {locale,preference} = resolveLanguage(request.get("cookie")??"",request.get("accept-language")??"");
  return (
    <html lang={locale}>
      <body>
        <Providers initialLocale={locale} initialPreference={preference}>{children}</Providers>
      </body>
    </html>
  );
}
