// vaultGroups.js
// Grupos do cofre de senhas (uma unidade, ex: "Loja Centro"). Os grupos sao
// da organizacao inteira (nao por usuario) - o Master decide quem enxerga
// qual grupo atraves de permissions.vaultGroups (veja auth.js/users.js).
// Criar/renomear/excluir grupo e restrito ao Master (index.js aplica
// auth.requireMaster nessas rotas).
const db = require('./firestore');

const groupsRef = db.collection('vaultGroups');
const entriesRef = db.collection('vaultEntries');

async function list() {
  const snap = await groupsRef.get();
  const groups = snap.docs.map(toGroup);
  groups.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return groups;
}

async function create(name) {
  name = String(name || '').trim();
  if (!name) throw new Error('Nome do grupo é obrigatório.');
  const doc = await groupsRef.add({ name, createdAt: new Date().toISOString() });
  return toGroup(await doc.get());
}

async function rename(id, name) {
  name = String(name || '').trim();
  if (!name) throw new Error('Nome do grupo é obrigatório.');
  const ref = groupsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Grupo não encontrado.');
  await ref.update({ name });
  return toGroup(await ref.get());
}

async function remove(id) {
  const ref = groupsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Grupo não encontrado.');
  await ref.delete();

  // as senhas que estavam nesse grupo ficam "sem grupo" em vez de serem apagadas
  const orphaned = await entriesRef.where('groupId', '==', id).get();
  await Promise.all(orphaned.docs.map((d) => d.ref.update({ groupId: null })));
}

function toGroup(doc) {
  return { id: doc.id, ...doc.data() };
}

module.exports = { list, create, rename, remove };
