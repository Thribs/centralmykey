'use strict';

const crypto = require('crypto');

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
        !Array.isArray(corpo) &&
        !corpo.request_id
      ) {
        resposta = { ...corpo, request_id: req.requestId };
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
  idInformadoValido
};
