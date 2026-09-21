'use strict';

const crypto = require('crypto');

const CODIGOS_POR_STATUS = Object.freeze({
  400: 'REQUISICAO_INVALIDA',
  401: 'NAO_AUTENTICADO',
  403: 'SEM_PERMISSAO',
  404: 'RECURSO_NAO_ENCONTRADO',
  405: 'METODO_NAO_PERMITIDO',
  409: 'CONFLITO',
  413: 'CORPO_MUITO_GRANDE',
  417: 'DADOS_NAO_ACEITOS',
  422: 'DADOS_INVALIDOS',
  429: 'LIMITE_EXCEDIDO',
  500: 'ERRO_INTERNO',
  502: 'SERVICO_EXTERNO_INDISPONIVEL',
  503: 'SERVICO_INDISPONIVEL',
  504: 'SERVICO_EXTERNO_EXPIRADO'
});

function codigoPadrao(status) {
  return CODIGOS_POR_STATUS[Number(status)] || (
    Number(status) >= 500 ? 'ERRO_INTERNO' : 'REQUISICAO_RECUSADA'
  );
}

function idInformadoValido(valor) {
  return typeof valor === 'string' && /^[A-Za-z0-9._-]{8,80}$/.test(valor);
}

function registrarContextoRequisicao(app) {
  app.use((req, res, next) => {
    const informado = req.headers['x-request-id'];
    req.requestId = idInformadoValido(informado)
      ? informado
      : crypto.randomUUID();
    res.setHeader('X-Request-ID', req.requestId);

    const responderJson = res.json.bind(res);
    res.json = corpo => {
      let resposta = corpo;
      if (
        res.statusCode >= 400 &&
        corpo &&
        typeof corpo === 'object' &&
        !Array.isArray(corpo)
      ) {
        resposta = {
          ...corpo,
          codigo: corpo.codigo || codigoPadrao(res.statusCode),
          request_id: corpo.request_id || req.requestId
        };
      }
      if (res.statusCode >= 500 && !res.locals.erroCorrelacionado) {
        console.error(
          `Resposta HTTP ${res.statusCode} [${req.requestId}] ` +
          `${req.method} ${req.originalUrl}`
        );
      }
      return responderJson(resposta);
    };
    next();
  });
}

function registrarTratamentoFinal(app) {
  app.use('/api', (req, res) => res.status(404).json({
    ok: false,
    error: 'Rota não encontrada',
    codigo: 'ROTA_NAO_ENCONTRADA'
  }));

  app.use((erro, req, res, next) => {
    if (res.headersSent) return next(erro);
    const statusInformado = Number(erro?.status || erro?.statusCode);
    const status = statusInformado >= 400 && statusInformado < 500
      ? statusInformado
      : 500;
    const jsonInvalido = erro?.type === 'entity.parse.failed';
    const corpoGrande = erro?.type === 'entity.too.large' || status === 413;
    if (status < 500) {
      return res.status(status).json({
        ok: false,
        error: corpoGrande
          ? 'O corpo da requisição excede o limite permitido'
          : jsonInvalido
            ? 'O corpo JSON da requisição é inválido'
            : 'A requisição não pôde ser processada',
        codigo: corpoGrande
          ? 'CORPO_MUITO_GRANDE'
          : jsonInvalido
            ? 'JSON_INVALIDO'
            : codigoPadrao(status)
      });
    }
    console.error(
      `Erro não tratado [${req.requestId}] ${req.method} ${req.originalUrl}:`,
      erro?.code || erro?.name || 'erro desconhecido'
    );
    res.locals.erroCorrelacionado = true;
    return res.status(500).json({
      ok: false,
      error: 'Erro interno da Central MyKey',
      codigo: 'ERRO_INTERNO'
    });
  });
}

module.exports = {
  registrarContextoRequisicao,
  registrarTratamentoFinal,
  idInformadoValido,
  codigoPadrao
};
