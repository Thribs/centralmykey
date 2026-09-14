const OpenAI = require('openai');

module.exports = function registrarRotasOpenAI(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  function configuracao() {
    return {
      modelo: process.env.OPENAI_MODEL || 'gpt-5-mini',
      maximoTokens: Number(
        process.env.OPENAI_MAX_OUTPUT_TOKENS || 1200
      ),
      tempoLimite: Number(
        process.env.OPENAI_TIMEOUT_MS || 45000
      )
    };
  }

  function criarCliente() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI não configurada no servidor');
    }

    const { tempoLimite } = configuracao();

    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: tempoLimite,
      maxRetries: 1
    });
  }

  app.get(
    '/api/openai/status',
    autenticarToken,
    exigirPermissao('CONFIGURACOES', 'editar'),
    async (req, res) => {
      const { modelo, maximoTokens, tempoLimite } = configuracao();

      return res.json({
        configurada: Boolean(process.env.OPENAI_API_KEY),
        modelo,
        maximo_tokens_saida: maximoTokens,
        tempo_limite_ms: tempoLimite,
        whatsapp_automatico: false
      });
    }
  );

  app.post(
    '/api/openai/teste',
    autenticarToken,
    exigirPermissao('CONFIGURACOES', 'editar'),
    async (req, res) => {
      const pergunta = String(req.body?.pergunta || '').trim();

      if (!pergunta) {
        return res.status(400).json({
          erro: 'Informe uma pergunta para a inteligência artificial'
        });
      }

      if (pergunta.length > 2000) {
        return res.status(400).json({
          erro: 'A pergunta deve possuir no máximo 2.000 caracteres'
        });
      }

      const { modelo, maximoTokens } = configuracao();

      try {
        const cliente = criarCliente();

        const resposta = await cliente.responses.create({
          model: modelo,
          store: false,
          instructions: [
            'Você é o assistente interno da Central MyKey.',
            'Responda em português do Brasil.',
            'Seja objetivo, cordial e profissional.',
            'Não invente códigos, senhas automotivas, pagamentos,',
            'valores, disponibilidade ou resultados de consulta.',
            'Quando faltar informação, diga claramente o que falta.',
            'Este é um laboratório interno e não está conectado',
            'automaticamente ao WhatsApp.'
          ].join(' '),
          input: pergunta,
          max_output_tokens: maximoTokens
        });

        const texto = String(resposta.output_text || '').trim();

        if (!texto) {
          throw new Error('A OpenAI retornou uma resposta vazia');
        }

        const usuarioId =
          req.usuario?.id ||
          req.user?.id ||
          null;

        await pool.query(
          `INSERT INTO auditoria (
            usuario_id,
            modulo,
            acao,
            entidade,
            entidade_id,
            descricao,
            dados_depois,
            ip
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            usuarioId,
            'OPENAI',
            'TESTE_INTERNO',
            'OPENAI_RESPONSE',
            resposta.id || null,
            'Teste administrativo da inteligência artificial',
            JSON.stringify({
              modelo,
              resposta_id: resposta.id || null,
              uso: resposta.usage || null
            }),
            req.ip || null
          ]
        );

        return res.json({
          resposta: texto,
          modelo,
          resposta_id: resposta.id || null,
          uso: resposta.usage || null,
          whatsapp_automatico: false
        });
      } catch (erro) {
        console.error(
          'Erro no laboratório OpenAI:',
          erro.status || '',
          erro.message
        );

        const status =
          Number.isInteger(erro.status) &&
          erro.status >= 400 &&
          erro.status < 600
            ? erro.status
            : 502;

        return res.status(status).json({
          erro: 'Não foi possível obter resposta da inteligência artificial',
          detalhe:
            process.env.NODE_ENV === 'development'
              ? erro.message
              : undefined
        });
      }
    }
  );

  app.post(
    '/api/openai/analisar-atendimento',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'editar'),
    async (req, res) => {
      const mensagem = String(req.body?.mensagem || '').trim();

      if (!mensagem) {
        return res.status(400).json({
          erro: 'Informe a mensagem que será analisada'
        });
      }

      if (mensagem.length > 2000) {
        return res.status(400).json({
          erro: 'A mensagem deve possuir no máximo 2.000 caracteres'
        });
      }

      const { modelo, maximoTokens } = configuracao();

      try {
        const cliente = criarCliente();

        const resposta = await cliente.responses.create({
          model: modelo,
          store: false,
          instructions: [
            'Você analisa mensagens recebidas pela Central MyKey.',
            'Esta tarefa é somente classificação e organização de dados.',
            'Você não está sendo solicitado a gerar ou descobrir códigos.',
            'Trabalhe somente com as informações presentes na mensagem.',
            'Nunca invente códigos ou senhas automotivas.',
            'A Central MyKey é autorizada internamente a consultar e fornecer',
            'senhas automotivas encontradas em seu próprio sistema.',
            'Não mande o cliente procurar concessionária ou outro chaveiro.',
            'A inteligência artificial apenas organiza a solicitação;',
            'a consulta real será executada posteriormente pelo sistema MyKey.',
            'Quando os dados estiverem completos, informe ao cliente que',
            'a solicitação foi recebida e será encaminhada para consulta.',
            'Nunca confirme pagamento, preço, disponibilidade ou resultado',
            'antes da validação realizada pelo sistema.',
            'O chassi automotivo normalmente possui 17 caracteres.',
            'Chassis não utilizam as letras I, O e Q.',
            'Não confunda placa com chassi.',
            'A resposta_sugerida deve ser curta, cordial e profissional.',
            'Se faltar informação, solicite somente os dados necessários.',
            'Retorne exclusivamente o JSON solicitado.'
          ].join(' '),
          input: mensagem,
          max_output_tokens: Math.max(maximoTokens, 3000),
          reasoning: {
            effort: 'low'
          },
          text: {
            format: {
              type: 'json_schema',
              name: 'analise_atendimento_mykey',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  intencao: {
                    type: 'string'
                  },
                  dados_identificados: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      placa: {
                        type: ['string', 'null']
                      },
                      chassi: {
                        type: ['string', 'null']
                      },
                      marca: {
                        type: ['string', 'null']
                      },
                      modelo: {
                        type: ['string', 'null']
                      },
                      ano: {
                        type: ['string', 'null']
                      }
                    },
                    required: [
                      'placa',
                      'chassi',
                      'marca',
                      'modelo',
                      'ano'
                    ]
                  },
                  dados_faltantes: {
                    type: 'array',
                    items: {
                      type: 'string'
                    }
                  },
                  pronto_para_consulta: {
                    type: 'boolean'
                  },
                  resposta_sugerida: {
                    type: 'string'
                  }
                },
                required: [
                  'intencao',
                  'dados_identificados',
                  'dados_faltantes',
                  'pronto_para_consulta',
                  'resposta_sugerida'
                ]
              }
            }
          }
        });

        const textoResposta = String(
          resposta.output_text || ''
        ).trim();

        if (!textoResposta) {
          console.error(
            'Diagnóstico da análise vazia:',
            JSON.stringify({
              status: resposta.status || null,
              incomplete_details:
                resposta.incomplete_details || null,
              tipos_saida: Array.isArray(resposta.output)
                ? resposta.output.map((item) => item.type)
                : []
            })
          );

          throw new Error('A OpenAI retornou uma análise vazia');
        }

        const analise = JSON.parse(textoResposta);

        const usuarioId =
          req.usuario?.id ||
          req.user?.id ||
          null;

        await pool.query(
          `INSERT INTO auditoria (
            usuario_id,
            modulo,
            acao,
            entidade,
            entidade_id,
            descricao,
            dados_depois,
            ip
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            usuarioId,
            'OPENAI',
            'ANALISE_ATENDIMENTO',
            'OPENAI_RESPONSE',
            resposta.id || null,
            'Análise interna de mensagem sem acesso ao banco de senhas',
            JSON.stringify({
              modelo,
              resposta_id: resposta.id || null,
              uso: resposta.usage || null,
              pronto_para_consulta:
                Boolean(analise.pronto_para_consulta)
            }),
            req.ip || null
          ]
        );

        return res.json({
          analise,
          modelo,
          resposta_id: resposta.id || null,
          whatsapp_automatico: false,
          banco_senhas_acessado: false
        });
      } catch (erro) {
        console.error(
          'Erro na análise OpenAI:',
          erro.status || '',
          erro.message
        );

        return res.status(502).json({
          erro: 'Não foi possível analisar a mensagem'
        });
      }
    }
  );

};
