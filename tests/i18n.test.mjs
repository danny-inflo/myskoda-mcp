import test from 'node:test';
import assert from 'node:assert/strict';
import {LANGUAGES,LANGUAGE_COOKIE,detectLanguage,languageFromHeader,resolveLanguage,normalizeLanguage,languagePreference} from '../lib/i18n/locale.mjs';
import {messages,translate,errorMessageKey,systemMessages,formatDate} from '../lib/i18n/catalog.mjs';
test('all 18 dictionaries have every message and preserve interpolation parameters',()=>{
 assert.equal(LANGUAGES.length,18);
 const keys=Object.keys(messages.en).sort();
 for(const {code} of LANGUAGES){assert.deepEqual(Object.keys(messages[code]).sort(),keys,code);for(const key of keys){const text=messages[code][key];assert.equal(typeof text,'string');assert(text.trim(),code+':'+key);assert.deepEqual([...text.matchAll(/\{([a-z]+)\}/g)].map(x=>x[1]).sort(),[...messages.en[key].matchAll(/\{([a-z]+)\}/g)].map(x=>x[1]).sort(),code+':'+key);}}
});
test('automatic detection respects browser priority, quality values, regional tags and unsupported languages',()=>{
 assert.equal(detectLanguage(['ja-JP','de-AT','cs-CZ']),'de');
 assert.equal(languageFromHeader('pl-PL;q=0.5,de-CH;q=0.9,en;q=0.7'),'de');
 assert.equal(languageFromHeader('de;q=0,fr;q=0.5'),'fr');
 assert.equal(languageFromHeader('cs;q=no,fr;q=2,ja-JP'),'en');
 assert.equal(languageFromHeader('*'),'en');assert.equal(detectLanguage([]),'en');
 assert.equal(normalizeLanguage('no-NO'),'nb');assert.equal(normalizeLanguage('sk_SK'),'sk');
 assert.equal(normalizeLanguage('__proto__'),null);
});
test('only a valid explicit preference overrides automatic server detection',()=>{
 assert.deepEqual(resolveLanguage(LANGUAGE_COOKIE+'=fr','de-DE'),{preference:'fr',locale:'fr'});
 assert.deepEqual(resolveLanguage(LANGUAGE_COOKIE+'=auto','cs-CZ'),{preference:'auto',locale:'cs'});
 for(const value of ['<script>','__proto__','de-DE','%0A','bad'])assert.equal(languagePreference(LANGUAGE_COOKIE+'='+value),'auto');
 assert.equal(languagePreference('other_'+LANGUAGE_COOKIE+'=de'),'auto');
});
test('translated UI errors use codes or status, never expose unknown provider text',()=>{
 assert.equal(errorMessageKey('KEY_EXPIRED',409),'errorExpired');assert.equal(errorMessageKey('UNKNOWN',429),'errorRateLimit');
 assert.equal(errorMessageKey('__proto__',503),'errorUnavailable');
 for(const {code} of LANGUAGES){assert.equal(translate(code,errorMessageKey('secret provider text',403)),messages[code].errorAccess);assert(!translate(code,'sensitive unknown error').includes('sensitive'));assert(!translate(code,'retryCountdown',{seconds:30}).includes('{'));}
});
test('dates and component accessibility messages follow the selected language',()=>{
 for(const {code} of LANGUAGES){assert.equal(systemMessages(code)['@astryx.field.required'],messages[code].required);assert.equal(systemMessages(code)['@astryx.dialog.close'],messages[code].close);assert.equal(formatDate(code,'bad'),'—');assert.equal(typeof formatDate(code,'2027-04-28T12:54:57Z'),'string');}
 assert.equal(translate('de','Uložit'),messages.de.save);assert.equal(translate('unsupported','save'),'Save');
});
