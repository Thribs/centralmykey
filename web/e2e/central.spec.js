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
    {
      codigo: 'PEDIDOS_SENHAS', modulo: 'Pedidos e senhas',
      visualizar: 1, criar: 1, editar: 1, excluir: 1, aprovar: 1
    },
    {
      codigo: 'CLIENTES', modulo: 'Clientes',
      visualizar: 1, criar: 1, editar: 1, excluir: 1, aprovar: 1
    },
    {
      codigo: 'FINANCEIRO', modulo: 'Financeiro',
      visualizar: 1, criar: 1, editar: 1, excluir: 1, aprovar: 1
    }
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

async function autenticarIntegrado(page, credenciais) {
  const resposta = await page.request.post(`${API}/api/auth/login`, {
    data: credenciais
  });
  expect(resposta.ok()).toBe(true);
  const corpo = await resposta.json();
  expect(corpo.token).toBeTruthy();
  await page.addInitScript(token => {
    localStorage.setItem('central_mykey_token', token);
    localStorage.setItem('central_mykey_troca_senha', '0');
  }, corpo.token);
  return corpo.token;
}

async function abrirModulo(page, nome, largura) {
  if (largura <= 860) {
    await page.getByRole('button', { name: 'Abrir menu' }).click();
  }
  await page.getByRole('button', { name: nome, exact: true }).click();
}

async function esperarSemRolagemHorizontal(page) {
  await expect.poll(async () => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth
  )).toBe(true);
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

test('formulários GM permanecem acessíveis em celular tablet e desktop', async ({ page }) => {
  test.setTimeout(90000);
  const pedidos = [
    ['CMK-RESP-PAGAMENTO', 710001, 'AGUARDANDO_PAGAMENTO'],
    ['CMK-RESP-RESULTADO', 710002, 'EM_CONSULTA'],
    ['CMK-RESP-CORRECAO', 710003, 'AGUARDANDO_DADOS'],
    ['CMK-RESP-VALIDACAO', 710004, 'CONCLUIDO']
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
        dados: pedidos.map(([protocolo, id, status]) => ({
          id,
          protocolo,
          cliente: 'CLIENTE RESPONSIVO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          modelo: 'ONIX',
          ano: 2026,
          chassi: `9BG-RESP-${id}`,
          fornecedor: status === 'EM_CONSULTA' || status === 'CONCLUIDO'
            ? 'Márcio'
            : null,
          status,
          valor_venda: 60,
          custo: status === 'EM_CONSULTA' || status === 'CONCLUIDO' ? 22 : 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        }))
      });
      return true;
    }
    if (url.pathname === '/api/clientes') {
      await json(route, {
        ok: true,
        dados: [{
          id: 720001,
          nome: 'CLIENTE RESPONSIVO E2E',
          telefone: '5500000000000',
          vip_elegivel: 1,
          ativo: 1
        }]
      });
      return true;
    }
    if (url.pathname === '/api/servicos') {
      await json(route, {
        ok: true,
        dados: [{
          id: 730001,
          codigo: 'GM_SENHA',
          nome: 'Senha GM',
          preco_base: 60,
          preco_vip: 50,
          moeda: 'BRL',
          exige_placa: 0,
          exige_chassi: 1,
          exige_documento: 0,
          ativo: 1
        }]
      });
      return true;
    }
    if (url.pathname === '/api/pagamentos/sicoob/status') {
      await json(route, { ok: true, disponivel: true, codigo: 'PRONTO' });
      return true;
    }
    if (
      url.pathname === '/api/pedidos/710001/pagamentos/sicoob' &&
      route.request().method() === 'POST'
    ) {
      await json(route, {
        ok: true,
        status: 'REGISTRADA',
        txid: 'SICOOBE2EFICTICIO00000000000001',
        valor: 60,
        moeda: 'BRL',
        location: 'pix.sicoob.invalid/e2e',
        pix_copia_cola: '000201PIX-COPIA-E-COLA-FICTICIO-E2E'
      }, 201);
      return true;
    }
    const item = pedidos.find(([, id]) => url.pathname === `/api/pedidos/${id}`);
    if (item) {
      const [protocolo, id, status] = item;
      await json(route, {
        ok: true,
        pedido: {
          id,
          protocolo,
          cliente: 'CLIENTE RESPONSIVO E2E',
          servico: 'Senha GM',
          marca: 'GM',
          modelo: 'ONIX',
          ano: 2026,
          chassi: `9BG-RESP-${id}`,
          fornecedor: status === 'EM_CONSULTA' || status === 'CONCLUIDO'
            ? 'Márcio'
            : null,
          fornecedor_id: status === 'EM_CONSULTA' || status === 'CONCLUIDO'
            ? 740001
            : null,
          status,
          valor_venda: 60,
          custo: status === 'EM_CONSULTA' || status === 'CONCLUIDO' ? 22 : 0,
          moeda: 'BRL',
          criado_em: '2026-09-21T12:00:00Z'
        },
        partes: {
          pagador: { nome: 'PAGADOR RESPONSIVO E2E' }
        },
        resultados: status === 'CONCLUIDO' ? [{
          id: 750001,
          fornecedor_id: 740001,
          origem: 'Fornecedor externo',
          status: 'ENCONTRADO',
          codigo_mecanico: 'MC-RESP-E2E',
          criado_em: '2026-09-21T12:10:00Z'
        }] : [],
        historico: [],
        comunicacoes: []
      });
      return true;
    }
    return false;
  });

  async function validarModal(modal, acaoFinal) {
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    const caixa = await modal.boundingBox();
    const viewport = page.viewportSize();
    expect(caixa).not.toBeNull();
    expect(caixa.x).toBeGreaterThanOrEqual(0);
    expect(caixa.y).toBeGreaterThanOrEqual(0);
    expect(caixa.x + caixa.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(caixa.y + caixa.height).toBeLessThanOrEqual(viewport.height + 1);
    const acao = modal.getByRole('button', { name: acaoFinal });
    await acao.scrollIntoViewIfNeeded();
    await expect(acao).toBeVisible();
    const largura = await page.evaluate(() => ({
      documento: document.documentElement.scrollWidth,
      viewport: window.innerWidth
    }));
    expect(largura.documento).toBeLessThanOrEqual(largura.viewport);
  }

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    if (viewport.width <= 900) {
      await page.getByRole('button', { name: 'Abrir menu' }).click();
    }
    await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();

    await page.getByRole('button', { name: 'Novo pedido' }).click();
    let modal = page.getByRole('dialog', { name: 'Novo pedido' });
    await modal.locator('select[name="cliente_id"]').selectOption('720001');
    await expect(modal.locator('select[name="servico_id"] option', {
      hasText: 'Senha GM'
    })).toContainText('VIP BRL 50');
    await modal.locator('select[name="servico_id"]').selectOption('730001');
    await expect(modal.getByLabel('Chassi')).toHaveAttribute('required', '');
    await expect(modal.getByLabel('Placa para consulta')).toHaveCount(0);
    await validarModal(modal, 'Criar pedido');
    await modal.getByRole('button', { name: 'Fechar' }).click();

    await page.locator('tr', { hasText: 'CMK-RESP-PAGAMENTO' }).click();
    let detalhe = page.getByRole('dialog', { name: 'CMK-RESP-PAGAMENTO' });
    await detalhe.getByRole('button', { name: 'Gerar Pix Sicoob' }).click();
    modal = page.getByRole('dialog', { name: 'Gerar cobrança Pix Sicoob' });
    await validarModal(modal, 'Gerar Pix');
    await modal.getByRole('button', { name: 'Gerar Pix', exact: true }).click();
    await expect(modal.getByLabel('Pix copia e cola')).toHaveValue(
      '000201PIX-COPIA-E-COLA-FICTICIO-E2E'
    );
    await expect(modal.getByText('Cobrança registrada no Sicoob')).toBeVisible();
    await modal.getByRole('button', { name: 'Fechar' }).last().click();
    await detalhe.getByRole('button', { name: 'Confirmar pagamento' }).click();
    modal = page.getByRole('dialog', { name: 'Confirmar pagamento' });
    await validarModal(modal, 'Confirmar pagamento');
    await modal.getByRole('button', { name: 'Fechar' }).click();
    await detalhe.getByRole('button', { name: 'Fechar' }).click();

    await page.locator('tr', { hasText: 'CMK-RESP-RESULTADO' }).click();
    detalhe = page.getByRole('dialog', { name: 'CMK-RESP-RESULTADO' });
    await detalhe.getByRole('button', { name: 'Informar resultado' }).click();
    modal = page.locator('.gm-result-modal');
    await expect(modal).toHaveAccessibleName('CMK-RESP-RESULTADO');
    await validarModal(modal, 'Salvar resultado');
    await modal.getByRole('button', { name: 'Fechar' }).click();
    await detalhe.getByRole('button', { name: 'Fechar' }).click();

    await page.locator('tr', { hasText: 'CMK-RESP-CORRECAO' }).click();
    detalhe = page.getByRole('dialog', { name: 'CMK-RESP-CORRECAO' });
    await detalhe.getByRole('button', { name: 'Corrigir dados' }).click();
    modal = page.locator('.gm-result-modal');
    await expect(modal).toHaveAccessibleName('CMK-RESP-CORRECAO');
    await validarModal(modal, 'Salvar e consultar novamente');
    await modal.getByRole('button', { name: 'Fechar' }).click();
    await detalhe.getByRole('button', { name: 'Fechar' }).click();

    await page.locator('tr', { hasText: 'CMK-RESP-VALIDACAO' }).click();
    detalhe = page.getByRole('dialog', { name: 'CMK-RESP-VALIDACAO' });
    await detalhe.getByRole('button', { name: 'Cliente confirmou' }).click();
    modal = page.getByRole('dialog', { name: 'Confirmar funcionamento' });
    await validarModal(modal, 'Confirmar senha correta');
    await modal.getByRole('button', { name: 'Fechar' }).click();
    await detalhe.getByRole('button', { name: 'Fechar' }).click();
  }
});

