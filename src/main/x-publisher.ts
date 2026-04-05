/**
 * X (Twitter) API v2 client — publish tweets and fetch engagement metrics.
 * Uses OAuth 1.0a User Context authentication.
 */

import * as crypto from 'crypto';
import { getConfig } from './config';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TweetResult {
  success: boolean;
  tweetId?: string;
  postUrl?: string;
  error?: string;
}

export interface TweetEngagement {
  views: number;
  likes: number;
  retweets: number;
  replies: number;
  last_checked: string;
}

// ─── OAuth 1.0a Signature ────────────────────────────────────────────────────

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function buildAuthHeader(
  method: string,
  url: string,
  consumerKey: string,
  consumerSecret: string,
  accessToken: string,
  accessTokenSecret: string,
  extraParams?: Record<string, string>,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: '1.0',
    ...extraParams,
  };

  const allParams = { ...oauthParams };
  oauthParams.oauth_signature = generateOAuthSignature(
    method,
    url,
    allParams,
    consumerSecret,
    accessTokenSecret,
  );

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');
  return `OAuth ${headerParts}`;
}

// ─── API Functions ───────────────────────────────────────────────────────────

function getCredentials(): {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
} {
  const config = getConfig();
  return {
    consumerKey: (config as any).xApiKey ?? '',
    consumerSecret: (config as any).xApiSecret ?? '',
    accessToken: (config as any).xAccessToken ?? '',
    accessTokenSecret: (config as any).xAccessTokenSecret ?? '',
  };
}

function hasCredentials(): boolean {
  const creds = getCredentials();
  return !!(
    creds.consumerKey &&
    creds.consumerSecret &&
    creds.accessToken &&
    creds.accessTokenSecret
  );
}

/**
 * Publish a tweet to X.
 */
export async function publishTweet(text: string): Promise<TweetResult> {
  if (!hasCredentials()) {
    return { success: false, error: 'X API credentials not configured. Add them in Settings.' };
  }

  const creds = getCredentials();
  const url = 'https://api.x.com/2/tweets';
  const method = 'POST';
  const authHeader = buildAuthHeader(
    method,
    url,
    creds.consumerKey,
    creds.consumerSecret,
    creds.accessToken,
    creds.accessTokenSecret,
  );

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[x-publisher] POST /2/tweets failed (${res.status}):`, body);
      return { success: false, error: `X API ${res.status}: ${body}` };
    }

    const data = await res.json();
    const tweetId = data.data?.id;
    return {
      success: true,
      tweetId,
      postUrl: tweetId ? `https://x.com/AILifeHacks7/status/${tweetId}` : undefined,
    };
  } catch (e: unknown) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Fetch engagement metrics for a tweet by ID.
 */
export async function getTweetEngagement(tweetId: string): Promise<TweetEngagement | null> {
  if (!hasCredentials()) return null;

  const creds = getCredentials();
  const url = `https://api.x.com/2/tweets/${tweetId}?tweet.fields=public_metrics`;
  const method = 'GET';
  const authHeader = buildAuthHeader(
    method,
    url.split('?')[0],
    creds.consumerKey,
    creds.consumerSecret,
    creds.accessToken,
    creds.accessTokenSecret,
  );

  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: authHeader },
    });

    if (!res.ok) {
      console.error(`[x-publisher] GET tweet ${tweetId} failed (${res.status})`);
      return null;
    }

    const data = await res.json();
    const metrics = data.data?.public_metrics;
    if (!metrics) return null;

    return {
      views: metrics.impression_count ?? 0,
      likes: metrics.like_count ?? 0,
      retweets: metrics.retweet_count ?? 0,
      replies: metrics.reply_count ?? 0,
      last_checked: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
