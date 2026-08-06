// inventario.js
// Inventário físico das lojas (Domino's, por enquanto - ver INVENTARIO_UNIDADES
// em index.js) - controla o estoque de insumos/bebidas/embalagens por setor
// (Estoque Seco, Congelados, Câmara Fria, Geladeira, Makeline, Mesa de
// Corte), com contagem diária, recebimento de mercadoria (com custo, pra dar
// noção de CMV) e saídas (venda/desperdício/outra).
//
// A lógica central é a "diferença" (ver calcularDiferencas): compara o que a
// contagem deveria ter dado (esperado = contagem do dia anterior + entradas
// - saídas do dia) com o que realmente foi contado (real). Diferença
// negativa = FALTA (sumiu mais do que o registrado); diferença positiva =
// SOBRA (ex: chegou mercadoria e a nota não foi lançada no sistema).
const db = require('./firestore');
const { createCache } = require('./liveCache');
const CATALOGO_SEED = require('./inventarioCatalogoSeed.json');

const CATALOGO = db.collection('inventarioCatalogo');
const RECEBIMENTOS = db.collection('inventarioRecebimentos');
const SAIDAS = db.collection('inventarioSaidas');
const CONTAGENS = db.collection('inventarioContagens');
// setores/tipos extras cadastrados pelo Master (ver criarSetor/criarTipo) -
// os fixos abaixo continuam existindo (o catálogo padrão da rede usa esses
// códigos), mas dá pra somar novos sem precisar mexer no código
const CONFIG = db.collection('inventarioConfig').doc('geral');

const SETORES = {
  estoque_seco: 'Estoque Seco',
  congelados: 'Congelados (Freezer)',
  camara_fria: 'Câmara Fria',
  geladeira: 'Geladeira',
  makeline: 'Makeline',
  mesa_de_corte: 'Mesa de Corte',
  comissariado: 'Comissariado',
};
const TIPOS_ITEM = ['COMIDA', 'BEBIDA', 'EMBALAGEM'];
const TIPOS_SAIDA = ['VENDA', 'DESPERDICIO', 'OUTRA'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function arred(v, casas = 2) {
  const f = 10 ** casas;
  return Math.round((v + Number.EPSILON) * f) / f;
}
function validarData(data) {
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');
  return data;
}
function normalizarNome(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
}
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase().replace(/^_+|_+$/g, '');
}

// ---------- setores/tipos: fixos (SETORES/TIPOS_ITEM acima) + extras que o
// Master cadastra na hora (ver criarSetor/criarTipo) - guardados num unico
// doc de config, pra nao precisar de uma colecao inteira por 2 arrays curtos ----------
async function getConfigUncached() {
  const doc = await CONFIG.get();
  return doc.exists ? doc.data() : { setoresExtras: [], tiposExtras: [] };
}
const configCache = createCache(getConfigUncached, 20 * 1000);
const getConfig = configCache.cached;

async function listSetores() {
  const cfg = await getConfig();
  const base = Object.entries(SETORES).map(([codigo, nome]) => ({ codigo, nome }));
  const extras = (cfg.setoresExtras || []).map((s) => ({ codigo: s.codigo, nome: s.nome }));
  return [...base, ...extras];
}
async function criarSetor(nome) {
  nome = String(nome || '').trim();
  if (!nome) throw new Error('Informe o nome do setor.');
  const codigo = slugify(nome);
  if (!codigo) throw new Error('Nome de setor inválido.');
  const atuais = await listSetores();
  if (atuais.some((s) => s.codigo === codigo)) throw new Error('Já existe um setor com esse nome.');
  const cfg = await getConfig();
  const setoresExtras = [...(cfg.setoresExtras || []), { codigo, nome: nome.slice(0, 60) }];
  await CONFIG.set({ ...cfg, setoresExtras }, { merge: true });
  configCache.invalidar();
  return { codigo, nome: nome.slice(0, 60) };
}

async function listTipos() {
  const cfg = await getConfig();
  return [...TIPOS_ITEM, ...(cfg.tiposExtras || [])];
}
async function criarTipo(nome) {
  nome = String(nome || '').trim().toUpperCase().slice(0, 30);
  if (!nome) throw new Error('Informe o nome do tipo.');
  const atuais = await listTipos();
  if (atuais.includes(nome)) throw new Error('Já existe um tipo com esse nome.');
  const cfg = await getConfig();
  const tiposExtras = [...(cfg.tiposExtras || []), nome];
  await CONFIG.set({ ...cfg, tiposExtras }, { merge: true });
  configCache.invalidar();
  return { nome };
}

