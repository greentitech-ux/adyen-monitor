// festas.js
// Reservas de festa (Saltiverso Patteo) - agenda de eventos com sinal/
// restante e status de pagamento. Mesmo padrao de sangrias.js/parque.js:
// colecao Firestore propria, cache curto via liveCache.js.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('festas');

const STATUS_VALIDOS = ['pendente', 'pago', 'cancelado'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// codigo curto tipo "CA6063F" (mesmo estilo do app anterior) - nao precisa
// ser criptograficamente forte, so legivel e facil de citar por telefone
function gerarCodigo() {
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 7);
}

function sanitizarPagamento(p) {
  if (!p) return null;
  const valor = num(p.valor);
  if (!valor) return null;
  return {
    valor,
    forma: String(p.forma || '').trim().slice(0, 40),
    data: p.data || null,
  };
}

async function criar({
  unidade, cliente, dataVenda, dataDeUso, horaInicio, horaFim,
  valorTotal, sinal, restante, observacao, referenciaVendaOriginal,
  criadoPorId, criadoPorEmail,
}) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!cliente || !String(cliente.nome || '').trim()) throw new Error('Informe o nome do cliente.');
  if (!dataDeUso || !/^\d{4}-\d{2}-\d{2}$/.test(dataDeUso)) throw new Error('Informe a data do evento.');
  const total = num(valorTotal);
  if (total < 0) throw new Error('Valor total inválido.');

  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    codigo: gerarCodigo(),
    unidade,
    cliente: {
      nome: String(cliente.nome).trim().slice(0, 150),
      contato: String(cliente.contato || '').trim().slice(0, 30),
      email: String(cliente.email || '').trim().slice(0, 150),
    },
    dataVenda: dataVenda || new Date().toISOString().slice(0, 10),
    dataDeUso,
    horaInicio: horaInicio || null,
    horaFim: horaFim || null,
    valorTotal: total,
    sinal: sanitizarPagamento(sinal),
    restante: sanitizarPagamento(restante),
    status: 'pendente',
    utilizado: false,
    dataUtilizacao: null,
    observacao: String(observacao || '').slice(0, 500),
    referenciaVendaOriginal: referenciaVendaOriginal ? String(referenciaVendaOriginal).trim().slice(0, 20) : null,
    termoAssinado: false,
    criadoPorId,
    criadoPorEmail,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  festasCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('dataDeUso', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const festasCache = createCache(listAllUncached, 20 * 1000);
const listAll = festasCache.cached;

async function listByUnidades(unidades) {
  if (!unidades || !unidades.length) return [];
  const lotes = [];
  for (let i = 0; i < unidades.length; i += 30) lotes.push(unidades.slice(i, i + 30));
  const resultados = await Promise.all(lotes.map((lote) => COLLECTION.where('unidade', 'in', lote).get()));
  return resultados.flatMap((snap) => snap.docs.map((d) => d.data()));
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function atualizar(id, patch) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Reserva não encontrada.');
  const atual = snap.data();
  const merge = {};

  if (patch.cliente) merge.cliente = { ...atual.cliente, ...patch.cliente };
  if (patch.dataDeUso !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dataDeUso)) throw new Error('Data do evento inválida.');
    merge.dataDeUso = patch.dataDeUso;
  }
  if (patch.horaInicio !== undefined) merge.horaInicio = patch.horaInicio || null;
  if (patch.horaFim !== undefined) merge.horaFim = patch.horaFim || null;
  if (patch.valorTotal !== undefined) merge.valorTotal = num(patch.valorTotal);
  if (patch.sinal !== undefined) merge.sinal = sanitizarPagamento(patch.sinal);
  if (patch.restante !== undefined) merge.restante = sanitizarPagamento(patch.restante);
  if (patch.status !== undefined) {
    if (!STATUS_VALIDOS.includes(patch.status)) throw new Error('Status inválido.');
    merge.status = patch.status;
  }
  if (patch.utilizado !== undefined) {
    merge.utilizado = patch.utilizado === true;
    merge.dataUtilizacao = merge.utilizado ? (patch.dataUtilizacao || new Date().toISOString().slice(0, 10)) : null;
  }
  if (patch.observacao !== undefined) merge.observacao = String(patch.observacao).slice(0, 500);
  if (patch.termoAssinado !== undefined) merge.termoAssinado = patch.termoAssinado === true;

  merge.atualizadoEm = new Date().toISOString();
  await ref.update(merge);
  festasCache.invalidar();
  return getOne(id);
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Reserva não encontrada.');
  await COLLECTION.doc(id).delete();
  festasCache.invalidar();
}

module.exports = { STATUS_VALIDOS, criar, listAll, listByUnidades, getOne, atualizar, remover };
