// disputes.js
// Historico de registros por pedido: tanto pedidos que ja viraram chargeback
// (disputa formal com a Adyen) quanto pedidos que ainda nao viraram, mas o
// time quer monitorar de perto (observacoes + evidencias, pra decidir se e
// preciso recorrer caso vire chargeback depois). Cada registro guarda notas +
// imagens anexadas (comprovante de pedido/retirada) e um status de
// acompanhamento. Persistido no Firestore, igual ao resto do app.
const db = require('./firestore');
const storage = require('./storage');
const COLLECTION = db.collection('disputes');

// MONITORANDO: pedido ainda nao e chargeback, so esta sendo acompanhado.
// ABERTA -> ENVIADA -> GANHA/PERDIDA: fluxo da disputa formal do chargeback.
const STATUSES = ['MONITORANDO', 'ABERTA', 'ENVIADA', 'GANHA', 'PERDIDA'];

async function create({ pedidoId, unidade, notas, imagens }) {
  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
    pedidoId,
    unidade: unidade || null,
    notas: notas || '',
    status: 'MONITORANDO',
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
