// refunds.js
// Fila de solicitacoes de estorno: um usuario Leitor pode pedir estorno de um
// pedido Aprovado (com uma observacao explicando o motivo), confirmando com a
// propria senha (veja auth.verifyPassword, chamado em index.js antes de criar
// o registro). O Master acompanha essa fila e Aprova (e executa o estorno na
// Adyen por fora) ou Rejeita (com um motivo).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const refundsRef = db.collection('refundRequests');
const STATUSES = ['PENDENTE', 'APROVADO', 'REJEITADO'];


async function create({ pedidoId, unidade, observacao, requestedById, requestedByEmail }) {
  if (!pedidoId) throw new Error('pedidoId é obrigatório.');
  if (!String(observacao || '').trim()) throw new Error('Descreva o motivo do estorno.');

  const doc = refundsRef.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
    pedidoId,
    unidade: unidade || null,
    observacao: String(observacao).trim(),
    status: 'PENDENTE',
    requestedById,
    requestedByEmail,
    motivoDecisao: '',
    decidedByEmail: null,
    criadoEm: agora,
    decidedEm: null,
  };
  await doc.set(registro);
  refundsCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await refundsRef.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const refundsCache = createCache(listAllUncached, 20 * 1000);
const listAll = refundsCache.cached;


async function getOne(id) {
  const doc = await refundsRef.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function updateStatus(id, status, { motivoDecisao, decidedByEmail }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({
    status,
    motivoDecisao: motivoDecisao || '',
    decidedByEmail,
    decidedEm: new Date().toISOString(),
  });
  refundsCache.invalidar();
  return getOne(id);
}


module.exports = { STATUSES, create, listAll, getOne, updateStatus };
