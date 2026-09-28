'use strict';

const { normalizarChassi } = require('./consulta-banco-senhas');
const { buscarSenhaFonteVerdade } = require('./consulta-api-joelpires');
const { calcularPrecoPedido } = require('./preco-pedido');
const { validarCPF, validarCNPJ } = require('./rotas-clientes');

const ACAO_ESTADO = 'ESTADO_AUTOMACAO_GM';

function normalizarTexto(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function identificaSenhaGm(texto) {
  const valor = normalizarTexto(texto);
  return /(SENHA|CODIGO).*(GM|CHEVROLET)|(GM|CHEVROLET).*(SENHA|CODIGO)/.test(valor);
}

function extrairChassi(texto) {
  const candidatos = normalizarTexto(texto).match(/[A-Z0-9]{8,30}/g) || [];
  for (const candidato of candidatos.sort((a, b) => b.length - a.length)) {
    try {
      const chassi = normalizarChassi(candidato);
      if (chassi) return chassi;
    } catch { /* tenta o próximo token */ }
  }
  return null;
}

function objetoJson(valor) {
  if (valor && typeof valor === 'object') return valor;
  try { return JSON.parse(String(valor || '{}')); } catch { return {}; }
}

function dinheiro(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', {
    style: 'currency', currency: 'BRL'
  });
}

function extrairCampo(texto, nomes) {
  const chaves = nomes.map(nome => nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const expressao = new RegExp(`(?:^|[\\n|;])\\s*(?:${chaves})\\s*:\\s*([^\\n|;]+)`, 'i');
  return String(texto || '').match(expressao)?.[1]?.trim() || null;
}

function extrairDadosFiscais(textoEntrada) {
  const texto = String(textoEntrada || '');
  const nome = extrairCampo(texto, ['NOME', 'RAZAO SOCIAL', 'RAZÃO SOCIAL']);
  const documentoInformado = extrairCampo(texto,
    ['CPF/CNPJ', 'CPF', 'CNPJ', 'DOCUMENTO']);
  const email = extrairCampo(texto, ['EMAIL', 'E-MAIL']);
  const cidade = extrairCampo(texto, ['CIDADE']);
  const documento = String(documentoInformado || '').replace(/\D/g, '');
  if (!nome || !documento || !email || !cidade) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const cpf = documento.length === 11 && validarCPF(documento) ? documento : null;
  const cnpj = documento.length === 14 && validarCNPJ(documento) ? documento : null;
  if (!cpf && !cnpj) return null;
  return {
    nome: nome.slice(0, 160), cpf, cnpj,
    documento: cpf || cnpj, email: email.slice(0, 160), cidade: cidade.slice(0, 120)
  };
}

async function lerEstado(connection, atendimentoId) {
  const [[linha]] = await connection.query(
    `SELECT dados_depois
       FROM auditoria
      WHERE entidade='atendimentos' AND entidade_id=? AND acao=?
      ORDER BY id DESC LIMIT 1`,
    [String(atendimentoId), ACAO_ESTADO]
  );
  return linha ? objetoJson(linha.dados_depois) : null;
}

async function registrarEstado(connection, atendimentoId, estado) {
  await connection.query(
    `INSERT INTO auditoria
       (usuario_id, modulo, acao, entidade, entidade_id, descricao,
        dados_antes, dados_depois)
     VALUES (NULL, 'ATENDIMENTO', ?, 'atendimentos', ?, ?, NULL, ?)`,
    [ACAO_ESTADO, String(atendimentoId),
      `Automação GM em ${estado.etapa}`, JSON.stringify({
        etapa: estado.etapa,
        pedido_id: estado.pedido_id || null,
        fonte_prevista: estado.fonte_prevista || null,
        tentativas: Number(estado.tentativas || 0),
        erro_codigo: estado.erro_codigo || null
      })]
  );
}

async function agendarMensagem(connection, atendimentoId, texto) {
  await connection.query(
    `INSERT INTO atendimento_mensagens
       (atendimento_id, direcao, autor_tipo, tipo_conteudo, texto,
        status_entrega)
     VALUES (?, 'SAIDA', 'IA', 'TEXTO', ?, 'PENDENTE')`,
    [atendimentoId, String(texto).slice(0, 5000)]
  );
}

async function encaminharHumanoConnection(connection, atendimentoId, codigo, detalhe) {
  const mensagem = String(detalhe || 'Automação GM requer atendimento humano').slice(0, 500);
  await connection.query(
    `UPDATE atendimentos
        SET modo='HUMANO', status='FILA', prioridade='ALTA', responsavel_id=NULL,
            assunto='Senha GM · revisão humana', ultima_mensagem_em=NOW()
      WHERE id=? AND status NOT IN ('FINALIZADO','CANCELADO')`,
    [atendimentoId]
  );
  await connection.query(
    `INSERT INTO atendimento_mensagens
       (atendimento_id, direcao, autor_tipo, tipo_conteudo, texto)
     VALUES (?, 'INTERNA', 'SISTEMA', 'TEXTO', ?)`,
    [atendimentoId, `Encaminhado para atendimento humano: ${mensagem}`]
  );
  await registrarEstado(connection, atendimentoId, {
    etapa: 'HUMANO', erro_codigo: String(codigo || 'AUTOMACAO_INTERROMPIDA').slice(0, 80)
  });
}

async function encaminharHumano(pool, atendimentoId, codigo, detalhe) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await encaminharHumanoConnection(connection, atendimentoId, codigo, detalhe);
    await connection.commit();
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally { connection.release(); }
}

