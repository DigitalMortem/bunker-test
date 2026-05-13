// Реестр паков игры.
// Классический пак уже заполнен. Остальные паки пока являются пустыми заготовками.
const packs = {};

function registerPack(key, data) {
  packs[key] = {
    key,
    name: data.name || key,
    ready: Boolean(data.ready),
    scenarios: Array.isArray(data.scenarios) ? data.scenarios : [],
    conditions: Array.isArray(data.conditions) ? data.conditions : [],
    source: data.source || ''
  };
}

function createEmptyPack(key, name) {
  registerPack(key, {
    name,
    ready: false,
    scenarios: [],
    conditions: [],
    source: `js/packs/${key}.js`
  });
}

function getPack(key) {
  return packs[key] || packs.classic;
}

function isPackReady(key) {
  const pack = getPack(key);
  return Boolean(pack && pack.ready && pack.scenarios.length && pack.conditions.length);
}

createEmptyPack('classic', 'Классический');
createEmptyPack('apocalypse', 'Апокалипсис');
createEmptyPack('zombie', 'Зомби');
createEmptyPack('fantasy', 'Фэнтези');
createEmptyPack('maniac', 'Маньяк');
createEmptyPack('space', 'Космос');
createEmptyPack('virus', 'Вирус');
createEmptyPack('winter', 'Ледниковый период');
createEmptyPack('cyber', 'Киберпанк');
createEmptyPack('island', 'Остров после катастрофы');
createEmptyPack('underwater', 'Подводный бункер');
