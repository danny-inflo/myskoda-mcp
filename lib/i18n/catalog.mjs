import cs from "./messages/cs.json" with {type:"json"};
import sk from "./messages/sk.json" with {type:"json"};
import de from "./messages/de.json" with {type:"json"};
import pl from "./messages/pl.json" with {type:"json"};
import hu from "./messages/hu.json" with {type:"json"};
import en from "./messages/en.json" with {type:"json"};
import fr from "./messages/fr.json" with {type:"json"};
import it from "./messages/it.json" with {type:"json"};
import es from "./messages/es.json" with {type:"json"};
import nl from "./messages/nl.json" with {type:"json"};
import da from "./messages/da.json" with {type:"json"};
import tr from "./messages/tr.json" with {type:"json"};
import sv from "./messages/sv.json" with {type:"json"};
import nb from "./messages/nb.json" with {type:"json"};
import fi from "./messages/fi.json" with {type:"json"};
import ro from "./messages/ro.json" with {type:"json"};
import sl from "./messages/sl.json" with {type:"json"};
import hr from "./messages/hr.json" with {type:"json"};
import aliases from "./aliases.json" with {type:"json"};
import {localeTag} from "./locale.mjs";
export const messages = Object.freeze({cs,sk,de,pl,hu,en,fr,it,es,nl,da,tr,sv,nb,fi,ro,sl,hr});
export function translate(locale, key, values={}) {
  values={provider:"OpenAI",...values};
  const id=Object.hasOwn(aliases,key)?aliases[key]:key;
  const dictionary=Object.hasOwn(messages,locale)?messages[locale]:messages.en;
  const text=(Object.hasOwn(dictionary,id)?dictionary[id]:undefined)??(Object.hasOwn(messages.en,id)?messages.en[id]:undefined)??dictionary.requestFailed;
  return text.replace(/\{([a-zA-Z]+)\}/g,(match,name)=>{
    const value=values[name];
    return value===undefined?match:typeof value==='number'?new Intl.NumberFormat(localeTag(locale)).format(value):String(value);
  });
}
export function formatDate(locale,value){const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(localeTag(locale),{dateStyle:'medium',timeStyle:'medium'}).format(date);}
export function systemMessages(locale) {
  const t=key=>translate(locale,key);
  return {'@astryx.field.required':t('required'),'@astryx.field.optional':t('optional'),'@astryx.dialog.close':t('close'),'@astryx.popover.close':t('close'),'@astryx.button.loading':t('loading'),'@astryx.banner.dismiss':t('close'),'@astryx.banner.dismissTitle':'{dismiss}: {title}','@astryx.selector.placeholder':t('language'),'@astryx.selector.empty':t('errorInput'),'@astryx.selector.searchPlaceholder':t('language'),'@astryx.selector.searchOptions':t('language'),'@astryx.selector.clearLabel':t('delete'),'@astryx.checkboxList.item.checkbox':'{label}'};
}
const groups={
 INVALID_KEY:'errorExpired',INVALID_CONNECTION_INPUT:'errorInput',CONNECTION_ATTEMPT_LIMITED:'errorRateLimit',CONTROL_NOT_ALLOWED:'errorPermissions',ACTION_CONFIRMATION_REQUIRED:'errorPermissions',HEATING_SPIN_REQUIRED:'errorPin',OPERATION_UNSUPPORTED:'errorUnsupported',OPERATION_DISABLED:'errorPermissions',SIGN_IN_REQUIRED:'errorSignIn',INVALID_ORIGIN:'errorInput',INVALID_CONTENT_TYPE:'errorInput',INVALID_JSON:'errorInput',PAYLOAD_TOO_LARGE:'errorInput',INVALID_INPUT:'errorInput',INVALID_VIN:'vinInvalid',INVALID_SPIN_INPUT:'pinInvalid',INVALID_PERMISSION_INPUT:'errorPermissions',INVALID_CONTROL_INPUT:'errorPermissions',CONTROL_DISABLED:'errorPermissions',CONTROL_NOT_ENABLED:'errorPermissions',CONTROL_PERMISSION_REQUIRED:'errorPermissions',CONTROL_SCOPE_DISABLED:'errorPermissions',CONTROL_ACKNOWLEDGEMENT_REQUIRED:'errorPermissions',KEY_EXPIRED:'errorExpired',UPSTREAM_UNAUTHORIZED:'errorExpired',UPSTREAM_FORBIDDEN:'errorAccess',FORBIDDEN:'errorAccess',INVALID_API_KEY:'errorExpired',CONNECTION_CHANGED:'connectionChanged',CONNECT_REQUIRED:'connectionFailed',CONNECTION_ATTEMPT_EXPIRED:'errorVerification',CONNECTION_ATTEMPT_LIMIT:'errorRateLimit',CONNECTION_RATE_LIMITED:'errorRateLimit',RATE_LIMITED:'errorRateLimit',UPSTREAM_RATE_LIMITED:'errorRateLimit',REQUEST_IN_PROGRESS:'errorRateLimit',SPIN_REQUIRED:'errorPin',INVALID_SPIN:'errorPin',UNSUPPORTED:'errorUnsupported',CAPABILITY_UNSUPPORTED:'errorUnsupported',VAULT_ERROR:'errorVerification',UNAVAILABLE:'errorUnavailable',UPSTREAM_UNAVAILABLE:'errorUnavailable',INVALID_RESPONSE:'errorUnavailable',UPSTREAM_REDIRECT:'errorUnavailable'
};
export function errorMessageKey(code,status){return (Object.hasOwn(groups,code)?groups[code]:undefined)??(status===429?'errorRateLimit':status===401?'errorSignIn':status===403?'errorAccess':status===409?'connectionChanged':status===400||status===422?'errorInput':'errorUnavailable');}
