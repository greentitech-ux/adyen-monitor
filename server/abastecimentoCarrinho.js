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
const CATALOGO = db.collection('abastecimentoInsumos');

const TIPOS = ['PEDIDO', 'ENVIO'];
const SABORES = ['calabresa', 'pepperoni', 'mussarela'];

// ---------- catalogo de insumos ----------
// Padroniza o que vai pro carrinho: em vez de texto livre (a planilha antiga
// tinha "coca zero"/"cocazero"/"coca cola zero" pro MESMO item), o lancamento
// escolhe um insumo do catalogo. Cada item pode ter `qtdPorCaixa`: quando
// definida, o lancamento pode ser em CAIXA e a quantidade por caixa vem
// travada do cadastro (nao e manipulavel na hora do envio); sem ela, o item
// so sai em UNIDADE. Gerencia o catalogo: Master/Admin ou quem tiver a
// permissao podeCatalogoInsumos (tela de Usuarios).
//
// Seed: todos os insumos que ja apareceram no historico da planilha,
// consolidados (grafias unificadas). qtdPorCaixa nasce vazia - quem gerencia
// preenche a quantidade real de cada caixa.
const CATALOGO_SEED = [
  'Coca-Cola', 'Coca-Cola Zero', 'Sprite', 'Sprite Zero', 'Fanta Laranja',
  'Fanta Laranja Zero', 'Fanta Uva', 'Kuat', 'Kuat Zero', 'Água sem gás',
  'Água com gás', 'Heineken', 'Copos', 'Guardanapos', 'Talheres',
  'Sacola viagem', 'Saco de lixo', 'Bobina grande (impressora)',
  'Bobina pequena', 'Perflex', 'Ketchup', 'Maionese', 'Mostarda',
];

function normalizarNome(nome) {
  return String(nome || '').trim().toLowerCase();
}

