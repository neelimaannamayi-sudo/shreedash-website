'use strict';
// One live phone call: Exotel streams the caller's audio (16-bit mono PCM, base64) over a WebSocket,
// we detect when they stop talking, transcribe with Sarvam, think, speak back with Sarvam TTS,
// and stop talking straight away if the caller interrupts.
const sarvam = require('./sarvam');
const agent = require('./voice-agent');

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;

class PhoneSession {
  // opts: { ws, sampleRate, call: { enquiry, greetingPcm }, onTranscript(turns, language), onEnd(reason), hangup() , log }
  constructor(opts) {
    Object.assign(this, opts);
    this.sr = this.sampleRate || 8000;
    this.frameBytes = Math.round(this.sr * 0.02) * 2; // 20 ms frames
    this.history = [];
    this.language = null;
    this.streamSid = null;
    this.buf = Buffer.alloc(0);
    // Voice activity detection state
    this.noise = 200; this.voicedRun = 0; this.silentRun = 0; this.inSpeech = false;
    this.preroll = []; this.utter = [];
    // Speaking state
    this.speaking = false; this.marks = 0; this.pendingMark = null;
    this.turn = 0; this.unanswered = '';
    this.ending = false; this.closed = false;
    this.lastActivity = Date.now(); this.idlePrompts = 0;
    this.startedAt = Date.now();
    this.maxMs = Number(env('VOICE_MAX_CALL_SECONDS', '600')) * 1000;
    this.silenceMs = Number(env('VOICE_END_OF_SPEECH_MS', '700'));
    this.ws.on('message', d => this.onMessage(d));
    this.ws.on('close', () => this.finish('callended'));
    this.ws.on('error', () => this.finish('error'));
    this.timer = setInterval(() => this.tick(), 1000);
  }

  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  onMessage(data) {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    switch (m.event) {
      case 'start': {
        this.streamSid = m.stream_sid || (m.start && m.start.stream_sid);
        this.callSid = m.start && m.start.call_sid;
        const rate = Number(m.start && m.start.media_format && m.start.media_format.sample_rate);
        if (rate) { this.sr = rate; this.frameBytes = Math.round(rate * 0.02) * 2; }
        this.onStart && this.onStart(this.callSid);
        this.greet();
        break;
      }
      case 'media':
        if (m.media && m.media.payload) this.onAudio(Buffer.from(m.media.payload, 'base64'));
        break;
      case 'mark':
        if (m.mark && m.mark.name === this.pendingMark) {
          this.speaking = false; this.pendingMark = null; this.lastActivity = Date.now();
          if (this.ending) this.hangupSoon();
        }
        break;
      case 'stop':
        this.finish((m.stop && m.stop.reason) || 'stopped');
        break;
    }
  }

  async greet() {
    const text = agent.greeting({ channel: 'phone', enquiry: this.call.enquiry });
    this.history.push({ role: 'assistant', content: text });
    this.saveTranscript();
    try {
      const pcm = this.call.greetingPcm || sarvam.wavToPcm(await sarvam.textToSpeech(text, 'en-IN', this.sr));
      this.play(pcm);
    } catch (err) { this.log('Greeting TTS failed: ' + err.message); }
  }

