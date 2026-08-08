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
const bcrypt = require('bcryptjs');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('abastecimentoCarrinho');
const CATALOGO = db.collection('abastecimentoInsumos');
const OPERADORES = db.collection('abastecimentoOperadores');

const TIPOS = ['PEDIDO', 'ENVIO', 'CONTAGEM'];
const SABORES = ['calabresa', 'pepperoni', 'mussarela'];

// ---------- config do abastecimento (Master) ----------
// por enquanto so os HORARIOS em que o popup de contagem aparece pro lado
// do carrinho (quem assume o turno lanca a contagem como primeira coisa)
const CONFIG_DOC = db.collection('abastecimentoConfig').doc('config');

async function getConfig() {
  const snap = await CONFIG_DOC.get();
  const data = snap.exists ? snap.data() : {};
  return { horasContagem: Array.isArray(data.horasContagem) ? data.horasContagem : [] };
}

async function salvarConfig({ horasContagem }) {
  const limpas = (Array.isArray(horasContagem) ? horasContagem : [])
    .map((h) => String(h || '').trim())
    .filter((h) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(h))
    .slice(0, 6);
  await CONFIG_DOC.set({ horasContagem: limpas }, { merge: true });
  return getConfig();
}

// ---------- operadores locais (login de balcao) ----------
// Cadastro LOCAL da propria pagina de Abastecimento, no espirito do
// usuario/senha que a equipe ja usava na planilha - so que seguro:
// - usuario: exatamente 4 LETRAS; senha: exatamente 4 NUMEROS (bcrypt);
// - cada operador tem um PAPEL: 'pedido' (quem pede, carrinho) ou 'envio'
//   (quem envia, loja) - o lancamento so aceita o papel certo;
// - mesma dinamica de bloqueio do login principal: 3 senhas erradas
//   seguidas -> bloqueado; SO O MASTER desbloqueia (redefinindo a senha),
//   igual ao desbloqueio do login principal.
// Esse login NAO da acesso a nada alem de assinar pedido/envio - a pagina
// continua atras do login normal do Zenith + secoes por ponta.
const PAPEIS_OPERADOR = ['pedido', 'envio'];
const MAX_TENTATIVAS_OPERADOR = 3;

function validarUsuarioOperador(usuario) {
  const limpo = String(usuario || '').trim().toLowerCase();
  if (!/^[a-z]{4}$/.test(limpo)) throw new Error('Usuário do operador deve ter exatamente 4 letras.');
  return limpo;
}
function validarSenhaOperador(senha) {
  const limpa = String(senha || '').trim();
  if (!/^[0-9]{4}$/.test(limpa)) throw new Error('Senha do operador deve ter exatamente 4 números.');
  return limpa;
}
function operadorPublico(op) {
  if (!op) return null;
  const { senhaHash, ...resto } = op;
  return resto;
}

async function listarOperadoresUncached() {
  const snap = await OPERADORES.orderBy('usuario').get();
  return snap.docs.map((d) => d.data());
}
const operadoresCache = createCache(listarOperadoresUncached, 15 * 1000);
async function listarOperadores() {
  return (await operadoresCache.cached()).map(operadorPublico);
}

async function criarOperador({ usuario, senha, nome, papel, criadoPorEmail }) {
  const usuarioLimpo = validarUsuarioOperador(usuario);
  const senhaLimpa = validarSenhaOperador(senha);
  if (!PAPEIS_OPERADOR.includes(papel)) throw new Error("Papel inválido: use 'pedido' (carrinho) ou 'envio' (loja).");
  const existentes = await operadoresCache.cached();
  if (existentes.some((o) => o.usuario === usuarioLimpo)) throw new Error('Já existe um operador com esse usuário.');
  const doc = OPERADORES.doc();
  const registro = {
    id: doc.id,
    usuario: usuarioLimpo,
    senhaHash: await bcrypt.hash(senhaLimpa, 12),
    nome: String(nome || '').trim().slice(0, 80) || usuarioLimpo,
    papel,
    ativo: true,
    bloqueado: false,
    tentativasErradas: 0,
    criadoEm: new Date().toISOString(),
    criadoPorEmail: criadoPorEmail || null,
  };
  await doc.set(registro);
  operadoresCache.invalidar();
  return operadorPublico(registro);
}

async function atualizarOperador(id, { nome, papel, ativo }) {
  const snap = await OPERADORES.doc(id).get();
  if (!snap.exists) throw new Error('Operador não encontrado.');
  const patch = {};
  if (nome != null) patch.nome = String(nome).trim().slice(0, 80) || snap.data().usuario;
  if (papel != null) {
    if (!PAPEIS_OPERADOR.includes(papel)) throw new Error("Papel inválido: use 'pedido' ou 'envio'.");
    patch.papel = papel;
  }
  if (ativo != null) patch.ativo = !!ativo;
  await OPERADORES.doc(id).update(patch);
  operadoresCache.invalidar();
  const atualizado = await OPERADORES.doc(id).get();
  return operadorPublico(atualizado.data());
}

