// sheetsSync.js
// Sincroniza os fechamentos direto das planilhas do Google Sheets (ARCFOOD e
// Grupo Bravo, aba "BD") pro dashboard, substituindo o export manual pra
// fechamentos-snapshot.json. Autentica como a mesma conta de servico usada
// pro Firestore (FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY) - pra funcionar,
// a API do Google Sheets precisa estar habilitada no mesmo projeto GCP, e as
// duas planilhas precisam estar compartilhadas com o email dessa conta de
// servico (como leitor).

const jwt = require('jsonwebtoken');

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
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

async function buscarAba(spreadsheetId, aba) {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(aba)}?valueRenderOption=FORMATTED_VALUE`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Erro ao ler a planilha ${spreadsheetId} (confira se ela foi compartilhada com ${process.env.FIREBASE_CLIENT_EMAIL}): ${data.error?.message || resp.status}`);
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
function mesclarLancamentosDoMesmoDia(fechamentos) {
  const grupos = new Map();
  fechamentos.forEach((f) => {
    const chave = `${f.grupo}__${f.unidade}__${f.data}`;
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

module.exports = { sincronizar, parseMoneyBR, parseDataArcfood, parseDataBravo, getAccessToken, buscarAba, mesclarLancamentosDoMesmoDia };
