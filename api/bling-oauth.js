'use strict';

const crypto = require('crypto');

const AUTORIZACAO_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const TOKEN_URL = 'https://api.bling.com.br/Api/v3/oauth/token';

function falha(mensagem, codigo, status) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = status;
  return erro;
}

function chaveCifragem(valor) {
  const texto = String(valor || '').trim();
  let chave;
  if (/^[a-f0-9]{64}$/i.test(texto)) chave = Buffer.from(texto, 'hex');
  else {
    try { chave = Buffer.from(texto, 'base64'); } catch { chave = null; }
  }
  if (!chave || chave.length !== 32) {
    throw falha('Cifragem OAuth Bling não configurada',
      'BLING_CIFRAGEM_NAO_CONFIGURADA', 503);
  }
  return chave;
}

function cifrarToken(token, chaveConfigurada) {
  const chave = chaveCifragem(chaveConfigurada);
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const dados = Buffer.concat([cifra.update(String(token), 'utf8'), cifra.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cifra.getAuthTag().toString('base64'),
    dados: dados.toString('base64')
  });
}

function descriptografarToken(envelope, chaveConfigurada) {
  const chave = chaveCifragem(chaveConfigurada);
  let item;
  try { item = typeof envelope === 'string' ? JSON.parse(envelope) : envelope; } catch {
    throw falha('Token OAuth Bling inválido', 'TOKEN_BLING_INVALIDO', 500);
  }
  try {
    if (item?.v !== 1) throw new Error('versão inválida');
    const decifra = crypto.createDecipheriv(
      'aes-256-gcm', chave, Buffer.from(item.iv, 'base64')
    );
    decifra.setAuthTag(Buffer.from(item.tag, 'base64'));
    return Buffer.concat([
      decifra.update(Buffer.from(item.dados, 'base64')), decifra.final()
    ]).toString('utf8');
  } catch {
    throw falha('Token OAuth Bling inválido', 'TOKEN_BLING_INVALIDO', 500);
  }
}

function validarConfiguracao(config) {
  if (!config?.habilitado) {
    throw falha('OAuth Bling desabilitado', 'OAUTH_BLING_DESABILITADO', 503);
  }
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw falha('OAuth Bling não configurado', 'OAUTH_BLING_NAO_CONFIGURADO', 503);
  }
  try {
    const callback = new URL(config.redirectUri);
    if (callback.protocol !== 'https:' || callback.username || callback.password ||
        callback.hash) throw new Error('callback inválido');
  } catch {
    throw falha('Callback OAuth Bling deve usar HTTPS',
      'CALLBACK_OAUTH_BLING_INVALIDO', 503);
  }
  chaveCifragem(config.encryptionKey);
}

async function iniciarOAuthBling(pool, config, opcoes = {}) {
  validarConfiguracao(config);
  const state = crypto.randomBytes(32).toString('base64url');
  const stateHash = crypto.createHash('sha256').update(state).digest('hex');
  const expiraEm = new Date(Date.now() + 10 * 60 * 1000);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `DELETE FROM integracao_oauth_estados
        WHERE provedor='BLING' AND (expira_em < NOW() OR usado_em IS NOT NULL)`
    );
    const [gravacao] = await connection.query(
      `INSERT INTO integracao_oauth_estados
         (provedor, state_hash, usuario_id, expira_em)
       VALUES ('BLING', ?, ?, ?)`,
      [stateHash, opcoes.usuarioId || null, expiraEm]
    );
    await connection.query(
      `INSERT INTO auditoria
         (usuario_id, modulo, acao, entidade, entidade_id, descricao,
          dados_antes, dados_depois, ip)
       VALUES (?, 'INTEGRACOES', 'INICIAR_OAUTH_BLING',
               'integracao_oauth_estados', ?,
               'Autorização OAuth Bling iniciada', NULL, ?, ?)`,
      [opcoes.usuarioId || null, String(gravacao.insertId),
        JSON.stringify({ provedor: 'BLING', expira_em: expiraEm.toISOString() }),
        opcoes.ip || null]
    );
    await connection.commit();
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally {
    connection.release();
  }
  const url = new URL(config.authorizationUrl || AUTORIZACAO_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('state', state);
  return { ok: true, autorizacao_url: url.toString(),
    callback_url: config.redirectUri, expira_em: expiraEm.toISOString() };
}

