// vaultGroups.js
// Grupos do cofre de senhas (nivel superior, ex: "GBE", "ARCFOOD") - da
// organizacao inteira, nao por usuario. Dentro de cada grupo existem
// subgrupos (unidades, ex: "DOM_BESSA", "SPO_TACARUNA" dentro de "GBE" - veja
// vaultSubgroups.js), e e nos subgrupos que as senhas de fato ficam. O Master
// decide quem enxerga qual subgrupo atraves de permissions.vaultSubgroups
// (veja auth.js/users.js). Criar/renomear/excluir grupo e restrito ao Master
// (index.js aplica auth.requireMaster nessas rotas).
const db = require('./firestore');
const subgroups = require('./vaultSubgroups');

const groupsRef = db.collection('vaultGroups');

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

  // exclui em cascata os subgrupos desse grupo - as senhas deles ficam "sem
  // subgrupo" em vez de serem apagadas (mesma logica de vaultSubgroups.remove)
  const filhos = await subgroups.listByGroup(id);
  await Promise.all(filhos.map((s) => subgroups.remove(s.id)));
}

function toGroup(doc) {
  return { id: doc.id, ...doc.data() };
}

module.exports = { list, create, rename, remove };
