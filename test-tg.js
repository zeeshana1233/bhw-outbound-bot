// Quick Telegram connectivity test — node test-tg.js
// Tests: direct IP TCP, HTTPS direct IP, HTTPS via proxy, HTTPS via hostname
import https from 'https';
import net from 'net';
import { HttpsProxyAgent } from 'https-proxy-agent';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8784111112:AAF_HiA_E9-FgFy5qG3aMtR-m7JBSRzNZwI';
const KNOWN_IP = '149.154.166.110';
const PROXY_URL = process.env.TELEGRAM_PROXY_URL || 'http://364a87d67519885f4520__cr.gb:c55e092b8405598b@gw.dataimpulse.com:10000';

console.log('--- Telegram connectivity test ---');
console.log('Proxy:', PROXY_URL.replace(/:\/\/.*@/, '://<creds>@'));

// Test 1: Direct IP TCP
const sock = net.createConnection({ host: KNOWN_IP, port: 443 });
sock.setTimeout(5000);
sock.on('connect', () => {
  console.log('[1] Direct IP TCP 443: OPEN');
  sock.destroy();
  runTest2();
});
sock.on('timeout', () => {
  console.log('[1] Direct IP TCP 443: TIMEOUT');
  sock.destroy();
  runTest2();
});
sock.on('error', e => {
  console.log('[1] Direct IP TCP 443: ERROR', e.message);
  runTest2();
});

function runTest2() {
  // Test 2: HTTPS via proxy
  console.log('[2] Testing HTTPS via proxy...');
  const agent = new HttpsProxyAgent(PROXY_URL);
  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TOKEN}/getMe`,
    method: 'GET',
    agent,
    timeout: 12000,
  };
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('[2] HTTPS via proxy: OK', data.slice(0, 120));
      process.exit(0);
    });
  });
  req.on('timeout', () => { req.destroy(); console.log('[2] HTTPS via proxy: TIMEOUT'); process.exit(1); });
  req.on('error', e => { console.log('[2] HTTPS via proxy: ERROR', e.message); process.exit(1); });
  req.end();
}

setTimeout(() => { console.log('Global timeout'); process.exit(1); }, 20000);
