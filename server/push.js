// push.js
// Notificacoes push (navegador/celular) para eventos criticos: estorno,
// estorno agendado, chargeback e fraude suspeita.
const webpush = require('web-push');
const db = require('./firestore');

const COLLECTION = db.collection('push_subscriptions');

function subDocId(endpoint) {
  return Buffer.from(endpoint).toString('base64').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 400);
}

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (PUBLIC_KEY && PRIVATE_KEY) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

async function loadSubs() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}

// meta = { userId, isMaster, unidades, sections } - null em unidades/sections
// significa Master (sem restricao). Sem meta (inscricoes antigas, de antes
// dessa checagem existir) e tratado como sem permissao nenhuma, nao como
// acesso total - mais seguro pedir pra re-inscrever do que vazar alerta.
async function addSubscription(sub, meta) {
  await COLLECTION.doc(subDocId(sub.endpoint)).set({ ...sub, meta: meta || null }, { merge: true });
}

function podeReceber(sub, { unidade, section }) {
  const meta = sub.meta;
  if (!meta) return false; // inscricao antiga sem dono conhecido - nao arrisca
  if (meta.isMaster) return true;
  if (section && !(meta.sections || []).includes(section)) return false;
  if (unidade && !(meta.unidades || []).includes(unidade)) return false;
  return true;
}

// Master/Admin, independente de secao/unidade (mesma checagem que o Painel
// ja usa pra decidir quem ve o toast+som de solicitacao nova - ver
// mostrarNotificacaoSolicitacao em painel.html)
function podeReceberSolicitacao(sub) {
  const meta = sub.meta;
  return !!meta && (meta.isMaster || meta.isAdmin);
}

// quem acompanha o parque (painel ou check-in), pra avisar de um check-in
// automatico (ninguem confirmou a entrada fisica no horario previsto)
function podeReceberParque(sub, unidade) {
  const meta = sub.meta;
  if (!meta) return false;
  if (meta.isMaster) return true;
  const secoes = meta.sections || [];
  if (!secoes.includes('parque') && !secoes.includes('parque-checkin')) return false;
  if (unidade && !(meta.unidades || []).includes(unidade)) return false;
  return true;
}

async function removeSubscription(endpoint) {
  await COLLECTION.doc(subDocId(endpoint)).delete();
}

// eventos que merecem notificacao push (estorno, estorno agendado,
// chargeback, fraude suspeita)
function isAlertable(tx) {
  if (tx.fraudeSuspeita) return true;
  const alertStatuses = [
    'ESTORNADO',
    'FALHA_ESTORNO',
    'ESTORNO_AGENDADO',
    'CHARGEBACK',
    'CHARGEBACK_REVERTIDO',
    'NOTIFICATION_OF_CHARGEBACK',
  ];
  return alertStatuses.includes(tx.status);
}

function titleFor(tx) {
  if (tx.fraudeSuspeita) return `Fraude suspeita — ${tx.unidade || ''}`;
  const labels = {
    ESTORNADO: 'Estorno realizado',
    FALHA_ESTORNO: 'Falha no estorno',
    ESTORNO_AGENDADO: 'Estorno agendado',
    CHARGEBACK: 'Chargeback',
    CHARGEBACK_REVERTIDO: 'Chargeback revertido',
    NOTIFICATION_OF_CHARGEBACK: 'Aviso de chargeback',
  };
  return `${labels[tx.status] || tx.status} — ${tx.unidade || ''}`;
}

async function sendToAll(data, { unidade, section } = {}) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(data);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceber(sub, { unidade, section })) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      // inscricao expirada/invalida - remove
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push:', err.message);
      }
    }
  }
}

async function notify(tx) {
  if (!isAlertable(tx)) return;
  await sendToAll({
    title: titleFor(tx),
    body: `${tx.nomeCliente || tx.cardHolder || 'Cliente'} · R$ ${(tx.valor || 0).toFixed(2)}${tx.motivo ? ' · ' + tx.motivo : ''}`,
    tag: tx.pspReference,
  }, { unidade: tx.unidade, section: 'monitor' });
}

// alerta generico (ex: teste de cartao clonado) - nao depende de uma
// transacao especifica normalizada
async function notifyRaw(title, body, tag, unidade) {
  await sendToAll({ title, body, tag }, { unidade, section: 'monitor' });
}

// solicitacao nova na Central (estorno, ajuste de fechamento, pagamento,
// suporte de TI etc.) - vai so pra Master/Admin, que sao quem decide essas
// filas (mesmo publico do toast+som ja existente no Painel)
async function notifySolicitacao(title, body, tag) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify({ title, body, tag });
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberSolicitacao(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (solicitação):', err.message);
      }
    }
  }
}

// pedidos/envios do Abastecimento do Carrinho: notifica SO quem opera a
// ponta (secao informada) - Master/Admin ficam de fora de proposito, o
// alarme e assunto do balcao, nao da gestao
async function notifyAbastecimento(title, body, tag, secao) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify({ title, body, tag });
  const subs = await loadSubs();
  for (const sub of subs) {
    const meta = sub.meta;
    if (!meta || meta.isMaster || meta.isAdmin) continue;
    if (!(meta.sections || []).includes(secao)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (abastecimento):', err.message);
      }
    }
  }
}

// aviso de check-in automatico do parque (ninguem confirmou a entrada
// fisica ate o horario previsto - ver rodarAutoCheckins em parque.js)
async function notifyParqueAutoCheckin(title, body, tag, unidade) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify({ title, body, tag });
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberParque(sub, unidade)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (parque):', err.message);
      }
    }
  }
}

module.exports = {
  addSubscription, removeSubscription, notify, notifyRaw, notifySolicitacao, notifyAbastecimento, notifyParqueAutoCheckin, PUBLIC_KEY,
};
