// disputes.js
// Historico de disputas de chargeback: cada registro guarda as notas de quem
// monitorou o pedido, as imagens anexadas como prova (pedido existiu / cliente
// retirou) e o status da disputa junto a Adyen. Persistido no Firestore, igual
// ao resto do app.
const db = require('./firestore');
const storage = require('./storage');
const COLLECTION = db.collection('disputes');

const STATUSES = ['ABERTA', 'ENVIADA', 'GANHA', 'PERDIDA'];

async function create({ pedidoId, unidade, notas, imagens }) {
  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
    pedidoId,
    unidade: unidade || null,
    notas: notas || '',
    status: 'ABERTA',
    imagens: imagens || [], // [{ nome, path }] - path e a chave no Cloud Storage
    criadoEm: agora,
    atualizadoEm: agora,
  };
  await doc.set(registro);
  return registro;
}

async function listAll() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}

async function listByPedido(pedidoId) {
  const snap = await COLLECTION.where('pedidoId', '==', pedidoId).get();
  return snap.docs.map((d) => d.data()).sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function updateStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error('status invalido');
  await COLLECTION.doc(id).update({ status, atualizadoEm: new Date().toISOString() });
  return getOne(id);
}

async function remove(id) {
  const registro = await getOne(id);
  if (!registro) return;
  await Promise.all((registro.imagens || []).map((img) => storage.apagarImagem(img.path)));
  await COLLECTION.doc(id).delete();
}

module.exports = { STATUSES, create, listAll, listByPedido, getOne, updateStatus, remove };
