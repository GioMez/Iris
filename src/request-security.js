const { isIP } = require("node:net");

// Use the wire fields: Node coalesces some duplicates and discards others (Host,
// Content-Type). Even identical repeated singletons are ambiguous for admission.
function singletonHeader(req, name) {
  let value;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() !== name) continue;
    if (value !== undefined) throw new Error(`Repeated ${name}`);
    value = req.rawHeaders[i + 1];
  }
  return value;
}

function validateAuthority(value) {
  if (typeof value !== "string" || !value || /[\s\x00-\x1f\x7f\\/@?#%,]/u.test(value)) {
    throw new Error("Invalid authority");
  }
  const parts = value.startsWith("[")
    ? value.match(/^\[([^\]]+)\](?::([0-9]+))?$/)
    : value.match(/^([^:\[\]]+)(?::([0-9]+))?$/);
  if (!parts || (value.startsWith("[") && isIP(parts[1]) !== 6)
    || (parts[2] !== undefined && Number(parts[2]) > 65535)) {
    throw new Error("Invalid authority");
  }
  // Only normalize after rejecting credentials, repaired paths/whitespace,
  // escaped hosts, unbracketed IPv6 and empty/invalid ports.
  const url = new URL(`http://${value}`);
  // WHATWG drops an IPv4 terminal dot, including on short numeric spellings.
  // Check the raw host before that normalized identity can be used for admission.
  if (parts[1].endsWith(".") && isIP(url.hostname) === 4) throw new Error("Invalid IPv4 authority");
  return value;
}

function requestAuthority(req) {
  return validateAuthority(singletonHeader(req, "host"));
}

function parseHttpUrl(value, originOnly = false) {
  if (typeof value !== "string" || /[\s\x00-\x1f\x7f\\]/u.test(value)) throw new Error("Invalid HTTP URL");
  const parts = value.match(/^https?:\/\/([^/?#]+)(.*)$/i);
  if (!parts || (originOnly && parts[2])) throw new Error("Invalid HTTP URL");
  validateAuthority(parts[1]);
  return new URL(value);
}

function parseAppBaseUrl(value = "") {
  if (value === "") return "";
  try {
    const url = parseHttpUrl(value);
    if (/[?#]/.test(value)) throw new Error("Query or fragment");
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new Error("APP_BASE_URL must be an absolute, credential-free HTTP(S) base URL without a query or fragment");
  }
}

// appBaseUrl has already passed startup validation. A pin takes precedence over
// forwarding; otherwise each missing proxy component falls back independently.
function requestOrigin(req, { appBaseUrl = "", trustProxy = false } = {}) {
  if (appBaseUrl) return new URL(appBaseUrl).origin;
  let authority = requestAuthority(req);
  let scheme = req.socket.encrypted ? "https" : "http";
  if (trustProxy) {
    const host = singletonHeader(req, "x-forwarded-host");
    const proto = singletonHeader(req, "x-forwarded-proto");
    if (host !== undefined) authority = validateAuthority(host);
    if (proto !== undefined) {
      if (!/^https?$/i.test(proto)) throw new Error("Invalid forwarded protocol");
      scheme = proto.toLowerCase();
    }
  }
  return new URL(`${scheme}://${authority}`).origin;
}

function isRequestOriginAllowed(req, options) {
  try {
    const expected = requestOrigin(req, options);
    const origin = singletonHeader(req, "origin");
    if (origin !== undefined) return parseHttpUrl(origin, true).origin === expected;

    const site = singletonHeader(req, "sec-fetch-site");
    if (site !== undefined && site !== "same-origin" && site !== "none") return false;
    const referer = singletonHeader(req, "referer");
    if (referer !== undefined) return parseHttpUrl(referer).origin === expected;

    // Metadata-free native clients remain compatible; authentication is still
    // required by their routes. Fetch-Site:none alone is not same-origin proof.
    return site === undefined || site === "same-origin";
  } catch {
    return false;
  }
}

function isJsonMediaAllowed(req) {
  try {
    const type = singletonHeader(req, "content-type");
    if (type !== undefined) {
      return !/[\r\n]/.test(type)
        && /^[ \t]*application\/json[ \t]*(?:;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8")[ \t]*)?$/i.test(type);
    }
    const length = req.headers["content-length"];
    return req.headers["transfer-encoding"] === undefined && (length === undefined || /^0+$/.test(length));
  } catch {
    return false;
  }
}

module.exports = { parseAppBaseUrl, requestAuthority, requestOrigin, isRequestOriginAllowed, isJsonMediaAllowed };
