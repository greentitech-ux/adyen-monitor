// abastecimentoCarrinho.js
// Abastecimento do carrinho da Dominos Aeroporto (substitui o AppSheet
// "AbastecimentoCarrinho" + planilha). A operacao tem duas pontas:
//
// - CARRINHO (Domino's Carrinho Aeroporto Recife) abre um PEDIDO: quantas
//   pizzas de cada sabor (Calabresa/Pepperoni/Mussarela) e/ou insumos
//   (bebidas, guardanapos... lista dinamica descricao+quantidade) precisa.
// - LOJA (Dominos Praça Aeroporto Recife) registra o ENVIO do que mandou -
//   de preferencia vinculado ao pedido que esta atendendo (atendePedidoId),
//   o que marca o pedido como atendido; envio avulso tambem vale (a loja
//   manda sem pedido, como ja acontece hoje na planilha).
//
// O saldo "Ontem/Hoje" por sabor (o card de resumo do AppSheet antigo) e
// calculado na tela a partir dos envios - aqui so guardamos os registros.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('abastecimentoCarrinho');

const TIPOS = ['PEDIDO', 'ENVIO'];
const SABORES = ['calabresa', 'pepperoni', 'mussarela'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function sanitizarPizzas(pizzas) {
  const limpo = {};
  for (const sabor of SABORES) limpo[sabor] = num(pizzas && pizzas[sabor]);
  return limpo;
}

function sanitizarInsumos(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((i) => ({ descricao: String(i?.descricao || '').trim().slice(0, 120), quantidade: String(i?.quantidade || '').trim().slice(0, 40) }))
    .filter((i) => i.descricao)
    .slice(0, 20);
}

async function criar({ tipo, pizzas, insumos, observacao, atendePedidoId, criadoPorId, criadoPorEmail, criadoPorNome }) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo inválido (use PEDIDO ou ENVIO).');
  const pizzasLimpas = sanitizarPizzas(pizzas);
  const insumosLimpos = sanitizarInsumos(insumos);
  const temPizza = SABORES.some((s) => pizzasLimpas[s] > 0);
  if (!temPizza && !insumosLimpos.length) throw new Error('Informe ao menos uma pizza ou um insumo.');

  let pedidoAtendido = null;
  if (atendePedidoId) {
    if (tipo !== 'ENVIO') throw new Error('Só um envio pode atender um pedido.');
    pedidoAtendido = await getOne(atendePedidoId);
    if (!pedidoAtendido || pedidoAtendido.tipo !== 'PEDIDO') throw new Error('Pedido não encontrado.');
    if (pedidoAtendido.atendidoPorEnvioId) throw new Error('Esse pedido já foi atendido por outro envio.');
  }

  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
    tipo,
    // a ponta que registra: pedido vem do carrinho, envio sai da loja -
    // mesma convencao da planilha antiga (coluna UNIDADE)
    origem: tipo === 'PEDIDO' ? 'CARRINHO' : 'LOJA',
    pizzas: pizzasLimpas,
    insumos: insumosLimpos,
    observacao: String(observacao || '').trim().slice(0, 500),
    // ENVIO -> qual pedido ele atende (opcional); PEDIDO -> qual envio o
    // atendeu (preenchido quando o envio vinculado nasce)
    atendePedidoId: atendePedidoId || null,
    atendidoPorEnvioId: null,
    criadoPorId: criadoPorId || null,
    criadoPorEmail: criadoPorEmail || null,
    criadoPorNome: criadoPorNome || null,
    criadoEm: agora,
  };
  await doc.set(registro);
  if (pedidoAtendido) {
    await COLLECTION.doc(pedidoAtendido.id).update({ atendidoPorEnvioId: registro.id });
  }
  cache.invalidar();
  return registro;
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// so o Master apaga (registro errado). Se era um envio que atendia um
// pedido, o pedido volta pra fila de "aguardando envio"
async function remover(id) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Registro não encontrado.');
  if (atual.tipo === 'ENVIO' && atual.atendePedidoId) {
    const pedido = await getOne(atual.atendePedidoId);
    if (pedido && pedido.atendidoPorEnvioId === id) {
      await COLLECTION.doc(pedido.id).update({ atendidoPorEnvioId: null });
    }
  }
  await COLLECTION.doc(id).delete();
  cache.invalidar();
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listAllUncached, 15 * 1000);
const listAll = cache.cached;

module.exports = { TIPOS, SABORES, criar, getOne, remover, listAll };
