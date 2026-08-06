// mensalistas.js
// Passaporte mensal (Saltiverso Patteo) - plano de 30 dias por pessoa, com
// ate 4 usuarios vinculados. Mesmo padrao de parque.js/festas.js: colecao
// Firestore propria, cache curto via liveCache.js. "Ativo" nao e um campo
// gravado - e sempre calculado comparando hoje com dataInicial/dataFinal,
// pra nao precisar de job nenhum pra "expirar" planos sozinho.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('mensalistas');
const DIAS_VALIDADE_PADRAO = 30;

function somarDias(dataIso, dias) {
  const d = new Date(dataIso + 'T00:00:00');
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sanitizarUsuarios(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((u) => ({
      nome: String((u && u.nome) || '').trim().slice(0, 120),
      dataNascimento: (u && u.dataNascimento) || null,
    }))
    .filter((u) => u.nome)
    .slice(0, 4);
}

async function criar({
  unidade, unidadeNome, nome, cpf, contato, email, cep, numero, complemento,
  dataInicial, valorPlano, usuarios, criadoPorId, criadoPorEmail,
}) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!nome || !String(nome).trim()) throw new Error('Informe o nome do responsável.');
  if (!dataInicial || !/^\d{4}-\d{2}-\d{2}$/.test(dataInicial)) throw new Error('Informe a data de início.');

  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    nome: String(nome).trim().slice(0, 150),
    cpf: String(cpf || '').trim().slice(0, 20),
    contato: String(contato || '').trim().slice(0, 30),
    email: String(email || '').trim().slice(0, 150),
    cep: String(cep || '').trim().slice(0, 20),
    numero: String(numero || '').trim().slice(0, 20),
    complemento: String(complemento || '').trim().slice(0, 100),
    dataInicial,
    dataFinal: somarDias(dataInicial, DIAS_VALIDADE_PADRAO),
    valorPlano: Math.max(0, num(valorPlano)),
    usuarios: sanitizarUsuarios(usuarios),
    criadoPorId,
    criadoPorEmail,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  mensalistasCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('dataInicial', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const mensalistasCache = createCache(listAllUncached, 20 * 1000);
const listAll = mensalistasCache.cached;

async function listByUnidades(unidades) {
  if (!unidades || !unidades.length) return [];
  const lotes = [];
  for (let i = 0; i < unidades.length; i += 30) lotes.push(unidades.slice(i, i + 30));
  const resultados = await Promise.all(lotes.map((lote) => COLLECTION.where('unidade', 'in', lote).get()));
  return resultados.flatMap((snap) => snap.docs.map((d) => d.data()));
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function atualizar(id, patch) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Mensalista não encontrado.');
  const merge = {};

  if (patch.nome !== undefined) merge.nome = String(patch.nome).trim().slice(0, 150);
  if (patch.cpf !== undefined) merge.cpf = String(patch.cpf).trim().slice(0, 20);
  if (patch.contato !== undefined) merge.contato = String(patch.contato).trim().slice(0, 30);
  if (patch.email !== undefined) merge.email = String(patch.email).trim().slice(0, 150);
  if (patch.dataInicial !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dataInicial)) throw new Error('Data de início inválida.');
    merge.dataInicial = patch.dataInicial;
    merge.dataFinal = somarDias(patch.dataInicial, DIAS_VALIDADE_PADRAO);
  }
  if (patch.dataFinal !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dataFinal)) throw new Error('Data final inválida.');
    merge.dataFinal = patch.dataFinal; // permite renovar/estender manualmente
  }
  if (patch.usuarios !== undefined) merge.usuarios = sanitizarUsuarios(patch.usuarios);
  if (patch.valorPlano !== undefined) merge.valorPlano = Math.max(0, num(patch.valorPlano));

  merge.atualizadoEm = new Date().toISOString();
  await ref.update(merge);
  mensalistasCache.invalidar();
  return getOne(id);
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Mensalista não encontrado.');
  await COLLECTION.doc(id).delete();
  mensalistasCache.invalidar();
}

function estaAtivo(registro, hojeIso) {
  return registro.dataInicial <= hojeIso && hojeIso <= registro.dataFinal;
}

module.exports = { DIAS_VALIDADE_PADRAO, criar, listAll, listByUnidades, getOne, atualizar, remover, estaAtivo };
