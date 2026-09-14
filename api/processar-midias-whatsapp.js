const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = async function processarMidiasWhatsapp(pool) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const versao = process.env.WHATSAPP_API_VERSION;

  if (!token || !versao) {
    return {
      executado: false,
      motivo: 'WHATSAPP_NAO_CONFIGURADO'
    };
  }

  if (!/^v\d+\.\d+$/.test(versao)) {
    throw new Error('WHATSAPP_API_VERSION inválida');
  }

  const diretorio = path.resolve(
    process.env.WHATSAPP_MEDIA_DIR ||
    '/opt/central-mykey-api/storage/whatsapp'
  );

  const limiteBytes =
    Number(process.env.WHATSAPP_MEDIA_MAX_BYTES) ||
    25 * 1024 * 1024;

  await fs.promises.mkdir(diretorio, {
    recursive: true,
    mode: 0o750
  });

  const connection = await pool.getConnection();
  let bloqueioObtido = false;

  try {
    const [bloqueio] = await connection.query(
      `SELECT GET_LOCK(
         'central_mykey_midias_whatsapp',
         0
       ) AS obtido`
    );

    bloqueioObtido = Number(bloqueio[0]?.obtido) === 1;

    if (!bloqueioObtido) {
      return {
        executado: false,
        motivo: 'PROCESSAMENTO_EM_ANDAMENTO'
      };
    }

    const [anexos] = await connection.query(
      `SELECT
         id,
         caminho_arquivo,
         nome_arquivo,
         tipo_mime
       FROM atendimento_anexos
       WHERE caminho_arquivo LIKE 'meta://%'
         AND excluido_em IS NULL
         AND (
           expira_em IS NULL
           OR expira_em > NOW()
         )
       ORDER BY id ASC
       LIMIT 10`
    );

    let baixados = 0;
    let falhas = 0;

    for (const anexo of anexos) {
      let caminhoFinal = null;

      try {
        const mediaId = String(anexo.caminho_arquivo).slice(7);

        if (!mediaId) {
          throw new Error('Identificador de mídia vazio');
        }

        const metadadosResposta = await fetch(
          `https://graph.facebook.com/${versao}/${encodeURIComponent(mediaId)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`
            },
            signal: AbortSignal.timeout(15000)
          }
        );

        const metadados = await metadadosResposta
          .json()
          .catch(() => ({}));

        if (!metadadosResposta.ok || !metadados.url) {
          throw new Error(
            metadados.error?.message ||
            'Meta não forneceu a URL da mídia'
          );
        }

        const tamanhoInformado = Number(metadados.file_size || 0);

        if (
          tamanhoInformado > 0 &&
          tamanhoInformado > limiteBytes
        ) {
          throw new Error('Mídia excede o limite permitido');
        }

        const arquivoResposta = await fetch(metadados.url, {
          headers: {
            Authorization: `Bearer ${token}`
          },
          signal: AbortSignal.timeout(30000)
        });

        if (!arquivoResposta.ok) {
          throw new Error(
            `Falha ao baixar mídia: HTTP ${arquivoResposta.status}`
          );
        }

        const buffer = Buffer.from(
          await arquivoResposta.arrayBuffer()
        );

        if (!buffer.length || buffer.length > limiteBytes) {
          throw new Error(
            'Arquivo vazio ou acima do limite permitido'
          );
        }

        const mime =
          metadados.mime_type ||
          arquivoResposta.headers.get('content-type') ||
          anexo.tipo_mime ||
          'application/octet-stream';

        const extensoes = {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'audio/ogg': 'ogg',
          'audio/mpeg': 'mp3',
          'audio/mp4': 'm4a',
          'video/mp4': 'mp4',
          'application/pdf': 'pdf'
        };

        let extensao = extensoes[mime];

        if (!extensao && anexo.nome_arquivo) {
          const candidata = path
            .extname(anexo.nome_arquivo)
            .replace('.', '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');

          if (candidata.length >= 1 && candidata.length <= 10) {
            extensao = candidata;
          }
        }

        extensao = extensao || 'bin';

        const nomeInterno =
          `${anexo.id}-` +
          `${crypto.randomBytes(12).toString('hex')}.` +
          extensao;

        caminhoFinal = path.join(diretorio, nomeInterno);

        await fs.promises.writeFile(
          caminhoFinal,
          buffer,
          {
            flag: 'wx',
            mode: 0o640
          }
        );

        const [atualizacao] = await connection.query(
          `UPDATE atendimento_anexos
           SET caminho_arquivo = ?,
               tipo_mime = ?,
               tamanho_bytes = ?
           WHERE id = ?
             AND caminho_arquivo = ?`,
          [
            nomeInterno,
            mime.slice(0, 120),
            buffer.length,
            anexo.id,
            anexo.caminho_arquivo
          ]
        );

        if (!atualizacao.affectedRows) {
          await fs.promises.unlink(caminhoFinal).catch(() => {});
        } else {
          baixados += 1;
        }
      } catch (error) {
        falhas += 1;

        if (caminhoFinal) {
          await fs.promises.unlink(caminhoFinal).catch(() => {});
        }

        console.error(
          `Falha ao processar anexo WhatsApp ${anexo.id}:`,
          error.message
        );
      }
    }

    return {
      executado: true,
      encontrados: anexos.length,
      baixados,
      falhas
    };
  } finally {
    if (bloqueioObtido) {
      await connection.query(
        `SELECT RELEASE_LOCK(
           'central_mykey_midias_whatsapp'
         )`
      ).catch(() => {});
    }

    connection.release();
  }
};
