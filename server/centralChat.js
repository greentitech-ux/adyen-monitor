// centralChat.js
// Chat de uma solicitacao da Central (Estorno, Ajuste de Fechamento, Compra,
// Manutencao, Suporte de TI) - Master e Admin questionam/conversam com quem
// pediu antes de aprovar ou rejeitar. Baixo trafego esperado por card (poucas
// mensagens, poucas solicitacoes abertas por vez), mesmo perfil da fila de
// edicao de fechamento (fechamentosLive.js EDITS) - por isso sem cache, leitura
// direta no Firestore a cada chamada, igual aquela colecao.
const db = require('./firestore');
const { createCache } = require('./liveCache');

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

// imagem (opcional): {nome, path, tipo} ja salva no Storage (ver rota em
// index.js) - pra quando o tecnico pede foto pra entender o problema antes
// de decidir. Mensagem precisa ter texto OU imagem, pelo menos um dos dois
async function addMessage({ tipo, cardId, autorId, autorEmail, autorUsername, texto, imagem }) {
  const texto2 = String(texto || '').trim();
  if (!texto2 && !imagem) throw new Error('Escreva uma mensagem ou anexe uma foto.');
  const doc = COLLECTION.doc();
  const registro = {
    id: doc.id,
    cardKey: chaveCard(tipo, cardId),
    tipo,
    cardId,
    autorId,
    autorEmail,
    autorUsername: autorUsername || null,
    texto: texto2.slice(0, 2000),
    imagem: imagem || null,
    criadoEm: new Date().toISOString(),
  };
  await doc.set(registro);
  chatCache.invalidar();
  return registro;
}

async function getMessage(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function removeMessage(id) {
  await COLLECTION.doc(id).delete();
}

// lista completa (com cache curto) - usada pela rota de responsaveis do
// grupo pra descobrir quais Admins ja participaram de chats de solicitações
// de uma unidade (ver GET /api/grupos/responsaveis em index.js)
async function listAllUncached() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}
const chatCache = createCache(listAllUncached, 20 * 1000);
const listAllCached = chatCache.cached;

// reatribui todas as mensagens de um card pra uma nova chave tipo:id - usado
// quando um ticket muda de tipo (mudarTipo, mesmo id) ou e convertido pra
// outra colecao (converterParaEstorno/converterParaSolicitacao, id novo),
// pra nao perder o historico de chat que ficava vinculado ao tipo/id antigo
async function reatribuirCard(tipoAntigo, idAntigo, tipoNovo, idNovo) {
  const snap = await COLLECTION.where('cardKey', '==', chaveCard(tipoAntigo, idAntigo)).get();
  const novaChave = chaveCard(tipoNovo, idNovo);
  await Promise.all(snap.docs.map((d) => d.ref.update({ cardKey: novaChave, tipo: tipoNovo, cardId: idNovo })));
  chatCache.invalidar();
}

module.exports = { listByCard, addMessage, getMessage, removeMessage, listAllCached, reatribuirCard };
