// ifoodStore.js
// Persistencia das vendas do iFood (Sales API) - diferente de Fechamentos
// (que reconsulta a planilha do Google como fonte de verdade e nao guarda
// nada no Firestore), vendas do iFood sao dado financeiro que a empresa
// quer manter/comparar ao longo do tempo, entao aqui persistimos de fato,
// mesmo padrao de store.js (transacoes Adyen).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('ifoodVendas');

// id unico que a Sales API do iFood devolver por venda/pedido - garante que
// resincronizar o mesmo periodo (janela retroativa de correcoes) atualiza o
// mesmo documento em vez de duplicar
function docId(venda) {
  return String(venda.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// fire-and-forget, mesmo padrao de store.addOrUpdate - nao trava o ciclo de
// sync esperando cada gravacao individual
function upsert(venda) {
  COLLECTION.doc(docId(venda))
    .set(venda, { merge: true })
    .catch((err) => console.error('Erro ao salvar venda do iFood no Firestore:', err.message));
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('dataHora', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const vendasCache = createCache(listAllUncached, 20 * 1000);
const listAllCached = vendasCache.cached;

module.exports = { upsert, listAllCached, invalidar: vendasCache.invalidar };
