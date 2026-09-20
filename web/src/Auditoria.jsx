import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { buscarFiltrosAuditoria, listarAuditoria } from './api';

function tokenLocal() {
  return localStorage.getItem('central_mykey_token') || '';
}

function dataHora(valor) {
  if (!valor) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(valor));
}

export default function Auditoria() {
  const token = useMemo(() => tokenLocal(), []);
  const [registros, setRegistros] = useState([]);
  const [opcoes, setOpcoes] = useState({ modulos: [], usuarios: [] });
  const [filtros, setFiltros] = useState({
    busca: '',
    modulo: '',
    usuario_id: '',
    inicio: '',
    fim: ''
  });
  const [cursor, setCursor] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async (continuar = false) => {
    setCarregando(true);
    setErro('');
    try {
      const resposta = await listarAuditoria(token, {
        ...filtros,
        limite: 50,
        antes_de: continuar ? cursor : ''
      });
      setRegistros(atuais => continuar
        ? [...atuais, ...(resposta.dados || [])]
        : (resposta.dados || []));
      setCursor(resposta.proximo_cursor || null);
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setCarregando(false);
    }
  }, [token, filtros, cursor]);

  useEffect(() => {
    Promise.all([
      listarAuditoria(token, { limite: 50 }),
      buscarFiltrosAuditoria(token)
    ]).then(([lista, filtrosDisponiveis]) => {
      setRegistros(lista.dados || []);
      setCursor(lista.proximo_cursor || null);
      setOpcoes(filtrosDisponiveis);
    }).catch(falha => setErro(falha.message))
      .finally(() => setCarregando(false));
  }, [token]);

  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <span>RASTREABILIDADE</span>
          <h1>Auditoria</h1>
          <p>Ações administrativas e operacionais, sem conteúdo sensível.</p>
        </div>
        <div>
          <button type="button" onClick={() => carregar(false)}>
            <RefreshCw size={16} className={carregando ? 'rotating' : ''} />
            Atualizar
          </button>
        </div>
      </div>

      <div className="admin-panel">
        <div className="audit-filters">
          <label className="admin-search">
            <Search size={17} />
            <input
              value={filtros.busca}
              onChange={evento => setFiltros(atual => ({
                ...atual,
                busca: evento.target.value
              }))}
              placeholder="Descrição, ação, entidade ou usuário"
            />
          </label>
          <select
            value={filtros.modulo}
            onChange={evento => setFiltros(atual => ({
              ...atual,
              modulo: evento.target.value
            }))}
          >
            <option value="">Todos os módulos</option>
            {(opcoes.modulos || []).map(item => (
              <option key={item.modulo} value={item.modulo}>{item.modulo}</option>
            ))}
          </select>
          <select
            value={filtros.usuario_id}
            onChange={evento => setFiltros(atual => ({
              ...atual,
              usuario_id: evento.target.value
            }))}
          >
            <option value="">Todos os usuários</option>
            {(opcoes.usuarios || []).map(item => (
              <option key={item.id} value={item.id}>{item.nome}</option>
            ))}
          </select>
          <input
            type="date"
            value={filtros.inicio}
            onChange={evento => setFiltros(atual => ({
              ...atual,
              inicio: evento.target.value
            }))}
            aria-label="Data inicial"
          />
          <input
            type="date"
            value={filtros.fim}
            onChange={evento => setFiltros(atual => ({
              ...atual,
              fim: evento.target.value
            }))}
            aria-label="Data final"
          />
          <button type="button" onClick={() => carregar(false)}>Filtrar</button>
        </div>

        {erro && <div className="admin-error">{erro}</div>}

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Usuário</th>
                <th>Módulo</th>
                <th>Ação</th>
                <th>Entidade</th>
                <th>Descrição</th>
              </tr>
            </thead>
            <tbody>
              {!carregando && registros.length === 0 && (
                <tr><td colSpan="6" className="admin-empty">
                  Nenhum registro encontrado.
                </td></tr>
              )}
              {registros.map(item => (
                <tr key={item.id}>
                  <td>{dataHora(item.criado_em)}</td>
                  <td>
                    <strong>{item.usuario || 'Sistema'}</strong>
                    <span>{item.login || 'Ação automática'}</span>
                  </td>
                  <td><span className="admin-badge">{item.modulo}</span></td>
                  <td>{item.acao}</td>
                  <td>{item.entidade || '—'} {item.entidade_id ? `#${item.entidade_id}` : ''}</td>
                  <td>{item.descricao || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {cursor && (
          <div className="audit-more">
            <button type="button" disabled={carregando} onClick={() => carregar(true)}>
              <ShieldCheck size={16} />
              {carregando ? 'Carregando...' : 'Carregar mais registros'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
