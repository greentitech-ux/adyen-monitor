// entregasRegras.js
// Regra de pagamento por unidade do app de Entregas (motoboys) - definida
// pelo Master em /entregas-regras.html, no mesmo espírito do construtor de
// campos extras do Fechamento (ver grupos.js): em vez de 5 campos fixos,
// cada unidade monta sua PRÓPRIA lista de campos de valor (camposValor) -
// Entrega, Retorno, Extra, Fora de Área, Encosta, Ajuda de Custo,
// Cooperativa, ou qualquer nome que a franquia usar.
//
// Cada campo pode:
//   - aplicar sobre uma contagem do lançamento (Entrega/Retorno/Extra/Fora de
//     Área) -> valor = contagem × taxa; ou ser "valor fixo por lançamento"
//     (ex: Ajuda de Custo/Encosta, que não multiplicam por contagem nenhuma);
//   - somar no "Valor a pagar" ao entregador, ou no "repasse da Cooperativa"
//     (a Cooperativa normalmente só soma sobre Entrega, nunca sobre
//     Retorno/Extra - mas quem decide isso é a taxa/base escolhida pelo
//     Master pra cada campo, não algo fixo no código);
//   - ter uma taxa diferente por dia da semana (ex: R$20 seg-sex, R$30
//     sáb/dom);
//   - ter uma meta mínima numa contagem do lançamento - se não bater, usa um
//     valor parcial (ou zero) no lugar da taxa cheia;
//   - ser removível pela loja no lançamento (ex: entregador atrasou/saiu
//     antes/gerou prejuízo - perde aquele campo específico naquela corrida).
//
// modo "plataforma" continua igual: unidade sem valor fixo (paga o que uma
// plataforma externa tipo GAMI/NEXT informar) - a loja digita os valores à
// mão, sem usar camposValor nenhum.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('entregasRegras');

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const BASES_VALIDAS = new Set(['entrega', 'retorno', 'extra', 'foraDeArea', 'flat']);
const DESTINOS_VALIDOS = new Set(['valor', 'coopRecebe']);
const MOTIVOS_REMOCAO_CAMPO = ['atraso', 'saiu_antes', 'prejuizo', 'outro'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// mesmo slugify de grupos.js - vira um identificador estavel (campo) a
// partir do nome digitado (label), ex "Ajuda de Custo" -> "ajudaDeCusto"
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

function sanitizarValoresPorDiaSemana(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const resultado = {};
  let algum = false;
  DIAS_SEMANA.forEach((d) => {
    if (obj[d] != null && obj[d] !== '') { resultado[d] = num(obj[d]); algum = true; }
  });
  return algum ? resultado : null;
}

function sanitizarMeta(m) {
  if (!m || !m.ativo) return null;
  const baseContagem = ['entrega', 'retorno', 'extra', 'foraDeArea', 'quantTotal'].includes(m.baseContagem) ? m.baseContagem : 'entrega';
  return { baseContagem, minimo: num(m.minimo), valorParcial: num(m.valorParcial) };
}

function sanitizarCamposValor(lista) {
  if (!Array.isArray(lista)) return [];
  const usados = new Set();
  return lista
    .map((c) => {
      const label = String(c?.label || '').trim().slice(0, 40);
      if (!label) return null;
      let campo = slugify(c?.campo) || slugify(label);
      if (!campo) return null;
      let base = campo;
      let n = 2;
      while (usados.has(campo)) { campo = base + n; n += 1; }
      usados.add(campo);
      return {
        campo,
        label,
        base: BASES_VALIDAS.has(c?.base) ? c.base : 'flat',
        destino: DESTINOS_VALIDOS.has(c?.destino) ? c.destino : 'valor',
        valorPadrao: num(c?.valorPadrao),
        valoresPorDiaSemana: sanitizarValoresPorDiaSemana(c?.valoresPorDiaSemana),
        meta: sanitizarMeta(c?.meta),
        removivelPelaLoja: !!c?.removivelPelaLoja,
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function defaultRegra(unidade) {
  return {
    unidade,
    modo: 'plataforma',
    plataformaNome: '',
    camposValor: [],
    atualizadoEm: null,
    atualizadoPorEmail: null,
  };
}

async function listAllUncached() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}
const regrasCache = createCache(listAllUncached, 20 * 1000);
const listAll = regrasCache.cached;

async function getPara(unidade) {
  const doc = await COLLECTION.doc(unidade).get();
  return doc.exists ? doc.data() : defaultRegra(unidade);
}

async function salvar(unidade, campos, atualizadoPorEmail) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const modo = campos?.modo === 'fixo' ? 'fixo' : 'plataforma';
  const registro = {
    unidade,
    modo,
    plataformaNome: String(campos?.plataformaNome || '').trim().slice(0, 40),
    camposValor: sanitizarCamposValor(campos?.camposValor),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail,
  };
  await COLLECTION.doc(unidade).set(registro);
  regrasCache.invalidar();
  return registro;
}

// "qua","sex","sab"... a partir de uma data ISO (yyyy-mm-dd), sem depender
// de fuso do servidor (new Date('yyyy-mm-dd') já vem em UTC 00:00, e
// getUTCDay bate certo com o dia civil da data informada)
function diaSemanaDe(dataIso) {
  const d = new Date(`${dataIso}T00:00:00Z`);
  return DIAS_SEMANA[d.getUTCDay()];
}

// calcula os valores de um lançamento a partir das contagens digitadas pela
// loja + a lista de camposValor da unidade. Só chamada quando regra.modo ===
// 'fixo' - no modo "plataforma" os valores continuam vindo direto do
// formulário. "camposRemovidos" é a lista de `campo` (slug) que a loja
// marcou pra não pagar naquela corrida (ex: Encosta removida por atraso).
function calcular(regra, { data, entrega, retorno, extra, foraDeArea, camposRemovidos }) {
  const contagens = {
    entrega: num(entrega), retorno: num(retorno), extra: num(extra), foraDeArea: num(foraDeArea),
  };
  contagens.quantTotal = contagens.entrega + contagens.retorno + contagens.extra;
  const dia = data ? diaSemanaDe(data) : null;
  const removidos = new Set(Array.isArray(camposRemovidos) ? camposRemovidos : []);

  let valor = 0;
  let coopRecebe = 0;
  let ajudaCusto = 0; // soma dos campos "flat" que somam no Valor a pagar - alimenta a coluna legada
  const detalhes = [];

  (regra.camposValor || []).forEach((c) => {
    if (removidos.has(c.campo)) {
      detalhes.push({ campo: c.campo, label: c.label, valor: 0, removido: true });
      return;
    }
    let taxa = (dia && c.valoresPorDiaSemana && c.valoresPorDiaSemana[dia] != null) ? c.valoresPorDiaSemana[dia] : c.valorPadrao;
    if (c.meta) {
      const contagemMeta = contagens[c.meta.baseContagem] ?? 0;
      if (contagemMeta < c.meta.minimo) taxa = c.meta.valorParcial;
    }
    const valorCampo = c.base === 'flat' ? taxa : (contagens[c.base] || 0) * taxa;
    detalhes.push({ campo: c.campo, label: c.label, valor: +valorCampo.toFixed(2) });
    if (c.destino === 'coopRecebe') coopRecebe += valorCampo;
    else {
      valor += valorCampo;
      if (c.base === 'flat') ajudaCusto += valorCampo;
    }
  });

  return {
    valor: +valor.toFixed(2),
    coopRecebe: +coopRecebe.toFixed(2),
    ajudaCusto: +ajudaCusto.toFixed(2),
    quantTotal: contagens.quantTotal,
    detalhesValor: detalhes,
  };
}

module.exports = {
  listAll, getPara, salvar, calcular, defaultRegra,
  DIAS_SEMANA, BASES_VALIDAS, DESTINOS_VALIDOS, MOTIVOS_REMOCAO_CAMPO,
};
