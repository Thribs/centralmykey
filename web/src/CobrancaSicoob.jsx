import { useState } from 'react';
import { Check, Clipboard, LoaderCircle, QrCode, X } from 'lucide-react';
import { criarCobrancaSicoob } from './api';

function dinheiro(valor, moeda) {
  return Number(valor || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: moeda || 'BRL'
  });
}

export default function CobrancaSicoob({ token, pedido, aoFechar }) {
  const [solicitacao, setSolicitacao] = useState('');
  const [cobranca, setCobranca] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [erro, setErro] = useState('');

  async function gerar(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');
    try {
      const resposta = await criarCobrancaSicoob(token, pedido.id, {
        expiracao_segundos: 3600,
        solicitacao_pagador: solicitacao.trim() || null
      });
      setCobranca(resposta);
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(cobranca.pix_copia_cola);
      setCopiado(true);
      window.setTimeout(() => setCopiado(false), 2500);
    } catch {
      setErro('Não foi possível copiar automaticamente. Selecione o código Pix abaixo.');
    }
  }

  return (
    <div className="vault-overlay" role="presentation">
      <form
        className="vault-modal payment-modal sicoob-modal"
        onSubmit={gerar}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sicoob-charge-title"
      >
        <header>
          <div>
            <span>CENTRAL FINANCEIRA</span>
            <h2 id="sicoob-charge-title">Gerar cobrança Pix Sicoob</h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar" disabled={salvando}>
            <X size={20} />
          </button>
        </header>

        <div className="vault-modal-body">
          <div className="payment-summary">
            <QrCode size={22} />
            <div>
              <span>{pedido.protocolo}</span>
              <strong>{dinheiro(pedido.valor_venda, pedido.moeda)}</strong>
              <small>Validade da cobrança: 1 hora</small>
            </div>
          </div>

          {erro && <div className="orders-error">{erro}</div>}

          {cobranca ? (
            <div className="sicoob-result" aria-live="polite">
              <p className="sicoob-success">
                <Check size={18} /> Cobrança registrada no Sicoob
              </p>
              <label>
                Pix copia e cola
                <textarea
                  value={cobranca.pix_copia_cola || ''}
                  readOnly
                  rows={5}
                  aria-label="Pix copia e cola"
                />
              </label>
              <button type="button" className="sicoob-copy-button" onClick={copiar}>
                {copiado ? <Check size={17} /> : <Clipboard size={17} />}
                {copiado ? 'Código copiado' : 'Copiar código Pix'}
              </button>
              <dl>
                <div><dt>Txid</dt><dd>{cobranca.txid}</dd></div>
                <div><dt>Status</dt><dd>{cobranca.status}</dd></div>
              </dl>
            </div>
          ) : (
            <label className="sicoob-request">
              Mensagem ao pagador (opcional)
              <input
                value={solicitacao}
                onChange={evento => setSolicitacao(evento.target.value)}
                maxLength={140}
                placeholder="Ex.: Pagamento do pedido"
                disabled={salvando}
              />
            </label>
          )}
        </div>

        <footer>
          <button type="button" onClick={aoFechar} disabled={salvando}>
            {cobranca ? 'Fechar' : 'Cancelar'}
          </button>
          {!cobranca && (
            <button type="submit" disabled={salvando}>
              {salvando ? <><LoaderCircle className="operation-spinner" size={17} /> Gerando...</> : 'Gerar Pix'}
            </button>
          )}
        </footer>
      </form>
    </div>
  );
}