// remocao e SO do Master (rota) - apaga o login local de vez
async function removerOperador(id) {
  const snap = await OPERADORES.doc(id).get();
  if (!snap.exists) throw new Error('Operador não encontrado.');
  await OPERADORES.doc(id).delete();
  operadoresCache.invalidar();
}

// desbloqueio do Master (via ticket que o bloqueio gera): mesma dinamica do
// login principal, mas a senha e OPCIONAL - em branco mantem a mesma senha,
// preenchida (4 numeros) redefine
async function desbloquearOperador(id, { novaSenha }) {
  const snap = await OPERADORES.doc(id).get();
  if (!snap.exists) throw new Error('Operador não encontrado.');
  const patch = { bloqueado: false, tentativasErradas: 0 };
  if (novaSenha != null && String(novaSenha).trim() !== '') {
    patch.senhaHash = await bcrypt.hash(validarSenhaOperador(novaSenha), 12);
  }
  await OPERADORES.doc(id).update(patch);
  operadoresCache.invalidar();
  const atualizado = await OPERADORES.doc(id).get();
  return operadorPublico(atualizado.data());
}

// autentica usuario+senha do operador com o mesmo bloqueio do login
// principal (3 erradas -> bloqueado). Quando o bloqueio ACONTECE nesta
// tentativa, o erro sai marcado (err.operadorBloqueado) pra rota gerar o
// ticket de desbloqueio pro Master
async function autenticarOperador({ usuario, senha }) {
  const usuarioLimpo = String(usuario || '').trim().toLowerCase();
  const todos = await operadoresCache.cached();
  const op = todos.find((o) => o.usuario === usuarioLimpo);
  if (!op || op.ativo === false) throw new Error('Operador não encontrado. Confira o usuário (4 letras).');
  if (op.bloqueado) throw new Error('Login do operador bloqueado após 3 senhas erradas. O Master desbloqueia pelo ticket.');
  const ok = await bcrypt.compare(String(senha || '').trim(), op.senhaHash);
  if (!ok) {
    const tentativas = (op.tentativasErradas || 0) + 1;
    const bloqueou = tentativas >= MAX_TENTATIVAS_OPERADOR;
    await OPERADORES.doc(op.id).update({ tentativasErradas: tentativas, bloqueado: bloqueou });
    operadoresCache.invalidar();
    if (bloqueou) {
      const err = new Error('Login do operador bloqueado após 3 senhas erradas. Um ticket foi gerado pro Master desbloquear.');
      err.operadorBloqueado = operadorPublico(op);
      throw err;
    }
    throw new Error(`Senha do operador errada (${tentativas}/${MAX_TENTATIVAS_OPERADOR}).`);
  }
  if (op.tentativasErradas) {
    await OPERADORES.doc(op.id).update({ tentativasErradas: 0 });
    operadoresCache.invalidar();
  }
  return op;
}

// valida o login local na hora do lancamento: papel certo pro tipo. Papel
// errado sai marcado (err.papelErrado) - a tela oferece "trocar meu papel"
async function validarOperador({ usuario, senha, papel }) {
  const op = await autenticarOperador({ usuario, senha });
  if (op.papel !== papel) {
    const err = new Error(papel === 'pedido'
      ? `O operador "${op.usuario}" é de ENVIO (loja) - não pode fazer pedido.`
      : `O operador "${op.usuario}" é de PEDIDO (carrinho) - não pode registrar envio.`);
    err.papelErrado = true;
    throw err;
  }
  return operadorPublico(op);
}

// o PROPRIO operador troca seu papel (pede <-> envia) autenticando com a
// propria senha - sem depender do Master pra mudar de ponta
async function trocarPapelOperador({ usuario, senha, papel }) {
  if (!PAPEIS_OPERADOR.includes(papel)) throw new Error("Papel inválido: use 'pedido' ou 'envio'.");
  const op = await autenticarOperador({ usuario, senha });
  if (op.papel !== papel) {
    await OPERADORES.doc(op.id).update({ papel });
    operadoresCache.invalidar();
  }
  const atualizado = await OPERADORES.doc(op.id).get();
  return operadorPublico(atualizado.data());
}

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