async function consultarViabilidade(pool, clienteId, chassi) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[servico]] = await connection.query(
      `SELECT id, codigo, nome, marca, preco_base, preco_vip, moeda
         FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1`
    );
    const [[cliente]] = await connection.query(
      `SELECT c.id, c.nome, c.tipo_cobranca, c.credito_status,
              CASE WHEN vip.status='ATIVO' AND
                (vip.proximo_vencimento IS NULL OR vip.proximo_vencimento>=CURDATE())
                THEN 1 ELSE 0 END AS vip_elegivel
         FROM clientes c LEFT JOIN cliente_vip vip ON vip.cliente_id=c.id
        WHERE c.id=? AND c.ativo=1 LIMIT 1`, [clienteId]
    );
    if (!servico || !cliente) {
      const erro = new Error('Cliente ou serviço GM indisponível');
      erro.codigo = 'CADASTRO_GM_INDISPONIVEL';
      throw erro;
    }
    if (cliente.credito_status === 'BLOQUEADO') {
      const erro = new Error('Cadastro financeiro bloqueado');
      erro.codigo = 'CLIENTE_FINANCEIRO_BLOQUEADO';
      throw erro;
    }
    if (cliente.tipo_cobranca !== 'ANTECIPADO') {
      const erro = new Error(
        'Cliente possui faturamento semanal e exige tratamento comercial humano'
      );
      erro.codigo = 'CLIENTE_FORA_DO_FLUXO_PIX_ANTECIPADO';
      throw erro;
    }
    const preco = calcularPrecoPedido(servico, cliente);
    const consulta = await buscarSenhaFonteVerdade(connection, {
      chassi, codigoServico: servico.codigo, marca: servico.marca || 'GM'
    });
    if (consulta.status === 'NAO_ENCONTRADO') {
      const [[fornecedor]] = await connection.query(
        `SELECT fs.fornecedor_id
           FROM fornecedor_servicos fs JOIN fornecedores f ON f.id=fs.fornecedor_id
          WHERE fs.codigo_servico='GM_SENHA' AND fs.ativo=1 AND f.ativo=1
            AND (f.horario_inicio IS NULL OR f.horario_fim IS NULL OR
                 CURTIME() BETWEEN f.horario_inicio AND f.horario_fim)
          ORDER BY fs.custo, fs.fornecedor_id LIMIT 1`
      );
      if (!fornecedor) {
        const erro = new Error('Nenhum fornecedor GM está disponível neste horário');
        erro.codigo = 'FORNECEDOR_GM_INDISPONIVEL';
        throw erro;
      }
    } else if (consulta.status !== 'ENCONTRADO') {
      const erro = new Error(`Consulta GM interrompida em ${consulta.status}`);
      erro.codigo = `CONSULTA_GM_${consulta.status}`;
      throw erro;
    }
    await connection.commit();
    return {
      servico, cliente, preco,
      fontePrevista: consulta.status === 'ENCONTRADO'
        ? consulta.origem || 'API_JOELPIRES' : 'FORNECEDOR'
    };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally { connection.release(); }
}

