// index.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const store = require('./store');
const { normalize } = require('./normalize');
const { lookupBank } = require('./binLookup');
const push = require('./push');
const cardTesting = require('./cardTesting');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// chaves HMAC por merchant account (cada webhook na Adyen tem a sua propria chave).
// aceita tanto o formato novo (ADYEN_HMAC_KEYS, um JSON) quanto o antigo
// (ADYEN_HMAC_KEY, uma unica chave usada para qualquer conta) para nao quebrar
// quem ainda nao migrou.
let HMAC_KEYS = {};
if (process.env.ADYEN_HMAC_KEYS) {
  try {
    HMAC_KEYS = JSON.parse(process.env.ADYEN_HMAC_KEYS);
  } catch (e) {
    console.error('ADYEN_HMAC_KEYS nao e um JSON valido:', e.message);
  }
}
const LEGACY_HMAC_KEY = process.env.ADYEN_HMAC_KEY || '';

// ---------- clientes SSE conectados (para empurrar atualizacoes ao vivo pro dashboard) ----------
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---------- validacao de assinatura HMAC da Adyen ----------
// https://docs.adyen.com/development-resources/webhooks/verify-hmac-signatures/
function hmacValid(item) {
  const key = HMAC_KEYS[item.merchantAccountCode] || LEGACY_HMAC_KEY;
  if (!key) return true; // ATENCAO: sem chave configurada para essa conta, aceitamos tudo (só para testes locais)
  const a = item.additionalData || {};
  const sign = a['hmacSignature'];
  if (!sign) return false;

  const fields = [
    item.pspReference,
    item.originalReference || '',
    item.merchantAccountCode,
    item.merchantReference,
    String(item.amount?.value ?? ''),
    item.amount?.currency ?? '',
    item.eventCode,
    String(item.success),
  ];
  const signingString = fields.join(':');
  const keyBuf = Buffer.from(key, 'hex');
  const hmac = crypto.createHmac('sha256', keyBuf).update(signingString, 'utf8').digest('base64');
  return hmac === sign;
}

// ---------- endpoint de webhook ----------
app.post('/webhooks/adyen', async (req, res) => {
  const items = req.body?.notificationItems || [];

  for (const wrapper of items) {
    const item = wrapper.NotificationRequestItem;
    if (!item) continue;

    if (!hmacValid(item)) {
      console.warn('Assinatura HMAC invalida, ignorando notificacao', item.pspReference);
      continue;
    }

    // eventos administrativos (ex: aviso de relatorio pronto) nao sao transacoes -
    // nao devem aparecer na lista de pedidos do dashboard
    if (item.eventCode === 'REPORT_AVAILABLE') {
      console.log('Relatorio disponivel:', item.reason);
      continue;
    }

    const tx = normalize(item);
    store.addOrUpdate(tx);
    broadcast('transaction', tx);
    push.notify(tx); // estorno, estorno agendado, chargeback ou fraude -> push no celular/navegador

    // recusas seguidas do mesmo cartao em poucos minutos -> possivel teste de cartao clonado
    if (tx.status === 'RECUSADO') {
      const alerta = cardTesting.registrarRecusa(tx);
      if (alerta) {
        push.notifyRaw(
          `Possível teste de cartão — ${tx.unidade || ''}`,
          `${alerta.tentativas} recusas seguidas do cartão •• ${tx.last4} em ${alerta.janelaMinutos} min`,
          `card-testing-${tx.unidade}-${tx.last4}`
        );
      }
    }

    // se esse pedido ja tinha outro status antes (ex: APROVADO -> ESTORNADO -> CHARGEBACK),
    // avisa o dashboard pra atualizar a secao de pedidos que mudaram de status
    const order = store.orderFor(tx.merchantReference || tx.pspReference);
    if (order && new Set(order.history.map((h) => h.status)).size > 1) {
      broadcast('order-changed', order);
    }

    // avisa o dashboard pra atualizar a secao dedicada de chargebacks
    if (['CHARGEBACK', 'CHARGEBACK_REVERTIDO', 'NOTIFICATION_OF_CHARGEBACK', 'DISPUTE_DEFENSE_PERIOD_ENDED', 'RETRIEVAL_REQUEST'].includes(tx.status)) {
      broadcast('chargeback', order || tx);
    }

    // BIN lookup assincrono (nao bloqueia a resposta do webhook - a Adyen espera resposta rapida)
    if (tx.bin) {
      lookupBank(tx.bin).then((bank) => {
        if (bank) {
          const updated = { ...tx, bancoEmissor: bank };
          store.addOrUpdate(updated);
          broadcast('update', updated);
        }
      });
    }
  }

  // a Adyen exige essa resposta exata, e rapido (poucos segundos)
  res.send('[accepted]');
});

// ---------- API para o dashboard ----------
app.get('/api/transactions', (req, res) => {
  res.json(store.allTransactions());
});

app.get('/api/clients/:key', (req, res) => {
  res.json(store.clientStats(decodeURIComponent(req.params.key)));
});

app.get('/api/orders', (req, res) => {
  res.json(store.allOrders());
});

app.get('/api/orders/changed', (req, res) => {
  res.json(store.ordersChanged());
});

app.get('/api/chargebacks', (req, res) => {
  res.json(store.chargebacks());
});

// ---------- notificacoes push (estorno, estorno agendado, chargeback, fraude) ----------
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: push.PUBLIC_KEY });
});

app.post('/api/push/subscribe', async (req, res) => {
  await push.addSubscription(req.body);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  await push.removeSubscription(req.body.endpoint);
  res.json({ ok: true });
});

app.get('/api/summary', (req, res) => {
  const all = store.allTransactions();
  const aprovadas = all.filter((t) => t.status === 'APROVADO');
  const recusadas = all.filter((t) => t.status === 'RECUSADO');
  res.json({
    total: all.length,
    aprovadas: aprovadas.length,
    recusadas: recusadas.length,
    volumeAprovado: +aprovadas.reduce((s, t) => s + t.valor, 0).toFixed(2),
    chargebacks: all.filter((t) => t.status.includes('CHARGEBACK')).length,
    fraudeSuspeita: all.filter((t) => t.fraudeSuspeita).length,
  });
});

app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  try {
    await store.init(); // carrega o historico do Firestore antes de aceitar trafego
  } catch (err) {
    console.error('Falha ao conectar no Firestore, encerrando:', err.message);
    process.exit(1);
  }

  app.listen(PORT, async () => {
    console.log(`Monitor Adyen rodando em http://localhost:${PORT}`);
    console.log(`Webhook: POST http://localhost:${PORT}/webhooks/adyen`);
    const contas = Object.keys(HMAC_KEYS);
    if (contas.length) console.log(`HMAC configurada para: ${contas.join(', ')}`);
    else if (!LEGACY_HMAC_KEY) console.warn('AVISO: nenhuma ADYEN_HMAC_KEYS/ADYEN_HMAC_KEY configurada - assinatura nao esta sendo verificada.');

    // mantem sempre os ultimos 3 meses de historico (roda no start e depois 1x/dia)
    const removidos = await store.pruneOld();
    if (removidos) console.log(`Retencao: removidas ${removidos} transacoes com mais de 90 dias.`);
    setInterval(() => {
      store.pruneOld().catch((err) => console.error('Erro na limpeza de retencao:', err.message));
    }, 24 * 60 * 60 * 1000);
  });
})();
