// fraudMarks.js
// Marcacao manual de suspeita/fraude por pedido - independente do status que
// vem da Adyen (esse continua intacto, e so o campo "status" da transacao
// mesmo). Guarda tambem a "chave do cliente" (cartao+nome, ou so nome -
// mesma logica ja usada na deteccao de pedidos repetidos, calculada no
// frontend) pra que, se o MESMO cliente fizer outro pedido depois de ja ter
// sido marcado como FRAUDE, esse pedido novo tambem entre no monitoramento
// automaticamente, mesmo sem ninguem marcar de novo.
const db = require('./firestore');
const COLLECTION = db.collection('fraudMarks');

const NIVEIS = ['SUSPEITO', 'FRAUDE'];

function docId(pedidoId) {
  return String(pedidoId).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function marcar({ pedidoId, unidade, nivel, motivo, clienteChave, clienteNome, valor, marcadoPorEmail }) {
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
    valor: valor || 0,
    nivel,
    motivo: motivo || '',
    criadoPorEmail: existente.exists ? existente.data().criadoPorEmail : marcadoPorEmail,
    criadoEm: existente.exists ? existente.data().criadoEm : agora,
    atualizadoPorEmail: marcadoPorEmail,
    atualizadoEm: agora,
  };
  await ref.set(registro);
  return registro;
}

async function remover(pedidoId) {
  await COLLECTION.doc(docId(pedidoId)).delete();
}

async function listAll() {
  const snap = await COLLECTION.orderBy('atualizadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}

module.exports = { NIVEIS, marcar, remover, listAll };
