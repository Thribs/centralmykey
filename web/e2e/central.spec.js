import { expect, test } from '@playwright/test';

const API = 'https://api-e2e.invalid';
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
    { codigo: 'PEDIDOS_SENHAS', modulo: 'Pedidos e senhas', visualizar: 1 }
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
