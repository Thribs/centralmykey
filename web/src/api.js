export const API_URL =
  import.meta.env.VITE_API_URL ||
  'https://api-central.aiepires.com.br';

async function lerResposta(resposta) {
  const dados = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const erro = new Error(
      dados.error || 'Não foi possível concluir a solicitação'
    );
    erro.status = resposta.status;
    throw erro;
  }

  return dados;
}

export async function fazerLogin(login, senha) {
  const resposta = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ login, senha })
  });

  return lerResposta(resposta);
}

export async function buscarSessao(token) {
  const resposta = await fetch(`${API_URL}/api/auth/me`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return lerResposta(resposta);
}


export async function trocarSenha(token, senhaAtual, novaSenha) {
  const resposta = await fetch(`${API_URL}/api/auth/trocar-senha`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      senha_atual: senhaAtual,
      nova_senha: novaSenha
    })
  });

  return lerResposta(resposta);
}


function cabecalhoAutenticado(token, adicionais = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...adicionais
  };
}

export async function listarAtendimentos(token, filtros = {}) {
  const parametros = new URLSearchParams();

  if (filtros.status) parametros.set('status', filtros.status);
  if (filtros.modo) parametros.set('modo', filtros.modo);
  if (filtros.meus) parametros.set('meus', 'true');
  if (filtros.busca) parametros.set('busca', filtros.busca);

  const consulta = parametros.toString();
  const resposta = await fetch(
    `${API_URL}/api/atendimentos${consulta ? `?${consulta}` : ''}`,
    {
      headers: cabecalhoAutenticado(token)
    }
  );

  return lerResposta(resposta);
}

export async function buscarAtendimento(token, atendimentoId) {
  const resposta = await fetch(
    `${API_URL}/api/atendimentos/${atendimentoId}`,
    {
      headers: cabecalhoAutenticado(token)
    }
  );

  return lerResposta(resposta);
}

export async function assumirAtendimento(token, atendimentoId) {
  const resposta = await fetch(
    `${API_URL}/api/atendimentos/${atendimentoId}/assumir`,
    {
      method: 'POST',
      headers: cabecalhoAutenticado(token)
    }
  );

  return lerResposta(resposta);
}


export async function enviarNotaInterna(token, atendimentoId, texto) {
  const resposta = await fetch(
    `${API_URL}/api/atendimentos/${atendimentoId}/mensagens/interna`,
    {
      method: 'POST',
      headers: cabecalhoAutenticado(token, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ texto })
    }
  );

  return lerResposta(resposta);
}

export async function enviarMensagemWhatsapp(
  token,
  atendimentoId,
  texto
) {
  const resposta = await fetch(
    `${API_URL}/api/atendimentos/${atendimentoId}/mensagens/whatsapp`,
    {
      method: 'POST',
      headers: cabecalhoAutenticado(token, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ texto })
    }
  );

  return lerResposta(resposta);
}


export async function alterarStatusAtendimento(
  token,
  atendimentoId,
  status,
  observacao = ''
) {
  const resposta = await fetch(
    `${API_URL}/api/atendimentos/${atendimentoId}/status`,
    {
      method: 'PATCH',
      headers: cabecalhoAutenticado(token, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ status, observacao })
    }
  );

  return lerResposta(resposta);
}


export async function listarAtendentesDisponiveis(token) {
  const resposta = await fetch(
    `${API_URL}/api/atendentes-disponiveis`,
    {
      headers: cabecalhoAutenticado(token)
    }
  );

  return lerResposta(resposta);
}

