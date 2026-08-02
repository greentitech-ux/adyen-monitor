// index.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

const store = require('./store');
const { normalize } = require('./normalize');
const { lookupBank } = require('./binLookup');
const push = require('./push');
const cardTesting = require('./cardTesting');
const cardHopping = require('./cardHopping');
const disputes = require('./disputes');
const fraudMarks = require('./fraudMarks');
const fraudReport = require('./fraudReport');
const storage = require('./storage');
const auth = require('./auth');
const users = require('./users');
const vaultGroups = require('./vaultGroups');
const vaultSubgroups = require('./vaultSubgroups');
const vaultEntries = require('./vaultEntries');
const vaultExport = require('./vaultExport');
const refunds = require('./refunds');
const fechamentosLive = require('./fechamentosLive');
const sangrias = require('./sangrias');
const entregasLive = require('./entregasLive');
const backup = require('./backup');
const sheetsSync = require('./sheetsSync');
const entregasSync = require('./entregasSync');

const upload = multer({
  storage: multer.memoryStorage(),
  // anexos de disputa incluem foto/print (pequenos), mas tambem video e audio
  // de ligacao (maiores) - ate 8 arquivos de 50MB cada por registro
  limits: { fileSize: 50 * 1024 * 1024, files: 8 },
});

const app = express();

// ---------- autenticacao basica pro dashboard/API ----------
// protege tudo (dashboard, APIs, imagens/videos anexados) atras de usuario e
// senha - o webhook da Adyen fica de fora (ja e verificado por assinatura
// HMAC, e a Adyen nao manda esse header). Sem DASHBOARD_USER/PASSWORD
// configurados, o site fica aberto (so pra facilitar teste local). Essa e
// so a primeira camada (quem tem a senha do site) - por dentro dela, cada
// pessoa loga com sua propria conta (veja auth.js) e so ve o que o Master
// liberou pra ela.
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
function senhasIguais(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
if (DASHBOARD_USER && DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/webhooks/adyen') return next();
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [user, ...rest] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      const pass = rest.join(':');
      if (senhasIguais(user, DASHBOARD_USER) && senhasIguais(pass, DASHBOARD_PASSWORD)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Zenith Ops"');
    res.status(401).send('Autenticação necessária.');
  });
} else {
  console.warn('AVISO: DASHBOARD_USER/DASHBOARD_PASSWORD nao configurados - o dashboard esta acessivel sem senha.');
}

app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// identificador unico deste processo - muda a cada deploy/restart. O
// dashboard usa isso pra recarregar sozinho quando detecta que o servidor
// subiu uma versao nova, sem precisar que alguem aperte "atualizar".
const BOOT_ID = crypto.randomUUID();

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

// ---------- login (sem token ainda) e portao de autenticacao pro resto da API ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const result = await auth.login(req.body.email, req.body.password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// tudo abaixo daqui exige um usuario logado (token JWT, via header ou
// ?token= - o EventSource do SSE usa a query porque nao manda headers custom)
app.use('/api', auth.requireAuth);

app.get('/api/me', (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role, permissions: req.permissions });
});

