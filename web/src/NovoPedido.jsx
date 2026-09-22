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
  ano: '',
  comprador_nome: '',
  comprador_documento: '',
  comprador_telefone: '',
  comprador_email: '',
  pagador_nome: '',
  pagador_documento: '',
  pagador_telefone: '',
  pagador_email: ''
};

function precoParaCliente(servico, cliente) {
  const temPrecoVip = servico.preco_vip !== null &&
    servico.preco_vip !== undefined && servico.preco_vip !== '';
  const vip = Number(cliente?.vip_elegivel) === 1 && temPrecoVip;
  return {
    valor: vip ? servico.preco_vip : servico.preco_base,
    tabela: vip ? 'VIP' : 'BASE'
  };
}

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
  const [compradorEhCliente, setCompradorEhCliente] = useState(true);
  const [pagadorEhComprador, setPagadorEhComprador] = useState(true);
  const servicoSelecionado = servicos.find(
    item => String(item.id) === String(formulario.servico_id)
  ) || null;
  const clienteSelecionado = clientes.find(
    item => String(item.id) === String(formulario.cliente_id)
  ) || null;
  const exigeDocumento = Boolean(Number(servicoSelecionado?.exige_documento));
  const documentoClienteAusente = exigeDocumento && compradorEhCliente &&
    clienteSelecionado && !clienteSelecionado.cpf && !clienteSelecionado.cnpj;

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
    setFormulario(atual => {
      const proximo = { ...atual, [name]: value };
      if (name === 'servico_id') {
        const servico = servicos.find(item => String(item.id) === String(value));
        if (!Number(servico?.exige_placa)) proximo.placa = '';
        if (!Number(servico?.exige_chassi)) proximo.chassi = '';
      }
      return proximo;
    });
  }

  async function enviar(evento) {
    evento.preventDefault();
    setSalvando(true);
    setErro('');

    try {
      if (documentoClienteAusente) {
        throw new Error('O cliente selecionado não possui documento para este serviço');
      }
      const {
        comprador_nome,
        comprador_documento,
        comprador_telefone,
        comprador_email,
        pagador_nome,
        pagador_documento,
        pagador_telefone,
        pagador_email,
        ...pedido
      } = formulario;
      if (!compradorEhCliente) {
        pedido.comprador = {
          nome: comprador_nome,
          documento: comprador_documento,
          telefone: comprador_telefone,
          email: comprador_email
        };
      }
      if (!pagadorEhComprador) {
        pedido.pagador = {
          nome: pagador_nome,
          documento: pagador_documento,
          telefone: pagador_telefone,
          email: pagador_email
        };
      }
      const resposta = await criarPedido(token, pedido);
      aoCriado(resposta);
    } catch (falha) {
      setErro(falha.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="vault-overlay">
      <section
        className="vault-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-order-title"
      >
        <header>
          <div>
            <span>CENTRAL OPERACIONAL</span>
            <h2 id="new-order-title">Novo pedido</h2>
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
                  {servicos.map(servico => {
                    const preco = precoParaCliente(servico, clienteSelecionado);
                    return <option key={servico.id} value={servico.id}>
                      {servico.nome} — {preco.tabela === 'VIP' ? 'VIP ' : ''}
                      {servico.moeda || 'BRL'} {preco.valor}
                    </option>;
                  })}
                </select>
              </label>

              <div className="wide order-party-toggle">
                <label>
                  <input
                    type="checkbox"
                    checked={compradorEhCliente}
                    onChange={evento => setCompradorEhCliente(evento.target.checked)}
                  />
                  O comprador é o próprio cliente
                </label>
              </div>

              {!compradorEhCliente && (
                <>
                  <label>
                    Nome do comprador
                    <input name="comprador_nome" value={formulario.comprador_nome} onChange={alterar} required />
                  </label>
                  <label>
                    Documento do comprador
                    <input name="comprador_documento" value={formulario.comprador_documento}
                      onChange={alterar} maxLength="30" required={exigeDocumento} />
                  </label>
                  <label>
                    Telefone do comprador
                    <input name="comprador_telefone" value={formulario.comprador_telefone} onChange={alterar} maxLength="25" />
                  </label>
                  <label>
                    E-mail do comprador
                    <input type="email" name="comprador_email" value={formulario.comprador_email} onChange={alterar} maxLength="180" />
                  </label>
                </>
              )}

              <div className="wide order-party-toggle">
                <label>
                  <input
                    type="checkbox"
                    checked={pagadorEhComprador}
                    onChange={evento => setPagadorEhComprador(evento.target.checked)}
                  />
                  O pagador é o próprio comprador
                </label>
              </div>

              {!pagadorEhComprador && (
                <>
                  <label>
                    Nome do pagador
                    <input name="pagador_nome" value={formulario.pagador_nome} onChange={alterar} required />
                  </label>
                  <label>
                    Documento do pagador
                    <input name="pagador_documento" value={formulario.pagador_documento} onChange={alterar} maxLength="30" />
                  </label>
                  <label>
                    Telefone do pagador
                    <input name="pagador_telefone" value={formulario.pagador_telefone} onChange={alterar} maxLength="25" />
                  </label>
                  <label>
                    E-mail do pagador
                    <input type="email" name="pagador_email" value={formulario.pagador_email} onChange={alterar} maxLength="180" />
                  </label>
                </>
              )}

              {documentoClienteAusente && <div className="wide vault-error">
                O cliente selecionado não possui CPF/CNPJ, obrigatório para este serviço.
              </div>}

              {servicoSelecionado && <>
                {Boolean(Number(servicoSelecionado.exige_chassi)) && <label>
                  Chassi
                  <input name="chassi" value={formulario.chassi} onChange={alterar}
                    minLength="8" maxLength="30" required />
                </label>}

                {Boolean(Number(servicoSelecionado.exige_placa)) && <label>
                  Placa para consulta
                  <input name="placa" value={formulario.placa} onChange={alterar}
                    maxLength="10" autoComplete="off" required />
                  <small>A placa não será armazenada.</small>
                </label>}

                <label>Marca
                  <input name="marca" value={formulario.marca} onChange={alterar} />
                </label>
                <label>Modelo
                  <input name="modelo" value={formulario.modelo} onChange={alterar} />
                </label>
                <label>Ano
                  <input type="number" name="ano" value={formulario.ano}
                    onChange={alterar} min="1900" max="2100" />
                </label>
              </>}
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
              disabled={carregando || salvando || Boolean(documentoClienteAusente)}
            >
              {salvando ? 'Criando...' : 'Criar pedido'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
