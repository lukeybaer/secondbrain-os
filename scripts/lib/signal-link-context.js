'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { uploadFile: defaultUploadFile } = require('./cloud-archive.js');
const { transcribeTelegramVoiceAudio } = require('./telegram-voice-transcriber.js');

const ARCHIVE_PREFIX = 'data-lake/secondbrain/life-archive/data/signal/raw';
const DEFAULT_FETCH_BYTES = 5 * 1024 * 1024;
const DEFAULT_MEDIA_BYTES = 250 * 1024 * 1024;
const MEDIA_HOSTS = new Set([
  'instagram.com',
  'tiktok.com',
  'twitter.com',
  'vimeo.com',
  'www.instagram.com',
  'www.tiktok.com',
  'www.youtube.com',
  'x.com',
  'youtu.be',
  'youtube.com',
]);

class SignalLinkSourceLimitationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SignalLinkSourceLimitationError';
    this.code = 'SIGNAL_LINK_SOURCE_LIMITATION';
    this.sourceLimitation = true;
    if (cause) this.cause = cause;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function extractUrls(text) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
  const unique = [];
  for (const raw of found) {
    const cleaned = raw.replace(/[),.;:!?\]}]+$/g, '');
    try {
      const parsed = new URL(cleaned);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      const value = parsed.toString();
      if (!unique.includes(value)) unique.push(value);
    } catch {
      // Malformed message text is not a URL obligation.
    }
  }
  return unique;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function metaContent(html, matcher) {
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const property = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!matcher.test(property)) continue;
    const content = tag.match(/content\s*=\s*["']([\s\S]*?)["']/i)?.[1] || '';
    if (content) return decodeHtml(content).trim();
  }
  return '';
}

function htmlContext(html) {
  const raw = String(html || '');
  const title =
    metaContent(raw, /^og:title$/i) ||
    decodeHtml(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const description =
    metaContent(raw, /^(?:og:description|twitter:description|description)$/i) || '';
  const canonicalUrl =
    decodeHtml(
      raw.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)/i)?.[1] ||
        raw.match(/<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']canonical/i)?.[1] ||
        '',
    ).trim();
  const excerpt = decodeHtml(
    raw
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20_000);
  const mediaExpected = /(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player)["']|video\.twimg\.com/i.test(raw);
  return {
    title: title.slice(0, 1000),
    description: description.slice(0, 4000),
    canonicalUrl,
    excerpt,
    mediaExpected,
  };
}

function assertPublicHttpUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SignalLinkSourceLimitationError('Only HTTP(S) shared links are supported');
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
  ) {
    // A private/LAN URL is a permanent source limitation from the cloud host,
    // not transient network work. Keep the SSRF guard intact and let the
    // caller archive an explicit limitation receipt instead of retrying it
    // forever and blocking every downstream event stage.
    throw new SignalLinkSourceLimitationError(`Shared link host is not public: ${host}`);
  }
  return url;
}

async function fetchSharedUrl(rawUrl, options = {}) {
  const url = assertPublicHttpUrl(rawUrl);
  const timeoutMs = Number(options.timeoutMs || 20_000);
  const maxBytes = Number(options.maxBytes || DEFAULT_FETCH_BYTES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await (options.fetchFn || global.fetch)(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
          'User-Agent': 'Amy-Signal-Link-Context/1.0',
        },
      });
    } catch (error) {
      throw new SignalLinkSourceLimitationError(
        `Shared link source unavailable: ${String(error?.message || error || 'fetch failed')}`,
        error,
      );
    }
    if (!response.ok) {
      throw new SignalLinkSourceLimitationError(`Shared link HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error(`Shared link body exceeds ${maxBytes} bytes`);
    let body;
    try {
      body = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new SignalLinkSourceLimitationError(
        `Shared link response unavailable: ${String(error?.message || error || 'read failed')}`,
        error,
      );
    }
    if (body.length > maxBytes) throw new Error(`Shared link body exceeds ${maxBytes} bytes`);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    const textLike = /^(?:text\/|application\/(?:json|xhtml\+xml))/.test(contentType);
    const text = textLike ? body.toString('utf8') : '';
    const parsed = /html|xhtml/.test(contentType) ? htmlContext(text) : {};
    return {
      url: rawUrl,
      finalUrl: response.url || rawUrl,
      statusCode: response.status,
      contentType,
      bytes: body.length,
      sha256: sha256(body),
      body,
      title: parsed.title || '',
      description: parsed.description || '',
      canonicalUrl: parsed.canonicalUrl || response.url || rawUrl,
      excerpt: parsed.excerpt || text.replace(/\s+/g, ' ').trim().slice(0, 20_000),
      mediaExpected: Boolean(parsed.mediaExpected),
    };
  } finally {
    clearTimeout(timer);
  }
}

function pythonCommand(env = process.env) {
  return env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
}

function ytDlpBaseArgs(url, env = process.env) {
  const args = ['-m', 'yt_dlp', '--no-playlist'];
  const cookies = env.YT_DLP_COOKIES || '/opt/secondbrain/.yt-dlp-cookies.txt';
  if (fs.existsSync(cookies)) args.push('--cookies', cookies);
  if (/youtu(?:\.be|be\.com)/i.test(url)) {
    const provider = env.YT_DLP_POT_PROVIDER || 'http://127.0.0.1:4416';
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${provider}`);
  }
  return args;
}