async function criar({ tipo, pizzas, insumos, observacao, atendePedidoId, criadoPorId, criadoPorEmail, criadoPorNome, operador }) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo inválido (use PEDIDO ou ENVIO).');
  const pizzasLimpas = sanitizarPizzas(pizzas);
  const insumosLimpos = await resolverInsumos(insumos);
  const temPizza = SABORES.some((s) => pizzasLimpas[s] > 0);
  // CONTAGEM pode ser toda zerada (carrinho vazio no inicio do turno)
  if (tipo !== 'CONTAGEM' && !temPizza && !insumosLimpos.length) throw new Error('Informe ao menos uma pizza ou um insumo.');

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
    // a ponta que registra: pedido e contagem vem do carrinho, envio sai
    // da loja - mesma convencao da planilha antiga (coluna UNIDADE)
    origem: tipo === 'ENVIO' ? 'LOJA' : 'CARRINHO',
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
    // PEDIDO: a loja marcou "SENDO PREPARADO" - e o retorno que o carrinho
    // espera. Depois do visto, a loja tem 5min pra marcar; sem marcar, o
    // popup de PEDIDO ATRASADO dispara do lado de quem envia
    preparoEm: null,
    preparoPorEmail: null,
    preparoPorNome: null,
    // conversa lateral do pedido (carrinho <-> loja): "esqueci uma
    // observacao", "o pedido esta demorando", combinados de preparo...
    mensagens: [],
    criadoPorId: criadoPorId || null,
    criadoPorEmail: criadoPorEmail || null,
    criadoPorNome: criadoPorNome || null,
    // operador local (login de balcao de 4 letras) que assinou o lancamento
    operadorUsuario: operador ? operador.usuario : null,
    operadorNome: operador ? operador.nome : null,
    // ENVIO: confirmacao de recebimento pelo carrinho (o ciclo so fecha
    // quando o carrinho confere o que chegou - ver confirmarRecebimento)
    recebidoEm: null,
    recebimento: null,
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

// loja marca "SENDO PREPARADO" - retorno que o carrinho espera ver. Marca
// o visto junto se ainda nao tinha (preparar implica ter visto). Idempotente
async function marcarPreparo(id, { email, nome }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Registro não encontrado.');
  if (atual.tipo !== 'PEDIDO') throw new Error('Só pedido tem status de preparo.');
  if (atual.preparoEm) return atual;
  const agora = new Date().toISOString();
  const patch = { preparoEm: agora, preparoPorEmail: email || null, preparoPorNome: nome || null };
  if (!atual.vistoEm) {
    patch.vistoEm = agora;
    patch.vistoPorEmail = email || null;
    patch.vistoPorNome = nome || null;
  }
  await COLLECTION.doc(id).update(patch);
  cache.invalidar();
  return getOne(id);
}

// conversa lateral do pedido: cada mensagem identifica a ponta (carrinho/
// loja) e quem escreveu. So em PEDIDO, limite de tamanho e de mensagens
async function adicionarMensagem(id, { de, texto, autorEmail, autorNome }) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Registro não encontrado.');
  if (atual.tipo !== 'PEDIDO') throw new Error('A conversa fica no pedido.');
  const textoLimpo = String(texto || '').trim().slice(0, 500);
  if (!textoLimpo) throw new Error('Escreva a mensagem.');
  const mensagens = atual.mensagens || [];
  if (mensagens.length >= 200) throw new Error('Essa conversa ficou muito longa.');
  const nova = {
    de: de === 'loja' ? 'loja' : 'carrinho',
    texto: textoLimpo,
    autorEmail: autorEmail || null,
    autorNome: autorNome || null,
    em: new Date().toISOString(),
  };
  await COLLECTION.doc(id).update({ mensagens: [...mensagens, nova] });
  cache.invalidar();
  return getOne(id);
}

