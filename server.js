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

    // Histórico diário de seguidores — usado pela sub-aba Crescimento.
    // Só roda quando 'seguidores' vem nesta chamada (a do Instagram),
    // não na chamada só de Meta Ads. ID do doc = data do dia, então
    // rodar 2x no mesmo dia sobrescreve (nunca duplica).
    if (body.seguidores !== undefined) {
      const hojeStr = new Date().toISOString().slice(0, 10);
      const historicoRef = db.collection('instagram_historico');
      const anteriorHistSnap = await historicoRef
        .where('data', '<', hojeStr)
        .orderBy('data', 'desc')
        .limit(1)
        .get();
      const seguidoresAnterior = anteriorHistSnap.empty ? null : anteriorHistSnap.docs[0].data().seguidores;
      const ganho = seguidoresAnterior !== null ? (body.seguidores || 0) - seguidoresAnterior : 0;

      await historicoRef.doc(hojeStr).set({
        data: hojeStr,
        seguidores: body.seguidores || 0,
        ganhoSeguidores: ganho,
        diaSemana: new Date(hojeStr + 'T12:00:00').getDay()
      });
    }

    res.send('ok');
  } catch(e) { console.error(e); res.status(500).send('error'); }
});

// Importação retroativa em lote do histórico de seguidores — uso único,
// diferente do /manus-instagram diário (que recebe 1 snapshot por vez).
app.post('/manus-instagram-historico', async (req, res) => {
  try {
    const dias = req.body.historico;
    if (!Array.isArray(dias) || dias.length === 0) {
      res.status(400).send('formato invalido');
      return;
    }

    dias.sort((a, b) => new Date(a.data) - new Date(b.data));

    let anterior = null;
    const batch = db.batch();

    for (const dia of dias) {
      const d = new Date(dia.data + 'T12:00:00');
      const ganho = anterior !== null ? dia.seguidores - anterior : 0;
      const ref = db.collection('instagram_historico').doc(dia.data);
      batch.set(ref, {
        data: dia.data,
        seguidores: dia.seguidores,
        ganhoSeguidores: ganho,
        diaSemana: d.getDay()
      });
      anterior = dia.seguidores;
    }

    await batch.commit();
    res.send(`ok - ${dias.length} dias importados`);
  } catch(e) { console.error(e); res.status(500).send('error'); }
});

app.get('/', (req, res) => res.send('Mayara Webhook OK'));
app.listen(process.env.PORT || 3000, () => console.log('Rodando!'));
