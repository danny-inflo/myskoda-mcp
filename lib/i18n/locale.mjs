export const LANGUAGE_COOKIE = 'vc_language_v1';
export const LANGUAGES = Object.freeze([
  ['cs','Čeština','cs-CZ'],['sk','Slovenčina','sk-SK'],['de','Deutsch','de-DE'],['pl','Polski','pl-PL'],['hu','Magyar','hu-HU'],['en','English','en-GB'],['fr','Français','fr-FR'],['it','Italiano','it-IT'],['es','Español','es-ES'],['nl','Nederlands','nl-NL'],['da','Dansk','da-DK'],['tr','Türkçe','tr-TR'],['sv','Svenska','sv-SE'],['nb','Norsk bokmål','nb-NO'],['fi','Suomi','fi-FI'],['ro','Română','ro-RO'],['sl','Slovenščina','sl-SI'],['hr','Hrvatski','hr-HR'],
].map(([code,name,tag])=>Object.freeze({code,name,tag})));
export const SUPPORTED_LANGUAGES = Object.freeze(LANGUAGES.map(x=>x.code));
export function normalizeLanguage(value) {
  if(typeof value!=='string'||value.length>80)return null;
  const base=value.trim().toLowerCase().replaceAll('_','-').split('-')[0];
  const code=base==='no'?'nb':base;
  return SUPPORTED_LANGUAGES.includes(code)?code:null;
}
export function isLanguage(value){return typeof value==='string'&&SUPPORTED_LANGUAGES.includes(value);}
export function languagePreference(cookie='') {
  const value=cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith(LANGUAGE_COOKIE+'='))?.slice(LANGUAGE_COOKIE.length+1);
  return isLanguage(value)?value:'auto';
}
export function detectLanguage(preferences=[]) {
  for(const preference of preferences){const locale=normalizeLanguage(preference);if(locale)return locale;}
  return 'en';
}
export function languageFromHeader(value='') {
  return detectLanguage(value.slice(0,8192).split(',').map((part,index)=>{
    const [tag,...parameters]=part.trim().split(';');const q=parameters.find(p=>p.trim().startsWith('q='));
    const quality=q===undefined?1:Number(q.trim().slice(2));
    return {tag,quality,index};
  }).filter(x=>Number.isFinite(x.quality)&&x.quality>0&&x.quality<=1).sort((a,b)=>b.quality-a.quality||a.index-b.index).map(x=>x.tag));
}
export function resolveLanguage(cookie='',acceptLanguage='') {
  const preference=languagePreference(cookie);
  return {preference,locale:preference==='auto'?languageFromHeader(acceptLanguage):preference};
}
export function localeTag(locale){return LANGUAGES.find(x=>x.code===locale)?.tag??'en-GB';}