async function solicitarTokens(config, parametros, opcoes = {}) {
  const transporte = opcoes.transporte || global.fetch;
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), opcoes.timeoutMs || 10000);
  let resposta;
  try {
    resposta = await transporte(config.tokenUrl || TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'enable-jwt': '1'
      },
      body: new URLSearchParams(parametros).toString(),
      signal: controlador.signal
    });
  } catch (erro) {
    throw falha(erro?.name === 'AbortError'
      ? 'Tempo limite no OAuth Bling' : 'Bling indisponível',
    erro?.name === 'AbortError' ? 'TIMEOUT_OAUTH_BLING' : 'BLING_INDISPONIVEL', 503);
  } finally {
    clearTimeout(temporizador);
  }
  let corpo = {};
  try { corpo = await resposta.json(); } catch { /* resposta inválida */ }
  if (!resposta.ok) {
    throw falha('Código OAuth Bling recusado', 'CODIGO_OAUTH_BLING_RECUSADO', 502);
  }
  if (!corpo.access_token || !corpo.refresh_token ||
      String(corpo.access_token).length > 20000 ||
      String(corpo.refresh_token).length > 20000 ||
      String(corpo.token_type || 'Bearer').toLowerCase() !== 'bearer' ||
      !Number.isFinite(Number(corpo.expires_in)) || Number(corpo.expires_in) <= 0) {
    throw falha('Resposta OAuth Bling inválida', 'RESPOSTA_OAUTH_BLING_INVALIDA', 502);
  }
  return corpo;
}

async function trocarCodigo(config, code, opcoes = {}) {
  return solicitarTokens(config, { grant_type: 'authorization_code', code }, opcoes);
}

