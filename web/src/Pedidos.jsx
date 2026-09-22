import { Fragment, useEffect, useState } from 'react';
import {
  CarFront,
  Ban,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Database,
  History,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Truck,
  UserRound,
  ShieldX,
  X
} from 'lucide-react';
import {
  buscarPedido,
  buscarResumoPedidos,
  obterStatusSicoob,
  listarFilaPedidos,
  cancelarPedido,
  estornarECancelarPedido,
  reprocessarPedido,
  reprocessarComunicacaoFornecedor,
} from './api';
import NovoPedido from './NovoPedido';
import ConfirmarPagamento from './ConfirmarPagamento';
import CobrancaSicoob from './CobrancaSicoob';
import ResultadoPedido from './ResultadoPedido';
import ValidarResultado from './ValidarResultado';
import CorrigirDadosPedido from './CorrigirDadosPedido';

const STATUS = {
  ABERTO: 'Aberto',
  AGUARDANDO_DADOS: 'Aguardando dados',
  EM_CONSULTA: 'Em consulta',
  AGUARDANDO_PAGAMENTO: 'Aguardando pagamento',
  PAGO: 'Pago',
  CONCLUIDO: 'Concluído',
  CANCELADO: 'Cancelado',
  ERRO: 'Erro'
};

const STATUS_COMUNICACAO = {
  PENDENTE: 'Aguardando envio',
  PROCESSANDO: 'Enviando',
  ENVIADA: 'Enviada',
  ENTREGUE: 'Entregue',
  LIDA: 'Lida',
  FALHOU: 'Falha no envio',
  INCERTA: 'Envio incerto',
  CANCELADA: 'Envio cancelado'
};

function nomeOrigem(origem, codigo) {
  if (
    codigo === 'API' ||
    origem === 'API / Sistema externo' ||
    origem === 'API'
  ) {
    return 'API Joel Pires';
  }
  return origem || 'Não definida';
}

function camposResultado(valor) {
  if (valor == null || valor === '') return [];
  if (typeof valor !== 'object') return [['Resultado', String(valor)]];

  const rotulos = {
    codigo_alarme: 'Alarme',
    origem_atendimento: 'Origem do atendimento',
    confiabilidade: 'Confiabilidade',
    final8: 'Final do chassi'
  };
  const ocultos = new Set([
    'origem_historica_id',
    'fornecedor_historico_id'
  ]);

  return Object.entries(valor)
    .filter(([chave, conteudo]) =>
      !ocultos.has(chave) && conteudo != null && conteudo !== ''
    )
    .map(([chave, conteudo]) => [
      rotulos[chave] || chave.replaceAll('_', ' '),
      typeof conteudo === 'object'
        ? JSON.stringify(conteudo)
        : String(conteudo)
    ]);
}

function dataHora(valor) {
  if (!valor) return 'Sem registro';

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(valor));
}

function dinheiro(valor, moeda = 'BRL') {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: moeda || 'BRL'
  }).format(Number(valor || 0));
}

function EstadoVazio() {
  return (
    <div className="orders-empty">
      <span><KeyRound size={30} /></span>
      <h3>Nenhum pedido encontrado</h3>
      <p>Os novos pedidos de senha aparecerão automaticamente nesta fila.</p>
    </div>
  );
}

