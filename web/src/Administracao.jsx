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
  definirAutoridadeIntegracao,
  estornarPagamentoPedido,
  listarConfiguracoesSeguras,
  listarAutoridadesIntegracoes,
  listarEventosIntegracao,
  listarMapeamentosIntegracoes,
  listarMapeamentosStatusIntegracoes,
  listarModelosWhatsapp,
  listarPerfis,
  listarUsuarios,
  salvarMapeamentoIntegracao,
  salvarMapeamentoStatusIntegracao,
  salvarConfiguracao,
  salvarPermissoesUsuario,
  alterarStatusMapeamentoIntegracao,
  sincronizarPedidoWBuy
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

function dinheiro(valor, moeda = 'BRL') {
  if (valor === null || valor === undefined) return '—';
  return Number(valor).toLocaleString('pt-BR', {
    style: 'currency',
    currency: moeda || 'BRL'
  });
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
      <section
        className="admin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="titulo-modal-usuario"
      >
        <header>
          <div>
            <span>USUÁRIOS MYKEY</span>
            <h2 id="titulo-modal-usuario">
              {registro ? 'Editar usuário' : 'Novo usuário'}
            </h2>
          </div>
          <button type="button" onClick={fechar} aria-label="Fechar formulário">
            <X size={20} />
          </button>
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
      <section
        className="admin-modal admin-permissions"
        role="dialog"
        aria-modal="true"
        aria-labelledby="titulo-modal-permissoes"
      >
        <header>
          <div>
            <span>CONTROLE DE ACESSO</span>
            <h2 id="titulo-modal-permissoes">
              Permissões de {dados.usuario.nome}
            </h2>
          </div>
          <button type="button" onClick={fechar} aria-label="Fechar permissões">
            <X size={20} />
          </button>
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
                          aria-label={`${campo} ${item.nome}`}
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

export function Usuarios({ permissoes: permissoesSessao = [] }) {
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
  const permissaoModulo = permissoesSessao.find(
    item => item.codigo === 'USUARIOS'
  ) || {};
  const podeCriar = Number(permissaoModulo.criar) === 1;
  const podeEditar = Number(permissaoModulo.editar) === 1;

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
    const verbo = novo === 'ATIVO' ? 'ativar' : 'bloquear';
    if (!window.confirm(`Confirma ${verbo} o usuário ${usuario.nome}?`)) return;

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
    if (!window.confirm(
      `Confirma substituir as permissões de ${permissoes.usuario.nome}?`
    )) return;
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
          {podeCriar && (
            <button type="button" className="primary" onClick={() => setModal({})}>
              <Plus size={17} /> Novo usuário
            </button>
          )}
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
                    {podeEditar && (
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
                    )}
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

export function Integracoes({ permissoes: permissoesSessao = [] }) {
  const token = useMemo(() => tokenLocal(), []);
  const [integracoes, setIntegracoes] = useState([]);
  const [modelos, setModelos] = useState([]);
  const [eventos, setEventos] = useState([]);
  const [mapeamentos, setMapeamentos] = useState([]);
  const [servicos, setServicos] = useState([]);
  const [autoridades, setAutoridades] = useState([]);
  const [opcoesAutoridade, setOpcoesAutoridade] = useState([]);
  const [statusMapeamentos, setStatusMapeamentos] = useState([]);
  const [opcoesStatus, setOpcoesStatus] = useState({ provedores: [], dominios: [], situacoes: [] });
  const [resumo, setResumo] = useState({});
  const [prontidaoWhatsapp, setProntidaoWhatsapp] = useState(null);
  const [filtrosEventos, setFiltrosEventos] = useState({
    provedor: '', status: ''
  });
  const [erro, setErro] = useState('');
  const [novo, setNovo] = useState({
    nome: '',
    idioma: 'pt_BR',
    categoria: 'UTILIDADE'
  });
  const [salvando, setSalvando] = useState(false);
  const [novoMapeamento, setNovoMapeamento] = useState({
    provedor: 'WBUY', produto_externo_id: '', sku: '', nome_externo: '', servico_id: ''
  });
  const [novoStatus, setNovoStatus] = useState({
    provedor: 'WBUY', dominio: 'PAGAMENTO', status_externo_id: '',
    status_externo_nome: '', situacao: 'PENDENTE'
  });
  const [pedidoWBuyId, setPedidoWBuyId] = useState('');
  const [resultadoWBuy, setResultadoWBuy] = useState('');
  const permissaoIntegracoes = permissoesSessao.find(
    item => item.codigo === 'INTEGRACOES'
  ) || {};
  const permissaoFinanceiro = permissoesSessao.find(
    item => item.codigo === 'FINANCEIRO'
  ) || {};
  const podeEditar = Number(permissaoIntegracoes.editar) === 1;
  const podeAprovarFinanceiro = Number(permissaoFinanceiro.aprovar) === 1;

  const carregar = useCallback(async () => {
    setErro('');

    try {
      const [dadosIntegracoes, dadosModelos, dadosEventos,
        dadosMapeamentos, dadosAutoridades, dadosStatus] = await Promise.all([
        buscarIntegracoes(token),
        listarModelosWhatsapp(token),
        listarEventosIntegracao(token, { ...filtrosEventos, limite: 30 }),
        listarMapeamentosIntegracoes(token),
        listarAutoridadesIntegracoes(token),
        listarMapeamentosStatusIntegracoes(token)
      ]);

      setIntegracoes(dadosIntegracoes.integracoes || []);
      setResumo(dadosIntegracoes.modelos_whatsapp || {});
      setProntidaoWhatsapp(dadosIntegracoes.prontidao_whatsapp || null);
      setModelos(dadosModelos.dados || []);
      setEventos(dadosEventos.dados || []);
      setMapeamentos(dadosMapeamentos.dados || []);
      setServicos(dadosMapeamentos.servicos || []);
      setAutoridades(dadosAutoridades.dados || []);
      setOpcoesAutoridade(dadosAutoridades.opcoes || []);
      setStatusMapeamentos(dadosStatus.dados || []);
      setOpcoesStatus({ provedores: dadosStatus.provedores || [],
        dominios: dadosStatus.dominios || [], situacoes: dadosStatus.situacoes || [] });
    } catch (falha) {
      setErro(falha.message);
    }
  }, [token, filtrosEventos]);

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
    if (!window.confirm(`Confirma a alteração do modelo ${modelo.nome}?`)) return;
    try {
      await alterarModeloWhatsapp(token, modelo.id, { status, ativo });
      await carregar();
    } catch (falha) {
      setErro(falha.message);
    }
  }

  async function salvarMapeamento(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');
    try {
      await salvarMapeamentoIntegracao(token, novoMapeamento);
      setNovoMapeamento({
        provedor: novoMapeamento.provedor,
        produto_externo_id: '', sku: '', nome_externo: '', servico_id: ''
      });
      await carregar();
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarMapeamento(item) {
    if (!window.confirm(
      `Confirma ${item.ativo ? 'desativar' : 'ativar'} este mapeamento?`
    )) return;
    try {
      await alterarStatusMapeamentoIntegracao(token, item.id, !item.ativo);
      await carregar();
    } catch (falha) {
      setErro(falha.message);
    }
  }

  async function alterarAutoridade(item, autoridade) {
    if (!autoridade || autoridade === item.autoridade) return;
    if (!window.confirm(
      `Confirma ${autoridade} como autoridade para ${item.dominio}?`
    )) return;
    setSalvando(true);
    setErro('');
    try {
      await definirAutoridadeIntegracao(token, item.dominio, autoridade);
      await carregar();
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  async function salvarStatus(evento) {
    evento.preventDefault();
    if (!window.confirm('Confirma este mapeamento de status externo?')) return;
    setSalvando(true); setErro('');
    try {
      await salvarMapeamentoStatusIntegracao(token, novoStatus);
      setNovoStatus({ ...novoStatus, status_externo_id: '', status_externo_nome: '' });
      await carregar();
    } catch (falha) { setErro(falha.message); } finally { setSalvando(false); }
  }

  async function sincronizarWBuy(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');
    setResultadoWBuy('');
    try {
      const resultado = await sincronizarPedidoWBuy(token, pedidoWBuyId.trim());
      const analise = resultado.analise || {};
      const resumo = `${Number(analise.produtos_mapeados || 0)} de ` +
        `${Number(analise.produtos_total || 0)} produtos mapeados`;
      setResultadoWBuy(resultado.idempotente
        ? `Pedido ${resultado.pedido_externo_id} já estava sincronizado · ${resumo}.`
        : `Pedido ${resultado.pedido_externo_id} recebido na fila · ${resumo}. ` +
          'Conversão aguarda regras comerciais.');
      setPedidoWBuyId('');
      await carregar();
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  async function registrarDevolucao(evento) {
    const meio = window.prompt(
      'Informe o meio usado na devolução:',
      evento.provedor === 'SICOOB' ? 'SICOOB' : 'PIX'
    )?.trim().toUpperCase();
    if (!meio) return;
    const referencia = window.prompt(
      'Informe a referência da devolução já realizada:'
    )?.trim();
    if (!referencia) return;
    const motivo = window.prompt(
      'Informe o motivo da devolução:',
      'Pagamento recebido após o cancelamento do pedido'
    )?.trim();
    if (!motivo) return;
    if (!window.confirm(
      `Confirma que ${dinheiro(evento.valor_pagamento, evento.moeda_pagamento)} ` +
      'já foi devolvido e deseja registrar o estorno?'
    )) return;

    setSalvando(true);
    setErro('');
    try {
      await estornarPagamentoPedido(token, evento.entidade_id, {
        meio_estorno: meio,
        referencia_externa: referencia,
        motivo_estorno: motivo
      });
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
            <i className={item.status === 'CONFIGURADO' ? 'connected' : 'pending'}>
              {{
                CONFIGURADO: 'Configurado',
                CONFIGURADO_DESABILITADO: 'Configurado · desabilitado',
                PARCIAL: 'Configuração parcial',
                CREDENCIAIS_SEM_CONECTOR: 'Credenciais · conector pendente',
                CONTRATO_NAO_IDENTIFICADO: 'Contrato não identificado',
                PENDENTE: 'Pendente'
              }[item.status] || 'Pendente'}
            </i>
          </article>
        ))}
      </div>

      {prontidaoWhatsapp && <div className="admin-panel whatsapp-readiness">
        <header>
          <div>
            <span>PRONTIDÃO WHATSAPP GM</span>
            <h2>{prontidaoWhatsapp.pronto_para_homologar
              ? 'Pronto para homologação controlada'
              : 'Homologação bloqueada'}</h2>
          </div>
          <strong>{prontidaoWhatsapp.worker_habilitado
            ? 'Worker habilitado' : 'Worker desabilitado'}</strong>
        </header>
        <div className="whatsapp-readiness-metrics">
          <span>Fornecedores GM <strong>{Number(
            prontidaoWhatsapp.fornecedores_gm?.destinatarios_validos || 0
          )}/{Number(prontidaoWhatsapp.fornecedores_gm?.total || 0)}</strong></span>
          <span>Fila pendente <strong>{Number(
            prontidaoWhatsapp.fila?.pendentes || 0
          )}</strong></span>
          <span>Falhas <strong>{Number(
            prontidaoWhatsapp.fila?.falhas || 0
          )}</strong></span>
          <span>Incertas <strong>{Number(
            prontidaoWhatsapp.fila?.incertas || 0
          )}</strong></span>
        </div>
        {prontidaoWhatsapp.bloqueios?.length > 0 && <ul>
          {prontidaoWhatsapp.bloqueios.map(codigo => <li key={codigo}>{({
            TRANSPORTE_WHATSAPP_INCOMPLETO: 'Credenciais de transporte incompletas',
            WEBHOOK_WHATSAPP_INCOMPLETO: 'Autenticação do webhook incompleta',
            MODELO_CONSULTA_FORNECEDOR_NAO_HOMOLOGADO:
              'Modelo de consulta ao fornecedor não está aprovado e ativo',
            MODELO_ENTREGA_CLIENTE_NAO_HOMOLOGADO:
              'Modelo de entrega ao cliente não está aprovado e ativo',
            FORNECEDOR_GM_NAO_CADASTRADO: 'Nenhum fornecedor GM ativo cadastrado',
            FORNECEDORES_GM_SEM_DESTINATARIO_VALIDO:
              'Há fornecedor GM sem destinatário válido',
            FILA_WHATSAPP_REQUER_REVISAO:
              'A fila contém envio em processamento ou com estado incerto'
          })[codigo] || codigo}</li>)}
        </ul>}
      </div>}

      <div className="admin-panel integration-panel">
        <header>
          <div>
            <span>TRANSIÇÃO WBUY · BLING · CENTRAL</span>
            <h2>Matriz de autoridade</h2>
          </div>
          <div className="integration-counts">
            <span>Definidos: <strong>{autoridades.filter(item =>
              item.autoridade).length}/{autoridades.length}</strong></span>
          </div>
        </header>
        <p className="integration-note">
          Registra qual sistema é a fonte de verdade de cada domínio. A matriz
          não ativa conversão automática de pedidos.
        </p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Domínio</th><th>Autoridade</th><th>Situação</th></tr></thead>
            <tbody>
              {autoridades.map(item => <tr key={item.dominio}>
                <td><strong>{item.dominio}</strong></td>
                <td>{podeEditar ? <select
                  aria-label={`Autoridade de ${item.dominio}`}
                  value={item.autoridade || ''}
                  disabled={salvando}
                  onChange={e => alterarAutoridade(item, e.target.value)}
                >
                  <option value="">Definir autoridade</option>
                  {opcoesAutoridade.map(opcao => <option key={opcao} value={opcao}>
                    {opcao}
                  </option>)}
                </select> : item.autoridade || 'PENDENTE'}</td>
                <td>{item.autoridade ? 'DEFINIDO' : 'PENDENTE'}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </div>

      <div className="admin-panel integration-panel">
        <header>
          <div>
            <span>COMÉRCIO ELETRÔNICO</span>
            <h2>Produtos WBuy/Bling → serviços MyKey</h2>
          </div>
          <div className="integration-counts">
            <span>Mapeados: <strong>{mapeamentos.length}</strong></span>
          </div>
        </header>
        {podeEditar && <form className="integration-form" onSubmit={sincronizarWBuy}>
          <input aria-label="ID do pedido WBuy" inputMode="numeric" pattern="[0-9]+"
            value={pedidoWBuyId} onChange={e => setPedidoWBuyId(e.target.value)}
            placeholder="ID do pedido WBuy" required />
          <button type="submit" disabled={salvando || !pedidoWBuyId.trim()}>
            <RefreshCw size={15} /> Sincronizar pedido WBuy
          </button>
          {resultadoWBuy && <span role="status">{resultadoWBuy}</span>}
        </form>}
        {podeEditar && <form className="integration-form" onSubmit={salvarMapeamento}>
          <select aria-label="Provedor do mapeamento" value={novoMapeamento.provedor}
            onChange={e => setNovoMapeamento({ ...novoMapeamento, provedor: e.target.value })}>
            <option value="WBUY">WBuy</option><option value="BLING">Bling</option>
          </select>
          <input value={novoMapeamento.produto_externo_id}
            onChange={e => setNovoMapeamento({ ...novoMapeamento, produto_externo_id: e.target.value })}
            placeholder="ID externo" />
          <input value={novoMapeamento.sku}
            onChange={e => setNovoMapeamento({ ...novoMapeamento, sku: e.target.value })}
            placeholder="SKU" />
          <input value={novoMapeamento.nome_externo}
            onChange={e => setNovoMapeamento({ ...novoMapeamento, nome_externo: e.target.value })}
            placeholder="Nome do produto" />
          <select aria-label="Serviço MyKey" value={novoMapeamento.servico_id}
            onChange={e => setNovoMapeamento({ ...novoMapeamento, servico_id: e.target.value })}
            required>
            <option value="">Serviço MyKey</option>
            {servicos.map(servico => <option key={servico.id} value={servico.id}>
              {servico.codigo} · {servico.nome}
            </option>)}
          </select>
          <button type="submit" disabled={salvando ||
            (!novoMapeamento.produto_externo_id.trim() && !novoMapeamento.sku.trim())}>
            <Plus size={15} /> Mapear
          </button>
        </form>}
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Origem</th><th>Produto/SKU</th><th>Serviço MyKey</th><th>Status</th><th>Ação</th></tr></thead>
            <tbody>
              {mapeamentos.length === 0 && <tr><td colSpan="5" className="admin-empty">
                Nenhum produto externo mapeado.
              </td></tr>}
              {mapeamentos.map(item => <tr key={item.id}>
                <td><strong>{item.provedor}</strong></td>
                <td>{item.nome_externo || item.produto_externo_id || item.sku}<small>
                  {[item.produto_externo_id, item.sku].filter(Boolean).join(' · ')}
                </small></td>
                <td>{item.servico_codigo} · {item.servico_nome}</td>
                <td>{item.ativo ? 'ATIVO' : 'INATIVO'}</td>
                <td>{podeEditar ? <button type="button" onClick={() => alternarMapeamento(item)}>
                  {item.ativo ? 'Desativar' : 'Ativar'}
                </button> : '—'}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </div>

      <div className="admin-panel integration-panel">
        <header><div><span>ESTADOS EXTERNOS</span><h2>Mapa de status</h2></div>
          <div className="integration-counts"><span>Mapeados: <strong>{statusMapeamentos.length}</strong></span></div>
        </header>
        {podeEditar && <form className="integration-form" onSubmit={salvarStatus}>
          <select aria-label="Provedor do status" value={novoStatus.provedor}
            onChange={e => setNovoStatus({ ...novoStatus, provedor: e.target.value })}>
            {opcoesStatus.provedores.map(item => <option key={item}>{item}</option>)}</select>
          <select aria-label="Domínio do status" value={novoStatus.dominio}
            onChange={e => setNovoStatus({ ...novoStatus, dominio: e.target.value })}>
            {opcoesStatus.dominios.map(item => <option key={item}>{item}</option>)}</select>
          <input aria-label="ID do status externo" value={novoStatus.status_externo_id}
            onChange={e => setNovoStatus({ ...novoStatus, status_externo_id: e.target.value })}
            placeholder="ID do status" required />
          <input aria-label="Nome do status externo" value={novoStatus.status_externo_nome}
            onChange={e => setNovoStatus({ ...novoStatus, status_externo_nome: e.target.value })}
            placeholder="Nome externo" />
          <select aria-label="Situação interna" value={novoStatus.situacao}
            onChange={e => setNovoStatus({ ...novoStatus, situacao: e.target.value })}>
            {opcoesStatus.situacoes.map(item => <option key={item}>{item}</option>)}</select>
          <button type="submit" disabled={salvando}>Mapear status</button>
        </form>}
        <div className="admin-table-wrap"><table className="admin-table">
          <thead><tr><th>Provedor</th><th>Domínio</th><th>Status externo</th><th>Situação</th></tr></thead>
          <tbody>{statusMapeamentos.length === 0 && <tr><td colSpan="4" className="admin-empty">Nenhum status mapeado.</td></tr>}
            {statusMapeamentos.map(item => <tr key={item.id}><td>{item.provedor}</td>
              <td>{item.dominio}</td><td>{item.status_externo_id}{item.status_externo_nome ? ` · ${item.status_externo_nome}` : ''}</td>
              <td>{item.situacao}</td></tr>)}</tbody>
        </table></div>
      </div>

      <div className="admin-panel integration-panel">
        <header>
          <div>
            <span>EVENTOS DE INTEGRAÇÃO</span>
            <h2>Recebimentos e processamento</h2>
          </div>
          <div className="integration-counts">
            <span>Últimos: <strong>{eventos.length}</strong></span>
          </div>
        </header>
        <div className="integration-form">
          <select aria-label="Filtrar provedor de eventos"
            value={filtrosEventos.provedor}
            onChange={e => setFiltrosEventos({
              ...filtrosEventos, provedor: e.target.value
            })}>
            <option value="">Todos os provedores</option>
            <option value="SICOOB">Sicoob</option>
            <option value="PLUGPAY">PlugPay</option>
            <option value="WBUY">WBuy</option>
            <option value="BLING">Bling</option>
          </select>
          <select aria-label="Filtrar status de eventos"
            value={filtrosEventos.status}
            onChange={e => setFiltrosEventos({
              ...filtrosEventos, status: e.target.value
            })}>
            <option value="">Todos os status</option>
            <option value="RECEBIDO">Recebido</option>
            <option value="PROCESSADO">Processado</option>
            <option value="IGNORADO">Ignorado</option>
            <option value="FALHOU">Falhou</option>
          </select>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Provedor</th><th>Evento</th><th>Referência</th><th>Entidade</th><th>Valor</th><th>Status</th><th>Tentativas</th><th>Falha</th><th>Recebido</th><th>Ação</th></tr></thead>
            <tbody>
              {eventos.length === 0 && (
                <tr><td colSpan="10" className="admin-empty">Nenhum evento encontrado.</td></tr>
              )}
              {eventos.map(evento => (
                <tr key={evento.id}>
                  <td><strong>{evento.provedor}</strong></td>
                  <td>{evento.tipo}</td>
                  <td>{evento.referencia_externa || '—'}</td>
                  <td>{evento.entidade
                    ? `${evento.entidade}${evento.entidade_id ? ` · ${evento.entidade_id}` : ''}`
                    : '—'}</td>
                  <td>{dinheiro(evento.valor_pagamento, evento.moeda_pagamento)}</td>
                  <td><span className={`admin-status status-${evento.status}`}>{evento.status}</span></td>
                  <td>{Number(evento.tentativas || 0)}</td>
                  <td>{evento.erro_codigo || '—'}</td>
                  <td>{dataHora(evento.recebido_em)}</td>
                  <td>
                    {podeAprovarFinanceiro &&
                      evento.erro_codigo === 'PAGAMENTO_APOS_CANCELAMENTO_REQUER_ESTORNO' &&
                      evento.pagamento_id && evento.entidade_id ? (
                        <button
                          type="button"
                          disabled={salvando}
                          onClick={() => registrarDevolucao(evento)}
                        >
                          Registrar devolução
                        </button>
                      ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

        {podeEditar && <form className="integration-form" onSubmit={cadastrar}>
          <input
            aria-label="Nome do modelo"
            value={novo.nome}
            onChange={e => setNovo({ ...novo, nome: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
            placeholder="nome_do_modelo"
            required
          />
          <select aria-label="Idioma do modelo" value={novo.idioma}
            onChange={e => setNovo({ ...novo, idioma: e.target.value })}>
            <option value="pt_BR">Português Brasil</option>
            <option value="es">Espanhol</option>
            <option value="en_US">Inglês</option>
          </select>
          <select aria-label="Categoria do modelo" value={novo.categoria}
            onChange={e => setNovo({ ...novo, categoria: e.target.value })}>
            <option value="UTILIDADE">Utilidade</option>
            <option value="MARKETING">Marketing</option>
            <option value="AUTENTICACAO">Autenticação</option>
          </select>
          <button type="submit" disabled={salvando}>
            <Plus size={16} /> Cadastrar
          </button>
        </form>}

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
                  <td>{podeEditar ? <>
                    <select
                      aria-label={`Status do modelo ${modelo.nome}`}
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
                  </> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function Configuracoes({ permissoes: permissoesSessao = [] }) {
  const token = useMemo(() => tokenLocal(), []);
  const [dados, setDados] = useState([]);
  const [busca, setBusca] = useState('');
  const [edicao, setEdicao] = useState(null);
  const [valor, setValor] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const permissaoModulo = permissoesSessao.find(
    item => item.codigo === 'CONFIGURACOES'
  ) || {};
  const podeEditar = Number(permissaoModulo.editar) === 1;

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
    if (!window.confirm(`Confirma a alteração de ${edicao.chave}?`)) return;
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
              {podeEditar && (
                <button
                  type="button"
                  onClick={() => {
                    setEdicao(item);
                    setValor(item.sensivel ? '' : item.valor || '');
                  }}
                >
                  <Pencil size={15} /> Editar
                </button>
              )}
            </article>
          ))}
        </div>
      </div>

      {edicao && (
        <div className="admin-overlay">
          <section
            className="admin-modal config-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="titulo-modal-configuracao"
          >
            <header>
              <div>
                <span>CONFIGURAÇÃO</span>
                <h2 id="titulo-modal-configuracao">{edicao.chave}</h2>
              </div>
              <button
                type="button"
                onClick={() => setEdicao(null)}
                aria-label="Fechar configuração"
              >
                <X size={20} />
              </button>
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
