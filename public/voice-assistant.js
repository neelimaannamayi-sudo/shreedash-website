// Shreedash website voice assistant: talk to the AI agent in the browser.
// Listens with the microphone, notices when you stop talking, sends the clip to /api/voice/web,
// plays the spoken reply, then listens again. You can interrupt it by talking.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const fab = $('vaFab'), box = $('va'), log = $('vaLog'), mic = $('vaMic'), st = $('vaSt');
  if (!fab || !box) return;

  let session = null, stream = null, ctx = null, analyser = null, rec = null, chunks = [];
  let state = 'idle'; // idle | listening | thinking | speaking
  let audio = null, vadTimer = null, heardSpeech = false, silenceSince = 0, listenStart = 0, loudSince = 0;
  let conversationOver = false;

  fetch('/api/voice/config').then(r => r.json()).then(c => {
    if (!c.web) return;
    fab.style.display = 'flex';
    const t = $('vaTry'); if (t) { t.hidden = false; t.addEventListener('click', open); }
    if (c.agent) $('vaName').textContent = c.agent + ', Shreedash AI assistant';
  }).catch(() => {});

  const status = t => { st.textContent = t; };
  const bubble = (who, text) => {
    if (!text) return;
    const d = document.createElement('div');
    d.className = 'b ' + who; d.textContent = text;
    log.appendChild(d); log.scrollTop = log.scrollHeight;
  };
  const setMic = cls => { mic.className = 'mic ' + (cls || ''); mic.setAttribute('aria-label', cls === 'live' ? 'Stop talking' : 'Start talking'); };

  async function api(body) {
    const r = await fetch('/api/voice/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    session = j.session || session;
    return j;
  }

  async function open() {
    box.classList.add('open'); fab.style.display = 'none';
    if (session) return;
    state = 'thinking'; setMic('busy'); status('Connecting…');
    try { handleReply(await api({})); }
    catch (e) { status(e.message); state = 'idle'; setMic(); }
  }
  function close() {
    box.classList.remove('open'); fab.style.display = 'flex';
    stopAll();
  }
  fab.addEventListener('click', open);
  $('vaClose').addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && box.classList.contains('open')) close(); });

  function stopAll() {
    if (audio) { audio.pause(); audio = null; }
    if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); }
    clearInterval(vadTimer); vadTimer = null;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    state = 'idle'; setMic(); status('Tap the mic and start talking');
  }

  function handleReply(j) {
    if (j.heard) bubble('u', j.heard);
    if (!j.reply) { status("Sorry, I didn't catch that."); return listen(); }
    bubble('a', j.reply);
    conversationOver = !!j.end;
    if (!j.audio) { state = 'idle'; setMic(); status(conversationOver ? 'Thanks for talking to us!' : 'Tap the mic to reply'); return; }
    state = 'speaking'; setMic(); status('Speaking… talk any time to interrupt');
    audio = new Audio('data:' + (j.mime || 'audio/mpeg') + ';base64,' + j.audio);
    audio.onended = () => { audio = null; if (conversationOver) { state = 'idle'; status('Thanks for talking to us!'); } else if (stream) listen(); else { state = 'idle'; status('Tap the mic to reply'); } };
    audio.play().catch(() => { state = 'idle'; status('Tap the mic to reply'); });
    if (stream) watchForInterrupt();
  }

  async function ensureMic() {
    if (stream) return true;
    if (!navigator.mediaDevices || !window.MediaRecorder) { status('Voice needs a newer browser. You can type instead.'); return false; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { status('Microphone blocked. Allow it in your browser, or type instead.'); return false; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    return true;
  }

  const level = (() => { let buf; return () => { if (!buf) buf = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); }; })();

  // While the assistant talks, start listening if the visitor speaks up.
  function watchForInterrupt() {
    clearInterval(vadTimer); loudSince = 0;
    vadTimer = setInterval(() => {
      if (state !== 'speaking' || !analyser) return clearInterval(vadTimer);
      if (level() > 0.06) { loudSince = loudSince || Date.now(); if (Date.now() - loudSince > 300) { if (audio) { audio.pause(); audio = null; } listen(); } }
      else loudSince = 0;
    }, 50);
  }

  async function listen() {
    if (!(await ensureMic())) { state = 'idle'; setMic(); return; }
    if (ctx.state === 'suspended') await ctx.resume();
    clearInterval(vadTimer);
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = send;
    rec.start();
    state = 'listening'; setMic('live'); status('Listening…');
    heardSpeech = false; silenceSince = 0; listenStart = Date.now();
    vadTimer = setInterval(() => {
      const now = Date.now(), loud = level() > 0.025;
      if (loud) { heardSpeech = true; silenceSince = 0; }
      else if (heardSpeech) { silenceSince = silenceSince || now; if (now - silenceSince > 900) stopListening(); }
      if (!heardSpeech && now - listenStart > 10000) { stopListening(true); }
      if (now - listenStart > 25000) stopListening();
    }, 60);
  }

  function stopListening(discard) {
    clearInterval(vadTimer); vadTimer = null;
    if (!rec || rec.state === 'inactive') return;
    if (discard) { rec.onstop = null; rec.stop(); state = 'idle'; setMic(); status('Tap the mic to talk'); return; }
    rec.stop();
  }

  async function send() {
    const blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
    state = 'thinking'; setMic('busy'); status('Thinking…');
    try {
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
      handleReply(await api({ audio: b64, mime: blob.type }));
    } catch (e) { state = 'idle'; setMic(); status(e.message); }
  }

  mic.addEventListener('click', async () => {
    if (state === 'listening') return stopListening();
    if (state === 'speaking') { if (audio) { audio.pause(); audio = null; } return listen(); }
    if (state === 'thinking') return;
    if (!session) await open();
    if (state === 'idle') listen();
  });

  $('vaForm').addEventListener('submit', async e => {
    e.preventDefault();
    const t = $('vaText').value.trim();
    if (!t || state === 'thinking') return;
    $('vaText').value = '';
    if (audio) { audio.pause(); audio = null; }
    if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); }
    clearInterval(vadTimer);
    bubble('u', t);
    state = 'thinking'; setMic('busy'); status('Thinking…');
    try { const j = await api({ text: t }); delete j.heard; handleReply(j); }
    catch (x) { state = 'idle'; setMic(); status(x.message); }
  });
})();
