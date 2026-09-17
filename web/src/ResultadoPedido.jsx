import { useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { registrarResultadoPedido } from './api';

const INICIAL = {
  codigo_mecanico: '',
  codigo_imobilizador: '',
  codigo_radio: '',
  codigo_alarme: '',
  pin: ''
};

export default function ResultadoPedido({ token, pedido, aoFechar, aoSalvo }) {
  const [formulario, setFormulario] = useState(INICIAL);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  function alterar(evento) {
    const { name, value } = evento.target;
    setFormulario(atual => ({
      ...atual,
      [name]: value.trimStart().toUpperCase()
    }));
  }

  async function enviar(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');

    try {
      await registrarResultadoPedido(token, pedido.id, formulario);
      aoSalvo();
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="vault-overlay gm-result-overlay">
      <section className="vault-modal gm-result-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <span>RESULTADO DO FORNECEDOR</span>
            <h2>{pedido.protocolo}</h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar" disabled={salvando}>
            <X size={20} />
          </button>
        </header>

        <form onSubmit={enviar}>
          {erro && <div className="vault-error">{erro}</div>}

          <div className="gm-result-summary">
            <KeyRound size={22} />
            <div>
              <strong>{pedido.fornecedor || 'Fornecedor não definido'}</strong>
              <span>GM · final {String(pedido.chassi || '').slice(-8)}</span>
            </div>
          </div>

          <div className="vault-form-grid">
            <label>
              Código mecânico
              <input name="codigo_mecanico" value={formulario.codigo_mecanico} onChange={alterar} />
            </label>
            <label>
              Imobilizador
              <input name="codigo_imobilizador" value={formulario.codigo_imobilizador} onChange={alterar} />
            </label>
            <label>
              Alarme
              <input name="codigo_alarme" value={formulario.codigo_alarme} onChange={alterar} />
            </label>
            <label>
              Rádio
              <input name="codigo_radio" value={formulario.codigo_radio} onChange={alterar} />
            </label>
            <label>
              PIN
              <input name="pin" value={formulario.pin} onChange={alterar} />
            </label>
          </div>

          <small className="gm-result-note">
            Após salvar, confirme com o cliente antes de adicionar a senha ao cache.
          </small>

          <footer>
            <button type="button" className="vault-secondary" onClick={aoFechar} disabled={salvando}>
              Cancelar
            </button>
            <button type="submit" className="vault-primary" disabled={salvando}>
              {salvando ? 'Salvando resultado...' : 'Salvar resultado'}
            </button>
          </footer>
        </form>

        {salvando && (
          <div className="operation-overlay" role="status" aria-live="polite">
            <span className="operation-spinner" />
            <strong>Registrando resultado...</strong>
          </div>
        )}
      </section>
    </div>
  );
}
