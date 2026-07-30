// push.js
// Notificacoes push (navegador/celular) para eventos criticos: estorno,
// estorno agendado, chargeback e fraude suspeita.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const FILE = path.join(__dirname, 'data', 'subscriptions.json');
if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (PUBLIC_KEY && PRIVATE_KEY) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

function loadSubs() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveSubs(subs) {
  fs.writeFileSync(FILE, JSON.stringify(subs, null, 1));
}

function addSubscription(sub) {
  const subs = loadSubs();
  if (!subs.find((s) => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    saveSubs(subs);
  }
}

function removeSubscription(endpoint) {
  const subs = loadSubs().filter((s) => s.endpoint !== endpoint);
  saveSubs(subs);
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

async function sendToAll(data) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(data);
  const subs = loadSubs();
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      // inscricao expirada/invalida - remove
      if (err.statusCode === 404 || err.statusCode === 410) {
        removeSubscription(sub.endpoint);
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
  });
}

// alerta generico (ex: teste de cartao clonado) - nao depende de uma
// transacao especifica normalizada
async function notifyRaw(title, body, tag) {
  await sendToAll({ title, body, tag });
}

module.exports = { addSubscription, removeSubscription, notify, notifyRaw, PUBLIC_KEY };
