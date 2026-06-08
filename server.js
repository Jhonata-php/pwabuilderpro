// Compatibilidade para dependências que esperam File global
if (typeof globalThis.File === 'undefined') {
  const { Blob } = require('buffer');
  class File extends Blob {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  }
  globalThis.File = File;
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const https = require('https');
const { version: APP_VERSION } = require('./package.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });
const upload = multer({ dest: './uploads/', limits: { fileSize: 20 * 1024 * 1024 } });
const publicDir = path.join(__dirname, 'public');

let currentBuildProcesses = [];
const GRADLE_PROPERTIES = [
  'org.gradle.jvmargs=-Xmx1024m',
  'org.gradle.daemon=false',
  'android.useAndroidX=true',
  'android.enableJetifier=true'
].join('\n') + '\n';

app.use(express.static(publicDir));
app.use(express.json({ limit: '20mb' }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'admin123';
const panelSessions = new Set();

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (String(username || '') === PANEL_USER && String(password || '') === PANEL_PASS) {
    const token = crypto.randomBytes(24).toString('hex');
    panelSessions.add(token);
    return res.json({ success: true, token, username: PANEL_USER });
  }
  res.status(401).json({ success: false, msg: 'Usuário ou senha inválidos.' });
});

function getPanelToken(req) {
  return req.headers['x-panel-token'] || req.query.token;
}

function requirePanelAuth(req, res, next) {
  const token = getPanelToken(req);
  if (token && panelSessions.has(String(token))) return next();
  return res.status(401).json({ success: false, msg: 'Sessão expirada. Faça login novamente.' });
}

app.get('/session', requirePanelAuth, (req, res) => {
  res.json({ success: true, version: APP_VERSION });
});


function cleanLogs(text) {
  return text.toString().replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-z]/g, '');
}

function emitLog(msg) {
  io.emit('log', msg);
}

function normalizeUrl(url) {
  if (!url) return '';
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function cleanHostFromUrl(url) {
  const normalized = normalizeUrl(url);
  return new URL(normalized).hostname;
}

function safePackageId(input, host) {
  let pkg = (input || '').trim();
  if (!pkg) pkg = `${host.split('.').reverse().join('.')}.app`;
  pkg = pkg.toLowerCase().replace(/[^a-z0-9_.]/g, '').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg)) {
    pkg = `br.com.needsolutions.${crypto.randomBytes(3).toString('hex')}`;
  }
  return pkg;
}


const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });
const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36 PWA-Builder-Pro',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/manifest+json,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
};

async function httpGetSmart(targetUrl, opts = {}) {
  return axios.get(targetUrl, {
    timeout: opts.timeout || 20000,
    maxRedirects: 8,
    validateStatus: s => s >= 200 && s < 500,
    responseType: opts.responseType || 'text',
    transformResponse: [data => data],
    headers: browserHeaders,
    httpsAgent: insecureHttpsAgent
  });
}

function tryParseJsonLoose(raw) {
  if (raw && typeof raw === 'object') return raw;
  let text = String(raw || '').trim();
  text = text.replace(/^\uFEFF/, '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  return JSON.parse(text);
}

function fallbackManifestData(inputUrl, warning = '') {
  const u = new URL(normalizeUrl(inputUrl));
  const host = u.hostname.replace(/^www\./, '');
  const label = host.split('.')[0] || 'App';
  const app = safeText(label.charAt(0).toUpperCase() + label.slice(1), 'App', 30);
  return {
    appName: app,
    shortName: safeLauncherName(app, 'App'),
    themeColor: '#000000',
    backgroundColor: '#ffffff',
    iconUrl: '',
    packageId: safePackageId('', host),
    startUrl: u.pathname && u.pathname !== '/' ? u.pathname : '/',
    description: '',
    display: 'standalone',
    orientation: 'portrait',
    iarc_rating_id: '',
    screenshots: [],
    manifestUrl: '',
    warning: warning || 'Não foi possível carregar o manifest. Dados básicos foram gerados pelo domínio.'
  };
}


function stripAccents(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function safeText(value, fallback = 'App', max = 60) {
  let out = stripAccents(value)
    .replace(/[–—]/g, '-')
    .replace(/[^a-zA-Z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) out = fallback;
  if (out.length > max) out = out.substring(0, max).trim();
  return out || fallback;
}

function safeLauncherName(value, fallback = 'App') {
  const cleaned = safeText(value, fallback, 40);
  // Bubblewrap/Android pode rejeitar nomes curtos grandes ou com caracteres especiais.
  // Usamos a primeira palavra ASCII com no máximo 12 caracteres para evitar loop no prompt "Short name".
  const first = cleaned.split(/[\s_-]+/).find(Boolean) || fallback;
  return safeText(first, fallback, 12).substring(0, 12) || fallback;
}

function findExistingPath(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return candidates.find(Boolean) || '';
}

function getJavaHome() {
  return findExistingPath([
    process.env.JAVA_HOME,
    '/usr/lib/jvm/java-17-openjdk-amd64',
    '/usr/lib/jvm/java-17-openjdk',
    '/usr/lib/jvm/default-java'
  ]);
}

function getAndroidSdkPath() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    '/opt/android-sdk',
    process.env.BUBBLEWRAP_ANDROID_SDK_HOME,
    '/root/.bubblewrap/android_sdk'
  ].filter(Boolean);

  // O Bubblewrap valida a raiz do SDK conferindo se existe tools/bin/sdkmanager.
  // Se usarmos apenas cmdline-tools/latest, ele fica perguntando o caminho em loop.
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'tools', 'bin', 'sdkmanager'))) return c;
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'))) return c;
  }
  return candidates[0] || '/opt/android-sdk';
}

function ensureBubblewrapConfig(javaHome, androidSdkPath) {
  const bwDir = path.join(process.env.HOME || '/root', '.bubblewrap');
  fs.mkdirSync(bwDir, { recursive: true });
  fs.writeFileSync(
    path.join(bwDir, 'config.json'),
    JSON.stringify({ jdkPath: javaHome, androidSdkPath }, null, 2) + '\n'
  );
}

