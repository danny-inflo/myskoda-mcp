"use client";
import {createContext,useContext,useEffect,useMemo,useState,type ReactNode} from 'react';
import {InternationalizationProvider} from '@astryxdesign/core/i18n';
import {LANGUAGE_COOKIE,detectLanguage,isLanguage,localeTag} from '../lib/i18n/locale.mjs';
import {translate,formatDate,systemMessages} from '../lib/i18n/catalog.mjs';
type Parameters = Record<string,string|number>;
const fallback={locale:'cs',preference:'auto',t:(key:string,values?:Parameters)=>translate('cs',key,values),date:(value:string)=>formatDate('cs',value),selectLanguage:(_value:string)=>{}};
const LanguageContext=createContext(fallback);
export function useI18n(){return useContext(LanguageContext);}
export function LanguageProvider({children,initialLocale,initialPreference='auto'}:{children:ReactNode;initialLocale:string;initialPreference?:string}) {
  const [locale,setLocale]=useState(initialLocale);
  const [preference,setPreference]=useState(initialPreference);
  useEffect(()=>{document.documentElement.lang=locale;},[locale]);
  useEffect(()=>{
    if(preference!=='auto')return;
    const changed=()=>setLocale(detectLanguage(navigator.languages));
    window.addEventListener('languagechange',changed);
    return ()=>window.removeEventListener('languagechange',changed);
  },[preference]);
  const value=useMemo(()=>({locale,preference,t:(key:string,values?:Parameters)=>translate(locale,key,values),date:(date:string)=>formatDate(locale,date),selectLanguage:(next:string)=>{
    if(next!=='auto'&&!isLanguage(next))return;
    setPreference(next);setLocale(next==='auto'?detectLanguage(navigator.languages):next);
    document.cookie=LANGUAGE_COOKIE+'='+next+'; Path=/; Max-Age=31536000; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');
  }}),[locale,preference]);
  const translatedSystemMessages=useMemo(()=>({[localeTag(locale)]:systemMessages(locale)}),[locale]);
  return <LanguageContext.Provider value={value}><InternationalizationProvider locale={localeTag(locale)} messages={translatedSystemMessages}>{children}</InternationalizationProvider></LanguageContext.Provider>;
}
