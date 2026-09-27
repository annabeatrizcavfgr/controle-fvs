// api/db.js — Vercel Serverless Function que implementa "documentos" e "colecoes" (parecido com o
// Firestore) por cima de UMA tabela so no Supabase (Postgres). O front-end (index.html) fala com essa
// API por fetch, nunca com o Supabase direto (a chave secreta de servidor fica so aqui, nunca no
// navegador).
//
// Tabela usada (criar uma vez, via SQL Editor do Supabase):
//   create table docs (
//     path text primary key,
//     value jsonb not null
//   );
//
// "Colecao" = todo documento cujo caminho e "<caminho-colecao>/<id>", sem nenhuma barra a mais depois
// disso. Resolvido com um LIKE direto no banco + um filtro em JS pra manter so os filhos diretos.
//
// MULTI-OBRA (2026-09-17): todo path de verdade (menos o healthcheck) precisa comecar com
// "obras/<obraId>/..." — e o "<obraId>" e extraido do proprio path e usado pra checar o papel/status
// dessa pessoa NAQUELA obra especifica, nunca um papel global. Antes disso o servidor confiava
// cegamente em qualquer "path" que o navegador mandasse; agora um path fora do formato "obras/.../"
// e recusado, e mesmo um path bem-formado só é atendido se a pessoa realmente tiver acesso aquela
// obra — isso e o que impede o navegador de uma obra pedir (por engano ou de proposito) os dados de
// outra so trocando o "path" na mao.
//
// LOGIN/PERMISSAO: toda chamada (menos o healthcheck) exige um usuario logado (Supabase Auth) E
// aprovado NAQUELA OBRA (status='approved', ver lib/supabaseAuth.js e a tela "Usuarios") — quem esta
// "pending" (acabou de pedir acesso aquela obra, esperando um planejador dela aprovar) nao le nem
// grava nada aqui. Alem disso, GRAVAR (POST: set/delete/add) exige que o papel NAQUELA OBRA seja
// "planejador" — "visualizador" so consegue ler (GET).
import { supabaseAdmin, getAuthedUser, getUserRoleStatus } from '../lib/supabaseAuth.js';

// "obras/<id>/resto/do/caminho" -> "<id>" (ou null se o path nao seguir esse formato).
function obraIdFromPath(path){
  const m = /^obras\/([^/]+)\//.exec(path || '');
  return m ? m[1] : null;
}

// VERSIONAMENTO (2026-09-27): cfg e medicaoUau sao documentos grandes gravados inteiros a cada
// clique — sem controle, duas pessoas com o app aberto (ex.: ela e a Caroline) sobrescreviam uma o
// trabalho da outra sem ninguem perceber. Agora o front manda junto "baseRev" (a versao que ele leu);
// a gravacao so acontece se o documento no banco AINDA estiver nessa versao (update condicional,
// atomico no Postgres). Se outra pessoa gravou antes, devolve 409 com a versao atual, e o front
// combina as duas alteracoes (ver mesclar3 no index.html) e tenta de novo. A versao fica dentro do
// proprio JSON, no campo "_rev" — nao precisa mudar a tabela.
const DOCS_COM_HISTORICO = /^(obras\/[^/]+)\/(cfg|medicaoUau)$/;
const DIAS_HISTORICO = 35;

