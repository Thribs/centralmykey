'use strict';

const STATUS = {
  APPROVED: 'APROVADO',
  IN_APPEAL: 'PENDENTE',
  PENDING: 'PENDENTE',
  REJECTED: 'REJEITADO',
  PAUSED: 'PAUSADO',
  DISABLED: 'DESATIVADO',
  DELETED: 'DESATIVADO',
  PENDING_DELETION: 'DESATIVADO'
};

function normalizarModelo(item) {
  const nome = String(item?.name || item?.nome || '').trim();
  const idioma = String(
    typeof item?.language === 'object' ? item.language.code :
      item?.language || item?.idioma || ''
  ).trim();
  const statusExterno = String(item?.status || '').trim().toUpperCase();
  const status = STATUS[statusExterno];
  if (!nome || !idioma || !status) return null;
  return { nome, idioma, status, statusExterno };
}

async function sincronizarModelosSendPulse(connection, modelosRemotos, contexto = {}) {
  const remotos = (Array.isArray(modelosRemotos) ? modelosRemotos : [])
    .map(normalizarModelo).filter(Boolean);
  let encontrados = 0;
  let atualizados = 0;

  for (const remoto of remotos) {
    const [locais] = await connection.query(
      `SELECT id, nome, idioma, status, ativo
         FROM whatsapp_modelos
        WHERE nome=? AND idioma=? LIMIT 1 FOR UPDATE`,
      [remoto.nome, remoto.idioma]
    );
    if (!locais.length) continue;
    encontrados += 1;
    const local = locais[0];
    const ativo = remoto.status === 'APROVADO' ? Number(local.ativo) : 0;
    const mudou = local.status !== remoto.status || Number(local.ativo) !== ativo;
    if (mudou) {
      await connection.query(
        'UPDATE whatsapp_modelos SET status=?, ativo=? WHERE id=?',
        [remoto.status, ativo, local.id]
      );
      atualizados += 1;
    }
    await connection.query(
      `INSERT INTO auditoria
         (usuario_id, modulo, acao, entidade, entidade_id, descricao,
          dados_antes, dados_depois, ip)
       VALUES (?, 'CONFIGURACOES', 'SINCRONIZAR_MODELO_SENDPULSE',
               'whatsapp_modelos', ?, ?, ?, ?, ?)`,
      [
        contexto.usuarioId || null,
        String(local.id),
        `Status do modelo ${local.nome} confirmado pela SendPulse`,
        JSON.stringify({ status: local.status, ativo: Boolean(local.ativo) }),
        JSON.stringify({ status: remoto.status, ativo: Boolean(ativo),
          status_externo: remoto.statusExterno }),
        contexto.ip || null
      ]
    );
  }
  return { remotos: remotos.length, encontrados, atualizados };
}

module.exports = { normalizarModelo, sincronizarModelosSendPulse };
