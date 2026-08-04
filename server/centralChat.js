// centralChat.js
// Chat de uma solicitacao da Central (Estorno, Ajuste de Fechamento, Compra,
// Manutencao, Suporte de TI) - Master e Admin questionam/conversam com quem
// pediu antes de aprovar ou rejeitar. Baixo trafego esperado por card (poucas
// mensagens, poucas solicitacoes abertas por vez), mesmo perfil da fila de
// edicao de fechamento (fechamentosLive.js EDITS) - por isso sem cache, leitura
// direta no Firestore a cada chamada, igual aquela colecao.
const db = require('./firestore');

const COLLECTION = db.collection('centralChat');

// combina tipo+id do card num unico campo pra poder filtrar com uma unica
// igualdade (sem where().orderBy() em campos diferentes, que exige indice
// composto - mesmo padrao ja usado em disputes.js: filtra por igualdade,
// ordena em JS)
function chaveCard(tipo, cardId) {
  return `${tipo}:${cardId}`;
}

async function listByCard(tipo, cardId) {
  const snap = await COLLECTION.where('cardKey', '==', chaveCard(tipo, cardId)).get();
  return snap.docs.map((d) => d.data()).sort((a, b) => (a.criadoEm || '').localeCompare(b.criadoEm || ''));
}

async function addMessage({ tipo, cardId, autorId, autorEmail, texto }) {
  const texto2 = String(texto || '').trim();
  if (!texto2) throw new Error('Escreva uma mensagem.');
  const doc = COLLECTION.doc();
  const registro = {
    id: doc.id,
    cardKey: chaveCard(tipo, cardId),
    tipo,
    cardId,
    autorId,
    autorEmail,
    texto: texto2.slice(0, 2000),
    criadoEm: new Date().toISOString(),
  };
  await doc.set(registro);
  return registro;
}

async function removeMessage(id) {
  await COLLECTION.doc(id).delete();
}

module.exports = { listByCard, addMessage, removeMessage };
