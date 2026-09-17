import { useState } from 'react';
import { CheckCircle2, ShieldX, X } from 'lucide-react';
import { confirmarResultadoPedido, marcarResultadoIncorreto } from './api';

export default function ValidarResultado({ token, pedido, modo, aoFechar, aoConcluido }) {
  const incorreto = modo === 'INCORRETO';
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  async function confirmar(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');

    try {
      if (incorreto) {
        if (motivo.trim().length < 5) {
          throw new Error('Informe o motivo do resultado incorreto.');
        }
        await marcarResultadoIncorreto(token, pedido.id, motivo.trim());
      } else {
        await confirmarResultadoPedido(token, pedido.id);
      }
      aoConcluido();
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="vault-overlay gm-result-overlay">
      <section className="vault-modal gm-validation-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <span>VALIDAÇÃO DA SENHA GM</span>
            <h2>{incorreto ? 'Informar erro' : 'Confirmar funcionamento'}</h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar" disabled={salvando}>
            <X size={20} />
          </button>
        </header>

        <form onSubmit={confirmar}>
          {erro && <div className="vault-error">{erro}</div>}

          <div className={`gm-validation-alert ${incorreto ? 'is-error' : 'is-success'}`}>
            {incorreto ? <ShieldX size={24} /> : <CheckCircle2 size={24} />}
            <div>
              <strong>{pedido.protocolo}</strong>
              <span>
                {incorreto
                  ? 'A senha usada será bloqueada e o pedido seguirá para o próximo fornecedor disponível.'
                  : 'A senha será marcada como confirmada e permanecerá disponível no cache.'}
              </span>
            </div>
          </div>

          {incorreto && (
            <label>
              Motivo do erro
              <textarea
                value={motivo}
                onChange={evento => setMotivo(evento.target.value)}
                placeholder="Ex.: código mecânico não funcionou"
                rows="3"
                required
              />
            </label>
          )}

          <footer>
            <button type="button" className="vault-secondary" onClick={aoFechar} disabled={salvando}>
              Voltar
            </button>
            <button type="submit" className={incorreto ? 'gm-danger-button' : 'vault-primary'} disabled={salvando}>
              {salvando
                ? 'Processando...'
                : incorreto
                  ? 'Confirmar resultado incorreto'
                  : 'Confirmar senha correta'}
            </button>
          </footer>
        </form>

        {salvando && (
          <div className="operation-overlay" role="status" aria-live="polite">
            <span className="operation-spinner" />
            <strong>Atualizando pedido e cache...</strong>
          </div>
        )}
      </section>
    </div>
  );
}
