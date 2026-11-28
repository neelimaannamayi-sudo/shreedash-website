'use strict';
// Minimal client for Sarvam AI: speech-to-text, text-to-speech and chat completions.
// Docs: https://docs.sarvam.ai  ·  Needs SARVAM_API_KEY (never commit it).

const BASE = 'https://api.sarvam.ai';
const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;

const config = () => ({
  key: env('SARVAM_API_KEY', ''),
  chatModel: env('SARVAM_CHAT_MODEL', 'sarvam-105b'),
  sttModel: env('SARVAM_STT_MODEL', 'saaras:v4'),
  ttsModel: env('SARVAM_TTS_MODEL', 'bulbul:v3'),
  // Asha is a woman, so default to a female voice for the model in use.
  speaker: env('SARVAM_TTS_SPEAKER', env('SARVAM_TTS_MODEL', 'bulbul:v3') === 'bulbul:v3' ? 'priya' : ''),
  pace: Number(env('SARVAM_TTS_PACE', '1.0'))
});

const enabled = () => Boolean(config().key);

// Languages Sarvam speaks. Anything else falls back to Indian English.
const LANGS = ['en-IN', 'hi-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'mr-IN', 'pa-IN', 'ta-IN', 'te-IN', 'ml-IN', 'od-IN'];
const normLang = l => (LANGS.includes(l) ? l : 'en-IN');

async function call(path, init, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { ...init, signal: ctrl.signal,
      headers: { 'api-subscription-key': config().key, ...(init.headers || {}) } });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) {
      const msg = (json && (json.error && (json.error.message || json.error) || json.message)) || text.slice(0, 300);
      throw new Error(`Sarvam ${path} ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return json;
  } finally { clearTimeout(t); }
}

// audio: Buffer; mime: e.g. 'audio/webm'. Returns { transcript, language }.
async function speechToText(audio, mime = 'audio/webm', language = 'unknown') {
  const c = config();
  const ext = (mime.split('/')[1] || 'webm').split(';')[0];
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime.split(';')[0] }), 'speech.' + ext);
  form.append('model', c.sttModel);
  form.append('language_code', language);
  const j = await call('/speech-to-text', { method: 'POST', body: form });
  return { transcript: (j.transcript || '').trim(), language: j.language_code ? normLang(j.language_code) : null };
}

// Returns an audio Buffer (WAV by default, or 'mp3'). sampleRate 8000 suits phone calls; 22050 or 24000 suits the website.
async function textToSpeech(text, language = 'en-IN', sampleRate = 22050, codec = 'wav') {
  const c = config();
  const body = { text: String(text).slice(0, 2400), language_code: normLang(language), model: c.ttsModel,
    speech_sample_rate: sampleRate, pace: c.pace, output_audio_codec: codec };
  if (c.speaker) body.speaker = c.speaker;
  const j = await call('/text-to-speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const parts = (j.audios || []).map(a => Buffer.from(a, 'base64'));
  if (!parts.length) throw new Error('Sarvam TTS returned no audio');
  return parts.length === 1 || codec !== 'wav' ? Buffer.concat(parts) : joinWav(parts);
}

// messages: [{role, content}]. Returns the reply text.
async function chat(messages, { maxTokens = 300, temperature = 0.5 } = {}) {
  const c = config();
  const j = await call('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.chatModel, messages, max_tokens: maxTokens, temperature, reasoning_effort: null }) }, 25000);
  const m = j.choices && j.choices[0] && j.choices[0].message;
  // Strip any thinking the model may print inline.
  return String((m && m.content) || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Raw 16-bit PCM samples from a WAV file (looks for the "data" chunk).
function wavToPcm(buf) {
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4), size = buf.readUInt32LE(i + 4);
    if (id === 'data') return buf.subarray(i + 8, Math.min(buf.length, i + 8 + size));
    i += 8 + size + (size % 2);
  }
  return buf.subarray(44);
}

// Wrap raw 16-bit mono PCM in a WAV header.
function pcmToWav(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Join several WAV files (same format) into one.
function joinWav(bufs) {
  const data = bufs.map(b => { const i = b.indexOf('data'); return i > 0 ? b.subarray(i + 8) : b; });
  const head = Buffer.from(bufs[0].subarray(0, bufs[0].indexOf('data') + 8));
  const len = data.reduce((n, d) => n + d.length, 0);
  head.writeUInt32LE(len + head.length - 8, 4);
  head.writeUInt32LE(len, head.length - 4);
  return Buffer.concat([head, ...data]);
}

module.exports = { enabled, config, speechToText, textToSpeech, chat, normLang, LANGS, wavToPcm, pcmToWav };
