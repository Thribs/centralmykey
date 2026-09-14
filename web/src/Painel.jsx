import { useMemo, useState } from 'react';
import Atendimento from './Atendimento';
import Pedidos from './Pedidos';
import BancoSenhas from './BancoSenhas';
import { Clientes, Fornecedores } from './Cadastros';
import Financeiro from './Financeiro';
import Relatorios from './Relatorios';
import { Usuarios, Integracoes, Configuracoes } from './Administracao';
import OpenAILab from './OpenAILab';
import {
  Bell,
  BookKey,
  ChevronRight,
  CircleDollarSign,
  FileChartColumn,
  Headphones,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircleMore,
  Plug,
  Search,
  Settings,
  ShieldCheck,
  Truck,
  UserRound,
  UsersRound,
  X
} from 'lucide-react';

const MODULOS = [
  {
    codigo: 'DASHBOARD',
    nome: 'Dashboard',
    icone: LayoutDashboard
  },
  {
    codigo: 'ATENDIMENTO',
    nome: 'Atendimento',
    icone: Headphones
  },
  {
    codigo: 'PEDIDOS_SENHAS',
    nome: 'Pedidos e senhas',
    icone: MessageCircleMore
  },
  {
    codigo: 'BANCO_SENHAS',
    nome: 'Banco de senhas',
    icone: BookKey
  },
  {
    codigo: 'CLIENTES',
    nome: 'Clientes',
    icone: UsersRound
  },
  {
    codigo: 'FORNECEDORES',
    nome: 'Fornecedores',
    icone: Truck
  },
  {
    codigo: 'FINANCEIRO',
    nome: 'Financeiro',
    icone: CircleDollarSign
  },
  {
    codigo: 'RELATORIOS',
    nome: 'Relatórios',
    icone: FileChartColumn
  },
  {
    codigo: 'USUARIOS',
    nome: 'Usuários',
    icone: UserRound
  },
  {
    codigo: 'INTEGRACOES',
    nome: 'Integrações',
    icone: Plug
  },
  {
    codigo: 'CONFIGURACOES',
    nome: 'Configurações',
    icone: Settings
  }
];

function iniciais(nome = '') {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(parte => parte[0])
    .join('')
    .toUpperCase() || 'MK';
}

function Dashboard({ usuario, modulos }) {
  const atalhos = modulos
    .filter(item => item.codigo !== 'DASHBOARD')
    .slice(0, 6);

  return (
    <div className="dashboard-content">
      <section className="welcome-banner">
        <div>
          <span className="eyebrow">Central MyKey</span>
          <h2>Olá, {usuario.nome?.split(' ')[0] || 'usuário'}!</h2>
          <p>
            Acompanhe a operação e acesse rapidamente os módulos
            disponíveis para o seu perfil.
          </p>
        </div>

        <div className="welcome-status">
          <ShieldCheck size={24} />
          <div>
            <strong>Sessão protegida</strong>
            <span>Perfil: {usuario.perfil}</span>
          </div>
        </div>
      </section>

      <section>
        <div className="section-title">
          <div>
            <span>ACESSO RÁPIDO</span>
            <h3>Módulos disponíveis</h3>
          </div>
          <p>{atalhos.length} acessos liberados para seu perfil</p>
        </div>

        <div className="module-grid">
          {atalhos.map(item => {
            const Icone = item.icone;

            return (
              <button
                type="button"
                className="module-card"
                key={item.codigo}
                onClick={item.aoSelecionar}
              >
                <span className="module-icon">
                  <Icone size={23} />
                </span>
                <span className="module-copy">
                  <strong>{item.nome}</strong>
                  <small>Acessar módulo</small>
                </span>
                <ChevronRight size={19} />
              </button>
            );
          })}
        </div>
      </section>

      <section className="operation-card">
        <div className="operation-icon">
          <MessageCircleMore size={25} />
        </div>
        <div>
          <span>INTEGRAÇÃO WHATSAPP</span>
          <h3>Backend preparado e validado</h3>
          <p>
            O recebimento, envio, anexos e status de entrega estão
            prontos para receber as credenciais oficiais da Meta.
          </p>
        </div>
        <div className="status-pill">
          <span />
          Aguardando Meta
        </div>
      </section>
    </div>
  );
}