function resolveCommandPath(cmd) {
  if (cmd !== 'bubblewrap') return cmd;
  return findExistingPath([
    path.join(process.cwd(), 'node_modules', '.bin', 'bubblewrap'),
    path.join(__dirname, 'node_modules', '.bin', 'bubblewrap'),
    '/app/node_modules/.bin/bubblewrap',
    cmd
  ]);
}

async function resolveWebManifestUrl(siteUrl) {
  const baseUrl = normalizeUrl(siteUrl);
  const u = new URL(baseUrl);
  const candidates = [];

  try {
    const htmlRes = await httpGetSmart(baseUrl);
    const contentType = String(htmlRes.headers['content-type'] || '');
    if (contentType.includes('application/manifest+json') || contentType.includes('application/json') || /manifest\.(webmanifest|json|php)$/i.test(u.pathname)) {
      try { tryParseJsonLoose(htmlRes.data); return baseUrl; } catch (_) {}
    }
    const $ = cheerio.load(String(htmlRes.data || ''));
    $('link[rel]').each((_, el) => {
      const rel = String($(el).attr('rel') || '').toLowerCase();
      const href = $(el).attr('href');
      if (href && rel.split(/\s+/).includes('manifest')) candidates.push(new URL(href, baseUrl).href);
    });
  } catch (e) {
    emitLog(`⚠️ Não foi possível ler o HTML para achar manifest: ${e.message}`);
  }

  const basePath = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/\/[^/]*$/, '/');
  candidates.push(new URL('manifest.webmanifest', `${u.origin}${basePath}`).href);
  candidates.push(new URL('manifest.json', `${u.origin}${basePath}`).href);
  candidates.push(new URL('manifest.php', `${u.origin}${basePath}`).href);
  candidates.push(new URL('/manifest.webmanifest', u.origin).href);
  candidates.push(new URL('/manifest.json', u.origin).href);
  candidates.push(new URL('/manifest.php', u.origin).href);

  for (const c of [...new Set(candidates)]) {
    try {
      const r = await httpGetSmart(c);
      if (r.status >= 400) continue;
      const manifest = tryParseJsonLoose(r.data);
      if (manifest && (manifest.name || manifest.short_name || manifest.start_url || manifest.icons)) return c;
    } catch (_) {}
  }
  // Retorna o candidato padrão para o Bubblewrap tentar, mas o fetch-manifest da UI não quebra.
  return candidates[0] || new URL('/manifest.webmanifest', baseUrl).href;
}

async function loadManifestFromUrl(manifestUrl) {
  const r = await httpGetSmart(manifestUrl);
  if (r.status >= 400) throw new Error(`Manifest HTTP ${r.status}: ${manifestUrl}`);
  return tryParseJsonLoose(r.data);
}

function absoluteUrlMaybe(src, base) {
  try { return new URL(src, base).href; } catch (_) { return ''; }
}

function buildCleanWebManifest({ originalManifest = {}, manifestUrl, siteUrl, appName, shortName, startUrl, themeColor, backgroundColor, displayMode, orientation, description, iconUrl, screenshots }) {
  const cleanName = safeText(appName || originalManifest.name || originalManifest.short_name || 'App', 'App', 45);
  const cleanShort = safeLauncherName(shortName || originalManifest.short_name || cleanName, cleanName.split(' ')[0] || 'App');
  const cleanStart = String(startUrl || originalManifest.start_url || '/').trim() || '/';
  const cleanScope = String(originalManifest.scope || cleanStart || '/').trim() || '/';
  let icons = [];
  if (iconUrl) {
    icons.push({ src: absoluteUrlMaybe(iconUrl, siteUrl), sizes: '512x512', type: 'image/png', purpose: 'any maskable' });
  } else if (Array.isArray(originalManifest.icons)) {
    icons = originalManifest.icons
      .filter(i => i && i.src)
      .map(i => ({
        src: absoluteUrlMaybe(i.src, manifestUrl || siteUrl),
        sizes: i.sizes || '512x512',
        type: i.type || 'image/png',
        purpose: i.purpose || 'any maskable'
      }))
      .filter(i => i.src);
  }
  let shots = [];
  const inputShots = screenshots ? (Array.isArray(screenshots) ? screenshots : [screenshots]) : [];
  if (inputShots.length) {
    shots = inputShots.filter(Boolean).map(u => ({ src: absoluteUrlMaybe(u, siteUrl), sizes: '1080x1920', type: 'image/png' })).filter(s => s.src);
  } else if (Array.isArray(originalManifest.screenshots)) {
    shots = originalManifest.screenshots.map(s => {
      const src = typeof s === 'string' ? s : s && s.src;
      return src ? { src: absoluteUrlMaybe(src, manifestUrl || siteUrl), sizes: (s && s.sizes) || '1080x1920', type: (s && s.type) || 'image/png' } : null;
    }).filter(Boolean);
  }
  const manifest = {
    name: cleanName,
    short_name: cleanShort,
    start_url: cleanStart,
    scope: cleanScope,
    display: displayMode || originalManifest.display || 'standalone',
    orientation: orientation || originalManifest.orientation || 'portrait',
    theme_color: themeColor || originalManifest.theme_color || '#000000',
    background_color: backgroundColor || originalManifest.background_color || '#ffffff',
    description: safeText(description || originalManifest.description || cleanName, cleanName, 120),
    icons
  };
  if (shots.length) manifest.screenshots = shots;
  if (originalManifest.iarc_rating_id) manifest.iarc_rating_id = originalManifest.iarc_rating_id;
  return manifest;
}

