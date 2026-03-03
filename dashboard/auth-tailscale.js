/**
 * Tailscale whois 认证中间件
 *
 * 原理：收到请求时调用 `tailscale whois <remoteIP>` 查询访问者的 Tailscale 身份。
 * 身份由 Tailscale daemon 保证，无法伪造。
 *
 * 配置（本地 .env，不进 git）：
 *   TAILSCALE_AUTH=true            # 启用认证（默认 true）
 *   TAILSCALE_BIN=                 # tailscale 可执行路径（自动探测，通常不需要手动设置）
 *   TAILSCALE_SOCKET=              # tailscaled socket 路径（自动探测）
 *   TAILSCALE_ALLOWED_LOGINS=      # 留空 = 允许所有 tailnet 成员；逗号分隔 = 白名单
 *   TAILSCALE_ADMIN_LOGINS=        # 可执行管理操作的用户，逗号分隔
 */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const execFileAsync = promisify(execFile);

const AUTH_ENABLED = process.env.TAILSCALE_AUTH !== 'false';

// 自动探测 tailscale 可执行路径
function findTailscaleBin() {
  if (process.env.TAILSCALE_BIN) return process.env.TAILSCALE_BIN;
  const candidates = [
    '/Users/lume/.homebrew/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/usr/bin/tailscale',
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return 'tailscale'; // fallback，依赖 PATH
}

// 自动探测 socket 路径
function findTailscaleSocket() {
  if (process.env.TAILSCALE_SOCKET) return process.env.TAILSCALE_SOCKET;
  const candidates = [
    '/var/run/tailscale/tailscaled.sock',
    '/tmp/tailscale/tailscaled.sock',
  ];
  for (const p of candidates) {
    try { fs.accessSync(p); return p; } catch {}
  }
  return null;
}

const TS_BIN    = findTailscaleBin();
const TS_SOCKET = findTailscaleSocket();

console.log(`[auth] tailscale bin: ${TS_BIN}`);
console.log(`[auth] tailscale socket: ${TS_SOCKET || '(default)'}`);

const getAllowed = () =>
  (process.env.TAILSCALE_ALLOWED_LOGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

const getAdmins = () =>
  (process.env.TAILSCALE_ADMIN_LOGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

/**
 * 查询 Tailscale 身份
 * @param {string} ip  远端 IP（可含端口，会自动剥离）
 * @returns {{ login, displayName, tailscaleIP } | null}
 */
async function whois(ip) {
  // 剥离端口（IPv4: 1.2.3.4:56789 / IPv6: [::1]:56789）
  const addr = ip.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  try {
    const args = ['whois', '--json', addr];
    if (TS_SOCKET) args.splice(0, 0, `--socket=${TS_SOCKET}`);
    const { stdout } = await execFileAsync(TS_BIN, args, { timeout: 3000 });
    const data = JSON.parse(stdout);
    const login = data?.UserProfile?.LoginName || null;
    const displayName = data?.UserProfile?.DisplayName || login;
    const tailscaleIP = data?.Node?.TailscaleIPs?.[0] || addr;
    return login ? { login, displayName, tailscaleIP } : null;
  } catch (err) {
    console.error(`[auth] whois failed for ${addr}:`, err.message);
    return null;
  }
}

/**
 * 主认证中间件
 */
async function tailscaleAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();

  const remoteIP = req.socket.remoteAddress || req.ip || '';
  const identity = await whois(remoteIP);

  if (!identity) {
    return res.status(401).json({
      error: 'Unauthorized',
      reason: 'Cannot verify Tailscale identity for ' + remoteIP,
    });
  }

  const allowed = getAllowed();
  if (allowed.length > 0 && !allowed.includes(identity.login)) {
    console.log(`[auth] DENIED  ${identity.login} (${remoteIP})`);
    return res.status(403).json({
      error: 'Forbidden',
      reason: `${identity.login} is not on the allow list`,
    });
  }

  identity.isAdmin = getAdmins().includes(identity.login);
  req.tsUser = identity;
  console.log(`[auth] OK      ${identity.login} (${identity.tailscaleIP}) admin=${identity.isAdmin}`);
  next();
}

/**
 * 管理员专用中间件（用于重启 Gateway 等敏感操作）
 */
function adminOnly(req, res, next) {
  if (!req.tsUser?.isAdmin) {
    return res.status(403).json({
      error: 'Forbidden',
      reason: 'Admin access required',
    });
  }
  next();
}

module.exports = { tailscaleAuth, adminOnly, whois };
