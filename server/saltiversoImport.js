// saltiversoImport.js
// Importa os dados historicos da planilha Google Sheets que a Saltiverso
// Patteo usava antes do Zenith Ops (abas "Entradas" e "Vendas de Festa") pro
// Firestore (colecoes parqueCheckins/festas). Reaproveita a autenticacao ja
// configurada em sheetsSync.js (mesma service account do Firestore - a
// planilha precisa estar compartilhada com esse email como leitor).
//
// Idempotente: cada documento importado usa um ID deterministico derivado
// do "Id"/"Codigo" da propria planilha (ver ID_ENTRADA/ID_FESTA abaixo), e
// grava com .set() (nao .add()) - rodar a importacao de novo so atualiza os
// mesmos documentos, nunca duplica.
const db = require('./firestore');
const { buscarAbaPorCandidatos, parseMoneyBR } = require('./sheetsSync');
const parque = require('./parque');
const festas = require('./festas');

const SHEET_ID_SALTIVERSO = process.env.SHEET_ID_SALTIVERSO || '11TcOlMUBZ_bqL6FyFZFjgo-GRD78h0y3DqsaOzKVBpI';
// a planilha real usa "BDClientes"/"BDFestas" (o app antigo chamava de
// "Entradas"/"Vendas de Festa") - tenta os nomes conhecidos e, se renomearem
// de novo, o buscarAbaPorCandidatos encontra a aba certa PELAS COLUNAS
const ABAS_ENTRADAS = ['BDClientes', 'Entradas'];
const COLUNAS_ENTRADAS = ['NomeCliente', 'DataUtilizacao', 'TimeInicial', 'NomeUtilizador01'];
const ABAS_FESTAS = ['BDFestas', 'Vendas de Festa'];
const COLUNAS_FESTAS = ['Codigo', 'DataDeUso', 'ValorTotal'];
const UNIDADE_PADRAO = 'Saltiverso Patteo';

function get(header, linha, nome) {
  const i = header.indexOf(nome);
  return i >= 0 ? (linha[i] ?? '') : '';
}

