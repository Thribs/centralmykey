'use strict';

function escaparLike(valor) {
  return String(valor).replace(/[\\%_]/g, caractere => `\\${caractere}`);
}

module.exports = function registrarRotasBuscaGlobal(app, pool) {
  const autenticarToken = app.locals.autenticarToken;

  app.get('/api/busca-global', autenticarToken, async (req, res) => {
    const termoInformado = String(req.query.termo || '').trim().slice(0, 100);

    if (termoInformado.length < 2) {
      return res.status(400).json({
        ok: false,
        error: 'Informe ao menos 2 caracteres para buscar'
      });
    }

    try {
      const [linhasPermissao] = await pool.query(`
        SELECT m.codigo
          FROM usuario_permissoes up
          INNER JOIN modulos m ON m.id = up.modulo_id
         WHERE up.usuario_id = ?
           AND up.visualizar = 1
           AND m.ativo = 1
      `, [req.usuario.id]);
      const permissoes = new Set(linhasPermissao.map(item => item.codigo));
      const termo = `%${escaparLike(termoInformado)}%`;
      const numeros = termoInformado.replace(/\D/g, '');
      const resultados = [];

      if (permissoes.has('PEDIDOS_SENHAS')) {
        const [pedidos] = await pool.query(`
          SELECT p.id, p.protocolo, p.status, p.placa, p.chassi,
                 c.nome AS cliente, s.nome AS servico
            FROM pedidos_senha p
            INNER JOIN clientes c ON c.id = p.cliente_id
            INNER JOIN servicos s ON s.id = p.servico_id
           WHERE p.protocolo LIKE ?
              OR p.placa LIKE ?
              OR p.chassi LIKE ?
              OR c.nome LIKE ?
              OR s.nome LIKE ?
           ORDER BY p.atualizado_em DESC, p.id DESC
           LIMIT 5
        `, [termo, termo, termo, termo, termo]);
        resultados.push(...pedidos.map(pedido => ({
          tipo: 'PEDIDO',
          id: Number(pedido.id),
          modulo: 'PEDIDOS_SENHAS',
          titulo: pedido.protocolo,
          descricao: [pedido.cliente, pedido.servico, pedido.placa || pedido.chassi]
            .filter(Boolean)
            .join(' · '),
          estado: pedido.status,
          busca: pedido.protocolo
        })));
      }

      if (permissoes.has('CLIENTES')) {
        const parametros = [termo, termo];
        const filtrosNumericos = numeros
          ? ' OR c.telefone_normalizado LIKE ? OR c.cpf_normalizado LIKE ? OR c.cnpj_normalizado LIKE ?'
          : '';
        if (numeros) {
          const termoNumerico = `%${escaparLike(numeros)}%`;
          parametros.push(termoNumerico, termoNumerico, termoNumerico);
        }
        const [clientes] = await pool.query(`
          SELECT c.id, c.nome, c.telefone, c.email, c.ativo
            FROM clientes c
           WHERE c.nome LIKE ? OR c.email LIKE ?${filtrosNumericos}
           ORDER BY c.atualizado_em DESC, c.id DESC
           LIMIT 5
        `, parametros);
        resultados.push(...clientes.map(cliente => ({
          tipo: 'CLIENTE',
          id: Number(cliente.id),
          modulo: 'CLIENTES',
          titulo: cliente.nome,
          descricao: [cliente.telefone, cliente.email].filter(Boolean).join(' · '),
          estado: Number(cliente.ativo) === 1 ? 'ATIVO' : 'BLOQUEADO',
          busca: cliente.nome
        })));
      }

      if (permissoes.has('FORNECEDORES')) {
        const [fornecedores] = await pool.query(`
          SELECT id, nome, contato, telefone, whatsapp, email, ativo
            FROM fornecedores
           WHERE nome LIKE ? OR contato LIKE ? OR telefone LIKE ?
              OR whatsapp LIKE ? OR email LIKE ?
           ORDER BY atualizado_em DESC, id DESC
           LIMIT 5
        `, [termo, termo, termo, termo, termo]);
        resultados.push(...fornecedores.map(fornecedor => ({
          tipo: 'FORNECEDOR',
          id: Number(fornecedor.id),
          modulo: 'FORNECEDORES',
          titulo: fornecedor.nome,
          descricao: [fornecedor.contato, fornecedor.whatsapp || fornecedor.telefone]
            .filter(Boolean)
            .join(' · '),
          estado: Number(fornecedor.ativo) === 1 ? 'ATIVO' : 'BLOQUEADO',
          busca: fornecedor.nome
        })));
      }

      return res.json({
        ok: true,
        termo: termoInformado,
        total: resultados.length,
        dados: resultados
      });
    } catch (error) {
      console.error('Erro na busca global:', error.code || error.message);
      return res.status(500).json({
        ok: false,
        error: 'Erro ao buscar na Central MyKey'
      });
    }
  });
};
