// grupos.js
// Cada franquia/rede lança fechamento de um jeito diferente. Essa coleção
// deixa o Master montar, por grupo, campos extras em três frentes do
// fechamento - Canais de venda (somam no Faturamento), Formas de pagamento
// (somam no Total Declarado) e KPI's (não somam em nada, só informativos) -
// sem precisar de código novo a cada franquia diferente. Os campos fixos de
// cada seção (Delivery/Carryout/... e Adyen/Ifood/... e TC/Cancelados)
// continuam os mesmos pra todo mundo; os extras daqui são um acréscimo por
// cima, nunca uma substituição (ver recomputarTotais em fechamentosLive.js).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('grupos');

// vira um identificador estavel (campo) a partir do nome digitado (label) -
// ex "Taxa de entrega" -> "taxaDeEntrega". Assim o Master só digita o nome
// bonito e a gente cuida da chave usada pra gravar o valor.
function slugify(s) {
  const limpo = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  if (!limpo) return '';
  return limpo
    .split(' ')
    .map((palavra, i) => (i === 0 ? palavra.toLowerCase() : palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase()))
    .join('');
}

// unidades de medida de um KPI extra - so faz sentido pra kpisExtras (Canais
// de venda/Formas de pagamento sempre somam em R$, entao nem mostram esse
// seletor em grupos.html). "quantidade" e o padrao pra KPI sem tipo definido
// (grupo criado antes dessa feature).
const TIPOS_KPI_VALIDOS = new Set(['quantidade', 'moeda', 'kg', 'arquivo', 'texto']);

// usado pras 3 listas de campos extras (kpisExtras, canaisVendaExtras,
// formasPagamentoExtras) - mesmo formato, mesma validacao. "tipo" so e
// gravado quando informado (canais/formas nunca mandam, entao continuam sem
// esse campo no documento).
function sanitizarCamposExtras(lista) {
  if (!Array.isArray(lista)) return [];
  const usados = new Set();
  return lista
    .map((k) => {
      const label = String(k?.label || '').trim().slice(0, 60);
      if (!label) return null;
      let campo = slugify(k?.campo) || slugify(label);
      if (!campo) return null;
      let base = campo;
      let n = 2;
      while (usados.has(campo)) { campo = base + n; n += 1; }
      usados.add(campo);
      const item = { campo, label };
      if (k?.tipo != null) item.tipo = TIPOS_KPI_VALIDOS.has(k.tipo) ? k.tipo : 'quantidade';
      return item;
    })
    .filter(Boolean)
    .slice(0, 40);
}

// nome padrao das maquininhas (ex: "Maquininha 1", "Maquininha 2"...) -
// franquia que usa uma maquinha especifica pode trocar o prefixo (ex:
// "Getnet" -> "Getnet 1", "Getnet 2"...), ver lancamento.html
function sanitizarPrefixo(s) {
  const limpo = String(s || '').trim().slice(0, 30);
  return limpo || 'Maquininha';
}

async function listUncached() {
  const snap = await COLLECTION.orderBy('nome', 'asc').get();
  return snap.docs.map((d) => d.data());
}
const gruposCache = createCache(listUncached, 20 * 1000);
const list = gruposCache.cached;

async function create({ nome, unidades, kpisExtras, canaisVendaExtras, formasPagamentoExtras, responsaveis, caixaHabilitado, maquininhasHabilitado, maquininhaPrefixo, saidasHabilitado }) {
  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) throw new Error('Informe o nome do grupo.');
  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    nome: nomeLimpo,
    unidades: Array.isArray(unidades) ? unidades.map(String) : [],
    kpisExtras: sanitizarCamposExtras(kpisExtras),
    canaisVendaExtras: sanitizarCamposExtras(canaisVendaExtras),
    formasPagamentoExtras: sanitizarCamposExtras(formasPagamentoExtras),
    // ids dos usuarios Master/Admin responsaveis por esse grupo - usado pra
    // deixar quem lanca uma solicitacao direcionar pra um deles (ver
    // GET /api/grupos/responsaveis em index.js)
    responsaveis: Array.isArray(responsaveis) ? responsaveis.map(String) : [],
    // secoes fixas do lancamento (Caixa/Maquininhas/Outras saidas) que a
    // franquia pode nao usar - todas habilitadas por padrao (comportamento
    // de sempre, pra grupo criado antes dessa feature nao mudar nada)
    caixaHabilitado: caixaHabilitado !== false,
    maquininhasHabilitado: maquininhasHabilitado !== false,
    maquininhaPrefixo: sanitizarPrefixo(maquininhaPrefixo),
    saidasHabilitado: saidasHabilitado !== false,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  gruposCache.invalidar();
  return registro;
}

async function update(id, { nome, unidades, kpisExtras, canaisVendaExtras, formasPagamentoExtras, responsaveis, caixaHabilitado, maquininhasHabilitado, maquininhaPrefixo, saidasHabilitado }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Grupo não encontrado.');
  const patch = {};
  if (nome != null) {
    const nomeLimpo = String(nome).trim();
    if (!nomeLimpo) throw new Error('Informe o nome do grupo.');
    patch.nome = nomeLimpo;
  }
  if (unidades != null) patch.unidades = Array.isArray(unidades) ? unidades.map(String) : [];
  if (kpisExtras != null) patch.kpisExtras = sanitizarCamposExtras(kpisExtras);
  if (canaisVendaExtras != null) patch.canaisVendaExtras = sanitizarCamposExtras(canaisVendaExtras);
  if (formasPagamentoExtras != null) patch.formasPagamentoExtras = sanitizarCamposExtras(formasPagamentoExtras);
  if (responsaveis != null) patch.responsaveis = Array.isArray(responsaveis) ? responsaveis.map(String) : [];
  if (caixaHabilitado != null) patch.caixaHabilitado = caixaHabilitado !== false;
  if (maquininhasHabilitado != null) patch.maquininhasHabilitado = maquininhasHabilitado !== false;
  if (maquininhaPrefixo != null) patch.maquininhaPrefixo = sanitizarPrefixo(maquininhaPrefixo);
  if (saidasHabilitado != null) patch.saidasHabilitado = saidasHabilitado !== false;
  await ref.update(patch);
  gruposCache.invalidar();
  return { ...snap.data(), ...patch };
}

async function remove(id) {
  await COLLECTION.doc(id).delete();
  gruposCache.invalidar();
}

// acha o grupo (com os kpisExtras dele) de uma unidade especifica - usado
// pelo formulario de fechamento pra saber quais campos extras mostrar. Uma
// unidade sem grupo cadastrado simplesmente nao tem KPI extra nenhum (so os
// campos fixos TC/Cancelados).
async function grupoDaUnidade(unidade) {
  const grupos = await list();
  return grupos.find((g) => (g.unidades || []).includes(unidade)) || null;
}

module.exports = { list, create, update, remove, grupoDaUnidade };