function startLocalManifestServer(manifest, buildDir) {
  return new Promise((resolve, reject) => {
    const localServer = http.createServer((req, res) => {
      if (req.url.startsWith('/manifest.webmanifest')) {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(manifest, null, 2));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    localServer.on('error', reject);
    localServer.listen(0, '127.0.0.1', () => {
      const port = localServer.address().port;
      const url = `http://127.0.0.1:${port}/manifest.webmanifest`;
      writeLog(buildDir, `Manifest local Bubblewrap: ${url}`);
      resolve({ server: localServer, url });
    });
  });
}

function writeLog(buildDir, msg) {
  try { fs.appendFileSync(path.join(buildDir, 'build.log'), msg + '\n'); } catch (_) {}
}

function runCommand(cmd, args, opts = {}) {
  const { cwd, env = {}, buildDir, promptAnswers = {}, timeoutMs = 0 } = opts;
  return new Promise((resolve) => {
    const resolvedCmd = resolveCommandPath(cmd);
    emitLog(`> ${resolvedCmd} ${args.join(' ')}`);
    const child = spawn(resolvedCmd, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    currentBuildProcesses.push(child);

    let outputBuffer = '';
    const answered = new Set();
    let killedByTimeout = false;
    let timeoutHandle = null;
    if (timeoutMs && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        killedByTimeout = true;
        writeLog(buildDir, `❌ Timeout após ${Math.round(timeoutMs/1000)}s executando: ${resolvedCmd} ${args.join(' ')}`);
        emitLog(`❌ Timeout após ${Math.round(timeoutMs/1000)}s executando: ${resolvedCmd} ${args.join(' ')}`);
        try { child.kill('SIGKILL'); } catch (_) {}
      }, timeoutMs);
    }

    const answerOnce = (key, answer, label) => {
      if (answered.has(key)) return;
      answered.add(key);
      try {
        child.stdin.write(String(answer) + '\n');
        emitLog(`> ${label || key}: ${answer === '' ? '[ENTER]' : answer}`);
      } catch (_) {}
    };

    const handlePrompts = (chunk) => {
      outputBuffer += chunk;
      if (outputBuffer.length > 12000) outputBuffer = outputBuffer.slice(-12000);
      const b = outputBuffer;

      // Instalação de dependências: sempre usar as já existentes no Docker.
      // IMPORTANTE: as respostas são enviadas somente uma vez por prompt, evitando loop/travamento.
      if (/Do you want Bubblewrap to install the JDK/i.test(b)) answerOnce('install-jdk', 'n', 'Usando JDK já instalado no Docker');
      if (/Path to your existing JDK 17/i.test(b)) answerOnce('jdk-path', promptAnswers.jdkPath, 'Caminho do JDK informado');
      if (/Do you want Bubblewrap to install the Android SDK/i.test(b)) answerOnce('install-sdk', 'n', 'Usando Android SDK já instalado no Docker');
      if (/Path to your existing Android SDK/i.test(b)) answerOnce('sdk-path', promptAnswers.androidSdkPath, 'Caminho do Android SDK informado');
      if (/provided androidSdk isn't correct/i.test(b)) {
        emitLog('❌ Android SDK recusado pelo Bubblewrap. Verifique se existe tools/bin/sdkmanager dentro do SDK.');
      }
      if (/terms and conditions|licenses/i.test(b) && /\(y\/N\)|Accept\?/i.test(b)) answerOnce('licenses', 'y', 'Aceitando licenças');

      // Web app details do bubblewrap init. Muitos possuem valor padrão; ENTER aceita.
      if (/\?\s*Domain:/i.test(b)) answerOnce('domain', promptAnswers.domain || '', 'Domain');
      if (/\?\s*URL path:/i.test(b)) answerOnce('url-path', promptAnswers.urlPath || '/', 'URL path');
      if (/\?\s*(Application name|Name):/i.test(b)) answerOnce('name', promptAnswers.appName || '', 'Nome do app');
      if (/\?\s*(Short name|Launcher name):/i.test(b)) answerOnce('short-name', promptAnswers.shortName || '', 'Nome curto');
      if (/\?\s*(Package name|Application ID|Package ID):/i.test(b)) answerOnce('package-id', promptAnswers.packageId || '', 'Package ID');
      if (/\?\s*(Version code|App version code):/i.test(b)) answerOnce('version-code', promptAnswers.versionCode || '1', 'Version code');
      if (/\?\s*(Version name|App version name|versionName):/i.test(b)) answerOnce('version-name', promptAnswers.versionName || '1.0.0', 'Version name');
      if (/\?\s*(Signing key path|Key store location|Keystore location|Keystore path):/i.test(b)) answerOnce('keystore-path', promptAnswers.keystorePath || '', 'Keystore');
      if (/\?\s*(Key name|Key alias|Signing key alias):/i.test(b)) answerOnce('key-alias', promptAnswers.keyAlias || 'app', 'Alias');
      if (/\?\s*(Do you want to create|Create a new signing key)/i.test(b)) answerOnce('create-key', 'n', 'Não criar chave pelo Bubblewrap');
      if (/\?\s*(Play Billing|billing)/i.test(b)) answerOnce('billing', 'n', 'Play Billing');
      if (/\?\s*(Display mode|Orientation|Status bar color|Navigation bar color|Theme color|Background color|Splash)/i.test(b)) answerOnce('visual-default', '', 'Mantendo padrão visual');
      if (/\?\s*(Do you want|Would you like|Overwrite|regenerate)/i.test(b) && /\(Y\/n\)|\(y\/N\)/i.test(b)) answerOnce('generic-yes', 'y', 'Confirmando');

      // Senhas em build/update.
      if (/Password/i.test(b) && !/\*\*\*/.test(chunk)) answerOnce('password-' + answered.size, promptAnswers.storePassword || '', 'Senha');
    };

    child.stdout.on('data', (data) => {
      const clean = cleanLogs(data);
      writeLog(buildDir, clean);
      emitLog(clean);
      handlePrompts(clean);
    });
    child.stderr.on('data', (data) => {
      const clean = cleanLogs(data);
      writeLog(buildDir, `⚠️ ${clean}`);
      emitLog(`⚠️ ${clean}`);
      handlePrompts(clean);
    });
    child.on('error', (err) => {
      writeLog(buildDir, `❌ ${err.message}`);
      emitLog(`❌ ${err.message}`);
    });
    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const idx = currentBuildProcesses.indexOf(child);
      if (idx > -1) currentBuildProcesses.splice(idx, 1);
      if (killedByTimeout) {
        resolve(124);
        return;
      }
      if (code !== 0) { writeLog(buildDir, `❌ Processo finalizou com código ${code}: ${resolvedCmd}`); emitLog(`❌ Processo finalizou com código ${code}: ${resolvedCmd}`); }
      resolve(code);
    });
  });
}

function tclEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

