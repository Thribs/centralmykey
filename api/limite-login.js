'use strict';

const crypto = require('crypto');

function chave(valor) {
  return crypto.createHash('sha256').update(String(valor || '')).digest('hex');
}

function criarLimitadorLogin(opcoes = {}) {
  const agora = opcoes.agora || (() => Date.now());
  const janelaMs = opcoes.janelaMs || 15 * 60 * 1000;
  const bloqueioMs = opcoes.bloqueioMs || 15 * 60 * 1000;
  const limiteConta = opcoes.limiteConta || 5;
  const limiteIp = opcoes.limiteIp || 20;
  const maximoChaves = opcoes.maximoChaves || 10000;
  const contas = new Map();
  const ips = new Map();

  function limitarMemoria(mapa, instante) {
    if (mapa.size < maximoChaves) return;
    for (const [id, estado] of mapa) {
      if (instante - estado.inicio >= janelaMs && estado.bloqueadoAte <= instante) {
        mapa.delete(id);
      }
    }
    while (mapa.size >= maximoChaves) {
      mapa.delete(mapa.keys().next().value);
    }
  }

  function estadoAtual(mapa, identificador) {
    const id = chave(identificador);
    const instante = agora();
    limitarMemoria(mapa, instante);
    let estado = mapa.get(id);
    if (!estado || instante - estado.inicio >= janelaMs) {
      estado = { inicio: instante, falhas: 0, bloqueadoAte: 0 };
      mapa.set(id, estado);
    }
    return { estado, instante };
  }

  function verificar({ login, ip }) {
    const itens = [estadoAtual(contas, login), estadoAtual(ips, ip)];
    const bloqueadoAte = Math.max(...itens.map(item => item.estado.bloqueadoAte));
    return {
      permitido: bloqueadoAte <= itens[0].instante,
      tentarNovamenteEm: bloqueadoAte > itens[0].instante
        ? Math.ceil((bloqueadoAte - itens[0].instante) / 1000)
        : 0
    };
  }

  function registrarFalha({ login, ip }) {
    for (const [mapa, identificador, limite] of [
      [contas, login, limiteConta],
      [ips, ip, limiteIp]
    ]) {
      const item = estadoAtual(mapa, identificador);
      item.estado.falhas += 1;
      if (item.estado.falhas >= limite) {
        item.estado.bloqueadoAte = item.instante + bloqueioMs;
      }
    }
  }

  function registrarSucesso({ login, ip }) {
    contas.delete(chave(login));
    ips.delete(chave(ip));
  }

  return { verificar, registrarFalha, registrarSucesso };
}

module.exports = { criarLimitadorLogin };
