const express = require('express');
const { createHash, randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('../config/auth');
const auth = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { listResourcesForUser } = require('../config/resources');
const { OIDC_ISSUER, OIDC_CLIENT_ID, verifyOidcIdToken } = require('../auth/oidc');

const router = express.Router();
const oidcTransactions = new Map();

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;

function randomUrlToken() {
  return randomBytes(32).toString('base64url');
}

function transactionCookie(req) {
  const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim());
  const value = cookie.find((part) => part.startsWith('oidc_tx='))?.slice('oidc_tx='.length) || '';
  return /^[A-Za-z0-9_-]{40,60}$/.test(value) ? value : '';
}

function clearTransactionCookie(res) {
  const secure = process.env.OIDC_COOKIE_SECURE === '1';
  res.append('Set-Cookie', `oidc_tx=; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=0${secure ? '; Secure' : ''}`);
}

function requireOidcCallbackSession(req, res, next) {
  const key = transactionCookie(req);
  const transaction = oidcTransactions.get(key);
  if (!transaction || transaction.expiresAt <= Date.now() || req.body?.state !== transaction.state) {
    if (key) oidcTransactions.delete(key);
    clearTransactionCookie(res);
    return res.status(400).json({ message: '统一账号登录状态无效或已过期' });
  }
  oidcTransactions.delete(key);
  clearTransactionCookie(res);
  req.oidcTransaction = transaction;
  if (transaction.mode === 'link') {
    return auth()(req, res, (error) => {
      if (error) return next(error);
      if (Number(req.user.id) !== Number(transaction.userId)) {
        return res.status(403).json({ message: '发起绑定的本地账号已变化，请重新开始' });
      }
      next();
    });
  }
  next();
}

router.get('/oidc/config', (_req, res) => {
  res.json({ enabled: true, issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID });
});

router.post('/oidc/start',
  (req, res, next) => req.body?.mode === 'link' ? auth()(req, res, next) : next(),
  rateLimit('oidc-start', { windowMs: 15 * 60 * 1000, max: 20, keyBy: 'visitor' }),
  (req, res) => {
    const { mode, redirectUri } = req.body || {};
    if (!['login', 'link'].includes(mode)) return res.status(400).json({ message: '统一账号流程无效' });
    let redirect;
    try { redirect = new URL(redirectUri); }
    catch { return res.status(400).json({ message: '回调地址无效' }); }
    if (!req.get('origin') || redirect.origin !== req.get('origin') || redirect.pathname !== '/' || redirect.search || redirect.hash) {
      return res.status(400).json({ message: '回调地址必须与当前站点一致' });
    }

    const now = Date.now();
    for (const [key, value] of oidcTransactions) {
      if (value.expiresAt <= now) oidcTransactions.delete(key);
    }
    if (oidcTransactions.size >= 1000) return res.status(503).json({ message: '统一登录暂不可用，请稍后重试' });

    const state = randomUrlToken();
    const nonce = randomUrlToken();
    const verifier = randomUrlToken();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const key = randomUrlToken();
    oidcTransactions.set(key, {
      mode, state, nonce, verifier, redirectUri: redirect.toString(),
      userId: mode === 'link' ? req.user.id : null,
      expiresAt: now + 10 * 60 * 1000
    });
    const secureCookie = req.secure || process.env.OIDC_COOKIE_SECURE === '1';
    res.append('Set-Cookie', `oidc_tx=${key}; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=600${secureCookie ? '; Secure' : ''}`);

    const authorize = new URL(`${OIDC_ISSUER}/protocol/openid-connect/auth`);
    authorize.search = new URLSearchParams({
      client_id: OIDC_CLIENT_ID, redirect_uri: redirect.toString(), response_type: 'code',
      scope: 'openid profile email', state, nonce,
      code_challenge: challenge, code_challenge_method: 'S256'
    });
    res.json({ authorizeUrl: authorize.toString() });
  }
);

async function linkOidcSubject(userId, subject) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [users] = await connection.execute(
      `SELECT u.id, u.oidc_subject, r.status AS role_status
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.status = 'active' FOR UPDATE OF u`,
      [userId]
    );
    const user = users[0];
    if (!user) throw Object.assign(new Error('本项目账号不可用'), { status: 403 });
    if (user.role_status !== 'active') throw Object.assign(new Error('本项目账号角色已停用'), { status: 403 });
    if (user.oidc_subject && user.oidc_subject !== subject) throw Object.assign(new Error('本项目账号已绑定其他统一身份'), { status: 409 });
    const [existing] = await connection.execute('SELECT id FROM users WHERE oidc_subject = ? AND id <> ?', [subject, userId]);
    if (existing.length) throw Object.assign(new Error('此统一身份已绑定其他本项目账号'), { status: 409 });
    await connection.execute('UPDATE users SET oidc_subject = ? WHERE id = ?', [subject, userId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (error.code === '23505') throw Object.assign(new Error('此统一身份已绑定其他本项目账号'), { status: 409 });
    throw error;
  } finally {
    connection.release();
  }
}

