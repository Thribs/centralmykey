/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CircleDollarSign,
  Clock3,
  FileText,
  HandCoins,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  Wallet,
  X
} from 'lucide-react';
import {
  buscarFatura,
  buscarFechamentoFornecedor,
  buscarResumoFinanceiro,
  confirmarPagamentoFatura,
  fecharFaturaCliente,
  fecharFechamentoFornecedor,
  gerarFechamentoFornecedor,
  listarFechamentosFornecedores,
  listarFaturas,
  listarFornecedoresFechamento,
  listarLancamentosFinanceiros,
  pagarFechamentoFornecedor
} from './api';

function tokenLocal() {
  const preferenciais = [
    'central_mykey_token',
    'centralMyKeyToken',
    'token',
    'authToken'
  ];

  for (const chave of preferenciais) {
    const valor = localStorage.getItem(chave);
    if (valor) return valor;
  }

  const encontrada = Object.keys(localStorage).find(chave =>
    chave.toLowerCase().includes('token')
  );

  return encontrada ? localStorage.getItem(encontrada) : '';
}

function dinheiro(valor, moeda = 'BRL') {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: moeda || 'BRL'
  }).format(Number(valor || 0));
}

function data(valor) {
  if (!valor) return '—';
  return new Intl.DateTimeFormat('pt-BR').format(
    new Date(`${String(valor).slice(0, 10)}T12:00:00`)
  );
}

function porMoeda(lista, moeda = 'BRL') {
  return lista.find(item => item.moeda === moeda) || {};
}

function ultimaSemanaConcluida(moeda = 'BRL') {
  const hoje = new Date();
  hoje.setHours(12, 0, 0, 0);
  const deslocamento = hoje.getDay() === 0 ? -6 : 1 - hoje.getDay();
  const inicio = new Date(hoje);
  inicio.setDate(hoje.getDate() + deslocamento - 7);
  const fim = new Date(inicio);
  fim.setDate(inicio.getDate() + 6);
  const iso = valor => [
    valor.getFullYear(),
    String(valor.getMonth() + 1).padStart(2, '0'),
    String(valor.getDate()).padStart(2, '0')
  ].join('-');
  return { periodo_inicio: iso(inicio), periodo_fim: iso(fim), moeda };
}

