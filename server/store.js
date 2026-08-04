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

// retencao: mantem sempre os ultimos 3 meses de historico, descarta o resto
const RETENTION_DAYS = 90;

// carrega so a janela de retencao (nao a colecao inteira) - alem de ser o
// unico dado que o app realmente usa, evita reler documentos que ja
// deveriam ter sido podados por pruneOld(), reduzindo o custo de leitura
// no Firestore a cada reinicio do processo
async function init() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const snap = await COLLECTION.where('dataHora', '>=', cutoff).get();
  cache = snap.docs.map((d) => d.data());
}

function load() {
  return cache;
}

async function pruneOld() {
  const all = load();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const kept = [];
  const removed = [];
  for (const t of all) {
    const ts = t.dataHora ? new Date(t.dataHora).getTime() : Date.now();
    (ts >= cutoff ? kept : removed).push(t);
  }
  if (removed.length) {
    cache = kept;
    const batch = db.batch();
    for (const t of removed) batch.delete(COLLECTION.doc(docId(t)));
    await batch.commit();
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

// agrupa os eventos de um mesmo pedido (merchantReference) em uma linha do tempo -
// e assim conseguimos ver quando um pedido aprovado depois foi estornado, virou
// chargeback, etc.
function orderKey(tx) {
  return tx.merchantReference || tx.pspReference;
}

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
function chargebacks() {
  return allOrders()
    .filter((o) => o.history.some((h) => CHARGEBACK_STATUSES.includes(h.status)))
    .sort((a, b) => (b.ultimaAtualizacao || '').localeCompare(a.ultimaAtualizacao || ''));
}

function clientStats(key) {
  const all = load();
  const rows = all.filter((t) => clientKey(t) === key);
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
  clientStats,
  clientKey,
  pruneOld,
  allOrders,
  orderFor,
  ordersChanged,
  chargebacks,
};
