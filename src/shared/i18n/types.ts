export type { LocaleKey } from './strings';

export type LocaleOverride = 'auto' | 'en' | 'zh_CN';

export type SubstitutionVars = Readonly<Record<string, string | number>>;
