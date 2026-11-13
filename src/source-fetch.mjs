import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

function blockedAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) !== 6) return true;
  // Canonicalize IPv4-mapped spellings too (e.g. ::ffff:127.0.0.1 -> ::ffff:7f00:1).
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  const words = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  const parts = words.map((word) => parseInt(word, 16));
  if (parts.slice(0, 5).every((part) => part === 0) && (parts[5] === 0xffff || parts[5] === 0)) {
    if (parts[5] === 0 && parts[6] === 0 && parts[7] <= 1) return true;
    return blockedAddress(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`);
  }
  return (parts[0] & 0xfe00) === 0xfc00 || (parts[0] & 0xffc0) === 0xfe80 ||
    (parts[0] & 0xffc0) === 0xfec0 || (parts[0] & 0xff00) === 0xff00;
}

function blocked() {
  return Object.assign(new Error('blocked_address'), { code: 'blocked_address' });
}

async function checkedAddress(url, signal) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw blocked();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  signal.throwIfAborted();
  let addresses;
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    // DNS lookup itself is not cancellable; stop waiting when the worker deadline expires.
    let onAbort;
    try {
      addresses = await Promise.race([
        dns.lookup(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => blockedAddress(address))) throw blocked();
  return addresses[0];
}

// Node fetch accepts an Undici dispatcher. Use built-in HTTP transports to pin the checked DNS
// answer, retaining the original hostname for Host/TLS validation; no second DNS lookup or proxy.
function pinnedDispatcher(url, address) {
  return {
    dispatch(options, handler) {
      let ended = false;
      const fail = (error) => { if (!ended) { ended = true; handler.onError(error); } };
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: options.method,
        headers: options.headers,
        agent: false,
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      });
      request.on('error', fail);
      request.on('response', (response) => {
        response.on('error', fail);
        response.on('data', (chunk) => { if (handler.onData(chunk) === false) response.pause(); });
        response.on('end', () => { if (!ended) { ended = true; handler.onComplete(response.rawTrailers); } });
        if (handler.onHeaders(response.statusCode, response.rawHeaders, () => response.resume(), response.statusMessage) === false) response.pause();
      });
      handler.onConnect((reason) => request.destroy(reason instanceof Error ? reason : new Error('aborted')));
      request.end();
      return true;
    },
  };
}

export async function fetchSource(source, { signal }) {
  let url = new URL(source);
  for (let hops = 0; ; hops++) {
    const address = await checkedAddress(url, signal);
    const response = await fetch(url.href, {
      signal, redirect: 'manual', dispatcher: pinnedDispatcher(url, address),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    await response.body?.cancel();
    if (hops === 3) throw new Error('redirect limit');
    url = new URL(location, url);
  }
}