async function concluirOAuthBling(pool, config, entrada, opcoes = {}) {
  validarConfiguracao(config);
  const state = String(entrada?.state || '').trim();
  const code = String(entrada?.code || '').trim();
  if (!state || state.length > 512 || !code || code.length > 2048) {
    throw falha('Retorno OAuth Bling inválido', 'RETORNO_OAUTH_BLING_INVALIDO', 400);
  }
  const stateHash = crypto.createHash('sha256').update(state).digest('hex');
  const connection = await pool.getConnection();
  let estado;
  try {
    await connection.beginTransaction();
    [[estado]] = await connection.query(
      `SELECT id, usuario_id, expira_em, usado_em
         FROM integracao_oauth_estados
        WHERE provedor='BLING' AND state_hash=? LIMIT 1 FOR UPDATE`, [stateHash]
    );
    if (!estado || estado.usado_em || new Date(estado.expira_em).getTime() <= Date.now()) {
      throw falha('Estado OAuth Bling inválido ou expirado',
        'OAUTH_BLING_STATE_INVALIDO', 400);
    }
    await connection.query(
      'UPDATE integracao_oauth_estados SET usado_em=NOW() WHERE id=?', [estado.id]
    );
    await connection.commit();
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally {
    connection.release();
  }

  const tokens = await trocarCodigo(config, code, opcoes);
  const agora = Date.now();
  const accessExpiraEm = new Date(agora + Number(tokens.expires_in) * 1000);
  const refreshExpiraEm = new Date(agora + 30 * 24 * 60 * 60 * 1000);
  const accessCifrado = cifrarToken(tokens.access_token, config.encryptionKey);
  const refreshCifrado = cifrarToken(tokens.refresh_token, config.encryptionKey);
  const persistencia = await pool.getConnection();
  try {
    await persistencia.beginTransaction();
    await persistencia.query(
      `INSERT INTO integracao_oauth_tokens
         (provedor, access_token_cifrado, refresh_token_cifrado, token_tipo,
          escopos, access_expira_em, refresh_expira_em, atualizado_por)
       VALUES ('BLING', ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token_cifrado=VALUES(access_token_cifrado),
         refresh_token_cifrado=VALUES(refresh_token_cifrado),
         token_tipo=VALUES(token_tipo), escopos=VALUES(escopos),
         access_expira_em=VALUES(access_expira_em),
         refresh_expira_em=VALUES(refresh_expira_em),
         atualizado_por=VALUES(atualizado_por), atualizado_em=NOW()`,
      [accessCifrado, refreshCifrado, String(tokens.token_type || 'Bearer').slice(0, 40),
        String(tokens.scope || '').slice(0, 2000) || null,
        accessExpiraEm, refreshExpiraEm, estado.usuario_id || null]
    );
    await persistencia.query(
      `INSERT INTO auditoria
         (usuario_id, modulo, acao, entidade, entidade_id, descricao,
          dados_antes, dados_depois, ip)
       VALUES (?, 'INTEGRACOES', 'CONECTAR_OAUTH_BLING',
               'integracao_oauth_tokens', 'BLING',
               'Conta Bling conectada por OAuth', NULL, ?, ?)`,
      [estado.usuario_id || null, JSON.stringify({
        provedor: 'BLING', token_tipo: String(tokens.token_type || 'Bearer'),
        access_expira_em: accessExpiraEm.toISOString(),
        refresh_expira_em: refreshExpiraEm.toISOString()
      }), opcoes.ip || null]
    );
    await persistencia.commit();
  } catch (erro) {
    await persistencia.rollback();
    throw erro;
  } finally {
    persistencia.release();
  }
  return { ok: true, conectado: true,
    access_expira_em: accessExpiraEm.toISOString(),
    refresh_expira_em: refreshExpiraEm.toISOString() };
}

async function obterStatusOAuthBling(pool, config) {
  const configurado = Boolean(config?.clientId && config?.clientSecret &&
    config?.redirectUri && config?.encryptionKey);
  const [[token]] = await pool.query(
    `SELECT token_tipo, access_expira_em, refresh_expira_em, atualizado_em
       FROM integracao_oauth_tokens WHERE provedor='BLING' LIMIT 1`
  );
  const agora = Date.now();
  const refreshValido = Boolean(token && new Date(token.refresh_expira_em).getTime() > agora);
  return {
    ok: true,
    habilitado: Boolean(config?.habilitado),
    configurado,
    conectado: refreshValido,
    access_token_valido: Boolean(token && new Date(token.access_expira_em).getTime() > agora),
    reautorizacao_necessaria: Boolean(token && !refreshValido),
    access_expira_em: token?.access_expira_em || null,
    refresh_expira_em: token?.refresh_expira_em || null,
    atualizado_em: token?.atualizado_em || null
  };
}

async function renovarOAuthBling(pool, config, opcoes = {}) {
  validarConfiguracao(config);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[atual]] = await connection.query(
      `SELECT refresh_token_cifrado, refresh_expira_em
         FROM integracao_oauth_tokens
        WHERE provedor='BLING' LIMIT 1 FOR UPDATE`
    );
    if (!atual || new Date(atual.refresh_expira_em).getTime() <= Date.now()) {
      throw falha('Reautorização Bling necessária',
        'REAUTORIZACAO_BLING_NECESSARIA', 409);
    }
    const refreshToken = descriptografarToken(
      atual.refresh_token_cifrado, config.encryptionKey
    );
    const tokens = await solicitarTokens(config, {
      grant_type: 'refresh_token', refresh_token: refreshToken
    }, opcoes);
    const agora = Date.now();
    const accessExpiraEm = new Date(agora + Number(tokens.expires_in) * 1000);
    const refreshExpiraEm = new Date(agora + 30 * 24 * 60 * 60 * 1000);
    await connection.query(
      `UPDATE integracao_oauth_tokens
          SET access_token_cifrado=?, refresh_token_cifrado=?, token_tipo=?,
              escopos=?, access_expira_em=?, refresh_expira_em=?,
              atualizado_por=?, atualizado_em=NOW()
        WHERE provedor='BLING'`,
      [cifrarToken(tokens.access_token, config.encryptionKey),
        cifrarToken(tokens.refresh_token, config.encryptionKey),
        String(tokens.token_type || 'Bearer').slice(0, 40),
        String(tokens.scope || '').slice(0, 2000) || null,
        accessExpiraEm, refreshExpiraEm, opcoes.usuarioId || null]
    );
    await connection.query(
      `INSERT INTO auditoria
         (usuario_id, modulo, acao, entidade, entidade_id, descricao,
          dados_antes, dados_depois, ip)
       VALUES (?, 'INTEGRACOES', 'RENOVAR_OAUTH_BLING',
               'integracao_oauth_tokens', 'BLING',
               'Tokens OAuth Bling renovados', NULL, ?, ?)`,
      [opcoes.usuarioId || null, JSON.stringify({
        provedor: 'BLING', access_expira_em: accessExpiraEm.toISOString(),
        refresh_expira_em: refreshExpiraEm.toISOString()
      }), opcoes.ip || null]
    );
    await connection.commit();
    return { ok: true, conectado: true,
      access_expira_em: accessExpiraEm.toISOString(),
      refresh_expira_em: refreshExpiraEm.toISOString() };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally {
    connection.release();
  }
}

module.exports = {
  AUTORIZACAO_URL,
  TOKEN_URL,
  cifrarToken,
  concluirOAuthBling,
  descriptografarToken,
  iniciarOAuthBling,
  obterStatusOAuthBling,
  renovarOAuthBling,
  trocarCodigo
};
