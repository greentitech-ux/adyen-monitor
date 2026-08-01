// vaultSubgroups.js
// Subgrupos do cofre (unidades dentro de um grupo, ex: "DOM_BESSA" e
// "SPO_TACARUNA" dentro do grupo "GBE"). E nos subgrupos que as senhas de
// fato ficam (veja vaultEntries.js) - a permissao de um usuario e concedida
// por subgrupo (permissions.vaultSubgroups), nao pelo grupo inteiro, pra dar
// controle fino (ex: acesso só a DOM_BESSA, sem ver SPO_TACARUNA). Criar/
// renomear/excluir subgrupo e restrito ao Master.
const db = require('./firestore');

const subgroupsRef = db.collection('vaultSubgroups');
const entriesRef = db.collection('vaultEntries');

async function listAll() {
  const snap = await subgroupsRef.get();
  const list = snap.docs.map(toSubgroup);
  list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return list;
}

async function listByGroup(groupId) {
  const snap = await subgroupsRef.where('groupId', '==', groupId).get();
  const list = snap.docs.map(toSubgroup);
  list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return list;
}

async function create(groupId, name) {
  name = String(name || '').trim();
  if (!groupId) throw new Error('Grupo é obrigatório.');
  if (!name) throw new Error('Nome do subgrupo é obrigatório.');
  const doc = await subgroupsRef.add({ groupId, name, createdAt: new Date().toISOString() });
  return toSubgroup(await doc.get());
}

async function rename(id, name) {
  name = String(name || '').trim();
  if (!name) throw new Error('Nome do subgrupo é obrigatório.');
  const ref = subgroupsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Subgrupo não encontrado.');
  await ref.update({ name });
  return toSubgroup(await ref.get());
}

async function remove(id) {
  const ref = subgroupsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Subgrupo não encontrado.');
  await ref.delete();

  // as senhas que estavam nesse subgrupo ficam "sem subgrupo" em vez de
  // serem apagadas
  const orphaned = await entriesRef.where('subgroupId', '==', id).get();
  await Promise.all(orphaned.docs.map((d) => d.ref.update({ subgroupId: null })));
}

function toSubgroup(doc) {
  return { id: doc.id, ...doc.data() };
}

module.exports = { listAll, listByGroup, create, rename, remove };
