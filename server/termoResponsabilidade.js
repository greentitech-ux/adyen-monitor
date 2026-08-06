// termoResponsabilidade.js
// Termo de responsabilidade (uso do parque de trampolins) gerado em PDF a
// partir de um check-in de server/parque.js - impresso e assinado
// fisicamente pelo responsavel antes da entrada no parque. Layout retrato,
// texto corrido, diferente do padrao de tabela de reportUtil.js.
const PDFDocument = require('pdfkit');

// ---------- identidade da operadora do parque - troque so aqui quando o
// nome/CNPJ/endereco oficial for confirmado (o usuario avisou que
// "WOW PARK PATTEO" nao e mais o nome correto, o certo vem depois) ----------
const EMPRESA_NOME = 'WOW PARK PATTEO LTDA';
const EMPRESA_CNPJ = '54.673.305/0001-93';
const EMPRESA_ENDERECO = 'Shopping Patteo Olinda';
const EMPRESA_CIDADE = 'Olinda';

function fmtDataBR(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
}

function fmtHora(hhmmss) {
  return hhmmss ? String(hhmmss).slice(0, 5) : '';
}

const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function dataPorExtenso(d) {
  return `${EMPRESA_CIDADE}, ${d.getDate()} de ${MESES_PT[d.getMonth()]} de ${d.getFullYear()}.`;
}

// substitui as mencoes ao nome da operadora no texto legal pelo valor atual
// de EMPRESA_NOME - assim trocar o nome/CNPJ/endereco no topo do arquivo
// atualiza tudo (cabecalho, corpo do termo, assinatura) de uma vez so
function textoComEmpresa() {
  return TEXTO_TERMO.split('WOW PARK').join(EMPRESA_NOME);
}

// texto oficial fornecido pelo usuario (contrato "PASSAPORTE MENSAL PATTEO
// OLINDA" da WOW PARK PATTEO LTDA - operadora do parque em nome da
// Saltiverso Patteo) - reproduzido verbatim; se a versao correta/atualizada
// for enviada depois, so trocar este texto
const TEXTO_TERMO = `Estou ciente que o uso de meia antiderrapante é obrigatório. O WOW PARK, em todas as unidades, esclarece e alerta seus usuários que as atividades desenvolvidas em seus parques de trampolins (complexo de camas elásticas) se tratam de atividades esportivas de grande impacto físico, que, quando não respeitadas as orientações de segurança na sua utilização, poderão causar ao usuário ou a terceiros: entorses, ferimentos, fraturas, rupturas, arranhões, luxações, contusões, sem prejuízo de outras lesões ou até mesmo a morte. Também estou ciente que, mesmo utilizando adequadamente os equipamentos, em razão de características pessoais do usuário, existem riscos decorrentes de movimentos inadequados ou falta de coordenação motora. Dessa forma, eu, acima qualificado, declaro absoluta ciência de que a atividade desenvolvida no WOW PARK (parque de trampolins) envolve os riscos supracitados e, consciente e livremente, assumo toda e qualquer responsabilidade inerente a essa atividade, conhecida ou desconhecida, comprometendo-me a respeitar e cumprir rigorosamente as regras e orientações do estabelecimento e de seus prepostos. Ratifico e declaro que me encontro em perfeitas condições físicas para a prática dessa modalidade de diversão, assumindo o risco exclusivo por tal declaração. Ciente dos riscos inerentes à atividade (parque de trampolins), desde já, afasto e isento o WOW PARK de qualquer responsabilidade em caso de acidente, e autorizo o estabelecimento a reprimir e até mesmo proibir minha permanência em suas dependências, na hipótese de ser constatada qualquer alteração comportamental que ponha em risco a minha integridade física ou a de terceiros, assumindo integral responsabilidade pela reparação dos danos que der causa, sejam eles pessoais, materiais ou morais. Clientes que utilizam próteses ou que possuam qualquer limitação física, com ou sem comprometimento de equilíbrio, e/ou que apresentam histórico de condições médicas que envolvam risco potencial (cardiopatias, instabilidade cervical, epilepsia, síndrome de Down, etc.), somente poderão acessar a área de trampolins mediante apresentação de laudo médico atualizado (emitido há no máximo 6 meses), que autorize expressamente a prática de atividade física de alto impacto sem risco à própria integridade física ou à de terceiros. A autorização está condicionada ao cumprimento integral das normas de segurança do parque e à obrigatória presença de um acompanhante maior de idade que também esteja utilizando a atração. Declaro, pelo presente Termo de Responsabilidade, que, como usuário e/ou na qualidade de responsável pelo menor, estou ciente de que o WOW PARK não se responsabiliza, em hipótese alguma, pela saída e destino de seus frequentadores, cabendo aos responsáveis acompanhar a entrada, permanência e saída dos menores do parque. Não haverá a aceitação do encargo de guarda dos menores e portadores de necessidade especiais, cabendo aos pais e/ou tutores e curadores a manutenção do encargo de guarda e zelo pelas pessoas que se encontrem nessa condição. Os pais e responsáveis por pessoas portadoras de necessidades especiais que reduzam o discernimento ou gerem comportamentos agressivos e/ou incompatíveis com ambientes agitados deverão comunicar o fato aos responsáveis pelo WOW PARK, cientes da responsabilidade civil pela prestação de informações autênticas em documentos particulares. O WOW PARK não se responsabiliza por quaisquer objetos deixados nas áreas comuns do parque, incluindo perdas, extravios ou danos de qualquer natureza. Ressaltamos que são disponibilizados armários, individuais, com código de acesso, através de senha, chaves ou similar, para a guarda de pertences pessoais e itens de valor. Além disso, autorizo o WOW PARK a fazer uso das imagens, gravações ou fotografias captadas dentro do seu ambiente, para fins de direito ou de divulgação publicitária, sem que isso caracterize uso indevido de imagem ou qualquer violação de direitos. PORTANTO, DECLARO QUE LI, COMPREENDI E PREENCHI ESTE FORMULÁRIO DE TERMO DE RESPONSABILIDADE E CONCORDO EXPRESSAMENTE COM TODOS OS SEUS TERMOS E CONDIÇÕES, ASSUMINDO CIVIL E CRIMINALMENTE PELA VERACIDADE DAS INFORMAÇÕES PRESTADAS. Ao assinar este termo, também concordo com o Regulamento e autorizo o tratamento de meus dados pessoais para finalidade específica pelo WOW PARK, em conformidade com a Lei nº 13.709 – Lei Geral de Proteção de Dados Pessoais (LGPD). POR FIM, DECLARO QUE NÃO SOLICITEI EVENTUAIS ALTERAÇÕES NO DOCUMENTO E NÃO INCLUI QUALQUER INFORMAÇÃO ADICIONAL, MESMO APÓS A LEITURA DO PRESENTE DOCUMENTO. O presente Termo de Responsabilidade tem validade por tempo indeterminado.`;