function numPorCaixa(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

async function listarInsumosUncached() {
  const snap = await CATALOGO.orderBy('nome').get();
  let itens = snap.docs.map((d) => d.data());
  if (!itens.length) {
    // primeira vez: semeia o catalogo com o historico consolidado da planilha
    const agora = new Date().toISOString();
    for (const nome of CATALOGO_SEED) {
      const doc = CATALOGO.doc();
      await doc.set({ id: doc.id, nome, qtdPorCaixa: null, ativo: true, criadoEm: agora, criadoPorEmail: null });
    }
    const snap2 = await CATALOGO.orderBy('nome').get();
    itens = snap2.docs.map((d) => d.data());
  }
  return itens;
}
const catalogoCache = createCache(listarInsumosUncached, 30 * 1000);
const listarInsumos = catalogoCache.cached;

async function criarInsumo({ nome, qtdPorCaixa, criadoPorEmail }) {
  const nomeLimpo = String(nome || '').trim().slice(0, 120);
  if (!nomeLimpo) throw new Error('Informe o nome do insumo.');
  const existentes = await listarInsumos();
  if (existentes.some((i) => normalizarNome(i.nome) === normalizarNome(nomeLimpo))) {
    throw new Error('Já existe um insumo com esse nome no catálogo.');
  }
  const doc = CATALOGO.doc();
  const registro = {
    id: doc.id,
    nome: nomeLimpo,
    qtdPorCaixa: numPorCaixa(qtdPorCaixa),
    ativo: true,
    criadoEm: new Date().toISOString(),
    criadoPorEmail: criadoPorEmail || null,
  };
  await doc.set(registro);
  catalogoCache.invalidar();
  return registro;
}

async function atualizarInsumo(id, { nome, qtdPorCaixa, ativo }) {
  const snap = await CATALOGO.doc(id).get();
  if (!snap.exists) throw new Error('Insumo não encontrado.');
  const patch = {};
  if (nome != null) {
    const nomeLimpo = String(nome).trim().slice(0, 120);
    if (!nomeLimpo) throw new Error('Informe o nome do insumo.');
    const existentes = await listarInsumos();
    if (existentes.some((i) => i.id !== id && normalizarNome(i.nome) === normalizarNome(nomeLimpo))) {
      throw new Error('Já existe um insumo com esse nome no catálogo.');
    }
    patch.nome = nomeLimpo;
  }
  if (qtdPorCaixa !== undefined) patch.qtdPorCaixa = numPorCaixa(qtdPorCaixa);
  if (ativo != null) patch.ativo = !!ativo;
  await CATALOGO.doc(id).update(patch);
  catalogoCache.invalidar();
  const atualizado = await CATALOGO.doc(id).get();
  return atualizado.data();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function sanitizarPizzas(pizzas) {
  const limpo = {};
  for (const sabor of SABORES) limpo[sabor] = num(pizzas && pizzas[sabor]);
  return limpo;
}

// insumos do lancamento: preferencialmente vindos do CATALOGO (insumoId +
// embalagem unidade/caixa + quantidade). Regras de previsibilidade:
// - caixa so e aceita se o item do catalogo tiver qtdPorCaixa cadastrada;
// - a qtdPorCaixa gravada vem SEMPRE do catalogo (o que o cliente mandar e
//   ignorado - nao e manipulavel na hora do lancamento);
// - totalUnidades = quantidade x qtdPorCaixa (caixa) ou quantidade (unidade).
// Texto livre ({descricao, quantidade}) segue aceito so pra compatibilidade
// com registros antigos/integracoes - a tela nova nao usa mais.
async function resolverInsumos(lista) {
  if (!Array.isArray(lista)) return [];
  const catalogo = await listarInsumos();
  const porId = new Map(catalogo.map((i) => [i.id, i]));
  const resultado = [];
  for (const item of lista.slice(0, 20)) {
    if (item && item.insumoId) {
      const cad = porId.get(item.insumoId);
      if (!cad || cad.ativo === false) throw new Error('Insumo fora do catálogo. Atualize a página e tente de novo.');
      const quantidade = Number(item.quantidade);
      if (!Number.isFinite(quantidade) || quantidade <= 0) throw new Error(`Informe a quantidade de "${cad.nome}".`);
      const qtd = Math.round(quantidade);
      const embalagem = item.embalagem === 'caixa' ? 'caixa' : 'unidade';
      if (embalagem === 'caixa' && !cad.qtdPorCaixa) throw new Error(`"${cad.nome}" não tem quantidade por caixa cadastrada - lance em unidades ou peça pra cadastrar.`);
      resultado.push({
        insumoId: cad.id,
        nome: cad.nome,
        embalagem,
        quantidade: qtd,
        qtdPorCaixa: embalagem === 'caixa' ? cad.qtdPorCaixa : null,
        totalUnidades: embalagem === 'caixa' ? qtd * cad.qtdPorCaixa : qtd,
      });
    } else {
      const descricao = String(item?.descricao || '').trim().slice(0, 120);
      if (!descricao) continue;
      resultado.push({ descricao, quantidade: String(item?.quantidade || '').trim().slice(0, 40) });
    }
  }
  return resultado;
}

async function criar({ tipo, pizzas, insumos, observacao, atendePedidoId, criadoPorId, criadoPorEmail, criadoPorNome }) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo inválido (use PEDIDO ou ENVIO).');
  const pizzasLimpas = sanitizarPizzas(pizzas);
  const insumosLimpos = await resolverInsumos(insumos);
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
    // PEDIDO: confirmacao de ciencia da loja (o alarme sonoro/popup do lado
    // de quem envia so para quando alguem aperta OK -> marcarVisto)
    vistoEm: null,
    vistoPorEmail: null,
    vistoPorNome: null,
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

// a loja aperta OK no popup de pedido novo: registra quem viu e quando.
// Idempotente - o primeiro OK vale, os proximos so retornam o registro
async function marcarVisto(id, { email, nome }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Registro não encontrado.');
  if (atual.tipo !== 'PEDIDO') throw new Error('Só pedido tem confirmação de visto.');
  if (atual.vistoEm) return atual;
  await COLLECTION.doc(id).update({
    vistoEm: new Date().toISOString(),
    vistoPorEmail: email || null,
    vistoPorNome: nome || null,
  });
  cache.invalidar();
  return getOne(id);
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

module.exports = { TIPOS, SABORES, criar, getOne, remover, listAll, marcarVisto, listarInsumos, criarInsumo, atualizarInsumo };
