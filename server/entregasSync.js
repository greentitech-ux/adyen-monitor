// entregasSync.js
// Sincroniza o histórico de entregas (motoboys) direto da planilha "MOTOS
// BRAVO" do Google Sheets - a mesma que hoje alimenta o app de entregas no
// AppSheet. Reaproveita a mesma autenticação de conta de serviço do
// sheetsSync.js (fechamentos): a planilha precisa estar compartilhada com
// esse mesmo email (FIREBASE_CLIENT_EMAIL) como leitora.
//
// A aba "BDMotos" fica de fora de propósito: ela não tem a coluna "Data"
// preenchida (só "Dia", o dia da semana) - decisão combinada com o cliente
// em 2026-08-02: essa aba entra depois, quando a data de cada linha puder
// ser resgatada (histórico de versões da planilha ou export do próprio
// AppSheet). As outras 5 abas de entrega têm Data+Mês preenchidos e já
// entram nessa sincronização.
const { buscarAba, parseMoneyBR } = require('./sheetsSync');

const SPREADSHEET_ID = process.env.SHEET_ID_ENTREGAS || '14qb8V0fCqgGFmHDISm4HIArAmDZ0QJN8uD7B6zRIYTk';
const ABAS = (process.env.SHEET_ABAS_ENTREGAS || 'Garanhuns,Bessa,Caruaru,Tirol,MMTirol')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MESES_PT = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };

// "24/12" (Data) + "dez./25" ou "DEZ./2025" (Mes, ano com 2 ou 4 dígitos) -> "2025-12-24"
function parseData(dataStr, mesStr) {
  const dia = parseInt(String(dataStr || '').split('/')[0], 10);
  const m = String(mesStr || '').toLowerCase().match(/([a-z]{3})\.?\/(\d{2,4})/);
  if (!dia || !m || !MESES_PT[m[1]]) return null;
  const ano = m[2].length === 2 ? `20${m[2]}` : m[2];
  return `${ano}-${String(MESES_PT[m[1]]).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// algumas colunas mudam de nome de aba pra aba (mesmo dado, rótulo
// diferente) - pega o primeiro nome que existir e tiver valor na linha
function getPrimeiro(header, linha, nomes) {
  for (const nome of nomes) {
    const i = header.indexOf(nome);
    if (i >= 0 && linha[i] !== undefined && linha[i] !== '') return linha[i];
  }
  return undefined;
}

function linhaParaEntrega(aba, header, linha) {
  const get = (nome) => {
    const i = header.indexOf(nome);
    return i >= 0 ? linha[i] : undefined;
  };

  const id = get('ID');
  if (!id) return null; // linha vazia/separadora

  const data = parseData(get('Data'), get('Mes'));
  if (!data) return null; // sem data nao da pra mostrar no dashboard por periodo

  const unidade = get('Unidade');
  if (!unidade) return null;

  return {
    id: `${aba.toLowerCase()}-${id}`,
    unidade,
    unidadeNome: unidade,
    data,
    entregador: get('Nome') || '',
    entrega: num(get('Entrega')),
    retorno: num(get('Retorno')),
    obsRetorno: get('Obs. Retorno') || null,
    extra: num(get('Extra')),
    obsExtra: get('Obs. Extra') || null,
    bonus: parseMoneyBR(getPrimeiro(header, linha, ['Valor Gami', 'Valor NEXT'])),
    pos00hs: num(get('Pos 00hs')),
    foraDeArea: num(get('Fora de Area')),
    ajudaCusto: parseMoneyBR(getPrimeiro(header, linha, ['Ajuda de Custo', 'Encosta', 'ac'])),
    valor: parseMoneyBR(get('Valor')),
    coopRecebe: parseMoneyBR(get('COOP Recebe')),
    quantTotal: num(get('Quant.')),
    observacao: getPrimeiro(header, linha, ['Obs.', 'Obs']) || null,
    // referência ao arquivo original no Drive do AppSheet - ainda não
    // migrado pro nosso Storage (fica só como referência de texto por ora)
    etiquetaOrigem: get('Etiquetas') || null,
    historico: true, // vem direto da planilha - somente leitura, não passa por solicitação de edição
  };
}

// lê as abas configuradas e devolve a lista combinada de entregas históricas,
// no mesmo formato usado pelos lançamentos ao vivo (entregasLive)
async function sincronizar() {
  const resultado = [];
  for (const aba of ABAS) {
    const valores = await buscarAba(SPREADSHEET_ID, aba);
    if (!valores.length) continue;
    const header = valores[0];
    for (let i = 1; i < valores.length; i++) {
      const entrega = linhaParaEntrega(aba, header, valores[i]);
      if (entrega) resultado.push(entrega);
    }
  }
  return resultado;
}

module.exports = { sincronizar, parseData };