function parseYtDlpJson(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // yt-dlp may emit notices before the JSON line.
    }
  }
  throw new Error('yt-dlp returned no metadata JSON');
}

const YT_DLP_AUTH_PATTERN = /sign in to confirm|not a bot|cookies.*authentication|authentication.*required|login.*required|please login|use --cookies/i;

function runYtDlp(command, args, options = {}) {
  const result = (options.spawn || spawnSync)(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: Number(options.timeoutMs || 180_000),
    env: options.env || process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const msg = String(result.stderr || result.stdout || `yt-dlp exit ${result.status}`).slice(0, 1000);
    if (YT_DLP_AUTH_PATTERN.test(msg)) {
      throw new SignalLinkSourceLimitationError(`Shared media source requires authentication: ${msg}`);
    }
    throw new Error(msg);
  }
  return result;
}

function findDownloadedMedia(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).isFile())
    .filter((file) => !/\.(?:json|part|ytdl)$/i.test(file))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] || null;
}

async function resolveMediaContext(url, dir, options = {}) {
  const host = new URL(url).hostname.toLowerCase();
  if (!MEDIA_HOSTS.has(host)) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = options.env || process.env;
  const command = options.python || pythonCommand(env);
  const metadataRun = runYtDlp(
    command,
    [...ytDlpBaseArgs(url, env), '--dump-single-json', '--skip-download', url],
    { ...options, env },
  );
  const metadata = parseYtDlpJson(metadataRun.stdout);
  const metadataFile = path.join(dir, 'media-metadata.json');
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

  const maxBytes = Number(options.maxMediaBytes || DEFAULT_MEDIA_BYTES);
  const outputTemplate = path.join(dir, 'media.%(ext)s');
  runYtDlp(
    command,
    [
      ...ytDlpBaseArgs(url, env),
      '--max-filesize',
      String(maxBytes),
      '-f',
      'bestaudio/best',
      '-o',
      outputTemplate,
      url,
    ],
    { ...options, env, timeoutMs: options.mediaTimeoutMs || 10 * 60 * 1000 },
  );
  const mediaFile = findDownloadedMedia(dir);
  if (!mediaFile) throw new Error('yt-dlp produced metadata but no media file');
  if (fs.statSync(mediaFile).size > maxBytes) throw new Error(`Shared media exceeds ${maxBytes} bytes`);
  const transcript = await Promise.resolve(
    (options.transcribe || transcribeTelegramVoiceAudio)(mediaFile, {
      env,
      repoRoot: options.repoRoot,
      timeoutMs: options.transcribeTimeoutMs || 15 * 60 * 1000,
    }),
  );
  const transcriptFile = path.join(dir, 'transcript.txt');
  fs.writeFileSync(transcriptFile, `${String(transcript || '').trim()}\n`, { mode: 0o600 });
  return {
    metadata: {
      id: metadata.id || null,
      title: metadata.title || '',
      description: metadata.description || '',
      uploader: metadata.uploader || metadata.channel || '',
      duration: Number.isFinite(Number(metadata.duration)) ? Number(metadata.duration) : null,
      webpageUrl: metadata.webpage_url || url,
    },
    metadataFile,
    mediaFile,
    transcriptFile,
    transcript: String(transcript || '').trim(),
  };
}

function linkArchiveKey(normalized, linkId, fileName) {
  const date = normalized.referenceTime.slice(0, 10).replace(/-/g, '/');
  return `${ARCHIVE_PREFIX}/${date}/${normalized.id}/links/${linkId}/${path.basename(fileName)}`;
}

function archiveArtifact(file, normalized, linkId, options = {}) {
  return (options.uploadFile || defaultUploadFile)(file, {
    env: options.env || process.env,
    key: linkArchiveKey(normalized, linkId, path.basename(file)),
    requireChecksumSha256: true,
    allowSensitive: true,
  });
}

function removeVerifiedArtifact(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // The next cleanup pass may remove a verified derived file.
  }
}