function DetalheFatura({ dados, aoFechar }) {
  const fatura = dados.fatura || {};
  const itens = dados.itens || dados.pedidos || [];

  return (
    <div className="finance-overlay">
      <aside
        className="finance-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`titulo-fatura-${fatura.id}`}
      >
        <header>
          <div>
            <span>DETALHES DA FATURA</span>
            <h2 id={`titulo-fatura-${fatura.id}`}>Fatura #{fatura.id}</h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar detalhes">
            <X size={20} />
          </button>
        </header>

        <div className="finance-detail-body">
          <section className="finance-detail-card">
            <div><span>Cliente</span><strong>{fatura.cliente}</strong></div>
            <div><span>Status</span><strong>{fatura.status}</strong></div>
            <div>
              <span>Período</span>
              <strong>{data(fatura.periodo_inicio)} até {data(fatura.periodo_fim)}</strong>
            </div>
            <div><span>Vencimento</span><strong>{data(fatura.vencimento)}</strong></div>
            <div>
              <span>Valor</span>
              <strong>{dinheiro(fatura.valor_total, fatura.moeda)}</strong>
            </div>
          </section>

          <h3>Pedidos incluídos</h3>

          {itens.length === 0 ? (
            <p className="finance-empty">Nenhum item encontrado.</p>
          ) : (
            <div className="finance-items">
              {itens.map((item, indice) => (
                <article key={item.id || indice}>
                  <div>
                    <strong>{item.protocolo || `Pedido #${item.pedido_senha_id}`}</strong>
                    <span>{item.servico || item.descricao || 'Serviço MyKey'}</span>
                  </div>
                  <strong>{dinheiro(item.valor, fatura.moeda)}</strong>
                </article>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function DetalheFechamentoFornecedor({ dados, aoFechar }) {
  const fechamento = dados.fechamento || {};
  const itens = dados.itens || [];
  return (
    <div className="finance-overlay">
      <aside
        className="finance-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`titulo-fechamento-${fechamento.id}`}
      >
        <header>
          <div>
            <span>FECHAMENTO DO FORNECEDOR</span>
            <h2 id={`titulo-fechamento-${fechamento.id}`}>
              Fechamento #{fechamento.id}
            </h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar detalhes">
            <X size={20} />
          </button>
        </header>
        <div className="finance-detail-body">
          <section className="finance-detail-card">
            <div><span>Fornecedor</span><strong>{fechamento.fornecedor}</strong></div>
            <div><span>Status</span><strong>{fechamento.status}</strong></div>
            <div>
              <span>Período</span>
              <strong>{data(fechamento.periodo_inicio)} até {data(fechamento.periodo_fim)}</strong>
            </div>
            <div><span>Resultados</span><strong>{Number(fechamento.quantidade_itens || 0)}</strong></div>
            <div><span>Valor</span><strong>{dinheiro(fechamento.valor_total, fechamento.moeda)}</strong></div>
          </section>
          <h3>Resultados incluídos</h3>
          {itens.length === 0 ? (
            <p className="finance-empty">Nenhum resultado encontrado.</p>
          ) : (
            <div className="finance-items">
              {itens.map(item => (
                <article key={item.id}>
                  <div>
                    <strong>{item.protocolo}</strong>
                    <span>Resultado #{item.resultado_id}</span>
                  </div>
                  <strong>{dinheiro(item.custo, fechamento.moeda)}</strong>
                </article>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

export default function Financeiro({ permissoes = [] }) {
  const token = useMemo(() => tokenLocal(), []);
  const permissao = permissoes.find(item => item.codigo === 'FINANCEIRO') || {};
  const podeEditar = Number(permissao.editar) === 1;
  const podeAprovar = Number(permissao.aprovar) === 1;
  const [resumo, setResumo] = useState({
    lancamentos: [],
    faturas: [],
    pagamentos_hoje: []
  });
  const [faturas, setFaturas] = useState([]);
  const [lancamentos, setLancamentos] = useState([]);
  const [fechamentos, setFechamentos] = useState([]);
  const [fornecedores, setFornecedores] = useState([]);
  const [fornecedorId, setFornecedorId] = useState('');
  const [aba, setAba] = useState('faturas');
  const [busca, setBusca] = useState('');
  const [tipo, setTipo] = useState('');
  const [status, setStatus] = useState('');
  const [moeda, setMoeda] = useState('BRL');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [detalhe, setDetalhe] = useState(null);
  const [detalheFornecedor, setDetalheFornecedor] = useState(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');

    try {
      const [
        indicadores,
        listaFaturas,
        listaLancamentos,
        listaFechamentos,
        listaFornecedores
      ] =
        await Promise.all([
          buscarResumoFinanceiro(token),
          listarFaturas(token, {
            status: aba === 'faturas' ? status : '',
            moeda
          }),
          listarLancamentosFinanceiros(token, {
            busca,
            tipo,
            status: aba === 'lancamentos' ? status : '',
            moeda
          }),
          listarFechamentosFornecedores(token, {
            status: aba === 'fornecedores' ? status : '',
            fornecedorId: aba === 'fornecedores' ? fornecedorId : '',
            moeda
          }),
          listarFornecedoresFechamento(token)
        ]);

      setResumo(indicadores);
      setFaturas(listaFaturas.dados || []);
      setLancamentos(listaLancamentos.dados || []);
      setFechamentos(listaFechamentos.dados || []);
      setFornecedores(listaFornecedores.dados || []);
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setCarregando(false);
    }
  }, [token, busca, tipo, status, aba, fornecedorId, moeda]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function abrirFatura(id) {
    setErro('');

    try {
      setDetalhe(await buscarFatura(token, id));
    } catch (falha) {
      setErro(falha.message);
    }
  }

  async function abrirFechamento(id) {
    setErro('');
    try {
      setDetalheFornecedor(await buscarFechamentoFornecedor(token, id));
    } catch (falha) {
      setErro(falha.message);
    }
  }

  async function fecharFatura(item) {
    if (!window.confirm(
      `Fechar a fatura #${item.id} e consolidar seus pedidos?`
    )) return;
    setCarregando(true);
    setErro('');
    try {
      await fecharFaturaCliente(token, item.id);
      await carregar();
    } catch (falha) {
      setErro(falha.message);
      setCarregando(false);
    }
  }

  async function pagarFatura(item) {
    const referencia = window.prompt(
      `Informe a referência do pagamento da fatura #${item.id}:`
    );
    if (!referencia?.trim()) return;
    if (!window.confirm('Confirma que o pagamento da fatura foi recebido?')) return;
    setCarregando(true);
    setErro('');
    try {
      await confirmarPagamentoFatura(token, item.id, {
        meio_pagamento: 'PIX',
        referencia_externa: referencia.trim()
      });
      await carregar();
    } catch (falha) {
      setErro(falha.message);
      setCarregando(false);
    }
  }

  async function gerarFechamento() {
    if (!fornecedorId) {
      setErro('Selecione um fornecedor para gerar o fechamento.');
      return;
    }
    const periodo = ultimaSemanaConcluida(moeda);
    if (!window.confirm(
      `Gerar o fechamento de ${data(periodo.periodo_inicio)} até ${data(periodo.periodo_fim)}?`
    )) return;
    setCarregando(true);
    setErro('');
    try {
      await gerarFechamentoFornecedor(token, fornecedorId, periodo);
      await carregar();
    } catch (falha) {
      setErro(falha.message);
      setCarregando(false);
    }
  }

  async function aprovarFechamento(item) {
    if (!window.confirm(`Aprovar o fechamento #${item.id}?`)) return;
    setCarregando(true);
    setErro('');
    try {
      await fecharFechamentoFornecedor(token, item.id);
      await carregar();
    } catch (falha) {
      setErro(falha.message);
      setCarregando(false);
    }
  }

  async function pagarFechamento(item) {
    const referencia = window.prompt(
      `Informe a referência do pagamento do fechamento #${item.id}:`
    );
    if (!referencia?.trim()) return;
    if (!window.confirm('Confirma que o pagamento ao fornecedor foi realizado?')) return;
    setCarregando(true);
    setErro('');
    try {
      await pagarFechamentoFornecedor(token, item.id, {
        meio_pagamento: 'PIX',
        referencia_externa: referencia.trim()
      });
      await carregar();
    } catch (falha) {
      setErro(falha.message);
      setCarregando(false);
    }
  }

  const lancamentosMoeda = porMoeda(resumo.lancamentos || [], moeda);
  const faturasMoeda = porMoeda(resumo.faturas || [], moeda);
  const hojeMoeda = porMoeda(resumo.pagamentos_hoje || [], moeda);

  return (
    <section className="finance-page">
      <div className="finance-heading">
        <div>
          <span>CENTRAL FINANCEIRA</span>
          <h1>Financeiro</h1>
          <p>Receitas, despesas, cobranças e faturas da operação.</p>
        </div>
        <button type="button" onClick={carregar}>
          <RefreshCw size={16} className={carregando ? 'rotating' : ''} />
          Atualizar
        </button>
      </div>

      <div className="finance-metrics">
        <article>
          <span><TrendingUp size={18} /></span>
          <div><small>Receitas realizadas</small><strong>
            {dinheiro(lancamentosMoeda.receitas_realizadas, moeda)}
          </strong></div>
        </article>
        <article>
          <span><TrendingDown size={18} /></span>
          <div><small>Despesas realizadas</small><strong>
            {dinheiro(lancamentosMoeda.despesas_realizadas, moeda)}
          </strong></div>
        </article>
        <article>
          <span><Clock3 size={18} /></span>
          <div><small>Contas a receber</small><strong>
            {dinheiro(lancamentosMoeda.contas_receber, moeda)}
          </strong></div>
        </article>
        <article>
          <span><CircleDollarSign size={18} /></span>
          <div><small>Recebido hoje</small><strong>
            {dinheiro(hojeMoeda.valor, moeda)}
          </strong></div>
        </article>
      </div>

      <div className="finance-secondary-metrics">
        <span>
          Faturas abertas: <strong>{Number(faturasMoeda.abertas || 0)}</strong>
        </span>
        <span>
          Fechadas: <strong>{Number(faturasMoeda.fechadas || 0)}</strong>
        </span>
        <span>
          Pagas: <strong>{Number(faturasMoeda.pagas || 0)}</strong>
        </span>
        <span>
          Vencidas: <strong>{Number(faturasMoeda.vencidas || 0)}</strong>
        </span>
        <span>
          Valor em aberto: <strong>{dinheiro(faturasMoeda.valor_em_aberto, moeda)}</strong>
        </span>
      </div>

      <div className="finance-panel">
        <div className="finance-tabs">
          <button
            type="button"
            className={aba === 'faturas' ? 'active' : ''}
            onClick={() => {
              setAba('faturas');
              setStatus('');
            }}
          >
            <FileText size={16} /> Faturas
          </button>
          <button
            type="button"
            className={aba === 'lancamentos' ? 'active' : ''}
            onClick={() => {
              setAba('lancamentos');
              setStatus('');
            }}
          >
            <Wallet size={16} /> Lançamentos
          </button>
          <button
            type="button"
            className={aba === 'fornecedores' ? 'active' : ''}
            onClick={() => {
              setAba('fornecedores');
              setStatus('');
            }}
          >
            <HandCoins size={16} /> Fornecedores
          </button>
        </div>

        <div className="finance-filters">
          <select
            aria-label="Moeda"
            value={moeda}
            onChange={evento => setMoeda(evento.target.value)}
          >
            <option value="BRL">BRL</option>
            <option value="USD">USD</option>
            <option value="PYG">PYG</option>
          </select>
          {aba === 'lancamentos' && (
            <>
              <div>
                <Search size={17} />
                <input
                  value={busca}
                  onChange={evento => setBusca(evento.target.value)}
                  placeholder="Descrição, cliente, fornecedor ou protocolo"
                />
              </div>
              <select value={tipo} onChange={evento => setTipo(evento.target.value)}>
                <option value="">Receitas e despesas</option>
                <option value="RECEITA">Receitas</option>
                <option value="DESPESA">Despesas</option>
              </select>
            </>
          )}

          {aba === 'fornecedores' && (
            <>
              <select
                aria-label="Fornecedor"
                value={fornecedorId}
                onChange={evento => setFornecedorId(evento.target.value)}
              >
                <option value="">Todos os fornecedores</option>
                {fornecedores.map(item => (
                  <option key={item.id} value={item.id}>{item.nome}</option>
                ))}
              </select>
              {podeEditar && <button type="button" onClick={gerarFechamento}>
                Gerar última semana
              </button>}
            </>
          )}

          <select
            aria-label="Status"
            value={status}
            onChange={evento => setStatus(evento.target.value)}
          >
            <option value="">Todos os status</option>
            {aba === 'faturas' ? (
              <>
                <option value="ABERTA">Aberta</option>
                <option value="FECHADA">Fechada</option>
                <option value="PAGA">Paga</option>
                <option value="VENCIDA">Vencida</option>
                <option value="CANCELADA">Cancelada</option>
              </>
            ) : aba === 'fornecedores' ? (
              <>
                <option value="RASCUNHO">Rascunho</option>
                <option value="FECHADO">Fechado</option>
                <option value="PAGO">Pago</option>
                <option value="CANCELADO">Cancelado</option>
              </>
            ) : (
              <>
                <option value="PREVISTO">Previsto</option>
                <option value="PENDENTE">Pendente</option>
                <option value="PAGO">Pago</option>
                <option value="RECEBIDO">Recebido</option>
                <option value="VENCIDO">Vencido</option>
                <option value="CANCELADO">Cancelado</option>
              </>
            )}
          </select>
        </div>

        {erro && <div className="finance-error">{erro}</div>}

        <div className="finance-table-wrap">
          {aba === 'faturas' ? (
            <table className="finance-table">
              <thead>
                <tr>
                  <th>Fatura</th>
                  <th>Cliente</th>
                  <th>Período</th>
                  <th>Vencimento</th>
                  <th>Pedidos</th>
                  <th>Valor</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {!carregando && faturas.length === 0 && (
                  <tr><td colSpan="8" className="finance-empty">
                    Nenhuma fatura encontrada.
                  </td></tr>
                )}
                {faturas.map(fatura => (
                  <tr key={fatura.id} onClick={() => abrirFatura(fatura.id)}>
                    <td><strong>#{fatura.id}</strong></td>
                    <td>
                      <strong>{fatura.cliente}</strong>
                      <span>{fatura.telefone}</span>
                    </td>
                    <td>{data(fatura.periodo_inicio)}–{data(fatura.periodo_fim)}</td>
                    <td>{data(fatura.vencimento)}</td>
                    <td>{Number(fatura.quantidade_pedidos || 0)}</td>
                    <td><strong>{dinheiro(fatura.valor_total, fatura.moeda)}</strong></td>
                    <td>
                      <span className={`finance-status status-${fatura.status}`}>
                        {fatura.status}
                      </span>
                    </td>
                    <td>
                      {podeEditar &&
                        (fatura.status_registrado || fatura.status) === 'ABERTA' && (
                        <button type="button" disabled={carregando}
                          onClick={evento => {
                            evento.stopPropagation();
                            fecharFatura(fatura);
                          }}>
                          Fechar
                        </button>
                      )}
                      {podeAprovar && ['FECHADA', 'VENCIDA'].includes(
                        fatura.status_registrado || fatura.status
                      ) && (
                        <button type="button" disabled={carregando}
                          onClick={evento => {
                            evento.stopPropagation();
                            pagarFatura(fatura);
                          }}>
                          Registrar pagamento
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : aba === 'fornecedores' ? (
            <table className="finance-table">
              <thead>
                <tr>
                  <th>Fechamento</th>
                  <th>Fornecedor</th>
                  <th>Período</th>
                  <th>Resultados</th>
                  <th>Valor</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {!carregando && fechamentos.length === 0 && (
                  <tr><td colSpan="7" className="finance-empty">
                    Nenhum fechamento encontrado.
                  </td></tr>
                )}
                {fechamentos.map(item => (
                  <tr key={item.id} onClick={() => abrirFechamento(item.id)}>
                    <td><strong>#{item.id}</strong></td>
                    <td>{item.fornecedor}</td>
                    <td>{data(item.periodo_inicio)}–{data(item.periodo_fim)}</td>
                    <td>{Number(item.quantidade_itens || 0)}</td>
                    <td><strong>{dinheiro(item.valor_total, item.moeda)}</strong></td>
                    <td>
                      <span className={`finance-status status-${item.status}`}>
                        {item.status}
                      </span>
                    </td>
                    <td>
                      {podeAprovar && item.status === 'RASCUNHO' && (
                        <button
                          type="button"
                          onClick={evento => {
                            evento.stopPropagation();
                            aprovarFechamento(item);
                          }}
                        >
                          Aprovar
                        </button>
                      )}
                      {podeAprovar && item.status === 'FECHADO' && (
                        <button
                          type="button"
                          onClick={evento => {
                            evento.stopPropagation();
                            pagarFechamento(item);
                          }}
                        >
                          Registrar pagamento
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="finance-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Descrição</th>
                  <th>Cliente/fornecedor</th>
                  <th>Origem</th>
                  <th>Tipo</th>
                  <th>Valor</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {!carregando && lancamentos.length === 0 && (
                  <tr><td colSpan="7" className="finance-empty">
                    Nenhum lançamento encontrado.
                  </td></tr>
                )}
                {lancamentos.map(item => (
                  <tr key={item.id}>
                    <td>{data(item.data_competencia)}</td>
                    <td>
                      <strong>{item.descricao}</strong>
                      <span>{item.protocolo || item.categoria || '—'}</span>
                    </td>
                    <td>{item.cliente || item.fornecedor || '—'}</td>
                    <td>{item.origem || 'Manual'}</td>
                    <td>
                      <span className={`finance-type type-${item.tipo}`}>
                        {item.tipo}
                      </span>
                    </td>
                    <td><strong>{dinheiro(item.valor, item.moeda)}</strong></td>
                    <td>
                      <span className={`finance-status status-${item.status}`}>
                        {item.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {detalhe && (
        <DetalheFatura dados={detalhe} aoFechar={() => setDetalhe(null)} />
      )}
      {detalheFornecedor && (
        <DetalheFechamentoFornecedor
          dados={detalheFornecedor}
          aoFechar={() => setDetalheFornecedor(null)}
        />
      )}
    </section>
  );
}
