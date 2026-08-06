// entregasRegras.js
// Regra de pagamento por unidade do app de Entregas (motoboys) - definida
// pelo Master em /entregas-regras.html, no mesmo espírito do construtor de
// campos extras do Fechamento (ver grupos.js): em vez de campos fixos, cada
// unidade monta sua PRÓPRIA lista de campos de valor (camposValor) -
// Entrega, Retorno, Extra, Fora de Área, Pos 00hs, Encosta, Ajuda de Custo,
// Cooperativa, ou qualquer nome que a franquia usar.
//
// Cada campo pode:
//   - aplicar sobre uma contagem do lançamento (Entrega/Retorno/Extra/Fora de
//     Área/Pos 00hs) -> valor = contagem × taxa; ou ser "valor fixo por
//     lançamento" (ex: Ajuda de Custo, que não multiplica por contagem
//     nenhuma);
//   - ter a taxa calculada (valorPadrao, com ou sem variação por dia da
//     semana/meta) OU ser "entrada manual" - a loja digita o R$ daquele
//     campo especificamente a cada lançamento (ex: Encosta em algumas
//     unidades, que varia e não segue uma tabela fixa);
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
// "Nomes especiais" (nomesEspeciais): quando o Nome do entregador bate com
// uma empresa de entrega cadastrada (ex: GAMI, Moovery) ou com um acordo
// próprio (ex: "Falcão Entregas" em Garanhuns, que tem uma taxa fixa
// diferente de todo mundo), o cálculo padrão da unidade é substituído:
//   - modoValor "manual": o lançamento inteiro vira igual ao modo
//     "plataforma" - loja digita Valor/COOP/Quantidade à mão, sem cálculo
//     nenhum (empresa terceirizada define o próprio preço);
//   - modoValor "taxaUnica": Valor = (Entrega+Retorno+Extra) × taxaUnica,
//     substituindo só os campos de "Valor a pagar" calculados - Cooperativa
//     (se configurada) continua somando normalmente.
//
// modo "plataforma" continua igual: unidade sem valor fixo nenhum (paga o
// que uma plataforma externa informar) - a loja digita os valores à mão,
// sem usar camposValor nenhum.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('entregasRegras');

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const BASES_VALIDAS = new Set(['entrega', 'retorno', 'extra', 'foraDeArea', 'pos00hs', 'flat']);
const DESTINOS_VALIDOS = new Set(['valor', 'coopRecebe']);
const MOTIVOS_REMOCAO_CAMPO = ['atraso', 'saiu_antes', 'prejuizo', 'outro'];
const MODOS_NOME_ESPECIAL = new Set(['manual', 'taxaUnica']);

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

