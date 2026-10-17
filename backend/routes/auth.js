const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const pool = require('../config/db');

const router = express.Router();

function isCollegeEmail(email) {
  const domain = process.env.COLLEGE_EMAIL_DOMAIN;
  return email.toLowerCase().endsWith('@' + domain.toLowerCase());
}

// OTPs are stored in the database (otp_codes table), not server memory.
// A host like Render's free tier restarts the process on redeploys and after
// idle periods — anything kept in memory is wiped when that happens, which
// is why codes were going stale/"incorrect" even when typed correctly.
async function storeOtp(identifier, purpose, code) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await pool.query(
    `INSERT INTO otp_codes (identifier, purpose, code, expires_at, used)
     VALUES (?, ?, ?, ?, FALSE)
     ON DUPLICATE KEY UPDATE code = VALUES(code), expires_at = VALUES(expires_at), used = FALSE`,
    [identifier, purpose, code, expiresAt]
  );
}
async function checkOtp(identifier, purpose, code) {
  const [[row]] = await pool.query(
    `SELECT * FROM otp_codes WHERE identifier = ? AND purpose = ? AND used = FALSE
     ORDER BY id DESC LIMIT 1`,
    [identifier, purpose]
  );
  if (!row) return { ok: false, reason: 'No code was requested for this account. Request a new one.' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'Code expired. Request a new one.' };
  if (row.code !== code) return { ok: false, reason: 'Incorrect code.' };
  return { ok: true, row };
}
async function consumeOtp(id) {
  await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = ?', [id]);
}

async function sendOtpEmail(email, code) {
  if (process.env.BREVO_API_KEY) {
    try {
      const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { name: process.env.MAIL_FROM_NAME || 'Trinity Ride', email: process.env.MAIL_FROM_EMAIL },
          to: [{ email }],
          subject: 'Your Trinity Ride verification code',
          textContent: `Your Trinity Ride code is ${code}. It expires in 10 minutes.`,
        }),
      });
      if (!resp.ok) console.error('Brevo failed:', resp.status, await resp.text());
    } catch (err) {
      console.error('Brevo request error:', err);
    }
    return;
  }
  if (process.env.RESEND_API_KEY) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'Trinity Ride <onboarding@resend.dev>',
          to: email,
          subject: 'Your Trinity Ride verification code',
          text: `Your Trinity Ride code is ${code}. It expires in 10 minutes.`,
        }),
      });
      if (!resp.ok) console.error('Resend failed:', resp.status, await resp.text());
    } catch (err) {
      console.error('Resend request error:', err);
    }
    return;
  }
  if (process.env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: `"Trinity Ride" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your Trinity Ride verification code',
      text: `Your code is ${code}. It expires in 10 minutes.`,
    });
    return;
  }
  console.log(`[no email provider configured] OTP for ${email}: ${code}`);
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { full_name, college_email, id_card_number, phone, branch, year_of_study, password, verify_via } = req.body;

    if (!full_name || !college_email || !id_card_number || !phone || !password) {
      return res.status(400).json({ error: 'Full name, college email, phone number, ID card number and password are required.' });
    }
    if (!isCollegeEmail(college_email)) {
      return res.status(400).json({ error: `Registration is open to @${process.env.COLLEGE_EMAIL_DOMAIN} addresses only.` });
    }

    // Checked separately — lumping "email OR id_card_number" together used to
    // misreport an ID-card collision as "this email already exists, log in",
    // which sent people to a login screen for an email that was never
    // actually registered.
    const [byEmail] = await pool.query('SELECT id, is_verified FROM users WHERE college_email = ?', [college_email]);
    const [byId] = await pool.query('SELECT id, is_verified FROM users WHERE id_card_number = ?', [id_card_number]);

    if (byId.length > 0 && (byEmail.length === 0 || byEmail[0].id !== byId[0].id)) {
      // The ID card number belongs to a different account than this email —
      // never tell the person to "log in", since this email has no account.
      return res.status(409).json({
        error: 'This ID card number is already registered to a different account. Check for a typo, or contact support if you believe this is an error.',
        conflict_field: 'id_card_number',
      });
    }

    const existing = byEmail;
    let userId;
    if (existing.length > 0) {
      if (existing[0].is_verified) {
        return res.status(409).json({ error: 'An account with this email already exists. Log in instead.', conflict_field: 'email' });
      }
      const password_hash = await bcrypt.hash(password, 10);
      await pool.query(
        `UPDATE users SET full_name=?, phone=?, branch=?, year_of_study=?, password_hash=? WHERE id=?`,
        [full_name, phone, branch || null, year_of_study || null, password_hash, existing[0].id]
      );
      userId = existing[0].id;
    } else {
      const password_hash = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        `INSERT INTO users (full_name, college_email, id_card_number, phone, branch, year_of_study, password_hash, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, FALSE)`,
        [full_name, college_email, id_card_number, phone, branch || null, year_of_study || null, password_hash]
      );
      userId = result.insertId;
    }

    if (verify_via === 'phone') {
      return res.status(400).json({ error: 'Phone verification isn\u2019t available just yet — please choose Email for now.' });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await storeOtp(college_email, 'signup', code);
    await sendOtpEmail(college_email, code);

    res.status(201).json({ userId, message: 'Check your college email for a verification code.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { college_email, code } = req.body;
    const result = await checkOtp(college_email, 'signup', code);
    if (!result.ok) return res.status(400).json({ error: result.reason });

    await pool.query('UPDATE users SET is_verified = TRUE WHERE college_email = ?', [college_email]);
    await consumeOtp(result.row.id);

    const [[user]] = await pool.query(
      'SELECT id, full_name, college_email, id_card_number, branch, phone FROM users WHERE college_email = ?',
      [college_email]
    );
    const token = jwt.sign({ id: user.id, email: user.college_email }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not verify code.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { college_email, password } = req.body;
    const [[user]] = await pool.query('SELECT * FROM users WHERE college_email = ?', [college_email]);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    if (!user.is_verified) {
      return res.status(403).json({ error: 'Account not verified yet. Check your college email for a code.' });
    }

    const token = jwt.sign({ id: user.id, email: user.college_email }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
    res.json({
      token,
      user: {
        id: user.id, full_name: user.full_name, college_email: user.college_email,
        id_card_number: user.id_card_number, branch: user.branch, year_of_study: user.year_of_study,
        phone: user.phone,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { college_email } = req.body;
    if (!college_email) return res.status(400).json({ error: 'College email is required.' });

    const [[user]] = await pool.query('SELECT id FROM users WHERE college_email = ?', [college_email]);
    if (user) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await storeOtp(college_email, 'reset', code);
      await sendOtpEmail(college_email, code);
    }
    res.json({ message: 'If that email has an account, a reset code has been sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not process the request.' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { college_email, code, new_password } = req.body;
    if (!college_email || !code || !new_password) {
      return res.status(400).json({ error: 'Email, code and a new password are required.' });
    }
    const result = await checkOtp(college_email, 'reset', code);
    if (!result.ok) return res.status(400).json({ error: result.reason });

    const password_hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = ? WHERE college_email = ?', [password_hash, college_email]);
    await consumeOtp(result.row.id);
    res.json({ message: 'Password updated. You can log in now.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

module.exports = router;