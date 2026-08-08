// fechamentosReport.js
// Relatorio (CSV/PDF) dos Fechamentos de caixa no periodo filtrado - mesma
// tabela mostrada no painel "Fechamentos" de fechamentos.html, pra levar
// pra fora do sistema (ex: apresentar caixa/quebra do periodo pra alguem
// que nao acessa o dashboard).
//
// As colunas sao montadas do MESMO jeito da tabela da tela (ver
// tabelaFechamentosHtml/colunasExtras em fechamentos.html): alem das fixas
// (Data/Unidade/Gerente/Faturamento/Total declarado/Diferenca/Quebra/
// Observacao), os campos do schema antigo (Adyen/Ifood/99Food/Pix/Loja) e
// os Canais de venda/Formas de pagamento definidos por grupo em /grupos.html
// SO entram se pelo menos um fechamento do resultado de fato preencheu
// aquele campo - o relatorio sai exatamente com as colunas preenchidas,
// sem colunas fantasmas de R$ 0,00 nem campos lancados ficando de fora.
const PDFDocument = require('pdfkit');

function slugify(text) {
  return String(text || 'relatorio-fechamentos')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'relatorio-fechamentos';
}

function fmtData(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

function fmtMoney(v) {
  return 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const COLUNAS_BASE = [
  { key: 'data', label: 'Data', largura: 58 },
  { key: 'unidadeNome', label: 'Unidade', largura: 58 },
  { key: 'gerente', label: 'Gerente', largura: 46 },
  { key: 'faturamento', label: 'Faturamento', moeda: true, largura: 64 },
  { key: 'totalDeclarado', label: 'Total declarado', moeda: true, largura: 64 },
  { key: 'diferenca', label: 'Diferença', moeda: true, largura: 58 },
  { key: 'quebra', label: 'Quebra', moeda: true, largura: 56 },
];
// schema antigo (planilha importada) - MAS "adyen" tambem e a soma da secao
// "Maquininhas (cartao)" de todo lancamento do sistema, por isso o label nao
// pode ser "Adyen" (colidia com a forma de pagamento "Adyen" definida pelo
// grupo, saindo duas colunas "Adyen" no relatorio - ver mesmo fix em
// fechamentos.html). Mesma regra da tela: so aparece se alguma linha usa
const CAMPOS_FIXOS = [
  { key: 'adyen', label: 'Maquininhas (cartão)' }, { key: 'ifood', label: 'Ifood' }, { key: 'food99', label: '99Food' },
  { key: 'pix', label: 'Pix' }, { key: 'loja', label: 'Loja' },
];
const COLUNA_OBSERVACAO = { key: 'observacao', label: 'Observação', largura: 75 };

// colunas extras (Canais de venda / Formas de pagamento) preenchidas em pelo
// menos uma linha - label vem da definicao do grupo da unidade (grupos.js),
// com fallback pro nome do campo (mesma logica de colunasExtras na tela)
function colunasExtrasUsadas(fechamentos, grupos, chave, prefixo) {
  const grupoDe = (u) => (grupos || []).find((g) => (g.unidades || []).includes(u)) || null;
  const vistas = new Map(); // campo -> label
  fechamentos.forEach((f) => {
    const mapa = f[chave] || {};
    if (!Object.keys(mapa).length) return;
    const grupo = grupoDe(f.unidade);
    const defs = grupo ? (grupo[chave] || []) : [];
    Object.keys(mapa).forEach((campo) => {
      if (!vistas.has(campo)) vistas.set(campo, (defs.find((k) => k.campo === campo) || {}).label || campo);
    });
  });
  return [...vistas.entries()].map(([campo, label]) => ({ key: prefixo + campo, label, moeda: true, largura: 58, origem: chave, campo }));
}

// monta colunas (na ordem da tela) + linhas ja com todos os valores
// achatados por key - "grupos" e a lista de grupos.list() (pros labels)
function prepararRelatorio(fechamentos, grupos) {
  const rows = [...fechamentos].sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  const fixasUsadas = CAMPOS_FIXOS
    .filter((c) => rows.some((f) => Math.abs(f[c.key] || 0) > 0.001))
    .map((c) => ({ ...c, moeda: true, largura: 58 }));
  const canais = colunasExtrasUsadas(rows, grupos, 'canaisVendaExtras', 'canal:');
  const formas = colunasExtrasUsadas(rows, grupos, 'formasPagamentoExtras', 'forma:');
  const colunas = [...COLUNAS_BASE, ...fixasUsadas, ...canais, ...formas, COLUNA_OBSERVACAO];

  const linhas = rows.map((f) => {
    const linha = {
      data: f.data,
      unidadeNome: f.unidadeNome || f.unidade,
      gerente: f.gerente || '—',
      faturamento: f.faturamento || 0,
      totalDeclarado: f.totalDeclarado || 0,
      diferenca: f.diferenca || 0,
      quebra: f.quebra || 0,
      observacao: f.observacao || f.obsDif || '—',
    };
    fixasUsadas.forEach((c) => { linha[c.key] = f[c.key] || 0; });
    [...canais, ...formas].forEach((c) => { linha[c.key] = (f[c.origem] || {})[c.campo] || 0; });
    return linha;
  });
  return { colunas, linhas };
}

function formatarCelula(coluna, valor) {
  if (coluna.key === 'data') return fmtData(valor);
  if (coluna.moeda) return fmtMoney(valor);
  return valor ?? '';
}

function toCSV(colunas, linhas) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [colunas.map((c) => escape(c.label)).join(',')];
  linhas.forEach((l) => out.push(colunas.map((c) => escape(formatarCelula(c, l[c.key]))).join(',')));
  // BOM no inicio - sem isso o Excel/Sheets as vezes le acentos errado num CSV UTF-8
  return '﻿' + out.join('\r\n');
}

// larguras: cada coluna tem a sua (ver defs acima); quando o total passa da
// area util do A4 paisagem (~761pt, ja descontadas as margens), todas
// encolhem na mesma proporcao pra caber - com muitos canais/formas extras as
// colunas ficam mais apertadas, mas nenhuma fica de fora
const AREA_UTIL_PT = 761;
function largurasAjustadas(colunas) {
  const total = colunas.reduce((s, c) => s + (c.largura || 58), 0);
  const fator = total > AREA_UTIL_PT ? AREA_UTIL_PT / total : 1;
  const larg = {};
  colunas.forEach((c) => { larg[c.key] = Math.floor((c.largura || 58) * fator); });
  return larg;
}

function writePDF(res, { titulo, subtitulo, colunas, linhas, nomeArquivo }) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(nomeArquivo || titulo)}.pdf"`);
  doc.pipe(res);

  const tableX = doc.page.margins.left;
  const larg = largurasAjustadas(colunas);
  const tableWidth = colunas.reduce((s, c) => s + larg[c.key], 0);
  // quando as colunas encolheram pra caber (muitos canais/formas), a fonte
  // encolhe junto - senao "R$ 1.771,94" nao cabe e vira "..."
  const totalDesejado = colunas.reduce((s, c) => s + (c.largura || 58), 0);
  const fonteTabela = totalDesejado > AREA_UTIL_PT ? Math.max(6, Math.floor(8 * AREA_UTIL_PT / totalDesejado)) : 8;

  const totalFechamentos = linhas.length;
  const faturamentoTotal = linhas.reduce((s, l) => s + l.faturamento, 0);
  const declaradoTotal = linhas.reduce((s, l) => s + l.totalDeclarado, 0);
  const diferencaTotal = linhas.reduce((s, l) => s + l.diferenca, 0);

  function cabecalhoPagina() {
    doc.fontSize(8).fillColor('#5b6470').text('SOLUTIONS TI TECH · ZENITH OPS · RELATÓRIO DE FECHAMENTOS', tableX, 30, { characterSpacing: 1 });
    doc.fontSize(16).fillColor('#111').text(titulo, tableX, 42);
    doc.fontSize(9).fillColor('#666').text(subtitulo, tableX, 64);
  }

  function resumo(y) {
    const itens = [
      [String(totalFechamentos), 'fechamentos no período'],
      [fmtMoney(faturamentoTotal), 'faturamento total'],
      [fmtMoney(declaradoTotal), 'total declarado'],
      [fmtMoney(diferencaTotal), 'diferença de caixa'],
    ];
    let x = tableX;
    itens.forEach(([val, lbl]) => {
      doc.fontSize(16).fillColor('#111').text(val, x, y);
      doc.fontSize(8).fillColor('#666').text(lbl.toUpperCase(), x, y + 20, { width: 160, characterSpacing: 0.5 });
      x += 165;
    });
    return y + 46;
  }

  function linhaCabecalhoTabela(y) {
    doc.rect(tableX, y, tableWidth, 20).fill('#eef1f4');
    doc.fillColor('#333').fontSize(fonteTabela);
    let x = tableX;
    for (const c of colunas) {
      doc.text(c.label.toUpperCase(), x + 4, y + 6, { width: larg[c.key] - 8 });
      x += larg[c.key];
    }
    return y + 20;
  }

  cabecalhoPagina();
  let y = resumo(90);
  y = linhaCabecalhoTabela(y);

  if (!linhas.length) {
    doc.fontSize(10).fillColor('#888').text('Nenhum fechamento encontrado nesse período.', tableX, y + 12);
  }

  doc.fontSize(fonteTabela).fillColor('#222');
  const alturaLinha = 18;
  for (const linha of linhas) {
    if (y + alturaLinha > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = linhaCabecalhoTabela(doc.page.margins.top);
      doc.fontSize(fonteTabela).fillColor('#222');
    }
    let x = tableX;
    for (const c of colunas) {
      const valor = formatarCelula(c, linha[c.key]);
      doc.text(String(valor ?? ''), x + 4, y + 5, { width: larg[c.key] - 8, height: alturaLinha - 4, ellipsis: true });
      x += larg[c.key];
    }
    doc.moveTo(tableX, y + alturaLinha).lineTo(tableX + tableWidth, y + alturaLinha).strokeColor('#ddd').lineWidth(0.5).stroke();
    y += alturaLinha;
  }

  doc.end();
}

module.exports = { slugify, prepararRelatorio, toCSV, writePDF };