test('pedido pós-pago respeita o limite de crédito BRL', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.credito;
  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);

  await page.goto('/');
  await abrirModulo(page, 'Pedidos e senhas', 1280);
  await page.getByRole('button', { name: 'Novo pedido' }).click();
  const modal = page.getByRole('dialog', { name: 'Novo pedido' });
  await modal.locator('select[name="cliente_id"]')
    .selectOption(String(contexto.cliente_id));
  await modal.locator('select[name="servico_id"]')
    .selectOption(String(contexto.servico_id));
  await modal.getByLabel('Chassi').fill(contexto.chassi);
  await modal.getByLabel('Marca').fill('GM');
  await modal.getByLabel('Modelo').fill(contexto.modelo);
  await modal.getByLabel('Ano').fill('2026');
  await modal.getByRole('button', { name: 'Criar pedido' }).click();

  await expect(modal.locator('.vault-error')).toContainText(
    'excede o limite de crédito disponível'
  );
  await expect(modal).toBeVisible();
  const verificacaoResposta = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=limite_credito`
  );
  expect(verificacaoResposta.ok()).toBe(true);
  const verificacao = await verificacaoResposta.json();
  expect(Number(verificacao.estado.limite_credito)).toBe(contexto.limite);
  expect(Number(verificacao.estado.comprometido)).toBe(contexto.limite);
  expect(Number(verificacao.estado.pedidos)).toBe(0);
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

  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
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

  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
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

  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
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

  const token = await autenticarIntegrado(
    page,
    contextoCompleto.autenticacao.administrador
  );
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

  const resumoFila = await page.request.get(`${API}/api/fila-pedidos/resumo`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  expect(resumoFila.ok()).toBe(true);
  const corpoResumoFila = await resumoFila.json();
  expect(Number(corpoResumoFila.indicadores.aguardando_reprocessamento_gm))
    .toBeGreaterThanOrEqual(1);
  const filaReprocessamento = await page.request.get(
    `${API}/api/fila-pedidos?status=AGUARDANDO_REPROCESSAMENTO`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  expect(filaReprocessamento.ok()).toBe(true);
  const corpoFilaReprocessamento = await filaReprocessamento.json();
  expect(corpoFilaReprocessamento.dados.map(item => Number(item.id)))
    .toContain(Number(contexto.pedido_id));
  expect(Number(corpoFilaReprocessamento.dados.find(
    item => Number(item.id) === Number(contexto.pedido_id)
  ).aguardando_reprocessamento_gm)).toBe(1);

  await detalhe.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByText('Reprocessamento GM', { exact: true })).toBeVisible();
  await page.getByLabel('Status do pedido')
    .selectOption('AGUARDANDO_REPROCESSAMENTO');
  await expect(linha).toBeVisible();
  await expect(linha).toContainText('Aguardando reprocessamento automático');
  await linha.click();
  await expect(detalhe).toBeVisible();

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

  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
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

test('financeiro fecha e paga fornecedor uma única vez na transação', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.fechamento_fornecedor;

  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
  await page.setViewportSize({ width: 390, height: 844 });
  const dialogos = [
    ['confirm'],
    ['confirm'],
    ['prompt', contexto.referencia],
    ['confirm']
  ];
  page.on('dialog', async dialogo => {
    const [tipo, valor] = dialogos.shift();
    expect(dialogo.type()).toBe(tipo);
    if (tipo === 'prompt') await dialogo.accept(valor);
    else await dialogo.accept();
  });

  await page.goto('/');
  await abrirModulo(page, 'Financeiro', 390);
  await expect(page.getByRole('main').getByRole('heading', { name: 'Financeiro' }))
    .toBeVisible();
  await page.getByRole('main')
    .getByRole('button', { name: 'Fornecedores', exact: true }).click();
  await page.getByLabel('Fornecedor').selectOption(String(contexto.fornecedor_id));
  await page.getByRole('button', { name: 'Gerar última semana' }).click();

  let linha = page.locator('tr', { hasText: contexto.fornecedor });
  await expect(linha).toContainText('RASCUNHO');
  await expect(linha).toContainText('R$\u00a00,01');
  await linha.click();
  const detalhe = page.getByRole('dialog', { name: /Fechamento #/ });
  await expect(detalhe.getByText(contexto.protocolo, { exact: true })).toBeVisible();
  await expect(detalhe.getByText('1', { exact: true })).toBeVisible();
  const caixaDetalhe = await detalhe.boundingBox();
  expect(caixaDetalhe.width).toBeLessThanOrEqual(390);
  await detalhe.getByRole('button', { name: 'Fechar detalhes' }).click();

  linha = page.locator('tr', { hasText: contexto.fornecedor });
  await linha.getByRole('button', { name: 'Aprovar' }).click();
  await expect(linha).toContainText('FECHADO');
  await linha.getByRole('button', { name: 'Registrar pagamento' }).click();
  await expect(linha).toContainText('PAGO');
  expect(dialogos).toHaveLength(0);

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=fechamento_fornecedor`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('PAGO');
  expect(Number(verificacao.estado.quantidade_itens)).toBe(1);
  expect(Number(verificacao.estado.valor_total)).toBeCloseTo(0.01);
  expect(Number(verificacao.estado.itens)).toBe(1);
  expect(Number(verificacao.estado.lancamentos)).toBe(1);
  expect(Number(verificacao.estado.pagamentos)).toBe(1);
  await esperarSemRolagemHorizontal(page);
});