async function runBubblewrapInitNoPrompt({ buildDir, env, manifestUrl, promptAnswers }) {
  emitLog('> Tentando bubblewrap init em modo não interativo...');
  const code = await runCommand('bubblewrap', ['init', '--manifest', manifestUrl, '--skipCheck', '--no-prompt'], {
    cwd: buildDir,
    env,
    buildDir,
    promptAnswers,
    timeoutMs: 90000
  });
  if (code === 0 && fs.existsSync(path.join(buildDir, 'twa-manifest.json'))) return 0;
  emitLog('⚠️ bubblewrap init --no-prompt não concluiu. Usando fallback controlado.');
  return 1;
}

async function runBubblewrapInitExpect({ buildDir, env, manifestUrl, javaHome, androidSdkPath, promptAnswers }) {
  const expectPath = path.join(buildDir, 'bubblewrap-init.expect');
  const script = `#!/usr/bin/expect -f
# v23 - controle dos prompts do Bubblewrap, incluindo prompts opcionais com maiusculas/minusculas.
# O erro das versões anteriores era responder o mesmo prompt várias vezes.
# O Inquirer redesenha a mesma linha enquanto digita; sem trava por prompt,
# o expect envia "Porta" repetidamente e parece loop infinito no Short name.
set timeout 420
log_user 1
set manifest "${tclEscape(manifestUrl)}"
set jdk "${tclEscape(javaHome)}"
set sdk "${tclEscape(androidSdkPath)}"
set appName "${tclEscape(promptAnswers.appName || 'App')}"
set shortName "${tclEscape(promptAnswers.shortName || 'App')}"
set packageId "${tclEscape(promptAnswers.packageId || 'br.com.needsolutions.app')}"
set domain "${tclEscape(promptAnswers.domain || 'example.com')}"
set urlPath "${tclEscape(promptAnswers.urlPath || '/')}"
set versionCode "${tclEscape(promptAnswers.versionCode || '1')}"
set versionName "${tclEscape(promptAnswers.versionName || '1.0.0')}"
set keyPath "${tclEscape(promptAnswers.keystorePath || '')}"
set statusColor "${tclEscape(promptAnswers.statusColor || '#000000')}"
set navColor "${tclEscape(promptAnswers.navColor || '#000000')}"
set themeColor "${tclEscape(promptAnswers.themeColor || '#000000')}"
set backgroundColor "${tclEscape(promptAnswers.backgroundColor || '#ffffff')}"
set orientationValue "${tclEscape(promptAnswers.orientation || 'portrait')}"
set displayValue "${tclEscape(promptAnswers.display || 'standalone')}"
set iconUrl "${tclEscape(promptAnswers.iconUrl || '')}"
set maskableIconUrl "${tclEscape(promptAnswers.maskableIconUrl || promptAnswers.iconUrl || '')}"
set keyAlias "${tclEscape(promptAnswers.keyAlias || 'app')}"
set keyPass "${tclEscape(promptAnswers.storePassword || '')}"
array set sent {}

proc send_once {key value label} {
  global sent
  if {![info exists sent($key)]} {
    set sent($key) 1
    puts "\\n> $label: [expr {$value eq \"\" ? \"[ENTER]\" : $value}]"
    send -- "$value\r"
  }
}

puts "> Executando bubblewrap init controlado v23. Cada prompt sera respondido apenas uma vez."
spawn bubblewrap init --manifest $manifest --skipCheck
expect {
  -glob "*Do you want Bubblewrap to install the JDK*" { send_once install_jdk "n" "Usando JDK do Docker"; exp_continue }
  -glob "*Path to your existing JDK 17:*" { send_once jdk_path $jdk "Caminho JDK"; exp_continue }
  -glob "*Do you want Bubblewrap to install the Android SDK*" { send_once install_sdk "n" "Usando Android SDK do Docker"; exp_continue }
  -glob "*Path to your existing Android SDK:*" { send_once sdk_path $sdk "Caminho Android SDK"; exp_continue }
  -glob "*Do you agree to the Android SDK terms*" { send_once licenses "y" "Licencas Android"; exp_continue }
  -glob "*terms and conditions*" { send_once licenses2 "y" "Termos"; exp_continue }

  -glob "*Domain:*" { send_once domain $domain "Domain"; exp_continue }
  -glob "*URL path:*" { send_once url_path $urlPath "URL path"; exp_continue }
  -glob "*Start URL:*" { send_once start_url $urlPath "Start URL"; exp_continue }
  -glob "*Scope:*" { send_once scope $urlPath "Scope"; exp_continue }

  -glob "*Application name:*" { send_once app_name $appName "Application name"; exp_continue }
  -glob "*Name:*" { send_once name $appName "Name"; exp_continue }
  -glob "*Short name:*" { send_once short_name $shortName "Short name"; exp_continue }
  -glob "*Launcher name:*" { send_once launcher_name $shortName "Launcher name"; exp_continue }
  -glob "*Application ID:*" { send_once app_id $packageId "Application ID"; exp_continue }
  -glob "*Package ID:*" { send_once pkg_id $packageId "Package ID"; exp_continue }
  -glob "*Package name:*" { send_once pkg_name $packageId "Package name"; exp_continue }

  -glob "*Starting version code*" { send_once version_code $versionCode "Version code"; exp_continue }
  -glob "*Version code:*" { send_once version_code2 $versionCode "Version code"; exp_continue }
  -glob "*Version name:*" { send_once version_name $versionName "Version name"; exp_continue }

  -glob "*Display mode:*" { send_once display $displayValue "Display"; exp_continue }
  -glob "*Display Mode:*" { send_once display2 $displayValue "Display"; exp_continue }
  -glob "*Orientation:*" { send_once orientation $orientationValue "Orientation"; exp_continue }
  -glob "*Status bar color:*" { send_once status_color $statusColor "Status bar color"; exp_continue }
  -glob "*Status Bar Color:*" { send_once status_color2 $statusColor "Status bar color"; exp_continue }
  -glob "*Navigation bar color:*" { send_once nav_color $navColor "Navigation bar color"; exp_continue }
  -glob "*Navigation Bar Color:*" { send_once nav_color2 $navColor "Navigation bar color"; exp_continue }
  -glob "*Theme color:*" { send_once theme_color $themeColor "Theme color"; exp_continue }
  -glob "*Background color:*" { send_once bg_color $backgroundColor "Background color"; exp_continue }
  -glob "*Background Color:*" { send_once bg_color2 $backgroundColor "Background color"; exp_continue }
  -glob "*Splash screen color:*" { send_once splash_color $backgroundColor "Splash color"; exp_continue }
  -glob "*Splash Screen Color:*" { send_once splash_color2 $backgroundColor "Splash color"; exp_continue }

  # Imagens/ícones. Sem estas respostas o Bubblewrap fica preso em "Icon URL".
  -glob "*Icon URL:*" { send_once icon_url $iconUrl "Icon URL"; exp_continue }
  -glob "*Icon url:*" { send_once icon_url_l $iconUrl "Icon URL"; exp_continue }
  -glob "*icon URL:*" { send_once icon_url_l2 $iconUrl "Icon URL"; exp_continue }
  -glob "*icon url:*" { send_once icon_url_l3 $iconUrl "Icon URL"; exp_continue }
  -glob "*Maskable Icon URL*" { send_once maskable_icon_url $maskableIconUrl "Maskable Icon URL"; exp_continue }
  -glob "*Maskable icon URL*" { send_once maskable_icon_url_l $maskableIconUrl "Maskable icon URL"; exp_continue }
  -glob "*maskable Icon URL*" { send_once maskable_icon_url_l2 $maskableIconUrl "Maskable icon URL"; exp_continue }
  -glob "*maskable icon URL*" { send_once maskable_icon_url_l3 $maskableIconUrl "Maskable icon URL"; exp_continue }
  -glob "*Monochrome Icon URL*" { send_once mono_icon_url "" "Monochrome Icon URL"; exp_continue }
  -glob "*Monochrome icon URL*" { send_once mono_icon_url_l "" "Monochrome icon URL"; exp_continue }
  -glob "*monochrome icon URL*" { send_once mono_icon_url_l2 "" "Monochrome icon URL"; exp_continue }
  -glob "*Splash screen image URL*" { send_once splash_image_url $iconUrl "Splash image URL"; exp_continue }
  -glob "*Splash Screen Image URL*" { send_once splash_image_url2 $iconUrl "Splash image URL"; exp_continue }
  -glob "*splash screen image URL*" { send_once splash_image_url3 $iconUrl "Splash image URL"; exp_continue }

  -glob "*Do you want to create a new signing key*" { send_once create_key "n" "Criar chave pelo Bubblewrap"; exp_continue }
  -glob "*Create a new signing key*" { send_once create_key2 "n" "Criar chave"; exp_continue }
  -glob "*Keystore path:*" { send_once key_path $keyPath "Keystore path"; exp_continue }
  -glob "*Key store location:*" { send_once key_store $keyPath "Key store"; exp_continue }
  -glob "*Signing key path:*" { send_once signing_key $keyPath "Signing key"; exp_continue }
  -glob "*Key alias:*" { send_once key_alias $keyAlias "Key alias"; exp_continue }
  -glob "*Key name:*" { send_once key_name $keyAlias "Key name"; exp_continue }
  -glob "*Password:*" { send_once key_pass $keyPass "Password"; exp_continue }

  -glob "*Play Billing*" { send_once billing "n" "Play Billing"; exp_continue }
  -glob "*URL:*" { send_once generic_url "" "URL opcional"; exp_continue }
  -glob "*Protocol handlers*" { send_once protocol_handlers "" "Protocol handlers"; exp_continue }
  -glob "*File handlers*" { send_once file_handlers "" "File handlers"; exp_continue }
  -glob "*Shortcuts*" { send_once shortcuts "" "Shortcuts"; exp_continue }
  -glob "*Categories*" { send_once categories "" "Categories"; exp_continue }
  -glob "*Overwrite*" { send_once overwrite "y" "Overwrite"; exp_continue }
  -glob "*Would you like*" { send_once would_like "" "Would you like"; exp_continue }
  -glob "*Do you want*" { send_once do_you_want "" "Do you want"; exp_continue }

  -glob "*isn't correct*" { puts "ERRO: JDK ou Android SDK recusado pelo Bubblewrap."; exit 94 }
  -glob "*Invalid URL*" { puts "ERRO: URL do manifest recusada pelo Bubblewrap."; exit 95 }
  -glob "*Invalid*" { puts "ERRO: Campo recusado pelo Bubblewrap. Confira o prompt anterior no build.log."; exit 96 }
  timeout { puts "ERRO: bubblewrap init ficou aguardando uma pergunta nao mapeada por 420s."; exit 93 }
  eof
}
catch wait result
exit [lindex $result 3]
`;
  fs.writeFileSync(expectPath, script, { mode: 0o755 });
  emitLog('> bubblewrap init: usando expect v23 com prompts case-insensitive e trava anti-loop.');
  return runCommand('expect', [expectPath], { cwd: buildDir, env, buildDir, promptAnswers: {}, timeoutMs: 8 * 60 * 1000 });
}


