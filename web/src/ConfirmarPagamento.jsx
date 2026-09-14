import { useState } from 'react';
import { CircleDollarSign, X } from 'lucide-react';
import { confirmarPagamentoManual } from './api';

export default function ConfirmarPagamento({
  token,
  pedido,
  aoFechar,
  aoConfirmado
}) {
  const [meio, setMeio] = useState('PIX');
  const [referencia, setReferencia] = useState('');
  const [observacao, setObservacao] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  async function confirmar(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');

    try {
      await confirmarPagamentoManual(token, pedido.id, {
        meio_pagamento: meio,
        referencia_externa: referencia.trim(),
        observacao: observacao.trim() || null
      });
      await aoConfirmado();
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="vault-overlay" role="presentation">
      <form className="vault-modal payment-modal" onSubmit={confirmar}>
        <header>
          <div>
            <span>CENTRAL FINANCEIRA</span>
            <h2>Confirmar pagamento</h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar">
            <X size={20} />
          </button>
        </header>

        <div className="vault-modal-body">
          <div className="payment-summary">
            <CircleDollarSign size={22} />
            <div>
              <span>{pedido.protocolo}</span>
              <strong>
                {Number(pedido.valor_venda || 0).toLocaleString('pt-BR', {
                  style: 'currency',
                  currency: pedido.moeda || 'BRL'
                })}
              </strong>
            </div>
          </div>

          {erro && <div className="orders-error">{erro}</div>}

          <div className="vault-form-grid">
            <label>
              Meio de pagamento
              <select
                value={meio}
                onChange={evento => setMeio(evento.target.value)}
                required
              >
                <option value="PIX">PIX</option>
                <option value="SICOOB">Sicoob</option>
                <option value="PLUGPAY">PlugPay</option>
                <option value="WBUY">WBuy</option>
                <option value="CARTAO">Cartão</option>
                <option value="DINHEIRO">Dinheiro</option>
                <option value="TRANSFERENCIA">Transferência</option>
                <option value="OUTRO">Outro</option>
              </select>
            </label>

            <label>
              Referência do pagamento
              <input
                value={referencia}
                onChange={evento => setReferencia(evento.target.value)}
                placeholder="Ex.: PIX recebido às 13:10"
                maxLength={120}
                required
              />
            </label>

            <label className="wide">
              Observação
              <textarea
                value={observacao}
                onChange={evento => setObservacao(evento.target.value)}
                placeholder="Informação opcional"
                rows={3}
              />
            </label>
          </div>
        </div>

        <footer>
          <button type="button" onClick={aoFechar} disabled={salvando}>
            Cancelar
          </button>
          <button type="submit" disabled={salvando || !referencia.trim()}>
            {salvando ? 'Confirmando...' : 'Confirmar pagamento'}
          </button>
        </footer>
      </form>
    </div>
  );
}
