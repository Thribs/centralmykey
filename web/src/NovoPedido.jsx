import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  criarPedido,
  listarClientes,
  listarServicos
} from './api';

const INICIAL = {
  cliente_id: '',
  servico_id: '',
  placa: '',
  chassi: '',
  marca: '',
  modelo: '',
  ano: ''
};

export default function NovoPedido({
  token,
  aoFechar,
  aoCriado
}) {
  const [formulario, setFormulario] = useState(INICIAL);
  const [clientes, setClientes] = useState([]);
  const [servicos, setServicos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    Promise.all([
      listarClientes(token),
      listarServicos(token)
    ])
      .then(([respostaClientes, respostaServicos]) => {
        setClientes(
          (respostaClientes.dados || []).filter(item => item.ativo)
        );
        setServicos(
          (respostaServicos.dados || []).filter(item => item.ativo)
        );
      })
      .catch(falha => setErro(falha.message))
      .finally(() => setCarregando(false));
  }, [token]);

  function alterar(evento) {
    const { name, value } = evento.target;
    setFormulario(atual => ({ ...atual, [name]: value }));
  }

  async function enviar(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');

    try {
      const resposta = await criarPedido(token, formulario);
      aoCriado(resposta);
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="vault-overlay">
      <section className="vault-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <span>CENTRAL OPERACIONAL</span>
            <h2>Novo pedido</h2>
          </div>
          <button type="button" onClick={aoFechar} aria-label="Fechar">
            <X size={20} />
          </button>
        </header>

        <form onSubmit={enviar}>
          {erro && <div className="vault-error">{erro}</div>}

          {carregando ? (
            <p>Carregando clientes e serviços...</p>
          ) : (
            <div className="vault-form-grid">
              <label className="wide">
                Cliente
                <select
                  name="cliente_id"
                  value={formulario.cliente_id}
                  onChange={alterar}
                  required
                >
                  <option value="">Selecione o cliente</option>
                  {clientes.map(cliente => (
                    <option key={cliente.id} value={cliente.id}>
                      {cliente.nome} — {cliente.cpf || cliente.cnpj || cliente.telefone}
                    </option>
                  ))}
                </select>
              </label>

              <label className="wide">
                Serviço
                <select
                  name="servico_id"
                  value={formulario.servico_id}
                  onChange={alterar}
                  required
                >
                  <option value="">Selecione o serviço</option>
                  {servicos.map(servico => (
                    <option key={servico.id} value={servico.id}>
                      {servico.nome} — {servico.moeda || 'BRL'} {servico.preco_base}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Chassi
                <input
                  name="chassi"
                  value={formulario.chassi}
                  onChange={alterar}
                  maxLength="30"
                />
              </label>

              <label>
                Placa para consulta
                <input
                  name="placa"
                  value={formulario.placa}
                  onChange={alterar}
                  maxLength="10"
                  autoComplete="off"
                />
                <small>A placa não será armazenada.</small>
              </label>

              <label>
                Marca
                <input
                  name="marca"
                  value={formulario.marca}
                  onChange={alterar}
                />
              </label>

              <label>
                Modelo
                <input
                  name="modelo"
                  value={formulario.modelo}
                  onChange={alterar}
                />
              </label>

              <label>
                Ano
                <input
                  type="number"
                  name="ano"
                  value={formulario.ano}
                  onChange={alterar}
                  min="1900"
                  max="2100"
                />
              </label>
            </div>
          )}

          <footer>
            <button
              type="button"
              className="vault-secondary"
              onClick={aoFechar}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="vault-primary"
              disabled={carregando || salvando}
            >
              {salvando ? 'Criando...' : 'Criar pedido'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
