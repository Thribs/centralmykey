/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  CircleDollarSign,
  FileChartColumn,
  RefreshCw,
  TrendingUp,
  UsersRound
} from 'lucide-react';
import { buscarRelatorioOperacional } from './api';

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

function dinheiro(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Number(valor || 0));
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function trintaDiasAtras() {
  const data = new Date();
  data.setDate(data.getDate() - 30);
  return data.toISOString().slice(0, 10);
}

export default function Relatorios() {
  const token = useMemo(() => tokenLocal(), []);
  const [inicio, setInicio] = useState(trintaDiasAtras());
  const [fim, setFim] = useState(hoje());
  const [filtros, setFiltros] = useState({
    inicio: trintaDiasAtras(),
    fim: hoje()
  });
  const [dados, setDados] = useState({
    resumo: {},
    por_status: [],
    por_fornecedor: [],
    por_origem: [],
    por_dia: []
  });
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');

    try {
      setDados(await buscarRelatorioOperacional(token, filtros));
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setCarregando(false);
    }
  }, [token, filtros]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  function aplicar(evento) {
    evento.preventDefault();
    setFiltros({ inicio, fim });
  }

  const resumo = dados.resumo || {};
  const maximoDiario = Math.max(
    ...(dados.por_dia || []).map(item => Number(item.quantidade || 0)),
    1
  );

  return (
    <section className="report-page">
      <div className="report-heading">
        <div>
          <span>ANÁLISE OPERACIONAL</span>
          <h1>Relatórios</h1>
          <p>Resultados por período, fornecedor, origem e status.</p>
        </div>

        <form onSubmit={aplicar}>
          <label>
            <CalendarDays size={15} />
            <input type="date" value={inicio} onChange={e => setInicio(e.target.value)} />
          </label>
          <span>até</span>
          <label>
            <CalendarDays size={15} />
            <input type="date" value={fim} onChange={e => setFim(e.target.value)} />
          </label>
          <button type="submit">
            <RefreshCw size={15} className={carregando ? 'rotating' : ''} />
            Gerar
          </button>
        </form>
      </div>

      {erro && <div className="report-error">{erro}</div>}

      <div className="report-metrics">
        <article>
          <span><FileChartColumn size={18} /></span>
          <div><small>Total de pedidos</small><strong>
            {Number(resumo.total_pedidos || 0)}
          </strong></div>
        </article>
        <article>
          <span><TrendingUp size={18} /></span>
          <div><small>Concluídos</small><strong>
            {Number(resumo.concluidos || 0)}
          </strong></div>
        </article>
        <article>
          <span><CircleDollarSign size={18} /></span>
          <div><small>Valor de vendas</small><strong>
            {dinheiro(resumo.valor_vendas)}
          </strong></div>
        </article>
        <article>
          <span><CircleDollarSign size={18} /></span>
          <div><small>Resultado bruto</small><strong>
            {dinheiro(resumo.resultado_bruto)}
          </strong></div>
        </article>
        <article>
          <span><UsersRound size={18} /></span>
          <div><small>Clientes atendidos</small><strong>
            {Number(resumo.clientes_atendidos || 0)}
          </strong></div>
        </article>
      </div>

      <div className="report-grid">
        <section className="report-card report-daily">
          <header>
            <div>
              <span>EVOLUÇÃO</span>
              <h2>Pedidos por dia</h2>
            </div>
          </header>

          {(dados.por_dia || []).length === 0 ? (
            <p className="report-empty">Sem dados no período.</p>
          ) : (
            <div className="report-bars">
              {dados.por_dia.map(item => (
                <div key={item.data}>
                  <span>{item.data.slice(5).split('-').reverse().join('/')}</span>
                  <div>
                    <i style={{
                      width: `${Math.max(
                        (Number(item.quantidade) / maximoDiario) * 100,
                        3
                      )}%`
                    }} />
                  </div>
                  <strong>{item.quantidade}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="report-card">
          <header><div><span>OPERAÇÃO</span><h2>Por status</h2></div></header>
          <table>
            <thead><tr><th>Status</th><th>Pedidos</th><th>Vendas</th></tr></thead>
            <tbody>
              {(dados.por_status || []).map(item => (
                <tr key={item.status}>
                  <td>{item.status}</td>
                  <td>{item.quantidade}</td>
                  <td>{dinheiro(item.valor_vendas)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="report-card">
          <header><div><span>PARCEIROS</span><h2>Por fornecedor</h2></div></header>
          <table>
            <thead><tr><th>Fornecedor</th><th>Pedidos</th><th>Custo</th></tr></thead>
            <tbody>
              {(dados.por_fornecedor || []).map(item => (
                <tr key={item.fornecedor}>
                  <td>{item.fornecedor}</td>
                  <td>{item.quantidade}</td>
                  <td>{dinheiro(item.custo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="report-card">
          <header><div><span>FONTES</span><h2>Por origem</h2></div></header>
          <table>
            <thead><tr><th>Origem</th><th>Pedidos</th><th>Vendas</th></tr></thead>
            <tbody>
              {(dados.por_origem || []).map(item => (
                <tr key={item.origem}>
                  <td>{item.origem}</td>
                  <td>{item.quantidade}</td>
                  <td>{dinheiro(item.valor_vendas)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </section>
  );
}
