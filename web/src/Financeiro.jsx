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

function ultimaSemanaConcluida() {
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
  return { periodo_inicio: iso(inicio), periodo_fim: iso(fim), moeda: 'BRL' };
}

function DetalheFatura({ dados, aoFechar }) {
  const fatura = dados.fatura || {};
  const itens = dados.itens || dados.pedidos || [];

  return (
    <div className="finance-overlay">
      <aside className="finance-detail">
        <header>
          <div>
            <span>DETALHES DA FATURA</span>
            <h2>Fatura #{fatura.id}</h2>
          </div>
          <button type="button" onClick={aoFechar}>
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
      <aside className="finance-detail">
        <header>
          <div>
            <span>FECHAMENTO DO FORNECEDOR</span>
            <h2>Fechamento #{fechamento.id}</h2>
          </div>
          <button type="button" onClick={aoFechar}><X size={20} /></button>
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

export default function Financeiro() {
  const token = useMemo(() => tokenLocal(), []);
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
            status: aba === 'faturas' ? status : ''
          }),
          listarLancamentosFinanceiros(token, {
            busca,
            tipo,
            status: aba === 'lancamentos' ? status : ''
          }),
          listarFechamentosFornecedores(token, {
            status: aba === 'fornecedores' ? status : '',
            fornecedorId: aba === 'fornecedores' ? fornecedorId : ''
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
  }, [token, busca, tipo, status, aba, fornecedorId]);

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

  async function gerarFechamento() {
    if (!fornecedorId) {
      setErro('Selecione um fornecedor para gerar o fechamento.');
      return;
    }
    const periodo = ultimaSemanaConcluida();
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

  const brl = porMoeda(resumo.lancamentos || []);
  const faturasBrl = porMoeda(resumo.faturas || []);
  const hojeBrl = porMoeda(resumo.pagamentos_hoje || []);

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
            {dinheiro(brl.receitas_realizadas)}
          </strong></div>
        </article>
        <article>
          <span><TrendingDown size={18} /></span>
          <div><small>Despesas realizadas</small><strong>
            {dinheiro(brl.despesas_realizadas)}
          </strong></div>
        </article>
        <article>
          <span><Clock3 size={18} /></span>
          <div><small>Contas a receber</small><strong>
            {dinheiro(brl.contas_receber)}
          </strong></div>
        </article>
        <article>
          <span><CircleDollarSign size={18} /></span>
          <div><small>Recebido hoje</small><strong>
            {dinheiro(hojeBrl.valor)}
          </strong></div>
        </article>
      </div>

      <div className="finance-secondary-metrics">
        <span>
          Faturas abertas: <strong>{Number(faturasBrl.abertas || 0)}</strong>
        </span>
        <span>
          Fechadas: <strong>{Number(faturasBrl.fechadas || 0)}</strong>
        </span>
        <span>
          Pagas: <strong>{Number(faturasBrl.pagas || 0)}</strong>
        </span>
        <span>
          Vencidas: <strong>{Number(faturasBrl.vencidas || 0)}</strong>
        </span>
        <span>
          Valor em aberto: <strong>{dinheiro(faturasBrl.valor_em_aberto)}</strong>
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
                value={fornecedorId}
                onChange={evento => setFornecedorId(evento.target.value)}
              >
                <option value="">Todos os fornecedores</option>
                {fornecedores.map(item => (
                  <option key={item.id} value={item.id}>{item.nome}</option>
                ))}
              </select>
              <button type="button" onClick={gerarFechamento}>
                Gerar última semana
              </button>
            </>
          )}

          <select value={status} onChange={evento => setStatus(evento.target.value)}>
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
                </tr>
              </thead>
              <tbody>
                {!carregando && faturas.length === 0 && (
                  <tr><td colSpan="7" className="finance-empty">
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
                      {item.status === 'RASCUNHO' && (
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
                      {item.status === 'FECHADO' && (
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
