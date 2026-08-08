// ativosTI.js
// Inventario de ATIVOS DE TI das lojas (monitores, CPUs, pin pads,
// impressoras, e o rack: roteador, switch, DVR, cameras...). Funciona por
// VISTORIA: o tecnico que vai a loja (secao 'ativos-ti', concedida pelo
// Master) registra o que encontrou, organizado em AREAS (ex: "Loja" e
// "Rack"), cada area com itens de descricao + quantidade + observacao
// ("confirmar", numero de serie...). O inventario ATUAL de uma loja e a
// vistoria mais recente; as anteriores ficam como historico - da pra ver o
// que mudou entre visitas.
//
// Seed: os levantamentos ja feitos pelo time (Anderson, 02/07/2026) entram
// como primeira vistoria das 3 lojas, com as duvidas anotadas na observacao.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('ativosTI');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function sanitizarAreas(areas) {
  if (!Array.isArray(areas)) return [];
  return areas.slice(0, 10).map((a) => ({
    nome: String(a?.nome || '').trim().slice(0, 60) || 'Loja',
    itens: (Array.isArray(a?.itens) ? a.itens : []).slice(0, 60)
      .map((i) => ({
        descricao: String(i?.descricao || '').trim().slice(0, 120),
        quantidade: num(i?.quantidade),
        observacao: String(i?.observacao || '').trim().slice(0, 200),
      }))
      .filter((i) => i.descricao),
  })).filter((a) => a.itens.length);
}

async function criar({ unidade, unidadeNome, areas, observacao, criadoPorEmail, criadoPorNome }) {
  if (!unidade) throw new Error('Escolha a loja.');
  const areasLimpas = sanitizarAreas(areas);
  if (!areasLimpas.length) throw new Error('Registre ao menos um ativo.');
  const doc = COLLECTION.doc();
  const registro = {
    id: doc.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    areas: areasLimpas,
    observacao: String(observacao || '').trim().slice(0, 500),
    totalAtivos: areasLimpas.reduce((t, a) => t + a.itens.reduce((s, i) => s + i.quantidade, 0), 0),
    criadoPorEmail: criadoPorEmail || null,
    criadoPorNome: criadoPorNome || null,
    criadoEm: new Date().toISOString(),
  };
  await doc.set(registro);
  cache.invalidar();
  return registro;
}

async function remover(id) {
  const doc = await COLLECTION.doc(id).get();
  if (!doc.exists) throw new Error('Vistoria não encontrada.');
  await COLLECTION.doc(id).delete();
  cache.invalidar();
}

// vistorias iniciais: levantamento do Anderson em 02/07/2026 (WhatsApp) -
// "4 vou" e "1 suite" eram digitacao por voz de "4 CPU" e "1 switch"
const SEED = [
  {
    unidade: 'Spoleto Shopping Tacaruna', unidadeNome: 'Spoleto Tacaruna',
    areas: [
      { nome: 'Loja', itens: [
        { descricao: 'Monitor', quantidade: 3, observacao: '' },
        { descricao: 'CPU montada', quantidade: 3, observacao: '' },
        { descricao: 'Pin pad', quantidade: 2, observacao: '' },
        { descricao: 'Impressora térmica', quantidade: 2, observacao: '' },
        { descricao: 'Impressora jato de tinta', quantidade: 1, observacao: '' },
      ] },
      { nome: 'Rack', itens: [
        { descricao: 'CPU', quantidade: 2, observacao: '' },
        { descricao: 'Roteador', quantidade: 1, observacao: '' },
        { descricao: 'Switch', quantidade: 1, observacao: '' },
        { descricao: 'DVR', quantidade: 1, observacao: '' },
        { descricao: 'Câmeras', quantidade: 0, observacao: 'quantidade a confirmar' },
      ] },
    ],
  },
  {
    unidade: 'Spoleto Praça Aeroporto Recife', unidadeNome: "Spoleto/Domino's Aeroporto",
    areas: [
      { nome: 'Loja', itens: [
        { descricao: 'TV', quantidade: 6, observacao: '' },
        { descricao: 'Monitor', quantidade: 6, observacao: '' },
        { descricao: 'CPU', quantidade: 6, observacao: '' },
        { descricao: 'Pin pad', quantidade: 5, observacao: '' },
        { descricao: 'Impressora jato de tinta', quantidade: 2, observacao: '' },
        { descricao: 'Impressora térmica', quantidade: 3, observacao: '' },
        { descricao: 'Impressora de etiqueta', quantidade: 1, observacao: '' },
        { descricao: 'Totem', quantidade: 3, observacao: '' },
      ] },
      { nome: 'Rack', itens: [
        { descricao: 'CPU', quantidade: 4, observacao: 'anotado como "4 vou" na vistoria - confirmar' },
        { descricao: 'Roteador', quantidade: 1, observacao: '' },
        { descricao: 'Switch', quantidade: 1, observacao: 'anotado como "1 suite" na vistoria - confirmar' },
        { descricao: 'Wi-Fi (access point)', quantidade: 2, observacao: '' },
        { descricao: 'Estabilizador/Nobreak', quantidade: 1, observacao: '' },
      ] },
    ],
  },
  {
    unidade: 'São Braz IL', unidadeNome: 'São Brás Ilha do Leite',
    areas: [
      { nome: 'Loja', itens: [
        { descricao: 'Monitor', quantidade: 1, observacao: '' },
        { descricao: 'CPU', quantidade: 1, observacao: '' },
        { descricao: 'Notebook', quantidade: 1, observacao: '' },
        { descricao: 'Wi-Fi Intelbras', quantidade: 1, observacao: '' },
        { descricao: 'Impressora térmica', quantidade: 1, observacao: '' },
        { descricao: 'Pin pad', quantidade: 1, observacao: '' },
      ] },
      { nome: 'Rack', itens: [
        { descricao: 'DVR', quantidade: 1, observacao: '' },
        { descricao: 'Modem/Roteador', quantidade: 2, observacao: '' },
        { descricao: 'Câmeras', quantidade: 8, observacao: 'confirmar' },
      ] },
    ],
  },
];

const maisRecentePrimeiro = (a, b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || ''));

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  let itens = snap.docs.map((d) => d.data()).sort(maisRecentePrimeiro);
  if (!itens.length) {
    for (const v of SEED) {
      const doc = COLLECTION.doc();
      const areas = sanitizarAreas(v.areas);
      await doc.set({
        id: doc.id,
        unidade: v.unidade,
        unidadeNome: v.unidadeNome,
        areas,
        observacao: 'Vistoria inicial importada do levantamento de 02/07/2026 (Anderson).',
        totalAtivos: areas.reduce((t, a) => t + a.itens.reduce((s, i) => s + i.quantidade, 0), 0),
        criadoPorEmail: null,
        criadoPorNome: 'Anderson (levantamento 02/07/2026)',
        criadoEm: '2026-07-02T15:08:00.000Z',
      });
    }
    const snap2 = await COLLECTION.orderBy('criadoEm', 'desc').get();
    itens = snap2.docs.map((d) => d.data()).sort(maisRecentePrimeiro);
  }
  return itens;
}
const cache = createCache(listAllUncached, 20 * 1000);
const listAll = cache.cached;

module.exports = { criar, remover, listAll };