export async function transferirAtendimento(
  token,
  atendimentoId,
  paraUsuarioId,
  motivo
) {
  const resposta = await fetch(
    `${API_URL}/api/atendimentos/${atendimentoId}/transferir`,
    {
      method: 'POST',
      headers: cabecalhoAutenticado(token, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({
        para_usuario_id: Number(paraUsuarioId),
        motivo
      })
    }
  );

  return lerResposta(resposta);
}

export async function buscarResumoPedidos(token) {
  const resposta = await fetch(
    `${API_URL}/api/fila-pedidos/resumo`,
    {
      headers: cabecalhoAutenticado(token)
    }
  );

  return lerResposta(resposta);
}

export async function listarFilaPedidos(token, filtros = {}) {
  const parametros = new URLSearchParams();

  if (filtros.status) {
    parametros.set('status', filtros.status);
  }

  if (filtros.busca) {
    parametros.set('busca', filtros.busca);
  }

  if (filtros.fornecedorId) {
    parametros.set('fornecedor_id', filtros.fornecedorId);
  }

  if (filtros.clienteId) {
    parametros.set('cliente_id', filtros.clienteId);
  }

  parametros.set('pagina', String(filtros.pagina || 1));
  parametros.set('limite', String(filtros.limite || 50));

  const resposta = await fetch(
    `${API_URL}/api/fila-pedidos?${parametros.toString()}`,
    {
      headers: cabecalhoAutenticado(token)
    }
  );

  return lerResposta(resposta);
}

export async function buscarPedido(token, pedidoId) {
  const resposta = await fetch(
    `${API_URL}/api/pedidos/${pedidoId}`,
    {
      headers: cabecalhoAutenticado(token)
    }
  );

  return lerResposta(resposta);
}


export async function buscarResumoBancoSenhas(token) {
  const resposta = await fetch(`${API_URL}/api/banco-senhas/resumo`, {
    headers: cabecalhoAutenticado(token)
  });

  return lerResposta(resposta);
}

export async function listarOrigensSenha(token) {
  const resposta = await fetch(`${API_URL}/api/origens-senha`, {
    headers: cabecalhoAutenticado(token)
  });

  return lerResposta(resposta);
}

export async function listarBancoSenhas(token, filtros = {}) {
  const parametros = new URLSearchParams();

  if (filtros.busca) parametros.set('busca', filtros.busca);
  if (filtros.marca) parametros.set('marca', filtros.marca);
  if (filtros.origemId) parametros.set('origem_id', filtros.origemId);
  if (filtros.confiabilidade) {
    parametros.set('confiabilidade', filtros.confiabilidade);
  }
  if (filtros.ativo !== '') parametros.set('ativo', filtros.ativo);

  parametros.set('pagina', String(filtros.pagina || 1));
  parametros.set('limite', String(filtros.limite || 50));

  const resposta = await fetch(
    `${API_URL}/api/banco-senhas?${parametros.toString()}`,
    { headers: cabecalhoAutenticado(token) }
  );

  return lerResposta(resposta);
}

export async function cadastrarSenha(token, dados) {
  const resposta = await fetch(`${API_URL}/api/banco-senhas`, {
    method: 'POST',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(dados)
  });

  return lerResposta(resposta);
}

export async function atualizarSenha(token, senhaId, dados) {
  const resposta = await fetch(
    `${API_URL}/api/banco-senhas/${senhaId}`,
    {
      method: 'PUT',
      headers: cabecalhoAutenticado(token, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify(dados)
    }
  );

  return lerResposta(resposta);
}

export async function alterarStatusSenha(token, senhaId, ativo) {
  const resposta = await fetch(
    `${API_URL}/api/banco-senhas/${senhaId}/status`,
    {
      method: 'PATCH',
      headers: cabecalhoAutenticado(token, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ ativo })
    }
  );

  return lerResposta(resposta);
}


export async function listarClientes(token, busca = '') {
  const parametros = new URLSearchParams();
  if (busca) parametros.set('busca', busca);

  const resposta = await fetch(
    `${API_URL}/api/clientes?${parametros.toString()}`,
    { headers: cabecalhoAutenticado(token) }
  );

  return lerResposta(resposta);
}

export async function buscarResumoClientes(token) {
  const resposta = await fetch(`${API_URL}/api/clientes-resumo`, {
    headers: cabecalhoAutenticado(token)
  });

  return lerResposta(resposta);
}

export async function cadastrarCliente(token, dados) {
  const resposta = await fetch(`${API_URL}/api/clientes`, {
    method: 'POST',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(dados)
  });

  return lerResposta(resposta);
}

export async function atualizarCliente(token, id, dados) {
  const resposta = await fetch(`${API_URL}/api/clientes/${id}`, {
    method: 'PUT',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(dados)
  });

  return lerResposta(resposta);
}

export async function alterarStatusCliente(token, id, ativo) {
  const resposta = await fetch(`${API_URL}/api/clientes/${id}/status`, {
    method: 'PATCH',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({ ativo })
  });

  return lerResposta(resposta);
}

export async function listarFornecedores(token) {
  const resposta = await fetch(`${API_URL}/api/fornecedores`, {
    headers: cabecalhoAutenticado(token)
  });

  return lerResposta(resposta);
}

export async function buscarResumoFornecedores(token) {
  const resposta = await fetch(`${API_URL}/api/fornecedores-resumo`, {
    headers: cabecalhoAutenticado(token)
  });

  return lerResposta(resposta);
}

export async function cadastrarFornecedor(token, dados) {
  const resposta = await fetch(`${API_URL}/api/fornecedores`, {
    method: 'POST',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(dados)
  });

  return lerResposta(resposta);
}

export async function atualizarFornecedor(token, id, dados) {
  const resposta = await fetch(`${API_URL}/api/fornecedores/${id}`, {
    method: 'PUT',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(dados)
  });

  return lerResposta(resposta);
}

export async function alterarStatusFornecedor(token, id, ativo) {
  const resposta = await fetch(
    `${API_URL}/api/fornecedores/${id}/status`,
    {
      method: 'PATCH',
      headers: cabecalhoAutenticado(token, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ ativo })
    }
  );

  return lerResposta(resposta);
}


