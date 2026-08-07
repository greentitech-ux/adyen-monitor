// relatorioMV.js
// Relatorio diario por e-mail das solicitacoes direcionadas ao MV (Grupo
// Bravo) + aprovar/recusar direto no e-mail, sem precisar logar no Zenith.
//
// PARTE A (relatorio): reaproveita centralCards.listarTodos() - a mesma
// fonte de dados do GET /api/central - filtrando por
// direcionadoParaEmail===MV_EMAIL, agrupado por status.
//
// PARTE B (decidir por e-mail): so pros tickets que nascem em solicitacoes.js
// (compra/manutencao/suporte-ti/pagamento/nota) - Estorno e Ajuste de
// Fechamento aparecem no relatorio mas SEM botao de acao, porque decidir
// esses dois de verdade depende de mais coisa que um simples aprovar/
// recusar (estorno pode chamar a API da Adyen; ajuste de fechamento reaplica
// diffs no lancamento) e nao valeria o risco de fazer isso numa rota publica
// sem login. Cada ticket PENDENTE ganha um token de uso unico (ver
// solicitacoes.gerarTokenAcao) que e RENOVADO a cada envio do relatorio -
// isso invalida sozinho o link de um e-mail de dias atras, sem precisar de
// nenhuma limpeza a parte.
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const cron = require('node-cron');
const centralCards = require('./centralCards');
const solicitacoes = require('./solicitacoes');

const FUSO_BR = 'America/Sao_Paulo';
const MV_EMAIL = process.env.RELATORIO_DIRECIONADO_EMAIL || 'mv@grupobravoempresarial.com';
// sem barra no final, pra concatenar direto nos links (/decidir...)
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://adyen-monitor.onrender.com').replace(/\/+$/, '');
// unicos tipos com fluxo de decisao por e-mail (ver aviso de escopo acima)
const TIPOS_COM_ACAO_POR_EMAIL = new Set(solicitacoes.TIPOS);
const TIPOS_LABEL = {
  estorno: 'Estorno', 'ajuste-fechamento': 'Ajuste de fechamento',
  compra: 'Compra', manutencao: 'Manutenção', 'suporte-ti': 'Suporte de TI', pagamento: 'Pagamento', nota: 'Nota fiscal',
  'quebra-caixa': 'Quebra de caixa',
};
const STATUS_LABEL = { PENDENTE: 'Pendentes', APROVADO: 'Aprovadas', REJEITADO: 'Recusadas' };
const STATUS_COR = { PENDENTE: '#b8860b', APROVADO: '#1a7f37', REJEITADO: '#c62828' };

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(v) { return centralCards.fmtMoneyServer(v); }

function dataHojeBR() {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO_BR, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
}
function fmtDataHora(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_BR, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

// junta os cards das 3 filas direcionados ao MV, agrupados por status - e
// gera (renovando) o token de acao dos que ainda estao PENDENTE e tem tipo
// com fluxo de decisao por e-mail (ver TIPOS_COM_ACAO_POR_EMAIL acima)
async function montarDados() {
  const todos = await centralCards.listarTodos();
  // CONVERTIDO = o ticket virou outro tipo/colecao (ver solicitacoes.js) -
  // quem continua a historia e o registro novo, esse aqui fica de fora
  const doMV = todos.filter((c) => c.direcionadoParaEmail === MV_EMAIL && c.status !== 'CONVERTIDO');

  for (const c of doMV) {
    if (c.status === 'PENDENTE' && TIPOS_COM_ACAO_POR_EMAIL.has(c.tipo)) {
      const { tokenAcao } = await solicitacoes.gerarTokenAcao(c.id);
      c.tokenAcao = tokenAcao;
    }
  }

  const grupos = { PENDENTE: [], APROVADO: [], REJEITADO: [] };
  doMV.forEach((c) => { (grupos[c.status] || (grupos[c.status] = [])).push(c); });
  Object.values(grupos).forEach((lista) => lista.sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || '')));
  return { grupos, total: doMV.length };
}

