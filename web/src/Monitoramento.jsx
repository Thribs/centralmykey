/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CircleCheck,
  Clock3,
  Plug,
  RefreshCw,
  Send
} from 'lucide-react';
import { buscarMonitoramentoOperacional } from './api';

function tokenLocal() {
  return localStorage.getItem('central_mykey_token') || '';
}

function dataHora(valor) {
  if (!valor) return 'Sem pendência';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(valor));
}

function Indicador({ titulo, valor, detalhe, Icone }) {
  return (
    <article>
      <span><Icone size={18} /></span>
      <div>
        <small>{titulo}</small>
        <strong>{Number(valor || 0)}</strong>
        {detalhe && <em>{detalhe}</em>}
      </div>
    </article>
  );
}

export default function Monitoramento() {
  const token = useMemo(() => tokenLocal(), []);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      setDados(await buscarMonitoramentoOperacional(token));
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setCarregando(false);
    }
  }, [token]);

  useEffect(() => {
    carregar();
    const intervalo = window.setInterval(carregar, 60000);
    return () => window.clearInterval(intervalo);
  }, [carregar]);

  const status = dados?.status || 'INDEFINIDO';
  const pedidos = dados?.pedidos || {};
  const comunicacoes = dados?.comunicacoes || {};
  const integracoes = dados?.integracoes || {};
  const notificacoes = dados?.notificacoes || {};

  return (
    <section className="monitor-page">
      <div className="monitor-heading">
        <div>
          <span>SAÚDE OPERACIONAL</span>
          <h1>Monitoramento</h1>
          <p>Filas, atrasos e falhas que exigem ação da equipe.</p>
        </div>
        <div className="monitor-actions">
          <span className={`monitor-status status-${status.toLowerCase()}`}>
            {status === 'OK' ? <CircleCheck size={16} /> : <AlertTriangle size={16} />}
            {status}
          </span>
          <button type="button" onClick={carregar} disabled={carregando}>
            <RefreshCw size={16} className={carregando ? 'rotating' : ''} />
            Atualizar
          </button>
        </div>
      </div>

      {erro && <div className="monitor-error">{erro}</div>}

      <div className="monitor-metrics">
        <Indicador
          titulo="Pedidos aguardando reprocessamento"
          valor={pedidos.aguardando_reprocessamento_gm}
          detalhe={`Limite: ${dados?.limites?.pedido_atraso_minutos || 0} min`}
          Icone={RefreshCw}
        />
        <Indicador
          titulo="Comunicações atrasadas"
          valor={Number(comunicacoes.pendentes_atrasadas || 0) + Number(comunicacoes.processando_atrasadas || 0)}
          detalhe={`Mais antiga: ${dataHora(comunicacoes.pendencia_mais_antiga_em)}`}
          Icone={Send}
        />
        <Indicador
          titulo="Falhas de comunicação"
          valor={Number(comunicacoes.falhas || 0) + Number(comunicacoes.incertas || 0)}
          detalhe={`${Number(comunicacoes.incertas || 0)} incerta(s)`}
          Icone={AlertTriangle}
        />
        <Indicador
          titulo="Eventos externos pendentes"
          valor={integracoes.recebidos_atrasados}
          detalhe={`${Number(integracoes.falhas || 0)} falha(s)`}
          Icone={Plug}
        />
      </div>

      <div className="monitor-grid">
        <section className="monitor-card">
          <header><Clock3 size={18} /><h2>Pedidos atrasados</h2></header>
          <dl>
            <div><dt>Aguardando pagamento</dt><dd>{Number(pedidos.aguardando_pagamento_atrasados || 0)}</dd></div>
            <div><dt>Aguardando dados</dt><dd>{Number(pedidos.aguardando_dados_atrasados || 0)}</dd></div>
            <div><dt>Em consulta</dt><dd>{Number(pedidos.em_consulta_atrasados || 0)}</dd></div>
            <div><dt>Pagos sem conclusão</dt><dd>{Number(pedidos.pagos_atrasados || 0)}</dd></div>
          </dl>
        </section>

        <section className="monitor-card">
          <header><Send size={18} /><h2>Comunicações</h2></header>
          <dl>
            <div><dt>Pendentes</dt><dd>{Number(comunicacoes.pendentes || 0)}</dd></div>
            <div><dt>Pendentes atrasadas</dt><dd>{Number(comunicacoes.pendentes_atrasadas || 0)}</dd></div>
            <div><dt>Processando atrasadas</dt><dd>{Number(comunicacoes.processando_atrasadas || 0)}</dd></div>
            <div><dt>Falhas/incertas</dt><dd>{Number(comunicacoes.falhas || 0) + Number(comunicacoes.incertas || 0)}</dd></div>
          </dl>
        </section>

        <section className="monitor-card">
          <header><Plug size={18} /><h2>Integrações</h2></header>
          <dl>
            <div><dt>Recebidos</dt><dd>{Number(integracoes.recebidos || 0)}</dd></div>
            <div><dt>Recebidos atrasados</dt><dd>{Number(integracoes.recebidos_atrasados || 0)}</dd></div>
            <div><dt>Falharam</dt><dd>{Number(integracoes.falhas || 0)}</dd></div>
            <div><dt>Pendência mais antiga</dt><dd>{dataHora(integracoes.pendencia_mais_antiga_em)}</dd></div>
          </dl>
        </section>

        <section className="monitor-card">
          <header><Activity size={18} /><h2>Alertas internos</h2></header>
          <dl>
            <div><dt>Ativos</dt><dd>{Number(notificacoes.ativas || 0)}</dd></div>
            <div><dt>Críticos</dt><dd>{Number(notificacoes.criticas || 0)}</dd></div>
            <div><dt>Atenção</dt><dd>{Number(notificacoes.atencoes || 0)}</dd></div>
            <div><dt>Verificado</dt><dd>{dataHora(dados?.verificado_em)}</dd></div>
          </dl>
        </section>
      </div>
    </section>
  );
}
