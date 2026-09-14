/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Truck,
  UsersRound,
  X
} from 'lucide-react';
import {
  alterarStatusCliente,
  alterarStatusFornecedor,
  atualizarCliente,
  atualizarFornecedor,
  buscarResumoClientes,
  buscarResumoFornecedores,
  cadastrarCliente,
  cadastrarFornecedor,
  listarClientes,
  listarFornecedores
} from './api';

const CLIENTE_INICIAL = {
  nome: '',
  telefone: '',
  cpf: '',
  cnpj: '',
  email: '',
  cidade: '',
  cadastro_status: 'PROVISORIO',
  tipo_cobranca: 'ANTECIPADO',
  dia_fechamento: '',
  prazo_pagamento_dias: '0',
  limite_credito: '',
  credito_status: 'LIBERADO',
  credito_observacao: '',
  vip: false,
  valor_mensalidade: '90',
  proximo_vencimento: ''
};

const FORNECEDOR_INICIAL = {
  nome: '',
  contato: '',
  telefone: '',
  whatsapp: '',
  email: '',
  tipo: 'PESSOA',
  horario_inicio: '',
  horario_fim: '',
  observacoes: ''
};

function obterToken() {
  const chaves = Object.keys(localStorage);
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

  const encontrada = chaves.find(chave =>
    chave.toLowerCase().includes('token')
  );

  return encontrada ? localStorage.getItem(encontrada) : '';
}

