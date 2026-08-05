// store.js
// Armazenamento em Cloud Firestore: mantem um cache em memoria (para as
// consultas sincronas que o resto do app espera) e persiste cada transacao
// como um documento na colecao "transactions", em segundo plano.

const db = require('./firestore');
const COLLECTION = db.collection('transactions');

let cache = [];

function docId(tx) {
  return `${tx.pspReference}__${tx.eventCode}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function init() {
  const snap = await COLLECTION.get();
  cache = snap.docs.map((d) => d.data());
}

function load() {
  return cache;
}

// retencao padrao quando ninguem passa um corte explicito (fallback de
// seguranca - o job normal e o relatorios.js, que passa o corte certo depois
// de gerar o PDF/CSV do periodo)
const RETENTION_DAYS = Number(process.env.RETENCAO_TRANSACOES_DIAS || 2);

// apaga transacoes velhas, MAS nunca apaga um pedido que em algum momento
// teve chargeback ou fraude suspeita - esses ficam retidos pra sempre, sem
// prazo, porque alimentam a tela de chargebacks (que precisa da linha do
// tempo inteira do pedido, nao so o evento isolado) e alertas futuros. Isso
// e avaliado por PEDIDO (orderKey), nao por evento: se um pedido teve
// chargeback, TODOS os eventos dele (aprovado, estornado, chargeback...)
// ficam guardados, senao a tela de chargeback perde o contexto.
async function pruneOld(cutoffMs) {
  const cutoff = cutoffMs ?? (Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const pedidosProtegidos = new Set(
    allOrders()
      .filter((o) => o.fraudeSuspeita || o.history.some((h) => CHARGEBACK_STATUSES.includes(h.status)))
      .map((o) => o.pedidoId)
  );

  const all = load();
  const kept = [];
  const removed = [];
  for (const t of all) {
    if (pedidosProtegidos.has(orderKey(t))) { kept.push(t); continue; }
    const ts = t.dataHora ? new Date(t.dataHora).getTime() : Date.now();
    (ts >= cutoff ? kept : removed).push(t);
  }

  if (removed.length) {
    cache = kept;
    // Firestore aceita no maximo 500 operacoes por batch
    for (let i = 0; i < removed.length; i += 450) {
      const lote = removed.slice(i, i + 450);
      const batch = db.batch();
      for (const t of lote) batch.delete(COLLECTION.doc(docId(t)));
      await batch.commit();
    }
  }
  return removed.length;
}

// chave de identidade do cliente: usa shopperReference se existir,
// senao cai para "cartao + nome" (o que der pra correlacionar sem PII completo)
function clientKey(tx) {
  return tx.shopperReference || `${tx.cardHolder || 'desconhecido'}::${tx.last4 || '----'}`;
}

function addOrUpdate(tx) {
  const all = load();
  // idempotencia: Adyen pode reenviar a mesma notificacao (mesmo pspReference + eventCode)
  const existingIdx = all.findIndex(
    (t) => t.pspReference === tx.pspReference && t.eventCode === tx.eventCode
  );
  let merged;
  if (existingIdx >= 0) {
    merged = { ...all[existingIdx], ...tx };
    cache[existingIdx] = merged;
  } else {
    merged = tx;
    cache.push(merged);
  }
  COLLECTION.doc(docId(merged))
    .set(merged, { merge: true })
    .catch((err) => console.error('Erro ao salvar transacao no Firestore:', err.message));
  return merged;
}

function allTransactions() {
  return load();
}

// comentario manual sobre um estorno especifico (ex: "estornei eu mesmo pelo
// painel da Adyen") - identificado pelo mesmo par pspReference+eventCode
// usado no resto do store
function setComentario(pspReference, eventCode, comentario) {
  const all = load();
  const idx = all.findIndex((t) => t.pspReference === pspReference && t.eventCode === eventCode);
  if (idx < 0) return null;
  const atualizado = { ...cache[idx], comentario, comentarioEm: new Date().toISOString() };
  cache[idx] = atualizado;
  COLLECTION.doc(docId(atualizado))
    .set(atualizado, { merge: true })
    .catch((err) => console.error('Erro ao salvar comentario no Firestore:', err.message));
  return atualizado;
}

// agrupa os eventos de um mesmo pedido (merchantReference) em uma linha do tempo -
// e assim conseguimos ver quando um pedido aprovado depois foi estornado, virou
// chargeback, etc. Alguns eventos (ex: OFFER_CLOSED) podem chegar sem
// merchantReference; nesse caso usamos originalReference (referencia pro
// pspReference do evento original) como segunda tentativa antes de cair pro
// proprio pspReference, pra nao criar um "pedido" fantasma que nunca atualiza.
function orderKey(tx) {
  return tx.merchantReference || tx.originalReference || tx.pspReference;
}

// pedidos que em algum momento entraram em chargeback (ou disputa relacionada) -
// mostra o pedido inteiro (nao so o evento de chargeback isolado), pra dar
// contexto: quando foi aprovado, quando virou chargeback, se foi revertido etc.
const CHARGEBACK_STATUSES = [
  'CHARGEBACK',
  'CHARGEBACK_REVERTIDO',
  'NOTIFICATION_OF_CHARGEBACK',
  'DISPUTE_DEFENSE_PERIOD_ENDED',
  'RETRIEVAL_REQUEST',
];
// so os eventos que marcam a abertura do chargeback em si (nao a reversao/fim
// de prazo) contam como "data do chargeback" pro filtro de periodo do painel
const ABERTURA_CHARGEBACK_STATUSES = ['CHARGEBACK', 'NOTIFICATION_OF_CHARGEBACK'];

function allOrders() {
  const all = load();
  const sorted = [...all].sort((a, b) => (a.dataHora || '').localeCompare(b.dataHora || ''));
  const map = new Map();
  for (const tx of sorted) {
    const key = orderKey(tx);
    if (!map.has(key)) {
      map.set(key, {
        pedidoId: key,
        unidade: tx.unidade,
        cliente: tx.cardHolder || tx.shopperReference || null,
        metodo: tx.metodo,
        last4: tx.last4,
        fraudeSuspeita: false,
        dataCompra: null,
        dataChargeback: null,
        prazoDefesa: null,
        history: [],
      });
    }
    const order = map.get(key);
    order.history.push({
      status: tx.status,
      eventCode: tx.eventCode,
      dataHora: tx.dataHora,
      valor: tx.valor,
      motivo: tx.motivo,
    });
    order.statusAtual = tx.status;
    order.ultimaAtualizacao = tx.dataHora;
    order.valor = tx.valor;
    order.fraudeSuspeita = order.fraudeSuspeita || !!tx.fraudeSuspeita;
    if (!order.last4 && tx.last4) order.last4 = tx.last4;
    if ((!order.cliente || order.cliente === order.unidade + ':') && (tx.cardHolder || tx.nomeCliente)) {
      order.cliente = tx.cardHolder || tx.nomeCliente;
    }
    if (tx.status === 'APROVADO' && !order.dataCompra) order.dataCompra = tx.dataHora;
    if (ABERTURA_CHARGEBACK_STATUSES.includes(tx.status) && !order.dataChargeback) order.dataChargeback = tx.dataHora;
    if (tx.prazoDefesa) order.prazoDefesa = tx.prazoDefesa;
  }
  return [...map.values()];
}

function orderFor(key) {
  return allOrders().find((o) => o.pedidoId === key) || null;
}

function ordersChanged() {
  return allOrders()
    .filter((o) => new Set(o.history.map((h) => h.status)).size > 1)
    .sort((a, b) => (b.ultimaAtualizacao || '').localeCompare(a.ultimaAtualizacao || ''));
}

function chargebacks() {
  return allOrders()
    .filter((o) => o.history.some((h) => CHARGEBACK_STATUSES.includes(h.status)))
    .sort((a, b) => (b.ultimaAtualizacao || '').localeCompare(a.ultimaAtualizacao || ''));
}

function clientStats(key, allowedUnidades) {
  const all = load();
  let rows = all.filter((t) => clientKey(t) === key);
  if (allowedUnidades) rows = rows.filter((t) => allowedUnidades.has(t.unidade));
  const aprovadas = rows.filter((t) => t.status === 'APROVADO').length;
  const recusadas = rows.filter((t) => t.status === 'RECUSADO').length;
  const fraude = rows.filter((t) => t.fraudeSuspeita).length;
  return {
    cliente: key,
    total: rows.length,
    aprovadas,
    recusadas,
    fraude,
    taxaAprovacao: rows.length ? +(aprovadas / rows.length * 100).toFixed(1) : 0,
    ultimaTransacao: rows.sort((a, b) => (b.dataHora || '').localeCompare(a.dataHora || ''))[0] || null,
  };
}

module.exports = {
  init,
  addOrUpdate,
  allTransactions,
  setComentario,
  clientStats,
  clientKey,
  pruneOld,
  allOrders,
  orderFor,
  ordersChanged,
  chargebacks,
};