// so a secao pedida bloqueia quem nao tem permissao - Master sempre passa
function requireSection(section) {
  return (req, res, next) => {
    if (!auth.hasSection(req, section)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    next();
  };
}

// ---------- clientes SSE conectados (para empurrar atualizacoes ao vivo pro dashboard) ----------
// cada cliente guarda suas proprias permissoes, pra so receber eventos das
// unidades/secoes que ele pode ver
const sseClients = new Set();
function broadcast(event, data, section) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (!client.isMaster) {
      if (section && !client.sections.has(section)) continue;
      if (data && data.unidade && !client.unidades.has(data.unidade)) continue;
    }
    client.res.write(payload);
  }
}

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ bootId: BOOT_ID })}\n\n`);
  const client = {
    res,
    isMaster: req.isMaster,
    sections: req.isMaster ? null : new Set(req.permissions.sections || []),
    unidades: req.isMaster ? null : new Set(req.permissions.unidades || []),
  };
  sseClients.add(client);
  req.on('close', () => sseClients.delete(client));
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
    broadcast('transaction', tx, 'monitor');
    push.notify(tx); // estorno, estorno agendado, chargeback ou fraude -> push no celular/navegador

    // recusas seguidas do mesmo cartao em poucos minutos -> possivel teste de cartao clonado
    if (tx.status === 'RECUSADO') {
      const alerta = cardTesting.registrarRecusa(tx);
      if (alerta) {
        push.notifyRaw(
          `Possível teste de cartão — ${tx.unidade || ''}`,
          `${alerta.tentativas} recusas seguidas do cartão •• ${tx.last4} em ${alerta.janelaMinutos} min`,
          `card-testing-${tx.unidade}-${tx.last4}`,
          tx.unidade
        );
      }
    }

    // mesmo cliente (mesmo nome) testando varios finais de cartao DIFERENTES
    // ate um aprovar, num intervalo curto -> padrao classico de cartao
    // clonado/roubado. Quando detecta, marca o pedido aprovado como FRAUDE
    // automaticamente, na mesma fila do botao manual "Marcar fraude" -
    // aparece no painel/monitor sem precisar de ninguem clicar
    if (tx.status === 'RECUSADO' || tx.status === 'APROVADO') {
      const padraoTroca = cardHopping.registrarTentativa(tx);
      if (padraoTroca) {
        try {
          const pedidoId = tx.merchantReference || tx.originalReference || tx.pspReference;
          const clienteNome = tx.nomeCliente || tx.cardHolder || null;
          const registro = await fraudMarks.marcar({
            pedidoId,
            unidade: tx.unidade,
            nivel: 'FRAUDE',
            motivo: `Detecção automática: ${padraoTroca.cartoesDistintos} finais de cartão diferentes testados pelo mesmo cliente em ${padraoTroca.janelaMinutos} min antes de aprovar.`,
            clienteChave: clienteNome ? `nome:${clienteNome}` : null,
            clienteNome,
            statusPedido: tx.status,
            valor: tx.valor,
            marcadoPorEmail: 'deteccao-automatica@sistema',
          });
          broadcast('fraude-marcada', registro, 'monitor');
          push.notifyRaw(
            `🚫 Fraude detectada automaticamente — ${tx.unidade || ''}`,
            `${clienteNome || 'Cliente'} testou ${padraoTroca.cartoesDistintos} cartões diferentes até aprovar`,
            `fraude-auto-${pedidoId}`,
            tx.unidade
          );
        } catch (err) {
          console.error('Erro ao marcar fraude automática (troca de cartão):', err.message);
        }
      }
    }

    // cliente ja identificado como fraude em algum pedido anterior (mesmo
    // nome, MESMO SE trocar de bandeira/final de cartao) -> qualquer pedido
    // novo dele tambem entra automaticamente como FRAUDE, sem precisar
    // repetir o padrao de troca de cartao de novo. Preferimos alertar
    // demais a deixar passar batido - o Master sempre pode remover a
    // marcacao de um pedido especifico se for engano; o nome continua
    // sendo monitorado pros proximos pedidos mesmo assim
    {
      const pedidoIdAtual = tx.merchantReference || tx.originalReference || tx.pspReference;
      const nomeAtual = tx.nomeCliente || tx.cardHolder || null;
      if (nomeAtual) {
        try {
          const marcasExistentes = await fraudMarks.listAll();
          const nomeNormalizado = fraudMarks.normalizarNome(nomeAtual);
          const jaConhecido = marcasExistentes.some(
            (m) => m.nivel === 'FRAUDE' && fraudMarks.normalizarNome(m.clienteNome) === nomeNormalizado
          );
          const jaMarcadoNesse = marcasExistentes.some((m) => m.pedidoId === pedidoIdAtual);
          if (jaConhecido && !jaMarcadoNesse) {
            const registro = await fraudMarks.marcar({
              pedidoId: pedidoIdAtual,
              unidade: tx.unidade,
              nivel: 'FRAUDE',
              motivo: 'Cliente já identificado como fraude em pedido(s) anterior(es) (mesmo nome, outro cartão).',
              clienteChave: `nome:${nomeAtual}`,
              clienteNome: nomeAtual,
              statusPedido: tx.status,
              valor: tx.valor,
              marcadoPorEmail: 'deteccao-automatica@sistema',
            });
            broadcast('fraude-marcada', registro, 'monitor');
            push.notifyRaw(
              `🚫 Fraude (cliente já conhecido) — ${tx.unidade || ''}`,
              `${nomeAtual} já tinha pedido marcado como fraude antes`,
              `fraude-auto-${pedidoIdAtual}`,
              tx.unidade
            );
          }
        } catch (err) {
          console.error('Erro ao propagar marcação de fraude por nome:', err.message);
        }
      }
    }

    // se esse pedido ja tinha outro status antes (ex: APROVADO -> ESTORNADO -> CHARGEBACK),
    // avisa o dashboard pra atualizar a secao de pedidos que mudaram de status
    const order = store.orderFor(tx.merchantReference || tx.originalReference || tx.pspReference);
    if (order && new Set(order.history.map((h) => h.status)).size > 1) {
      broadcast('order-changed', order, 'monitor');
    }

    // avisa o dashboard pra atualizar a secao dedicada de chargebacks
    if (['CHARGEBACK', 'CHARGEBACK_REVERTIDO', 'NOTIFICATION_OF_CHARGEBACK', 'DISPUTE_DEFENSE_PERIOD_ENDED', 'RETRIEVAL_REQUEST'].includes(tx.status)) {
      broadcast('chargeback', order || tx, 'monitor');
    }

    // BIN lookup assincrono (nao bloqueia a resposta do webhook - a Adyen espera resposta rapida)
    if (tx.bin) {
      lookupBank(tx.bin).then((bank) => {
        if (bank) {
          const updated = { ...tx, bancoEmissor: bank };
          store.addOrUpdate(updated);
          broadcast('update', updated, 'monitor');
        }
      });
    }
  }

  // a Adyen exige essa resposta exata, e rapido (poucos segundos)
  res.send('[accepted]');
});

// ---------- API para o dashboard (secao "monitor") ----------
app.get('/api/transactions', requireSection('monitor'), (req, res) => {
  res.json(auth.filterByUnidade(req, store.allTransactions()));
});

app.get('/api/clients/:key', requireSection('monitor'), (req, res) => {
  const allowed = req.isMaster ? null : new Set(req.permissions.unidades || []);
  res.json(store.clientStats(decodeURIComponent(req.params.key), allowed));
});

// comentario manual sobre um estorno (ex: "estornei eu mesmo pelo painel da Adyen")
app.patch('/api/transactions/:pspReference/:eventCode/comentario', requireSection('monitor'), (req, res) => {
  const eventCode = decodeURIComponent(req.params.eventCode);
  const existente = store.allTransactions().find((t) => t.pspReference === req.params.pspReference && t.eventCode === eventCode);
  if (!existente) return res.sendStatus(404);
  if (!req.isMaster && !(req.permissions.unidades || []).includes(existente.unidade)) return res.sendStatus(404);

  const tx = store.setComentario(req.params.pspReference, eventCode, req.body.comentario || '');
  broadcast('update', tx, 'monitor');
  res.json(tx);
});

app.get('/api/orders', requireSection('monitor'), (req, res) => {
  res.json(auth.filterByUnidade(req, store.allOrders()));
});

app.get('/api/orders/changed', requireSection('monitor'), (req, res) => {
  res.json(auth.filterByUnidade(req, store.ordersChanged()));
});

app.get('/api/chargebacks', requireSection('monitor'), (req, res) => {
  res.json(auth.filterByUnidade(req, store.chargebacks()));
});

// ---------- marcacao manual de suspeita/fraude por pedido (monitoramento
// efetivo, separado do status que vem da Adyen - esse continua intacto) ----------
app.get('/api/fraude', requireSection('monitor'), (req, res) => {
  fraudMarks.listAll().then((lista) => res.json(auth.filterByUnidade(req, lista)));
});

app.post('/api/fraude/marcar', requireSection('monitor'), async (req, res) => {
  try {
    const { pedidoId, unidade, nivel, motivo, clienteChave, clienteNome, statusPedido, valor } = req.body;
    if (!req.isMaster && unidade && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await fraudMarks.marcar({
      pedidoId, unidade, nivel, motivo, clienteChave, clienteNome, statusPedido, valor,
      marcadoPorEmail: req.user.email,
    });
    broadcast('fraude-marcada', registro, 'monitor');
    if (nivel === 'FRAUDE') {
      push.notifyRaw(
        '🚫 Pedido marcado como fraude',
        `${registro.clienteNome || 'Cliente'} · ${registro.unidade || ''}${registro.motivo ? ' · ' + registro.motivo : ''}`,
        `fraude-${registro.pedidoId}`,
        registro.unidade
      );
    }
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/fraude/:pedidoId', requireSection('monitor'), async (req, res) => {
  await fraudMarks.remover(decodeURIComponent(req.params.pedidoId), req.user.email);
  broadcast('fraude-removida', { pedidoId: req.params.pedidoId }, 'monitor');
  res.json({ ok: true });
});

// ---------- relatorio de fraude (Master) - resumo por cliente pra
// apresentar incidentes (quantidade, se algum pedido passou, acao tomada) -
// usa o historico completo (inclui marcacoes ja removidas) ----------
app.get('/api/fraude/relatorio.csv', auth.requireMaster, async (req, res) => {
  const { inicio, fim } = req.query;
  const historico = await fraudMarks.listHistorico();
  const filtrado = historico.filter((m) => (!inicio || (m.criadoEm || '') >= inicio) && (!fim || (m.criadoEm || '') <= fim + 'T23:59:59'));
  const linhas = fraudReport.agruparPorCliente(filtrado);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fraudReport.slugify('relatorio-fraude')}.csv"`);
  res.send(fraudReport.toCSV(linhas));
});

