import { expect, test } from '@playwright/test';

const API = 'http://127.0.0.1:4175';
const sessao = {
  ok: true,
  usuario: {
    id: 900001,
    nome: 'OPERADOR E2E',
    login: 'operador_e2e',
    perfil_id: 1,
    perfil: 'Administrador',
    status: 'ATIVO',
    senha_provisoria: 0
  },
  permissoes: [
    { codigo: 'DASHBOARD', modulo: 'Dashboard', visualizar: 1 },
    { codigo: 'PEDIDOS_SENHAS', modulo: 'Pedidos e senhas', visualizar: 1 },
    { codigo: 'CLIENTES', modulo: 'Clientes', visualizar: 1 }
  ]
};

function json(route, corpo, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(corpo)
  });
}

async function prepararPagina(page, tratar) {
  await page.addInitScript(() => {
    localStorage.setItem('central_mykey_token', 'token-e2e-ficticio');
    localStorage.setItem('central_mykey_troca_senha', '0');
  });
  await page.route(`${API}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/me') return json(route, sessao);
    if (url.pathname === '/api/notificacoes/resumo') {
      return json(route, { ok: true, nao_lidas: 0, criticas: 0 });
    }
    if (tratar && await tratar(route, url)) return undefined;
    return json(route, {
      ok: false,
      error: `Rota simulada ausente: ${url.pathname}`,
      codigo: 'ROTA_SIMULADA_AUSENTE'
    }, 404);
  });
}

test('busca global abre o pedido com filtro aplicado', async ({ page }) => {
  const protocolo = 'CMK-E2E-0001';
  let filtroRecebido = '';
  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/busca-global') {
      expect(url.searchParams.get('termo')).toBe(protocolo);
      await json(route, {
        ok: true,
        total: 1,
        dados: [{
          tipo: 'PEDIDO',
          id: 700001,
          modulo: 'PEDIDOS_SENHAS',
          titulo: protocolo,
          descricao: 'CLIENTE E2E · Senha GM',
          estado: 'ABERTO',
          busca: protocolo
        }]
      });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos/resumo') {
      await json(route, { ok: true, indicadores: {} });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos') {
      filtroRecebido = url.searchParams.get('busca') || '';
      await json(route, {
        ok: true,
        total: 1,
        dados: [{
          id: 700001,
          protocolo,
          cliente: 'CLIENTE E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: 'CHASSI-E2E-00001',
          status: 'ABERTO',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        }]
      });
      return true;
    }
    return false;
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const busca = page.getByRole('searchbox', { name: 'Buscar na Central' });
  await busca.fill(protocolo);
  await page.getByRole('option', { name: new RegExp(protocolo) }).click();

  await expect(page.getByRole('heading', { name: 'Pedidos e senhas', level: 2 }))
    .toBeVisible();
  await expect(page.getByPlaceholder('Protocolo, cliente, chassi ou serviço'))
    .toHaveValue(protocolo);
  await expect(page.getByText(protocolo, { exact: true }).last()).toBeVisible();
  expect(filtroRecebido).toBe(protocolo);
});

test('erro com referência é exibido e a atualização recupera a fila', async ({ page }) => {
  let liberarFila = false;
  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/fila-pedidos/resumo') {
      await json(route, { ok: true, indicadores: {} });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos') {
      if (!liberarFila) {
        await json(route, {
          ok: false,
          error: 'Fila temporariamente indisponível',
          codigo: 'SERVICO_INDISPONIVEL',
          request_id: 'req-e2e-recuperacao-123'
        }, 503);
      } else {
        await json(route, { ok: true, total: 0, dados: [] });
      }
      return true;
    }
    return false;
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  await expect(page.getByText(/referência: req-e2e-recuperacao-123/)).toBeVisible();

  liberarFila = true;
  await page.getByTitle('Atualizar pedidos').click();
  await expect(page.getByText(/referência: req-e2e-recuperacao-123/)).toBeHidden();
  await expect(page.getByText('0 pedido(s)')).toBeVisible();
});

test('menu móvel abre sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepararPagina(page);
  await page.goto('/');

  await expect(page.getByRole('searchbox', { name: 'Buscar na Central' })).toBeHidden();
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await expect(page.locator('.sidebar')).toHaveClass(/sidebar-open/);
  const dimensoes = await page.evaluate(() => ({
    largura: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  }));
  expect(dimensoes.largura).toBeLessThanOrEqual(dimensoes.viewport);
});

test('cancelamento exige motivo e confirmação antes de uma única mutação', async ({ page }) => {
  const protocolo = 'CMK-E2E-CANCELAR';
  const pedidoId = 700002;
  let cancelado = false;
  let requisicoesCancelamento = 0;
  let dadosCancelamento = null;
  let liberarResposta;
  const respostaLiberada = new Promise(resolve => {
    liberarResposta = resolve;
  });
  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/fila-pedidos/resumo') {
      await json(route, { ok: true, indicadores: {} });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos') {
      await json(route, {
        ok: true,
        total: 1,
        dados: [{
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE CANCELAMENTO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: 'CHASSI-E2E-CANCEL',
          status: cancelado ? 'CANCELADO' : 'ABERTO',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        }]
      });
      return true;
    }
    if (url.pathname === `/api/pedidos/${pedidoId}`) {
      await json(route, {
        ok: true,
        pedido: {
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE CANCELAMENTO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: 'CHASSI-E2E-CANCEL',
          status: cancelado ? 'CANCELADO' : 'ABERTO',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        },
        partes: {},
        resultados: [],
        historico: [],
        comunicacoes: []
      });
      return true;
    }
    if (
      url.pathname === `/api/pedidos/${pedidoId}/cancelar` &&
      route.request().method() === 'POST'
    ) {
      requisicoesCancelamento += 1;
      dadosCancelamento = route.request().postDataJSON();
      await respostaLiberada;
      cancelado = true;
      await json(route, { ok: true, status: 'CANCELADO' });
      return true;
    }
    return false;
  });

  const dialogos = [
    { tipo: 'prompt', aceitar: true, valor: 'Cancelamento E2E controlado' },
    { tipo: 'confirm', aceitar: false },
    { tipo: 'prompt', aceitar: true, valor: 'Cancelamento E2E controlado' },
    { tipo: 'confirm', aceitar: true }
  ];
  page.on('dialog', async dialogo => {
    const esperado = dialogos.shift();
    expect(dialogo.type()).toBe(esperado.tipo);
    if (esperado.aceitar) await dialogo.accept(esperado.valor);
    else await dialogo.dismiss();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  await page.locator('tr', { hasText: protocolo }).click();
  const detalhe = page.getByRole('dialog');
  await expect(detalhe).toBeVisible();

  await detalhe.getByRole('button', { name: 'Cancelar pedido' }).click();
  expect(requisicoesCancelamento).toBe(0);
  await expect(detalhe.getByRole('button', { name: 'Cancelar pedido' })).toBeVisible();

  await detalhe.getByRole('button', { name: 'Cancelar pedido' }).click();
  await expect(page.getByRole('status')).toContainText('Cancelando o pedido');
  expect(requisicoesCancelamento).toBe(1);
  expect(dadosCancelamento).toEqual({ motivo: 'Cancelamento E2E controlado' });
  liberarResposta();

  await expect(detalhe.getByText('Cancelado', { exact: true })).toBeVisible();
  await expect(detalhe.getByRole('button', { name: 'Cancelar pedido' })).toBeHidden();
  expect(dialogos).toHaveLength(0);
});

test('pagamento manual bloqueia repetição enquanto processa e atualiza o pedido', async ({ page }) => {
  const protocolo = 'CMK-E2E-PAGAMENTO';
  const pedidoId = 700003;
  let confirmado = false;
  let requisicoesPagamento = 0;
  let dadosPagamento = null;
  let liberarResposta;
  const respostaLiberada = new Promise(resolve => {
    liberarResposta = resolve;
  });

  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/fila-pedidos/resumo') {
      await json(route, {
        ok: true,
        indicadores: { aguardando_pagamento: confirmado ? 0 : 1 }
      });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos') {
      await json(route, {
        ok: true,
        total: 1,
        dados: [{
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE PAGAMENTO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: 'CHASSI-E2E-PAGAR',
          status: confirmado ? 'CONCLUIDO' : 'AGUARDANDO_PAGAMENTO',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        }]
      });
      return true;
    }
    if (url.pathname === `/api/pedidos/${pedidoId}`) {
      await json(route, {
        ok: true,
        pedido: {
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE PAGAMENTO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: 'CHASSI-E2E-PAGAR',
          status: confirmado ? 'CONCLUIDO' : 'AGUARDANDO_PAGAMENTO',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        },
        partes: {
          pagador: { nome: 'PAGADOR PAGAMENTO E2E' }
        },
        resultados: confirmado ? [{
          id: 990001,
          status: 'ENCONTRADO',
          senha: 'SENHA-E2E',
          origem: 'API_JOELPIRES',
          confirmado: 1,
          fornecedor_id: null
        }] : [],
        historico: [],
        comunicacoes: []
      });
      return true;
    }
    if (
      url.pathname === `/api/pedidos/${pedidoId}/pagamento/confirmar-manual` &&
      route.request().method() === 'POST'
    ) {
      requisicoesPagamento += 1;
      dadosPagamento = route.request().postDataJSON();
      await respostaLiberada;
      confirmado = true;
      await json(route, {
        ok: true,
        pedido: { id: pedidoId, protocolo, status: 'CONCLUIDO' },
        pagamento: {
          id: 980001,
          valor: 60,
          moeda: 'BRL',
          meio_pagamento: 'PIX'
        },
        processamento: {
          status: 'CONCLUIDO',
          origem: 'API_JOELPIRES',
          resultado: 'ENCONTRADO'
        }
      });
      return true;
    }
    return false;
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  await page.locator('tr', { hasText: protocolo }).click();
  const detalhe = page.getByRole('dialog');
  await expect(detalhe).toBeVisible();
  await detalhe.getByRole('button', { name: 'Confirmar pagamento' }).click();

  const formulario = page.locator('form.payment-modal');
  await expect(formulario.getByRole('heading', { name: 'Confirmar pagamento' }))
    .toBeVisible();
  await expect(formulario.getByText('Pagador: PAGADOR PAGAMENTO E2E'))
    .toBeVisible();
  await formulario.getByLabel('Referência do pagamento')
    .fill('PIX-E2E-IDEMPOTENTE');
  await formulario.getByLabel('Observação').fill('Comprovante fictício E2E');
  await formulario.getByRole('button', { name: 'Confirmar pagamento' }).click();

  await expect(page.getByRole('status')).toContainText(
    'Confirmando o pagamento e consultando a senha'
  );
  await expect(page.getByRole('status')).toContainText(
    'Não feche esta tela nem repita a operação'
  );
  await expect(formulario.getByRole('button', { name: 'Confirmando...' }))
    .toBeDisabled();
  await expect(formulario.getByRole('button', { name: 'Fechar' })).toBeDisabled();
  expect(requisicoesPagamento).toBe(1);
  expect(dadosPagamento).toEqual({
    meio_pagamento: 'PIX',
    referencia_externa: 'PIX-E2E-IDEMPOTENTE',
    observacao: 'Comprovante fictício E2E'
  });

  liberarResposta();

  await expect(formulario).toBeHidden();
  await expect(detalhe.getByText('Concluído', { exact: true })).toBeVisible();
  await expect(detalhe.getByRole('button', { name: 'Confirmar pagamento' }))
    .toBeHidden();
  expect(requisicoesPagamento).toBe(1);
});

test('navegador confirma pagamento GM contra API e MySQL transacionais', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.encontrado;
  const referencia = `PIX-${contexto.protocolo}`;

  await page.addInitScript(() => {
    localStorage.setItem('central_mykey_token', 'token-e2e-integrado');
    localStorage.setItem('central_mykey_troca_senha', '0');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  const busca = page.getByPlaceholder('Protocolo, cliente, chassi ou serviço');
  await busca.fill(contexto.protocolo);
  const linha = page.locator('tr', { hasText: contexto.protocolo });
  await expect(linha).toBeVisible();
  await linha.click();

  const detalhe = page.getByRole('dialog');
  await expect(detalhe.getByText('Aguardando pagamento', { exact: true }))
    .toBeVisible();
  await detalhe.getByRole('button', { name: 'Confirmar pagamento' }).click();
  const formulario = page.locator('form.payment-modal');
  await formulario.getByLabel('Referência do pagamento').fill(referencia);
  await formulario.getByRole('button', { name: 'Confirmar pagamento' }).click();

  await expect(page.getByRole('status')).toContainText(
    'Confirmando o pagamento e consultando a senha'
  );
  await expect(formulario).toBeHidden({ timeout: 10000 });
  await expect(detalhe.getByText('Concluído', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('MEC-E2E-INTEGRADO', { exact: true }))
    .toBeVisible();
  await expect(detalhe.getByText('Base própria / não definido', { exact: true }))
    .toBeVisible();
  await expect(detalhe.getByText('Aguardando envio', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(
    'Nenhum envio ao fornecedor foi registrado.'
  )).toBeVisible();

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('CONCLUIDO');
  expect(Number(verificacao.estado.custo)).toBe(0);
  expect(verificacao.estado.fornecedor_id).toBeNull();
  expect(Number(verificacao.estado.pagamentos)).toBe(1);
  expect(Number(verificacao.estado.resultados)).toBe(1);
  expect(Number(verificacao.estado.cache)).toBe(1);
  expect(Number(verificacao.estado.entregas)).toBe(1);
  expect(Number(verificacao.estado.consultas_fornecedor)).toBe(0);
});

test('navegador encaminha 404 real ao fornecedor na transação', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.nao_encontrado;

  await page.addInitScript(() => {
    localStorage.setItem('central_mykey_token', 'token-e2e-integrado');
    localStorage.setItem('central_mykey_troca_senha', '0');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  const busca = page.getByPlaceholder('Protocolo, cliente, chassi ou serviço');
  await busca.fill(contexto.protocolo);
  const linha = page.locator('tr', { hasText: contexto.protocolo });
  await expect(linha).toBeVisible();
  await linha.click();

  const detalhe = page.getByRole('dialog');
  await detalhe.getByRole('button', { name: 'Confirmar pagamento' }).click();
  const formulario = page.locator('form.payment-modal');
  await formulario.getByLabel('Referência do pagamento')
    .fill(`PIX-${contexto.protocolo}`);
  await formulario.getByRole('button', { name: 'Confirmar pagamento' }).click();

  await expect(formulario).toBeHidden({ timeout: 10000 });
  await expect(detalhe.getByText('Em consulta', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(contexto.fornecedor, { exact: true }))
    .toBeVisible();
  await expect(detalhe.getByText('R$ 0,01', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('Aguardando envio', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(
    'O resultado ainda não foi preparado para entrega.'
  )).toBeVisible();

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=nao_encontrado`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('EM_CONSULTA');
  expect(Number(verificacao.estado.custo)).toBeCloseTo(0.01);
  expect(Number(verificacao.estado.fornecedor_id)).toBe(contexto.fornecedor_id);
  expect(verificacao.estado.fornecedor).toBe(contexto.fornecedor);
  expect(Number(verificacao.estado.pagamentos)).toBe(1);
  expect(Number(verificacao.estado.resultados)).toBe(0);
  expect(Number(verificacao.estado.cache)).toBe(0);
  expect(Number(verificacao.estado.entregas || 0)).toBe(0);
  expect(Number(verificacao.estado.consultas_fornecedor)).toBe(1);
});

