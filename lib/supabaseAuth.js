// lib/supabaseAuth.js — helper compartilhado por api/db.js, api/role.js e api/obras.js: verifica
// quem esta chamando a API (via o token da sessao do Supabase Auth, mandado pelo front-end no
// cabecalho Authorization), descobre/cria o "papel" (role) e o "status" (pending/approved) dessa
// pessoa NUMA OBRA ESPECIFICA (numa tabela propria, user_roles), e manda um e-mail pra dona do app
// quando alguem novo pede acesso a uma obra.
//
// Multi-obra (2026-09-17): cada pessoa tem um papel/status POR OBRA, nao mais um global — a mesma
// pessoa pode ser planejador na Obra B e nao ter acesso nenhum (ou so pendente) em Jardins Berlim.
// Tabelas usadas (criar/atualizar uma vez, via SQL Editor do Supabase — ver plano da migracao):
//   create table obras (
//     id text primary key,
//     nome text not null,
//     created_at timestamptz not null default now(),
//     created_by uuid references auth.users(id)
//   );
//   create table user_roles (
//     user_id uuid not null,
//     obra_id text not null references obras(id),
//     email text not null,
//     role text not null default 'visualizador' check (role in ('planejador','visualizador')),
//     status text not null default 'pending' check (status in ('pending','approved')),
//     created_at timestamptz default now(),
//     primary key (user_id, obra_id)
//   );
//   create unique index user_roles_email_obra_idx on user_roles (email, obra_id);
import { createClient } from '@supabase/supabase-js';

export function supabaseAdmin(){
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// extrai e valida o token "Bearer ..." do cabecalho Authorization, devolve o usuario do Supabase Auth
// (ou null se nao tiver token / token invalido/expirado).
export async function getAuthedUser(req, admin){
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if(!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if(error || !data || !data.user) return null;
  return data.user;
}

// manda um e-mail pra quem administra o app (ADMIN_NOTIFY_EMAIL) avisando que alguem pediu acesso a
// uma obra. Usa o Resend (RESEND_API_KEY) — se essas variaveis nao estiverem configuradas ainda, so
// pula o envio (sem quebrar o cadastro por causa disso: a pessoa fica "pending" mesmo sem o e-mail
// sair, e quem administra ainda pode ver e aprovar em "Usuarios", dentro daquela obra).
// ADMIN_NOTIFY_EMAIL aceita mais de um destinatario, separados por virgula (2026-09-17, pedido dela:
// "quero que tambem chegue no email da caroline") — ela so precisa editar essa variavel de ambiente
// no painel da Vercel (Project Settings > Environment Variables), colocando os dois e-mails
// separados por virgula (ex: "anna@fgr.com.br,caroline@fgr.com.br"), e clicar em "Redeploy" no
// ultimo deploy pra function pegar o valor novo (variavel de ambiente so e lida de novo num deploy/
// cold start novo, editar o valor sozinho no painel nao basta).
// "onboarding@resend.dev" e o remetente de TESTE do Resend (sem dominio proprio verificado) — so
// aceita mandar pro UNICO e-mail dono da conta Resend, qualquer outro destinatario na lista faz o
// Resend recusar o envio INTEIRO (2026-09-23, achado depois dela reportar "desde que botei varios
// e-mails, nao chega pra nenhum" — antes so tinha o e-mail dela mesma ali, que e o dono da conta,
// por isso funcionava; ADMIN_NOTIFY_EMAIL virar dela+Caroline quebrou geral). O `fetch` sozinho NUNCA
// jogava esse erro pra fora (só lança exceção em falha de REDE, não em resposta HTTP de erro — a
// tentativa recusada retornava normal, sem exceção, então o catch abaixo nunca via nada) — por isso
// não dava pra saber que estava falhando. Agora loga o corpo da resposta quando `!res.ok`, pra pelo
// menos aparecer no log da function na Vercel da próxima vez. Mas a causa real só se resolve
// verificando um domínio próprio no Resend (Resend > Domains) e trocando o "from" abaixo pra um
// endereço desse domínio — com um domínio verificado, o Resend deixa mandar pra qualquer destinatário.
async function notifyNewSignup(email, obraNome){
  const key = process.env.RESEND_API_KEY;
  const to = (process.env.ADMIN_NOTIFY_EMAIL || '').split(',').map(s=>s.trim()).filter(Boolean);
  if(!key || !to.length) return;
  try{
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer '+key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Avanco Fisico FVS <onboarding@resend.dev>',
        to,
        subject: 'Novo pedido de acesso - '+obraNome,
        html: '<p><strong>'+email+'</strong> pediu acesso ao dashboard de <strong>'+obraNome+'</strong> como visualizador.</p>'
          + '<p>Entre no site e aprove (ou recuse) em "Usuarios", dentro daquela obra.</p>',
      }),
    });
    if(!res.ok){
      const body = await res.text().catch(()=>'');
      console.error('notifyNewSignup: Resend recusou o envio', res.status, body);
    }
  }catch(e){ console.error('notifyNewSignup failed', e); }
}

// devolve {role, status} pra esse usuario NESSA OBRA; se e a primeira vez que ele aparece nela, cria
// o registro — e se ele for a PRIMEIRA pessoa de todas a logar NESSA OBRA (ainda sem nenhuma linha
// pra ela), vira "planejador" JA APROVADO automaticamente (bootstrap do primeiro admin daquela obra,
// sem precisar de nenhum passo manual no banco). Isso nunca dispara à toa pra uma obra criada pela
// tela "+ Nova obra" — essa ja nasce com o criador registrado como planejador, entao a contagem nunca
// esta zerada quando uma SEGUNDA pessoa organicamente aparece. Qualquer outra pessoa entra como
// "visualizador" "pending" e dispara o e-mail de aviso.
export async function getUserRoleStatus(admin, userId, email, obraId){
  const { data: existing } = await admin.from('user_roles').select('role, status').eq('user_id', userId).eq('obra_id', obraId).maybeSingle();
  if(existing){
    // auto-corrige um caso de dado inconsistente (ex.: coluna "status" adicionada depois, com default
    // "pending" pra linhas que ja existiam) — um planejador nunca deveria ficar preso esperando
    // aprovacao dele mesmo.
    if(existing.role === 'planejador' && existing.status !== 'approved'){
      await admin.from('user_roles').update({ status: 'approved' }).eq('user_id', userId).eq('obra_id', obraId);
      return { role: existing.role, status: 'approved' };
    }
    return existing;
  }
  const { count } = await admin.from('user_roles').select('user_id', { count: 'exact', head: true }).eq('obra_id', obraId);
  const isFirst = !count;
  const role = isFirst ? 'planejador' : 'visualizador';
  const status = isFirst ? 'approved' : 'pending';
  await admin.from('user_roles').insert({ user_id: userId, obra_id: obraId, email, role, status });
  if(!isFirst){
    const { data: obra } = await admin.from('obras').select('nome').eq('id', obraId).maybeSingle();
    await notifyNewSignup(email, (obra && obra.nome) || obraId);
  }
  return { role, status };
}

// true se essa pessoa e planejador aprovado em PELO MENOS UMA obra — usado por api/obras.js pra
// decidir quem pode cadastrar uma obra nova (so quem ja e planejador de alguma).
export async function isPlanejadorEmAlgumaObra(admin, userId){
  const { count } = await admin.from('user_roles').select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('role', 'planejador').eq('status', 'approved');
  return !!count;
}
