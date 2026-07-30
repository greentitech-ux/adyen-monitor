// store.js
// Armazenamento simples em arquivo JSON (sem dependencias nativas de banco).
// Para volumes grandes (dezenas de milhares de transacoes/dia), trocar por
// Postgres/SQLite depois é uma boa evolução - a interface (get/all/save) fica igual.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'transactions.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch (e) {
    cache = [];
  }
  return cache;
}

function persist() {
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 1));
}

// retencao: mantem sempre os ultimos 3 meses de historico, descarta o resto
const RETENTION_DAYS = 90;
function pruneOld() {
  const all = load();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const kept = all.filter((t) => {
    const ts = t.dataHora ? new Date(t.dataHora).getTime() : Date.now();
    return ts >= cutoff;
  });
  if (kept.length !== all.length) {
    cache = kept;
    persist();
  }
  return all.length - kept.length; // quantos foram removidos
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
  if (existingIdx >= 0) {
    all[existingIdx] = { ...all[existingIdx], ...tx };
  } else {
    all.push(tx);
  }
  persist();
  return tx;
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