router.post('/oidc/callback',
  rateLimit('oidc-callback', { windowMs: 15 * 60 * 1000, max: 30, keyBy: 'visitor' }),
  requireOidcCallbackSession,
  async (req, res, next) => {
    try {
      if (req.body?.error || typeof req.body?.code !== 'string') {
        return res.status(400).json({ message: '统一账号授权未完成' });
      }
      const transaction = req.oidcTransaction;
      const tokenResponse = await fetch(`${OIDC_ISSUER}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: OIDC_CLIENT_ID,
          redirect_uri: transaction.redirectUri, code: req.body.code, code_verifier: transaction.verifier
        }),
        signal: AbortSignal.timeout(15_000)
      });
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok || !tokens.id_token) return res.status(401).json({ message: '统一账号授权失败或授权码已过期' });

      let identity;
      try { identity = await verifyOidcIdToken(tokens.id_token, transaction.nonce); }
      catch { return res.status(401).json({ message: '统一身份令牌无效或已过期' }); }

      if (transaction.mode === 'link') {
        await linkOidcSubject(req.user.id, identity.subject);
        return res.json({ linked: true });
      }

      const [rows] = await pool.execute(
        `SELECT u.id, u.username, u.display_name, u.email, u.phone, u.status,
                u.last_login_at, u.token_version, u.created_at,
                r.code AS role, r.status AS role_status
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.oidc_subject = ? LIMIT 1`,
        [identity.subject]
      );
      const user = rows[0];
      if (!user) return res.status(403).json({ message: '此统一身份尚未绑定本项目账号，请先使用本地账号登录并绑定' });
      if (user.status !== 'active' || user.role_status !== 'active') {
        return res.status(403).json({ message: '本项目账号或角色已停用' });
      }
      await pool.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
      await recordLogin({ userId: user.id, username: user.username, role: user.role, success: 1, message: '统一身份登录成功', req });
      const viewer = await auth.loadActiveUser({ id: user.id, tokenVersion: user.token_version });
      if (!viewer) return res.status(403).json({ message: '本项目账号状态已变化，请重新登录' });
      res.json({ token: signToken(user), user: publicUser(user, viewer) });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/oidc/status', auth(), async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT oidc_subject IS NOT NULL AS linked FROM users WHERE id = ?', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ message: '用户不存在' });
    res.json({ linked: rows[0].linked });
  } catch (error) {
    next(error);
  }
});

function clientIp(req) {
  // 服务通过 FRP 以 TCP 方式暴露，真实客户端 IP 拿不到，此时会是回环地址。
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return (req.ip || '').slice(0, 64) || null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`;
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return '密码需要同时包含字母和数字';
  }
  return null;
}

function validateUsername(username) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return '账号需为 3-32 位字母、数字、下划线、点或连字符';
  }
  return null;
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      name: user.display_name,
      tokenVersion: Number(user.token_version || 0)
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * 对外暴露的用户信息。
 *
 * 第二个参数是 auth 中间件装载的 req.user，只有它带着菜单授权。门户拿
 * adminMenus 决定显示哪些页签、要不要给管理台入口 —— 判据与管理台自身渲染菜单
 * 完全同源。以前门户写死 ['admin','teacher']，角色改成库里的数据之后，
 * 超级管理员被挡在管理台门外、审计员明明有菜单也看不到入口。
 */
function publicUser(user, viewer) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    roleName: viewer ? viewer.roleName : null,
    displayName: user.display_name,
    email: user.email || null,
    phone: user.phone || null,
    status: user.status,
    lastLoginAt: user.last_login_at || null,
    createdAt: user.created_at || null,
    adminMenus: viewer ? listResourcesForUser(viewer).map((item) => item.key) : []
  };
}