function diaSaoPaulo(d){
  // "2026-09-27" no fuso de Brasilia (a Vercel roda em UTC)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}

// BACKUP DIARIO (2026-09-27): na PRIMEIRA gravacao de cada dia em cfg/medicaoUau, guarda uma copia de
// como o documento estava ANTES dela, em obras/<id>/historico/<doc>/<AAAA-MM-DD>. Assim sempre da pra
// voltar pra "como estava no inicio de hoje/ontem" (tela Backups no app). Copias com mais de
// DIAS_HISTORICO dias sao apagadas aqui mesmo. Falha no backup nunca impede a gravacao em si.
async function snapshotDoDia(supabase, path){
  const m = DOCS_COM_HISTORICO.exec(path);
  if(!m) return;
  try{
    const prefixo = m[1] + '/historico/' + m[2] + '/';
    const dia = diaSaoPaulo();
    const histPath = prefixo + dia;
    const { data: ja } = await supabase.from('docs').select('path').eq('path', histPath).maybeSingle();
    if(ja) return;
    const { data: atual } = await supabase.from('docs').select('value').eq('path', path).maybeSingle();
    if(!atual || !atual.value) return;
    await supabase.from('docs').insert({ path: histPath, value: { ...atual.value, _snapshotEm: new Date().toISOString() } });
    const limite = diaSaoPaulo(new Date(Date.now() - DIAS_HISTORICO * 86400000));
    const { data: todos } = await supabase.from('docs').select('path').like('path', prefixo + '%');
    const antigos = (todos || []).map((r) => r.path).filter((p) => p.slice(prefixo.length, prefixo.length + 10) < limite);
    if(antigos.length) await supabase.from('docs').delete().in('path', antigos);
  }catch(e){ console.error('snapshotDoDia falhou', e); }
}

async function responderConflito(supabase, res, path){
  const { data: atual } = await supabase.from('docs').select('value').eq('path', path).maybeSingle();
  const value = atual ? atual.value : null;
  return res.status(409).json({ conflict: true, data: value, rev: value && value._rev ? value._rev : 0 });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET' && req.query.path === '__healthcheck__') {
      return res.status(200).json({ ok: true });
    }

    let supabase;
    try {
      supabase = supabaseAdmin();
    } catch (e) {
      return res.status(500).json({
        error: 'Falha ao criar cliente Supabase: ' + String((e && e.message) || e),
        hasUrl: !!process.env.SUPABASE_URL,
        hasKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      });
    }

    const user = await getAuthedUser(req, supabase);
    if (!user) return res.status(401).json({ error: 'nao autenticado' });

    const pathParaObra = req.method === 'POST' ? (req.body || {}).path : req.query.path;
    const obraId = obraIdFromPath(pathParaObra);
    if (!obraId) return res.status(400).json({ error: 'path precisa comecar com "obras/<id>/"' });
    const mine = await getUserRoleStatus(supabase, user.id, user.email, obraId);
    if (mine.status !== 'approved') return res.status(403).json({ error: 'conta aguardando aprovacao nessa obra', status: mine.status });

    if (req.method === 'GET') {
      const { path, collection, orderBy, dir, limit, idsOnly } = req.query;
      if (!path) return res.status(400).json({ error: 'path obrigatorio' });

      if (collection === 'true') {
        // idsOnly=true: so os ids, sem o conteudo — pra listar backups/partes sem baixar megabytes.
        const soIds = idsOnly === 'true';
        const { data: rows, error } = await supabase
          .from('docs')
          .select(soIds ? 'path' : 'path, value')
          .like('path', path + '/%');
        if (error) throw error;

        let docs = (rows || [])
          .filter((r) => !r.path.slice(path.length + 1).includes('/'))
          .map((r) => ({ id: r.path.slice(path.length + 1), data: soIds ? null : r.value }));
        if (soIds) return res.status(200).json({ docs });

        if (orderBy) {
          docs.sort((a, b) => {
            const av = a.data[orderBy], bv = b.data[orderBy];
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === 'desc' ? -cmp : cmp;
          });
        }
        if (limit) docs = docs.slice(0, parseInt(limit, 10));
        return res.status(200).json({ docs });
      }

      const { data, error } = await supabase.from('docs').select('value').eq('path', path).maybeSingle();
      if (error) throw error;
      return res.status(200).json({ exists: data != null, data: data ? data.value : null });
    }

    if (req.method === 'POST') {
      if (mine.role !== 'planejador') return res.status(403).json({ error: 'so planejador pode editar' });
      const body = req.body || {};
      const { path, action, data } = body;
      if (!path || !action) return res.status(400).json({ error: 'path e action obrigatorios' });

      // gravacao versionada (ver comentario de VERSIONAMENTO no topo)
      if (action === 'set' && Object.prototype.hasOwnProperty.call(body, 'baseRev')) {
        const baseRev = Number(body.baseRev) || 0;
        const novaRev = baseRev + 1;
        const valor = { ...(data || {}), _rev: novaRev };
        await snapshotDoDia(supabase, path);
        if (baseRev > 0) {
          const { data: rows, error } = await supabase.from('docs').update({ value: valor })
            .eq('path', path).eq('value->>_rev', String(baseRev)).select('path');
          if (error) throw error;
          if (!rows || rows.length === 0) return responderConflito(supabase, res, path);
          return res.status(200).json({ ok: true, rev: novaRev });
        }
        // baseRev 0: quem gravou achava que o doc nao existia (ou era de antes do versionamento)
        const { data: atual, error: errAtual } = await supabase.from('docs').select('value').eq('path', path).maybeSingle();
        if (errAtual) throw errAtual;
        if (!atual) {
          const { error } = await supabase.from('docs').insert({ path, value: valor });
          if (error) {
            if (error.code === '23505') return responderConflito(supabase, res, path);
            throw error;
          }
          return res.status(200).json({ ok: true, rev: novaRev });
        }
        if (atual.value && atual.value._rev) return responderConflito(supabase, res, path);
        const { error } = await supabase.from('docs').update({ value: valor }).eq('path', path);
        if (error) throw error;
        return res.status(200).json({ ok: true, rev: novaRev });
      }

      if (action === 'set') {
        const { error } = await supabase.from('docs').upsert({ path, value: data });
        if (error) throw error;
        return res.status(200).json({ ok: true });
      }

      if (action === 'delete') {
        const { error } = await supabase.from('docs').delete().eq('path', path);
        if (error) throw error;
        return res.status(200).json({ ok: true });
      }

      if (action === 'add') {
        const id = 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const { error } = await supabase.from('docs').insert({ path: path + '/' + id, value: data });
        if (error) throw error;
        return res.status(200).json({ id });
      }

      return res.status(400).json({ error: 'action desconhecida: ' + action });
    }

    return res.status(405).json({ error: 'metodo nao permitido' });
  } catch (e) {
    console.error('api/db error', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
