import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  UserRound
} from 'lucide-react';
import { buscarSessao, fazerLogin, trocarSenha } from './api';
import Painel from './Painel';
import './App.css';

function Login({ aoEntrar }) {
  const [login, setLogin] = useState('');
  const [senha, setSenha] = useState('');
  const [mostrarSenha, setMostrarSenha] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');

  async function enviar(evento) {
    evento.preventDefault();
    setErro('');
    setCarregando(true);

    try {
      const loginRealizado = await fazerLogin(login.trim(), senha);
      const token = loginRealizado.token;
      const sessao = await buscarSessao(token);

      const trocaObrigatoria = Boolean(
        loginRealizado.usuario?.troca_senha_obrigatoria
      );

      localStorage.setItem('central_mykey_token', token);
      localStorage.setItem(
        'central_mykey_troca_senha',
        trocaObrigatoria ? '1' : '0'
      );
      aoEntrar(sessao, trocaObrigatoria);
    } catch (error) {
      setErro(error.message);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-card">
          <div className="logo-window">
            <img
              src="/logo-mykey.jpeg"
              alt="MyKey Soluções"
              className="logo-image"
            />
          </div>

          <div className="login-heading">
            <span>Central MyKey</span>
            <h2>Bem-vindo de volta</h2>
            <p>Entre com seu usuário para acessar o sistema.</p>
          </div>

          <form onSubmit={enviar} className="login-form">
            <label>
              <span>Usuário</span>
              <div className="input-wrap">
                <UserRound size={19} />
                <input
                  type="text"
                  value={login}
                  onChange={evento => setLogin(evento.target.value)}
                  placeholder="Digite seu usuário"
                  autoComplete="username"
                  autoFocus
                  required
                />
              </div>
            </label>

            <label>
              <span>Senha</span>
              <div className="input-wrap">
                <LockKeyhole size={19} />
                <input
                  type={mostrarSenha ? 'text' : 'password'}
                  value={senha}
                  onChange={evento => setSenha(evento.target.value)}
                  placeholder="Digite sua senha"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="show-password"
                  onClick={() => setMostrarSenha(valor => !valor)}
                  aria-label={
                    mostrarSenha ? 'Ocultar senha' : 'Mostrar senha'
                  }
                >
                  {mostrarSenha
                    ? <EyeOff size={19} />
                    : <Eye size={19} />}
                </button>
              </div>
            </label>

            {erro && (
              <div className="login-error" role="alert">
                {erro}
              </div>
            )}

            <button
              type="submit"
              className="login-button"
              disabled={carregando}
            >
              <span>
                {carregando ? 'Entrando...' : 'Entrar na Central'}
              </span>
              {!carregando && <ArrowRight size={20} />}
            </button>
          </form>

          <p className="login-footer">
            Acesso exclusivo para usuários autorizados da MyKey.
          </p>
        </div>
      </section>
    </main>
  );
}

function TrocaSenha({ usuario, aoConcluir, aoSair }) {
  const [senhaAtual, setSenhaAtual] = useState('');
  const [novaSenha, setNovaSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [mostrarSenhas, setMostrarSenhas] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');

  async function enviar(evento) {
    evento.preventDefault();
    setErro('');

    if (novaSenha.length < 8) {
      setErro('A nova senha deve possuir pelo menos 8 caracteres.');
      return;
    }

    if (novaSenha !== confirmacao) {
      setErro('A confirmação não corresponde à nova senha.');
      return;
    }

    if (senhaAtual === novaSenha) {
      setErro('A nova senha deve ser diferente da senha atual.');
      return;
    }

    setCarregando(true);

    try {
      const tokenAtual = localStorage.getItem('central_mykey_token');
      const resultado = await trocarSenha(tokenAtual, senhaAtual, novaSenha);
      const novoToken = resultado.token || tokenAtual;

      localStorage.setItem('central_mykey_token', novoToken);
      localStorage.setItem('central_mykey_troca_senha', '0');

      const sessaoAtualizada = await buscarSessao(novoToken);
      aoConcluir(sessaoAtualizada);
    } catch (error) {
      setErro(error.message);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-card password-card">
          <div className="logo-window">
            <img
              src="/logo-mykey.jpeg"
              alt="MyKey Soluções"
              className="logo-image"
            />
          </div>

          <div className="login-heading">
            <span>Primeiro acesso</span>
            <h2>Crie sua nova senha</h2>
            <p>
              Olá, {usuario?.nome?.split(' ')[0] || 'usuário'}.
              Por segurança, substitua sua senha provisória.
            </p>
          </div>

          <form onSubmit={enviar} className="login-form">
            <label>
              <span>Senha atual</span>
              <div className="input-wrap">
                <LockKeyhole size={19} />
                <input
                  type={mostrarSenhas ? 'text' : 'password'}
                  value={senhaAtual}
                  onChange={evento => setSenhaAtual(evento.target.value)}
                  placeholder="Digite a senha provisória"
                  autoComplete="current-password"
                  autoFocus
                  required
                />
              </div>
            </label>

            <label>
              <span>Nova senha</span>
              <div className="input-wrap">
                <LockKeyhole size={19} />
                <input
                  type={mostrarSenhas ? 'text' : 'password'}
                  value={novaSenha}
                  onChange={evento => setNovaSenha(evento.target.value)}
                  placeholder="Mínimo de 8 caracteres"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
            </label>

            <label>
              <span>Confirmar nova senha</span>
              <div className="input-wrap">
                <LockKeyhole size={19} />
                <input
                  type={mostrarSenhas ? 'text' : 'password'}
                  value={confirmacao}
                  onChange={evento => setConfirmacao(evento.target.value)}
                  placeholder="Digite novamente"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
                <button
                  type="button"
                  className="show-password"
                  onClick={() => setMostrarSenhas(valor => !valor)}
                  aria-label={mostrarSenhas ? 'Ocultar senhas' : 'Mostrar senhas'}
                >
                  {mostrarSenhas
                    ? <EyeOff size={19} />
                    : <Eye size={19} />}
                </button>
              </div>
            </label>

            {erro && (
              <div className="login-error" role="alert">
                {erro}
              </div>
            )}

            <button
              type="submit"
              className="login-button"
              disabled={carregando}
            >
              <span>
                {carregando ? 'Alterando senha...' : 'Salvar nova senha'}
              </span>
              {!carregando && <ArrowRight size={20} />}
            </button>

            <button
              type="button"
              className="password-exit"
              onClick={aoSair}
              disabled={carregando}
            >
              Sair e voltar ao login
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}

function Carregando() {
  return (
    <main className="loading-page">
      <img src="/logo-mykey.jpeg" alt="MyKey Soluções" />
      <span>Carregando a Central...</span>
    </main>
  );
}

export default function App() {
  const [sessao, setSessao] = useState(null);
  const [trocaObrigatoria, setTrocaObrigatoria] = useState(
    () => localStorage.getItem('central_mykey_troca_senha') === '1'
  );
  const [verificando, setVerificando] = useState(
    () => Boolean(localStorage.getItem('central_mykey_token'))
  );

  useEffect(() => {
    const token = localStorage.getItem('central_mykey_token');

    if (!token) {
      return;
    }

    buscarSessao(token)
      .then(setSessao)
      .catch(() => {
        localStorage.removeItem('central_mykey_token');
      })
      .finally(() => setVerificando(false));
  }, []);

  function entrar(sessaoRecebida, deveTrocarSenha) {
    setSessao(sessaoRecebida);
    setTrocaObrigatoria(deveTrocarSenha);
  }

  function concluirTroca(sessaoAtualizada) {
    setSessao(sessaoAtualizada);
    setTrocaObrigatoria(false);
  }

  function sair() {
    localStorage.removeItem('central_mykey_token');
    localStorage.removeItem('central_mykey_troca_senha');
    setSessao(null);
    setTrocaObrigatoria(false);
  }

  if (verificando) {
    return <Carregando />;
  }

  if (!sessao) {
    return <Login aoEntrar={entrar} />;
  }

  if (trocaObrigatoria) {
    return (
      <TrocaSenha
        usuario={sessao.usuario}
        aoConcluir={concluirTroca}
        aoSair={sair}
      />
    );
  }

  return (
    <Painel
      usuario={sessao.usuario}
      permissoes={sessao.permissoes || []}
      aoSair={sair}
    />
  );
}