function linkDecisao(card, acao) {
  const params = new URLSearchParams({ ticket: card.id, tipo: card.tipo, acao, token: card.tokenAcao || '' });
  return `${APP_BASE_URL}/decidir.html?${params.toString()}`;
}

function htmlBotoesAcao(card) {
  if (card.status !== 'PENDENTE' || !card.tokenAcao) return '';
  const btn = (texto, cor, acao) =>
    `<a href="${linkDecisao(card, acao)}" style="display:inline-block;padding:8px 18px;margin:8px 8px 0 0;border-radius:6px;background:${cor};color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;">${texto}</a>`;
  return `<div>${btn('✓ Aprovar', '#1a7f37', 'aprovar')}${btn('✗ Recusar', '#c62828', 'recusar')}</div>`;
}

function htmlCard(card) {
  const linhas = [
    `<b>#${card.numeroTicket ?? '—'} - ${escapeHtml(card.titulo || '')}</b>`,
    `<div style="color:#555;font-size:12.5px;margin-top:2px;">${escapeHtml(TIPOS_LABEL[card.tipo] || card.tipo)} · ${escapeHtml(card.unidadeNome || card.unidade || '—')} · ${fmtDataHora(card.criadoEm)}</div>`,
  ];
  if (card.valorEstimado != null) linhas.push(`<div style="font-size:12.5px;margin-top:2px;">Valor estimado: ${fmtMoney(card.valorEstimado)}</div>`);
  if (card.observacao) linhas.push(`<div style="font-size:12.5px;color:#333;margin-top:4px;white-space:pre-wrap;">${escapeHtml(card.observacao)}</div>`);
  if (card.motivoDecisao) linhas.push(`<div style="font-size:12px;color:#777;margin-top:4px;">Motivo: ${escapeHtml(card.motivoDecisao)}</div>`);
  return `<div style="padding:12px 0;border-bottom:1px solid #eee;">${linhas.join('')}${htmlBotoesAcao(card)}</div>`;
}

function htmlSecao(status, lista) {
  if (!lista.length) return '';
  return `
    <div style="margin-top:22px;">
      <div style="font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:${STATUS_COR[status]};border-bottom:2px solid ${STATUS_COR[status]};padding-bottom:6px;">
        ${STATUS_LABEL[status]} (${lista.length})
      </div>
      <div style="font-family:Arial,sans-serif;">${lista.map(htmlCard).join('')}</div>
    </div>`;
}

function montarHtml({ grupos, total }) {
  const resumo = Object.entries(STATUS_LABEL)
    .map(([status, label]) => `<div style="display:inline-block;margin-right:22px;"><div style="font-size:11px;color:#888;text-transform:uppercase;">${label}</div><div style="font-size:20px;font-weight:bold;color:${STATUS_COR[status]};">${grupos[status].length}</div></div>`)
    .join('');
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:#1a56db;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0;">
      <div style="font-size:17px;font-weight:bold;">Relatório de Solicitações · MV</div>
      <div style="font-size:12.5px;opacity:.85;margin-top:2px;">${dataHojeBR()} · ${total} solicitaç${total === 1 ? 'ão' : 'ões'} no total</div>
    </div>
    <div style="border:1px solid #e5e5e5;border-top:none;padding:18px 22px;border-radius:0 0 8px 8px;">
      <div>${resumo}</div>
      ${!total ? '<div style="color:#888;margin-top:18px;">Nenhuma solicitação direcionada ao MV no momento.</div>' : ''}
      ${htmlSecao('PENDENTE', grupos.PENDENTE)}
      ${htmlSecao('APROVADO', grupos.APROVADO)}
      ${htmlSecao('REJEITADO', grupos.REJEITADO)}
    </div>
    <div style="font-family:Arial,sans-serif;font-size:11px;color:#999;text-align:center;margin-top:14px;">
      Zenith Ops · gerado automaticamente
    </div>
  </div>`;
}

function montarHtmlCardUnico(card, titulo) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:#1a56db;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0;">
      <div style="font-size:17px;font-weight:bold;">${escapeHtml(titulo)}</div>
      <div style="font-size:12.5px;opacity:.85;margin-top:2px;">${fmtDataHora(card.criadoEm)}</div>
    </div>
    <div style="border:1px solid #e5e5e5;border-top:none;padding:18px 22px;border-radius:0 0 8px 8px;">
      ${htmlCard(card)}
    </div>
    <div style="font-family:Arial,sans-serif;font-size:11px;color:#999;text-align:center;margin-top:14px;">
      Zenith Ops · gerado automaticamente
    </div>
  </div>`;
}