export default function Painel({
  usuario,
  permissoes,
  aoSair
}) {
  const [moduloAtivo, setModuloAtivo] = useState('DASHBOARD');
  const [menuAberto, setMenuAberto] = useState(false);

  const modulosPermitidos = useMemo(() => {
    const permitidos = new Set(
      permissoes
        .filter(permissao => Number(permissao.visualizar) === 1)
        .map(permissao => permissao.codigo)
    );

    return MODULOS
      .filter(item => permitidos.has(item.codigo))
      .map(item => ({
        ...item,
        aoSelecionar: () => {
          setModuloAtivo(item.codigo);
          setMenuAberto(false);
        }
      }));
  }, [permissoes]);

  const atual =
    modulosPermitidos.find(item => item.codigo === moduloAtivo) ||
    modulosPermitidos[0];

  const IconeAtual = atual?.icone || LayoutDashboard;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuAberto ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <div className="sidebar-logo">
            <img src="/logo-mykey.jpeg" alt="MyKey Soluções" />
          </div>
          <button
            type="button"
            className="close-menu"
            onClick={() => setMenuAberto(false)}
            aria-label="Fechar menu"
          >
            <X size={21} />
          </button>
        </div>

        <nav className="sidebar-nav">
          <span className="nav-label">MENU PRINCIPAL</span>

          {modulosPermitidos.map(item => {
            const Icone = item.icone;
            const ativo = atual?.codigo === item.codigo;

            return (
              <button
                type="button"
                key={item.codigo}
                className={`nav-item ${ativo ? 'nav-item-active' : ''}`}
                onClick={item.aoSelecionar}
              >
                <Icone size={20} />
                <span>{item.nome}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-user">
          <div className="user-avatar">{iniciais(usuario.nome)}</div>
          <div>
            <strong>{usuario.nome}</strong>
            <span>{usuario.perfil}</span>
          </div>
          <button type="button" onClick={aoSair} title="Sair">
            <LogOut size={18} />
          </button>
        </div>
      </aside>

      {menuAberto && (
        <button
          type="button"
          className="sidebar-overlay"
          onClick={() => setMenuAberto(false)}
          aria-label="Fechar menu"
        />
      )}

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            <button
              type="button"
              className="open-menu"
              onClick={() => setMenuAberto(true)}
              aria-label="Abrir menu"
            >
              <Menu size={22} />
            </button>
            <span className="topbar-icon">
              <IconeAtual size={20} />
            </span>
            <div>
              <h1>{atual?.nome || 'Central MyKey'}</h1>
              <p>Central de operação MyKey</p>
            </div>
          </div>

          <div className="topbar-actions">
            <label className="global-search">
              <Search size={18} />
              <input
                type="search"
                placeholder="Buscar na Central"
              />
            </label>

            <button
              type="button"
              className="icon-button"
              aria-label="Notificações"
            >
              <Bell size={20} />
              <span />
            </button>

            <div className="topbar-profile">
              <div className="user-avatar">
                {iniciais(usuario.nome)}
              </div>
              <div>
                <strong>{usuario.nome}</strong>
                <span>{usuario.perfil}</span>
              </div>
            </div>
          </div>
        </header>

        <main className="page-content">
          {atual?.codigo === 'DASHBOARD' ? (
            <Dashboard
              usuario={usuario}
              modulos={modulosPermitidos}
            />
          ) : atual?.codigo === 'ATENDIMENTO' ? (
            <Atendimento
              usuario={usuario}
              permissoes={permissoes}
            />
          ) : atual?.codigo === 'PEDIDOS_SENHAS' ? (
            <Pedidos />
          ) : atual?.codigo === 'BANCO_SENHAS' ? (
            <BancoSenhas
              usuario={usuario}
              permissoes={permissoes}
            />
          ) : atual?.codigo === 'CLIENTES' ? (
            <Clientes />
          ) : atual?.codigo === 'FORNECEDORES' ? (
            <Fornecedores />
          ) : atual?.codigo === 'FINANCEIRO' ? (
            <Financeiro />
          ) : atual?.codigo === 'RELATORIOS' ? (
            <Relatorios />
          ) : atual?.codigo === 'USUARIOS' ? (
            <Usuarios />
          ) : atual?.codigo === 'INTEGRACOES' ? (
            <>
              <Integracoes />
              <OpenAILab />
            </>
          ) : atual?.codigo === 'CONFIGURACOES' ? (
            <Configuracoes />
          ) : (
            <section className="module-placeholder">
              <div className="placeholder-icon">
                <IconeAtual size={30} />
              </div>
              <span>MÓDULO MYKEY</span>
              <h2>{atual?.nome}</h2>
              <p>
                A estrutura visual deste módulo será construída na
                próxima etapa e conectada à API já existente.
              </p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