function ModalCadastro({
  tipo,
  registro,
  salvando,
  erro,
  aoFechar,
  aoSalvar
}) {
  const cliente = tipo === 'cliente';
  const inicial = cliente ? CLIENTE_INICIAL : FORNECEDOR_INICIAL;
  const [formulario, setFormulario] = useState(
    registro ? { ...inicial, ...registro } : inicial
  );

  function alterar(evento) {
    const { name, value, type, checked } = evento.target;
    setFormulario(atual => ({
      ...atual,
      [name]: type === 'checkbox' ? checked : value
    }));
  }

  function enviar(evento) {
    evento.preventDefault();
    aoSalvar(formulario);
  }

  return (
    <div className="registry-overlay">
      <section className="registry-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <span>CADASTROS MYKEY</span>
            <h2>
              {registro ? 'Editar' : 'Cadastrar'}{' '}
              {cliente ? 'cliente' : 'fornecedor'}
            </h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar">
            <X size={20} />
          </button>
        </header>

        <form onSubmit={enviar}>
          {erro && <div className="registry-error">{erro}</div>}

          <div className="registry-form">
            <label className="wide">
              Nome
              <input
                name="nome"
                value={formulario.nome || ''}
                onChange={alterar}
                required
              />
            </label>

            {cliente ? (
              <>
                <label>
                  Telefone
                  <input
                    name="telefone"
                    value={formulario.telefone || ''}
                    onChange={alterar}
                    required
                  />
                </label>
                <label>
                  E-mail
                  <input
                    type="email"
                    name="email"
                    value={formulario.email || ''}
                    onChange={alterar}
                  />
                </label>
                <label>
                  CPF
                  <input
                    name="cpf"
                    value={formulario.cpf || ''}
                    onChange={alterar}
                  />
                </label>
                <label>
                  CNPJ
                  <input
                    name="cnpj"
                    value={formulario.cnpj || ''}
                    onChange={alterar}
                  />
                </label>
                <label className="wide">
                  Cidade
                  <input
                    name="cidade"
                    value={formulario.cidade || ''}
                    onChange={alterar}
                  />
                </label>
                <label>
                  Situação cadastral
                  <select
                    name="cadastro_status"
                    value={formulario.cadastro_status}
                    onChange={alterar}
                  >
                    <option value="PROVISORIO">Provisório</option>
                    <option value="VALIDADO">Validado</option>
                    <option value="COMPLETO">Completo</option>
                  </select>
                </label>
                <label>
                  Tipo de cobrança
                  <select
                    name="tipo_cobranca"
                    value={formulario.tipo_cobranca}
                    onChange={alterar}
                  >
                    <option value="ANTECIPADO">Antecipado</option>
                    <option value="FATURAMENTO_SEMANAL">
                      Faturamento semanal
                    </option>
                  </select>
                </label>
                <label>
                  Dia de fechamento
                  <input
                    type="number"
                    min="1"
                    max="31"
                    name="dia_fechamento"
                    value={formulario.dia_fechamento || ''}
                    onChange={alterar}
                  />
                </label>
                <label>
                  Prazo de pagamento
                  <input
                    type="number"
                    min="0"
                    name="prazo_pagamento_dias"
                    value={formulario.prazo_pagamento_dias || '0'}
                    onChange={alterar}
                  />
                </label>
                <label>
                  Limite de crédito
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    name="limite_credito"
                    value={formulario.limite_credito || ''}
                    onChange={alterar}
                  />
                </label>
                <label>
                  Crédito
                  <select
                    name="credito_status"
                    value={formulario.credito_status}
                    onChange={alterar}
                  >
                    <option value="LIBERADO">Liberado</option>
                    <option value="BLOQUEADO">Bloqueado</option>
                  </select>
                </label>
                <label className="wide">
                  Observação de crédito
                  <textarea
                    name="credito_observacao"
                    value={formulario.credito_observacao || ''}
                    onChange={alterar}
                  />
                </label>
                {!registro && (
                  <label className="registry-check wide">
                    <input
                      type="checkbox"
                      name="vip"
                      checked={Boolean(formulario.vip)}
                      onChange={alterar}
                    />
                    Cadastrar como cliente VIP
                  </label>
                )}
              </>
            ) : (
              <>
                <label>
                  Pessoa de contato
                  <input
                    name="contato"
                    value={formulario.contato || ''}
                    onChange={alterar}
                  />
                </label>
                <label>
                  Tipo
                  <select
                    name="tipo"
                    value={formulario.tipo}
                    onChange={alterar}
                  >
                    <option value="PESSOA">Pessoa</option>
                    <option value="EMPRESA">Empresa</option>
                    <option value="SISTEMA">Sistema</option>
                    <option value="API">API</option>
                  </select>
                </label>
                <label>
                  Telefone
                  <input
                    name="telefone"
                    value={formulario.telefone || ''}
                    onChange={alterar}
                  />
                </label>
                <label>
                  WhatsApp
                  <input
                    name="whatsapp"
                    value={formulario.whatsapp || ''}
                    onChange={alterar}
                  />
                </label>
                <label className="wide">
                  E-mail
                  <input
                    type="email"
                    name="email"
                    value={formulario.email || ''}
                    onChange={alterar}
                  />
                </label>
                <label>
                  Início do atendimento
                  <input
                    type="time"
                    name="horario_inicio"
                    value={(formulario.horario_inicio || '').slice(0, 5)}
                    onChange={alterar}
                  />
                </label>
                <label>
                  Fim do atendimento
                  <input
                    type="time"
                    name="horario_fim"
                    value={(formulario.horario_fim || '').slice(0, 5)}
                    onChange={alterar}
                  />
                </label>
                <label className="wide">
                  Observações
                  <textarea
                    name="observacoes"
                    value={formulario.observacoes || ''}
                    onChange={alterar}
                  />
                </label>
              </>
            )}
          </div>

          <footer>
            <button type="button" className="registry-cancel" onClick={aoFechar}>
              Cancelar
            </button>
            <button type="submit" className="registry-save" disabled={salvando}>
              {salvando ? 'Salvando...' : 'Salvar'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function Cabecalho({ tipo, carregando, aoAtualizar, aoNovo }) {
  const cliente = tipo === 'cliente';

  return (
    <div className="registry-heading">
      <div>
        <span>CENTRAL OPERACIONAL</span>
        <h1>{cliente ? 'Clientes' : 'Fornecedores'}</h1>
        <p>
          {cliente
            ? 'Cadastros, cobranças, crédito e relacionamento.'
            : 'Parceiros, sistemas, horários e canais de atendimento.'}
        </p>
      </div>
      <div className="registry-actions">
        <button type="button" onClick={aoAtualizar}>
          <RefreshCw size={16} className={carregando ? 'rotating' : ''} />
          Atualizar
        </button>
        <button type="button" className="registry-new" onClick={aoNovo}>
          <Plus size={17} />
          {cliente ? 'Novo cliente' : 'Novo fornecedor'}
        </button>
      </div>
    </div>
  );
}

function Indicadores({ tipo, resumo }) {
  const cliente = tipo === 'cliente';

  const itens = cliente
    ? [
        ['Total', resumo.total, UsersRound],
        ['Ativos', resumo.ativos, CheckCircle2],
        ['Faturamento semanal', resumo.faturamento_semanal, CircleDollarSign],
        ['Crédito bloqueado', resumo.credito_bloqueado, ShieldCheck]
      ]
    : [
        ['Total', resumo.total, Truck],
        ['Ativos', resumo.ativos, CheckCircle2],
        ['Pessoas/empresas',
          Number(resumo.pessoas || 0) + Number(resumo.empresas || 0),
          Building2],
        ['APIs/sistemas',
          Number(resumo.apis || 0) + Number(resumo.sistemas || 0),
          ShieldCheck]
      ];

  return (
    <div className="registry-metrics">
      {itens.map(([titulo, valor, Icone]) => (
        <article key={titulo}>
          <span><Icone size={18} /></span>
          <div>
            <small>{titulo}</small>
            <strong>{Number(valor || 0)}</strong>
          </div>
        </article>
      ))}
    </div>
  );
}

function TelaCadastro({ tipo }) {
  const cliente = tipo === 'cliente';
  const token = useMemo(() => obterToken(), []);
  const [dados, setDados] = useState([]);
  const [resumo, setResumo] = useState({});
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState('');
  const [status, setStatus] = useState('1');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [erroModal, setErroModal] = useState('');
  const [modal, setModal] = useState(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');

    try {
      const [lista, indicadores] = cliente
        ? await Promise.all([
            listarClientes(token, filtro),
            buscarResumoClientes(token)
          ])
        : await Promise.all([
            listarFornecedores(token),
            buscarResumoFornecedores(token)
          ]);

      setDados(lista.dados || []);
      setResumo(indicadores.resumo || {});
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setCarregando(false);
    }
  }, [cliente, token, filtro]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const dadosFiltrados = useMemo(() => {
    const termo = filtro.toLowerCase();

    return dados.filter(registro => {
      if (status !== '' && Number(registro.ativo) !== Number(status)) {
        return false;
      }

      if (cliente || !termo) return true;

      return [
        registro.nome,
        registro.contato,
        registro.telefone,
        registro.whatsapp,
        registro.email,
        registro.tipo
      ].some(valor => String(valor || '').toLowerCase().includes(termo));
    });
  }, [dados, filtro, status, cliente]);

  async function salvar(formulario) {
    setSalvando(true);
    setErroModal('');

    try {
      if (cliente) {
        if (modal?.id) {
          await atualizarCliente(token, modal.id, formulario);
        } else {
          await cadastrarCliente(token, formulario);
        }
      } else if (modal?.id) {
        await atualizarFornecedor(token, modal.id, formulario);
      } else {
        await cadastrarFornecedor(token, formulario);
      }

      setModal(null);
      await carregar();
    } catch (falha) {
      setErroModal(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  async function alternar(registro) {
    setErro('');

    try {
      if (cliente) {
        await alterarStatusCliente(token, registro.id, registro.ativo ? 0 : 1);
      } else {
        await alterarStatusFornecedor(
          token,
          registro.id,
          registro.ativo ? 0 : 1
        );
      }

      await carregar();
    } catch (falha) {
      setErro(falha.message);
    }
  }

  function pesquisar(evento) {
    evento.preventDefault();
    setFiltro(busca.trim());
  }

  return (
    <section className="registry-page">
      <Cabecalho
        tipo={tipo}
        carregando={carregando}
        aoAtualizar={carregar}
        aoNovo={() => setModal({})}
      />

      <Indicadores tipo={tipo} resumo={resumo} />

      <div className="registry-panel">
        <form className="registry-filters" onSubmit={pesquisar}>
          <div>
            <Search size={17} />
            <input
              value={busca}
              onChange={evento => setBusca(evento.target.value)}
              placeholder={
                cliente
                  ? 'Nome, telefone, CPF, CNPJ ou e-mail'
                  : 'Nome, contato, telefone, WhatsApp ou e-mail'
              }
            />
          </div>
          <select value={status} onChange={evento => setStatus(evento.target.value)}>
            <option value="">Todos os status</option>
            <option value="1">Ativos</option>
            <option value="0">Bloqueados</option>
          </select>
          <button type="submit">Pesquisar</button>
        </form>

        {erro && <div className="registry-page-error">{erro}</div>}

        <div className="registry-table-wrap">
          <table className="registry-table">
            <thead>
              {cliente ? (
                <tr>
                  <th>Cliente</th>
                  <th>Contato</th>
                  <th>Cadastro</th>
                  <th>Cobrança</th>
                  <th>Crédito</th>
                  <th>Status</th>
                  <th />
                </tr>
              ) : (
                <tr>
                  <th>Fornecedor</th>
                  <th>Contato</th>
                  <th>Comunicação</th>
                  <th>Horário</th>
                  <th>Tipo</th>
                  <th>Status</th>
                  <th />
                </tr>
              )}
            </thead>
            <tbody>
              {!carregando && dadosFiltrados.length === 0 && (
                <tr>
                  <td colSpan="7" className="registry-empty">
                    Nenhum registro encontrado.
                  </td>
                </tr>
              )}

              {dadosFiltrados.map(registro => (
                <tr key={registro.id}>
                  {cliente ? (
                    <>
                      <td>
                        <strong>{registro.nome}</strong>
                        <span>{registro.cidade || 'Cidade não informada'}</span>
                      </td>
                      <td>
                        <strong>{registro.telefone}</strong>
                        <span>{registro.email || 'E-mail não informado'}</span>
                      </td>
                      <td>
                        <span className={`registry-badge badge-${registro.cadastro_status}`}>
                          {registro.cadastro_status}
                        </span>
                        <small>{registro.cpf || registro.cnpj || 'Sem documento'}</small>
                      </td>
                      <td>
                        <strong>
                          {registro.tipo_cobranca === 'FATURAMENTO_SEMANAL'
                            ? 'Semanal'
                            : 'Antecipado'}
                        </strong>
                        {registro.vip_status && <span>VIP: {registro.vip_status}</span>}
                      </td>
                      <td>
                        <span className={`registry-badge credit-${registro.credito_status}`}>
                          {registro.credito_status || 'LIBERADO'}
                        </span>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <strong>{registro.nome}</strong>
                        <span>{registro.contato || 'Contato não informado'}</span>
                      </td>
                      <td>
                        <strong>{registro.telefone || '—'}</strong>
                        <span>{registro.email || 'E-mail não informado'}</span>
                      </td>
                      <td>
                        <strong>{registro.whatsapp || '—'}</strong>
                        <span>WhatsApp</span>
                      </td>
                      <td>
                        <Clock3 size={14} />
                        <strong>
                          {registro.horario_inicio
                            ? `${registro.horario_inicio.slice(0, 5)}–${(registro.horario_fim || '').slice(0, 5)}`
                            : 'Não definido'}
                        </strong>
                      </td>
                      <td>
                        <span className="registry-badge">{registro.tipo}</span>
                      </td>
                    </>
                  )}

                  <td>
                    <span className={registro.ativo ? 'registry-active' : 'registry-blocked'}>
                      {registro.ativo ? 'Ativo' : 'Bloqueado'}
                    </span>
                  </td>
                  <td>
                    <div className="registry-row-actions">
                      <button type="button" onClick={() => setModal(registro)}>
                        <Pencil size={16} />
                      </button>
                      <button type="button" onClick={() => alternar(registro)}>
                        {registro.ativo
                          ? <Ban size={16} />
                          : <CheckCircle2 size={16} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer className="registry-footer">
          {dadosFiltrados.length} registro(s) exibido(s)
        </footer>
      </div>

      {modal && (
        <ModalCadastro
          tipo={tipo}
          registro={modal.id ? modal : null}
          salvando={salvando}
          erro={erroModal}
          aoFechar={() => {
            setModal(null);
            setErroModal('');
          }}
          aoSalvar={salvar}
        />
      )}
    </section>
  );
}

export function Clientes() {
  return <TelaCadastro tipo="cliente" />;
}

export function Fornecedores() {
  return <TelaCadastro tipo="fornecedor" />;
}
