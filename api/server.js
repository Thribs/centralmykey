require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const processarFaturasSemanais = require('./processar-faturas-semanais');
const processarMidiasWhatsapp = require('./processar-midias-whatsapp');
const processarAnexosExpirados = require('./processar-anexos-expirados');

const app = express();

app.use(cors());
app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = buffer;
  }
}));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

require('./rotas-auth')(app, pool);

const autenticarToken = app.locals.autenticarToken;
const exigirPermissao = app.locals.exigirPermissao;

function somenteNumeros(valor = '') {
  return String(valor).replace(/\D/g, '');
}

function normalizarTelefone(valor = '') {
  let n = somenteNumeros(valor);

  if (!n) return '';

  if (n.length === 10 || n.length === 11) {
    n = '55' + n;
  }

  return n;
}

function validarCPF(valor) {
  const cpf = somenteNumeros(valor);

  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  let soma = 0;

  for (let i = 0; i < 9; i++) {
    soma += Number(cpf[i]) * (10 - i);
  }

  let digito1 = (soma * 10) % 11;
  if (digito1 === 10) digito1 = 0;

  if (digito1 !== Number(cpf[9])) return false;

  soma = 0;

  for (let i = 0; i < 10; i++) {
    soma += Number(cpf[i]) * (11 - i);
  }

  let digito2 = (soma * 10) % 11;
  if (digito2 === 10) digito2 = 0;

  return digito2 === Number(cpf[10]);
}

function validarCNPJ(valor) {
  const cnpj = somenteNumeros(valor);

  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const calcular = (base, pesos) => {
    let soma = 0;

    for (let i = 0; i < pesos.length; i++) {
      soma += Number(base[i]) * pesos[i];
    }

    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const d1 = calcular(
    cnpj,
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  );

  if (d1 !== Number(cnpj[12])) return false;

  const d2 = calcular(
    cnpj,
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  );

  return d2 === Number(cnpj[13]);
}

/* =========================
   HEALTH
========================= */

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Central MyKey API'
  });
});

app.get('/health/db', autenticarToken, exigirPermissao('CONFIGURACOES', 'visualizar'), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        DATABASE() AS database_name,
        VERSION() AS mysql_version,
        NOW() AS server_time
    `);

    res.json({
      ok: true,
      database: rows[0]
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: 'Falha na conexão com o banco'
    });
  }
});

/* =========================
   CONFIGURAÇÕES
========================= */

app.get('/api/configuracoes', autenticarToken, exigirPermissao('CONFIGURACOES', 'visualizar'), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        chave,
        valor,
        descricao
      FROM configuracoes
      ORDER BY chave
    `);

    res.json({
      ok: true,
      total: rows.length,
      dados: rows
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: 'Erro ao consultar configurações'
    });
  }
});

/* =========================
   CLIENTES
========================= */

app.get('/api/clientes', autenticarToken, exigirPermissao('CLIENTES', 'visualizar'), async (req, res) => {
  try {
    const busca = String(req.query.busca || '').trim();

    let sql = `
      SELECT
        c.id,
        c.nome,
        c.telefone,
        c.telefone_normalizado,
        c.cpf,
        c.cnpj,
        c.email,
        c.cidade,
        c.cadastro_status,
        c.ativo,
        c.criado_em,
        v.status AS vip_status,
        v.valor_mensalidade,
        v.proximo_vencimento
      FROM clientes c
      LEFT JOIN cliente_vip v
        ON v.cliente_id = c.id
    `;

    const params = [];

    if (busca) {
      const numeros = somenteNumeros(busca);

      sql += `
        WHERE
          c.nome LIKE ?
          OR c.email LIKE ?
          OR c.telefone_normalizado LIKE ?
          OR c.cpf_normalizado LIKE ?
          OR c.cnpj_normalizado LIKE ?
      `;

      params.push(
        `%${busca}%`,
        `%${busca}%`,
        `%${numeros}%`,
        `%${numeros}%`,
        `%${numeros}%`
      );
    }

    sql += `
      ORDER BY c.id DESC
      LIMIT 200
    `;

    const [rows] = await pool.query(sql, params);

    res.json({
      ok: true,
      total: rows.length,
      dados: rows
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: 'Erro ao consultar clientes'
    });
  }
});