async function recordLogin({ userId, username, role, success, message, req }) {
  try {
    await pool.execute(
      `INSERT INTO login_logs (user_id, username, role, success, message, ip, user_agent)
       VALUES (:userId, :username, :role, :success, :message, :ip, :userAgent)`,
      {
        userId: userId || null,
        username: String(username || '').slice(0, 64),
        role: role || null,
        success: success ? 1 : 0,
        message: message || null,
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 255) || null
      }
    );
  } catch (error) {
    // 审计写入失败不应阻断登录本身
    console.error('Failed to write login log:', error.message);
  }
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
router.post(
  '/login',
  // 双层失败计数：按账号挡住针对某个账号的暴力破解，按访客挡住脚本撒网。
  // 不按 IP：经 TCP 隧道时公网访客的 req.ip 全是 127.0.0.1，那样全世界共用一个桶，
  // 任何人试错 20 次就能把所有人的登录一起锁 15 分钟。
  // 两者都只统计失败（skipSuccessful），正常登录不会被自己限流拖累。
  rateLimit('login-user', { windowMs: 15 * 60 * 1000, max: 10, keyBy: 'username', skipSuccessful: true }),
  rateLimit('login-visitor', { windowMs: 15 * 60 * 1000, max: 30, keyBy: 'visitor', skipSuccessful: true }),
  async (req, res, next) => {
    const { username, password } = req.body || {};
    try {
      if (!username || !password) {
        return res.status(400).json({ message: '请填写账号和密码' });
      }

      const [rows] = await pool.execute(
        `SELECT u.id, u.username, u.password_hash, u.display_name, u.email, u.phone, u.status,
                u.last_login_at, u.token_version, u.created_at,
                r.code AS role, r.status AS role_status
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.username = :username LIMIT 1`,
        { username }
      );

      const user = rows[0];
      if (!user) {
        await recordLogin({ username, success: false, message: '账号不存在', req });
        return res.status(401).json({ message: '账号或密码错误' });
      }
      if (user.status !== 'active') {
        await recordLogin({
          userId: user.id,
          username: user.username,
          role: user.role,
          success: false,
          message: '账号已被停用',
          req
        });
        return res.status(403).json({ message: '该账号已被停用，请联系管理员' });
      }
      // 角色被停用等同于该角色下所有账号停用，否则"停用角色"只是改了个标记位
      if (user.role_status !== 'active') {
        await recordLogin({
          userId: user.id,
          username: user.username,
          role: user.role,
          success: false,
          message: '所属角色已被停用',
          req
        });
        return res.status(403).json({ message: '该账号所属角色已被停用，请联系管理员' });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        await recordLogin({
          userId: user.id,
          username: user.username,
          role: user.role,
          success: false,
          message: '密码错误',
          req
        });
        return res.status(401).json({ message: '账号或密码错误' });
      }

      await pool.execute('UPDATE users SET last_login_at = NOW() WHERE id = :id', { id: user.id });
      await recordLogin({
        userId: user.id,
        username: user.username,
        role: user.role,
        success: true,
        message: '登录成功',
        req
      });

      // 登录下发的用户信息要与 /auth/me 完全同形（门户两处都读），
      // 所以这里也走一遍 loadActiveUser 取菜单授权，而不是手拼一个精简对象。
      const viewer = await auth.loadActiveUser({ id: user.id, tokenVersion: user.token_version });

      res.json({
        token: signToken(user),
        user: publicUser(user, viewer)
      });
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// 注册（角色固定为 student，不接受客户端传入的 role）
// ---------------------------------------------------------------------------
router.post(
  '/register',
  // 同样按访客计数：注册接口没有账号维度可用，而 IP 在 TCP 隧道下无区分度
  rateLimit('register', { windowMs: 60 * 60 * 1000, max: 10, keyBy: 'visitor' }),
  async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
      const { username, password, displayName, email, phone, studentNo, englishName } = req.body || {};

      const usernameError = validateUsername(username);
      if (usernameError) return res.status(400).json({ message: usernameError });

      const passwordError = validatePassword(password);
      if (passwordError) return res.status(400).json({ message: passwordError });

      if (!displayName || String(displayName).trim().length < 1) {
        return res.status(400).json({ message: '请填写姓名' });
      }

      // 学号一旦填写，就要求同时提供英文姓名，以便建立学生档案
      if (studentNo && !englishName) {
        return res.status(400).json({ message: '填写学号时需同时填写英文姓名' });
      }

      const [existing] = await connection.execute(
        'SELECT id FROM users WHERE username = ? LIMIT 1',
        [username]
      );
      if (existing.length) {
        return res.status(409).json({ message: '该账号已被注册' });
      }

      if (studentNo) {
        const [dupStudent] = await connection.execute(
          'SELECT id FROM students WHERE student_no = ? LIMIT 1',
          [studentNo]
        );
        if (dupStudent.length) {
          return res.status(409).json({ message: '该学号已存在' });
        }
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      await connection.beginTransaction();

      // role_id 由 roles 表按 code 反查，注册接口拿不到也传不进角色：
      // 走 INSERT ... SELECT，没查到角色就是插 0 行，紧接着报错，不会插出一个无角色的账号。
      const [result] = await connection.execute(
        `INSERT INTO users (username, password_hash, role_id, display_name, email, phone, status)
         SELECT ?, ?, r.id, ?, ?, ?, 'active' FROM roles r WHERE r.code = 'student'`,
        [
          username,
          passwordHash,
          String(displayName).trim().slice(0, 120),
          email ? String(email).trim().slice(0, 120) : null,
          phone ? String(phone).trim().slice(0, 40) : null
        ]
      );
      if (!result.affectedRows) {
        throw new Error("roles 表里没有 student 角色，请先执行 npm run db:migrate");
      }

      let studentId = null;
      if (studentNo) {
        const [studentResult] = await connection.execute(
          `INSERT INTO students (user_id, student_no, chinese_name, english_name, email, phone, status)
           VALUES (?, ?, ?, ?, ?, ?, 'active')`,
          [
            result.insertId,
            String(studentNo).trim().slice(0, 64),
            String(displayName).trim().slice(0, 120),
            String(englishName).trim().slice(0, 120),
            email ? String(email).trim().slice(0, 120) : null,
            phone ? String(phone).trim().slice(0, 40) : null
          ]
        );
        studentId = studentResult.insertId;
      }

      await connection.commit();

      await recordLogin({
        userId: result.insertId,
        username,
        role: 'student',
        success: true,
        message: '注册成功',
        req
      });

      res.status(201).json({
        message: '注册成功，请使用新账号登录',
        user: { id: result.insertId, username, role: 'student', displayName: String(displayName).trim() },
        studentId
      });
    } catch (error) {
      await connection.rollback().catch(() => {});
      next(error);
    } finally {
      connection.release();
    }
  }
);

// ---------------------------------------------------------------------------
// 当前登录用户
// ---------------------------------------------------------------------------
router.get('/me', auth(), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.display_name, u.email, u.phone, u.status,
              u.last_login_at, u.created_at, r.code AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = :id LIMIT 1`,
      { id: req.user.id }
    );
    if (!rows[0]) return res.status(404).json({ message: '用户不存在' });
    res.json(publicUser(rows[0], req.user));
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 修改个人资料
// ---------------------------------------------------------------------------
router.patch('/profile', auth(), async (req, res, next) => {
  try {
    const { displayName, email, phone } = req.body || {};
    const fields = [];
    const params = { id: req.user.id };

    if (displayName !== undefined) {
      if (!String(displayName).trim()) return res.status(400).json({ message: '姓名不能为空' });
      fields.push('display_name = :displayName');
      params.displayName = String(displayName).trim().slice(0, 120);
    }
    if (email !== undefined) {
      fields.push('email = :email');
      params.email = email ? String(email).trim().slice(0, 120) : null;
    }
    if (phone !== undefined) {
      fields.push('phone = :phone');
      params.phone = phone ? String(phone).trim().slice(0, 40) : null;
    }

    if (!fields.length) return res.status(400).json({ message: '没有需要更新的字段' });

    await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = :id`, params);

    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.display_name, u.email, u.phone, u.status,
              u.last_login_at, u.created_at, r.code AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = :id LIMIT 1`,
      { id: req.user.id }
    );
    res.json(publicUser(rows[0], req.user));
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 修改密码（改完旧 token 全部失效，同时把新 token 回给前端保持当前会话）
// ---------------------------------------------------------------------------
router.post('/change-password', auth(), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword) return res.status(400).json({ message: '请填写当前密码' });

    const passwordError = validatePassword(newPassword);
    if (passwordError) return res.status(400).json({ message: passwordError });

    if (currentPassword === newPassword) {
      return res.status(400).json({ message: '新密码不能与当前密码相同' });
    }

    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.display_name, u.password_hash, u.token_version,
              r.code AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = :id LIMIT 1`,
      { id: req.user.id }
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ message: '用户不存在' });

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(400).json({ message: '当前密码不正确' });

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.execute(
      'UPDATE users SET password_hash = :passwordHash, token_version = token_version + 1 WHERE id = :id',
      { passwordHash, id: user.id }
    );

    // 重新读取 token_version，签发一个仍然有效的新 token
    const [updated] = await pool.execute(
      `SELECT u.id, u.username, u.display_name, u.token_version, r.code AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = :id LIMIT 1`,
      { id: user.id }
    );

    res.json({
      message: '密码修改成功，其他设备的登录已失效',
      token: signToken(updated[0])
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 退出登录：递增 token_version，立即撤销该账号已签发的所有 token。
// ---------------------------------------------------------------------------
router.post('/logout', auth(), async (req, res) => {
  await pool.execute(
    'UPDATE users SET token_version = token_version + 1 WHERE id = :id',
    { id: req.user.id }
  );
  await recordLogin({
    userId: req.user.id,
    username: req.user.username,
    role: req.user.role,
    success: true,
    message: '退出登录',
    req
  });
  res.json({ message: '已退出登录' });
});

module.exports = router;
