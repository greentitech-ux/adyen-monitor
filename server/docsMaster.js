// docsMaster.js
// Topicos da Ajuda EXCLUSIVOS de Master/Admin. Ficam aqui no backend (e nao
// no HTML publico de ajuda.html) de proposito: conteudo que so o Master pode
// conhecer nao deve nem viajar pro navegador de um colaborador de loja.
// Servidos por GET /api/ajuda/topicos-master (auth.requireMasterOrAdmin).
// Mesmo formato dos TOPICOS de ajuda.html: { id, icone, secoes:'master', titulo, corpo }.
const TOPICOS_MASTER = [
  { id:'tags-cargo', icone:'🏷️', secoes:'master', titulo:'Tags de cargo e telas iniciais (Master)', corpo:`
    <p>Na tela de <b>Usuários</b>, além das seções e unidades, cada acesso pode receber uma <b>tag de cargo</b> - ela define a identidade da pessoa no sistema e a <b>tela em que ela pousa</b> ao entrar:</p>
    <ul>
      <li><b>🏬 Loja</b> → pousa no <b>Histórico de Solicitações</b>.</li>
      <li><b>👔 Gerente</b> → pousa no Painel (tag só de identificação).</li>
      <li><b>🔧 Técnico</b> → pousa nos <b>Chamados de TI</b> (atendimento de campo).</li>
      <li><b>🎧 Suporte</b> → pousa nos <b>Chamados de TI</b> (atendimento remoto + chats do site).</li>
      <li><b>🛠️ Manutenção</b> → pousa na tela de <b>Manutenção</b>.</li>
      <li>Sem tag (ou Master) → Painel.</li>
    </ul>
    <h3>Tag ≠ permissão</h3>
    <p>A tag NÃO libera acesso sozinha - quem manda no que a pessoa consegue abrir continuam sendo as <b>seções</b>. Pro time de Suporte funcionar de verdade, marque a seção <b>"Suporte de TI (atendimento remoto)"</b>: ela libera a tela de Chamados TI, a visão de todos os chamados remotos, o botão ➕ Abrir chamado (remoto, no próprio nome) e o painel de atendimento dos chats do site.</p>
    <div class="dica"><b>Menu sempre visível:</b> todos os links de página aparecem no menu ☰ pra todo mundo - só Usuários, Grupos, Regras de Entregas e Reset Senha continuam restritos a Master/Admin. Ter o link não significa ter acesso: a página em si continua validando a seção.</div>
  `},
  { id:'gestao-sla', icone:'⏱️', secoes:'master', titulo:'Gestão de prioridades e SLA (Master/Admin)', corpo:`
    <p>Todo ticket da Central e todo chamado de TI nasce com uma <b>prioridade</b> que define o prazo-alvo de resolução (SLA), contado a partir da criação:</p>
    <ul>
      <li>🔴 <b>Crítica</b> - 4 horas</li>
      <li>🟠 <b>Alta</b> - 8 horas</li>
      <li>🟡 <b>Média</b> - 24 horas (padrão)</li>
      <li>🟢 <b>Baixa</b> - 72 horas</li>
    </ul>
    <h3>Como o quadro usa isso</h3>
    <ul>
      <li>Cada card mostra o chip da prioridade e o relógio do SLA ("⏳ SLA 5h" / "🔥 SLA estourado há 2h"). O relógio fica amarelo quando falta menos de 25% do tempo.</li>
      <li>Dentro de cada coluna, a fila ordena por andamento → prioridade → prazo mais apertado. Finalizado fica sempre embaixo.</li>
      <li>O relógio conta enquanto o ticket está <b>Pendente</b> ou <b>Aprovado sem Finalizar</b> - Rejeitado e Finalizado não mostram SLA.</li>
      <li>O filtro <b>Prioridade</b> (ao lado de loja/grupo/data) tem a opção <b>🔥 SLA estourado</b> pra enxergar de uma vez tudo que passou do prazo.</li>
    </ul>
    <h3>Re-priorizar na triagem</h3>
    <p>Master/Admin abrem o detalhe do ticket e trocam a prioridade no seletor ao lado dos chips - o prazo é <b>recalculado a partir da criação</b> do ticket (não de agora), então rebaixar/subir a prioridade reflete o tempo já corrido na fila.</p>
    <div class="dica"><b>Disciplina de triagem:</b> a loja escolhe a prioridade ao abrir o pedido, mas a palavra final é de quem faz a triagem - re-priorize cedo pra fila do dia ficar honesta.</div>
  `},
  { id:'mover-fechamento', icone:'📅', secoes:'master', titulo:'Corrigir Unidade/Data de um fechamento (Master)', corpo:`
    <p>No botão ✏️ de editar fechamento (tela Fechamentos), o Master pode corrigir também a <b>Unidade</b> e a <b>Data</b> do lançamento - útil quando a loja lançou no dia errado ou na unidade errada.</p>
    <ul>
      <li>A correção é um <b>movimento</b>: o lançamento passa a existir na unidade/data novas e some da antiga.</li>
      <li>Se já existir um fechamento lançado na unidade/data de destino, o sistema bloqueia com aviso - nada é sobrescrito.</li>
      <li>Tudo fica no <b>histórico</b> do lançamento: quem moveu, quando, motivo e os valores antes/depois.</li>
    </ul>
    <div class="dica"><b>Loja não move:</b> colaborador de loja pede a correção pelo fluxo normal de ajuste ("Pedir correção" → "Corrigir a data do lançamento"); mover direto é exclusivo do Master.</div>
  `},
  { id:'emails-sistema', icone:'📧', secoes:'master', titulo:'E-mails do sistema: disparos e configuração (Master)', corpo:`
    <p>O envio usa a <b>API do Gmail por HTTPS</b> (o Render bloqueia SMTP), autenticada pelas variáveis <b>GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_OAUTH_REFRESH_TOKEN</b> no Render, enviando como <b>RELATORIO_EMAIL_USER</b>.</p>
    <h3>Disparos automáticos</h3>
    <ul>
      <li><b>Notificação instantânea ao MV:</b> quando um ticket é direcionado ao e-mail do MV (na criação ou depois), o card vai por e-mail na hora - com botões Aprovar/Recusar de uso único quando o tipo permite ação por e-mail.</li>
      <li><b>Relatório diário:</b> no horário de <b>RELATORIO_HORA</b> (padrão 8h, horário de Brasília) vai um resumo dos tickets pro <b>RELATORIO_EMAIL_TO</b>.</li>
      <li><b>Quebra de caixa:</b> NÃO dispara e-mail sozinha - o ticket nasce sem direcionamento e só notifica se alguém direcionar ao MV manualmente.</li>
    </ul>
    <h3>Disparo manual</h3>
    <p>Na Central/Histórico, Master/Admin selecionam tickets (modo seleção ou detalhe) e usam <b>"Enviar por e-mail"</b> pra qualquer destinatário - tickets Pendentes dos tipos com ação por e-mail vão com os botões Aprovar/Recusar.</p>
    <div class="dica"><b>Se o e-mail parar:</b> confira as 3 variáveis GMAIL_OAUTH_* no Render e se o app OAuth continua "Em produção" no Google Cloud - refresh token de app em teste expira em 7 dias.</div>
  `},
  { id:'admin-tag', icone:'⭐', secoes:'master', titulo:'Tag Admin: o que é e como usar', corpo:`
    <p>A tag Admin dá pra um usuário comum o poder de aprovar/rejeitar solicitações da Central, sem precisar virar Master (que tem acesso a tudo, incluindo gestão de usuários).</p>
    <h3>Como o Master ativa</h3>
    <ol>
      <li>Abra <b>Usuários</b>.</li>
      <li>Na linha da pessoa, clique em <b>Tornar admin</b>.</li>
      <li>O badge <span class="tagpill admin">⭐ admin</span> aparece na linha dela.</li>
    </ol>
    <h3>O que quem tem a tag Admin pode fazer</h3>
    <ul>
      <li>Ver todas as solicitações da Central (não só as próprias).</li>
      <li>Aprovar ou rejeitar Estorno, Ajuste de Fechamento, Compra, Manutenção e Suporte de TI.</li>
      <li>Participar do chat de qualquer solicitação.</li>
    </ul>
    <div class="dica">Admin <b>não</b> pode editar/excluir solicitações direto, nem gerenciar outros usuários - isso continua exclusivo do Master.</div>
  `},
  { id:'usuarios', icone:'👤', secoes:'master', titulo:'Usuários (Master)', corpo:`
    <p>Tela exclusiva do Master pra criar e administrar todos os acessos do sistema.</p>
    <h3>Criar um acesso novo</h3>
    <ol>
      <li>Preencha e-mail, senha temporária e, se quiser, um <b>usuário</b> (login curto, tipo "jn") no formulário do topo.</li>
      <li>Marque as seções, lojas, subgrupos do Cofre e, se quiser restringir, os <b>tipos de solicitação</b> da Central que a pessoa vai poder usar.</li>
      <li>Clique em <b>Criar acesso</b>.</li>
    </ol>
    <div class="dica">A senha que você digitou é só a temporária - no primeiro login a pessoa é obrigada a trocar por uma nova antes de usar o resto do app.</div>
    <h3>🎫 Tipos de solicitação (Central)</h3>
    <p>Quem tem a seção Central de Solicitações vê, por padrão, todos os tipos (Estorno, Ajuste de fechamento, Compra, Manutenção, Suporte de TI, Pagamento, Nota). Se você marcar algum tipo específico nessa permissão, a pessoa passa a ver e agir <b>só</b> nesses tipos - útil pra um Admin que cuida só de um assunto (ex: liberar só "Suporte de TI" pra quem coordena os chamados de TI, sem ele ver os pedidos de Estorno e Compra de todo mundo).</p>
    <h3>Gerenciar um acesso existente</h3>
    <ul>
      <li><b>Permissões</b>: muda seções/lojas/subgrupos liberados.</li>
      <li><b>Horário</b>: restringe o login a um intervalo do dia.</li>
      <li><b>Tornar admin / Remover admin</b>: dá ou tira o poder de aprovar solicitações da Central.</li>
      <li><b>Liberar Catálogo do Estoque</b>: deixa a pessoa organizar setor/tipo, ajustar custo de referência e ativar/desativar item no Catálogo do Estoque, sem precisar virar Master nem Admin - útil pra um gerente que cuida disso no dia a dia da loja dele.</li>
      <li><b>Tag de cargo (Loja/Gerente)</b>: além de ser um rótulo de organização na lista, a tag <b>Gerente</b> agora também é usada de verdade no Saltiverso - só quem tem essa tag (na loja certa) ou Master/Admin pode aprovar um check-out antecipado do parque.</li>
      <li><b>Definir/Editar usuário</b>: define o login curto (usuário) da pessoa, alternativa ao e-mail na tela de login.</li>
      <li><b>Nova senha</b>: troca a senha (e destrava a conta, se estiver bloqueada) - a pessoa é obrigada a trocar de novo no próximo login.</li>
      <li><b>Ativar/Desativar</b>: liga ou desliga o acesso sem excluir.</li>
      <li><b>Excluir</b>: remove o acesso de vez.</li>
    </ul>
    <h3>Definir o "usuário" em massa</h3>
    <p>No painel <b>"Atualizar usuários em massa"</b>, mais abaixo na mesma tela, cole uma lista no formato <code>email,usuário</code> (uma linha por acesso, pode copiar de uma planilha) e clique em <b>Aplicar</b> - o sistema processa linha por linha e mostra o resultado de cada uma, sem parar se alguma der erro.</p>
  `},
  { id:'grupos', icone:'🏷️', secoes:'master', titulo:'Grupos (Master)', corpo:`
    <p>Organiza as lojas em franquias/grupos e permite configurar, por grupo, tudo que muda de loja pra loja: seções do Fechamento, campos extras e quem recebe as notificações da Central.</p>
    <h3>Criar/editar um grupo</h3>
    <ol>
      <li>Crie ou edite um grupo, associando as lojas que fazem parte dele.</li>
      <li>Escolha os <b>Responsáveis</b> (Master/Admin) que aparecem como opção de "Direcionar para" quando alguém dessa unidade abre uma solicitação na Central.</li>
    </ol>
    <h3>Seções do Fechamento</h3>
    <p>Dá pra habilitar ou desabilitar, por grupo:</p>
    <ul>
      <li><b>Caixa</b> - caixa inicial, caixa final, entrada de dinheiro, depósito.</li>
      <li><b>Maquininhas</b> - inclusive trocar o nome padrão delas (ex: "Maquininha 1, 2, 3..." vira "Getnet 1, 2, 3...").</li>
      <li><b>Saídas</b> - saída de dinheiro do caixa.</li>
    </ul>
    <h3>Canais de venda / Formas de pagamento extras</h3>
    <p>Além dos campos fixos, dá pra criar campos extras próprios do grupo. Pra cada campo extra, escolha:</p>
    <ul>
      <li><b>Soma ou subtrai</b> no total da própria seção.</li>
      <li><b>Também soma no outro total</b> - ex: TEF Crédito é um Canal de venda, mas já é uma forma de pagamento validada, então também soma no Total Declarado (senão dava "falta no caixa" à toa, mesmo estando tudo certo).</li>
    </ul>
    <h3>KPI's extras</h3>
    <p>Campos extras que aparecem no fim do Fechamento, cada um com a unidade de medida certa: <b>Quantidade</b>, <b>R$</b>, <b>Kg</b>, <b>Arquivo</b> (upload de foto/comprovante) ou <b>Texto</b>.</p>
  `},
];

module.exports = { TOPICOS_MASTER };
