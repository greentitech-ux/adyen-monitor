// ifoodClient.js
// Unico arquivo que fala com a API do iFood. Isola toda a incerteza sobre o
// formato exato da Sales API (confirmado publicamente: modulo "Financial",
// endpoint GET /{merchantId}/sales - mas o shape completo da resposta so da
// pra confirmar com credenciais reais no Developer Portal) - o resto do
// sistema (ifoodSync.js, ifoodStore.js, rotas) nunca depende do formato bruto.
//
// ATENCAO - NUNCA trocar isso pela Order/Events API (GET /events:polling +
// POST /acknowledgment). A Order/Events API e operacional: parar de fazer
// polling nela pode tirar a loja do "online" no iFood e ela para de receber
// pedidos de verdade. Ja existe um sistema (tablet/POS) fazendo esse papel
// nas lojas - este arquivo so LE dados financeiros (Sales API), nunca aceita
// nem confirma pedido nenhum.

const AUTH_URL = 'https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token';
const API_BASE = 'https://merchant-api.ifood.com.br/financial/v3.0';

// merchantId do iFood -> nome da loja (mesmo padrao de
// FECHAMENTO_UNIDADES_NOMES/ENTREGAS_UNIDADES_NOMES em index.js: o codigo do
// iFood vira o "unidade" usado no resto do app pra filtrar por permissao).
// PREENCHER com a lista real antes de usar em producao - sem isso o sync nao
// tem o que sincronizar (roda e nao encontra nenhuma loja).
const IFOOD_UNIDADES_NOMES = {
  // 'merchantId-real-aqui': 'Nome da loja (iFood)',
};

let cachedToken = null; // { token, expiraEm }
async function getAccessToken() {
  if (cachedToken && cachedToken.expiraEm > Date.now() + 30000) return cachedToken.token;

  const clientId = process.env.IFOOD_CLIENT_ID;
  const clientSecret = process.env.IFOOD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET não configurados (Portal do Desenvolvedor iFood).');
  }

  const resp = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grantType: 'client_credentials', clientId, clientSecret }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Erro ao autenticar com o iFood: ${data.error?.message || data.error_description || resp.status}`);
  }

  const token = data.accessToken || data.access_token;
  const expiresInSeg = data.expiresIn || data.expires_in || 21600; // padrao iFood: 6h
  cachedToken = { token, expiraEm: Date.now() + expiresInSeg * 1000 };
  return cachedToken.token;
}

// normaliza um item bruto da Sales API pro formato usado no resto do
// sistema - unico ponto que precisa mudar se o shape real vier diferente
// do que documentacao publica sugere
function normalizarVenda(unidade, unidadeNome, bruto) {
  return {
    id: String(bruto.id || bruto.orderId || bruto.saleId),
    unidade,
    unidadeNome,
    numeroPedido: bruto.orderShortReference || bruto.shortId || bruto.orderId || null,
    dataHora: bruto.orderDate || bruto.createdAt || bruto.date || null,
    valorBruto: Number(bruto.grossValue ?? bruto.orderAmount ?? bruto.amount ?? 0),
    valorLiquido: Number(bruto.netValue ?? bruto.receivableAmount ?? bruto.amount ?? 0),
    taxaComissao: Number(bruto.commissionValue ?? bruto.ifoodCommission ?? 0),
    formaPagamento: bruto.paymentMethod || bruto.payment?.method || null,
    status: bruto.status || null,
    raw: bruto,
  };
}

// busca as vendas de UMA loja num periodo (inicioISO/fimISO, formato
// YYYY-MM-DD) - devolve sempre um array ja normalizado, nunca o payload bruto
async function buscarVendas(merchantId, { inicio, fim }) {
  const unidadeNome = IFOOD_UNIDADES_NOMES[merchantId] || merchantId;

  const token = await getAccessToken();
  const url = `${API_BASE}/merchants/${encodeURIComponent(merchantId)}/sales?beginSalesDate=${inicio}&endSalesDate=${fim}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Erro ao buscar vendas do iFood (loja ${merchantId}): ${data.error?.message || resp.status}`);
  }

  const itens = Array.isArray(data) ? data : (data.sales || data.items || data.content || []);
  return itens.map((bruto) => normalizarVenda(merchantId, unidadeNome, bruto));
}

module.exports = { IFOOD_UNIDADES_NOMES, getAccessToken, buscarVendas };