// ---------- catálogo (Master gerencia; leitura liberada pra quem tem a
// seção "inventario", ver index.js) ----------
async function listCatalogoUncached() {
  const snap = await CATALOGO.orderBy('nome', 'asc').get();
  return snap.docs.map((d) => d.data());
}
const catalogoCache = createCache(listCatalogoUncached, 20 * 1000);
const listCatalogo = catalogoCache.cached;

async function criarItem({ nome, setor, tipo, unidadeMedida, custoReferencia, quantidadePadrao, pesoEmbalagemG }) {
  nome = String(nome || '').trim();
  if (!nome) throw new Error('Nome do item é obrigatório.');
  const setores = await listSetores();
  if (!setores.some((s) => s.codigo === setor)) throw new Error('Setor inválido.');
  const tipos = await listTipos();
  const ref = CATALOGO.doc();
  // item novo sempre entra no fim da ordem manual do setor (ver
  // reordenarItens) - assim quem organiza a lista com drag-and-drop nao tem
  // itens novos pulando pro meio sem querer
  const itensDoSetor = (await listCatalogo()).filter((i) => i.setor === setor);
  const proximaOrdem = itensDoSetor.length
    ? Math.max(...itensDoSetor.map((i) => num(i.ordem))) + 1
    : 0;
  const registro = {
    id: ref.id,
    nome: nome.slice(0, 120),
    setor,
    tipo: tipos.includes(tipo) ? tipo : (tipos[0] || 'COMIDA'),
    unidadeMedida: (String(unidadeMedida || 'UN').trim().slice(0, 10) || 'UN').toUpperCase(),
    custoReferencia: num(custoReferencia),
    // pra automatizar o Recebimento (ver criarRecebimento): quantidadePadrao
    // pre-preenche "quantidade" (ou "qtd. de embalagens" pra item com peso);
    // pesoEmbalagemG so faz sentido pra item medido em KG/G - peso de 1
    // embalagem/pacote, usado pra converter embalagens recebidas em peso
    quantidadePadrao: quantidadePadrao != null && quantidadePadrao !== '' ? num(quantidadePadrao) : null,
    pesoEmbalagemG: pesoEmbalagemG != null && pesoEmbalagemG !== '' ? num(pesoEmbalagemG) : null,
    ordem: proximaOrdem,
    ativo: true,
    createdAt: new Date().toISOString(),
  };
  await ref.set(registro);
  catalogoCache.invalidar();
  return registro;
}

// reordenacao manual dos itens de um setor (drag-and-drop no Contagem/
// Catalogo, ver estoque.html) - recebe os ids do setor JA na ordem desejada
// e grava 0,1,2... em `ordem`; itens de outros setores nao sao tocados
async function reordenarItens(setor, ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('Lista de itens inválida.');
  const setores = await listSetores();
  if (!setores.some((s) => s.codigo === setor)) throw new Error('Setor inválido.');
  const catalogo = await listCatalogo();
  const doSetor = new Set(catalogo.filter((i) => i.setor === setor).map((i) => i.id));
  const idsValidos = ids.filter((id) => doSetor.has(id));
  if (!idsValidos.length) throw new Error('Nenhum item válido para reordenar.');
  const batch = db.batch();
  idsValidos.forEach((id, index) => {
    batch.update(CATALOGO.doc(id), { ordem: index });
  });
  await batch.commit();
  catalogoCache.invalidar();
  return (await listCatalogo()).filter((i) => i.setor === setor);
}

