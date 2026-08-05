// vaultEntries.js
// CRUD das senhas salvas no cofre. Cada senha pertence a um subgrupo (unidade
// dentro de um grupo - veja vaultSubgroups.js). A senha em si nunca e gravada
// em texto puro no Firestore (veja vaultCrypto.js) - so e decifrada na hora
// de responder pra quem tem permissao de ver aquele subgrupo (checado em
// index.js antes de chamar essas funcoes).
const db = require('./firestore');
const { encrypt, decrypt } = require('./vaultCrypto');
const { createCache } = require('./liveCache');

const entriesRef = db.collection('vaultEntries');

// cache separado so pro caso "todos os subgrupos" (Master, subgroupIds ===
// null) - e o caso mais comum (Master e quem mais acessa o cofre) e o mais
// caro (le a colecao inteira). Consultas filtradas por subgrupo especifico
// continuam sem cache (ja usam 'where' no Firestore, bem mais baratas).
async function listAllSubgroupsUncached() {
  const snap = await entriesRef.get();
  const entries = snap.docs.map(toEntry);
  entries.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  return entries;
}
const allSubgroupsCache = createCache(listAllSubgroupsUncached, 20 * 1000);

async function listBySubgroups(subgroupIds) {
  // subgroupIds === null significa "todos os subgrupos" (Master)
  if (subgroupIds === null) return allSubgroupsCache.cached();
  const snap = await entriesRef.where('subgroupId', 'in', subgroupIds.length ? subgroupIds : ['__none__']).get();
  const entries = snap.docs.map(toEntry);
  entries.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  return entries;
}


async function get(id) {
  const doc = await entriesRef.doc(id).get();
  return doc.exists ? toEntry(doc) : null;
}

async function create(data) {
  const { title, url, username, password, note, subgroupId } = data;
  if (!String(title || '').trim()) throw new Error('Título é obrigatório.');
  if (!String(password || '').trim()) throw new Error('Senha é obrigatória.');

  const now = new Date().toISOString();
  const doc = await entriesRef.add({
    subgroupId: subgroupId || null,
    title: String(title).trim(),
    url: String(url || '').trim(),
    username: String(username || '').trim(),
    note: String(note || '').trim(),
    passwordEnc: encrypt(password),
    createdAt: now,
    updatedAt: now,
  });
  allSubgroupsCache.invalidar();
  return toEntry(await doc.get());
}

async function update(id, data) {
  const ref = entriesRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Senha não encontrada.');

  const patch = { updatedAt: new Date().toISOString() };
  if (data.title !== undefined) patch.title = String(data.title).trim();
  if (data.url !== undefined) patch.url = String(data.url).trim();
  if (data.username !== undefined) patch.username = String(data.username).trim();
  if (data.note !== undefined) patch.note = String(data.note).trim();
  if (data.subgroupId !== undefined) patch.subgroupId = data.subgroupId || null;
  if (data.password) patch.passwordEnc = encrypt(data.password);

  await ref.update(patch);
  allSubgroupsCache.invalidar();
  return toEntry(await ref.get());
}

async function remove(id) {
  const ref = entriesRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Senha não encontrada.');
  await ref.delete();
  allSubgroupsCache.invalidar();
}


function toEntry(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    subgroupId: data.subgroupId || null,
    title: data.title,
    url: data.url,
    username: data.username,
    note: data.note,
    password: decrypt(data.passwordEnc),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

module.exports = { listBySubgroups, get, create, update, remove };