app.post('/api/clientes', autenticarToken, exigirPermissao('CLIENTES', 'criar'), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const {
      nome,
      telefone,
      cpf,
      cnpj,
      email,
      cidade,
      vip = false,
      valor_mensalidade = 90,
      proximo_vencimento = null
    } = req.body;

    if (!nome || !String(nome).trim()) {
      return res.status(400).json({
        ok: false,
        error: 'Nome é obrigatório'
      });
    }

    const telefoneNormalizado = normalizarTelefone(telefone);

    if (!telefoneNormalizado) {
      return res.status(400).json({
        ok: false,
        error: 'Telefone é obrigatório'
      });
    }

    const cpfNormalizado = cpf ? somenteNumeros(cpf) : null;
    const cnpjNormalizado = cnpj ? somenteNumeros(cnpj) : null;

    if (cpfNormalizado && !validarCPF(cpfNormalizado)) {
      return res.status(400).json({
        ok: false,
        error: 'CPF inválido'
      });
    }

    if (cnpjNormalizado && !validarCNPJ(cnpjNormalizado)) {
      return res.status(400).json({
        ok: false,
        error: 'CNPJ inválido'
      });
    }

    await connection.beginTransaction();

    const [telefoneExistente] = await connection.query(`
      SELECT id, nome
      FROM clientes
      WHERE telefone_normalizado = ?
      LIMIT 1
    `, [telefoneNormalizado]);

    if (telefoneExistente.length) {
      await connection.rollback();

      return res.status(409).json({
        ok: false,
        error: 'Telefone já cadastrado',
        cliente: telefoneExistente[0]
      });
    }

    if (cpfNormalizado) {
      const [cpfExistente] = await connection.query(`
        SELECT id, nome
        FROM clientes
        WHERE cpf_normalizado = ?
        LIMIT 1
      `, [cpfNormalizado]);

      if (cpfExistente.length) {
        await connection.rollback();

        return res.status(409).json({
          ok: false,
          error: 'CPF já cadastrado',
          cliente: cpfExistente[0]
        });
      }
    }

    if (cnpjNormalizado) {
      const [cnpjExistente] = await connection.query(`
        SELECT id, nome
        FROM clientes
        WHERE cnpj_normalizado = ?
        LIMIT 1
      `, [cnpjNormalizado]);

      if (cnpjExistente.length) {
        await connection.rollback();

        return res.status(409).json({
          ok: false,
          error: 'CNPJ já cadastrado',
          cliente: cnpjExistente[0]
        });
      }
    }

    let cadastroStatus = 'PROVISORIO';

    if (cpfNormalizado || cnpjNormalizado) {
      cadastroStatus = 'VALIDADO';
    }

    if (
      (cpfNormalizado || cnpjNormalizado) &&
      email &&
      cidade
    ) {
      cadastroStatus = 'COMPLETO';
    }

    const [result] = await connection.query(`
      INSERT INTO clientes (
        nome,
        telefone,
        telefone_normalizado,
        cpf,
        cpf_normalizado,
        cnpj,
        cnpj_normalizado,
        email,
        cidade,
        cadastro_status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      String(nome).trim(),
      telefone,
      telefoneNormalizado,
      cpf || null,
      cpfNormalizado,
      cnpj || null,
      cnpjNormalizado,
      email || null,
      cidade || null,
      cadastroStatus
    ]);

    const clienteId = result.insertId;

    if (vip === true) {
      await connection.query(`
        INSERT INTO cliente_vip (
          cliente_id,
          status,
          valor_mensalidade,
          inicio,
          proximo_vencimento
        )
        VALUES (?, 'ATIVO', ?, CURDATE(), ?)
      `, [
        clienteId,
        Number(valor_mensalidade || 90),
        proximo_vencimento || null
      ]);
    }

    await connection.commit();

    res.status(201).json({
      ok: true,
      mensagem: 'Cliente cadastrado com sucesso',
      cliente_id: clienteId,
      cadastro_status: cadastroStatus
    });

  } catch (error) {
    await connection.rollback();

    console.error(error);

    res.status(500).json({
      ok: false,
      error: 'Erro ao cadastrar cliente'
    });

  } finally {
    connection.release();
  }
});

require('./rotas-financeiro')(app, pool);
require('./rotas-whatsapp')(app, pool);
require('./rotas-whatsapp-admin')(app, pool);
require('./rotas-atendimento')(app, pool);
require('./rotas-administracao')(app, pool);
require('./rotas-relatorios')(app, pool);
require('./rotas-cadastros')(app, pool);
require('./rotas-operacionais')(app, pool);
require('./rotas-pedidos')(app, pool);

/* =========================
   START
========================= */

const port = Number(process.env.PORT || 3000);

let fechamentoFaturasEmAndamento = false;

async function executarFechamentoAutomatico() {
  if (fechamentoFaturasEmAndamento) return;

  fechamentoFaturasEmAndamento = true;

  try {
    const resultado = await processarFaturasSemanais(pool);

    if (resultado.analisadas > 0) {
      console.log('Fechamento automático de faturas:', resultado);
    }

  } catch (error) {
    console.error(
      'Erro no fechamento automático de faturas:',
      error
    );

  } finally {
    fechamentoFaturasEmAndamento = false;
  }
}

let processamentoMidiasEmAndamento = false;

async function executarProcessamentoMidias() {
  if (processamentoMidiasEmAndamento) return;

  processamentoMidiasEmAndamento = true;

  try {
    const resultado = await processarMidiasWhatsapp(pool);

    if (
      resultado.executado &&
      (resultado.encontrados > 0 || resultado.falhas > 0)
    ) {
      console.log(
        'Processamento de mídias do WhatsApp:',
        resultado
      );
    }
  } catch (error) {
    console.error(
      'Erro no processamento de mídias do WhatsApp:',
      error
    );
  } finally {
    processamentoMidiasEmAndamento = false;
  }
}

let limpezaAnexosEmAndamento = false;

async function executarLimpezaAnexos() {
  if (limpezaAnexosEmAndamento) return;

  limpezaAnexosEmAndamento = true;

  try {
    const resultado = await processarAnexosExpirados(pool);

    if (
      resultado.executado &&
      (resultado.encontrados > 0 || resultado.falhas > 0)
    ) {
      console.log(
        'Limpeza de anexos expirados:',
        resultado
      );
    }
  } catch (error) {
    console.error(
      'Erro na limpeza de anexos expirados:',
      error
    );
  } finally {
    limpezaAnexosEmAndamento = false;
  }
}

require('./rotas-openai')(app, pool);

app.listen(port, '127.0.0.1', () => {
  console.log(`Central MyKey API ativa na porta ${port}`);

  executarFechamentoAutomatico();

  const intervaloFaturas = setInterval(
    executarFechamentoAutomatico,
    60 * 60 * 1000
  );

  intervaloFaturas.unref();

  executarProcessamentoMidias();

  const intervaloMidias = setInterval(
    executarProcessamentoMidias,
    30 * 1000
  );

  intervaloMidias.unref();

  executarLimpezaAnexos();

  const intervaloLimpezaAnexos = setInterval(
    executarLimpezaAnexos,
    60 * 60 * 1000
  );

  intervaloLimpezaAnexos.unref();
});
