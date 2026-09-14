import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRightLeft,
  CheckCheck,
  Clock3,
  Headphones,
  Inbox,
  MessageCircleMore,
  Phone,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  StickyNote
} from 'lucide-react';
import {
  alterarStatusAtendimento,
  assumirAtendimento,
  buscarAtendimento,
  enviarMensagemWhatsapp,
  enviarNotaInterna,
  listarAtendentesDisponiveis,
  listarAtendimentos,
  transferirAtendimento
} from './api';

const TRANSICOES = {
  FILA: ['EM_ATENDIMENTO', 'CANCELADO'],
  EM_ATENDIMENTO: [
    'AGUARDANDO_CLIENTE',
    'AGUARDANDO_PAGAMENTO',
    'AGUARDANDO_FORNECEDOR',
    'REVISAO',
    'PRONTO_ENVIO',
    'FINALIZADO',
    'CANCELADO'
  ],
  AGUARDANDO_CLIENTE: [
    'EM_ATENDIMENTO',
    'AGUARDANDO_PAGAMENTO',
    'AGUARDANDO_FORNECEDOR',
    'REVISAO',
    'CANCELADO'
  ],
  AGUARDANDO_PAGAMENTO: [
    'EM_ATENDIMENTO',
    'AGUARDANDO_FORNECEDOR',
    'REVISAO',
    'CANCELADO'
  ],
  AGUARDANDO_FORNECEDOR: [
    'EM_ATENDIMENTO',
    'REVISAO',
    'PRONTO_ENVIO',
    'CANCELADO'
  ],
  REVISAO: [
    'EM_ATENDIMENTO',
    'AGUARDANDO_CLIENTE',
    'AGUARDANDO_FORNECEDOR',
    'PRONTO_ENVIO',
    'CANCELADO'
  ],
  PRONTO_ENVIO: [
    'EM_ATENDIMENTO',
    'REVISAO',
    'FINALIZADO',
    'CANCELADO'
  ],
  FINALIZADO: [],
  CANCELADO: []
};

const STATUS = {
  FILA: 'Na fila',
  EM_ATENDIMENTO: 'Em atendimento',
  AGUARDANDO_CLIENTE: 'Aguardando cliente',
  AGUARDANDO_PAGAMENTO: 'Aguardando pagamento',
  AGUARDANDO_FORNECEDOR: 'Aguardando fornecedor',
  REVISAO: 'Em revisão',
  PRONTO_ENVIO: 'Pronto para envio',
  FINALIZADO: 'Finalizado',
  CANCELADO: 'Cancelado'
};

function dataHora(valor) {
  if (!valor) return 'Sem registro';

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(valor));
}

function iniciais(nome = '') {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(parte => parte[0])
    .join('')
    .toUpperCase() || 'CL';
}

function EstadoVazio({ titulo, texto }) {
  return (
    <div className="attendance-empty">
      <span><Inbox size={29} /></span>
      <h3>{titulo}</h3>
      <p>{texto}</p>
    </div>
  );
}