// html de N cards (1 ou varios) - usado no envio manual sob demanda (botao
// "enviar por e-mail" no detalhe de um card, ou selecionar varios na lista),
// diferente de notificarCardMV/enviarRelatorio que sao fluxos automaticos
// pro MV. Aqui NUNCA gera token de decisao nem botoes Aprovar/Recusar - o
// destinatario pode ser qualquer e-mail digitado na hora (fornecedor,
// gerente etc.), entao dar poder de decisao por link seria arriscado demais
// pra um envio ad-hoc
function montarHtmlCards(cards, titulo) {
  const semBotoesDecisao = cards.map((c) => ({ ...c, tokenAcao: null }));
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:#1a56db;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0;">
      <div style="font-size:17px;font-weight:bold;">${escapeHtml(titulo)}</div>
      <div style="font-size:12.5px;opacity:.85;margin-top:2px;">${dataHojeBR()} · ${cards.length} ticket${cards.length === 1 ? '' : 's'}</div>
    </div>
    <div style="border:1px solid #e5e5e5;border-top:none;padding:18px 22px;border-radius:0 0 8px 8px;">
      ${semBotoesDecisao.map(htmlCard).join('')}
    </div>
    <div style="font-family:Arial,sans-serif;font-size:11px;color:#999;text-align:center;margin-top:14px;">
      Zenith Ops · enviado manualmente
    </div>
  </div>`;
}

// envio manual (Master/Admin escolhe o destinatario na hora) de 1 ou mais
// cards - ver rota POST /api/central/enviar-email em index.js
async function enviarCardsPorEmail(cards, destinatario) {
  if (!destinatario) throw new Error('Informe o e-mail de destino.');
  if (!cards || !cards.length) throw new Error('Nenhum ticket selecionado.');
  const titulo = cards.length === 1
    ? `Ticket #${cards[0].numeroTicket ?? '—'} · ${cards[0].titulo || ''}`
    : `${cards.length} tickets · Zenith Ops`;
  await enviarComFallback({
    from: `Zenith Ops <${process.env.RELATORIO_EMAIL_USER}>`,
    to: destinatario,
    subject: titulo,
    html: montarHtmlCards(cards, titulo),
  });
}

// e-mail IMEDIATO de UM card assim que ele e direcionado ao MV (na criacao
// ou num redirecionamento depois) - diferente do relatorio diario
// (enviarRelatorio), que manda o resumo de todos de uma vez no horario
// configurado. As duas coisas convivem: o card chega na hora aqui, e
// aparece de novo (se ainda estiver pendente) no resumo do dia seguinte.
// Quem chama decide o que fazer com erro - normalmente so loga, nunca
// derruba a acao que criou/redirecionou o card (ver index.js)
async function notificarCardMV(card) {
  if (!card || card.direcionadoParaEmail !== MV_EMAIL) return;
  const to = process.env.RELATORIO_EMAIL_TO;
  if (!to) throw new Error('RELATORIO_EMAIL_TO não configurado.');

  const cardParaEnviar = { ...card };
  if (card.status === 'PENDENTE' && TIPOS_COM_ACAO_POR_EMAIL.has(card.tipo)) {
    const { tokenAcao } = await solicitacoes.gerarTokenAcao(card.id);
    cardParaEnviar.tokenAcao = tokenAcao;
  }

  const titulo = `Nova solicitação · MV`;
  await enviarComFallback({
    from: `Zenith Ops <${process.env.RELATORIO_EMAIL_USER}>`,
    to,
    subject: `${titulo} - #${cardParaEnviar.numeroTicket ?? '—'} - ${cardParaEnviar.titulo || ''}`,
    html: montarHtmlCardUnico(cardParaEnviar, titulo),
  });
}

