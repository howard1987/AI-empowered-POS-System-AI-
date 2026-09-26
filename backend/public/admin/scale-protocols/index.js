import Dahua from './dahua.js';
import Topping from './topping.js';
import Digi from './digi.js';
import Mettler from './mettler.js';
import Cas from './cas.js';
import Generic from './generic.js';

const map = {
  dahua: Dahua,
  topping: Topping,
  digi: Digi,
  mettler: Mettler,
  cas: Cas,
  generic: Generic,
};

export const PROTOCOLS = Object.values(map).map(p => ({
  key: p.key,
  name: p.name,
  brand: p.brand,
  desc: p.desc,
  defaultBaud: p.defaultBaud,
  defaultDataBits: p.defaultDataBits,
  defaultParity: p.defaultParity,
  defaultStopBits: p.defaultStopBits,
}));

export function getProtocol(key) {
  return map[key] || map.generic;
}