async function atualizarItem(id, { nome, setor, tipo, unidadeMedida, custoReferencia, ativo, quantidadePadrao, pesoEmbalagemG }) {
  const ref = CATALOGO.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Item não encontrado.');
  const patch = {};
  if (nome != null) {
    const n = String(nome).trim();
    if (!n) throw new Error('Nome do item é obrigatório.');
    patch.nome = n.slice(0, 120);
  }
  if (setor != null) {
    const setores = await listSetores();
    if (!setores.some((s) => s.codigo === setor)) throw new Error('Setor inválido.');
    patch.setor = setor;
  }
  if (tipo != null) {
    const tipos = await listTipos();
    patch.tipo = tipos.includes(tipo) ? tipo : (tipos[0] || 'COMIDA');
  }
  if (unidadeMedida != null) patch.unidadeMedida = (String(unidadeMedida).trim().slice(0, 10) || 'UN').toUpperCase();
  if (custoReferencia != null) patch.custoReferencia = num(custoReferencia);
  if (ativo != null) patch.ativo = !!ativo;
  if (quantidadePadrao !== undefined) patch.quantidadePadrao = quantidadePadrao != null && quantidadePadrao !== '' ? num(quantidadePadrao) : null;
  if (pesoEmbalagemG !== undefined) patch.pesoEmbalagemG = pesoEmbalagemG != null && pesoEmbalagemG !== '' ? num(pesoEmbalagemG) : null;
  await ref.update(patch);
  catalogoCache.invalidar();
  return (await ref.get()).data();
}

async function removerItem(id) {
  const ref = CATALOGO.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Item não encontrado.');
  await ref.delete();
  catalogoCache.invalidar();
}

// idempotente - so insere itens cujo NOME normalizado ainda nao existe no
// catalogo, entao pode ser chamado de novo sem duplicar (ex: se o Master
// clicar 2x, ou apos adicionar itens manuais que ja cobrem parte da lista)
async function seedCatalogoPadrao() {
  const existentes = await listCatalogo();
  const nomesExistentes = new Set(existentes.map((i) => normalizarNome(i.nome)));
  const novos = CATALOGO_SEED.filter((i) => !nomesExistentes.has(normalizarNome(i.nome)));
  const agora = new Date().toISOString();
  await Promise.all(novos.map((i) => {
    const ref = CATALOGO.doc();
    return ref.set({
      id: ref.id, nome: i.nome, setor: i.setor, tipo: i.tipo,
      unidadeMedida: i.unidadeMedida, custoReferencia: i.custoReferencia || 0,
      ativo: true, createdAt: agora,
    });
  }));
  if (novos.length) catalogoCache.invalidar();
  return { adicionados: novos.length, jaExistiam: existentes.length };
}

