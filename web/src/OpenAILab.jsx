import { useState } from 'react';
import {
  Bot,
  CheckCircle2,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import {
  analisarAtendimentoOpenAI,
  buscarStatusOpenAI,
  consultarBancoSenhaExato,
  testarOpenAI
} from './api';

export default function OpenAILab() {
  const [pergunta, setPergunta] = useState(
    'Um cliente pediu uma senha automotiva, mas não informou o chassi. Como devo responder?'
  );
  const [resposta, setResposta] = useState('');
  const [analise, setAnalise] = useState(null);
  const [consultaBanco, setConsultaBanco] = useState(null);
  const [bancoAcessado, setBancoAcessado] = useState(false);
  const [status, setStatus] = useState(null);
  const [erro, setErro] = useState('');
   const [acaoAtual, setAcaoAtual] = useState('');

  const token = localStorage.getItem('central_mykey_token');
  const carregando = Boolean(acaoAtual);

  async function verificarConexao() {
    try {
      setAcaoAtual('status');
      setErro('');
      const resultado = await buscarStatusOpenAI(token);
      setStatus(resultado);
    } catch (falha) {
      setErro(falha.message || 'Não foi possível verificar a OpenAI.');
    } finally {
      setAcaoAtual('');
    }
  }

  function validarPergunta() {
    if (!pergunta.trim()) {
      setErro('Digite uma mensagem.');
      return false;
    }

    return true;
  }

  async function enviarPergunta(evento) {
    evento.preventDefault();

    if (!validarPergunta()) return;

    try {
      setAcaoAtual('pergunta');
      setErro('');
      setResposta('');
      setAnalise(null);
      setConsultaBanco(null);

      const resultado = await testarOpenAI(
        token,
        pergunta.trim()
      );

      setResposta(resultado.resposta || '');
      setStatus({
        configurada: true,
        modelo: resultado.modelo,
        whatsapp_automatico: false
      });
    } catch (falha) {
      setErro(
        falha.message ||
        'A inteligência artificial não respondeu.'
      );
    } finally {
      setAcaoAtual('');
    }
  }

  async function analisarAtendimento() {
    if (!validarPergunta()) return;

    try {
      setAcaoAtual('analise');
      setErro('');
      setResposta('');
      setAnalise(null);
      setConsultaBanco(null);

      const resultado = await analisarAtendimentoOpenAI(
        token,
        pergunta.trim()
      );

      setAnalise(resultado.analise || null);
      setBancoAcessado(
        Boolean(resultado.banco_senhas_acessado)
      );
      setStatus({
        configurada: true,
        modelo: resultado.modelo,
        whatsapp_automatico: false
      });
    } catch (falha) {
      setErro(
        falha.message ||
        'Não foi possível analisar o atendimento.'
      );
    } finally {
      setAcaoAtual('');
    }
  }

  async function consultarBanco() {
    const chassi =
      analise?.dados_identificados?.chassi || '';

    if (!chassi) {
      setErro('A análise ainda não identificou um chassi válido.');
      return;
    }

    try {
      setAcaoAtual('consulta');
      setErro('');
      setConsultaBanco(null);

      const resultado = await consultarBancoSenhaExato(
        token,
        chassi
      );

      setConsultaBanco(resultado);
      setBancoAcessado(true);
    } catch (falha) {
      setErro(
        falha.message ||
        'Não foi possível consultar o banco MyKey.'
      );
    } finally {
      setAcaoAtual('');
    }
  }

  const dadosIdentificados = Object.entries(
    analise?.dados_identificados || {}
  ).filter(([, valor]) => valor);

  const codigosEncontrados = Object.entries({
    'Código mecânico':
      consultaBanco?.senha?.codigo_mecanico,
    'Código do rádio':
      consultaBanco?.senha?.codigo_radio,
    'Código do imobilizador':
      consultaBanco?.senha?.codigo_imobilizador,
    'Código do alarme':
      consultaBanco?.senha?.codigo_alarme,
    PIN:
      consultaBanco?.senha?.pin
  }).filter(([, valor]) => valor);

  return (
    <section className="openai-lab">
      <header className="openai-lab-header">
        <div className="openai-lab-icon">
          <Sparkles size={22} />
        </div>

        <div>
          <span>INTELIGÊNCIA ARTIFICIAL</span>
          <h2>Laboratório OpenAI</h2>
          <p>
            Teste interno protegido. Ainda não envia respostas ao WhatsApp.
          </p>
        </div>

        <button
          type="button"
          className="openai-status-button"
          onClick={verificarConexao}
          disabled={carregando}
        >
          <RefreshCw
            size={16}
            className={
              acaoAtual === 'status' ? 'openai-spinning' : ''
            }
          />
          Verificar conexão
        </button>
      </header>

      <div className="openai-security">
        <ShieldCheck size={18} />

        <div>
          <strong>Ambiente administrativo seguro</strong>
          <span>
            A chave permanece no servidor e nenhuma senha é enviada à OpenAI.
          </span>
        </div>

        {status?.configurada && (
          <div className="openai-connected">
            <CheckCircle2 size={15} />
            Conectada — {status.modelo}
          </div>
        )}
      </div>

      <form className="openai-form" onSubmit={enviarPergunta}>
        <label htmlFor="openai-pergunta">
          Mensagem ou pergunta para a inteligência artificial
        </label>

        <textarea
          id="openai-pergunta"
          value={pergunta}
          maxLength={2000}
          onChange={(evento) => setPergunta(evento.target.value)}
          placeholder="Cole ou digite a mensagem recebida do cliente"
        />

        <div className="openai-form-footer">
          <span>{pergunta.length}/2000 caracteres</span>

          <div className="openai-actions">
            <button
              type="button"
              className="openai-analysis-button"
              onClick={analisarAtendimento}
              disabled={carregando}
            >
              <Sparkles size={17} />
              {acaoAtual === 'analise'
                ? 'Analisando...'
                : 'Analisar atendimento'}
            </button>

            <button type="submit" disabled={carregando}>
              <Send size={17} />
              {acaoAtual === 'pergunta'
                ? 'Perguntando...'
                : 'Perguntar à OpenAI'}
            </button>
          </div>
        </div>
      </form>

      {erro && (
        <div className="openai-error">
          {erro}
        </div>
      )}

      {resposta && (
        <div className="openai-result">
          <h3>
            <Bot size={19} />
            Resposta da inteligência artificial
          </h3>
          <p>{resposta}</p>
        </div>
      )}

      {analise && (
        <div className="openai-analysis">
          <div className="openai-analysis-heading">
            <h3>
              <Bot size={19} />
              Análise do atendimento
            </h3>

            <span
              className={
                analise.pronto_para_consulta
                  ? 'openai-ready'
                  : 'openai-pending'
              }
            >
              {analise.pronto_para_consulta
                ? 'Pronto para consulta'
                : 'Aguardando informações'}
            </span>
          </div>

          <div className="openai-analysis-grid">
            <article>
              <strong>Intenção identificada</strong>
              <p>{analise.intencao}</p>
            </article>

            <article>
              <strong>Dados identificados</strong>

              {dadosIdentificados.length ? (
                <ul>
                  {dadosIdentificados.map(([campo, valor]) => (
                    <li key={campo}>
                      <span>{campo.replaceAll('_', ' ')}</span>
                      <b>{valor}</b>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Nenhum dado técnico identificado.</p>
              )}
            </article>

            <article>
              <strong>Dados que ainda faltam</strong>

              {analise.dados_faltantes?.length ? (
                <ul>
                  {analise.dados_faltantes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p>Nenhum dado pendente.</p>
              )}
            </article>
          </div>

          <div className="openai-suggested-answer">
            <strong>Resposta sugerida ao cliente</strong>
            <p>{analise.resposta_sugerida}</p>
          </div>

          {analise.pronto_para_consulta &&
            analise.dados_identificados?.chassi && (
              <div className="openai-bank-action">
                <button
                  type="button"
                  onClick={consultarBanco}
                  disabled={carregando}
                >
                  <ShieldCheck size={17} />
                  {acaoAtual === 'consulta'
                    ? 'Consultando banco...'
                    : 'Consultar banco MyKey'}
                </button>

                <span>
                  Busca exata pelo chassi identificado
                </span>
              </div>
            )}

          {consultaBanco && (
            <div
              className={
                consultaBanco.encontrada
                  ? 'openai-bank-result found'
                  : 'openai-bank-result not-found'
              }
            >
              <strong>
                {consultaBanco.encontrada
                  ? 'Senha encontrada no banco MyKey'
                  : 'Chassi não encontrado no banco MyKey'}
              </strong>

              {consultaBanco.encontrada ? (
                <>
                  <p>
                    {[
                      consultaBanco.senha?.marca,
                      consultaBanco.senha?.modelo
                    ].filter(Boolean).join(' — ')}
                  </p>

                  {codigosEncontrados.length ? (
                    <ul>
                      {codigosEncontrados.map(
                        ([campo, valor]) => (
                          <li key={campo}>
                            <span>{campo}</span>
                            <b>{valor}</b>
                          </li>
                        )
                      )}
                    </ul>
                  ) : (
                    <p>
                      O registro não possui códigos preenchidos.
                    </p>
                  )}

                  <small>
                    Confiabilidade:{' '}
                    {consultaBanco.senha?.confiabilidade}
                  </small>
                </>
              ) : (
                <p>{consultaBanco.mensagem}</p>
              )}
            </div>
          )}

          <div className="openai-bank-protection">
            <ShieldCheck size={17} />
            Banco de senhas acessado: {bancoAcessado ? 'SIM' : 'NÃO'}
          </div>
        </div>
      )}
    </section>
  );
}
