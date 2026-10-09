import smCrypto from "sm-crypto";

const username = process.env.DDL_LEARN_USER;
const password = process.env.DDL_LEARN_PASSWORD;
const startUrl = "https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/bb5df85216504820be7bba2b0ae1535b/0";

if (!username || !password) {
  throw new Error("DDL_LEARN_USER and DDL_LEARN_PASSWORD are required");
}

const cookies = [];

function storeCookies(response, requestUrl) {
  const hostname = new URL(requestUrl).hostname;
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const parts = raw.split(";").map((part) => part.trim());
    const [nameValue, ...attributes] = parts;
    const separator = nameValue.indexOf("=");
    if (separator < 1) continue;
    const name = nameValue.slice(0, separator);
    const value = nameValue.slice(separator + 1);
    let domain = hostname;
    let hostOnly = true;
    let path = "/";
    let secure = false;
    for (const attribute of attributes) {
      const [key, attributeValue = ""] = attribute.split("=");
      if (key.toLowerCase() === "domain") {
        domain = attributeValue.replace(/^\./, "").toLowerCase();
        hostOnly = false;
      } else if (key.toLowerCase() === "path") {
        path = attributeValue || "/";
      } else if (key.toLowerCase() === "secure") {
        secure = true;
      }
    }
    const existing = cookies.findIndex((cookie) => cookie.name === name && cookie.domain === domain && cookie.path === path);
    const next = { name, value, domain, hostOnly, path, secure };
    if (existing >= 0) cookies[existing] = next;
    else cookies.push(next);
  }
}

function cookieHeader(url) {
  const parsed = new URL(url);
  return cookies
    .filter((cookie) => {
      const domainMatches = cookie.hostOnly
        ? parsed.hostname === cookie.domain
        : parsed.hostname === cookie.domain || parsed.hostname.endsWith(`.${cookie.domain}`);
      return domainMatches && parsed.pathname.startsWith(cookie.path) && (!cookie.secure || parsed.protocol === "https:");
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const cookie = cookieHeader(url);
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(url, { ...options, headers, redirect: "manual" });
  storeCookies(response, url);
  return response;
}

async function follow(response, requestUrl, maxRedirects = 10) {
  let current = response;
  let currentUrl = requestUrl;
  for (let count = 0; count < maxRedirects && current.status >= 300 && current.status < 400; count += 1) {
    const location = current.headers.get("location");
    if (!location) break;
    currentUrl = new URL(location, currentUrl).toString();
    current = await request(currentUrl);
  }
  return { response: current, url: currentUrl };
}

const loginPage = await request(startUrl);
const html = await loginPage.text();
const publicKey = html.match(/id=["']sm2publicKey["'][^>]*>([0-9a-f]+)</i)?.[1];
if (!publicKey) throw new Error("SM2 public key not found");

const encryptedPassword = `04${smCrypto.sm2.doEncrypt(password, publicKey, 1)}`;
const form = new URLSearchParams({
  i_user: username,
  i_pass: encryptedPassword,
  singleLogin: "on",
  fingerPrint: "",
  fingerGenPrint: "",
  fingerGenPrint3: "",
  deviceName: "Edge",
  i_captcha: "",
});

const loginResponse = await request("https://id.tsinghua.edu.cn/do/off/ui/auth/login/check", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form,
});
const result = await follow(loginResponse, "https://id.tsinghua.edu.cn/do/off/ui/auth/login/check");
const resultHtml = await result.response.text();
const title = resultHtml.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
const captchaRequired = !/id=["']c_code["'][^>]*class=["'][^"']*hidden/i.test(resultHtml) && /i_captcha/.test(resultHtml);
const loggedIn = result.url.startsWith("https://learn.tsinghua.edu.cn/") && !result.url.includes("/f/login");
const twoFactorRequired = /<title>\s*二次认证\s*<\/title>/i.test(resultHtml) || /二次认证/.test(title);
const authOptions = {
  sms: /短信|手机验证码/.test(resultHtml),
  email: /邮箱验证码|邮件验证码/.test(resultHtml),
  otp: /动态口令|OTP/i.test(resultHtml),
  qrCode: /二维码|扫码/.test(resultHtml),
  trustedDevice: /信任.*(?:设备|浏览器)|(?:设备|浏览器).*信任/.test(resultHtml),
};
const authLabels = [...resultHtml.matchAll(/<(?:button|label|a|h[1-4]|p|span)[^>]*>([\s\S]*?)<\/(?:button|label|a|h[1-4]|p|span)>/gi)]
  .map((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
  .filter((text) => text.length > 0 && text.length < 80 && /(验证|认证|口令|扫码|微信|手机|邮件|安全|登录|设备|浏览器)/.test(text))
  .map((text) => text.replace(/[\w.+-]+@[\w.-]+/g, "[email]").replace(/\d{3,}/g, "[number]"))
  .filter((text, index, list) => list.indexOf(text) === index)
  .slice(0, 20);
const scriptSources = [...resultHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
  .map((match) => match[1])
  .slice(-12);
const authProfile = {
  phoneAvailable: /["']?phone["']?\s*:\s*["'][^"']+["']/.test(resultHtml),
  weChatAvailable: /["']?hasWeChatBool["']?\s*:\s*(?:true|1)/i.test(resultHtml),
  totpAvailable: /["']?hasTotp["']?\s*:\s*(?:true|1)/i.test(resultHtml),
};
let challengeSummary = null;
if (twoFactorRequired) {
  const challengeResponse = await request("https://id.tsinghua.edu.cn/b/doubleAuth/login", { method: "POST" });
  const challengeText = await challengeResponse.text();
  try {
    const challenge = JSON.parse(challengeText);
    const object = challenge.object ?? challenge.data ?? {};
    challengeSummary = {
      status: challengeResponse.status,
      topLevelFields: Object.keys(challenge).filter((key) => !/phone|email|name|user/i.test(key)).slice(0, 20),
      resultType: Array.isArray(challenge) ? "array" : typeof challenge,
      result: challenge.result ?? null,
      message: typeof challenge.msg === "string" ? challenge.msg.replace(/\d{3,}/g, "[number]") : null,
      flow: object.flow ?? null,
      phoneAvailable: Boolean(object.phone),
      weChatAvailable: Boolean(object.hasWeChatBool),
      totpAvailable: Boolean(object.hasTotp),
      fields: Object.keys(object).filter((key) => !/phone|email|name|user/i.test(key)).slice(0, 20),
    };
  } catch {
    challengeSummary = { status: challengeResponse.status, responseType: "non-json" };
  }
}
const errorMessage = resultHtml
  .match(/id=["']msg_note["'][^>]*>([\s\S]*?)<\//i)?.[1]
  ?.replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim() || null;

console.log(JSON.stringify({
  loggedIn,
  finalHost: new URL(result.url).hostname,
  finalPath: new URL(result.url).pathname,
  status: result.response.status,
  title,
  captchaRequired,
  twoFactorRequired,
  authOptions,
  authLabels,
  scriptSources,
  authProfile,
  challengeSummary,
  errorMessage,
}));

if (!loggedIn) process.exitCode = 1;