// ---------- recebimento de mercadoria (entrada) - guarda o valor unitario
// pago pra dar nocao de CMV (ver calcularDiferencas). A nota fiscal quase
// sempre traz os dois numeros impressos (Valor Unit. e Valor Total) - em vez
// de obrigar a loja a fazer a conta de cabeça, aceita o que ela tiver mais a
// mao e calcula o outro automaticamente (valorTotal informado sem
// valorUnitario -> divide pela quantidade; valorUnitario informado -> usa
// ele direto e recalcula o total, igual antes dessa mudanca).
//
// itens medidos em KG/G podem vir por EMBALAGEM em vez de quantidade direta
// (ex: 10 pacotes de 400g) - se quantidadeEmbalagens+pesoEmbalagem vierem
// preenchidos, a quantidade real (na unidadeMedida do item) e calculada a
// partir deles em vez do campo `quantidade` bruto, poupando a loja de fazer
// a conversao embalagem->peso de cabeca (o ponto que travava o lancamento
// de itens fracionados tipo 400g/300g/210g). O peso informado tambem vira o
// novo padrao do item no catalogo, pra pre-preencher o proximo recebimento -
// util quando a marca muda o tamanho da embalagem (1kg -> 1,2kg -> 1,7kg).
async function criarRecebimento({ unidade, unidadeNome, itemId, fornecedor, quantidade, quantidadeEmbalagens, pesoEmbalagem, valorUnitario, valorTotal, data, notaFiscal, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!itemId) throw new Error('Selecione o item.');
  const dataValida = validarData(data);
  const item = (await listCatalogo()).find((i) => i.id === itemId);
  if (!item) throw new Error('Item não encontrado no catálogo.');

  const porEmbalagem = ['KG', 'G'].includes(item.unidadeMedida) && num(quantidadeEmbalagens) > 0 && num(pesoEmbalagem) > 0;
  const pesoUsadoG = porEmbalagem ? num(pesoEmbalagem) : null;
  const qtd = porEmbalagem
    ? (item.unidadeMedida === 'KG' ? (num(quantidadeEmbalagens) * pesoUsadoG) / 1000 : num(quantidadeEmbalagens) * pesoUsadoG)
    : num(quantidade);
  if (qtd <= 0) throw new Error('Informe a quantidade recebida.');
  let valorUnit = num(valorUnitario);
  if (valorUnit <= 0 && num(valorTotal) > 0) valorUnit = num(valorTotal) / qtd;
  if (valorUnit < 0) throw new Error('Valor unitário inválido.');

  const ref = RECEBIMENTOS.doc();
  const registro = {
    id: ref.id, unidade, unidadeNome: unidadeNome || unidade,
    itemId, itemNome: item.nome, setor: item.setor,
    fornecedor: String(fornecedor || '').trim().slice(0, 80) || 'Não informado',
    quantidade: arred(qtd, 3), valorUnitario: valorUnit, valorTotal: arred(qtd * valorUnit),
    // so preenchidos quando o recebimento veio por embalagem - guardados pra
    // rastreabilidade/exibicao (a `quantidade` acima ja e o total convertido)
    quantidadeEmbalagens: porEmbalagem ? num(quantidadeEmbalagens) : null,
    pesoEmbalagem: pesoUsadoG,
    data: dataValida, notaFiscal: (notaFiscal || '').trim().slice(0, 60) || null,
    criadoPorId, criadoPorEmail, criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  recebimentosCache.invalidar();

  if (porEmbalagem && pesoUsadoG !== item.pesoEmbalagemG) {
    await atualizarItem(itemId, { pesoEmbalagemG: pesoUsadoG });
  }
  return registro;
}

async function listRecebimentosUncached() {
  const snap = await RECEBIMENTOS.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const recebimentosCache = createCache(listRecebimentosUncached, 20 * 1000);
const listRecebimentos = recebimentosCache.cached;

async function removerRecebimento(id) {
  const ref = RECEBIMENTOS.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Recebimento não encontrado.');
  await ref.delete();
  recebimentosCache.invalidar();
}

// ---------- saída (venda / desperdício / outra) ----------
async function criarSaida({ unidade, unidadeNome, itemId, tipo, quantidade, motivo, data, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!itemId) throw new Error('Selecione o item.');
  if (!TIPOS_SAIDA.includes(tipo)) throw new Error('Tipo de saída inválido.');
  const dataValida = validarData(data);
  const qtd = num(quantidade);
  if (qtd <= 0) throw new Error('Informe a quantidade.');
  const item = (await listCatalogo()).find((i) => i.id === itemId);
  if (!item) throw new Error('Item não encontrado no catálogo.');

  const ref = SAIDAS.doc();
  const registro = {
    id: ref.id, unidade, unidadeNome: unidadeNome || unidade,
    itemId, itemNome: item.nome, setor: item.setor,
    tipo, quantidade: qtd, motivo: String(motivo || '').trim().slice(0, 300) || null,
    data: dataValida, criadoPorId, criadoPorEmail, criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  saidasCache.invalidar();
  return registro;
}

async function listSaidasUncached() {
  const snap = await SAIDAS.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const saidasCache = createCache(listSaidasUncached, 20 * 1000);
const listSaidas = saidasCache.cached;

async function removerSaida(id) {
  const ref = SAIDAS.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Saída não encontrada.');
  await ref.delete();
  saidasCache.invalidar();
}

// ---------- contagem diária - 1 doc por unidade+data (map itemId->qtd), pra
// nao multiplicar leituras/escritas por item (a mesma logica de
// canaisVendaExtras em fechamentosLive.js) ----------
function docIdContagem(unidade, data) {
  return `${unidade}__${data}`;
}

async function upsertContagem({ unidade, unidadeNome, data, contagens, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const dataValida = validarData(data);
  if (!contagens || typeof contagens !== 'object' || Array.isArray(contagens)) throw new Error('Informe as contagens.');
  const limpas = {};
  Object.entries(contagens).forEach(([itemId, valor]) => {
    if (valor === '' || valor == null) return;
    limpas[itemId] = num(valor);
  });
  if (!Object.keys(limpas).length) throw new Error('Nenhuma contagem informada.');

  const ref = CONTAGENS.doc(docIdContagem(unidade, dataValida));
  const snap = await ref.get();
  const atual = snap.exists ? snap.data() : null;
  const agora = new Date().toISOString();
  const registro = {
    id: ref.id, unidade, unidadeNome: unidadeNome || unidade, data: dataValida,
    contagens: { ...(atual?.contagens || {}), ...limpas },
    criadoPorId: atual?.criadoPorId || criadoPorId,
    criadoPorEmail: atual?.criadoPorEmail || criadoPorEmail,
    criadoEm: atual?.criadoEm || agora,
    atualizadoPorEmail: criadoPorEmail,
    atualizadoEm: agora,
  };
  await ref.set(registro);
  contagensCache.invalidar();
  return registro;
}

async function getContagem(unidade, data) {
  const doc = await CONTAGENS.doc(docIdContagem(unidade, validarData(data))).get();
  return doc.exists ? doc.data() : null;
}

async function listContagensUncached() {
  const snap = await CONTAGENS.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const contagensCache = createCache(listContagensUncached, 20 * 1000);
const listContagens = contagensCache.cached;

// ---------- motor de calculo: esperado x real ----------
function diaAnterior(data) {
  const d = new Date(`${data}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return isoLocal(d);
}
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function diasEntre(inicio, fim) {
  const dias = [];
  let atual = inicio;
  let guard = 0;
  while (atual <= fim && guard < 400) {
    dias.push(atual);
    const d = new Date(`${atual}T00:00:00`);
    d.setDate(d.getDate() + 1);
    atual = isoLocal(d);
    guard += 1;
  }
  return dias;
}

// Para o intervalo [dataInicio, dataFim] de uma unidade, calcula por dia e
// por item: contagemAnterior, entradas, saidas (venda/desperdicio/outra),
// esperado, real, diferenca (real-esperado) e o valor em R$ dessa diferenca
// (custo unitario = media dos recebimentos do item NESSE periodo, ou o
// custoReferencia cadastrado no catalogo se nao houve recebimento) - depois
// agrega por item pra virar o ranking de "ofensores" (maior |diferenca| em
// R$, nao so em quantidade, pra priorizar o que realmente pesa no CMV).
async function calcularDiferencas(unidade, dataInicio, dataFim) {
  validarData(dataInicio);
  validarData(dataFim);
  if (dataFim < dataInicio) throw new Error('Data final não pode ser anterior à inicial.');
  const diaBase = diaAnterior(dataInicio);

  const [todasContagens, todosRecebimentos, todasSaidas, catalogo] = await Promise.all([
    listContagens(), listRecebimentos(), listSaidas(), listCatalogo(),
  ]);
  const catalogoPorId = new Map(catalogo.map((i) => [i.id, i]));

  const contagensPorData = new Map();
  todasContagens
    .filter((c) => c.unidade === unidade && c.data >= diaBase && c.data <= dataFim)
    .forEach((c) => contagensPorData.set(c.data, c.contagens || {}));

  const recebimentosPeriodo = todosRecebimentos.filter((r) => r.unidade === unidade && r.data >= dataInicio && r.data <= dataFim);
  const saidasPeriodo = todasSaidas.filter((s) => s.unidade === unidade && s.data >= dataInicio && s.data <= dataFim);

  const custoPorItem = new Map(catalogo.map((i) => [i.id, i.custoReferencia || 0]));
  const somaCusto = new Map();
  const qtdCusto = new Map();
  recebimentosPeriodo.forEach((r) => {
    somaCusto.set(r.itemId, (somaCusto.get(r.itemId) || 0) + r.valorUnitario * r.quantidade);
    qtdCusto.set(r.itemId, (qtdCusto.get(r.itemId) || 0) + r.quantidade);
  });
  somaCusto.forEach((soma, itemId) => {
    const qtd = qtdCusto.get(itemId);
    if (qtd > 0) custoPorItem.set(itemId, soma / qtd);
  });

  const dias = diasEntre(dataInicio, dataFim);
  const porDia = [];
  const acumuladoPorItem = new Map();

  dias.forEach((data) => {
    const contagemHoje = contagensPorData.get(data) || {};
    const contagemOntem = contagensPorData.get(diaAnterior(data)) || {};
    const recebimentosDoDia = recebimentosPeriodo.filter((r) => r.data === data);
    const saidasDoDia = saidasPeriodo.filter((s) => s.data === data);

    const itensEnvolvidos = new Set([
      ...Object.keys(contagemHoje), ...Object.keys(contagemOntem),
      ...recebimentosDoDia.map((r) => r.itemId), ...saidasDoDia.map((s) => s.itemId),
    ]);

    itensEnvolvidos.forEach((itemId) => {
      const item = catalogoPorId.get(itemId);
      const contagemAnterior = Object.prototype.hasOwnProperty.call(contagemOntem, itemId) ? contagemOntem[itemId] : null;
      const entradas = recebimentosDoDia.filter((r) => r.itemId === itemId).reduce((s, r) => s + r.quantidade, 0);
      const saidasItem = saidasDoDia.filter((s) => s.itemId === itemId);
      const vendas = saidasItem.filter((s) => s.tipo === 'VENDA').reduce((s, x) => s + x.quantidade, 0);
      const desperdicios = saidasItem.filter((s) => s.tipo === 'DESPERDICIO').reduce((s, x) => s + x.quantidade, 0);
      const outras = saidasItem.filter((s) => s.tipo === 'OUTRA').reduce((s, x) => s + x.quantidade, 0);
      const totalSaidas = vendas + desperdicios + outras;
      const real = Object.prototype.hasOwnProperty.call(contagemHoje, itemId) ? contagemHoje[itemId] : null;
      const esperado = contagemAnterior != null ? arred(contagemAnterior + entradas - totalSaidas, 3) : null;
      const diferenca = (real != null && esperado != null) ? arred(real - esperado, 3) : null;
      const custoUnitario = custoPorItem.get(itemId) || 0;
      const diferencaValor = diferenca != null ? arred(diferenca * custoUnitario) : null;

      porDia.push({
        data, itemId, itemNome: item ? item.nome : itemId, setor: item ? item.setor : null,
        unidadeMedida: item ? item.unidadeMedida : 'UN',
        contagemAnterior, entradas, vendas, desperdicios, outras, totalSaidas,
        esperado, real, diferenca, custoUnitario: arred(custoUnitario, 4), diferencaValor,
      });

      if (diferenca != null) {
        const acc = acumuladoPorItem.get(itemId) || {
          itemId, itemNome: item ? item.nome : itemId, setor: item ? item.setor : null,
          unidadeMedida: item ? item.unidadeMedida : 'UN',
          entradas: 0, vendas: 0, desperdicios: 0, outras: 0,
          diferencaQtd: 0, diferencaValor: 0, dias: 0,
        };
        acc.entradas += entradas; acc.vendas += vendas; acc.desperdicios += desperdicios; acc.outras += outras;
        acc.diferencaQtd += diferenca; acc.diferencaValor += diferencaValor; acc.dias += 1;
        acumuladoPorItem.set(itemId, acc);
      }
    });
  });

  const ofensores = [...acumuladoPorItem.values()]
    .map((x) => ({ ...x, diferencaQtd: arred(x.diferencaQtd, 3), diferencaValor: arred(x.diferencaValor) }))
    .sort((a, b) => Math.abs(b.diferencaValor) - Math.abs(a.diferencaValor));

  const custoDesperdicio = arred(saidasPeriodo.filter((s) => s.tipo === 'DESPERDICIO').reduce((s, x) => s + x.quantidade * (custoPorItem.get(x.itemId) || 0), 0));
  const custoVenda = arred(saidasPeriodo.filter((s) => s.tipo === 'VENDA').reduce((s, x) => s + x.quantidade * (custoPorItem.get(x.itemId) || 0), 0));
  const totalRecebidoValor = arred(recebimentosPeriodo.reduce((s, r) => s + r.valorTotal, 0));
  const totalDiferencaValor = arred(ofensores.reduce((s, x) => s + x.diferencaValor, 0));
  const totalFaltaValor = arred(ofensores.filter((x) => x.diferencaValor < 0).reduce((s, x) => s + x.diferencaValor, 0));
  const totalSobraValor = arred(ofensores.filter((x) => x.diferencaValor > 0).reduce((s, x) => s + x.diferencaValor, 0));

  return {
    porDia, ofensores,
    resumo: {
      totalRecebidoValor, custoDesperdicioValor: custoDesperdicio, custoVendaValor: custoVenda,
      totalDiferencaValor, totalFaltaValor, totalSobraValor,
    },
  };
}

module.exports = {
  SETORES, TIPOS_ITEM, TIPOS_SAIDA,
  listSetores, criarSetor, listTipos, criarTipo,
  listCatalogo, criarItem, atualizarItem, removerItem, seedCatalogoPadrao, reordenarItens,
  listRecebimentos, criarRecebimento, removerRecebimento,
  listSaidas, criarSaida, removerSaida,
  upsertContagem, getContagem, listContagens,
  calcularDiferencas,
};
