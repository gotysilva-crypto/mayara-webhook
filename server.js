const express = require('express');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

if (!admin.apps.length) {
  const cred = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  admin.initializeApp({ credential: admin.credential.cert(cred) });
}
const db = admin.firestore();

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.fromMe === true) { res.send('ok'); return; }
    const numero = (body.phone || body.from || '').replace(/[^0-9]/g,'').replace(/^55/,'');
    if (!numero || numero.length < 8) { res.send('ok'); return; }
    const timestamp = new Date().toISOString();
    const nome = body.senderName || body.pushName || numero;
    const snap = await db.collection('leads').get();
    let leadRef = null;
    snap.forEach(doc => {
      const tel = (doc.data().tel||'').replace(/[^0-9]/g,'').replace(/^55/,'');
      if (tel === numero) leadRef = doc.ref;
    });
    if (leadRef) {
      await leadRef.update({ ultimaRespostaLead: timestamp });
    } else {
      const meses = ['JANEIRO','FEVEREIRO','MARCO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
      await db.collection('leads').add({
        nome, tel: numero, numero_whatsapp: '55'+numero,
        data: new Date().toISOString().slice(0,10),
        etq: 'LEAD '+meses[new Date().getMonth()],
        st: 'Novo', etapa: 'Novo', origem: 'WhatsApp',
        primeiroContato: timestamp, ultimaRespostaLead: timestamp,
        followupsConcluidos: [], historico: [], arquivado: false
      });
    }
    res.send('ok');
  } catch(e) { console.error(e); res.status(500).send('error'); }
});

// Recebe snapshot do Instagram e/ou Meta Ads gerado pelo Manus AI.
// Aceita chamadas PARCIAIS (só Instagram, ou só Meta Ads) — usa
// merge:true pra nunca apagar campos que outra chamada acabou de
// salvar minutos antes. O 'anterior' só é movido uma vez por dia
// (na primeira chamada), não a cada chamada parcial subsequente.
app.post('/manus-instagram', async (req, res) => {
  try {
    const body = req.body;

    const temInstagramData = body.seguidores !== undefined;
    const temMetaAdsData = body.campanhas !== undefined;
    if (!temInstagramData && !temMetaAdsData) {
      res.status(400).send('payload invalido');
      return;
    }

    const docAtualRef = db.collection('instagram_insights').doc('atual');
    const docAtualSnap = await docAtualRef.get();
    const dadosAtuais = docAtualSnap.exists ? docAtualSnap.data() : null;

    const hoje = new Date().toISOString().slice(0, 10);
    const atualizadoHoje = dadosAtuais?.atualizadoEm?.slice(0, 10) === hoje;

    // Só move para 'anterior' na PRIMEIRA chamada do dia, não a cada
    // chamada parcial subsequente (evita sobrescrever o 'anterior' com
    // um snapshot de minutos atrás, no mesmo dia).
    if (dadosAtuais && !atualizadoHoje) {
      await db.collection('instagram_insights').doc('anterior').set(dadosAtuais);
    }

    // Só grava os campos que vieram nesta chamada — preserva o resto.
    const camposParaAtualizar = {};
    if (body.seguidores !== undefined) camposParaAtualizar.seguidores = body.seguidores;
    if (body.alcance7d !== undefined) camposParaAtualizar.alcance7d = body.alcance7d;
    if (body.impressoes7d !== undefined) camposParaAtualizar.impressoes7d = body.impressoes7d;
    if (body.posts !== undefined) camposParaAtualizar.posts = body.posts;
    if (body.investimento7d !== undefined) camposParaAtualizar.investimento7d = body.investimento7d;
    if (body.custoPorResultado !== undefined) camposParaAtualizar.custoPorResultado = body.custoPorResultado;
    if (body.campanhas !== undefined) camposParaAtualizar.campanhasMeta = body.campanhas;

    camposParaAtualizar.atualizadoEm = new Date().toISOString();

    await docAtualRef.set(camposParaAtualizar, { merge: true });

    // Histórico diário — usado pela aba Crescimento (seguidores) e pelos
    // KPIs "(mês)" do Instagram (alcance/impressões/resultados). Instagram
    // (08:00) e Meta Ads (08:05) chegam em chamadas separadas no mesmo dia —
    // merge:true pra uma não apagar o que a outra já gravou.
    const hojeStr = new Date().toISOString().slice(0, 10);
    const historicoUpdate = {
      data: hojeStr,
      diaSemana: new Date(hojeStr + 'T12:00:00').getDay()
    };

    if (body.seguidores !== undefined) {
      // Busca os últimos dias e pega o primeiro que realmente tem 'seguidores'
      // gravado — dias com update parcial (só resultados, por exemplo) não
      // servem de base pro cálculo do ganho, senão vira NaN/null.
      const anteriorHistSnap = await db.collection('instagram_historico')
        .where('data', '<', hojeStr)
        .orderBy('data', 'desc')
        .limit(10)
        .get();
      let seguidoresAnterior = null;
      for (const doc of anteriorHistSnap.docs) {
        const v = doc.data().seguidores;
        if (typeof v === 'number') { seguidoresAnterior = v; break; }
      }
      const ganho = seguidoresAnterior !== null ? (body.seguidores || 0) - seguidoresAnterior : 0;
      historicoUpdate.seguidores = body.seguidores || 0;
      historicoUpdate.ganhoSeguidores = ganho;
    }
    if (body.alcanceHoje !== undefined) historicoUpdate.alcance = body.alcanceHoje;
    if (body.impressoesHoje !== undefined) historicoUpdate.impressoes = body.impressoesHoje;
    if (body.resultadosHoje !== undefined) historicoUpdate.resultados = body.resultadosHoje;

    const temHistoricoData = body.seguidores !== undefined || body.alcanceHoje !== undefined ||
      body.impressoesHoje !== undefined || body.resultadosHoje !== undefined;
    if (temHistoricoData) {
      await db.collection('instagram_historico').doc(hojeStr).set(historicoUpdate, { merge: true });
    }

    res.send('ok');
  } catch(e) { console.error(e); res.status(500).send('error'); }
});