app.get('/api/fraude/relatorio.pdf', auth.requireMaster, async (req, res) => {
  const { inicio, fim } = req.query;
  const historico = await fraudMarks.listHistorico();
  const filtrado = historico.filter((m) => (!inicio || (m.criadoEm || '') >= inicio) && (!fim || (m.criadoEm || '') <= fim + 'T23:59:59'));
  const linhas = fraudReport.agruparPorCliente(filtrado);
  const periodo = inicio || fim ? ` · período: ${inicio || 'início'} a ${fim || 'hoje'}` : '';
  const subtitulo = `Exportado em ${new Date().toLocaleString('pt-BR')}${periodo} · ${linhas.length} cliente(s) monitorado(s)`;
  fraudReport.writePDF(res, { titulo: 'Relatório de Fraude', subtitulo, linhas });
});

app.get('/api/summary', requireSection('monitor'), (req, res) => {
  const all = auth.filterByUnidade(req, store.allTransactions());
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

// unidades da planilha de fechamento - IDs proprios (codigo da loja ARCFOOD
// ou nome da loja do Grupo Bravo), diferentes do merchantAccountCode da
// Adyen. Ficam fixos aqui porque uma unidade pode precisar de permissao
// mesmo antes de ter qualquer transacao Adyen ou fechamento lancado.
const FECHAMENTO_UNIDADES_NOMES = {
  '19821': 'São Miguel (Fechamento)', '19855': 'Carrão (Fechamento)', '19888': 'Mooca (Fechamento)', '19889': 'Tatuapé (Fechamento)',
  "Domino's Carrinho Aeroporto Recife": "Domino's Carrinho Aeroporto Recife",
  'Dominos Bessa': 'Dominos Bessa',
  'Dominos Campina Grande': 'Dominos Campina Grande',
  'Dominos Caruaru': 'Dominos Caruaru',
  'Dominos Garanhuns': 'Dominos Garanhuns',
  'Dominos Praça Aeroporto Recife': 'Dominos Praça Aeroporto Recife',
  'Dominos Tirol': 'Dominos Tirol',
  'Milky Moo Tirol': 'Milky Moo Tirol',
  'Spoleto Praça Aeroporto Recife': 'Spoleto Praça Aeroporto Recife',
  'Spoleto Shopping Recife': 'Spoleto Shopping Recife',
  'Spoleto Shopping Tacaruna': 'Spoleto Shopping Tacaruna',
  'São Braz IL': 'São Braz IL',
};

// unidades do app de entregas (motoboys) - nomes como aparecem nas planilhas
// atuais do AppSheet ("MOTOS BRAVO"); igual ao Fechamento, ficam fixas aqui
// pra ja aparecerem no checklist de permissoes mesmo antes de qualquer
// lançamento. O Master pode liberar mais conforme novas unidades entrarem
// (o app de entregas ainda esta sendo migrado loja a loja do AppSheet).
const ENTREGAS_UNIDADES_NOMES = {
  'Tirol Natal': 'Tirol Natal (Entregas)',
  'MMTirol Natal': 'Milky Moo Tirol Natal (Entregas)',
  Bessa: 'Bessa (Entregas)',
  Caruaru: 'Caruaru (Entregas)',
  Garanhuns: 'Garanhuns (Entregas)',
};

// lista de unidades pra montar o seletor de permissoes na tela de Usuarios -
// junta as unidades ja vistas nas transacoes Adyen (secoes Monitor/Disputas)
// com as unidades fixas de Fechamento/Lançamento/Entregas (espacos de codigo
// diferentes, nao e o merchantAccountCode da Adyen) e as que ja aparecem nos
// dados importados/lançados, pra nunca faltar opcao no checklist do Master
app.get('/api/meta/unidades', auth.requireMaster, async (req, res) => {
  const mapa = {};
  store.allTransactions().forEach((t) => { if (t.unidade) mapa[t.unidade] = mapa[t.unidade] || t.unidade; });
  Object.entries(FECHAMENTO_UNIDADES_NOMES).forEach(([codigo, nome]) => { mapa[codigo] = nome; });
  Object.entries(ENTREGAS_UNIDADES_NOMES).forEach(([codigo, nome]) => { mapa[codigo] = mapa[codigo] || nome; });
  require('./fechamentos-snapshot.json').forEach((f) => { if (f.unidade) mapa[f.unidade] = f.unidadeNome || mapa[f.unidade] || f.unidade; });
  (await fechamentosLive.listAll()).forEach((f) => { if (f.unidade) mapa[f.unidade] = f.unidadeNome || mapa[f.unidade] || f.unidade; });
  entregasHistoricoData.forEach((e) => { if (e.unidade) mapa[e.unidade] = e.unidadeNome || mapa[e.unidade] || e.unidade; });
  (await entregasLive.listAll()).forEach((e) => { if (e.unidade) mapa[e.unidade] = e.unidadeNome || mapa[e.unidade] || e.unidade; });
  const lista = Object.entries(mapa)
    .map(([codigo, nome]) => ({ codigo, nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  res.json(lista);
});

// ---------- registros de disputa/monitoramento (secao "disputas") ----------
function disputaPermitida(req, registro) {
  if (!registro) return false;
  if (req.isMaster) return true;
  return !registro.unidade || (req.permissions.unidades || []).includes(registro.unidade);
}

app.post('/api/disputes', requireSection('disputas'), upload.array('anexos', 8), async (req, res) => {
  try {
    const { pedidoId, unidade, nomeContato, telefoneContato, notas } = req.body;
    if (!pedidoId) return res.status(400).json({ error: 'pedidoId é obrigatório' });
    if (!req.isMaster && unidade && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }

    const anexos = [];
    for (const file of req.files || []) {
      const path = await storage.salvarArquivo(pedidoId, file);
      anexos.push({ nome: file.originalname, path, tipo: file.mimetype || 'application/octet-stream' });
    }

    const registro = await disputes.create({ pedidoId, unidade, nomeContato, telefoneContato, notas, anexos });
    broadcast('dispute-changed', { pedidoId: registro.pedidoId, status: registro.status, unidade: registro.unidade }, 'disputas');
    res.json(registro);
  } catch (err) {
    console.error('Erro ao criar disputa:', err.message);
    res.status(500).json({ error: 'Erro ao salvar disputa' });
  }
});

app.get('/api/disputes', requireSection('disputas'), async (req, res) => {
  res.json(auth.filterByUnidade(req, (await disputes.listAll()).filter((d) => req.isMaster || !d.unidade || (req.permissions.unidades || []).includes(d.unidade))));
});

app.get('/api/disputes/:pedidoId', requireSection('disputas'), async (req, res) => {
  const lista = await disputes.listByPedido(decodeURIComponent(req.params.pedidoId));
  res.json(lista.filter((d) => disputaPermitida(req, d)));
});

app.patch('/api/disputes/:id/status', requireSection('disputas'), async (req, res) => {
  try {
    const atual = await disputes.getOne(req.params.id);
    if (!disputaPermitida(req, atual)) return res.sendStatus(404);
    const registro = await disputes.updateStatus(req.params.id, req.body.status);
    broadcast('dispute-changed', { pedidoId: registro.pedidoId, status: registro.status, unidade: registro.unidade }, 'disputas');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/disputes/:id', requireSection('disputas'), async (req, res) => {
  const atual = await disputes.getOne(req.params.id);
  if (!disputaPermitida(req, atual)) return res.sendStatus(404);
  await disputes.remove(req.params.id);
  res.json({ ok: true });
});

app.get('/api/disputes/anexo/:disputeId/:index', requireSection('disputas'), async (req, res) => {
  const registro = await disputes.getOne(req.params.disputeId);
  if (!disputaPermitida(req, registro)) return res.sendStatus(404);
  const anexo = registro && registro.anexos && registro.anexos[Number(req.params.index)];
  if (!anexo) return res.sendStatus(404);
  storage.streamArquivo(anexo.path, anexo.tipo, res);
});

// ---------- notificacoes push (estorno, estorno agendado, chargeback, fraude) ----------
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: push.PUBLIC_KEY });
});

app.post('/api/push/subscribe', async (req, res) => {
  // guarda quem e essa inscricao (Master ve tudo; usuario comum so recebe
  // alerta das unidades e secoes que ele tem acesso - sem isso o push
  // vazava fraude/chargeback/estorno de TODAS as unidades pra qualquer
  // pessoa logada que clicasse no sino, ignorando as permissoes dela)
  await push.addSubscription(req.body, {
    userId: req.user.id,
    isMaster: req.isMaster,
    unidades: req.isMaster ? null : (req.permissions.unidades || []),
    sections: req.isMaster ? null : (req.permissions.sections || []),
  });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  await push.removeSubscription(req.body.endpoint);
  res.json({ ok: true });
});

// ---------- cofre de senhas (secao "cofre") ----------
// grupos (ex: GBE) contem subgrupos (unidades, ex: DOM_BESSA, SPO_TACARUNA) -
// e nos subgrupos que as senhas ficam. Grupos/subgrupos sao da organizacao
// inteira; o Master decide quem enxerga qual SUBGRUPO (permissions.
// vaultSubgroups) - dentro de um subgrupo liberado, o usuario pode ver e
// gerenciar as senhas normalmente (o modo Leitor do Monitor nao se aplica
// aqui, senao toda troca de senha dependeria do Master).
function subgruposPermitidos(req) {
  return req.isMaster ? null : new Set(req.permissions.vaultSubgroups || []);
}

app.get('/api/vault/groups', requireSection('cofre'), async (req, res) => {
  res.json(await vaultGroups.list());
});

app.post('/api/vault/groups', auth.requireMaster, async (req, res) => {
  try {
    res.json(await vaultGroups.create(req.body.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/vault/groups/:id', auth.requireMaster, async (req, res) => {
  try {
    res.json(await vaultGroups.rename(req.params.id, req.body.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/vault/groups/:id', auth.requireMaster, async (req, res) => {
  try {
    await vaultGroups.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// lista de subgrupos - Master ve todos (pra montar a arvore inteira e a tela
// de usuarios); usuario comum so ve os subgrupos liberados pra ele
app.get('/api/vault/subgroups', requireSection('cofre'), async (req, res) => {
  const todos = await vaultSubgroups.listAll();
  if (req.isMaster) return res.json(todos);
  const permitidos = subgruposPermitidos(req);
  res.json(todos.filter((s) => permitidos.has(s.id)));
});

app.post('/api/vault/subgroups', auth.requireMaster, async (req, res) => {
  try {
    res.json(await vaultSubgroups.create(req.body.groupId, req.body.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/vault/subgroups/:id', auth.requireMaster, async (req, res) => {
  try {
    res.json(await vaultSubgroups.rename(req.params.id, req.body.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/vault/subgroups/:id', auth.requireMaster, async (req, res) => {
  try {
    await vaultSubgroups.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/vault/entries', requireSection('cofre'), async (req, res) => {
  const permitidos = subgruposPermitidos(req); // null = Master, todos
  if (req.query.subgroupId) {
    if (permitidos && !permitidos.has(req.query.subgroupId)) return res.json([]);
    return res.json(await vaultEntries.listBySubgroups([req.query.subgroupId]));
  }
  res.json(await vaultEntries.listBySubgroups(permitidos ? [...permitidos] : null));
});

app.post('/api/vault/entries', requireSection('cofre'), async (req, res) => {
  try {
    const permitidos = subgruposPermitidos(req);
    const subgroupId = req.body.subgroupId || null;
    if (permitidos && (!subgroupId || !permitidos.has(subgroupId))) return res.status(403).json({ error: 'Você não tem acesso a esse subgrupo.' });
    res.json(await vaultEntries.create(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/vault/entries/:id', requireSection('cofre'), async (req, res) => {
  try {
    const permitidos = subgruposPermitidos(req);
    const atual = await vaultEntries.get(req.params.id);
    if (!atual) return res.sendStatus(404);
    if (permitidos && (!atual.subgroupId || !permitidos.has(atual.subgroupId))) return res.sendStatus(404);
    if (permitidos && req.body.subgroupId !== undefined && (!req.body.subgroupId || !permitidos.has(req.body.subgroupId))) {
      return res.status(403).json({ error: 'Você não tem acesso a esse subgrupo.' });
    }
    res.json(await vaultEntries.update(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/vault/entries/:id', requireSection('cofre'), async (req, res) => {
  try {
    const permitidos = subgruposPermitidos(req);
    const atual = await vaultEntries.get(req.params.id);
    if (!atual) return res.sendStatus(404);
    if (permitidos && (!atual.subgroupId || !permitidos.has(atual.subgroupId))) return res.sendStatus(404);
    await vaultEntries.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// exporta o cofre (tudo, um grupo ou um subgrupo) em CSV ou PDF - so o Master
// (a senha vai em texto puro no arquivo, de proposito - e pra servir como
// inventario/backup). ?scope=all|group|subgroup&id=<groupId|subgroupId>
async function resolverEscopoExportacao(req) {
  const scope = ['group', 'subgroup'].includes(req.query.scope) ? req.query.scope : 'all';
  const id = req.query.id || null;
  const [groups, subgroups] = await Promise.all([vaultGroups.list(), vaultSubgroups.listAll()]);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const subgroupById = new Map(subgroups.map((s) => [s.id, s]));

  let subgroupIds = null; // null = tudo
  let titulo = 'Cofre de senhas · Todas as senhas';
  if (scope === 'subgroup') {
    const sub = subgroupById.get(id);
    if (!sub) throw new Error('Subgrupo não encontrado.');
    const grp = groupById.get(sub.groupId);
    subgroupIds = [sub.id];
    titulo = `Cofre de senhas · ${grp ? grp.name + ' / ' : ''}${sub.name}`;
  } else if (scope === 'group') {
    const grp = groupById.get(id);
    if (!grp) throw new Error('Grupo não encontrado.');
    subgroupIds = subgroups.filter((s) => s.groupId === id).map((s) => s.id);
    titulo = `Cofre de senhas · ${grp.name}`;
  }

  const entries = await vaultEntries.listBySubgroups(subgroupIds);
  const rows = entries
    .map((e) => {
      const sub = e.subgroupId ? subgroupById.get(e.subgroupId) : null;
      const grp = sub ? groupById.get(sub.groupId) : null;
      return {
        grupo: grp ? grp.name : '',
        subgrupo: sub ? sub.name : '',
        titulo: e.title,
        url: e.url,
        usuario: e.username,
        senha: e.password,
        observacao: e.note,
        atualizadoEm: e.updatedAt,
      };
    })
    .sort((a, b) => (a.grupo + a.subgrupo + a.titulo).localeCompare(b.grupo + b.subgrupo + b.titulo, 'pt-BR'));

  return { titulo, rows };
}

app.get('/api/vault/export.csv', auth.requireMaster, async (req, res) => {
  try {
    const { titulo, rows } = await resolverEscopoExportacao(req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${vaultExport.slugify(titulo)}.csv"`);
    res.send(vaultExport.toCSV(rows));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/vault/export.pdf', auth.requireMaster, async (req, res) => {
  try {
    const { titulo, rows } = await resolverEscopoExportacao(req);
    const subtitulo = `Exportado em ${new Date().toLocaleString('pt-BR')} · ${rows.length} senha(s)`;
    vaultExport.writePDF(res, { titulo, subtitulo, rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- solicitacoes de estorno (usuario Leitor pede, Master aprova/rejeita) ----------
app.post('/api/refund-requests', requireSection('monitor'), async (req, res) => {
  try {
    const { pedidoId, unidade, observacao, password } = req.body;
    if (!req.isMaster && unidade && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const senhaOk = await auth.verifyPassword(req.user.id, password);
    if (!senhaOk) return res.status(401).json({ error: 'Senha incorreta.' });

    const registro = await refunds.create({
      pedidoId,
      unidade,
      observacao,
      requestedById: req.user.id,
      requestedByEmail: req.user.email,
    });
    broadcast('refund-requested', registro, 'monitor');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/refund-requests', requireSection('monitor'), async (req, res) => {
  const todas = await refunds.listAll();
  if (req.isMaster) return res.json(auth.filterByUnidade(req, todas));
  res.json(todas.filter((r) => r.requestedById === req.user.id));
});

app.patch('/api/refund-requests/:id/status', auth.requireMaster, async (req, res) => {
  try {
    const registro = await refunds.updateStatus(req.params.id, req.body.status, {
      motivoDecisao: req.body.motivoDecisao,
      decidedByEmail: req.user.email,
    });
    broadcast('refund-request-changed', registro, 'monitor');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- gestao de usuarios (so o Master) ----------
app.get('/api/users', auth.requireMaster, async (req, res) => {
  res.json(await users.list());
});

app.post('/api/users', auth.requireMaster, async (req, res) => {
  try {
    res.json(await users.create(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/permissions', auth.requireMaster, async (req, res) => {
  try {
    res.json(await users.updatePermissions(req.params.id, req.body.permissions));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/active', auth.requireMaster, async (req, res) => {
  try {
    res.json(await users.setActive(req.params.id, req.body.active));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/users/:id/reset-password', auth.requireMaster, async (req, res) => {
  try {
    res.json(await users.resetPassword(req.params.id, req.body.password));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', auth.requireMaster, async (req, res) => {
  try {
    await users.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- backup do banco (so o Master ve/aciona) ----------
app.get('/api/backups', auth.requireMaster, async (req, res) => {
  try {
    res.json(await backup.listarBackups());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backups/run', auth.requireMaster, async (req, res) => {
  try {
    res.json(await backup.rodarBackup());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- fechamentos de caixa (secao "fechamentos") ----------
// combina os fechamentos das planilhas do Google Sheets (ARCFOOD + Grupo
// Bravo, aba "BD") com os fechamentos lançados ao vivo pelas lojas. As
// unidades aqui (19821/19855/19888/19889, ou o nome da loja no Grupo Bravo)
// sao codigos proprios da planilha, num espaco diferente do
// merchantAccountCode da Adyen usado em Monitor/Disputas - mas o mesmo campo
// permissions.unidades e reaproveitado pra filtrar as duas coisas (o Master
// escolhe os codigos certos pelo seletor de /api/meta/unidades, que junta os
// dois espacos).
//
// fechamentosData comeca com o snapshot estatico (fallback pro caso da 1a
// sincronizacao ainda nao ter rodado, ou de a API do Sheets estar fora do
// ar) e e substituido pelos dados frescos da planilha assim que
// sincronizarPlanilhasFechamento roda com sucesso (no boot e a cada
// SHEETS_SYNC_INTERVAL_MS).
let fechamentosData = require('./fechamentos-snapshot.json');
let statusSincronizacaoPlanilhas = { ultimaEm: null, ultimoErro: null, sincronizando: false };

async function sincronizarPlanilhasFechamento() {
  if (statusSincronizacaoPlanilhas.sincronizando) return statusSincronizacaoPlanilhas;
  statusSincronizacaoPlanilhas.sincronizando = true;
  try {
    const dados = await sheetsSync.sincronizar();
    if (dados.length) {
      fechamentosData = dados;
      statusSincronizacaoPlanilhas.ultimaEm = new Date().toISOString();
      statusSincronizacaoPlanilhas.ultimoErro = null;
      console.log(`Fechamentos: sincronizados ${dados.length} registros das planilhas do Google Sheets.`);
    } else {
      statusSincronizacaoPlanilhas.ultimoErro = 'A sincronização rodou mas não retornou nenhuma linha - planilhas continuam com os dados anteriores.';
      console.warn(statusSincronizacaoPlanilhas.ultimoErro);
    }
  } catch (err) {
    statusSincronizacaoPlanilhas.ultimoErro = err.message;
    console.error('Erro ao sincronizar planilhas de fechamento:', err.message);
  } finally {
    statusSincronizacaoPlanilhas.sincronizando = false;
  }
  return statusSincronizacaoPlanilhas;
}

app.get('/api/fechamentos', requireSection('fechamentos'), async (req, res) => {
  const lancados = await fechamentosLive.listAll();
  const sangriasLancadas = (await sangrias.listAll()).map(sangrias.comoFechamento);
  const combinado = sheetsSync.mesclarLancamentosDoMesmoDia([...fechamentosData, ...lancados, ...sangriasLancadas]);
  res.json(auth.filterByUnidade(req, combinado));
});

app.get('/api/fechamentos/sincronizacao', requireSection('fechamentos'), (req, res) => {
  res.json(statusSincronizacaoPlanilhas);
});

// forca uma sincronizacao imediata com as planilhas - so o Master (evita
// disparar chamadas extras na API do Google sem necessidade)
app.post('/api/fechamentos/sincronizar-planilhas', auth.requireMaster, async (req, res) => {
  const status = await sincronizarPlanilhasFechamento();
  if (status.ultimoErro) return res.status(502).json(status);
  res.json(status);
});

// ---------- lancamento de fechamento pela propria loja (secao "lancamento") ----------
// substitui o AppSheet: a loja loga com um usuario proprio (papel "Fechamento",
// limitado a sua(s) unidade(s)) e lanca o fechamento do dia direto no banco.
// Depois de lancado o registro e imutavel - qualquer correcao vira um pedido
// que so o Master pode aprovar (fechamentosLive.js guarda o historico).
app.post('/api/fechamentos/lancar', requireSection('lancamento'), async (req, res) => {
  try {
    const { unidade, unidadeNome, grupo, data, gerente, campos, observacao, detalhesMaquinas, detalhesSaidas } = req.body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await fechamentosLive.create({
      unidade, unidadeNome, grupo, data, gerente, campos, observacao, detalhesMaquinas, detalhesSaidas,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
    });
    broadcast('fechamento-lancado', registro, 'lancamento');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/fechamentos/meus', requireSection('lancamento'), async (req, res) => {
  if (req.isMaster) return res.json(await fechamentosLive.listAll());
  res.json(await fechamentosLive.listByUnidades(req.permissions.unidades || []));
});

// ---------- sangria (retirada de caixa) registrada em campo, ao longo do
// dia - pensado pra quem visita varias lojas (ex: supervisor) e nao ta
// esperando o fechamento do dia sair pra lancar a retirada. Fica separado do
// fechamento e so e mesclado com ele na leitura (GET /api/fechamentos) ----------
app.post('/api/sangrias', requireSection('lancamento'), async (req, res) => {
  try {
    const { unidade, unidadeNome, grupo, data, valor, descricao } = req.body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await sangrias.criar({
      unidade, unidadeNome, grupo, data, valor, descricao,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
    });
    broadcast('sangria-lancada', registro, 'lancamento');
    broadcast('sangria-lancada', registro, 'fechamentos');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/sangrias/minhas', requireSection('lancamento'), async (req, res) => {
  if (req.isMaster) return res.json(await sangrias.listAll());
  res.json(await sangrias.listByUnidades(req.permissions.unidades || []));
});

app.post('/api/fechamentos/:id/solicitar-edicao', requireSection('lancamento'), async (req, res) => {
  try {
    const atual = await fechamentosLive.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Fechamento não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const pedido = await fechamentosLive.solicitarEdicao({
      fechamentoId: req.params.id,
      mudancas: req.body.mudancas,
      motivo: req.body.motivo,
      solicitadoPorId: req.user.id,
      solicitadoPorEmail: req.user.email,
    });
    broadcast('fechamento-edicao-solicitada', pedido, 'lancamento');
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// edicao direta de um lancamento - so o Master, sem passar pela fila de
// aprovacao (ele mesmo e quem aprovaria, entao pedir pra si mesmo so
// atrasaria); ainda assim fica registrado no historico do fechamento
app.patch('/api/fechamentos/:id/editar-direto', auth.requireMaster, async (req, res) => {
  try {
    const registro = await fechamentosLive.editarDireto({
      fechamentoId: req.params.id,
      mudancas: req.body.mudancas,
      motivo: req.body.motivo,
      editadoPorEmail: req.user.email,
    });
    broadcast('fechamento-editado-direto', registro, 'lancamento');
    broadcast('fechamento-editado-direto', registro, 'fechamentos');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// fila de pedidos de correcao - so o Master decide (aprova/rejeita), mas quem
// pediu pode acompanhar o status do proprio pedido
app.get('/api/fechamentos/edicoes', requireSection('lancamento'), async (req, res) => {
  const todas = await fechamentosLive.listarEdicoes();
  if (req.isMaster) return res.json(todas);
  res.json(todas.filter((p) => p.solicitadoPorId === req.user.id));
});

app.patch('/api/fechamentos/edicoes/:id', auth.requireMaster, async (req, res) => {
  try {
    const pedido = await fechamentosLive.decidirEdicao(req.params.id, req.body.status, {
      decididoPorEmail: req.user.email,
      motivoDecisao: req.body.motivoDecisao,
    });
    broadcast('fechamento-edicao-decidida', pedido, 'lancamento');
    broadcast('fechamento-edicao-decidida', pedido, 'fechamentos');
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- entregas (motoboys) - substitui o app de entregas do AppSheet ----------
// mesmo desenho do fechamento: secao "entregas-lancamento" e onde a loja
// lança as corridas dos entregadores do dia (varias por unidade+data, uma por
// entregador/turno); secao "entregas" e o dashboard de acompanhamento
// (Master ve tudo, cada loja so ve as suas unidades). Etiqueta (foto do
// comprovante/etiquetas do entregador) e opcional, guardada no mesmo Storage
// dos anexos de disputa.
//
// entregasHistoricoData: historico importado direto da planilha "MOTOS
// BRAVO" (AppSheet) via entregasSync - comeca vazio (so aparece depois da 1a
// sincronizacao, no boot) e e somente leitura (nao tem dono/permissao de
// edicao, so o Master ve as diferencas na planilha em si). A aba "BDMotos"
// fica de fora por enquanto (sem coluna Data preenchida - ver entregasSync.js).
let entregasHistoricoData = [];
let statusSincronizacaoEntregas = { ultimaEm: null, ultimoErro: null, sincronizando: false };

async function sincronizarPlanilhaEntregas() {
  if (statusSincronizacaoEntregas.sincronizando) return statusSincronizacaoEntregas;
  statusSincronizacaoEntregas.sincronizando = true;
  try {
    const dados = await entregasSync.sincronizar();
    if (dados.length) {
      entregasHistoricoData = dados;
      statusSincronizacaoEntregas.ultimaEm = new Date().toISOString();
      statusSincronizacaoEntregas.ultimoErro = null;
      console.log(`Entregas: sincronizados ${dados.length} registros historicos da planilha do Google Sheets.`);
    } else {
      statusSincronizacaoEntregas.ultimoErro = 'A sincronização rodou mas não retornou nenhuma linha - histórico continua com os dados anteriores.';
      console.warn(statusSincronizacaoEntregas.ultimoErro);
    }
  } catch (err) {
    statusSincronizacaoEntregas.ultimoErro = err.message;
    console.error('Erro ao sincronizar planilha de entregas:', err.message);
  } finally {
    statusSincronizacaoEntregas.sincronizando = false;
  }
  return statusSincronizacaoEntregas;
}

app.get('/api/entregas/sincronizacao', requireSection('entregas'), (req, res) => {
  res.json(statusSincronizacaoEntregas);
});

// forca uma sincronizacao imediata - so o Master (evita chamadas extras na API do Google sem necessidade)
app.post('/api/entregas/sincronizar-planilha', auth.requireMaster, async (req, res) => {
  const status = await sincronizarPlanilhaEntregas();
  if (status.ultimoErro) return res.status(502).json(status);
  res.json(status);
});

app.post('/api/entregas/lancar', requireSection('entregas-lancamento'), upload.single('etiqueta'), async (req, res) => {
  try {
    const { unidade, unidadeNome, data, entregador, campos, obsRetorno, obsExtra, observacao } = JSON.parse(req.body.payload || '{}');
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await entregasLive.create({
      unidade, unidadeNome, data, entregador, campos, obsRetorno, obsExtra, observacao,
      etiquetaFile: req.file || null,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
    });
    broadcast('entrega-lancada', registro, 'entregas-lancamento');
    broadcast('entrega-lancada', registro, 'entregas');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/entregas/meus', requireSection('entregas-lancamento'), async (req, res) => {
  if (req.isMaster) return res.json(await entregasLive.listAll());
  res.json(await entregasLive.listByUnidades(req.permissions.unidades || []));
});

// dashboard de acompanhamento (secao separada - pode ser liberada sem dar
// acesso de lançamento, e vice-versa) - junta o historico da planilha
// (AppSheet, somente leitura) com os lançamentos ao vivo pela loja
app.get('/api/entregas', requireSection('entregas'), async (req, res) => {
  res.json(auth.filterByUnidade(req, [...entregasHistoricoData, ...(await entregasLive.listAll())]));
});

app.get('/api/entregas/etiqueta/:id', (req, res, next) => {
  if (!req.isMaster && !auth.hasSection(req, 'entregas') && !auth.hasSection(req, 'entregas-lancamento')) {
    return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  }
  next();
}, async (req, res) => {
  const registro = await entregasLive.getOne(req.params.id);
  if (!registro || !registro.etiquetaPath) return res.sendStatus(404);
  if (!req.isMaster && !(req.permissions.unidades || []).includes(registro.unidade)) return res.sendStatus(404);
  storage.streamArquivo(registro.etiquetaPath, null, res);
});

app.post('/api/entregas/:id/solicitar-edicao', requireSection('entregas-lancamento'), async (req, res) => {
  try {
    const atual = await entregasLive.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Lançamento não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const pedido = await entregasLive.solicitarEdicao({
      entregaId: req.params.id,
      mudancas: req.body.mudancas,
      motivo: req.body.motivo,
      solicitadoPorId: req.user.id,
      solicitadoPorEmail: req.user.email,
    });
    broadcast('entrega-edicao-solicitada', pedido, 'entregas-lancamento');
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// edicao direta - so o Master, sem fila de aprovacao (ainda fica no historico)
app.patch('/api/entregas/:id/editar-direto', auth.requireMaster, async (req, res) => {
  try {
    const registro = await entregasLive.editarDireto({
      entregaId: req.params.id,
      mudancas: req.body.mudancas,
      motivo: req.body.motivo,
      editadoPorEmail: req.user.email,
    });
    broadcast('entrega-editada-direto', registro, 'entregas-lancamento');
    broadcast('entrega-editada-direto', registro, 'entregas');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/entregas/edicoes', requireSection('entregas-lancamento'), async (req, res) => {
  const todas = await entregasLive.listarEdicoes();
  if (req.isMaster) return res.json(todas);
  res.json(todas.filter((p) => p.solicitadoPorId === req.user.id));
});

app.patch('/api/entregas/edicoes/:id', auth.requireMaster, async (req, res) => {
  try {
    const pedido = await entregasLive.decidirEdicao(req.params.id, req.body.status, {
      decididoPorEmail: req.user.email,
      motivoDecisao: req.body.motivoDecisao,
    });
    broadcast('entrega-edicao-decidida', pedido, 'entregas-lancamento');
    broadcast('entrega-edicao-decidida', pedido, 'entregas');
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// mensagens amigaveis pros erros mais comuns de upload (arquivo grande demais,
// anexos demais) em vez de estourar uma pagina de erro generica do Express
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const mensagens = {
      LIMIT_FILE_SIZE: 'Arquivo muito grande (máximo 50MB por anexo).',
      LIMIT_FILE_COUNT: 'Muitos arquivos de uma vez (máximo 8 anexos por registro).',
      LIMIT_UNEXPECTED_FILE: 'Campo de arquivo inesperado no envio.',
    };
    return res.status(400).json({ error: mensagens[err.code] || 'Erro ao enviar anexo: ' + err.message });
  }
  next(err);
});

(async () => {
  await store.init(); // carrega o historico do Firestore antes de aceitar trafego
  await auth.ensureMaster(); // garante que existe um acesso Master pra logar

  app.listen(PORT, async () => {
    console.log(`Zenith Ops rodando em http://localhost:${PORT}`);
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

    // backup automatico do banco: roda no start e depois 1x/dia (o Master
    // tambem pode acionar na hora pela tela de Usuarios/Backup)
    backup.rodarBackup().catch((err) => console.error('Erro no backup automático:', err.message));
    setInterval(() => {
      backup.rodarBackup().catch((err) => console.error('Erro no backup automático:', err.message));
    }, 24 * 60 * 60 * 1000);

    // sincroniza os fechamentos com as planilhas do Google Sheets: roda no
    // start e depois periodicamente (15min por padrao - ajustavel via
    // SHEETS_SYNC_INTERVAL_MS). O Master tambem pode forçar pela tela.
    sincronizarPlanilhasFechamento();
    const intervaloSync = Number(process.env.SHEETS_SYNC_INTERVAL_MS) || 15 * 60 * 1000;
    setInterval(sincronizarPlanilhasFechamento, intervaloSync);

    // mesma logica pro historico de entregas (planilha "MOTOS BRAVO" do AppSheet)
    sincronizarPlanilhaEntregas();
    setInterval(sincronizarPlanilhaEntregas, intervaloSync);
  });
})();