async function generateBubblewrapProjectDirect({ buildDir, manifestUrl, promptAnswers }) {
  emitLog('> Gerando projeto Android diretamente pela API do Bubblewrap, sem wizard interativo...');
  const core = require('@bubblewrap/core');
  const shared = require('@bubblewrap/cli/dist/lib/cmds/shared');

  const twaManifest = await core.TwaManifest.fromWebManifest(manifestUrl);

  twaManifest.host = promptAnswers.domain;
  twaManifest.name = promptAnswers.appName;
  twaManifest.launcherName = safeLauncherName(promptAnswers.shortName || promptAnswers.appName, 'App');
  twaManifest.packageId = promptAnswers.packageId;
  twaManifest.appVersionCode = parseInt(promptAnswers.versionCode, 10) || 1;
  twaManifest.appVersionName = promptAnswers.versionName || String(twaManifest.appVersionCode);
  twaManifest.startUrl = promptAnswers.urlPath || '/';
  twaManifest.display = promptAnswers.display || 'standalone';
  twaManifest.orientation = promptAnswers.orientation || 'portrait';
  twaManifest.enableNotifications = true;
  twaManifest.signingKey = { path: promptAnswers.keystorePath, alias: promptAnswers.keyAlias || 'app' };
  twaManifest.generatorApp = 'PWA Builder Pro';
  twaManifest.features = twaManifest.features || {};
  twaManifest.shortcuts = [];
  twaManifest.monochromeIconUrl = undefined;
  twaManifest.maskableIconUrl = promptAnswers.maskableIconUrl || promptAnswers.iconUrl || twaManifest.maskableIconUrl;
  if (promptAnswers.iconUrl) twaManifest.iconUrl = promptAnswers.iconUrl;

  if (!twaManifest.iconUrl) {
    throw new Error('Manifest não possui ícone válido. Informe uma URL de ícone PNG 512x512 no campo Icon URL.');
  }

  // O Bubblewrap espera objetos de cor internos aqui; sobrescrever com string
  // quebra o saveToFile() com "this.themeColor.hex is not a function".
  // As cores finais continuam sendo aplicadas depois, no twa-manifest.json.
  const manifestFile = path.join(buildDir, 'twa-manifest.json');
  await twaManifest.saveToFile(manifestFile);

  const twaGenerator = new core.TwaGenerator();
  const log = new core.BufferedLog(new core.ConsoleLog('Bubblewrap'));
  const progress = (current, total) => {
    if (total && current % Math.max(1, Math.floor(total / 10)) === 0) {
      emitLog('> Gerando projeto Android: ' + current + '/' + total);
    }
  };
  await twaGenerator.createTwaProject(buildDir, twaManifest, log, progress);
  log.flush();
  await shared.generateManifestChecksumFile(manifestFile, buildDir);
  emitLog('> Projeto Android/TWA criado sem perguntas interativas.');
  return 0;
}

