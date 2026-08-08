// prioridades.js
// Tabela unica de prioridades + SLA usada pelos Chamados de TI e pelas
// Solicitacoes da Central. O SLA e o prazo-alvo pra RESOLVER o ticket,
// contado a partir da criacao; o front usa slaPrazo pra pintar o chip de
// "vence em Xh" / "atrasado ha Xh". `ordem` define a posicao na fila
// (menor = mais urgente = aparece primeiro).
const PRIORIDADES = {
  critica: { label: 'Crítica', slaHoras: 4, ordem: 0 },
  alta: { label: 'Alta', slaHoras: 8, ordem: 1 },
  media: { label: 'Média', slaHoras: 24, ordem: 2 },
  baixa: { label: 'Baixa', slaHoras: 72, ordem: 3 },
};

const PRIORIDADE_PADRAO = 'media';

function sanitizarPrioridade(p) {
  return PRIORIDADES[p] ? p : PRIORIDADE_PADRAO;
}

// prazo do SLA em ISO, a partir do instante de criacao
function slaPrazo(prioridade, criadoEmIso) {
  const base = criadoEmIso ? new Date(criadoEmIso) : new Date();
  const horas = (PRIORIDADES[sanitizarPrioridade(prioridade)] || PRIORIDADES[PRIORIDADE_PADRAO]).slaHoras;
  return new Date(base.getTime() + horas * 60 * 60 * 1000).toISOString();
}

function ordemPrioridade(p) {
  return (PRIORIDADES[p] || PRIORIDADES[PRIORIDADE_PADRAO]).ordem;
}

module.exports = { PRIORIDADES, PRIORIDADE_PADRAO, sanitizarPrioridade, slaPrazo, ordemPrioridade };
