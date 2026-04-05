const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost';
const SCOPES =
  'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/' || parsed.pathname === '/start') {
    const authUrl =
      'https://accounts.google.com/o/oauth2/auth?client_id=' +
      CLIENT_ID +
      '&redirect_uri=' +
      encodeURIComponent(REDIRECT_URI) +
      '&response_type=code&scope=' +
      encodeURIComponent(SCOPES) +
      '&access_type=offline&prompt=consent';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<html><body style="background:#111;color:#eee;font-family:system-ui;padding:40px">' +
        '<h1>YouTube OAuth Setup</h1>' +
        '<p>Click the link below. After authorizing, Google will redirect to localhost which will fail.</p>' +
        '<p>Copy the <b>code</b> parameter from the URL bar and paste it in the form below.</p>' +
        '<p><a href="' +
        authUrl +
        '" style="color:#60a5fa;font-size:18px">Authorize YouTube Access</a></p>' +
        '<hr style="border-color:#333">' +
        '<form method="GET" action="/exchange">' +
        '<label>Paste the code from the URL:</label><br>' +
        '<input name="code" style="width:600px;padding:8px;margin:8px 0;background:#222;color:#eee;border:1px solid #444" placeholder="4/0A..."><br>' +
        '<label>Channel:</label><br>' +
        '<select name="channel" style="padding:8px;margin:8px 0;background:#222;color:#eee;border:1px solid #444">' +
        '<option value="AILifeHacks">AILifeHacks</option>' +
        '<option value="BedtimeStories">BedtimeStories</option></select><br><br>' +
        '<button type="submit" style="padding:10px 20px;background:#1a3a5a;color:#fff;border:none;cursor:pointer;font-size:16px">Exchange Code for Token</button>' +
        '</form></body></html>',
    );
    return;
  }

  if (parsed.pathname === '/exchange') {
    const code = parsed.query.code;
    const channel = parsed.query.channel || 'AILifeHacks';
    if (!code) {
      res.writeHead(400);
      res.end('No code provided');
      return;
    }

    const body =
      'code=' +
      encodeURIComponent(code) +
      '&client_id=' +
      encodeURIComponent(CLIENT_ID) +
      '&client_secret=' +
      encodeURIComponent(CLIENT_SECRET) +
      '&redirect_uri=' +
      encodeURIComponent(REDIRECT_URI) +
      '&grant_type=authorization_code';

    try {
      const tokenRes = await new Promise((resolve, reject) => {
        const r = https.request(
          'https://oauth2.googleapis.com/token',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (resp) => {
            let d = '';
            resp.on('data', (c) => (d += c));
            resp.on('end', () => resolve(JSON.parse(d)));
          },
        );
        r.on('error', reject);
        r.write(body);
        r.end();
      });

      fs.writeFileSync(
        '/opt/secondbrain/data/youtube/' + channel + '_token.json',
        JSON.stringify(tokenRes, null, 2),
      );
      console.log('TOKEN for ' + channel + ':', JSON.stringify(tokenRes));

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body style="background:#111;color:#eee;font-family:system-ui;padding:40px">' +
          '<h1>Success! Token saved for ' +
          channel +
          '</h1>' +
          '<pre style="background:#1a1a1a;padding:16px;border-radius:8px;overflow:auto">' +
          JSON.stringify(tokenRes, null, 2) +
          '</pre>' +
          '<p>Go back to <a href="/" style="color:#60a5fa">authorize another channel</a></p></body></html>',
      );
    } catch (e) {
      res.writeHead(500);
      res.end('Token exchange failed: ' + e.message);
    }
    return;
  }

  if (parsed.pathname === '/oauth2callback') {
    const code = parsed.query.code;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<html><body style="background:#111;color:#eee;font-family:system-ui;padding:40px">' +
        '<h1>Got the code!</h1><p>Code: <code>' +
        code +
        '</code></p>' +
        '<p>Go back to the auth page and paste this code.</p></body></html>',
    );
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(8888, () => {
  console.log('YouTube OAuth server on port 8888');
  console.log('Visit: http://98.80.164.16:8888/');
});