async function resolveAndArchiveLinks({ normalized, eventDir, ...options }) {
  const urls = Array.isArray(normalized.links) ? normalized.links : extractUrls(normalized.text);
  const root = path.join(eventDir, 'links');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const resolvedLinks = [];
  for (const url of urls) {
    const linkId = sha256(url).slice(0, 16);
    const dir = path.join(root, linkId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let fetched = null;
    let fetchError = '';
    let fetchSourceLimitation = null;
    try {
      fetched = await (options.fetchSharedUrl || fetchSharedUrl)(url, options);
    } catch (error) {
      fetchError = String(error.message || error);
      if (error?.sourceLimitation === true) fetchSourceLimitation = error;
    }
    const media = await Promise.resolve((options.mediaResolver || resolveMediaContext)(url, dir, options)).catch(
      (error) => {
        if (!fetched) throw error;
        return { error: String(error.message || error), sourceLimitation: Boolean(error.sourceLimitation) };
      },
    );
    if (fetched?.mediaExpected && media?.error && !media.sourceLimitation) {
      throw new Error(`Shared media context is incomplete: ${media.error}`);
    }
    if (!fetched && !media && !fetchSourceLimitation) {
      throw new Error(`Shared link could not be resolved: ${fetchError || url}`);
    }

    const archived = {};
    let pageFile = '';
    if (fetched) {
      const extension = /html/.test(fetched.contentType) ? '.html' : /json/.test(fetched.contentType) ? '.json' : '.bin';
      pageFile = path.join(dir, `page${extension}`);
      fs.writeFileSync(pageFile, fetched.body, { mode: 0o600 });
      archived.page = archiveArtifact(pageFile, normalized, linkId, options);
    }
    if (media && !media.error) {
      archived.mediaMetadata = archiveArtifact(media.metadataFile, normalized, linkId, options);
      archived.media = archiveArtifact(media.mediaFile, normalized, linkId, options);
      archived.transcript = archiveArtifact(media.transcriptFile, normalized, linkId, options);
    }
    const mediaMetadata = media && !media.error ? media.metadata : {};
    resolvedLinks.push({
      id: linkId,
      url,
      canonicalUrl: fetched?.canonicalUrl || mediaMetadata.webpageUrl || url,
      title: fetched?.title || mediaMetadata.title || '',
      description: fetched?.description || mediaMetadata.description || '',
      excerpt: fetched?.excerpt || '',
      transcript: media && !media.error ? media.transcript : '',
      media: mediaMetadata,
      fetchedAt: new Date().toISOString(),
      contentType: fetched?.contentType || '',
      pageSha256: fetched?.sha256 || null,
      pageBytes: fetched?.bytes ?? null,
      archive: archived,
      ...(fetchSourceLimitation
        ? {
            sourceLimitation: {
              code: fetchSourceLimitation.code || 'SIGNAL_LINK_SOURCE_LIMITATION',
              terminal: true,
              reason: fetchError,
            },
          }
        : {}),
      ...(media?.error ? { mediaResolutionWarning: media.error } : {}),
    });
    removeVerifiedArtifact(pageFile);
    if (media && !media.error) {
      removeVerifiedArtifact(media.metadataFile);
      removeVerifiedArtifact(media.mediaFile);
      removeVerifiedArtifact(media.transcriptFile);
    }
  }
  const context = {
    schema: 'amy.signal.link-context.v1',
    status: 'verified',
    eventId: normalized.id,
    generatedAt: new Date().toISOString(),
    links: resolvedLinks,
  };
  const manifestFile = path.join(root, 'context.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  const manifest = (options.uploadFile || defaultUploadFile)(manifestFile, {
    env: options.env || process.env,
    key: linkArchiveKey(normalized, 'manifest', 'context.json'),
    requireChecksumSha256: true,
    allowSensitive: true,
  });
  return { ...context, archive: { manifest } };
}

function citationBody(normalized, link) {
  return [
    `Context for a link shared in Signal ${normalized.direction} message ${normalized.id} at ${normalized.referenceTime}.`,
    `Original URL: ${link.url}`,
    link.canonicalUrl && link.canonicalUrl !== link.url ? `Canonical URL: ${link.canonicalUrl}` : '',
    link.title ? `Title: ${link.title}` : '',
    link.description ? `Description: ${link.description}` : '',
    link.excerpt ? `Page context: ${String(link.excerpt).slice(0, 8000)}` : '',
    link.transcript ? `Media transcript: ${String(link.transcript).slice(0, 12000)}` : '',
    link.sourceLimitation?.terminal === true
      ? `Source limitation: ${String(link.sourceLimitation.reason || 'The shared source was not reachable from the cloud host.').slice(0, 1000)}`
      : '',
    `Permanent cited-context archive: ${link.archive?.media?.s3Uri || link.archive?.page?.s3Uri || 'manifest archived with the Signal event'}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  ARCHIVE_PREFIX,
  DEFAULT_FETCH_BYTES,
  DEFAULT_MEDIA_BYTES,
  MEDIA_HOSTS,
  YT_DLP_AUTH_PATTERN,
  assertPublicHttpUrl,
  citationBody,
  extractUrls,
  fetchSharedUrl,
  htmlContext,
  linkArchiveKey,
  resolveAndArchiveLinks,
  resolveMediaContext,
  runYtDlp,
  SignalLinkSourceLimitationError,
  sha256,
};
