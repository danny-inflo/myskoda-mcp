"use client";
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {LANGUAGES} from '../lib/i18n/locale.mjs';
import {useI18n} from './language-provider';
export function LanguageSwitcher(){
  const {t,locale,preference,selectLanguage}=useI18n();
  return <Selector label={locale==='en'?'Language':t('language')+' / Language'} isLabelHidden variant="ghost" size="sm" renderValue={option=><Text type="supporting" color="accent" weight="normal">{option.label}</Text>} value={preference} onChange={selectLanguage} options={[{value:'auto',label:t('automatic')+' ('+(LANGUAGES.find(x=>x.code===locale)?.name??'English')+')'},...LANGUAGES.map(x=>({value:x.code,label:x.name}))]} />;
}