// o resolvedor de host do nodemailer (lib/shared/index.js) busca IPv4 E
// IPv6 de smtp.gmail.com e sorteia um endereco qualquer dos dois pra
// conectar - nao tem nenhuma opcao (nem "family") pra forcar so IPv4. Em
// ambientes sem rota de saida IPv6 (Render incluso), cair num endereco
// IPv6 da ECONNREFUSED/ENETUNREACH na hora, mesmo com usuario/senha certos.
// Pra contornar, resolvemos o IPv4 nos mesmos com dns.resolve4 e passamos
// o IP literal como host - "servername" garante que a validacao do
// certificado TLS (SNI) continua batendo com smtp.gmail.com normalmente.
//
// Um endereco IPv4 especifico do Gmail pode ficar temporariamente
// inalcancavel (blackhole de rede, throttling) sem que a conta tenha nada
// de errado - por isso NAO cacheamos o transportador/IP escolhido: um
// primeiro pick ruim ficava memorizado pra sempre (so um restart do
// processo resolvia), travando literalmente TODO envio de e-mail dali em
// diante. Em vez disso, tenta cada endereco resolvido, em ordem aleatoria,
// e so desiste se TODOS falharem.
async function enviarComFallback(opcoesEmail) {
  const user = process.env.RELATORIO_EMAIL_USER;
  const pass = process.env.RELATORIO_EMAIL_PASS;
  if (!user || !pass) throw new Error('RELATORIO_EMAIL_USER/RELATORIO_EMAIL_PASS não configurados.');
  const enderecos = await dns.resolve4('smtp.gmail.com');
  for (let i = enderecos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [enderecos[i], enderecos[j]] = [enderecos[j], enderecos[i]];
  }
  let ultimoErro;
  for (const ip of enderecos) {
    const transporter = nodemailer.createTransport({
      host: ip,
      servername: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    try {
      await transporter.sendMail(opcoesEmail);
      return;
    } catch (err) {
      ultimoErro = err;
    }
  }
  throw ultimoErro;
}

async function enviarRelatorio() {
  const to = process.env.RELATORIO_EMAIL_TO;
  if (!to) throw new Error('RELATORIO_EMAIL_TO não configurado.');
  const dados = await montarDados();
  await enviarComFallback({
    from: `Zenith Ops <${process.env.RELATORIO_EMAIL_USER}>`,
    to,
    subject: `Relatório de Solicitações - MV - ${dataHojeBR()}`,
    html: montarHtml(dados),
  });
  return { total: dados.total, pendentes: dados.grupos.PENDENTE.length, aprovados: dados.grupos.APROVADO.length, rejeitados: dados.grupos.REJEITADO.length };
}

// agenda o envio diario (cron.schedule ja roda em cima do timezone
// informado, sem precisar converter hora local -> UTC na mao)
function iniciarAgendamento() {
  const horaCron = process.env.RELATORIO_HORA || '0 8 * * *';
  if (!cron.validate(horaCron)) {
    console.error(`RELATORIO_HORA inválido ("${horaCron}") - agendamento do relatório diário MV desativado.`);
    return;
  }
  cron.schedule(horaCron, () => {
    enviarRelatorio().catch((err) => console.error('Erro ao enviar relatório diário MV:', err.message));
  }, { timezone: FUSO_BR });
}

module.exports = { enviarRelatorio, iniciarAgendamento, montarDados, montarHtml, notificarCardMV, enviarCardsPorEmail, MV_EMAIL, TIPOS_COM_ACAO_POR_EMAIL };