// "10/06/2026" -> "2026-06-10". Aceita ano com 2 ou 4 digitos.
function parseDataBR(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const [, dd, mm, yy] = m;
  const ano = yy.length === 2 ? `20${yy}` : yy;
  return `${ano}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

// "16:01:23" ou "10/06/2026 15:25:36" -> ISO 8601. Quando so tem hora, usa a
// data de utilizacao como base (mesmo dia do check-in, aproximacao razoavel
// pra um campo que so serve de ordenacao/registro).
function parseCriadoEm(dataTimeRaw, dataUtilizacaoIso) {
  const s = String(dataTimeRaw || '').trim();
  const comData = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (comData) {
    const [, dd, mm, yy, hh, mi, ss] = comData;
    const ano = yy.length === 2 ? `20${yy}` : yy;
    return `${ano}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh}:${mi}:${ss}`;
  }
  const soHora = s.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (soHora && dataUtilizacaoIso) return `${dataUtilizacaoIso}T${s}`;
  return new Date().toISOString();
}

function normalizarUnidade(raw) {
  const s = String(raw || '').trim();
  return s ? UNIDADE_PADRAO : UNIDADE_PADRAO; // so existe uma unidade Saltiverso hoje
}

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

function linhaParaCheckin(header, linha) {
  const id = get(header, linha, 'Id');
  if (!id) return null;
  const nomeCliente = String(get(header, linha, 'NomeCliente') || '').trim();
  const dataUtilizacao = parseDataBR(get(header, linha, 'DataUtilizacao'));
  const timeInicial = String(get(header, linha, 'TimeInicial') || '').trim();
  if (!nomeCliente || !dataUtilizacao || !timeInicial) return null; // sem o minimo pra um check-in valido

  const criancas = [];
  for (let n = 1; n <= 20; n++) {
    const suf = String(n).padStart(2, '0');
    const nome = String(get(header, linha, `NomeUtilizador${suf}`) || '').trim();
    if (!nome) continue;
    const nascRaw = get(header, linha, `DataNascUtilizador${suf}`);
    criancas.push({ nome: nome.slice(0, 120), dataNascimento: parseDataBR(nascRaw) });
  }
  if (!criancas.length) return null;

  const tempoRaw = Number(get(header, linha, 'CompraTempo'));
  const tempoMinutos = parque.TEMPOS_VALIDOS.includes(tempoRaw) ? tempoRaw : 60;
  let timeFinal = String(get(header, linha, 'TimeFInal') || '').trim();
  if (!timeFinal) {
    const [h, m] = timeInicial.split(':').map(Number);
    const total = h * 60 + (m || 0) + tempoMinutos;
    timeFinal = `${String(Math.floor((total % 1440) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
  }

  const adultoCortesia = String(get(header, linha, 'AdultoCortesia')).toUpperCase() === 'TRUE';
  const quantAcRaw = Number(get(header, linha, 'PulA.C.')) || Number(get(header, linha, 'QuantPCD')) || 0;

  return {
    id: `sheet-entrada-${id}`,
    unidade: normalizarUnidade(get(header, linha, 'Unidade')),
    unidadeNome: UNIDADE_PADRAO,
    colaboradorId: null,
    colaboradorNome: get(header, linha, 'Colaborador') || null,
    responsavel: {
      nome: nomeCliente.slice(0, 150),
      cpf: String(get(header, linha, 'CPF') || '').trim().slice(0, 20),
      contato: String(get(header, linha, 'Contato') || '').trim().slice(0, 30),
      email: String(get(header, linha, 'EmailCliente') || '').trim().slice(0, 150),
      cep: String(get(header, linha, 'CEP') || '').trim().slice(0, 300),
      numero: String(get(header, linha, 'Numero') || '').trim().slice(0, 20),
      complemento: String(get(header, linha, 'Complemento') || '').trim().slice(0, 100),
    },
    dataUtilizacao,
    tempoMinutos,
    timeInicial: timeInicial.length === 5 ? `${timeInicial}:00` : timeInicial,
    timeFinal,
    observacao: String(get(header, linha, 'Observacao') || '').slice(0, 300),
    adultoCortesia,
    quantAC: adultoCortesia ? Math.max(0, Math.min(10, quantAcRaw || 1)) : 0,
    criancas,
    pulseiras: criancas.length,
    usou: String(get(header, linha, 'Utilizado?')).toUpperCase() !== 'NAO' && String(get(header, linha, 'Utilizado?')).toUpperCase() !== 'NÃO',
    // dado historico - o parque ja foi utilizado, entao o termo fisico ja
    // foi assinado no balcao na epoca (nao ha como confirmar retroativo,
    // mas marcar como "aguardando" pra visita que ja aconteceu so
    // atrapalharia a operacao com pendencias falsas)
    termoAssinado: true,
    iniciado: true, // dado historico ja aconteceu - timeInicial/timeFinal ja vem preenchidos da planilha
    criadoPorId: null,
    criadoPorEmail: 'importado-planilha',
    criadoEm: parseCriadoEm(get(header, linha, 'DataTime'), dataUtilizacao),
    origemPlanilhaId: id,
  };
}

function extrairReferenciaUpsell(observacao) {
  const m = String(observacao || '').match(/C[ÓO]D[.:;]?\s*([A-Z0-9]{4,10})/i);
  return m ? m[1].toUpperCase() : null;
}

function statusFesta(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (s === 'PAGO') return 'pago';
  if (s === 'CANCELADO') return 'cancelado';
  return 'pendente';
}

function linhaParaFesta(header, linha) {
  const id = get(header, linha, 'Id');
  const codigo = String(get(header, linha, 'Codigo') || '').trim();
  if (!id || !codigo) return null;
  const nomeCliente = String(get(header, linha, 'NomeCliente') || '').trim();
  const dataDeUso = parseDataBR(get(header, linha, 'DataDeUso'));
  if (!nomeCliente || !dataDeUso) return null;

  const valorTotal = parseMoneyBR(get(header, linha, 'ValorTotal'));
  const valorSinal = parseMoneyBR(get(header, linha, 'ValorSinal'));
  const valorRestante = parseMoneyBR(get(header, linha, 'ValorRestante'));
  const observacao = String(get(header, linha, 'Observacao') || '').slice(0, 500);
  const dataVenda = parseDataBR(get(header, linha, 'DataVenda')) || dataDeUso;
  const utilizado = String(get(header, linha, 'Utilizado')).trim().toUpperCase() === 'SIM';

  return {
    id: `sheet-festa-${id}`,
    codigo,
    unidade: normalizarUnidade(get(header, linha, 'Unidade')),
    cliente: {
      nome: nomeCliente.slice(0, 150),
      contato: String(get(header, linha, 'Contato') || '').trim().slice(0, 30),
      email: String(get(header, linha, 'EmailCliente') || '').trim().slice(0, 150),
    },
    dataVenda,
    dataDeUso,
    horaInicio: null,
    horaFim: null,
    valorTotal,
    sinal: valorSinal ? { valor: valorSinal, forma: get(header, linha, 'FormaPagSinal') || '', data: parseDataBR(get(header, linha, 'DataSinal')) } : null,
    restante: valorRestante ? { valor: valorRestante, forma: get(header, linha, 'FormaPagResta') || '', data: parseDataBR(get(header, linha, 'DataPagamentoFinal')) || parseDataBR(get(header, linha, 'DataVencimento')) } : null,
    status: statusFesta(get(header, linha, 'Status')),
    utilizado,
    dataUtilizacao: parseDataBR(get(header, linha, 'DataUtilizacao')),
    observacao,
    referenciaVendaOriginal: extrairReferenciaUpsell(observacao),
    termoAssinado: utilizado,
    criadoPorId: null,
    criadoPorEmail: 'importado-planilha',
    criadoEm: `${dataVenda}T00:00:00.000Z`,
    origemPlanilhaId: id,
  };
}

async function importar() {
  const resultado = { checkins: { lidos: 0, importados: 0 }, festas: { lidos: 0, importados: 0 } };

  const { valores: valoresEntradas } = await buscarAbaPorCandidatos(SHEET_ID_SALTIVERSO, ABAS_ENTRADAS, COLUNAS_ENTRADAS);
  if (valoresEntradas.length) {
    const header = valoresEntradas[0];
    const batchCheckins = db.batch();
    const colecaoCheckins = db.collection('parqueCheckins');
    for (let i = 1; i < valoresEntradas.length; i++) {
      resultado.checkins.lidos++;
      const doc = linhaParaCheckin(header, valoresEntradas[i]);
      if (!doc) continue;
      batchCheckins.set(colecaoCheckins.doc(doc.id), doc);
      resultado.checkins.importados++;
    }
    if (resultado.checkins.importados) await batchCheckins.commit();
  }

  const { valores: valoresFestas } = await buscarAbaPorCandidatos(SHEET_ID_SALTIVERSO, ABAS_FESTAS, COLUNAS_FESTAS);
  if (valoresFestas.length) {
    const header = valoresFestas[0];
    const colecaoFestas = db.collection('festas');
    // uma unica planilha pode ter mais linhas que o limite de 500
    // operacoes por batch do Firestore - quebra em lotes de 400 pra sobrar
    // margem de seguranca
    let batch = db.batch();
    let contadorLote = 0;
    for (let i = 1; i < valoresFestas.length; i++) {
      resultado.festas.lidos++;
      const doc = linhaParaFesta(header, valoresFestas[i]);
      if (!doc) continue;
      batch.set(colecaoFestas.doc(doc.id), doc);
      resultado.festas.importados++;
      contadorLote++;
      if (contadorLote >= 400) {
        await batch.commit();
        batch = db.batch();
        contadorLote = 0;
      }
    }
    if (contadorLote > 0) await batch.commit();
  }

  parque.invalidar();
  festas.invalidar();
  return resultado;
}

module.exports = { importar, soDigitos };