// normaliza nome de entregador pra comparação (maiusculo, sem acento, sem
// espaco duplicado) - "Falcão Entregas" === "FALCAO ENTREGAS" === "falcão  entregas"
function normalizarNome(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().replace(/\s+/g, ' ').toUpperCase();
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
  const baseContagem = ['entrega', 'retorno', 'extra', 'foraDeArea', 'pos00hs', 'quantTotal'].includes(m.baseContagem) ? m.baseContagem : 'entrega';
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
      const entradaManual = !!c?.entradaManual;
      return {
        campo,
        label,
        base: BASES_VALIDAS.has(c?.base) ? c.base : 'flat',
        destino: DESTINOS_VALIDOS.has(c?.destino) ? c.destino : 'valor',
        entradaManual,
        // taxa/semana/meta so fazem sentido quando NAO e entrada manual
        valorPadrao: entradaManual ? 0 : num(c?.valorPadrao),
        valoresPorDiaSemana: entradaManual ? null : sanitizarValoresPorDiaSemana(c?.valoresPorDiaSemana),
        meta: entradaManual ? null : sanitizarMeta(c?.meta),
        removivelPelaLoja: !!c?.removivelPelaLoja,
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function sanitizarNomesEspeciais(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((n) => {
      const nomes = Array.isArray(n?.nomes)
        ? n.nomes.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20)
        : [];
      if (!nomes.length) return null;
      const modoValor = MODOS_NOME_ESPECIAL.has(n?.modoValor) ? n.modoValor : 'manual';
      return {
        nomes,
        modoValor,
        taxaUnica: modoValor === 'taxaUnica' ? num(n?.taxaUnica) : 0,
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
    nomesEspeciais: [],
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
    nomesEspeciais: sanitizarNomesEspeciais(campos?.nomesEspeciais),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail,
  };
  await COLLECTION.doc(unidade).set(registro);
  regrasCache.invalidar();
  return registro;
}

// "qua","sex","sab"... a partir de uma data ISO (yyyy-mm-dd), sem depender
// de fuso do servidor (new Date('yyyy-mm-dd') já vem em UTC 00:00, e
// getUTCDay já bate certo com o dia civil da data informada)
function diaSemanaDe(dataIso) {
  const d = new Date(`${dataIso}T00:00:00Z`);
  return DIAS_SEMANA[d.getUTCDay()];
}

// acha, se existir, o "nome especial" (empresa de entrega/acordo próprio)
// cadastrado na unidade que bate com o nome do entregador do lançamento
function encontrarNomeEspecial(regra, entregador) {
  const alvo = normalizarNome(entregador);
  if (!alvo) return null;
  return (regra.nomesEspeciais || []).find((ne) => ne.nomes.some((n) => normalizarNome(n) === alvo)) || null;
}

// calcula os valores de um lançamento a partir das contagens digitadas pela
// loja + a lista de camposValor da unidade. Só chamada quando regra.modo ===
// 'fixo' E o entregador NÃO bate com um nome especial "manual" (esse caso é
// tratado no chamador - entregasLive.js - igual ao modo "plataforma", sem
// passar por aqui). "camposRemovidos" é a lista de `campo` (slug) que a loja
// marcou pra não pagar naquela corrida. "valoresManuaisCampos" é
// {campo: valorDigitado} pros campos marcados como "entrada manual" (ex:
// Encosta, que varia e não segue tabela).
function calcular(regra, { data, entrega, retorno, extra, foraDeArea, pos00hs, camposRemovidos, entregador, valoresManuaisCampos }) {
  const contagens = {
    entrega: num(entrega), retorno: num(retorno), extra: num(extra),
    foraDeArea: num(foraDeArea), pos00hs: num(pos00hs),
  };
  contagens.quantTotal = contagens.entrega + contagens.retorno + contagens.extra;
  const dia = data ? diaSemanaDe(data) : null;
  const removidos = new Set(Array.isArray(camposRemovidos) ? camposRemovidos : []);
  const especial = encontrarNomeEspecial(regra, entregador);
  const usaTaxaUnica = especial && especial.modoValor === 'taxaUnica';

  let valor = 0;
  let coopRecebe = 0;
  let ajudaCusto = 0; // soma dos campos "flat" que somam no Valor a pagar - alimenta a coluna legada
  const detalhes = [];

  (regra.camposValor || []).forEach((c) => {
    if (removidos.has(c.campo)) {
      detalhes.push({ campo: c.campo, label: c.label, valor: 0, removido: true });
      return;
    }
    // taxa unica (ex: Falcão em Garanhuns) substitui os campos de "Valor a
    // pagar" calculados por uma unica formula (ver abaixo) - Cooperativa
    // continua normal
    if (usaTaxaUnica && c.destino === 'valor') return;

    let valorCampo;
    if (c.entradaManual) {
      valorCampo = num(valoresManuaisCampos?.[c.campo]);
    } else {
      let taxa = (dia && c.valoresPorDiaSemana && c.valoresPorDiaSemana[dia] != null) ? c.valoresPorDiaSemana[dia] : c.valorPadrao;
      if (c.meta) {
        const contagemMeta = contagens[c.meta.baseContagem] ?? 0;
        if (contagemMeta < c.meta.minimo) taxa = c.meta.valorParcial;
      }
      valorCampo = c.base === 'flat' ? taxa : (contagens[c.base] || 0) * taxa;
    }
    detalhes.push({ campo: c.campo, label: c.label, valor: +valorCampo.toFixed(2) });
    if (c.destino === 'coopRecebe') coopRecebe += valorCampo;
    else {
      valor += valorCampo;
      if (c.base === 'flat' && !c.entradaManual) ajudaCusto += valorCampo;
    }
  });

  if (usaTaxaUnica) {
    const valorTaxaUnica = contagens.quantTotal * especial.taxaUnica;
    valor += valorTaxaUnica;
    detalhes.push({ campo: 'taxaUnica', label: `${entregador} (taxa ${especial.taxaUnica}/entrega)`, valor: +valorTaxaUnica.toFixed(2) });
  }

  return {
    valor: +valor.toFixed(2),
    coopRecebe: +coopRecebe.toFixed(2),
    ajudaCusto: +ajudaCusto.toFixed(2),
    quantTotal: contagens.quantTotal,
    detalhesValor: detalhes,
  };
}

module.exports = {
  listAll, getPara, salvar, calcular, defaultRegra, encontrarNomeEspecial,
  DIAS_SEMANA, BASES_VALIDAS, DESTINOS_VALIDOS, MOTIVOS_REMOCAO_CAMPO, MODOS_NOME_ESPECIAL,
};
