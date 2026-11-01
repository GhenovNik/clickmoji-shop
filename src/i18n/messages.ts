import enAdmin from './messages/en/admin.json';
import enApi from './messages/en/api.json';
import enAuth from './messages/en/auth.json';
import enCatalog from './messages/en/catalog.json';
import enCommon from './messages/en/common.json';
import enEmail from './messages/en/email.json';
import enHistory from './messages/en/history.json';
import enHome from './messages/en/home.json';
import enLists from './messages/en/lists.json';
import enNav from './messages/en/nav.json';
import ruAdmin from './messages/ru/admin.json';
import ruApi from './messages/ru/api.json';
import ruAuth from './messages/ru/auth.json';
import ruCatalog from './messages/ru/catalog.json';
import ruCommon from './messages/ru/common.json';
import ruEmail from './messages/ru/email.json';
import ruHistory from './messages/ru/history.json';
import ruHome from './messages/ru/home.json';
import ruLists from './messages/ru/lists.json';
import ruNav from './messages/ru/nav.json';
import type { Locale } from './config';

// One file per namespace and language, so screens can be translated independently.
// Both dictionaries are bundled on the server; a page sends the client only the active one.
const ru = {
  admin: ruAdmin,
  api: ruApi,
  auth: ruAuth,
  catalog: ruCatalog,
  common: ruCommon,
  email: ruEmail,
  history: ruHistory,
  home: ruHome,
  lists: ruLists,
  nav: ruNav,
};

export type Messages = typeof ru;

// Typed against the Russian dictionary: a key missing in English fails the build.
const en: Messages = {
  admin: enAdmin,
  api: enApi,
  auth: enAuth,
  catalog: enCatalog,
  common: enCommon,
  email: enEmail,
  history: enHistory,
  home: enHome,
  lists: enLists,
  nav: enNav,
};

export const messages: Record<Locale, Messages> = { ru, en };
