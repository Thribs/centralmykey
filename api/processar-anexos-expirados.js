const fs = require('fs');
const path = require('path');

module.exports = async function processarAnexosExpirados(pool) {
  const diretorio = path.resolve(
    process.env.WHATSAPP_MEDIA_DIR ||
    '/opt/central-mykey-api/storage/whatsapp'
  );

  const connection = await pool.getConnection();
  let bloqueioObtido = false;

  try {
    const [bloqueio] = await connection.query(
      `SELECT GET_LOCK(
         'central_mykey_anexos_expirados',
         0
       ) AS obtido`
    );

    bloqueioObtido = Number(bloqueio[0]?.obtido) === 1;

    if (!bloqueioObtido) {
      return {
        executado: false,
        motivo: 'LIMPEZA_EM_ANDAMENTO'
      };
    }

    const [anexos] = await connection.query(
      `SELECT id, caminho_arquivo
       FROM atendimento_anexos
       WHERE excluido_em IS NULL
         AND expira_em IS NOT NULL
         AND expira_em <= NOW()
       ORDER BY id ASC
       LIMIT 100`
    );

    let removidos = 0;
    let falhas = 0;

    for (const anexo of anexos) {
      try {
        const caminhoRegistrado =
          String(anexo.caminho_arquivo || '');

        if (
          caminhoRegistrado &&
          !caminhoRegistrado.startsWith('meta://')
        ) {
          const caminho = path.resolve(
            diretorio,
            caminhoRegistrado
          );

          const caminhoSeguro =
            caminho === diretorio ||
            caminho.startsWith(diretorio + path.sep);

          if (!caminhoSeguro) {
            throw new Error(
              'Caminho fora do armazenamento privado'
            );
          }

          await fs.promises.unlink(caminho).catch(error => {
            if (error.code !== 'ENOENT') {
              throw error;
            }
          });
        }

        await connection.query(
          `UPDATE atendimento_anexos
           SET excluido_em = NOW(),
               caminho_arquivo = NULL
           WHERE id = ?
             AND excluido_em IS NULL`,
          [anexo.id]
        );

        removidos += 1;
      } catch (error) {
        falhas += 1;

        console.error(
          `Falha ao excluir anexo expirado ${anexo.id}:`,
          error.message
        );
      }
    }

    return {
      executado: true,
      encontrados: anexos.length,
      removidos,
      falhas
    };
  } finally {
    if (bloqueioObtido) {
      await connection.query(
        `SELECT RELEASE_LOCK(
           'central_mykey_anexos_expirados'
         )`
      ).catch(() => {});
    }

    connection.release();
  }
};