function findBuiltFile(buildDir, type) {
  const dirs = [
    buildDir,
    path.join(buildDir, 'dist'),
    path.join(buildDir, 'app', 'build', 'outputs', 'bundle', 'release'),
    path.join(buildDir, 'app', 'build', 'outputs', 'apk', 'release'),
    path.join(buildDir, 'app', 'build', 'outputs', 'bundle', 'debug'),
    path.join(buildDir, 'app', 'build', 'outputs', 'apk', 'debug')
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const files = fs.readdirSync(d);
    const found = files.find(f => type === 'apk' ? f.endsWith('.apk') : type === 'aab' ? f.endsWith('.aab') : (f.endsWith('.apk') || f.endsWith('.aab')));
    if (found) return path.join(d, found);
  }
  return null;
}

app.post('/cancel-build', requirePanelAuth, (req, res) => {
  currentBuildProcesses.forEach(proc => { try { proc.kill('SIGKILL'); } catch (_) {} });
  currentBuildProcesses = [];
  io.emit('status', { success: false, msg: '❌ Build cancelado pelo usuário.', isSigned: false, hasLogs: true });
  io.emit('log', '> ❌ BUILD CANCELADO PELO USUÁRIO.');
  res.json({ success: true });
});

app.get('/fetch-manifest', requirePanelAuth, async (req, res) => {
  let { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  url = normalizeUrl(url);

  const parseManifest = (manifest, manifestUrl, htmlTitle = '', htmlDescription = '') => {
    const originHost = cleanHostFromUrl(url);
    const data = {
      appName: manifest.name || htmlTitle || '',
      shortName: manifest.short_name || manifest.name || htmlTitle || '',
      themeColor: manifest.theme_color || '#000000',
      backgroundColor: manifest.background_color || '#ffffff',
      iconUrl: '',
      packageId: '',
      startUrl: manifest.start_url || '/',
      description: manifest.description || htmlDescription || '',
      display: manifest.display || 'standalone',
      orientation: manifest.orientation || 'portrait',
      iarc_rating_id: manifest.iarc_rating_id || '',
      screenshots: [],
      manifestUrl
    };
    if (Array.isArray(manifest.icons) && manifest.icons.length) {
      const bestIcon = manifest.icons.find(i => String(i.sizes || '').includes('512x512')) || manifest.icons.find(i => String(i.sizes || '').includes('192x192')) || manifest.icons[manifest.icons.length - 1];
      if (bestIcon && bestIcon.src) data.iconUrl = new URL(bestIcon.src, manifestUrl || url).href;
    }
    if (Array.isArray(manifest.screenshots)) {
      data.screenshots = manifest.screenshots.map(s => typeof s === 'string' ? s : s && s.src).filter(Boolean).map(src => new URL(src, manifestUrl || url).href);
    }
    const playApp = Array.isArray(manifest.related_applications) ? manifest.related_applications.find(app => app.platform === 'play') : null;
    if (playApp && playApp.id) data.packageId = playApp.id;
    if (!data.packageId) data.packageId = safePackageId('', originHost);
    data.appName = safeText(data.appName || originHost.split('.')[0] || 'App', 'App', 50);
    data.shortName = safeLauncherName(data.shortName || data.appName || 'App', 'App');
    return data;
  };

  try {
    let html = '';
    let $ = cheerio.load('');
    let htmlTitle = '';
    let htmlDescription = '';
    const candidates = [];
    let lastErr = '';

    try {
      const first = await httpGetSmart(url);
      const contentType = String(first.headers['content-type'] || '');
      const pathName = new URL(url).pathname;
      if (first.status < 400 && (contentType.includes('application/manifest+json') || contentType.includes('application/json') || /manifest\.(webmanifest|json|php)$/i.test(pathName))) {
        try {
          const manifest = tryParseJsonLoose(first.data);
          return res.json(parseManifest(manifest, url));
        } catch (e) { lastErr = e.message; }
      }
      html = String(first.data || '');
      $ = cheerio.load(html);
      htmlTitle = ($('title').text() || '').trim();
      htmlDescription = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
      $('link[rel]').each((_, el) => {
        const rel = String($(el).attr('rel') || '').toLowerCase();
        const href = $(el).attr('href');
        if (href && rel.split(/\s+/).includes('manifest')) candidates.push(new URL(href, url).href);
      });
    } catch (e) {
      lastErr = e.message;
    }

    const u = new URL(url);
    const basePath = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/\/[^/]*$/, '/');
    candidates.push(new URL('manifest.webmanifest', `${u.origin}${basePath}`).href);
    candidates.push(new URL('manifest.json', `${u.origin}${basePath}`).href);
    candidates.push(new URL('manifest.php', `${u.origin}${basePath}`).href);
    candidates.push(new URL('/manifest.webmanifest', u.origin).href);
    candidates.push(new URL('/manifest.json', u.origin).href);
    candidates.push(new URL('/manifest.php', u.origin).href);

    for (const mUrl of [...new Set(candidates)]) {
      try {
        const mr = await httpGetSmart(mUrl);
        if (mr.status >= 400) { lastErr = `HTTP ${mr.status} em ${mUrl}`; continue; }
        const manifest = tryParseJsonLoose(mr.data);
        if (manifest && (manifest.name || manifest.short_name || manifest.start_url || manifest.icons)) {
          const data = parseManifest(manifest, mUrl, htmlTitle, htmlDescription);
          if (!data.iconUrl) {
            const icon = $('link[rel="apple-touch-icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || $('link[rel="icon"]').attr('href');
            if (icon) data.iconUrl = new URL(icon, url).href;
          }
          return res.json(data);
        }
      } catch (e) { lastErr = e.message; }
    }

    const fallback = fallbackManifestData(url, lastErr ? `Manifest não encontrado. Usando dados básicos. Último erro: ${lastErr}` : 'Manifest não encontrado. Usando dados básicos.');
    if (htmlTitle) fallback.appName = safeText(htmlTitle, fallback.appName, 50);
    if (htmlDescription) fallback.description = htmlDescription;
    const icon = $('link[rel="apple-touch-icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || $('link[rel="icon"]').attr('href');
    if (icon) fallback.iconUrl = new URL(icon, url).href;
    return res.json(fallback);
  } catch (error) {
    return res.json(fallbackManifestData(url, 'Falha ao buscar dados externos. Preencha/revise os campos manualmente. Detalhe: ' + error.message));
  }
});

app.get('/download', requirePanelAuth, (req, res) => {
  const buildDir = path.join(__dirname, 'temp_build');
  const type = req.query.type;
  const logFile = path.join(buildDir, 'build.log');
  if (type === 'log') {
    if (fs.existsSync(logFile)) return res.download(logFile, 'build-error.log');
    return res.status(404).send('Log não encontrado.');
  }
  const file = findBuiltFile(buildDir, type);
  if (file) return res.download(file, path.basename(file));
  if (fs.existsSync(logFile)) return res.download(logFile, 'build-error.log');
  res.status(404).send('Arquivo de build não encontrado.');
});

app.post('/generate', requirePanelAuth, upload.single('signingKey'), async (req, res) => {
  const {
    appName, host, versionCode, versionName, shortName, packageId, themeColor,
    backgroundColor, navColor, navDarkColor, iconUrl, startUrl, description,
    iarc, displayMode, orientation, screenshots
  } = req.body;

  if (!host || !appName) return res.status(400).json({ success: false, msg: 'Faltam campos obrigatórios: host e appName.' });

  const buildDir = path.join(__dirname, 'temp_build');
  try {
    res.json({ success: true, message: 'Build started' });

    if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });
    writeLog(buildDir, 'Iniciando build...');

    const javaHome = getJavaHome();
    const androidSdkPath = getAndroidSdkPath();
    const cleanHost = cleanHostFromUrl(host);
    const siteUrl = normalizeUrl(host);
    const webManifestUrl = await resolveWebManifestUrl(siteUrl);
    let originalWebManifest = {};
    try {
      originalWebManifest = await loadManifestFromUrl(webManifestUrl);
    } catch (e) {
      emitLog(`⚠️ Não foi possível carregar o manifest original (${e.message}). Será usado um manifest local limpo.`);
    }
    const vCode = parseInt(versionCode, 10) || 1;
    const vName = versionName || `1.0.${vCode}`;
    const finalPackageId = safePackageId(packageId, cleanHost);
    const safeAppName = safeText(appName, 'App', 50);
    const finalShortName = safeLauncherName(shortName || appName, safeAppName.split(' ')[0] || 'App');
    const keyAlias = 'app';
    const storePassword = crypto.randomBytes(18).toString('base64url');
    const keystorePath = path.join(buildDir, 'release-key.p12');

    const env = {
      JAVA_HOME: javaHome,
      ANDROID_HOME: androidSdkPath,
      ANDROID_SDK_ROOT: androidSdkPath,
      PATH: `${process.env.PATH}:${androidSdkPath}/cmdline-tools/latest/bin:${androidSdkPath}/platform-tools:${androidSdkPath}/build-tools/34.0.0`,
      BUBBLEWRAP_KEYSTORE_PASSWORD: storePassword,
      BUBBLEWRAP_KEY_PASSWORD: storePassword,
      JAVA_TOOL_OPTIONS: '-Xmx1024m',
      _JAVA_OPTIONS: '-Xmx1024m',
      GRADLE_OPTS: '-Xmx1024m -Dorg.gradle.daemon=false'
    };

    ensureBubblewrapConfig(javaHome, androidSdkPath);

    emitLog('> [INICIANDO] Limpando ambiente e gerando assinatura automática...');
    emitLog(`> JAVA_HOME: ${javaHome}`);
    emitLog(`> ANDROID_SDK_ROOT: ${androidSdkPath}`);
    emitLog(`> Web Manifest usado: ${webManifestUrl}`);
    if (!fs.existsSync(path.join(androidSdkPath, 'platform-tools'))) {
      emitLog('⚠️ platform-tools não encontrado no Android SDK informado. Verifique o Dockerfile.');
    }
    if (!fs.existsSync(path.join(androidSdkPath, 'cmdline-tools'))) {
      emitLog('⚠️ cmdline-tools não encontrado no Android SDK informado. Verifique o Dockerfile.');
    }

    const gradleDir = path.join(process.env.HOME || '/root', '.gradle');
    fs.mkdirSync(gradleDir, { recursive: true });
    fs.writeFileSync(path.join(gradleDir, 'gradle.properties'), GRADLE_PROPERTIES);

    emitLog('> Configurando Bubblewrap com JDK/Android SDK fixos...');
    await runCommand('bubblewrap', ['updateConfig', '--jdkPath', javaHome, '--androidSdkPath', androidSdkPath], { cwd: buildDir, env, buildDir, promptAnswers: {} });

    const dn = `CN=${safeAppName}, OU=Apps, O=Need Solutions, L=Urania, ST=SP, C=BR`;
    const keyCode = await runCommand('keytool', [
      '-genkeypair', '-v', '-keystore', keystorePath, '-storetype', 'PKCS12',
      '-storepass', storePassword, '-keypass', storePassword,
      '-alias', keyAlias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
      '-dname', dn
    ], { cwd: buildDir, env, buildDir });
    if (keyCode !== 0) throw new Error('Falha ao gerar keystore automaticamente.');
    fs.writeFileSync(path.join(buildDir, 'keystore-info.json'), JSON.stringify({ path: keystorePath, alias: keyAlias, storePassword }, null, 2));

    emitLog('> [1/3] Inicializando projeto Android/TWA pelo Web Manifest...');
    const promptAnswers = {
      jdkPath: javaHome,
      androidSdkPath,
      domain: cleanHost,
      urlPath: startUrl || '/',
      appName: safeAppName,
      shortName: finalShortName,
      packageId: finalPackageId,
      versionCode: String(vCode),
      versionName: vName,
      keystorePath,
      keyAlias,
      storePassword,
      statusColor: themeColor || '#000000',
      navColor: navColor || '#000000',
      themeColor: themeColor || '#000000',
      backgroundColor: backgroundColor || '#ffffff',
      orientation: orientation || 'portrait',
      display: displayMode || 'standalone',
      iconUrl: iconUrl || '',
      maskableIconUrl: iconUrl || ''
    };

    const cleanWebManifest = buildCleanWebManifest({
      originalManifest: originalWebManifest,
      manifestUrl: webManifestUrl,
      siteUrl,
      appName: safeAppName,
      shortName: finalShortName,
      startUrl: startUrl || '/',
      themeColor,
      backgroundColor,
      displayMode,
      orientation,
      description,
      iconUrl,
      screenshots
    });
    fs.writeFileSync(path.join(buildDir, 'web-manifest-sanitized.json'), JSON.stringify(cleanWebManifest, null, 2));
    if (!promptAnswers.iconUrl && cleanWebManifest.icons && cleanWebManifest.icons[0] && cleanWebManifest.icons[0].src) {
      promptAnswers.iconUrl = cleanWebManifest.icons[0].src;
      promptAnswers.maskableIconUrl = cleanWebManifest.icons[0].src;
    }
    emitLog('> Manifest sanitizado criado para evitar loop nos prompts do Bubblewrap.');
    const localManifest = await startLocalManifestServer(cleanWebManifest, buildDir);
    let initCode = 1;
    try {
      initCode = await generateBubblewrapProjectDirect({ buildDir, manifestUrl: localManifest.url, promptAnswers });
    } finally {
      try { localManifest.server.close(); } catch (_) {}
    }
    if (initCode !== 0) throw new Error('Falha ao gerar projeto Android/TWA. Baixe o build-error.log para ver detalhes.');

    // Garante manifest local correto caso o Bubblewrap tenha aceitado valores padrão diferentes.
    const twaPath = path.join(buildDir, 'twa-manifest.json');
    if (fs.existsSync(twaPath)) {
      const twa = JSON.parse(fs.readFileSync(twaPath, 'utf8'));
      twa.packageId = finalPackageId;
      twa.host = cleanHost;
      twa.name = safeAppName;
      twa.launcherName = finalShortName;
      twa.display = displayMode || twa.display || 'standalone';
      twa.startUrl = startUrl || twa.startUrl || '/';
      twa.themeColor = themeColor || twa.themeColor || '#000000';
      twa.navigationColor = navColor || twa.navigationColor || '#000000';
      twa.navigationColorDark = navDarkColor || twa.navigationColorDark || '#000000';
      twa.backgroundColor = backgroundColor || twa.backgroundColor || '#ffffff';
      twa.orientation = orientation || twa.orientation || 'any';
      twa.enableNotifications = true;
      twa.signingKey = { path: keystorePath, alias: keyAlias };
      twa.appVersionCode = vCode;
      twa.appVersionName = vName;
      if (iconUrl) twa.iconUrl = iconUrl;
      if (description) twa.description = description;
      if (iarc) twa.iarcRatingId = iarc;
      const validScreenshots = screenshots ? (Array.isArray(screenshots) ? screenshots : [screenshots]).filter(u => String(u).trim()) : [];
      if (validScreenshots.length) twa.screenshots = validScreenshots.map(u => ({ src: u, sizes: '1080x1920', type: 'image/png' }));
      fs.writeFileSync(twaPath, JSON.stringify(twa, null, 2));
      const shared = require('@bubblewrap/cli/dist/lib/cmds/shared');
      await shared.generateManifestChecksumFile(twaPath, buildDir);
    }

    fs.writeFileSync(path.join(buildDir, 'gradle.properties'), GRADLE_PROPERTIES);

    emitLog('> [2/3] Projeto gerado. Pulando bubblewrap update para evitar prompts interativos.');

    emitLog('> [3/3] Construindo Android App Bundle...');
    const buildCode = await runCommand('bubblewrap', [
      'build', '--skipCheck',
      '--signingKeyPassword', storePassword,
      '--signingKeyAliasPassword', storePassword
    ], { cwd: buildDir, env, buildDir, promptAnswers, timeoutMs: 25 * 60 * 1000 });

    if (buildCode === 0 && findBuiltFile(buildDir)) {
      io.emit('status', { success: true, msg: '✅ SUCESSO! O download já está disponível.', isSigned: true });
    } else {
      io.emit('status', { success: false, msg: '❌ O build finalizou, mas o APK/AAB não foi encontrado. Baixe o log.', isSigned: false, hasLogs: true });
    }
  } catch (err) {
    writeLog(buildDir, `❌ ERRO CRÍTICO: ${err.message}`);
    io.emit('log', `❌ ERRO CRÍTICO: ${err.message}`);
    io.emit('status', { success: false, msg: `❌ ${err.message}`, isSigned: false, hasLogs: true });
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
  }
});

server.listen(3000, () => console.log('🚀 Gerador rodando em http://localhost:3000'));
