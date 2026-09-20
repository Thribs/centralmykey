'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  horarioValido,
  selecionarFornecedor
} = require('./selecionar-fornecedor');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  let erro;

  try {
    await connection.beginTransaction();
    const [configuracaoViva] = await connection.query(
      `SELECT f.nome, f.ativo,
              TIME_FORMAT(f.horario_inicio, '%H:%i:%s') AS horario_inicio,
              TIME_FORMAT(f.horario_fim, '%H:%i:%s') AS horario_fim,
              fs.custo, fs.ativo AS servico_ativo
         FROM fornecedores f
         INNER JOIN fornecedor_servicos fs ON fs.fornecedor_id = f.id
        WHERE f.nome IN ('Márcio', 'Emerson')
          AND fs.codigo_servico = 'GM_SENHA'
        ORDER BY f.nome`
    );
    const porNome = Object.fromEntries(
      configuracaoViva.map(item => [item.nome, item])
    );
    assert.ok(porNome['Márcio'], 'Cadastro GM de Márcio é obrigatório');
    assert.ok(porNome.Emerson, 'Cadastro GM de Emerson é obrigatório');
    assert.deepStrictEqual(
      {
        ativo: Number(porNome['Márcio'].ativo),
        servico_ativo: Number(porNome['Márcio'].servico_ativo),
        inicio: porNome['Márcio'].horario_inicio,
        fim: porNome['Márcio'].horario_fim,
        custo: Number(porNome['Márcio'].custo)
      },
      { ativo: 1, servico_ativo: 1, inicio: '08:00:00', fim: '22:00:00', custo: 22 }
    );
    assert.deepStrictEqual(
      {
        ativo: Number(porNome.Emerson.ativo),
        servico_ativo: Number(porNome.Emerson.servico_ativo),
        inicio: porNome.Emerson.horario_inicio,
        fim: porNome.Emerson.horario_fim,
        custo: Number(porNome.Emerson.custo)
      },
      { ativo: 1, servico_ativo: 1, inicio: '08:00:00', fim: '19:00:00', custo: 25 }
    );

    await connection.query(
      `CREATE TEMPORARY TABLE fornecedores (
         id BIGINT NOT NULL PRIMARY KEY,
         nome VARCHAR(120) NOT NULL,
         whatsapp VARCHAR(30) NULL,
         telefone VARCHAR(30) NULL,
         horario_inicio TIME NULL,
         horario_fim TIME NULL,
         ativo TINYINT(1) NOT NULL
       ) ENGINE=InnoDB`
    );
    await connection.query(
      `CREATE TEMPORARY TABLE fornecedor_servicos (
         id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
         fornecedor_id BIGINT NOT NULL,
         codigo_servico VARCHAR(60) NOT NULL,
         custo DECIMAL(12,2) NOT NULL,
         ativo TINYINT(1) NOT NULL
       ) ENGINE=InnoDB`
    );
    await connection.query(
      `INSERT INTO fornecedores
         (id, nome, whatsapp, horario_inicio, horario_fim, ativo)
       VALUES
         (101, 'Márcio', '5511000000101', '08:00:00', '22:00:00', 1),
         (202, 'Emerson', '5511000000202', '08:00:00', '19:00:00', 1)`
    );
    await connection.query(
      `INSERT INTO fornecedor_servicos
         (fornecedor_id, codigo_servico, custo, ativo)
       VALUES
         (101, 'GM_SENHA', 22, 1),
         (202, 'GM_SENHA', 25, 1)`
    );

    assert.strictEqual(horarioValido('08:00:00'), true);
    assert.strictEqual(horarioValido('24:00:00'), false);
    await assert.rejects(
      () => selecionarFornecedor(connection, 'GM_SENHA', { horario: '8h' }),
      /Horário de referência inválido/
    );

    async function esperado(horario, nome, custo) {
      const selecionado = await selecionarFornecedor(
        connection,
        'GM_SENHA',
        { horario }
      );
      if (!nome) {
        assert.strictEqual(selecionado, null, `Não deveria selecionar às ${horario}`);
        return;
      }
      assert.ok(selecionado, `Fornecedor esperado às ${horario}`);
      assert.strictEqual(selecionado.fornecedor, nome);
      assert.strictEqual(Number(selecionado.custo), custo);
    }

    await esperado('07:59:59', null);
    await esperado('08:00:00', 'Márcio', 22);
    await esperado('18:59:59', 'Márcio', 22);
    await esperado('19:00:00', 'Márcio', 22);
    await esperado('19:00:01', 'Márcio', 22);
    await esperado('22:00:00', 'Márcio', 22);
    await esperado('22:00:01', null);

    await connection.query('UPDATE fornecedores SET ativo = 0 WHERE id = 101');
    await esperado('12:00:00', 'Emerson', 25);
    await esperado('19:00:00', 'Emerson', 25);
    await esperado('19:00:01', null);

    await connection.query('UPDATE fornecedores SET ativo = 1 WHERE id = 101');
    await connection.query(
      'UPDATE fornecedor_servicos SET custo = 30 WHERE fornecedor_id = 101'
    );
    await esperado('12:00:00', 'Emerson', 25);

    await connection.query(
      'UPDATE fornecedor_servicos SET custo = 25 WHERE fornecedor_id = 101'
    );
    await esperado('12:00:00', 'Márcio', 25);

    await connection.query(
      'UPDATE fornecedor_servicos SET ativo = 0 WHERE fornecedor_id = 101'
    );
    await esperado('20:00:00', null);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await connection.rollback();
    } catch (falhaRollback) {
      erro = erro || falhaRollback;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: Márcio e Emerson respeitam horários, custos e prioridade (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de seleção de fornecedores GM: ${erro.message}`);
  process.exitCode = 1;
});