test('navegador corrige 422 real e conclui sem fornecedor na transação', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.dados_invalidos;

  await page.addInitScript(() => {
    localStorage.setItem('central_mykey_token', 'token-e2e-integrado');
    localStorage.setItem('central_mykey_troca_senha', '0');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  const busca = page.getByPlaceholder('Protocolo, cliente, chassi ou serviço');
  await busca.fill(contexto.protocolo);
  const linha = page.locator('tr', { hasText: contexto.protocolo });
  await expect(linha).toBeVisible();
  await linha.click();

  const detalhe = page.getByRole('dialog');
  await detalhe.getByRole('button', { name: 'Confirmar pagamento' }).click();
  const formularioPagamento = page.locator('form.payment-modal');
  await formularioPagamento.getByLabel('Referência do pagamento')
    .fill(`PIX-${contexto.protocolo}`);
  await formularioPagamento.getByRole('button', { name: 'Confirmar pagamento' })
    .click();

  await expect(formularioPagamento).toBeHidden({ timeout: 10000 });
  await expect(detalhe.getByText('Aguardando dados', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('R$ 0,00', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('Base própria / não definido', { exact: true }))
    .toBeVisible();
  await expect(detalhe.getByText(
    'Nenhum envio ao fornecedor foi registrado.'
  )).toBeVisible();

  let respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=dados_invalidos`
  );
  let verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('AGUARDANDO_DADOS');
  expect(Number(verificacao.estado.dados_invalidos)).toBe(1);
  expect(Number(verificacao.estado.custo)).toBe(0);
  expect(verificacao.estado.fornecedor_id).toBeNull();
  expect(Number(verificacao.estado.pagamentos)).toBe(1);
  expect(Number(verificacao.estado.cache)).toBe(0);
  expect(Number(verificacao.estado.consultas_fornecedor || 0)).toBe(0);

  await detalhe.getByRole('button', { name: 'Corrigir dados' }).click();
  const modal = page.locator('.gm-result-modal');
  await modal.getByLabel('Chassi').fill(contexto.chassi_corrigido);
  await modal.getByLabel('Marca').fill('GM');
  await modal.getByLabel('Modelo').fill('ONIX');
  await modal.getByLabel('Ano').fill('2026');
  await modal.getByRole('button', { name: 'Salvar e consultar novamente' }).click();

  await expect(page.getByRole('status')).toContainText('Consultando novamente');
  await expect(modal).toBeHidden({ timeout: 10000 });
  await expect(detalhe.getByText('Concluído', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('MEC-E2E-CORRIGIDO', { exact: true }))
    .toBeVisible();
  await expect(detalhe.getByText('Aguardando envio', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(
    'Nenhum envio ao fornecedor foi registrado.'
  )).toBeVisible();

  respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=dados_invalidos`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('CONCLUIDO');
  expect(Number(verificacao.estado.custo)).toBe(0);
  expect(verificacao.estado.fornecedor_id).toBeNull();
  expect(Number(verificacao.estado.resultados)).toBe(1);
  expect(Number(verificacao.estado.cache)).toBe(1);
  expect(Number(verificacao.estado.entregas)).toBe(1);
  expect(Number(verificacao.estado.consultas_fornecedor || 0)).toBe(0);
});

test('navegador reprocessa HTTP 503 real sem acionar fornecedor', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.indisponivel;

  await page.addInitScript(() => {
    localStorage.setItem('central_mykey_token', 'token-e2e-integrado');
    localStorage.setItem('central_mykey_troca_senha', '0');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  const busca = page.getByPlaceholder('Protocolo, cliente, chassi ou serviço');
  await busca.fill(contexto.protocolo);
  const linha = page.locator('tr', { hasText: contexto.protocolo });
  await expect(linha).toBeVisible();
  await linha.click();

  const detalhe = page.getByRole('dialog');
  await detalhe.getByRole('button', { name: 'Confirmar pagamento' }).click();
  const formulario = page.locator('form.payment-modal');
  await formulario.getByLabel('Referência do pagamento')
    .fill(`PIX-${contexto.protocolo}`);
  await formulario.getByRole('button', { name: 'Confirmar pagamento' }).click();

  await expect(formulario).toBeHidden({ timeout: 10000 });
  await expect(detalhe.getByText('Aberto', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(
    'API Joel Pires temporariamente indisponível'
  )).toBeVisible();
  await expect(detalhe.getByText(/Nenhum fornecedor foi acionado/)).toBeVisible();
  await expect(detalhe.getByText('R$ 0,00', { exact: true })).toBeVisible();

  let respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=indisponivel`
  );
  let verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('ABERTO');
  expect(Number(verificacao.estado.indisponibilidades)).toBe(1);
  expect(verificacao.estado.fornecedor_id).toBeNull();
  expect(Number(verificacao.estado.custo)).toBe(0);
  expect(Number(verificacao.estado.pagamentos)).toBe(1);
  expect(Number(verificacao.estado.cache)).toBe(0);
  expect(Number(verificacao.estado.consultas_fornecedor || 0)).toBe(0);

  await detalhe.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Consultando novamente a API Joel Pires'
  );
  await expect(detalhe.getByText('Concluído', { exact: true }))
    .toBeVisible({ timeout: 10000 });
  await expect(detalhe.getByText('MEC-E2E-REPROCESSADO', { exact: true }))
    .toBeVisible();
  await expect(detalhe.getByText('Aguardando envio', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(
    'Nenhum envio ao fornecedor foi registrado.'
  )).toBeVisible();

  respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=indisponivel`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('CONCLUIDO');
  expect(Number(verificacao.estado.resultados)).toBe(1);
  expect(Number(verificacao.estado.cache)).toBe(1);
  expect(Number(verificacao.estado.entregas)).toBe(1);
  expect(Number(verificacao.estado.consultas_fornecedor || 0)).toBe(0);
});

test('navegador registra resultado real e prepara entrega na transação', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.resultado_fornecedor;

  await page.addInitScript(() => {
    localStorage.setItem('central_mykey_token', 'token-e2e-integrado');
    localStorage.setItem('central_mykey_troca_senha', '0');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  const busca = page.getByPlaceholder('Protocolo, cliente, chassi ou serviço');
  await busca.fill(contexto.protocolo);
  const linha = page.locator('tr', { hasText: contexto.protocolo });
  await expect(linha).toBeVisible();
  await linha.click();

  const detalhe = page.getByRole('dialog');
  await expect(detalhe.getByText('Em consulta', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(contexto.fornecedor, { exact: true }))
    .toBeVisible();
  await detalhe.getByRole('button', { name: 'Informar resultado' }).click();

  const modalResultado = page.locator('.gm-result-modal');
  await modalResultado.getByLabel('Código mecânico').fill('MEC-FORNECEDOR-E2E');
  await modalResultado.getByLabel('Imobilizador').fill('IMMO-FORNECEDOR-E2E');
  await modalResultado.getByRole('button', { name: 'Salvar resultado' }).click();
  await expect(page.getByRole('status')).toContainText('Registrando resultado');
  await expect(modalResultado).toBeHidden({ timeout: 10000 });

  await expect(detalhe.getByText('Concluído', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('ENCONTRADO', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('Envio cancelado', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(
    'O resultado ainda não foi preparado para entrega.'
  )).toBeVisible();
  await detalhe.getByRole('button', { name: 'Cliente confirmou' }).click();

  const modalValidacao = page.getByRole('dialog', { name: 'Confirmar funcionamento' });
  await modalValidacao.getByRole('button', { name: 'Confirmar senha correta' }).click();
  await expect(modalValidacao).toBeHidden({ timeout: 10000 });

  await expect(detalhe.getByText('CONFIRMADO', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('Aguardando envio', { exact: true })).toBeVisible();
  await expect(detalhe.getByRole('button', { name: 'Cliente confirmou' }))
    .toBeHidden();

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=resultado_fornecedor`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('CONCLUIDO');
  expect(Number(verificacao.estado.custo)).toBeCloseTo(0.01);
  expect(Number(verificacao.estado.fornecedor_id)).toBe(contexto.fornecedor_id);
  expect(Number(verificacao.estado.resultados)).toBe(1);
  expect(Number(verificacao.estado.cache)).toBe(1);
  expect(Number(verificacao.estado.entregas)).toBe(1);
  expect(Number(verificacao.estado.consultas_fornecedor)).toBe(1);
  expect(Number(verificacao.estado.consultas_canceladas)).toBe(1);
});

test('navegador estorna pagamento real e cancela na transação', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.estorno;

  await page.addInitScript(() => {
    localStorage.setItem('central_mykey_token', 'token-e2e-integrado');
    localStorage.setItem('central_mykey_troca_senha', '0');
  });
  const dialogos = [
    ['prompt', 'Devolução integral E2E'],
    ['confirm'],
    ['prompt', 'PIX'],
    ['prompt', `DEVOLUCAO-${contexto.protocolo}`],
    ['confirm']
  ];
  page.on('dialog', async dialogo => {
    const [tipo, valor] = dialogos.shift();
    expect(dialogo.type()).toBe(tipo);
    if (tipo === 'prompt') await dialogo.accept(valor);
    else await dialogo.accept();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  const busca = page.getByPlaceholder('Protocolo, cliente, chassi ou serviço');
  await busca.fill(contexto.protocolo);
  const linha = page.locator('tr', { hasText: contexto.protocolo });
  await expect(linha).toBeVisible();
  await linha.click();

  const detalhe = page.getByRole('dialog');
  await expect(detalhe.getByText('Aberto', { exact: true })).toBeVisible();
  await detalhe.getByRole('button', { name: 'Cancelar pedido' }).click();

  await expect(detalhe.getByText('Cancelado', { exact: true }))
    .toBeVisible({ timeout: 10000 });
  await expect(detalhe.getByRole('button', { name: 'Cancelar pedido' }))
    .toBeHidden();
  expect(dialogos).toHaveLength(0);

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=estorno`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('CANCELADO');
  expect(Number(verificacao.estado.custo)).toBe(0);
  expect(verificacao.estado.fornecedor_id).toBeNull();
  expect(Number(verificacao.estado.pagamentos)).toBe(2);
  expect(Number(verificacao.estado.estornos)).toBe(1);
  expect(Number(verificacao.estado.despesas_estorno)).toBe(1);
  expect(Number(verificacao.estado.consultas_fornecedor || 0)).toBe(0);
});

test('estorno e cancelamento só são registrados após confirmar a devolução', async ({ page }) => {
  const protocolo = 'CMK-E2E-ESTORNO';
  const pedidoId = 700004;
  let cancelado = false;
  let tentativasCancelamento = 0;
  let requisicoesEstorno = 0;
  let dadosEstorno = null;
  let liberarResposta;
  const respostaLiberada = new Promise(resolve => {
    liberarResposta = resolve;
  });

  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/fila-pedidos/resumo') {
      await json(route, { ok: true, indicadores: {} });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos') {
      await json(route, {
        ok: true,
        total: 1,
        dados: [{
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE ESTORNO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: 'CHASSI-E2E-ESTORNO',
          status: cancelado ? 'CANCELADO' : 'ABERTO',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        }]
      });
      return true;
    }
    if (url.pathname === `/api/pedidos/${pedidoId}`) {
      await json(route, {
        ok: true,
        pedido: {
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE ESTORNO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: 'CHASSI-E2E-ESTORNO',
          status: cancelado ? 'CANCELADO' : 'ABERTO',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        },
        partes: {},
        resultados: [],
        historico: [],
        comunicacoes: []
      });
      return true;
    }
    if (
      url.pathname === `/api/pedidos/${pedidoId}/cancelar` &&
      route.request().method() === 'POST'
    ) {
      tentativasCancelamento += 1;
      await json(route, {
        ok: false,
        codigo: 'ESTORNO_FINANCEIRO_NECESSARIO',
        error: 'O pagamento deve ser estornado antes do cancelamento'
      }, 409);
      return true;
    }
    if (
      url.pathname === `/api/pedidos/${pedidoId}/estornar-e-cancelar` &&
      route.request().method() === 'POST'
    ) {
      requisicoesEstorno += 1;
      dadosEstorno = route.request().postDataJSON();
      await respostaLiberada;
      cancelado = true;
      await json(route, {
        ok: true,
        estorno: { id: 970001, idempotente: false },
        cancelamento: { status: 'CANCELADO' }
      });
      return true;
    }
    return false;
  });

  const dialogos = [
    ['prompt', true, 'Estorno E2E controlado'],
    ['confirm', true],
    ['prompt', true, 'PIX'],
    ['prompt', true, 'DEVOLUCAO-E2E-001'],
    ['confirm', false],
    ['prompt', true, 'Estorno E2E controlado'],
    ['confirm', true],
    ['prompt', true, 'PIX'],
    ['prompt', true, 'DEVOLUCAO-E2E-001'],
    ['confirm', true]
  ];
  page.on('dialog', async dialogo => {
    const [tipo, aceitar, valor] = dialogos.shift();
    expect(dialogo.type()).toBe(tipo);
    if (aceitar) await dialogo.accept(valor);
    else await dialogo.dismiss();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  await page.locator('tr', { hasText: protocolo }).click();
  const detalhe = page.getByRole('dialog');
  const botaoCancelar = detalhe.getByRole('button', { name: 'Cancelar pedido' });

  await botaoCancelar.click();
  await expect(botaoCancelar).toBeVisible();
  expect(tentativasCancelamento).toBe(1);
  expect(requisicoesEstorno).toBe(0);

  await botaoCancelar.click();
  await expect(page.getByRole('status')).toContainText(
    'Registrando estorno e cancelando o pedido'
  );
  expect(tentativasCancelamento).toBe(2);
  expect(requisicoesEstorno).toBe(1);
  expect(dadosEstorno).toEqual({
    meio_estorno: 'PIX',
    referencia_externa: 'DEVOLUCAO-E2E-001',
    motivo_estorno: 'Estorno E2E controlado',
    motivo_cancelamento: 'Estorno E2E controlado'
  });

  liberarResposta();

  await expect(detalhe.getByText('Cancelado', { exact: true })).toBeVisible();
  await expect(botaoCancelar).toBeHidden();
  expect(requisicoesEstorno).toBe(1);
  expect(dialogos).toHaveLength(0);
});

test('resultado do fornecedor é validado antes de preparar a entrega ao cliente', async ({ page }) => {
  const protocolo = 'CMK-E2E-RESULTADO';
  const pedidoId = 700005;
  let etapa = 'CONSULTA';
  let requisicoesResultado = 0;
  let requisicoesConfirmacao = 0;
  let dadosResultado = null;
  let liberarResultado;
  let liberarConfirmacao;
  const resultadoLiberado = new Promise(resolve => {
    liberarResultado = resolve;
  });
  const confirmacaoLiberada = new Promise(resolve => {
    liberarConfirmacao = resolve;
  });

  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/fila-pedidos/resumo') {
      await json(route, { ok: true, indicadores: {} });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos') {
      await json(route, {
        ok: true,
        total: 1,
        dados: [{
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE RESULTADO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: '9BG-E2E-RESULTADO',
          fornecedor: 'Márcio',
          status: etapa === 'CONSULTA' ? 'EM_CONSULTA' : 'CONCLUIDO',
          valor_venda: 60,
          custo: 22,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        }]
      });
      return true;
    }
    if (url.pathname === `/api/pedidos/${pedidoId}`) {
      const possuiResultado = etapa !== 'CONSULTA';
      await json(route, {
        ok: true,
        pedido: {
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE RESULTADO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: '9BG-E2E-RESULTADO',
          fornecedor: 'Márcio',
          fornecedor_id: 850001,
          status: possuiResultado ? 'CONCLUIDO' : 'EM_CONSULTA',
          valor_venda: 60,
          custo: 22,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        },
        partes: {},
        resultados: possuiResultado ? [{
          id: 960001,
          fornecedor_id: 850001,
          origem: 'Fornecedor externo',
          status: etapa === 'CONFIRMADO' ? 'CONFIRMADO' : 'ENCONTRADO',
          codigo_mecanico: 'MC-E2E-01',
          codigo_imobilizador: 'IM-E2E-02',
          resultado: { codigo_alarme: 'AL-E2E-03' },
          criado_em: '2026-09-21T12:10:00Z'
        }] : [],
        historico: [],
        comunicacoes: [
          {
            id: 950001,
            finalidade: 'CONSULTA_FORNECEDOR',
            status: 'ENVIADA',
            tentativas: 1,
            enviado_em: '2026-09-21T12:05:00Z'
          },
          ...(etapa === 'CONFIRMADO' ? [{
            id: 950002,
            finalidade: 'ENTREGA_CLIENTE',
            status: 'PENDENTE',
            tentativas: 0,
            atualizado_em: '2026-09-21T12:12:00Z'
          }] : [])
        ]
      });
      return true;
    }
    if (
      url.pathname === `/api/pedidos/${pedidoId}/resultado` &&
      route.request().method() === 'POST'
    ) {
      requisicoesResultado += 1;
      dadosResultado = route.request().postDataJSON();
      await resultadoLiberado;
      etapa = 'RESULTADO';
      await json(route, {
        ok: true,
        pedido: { id: pedidoId, protocolo, status: 'CONCLUIDO' },
        resultado: { id: 960001, codigo_mecanico: 'MC-E2E-01' }
      }, 201);
      return true;
    }
    if (
      url.pathname === `/api/pedidos/${pedidoId}/resultado/confirmar` &&
      route.request().method() === 'POST'
    ) {
      requisicoesConfirmacao += 1;
      expect(route.request().postDataJSON()).toEqual({});
      await confirmacaoLiberada;
      etapa = 'CONFIRMADO';
      await json(route, {
        ok: true,
        pedido_id: pedidoId,
        resultado_id: 960001,
        banco_senha_id: 940001,
        acao_base: 'CRIADO',
        entrega: { criada: true, id: 950002, status: 'PENDENTE' }
      });
      return true;
    }
    return false;
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  await page.locator('tr', { hasText: protocolo }).click();
  const detalhe = page.getByRole('dialog');
  await detalhe.getByRole('button', { name: 'Informar resultado' }).click();

  const modalResultado = page.locator('.gm-result-modal');
  await expect(modalResultado).toHaveAccessibleName(protocolo);
  await expect(modalResultado.getByText('Márcio', { exact: true })).toBeVisible();
  await modalResultado.getByLabel('Código mecânico').fill('mc-e2e-01');
  await modalResultado.getByLabel('Imobilizador').fill('im-e2e-02');
  await modalResultado.getByLabel('Alarme').fill('al-e2e-03');
  await modalResultado.getByRole('button', { name: 'Salvar resultado' }).click();

  await expect(page.getByRole('status')).toContainText('Registrando resultado');
  await expect(modalResultado.getByRole('button', { name: 'Salvando resultado...' }))
    .toBeDisabled();
  await expect(modalResultado.getByRole('button', { name: 'Fechar' })).toBeDisabled();
  expect(requisicoesResultado).toBe(1);
  expect(dadosResultado).toEqual({
    codigo_mecanico: 'MC-E2E-01',
    codigo_imobilizador: 'IM-E2E-02',
    codigo_radio: '',
    codigo_alarme: 'AL-E2E-03',
    pin: ''
  });

  liberarResultado();

  await expect(modalResultado).toBeHidden();
  await expect(detalhe.getByText('ENCONTRADO', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(
    'O resultado ainda não foi preparado para entrega.'
  )).toBeVisible();
  await detalhe.getByRole('button', { name: 'Cliente confirmou' }).click();

  const modalValidacao = page.getByRole('dialog', { name: 'Confirmar funcionamento' });
  await modalValidacao.getByRole('button', { name: 'Confirmar senha correta' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Atualizando pedido e cache'
  );
  await expect(modalValidacao.getByRole('button', { name: 'Processando...' }))
    .toBeDisabled();
  expect(requisicoesConfirmacao).toBe(1);

  liberarConfirmacao();

  await expect(modalValidacao).toBeHidden();
  await expect(detalhe.getByText('CONFIRMADO', { exact: true })).toBeVisible();
  await expect(detalhe.getByRole('heading', { name: 'Entrega ao cliente' }))
    .toBeVisible();
  await expect(detalhe.getByText('Aguardando envio', { exact: true }).last())
    .toBeVisible();
  await expect(detalhe.getByRole('button', { name: 'Cliente confirmou' }))
    .toBeHidden();
  expect(requisicoesResultado).toBe(1);
  expect(requisicoesConfirmacao).toBe(1);
});

test('resultado incorreto segue uma única vez ao próximo fornecedor', async ({ page }) => {
  const protocolo = 'CMK-E2E-INCORRETO';
  const pedidoId = 700008;
  let redirecionado = false;
  let requisicoes = 0;
  let dadosRecebidos = null;
  let liberarResposta;
  const respostaLiberada = new Promise(resolve => {
    liberarResposta = resolve;
  });

  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/fila-pedidos/resumo') {
      await json(route, { ok: true, indicadores: {} });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos') {
      await json(route, {
        ok: true,
        total: 1,
        dados: [{
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE INCORRETO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: '9BG-E2E-INCORRETO',
          fornecedor: redirecionado ? 'Emerson' : 'Márcio',
          status: redirecionado ? 'EM_CONSULTA' : 'CONCLUIDO',
          valor_venda: 60,
          custo: redirecionado ? 25 : 22,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        }]
      });
      return true;
    }
    if (url.pathname === `/api/pedidos/${pedidoId}`) {
      await json(route, {
        ok: true,
        pedido: {
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE INCORRETO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: '9BG-E2E-INCORRETO',
          fornecedor: redirecionado ? 'Emerson' : 'Márcio',
          fornecedor_id: redirecionado ? 850002 : 850001,
          status: redirecionado ? 'EM_CONSULTA' : 'CONCLUIDO',
          valor_venda: 60,
          custo: redirecionado ? 25 : 22,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        },
        partes: {},
        resultados: [{
          id: 880001,
          fornecedor_id: 850001,
          origem: 'Fornecedor externo',
          status: redirecionado ? 'INCORRETO' : 'ENCONTRADO',
          codigo_mecanico: 'MC-INCORRETO-E2E',
          criado_em: '2026-09-21T12:10:00Z'
        }],
        historico: redirecionado ? [{
          id: 870001,
          tipo: 'RESULTADO_INCORRETO',
          descricao: 'Código mecânico não funcionou no veículo',
          criado_em: '2026-09-21T12:15:00Z'
        }] : [],
        comunicacoes: redirecionado ? [{
          id: 860001,
          finalidade: 'CONSULTA_FORNECEDOR',
          fornecedor_id: 850002,
          status: 'PENDENTE',
          tentativas: 0,
          atualizado_em: '2026-09-21T12:15:00Z'
        }] : []
      });
      return true;
    }
    if (
      url.pathname === `/api/pedidos/${pedidoId}/resultado/incorreto` &&
      route.request().method() === 'POST'
    ) {
      requisicoes += 1;
      dadosRecebidos = route.request().postDataJSON();
      await respostaLiberada;
      redirecionado = true;
      await json(route, {
        ok: true,
        pedido: { id: pedidoId, protocolo, status: 'EM_CONSULTA' },
        base: { banco_senha_id: null, bloqueada: false },
        fornecedor: {
          id: 850002,
          nome: 'Emerson',
          custo: 25,
          envio: { id: 860001, status: 'PENDENTE' }
        }
      });
      return true;
    }
    return false;
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  await page.locator('tr', { hasText: protocolo }).click();
  const detalhe = page.getByRole('dialog');
  await detalhe.getByRole('button', { name: 'Senha incorreta' }).click();

  const modal = page.getByRole('dialog', { name: 'Informar erro' });
  await modal.getByLabel('Motivo do erro').fill('não');
  await modal.getByRole('button', { name: 'Confirmar resultado incorreto' }).click();
  await expect(modal.getByText('Informe o motivo do resultado incorreto.'))
    .toBeVisible();
  expect(requisicoes).toBe(0);

  await modal.getByLabel('Motivo do erro')
    .fill('Código mecânico não funcionou no veículo');
  await modal.getByRole('button', { name: 'Confirmar resultado incorreto' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Atualizando pedido e cache'
  );
  await expect(modal.getByRole('button', { name: 'Processando...' }))
    .toBeDisabled();
  expect(requisicoes).toBe(1);
  expect(dadosRecebidos).toEqual({
    motivo: 'Código mecânico não funcionou no veículo'
  });

  liberarResposta();

  await expect(modal).toBeHidden();
  await expect(detalhe.getByText('Em consulta', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('Emerson', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('R$ 25,00', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('INCORRETO', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('Aguardando envio', { exact: true })).toBeVisible();
  await expect(detalhe.getByRole('button', { name: 'Senha incorreta' }))
    .toBeHidden();
  expect(requisicoes).toBe(1);
});

test('dados GM rejeitados são corrigidos e reprocessados sem fornecedor', async ({ page }) => {
  const protocolo = 'CMK-E2E-CORRECAO';
  const pedidoId = 700006;
  let corrigido = false;
  let requisicoesCorrecao = 0;
  let dadosCorrecao = null;
  let liberarResposta;
  const respostaLiberada = new Promise(resolve => {
    liberarResposta = resolve;
  });

  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/fila-pedidos/resumo') {
      await json(route, { ok: true, indicadores: {} });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos') {
      await json(route, {
        ok: true,
        total: 1,
        dados: [{
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE CORRECAO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          modelo: corrigido ? 'ONIX' : 'MODELO INCORRETO',
          ano: corrigido ? 2026 : 2025,
          chassi: corrigido ? '9BGKS48U0RG123456' : '9BG-DADO-INVALIDO',
          fornecedor: null,
          fornecedor_id: null,
          status: corrigido ? 'CONCLUIDO' : 'AGUARDANDO_DADOS',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        }]
      });
      return true;
    }
    if (url.pathname === `/api/pedidos/${pedidoId}`) {
      await json(route, {
        ok: true,
        pedido: {
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE CORRECAO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          modelo: corrigido ? 'ONIX' : 'MODELO INCORRETO',
          ano: corrigido ? 2026 : 2025,
          chassi: corrigido ? '9BGKS48U0RG123456' : '9BG-DADO-INVALIDO',
          fornecedor: null,
          fornecedor_id: null,
          status: corrigido ? 'CONCLUIDO' : 'AGUARDANDO_DADOS',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        },
        partes: {},
        resultados: corrigido ? [{
          id: 930001,
          fornecedor_id: null,
          origem: 'API',
          status: 'CONFIRMADO',
          codigo_mecanico: 'MC-CORRIGIDO-E2E',
          criado_em: '2026-09-21T12:15:00Z'
        }] : [],
        historico: [],
        comunicacoes: corrigido ? [{
          id: 920001,
          finalidade: 'ENTREGA_CLIENTE',
          status: 'PENDENTE',
          tentativas: 0,
          atualizado_em: '2026-09-21T12:15:00Z'
        }] : []
      });
      return true;
    }
    if (
      url.pathname === `/api/pedidos/${pedidoId}/corrigir-dados` &&
      route.request().method() === 'POST'
    ) {
      requisicoesCorrecao += 1;
      dadosCorrecao = route.request().postDataJSON();
      await respostaLiberada;
      corrigido = true;
      await json(route, {
        ok: true,
        dados: dadosCorrecao,
        processamento: {
          status: 'CONCLUIDO',
          origem: 'API_JOELPIRES',
          resultado: 'ENCONTRADO'
        }
      });
      return true;
    }
    return false;
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  await page.locator('tr', { hasText: protocolo }).click();
  const detalhe = page.getByRole('dialog');
  await expect(detalhe.getByText('Aguardando dados', { exact: true })).toBeVisible();
  await detalhe.getByRole('button', { name: 'Corrigir dados' }).click();

  const modal = page.locator('.gm-result-modal');
  await expect(modal).toHaveAccessibleName(protocolo);
  await modal.getByLabel('Chassi').fill('9bgks48u0rg123456');
  await modal.getByLabel('Marca').fill('gm');
  await modal.getByLabel('Modelo').fill('onix');
  await modal.getByLabel('Ano').fill('2026');
  await modal.getByRole('button', { name: 'Salvar e consultar novamente' }).click();

  await expect(page.getByRole('status')).toContainText('Consultando novamente');
  await expect(modal.getByRole('button', { name: 'Corrigindo e consultando...' }))
    .toBeDisabled();
  await expect(modal.getByRole('button', { name: 'Fechar' })).toBeDisabled();
  expect(requisicoesCorrecao).toBe(1);
  expect(dadosCorrecao).toEqual({
    chassi: '9BGKS48U0RG123456',
    marca: 'GM',
    modelo: 'ONIX',
    ano: 2026
  });

  liberarResposta();

  await expect(modal).toBeHidden();
  await expect(detalhe.getByText('Concluído', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('MC-CORRIGIDO-E2E', { exact: true }))
    .toBeVisible();
  await expect(detalhe.getByText('Base própria / não definido', { exact: true }))
    .toBeVisible();
  await expect(detalhe.getByRole('heading', { name: 'Comunicação com fornecedor' }))
    .toBeVisible();
  await expect(detalhe.getByText(
    'Nenhum envio ao fornecedor foi registrado.'
  )).toBeVisible();
  await expect(detalhe.getByText('Aguardando envio', { exact: true })).toBeVisible();
  await expect(detalhe.getByRole('button', { name: 'Corrigir dados' })).toBeHidden();
  expect(requisicoesCorrecao).toBe(1);
});

test('indisponibilidade da API é explicada e reprocessada sem fornecedor', async ({ page }) => {
  const protocolo = 'CMK-E2E-INDISPONIVEL';
  const pedidoId = 700007;
  let concluido = false;
  let requisicoesReprocessamento = 0;
  let liberarResposta;
  const respostaLiberada = new Promise(resolve => {
    liberarResposta = resolve;
  });

  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/fila-pedidos/resumo') {
      await json(route, { ok: true, indicadores: {} });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos') {
      await json(route, {
        ok: true,
        total: 1,
        dados: [{
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE INDISPONIBILIDADE E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: '9BG-E2E-INDISPONIVEL',
          fornecedor: null,
          fornecedor_id: null,
          status: concluido ? 'CONCLUIDO' : 'ABERTO',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        }]
      });
      return true;
    }
    if (url.pathname === `/api/pedidos/${pedidoId}`) {
      await json(route, {
        ok: true,
        pedido: {
          id: pedidoId,
          protocolo,
          cliente: 'CLIENTE INDISPONIBILIDADE E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: '9BG-E2E-INDISPONIVEL',
          fornecedor: null,
          fornecedor_id: null,
          status: concluido ? 'CONCLUIDO' : 'ABERTO',
          valor_venda: 60,
          custo: 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        },
        partes: {},
        resultados: concluido ? [{
          id: 910001,
          fornecedor_id: null,
          origem: 'API',
          status: 'CONFIRMADO',
          codigo_mecanico: 'MC-REPROCESSADO-E2E',
          criado_em: '2026-09-21T12:20:00Z'
        }] : [],
        historico: concluido ? [{
          id: 900002,
          tipo: 'RESULTADO_ENCONTRADO',
          descricao: 'Senha localizada após nova tentativa',
          criado_em: '2026-09-21T12:20:00Z'
        }] : [{
          id: 900001,
          tipo: 'API_JOELPIRES_INDISPONIVEL',
          descricao: 'API Joel Pires indisponível; fornecedor externo não acionado',
          criado_em: '2026-09-21T12:10:00Z'
        }],
        comunicacoes: concluido ? [{
          id: 890001,
          finalidade: 'ENTREGA_CLIENTE',
          status: 'PENDENTE',
          tentativas: 0,
          atualizado_em: '2026-09-21T12:20:00Z'
        }] : []
      });
      return true;
    }
    if (
      url.pathname === `/api/pedidos/${pedidoId}/reprocessar` &&
      route.request().method() === 'POST'
    ) {
      requisicoesReprocessamento += 1;
      await respostaLiberada;
      concluido = true;
      await json(route, {
        ok: true,
        processamento: {
          status: 'CONCLUIDO',
          origem: 'API_JOELPIRES',
          resultado: 'ENCONTRADO'
        }
      });
      return true;
    }
    return false;
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  await page.locator('tr', { hasText: protocolo }).click();
  const detalhe = page.getByRole('dialog');

  await expect(detalhe.getByText(
    'API Joel Pires temporariamente indisponível'
  )).toBeVisible();
  await expect(detalhe.getByText(/Nenhum fornecedor foi acionado/)).toBeVisible();
  await expect(detalhe.getByText('R$ 0,00', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('Base própria / não definido', { exact: true }))
    .toBeVisible();
  await expect(detalhe.getByText(
    'Nenhum envio ao fornecedor foi registrado.'
  )).toBeVisible();

  await detalhe.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Consultando novamente a API Joel Pires'
  );
  expect(requisicoesReprocessamento).toBe(1);

  liberarResposta();

  await expect(detalhe.getByText('Concluído', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(
    'API Joel Pires temporariamente indisponível'
  )).toBeHidden();
  await expect(detalhe.getByText('MC-REPROCESSADO-E2E', { exact: true }))
    .toBeVisible();
  await expect(detalhe.getByText('Aguardando envio', { exact: true })).toBeVisible();
  await expect(detalhe.getByRole('button', { name: 'Tentar novamente' }))
    .toBeHidden();
  expect(requisicoesReprocessamento).toBe(1);
});

test('retentativa de comunicação distingue falha confirmada de envio incerto', async ({ page }) => {
  const pedidos = [
    {
      id: 700009,
      protocolo: 'CMK-E2E-ENVIO-FALHOU',
      comunicacaoId: 840001,
      status: 'FALHOU',
      reagendada: false,
      requisicoes: 0,
      corpo: null
    },
    {
      id: 700010,
      protocolo: 'CMK-E2E-ENVIO-INCERTO',
      comunicacaoId: 840002,
      status: 'INCERTA',
      reagendada: false,
      requisicoes: 0,
      corpo: null
    }
  ];

  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/fila-pedidos/resumo') {
      await json(route, { ok: true, indicadores: {} });
      return true;
    }
    if (url.pathname === '/api/fila-pedidos') {
      await json(route, {
        ok: true,
        total: pedidos.length,
        dados: pedidos.map(item => ({
          id: item.id,
          protocolo: item.protocolo,
          cliente: 'CLIENTE COMUNICACAO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: `9BG-E2E-${item.id}`,
          fornecedor: 'Márcio',
          status: 'EM_CONSULTA',
          valor_venda: 60,
          custo: 22,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z',
          comunicacao_fornecedor_status: item.reagendada
            ? 'PENDENTE'
            : item.status
        }))
      });
      return true;
    }

    const pedido = pedidos.find(item =>
      url.pathname === `/api/pedidos/${item.id}`
    );
    if (pedido) {
      await json(route, {
        ok: true,
        pedido: {
          id: pedido.id,
          protocolo: pedido.protocolo,
          cliente: 'CLIENTE COMUNICACAO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          chassi: `9BG-E2E-${pedido.id}`,
          fornecedor: 'Márcio',
          fornecedor_id: 850001,
          status: 'EM_CONSULTA',
          valor_venda: 60,
          custo: 22,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        },
        partes: {},
        resultados: [],
        historico: [],
        comunicacoes: [{
          id: pedido.comunicacaoId,
          finalidade: 'CONSULTA_FORNECEDOR',
          fornecedor_id: 850001,
          status: pedido.reagendada ? 'PENDENTE' : pedido.status,
          tentativas: 1,
          erro_codigo: pedido.reagendada
            ? null
            : pedido.status === 'INCERTA'
              ? 'TIMEOUT'
              : 'FALHA_TRANSPORTE',
          atualizado_em: '2026-09-21T12:10:00Z'
        }]
      });
      return true;
    }

    const comunicacao = pedidos.find(item =>
      url.pathname === `/api/pedidos/${item.id}/comunicacoes/` +
        `${item.comunicacaoId}/reprocessar`
    );
    if (comunicacao && route.request().method() === 'POST') {
      comunicacao.requisicoes += 1;
      comunicacao.corpo = route.request().postDataJSON();
      comunicacao.reagendada = true;
      await json(route, {
        ok: true,
        comunicacao: {
          id: comunicacao.comunicacaoId,
          status: 'PENDENTE'
        }
      });
      return true;
    }
    return false;
  });

  const confirmacoes = [false, true];
  page.on('dialog', async dialogo => {
    expect(dialogo.type()).toBe('confirm');
    const aceitar = confirmacoes.shift();
    if (aceitar) await dialogo.accept();
    else await dialogo.dismiss();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();

  await page.locator('tr', { hasText: pedidos[0].protocolo }).click();
  let detalhe = page.getByRole('dialog');
  await expect(detalhe.getByText('Falha no envio', { exact: true })).toBeVisible();
  await expect(detalhe.getByText('Verifique a configuração da integração.'))
    .toBeVisible();
  await detalhe.getByRole('button', { name: 'Tentar envio novamente' }).click();
  await expect(detalhe.getByText('Aguardando envio', { exact: true })).toBeVisible();
  expect(pedidos[0].requisicoes).toBe(1);
  expect(pedidos[0].corpo).toEqual({ confirmar_nao_enviado: false });
  await detalhe.getByRole('button', { name: 'Fechar' }).click();

  await page.locator('tr', { hasText: pedidos[1].protocolo }).click();
  detalhe = page.getByRole('dialog');
  await expect(detalhe.getByText('Envio incerto', { exact: true })).toBeVisible();
  await expect(detalhe.getByText(
    'Confirme manualmente antes de tentar novo envio.'
  )).toBeVisible();
  const tentarNovamente = detalhe.getByRole('button', {
    name: 'Tentar envio novamente'
  });
  await tentarNovamente.click();
  expect(pedidos[1].requisicoes).toBe(0);
  await expect(tentarNovamente).toBeVisible();

  await tentarNovamente.click();
  await expect(detalhe.getByText('Aguardando envio', { exact: true })).toBeVisible();
  expect(pedidos[1].requisicoes).toBe(1);
  expect(pedidos[1].corpo).toEqual({ confirmar_nao_enviado: true });
  expect(confirmacoes).toHaveLength(0);
});

test('bloqueio de cliente só ocorre depois da confirmação', async ({ page }) => {
  let bloqueado = false;
  let alteracoes = 0;
  await prepararPagina(page, async (route, url) => {
    if (url.pathname === '/api/clientes-resumo') {
      await json(route, {
        ok: true,
        resumo: { total: 1, ativos: bloqueado ? 0 : 1 }
      });
      return true;
    }
    if (url.pathname === '/api/clientes' && route.request().method() === 'GET') {
      await json(route, {
        ok: true,
        total: 1,
        dados: [{
          id: 800001,
          nome: 'CLIENTE BLOQUEIO E2E',
          telefone: '5500000000000',
          cadastro_status: 'COMPLETO',
          tipo_cobranca: 'ANTECIPADO',
          credito_status: 'LIBERADO',
          ativo: bloqueado ? 0 : 1
        }]
      });
      return true;
    }
    if (
      url.pathname === '/api/clientes/800001/status' &&
      route.request().method() === 'PATCH'
    ) {
      alteracoes += 1;
      expect(route.request().postDataJSON()).toEqual({ ativo: 0 });
      bloqueado = true;
      await json(route, { ok: true, cliente_id: 800001, ativo: 0 });
      return true;
    }
    return false;
  });

  const confirmacoes = [false, true];
  page.on('dialog', async dialogo => {
    expect(dialogo.type()).toBe('confirm');
    const aceitar = confirmacoes.shift();
    if (aceitar) await dialogo.accept();
    else await dialogo.dismiss();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Clientes', exact: true }).click();
  const bloquear = page.getByRole('button', { name: 'Bloquear CLIENTE BLOQUEIO E2E' });
  await bloquear.click();
  expect(alteracoes).toBe(0);
  await expect(bloquear).toBeVisible();

  await bloquear.click();
  await expect(page.getByText('CLIENTE BLOQUEIO E2E', { exact: true })).toBeHidden();
  await expect(page.getByText('Nenhum registro encontrado.')).toBeVisible();
  expect(alteracoes).toBe(1);
  expect(confirmacoes).toHaveLength(0);
});
