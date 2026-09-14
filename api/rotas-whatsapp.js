const crypto = require('crypto');

module.exports = function (app, pool) {
  // ============================================================
  // ENVIAR MENSAGEM PELA API OFICIAL DA META
  // ============================================================

  app.locals.enviarMensagemWhatsapp = async ({ telefone, texto }) => {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const versao = process.env.WHATSAPP_API_VERSION;

    if (!token || !phoneNumberId || !versao) {
      const erro = new Error(
        'Credenciais de envio do WhatsApp ainda não configuradas'
      );
      erro.codigo = 'WHATSAPP_NAO_CONFIGURADO';
      throw erro;
    }

    if (!/^v\d+\.\d+$/.test(versao)) {
      const erro = new Error('Versão da API do WhatsApp inválida');
      erro.codigo = 'WHATSAPP_CONFIGURACAO_INVALIDA';
      throw erro;
    }

    const destino = String(telefone || '').replace(/\D/g, '');
    const mensagem = String(texto || '').trim();

    if (!destino || !mensagem) {
      const erro = new Error('Telefone e mensagem são obrigatórios');
      erro.codigo = 'WHATSAPP_DADOS_INVALIDOS';
      throw erro;
    }

    const controlador = new AbortController();
    const tempoLimite = setTimeout(() => controlador.abort(), 15000);

    try {
      const resposta = await fetch(
        `https://graph.facebook.com/${versao}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: destino,
            type: 'text',
            text: {
              preview_url: false,
              body: mensagem
            }
          }),
          signal: controlador.signal
        }
      );

      const dados = await resposta.json().catch(() => ({}));

      if (!resposta.ok || !dados.messages?.[0]?.id) {
        const erro = new Error(
          dados.error?.message || 'A Meta recusou o envio da mensagem'
        );
        erro.codigo = 'WHATSAPP_ENVIO_FALHOU';
        erro.statusMeta = resposta.status;
        erro.dadosMeta = dados.error || null;
        throw erro;
      }

      return {
        mensagem_externa_id: dados.messages[0].id,
        contato: dados.contacts?.[0]?.wa_id || destino
      };
    } finally {
      clearTimeout(tempoLimite);
    }
  };

  // ============================================================
  // ENVIAR MODELO APROVADO PELA META
  // ============================================================

  app.locals.enviarModeloWhatsapp = async ({
    telefone,
    nome,
    idioma,
    parametros = []
  }) => {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const versao = process.env.WHATSAPP_API_VERSION;

    if (!token || !phoneNumberId || !versao) {
      const erro = new Error(
        'Credenciais de envio do WhatsApp ainda não configuradas'
      );
      erro.codigo = 'WHATSAPP_NAO_CONFIGURADO';
      throw erro;
    }

    if (!/^v\d+\.\d+$/.test(versao)) {
      const erro = new Error('Versão da API do WhatsApp inválida');
      erro.codigo = 'WHATSAPP_CONFIGURACAO_INVALIDA';
      throw erro;
    }

    const destino = String(telefone || '').replace(/\D/g, '');
    const nomeModelo = String(nome || '').trim();
    const idiomaModelo = String(idioma || '').trim();

    if (
      !destino ||
      !/^[a-z0-9_]+$/.test(nomeModelo) ||
      !/^[a-zA-Z]{2,3}(?:_[a-zA-Z]{2})?$/.test(idiomaModelo) ||
      !Array.isArray(parametros) ||
      parametros.length > 10
    ) {
      const erro = new Error('Dados do modelo inválidos');
      erro.codigo = 'WHATSAPP_DADOS_INVALIDOS';
      throw erro;
    }

    const parametrosTexto = parametros.map(valor => {
      const textoParametro = String(valor ?? '').trim();

      if (!textoParametro || textoParametro.length > 1024) {
        const erro = new Error('Parâmetro do modelo inválido');
        erro.codigo = 'WHATSAPP_DADOS_INVALIDOS';
        throw erro;
      }

      return {
        type: 'text',
        text: textoParametro
      };
    });

    const modelo = {
      name: nomeModelo,
      language: {
        code: idiomaModelo
      }
    };

    if (parametrosTexto.length) {
      modelo.components = [
        {
          type: 'body',
          parameters: parametrosTexto
        }
      ];
    }

    const controlador = new AbortController();
    const tempoLimite = setTimeout(() => controlador.abort(), 15000);

    try {
      const resposta = await fetch(
        `https://graph.facebook.com/${versao}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: destino,
            type: 'template',
            template: modelo
          }),
          signal: controlador.signal
        }
      );

      const dados = await resposta.json().catch(() => ({}));

      if (!resposta.ok || !dados.messages?.[0]?.id) {
        const erro = new Error(
          dados.error?.message ||
          'A Meta recusou o envio do modelo'
        );
        erro.codigo = 'WHATSAPP_ENVIO_FALHOU';
        erro.statusMeta = resposta.status;
        erro.dadosMeta = dados.error || null;
        throw erro;
      }

      return {
        mensagem_externa_id: dados.messages[0].id,
        contato: dados.contacts?.[0]?.wa_id || destino
      };
    } finally {
      clearTimeout(tempoLimite);
    }
  };

  // ============================================================
  // VERIFICAÇÃO DO WEBHOOK DA META
  // ============================================================

  app.get('/webhooks/whatsapp', (req, res) => {
    const modo = req.query['hub.mode'];
    const tokenRecebido = req.query['hub.verify_token'];
    const desafio = req.query['hub.challenge'];
    const tokenConfigurado = process.env.META_VERIFY_TOKEN;

    if (!tokenConfigurado) {
      console.error('META_VERIFY_TOKEN não configurado');

      return res.status(503).json({
        ok: false,
        error: 'Webhook ainda não configurado'
      });
    }

    const recebido = Buffer.from(String(tokenRecebido || ''));
    const configurado = Buffer.from(String(tokenConfigurado));

    const tokenValido =
      recebido.length === configurado.length &&
      crypto.timingSafeEqual(recebido, configurado);

    if (modo === 'subscribe' && tokenValido) {
      return res.status(200).send(String(desafio || ''));
    }

    return res.status(403).json({
      ok: false,
      error: 'Falha na verificação do webhook'
    });
  });

  // ============================================================
  // RECEBIMENTO DE MENSAGENS DA META
  // ============================================================

  app.post('/webhooks/whatsapp', async (req, res) => {
    const segredo = process.env.META_APP_SECRET;

    if (!segredo) {
      console.error('META_APP_SECRET não configurado');
      return res.sendStatus(503);
    }

    const assinaturaRecebida = String(
      req.get('x-hub-signature-256') || ''
    );

    const assinaturaEsperada =
      'sha256=' +
      crypto
        .createHmac('sha256', segredo)
        .update(req.rawBody || Buffer.from(''))
        .digest('hex');

    const recebida = Buffer.from(assinaturaRecebida);
    const esperada = Buffer.from(assinaturaEsperada);

    const assinaturaValida =
      recebida.length === esperada.length &&
      crypto.timingSafeEqual(recebida, esperada);

    if (!assinaturaValida) {
      return res.sendStatus(401);
    }

    if (req.body?.object !== 'whatsapp_business_account') {
      return res.sendStatus(404);
    }

    const mensagens = [];
    const statusEntrega = [];

    for (const entrada of req.body.entry || []) {
      for (const alteracao of entrada.changes || []) {
        const valor = alteracao.value || {};
        const contatos = valor.contacts || [];

        // PROCESSAR STATUS DE ENTREGA
        for (const status of valor.statuses || []) {
          statusEntrega.push(status);
        }

        for (const mensagem of valor.messages || []) {
          mensagens.push({
            mensagem,
            contato: contatos.find(
              item => item.wa_id === mensagem.from
            ) || contatos[0] || null
          });
        }
      }
    }

    try {
      const mapaStatus = {
        sent: 'ENVIADA',
        delivered: 'ENTREGUE',
        read: 'LIDA',
        failed: 'FALHOU'
      };

      for (const evento of statusEntrega) {
        const novoStatus = mapaStatus[evento.status];
        const mensagemExternaId = String(evento.id || '');

        if (!novoStatus || !mensagemExternaId) {
          continue;
        }

        const erroMeta = evento.errors?.[0] || null;
        const horarioUnix = Number(evento.timestamp || 0);

        await pool.query(
          `UPDATE atendimento_mensagens
           SET status_entrega = CASE
                 WHEN status_entrega = 'LIDA' THEN 'LIDA'
                 WHEN status_entrega = 'ENTREGUE'
                      AND ? = 'ENVIADA' THEN 'ENTREGUE'
                 WHEN status_entrega IN ('ENTREGUE', 'LIDA')
                      AND ? = 'FALHOU' THEN status_entrega
                 ELSE ?
               END,
               status_atualizado_em =
                 IF(? > 0, FROM_UNIXTIME(?), NOW()),
               erro_codigo = ?,
               erro_detalhe = ?
           WHERE mensagem_externa_id = ?`,
          [
            novoStatus,
            novoStatus,
            novoStatus,
            horarioUnix,
            horarioUnix,
            erroMeta?.code ? String(erroMeta.code).slice(0, 64) : null,
            erroMeta
              ? String(
                  erroMeta.error_data?.details ||
                  erroMeta.message ||
                  erroMeta.title ||
                  'Falha informada pela Meta'
                ).slice(0, 500)
              : null,
            mensagemExternaId
          ]
        );
      }

      if (!mensagens.length) {
        return res.sendStatus(200);
      }

      for (const item of mensagens) {
        const mensagem = item.mensagem;
        const telefone = String(mensagem.from || '').replace(/\D/g, '');
        const mensagemExternaId = String(mensagem.id || '');

        if (!telefone || !mensagemExternaId) {
          continue;
        }

        let tipoConteudo = 'OUTRO';
        let conteudo = null;
        let midia = null;

        if (mensagem.type === 'text') {
          tipoConteudo = 'TEXTO';
          conteudo = mensagem.text?.body || null;
        } else if (mensagem.type === 'audio') {
          tipoConteudo = 'AUDIO';
          conteudo = 'Áudio recebido pelo WhatsApp';
          midia = mensagem.audio;
        } else if (mensagem.type === 'image') {
          tipoConteudo = 'IMAGEM';
          conteudo = mensagem.image?.caption || 'Imagem recebida pelo WhatsApp';
          midia = mensagem.image;
        } else if (mensagem.type === 'document') {
          tipoConteudo = 'DOCUMENTO';
          conteudo =
            mensagem.document?.caption ||
            mensagem.document?.filename ||
            'Documento recebido pelo WhatsApp';
          midia = mensagem.document;
        } else if (mensagem.type === 'location') {
          tipoConteudo = 'LOCALIZACAO';
          conteudo = JSON.stringify({
            latitude: mensagem.location?.latitude,
            longitude: mensagem.location?.longitude,
            nome: mensagem.location?.name || null,
            endereco: mensagem.location?.address || null
          });
        } else if (mensagem.type === 'button') {
          tipoConteudo = 'TEXTO';
          conteudo = mensagem.button?.text || null;
        } else if (mensagem.type === 'interactive') {
          tipoConteudo = 'TEXTO';
          conteudo =
            mensagem.interactive?.button_reply?.title ||
            mensagem.interactive?.list_reply?.title ||
            'Resposta interativa recebida';
        } else {
          conteudo = `Mensagem do tipo ${mensagem.type || 'desconhecido'}`;
        }

        const conexao = await pool.getConnection();

        try {
          await conexao.beginTransaction();

          const [duplicadas] = await conexao.query(
            'SELECT id FROM atendimento_mensagens WHERE mensagem_externa_id = ? LIMIT 1',
            [mensagemExternaId]
          );

          if (duplicadas.length) {
            await conexao.rollback();
            continue;
          }

          const [clientes] = await conexao.query(
            `SELECT id
               FROM (
                 SELECT id, 0 AS ordem
                   FROM clientes
                  WHERE telefone_normalizado = ? AND ativo = 1
                 UNION ALL
                 SELECT c.id, 1 AS ordem
                   FROM cliente_telefones ct
                   JOIN clientes c ON c.id = ct.cliente_id
                  WHERE ct.telefone_normalizado = ?
                    AND c.ativo = 1
               ) encontrados
              ORDER BY ordem
              LIMIT 1`,
            [telefone, telefone]
          );

          const clienteId = clientes[0]?.id || null;

          const [abertos] = await conexao.query(
            `SELECT id
               FROM atendimentos
              WHERE telefone_normalizado = ?
                AND canal = 'WHATSAPP'
                AND status NOT IN ('FINALIZADO', 'CANCELADO')
              ORDER BY id DESC
              LIMIT 1
              FOR UPDATE`,
            [telefone]
          );

          let atendimentoId = abertos[0]?.id;

          if (!atendimentoId) {
            const protocolo =
              `ATD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

            const nome =
              String(item.contato?.profile?.name || '').trim().slice(0, 120);

            const [novo] = await conexao.query(
              `INSERT INTO atendimentos
                 (protocolo, cliente_id, telefone, telefone_normalizado,
                  canal, modo, status, prioridade, assunto,
                  ultima_mensagem_em)
               VALUES (?, ?, ?, ?, 'WHATSAPP', 'ELETRONICO',
                       'FILA', 'NORMAL', ?, NOW())`,
              [
                protocolo,
                clienteId,
                telefone,
                telefone,
                nome ? `WhatsApp - ${nome}` : 'Atendimento pelo WhatsApp'
              ]
            );

            atendimentoId = novo.insertId;
          }

          const [resultadoMensagem] = await conexao.query(
            `INSERT INTO atendimento_mensagens
               (atendimento_id, direcao, autor_tipo, tipo_conteudo,
                texto, mensagem_externa_id)
             VALUES (?, 'ENTRADA', 'CLIENTE', ?, ?, ?)`,
            [atendimentoId, tipoConteudo, conteudo, mensagemExternaId]
          );

          if (midia?.id) {
            await conexao.query(
              `INSERT INTO atendimento_anexos
                 (atendimento_id, mensagem_id, nome_arquivo, tipo_mime,
                  caminho_arquivo, expira_em)
               VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
              [
                atendimentoId,
                resultadoMensagem.insertId,
                midia.filename || null,
                midia.mime_type || null,
                `meta://${midia.id}`
              ]
            );
          }

          await conexao.query(
            `UPDATE atendimentos
                SET cliente_id = COALESCE(cliente_id, ?),
                    ultima_mensagem_em = NOW(),
                    status = CASE
                      WHEN status = 'AGUARDANDO_CLIENTE'
                        THEN IF(responsavel_id IS NULL, 'FILA', 'EM_ATENDIMENTO')
                      ELSE status
                    END
              WHERE id = ?`,
            [clienteId, atendimentoId]
          );

          await conexao.commit();
        } catch (erro) {
          await conexao.rollback();

          if (erro.code !== 'ER_DUP_ENTRY') {
            throw erro;
          }
        } finally {
          conexao.release();
        }
      }

      return res.sendStatus(200);
    } catch (erro) {
      console.error('Erro ao processar webhook WhatsApp:', erro.message);
      return res.sendStatus(500);
    }
  });

};
