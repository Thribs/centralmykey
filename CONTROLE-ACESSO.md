# Controle de acesso

A autenticação usa token JWT de 12 horas. A cada requisição protegida, a API
consulta novamente o usuário e exige status `ATIVO`; bloquear ou inativar um
usuário invalida o acesso imediatamente, mesmo que o token ainda não tenha
expirado.

As permissões são avaliadas por módulo e por ação:

- visualizar;
- criar;
- editar;
- excluir;
- aprovar.

O middleware consulta `usuario_permissoes` e também exige que o módulo esteja
ativo. Usuários com senha provisória podem acessar apenas a sessão e a troca de
senha até concluírem essa etapa.

O teste `api/teste-autorizacao.js` usa as rotas reais de login e os middlewares
reais. Ele comprova senha incorreta, token válido e adulterado, ausência de
token, módulo inativo, as cinco ações com combinações permitidas e negadas,
restrição da senha provisória e bloqueio imediato do usuário. O usuário fictício
fica em transação MySQL com rollback; os módulos e permissões usam tabelas
temporárias, sem alterar configurações reais.