test('financeiro fecha e recebe fatura semanal uma única vez na transação', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.fatura_semanal;

  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
  const dialogos = [
    ['confirm'],
    ['prompt', contexto.referencia],
    ['confirm']
  ];
  page.on('dialog', async dialogo => {
    const [tipo, valor] = dialogos.shift();
    expect(dialogo.type()).toBe(tipo);
    if (tipo === 'prompt') await dialogo.accept(valor);
    else await dialogo.accept();
  });

  await page.goto('/');
  await abrirModulo(page, 'Financeiro');
  let linha = page.locator('tr', { hasText: `#${contexto.id}` });
  await expect(linha).toContainText('VENCIDA');
  await expect(linha.getByRole('button', { name: 'Registrar pagamento' }))
    .toHaveCount(0);
  await linha.getByRole('button', { name: 'Fechar', exact: true }).click();
  linha = page.locator('tr', { hasText: `#${contexto.id}` });
  await expect(linha).toContainText('VENCIDA');
  await linha.getByRole('button', { name: 'Registrar pagamento' }).click();
  await expect(linha).toContainText('PAGA');
  expect(dialogos).toHaveLength(0);

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=fatura_semanal`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('PAGA');
  expect(Number(verificacao.estado.valor_total)).toBeCloseTo(contexto.valor);
  expect(Number(verificacao.estado.lancamentos)).toBe(1);
  expect(Number(verificacao.estado.pagamentos)).toBe(1);
  expect(Number(verificacao.estado.auditorias)).toBe(2);
});

test('financeiro e administração permanecem acessíveis em três larguras', async ({ page }) => {
  test.setTimeout(90000);
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contexto = await respostaContexto.json();
  await autenticarIntegrado(page, contexto.autenticacao.administrador);

  const tamanhos = [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 1000 }
  ];

  for (const tamanho of tamanhos) {
    await page.setViewportSize(tamanho);
    await page.goto('/');

    await abrirModulo(page, 'Financeiro', tamanho.width);
    const financeiro = page.getByRole('main');
    await expect(financeiro.getByRole('heading', { name: 'Financeiro' }))
      .toBeVisible();
    await expect(financeiro.getByLabel('Moeda')).toBeVisible();
    await financeiro.getByRole('button', { name: 'Lançamentos', exact: true }).click();
    await expect(financeiro.getByPlaceholder(
      'Descrição, cliente, fornecedor ou protocolo'
    )).toBeVisible();
    await financeiro.getByRole('button', { name: 'Fornecedores', exact: true }).click();
    await expect(financeiro.getByLabel('Fornecedor')).toBeVisible();
    await expect(financeiro.getByRole('button', { name: 'Gerar última semana' }))
      .toBeVisible();
    await esperarSemRolagemHorizontal(page);

    await abrirModulo(page, 'Relatórios', tamanho.width);
    const relatorios = page.getByRole('main');
    await expect(relatorios.getByRole('heading', { name: 'Relatórios' }))
      .toBeVisible();
    await expect(relatorios.getByLabel('Data inicial')).toBeVisible();
    await expect(relatorios.getByLabel('Data final')).toBeVisible();
    await expect(relatorios.getByLabel('Moeda do relatório')).toBeVisible();
    await expect(relatorios.getByRole('button', { name: 'Gerar' })).toBeVisible();
    await esperarSemRolagemHorizontal(page);

    for (const modulo of ['Usuários', 'Configurações', 'Auditoria', 'Monitoramento']) {
      await abrirModulo(page, modulo, tamanho.width);
      await expect(page.getByRole('main').getByRole('heading', { name: modulo }))
        .toBeVisible();
      await esperarSemRolagemHorizontal(page);
    }
  }
});

test('clientes VIP e fornecedores são cadastrados pelas rotas reais', async ({ page }) => {
  test.setTimeout(60000);
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.cadastros;
  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/');
  await abrirModulo(page, 'Clientes', 390);
  await page.getByRole('button', { name: 'Novo cliente' }).click();
  const cliente = page.getByRole('dialog', { name: 'Cadastrar cliente' });
  await cliente.getByLabel('Nome').fill(contexto.cliente_nome);
  await cliente.getByLabel('Telefone').fill(contexto.cliente_telefone);
  await cliente.getByLabel('E-mail').fill(contexto.cliente_email);
  await cliente.getByLabel('Cidade').fill('Cidade fictícia');
  await cliente.getByLabel('Tipo de cobrança').selectOption('FATURAMENTO_SEMANAL');
  await cliente.getByLabel('Dia da semana do fechamento').selectOption('5');
  await cliente.getByLabel('Prazo de pagamento').fill('7');
  await cliente.getByLabel('Limite de crédito').fill('500');
  await cliente.getByRole('checkbox', { name: 'Cadastrar como cliente VIP' }).check();
  await cliente.getByLabel('Mensalidade VIP').fill('90');
  await cliente.getByLabel('Próximo vencimento VIP').fill('2026-12-31');
  await cliente.getByRole('button', { name: 'Salvar' }).click();
  await expect(cliente).toBeHidden({ timeout: 10000 });

  let linha = page.locator('tr', { hasText: contexto.cliente_nome });
  await expect(linha).toContainText('Semanal');
  await expect(linha).toContainText('VIP: ATIVO');
  await expect(linha).toContainText('Saldo: R$ 500,00 de R$ 500,00');
  page.once('dialog', dialogo => dialogo.accept());
  await linha.getByRole('button', { name: `Bloquear ${contexto.cliente_nome}` }).click();
  await page.getByLabel('Status do cadastro').selectOption('0');
  linha = page.locator('tr', { hasText: contexto.cliente_nome });
  await expect(linha).toContainText('Bloqueado');

  await abrirModulo(page, 'Fornecedores', 390);
  await page.getByRole('button', { name: 'Catálogo de serviços' }).click();
  const catalogo = page.getByRole('dialog', { name: 'Catálogo de serviços' });
  await catalogo.getByLabel('Código').fill(contexto.catalogo_codigo);
  await catalogo.getByLabel('Nome do serviço').fill(contexto.catalogo_nome);
  await catalogo.getByLabel('Categoria').fill('Consulta');
  await catalogo.getByLabel('Marca').fill('Marca fictícia');
  await catalogo.getByLabel('Preço base').fill('120.00');
  await catalogo.getByLabel('Preço VIP').fill('100.00');
  await catalogo.getByLabel('Exige chassi').check();
  await catalogo.getByRole('button', { name: 'Cadastrar serviço' }).click();
  let linhaCatalogo = catalogo.locator('tr', { hasText: contexto.catalogo_codigo });
  await expect(linhaCatalogo).toContainText('BRL 120.00');
  await expect(linhaCatalogo).toContainText('Chassi');
  await expect(linhaCatalogo).toContainText('Somente catálogo');
  await expect(linhaCatalogo).toContainText('fluxo ainda não implementado');
  await linhaCatalogo.getByTitle('Editar serviço').click();
  await catalogo.getByLabel('Preço base').fill('119.90');
  await catalogo.getByLabel('Preço VIP').fill('99.00');
  await catalogo.getByRole('button', { name: 'Atualizar serviço' }).click();
  linhaCatalogo = catalogo.locator('tr', { hasText: contexto.catalogo_codigo });
  await expect(linhaCatalogo).toContainText('BRL 119.90');
  await expect(linhaCatalogo).toContainText('VIP BRL 99.00');
  await catalogo.getByRole('button', { name: 'Fechar' }).click();

  await page.getByRole('button', { name: 'Novo fornecedor' }).click();
  const fornecedor = page.getByRole('dialog', { name: 'Cadastrar fornecedor' });
  await fornecedor.getByLabel('Nome').fill(contexto.fornecedor_nome);
  await fornecedor.getByLabel('Pessoa de contato').fill('Contato fictício');
  await fornecedor.getByLabel('Tipo').selectOption('PESSOA');
  await fornecedor.getByLabel('Telefone').fill('5500000000000');
  await fornecedor.getByLabel('WhatsApp').fill('5500000000000');
  await fornecedor.getByLabel('E-mail').fill(contexto.fornecedor_email);
  await fornecedor.getByLabel('Início do atendimento').fill('08:00');
  await fornecedor.getByLabel('Fim do atendimento').fill('18:00');
  await fornecedor.getByRole('button', { name: 'Salvar' }).click();
  await expect(fornecedor).toBeHidden({ timeout: 10000 });

  linha = page.locator('tr', { hasText: contexto.fornecedor_nome });
  await linha.getByRole('button', {
    name: `Serviços e custos de ${contexto.fornecedor_nome}`
  }).click();
  const servicos = page.getByRole('dialog', { name: contexto.fornecedor_nome });
  await servicos.getByLabel('Serviço').selectOption(contexto.catalogo_codigo);
  await servicos.getByLabel('Custo').fill('17.50');
  await servicos.getByLabel('Prazo estimado (minutos)').fill('30');
  await servicos.getByRole('button', { name: 'Adicionar regra' }).click();
  const regraServico = servicos.locator('tr', { hasText: contexto.catalogo_codigo });
  await expect(regraServico).toContainText('BRL 17.50');
  page.once('dialog', dialogo => dialogo.dismiss());
  await regraServico.getByTitle('Desativar regra').click();
  await expect(regraServico).toContainText('Ativo');
  page.once('dialog', dialogo => dialogo.accept());
  await regraServico.getByTitle('Desativar regra').click();
  await expect(regraServico).toContainText('Inativo');
  await servicos.getByRole('button', { name: 'Fechar' }).click();

  await page.getByRole('button', { name: 'Catálogo de serviços' }).click();
  const catalogoFinal = page.getByRole('dialog', { name: 'Catálogo de serviços' });
  linhaCatalogo = catalogoFinal.locator('tr', { hasText: contexto.catalogo_codigo });
  page.once('dialog', dialogo => dialogo.dismiss());
  await linhaCatalogo.getByTitle('Desativar serviço').click();
  await expect(linhaCatalogo).toContainText('Ativo');
  page.once('dialog', dialogo => dialogo.accept());
  await linhaCatalogo.getByTitle('Desativar serviço').click();
  await expect(linhaCatalogo).toContainText('Inativo');
  await catalogoFinal.getByRole('button', { name: 'Fechar' }).click();

  linha = page.locator('tr', { hasText: contexto.fornecedor_nome });
  page.once('dialog', dialogo => dialogo.accept());
  await linha.getByRole('button', { name: `Bloquear ${contexto.fornecedor_nome}` })
    .click();
  await page.getByLabel('Status do cadastro').selectOption('0');
  linha = page.locator('tr', { hasText: contexto.fornecedor_nome });
  await expect(linha).toContainText('Bloqueado');
  await esperarSemRolagemHorizontal(page);

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=cadastros`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(Number(verificacao.cliente.ativo)).toBe(0);
  expect(verificacao.cliente.tipo_cobranca).toBe('FATURAMENTO_SEMANAL');
  expect(Number(verificacao.cliente.dia_fechamento)).toBe(5);
  expect(Number(verificacao.cliente.prazo_pagamento_dias)).toBe(7);
  expect(verificacao.cliente.vip_status).toBe('ATIVO');
  expect(Number(verificacao.cliente.valor_mensalidade)).toBeCloseTo(90);
  expect(Number(verificacao.cliente.auditorias)).toBeGreaterThanOrEqual(2);
  expect(Number(verificacao.fornecedor.ativo)).toBe(0);
  expect(verificacao.fornecedor.tipo).toBe('PESSOA');
  expect(Number(verificacao.fornecedor.servicos)).toBe(0);
  expect(Number(verificacao.fornecedor.auditorias)).toBeGreaterThanOrEqual(2);
  expect(Number(verificacao.fornecedor.auditorias_servicos)).toBe(2);
  expect(verificacao.catalogo.codigo).toBe(contexto.catalogo_codigo);
  expect(Number(verificacao.catalogo.preco_base)).toBeCloseTo(119.9);
  expect(Number(verificacao.catalogo.preco_vip)).toBeCloseTo(99);
  expect(Number(verificacao.catalogo.exige_chassi)).toBe(1);
  expect(Number(verificacao.catalogo.ativo)).toBe(0);
  expect(Number(verificacao.catalogo.auditorias)).toBe(3);
});

