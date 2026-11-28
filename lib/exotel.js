'use strict';
// Exotel (India) outbound calls that connect the customer straight to our WebSocket voice bot.
// Docs: https://developer.exotel.com/docs/agentstream/connect-voice-ai
const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;

const config = () => ({
  sid: env('EXOTEL_ACCOUNT_SID', ''),
  key: env('EXOTEL_API_KEY', ''),
  token: env('EXOTEL_API_TOKEN', ''),
  callerId: env('EXOTEL_CALLER_ID', ''), // your ExoPhone
  host: env('EXOTEL_API_HOST', 'api.in.exotel.com') // api.exotel.com for Singapore accounts
});

const enabled = () => { const c = config(); return Boolean(c.sid && c.key && c.token && c.callerId); };

async function request(method, path, form) {
  const c = config();
  const res = await fetch(`https://${c.host}/v1/Accounts/${encodeURIComponent(c.sid)}${path}`, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(`${c.key}:${c.token}`).toString('base64'),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? form.toString() : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const msg = (json && json.RestException && json.RestException.Message) || text.slice(0, 300);
    throw new Error(`Exotel ${res.status}: ${msg}`);
  }
  return json;
}

// Calls `to` from the ExoPhone; when they answer, Exotel opens a two-way audio WebSocket to streamUrl.
async function startCall({ to, streamUrl, statusUrl, customField, timeLimit = 900 }) {
  const c = config();
  const form = new URLSearchParams();
  form.append('From', to);
  form.append('CallerId', c.callerId);
  form.append('StreamUrl', streamUrl);
  form.append('StreamType', 'bidirectional');
  form.append('CallType', 'trans');
  form.append('TimeLimit', String(timeLimit));
  form.append('Record', env('EXOTEL_RECORD', 'false') === 'true' ? 'true' : 'false');
  if (customField) form.append('CustomField', String(customField).slice(0, 128));
  if (statusUrl) {
    form.append('StatusCallback', statusUrl);
    form.append('StatusCallbackEvents[]', 'answered');
    form.append('StatusCallbackEvents[]', 'terminal');
  }
  const j = await request('POST', '/Calls/connect.json', form);
  return { sid: j && j.Call && j.Call.Sid, status: j && j.Call && j.Call.Status };
}

// Best effort: hang up every active leg of a call.
async function hangup(callSid) {
  if (!callSid) return;
  try {
    const j = await request('GET', `/Calls/${encodeURIComponent(callSid)}/ActiveLegs.json`);
    const legs = [].concat((j && (j.Legs || j.ActiveLegs || (j.Call && j.Call.Legs))) || []);
    for (const l of legs) {
      const legSid = (l.Leg && l.Leg.Sid) || l.Sid || l.LegSid;
      if (!legSid) continue;
      const form = new URLSearchParams({ Action: 'hangup' });
      await request('PUT', `/Calls/${encodeURIComponent(callSid)}/Legs/${encodeURIComponent(legSid)}.json`, form).catch(() => {});
    }
  } catch (err) { /* the call may already be over */ }
}

module.exports = { enabled, config, startCall, hangup };