function ModalTransferencia({
  atendentes,
  carregando,
  enviando,
  aoFechar,
  aoConfirmar
}) {
  const [destino, setDestino] = useState('');
  const [motivo, setMotivo] = useState('');

  function confirmar(evento) {
    evento.preventDefault();
    if (!destino) return;
    aoConfirmar(destino, motivo.trim());
  }

  return (
    <div className="transfer-overlay" role="presentation">
      <section
        className="transfer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-title"
      >
        <header>
          <span><ArrowRightLeft size={21} /></span>
          <div>
            <small>ATENDIMENTO MYKEY</small>
            <h3 id="transfer-title">Transferir atendimento</h3>
          </div>
        </header>

        <form onSubmit={confirmar}>
          <label>
            <span>Novo responsável</span>
            <select
              value={destino}
              onChange={evento => setDestino(evento.target.value)}
              disabled={carregando || enviando}
              required
            >
              <option value="">
                {carregando
                  ? 'Carregando atendentes...'
                  : 'Selecione um atendente'}
              </option>
              {atendentes.map(atendente => (
                <option key={atendente.id} value={atendente.id}>
                  {atendente.nome} — {atendente.perfil}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Motivo da transferência</span>
            <textarea
              value={motivo}
              onChange={evento => setMotivo(evento.target.value)}
              placeholder="Ex.: continuidade do atendimento no próximo turno"
              rows={3}
              maxLength={250}
              disabled={enviando}
            />
          </label>

          {!carregando && atendentes.length === 0 && (
            <p className="transfer-empty">
              Nenhum outro atendente disponível para transferência.
            </p>
          )}

          <footer>
            <button
              type="button"
              className="transfer-cancel"
              onClick={aoFechar}
              disabled={enviando}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="transfer-confirm"
              disabled={!destino || enviando}
            >
              <ArrowRightLeft size={17} />
              {enviando ? 'Transferindo...' : 'Confirmar transferência'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function Conversa({
  detalhe,
  usuario,
  podeEditar,
  aoAssumir,
  assumindo,
  aoVoltar,
  aoEnviar,
  enviando,
  aoAlterarStatus,
  alterandoStatus,
  aoAbrirTransferencia
}) {
  const atendimento = detalhe.atendimento;
  const mensagens = detalhe.mensagens || [];
  const [tipoEnvio, setTipoEnvio] = useState('WHATSAPP');
  const [textoEnvio, setTextoEnvio] = useState('');
  const anexosPorMensagem = useMemo(() => {
    const mapa = new Map();

    for (const anexo of detalhe.anexos || []) {
      const atuais = mapa.get(Number(anexo.mensagem_id)) || [];
      atuais.push(anexo);
      mapa.set(Number(anexo.mensagem_id), atuais);
    }

    return mapa;
  }, [detalhe.anexos]);

  const pertenceAoUsuario =
    Number(atendimento.responsavel_id) === Number(usuario.id);
  const podeAssumir =
    podeEditar &&
    !atendimento.responsavel_id &&
    !['FINALIZADO', 'CANCELADO'].includes(atendimento.status);

  const janelaAberta =
    Number(atendimento.janela_whatsapp_ativa) === 1;

  async function enviar(evento) {
    evento.preventDefault();

    const conteudo = textoEnvio.trim();
    if (!conteudo) return;

    const enviado = await aoEnviar(tipoEnvio, conteudo);
    if (enviado) setTextoEnvio('');
  }

  return (
    <section className="conversation-panel">
      <header className="conversation-header">
        <button
          type="button"
          className="conversation-back"
          onClick={aoVoltar}
          aria-label="Voltar para a fila"
        >
          <ArrowLeft size={20} />
        </button>

        <div className="conversation-avatar">
          {iniciais(atendimento.cliente)}
        </div>

        <div className="conversation-client">
          <h3>{atendimento.cliente}</h3>
          <p>
            <Phone size={14} />
            {atendimento.telefone || 'Telefone não informado'}
          </p>
        </div>

        <div className="conversation-meta">
          <span className={`attendance-status status-${atendimento.status}`}>
            {STATUS[atendimento.status] || atendimento.status}
          </span>
          <small>{atendimento.protocolo}</small>
        </div>
      </header>

      <div className="conversation-summary">
        <div>
          <span>Assunto</span>
          <strong>{atendimento.assunto || 'Atendimento pelo WhatsApp'}</strong>
        </div>
        <div>
          <span>Responsável</span>
          <strong>{atendimento.responsavel || 'Aguardando atendente'}</strong>
        </div>
        <div>
          <span>Canal</span>
          <strong>{atendimento.canal}</strong>
        </div>
        <div>
          <span>Janela WhatsApp</span>
          <strong className={
            Number(atendimento.janela_whatsapp_ativa) === 1
              ? 'window-open'
              : 'window-closed'
          }>
            {Number(atendimento.janela_whatsapp_ativa) === 1
              ? 'Aberta'
              : 'Encerrada'}
          </strong>
        </div>
      </div>

      {(pertenceAoUsuario || usuario.perfil === 'Administrador') &&
        podeEditar &&
        (TRANSICOES[atendimento.status] || []).length > 0 && (
          <div className="status-control">
            <div>
              <span>Etapa atual</span>
              <strong>
                {STATUS[atendimento.status] || atendimento.status}
              </strong>
            </div>
            <label>
              <span>Alterar etapa</span>
              <select
                value=""
                onChange={evento => {
                  const novoStatus = evento.target.value;
                  evento.target.value = '';

                  if (!novoStatus) return;

                  if (
                    ['FINALIZADO', 'CANCELADO'].includes(novoStatus) &&
                    !window.confirm(
                      novoStatus === 'FINALIZADO'
                        ? 'Confirma a finalização deste atendimento?'
                        : 'Confirma o cancelamento deste atendimento?'
                    )
                  ) {
                    return;
                  }

                  aoAlterarStatus(novoStatus);
                }}
                disabled={alterandoStatus}
              >
                <option value="">
                  {alterandoStatus ? 'Alterando...' : 'Selecione a próxima etapa'}
                </option>
                {(TRANSICOES[atendimento.status] || []).map(status => (
                  <option key={status} value={status}>
                    {STATUS[status] || status}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="transfer-button"
              onClick={aoAbrirTransferencia}
            >
              <ArrowRightLeft size={15} />
              Transferir
            </button>
          </div>
        )}

      <div className="messages-area">
        {mensagens.length === 0 ? (
          <EstadoVazio
            titulo="Nenhuma mensagem"
            texto="O histórico desta conversa ainda está vazio."
          />
        ) : (
          mensagens.map(mensagem => {
            const interna = mensagem.direcao === 'INTERNA';
            const saida = mensagem.direcao === 'SAIDA';
            const anexos = anexosPorMensagem.get(Number(mensagem.id)) || [];

            return (
              <div
                key={mensagem.id}
                className={`message-row ${
                  interna ? 'message-internal' : saida ? 'message-out' : 'message-in'
                }`}
              >
                <div className="message-bubble">
                  {interna && <span className="internal-label">NOTA INTERNA</span>}
                  <p>{mensagem.texto || `[${mensagem.tipo_conteudo}]`}</p>

                  {anexos.map(anexo => (
                    <span className="message-attachment" key={anexo.id}>
                      {anexo.nome_arquivo || 'Arquivo anexado'} · {anexo.status_arquivo}
                    </span>
                  ))}

                  <footer>
                    <span>
                      {mensagem.usuario ||
                        (mensagem.autor_tipo === 'CLIENTE'
                          ? atendimento.cliente
                          : 'Sistema')}
                    </span>
                    <time>{dataHora(mensagem.criado_em)}</time>
                    {saida && mensagem.status_entrega && (
                      <span title={mensagem.status_entrega}>
                        <CheckCheck size={14} />
                      </span>
                    )}
                  </footer>
                </div>
              </div>
            );
          })
        )}
      </div>

      <footer className="conversation-actions">
        {podeAssumir ? (
          <button
            type="button"
            className="take-attendance"
            onClick={aoAssumir}
            disabled={assumindo}
          >
            <Headphones size={18} />
            {assumindo ? 'Assumindo...' : 'Assumir atendimento'}
          </button>
        ) : pertenceAoUsuario &&
            podeEditar &&
            !['FINALIZADO', 'CANCELADO'].includes(atendimento.status) ? (
          <form className="message-composer" onSubmit={enviar}>
            <div className="composer-tabs">
              <button
                type="button"
                className={tipoEnvio === 'WHATSAPP' ? 'active' : ''}
                onClick={() => setTipoEnvio('WHATSAPP')}
              >
                <MessageCircleMore size={15} />
                Responder cliente
              </button>
              <button
                type="button"
                className={tipoEnvio === 'INTERNA' ? 'active internal' : ''}
                onClick={() => setTipoEnvio('INTERNA')}
              >
                <StickyNote size={15} />
                Nota interna
              </button>
            </div>

            {tipoEnvio === 'WHATSAPP' && !janelaAberta && (
              <div className="composer-warning">
                A janela de 24 horas está encerrada. Utilize um modelo
                aprovado para reiniciar a conversa.
              </div>
            )}

            <div className={`composer-input ${
              tipoEnvio === 'INTERNA' ? 'composer-input-internal' : ''
            }`}>
              <textarea
                value={textoEnvio}
                onChange={evento => setTextoEnvio(evento.target.value)}
                placeholder={
                  tipoEnvio === 'INTERNA'
                    ? 'Escreva uma observação visível apenas para a equipe'
                    : 'Digite uma mensagem para o cliente'
                }
                rows={2}
              />
              <button
                type="submit"
                title="Enviar"
                disabled={
                  enviando ||
                  !textoEnvio.trim() ||
                  (tipoEnvio === 'WHATSAPP' && !janelaAberta)
                }
              >
                <Send size={18} />
              </button>
            </div>
          </form>
        ) : (
          <div className="conversation-owner">
            <ShieldCheck size={18} />
            <span>
              {pertenceAoUsuario
                ? 'Este atendimento está com você'
                : atendimento.responsavel
                  ? `Atendimento com ${atendimento.responsavel}`
                  : 'Atendimento encerrado'}
            </span>
          </div>
        )}
      </footer>
    </section>
  );
}

export default function Atendimento({ usuario, permissoes }) {
  const token = localStorage.getItem('central_mykey_token');
  const [filtro, setFiltro] = useState('ABERTOS');
  const [busca, setBusca] = useState('');
  const [atendimentos, setAtendimentos] = useState([]);
  const [selecionado, setSelecionado] = useState(null);
  const [detalhe, setDetalhe] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);
  const [assumindo, setAssumindo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [alterandoStatus, setAlterandoStatus] = useState(false);
  const [modalTransferencia, setModalTransferencia] = useState(false);
  const [atendentes, setAtendentes] = useState([]);
  const [carregandoAtendentes, setCarregandoAtendentes] = useState(false);
  const [transferindo, setTransferindo] = useState(false);
  const [erro, setErro] = useState('');
  const [atualizacao, setAtualizacao] = useState(0);

  const permissao = permissoes.find(item => item.codigo === 'ATENDIMENTO');
  const podeEditar = Number(permissao?.editar) === 1;

  useEffect(() => {
    let ativo = true;
    const atraso = setTimeout(async () => {
      try {
        const parametros = {
          busca: busca.trim(),
          meus: filtro === 'MEUS'
        };

        if (!['ABERTOS', 'MEUS', 'TODOS'].includes(filtro)) {
          parametros.status = filtro;
        }

        const resposta = await listarAtendimentos(token, parametros);
        let dados = resposta.dados || [];

        if (filtro === 'ABERTOS') {
          dados = dados.filter(item =>
            !['FINALIZADO', 'CANCELADO'].includes(item.status)
          );
        }

        if (ativo) {
          setAtendimentos(dados);
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
  }, [token, filtro, busca, atualizacao]);

  async function abrir(atendimento) {
    setSelecionado(atendimento.id);
    setDetalhe(null);
    setCarregandoDetalhe(true);
    setErro('');

    try {
      const resposta = await buscarAtendimento(token, atendimento.id);
      setDetalhe(resposta);
    } catch (error) {
      setErro(error.message);
    } finally {
      setCarregandoDetalhe(false);
    }
  }

  async function abrirTransferencia() {
    setModalTransferencia(true);
    setCarregandoAtendentes(true);
    setErro('');

    try {
      const resposta = await listarAtendentesDisponiveis(token);
      setAtendentes(resposta.dados || []);
    } catch (error) {
      setErro(error.message);
      setModalTransferencia(false);
    } finally {
      setCarregandoAtendentes(false);
    }
  }

  async function confirmarTransferencia(destino, motivo) {
    if (!detalhe?.atendimento?.id) return;

    setTransferindo(true);
    setErro('');

    try {
      await transferirAtendimento(
        token,
        detalhe.atendimento.id,
        destino,
        motivo
      );

      const resposta = await buscarAtendimento(
        token,
        detalhe.atendimento.id
      );

      setDetalhe(resposta);
      setModalTransferencia(false);
      setAtualizacao(valor => valor + 1);
    } catch (error) {
      setErro(error.message);
    } finally {
      setTransferindo(false);
    }
  }

  async function alterarEtapa(novoStatus) {
    if (!detalhe?.atendimento?.id) return;

    setAlterandoStatus(true);
    setErro('');

    try {
      await alterarStatusAtendimento(
        token,
        detalhe.atendimento.id,
        novoStatus
      );

      const resposta = await buscarAtendimento(
        token,
        detalhe.atendimento.id
      );

      setDetalhe(resposta);
      setAtualizacao(valor => valor + 1);
    } catch (error) {
      setErro(error.message);
    } finally {
      setAlterandoStatus(false);
    }
  }

  async function enviarConteudo(tipo, conteudo) {
    if (!detalhe?.atendimento?.id) return false;

    setEnviando(true);
    setErro('');

    try {
      if (tipo === 'INTERNA') {
        await enviarNotaInterna(
          token,
          detalhe.atendimento.id,
          conteudo
        );
      } else {
        await enviarMensagemWhatsapp(
          token,
          detalhe.atendimento.id,
          conteudo
        );
      }

      const resposta = await buscarAtendimento(
        token,
        detalhe.atendimento.id
      );

      setDetalhe(resposta);
      setAtualizacao(valor => valor + 1);
      return true;
    } catch (error) {
      setErro(error.message);
      return false;
    } finally {
      setEnviando(false);
    }
  }

  async function assumir() {
    if (!detalhe?.atendimento?.id) return;

    setAssumindo(true);
    setErro('');

    try {
      await assumirAtendimento(token, detalhe.atendimento.id);
      const resposta = await buscarAtendimento(
        token,
        detalhe.atendimento.id
      );
      setDetalhe(resposta);
      setAtualizacao(valor => valor + 1);
    } catch (error) {
      setErro(error.message);
    } finally {
      setAssumindo(false);
    }
  }

  return (
    <div className={`attendance-layout ${selecionado ? 'has-selection' : ''}`}>
      <section className="attendance-list-panel">
        <div className="attendance-toolbar">
          <div>
            <span>Central de conversas</span>
            <h2>Atendimentos</h2>
          </div>

          <button
            type="button"
            className="refresh-attendance"
            onClick={() => setAtualizacao(valor => valor + 1)}
            title="Atualizar fila"
          >
            <RefreshCw size={18} />
          </button>
        </div>

        <label className="attendance-search">
          <Search size={17} />
          <input
            type="search"
            value={busca}
            onChange={evento => setBusca(evento.target.value)}
            placeholder="Cliente, telefone ou protocolo"
          />
        </label>

        <div className="attendance-filters">
          {[
            ['ABERTOS', 'Abertos'],
            ['FILA', 'Fila'],
            ['MEUS', 'Meus'],
            ['FINALIZADO', 'Finalizados']
          ].map(([codigo, nome]) => (
            <button
              type="button"
              key={codigo}
              className={filtro === codigo ? 'active' : ''}
              onClick={() => setFiltro(codigo)}
            >
              {nome}
            </button>
          ))}
        </div>

        <div className="attendance-count">
          <span>{atendimentos.length} atendimento(s)</span>
          <small>Atualização manual</small>
        </div>

        <div className="attendance-items">
          {carregando ? (
            <div className="attendance-loading">
              <RefreshCw size={22} />
              Carregando atendimentos...
            </div>
          ) : atendimentos.length === 0 ? (
            <EstadoVazio
              titulo="Fila vazia"
              texto="Nenhum atendimento encontrado neste filtro."
            />
          ) : (
            atendimentos.map(atendimento => (
              <button
                type="button"
                key={atendimento.id}
                className={`attendance-item ${
                  Number(selecionado) === Number(atendimento.id) ? 'active' : ''
                }`}
                onClick={() => abrir(atendimento)}
              >
                <span className="attendance-avatar">
                  {iniciais(atendimento.cliente)}
                </span>
                <span className="attendance-copy">
                  <strong>{atendimento.cliente}</strong>
                  <small>
                    {atendimento.ultima_mensagem ||
                      atendimento.assunto ||
                      'Nova conversa'}
                  </small>
                  <span>
                    <Clock3 size={12} />
                    {dataHora(
                      atendimento.ultima_mensagem_em ||
                      atendimento.iniciado_em
                    )}
                  </span>
                </span>
                <span className="attendance-side">
                  <span className={`attendance-status status-${atendimento.status}`}>
                    {STATUS[atendimento.status] || atendimento.status}
                  </span>
                  {Number(atendimento.quantidade_mensagens) > 0 && (
                    <small>{atendimento.quantidade_mensagens}</small>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <div className="attendance-conversation-wrap">
        {erro && <div className="attendance-error">{erro}</div>}

        {carregandoDetalhe ? (
          <div className="conversation-loading">
            <RefreshCw size={24} />
            Carregando conversa...
          </div>
        ) : detalhe ? (
          <Conversa
            detalhe={detalhe}
            usuario={usuario}
            podeEditar={podeEditar}
            aoAssumir={assumir}
            assumindo={assumindo}
            aoEnviar={enviarConteudo}
            enviando={enviando}
            aoAlterarStatus={alterarEtapa}
            alterandoStatus={alterandoStatus}
            aoAbrirTransferencia={abrirTransferencia}
            aoVoltar={() => {
              setSelecionado(null);
              setDetalhe(null);
            }}
          />
        ) : (
          <div className="conversation-welcome">
            <span><MessageCircleMore size={34} /></span>
            <h2>Selecione uma conversa</h2>
            <p>
              Escolha um atendimento na fila para visualizar o cliente,
              o histórico e os anexos.
            </p>
          </div>
        )}
      </div>

      {modalTransferencia && (
        <ModalTransferencia
          atendentes={atendentes}
          carregando={carregandoAtendentes}
          enviando={transferindo}
          aoFechar={() => setModalTransferencia(false)}
          aoConfirmar={confirmarTransferencia}
        />
      )}
    </div>
  );
}