test('administrador gerencia banco de senhas por permissão e confirmação', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.banco_senhas;
  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);

  await page.goto('/');
  await page.getByRole('button', { name: 'Banco de senhas', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', {
    name: 'Banco de senhas'
  })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Atualizar' })).toBeVisible();

  await page.getByRole('button', { name: 'Nova senha' }).click();
  const cadastro = page.getByRole('dialog', { name: 'Cadastrar senha' });
  await cadastro.getByLabel('Chassi').fill(contexto.novo_chassi);
  await cadastro.getByLabel('Modelo').fill('BANCO NOVO E2E');
  await cadastro.getByLabel('Ano inicial').fill('2026');
  await cadastro.getByLabel('Código mecânico original')
    .fill(contexto.novo_codigo);
  await cadastro.getByLabel('Confiabilidade').selectOption('ALTA');
  await cadastro.getByRole('button', { name: 'Salvar senha' }).click();
  await expect(cadastro).toBeHidden({ timeout: 10000 });

  await page.getByLabel('Status da senha').selectOption('');
  await page.getByPlaceholder('Chassi, mecânico, rádio, imobilizador ou alarme')
    .fill(contexto.novo_chassi);
  await page.getByRole('button', { name: 'Pesquisar' }).click();
  await expect(page.locator('tr', { hasText: contexto.novo_chassi }))
    .toContainText('Ativo');

  await page.getByPlaceholder('Chassi, mecânico, rádio, imobilizador ou alarme')
    .fill(contexto.chassi);
  await page.getByRole('button', { name: 'Pesquisar' }).click();
  const linha = page.locator('tr', { hasText: contexto.chassi });
  await expect(linha).toContainText('Ativo');

  page.once('dialog', dialogo => dialogo.dismiss());
  await linha.getByTitle('Bloquear').click();
  let verificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=banco_senhas`
  );
  let corpoVerificacao = await verificacao.json();
  let estado = corpoVerificacao.estado;
  expect(Number(estado.ativo)).toBe(1);
  expect(Number(estado.auditorias)).toBe(0);
  expect(Number(corpoVerificacao.criada.ativo)).toBe(1);
  expect(Number(corpoVerificacao.criada.auditorias)).toBe(1);
  expect(Number(corpoVerificacao.criada.codigos_na_auditoria)).toBe(0);

  page.once('dialog', dialogo => dialogo.accept());
  await linha.getByTitle('Bloquear').click();
  await expect(linha).toContainText('Bloqueado');
  verificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=banco_senhas`
  );
  corpoVerificacao = await verificacao.json();
  estado = corpoVerificacao.estado;
  expect(Number(estado.ativo)).toBe(0);
  expect(Number(estado.auditorias)).toBe(1);
});

test('relatório no navegador reconcilia a resposta real da API', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contexto = await respostaContexto.json();
  const token = await autenticarIntegrado(page, contexto.autenticacao.administrador);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/');
  await abrirModulo(page, 'Relatórios', 768);

  const relatorios = page.getByRole('main');
  const inicio = await relatorios.getByLabel('Data inicial').inputValue();
  const fim = await relatorios.getByLabel('Data final').inputValue();
  const resposta = await page.request.get(
    `${API}/api/relatorios/operacional?inicio=${inicio}&fim=${fim}&moeda=BRL`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  expect(resposta.ok()).toBe(true);
  const esperado = await resposta.json();
  await relatorios.getByRole('button', { name: 'Gerar' }).click();

  const metricas = relatorios.locator('.report-metrics');
  const valor = numero => new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL'
  }).format(Number(numero || 0));
  await expect(metricas.locator('article', { hasText: 'Total de pedidos' })
    .locator('strong')).toHaveText(String(Number(esperado.resumo.total_pedidos || 0)));
  await expect(metricas.locator('article', { hasText: 'Concluídos' })
    .locator('strong')).toHaveText(String(Number(esperado.resumo.concluidos || 0)));
  await expect(metricas.locator('article', { hasText: 'Valor de vendas' })
    .locator('strong')).toHaveText(valor(esperado.resumo.valor_vendas));
  await expect(metricas.locator('article', { hasText: 'Resultado bruto' })
    .locator('strong')).toHaveText(valor(esperado.resumo.resultado_bruto));
  await expect(metricas.locator('article', { hasText: 'Clientes atendidos' })
    .locator('strong')).toHaveText(String(Number(
      esperado.resumo.clientes_atendidos || 0
    )));
  if (esperado.por_status.length) {
    const primeiro = esperado.por_status[0];
    await expect(relatorios.locator('.report-card', { hasText: 'Por status' })
      .locator('tr', { hasText: primeiro.status }))
      .toContainText(String(primeiro.quantidade));
  }
  await esperarSemRolagemHorizontal(page);
});

