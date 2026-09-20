export const TIMEOUT_PADRAO_MS = 30000;

function erroOperacional(mensagem, codigo, causa) {
  const erro = new Error(mensagem, { cause: causa });
  erro.codigo = codigo;
  return erro;
}

export async function requisitar(
  url,
  opcoes = {},
  { timeoutMs = TIMEOUT_PADRAO_MS } = {}
) {
  const sinalExterno = opcoes.signal;
  const controlador = sinalExterno ? null : new AbortController();
  const temporizador = controlador
    ? globalThis.setTimeout(() => controlador.abort(), timeoutMs)
    : null;

  try {
    return await fetch(url, {
      ...opcoes,
      signal: sinalExterno || controlador.signal
    });
  } catch (erro) {
    if (erro?.name === 'AbortError') {
      if (sinalExterno) throw erro;
      throw erroOperacional(
        `A solicitação ultrapassou ${Math.ceil(timeoutMs / 1000)} segundos. Tente novamente.`,
        'TEMPO_ESGOTADO',
        erro
      );
    }
    if (erro instanceof TypeError) {
      throw erroOperacional(
        'Não foi possível conectar à Central MyKey. Verifique a conexão e tente novamente.',
        'REDE_INDISPONIVEL',
        erro
      );
    }
    throw erro;
  } finally {
    if (temporizador !== null) globalThis.clearTimeout(temporizador);
  }
}