// Importação retroativa em lote pro histórico diário — uso único/pontual.
// Aceita entradas parciais (só seguidores, só alcance/impressoes/resultados,
// ou tudo junto) e usa merge:true pra nunca apagar o que já existe no dia
// (ex.: rodar isso pra preencher alcance/impressoes de dias que já têm
// seguidores gravado pelo /manus-instagram diário).
app.post('/manus-instagram-historico', async (req, res) => {
  try {
    const dias = req.body.historico;
    if (!Array.isArray(dias) || dias.length === 0) {
      res.status(400).send('formato invalido');
      return;
    }

    dias.sort((a, b) => new Date(a.data) - new Date(b.data));

    let anteriorSeguidores = null;
    const batch = db.batch();

    for (const dia of dias) {
      const d = new Date(dia.data + 'T12:00:00');
      const doc = { data: dia.data, diaSemana: d.getDay() };

      if (dia.seguidores !== undefined) {
        const ganho = anteriorSeguidores !== null ? dia.seguidores - anteriorSeguidores : 0;
        doc.seguidores = dia.seguidores;
        doc.ganhoSeguidores = ganho;
        anteriorSeguidores = dia.seguidores;
      }
      if (dia.alcance !== undefined) doc.alcance = dia.alcance;
      if (dia.impressoes !== undefined) doc.impressoes = dia.impressoes;
      if (dia.resultados !== undefined) doc.resultados = dia.resultados;

      const ref = db.collection('instagram_historico').doc(dia.data);
      batch.set(ref, doc, { merge: true });
    }

    await batch.commit();
    res.send(`ok - ${dias.length} dias importados`);
  } catch(e) { console.error(e); res.status(500).send('error'); }
});

// Realizado mensal de conteúdo (Reels/Posts/Stories) — total do PERÍODO,
// não soma diária. Vem do painel "Formatos de conteúdo" do Meta Business
// Suite, que já entrega o total do intervalo de datas selecionado — mais
// confiável de coletar do que tentar quebrar por dia. Aceita chamadas
// parciais (merge:true): a tarefa diária manda o mês vigente, o backfill
// manda um POST por mês passado.
app.post('/manus-conteudo-mes', async (req, res) => {
  try {
    const body = req.body;
    if (!body.mes || !body.ano) {
      res.status(400).send('mes e ano obrigatorios');
      return;
    }
    const norm = String(body.mes).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const slug = `${body.ano}-${norm}`;

    const doc = { mes: body.mes, ano: body.ano, atualizadoEm: new Date().toISOString() };
    if (body.reels !== undefined) doc.reels = body.reels;
    if (body.posts !== undefined) doc.posts = body.posts;
    if (body.stories !== undefined) doc.stories = body.stories;

    await db.collection('conteudo_realizado').doc(slug).set(doc, { merge: true });
    res.send('ok');
  } catch(e) { console.error(e); res.status(500).send('error'); }
});

app.get('/', (req, res) => res.send('Mayara Webhook OK'));
app.listen(process.env.PORT || 3000, () => console.log('Rodando!'));