  // ---------- Listening ----------
  onAudio(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= this.frameBytes) {
      const frame = this.buf.subarray(0, this.frameBytes);
      this.buf = this.buf.subarray(this.frameBytes);
      this.onFrame(Buffer.from(frame));
    }
  }

  onFrame(frame) {
    let sum = 0;
    for (let i = 0; i + 1 < frame.length; i += 2) { const s = frame.readInt16LE(i); sum += s * s; }
    const rms = Math.sqrt(sum / (frame.length / 2));
    // While we are talking the line may carry some echo, so ask for a louder voice to count as an interruption.
    const threshold = Math.max(Number(env('VOICE_VAD_MIN_RMS', '350')), this.noise * 3) * (this.speaking ? 1.8 : 1);
    const voiced = rms > threshold;
    if (!voiced && !this.inSpeech) this.noise = this.noise * 0.95 + rms * 0.05;

    if (!this.inSpeech) {
      this.preroll.push(frame); if (this.preroll.length > 15) this.preroll.shift();
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= (this.speaking ? 12 : 6)) { // 240 ms to barge in, 120 ms otherwise
        this.inSpeech = true; this.silentRun = 0;
        this.utter = this.preroll.slice(); this.preroll = [];
        this.lastActivity = Date.now();
        if (this.speaking) this.interrupt();
        this.turn++; // any reply still being prepared is now out of date
      }
      return;
    }
    this.utter.push(frame);
    this.silentRun = voiced ? 0 : this.silentRun + 1;
    const tooLong = this.utter.length * 20 > 25000;
    if (this.silentRun * 20 >= this.silenceMs || tooLong) {
      const pcm = Buffer.concat(this.utter);
      this.inSpeech = false; this.utter = []; this.voicedRun = 0; this.silentRun = 0;
      this.lastActivity = Date.now();
      this.onUtterance(pcm);
    }
  }

  interrupt() {
    this.send({ event: 'clear', stream_sid: this.streamSid });
    this.speaking = false; this.pendingMark = null;
    if (this.ending) this.ending = false; // they still want to talk
  }

  async onUtterance(pcm) {
    if (this.closed) return;
    if (pcm.length < this.sr * 2 * 0.25) { // a click or cough under 250 ms: answer anything still waiting
      if (this.unanswered && !this.inSpeech) await this.respond(++this.turn);
      return;
    }
    const turn = ++this.turn;
    let heard;
    try { heard = await sarvam.speechToText(sarvam.pcmToWav(pcm, this.sr), 'audio/wav'); }
    catch (err) { this.log('STT failed: ' + err.message); return; }
    if (!heard.transcript) return;
    if (heard.language) this.language = heard.language;
    this.unanswered = (this.unanswered ? this.unanswered + ' ' : '') + heard.transcript;
    if (turn !== this.turn || this.inSpeech) return; // they kept talking; answer everything together
    await this.respond(turn);
  }

  // ---------- Thinking and speaking ----------
  async respond(turn) {
    const userText = this.unanswered;
    const history = [...this.history, { role: 'user', content: userText }];
    let r;
    try { r = await agent.reply({ channel: 'phone', enquiry: this.call.enquiry, history }); }
    catch (err) {
      this.log('Agent reply failed: ' + err.message);
      r = { text: 'Sorry, I missed that. Could you say it once more?', end: false };
    }
    if (turn !== this.turn || this.closed) return;
    let audio;
    try { audio = sarvam.wavToPcm(await sarvam.textToSpeech(r.text, this.language || 'en-IN', this.sr)); }
    catch (err) { this.log('TTS failed: ' + err.message); return; }
    if (turn !== this.turn || this.closed) return;
    this.unanswered = '';
    this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: r.text });
    if (r.optOut) this.optOut = true;
    this.saveTranscript();
    if (r.end || this.history.length >= 60) this.ending = true;
    this.play(audio);
  }

  play(pcm) {
    const CH = 3200; // 100 ms at 8 kHz; Exotel wants multiples of 320 bytes, at least 3.2 KB
    const total = Math.ceil(pcm.length / CH) * CH;
    const padded = total === pcm.length ? pcm : Buffer.concat([pcm, Buffer.alloc(total - pcm.length)]);
    for (let i = 0; i < padded.length; i += CH) {
      this.send({ event: 'media', stream_sid: this.streamSid, media: { payload: padded.subarray(i, i + CH).toString('base64') } });
    }
    this.pendingMark = 'say-' + (++this.marks);
    this.speaking = true;
    this.speakUntil = Date.now() + (pcm.length / (this.sr * 2)) * 1000 + 1500;
    this.send({ event: 'mark', stream_sid: this.streamSid, mark: { name: this.pendingMark } });
  }

  async say(text) {
    this.history.push({ role: 'assistant', content: text });
    this.saveTranscript();
    try { this.play(sarvam.wavToPcm(await sarvam.textToSpeech(text, this.language || 'en-IN', this.sr))); }
    catch (err) { this.log('TTS failed: ' + err.message); }
  }

  tick() {
    if (this.closed) return;
    const now = Date.now();
    // If a mark never comes back, assume playback finished.
    if (this.speaking && this.speakUntil && now > this.speakUntil + 4000) {
      this.speaking = false; this.pendingMark = null; this.lastActivity = now;
      if (this.ending) this.hangupSoon();
    }
    if (now - this.startedAt > this.maxMs && !this.ending) {
      this.ending = true;
      this.say('I need to wrap up now, but our team will follow up with the details by email. Thank you so much for your time!');
      return;
    }
    if (!this.speaking && !this.inSpeech && !this.ending && now - this.lastActivity > 9000) {
      this.lastActivity = now;
      this.idlePrompts++;
      if (this.idlePrompts === 1) this.say(this.language === 'hi-IN' ? 'Hello, kya aap line par hain?' : 'Hello, are you still there?');
      else { this.ending = true; this.say('It seems the line is quiet, so I will let you go. Our team will email you the details. Have a lovely day!'); }
    }
  }

  hangupSoon() {
    if (this.hangTimer) return;
    this.hangTimer = setTimeout(() => {
      this.hangup && this.hangup(this.callSid);
      try { this.ws.close(); } catch { /* already closed */ }
      this.finish('agent_ended');
    }, 600);
  }

  saveTranscript() { this.onTranscript && this.onTranscript(this.history, this.language); }

  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer); clearTimeout(this.hangTimer);
    this.onEnd && this.onEnd({ reason, history: this.history, language: this.language, optOut: this.optOut, callSid: this.callSid });
  }
}

module.exports = PhoneSession;
