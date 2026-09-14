/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  Database,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X
} from 'lucide-react';
import {
  alterarStatusSenha,
  atualizarSenha,
  buscarResumoBancoSenhas,
  cadastrarSenha,
    consultarBancoSenhaExato,
  listarBancoSenhas,
  listarOrigensSenha
} from './api';

const FORMULARIO_INICIAL = {
  tipo: 'GM_SENHA',
  marca: 'GM',
  modelo: '',
  ano_inicio: '',
  ano_fim: '',
  chassi: '',
  codigo_mecanico: '',
  codigo_mecanico_alterado: '',
  codigo_radio: '',
  codigo_radio_alterado: '',
  codigo_imobilizador: '',
  codigo_imobilizador_alterado: '',
  codigo_alarme: '',
  codigo_alarme_alterado: '',
  pin: '',
  pin_alterado: '',
  origem_id: '',
  fornecedor_id: '',
  confiabilidade: 'MEDIA'
};

function obterToken() {
  const chaves = [
    'central_mykey_token',
    'centralMyKeyToken',
    'token',
    'authToken'
  ];

  for (const chave of chaves) {
    const valor = localStorage.getItem(chave);
    if (valor) return valor;
  }

  const chaveEncontrada = Object.keys(localStorage).find(chave =>
    chave.toLowerCase().includes('token')
  );

  return chaveEncontrada
    ? localStorage.getItem(chaveEncontrada)
    : '';
}

function CampoCodigo({ titulo, valor }) {
  return (
    <div className="vault-code">
      <span>{titulo}</span>
      <strong>{valor || '—'}</strong>
    </div>
  );
}

