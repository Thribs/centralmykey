/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  UserRound,
  UsersRound,
  X
} from 'lucide-react';
import {
  alterarModeloWhatsapp,
  alterarStatusUsuario,
  atualizarUsuario,
  buscarIntegracoes,
  buscarPermissoesUsuario,
  buscarResumoUsuarios,
  cadastrarModeloWhatsapp,
  cadastrarUsuario,
  listarConfiguracoesSeguras,
  listarModelosWhatsapp,
  listarPerfis,
  listarUsuarios,
  salvarConfiguracao,
  salvarPermissoesUsuario
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

function dataHora(valor) {
  if (!valor) return 'Nunca acessou';

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(valor));
}

function ModalUsuario({ registro, perfis, erro, salvando, fechar, salvar }) {
  const [form, setForm] = useState({
    nome: registro?.nome || '',
    email: registro?.email || '',
    telefone: registro?.telefone || '',
    login: registro?.login || '',
    senha: '',
    perfil_id: registro?.perfil_id || ''
  });

  function alterar(evento) {
    setForm(atual => ({
      ...atual,
      [evento.target.name]: evento.target.value
    }));
  }

  return (
    <div className="admin-overlay">
      <section className="admin-modal">
        <header>
          <div>
            <span>USUÁRIOS MYKEY</span>
            <h2>{registro ? 'Editar usuário' : 'Novo usuário'}</h2>
          </div>
          <button type="button" onClick={fechar}><X size={20} /></button>
        </header>

        <form onSubmit={evento => {
          evento.preventDefault();
          salvar(form);
        }}>
          {erro && <div className="admin-error">{erro}</div>}

          <div className="admin-form">
            <label className="wide">
              Nome
              <input name="nome" value={form.nome} onChange={alterar} required />
            </label>
            <label>
              Login
              <input name="login" value={form.login} onChange={alterar} required />
            </label>
            <label>
              Perfil
              <select
                name="perfil_id"
                value={form.perfil_id}
                onChange={alterar}
                required
              >
                <option value="">Selecione</option>
                {perfis.map(perfil => (
                  <option key={perfil.id} value={perfil.id}>{perfil.nome}</option>
                ))}
              </select>
            </label>
            <label>
              E-mail
              <input type="email" name="email" value={form.email} onChange={alterar} />
            </label>
            <label>
              Telefone
              <input name="telefone" value={form.telefone} onChange={alterar} />
            </label>
            {!registro && (
              <label className="wide">
                Senha provisória
                <input
                  type="password"
                  name="senha"
                  value={form.senha}
                  onChange={alterar}
                  minLength="8"
                  required
                />
              </label>
            )}
          </div>

          <footer>
            <button type="button" className="admin-cancel" onClick={fechar}>
              Cancelar
            </button>
            <button type="submit" className="admin-save" disabled={salvando}>
              {salvando ? 'Salvando...' : 'Salvar usuário'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function ModalPermissoes({ dados, erro, salvando, fechar, salvar }) {
  const [permissoes, setPermissoes] = useState(dados.permissoes || []);
  const campos = ['visualizar', 'criar', 'editar', 'excluir', 'aprovar'];

  function alterar(indice, campo) {
    setPermissoes(atuais => atuais.map((item, posicao) =>
      posicao === indice
        ? { ...item, [campo]: !item[campo] }
        : item
    ));
  }

  return (
    <div className="admin-overlay">
      <section className="admin-modal admin-permissions">
        <header>
          <div>
            <span>CONTROLE DE ACESSO</span>
            <h2>Permissões de {dados.usuario.nome}</h2>
          </div>
          <button type="button" onClick={fechar}><X size={20} /></button>
        </header>

        <div className="admin-modal-body">
          {erro && <div className="admin-error">{erro}</div>}
          <div className="permission-wrap">
            <table>
              <thead>
                <tr>
                  <th>Módulo</th>
                  <th>Ver</th>
                  <th>Criar</th>
                  <th>Editar</th>
                  <th>Excluir</th>
                  <th>Aprovar</th>
                </tr>
              </thead>
              <tbody>
                {permissoes.map((item, indice) => (
                  <tr key={item.modulo_id}>
                    <td><strong>{item.nome}</strong></td>
                    {campos.map(campo => (
                      <td key={campo}>
                        <input
                          type="checkbox"
                          checked={Boolean(item[campo])}
                          onChange={() => alterar(indice, campo)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <footer>
            <button type="button" className="admin-cancel" onClick={fechar}>
              Cancelar
            </button>
            <button
              type="button"
              className="admin-save"
              disabled={salvando}
              onClick={() => salvar(permissoes)}
            >
              <Save size={16} />
              {salvando ? 'Salvando...' : 'Salvar permissões'}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}

export function Usuarios() {
  const token = useMemo(() => tokenLocal(), []);
  const [usuarios, setUsuarios] = useState([]);
  const [perfis, setPerfis] = useState([]);
  const [resumo, setResumo] = useState({});
  const [busca, setBusca] = useState('');
  const [modal, setModal] = useState(null);
  const [permissoes, setPermissoes] = useState(null);
  const [erro, setErro] = useState('');
  const [erroModal, setErroModal] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');

    try {
      const [lista, listaPerfis, indicadores] = await Promise.all([
        listarUsuarios(token),
        listarPerfis(token),
        buscarResumoUsuarios(token)
      ]);

      setUsuarios(lista.dados || []);
      setPerfis(listaPerfis.dados || []);
      setResumo(indicadores.resumo || {});
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setCarregando(false);
    }
  }, [token]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const filtrados = usuarios.filter(usuario =>
    [usuario.nome, usuario.login, usuario.email, usuario.perfil]
      .some(valor => String(valor || '').toLowerCase().includes(
        busca.toLowerCase()
      ))
  );

  async function salvarUsuario(form) {
    setSalvando(true);
    setErroModal('');

    try {
      if (modal?.id) {
        await atualizarUsuario(token, modal.id, form);
      } else {
        await cadastrarUsuario(token, form);
      }

      setModal(null);
      await carregar();
    } catch (falha) {
      setErroModal(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  async function mudarStatus(usuario) {
    const novo = usuario.status === 'ATIVO' ? 'BLOQUEADO' : 'ATIVO';

    try {
      await alterarStatusUsuario(token, usuario.id, novo);
      await carregar();
    } catch (falha) {
      setErro(falha.message);
    }
  }

  async function abrirPermissoes(usuario) {
    setErro('');

    try {
      setPermissoes(await buscarPermissoesUsuario(token, usuario.id));
    } catch (falha) {
      setErro(falha.message);
    }
  }

  async function salvarPermissoes(lista) {
    setSalvando(true);
    setErroModal('');

    try {
      await salvarPermissoesUsuario(
        token,
        permissoes.usuario.id,
        lista
      );
      setPermissoes(null);
    } catch (falha) {
      setErroModal(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <span>CONTROLE DE ACESSO</span>
          <h1>Usuários</h1>
          <p>Equipe, perfis, status e permissões por módulo.</p>
        </div>
        <div>
          <button type="button" onClick={carregar}>
            <RefreshCw size={16} className={carregando ? 'rotating' : ''} />
            Atualizar
          </button>
          <button type="button" className="primary" onClick={() => setModal({})}>
            <Plus size={17} /> Novo usuário
          </button>
        </div>
      </div>

      <div className="admin-metrics">
        <article><UsersRound size={19} /><span>Total<strong>{Number(resumo.total || 0)}</strong></span></article>
        <article><CheckCircle2 size={19} /><span>Ativos<strong>{Number(resumo.ativos || 0)}</strong></span></article>
        <article><KeyRound size={19} /><span>Senha provisória<strong>{Number(resumo.senha_provisoria || 0)}</strong></span></article>
        <article><ShieldCheck size={19} /><span>Já acessaram<strong>{Number(resumo.ja_acessaram || 0)}</strong></span></article>
      </div>

      <div className="admin-panel">
        <div className="admin-search">
          <UserRound size={17} />
          <input
            value={busca}
            onChange={evento => setBusca(evento.target.value)}
            placeholder="Nome, login, e-mail ou perfil"
          />
        </div>

        {erro && <div className="admin-error">{erro}</div>}

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Usuário</th>
                <th>Login</th>
                <th>Perfil</th>
                <th>Último acesso</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtrados.map(usuario => (
                <tr key={usuario.id}>
                  <td><strong>{usuario.nome}</strong><span>{usuario.email || 'Sem e-mail'}</span></td>
                  <td>{usuario.login}</td>
                  <td><span className="admin-badge">{usuario.perfil}</span></td>
                  <td>{dataHora(usuario.ultimo_login)}</td>
                  <td><span className={`admin-status status-${usuario.status}`}>{usuario.status}</span></td>
                  <td>
                    <div className="admin-row-actions">
                      <button type="button" title="Editar" onClick={() => setModal(usuario)}>
                        <Pencil size={16} />
                      </button>
                      <button type="button" title="Permissões" onClick={() => abrirPermissoes(usuario)}>
                        <KeyRound size={16} />
                      </button>
                      <button type="button" title="Alterar status" onClick={() => mudarStatus(usuario)}>
                        {usuario.status === 'ATIVO' ? <Ban size={16} /> : <CheckCircle2 size={16} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <ModalUsuario
          registro={modal.id ? modal : null}
          perfis={perfis}
          erro={erroModal}
          salvando={salvando}
          fechar={() => {
            setModal(null);
            setErroModal('');
          }}
          salvar={salvarUsuario}
        />
      )}

      {permissoes && (
        <ModalPermissoes
          dados={permissoes}
          erro={erroModal}
          salvando={salvando}
          fechar={() => {
            setPermissoes(null);
            setErroModal('');
          }}
          salvar={salvarPermissoes}
        />
      )}
    </section>
  );
}

export function Integracoes() {
  const token = useMemo(() => tokenLocal(), []);
  const [integracoes, setIntegracoes] = useState([]);
  const [modelos, setModelos] = useState([]);
  const [resumo, setResumo] = useState({});
  const [erro, setErro] = useState('');
  const [novo, setNovo] = useState({
    nome: '',
    idioma: 'pt_BR',
    categoria: 'UTILIDADE'
  });
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setErro('');

    try {
      const [dadosIntegracoes, dadosModelos] = await Promise.all([
        buscarIntegracoes(token),
        listarModelosWhatsapp(token)
      ]);

      setIntegracoes(dadosIntegracoes.integracoes || []);
      setResumo(dadosIntegracoes.modelos_whatsapp || {});
      setModelos(dadosModelos.dados || []);
    } catch (falha) {
      setErro(falha.message);
    }
  }, [token]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function cadastrar(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');

    try {
      await cadastrarModeloWhatsapp(token, novo);
      setNovo({ nome: '', idioma: 'pt_BR', categoria: 'UTILIDADE' });
      await carregar();
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  async function alterar(modelo, status, ativo = false) {
    try {
      await alterarModeloWhatsapp(token, modelo.id, { status, ativo });
      await carregar();
    } catch (falha) {
      setErro(falha.message);
    }
  }

  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <span>CONEXÕES EXTERNAS</span>
          <h1>Integrações</h1>
          <p>WhatsApp, bancos, pagamentos e comércio eletrônico.</p>
        </div>
        <div><button type="button" onClick={carregar}><RefreshCw size={16} /> Atualizar</button></div>
      </div>

      {erro && <div className="admin-error">{erro}</div>}

      <div className="integration-grid">
        {integracoes.map(item => (
          <article key={item.codigo}>
            <span><Settings size={19} /></span>
            <div><small>{item.codigo}</small><strong>{item.nome}</strong></div>
            <i className={item.configurado ? 'connected' : 'pending'}>
              {item.configurado ? 'Configurado' : 'Pendente'}
            </i>
          </article>
        ))}
      </div>

      <div className="admin-panel integration-panel">
        <header>
          <div>
            <span>MODELOS WHATSAPP</span>
            <h2>Mensagens oficiais</h2>
          </div>
          <div className="integration-counts">
            <span>Total: <strong>{Number(resumo.total || 0)}</strong></span>
            <span>Aprovados: <strong>{Number(resumo.aprovados || 0)}</strong></span>
            <span>Ativos: <strong>{Number(resumo.ativos || 0)}</strong></span>
          </div>
        </header>

        <form className="integration-form" onSubmit={cadastrar}>
          <input
            value={novo.nome}
            onChange={e => setNovo({ ...novo, nome: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
            placeholder="nome_do_modelo"
            required
          />
          <select value={novo.idioma} onChange={e => setNovo({ ...novo, idioma: e.target.value })}>
            <option value="pt_BR">Português Brasil</option>
            <option value="es">Espanhol</option>
            <option value="en_US">Inglês</option>
          </select>
          <select value={novo.categoria} onChange={e => setNovo({ ...novo, categoria: e.target.value })}>
            <option value="UTILIDADE">Utilidade</option>
            <option value="MARKETING">Marketing</option>
            <option value="AUTENTICACAO">Autenticação</option>
          </select>
          <button type="submit" disabled={salvando}>
            <Plus size={16} /> Cadastrar
          </button>
        </form>

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Modelo</th><th>Idioma</th><th>Categoria</th><th>Status</th><th>Ativo</th><th>Ações</th></tr></thead>
            <tbody>
              {modelos.length === 0 && (
                <tr><td colSpan="6" className="admin-empty">Nenhum modelo cadastrado.</td></tr>
              )}
              {modelos.map(modelo => (
                <tr key={modelo.id}>
                  <td><strong>{modelo.nome}</strong></td>
                  <td>{modelo.idioma}</td>
                  <td>{modelo.categoria}</td>
                  <td><span className={`admin-status status-${modelo.status}`}>{modelo.status}</span></td>
                  <td>{modelo.ativo ? 'Sim' : 'Não'}</td>
                  <td>
                    <select
                      value={modelo.status}
                      onChange={e => alterar(modelo, e.target.value, modelo.ativo)}
                    >
                      <option value="PENDENTE">Pendente</option>
                      <option value="APROVADO">Aprovado</option>
                      <option value="REJEITADO">Rejeitado</option>
                      <option value="PAUSADO">Pausado</option>
                      <option value="DESATIVADO">Desativado</option>
                    </select>
                    {modelo.status === 'APROVADO' && (
                      <button type="button" onClick={() => alterar(modelo, 'APROVADO', !modelo.ativo)}>
                        {modelo.ativo ? 'Desativar' : 'Ativar'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function Configuracoes() {
  const token = useMemo(() => tokenLocal(), []);
  const [dados, setDados] = useState([]);
  const [busca, setBusca] = useState('');
  const [edicao, setEdicao] = useState(null);
  const [valor, setValor] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setErro('');

    try {
      const resposta = await listarConfiguracoesSeguras(token);
      setDados(resposta.dados || []);
    } catch (falha) {
      setErro(falha.message);
    }
  }, [token]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const filtrados = dados.filter(item =>
    [item.chave, item.descricao].some(conteudo =>
      String(conteudo || '').toLowerCase().includes(busca.toLowerCase())
    )
  );

  async function salvar(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');

    try {
      await salvarConfiguracao(token, edicao.chave, {
        valor,
        descricao: edicao.descricao
      });

      setEdicao(null);
      setValor('');
      await carregar();
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <span>ADMINISTRAÇÃO DO SISTEMA</span>
          <h1>Configurações</h1>
          <p>Parâmetros operacionais e credenciais protegidas.</p>
        </div>
        <div><button type="button" onClick={carregar}><RefreshCw size={16} /> Atualizar</button></div>
      </div>

      {erro && <div className="admin-error">{erro}</div>}

      <div className="admin-panel">
        <div className="admin-search">
          <Settings size={17} />
          <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar configuração" />
        </div>

        <div className="config-grid">
          {filtrados.map(item => (
            <article key={item.chave}>
              <div className="config-icon">
                {item.sensivel ? <KeyRound size={18} /> : <Settings size={18} />}
              </div>
              <div>
                <strong>{item.chave}</strong>
                <p>{item.descricao || 'Sem descrição'}</p>
                <span className={item.configurado ? 'configured' : 'not-configured'}>
                  {item.configurado ? item.valor : 'Não configurado'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEdicao(item);
                  setValor(item.sensivel ? '' : item.valor || '');
                }}
              >
                <Pencil size={15} /> Editar
              </button>
            </article>
          ))}
        </div>
      </div>

      {edicao && (
        <div className="admin-overlay">
          <section className="admin-modal config-modal">
            <header>
              <div><span>CONFIGURAÇÃO</span><h2>{edicao.chave}</h2></div>
              <button type="button" onClick={() => setEdicao(null)}><X size={20} /></button>
            </header>
            <form onSubmit={salvar}>
              <label>
                {edicao.sensivel ? 'Novo valor protegido' : 'Valor'}
                <textarea value={valor} onChange={e => setValor(e.target.value)} required={edicao.sensivel} />
              </label>
              {edicao.sensivel && (
                <small>O valor atual não é exibido por segurança.</small>
              )}
              <footer>
                <button type="button" className="admin-cancel" onClick={() => setEdicao(null)}>Cancelar</button>
                <button type="submit" className="admin-save" disabled={salvando}>
                  <Save size={16} /> {salvando ? 'Salvando...' : 'Salvar'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