export async function buscarResumoFinanceiro(token) {
  const resposta = await fetch(`${API_URL}/api/financeiro/resumo`, {
    headers: cabecalhoAutenticado(token)
  });

  return lerResposta(resposta);
}

export async function listarLancamentosFinanceiros(token, filtros = {}) {
  const parametros = new URLSearchParams();

  if (filtros.busca) parametros.set('busca', filtros.busca);
  if (filtros.tipo) parametros.set('tipo', filtros.tipo);
  if (filtros.status) parametros.set('status', filtros.status);
  if (filtros.moeda) parametros.set('moeda', filtros.moeda);

  const resposta = await fetch(
    `${API_URL}/api/lancamentos-financeiros?${parametros.toString()}`,
    { headers: cabecalhoAutenticado(token) }
  );

  return lerResposta(resposta);
}

export async function listarFaturas(token, filtros = {}) {
  const parametros = new URLSearchParams();

  if (filtros.status) parametros.set('status', filtros.status);
  if (filtros.clienteId) {
    parametros.set('cliente_id', filtros.clienteId);
  }

  const resposta = await fetch(
    `${API_URL}/api/faturas?${parametros.toString()}`,
    { headers: cabecalhoAutenticado(token) }
  );

  return lerResposta(resposta);
}

export async function buscarFatura(token, faturaId) {
  const resposta = await fetch(`${API_URL}/api/faturas/${faturaId}`, {
    headers: cabecalhoAutenticado(token)
  });

  return lerResposta(resposta);
}

export async function buscarRelatorioOperacional(token, filtros = {}) {
  const parametros = new URLSearchParams();

  if (filtros.inicio) parametros.set('inicio', filtros.inicio);
  if (filtros.fim) parametros.set('fim', filtros.fim);

  const resposta = await fetch(
    `${API_URL}/api/relatorios/operacional?${parametros.toString()}`,
    { headers: cabecalhoAutenticado(token) }
  );

  return lerResposta(resposta);
}


export async function listarUsuarios(token) {
  const resposta = await fetch(`${API_URL}/api/usuarios`, {
    headers: cabecalhoAutenticado(token)
  });
  return lerResposta(resposta);
}

export async function listarPerfis(token) {
  const resposta = await fetch(`${API_URL}/api/perfis`, {
    headers: cabecalhoAutenticado(token)
  });
  return lerResposta(resposta);
}

export async function buscarResumoUsuarios(token) {
  const resposta = await fetch(`${API_URL}/api/usuarios-resumo`, {
    headers: cabecalhoAutenticado(token)
  });
  return lerResposta(resposta);
}

export async function cadastrarUsuario(token, dados) {
  const resposta = await fetch(`${API_URL}/api/usuarios`, {
    method: 'POST',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(dados)
  });
  return lerResposta(resposta);
}

export async function atualizarUsuario(token, id, dados) {
  const resposta = await fetch(`${API_URL}/api/usuarios/${id}`, {
    method: 'PUT',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(dados)
  });
  return lerResposta(resposta);
}

export async function alterarStatusUsuario(token, id, status) {
  const resposta = await fetch(`${API_URL}/api/usuarios/${id}/status`, {
    method: 'PATCH',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({ status })
  });
  return lerResposta(resposta);
}