async function solicitarDadosFiscais(pool, atendimentoId, pedido, fontePrevista) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE atendimentos SET status='AGUARDANDO_CLIENTE',
        assunto='Senha GM · aguardando dados fiscais' WHERE id=?`, [atendimentoId]
    );
    await registrarEstado(connection, atendimentoId, {
      etapa: 'AGUARDANDO_DADOS_FISCAIS', pedido_id: pedido.id,
      fonte_prevista: fontePrevista
    });
    await agendarMensagem(connection, atendimentoId,
      `A consulta custa ${dinheiro(pedido.valor_venda)}. Para emitir a nota fiscal, ` +
      'envie em uma mensagem: NOME: ... | CPF/CNPJ: ... | EMAIL: ... | CIDADE: ...');
    await connection.commit();
    return { automatizado: true, etapa: 'AGUARDANDO_DADOS_FISCAIS',
      pedido_id: pedido.id, status: pedido.status };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally { connection.release(); }
}

async function salvarDadosFiscais(connection, atendimento, estado, dados) {
  await connection.query(
    `UPDATE clientes SET nome=?, cpf=?, cpf_normalizado=?, cnpj=?,
      cnpj_normalizado=?, email=?, cidade=?, cadastro_status='COMPLETO'
     WHERE id=?`,
    [dados.nome, dados.cpf, dados.cpf, dados.cnpj, dados.cnpj,
      dados.email, dados.cidade, atendimento.cliente_id]
  );
  await connection.query(
    `UPDATE pedido_partes SET nome=?, documento=?, telefone=?, email=?
      WHERE pedido_id=? AND papel IN ('CLIENTE','COMPRADOR','PAGADOR')`,
    [dados.nome, dados.documento, atendimento.telefone_normalizado,
      dados.email, estado.pedido_id]
  );
  await connection.query(
    `INSERT INTO auditoria
       (usuario_id, modulo, acao, entidade, entidade_id, descricao,
        dados_antes, dados_depois)
     VALUES (NULL, 'ATENDIMENTO', 'DADOS_FISCAIS_AUTOMACAO', 'clientes', ?, ?, NULL, ?)`,
    [String(atendimento.cliente_id),
      'Dados fiscais recebidos pela automação GM',
      JSON.stringify({ nome: true, documento: true, email: true, cidade: true })]
  );
}

async function gerarCobrancaPix(pool, app, atendimentoId, pedidoId) {
  if (typeof app.locals.criarCobrancaSicoobInterna !== 'function') {
    await encaminharHumano(pool, atendimentoId, 'SICOOB_NAO_CONFIGURADO',
      'Rotina de cobrança Pix indisponível');
    return { automatizado: false, humano: true };
  }
  try {
    const cobranca = await app.locals.criarCobrancaSicoobInterna({
      pedidoId,
      solicitacaoPagador: `Central MyKey - pedido ${pedidoId}`
    });
    if (!cobranca.pix_copia_cola) {
      const erro = new Error('Cobrança criada sem código Pix copia e cola');
      erro.codigo = 'PIX_SEM_CODIGO';
      throw erro;
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        `UPDATE atendimentos SET status='AGUARDANDO_PAGAMENTO',
          assunto='Senha GM · aguardando Pix' WHERE id=?`, [atendimentoId]
      );
      await registrarEstado(connection, atendimentoId, {
        etapa: 'AGUARDANDO_PAGAMENTO', pedido_id: pedidoId
      });
      await agendarMensagem(connection, atendimentoId,
        `Pix copia e cola:\n${cobranca.pix_copia_cola}\n` +
        `Valor: ${dinheiro(cobranca.valor)}. A confirmação será automática.`);
      await connection.commit();
    } catch (erro) {
      await connection.rollback();
      throw erro;
    } finally { connection.release(); }
    return { automatizado: true, etapa: 'AGUARDANDO_PAGAMENTO',
      pedido_id: pedidoId, cobranca_status: cobranca.status };
  } catch (erro) {
    await encaminharHumano(pool, atendimentoId,
      erro.codigo || 'FALHA_COBRANCA_PIX', erro.message);
    return { automatizado: false, humano: true };
  }
}

async function sincronizarAtendimentoAposPagamento(pool, pedidoId) {
  const atendimentoId = await buscarAtendimentoAutomaticoDoPedido(pool, pedidoId);
  if (!atendimentoId) return { processado: false, motivo: 'PEDIDO_NAO_AUTOMATICO' };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[atendimento]] = await connection.query(
      `SELECT id, modo, status FROM atendimentos WHERE id=? LIMIT 1 FOR UPDATE`,
      [atendimentoId]
    );
    const [[pedido]] = await connection.query(
      'SELECT id, status FROM pedidos_senha WHERE id=? LIMIT 1', [pedidoId]
    );
    if (!atendimento || !pedido || atendimento.modo === 'HUMANO' ||
        ['FINALIZADO', 'CANCELADO'].includes(atendimento.status)) {
      await connection.rollback();
      return { processado: false, motivo: 'ATENDIMENTO_NAO_ELETRONICO' };
    }
    const estado = await lerEstado(connection, atendimentoId);
    if (estado?.etapa !== 'AGUARDANDO_PAGAMENTO') {
      await connection.rollback();
      return { processado: false, motivo: 'PAGAMENTO_JA_SINCRONIZADO' };
    }
    if (pedido.status === 'EM_CONSULTA') {
      await connection.query(
        `UPDATE atendimentos SET status='AGUARDANDO_FORNECEDOR',
          assunto='Senha GM · aguardando fornecedor' WHERE id=?`, [atendimentoId]
      );
      await registrarEstado(connection, atendimentoId,
        { etapa: 'AGUARDANDO_FORNECEDOR', pedido_id: pedido.id });
      await agendarMensagem(connection, atendimentoId,
        'Pagamento confirmado. A senha GM foi solicitada ao fornecedor. Avisaremos aqui.');
    } else if (pedido.status === 'CONCLUIDO') {
      await connection.query(
        `UPDATE atendimentos SET status='PRONTO_ENVIO',
          assunto='Senha GM · entrega preparada' WHERE id=?`, [atendimentoId]
      );
      await registrarEstado(connection, atendimentoId,
        { etapa: 'AGUARDANDO_ENTREGA', pedido_id: pedido.id });
      await agendarMensagem(connection, atendimentoId,
        'Pagamento confirmado. A senha GM foi encontrada e está sendo enviada.');
    } else {
      await encaminharHumanoConnection(connection, atendimentoId,
        `PEDIDO_APOS_PAGAMENTO_${pedido.status}`,
        `O pagamento foi confirmado, mas o pedido ficou em ${pedido.status}`);
    }
    await connection.commit();
    return { processado: true, pedido_id: Number(pedidoId), status: pedido.status };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally { connection.release(); }
}

async function finalizarCriacao(pool, atendimentoId, resultado) {
  const pedido = resultado?.corpo?.pedido;
  if (!pedido?.id) {
    await encaminharHumano(pool, atendimentoId,
      resultado?.corpo?.codigo || 'PEDIDO_GM_NAO_CRIADO',
      resultado?.corpo?.error || 'Não foi possível criar o pedido GM');
    return { automatizado: false, humano: true };
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
       SELECT ?, NULL, 'ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO', ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM pedido_historico
           WHERE pedido_id=? AND tipo='ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO'
        )`,
      [pedido.id, 'Pedido criado pela automação GM do WhatsApp',
        JSON.stringify({ atendimento_id: atendimentoId }), pedido.id]
    );
    if (pedido.status === 'EM_CONSULTA') {
      await connection.query(
        `UPDATE atendimentos SET status='AGUARDANDO_FORNECEDOR',
          assunto='Senha GM · aguardando fornecedor' WHERE id=?`, [atendimentoId]
      );
      await registrarEstado(connection, atendimentoId,
        { etapa: 'AGUARDANDO_FORNECEDOR', pedido_id: pedido.id });
    } else if (pedido.status === 'CONCLUIDO') {
      await connection.query(
        `UPDATE atendimentos SET status='PRONTO_ENVIO',
          assunto='Senha GM · entrega preparada' WHERE id=?`, [atendimentoId]
      );
      await registrarEstado(connection, atendimentoId,
        { etapa: 'AGUARDANDO_ENTREGA', pedido_id: pedido.id });
    } else if (pedido.status === 'AGUARDANDO_PAGAMENTO') {
      await connection.query(
        `UPDATE atendimentos SET status='AGUARDANDO_CLIENTE',
          assunto='Senha GM · preparando cobrança' WHERE id=?`, [atendimentoId]
      );
      await registrarEstado(connection, atendimentoId,
        { etapa: 'PREPARANDO_COBRANCA', pedido_id: pedido.id });
    } else {
      await encaminharHumanoConnection(connection, atendimentoId,
        `PEDIDO_${pedido.status}`, `Pedido criado no estado ${pedido.status}`);
    }
    await connection.commit();
    return { automatizado: ['EM_CONSULTA', 'CONCLUIDO', 'AGUARDANDO_PAGAMENTO']
      .includes(pedido.status),
      pedido_id: pedido.id, status: pedido.status };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally { connection.release(); }
}

