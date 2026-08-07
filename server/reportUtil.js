// reportUtil.js
// Nucleo generico de CSV/PDF reaproveitado pelos relatorios de tabelas que
// nao tinham exportacao (Entregas, iFood, Usuarios, Grupos, Central
// Historico, Relatorios de disputa, Comparativo de Fechamentos) - mesmo
// padrao visual/estrutural ja usado em fechamentosReport.js/fraudReport.js/
// alertReport.js/monitorReport.js, so que sem nenhuma logica de dominio: quem
// chama ja entrega "colunas" (array de {key,label}) e "linhas" (array de
// objetos com valores ja formatados pra exibicao, prontos pra imprimir).
// Os modulos de dominio mais antigos (fechamentosReport.js etc.) nao foram
// migrados pra cima disso de proposito - ja funcionam e mexer neles so pra
// unificar traria risco sem beneficio real.
const PDFDocument = require('pdfkit');

function slugify(text, fallback = 'relatorio') {
  return String(text || fallback)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || fallback;
}

function fmtMoneyBR(v) {
  return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDataBR(iso) {
  if (!iso) return '';
  const s = String(iso);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

const FUSO_BR = 'America/Sao_Paulo';
function fmtDataHoraBR(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: FUSO_BR }) + ' ' + d.toLocaleTimeString('pt-BR', { timeZone: FUSO_BR, hour: '2-digit', minute: '2-digit' });
}

function agoraBrasiliaFmt() {
  return new Date().toLocaleString('pt-BR', { timeZone: FUSO_BR });
}

// data de hoje (Brasilia) no formato pra sufixo de nome de arquivo -
// pedido explicito do usuario pra nunca sair um "relatorio.csv" generico
// sem saber nem do que e nem de quando e (ver uso em index.js, em todo
// nomeArquivo/Content-Disposition de relatorio)
function dataArquivo() {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_BR, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const o = {}; partes.forEach((p) => { if (p.type !== 'literal') o[p.type] = p.value; });
  return `${o.year}-${o.month}-${o.day}`;
}

// atalho pro caso mais comum: nome base (ex: "grupos", "ifood-vendas") + data
// de hoje, ja passado pelo slugify - usado em quase todo relatorio que nao
// tem um recorte mais especifico (unidade, tipo) pra incluir no nome
function nomeArquivoComData(base) {
  return `${slugify(base)}-${dataArquivo()}`;
}

function toCSV(colunas, linhas) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [colunas.map((c) => escape(c.label)).join(',')];
  linhas.forEach((l) => out.push(colunas.map((c) => escape(l[c.key])).join(',')));
  // BOM no inicio - sem isso o Excel/Sheets as vezes le acentos errado num CSV UTF-8
  return '﻿' + out.join('\r\n');
}

// larguras iguais somando ~761pt (A4 paisagem menos margens de 36pt de cada
// lado) quando quem chama nao especifica largura por coluna - suficiente pra
// tabelas de ate ~10 colunas; acima disso vale passar "larguras" explicito
function largurasPadrao(colunas) {
  const cada = Math.floor(761 / colunas.length);
  const map = {};
  colunas.forEach((c) => { map[c.key] = cada; });
  return map;
}

function writePDF(res, { titulo, subtitulo, colunas, linhas, resumo, larguras, semDadosMsg, nomeArquivo, cabecalho, linhasDinamicas }) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo || slugify(titulo)}.pdf"`);
  doc.pipe(res);

  const tableX = doc.page.margins.left;
  const larg = larguras || largurasPadrao(colunas);
  const tableWidth = colunas.reduce((s, c) => s + (larg[c.key] || 60), 0);

  function cabecalhoPagina() {
    doc.fontSize(8).fillColor('#5b6470').text(cabecalho || 'SOLUTIONS TI TECH · ZENITH OPS', tableX, 30, { characterSpacing: 1 });
    doc.fontSize(16).fillColor('#111').text(titulo, tableX, 42);
    doc.fontSize(9).fillColor('#666').text(subtitulo || '', tableX, 64);
  }

  function blocoResumo(y) {
    if (!resumo || !resumo.length) return y;
    let x = tableX;
    resumo.forEach(([val, lbl]) => {
      doc.fontSize(16).fillColor('#111').text(String(val), x, y);
      doc.fontSize(8).fillColor('#666').text(String(lbl).toUpperCase(), x, y + 20, { width: 160, characterSpacing: 0.5 });
      x += 165;
    });
    return y + 46;
  }

  function linhaCabecalhoTabela(y) {
    doc.rect(tableX, y, tableWidth, 20).fill('#eef1f4');
    doc.fillColor('#333').fontSize(8);
    let x = tableX;
    for (const c of colunas) {
      doc.text(c.label.toUpperCase(), x + 4, y + 6, { width: (larg[c.key] || 60) - 8 });
      x += larg[c.key] || 60;
    }
    return y + 20;
  }

  cabecalhoPagina();
  let y = blocoResumo(90);
  y = linhaCabecalhoTabela(y);

  if (!linhas.length) {
    doc.fontSize(10).fillColor('#888').text(semDadosMsg || 'Nenhum registro encontrado.', tableX, y + 12);
  }

  doc.fontSize(8).fillColor('#222');
  const alturaLinhaMin = 18;
  for (const linha of linhas) {
    // altura da linha: fixa por padrao (celula corta com "..."); com
    // "linhasDinamicas" a linha cresce pra baixo ate caber a celula mais
    // alta, quebrando o texto na largura da coluna - nada e cortado, mesmo
    // que a linha fique bem maior que as outras (ex: lista de itens de uma
    // Compra no relatorio da Central)
    let alturaLinha = alturaLinhaMin;
    if (linhasDinamicas) {
      for (const c of colunas) {
        const h = doc.heightOfString(String(linha[c.key] ?? ''), { width: (larg[c.key] || 60) - 8 }) + 10;
        if (h > alturaLinha) alturaLinha = h;
      }
      // nunca mais alta que a area util de uma pagina inteira
      alturaLinha = Math.min(alturaLinha, doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 30);
    }
    if (y + alturaLinha > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = linhaCabecalhoTabela(doc.page.margins.top);
      doc.fontSize(8).fillColor('#222');
    }
    let x = tableX;
    for (const c of colunas) {
      const opcoesCelula = linhasDinamicas
        ? { width: (larg[c.key] || 60) - 8 }
        : { width: (larg[c.key] || 60) - 8, height: alturaLinha - 4, ellipsis: true };
      doc.text(String(linha[c.key] ?? ''), x + 4, y + 5, opcoesCelula);
      x += larg[c.key] || 60;
    }
    doc.moveTo(tableX, y + alturaLinha).lineTo(tableX + tableWidth, y + alturaLinha).strokeColor('#ddd').lineWidth(0.5).stroke();
    y += alturaLinha;
  }

  doc.end();
}

module.exports = { slugify, toCSV, writePDF, fmtMoneyBR, fmtDataBR, fmtDataHoraBR, agoraBrasiliaFmt, dataArquivo, nomeArquivoComData };