// confirmacao de recebimento pelo CARRINHO: o envio nao finaliza sozinho -
// quem recebe confere o que chegou.
// - recebido por item: no maximo o que foi enviado (faltou -> diminui/zera;
//   sobrar em relacao ao ENVIO nao existe - a mais e tratado contra o PEDIDO);
// - faltas = enviado - recebido (> 0) ficam registradas item a item;
// - extras = itens em que o ENVIO veio ACIMA do PEDIDO vinculado (ex: pediu
//   1 calabresa, enviaram 2): o carrinho precisa confirmar que o "a mais"
//   confere com o que realmente esta no lancamento (confirmaExtras).
async function confirmarRecebimento(envioId, { pizzas, insumos, confirmaExtras, porEmail, porNome }) {
  const envio = await getOne(envioId);
  if (!envio) throw new Error('Envio não encontrado.');
  if (envio.tipo !== 'ENVIO') throw new Error('Só envio tem confirmação de recebimento.');
  if (envio.recebidoEm) return envio;

  const pedido = envio.atendePedidoId ? await getOne(envio.atendePedidoId) : null;

  const recebidoPizzas = {};
  const faltas = [];
  for (const sabor of SABORES) {
    const enviada = num((envio.pizzas || {})[sabor]);
    // ausente/null = "recebi como enviado"; so um numero informado conta
    const informado = pizzas && pizzas[sabor] != null && pizzas[sabor] !== '';
    let recebida = informado ? Number(pizzas[sabor]) : enviada;
    if (!Number.isFinite(recebida) || recebida < 0) recebida = enviada;
    recebida = Math.min(Math.round(recebida), enviada);
    recebidoPizzas[sabor] = recebida;
    if (recebida < enviada) faltas.push({ item: sabor, enviada, recebida });
  }
  const recebidoInsumos = (envio.insumos || []).map((ins, idx) => {
    const enviada = ins.insumoId ? Number(ins.quantidade) || 0 : null;
    if (enviada == null) return { ...ins }; // texto livre legado: sem conferencia numerica
    const informadoIns = insumos && insumos[idx] && insumos[idx].quantidade != null && insumos[idx].quantidade !== '';
    let recebida = informadoIns ? Number(insumos[idx].quantidade) : enviada;
    if (!Number.isFinite(recebida) || recebida < 0) recebida = enviada;
    recebida = Math.min(Math.round(recebida), enviada);
    if (recebida < enviada) faltas.push({ item: ins.nome, enviada, recebida });
    return { ...ins, quantidadeRecebida: recebida };
  });

  // "a mais": envio acima do PEDIDO vinculado - registrado sempre, e o
  // carrinho declara se o extra confere com o que chegou de verdade
  const extras = [];
  if (pedido) {
    for (const sabor of SABORES) {
      const pedida = num((pedido.pizzas || {})[sabor]);
      const enviada = num((envio.pizzas || {})[sabor]);
      if (enviada > pedida) extras.push({ item: sabor, pedida, enviada });
    }
    const pedidoPorInsumo = new Map((pedido.insumos || []).filter((i) => i.insumoId).map((i) => [i.insumoId, Number(i.quantidade) || 0]));
    for (const ins of envio.insumos || []) {
      if (!ins.insumoId) continue;
      const pedida = pedidoPorInsumo.get(ins.insumoId) || 0;
      const enviada = Number(ins.quantidade) || 0;
      if (enviada > pedida) extras.push({ item: ins.nome, pedida, enviada });
    }
  }
  if (extras.length && !confirmaExtras) {
    throw new Error('O envio veio com itens a mais que o pedido - confirme que o "a mais" confere com o que chegou.');
  }

  const agora = new Date().toISOString();
  const recebimento = {
    em: agora,
    porEmail: porEmail || null,
    porNome: porNome || null,
    confere: !faltas.length,
    faltas,
    extras,
    extrasConfirmados: extras.length ? true : null,
    recebido: { pizzas: recebidoPizzas, insumos: recebidoInsumos },
  };
  await COLLECTION.doc(envioId).update({ recebidoEm: agora, recebimento });
  cache.invalidar();
  return getOne(envioId);
}

// recebimento que NAO bate de um jeito que o popup nao resolve (ex: chegou
// item que nem esta na lista do envio, ou o "a mais" registrado nao e o que
// chegou): encerra a conferencia marcando DIVERGENCIA e amarra o numero do
// ticket de analise gerado pro Master (a rota cria o ticket)
async function registrarDivergencia(envioId, { motivo, detalhe, numeroTicket, porEmail, porNome }) {
  const envio = await getOne(envioId);
  if (!envio) throw new Error('Envio não encontrado.');
  if (envio.tipo !== 'ENVIO') throw new Error('Só envio tem confirmação de recebimento.');
  if (envio.recebidoEm) return envio;
  const agora = new Date().toISOString();
  await COLLECTION.doc(envioId).update({
    recebidoEm: agora,
    recebimento: {
      em: agora,
      porEmail: porEmail || null,
      porNome: porNome || null,
      confere: false,
      divergencia: true,
      motivo: String(motivo || 'divergencia').slice(0, 60),
      detalhe: String(detalhe || '').trim().slice(0, 500),
      numeroTicket: numeroTicket != null ? numeroTicket : null,
      faltas: [],
      extras: [],
      recebido: null,
    },
  });
  cache.invalidar();
  return getOne(envioId);
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

module.exports = {
  TIPOS, SABORES, criar, getOne, remover, listAll, marcarVisto, marcarPreparo, adicionarMensagem, confirmarRecebimento, registrarDivergencia, getConfig, salvarConfig,
  listarInsumos, criarInsumo, atualizarInsumo,
  listarOperadores, criarOperador, atualizarOperador, removerOperador, desbloquearOperador, validarOperador, trocarPapelOperador,
};
