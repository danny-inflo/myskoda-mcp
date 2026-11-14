"use client";
import {Theme} from "@astryxdesign/core/theme";
import {LanguageProvider} from "../components/language-provider";
import {vehicleConnectTheme} from "./astryx/vehicle-connect.js";
export function Providers({children,initialLocale,initialPreference}:{children:React.ReactNode;initialLocale:string;initialPreference:string}) {
 return <LanguageProvider initialLocale={initialLocale} initialPreference={initialPreference}><Theme theme={vehicleConnectTheme} mode="system">{children}</Theme></LanguageProvider>;
}
