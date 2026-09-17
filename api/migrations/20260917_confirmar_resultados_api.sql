UPDATE pedido_resultados pr
INNER JOIN origens_senha os
  ON os.id = pr.origem_id
INNER JOIN banco_senhas bs
  ON bs.id = pr.banco_senha_id
SET pr.status = 'CONFIRMADO'
WHERE pr.status = 'ENCONTRADO'
  AND os.codigo = 'API'
  AND bs.confiabilidade = 'CONFIRMADA';
