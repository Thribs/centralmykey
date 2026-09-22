'use strict';

const STATUS_VIP = [
  'ATIVO',
  'AGUARDANDO_PAGAMENTO',
  'VENCIDO',
  'SUSPENSO',
  'CANCELADO'
];
const STATUS_CADASTRO = ['PROVISORIO', 'VALIDADO', 'COMPLETO'];
const TIPOS_COBRANCA = ['ANTECIPADO', 'FATURAMENTO_SEMANAL'];
const STATUS_CREDITO = ['LIBERADO', 'BLOQUEADO'];

function somenteNumeros(valor) {
  return String(valor === undefined || valor === null ? '' : valor)
    .replace(/\D/g, '');
}

function texto(valor) {
  if (valor === undefined || valor === null) return null;
  const resultado = String(valor).trim();
  return resultado || null;
}

function normalizarTelefone(valor) {
  let telefone = somenteNumeros(valor);
  if (telefone.length === 10 || telefone.length === 11) telefone = `55${telefone}`;
  return telefone;
}

function validarCPF(valor) {
  const cpf = somenteNumeros(valor);
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  const calcular = tamanho => {
    let soma = 0;
    for (let i = 0; i < tamanho; i += 1) {
      soma += Number(cpf[i]) * (tamanho + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return calcular(9) === Number(cpf[9]) && calcular(10) === Number(cpf[10]);
}

function validarCNPJ(valor) {
  const cnpj = somenteNumeros(valor);
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
  const digito = base => {
    let peso = base.length - 7;
    let soma = 0;
    for (const numero of base) {
      soma += Number(numero) * peso;
      peso -= 1;
      if (peso === 1) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const primeiro = digito(cnpj.slice(0, 12));
  const segundo = digito(cnpj.slice(0, 12) + primeiro);
  return cnpj.endsWith(`${primeiro}${segundo}`);
}

function dataValida(valor) {
  if (valor === null || valor === undefined || valor === '') return true;
  const textoData = String(valor);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(textoData)) return false;
  const [ano, mes, dia] = textoData.split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  return data.getUTCFullYear() === ano &&
    data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}

function erroValidacaoCliente(dados, atualizacao = false) {
  const nome = texto(dados.nome);
  const telefone = normalizarTelefone(dados.telefone);
  const cpf = texto(dados.cpf);
  const cnpj = texto(dados.cnpj);
  const cpfNormalizado = cpf ? somenteNumeros(cpf) : null;
  const cnpjNormalizado = cnpj ? somenteNumeros(cnpj) : null;

  if (!nome || !telefone) return 'Nome e telefone são obrigatórios';
  if (cpfNormalizado && !validarCPF(cpfNormalizado)) return 'CPF inválido';
  if (cnpjNormalizado && !validarCNPJ(cnpjNormalizado)) return 'CNPJ inválido';

  if (atualizacao) {
    if (!STATUS_CADASTRO.includes(dados.cadastro_status)) {
      return 'Situação cadastral inválida';
    }
    if (!TIPOS_COBRANCA.includes(dados.tipo_cobranca)) {
      return 'Tipo de cobrança inválido';
    }
    if (!STATUS_CREDITO.includes(dados.credito_status)) {
      return 'Status de crédito inválido';
    }
    const prazo = Number(dados.prazo_pagamento_dias ?? 0);
    if (!Number.isInteger(prazo) || prazo < 0 || prazo > 60) {
      return 'Prazo de pagamento inválido';
    }
    if (dados.tipo_cobranca === 'FATURAMENTO_SEMANAL') {
      const fechamento = Number(dados.dia_fechamento);
      if (!Number.isInteger(fechamento) || fechamento < 0 || fechamento > 6) {
        return 'Dia de fechamento deve estar entre 0 e 6';
      }
    }
    if (dados.limite_credito !== '' && dados.limite_credito !== null &&
        dados.limite_credito !== undefined) {
      const limite = Number(dados.limite_credito);
      if (!Number.isFinite(limite) || limite < 0) {
        return 'Limite de crédito inválido';
      }
    }
  }
  return null;
}

function validarVip(dados) {
  const status = dados.vip_status || dados.status || 'ATIVO';
  const valor = Number(dados.valor_mensalidade ?? 90);
  if (!STATUS_VIP.includes(status)) return 'Status VIP inválido';
  if (!Number.isFinite(valor) || valor <= 0) return 'Mensalidade VIP inválida';
  if (!dataValida(dados.inicio)) return 'Data inicial VIP inválida';
  if (!dataValida(dados.proximo_vencimento)) return 'Próximo vencimento VIP inválido';
  return null;
}

async function registrarAuditoria(connection, req, acao, entidadeId, descricao,
  antes, depois) {
  await connection.query(
    `INSERT INTO auditoria (
       usuario_id, modulo, acao, entidade, entidade_id, descricao,
       dados_antes, dados_depois, ip
     ) VALUES (?, 'CLIENTES', ?, 'clientes', ?, ?, ?, ?, ?)`,
    [
      req.usuario?.id || null,
      acao,
      String(entidadeId),
      descricao,
      antes ? JSON.stringify(antes) : null,
      depois ? JSON.stringify(depois) : null,
      req.ip || null
    ]
  );
}

async function salvarVip(connection, clienteId, dados) {
  const erro = validarVip(dados);
  if (erro) {
    const falha = new Error(erro);
    falha.status = 400;
    throw falha;
  }
  const status = dados.vip_status || dados.status || 'ATIVO';
  const valor = Number(dados.valor_mensalidade ?? 90);
  const inicio = dados.inicio || null;
  const vencimento = dados.proximo_vencimento || null;
  const [existentes] = await connection.query(
    'SELECT * FROM cliente_vip WHERE cliente_id = ? LIMIT 1 FOR UPDATE',
    [clienteId]
  );
  const antes = existentes[0] || null;

  if (antes) {
    await connection.query(
      `UPDATE cliente_vip
          SET status = ?, valor_mensalidade = ?,
              inicio = COALESCE(?, inicio, CURDATE()),
              proximo_vencimento = ?,
              cancelado_em = CASE WHEN ? = 'CANCELADO' THEN NOW() ELSE NULL END
        WHERE cliente_id = ?`,
      [status, valor, inicio, vencimento, status, clienteId]
    );
  } else {
    await connection.query(
      `INSERT INTO cliente_vip (
         cliente_id, status, valor_mensalidade, inicio,
         proximo_vencimento, cancelado_em
       ) VALUES (?, ?, ?, COALESCE(?, CURDATE()), ?,
                 CASE WHEN ? = 'CANCELADO' THEN NOW() ELSE NULL END)`,
      [clienteId, status, valor, inicio, vencimento, status]
    );
  }

  const [[depois]] = await connection.query(
    'SELECT * FROM cliente_vip WHERE cliente_id = ? LIMIT 1',
    [clienteId]
  );
  return { antes, depois };
}

module.exports = function registrarRotasClientes(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  app.get('/api/clientes', autenticarToken,
    exigirPermissao('CLIENTES', 'visualizar'), async (req, res) => {
      try {
        const busca = String(req.query.busca || '').trim();
        const numeros = somenteNumeros(busca);
        const params = [];
        let filtro = '';
        if (busca) {
          filtro = `WHERE c.nome LIKE ? OR c.email LIKE ?
            OR c.telefone_normalizado LIKE ? OR c.cpf_normalizado LIKE ?
            OR c.cnpj_normalizado LIKE ?`;
          params.push(`%${busca}%`, `%${busca}%`, `%${numeros}%`,
            `%${numeros}%`, `%${numeros}%`);
        }
        const [rows] = await pool.query(
          `SELECT c.id, c.nome, c.telefone, c.telefone_normalizado,
                  c.cpf, c.cnpj, c.email, c.cidade, c.cadastro_status,
                  c.tipo_cobranca, c.dia_fechamento,
                  c.prazo_pagamento_dias, c.limite_credito,
                  c.credito_status, c.credito_observacao,
                  c.ativo, c.criado_em,
                  v.status AS vip_status, v.valor_mensalidade,
                  v.inicio AS vip_inicio, v.proximo_vencimento,
                  CASE
                    WHEN v.status = 'ATIVO'
                     AND (v.proximo_vencimento IS NULL
                          OR v.proximo_vencimento >= CURDATE())
                    THEN 1 ELSE 0
                  END AS vip_elegivel
             FROM clientes c
             LEFT JOIN cliente_vip v ON v.cliente_id = c.id
             ${filtro}
            ORDER BY c.id DESC LIMIT 200`,
          params
        );
        return res.json({ ok: true, total: rows.length, dados: rows });
      } catch (error) {
        console.error('Erro ao consultar clientes:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar clientes' });
      }
    });

  app.get('/api/clientes-resumo', autenticarToken,
    exigirPermissao('CLIENTES', 'visualizar'), async (req, res) => {
      try {
        const [[resumo]] = await pool.query(
          `SELECT COUNT(*) AS total, SUM(c.ativo = 1) AS ativos,
                  SUM(c.ativo = 0) AS bloqueados,
                  SUM(c.cadastro_status = 'PROVISORIO') AS provisorios,
                  SUM(c.cadastro_status = 'VALIDADO') AS validados,
                  SUM(c.cadastro_status = 'COMPLETO') AS completos,
                  SUM(c.tipo_cobranca = 'FATURAMENTO_SEMANAL') AS faturamento_semanal,
                  SUM(c.credito_status = 'BLOQUEADO') AS credito_bloqueado,
                  COUNT(CASE WHEN v.status = 'ATIVO' THEN 1 END) AS vips_ativos
             FROM clientes c
             LEFT JOIN cliente_vip v ON v.cliente_id = c.id`
        );
        return res.json({ ok: true, resumo });
      } catch (error) {
        console.error('Erro ao resumir clientes:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar resumo de clientes' });
      }
    });

  app.get('/api/clientes/:id', autenticarToken,
    exigirPermissao('CLIENTES', 'visualizar'), async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'Cliente inválido' });
      }
      try {
        const [rows] = await pool.query(
          `SELECT c.*, v.status AS vip_status, v.valor_mensalidade,
                  v.inicio AS vip_inicio, v.ultimo_pagamento,
                  v.proximo_vencimento, v.cancelado_em,
                  (SELECT COUNT(*) FROM pedidos_senha p
                    WHERE p.cliente_id = c.id) AS total_pedidos,
                  (SELECT COUNT(*) FROM faturas_clientes f
                    WHERE f.cliente_id = c.id) AS total_faturas
             FROM clientes c
             LEFT JOIN cliente_vip v ON v.cliente_id = c.id
            WHERE c.id = ? LIMIT 1`,
          [id]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, error: 'Cliente não encontrado' });
        }
        return res.json({ ok: true, cliente: rows[0] });
      } catch (error) {
        console.error('Erro ao detalhar cliente:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao detalhar cliente' });
      }
    });

  app.post('/api/clientes', autenticarToken,
    exigirPermissao('CLIENTES', 'criar'), async (req, res) => {
      const entrada = {
        cadastro_status: 'PROVISORIO',
        tipo_cobranca: 'ANTECIPADO',
        dia_fechamento: null,
        prazo_pagamento_dias: 0,
        limite_credito: null,
        credito_status: 'LIBERADO',
        ...req.body
      };
      const erro = erroValidacaoCliente(entrada, true);
      if (erro) return res.status(400).json({ ok: false, error: erro });
      if (req.body.vip === true) {
        const erroVip = validarVip(req.body);
        if (erroVip) return res.status(400).json({ ok: false, error: erroVip });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const nome = texto(req.body.nome);
        const telefone = texto(req.body.telefone);
        const telefoneNormalizado = normalizarTelefone(telefone);
        const cpf = texto(req.body.cpf);
        const cnpj = texto(req.body.cnpj);
        const cpfNormalizado = cpf ? somenteNumeros(cpf) : null;
        const cnpjNormalizado = cnpj ? somenteNumeros(cnpj) : null;
        const [duplicados] = await connection.query(
          `SELECT id, nome FROM clientes
            WHERE telefone_normalizado = ?
               OR (? IS NOT NULL AND cpf_normalizado = ?)
               OR (? IS NOT NULL AND cnpj_normalizado = ?)
            LIMIT 1 FOR UPDATE`,
          [telefoneNormalizado, cpfNormalizado, cpfNormalizado,
            cnpjNormalizado, cnpjNormalizado]
        );
        if (duplicados.length) {
          await connection.rollback();
          return res.status(409).json({
            ok: false,
            error: 'Telefone, CPF ou CNPJ já cadastrado',
            cliente: duplicados[0]
          });
        }
        let cadastroStatus = 'PROVISORIO';
        if (cpfNormalizado || cnpjNormalizado) cadastroStatus = 'VALIDADO';
        if ((cpfNormalizado || cnpjNormalizado) && texto(req.body.email) &&
            texto(req.body.cidade)) cadastroStatus = 'COMPLETO';
        const semanal = entrada.tipo_cobranca === 'FATURAMENTO_SEMANAL';
        const diaFechamento = semanal ? Number(entrada.dia_fechamento) : null;
        const prazoPagamento = semanal
          ? Number(entrada.prazo_pagamento_dias ?? 0)
          : 0;
        const limiteCredito = entrada.limite_credito === '' ||
          entrada.limite_credito === null || entrada.limite_credito === undefined
          ? null : Number(entrada.limite_credito);
        const [resultado] = await connection.query(
          `INSERT INTO clientes (
             nome, telefone, telefone_normalizado, cpf, cpf_normalizado,
             cnpj, cnpj_normalizado, email, cidade, cadastro_status,
             tipo_cobranca, dia_fechamento, prazo_pagamento_dias,
             limite_credito, credito_status, credito_observacao
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [nome, telefone, telefoneNormalizado, cpf, cpfNormalizado,
            cnpj, cnpjNormalizado, texto(req.body.email),
            texto(req.body.cidade), cadastroStatus, entrada.tipo_cobranca,
            diaFechamento, prazoPagamento, limiteCredito,
            entrada.credito_status, texto(entrada.credito_observacao)]
        );
        const clienteId = resultado.insertId;
        let vip = null;
        if (req.body.vip === true) vip = await salvarVip(connection, clienteId, req.body);
        await registrarAuditoria(connection, req, 'CRIAR_CLIENTE', clienteId,
          `Cliente ${nome} cadastrado`, null,
          { nome, telefone_normalizado: telefoneNormalizado, cadastro_status: cadastroStatus,
            tipo_cobranca: entrada.tipo_cobranca,
            dia_fechamento: diaFechamento,
            prazo_pagamento_dias: prazoPagamento,
            limite_credito: limiteCredito,
            credito_status: entrada.credito_status,
            vip: vip?.depois || null });
        await connection.commit();
        return res.status(201).json({
          ok: true,
          mensagem: 'Cliente cadastrado com sucesso',
          cliente_id: clienteId,
          cadastro_status: cadastroStatus
        });
      } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ ok: false, error: 'Telefone, CPF ou CNPJ já cadastrado' });
        }
        console.error('Erro ao cadastrar cliente:', error);
        return res.status(error.status || 500).json({
          ok: false,
          error: error.status ? error.message : 'Erro ao cadastrar cliente'
        });
      } finally {
        connection.release();
      }
    });

  app.put('/api/clientes/:id', autenticarToken,
    exigirPermissao('CLIENTES', 'editar'), async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'Cliente inválido' });
      }
      const erro = erroValidacaoCliente(req.body, true);
      if (erro) return res.status(400).json({ ok: false, error: erro });
      if (req.body.vip_status) {
        const erroVip = validarVip(req.body);
        if (erroVip) return res.status(400).json({ ok: false, error: erroVip });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [clientes] = await connection.query(
          'SELECT * FROM clientes WHERE id = ? LIMIT 1 FOR UPDATE', [id]
        );
        if (!clientes.length) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Cliente não encontrado' });
        }
        const antes = clientes[0];
        const nome = texto(req.body.nome);
        const telefone = texto(req.body.telefone);
        const telefoneNormalizado = normalizarTelefone(telefone);
        const cpf = texto(req.body.cpf);
        const cnpj = texto(req.body.cnpj);
        const cpfNormalizado = cpf ? somenteNumeros(cpf) : null;
        const cnpjNormalizado = cnpj ? somenteNumeros(cnpj) : null;
        const [duplicados] = await connection.query(
          `SELECT id, nome FROM clientes WHERE id <> ? AND (
             telefone_normalizado = ?
             OR (? IS NOT NULL AND cpf_normalizado = ?)
             OR (? IS NOT NULL AND cnpj_normalizado = ?)) LIMIT 1 FOR UPDATE`,
          [id, telefoneNormalizado, cpfNormalizado, cpfNormalizado,
            cnpjNormalizado, cnpjNormalizado]
        );
        if (duplicados.length) {
          await connection.rollback();
          return res.status(409).json({
            ok: false,
            error: 'Telefone, CPF ou CNPJ já utilizado por outro cliente',
            cliente: duplicados[0]
          });
        }
        const semanal = req.body.tipo_cobranca === 'FATURAMENTO_SEMANAL';
        const depois = {
          nome,
          telefone,
          telefone_normalizado: telefoneNormalizado,
          cpf,
          cpf_normalizado: cpfNormalizado,
          cnpj,
          cnpj_normalizado: cnpjNormalizado,
          email: texto(req.body.email),
          cidade: texto(req.body.cidade),
          cadastro_status: req.body.cadastro_status,
          tipo_cobranca: req.body.tipo_cobranca,
          dia_fechamento: semanal ? Number(req.body.dia_fechamento) : null,
          prazo_pagamento_dias: semanal ? Number(req.body.prazo_pagamento_dias ?? 0) : 0,
          limite_credito: req.body.limite_credito === '' ||
            req.body.limite_credito === null || req.body.limite_credito === undefined
            ? null : Number(req.body.limite_credito),
          credito_status: req.body.credito_status,
          credito_observacao: texto(req.body.credito_observacao)
        };
        await connection.query(
          `UPDATE clientes SET nome=?, telefone=?, telefone_normalizado=?,
             cpf=?, cpf_normalizado=?, cnpj=?, cnpj_normalizado=?, email=?,
             cidade=?, cadastro_status=?, tipo_cobranca=?, dia_fechamento=?,
             prazo_pagamento_dias=?, limite_credito=?, credito_status=?,
             credito_observacao=? WHERE id=?`,
          [...Object.values(depois), id]
        );
        let vip = null;
        if (req.body.vip_status) vip = await salvarVip(connection, id, req.body);
        await registrarAuditoria(connection, req, 'ATUALIZAR_CLIENTE', id,
          `Cliente ${nome} atualizado`, antes, { ...depois, vip: vip?.depois || null });
        await connection.commit();
        return res.json({ ok: true, mensagem: 'Cliente atualizado com sucesso' });
      } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ ok: false, error: 'Telefone, CPF ou CNPJ já utilizado por outro cliente' });
        }
        console.error('Erro ao atualizar cliente:', error);
        return res.status(error.status || 500).json({
          ok: false,
          error: error.status ? error.message : 'Erro ao atualizar cliente'
        });
      } finally {
        connection.release();
      }
    });

  app.patch('/api/clientes/:id/status', autenticarToken,
    exigirPermissao('CLIENTES', 'editar'), async (req, res) => {
      const id = Number(req.params.id);
      const ativo = Number(req.body.ativo);
      if (!Number.isInteger(id) || id <= 0 || ![0, 1].includes(ativo)) {
        return res.status(400).json({ ok: false, error: 'Dados inválidos' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [clientes] = await connection.query(
          'SELECT id, nome, ativo FROM clientes WHERE id = ? LIMIT 1 FOR UPDATE', [id]
        );
        if (!clientes.length) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Cliente não encontrado' });
        }
        await connection.query('UPDATE clientes SET ativo = ? WHERE id = ?', [ativo, id]);
        await registrarAuditoria(connection, req, ativo ? 'ATIVAR_CLIENTE' : 'BLOQUEAR_CLIENTE',
          id, `Cliente ${clientes[0].nome} ${ativo ? 'ativado' : 'bloqueado'}`,
          { ativo: Number(clientes[0].ativo) }, { ativo });
        await connection.commit();
        return res.json({
          ok: true,
          mensagem: ativo ? 'Cliente ativado com sucesso' : 'Cliente bloqueado com sucesso'
        });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao alterar cliente:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao alterar status do cliente' });
      } finally {
        connection.release();
      }
    });

  app.put('/api/clientes/:id/vip', autenticarToken,
    exigirPermissao('CLIENTES', 'editar'), async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'Cliente inválido' });
      }
      const erro = validarVip(req.body);
      if (erro) return res.status(400).json({ ok: false, error: erro });
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [clientes] = await connection.query(
          'SELECT id, nome FROM clientes WHERE id = ? LIMIT 1 FOR UPDATE', [id]
        );
        if (!clientes.length) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Cliente não encontrado' });
        }
        const vip = await salvarVip(connection, id, req.body);
        await registrarAuditoria(connection, req, 'ATUALIZAR_CLIENTE_VIP', id,
          `Plano VIP de ${clientes[0].nome} atualizado`, vip.antes, vip.depois);
        await connection.commit();
        return res.json({ ok: true, mensagem: 'Plano VIP atualizado', vip: vip.depois });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar cliente VIP:', error);
        return res.status(error.status || 500).json({
          ok: false,
          error: error.status ? error.message : 'Erro ao atualizar cliente VIP'
        });
      } finally {
        connection.release();
      }
    });
};

module.exports.STATUS_VIP = STATUS_VIP;
module.exports.normalizarTelefone = normalizarTelefone;
module.exports.validarCPF = validarCPF;
module.exports.validarCNPJ = validarCNPJ;
