// sheetsSync.js
// Sincroniza os fechamentos direto das planilhas do Google Sheets (ARCFOOD e
// Grupo Bravo, aba "BD") pro dashboard, substituindo o export manual pra
// fechamentos-snapshot.json. Autentica como a mesma conta de servico usada
// pro Firestore (FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY) - pra funcionar,
// a API do Google Sheets precisa estar habilitada no mesmo projeto GCP, e as
// duas planilhas precisam estar compartilhadas com o email dessa conta de
// servico (como leitor).

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// escopo de leitura E escrita - a escrita e usada pelo caminho inverso
// (enviarFechamentoArcfood), que manda o fechamento lançado ao vivo no app
// de volta pra planilha
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const PLANILHAS = [
  { grupo: 'ARCFOOD', id: process.env.SHEET_ID_ARCFOOD || '1XosBc3cNF9gAha91u_g9WnAOtbeTvxrhfKuupolguUU', aba: process.env.SHEET_ABA_ARCFOOD || 'BD' },
  { grupo: 'BRAVO', id: process.env.SHEET_ID_BRAVO || '1dObCSsx4BYDGSQG81KLIOtFSNNs18mVOD5GfYzRIZcM', aba: process.env.SHEET_ABA_BRAVO || 'BD' },
];

// mesmas unidades usadas no resto do app (fechamentos.html/lancamento.html) -
// a planilha ARCFOOD grava o nome da loja sem acento na coluna "Unidade"
const ARCFOOD_CODIGOS = { '19821': 'São Miguel', '19855': 'Carrão', '19888': 'Mooca', '19889': 'Tatuapé' };
const ARCFOOD_UNIDADES_POR_NOME = { 'sao miguel': '19821', 'carrao': '19855', 'mooca': '19888', 'tatuape': '19889' };
const BRAVO_UNIDADES = new Set([
  "Domino's Carrinho Aeroporto Recife", 'Dominos Bessa', 'Dominos Campina Grande', 'Dominos Caruaru',
  'Dominos Garanhuns', 'Dominos Praça Aeroporto Recife', 'Dominos Tirol', 'Milky Moo Tirol',
  'Spoleto Praça Aeroporto Recife', 'Spoleto Shopping Recife', 'Spoleto Shopping Tacaruna', 'São Braz IL',
]);

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

// "R$ 9.619,89" -> 9619.89 · "R$ (1,91)" -> -1.91 · "R$ -" / "" -> 0
function parseMoneyBR(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;
  const negativo = s.includes('(') && s.includes(')');
  s = s.replace(/[R$\s()]/g, '');
  if (!s || s === '-') return 0;
  s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? (negativo ? -Math.abs(n) : n) : 0;
}

const MESES_PT = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };

// planilha ARCFOOD: coluna "Data" so tem dia/mes ("31/08"), o ano vem da
// coluna "Mes" ("AGO/2026", "MAR./2026" etc)
function parseDataArcfood(dataStr, mesStr) {
  const dia = parseInt(String(dataStr || '').split('/')[0], 10);
  const m = String(mesStr || '').toLowerCase().match(/([a-z]{3})\.?\/(\d{4})/);
  if (!dia || !m || !MESES_PT[m[1]]) return null;
  return `${m[2]}-${String(MESES_PT[m[1]]).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// planilha Grupo Bravo: coluna "Data" ja vem completa ("01/08/26")
function parseDataBravo(dataStr) {
  const partes = String(dataStr || '').split('/');
  if (partes.length !== 3) return null;
  const [dd, mm, yy] = partes;
  if (!dd || !mm || !yy) return null;
  const ano = yy.length === 2 ? '20' + yy : yy;
  return `${ano}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

let cachedToken = null; // { token, expiraEm }
async function getAccessToken() {
  if (cachedToken && cachedToken.expiraEm > Date.now() + 30000) return cachedToken.token;

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new Error('FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY não configurados (mesma conta de serviço do Firestore, precisa ter acesso às planilhas).');
  }

  const agora = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: clientEmail, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat: agora, exp: agora + 3600 },
    privateKey,
    { algorithm: 'RS256' }
  );

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Erro ao autenticar com o Google (confira se a API do Sheets está habilitada no projeto): ${data.error_description || data.error || resp.status}`);
  }

  cachedToken = { token: data.access_token, expiraEm: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function buscarValoresAba(spreadsheetId, aba, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(aba)}?valueRenderOption=FORMATTED_VALUE`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, data };
}