function ListaComunicacoes({ itens, vazio, pedido, podeEditar, aoReprocessar }) {
  if (itens.length === 0) {
    return <p className="order-section-empty">{vazio}</p>;
  }
  return (
    <div className="supplier-communications">
      {itens.map(comunicacao => (
        <article key={comunicacao.id}>
          <div>
            <strong>
              {STATUS_COMUNICACAO[comunicacao.status] || comunicacao.status}
            </strong>
            <small>
              Tentativas: {Number(comunicacao.tentativas || 0)} ·{' '}
              {dataHora(
                comunicacao.lida_em || comunicacao.entregue_em ||
                comunicacao.enviado_em || comunicacao.atualizado_em
              )}
            </small>
          </div>
          {comunicacao.erro_codigo && (
            <p>
              {comunicacao.erro_codigo === 'FORNECEDOR_SEM_WHATSAPP'
                ? 'Cadastre um WhatsApp válido para o fornecedor.'
                : comunicacao.erro_codigo === 'CLIENTE_SEM_WHATSAPP'
                  ? 'Cadastre um WhatsApp válido para o cliente.'
                  : comunicacao.status === 'INCERTA'
                    ? 'Confirme manualmente antes de tentar novo envio.'
                    : 'Verifique a configuração da integração.'}
            </p>
          )}
          {podeEditar && ['FALHOU', 'INCERTA'].includes(comunicacao.status) && (
            <button
              type="button"
              className="order-payment-button"
              onClick={() => aoReprocessar(pedido, comunicacao)}
            >
              <RefreshCw size={15} />
              Tentar envio novamente
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

function DetalhePedido({
  dados,
  podeEditar,
  podeGerarCobrancaSicoob,
  aoFechar,
  aoConfirmarPagamento,
  aoGerarCobrancaSicoob,
  aoRegistrarResultado,
  aoValidarResultado,
  aoReprocessar,
  aoCorrigir,
  aoCancelar,
  aoReprocessarComunicacao
}) {
  const pedido = dados.pedido;
  const resultados = dados.resultados || [];
  const historico = dados.historico || [];
  const comunicacoes = dados.comunicacoes || [];
  const partes = dados.partes || {};
  const consultasFornecedor = comunicacoes.filter(
    item => item.finalidade === 'CONSULTA_FORNECEDOR'
  );
  const entregasCliente = comunicacoes.filter(
    item => item.finalidade === 'ENTREGA_CLIENTE'
  );
  const motivoReprocessamento = historico.find(item =>
    ['API_JOELPIRES_INDISPONIVEL', 'FORNECEDOR_GM_INDISPONIVEL']
      .includes(item.tipo)
  )?.tipo;
  const apiJoelPiresIndisponivel =
    ['ABERTO', 'ERRO'].includes(pedido.status) &&
    motivoReprocessamento === 'API_JOELPIRES_INDISPONIVEL';
  const fornecedorGmIndisponivel =
    pedido.status === 'ABERTO' &&
    motivoReprocessamento === 'FORNECEDOR_GM_INDISPONIVEL';
  const resultadoPendente = resultados.find(item =>
    item.status === 'ENCONTRADO' && item.fornecedor_id
  );

  return (
    <div className="order-detail-overlay" role="presentation">
      <aside
        className="order-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-detail-title"
      >
        <header>
          <div>
            <span>DETALHES DO PEDIDO</span>
            <h2 id="order-detail-title">{pedido.protocolo}</h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar">
            <X size={20} />
          </button>
        </header>

        <div className="order-detail-scroll">
          <div className="order-detail-status">
            <span className={`order-status status-order-${pedido.status}`}>
              {STATUS[pedido.status] || pedido.status}
            </span>
            <small>Criado em {dataHora(pedido.criado_em)}</small>
              {podeEditar && pedido.status === 'AGUARDANDO_PAGAMENTO' && (
                <button
                  type="button"
                  className="order-payment-button"
                  onClick={() => aoConfirmarPagamento({ ...pedido, partes })}
                >
                  <CircleDollarSign size={17} />
                  Confirmar pagamento
                </button>
              )}
              {podeGerarCobrancaSicoob && pedido.status === 'AGUARDANDO_PAGAMENTO' && (
                <button
                  type="button"
                  className="order-payment-button order-sicoob-button"
                  onClick={() => aoGerarCobrancaSicoob({ ...pedido, partes })}
                >
                  <CircleDollarSign size={17} />
                  Gerar Pix Sicoob
                </button>
              )}
              {podeEditar && pedido.status === 'EM_CONSULTA' && (
                <button
                  type="button"
                  className="order-payment-button"
                  onClick={() => aoRegistrarResultado(pedido)}
                >
                  <KeyRound size={17} />
                  Informar resultado
                </button>
              )}
              {podeEditar && ['ABERTO', 'ERRO'].includes(pedido.status) && (
                <button
                  type="button"
                  className="order-payment-button"
                  onClick={() => aoReprocessar(pedido)}
                >
                  <RefreshCw size={17} />
                  Tentar novamente
                </button>
              )}
              {podeEditar && pedido.status === 'AGUARDANDO_DADOS' && (
                <button
                  type="button"
                  className="order-payment-button"
                  onClick={() => aoCorrigir(pedido)}
                >
                  <CarFront size={17} />
                  Corrigir dados
                </button>
              )}
              {podeEditar && !['CONCLUIDO', 'CANCELADO'].includes(pedido.status) && (
                <button
                  type="button"
                  className="gm-incorrect-button"
                  onClick={() => aoCancelar(pedido)}
                >
                  <Ban size={17} />
                  Cancelar pedido
                </button>
              )}
          </div>

          {apiJoelPiresIndisponivel && (
            <div className="order-operational-alert">
              <Clock3 size={20} />
              <div>
                <strong>API Joel Pires temporariamente indisponível</strong>
                <span>
                  Nenhum fornecedor foi acionado e o custo permanece zero.
                  A Central tentará novamente automaticamente; use a ação
                  manual somente quando precisar antecipar a tentativa.
                </span>
              </div>
            </div>
          )}

          {fornecedorGmIndisponivel && (
            <div className="order-operational-alert">
              <Clock3 size={20} />
              <div>
                <strong>Nenhum fornecedor GM está no horário de atendimento</strong>
                <span>
                  A consulta externa não encontrou a senha. O custo permanece
                  zero e a Central tentará novamente até encaminhar a um
                  fornecedor disponível.
                </span>
              </div>
            </div>
          )}

          <section className="order-detail-section">
            <h3><UserRound size={17} /> Partes e serviço</h3>
            <div className="order-info-grid">
              <div><span>Cliente</span><strong>{pedido.cliente}</strong></div>
              <div><span>Comprador</span><strong>{partes.comprador?.nome || pedido.cliente}</strong></div>
              <div><span>Pagador</span><strong>{partes.pagador?.nome || pedido.cliente}</strong></div>
              <div><span>Serviço</span><strong>{pedido.servico}</strong></div>
              <div><span>Atendente</span><strong>{pedido.atendente || 'Não informado'}</strong></div>
              <div><span>Origem</span><strong>{nomeOrigem(pedido.origem, pedido.origem_codigo)}</strong></div>
            </div>
          </section>

          <section className="order-detail-section">
            <h3><CarFront size={17} /> Veículo</h3>
            <div className="order-info-grid">
              <div><span>Marca</span><strong>{pedido.marca || '—'}</strong></div>
              <div><span>Modelo</span><strong>{pedido.modelo || '—'}</strong></div>
              <div><span>Ano</span><strong>{pedido.ano || '—'}</strong></div>
              <div className="wide"><span>Chassi</span><strong>{pedido.chassi || '—'}</strong></div>
            </div>
          </section>

          <section className="order-detail-section">
            <h3><CircleDollarSign size={17} /> Financeiro</h3>
            <div className="order-info-grid">
              <div>
                <span>Valor de venda</span>
                <strong>{dinheiro(pedido.valor_venda, pedido.moeda)}</strong>
              </div>
              <div>
                <span>Custo</span>
                <strong>{dinheiro(pedido.custo, pedido.moeda)}</strong>
              </div>
              <div className="wide">
                <span>Fornecedor</span>
                <strong>{pedido.fornecedor || 'Base própria / não definido'}</strong>
              </div>
            </div>
          </section>

          <section className="order-detail-section">
            <h3><Database size={17} /> Resultados</h3>
            {resultados.length === 0 ? (
              <p className="order-section-empty">Nenhum resultado registrado.</p>
            ) : (
              <div className="results-list">
                {resultados.map(resultado => (
                  <article key={resultado.id}>
                    <div>
                      <strong>{nomeOrigem(resultado.origem, resultado.origem_codigo)}</strong>
                      <span>{dataHora(resultado.criado_em)}</span>
                    </div>
                    <span className={`order-status status-result-${resultado.status}`}>
                      {resultado.status}
                    </span>
                    <dl>
                      {resultado.codigo_mecanico && (
                        <><dt>Código mecânico</dt><dd>{resultado.codigo_mecanico}</dd></>
                      )}
                      {resultado.codigo_imobilizador && (
                        <><dt>Imobilizador</dt><dd>{resultado.codigo_imobilizador}</dd></>
                      )}
                      {resultado.codigo_radio && (
                        <><dt>Rádio</dt><dd>{resultado.codigo_radio}</dd></>
                      )}
                      {resultado.pin && (
                        <><dt>PIN</dt><dd>{resultado.pin}</dd></>
                      )}
                      {camposResultado(resultado.resultado).map(
                        ([rotulo, valor]) => (
                          <Fragment key={rotulo}>
                            <dt>{rotulo}</dt>
                            <dd>{valor}</dd>
                          </Fragment>
                        )
                      )}
                    </dl>
                  </article>
                ))}
              </div>
            )}
            {podeEditar && resultadoPendente && (
              <div className="gm-result-actions">
                <button
                  type="button"
                  className="gm-confirm-button"
                  onClick={() => aoValidarResultado(pedido, 'CORRETO')}
                >
                  <CheckCircle2 size={17} />
                  Cliente confirmou
                </button>
                <button
                  type="button"
                  className="gm-incorrect-button"
                  onClick={() => aoValidarResultado(pedido, 'INCORRETO')}
                >
                  <ShieldX size={17} />
                  Senha incorreta
                </button>
              </div>
            )}
          </section>

          <section className="order-detail-section">
            <h3><Truck size={17} /> Comunicação com fornecedor</h3>
            <ListaComunicacoes
              itens={consultasFornecedor}
              vazio="Nenhum envio ao fornecedor foi registrado."
              pedido={pedido}
              podeEditar={podeEditar}
              aoReprocessar={aoReprocessarComunicacao}
            />
          </section>

          <section className="order-detail-section">
            <h3><CheckCircle2 size={17} /> Entrega ao cliente</h3>
            <ListaComunicacoes
              itens={entregasCliente}
              vazio="O resultado ainda não foi preparado para entrega."
              pedido={pedido}
              podeEditar={podeEditar}
              aoReprocessar={aoReprocessarComunicacao}
            />
          </section>

          <section className="order-detail-section">
            <h3><History size={17} /> Histórico</h3>
            {historico.length === 0 ? (
              <p className="order-section-empty">Nenhum histórico registrado.</p>
            ) : (
              <div className="order-history">
                {historico.map(item => (
                  <article key={item.id}>
                    <span />
                    <div>
                      <strong>{item.descricao}</strong>
                      <small>
                        {item.usuario || 'Sistema'} · {dataHora(item.criado_em)}
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

export default function Pedidos({ buscaInicial = '', permissoes = [] }) {
  const token = localStorage.getItem('central_mykey_token');
  const permissao = permissoes.find(item => item.codigo === 'PEDIDOS_SENHAS') || {};
  const permissaoFinanceiro = permissoes.find(item => item.codigo === 'FINANCEIRO') || {};
  const podeCriar = Number(permissao.criar) === 1;
  const podeEditar = Number(permissao.editar) === 1;
  const podeGerarCobranca = Number(permissaoFinanceiro.editar) === 1;
  const [resumo, setResumo] = useState(null);
  const [pedidos, setPedidos] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState(buscaInicial);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [detalhe, setDetalhe] = useState(null);
  const [pagamento, setPagamento] = useState(null);
  const [cobrancaSicoob, setCobrancaSicoob] = useState(null);
  const [sicoobDisponivel, setSicoobDisponivel] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [validacao, setValidacao] = useState(null);
  const [correcao, setCorrecao] = useState(null);
  const [processando, setProcessando] = useState('');
  const [abrindo, setAbrindo] = useState(false);
  const [atualizacao, setAtualizacao] = useState(0);
  const [novoPedido, setNovoPedido] = useState(false);

  useEffect(() => {
    let ativo = true;
    const atraso = setTimeout(async () => {
      try {
        const [dadosResumo, dadosFila] = await Promise.all([
          buscarResumoPedidos(token),
          listarFilaPedidos(token, {
            status,
            busca: busca.trim(),
            limite: 50
          })
        ]);

        if (ativo) {
          setResumo(dadosResumo);
          setPedidos(dadosFila.dados || []);
          setTotal(Number(dadosFila.total || 0));
          setErro('');
          setCarregando(false);
        }
      } catch (error) {
        if (ativo) {
          setErro(error.message);
          setCarregando(false);
        }
      }
    }, busca ? 350 : 0);

    return () => {
      ativo = false;
      clearTimeout(atraso);
    };
  }, [token, status, busca, atualizacao]);

  useEffect(() => {
    let ativo = true;
    if (!podeGerarCobranca) {
      return () => { ativo = false; };
    }
    obterStatusSicoob(token)
      .then(resposta => {
        if (ativo) setSicoobDisponivel(resposta.disponivel === true);
      })
      .catch(() => {
        if (ativo) setSicoobDisponivel(false);
      });
    return () => { ativo = false; };
  }, [token, podeGerarCobranca, atualizacao]);

  async function abrirPedido(pedidoId) {
    setAbrindo(true);
    setErro('');

    try {
      const resposta = await buscarPedido(token, pedidoId);
      setDetalhe(resposta);
    } catch (error) {
      setErro(error.message);
    } finally {
      setAbrindo(false);
    }
  }

  async function reprocessar(pedido) {
    setProcessando('Consultando novamente a API Joel Pires...');
    setErro('');
    try {
      await reprocessarPedido(token, pedido.id);
      await abrirPedido(pedido.id);
      setAtualizacao(valor => valor + 1);
    } catch (error) {
      setErro(error.message);
    } finally {
      setProcessando('');
    }
  }

  async function reprocessarComunicacao(pedido, comunicacao) {
    const incerta = comunicacao.status === 'INCERTA';
    const destino = comunicacao.finalidade === 'ENTREGA_CLIENTE'
      ? 'cliente'
      : 'fornecedor';
    if (
      incerta &&
      !window.confirm(
        `O envio anterior pode ter sido recebido. Confirma que o ${destino} não recebeu a mensagem e deseja tentar novamente?`
      )
    ) {
      return;
    }

    setProcessando('Reagendando a comunicação...');
    setErro('');
    try {
      await reprocessarComunicacaoFornecedor(
        token,
        pedido.id,
        comunicacao.id,
        incerta
      );
      await abrirPedido(pedido.id);
      setAtualizacao(valor => valor + 1);
    } catch (error) {
      setErro(error.message);
    } finally {
      setProcessando('');
    }
  }

  async function cancelar(pedido) {
    const motivo = window.prompt(
      `Informe o motivo para cancelar o pedido ${pedido.protocolo}:`
    );
    if (!motivo?.trim()) return;
    if (!window.confirm('Confirma o cancelamento deste pedido?')) return;

    setProcessando('Cancelando o pedido...');
    setErro('');
    try {
      await cancelarPedido(token, pedido.id, motivo.trim());
      await abrirPedido(pedido.id);
      setAtualizacao(valor => valor + 1);
    } catch (error) {
      if (error.codigo === 'ESTORNO_FINANCEIRO_NECESSARIO') {
        const meio = window.prompt(
          'Informe o meio usado na devolução (PIX, DINHEIRO, TRANSFERENCIA ou OUTRO):',
          'PIX'
        )?.trim().toUpperCase();
        if (!meio) {
          setErro(error.message);
          return;
        }
        const referencia = meio === 'DINHEIRO'
          ? null
          : window.prompt('Informe a referência da devolução já realizada:')?.trim();
        if (meio !== 'DINHEIRO' && !referencia) {
          setErro('A referência da devolução é obrigatória.');
          return;
        }
        if (!window.confirm(
          'Confirma que o valor já foi devolvido ao cliente e deseja registrar o estorno e cancelar o pedido?'
        )) return;
        try {
          setProcessando('Registrando estorno e cancelando o pedido...');
          await estornarECancelarPedido(token, pedido.id, {
            meio_estorno: meio,
            referencia_externa: referencia,
            motivo_estorno: motivo.trim(),
            motivo_cancelamento: motivo.trim()
          });
          await abrirPedido(pedido.id);
          setAtualizacao(valor => valor + 1);
          return;
        } catch (falhaEstorno) {
          setErro(falhaEstorno.message);
          return;
        }
      }
      setErro(error.message);
    } finally {
      setProcessando('');
    }
  }

  const indicadores = resumo?.indicadores || {};

  const cards = [
    ['Total hoje', indicadores.total || 0, KeyRound, 'blue'],
    ['Em consulta', indicadores.em_consulta || 0, Search, 'purple'],
    ['Reprocessamento GM', indicadores.aguardando_reprocessamento_gm || 0, ShieldX, 'red'],
    ['Aguardando envio', indicadores.aguardando_envio_fornecedor || 0, Truck, 'orange'],
    ['Falhas de envio', indicadores.falhas_envio_fornecedor || 0, ShieldX, 'red'],
    ['Aguardando entrega', indicadores.aguardando_entrega_cliente || 0, Clock3, 'orange'],
    ['Falhas na entrega', indicadores.falhas_entrega_cliente || 0, ShieldX, 'red'],
    ['Aguardando pagamento', indicadores.aguardando_pagamento || 0, Clock3, 'orange'],
    ['Concluídos', indicadores.concluidos || 0, Database, 'green']
  ];

  return (
    <div className="orders-page">
      <section className="orders-heading">
        <div>
          <span>CENTRAL OPERACIONAL</span>
          <h2>Pedidos e senhas</h2>
          <p>Acompanhe consultas, fornecedores e resultados em tempo real.</p>
        </div>
        {podeCriar && <button
          type="button"
          onClick={() => setNovoPedido(true)}
          title="Criar novo pedido"
        >
          <Plus size={18} />
          Novo pedido
        </button>}
        <button
          type="button"
          onClick={() => setAtualizacao(valor => valor + 1)}
          title="Atualizar pedidos"
        >
          <RefreshCw size={18} />
          Atualizar
        </button>
      </section>

      {erro && <div className="orders-error">{erro}</div>}

      <section className="orders-metrics">
        {cards.map(([nome, valor, Icone, cor]) => (
          <article key={nome}>
            <span className={`metric-icon metric-${cor}`}><Icone size={20} /></span>
            <div><small>{nome}</small><strong>{valor}</strong></div>
          </article>
        ))}
      </section>

      <section className="orders-board">
        <div className="orders-toolbar">
          <label>
            <Search size={17} />
            <input
              type="search"
              value={busca}
              onChange={evento => setBusca(evento.target.value)}
              placeholder="Protocolo, cliente, chassi ou serviço"
            />
          </label>

          <select
            aria-label="Status do pedido"
            value={status}
            onChange={evento => setStatus(evento.target.value)}
          >
            <option value="">Todos os status</option>
            <option value="AGUARDANDO_REPROCESSAMENTO">
              Aguardando reprocessamento
            </option>
            {Object.entries(STATUS).map(([codigo, nome]) => (
              <option key={codigo} value={codigo}>{nome}</option>
            ))}
          </select>

          <span>{total} pedido(s)</span>
        </div>

        {carregando ? (
          <div className="orders-loading">
            <RefreshCw size={22} />
            Carregando pedidos...
          </div>
        ) : pedidos.length === 0 ? (
          <EstadoVazio />
        ) : (
          <div className="orders-table-wrap">
            <table className="orders-table">
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Cliente</th>
                  <th>Veículo</th>
                  <th>Serviço</th>
                  <th>Origem</th>
                  <th>Valor</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pedidos.map(pedido => (
                  <tr key={pedido.id} onClick={() => abrirPedido(pedido.id)}>
                    <td>
                      <strong>{pedido.protocolo}</strong>
                      <small>{dataHora(pedido.criado_em)}</small>
                    </td>
                    <td>{pedido.cliente}</td>
                    <td>
                      <strong>{[pedido.marca, pedido.modelo].filter(Boolean).join(' ') || 'Não informado'}</strong>
                      <small>{pedido.chassi || 'Sem identificação'}</small>
                    </td>
                    <td>{pedido.servico}</td>
                    <td>
                      {pedido.origem_codigo === 'FORNECEDOR' ? (
                        <span className="order-origin"><Truck size={14} />{pedido.fornecedor || pedido.origem}</span>
                      ) : (
                        <span className="order-origin"><Database size={14} />{nomeOrigem(pedido.origem, pedido.origem_codigo)}</span>
                      )}
                    </td>
                    <td>{dinheiro(pedido.valor_venda, pedido.moeda)}</td>
                    <td>
                      <span className={`order-status status-order-${pedido.status}`}>
                        {STATUS[pedido.status] || pedido.status}
                      </span>
                      {Number(pedido.aguardando_reprocessamento_gm) === 1 && (
                        <small className="communication-state communication-FALHOU">
                          Aguardando reprocessamento automático
                        </small>
                      )}
                      {pedido.comunicacao_fornecedor_status && (
                        <small className={`communication-state communication-${pedido.comunicacao_fornecedor_status}`}>
                          {STATUS_COMUNICACAO[pedido.comunicacao_fornecedor_status] ||
                            pedido.comunicacao_fornecedor_status}
                        </small>
                      )}
                      {pedido.entrega_cliente_status && (
                        <small className={`communication-state communication-${pedido.entrega_cliente_status}`}>
                          Cliente: {STATUS_COMUNICACAO[pedido.entrega_cliente_status] ||
                            pedido.entrega_cliente_status}
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {abrindo && (
        <div className="order-opening">
          <RefreshCw size={22} />
          Abrindo pedido...
        </div>
      )}

      {detalhe && (
        <DetalhePedido
          dados={detalhe}
          podeEditar={podeEditar}
          podeGerarCobrancaSicoob={podeGerarCobranca && sicoobDisponivel}
          aoFechar={() => setDetalhe(null)}
          aoConfirmarPagamento={setPagamento}
          aoGerarCobrancaSicoob={setCobrancaSicoob}
          aoRegistrarResultado={setResultado}
          aoValidarResultado={(pedido, modo) => setValidacao({ pedido, modo })}
          aoReprocessar={reprocessar}
          aoCorrigir={setCorrecao}
          aoCancelar={cancelar}
          aoReprocessarComunicacao={reprocessarComunicacao}
        />
      )}

        {pagamento && (
          <ConfirmarPagamento
            token={token}
            pedido={pagamento}
            aoFechar={() => setPagamento(null)}
            aoConfirmado={async () => {
              const pedidoId = pagamento.id;
              setPagamento(null);
              await abrirPedido(pedidoId);
              setAtualizacao(valor => valor + 1);
            }}
          />
        )}

      {cobrancaSicoob && (
        <CobrancaSicoob
          token={token}
          pedido={cobrancaSicoob}
          aoFechar={() => setCobrancaSicoob(null)}
        />
      )}

      {resultado && (
        <ResultadoPedido
          token={token}
          pedido={resultado}
          aoFechar={() => setResultado(null)}
          aoSalvo={async () => {
            const pedidoId = resultado.id;
            setResultado(null);
            await abrirPedido(pedidoId);
            setAtualizacao(valor => valor + 1);
          }}
        />
      )}

      {validacao && (
        <ValidarResultado
          token={token}
          pedido={validacao.pedido}
          modo={validacao.modo}
          aoFechar={() => setValidacao(null)}
          aoConcluido={async () => {
            const pedidoId = validacao.pedido.id;
            setValidacao(null);
            await abrirPedido(pedidoId);
            setAtualizacao(valor => valor + 1);
          }}
        />
      )}

      {correcao && (
        <CorrigirDadosPedido
          token={token}
          pedido={correcao}
          aoFechar={() => setCorrecao(null)}
          aoSalvo={async () => {
            const pedidoId = correcao.id;
            setCorrecao(null);
            await abrirPedido(pedidoId);
            setAtualizacao(valor => valor + 1);
          }}
        />
      )}

      {processando && (
        <div className="operation-overlay page-operation-overlay" role="status" aria-live="polite">
          <span className="operation-spinner" />
          <strong>{processando}</strong>
          <small>Aguarde a conclusão para evitar processamento duplicado.</small>
        </div>
      )}

      {novoPedido && (
        <NovoPedido
          token={token}
          aoFechar={() => setNovoPedido(false)}
          aoCriado={() => {
            setNovoPedido(false);
            setAtualizacao(valor => valor + 1);
          }}
        />
      )}
    </div>
  );
}
