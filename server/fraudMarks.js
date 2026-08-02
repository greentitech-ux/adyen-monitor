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
}

// so as marcacoes ativas (usado no painel/monitor e na propagacao por nome)
async function listAll() {
  const snap = await COLLECTION.orderBy('atualizadoEm', 'desc').get();
  return snap.docs.map((d) => d.data()).filter((m) => !m.removido);
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

module.exports = { NIVEIS, marcar, remover, listAll, listHistorico, listFraudeNomes, normalizarNome };
