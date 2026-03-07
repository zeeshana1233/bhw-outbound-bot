// Quick Telegram connectivity test — node test-tg.js
import https from 'https';
import net from 'net';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8784111112:AAF_HiA_E9-FgFy5qG3aMtR-m7JBSRzNZwI';
const KNOWN_IP = '149.154.166.110';

console.log('--- Telegram connectivity test ---');

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
  // Test 2: HTTPS via direct IP (bypassing DNS/SNI issues)
  const options = {
    hostname: KNOWN_IP,
    port: 443,
    path: `/bot${TOKEN}/getMe`,
    method: 'GET',
    rejectUnauthorized: false, // skip cert validation for direct-IP call
    timeout: 8000,
  };
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('[2] HTTPS direct IP: OK', data.slice(0, 120));
      runTest3();
    });
  });
  req.on('timeout', () => { req.destroy(); console.log('[2] HTTPS direct IP: TIMEOUT'); runTest3(); });
  req.on('error', e => { console.log('[2] HTTPS direct IP: ERROR', e.message); runTest3(); });
  req.end();
}

function runTest3() {
  // Test 3: HTTPS via hostname
  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TOKEN}/getMe`,
    method: 'GET',
    timeout: 8000,
  };
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('[3] HTTPS hostname: OK', data.slice(0, 120));
      process.exit(0);
    });
  });
  req.on('timeout', () => { req.destroy(); console.log('[3] HTTPS hostname: TIMEOUT'); process.exit(1); });
  req.on('error', e => { console.log('[3] HTTPS hostname: ERROR', e.message); process.exit(1); });
  req.end();
}

setTimeout(() => { console.log('Global timeout'); process.exit(1); }, 20000);