function gerarTermoPDF(res, checkin) {
  const doc = new PDFDocument({ margin: 48, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="termo-${checkin.id}.pdf"`);
  doc.pipe(res);

  const x = doc.page.margins.left;
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.fontSize(8).fillColor('#5b6470').text(`${EMPRESA_NOME} · CNPJ ${EMPRESA_CNPJ} · ${EMPRESA_ENDERECO}`, x, doc.y, { characterSpacing: 0.5 });
  doc.moveDown(0.3);
  doc.fontSize(17).fillColor('#111').text('Termo de Ciência e Responsabilidade', x, doc.y);
  doc.fontSize(10).fillColor('#666').text('Acesso ao espaço de trampolins/jump', x, doc.y);
  doc.moveDown(1);

  function linhaCampo(label, valor) {
    doc.fontSize(9).fillColor('#666').text(label.toUpperCase(), x, doc.y, { characterSpacing: 0.5 });
    doc.fontSize(11).fillColor('#111').text(valor || '—', x, doc.y);
    doc.moveDown(0.6);
  }

  doc.rect(x, doc.y, largura, 1).fill('#dde3ea');
  doc.moveDown(0.8);

  linhaCampo('Contratante (responsável)', checkin.responsavel?.nome);
  linhaCampo('CPF', checkin.responsavel?.cpf);
  linhaCampo('Contato', checkin.responsavel?.contato);
  linhaCampo('Endereço', [checkin.responsavel?.endereco || checkin.responsavel?.cep, checkin.responsavel?.numero, checkin.responsavel?.complemento].filter(Boolean).join(', '));
  const horarioTexto = checkin.iniciado
    ? `${fmtHora(checkin.timeInicial)} às ${fmtHora(checkin.timeFinal)}`
    : 'horário definido no check-in';
  linhaCampo('Data de utilização', `${fmtDataBR(checkin.dataUtilizacao)} · ${horarioTexto} (${checkin.tempoMinutos} min)`);
  if (checkin.adultoCortesia) {
    linhaCampo('Adulto cortesia (A.C.)', `Sim — ${checkin.quantAC || 1} adulto(s) com entrada permitida`);
  }

  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#666').text('BENEFICIÁRIO(S) — CRIANÇAS QUE VÃO UTILIZAR O PARQUE', x, doc.y, { characterSpacing: 0.5 });
  doc.moveDown(0.3);
  (checkin.criancas || []).forEach((c, i) => {
    doc.fontSize(11).fillColor('#111').text(`${i + 1}. ${c.nome}${c.dataNascimento ? '  ·  nascimento: ' + fmtDataBR(c.dataNascimento) : ''}`, x, doc.y);
    doc.moveDown(0.3);
  });

  doc.moveDown(0.8);
  doc.rect(x, doc.y, largura, 1).fill('#dde3ea');
  doc.moveDown(0.8);

  doc.fontSize(10).fillColor('#333').text(textoComEmpresa(), x, doc.y, { width: largura, align: 'justify', lineGap: 3 });

  doc.moveDown(1.5);
  doc.fontSize(10).fillColor('#333').text(dataPorExtenso(new Date()), x, doc.y);

  doc.moveDown(2.5);
  const yAssinatura = doc.y;
  doc.moveTo(x, yAssinatura).lineTo(x + 240, yAssinatura).strokeColor('#333').lineWidth(1).stroke();
  doc.moveTo(x + 300, yAssinatura).lineTo(x + largura, yAssinatura).strokeColor('#333').lineWidth(1).stroke();
  doc.fontSize(9).fillColor('#666').text('Contratante (responsável)', x, yAssinatura + 4);
  doc.fontSize(9).fillColor('#666').text(EMPRESA_NOME, x + 300, yAssinatura + 4);

  doc.end();
}

module.exports = { gerarTermoPDF };
