"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const crypto = require("crypto");
const index = require("./index.js");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const crypto__namespace = /* @__PURE__ */ _interopNamespaceDefault(crypto);
function percentEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
function generateOAuthSignature(method, url, params, consumerSecret, tokenSecret) {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys.map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join("&");
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto__namespace.createHmac("sha1", signingKey).update(baseString).digest("base64");
}
function buildAuthHeader(method, url, consumerKey, consumerSecret, accessToken, accessTokenSecret, extraParams) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto__namespace.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1e3).toString(),
    oauth_token: accessToken,
    oauth_version: "1.0",
    ...extraParams
  };
  const allParams = { ...oauthParams };
  oauthParams.oauth_signature = generateOAuthSignature(
    method,
    url,
    allParams,
    consumerSecret,
    accessTokenSecret
  );
  const headerParts = Object.keys(oauthParams).sort().map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(", ");
  return `OAuth ${headerParts}`;
}
function getCredentials() {
  const config = index.getConfig();
  return {
    consumerKey: config.xApiKey ?? "",
    consumerSecret: config.xApiSecret ?? "",
    accessToken: config.xAccessToken ?? "",
    accessTokenSecret: config.xAccessTokenSecret ?? ""
  };
}
function hasCredentials() {
  const creds = getCredentials();
  return !!(creds.consumerKey && creds.consumerSecret && creds.accessToken && creds.accessTokenSecret);
}
async function publishTweet(text) {
  if (!hasCredentials()) {
    return { success: false, error: "X API credentials not configured. Add them in Settings." };
  }
  const creds = getCredentials();
  const url = "https://api.x.com/2/tweets";
  const method = "POST";
  const authHeader = buildAuthHeader(
    method,
    url,
    creds.consumerKey,
    creds.consumerSecret,
    creds.accessToken,
    creds.accessTokenSecret
  );
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
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
      postUrl: tweetId ? `https://x.com/Channel17/status/${tweetId}` : void 0
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
async function getTweetEngagement(tweetId) {
  if (!hasCredentials()) return null;
  const creds = getCredentials();
  const url = `https://api.x.com/2/tweets/${tweetId}?tweet.fields=public_metrics`;
  const method = "GET";
  const authHeader = buildAuthHeader(
    method,
    url.split("?")[0],
    creds.consumerKey,
    creds.consumerSecret,
    creds.accessToken,
    creds.accessTokenSecret
  );
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: authHeader }
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
      last_checked: (/* @__PURE__ */ new Date()).toISOString()
    };
  } catch {
    return null;
  }
}
exports.getTweetEngagement = getTweetEngagement;
exports.publishTweet = publishTweet;