test('integrações administram modelos e mapeamentos sem chamar serviços externos', async ({ page }) => {
  test.setTimeout(60000);
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.integracoes;
  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
  await page.setViewportSize({ width: 768, height: 1024 });

  await page.goto('/');
  await abrirModulo(page, 'Integrações', 768);
  await expect(page.getByRole('main').getByRole('heading', {
    name: 'Integrações', exact: true
  }))
    .toBeVisible();
  await expect(page.locator('.integration-grid article', { hasText: 'API Joel Pires' }))
    .toBeVisible();
  await expect(page.locator('.integration-grid article', { hasText: 'PlugPay' }))
    .toContainText('Contrato não identificado');
  const prontidaoFluxoGm = page.locator('.whatsapp-readiness', {
    hasText: 'PRONTIDÃO DO CENÁRIO GM'
  });
  await expect(prontidaoFluxoGm).toContainText('Cenário externo ainda bloqueado');
  await expect(prontidaoFluxoGm).toContainText('Gravação Joel Pires');
  const oauthBling = page.locator('.whatsapp-readiness', {
    hasText: 'BLING OAUTH 2.0 · JWT'
  });
  await expect(oauthBling).toContainText('Autorização Bling pendente');
  await expect(oauthBling).toContainText('Os tokens ficam cifrados no servidor');
  await oauthBling.getByRole('button', { name: 'Preparar conexão Bling' }).click();
  const linkBling = oauthBling.getByRole('link', { name: 'Abrir autorização Bling' });
  await expect(linkBling).toHaveAttribute('href', /bling-e2e\.invalid/);
  await expect(linkBling).toHaveAttribute('href', /state=/);
  await expect(linkBling).not.toHaveAttribute('href', /bling-secret-e2e/);
  await expect(page.getByLabel('ID do pedido Bling')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sincronizar pedido Bling' }))
    .toBeDisabled();
  await expect(page.getByText('PRONTIDÃO WHATSAPP GM')).toBeVisible();
  const prontidaoWhatsapp = page.locator('.whatsapp-readiness', {
    hasText: 'PRONTIDÃO WHATSAPP GM'
  });
  await expect(prontidaoWhatsapp).toContainText('Worker desabilitado');
  await expect(prontidaoWhatsapp).toContainText('Automação GM');
  await expect(prontidaoWhatsapp).not.toContainText(/\d{10,15}/);
  const prontidaoSicoob = page.locator('.whatsapp-readiness', {
    hasText: 'PRONTIDÃO SICOOB PIX'
  });
  await expect(prontidaoSicoob).toContainText('Teste externo bloqueado');
  await expect(prontidaoSicoob).toContainText('Webhook mTLS');
  await expect(prontidaoSicoob).not.toContainText(/client-secret|BEGIN PRIVATE KEY/i);
  const prontidaoComercio = page.locator('.whatsapp-readiness', {
    hasText: 'PRONTIDÃO DO COMÉRCIO ELETRÔNICO'
  });
  await expect(prontidaoComercio).toContainText('Conversão WBuy bloqueada');
  await expect(prontidaoComercio).toContainText('Regra de moeda WBuy ainda não definida');
  await expect(prontidaoComercio).toContainText(
    'Reconciliação de cliente, comprador e pagador não definida'
  );
  await page.getByLabel('Moeda de WBUY').selectOption('BRL');
  await page.getByLabel('cliente de WBUY').selectOption('CADASTRO_CENTRAL');
  await page.getByLabel('comprador de WBUY').selectOption('ORIGEM_EXTERNA');
  await page.getByLabel('pagador de WBUY').selectOption('MANUAL');
  page.once('dialog', dialogo => dialogo.accept());
  const linhaPoliticaWBuy = page.locator('tr').filter({
    has: page.getByLabel('Moeda de WBUY')
  });
  await linhaPoliticaWBuy.getByRole('button', { name: 'Salvar política' }).click();
  await expect(prontidaoComercio)
    .not.toContainText('Regra de moeda WBuy ainda não definida');
  await expect(prontidaoComercio)
    .not.toContainText('Reconciliação de cliente, comprador e pagador não definida');
  const autoridadePedido = page.getByLabel('Autoridade de PEDIDO');
  await expect(autoridadePedido).toHaveValue('');
  page.once('dialog', dialogo => dialogo.accept());
  await autoridadePedido.selectOption('WBUY');
  await expect(autoridadePedido).toHaveValue('WBUY');
  await expect(page.getByText('Definidos:', { exact: false })).toContainText('1/7');
  await page.getByLabel('ID do status externo').fill('2');
  await page.getByLabel('Nome do status externo').fill('Pagamento confirmado');
  await page.getByLabel('Situação interna').selectOption('CONFIRMADO');
  page.once('dialog', dialogo => dialogo.accept());
  await page.getByRole('button', { name: 'Mapear status' }).click();
  await expect(page.locator('tr', { hasText: 'Pagamento confirmado' }))
    .toContainText('CONFIRMADO');

  const linhaBling = page.locator('tr', {
    hasText: contexto.referencia_evento_bling
  });
  const linhaSicoob = page.locator('tr', {
    hasText: contexto.referencia_evento_sicoob
  });
  await expect(page.getByRole('heading', {
    name: 'Recebimentos e processamento'
  })).toBeVisible();
  await expect(linhaBling).toContainText('BLING');
  await expect(linhaBling).toContainText('ORDER.SNAPSHOT');
  await expect(linhaBling).toContainText('RECEBIDO');
  await expect(linhaBling).toContainText('2');
  await linhaBling.getByRole('button', { name: 'Analisar snapshot' }).click();
  const previaBling = page.locator('.integration-result', {
    hasText: 'PRÉVIA BLING · SOMENTE LEITURA'
  });
  await expect(previaBling).toContainText('0 de 1 produtos mapeados');
  await expect(previaBling).toContainText('Nenhum pedido ou pagamento foi criado');
  await expect(previaBling).toContainText('PRODUTO NAO MAPEADO');
  await expect(previaBling).not.toContainText('Cliente Bling secreto E2E');
  await previaBling.getByRole('button', { name: 'Fechar prévia BLING' }).click();
  await expect(linhaSicoob).toContainText('REFERENCIA_NAO_ENCONTRADA');

  let linhaPagamentoTardio = page.locator('tr', {
    hasText: contexto.referencia_pagamento_tardio
  });
  await expect(linhaPagamentoTardio)
    .toContainText('PAGAMENTO_APOS_CANCELAMENTO_REQUER_ESTORNO');
  await expect(linhaPagamentoTardio).toContainText('R$');
  const respostasDevolucao = [
    'SICOOB',
    `DEVOLUCAO-${contexto.referencia_pagamento_tardio}`,
    'Pagamento devolvido após cancelamento no teste integrado'
  ];
  const responderDialogoDevolucao = async dialogo => {
    if (dialogo.type() === 'prompt') {
      await dialogo.accept(respostasDevolucao.shift());
    } else {
      await dialogo.accept();
    }
  };
  page.on('dialog', responderDialogoDevolucao);
  await linhaPagamentoTardio.getByRole('button', {
    name: 'Registrar devolução'
  }).click();
  page.off('dialog', responderDialogoDevolucao);
  linhaPagamentoTardio = page.locator('tr', {
    hasText: contexto.referencia_pagamento_tardio
  });
  await expect(linhaPagamentoTardio).toContainText('IGNORADO');
  await expect(linhaPagamentoTardio).toContainText('PAGAMENTO_ESTORNADO');

  await page.getByLabel('ID do pedido WBuy').fill(contexto.pedido_wbuy_id);
  await page.getByRole('button', { name: 'Sincronizar pedido WBuy' }).click();
  await expect(page.getByRole('status')).toContainText('recebido na fila');
  await expect(page.getByRole('status')).toContainText('0 de 1 produtos mapeados');
  await expect(page.getByRole('status')).toContainText('aguarda regras comerciais');
  const linhaWBuy = page.locator('tr', { hasText: contexto.pedido_wbuy_id });
  await expect(linhaWBuy).toContainText('WBUY');
  await expect(linhaWBuy).toContainText('ORDER.SNAPSHOT');
  await expect(linhaWBuy).toContainText('RECEBIDO');
  await linhaWBuy.getByRole('button', { name: 'Analisar snapshot' }).click();
  const previaWBuy = page.locator('.integration-result', {
    hasText: 'PRÉVIA WBUY · SOMENTE LEITURA'
  });
  await expect(previaWBuy).toContainText('0 de 1 produtos mapeados');
  await expect(previaWBuy).toContainText('Nenhum pedido ou pagamento foi criado');
  await expect(previaWBuy).toContainText('PRODUTO NAO MAPEADO');
  await expect(previaWBuy).not.toContainText('Cliente WBuy fictício E2E');

  await page.getByLabel('Filtrar status de eventos').selectOption('FALHOU');
  await expect(linhaSicoob).toBeVisible();
  await expect(linhaBling).toHaveCount(0);
  await page.getByLabel('Filtrar status de eventos').selectOption('');
  await page.getByLabel('Filtrar provedor de eventos').selectOption('BLING');
  await expect(linhaBling).toBeVisible();
  await expect(linhaSicoob).toHaveCount(0);

  await page.getByLabel('Provedor do mapeamento').selectOption('WBUY');
  await page.getByPlaceholder('ID externo').fill(contexto.produto_externo_id);
  await page.getByPlaceholder('SKU').fill(contexto.sku);
  await page.getByPlaceholder('Nome do produto').fill(contexto.nome_externo);
  await page.getByLabel('Serviço MyKey').selectOption(String(contexto.servico_id));
  await page.getByRole('button', { name: 'Mapear', exact: true }).click();
  let linhaMapeamento = page.locator('tr', { hasText: contexto.produto_externo_id });
  await expect(linhaMapeamento).toContainText(contexto.servico_codigo);
  await expect(linhaMapeamento).toContainText('ATIVO');
  page.once('dialog', dialogo => dialogo.accept());
  await linhaMapeamento.getByRole('button', { name: 'Desativar' }).click();
  linhaMapeamento = page.locator('tr', { hasText: contexto.produto_externo_id });
  await expect(linhaMapeamento).toContainText('INATIVO');

  await page.getByLabel('Nome do modelo').fill(contexto.modelo_nome);
  await page.getByLabel('Idioma do modelo').selectOption('pt_BR');
  await page.getByLabel('Categoria do modelo').selectOption('UTILIDADE');
  await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
  let linhaModelo = page.locator('tr', { hasText: contexto.modelo_nome });
  await expect(linhaModelo).toContainText('PENDENTE');
  page.once('dialog', dialogo => dialogo.accept());
  await linhaModelo.getByLabel(`Status do modelo ${contexto.modelo_nome}`)
    .selectOption('APROVADO');
  linhaModelo = page.locator('tr', { hasText: contexto.modelo_nome });
  await expect(linhaModelo).toContainText('APROVADO');
  page.once('dialog', dialogo => dialogo.accept());
  await linhaModelo.getByRole('button', { name: 'Ativar', exact: true }).click();
  await expect(linhaModelo).toContainText('Sim');
  await esperarSemRolagemHorizontal(page);

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=integracoes`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(verificacao.mapeamento.provedor).toBe('WBUY');
  expect(Number(verificacao.mapeamento.ativo)).toBe(0);
  expect(Number(verificacao.mapeamento.auditorias)).toBe(2);
  expect(verificacao.modelo.status).toBe('APROVADO');
  expect(Number(verificacao.modelo.ativo)).toBe(1);
  expect(Number(verificacao.modelo.auditorias)).toBe(3);
  expect(verificacao.autoridade.dominio).toBe('PEDIDO');
  expect(verificacao.autoridade.autoridade).toBe('WBUY');
  expect(Number(verificacao.autoridade.auditorias)).toBeGreaterThanOrEqual(1);
  expect(verificacao.status_mapeado.status_externo_id).toBe('2');
  expect(verificacao.status_mapeado.situacao).toBe('CONFIRMADO');
  expect(Number(verificacao.status_mapeado.auditorias)).toBeGreaterThanOrEqual(1);
  expect(Number(verificacao.oauth_bling.estados)).toBe(1);
  expect(Number(verificacao.oauth_bling.auditorias)).toBe(1);
  expect(verificacao.pagamento_tardio.pedido_status).toBe('CANCELADO');
  expect(verificacao.pagamento_tardio.evento_status).toBe('IGNORADO');
  expect(verificacao.pagamento_tardio.erro_codigo).toBe('PAGAMENTO_ESTORNADO');
  expect(Number(verificacao.pagamento_tardio.estornos)).toBe(1);
  expect(Number(verificacao.pagamento_tardio.devolucoes)).toBe(1);
});

test('administrador cria usuário e define permissões pelas rotas reais', async ({ page }) => {
  test.setTimeout(60000);
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.administracao;
  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page.getByRole('button', { name: 'Usuários', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: 'Usuários' }))
    .toBeVisible();
  await page.getByRole('button', { name: 'Novo usuário' }).click();

  const formulario = page.getByRole('dialog', { name: 'Novo usuário' });
  await formulario.getByLabel('Nome').fill(contexto.nome_novo_usuario);
  await formulario.getByLabel('Login').fill(contexto.login_novo_usuario);
  await formulario.getByLabel('Perfil').selectOption(String(contexto.perfil_id));
  await formulario.getByLabel('E-mail')
    .fill(`${contexto.login_novo_usuario}@teste.invalid`);
  await formulario.getByLabel('Telefone').fill('5500000000000');
  await formulario.getByLabel('Senha provisória').fill('Senha-Provisoria-E2E-9');
  const caixaFormulario = await formulario.boundingBox();
  expect(caixaFormulario.width).toBeLessThanOrEqual(390);
  await expect(formulario.getByRole('button', { name: 'Salvar usuário' }))
    .toBeVisible();
  await formulario.getByRole('button', { name: 'Salvar usuário' }).click();
  await expect(formulario).toBeHidden({ timeout: 15000 });

  const linha = page.locator('tr', { hasText: contexto.login_novo_usuario });
  await expect(linha).toContainText(contexto.nome_novo_usuario);
  await linha.getByTitle('Permissões').click();
  const permissoes = page.getByRole('dialog', {
    name: new RegExp(`Permissões de ${contexto.nome_novo_usuario}`)
  });
  await permissoes.getByRole('checkbox', { name: 'visualizar Usuários' }).check();
  await expect(permissoes.getByRole('button', { name: 'Salvar permissões' }))
    .toBeVisible();
  page.once('dialog', dialogo => dialogo.dismiss());
  await permissoes.getByRole('button', { name: 'Salvar permissões' }).click();
  await expect(permissoes).toBeVisible();
  page.once('dialog', dialogo => dialogo.accept());
  await permissoes.getByRole('button', { name: 'Salvar permissões' }).click();
  await expect(permissoes).toBeHidden({ timeout: 10000 });

  page.once('dialog', dialogo => dialogo.accept());
  await linha.getByTitle('Alterar status').click();
  await expect(linha).toContainText('BLOQUEADO');

  const dimensoes = await page.evaluate(() => ({
    largura: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  }));
  expect(dimensoes.largura).toBeLessThanOrEqual(dimensoes.viewport);

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=administracao`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('BLOQUEADO');
  expect(Number(verificacao.estado.senha_provisoria)).toBe(1);
  expect(Number(verificacao.estado.permissoes_visualizar)).toBe(1);
  expect(Number(verificacao.estado.auditorias)).toBe(3);
});

test('atendimento é assumido, respondido, transferido e finalizado na transação', async ({ page }) => {
  test.setTimeout(60000);
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.atendimento;
  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page.getByRole('button', { name: 'Atendimento', exact: true }).click();
  const busca = page.getByPlaceholder('Cliente, telefone ou protocolo');
  await busca.fill(contexto.protocolo);
  const item = page.locator('.attendance-item', { hasText: contexto.cliente });
  await expect(item).toBeVisible();
  await item.click();

  const conversa = page.locator('.conversation-panel');
  await expect(conversa.getByText(contexto.protocolo, { exact: true })).toBeVisible();
  const fluxoGm = conversa.getByLabel('Fluxo automático GM');
  await expect(fluxoGm).toBeVisible();
  await expect(fluxoGm.getByText(contexto.pedido_automacao_protocolo, { exact: true }))
    .toBeVisible();
  await expect(fluxoGm.getByText('Pix: REGISTRADA', { exact: true })).toBeVisible();
  await expect(fluxoGm.locator('strong', { hasText: 'AGUARDANDO_PAGAMENTO' }))
    .toBeVisible();
  await expect(conversa.locator('.conversation-meta .attendance-status'))
    .toHaveText('Na fila');
  await conversa.getByRole('button', { name: 'Assumir atendimento' }).click();
  await expect(conversa.locator('.conversation-meta .attendance-status'))
    .toHaveText('Em atendimento');

  await conversa.getByRole('button', { name: 'Nota interna' }).click();
  await conversa.getByPlaceholder(
    'Escreva uma observação visível apenas para a equipe'
  ).fill(contexto.nota);
  await conversa.getByTitle('Enviar').click();
  await expect(conversa.getByText(contexto.nota, { exact: true })).toBeVisible();

  await conversa.getByRole('button', { name: 'Responder cliente' }).click();
  await conversa.getByPlaceholder('Digite uma mensagem para o cliente')
    .fill(contexto.resposta);
  await conversa.getByTitle('Enviar').click();
  await expect(conversa.getByText(contexto.resposta, { exact: true })).toBeVisible();

  await conversa.getByLabel('Alterar etapa').selectOption('PRONTO_ENVIO');
  await expect(conversa.locator('.conversation-meta .attendance-status'))
    .toHaveText('Pronto para envio');
  await conversa.getByRole('button', { name: 'Transferir' }).click();
  const transferencia = page.getByRole('dialog', { name: 'Transferir atendimento' });
  await transferencia.getByLabel('Novo responsável')
    .selectOption(String(contexto.atendente_id));
  await transferencia.getByLabel('Motivo da transferência')
    .fill('Continuidade E2E em outro atendente');
  const caixaTransferencia = await transferencia.boundingBox();
  expect(caixaTransferencia.width).toBeLessThanOrEqual(390);
  await transferencia.getByRole('button', { name: 'Confirmar transferência' })
    .click();
  await expect(transferencia).toBeHidden({ timeout: 10000 });
  await expect(conversa.getByText(contexto.atendente, { exact: true })).toBeVisible();

  const paginaAtendente = await page.context().newPage();
  await autenticarIntegrado(
    paginaAtendente,
    contextoCompleto.autenticacao.atendente
  );
  await paginaAtendente.setViewportSize({ width: 390, height: 844 });
  await paginaAtendente.goto('/');
  const buscaAtendente = paginaAtendente.getByPlaceholder(
    'Cliente, telefone ou protocolo'
  );
  await buscaAtendente.fill(contexto.protocolo);
  const itemAtendente = paginaAtendente.locator('.attendance-item', {
    hasText: contexto.cliente
  });
  await expect(itemAtendente).toBeVisible();
  await itemAtendente.click();
  const conversaAtendente = paginaAtendente.locator('.conversation-panel');
  await expect(conversaAtendente.getByText(contexto.atendente, { exact: true }))
    .toBeVisible();
  paginaAtendente.once('dialog', dialogo => dialogo.accept());
  await conversaAtendente.getByLabel('Alterar etapa').selectOption('FINALIZADO');
  await expect(conversaAtendente.locator('.conversation-meta .attendance-status'))
    .toHaveText('Finalizado');
  await expect(conversaAtendente.getByTitle('Enviar')).toHaveCount(0);
  const dimensoes = await paginaAtendente.evaluate(() => ({
    largura: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  }));
  expect(dimensoes.largura).toBeLessThanOrEqual(dimensoes.viewport);
  await paginaAtendente.close();

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=atendimento`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(verificacao.estado.status).toBe('FINALIZADO');
  expect(verificacao.estado.modo).toBe('HUMANO');
  expect(Number(verificacao.estado.responsavel_id)).toBe(contexto.atendente_id);
  expect(Number(verificacao.estado.finalizado)).toBe(1);
  expect(Number(verificacao.estado.transferencias)).toBe(2);
  expect(Number(verificacao.estado.notas)).toBe(1);
  expect(Number(verificacao.estado.mensagens_whatsapp)).toBe(1);
  expect(Number(verificacao.estado.auditorias)).toBe(7);
  expect(Number(verificacao.chamadas_whatsapp)).toBe(1);
});

test('configuração é confirmada, auditada e monitorada sem expor valor', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.configuracao;
  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
  await page.setViewportSize({ width: 768, height: 1024 });

  await page.goto('/');
  const abrirMenu = page.getByRole('button', { name: 'Abrir menu' });
  if (await abrirMenu.isVisible()) await abrirMenu.click();
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.getByPlaceholder('Buscar configuração').fill(contexto.chave);
  const cartao = page.locator('.config-grid article', { hasText: contexto.chave });
  await expect(cartao).toContainText(contexto.valor_inicial);
  await cartao.getByRole('button', { name: 'Editar' }).click();

  const modal = page.getByRole('dialog', { name: contexto.chave });
  await modal.getByLabel('Valor').fill(contexto.valor_final);
  const caixaModal = await modal.boundingBox();
  expect(caixaModal.width).toBeLessThanOrEqual(768);
  page.once('dialog', dialogo => dialogo.accept());
  await modal.getByRole('button', { name: 'Salvar' }).click();
  await expect(modal).toBeHidden({ timeout: 10000 });
  await expect(cartao).toContainText(contexto.valor_final);

  if (await abrirMenu.isVisible()) await abrirMenu.click();
  await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
  await page.getByPlaceholder('Descrição, ação, entidade ou usuário')
    .fill(contexto.chave);
  await page.getByRole('button', { name: 'Filtrar' }).click();
  const linhaAuditoria = page.locator('tr', { hasText: contexto.chave });
  await expect(linhaAuditoria).toContainText('ALTERAR_CONFIGURACAO');
  await expect(linhaAuditoria).not.toContainText(contexto.valor_final);

  if (await abrirMenu.isVisible()) await abrirMenu.click();
  await page.getByRole('button', { name: 'Monitoramento', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', {
    name: 'Monitoramento'
  })).toBeVisible();
  await expect(page.getByText('Comunicações atrasadas', { exact: true }))
    .toBeVisible();
  await expect(page.getByText('Eventos externos pendentes', { exact: true }))
    .toBeVisible();
  await expect(page.getByText('Estado do backup', { exact: true })).toBeVisible();
  await expect(page.locator('.monitor-card', { hasText: 'Backup' }))
    .toContainText('Verificada');
  await expect(page.locator('.monitor-card', { hasText: 'Backup' }))
    .toContainText('Cópia externa');
  const dimensoes = await page.evaluate(() => ({
    largura: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  }));
  expect(dimensoes.largura).toBeLessThanOrEqual(dimensoes.viewport);

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=configuracao`
  );
  expect(respostaVerificacao.ok()).toBe(true);
  const verificacao = await respostaVerificacao.json();
  expect(Number(verificacao.estado.valor_atualizado)).toBe(1);
  expect(Number(verificacao.estado.auditorias)).toBe(1);
  expect(Number(verificacao.estado.valores_na_auditoria)).toBe(0);
});

