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

app.get('/', (req, res) => res.send('Mayara Webhook OK'));
app.listen(process.env.PORT || 3000, () => console.log('Rodando!'));