export async function buscarPermissoesUsuario(token, id) {
  const resposta = await fetch(`${API_URL}/api/usuarios/${id}/permissoes`, {
    headers: cabecalhoAutenticado(token)
  });
  return lerResposta(resposta);
}

export async function salvarPermissoesUsuario(token, id, permissoes) {
  const resposta = await fetch(`${API_URL}/api/usuarios/${id}/permissoes`, {
    method: 'PUT',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({ permissoes })
  });
  return lerResposta(resposta);
}

export async function buscarIntegracoes(token) {
  const resposta = await fetch(`${API_URL}/api/integracoes/resumo`, {
    headers: cabecalhoAutenticado(token)
  });
  return lerResposta(resposta);
}

export async function listarModelosWhatsapp(token) {
  const resposta = await fetch(`${API_URL}/api/whatsapp/modelos`, {
    headers: cabecalhoAutenticado(token)
  });
  return lerResposta(resposta);
}

export async function cadastrarModeloWhatsapp(token, dados) {
  const resposta = await fetch(`${API_URL}/api/whatsapp/modelos`, {
    method: 'POST',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(dados)
  });
  return lerResposta(resposta);
}

export async function alterarModeloWhatsapp(token, id, dados) {
  const resposta = await fetch(
    `${API_URL}/api/whatsapp/modelos/${id}/status`,
    {
      method: 'PATCH',
      headers: cabecalhoAutenticado(token, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify(dados)
    }
  );
  return lerResposta(resposta);
}

export async function listarConfiguracoesSeguras(token) {
  const resposta = await fetch(`${API_URL}/api/configuracoes-seguras`, {
    headers: cabecalhoAutenticado(token)
  });
  return lerResposta(resposta);
}

export async function salvarConfiguracao(token, chave, dados) {
  const resposta = await fetch(
    `${API_URL}/api/configuracoes/${encodeURIComponent(chave)}`,
    {
      method: 'PUT',
      headers: cabecalhoAutenticado(token, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify(dados)
    }
  );
  return lerResposta(resposta);
}

export async function buscarStatusOpenAI(token) {
  const resposta = await fetch(`${API_URL}/api/openai/status`, {
    headers: cabecalhoAutenticado(token)
  });
  return lerResposta(resposta);
}

export async function testarOpenAI(token, pergunta) {
  const resposta = await fetch(`${API_URL}/api/openai/teste`, {
    method: 'POST',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({ pergunta })
  });
  return lerResposta(resposta);
}



export async function analisarAtendimentoOpenAI(token, mensagem) {
  const resposta = await fetch(
    `${API_URL}/api/openai/analisar-atendimento`,
    {
      method: 'POST',
      headers: cabecalhoAutenticado(token, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ mensagem })
    }
  );

  return lerResposta(resposta);
}


export async function consultarBancoSenhaExato(token, chassi) {
  const parametros = new URLSearchParams({ chassi });

  const resposta = await fetch(
    `${API_URL}/api/banco-senhas/consulta-exata?${parametros}`,
    {
      headers: cabecalhoAutenticado(token)
    }
  );

  return lerResposta(resposta);
}

export async function listarServicos(token) {
  const resposta = await fetch(`${API_URL}/api/servicos`, {
    headers: cabecalhoAutenticado(token)
  });

  return lerResposta(resposta);
}

export async function criarPedido(token, dados) {
  const resposta = await fetch(`${API_URL}/api/pedidos`, {
    method: 'POST',
    headers: cabecalhoAutenticado(token, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(dados)
  });

  return lerResposta(resposta);
}

export async function confirmarPagamentoManual(
  token,
  pedidoId,
  dados,
  { timeoutMs = 105000 } = {}
) {
  const controlador = new AbortController();
  const temporizador = window.setTimeout(
    () => controlador.abort(),
    timeoutMs
  );

  try {
    const resposta = await fetch(
      `${API_URL}/api/pedidos/${pedidoId}/pagamento/confirmar-manual`,
      {
        method: 'POST',
        headers: cabecalhoAutenticado(token, {
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify(dados),
        signal: controlador.signal
      }
    );

    return lerResposta(resposta);
  } catch (erro) {
    if (erro.name === 'AbortError') {
      throw new Error(
        'A confirmação ultrapassou 105 segundos. Atualize o pedido antes de tentar novamente para evitar pagamento duplicado.',
        { cause: erro }
      );
    }
    throw erro;
  } finally {
    window.clearTimeout(temporizador);
  }
}
