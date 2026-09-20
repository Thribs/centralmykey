import { useState } from 'react';
import { CarFront, X } from 'lucide-react';
import { corrigirDadosPedido } from './api';

export default function CorrigirDadosPedido({ token, pedido, aoFechar, aoSalvo }) {
  const [formulario, setFormulario] = useState({
    chassi: pedido.chassi || '',
    marca: pedido.marca || 'GM',
    modelo: pedido.modelo || '',
    ano: pedido.ano || ''
  });
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  function alterar(evento) {
    const { name, value } = evento.target;
    setFormulario(atual => ({
      ...atual,
      [name]: name === 'ano' ? value : value.trimStart().toUpperCase()
    }));
  }

  async function enviar(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');
    try {
      await corrigirDadosPedido(token, pedido.id, {
        ...formulario,
        ano: Number(formulario.ano)
      });
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
            <span>CORRIGIR DADOS DO VEÍCULO</span>
            <h2>{pedido.protocolo}</h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar" disabled={salvando}>
            <X size={20} />
          </button>
        </header>

        <form onSubmit={enviar}>
          {erro && <div className="vault-error">{erro}</div>}
          <div className="gm-result-summary">
            <CarFront size={22} />
            <div>
              <strong>Revise os dados rejeitados pela API</strong>
              <span>Ao salvar, a consulta será processada novamente.</span>
            </div>
          </div>
          <div className="vault-form-grid">
            <label className="wide">
              Chassi
              <input
                name="chassi"
                value={formulario.chassi}
                onChange={alterar}
                minLength="8"
                maxLength="30"
                required
                autoFocus
              />
            </label>
            <label>
              Marca
              <input name="marca" value={formulario.marca} onChange={alterar} required />
            </label>
            <label>
              Modelo
              <input name="modelo" value={formulario.modelo} onChange={alterar} required />
            </label>
            <label>
              Ano
              <input
                type="number"
                name="ano"
                value={formulario.ano}
                onChange={alterar}
                min="1900"
                max={new Date().getFullYear() + 2}
                required
              />
            </label>
          </div>
          <small className="gm-result-note">
            A correção e o reprocessamento acontecem na mesma transação.
          </small>
          <footer>
            <button type="button" className="vault-secondary" onClick={aoFechar} disabled={salvando}>
              Cancelar
            </button>
            <button type="submit" className="vault-primary" disabled={salvando}>
              {salvando ? 'Corrigindo e consultando...' : 'Salvar e consultar novamente'}
            </button>
          </footer>
        </form>

        {salvando && (
          <div className="operation-overlay" role="status" aria-live="polite">
            <span className="operation-spinner" />
            <strong>Consultando novamente...</strong>
          </div>
        )}
      </section>
    </div>
  );
}
