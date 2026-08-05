// fraudMarks.js
// Marcacao manual/automatica de suspeita/fraude por pedido - independente do
// status que vem da Adyen (esse continua intacto, e so o campo "status" da
// transacao mesmo). Guarda tambem a "chave do cliente" (cartao+nome, ou so
// nome) e o clienteNome separadamente: e por clienteNome que a marcacao se
// propaga automaticamente pro proximo pedido desse mesmo cliente, mesmo que
// troque de bandeira/final de cartao (ver index.js, webhook).
//
// "Remover" nao apaga o registro (soft delete, campo `removido`) - assim o
// historico completo fica preservado pro Relatorio de Fraude (fraudReport.js)
// mesmo que uma marcacao tenha sido corrigida/removida por ser falso positivo.
const db = require('./firestore');
const COLLECTION = db.collection('fraudMarks');

const NIVEIS = ['SUSPEITO', 'FRAUDE'];

function docId(pedidoId) {
  return String(pedidoId).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function marcar({ pedidoId, unidade, nivel, motivo, clienteChave, clienteNome, statusPedido, valor, marcadoPorEmail }) {
  if (!pedidoId) throw new Error('pedidoId é obrigatório.');
  if (!NIVEIS.includes(nivel)) throw new Error('Nível inválido.');

  const ref = COLLECTION.doc(docId(pedidoId));
  const existente = await ref.get();
  const agora = new Date().toISOString();
  const registro = {
    id: ref.id,
    pedidoId,
    unidade: unidade || null,
    clienteChave: clienteChave || null,
    clienteNome: clienteNome || null,
    statusPedido: statusPedido || null,
    valor: valor || 0,
    nivel,
    motivo: motivo || '',
    // sempre volta a ficar ativo ao (re)marcar, mesmo que ja tivesse sido
    // removido antes (ex: o mesmo pedido entra de novo por outro motivo)
    removido: false,
    removidoEm: null,
    removidoPorEmail: null,
    criadoPorEmail: existente.exists ? existente.data().criadoPorEmail : marcadoPorEmail,
    criadoEm: existente.exists ? existente.data().criadoEm : agora,
    atualizadoPorEmail: marcadoPorEmail,
    atualizadoEm: agora,
  };
  await ref.set(registro);
  invalidarCache();
  return registro;
}

async function remover(pedidoId, removidoPorEmail) {
  const ref = COLLECTION.doc(docId(pedidoId));
  const snap = await ref.get();
  if (!snap.exists) return;
  await ref.update({
    removido: true,
    removidoEm: new Date().toISOString(),
    removidoPorEmail: removidoPorEmail || null,
  });
  invalidarCache();
}


// so as marcacoes ativas (usado no painel/monitor e na propagacao por nome)
async function listAll() {
  const snap = await COLLECTION.orderBy('atualizadoEm', 'desc').get();
  return snap.docs.map((d) => d.data()).filter((m) => !m.removido);
}

// cache em memoria de curta duracao (TTL) por cima de listAll() - essa
// funcao e chamada MUITAS vezes por segundo em picos de trafego (uma ou
// mais vezes por notificacao de webhook da Adyen, alem de toda vez que
// alguem abre/atualiza o painel de Monitor), e cada chamada relia a
// colecao INTEIRA do Firestore do zero. Isso multiplica muito rapido o
// numero de leituras e foi a causa mais provavel do "RESOURCE_EXHAUSTED"
// (cota diaria de leitura do Firestore estourada) que derrubava o app em
// crash-loop no Render. Com o cache, varias chamadas dentro da mesma
// janela de tempo reaproveitam o mesmo resultado em memoria, sem bater no
// Firestore de novo - e qualquer marcacao nova/removida invalida o cache
// na hora (ver marcar()/remover() abaixo), entao ninguem ve dado
// desatualizado por mais que TTL_MS.
const TTL_MS = 30 * 1000; // 30s: curto o suficiente pra nao atrasar o dashboard perceptivelmente
let cache = { valor: null, expiraEm: 0, emAndamento: null };

function invalidarCache() {
  cache = { valor: null, expiraEm: 0, emAndamento: null };
}

async function listAllCached() {
  const agora = Date.now();
  if (cache.valor && agora < cache.expiraEm) return cache.valor;
  // se ja tem uma leitura em andamento (varias notificacoes de webhook
  // chegando juntas), todo mundo espera a MESMA leitura em vez de cada
  // uma disparar sua propria chamada ao Firestore em paralelo
  if (cache.emAndamento) return cache.emAndamento;

  const promessa = listAll()
    .then((valor) => {
      cache = { valor, expiraEm: Date.now() + TTL_MS, emAndamento: null };
      return valor;
    })
    .catch((err) => {
      cache.emAndamento = null;
      throw err;
    });
  cache.emAndamento = promessa;
  return promessa;
}


// historico completo, incluindo as removidas - so pro Relatorio de Fraude
async function listHistorico() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}

function normalizarNome(nome) {
  return String(nome || '').trim().toLowerCase();
}

// nomes (normalizados) que ja tem pelo menos um pedido ATIVO marcado como
// FRAUDE - usado pra propagar a marcacao automaticamente pro proximo pedido
// que aparecer com esse mesmo nome, mesmo que troque de bandeira/final de
// cartao (ver index.js, webhook). Cobre tanto marcacao manual quanto
// automatica (cardHopping.js), ja que as duas passam por marcar() e gravam
// clienteNome. Se o Master remover a unica marca ativa de alguem (falso
// positivo confirmado), o nome sai da lista - novos pedidos dele deixam de
// ser marcados sozinhos ate o padrao se repetir de novo.
async function listFraudeNomes() {
  const marcas = await listAll();
  const nomes = new Set();
  marcas.forEach((m) => {
    if (m.nivel === 'FRAUDE' && m.clienteNome) nomes.add(normalizarNome(m.clienteNome));
  });
  return nomes;
}

module.exports = { NIVEIS, marcar, remover, listAll, listAllCached, listHistorico, listFraudeNomes, normalizarNome };