function ModalSenha({
  registro,
  origens,
  salvando,
  erro,
  aoFechar,
  aoSalvar
}) {
  const [formulario, setFormulario] = useState(
    registro
      ? {
          ...FORMULARIO_INICIAL,
          ...registro,
          origem_id: registro.origem_id || ''
        }
      : FORMULARIO_INICIAL
  );

  function alterar(evento) {
    const { name, value } = evento.target;
    setFormulario(atual => ({ ...atual, [name]: value }));
  }

  function enviar(evento) {
    evento.preventDefault();
    aoSalvar(formulario);
  }

  return (
    <div className="vault-overlay">
      <section className="vault-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <span>BANCO DE SENHAS MYKEY</span>
            <h2>{registro ? 'Editar senha' : 'Cadastrar senha'}</h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar">
            <X size={20} />
          </button>
        </header>

        <form onSubmit={enviar}>
          {erro && <div className="vault-error">{erro}</div>}

          <div className="vault-form-grid">
            <label className="wide">
              Chassi
              <input
                name="chassi"
                value={formulario.chassi || ''}
                onChange={alterar}
                maxLength="30"
                required
              />
            </label>

            <label>
              Marca
              <input
                name="marca"
                value={formulario.marca || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Modelo
              <input
                name="modelo"
                value={formulario.modelo || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Ano inicial
              <input
                type="number"
                name="ano_inicio"
                value={formulario.ano_inicio || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Ano final
              <input
                type="number"
                name="ano_fim"
                value={formulario.ano_fim || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Código mecânico original
              <input
                name="codigo_mecanico"
                value={formulario.codigo_mecanico || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Código mecânico alterado
              <input
                name="codigo_mecanico_alterado"
                value={formulario.codigo_mecanico_alterado || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Código de rádio original
              <input
                name="codigo_radio"
                value={formulario.codigo_radio || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Código de rádio alterado
              <input
                name="codigo_radio_alterado"
                value={formulario.codigo_radio_alterado || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Código imobilizador original
              <input
                name="codigo_imobilizador"
                value={formulario.codigo_imobilizador || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Código imobilizador alterado
              <input
                name="codigo_imobilizador_alterado"
                value={formulario.codigo_imobilizador_alterado || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Código de alarme original
              <input
                name="codigo_alarme"
                value={formulario.codigo_alarme || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Código de alarme alterado
              <input
                name="codigo_alarme_alterado"
                value={formulario.codigo_alarme_alterado || ''}
                onChange={alterar}
              />
            </label>

            <label>
              PIN original
              <input
                name="pin"
                value={formulario.pin || ''}
                onChange={alterar}
              />
            </label>

            <label>
              PIN alterado
              <input
                name="pin_alterado"
                value={formulario.pin_alterado || ''}
                onChange={alterar}
              />
            </label>

            <label>
              Origem
              <select
                name="origem_id"
                value={formulario.origem_id || ''}
                onChange={alterar}
              >
                <option value="">Não definida</option>
                {origens.map(origem => (
                  <option key={origem.id} value={origem.id}>
                    {origem.nome}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Confiabilidade
              <select
                name="confiabilidade"
                value={formulario.confiabilidade}
                onChange={alterar}
              >
                <option value="BAIXA">Baixa</option>
                <option value="MEDIA">Média</option>
                <option value="ALTA">Alta</option>
                <option value="CONFIRMADA">Confirmada</option>
              </select>
            </label>
          </div>

          <footer>
            <button type="button" className="vault-secondary" onClick={aoFechar}>
              Cancelar
            </button>
            <button type="submit" className="vault-primary" disabled={salvando}>
              {salvando ? 'Salvando...' : 'Salvar senha'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export default function BancoSenhas({ usuario, permissoes = [] }) {
  const token = useMemo(() => obterToken(), []);
  const permissao = permissoes.find(
    item => item.codigo === 'BANCO_SENHAS'
  );
  const acessoCompleto =
    Number(permissao?.aprovar) === 1 &&
    [1, 3].includes(Number(usuario?.id));
  const podeCriar = Number(permissao?.criar) === 1;
  const podeEditar = Number(permissao?.editar) === 1;
  const [dados, setDados] = useState([]);
  const [resumo, setResumo] = useState({});
  const [origens, setOrigens] = useState([]);
  const [busca, setBusca] = useState('');
  const [filtroBusca, setFiltroBusca] = useState('');
  const [origemId, setOrigemId] = useState('');
  const [confiabilidade, setConfiabilidade] = useState('');
  const [ativo, setAtivo] = useState('1');
  const [pagina, setPagina] = useState(1);
  const [totalPaginas, setTotalPaginas] = useState(1);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [erroModal, setErroModal] = useState('');
  const [modal, setModal] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [consultaRealizada, setConsultaRealizada] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');

    try {
      if (!acessoCompleto) {
        const listaOrigens = await listarOrigensSenha(token);
        setOrigens(listaOrigens.dados || []);
        return;
      }

      const [lista, indicadores, listaOrigens] = await Promise.all([
        listarBancoSenhas(token, {
          busca: filtroBusca,
          origemId,
          confiabilidade,
          ativo,
          pagina,
          limite: 50
        }),
        buscarResumoBancoSenhas(token),
        listarOrigensSenha(token)
      ]);

      setDados(lista.dados || []);
      setTotal(Number(lista.total || 0));
      setTotalPaginas(Math.max(Number(lista.total_paginas || 1), 1));
      setResumo(indicadores.resumo || {});
      setOrigens(listaOrigens.dados || []);
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setCarregando(false);
    }
  }, [
    token,
    acessoCompleto,
    filtroBusca,
    origemId,
    confiabilidade,
    ativo,
    pagina
  ]);

  useEffect(() => {
    // A carga inicial sincroniza o componente com a API.
    carregar();
  }, [carregar]);

  async function pesquisar(evento) {
    evento.preventDefault();

    const termo = busca
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

    setErro('');
    setPagina(1);

    if (acessoCompleto) {
      setFiltroBusca(termo);
      return;
    }

    if (termo.length < 8 || termo.length > 17) {
      setDados([]);
      setTotal(0);
      setConsultaRealizada(false);
      setErro('Informe entre 8 e 17 caracteres finais do chassi.');
      return;
    }

    setCarregando(true);
    setConsultaRealizada(true);

    try {
      const resposta = await consultarBancoSenhaExato(token, termo);
      setDados(resposta.senha ? [resposta.senha] : []);
      setTotal(resposta.senha ? 1 : 0);
    } catch (falha) {
      setDados([]);
      setTotal(0);
      setErro(falha.message);
    } finally {
      setCarregando(false);
    }
  }

  async function salvar(formulario) {
    setSalvando(true);
    setErroModal('');

    try {
      if (modal?.id) {
        await atualizarSenha(token, modal.id, formulario);
      } else {
        await cadastrarSenha(token, formulario);
      }

      setModal(null);

      if (acessoCompleto) {
        await carregar();
      } else {
        const resposta = await consultarBancoSenhaExato(
          token,
          formulario.chassi
        );

        setConsultaRealizada(true);
        setDados(resposta.senha ? [resposta.senha] : []);
        setTotal(resposta.senha ? 1 : 0);
      }
    } catch (falha) {
      setErroModal(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarStatus(registro) {
    setErro('');

    try {
      const novoStatus = registro.ativo ? 0 : 1;

      await alterarStatusSenha(
        token,
        registro.id,
        novoStatus
      );

      if (acessoCompleto) {
        await carregar();
      } else {
        setDados(atuais =>
          atuais.map(item =>
            Number(item.id) === Number(registro.id)
              ? { ...item, ativo: novoStatus }
              : item
          )
        );
      }
    } catch (falha) {
      setErro(falha.message);
    }
  }

  return (
    <section className="vault-page">
      <div className="vault-heading">
        <div>
          <span>CENTRAL OPERACIONAL</span>
          <h1>Banco de senhas</h1>
          <p>
              {acessoCompleto
                ? 'Consulte, valide e administre os códigos da base MyKey.'
                : 'Consulte uma senha pelos últimos 8 a 17 caracteres do chassi.'}
            </p>
        </div>

        <div className="vault-actions">
            {acessoCompleto && (
              <button type="button" onClick={carregar} className="vault-refresh">
                <RefreshCw size={16} />
                Atualizar
              </button>
            )}
            {podeCriar && (
              <button type="button" onClick={() => setModal({})} className="vault-new">
                <Plus size={17} />
                Nova senha
              </button>
            )}
          </div>
      </div>

      {acessoCompleto && (
        <div className="vault-metrics">
        <article>
          <span><Database size={18} /></span>
          <div><small>Total na base</small><strong>{Number(resumo.total || 0)}</strong></div>
        </article>
        <article>
          <span><CheckCircle2 size={18} /></span>
          <div><small>Ativos</small><strong>{Number(resumo.ativos || 0)}</strong></div>
        </article>
        <article>
          <span><ShieldCheck size={18} /></span>
          <div><small>Alta/confirmada</small><strong>
            {Number(resumo.confiabilidade_alta || 0) +
              Number(resumo.confirmados || 0)}
          </strong></div>
        </article>
        <article>
          <span><KeyRound size={18} /></span>
          <div><small>Bônus importado</small><strong>{Number(resumo.origem_bonus || 0)}</strong></div>
        </article>
      </div>
        )}

        <div className="vault-panel">
        <form className="vault-filters" onSubmit={pesquisar}>
          <div className="vault-search">
            <Search size={17} />
            <input
              value={busca}
              onChange={evento => setBusca(evento.target.value)}
              placeholder={
                  acessoCompleto
                    ? 'Chassi, mecânico, rádio, imobilizador ou alarme'
                    : 'Últimos 8 a 17 caracteres do chassi'
                }
                minLength={acessoCompleto ? undefined : 8}
                maxLength={acessoCompleto ? undefined : 17}
            />
          </div>

          {acessoCompleto && (
              <>
                <select
            value={origemId}
            onChange={evento => {
              setOrigemId(evento.target.value);
              setPagina(1);
            }}
          >
            <option value="">Todas as origens</option>
            {origens.map(origem => (
              <option key={origem.id} value={origem.id}>{origem.nome}</option>
            ))}
          </select>

          <select
            value={confiabilidade}
            onChange={evento => {
              setConfiabilidade(evento.target.value);
              setPagina(1);
            }}
          >
            <option value="">Toda confiabilidade</option>
            <option value="BAIXA">Baixa</option>
            <option value="MEDIA">Média</option>
            <option value="ALTA">Alta</option>
            <option value="CONFIRMADA">Confirmada</option>
          </select>

          <select
            value={ativo}
            onChange={evento => {
              setAtivo(evento.target.value);
              setPagina(1);
            }}
          >
            <option value="">Todos os status</option>
            <option value="1">Ativos</option>
            <option value="0">Bloqueados</option>
          </select>
              </>
            )}

            <button type="submit" disabled={carregando}>
              {carregando ? 'Consultando...' : 'Pesquisar'}
            </button>
        </form>

        {erro && <div className="vault-page-error">{erro}</div>}

        <div className="vault-table-wrap">
          <table className="vault-table">
            <thead>
              <tr>
                <th>Veículo / chassi</th>
                <th>Códigos</th>
                <th>Origem</th>
                <th>Confiabilidade</th>
                <th>Uso</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!carregando && dados.length === 0 && (
                <tr>
                  <td colSpan="7" className="vault-empty">
                    {!acessoCompleto && !consultaRealizada
                        ? 'Digite os últimos 8 a 17 caracteres do chassi para consultar.'
                        : 'Nenhuma senha encontrada.'}
                  </td>
                </tr>
              )}

              {dados.map(registro => (
                <tr key={registro.id}>
                  <td>
                    <strong>{registro.marca || 'Sem marca'} {registro.modelo || ''}</strong>
                    <span>{registro.chassi}</span>
                    <small>
                      {registro.ano_inicio || '—'}
                      {registro.ano_fim && registro.ano_fim !== registro.ano_inicio
                        ? ` a ${registro.ano_fim}`
                        : ''}
                    </small>
                  </td>
                  <td>
                    <div className="vault-codes">
                      <CampoCodigo titulo="Mecânico original" valor={registro.codigo_mecanico} />
                      {registro.codigo_mecanico_alterado && (
                        <CampoCodigo titulo="Mecânico alterado" valor={registro.codigo_mecanico_alterado} />
              )}
                      <CampoCodigo titulo="Rádio original" valor={registro.codigo_radio} />
                      {registro.codigo_radio_alterado && (
                        <CampoCodigo titulo="Rádio alterado" valor={registro.codigo_radio_alterado} />
              )}
                      <CampoCodigo titulo="Imobilizador original" valor={registro.codigo_imobilizador} />
                      {registro.codigo_imobilizador_alterado && (
                        <CampoCodigo titulo="Imobilizador alterado" valor={registro.codigo_imobilizador_alterado} />
              )}
                      <CampoCodigo titulo="Alarme original" valor={registro.codigo_alarme} />
                      {registro.codigo_alarme_alterado && (
                        <CampoCodigo titulo="Alarme alterado" valor={registro.codigo_alarme_alterado} />
              )}
                      <CampoCodigo titulo="PIN original" valor={registro.pin} />
                      {registro.pin_alterado && (
                        <CampoCodigo titulo="PIN alterado" valor={registro.pin_alterado} />
              )}
                    </div>
                  </td>
                  <td>{registro.origem || 'Não definida'}</td>
                  <td>
                    <span className={`vault-trust trust-${registro.confiabilidade}`}>
                      {registro.confiabilidade}
                    </span>
                  </td>
                  <td>
                    <strong>{Number(registro.quantidade_usos || 0)}</strong>
                    <small className="vault-use">
                      {Number(registro.quantidade_sucessos || 0)} acertos ·{' '}
                      {Number(registro.quantidade_erros || 0)} erros
                    </small>
                  </td>
                  <td>
                    <span className={registro.ativo ? 'vault-active' : 'vault-blocked'}>
                      {registro.ativo ? 'Ativo' : 'Bloqueado'}
                    </span>
                  </td>
                  <td>
                    <div className="vault-row-actions">
                        {podeEditar && (
                          <>

                      <button
                        type="button"
                        title="Editar"
                        onClick={() => setModal(registro)}
                      >
                        <Pencil size={16} />
                      </button>
                      {acessoCompleto && (
                      <button
                        type="button"
                        title={registro.ativo ? 'Bloquear' : 'Ativar'}
                        onClick={() => alternarStatus(registro)}
                      >
                        {registro.ativo
                          ? <Ban size={16} />
                          : <CheckCircle2 size={16} />}
                      </button>
                      )}
                    
                          </>
                        )}
                      </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {acessoCompleto && (
          <footer className="vault-pagination">
          <span>{total} registro(s)</span>
          <div>
            <button
              type="button"
              disabled={pagina <= 1}
              onClick={() => setPagina(atual => atual - 1)}
            >
              Anterior
            </button>
            <strong>{pagina} de {totalPaginas}</strong>
            <button
              type="button"
              disabled={pagina >= totalPaginas}
              onClick={() => setPagina(atual => atual + 1)}
            >
              Próxima
            </button>
          </div>
        </footer>
          )}
      </div>

      {modal && (
        <ModalSenha
          registro={modal.id ? modal : null}
          origens={origens}
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
