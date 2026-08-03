// ifoodSync.js
// Orquestra a sincronizacao periodica das vendas do iFood: para cada loja
// cadastrada em ifoodClient.IFOOD_UNIDADES_NOMES, busca uma janela
// retroativa curta (nao so "hoje" - cobre correções tardias de conciliação
// que a Sales API do iFood costuma aplicar em D+1/D+2) e grava no Firestore
// via ifoodStore.upsert.
//
// Cada loja falha "soft": um erro numa loja (ex: autorização revogada) não
// derruba o ciclo inteiro nem esconde que as outras lojas sincronizaram bem
// - por isso o status é guardado por merchantId, não só um erro global (mesma
// filosofia de sincronizarPlanilhasFechamento/sincronizarPlanilhaEntregas em
// index.js).
const ifoodClient = require('./ifoodClient');
const ifoodStore = require('./ifoodStore');

const JANELA_RETROATIVA_DIAS = 10;

function isoDiasAtras(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}

let statusSincronizacao = { ultimaEm: null, porLoja: {}, sincronizando: false };

async function sincronizarVendasIfood() {
  if (statusSincronizacao.sincronizando) return statusSincronizacao;
  statusSincronizacao.sincronizando = true;

  const lojas = Object.keys(ifoodClient.IFOOD_UNIDADES_NOMES);
  const periodo = { inicio: isoDiasAtras(JANELA_RETROATIVA_DIAS), fim: isoDiasAtras(0) };
  const porLoja = {};

  if (!lojas.length) {
    statusSincronizacao = {
      ultimaEm: new Date().toISOString(),
      porLoja: {},
      sincronizando: false,
      ultimoErro: 'Nenhuma loja cadastrada em IFOOD_UNIDADES_NOMES (server/ifoodClient.js) - preencha com o merchantId real de cada loja.',
    };
    return statusSincronizacao;
  }

  for (const merchantId of lojas) {
    try {
      const vendas = await ifoodClient.buscarVendas(merchantId, periodo);
      vendas.forEach((v) => ifoodStore.upsert(v));
      porLoja[merchantId] = { ok: true, vendas: vendas.length, erro: null, em: new Date().toISOString() };
    } catch (err) {
      porLoja[merchantId] = { ok: false, vendas: 0, erro: err.message, em: new Date().toISOString() };
      console.error(`Erro ao sincronizar vendas do iFood (loja ${merchantId}):`, err.message);
    }
  }

  ifoodStore.invalidar();
  statusSincronizacao = { ultimaEm: new Date().toISOString(), porLoja, sincronizando: false, ultimoErro: null };
  return statusSincronizacao;
}

function getStatus() {
  return statusSincronizacao;
}

module.exports = { sincronizarVendasIfood, getStatus };
