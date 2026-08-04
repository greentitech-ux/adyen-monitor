// grupos.js
// Cada franquia/rede lança fechamento de um jeito diferente - o Faturamento e
// o Total Declarado usam a mesma fórmula pra todo mundo (canais de venda /
// formas de pagamento, ver fechamentosLive.js), mas os KPI's variam muito
// (ex: Domino's acompanha LegTime/RunTime/OTD que não fazem sentido pra
// quem não usa aquele sistema de entrega). Essa coleção deixa o Master
// montar, por grupo, quais campos de KPI extras aparecem no formulário de
// fechamento - sem precisar de código novo a cada franquia diferente.
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

function sanitizarKpisExtras(lista) {
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
      return { campo, label };
    })
    .filter(Boolean)
    .slice(0, 40);
}

async function listUncached() {
  const snap = await COLLECTION.orderBy('nome', 'asc').get();
  return snap.docs.map((d) => d.data());
}
const gruposCache = createCache(listUncached, 20 * 1000);
const list = gruposCache.cached;

async function create({ nome, unidades, kpisExtras }) {
  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) throw new Error('Informe o nome do grupo.');
  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    nome: nomeLimpo,
    unidades: Array.isArray(unidades) ? unidades.map(String) : [],
    kpisExtras: sanitizarKpisExtras(kpisExtras),
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  gruposCache.invalidar();
  return registro;
}

async function update(id, { nome, unidades, kpisExtras }) {
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
  if (kpisExtras != null) patch.kpisExtras = sanitizarKpisExtras(kpisExtras);
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
