// Contact form validation shared by the browser (window.ShreedashValidate) and the server (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShreedashValidate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Email: local part of letters, digits and . _ % + - ' (no leading, trailing or double dots),
  // a domain of one or more labels, and a top-level domain of at least two letters.
  const EMAIL_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._%+'-]{1,64}(?<!\.)@(?=.{4,190}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

  function email(value) {
    const v = String(value || '').trim();
    if (!v) return { ok: false, error: 'Please enter your email address.' };
    if (v.length > 190 || !EMAIL_RE.test(v)) return { ok: false, error: 'Please enter a valid email address, like name@company.com.' };
    return { ok: true, value: v.toLowerCase() };
  }

  // Mobile: Indian numbers (10 digits starting 6 to 9, with optional +91, 91 or 0 in front),
  // or international numbers written with + and the country code (8 to 15 digits).
  function phone(value) {
    const raw = String(value || '').trim();
    if (!raw) return { ok: false, error: 'Please enter your mobile number.' };
    if (!/^\+?[0-9 ()\-.]+$/.test(raw)) return { ok: false, error: 'Use only digits, spaces and an optional + in the mobile number.' };
    const plus = raw.startsWith('+');
    const d = raw.replace(/\D/g, '');
    let local = null;
    if (plus && d.startsWith('91')) local = d.slice(2);
    else if (!plus && d.length === 12 && d.startsWith('91')) local = d.slice(2);
    else if (!plus && d.length === 11 && d.startsWith('0')) local = d.slice(1);
    else if (!plus) local = d;
    if (local !== null) {
      if (!/^[6-9][0-9]{9}$/.test(local)) {
        return { ok: false, error: 'Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9. For other countries, start with + and the country code.' };
      }
      return { ok: true, value: '+91 ' + local.slice(0, 5) + ' ' + local.slice(5) };
    }
    if (!/^[1-9][0-9]{7,14}$/.test(d)) return { ok: false, error: 'Please enter a valid international number: + then the country code and number, 8 to 15 digits.' };
    return { ok: true, value: '+' + d };
  }

  return { email, phone };
});
