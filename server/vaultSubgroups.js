// vaultSubgroups.js
// Subgrupos do cofre (unidades dentro de um grupo, ex: "DOM_BESSA" e
// "SPO_TACARUNA" dentro do grupo "GBE"). E nos subgrupos que as senhas de
// fato ficam (veja vaultEntries.js) - a permissao de um usuario e concedida
// por subgrupo (permissions.vaultSubgroups), nao pelo grupo inteiro, pra dar
// controle fino (ex: acesso só a DOM_BESSA, sem ver SPO_TACARUNA). Criar/
// renomear/excluir subgrupo e restrito ao Master.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const subgroupsRef = db.collection('vaultSubgroups');
const entriesRef = db.collection('vaultEntries');

// cache de 20s, mesmo racional de vaultGroups.js: lista muda raramente e e
// lida a cada boot de Cofre/Usuarios - listByGroup deriva do mesmo cache em
// vez de fazer uma query propria no Firestore
async function listAllUncached() {
  const snap = await subgroupsRef.get();
  const list = snap.docs.map(toSubgroup);
  list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return list;
}
const subgroupsCache = createCache(listAllUncached, 20 * 1000);
const listAll = subgroupsCache.cached;

async function listByGroup(groupId) {
  return (await listAll()).filter((s) => s.groupId === groupId);
}

async function create(groupId, name) {
  name = String(name || '').trim();
  if (!groupId) throw new Error('Grupo é obrigatório.');
  if (!name) throw new Error('Nome do subgrupo é obrigatório.');
  const doc = await subgroupsRef.add({ groupId, name, createdAt: new Date().toISOString() });
  subgroupsCache.invalidar();
  return toSubgroup(await doc.get());
}

async function rename(id, name) {
  name = String(name || '').trim();
  if (!name) throw new Error('Nome do subgrupo é obrigatório.');
  const ref = subgroupsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Subgrupo não encontrado.');
  await ref.update({ name });
  subgroupsCache.invalidar();
  return toSubgroup(await ref.get());
}

async function remove(id) {
  const ref = subgroupsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Subgrupo não encontrado.');
  await ref.delete();
  subgroupsCache.invalidar();

  // as senhas que estavam nesse subgrupo ficam "sem subgrupo" em vez de
  // serem apagadas
  const orphaned = await entriesRef.where('subgroupId', '==', id).get();
  await Promise.all(orphaned.docs.map((d) => d.ref.update({ subgroupId: null })));
}

function toSubgroup(doc) {
  return { id: doc.id, ...doc.data() };
}

module.exports = { listAll, listByGroup, create, rename, remove };
