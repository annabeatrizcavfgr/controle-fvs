// api/obras.js — cadastro de obras (multi-obra, 2026-09-17).
// GET (sem query)        -> minhas obras (as que eu ja tenho QUALQUER linha em user_roles),
//                           com meu papel/status em cada uma - alimenta o seletor de obra.
// GET ?all=true           -> lista TODA obra cadastrada, so {id,nome} (sem papel) - alimenta a tela
//                           "Escolha uma obra" de quem ainda nao participa de nenhuma. Lista aberta,
//                           de proposito (mesma empresa, times diferentes podem se ver).
// POST {nome}              -> cadastra uma obra nova. So quem ja e planejador aprovado em PELO MENOS
//                           UMA obra pode fazer isso; quem cria vira automaticamente planejador
//                           aprovado da obra nova.
// POST {action:'join', obra_id} -> pede acesso a uma obra que eu ainda nao participo (cria minha
//                           linha em user_roles nela, pending - ou planejador/approved se por acaso
//                           for a primeira pessoa de todas a entrar nessa obra) - so um invólucro
//                           explicito sobre a mesma logica que ja existe em getUserRoleStatus.
import { supabaseAdmin, getAuthedUser, getUserRoleStatus, isPlanejadorEmAlgumaObra } from '../lib/supabaseAuth.js';

function slugify(nome){
  return (nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'obra';
}

export default async function handler(req, res) {
  try {
    const admin = supabaseAdmin();
    const user = await getAuthedUser(req, admin);
    if (!user) return res.status(401).json({ error: 'nao autenticado' });

    if (req.method === 'GET') {
      if (req.query.all === 'true') {
        const { data, error } = await admin.from('obras').select('id, nome').order('nome');
        if (error) throw error;
        return res.status(200).json({ obras: data || [] });
      }
      const { data, error } = await admin.from('user_roles').select('obra_id, role, status').eq('user_id', user.id);
      if (error) throw error;
      const obraIds = (data || []).map((r) => r.obra_id);
      let nomes = {};
      if (obraIds.length) {
        const { data: obrasData, error: obrasError } = await admin.from('obras').select('id, nome').in('id', obraIds);
        if (obrasError) throw obrasError;
        nomes = Object.fromEntries((obrasData || []).map((o) => [o.id, o.nome]));
      }
      const minhas = (data || []).map((r) => ({ id: r.obra_id, nome: nomes[r.obra_id] || r.obra_id, role: r.role, status: r.status }));
      return res.status(200).json({ obras: minhas });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      if (body.action === 'join') {
        const obraId = body.obra_id;
        if (!obraId) return res.status(400).json({ error: 'obra_id obrigatorio' });
        const { data: obra } = await admin.from('obras').select('id').eq('id', obraId).maybeSingle();
        if (!obra) return res.status(404).json({ error: 'obra nao encontrada' });
        const mine = await getUserRoleStatus(admin, user.id, user.email, obraId);
        return res.status(200).json({ ok: true, role: mine.role, status: mine.status });
      }

      const nome = (body.nome || '').trim();
      if (!nome) return res.status(400).json({ error: 'nome obrigatorio' });
      const podeCriar = await isPlanejadorEmAlgumaObra(admin, user.id);
      if (!podeCriar) return res.status(403).json({ error: 'so quem ja e planejador de alguma obra pode cadastrar uma obra nova' });

      let id = slugify(nome);
      const { data: existing } = await admin.from('obras').select('id').like('id', id + '%');
      const usados = new Set((existing || []).map((o) => o.id));
      if (usados.has(id)) {
        let n = 2;
        while (usados.has(id + '-' + n)) n++;
        id = id + '-' + n;
      }
      const { error: insertObraError } = await admin.from('obras').insert({ id, nome, created_by: user.id });
      if (insertObraError) throw insertObraError;
      const { error: insertRoleError } = await admin.from('user_roles').insert({ user_id: user.id, obra_id: id, email: user.email, role: 'planejador', status: 'approved' });
      if (insertRoleError) throw insertRoleError;
      return res.status(200).json({ id, nome });
    }

    return res.status(405).json({ error: 'metodo nao permitido' });
  } catch (e) {
    console.error('api/obras error', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