test('visualizador não vê ações de usuário e recebe 403 ao forçar criação', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.administracao;
  const token = await autenticarIntegrado(
    page,
    contextoCompleto.autenticacao.visualizador
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Usuários', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: 'Usuários' }))
    .toBeVisible();
  await expect(page.getByRole('button', { name: 'Novo usuário' })).toBeHidden();
  await expect(page.getByTitle('Editar')).toHaveCount(0);
  await expect(page.getByTitle('Permissões')).toHaveCount(0);
  await expect(page.getByTitle('Alterar status')).toHaveCount(0);

  const negada = await page.request.post(`${API}/api/usuarios`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      nome: 'USUÁRIO NEGADO E2E',
      login: `${contexto.login_novo_usuario}-negado`,
      senha: 'Senha-Negada-E2E-9',
      perfil_id: contexto.perfil_id
    }
  });
  expect(negada.status()).toBe(403);

  const respostaVerificacao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=administracao`
  );
  const verificacao = await respostaVerificacao.json();
  expect(Number(verificacao.estado.criacoes_negadas)).toBe(0);

  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  const configuracao = contextoCompleto.configuracao;
  await page.getByPlaceholder('Buscar configuração').fill(configuracao.chave);
  const cartao = page.locator('.config-grid article', {
    hasText: configuracao.chave
  });
  await expect(cartao).toBeVisible();
  await expect(cartao.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  const verificacaoConfiguracaoAntes = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=configuracao`
  );
  const estadoConfiguracaoAntes = await verificacaoConfiguracaoAntes.json();
  const alteracaoNegada = await page.request.put(
    `${API}/api/configuracoes/${configuracao.chave}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { valor: 'ALTERACAO-NEGADA-E2E' }
    }
  );
  expect(alteracaoNegada.status()).toBe(403);
  const verificacaoConfiguracao = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=configuracao`
  );
  const estadoConfiguracao = await verificacaoConfiguracao.json();
  expect(Number(estadoConfiguracao.estado.valor_atualizado)).toBe(
    Number(estadoConfiguracaoAntes.estado.valor_atualizado)
  );
  expect(Number(estadoConfiguracao.estado.auditorias)).toBe(
    Number(estadoConfiguracaoAntes.estado.auditorias)
  );

  await page.getByRole('button', { name: 'Integrações', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Laboratório OpenAI' }))
    .toHaveCount(0);
  await expect(page.getByPlaceholder('ID externo')).toHaveCount(0);
  await expect(page.getByLabel('ID do pedido WBuy')).toHaveCount(0);
  await expect(page.getByLabel('ID do pedido Bling')).toHaveCount(0);
  await expect(page.getByLabel('Nome do modelo')).toHaveCount(0);
  await expect(page.getByLabel(/Status do modelo/)).toHaveCount(0);
  await expect(page.getByLabel(/Autoridade de/)).toHaveCount(0);
  await expect(page.getByLabel(/Moeda de/)).toHaveCount(0);
  await expect(page.getByLabel('ID do status externo')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preparar conexão Bling' }))
    .toHaveCount(0);
  const oauthBlingNegado = await page.request.post(
    `${API}/api/integracoes/bling/oauth/iniciar`, {
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  expect(oauthBlingNegado.status()).toBe(403);
  const sincronizacaoBlingNegada = await page.request.post(
    `${API}/api/integracoes/bling/pedidos/123/sincronizar`, {
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  expect(sincronizacaoBlingNegada.status()).toBe(403);
  const politicaNegada = await page.request.put(
    `${API}/api/integracoes/politicas-comercio/WBUY`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { moeda: 'BRL', identidades: { cliente: 'CADASTRO_CENTRAL',
        comprador: 'ORIGEM_EXTERNA', pagador: 'MANUAL' } }
    }
  );
  expect(politicaNegada.status()).toBe(403);
  await expect(page.getByRole('button', { name: 'Ativar', exact: true }))
    .toHaveCount(0);
  const integracoes = contextoCompleto.integracoes;
  const verificacaoIntegracoesAntes = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=integracoes`
  );
  const estadoIntegracoesAntes = await verificacaoIntegracoesAntes.json();
  const mapeamentoNegado = await page.request.post(
    `${API}/api/integracoes/mapeamentos-produtos`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        provedor: 'BLING',
        produto_externo_id: `${integracoes.produto_externo_id}-negado`,
        sku: `${integracoes.sku}-NEGADO`,
        servico_id: integracoes.servico_id
      }
    }
  );
  expect(mapeamentoNegado.status()).toBe(403);
  const sincronizacaoNegada = await page.request.post(
    `${API}/api/integracoes/wbuy/pedidos/${integracoes.pedido_wbuy_id}/sincronizar`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  expect(sincronizacaoNegada.status()).toBe(403);
  const modeloNegado = await page.request.post(`${API}/api/whatsapp/modelos`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      nome: `${integracoes.modelo_nome}_negado`,
      idioma: 'pt_BR',
      categoria: 'UTILIDADE'
    }
  });
  expect(modeloNegado.status()).toBe(403);
  const verificacaoIntegracoes = await page.request.get(
    `${API}/api/e2e/verificacao?cenario=integracoes`
  );
  const estadoIntegracoes = await verificacaoIntegracoes.json();
  expect(estadoIntegracoes.mapeamento).toEqual(estadoIntegracoesAntes.mapeamento);
  expect(estadoIntegracoes.modelo).toEqual(estadoIntegracoesAntes.modelo);

  await page.getByRole('button', { name: 'Clientes', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: 'Clientes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Novo cliente' })).toHaveCount(0);
  await expect(page.getByTitle('Editar')).toHaveCount(0);

  await page.getByRole('button', { name: 'Fornecedores', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: 'Fornecedores' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Novo fornecedor' })).toHaveCount(0);
  await expect(page.getByTitle('Editar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Catálogo de serviços' }).click();
  const catalogoSomenteLeitura = page.getByRole('dialog', { name: 'Catálogo de serviços' });
  await expect(catalogoSomenteLeitura.getByRole('button', { name: 'Cadastrar serviço' }))
    .toHaveCount(0);
  await expect(catalogoSomenteLeitura.getByTitle('Editar serviço')).toHaveCount(0);
  await catalogoSomenteLeitura.getByRole('button', { name: 'Fechar' }).click();
  const servicos = page.getByTitle('Serviços e custos').first();
  await expect(servicos).toBeVisible();
  await servicos.click();
  const dialogoServicos = page.getByRole('dialog');
  await expect(dialogoServicos.getByRole('button', { name: 'Adicionar regra' }))
    .toHaveCount(0);
  await expect(dialogoServicos.getByTitle('Editar regra')).toHaveCount(0);
  await dialogoServicos.getByRole('button', { name: 'Fechar' }).click();

  await page.getByRole('button', { name: 'Financeiro', exact: true }).click();
  const faturaSomenteLeitura = page.locator('tr', {
    hasText: `#${contextoCompleto.fatura_semanal.id}`
  });
  await expect(faturaSomenteLeitura).toBeVisible();
  await expect(faturaSomenteLeitura.getByRole('button', {
    name: 'Fechar', exact: true
  })).toHaveCount(0);
  await expect(faturaSomenteLeitura.getByRole('button', {
    name: 'Registrar pagamento'
  })).toHaveCount(0);
  await page.locator('.finance-tabs').getByRole('button', {
    name: 'Fornecedores', exact: true
  }).click();
  await expect(page.getByRole('button', { name: 'Gerar última semana' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Registrar pagamento' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Pedidos e senhas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Novo pedido' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Banco de senhas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Nova senha' })).toHaveCount(0);
  await expect(page.getByTitle('Editar')).toHaveCount(0);

  const mutacoesNegadas = await Promise.all([
    page.request.post(`${API}/api/clientes`, {
      headers: { Authorization: `Bearer ${token}` }, data: {}
    }),
    page.request.post(`${API}/api/fornecedores`, {
      headers: { Authorization: `Bearer ${token}` }, data: {}
    }),
    page.request.post(`${API}/api/catalogo-servicos`, {
      headers: { Authorization: `Bearer ${token}` }, data: {}
    }),
    page.request.post(`${API}/api/fornecedores/1/fechamentos/gerar`, {
      headers: { Authorization: `Bearer ${token}` }, data: {}
    }),
    page.request.post(
      `${API}/api/faturas/${contextoCompleto.fatura_semanal.id}/fechar`,
      { headers: { Authorization: `Bearer ${token}` }, data: {} }
    ),
    page.request.post(
      `${API}/api/faturas/${contextoCompleto.fatura_semanal.id}/pagamento/confirmar-manual`,
      { headers: { Authorization: `Bearer ${token}` }, data: {} }
    ),
    page.request.post(`${API}/api/pedidos`, {
      headers: { Authorization: `Bearer ${token}` }, data: {}
    }),
    page.request.post(`${API}/api/banco-senhas`, {
      headers: { Authorization: `Bearer ${token}` }, data: {}
    }),
    page.request.patch(
      `${API}/api/banco-senhas/${contextoCompleto.banco_senhas.id}/status`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { ativo: 1 }
      }
    )
  ]);
  expect(mutacoesNegadas.map(resposta => resposta.status()))
    .toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403]);
});

test('navegador estorna pagamento real e cancela na transação', async ({ page }) => {
  const respostaContexto = await page.request.get(`${API}/api/e2e/contexto`);
  expect(respostaContexto.ok()).toBe(true);
  const contextoCompleto = await respostaContexto.json();
  const contexto = contextoCompleto.estorno;

  await autenticarIntegrado(page, contextoCompleto.autenticacao.administrador);
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