async function criarPedidoDoAtendimento(pool, app, atendimentoId, clienteId, chassi) {
  if (typeof app.locals.criarPedidoInterno !== 'function') {
    await encaminharHumano(pool, atendimentoId, 'CRIADOR_PEDIDO_INDISPONIVEL',
      'Rotina de criação de pedido indisponível');
    return { automatizado: false, humano: true };
  }
  const viabilidade = await consultarViabilidade(pool, clienteId, chassi);
  const servico = viabilidade.servico;
  const resultado = await app.locals.criarPedidoInterno({
    dados: { cliente_id: clienteId, servico_id: servico.id, chassi, marca: 'GM' },
    atendimentoId
  });
  if (resultado?.corpo?.pedido?.status === 'AGUARDANDO_PAGAMENTO') {
    return solicitarDadosFiscais(pool, atendimentoId, resultado.corpo.pedido,
      viabilidade.fontePrevista);
  }
  return finalizarCriacao(pool, atendimentoId, resultado);
}

async function processarEntradaClienteWhatsapp(pool, app, entrada) {
  const atendimentoId = Number(entrada.atendimentoId);
  const connection = await pool.getConnection();
  let criarPedido = null;
  let gerarPixPedido = null;
  try {
    await connection.beginTransaction();
    const [[atendimento]] = await connection.query(
      `SELECT id, cliente_id, modo, status FROM atendimentos
        WHERE id=? LIMIT 1 FOR UPDATE`, [atendimentoId]
    );
    if (!atendimento || atendimento.modo === 'HUMANO' ||
        ['FINALIZADO', 'CANCELADO'].includes(atendimento.status)) {
      await connection.rollback();
      return { automatizado: false, motivo: 'ATENDIMENTO_NAO_ELETRONICO' };
    }
    const estado = await lerEstado(connection, atendimentoId);
    if (entrada.tipoConteudo !== 'TEXTO') {
      await encaminharHumanoConnection(connection, atendimentoId,
        'CONTEUDO_NAO_TEXTUAL',
        'Cliente enviou mídia ou conteúdo não textual durante a automação GM');
      await connection.commit();
      return { automatizado: false, humano: true };
    }
    const texto = entrada.tipoConteudo === 'TEXTO' ? String(entrada.texto || '') : '';
    if (!estado) {
      if (!identificaSenhaGm(texto)) {
        await encaminharHumanoConnection(connection, atendimentoId,
          'INTENCAO_NAO_RECONHECIDA', 'Solicitação não reconhecida como senha GM');
        await connection.commit();
        return { automatizado: false, humano: true };
      }
      if (!atendimento.cliente_id) {
        await encaminharHumanoConnection(connection, atendimentoId,
          'CLIENTE_NAO_IDENTIFICADO', 'Telefone não pertence a um cliente ativo');
        await connection.commit();
        return { automatizado: false, humano: true };
      }
      const chassi = extrairChassi(texto);
      if (!chassi) {
        await registrarEstado(connection, atendimentoId,
          { etapa: 'AGUARDANDO_CHASSI', tentativas: 0 });
        await connection.query(
          `UPDATE atendimentos SET status='AGUARDANDO_CLIENTE',
            assunto='Senha GM · aguardando chassi' WHERE id=?`, [atendimentoId]
        );
        await agendarMensagem(connection, atendimentoId,
          'Olá! Para consultar a senha GM, envie o chassi com pelo menos 8 caracteres.');
        await connection.commit();
        return { automatizado: true, etapa: 'AGUARDANDO_CHASSI' };
      }
      await registrarEstado(connection, atendimentoId, { etapa: 'PROCESSANDO' });
      criarPedido = { clienteId: atendimento.cliente_id, chassi };
    } else if (estado.etapa === 'AGUARDANDO_CHASSI') {
      const chassi = extrairChassi(texto);
      if (!chassi) {
        const tentativas = Number(estado.tentativas || 0) + 1;
        if (tentativas >= 2) {
          await encaminharHumanoConnection(connection, atendimentoId,
            'CHASSI_INVALIDO', 'Chassi não reconhecido após duas tentativas');
          await connection.commit();
          return { automatizado: false, humano: true };
        }
        await registrarEstado(connection, atendimentoId,
          { etapa: 'AGUARDANDO_CHASSI', tentativas });
        await agendarMensagem(connection, atendimentoId,
          'Não consegui reconhecer o chassi. Envie somente os caracteres do chassi.');
        await connection.commit();
        return { automatizado: true, etapa: 'AGUARDANDO_CHASSI' };
      }
      await registrarEstado(connection, atendimentoId, { etapa: 'PROCESSANDO' });
      criarPedido = { clienteId: atendimento.cliente_id, chassi };
    } else if (estado.etapa === 'AGUARDANDO_DADOS_FISCAIS') {
      const dadosFiscais = extrairDadosFiscais(texto);
      if (!dadosFiscais) {
        const tentativas = Number(estado.tentativas || 0) + 1;
        if (tentativas >= 2) {
          await encaminharHumanoConnection(connection, atendimentoId,
            'DADOS_FISCAIS_INVALIDOS',
            'Dados fiscais não foram reconhecidos após duas tentativas');
          await connection.commit();
          return { automatizado: false, humano: true };
        }
        await registrarEstado(connection, atendimentoId, {
          etapa: 'AGUARDANDO_DADOS_FISCAIS', pedido_id: estado.pedido_id,
          fonte_prevista: estado.fonte_prevista, tentativas
        });
        await agendarMensagem(connection, atendimentoId,
          'Não consegui validar os dados. Envie: NOME: ... | CPF/CNPJ: ... | ' +
          'EMAIL: ... | CIDADE: ...');
        await connection.commit();
        return { automatizado: true, etapa: 'AGUARDANDO_DADOS_FISCAIS' };
      }
      await salvarDadosFiscais(connection, atendimento, estado, dadosFiscais);
      await connection.query(
        `UPDATE atendimentos SET status='AGUARDANDO_CLIENTE',
          assunto='Senha GM · aguardando opção de pagamento' WHERE id=?`,
        [atendimentoId]
      );
      await registrarEstado(connection, atendimentoId, {
        etapa: 'AGUARDANDO_OPCAO_PAGAMENTO', pedido_id: estado.pedido_id
      });
      const [[pedidoFiscal]] = await connection.query(
        'SELECT valor_venda FROM pedidos_senha WHERE id=? LIMIT 1', [estado.pedido_id]
      );
      await agendarMensagem(connection, atendimentoId,
        `Dados fiscais recebidos. O valor é ${dinheiro(pedidoFiscal?.valor_venda)}. ` +
        'Responda PIX para gerar o pagamento.');
      await connection.commit();
      return { automatizado: true, etapa: 'AGUARDANDO_OPCAO_PAGAMENTO' };
    } else if (estado.etapa === 'AGUARDANDO_OPCAO_PAGAMENTO') {
      if (!/\bPIX\b/.test(normalizarTexto(texto))) {
        const tentativas = Number(estado.tentativas || 0) + 1;
        if (tentativas >= 2) {
          await encaminharHumanoConnection(connection, atendimentoId,
            'PAGAMENTO_NAO_SELECIONADO', 'Cliente não selecionou Pix');
          await connection.commit();
          return { automatizado: false, humano: true };
        }
        await registrarEstado(connection, atendimentoId, {
          etapa: 'AGUARDANDO_OPCAO_PAGAMENTO', pedido_id: estado.pedido_id,
          tentativas
        });
        await agendarMensagem(connection, atendimentoId,
          'Para continuar automaticamente, responda PIX. Se preferir outra forma, um atendente ajudará.');
        await connection.commit();
        return { automatizado: true, etapa: 'AGUARDANDO_OPCAO_PAGAMENTO' };
      }
      await registrarEstado(connection, atendimentoId, {
        etapa: 'PROCESSANDO_COBRANCA', pedido_id: estado.pedido_id
      });
      gerarPixPedido = Number(estado.pedido_id);
    }
    await connection.commit();
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally { connection.release(); }

  if (criarPedido) {
    try {
      return await criarPedidoDoAtendimento(pool, app, atendimentoId,
        criarPedido.clienteId, criarPedido.chassi);
    } catch (erro) {
      await encaminharHumano(pool, atendimentoId,
        erro.codigo || 'FALHA_PROCESSAMENTO_GM', erro.message);
      return { automatizado: false, humano: true };
    }
  }
  if (gerarPixPedido) {
    return gerarCobrancaPix(pool, app, atendimentoId, gerarPixPedido);
  }
  return { automatizado: false, motivo: 'ETAPA_SEM_ACAO' };
}

async function buscarAtendimentoAutomaticoDoPedido(connection, pedidoId) {
  const [[linha]] = await connection.query(
    `SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(dados, '$.atendimento_id')) AS UNSIGNED)
              AS atendimento_id
       FROM pedido_historico
      WHERE pedido_id=? AND tipo='ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO'
      ORDER BY id DESC LIMIT 1`, [pedidoId]
  );
  return Number(linha?.atendimento_id) || null;
}

module.exports = {
  agendarMensagem,
  buscarAtendimentoAutomaticoDoPedido,
  encaminharHumano,
  encaminharHumanoConnection,
  extrairDadosFiscais,
  extrairChassi,
  identificaSenhaGm,
  lerEstado,
  processarEntradaClienteWhatsapp,
  registrarEstado,
  sincronizarAtendimentoAposPagamento
};
