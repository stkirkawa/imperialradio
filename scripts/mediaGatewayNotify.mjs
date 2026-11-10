const action = process.argv[2];
const mediaPath = process.env.MTX_PATH;

if (!['ready', 'not-ready'].includes(action) || !/^dj-[A-Za-z0-9_-]{20,64}$/.test(mediaPath || '')) {
  process.exitCode = 1;
} else {
  const endpoint = process.env.IMPERIALRADIO_APP_URL || 'http://127.0.0.1:3000';
  const response = await fetch(`${endpoint.replace(/\/+$/, '')}/api/ingest/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, path: mediaPath }),
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) {
    console.error(`Media relay notification failed: HTTP ${response.status}`);
    process.exitCode = 1;
  }
}
