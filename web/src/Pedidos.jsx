import { useEffect, useState } from 'react';
import {
  CarFront,
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
  X
} from 'lucide-react';
import {
  buscarPedido,
  buscarResumoPedidos,
  listarFilaPedidos,
} from './api';
import NovoPedido from './NovoPedido';
import ConfirmarPagamento from './ConfirmarPagamento';

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

function DetalhePedido({ dados, aoFechar, aoConfirmar }) {
  const pedido = dados.pedido;
  const resultados = dados.resultados || [];
  const historico = dados.historico || [];

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
              {pedido.status === 'AGUARDANDO_PAGAMENTO' && (
                <button
                  type="button"
                  className="order-payment-button"
                  onClick={() => aoConfirmar(pedido)}
                >
                  <CircleDollarSign size={17} />
                  Confirmar pagamento
                </button>
              )}
          </div>

          <section className="order-detail-section">
            <h3><UserRound size={17} /> Cliente e serviço</h3>
            <div className="order-info-grid">
              <div><span>Cliente</span><strong>{pedido.cliente}</strong></div>
              <div><span>Serviço</span><strong>{pedido.servico}</strong></div>
              <div><span>Atendente</span><strong>{pedido.atendente || 'Não informado'}</strong></div>
              <div><span>Origem</span><strong>{pedido.origem || 'Não definida'}</strong></div>
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
                      <strong>{resultado.origem || 'Resultado'}</strong>
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
                      {resultado.resultado && (
                        <><dt>Resultado</dt><dd>{resultado.resultado}</dd></>
                      )}
                    </dl>
                  </article>
                ))}
              </div>
            )}
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

export default function Pedidos() {
  const token = localStorage.getItem('central_mykey_token');
  const [resumo, setResumo] = useState(null);
  const [pedidos, setPedidos] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [detalhe, setDetalhe] = useState(null);
  const [pagamento, setPagamento] = useState(null);
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

  const indicadores = resumo?.indicadores || {};

  const cards = [
    ['Total hoje', indicadores.total || 0, KeyRound, 'blue'],
    ['Em consulta', indicadores.em_consulta || 0, Search, 'purple'],
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
        <button
          type="button"
          onClick={() => setNovoPedido(true)}
          title="Criar novo pedido"
        >
          <Plus size={18} />
          Novo pedido
        </button>
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
            value={status}
            onChange={evento => setStatus(evento.target.value)}
          >
            <option value="">Todos os status</option>
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
                        <span className="order-origin"><Database size={14} />{pedido.origem || 'Não definida'}</span>
                      )}
                    </td>
                    <td>{dinheiro(pedido.valor_venda, pedido.moeda)}</td>
                    <td>
                      <span className={`order-status status-order-${pedido.status}`}>
                        {STATUS[pedido.status] || pedido.status}
                      </span>
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
          aoFechar={() => setDetalhe(null)}
            aoConfirmar={setPagamento}
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