// lista os nomes reais das abas da planilha (metadados, nao os valores) -
// usado quando a busca pelo nome esperado falha, pra tentar achar a aba
// certa mesmo se o nome real tiver maiuscula/espaco/acento diferente, e pra
// dar um erro claro (com os nomes de verdade) se mesmo assim nao achar
async function listarAbas(spreadsheetId, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  if (!resp.ok) return [];
  return (data.sheets || []).map((s) => s.properties.title);
}

function normalizarNomeAba(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

// busca DEFINITIVA por aba: tenta os nomes candidatos (com a tolerancia de
// maiuscula/acento do buscarAba) e, se nenhum existir, varre TODAS as abas
// da planilha e escolhe a que tem as colunas-chave no cabecalho - assim a
// importacao sobrevive a aba renomeada (ex: "Entradas" -> "BDClientes")
async function buscarAbaPorCandidatos(spreadsheetId, candidatos, colunasChave) {
  let ultimoErro = null;
  for (const nome of candidatos) {
    try {
      const valores = await buscarAba(spreadsheetId, nome);
      if (valores.length) return { aba: nome, valores };
    } catch (e) { ultimoErro = e; }
  }
  // nenhum candidato existe: detecta pela ESTRUTURA (colunas do cabecalho)
  const token = await getAccessToken();
  const abas = await listarAbas(spreadsheetId, token);
  for (const titulo of abas) {
    try {
      const { ok, data } = await buscarValoresAba(spreadsheetId, titulo, token);
      if (!ok) continue;
      const header = (data.values || [])[0] || [];
      if (colunasChave.every((c) => header.includes(c))) {
        return { aba: titulo, valores: data.values || [] };
      }
    } catch (e) { /* tenta a proxima aba */ }
  }
  const listaAbas = abas.length ? ` Abas encontradas na planilha: ${abas.join(', ')}.` : '';
  throw new Error(`Nenhuma aba da planilha ${spreadsheetId} tem as colunas esperadas (${colunasChave.join(', ')}) nem os nomes ${candidatos.map((c) => `"${c}"`).join('/')}.${ultimoErro ? ` Último erro: ${ultimoErro.message}` : ''}${listaAbas}`);
}

async function buscarAba(spreadsheetId, aba) {
  const token = await getAccessToken();
  let { ok, data } = await buscarValoresAba(spreadsheetId, aba, token);
  if (!ok) {
    // "Unable to parse range" e o mesmo erro generico que o Sheets devolve
    // tanto pra sintaxe invalida quanto pra aba que nao existe com ESSE nome
    // exato - antes de desistir, procura entre as abas de verdade da
    // planilha uma que bata ignorando maiuscula/espaco/acento (bem comum
    // quando a aba foi renomeada ou copiada com uma diferenca sutil)
    const abas = await listarAbas(spreadsheetId, token);
    const alvo = normalizarNomeAba(aba);
    const encontrada = abas.find((t) => normalizarNomeAba(t) === alvo);
    if (encontrada && encontrada !== aba) {
      ({ ok, data } = await buscarValoresAba(spreadsheetId, encontrada, token));
    }
    if (!ok) {
      const listaAbas = abas.length ? ` Abas encontradas na planilha: ${abas.join(', ')}.` : '';
      throw new Error(`Erro ao ler a aba "${aba}" da planilha ${spreadsheetId} (confira se ela foi compartilhada com ${process.env.FIREBASE_CLIENT_EMAIL}): ${data.error?.message || data.status || 'erro desconhecido'}.${listaAbas}`);
    }
  }
  return data.values || [];
}

function linhaParaFechamento(grupo, header, linha) {
  const get = (nome) => {
    const i = header.indexOf(nome);
    return i >= 0 ? linha[i] : undefined;
  };

  const id = get('ID');
  if (!id) return null; // linha vazia ou de outra secao da planilha

  let data, unidade, unidadeNome;
  if (grupo === 'ARCFOOD') {
    data = parseDataArcfood(get('Data'), get('Mes'));
    const codigo = ARCFOOD_UNIDADES_POR_NOME[normalizarTexto(get('Unidade'))];
    if (!codigo) return null; // nao e uma das 4 lojas (linha de resumo/config)
    unidade = codigo;
    unidadeNome = ARCFOOD_CODIGOS[codigo];
  } else {
    const unidadeRaw = get('Unidade');
    if (!BRAVO_UNIDADES.has(unidadeRaw)) return null;
    data = parseDataBravo(get('Data'));
    unidade = unidadeRaw;
    unidadeNome = unidadeRaw;
  }
  if (!data) return null;

  return {
    id: `${grupo.toLowerCase()}-${id}`,
    gerente: get('Nome') || '',
    unidadeNome,
    unidade,
    grupo,
    data,
    caixaInicial: parseMoneyBR(get('Caixa Inicial')),
    caixaFinal: parseMoneyBR(get('Caixa Final')),
    delivery: parseMoneyBR(get('Delivery')),
    carryout: parseMoneyBR(get('Carryout')),
    pickup: parseMoneyBR(get('Pick-UP')),
    loja: parseMoneyBR(get('Loja')),
    adyen: parseMoneyBR(get('Adyen')),
    ifood: parseMoneyBR(get('Ifood')),
    food99: parseMoneyBR(get('99Food')),
    pix: parseMoneyBR(get('Pix')),
    pixCnpj: parseMoneyBR(get('Pix CNPJ')),
    outros: parseMoneyBR(get('Outros')),
    somaMaq: parseMoneyBR(get('SomaMaq')),
    somaPOS: parseMoneyBR(get('SomaPOS')),
    entradaDinheiro: parseMoneyBR(get('Entrada Dinheiro')),
    deposito: parseMoneyBR(get('Deposito')),
    totalSaida: parseMoneyBR(get('Total Saida')),
    faturamento: parseMoneyBR(get('Faturam.')),
    totalDeclarado: parseMoneyBR(get('Total Decla')),
    diferenca: parseMoneyBR(get('Dif.')),
    obsDif: get('Obs. Dif') || null,
    observacao: get('Observação') || null,
    quebra: parseMoneyBR(get('Quebra')),
    tc: parseMoneyBR(get('TC')),
    cancelados: parseMoneyBR(get('Cancelados')),
  };
}

// campos monetarios/contagem que sao seguros de somar quando ha mais de um
// lancamento pro mesmo dia+loja (ver mesclarLancamentosDoMesmoDia abaixo).
// "Deposito", "Caixa Inicial" e "Caixa Final" ficam de fora de proposito -
// sao saldos/movimentos de caixa cujo significado ao somar duas linhas nao e
// obvio (ex: a linha da sangria registra o Deposito como negativo do valor
// retirado, o que pode nao refletir o saldo real do dia se somado direto);
// esses tres vem sempre da linha "principal" (o fechamento de verdade)
const CAMPOS_SOMA = [
  'delivery', 'carryout', 'pickup', 'loja', 'adyen', 'ifood', 'food99', 'pix', 'pixCnpj', 'outros',
  'somaMaq', 'somaPOS', 'entradaDinheiro', 'totalSaida', 'faturamento', 'totalDeclarado',
  'diferenca', 'quebra', 'tc', 'cancelados',
];

// o AppSheet permite mais de um lancamento no mesmo dia pra mesma loja - o
// caso mais comum e uma sangria/retirada de caixa feita separado do
// fechamento em si (linha com Nome tipo "André SangriaX", faturamento zerado
// e so o valor da saida preenchido). Sem juntar isso, cada dia com sangria
// aparecia como "2 fechamentos" no sistema - dava a impressao de faturamento
// duplicado (mesmo o VALOR do faturamento nao sendo somado em dobro, ja que
// a linha da sangria tem faturamento R$0). Aqui a gente junta tudo do mesmo
// dia numa linha so: soma os campos monetarios (seguro, pois a linha da
// sangria tem os outros campos zerados) e usa como base a linha de maior
// faturamento (o fechamento "de verdade") pro gerente/caixa inicial/final.
// agrupa so por unidade+data (nao por grupo) - os codigos de unidade da
// ARCFOOD e os nomes de loja do Grupo Bravo nunca se repetem entre si, e
// isso deixa a funcao reutilizavel tambem pra mesclar sangrias lancadas
// direto no sistema (server/sangrias.js), cujo campo "grupo" pode nao bater
// 100% com o do fechamento se alguem digitar/computar diferente
function mesclarLancamentosDoMesmoDia(fechamentos) {
  const grupos = new Map();
  fechamentos.forEach((f) => {
    const chave = `${f.unidade}__${f.data}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(f);
  });

  const resultado = [];
  for (const linhas of grupos.values()) {
    if (linhas.length === 1) {
      resultado.push(linhas[0]);
      continue;
    }
    const principal = linhas.reduce((a, b) => (b.faturamento > a.faturamento ? b : a));
    const mesclado = { ...principal };
    CAMPOS_SOMA.forEach((campo) => {
      mesclado[campo] = +linhas.reduce((s, l) => s + (l[campo] || 0), 0).toFixed(2);
    });
    mesclado.observacao = linhas.map((l) => l.observacao).filter(Boolean).join(' · ') || null;
    resultado.push(mesclado);
  }
  return resultado;
}

// le as duas planilhas (aba "BD") e devolve a lista combinada de fechamentos,
// no mesmo formato do fechamentos-snapshot.json - ja com os lancamentos do
// mesmo dia/loja mesclados (ver mesclarLancamentosDoMesmoDia)
async function sincronizar() {
  const resultado = [];
  for (const planilha of PLANILHAS) {
    const valores = await buscarAba(planilha.id, planilha.aba);
    if (!valores.length) continue;
    const header = valores[0];
    for (let i = 1; i < valores.length; i++) {
      const fechamento = linhaParaFechamento(planilha.grupo, header, valores[i]);
      if (fechamento) resultado.push(fechamento);
    }
  }
  return mesclarLancamentosDoMesmoDia(resultado);
}

// ---------- caminho inverso: manda o fechamento lançado ao vivo no app
// (fechamentosLive.js) de volta pra planilha ARCFOOD (aba BD) - pros
// stakeholders que ainda acompanham por ela. So ARCFOOD por enquanto (Grupo
// Bravo nunca teve planilha, nasceu direto no app) ----------

// mesmo nome sem acento gravado na coluna "Unidade" da planilha (ver
// ARCFOOD_UNIDADES_POR_NOME acima, que faz o caminho contrario)
const ARCFOOD_NOME_PLANILHA = { '19821': 'Sao Miguel', '19855': 'Carrao', '19888': 'Mooca', '19889': 'Tatuape' };
const ARCFOOD_EMAIL = {
  '19821': 'saomiguel.arcfood@gmail.com', '19855': 'carrao.arcfood@gmail.com',
  '19888': 'mooca.arcfood@gmail.com', '19889': 'tatuape.arcfood@gmail.com',
};
const MESES_PT_INVERSO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function ddmmDaData(dataISO) {
  const [, mm, dd] = String(dataISO).split('-');
  return `${dd}/${mm}`;
}
function mesDaDataArcfood(dataISO) {
  const [ano, mm] = String(dataISO).split('-');
  return `${MESES_PT_INVERSO[Number(mm) - 1].toUpperCase()}/${ano}`;
}

// manda numero puro (nao string "R$ x,xx") - a coluna ja tem formatacao de
// moeda aplicada na planilha, o Sheets so precisa do valor
function numEnvio(v) {
  return Number(v) || 0;
}

// pares [coluna do valor da maquina, coluna do valor "pos 00hs" dessa mesma
// maquina] - MaqBalcao/PosMaqBalcao e' a 1a maquina, Maquina02.../Pos00hs 02
// em diante as demais (ate 8 no total, mesmo limite da planilha)
const ARCFOOD_MAQ_SLOTS = [
  ['MaqBalcao', 'PosMaqBalcao'], ['Maquina02', 'Pos00hs 02'], ['Maquina03', 'Pos00hs 03'], ['Maquina04', 'Pos00hs 04'],
  ['Maquina05', 'Pos00hs 05'], ['Maquina06', 'Pos00hs 06'], ['Maquina07', 'Pos00hs 07'], ['Maquina08', 'Pos00hs 08'],
];
// pares [coluna do valor da saida, coluna da descricao] - ate 5 saidas
const ARCFOOD_SAIDA_SLOTS = [
  ['Saida Dinheiro', 'Descricao Saida'], ['Saida Dinheiro 02', 'Descricao Saida 02'], ['Saida Dinheiro 03', 'Descricao Saida 03'],
  ['Saida Dinheiro 04', 'Descricao Saida 04'], ['Saida Dinheiro 05', 'Descricao Saida 05'],
];

// campos escalares do fechamento lançado ao vivo -> nome da coluna na
// planilha (caminho inverso de linhaParaFechamento). "adyen"/"adyenPos" no
// registro do app SÃO a soma das maquininhas/maquininhas-POS (ver
// lancamento.html, campos.adyen = soma de MAQUINAS) - por isso tambem
// preenchem Adyen/SomaMaq/SomaPOS
function camposEscalaresArcfood(f) {
  return {
    Nome: f.gerente || '',
    Unidade: ARCFOOD_NOME_PLANILHA[f.unidade] || f.unidadeNome || f.unidade,
    Data: ddmmDaData(f.data),
    Mes: mesDaDataArcfood(f.data),
    'Caixa Inicial': numEnvio(f.caixaInicial),
    'Caixa Final': numEnvio(f.caixaFinal),
    Delivery: numEnvio(f.delivery),
    Carryout: numEnvio(f.carryout),
    'Pick-UP': numEnvio(f.pickup),
    Loja: numEnvio(f.loja),
    Adyen: numEnvio(f.adyen),
    Ifood: numEnvio(f.ifood),
    '99Food': numEnvio(f.food99),
    Pix: numEnvio(f.pix),
    'Pix CNPJ': numEnvio(f.pixCnpj),
    Outros: numEnvio(f.outros),
    SomaMaq: numEnvio(f.adyen),
    SomaPOS: numEnvio(f.adyenPos),
    'Entrada Dinheiro': numEnvio(f.entradaDinheiro),
    Deposito: numEnvio(f.deposito),
    'Total Saida': numEnvio(f.totalSaida),
    'Faturam.': numEnvio(f.faturamento),
    'Total Decla': numEnvio(f.totalDeclarado),
    'Dif.': numEnvio(f.diferenca),
    'Obs. Dif': f.obsDif || '',
    Observação: f.observacao || '',
    Quebra: numEnvio(f.quebra),
    TC: numEnvio(f.tc),
    Cancelados: numEnvio(f.cancelados),
    Email: ARCFOOD_EMAIL[f.unidade] || '',
  };
}

// linha completa (array na ordem do cabecalho real da planilha) pra uma
// linha NOVA - colunas que a gente nao conhece (Pedido Anulado, Venda,
// AnaliseEspecialista etc) ficam em branco, sem problema numa linha nova
function novaLinhaArcfood(header, f) {
  const linha = header.map(() => '');
  const setCol = (nome, valor) => {
    const i = header.indexOf(nome);
    if (i >= 0) linha[i] = valor;
  };
  setCol('ID', crypto.randomBytes(4).toString('hex'));
  Object.entries(camposEscalaresArcfood(f)).forEach(([nome, valor]) => setCol(nome, valor));
  (f.detalhesMaquinas || []).slice(0, ARCFOOD_MAQ_SLOTS.length).forEach((m, i) => setCol(ARCFOOD_MAQ_SLOTS[i][0], numEnvio(m.valor)));
  (f.detalhesMaquinasPos || []).slice(0, ARCFOOD_MAQ_SLOTS.length).forEach((m, i) => setCol(ARCFOOD_MAQ_SLOTS[i][1], numEnvio(m.valor)));
  (f.detalhesSaidas || []).slice(0, ARCFOOD_SAIDA_SLOTS.length).forEach((s, i) => {
    setCol(ARCFOOD_SAIDA_SLOTS[i][0], numEnvio(s.valor));
    setCol(ARCFOOD_SAIDA_SLOTS[i][1], s.descricao || '');
  });
  return linha;
}

// mapa {nome da coluna: valor} pra ATUALIZAR uma linha existente - deliberadamente
// so as colunas que a gente conhece (nunca mexe no ID nem nas colunas que
// esse sistema nao usa, tipo Pedido Anulado/Venda/AnaliseEspecialista, pra
// nao apagar algo preenchido manualmente ali)
function mudancasArcfood(f) {
  const mudancas = { ...camposEscalaresArcfood(f) };
  (f.detalhesMaquinas || []).slice(0, ARCFOOD_MAQ_SLOTS.length).forEach((m, i) => { mudancas[ARCFOOD_MAQ_SLOTS[i][0]] = numEnvio(m.valor); });
  (f.detalhesMaquinasPos || []).slice(0, ARCFOOD_MAQ_SLOTS.length).forEach((m, i) => { mudancas[ARCFOOD_MAQ_SLOTS[i][1]] = numEnvio(m.valor); });
  (f.detalhesSaidas || []).slice(0, ARCFOOD_SAIDA_SLOTS.length).forEach((s, i) => {
    mudancas[ARCFOOD_SAIDA_SLOTS[i][0]] = numEnvio(s.valor);
    mudancas[ARCFOOD_SAIDA_SLOTS[i][1]] = s.descricao || '';
  });
  return mudancas;
}

// indice zero -> letra de coluna do Sheets (0->A, 25->Z, 26->AA...)
function colunaLetra(indiceZero) {
  let n = indiceZero + 1;
  let s = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    s = String.fromCharCode(65 + resto) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function valuesAppend(spreadsheetId, aba, row, token) {
  const range = encodeURIComponent(`${aba}!A1`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Erro ao adicionar linha na planilha: ${data.error?.message || resp.status}`);
  return data;
}

// atualiza so as celulas passadas em "mudancas" (uma por range), nao a
// linha inteira - assim colunas que a gente nao conhece ficam intocadas
async function valuesBatchUpdate(spreadsheetId, aba, linhaNumero, header, mudancas, token) {
  const data = Object.entries(mudancas)
    .map(([nome, valor]) => {
      const i = header.indexOf(nome);
      if (i < 0) return null;
      return { range: `${aba}!${colunaLetra(i)}${linhaNumero}`, values: [[valor]] };
    })
    .filter(Boolean);
  if (!data.length) return null;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(`Erro ao atualizar linha na planilha: ${body.error?.message || resp.status}`);
  return body;
}

// manda o fechamento (lançado ao vivo, ja no formato de server/fechamentosLive.js)
// de UMA loja ARCFOOD pra planilha, aba BD. Se ja existir uma linha da
// mesma loja+data+mes (por exemplo alguem tambem lançou direto na
// planilha), atualiza so as colunas conhecidas em vez de acrescentar linha
// duplicada; senao, adiciona uma linha nova no final
async function enviarFechamentoArcfood(f) {
  const planilha = PLANILHAS.find((p) => p.grupo === 'ARCFOOD');
  if (!planilha) throw new Error('Planilha ARCFOOD não configurada.');
  const token = await getAccessToken();
  const valores = await buscarAba(planilha.id, planilha.aba);
  const header = valores[0] || [];
  if (!header.length) throw new Error('Planilha ARCFOOD sem cabeçalho na aba BD.');

  const iUnidade = header.indexOf('Unidade');
  const iData = header.indexOf('Data');
  const iMes = header.indexOf('Mes');
  const unidadeAlvo = normalizarTexto(ARCFOOD_NOME_PLANILHA[f.unidade] || '');
  const dataAlvo = ddmmDaData(f.data);
  const mesAlvo = mesDaDataArcfood(f.data);

  let linhaExistente = -1;
  for (let i = 1; i < valores.length; i++) {
    const linha = valores[i];
    if (normalizarTexto(linha[iUnidade]) === unidadeAlvo && String(linha[iData] || '').trim() === dataAlvo && String(linha[iMes] || '').trim() === mesAlvo) {
      linhaExistente = i + 1; // 1-indexado + linha de cabecalho
      break;
    }
  }

  if (linhaExistente > 0) {
    await valuesBatchUpdate(planilha.id, planilha.aba, linhaExistente, header, mudancasArcfood(f), token);
    return { acao: 'atualizado', linha: linhaExistente };
  }
  await valuesAppend(planilha.id, planilha.aba, novaLinhaArcfood(header, f), token);
  return { acao: 'adicionado' };
}

module.exports = {
  sincronizar, parseMoneyBR, parseDataArcfood, parseDataBravo, getAccessToken, buscarAba, buscarAbaPorCandidatos, mesclarLancamentosDoMesmoDia,
  enviarFechamentoArcfood,
};
